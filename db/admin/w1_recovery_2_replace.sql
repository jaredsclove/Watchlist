-- W1 recovery, step 2 of 5: run after removing the offending default (or function), and again after any later change.
-- Run as postgres. The notifications make PostgREST read its configuration and role settings again. Replacing the
-- connections matters separately: a connection keeps the reset_val it started with, and a session-level SET stays on it.
-- So run w1_recovery_connections.sql next, on its own. A notification alone proves nothing.
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
