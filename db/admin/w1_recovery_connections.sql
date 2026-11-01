-- W1 recovery: end PostgREST's connections, as a separate run after steps 1 and 2. Run as postgres. Never in one batch with
-- a notification: a batch delivers it at commit, and an error here would cancel it. PostgREST reconnects, and reloads its
-- schema cache and configuration as it does. W1R reports whether postgres may end them, and when it ran: a connection that
-- started later is a new one (w1_recovery_status.sql). Only PostgREST's own connections, by name: anything else connected as
-- authenticator stays. If postgres may not, or the checks that follow don't pass, restart the project instead: the gates
-- are in the database, so they hold through a restart.
select 'W1R|' || json_build_object('may_end', pg_has_role(current_user, 'pg_signal_backend', 'usage'), 'found', count(*), 'ended', count(*) filter (where e), 'at', now()) as result
from (select case when pg_has_role(current_user, 'pg_signal_backend', 'usage') then pg_terminate_backend(pid) else false end as e
  from pg_stat_activity where usename = 'authenticator' and application_name ilike 'postgrest%' and pid <> pg_backend_pid()) t;
