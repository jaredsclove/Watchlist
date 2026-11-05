-- Q1: named planning queues (next-gen item 7). One transaction, run as postgres on a contracted-cu1 database (backup format 7,
-- access = members, after the simplification).
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.q1_run', '<a fresh run id, recorded before running>', false);
-- What it adds:
--   * public.watch_queues (a member's named queues, in their saved order) and public.queue_entries (a film, a whole show or one
--     season, in a queue, at a position). Owner-only like every library table (M1 policies; nothing for anon); written only
--     through the functions below, a restore, or the completion and identity triggers (library_write_guard).
--   * Functions: library_queue_create / _rename / _delete / _reorder (the queues), library_queue_add / _remove / _move (the
--     entries). Each takes a per-member transaction lock first (private.q1_lock), so two devices' changes to the same member's
--     queues run one after another, including a member's very first queue. Ordered changes send the order the page showed.
--   * Completion (in the transaction that completes the item): a film or season going from unwatched to watched leaves every
--     queue; a regular season doing so, or Show ended being turned on, when that makes an ended show complete (at least one
--     regular season, every regular season watched and none skipped; specials never count) takes the show's whole-show entries
--     out too. Only those transitions remove anything: reads, inserts (restore, Refresh shows), matching, Skip and edits don't.
--   * Identity (matching): a season moved to another show takes its entries along; a whole-show entry of a show its last season
--     left is carried to where that season went (another show, or the film it became); a true duplicate keeps the entry already
--     there; a whole-show entry then covering seasons of its show in the same queue removes those season entries.
--   * public.restore_backup takes format 8 (format 7's nineteen tables plus these two); 5 to 7 are converted in the page.
--   * stage5_capabilities(): phase contracted-q1, backup_format 8. A page from before this migration sees another phase and
--     stops writing, making backups and restoring until it is reloaded, so no format-7 backup can leave queues out.
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate execution). Never rerun
-- to find out; a rerun is refused once this committed. No rollback (fix-forward); earlier definitions are in git.
begin;
select set_config('application_name', 'watchlist-q1-' || coalesce(nullif(current_setting('watchlist.q1_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;
do $$
begin
  if exists (select 1 from private.migration_runs r where r.migration = 'q1') then raise exception 'q1: already installed; nothing was changed'; end if;
end $$;
lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships, public.watch_with_choices,
  public.custom_collections, public.catalog_show_links, public.catalog_film_links, public.episode_marks, public.update_setup,
  public.collection_definitions, public.collection_exclusions, public.update_holds, public.record_aliases, public.membership_removals,
  public.show_update_settings, public.research_briefs, public.research_imports, public.update_findings, private.library_members in share row exclusive mode;

-- ── 1. Preconditions and the before-state ─────────────────────────────────────
create temp table q1_tables (t text primary key) on commit drop;
insert into q1_tables values ('private.library_members'), ('public.tv_shows'), ('public.watchlist_items'), ('public.personal_collections'),
  ('public.collection_memberships'), ('public.watch_with_choices'), ('public.custom_collections'), ('public.catalog_show_links'),
  ('public.catalog_film_links'), ('public.episode_marks'), ('public.update_setup'), ('public.collection_definitions'),
  ('public.collection_exclusions'), ('public.update_holds'), ('public.record_aliases'), ('public.membership_removals'),
  ('public.show_update_settings'), ('public.research_briefs'), ('public.research_imports'), ('public.update_findings');
create or replace function pg_temp.q1_fp() returns text language plpgsql as $$
declare r record; v text; v_all text := '';
begin
  for r in select t from q1_tables order by t loop
    execute format('select coalesce(md5(string_agg(md5(x::text), '','' order by md5(x::text))), '''') from %s x', r.t) into v;
    v_all := v_all || r.t || ':' || v || ';';
  end loop;
  return md5(v_all);
end $$;
create temp table q1_ctx on commit drop as
select nullif(current_setting('watchlist.q1_run', true), '') as run_id, pg_temp.q1_fp() as library_before;
do $$
declare c record;
begin
  select * into c from q1_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'q1: set watchlist.q1_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'q1: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-cu1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '7'
     or public.stage5_capabilities() ->> 'access' is distinct from 'members' then
    raise exception 'q1: expected phase contracted-cu1, backup format 7 and access = members; nothing was changed';
  end if;
  if not exists (select 1 from private.migration_runs r where r.migration = 'simplify') or to_regprocedure('private.restore_backup_v7(jsonb, boolean)') is not null
     or (select prosrc from pg_proc where oid = 'public.restore_backup(jsonb, boolean)'::regprocedure) !~ 'unexpected set of tables for format 7' then
    raise exception 'q1: public.restore_backup is not the flat format-7 function of the simplification; nothing was changed';
  end if;
  if to_regclass('public.watch_queues') is not null or to_regclass('public.queue_entries') is not null then raise exception 'q1: the queue tables already exist; nothing was changed'; end if;
  if to_regprocedure('private.library_write_guard()') is null or to_regprocedure('private.b45_is_special(public.watchlist_items)') is null
     or to_regprocedure('private.lib_refuse(text, text)') is null or to_regprocedure('private.b45_changed()') is null then
    raise exception 'q1: a helper it relies on is missing; nothing was changed';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'watchlist_items_id_owner_key') or not exists (select 1 from pg_constraint where conname = 'tv_shows_id_owner_key') then
    raise exception 'q1: the (id, user_id) keys of watchlist_items and tv_shows are missing; nothing was changed';
  end if;
end $$;

-- ── 2. Tables, guards and policies ─────────────────────────────────────────────
create table public.watch_queues (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  name text not null,
  sort_order integer not null,
  created_at timestamptz not null default now(),
  constraint watch_queues_pkey primary key (id),
  constraint watch_queues_name_check check (name = btrim(name) and name <> '' and char_length(name) <= 100),
  constraint watch_queues_sort_order_check check (sort_order > 0),
  constraint watch_queues_id_owner_key unique (id, user_id),
  -- Deferred: a reorder renumbers every queue in one statement.
  constraint watch_queues_order_key unique (user_id, sort_order) deferrable initially deferred
);
-- Names are unique per member ignoring case.
create unique index watch_queues_name_key on public.watch_queues using btree (user_id, lower(name));
comment on table public.watch_queues is 'Q1: a member''s named planning queues, in their saved order.';

create table public.queue_entries (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  queue_id uuid not null,
  show_id uuid,
  item_id uuid,
  position integer not null,
  created_at timestamptz not null default now(),
  constraint queue_entries_pkey primary key (id),
  constraint queue_entries_target_check check ((show_id is null) <> (item_id is null)),
  constraint queue_entries_position_check check (position > 0),
  constraint queue_entries_queue_fkey foreign key (queue_id, user_id) references public.watch_queues (id, user_id) on delete cascade,
  constraint queue_entries_show_fkey foreign key (show_id, user_id) references public.tv_shows (id, user_id) on delete cascade,
  -- Any library row (a film or a season): an entry follows a season that matching turns into a film.
  constraint queue_entries_item_fkey foreign key (item_id, user_id) references public.watchlist_items (id, user_id) on delete cascade,
  -- Deferred: a move renumbers the queue in one statement.
  constraint queue_entries_position_key unique (queue_id, position) deferrable initially deferred
);
create unique index queue_entries_show_key on public.queue_entries using btree (queue_id, show_id) where (show_id is not null);
create unique index queue_entries_item_key on public.queue_entries using btree (queue_id, item_id) where (item_id is not null);
create index queue_entries_show_id_idx on public.queue_entries using btree (show_id);
create index queue_entries_item_id_idx on public.queue_entries using btree (item_id);
comment on table public.queue_entries is 'Q1: a film, a whole show or one season in a queue, at a position.';

create trigger watch_queues_write_guard before insert or update or delete on public.watch_queues
  for each row execute function private.library_write_guard();
-- Inserts and updates only: deleting a film, season or show cascades to its entries, and a film's delete is a direct one
-- (a member's direct delete of their own rows is an accepted limitation, db/README.md).
create trigger queue_entries_write_guard before insert or update on public.queue_entries
  for each row execute function private.library_write_guard();

do $$
declare t text;
begin
  foreach t in array array['watch_queues', 'queue_entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t);
    execute format('create policy owner_update on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy members_only on public.%I as restrictive for all to authenticated using ((select private.is_member())) with check ((select private.is_member()))', t);
  end loop;
end $$;

-- ── 3. Helpers ─────────────────────────────────────────────────────────────────
-- One member's queue changes run one after another: every queue function, the triggers below and restore take this
-- transaction lock (it needs no row, so it also covers a member's first queue). Lock order, everywhere: library rows or
-- tables first, then the queue tables (row exclusive, which a restore's exclusive lock blocks), then this lock.
create function private.q1_lock(p_owner uuid) returns void
language plpgsql set search_path = '' as $$
begin
  lock table public.watch_queues, public.queue_entries in row exclusive mode;
  perform pg_advisory_xact_lock(hashtextextended('watchlist.queues ' || p_owner::text, 0));
end $$;
-- The library flag for the queue writes a trigger makes; returns what it was, so the trigger can put it back.
create function private.q1_write_begin() returns text
language plpgsql set search_path = '' as $$
declare v text := coalesce(current_setting('watchlist.library_write', true), '');
begin
  perform set_config('watchlist.library_write', 'on', true);
  return v;
end $$;
create function private.q1_write_end(p_prev text) returns void
language sql set search_path = '' as $$ select set_config('watchlist.library_write', coalesce(p_prev, ''), true); $$;
-- An ended show with at least one regular season, every regular season watched and none skipped. Specials never count.
-- Only stored rows: dates, TMDB identity and episode lists play no part.
create function private.q1_show_complete(p_show_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select s.ended from public.tv_shows s where s.id = p_show_id), false)
     and exists (select 1 from public.watchlist_items w where w.show_id = p_show_id and not private.b45_is_special(w))
     and not exists (select 1 from public.watchlist_items w where w.show_id = p_show_id and not private.b45_is_special(w) and (not w.watched or w.skipped))
$$;
-- A queue's entries as the page shows them.
create function private.q1_entry_json(e public.queue_entries) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'queue_id', e.queue_id, 'show_id', e.show_id, 'item_id', e.item_id, 'position', e.position, 'created_at', e.created_at)
$$;
-- The queue the caller names, locked by q1_lock already; refused when it isn't theirs or is gone.
create function private.q1_queue(p_owner uuid, p_queue_id uuid) returns public.watch_queues
language plpgsql stable set search_path = '' as $$
declare q public.watch_queues;
begin
  select * into q from public.watch_queues where id = p_queue_id and user_id = p_owner;
  if q.id is null then perform private.lib_refuse('queue_missing', 'This queue is no longer there, so nothing was changed. Look at your queues again.'); end if;
  return q;
end $$;
-- p_ids reordered: p_id moved to the 1-based p_to (clamped).
create function private.q1_moved(p_ids uuid[], p_id uuid, p_to integer) returns uuid[]
language plpgsql immutable set search_path = '' as $$
declare v_rest uuid[] := array_remove(p_ids, p_id); k integer;
begin
  k := greatest(1, least(p_to, coalesce(cardinality(v_rest), 0) + 1));
  return coalesce(v_rest[1:k - 1], '{}') || p_id || coalesce(v_rest[k:], '{}');
end $$;

-- ── 4. Functions ───────────────────────────────────────────────────────────────
-- Creates a queue at the end of the member's queues.
create function public.library_queue_create(p_name text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); q public.watch_queues;
begin
  if p_name is null or p_name <> btrim(p_name) or p_name = '' or char_length(p_name) > 100 then raise exception 'invalid_input: name' using errcode = '22023'; end if;
  perform private.q1_lock(v_owner);
  if exists (select 1 from public.watch_queues where user_id = v_owner and lower(name) = lower(p_name)) then
    perform private.lib_refuse('queue_name_taken', 'You already have a queue with this name, so nothing was changed.');
  end if;
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.watch_queues (name, sort_order)
  values (p_name, coalesce((select max(sort_order) from public.watch_queues where user_id = v_owner), 0) + 1) returning * into q;
  return jsonb_build_object('id', q.id, 'name', q.name, 'sort_order', q.sort_order, 'created_at', q.created_at);
end $$;

create function public.library_queue_rename(p_queue_id uuid, p_expected_name text, p_name text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); q public.watch_queues;
begin
  if p_name is null or p_name <> btrim(p_name) or p_name = '' or char_length(p_name) > 100 or p_expected_name is null then raise exception 'invalid_input: name' using errcode = '22023'; end if;
  perform private.q1_lock(v_owner);
  q := private.q1_queue(v_owner, p_queue_id);
  if q.name is distinct from p_expected_name then perform private.b45_changed(); end if;
  if exists (select 1 from public.watch_queues where user_id = v_owner and id <> q.id and lower(name) = lower(p_name)) then
    perform private.lib_refuse('queue_name_taken', 'You already have a queue with this name, so nothing was changed.');
  end if;
  perform set_config('watchlist.library_write', 'on', true);
  update public.watch_queues set name = p_name where id = q.id returning * into q;
  return jsonb_build_object('id', q.id, 'name', q.name, 'sort_order', q.sort_order, 'created_at', q.created_at);
end $$;

-- Deletes a queue and its entries (never the films, shows or seasons). p_expected_count: the entries the page showed.
create function public.library_queue_delete(p_queue_id uuid, p_expected_count integer) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); q public.watch_queues; v_n integer;
begin
  if p_expected_count is null or p_expected_count < 0 then raise exception 'invalid_input: p_expected_count' using errcode = '22023'; end if;
  perform private.q1_lock(v_owner);
  q := private.q1_queue(v_owner, p_queue_id);
  select count(*) into v_n from public.queue_entries where queue_id = q.id;
  if v_n <> p_expected_count then perform private.b45_changed(); end if;
  perform set_config('watchlist.library_write', 'on', true);
  delete from public.watch_queues where id = q.id;
  return jsonb_build_object('deleted_queue_id', q.id, 'entries_removed', v_n);
end $$;

-- Moves one queue to a 1-based place among the member's queues (past the end: the end). p_expected: every queue id in the order the page showed.
create function public.library_queue_reorder(p_expected uuid[], p_queue_id uuid, p_to_index integer) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); v_now uuid[]; v_new uuid[];
begin
  if p_expected is null or p_queue_id is null or p_to_index is null or p_to_index < 1 then raise exception 'invalid_input: reorder' using errcode = '22023'; end if;
  perform private.q1_lock(v_owner);
  v_now := coalesce((select array_agg(id order by sort_order, id) from public.watch_queues where user_id = v_owner), '{}');
  if v_now is distinct from p_expected or not (p_queue_id = any(v_now)) then perform private.b45_changed(); end if;
  v_new := private.q1_moved(v_now, p_queue_id, p_to_index);
  perform set_config('watchlist.library_write', 'on', true);
  update public.watch_queues q set sort_order = o.n from unnest(v_new) with ordinality o(id, n) where q.id = o.id and q.sort_order is distinct from o.n;
  return jsonb_build_object('order', to_jsonb(v_new));
end $$;

-- Adds a film, a whole show or one season at the end of a queue. Viewing status is never changed; an already watched or complete
-- item may be added. Refused: the same item already in the queue, or a whole show beside any of its seasons.
create function public.library_queue_add(p_queue_id uuid, p_show_id uuid, p_item_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  q public.watch_queues; w public.watchlist_items; s public.tv_shows; e public.queue_entries; v_pos integer; v_label text;
begin
  if p_queue_id is null or (p_show_id is null) = (p_item_id is null) then raise exception 'invalid_input: one of show or item' using errcode = '22023'; end if;
  -- The library row first (shared: its show can't change under the checks), then the member's queue lock.
  if p_item_id is not null then
    select * into w from public.watchlist_items where id = p_item_id and user_id = v_owner for share;
    if w.id is null then perform private.lib_refuse('target_missing', 'This is no longer in your library, so nothing was changed.'); end if;
  else
    select * into s from public.tv_shows where id = p_show_id and user_id = v_owner for share;
    if s.id is null then perform private.lib_refuse('target_missing', 'This show is no longer in your library, so nothing was changed.'); end if;
  end if;
  perform private.q1_lock(v_owner);
  q := private.q1_queue(v_owner, p_queue_id);
  select * into e from public.queue_entries x where x.queue_id = q.id and (x.item_id = p_item_id or x.show_id = p_show_id);
  if e.id is not null then
    perform private.lib_refuse('queue_duplicate', format('This is already in “%s” (#%s), so nothing was changed.', q.name,
      (select count(*) from public.queue_entries x where x.queue_id = q.id and x.position <= e.position)));
  end if;
  if w.id is not null and w.show_id is not null and exists (select 1 from public.queue_entries x where x.queue_id = q.id and x.show_id = w.show_id) then
    perform private.lib_refuse('queue_overlap', format('The whole show is in “%s”, which covers %s, so nothing was changed.', q.name, w.season));
  end if;
  if s.id is not null then
    select string_agg(i.season, ', ' order by i.season) into v_label from public.queue_entries x join public.watchlist_items i on i.id = x.item_id
    where x.queue_id = q.id and i.show_id = s.id;
    if v_label is not null then
      perform private.lib_refuse('queue_overlap', format('“%s” already has %s of this show. Remove %s first to add the whole show. Nothing was changed.', q.name, v_label,
        case when position(',' in v_label) > 0 then 'them' else 'it' end));
    end if;
  end if;
  v_pos := coalesce((select max(position) from public.queue_entries where queue_id = q.id), 0) + 1;
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.queue_entries (queue_id, show_id, item_id, position) values (q.id, p_show_id, p_item_id, v_pos) returning * into e;
  return private.q1_entry_json(e) || jsonb_build_object('place', (select count(*) from public.queue_entries x where x.queue_id = q.id));
end $$;

-- Removes one entry (never the film, show or season). An entry already gone is reported, not refused.
create function public.library_queue_remove(p_entry_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); v_id uuid;
begin
  if p_entry_id is null then raise exception 'invalid_input: entry' using errcode = '22023'; end if;
  perform private.q1_lock(v_owner);
  perform set_config('watchlist.library_write', 'on', true);
  delete from public.queue_entries where id = p_entry_id and user_id = v_owner returning id into v_id;
  return jsonb_build_object('entry_id', p_entry_id, 'removed', v_id is not null);
end $$;

-- Moves one entry to a 1-based place in its queue (past the end: the end). p_expected: every entry id of the queue in the order the page showed.
create function public.library_queue_move(p_queue_id uuid, p_expected uuid[], p_entry_id uuid, p_to_index integer) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); q public.watch_queues; v_now uuid[]; v_new uuid[];
begin
  if p_expected is null or p_entry_id is null or p_to_index is null or p_to_index < 1 then raise exception 'invalid_input: move' using errcode = '22023'; end if;
  perform private.q1_lock(v_owner);
  q := private.q1_queue(v_owner, p_queue_id);
  v_now := coalesce((select array_agg(id order by position, id) from public.queue_entries where queue_id = q.id), '{}');
  if v_now is distinct from p_expected or not (p_entry_id = any(v_now)) then perform private.b45_changed(); end if;
  v_new := private.q1_moved(v_now, p_entry_id, p_to_index);
  perform set_config('watchlist.library_write', 'on', true);
  update public.queue_entries e set position = o.n from unnest(v_new) with ordinality o(id, n) where e.id = o.id and e.position is distinct from o.n;
  return jsonb_build_object('queue_id', q.id, 'order', to_jsonb(v_new));
end $$;

-- ── 5. Completion and identity ─────────────────────────────────────────────────
-- A film or season explicitly marked watched (from unwatched) leaves every queue; a regular season whose mark completes its
-- ended show takes the show's whole-show entries too. Nothing else here removes an entry.
create function private.q1_item_watched() returns trigger
language plpgsql set search_path = '' as $$
declare v_prev text;
begin
  perform private.q1_lock(new.user_id);
  v_prev := private.q1_write_begin();
  delete from public.queue_entries where item_id = new.id and user_id = new.user_id;
  if new.show_id is not null and not new.is_film and not private.b45_is_special(new) and private.q1_show_complete(new.show_id) then
    delete from public.queue_entries where show_id = new.show_id and user_id = new.user_id;
  end if;
  perform private.q1_write_end(v_prev);
  return null;
end $$;
create trigger watchlist_items_q1_watched after update of watched on public.watchlist_items
  for each row when (old.watched is not true and new.watched is true) execute function private.q1_item_watched();

-- Show ended turned on when every regular season is already watched.
create function private.q1_show_ended() returns trigger
language plpgsql set search_path = '' as $$
declare v_prev text;
begin
  if not private.q1_show_complete(new.id) then return null; end if;
  perform private.q1_lock(new.user_id);
  v_prev := private.q1_write_begin();
  delete from public.queue_entries where show_id = new.id and user_id = new.user_id;
  perform private.q1_write_end(v_prev);
  return null;
end $$;
create trigger tv_shows_q1_ended after update of ended on public.tv_shows
  for each row when (old.ended is not true and new.ended is true) execute function private.q1_show_ended();

-- A season moved to another show, or made a film, by matching. Its own entries follow it (they name the row). A whole-show entry
-- of the show it left, when that show has no season left (matching then deletes it), is carried: to the new show, or to the film.
-- Where the queue already has that destination, the entry already there stays at its place and the carried one goes. Then, in each
-- queue holding the new show whole, entries for that show's seasons go: the whole-show entry covers them.
create function private.q1_season_moved() returns trigger
language plpgsql set search_path = '' as $$
declare v_prev text; e public.queue_entries;
begin
  perform private.q1_lock(new.user_id);
  v_prev := private.q1_write_begin();
  if old.show_id is not null and not exists (select 1 from public.watchlist_items where show_id = old.show_id) then
    for e in select * from public.queue_entries where show_id = old.show_id and user_id = new.user_id order by queue_id, position loop
      if new.show_id is not null then
        if exists (select 1 from public.queue_entries x where x.queue_id = e.queue_id and x.show_id = new.show_id) then
          delete from public.queue_entries where id = e.id;
        else
          update public.queue_entries set show_id = new.show_id where id = e.id;
        end if;
      else
        if exists (select 1 from public.queue_entries x where x.queue_id = e.queue_id and x.item_id = new.id) then
          delete from public.queue_entries where id = e.id;
        else
          update public.queue_entries set show_id = null, item_id = new.id where id = e.id;
        end if;
      end if;
    end loop;
  end if;
  if new.show_id is not null then
    delete from public.queue_entries s using public.queue_entries w, public.watchlist_items i
    where w.show_id = new.show_id and w.user_id = new.user_id and s.queue_id = w.queue_id and s.item_id = i.id and i.show_id = new.show_id;
  end if;
  perform private.q1_write_end(v_prev);
  return null;
end $$;
create trigger watchlist_items_q1_moved after update of show_id on public.watchlist_items
  for each row when (old.show_id is distinct from new.show_id) execute function private.q1_season_moved();

-- ── 6. The restore, format 8 ────────────────────────────────────────────────────
-- The simplification's flat function with the two queue tables added: refuse what can't be a format-8 library, replace the caller's
-- rows in one transaction, then compare the final state with the file. Formats 5 to 7 are converted in the page or the admin tool first.
-- Restore inserts rows, so the completion triggers (updates only) never remove anything it restores.
create or replace function public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean default false)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_version text := p_backup ->> 'formatVersion';
  v_tables jsonb := p_backup -> 'tables';
  v_counts jsonb := p_backup -> 'rowCounts';
  -- Every table of a format-8 backup, references first, with its columns.
  v_spec text[][] := array[
    ['watch_with_choices', 'id uuid, token text, label text, sort_order integer, archived_at timestamptz, created_at timestamptz'],
    ['personal_collections', 'id uuid, name text, catalog_id text, presentation_key text, sort_order integer, archived_at timestamptz, created_at timestamptz'],
    ['tv_shows', 'id uuid, title text, show_key text, tmdb_id integer, status text, created_at timestamptz, priority text, ended boolean, catalog_new boolean, status_review boolean, legacy_status text, genres text[], forms text[], franchises text[], companies text[], genre_candidates text[], network text, network_candidates text[], metadata_owner_set boolean, resume_start_season_id uuid, resume_end_season_id uuid'],
    ['watchlist_items', 'id uuid, item_key text, title text, season text, theme text, theme_kind text, display_date text, date_sort text, watched boolean, status text, created_at timestamptz, watch_with text[], collections text[], tmdb_collection_id integer, tmdb_collection_name text, media_type text, tmdb_id integer, season_number integer, show_id uuid, skipped boolean, priority text, catalog_new boolean, status_review boolean, legacy_status text, genres text[], forms text[], franchises text[], companies text[], genre_candidates text[], metadata_owner_set boolean'],
    ['custom_collections', 'id uuid, name text, tmdb_person_id integer, created_at timestamptz, role text'],
    ['collection_memberships', 'id uuid, collection_id uuid, show_id uuid, item_id uuid, created_at timestamptz'],
    ['catalog_show_links', 'id uuid, catalog text, catalog_key text, show_id uuid, origin text, created_at timestamptz'],
    ['catalog_film_links', 'id uuid, catalog text, entry_key text, item_id uuid, origin text, created_at timestamptz'],
    ['episode_marks', 'id uuid, season_id uuid, tmdb_episode_id integer, episode_number integer'],
    ['update_setup', 'id uuid, setup_confirmed_at timestamptz, source text'],
    ['collection_definitions', 'id uuid, collection_id uuid, version integer, mode text, rules jsonb, evidence jsonb, summary text, rule_hashes jsonb, evidence_hash text, confirmed_at timestamptz'],
    ['collection_exclusions', 'id uuid, collection_id uuid, kind text, title text, match_text text, tmdb_id integer, media text, note text, created_at timestamptz'],
    ['update_holds', 'id uuid, kind text, collection_id uuid, show_id uuid, item_id uuid, subject_label text, field text, protected_value text, decision text, effect text, reopen jsonb, decided_on date, created_at timestamptz'],
    ['record_aliases', 'id uuid, show_id uuid, item_id uuid, alias text, match_text text, evidence jsonb, created_at timestamptz'],
    ['membership_removals', 'id uuid, collection_id uuid, show_id uuid, item_id uuid, removed_at timestamptz'],
    ['show_update_settings', 'id uuid, show_id uuid, follow_when_skipped boolean, new_season_after_ended_at timestamptz, updated_at timestamptz'],
    ['research_briefs', 'id uuid, exported_at timestamptz, collections jsonb, checks jsonb'],
    ['research_imports', 'id uuid, brief_id uuid, file_sha256 text, imported_at timestamptz, counts jsonb'],
    ['update_findings', 'id uuid, fingerprint text, source text, kind text, status text, reason text, collection_id uuid, show_id uuid, item_id uuid, season_id uuid, subject jsonb, proposed jsonb, expected jsonb, evidence jsonb, assessment jsonb, rule_id text, definition_version integer, rule_hash text, evidence_hash text, brief_id uuid, first_seen_at timestamptz, last_seen_at timestamptz, decided_at timestamptz, applied_at timestamptz, result jsonb'],
    ['watch_queues', 'id uuid, name text, sort_order integer, created_at timestamptz'],
    ['queue_entries', 'id uuid, queue_id uuid, show_id uuid, item_id uuid, position integer, created_at timestamptz']];
  v_restored jsonb := '{}';
  t text; v_cols text; v_names text; v_keys text[]; v_k int; v_same boolean; v_detail text; i int;
begin
  if p_backup ->> 'format' is distinct from 'watchlist-tracker-backup' then
    raise exception 'restore_invalid: not a Watchlist backup' using errcode = '22023';
  end if;
  if v_version in ('1', '2', '3', '4') then
    raise exception 'restore_invalid: format % backups can no longer be restored; nothing was changed', v_version using errcode = '22023';
  elsif v_version in ('5', '6', '7') then
    raise exception 'restore_invalid: format % backups are converted in the page first; nothing was changed', v_version using errcode = '22023';
  elsif v_version is distinct from '8' then
    raise exception 'restore_invalid: unsupported backup format %', coalesce(v_version, '(none)') using errcode = '22023';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_backup) k)
     <@ array['conversion', 'exportedAt', 'format', 'formatVersion', 'recovery', 'rowCounts', 'tables']::text[] is not true then
    raise exception 'restore_invalid: unexpected top-level fields' using errcode = '22023';
  end if;
  if jsonb_typeof(v_tables) is distinct from 'object' or jsonb_typeof(v_counts) is distinct from 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(v_tables) k)
        is distinct from (select array_agg(v_spec[n][1] order by v_spec[n][1] collate "C") from generate_subscripts(v_spec, 1) n) then
    raise exception 'restore_invalid: unexpected set of tables for format 8' using errcode = '22023';
  end if;
  for i in 1 .. array_length(v_spec, 1) loop
    t := v_spec[i][1];
    if jsonb_typeof(v_tables -> t) is distinct from 'array' then raise exception 'restore_invalid: % is not a list of rows', t using errcode = '22023'; end if;
    if (v_counts ->> t) is distinct from jsonb_array_length(v_tables -> t)::text then
      raise exception 'restore_invalid: rowCounts.% does not match its rows', t using errcode = '22023';
    end if;
    v_keys := array(select k from (select split_part(c, ' ', 1) k from unnest(string_to_array(v_spec[i][2], ', ')) c) q order by k collate "C");
    if exists (select 1 from jsonb_array_elements(v_tables -> t) r
               where jsonb_typeof(r) is distinct from 'object' or (select array_agg(k order by k collate "C") from jsonb_object_keys(r) k) is distinct from v_keys) then
      raise exception 'restore_invalid: a % row does not have exactly the expected columns', t using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(v_tables -> t) r
               where jsonb_typeof(r -> 'id') is distinct from 'string' or (r ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'restore_invalid: a % row has an id that isn''t a uuid, so nothing was changed', t using errcode = '22023';
    end if;
  end loop;
  if jsonb_array_length(v_tables -> 'update_setup') > 1 then raise exception 'restore_invalid: more than one update_setup row' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(v_tables -> 'collection_definitions') d
             where not private.cu1_rules_ok(coalesce(d -> 'rules', 'null')) or not private.cu1_evidence_settings_ok(coalesce(d -> 'evidence', 'null'))
                or d -> 'rule_hashes' is distinct from private.cu1_rule_hashes(d -> 'rules') or d ->> 'evidence_hash' is distinct from md5((d -> 'evidence')::text)) then
    raise exception 'restore_invalid: a collection definition in the backup isn''t consistent, so nothing was changed' using errcode = '22023';
  end if;

  perform set_config('lock_timeout', '5s', true);
  lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
    public.watch_with_choices, public.custom_collections, public.watch_queues, public.queue_entries in exclusive mode;
  perform pg_advisory_xact_lock(hashtextextended('watchlist.queues ' || v_owner::text, 0)); -- (q1_lock's second step)
  perform private.lib_write_on();
  -- Restoring saved data isn't a research operation (private.research_write_guard). Cleared below; a failure discards it with the transaction.
  perform set_config('watchlist.research_restore', 'on', true);

  delete from public.queue_entries where user_id = v_owner;
  delete from public.watch_queues where user_id = v_owner;
  delete from public.update_findings where user_id = v_owner;
  delete from public.research_imports where user_id = v_owner;
  delete from public.research_briefs where user_id = v_owner;
  delete from public.record_aliases where user_id = v_owner;
  delete from public.membership_removals where user_id = v_owner;
  delete from public.show_update_settings where user_id = v_owner;
  delete from public.update_holds where user_id = v_owner;
  delete from public.collection_exclusions where user_id = v_owner;
  delete from public.collection_definitions where user_id = v_owner;
  delete from public.update_setup where user_id = v_owner;
  delete from public.collection_memberships where user_id = v_owner;
  -- (the ranges come back from the file)
  update public.tv_shows set resume_start_season_id = null, resume_end_season_id = null
  where user_id = v_owner and resume_start_season_id is not null;
  delete from public.watchlist_items where user_id = v_owner; -- episode marks and film links go with these
  delete from public.tv_shows where user_id = v_owner;        -- and show links with these
  delete from public.personal_collections where user_id = v_owner;
  delete from public.watch_with_choices where user_id = v_owner;
  delete from public.custom_collections where user_id = v_owner;

  begin
    -- (whatever the session's mode: shows name seasons inserted after them)
    set constraints public.tv_shows_resume_start_fkey, public.tv_shows_resume_end_fkey deferred;
    for i in 1 .. array_length(v_spec, 1) loop
      t := v_spec[i][1]; v_cols := v_spec[i][2];
      v_names := (select string_agg(split_part(c, ' ', 1), ', ') from unnest(string_to_array(v_cols, ', ')) c);
      execute format('insert into public.%I (%s) select %s from jsonb_to_recordset($1) as x(%s)', t, v_names, v_names, v_cols) using v_tables -> t;
      get diagnostics v_k = row_count;
      v_restored := v_restored || jsonb_build_object(t, v_k);
    end loop;
    set constraints public.tv_shows_resume_start_fkey, public.tv_shows_resume_end_fkey immediate;
    -- The queues' order keys are checked here, not at commit, so a repeated place is refused like any other rule.
    set constraints public.watch_queues_order_key, public.queue_entries_position_key immediate;
    t := 'queue_entries';
    if exists (select 1 from public.queue_entries w join public.queue_entries s on s.queue_id = w.queue_id and s.user_id = w.user_id
               join public.watchlist_items i on i.id = s.item_id where w.user_id = v_owner and w.show_id is not null and i.show_id = w.show_id) then
      raise exception 'a queue holds a whole show and one of its seasons' using errcode = 'P0001';
    end if;
  exception
    when unique_violation then
      get stacked diagnostics v_detail = constraint_name;
      if v_detail like '%\_pkey' or v_detail like '%\_id\_key' then
        raise exception 'restore_id_collision: this backup contains ids already owned by another user; restoring it would keep those ids and break user isolation, so nothing was changed'
          using errcode = '23505';
      end if;
      raise exception 'restore_invalid: the backup repeats a % row (%), so nothing was changed', t, v_detail using errcode = '22023';
    when foreign_key_violation then
      get stacked diagnostics v_detail = constraint_name;
      raise exception 'restore_invalid: a row in the backup points at something that isn''t in it or has the wrong kind (%), so nothing was changed', v_detail using errcode = '22023';
    when check_violation or not_null_violation or raise_exception or invalid_text_representation or numeric_value_out_of_range
         or datetime_field_overflow or invalid_datetime_format then
      get stacked diagnostics v_detail = message_text;
      raise exception 'restore_invalid: a % row in the backup breaks a rule (%), so nothing was changed', t, v_detail using errcode = '22023';
  end;

  -- The final state, every field of every table, after every insert and trigger: this owner has exactly the file's rows. The ids are unique,
  -- so equal counts and no file row missing mean the two sets are equal.
  for i in 1 .. array_length(v_spec, 1) loop
    t := v_spec[i][1]; v_cols := v_spec[i][2];
    v_names := (select string_agg(split_part(c, ' ', 1), ', ') from unnest(string_to_array(v_cols, ', ')) c);
    execute format('select (select count(*) from public.%I where user_id = $2) = jsonb_array_length($1) and not exists (select %s from jsonb_to_recordset($1) as x(%s) except select %s from public.%I where user_id = $2)',
      t, v_names, v_cols, v_names, t) into v_same using v_tables -> t, v_owner;
    if not v_same then raise exception 'restore_invalid: the restored % differ from the backup, so nothing was changed', t using errcode = '22023'; end if;
  end loop;

  perform set_config('watchlist.research_restore', '', true);
  return jsonb_build_object('formatVersion', 8, 'restored', v_restored);
end $$;

-- ── 7. Grants ───────────────────────────────────────────────────────────────────
-- Explicit, then verified: default privileges owned by supabase_admin can't be relied on.
revoke all on public.watch_queues, public.queue_entries from public, anon, authenticated;
grant select, delete on public.watch_queues, public.queue_entries to authenticated;
-- (id and created_at: restore writes them; the guard still refuses any insert outside a library function or restore)
grant insert (id, name, sort_order, created_at), update (name, sort_order) on public.watch_queues to authenticated;
grant insert (id, queue_id, show_id, item_id, position, created_at), update (show_id, item_id, position) on public.queue_entries to authenticated;
revoke all on function private.q1_lock(uuid), private.q1_write_begin(), private.q1_write_end(text), private.q1_show_complete(uuid),
  private.q1_entry_json(public.queue_entries), private.q1_queue(uuid, uuid), private.q1_moved(uuid[], uuid, integer),
  private.q1_item_watched(), private.q1_show_ended(), private.q1_season_moved() from public, anon;
revoke all on function private.q1_item_watched(), private.q1_show_ended(), private.q1_season_moved() from authenticated; -- (triggers need no grant)
grant execute on function private.q1_lock(uuid), private.q1_write_begin(), private.q1_write_end(text), private.q1_show_complete(uuid),
  private.q1_entry_json(public.queue_entries), private.q1_queue(uuid, uuid), private.q1_moved(uuid[], uuid, integer) to authenticated;
revoke all on function public.library_queue_create(text), public.library_queue_rename(uuid, text, text), public.library_queue_delete(uuid, integer),
  public.library_queue_reorder(uuid[], uuid, integer), public.library_queue_add(uuid, uuid, uuid), public.library_queue_remove(uuid),
  public.library_queue_move(uuid, uuid[], uuid, integer), public.restore_backup(jsonb, boolean) from public, anon;
grant execute on function public.library_queue_create(text), public.library_queue_rename(uuid, text, text), public.library_queue_delete(uuid, integer),
  public.library_queue_reorder(uuid[], uuid, integer), public.library_queue_add(uuid, uuid, uuid), public.library_queue_remove(uuid),
  public.library_queue_move(uuid, uuid[], uuid, integer), public.restore_backup(jsonb, boolean) to authenticated;

-- ── 8. The capability and the run record ────────────────────────────────────────
create or replace function public.stage5_capabilities() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted-q1', 'backup_format', 8, 'b45', 1, 'ep1', 1, 'cu1', 1, 'q1', 1, 'access', 'members',
    'member', private.is_member(), 'research', private.research_enabled(),
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;
revoke execute on function public.stage5_capabilities() from public, anon;
grant execute on function public.stage5_capabilities() to authenticated;
insert into private.migration_runs (run_id, migration) select run_id, 'q1' from q1_ctx;

-- ── 9. Verify before commit ─────────────────────────────────────────────────────
do $$
declare c record; t text; f text;
begin
  select * into c from q1_ctx;
  if pg_temp.q1_fp() is distinct from c.library_before then raise exception 'q1: a library row or a membership changed'; end if;
  foreach t in array array['public.watch_queues', 'public.queue_entries'] loop
    if not (select relrowsecurity from pg_class where oid = t::regclass)
       or (select count(*) from pg_policies where schemaname || '.' || tablename = t) <> 5
       or has_table_privilege('anon', t, 'select,insert,update,delete,truncate,references,trigger')
       or has_table_privilege('authenticated', t, 'insert,update,truncate,references,trigger') then
      raise exception 'q1: % isn''t closed as designed', t;
    end if;
    if (select count(*) from pg_trigger where tgrelid = t::regclass and not tgisinternal and tgname like '%write_guard') <> 1 then raise exception 'q1: % has no write guard', t; end if;
  end loop;
  foreach f in array array['public.library_queue_create(text)', 'public.library_queue_rename(uuid, text, text)', 'public.library_queue_delete(uuid, integer)',
    'public.library_queue_reorder(uuid[], uuid, integer)', 'public.library_queue_add(uuid, uuid, uuid)', 'public.library_queue_remove(uuid)',
    'public.library_queue_move(uuid, uuid[], uuid, integer)', 'public.restore_backup(jsonb, boolean)', 'public.stage5_capabilities()'] loop
    if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')
       or (select prosecdef from pg_proc where oid = f::regprocedure) then
      raise exception 'q1: % isn''t executable as designed', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'private.q1_lock(uuid)', 'execute') or has_function_privilege('authenticated', 'private.q1_item_watched()', 'execute') then
    raise exception 'q1: a helper is executable by a role that shouldn''t have it';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'restore_backup') <> 1 then raise exception 'q1: more than one restore_backup'; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-q1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '8' then
    raise exception 'q1: the capability isn''t as designed: %', public.stage5_capabilities();
  end if;
end $$;

select 'Q1|' || json_build_object('run', (select run_id from q1_ctx)) as result;

notify pgrst, 'reload schema';
commit;
