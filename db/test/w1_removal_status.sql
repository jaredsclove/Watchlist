-- Historical release verification, not a recurring check. W1 removal: one read-only SELECT, aggregates only, run as postgres before and after the migration.
-- Before: w1 recorded, clause_functions 38, helper true, repair and defaults none, pg_graphql false.
-- After: w1 and w1_removal recorded once each, clause_functions 0, helper false, names_w1 0, guards_read_flag 3.
select 'W1S|' || (jsonb_build_object(
  'phase', public.stage5_capabilities() ->> 'phase', 'backup_format', public.stage5_capabilities() ->> 'backup_format',
  'runs', (select jsonb_object_agg(q.migration, q.c) from (select migration, count(*) c from private.migration_runs where migration in ('cu1', 'cu2', 'cu1e', 'w1', 'w1_removal') group by 1) q),
  'clause_functions', (select count(*) from pg_proc p, unnest(p.proconfig) x where lower(x) like 'xmloption=%'),
  'helper', to_regprocedure('private.lib_authorized()') is not null,
  'names_w1', (select count(*) from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and (coalesce(p.prosrc, '') || coalesce(pg_get_function_sqlbody(p.oid), '')) ~* 'xml\s*_?option|lib_authorized|w1_reset_ok'),
  'guards_read_flag', (select count(*) from pg_proc where oid in ('private.lib_write_on()'::regprocedure, 'private.library_write_guard()'::regprocedure, 'private.b45_show_guard()'::regprocedure) and prosrc like '%watchlist.library_write%'),
  'repair', to_regclass('private.w1_recovery') is not null or to_regprocedure('public.w1_repair_gate()') is not null,
  'defaults', (select count(*) from pg_db_role_setting s, unnest(s.setconfig) x where x like 'pgrst.db_pre_request=%' or lower(x) like 'xmloption=%' or lower(x) like 'watchlist.w1_reset_ok=%'),
  'xmloption', current_setting('xmloption'),
  'pg_graphql', exists (select 1 from pg_extension where extname = 'pg_graphql'),
  'temp_left', exists (select 1 from pg_class where relname in ('w1r_ctx', 'w1r_expected')),
  'counts', jsonb_build_object('shows', (select count(*) from public.tv_shows), 'rows', (select count(*) from public.watchlist_items), 'findings', (select count(*) from public.update_findings))
))::text as result;
