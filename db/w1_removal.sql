-- W1 removal: the owner's decision (2026-11-01) to take W1 out of the active system. One transaction, run as postgres on a database
-- with W1 installed. Preamble, in the same run and before this file:
--   select set_config('watchlist.w1_removal_run', '<a fresh run id, recorded before running>', false);
--
-- db/w1_write_scope.sql stays as history, and its run record stays. This puts the write authorization back as it was: lib_write_on
-- sets the transaction-local watchlist.library_write, and the guards read it. It removes the xmloption clause from W1's 38 functions,
-- restores the three functions W1 replaced, word for word, and drops private.lib_authorized. No function body changes otherwise, so
-- everything since W1 stays, and no library row is written. A library function already waiting on lib_write_on's lock when this commits
-- fails once with library_write_required, and nothing of it is kept.
--
-- GraphQL stays disabled as a standing decision, so this refuses if pg_graphql is installed: the flag lasts for the transaction, and
-- one GraphQL request could chain a library function with a direct write on the caller's own rows. Account isolation and CU2's research
-- guard don't read the flag or the setting.
--
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate execution). Never rerun to
-- find out; a rerun is refused once this committed. Fix-forward: there's no script to put W1 back.
begin;
select set_config('application_name', 'watchlist-w1-removal-' || coalesce(nullif(current_setting('watchlist.w1_removal_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;
lock table public.tv_shows, public.watchlist_items in share row exclusive mode;

-- ── 1. Preconditions and the before-state ─────────────────────────────────────
create temp table w1r_ctx on commit drop as
select nullif(current_setting('watchlist.w1_removal_run', true), '') as run_id,
  (select md5(string_agg(md5(s::text), ',' order by s.id)) from public.tv_shows s) as shows_before,
  (select md5(string_agg(md5(w::text), ',' order by w.id)) from public.watchlist_items w) as rows_before;
create temp table w1r_expected on commit drop as
select to_regprocedure(sig) as fn, sig from unnest(array[
  'public.delete_tv_season(uuid, integer)',
  'public.library_add_films_b45(jsonb)',
  'public.library_add_seasons_b45(uuid, jsonb, jsonb)',
  'public.library_add_watched_season_marks(uuid, jsonb, jsonb)',
  'public.library_create_film_b45(jsonb)',
  'public.library_create_show_b45(jsonb, jsonb)',
  'public.library_cu_accept_finding(uuid, jsonb)',
  'public.library_cu_add_alias(uuid, uuid, text, jsonb)',
  'public.library_cu_attach_identity(uuid, jsonb, integer, jsonb, jsonb, boolean)',
  'public.library_cu_delete_hold(uuid, text)',
  'public.library_cu_import_setup(jsonb)',
  'public.library_cu_note_finding(jsonb, text)',
  'public.library_cu_reconcile_season(uuid, jsonb, jsonb, jsonb, boolean, uuid)',
  'public.library_cu_record_findings(uuid, text, jsonb)',
  'public.library_cu_register_brief(uuid, jsonb, jsonb)',
  'public.library_cu_save_definition(uuid, integer, text, jsonb, jsonb, text)',
  'public.library_cu_save_hold(jsonb)',
  'public.library_cu_set_exclusion(uuid, text, jsonb)',
  'public.library_cu_set_finding_status(uuid, text, text, text, jsonb)',
  'public.library_cu_set_season_date(uuid, jsonb, jsonb, jsonb, boolean)',
  'public.library_cu_set_show_settings(uuid, jsonb, boolean, boolean)',
  'public.library_cu_sync_show_network(uuid, jsonb, jsonb)',
  'public.library_cu_update_hold(uuid, jsonb, jsonb)',
  'public.library_dismiss_catalog_new_b45(jsonb)',
  'public.library_dismiss_review_b45(text, uuid, jsonb)',
  'public.library_match_film_b45(uuid, jsonb, jsonb, text, text)',
  'public.library_match_season_b45(uuid, jsonb, jsonb, jsonb, text)',
  'public.library_set_episode_marks(uuid, jsonb, boolean, jsonb)',
  'public.library_set_film_state_b45(uuid, jsonb, jsonb)',
  'public.library_set_metadata_b45(text, uuid, jsonb, jsonb)',
  'public.library_set_resume_b45(uuid, jsonb, uuid, uuid, boolean)',
  'public.library_set_show_state_b45(uuid, jsonb, jsonb)',
  'public.org_add_membership(uuid, uuid, uuid)',
  'public.org_remove_membership(uuid, uuid, uuid, uuid)',
  'public.restore_backup(jsonb, boolean)',
  'private.tv_enrich_season(uuid, uuid, text, integer, uuid, text, integer, boolean)',
  'private.tv_enrich_show(uuid, text, integer, jsonb, boolean)',
  'private.tv_enrich_show_partial(uuid, uuid, text, integer, jsonb, jsonb, boolean)'
]) sig;
do $$
declare c record; v_bad text;
begin
  select * into c from w1r_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'w1 removal: set watchlist.w1_removal_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if exists (select 1 from private.migration_runs where migration = 'w1_removal') then raise exception 'w1 removal: already installed; nothing was changed'; end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'w1 removal: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
  if not exists (select 1 from private.migration_runs where migration = 'w1') or to_regprocedure('private.lib_authorized()') is null then raise exception 'w1 removal: W1 isn''t installed; nothing was changed'; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-cu1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '7' then
    raise exception 'w1 removal: expected phase contracted-cu1 with backup format 7; nothing was changed';
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_graphql') then raise exception 'w1 removal: pg_graphql is installed, and GraphQL stays disabled; nothing was changed'; end if;
  if exists (select 1 from pg_db_role_setting s, unnest(s.setconfig) x where lower(x) like 'xmloption=%' or lower(x) like 'watchlist.w1_reset_ok=%') then
    raise exception 'w1 removal: a configured default is in place; nothing was changed';
  end if;
  select string_agg(e.sig, ', ') into v_bad from w1r_expected e left join pg_proc p on p.oid = e.fn where p.oid is null or not coalesce(p.proconfig @> array['xmloption=document'], false);
  if v_bad is not null then raise exception 'w1 removal: expected the clause on: %; nothing was changed', v_bad; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p, unnest(p.proconfig) x where lower(x) like 'xmloption=%' and p.oid not in (select fn from w1r_expected);
  if v_bad is not null then raise exception 'w1 removal: the clause is on a function outside the set: %; nothing was changed', v_bad; end if;
  if (select count(*) from pg_proc where oid in ('private.lib_write_on()'::regprocedure, 'private.library_write_guard()'::regprocedure, 'private.b45_show_guard()'::regprocedure) and prosrc like '%lib_authorized%') <> 3 then
    raise exception 'w1 removal: the guards aren''t W1''s; nothing was changed';
  end if;
end $$;

-- ── 2. The clauses, then the functions W1 replaced ────────────────────────────
do $$
declare f regprocedure;
begin
  for f in select fn from w1r_expected loop
    execute format('alter function %s reset xmloption', f);
  end loop;
end $$;
create or replace function private.lib_write_on() returns void
language plpgsql set search_path = '' as $$
begin
  lock table public.tv_shows, public.watchlist_items in row exclusive mode;
  perform set_config('watchlist.library_write', 'on', true);
end $$;
create or replace function private.library_write_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('watchlist.library_write', true), '') <> 'on' then
    raise exception 'library_write_required: This change is made only through the app''s library functions. Reload the page. Nothing was changed.'
      using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create or replace function private.b45_show_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('watchlist.library_write', true), '') = 'on' then return new; end if;
  if coalesce(current_setting('watchlist.resume_cleanup', true), '') = 'on'
     and new.resume_start_season_id is null and new.resume_end_season_id is null
     and (to_jsonb(new) - 'resume_start_season_id' - 'resume_end_season_id') = (to_jsonb(old) - 'resume_start_season_id' - 'resume_end_season_id') then
    return new;
  end if;
  raise exception 'library_write_required: This change is made only through the app''s library functions. Reload the page. Nothing was changed.'
    using errcode = 'P0001';
end $$;
drop function private.lib_authorized();

-- ── 3. The run record ─────────────────────────────────────────────────────────
insert into private.migration_runs (run_id, migration) select run_id, 'w1_removal' from w1r_ctx;

-- ── 4. Verify before commit ───────────────────────────────────────────────────
do $$
declare c record; v_owner uuid; v_tmdb integer; v_show uuid; v_row uuid; v_out jsonb; v_bad text;
begin
  select * into c from w1r_ctx;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p
  where exists (select 1 from unnest(p.proconfig) x where lower(x) like 'xmloption=%')
     or (p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and (coalesce(p.prosrc, '') || coalesce(pg_get_function_sqlbody(p.oid), '')) ~* 'xml\s*_?option|lib_authorized|w1_reset_ok');
  if v_bad is not null then raise exception 'w1 removal: something still names W1: %', v_bad; end if;
  if to_regprocedure('private.lib_authorized()') is not null then raise exception 'w1 removal: the helper is still there'; end if;
  -- Synthetic checks for the first member (always rolled back): a direct write is refused, a library function writes and deletes. The
  -- flag lasts for a transaction, so the refusal comes first; a rolled-back subtransaction takes the flag with it.
  select m.user_id into v_owner from private.library_members m order by m.user_id limit 1;
  if v_owner is not null then
    select min(x) into v_tmdb from generate_series(2147470000, 2147470999) x where not exists (select 1 from public.tv_shows s where s.user_id = v_owner and s.tmdb_id = x);
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    begin
      begin
        insert into public.tv_shows (title, show_key) values ('ZZ W1 Removal Direct', 'zz w1 removal direct');
        raise exception 'w1r-check: a direct write succeeded';
      exception when raise_exception then
        if sqlerrm !~ '^library_write_required: ' then raise; end if;
      end;
      v_out := public.library_create_show_b45(
        jsonb_build_object('tmdb_id', v_tmdb, 'title', 'ZZ W1 Removal Check', 'show_key', 'zz w1 removal check', 'network', 'ZZ'),
        jsonb_build_array(jsonb_build_object('item_key', 'zz w1 removal check|season 1', 'title', 'ZZ W1 Removal Check', 'season', 'Season 1', 'theme', 'ZZ', 'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01', 'season_number', 1)));
      v_show := (v_out -> 'show' ->> 'id')::uuid;
      select id into v_row from public.watchlist_items where show_id = v_show;
      v_out := public.delete_tv_season(v_row, 0);
      if (v_out ->> 'show_deleted') <> 'true' then raise exception 'w1r-check: a library delete did not run: %', v_out; end if;
      raise exception 'w1r-rollback';
    exception when raise_exception then
      if sqlerrm <> 'w1r-rollback' then raise; end if;
    end;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
  end if;
  if (select md5(string_agg(md5(s::text), ',' order by s.id)) from public.tv_shows s) is distinct from c.shows_before
     or (select md5(string_agg(md5(w::text), ',' order by w.id)) from public.watchlist_items w) is distinct from c.rows_before then
    raise exception 'w1 removal: library content changed';
  end if;
end $$;

select 'W1-REMOVED|' || json_build_object('run', (select run_id from w1r_ctx), 'functions', (select count(*) from w1r_expected)) as result;

notify pgrst, 'reload schema';
commit;
