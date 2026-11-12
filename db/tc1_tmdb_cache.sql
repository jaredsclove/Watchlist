-- TC1: the member's TMDB cache across devices (next-gen items 2 and 13; episode lists for EP1). One transaction, run as postgres
-- on a contracted-g1 database (backup format 9, access = members) with the pg_cron extension already enabled (Dashboard →
-- Integrations → Cron), because the expiry job below needs cron.schedule.
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.tc1_run', '<a fresh run id, recorded before running>', false);
-- What it adds:
--   * public.tmdb_tv_cache: this member's copy of TMDB facts the page shows: a show's score, vote count and first-air date
--     (kind 'show', season_number -1) and a season's episode list (kind 'season': ids, numbers, titles and the last episode's
--     type and air date). Owner-only like the game cache (M1 policies, nothing for anon, written only through the functions
--     below, library_write_guard). Provider data, replaceable: never in a backup, untouched by restore_backup.
--   * rev: a number from one sequence (private.tmdb_cache_rev), new on every accepted write and never reused, so a row deleted
--     and made again never repeats a revision an older page saw. fetched_at: the database's time of the accepted write.
--   * library_tmdb_cache_put(p_rows): up to 100 rows, each with the revision the page last saw (base_rev; 0: "no row"). A row
--     is written only when the stored row still has that revision (0: only when there is none): protection against conflicting
--     cache writes, not a freshness clock. Every row sent is answered with what is stored now, written or not.
--   * library_tmdb_cache_purge(): empties the member's cache.
--   * private.tmdb_cache_expire() and the daily Cron job watchlist-tmdb-cache-expiry: deletes rows of public.tmdb_tv_cache, and
--     nothing else, whose fetched_at is older than 150 days (TMDB's API terms forbid caching for longer than six months). The
--     job can't run while the project is paused; its first run after resuming deletes every row past the limit then.
--   * stage5_capabilities() adds tc1: 1. Phase (contracted-g1) and backup format (9) are unchanged, so an open older page
--     keeps working; it simply doesn't use the cache.
-- Existing rows are not changed: every existing table's rows are fingerprinted before and checked after.
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate execution). Never rerun
-- to find out; a rerun is refused once this committed. No rollback (fix-forward); earlier definitions are in git.
begin;
select set_config('application_name', 'watchlist-tc1-' || coalesce(nullif(current_setting('watchlist.tc1_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;
do $$
begin
  if exists (select 1 from private.migration_runs r where r.migration = 'tc1') then raise exception 'tc1: already installed; nothing was changed'; end if;
end $$;

-- ── 1. Preconditions and the before-state ─────────────────────────────────────
create temp table tc1_tables (t text primary key) on commit drop;
insert into tc1_tables values ('private.library_members'), ('public.tv_shows'), ('public.watchlist_items'), ('public.personal_collections'),
  ('public.collection_memberships'), ('public.watch_with_choices'), ('public.custom_collections'), ('public.catalog_show_links'),
  ('public.catalog_film_links'), ('public.episode_marks'), ('public.update_setup'), ('public.collection_definitions'),
  ('public.collection_exclusions'), ('public.update_holds'), ('public.record_aliases'), ('public.membership_removals'),
  ('public.show_update_settings'), ('public.research_briefs'), ('public.research_imports'), ('public.update_findings'),
  ('public.watch_queues'), ('public.queue_entries'), ('public.game_settings'), ('public.game_entries'), ('public.game_follows'),
  ('public.game_decisions'), ('public.game_collections'), ('public.game_collection_members'), ('public.game_titles');
create or replace function pg_temp.tc1_fp() returns text language plpgsql as $$
declare r record; v text; v_all text := '';
begin
  for r in select t from tc1_tables order by t loop
    execute format('select coalesce(md5(string_agg(md5(to_jsonb(x)::text), '','' order by md5(to_jsonb(x)::text))), '''') from %s x', r.t) into v;
    v_all := v_all || r.t || ':' || v || ';';
  end loop;
  return md5(v_all);
end $$;
create temp table tc1_ctx on commit drop as
select nullif(current_setting('watchlist.tc1_run', true), '') as run_id, pg_temp.tc1_fp() as library_before,
  (select prosrc from pg_proc where oid = 'public.restore_backup(jsonb, boolean)'::regprocedure) as restore_before;
do $$
declare c record;
begin
  select * into c from tc1_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'tc1: set watchlist.tc1_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'tc1: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-g1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '9'
     or public.stage5_capabilities() ->> 'access' is distinct from 'members' or not exists (select 1 from private.migration_runs r where r.migration = 'g1') then
    raise exception 'tc1: expected G1 (phase contracted-g1, backup format 9, access = members); nothing was changed';
  end if;
  if to_regclass('public.tmdb_tv_cache') is not null or to_regclass('private.tmdb_cache_rev') is not null then
    raise exception 'tc1: the cache already exists; nothing was changed';
  end if;
  if to_regprocedure('cron.schedule(text, text, text)') is null then
    raise exception 'tc1: the pg_cron extension isn''t enabled (Dashboard → Integrations → Cron); nothing was changed';
  end if;
  if exists (select 1 from cron.job j where j.jobname = 'watchlist-tmdb-cache-expiry') then
    raise exception 'tc1: a Cron job named watchlist-tmdb-cache-expiry already exists; nothing was changed';
  end if;
  if to_regprocedure('private.library_write_guard()') is null or to_regprocedure('private.current_owner_id()') is null
     or to_regprocedure('private.is_member()') is null or to_regprocedure('private.research_enabled()') is null then
    raise exception 'tc1: a helper it relies on is missing; nothing was changed';
  end if;
end $$;

-- ── 2. The table, its guard and policies ──────────────────────────────────────
create sequence private.tmdb_cache_rev as bigint;
create table public.tmdb_tv_cache (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  kind text not null,
  tmdb_id integer not null,
  season_number integer not null,
  data jsonb not null,
  rev bigint not null default nextval('private.tmdb_cache_rev'),
  fetched_at timestamptz not null default now(),
  constraint tmdb_tv_cache_pkey primary key (id),
  constraint tmdb_tv_cache_key unique (user_id, kind, tmdb_id, season_number),
  constraint tmdb_tv_cache_kind_check check ((kind = 'show' and season_number = -1) or (kind = 'season' and season_number between 0 and 9999)),
  constraint tmdb_tv_cache_tmdb_check check (tmdb_id > 0),
  constraint tmdb_tv_cache_data_check check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 40000)
);
create index tmdb_tv_cache_fetched_idx on public.tmdb_tv_cache using btree (fetched_at);
comment on table public.tmdb_tv_cache is 'TC1: this member''s cache of TMDB show details and season episode lists. Replaceable, never in backups, untouched by restore; rows older than 150 days are deleted daily (watchlist-tmdb-cache-expiry).';
create trigger tmdb_tv_cache_write_guard before insert or update or delete on public.tmdb_tv_cache for each row execute function private.library_write_guard();
alter table public.tmdb_tv_cache enable row level security;
create policy owner_select on public.tmdb_tv_cache for select to authenticated using (user_id = (select auth.uid()));
create policy owner_insert on public.tmdb_tv_cache for insert to authenticated with check (user_id = (select auth.uid()));
create policy owner_update on public.tmdb_tv_cache for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy owner_delete on public.tmdb_tv_cache for delete to authenticated using (user_id = (select auth.uid()));
create policy members_only on public.tmdb_tv_cache as restrictive for all to authenticated using ((select private.is_member())) with check ((select private.is_member()));

-- ── 3. Functions ─────────────────────────────────────────────────────────────────
-- Up to 100 rows: [{kind, tmdb_id, season_number, data, base_rev}], one per key. A row is written only when the stored row
-- still has base_rev (0: only when there is no row), so a page's write based on what it read can't replace a write made since
-- by another page or device. Answer: { rows: [{kind, tmdb_id, season_number, written, rev, data, fetched_at}] }, one per row
-- sent, with what is stored now (rev null: no row).
create function public.library_tmdb_cache_put(p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); r jsonb; v_kind text; v_tmdb integer; v_season integer; v_base bigint; v_n integer;
  v_out jsonb := '[]'::jsonb; v_row public.tmdb_tv_cache;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 100
     or exists (select 1 from jsonb_array_elements(p_rows) x where jsonb_typeof(x) is distinct from 'object'
       or (x ->> 'kind') is null or (x ->> 'kind') not in ('show', 'season')
       or jsonb_typeof(x -> 'tmdb_id') is distinct from 'number' or jsonb_typeof(x -> 'season_number') is distinct from 'number'
       or jsonb_typeof(x -> 'base_rev') is distinct from 'number' or jsonb_typeof(x -> 'data') is distinct from 'object'
       or (x ->> 'tmdb_id') !~ '^[0-9]{1,9}$' or (x ->> 'season_number') !~ '^-?[0-9]{1,4}$' or (x ->> 'base_rev') !~ '^[0-9]{1,18}$'
       or ((x ->> 'kind') = 'season' and jsonb_typeof(x -> 'data' -> 'ids') is distinct from 'array'))
     or (select count(*) from jsonb_array_elements(p_rows)) <> (select count(distinct (x ->> 'kind', x ->> 'tmdb_id', x ->> 'season_number')) from jsonb_array_elements(p_rows) x) then
    raise exception 'invalid_input: cache rows' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('watchlist.tmdb ' || v_owner::text, 0));
  perform set_config('watchlist.library_write', 'on', true);
  for r in select x from jsonb_array_elements(p_rows) x loop
    v_kind := r ->> 'kind'; v_tmdb := (r ->> 'tmdb_id')::integer; v_season := (r ->> 'season_number')::integer; v_base := (r ->> 'base_rev')::bigint;
    if v_base = 0 then
      insert into public.tmdb_tv_cache (kind, tmdb_id, season_number, data) values (v_kind, v_tmdb, v_season, r -> 'data')
      on conflict (user_id, kind, tmdb_id, season_number) do nothing;
    else
      update public.tmdb_tv_cache c set data = r -> 'data', rev = nextval('private.tmdb_cache_rev'), fetched_at = now()
      where c.user_id = v_owner and c.kind = v_kind and c.tmdb_id = v_tmdb and c.season_number = v_season and c.rev = v_base;
    end if;
    get diagnostics v_n = row_count;
    select * into v_row from public.tmdb_tv_cache c where c.user_id = v_owner and c.kind = v_kind and c.tmdb_id = v_tmdb and c.season_number = v_season;
    v_out := v_out || jsonb_build_array(jsonb_build_object('kind', v_kind, 'tmdb_id', v_tmdb, 'season_number', v_season, 'written', v_n = 1,
      'rev', v_row.rev, 'data', v_row.data, 'fetched_at', v_row.fetched_at));
  end loop;
  perform set_config('watchlist.library_write', '', true);
  return jsonb_build_object('rows', v_out);
end $$;

-- Empties this member's TMDB cache (the provider's data, not the member's; the page fills it again).
create function public.library_tmdb_cache_purge() returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); v_n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('watchlist.tmdb ' || v_owner::text, 0));
  perform set_config('watchlist.library_write', 'on', true);
  delete from public.tmdb_tv_cache where user_id = v_owner;
  get diagnostics v_n = row_count;
  perform set_config('watchlist.library_write', '', true);
  return jsonb_build_object('removed', v_n);
end $$;

-- The Cron job's one statement: rows of this cache, and only these, older than 150 days. Run by the job's owner; no API role
-- can execute it.
create function private.tmdb_cache_expire() returns integer
language plpgsql security invoker set search_path = '' as $$
declare v_n integer;
begin
  perform set_config('watchlist.library_write', 'on', true);
  delete from public.tmdb_tv_cache where fetched_at < now() - interval '150 days';
  get diagnostics v_n = row_count;
  perform set_config('watchlist.library_write', '', true);
  return v_n;
end $$;
select cron.schedule('watchlist-tmdb-cache-expiry', '23 4 * * *', 'select private.tmdb_cache_expire()');

-- ── 4. Grants ────────────────────────────────────────────────────────────────────
-- Explicit, then verified: default privileges owned by supabase_admin can't be relied on.
revoke all on public.tmdb_tv_cache from public, anon, authenticated;
grant select, delete on public.tmdb_tv_cache to authenticated;
-- (the functions run as the caller; the guard still refuses any write outside them)
grant insert (kind, tmdb_id, season_number, data), update (data, rev, fetched_at) on public.tmdb_tv_cache to authenticated;
revoke all on sequence private.tmdb_cache_rev from public, anon, authenticated;
grant usage on sequence private.tmdb_cache_rev to authenticated;
revoke all on function public.library_tmdb_cache_put(jsonb), public.library_tmdb_cache_purge(), private.tmdb_cache_expire() from public, anon, authenticated;
grant execute on function public.library_tmdb_cache_put(jsonb), public.library_tmdb_cache_purge() to authenticated;

-- ── 5. The capability and the run record ────────────────────────────────────────
create or replace function public.stage5_capabilities() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted-g1', 'backup_format', 9, 'b45', 1, 'ep1', 1, 'cu1', 1, 'q1', 1, 'g1', 1, 'tc1', 1, 'access', 'members',
    'member', private.is_member(), 'research', private.research_enabled(),
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;
revoke execute on function public.stage5_capabilities() from public, anon;
grant execute on function public.stage5_capabilities() to authenticated;
insert into private.migration_runs (run_id, migration) select run_id, 'tc1' from tc1_ctx;

-- ── 6. Verify before commit ─────────────────────────────────────────────────────
do $$
declare c record; f text;
begin
  select * into c from tc1_ctx;
  if pg_temp.tc1_fp() is distinct from c.library_before then raise exception 'tc1: an existing library row, game or member changed'; end if;
  if (select prosrc from pg_proc where oid = 'public.restore_backup(jsonb, boolean)'::regprocedure) is distinct from c.restore_before then raise exception 'tc1: restore_backup changed'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.tmdb_tv_cache'::regclass)
     or (select count(*) from pg_policies where schemaname = 'public' and tablename = 'tmdb_tv_cache') <> 5
     or has_table_privilege('anon', 'public.tmdb_tv_cache', 'select,insert,update,delete,truncate,references,trigger')
     or has_table_privilege('authenticated', 'public.tmdb_tv_cache', 'insert,update,truncate,references,trigger')
     or has_sequence_privilege('anon', 'private.tmdb_cache_rev', 'usage,select,update')
     or (select count(*) from pg_trigger where tgrelid = 'public.tmdb_tv_cache'::regclass and not tgisinternal and tgname like '%write_guard') <> 1 then
    raise exception 'tc1: public.tmdb_tv_cache isn''t closed as designed';
  end if;
  foreach f in array array['public.library_tmdb_cache_put(jsonb)', 'public.library_tmdb_cache_purge()', 'public.stage5_capabilities()'] loop
    if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')
       or (select prosecdef from pg_proc where oid = f::regprocedure) then
      raise exception 'tc1: % isn''t executable as designed', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'private.tmdb_cache_expire()', 'execute') or has_function_privilege('authenticated', 'private.tmdb_cache_expire()', 'execute') then
    raise exception 'tc1: the expiry function is executable by an API role';
  end if;
  if (select count(*) from cron.job j where j.jobname = 'watchlist-tmdb-cache-expiry' and j.schedule = '23 4 * * *' and j.command = 'select private.tmdb_cache_expire()') <> 1 then
    raise exception 'tc1: the expiry job isn''t scheduled as designed';
  end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-g1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '9'
     or (public.stage5_capabilities() ->> 'tc1') is distinct from '1' then
    raise exception 'tc1: the capability isn''t as designed: %', public.stage5_capabilities();
  end if;
end $$;

select 'TC1|' || json_build_object('run', (select run_id from tc1_ctx)) as result;

notify pgrst, 'reload schema';
commit;
