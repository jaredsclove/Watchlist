-- TEST ENVIRONMENTS ONLY: removes CU2 so its install can be rehearsed again. Never a production step: production
-- is fix-forward.
-- Refuses unless the database is marked as a test environment (db/test/m1_test_marker.sql).
begin;
do $$ begin
  if to_regclass('zz_test.environment') is null then raise exception 'cu2 reverse: not a marked test environment; nothing was changed'; end if;
  if to_regprocedure('private.restore_backup_v7(jsonb, boolean)') is null then raise exception 'cu2 reverse: CU2 is not installed; nothing was changed'; end if;
end $$;
do $$
declare t text;
begin
  foreach t in array array['update_setup', 'collection_definitions', 'collection_exclusions', 'update_holds', 'research_briefs', 'research_imports',
    'record_aliases', 'update_findings'] loop
    execute format('drop trigger %I on public.%I', t || '_research_guard', t);
  end loop;
end $$;
drop function private.research_write_guard();
drop function public.restore_backup(jsonb, boolean);
alter function private.restore_backup_v7(jsonb, boolean) set schema public;
alter function public.restore_backup_v7(jsonb, boolean) rename to restore_backup;
create or replace function public.stage5_capabilities() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted-cu1', 'backup_format', 7, 'b45', 1, 'ep1', 1, 'cu1', 1, 'access', 'members',
    'member', private.is_member(),
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;
drop function private.research_enabled();
alter table private.library_members drop column research_enabled;
delete from private.migration_runs where migration = 'cu2';
commit;
