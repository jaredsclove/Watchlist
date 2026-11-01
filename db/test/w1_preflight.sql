-- W1's release preflight and hosted capability check: one read-only SELECT, aggregates only, run as postgres. Reports names of
-- settings on authenticator, never their values. docs/W1_RELEASE_PROCEDURE.md says what each answer must be.
with expected(sig) as (select unnest(array[
  'public.delete_tv_season(uuid, integer)', 'public.library_add_films_b45(jsonb)', 'public.library_add_seasons_b45(uuid, jsonb, jsonb)',
  'public.library_add_watched_season_marks(uuid, jsonb, jsonb)', 'public.library_create_film_b45(jsonb)', 'public.library_create_show_b45(jsonb, jsonb)',
  'public.library_cu_accept_finding(uuid, jsonb)', 'public.library_cu_add_alias(uuid, uuid, text, jsonb)',
  'public.library_cu_attach_identity(uuid, jsonb, integer, jsonb, jsonb, boolean)', 'public.library_cu_delete_hold(uuid, text)',
  'public.library_cu_import_setup(jsonb)', 'public.library_cu_note_finding(jsonb, text)',
  'public.library_cu_reconcile_season(uuid, jsonb, jsonb, jsonb, boolean, uuid)', 'public.library_cu_record_findings(uuid, text, jsonb)',
  'public.library_cu_register_brief(uuid, jsonb, jsonb)', 'public.library_cu_save_definition(uuid, integer, text, jsonb, jsonb, text)',
  'public.library_cu_save_hold(jsonb)', 'public.library_cu_set_exclusion(uuid, text, jsonb)', 'public.library_cu_set_finding_status(uuid, text, text, text, jsonb)',
  'public.library_cu_set_season_date(uuid, jsonb, jsonb, jsonb, boolean)', 'public.library_cu_set_show_settings(uuid, jsonb, boolean, boolean)',
  'public.library_cu_sync_show_network(uuid, jsonb, jsonb)', 'public.library_cu_update_hold(uuid, jsonb, jsonb)', 'public.library_dismiss_catalog_new_b45(jsonb)',
  'public.library_dismiss_review_b45(text, uuid, jsonb)', 'public.library_match_film_b45(uuid, jsonb, jsonb, text, text)',
  'public.library_match_season_b45(uuid, jsonb, jsonb, jsonb, text)', 'public.library_set_episode_marks(uuid, jsonb, boolean, jsonb)',
  'public.library_set_film_state_b45(uuid, jsonb, jsonb)', 'public.library_set_metadata_b45(text, uuid, jsonb, jsonb)',
  'public.library_set_resume_b45(uuid, jsonb, uuid, uuid, boolean)', 'public.library_set_show_state_b45(uuid, jsonb, jsonb)',
  'public.org_add_membership(uuid, uuid, uuid)', 'public.org_remove_membership(uuid, uuid, uuid, uuid)', 'public.restore_backup(jsonb, boolean)',
  'private.tv_enrich_season(uuid, uuid, text, integer, uuid, text, integer, boolean)', 'private.tv_enrich_show(uuid, text, integer, jsonb, boolean)',
  'private.tv_enrich_show_partial(uuid, uuid, text, integer, jsonb, jsonb, boolean)'])),
fn as (select p.oid, coalesce(p.prosrc, '') || coalesce(pg_get_function_sqlbody(p.oid), '') as src, p.proconfig from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)),
cfg as (select s.setrole, s.setdatabase, x from pg_db_role_setting s, unnest(s.setconfig) x)
select 'W1P|' || (jsonb_build_object(
  'records', jsonb_build_object(
    'phase', public.stage5_capabilities() ->> 'phase', 'backup_format', public.stage5_capabilities() ->> 'backup_format',
    'runs', (select jsonb_agg(distinct migration) from private.migration_runs where migration in ('cu1', 'cu1b', 'cu1c', 'cu1d', 'cu2', 'cu1e', 'w1')),
    'lib_authorized_absent', to_regprocedure('private.lib_authorized()') is null),
  'functions', jsonb_build_object(
    'present_of_38', (select count(to_regprocedure(sig)) from expected),
    'enrichment_present', (select count(to_regprocedure(sig)) from expected where sig like 'private.%'),
    'public_writers_outside_list', (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.prosrc like '%lib_write_on%' or p.prosrc like '%watchlist.library_write%')
      and p.oid not in (select to_regprocedure(sig) from expected where to_regprocedure(sig) is not null))),
  'settings', jsonb_build_object(
    'xmloption', current_setting('xmloption'), 'reset_val', (select reset_val from pg_settings where name = 'xmloption'), 'source', (select source from pg_settings where name = 'xmloption'),
    'context', (select context from pg_settings where name = 'xmloption'),
    'xmloption_defaults', (select count(*) from cfg where lower(x) like 'xmloption=%'), 'marker_defaults', (select count(*) from cfg where lower(x) like 'watchlist.w1_reset_ok=%'),
    'functions_naming_either', (select count(*) from pg_proc p where (coalesce(p.prosrc, '') || coalesce(pg_get_function_sqlbody(p.oid), '')) ~* 'xml\s*_?option|w1_reset_ok' or exists (select 1 from unnest(p.proconfig) c where c ~* '^(xmloption|watchlist\.w1_reset_ok)=')),
    'authenticated_timeout', (select x from cfg where setrole = 'authenticated'::regrole and x like 'statement_timeout=%'),
    'authenticator_keys', (select jsonb_agg(split_part(x, '=', 1) order by 1) from cfg where setrole = 'authenticator'::regrole),
    'pre_request_set', exists (select 1 from cfg where x like 'pgrst.db_pre_request=%')),
  'grants', jsonb_build_object(
    'app_roles_can_create', (select bool_or(has_schema_privilege(r, s, 'create')) from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['public', 'private']) s),
    'private_acl_entries', (select array_length(nspacl, 1) from pg_namespace where nspname = 'private'),
    'authenticated_uses_private', has_schema_privilege('authenticated', 'private', 'usage'), 'anon_uses_private', has_schema_privilege('anon', 'private', 'usage'),
    'pg_graphql', exists (select 1 from pg_extension where extname = 'pg_graphql')),
  'capabilities', jsonb_build_object(
    'postgres_super', (select rolsuper from pg_roles where rolname = 'postgres'), 'postgres_createrole', (select rolcreaterole from pg_roles where rolname = 'postgres'),
    'pg_version', current_setting('server_version_num')::int, 'runs_as', current_user, 'may_signal', pg_has_role('postgres', 'pg_signal_backend', 'usage'),
    'may_alter_system_xmloption', has_parameter_privilege('postgres', 'xmloption', 'ALTER SYSTEM'),
    'admin_of_authenticator', exists (select 1 from pg_auth_members a where a.roleid = 'authenticator'::regrole and a.member = 'postgres'::regrole and a.admin_option),
    'private_owner', (select nspowner::regrole::text from pg_namespace where nspname = 'private'),
    'owner_table', (select count(*) from private.app_owner where singleton)),
  'connections', jsonb_build_object(
    'authenticator_by_name', (select jsonb_object_agg(n, c) from (select coalesce(nullif(application_name, ''), '(none)') n, count(*) c from pg_stat_activity where usename = 'authenticator' group by 1) q),
    'others_named', (select jsonb_agg(distinct usename) from pg_stat_activity where usename is not null and usename not in ('authenticator'))),
  'recovery_absent', to_regclass('private.w1_recovery') is null and to_regprocedure('public.w1_repair_gate()') is null
))::text as result;
