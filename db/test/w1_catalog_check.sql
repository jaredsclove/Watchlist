-- W1's standing check, for a test run or a release preflight after any migration that touches functions: read-only.
-- Fails if a function an application role can execute names xmloption (its session-level SET would stay on a pooled
-- connection, and the guard can't see that), if another function names lib_authorized's marker, if one takes a
-- setting's name from elsewhere, or if a library function has lost the clause.
do $$
declare v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p
  where (coalesce(p.prosrc, '') || coalesce(pg_get_function_sqlbody(p.oid), '')) ~* 'xml\s*_?option' and p.oid not in ('private.lib_authorized()'::regprocedure, 'private.lib_write_on()'::regprocedure)
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'));
  if v_bad is not null then raise exception 'w1 check: an application role can execute a function that names xmloption: %', v_bad; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p
  where (coalesce(p.prosrc, '') || coalesce(pg_get_function_sqlbody(p.oid), '')) like '%w1_reset_ok%' and p.oid <> 'private.lib_authorized()'::regprocedure;
  if v_bad is not null then raise exception 'w1 check: a function other than lib_authorized names watchlist.w1_reset_ok: %', v_bad; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p
  where (coalesce(p.prosrc, '') || coalesce(pg_get_function_sqlbody(p.oid), '')) ~* 'set_config\s*\(\s*[^''[:space:]]'
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'));
  if v_bad is not null then raise exception 'w1 check: an application role can execute a function that takes a setting''s name from elsewhere: %', v_bad; end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p
  where p.pronamespace = 'public'::regnamespace and (p.prosrc like '%lib_write_on%' or p.prosrc like '%watchlist.library_write%' or p.proname = 'restore_backup')
    and not coalesce(p.proconfig @> array['xmloption=document'], false);
  if v_bad is not null then raise exception 'w1 check: the clause is missing from: %', v_bad; end if;
end $$;
