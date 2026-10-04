-- Phase 1b: user ownership, in one transaction.
--   * private schema (not exposed by the API) holding the bootstrap owner and the
--     migration stage, read only through two narrow functions;
--   * user_id on every owned table: NOT NULL from the moment it exists, with
--     every existing row stamped with the bootstrap owner by the column default;
--   * uniqueness rules rebuilt per owner;
--   * column-level write permissions so browser roles can never set user_id.
-- Run as postgres (SQL Editor). Follow with db/restore_backup.sql.
begin;

create temp table _before on commit drop as
select (select count(*) from public.watchlist_items) w, (select count(*) from public.othertv_shows) o,
       (select count(*) from public.custom_collections) c;

-- ── Private schema ───────────────────────────────────────────────────────────
create schema private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create table private.app_owner (
  singleton boolean primary key default true check (singleton),
  bootstrap_owner_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);
alter table private.app_owner enable row level security;
revoke all on private.app_owner from public, anon, authenticated;
insert into private.app_owner default values;

create table private.migration_stage (
  singleton boolean primary key default true check (singleton),
  stage text not null check (stage in ('ownership', 'tv_schema', 'shadow', 'authoritative', 'final')),
  changed_at timestamptz not null default now()
);
alter table private.migration_stage enable row level security;
revoke all on private.migration_stage from public, anon, authenticated;
insert into private.migration_stage (stage) values ('ownership');

-- The owner of the current request. Before sign-in exists: the bootstrap owner.
-- Replaced at the sign-in switch-over by a version that returns auth.uid() and
-- fails when nobody is signed in, with no fallback.
-- SECURITY DEFINER only so browser roles can read the one value from the closed table.
create function private.current_owner_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid;
begin
  select bootstrap_owner_id into v from private.app_owner where singleton;
  if v is null then raise exception 'owner_not_configured'; end if;
  return v;
end $$;
revoke all on function private.current_owner_id() from public;
grant execute on function private.current_owner_id() to anon, authenticated;

create function private.tv_stage() returns text
language sql stable security definer set search_path = '' as $$
  select stage from private.migration_stage where singleton
$$;
revoke all on function private.tv_stage() from public;
grant execute on function private.tv_stage() to anon, authenticated;

-- ── user_id ──────────────────────────────────────────────────────────────────
-- A non-volatile default is evaluated once and applied to every existing row by
-- this same statement, so no row is ever without an owner.
alter table public.watchlist_items    add column user_id uuid not null default private.current_owner_id();
alter table public.othertv_shows      add column user_id uuid not null default private.current_owner_id();
alter table public.custom_collections add column user_id uuid not null default private.current_owner_id();

-- ── Uniqueness per owner ─────────────────────────────────────────────────────
create unique index watchlist_items_movie_identity_key_v2 on public.watchlist_items
  using btree (user_id, collection, media_type, tmdb_id) where ((media_type = 'movie'::text) and (tmdb_id is not null));
drop index public.watchlist_items_movie_identity_key;
alter index public.watchlist_items_movie_identity_key_v2 rename to watchlist_items_movie_identity_key;

create unique index watchlist_items_tv_identity_key_v2 on public.watchlist_items
  using btree (user_id, collection, media_type, tmdb_id, season_number)
  where ((media_type = 'tv'::text) and (tmdb_id is not null) and (season_number is not null));
drop index public.watchlist_items_tv_identity_key;
alter index public.watchlist_items_tv_identity_key_v2 rename to watchlist_items_tv_identity_key;

create unique index watchlist_items_legacy_item_key_key_v2 on public.watchlist_items
  using btree (user_id, collection, item_key) where (tmdb_id is null);
drop index public.watchlist_items_legacy_item_key_key;
alter index public.watchlist_items_legacy_item_key_key_v2 rename to watchlist_items_legacy_item_key_key;

drop index public.watchlist_items_collection_idx;
create index watchlist_items_collection_idx on public.watchlist_items using btree (user_id, collection, date_sort);

alter table public.othertv_shows drop constraint othertv_shows_collection_tmdb_id_key,
  add constraint othertv_shows_user_collection_tmdb_id_key unique (user_id, collection, tmdb_id);
alter table public.custom_collections drop constraint custom_collections_name_key,
  add constraint custom_collections_user_name_key unique (user_id, name);

-- ── Column-level writes: every column except user_id ─────────────────────────
-- SELECT and DELETE stay table-level. A new column on these tables must be added
-- to these grants (as it must be added to RESTORE_COLUMNS).
revoke insert, update on public.watchlist_items, public.othertv_shows, public.custom_collections from anon, authenticated;
grant insert (id, collection, item_key, title, season, theme, display_date, date_sort, watched, status, created_at,
              watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number),
      update (id, collection, item_key, title, season, theme, display_date, date_sort, watched, status, created_at,
              watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number)
  on public.watchlist_items to anon, authenticated;
grant insert (id, tmdb_id, title, network, created_at, collection),
      update (id, tmdb_id, title, network, created_at, collection)
  on public.othertv_shows to anon, authenticated;
grant insert (id, name, tmdb_person_id, created_at, role),
      update (id, name, tmdb_person_id, created_at, role)
  on public.custom_collections to anon, authenticated;

-- ── Checks: abort the whole migration on any surprise ────────────────────────
do $$
declare b record; v_owner uuid := (select bootstrap_owner_id from private.app_owner);
begin
  select * into b from _before;
  if (select count(*) from public.watchlist_items) <> b.w or (select count(*) from public.othertv_shows) <> b.o
     or (select count(*) from public.custom_collections) <> b.c then
    raise exception 'phase1b: row counts changed';
  end if;
  if exists (select 1 from public.watchlist_items where user_id is distinct from v_owner)
     or exists (select 1 from public.othertv_shows where user_id is distinct from v_owner)
     or exists (select 1 from public.custom_collections where user_id is distinct from v_owner) then
    raise exception 'phase1b: a row is not owned by the bootstrap owner';
  end if;
  if (select count(*) from private.app_owner) <> 1 then raise exception 'phase1b: app_owner must have one row'; end if;
end $$;

commit;
