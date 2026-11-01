-- W1 recovery, step 1 of 5: close the API to everyone before touching the configuration. See db/README.md, write scope.
-- Run as postgres. Two gates, because neither alone can be trusted yet:
--   usage on schema private is revoked, which works at once and doesn't depend on PostgREST: the guards and the library
--   functions need that schema, so guarded writes stop (public can't be used: its usage comes from PUBLIC). Reads and
--   unguarded deletes don't all need it;
--   a pre-request gate refuses everyone but the owner, every kind of request, once PostgREST has reloaded. A request has
--   to prove that. Nothing counts as closed until one has.
-- The first holds until step 3. The second holds until step 4, and lets the owner's token test the real API path before
-- anyone else returns. Then every API connection is ended, so that nothing in flight keeps the old state.
begin;
do $$
begin
  if to_regclass('private.w1_recovery') is not null then raise exception 'w1 recovery: already closed; finish or clean up first. Nothing was changed'; end if;
  if (select count(*) from private.app_owner where singleton) <> 1 then raise exception 'w1 recovery: no single owner; nothing was changed'; end if;
end $$;
create table private.w1_recovery as
select (select array_agg(x::text order by x::text) from pg_namespace n, unnest(n.nspacl) x where n.nspname = 'private') as private_acl;
do $$
begin
  if not has_schema_privilege('authenticated', 'private', 'usage') then raise exception 'w1 recovery: authenticated has no usage of private to give back; nothing was changed'; end if;
end $$;
do $$
begin
  execute format($f$
    create function public.w1_repair_gate() returns void language plpgsql stable set search_path = '' as $g$
    begin
      if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '') is distinct from %L then
        raise exception 'library_under_repair: The library is closed for repair. Nothing was changed.' using errcode = 'PT503';
      end if;
    end $g$ $f$, (select bootstrap_owner_id::text from private.app_owner where singleton));
end $$;
revoke all on function public.w1_repair_gate() from public;
grant execute on function public.w1_repair_gate() to anon, authenticated, service_role;
revoke usage on schema private from authenticated;
alter role authenticator set pgrst.db_pre_request = 'public.w1_repair_gate';
notify pgrst, 'reload config';
commit;
select pg_terminate_backend(pid) from pg_stat_activity where usename = 'authenticator' and pid <> pg_backend_pid();
