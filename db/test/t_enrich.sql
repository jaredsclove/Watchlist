-- Checks for admin TMDB enrichment (db/admin/tv_enrich.sql) and the guard that
-- makes later seasons of an enriched built-in show join it (db/rpc.sql).
-- Prepend db/test/_prelude.sql. Run as postgres after both files, on data that has
-- the Sheridan shows Landman (3 seasons) and Tulsa King (4 seasons). Each check
-- runs in its own rolled-back subtransaction.

create or replace function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true);
$$;
create or replace function pg_temp.as_postgres() returns void language sql as $$
  select set_config('role', 'none', true), set_config('request.jwt.claims', '', true);
$$;
-- Enriches a Sheridan show with "Season N" labels as TMDB seasons N (as postgres).
create or replace function pg_temp.enrich(p_title text, p_tmdb int) returns uuid language plpgsql as $$
declare v uuid;
begin
  select id into v from public.tv_shows where collection = 'sheridan' and title = p_title;
  perform private.tv_enrich_show(v, p_title, p_tmdb, (
    select jsonb_agg(jsonb_build_object('row_id', w.id, 'season', w.season, 'season_number', substring(w.season from 8)::int))
    from public.watchlist_items w where w.show_id = v), true);
  return v;
end $$;
create or replace function pg_temp.default_(p_key text, p_label text, p_ds text default '2099-01-01', p_d text default 'TBA') returns jsonb
language sql as $$ select jsonb_build_object('k', p_key, 't', 'Landman', 's', p_label, 'th', 'Landman', 'd', p_d, 'ds', p_ds) $$;
create or replace function pg_temp.shows(p_key text) returns int language sql as $$
  select count(*)::int from public.tv_shows where collection = 'sheridan' and show_key = p_key
$$;

select pg_temp.t('enrich: dry run writes nothing; apply changes only tmdb_id (show) and media_type/tmdb_id/season_number (seasons)', $b$ do $$
declare v uuid; before text; after text; plan jsonb;
begin
  update private.migration_stage set stage = 'final';
  select id into v from public.tv_shows where collection = 'sheridan' and title = 'Landman';
  before := (select string_agg((to_jsonb(w) - 'media_type' - 'tmdb_id' - 'season_number')::text, '|' order by id) from public.watchlist_items w)
         || (select string_agg((to_jsonb(s) - 'tmdb_id')::text, '|' order by id) from public.tv_shows s);
  plan := private.tv_enrich_show(v, 'Landman', 157741, (select jsonb_agg(jsonb_build_object('row_id', id, 'season', season,
    'season_number', substring(season from 8)::int)) from public.watchlist_items where show_id = v));
  if (plan ->> 'applied')::boolean or exists (select 1 from public.tv_shows where id = v and tmdb_id is not null) then raise exception 'dry run wrote: %', plan; end if;
  perform pg_temp.enrich('Landman', 157741);
  after := (select string_agg((to_jsonb(w) - 'media_type' - 'tmdb_id' - 'season_number')::text, '|' order by id) from public.watchlist_items w)
        || (select string_agg((to_jsonb(s) - 'tmdb_id')::text, '|' order by id) from public.tv_shows s);
  if before <> after then raise exception 'other fields changed'; end if;
  if (select count(*) from public.watchlist_items where show_id = v and media_type = 'tv' and tmdb_id = 157741
      and season_number = substring(season from 8)::int) <> 3 then raise exception 'seasons not identified'; end if;
  if has_function_privilege('anon', 'private.tv_enrich_show(uuid, text, integer, jsonb, boolean)', 'execute') then raise exception 'anon can execute'; end if;
end $$ $b$);

select pg_temp.t('enrich guards: wrong title, unmapped season, duplicate number, already enriched, duplicate TMDB show', $b$ do $$
declare v uuid; t uuid; n int := 0; m jsonb;
begin
  update private.migration_stage set stage = 'final';
  select id into v from public.tv_shows where collection = 'sheridan' and title = 'Landman';
  select id into t from public.tv_shows where collection = 'sheridan' and title = 'Tulsa King';
  m := (select jsonb_agg(jsonb_build_object('row_id', id, 'season', season, 'season_number', substring(season from 8)::int)) from public.watchlist_items where show_id = v);
  begin perform private.tv_enrich_show(v, 'Landmann', 157741, m, true); exception when others then n := n + 1; end;
  begin perform private.tv_enrich_show(v, 'Landman', 157741, m - 0, true); exception when others then n := n + 1; end;
  begin perform private.tv_enrich_show(v, 'Landman', 157741, jsonb_set(m, '{1,season_number}', '1'), true); exception when others then n := n + 1; end;
  perform pg_temp.enrich('Landman', 157741);
  begin perform private.tv_enrich_show(v, 'Landman', 157741, m, true); exception when others then n := n + 1; end;
  begin perform private.tv_enrich_show(t, 'Tulsa King', 157741, (select jsonb_agg(jsonb_build_object('row_id', id, 'season', season,
    'season_number', substring(season from 8)::int)) from public.watchlist_items where show_id = t), true); exception when others then n := n + 1; end;
  if n <> 5 then raise exception 'only % of 5 refused', n; end if;
  if exists (select 1 from public.tv_shows where id = t and tmdb_id is not null) then raise exception 'Tulsa King changed'; end if;
end $$ $b$);

select pg_temp.t('guard: a future "Season N" default of an enriched show joins it as TMDB season N (no second show)', $b$ do $$
declare v uuid; r jsonb;
begin
  update private.migration_stage set stage = 'final';
  v := pg_temp.enrich('Landman', 157741);
  perform pg_temp.as_anon();
  r := public.seed_tv_defaults('sheridan', jsonb_build_array(pg_temp.default_('landman|season 4', 'Season 4')));
  perform pg_temp.as_postgres();
  if jsonb_array_length(r -> 'inserted') <> 1 or (r -> 'inserted' -> 0 ->> 'show_id')::uuid <> v
     or (r -> 'inserted' -> 0 ->> 'tmdb_id')::int <> 157741 or (r -> 'inserted' -> 0 ->> 'season_number')::int <> 4
     or r -> 'inserted' -> 0 ->> 'media_type' <> 'tv' or (r ->> 'shows_created')::int <> 0 then raise exception 'result %', r; end if;
  if pg_temp.shows('landman') <> 1 then raise exception 'second show'; end if;
end $$ $b$);

select pg_temp.t('guard: a manual add of a plain "Season N" joins the enriched show; Specials / parts / "(Final)" are rejected for review', $b$ do $$
declare v uuid; r jsonb; bad text;
begin
  update private.migration_stage set stage = 'final';
  v := pg_temp.enrich('Landman', 157741);
  perform pg_temp.as_anon();
  r := public.add_tv_seasons('sheridan', '{"tmdb_id": null, "title": "Landman", "show_key": "landman"}',
    '[{"item_key": "landman|season 5", "title": "Landman", "season": "Season 5", "theme": "Landman", "display_date": "TBA", "date_sort": "2099-01-01"}]');
  if jsonb_array_length(r -> 'inserted') <> 1 or (r ->> 'show_id')::uuid <> v or (r ->> 'show_created')::boolean
     or (r -> 'inserted' -> 0 ->> 'season_number')::int <> 5 then raise exception 'manual %', r; end if;
  foreach bad in array array['Specials', 'Season 6 (Part 1)', 'Season 6 (Final)', 'Volume 6', 'Season 06'] loop
    r := public.add_tv_seasons('sheridan', '{"tmdb_id": null, "title": "Landman", "show_key": "landman"}',
      jsonb_build_array(jsonb_build_object('item_key', 'landman|' || lower(bad), 'title', 'Landman', 'season', bad, 'date_sort', '2099-01-01')));
    if jsonb_array_length(r -> 'inserted') <> 0 or r -> 'rejected' -> 0 ->> 'reason' <> 'enriched_show_label' then raise exception '% → %', bad, r; end if;
    r := public.seed_tv_defaults('sheridan', jsonb_build_array(pg_temp.default_('landman|' || lower(bad) || ' x', bad)));
    if jsonb_array_length(r -> 'inserted') <> 0 or r -> 'conflicts' -> 0 ->> 'reason' <> 'enriched_show_label' then raise exception 'seed % → %', bad, r; end if;
  end loop;
  perform pg_temp.as_postgres();
  if pg_temp.shows('landman') <> 1 then raise exception 'second show'; end if;
end $$ $b$);

select pg_temp.t('guard: Complete enriched show + a new season → joins and reopens On List; Skipped stays Skipped', $b$ do $$
declare v uuid; r jsonb;
begin
  update private.migration_stage set stage = 'final';
  v := pg_temp.enrich('Landman', 157741);
  update public.tv_shows set status = 'complete' where id = v;
  perform pg_temp.as_anon();
  r := public.seed_tv_defaults('sheridan', jsonb_build_array(pg_temp.default_('landman|season 4', 'Season 4')));
  perform pg_temp.as_postgres();
  if (select status from public.tv_shows where id = v) <> 'confirmed' or (r -> 'reopened') <> jsonb_build_array(v) then raise exception 'not reopened %', r; end if;
  update public.tv_shows set status = 'skipped' where id = v;
  perform pg_temp.as_anon();
  r := public.add_tv_seasons('sheridan', '{"tmdb_id": null, "title": "Landman", "show_key": "landman"}',
    '[{"item_key": "landman|season 5", "title": "Landman", "season": "Season 5", "date_sort": "2099-01-01"}]');
  perform pg_temp.as_postgres();
  if (select status from public.tv_shows where id = v) <> 'skipped' or (r ->> 'reopened')::boolean or jsonb_array_length(r -> 'inserted') <> 1 then raise exception 'skipped %', r; end if;
  if pg_temp.shows('landman') <> 1 then raise exception 'second show'; end if;
end $$ $b$);

select pg_temp.t('guard: a season already on the enriched show is a no-op; an identity held by another key is rejected', $b$ do $$
declare v uuid; r jsonb; n int;
begin
  update private.migration_stage set stage = 'final';
  v := pg_temp.enrich('Landman', 157741);
  n := (select count(*) from public.watchlist_items);
  perform pg_temp.as_anon();
  r := public.seed_tv_defaults('sheridan', jsonb_build_array(pg_temp.default_('landman|season 1', 'Season 1')));
  if jsonb_array_length(r -> 'inserted') <> 0 or jsonb_array_length(r -> 'conflicts') <> 0 then raise exception 'duplicate %', r; end if;
  r := public.add_tv_seasons('sheridan', '{"tmdb_id": null, "title": "Landman", "show_key": "landman"}',
    '[{"item_key": "landman|season 2", "title": "Landman", "season": "Season 2", "date_sort": "2025-11-16"}]');
  if jsonb_array_length(r -> 'existing') <> 1 or jsonb_array_length(r -> 'inserted') <> 0 then raise exception 'manual duplicate %', r; end if;
  r := public.seed_tv_defaults('sheridan', jsonb_build_array(pg_temp.default_('landman|second season', 'Season 2')));
  if jsonb_array_length(r -> 'inserted') <> 0 or r -> 'conflicts' -> 0 ->> 'reason' <> 'identity_conflict' then raise exception 'conflict %', r; end if;
  perform pg_temp.as_postgres();
  if (select count(*) from public.watchlist_items) <> n or pg_temp.shows('landman') <> 1 then raise exception 'rows or shows changed'; end if;
end $$ $b$);

select pg_temp.t('guard: not on dynamic tabs (Other TV keeps its separate legacy show for a manual add) or for unmatched built-in shows', $b$ do $$
declare r jsonb; k text; t text;
begin
  update private.migration_stage set stage = 'final';
  select show_key, title into k, t from public.tv_shows where collection = 'othertv' and tmdb_id is not null order by title limit 1;
  perform pg_temp.as_anon();
  r := public.add_tv_seasons('othertv', jsonb_build_object('tmdb_id', null, 'title', t, 'show_key', k),
    jsonb_build_array(jsonb_build_object('item_key', k || '|season 99', 'title', t, 'season', 'Season 99', 'date_sort', '2099-01-01')));
  if not (r ->> 'show_created')::boolean then raise exception 'dynamic tab changed: %', r; end if;
  r := public.seed_tv_defaults('sheridan', jsonb_build_array(pg_temp.default_('tulsa king|season 5', 'Season 5')));
  perform pg_temp.as_postgres();
  if (r -> 'inserted' -> 0 ->> 'tmdb_id') is not null or (r -> 'inserted' -> 0 ->> 'show_id')::uuid
     <> (select id from public.tv_shows where collection = 'sheridan' and title = 'Tulsa King') then raise exception 'unmatched show %', r; end if;
end $$ $b$);

-- Enriched show with owner-approved nonstandard labels (Star Wars: Visions, Volume N → TMDB N).
create or replace function pg_temp.enrich_visions() returns uuid language plpgsql as $$
declare v uuid;
begin
  select id into v from public.tv_shows where collection = 'disney' and title = 'Star Wars: Visions';
  perform private.tv_enrich_show(v, 'Star Wars: Visions', 114478, (
    select jsonb_agg(jsonb_build_object('row_id', w.id, 'season', w.season, 'season_number', substring(w.season from 8)::int))
    from public.watchlist_items w where w.show_id = v), true);
  return v;
end $$;
create or replace function pg_temp.vdef(p_key text, p_label text) returns jsonb language sql as $$
  select jsonb_build_object('k', p_key, 't', 'Star Wars: Visions', 's', p_label, 'th', 'Star Wars', 'd', 'TBA', 'ds', '2099-01-01')
$$;

select pg_temp.t('guard: existing nonstandard-label seasons of an enriched show (Visions Volume 1–3) are a no-op, no conflict', $b$ do $$
declare v uuid; r jsonb; n int; before text;
begin
  update private.migration_stage set stage = 'final';
  v := pg_temp.enrich_visions();
  if (select string_agg(season || '=' || season_number, ',' order by season_number) from public.watchlist_items where show_id = v)
     <> 'Volume 1=1,Volume 2=2,Volume 3=3' then raise exception 'mapping not as approved'; end if;
  n := (select count(*) from public.watchlist_items);
  before := (select string_agg(to_jsonb(w)::text, '|' order by id) from public.watchlist_items w);
  perform pg_temp.as_anon();
  r := public.seed_tv_defaults('disney', jsonb_build_array(pg_temp.vdef('star wars: visions|volume 1', 'Volume 1'),
    pg_temp.vdef('star wars: visions|volume 2', 'Volume 2'), pg_temp.vdef('star wars: visions|volume 3', 'Volume 3')));
  if jsonb_array_length(r -> 'inserted') <> 0 or jsonb_array_length(r -> 'conflicts') <> 0 then raise exception 'seed %', r; end if;
  r := public.add_tv_seasons('disney', '{"tmdb_id": null, "title": "Star Wars: Visions", "show_key": "star wars: visions"}',
    '[{"item_key": "star wars: visions|volume 2", "title": "Star Wars: Visions", "season": "Volume 2", "date_sort": "2023-05-04"}]');
  if jsonb_array_length(r -> 'existing') <> 1 or jsonb_array_length(r -> 'inserted') <> 0 or jsonb_array_length(r -> 'rejected') <> 0
     or (r -> 'existing' -> 0 ->> 'season_number')::int <> 2 then raise exception 'manual %', r; end if;
  perform pg_temp.as_postgres();
  if (select count(*) from public.watchlist_items) <> n or (select string_agg(to_jsonb(w)::text, '|' order by id) from public.watchlist_items w) <> before
     or (select count(*) from public.tv_shows where collection = 'disney' and show_key = 'star wars: visions') <> 1 then raise exception 'data or shows changed'; end if;
end $$ $b$);

select pg_temp.t('guard: a new nonstandard label on an enriched show (Visions "Volume 4") is held for review, nothing inserted', $b$ do $$
declare v uuid; r jsonb; n int;
begin
  update private.migration_stage set stage = 'final';
  v := pg_temp.enrich_visions();
  n := (select count(*) from public.watchlist_items);
  perform pg_temp.as_anon();
  r := public.seed_tv_defaults('disney', jsonb_build_array(pg_temp.vdef('star wars: visions|volume 4', 'Volume 4')));
  if jsonb_array_length(r -> 'inserted') <> 0 or r -> 'conflicts' -> 0 ->> 'reason' <> 'enriched_show_label' then raise exception 'seed %', r; end if;
  r := public.add_tv_seasons('disney', '{"tmdb_id": null, "title": "Star Wars: Visions", "show_key": "star wars: visions"}',
    '[{"item_key": "star wars: visions|volume 4", "title": "Star Wars: Visions", "season": "Volume 4", "date_sort": "2099-01-01"}]');
  if jsonb_array_length(r -> 'inserted') <> 0 or r -> 'rejected' -> 0 ->> 'reason' <> 'enriched_show_label' then raise exception 'manual %', r; end if;
  -- an existing key sent with a different nonstandard label is not "existing": held for review
  r := public.seed_tv_defaults('disney', jsonb_build_array(pg_temp.vdef('star wars: visions|volume 1', 'Volume One')));
  if jsonb_array_length(r -> 'inserted') <> 0 or r -> 'conflicts' -> 0 ->> 'reason' <> 'enriched_show_label' then raise exception 'relabel %', r; end if;
  perform pg_temp.as_postgres();
  if (select count(*) from public.watchlist_items) <> n or (select count(*) from public.tv_shows where collection = 'disney' and show_key = 'star wars: visions') <> 1
    then raise exception 'rows or shows changed'; end if;
end $$ $b$);

select pg_temp.t('guard: enriched Visions + a new "Season 4" attaches as TMDB season 4; repeating it is a no-op; an identity held by another key is rejected', $b$ do $$
declare v uuid; r jsonb; n int;
begin
  update private.migration_stage set stage = 'final';
  v := pg_temp.enrich_visions();
  perform pg_temp.as_anon();
  r := public.seed_tv_defaults('disney', jsonb_build_array(pg_temp.vdef('star wars: visions|season 4', 'Season 4')));
  if jsonb_array_length(r -> 'inserted') <> 1 or (r -> 'inserted' -> 0 ->> 'show_id')::uuid <> v or (r -> 'inserted' -> 0 ->> 'tmdb_id')::int <> 114478
     or (r -> 'inserted' -> 0 ->> 'season_number')::int <> 4 or jsonb_array_length(r -> 'conflicts') <> 0 then raise exception 'season 4 %', r; end if;
  n := (select count(*) from public.watchlist_items);
  r := public.seed_tv_defaults('disney', jsonb_build_array(pg_temp.vdef('star wars: visions|season 4', 'Season 4')));
  if jsonb_array_length(r -> 'inserted') <> 0 or jsonb_array_length(r -> 'conflicts') <> 0 then raise exception 'repeat %', r; end if;
  r := public.seed_tv_defaults('disney', jsonb_build_array(pg_temp.vdef('star wars: visions|season 1', 'Season 1')));
  if jsonb_array_length(r -> 'inserted') <> 0 or r -> 'conflicts' -> 0 ->> 'reason' <> 'identity_conflict' then raise exception 'conflict %', r; end if;
  perform pg_temp.as_postgres();
  if (select count(*) from public.watchlist_items) <> n or (select count(*) from public.tv_shows where collection = 'disney' and show_key = 'star wars: visions') <> 1
    then raise exception 'rows or shows changed'; end if;
end $$ $b$);

select coalesce(json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq), '[]')::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from pg_temp._t;
