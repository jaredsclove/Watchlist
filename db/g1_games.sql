-- G1: games (next-gen item 5). One transaction, run as postgres on a contracted-q1 database (backup format 8, access = members).
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.g1_run', '<a fresh run id, recorded before running>', false);
-- What it adds (every table owner-only like the library: M1 policies, nothing for anon, written only through the functions below,
-- a restore or the completion trigger, library_write_guard):
--   * public.game_settings: a member's platforms and play style (one row; none until first saved).
--   * public.game_entries: a saved game version (an IGDB record) with its status and priority, the franchise spot it counts for
--     (spot_igdb_id, the original's IGDB record) and the ordinary port records joined to it (port_ids). The spot and ports are
--     stored so that a later IGDB correction never changes progress by itself: the page offers it for review.
--   * public.game_follows: followed franchises (an IGDB series collection). Following is explicit; saving a game follows nothing.
--   * public.game_decisions: the member's standing decisions about IGDB facts: Not out yet (a platform release held out of Up
--     next while IGDB's row is unchanged), Available (title-specific Store or publisher evidence; research access only), Skip this
--     spot, Include a spin-off, Keep my link (an IGDB relationship change the member declined).
--   * public.game_collections and public.game_collection_members: private, hand-made game collections.
--   * public.game_titles: this member's cache of IGDB details (replaceable; not in backups; library_game_titles_purge empties it).
--   * public.queue_entries.game_entry_id: a queue entry may be a game. Exactly one of a show, a library row or a game.
--   * Functions: library_game_settings_save, library_game_add / _set / _relink / _delete, library_game_follow / _unfollow,
--     library_game_decision_set, library_game_collection_create / _rename / _delete / _add / _remove, library_game_titles_put /
--     _purge, library_queue_add_game, library_queue_set_order (a whole queue's order in one guarded write, for queues with
--     entries the page hides).
--   * Completion: a game set to Finished (from any other status) leaves every queue in the same transaction. Nothing else does.
--   * public.restore_backup takes format 9 (format 8's twenty-one tables plus six game tables; queue entries carry
--     game_entry_id); 5 to 8 are converted in the page.
--   * stage5_capabilities(): phase contracted-g1, backup_format 9. A page from before this migration sees another phase and stops
--     writing, making backups and restoring until it is reloaded, so no format-8 backup can leave games out.
-- Existing rows are not changed: every existing table's rows are fingerprinted before and checked after (queue entries without
-- their new, empty column).
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate execution). Never rerun
-- to find out; a rerun is refused once this committed. No rollback (fix-forward); earlier definitions are in git.
begin;
select set_config('application_name', 'watchlist-g1-' || coalesce(nullif(current_setting('watchlist.g1_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;
do $$
begin
  if exists (select 1 from private.migration_runs r where r.migration = 'g1') then raise exception 'g1: already installed; nothing was changed'; end if;
end $$;
lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships, public.watch_with_choices,
  public.custom_collections, public.catalog_show_links, public.catalog_film_links, public.episode_marks, public.update_setup,
  public.collection_definitions, public.collection_exclusions, public.update_holds, public.record_aliases, public.membership_removals,
  public.show_update_settings, public.research_briefs, public.research_imports, public.update_findings, public.watch_queues,
  public.queue_entries, private.library_members in share row exclusive mode;

-- ── 1. Preconditions and the before-state ─────────────────────────────────────
create temp table g1_tables (t text primary key) on commit drop;
insert into g1_tables values ('private.library_members'), ('public.tv_shows'), ('public.watchlist_items'), ('public.personal_collections'),
  ('public.collection_memberships'), ('public.watch_with_choices'), ('public.custom_collections'), ('public.catalog_show_links'),
  ('public.catalog_film_links'), ('public.episode_marks'), ('public.update_setup'), ('public.collection_definitions'),
  ('public.collection_exclusions'), ('public.update_holds'), ('public.record_aliases'), ('public.membership_removals'),
  ('public.show_update_settings'), ('public.research_briefs'), ('public.research_imports'), ('public.update_findings'),
  ('public.watch_queues'), ('public.queue_entries');
-- Each row as JSON without the column this migration adds (queue entries), so the before and after states compare.
create or replace function pg_temp.g1_fp() returns text language plpgsql as $$
declare r record; v text; v_all text := '';
begin
  for r in select t from g1_tables order by t loop
    execute format('select coalesce(md5(string_agg(md5((to_jsonb(x) - ''game_entry_id'')::text), '','' order by md5((to_jsonb(x) - ''game_entry_id'')::text))), '''') from %s x', r.t) into v;
    v_all := v_all || r.t || ':' || v || ';';
  end loop;
  return md5(v_all);
end $$;
create temp table g1_ctx on commit drop as
select nullif(current_setting('watchlist.g1_run', true), '') as run_id, pg_temp.g1_fp() as library_before;
do $$
declare c record;
begin
  select * into c from g1_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'g1: set watchlist.g1_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'g1: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-q1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '8'
     or public.stage5_capabilities() ->> 'access' is distinct from 'members' then
    raise exception 'g1: expected phase contracted-q1, backup format 8 and access = members; nothing was changed';
  end if;
  if not exists (select 1 from private.migration_runs r where r.migration = 'q1')
     or (select prosrc from pg_proc where oid = 'public.restore_backup(jsonb, boolean)'::regprocedure) !~ 'unexpected set of tables for format 8' then
    raise exception 'g1: public.restore_backup is not Q1''s format-8 function; nothing was changed';
  end if;
  if to_regclass('public.game_entries') is not null or to_regclass('public.game_settings') is not null or to_regclass('public.game_titles') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'game_entry_id') then
    raise exception 'g1: the game tables already exist; nothing was changed';
  end if;
  if to_regprocedure('private.q1_lock(uuid)') is null or to_regprocedure('private.q1_queue(uuid, uuid)') is null or to_regprocedure('private.lib_refuse(text, text)') is null
     or to_regprocedure('private.b45_changed()') is null or to_regprocedure('private.research_enabled()') is null or to_regprocedure('private.library_write_guard()') is null then
    raise exception 'g1: a helper it relies on is missing; nothing was changed';
  end if;
end $$;

-- ── 2. Tables, guards and policies ─────────────────────────────────────────────
-- The platforms a member can choose (the page's list; IGDB's platform ids are mapped in games-data.js).
create function private.g1_platforms_ok(p text[]) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and cardinality(p) <= 7 and p <@ array['ps5', 'ps4', 'switch2', 'switch', 'xbox_series', 'xbox_one', 'pc']::text[]
     and cardinality(p) = (select count(distinct x) from unnest(p) x)
$$;
create function private.g1_ids_ok(p integer[]) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and cardinality(p) <= 50 and 0 < all(p) and cardinality(p) = (select count(distinct x) from unnest(p) x)
$$;

create table public.game_settings (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  platforms text[] not null default '{}',
  play_style text not null default 'main',
  updated_at timestamptz not null default now(),
  constraint game_settings_pkey primary key (id),
  constraint game_settings_owner_key unique (user_id),
  constraint game_settings_platforms_check check (private.g1_platforms_ok(platforms)),
  constraint game_settings_style_check check (play_style in ('main', 'main_extra', 'completionist'))
);
comment on table public.game_settings is 'G1: a member''s game platforms and play style (follows them across devices; in backups).';

create table public.game_entries (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  igdb_id integer not null,
  spot_igdb_id integer not null,
  port_ids integer[] not null default '{}',
  title text not null,
  status text not null default 'want',
  priority text not null default 'normal',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint game_entries_pkey primary key (id),
  constraint game_entries_id_owner_key unique (id, user_id),
  constraint game_entries_igdb_key unique (user_id, igdb_id),
  constraint game_entries_ids_check check (igdb_id > 0 and spot_igdb_id > 0 and private.g1_ids_ok(port_ids) and not (igdb_id = any(port_ids))),
  constraint game_entries_title_check check (title = btrim(title) and title <> '' and char_length(title) <= 300),
  constraint game_entries_status_check check (status in ('want', 'playing', 'paused', 'finished', 'skipped')),
  constraint game_entries_priority_check check (priority in ('high', 'normal', 'low'))
);
create index game_entries_port_ids_idx on public.game_entries using gin (port_ids);
comment on table public.game_entries is 'G1: a saved game version (an IGDB record), its status and priority, its franchise spot and joined port records.';

create table public.game_follows (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  igdb_collection_id integer not null,
  name text not null,
  created_at timestamptz not null default now(),
  constraint game_follows_pkey primary key (id),
  constraint game_follows_id_owner_key unique (id, user_id),
  constraint game_follows_collection_key unique (user_id, igdb_collection_id),
  constraint game_follows_collection_check check (igdb_collection_id > 0),
  constraint game_follows_name_check check (name = btrim(name) and name <> '' and char_length(name) <= 200)
);
comment on table public.game_follows is 'G1: a followed franchise (an IGDB series collection). Following is explicit.';

create table public.game_decisions (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  kind text not null,
  igdb_id integer not null,
  platform text not null default '',
  value jsonb not null default '{}'::jsonb,
  basis text not null default 'member',
  created_at timestamptz not null default now(),
  constraint game_decisions_pkey primary key (id),
  constraint game_decisions_key unique (user_id, kind, igdb_id, platform),
  constraint game_decisions_kind_check check (kind in ('not_out_yet', 'available', 'skip_spot', 'include_spinoff', 'keep_link')),
  constraint game_decisions_platform_check check ((kind in ('not_out_yet', 'available')) = (platform <> '')
    and (platform = '' or private.g1_platforms_ok(array[platform]))),
  constraint game_decisions_igdb_check check (igdb_id > 0),
  constraint game_decisions_value_check check (jsonb_typeof(value) = 'object' and octet_length(value::text) <= 4000),
  constraint game_decisions_basis_check check (basis in ('member', 'research') and (basis = 'research') = (kind = 'available'))
);
comment on table public.game_decisions is 'G1: standing decisions about IGDB facts (Not out yet, Available, Skip this spot, Include a spin-off, Keep my link).';

create table public.game_collections (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now(),
  constraint game_collections_pkey primary key (id),
  constraint game_collections_id_owner_key unique (id, user_id),
  constraint game_collections_name_check check (name = btrim(name) and name <> '' and char_length(name) <= 100)
);
create unique index game_collections_name_key on public.game_collections using btree (user_id, lower(name));
comment on table public.game_collections is 'G1: a member''s private, hand-made game collection.';

create table public.game_collection_members (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  collection_id uuid not null,
  entry_id uuid not null,
  created_at timestamptz not null default now(),
  constraint game_collection_members_pkey primary key (id),
  constraint game_collection_members_key unique (collection_id, entry_id),
  constraint game_collection_members_collection_fkey foreign key (collection_id, user_id) references public.game_collections (id, user_id) on delete cascade,
  constraint game_collection_members_entry_fkey foreign key (entry_id, user_id) references public.game_entries (id, user_id) on delete cascade
);
create index game_collection_members_entry_idx on public.game_collection_members using btree (entry_id);
comment on table public.game_collection_members is 'G1: a saved game in a game collection.';

create table public.game_titles (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  igdb_id integer not null,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  constraint game_titles_pkey primary key (id),
  constraint game_titles_key unique (user_id, igdb_id),
  constraint game_titles_igdb_check check (igdb_id > 0),
  constraint game_titles_data_check check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 40000)
);
comment on table public.game_titles is 'G1: this member''s cache of IGDB details. Replaceable, never in backups; library_game_titles_purge empties it.';

-- A queue entry may be a game (exactly one of a show, a library row or a game).
alter table public.queue_entries add column game_entry_id uuid;
alter table public.queue_entries drop constraint queue_entries_target_check;
alter table public.queue_entries add constraint queue_entries_target_check
  check (num_nonnulls(show_id, item_id, game_entry_id) = 1);
alter table public.queue_entries add constraint queue_entries_game_fkey foreign key (game_entry_id, user_id)
  references public.game_entries (id, user_id) on delete cascade;
create unique index queue_entries_game_key on public.queue_entries using btree (queue_id, game_entry_id) where (game_entry_id is not null);
create index queue_entries_game_entry_id_idx on public.queue_entries using btree (game_entry_id);

do $$
declare t text;
begin
  foreach t in array array['game_settings', 'game_entries', 'game_follows', 'game_decisions', 'game_collections', 'game_collection_members', 'game_titles'] loop
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function private.library_write_guard()', t || '_write_guard', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t);
    execute format('create policy owner_update on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy members_only on public.%I as restrictive for all to authenticated using ((select private.is_member())) with check ((select private.is_member()))', t);
  end loop;
end $$;

-- ── 3. Helpers ─────────────────────────────────────────────────────────────────
-- One member's game changes that read before they write (settings, follows, decisions, collections, the cache) run one after
-- another. A game entry's own changes lock its row instead; anything touching queues then takes the queue lock (q1_lock) after.
create function private.g1_lock(p_owner uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('watchlist.games ' || p_owner::text, 0));
end $$;
create function private.g1_entry_json(e public.game_entries) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'igdb_id', e.igdb_id, 'spot_igdb_id', e.spot_igdb_id, 'port_ids', to_jsonb(e.port_ids), 'title', e.title,
    'status', e.status, 'priority', e.priority, 'created_at', e.created_at, 'updated_at', e.updated_at)
$$;
-- A member's entry, locked; refused when it isn't theirs or is gone.
create function private.g1_entry(p_owner uuid, p_entry_id uuid) returns public.game_entries
language plpgsql set search_path = '' as $$
declare e public.game_entries;
begin
  select * into e from public.game_entries where id = p_entry_id and user_id = p_owner for update;
  if e.id is null then perform private.lib_refuse('target_missing', 'This game is no longer in your library, so nothing was changed.'); end if;
  return e;
end $$;
-- An IGDB record already saved by this member, as the entry itself or one of its joined ports (null: none).
create function private.g1_saved_as(p_owner uuid, p_igdb integer, p_except uuid) returns uuid
language sql stable set search_path = '' as $$
  select id from public.game_entries where user_id = p_owner and id is distinct from p_except and (igdb_id = p_igdb or p_igdb = any(port_ids)) limit 1
$$;
create function private.g1_title_ok(p text, p_max integer) returns boolean
language sql immutable set search_path = '' as $$ select p is not null and p = btrim(p) and p <> '' and char_length(p) <= p_max $$;

-- The queue entries' JSON now names a game too.
create or replace function private.q1_entry_json(e public.queue_entries) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'queue_id', e.queue_id, 'show_id', e.show_id, 'item_id', e.item_id, 'game_entry_id', e.game_entry_id,
    'position', e.position, 'created_at', e.created_at)
$$;

-- ── 4. Functions ───────────────────────────────────────────────────────────────
-- Settings: the platforms and play style. p_expected: what the page showed ({platforms, play_style}), or null for "not chosen yet".
create function public.library_game_settings_save(p_expected jsonb, p_platforms text[], p_play_style text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); s public.game_settings;
begin
  if not private.g1_platforms_ok(p_platforms) or p_play_style is null or p_play_style not in ('main', 'main_extra', 'completionist')
     or (p_expected is not null and jsonb_typeof(p_expected) is distinct from 'object') then
    raise exception 'invalid_input: settings' using errcode = '22023';
  end if;
  perform private.g1_lock(v_owner);
  select * into s from public.game_settings where user_id = v_owner;
  if (s.id is null) <> (p_expected is null)
     or (s.id is not null and (to_jsonb(s.platforms) is distinct from p_expected -> 'platforms' or s.play_style is distinct from p_expected ->> 'play_style')) then
    perform private.b45_changed();
  end if;
  perform set_config('watchlist.library_write', 'on', true);
  if s.id is null then
    insert into public.game_settings (platforms, play_style) values (p_platforms, p_play_style) returning * into s;
  else
    update public.game_settings set platforms = p_platforms, play_style = p_play_style, updated_at = now() where id = s.id returning * into s;
  end if;
  return jsonb_build_object('id', s.id, 'platforms', to_jsonb(s.platforms), 'play_style', s.play_style, 'updated_at', s.updated_at);
end $$;

-- Saves a game version. Refused when the record (or one of its ports) is already saved, as an entry or a joined port.
create function public.library_game_add(p_igdb_id integer, p_title text, p_spot_igdb_id integer, p_port_ids integer[], p_status text, p_priority text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); e public.game_entries; v_id integer;
begin
  if p_igdb_id is null or p_igdb_id < 1 or p_spot_igdb_id is null or p_spot_igdb_id < 1 or not private.g1_ids_ok(p_port_ids) or p_igdb_id = any(p_port_ids)
     or not private.g1_title_ok(p_title, 300) or p_status not in ('want', 'playing', 'paused', 'finished', 'skipped') or p_priority not in ('high', 'normal', 'low') then
    raise exception 'invalid_input: game' using errcode = '22023';
  end if;
  perform private.g1_lock(v_owner);
  foreach v_id in array array[p_igdb_id] || p_port_ids loop
    if private.g1_saved_as(v_owner, v_id, null) is not null then
      perform private.lib_refuse('game_duplicate', 'This game is already in your library, so nothing was changed.');
    end if;
  end loop;
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.game_entries (igdb_id, spot_igdb_id, port_ids, title, status, priority)
  values (p_igdb_id, p_spot_igdb_id, p_port_ids, p_title, p_status, p_priority) returning * into e;
  return private.g1_entry_json(e);
end $$;

-- Status and priority, with the values the page showed ({status, priority}). Set to Finished (from anything else), the game
-- leaves every queue in this transaction (the trigger below); the answer says how many entries went.
create function public.library_game_set(p_entry_id uuid, p_expected jsonb, p_status text, p_priority text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); e public.game_entries; v_n integer := 0;
begin
  if p_entry_id is null or jsonb_typeof(p_expected) is distinct from 'object' or p_status not in ('want', 'playing', 'paused', 'finished', 'skipped')
     or p_priority not in ('high', 'normal', 'low') then
    raise exception 'invalid_input: game' using errcode = '22023';
  end if;
  e := private.g1_entry(v_owner, p_entry_id);
  if e.status is distinct from p_expected ->> 'status' or e.priority is distinct from p_expected ->> 'priority' then perform private.b45_changed(); end if;
  if p_status = 'finished' and e.status <> 'finished' then select count(*) into v_n from public.queue_entries where game_entry_id = e.id; end if;
  perform set_config('watchlist.library_write', 'on', true);
  update public.game_entries set status = p_status, priority = p_priority, updated_at = now() where id = e.id returning * into e;
  return private.g1_entry_json(e) || jsonb_build_object('queue_entries_removed', v_n);
end $$;

-- The spot and joined ports, after the member's review ({spot_igdb_id, port_ids} as the page showed them).
create function public.library_game_relink(p_entry_id uuid, p_expected jsonb, p_spot_igdb_id integer, p_port_ids integer[]) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); e public.game_entries; v_id integer;
begin
  if p_entry_id is null or jsonb_typeof(p_expected) is distinct from 'object' or p_spot_igdb_id is null or p_spot_igdb_id < 1 or not private.g1_ids_ok(p_port_ids) then
    raise exception 'invalid_input: link' using errcode = '22023';
  end if;
  -- The entry first (as Add to a collection does), then the member's games lock.
  e := private.g1_entry(v_owner, p_entry_id);
  perform private.g1_lock(v_owner);
  if p_expected -> 'spot_igdb_id' is distinct from to_jsonb(e.spot_igdb_id) or p_expected -> 'port_ids' is distinct from to_jsonb(e.port_ids) then perform private.b45_changed(); end if;
  if e.igdb_id = any(p_port_ids) then raise exception 'invalid_input: link' using errcode = '22023'; end if;
  foreach v_id in array p_port_ids loop
    if private.g1_saved_as(v_owner, v_id, e.id) is not null then
      perform private.lib_refuse('game_duplicate', 'One of these records is already saved as another game, so nothing was changed.');
    end if;
  end loop;
  perform set_config('watchlist.library_write', 'on', true);
  update public.game_entries set spot_igdb_id = p_spot_igdb_id, port_ids = p_port_ids, updated_at = now() where id = e.id returning * into e;
  return private.g1_entry_json(e);
end $$;

-- Deletes a game from the library (its queue entries and collection memberships go with it). p_expected_status: as shown.
create function public.library_game_delete(p_entry_id uuid, p_expected_status text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); e public.game_entries; v_q integer; v_c integer;
begin
  if p_entry_id is null or p_expected_status is null then raise exception 'invalid_input: game' using errcode = '22023'; end if;
  e := private.g1_entry(v_owner, p_entry_id);
  if e.status is distinct from p_expected_status then perform private.b45_changed(); end if;
  perform private.q1_lock(v_owner);
  select count(*) into v_q from public.queue_entries where game_entry_id = e.id;
  select count(*) into v_c from public.game_collection_members where entry_id = e.id;
  perform set_config('watchlist.library_write', 'on', true);
  delete from public.game_entries where id = e.id;
  return jsonb_build_object('deleted_id', e.id, 'queue_entries_removed', v_q, 'collection_memberships_removed', v_c);
end $$;

create function public.library_game_follow(p_collection_igdb_id integer, p_name text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); f public.game_follows;
begin
  if p_collection_igdb_id is null or p_collection_igdb_id < 1 or not private.g1_title_ok(p_name, 200) then raise exception 'invalid_input: follow' using errcode = '22023'; end if;
  perform private.g1_lock(v_owner);
  if exists (select 1 from public.game_follows where user_id = v_owner and igdb_collection_id = p_collection_igdb_id) then
    perform private.lib_refuse('game_follow_exists', 'You already follow this franchise, so nothing was changed.');
  end if;
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.game_follows (igdb_collection_id, name) values (p_collection_igdb_id, p_name) returning * into f;
  return jsonb_build_object('id', f.id, 'igdb_collection_id', f.igdb_collection_id, 'name', f.name, 'created_at', f.created_at);
end $$;

-- Stops following (saved games, decisions and queues are untouched). An already removed follow is reported, not refused.
create function public.library_game_unfollow(p_follow_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); v_id uuid;
begin
  if p_follow_id is null then raise exception 'invalid_input: follow' using errcode = '22023'; end if;
  perform private.g1_lock(v_owner);
  perform set_config('watchlist.library_write', 'on', true);
  delete from public.game_follows where id = p_follow_id and user_id = v_owner returning id into v_id;
  return jsonb_build_object('follow_id', p_follow_id, 'removed', v_id is not null);
end $$;

-- Sets or clears (p_value null) one standing decision. p_expected: the decision's value as the page showed it, or null for none.
-- Available needs research access (it records title-specific evidence); the others are every member's own.
create function public.library_game_decision_set(p_kind text, p_igdb_id integer, p_platform text, p_expected jsonb, p_value jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); d public.game_decisions; v_platform text := coalesce(p_platform, '');
begin
  if p_kind is null or p_kind not in ('not_out_yet', 'available', 'skip_spot', 'include_spinoff', 'keep_link') or p_igdb_id is null or p_igdb_id < 1
     or (p_kind in ('not_out_yet', 'available')) <> (v_platform <> '') or (v_platform <> '' and not private.g1_platforms_ok(array[v_platform]))
     or (p_value is not null and (jsonb_typeof(p_value) is distinct from 'object' or octet_length(p_value::text) > 4000)) then
    raise exception 'invalid_input: decision' using errcode = '22023';
  end if;
  if p_kind = 'available' and not private.research_enabled() then
    raise exception 'research_not_enabled: Recording release evidence needs research access. Nothing was changed.' using errcode = 'P0001';
  end if;
  perform private.g1_lock(v_owner);
  select * into d from public.game_decisions where user_id = v_owner and kind = p_kind and igdb_id = p_igdb_id and platform = v_platform;
  if (d.id is null) <> (p_expected is null) or (d.id is not null and d.value is distinct from p_expected) then perform private.b45_changed(); end if;
  perform set_config('watchlist.library_write', 'on', true);
  if p_value is null then
    delete from public.game_decisions where id = d.id;
    return jsonb_build_object('kind', p_kind, 'igdb_id', p_igdb_id, 'platform', v_platform, 'removed', d.id is not null);
  end if;
  if d.id is null then
    insert into public.game_decisions (kind, igdb_id, platform, value, basis)
    values (p_kind, p_igdb_id, v_platform, p_value, case when p_kind = 'available' then 'research' else 'member' end) returning * into d;
  else
    update public.game_decisions set value = p_value, created_at = now() where id = d.id returning * into d;
  end if;
  return jsonb_build_object('id', d.id, 'kind', d.kind, 'igdb_id', d.igdb_id, 'platform', d.platform, 'value', d.value, 'basis', d.basis, 'created_at', d.created_at);
end $$;

create function public.library_game_collection_create(p_name text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); c public.game_collections;
begin
  if not private.g1_title_ok(p_name, 100) then raise exception 'invalid_input: name' using errcode = '22023'; end if;
  perform private.g1_lock(v_owner);
  if exists (select 1 from public.game_collections where user_id = v_owner and lower(name) = lower(p_name)) then
    perform private.lib_refuse('collection_name_taken', 'You already have a game collection with this name, so nothing was changed.');
  end if;
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.game_collections (name) values (p_name) returning * into c;
  return jsonb_build_object('id', c.id, 'name', c.name, 'created_at', c.created_at);
end $$;

create function public.library_game_collection_rename(p_collection_id uuid, p_expected_name text, p_name text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); c public.game_collections;
begin
  if p_collection_id is null or p_expected_name is null or not private.g1_title_ok(p_name, 100) then raise exception 'invalid_input: name' using errcode = '22023'; end if;
  perform private.g1_lock(v_owner);
  select * into c from public.game_collections where id = p_collection_id and user_id = v_owner;
  if c.id is null then perform private.lib_refuse('collection_missing', 'This game collection is no longer there, so nothing was changed.'); end if;
  if c.name is distinct from p_expected_name then perform private.b45_changed(); end if;
  if exists (select 1 from public.game_collections where user_id = v_owner and id <> c.id and lower(name) = lower(p_name)) then
    perform private.lib_refuse('collection_name_taken', 'You already have a game collection with this name, so nothing was changed.');
  end if;
  perform set_config('watchlist.library_write', 'on', true);
  update public.game_collections set name = p_name where id = c.id returning * into c;
  return jsonb_build_object('id', c.id, 'name', c.name, 'created_at', c.created_at);
end $$;

-- Deletes a game collection (never its games). p_expected_count: the members the page showed.
create function public.library_game_collection_delete(p_collection_id uuid, p_expected_count integer) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); c public.game_collections; v_n integer;
begin
  if p_collection_id is null or p_expected_count is null or p_expected_count < 0 then raise exception 'invalid_input: collection' using errcode = '22023'; end if;
  perform private.g1_lock(v_owner);
  select * into c from public.game_collections where id = p_collection_id and user_id = v_owner;
  if c.id is null then perform private.lib_refuse('collection_missing', 'This game collection is no longer there, so nothing was changed.'); end if;
  select count(*) into v_n from public.game_collection_members where collection_id = c.id;
  if v_n <> p_expected_count then perform private.b45_changed(); end if;
  perform set_config('watchlist.library_write', 'on', true);
  delete from public.game_collections where id = c.id;
  return jsonb_build_object('deleted_collection_id', c.id, 'members_removed', v_n);
end $$;

create function public.library_game_collection_add(p_collection_id uuid, p_entry_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); c public.game_collections; e public.game_entries; m public.game_collection_members;
begin
  if p_collection_id is null or p_entry_id is null then raise exception 'invalid_input: member' using errcode = '22023'; end if;
  select * into e from public.game_entries where id = p_entry_id and user_id = v_owner for share;
  if e.id is null then perform private.lib_refuse('target_missing', 'This game is no longer in your library, so nothing was changed.'); end if;
  perform private.g1_lock(v_owner);
  select * into c from public.game_collections where id = p_collection_id and user_id = v_owner;
  if c.id is null then perform private.lib_refuse('collection_missing', 'This game collection is no longer there, so nothing was changed.'); end if;
  if exists (select 1 from public.game_collection_members where collection_id = c.id and entry_id = e.id) then
    perform private.lib_refuse('collection_duplicate', format('This game is already in “%s”, so nothing was changed.', c.name));
  end if;
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.game_collection_members (collection_id, entry_id) values (c.id, e.id) returning * into m;
  return jsonb_build_object('id', m.id, 'collection_id', m.collection_id, 'entry_id', m.entry_id, 'created_at', m.created_at);
end $$;

-- Removes a game from a collection (never from the library). An already removed member is reported, not refused.
create function public.library_game_collection_remove(p_member_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); v_id uuid;
begin
  if p_member_id is null then raise exception 'invalid_input: member' using errcode = '22023'; end if;
  perform private.g1_lock(v_owner);
  perform set_config('watchlist.library_write', 'on', true);
  delete from public.game_collection_members where id = p_member_id and user_id = v_owner returning id into v_id;
  return jsonb_build_object('member_id', p_member_id, 'removed', v_id is not null);
end $$;

-- The IGDB cache: up to 500 records per call, each [{igdb_id, data}], replacing what was cached for them.
create function public.library_game_titles_put(p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); v_n integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 500
     or exists (select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r -> 'igdb_id') is distinct from 'number' or jsonb_typeof(r -> 'data') is distinct from 'object')
     or (select count(*) from jsonb_array_elements(p_rows)) <> (select count(distinct r ->> 'igdb_id') from jsonb_array_elements(p_rows) r) then
    raise exception 'invalid_input: titles' using errcode = '22023';
  end if;
  perform private.g1_lock(v_owner);
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.game_titles (igdb_id, data, fetched_at)
  select (r ->> 'igdb_id')::integer, r -> 'data', now() from jsonb_array_elements(p_rows) r
  on conflict (user_id, igdb_id) do update set data = excluded.data, fetched_at = excluded.fetched_at;
  get diagnostics v_n = row_count;
  return jsonb_build_object('cached', v_n);
end $$;

-- Empties this member's IGDB cache (the provider's data, not the member's; Refresh fills it again).
create function public.library_game_titles_purge() returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); v_n integer;
begin
  perform private.g1_lock(v_owner);
  perform set_config('watchlist.library_write', 'on', true);
  delete from public.game_titles where user_id = v_owner;
  get diagnostics v_n = row_count;
  return jsonb_build_object('removed', v_n);
end $$;

-- Adds a saved game at the end of a queue. Its status and priority are never changed; a Finished game may be added (a replay).
create function public.library_queue_add_game(p_queue_id uuid, p_entry_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); q public.watch_queues; g public.game_entries; e public.queue_entries; v_pos integer;
begin
  if p_queue_id is null or p_entry_id is null then raise exception 'invalid_input: game' using errcode = '22023'; end if;
  -- The game first (shared), then the member's queue lock (Q1's lock order).
  select * into g from public.game_entries where id = p_entry_id and user_id = v_owner for share;
  if g.id is null then perform private.lib_refuse('target_missing', 'This game is no longer in your library, so nothing was changed.'); end if;
  perform private.q1_lock(v_owner);
  q := private.q1_queue(v_owner, p_queue_id);
  select * into e from public.queue_entries x where x.queue_id = q.id and x.game_entry_id = g.id;
  if e.id is not null then
    perform private.lib_refuse('queue_duplicate', format('This is already in “%s” (#%s), so nothing was changed.', q.name,
      (select count(*) from public.queue_entries x where x.queue_id = q.id and x.position <= e.position)));
  end if;
  v_pos := coalesce((select max(position) from public.queue_entries where queue_id = q.id), 0) + 1;
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.queue_entries (queue_id, game_entry_id, position) values (q.id, g.id, v_pos) returning * into e;
  return private.q1_entry_json(e) || jsonb_build_object('place', (select count(*) from public.queue_entries x where x.queue_id = q.id));
end $$;

-- A whole queue's order in one guarded write: p_expected is every entry id in the order the page has (hidden entries included),
-- p_order the same ids in their new order. Used where the page keeps hidden entries in their places while the visible ones move.
create function public.library_queue_set_order(p_queue_id uuid, p_expected uuid[], p_order uuid[]) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); q public.watch_queues; v_now uuid[];
begin
  if p_queue_id is null or p_expected is null or p_order is null then raise exception 'invalid_input: order' using errcode = '22023'; end if;
  perform private.q1_lock(v_owner);
  q := private.q1_queue(v_owner, p_queue_id);
  v_now := coalesce((select array_agg(id order by position, id) from public.queue_entries where queue_id = q.id), '{}');
  if v_now is distinct from p_expected then perform private.b45_changed(); end if;
  if cardinality(p_order) <> cardinality(v_now) or array_position(p_order, null) is not null
     or (select count(distinct x) from unnest(p_order) x) <> cardinality(v_now) or not (p_order <@ v_now) then
    raise exception 'invalid_input: the new order must hold exactly the queue''s entries' using errcode = '22023';
  end if;
  perform set_config('watchlist.library_write', 'on', true);
  update public.queue_entries e set position = o.n from unnest(p_order) with ordinality o(id, n) where e.id = o.id and e.position is distinct from o.n;
  return jsonb_build_object('queue_id', q.id, 'order', to_jsonb(p_order));
end $$;

-- ── 5. Completion ──────────────────────────────────────────────────────────────
-- A game explicitly set to Finished (from any other status) leaves every queue. Nothing else here removes an entry: a restore
-- inserts (no update), and a Finished game queued again for a replay stays until it is set to Finished again.
create function private.g1_game_finished() returns trigger
language plpgsql set search_path = '' as $$
declare v_prev text;
begin
  perform private.q1_lock(new.user_id);
  v_prev := private.q1_write_begin();
  delete from public.queue_entries where game_entry_id = new.id and user_id = new.user_id;
  perform private.q1_write_end(v_prev);
  return null;
end $$;
create trigger game_entries_g1_finished after update of status on public.game_entries
  for each row when (old.status is distinct from 'finished' and new.status = 'finished') execute function private.g1_game_finished();

-- ── 6. The restore, format 9 ────────────────────────────────────────────────────
-- Q1's flat function with the six game tables added and queue entries' game_entry_id. The IGDB cache (game_titles) isn't part of
-- a backup and isn't touched: it is the provider's data, keyed by IGDB id, refilled by Refresh.
create or replace function public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean default false)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_version text := p_backup ->> 'formatVersion';
  v_tables jsonb := p_backup -> 'tables';
  v_counts jsonb := p_backup -> 'rowCounts';
  -- Every table of a format-9 backup, references first, with its columns.
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
    ['game_settings', 'id uuid, platforms text[], play_style text, updated_at timestamptz'],
    ['game_entries', 'id uuid, igdb_id integer, spot_igdb_id integer, port_ids integer[], title text, status text, priority text, created_at timestamptz, updated_at timestamptz'],
    ['game_follows', 'id uuid, igdb_collection_id integer, name text, created_at timestamptz'],
    ['game_decisions', 'id uuid, kind text, igdb_id integer, platform text, value jsonb, basis text, created_at timestamptz'],
    ['game_collections', 'id uuid, name text, created_at timestamptz'],
    ['game_collection_members', 'id uuid, collection_id uuid, entry_id uuid, created_at timestamptz'],
    ['watch_queues', 'id uuid, name text, sort_order integer, created_at timestamptz'],
    ['queue_entries', 'id uuid, queue_id uuid, show_id uuid, item_id uuid, game_entry_id uuid, position integer, created_at timestamptz']];
  v_restored jsonb := '{}';
  t text; v_cols text; v_names text; v_keys text[]; v_k int; v_same boolean; v_detail text; i int;
begin
  if p_backup ->> 'format' is distinct from 'watchlist-tracker-backup' then
    raise exception 'restore_invalid: not a Watchlist backup' using errcode = '22023';
  end if;
  if v_version in ('1', '2', '3', '4') then
    raise exception 'restore_invalid: format % backups can no longer be restored; nothing was changed', v_version using errcode = '22023';
  elsif v_version in ('5', '6', '7', '8') then
    raise exception 'restore_invalid: format % backups are converted in the page first; nothing was changed', v_version using errcode = '22023';
  elsif v_version is distinct from '9' then
    raise exception 'restore_invalid: unsupported backup format %', coalesce(v_version, '(none)') using errcode = '22023';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_backup) k)
     <@ array['conversion', 'exportedAt', 'format', 'formatVersion', 'recovery', 'rowCounts', 'tables']::text[] is not true then
    raise exception 'restore_invalid: unexpected top-level fields' using errcode = '22023';
  end if;
  if jsonb_typeof(v_tables) is distinct from 'object' or jsonb_typeof(v_counts) is distinct from 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(v_tables) k)
        is distinct from (select array_agg(v_spec[n][1] order by v_spec[n][1] collate "C") from generate_subscripts(v_spec, 1) n) then
    raise exception 'restore_invalid: unexpected set of tables for format 9' using errcode = '22023';
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
  if jsonb_array_length(v_tables -> 'game_settings') > 1 then raise exception 'restore_invalid: more than one game_settings row' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(v_tables -> 'collection_definitions') d
             where not private.cu1_rules_ok(coalesce(d -> 'rules', 'null')) or not private.cu1_evidence_settings_ok(coalesce(d -> 'evidence', 'null'))
                or d -> 'rule_hashes' is distinct from private.cu1_rule_hashes(d -> 'rules') or d ->> 'evidence_hash' is distinct from md5((d -> 'evidence')::text)) then
    raise exception 'restore_invalid: a collection definition in the backup isn''t consistent, so nothing was changed' using errcode = '22023';
  end if;

  perform set_config('lock_timeout', '5s', true);
  lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
    public.watch_with_choices, public.custom_collections, public.game_settings, public.game_entries, public.game_follows, public.game_decisions,
    public.game_collections, public.game_collection_members, public.watch_queues, public.queue_entries in exclusive mode;
  perform pg_advisory_xact_lock(hashtextextended('watchlist.queues ' || v_owner::text, 0)); -- (q1_lock's second step)
  perform private.g1_lock(v_owner);
  perform private.lib_write_on();
  -- Restoring saved data isn't a research operation (private.research_write_guard). Cleared below; a failure discards it with the transaction.
  perform set_config('watchlist.research_restore', 'on', true);

  delete from public.queue_entries where user_id = v_owner;
  delete from public.watch_queues where user_id = v_owner;
  delete from public.game_collection_members where user_id = v_owner;
  delete from public.game_collections where user_id = v_owner;
  delete from public.game_decisions where user_id = v_owner;
  delete from public.game_follows where user_id = v_owner;
  delete from public.game_entries where user_id = v_owner;
  delete from public.game_settings where user_id = v_owner;
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
    t := 'game_entries';
    if exists (select 1 from public.game_entries a join public.game_entries b on b.user_id = a.user_id and b.id <> a.id
               where a.user_id = v_owner and (b.igdb_id = any(a.port_ids) or a.port_ids && b.port_ids)) then
      raise exception 'an IGDB record is saved as two games' using errcode = 'P0001';
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
  return jsonb_build_object('formatVersion', 9, 'restored', v_restored);
end $$;

-- ── 7. Grants ───────────────────────────────────────────────────────────────────
-- Explicit, then verified: default privileges owned by supabase_admin can't be relied on.
revoke all on public.game_settings, public.game_entries, public.game_follows, public.game_decisions, public.game_collections,
  public.game_collection_members, public.game_titles from public, anon, authenticated;
grant select, delete on public.game_settings, public.game_entries, public.game_follows, public.game_decisions, public.game_collections,
  public.game_collection_members, public.game_titles to authenticated;
-- (ids and timestamps: restore writes them; the guard still refuses any write outside a library function or restore)
grant insert (id, platforms, play_style, updated_at), update (platforms, play_style, updated_at) on public.game_settings to authenticated;
grant insert (id, igdb_id, spot_igdb_id, port_ids, title, status, priority, created_at, updated_at),
  update (spot_igdb_id, port_ids, status, priority, updated_at) on public.game_entries to authenticated;
grant insert (id, igdb_collection_id, name, created_at) on public.game_follows to authenticated;
grant insert (id, kind, igdb_id, platform, value, basis, created_at), update (value, created_at) on public.game_decisions to authenticated;
grant insert (id, name, created_at), update (name) on public.game_collections to authenticated;
grant insert (id, collection_id, entry_id, created_at) on public.game_collection_members to authenticated;
grant insert (id, igdb_id, data, fetched_at), update (data, fetched_at) on public.game_titles to authenticated;
grant insert (game_entry_id) on public.queue_entries to authenticated;
revoke all on function private.g1_platforms_ok(text[]), private.g1_ids_ok(integer[]), private.g1_lock(uuid), private.g1_entry_json(public.game_entries),
  private.g1_entry(uuid, uuid), private.g1_saved_as(uuid, integer, uuid), private.g1_title_ok(text, integer), private.g1_game_finished() from public, anon;
revoke all on function private.g1_game_finished() from authenticated; -- (a trigger needs no grant)
grant execute on function private.g1_platforms_ok(text[]), private.g1_ids_ok(integer[]), private.g1_lock(uuid), private.g1_entry_json(public.game_entries),
  private.g1_entry(uuid, uuid), private.g1_saved_as(uuid, integer, uuid), private.g1_title_ok(text, integer) to authenticated;
revoke all on function private.q1_entry_json(public.queue_entries) from public, anon;
grant execute on function private.q1_entry_json(public.queue_entries) to authenticated;
revoke all on function public.library_game_settings_save(jsonb, text[], text), public.library_game_add(integer, text, integer, integer[], text, text),
  public.library_game_set(uuid, jsonb, text, text), public.library_game_relink(uuid, jsonb, integer, integer[]), public.library_game_delete(uuid, text),
  public.library_game_follow(integer, text), public.library_game_unfollow(uuid), public.library_game_decision_set(text, integer, text, jsonb, jsonb),
  public.library_game_collection_create(text), public.library_game_collection_rename(uuid, text, text), public.library_game_collection_delete(uuid, integer),
  public.library_game_collection_add(uuid, uuid), public.library_game_collection_remove(uuid), public.library_game_titles_put(jsonb), public.library_game_titles_purge(),
  public.library_queue_add_game(uuid, uuid), public.library_queue_set_order(uuid, uuid[], uuid[]), public.restore_backup(jsonb, boolean) from public, anon;
grant execute on function public.library_game_settings_save(jsonb, text[], text), public.library_game_add(integer, text, integer, integer[], text, text),
  public.library_game_set(uuid, jsonb, text, text), public.library_game_relink(uuid, jsonb, integer, integer[]), public.library_game_delete(uuid, text),
  public.library_game_follow(integer, text), public.library_game_unfollow(uuid), public.library_game_decision_set(text, integer, text, jsonb, jsonb),
  public.library_game_collection_create(text), public.library_game_collection_rename(uuid, text, text), public.library_game_collection_delete(uuid, integer),
  public.library_game_collection_add(uuid, uuid), public.library_game_collection_remove(uuid), public.library_game_titles_put(jsonb), public.library_game_titles_purge(),
  public.library_queue_add_game(uuid, uuid), public.library_queue_set_order(uuid, uuid[], uuid[]), public.restore_backup(jsonb, boolean) to authenticated;

-- ── 8. The capability and the run record ────────────────────────────────────────
create or replace function public.stage5_capabilities() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted-g1', 'backup_format', 9, 'b45', 1, 'ep1', 1, 'cu1', 1, 'q1', 1, 'g1', 1, 'access', 'members',
    'member', private.is_member(), 'research', private.research_enabled(),
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;
revoke execute on function public.stage5_capabilities() from public, anon;
grant execute on function public.stage5_capabilities() to authenticated;
insert into private.migration_runs (run_id, migration) select run_id, 'g1' from g1_ctx;

-- ── 9. Verify before commit ─────────────────────────────────────────────────────
do $$
declare c record; t text; f text;
begin
  select * into c from g1_ctx;
  if pg_temp.g1_fp() is distinct from c.library_before then raise exception 'g1: an existing library row, queue or membership changed'; end if;
  if exists (select 1 from public.queue_entries where game_entry_id is not null) then raise exception 'g1: a queue entry names a game already'; end if;
  foreach t in array array['public.game_settings', 'public.game_entries', 'public.game_follows', 'public.game_decisions', 'public.game_collections',
    'public.game_collection_members', 'public.game_titles'] loop
    if not (select relrowsecurity from pg_class where oid = t::regclass)
       or (select count(*) from pg_policies where schemaname || '.' || tablename = t) <> 5
       or has_table_privilege('anon', t, 'select,insert,update,delete,truncate,references,trigger')
       or has_table_privilege('authenticated', t, 'insert,update,truncate,references,trigger') then
      raise exception 'g1: % isn''t closed as designed', t;
    end if;
    if (select count(*) from pg_trigger where tgrelid = t::regclass and not tgisinternal and tgname like '%write_guard') <> 1 then raise exception 'g1: % has no write guard', t; end if;
  end loop;
  if has_table_privilege('anon', 'public.queue_entries', 'select,insert,update,delete') or has_column_privilege('anon', 'public.queue_entries', 'game_entry_id', 'select,insert') then
    raise exception 'g1: queue entries are open to anon';
  end if;
  foreach f in array array['public.library_game_settings_save(jsonb, text[], text)', 'public.library_game_add(integer, text, integer, integer[], text, text)',
    'public.library_game_set(uuid, jsonb, text, text)', 'public.library_game_relink(uuid, jsonb, integer, integer[])', 'public.library_game_delete(uuid, text)',
    'public.library_game_follow(integer, text)', 'public.library_game_unfollow(uuid)', 'public.library_game_decision_set(text, integer, text, jsonb, jsonb)',
    'public.library_game_collection_create(text)', 'public.library_game_collection_rename(uuid, text, text)', 'public.library_game_collection_delete(uuid, integer)',
    'public.library_game_collection_add(uuid, uuid)', 'public.library_game_collection_remove(uuid)', 'public.library_game_titles_put(jsonb)', 'public.library_game_titles_purge()',
    'public.library_queue_add_game(uuid, uuid)', 'public.library_queue_set_order(uuid, uuid[], uuid[])', 'public.restore_backup(jsonb, boolean)',
    'public.stage5_capabilities()', 'public.library_queue_move(uuid, uuid[], uuid, integer)', 'public.library_queue_add(uuid, uuid, uuid)'] loop
    if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')
       or (select prosecdef from pg_proc where oid = f::regprocedure) then
      raise exception 'g1: % isn''t executable as designed', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'private.g1_lock(uuid)', 'execute') or has_function_privilege('authenticated', 'private.g1_game_finished()', 'execute') then
    raise exception 'g1: a helper is executable by a role that shouldn''t have it';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'restore_backup') <> 1 then raise exception 'g1: more than one restore_backup'; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-g1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '9' then
    raise exception 'g1: the capability isn''t as designed: %', public.stage5_capabilities();
  end if;
end $$;

select 'G1|' || json_build_object('run', (select run_id from g1_ctx)) as result;

notify pgrst, 'reload schema';
commit;
