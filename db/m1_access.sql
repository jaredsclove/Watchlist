-- M1: owner-only access. Every library row belongs to a signed-in member; anonymous
-- access to app tables, views and functions ends. One transaction, run as postgres on a
-- contracted-b45 database (recovery archive active). Replaces the historical
-- db/future/auth_switchover.sql, which predates Stage 5c and B4/B5 and is not used.
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.m1_owner', '<the owner''s Auth user id>', false);
--   select set_config('watchlist.m1_run', '<a fresh run id, recorded before running>', false);
-- Order:
--   0. the run label (application_name, transaction-local), then every lock, then the checks;
--   1. preconditions; the before-state (counts and fingerprints without user_id);
--   2. ownership: the bootstrap owner's rows in all twelve owned tables move to the Auth user;
--      user_id → auth.users (ON DELETE RESTRICT: deleting a login never deletes a library);
--   3. membership (private.library_members) and owner resolution from auth.uid(); the run record
--      (private.migration_runs: this run's id, written inside this transaction);
--   4. policies: owner-only per command plus one restrictive membership policy per table;
--      RLS on the recovery archive;
--   5. grants: nothing for anon; the function set authenticated could already execute, minus
--      the client_outdated stubs; no TRUNCATE / REFERENCES / TRIGGER; defaults for future objects;
--   6. stage5_capabilities() gains access = members;
--   7. verify before commit (preservation, ownership, privileges, policies, simulated callers,
--      a default-privilege probe).
-- Completion: this run committed if and only if private.migration_runs holds its run id. Confirm it
-- with a fresh read of that exact row in a separate execution (an authorized administrative read; the
-- table is closed to every application role). A missing row is "not committed" only once the
-- transaction is known to have ended (the run label observed, then absent); otherwise the outcome is
-- unknown. Never rerun to find out: every attempt needs a fresh run id, and a rerun is refused by
-- section 1 once this committed.
-- Test environments only: db/test/m1_reverse.sql.
begin;
select set_config('application_name', 'watchlist-m1-' || coalesce(nullif(current_setting('watchlist.m1_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';

-- ── 0. Locks before any check: a delayed original and a rerun are serialized ─────
lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
  public.watch_with_choices, public.custom_collections, public.catalog_show_links, public.catalog_film_links,
  private.stage5_recovery_records, private.stage5_recovery_collections, private.stage5_recovery_othertv,
  private.stage5_recovery_meta, private.app_owner, private.migration_stage in access exclusive mode;

-- ── 1. Preconditions and the before-state ─────────────────────────────────────
create temp table m1_tables (schema_name text, table_name text, commands text[]) on commit drop;
insert into m1_tables values
  ('public', 'watchlist_items', '{select,insert,update,delete}'),
  ('public', 'tv_shows', '{select,insert,update,delete}'),
  ('public', 'custom_collections', '{select,insert,update,delete}'),
  ('public', 'personal_collections', '{select,insert,update,delete}'),
  ('public', 'collection_memberships', '{select,insert,update,delete}'),
  ('public', 'watch_with_choices', '{select,insert,update,delete}'),
  ('public', 'catalog_show_links', '{select,insert}'),
  ('public', 'catalog_film_links', '{select,insert}'),
  ('private', 'stage5_recovery_records', '{select,insert,delete}'),
  ('private', 'stage5_recovery_collections', '{select,insert,delete}'),
  ('private', 'stage5_recovery_othertv', '{select,insert,delete}'),
  ('private', 'stage5_recovery_meta', '{select,insert,delete}');

create temp table m1_ctx on commit drop as
select nullif(current_setting('watchlist.m1_owner', true), '') as owner_text,
       nullif(current_setting('watchlist.m1_run', true), '') as run_id,
       (select bootstrap_owner_id from private.app_owner where singleton) as bootstrap;

do $$
declare c record; v_owner uuid; t record; n bigint;
begin
  select * into c from m1_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'm1: set watchlist.m1_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if c.owner_text is null or c.owner_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'm1: set watchlist.m1_owner to the owner''s Auth user id first; nothing was changed';
  end if;
  v_owner := c.owner_text::uuid;
  if private.tv_stage() <> 'final' then raise exception 'm1: expected stage final, found %', private.tv_stage(); end if;
  if public.stage5_capabilities() ? 'access' then raise exception 'm1: already applied (access = %); nothing was changed', public.stage5_capabilities() ->> 'access'; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-b45' then
    raise exception 'm1: expected phase contracted-b45, found %', public.stage5_capabilities() ->> 'phase';
  end if;
  if to_regclass('private.stage5_recovery_meta') is null then raise exception 'm1: the recovery archive is not active; nothing was changed'; end if;
  if to_regclass('private.library_members') is not null then raise exception 'm1: private.library_members already exists; nothing was changed'; end if;
  if to_regclass('private.migration_runs') is not null then raise exception 'm1: private.migration_runs already exists; nothing was changed'; end if;
  if c.bootstrap is null then raise exception 'm1: no bootstrap owner; nothing was changed'; end if;
  if c.bootstrap = v_owner then raise exception 'm1: the Auth user is the bootstrap owner already; nothing was changed'; end if;
  if not exists (select 1 from auth.users where id = v_owner) then raise exception 'm1: no Auth user %; nothing was changed', v_owner; end if;
  for t in select * from m1_tables loop
    execute format('select count(*) from %I.%I where user_id is distinct from $1', t.schema_name, t.table_name) into n using c.bootstrap;
    if n > 0 then raise exception 'm1: %.% has % row(s) not owned by the bootstrap owner; nothing was changed', t.schema_name, t.table_name, n; end if;
  end loop;
end $$;

-- Fingerprints without user_id, in a stable order (every owned table; recovery_meta has no id).
create or replace function pg_temp.m1_fp(p_schema text, p_table text) returns text language plpgsql as $$
declare v text;
begin
  execute format('select md5(coalesce(string_agg(x, ''|'' order by x), '''')) from (select (to_jsonb(t) - ''user_id'')::text x from %I.%I t) s',
                 p_schema, p_table) into v;
  return v;
end $$;
create or replace function pg_temp.m1_n(p_schema text, p_table text) returns bigint language plpgsql as $$
declare v bigint;
begin
  execute format('select count(*) from %I.%I', p_schema, p_table) into v;
  return v;
end $$;
create temp table m1_before on commit drop as
select schema_name, table_name, pg_temp.m1_fp(schema_name, table_name) fp, pg_temp.m1_n(schema_name, table_name) n
from m1_tables;

-- ── 2. Ownership ───────────────────────────────────────────────────────────────
-- Deferrable FKs are checked at commit; watchlist_items → tv_shows cascades on update; the two
-- catalog-link FKs (neither deferrable nor cascading) are recreated with their exact definitions.
set constraints all deferred;
create temp table m1_fk on commit drop as
select c.conrelid::regclass::text tbl, c.conname, pg_get_constraintdef(c.oid) def
from pg_constraint c join m1_tables t on c.conrelid = format('%I.%I', t.schema_name, t.table_name)::regclass
where c.contype = 'f' and not c.condeferrable and c.confupdtype <> 'c';
do $$
declare r record;
begin
  if (select array_agg(conname order by conname) from m1_fk) is distinct from array['catalog_film_links_item_fkey', 'catalog_show_links_show_fkey']::name[] then
    raise exception 'm1: unexpected non-deferrable foreign keys: %', (select array_agg(conname order by conname) from m1_fk);
  end if;
  for r in select * from m1_fk loop execute format('alter table %s drop constraint %I', r.tbl, r.conname); end loop;
end $$;

select set_config('watchlist.library_write', 'on', true);
do $$
declare v_from uuid := (select bootstrap from m1_ctx); v_to uuid := (select owner_text::uuid from m1_ctx); t record;
begin
  -- Shows first (their seasons follow through the cascading FK), then every table.
  update public.tv_shows set user_id = v_to where user_id = v_from;
  for t in select * from m1_tables where table_name <> 'tv_shows' loop
    execute format('update %I.%I set user_id = $1 where user_id = $2', t.schema_name, t.table_name) using v_to, v_from;
  end loop;
  update private.app_owner set bootstrap_owner_id = v_to where singleton;
end $$;
select set_config('watchlist.library_write', '', true);
-- Check every deferred link now (the queue must be empty before ALTER TABLE).
set constraints all immediate;

do $$
declare r record;
begin
  for r in select * from m1_fk loop execute format('alter table %s add constraint %I %s', r.tbl, r.conname, r.def); end loop;
  for r in select * from m1_tables loop
    execute format('alter table %I.%I add constraint %I foreign key (user_id) references auth.users (id) on delete restrict',
                   r.schema_name, r.table_name, r.table_name || '_user_id_auth_fkey');
  end loop;
end $$;

-- ── 3. Membership and owner resolution ─────────────────────────────────────────
create table private.library_members (
  user_id uuid primary key references auth.users (id) on delete restrict,
  added_at timestamptz not null default now(),
  note text
);
alter table private.library_members enable row level security;
revoke all on private.library_members from public, anon, authenticated;
insert into private.library_members (user_id, note) select owner_text::uuid, 'owner (M1)' from m1_ctx;

-- The run record: written in this transaction, so it exists only if this run commits. Read only by the
-- database owner (an administrative confirmation); no application role can reach it.
create table private.migration_runs (
  run_id text primary key check (run_id ~ '^[A-Za-z0-9_-]{6,64}$'),
  migration text not null,
  recorded_at timestamptz not null default now()
);
alter table private.migration_runs enable row level security;
revoke all on private.migration_runs from public, anon, authenticated;
insert into private.migration_runs (run_id, migration) select run_id, 'm1' from m1_ctx;

create or replace function private.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.library_members m where m.user_id = auth.uid())
$$;

-- The owner is the signed-in member, and only the signed-in member (no fallback).
create or replace function private.current_owner_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'not_signed_in: Sign in to change your library. Nothing was changed.' using errcode = '28000';
  end if;
  if not exists (select 1 from private.library_members m where m.user_id = v) then
    raise exception 'not_a_member: This account has no library here. Nothing was changed.' using errcode = '42501';
  end if;
  return v;
end $$;

-- ── 4. Policies ────────────────────────────────────────────────────────────────
do $$
declare t record; p record; c text;
begin
  for t in select * from m1_tables loop
    execute format('alter table %I.%I enable row level security', t.schema_name, t.table_name);
    for p in select policyname from pg_policies where schemaname = t.schema_name and tablename = t.table_name loop
      execute format('drop policy %I on %I.%I', p.policyname, t.schema_name, t.table_name);
    end loop;
    foreach c in array t.commands loop
      execute format('create policy %I on %I.%I for %s to authenticated %s', 'owner_' || c, t.schema_name, t.table_name, c,
        case c when 'insert' then 'with check (user_id = (select auth.uid()))'
               when 'update' then 'using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))'
               else 'using (user_id = (select auth.uid()))' end);
    end loop;
    execute format('create policy members_only on %I.%I as restrictive for all to authenticated using ((select private.is_member())) with check ((select private.is_member()))',
                   t.schema_name, t.table_name);
  end loop;
end $$;

-- ── 5. Grants ──────────────────────────────────────────────────────────────────
-- Functions: keep exactly what authenticated could execute, minus the refusing stubs.
create temp table m1_stubs (f regprocedure) on commit drop;
insert into m1_stubs values
  ('public.add_tv_seasons(text, jsonb, jsonb)'), ('public.add_tv_seasons_to_show(uuid, jsonb, jsonb)'),
  ('public.catalog_apply(text, jsonb, text)'), ('public.create_tv_show(jsonb, jsonb)'),
  ('public.library_add_films(jsonb)'), ('public.library_add_seasons(uuid, jsonb, jsonb)'),
  ('public.library_catalog_apply(text, jsonb, text)'), ('public.library_create_film(jsonb)'),
  ('public.library_create_show(jsonb, jsonb)'), ('public.library_match_film(uuid, jsonb, jsonb)'),
  ('public.library_match_season(uuid, jsonb, jsonb, jsonb)'), ('public.match_tv_row(uuid, jsonb, jsonb, jsonb)'),
  ('public.seed_tv_defaults(text, jsonb)'), ('public.set_show_status(uuid, text)');
do $$ begin
  if exists (select 1 from m1_stubs s join pg_proc p on p.oid = s.f
             where p.prosrc !~ '(client_outdated|catalog_apply_required)' or length(p.prosrc) > 600) then
    raise exception 'm1: a listed stub is not a refusing stub: %', (select array_agg(s.f) from m1_stubs s join pg_proc p on p.oid = s.f
      where p.prosrc !~ '(client_outdated|catalog_apply_required)' or length(p.prosrc) > 600);
  end if;
end $$;
create temp table m1_fn_keep on commit drop as
select p.oid::regprocedure f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'private') and has_function_privilege('authenticated', p.oid, 'execute')
  and p.oid not in (select f from m1_stubs);
revoke execute on all functions in schema public, private from public, anon, authenticated;
do $$ declare r record; begin
  for r in select f from m1_fn_keep loop execute format('grant execute on function %s to authenticated', r.f); end loop;
end $$;
grant execute on function private.is_member(), private.current_owner_id() to authenticated;

-- Relations: nothing for anon; no TRUNCATE / REFERENCES / TRIGGER for authenticated.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema private from anon;
revoke all on all sequences in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
revoke truncate, references, trigger on all tables in schema private from authenticated;
revoke usage on schema private from anon, public;

-- Future objects. EXECUTE-to-PUBLIC on new functions is a global default, which a schema-scoped
-- revoke can't remove; the schema-scoped entries in public are revoked per object type.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;
-- Defaults owned by supabase_admin (hosted only): changed when this role may; otherwise recorded,
-- and every later migration revokes explicitly and verifies before commit.
create temp table m1_notes (note text) on commit drop;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    begin
      execute 'alter default privileges for role supabase_admin revoke execute on functions from public';
      execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from anon';
      execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon';
      execute 'alter default privileges for role supabase_admin in schema public revoke all on functions from anon';
      insert into m1_notes values ('supabase_admin defaults: revoked');
    exception when insufficient_privilege then
      insert into m1_notes values ('supabase_admin defaults: not alterable by ' || current_user || ' (recorded; later migrations revoke explicitly)');
    end;
  else
    insert into m1_notes values ('supabase_admin: no such role');
  end if;
end $$;

-- ── 6. Capability ──────────────────────────────────────────────────────────────
create or replace function public.stage5_capabilities() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted-b45', 'backup_format', 5, 'b45', 1, 'access', 'members',
    -- Whether the caller is a member now. A signed-in non-member's reads return no rows (RLS), so pages and
    -- exports check this explicitly before treating anything they read as the library (never an empty one).
    'member', private.is_member(),
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;
revoke execute on function public.stage5_capabilities() from public, anon;
grant execute on function public.stage5_capabilities() to authenticated;

-- ── 7. Verify before commit ────────────────────────────────────────────────────
do $$
declare v_owner uuid := (select owner_text::uuid from m1_ctx); v_bad jsonb; t record; v_n bigint;
  v_expect bigint[] := array[(select b.n from m1_before b where b.table_name = 'watchlist_items'), (select b.n from m1_before b where b.table_name = 'tv_shows'),
    (select b.n from m1_before b where b.table_name = 'stage5_recovery_records')]; v_fake uuid := gen_random_uuid();
begin
  -- (a) preservation and ownership
  select jsonb_agg(b.table_name) into v_bad from m1_before b
  where b.fp is distinct from pg_temp.m1_fp(b.schema_name, b.table_name);
  if v_bad is not null then raise exception 'm1: content changed in %', v_bad; end if;
  for t in select * from m1_tables loop
    execute format('select count(*) from %I.%I where user_id is distinct from $1', t.schema_name, t.table_name) into v_n using v_owner;
    if v_n > 0 then raise exception 'm1: %.% has % row(s) not owned by the owner', t.schema_name, t.table_name, v_n; end if;
  end loop;
  if (select count(*) from pg_constraint c join m1_fk f on f.conname = c.conname and c.conrelid = f.tbl::regclass and pg_get_constraintdef(c.oid) = f.def) <> 2 then
    raise exception 'm1: the catalog-link foreign keys were not restored exactly';
  end if;

  -- (a2) the run record: exactly this run, and no application role can reach it
  if (select count(*) from private.migration_runs) <> 1
     or not exists (select 1 from private.migration_runs r join m1_ctx c on c.run_id = r.run_id where r.migration = 'm1') then
    raise exception 'm1: the run record does not hold exactly this run';
  end if;
  if has_table_privilege('anon', 'private.migration_runs', 'select, insert, update, delete, truncate, references, trigger')
     or has_table_privilege('authenticated', 'private.migration_runs', 'select, insert, update, delete, truncate, references, trigger')
     or has_any_column_privilege('authenticated', 'private.migration_runs', 'select, insert, update, references')
     or not (select relrowsecurity from pg_class where oid = 'private.migration_runs'::regclass) then
    raise exception 'm1: the run record is reachable by an application role';
  end if;

  -- (b) anon: no privilege on any app relation, column, function or the private schema
  select jsonb_agg(c.oid::regclass) into v_bad from pg_class c
  where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'v', 'm', 'S', 'f', 'p')
    and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update')
      or has_table_privilege('anon', c.oid, 'delete') or has_table_privilege('anon', c.oid, 'truncate')
      or has_table_privilege('anon', c.oid, 'references') or has_table_privilege('anon', c.oid, 'trigger')
      or exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                 and (has_column_privilege('anon', c.oid, a.attnum, 'select') or has_column_privilege('anon', c.oid, a.attnum, 'insert')
                      or has_column_privilege('anon', c.oid, a.attnum, 'update'))));
  if v_bad is not null then raise exception 'm1: anon still has privileges on %', v_bad; end if;
  select jsonb_agg(p.oid::regprocedure) into v_bad from pg_proc p
  where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and has_function_privilege('anon', p.oid, 'execute');
  if v_bad is not null then raise exception 'm1: anon can still execute %', v_bad; end if;
  if has_schema_privilege('anon', 'private', 'usage') then raise exception 'm1: anon still has usage on private'; end if;

  -- (c) authenticated: exactly the kept functions (plus the two helpers and the capability), no stub,
  -- no TRUNCATE / REFERENCES / TRIGGER, and no SECURITY DEFINER function beyond the three helpers
  select jsonb_agg(p.oid::regprocedure) into v_bad from pg_proc p
  where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and has_function_privilege('authenticated', p.oid, 'execute')
    and p.oid not in (select f from m1_fn_keep)
    and p.oid not in ('private.is_member()'::regprocedure, 'private.current_owner_id()'::regprocedure, 'public.stage5_capabilities()'::regprocedure);
  if v_bad is not null then raise exception 'm1: authenticated can execute unexpected functions %', v_bad; end if;
  if exists (select 1 from m1_stubs s where has_function_privilege('authenticated', s.f, 'execute')) then raise exception 'm1: a stub is still executable'; end if;
  select jsonb_agg(p.oid::regprocedure) into v_bad from pg_proc p
  where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
    and p.oid not in ('private.is_member()'::regprocedure, 'private.current_owner_id()'::regprocedure, 'private.tv_stage()'::regprocedure);
  if v_bad is not null then raise exception 'm1: unexpected SECURITY DEFINER functions for authenticated %', v_bad; end if;
  select jsonb_agg(c.oid::regclass) into v_bad from pg_class c
  where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'p')
    and (has_table_privilege('authenticated', c.oid, 'truncate') or has_table_privilege('authenticated', c.oid, 'references')
      or has_table_privilege('authenticated', c.oid, 'trigger'));
  if v_bad is not null then raise exception 'm1: authenticated still has truncate/references/trigger on %', v_bad; end if;

  -- (d) policies: RLS on, exactly the expected set, nothing for anon or PUBLIC anywhere in the app schemas
  for t in select * from m1_tables loop
    if not (select relrowsecurity from pg_class where oid = format('%I.%I', t.schema_name, t.table_name)::regclass) then
      raise exception 'm1: RLS is off on %.%', t.schema_name, t.table_name;
    end if;
    if (select array_agg(policyname || ':' || cmd || ':' || permissive || ':' || array_to_string(roles, ',') order by policyname)
        from pg_policies where schemaname = t.schema_name and tablename = t.table_name)
       is distinct from (select array_agg(x order by x) from (
         select 'owner_' || c || ':' || upper(c) || ':PERMISSIVE:authenticated' x from unnest(t.commands) c
         union all select 'members_only:ALL:RESTRICTIVE:authenticated') s) then
      raise exception 'm1: unexpected policies on %.%', t.schema_name, t.table_name;
    end if;
  end loop;
  if exists (select 1 from pg_policies where schemaname in ('public', 'private') and (roles && array['anon', 'public']::name[])) then
    raise exception 'm1: a policy still applies to anon or PUBLIC';
  end if;
  if public.stage5_capabilities() ->> 'access' is distinct from 'members' then raise exception 'm1: capability not updated'; end if;
  if (public.stage5_capabilities() -> 'member') is distinct from 'false'::jsonb then raise exception 'm1: capability member flag wrong for a caller with no claims'; end if;

  -- (e) simulated callers (each inside a subtransaction that is rolled back)
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
  begin
    perform count(*) from public.watchlist_items;
    raise exception 'm1-check: anon read succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.stage5_capabilities();
    raise exception 'm1-check: anon executed stage5_capabilities';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'none', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_fake, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  if (select count(*) from public.watchlist_items) + (select count(*) from public.tv_shows) + (select count(*) from public.personal_collections) <> 0 then
    raise exception 'm1-check: a non-member sees rows';
  end if;
  begin
    perform private.current_owner_id();
    raise exception 'm1-check: a non-member resolved as owner';
  exception when insufficient_privilege then null;
  end;
  if (public.stage5_capabilities() -> 'member') is distinct from 'false'::jsonb then raise exception 'm1-check: a non-member is reported as a member'; end if;
  perform set_config('role', 'none', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  if private.current_owner_id() <> v_owner then raise exception 'm1-check: owner not resolved'; end if;
  if (public.stage5_capabilities() -> 'member') is distinct from 'true'::jsonb then raise exception 'm1-check: the owner is not reported as a member'; end if;
  if array[(select count(*) from public.watchlist_items), (select count(*) from public.tv_shows), (select count(*) from private.stage5_recovery_records)]
     is distinct from v_expect then
    raise exception 'm1-check: the owner doesn''t see every row';
  end if;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);

  -- (f) default-privilege probe: new objects created as postgres grant nothing to anon or PUBLIC
  create table public.zz_m1_probe (x int);
  create sequence public.zz_m1_probe_seq;
  create function public.zz_m1_probe_fn() returns int language sql as 'select 1';
  if has_table_privilege('anon', 'public.zz_m1_probe', 'select') or has_table_privilege('anon', 'public.zz_m1_probe', 'insert')
     or has_sequence_privilege('anon', 'public.zz_m1_probe_seq', 'usage')
     or has_function_privilege('anon', 'public.zz_m1_probe_fn()', 'execute')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid = 'public.zz_m1_probe_fn()'::regprocedure and a.grantee = 0) then
    raise exception 'm1: a new object would be open to anon or PUBLIC';
  end if;
  drop function public.zz_m1_probe_fn();
  drop sequence public.zz_m1_probe_seq;
  drop table public.zz_m1_probe;
end $$;

select 'M1|' || json_build_object('owner', (select owner_text from m1_ctx), 'run', (select run_id from m1_ctx),
  'counts', (select json_object_agg(schema_name || '.' || table_name, n) from m1_before),
  'notes', (select json_agg(note) from m1_notes)) as result;

notify pgrst, 'reload schema';
commit;
