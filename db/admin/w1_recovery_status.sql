-- W1 recovery: where things stand, as a read-only run between the steps. Run as postgres. Changes nothing, ends nothing and
-- reports counts and times only. A row of authenticator connections that aren't PostgREST's is left alone by the
-- connections script, so 'other_authenticator' above zero is worth a look before relying on it.
select 'W1S|' || json_build_object(
  'at', now(),
  'closed', to_regclass('private.w1_recovery') is not null,
  'gate_function', to_regprocedure('public.w1_repair_gate()') is not null,
  'gate_setting', exists (select 1 from pg_db_role_setting s, unnest(s.setconfig) x where x like 'pgrst.db_pre_request=%'),
  'authenticated_uses_private', has_schema_privilege('authenticated', 'private', 'usage'),
  'xmloption_defaults', (select count(*) from pg_db_role_setting s, unnest(s.setconfig) x where lower(x) like 'xmloption=%'),
  'marker_defaults', (select count(*) from pg_db_role_setting s, unnest(s.setconfig) x where lower(x) like 'watchlist.w1_reset_ok=%'),
  'xmloption_reset_val', (select reset_val from pg_settings where name = 'xmloption'),
  'postgrest_connections', (select count(*) from pg_stat_activity where usename = 'authenticator' and application_name ilike 'postgrest%'),
  'oldest_postgrest_connection', (select min(backend_start) from pg_stat_activity where usename = 'authenticator' and application_name ilike 'postgrest%'),
  'other_authenticator', (select count(*) from pg_stat_activity where usename = 'authenticator' and application_name not ilike 'postgrest%')
) as result;
