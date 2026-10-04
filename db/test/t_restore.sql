-- Checks for the owner-scoped transactional restore (prepend db/test/_prelude.sql).
-- Run as postgres after Phase 1c (stage tv_schema or later). Backups are built
-- here the way the app builds them: the owner's rows, every column but user_id.

create or replace function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true);
$$;
create or replace function pg_temp.stage(p text) returns void language sql as $$
  update private.migration_stage set stage = p;
$$;
create or replace function pg_temp.backup(p_owner uuid, p_version int) returns jsonb language sql as $$
  with t as (
    select
      (select coalesce(jsonb_agg(case when p_version = 1 then to_jsonb(w) - 'user_id' - 'show_id' - 'skipped' else to_jsonb(w) - 'user_id' end order by w.id), '[]')
         from public.watchlist_items w where w.user_id = p_owner) as items,
      (select coalesce(jsonb_agg(to_jsonb(s) - 'user_id' order by s.id), '[]') from public.tv_shows s where s.user_id = p_owner) as shows,
      (select coalesce(jsonb_agg(to_jsonb(o) - 'user_id' order by o.id), '[]') from public.othertv_shows o where o.user_id = p_owner) as tracked,
      (select coalesce(jsonb_agg(to_jsonb(c) - 'user_id' order by c.id), '[]') from public.custom_collections c where c.user_id = p_owner) as people
  )
  select jsonb_build_object('format', 'watchlist-tracker-backup', 'formatVersion', p_version, 'exportedAt', now(),
    'rowCounts', jsonb_build_object('watchlist_items', jsonb_array_length(items), 'othertv_shows', jsonb_array_length(tracked),
                                    'custom_collections', jsonb_array_length(people))
                 || case when p_version = 2 then jsonb_build_object('tv_shows', jsonb_array_length(shows)) else '{}' end,
    'tables', jsonb_build_object('watchlist_items', items, 'othertv_shows', tracked, 'custom_collections', people)
                 || case when p_version = 2 then jsonb_build_object('tv_shows', shows) else '{}' end)
  from t
$$;
-- Content fingerprint of one owner's list (every column but user_id).
create or replace function pg_temp.fp(p_owner uuid) returns text language sql as $$
  select md5(concat_ws('#',
    (select string_agg((to_jsonb(w) - 'user_id')::text, '|' order by w.id) from public.watchlist_items w where w.user_id = p_owner),
    (select string_agg((to_jsonb(s) - 'user_id')::text, '|' order by s.id) from public.tv_shows s where s.user_id = p_owner),
    (select string_agg((to_jsonb(o) - 'user_id')::text, '|' order by o.id) from public.othertv_shows o where o.user_id = p_owner),
    (select string_agg((to_jsonb(c) - 'user_id')::text, '|' order by c.id) from public.custom_collections c where c.user_id = p_owner)))
$$;
-- A second owner with one row in every owned table (rows' ids returned).
create or replace function pg_temp.owner_b(p_owner uuid) returns jsonb language plpgsql as $$
declare v_show uuid; v_item uuid; v_tracked uuid; v_person uuid;
begin
  insert into public.tv_shows (user_id, collection, title, show_key, tmdb_id) values (p_owner, 'othertv', 'ZZ B Show', 'zz b show', 990000201) returning id into v_show;
  insert into public.watchlist_items (user_id, collection, item_key, title, season, media_type, tmdb_id, season_number, show_id, date_sort)
  values (p_owner, 'othertv', 'zz b show|season 1', 'ZZ B Show', 'Season 1', 'tv', 990000201, 1, v_show, '2020-01-01') returning id into v_item;
  insert into public.othertv_shows (user_id, tmdb_id, title, collection) values (p_owner, 990000201, 'ZZ B Show', 'othertv') returning id into v_tracked;
  insert into public.custom_collections (user_id, name, tmdb_person_id) values (p_owner, 'ZZ B Person', 990000202) returning id into v_person;
  return jsonb_build_object('show', v_show, 'item', v_item, 'tracked', v_tracked, 'person', v_person);
end $$;

select pg_temp.t('restore v2: round trip as anon reproduces the owner''s list exactly', $b$ do $$
declare a uuid := private.current_owner_id(); before text; r jsonb; b jsonb;
begin
  perform pg_temp.stage('authoritative');
  before := pg_temp.fp(a); b := pg_temp.backup(a, 2);
  perform pg_temp.as_anon();
  r := public.restore_backup(b);
  perform set_config('role', 'none', true);
  if pg_temp.fp(a) <> before then raise exception 'content changed'; end if;
  if (r -> 'restored' ->> 'watchlist_items')::int <> jsonb_array_length(b -> 'tables' -> 'watchlist_items') then raise exception '%', r; end if;
end $$ $b$);

select pg_temp.t('restore: another owner''s list is untouched by this owner''s restore', $b$ do $$
declare a uuid := private.current_owner_id(); o uuid := gen_random_uuid(); before_b text; bk jsonb;
begin
  perform pg_temp.stage('authoritative'); perform pg_temp.owner_b(o);
  before_b := pg_temp.fp(o); bk := pg_temp.backup(a, 2);
  perform pg_temp.as_anon(); perform public.restore_backup(bk); perform set_config('role', 'none', true);
  if pg_temp.fp(o) <> before_b then raise exception 'other owner changed'; end if;
end $$ $b$);

select pg_temp.t('restore: format by stage — v1 refused after the switch-over; needs confirmation in shadow; v2 refused before TV shows', $b$ do $$
declare a uuid := private.current_owner_id(); v1 jsonb := pg_temp.backup(a, 1); v2 jsonb := pg_temp.backup(a, 2);
begin
  perform pg_temp.stage('authoritative'); perform pg_temp.as_anon();
  begin perform public.restore_backup(v1); raise exception 'v1 accepted when authoritative'; exception when sqlstate '22023' then null; end;
  begin perform public.restore_backup(v1, true); raise exception 'v1 accepted with flag when authoritative'; exception when sqlstate '22023' then null; end;
  perform set_config('role', 'none', true); perform pg_temp.stage('shadow'); perform pg_temp.as_anon();
  begin perform public.restore_backup(v1); raise exception 'v1 accepted without confirmation'; exception when sqlstate '22023' then null; end;
  perform set_config('role', 'none', true); perform pg_temp.stage('ownership'); perform pg_temp.as_anon();
  begin perform public.restore_backup(v2); raise exception 'v2 accepted before TV shows'; exception when sqlstate '22023' then null; end;
end $$ $b$);

select pg_temp.t('restore: a confirmed v1 restore in shadow empties the owner''s shows; backfill + resync rebuild them exactly', $b$ do $$
declare a uuid := private.current_owner_id(); v1 jsonb := pg_temp.backup(a, 1); before text := pg_temp.fp(a); r jsonb;
begin
  perform pg_temp.stage('shadow'); perform pg_temp.as_anon();
  r := public.restore_backup(v1, true);
  perform set_config('role', 'none', true);
  if exists (select 1 from public.tv_shows where user_id = a) or exists (select 1 from public.watchlist_items where user_id = a and (show_id is not null or skipped)) then
    raise exception 'shows not emptied';
  end if;
  perform private.tv_backfill(a); perform private.tv_shadow_resync(a);
  if (select count(*) from public.tv_shows where user_id = a) <> 196 or (select count(*) from public.watchlist_items where user_id = a and skipped) <> 38 then
    raise exception 'rebuild differs';
  end if;
end $$ $b$);

select pg_temp.t('restore: shape errors are refused before anything changes (user_id key, missing column, rowCounts, table set)', $b$ do $$
declare a uuid := private.current_owner_id(); b jsonb := pg_temp.backup(a, 2); before text := pg_temp.fp(a); bad jsonb;
begin
  perform pg_temp.stage('authoritative'); perform pg_temp.as_anon();
  bad := jsonb_set(b, '{tables,custom_collections,0}', (b -> 'tables' -> 'custom_collections' -> 0) || jsonb_build_object('user_id', gen_random_uuid()));
  begin perform public.restore_backup(bad); raise exception 'user_id accepted'; exception when sqlstate '22023' then null; end;
  bad := jsonb_set(b, '{tables,watchlist_items,0}', (b -> 'tables' -> 'watchlist_items' -> 0) - 'skipped');
  begin perform public.restore_backup(bad); raise exception 'missing column accepted'; exception when sqlstate '22023' then null; end;
  bad := jsonb_set(b, '{rowCounts,watchlist_items}', '1');
  begin perform public.restore_backup(bad); raise exception 'bad rowCounts accepted'; exception when sqlstate '22023' then null; end;
  bad := b #- '{tables,tv_shows}';
  begin perform public.restore_backup(bad); raise exception 'missing table accepted'; exception when sqlstate '22023' then null; end;
  perform set_config('role', 'none', true);
  if pg_temp.fp(a) <> before then raise exception 'content changed'; end if;
end $$ $b$);

select pg_temp.t('restore forced failure: a constraint error after the deletes rolls everything back', $b$ do $$
declare a uuid := private.current_owner_id(); b jsonb := pg_temp.backup(a, 2); before text := pg_temp.fp(a); m jsonb; bad jsonb;
begin
  perform pg_temp.stage('authoritative');
  -- Two copies of one movie under different ids: fails on the movie identity index mid-insert.
  select value into m from jsonb_array_elements(b -> 'tables' -> 'watchlist_items') where value ->> 'media_type' = 'movie' limit 1;
  bad := jsonb_set(b, '{tables,watchlist_items}', (b -> 'tables' -> 'watchlist_items') || jsonb_build_array(m || jsonb_build_object('id', gen_random_uuid())));
  bad := jsonb_set(bad, '{rowCounts,watchlist_items}', to_jsonb(jsonb_array_length(bad -> 'tables' -> 'watchlist_items')));
  perform pg_temp.as_anon();
  begin perform public.restore_backup(bad); raise exception 'duplicate accepted'; exception when unique_violation then null; end;
  perform set_config('role', 'none', true);
  if pg_temp.fp(a) <> before then raise exception 'content changed'; end if;
end $$ $b$);

select pg_temp.t('restore: after the switch-over a TV season without a show is refused', $b$ do $$
declare a uuid := private.current_owner_id(); b jsonb := pg_temp.backup(a, 2); before text := pg_temp.fp(a); i int;
begin
  perform pg_temp.stage('authoritative');
  select (ord - 1)::int into i from jsonb_array_elements(b -> 'tables' -> 'watchlist_items') with ordinality e(v, ord)
  where v ->> 'show_id' is not null limit 1;
  b := jsonb_set(b, array['tables', 'watchlist_items', i::text, 'show_id'], 'null');
  perform pg_temp.as_anon();
  begin perform public.restore_backup(b); raise exception 'unlinked season accepted'; exception when sqlstate '22023' then null; end;
  perform set_config('role', 'none', true);
  if pg_temp.fp(a) <> before then raise exception 'content changed'; end if;
end $$ $b$);

-- One collision check per owned table: the backup carries an id that another
-- owner already uses. Refused; neither owner changes.
create or replace function pg_temp.collision(p_table text) returns void language plpgsql as $$
declare a uuid := private.current_owner_id(); o uuid := gen_random_uuid(); ids jsonb; b jsonb; fa text; fb text; v_old text; v_new text;
begin
  perform pg_temp.stage('authoritative');
  ids := pg_temp.owner_b(o);
  b := pg_temp.backup(a, 2);
  v_new := ids ->> case p_table when 'watchlist_items' then 'item' when 'tv_shows' then 'show' when 'othertv_shows' then 'tracked' else 'person' end;
  v_old := b -> 'tables' -> p_table -> 0 ->> 'id';
  if v_old is null then raise exception 'no % row to collide', p_table; end if;
  b := jsonb_set(b, array['tables', p_table, '0', 'id'], to_jsonb(v_new));
  if p_table = 'tv_shows' then
    -- Keep the backup internally consistent: its seasons follow the show's new id.
    b := jsonb_set(b, '{tables,watchlist_items}', (select jsonb_agg(case when e ->> 'show_id' = v_old
           then jsonb_set(e, '{show_id}', to_jsonb(v_new)) else e end) from jsonb_array_elements(b -> 'tables' -> 'watchlist_items') e));
  end if;
  fa := pg_temp.fp(a); fb := pg_temp.fp(o);
  perform pg_temp.as_anon();
  begin
    perform public.restore_backup(b);
    raise exception 'collision in % accepted', p_table;
  exception when unique_violation then
    if sqlerrm not like 'restore_id_collision:%user isolation%' then raise exception 'unclear message: %', sqlerrm; end if;
  end;
  perform set_config('role', 'none', true);
  if pg_temp.fp(a) <> fa or pg_temp.fp(o) <> fb then raise exception 'an owner changed'; end if;
end $$;
select pg_temp.t('restore collision: watchlist_items id owned by another user is refused; nobody changes', $b$ do $$ begin perform pg_temp.collision('watchlist_items'); end $$ $b$);
select pg_temp.t('restore collision: tv_shows id owned by another user is refused; nobody changes', $b$ do $$ begin perform pg_temp.collision('tv_shows'); end $$ $b$);
select pg_temp.t('restore collision: othertv_shows id owned by another user is refused; nobody changes', $b$ do $$ begin perform pg_temp.collision('othertv_shows'); end $$ $b$);
select pg_temp.t('restore collision: custom_collections id owned by another user is refused; nobody changes', $b$ do $$ begin perform pg_temp.collision('custom_collections'); end $$ $b$);

select json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq)::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from _t;
