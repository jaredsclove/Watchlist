-- CU1b: edit a collection-update hold in place (item 4, after CU1). One transaction, run as postgres on a
-- contracted-cu1 database. Design: docs/ITEM4_DESIGN.md §4.3.
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.cu1b_run', '<a fresh run id, recorded before running>', false);
--
-- public.library_cu_update_hold(p_id, p_expected, p_hold)
--   Locks the owner's hold p_id and refuses (target_changed, nothing written) unless every stored editable
--   value equals p_expected: kind, collection_id, show_id, item_id, subject_label, field, protected_value,
--   decision, effect, reopen, decided_on, each given (null as JSON null). Then sets those values from p_hold
--   (the keys library_cu_save_hold takes; a missing key becomes null), in place: the same id, owner and
--   created_at, so the hold keeps its identity and its order among holds. update_holds' own checks validate
--   the result exactly as for a new hold. Nothing else is read or written: no show, season, date, progress,
--   membership or other hold changes.
-- Adds nothing else: no table, column, trigger, policy, capability or backup-format change (backups stay
-- format 7; the page detects the function by calling it).
--
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate
-- execution). Never rerun to find out; a rerun is refused once this committed. No rollback (fix-forward);
-- db/test/cu1b_reverse.sql is for test environments only.
begin;
select set_config('application_name', 'watchlist-cu1b-' || coalesce(nullif(current_setting('watchlist.cu1b_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;
lock table public.update_holds in share row exclusive mode;

-- ── 1. Preconditions ───────────────────────────────────────────────────────────
create temp table cu1b_ctx on commit drop as
select nullif(current_setting('watchlist.cu1b_run', true), '') as run_id,
  (select md5(string_agg(md5(h::text), ',' order by h.id)) from public.update_holds h) as holds_before,
  (select count(*) from public.update_holds) as holds_count,
  (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.stage5_capabilities()')) as caps_src,
  (select md5(prosrc) from pg_proc where oid = to_regprocedure('private.cu1_insert_hold(jsonb)')) as insert_src,
  (select md5(string_agg(conname || ':' || pg_get_constraintdef(oid), ',' order by conname)) from pg_constraint
   where conrelid = to_regclass('public.update_holds')) as holds_constraints;
do $$
declare c record;
begin
  select * into c from cu1b_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'cu1b: set watchlist.cu1b_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-cu1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '7' then
    raise exception 'cu1b: expected phase contracted-cu1 with backup format 7, found % / %; nothing was changed',
      public.stage5_capabilities() ->> 'phase', public.stage5_capabilities() ->> 'backup_format';
  end if;
  if not exists (select 1 from private.migration_runs where migration = 'cu1') then raise exception 'cu1b: CU1 has no run record; nothing was changed'; end if;
  if to_regprocedure('public.library_cu_update_hold(uuid, jsonb, jsonb)') is not null then raise exception 'cu1b: already installed; nothing was changed'; end if;
  if c.insert_src is null or to_regprocedure('public.library_cu_save_hold(jsonb)') is null or to_regprocedure('private.lib_write_on()') is null
     or to_regprocedure('private.b45_changed()') is null then
    raise exception 'cu1b: the CU1 hold functions are missing; nothing was changed';
  end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'cu1b: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
end $$;

-- ── 2. The function ────────────────────────────────────────────────────────────
create function public.library_cu_update_hold(p_id uuid, p_expected jsonb, p_hold jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_keys constant text[] := array['kind', 'collection_id', 'show_id', 'item_id', 'subject_label', 'field', 'protected_value', 'decision', 'effect', 'reopen', 'decided_on'];
  h public.update_holds;
  k text;
begin
  if p_id is null or jsonb_typeof(p_expected) is distinct from 'object' or jsonb_typeof(p_hold) is distinct from 'object' then
    raise exception 'invalid_input: hold' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_hold) x where x <> all (v_keys))
     or exists (select 1 from jsonb_object_keys(p_expected) x where x <> all (v_keys))
     or exists (select 1 from unnest(v_keys) x where not (p_expected ? x)) then
    raise exception 'invalid_input: hold' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  select * into h from public.update_holds where id = p_id and user_id = v_owner for update;
  if not found then perform private.b45_changed(); end if;
  -- Every editable value as the page showed it (jsonb equality: reopen by content, dates and ids as text).
  foreach k in array v_keys loop
    if (to_jsonb(h) -> k) is distinct from (p_expected -> k) then perform private.b45_changed(); end if;
  end loop;
  begin
    update public.update_holds set
      kind = p_hold ->> 'kind', collection_id = (p_hold ->> 'collection_id')::uuid, show_id = (p_hold ->> 'show_id')::uuid,
      item_id = (p_hold ->> 'item_id')::uuid, subject_label = nullif(btrim(p_hold ->> 'subject_label'), ''), field = p_hold ->> 'field',
      protected_value = p_hold ->> 'protected_value', decision = btrim(p_hold ->> 'decision'), effect = p_hold ->> 'effect',
      reopen = p_hold -> 'reopen', decided_on = (p_hold ->> 'decided_on')::date
    where id = h.id and user_id = v_owner
    returning * into h;
  exception
    when foreign_key_violation then raise exception 'invalid_input: a hold names a record or collection that isn''t yours' using errcode = '22023';
    when not_null_violation or check_violation or invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
      raise exception 'invalid_input: hold %', sqlerrm using errcode = '22023';
  end;
  return to_jsonb(h) - 'user_id';
end $$;

-- ── 3. Grants: members only (M1's rule: nothing for anon or PUBLIC) ─────────────
revoke all on function public.library_cu_update_hold(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.library_cu_update_hold(uuid, jsonb, jsonb) to authenticated;

-- ── 4. The run record, then verify before commit ───────────────────────────────
insert into private.migration_runs (run_id, migration) select run_id, 'cu1b' from cu1b_ctx;
do $$
declare f regprocedure := 'public.library_cu_update_hold(uuid, jsonb, jsonb)'::regprocedure; c record;
begin
  select * into c from cu1b_ctx;
  if has_function_privilege('anon', f, 'execute')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = f and a.grantee = 0) then
    raise exception 'cu1b: the function is executable by anon or PUBLIC';
  end if;
  if not has_function_privilege('authenticated', f, 'execute') then raise exception 'cu1b: members can''t execute the function'; end if;
  if (select prosecdef from pg_proc where oid = f) then raise exception 'cu1b: the function must not be SECURITY DEFINER'; end if;
  if (select md5(string_agg(md5(h::text), ',' order by h.id)) from public.update_holds h) is distinct from c.holds_before
     or (select count(*) from public.update_holds) <> c.holds_count then
    raise exception 'cu1b: a hold changed';
  end if;
  if (select md5(prosrc) from pg_proc where oid = 'public.stage5_capabilities()'::regprocedure) is distinct from c.caps_src
     or (select md5(prosrc) from pg_proc where oid = 'private.cu1_insert_hold(jsonb)'::regprocedure) is distinct from c.insert_src
     or (select md5(string_agg(conname || ':' || pg_get_constraintdef(oid), ',' order by conname)) from pg_constraint
         where conrelid = 'public.update_holds'::regclass) is distinct from c.holds_constraints then
    raise exception 'cu1b: the capability, the hold insert or the hold checks changed';
  end if;
  if not exists (select 1 from private.migration_runs r where r.run_id = c.run_id and r.migration = 'cu1b') then
    raise exception 'cu1b: the run record does not hold this run';
  end if;
  if has_table_privilege('authenticated', 'private.migration_runs', 'select') or has_table_privilege('anon', 'private.migration_runs', 'select') then
    raise exception 'cu1b: private.migration_runs is readable by an application role';
  end if;
end $$;

select 'CU1B|' || (select run_id from cu1b_ctx) as result;
commit;
