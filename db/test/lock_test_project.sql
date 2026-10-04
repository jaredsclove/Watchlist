-- TEST PROJECTS ONLY. Puts a rehearsal project into the future signed-in state
-- for the real authenticated-API isolation test (tools/auth-isolation-test.html):
-- switch-over stage, the bootstrap owner's data moved to test user A, then the
-- lock (owner = auth.uid() only, owner-only access rules, no anonymous access).
-- Needs db/rpc.sql and db/future/auth_switchover.sql installed. Run as postgres,
-- after the untracked db/test/local_test_users.sql (template:
-- local_test_users.example.sql), which sets the two test users' ids.
begin;

do $$
declare a text := current_setting('watchlist_test.user_a', true); b text := current_setting('watchlist_test.user_b', true);
begin
  if a is null or b is null or a = b
     or a !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or b !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'set watchlist_test.user_a and watchlist_test.user_b first (db/test/local_test_users.sql)';
  end if;
  if private.tv_stage() not in ('shadow', 'tv_schema', 'authoritative') then raise exception 'unexpected stage %', private.tv_stage(); end if;
  if not exists (select 1 from auth.users where id = a::uuid) or not exists (select 1 from auth.users where id = b::uuid) then
    raise exception 'test users A and B must exist in auth.users';
  end if;
end $$;

update private.migration_stage set stage = 'authoritative', changed_at = now();
select private.auth_move_owner(current_setting('watchlist_test.user_a')::uuid);
select private.auth_lock();

commit;

select 'LOCKED|' || json_build_object(
  'stage', private.tv_stage(),
  'owners', (select json_agg(distinct user_id) from (select user_id from public.watchlist_items union all select user_id from public.tv_shows
             union all select user_id from public.othertv_shows union all select user_id from public.custom_collections) x),
  'anon_policies', (select count(*) from pg_policies where schemaname = 'public' and 'anon' = any(roles)),
  'owner_policies', (select count(*) from pg_policies where schemaname = 'public' and policyname = 'owner_only'),
  'anon_table_select', (select bool_or(has_table_privilege('anon', 'public.' || t, 'select'))
                        from unnest(array['watchlist_items', 'tv_shows', 'othertv_shows', 'custom_collections']) t),
  'anon_rpc_execute', (select bool_or(has_function_privilege('anon', p.oid, 'execute')) from pg_proc p where p.pronamespace = 'public'::regnamespace),
  'app_owner_table', to_regclass('private.app_owner') is not null)::text as r;
