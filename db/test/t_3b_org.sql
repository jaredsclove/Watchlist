-- Checks for Stage 3b-1 (prepend db/test/_prelude.sql). Run as postgres after
-- db/phase3b_org.sql, at stage final, on a replica or test project. Every check
-- works on synthetic ZZ rows inside its own rolled-back subtransaction and calls
-- the database as anon, the way the app does.

create or replace function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true);
$$;
create or replace function pg_temp.as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true);
$$;
create or replace function pg_temp.coll(p_source text) returns uuid language sql as $$
  select id from public.personal_collections where legacy_source = p_source and user_id = private.current_owner_id()
$$;
create or replace function pg_temp.colls_of_show(p uuid) returns text language sql as $$
  select coalesce(string_agg(c.name, ',' order by c.name), '') from public.collection_memberships m
  join public.personal_collections c on c.id = m.collection_id where m.show_id = p
$$;
create or replace function pg_temp.colls_of_item(p uuid) returns text language sql as $$
  select coalesce(string_agg(c.name, ',' order by c.name), '') from public.collection_memberships m
  join public.personal_collections c on c.id = m.collection_id where m.item_id = p
$$;
create or replace function pg_temp.tv_season(p_key text, p_title text, p_num int, p_date text default '2020-01-01') returns jsonb
language sql as $$
  select jsonb_build_object('item_key', p_key || '|' || case when p_num = 0 then 'specials' else 'season ' || p_num end,
    'title', p_title, 'season', case when p_num = 0 then 'Specials' else 'Season ' || p_num end, 'theme', 'ZZ Net',
    'display_date', 'Jan 1, 2020', 'date_sort', p_date, 'season_number', p_num)
$$;
create or replace function pg_temp.match_patch(p_title text, p_tmdb int, p_num int) returns jsonb language sql as $$
  select jsonb_build_object('title', p_title, 'season', 'Season ' || p_num, 'item_key', lower(p_title) || '|season ' || p_num,
    'theme', 'ZZ Net', 'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01', 'media_type', 'tv', 'tmdb_id', p_tmdb, 'season_number', p_num)
$$;
-- A legacy (unidentified) film row in a tab, as a manual add creates it.
create or replace function pg_temp.legacy_film(p_coll text, p_title text) returns uuid language sql as $$
  insert into public.watchlist_items (collection, item_key, title, season, date_sort)
  values (p_coll, lower(p_title) || '|film', p_title, 'Film', '2020-01-01') returning id
$$;
-- The client's season-to-film Match request (tmdb-match.js): one PATCH.
create or replace function pg_temp.season_to_film(p_row uuid, p_title text, p_tmdb int) returns int language plpgsql as $$
declare n int;
begin
  update public.watchlist_items set media_type = 'movie', tmdb_id = p_tmdb, season_number = null, title = p_title,
    season = 'Film', item_key = lower(p_title) || '|film', show_id = null
  where id = p_row and tmdb_id is null and media_type is null and season_number is null;
  get diagnostics n = row_count;
  return n;
end $$;
-- Content hashes (everything except owner and generated columns).
create or replace function pg_temp.content() returns text language sql as $$
  select concat_ws('/',
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.othertv_shows t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.custom_collections t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.personal_collections t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watch_with_choices t))
$$;
-- A format 3 backup of the current owner's data, with the app's exact columns.
create or replace function pg_temp.backup_v3() returns jsonb language plpgsql as $$
declare
  cols jsonb := jsonb_build_object(
    'watchlist_items', '["id","collection","item_key","title","season","theme","display_date","date_sort","watched","status","created_at","watch_with","collections","tmdb_collection_id","tmdb_collection_name","media_type","tmdb_id","season_number","show_id","skipped"]'::jsonb,
    'tv_shows', '["id","collection","title","show_key","tmdb_id","status","created_at"]'::jsonb,
    'othertv_shows', '["id","tmdb_id","title","network","created_at","collection"]'::jsonb,
    'custom_collections', '["id","name","tmdb_person_id","created_at","role"]'::jsonb,
    'personal_collections', '["id","name","legacy_source","sort_order","archived_at","created_at"]'::jsonb,
    'collection_memberships', '["id","collection_id","show_id","item_id","created_at"]'::jsonb,
    'watch_with_choices', '["id","token","label","sort_order","archived_at","created_at"]'::jsonb);
  t text; rows jsonb; tables jsonb := '{}'; counts jsonb := '{}';
begin
  for t in select jsonb_object_keys(cols) loop
    execute format('select coalesce(jsonb_agg((select jsonb_object_agg(k, to_jsonb(x) -> k) from jsonb_array_elements_text($1) k) order by x.id), ''[]'') from public.%I x', t)
      into rows using cols -> t;
    tables := tables || jsonb_build_object(t, rows);
    counts := counts || jsonb_build_object(t, jsonb_array_length(rows));
  end loop;
  return jsonb_build_object('format', 'watchlist-tracker-backup', 'formatVersion', 3, 'exportedAt', now(), 'rowCounts', counts, 'tables', tables);
end $$;

-- ── Bootstrap ──
select pg_temp.t('bootstrap: four collections in order, memberships = what each tab stores, choices cover config and rows', $b$ do $$
begin
  if (select string_agg(name || ':' || legacy_source || ':' || sort_order, ',' order by sort_order) from public.personal_collections)
     <> 'Disney+:disney:1,Sheridan:sheridan:2,90 Day:90day:3,True Crime / Docs:truecrime:4' then raise exception 'collections'; end if;
  if (select count(*) from public.collection_memberships m join public.tv_shows s on s.id = m.show_id
      join public.personal_collections c on c.id = m.collection_id and c.legacy_source = s.collection)
     <> (select count(*) from public.tv_shows where collection in ('disney', 'sheridan', '90day', 'truecrime')) then raise exception 'shows'; end if;
  if (select count(*) from public.collection_memberships m join public.watchlist_items w on w.id = m.item_id
      join public.personal_collections c on c.id = m.collection_id and c.legacy_source = w.collection)
     <> (select count(*) from public.watchlist_items where is_film and collection in ('disney', 'sheridan', '90day', 'truecrime')) then raise exception 'films'; end if;
  if (select count(*) from public.collection_memberships) <> (select count(*) from public.tv_shows where collection in ('disney', 'sheridan', '90day', 'truecrime'))
       + (select count(*) from public.watchlist_items where is_film and collection in ('disney', 'sheridan', '90day', 'truecrime')) then raise exception 'extra'; end if;
  if (select string_agg(token, ',' order by sort_order) from public.watch_with_choices) not like 'Alone,Suzanne,Rina,Whole Family%'
     or exists (select 1 from public.watch_with_choices where token <> label or archived_at is not null) then raise exception 'choices'; end if;
  if exists (select 1 from public.watchlist_items where is_film is distinct from (coalesce(media_type = 'movie', false) or (media_type is null and season = 'Film'))) then
    raise exception 'is_film'; end if;
end $$ $b$);

-- ── The trigger: genuinely new shows and films only ──
select pg_temp.t('trigger: a new show in Disney+ joins Disney+; a new show in Other TV joins nothing', $b$ do $$
declare r jsonb;
begin
  perform pg_temp.as_anon();
  r := public.add_tv_seasons('disney', '{"tmdb_id": 990003001, "title": "ZZ D Show", "show_key": "zz d show"}', jsonb_build_array(pg_temp.tv_season('zz d show', 'ZZ D Show', 1)));
  if pg_temp.colls_of_show((r ->> 'show_id')::uuid) <> 'Disney+' then raise exception 'disney %', pg_temp.colls_of_show((r ->> 'show_id')::uuid); end if;
  r := public.add_tv_seasons('othertv', '{"tmdb_id": 990003002, "title": "ZZ O Show", "show_key": "zz o show"}', jsonb_build_array(pg_temp.tv_season('zz o show', 'ZZ O Show', 1)));
  if pg_temp.colls_of_show((r ->> 'show_id')::uuid) <> '' then raise exception 'othertv'; end if;
end $$ $b$);

select pg_temp.t('trigger: seeding a new legacy show and a built-in film in Sheridan; a film added directly to True Crime / Docs; none for Movies', $b$ do $$
declare r jsonb; v uuid;
begin
  perform pg_temp.as_anon();
  r := public.seed_tv_defaults('sheridan', '[{"k": "zz seed show|season 1", "t": "ZZ Seed Show", "s": "Season 1", "ds": "2030-01-01"},
                                            {"k": "zz seed film|film", "t": "ZZ Seed Film", "s": "Film", "ds": "2030-01-01"}]');
  if pg_temp.colls_of_show((select show_id from public.watchlist_items where item_key = 'zz seed show|season 1')) <> 'Sheridan' then raise exception 'seed show'; end if;
  if pg_temp.colls_of_item((select id from public.watchlist_items where item_key = 'zz seed film|film')) <> 'Sheridan' then raise exception 'seed film'; end if;
  v := pg_temp.legacy_film('truecrime', 'ZZ Doc Film');
  if pg_temp.colls_of_item(v) <> 'True Crime / Docs' then raise exception 'truecrime film'; end if;
  insert into public.watchlist_items (collection, item_key, title, season, date_sort, media_type, tmdb_id)
  values ('movies', 'zz movie|film', 'ZZ Movie', 'Film', '2020-01-01', 'movie', 990003003) returning id into v;
  if pg_temp.colls_of_item(v) <> '' then raise exception 'movies'; end if;
end $$ $b$);

select pg_temp.t('trigger: a renamed, archived mapped collection still receives new items and stays archived', $b$ do $$
declare r jsonb;
begin
  perform pg_temp.as_anon();
  update public.personal_collections set name = 'ZZ Renamed', archived_at = now() where id = pg_temp.coll('disney');
  r := public.add_tv_seasons('disney', '{"tmdb_id": 990003004, "title": "ZZ Arch", "show_key": "zz arch"}', jsonb_build_array(pg_temp.tv_season('zz arch', 'ZZ Arch', 1)));
  if pg_temp.colls_of_show((r ->> 'show_id')::uuid) <> 'ZZ Renamed' then raise exception 'not added'; end if;
  if (select archived_at from public.personal_collections where id = pg_temp.coll('disney')) is null then raise exception 'unarchived'; end if;
end $$ $b$);

select pg_temp.t('trigger never re-adds a removed membership: reseeding, new season, edits, a duplicate insert', $b$ do $$
declare r jsonb; v_show uuid; v_row uuid;
begin
  perform pg_temp.as_anon();
  r := public.seed_tv_defaults('disney', '[{"k": "zz kept|season 1", "t": "ZZ Kept", "s": "Season 1", "ds": "2020-01-01"}]');
  select show_id, id into v_show, v_row from public.watchlist_items where item_key = 'zz kept|season 1';
  delete from public.collection_memberships where show_id = v_show;
  perform public.seed_tv_defaults('disney', '[{"k": "zz kept|season 1", "t": "ZZ Kept", "s": "Season 1", "ds": "2020-01-01"}]');
  perform public.add_tv_seasons('disney', '{"title": "ZZ Kept", "show_key": "zz kept"}',
    '[{"item_key": "zz kept|season 2", "title": "ZZ Kept", "season": "Season 2", "date_sort": "2031-01-01"}]');
  update public.watchlist_items set display_date = 'Jan 2, 2020', date_sort = '2020-01-02' where id = v_row;
  perform public.set_season_watched(v_row, true);
  perform public.set_season_skipped(v_row, true);
  perform public.set_show_status(v_show, 'watching');
  begin
    insert into public.watchlist_items (collection, item_key, title, season, date_sort) values ('disney', 'zz kept|season 1', 'ZZ Kept', 'Season 1', '2020-01-01');
    raise exception 'duplicate accepted';
  exception when unique_violation then null; end;
  if pg_temp.colls_of_show(v_show) <> '' then raise exception 're-added: %', pg_temp.colls_of_show(v_show); end if;
  if (select count(*) from public.watchlist_items where show_id = v_show) <> 2 then raise exception 'season not added'; end if;
end $$ $b$);

-- ── Deletion ──
select pg_temp.t('deletion: last season removes the show and its memberships; a film delete removes its own; collections stay; a collection with members can''t be deleted', $b$ do $$
declare r jsonb; v_show uuid; v_film uuid;
begin
  perform pg_temp.as_anon();
  r := public.add_tv_seasons('disney', '{"tmdb_id": 990003010, "title": "ZZ Del", "show_key": "zz del"}', jsonb_build_array(pg_temp.tv_season('zz del', 'ZZ Del', 1)));
  v_show := (r ->> 'show_id')::uuid;
  perform public.delete_tv_season((r -> 'inserted' -> 0 ->> 'id')::uuid);
  if exists (select 1 from public.collection_memberships where show_id = v_show) or exists (select 1 from public.tv_shows where id = v_show) then raise exception 'show'; end if;
  v_film := pg_temp.legacy_film('truecrime', 'ZZ Del Film');
  delete from public.watchlist_items where id = v_film;
  if exists (select 1 from public.collection_memberships where item_id = v_film) then raise exception 'film'; end if;
  if (select count(*) from public.personal_collections) <> 4 then raise exception 'collection removed'; end if;
  begin
    delete from public.personal_collections where id = pg_temp.coll('sheridan');
    raise exception 'collection with members deleted';
  exception when restrict_violation or foreign_key_violation then null; end;
end $$ $b$);

-- ── Match conversions ──
select pg_temp.t('M1 film → season of a new show: the new show gets exactly the film''s collections (not the default)', $b$ do $$
declare v_film uuid; r jsonb;
begin
  perform pg_temp.as_anon();
  v_film := pg_temp.legacy_film('truecrime', 'ZZ M1');
  insert into public.collection_memberships (collection_id, item_id) values (pg_temp.coll('disney'), v_film);
  delete from public.collection_memberships where item_id = v_film and collection_id = pg_temp.coll('truecrime');
  r := public.match_tv_row(v_film, '{"tmdb_id": 990003020}', pg_temp.match_patch('ZZ M1', 990003020, 1));
  if (r ->> 'blocked')::boolean then raise exception 'blocked %', r; end if;
  if pg_temp.colls_of_show((r ->> 'show_id')::uuid) <> 'Disney+' then raise exception 'show colls %', pg_temp.colls_of_show((r ->> 'show_id')::uuid); end if;
  if exists (select 1 from public.collection_memberships where item_id = v_film) then raise exception 'film memberships left'; end if;
  if (select show_id from public.watchlist_items where id = v_film) is distinct from (r ->> 'show_id')::uuid then raise exception 'not linked'; end if;
end $$ $b$);

select pg_temp.t('M1 with no collections: the new show gets none (the trigger default is removed)', $b$ do $$
declare v_film uuid; r jsonb;
begin
  perform pg_temp.as_anon();
  v_film := pg_temp.legacy_film('truecrime', 'ZZ M1b');
  delete from public.collection_memberships where item_id = v_film;
  r := public.match_tv_row(v_film, '{"tmdb_id": 990003021}', pg_temp.match_patch('ZZ M1b', 990003021, 1));
  if pg_temp.colls_of_show((r ->> 'show_id')::uuid) <> '' then raise exception 'default kept'; end if;
end $$ $b$);

select pg_temp.t('M2 film → season of an existing show, no expansion: applied for every caller (old pages too)', $b$ do $$
declare v_film uuid; v_t uuid; r jsonb;
begin
  perform pg_temp.as_anon();
  r := public.add_tv_seasons('truecrime', '{"tmdb_id": 990003030, "title": "ZZ M2", "show_key": "zz m2"}', jsonb_build_array(pg_temp.tv_season('zz m2', 'ZZ M2', 1)));
  v_t := (r ->> 'show_id')::uuid;
  v_film := pg_temp.legacy_film('truecrime', 'ZZ M2 Film');
  r := public.match_tv_row(p_row_id => v_film, p_target => '{"tmdb_id": 990003030}', p_patch => pg_temp.match_patch('ZZ M2', 990003030, 2));
  if (r ->> 'show_id')::uuid <> v_t or pg_temp.colls_of_show(v_t) <> 'True Crime / Docs' then raise exception '%', r; end if;
end $$ $b$);

select pg_temp.t('M2 expansion: an old page gets a clear error and nothing changes; a new page is asked; a stale confirmation is asked again; a matching one applies', $b$ do $$
declare v_film uuid; v_t uuid; r jsonb; v_before text; v_token text;
begin
  perform pg_temp.as_anon();
  r := public.add_tv_seasons('truecrime', '{"tmdb_id": 990003040, "title": "ZZ Exp", "show_key": "zz exp"}', jsonb_build_array(pg_temp.tv_season('zz exp', 'ZZ Exp', 1)));
  v_t := (r ->> 'show_id')::uuid;
  v_film := pg_temp.legacy_film('truecrime', 'ZZ Exp Film');
  insert into public.collection_memberships (collection_id, item_id) values (pg_temp.coll('disney'), v_film);
  v_before := pg_temp.content();
  begin
    perform public.match_tv_row(v_film, '{"tmdb_id": 990003040}', pg_temp.match_patch('ZZ Exp', 990003040, 2));
    raise exception 'old page applied an expansion';
  exception when raise_exception then
    if sqlerrm not like 'match_needs_confirmation: matching this row would also show all 1 stored seasons of "ZZ Exp" in Disney+.%' then raise exception 'message: %', sqlerrm; end if;
  end;
  if pg_temp.content() <> v_before then raise exception 'old page changed data'; end if;
  r := public.match_tv_row(v_film, '{"tmdb_id": 990003040}', pg_temp.match_patch('ZZ Exp', 990003040, 2), '{}');
  if not (r ->> 'blocked')::boolean or r ->> 'reason' <> 'membership_expansion' or (r ->> 'seasons')::int <> 1
     or r -> 'collections' -> 0 ->> 'name' <> 'Disney+' or (r ->> 'changed')::boolean then raise exception 'preview %', r; end if;
  if pg_temp.content() <> v_before then raise exception 'preview changed data'; end if;
  v_token := r ->> 'confirmation';
  -- The show gains a season after the preview: the confirmation no longer describes the expansion.
  perform public.add_tv_seasons('truecrime', '{"tmdb_id": 990003040, "title": "ZZ Exp", "show_key": "zz exp"}', jsonb_build_array(pg_temp.tv_season('zz exp', 'ZZ Exp', 3)));
  v_before := pg_temp.content();
  r := public.match_tv_row(v_film, '{"tmdb_id": 990003040}', pg_temp.match_patch('ZZ Exp', 990003040, 2), jsonb_build_object('confirm', v_token));
  if not (r ->> 'blocked')::boolean or not (r ->> 'changed')::boolean or (r ->> 'seasons')::int <> 2 or r ->> 'confirmation' = v_token then raise exception 'stale %', r; end if;
  if pg_temp.content() <> v_before then raise exception 'stale confirmation changed data'; end if;
  r := public.match_tv_row(v_film, '{"tmdb_id": 990003040}', pg_temp.match_patch('ZZ Exp', 990003040, 2), jsonb_build_object('confirm', r ->> 'confirmation'));
  if (r ->> 'blocked')::boolean or pg_temp.colls_of_show(v_t) <> 'Disney+,True Crime / Docs' or pg_temp.colls_of_item(v_film) <> '' then raise exception 'applied %', r; end if;
end $$ $b$);

select pg_temp.t('M3 one season of a multi-season show → film: the film gets the show''s collections; the show keeps them; deleting the show is refused', $b$ do $$
declare r jsonb; v_show uuid; v_s1 uuid;
begin
  perform pg_temp.as_anon();
  r := public.add_tv_seasons('truecrime', '{"title": "ZZ M3", "show_key": "zz m3"}',
    '[{"item_key": "zz m3|season 1", "title": "ZZ M3", "season": "Season 1", "date_sort": "2020-01-01"},
      {"item_key": "zz m3|season 2", "title": "ZZ M3", "season": "Season 2", "date_sort": "2021-01-01"}]');
  v_show := (r ->> 'show_id')::uuid;
  insert into public.collection_memberships (collection_id, show_id) values (pg_temp.coll('sheridan'), v_show);
  select id into v_s1 from public.watchlist_items where item_key = 'zz m3|season 1';
  if pg_temp.season_to_film(v_s1, 'ZZ M3 Film', 990003050) <> 1 then raise exception 'patch'; end if;
  if pg_temp.colls_of_item(v_s1) <> 'Sheridan,True Crime / Docs' then raise exception 'film %', pg_temp.colls_of_item(v_s1); end if;
  if pg_temp.colls_of_show(v_show) <> 'Sheridan,True Crime / Docs' then raise exception 'show lost collections'; end if;
  begin
    delete from public.tv_shows where id = v_show;
    raise exception 'show with a season deleted';
  exception when restrict_violation or foreign_key_violation then null; end;
  if pg_temp.colls_of_show(v_show) <> 'Sheridan,True Crime / Docs' then raise exception 'refused delete touched memberships'; end if;
end $$ $b$);

select pg_temp.t('M4 last season → film: the film keeps the collections after the empty show is deleted', $b$ do $$
declare r jsonb; v_show uuid; v_s1 uuid;
begin
  perform pg_temp.as_anon();
  r := public.add_tv_seasons('truecrime', '{"title": "ZZ M4", "show_key": "zz m4"}',
    '[{"item_key": "zz m4|season 1", "title": "ZZ M4", "season": "Season 1", "date_sort": "2020-01-01"}]');
  v_show := (r ->> 'show_id')::uuid; v_s1 := (r -> 'inserted' -> 0 ->> 'id')::uuid;
  perform pg_temp.season_to_film(v_s1, 'ZZ M4 Film', 990003060);
  delete from public.tv_shows where id = v_show;
  if exists (select 1 from public.collection_memberships where show_id = v_show) then raise exception 'show memberships left'; end if;
  if pg_temp.colls_of_item(v_s1) <> 'True Crime / Docs' then raise exception 'film %', pg_temp.colls_of_item(v_s1); end if;
end $$ $b$);

select pg_temp.t('M4 interrupted between the two requests: tracking and memberships intact, the empty show is inert, a retried PATCH is a no-op, a retried DELETE finishes', $b$ do $$
declare r jsonb; v_show uuid; v_s1 uuid; v_film_before text;
begin
  perform pg_temp.as_anon();
  r := public.add_tv_seasons('truecrime', '{"title": "ZZ M4i", "show_key": "zz m4i"}',
    '[{"item_key": "zz m4i|season 1", "title": "ZZ M4i", "season": "Season 1", "date_sort": "2020-01-01"}]');
  v_show := (r ->> 'show_id')::uuid; v_s1 := (r -> 'inserted' -> 0 ->> 'id')::uuid;
  perform public.set_season_watched(v_s1, true);
  perform pg_temp.season_to_film(v_s1, 'ZZ M4i Film', 990003070);
  -- (the DELETE never arrives)
  if not (select watched from public.watchlist_items where id = v_s1) then raise exception 'watched lost'; end if;
  if pg_temp.colls_of_item(v_s1) <> 'True Crime / Docs' or pg_temp.colls_of_show(v_show) <> 'True Crime / Docs' then raise exception 'memberships'; end if;
  if exists (select 1 from public.watchlist_items where show_id = v_show) then raise exception 'show not empty'; end if;
  v_film_before := pg_temp.colls_of_item(v_s1);
  if pg_temp.season_to_film(v_s1, 'ZZ M4i Film', 990003070) <> 0 then raise exception 'retried PATCH matched'; end if;
  delete from public.tv_shows where id = v_show;
  if pg_temp.colls_of_item(v_s1) <> v_film_before or exists (select 1 from public.tv_shows where id = v_show) then raise exception 'retry'; end if;
end $$ $b$);

select pg_temp.t('M2/M1 for a legacy TV season: a split gives the new show its old show''s collections; the in-place match keeps them', $b$ do $$
declare r jsonb; v_show uuid; v_s1 uuid; v_s2 uuid;
begin
  perform pg_temp.as_anon();
  r := public.add_tv_seasons('truecrime', '{"title": "ZZ Split", "show_key": "zz split"}',
    '[{"item_key": "zz split|season 1", "title": "ZZ Split", "season": "Season 1", "date_sort": "2020-01-01"},
      {"item_key": "zz split|season 2", "title": "ZZ Split", "season": "Season 2", "date_sort": "2021-01-01"}]');
  v_show := (r ->> 'show_id')::uuid;
  insert into public.collection_memberships (collection_id, show_id) values (pg_temp.coll('90day'), v_show);
  delete from public.collection_memberships where show_id = v_show and collection_id = pg_temp.coll('truecrime');
  select id into v_s1 from public.watchlist_items where item_key = 'zz split|season 1';
  r := public.match_tv_row(v_s1, '{"tmdb_id": 990003080}', pg_temp.match_patch('ZZ Split', 990003080, 1));
  if (r ->> 'show_id')::uuid = v_show or pg_temp.colls_of_show((r ->> 'show_id')::uuid) <> '90 Day' then raise exception 'split %', pg_temp.colls_of_show((r ->> 'show_id')::uuid); end if;
  if pg_temp.colls_of_show(v_show) <> '90 Day' then raise exception 'old show changed'; end if;
  select id into v_s2 from public.watchlist_items where item_key = 'zz split|season 2';
  r := public.match_tv_row(v_s2, '{"tmdb_id": 990003081}', pg_temp.match_patch('ZZ Split', 990003081, 2));
  if (r ->> 'show_id')::uuid <> v_show or pg_temp.colls_of_show(v_show) <> '90 Day' then raise exception 'in place %', r; end if;
end $$ $b$);

select pg_temp.t('Match: the show-status block is unchanged (old reply shape, nothing written)', $b$ do $$
declare r jsonb; v_row uuid; v_before text;
begin
  perform pg_temp.as_anon();
  r := public.add_tv_seasons('truecrime', '{"tmdb_id": 990003090, "title": "ZZ Blk", "show_key": "zz blk"}', jsonb_build_array(pg_temp.tv_season('zz blk', 'ZZ Blk', 1)));
  perform public.set_show_status((r ->> 'show_id')::uuid, 'watching');
  r := public.add_tv_seasons('truecrime', '{"title": "ZZ Blk L", "show_key": "zz blk l"}',
    '[{"item_key": "zz blk l|season 2", "title": "ZZ Blk L", "season": "Season 2", "date_sort": "2020-01-01"}]');
  v_row := (r -> 'inserted' -> 0 ->> 'id')::uuid;
  v_before := pg_temp.content();
  r := public.match_tv_row(v_row, '{"tmdb_id": 990003090}', pg_temp.match_patch('ZZ Blk', 990003090, 2));
  if not (r ->> 'blocked')::boolean or r ? 'reason' or r ->> 'target_status' <> 'watching' then raise exception '%', r; end if;
  if pg_temp.content() <> v_before then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('reclassification outside Match: a member film can''t be turned into a TV row directly', $b$ do $$
declare v uuid;
begin
  perform pg_temp.as_anon();
  v := pg_temp.legacy_film('truecrime', 'ZZ Flip');
  begin
    update public.watchlist_items set season = 'Season 1' where id = v;
    raise exception 'flip accepted';
  exception when foreign_key_violation then null; end;
end $$ $b$);

-- ── Ownership, kind, uniqueness, API immutability ──
select pg_temp.t('ownership and kind: a TV season can''t be a film target; another owner''s show, film, collection or choice can''t be used', $b$ do $$
declare v_other uuid := gen_random_uuid(); v_oshow uuid; v_ofilm uuid; v_ocoll uuid; v_season uuid;
begin
  perform pg_temp.as_admin();
  insert into public.tv_shows (user_id, collection, title, show_key) values (v_other, 'disney', 'ZZ Other', 'zz other') returning id into v_oshow;
  insert into public.watch_with_choices (user_id, token, label) values (v_other, 'ZZ B', 'ZZ B');
  insert into public.watchlist_items (user_id, collection, item_key, title, season, date_sort) values (v_other, 'movies', 'zz of|film', 'ZZ OF', 'Film', '2020-01-01') returning id into v_ofilm;
  insert into public.personal_collections (user_id, name) values (v_other, 'ZZ Theirs') returning id into v_ocoll;
  perform pg_temp.as_anon();
  select id into v_season from public.watchlist_items where show_id is not null limit 1;
  begin insert into public.collection_memberships (collection_id, item_id) values (pg_temp.coll('disney'), v_season); raise exception 'season as film';
  exception when foreign_key_violation then null; end;
  begin insert into public.collection_memberships (collection_id, show_id) values (pg_temp.coll('disney'), v_oshow); raise exception 'other show';
  exception when foreign_key_violation then null; end;
  begin insert into public.collection_memberships (collection_id, item_id) values (pg_temp.coll('disney'), v_ofilm); raise exception 'other film';
  exception when foreign_key_violation then null; end;
  begin insert into public.collection_memberships (collection_id, show_id) values (v_ocoll, (select id from public.tv_shows where user_id <> v_other limit 1)); raise exception 'other collection';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.watchlist_items (collection, item_key, title, season, date_sort, watch_with) values ('movies', 'zz ww|film', 'ZZ WW', 'Film', '2020-01-01', '{"ZZ B"}');
    raise exception 'other owner''s choice';
  exception when check_violation then null; end;
end $$ $b$);

select pg_temp.t('uniqueness: duplicate memberships; names and labels ignoring case, archived ones included', $b$ do $$
declare v_show uuid;
begin
  perform pg_temp.as_anon();
  select show_id into v_show from public.collection_memberships where show_id is not null limit 1;
  begin insert into public.collection_memberships (collection_id, show_id)
    select collection_id, show_id from public.collection_memberships where show_id = v_show limit 1; raise exception 'dup membership';
  exception when unique_violation then null; end;
  begin insert into public.personal_collections (name) values ('disney+'); raise exception 'case name';
  exception when unique_violation then null; end;
  insert into public.personal_collections (name, archived_at) values ('ZZ Old', now());
  begin insert into public.personal_collections (name) values ('zz old'); raise exception 'archived name reused';
  exception when unique_violation then null; end;
  begin insert into public.watch_with_choices (token, label) values ('ww:x', 'rina'); raise exception 'case label';
  exception when unique_violation then null; end;
  begin insert into public.personal_collections (name) values (' ZZ Spaced'); raise exception 'untrimmed name';
  exception when check_violation then null; end;
end $$ $b$);

select pg_temp.t('API: user_id, legacy_source and token can''t be written; memberships can''t be edited', $b$ do $$
begin
  perform pg_temp.as_anon();
  begin update public.personal_collections set legacy_source = 'sheridan' where id = pg_temp.coll('disney'); raise exception 'legacy_source';
  exception when insufficient_privilege then null; end;
  begin update public.watch_with_choices set token = 'X' where token = 'Rina'; raise exception 'token';
  exception when insufficient_privilege then null; end;
  begin insert into public.personal_collections (user_id, name) values (gen_random_uuid(), 'ZZ U'); raise exception 'user_id';
  exception when insufficient_privilege then null; end;
  begin update public.collection_memberships set collection_id = collection_id; raise exception 'membership update';
  exception when insufficient_privilege then null; end;
  begin insert into public.watchlist_items (collection, item_key, title, season, date_sort, is_film) values ('movies', 'zz g|film', 'ZZ G', 'Film', '2020-01-01', true); raise exception 'is_film';
  exception when insufficient_privilege or generated_always then null; end;
end $$ $b$);

-- ── Watch-with ──
select pg_temp.t('watch-with: an undefined value is refused, a defined one accepted, a label rename changes no row', $b$ do $$
declare v uuid; v_rows text;
begin
  perform pg_temp.as_anon();
  insert into public.watchlist_items (collection, item_key, title, season, date_sort, media_type, tmdb_id)
  values ('movies', 'zz w|film', 'ZZ W', 'Film', '2020-01-01', 'movie', 990003100) returning id into v;
  begin update public.watchlist_items set watch_with = '{"Nobody"}' where id = v; raise exception 'undefined accepted';
  exception when check_violation then null; end;
  update public.watchlist_items set watch_with = '{"Rina","Suzanne"}' where id = v;
  update public.watchlist_items set watch_with = '{}' where id = v;
  update public.watchlist_items set watch_with = '{"Rina"}' where id = v;
  v_rows := (select md5(string_agg((to_jsonb(t))::text, '|' order by id)) from public.watchlist_items t);
  update public.watch_with_choices set label = 'Rina S.' where token = 'Rina';
  if (select md5(string_agg((to_jsonb(t))::text, '|' order by id)) from public.watchlist_items t) <> v_rows then raise exception 'rows rewritten'; end if;
  if (select watch_with from public.watchlist_items where id = v) <> '{"Rina"}' then raise exception 'token'; end if;
end $$ $b$);

select pg_temp.t('watch-with: a NULL value in a row''s list is refused (on insert and update)', $b$ do $$
declare v uuid;
begin
  perform pg_temp.as_anon();
  begin
    insert into public.watchlist_items (collection, item_key, title, season, date_sort, media_type, tmdb_id, watch_with)
    values ('movies', 'zz n|film', 'ZZ N', 'Film', '2020-01-01', 'movie', 990003200, array['Rina', null]::text[]);
    raise exception 'NULL accepted on insert';
  exception when check_violation then null; end;
  insert into public.watchlist_items (collection, item_key, title, season, date_sort, media_type, tmdb_id)
  values ('movies', 'zz n2|film', 'ZZ N2', 'Film', '2020-01-01', 'movie', 990003201) returning id into v;
  begin update public.watchlist_items set watch_with = array[null]::text[] where id = v; raise exception 'NULL accepted on update';
  exception when check_violation then null; end;
end $$ $b$);

select pg_temp.t('watch-with: a choice still used on a row can''t be deleted (or have its token changed); an unused one can', $b$ do $$
declare v uuid;
begin
  perform pg_temp.as_anon();
  insert into public.watchlist_items (collection, item_key, title, season, date_sort, media_type, tmdb_id, watch_with)
  values ('movies', 'zz u|film', 'ZZ U', 'Film', '2020-01-01', 'movie', 990003210, '{"Whole Family"}') returning id into v;
  begin delete from public.watch_with_choices where token = 'Whole Family'; raise exception 'used choice deleted';
  exception when foreign_key_violation then null; end;
  perform pg_temp.as_admin();
  begin update public.watch_with_choices set token = 'WF' where token = 'Whole Family'; raise exception 'used token changed';
  exception when foreign_key_violation then null; end;
  perform pg_temp.as_anon();
  update public.watchlist_items set watch_with = '{}' where id = v;
  delete from public.watch_with_choices where token = 'Whole Family';
  if exists (select 1 from public.watch_with_choices where token = 'Whole Family') then raise exception 'unused choice not deleted'; end if;
end $$ $b$);

-- ── Restore ──
select pg_temp.t('restore v3 round trip: exclusions, an archived collection, a renamed label and a cross-tab member come back exactly; the trigger''s additions are replaced', $b$ do $$
declare b jsonb; v_show uuid; v_expected text;
begin
  perform pg_temp.as_anon();
  select show_id into v_show from public.collection_memberships m join public.personal_collections c on c.id = m.collection_id
  where c.legacy_source = 'disney' and m.show_id is not null limit 1;
  delete from public.collection_memberships where show_id = v_show;                                         -- deliberate exclusion
  update public.personal_collections set archived_at = '2026-01-01T00:00:00Z' where id = pg_temp.coll('90day');
  update public.watch_with_choices set label = 'Rina S.' where token = 'Rina';
  insert into public.collection_memberships (collection_id, show_id)
    select pg_temp.coll('sheridan'), id from public.tv_shows where collection = 'othertv' limit 1;              -- cross-tab member
  b := pg_temp.backup_v3();
  v_expected := pg_temp.content();
  -- Changes after the backup, which the restore must undo.
  perform public.add_tv_seasons('disney', '{"tmdb_id": 990003110, "title": "ZZ After", "show_key": "zz after"}', jsonb_build_array(pg_temp.tv_season('zz after', 'ZZ After', 1)));
  insert into public.collection_memberships (collection_id, show_id) values (pg_temp.coll('disney'), v_show);
  perform public.restore_backup(b, false);
  if pg_temp.content() <> v_expected then raise exception 'restore differs from the backup'; end if;
  if exists (select 1 from public.collection_memberships where show_id = v_show) then raise exception 'exclusion lost'; end if;
end $$ $b$);

select pg_temp.t('restore v3 failures roll back completely: a dangling membership, a wrong-kind target, a duplicate, an undefined watch-with value', $b$ do $$
declare b jsonb; bad jsonb; v_before text; v_season uuid;
begin
  perform pg_temp.as_anon();
  b := pg_temp.backup_v3();
  v_before := pg_temp.content();
  select id into v_season from public.watchlist_items where show_id is not null limit 1;
  foreach bad in array array[
    jsonb_set(b, '{tables,collection_memberships,0,show_id}', to_jsonb(gen_random_uuid()::text)),
    jsonb_set(jsonb_set(b, '{tables,collection_memberships,0,show_id}', 'null'), '{tables,collection_memberships,0,item_id}', to_jsonb(v_season::text)),
    jsonb_set(jsonb_set(b, '{tables,collection_memberships}', (b -> 'tables' -> 'collection_memberships') || jsonb_set(b -> 'tables' -> 'collection_memberships' -> 0, '{id}', to_jsonb(gen_random_uuid()::text))),
              '{rowCounts,collection_memberships}', to_jsonb(jsonb_array_length(b -> 'tables' -> 'collection_memberships') + 1)),
    jsonb_set(jsonb_set(b, '{tables,watch_with_choices}', '[]'::jsonb), '{rowCounts,watch_with_choices}', '0')
  ] loop
    begin
      perform public.restore_backup(bad, false);
      raise exception 'accepted a bad backup';
    exception when sqlstate '22023' then null; end;
    if pg_temp.content() <> v_before then raise exception 'a failed restore changed data'; end if;
  end loop;
end $$ $b$);

select pg_temp.t('restore: formats 1 and 2 are refused with guidance; nothing changes', $b$ do $$
declare b jsonb; v_before text;
begin
  perform pg_temp.as_anon();
  b := pg_temp.backup_v3();
  v_before := pg_temp.content();
  begin perform public.restore_backup(jsonb_set(b, '{formatVersion}', '2'), false); raise exception 'v2 accepted';
  exception when sqlstate '22023' then
    if sqlerrm not like 'restore_invalid: format 2 backups predate personal collections%' then raise exception '%', sqlerrm; end if;
  end;
  begin perform public.restore_backup(jsonb_set(b, '{formatVersion}', '1'), true); raise exception 'v1 accepted';
  exception when sqlstate '22023' then null; end;
  if pg_temp.content() <> v_before then raise exception 'changed'; end if;
end $$ $b$);

select json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq)::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from _t;
