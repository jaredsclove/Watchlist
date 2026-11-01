-- W1 recovery, step 2 of 5: run after removing the offending default (or function), and again after any later change.
-- Run as postgres. The notifications make PostgREST read its configuration and role settings again. Ending the connections
-- matters separately: a connection keeps the reset_val it started with, and a session-level SET stays on it. If PostgREST
-- doesn't answer as step 3's checks expect, restart it (on a hosted project, from the dashboard). A notification alone
-- proves nothing.
do $$
begin
  if to_regclass('private.w1_recovery') is null then raise exception 'w1 recovery: step 1 has not run; nothing was changed'; end if;
  if exists (select 1 from pg_db_role_setting s, unnest(s.setconfig) x where lower(x) like 'xmloption=%' or lower(x) like 'watchlist.w1_reset_ok=%')
     or (select reset_val from pg_settings where name = 'xmloption') <> 'content' then
    raise exception 'w1 recovery: the default is still configured; remove it first. Nothing was changed';
  end if;
end $$;
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
select pg_terminate_backend(pid) from pg_stat_activity where usename = 'authenticator' and pid <> pg_backend_pid();
