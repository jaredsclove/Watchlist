-- Two-user isolation, rehearsing the FUTURE sign-in switch-over (prepend
-- db/test/_prelude.sql; needs db/future/auth_switchover.sql and db/rpc.sql).
-- TEST PROJECTS ONLY. Every check moves the bootstrap owner's data to test user
-- A, applies the lock migration, gives test user B their own rows, and then acts
-- as A or B the way PostgREST does (role authenticated + JWT sub claim). All of
-- it is rolled back at the end of each check.
-- The two test users' ids come from the session settings watchlist_test.user_a
-- and watchlist_test.user_b, set by the untracked db/test/local_test_users.sql
-- (template: db/test/local_test_users.example.sql), run before this script.
-- Locally, tools/db-rehearsal.mjs sets random ids and creates matching auth.users rows.

create or replace function pg_temp.test_user(p_name text) returns uuid language plpgsql as $$
declare v text := current_setting('watchlist_test.' || p_name, true);
begin
  if v is null or v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'watchlist_test.% is not set: run db/test/local_test_users.sql first (template: local_test_users.example.sql)', p_name;
  end if;
  return v::uuid;
end $$;
create or replace function pg_temp.ua() returns uuid language sql as $$ select pg_temp.test_user('user_a') $$;
create or replace function pg_temp.ub() returns uuid language sql as $$ select pg_temp.test_user('user_b') $$;
create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true),
         set_config('role', 'authenticated', true);
$$;
create or replace function pg_temp.as_postgres() returns void language sql as $$
  select set_config('role', 'none', true), set_config('request.jwt.claims', '', true);
$$;
create or replace function pg_temp.fp(p_owner uuid) returns text language sql as $$
  select md5(concat_ws('#',
    (select string_agg((to_jsonb(w) - 'user_id')::text, '|' order by w.id) from public.watchlist_items w where w.user_id = p_owner),
    (select string_agg((to_jsonb(s) - 'user_id')::text, '|' order by s.id) from public.tv_shows s where s.user_id = p_owner),
    (select string_agg((to_jsonb(o) - 'user_id')::text, '|' order by o.id) from public.othertv_shows o where o.user_id = p_owner),
    (select string_agg((to_jsonb(c) - 'user_id')::text, '|' order by c.id) from public.custom_collections c where c.user_id = p_owner)))
$$;
-- Bootstrap → A, lock, then B's own list: the same movie, the same TMDB show
-- (Complete) and season as A, a legacy row with A's key, A's person name, a
-- tracked show. Returns B's ids.
create or replace function pg_temp.two_users() returns jsonb language plpgsql as $$
declare m record; s record; l record; c record; v_show uuid; v_item uuid; v_movie uuid; v_tracked uuid; v_person uuid; v_legacy uuid;
begin
  insert into auth.users (id) select pg_temp.ua() where not exists (select 1 from auth.users where id = pg_temp.ua());
  insert into auth.users (id) select pg_temp.ub() where not exists (select 1 from auth.users where id = pg_temp.ub());
  update private.migration_stage set stage = 'authoritative';
  perform private.auth_move_owner(pg_temp.ua());
  perform private.auth_lock();
  select * into m from public.watchlist_items where media_type = 'movie' limit 1;
  select w.*, t.tmdb_id as show_tmdb into s from public.watchlist_items w join public.tv_shows t on t.id = w.show_id where t.tmdb_id is not null order by w.id limit 1;
  select * into l from public.watchlist_items where tmdb_id is null limit 1;
  select * into c from public.custom_collections limit 1;
  insert into public.tv_shows (user_id, collection, title, show_key, tmdb_id, status) values (pg_temp.ub(), s.collection, s.title, split_part(s.item_key, '|', 1), s.tmdb_id, 'complete')
  returning id into v_show;
  insert into public.watchlist_items (user_id, collection, item_key, title, season, media_type, tmdb_id, season_number, show_id, date_sort, status)
  values (pg_temp.ub(), s.collection, s.item_key, s.title, s.season, 'tv', s.tmdb_id, s.season_number, v_show, s.date_sort, 'complete') returning id into v_item;
  insert into public.watchlist_items (user_id, collection, item_key, title, season, media_type, tmdb_id, date_sort)
  values (pg_temp.ub(), m.collection, m.item_key, m.title, 'Film', 'movie', m.tmdb_id, m.date_sort) returning id into v_movie;
  insert into public.othertv_shows (user_id, tmdb_id, title, collection) values (pg_temp.ub(), s.tmdb_id, s.title, s.collection) returning id into v_tracked;
  insert into public.custom_collections (user_id, name, tmdb_person_id) values (pg_temp.ub(), coalesce(c.name, 'ZZ Person'), coalesce(c.tmdb_person_id, 1)) returning id into v_person;
  return jsonb_build_object('show', v_show, 'item', v_item, 'movie', v_movie, 'tracked', v_tracked, 'person', v_person,
    'show_tmdb', s.tmdb_id, 'collection', s.collection, 'item_key_prefix', split_part(s.item_key, '|', 1), 'season_number', s.season_number);
end $$;

select pg_temp.t('setup: both test-user ids are configured and different', $b$ do $$
begin
  if pg_temp.ua() = pg_temp.ub() then raise exception 'user_a and user_b are the same id'; end if;
end $$ $b$);

select pg_temp.t('auth move: every bootstrap row moves to A (links cascade), counts unchanged, links to auth.users added', $b$ do $$
declare v_from uuid := (select bootstrap_owner_id from private.app_owner); n_items int := (select count(*) from public.watchlist_items);
  n_shows int := (select count(*) from public.tv_shows); n_linked int := (select count(*) from public.watchlist_items where show_id is not null); r jsonb;
begin
  insert into auth.users (id) select pg_temp.ua() where not exists (select 1 from auth.users where id = pg_temp.ua());
  r := private.auth_move_owner(pg_temp.ua());
  if exists (select 1 from public.watchlist_items where user_id <> pg_temp.ua()) or exists (select 1 from public.tv_shows where user_id <> pg_temp.ua())
     or exists (select 1 from public.othertv_shows where user_id <> pg_temp.ua()) or exists (select 1 from public.custom_collections where user_id <> pg_temp.ua()) then
    raise exception 'a row did not move';
  end if;
  if exists (select 1 from public.watchlist_items where user_id = v_from) then raise exception 'bootstrap rows remain'; end if;
  if (select count(*) from public.watchlist_items) <> n_items or (select count(*) from public.tv_shows) <> n_shows
     or (select count(*) from public.watchlist_items w join public.tv_shows s on s.id = w.show_id and s.user_id = w.user_id) <> n_linked then
    raise exception 'counts or links changed';
  end if;
  if (select count(*) from pg_constraint where conname like '%_user_id_fkey' and confrelid = 'auth.users'::regclass and confdeltype = 'r') <> 4 then
    raise exception 'auth.users links missing or not RESTRICT';
  end if;
  if (select bootstrap_owner_id from private.app_owner) <> pg_temp.ua() then raise exception 'default owner not moved'; end if;
end $$ $b$);

select pg_temp.t('lock: nobody signed in means no owner (no bootstrap fallback); anon reads and calls nothing', $b$ do $$
begin
  perform pg_temp.two_users();
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin perform private.current_owner_id(); raise exception 'owner without a session'; exception when sqlstate '28000' then null; end;
  perform pg_temp.as_postgres();
  perform set_config('role', 'anon', true);
  begin perform 1 from public.watchlist_items limit 1; raise exception 'anon read watchlist_items'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.tv_shows limit 1; raise exception 'anon read tv_shows'; exception when insufficient_privilege then null; end;
  begin perform public.restore_backup('{}'); raise exception 'anon called restore'; exception when insufficient_privilege then null; end;
  begin perform public.add_tv_seasons('othertv', '{}', '[]'); raise exception 'anon called add'; exception when insufficient_privilege then null; end;
end $$ $b$);

select pg_temp.t('isolation: A and B each hold the same movie and TMDB season; each sees only their own rows', $b$ do $$
declare ids jsonb; a_total int := (select count(*) from public.watchlist_items); n int;
begin
  ids := pg_temp.two_users();
  perform pg_temp.as_user(pg_temp.ua());
  select count(*) into n from public.watchlist_items;
  if n <> a_total then raise exception 'A sees % rows, owns %', n, a_total; end if;
  if exists (select 1 from public.watchlist_items where user_id = pg_temp.ub()) or exists (select 1 from public.tv_shows where user_id = pg_temp.ub())
     or exists (select 1 from public.othertv_shows where user_id = pg_temp.ub()) or exists (select 1 from public.custom_collections where user_id = pg_temp.ub()) then
    raise exception 'A can read B rows';
  end if;
  perform pg_temp.as_user(pg_temp.ub());
  select count(*) into n from public.watchlist_items;
  if n <> 2 then raise exception 'B sees % rows', n; end if;
  -- B adds a movie A also has, through the API path (no user_id sent).
  insert into public.watchlist_items (collection, item_key, title, season, media_type, tmdb_id) values ('movies', 'zz both|film', 'ZZ Both', 'Film', 'movie', 990000301);
  perform pg_temp.as_user(pg_temp.ua());
  insert into public.watchlist_items (collection, item_key, title, season, media_type, tmdb_id) values ('movies', 'zz both|film', 'ZZ Both', 'Film', 'movie', 990000301);
end $$ $b$);

select pg_temp.t('isolation: A cannot update, delete, re-own or insert-as B''s rows', $b$ do $$
declare ids jsonb; fb text; n int;
begin
  ids := pg_temp.two_users(); fb := pg_temp.fp(pg_temp.ub());
  perform pg_temp.as_user(pg_temp.ua());
  update public.watchlist_items set watched = true, status = 'watching' where id in ((ids ->> 'item')::uuid, (ids ->> 'movie')::uuid);
  get diagnostics n = row_count; if n <> 0 then raise exception 'A updated % B rows', n; end if;
  update public.tv_shows set status = 'watching' where id = (ids ->> 'show')::uuid;
  get diagnostics n = row_count; if n <> 0 then raise exception 'A updated B show'; end if;
  delete from public.watchlist_items where id = (ids ->> 'movie')::uuid; get diagnostics n = row_count; if n <> 0 then raise exception 'A deleted B row'; end if;
  delete from public.custom_collections where id = (ids ->> 'person')::uuid; get diagnostics n = row_count; if n <> 0 then raise exception 'A deleted B person'; end if;
  delete from public.othertv_shows where id = (ids ->> 'tracked')::uuid; get diagnostics n = row_count; if n <> 0 then raise exception 'A deleted B tracked'; end if;
  begin insert into public.watchlist_items (collection, item_key, title, user_id) values ('movies', 'zz|film', 'ZZ', pg_temp.ub());
    raise exception 'A inserted as B'; exception when insufficient_privilege then null; end;
  begin update public.watchlist_items set user_id = pg_temp.ub() where true; raise exception 'A re-owned rows'; exception when insufficient_privilege then null; end;
  begin update public.watchlist_items set show_id = (ids ->> 'show')::uuid where show_id is not null and id = (select id from public.watchlist_items where show_id is not null limit 1);
    raise exception 'A linked to B show'; exception when foreign_key_violation then null; end;
  perform pg_temp.as_postgres();
  if pg_temp.fp(pg_temp.ub()) <> fb then raise exception 'B changed'; end if;
end $$ $b$);

select pg_temp.t('isolation: A''s function calls with B''s ids are not_found and change nothing', $b$ do $$
declare ids jsonb; fb text;
begin
  ids := pg_temp.two_users(); fb := pg_temp.fp(pg_temp.ub());
  perform pg_temp.as_user(pg_temp.ua());
  begin perform public.set_show_status((ids ->> 'show')::uuid, 'watching'); raise exception 'status'; exception when sqlstate 'P0002' then null; end;
  begin perform public.set_season_watched((ids ->> 'item')::uuid, true); raise exception 'watched'; exception when sqlstate 'P0002' then null; end;
  begin perform public.set_season_skipped((ids ->> 'item')::uuid, true); raise exception 'skipped'; exception when sqlstate 'P0002' then null; end;
  begin perform public.delete_tv_season((ids ->> 'item')::uuid); raise exception 'delete'; exception when sqlstate 'P0002' then null; end;
  perform pg_temp.as_postgres();
  if pg_temp.fp(pg_temp.ub()) <> fb then raise exception 'B changed'; end if;
end $$ $b$);

select pg_temp.t('isolation: A''s seeding, Refresh-style add and reopen leave B untouched (B''s identical show stays Complete)', $b$ do $$
declare ids jsonb; fb text; r jsonb; v_a_show uuid; d jsonb;
begin
  ids := pg_temp.two_users(); fb := pg_temp.fp(pg_temp.ub());
  perform pg_temp.as_user(pg_temp.ua());
  select id into v_a_show from public.tv_shows where tmdb_id = (ids ->> 'show_tmdb')::int and collection = ids ->> 'collection';
  perform public.set_show_status(v_a_show, 'complete');
  r := public.add_tv_seasons(ids ->> 'collection', jsonb_build_object('tmdb_id', (ids ->> 'show_tmdb')::int, 'title', 'ZZ', 'show_key', ids ->> 'item_key_prefix'),
         jsonb_build_array(jsonb_build_object('item_key', (ids ->> 'item_key_prefix') || '|season 90', 'title', 'ZZ', 'season', 'Season 90',
           'date_sort', '2030-01-01', 'season_number', 90)));
  if not (r ->> 'reopened')::boolean then raise exception 'A not reopened %', r; end if;
  select jsonb_agg(jsonb_build_object('k', item_key, 't', title, 's', season, 'th', theme, 'd', display_date, 'ds', date_sort))
    into d from public.watchlist_items where collection = 'disney';
  d := d || '[{"k":"zz two user seed|season 1","t":"ZZ Two User Seed","s":"Season 1","th":"X","d":"TBA","ds":"2027-01-01"}]';
  r := public.seed_tv_defaults('disney', d);
  if jsonb_array_length(r -> 'inserted') <> 1 then raise exception 'A seed %', r; end if;
  perform pg_temp.as_postgres();
  if pg_temp.fp(pg_temp.ub()) <> fb or (select status from public.tv_shows where id = (ids ->> 'show')::uuid) <> 'complete' then
    raise exception 'B changed';
  end if;
  -- B seeding the same tab gets B's own full catalog, independent of A.
  perform pg_temp.as_user(pg_temp.ub());
  r := public.seed_tv_defaults('disney', d);
  perform pg_temp.as_postgres();
  if (select count(*) from public.watchlist_items where user_id = pg_temp.ub() and collection = 'disney') <> jsonb_array_length(d) then
    raise exception 'B seeding gave % rows', (select count(*) from public.watchlist_items where user_id = pg_temp.ub() and collection = 'disney');
  end if;
end $$ $b$);

create or replace function pg_temp.backup_of(p_owner uuid) returns jsonb language sql as $$
  select jsonb_build_object('format', 'watchlist-tracker-backup', 'formatVersion', 2, 'exportedAt', now(),
    'rowCounts', jsonb_build_object(
      'watchlist_items', (select count(*) from public.watchlist_items where user_id = p_owner),
      'tv_shows', (select count(*) from public.tv_shows where user_id = p_owner),
      'othertv_shows', (select count(*) from public.othertv_shows where user_id = p_owner),
      'custom_collections', (select count(*) from public.custom_collections where user_id = p_owner)),
    'tables', jsonb_build_object(
      'watchlist_items', (select coalesce(jsonb_agg(to_jsonb(w) - 'user_id'), '[]') from public.watchlist_items w where w.user_id = p_owner),
      'tv_shows', (select coalesce(jsonb_agg(to_jsonb(s) - 'user_id'), '[]') from public.tv_shows s where s.user_id = p_owner),
      'othertv_shows', (select coalesce(jsonb_agg(to_jsonb(o) - 'user_id'), '[]') from public.othertv_shows o where o.user_id = p_owner),
      'custom_collections', (select coalesce(jsonb_agg(to_jsonb(c) - 'user_id'), '[]') from public.custom_collections c where c.user_id = p_owner)))
$$;

select pg_temp.t('isolation: A''s restore replaces only A''s list; B stays byte-for-byte identical', $b$ do $$
declare ids jsonb; fa text; fb text; bk jsonb;
begin
  ids := pg_temp.two_users(); fa := pg_temp.fp(pg_temp.ua()); fb := pg_temp.fp(pg_temp.ub()); bk := pg_temp.backup_of(pg_temp.ua());
  perform pg_temp.as_user(pg_temp.ua());
  perform public.restore_backup(bk);
  perform pg_temp.as_postgres();
  if pg_temp.fp(pg_temp.ua()) <> fa then raise exception 'A round trip differs'; end if;
  if pg_temp.fp(pg_temp.ub()) <> fb then raise exception 'B changed'; end if;
end $$ $b$);

-- With owner-only access rules A can't see B's ids, so the collision is caught
-- by the primary key inside the transaction: same refusal, nothing changes.
create or replace function pg_temp.signed_in_collision(p_table text) returns void language plpgsql as $$
declare ids jsonb; fa text; fb text; bk jsonb; v_new text; v_old text;
begin
  ids := pg_temp.two_users(); fa := pg_temp.fp(pg_temp.ua()); fb := pg_temp.fp(pg_temp.ub()); bk := pg_temp.backup_of(pg_temp.ua());
  v_new := ids ->> case p_table when 'watchlist_items' then 'movie' when 'tv_shows' then 'show' when 'othertv_shows' then 'tracked' else 'person' end;
  v_old := bk -> 'tables' -> p_table -> 0 ->> 'id';
  bk := jsonb_set(bk, array['tables', p_table, '0', 'id'], to_jsonb(v_new));
  if p_table = 'tv_shows' then
    bk := jsonb_set(bk, '{tables,watchlist_items}', (select jsonb_agg(case when e ->> 'show_id' = v_old
            then jsonb_set(e, '{show_id}', to_jsonb(v_new)) else e end) from jsonb_array_elements(bk -> 'tables' -> 'watchlist_items') e));
  end if;
  perform pg_temp.as_user(pg_temp.ua());
  begin
    perform public.restore_backup(bk);
    raise exception 'collision in % accepted', p_table;
  exception when unique_violation then
    if sqlerrm not like 'restore_id_collision:%user isolation%' then raise exception 'unclear message: %', sqlerrm; end if;
  end;
  perform pg_temp.as_postgres();
  if pg_temp.fp(pg_temp.ua()) <> fa or pg_temp.fp(pg_temp.ub()) <> fb then raise exception 'an owner changed'; end if;
end $$;
select pg_temp.t('isolation restore collision (signed in): watchlist_items', $b$ do $$ begin perform pg_temp.signed_in_collision('watchlist_items'); end $$ $b$);
select pg_temp.t('isolation restore collision (signed in): tv_shows', $b$ do $$ begin perform pg_temp.signed_in_collision('tv_shows'); end $$ $b$);
select pg_temp.t('isolation restore collision (signed in): othertv_shows', $b$ do $$ begin perform pg_temp.signed_in_collision('othertv_shows'); end $$ $b$);
select pg_temp.t('isolation restore collision (signed in): custom_collections', $b$ do $$ begin perform pg_temp.signed_in_collision('custom_collections'); end $$ $b$);

select json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq)::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from _t;
