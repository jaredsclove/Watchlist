-- TEST ENVIRONMENTS ONLY. Read-only: what db/test/m1_reverse.sql needs to put a test database back
-- exactly as it was before db/m1_access.sql. Run before M1; pass the result to the reverse as
--   select set_config('watchlist.m1_snapshot', '<the m1_snapshot value>', false);
select jsonb_build_object(
  'bootstrap', (select bootstrap_owner_id from private.app_owner where singleton),
  'functions', (select jsonb_object_agg(p.oid::regprocedure::text, pg_get_functiondef(p.oid))
    from pg_proc p where p.oid in ('private.current_owner_id()'::regprocedure, 'public.stage5_capabilities()'::regprocedure)),
  'rel_acl', (select jsonb_object_agg(c.oid::regclass::text, jsonb_build_object('acl', coalesce(c.relacl::text, ''), 'rls', c.relrowsecurity))
    from pg_class c where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'v', 'S')),
  'col_acl', (select coalesce(jsonb_object_agg(a.attrelid::regclass::text || '.' || a.attname, a.attacl::text), '{}')
    from pg_attribute a join pg_class c on c.oid = a.attrelid
    where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and a.attacl is not null),
  'fn_acl', (select jsonb_object_agg(p.oid::regprocedure::text, coalesce(p.proacl::text, ''))
    from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)),
  'schema_acl', (select nspacl::text from pg_namespace where nspname = 'private'),
  'policies', (select coalesce(jsonb_agg(jsonb_build_object('schema', schemaname, 'table', tablename, 'name', policyname, 'permissive', permissive,
      'roles', roles, 'cmd', cmd, 'using', qual, 'check', with_check)), '[]')
    from pg_policies where schemaname in ('public', 'private')),
  'defaults', (select coalesce(jsonb_agg(jsonb_build_object('role', pg_get_userbyid(defaclrole), 'schema', defaclnamespace::regnamespace::text,
      'type', defaclobjtype::text, 'acl', defaclacl::text)), '[]') from pg_default_acl)
) as m1_snapshot;
