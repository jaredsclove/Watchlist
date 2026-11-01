-- W1: library writes are authorized by the function's own scope (item 9, after CU1, CU1b, CU1c, CU1d and CU2;
-- independent of CU1e). One transaction, run as postgres on a contracted-cu1 database.
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.w1_run', '<a fresh run id, recorded before running>', false);
--
-- Until now the guards read watchlist.library_write, which lib_write_on set for the rest of the transaction. One request
-- is one transaction, and a request that holds several statements (chained GraphQL mutations, where pg_graphql is on) ran
-- a direct write after a library function had left the flag on. Now the permission lasts as long as the function: each
-- library function carries the clause `set xmloption = 'document'`, which PostgreSQL restores when the function ends,
-- normally or by an error. xmloption stands in because Supabase's postgres can't put a clause on a placeholder setting,
-- and nothing in this project uses XML.
--
-- The guards read the setting through private.lib_authorized, which also requires that nothing configures it as a
-- default: a value in pg_db_role_setting (PostgREST applies a role's settings to each request's transaction) or a
-- reset_val other than content (the server's or the connection's). A default there would make every write look like
-- a library function's. A poisoned default refuses every write, under its own library_write_misconfigured error.
-- Removing one needs PostgREST reloaded or restarted in the same step: a connection keeps its starting reset_val, which
-- fails closed, but PostgREST also caches a role's settings, and until it reloads, a role default it still applies is
-- no longer in the catalog, so direct writes pass.
--
-- What the guard can't see is a session-level SET inside a function: a pooled connection keeps it for later requests,
-- and it looks exactly like the clause. No function may do that (db/README.md, write scope), and this file refuses
-- if an application role can execute a function whose source names the setting.
--
-- org_add_membership and org_remove_membership still set watchlist.library_write: nothing reads it now.
-- Any later `create or replace` of a function in the set drops its clause, so it must set it again;
-- db/test/w1_catalog_check.sql checks both rules after such a migration.
-- A direct write by service_role is refused with a permission error (it has no usage on private), not the guard's.
-- A library function already waiting on lib_write_on's lock when this commits fails once with library_write_required.
--
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate execution).
-- Never rerun to find out; a rerun is refused once this committed. No rollback (fix-forward); db/test/w1_reverse.sql is
-- for test environments only.
begin;
select set_config('application_name', 'watchlist-w1-' || coalesce(nullif(current_setting('watchlist.w1_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;
lock table public.tv_shows, public.watchlist_items in share row exclusive mode;

-- ── 1. Preconditions and the before-state ─────────────────────────────────────
create temp table w1_ctx on commit drop as
select nullif(current_setting('watchlist.w1_run', true), '') as run_id,
  (select md5(string_agg(md5(s::text), ',' order by s.id)) from public.tv_shows s) as shows_before,
  (select md5(string_agg(md5(w::text), ',' order by w.id)) from public.watchlist_items w) as rows_before;
-- The set, by name: the catalog must agree with it before anything changes.
create temp table w1_expected on commit drop as
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
declare c record; m text; v_miss text; v_extra text;
begin
  select * into c from w1_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'w1: set watchlist.w1_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if to_regprocedure('private.lib_authorized()') is not null then raise exception 'w1: already installed; nothing was changed'; end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'w1: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-cu1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '7' then
    raise exception 'w1: expected phase contracted-cu1 with backup format 7; nothing was changed';
  end if;
  foreach m in array array['cu1', 'cu1b', 'cu1c', 'cu1d', 'cu2'] loop
    if not exists (select 1 from private.migration_runs where migration = m) then raise exception 'w1: % has no run record; nothing was changed', m; end if;
  end loop;
  select string_agg(sig, ', ') into v_miss from w1_expected where fn is null;
  if v_miss is not null then raise exception 'w1: missing functions: %; nothing was changed', v_miss; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_extra from pg_proc p
  where p.pronamespace = 'public'::regnamespace and (p.prosrc like '%lib_write_on%' or p.prosrc like '%watchlist.library_write%')
    and p.oid not in (select fn from w1_expected);
  if v_extra is not null then raise exception 'w1: library functions the set doesn''t name: %; nothing was changed', v_extra; end if;
  if exists (select 1 from pg_proc p, unnest(p.proconfig) x where lower(x) like 'xmloption=%') then raise exception 'w1: a function already sets xmloption; nothing was changed'; end if;
  if exists (select 1 from pg_db_role_setting s, unnest(s.setconfig) x where lower(x) like 'xmloption=%') then raise exception 'w1: xmloption is configured for a database or role; nothing was changed'; end if;
  if current_setting('xmloption') <> 'content' or (select reset_val from pg_settings where name = 'xmloption') <> 'content' then
    raise exception 'w1: xmloption isn''t content in this session; nothing was changed';
  end if;
  if exists (select 1 from pg_proc p where p.prosrc ~* 'xml\s*_?option') then raise exception 'w1: a function''s source names xmloption; nothing was changed'; end if;
end $$;

-- ── 2. The guards, lib_write_on and the clause ────────────────────────────────
-- w1-core-begin
create or replace function private.lib_authorized() returns boolean
language plpgsql stable set search_path = '' as $$
begin
  if current_setting('xmloption') <> 'document' then return false; end if;
  if (select reset_val from pg_catalog.pg_settings where name = 'xmloption') <> 'content'
     or exists (select 1 from pg_catalog.pg_db_role_setting s, unnest(s.setconfig) c where lower(c) like 'xmloption=%') then
    raise exception 'library_write_misconfigured: xmloption is configured as a default on this database, so a library function can''t be told from a direct write. Nothing was changed.'
      using errcode = 'P0001';
  end if;
  return true;
end $$;
revoke all on function private.lib_authorized() from public, anon, service_role;
grant execute on function private.lib_authorized() to authenticated;

create or replace function private.lib_write_on() returns void
language plpgsql set search_path = '' as $$
begin
  if not private.lib_authorized() then
    raise exception 'library_write_scope: lib_write_on was called outside a library function: the calling function needs set xmloption = document. Nothing was changed.'
      using errcode = 'P0001';
  end if;
  lock table public.tv_shows, public.watchlist_items in row exclusive mode;
end $$;

create or replace function private.library_write_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not private.lib_authorized() then
    raise exception 'library_write_required: This change is made only through the app''s library functions. Reload the page. Nothing was changed.'
      using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create or replace function private.b45_show_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if private.lib_authorized() then return new; end if;
  if coalesce(current_setting('watchlist.resume_cleanup', true), '') = 'on'
     and new.resume_start_season_id is null and new.resume_end_season_id is null
     and (to_jsonb(new) - 'resume_start_season_id' - 'resume_end_season_id') = (to_jsonb(old) - 'resume_start_season_id' - 'resume_end_season_id') then
    return new;
  end if;
  raise exception 'library_write_required: This change is made only through the app''s library functions. Reload the page. Nothing was changed.'
    using errcode = 'P0001';
end $$;

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
    where (p.pronamespace = 'public'::regnamespace and (p.prosrc like '%lib_write_on%' or p.prosrc like '%watchlist.library_write%' or p.proname = 'restore_backup'))
       or (p.pronamespace = 'private'::regnamespace and p.proname in ('tv_enrich_season', 'tv_enrich_show', 'tv_enrich_show_partial')) loop
    execute format('alter function %s set xmloption = %L', f, 'document');
  end loop;
end $$;
-- w1-core-end

-- ── 3. The run record ─────────────────────────────────────────────────────────
insert into private.migration_runs (run_id, migration) select run_id, 'w1' from w1_ctx;

-- ── 4. Verify before commit ───────────────────────────────────────────────────
do $$
declare c record; v_owner uuid; v_tmdb integer; v_show uuid; v_row uuid; v_out jsonb; v_bad text; n int;
begin
  select * into c from w1_ctx;
  select string_agg(e.sig, ', ') into v_bad from w1_expected e join pg_proc p on p.oid = e.fn
  where not (p.proconfig @> array['xmloption=document', 'search_path=""']) or p.prosecdef;
  if v_bad is not null then raise exception 'w1: the clause is missing from: %', v_bad; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p, unnest(p.proconfig) x
  where lower(x) like 'xmloption=%' and p.oid not in (select fn from w1_expected);
  if v_bad is not null then raise exception 'w1: the clause is on a function outside the set: %', v_bad; end if;
  -- Only lib_authorized reads the setting. Any other function an application role can execute could change it.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p
  where p.prosrc ~* 'xml\s*_?option' and p.oid <> 'private.lib_authorized()'::regprocedure and p.oid <> 'private.lib_write_on()'::regprocedure
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'));
  if v_bad is not null then raise exception 'w1: an application role can execute a function that names xmloption: %', v_bad; end if;
  if exists (select 1 from pg_db_role_setting s, unnest(s.setconfig) x where lower(x) like 'xmloption=%')
     or current_setting('xmloption') <> 'content' or (select reset_val from pg_settings where name = 'xmloption') <> 'content' then
    raise exception 'w1: xmloption isn''t content outside a function';
  end if;
  if has_schema_privilege('anon', 'public', 'create') or has_schema_privilege('authenticated', 'public', 'create')
     or has_schema_privilege('anon', 'private', 'create') or has_schema_privilege('authenticated', 'private', 'create') then
    raise exception 'w1: an application role can create functions';
  end if;
  if has_function_privilege('anon', 'private.lib_authorized()', 'execute') or not has_function_privilege('authenticated', 'private.lib_authorized()', 'execute')
     or (select prosecdef from pg_proc where oid = 'private.lib_authorized()'::regprocedure) then
    raise exception 'w1: lib_authorized''s security or grants changed';
  end if;
  -- Synthetic checks for the first member (always rolled back): a library function writes; the same write is refused
  -- directly, after the function returned and after one failed; the setting is back at its default each time.
  select m.user_id into v_owner from private.library_members m order by m.user_id limit 1;
  if v_owner is not null then
    select min(x) into v_tmdb from generate_series(2147470000, 2147470999) x where not exists (select 1 from public.tv_shows s where s.user_id = v_owner and s.tmdb_id = x);
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    begin
      v_out := public.library_create_show_b45(
        jsonb_build_object('tmdb_id', v_tmdb, 'title', 'ZZ W1 Migration Check', 'show_key', 'zz w1 migration check', 'network', 'ZZ'),
        jsonb_build_array(jsonb_build_object('item_key', 'zz w1 migration check|season 1', 'title', 'ZZ W1 Migration Check', 'season', 'Season 1', 'theme', 'ZZ', 'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01', 'season_number', 1)));
      v_show := (v_out -> 'show' ->> 'id')::uuid;
      select id into v_row from public.watchlist_items where show_id = v_show;
      if current_setting('xmloption') <> 'content' then raise exception 'w1-check: the setting outlived a function'; end if;
      begin
        update public.watchlist_items set season_number = 99 where id = v_row;
        raise exception 'w1-check: a direct write after a library function succeeded';
      exception when raise_exception then
        if sqlerrm !~ '^library_write_required: ' then raise; end if;
      end;
      begin
        perform public.delete_tv_season(v_row, 5);
        raise exception 'w1-check: a stale delete succeeded';
      exception when raise_exception then
        if sqlerrm !~ '^target_changed: ' then raise; end if;
      end;
      if current_setting('xmloption') <> 'content' then raise exception 'w1-check: the setting outlived a failed function'; end if;
      begin
        update public.tv_shows set tmdb_id = v_tmdb + 1 where id = v_show;
        raise exception 'w1-check: a direct write after a failed function succeeded';
      exception when raise_exception then
        if sqlerrm !~ '^library_write_required: ' then raise; end if;
      end;
      v_out := public.delete_tv_season(v_row, 0);
      if (v_out ->> 'show_deleted') <> 'true' then raise exception 'w1-check: a library delete did not run: %', v_out; end if;
      raise exception 'w1-rollback';
    exception when raise_exception then
      if sqlerrm <> 'w1-rollback' then raise; end if;
    end;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
  end if;
  if (select md5(string_agg(md5(s::text), ',' order by s.id)) from public.tv_shows s) is distinct from c.shows_before
     or (select md5(string_agg(md5(w::text), ',' order by w.id)) from public.watchlist_items w) is distinct from c.rows_before then
    raise exception 'w1: library content changed';
  end if;
end $$;

select 'W1|' || json_build_object('run', (select run_id from w1_ctx), 'functions', (select count(*) from w1_expected)) as result;

notify pgrst, 'reload schema';
commit;
