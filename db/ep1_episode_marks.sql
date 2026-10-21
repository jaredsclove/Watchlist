-- EP1: episode progress within seasons (next-gen item 1). One transaction, run as postgres on a
-- contracted-b45 database with M1 owner-only access (access = members).
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.ep1_run', '<a fresh run id, recorded before running>', false);
-- What it adds:
--   * public.episode_marks: one row per watched episode of a TMDB-matched season (an id like every
--     library row, the season, the TMDB episode id, the episode number when it was marked). Owner-only like every library table
--     (M1 policies; nothing for anon). No dates and no titles: episode lists and totals are
--     reference data the page fetches from TMDB and never stores here. A mark is removed only
--     explicitly, or with its season (delete, restore).
--   * public.library_set_episode_marks: sets or clears the given episodes of one season, refused
--     while the season is watched or skipped (episode editing is locked; the season's flags are
--     never changed here, and set_season_watched / set_season_skipped never change marks).
--   * public.delete_tv_season(p_row_id, p_marks_expected default null) replaces the one-argument
--     function (dropped: no unguarded signature remains). A call without a count — a page from
--     before this migration — is refused for a season that has marks; a count that differs from the
--     marks stored is refused as a stale delete. The season and its marks go in one statement.
--   * public.restore_backup takes format 6 (format 5's eight tables plus episode_marks). The format-5
--     function is kept unchanged as private.restore_backup_v5 and does the eight tables; the marks are
--     restored and verified after it, in the same transaction.
--   * stage5_capabilities(): phase contracted-ep1, backup_format 6. A page from before this
--     migration re-reads the phase before every backup and restore and refuses them; its ordinary
--     writes continue (they don't touch marks), and the database refuses its delete of a marked season.
-- Order: 0. the run label, every lock, then the checks; 1. preconditions and the before-state;
-- 2. the table, its guards and policies; 3. functions; 4. grants; 5. the capability and the run
-- record; 6. verify before commit.
-- Completion: this run committed if and only if private.migration_runs holds its run id (a fresh read
-- in a separate execution). A missing row is "not committed" only once the transaction is known to have
-- ended (the run label observed, then absent); otherwise the outcome is unknown. Never rerun to find
-- out: every attempt needs a fresh run id, and a rerun is refused once this committed. No rollback
-- (fix-forward); test environments only: db/test/ep1_reverse.sql.
begin;
select set_config('application_name', 'watchlist-ep1-' || coalesce(nullif(current_setting('watchlist.ep1_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';

-- ── 0. Locks before any check ──────────────────────────────────────────────────
lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
  public.watch_with_choices, public.custom_collections, public.catalog_show_links, public.catalog_film_links,
  private.stage5_recovery_records, private.stage5_recovery_collections, private.stage5_recovery_othertv,
  private.stage5_recovery_meta, private.library_members, private.migration_runs in access exclusive mode;

-- ── 1. Preconditions and the before-state ──────────────────────────────────────
create temp table ep1_ctx on commit drop as select nullif(current_setting('watchlist.ep1_run', true), '') as run_id;
create temp table ep1_tables (schema_name text, table_name text) on commit drop;
insert into ep1_tables values
  ('public', 'watchlist_items'), ('public', 'tv_shows'), ('public', 'custom_collections'), ('public', 'personal_collections'),
  ('public', 'collection_memberships'), ('public', 'watch_with_choices'), ('public', 'catalog_show_links'), ('public', 'catalog_film_links'),
  ('private', 'stage5_recovery_records'), ('private', 'stage5_recovery_collections'), ('private', 'stage5_recovery_othertv'),
  ('private', 'stage5_recovery_meta'), ('private', 'library_members');

do $$
declare c record;
begin
  select * into c from ep1_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'ep1: set watchlist.ep1_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if to_regclass('public.episode_marks') is not null then raise exception 'ep1: already applied (public.episode_marks exists); nothing was changed'; end if;
  if private.tv_stage() <> 'final' then raise exception 'ep1: expected stage final, found %', private.tv_stage(); end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-b45' then
    raise exception 'ep1: expected phase contracted-b45, found %', public.stage5_capabilities() ->> 'phase';
  end if;
  if public.stage5_capabilities() ->> 'access' is distinct from 'members' then raise exception 'ep1: expected M1 owner-only access (access = members); nothing was changed'; end if;
  if to_regclass('private.migration_runs') is null then raise exception 'ep1: private.migration_runs is missing; nothing was changed'; end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'ep1: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
  if to_regprocedure('public.delete_tv_season(uuid)') is null or to_regprocedure('public.restore_backup(jsonb, boolean)') is null
     or to_regprocedure('private.restore_backup_v5(jsonb, boolean)') is not null
     or to_regprocedure('public.library_set_episode_marks(uuid, jsonb, boolean, jsonb)') is not null then
    raise exception 'ep1: the functions it replaces are not as expected; nothing was changed';
  end if;
  if (select prosrc from pg_proc where oid = 'public.restore_backup(jsonb, boolean)'::regprocedure) !~ 'v_version is distinct from ''5''' then
    raise exception 'ep1: public.restore_backup is not the format-5 function; nothing was changed';
  end if;
end $$;

-- Fingerprints of every row (user_id included: nothing in them changes), in a stable order.
create or replace function pg_temp.ep1_fp(p_schema text, p_table text) returns text language plpgsql as $$
declare v text;
begin
  execute format('select md5(coalesce(string_agg(x, ''|'' order by x), '''')) from (select to_jsonb(t)::text x from %I.%I t) s', p_schema, p_table) into v;
  return v;
end $$;
create temp table ep1_before on commit drop as
select schema_name, table_name, pg_temp.ep1_fp(schema_name, table_name) fp from ep1_tables;
-- What authenticated may execute now (the grant check compares against it).
-- Whether the synthetic write checks of section 6 ran (a row is added after their rolled-back subtransaction).
create temp table ep1_checked (ran boolean) on commit drop;
create temp table ep1_fn_before on commit drop as
select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'private') and has_function_privilege('authenticated', p.oid, 'execute');

-- ── 2. The table, its guards and policies ──────────────────────────────────────
-- A mark belongs to a season of the same owner (and goes with it).
alter table public.watchlist_items add constraint watchlist_items_id_owner_key unique (id, user_id);
create table public.episode_marks (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  season_id uuid not null,
  tmdb_episode_id integer not null constraint episode_marks_episode_check check (tmdb_episode_id > 0),
  episode_number integer not null constraint episode_marks_number_check check (episode_number >= 0),
  constraint episode_marks_pkey primary key (id),
  constraint episode_marks_episode_key unique (season_id, tmdb_episode_id),
  constraint episode_marks_season_fkey foreign key (season_id, user_id)
    references public.watchlist_items (id, user_id) on update cascade on delete cascade
);
comment on table public.episode_marks is 'EP1: watched episodes of TMDB-matched seasons (no dates, no titles).';

-- Marks change only through library_set_episode_marks, a season delete or a restore (each sets
-- watchlist.library_write); a direct insert or delete, and a direct delete of a marked season, is refused.
create trigger episode_marks_write_guard before insert or update or delete on public.episode_marks
  for each row execute function private.library_write_guard();

-- Only a TMDB-matched season takes marks.
create function private.ep1_mark_season_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- (a season that doesn't exist is the foreign key's to refuse)
  if exists (select 1 from public.watchlist_items w where w.id = new.season_id and w.user_id = new.user_id)
     and not exists (select 1 from public.watchlist_items w where w.id = new.season_id and w.user_id = new.user_id and not w.is_film
                     and w.show_id is not null and w.media_type = 'tv' and w.tmdb_id is not null and w.season_number is not null) then
    raise exception 'season_unmatched: Only a season matched to TMDB has episode marks. Nothing was changed.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.ep1_mark_season_check() from public;
create trigger episode_marks_season_check before insert or update on public.episode_marks
  for each row execute function private.ep1_mark_season_check();

-- A season with marks keeps its identity (no path changes a matched season's identity today; this
-- makes sure marks can never follow a season onto other episodes).
create function private.ep1_identity_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.episode_marks m where m.season_id = old.id) then
    raise exception 'episode_marks_kept: This season has episode marks, so its identity can''t change. Nothing was changed.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.ep1_identity_guard() from public;
create trigger watchlist_items_ep1_identity_guard before update of id, media_type, tmdb_id, season_number, show_id on public.watchlist_items
  for each row when (new.id is distinct from old.id or new.media_type is distinct from old.media_type or new.tmdb_id is distinct from old.tmdb_id
                     or new.season_number is distinct from old.season_number or new.show_id is distinct from old.show_id)
  execute function private.ep1_identity_guard();

-- M1's policies: owner-only per command plus the restrictive membership policy.
alter table public.episode_marks enable row level security;
create policy owner_select on public.episode_marks for select to authenticated using (user_id = (select auth.uid()));
create policy owner_insert on public.episode_marks for insert to authenticated with check (user_id = (select auth.uid()));
create policy owner_delete on public.episode_marks for delete to authenticated using (user_id = (select auth.uid()));
create policy members_only on public.episode_marks as restrictive for all to authenticated
  using ((select private.is_member())) with check ((select private.is_member()));

-- ── 3. Functions ───────────────────────────────────────────────────────────────
-- Sets (p_watched) or clears the given episodes of one season. p_expected is the season's
-- { watched, skipped } as the page showed it; a watched or skipped season is locked. Setting a
-- mark that exists, or clearing one that doesn't, changes nothing (the same request twice has the
-- same effect). Returns the season's marks after the change. Locks the show, then the season (the
-- order every season write and delete_tv_season use).
create function public.library_set_episode_marks(p_season_id uuid, p_expected jsonb, p_watched boolean, p_episodes jsonb)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_set_episode_marks', 'final');
  r public.watchlist_items;
begin
  if p_season_id is null or p_watched is null or jsonb_typeof(p_expected) is distinct from 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(p_expected) k) is distinct from array['skipped', 'watched']::text[]
     or jsonb_typeof(p_episodes) is distinct from 'array' or jsonb_array_length(p_episodes) not between 1 and 500
     or exists (select 1 from jsonb_array_elements(p_episodes) e
                where jsonb_typeof(e) is distinct from 'object'
                   or jsonb_typeof(e -> 'tmdb_episode_id') is distinct from 'number' or (e ->> 'tmdb_episode_id') !~ '^[1-9][0-9]{0,8}$'
                   or (p_watched and (jsonb_typeof(e -> 'episode_number') is distinct from 'number' or (e ->> 'episode_number') !~ '^[0-9]{1,6}$')))
     or (select count(distinct e ->> 'tmdb_episode_id') from jsonb_array_elements(p_episodes) e) <> jsonb_array_length(p_episodes) then
    raise exception 'invalid_input: episode marks' using errcode = '22023';
  end if;
  select * into r from public.watchlist_items where id = p_season_id and user_id = v_owner and not is_film;
  if r.id is null then perform private.lib_refuse('target_missing', 'This season is no longer on your list, so nothing was changed.'); end if;
  if r.show_id is not null then perform 1 from public.tv_shows where id = r.show_id and user_id = v_owner for update; end if;
  select * into r from public.watchlist_items where id = r.id and user_id = v_owner for update;
  if r.id is null then perform private.lib_refuse('target_missing', 'This season is no longer on your list, so nothing was changed.'); end if;
  if jsonb_build_object('watched', r.watched, 'skipped', r.skipped) is distinct from p_expected then perform private.b45_changed(); end if;
  if r.show_id is null or r.media_type is distinct from 'tv' or r.tmdb_id is null or r.season_number is null then
    perform private.lib_refuse('season_unmatched', 'Only a season matched to TMDB has episode marks. Nothing was changed.');
  end if;
  if r.watched or r.skipped then
    perform private.lib_refuse('season_locked', 'This season is marked watched or skipped, so its episodes can''t be changed. Change that first. Nothing was changed.');
  end if;
  perform private.lib_write_on();
  if p_watched then
    insert into public.episode_marks (season_id, tmdb_episode_id, episode_number)
    select r.id, (e ->> 'tmdb_episode_id')::integer, (e ->> 'episode_number')::integer from jsonb_array_elements(p_episodes) e
    on conflict (season_id, tmdb_episode_id) do nothing;
  else
    delete from public.episode_marks m where m.season_id = r.id and m.user_id = v_owner
      and m.tmdb_episode_id in (select (e ->> 'tmdb_episode_id')::integer from jsonb_array_elements(p_episodes) e);
  end if;
  return jsonb_build_object('season_id', r.id, 'watched', r.watched, 'skipped', r.skipped,
    'marks', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'tmdb_episode_id', m.tmdb_episode_id, 'episode_number', m.episode_number)
                                         order by m.episode_number, m.tmdb_episode_id)
                       from public.episode_marks m where m.season_id = r.id), '[]'::jsonb));
end $$;

-- Deletes one TV season and its episode marks; a show left with no seasons goes too (its governance
-- link and memberships with it). p_marks_expected is the number of marks the page showed: null (a page
-- from before EP1, which shows none) is refused for a season that has marks; another number than the
-- one stored is refused as stale. Skip never deletes; catalog entries are skipped by the app.
drop function public.delete_tv_season(uuid);
create function public.delete_tv_season(p_row_id uuid, p_marks_expected integer default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('delete_tv_season', 'final');
  r public.watchlist_items;
  v_show public.tv_shows;
  v_marks integer;
  v_show_deleted boolean := false;
begin
  if p_marks_expected < 0 then raise exception 'invalid_input: p_marks_expected' using errcode = '22023'; end if;
  select * into r from public.watchlist_items where id = p_row_id and user_id = v_owner and not is_film;
  if r.id is null then raise exception 'not_found: TV season' using errcode = 'P0002'; end if;
  if r.show_id is not null then
    select * into v_show from public.tv_shows where id = r.show_id and user_id = v_owner for update;
  end if;
  select * into r from public.watchlist_items where id = r.id and user_id = v_owner for update;
  if r.id is null then raise exception 'not_found: TV season' using errcode = 'P0002'; end if;
  select count(*) into v_marks from public.episode_marks where season_id = r.id;
  if p_marks_expected is null and v_marks > 0 then
    perform private.lib_refuse('update_required', format('This season has %s episode mark%s, which this page doesn''t show, so it wasn''t deleted. Reload the page. Nothing was changed.',
      v_marks, case when v_marks = 1 then '' else 's' end));
  end if;
  if p_marks_expected is not null and p_marks_expected <> v_marks then perform private.b45_changed(); end if;
  perform private.lib_write_on();
  delete from public.watchlist_items where id = r.id and user_id = v_owner;
  if v_show.id is not null and not exists (select 1 from public.watchlist_items where show_id = v_show.id) then
    delete from public.tv_shows where id = v_show.id and user_id = v_owner;
    v_show_deleted := true;
  end if;
  return jsonb_build_object('deleted_row_id', r.id, 'show_id', v_show.id, 'show_deleted', v_show_deleted, 'marks_deleted', v_marks);
end $$;

-- restore_backup, format 6: the format-5 function (unchanged, now private) restores the eight
-- tables; then the marks are inserted and verified, in the same transaction. A format 3, 4 or 5 file
-- is converted in the page first (format 5 → 6 adds no marks). A converted document may carry
-- conversion { source_format: '3' | '4' | '5', … }; a recovery section only with source '3' (the
-- format-5 function's rules).
alter function public.restore_backup(jsonb, boolean) rename to restore_backup_v5;
alter function public.restore_backup_v5(jsonb, boolean) set schema private;
create function public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean default false)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_version text := p_backup ->> 'formatVersion';
  v_tables jsonb := p_backup -> 'tables';
  v_counts jsonb := p_backup -> 'rowCounts';
  v_conv jsonb := p_backup -> 'conversion';
  v_marks jsonb;
  v_inner jsonb;
  v_out jsonb;
  v_k int;
  v_constraint text;
begin
  if p_backup ->> 'format' is distinct from 'watchlist-tracker-backup' then
    raise exception 'restore_invalid: not a Watchlist backup' using errcode = '22023';
  end if;
  if v_version = '1' then
    raise exception 'restore_invalid: format 1 backups predate TV shows and can no longer be restored' using errcode = '22023';
  elsif v_version = '2' then
    raise exception 'restore_invalid: format 2 backups predate personal collections and can''t be restored here' using errcode = '22023';
  elsif v_version in ('3', '4', '5') then
    raise exception 'restore_invalid: format % backups are converted in the page first (Restore shows what the conversion keeps and what it can''t); nothing was changed', v_version
      using errcode = '22023';
  elsif v_version is distinct from '6' then
    raise exception 'restore_invalid: unsupported backup format %', coalesce(v_version, '(none)') using errcode = '22023';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_backup) k)
     <@ array['conversion', 'exportedAt', 'format', 'formatVersion', 'recovery', 'rowCounts', 'tables']::text[] is not true then
    raise exception 'restore_invalid: unexpected top-level fields' using errcode = '22023';
  end if;
  if jsonb_typeof(v_tables) is distinct from 'object' or jsonb_typeof(v_counts) is distinct from 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(v_tables) k)
        is distinct from array['catalog_film_links', 'catalog_show_links', 'collection_memberships', 'custom_collections', 'episode_marks',
                               'personal_collections', 'tv_shows', 'watch_with_choices', 'watchlist_items']::text[] then
    raise exception 'restore_invalid: unexpected set of tables for format 6' using errcode = '22023';
  end if;
  v_marks := v_tables -> 'episode_marks';
  if jsonb_typeof(v_marks) is distinct from 'array' then
    raise exception 'restore_invalid: episode_marks is not a list of rows' using errcode = '22023';
  end if;
  if (v_counts ->> 'episode_marks') is distinct from jsonb_array_length(v_marks)::text then
    raise exception 'restore_invalid: rowCounts.episode_marks does not match its rows' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_marks) r
             where jsonb_typeof(r) is distinct from 'object'
                or (select array_agg(k order by k collate "C") from jsonb_object_keys(r) k) is distinct from array['episode_number', 'id', 'season_id', 'tmdb_episode_id']::text[]) then
    raise exception 'restore_invalid: a episode_marks row does not have exactly the expected columns' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_marks) r
             where jsonb_typeof(r -> 'id') is distinct from 'string' or (r ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'restore_invalid: an episode mark in the backup has an id that isn''t a uuid, so nothing was changed' using errcode = '22023';
  end if;
  if v_conv is not null and (jsonb_typeof(v_conv) is distinct from 'object' or (v_conv ->> 'source_format') not in ('3', '4', '5')) then
    raise exception 'restore_invalid: the conversion record is malformed' using errcode = '22023';
  end if;
  if v_conv is not null and (v_conv ->> 'source_format') = '5'
     and (coalesce(v_conv ->> 'source_sha256', '') !~ '^[0-9a-f]{64}$' or coalesce(v_conv ->> 'converter_version', '') = ''
          or coalesce(v_conv ->> 'source_exported_at', '') = '' or p_backup ? 'recovery') then
    raise exception 'restore_invalid: the conversion record is malformed' using errcode = '22023';
  end if;

  -- The eight format-5 tables, by the format-5 function (a format-5 conversion record is checked above;
  -- format 3 / 4 records go on to it unchanged).
  v_inner := (p_backup - 'formatVersion' - 'tables' - 'rowCounts' - 'conversion')
    || jsonb_build_object('formatVersion', 5, 'tables', v_tables - 'episode_marks', 'rowCounts', v_counts - 'episode_marks')
    || case when v_conv is not null and (v_conv ->> 'source_format') <> '5' then jsonb_build_object('conversion', v_conv) else '{}'::jsonb end;
  v_out := private.restore_backup_v5(v_inner, p_allow_v1_reset);

  -- The owner's seasons were replaced, and their marks went with them.
  if exists (select 1 from public.episode_marks where user_id = v_owner) then
    raise exception 'restore_invalid: episode marks remained after the seasons were replaced, so nothing was changed' using errcode = '22023';
  end if;
  begin
    insert into public.episode_marks (id, season_id, tmdb_episode_id, episode_number)
    select id, season_id, tmdb_episode_id, episode_number
    from jsonb_to_recordset(v_marks) as x(id uuid, season_id uuid, tmdb_episode_id integer, episode_number integer);
    get diagnostics v_k = row_count;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      -- (ids are kept, as for every table: an id that is taken is another owner's, since this owner's
      -- marks went with their seasons; a repeat inside the file is the page's to refuse first)
      if v_constraint = 'episode_marks_pkey' then
        raise exception 'restore_id_collision: this backup contains ids already owned by another user; restoring it would keep those ids and break user isolation, so nothing was changed'
          using errcode = '23505';
      end if;
      raise exception 'restore_invalid: the backup repeats an episode mark, so nothing was changed' using errcode = '22023';
    when foreign_key_violation then
      raise exception 'restore_invalid: an episode mark in the backup points at a season that isn''t in it, so nothing was changed' using errcode = '22023';
    when check_violation or not_null_violation or raise_exception or invalid_text_representation or numeric_value_out_of_range then
      get stacked diagnostics v_constraint = message_text;
      raise exception 'restore_invalid: an episode mark in the backup breaks a rule (%), so nothing was changed', v_constraint using errcode = '22023';
  end;
  if (select count(*) from public.episode_marks where user_id = v_owner) <> jsonb_array_length(v_marks)
     or exists (select x.id, x.season_id, x.tmdb_episode_id, x.episode_number
                from jsonb_to_recordset(v_marks) as x(id uuid, season_id uuid, tmdb_episode_id integer, episode_number integer)
                except select m.id, m.season_id, m.tmdb_episode_id, m.episode_number from public.episode_marks m where m.user_id = v_owner) then
    raise exception 'restore_invalid: the restored episode marks differ from the backup' using errcode = '22023';
  end if;

  return jsonb_build_object('formatVersion', 6, 'restored', (v_out -> 'restored') || jsonb_build_object('episode_marks', v_k),
    'recovery', v_out -> 'recovery',
    'converted_from', case when v_conv is not null then (v_conv ->> 'source_format')::int end);
end $$;

-- ── 4. Grants ──────────────────────────────────────────────────────────────────
-- Explicit, then verified: default privileges owned by supabase_admin can't be relied on.
revoke all on public.episode_marks from public, anon, authenticated;
grant select, delete on public.episode_marks to authenticated;
grant insert (id, season_id, tmdb_episode_id, episode_number) on public.episode_marks to authenticated;
revoke all on function public.library_set_episode_marks(uuid, jsonb, boolean, jsonb), public.delete_tv_season(uuid, integer),
  public.restore_backup(jsonb, boolean), private.restore_backup_v5(jsonb, boolean) from public, anon;
grant execute on function public.library_set_episode_marks(uuid, jsonb, boolean, jsonb), public.delete_tv_season(uuid, integer),
  public.restore_backup(jsonb, boolean), private.restore_backup_v5(jsonb, boolean) to authenticated;

-- ── 5. The capability and the run record ───────────────────────────────────────
create or replace function public.stage5_capabilities() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted-ep1', 'backup_format', 6, 'b45', 1, 'ep1', 1, 'access', 'members',
    -- Whether the caller is a member now (M1): a signed-in non-member's reads return no rows.
    'member', private.is_member(),
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;
revoke execute on function public.stage5_capabilities() from public, anon;
grant execute on function public.stage5_capabilities() to authenticated;
insert into private.migration_runs (run_id, migration) select run_id, 'ep1' from ep1_ctx;

-- ── 6. Verify before commit ────────────────────────────────────────────────────
do $$
declare v_bad jsonb; v_owner uuid; v_tmdb integer; v_sid uuid; v_fake uuid := gen_random_uuid(); v_out jsonb;
begin
  -- (a) every existing row unchanged; no marks yet
  select jsonb_agg(b.schema_name || '.' || b.table_name) into v_bad from ep1_before b where b.fp is distinct from pg_temp.ep1_fp(b.schema_name, b.table_name);
  if v_bad is not null then raise exception 'ep1: content changed in %', v_bad; end if;
  if exists (select 1 from public.episode_marks) then raise exception 'ep1: episode_marks is not empty'; end if;

  -- (b) the run record: this run, unreachable by application roles (as M1 left it)
  if not exists (select 1 from private.migration_runs r join ep1_ctx c on c.run_id = r.run_id where r.migration = 'ep1') then
    raise exception 'ep1: the run record does not hold this run';
  end if;
  if has_table_privilege('authenticated', 'private.migration_runs', 'select') or has_table_privilege('anon', 'private.migration_runs', 'select') then
    raise exception 'ep1: the run record is reachable by an application role';
  end if;

  -- (c) anon: no privilege on any app relation, column or function, nor the private schema
  select jsonb_agg(c.oid::regclass) into v_bad from pg_class c
  where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'v', 'm', 'S', 'f', 'p')
    and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update')
      or has_table_privilege('anon', c.oid, 'delete') or has_table_privilege('anon', c.oid, 'truncate')
      or has_table_privilege('anon', c.oid, 'references') or has_table_privilege('anon', c.oid, 'trigger')
      or exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                 and (has_column_privilege('anon', c.oid, a.attnum, 'select') or has_column_privilege('anon', c.oid, a.attnum, 'insert')
                      or has_column_privilege('anon', c.oid, a.attnum, 'update'))));
  if v_bad is not null then raise exception 'ep1: anon has privileges on %', v_bad; end if;
  select jsonb_agg(p.oid::regprocedure) into v_bad from pg_proc p
  where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and has_function_privilege('anon', p.oid, 'execute');
  if v_bad is not null then raise exception 'ep1: anon can execute %', v_bad; end if;
  if has_schema_privilege('anon', 'private', 'usage') then raise exception 'ep1: anon has usage on private'; end if;

  -- (d) authenticated: exactly the functions it had, the old delete and format-5 restore signatures
  -- gone from public, the format-5 restore kept privately, plus the new ones; the trigger functions not
  -- executable; on episode_marks only SELECT, DELETE and INSERT of the three columns
  select jsonb_agg(f) into v_bad from (
    (select f from ep1_fn_before where f not in ('delete_tv_season(uuid)', 'restore_backup(jsonb,boolean)')
     union all select unnest(array['delete_tv_season(uuid,integer)', 'restore_backup(jsonb,boolean)',
       'private.restore_backup_v5(jsonb,boolean)', 'library_set_episode_marks(uuid,jsonb,boolean,jsonb)']))
    except
    (select p.oid::regprocedure::text from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
       and has_function_privilege('authenticated', p.oid, 'execute'))) z;
  if v_bad is not null then raise exception 'ep1: authenticated can''t execute %', v_bad; end if;
  select jsonb_agg(f) into v_bad from (
    (select p.oid::regprocedure::text f from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
       and has_function_privilege('authenticated', p.oid, 'execute'))
    except
    (select f from ep1_fn_before where f not in ('delete_tv_season(uuid)', 'restore_backup(jsonb,boolean)')
     union all select unnest(array['delete_tv_season(uuid,integer)', 'restore_backup(jsonb,boolean)',
       'private.restore_backup_v5(jsonb,boolean)', 'library_set_episode_marks(uuid,jsonb,boolean,jsonb)']))) z;
  if v_bad is not null then raise exception 'ep1: authenticated can execute unexpected functions %', v_bad; end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'delete_tv_season') <> 1
     or (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'restore_backup') <> 1 then
    raise exception 'ep1: more than one delete_tv_season or restore_backup signature in public';
  end if;
  if has_table_privilege('authenticated', 'public.episode_marks', 'update') or has_table_privilege('authenticated', 'public.episode_marks', 'truncate')
     or has_table_privilege('authenticated', 'public.episode_marks', 'references') or has_table_privilege('authenticated', 'public.episode_marks', 'trigger')
     or has_column_privilege('authenticated', 'public.episode_marks', 'user_id', 'insert')
     or not has_table_privilege('authenticated', 'public.episode_marks', 'select') or not has_table_privilege('authenticated', 'public.episode_marks', 'delete')
     or not has_column_privilege('authenticated', 'public.episode_marks', 'tmdb_episode_id', 'insert') then
    raise exception 'ep1: unexpected privileges on episode_marks';
  end if;

  -- (e) policies: RLS on, exactly the expected set, nothing for anon or PUBLIC
  if not (select relrowsecurity from pg_class where oid = 'public.episode_marks'::regclass) then raise exception 'ep1: RLS is off on episode_marks'; end if;
  if (select array_agg(policyname || ':' || cmd || ':' || permissive || ':' || array_to_string(roles, ',') order by policyname)
      from pg_policies where schemaname = 'public' and tablename = 'episode_marks')
     is distinct from array['members_only:ALL:RESTRICTIVE:authenticated', 'owner_delete:DELETE:PERMISSIVE:authenticated',
                            'owner_insert:INSERT:PERMISSIVE:authenticated', 'owner_select:SELECT:PERMISSIVE:authenticated'] then
    raise exception 'ep1: unexpected policies on episode_marks';
  end if;
  if exists (select 1 from pg_policies where schemaname in ('public', 'private') and (roles && array['anon', 'public']::name[])) then
    raise exception 'ep1: a policy applies to anon or PUBLIC';
  end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-ep1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '6' then
    raise exception 'ep1: capability not updated';
  end if;

  -- (f) simulated callers (role changes are transaction-local; every write below is rolled back
  -- with its subtransaction)
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
  begin
    perform count(*) from public.episode_marks;
    raise exception 'ep1-check: anon read episode_marks';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'none', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_fake, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.library_set_episode_marks(gen_random_uuid(), '{"watched": false, "skipped": false}', true, '[{"tmdb_episode_id": 1, "episode_number": 1}]');
    raise exception 'ep1-check: a non-member set a mark';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'none', true);

  -- The write checks use synthetic rows only: for the first member, a show "ZZ EP1 Migration Check" with one
  -- TMDB-matched season (a TMDB id that member doesn't use), created through library_create_show_b45 inside a
  -- subtransaction that is always rolled back. On it: marks set and cleared, a stale, an old-style and a
  -- direct delete refused, then the guarded delete (season, marks and the emptied show). No existing row is
  -- written; (a) below and the synthetic-row check confirm it.
  select m.user_id into v_owner from private.library_members m order by m.user_id limit 1;
  if v_owner is not null then
    select min(t) into v_tmdb from generate_series(2147480000, 2147480999) t
    where not exists (select 1 from public.tv_shows s where s.user_id = v_owner and s.tmdb_id = t)
      and not exists (select 1 from public.watchlist_items w where w.user_id = v_owner and w.tmdb_id = t);
    if v_tmdb is null then raise exception 'ep1: no free TMDB id for the synthetic check season'; end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    begin
      perform public.library_create_show_b45(
        jsonb_build_object('tmdb_id', v_tmdb, 'title', 'ZZ EP1 Migration Check', 'show_key', 'zz ep1 migration check', 'network', 'ZZ'),
        jsonb_build_array(jsonb_build_object('item_key', 'zz ep1 migration check|season 1', 'title', 'ZZ EP1 Migration Check', 'season', 'Season 1',
          'theme', 'ZZ', 'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01', 'season_number', 1)));
      select w.id into v_sid from public.watchlist_items w where w.user_id = v_owner and w.tmdb_id = v_tmdb and w.season_number = 1;
      if v_sid is null then raise exception 'ep1-check: the synthetic season was not created'; end if;
      v_out := public.library_set_episode_marks(v_sid, '{"watched": false, "skipped": false}', true,
        '[{"tmdb_episode_id": 900000001, "episode_number": 1}, {"tmdb_episode_id": 900000002, "episode_number": 2}]');
      if jsonb_array_length(v_out -> 'marks') <> 2 then raise exception 'ep1-check: marks not set: %', v_out; end if;
      v_out := public.library_set_episode_marks(v_sid, '{"watched": false, "skipped": false}', false, '[{"tmdb_episode_id": 900000002}]');
      if jsonb_array_length(v_out -> 'marks') <> 1 then raise exception 'ep1-check: mark not cleared: %', v_out; end if;
      begin
        perform public.delete_tv_season(v_sid);
        raise exception 'ep1-check: an old-style delete of a marked season succeeded';
      exception when raise_exception then
        if sqlerrm !~ '^update_required: ' then raise; end if;
      end;
      begin
        perform public.delete_tv_season(v_sid, 0);
        raise exception 'ep1-check: a stale delete succeeded';
      exception when raise_exception then
        if sqlerrm !~ '^target_changed: ' then raise; end if;
      end;
      -- (each request is its own transaction; here the writes above left library_write on)
      perform set_config('watchlist.library_write', '', true);
      begin
        delete from public.watchlist_items where id = v_sid;
        raise exception 'ep1-check: a direct delete of a marked season succeeded';
      exception when raise_exception then
        if sqlerrm !~ '^library_write_required: ' then raise; end if;
      end;
      v_out := public.delete_tv_season(v_sid, 1);
      if (v_out ->> 'marks_deleted') <> '1' or (v_out ->> 'show_deleted') <> 'true' or exists (select 1 from public.watchlist_items where id = v_sid)
         or exists (select 1 from public.episode_marks where season_id = v_sid) then
        raise exception 'ep1-check: the guarded delete did not delete the season, its marks and the emptied show: %', v_out;
      end if;
      raise exception 'ep1-rollback';
    exception when raise_exception then
      if sqlerrm <> 'ep1-rollback' then raise; end if;
    end;
    perform set_config('role', 'none', true);
    insert into ep1_checked values (v_owner is not null);
  end if;
  perform set_config('request.jwt.claims', '', true);

  -- (a) again, after the simulated writes; and no synthetic row survived
  if exists (select 1 from public.tv_shows where title = 'ZZ EP1 Migration Check' or show_key = 'zz ep1 migration check')
     or exists (select 1 from public.watchlist_items where title = 'ZZ EP1 Migration Check')
     or exists (select 1 from public.episode_marks where tmdb_episode_id in (900000001, 900000002)) then
    raise exception 'ep1: a synthetic check row survived';
  end if;
  select jsonb_agg(b.schema_name || '.' || b.table_name) into v_bad from ep1_before b where b.fp is distinct from pg_temp.ep1_fp(b.schema_name, b.table_name);
  if v_bad is not null then raise exception 'ep1: content changed in % (after the checks)', v_bad; end if;
  if exists (select 1 from public.episode_marks) then raise exception 'ep1: episode_marks is not empty (after the checks)'; end if;
end $$;

select 'EP1|' || json_build_object('run', (select run_id from ep1_ctx),
  -- (whether section 6 ran its synthetic write checks: it does whenever there is a member)
  'checked_writes', exists (select 1 from ep1_checked)) as result;

notify pgrst, 'reload schema';
commit;
