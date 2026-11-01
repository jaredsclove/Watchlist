-- CU1e: a TMDB-listed season that's missing comes back on every Refresh shows, not only the first time (item 10, after
-- CU1, CU1b, CU1c, CU1d and CU2). One transaction, run as postgres on a contracted-cu1 database. Design:
-- docs/ITEM4_DESIGN.md §4.1.
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.cu1e_run', '<a fresh run id, recorded before running>', false);
--
-- private.cu1_finding_take: a season's finding is keyed by show, TMDB id and season number, so a season added, deleted
-- and listed again meets its own `applied` finding, and the call answered not_pending with the season gone. Now an
-- applied TMDB new_season finding whose season is missing is reopened (pending, no reason, no decision or result), and
-- the same call decides it under every current rule. Nothing else changes:
--   the season exists (Skipped included, or a stored row with that number): the finding stays applied, no duplicate;
--   Dismissed and Not now are the owner's decisions: they keep their status;
--   a Skipped show, a hold, a stale write or a research finding behaves as before, in library_cu_reconcile_season.
-- Lock order stays finding, then show, as in that function; delete_tv_season takes the show and no finding, so neither
-- waits on the other in a cycle. The check runs after the show lock, so a delete in flight is seen once it commits.
--
-- No backfill: a finding corrects itself the next time Refresh shows sends it, and Refresh sends only seasons missing
-- from the library. No table, column, grant, capability, phase or backup-format change; an older page gets the same rule.
--
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate execution).
-- Never rerun to find out; a rerun is refused once this committed. No rollback (fix-forward); db/test/cu1e_reverse.sql is
-- for test environments only.
begin;
select set_config('application_name', 'watchlist-cu1e-' || coalesce(nullif(current_setting('watchlist.cu1e_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;
lock table public.update_findings, public.tv_shows, public.watchlist_items in share row exclusive mode;

-- ── 1. Preconditions and the before-state ─────────────────────────────────────
create temp table cu1e_ctx on commit drop as
select nullif(current_setting('watchlist.cu1e_run', true), '') as run_id,
  (select md5(string_agg(md5(s::text), ',' order by s.id)) from public.tv_shows s) as shows_before,
  (select md5(string_agg(md5(w::text), ',' order by w.id)) from public.watchlist_items w) as rows_before,
  (select coalesce(md5(string_agg(md5(f::text), ',' order by f.id)), '') from public.update_findings f) as findings_before;
do $$
declare c record; m text;
begin
  select * into c from cu1e_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'cu1e: set watchlist.cu1e_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if (select prosrc from pg_proc where oid = 'private.cu1_finding_take(uuid, jsonb, text[])'::regprocedure) like '%A TMDB season applied earlier%' then
    raise exception 'cu1e: already installed; nothing was changed';
  end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'cu1e: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-cu1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '7' then
    raise exception 'cu1e: expected phase contracted-cu1 with backup format 7; nothing was changed';
  end if;
  foreach m in array array['cu1', 'cu1b', 'cu1c', 'cu1d', 'cu2'] loop
    if not exists (select 1 from private.migration_runs where migration = m) then raise exception 'cu1e: % has no run record; nothing was changed', m; end if;
  end loop;
end $$;

-- ── 2. The function ────────────────────────────────────────────────────────────
create or replace function private.cu1_finding_take(p_owner uuid, p_finding jsonb, p_kinds text[]) returns public.update_findings
language plpgsql set search_path = '' as $$
declare f public.update_findings; v_id uuid;
begin
  if jsonb_typeof(p_finding) is distinct from 'object' then raise exception 'invalid_input: finding' using errcode = '22023'; end if;
  if p_finding ? 'id' then
    begin v_id := (p_finding ->> 'id')::uuid; exception when others then raise exception 'invalid_input: finding id' using errcode = '22023'; end;
    select * into f from public.update_findings where id = v_id and user_id = p_owner for update;
    if f.id is null then perform private.lib_refuse('target_missing', 'This finding is no longer saved, so nothing was changed. Check again.'); end if;
  else
    if p_finding ->> 'source' is distinct from 'tmdb' or coalesce(p_finding ->> 'fingerprint', '') !~ '^[a-z_]+:[0-9a-f]{64}$'
       or not ((p_finding ->> 'kind') = any(p_kinds))
       or jsonb_typeof(coalesce(p_finding -> 'subject', '{}')) <> 'object' or jsonb_typeof(coalesce(p_finding -> 'proposed', '{}')) <> 'object'
       or jsonb_typeof(coalesce(p_finding -> 'expected', '{}')) <> 'object' then
      raise exception 'invalid_input: TMDB finding' using errcode = '22023';
    end if;
    begin
      insert into public.update_findings (fingerprint, source, kind, status, show_id, item_id, season_id, subject, proposed, expected)
      values (p_finding ->> 'fingerprint', 'tmdb', p_finding ->> 'kind', 'pending', (p_finding ->> 'show_id')::uuid, (p_finding ->> 'item_id')::uuid,
        (p_finding ->> 'season_id')::uuid, coalesce(p_finding -> 'subject', '{}'), coalesce(p_finding -> 'proposed', '{}'), coalesce(p_finding -> 'expected', '{}'))
      on conflict (user_id, fingerprint) do nothing;
    exception when invalid_text_representation then raise exception 'invalid_input: TMDB finding ids' using errcode = '22023';
    end;
    select * into f from public.update_findings where user_id = p_owner and fingerprint = p_finding ->> 'fingerprint' for update;
    -- A TMDB finding a policy outcome parked (needs_evidence, set_aside) and the owner hasn't decided is
    -- checked again with what TMDB says now (a later date and episodes, a show no longer Skipped);
    -- owner decisions (Not now, Dismiss) and final outcomes stand.
    if f.source = 'tmdb' and f.status in ('needs_evidence', 'set_aside') and f.decided_at is null then
      update public.update_findings set status = 'pending', reason = '', subject = coalesce(p_finding -> 'subject', subject),
        proposed = coalesce(p_finding -> 'proposed', proposed), expected = coalesce(p_finding -> 'expected', expected), last_seen_at = now()
      where id = f.id returning * into f;
    end if;
  end if;
  -- A TMDB season applied earlier and now missing: this call is a fresh check, not a repeat. Deleting a season is
  -- no decision about it: only an explicit one (Skip, a hold, Dismiss, Not now) keeps it out, and those keep their
  -- status here. The show lock comes before the look at its seasons, so a delete in flight is waited for, not missed.
  if f.source = 'tmdb' and f.kind = 'new_season' and f.status = 'applied' and f.show_id is not null and coalesce(f.subject ->> 'season_number', '') ~ '^[0-9]{1,4}$' then
    perform 1 from public.tv_shows where id = f.show_id and user_id = p_owner for update;
    if not exists (select 1 from public.watchlist_items w where w.user_id = p_owner and w.show_id = f.show_id and w.season_number = (f.subject ->> 'season_number')::integer) then
      update public.update_findings set status = 'pending', reason = '', result = null, decided_at = null, applied_at = null, last_seen_at = now()
      where id = f.id returning * into f;
    end if;
  end if;
  if not (f.kind = any(p_kinds)) then raise exception 'invalid_input: a % finding can''t be applied here', f.kind using errcode = '22023'; end if;
  return f;
end $$;

-- ── 3. The run record ──────────────────────────────────────────────────────────
insert into private.migration_runs (run_id, migration) select run_id, 'cu1e' from cu1e_ctx;

-- ── 4. Verify before commit ────────────────────────────────────────────────────
do $$
declare c record; v_owner uuid; v_tmdb integer; v_show uuid; v_row uuid; v_out jsonb; v_exp jsonb; v_f jsonb; v_s jsonb; n int;
begin
  select * into c from cu1e_ctx;
  if not (select prosecdef is false from pg_proc where oid = 'private.cu1_finding_take(uuid, jsonb, text[])'::regprocedure)
     or has_function_privilege('anon', 'private.cu1_finding_take(uuid, jsonb, text[])', 'execute')
     or not has_function_privilege('authenticated', 'private.cu1_finding_take(uuid, jsonb, text[])', 'execute') then
    raise exception 'cu1e: the function''s security or grants changed';
  end if;
  -- Synthetic checks for the first member (always rolled back): a season deleted twice comes back twice, a season
  -- that exists isn't duplicated.
  select m.user_id into v_owner from private.library_members m order by m.user_id limit 1;
  if v_owner is not null then
    select min(x) into v_tmdb from generate_series(2147460000, 2147460999) x where not exists (select 1 from public.tv_shows s where s.user_id = v_owner and s.tmdb_id = x);
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    begin
      v_out := public.library_create_show_b45(
        jsonb_build_object('tmdb_id', v_tmdb, 'title', 'ZZ CU1e Migration Check', 'show_key', 'zz cu1e migration check', 'network', 'ZZ'),
        jsonb_build_array(jsonb_build_object('item_key', 'zz cu1e migration check|season 1', 'title', 'ZZ CU1e Migration Check', 'season', 'Season 1', 'theme', 'ZZ', 'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01', 'season_number', 1),
          jsonb_build_object('item_key', 'zz cu1e migration check|season 2', 'title', 'ZZ CU1e Migration Check', 'season', 'Season 2', 'theme', 'ZZ', 'display_date', 'Jan 1, 2021', 'date_sort', '2021-01-01', 'season_number', 2)));
      v_show := (v_out -> 'show' ->> 'id')::uuid;
      v_exp := jsonb_build_object('tmdb_id', v_tmdb, 'show_key', 'zz cu1e migration check');
      v_s := '{"season_number": 2, "display_date": "Jan 1, 2021", "date_sort": "2021-01-01", "episode_count": 8}';
      v_f := jsonb_build_object('source', 'tmdb', 'kind', 'new_season', 'fingerprint', 'new_season:' || repeat('e', 64), 'show_id', v_show, 'subject', '{"season_number": 2}'::jsonb);
      foreach n in array array[1, 2] loop
        select id into v_row from public.watchlist_items where show_id = v_show and season_number = 2;
        perform public.delete_tv_season(v_row, 0);
        v_out := public.library_cu_reconcile_season(v_show, v_exp, v_s, v_f);
        if v_out ->> 'outcome' <> 'applied' or v_out -> 'result' ->> 'outcome' <> 'created' then raise exception 'cu1e-check: deletion % did not come back: %', n, v_out; end if;
      end loop;
      v_out := public.library_cu_reconcile_season(v_show, v_exp, v_s, v_f);
      if v_out ->> 'outcome' <> 'not_pending' or (select count(*) from public.watchlist_items where show_id = v_show and season_number = 2) <> 1 then
        raise exception 'cu1e-check: an existing season was not left alone: %', v_out;
      end if;
      raise exception 'cu1e-rollback';
    exception when raise_exception then
      if sqlerrm <> 'cu1e-rollback' then raise; end if;
    end;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
  end if;
  if (select md5(string_agg(md5(s::text), ',' order by s.id)) from public.tv_shows s) is distinct from c.shows_before
     or (select md5(string_agg(md5(w::text), ',' order by w.id)) from public.watchlist_items w) is distinct from c.rows_before
     or (select coalesce(md5(string_agg(md5(f::text), ',' order by f.id)), '') from public.update_findings f) is distinct from c.findings_before then
    raise exception 'cu1e: library or findings content changed';
  end if;
end $$;

select 'CU1E|' || json_build_object('run', (select run_id from cu1e_ctx)) as result;

notify pgrst, 'reload schema';
commit;
