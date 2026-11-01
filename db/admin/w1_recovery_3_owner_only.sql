-- W1 recovery, step 3 of 5: give schema usage back, so that only the pre-request gate stays. Run as postgres, and only
-- after a request has shown that gate at work: an ordinary token refused with library_under_repair. Otherwise this opens
-- the API to everyone. Then, with the owner's token through the real API, on enough requests to cover the pool: a direct
-- write refused with library_write_required, a library function working, and an ordinary token still refused.
begin;
do $$
declare v_acl text;
begin
  if to_regclass('private.w1_recovery') is null then raise exception 'w1 recovery: step 1 has not run; nothing was changed'; end if;
  execute 'select private_acl from private.w1_recovery' into v_acl;
  grant usage on schema private to authenticated;
  if (select nspacl::text from pg_namespace where nspname = 'private') is distinct from v_acl then
    raise exception 'w1 recovery: schema access isn''t what it was; nothing was changed';
  end if;
end $$;
commit;
