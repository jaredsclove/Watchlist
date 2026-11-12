-- Local runs only (PGlite and a bare PostgreSQL have no pg_cron): the part of pg_cron that db/tc1_tmdb_cache.sql uses, so the
-- migration can be replayed. Jobs are recorded, never run; tests run their command themselves.
create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, schedule text not null, command text not null, jobname text unique);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint
language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid
$$;
create or replace function cron.unschedule(job_name text) returns boolean
language sql as $$ with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d) $$;
