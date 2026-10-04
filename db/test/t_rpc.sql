-- Checks for the browser-facing TV functions (prepend db/test/_prelude.sql).
-- Run as postgres after db/rpc.sql, with the stage at tv_schema or later. Each
-- check sets the stage it needs inside its own rolled-back subtransaction and
-- calls the functions as anon, the way the app will.

create or replace function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true);
$$;
create or replace function pg_temp.stage(p text) returns void language sql as $$
  update private.migration_stage set stage = p;
$$;
-- A TMDB season payload for add_tv_seasons.
create or replace function pg_temp.tv_season(p_key text, p_title text, p_num int, p_date text default '2020-01-01') returns jsonb
language sql as $$
  select jsonb_build_object('item_key', p_key || '|' || case when p_num = 0 then 'specials' else 'season ' || p_num end,
    'title', p_title, 'season', case when p_num = 0 then 'Specials' else 'Season ' || p_num end, 'theme', 'ZZ Net',
    'display_date', 'Jan 1, 2020', 'date_sort', p_date, 'season_number', p_num)
$$;

select pg_temp.t('rpc shadow: add_tv_seasons creates the show, links seasons, registers the tracked show, no reopen', $b$ do $$
declare r jsonb; v_show uuid;
begin
  perform pg_temp.stage('shadow'); perform pg_temp.as_anon();
  r := public.add_tv_seasons('othertv', '{"tmdb_id": 990000101, "title": "ZZ Rpc Show", "show_key": "zz rpc show", "network": "ZZ Net"}',
         jsonb_build_array(pg_temp.tv_season('zz rpc show', 'ZZ Rpc Show', 1), pg_temp.tv_season('zz rpc show', 'ZZ Rpc Show', 2)));
  v_show := (r ->> 'show_id')::uuid;
  if not (r ->> 'show_created')::boolean or jsonb_array_length(r -> 'inserted') <> 2 or (r ->> 'reopened')::boolean then raise exception 'result %', r; end if;
  if (select count(*) from public.watchlist_items where show_id = v_show and status = 'confirmed' and not skipped) <> 2 then raise exception 'rows'; end if;
  if not exists (select 1 from public.othertv_shows where tmdb_id = 990000101 and collection = 'othertv') then raise exception 'not tracked'; end if;
end $$ $b$);

select pg_temp.t('rpc: duplicates are existing, new seasons still insert, legacy same-key is rejected (not swallowed)', $b$ do $$
declare r jsonb; v_legacy uuid;
begin
  perform pg_temp.stage('shadow'); perform pg_temp.as_anon();
  perform public.add_tv_seasons('othertv', '{"tmdb_id": 990000102, "title": "ZZ Dup", "show_key": "zz dup"}', jsonb_build_array(pg_temp.tv_season('zz dup', 'ZZ Dup', 1)));
  insert into public.watchlist_items (collection, item_key, title, season, date_sort) values ('othertv', 'zz dup|season 3', 'ZZ Dup', 'Season 3', '2020-01-01')
  returning id into v_legacy;
  r := public.add_tv_seasons('othertv', '{"tmdb_id": 990000102, "title": "ZZ Dup", "show_key": "zz dup"}',
         jsonb_build_array(pg_temp.tv_season('zz dup', 'ZZ Dup', 1), pg_temp.tv_season('zz dup', 'ZZ Dup', 2), pg_temp.tv_season('zz dup', 'ZZ Dup', 3)));
  if jsonb_array_length(r -> 'inserted') <> 1 or (r -> 'inserted' -> 0 ->> 'season_number')::int <> 2 then raise exception 'inserted %', r -> 'inserted'; end if;
  if jsonb_array_length(r -> 'existing') <> 1 or (r -> 'existing' -> 0 ->> 'season_number')::int <> 1 then raise exception 'existing %', r -> 'existing'; end if;
  if jsonb_array_length(r -> 'rejected') <> 1 or r -> 'rejected' -> 0 ->> 'reason' <> 'legacy_row_same_key'
     or (r -> 'rejected' -> 0 ->> 'conflicting_row_id')::uuid <> v_legacy then raise exception 'rejected %', r -> 'rejected'; end if;
  if (r ->> 'show_created')::boolean then raise exception 'show recreated'; end if;
end $$ $b$);

select pg_temp.t('rpc forced failure: invalid input anywhere in the batch writes nothing (not even the show)', $b$ do $$
begin
  perform pg_temp.stage('shadow'); perform pg_temp.as_anon();
  begin
    perform public.add_tv_seasons('othertv', '{"tmdb_id": 990000103, "title": "ZZ Bad", "show_key": "zz bad"}',
      jsonb_build_array(pg_temp.tv_season('zz bad', 'ZZ Bad', 1), pg_temp.tv_season('zz bad', 'ZZ Bad', 2, 'not-a-date')));
    raise exception 'accepted invalid input';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.add_tv_seasons('othertv', '{"tmdb_id": 990000103, "title": "ZZ Bad", "show_key": "zz bad"}',
      jsonb_build_array(pg_temp.tv_season('zz bad', 'ZZ Bad', 1), pg_temp.tv_season('zz bad', 'ZZ Bad', 1)));
    raise exception 'accepted a season twice';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.add_tv_seasons('movies', '{"tmdb_id": 990000103, "title": "ZZ Bad", "show_key": "zz bad"}', jsonb_build_array(pg_temp.tv_season('zz bad', 'ZZ Bad', 1)));
    raise exception 'accepted the Movies collection';
  exception when sqlstate '22023' then null; end;
  if exists (select 1 from public.tv_shows where tmdb_id = 990000103) or exists (select 1 from public.watchlist_items where tmdb_id = 990000103) then
    raise exception 'something was written';
  end if;
end $$ $b$);

select pg_temp.t('rpc forced failure: an integrity fault after a successful insert rolls back the whole call', $b$ do $$
declare v_show uuid; v_other uuid;
begin
  perform pg_temp.stage('shadow'); perform pg_temp.as_anon();
  v_show := (public.add_tv_seasons('othertv', '{"tmdb_id": 990000104, "title": "ZZ Fault", "show_key": "zz fault"}',
               jsonb_build_array(pg_temp.tv_season('zz fault', 'ZZ Fault', 2))) ->> 'show_id')::uuid;
  perform set_config('role', 'none', true);
  -- Corrupt: link season 2 to a different show of the same owner.
  insert into public.tv_shows (collection, title, show_key) values ('othertv', 'ZZ Other', 'zz other') returning id into v_other;
  update public.watchlist_items set show_id = v_other where tmdb_id = 990000104;
  perform pg_temp.as_anon();
  begin
    perform public.add_tv_seasons('othertv', '{"tmdb_id": 990000104, "title": "ZZ Fault", "show_key": "zz fault"}',
      jsonb_build_array(pg_temp.tv_season('zz fault', 'ZZ Fault', 1), pg_temp.tv_season('zz fault', 'ZZ Fault', 2)));
    raise exception 'integrity fault not raised';
  exception when sqlstate '23000' then null; end;
  if exists (select 1 from public.watchlist_items where tmdb_id = 990000104 and season_number = 1) then raise exception 'season 1 kept'; end if;
end $$ $b$);

select pg_temp.t('rpc shadow: show-level edits are not available until the switch-over', $b$ do $$
declare v_show uuid := (select id from public.tv_shows limit 1);
begin
  perform pg_temp.stage('shadow'); perform pg_temp.as_anon();
  begin perform public.set_show_status(v_show, 'complete'); raise exception 'set_show_status ran'; exception when sqlstate '55000' then null; end;
  begin perform public.set_season_watched((select id from public.watchlist_items where show_id = v_show limit 1), true); raise exception 'watched ran';
  exception when sqlstate '55000' then null; end;
end $$ $b$);

select pg_temp.t('rpc: seed_tv_defaults seeds per owner, p makes a new show Pending, films unlinked, re-run inserts nothing', $b$ do $$
declare d jsonb := '[{"k":"zz seed show|season 1","t":"ZZ Seed Show","s":"Season 1","th":"X","d":"TBA","ds":"2027-01-01","p":true},
                     {"k":"zz seed show|season 2","t":"ZZ Seed Show","s":"Season 2","th":"X","d":"TBA","ds":"2028-01-01","p":true},
                     {"k":"zz seed film|film","t":"ZZ Seed Film","s":"Film","th":"X","d":"Jan 1, 2027","ds":"2027-01-01"}]';
  r jsonb;
begin
  perform pg_temp.stage('shadow'); perform pg_temp.as_anon();
  r := public.seed_tv_defaults('disney', d);
  if jsonb_array_length(r -> 'inserted') <> 3 or (r ->> 'shows_created')::int <> 1 then raise exception 'first run %', r; end if;
  if (select status from public.tv_shows where collection = 'disney' and show_key = 'zz seed show') <> 'pending' then raise exception 'not pending'; end if;
  if (select count(*) from public.watchlist_items w join public.tv_shows s on s.id = w.show_id where s.show_key = 'zz seed show') <> 2 then raise exception 'not linked'; end if;
  if (select show_id from public.watchlist_items where item_key = 'zz seed film|film') is not null then raise exception 'film linked'; end if;
  r := public.seed_tv_defaults('disney', d);
  if jsonb_array_length(r -> 'inserted') <> 0 or (r ->> 'shows_created')::int <> 0 then raise exception 'second run %', r; end if;
end $$ $b$);

select pg_temp.t('rpc: seeding the real Disney+ defaults over migrated data is a no-op (Clone Wars S7 stays on the merged show)', $b$ do $$
declare r jsonb; d jsonb;
begin
  perform pg_temp.stage('shadow');
  select jsonb_agg(jsonb_build_object('k', item_key, 't', title, 's', season, 'th', theme, 'd', display_date, 'ds', date_sort,
                                      'p', status = 'pending')) into d
  from public.watchlist_items where collection = 'disney';
  perform pg_temp.as_anon();
  r := public.seed_tv_defaults('disney', d);
  if jsonb_array_length(r -> 'inserted') <> 0 or jsonb_array_length(r -> 'conflicts') <> 0 then raise exception '%', r; end if;
end $$ $b$);

select pg_temp.t('rpc: delete_tv_season keeps the show until its last season, then removes it and its tracked entry', $b$ do $$
declare r jsonb; v_show uuid; a uuid; b uuid;
begin
  perform pg_temp.stage('shadow'); perform pg_temp.as_anon();
  r := public.add_tv_seasons('othertv', '{"tmdb_id": 990000105, "title": "ZZ Del", "show_key": "zz del"}',
         jsonb_build_array(pg_temp.tv_season('zz del', 'ZZ Del', 1), pg_temp.tv_season('zz del', 'ZZ Del', 2)));
  v_show := (r ->> 'show_id')::uuid; a := (r -> 'inserted' -> 0 ->> 'id')::uuid; b := (r -> 'inserted' -> 1 ->> 'id')::uuid;
  r := public.delete_tv_season(a);
  if (r ->> 'show_deleted')::boolean or not exists (select 1 from public.tv_shows where id = v_show) then raise exception 'show deleted early'; end if;
  r := public.delete_tv_season(b);
  if not (r ->> 'show_deleted')::boolean or exists (select 1 from public.tv_shows where id = v_show) then raise exception 'show kept'; end if;
  if exists (select 1 from public.othertv_shows where tmdb_id = 990000105) then raise exception 'tracked entry kept'; end if;
end $$ $b$);

select pg_temp.t('rpc: another owner''s ids are not_found and their rows are untouched', $b$ do $$
declare o uuid := gen_random_uuid(); v_show uuid; v_row uuid;
begin
  insert into public.tv_shows (user_id, collection, title, show_key, tmdb_id, status) values (o, 'othertv', 'ZZ B', 'zz b', 990000106, 'complete') returning id into v_show;
  insert into public.watchlist_items (user_id, collection, item_key, title, season, media_type, tmdb_id, season_number, show_id, date_sort)
  values (o, 'othertv', 'zz b|season 1', 'ZZ B', 'Season 1', 'tv', 990000106, 1, v_show, '2020-01-01') returning id into v_row;
  perform pg_temp.stage('authoritative'); perform pg_temp.as_anon();
  begin perform public.set_show_status(v_show, 'watching'); raise exception 'status changed'; exception when sqlstate 'P0002' then null; end;
  begin perform public.set_season_watched(v_row, true); raise exception 'watched changed'; exception when sqlstate 'P0002' then null; end;
  begin perform public.set_season_skipped(v_row, true); raise exception 'skipped changed'; exception when sqlstate 'P0002' then null; end;
  begin perform public.delete_tv_season(v_row); raise exception 'deleted'; exception when sqlstate 'P0002' then null; end;
  begin perform public.match_tv_row(v_row, '{"tmdb_id": 1}', '{}'); raise exception 'matched'; exception when sqlstate '22023' or sqlstate 'P0002' then null; end;
  -- The same TMDB show for this owner is a separate show; adding it doesn't touch the other owner.
  perform public.add_tv_seasons('othertv', '{"tmdb_id": 990000106, "title": "ZZ B", "show_key": "zz b"}', jsonb_build_array(pg_temp.tv_season('zz b', 'ZZ B', 2)));
  perform set_config('role', 'none', true);
  if (select status from public.tv_shows where id = v_show) <> 'complete' or (select watched from public.watchlist_items where id = v_row)
     or (select count(*) from public.watchlist_items where show_id = v_show) <> 1 then raise exception 'other owner changed'; end if;
end $$ $b$);

-- ── Authoritative stage ──────────────────────────────────────────────────────
select pg_temp.t('rpc authoritative: a genuinely new season reopens a Complete show; duplicates and Skipped shows don''t', $b$ do $$
declare r jsonb; v_show uuid;
begin
  perform pg_temp.stage('authoritative'); perform pg_temp.as_anon();
  v_show := (public.add_tv_seasons('othertv', '{"tmdb_id": 990000107, "title": "ZZ Reopen", "show_key": "zz reopen"}',
               jsonb_build_array(pg_temp.tv_season('zz reopen', 'ZZ Reopen', 1))) ->> 'show_id')::uuid;
  perform public.set_show_status(v_show, 'complete');
  r := public.add_tv_seasons('othertv', '{"tmdb_id": 990000107, "title": "ZZ Reopen", "show_key": "zz reopen"}', jsonb_build_array(pg_temp.tv_season('zz reopen', 'ZZ Reopen', 1)));
  if (r ->> 'reopened')::boolean or r ->> 'show_status' <> 'complete' then raise exception 'reopened on duplicate %', r; end if;
  r := public.add_tv_seasons('othertv', '{"tmdb_id": 990000107, "title": "ZZ Reopen", "show_key": "zz reopen"}', jsonb_build_array(pg_temp.tv_season('zz reopen', 'ZZ Reopen', 2)));
  if not (r ->> 'reopened')::boolean or r ->> 'show_status' <> 'confirmed' then raise exception 'not reopened %', r; end if;
  perform public.set_show_status(v_show, 'skipped');
  r := public.add_tv_seasons('othertv', '{"tmdb_id": 990000107, "title": "ZZ Reopen", "show_key": "zz reopen"}', jsonb_build_array(pg_temp.tv_season('zz reopen', 'ZZ Reopen', 3)));
  if (r ->> 'reopened')::boolean or r ->> 'show_status' <> 'skipped' then raise exception 'Skipped show changed %', r; end if;
end $$ $b$);

select pg_temp.t('rpc authoritative: seeding a new DEFAULT season reopens that Complete built-in show', $b$ do $$
declare d jsonb := '[{"k":"zz seedre|season 1","t":"ZZ Seedre","s":"Season 1","th":"X","d":"Jan 1, 2020","ds":"2020-01-01"}]'; r jsonb; v_show uuid;
begin
  perform pg_temp.stage('authoritative'); perform pg_temp.as_anon();
  perform public.seed_tv_defaults('disney', d);
  v_show := (select id from public.tv_shows where show_key = 'zz seedre');
  perform public.set_show_status(v_show, 'complete');
  r := public.seed_tv_defaults('disney', d || '[{"k":"zz seedre|season 2","t":"ZZ Seedre","s":"Season 2","th":"X","d":"TBA","ds":"2027-01-01"}]');
  if jsonb_array_length(r -> 'reopened') <> 1 or (select status from public.tv_shows where id = v_show) <> 'confirmed' then raise exception '%', r; end if;
end $$ $b$);

select pg_temp.t('rpc authoritative: compatibility values follow show status, watched and skip changes', $b$ do $$
declare v_show uuid; s1 uuid; s2 uuid; s3 uuid; r jsonb;
begin
  perform pg_temp.stage('authoritative'); perform pg_temp.as_anon();
  r := public.add_tv_seasons('othertv', '{"tmdb_id": 990000108, "title": "ZZ Compat", "show_key": "zz compat"}',
         jsonb_build_array(pg_temp.tv_season('zz compat', 'ZZ Compat', 1), pg_temp.tv_season('zz compat', 'ZZ Compat', 2), pg_temp.tv_season('zz compat', 'ZZ Compat', 3)));
  v_show := (r ->> 'show_id')::uuid;
  select id into s1 from public.watchlist_items where show_id = v_show and season_number = 1;
  select id into s2 from public.watchlist_items where show_id = v_show and season_number = 2;
  select id into s3 from public.watchlist_items where show_id = v_show and season_number = 3;
  perform public.set_show_status(v_show, 'watching');
  if (select string_agg(status, ',' order by season_number) from public.watchlist_items where show_id = v_show) <> 'watching,confirmed,confirmed' then raise exception 'watching s1'; end if;
  perform public.set_season_watched(s1, true);
  if (select string_agg(status, ',' order by season_number) from public.watchlist_items where show_id = v_show) <> 'confirmed,watching,confirmed' then raise exception 'watching s2'; end if;
  perform public.set_season_skipped(s2, true);
  if (select string_agg(status, ',' order by season_number) from public.watchlist_items where show_id = v_show) <> 'confirmed,skipped,watching' then raise exception 'skip s2'; end if;
  perform public.set_season_watched(s3, true);
  if (select string_agg(status, ',' order by season_number) from public.watchlist_items where show_id = v_show) <> 'confirmed,skipped,watching' then raise exception 'up to date anchor'; end if;
  perform public.set_show_status(v_show, 'complete');
  if (select string_agg(status, ',' order by season_number) from public.watchlist_items where show_id = v_show) <> 'complete,skipped,complete' then raise exception 'complete'; end if;
  begin perform public.set_show_status(v_show, 'caughtup'); raise exception 'accepted caughtup'; exception when sqlstate '22023' then null; end;
end $$ $b$);

select pg_temp.t('rpc authoritative: Match to TMDB is blocked when the two shows'' statuses differ, and nothing is written', $b$ do $$
declare r jsonb; v_row uuid; v_legacy uuid; v_target uuid;
begin
  perform pg_temp.stage('authoritative'); perform pg_temp.as_anon();
  r := public.add_tv_seasons('othertv', '{"title": "ZZ Manual", "show_key": "zz manual"}',
         '[{"item_key": "zz manual|season 2", "title": "ZZ Manual", "season": "Season 2", "date_sort": "2020-01-01"}]');
  v_legacy := (r ->> 'show_id')::uuid; v_row := (r -> 'inserted' -> 0 ->> 'id')::uuid;
  v_target := (public.add_tv_seasons('othertv', '{"tmdb_id": 990000109, "title": "ZZ Matched", "show_key": "zz matched"}',
                 jsonb_build_array(pg_temp.tv_season('zz matched', 'ZZ Matched', 1))) ->> 'show_id')::uuid;
  perform public.set_show_status(v_target, 'watching');
  r := public.match_tv_row(v_row, '{"tmdb_id": 990000109}', '{"title": "ZZ Matched", "season": "Season 2", "item_key": "zz matched|season 2",
         "theme": "ZZ Net", "display_date": "Jan 1, 2021", "date_sort": "2021-01-01", "media_type": "tv", "tmdb_id": 990000109, "season_number": 2}');
  if not (r ->> 'blocked')::boolean or r ->> 'legacy_status' <> 'confirmed' or r ->> 'target_status' <> 'watching' then raise exception '%', r; end if;
  if (select tmdb_id from public.watchlist_items where id = v_row) is not null then raise exception 'row changed'; end if;
  perform public.set_show_status(v_legacy, 'watching');
  r := public.match_tv_row(v_row, '{"tmdb_id": 990000109}', '{"title": "ZZ Matched", "season": "Season 2", "item_key": "zz matched|season 2",
         "theme": "ZZ Net", "display_date": "Jan 1, 2021", "date_sort": "2021-01-01", "media_type": "tv", "tmdb_id": 990000109, "season_number": 2}');
  if (r ->> 'blocked')::boolean or (r ->> 'show_id')::uuid <> v_target then raise exception 'not moved %', r; end if;
  if exists (select 1 from public.tv_shows where id = v_legacy) then raise exception 'empty legacy show kept'; end if;
end $$ $b$);

select pg_temp.t('rpc: Match converts a single-season legacy show in place and keeps its status', $b$ do $$
declare r jsonb; v_row uuid; v_legacy uuid;
begin
  perform pg_temp.stage('authoritative'); perform pg_temp.as_anon();
  r := public.add_tv_seasons('truecrime', '{"title": "ZZ Doc", "show_key": "zz doc"}',
         '[{"item_key": "zz doc|season 1", "title": "ZZ Doc", "season": "Season 1", "date_sort": "2020-01-01"}]');
  v_legacy := (r ->> 'show_id')::uuid; v_row := (r -> 'inserted' -> 0 ->> 'id')::uuid;
  perform public.set_show_status(v_legacy, 'complete');
  r := public.match_tv_row(v_row, '{"tmdb_id": 990000110}', '{"title": "ZZ Doc", "season": "Season 1", "item_key": "zz doc|season 1",
         "theme": "ZZ Net", "display_date": "Jan 1, 2020", "date_sort": "2020-01-01", "media_type": "tv", "tmdb_id": 990000110, "season_number": 1}');
  if (r ->> 'show_id')::uuid <> v_legacy or (select tmdb_id from public.tv_shows where id = v_legacy) <> 990000110
     or (select status from public.tv_shows where id = v_legacy) <> 'complete' then raise exception '%', r; end if;
end $$ $b$);

select json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq)::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from _t;
