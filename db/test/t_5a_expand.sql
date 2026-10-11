-- Checks for Stage 5a, the expansion (prepend db/test/_prelude.sql). Run as postgres
-- after db/phase5a_expand.sql at stage final with Stages 3b-2, 4a and 4b installed, on
-- a replica. Every check works on synthetic ZZ records inside its own rolled-back
-- subtransaction and calls the database as anon, the way the app does. These are
-- single-session checks: "in between" is a change made before the call in the same
-- session, so they show each serial order of two operations, not how two sessions
-- interleave (lock waits, timeouts), which needs two real connections (G2).

create or replace function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true);
$$;
create or replace function pg_temp.as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true);
$$;
create or replace function pg_temp.content() returns text language sql as $$
  select concat_ws('/',
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.personal_collections t))
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
-- A new show as the app creates one (library_create_show), identified or not.
create or replace function pg_temp.new_show(p_tmdb int, p_title text, p_distinct jsonb default '[]') returns public.tv_shows language plpgsql as $$
declare v jsonb; s public.tv_shows;
begin
  v := public.library_create_show(jsonb_build_object('tmdb_id', p_tmdb, 'title', p_title, 'show_key', lower(p_title), 'network', 'ZZ Net', 'distinct_from', p_distinct),
    jsonb_build_array(case when p_tmdb is null then pg_temp.by_label(lower(p_title), p_title, 'Season 1', '2020-01-01')
                           else pg_temp.by_number(lower(p_title), p_title, 1, '2020-01-01') end));
  select * into s from public.tv_shows where id = (v ->> 'show_id')::uuid;
  return s;
end $$;
-- A show stored with a given storage, as an old (Stage 4b) page still can during coexistence.
create or replace function pg_temp.stored_show(p_coll text, p_title text) returns public.tv_shows language plpgsql as $$
declare v jsonb; s public.tv_shows;
begin
  v := public.add_tv_seasons(p_coll, jsonb_build_object('title', p_title, 'show_key', lower(p_title)),
    jsonb_build_array(pg_temp.by_label(lower(p_title), p_title, 'Season 1', '2020-01-01')));
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
create or replace function pg_temp.n_shows() returns int language sql as $$ select count(*)::int from public.tv_shows $$;
-- A small synthetic Sheridan payload: one missing show (two seasons) and one missing film.
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

-- ── Function properties and the phase ──
select pg_temp.t('library_* and stage5_capabilities run as the caller with an empty search_path, executable by anon and authenticated, not by public', $b$ do $$
declare f record; fn regprocedure;
begin
  foreach fn in array array['public.stage5_capabilities()', 'public.library_add_seasons(uuid, jsonb, jsonb)', 'public.library_create_show(jsonb, jsonb)',
      'public.library_add_films(jsonb)', 'public.library_create_film(jsonb)', 'public.library_match_season(uuid, jsonb, jsonb, jsonb)',
      'public.library_match_film(uuid, jsonb, jsonb)', 'public.library_catalog_apply(text, jsonb, text)']::regprocedure[] loop
    select p.prosecdef, p.proconfig, p.proacl::text acl into f from pg_proc p where p.oid = fn;
    if f.prosecdef then raise exception '% security definer', fn; end if;
    if not ('search_path=""' = any(f.proconfig)) then raise exception '% search_path %', fn, f.proconfig; end if;
    if f.acl not like '%anon=X%' or f.acl not like '%authenticated=X%' or f.acl ~ '(^|[{,])=X' then raise exception '% acl %', fn, f.acl; end if;
  end loop;
  -- (The two pre-Stage-5 helpers private.current_owner_id and private.tv_stage are unchanged.)
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.prosecdef
             and (p.proname like 'library\_%' or p.proname like 'lib\_%' or p.proname like 'stage5\_%' or p.proname = 'catalog_run5')) then
    raise exception 'a Stage 5 function is SECURITY DEFINER';
  end if;
end $$ $b$);

select pg_temp.t('the phase: coexistence, backup format 3, no recovery archive', $b$ do $$
declare c jsonb;
begin
  perform pg_temp.as_anon();
  c := public.stage5_capabilities();
  if c <> '{"stage5": 1, "phase": "coexistence", "backup_format": 3, "recovery_archive": "none"}'::jsonb then raise exception '%', c; end if;
end $$ $b$);

select pg_temp.t('the read views derive governance and theme meaning from storage exactly, run as the caller, and each has an id', $b$ do $$
begin
  perform pg_temp.as_anon();
  if (select count(*) from public.library_catalog_shows) <> (select count(*) from public.tv_shows where collection in ('disney', '90day', 'sheridan')) then raise exception 'shows'; end if;
  if exists (select 1 from public.library_catalog_shows l join public.tv_shows s on s.id = l.show_id where s.collection <> l.catalog or l.id <> l.show_id) then raise exception 'show catalog'; end if;
  if (select count(*) from public.library_catalog_films) <> (select count(*) from public.watchlist_items where is_film and collection in ('disney', '90day', 'sheridan')) then raise exception 'films'; end if;
  if exists (select 1 from public.library_film_theme_kinds k join public.watchlist_items w on w.id = k.item_id
             where k.theme_kind <> case when w.collection = 'movies' then 'genre' else 'other' end) then raise exception 'theme kinds'; end if;
  if (select count(*) from public.library_film_theme_kinds) <> (select count(*) from public.watchlist_items where is_film) then raise exception 'kinds count'; end if;
  if exists (select 1 from public.library_collection_catalogs l join public.personal_collections c on c.id = l.collection_id where c.legacy_source is distinct from l.catalog) then raise exception 'collections'; end if;
  perform pg_temp.as_admin();
  if exists (select 1 from pg_class where relname like 'library\_%' and relkind = 'v' and not coalesce(reloptions @> array['security_invoker=true'], false)) then raise exception 'not security_invoker'; end if;
end $$ $b$);

select pg_temp.t('library identity: one show per TMDB identity and one record per film / season identity, across storage (unique indexes)', $b$ do $$
declare s public.tv_shows;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_show(991001, 'ZZ Ident');
  perform pg_temp.as_admin();
  perform pg_temp.refused(format($q$ insert into public.tv_shows (user_id, collection, title, show_key, tmdb_id) values (%L, 'truecrime', 'ZZ Ident', 'zz ident', 991001) $q$, s.user_id), 'duplicate key');
  insert into public.watchlist_items (user_id, collection, item_key, title, season, date_sort, media_type, tmdb_id)
    values (s.user_id, 'movies', 'zz idfilm|film', 'ZZ IdFilm', 'Film', '2020-01-01', 'movie', 991002);
  perform pg_temp.refused(format($q$ insert into public.watchlist_items (user_id, collection, item_key, title, season, date_sort, media_type, tmdb_id)
    values (%L, 'truecrime', 'zz idfilm|film', 'ZZ IdFilm', 'Film', '2020-01-01', 'movie', 991002) $q$, s.user_id), 'duplicate key');
end $$ $b$);

-- ── library_create_show ──
select pg_temp.t('library_create_show: a new TMDB show is created where new shows go, governed by no catalog; a repeat (its identity now on the list) is show_exists', $b$ do $$
declare s public.tv_shows; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_show(991010, 'ZZ New');
  if s.collection <> 'othertv' or s.tmdb_id <> 991010 or private.lib_show_catalog(s.id) is not null then raise exception '%', to_jsonb(s); end if;
  if (select count(*) from public.watchlist_items where show_id = s.id and season_number = 1 and tmdb_id = 991010) <> 1 then raise exception 'season'; end if;
  c := pg_temp.content();
  perform pg_temp.refused($q$ select pg_temp.new_show(991010, 'ZZ New') $q$, 'show_exists');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('library_create_show (no identity): a same-key unmatched show the page didn''t list refuses it; listed in distinct_from, a separate show is created where storage allows it', $b$ do $$
declare a public.tv_shows; b public.tv_shows; c text;
begin
  perform pg_temp.as_anon();
  a := pg_temp.stored_show('truecrime', 'ZZ Twin');
  c := pg_temp.content();
  perform pg_temp.refused($q$ select pg_temp.new_show(null, 'ZZ Twin') $q$, 'show_exists');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
  b := pg_temp.new_show(null, 'ZZ Twin', jsonb_build_array(a.id));
  if b.id = a.id or b.show_key <> a.show_key then raise exception 'not separate'; end if;
end $$ $b$);

select pg_temp.t('coexistence limitation: a same-key unmatched show already where new shows go stays one show even with distinct_from (refused, nothing written; allowed after contraction)', $b$ do $$
declare a public.tv_shows; c text;
begin
  perform pg_temp.as_anon();
  a := pg_temp.new_show(null, 'ZZ Single');
  c := pg_temp.content();
  perform pg_temp.refused(format($q$ select pg_temp.new_show(null, 'ZZ Single', %L::jsonb) $q$, jsonb_build_array(a.id)), 'show_exists');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

-- ── library_add_seasons ──
select pg_temp.t('library_add_seasons: an identified show no catalog governs takes TMDB seasons; a changed expectation (catalog, key, identity) is target_changed; a deleted show is target_missing; never a new show', $b$ do $$
declare s public.tv_shows; v jsonb; n int; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_show(991020, 'ZZ Add');
  n := pg_temp.n_shows();
  v := public.library_add_seasons(s.id, pg_temp.expected(s), jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01')));
  if (v ->> 'show_id')::uuid <> s.id or (v ->> 'show_created')::boolean or jsonb_array_length(v -> 'inserted') <> 1 then raise exception '%', v; end if;
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_add_seasons(%L, %L::jsonb, %L::jsonb)', s.id, pg_temp.expected(s) || '{"catalog":"disney"}', jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 3, '2022-01-01'))), 'target_changed');
  perform pg_temp.refused(format('select public.library_add_seasons(%L, %L::jsonb, %L::jsonb)', s.id, pg_temp.expected(s) || '{"show_key":"zz other"}', jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 3, '2022-01-01'))), 'target_changed');
  perform pg_temp.refused(format('select public.library_add_seasons(%L, %L::jsonb, %L::jsonb)', s.id, pg_temp.expected(s) || '{"tmdb_id":1}', jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 3, '2022-01-01'))), 'target_changed');
  perform pg_temp.refused(format('select public.library_add_seasons(%L, %L::jsonb, %L::jsonb)', s.id, pg_temp.expected(s), jsonb_build_array(pg_temp.by_label(s.show_key, s.title, 'Season 3', '2022-01-01'))), 'invalid_input');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
  perform public.delete_tv_season(id) from public.watchlist_items where show_id = s.id;
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_add_seasons(%L, %L::jsonb, %L::jsonb)', s.id, pg_temp.expected(s), jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 3, '2022-01-01'))), 'target_missing');
  if pg_temp.content() <> c or pg_temp.n_shows() <> n - 1 then raise exception 'recreated'; end if;
end $$ $b$);

select pg_temp.t('library_add_seasons: a show a catalog governs takes seasons by label and its expectation names the catalog', $b$ do $$
declare s public.tv_shows; v jsonb;
begin
  perform pg_temp.as_anon();
  s := pg_temp.stored_show('sheridan', 'ZZ Gov');
  if pg_temp.expected(s) ->> 'catalog' <> 'sheridan' then raise exception 'not governed'; end if;
  v := public.library_add_seasons(s.id, pg_temp.expected(s), jsonb_build_array(pg_temp.by_label(s.show_key, s.title, 'Season 2', '2021-01-01')));
  if jsonb_array_length(v -> 'inserted') <> 1 or (v -> 'inserted' -> 0 ->> 'show_id')::uuid <> s.id then raise exception '%', v; end if;
end $$ $b$);

-- ── Films ──
select pg_temp.t('library_add_films: inserted, then existing on a repeat (identity anywhere); the film''s theme is a genre', $b$ do $$
declare v jsonb; w jsonb; id uuid;
begin
  perform pg_temp.as_anon();
  v := public.library_add_films(jsonb_build_array(pg_temp.film('ZZ Film A', 991030)));
  if v -> 'results' -> 0 ->> 'outcome' <> 'inserted' then raise exception '%', v; end if;
  id := (v -> 'results' -> 0 ->> 'id')::uuid;
  if private.lib_film_theme_kind(id) <> 'genre' then raise exception 'kind'; end if;
  w := public.library_add_films(jsonb_build_array(pg_temp.film('ZZ Film A', 991030)));
  if w -> 'results' -> 0 ->> 'outcome' <> 'existing' or (w -> 'results' -> 0 ->> 'id')::uuid <> id then raise exception '%', w; end if;
end $$ $b$);

select pg_temp.t('library_create_film: a same-key unmatched film the page didn''t list refuses it (film_exists); listed, a separate film is created where storage allows it', $b$ do $$
declare a uuid; v jsonb; c text;
begin
  perform pg_temp.as_admin();
  insert into public.watchlist_items (user_id, collection, item_key, title, season, date_sort)
    values (private.current_owner_id(), 'truecrime', 'zz doc|film', 'ZZ Doc', 'Film', '2020-01-01') returning id into a;
  perform pg_temp.as_anon();
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_create_film(%L::jsonb)', pg_temp.film('ZZ Doc')), 'film_exists');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
  v := public.library_create_film(pg_temp.film('ZZ Doc') || jsonb_build_object('distinct_from', jsonb_build_array(a)));
  if (v ->> 'id')::uuid = a then raise exception 'not separate'; end if;
end $$ $b$);

-- ── Match ──
select pg_temp.t('library_match_season: a governed row is not_eligible; a TMDB show a catalog governs is match_target_governed (nothing changed); otherwise the row joins the identified show', $b$ do $$
declare g public.tv_shows; u public.tv_shows; t public.tv_shows; r uuid; c text; v jsonb;
begin
  perform pg_temp.as_anon();
  g := pg_temp.stored_show('sheridan', 'ZZ Governed');
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_match_season(%L, ''{"tmdb_id": 991040}''::jsonb, %L::jsonb)',
    (select id from public.watchlist_items where show_id = g.id), pg_temp.by_number('zz governed', 'ZZ Governed', 1, '2020-01-01') || '{"media_type":"tv","tmdb_id":991040}'), 'not_eligible');
  perform pg_temp.as_admin();
  update public.tv_shows set tmdb_id = 991041 where id = g.id;     -- the governed show gets an identity (as enrichment does)
  perform pg_temp.as_anon();
  u := pg_temp.stored_show('othertv', 'ZZ Loose');
  r := (select id from public.watchlist_items where show_id = u.id);
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_match_season(%L, ''{"tmdb_id": 991041}''::jsonb, %L::jsonb)',
    r, pg_temp.by_number('zz governed', 'ZZ Governed', 7, '2027-01-01') || '{"media_type":"tv","tmdb_id":991041}'), 'match_target_governed');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
  t := pg_temp.new_show(991042, 'ZZ Target');
  v := public.library_match_season(r, '{"tmdb_id": 991042}'::jsonb, pg_temp.by_number('zz target', 'ZZ Target', 4, '2024-01-01') || '{"media_type":"tv","tmdb_id":991042}');
  if (select show_id from public.watchlist_items where id = r) <> t.id then raise exception '%', v; end if;
end $$ $b$);

select pg_temp.t('library_match_film: one transaction — a season becomes the film, keeps its show''s collections, and the emptied show is removed; a changed row or a taken identity is match_conflict', $b$ do $$
declare s public.tv_shows; r uuid; pc uuid; v jsonb; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.stored_show('othertv', 'ZZ Was Show');
  r := (select id from public.watchlist_items where show_id = s.id);
  perform pg_temp.as_admin();
  insert into public.personal_collections (user_id, name, sort_order) values (s.user_id, 'ZZ Coll', 999) returning id into pc;
  insert into public.collection_memberships (user_id, collection_id, show_id) values (s.user_id, pc, s.id);
  perform pg_temp.as_anon();
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_match_film(%L, ''{"show_id": null}''::jsonb, %L::jsonb)', r, pg_temp.film_patch('ZZ Became Film', 991050)), 'match_conflict');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
  v := public.library_match_film(r, jsonb_build_object('show_id', s.id), pg_temp.film_patch('ZZ Became Film', 991050));
  if not (v ->> 'former_show_deleted')::boolean or exists (select 1 from public.tv_shows where id = s.id) then raise exception '%', v; end if;
  if not exists (select 1 from public.collection_memberships where item_id = r and collection_id = pc) then raise exception 'collection not kept'; end if;
  if (select tmdb_id from public.watchlist_items where id = r) <> 991050 then raise exception 'identity'; end if;
  perform public.library_add_films(jsonb_build_array(pg_temp.film('ZZ Taken', 991051)));
  s := pg_temp.stored_show('othertv', 'ZZ Other Was');
  r := (select id from public.watchlist_items where show_id = s.id);
  perform pg_temp.refused(format('select public.library_match_film(%L, %L::jsonb, %L::jsonb)', r, jsonb_build_object('show_id', s.id), pg_temp.film_patch('ZZ Taken', 991051)), 'match_conflict');
end $$ $b$);

select pg_temp.t('a film stored with the films (a genre theme) can''t be matched to a TV season (genre_film_season, as before Stage 5 and after contraction), nothing changed', $b$ do $$
declare r uuid; c text;
begin
  perform pg_temp.as_admin();
  insert into public.watchlist_items (user_id, collection, item_key, title, season, date_sort)
    values (private.current_owner_id(), 'movies', 'zz movie|film', 'ZZ Movie', 'Film', '2020-01-01') returning id into r;
  perform pg_temp.as_anon();
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_match_season(%L, ''{"tmdb_id": 991060}''::jsonb, %L::jsonb)', r,
    pg_temp.by_number('zz movie', 'ZZ Movie', 1, '2020-01-01') || '{"media_type":"tv","tmdb_id":991060}'), 'genre_film_season');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

-- ── Match × creation of the same TMDB identity (the G2 C3 stop, 2026-10-10) ──
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
  if pg_temp.holds_tvid(991100) then raise exception 'lock already held before the call'; end if;
  perform pg_temp.new_show(991100, 'ZZ Lock Create');
  if not pg_temp.holds_tvid(991100) then raise exception 'library_create_show did not take the identity lock'; end if;
  u := pg_temp.new_show(null, 'ZZ Lock Loose');
  r := (select id from public.watchlist_items where show_id = u.id);
  if pg_temp.holds_tvid(991101) then raise exception 'lock held before the Match'; end if;
  perform public.library_match_season(r, '{"tmdb_id": 991101}'::jsonb, pg_temp.season_patch('ZZ Lock Match', 991101, 1));
  if not pg_temp.holds_tvid(991101) then raise exception 'library_match_season did not take the identity lock'; end if;
end $$ $b$);
select pg_temp.t('C3 create first (serial): a singleton unmatched show''s sole season, matched to the created identity, joins the created show (no rename onto it, no second show); the emptied show is removed', $b$ do $$
declare t public.tv_shows; u public.tv_shows; r uuid; v jsonb;
begin
  perform pg_temp.as_anon();
  t := pg_temp.new_show(991102, 'ZZ C3 Target');
  u := pg_temp.new_show(null, 'ZZ C3 Single');
  r := (select id from public.watchlist_items where show_id = u.id);
  v := public.library_match_season(r, '{"tmdb_id": 991102}'::jsonb, pg_temp.season_patch('ZZ C3 Target', 991102, 2));
  if (v ->> 'blocked')::boolean or (v ->> 'show_id')::uuid <> t.id or (select show_id from public.watchlist_items where id = r) <> t.id then raise exception 'not joined: %', v; end if;
  if (select count(*) from public.tv_shows where tmdb_id = 991102) <> 1 or exists (select 1 from public.tv_shows where id = u.id) then raise exception 'shows'; end if;
end $$ $b$);
select pg_temp.t('C3 Match first (serial): singleton promotion takes the identity; the later creation is show_exists and changes nothing', $b$ do $$
declare u public.tv_shows; r uuid; v jsonb; c text;
begin
  perform pg_temp.as_anon();
  u := pg_temp.new_show(null, 'ZZ C3b Single');
  r := (select id from public.watchlist_items where show_id = u.id);
  v := public.library_match_season(r, '{"tmdb_id": 991103}'::jsonb, pg_temp.season_patch('ZZ C3b Target', 991103, 2));
  if (v ->> 'show_id')::uuid <> u.id or (select tmdb_id from public.tv_shows where id = u.id) <> 991103 then raise exception 'not promoted: %', v; end if;
  c := pg_temp.content();
  perform pg_temp.refused($q$select pg_temp.new_show(991103, 'ZZ C3b Target')$q$, 'show_exists');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);
select pg_temp.t('new-target insertion: a season of a multi-season unmatched show matched to an absent identity creates that show (Match first); a later creation is show_exists; with the creation first it joins instead', $b$ do $$
declare u public.tv_shows; r uuid; v jsonb; t public.tv_shows;
begin
  perform pg_temp.as_anon();
  u := pg_temp.new_show(null, 'ZZ Multi');
  perform public.library_add_seasons(u.id, pg_temp.expected(u), jsonb_build_array(pg_temp.by_label('zz multi', 'ZZ Multi', 'Season 2', '2021-01-01')));
  r := (select id from public.watchlist_items where show_id = u.id and season = 'Season 1');
  v := public.library_match_season(r, '{"tmdb_id": 991104}'::jsonb, pg_temp.season_patch('ZZ Multi Target', 991104, 1));
  if (v ->> 'show_id')::uuid = u.id or (select tmdb_id from public.tv_shows where id = (v ->> 'show_id')::uuid) <> 991104 then raise exception 'no new target: %', v; end if;
  perform pg_temp.refused($q$select pg_temp.new_show(991104, 'ZZ Multi Target')$q$, 'show_exists');
  t := pg_temp.new_show(991105, 'ZZ Multi Two');
  r := (select id from public.watchlist_items where show_id = u.id and season = 'Season 2');
  v := public.library_match_season(r, '{"tmdb_id": 991105}'::jsonb, pg_temp.season_patch('ZZ Multi Two', 991105, 2));
  if (v ->> 'show_id')::uuid <> t.id or (select count(*) from public.tv_shows where tmdb_id = 991105) <> 1 then raise exception 'not joined: %', v; end if;
end $$ $b$);
select pg_temp.t('Match × Match of one absent identity (serial): the second joins the first''s show (different seasons); the same season is match_conflict with the row untouched', $b$ do $$
declare a public.tv_shows; b public.tv_shows; c3 public.tv_shows; ra uuid; rb uuid; rc uuid; v jsonb; c text;
begin
  perform pg_temp.as_anon();
  a := pg_temp.new_show(null, 'ZZ MM A'); b := pg_temp.new_show(null, 'ZZ MM B'); c3 := pg_temp.new_show(null, 'ZZ MM C');
  ra := (select id from public.watchlist_items where show_id = a.id);
  rb := (select id from public.watchlist_items where show_id = b.id);
  rc := (select id from public.watchlist_items where show_id = c3.id);
  v := public.library_match_season(ra, '{"tmdb_id": 991106}'::jsonb, pg_temp.season_patch('ZZ MM Target', 991106, 1));
  v := public.library_match_season(rb, '{"tmdb_id": 991106}'::jsonb, pg_temp.season_patch('ZZ MM Target', 991106, 2));
  if (select count(*) from public.tv_shows where tmdb_id = 991106) <> 1 or (select show_id from public.watchlist_items where id = rb) <> (select show_id from public.watchlist_items where id = ra) then raise exception 'not one show: %', v; end if;
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_match_season(%L, ''{"tmdb_id": 991106}''::jsonb, %L::jsonb)', rc, pg_temp.season_patch('ZZ MM Target', 991106, 1)), 'match_conflict');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);
select pg_temp.t('C3 genuine season conflict: the created show already holds the season → match_conflict; atomic: nothing of the Match is written (the singleton show keeps its row and has no identity)', $b$ do $$
declare u public.tv_shows; r uuid; c text;
begin
  perform pg_temp.as_anon();
  perform pg_temp.new_show(991107, 'ZZ Conflict Target');
  u := pg_temp.new_show(null, 'ZZ Conflict Single');
  r := (select id from public.watchlist_items where show_id = u.id);
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_match_season(%L, ''{"tmdb_id": 991107}''::jsonb, %L::jsonb)', r, pg_temp.season_patch('ZZ Conflict Target', 991107, 1)), 'match_conflict');
  if pg_temp.content() <> c or (select tmdb_id from public.tv_shows where id = u.id) is not null then raise exception 'changed'; end if;
end $$ $b$);

-- ── Catalog updates ──
select pg_temp.t('the Stage 4a catalog_apply still previews, but its apply step is refused (client_outdated) from 5a on; nothing written', $b$ do $$
declare c text; p jsonb;
begin
  perform pg_temp.as_anon();
  c := pg_temp.content();
  p := public.catalog_apply('sheridan', pg_temp.defaults());
  if p ->> 'hash' is null then raise exception 'no preview %', p; end if;
  perform pg_temp.refused(format('select public.catalog_apply(''sheridan'', %L::jsonb, %L)', pg_temp.defaults(), p ->> 'hash'), 'client_outdated');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('library_catalog_apply: missing entries are created in the catalog and join its collection explicitly; a repeat changes nothing', $b$ do $$
declare v jsonb; s uuid; pc uuid;
begin
  perform pg_temp.as_anon();
  v := pg_temp.apply(pg_temp.defaults());
  if v ->> 'mode' <> 'applied' then raise exception '%', v; end if;
  s := (select id from public.tv_shows where show_key = 'zz cat show');
  if private.lib_show_catalog(s) <> 'sheridan' or (select count(*) from public.watchlist_items where show_id = s) <> 2 then raise exception 'show'; end if;
  if private.lib_film_catalog((select id from public.watchlist_items where item_key = 'zz cat film|film')) <> 'sheridan' then raise exception 'film'; end if;
  pc := (select id from public.personal_collections where legacy_source = 'sheridan');
  if pc is not null and not exists (select 1 from public.collection_memberships where collection_id = pc and show_id = s) then raise exception 'membership'; end if;
  v := pg_temp.apply(pg_temp.defaults());
  if exists (select 1 from jsonb_array_elements(v -> 'document' -> 'entries') e where e ->> 'kind' in ('create_show', 'insert_season', 'insert_film')) then raise exception 'repeat %', v; end if;
end $$ $b$);

select pg_temp.t('catalog collision (U7): an unmatched show or film elsewhere with the catalog entry''s key or title is a candidate — the entry is excluded (existing_record, candidate listed), never adopted or duplicated; two candidates are ambiguous', $b$ do $$
declare a public.tv_shows; b public.tv_shows; f uuid; v jsonb; x jsonb;
begin
  perform pg_temp.as_anon();
  a := pg_temp.stored_show('othertv', 'ZZ Cat Show');                -- same key as the catalog show
  perform pg_temp.as_admin();
  insert into public.watchlist_items (user_id, collection, item_key, title, season, date_sort)
    values (private.current_owner_id(), 'movies', 'zz cat film|film', 'ZZ Cat Film', 'Film', '2020-01-01') returning id into f;
  perform pg_temp.as_anon();
  x := pg_temp.excluded(pg_temp.preview(pg_temp.defaults()));
  if jsonb_array_length(x) <> 3 or exists (select 1 from jsonb_array_elements(x) e where e ->> 'reason' <> 'existing_record') then raise exception '%', x; end if;
  if not exists (select 1 from jsonb_array_elements(x) e where e -> 'candidates' ? a.id::text) or not exists (select 1 from jsonb_array_elements(x) e where e -> 'candidates' ? f::text) then raise exception 'candidates %', x; end if;
  v := pg_temp.apply(pg_temp.defaults());
  if (select count(*) from public.tv_shows where show_key = 'zz cat show') <> 1 or (select count(*) from public.watchlist_items where item_key = 'zz cat film|film') <> 1 then raise exception 'duplicated'; end if;
  if private.lib_show_catalog(a.id) is not null or private.lib_film_catalog(f) is not null then raise exception 'adopted'; end if;
  b := pg_temp.stored_show('truecrime', 'ZZ Cat Show');               -- a second candidate
  x := pg_temp.excluded(pg_temp.preview(pg_temp.defaults()));
  if not exists (select 1 from jsonb_array_elements(x) e where e ->> 'reason' = 'ambiguous' and jsonb_array_length(e -> 'candidates') = 2) then raise exception 'ambiguous %', x; end if;
end $$ $b$);

-- ── Catalog concurrency: serialization with library writes ──
select pg_temp.t('every library write first takes tv_shows and watchlist_items in ROW EXCLUSIVE mode (conflicts with the catalog''s EXCLUSIVE locks), before any read', $b$ do $$
declare fn text; src text;
begin
  src := (select prosrc from pg_proc where oid = 'private.lib_write_on()'::regprocedure);
  if src not like '%lock table public.tv_shows, public.watchlist_items in row exclusive mode%' then raise exception 'lib_write_on %', src; end if;
  foreach fn in array array['public.library_add_seasons(uuid, jsonb, jsonb)', 'public.library_create_show(jsonb, jsonb)', 'public.library_add_films(jsonb)',
      'public.library_create_film(jsonb)', 'public.library_match_season(uuid, jsonb, jsonb, jsonb)', 'public.library_match_film(uuid, jsonb, jsonb)'] loop
    src := (select prosrc from pg_proc where oid = fn::regprocedure);
    if position('lib_write_on()' in src) = 0 then raise exception '% has no lib_write_on', fn; end if;
    -- (Declarations name the row types; what matters is that no statement reads or writes first.)
    if position('from public.' in src) between 1 and position('lib_write_on()' in src)
       or position('update public.' in src) between 1 and position('lib_write_on()' in src)
       or position('insert into public.' in src) between 1 and position('lib_write_on()' in src)
       or position('private.lib_match_row' in src) between 1 and position('lib_write_on()' in src) then
      raise exception '% reads a library table before taking the locks', fn;
    end if;
  end loop;
  perform pg_temp.as_anon();
  perform pg_temp.new_show(991070, 'ZZ Locks');
  if (select count(*) from pg_locks l where l.pid = pg_backend_pid() and l.mode = 'RowExclusiveLock'
      and l.relation in ('public.tv_shows'::regclass, 'public.watchlist_items'::regclass)) <> 2 then raise exception 'locks not held'; end if;
end $$ $b$);

select pg_temp.t('serial order 1 — a creation, then the catalog: the catalog sees the new unmatched show and film as candidates (excluded), never a twin', $b$ do $$
declare x jsonb;
begin
  perform pg_temp.as_anon();
  perform pg_temp.new_show(null, 'ZZ Cat Show');
  perform public.library_create_film(pg_temp.film('ZZ Cat Film'));
  perform pg_temp.apply(pg_temp.defaults());
  if (select count(*) from public.tv_shows where show_key = 'zz cat show') <> 1 or (select count(*) from public.watchlist_items where item_key = 'zz cat film|film') <> 1 then raise exception 'twin'; end if;
  x := pg_temp.excluded(pg_temp.preview(pg_temp.defaults()));
  if jsonb_array_length(x) <> 3 then raise exception '%', x; end if;
end $$ $b$);

select pg_temp.t('serial order 2 — the catalog, then a creation the page prepared before it: refused (show_exists / film_exists), never a twin; Match into the catalog''s show is refused', $b$ do $$
declare c text; u public.tv_shows;
begin
  perform pg_temp.as_anon();
  u := pg_temp.stored_show('othertv', 'ZZ Unrelated');
  perform pg_temp.apply(pg_temp.defaults());
  c := pg_temp.content();
  perform pg_temp.refused($q$ select pg_temp.new_show(null, 'ZZ Cat Show') $q$, 'show_exists');
  perform pg_temp.refused(format('select public.library_create_film(%L::jsonb)', pg_temp.film('ZZ Cat Film')), 'film_exists');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);


-- ── Presentation ──
select pg_temp.t('library_collection_presentation: every original collection (True Crime / Docs included) by its legacy source, read as the caller; the catalogs equal library_collection_catalogs', $b$ do $$
begin
  perform pg_temp.as_anon();
  if (select count(*) from public.library_collection_presentation) <> (select count(*) from public.personal_collections where legacy_source is not null) then raise exception 'count'; end if;
  if exists (select 1 from public.library_collection_catalogs c left join public.library_collection_presentation p on p.collection_id = c.collection_id
             where p.presentation_key is distinct from c.catalog) then raise exception 'catalogs'; end if;
end $$ $b$);

-- ── The catalog collision rule from the other side (F2), during coexistence ──
select pg_temp.t('catalog first, then same-title creations under other keys: refused (catalog_candidate, nothing changed) for a show by hand, a TMDB show, a film by hand, a TMDB film (outcome) and a Match; acknowledged (distinct_from), created', $b$ do $$
declare cat_s uuid; cat_f uuid; c text; v jsonb; u public.tv_shows; r uuid;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply(pg_temp.defaults('ZZ Shared Title', 'ZZ Shared Film'));
  cat_s := (select id from public.tv_shows where show_key = 'zz shared title');
  cat_f := (select id from public.watchlist_items where item_key = 'zz shared film|film');
  u := pg_temp.new_show(null, 'ZZ Unmatched One');
  r := (select id from public.watchlist_items where show_id = u.id);
  c := pg_temp.content();
  perform pg_temp.refused($q$ select public.library_create_show('{"title":"ZZ Shared Title","show_key":"zz other key"}'::jsonb,
    '[{"item_key":"zz other key|season 1","title":"ZZ Shared Title","season":"Season 1","date_sort":"2020-01-01"}]'::jsonb) $q$, 'catalog_candidate');
  perform pg_temp.refused($q$ select public.library_create_show('{"tmdb_id":991080,"title":"ZZ Shared Title","show_key":"zz shared title tmdb"}'::jsonb,
    '[{"item_key":"zz shared title tmdb|season 1","title":"ZZ Shared Title","season":"Season 1","date_sort":"2020-01-01","season_number":1}]'::jsonb) $q$, 'catalog_candidate');
  perform pg_temp.refused($q$ select public.library_create_film('{"title":"ZZ Shared Film","item_key":"zz shared film (2)|film","season":"Film","date_sort":"2020-01-01"}'::jsonb) $q$, 'catalog_candidate');
  v := public.library_add_films('[{"tmdb_id":991081,"title":"ZZ Shared Film","item_key":"zz shared film|film","date_sort":"2020-01-01"}]'::jsonb);
  if v -> 'results' -> 0 ->> 'outcome' <> 'catalog_candidate' then raise exception '%', v; end if;
  perform pg_temp.refused(format('select public.library_match_season(%L, ''{"tmdb_id": 991082}''::jsonb, %L::jsonb)', r,
    pg_temp.by_number('zz shared title', 'ZZ Shared Title', 1, '2020-01-01') || '{"media_type":"tv","tmdb_id":991082}'), 'catalog_candidate');
  if pg_temp.content() <> c then raise exception 'a refusal changed something'; end if;
  perform public.library_create_show(jsonb_build_object('title', 'ZZ Shared Title', 'show_key', 'zz other key', 'distinct_from', jsonb_build_array(cat_s)),
    '[{"item_key":"zz other key|season 1","title":"ZZ Shared Title","season":"Season 1","date_sort":"2020-01-01"}]'::jsonb);
  perform public.library_create_film(jsonb_build_object('title', 'ZZ Shared Film', 'item_key', 'zz shared film (2)|film', 'season', 'Film', 'date_sort', '2020-01-01', 'distinct_from', jsonb_build_array(cat_f)));
  if (select count(*) from public.tv_shows where title = 'ZZ Shared Title') <> 2 or (select count(*) from public.watchlist_items where title = 'ZZ Shared Film') <> 2 then raise exception 'distinct works not kept'; end if;
end $$ $b$);

select pg_temp.t('creation first under another key, then the catalog: the same-title record is a candidate (excluded with its id); no twin either way', $b$ do $$
declare a public.tv_shows; x jsonb;
begin
  perform pg_temp.as_anon();
  a := pg_temp.new_show(null, 'ZZ Second Title');
  perform public.library_create_show('{"title":"ZZ Second Title","show_key":"zz second other key","distinct_from":[]}'::jsonb,
    '[{"item_key":"zz second other key|season 1","title":"ZZ Second Title","season":"Season 1","date_sort":"2020-01-01"}]'::jsonb);
  x := pg_temp.excluded(pg_temp.preview(pg_temp.defaults('ZZ Second Title', 'ZZ Unused Film')));
  if not exists (select 1 from jsonb_array_elements(x) e where e ->> 'reason' = 'ambiguous') then raise exception '%', x; end if;
end $$ $b$);

select json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq)::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from _t;
