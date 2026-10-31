-- CU2: per-member research access (item 4, after CU1, CU1b, CU1c and CU1d). One transaction, run as postgres on a
-- contracted-cu1 database. Design: docs/ITEM4_DESIGN.md §4.6.
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.cu2_owner', '<the Auth user id of the member to enable>', false);
--   select set_config('watchlist.cu2_run', '<a fresh run id, recorded before running>', false);
-- The id stays in the preamble: it is never written to this file, the repository or the run record.
--
-- What it adds:
--   * private.library_members.research_enabled (default false): existing and future members are off; only the
--     preamble's member is switched on. No application role can reach the table, so a member can't change it.
--   * private.research_enabled(): the signed-in member's own effective permission (no parameter; false for
--     anyone who isn't a member now). Read on every research write, so a change applies on the next request.
--   * private.research_write_guard(), a BEFORE row trigger on the research tables: update_setup,
--     collection_definitions, collection_exclusions, update_holds, research_briefs, research_imports,
--     record_aliases, and update_findings rows whose stored or new source is research. It refuses
--     (research_not_enabled, the whole call rolled back) every write by a member without access, whatever the
--     path: function, REST, GraphQL. It restricts operations only: a member's own saved rows stay readable,
--     because the applying functions read holds as the caller and backups read every table.
--     Two exemptions, and no others:
--       restore   public.restore_backup, while it is running (watchlist.research_restore). Restoring saved data
--                 isn't a research operation. Only that wrapper sets the flag, transaction-local, and it clears
--                 it before returning; a failure discards it with the (sub)transaction.
--       cascade   a DELETE from update_holds or record_aliases whose parent show or item, by its id and the
--                 row's own user_id, no longer exists: the foreign keys allow that only inside the cascade of
--                 an ordinary delete of that record. A null reference is never a missing parent, and the guard
--                 is security definer so that a parent hidden by row security isn't one either.
--   * public.restore_backup becomes that wrapper; its body moves unchanged to private.restore_backup_v7.
--   * stage5_capabilities() gains research (true / false). Phase and backup format are unchanged, so an open
--     page keeps working; the database decides.
-- No library_cu_* function changes, and backups stay format 7: the permission isn't library data, and restore's
-- exact table and field lists refuse any file that tries to carry it.
--
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate
-- execution). Never rerun to find out; a rerun is refused once this committed. No rollback (fix-forward);
-- db/test/cu2_reverse.sql is for test environments only.
begin;
select set_config('application_name', 'watchlist-cu2-' || coalesce(nullif(current_setting('watchlist.cu2_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs, private.library_members in access exclusive mode;
lock table public.update_setup, public.collection_definitions, public.collection_exclusions, public.update_holds, public.research_briefs,
  public.research_imports, public.record_aliases, public.update_findings, public.membership_removals, public.show_update_settings,
  public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships in share row exclusive mode;

-- ── 1. Preconditions and the before-state ─────────────────────────────────────
create temp table cu2_ctx on commit drop as
select nullif(current_setting('watchlist.cu2_run', true), '') as run_id, nullif(current_setting('watchlist.cu2_owner', true), '') as owner_text;
create temp table cu2_guarded (table_name text primary key) on commit drop;
insert into cu2_guarded values ('update_setup'), ('collection_definitions'), ('collection_exclusions'), ('update_holds'), ('research_briefs'),
  ('research_imports'), ('record_aliases'), ('update_findings');
create or replace function pg_temp.cu2_fp(p_table text) returns text language plpgsql as $$
declare v text;
begin
  execute format('select md5(coalesce(string_agg(x, ''|'' order by x), '''')) from (select (to_jsonb(t) - ''research_enabled'')::text x from %s t) s', p_table) into v;
  return v;
end $$;
create temp table cu2_before on commit drop as
select t, pg_temp.cu2_fp(t) fp from unnest(array['private.library_members', 'public.tv_shows', 'public.watchlist_items', 'public.personal_collections',
  'public.collection_memberships', 'public.episode_marks', 'public.update_setup', 'public.collection_definitions', 'public.collection_exclusions',
  'public.update_holds', 'public.research_briefs', 'public.research_imports', 'public.record_aliases', 'public.update_findings',
  'public.membership_removals', 'public.show_update_settings']) t;
create temp table cu2_definers on commit drop as
select p.oid::regprocedure::text f from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef;

do $$
declare c record; m text;
begin
  select * into c from cu2_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'cu2: set watchlist.cu2_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if c.owner_text is null or c.owner_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'cu2: set watchlist.cu2_owner to the Auth user id of the member to enable first; nothing was changed';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'private' and table_name = 'library_members' and column_name = 'research_enabled')
     or to_regprocedure('private.restore_backup_v7(jsonb, boolean)') is not null then
    raise exception 'cu2: already installed; nothing was changed';
  end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'cu2: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-cu1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '7'
     or public.stage5_capabilities() ->> 'access' is distinct from 'members' then
    raise exception 'cu2: expected phase contracted-cu1, backup format 7 and access = members; nothing was changed';
  end if;
  foreach m in array array['cu1', 'cu1b', 'cu1c', 'cu1d'] loop
    if not exists (select 1 from private.migration_runs where migration = m) then raise exception 'cu2: % has no run record; nothing was changed', m; end if;
  end loop;
  if not exists (select 1 from private.library_members where user_id = c.owner_text::uuid) then
    raise exception 'cu2: the member to enable isn''t in private.library_members; nothing was changed';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'restore_backup') <> 1
     or to_regprocedure('public.restore_backup(jsonb, boolean)') is null
     or (select prosrc from pg_proc where oid = 'public.restore_backup(jsonb, boolean)'::regprocedure) !~ 'v_version is distinct from ''7''' then
    raise exception 'cu2: public.restore_backup is not the format-7 function; nothing was changed';
  end if;
  if exists (select 1 from pg_proc where pronamespace in ('public'::regnamespace, 'private'::regnamespace) and prosrc like '%watchlist.research_restore%') then
    raise exception 'cu2: a function already names the restore flag; nothing was changed';
  end if;
end $$;

-- ── 2. The permission ──────────────────────────────────────────────────────────
alter table private.library_members add column research_enabled boolean not null default false;
update private.library_members set research_enabled = true where user_id = (select owner_text::uuid from cu2_ctx);

-- The signed-in member's own permission, and only that: no parameter, false for a non-member or nobody signed in.
-- SECURITY DEFINER only so a member can read this one value from the closed table.
create function private.research_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select m.research_enabled from private.library_members m where m.user_id = auth.uid()), false)
$$;
revoke all on function private.research_enabled() from public, anon;
grant execute on function private.research_enabled() to authenticated;

-- ── 3. The guard ───────────────────────────────────────────────────────────────
-- SECURITY DEFINER so its lookup of a parent sees the row itself, not what row security shows the caller. It fires
-- beside library_write_guard, never instead of it: a write must pass both. No role needs EXECUTE on a trigger function.
create function private.research_write_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- TMDB findings aren't research. A change of source counts as research either way.
  if tg_table_name = 'update_findings' then
    if not ((tg_op <> 'INSERT' and old.source = 'research') or (tg_op <> 'DELETE' and new.source = 'research')) then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
  end if;
  if private.research_enabled() or current_setting('watchlist.research_restore', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- The cascade of an ordinary delete of a show or season. Only these two tables, only a delete, only a reference
  -- that isn't null, and only a parent gone by its full identity (the foreign keys are (id, user_id)). While a parent
  -- exists no delete of its child passes, so this can't be used to remove a hold or an alias.
  if tg_op = 'DELETE' and tg_table_name in ('update_holds', 'record_aliases') then
    if (old.show_id is not null and not exists (select 1 from public.tv_shows s where s.id = old.show_id and s.user_id = old.user_id))
       or (old.item_id is not null and not exists (select 1 from public.watchlist_items w where w.id = old.item_id and w.user_id = old.user_id)) then
      return old;
    end if;
  end if;
  raise exception 'research_not_enabled: Collection research isn''t enabled for this account, so nothing was changed.' using errcode = 'P0001';
end $$;
revoke all on function private.research_write_guard() from public, anon, authenticated;

do $$
declare t text;
begin
  for t in select table_name from cu2_guarded loop
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function private.research_write_guard()', t || '_research_guard', t);
  end loop;
end $$;

-- ── 4. Restore ─────────────────────────────────────────────────────────────────
-- The format-7 function, unchanged, now private; execute stays with authenticated because this wrapper runs as the
-- caller. Calling it any other way gains nothing: the flag lives here, so without this wrapper the guard refuses.
alter function public.restore_backup(jsonb, boolean) rename to restore_backup_v7;
alter function public.restore_backup_v7(jsonb, boolean) set schema private;
-- The flag is on only for the call below, transaction-local. There is deliberately no exception block: a failure
-- leaves this function, which undoes the setting with the transaction or the caller's savepoint.
create function public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean default false)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_out jsonb;
begin
  perform set_config('watchlist.research_restore', 'on', true);
  v_out := private.restore_backup_v7(p_backup, p_allow_v1_reset);
  perform set_config('watchlist.research_restore', '', true);
  return v_out;
end $$;
revoke all on function public.restore_backup(jsonb, boolean) from public, anon;
grant execute on function public.restore_backup(jsonb, boolean) to authenticated;

-- ── 5. The capability and the run record ───────────────────────────────────────
create or replace function public.stage5_capabilities() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted-cu1', 'backup_format', 7, 'b45', 1, 'ep1', 1, 'cu1', 1, 'access', 'members',
    'member', private.is_member(), 'research', private.research_enabled(),
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;
revoke execute on function public.stage5_capabilities() from public, anon;
grant execute on function public.stage5_capabilities() to authenticated;
insert into private.migration_runs (run_id, migration) select run_id, 'cu2' from cu2_ctx;

-- ── 6. Verify before commit ────────────────────────────────────────────────────
do $$
declare v_bad jsonb; v_owner uuid := (select owner_text::uuid from cu2_ctx); v_out jsonb; v_refused boolean := false;
begin
  -- (a) no row changed, and exactly the named member is on
  select jsonb_agg(b.t) into v_bad from cu2_before b where b.fp is distinct from pg_temp.cu2_fp(b.t);
  if v_bad is not null then raise exception 'cu2: content changed in %', v_bad; end if;
  if (select array_agg(user_id) from private.library_members where research_enabled) is distinct from array[v_owner] then
    raise exception 'cu2: research access isn''t on for exactly the named member';
  end if;

  -- (b) no application role can reach the permission
  if has_table_privilege('authenticated', 'private.library_members', 'select,insert,update,delete,truncate,references,trigger')
     or has_table_privilege('anon', 'private.library_members', 'select,insert,update,delete,truncate,references,trigger')
     or has_column_privilege('authenticated', 'private.library_members', 'research_enabled', 'select,insert,update,references')
     or has_column_privilege('anon', 'private.library_members', 'research_enabled', 'select,insert,update,references') then
    raise exception 'cu2: an application role can reach private.library_members';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.library_members'::regclass)
     or exists (select 1 from pg_policies where schemaname = 'private' and tablename = 'library_members') then
    raise exception 'cu2: private.library_members isn''t closed by row security';
  end if;
  if has_function_privilege('anon', 'private.research_enabled()', 'execute') or has_function_privilege('anon', 'private.research_write_guard()', 'execute')
     or has_function_privilege('authenticated', 'private.research_write_guard()', 'execute') or has_function_privilege('anon', 'public.restore_backup(jsonb, boolean)', 'execute')
     or has_function_privilege('anon', 'private.restore_backup_v7(jsonb, boolean)', 'execute') then
    raise exception 'cu2: a new function is executable by a role that shouldn''t have it';
  end if;
  if not has_function_privilege('authenticated', 'public.restore_backup(jsonb, boolean)', 'execute')
     or not has_function_privilege('authenticated', 'private.restore_backup_v7(jsonb, boolean)', 'execute')
     or not has_function_privilege('authenticated', 'private.research_enabled()', 'execute') then
    raise exception 'cu2: authenticated lost a function it needs';
  end if;
  -- Only the two new functions gained SECURITY DEFINER; nothing in the application schemas writes the column.
  select jsonb_agg(f) into v_bad from (
    (select p.oid::regprocedure::text f from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef)
    except (select f from cu2_definers union all select unnest(array['private.research_enabled()', 'private.research_write_guard()']))) z;
  if v_bad is not null then raise exception 'cu2: unexpected security definer functions %', v_bad; end if;
  if exists (select 1 from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
             and p.prosrc ~* '(update|insert into|delete from)\s+private\.library_members') then
    raise exception 'cu2: a function writes private.library_members';
  end if;

  -- (c) the flag: only the wrapper sets it and only the guard reads it
  if (select array_agg(p.oid::regprocedure order by p.oid) from pg_proc p
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosrc like '%watchlist.research_restore%')
     is distinct from (select array_agg(x order by x::oid) from unnest(array['private.research_write_guard()'::regprocedure, 'public.restore_backup(jsonb, boolean)'::regprocedure]) x) then
    raise exception 'cu2: the restore flag is named by an unexpected function';
  end if;
  if current_setting('watchlist.research_restore', true) = 'on' then raise exception 'cu2: the restore flag is on'; end if;

  -- (d) the triggers and the single restore signature
  select jsonb_agg(g.table_name) into v_bad from cu2_guarded g
  where not exists (select 1 from pg_trigger t where t.tgrelid = ('public.' || g.table_name)::regclass and t.tgname = g.table_name || '_research_guard'
                    and t.tgenabled = 'O' and t.tgfoid = 'private.research_write_guard()'::regprocedure);
  if v_bad is not null then raise exception 'cu2: the guard is missing on %', v_bad; end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'restore_backup') <> 1 then
    raise exception 'cu2: more than one restore_backup signature in public';
  end if;
  if (public.stage5_capabilities() ->> 'phase') is distinct from 'contracted-cu1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '7'
     or not public.stage5_capabilities() ? 'research' then
    raise exception 'cu2: capability not updated';
  end if;

  -- (e) synthetic checks for the named member (always rolled back): with access a hold saves; without it the same
  -- call is refused and a direct delete of the saved hold is refused.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    if (public.stage5_capabilities() ->> 'research')::boolean is not true then raise exception 'cu2-check: the named member reads research off'; end if;
    v_out := public.library_cu_save_hold('{"kind": "standing_decision", "subject_label": "ZZ CU2 Migration Check", "decision": "ZZ", "effect": "do_not_add", "reopen": {"on": "owner_only"}}');
    perform set_config('role', 'none', true);
    update private.library_members set research_enabled = false where user_id = v_owner;
    perform set_config('role', 'authenticated', true);
    if (public.stage5_capabilities() ->> 'research')::boolean is not false then raise exception 'cu2-check: research still reads on after it was switched off'; end if;
    begin
      perform public.library_cu_save_hold('{"kind": "standing_decision", "subject_label": "ZZ CU2 Migration Check 2", "decision": "ZZ", "effect": "do_not_add", "reopen": {"on": "owner_only"}}');
    exception when raise_exception then
      if sqlerrm !~ '^research_not_enabled: ' then raise; end if;
      v_refused := true;
    end;
    if not v_refused then raise exception 'cu2-check: a hold saved without access'; end if;
    v_refused := false;
    begin
      delete from public.update_holds where id = (v_out ->> 'id')::uuid;
    exception when raise_exception then
      if sqlerrm !~ '^research_not_enabled: ' then raise; end if;
      v_refused := true;
    end;
    if not v_refused then raise exception 'cu2-check: a hold was deleted without access'; end if;
    raise exception 'cu2-rollback';
  exception when raise_exception then
    if sqlerrm <> 'cu2-rollback' then raise; end if;
  end;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  -- (a) again, after the simulated writes
  select jsonb_agg(b.t) into v_bad from cu2_before b where b.fp is distinct from pg_temp.cu2_fp(b.t);
  if v_bad is not null then raise exception 'cu2: content changed in % (after the checks)', v_bad; end if;
  if (select array_agg(user_id) from private.library_members where research_enabled) is distinct from array[v_owner] then
    raise exception 'cu2: research access changed during the checks';
  end if;
end $$;

select 'CU2|' || json_build_object('run', (select run_id from cu2_ctx), 'members_enabled', (select count(*) from private.library_members where research_enabled)) as result;

notify pgrst, 'reload schema';
commit;
