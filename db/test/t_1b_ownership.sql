-- Checks after Phase 1b (prepend db/test/_prelude.sql). Run as postgres.
-- Covers: every row owned by the one bootstrap owner; user_id NOT NULL with the
-- server default; browser roles can neither set nor change user_id; every
-- direct insert/update the app makes today still works without user_id;
-- uniqueness is per owner; the private schema is closed to browser roles.

select pg_temp.t('1b: exactly one bootstrap owner, every row owned by it', $b$ do $$
declare v uuid := (select bootstrap_owner_id from private.app_owner);
begin
  if (select count(*) from private.app_owner) <> 1 then raise exception 'app_owner rows'; end if;
  if exists (select 1 from public.watchlist_items where user_id is distinct from v)
     or exists (select 1 from public.othertv_shows where user_id is distinct from v)
     or exists (select 1 from public.custom_collections where user_id is distinct from v) then
    raise exception 'a row is not owned by the bootstrap owner';
  end if;
end $$ $b$);

select pg_temp.t('1b: user_id is NOT NULL with default private.current_owner_id() on all three tables', $b$ do $$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and column_name = 'user_id' and is_nullable = 'NO'
        and column_default = 'private.current_owner_id()'
        and table_name in ('watchlist_items', 'othertv_shows', 'custom_collections')) <> 3 then
    raise exception 'user_id definition differs';
  end if;
end $$ $b$);

select pg_temp.t('1b: browser roles have no INSERT/UPDATE privilege on user_id, but keep it on every other column', $b$ do $$
declare r text; t text; c record;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach t in array array['watchlist_items', 'othertv_shows', 'custom_collections'] loop
      if has_column_privilege(r, 'public.' || t, 'user_id', 'INSERT') or has_column_privilege(r, 'public.' || t, 'user_id', 'UPDATE') then
        raise exception '% can write %.user_id', r, t;
      end if;
      if not has_column_privilege(r, 'public.' || t, 'user_id', 'SELECT') then raise exception '% cannot read %.user_id', r, t; end if;
      for c in select column_name from information_schema.columns where table_schema = 'public' and table_name = t and column_name <> 'user_id' loop
        if not (has_column_privilege(r, 'public.' || t, c.column_name, 'INSERT') and has_column_privilege(r, 'public.' || t, c.column_name, 'UPDATE')) then
          raise exception '% cannot write %.%', r, t, c.column_name;
        end if;
      end loop;
      if not has_table_privilege(r, 'public.' || t, 'DELETE') then raise exception '% cannot delete from %', r, t; end if;
    end loop;
  end loop;
end $$ $b$);

select pg_temp.t('1b: anon cannot read private.app_owner or private.migration_stage', $b$ do $$
begin
  perform set_config('role', 'anon', true);
  begin perform 1 from private.app_owner; raise exception 'read app_owner'; exception when insufficient_privilege then null; end;
  begin perform 1 from private.migration_stage; raise exception 'read migration_stage'; exception when insufficient_privilege then null; end;
end $$ $b$);

select pg_temp.t('1b: anon gets the bootstrap owner from private.current_owner_id() and the stage from private.tv_stage()', $b$ do $$
declare v uuid; s text;
begin
  perform set_config('role', 'anon', true);
  v := private.current_owner_id(); s := private.tv_stage();
  perform set_config('role', 'none', true);
  if v is distinct from (select bootstrap_owner_id from private.app_owner) then raise exception 'wrong owner %', v; end if;
  if s is null then raise exception 'no stage'; end if;
end $$ $b$);

-- ── Every direct write the app makes today, as anon, without user_id ─────────
select pg_temp.t('1b direct insert: movie manual add (addEntry on Movies) is owned by the bootstrap owner', $b$ do $$
declare r public.watchlist_items;
begin
  perform set_config('role', 'anon', true);
  insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched, status)
  values ('movies', 'zz manual film|film', 'ZZ Manual Film', 'Film', 'Drama', 'Jan 1, 2026', '2026-01-01', false, 'confirmed')
  returning * into r;
  if r.user_id is distinct from private.current_owner_id() then raise exception 'not owned'; end if;
end $$ $b$);

select pg_temp.t('1b direct insert: movie TMDB add / collection pull / universe pull / person filmography shape', $b$ do $$
declare n int;
begin
  perform set_config('role', 'anon', true);
  insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched, status,
    tmdb_collection_id, tmdb_collection_name, collections, media_type, tmdb_id, season_number)
  values ('movies', 'zz pulled film|film', 'ZZ Pulled Film', 'Film', 'Action', 'Jan 1, 2026', '2026-01-01', false, 'confirmed',
          9990001, 'ZZ Collection', array['ZZ Collection', 'ZZ Person'], 'movie', 999000001, null),
         ('movies', 'zz pulled film 2|film', 'ZZ Pulled Film 2', 'Film', 'Action', 'TBA', '2099-01-01', false, 'confirmed',
          null, null, array['MCU'], 'movie', 999000002, null);
  get diagnostics n = row_count;
  if n <> 2 then raise exception 'inserted %', n; end if;
  if exists (select 1 from public.watchlist_items where tmdb_id in (999000001, 999000002) and user_id <> private.current_owner_id()) then
    raise exception 'not owned';
  end if;
end $$ $b$);

select pg_temp.t('1b direct insert: TV season add (search / Refresh shows) and its othertv_shows registration', $b$ do $$
begin
  perform set_config('role', 'anon', true);
  insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched, status,
    media_type, tmdb_id, season_number)
  values ('othertv', 'zz show|season 1', 'ZZ Show', 'Season 1', 'HBO', 'TBA', '2099-01-01', false, 'confirmed', 'tv', 999000003, 1);
  insert into public.othertv_shows (tmdb_id, title, network, collection) values (999000003, 'ZZ Show', 'HBO', 'othertv');
  if (select user_id from public.othertv_shows where tmdb_id = 999000003) is distinct from private.current_owner_id() then
    raise exception 'othertv_shows row not owned';
  end if;
end $$ $b$);

select pg_temp.t('1b direct insert: built-in DEFAULT seeding, TV season and film rows (loadTab)', $b$ do $$
begin
  perform set_config('role', 'anon', true);
  insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched, status)
  values ('disney', 'zz default show|season 1', 'ZZ Default Show', 'Season 1', 'Star Wars', 'TBA 2027', '2027-06-01', false, 'pending'),
         ('sheridan', 'zz default film|film', 'ZZ Default Film', 'Film', 'Western', 'Jan 1, 2027', '2027-01-01', false, 'confirmed');
end $$ $b$);

select pg_temp.t('1b direct insert: person collection creation (custom_collections)', $b$ do $$
begin
  perform set_config('role', 'anon', true);
  insert into public.custom_collections (name, tmdb_person_id, role) values ('ZZ Person', 999000004, 'director');
  if (select user_id from public.custom_collections where name = 'ZZ Person') is distinct from private.current_owner_id() then
    raise exception 'not owned';
  end if;
end $$ $b$);

select pg_temp.t('1b direct update: every PATCH the app sends (status, watched, watch_with, collections, dates, Match patch)', $b$ do $$
declare v_id uuid;
begin
  perform set_config('role', 'anon', true);
  insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched, status)
  values ('othertv', 'zz manual show|season 1', 'ZZ Manual Show', 'Season 1', 'HBO', 'TBA', '2099-01-01', false, 'confirmed')
  returning id into v_id;
  update public.watchlist_items set status = 'watching' where id = v_id;
  update public.watchlist_items set watched = true where id = v_id;
  update public.watchlist_items set watch_with = array['Alone'] where id = v_id;
  update public.watchlist_items set collections = array['ZZ Tag'] where id = v_id;
  update public.watchlist_items set display_date = 'Jan 1, 2027', date_sort = '2027-01-01' where id = v_id;
  update public.watchlist_items set title = 'ZZ Matched', season = 'Season 1', item_key = 'zz matched|season 1', theme = 'HBO',
    display_date = 'Jan 1, 2027', date_sort = '2027-01-01', media_type = 'tv', tmdb_id = 999000005, season_number = 1
  where id = v_id and tmdb_id is null and media_type is null and season_number is null;
  update public.othertv_shows set title = title where false;
  update public.custom_collections set role = role where false;
end $$ $b$);

select pg_temp.t('1b: anon cannot set user_id on insert (watchlist_items, othertv_shows, custom_collections)', $b$ do $$
begin
  perform set_config('role', 'anon', true);
  begin
    insert into public.watchlist_items (collection, item_key, title, user_id) values ('movies', 'zz|film', 'ZZ', gen_random_uuid());
    raise exception 'watchlist_items accepted user_id';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.othertv_shows (tmdb_id, title, user_id) values (1, 'ZZ', gen_random_uuid());
    raise exception 'othertv_shows accepted user_id';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.custom_collections (name, tmdb_person_id, user_id) values ('ZZ', 1, gen_random_uuid());
    raise exception 'custom_collections accepted user_id';
  exception when insufficient_privilege then null; end;
end $$ $b$);

select pg_temp.t('1b: anon cannot change user_id (ownership transfer) on any table', $b$ do $$
begin
  perform set_config('role', 'anon', true);
  begin update public.watchlist_items set user_id = gen_random_uuid() where true; raise exception 'watchlist_items';
  exception when insufficient_privilege then null; end;
  begin update public.othertv_shows set user_id = gen_random_uuid() where true; raise exception 'othertv_shows';
  exception when insufficient_privilege then null; end;
  begin update public.custom_collections set user_id = gen_random_uuid() where true; raise exception 'custom_collections';
  exception when insufficient_privilege then null; end;
end $$ $b$);

-- ── Uniqueness is per owner ───────────────────────────────────────────────────
select pg_temp.t('1b: another owner may hold the same movie, TV season, legacy key, tracked show and person-collection name', $b$ do $$
declare o uuid := gen_random_uuid(); m record; s record; l record; ot record; cc record;
begin
  select * into m from public.watchlist_items where media_type = 'movie' limit 1;
  select * into s from public.watchlist_items where media_type = 'tv' limit 1;
  select * into l from public.watchlist_items where tmdb_id is null limit 1;
  select * into ot from public.othertv_shows limit 1;
  select * into cc from public.custom_collections limit 1;
  insert into public.watchlist_items (user_id, collection, item_key, title, media_type, tmdb_id, season_number)
  values (o, m.collection, m.item_key, m.title, 'movie', m.tmdb_id, null),
         (o, s.collection, s.item_key, s.title, 'tv', s.tmdb_id, s.season_number),
         (o, l.collection, l.item_key, l.title, null, null, null);
  if ot.id is not null then insert into public.othertv_shows (user_id, tmdb_id, title, collection) values (o, ot.tmdb_id, ot.title, ot.collection); end if;
  if cc.id is not null then insert into public.custom_collections (user_id, name, tmdb_person_id) values (o, cc.name, cc.tmdb_person_id); end if;
end $$ $b$);

select pg_temp.t('1b: the same owner still cannot duplicate a movie, TV season, legacy key, tracked show or name', $b$ do $$
declare m record; s record; l record; ot record; cc record;
begin
  select * into m from public.watchlist_items where media_type = 'movie' limit 1;
  select * into s from public.watchlist_items where media_type = 'tv' limit 1;
  select * into l from public.watchlist_items where tmdb_id is null limit 1;
  select * into ot from public.othertv_shows limit 1;
  select * into cc from public.custom_collections limit 1;
  perform set_config('role', 'anon', true);
  begin insert into public.watchlist_items (collection, item_key, title, media_type, tmdb_id) values (m.collection, 'x|film', 'x', 'movie', m.tmdb_id);
    raise exception 'movie duplicate allowed'; exception when unique_violation then null; end;
  begin insert into public.watchlist_items (collection, item_key, title, media_type, tmdb_id, season_number) values (s.collection, 'x|s', 'x', 'tv', s.tmdb_id, s.season_number);
    raise exception 'tv duplicate allowed'; exception when unique_violation then null; end;
  begin insert into public.watchlist_items (collection, item_key, title) values (l.collection, l.item_key, 'x');
    raise exception 'legacy duplicate allowed'; exception when unique_violation then null; end;
  if ot.id is not null then
    begin insert into public.othertv_shows (tmdb_id, title, collection) values (ot.tmdb_id, 'x', ot.collection);
      raise exception 'tracked show duplicate allowed'; exception when unique_violation then null; end;
  end if;
  if cc.id is not null then
    begin insert into public.custom_collections (name, tmdb_person_id) values (cc.name, 1);
      raise exception 'name duplicate allowed'; exception when unique_violation then null; end;
  end if;
end $$ $b$);

select pg_temp.t('1b: index and constraint definitions are exactly as planned', $b$ do $$
declare d text;
begin
  select string_agg(indexname || ': ' || regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX \S+ ON public\.\S+ USING btree ', '\1'), E'\n' order by indexname)
  into d from pg_indexes where schemaname = 'public' and tablename in ('watchlist_items', 'othertv_shows', 'custom_collections');
  if d is distinct from concat_ws(E'\n',
    'custom_collections_person_idx: (tmdb_person_id)',
    'custom_collections_pkey: UNIQUE (id)',
    'custom_collections_user_name_key: UNIQUE (user_id, name)',
    'othertv_shows_collection_idx: (collection)',
    'othertv_shows_pkey: UNIQUE (id)',
    'othertv_shows_tmdb_id_idx: (tmdb_id)',
    'othertv_shows_user_collection_tmdb_id_key: UNIQUE (user_id, collection, tmdb_id)',
    'watchlist_items_collection_idx: (user_id, collection, date_sort)',
    'watchlist_items_legacy_item_key_key: UNIQUE (user_id, collection, item_key) WHERE (tmdb_id IS NULL)',
    'watchlist_items_movie_identity_key: UNIQUE (user_id, collection, media_type, tmdb_id) WHERE ((media_type = ''movie''::text) AND (tmdb_id IS NOT NULL))',
    'watchlist_items_pkey: UNIQUE (id)',
    'watchlist_items_tmdb_collection_idx: (tmdb_collection_id)',
    'watchlist_items_tv_identity_key: UNIQUE (user_id, collection, media_type, tmdb_id, season_number) WHERE ((media_type = ''tv''::text) AND (tmdb_id IS NOT NULL) AND (season_number IS NOT NULL))') then
    raise exception E'index definitions differ:\n%', d;
  end if;
end $$ $b$);

select json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq)::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from _t;
