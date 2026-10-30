-- TEST ENVIRONMENTS ONLY: removes CU1d's two functions and its run record so the CU1d install can be rehearsed
-- again. Never a production step: production is fix-forward.
-- Refuses unless the database is marked as a test environment (db/test/m1_test_marker.sql).
begin;
do $$ begin
  if to_regclass('zz_test.environment') is null then raise exception 'cu1d reverse: not a marked test environment; nothing was changed'; end if;
  if to_regprocedure('public.library_cu_sync_show_network(uuid, jsonb, jsonb)') is null then raise exception 'cu1d reverse: CU1d is not installed; nothing was changed'; end if;
end $$;
drop function public.library_cu_sync_show_network(uuid, jsonb, jsonb);
drop function public.library_add_watched_season_marks(uuid, jsonb, jsonb);
delete from private.migration_runs where migration = 'cu1d';
commit;
