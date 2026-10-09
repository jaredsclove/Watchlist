-- Checks for Stage 4b (prepend db/test/_prelude.sql). Run as postgres after
-- db/phase4b_add_to_show.sql at stage final with Stage 4a installed, on a replica.
-- Every check works on synthetic ZZ shows inside its own rolled-back
-- subtransaction and calls the database as anon, the way the app does. These are
-- single-session checks: a change "in between" is made before the call, in the
-- same session. They show what the function does in each state; they don't show
-- how two sessions interleave (lock waits, timeouts), which needs two real connections.

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
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t))
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
-- A season as the app sends it: by label (legacy key) or a TMDB season (number).
create or replace function pg_temp.by_label(p_key text, p_title text, p_label text, p_ds text) returns jsonb language sql as $$
  select jsonb_build_object('item_key', p_key || '|' || lower(p_label), 'title', p_title, 'season', p_label, 'theme', 'ZZ Net',
    'display_date', 'ZZ ' || p_ds, 'date_sort', p_ds)
$$;
create or replace function pg_temp.by_number(p_key text, p_title text, p_num int, p_ds text) returns jsonb language sql as $$
  select jsonb_build_object('item_key', p_key || '|' || case when p_num = 0 then 'specials' else 'season ' || p_num end, 'title', p_title,
    'season', case when p_num = 0 then 'Specials' else 'Season ' || p_num end, 'theme', 'ZZ Net', 'display_date', 'ZZ ' || p_ds,
    'date_sort', p_ds, 'season_number', p_num)
$$;
-- New shows through the existing create path (as the app does for a new show).
create or replace function pg_temp.new_identified(p_coll text, p_tmdb int, p_title text) returns public.tv_shows language plpgsql as $$
declare v jsonb; s public.tv_shows;
begin
  v := public.add_tv_seasons(p_coll, jsonb_build_object('tmdb_id', p_tmdb, 'title', p_title, 'show_key', lower(p_title)),
    jsonb_build_array(pg_temp.by_number(lower(p_title), p_title, 1, '2020-01-01')));
  select * into s from public.tv_shows where id = (v ->> 'show_id')::uuid;
  return s;
end $$;
create or replace function pg_temp.new_legacy(p_coll text, p_title text) returns public.tv_shows language plpgsql as $$
declare v jsonb; s public.tv_shows;
begin
  v := public.add_tv_seasons(p_coll, jsonb_build_object('title', p_title, 'show_key', lower(p_title)),
    jsonb_build_array(pg_temp.by_label(lower(p_title), p_title, 'Season 1', '2020-01-01')));
  select * into s from public.tv_shows where id = (v ->> 'show_id')::uuid;
  return s;
end $$;
-- A legacy built-in show enriched the way db/admin/tv_enrich.sql does (identity columns only).
create or replace function pg_temp.new_enriched(p_coll text, p_tmdb int, p_title text) returns public.tv_shows language plpgsql as $$
declare s public.tv_shows;
begin
  s := pg_temp.new_legacy(p_coll, p_title);
  perform pg_temp.as_admin();
  update public.tv_shows set tmdb_id = p_tmdb where id = s.id;
  update public.watchlist_items set media_type = 'tv', tmdb_id = p_tmdb, season_number = 1 where show_id = s.id;
  perform pg_temp.as_anon();
  select * into s from public.tv_shows where id = s.id;
  return s;
end $$;
create or replace function pg_temp.expected(s public.tv_shows) returns jsonb language sql as $$
  select jsonb_build_object('collection', s.collection, 'tmdb_id', s.tmdb_id, 'show_key', s.show_key, 'network', 'ZZ Net')
$$;
create or replace function pg_temp.add(s public.tv_shows, p_seasons jsonb) returns jsonb language sql as $$
  select public.add_tv_seasons_to_show(s.id, pg_temp.expected(s), p_seasons)
$$;
create or replace function pg_temp.call_sql(s public.tv_shows, p_expected jsonb, p_seasons jsonb) returns text language sql as $$
  select format('select public.add_tv_seasons_to_show(%L::uuid, %L::jsonb, %L::jsonb)', s.id, p_expected, p_seasons)
$$;
create or replace function pg_temp.n_shows() returns int language sql as $$ select count(*)::int from public.tv_shows $$;
-- create_tv_show as the app sends it (a new TMDB show, or a show typed by hand).
create or replace function pg_temp.create_sql(p_tmdb int, p_title text, p_seasons jsonb) returns text language sql as $$
  select format('select public.create_tv_show(%L::jsonb, %L::jsonb)',
    jsonb_build_object('tmdb_id', p_tmdb, 'title', p_title, 'show_key', lower(p_title), 'network', 'ZZ Net'), p_seasons)
$$;
-- A show and its seasons as text, to show they are untouched.
create or replace function pg_temp.show_state(p_id uuid) returns text language sql as $$
  select (select (to_jsonb(s) - 'user_id')::text from public.tv_shows s where s.id = p_id) || '/' ||
    coalesce((select string_agg((to_jsonb(w) - 'user_id' - 'is_film')::text, '|' order by w.id) from public.watchlist_items w where w.show_id = p_id), '')
$$;

-- ── Function properties ──
select pg_temp.t('add_tv_seasons_to_show and create_tv_show run as the caller with an empty search_path, executable by anon and authenticated, not by public', $b$ do $$
declare f record; fn regprocedure;
begin
  foreach fn in array array['public.add_tv_seasons_to_show(uuid, jsonb, jsonb)'::regprocedure, 'public.create_tv_show(jsonb, jsonb)'::regprocedure] loop
    select p.prosecdef, p.proconfig, p.proacl::text acl into f from pg_proc p where p.oid = fn;
    if f.prosecdef then raise exception '% security definer', fn; end if;
    if not ('search_path=""' = any(f.proconfig)) then raise exception '% search_path %', fn, f.proconfig; end if;
    if f.acl not like '%anon=X%' or f.acl not like '%authenticated=X%' or f.acl ~ '(^|[{,])=X' then raise exception '% acl %', fn, f.acl; end if;
  end loop;
end $$ $b$);

select pg_temp.t('Stage 4a protections unchanged: seed_tv_defaults refuses and the date guard is installed', $b$ do $$
begin
  perform pg_temp.as_anon();
  perform pg_temp.refused($q$ select public.seed_tv_defaults('sheridan', '[{"k":"zz x|season 1","t":"ZZ X","s":"Season 1","d":"Jan 1, 2020","ds":"2020-01-01"}]'::jsonb) $q$,
                          'catalog_apply_required');
  if not exists (select 1 from pg_trigger where tgname = 'catalog_date_guard' and not tgisinternal) then raise exception 'date guard missing'; end if;
end $$ $b$);

-- ── The three kinds of target ──
select pg_temp.t('identified show outside the built-in catalogs: a TMDB season joins it with its identity; no show created; repeat is a no-op', $b$ do $$
declare s public.tv_shows; v jsonb; n int; r public.watchlist_items;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_identified('othertv', 990001, 'ZZ Dyn');
  n := pg_temp.n_shows();
  v := pg_temp.add(s, jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01')));
  if (v ->> 'show_id')::uuid <> s.id or (v ->> 'show_created')::boolean then raise exception 'parent %', v; end if;
  if jsonb_array_length(v -> 'inserted') <> 1 then raise exception 'inserted %', v; end if;
  select * into r from public.watchlist_items where id = (v -> 'inserted' -> 0 ->> 'id')::uuid;
  if r.show_id <> s.id or r.media_type <> 'tv' or r.tmdb_id <> 990001 or r.season_number <> 2 or r.collection <> 'othertv' then raise exception 'row %', to_jsonb(r); end if;
  if pg_temp.n_shows() <> n then raise exception 'show count changed'; end if;
  v := pg_temp.add(s, jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01')));
  if jsonb_array_length(v -> 'inserted') <> 0 or jsonb_array_length(v -> 'existing') <> 1 then raise exception 'repeat %', v; end if;
end $$ $b$);

select pg_temp.t('identified show outside the built-in catalogs refuses a season by label; nothing written', $b$ do $$
declare s public.tv_shows; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_identified('othertv', 990002, 'ZZ Dyn2');
  c := pg_temp.content();
  perform pg_temp.refused(pg_temp.call_sql(s, pg_temp.expected(s), jsonb_build_array(pg_temp.by_label(s.show_key, s.title, 'Season 2', '2021-01-01'))), 'invalid_input');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('enriched built-in show: "Season N" by label joins as TMDB season N (enriched-show guard ran); no show created', $b$ do $$
declare s public.tv_shows; v jsonb; n int; r public.watchlist_items;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_enriched('sheridan', 990003, 'ZZ Enr');
  n := pg_temp.n_shows();
  v := pg_temp.add(s, jsonb_build_array(pg_temp.by_label(s.show_key, s.title, 'Season 2', '2021-01-01')));
  if (v ->> 'show_id')::uuid <> s.id or (v ->> 'show_created')::boolean then raise exception 'parent %', v; end if;
  select * into r from public.watchlist_items where id = (v -> 'inserted' -> 0 ->> 'id')::uuid;
  if r.show_id <> s.id or r.tmdb_id <> 990003 or r.season_number <> 2 or r.media_type <> 'tv' then raise exception 'row %', to_jsonb(r); end if;
  if pg_temp.n_shows() <> n then raise exception 'show count changed'; end if;
end $$ $b$);

select pg_temp.t('enriched built-in show: a nonstandard label is held for review (enriched_show_label); nothing inserted', $b$ do $$
declare s public.tv_shows; v jsonb; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_enriched('sheridan', 990004, 'ZZ Enr2');
  c := pg_temp.content();
  v := pg_temp.add(s, jsonb_build_array(pg_temp.by_label(s.show_key, s.title, 'Season 2 (Part 1)', '2021-01-01')));
  if jsonb_array_length(v -> 'inserted') <> 0 or v -> 'rejected' -> 0 ->> 'reason' <> 'enriched_show_label' then raise exception 'result %', v; end if;
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('enriched built-in show refuses a TMDB season (season_number); nothing written', $b$ do $$
declare s public.tv_shows; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_enriched('sheridan', 990005, 'ZZ Enr3');
  c := pg_temp.content();
  perform pg_temp.refused(pg_temp.call_sql(s, pg_temp.expected(s), jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01'))), 'invalid_input');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('legacy show (built-in and dynamic storage): a season by label joins it; a TMDB season is refused', $b$ do $$
declare s public.tv_shows; v jsonb; coll text; c text;
begin
  perform pg_temp.as_anon();
  foreach coll in array array['sheridan', 'othertv'] loop
    s := pg_temp.new_legacy(coll, 'ZZ Leg ' || coll);
    v := pg_temp.add(s, jsonb_build_array(pg_temp.by_label(s.show_key, s.title, 'Season 2', '2021-01-01')));
    if (v ->> 'show_id')::uuid <> s.id or (v ->> 'show_created')::boolean or jsonb_array_length(v -> 'inserted') <> 1 then raise exception '% %', coll, v; end if;
    if (select tmdb_id from public.watchlist_items where id = (v -> 'inserted' -> 0 ->> 'id')::uuid) is not null then raise exception 'identity guessed'; end if;
    c := pg_temp.content();
    perform pg_temp.refused(pg_temp.call_sql(s, pg_temp.expected(s), jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 3, '2022-01-01'))), 'invalid_input');
    if pg_temp.content() <> c then raise exception 'changed'; end if;
  end loop;
end $$ $b$);

-- ── Changed or missing targets: refused, never recreated ──
select pg_temp.t('target deleted (its last season deleted): target_missing and no show recreated; the existing create path would recreate it', $b$ do $$
declare s public.tv_shows; c text; seasons jsonb; v jsonb;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_identified('othertv', 990006, 'ZZ Gone');
  perform public.delete_tv_season((select id from public.watchlist_items where show_id = s.id));
  if exists (select 1 from public.tv_shows where id = s.id) then raise exception 'show not deleted'; end if;
  seasons := jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01'));
  c := pg_temp.content();
  perform pg_temp.refused(pg_temp.call_sql(s, pg_temp.expected(s), seasons), 'target_missing');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
  -- For contrast (rolled back with this check): add_tv_seasons creates a new show for the same request.
  v := public.add_tv_seasons('othertv', jsonb_build_object('tmdb_id', 990006, 'title', s.title, 'show_key', s.show_key), seasons);
  if not (v ->> 'show_created')::boolean then raise exception 'expected the create path to recreate: %', v; end if;
end $$ $b$);

select pg_temp.t('legacy target deleted: target_missing; nothing written', $b$ do $$
declare s public.tv_shows; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_legacy('othertv', 'ZZ Gone Legacy');
  perform public.delete_tv_season((select id from public.watchlist_items where show_id = s.id));
  c := pg_temp.content();
  perform pg_temp.refused(pg_temp.call_sql(s, pg_temp.expected(s), jsonb_build_array(pg_temp.by_label(s.show_key, s.title, 'Season 2', '2021-01-01'))), 'target_missing');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('expected state differs (TMDB id, show key or collection): target_changed; nothing written', $b$ do $$
declare s public.tv_shows; c text; seasons jsonb;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_identified('othertv', 990007, 'ZZ Diff');
  seasons := jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01'));
  c := pg_temp.content();
  perform pg_temp.refused(pg_temp.call_sql(s, pg_temp.expected(s) || '{"tmdb_id": 990008}', seasons), 'target_changed');
  perform pg_temp.refused(pg_temp.call_sql(s, pg_temp.expected(s) || '{"tmdb_id": null}', seasons), 'target_changed');
  perform pg_temp.refused(pg_temp.call_sql(s, pg_temp.expected(s) || '{"show_key": "zz other"}', seasons), 'target_changed');
  perform pg_temp.refused(pg_temp.call_sql(s, pg_temp.expected(s) || '{"collection": "truecrime"}', seasons), 'target_changed');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('a Match in between changes the target (legacy show gains a TMDB identity or is replaced): refused; nothing written', $b$ do $$
declare s public.tv_shows; r public.watchlist_items; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_legacy('othertv', 'ZZ Matched');
  select * into r from public.watchlist_items where show_id = s.id;
  perform public.match_tv_row(r.id, '{"tmdb_id": 990009, "network": "ZZ Net"}'::jsonb,
    jsonb_build_object('title', 'ZZ Matched', 'season', 'Season 1', 'item_key', 'zz matched|season 1', 'media_type', 'tv', 'tmdb_id', 990009,
      'season_number', 1, 'theme', 'ZZ Net', 'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01'), '{}'::jsonb);
  c := pg_temp.content();
  perform pg_temp.refused(pg_temp.call_sql(s, pg_temp.expected(s), jsonb_build_array(pg_temp.by_label(s.show_key, s.title, 'Season 2', '2021-01-01'))), 'target_');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('seasons that add_tv_seasons would put on another show (an enriched show with the same key): target_changed and all of it rolled back', $b$ do $$
declare l public.tv_shows; e public.tv_shows; c text;
begin
  perform pg_temp.as_anon();
  -- a legacy show and an enriched show with the same key in one built-in collection (the show-key index is for legacy shows only)
  e := pg_temp.new_enriched('sheridan', 990010, 'ZZ Twin');
  perform pg_temp.as_admin();
  insert into public.tv_shows (user_id, collection, title, show_key, tmdb_id, status)
  values (private.current_owner_id(), 'sheridan', 'ZZ Twin', e.show_key, null, 'confirmed') returning * into l;
  perform pg_temp.as_anon();
  c := pg_temp.content();
  perform pg_temp.refused(pg_temp.call_sql(l, pg_temp.expected(l), jsonb_build_array(pg_temp.by_label(l.show_key, l.title, 'Season 2', '2021-01-01'))), 'target_changed');
  if pg_temp.content() <> c then raise exception 'changed (the season added to the other show was not rolled back)'; end if;
end $$ $b$);

-- ── Rules carried over from add_tv_seasons ──
select pg_temp.t('a genuinely new season reopens a Complete show to On List; a Skipped show stays Skipped', $b$ do $$
declare s public.tv_shows; v jsonb;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_identified('othertv', 990011, 'ZZ Done');
  perform public.set_show_status(s.id, 'complete');
  v := pg_temp.add(s, jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01')));
  if not (v ->> 'reopened')::boolean or (select status from public.tv_shows where id = s.id) <> 'confirmed' then raise exception 'not reopened %', v; end if;
  perform public.set_show_status(s.id, 'skipped');
  v := pg_temp.add(s, jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 3, '2022-01-01')));
  if (v ->> 'reopened')::boolean or (select status from public.tv_shows where id = s.id) <> 'skipped' then raise exception 'skipped changed %', v; end if;
end $$ $b$);

select pg_temp.t('memberships unchanged by an addition to an existing show (built-in show with a mapped collection)', $b$ do $$
declare s public.tv_shows; m text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_legacy('sheridan', 'ZZ Member');
  m := (select string_agg(id::text, ',' order by id) from public.collection_memberships);
  perform pg_temp.add(s, jsonb_build_array(pg_temp.by_label(s.show_key, s.title, 'Season 2', '2021-01-01')));
  if (select string_agg(id::text, ',' order by id) from public.collection_memberships) is distinct from m then raise exception 'memberships changed'; end if;
end $$ $b$);

select pg_temp.t('not exactly-once: after the added season is deleted (or restored away), the same request adds it again', $b$ do $$
declare s public.tv_shows; v jsonb; seasons jsonb;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_identified('othertv', 990012, 'ZZ Twice');
  seasons := jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01'));
  v := pg_temp.add(s, seasons);
  perform public.delete_tv_season((v -> 'inserted' -> 0 ->> 'id')::uuid);
  v := pg_temp.add(s, seasons);
  if jsonb_array_length(v -> 'inserted') <> 1 then raise exception 'not added again %', v; end if;
end $$ $b$);

select pg_temp.t('invalid input refused: no show id, missing expected fields, empty seasons, a season repeated', $b$ do $$
declare s public.tv_shows; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_identified('othertv', 990013, 'ZZ Bad');
  c := pg_temp.content();
  perform pg_temp.refused($q$ select public.add_tv_seasons_to_show(null, '{"collection":"othertv","show_key":"x"}', '[{}]') $q$, 'invalid_input');
  perform pg_temp.refused(pg_temp.call_sql(s, '{"collection":"othertv"}', jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01'))), 'invalid_input');
  perform pg_temp.refused(pg_temp.call_sql(s, pg_temp.expected(s), '[]'), 'invalid_input');
  perform pg_temp.refused(pg_temp.call_sql(s, pg_temp.expected(s), jsonb_build_array(pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01'),
    pg_temp.by_number(s.show_key, s.title, 2, '2021-01-01'))), 'invalid_input');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

-- ── create_tv_show: create-only ──
select pg_temp.t('create_tv_show: a new TMDB show is created where new shows go, with every season and its identity; no membership', $b$ do $$
declare v jsonb; s public.tv_shows; m text;
begin
  perform pg_temp.as_anon();
  m := (select string_agg(id::text, ',' order by id) from public.collection_memberships);
  execute pg_temp.create_sql(990030, 'ZZ Fresh', jsonb_build_array(pg_temp.by_number('zz fresh', 'ZZ Fresh', 1, '2020-01-01'), pg_temp.by_number('zz fresh', 'ZZ Fresh', 2, '2021-01-01'))) into v;
  if not (v ->> 'show_created')::boolean or jsonb_array_length(v -> 'inserted') <> 2 then raise exception 'result %', v; end if;
  select * into s from public.tv_shows where id = (v ->> 'show_id')::uuid;
  if s.collection <> 'othertv' or s.tmdb_id <> 990030 or s.status <> 'confirmed' then raise exception 'show %', to_jsonb(s); end if;
  if (select count(*) from public.watchlist_items where show_id = s.id and tmdb_id = 990030 and season_number in (1, 2)) <> 2 then raise exception 'seasons'; end if;
  if (select string_agg(id::text, ',' order by id) from public.collection_memberships) is distinct from m then raise exception 'memberships changed'; end if;
end $$ $b$);

select pg_temp.t('create_tv_show: a new show typed by hand (no TMDB identity) is created by its key', $b$ do $$
declare v jsonb;
begin
  perform pg_temp.as_anon();
  execute pg_temp.create_sql(null, 'ZZ Hand', jsonb_build_array(pg_temp.by_label('zz hand', 'ZZ Hand', 'Season 1', '2020-01-01'))) into v;
  if not (v ->> 'show_created')::boolean or (select tmdb_id from public.tv_shows where id = (v ->> 'show_id')::uuid) is not null then raise exception '%', v; end if;
end $$ $b$);

select pg_temp.t('create_tv_show refuses (show_exists) when an unmatched show with the key is already where new shows go: nothing added, that show and its seasons untouched', $b$ do $$
declare s public.tv_shows; st text; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.new_legacy('othertv', 'ZZ Occupied');   -- appeared after the page's check (single session: before the call)
  st := pg_temp.show_state(s.id); c := pg_temp.content();
  perform pg_temp.refused(pg_temp.create_sql(null, 'ZZ Occupied', jsonb_build_array(pg_temp.by_label('zz occupied', 'ZZ Occupied', 'Season 2', '2021-01-01'))), 'show_exists');
  if pg_temp.show_state(s.id) <> st or pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('create_tv_show refuses (show_exists) when the TMDB identity is already a show where new shows go, or anywhere else in the library; nothing changes', $b$ do $$
declare a public.tv_shows; b public.tv_shows; c text;
begin
  perform pg_temp.as_anon();
  a := pg_temp.new_identified('othertv', 990031, 'ZZ Same');
  b := pg_temp.new_enriched('sheridan', 990032, 'ZZ Elsewhere');
  c := pg_temp.content();
  perform pg_temp.refused(pg_temp.create_sql(990031, 'ZZ Same', jsonb_build_array(pg_temp.by_number('zz same', 'ZZ Same', 2, '2021-01-01'))), 'show_exists');
  perform pg_temp.refused(pg_temp.create_sql(990032, 'ZZ Elsewhere', jsonb_build_array(pg_temp.by_number('zz elsewhere', 'ZZ Elsewhere', 2, '2021-01-01'))), 'show_exists');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('create_tv_show: a season that can''t be added (its key held by another entry) refuses the whole creation (create_conflict); the new show is rolled back', $b$ do $$
declare c text; n int;
begin
  perform pg_temp.as_anon();
  perform pg_temp.new_legacy('othertv', 'ZZ Clash');   -- holds 'zz clash|season 1' without an identity
  c := pg_temp.content(); n := pg_temp.n_shows();
  perform pg_temp.refused(pg_temp.create_sql(990033, 'ZZ Clash', jsonb_build_array(pg_temp.by_number('zz clash', 'ZZ Clash', 1, '2020-01-01'))), 'create_conflict');
  if pg_temp.content() <> c or pg_temp.n_shows() <> n then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('create_tv_show: invalid input refused, nothing written', $b$ do $$
declare c text;
begin
  perform pg_temp.as_anon();
  c := pg_temp.content();
  perform pg_temp.refused($q$ select public.create_tv_show('{"title":"ZZ X"}', '[{}]') $q$, 'invalid_input');
  perform pg_temp.refused(pg_temp.create_sql(990034, 'ZZ Empty', '[]'), 'invalid_input');
  perform pg_temp.refused(pg_temp.create_sql(990035, 'ZZ Bad', jsonb_build_array(pg_temp.by_label('zz bad', 'ZZ Bad', 'Season 1', '2020-01-01'))), 'invalid_input');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

select json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq)::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from _t;
