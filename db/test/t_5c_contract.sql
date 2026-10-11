-- Checks for Stage 5c, the contraction (prepend db/test/_prelude.sql). Run as postgres
-- right after db/phase5c_contract.sql on a replica (the archive must still be active).
-- Every check works on synthetic ZZ records inside its own rolled-back subtransaction
-- and calls the database as anon, the way the app does. Single-session checks: each
-- shows one serial order; how two sessions interleave needs real connections (G2).
-- Privileges are checked as the anon role of the replica (A12 is the hosted check).

create or replace function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true);
$$;
create or replace function pg_temp.as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true);
$$;
-- Every table a restore replaces, every column of every row (owners' user_id included:
-- compared within this replica), by id.
create or replace function pg_temp.content() returns text language sql as $$
  select concat_ws('/',
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.watchlist_items t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.tv_shows t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.collection_memberships t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.catalog_show_links t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.catalog_film_links t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.personal_collections t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.custom_collections t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.watch_with_choices t))
$$;
create or replace function pg_temp.refused(p_sql text, p_prefix text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like p_prefix || '%' then raise exception 'expected "%" but got: %', p_prefix, v_msg; end if;
    return;
  end;
  raise exception 'expected "%" but the call was accepted', p_prefix;
end $$;
create or replace function pg_temp.by_label(p_key text, p_title text, p_label text, p_ds text) returns jsonb language sql as $$
  select jsonb_build_object('item_key', p_key || '|' || lower(p_label), 'title', p_title, 'season', p_label, 'theme', 'ZZ Net',
    'display_date', 'ZZ ' || p_ds, 'date_sort', p_ds)
$$;
create or replace function pg_temp.by_number(p_key text, p_title text, p_num int, p_ds text) returns jsonb language sql as $$
  select jsonb_build_object('item_key', p_key || '|' || case when p_num = 0 then 'specials' else 'season ' || p_num end, 'title', p_title,
    'season', case when p_num = 0 then 'Specials' else 'Season ' || p_num end, 'theme', 'ZZ Net', 'display_date', 'ZZ ' || p_ds,
    'date_sort', p_ds, 'season_number', p_num)
$$;
create or replace function pg_temp.new_show(p_tmdb int, p_title text, p_distinct jsonb default '[]') returns public.tv_shows language plpgsql as $$
declare v jsonb; s public.tv_shows;
begin
  v := public.library_create_show(jsonb_build_object('tmdb_id', p_tmdb, 'title', p_title, 'show_key', lower(p_title), 'network', 'ZZ Net', 'distinct_from', p_distinct),
    jsonb_build_array(case when p_tmdb is null then pg_temp.by_label(lower(p_title), p_title, 'Season 1', '2020-01-01')
                           else pg_temp.by_number(lower(p_title), p_title, 1, '2020-01-01') end));
  select * into s from public.tv_shows where id = (v ->> 'show_id')::uuid;
  return s;
end $$;
create or replace function pg_temp.expected(s public.tv_shows) returns jsonb language sql as $$
  select jsonb_build_object('tmdb_id', s.tmdb_id, 'show_key', s.show_key, 'catalog', private.lib_show_catalog(s.id), 'network', 'ZZ Net')
$$;
create or replace function pg_temp.film(p_title text, p_tmdb int default null) returns jsonb language sql as $$
  select jsonb_build_object('tmdb_id', p_tmdb, 'title', p_title, 'item_key', lower(p_title) || '|film', 'season', 'Film', 'theme', 'Drama',
    'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01')
$$;
create or replace function pg_temp.film_patch(p_title text, p_tmdb int) returns jsonb language sql as $$
  select jsonb_build_object('title', p_title, 'season', 'Film', 'item_key', lower(p_title) || '|film', 'theme', 'Drama',
    'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01', 'media_type', 'movie', 'tmdb_id', p_tmdb, 'season_number', null)
$$;
create or replace function pg_temp.defaults(p_show text default 'ZZ Cat Show', p_film text default 'ZZ Cat Film') returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('k', lower(p_show) || '|season 1', 't', p_show, 's', 'Season 1', 'd', 'Jan 1, 2020', 'ds', '2020-01-01'),
    jsonb_build_object('k', lower(p_show) || '|season 2', 't', p_show, 's', 'Season 2', 'd', 'Jan 1, 2021', 'ds', '2021-01-01'),
    jsonb_build_object('k', lower(p_film) || '|film', 't', p_film, 's', 'Film', 'd', 'Jan 1, 2022', 'ds', '2022-01-01'))
$$;
create or replace function pg_temp.preview(p_defaults jsonb) returns jsonb language sql as $$
  select public.library_catalog_apply('sheridan', p_defaults)
$$;
create or replace function pg_temp.apply(p_defaults jsonb) returns jsonb language plpgsql as $$
declare p jsonb := public.library_catalog_apply('sheridan', p_defaults);
begin
  return public.library_catalog_apply('sheridan', p_defaults, p ->> 'hash');
end $$;
create or replace function pg_temp.excluded(p_doc jsonb) returns jsonb language sql as $$
  select coalesce(jsonb_agg(e), '[]') from jsonb_array_elements(p_doc -> 'document' -> 'entries') e where e ->> 'kind' = 'excluded_conflict'
$$;

-- The recovery archive, to show a refusal left it unchanged.
create or replace function pg_temp.archive() returns text language sql as $$
  select concat_ws('/',
    (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.stage5_recovery_records t),
    (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.stage5_recovery_collections t),
    (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.stage5_recovery_othertv t),
    (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.stage5_recovery_meta t))
$$;
-- A valid format-4 document of the current contents (what the page's backup builds).
create or replace function pg_temp.doc4() returns jsonb language sql as $$
  select jsonb_build_object('format', 'watchlist-tracker-backup', 'formatVersion', 4, 'exportedAt', '2026-10-09T00:00:00.000Z',
    'tables', t, 'rowCounts', (select jsonb_object_agg(k, jsonb_array_length(v)) from jsonb_each(t) e(k, v)))
  from (select jsonb_build_object(
    'watchlist_items', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from (select id, item_key, title, season, theme, theme_kind, display_date,
       date_sort, watched, status, created_at, watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number, show_id, skipped
       from public.watchlist_items) x),
    'tv_shows', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from (select id, title, show_key, tmdb_id, status, created_at from public.tv_shows) x),
    'custom_collections', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from (select id, name, tmdb_person_id, created_at, role from public.custom_collections) x),
    'personal_collections', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from (select id, name, catalog_id, presentation_key, sort_order, archived_at, created_at
       from public.personal_collections) x),
    'collection_memberships', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from (select id, collection_id, show_id, item_id, created_at from public.collection_memberships) x),
    'watch_with_choices', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from (select id, token, label, sort_order, archived_at, created_at from public.watch_with_choices) x),
    'catalog_show_links', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from (select id, catalog, catalog_key, show_id, origin, created_at from public.catalog_show_links) x),
    'catalog_film_links', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from (select id, catalog, entry_key, item_id, origin, created_at from public.catalog_film_links) x)
  ) t) z
$$;
-- The same, as a converted format-3 file with its recovery section (the archive's own content).
create or replace function pg_temp.doc4conv() returns jsonb language sql as $$
  select pg_temp.doc4() || jsonb_build_object(
    'conversion', jsonb_build_object('source_format', 3, 'source_exported_at', '2026-10-09T00:00:00.000Z', 'source_sha256', repeat('a', 64), 'converter_version', 'test'),
    'recovery', jsonb_build_object(
      'storage_map', jsonb_build_object(
        'items', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'collection', collection) order by id), '[]') from private.stage5_recovery_records where kind = 'item'),
        'shows', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'collection', collection) order by id), '[]') from private.stage5_recovery_records where kind = 'show'),
        'personal_collections', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'legacy_source', legacy_source) order by id), '[]') from private.stage5_recovery_collections)),
      'othertv_shows', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from (select id, tmdb_id, title, network, created_at, collection from private.stage5_recovery_othertv) x)))
$$;
-- The index of the first row of a table matching a condition on its JSON.
create or replace function pg_temp.idx(p_doc jsonb, p_table text, p_where text) returns int language plpgsql as $$
declare v int;
begin
  execute format('select (o - 1)::int from jsonb_array_elements($1 -> ''tables'' -> %L) with ordinality e(r, o) where %s order by o limit 1', p_table, p_where)
    into v using p_doc;
  return v;
end $$;
-- restore_backup with a document that must be refused with this prefix; nothing changes (tables and archive).
create or replace function pg_temp.restore_refused(p_doc jsonb, p_prefix text) returns void language plpgsql as $$
declare c text := pg_temp.content() || pg_temp.archive();
begin
  perform pg_temp.refused(format('select public.restore_backup(%L::jsonb)', p_doc), p_prefix);
  if pg_temp.content() || pg_temp.archive() <> c then raise exception 'a refused restore changed something'; end if;
end $$;

-- ── The refusal snapshot itself ──
select pg_temp.t('control: the snapshot a refused restore is compared with sees an owner change and a change in every table a restore replaces', $b$ do $$
declare c text := pg_temp.content(); u uuid := gen_random_uuid();
begin
  if not exists (select 1 from public.watch_with_choices) or not exists (select 1 from public.custom_collections) then
    raise exception 'this control needs a watch-with choice and a person collection on the replica'; end if;
  perform private.lib_write_on();
  update public.watch_with_choices set user_id = u where id = (select id from public.watch_with_choices order by id limit 1);
  if pg_temp.content() = c then raise exception 'an owner change (watch_with_choices.user_id) was not seen'; end if;
  c := pg_temp.content();
  update public.watch_with_choices set label = label || ' ZZ' where id = (select id from public.watch_with_choices order by id limit 1);
  if pg_temp.content() = c then raise exception 'a watch_with_choices change was not seen'; end if;
  c := pg_temp.content();
  update public.custom_collections set name = name || ' ZZ' where id = (select id from public.custom_collections order by id limit 1);
  if pg_temp.content() = c then raise exception 'a custom_collections change was not seen'; end if;
end $$ $b$);

-- ── The phase and what is gone ──
select pg_temp.t('the phase: contracted, backup format 4, the recovery archive active', $b$ do $$
declare c jsonb;
begin
  perform pg_temp.as_anon();
  c := public.stage5_capabilities();
  if c <> '{"stage5": 1, "phase": "contracted", "backup_format": 4, "recovery_archive": "active"}'::jsonb then raise exception '%', c; end if;
end $$ $b$);

select pg_temp.t('storage is gone: no collection / legacy_source columns, no othertv_shows, no storage helpers or membership triggers', $b$ do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and column_name in ('collection', 'legacy_source')) then raise exception 'columns'; end if;
  if to_regclass('public.othertv_shows') is not null then raise exception 'othertv_shows'; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private'
             and p.proname in ('catalog_run', 'catalog_insert_missing', 'tv_backfill', 'tv_enriched_show_for', 'tv_lock_or_create_show',
                               'tv_is_tv_row', 'tv_collections', 'tv_builtin_collections', 'org_auto_membership', 'org_bootstrap')) then raise exception 'helpers'; end if;
  if exists (select 1 from pg_trigger where not tgisinternal
             and tgname in ('org_auto_membership_show', 'org_auto_membership_film', 'org_carry_membership_to_film')) then raise exception 'membership triggers'; end if;
  -- (The watch-with triggers stay: org_check_watch_with, org_guard_watch_with_choice.)
  if (select count(*) from pg_trigger where not tgisinternal and tgname in ('org_check_watch_with', 'org_guard_watch_with_choice')) <> 2 then raise exception 'watch-with triggers'; end if;
end $$ $b$);

select pg_temp.t('database source scan (A13): no function in public or private names a storage column or othertv_shows, except restore_backup''s format-3 recovery section and the archive', $b$ do $$
declare bad text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prolang in (select oid from pg_language where lanname in ('plpgsql', 'sql'))
    and (p.prosrc ~ '\.collection\M' or p.prosrc ~ '\mlegacy_source\M' or p.prosrc ~ 'othertv_shows')
    and p.proname not in ('restore_backup');
  if bad is not null then raise exception 'storage named in: %', bad; end if;
end $$ $b$);

-- ── What the contraction carried over ──
select pg_temp.t('governance equals the storage it replaced: one link per catalog-stored show and film (origin migrated_from_storage), and no other', $b$ do $$
begin
  if (select count(*) from public.catalog_show_links where origin = 'migrated_from_storage')
     <> (select count(*) from private.stage5_recovery_records where kind = 'show' and collection in ('disney', '90day', 'sheridan')) then raise exception 'show links'; end if;
  if exists (select 1 from public.catalog_show_links l join private.stage5_recovery_records r on r.kind = 'show' and r.id = l.show_id where r.collection <> l.catalog) then raise exception 'show catalog'; end if;
  if (select count(*) from public.catalog_film_links where origin = 'migrated_from_storage')
     <> (select count(*) from private.stage5_recovery_records r join public.watchlist_items w on w.id = r.id where r.kind = 'item' and w.is_film and r.collection in ('disney', '90day', 'sheridan')) then raise exception 'film links'; end if;
  if exists (select 1 from public.watchlist_items w join private.stage5_recovery_records r on r.kind = 'item' and r.id = w.id
             where w.is_film and w.theme_kind is distinct from case when r.collection = 'movies' then 'genre' else 'other' end) then raise exception 'theme_kind'; end if;
  if exists (select 1 from public.watchlist_items where not is_film and theme_kind is not null) then raise exception 'season kind'; end if;
  if exists (select 1 from public.personal_collections c join private.stage5_recovery_collections r on r.id = c.id
             where c.catalog_id is distinct from case when r.legacy_source in ('disney', '90day', 'sheridan') then r.legacy_source end) then raise exception 'catalog_id'; end if;
end $$ $b$);

select pg_temp.t('the archive holds exactly the storage of every record and collection and every othertv_shows row, with matching counts and hashes', $b$ do $$
declare m record;
begin
  for m in select * from private.stage5_recovery_meta loop
    if m.origin <> 'contraction' then raise exception 'origin %', m.origin; end if;
    if (m.counts ->> 'items')::int <> (select count(*) from public.watchlist_items where user_id = m.user_id)
       or (m.counts ->> 'shows')::int <> (select count(*) from public.tv_shows where user_id = m.user_id)
       or (m.counts ->> 'collections')::int <> (select count(*) from public.personal_collections where user_id = m.user_id) then raise exception 'counts %', m.counts; end if;
    if m.hashes ->> 'othertv_shows' <> (select md5(coalesce(string_agg((to_jsonb(r) - 'user_id')::text, '|' order by r.id), '')) from private.stage5_recovery_othertv r where r.user_id = m.user_id) then raise exception 'othertv hash'; end if;
  end loop;
end $$ $b$);

-- ── The write boundary (guards and grants) ──
select pg_temp.t('direct writes outside the library functions are refused (library_write_required); plain edits (watched, status, a collection without a catalog) still work', $b$ do $$
declare w uuid; s uuid; c text;
begin
  perform pg_temp.as_anon();
  w := (select id from public.watchlist_items where is_film limit 1);
  s := (select id from public.tv_shows limit 1);
  c := pg_temp.content();
  perform pg_temp.refused($q$ insert into public.watchlist_items (item_key, title, season, date_sort, theme_kind) values ('zz d|film', 'ZZ D', 'Film', '2020-01-01', 'genre') $q$, 'library_write_required');
  perform pg_temp.refused($q$ insert into public.tv_shows (title, show_key) values ('ZZ D', 'zz d') $q$, 'library_write_required');
  perform pg_temp.refused(format($q$ insert into public.catalog_show_links (catalog, catalog_key, show_id, origin) values ('disney', 'zz', %L, 'catalog_insert') $q$, s), 'library_write_required');
  perform pg_temp.refused(format($q$ update public.watchlist_items set tmdb_id = 1, media_type = 'movie' where id = %L $q$, w), 'library_write_required');
  perform pg_temp.refused(format($q$ update public.watchlist_items set theme_kind = case when theme_kind = 'genre' then 'other' else 'genre' end where id = %L $q$, w), 'library_write_required');
  perform pg_temp.refused(format($q$ update public.tv_shows set show_key = 'zz moved' where id = %L $q$, s), 'library_write_required');
  perform pg_temp.refused($q$ insert into public.personal_collections (name, sort_order, catalog_id) values ('ZZ C', 999, 'disney') $q$, 'library_write_required');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
  update public.watchlist_items set watched = not watched where id = w;
  update public.watchlist_items set status = 'maybe' where id = w;
  insert into public.personal_collections (name, sort_order) values ('ZZ Plain', 998);
end $$ $b$);

select pg_temp.t('the archive is not reachable through the API (private schema) and refuses direct inserts and deletes; the read views and link tables run as the caller', $b$ do $$
begin
  perform pg_temp.as_anon();
  perform pg_temp.refused($q$ delete from private.stage5_recovery_othertv $q$, 'library_write_required');
  perform pg_temp.refused($q$ insert into private.stage5_recovery_meta (user_id, origin, counts, hashes) values (gen_random_uuid(), 'contraction', '{}', '{}') $q$, 'library_write_required');
  perform pg_temp.as_admin();
  if exists (select 1 from pg_class where relname like 'library\_%' and relkind = 'v' and not coalesce(reloptions @> array['security_invoker=true'], false)) then raise exception 'views'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.catalog_show_links'::regclass) then raise exception 'rls'; end if;
  if has_table_privilege('anon', 'public.catalog_show_links', 'UPDATE') or has_table_privilege('anon', 'public.catalog_show_links', 'DELETE') then raise exception 'link grants'; end if;
end $$ $b$);

-- ── Governance rules (U3) ──
select pg_temp.t('one governing catalog per record: a second link for a show or film, a duplicate catalog entry and a film link to a TV season are refused', $b$ do $$
declare l public.catalog_show_links; f public.catalog_film_links; tvrow uuid;
begin
  perform private.lib_write_on();
  select * into l from public.catalog_show_links limit 1;
  select * into f from public.catalog_film_links limit 1;
  tvrow := (select id from public.watchlist_items where not is_film limit 1);
  if l.id is not null then
    perform pg_temp.refused(format($q$ insert into public.catalog_show_links (user_id, catalog, catalog_key, show_id, origin) values (%L, '90day', 'zz other key', %L, 'catalog_insert') $q$, l.user_id, l.show_id), 'duplicate key');
    perform pg_temp.refused(format($q$ insert into public.catalog_show_links (user_id, catalog, catalog_key, show_id, origin) values (%L, %L, %L, (select id from public.tv_shows where id <> %L and id not in (select show_id from public.catalog_show_links) limit 1), 'catalog_insert') $q$,
      l.user_id, l.catalog, l.catalog_key, l.show_id), 'duplicate key');
  end if;
  if f.id is not null then
    perform pg_temp.refused(format($q$ insert into public.catalog_film_links (user_id, catalog, entry_key, item_id, origin) values (%L, '90day', 'zz other|film', %L, 'catalog_insert') $q$, f.user_id, f.item_id), 'duplicate key');
  end if;
  perform pg_temp.refused(format($q$ insert into public.catalog_film_links (user_id, catalog, entry_key, item_id, origin) values (private.current_owner_id(), 'disney', 'zz tv|film', %L, 'catalog_insert') $q$, tvrow), 'insert or update on table');
end $$ $b$);

-- ── The library functions without storage ──
select pg_temp.t('library_add_films: the film''s theme is a genre (theme_kind), governed by no catalog; a repeat is existing', $b$ do $$
declare v jsonb; v_id uuid;
begin
  perform pg_temp.as_anon();
  v := public.library_add_films(jsonb_build_array(pg_temp.film('ZZ Film C', 992001)));
  v_id := (v -> 'results' -> 0 ->> 'id')::uuid;
  if (select theme_kind from public.watchlist_items where id = v_id) <> 'genre' or private.lib_film_catalog(v_id) is not null then raise exception '%', v; end if;
  v := public.library_add_films(jsonb_build_array(pg_temp.film('ZZ Film C', 992001)));
  if v -> 'results' -> 0 ->> 'outcome' <> 'existing' then raise exception '%', v; end if;
end $$ $b$);

select pg_temp.t('library_create_show: governed by no catalog; a same-key unmatched show is refused unless the page listed it, and then a separate show is created (no storage limitation now)', $b$ do $$
declare a public.tv_shows; b public.tv_shows;
begin
  perform pg_temp.as_anon();
  a := pg_temp.new_show(null, 'ZZ Twin C');
  if exists (select 1 from public.catalog_show_links where show_id = a.id) then raise exception 'governed'; end if;
  perform pg_temp.refused($q$ select pg_temp.new_show(null, 'ZZ Twin C') $q$, 'show_exists');
  b := pg_temp.new_show(null, 'ZZ Twin C', jsonb_build_array(a.id));
  if b.id = a.id or b.show_key <> a.show_key then raise exception 'not separate'; end if;
  perform pg_temp.refused($q$ select pg_temp.new_show(null, 'ZZ Twin C') $q$, 'show_exists');
end $$ $b$);

select pg_temp.t('library_add_seasons and Match: a governed show takes labels; Match into it is match_target_governed; a governed row is not_eligible; a genre film stays a film (genre_film_season); a company-theme film may become a season (theme_kind cleared); every refusal leaves everything unchanged', $b$ do $$
declare g public.tv_shows; f uuid; o uuid; u public.tv_shows; t public.tv_shows; c text; v jsonb;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply(pg_temp.defaults());
  select * into g from public.tv_shows where show_key = 'zz cat show';
  if pg_temp.expected(g) ->> 'catalog' <> 'sheridan' then raise exception 'not governed'; end if;
  v := public.library_add_seasons(g.id, pg_temp.expected(g), jsonb_build_array(pg_temp.by_label(g.show_key, g.title, 'Season 3', '2023-01-01')));
  if jsonb_array_length(v -> 'inserted') <> 1 then raise exception '%', v; end if;
  c := pg_temp.content() || pg_temp.archive();
  perform pg_temp.refused(format('select public.library_match_season(%L, ''{"tmdb_id": 992010}''::jsonb, %L::jsonb)',
    (select id from public.watchlist_items where show_id = g.id limit 1), pg_temp.by_number('zz x', 'ZZ X', 1, '2020-01-01') || '{"media_type":"tv","tmdb_id":992010}'), 'not_eligible');
  perform pg_temp.as_admin();
  perform private.lib_write_on();
  update public.tv_shows set tmdb_id = 992011 where id = g.id;
  -- an unidentified film no catalog governs whose theme is a company name (as True Crime / Docs films are)
  insert into public.watchlist_items (user_id, item_key, title, season, date_sort, theme, theme_kind)
    values (private.current_owner_id(), 'zz company film|film', 'ZZ Company Film', 'Film', '2020-01-01', 'HBO Docs', 'other') returning id into o;
  perform pg_temp.as_anon();
  f := (public.library_create_film(pg_temp.film('ZZ Loose Film')) ->> 'id')::uuid;   -- a genre film
  u := pg_temp.new_show(null, 'ZZ Loose Show');
  c := pg_temp.content() || pg_temp.archive();
  perform pg_temp.refused(format('select public.library_match_season(%L, ''{"tmdb_id": 992011}''::jsonb, %L::jsonb)', (select id from public.watchlist_items where show_id = u.id),
    pg_temp.by_number('zz cat show', 'ZZ Cat Show', 9, '2029-01-01') || '{"media_type":"tv","tmdb_id":992011}'), 'match_target_governed');
  perform pg_temp.refused(format('select public.library_match_season(%L, ''{"tmdb_id": 992012}''::jsonb, %L::jsonb)', f,
    pg_temp.by_number('zz t5c', 'ZZ T5c', 1, '2022-01-01') || '{"media_type":"tv","tmdb_id":992012}'), 'genre_film_season');
  if pg_temp.content() || pg_temp.archive() <> c then raise exception 'a refusal changed something'; end if;
  t := pg_temp.new_show(992012, 'ZZ T5c');
  v := public.library_match_season(o, '{"tmdb_id": 992012}'::jsonb, pg_temp.by_number('zz t5c', 'ZZ T5c', 2, '2022-01-01') || '{"media_type":"tv","tmdb_id":992012}');
  if (select show_id from public.watchlist_items where id = o) <> t.id or (select theme_kind from public.watchlist_items where id = o) is not null then raise exception '%', v; end if;
end $$ $b$);

select pg_temp.t('library_match_film: a season becomes a film whose theme is a company name (theme_kind other), keeps its show''s collections; the emptied show and its links go', $b$ do $$
declare s public.tv_shows; r uuid; pc uuid; v jsonb;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_show(null, 'ZZ Was C');
  r := (select id from public.watchlist_items where show_id = s.id);
  insert into public.personal_collections (name, sort_order) values ('ZZ Coll C', 997) returning id into pc;
  insert into public.collection_memberships (collection_id, show_id) values (pc, s.id);
  v := public.library_match_film(r, jsonb_build_object('show_id', s.id), pg_temp.film_patch('ZZ Became C', 992020));
  if not (v ->> 'former_show_deleted')::boolean then raise exception '%', v; end if;
  if (select theme_kind from public.watchlist_items where id = r) <> 'other' then raise exception 'kind'; end if;
  if not exists (select 1 from public.collection_memberships where item_id = r and collection_id = pc) then raise exception 'collection'; end if;
end $$ $b$);

select pg_temp.t('delete_tv_season: the last season removes its show, and the show''s governance link goes with it', $b$ do $$
declare g uuid;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply(pg_temp.defaults());
  g := (select id from public.tv_shows where show_key = 'zz cat show');
  perform public.delete_tv_season(id) from public.watchlist_items where show_id = g;
  if exists (select 1 from public.tv_shows where id = g) or exists (select 1 from public.catalog_show_links where show_id = g) then raise exception 'left behind'; end if;
end $$ $b$);

-- ── Catalog updates without storage ──
select pg_temp.t('library_catalog_apply: new entries are governed by links (origin catalog_insert) and join the catalog''s collection (catalog_id) explicitly', $b$ do $$
declare v jsonb; s uuid; f uuid; pc uuid;
begin
  perform pg_temp.as_anon();
  v := pg_temp.apply(pg_temp.defaults());
  s := (select id from public.tv_shows where show_key = 'zz cat show');
  f := (select id from public.watchlist_items where item_key = 'zz cat film|film');
  if (select origin from public.catalog_show_links where show_id = s) <> 'catalog_insert' or (select catalog from public.catalog_film_links where item_id = f) <> 'sheridan' then raise exception 'links'; end if;
  if (select theme_kind from public.watchlist_items where id = f) <> 'other' then raise exception 'kind'; end if;
  pc := (select id from public.personal_collections where catalog_id = 'sheridan');
  if pc is not null and (not exists (select 1 from public.collection_memberships where collection_id = pc and show_id = s)
                         or not exists (select 1 from public.collection_memberships where collection_id = pc and item_id = f)) then raise exception 'memberships'; end if;
end $$ $b$);

select pg_temp.t('catalog collision (U7) without storage: an ungoverned same-key show or same-title film is a candidate (excluded with its id), never adopted, re-governed or duplicated', $b$ do $$
declare a public.tv_shows; f uuid; x jsonb;
begin
  perform pg_temp.as_anon();
  a := pg_temp.new_show(null, 'ZZ Cat Show');
  f := (public.library_create_film(pg_temp.film('ZZ Cat Film')) ->> 'id')::uuid;
  x := pg_temp.excluded(pg_temp.preview(pg_temp.defaults()));
  if jsonb_array_length(x) <> 3 or not exists (select 1 from jsonb_array_elements(x) e where e -> 'candidates' ? a.id::text)
     or not exists (select 1 from jsonb_array_elements(x) e where e -> 'candidates' ? f::text) then raise exception '%', x; end if;
  perform pg_temp.apply(pg_temp.defaults());
  if (select count(*) from public.tv_shows where show_key = 'zz cat show') <> 1 or exists (select 1 from public.catalog_show_links where show_id = a.id)
     or exists (select 1 from public.catalog_film_links where item_id = f) then raise exception 'adopted or duplicated'; end if;
end $$ $b$);

select pg_temp.t('serial order — the catalog, then a creation prepared before it: refused (show_exists / film_exists); a creation, then the catalog: excluded', $b$ do $$
declare c text; x jsonb;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply(pg_temp.defaults());
  c := pg_temp.content();
  perform pg_temp.refused($q$ select pg_temp.new_show(null, 'ZZ Cat Show') $q$, 'show_exists');
  perform pg_temp.refused(format('select public.library_create_film(%L::jsonb)', pg_temp.film('ZZ Cat Film')), 'film_exists');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
  perform pg_temp.new_show(null, 'ZZ Cat Two');
  x := pg_temp.excluded(pg_temp.preview(pg_temp.defaults('ZZ Cat Two', 'ZZ Cat Film Two')));
  if jsonb_array_length(x) <> 2 then raise exception '%', x; end if;
end $$ $b$);

-- ── Old pages ──
select pg_temp.t('an old page''s functions refuse (client_outdated) and write nothing: add_tv_seasons, add_tv_seasons_to_show, create_tv_show, match_tv_row, catalog_apply', $b$ do $$
declare c text;
begin
  perform pg_temp.as_anon();
  c := pg_temp.content();
  perform pg_temp.refused($q$ select public.add_tv_seasons('othertv', '{}', '[]') $q$, 'client_outdated');
  perform pg_temp.refused($q$ select public.add_tv_seasons_to_show(gen_random_uuid(), '{}', '[]') $q$, 'client_outdated');
  perform pg_temp.refused($q$ select public.create_tv_show('{}', '[]') $q$, 'client_outdated');
  perform pg_temp.refused($q$ select public.match_tv_row(gen_random_uuid(), '{}', '{}') $q$, 'client_outdated');
  perform pg_temp.refused($q$ select public.catalog_apply('sheridan', '[]') $q$, 'client_outdated');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('restore_backup takes format 4 only: a format-3 document is refused (convert it in the page), and a recovery section without a conversion is refused; nothing written', $b$ do $$
declare c text;
begin
  perform pg_temp.as_anon();
  c := pg_temp.content();
  perform pg_temp.refused($q$ select public.restore_backup('{"format":"watchlist-tracker-backup","formatVersion":3,"tables":{}}'::jsonb) $q$, 'restore_invalid');
  perform pg_temp.refused($q$ select public.restore_backup('{"format":"watchlist-tracker-backup","formatVersion":4,"tables":{},"recovery":{}}'::jsonb) $q$, 'restore_invalid');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);


-- ── Format-4 restore: every refusal starts from a valid document ──
select pg_temp.t('restore: the unchanged current document is accepted (the baseline every refusal below mutates)', $b$ do $$
declare d jsonb; c text;
begin
  perform pg_temp.as_anon();
  d := pg_temp.doc4(); c := pg_temp.content();
  perform public.restore_backup(d);
  if pg_temp.content() <> c then raise exception 'restore of the current document changed it'; end if;
end $$ $b$);

select pg_temp.t('restore refusals from a valid document, each changing nothing (tables and archive): a film without a theme kind (F3), a kind on a season, an unknown kind, an unlinked season, a film link to a season, a duplicate governing link, an unknown presentation key, catalog vs presentation disagreeing, a repeated id, wrong rowCounts, an extra column', $b$ do $$
declare d jsonb; i int; s int; j int;
begin
  perform pg_temp.as_anon();
  d := pg_temp.doc4();
  i := pg_temp.idx(d, 'watchlist_items', 'r ->> ''theme_kind'' = ''genre''');
  s := pg_temp.idx(d, 'watchlist_items', 'r ->> ''show_id'' is not null');
  perform pg_temp.restore_refused(jsonb_set(d, array['tables', 'watchlist_items', i::text, 'theme_kind'], 'null'), 'restore_invalid');
  perform pg_temp.restore_refused(jsonb_set(d, array['tables', 'watchlist_items', s::text, 'theme_kind'], '"genre"'), 'restore_invalid');
  perform pg_temp.restore_refused(jsonb_set(d, array['tables', 'watchlist_items', i::text, 'theme_kind'], '"documentary"'), 'restore_invalid');
  perform pg_temp.restore_refused(jsonb_set(d, array['tables', 'watchlist_items', s::text, 'show_id'], 'null'), 'restore_invalid');
  if jsonb_array_length(d -> 'tables' -> 'catalog_film_links') > 0 then
    perform pg_temp.restore_refused(jsonb_set(d, array['tables', 'catalog_film_links', '0', 'item_id'], to_jsonb(d -> 'tables' -> 'watchlist_items' -> s ->> 'id')), 'restore_invalid');
  end if;
  if jsonb_array_length(d -> 'tables' -> 'catalog_show_links') > 1 then
    perform pg_temp.restore_refused(jsonb_set(d, array['tables', 'catalog_show_links', '1', 'show_id'], d -> 'tables' -> 'catalog_show_links' -> 0 -> 'show_id'), 'restore_invalid');
  end if;
  j := pg_temp.idx(d, 'personal_collections', 'true');
  perform pg_temp.restore_refused(jsonb_set(d, array['tables', 'personal_collections', j::text, 'presentation_key'], '"movies"'), 'restore_invalid');
  j := pg_temp.idx(d, 'personal_collections', 'r ->> ''catalog_id'' is not null');
  if j is not null then
    perform pg_temp.restore_refused(jsonb_set(d, array['tables', 'personal_collections', j::text, 'presentation_key'], '"truecrime"'), 'restore_invalid');
  end if;
  -- (A repeated id fails the primary key, which restore reports as restore_id_collision: refused either way.)
  perform pg_temp.restore_refused(jsonb_set(d, array['tables', 'watchlist_items', '1', 'id'], d -> 'tables' -> 'watchlist_items' -> 0 -> 'id'), 'restore_id_collision');
  perform pg_temp.restore_refused(jsonb_set(d, array['rowCounts', 'tv_shows'], '1'), 'restore_invalid');
  perform pg_temp.restore_refused(jsonb_set(d, array['tables', 'tv_shows', '0', 'collection'], '"othertv"'), 'restore_invalid');
end $$ $b$);

select pg_temp.t('restore: a recovery section needs a conversion record (recovery_not_accepted); a malformed conversion record is refused; a recovery section that disagrees with governance or presentation is refused — all from valid documents, nothing changed', $b$ do $$
declare d jsonb; k int;
begin
  perform pg_temp.as_anon();
  d := pg_temp.doc4conv();
  perform pg_temp.restore_refused(d - 'conversion', 'recovery_not_accepted');
  perform pg_temp.restore_refused(jsonb_set(d, '{conversion,source_sha256}', '"not-a-hash"'), 'restore_invalid');
  k := pg_temp.idx(d, 'personal_collections', 'r ->> ''presentation_key'' = ''truecrime''');
  if k is not null then
    perform pg_temp.restore_refused(jsonb_set(d, array['tables', 'personal_collections', k::text, 'presentation_key'], 'null'), 'restore_invalid');
  end if;
  perform pg_temp.restore_refused(jsonb_set(d, '{recovery,storage_map,shows}',
    (select jsonb_agg(case when (x ->> 'collection') = 'othertv' then jsonb_set(x, '{collection}', '"disney"') else x end) from jsonb_array_elements(d -> 'recovery' -> 'storage_map' -> 'shows') x)), 'restore_invalid');
end $$ $b$);

select pg_temp.t('restore: a converted document with its recovery section is accepted; the archive then equals the section exactly and records its own content hashes (origin converted_restore)', $b$ do $$
declare d jsonb; m record;
begin
  perform pg_temp.as_anon();
  d := pg_temp.doc4conv();
  perform public.restore_backup(d);
  select * into m from private.stage5_recovery_meta;
  if m.origin <> 'converted_restore' or m.hashes ->> 'source_sha256' <> repeat('a', 64) then raise exception 'meta %', to_jsonb(m); end if;
  if m.hashes ->> 'records' <> (select md5(coalesce(string_agg(r.kind || ':' || r.id || ':' || r.collection, '|' order by r.kind, r.id), '')) from private.stage5_recovery_records r)
     or m.hashes ->> 'othertv_shows' <> (select md5(coalesce(string_agg((to_jsonb(r) - 'user_id')::text, '|' order by r.id), '')) from private.stage5_recovery_othertv r) then
    raise exception 'hashes are not of the installed archive';
  end if;
  if (select count(*) from private.stage5_recovery_othertv) <> jsonb_array_length(d -> 'recovery' -> 'othertv_shows') then raise exception 'othertv'; end if;
end $$ $b$);

select pg_temp.t('restore after the archive is retired: without a recovery section it is accepted; with one it is refused (recovery_not_accepted), nothing changed', $b$ do $$
declare d jsonb; c text;
begin
  perform pg_temp.as_admin();
  drop table private.stage5_recovery_meta;   -- what retirement leaves (rolled back with this check)
  perform pg_temp.as_anon();
  if public.stage5_capabilities() ->> 'recovery_archive' <> 'retired' then raise exception 'not retired'; end if;
  d := pg_temp.doc4conv();
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.restore_backup(%L::jsonb)', d), 'recovery_not_accepted');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
  perform public.restore_backup(d - 'recovery');
  if pg_temp.content() <> c then raise exception 'the restore of the same contents changed them'; end if;
end $$ $b$);

-- ── Classification (persistent) ──
select pg_temp.t('every film has a theme kind and every row is a film or a linked season, even inside a library write (CHECK constraints)', $b$ do $$
declare f uuid;
begin
  perform pg_temp.as_admin();
  perform private.lib_write_on();
  f := (select id from public.watchlist_items where is_film limit 1);
  perform pg_temp.refused(format('update public.watchlist_items set theme_kind = null where id = %L', f), 'new row for relation');
  perform pg_temp.refused($q$ insert into public.watchlist_items (user_id, item_key, title, season, date_sort) values (private.current_owner_id(), 'zz loose|season 1', 'ZZ Loose', 'Season 1', '2020-01-01') $q$, 'new row for relation');
end $$ $b$);

-- ── Presentation keys ──
select pg_temp.t('presentation keys: True Crime / Docs keeps its key (from the archive), the catalogs’ equal their catalog_id; anon can’t set or change one directly', $b$ do $$
declare c uuid;
begin
  if exists (select 1 from public.personal_collections p join private.stage5_recovery_collections a on a.id = p.id
             where p.presentation_key is distinct from case when a.legacy_source in ('disney', '90day', 'sheridan', 'truecrime') then a.legacy_source end) then
    raise exception 'presentation keys differ from the archived legacy_source';
  end if;
  perform pg_temp.as_anon();
  perform pg_temp.refused($q$ insert into public.personal_collections (name, sort_order, presentation_key) values ('ZZ P', 990, 'truecrime') $q$, 'library_write_required');
  c := (select id from public.personal_collections where presentation_key is not null limit 1);
  if c is not null then
    perform pg_temp.refused(format('update public.personal_collections set presentation_key = null where id = %L', c), 'permission denied');  -- (no column grant; the guard is the second line)
  end if;
  if (select count(*) from public.library_collection_presentation) <> (select count(*) from public.personal_collections where presentation_key is not null) then raise exception 'view'; end if;
end $$ $b$);

-- ── Date guard and archived target, without storage ──
select pg_temp.t('the date guard: a governed entry''s date changes only inside a catalog application (catalog_apply_required); an ungoverned film''s date is an ordinary edit', $b$ do $$
declare g uuid; u uuid;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply(pg_temp.defaults());
  g := (select id from public.watchlist_items where item_key = 'zz cat film|film');
  perform pg_temp.refused(format('update public.watchlist_items set display_date = ''Jan 2, 2022'', date_sort = ''2022-01-02'' where id = %L', g), 'catalog_apply_required');
  u := (public.library_create_film(pg_temp.film('ZZ Own Film')) ->> 'id')::uuid;
  update public.watchlist_items set display_date = 'Jan 2, 2022', date_sort = '2022-01-02' where id = u;
end $$ $b$);

select pg_temp.t('an archived catalog collection: new catalog records join no collection; existing memberships stay', $b$ do $$
declare pc uuid; n int;
begin
  pc := (select id from public.personal_collections where catalog_id = 'sheridan');
  if pc is null then return; end if;
  perform pg_temp.as_admin();
  update public.personal_collections set archived_at = now() where id = pc;
  perform pg_temp.as_anon();
  n := (select count(*) from public.collection_memberships where collection_id = pc);
  perform pg_temp.apply(pg_temp.defaults());
  if (select count(*) from public.collection_memberships where collection_id = pc) <> n then raise exception 'joined an archived collection'; end if;
end $$ $b$);

-- ── Match carries archived memberships ──
select pg_temp.t('library_match_film keeps the former show''s archived collections too', $b$ do $$
declare s public.tv_shows; r uuid; pc uuid;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_show(null, 'ZZ Was Archived');
  r := (select id from public.watchlist_items where show_id = s.id);
  insert into public.personal_collections (name, sort_order, archived_at) values ('ZZ Archived Coll', 996, now()) returning id into pc;
  perform pg_temp.as_admin();
  insert into public.collection_memberships (user_id, collection_id, show_id) values (s.user_id, pc, s.id);
  perform pg_temp.as_anon();
  perform public.library_match_film(r, jsonb_build_object('show_id', s.id), pg_temp.film_patch('ZZ Archived Film', 992030));
  if not exists (select 1 from public.collection_memberships where item_id = r and collection_id = pc) then raise exception 'archived collection not kept'; end if;
end $$ $b$);

-- ── The catalog collision rule from the other side (F2), both orders, without storage ──
select pg_temp.t('catalog first, then a same-title creation under another key: refused (catalog_candidate, the catalog record named) for a show by hand, a TMDB show, a film by hand and a TMDB film; acknowledged (distinct_from), each is created', $b$ do $$
declare cat_s uuid; cat_f uuid; c text; v jsonb;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply(pg_temp.defaults('ZZ Shared Title', 'ZZ Shared Film'));
  cat_s := (select id from public.tv_shows where show_key = 'zz shared title');
  cat_f := (select id from public.watchlist_items where item_key = 'zz shared film|film');
  c := pg_temp.content();
  perform pg_temp.refused($q$ select public.library_create_show('{"title":"ZZ Shared Title","show_key":"zz other key"}'::jsonb,
    '[{"item_key":"zz other key|season 1","title":"ZZ Shared Title","season":"Season 1","date_sort":"2020-01-01"}]'::jsonb) $q$, 'catalog_candidate');
  perform pg_temp.refused($q$ select public.library_create_show('{"tmdb_id":992040,"title":"ZZ Shared Title","show_key":"zz shared title tmdb"}'::jsonb,
    '[{"item_key":"zz shared title tmdb|season 1","title":"ZZ Shared Title","season":"Season 1","date_sort":"2020-01-01","season_number":1}]'::jsonb) $q$, 'catalog_candidate');
  perform pg_temp.refused($q$ select public.library_create_film('{"title":"ZZ Shared Film","item_key":"zz shared film (2)|film","season":"Film","date_sort":"2020-01-01"}'::jsonb) $q$, 'catalog_candidate');
  v := public.library_add_films('[{"tmdb_id":992041,"title":"ZZ Shared Film","item_key":"zz shared film|film","date_sort":"2020-01-01"}]'::jsonb);
  if v -> 'results' -> 0 ->> 'outcome' <> 'catalog_candidate' or not (v -> 'results' -> 0 -> 'candidates' ? cat_f::text) then raise exception '%', v; end if;
  if pg_temp.content() <> c then raise exception 'a refusal changed something'; end if;
  perform public.library_create_show(jsonb_build_object('title', 'ZZ Shared Title', 'show_key', 'zz other key', 'distinct_from', jsonb_build_array(cat_s)),
    '[{"item_key":"zz other key|season 1","title":"ZZ Shared Title","season":"Season 1","date_sort":"2020-01-01"}]'::jsonb);
  perform public.library_create_film(jsonb_build_object('title', 'ZZ Shared Film', 'item_key', 'zz shared film (2)|film', 'season', 'Film', 'date_sort', '2020-01-01', 'distinct_from', jsonb_build_array(cat_f)));
  v := public.library_add_films(jsonb_build_array(jsonb_build_object('tmdb_id', 992041, 'title', 'ZZ Shared Film', 'item_key', 'zz shared film|film', 'date_sort', '2020-01-01', 'distinct_from', jsonb_build_array(cat_f))));
  if v -> 'results' -> 0 ->> 'outcome' <> 'inserted' then raise exception '%', v; end if;
  if (select count(*) from public.tv_shows where title = 'ZZ Shared Title') <> 2 then raise exception 'distinct works not kept'; end if;
end $$ $b$);

select pg_temp.t('creation first, then the catalog: the same-title record under another key is a candidate (excluded, its id named), so neither order leaves an unacknowledged twin', $b$ do $$
declare a public.tv_shows; x jsonb;
begin
  perform pg_temp.as_anon();
  a := pg_temp.new_show(null, 'ZZ Shared Title');   -- key 'zz shared title' ... and a different key below
  perform public.library_create_show('{"title":"ZZ Second Title","show_key":"zz second other key"}'::jsonb,
    '[{"item_key":"zz second other key|season 1","title":"ZZ Second Title","season":"Season 1","date_sort":"2020-01-01"}]'::jsonb);
  x := pg_temp.excluded(pg_temp.preview(pg_temp.defaults('ZZ Second Title', 'ZZ Unused Film')));
  if not exists (select 1 from jsonb_array_elements(x) e where e ->> 'reason' = 'existing_record') then raise exception '%', x; end if;
  perform pg_temp.apply(pg_temp.defaults('ZZ Second Title', 'ZZ Unused Film'));
  if (select count(*) from public.tv_shows where title = 'ZZ Second Title') <> 1 then raise exception 'twin created'; end if;
end $$ $b$);

select pg_temp.t('catalog first, then a Match that would name a show or a film after a catalog record: refused (catalog_candidate), nothing changed; acknowledged, matched', $b$ do $$
declare cat_s uuid; cat_f uuid; u public.tv_shows; r uuid; c text;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply(pg_temp.defaults('ZZ Match Title', 'ZZ Match Film'));
  cat_s := (select id from public.tv_shows where show_key = 'zz match title');
  cat_f := (select id from public.watchlist_items where item_key = 'zz match film|film');
  u := pg_temp.new_show(null, 'ZZ Unmatched One');
  r := (select id from public.watchlist_items where show_id = u.id);
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_match_season(%L, ''{"tmdb_id": 992050}''::jsonb, %L::jsonb)', r,
    pg_temp.by_number('zz match title', 'ZZ Match Title', 1, '2020-01-01') || '{"media_type":"tv","tmdb_id":992050}'), 'catalog_candidate');
  perform pg_temp.refused(format('select public.library_match_film(%L, %L::jsonb, %L::jsonb)', r, jsonb_build_object('show_id', u.id),
    pg_temp.film_patch('ZZ Match Film', 992051)), 'catalog_candidate');
  if pg_temp.content() <> c then raise exception 'a refusal changed something'; end if;
  perform public.library_match_season(r, '{"tmdb_id": 992050}'::jsonb, pg_temp.by_number('zz match title', 'ZZ Match Title', 1, '2020-01-01')
    || jsonb_build_object('media_type', 'tv', 'tmdb_id', 992050, 'distinct_from', jsonb_build_array(cat_s)));
  if (select tmdb_id from public.watchlist_items where id = r) <> 992050 then raise exception 'not matched'; end if;
end $$ $b$);

-- ── The new wrappers: all or nothing, the intended parent ──
select pg_temp.t('library_create_show refuses a request with a season repeated or not matching its show as a whole (invalid_input; its create_conflict branch is defensive: unreachable in one session), and library_add_seasons refuses a deleted or changed parent; nothing changes', $b$ do $$
declare s public.tv_shows; c text;
begin
  perform pg_temp.as_anon();
  c := pg_temp.content();
  perform pg_temp.refused($q$ select public.library_create_show('{"tmdb_id":992060,"title":"ZZ Dup Seasons","show_key":"zz dup seasons"}'::jsonb,
    '[{"item_key":"zz dup seasons|season 1","title":"ZZ Dup Seasons","season":"Season 1","date_sort":"2020-01-01","season_number":1},
      {"item_key":"zz dup seasons|season 1","title":"ZZ Dup Seasons","season":"Season 1","date_sort":"2020-01-01","season_number":1}]'::jsonb) $q$, 'invalid_input');
  if pg_temp.content() <> c then raise exception 'partial creation'; end if;
  s := pg_temp.new_show(992061, 'ZZ Parent');
  perform pg_temp.refused(format('select public.library_add_seasons(%L, %L::jsonb, %L::jsonb)', s.id, pg_temp.expected(s) || '{"tmdb_id": 1}',
    jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01'))), 'target_changed');
  perform public.delete_tv_season((select id from public.watchlist_items where show_id = s.id));
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_add_seasons(%L, %L::jsonb, %L::jsonb)', s.id, pg_temp.expected(s),
    jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01'))), 'target_missing');
  if pg_temp.content() <> c then raise exception 'recreated'; end if;
end $$ $b$);

-- ── Match × creation of the same TMDB identity (the G2 C3 stop, 2026-10-10; contracted core) ──
-- Single-session: each serial order, and that both calls take the same per-identity lock
-- (held to the end of the transaction), which is what makes the other order wait. How
-- two sessions interleave is validated with two real connections (pending; see G2).
create or replace function pg_temp.holds_tvid(p_tmdb int) returns boolean language sql as $$
  select exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.objsubid = 1
    and l.objid = ((hashtext(private.current_owner_id()::text || '|tvid|' || p_tmdb)::bigint) & 4294967295)::oid
    and l.classid = (((hashtext(private.current_owner_id()::text || '|tvid|' || p_tmdb)::bigint) >> 32) & 4294967295)::oid)
$$;
create or replace function pg_temp.season_patch(p_title text, p_tmdb int, p_num int) returns jsonb language sql as $$
  select pg_temp.by_number(lower(p_title), p_title, p_num, '2021-01-01') || jsonb_build_object('media_type', 'tv', 'tmdb_id', p_tmdb)
$$;
select pg_temp.t('identity lock: library_create_show and library_match_season both hold the per-TMDB-identity transaction lock (a Match waits for a concurrent creation of its target, and the reverse)', $b$ do $$
declare u public.tv_shows; r uuid;
begin
  perform pg_temp.as_anon();
  if pg_temp.holds_tvid(992100) then raise exception 'lock already held before the call'; end if;
  perform pg_temp.new_show(992100, 'ZZ Lock Create');
  if not pg_temp.holds_tvid(992100) then raise exception 'library_create_show did not take the identity lock'; end if;
  u := pg_temp.new_show(null, 'ZZ Lock Loose');
  r := (select id from public.watchlist_items where show_id = u.id);
  if pg_temp.holds_tvid(992101) then raise exception 'lock held before the Match'; end if;
  perform public.library_match_season(r, '{"tmdb_id": 992101}'::jsonb, pg_temp.season_patch('ZZ Lock Match', 992101, 1));
  if not pg_temp.holds_tvid(992101) then raise exception 'library_match_season did not take the identity lock'; end if;
end $$ $b$);
select pg_temp.t('C3 create first (serial): a singleton unmatched show''s sole season, matched to the created identity, joins the created show (no rename onto it, no second show); the emptied show is removed', $b$ do $$
declare t public.tv_shows; u public.tv_shows; r uuid; v jsonb;
begin
  perform pg_temp.as_anon();
  t := pg_temp.new_show(992102, 'ZZ C3 Target');
  u := pg_temp.new_show(null, 'ZZ C3 Single');
  r := (select id from public.watchlist_items where show_id = u.id);
  v := public.library_match_season(r, '{"tmdb_id": 992102}'::jsonb, pg_temp.season_patch('ZZ C3 Target', 992102, 2));
  if (v ->> 'blocked')::boolean or (v ->> 'show_id')::uuid <> t.id or (select show_id from public.watchlist_items where id = r) <> t.id then raise exception 'not joined: %', v; end if;
  if (select count(*) from public.tv_shows where tmdb_id = 992102) <> 1 or exists (select 1 from public.tv_shows where id = u.id) then raise exception 'shows'; end if;
end $$ $b$);
select pg_temp.t('C3 Match first (serial): singleton promotion takes the identity; the later creation is show_exists and changes nothing', $b$ do $$
declare u public.tv_shows; r uuid; v jsonb; c text;
begin
  perform pg_temp.as_anon();
  u := pg_temp.new_show(null, 'ZZ C3b Single');
  r := (select id from public.watchlist_items where show_id = u.id);
  v := public.library_match_season(r, '{"tmdb_id": 992103}'::jsonb, pg_temp.season_patch('ZZ C3b Target', 992103, 2));
  if (v ->> 'show_id')::uuid <> u.id or (select tmdb_id from public.tv_shows where id = u.id) <> 992103 then raise exception 'not promoted: %', v; end if;
  c := pg_temp.content();
  perform pg_temp.refused($q$select pg_temp.new_show(992103, 'ZZ C3b Target')$q$, 'show_exists');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);
select pg_temp.t('new-target insertion: a season of a multi-season unmatched show matched to an absent identity creates that show (Match first); a later creation is show_exists; with the creation first it joins instead', $b$ do $$
declare u public.tv_shows; r uuid; v jsonb; t public.tv_shows;
begin
  perform pg_temp.as_anon();
  u := pg_temp.new_show(null, 'ZZ Multi');
  perform public.library_add_seasons(u.id, pg_temp.expected(u), jsonb_build_array(pg_temp.by_label('zz multi', 'ZZ Multi', 'Season 2', '2021-01-01')));
  r := (select id from public.watchlist_items where show_id = u.id and season = 'Season 1');
  v := public.library_match_season(r, '{"tmdb_id": 992104}'::jsonb, pg_temp.season_patch('ZZ Multi Target', 992104, 1));
  if (v ->> 'show_id')::uuid = u.id or (select tmdb_id from public.tv_shows where id = (v ->> 'show_id')::uuid) <> 992104 then raise exception 'no new target: %', v; end if;
  perform pg_temp.refused($q$select pg_temp.new_show(992104, 'ZZ Multi Target')$q$, 'show_exists');
  t := pg_temp.new_show(992105, 'ZZ Multi Two');
  r := (select id from public.watchlist_items where show_id = u.id and season = 'Season 2');
  v := public.library_match_season(r, '{"tmdb_id": 992105}'::jsonb, pg_temp.season_patch('ZZ Multi Two', 992105, 2));
  if (v ->> 'show_id')::uuid <> t.id or (select count(*) from public.tv_shows where tmdb_id = 992105) <> 1 then raise exception 'not joined: %', v; end if;
end $$ $b$);
select pg_temp.t('Match × Match of one absent identity (serial): the second joins the first''s show (different seasons); the same season is match_conflict with the row untouched', $b$ do $$
declare a public.tv_shows; b public.tv_shows; c3 public.tv_shows; ra uuid; rb uuid; rc uuid; v jsonb; c text;
begin
  perform pg_temp.as_anon();
  a := pg_temp.new_show(null, 'ZZ MM A'); b := pg_temp.new_show(null, 'ZZ MM B'); c3 := pg_temp.new_show(null, 'ZZ MM C');
  ra := (select id from public.watchlist_items where show_id = a.id);
  rb := (select id from public.watchlist_items where show_id = b.id);
  rc := (select id from public.watchlist_items where show_id = c3.id);
  v := public.library_match_season(ra, '{"tmdb_id": 992106}'::jsonb, pg_temp.season_patch('ZZ MM Target', 992106, 1));
  v := public.library_match_season(rb, '{"tmdb_id": 992106}'::jsonb, pg_temp.season_patch('ZZ MM Target', 992106, 2));
  if (select count(*) from public.tv_shows where tmdb_id = 992106) <> 1 or (select show_id from public.watchlist_items where id = rb) <> (select show_id from public.watchlist_items where id = ra) then raise exception 'not one show: %', v; end if;
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_match_season(%L, ''{"tmdb_id": 992106}''::jsonb, %L::jsonb)', rc, pg_temp.season_patch('ZZ MM Target', 992106, 1)), 'match_conflict');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);
select pg_temp.t('C3 genuine season conflict: the created show already holds the season → match_conflict; atomic: nothing of the Match is written (the singleton show keeps its row and has no identity)', $b$ do $$
declare u public.tv_shows; r uuid; c text;
begin
  perform pg_temp.as_anon();
  perform pg_temp.new_show(992107, 'ZZ Conflict Target');
  u := pg_temp.new_show(null, 'ZZ Conflict Single');
  r := (select id from public.watchlist_items where show_id = u.id);
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_match_season(%L, ''{"tmdb_id": 992107}''::jsonb, %L::jsonb)', r, pg_temp.season_patch('ZZ Conflict Target', 992107, 1)), 'match_conflict');
  if pg_temp.content() <> c or (select tmdb_id from public.tv_shows where id = u.id) is not null then raise exception 'changed'; end if;
end $$ $b$);

select json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq)::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from _t;
