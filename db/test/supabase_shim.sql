-- LOCAL ONLY (PGlite / plain Postgres). Never run on Supabase: these objects
-- already exist there. Recreates just enough of Supabase's platform for the
-- rehearsal: the API roles, auth.uid() and auth.users, and the default
-- privileges that give anon/authenticated full table access in public.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text);

-- Same definition Supabase ships: the JWT 'sub' claim, as set by PostgREST.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
