-- CU1d: confirm a show's sole TMDB network, and add marks to a Watched season (items 1 and 4, after CU1). One
-- transaction, run as postgres on a contracted-cu1 database. Design: docs/ITEM4_DESIGN.md §4.5.
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.cu1d_run', '<a fresh run id, recorded before running>', false);
--
-- public.library_cu_sync_show_network(p_show_id, p_expected, p_networks)
--   p_networks: the show's current TMDB network names (a non-empty label list; missing TMDB data is never sent, so
--   it can't blank anything). Locks the owner's show and refuses (target_changed, nothing written) unless tmdb_id,
--   network, network_candidates and metadata_owner_set are each as expected. A show without a TMDB identity is
--   refused (show_unmatched). The rules are decided here, not by the page:
--     a confirmed network       no write: outcome 'already', network_outcome 'kept' (never replaced);
--     no network, one name, the Details flag off: network and network_candidates set: 'confirmed';
--     otherwise (several names, or the flag on): only network_candidates, when they differ: 'needs_choice'.
--   metadata_owner_set is never written: an automatic confirmation isn't recorded as the owner's choice. Saving
--   Details sets that flag, so a network cleared there stays cleared. No other column is written.
--
-- public.library_add_watched_season_marks(p_season_id, p_expected, p_episodes)
--   The one exception to the Watched lock, and an add only: it can't remove a mark or change a season.
--   p_expected: { show_id, show_tmdb_id, tmdb_id, season_number, watched, skipped }, the identity the page's
--   episode list was read for and the flags it showed. Locks the show, then the season (the order of
--   library_set_episode_marks), and refuses (target_changed) if any of them differs, so a rematch refuses a stale
--   request. Refuses a season that isn't Watched (season_not_watched) or is Skipped (season_locked), and one that
--   isn't a TMDB-matched TV season (season_unmatched). Existing marks are kept as stored (on conflict do nothing).
--   library_set_episode_marks is unchanged: ordinary episode editing stays locked while a season is Watched.
--
-- Adds nothing else: no table, column, trigger, policy, status, capability or backup-format change (backups stay
-- format 7; the page detects each function by calling it).
--
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate
-- execution). Never rerun to find out; a rerun is refused once this committed. No rollback (fix-forward);
-- db/test/cu1d_reverse.sql is for test environments only.
begin;
select set_config('application_name', 'watchlist-cu1d-' || coalesce(nullif(current_setting('watchlist.cu1d_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;
lock table public.tv_shows, public.watchlist_items, public.episode_marks, public.update_holds in share row exclusive mode;

-- ── 1. Preconditions ───────────────────────────────────────────────────────────
create temp table cu1d_ctx on commit drop as
select nullif(current_setting('watchlist.cu1d_run', true), '') as run_id,
  (select md5(string_agg(md5(s::text), ',' order by s.id)) from public.tv_shows s) as shows_before,
  (select md5(string_agg(md5(w::text), ',' order by w.id)) from public.watchlist_items w) as rows_before,
  (select coalesce(md5(string_agg(md5(m::text), ',' order by m.id)), '') from public.episode_marks m) as marks_before,
  (select coalesce(md5(string_agg(md5(h::text), ',' order by h.id)), '') from public.update_holds h) as holds_before,
  (select md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), ',' order by p.oid::regprocedure::text)) from pg_proc p
   where p.oid in (to_regprocedure('public.stage5_capabilities()'), to_regprocedure('public.library_set_episode_marks(uuid, jsonb, boolean, jsonb)'),
     to_regprocedure('public.library_create_show_b45(jsonb, jsonb)'), to_regprocedure('public.library_set_metadata_b45(text, uuid, jsonb, jsonb)'))) as funcs_before,
  (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.stage5_capabilities()'), to_regprocedure('public.library_set_episode_marks(uuid, jsonb, boolean, jsonb)'),
     to_regprocedure('public.library_create_show_b45(jsonb, jsonb)'), to_regprocedure('public.library_set_metadata_b45(text, uuid, jsonb, jsonb)'))) as funcs_count;
do $$
declare c record;
begin
  select * into c from cu1d_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'cu1d: set watchlist.cu1d_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-cu1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '7' then
    raise exception 'cu1d: expected phase contracted-cu1 with backup format 7, found % / %; nothing was changed',
      public.stage5_capabilities() ->> 'phase', public.stage5_capabilities() ->> 'backup_format';
  end if;
  if not exists (select 1 from private.migration_runs where migration = 'cu1') then raise exception 'cu1d: CU1 has no run record; nothing was changed'; end if;
  if to_regprocedure('public.library_cu_sync_show_network(uuid, jsonb, jsonb)') is not null
     or to_regprocedure('public.library_add_watched_season_marks(uuid, jsonb, jsonb)') is not null then
    raise exception 'cu1d: already installed; nothing was changed';
  end if;
  if c.funcs_count <> 4 or to_regprocedure('private.lib_write_on()') is null or to_regprocedure('private.lib_refuse(text, text)') is null
     or to_regprocedure('private.b45_changed()') is null or to_regprocedure('private.b45_labels(jsonb, text)') is null then
    raise exception 'cu1d: a function this depends on is missing; nothing was changed';
  end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'cu1d: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
end $$;

-- ── 2. The functions ───────────────────────────────────────────────────────────
create function public.library_cu_sync_show_network(p_show_id uuid, p_expected jsonb, p_networks jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_cu_sync_show_network', 'final');
  v_keys constant text[] := array['metadata_owner_set', 'network', 'network_candidates', 'tmdb_id'];
  v_names text[];
  s public.tv_shows;
  v_network text;
  v_outcome text;
  v_key text;
begin
  if p_show_id is null or jsonb_typeof(p_expected) is distinct from 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(p_expected) k) is distinct from v_keys then
    raise exception 'invalid_input: show network' using errcode = '22023';
  end if;
  v_names := private.b45_labels(p_networks, 'networks');
  if cardinality(v_names) = 0 then raise exception 'invalid_input: show network' using errcode = '22023'; end if;
  perform private.lib_write_on();
  select * into s from public.tv_shows where id = p_show_id and user_id = v_owner for update;
  if not found then perform private.lib_refuse('target_missing', 'This show is no longer on your list, so nothing was changed.'); end if;
  -- to_jsonb of the row: a stored null is JSON null, as the page sends it.
  foreach v_key in array v_keys loop
    if (to_jsonb(s) -> v_key) is distinct from (p_expected -> v_key) then perform private.b45_changed(); end if;
  end loop;
  if s.tmdb_id is null then perform private.lib_refuse('show_unmatched', 'Only a show matched to TMDB takes its networks from TMDB. Nothing was changed.'); end if;
  if s.network is not null then
    return jsonb_build_object('outcome', 'already', 'result', jsonb_build_object('network_outcome', 'kept', 'network', s.network, 'network_candidates', to_jsonb(s.network_candidates)));
  end if;
  v_network := case when cardinality(v_names) = 1 and not s.metadata_owner_set then v_names[1] end;
  v_outcome := case when v_network is not null then 'confirmed' else 'needs_choice' end;
  if v_network is null and s.network_candidates = v_names then
    return jsonb_build_object('outcome', 'already', 'result', jsonb_build_object('network_outcome', v_outcome, 'network', null, 'network_candidates', to_jsonb(s.network_candidates)));
  end if;
  update public.tv_shows set network = v_network, network_candidates = v_names
  where id = s.id and user_id = v_owner and network is null returning * into s;
  if not found then perform private.b45_changed(); end if;
  return jsonb_build_object('outcome', 'applied', 'result', jsonb_build_object('network_outcome', v_outcome, 'network', s.network, 'network_candidates', to_jsonb(s.network_candidates)));
end $$;

create function public.library_add_watched_season_marks(p_season_id uuid, p_expected jsonb, p_episodes jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_add_watched_season_marks', 'final');
  r public.watchlist_items;
  v_show_tmdb integer;
begin
  if p_season_id is null or jsonb_typeof(p_expected) is distinct from 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(p_expected) k) is distinct from array['season_number', 'show_id', 'show_tmdb_id', 'skipped', 'tmdb_id', 'watched']::text[]
     or jsonb_typeof(p_expected -> 'show_id') is distinct from 'string' or jsonb_typeof(p_expected -> 'show_tmdb_id') is distinct from 'number'
     or jsonb_typeof(p_expected -> 'tmdb_id') is distinct from 'number' or jsonb_typeof(p_expected -> 'season_number') is distinct from 'number'
     or jsonb_typeof(p_expected -> 'watched') is distinct from 'boolean' or jsonb_typeof(p_expected -> 'skipped') is distinct from 'boolean'
     or jsonb_typeof(p_episodes) is distinct from 'array' or jsonb_array_length(p_episodes) not between 1 and 500
     or exists (select 1 from jsonb_array_elements(p_episodes) e
                where jsonb_typeof(e) is distinct from 'object'
                   or jsonb_typeof(e -> 'tmdb_episode_id') is distinct from 'number' or (e ->> 'tmdb_episode_id') !~ '^[1-9][0-9]{0,8}$'
                   or jsonb_typeof(e -> 'episode_number') is distinct from 'number' or (e ->> 'episode_number') !~ '^[0-9]{1,6}$')
     or (select count(distinct e ->> 'tmdb_episode_id') from jsonb_array_elements(p_episodes) e) <> jsonb_array_length(p_episodes) then
    raise exception 'invalid_input: episode marks' using errcode = '22023';
  end if;
  select * into r from public.watchlist_items where id = p_season_id and user_id = v_owner and not is_film;
  if r.id is null then perform private.lib_refuse('target_missing', 'This season is no longer on your list, so nothing was changed.'); end if;
  if r.show_id is not null then select tmdb_id into v_show_tmdb from public.tv_shows where id = r.show_id and user_id = v_owner for update; end if;
  select * into r from public.watchlist_items where id = r.id and user_id = v_owner for update;
  if r.id is null then perform private.lib_refuse('target_missing', 'This season is no longer on your list, so nothing was changed.'); end if;
  -- The identity the list was read for, as well as the flags: a rematch refuses a stale request.
  if (to_jsonb(r) -> 'show_id') is distinct from (p_expected -> 'show_id') or to_jsonb(v_show_tmdb) is distinct from (p_expected -> 'show_tmdb_id')
     or (to_jsonb(r) -> 'tmdb_id') is distinct from (p_expected -> 'tmdb_id') or (to_jsonb(r) -> 'season_number') is distinct from (p_expected -> 'season_number')
     or (to_jsonb(r) -> 'watched') is distinct from (p_expected -> 'watched') or (to_jsonb(r) -> 'skipped') is distinct from (p_expected -> 'skipped') then
    perform private.b45_changed();
  end if;
  if r.show_id is null or r.media_type is distinct from 'tv' or r.tmdb_id is null or r.season_number is null then
    perform private.lib_refuse('season_unmatched', 'Only a season matched to TMDB has episode marks. Nothing was changed.');
  end if;
  if not r.watched then perform private.lib_refuse('season_not_watched', 'This season isn''t marked watched, so nothing was changed.'); end if;
  if r.skipped then perform private.lib_refuse('season_locked', 'This season is skipped, so its episodes can''t be changed. Nothing was changed.'); end if;
  perform private.lib_write_on();
  insert into public.episode_marks (season_id, tmdb_episode_id, episode_number)
  select r.id, (e ->> 'tmdb_episode_id')::integer, (e ->> 'episode_number')::integer from jsonb_array_elements(p_episodes) e
  on conflict (season_id, tmdb_episode_id) do nothing;
  return jsonb_build_object('season_id', r.id, 'watched', r.watched, 'skipped', r.skipped,
    'marks', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'tmdb_episode_id', m.tmdb_episode_id, 'episode_number', m.episode_number)
                                         order by m.episode_number, m.tmdb_episode_id)
                       from public.episode_marks m where m.season_id = r.id), '[]'::jsonb));
end $$;

-- ── 3. Grants: members only (M1's rule: nothing for anon or PUBLIC) ─────────────
revoke all on function public.library_cu_sync_show_network(uuid, jsonb, jsonb), public.library_add_watched_season_marks(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.library_cu_sync_show_network(uuid, jsonb, jsonb), public.library_add_watched_season_marks(uuid, jsonb, jsonb) to authenticated;

-- ── 4. The run record, then verify before commit ───────────────────────────────
insert into private.migration_runs (run_id, migration) select run_id, 'cu1d' from cu1d_ctx;
do $$
declare f regprocedure; c record;
begin
  select * into c from cu1d_ctx;
  foreach f in array array['public.library_cu_sync_show_network(uuid, jsonb, jsonb)'::regprocedure, 'public.library_add_watched_season_marks(uuid, jsonb, jsonb)'::regprocedure] loop
    if has_function_privilege('anon', f, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = f and a.grantee = 0) then
      raise exception 'cu1d: % is executable by anon or PUBLIC', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception 'cu1d: members can''t execute %', f; end if;
    if (select prosecdef from pg_proc where oid = f) then raise exception 'cu1d: % must not be SECURITY DEFINER', f; end if;
  end loop;
  if (select md5(string_agg(md5(s::text), ',' order by s.id)) from public.tv_shows s) is distinct from c.shows_before
     or (select md5(string_agg(md5(w::text), ',' order by w.id)) from public.watchlist_items w) is distinct from c.rows_before
     or (select coalesce(md5(string_agg(md5(m::text), ',' order by m.id)), '') from public.episode_marks m) is distinct from c.marks_before
     or (select coalesce(md5(string_agg(md5(h::text), ',' order by h.id)), '') from public.update_holds h) is distinct from c.holds_before then
    raise exception 'cu1d: a show, season, mark or hold changed';
  end if;
  if (select md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), ',' order by p.oid::regprocedure::text)) from pg_proc p
      where p.oid in (to_regprocedure('public.stage5_capabilities()'), to_regprocedure('public.library_set_episode_marks(uuid, jsonb, boolean, jsonb)'),
        to_regprocedure('public.library_create_show_b45(jsonb, jsonb)'), to_regprocedure('public.library_set_metadata_b45(text, uuid, jsonb, jsonb)'))) is distinct from c.funcs_before then
    raise exception 'cu1d: the capability, the episode lock, show creation or the Details save changed';
  end if;
  if not exists (select 1 from private.migration_runs r where r.run_id = c.run_id and r.migration = 'cu1d') then
    raise exception 'cu1d: the run record does not hold this run';
  end if;
  if has_table_privilege('authenticated', 'private.migration_runs', 'select') or has_table_privilege('anon', 'private.migration_runs', 'select') then
    raise exception 'cu1d: private.migration_runs is readable by an application role';
  end if;
end $$;

select 'CU1D|' || (select run_id from cu1d_ctx) as result;
commit;
