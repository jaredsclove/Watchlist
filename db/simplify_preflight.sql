-- Read-only, for db/simplify_restore_cleanup.sql: run as postgres before it, with the owner's authorization. Rolls back whatever it runs.
-- The result is one JSON value. Save it privately, never in the repository: `archive` holds the recovery archive and rollback tables the
-- migration deletes, which an ordinary format-7 library backup doesn't contain. `catalog` is what to compare with the migration's drop lists.
begin isolation level repeatable read read only;
select json_build_object(
  'phase', public.stage5_capabilities() ->> 'phase',
  'backup_format', public.stage5_capabilities() ->> 'backup_format',
  'archive', json_build_object(
    'stage5_recovery_records', (select coalesce(json_agg(r), '[]') from private.stage5_recovery_records r),
    'stage5_recovery_collections', (select coalesce(json_agg(r), '[]') from private.stage5_recovery_collections r),
    'stage5_recovery_othertv', (select coalesce(json_agg(r), '[]') from private.stage5_recovery_othertv r),
    'stage5_recovery_meta', (select coalesce(json_agg(r), '[]') from private.stage5_recovery_meta r),
    'b45_meta', (select coalesce(json_agg(r), '[]') from private.b45_meta r),
    'b45_saved', (select coalesce(json_agg(r), '[]') from private.b45_saved r)),
  'catalog', json_build_object(
    'functions', (select json_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' order by 1)
                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')),
    'tables', (select json_agg(schemaname || '.' || tablename order by 1) from pg_tables where schemaname in ('public', 'private')),
    'triggers', (select json_agg(c.relname || '.' || t.tgname || ' ' || t.tgfoid::regproc order by 1) from pg_trigger t join pg_class c on c.oid = t.tgrelid
                 join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ('public', 'private')))
)::text as preflight;
rollback;
