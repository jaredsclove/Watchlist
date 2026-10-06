-- TEST PROJECTS ONLY (Stage 3b-1 hosted checks). Helpers that let two or three
-- concurrent API requests interleave for real: each holds its transaction open
-- (with its locks) for a set time, and a monitor shows who is waiting on whom.
-- Refuses to install unless the database holds only the synthetic fixture (every
-- title starts with "ZZ ", fewer than 100 rows), so it can't land on production.
-- Run as postgres in the test project's SQL Editor, after db/phase3b_org.sql.
-- Remove with the drop statements at the end (or delete the project).
begin;

do $$ begin
  if (select count(*) from public.watchlist_items) >= 100
     or exists (select 1 from public.watchlist_items where title not like 'ZZ %') then
    raise exception 'hosted_helpers: this database holds non-synthetic data; refusing (test projects only)';
  end if;
end $$;

-- Who is waiting on whom right now (every backend; SECURITY DEFINER so anon can see them).
create or replace function public.zz_waits() returns jsonb
language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('pid', a.pid, 'state', a.state, 'wait', a.wait_event_type || ':' || a.wait_event,
    'blocked_by', pg_catalog.pg_blocking_pids(a.pid), 'query', left(a.query, 400), 'xact_age_ms',
    round(extract(epoch from (clock_timestamp() - a.xact_start)) * 1000)) order by a.pid), '[]')
  from pg_catalog.pg_stat_activity a
  where a.datname = current_database() and a.pid <> pg_catalog.pg_backend_pid() and a.state <> 'idle'
    and a.query not ilike '%zz_waits%';
$$;

-- Settings that bound the waits.
create or replace function public.zz_settings() returns jsonb language sql as $$
  select jsonb_build_object('version', version(), 'deadlock_timeout', current_setting('deadlock_timeout'),
    'lock_timeout', current_setting('lock_timeout'), 'statement_timeout', current_setting('statement_timeout'));
$$;

-- Holds a row lock (FOR UPDATE) on one row of tv_shows or watchlist_items for p_seconds, then commits.
create or replace function public.zz_hold_row(p_table text, p_id uuid, p_seconds double precision) returns jsonb
language plpgsql as $$
declare t0 timestamptz := clock_timestamp(); t1 timestamptz;
begin
  if p_table not in ('tv_shows', 'watchlist_items') then raise exception 'zz_hold_row: table %', p_table; end if;
  execute format('select 1 from public.%I where id = $1 for update', p_table) using p_id;
  t1 := clock_timestamp();
  perform pg_sleep(p_seconds);
  return jsonb_build_object('pid', pg_backend_pid(), 'start', t0, 'locked', t1, 'end', clock_timestamp());
end $$;

-- Runs one statement (an app write: an update of watch_with, a membership insert or
-- delete, a choice delete, restore_backup, set_season_watched …) and then keeps the
-- transaction open for p_seconds before committing (p_commit) or rolling back.
create or replace function public.zz_do_then_hold(p_sql text, p_seconds double precision, p_commit boolean default true) returns jsonb
language plpgsql as $$
declare t0 timestamptz := clock_timestamp(); t1 timestamptz; v_result text;
begin
  execute p_sql into v_result;
  t1 := clock_timestamp();
  perform pg_sleep(p_seconds);
  if not p_commit then raise exception 'zz_rollback: % (held % s)', v_result, p_seconds; end if;
  return jsonb_build_object('pid', pg_backend_pid(), 'result', v_result, 'start', t0, 'done', t1, 'end', clock_timestamp());
end $$;

-- Content hashes of every table (rollback-completeness checks), owner and generated columns excluded.
create or replace function public.zz_content() returns jsonb language sql as $$
  select jsonb_build_object(
    'watchlist_items', (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t),
    'tv_shows', (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t),
    'personal_collections', (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.personal_collections t),
    'collection_memberships', (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t),
    'watch_with_choices', (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watch_with_choices t));
$$;

grant execute on function public.zz_waits(), public.zz_settings(), public.zz_hold_row(text, uuid, double precision),
  public.zz_do_then_hold(text, double precision, boolean), public.zz_content() to anon;

commit;

notify pgrst, 'reload schema';

-- Removal:
--   drop function public.zz_waits(), public.zz_settings(), public.zz_hold_row(text, uuid, double precision),
--     public.zz_do_then_hold(text, double precision, boolean), public.zz_content();
