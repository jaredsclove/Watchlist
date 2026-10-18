-- TEST ENVIRONMENTS ONLY (refuses without db/test/m1_test_marker.sql's marker). Puts a test
-- database back exactly as it was before db/m1_access.sql, from the snapshot taken before M1
-- (db/test/m1_snapshot.sql), so M1 can be rehearsed again. It is not a production rollback: M1 has
-- none (plan D2), and re-opening anonymous access is never a recovery step there.
--   select set_config('watchlist.m1_snapshot', '<db/test/m1_snapshot.sql result>', false);
begin;
set local lock_timeout = '10s';
lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
  public.watch_with_choices, public.custom_collections, public.catalog_show_links, public.catalog_film_links,
  private.stage5_recovery_records, private.stage5_recovery_collections, private.stage5_recovery_othertv,
  private.stage5_recovery_meta, private.app_owner in access exclusive mode;

create temp table rv_snap on commit drop as select current_setting('watchlist.m1_snapshot', true)::jsonb s;
create temp table rv_tables (schema_name text, table_name text) on commit drop;
insert into rv_tables values ('public', 'watchlist_items'), ('public', 'tv_shows'), ('public', 'custom_collections'),
  ('public', 'personal_collections'), ('public', 'collection_memberships'), ('public', 'watch_with_choices'),
  ('public', 'catalog_show_links'), ('public', 'catalog_film_links'), ('private', 'stage5_recovery_records'),
  ('private', 'stage5_recovery_collections'), ('private', 'stage5_recovery_othertv'), ('private', 'stage5_recovery_meta');

do $$
declare v_snap jsonb := (select s from rv_snap); v_owner uuid; t record; n bigint;
begin
  if to_regclass('private.zz_test_environment') is null then raise exception 'm1_reverse: not a marked test environment; nothing was changed'; end if;
  if v_snap is null or v_snap ->> 'bootstrap' is null then raise exception 'm1_reverse: set watchlist.m1_snapshot first'; end if;
  if to_regclass('private.library_members') is null then raise exception 'm1_reverse: M1 is not installed'; end if;
  if (select count(*) from private.library_members) <> 1 then raise exception 'm1_reverse: remove every member but the owner (and their rows) first'; end if;
  v_owner := (select user_id from private.library_members);
  for t in select * from rv_tables loop
    execute format('select count(*) from %I.%I where user_id <> $1', t.schema_name, t.table_name) into n using v_owner;
    if n > 0 then raise exception 'm1_reverse: %.% holds rows of other users', t.schema_name, t.table_name; end if;
  end loop;
end $$;

-- Ownership back to the bootstrap owner (the same link handling as M1).
do $$ declare t record; begin
  for t in select * from rv_tables loop
    execute format('alter table %I.%I drop constraint %I', t.schema_name, t.table_name, t.table_name || '_user_id_auth_fkey');
  end loop;
end $$;
set constraints all deferred;
alter table public.catalog_show_links drop constraint catalog_show_links_show_fkey;
alter table public.catalog_film_links drop constraint catalog_film_links_item_fkey;
select set_config('watchlist.library_write', 'on', true);
do $$
declare v_to uuid := ((select s from rv_snap) ->> 'bootstrap')::uuid; v_from uuid := (select user_id from private.library_members); t record;
begin
  update public.tv_shows set user_id = v_to where user_id = v_from;
  for t in select * from rv_tables where table_name <> 'tv_shows' loop
    execute format('update %I.%I set user_id = $1 where user_id = $2', t.schema_name, t.table_name) using v_to, v_from;
  end loop;
  update private.app_owner set bootstrap_owner_id = v_to where singleton;
end $$;
select set_config('watchlist.library_write', '', true);
set constraints all immediate;
alter table public.catalog_show_links add constraint catalog_show_links_show_fkey
  foreign key (show_id, user_id) references public.tv_shows (id, user_id) on delete cascade;
alter table public.catalog_film_links add constraint catalog_film_links_item_fkey
  foreign key (item_id, user_id, item_is_film) references public.watchlist_items (id, user_id, is_film) on delete cascade;

-- Policies and RLS flags as they were.
do $$
declare v_snap jsonb := (select s from rv_snap); t record; p record; r jsonb;
begin
  for t in select * from rv_tables loop
    for p in select policyname from pg_policies where schemaname = t.schema_name and tablename = t.table_name loop
      execute format('drop policy %I on %I.%I', p.policyname, t.schema_name, t.table_name);
    end loop;
    execute format('alter table %I.%I %s row level security', t.schema_name, t.table_name,
      case when (v_snap -> 'rel_acl' -> (case when t.schema_name = 'public' then t.table_name else t.schema_name || '.' || t.table_name end) ->> 'rls')::boolean
           then 'enable' else 'disable' end);
  end loop;
  for r in select * from jsonb_array_elements(v_snap -> 'policies') loop
    execute format('create policy %I on %I.%I as %s for %s to %s%s%s', r ->> 'name', r ->> 'schema', r ->> 'table', r ->> 'permissive', r ->> 'cmd',
      (select string_agg(case when x = 'public' then 'public' else quote_ident(x) end, ', ') from jsonb_array_elements_text(r -> 'roles') x),
      case when r ->> 'using' is not null then ' using (' || (r ->> 'using') || ')' else '' end,
      case when r ->> 'check' is not null then ' with check (' || (r ->> 'check') || ')' else '' end);
  end loop;
end $$;

-- Functions: the two replaced definitions back; the M1 objects gone.
do $$ declare f record; begin
  for f in select * from jsonb_each_text((select s from rv_snap) -> 'functions') loop execute f.value; end loop;
end $$;
drop function private.is_member();
drop table private.library_members;

-- Privileges exactly as they were: every app relation, column and function, the private schema,
-- and the default privileges (roles this session may change).
create or replace function pg_temp.rv_apply(p_kind text, p_object text, p_acl text, p_owner oid) returns void language plpgsql as $$
declare g record;
begin
  execute format('revoke all on %s %s from public, anon, authenticated, service_role', p_kind, p_object);
  for g in select a.grantee, a.privilege_type from aclexplode(coalesce(nullif(p_acl, '')::aclitem[],
      acldefault((case p_kind when 'function' then 'f' when 'schema' then 'n' when 'sequence' then 's' else 'r' end)::"char", p_owner))) a
    where a.grantee <> p_owner loop
    execute format('grant %s on %s %s to %s', g.privilege_type, p_kind, p_object, case when g.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(g.grantee)) end);
  end loop;
end $$;
do $$
declare v_snap jsonb := (select s from rv_snap); r record; g record;
begin
  for r in select c.oid, c.oid::regclass::text o, c.relkind, c.relowner from pg_class c
           where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'v', 'S') loop
    perform pg_temp.rv_apply(case when r.relkind = 'S' then 'sequence' else 'table' end, r.o, v_snap -> 'rel_acl' -> r.o ->> 'acl', r.relowner);
  end loop;
  for r in select * from jsonb_each_text(v_snap -> 'col_acl') loop
    for g in select a.grantee, a.privilege_type from aclexplode(r.value::aclitem[]) a loop
      execute format('grant %s (%I) on %s to %s', g.privilege_type, split_part(r.key, '.', -1),
        left(r.key, length(r.key) - length(split_part(r.key, '.', -1)) - 1),
        case when g.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(g.grantee)) end);
    end loop;
  end loop;
  for r in select p.oid::regprocedure::text o, p.proowner from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) loop
    perform pg_temp.rv_apply('function', r.o, v_snap -> 'fn_acl' ->> r.o, r.proowner);
  end loop;
  perform pg_temp.rv_apply('schema', 'private', v_snap ->> 'schema_acl', (select nspowner from pg_namespace where nspname = 'private'));
end $$;

do $$
declare v_snap jsonb := (select s from rv_snap); k record; g record; v_kind text; v_scope text; v_target text;
begin
  for k in select distinct role, schema, type from (
             select x ->> 'role' role, x ->> 'schema' schema, x ->> 'type' type from jsonb_array_elements(v_snap -> 'defaults') x
             union select pg_get_userbyid(defaclrole), defaclnamespace::regnamespace::text, defaclobjtype::text from pg_default_acl) s
           where role = current_user loop
    v_kind := case k.type when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' when 'T' then 'types' when 'n' then 'schemas' end;
    v_scope := format('for role %I', k.role) || case when k.schema = '-' then '' else format(' in schema %I', k.schema) end;
    execute format('alter default privileges %s revoke all on %s from public, anon, authenticated, service_role', v_scope, v_kind);
    v_target := (select x ->> 'acl' from jsonb_array_elements(v_snap -> 'defaults') x
                 where x ->> 'role' = k.role and x ->> 'schema' = k.schema and x ->> 'type' = k.type);
    for g in select a.grantee, a.privilege_type from aclexplode(coalesce(v_target::aclitem[],
        case when k.schema = '-' then acldefault(case k.type when 'S' then 's' when 'T' then 'T' else k.type end::"char", k.role::regrole) end)) a
      where a.grantee <> k.role::regrole loop
      execute format('alter default privileges %s grant %s on %s to %s', v_scope, g.privilege_type, v_kind,
        case when g.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(g.grantee)) end);
    end loop;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
