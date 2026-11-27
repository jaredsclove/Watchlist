-- BK1: books (next-gen item 6). One transaction, run as postgres on a database with G1 and TC1 (phase contracted-g1, backup
-- format 9, access = members).
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.bk1_run', '<a fresh run id, recorded before running>', false);
-- What it adds (every table owner-only like the library: M1 policies, nothing for anon, written only through the functions below
-- or a restore, library_write_guard):
--   * public.book_entries: a saved book (one entry per underlying book; editions and formats are never tracked), its status
--     (Want to read, Reading, Paused, Finished, Dropped), its Hardcover book id when it has one (none for a book entered by hand or
--     found only on an official site), the title, authors and series placements it was saved with, and a date the member chose
--     (chosen_date), which nothing but the member changes.
--   * public.book_follows: followed authors and series (Hardcover ids). A followed series may add new main-series titles
--     automatically on Refresh (auto_add, off unless the member turns it on). Following is explicit; saving a book follows nothing.
--   * public.book_sites: an author's official book-listing page, which Refresh books reads (the member's setting).
--   * public.book_associations: "this book is by this author" for a book Hardcover credits to someone else (a manual correction).
--   * public.book_decisions: standing decisions: skip (pass over in series progress), exclude (a removed or dismissed title stays
--     out until added again), keep_date (a date suggestion declined), not_same (two records kept apart), not_author (a credit
--     suggestion declined). Keys are text ("hc:<Hardcover id>", "e:<entry id>", "t:<author>:<title>" or a finding fingerprint).
--   * public.book_findings: open review items from Refresh books (Hardcover and official sites): pending or later. A decided item
--     leaves this table; its decision (or the saved book) keeps it from coming back.
--   * public.book_cache: this member's copy of Hardcover records and of each official site's last reading. Replaceable: never in a
--     backup, untouched by restore; library_book_cache_purge empties it.
--   * public.restore_backup takes format 10 (format 9's twenty-seven tables plus six book tables); 5 to 9 are converted in the page.
--   * stage5_capabilities(): phase contracted-bk1, backup_format 10, bk1: 1. A page from before this migration sees another phase
--     and stops writing, making backups and restoring until it is reloaded, so no format-9 backup can leave books out.
-- Existing rows are not changed: every existing table's rows are fingerprinted before and checked after.
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate execution). Never rerun
-- to find out; a rerun is refused once this committed. No rollback (fix-forward); earlier definitions are in git.
begin;
select set_config('application_name', 'watchlist-bk1-' || coalesce(nullif(current_setting('watchlist.bk1_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;
do $$
begin
  if exists (select 1 from private.migration_runs r where r.migration = 'bk1') then raise exception 'bk1: already installed; nothing was changed'; end if;
end $$;
lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships, public.watch_with_choices,
  public.custom_collections, public.catalog_show_links, public.catalog_film_links, public.episode_marks, public.update_setup,
  public.collection_definitions, public.collection_exclusions, public.update_holds, public.record_aliases, public.membership_removals,
  public.show_update_settings, public.research_briefs, public.research_imports, public.update_findings, public.watch_queues,
  public.queue_entries, public.game_settings, public.game_entries, public.game_follows, public.game_decisions, public.game_collections,
  public.game_collection_members, public.game_titles, public.tmdb_tv_cache, private.library_members in share row exclusive mode;

-- ── 1. Preconditions and the before-state ─────────────────────────────────────
create temp table bk1_tables (t text primary key) on commit drop;
insert into bk1_tables values ('private.library_members'), ('public.tv_shows'), ('public.watchlist_items'), ('public.personal_collections'),
  ('public.collection_memberships'), ('public.watch_with_choices'), ('public.custom_collections'), ('public.catalog_show_links'),
  ('public.catalog_film_links'), ('public.episode_marks'), ('public.update_setup'), ('public.collection_definitions'),
  ('public.collection_exclusions'), ('public.update_holds'), ('public.record_aliases'), ('public.membership_removals'),
  ('public.show_update_settings'), ('public.research_briefs'), ('public.research_imports'), ('public.update_findings'),
  ('public.watch_queues'), ('public.queue_entries'), ('public.game_settings'), ('public.game_entries'), ('public.game_follows'),
  ('public.game_decisions'), ('public.game_collections'), ('public.game_collection_members'), ('public.game_titles'), ('public.tmdb_tv_cache');
create or replace function pg_temp.bk1_fp() returns text language plpgsql as $$
declare r record; v text; v_all text := '';
begin
  for r in select t from bk1_tables order by t loop
    execute format('select coalesce(md5(string_agg(md5(to_jsonb(x)::text), '','' order by md5(to_jsonb(x)::text))), '''') from %s x', r.t) into v;
    v_all := v_all || r.t || ':' || v || ';';
  end loop;
  return md5(v_all);
end $$;
create temp table bk1_ctx on commit drop as
select nullif(current_setting('watchlist.bk1_run', true), '') as run_id, pg_temp.bk1_fp() as library_before;
do $$
declare c record;
begin
  select * into c from bk1_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'bk1: set watchlist.bk1_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'bk1: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-g1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '9'
     or public.stage5_capabilities() ->> 'access' is distinct from 'members' or (public.stage5_capabilities() ->> 'tc1') is distinct from '1'
     or not exists (select 1 from private.migration_runs r where r.migration = 'g1') or not exists (select 1 from private.migration_runs r where r.migration = 'tc1') then
    raise exception 'bk1: expected G1 and TC1 (phase contracted-g1, backup format 9, access = members); nothing was changed';
  end if;
  if (select prosrc from pg_proc where oid = 'public.restore_backup(jsonb, boolean)'::regprocedure) !~ 'unexpected set of tables for format 9' then
    raise exception 'bk1: public.restore_backup is not G1''s format-9 function; nothing was changed';
  end if;
  if to_regclass('public.book_entries') is not null or to_regclass('public.book_cache') is not null then
    raise exception 'bk1: the book tables already exist; nothing was changed';
  end if;
  if to_regprocedure('private.g1_lock(uuid)') is null or to_regprocedure('private.lib_refuse(text, text)') is null or to_regprocedure('private.b45_changed()') is null
     or to_regprocedure('private.library_write_guard()') is null or to_regprocedure('private.lib_write_on()') is null or to_regprocedure('private.g1_title_ok(text, integer)') is null then
    raise exception 'bk1: a helper it relies on is missing; nothing was changed';
  end if;
end $$;

-- ── 2. Shape checks ────────────────────────────────────────────────────────────
-- A list of people (a book's authors): up to 20 objects {name, id?}, the name trimmed and not empty, the id a Hardcover author id.
create function private.bk1_people_ok(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 20 and octet_length(p::text) <= 6000
     and not exists (select 1 from jsonb_array_elements(p) x where jsonb_typeof(x) <> 'object'
       or exists (select 1 from jsonb_object_keys(x) k where k not in ('id', 'name'))
       or jsonb_typeof(x -> 'name') is distinct from 'string' or not private.g1_title_ok(x ->> 'name', 200)
       or (x ? 'id' and jsonb_typeof(x -> 'id') <> 'null' and (jsonb_typeof(x -> 'id') <> 'number' or (x ->> 'id') !~ '^[1-9][0-9]{0,9}$')))
$$;
-- Series placements: up to 10 objects {name, id?, position?}; a position is "3", "1.5" or absent (an unnumbered companion).
create function private.bk1_series_ok(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 10 and octet_length(p::text) <= 4000
     and not exists (select 1 from jsonb_array_elements(p) x where jsonb_typeof(x) <> 'object'
       or exists (select 1 from jsonb_object_keys(x) k where k not in ('id', 'name', 'position'))
       or jsonb_typeof(x -> 'name') is distinct from 'string' or not private.g1_title_ok(x ->> 'name', 200)
       or (x ? 'id' and jsonb_typeof(x -> 'id') <> 'null' and (jsonb_typeof(x -> 'id') <> 'number' or (x ->> 'id') !~ '^[1-9][0-9]{0,9}$'))
       or (x ? 'position' and jsonb_typeof(x -> 'position') <> 'null' and (jsonb_typeof(x -> 'position') <> 'string' or (x ->> 'position') !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$')))
$$;
create function private.bk1_url_ok(p text) returns boolean
language sql immutable set search_path = '' as $$ select p is not null and char_length(p) <= 500 and p ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$' $$;
-- A date the member chose: {value, source, url?, chosen_at?}; value YYYY, YYYY-MM, YYYY-MM-DD or TBA; source member or website.
create function private.bk1_date_ok(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p is null or (jsonb_typeof(p) = 'object' and octet_length(p::text) <= 1000
     and not exists (select 1 from jsonb_object_keys(p) k where k not in ('value', 'source', 'url', 'chosen_at'))
     and jsonb_typeof(p -> 'value') = 'string' and (p ->> 'value') ~ '^([0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?|TBA)$'
     and jsonb_typeof(p -> 'source') = 'string' and (p ->> 'source') in ('member', 'website')
     and (not (p ? 'url') or jsonb_typeof(p -> 'url') = 'null' or (jsonb_typeof(p -> 'url') = 'string' and private.bk1_url_ok(p ->> 'url')))
     and (not (p ? 'chosen_at') or jsonb_typeof(p -> 'chosen_at') in ('null', 'string')))
$$;
create function private.bk1_key_ok(p text) returns boolean
language sql immutable set search_path = '' as $$ select p is not null and char_length(p) between 3 and 300 and p ~ '^[a-z]{1,3}:[^[:space:]]+$' $$;
create function private.bk1_keys_ok(p text[]) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and cardinality(p) <= 20 and not exists (select 1 from unnest(p) k where not private.bk1_key_ok(k))
$$;
create function private.bk1_status_ok(p text) returns boolean
language sql immutable set search_path = '' as $$ select p in ('want', 'reading', 'paused', 'finished', 'dropped') $$;

-- ── 3. Tables, guards and policies ─────────────────────────────────────────────
create table public.book_entries (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  hardcover_id integer,
  title text not null,
  authors jsonb not null default '[]'::jsonb,
  series jsonb not null default '[]'::jsonb,
  status text not null default 'want',
  chosen_date jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint book_entries_pkey primary key (id),
  constraint book_entries_id_owner_key unique (id, user_id),
  constraint book_entries_hardcover_check check (hardcover_id is null or hardcover_id > 0),
  constraint book_entries_title_check check (private.g1_title_ok(title, 300)),
  constraint book_entries_authors_check check (private.bk1_people_ok(authors)),
  constraint book_entries_series_check check (private.bk1_series_ok(series)),
  constraint book_entries_status_check check (private.bk1_status_ok(status)),
  constraint book_entries_date_check check (private.bk1_date_ok(chosen_date))
);
create unique index book_entries_hardcover_key on public.book_entries using btree (user_id, hardcover_id) where (hardcover_id is not null);
comment on table public.book_entries is 'BK1: a saved book (one per underlying book), its status, its Hardcover id when it has one, and a date the member chose.';

create table public.book_follows (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  kind text not null,
  hardcover_id integer not null,
  name text not null,
  auto_add boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint book_follows_pkey primary key (id),
  constraint book_follows_key unique (user_id, kind, hardcover_id),
  constraint book_follows_kind_check check (kind in ('author', 'series') and (kind = 'series' or not auto_add)),
  constraint book_follows_id_check check (hardcover_id > 0),
  constraint book_follows_name_check check (private.g1_title_ok(name, 200))
);
comment on table public.book_follows is 'BK1: a followed author or series (Hardcover ids); a series may add new main-series titles automatically (auto_add).';

create table public.book_sites (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  hardcover_author_id integer not null,
  author_name text not null,
  listing_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint book_sites_pkey primary key (id),
  constraint book_sites_author_key unique (user_id, hardcover_author_id),
  constraint book_sites_author_check check (hardcover_author_id > 0),
  constraint book_sites_name_check check (private.g1_title_ok(author_name, 200)),
  constraint book_sites_url_check check (private.bk1_url_ok(listing_url))
);
comment on table public.book_sites is 'BK1: an author''s official book-listing page, read by Refresh books (the member''s setting).';

create table public.book_associations (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  hardcover_book_id integer not null,
  hardcover_author_id integer not null,
  author_name text not null,
  created_at timestamptz not null default now(),
  constraint book_associations_pkey primary key (id),
  constraint book_associations_key unique (user_id, hardcover_book_id, hardcover_author_id),
  constraint book_associations_ids_check check (hardcover_book_id > 0 and hardcover_author_id > 0),
  constraint book_associations_name_check check (private.g1_title_ok(author_name, 200))
);
comment on table public.book_associations is 'BK1: a manual author credit for a Hardcover book credited to someone else.';

create table public.book_decisions (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  kind text not null,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint book_decisions_pkey primary key (id),
  constraint book_decisions_key unique (user_id, kind, key),
  constraint book_decisions_kind_check check (kind in ('skip', 'exclude', 'keep_date', 'not_same', 'not_author')),
  constraint book_decisions_key_check check (private.bk1_key_ok(key)),
  constraint book_decisions_value_check check (jsonb_typeof(value) = 'object' and octet_length(value::text) <= 4000)
);
comment on table public.book_decisions is 'BK1: standing book decisions: skip in series progress, exclude (removed or dismissed), and declined suggestions.';

create table public.book_findings (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  fingerprint text not null,
  source text not null,
  kind text not null,
  status text not null default 'pending',
  subject jsonb not null,
  evidence jsonb not null default '[]'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint book_findings_pkey primary key (id),
  constraint book_findings_key unique (user_id, fingerprint),
  constraint book_findings_fingerprint_check check (private.bk1_key_ok(fingerprint)),
  constraint book_findings_source_check check (source in ('hardcover', 'website')),
  constraint book_findings_kind_check check (kind in ('new_book', 'date', 'credit_gap', 'match', 'duplicate', 'site_changed')),
  constraint book_findings_status_check check (status in ('pending', 'later')),
  constraint book_findings_subject_check check (jsonb_typeof(subject) = 'object' and octet_length(subject::text) <= 8000),
  constraint book_findings_evidence_check check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 10 and octet_length(evidence::text) <= 4000)
);
comment on table public.book_findings is 'BK1: open review items from Refresh books (pending or later); a decided item leaves this table.';

create table public.book_cache (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  kind text not null,
  key text not null,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  constraint book_cache_pkey primary key (id),
  constraint book_cache_key unique (user_id, kind, key),
  constraint book_cache_kind_check check (kind in ('book', 'author', 'series', 'site')),
  constraint book_cache_key_check check (char_length(key) between 1 and 100),
  constraint book_cache_data_check check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 60000)
);
comment on table public.book_cache is 'BK1: this member''s copy of Hardcover records and official-site readings. Replaceable, never in backups; library_book_cache_purge empties it.';

do $$
declare t text;
begin
  foreach t in array array['book_entries', 'book_follows', 'book_sites', 'book_associations', 'book_decisions', 'book_findings', 'book_cache'] loop
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function private.library_write_guard()', t || '_write_guard', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t);
    execute format('create policy owner_update on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy members_only on public.%I as restrictive for all to authenticated using ((select private.is_member())) with check ((select private.is_member()))', t);
  end loop;
end $$;

-- ── 4. Helpers ─────────────────────────────────────────────────────────────────
-- Every book change of one member runs one after another: the book tables in row exclusive mode first (a restore's exclusive lock
-- blocks this), then the member's advisory lock, as g1_lock does, so a books change and a restore wait for each other in one order.
create function private.bk1_lock(p_owner uuid) returns void
language plpgsql set search_path = '' as $$
begin
  lock table public.book_entries, public.book_follows, public.book_sites, public.book_associations, public.book_decisions,
    public.book_findings, public.book_cache in row exclusive mode;
  perform pg_advisory_xact_lock(hashtextextended('watchlist.books ' || p_owner::text, 0));
end $$;
create function private.bk1_entry_json(e public.book_entries) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'hardcover_id', e.hardcover_id, 'title', e.title, 'authors', e.authors, 'series', e.series,
    'status', e.status, 'chosen_date', e.chosen_date, 'created_at', e.created_at, 'updated_at', e.updated_at)
$$;
-- A member's entry; refused when it isn't theirs or is gone. (Called with the member's books lock held.)
create function private.bk1_entry(p_owner uuid, p_entry_id uuid) returns public.book_entries
language plpgsql set search_path = '' as $$
declare e public.book_entries;
begin
  select * into e from public.book_entries where id = p_entry_id and user_id = p_owner for update;
  if e.id is null then perform private.lib_refuse('target_missing', 'This book is no longer in your library, so nothing was changed.'); end if;
  return e;
end $$;
-- Closes an open finding the change settles (its row goes; the change itself keeps it from coming back).
create function private.bk1_close(p_owner uuid, p_fingerprint text) returns integer
language plpgsql set search_path = '' as $$
declare v_n integer;
begin
  if p_fingerprint is null then return 0; end if;
  delete from public.book_findings where user_id = p_owner and fingerprint = p_fingerprint;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ── 5. Functions ───────────────────────────────────────────────────────────────
-- Saves a book. p_book: {hardcover_id?, title, authors, series, chosen_date?}. Refused when that Hardcover book is already saved.
-- p_clear_keys: the exclusions this explicit add lifts (the book's own keys: a removed or dismissed title is reconsidered by adding
-- it again). p_finding: the review item it settles, if any.
create function public.library_book_add(p_book jsonb, p_status text, p_clear_keys text[], p_finding text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); e public.book_entries; v_hc integer; v_cleared integer;
begin
  if jsonb_typeof(p_book) is distinct from 'object' or exists (select 1 from jsonb_object_keys(p_book) k where k not in ('hardcover_id', 'title', 'authors', 'series', 'chosen_date'))
     or (p_book ? 'hardcover_id' and jsonb_typeof(p_book -> 'hardcover_id') <> 'null' and (jsonb_typeof(p_book -> 'hardcover_id') <> 'number' or (p_book ->> 'hardcover_id') !~ '^[1-9][0-9]{0,9}$'))
     or jsonb_typeof(p_book -> 'title') is distinct from 'string' or not private.g1_title_ok(p_book ->> 'title', 300)
     or not private.bk1_people_ok(coalesce(p_book -> 'authors', '[]')) or not private.bk1_series_ok(coalesce(p_book -> 'series', '[]'))
     or not private.bk1_date_ok(nullif(p_book -> 'chosen_date', 'null'::jsonb)) or not private.bk1_status_ok(p_status)
     or not private.bk1_keys_ok(coalesce(p_clear_keys, '{}')) or (p_finding is not null and not private.bk1_key_ok(p_finding)) then
    raise exception 'invalid_input: book' using errcode = '22023';
  end if;
  v_hc := nullif(p_book ->> 'hardcover_id', '')::integer;
  perform private.bk1_lock(v_owner);
  if v_hc is not null and exists (select 1 from public.book_entries where user_id = v_owner and hardcover_id = v_hc) then
    perform private.lib_refuse('book_duplicate', 'This book is already in your library, so nothing was changed.');
  end if;
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.book_entries (hardcover_id, title, authors, series, status, chosen_date)
  values (v_hc, p_book ->> 'title', coalesce(p_book -> 'authors', '[]'), coalesce(p_book -> 'series', '[]'), p_status, nullif(p_book -> 'chosen_date', 'null'::jsonb))
  returning * into e;
  delete from public.book_decisions where user_id = v_owner and kind = 'exclude' and key = any(coalesce(p_clear_keys, '{}'));
  get diagnostics v_cleared = row_count;
  perform private.bk1_close(v_owner, p_finding);
  return private.bk1_entry_json(e) || jsonb_build_object('exclusions_lifted', v_cleared);
end $$;

-- The status, with the one the page showed.
create function public.library_book_set(p_entry_id uuid, p_expected_status text, p_status text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); e public.book_entries;
begin
  if p_entry_id is null or p_expected_status is null or not private.bk1_status_ok(p_status) then raise exception 'invalid_input: book' using errcode = '22023'; end if;
  perform private.bk1_lock(v_owner);
  e := private.bk1_entry(v_owner, p_entry_id);
  if e.status is distinct from p_expected_status then perform private.b45_changed(); end if;
  perform set_config('watchlist.library_write', 'on', true);
  update public.book_entries set status = p_status, updated_at = now() where id = e.id returning * into e;
  return private.bk1_entry_json(e);
end $$;

-- Edits the title, authors, series placements or chosen date (p_fields: any of those keys). p_expected: the same keys as the page
-- showed them. A chosen date of null clears the member's choice (the provider's date shows again).
create function public.library_book_edit(p_entry_id uuid, p_expected jsonb, p_fields jsonb, p_finding text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); e public.book_entries; k text;
begin
  if p_entry_id is null or jsonb_typeof(p_fields) is distinct from 'object' or jsonb_typeof(p_expected) is distinct from 'object'
     or not exists (select 1 from jsonb_object_keys(p_fields))
     or exists (select 1 from jsonb_object_keys(p_fields) k2 where k2 not in ('title', 'authors', 'series', 'chosen_date'))
     or (select array_agg(k2 order by k2) from jsonb_object_keys(p_fields) k2) is distinct from (select array_agg(k2 order by k2) from jsonb_object_keys(p_expected) k2)
     or (p_fields ? 'title' and (jsonb_typeof(p_fields -> 'title') is distinct from 'string' or not private.g1_title_ok(p_fields ->> 'title', 300)))
     or (p_fields ? 'authors' and not private.bk1_people_ok(p_fields -> 'authors'))
     or (p_fields ? 'series' and not private.bk1_series_ok(p_fields -> 'series'))
     or (p_fields ? 'chosen_date' and not private.bk1_date_ok(nullif(p_fields -> 'chosen_date', 'null'::jsonb)))
     or (p_finding is not null and not private.bk1_key_ok(p_finding)) then
    raise exception 'invalid_input: book' using errcode = '22023';
  end if;
  perform private.bk1_lock(v_owner);
  e := private.bk1_entry(v_owner, p_entry_id);
  for k in select jsonb_object_keys(p_expected) loop
    if coalesce(to_jsonb(e) -> k, 'null'::jsonb) is distinct from p_expected -> k then perform private.b45_changed(); end if;
  end loop;
  perform set_config('watchlist.library_write', 'on', true);
  update public.book_entries set
    title = case when p_fields ? 'title' then p_fields ->> 'title' else title end,
    authors = case when p_fields ? 'authors' then p_fields -> 'authors' else authors end,
    series = case when p_fields ? 'series' then p_fields -> 'series' else series end,
    chosen_date = case when p_fields ? 'chosen_date' then nullif(p_fields -> 'chosen_date', 'null'::jsonb) else chosen_date end,
    updated_at = now()
  where id = e.id returning * into e;
  perform private.bk1_close(v_owner, p_finding);
  return private.bk1_entry_json(e);
end $$;

-- Links a saved book to a Hardcover record (an explicit match of a book entered by hand or found on a site, or a relink). Its status,
-- chosen date, skip, exclusions and placements are kept; p_fields (optional: title, authors, series) replace those shown.
-- p_expected_hardcover_id: what the page showed (null: not linked). Refused when another saved book has that record.
create function public.library_book_link(p_entry_id uuid, p_expected_hardcover_id integer, p_hardcover_id integer, p_fields jsonb, p_finding text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); e public.book_entries;
begin
  if p_entry_id is null or p_hardcover_id is null or p_hardcover_id < 1
     or (p_fields is not null and (jsonb_typeof(p_fields) <> 'object' or exists (select 1 from jsonb_object_keys(p_fields) k where k not in ('title', 'authors', 'series'))
       or (p_fields ? 'title' and (jsonb_typeof(p_fields -> 'title') is distinct from 'string' or not private.g1_title_ok(p_fields ->> 'title', 300)))
       or (p_fields ? 'authors' and not private.bk1_people_ok(p_fields -> 'authors'))
       or (p_fields ? 'series' and not private.bk1_series_ok(p_fields -> 'series'))))
     or (p_finding is not null and not private.bk1_key_ok(p_finding)) then
    raise exception 'invalid_input: link' using errcode = '22023';
  end if;
  perform private.bk1_lock(v_owner);
  e := private.bk1_entry(v_owner, p_entry_id);
  if e.hardcover_id is distinct from p_expected_hardcover_id then perform private.b45_changed(); end if;
  if exists (select 1 from public.book_entries where user_id = v_owner and hardcover_id = p_hardcover_id and id <> e.id) then
    perform private.lib_refuse('book_duplicate', 'Another book in your library already has this Hardcover record, so nothing was changed.');
  end if;
  perform set_config('watchlist.library_write', 'on', true);
  update public.book_entries set hardcover_id = p_hardcover_id,
    title = case when p_fields ? 'title' then p_fields ->> 'title' else title end,
    authors = case when p_fields ? 'authors' then p_fields -> 'authors' else authors end,
    series = case when p_fields ? 'series' then p_fields -> 'series' else series end,
    updated_at = now()
  where id = e.id returning * into e;
  perform private.bk1_close(v_owner, p_finding);
  return private.bk1_entry_json(e);
end $$;

-- Deletes a book from the library. It stays out of later refreshes: p_exclude_keys (its Hardcover and title keys) become exclude
-- decisions in the same transaction, until the member adds it again. p_expected_status: as shown.
create function public.library_book_delete(p_entry_id uuid, p_expected_status text, p_exclude_keys text[]) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); e public.book_entries; v_n integer;
begin
  if p_entry_id is null or p_expected_status is null or not private.bk1_keys_ok(coalesce(p_exclude_keys, '{}')) or cardinality(coalesce(p_exclude_keys, '{}')) = 0 then
    raise exception 'invalid_input: book' using errcode = '22023';
  end if;
  perform private.bk1_lock(v_owner);
  e := private.bk1_entry(v_owner, p_entry_id);
  if e.status is distinct from p_expected_status then perform private.b45_changed(); end if;
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.book_decisions (kind, key, value)
  select 'exclude', k, jsonb_build_object('reason', 'removed', 'title', e.title) from unnest(p_exclude_keys) k
  on conflict (user_id, kind, key) do update set value = excluded.value, created_at = now();
  get diagnostics v_n = row_count;
  delete from public.book_entries where id = e.id;
  return jsonb_build_object('deleted_id', e.id, 'excluded', v_n);
end $$;

create function public.library_book_follow(p_kind text, p_hardcover_id integer, p_name text, p_auto_add boolean) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); f public.book_follows;
begin
  if p_kind is null or p_kind not in ('author', 'series') or p_hardcover_id is null or p_hardcover_id < 1 or not private.g1_title_ok(p_name, 200)
     or p_auto_add is null or (p_kind = 'author' and p_auto_add) then
    raise exception 'invalid_input: follow' using errcode = '22023';
  end if;
  perform private.bk1_lock(v_owner);
  if exists (select 1 from public.book_follows where user_id = v_owner and kind = p_kind and hardcover_id = p_hardcover_id) then
    perform private.lib_refuse('book_follow_exists', format('You already follow this %s, so nothing was changed.', p_kind));
  end if;
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.book_follows (kind, hardcover_id, name, auto_add) values (p_kind, p_hardcover_id, p_name, p_auto_add) returning * into f;
  return to_jsonb(f) - 'user_id';
end $$;

-- A followed series' "Automatically add new titles on refresh", with the value the page showed.
create function public.library_book_follow_set(p_follow_id uuid, p_expected_auto_add boolean, p_auto_add boolean) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); f public.book_follows;
begin
  if p_follow_id is null or p_expected_auto_add is null or p_auto_add is null then raise exception 'invalid_input: follow' using errcode = '22023'; end if;
  perform private.bk1_lock(v_owner);
  select * into f from public.book_follows where id = p_follow_id and user_id = v_owner;
  if f.id is null then perform private.lib_refuse('follow_missing', 'You no longer follow this, so nothing was changed.'); end if;
  if f.kind <> 'series' then raise exception 'invalid_input: follow' using errcode = '22023'; end if;
  if f.auto_add is distinct from p_expected_auto_add then perform private.b45_changed(); end if;
  perform set_config('watchlist.library_write', 'on', true);
  update public.book_follows set auto_add = p_auto_add, updated_at = now() where id = f.id returning * into f;
  return to_jsonb(f) - 'user_id';
end $$;

-- Stops following (saved books, decisions and sites are untouched). An already removed follow is reported, not refused.
create function public.library_book_unfollow(p_follow_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); v_id uuid;
begin
  if p_follow_id is null then raise exception 'invalid_input: follow' using errcode = '22023'; end if;
  perform private.bk1_lock(v_owner);
  perform set_config('watchlist.library_write', 'on', true);
  delete from public.book_follows where id = p_follow_id and user_id = v_owner returning id into v_id;
  return jsonb_build_object('follow_id', p_follow_id, 'removed', v_id is not null);
end $$;

-- An author's official book-listing page: set, changed or removed (p_url null). p_expected_url: as shown (null: none set).
create function public.library_book_site_set(p_author_id integer, p_author_name text, p_expected_url text, p_url text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); s public.book_sites;
begin
  if p_author_id is null or p_author_id < 1 or not private.g1_title_ok(p_author_name, 200) or (p_url is not null and not private.bk1_url_ok(p_url)) then
    raise exception 'invalid_input: site' using errcode = '22023';
  end if;
  perform private.bk1_lock(v_owner);
  select * into s from public.book_sites where user_id = v_owner and hardcover_author_id = p_author_id;
  if s.listing_url is distinct from p_expected_url then perform private.b45_changed(); end if;
  perform set_config('watchlist.library_write', 'on', true);
  if p_url is null then
    delete from public.book_sites where id = s.id;
    return jsonb_build_object('hardcover_author_id', p_author_id, 'removed', s.id is not null);
  end if;
  if s.id is null then
    insert into public.book_sites (hardcover_author_id, author_name, listing_url) values (p_author_id, p_author_name, p_url) returning * into s;
  else
    update public.book_sites set author_name = p_author_name, listing_url = p_url, updated_at = now() where id = s.id returning * into s;
  end if;
  return to_jsonb(s) - 'user_id';
end $$;

-- A manual author credit for a Hardcover book (p_on false: removed). p_finding: the credit suggestion it settles.
create function public.library_book_association_set(p_book_id integer, p_author_id integer, p_author_name text, p_on boolean, p_finding text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); a public.book_associations;
begin
  if p_book_id is null or p_book_id < 1 or p_author_id is null or p_author_id < 1 or not private.g1_title_ok(p_author_name, 200) or p_on is null
     or (p_finding is not null and not private.bk1_key_ok(p_finding)) then
    raise exception 'invalid_input: association' using errcode = '22023';
  end if;
  perform private.bk1_lock(v_owner);
  perform set_config('watchlist.library_write', 'on', true);
  if not p_on then
    delete from public.book_associations where user_id = v_owner and hardcover_book_id = p_book_id and hardcover_author_id = p_author_id returning * into a;
    perform private.bk1_close(v_owner, p_finding);
    return jsonb_build_object('hardcover_book_id', p_book_id, 'hardcover_author_id', p_author_id, 'removed', a.id is not null);
  end if;
  insert into public.book_associations (hardcover_book_id, hardcover_author_id, author_name) values (p_book_id, p_author_id, p_author_name)
  on conflict (user_id, hardcover_book_id, hardcover_author_id) do update set author_name = excluded.author_name returning * into a;
  perform private.bk1_close(v_owner, p_finding);
  return to_jsonb(a) - 'user_id';
end $$;

-- Sets or clears (p_value null) one standing decision. p_expected: its value as the page showed it, or null for none.
-- p_finding and p_outcome: a review item the decision settles ('done': it goes; 'later': it waits under Later).
create function public.library_book_decision_set(p_kind text, p_key text, p_expected jsonb, p_value jsonb, p_finding text, p_outcome text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); d public.book_decisions;
begin
  if p_kind is null or p_kind not in ('skip', 'exclude', 'keep_date', 'not_same', 'not_author') or not private.bk1_key_ok(p_key)
     or (p_value is not null and (jsonb_typeof(p_value) is distinct from 'object' or octet_length(p_value::text) > 4000))
     or (p_finding is not null and not private.bk1_key_ok(p_finding)) or (p_outcome is not null and p_outcome not in ('done', 'later'))
     or ((p_finding is null) <> (p_outcome is null)) then
    raise exception 'invalid_input: decision' using errcode = '22023';
  end if;
  perform private.bk1_lock(v_owner);
  select * into d from public.book_decisions where user_id = v_owner and kind = p_kind and key = p_key;
  if (d.id is null) <> (p_expected is null) or (d.id is not null and d.value is distinct from p_expected) then perform private.b45_changed(); end if;
  perform set_config('watchlist.library_write', 'on', true);
  if p_outcome = 'done' then perform private.bk1_close(v_owner, p_finding);
  elsif p_outcome = 'later' then update public.book_findings set status = 'later' where user_id = v_owner and fingerprint = p_finding;
  end if;
  if p_value is null then
    delete from public.book_decisions where id = d.id;
    return jsonb_build_object('kind', p_kind, 'key', p_key, 'removed', d.id is not null);
  end if;
  if d.id is null then
    insert into public.book_decisions (kind, key, value) values (p_kind, p_key, p_value) returning * into d;
  else
    update public.book_decisions set value = p_value, created_at = now() where id = d.id returning * into d;
  end if;
  return to_jsonb(d) - 'user_id';
end $$;

-- Records what Refresh books found: up to 200 rows {fingerprint, source, kind, subject, evidence, exclude_keys}. A new fingerprint
-- opens as pending; an open one keeps its status (pending or later) and takes the new subject and evidence. A row whose
-- exclude_keys match an exclude decision, or whose fingerprint a declined suggestion names, is not recorded (a removed or
-- dismissed title doesn't come back). p_close: open findings this refresh found settled (removed in the same transaction).
create function public.library_book_findings_record(p_rows jsonb, p_close text[]) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); r jsonb; v_added integer := 0; v_updated integer := 0; v_suppressed integer := 0; v_closed integer := 0; v_keys text[];
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 200
     or cardinality(coalesce(p_close, '{}')) > 200 or exists (select 1 from unnest(coalesce(p_close, '{}')) k where not private.bk1_key_ok(k))
     or (select count(*) from jsonb_array_elements(p_rows)) <> (select count(distinct x ->> 'fingerprint') from jsonb_array_elements(p_rows) x)
     or exists (select 1 from jsonb_array_elements(p_rows) x where jsonb_typeof(x) <> 'object'
       or exists (select 1 from jsonb_object_keys(x) k where k not in ('fingerprint', 'source', 'kind', 'subject', 'evidence', 'exclude_keys'))
       or jsonb_typeof(x -> 'fingerprint') is distinct from 'string' or not private.bk1_key_ok(x ->> 'fingerprint')
       or (x ->> 'source') is null or (x ->> 'source') not in ('hardcover', 'website')
       or (x ->> 'kind') is null or (x ->> 'kind') not in ('new_book', 'date', 'credit_gap', 'match', 'duplicate', 'site_changed')
       or jsonb_typeof(x -> 'subject') is distinct from 'object' or octet_length((x -> 'subject')::text) > 8000
       or jsonb_typeof(coalesce(x -> 'evidence', '[]')) <> 'array' or jsonb_array_length(coalesce(x -> 'evidence', '[]')) > 10 or octet_length(coalesce(x -> 'evidence', '[]')::text) > 4000
       or jsonb_typeof(coalesce(x -> 'exclude_keys', '[]')) <> 'array' or jsonb_array_length(coalesce(x -> 'exclude_keys', '[]')) > 20
       or exists (select 1 from jsonb_array_elements(coalesce(x -> 'exclude_keys', '[]')) k where jsonb_typeof(k) <> 'string' or not private.bk1_key_ok(k #>> '{}'))) then
    raise exception 'invalid_input: findings' using errcode = '22023';
  end if;
  perform private.bk1_lock(v_owner);
  perform set_config('watchlist.library_write', 'on', true);
  if cardinality(coalesce(p_close, '{}')) > 0 then
    delete from public.book_findings where user_id = v_owner and fingerprint = any(p_close);
    get diagnostics v_closed = row_count;
  end if;
  for r in select x from jsonb_array_elements(p_rows) x loop
    v_keys := array(select k #>> '{}' from jsonb_array_elements(coalesce(r -> 'exclude_keys', '[]')) k);
    if exists (select 1 from public.book_decisions d where d.user_id = v_owner
               and ((d.kind = 'exclude' and d.key = any(v_keys)) or (d.kind in ('keep_date', 'not_same', 'not_author') and d.key = r ->> 'fingerprint'))) then
      delete from public.book_findings where user_id = v_owner and fingerprint = r ->> 'fingerprint';
      v_suppressed := v_suppressed + 1;
      continue;
    end if;
    update public.book_findings set subject = r -> 'subject', evidence = coalesce(r -> 'evidence', '[]'), source = r ->> 'source', kind = r ->> 'kind', last_seen_at = now()
    where user_id = v_owner and fingerprint = r ->> 'fingerprint';
    if found then v_updated := v_updated + 1;
    else
      insert into public.book_findings (fingerprint, source, kind, subject, evidence)
      values (r ->> 'fingerprint', r ->> 'source', r ->> 'kind', r -> 'subject', coalesce(r -> 'evidence', '[]'));
      v_added := v_added + 1;
    end if;
  end loop;
  return jsonb_build_object('added', v_added, 'updated', v_updated, 'suppressed', v_suppressed, 'closed', v_closed);
end $$;

-- A review item without a standing decision: 'later' (waits under Later), 'pending' (back from Later) or 'done' (it goes; nothing
-- keeps it from coming back if a later refresh finds it again, which is what "Not now" means for a finding with no decision).
-- p_expected_status: as shown. An item already gone is reported, not refused.
create function public.library_book_finding_resolve(p_fingerprint text, p_expected_status text, p_outcome text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); f public.book_findings;
begin
  if not private.bk1_key_ok(p_fingerprint) or p_expected_status is null or p_outcome is null or p_outcome not in ('later', 'pending', 'done') then
    raise exception 'invalid_input: finding' using errcode = '22023';
  end if;
  perform private.bk1_lock(v_owner);
  select * into f from public.book_findings where user_id = v_owner and fingerprint = p_fingerprint;
  if f.id is null then return jsonb_build_object('fingerprint', p_fingerprint, 'gone', true); end if;
  if f.status is distinct from p_expected_status then perform private.b45_changed(); end if;
  perform set_config('watchlist.library_write', 'on', true);
  if p_outcome = 'done' then delete from public.book_findings where id = f.id;
  else update public.book_findings set status = p_outcome where id = f.id;
  end if;
  return jsonb_build_object('fingerprint', p_fingerprint, 'status', case when p_outcome = 'done' then null else p_outcome end);
end $$;

-- The cache: up to 200 rows [{kind, key, data}] per call, replacing what was cached for them.
create function public.library_book_cache_put(p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); v_n integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 200
     or exists (select 1 from jsonb_array_elements(p_rows) r where jsonb_typeof(r) <> 'object' or (r ->> 'kind') is null or (r ->> 'kind') not in ('book', 'author', 'series', 'site')
       or jsonb_typeof(r -> 'key') is distinct from 'string' or char_length(r ->> 'key') not between 1 and 100 or jsonb_typeof(r -> 'data') is distinct from 'object'
       or octet_length((r -> 'data')::text) > 60000)
     or (select count(*) from jsonb_array_elements(p_rows)) <> (select count(distinct (r ->> 'kind') || ':' || (r ->> 'key')) from jsonb_array_elements(p_rows) r) then
    raise exception 'invalid_input: cache' using errcode = '22023';
  end if;
  perform private.bk1_lock(v_owner);
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.book_cache (kind, key, data, fetched_at)
  select r ->> 'kind', r ->> 'key', r -> 'data', now() from jsonb_array_elements(p_rows) r
  on conflict (user_id, kind, key) do update set data = excluded.data, fetched_at = excluded.fetched_at;
  get diagnostics v_n = row_count;
  return jsonb_build_object('cached', v_n);
end $$;

-- Empties this member's book cache (the provider's and sites' data, not the member's; Refresh books fills it again).
create function public.library_book_cache_purge() returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); v_n integer;
begin
  perform private.bk1_lock(v_owner);
  perform set_config('watchlist.library_write', 'on', true);
  delete from public.book_cache where user_id = v_owner;
  get diagnostics v_n = row_count;
  return jsonb_build_object('removed', v_n);
end $$;

-- ── 6. The restore, format 10 ───────────────────────────────────────────────────
-- G1's flat function with the six book tables added. The book cache isn't part of a backup and isn't touched: it is provider and
-- site data, refilled by Refresh books. (The rest is G1's function unchanged.)
create or replace function public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean default false)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_version text := p_backup ->> 'formatVersion';
  v_tables jsonb := p_backup -> 'tables';
  v_counts jsonb := p_backup -> 'rowCounts';
  -- Every table of a format-10 backup, references first, with its columns.
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
    ['book_entries', 'id uuid, hardcover_id integer, title text, authors jsonb, series jsonb, status text, chosen_date jsonb, created_at timestamptz, updated_at timestamptz'],
    ['book_follows', 'id uuid, kind text, hardcover_id integer, name text, auto_add boolean, created_at timestamptz, updated_at timestamptz'],
    ['book_sites', 'id uuid, hardcover_author_id integer, author_name text, listing_url text, created_at timestamptz, updated_at timestamptz'],
    ['book_associations', 'id uuid, hardcover_book_id integer, hardcover_author_id integer, author_name text, created_at timestamptz'],
    ['book_decisions', 'id uuid, kind text, key text, value jsonb, created_at timestamptz'],
    ['book_findings', 'id uuid, fingerprint text, source text, kind text, status text, subject jsonb, evidence jsonb, first_seen_at timestamptz, last_seen_at timestamptz'],
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
  elsif v_version in ('5', '6', '7', '8', '9') then
    raise exception 'restore_invalid: format % backups are converted in the page first; nothing was changed', v_version using errcode = '22023';
  elsif v_version is distinct from '10' then
    raise exception 'restore_invalid: unsupported backup format %', coalesce(v_version, '(none)') using errcode = '22023';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_backup) k)
     <@ array['conversion', 'exportedAt', 'format', 'formatVersion', 'recovery', 'rowCounts', 'tables']::text[] is not true then
    raise exception 'restore_invalid: unexpected top-level fields' using errcode = '22023';
  end if;
  if jsonb_typeof(v_tables) is distinct from 'object' or jsonb_typeof(v_counts) is distinct from 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(v_tables) k)
        is distinct from (select array_agg(v_spec[n][1] order by v_spec[n][1] collate "C") from generate_subscripts(v_spec, 1) n) then
    raise exception 'restore_invalid: unexpected set of tables for format 10' using errcode = '22023';
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
    public.game_collections, public.game_collection_members, public.watch_queues, public.queue_entries, public.book_entries, public.book_follows,
    public.book_sites, public.book_associations, public.book_decisions, public.book_findings in exclusive mode;
  perform pg_advisory_xact_lock(hashtextextended('watchlist.queues ' || v_owner::text, 0)); -- (q1_lock's second step)
  perform private.g1_lock(v_owner);
  perform private.bk1_lock(v_owner);
  perform private.lib_write_on();
  -- Restoring saved data isn't a research operation (private.research_write_guard). Cleared below; a failure discards it with the transaction.
  perform set_config('watchlist.research_restore', 'on', true);

  delete from public.queue_entries where user_id = v_owner;
  delete from public.watch_queues where user_id = v_owner;
  delete from public.book_findings where user_id = v_owner;
  delete from public.book_decisions where user_id = v_owner;
  delete from public.book_associations where user_id = v_owner;
  delete from public.book_sites where user_id = v_owner;
  delete from public.book_follows where user_id = v_owner;
  delete from public.book_entries where user_id = v_owner;
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
  return jsonb_build_object('formatVersion', 10, 'restored', v_restored);
end $$;

-- ── 7. Grants ───────────────────────────────────────────────────────────────────
-- Explicit, then verified: default privileges owned by supabase_admin can't be relied on.
revoke all on public.book_entries, public.book_follows, public.book_sites, public.book_associations, public.book_decisions,
  public.book_findings, public.book_cache from public, anon, authenticated;
grant select, delete on public.book_entries, public.book_follows, public.book_sites, public.book_associations, public.book_decisions,
  public.book_findings, public.book_cache to authenticated;
-- (ids and timestamps: restore writes them; the guard still refuses any write outside a library function or restore)
grant insert (id, hardcover_id, title, authors, series, status, chosen_date, created_at, updated_at),
  update (hardcover_id, title, authors, series, status, chosen_date, updated_at) on public.book_entries to authenticated;
grant insert (id, kind, hardcover_id, name, auto_add, created_at, updated_at), update (auto_add, updated_at) on public.book_follows to authenticated;
grant insert (id, hardcover_author_id, author_name, listing_url, created_at, updated_at), update (author_name, listing_url, updated_at) on public.book_sites to authenticated;
grant insert (id, hardcover_book_id, hardcover_author_id, author_name, created_at), update (author_name) on public.book_associations to authenticated;
grant insert (id, kind, key, value, created_at), update (value, created_at) on public.book_decisions to authenticated;
grant insert (id, fingerprint, source, kind, status, subject, evidence, first_seen_at, last_seen_at),
  update (source, kind, status, subject, evidence, last_seen_at) on public.book_findings to authenticated;
grant insert (id, kind, key, data, fetched_at), update (data, fetched_at) on public.book_cache to authenticated;
revoke all on function private.bk1_people_ok(jsonb), private.bk1_series_ok(jsonb), private.bk1_date_ok(jsonb), private.bk1_url_ok(text), private.bk1_key_ok(text),
  private.bk1_keys_ok(text[]), private.bk1_status_ok(text), private.bk1_lock(uuid), private.bk1_entry_json(public.book_entries), private.bk1_entry(uuid, uuid),
  private.bk1_close(uuid, text) from public, anon;
grant execute on function private.bk1_people_ok(jsonb), private.bk1_series_ok(jsonb), private.bk1_date_ok(jsonb), private.bk1_url_ok(text), private.bk1_key_ok(text),
  private.bk1_keys_ok(text[]), private.bk1_status_ok(text), private.bk1_lock(uuid), private.bk1_entry_json(public.book_entries), private.bk1_entry(uuid, uuid),
  private.bk1_close(uuid, text) to authenticated;
revoke all on function public.library_book_add(jsonb, text, text[], text), public.library_book_set(uuid, text, text), public.library_book_edit(uuid, jsonb, jsonb, text),
  public.library_book_link(uuid, integer, integer, jsonb, text), public.library_book_delete(uuid, text, text[]), public.library_book_follow(text, integer, text, boolean),
  public.library_book_follow_set(uuid, boolean, boolean), public.library_book_unfollow(uuid), public.library_book_site_set(integer, text, text, text),
  public.library_book_association_set(integer, integer, text, boolean, text), public.library_book_decision_set(text, text, jsonb, jsonb, text, text),
  public.library_book_findings_record(jsonb, text[]), public.library_book_finding_resolve(text, text, text), public.library_book_cache_put(jsonb),
  public.library_book_cache_purge(), public.restore_backup(jsonb, boolean) from public, anon;
grant execute on function public.library_book_add(jsonb, text, text[], text), public.library_book_set(uuid, text, text), public.library_book_edit(uuid, jsonb, jsonb, text),
  public.library_book_link(uuid, integer, integer, jsonb, text), public.library_book_delete(uuid, text, text[]), public.library_book_follow(text, integer, text, boolean),
  public.library_book_follow_set(uuid, boolean, boolean), public.library_book_unfollow(uuid), public.library_book_site_set(integer, text, text, text),
  public.library_book_association_set(integer, integer, text, boolean, text), public.library_book_decision_set(text, text, jsonb, jsonb, text, text),
  public.library_book_findings_record(jsonb, text[]), public.library_book_finding_resolve(text, text, text), public.library_book_cache_put(jsonb),
  public.library_book_cache_purge(), public.restore_backup(jsonb, boolean) to authenticated;

-- ── 8. The capability and the run record ────────────────────────────────────────
create or replace function public.stage5_capabilities() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted-bk1', 'backup_format', 10, 'b45', 1, 'ep1', 1, 'cu1', 1, 'q1', 1, 'g1', 1, 'tc1', 1, 'bk1', 1,
    'access', 'members', 'member', private.is_member(), 'research', private.research_enabled(),
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;
revoke execute on function public.stage5_capabilities() from public, anon;
grant execute on function public.stage5_capabilities() to authenticated;
insert into private.migration_runs (run_id, migration) select run_id, 'bk1' from bk1_ctx;

-- ── 9. Verify before commit ─────────────────────────────────────────────────────
do $$
declare c record; t text; f text;
begin
  select * into c from bk1_ctx;
  if pg_temp.bk1_fp() is distinct from c.library_before then raise exception 'bk1: an existing library, games, queue or cache row changed'; end if;
  foreach t in array array['public.book_entries', 'public.book_follows', 'public.book_sites', 'public.book_associations', 'public.book_decisions',
    'public.book_findings', 'public.book_cache'] loop
    if not (select relrowsecurity from pg_class where oid = t::regclass)
       or (select count(*) from pg_policies where schemaname || '.' || tablename = t) <> 5
       or has_table_privilege('anon', t, 'select,insert,update,delete,truncate,references,trigger')
       or has_table_privilege('authenticated', t, 'insert,update,truncate,references,trigger') then
      raise exception 'bk1: % isn''t closed as designed', t;
    end if;
    if (select count(*) from pg_trigger where tgrelid = t::regclass and not tgisinternal and tgname like '%write_guard') <> 1 then raise exception 'bk1: % has no write guard', t; end if;
  end loop;
  foreach f in array array['public.library_book_add(jsonb, text, text[], text)', 'public.library_book_set(uuid, text, text)', 'public.library_book_edit(uuid, jsonb, jsonb, text)',
    'public.library_book_link(uuid, integer, integer, jsonb, text)', 'public.library_book_delete(uuid, text, text[])', 'public.library_book_follow(text, integer, text, boolean)',
    'public.library_book_follow_set(uuid, boolean, boolean)', 'public.library_book_unfollow(uuid)', 'public.library_book_site_set(integer, text, text, text)',
    'public.library_book_association_set(integer, integer, text, boolean, text)', 'public.library_book_decision_set(text, text, jsonb, jsonb, text, text)',
    'public.library_book_findings_record(jsonb, text[])', 'public.library_book_finding_resolve(text, text, text)', 'public.library_book_cache_put(jsonb)',
    'public.library_book_cache_purge()', 'public.restore_backup(jsonb, boolean)', 'public.stage5_capabilities()'] loop
    if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')
       or (select prosecdef from pg_proc where oid = f::regprocedure) then
      raise exception 'bk1: % isn''t executable as designed', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'private.bk1_lock(uuid)', 'execute') then raise exception 'bk1: a helper is executable by anon'; end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'restore_backup') <> 1 then raise exception 'bk1: more than one restore_backup'; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-bk1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '10' then
    raise exception 'bk1: the capability isn''t as designed: %', public.stage5_capabilities();
  end if;
end $$;

select 'BK1|' || json_build_object('run', (select run_id from bk1_ctx)) as result;

notify pgrst, 'reload schema';
commit;
