-- TEST ENVIRONMENTS ONLY: puts a test database back to CU1 without CU1b (drops library_cu_update_hold and its
-- run record) so the CU1b install can be rehearsed again. Never a production step: production is fix-forward.
-- Refuses unless the database is marked as a test environment (db/test/m1_test_marker.sql).
begin;
do $$ begin
  if to_regclass('zz_test.environment') is null then raise exception 'cu1b reverse: not a marked test environment; nothing was changed'; end if;
  if to_regprocedure('public.library_cu_update_hold(uuid, jsonb, jsonb)') is null then raise exception 'cu1b reverse: CU1b is not installed; nothing was changed'; end if;
end $$;
drop function public.library_cu_update_hold(uuid, jsonb, jsonb);
delete from private.migration_runs where migration = 'cu1b';
commit;
