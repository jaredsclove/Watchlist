-- TEST PROJECTS ONLY. Puts a rehearsal project into the future signed-in state
-- for the real authenticated-API isolation test (tools/auth-isolation-test.html):
-- switch-over stage, the bootstrap owner's data moved to test user A, then the
-- lock (owner = auth.uid() only, owner-only access rules, no anonymous access).
-- Needs db/rpc.sql and db/future/auth_switchover.sql installed. Run as postgres.
begin;

do $$ begin
  if private.tv_stage() not in ('shadow', 'tv_schema', 'authoritative') then raise exception 'unexpected stage %', private.tv_stage(); end if;
  if not exists (select 1 from auth.users where id = '63cfd441-87f9-4882-976d-0d0fabe7eda4')
     or not exists (select 1 from auth.users where id = 'cdb783e6-a0b6-4412-8284-56add7ae3126') then
    raise exception 'test users A and B must exist in auth.users';
  end if;
end $$;

update private.migration_stage set stage = 'authoritative', changed_at = now();
select private.auth_move_owner('63cfd441-87f9-4882-976d-0d0fabe7eda4');
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
