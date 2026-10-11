-- Stage 5c: contraction, in one transaction. Storage (collection) stops existing.
-- Order (each step depends on the one before):
--   1. take restore's lock set and re-check the readiness invariants;
--   2. write the recovery archive from the state at this moment: every item and
--      show id with its storage (so ids restored during coexistence and changed
--      storage are captured), every collection's legacy_source, and the complete
--      othertv_shows rows, with counts and hashes;
--   3. turn the governance views into tables (catalog_show_links,
--      catalog_film_links; origin migrated_from_storage), and backfill
--      personal_collections.catalog_id and watchlist_items.theme_kind;
--   4. replace the phase-dependent primitives with storage-free ones (the public
--      library_* functions don't change), rewrite delete_tv_season,
--      restore_backup (format 4), the date guard and the admin enrichment;
--      the old functions become refusing stubs (client_outdated);
--   5. install the privilege contract: column grants for everything the
--      SECURITY INVOKER functions write, and guard triggers that refuse those
--      writes unless the transaction sets watchlist.library_write (only the
--      library_* functions, restore and approved admin scripts set it);
--   6. drop the membership triggers (their duties are explicit in the functions;
--      an old page's direct film-Match PATCH is refused by the guards first);
--   7. drop the storage columns, legacy_source, the storage-scoped keys and
--      helpers, and othertv_shows (its rows are in the archive);
--   8. verify every preserved field, the archive and the governance before commit.
-- Run as postgres, at stage final, after Stage 5a, only with the separately
-- approved readiness checks done (including a rehearsed exact recovery of
-- othertv_shows from the archive). Rollback: db/rollback/phase5c.sql (refuses
-- unless the state is representable in Stage 5a; see that file).
begin;
set local lock_timeout = '5s';

do $$ begin
  if private.tv_stage() <> 'final' then raise exception 'phase5c: expected stage final, found %', private.tv_stage(); end if;
  if to_regprocedure('public.stage5_capabilities()') is null then raise exception 'phase5c: Stage 5a is not installed'; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'coexistence' then
    raise exception 'phase5c: already applied (phase %)', public.stage5_capabilities() ->> 'phase';
  end if;
end $$;

-- ── 1. Locks and readiness invariants ────────────────────────────────────────
lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
  public.watch_with_choices, public.othertv_shows, public.custom_collections in exclusive mode;

do $$
declare v jsonb;
begin
  select jsonb_strip_nulls(jsonb_build_object(
    'duplicate_show_identity', (select jsonb_agg(ids) from (select array_agg(id order by id) ids from public.tv_shows
      where tmdb_id is not null group by user_id, tmdb_id having count(*) > 1) x),
    'duplicate_film_identity', (select jsonb_agg(ids) from (select array_agg(id order by id) ids from public.watchlist_items
      where media_type = 'movie' and tmdb_id is not null group by user_id, tmdb_id having count(*) > 1) x),
    'duplicate_catalog_show_key', (select jsonb_agg(ids) from (select array_agg(id order by id) ids from public.tv_shows
      where collection in ('disney', '90day', 'sheridan') group by user_id, collection, show_key having count(*) > 1) x),
    'duplicate_catalog_film_key', (select jsonb_agg(ids) from (select array_agg(id order by id) ids from public.watchlist_items
      where is_film and collection in ('disney', '90day', 'sheridan') group by user_id, collection, item_key having count(*) > 1) x),
    'unclassified_rows', (select jsonb_agg(id order by id) from public.watchlist_items where not is_film and show_id is null),
    'season_storage_differs_from_show', (select jsonb_agg(w.id order by w.id) from public.watchlist_items w join public.tv_shows s on s.id = w.show_id
      where w.collection is distinct from s.collection),
    'unexpected_storage', (select jsonb_agg(distinct collection) from (select collection from public.watchlist_items union all
      select collection from public.tv_shows) x where collection not in ('disney', '90day', 'sheridan', 'othertv', 'truecrime', 'movies')),
    'unexpected_legacy_source', (select jsonb_agg(id) from public.personal_collections
      where legacy_source is not null and legacy_source not in ('disney', '90day', 'sheridan', 'truecrime'))
  )) into v;
  if v <> '{}'::jsonb then raise exception 'phase5c: readiness invariants do not hold; nothing was changed: %', v; end if;
end $$;

-- What must survive unchanged (everything but the storage values).
create temp table phase5c_before on commit drop as
select
  (select count(*) from public.watchlist_items) w_n,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'collection' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t) w,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'collection')::text, '|' order by t.id), '')) from public.tv_shows t) s,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t) m,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'legacy_source')::text, '|' order by t.id), '')) from public.personal_collections t) p,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watch_with_choices t) c,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.custom_collections t) cc,
  (select count(*) from public.library_catalog_shows) gs,
  (select count(*) from public.library_catalog_films) gf,
  (select md5(coalesce(string_agg(show_id::text || ':' || catalog || ':' || catalog_key, '|' order by show_id), '')) from public.library_catalog_shows) gsh,
  (select md5(coalesce(string_agg(item_id::text || ':' || catalog || ':' || entry_key, '|' order by item_id), '')) from public.library_catalog_films) gfh,
  (select md5(coalesce(string_agg(item_id::text || ':' || theme_kind, '|' order by item_id), '')) from public.library_film_theme_kinds) tk;

-- ── 2. Recovery archive (private; not reachable through the API) ──────────────
create table private.stage5_recovery_records (
  user_id uuid not null,
  kind text not null constraint stage5_recovery_records_kind_check check (kind in ('item', 'show')),
  id uuid not null,
  collection text not null,
  primary key (kind, id)
);
create table private.stage5_recovery_collections (
  user_id uuid not null,
  id uuid primary key,
  legacy_source text
);
create table private.stage5_recovery_othertv (like public.othertv_shows);
alter table private.stage5_recovery_othertv add primary key (id);
create table private.stage5_recovery_meta (
  user_id uuid primary key,
  captured_at timestamptz not null default now(),
  origin text not null constraint stage5_recovery_meta_origin_check check (origin in ('contraction', 'converted_restore')),
  counts jsonb not null,
  hashes jsonb not null
);

insert into private.stage5_recovery_records (user_id, kind, id, collection)
select user_id, 'item', id, collection from public.watchlist_items
union all select user_id, 'show', id, collection from public.tv_shows;
insert into private.stage5_recovery_collections (user_id, id, legacy_source)
select user_id, id, legacy_source from public.personal_collections;
insert into private.stage5_recovery_othertv select * from public.othertv_shows;
insert into private.stage5_recovery_meta (user_id, origin, counts, hashes)
select o.user_id, 'contraction',
  jsonb_build_object(
    'items', (select count(*) from private.stage5_recovery_records r where r.user_id = o.user_id and r.kind = 'item'),
    'shows', (select count(*) from private.stage5_recovery_records r where r.user_id = o.user_id and r.kind = 'show'),
    'collections', (select count(*) from private.stage5_recovery_collections r where r.user_id = o.user_id),
    'othertv_shows', (select count(*) from private.stage5_recovery_othertv r where r.user_id = o.user_id)),
  jsonb_build_object(
    'records', (select md5(coalesce(string_agg(r.kind || ':' || r.id || ':' || r.collection, '|' order by r.kind, r.id), ''))
                from private.stage5_recovery_records r where r.user_id = o.user_id),
    'collections', (select md5(coalesce(string_agg(r.id || ':' || coalesce(r.legacy_source, ''), '|' order by r.id), ''))
                    from private.stage5_recovery_collections r where r.user_id = o.user_id),
    'othertv_shows', (select md5(coalesce(string_agg((to_jsonb(r) - 'user_id')::text, '|' order by r.id), ''))
                      from private.stage5_recovery_othertv r where r.user_id = o.user_id))
from (select user_id from public.watchlist_items union select user_id from public.tv_shows
      union select user_id from public.personal_collections union select user_id from public.othertv_shows) o;

-- ── 3. Governance tables, catalog_id, theme_kind ─────────────────────────────
create table public.catalog_show_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id(),
  catalog text not null constraint catalog_show_links_catalog_check check (catalog in ('disney', '90day', 'sheridan')),
  catalog_key text not null constraint catalog_show_links_key_check check (catalog_key <> ''),
  show_id uuid not null,
  origin text not null constraint catalog_show_links_origin_check check (origin in ('migrated_from_storage', 'catalog_insert')),
  created_at timestamptz not null default now(),
  constraint catalog_show_links_show_fkey foreign key (show_id, user_id) references public.tv_shows (id, user_id) on delete cascade,
  constraint catalog_show_links_show_key unique (show_id),
  constraint catalog_show_links_entry_key unique (user_id, catalog, catalog_key)
);
create table public.catalog_film_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id(),
  catalog text not null constraint catalog_film_links_catalog_check check (catalog in ('disney', '90day', 'sheridan')),
  entry_key text not null constraint catalog_film_links_key_check check (entry_key <> ''),
  item_id uuid not null,
  item_is_film boolean not null generated always as (true) stored,
  origin text not null constraint catalog_film_links_origin_check check (origin in ('migrated_from_storage', 'catalog_insert')),
  created_at timestamptz not null default now(),
  constraint catalog_film_links_item_fkey foreign key (item_id, user_id, item_is_film)
    references public.watchlist_items (id, user_id, is_film) on delete cascade,
  constraint catalog_film_links_item_key unique (item_id),
  constraint catalog_film_links_entry_key unique (user_id, catalog, entry_key)
);
insert into public.catalog_show_links (user_id, catalog, catalog_key, show_id, origin)
select s.user_id, v.catalog, v.catalog_key, v.show_id, 'migrated_from_storage'
from public.library_catalog_shows v join public.tv_shows s on s.id = v.show_id;
insert into public.catalog_film_links (user_id, catalog, entry_key, item_id, origin)
select w.user_id, v.catalog, v.entry_key, v.item_id, 'migrated_from_storage'
from public.library_catalog_films v join public.watchlist_items w on w.id = v.item_id;

alter table public.personal_collections add column catalog_id text
  constraint personal_collections_catalog_check check (catalog_id in ('disney', '90day', 'sheridan'));
update public.personal_collections set catalog_id = legacy_source where legacy_source in ('disney', '90day', 'sheridan');
create unique index personal_collections_catalog_key on public.personal_collections using btree (user_id, catalog_id)
  where (catalog_id is not null);
-- How the page presents a collection it has always known (note, remembered layout key);
-- never used to place, govern or edit anything.
alter table public.personal_collections add column presentation_key text
  constraint personal_collections_presentation_check check (presentation_key in ('disney', '90day', 'sheridan', 'truecrime'));
update public.personal_collections set presentation_key = legacy_source where legacy_source in ('disney', '90day', 'sheridan', 'truecrime');
create unique index personal_collections_presentation_key on public.personal_collections using btree (user_id, presentation_key)
  where (presentation_key is not null);
alter table public.personal_collections add constraint personal_collections_presentation_catalog_check
  check (catalog_id is null or presentation_key = catalog_id);

alter table public.watchlist_items add column theme_kind text;
update public.watchlist_items set theme_kind = case when collection = 'movies' then 'genre' else 'other' end where is_film;
-- Every film has a classification and no season has one (a NULL kind fails for a film:
-- coalesce, since a CHECK only rejects false). Every row is a film or a linked season.
alter table public.watchlist_items add constraint watchlist_items_theme_kind_check
  check (case when coalesce(media_type = 'movie', false) or (media_type is null and season = 'Film')
              then coalesce(theme_kind in ('genre', 'other'), false) else theme_kind is null end);
alter table public.watchlist_items add constraint watchlist_items_classified_check
  check (coalesce(media_type = 'movie', false) or (media_type is null and season = 'Film') or show_id is not null);

-- The read views, same names and columns, now over the tables.
create or replace view public.library_catalog_shows with (security_invoker = true) as
  select l.show_id as id, l.show_id, l.catalog, l.catalog_key, l.origin from public.catalog_show_links l;
create or replace view public.library_catalog_films with (security_invoker = true) as
  select l.item_id as id, l.item_id, l.catalog, l.entry_key, l.origin from public.catalog_film_links l;
create or replace view public.library_film_theme_kinds with (security_invoker = true) as
  select w.id, w.id as item_id, w.theme_kind from public.watchlist_items w where w.is_film;
create or replace view public.library_collection_catalogs with (security_invoker = true) as
  select c.id, c.id as collection_id, c.catalog_id as catalog from public.personal_collections c where c.catalog_id is not null;
create or replace view public.library_collection_presentation with (security_invoker = true) as
  select c.id, c.id as collection_id, c.presentation_key from public.personal_collections c where c.presentation_key is not null;

-- ── 4. Storage-free functions ────────────────────────────────────────────────
-- Show keys: the reviewed override is keyed by catalog (the same value as before).
drop function private.tv_show_key(text, text);
drop function private.tv_show_key_override(text, text);
create function private.tv_show_key_override(p_catalog text, p_prefix text) returns text
language sql immutable set search_path = '' as $$
  select v.show_key
  from (values ('disney', 'the clone wars', 'star wars: the clone wars (2008)')) as v(catalog, prefix, show_key)
  where v.catalog = p_catalog and v.prefix = p_prefix
$$;
create function private.tv_show_key(p_catalog text, p_item_key text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(private.tv_show_key_override(p_catalog, split_part(coalesce(p_item_key, ''), '|', 1)),
                  split_part(coalesce(p_item_key, ''), '|', 1))
$$;

create or replace function private.lib_show_catalog(p_show_id uuid) returns text
language sql stable set search_path = '' as $$
  select l.catalog from public.catalog_show_links l where l.show_id = p_show_id
$$;
create or replace function private.lib_film_catalog(p_item_id uuid) returns text
language sql stable set search_path = '' as $$
  select l.catalog from public.catalog_film_links l where l.item_id = p_item_id
$$;
create or replace function private.lib_film_theme_kind(p_item_id uuid) returns text
language sql stable set search_path = '' as $$
  select w.theme_kind from public.watchlist_items w where w.id = p_item_id
$$;
create or replace function private.lib_set_theme_kind(p_item_id uuid, p_kind text) returns void
language plpgsql set search_path = '' as $$
begin
  update public.watchlist_items set theme_kind = p_kind where id = p_item_id and theme_kind is distinct from p_kind;
end $$;
create or replace function private.lib_film_match_update(p_row_id uuid, p_patch jsonb, p_tmdb integer, p_coll_id integer, p_kind text)
returns public.watchlist_items
language plpgsql set search_path = '' as $$
declare r public.watchlist_items;
begin
  if p_kind is null or p_kind not in ('genre', 'other') then
    raise exception 'integrity_fault: theme kind %', p_kind using errcode = '23000';
  end if;
  update public.watchlist_items set
    title = btrim(p_patch ->> 'title'), season = 'Film', item_key = p_patch ->> 'item_key',
    theme = coalesce(p_patch ->> 'theme', theme), display_date = coalesce(p_patch ->> 'display_date', display_date),
    date_sort = p_patch ->> 'date_sort', tmdb_collection_id = p_coll_id, tmdb_collection_name = p_patch ->> 'tmdb_collection_name',
    collections = case when p_patch ? 'collections' then coalesce(array(select jsonb_array_elements_text(p_patch -> 'collections')), '{}') else collections end,
    media_type = 'movie', tmdb_id = p_tmdb, season_number = null, show_id = null, theme_kind = p_kind
  where id = p_row_id
  returning * into r;
  return r;
end $$;
create or replace function private.lib_catalog_target(p_owner uuid, p_catalog text) returns public.personal_collections
language sql stable set search_path = '' as $$
  select * from public.personal_collections where user_id = p_owner and catalog_id = p_catalog
$$;
-- (Governance links are written only by functions that hold these locks, so the
-- link tables need no lock of their own.)
create or replace function private.lib_catalog_lock() returns void
language plpgsql set search_path = '' as $$
begin
  lock table public.tv_shows, public.watchlist_items in exclusive mode;
  lock table public.personal_collections in share mode;
end $$;
create or replace function private.lib_new_show_row(p_owner uuid, p_title text, p_key text, p_tmdb integer, p_status text) returns uuid
language plpgsql set search_path = '' as $$
declare v uuid;
begin
  insert into public.tv_shows (title, show_key, tmdb_id, status)
  values (p_title, p_key, p_tmdb, p_status)
  on conflict do nothing
  returning id into v;
  return v;
end $$;
create or replace function private.lib_insert_film(p_owner uuid, f jsonb, p_kind text) returns uuid
language plpgsql set search_path = '' as $$
declare v uuid;
begin
  if p_kind is null or p_kind not in ('genre', 'other') then
    raise exception 'integrity_fault: theme kind %', p_kind using errcode = '23000';
  end if;
  insert into public.watchlist_items (item_key, title, season, theme, theme_kind, display_date, date_sort, watched, status,
    watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number)
  values (f ->> 'item_key', btrim(f ->> 'title'), 'Film', coalesce(f ->> 'theme', ''), p_kind, coalesce(f ->> 'display_date', ''),
    f ->> 'date_sort', coalesce((f ->> 'watched')::boolean, false), coalesce(f ->> 'status', 'confirmed'),
    coalesce(array(select jsonb_array_elements_text(f -> 'watch_with')), '{}'),
    coalesce(array(select jsonb_array_elements_text(f -> 'collections')), '{}'),
    (f ->> 'tmdb_collection_id')::integer, f ->> 'tmdb_collection_name',
    case when f ->> 'tmdb_id' is not null then 'movie' end, (f ->> 'tmdb_id')::integer, null)
  on conflict do nothing
  returning id into v;
  return v;
end $$;

-- Seasons of a governed, TMDB-matched show added by label: a season already on
-- the show with its identity is a no-op (whatever its label); a new plain
-- "Season N" becomes TMDB season N; any other label, or a key / identity another
-- row holds, is held for review. Never creates a show.
create or replace function private.tv_add_to_enriched_show(p_show_id uuid, p_seasons jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  p_show public.tv_shows;
  s jsonb;
  v_num integer;
  v_row public.watchlist_items;
  v_conflict uuid;
  r public.watchlist_items;
  v_inserted uuid[] := '{}';
  v_existing jsonb := '[]';
  v_rejected jsonb := '[]';
begin
  select * into p_show from public.tv_shows where id = p_show_id;
  for s in select * from jsonb_array_elements(p_seasons) loop
    v_num := private.tv_plain_season_number(s ->> 'season');
    select * into v_row from public.watchlist_items
    where show_id = p_show.id and item_key = s ->> 'item_key'
    order by id limit 1;
    if found and v_row.media_type = 'tv' and v_row.tmdb_id = p_show.tmdb_id and v_row.season_number is not null
       and (case when v_num is null then v_row.season = s ->> 'season' else v_row.season_number = v_num end) then
      v_existing := v_existing || jsonb_build_object('season_number', v_row.season_number, 'item_key', v_row.item_key, 'id', v_row.id);
      continue;
    end if;
    if v_num is null then
      v_rejected := v_rejected || jsonb_build_object('item_key', s ->> 'item_key', 'season', s ->> 'season',
        'reason', 'enriched_show_label', 'show_id', p_show.id);
      continue;
    end if;
    if found then
      v_rejected := v_rejected || jsonb_build_object('item_key', s ->> 'item_key', 'season', s ->> 'season',
        'reason', 'identity_conflict', 'conflicting_row_id', v_row.id);
      continue;
    end if;
    select id into v_conflict from public.watchlist_items
    where user_id = p_show.user_id and media_type = 'tv' and tmdb_id = p_show.tmdb_id and season_number = v_num;
    if found then
      v_rejected := v_rejected || jsonb_build_object('item_key', s ->> 'item_key', 'season', s ->> 'season',
        'reason', 'identity_conflict', 'conflicting_row_id', v_conflict);
      continue;
    end if;
    r := null;
    insert into public.watchlist_items (item_key, title, season, theme, display_date, date_sort, watched,
      status, media_type, tmdb_id, season_number, show_id)
    values (s ->> 'item_key', s ->> 'title', s ->> 'season', coalesce(s ->> 'theme', ''),
      coalesce(s ->> 'display_date', ''), s ->> 'date_sort', false, coalesce(s ->> 'status', 'confirmed'),
      'tv', p_show.tmdb_id, v_num, p_show.id)
    on conflict do nothing
    returning * into r;
    if r.id is not null then v_inserted := v_inserted || r.id;
    else v_rejected := v_rejected || jsonb_build_object('item_key', s ->> 'item_key', 'season', s ->> 'season', 'reason', 'identity_conflict');
    end if;
  end loop;
  return jsonb_build_object('inserted', to_jsonb(v_inserted), 'existing', v_existing, 'rejected', v_rejected);
end $$;

-- Seasons for one locked show (the add_tv_seasons rules, scoped to the show):
-- identified shows that no catalog governs take TMDB seasons; the others take
-- seasons by label, a governed TMDB-matched show through the enriched-show rule.
-- A genuinely new season reopens a Complete show. Returns
-- {show_id, show_created: false, inserted[], existing[], rejected[], reopened, show_status}.
create or replace function private.lib_add_to_show(p_show public.tv_shows, p_network text, p_seasons jsonb, p_by_number boolean) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_owner uuid := p_show.user_id;
  v_key text := p_show.show_key;
  v_tmdb integer := case when p_by_number then p_show.tmdb_id end;
  v_catalog text := private.lib_show_catalog(p_show.id);
  s jsonb;
  v_num integer;
  v_label text;
  v_ident text;
  v_seen text[] := '{}';
  r public.watchlist_items;
  v_conflict uuid;
  v_inserted uuid[] := '{}';
  v_existing jsonb := '[]';
  v_rejected jsonb := '[]';
  v_reopened boolean := false;
  v_enriched jsonb;
begin
  -- Validate everything before writing anything.
  for s in select * from jsonb_array_elements(p_seasons) loop
    if jsonb_typeof(s) is distinct from 'object' or coalesce(s ->> 'item_key', '') = '' or coalesce(btrim(s ->> 'title'), '') = ''
       or coalesce(btrim(s ->> 'season'), '') = '' or not private.tv_valid_date(s ->> 'date_sort') then
      raise exception 'invalid_input: season %', s using errcode = '22023';
    end if;
    if v_tmdb is not null then
      begin v_num := (s ->> 'season_number')::integer;
      exception when others then raise exception 'invalid_input: season_number in %', s using errcode = '22023'; end;
      v_label := case when v_num = 0 then 'Specials' else 'Season ' || v_num end;
      if v_num is null or v_num < 0 or s ->> 'season' <> v_label or s ->> 'item_key' <> v_key || '|' || lower(v_label) then
        raise exception 'invalid_input: season % does not match its number and show', s using errcode = '22023';
      end if;
      v_ident := v_num::text;
    else
      if s ? 'season_number' and s -> 'season_number' <> 'null'::jsonb then
        raise exception 'invalid_input: a legacy season has no season_number' using errcode = '22023';
      end if;
      if s ->> 'season' = 'Film' or private.tv_show_key(coalesce(v_catalog, ''), s ->> 'item_key') <> v_key then
        raise exception 'invalid_input: season % does not belong to show %', s ->> 'item_key', v_key using errcode = '22023';
      end if;
      v_ident := s ->> 'item_key';
    end if;
    if v_ident = any(v_seen) then raise exception 'invalid_input: season % requested twice', v_ident using errcode = '22023'; end if;
    v_seen := v_seen || v_ident;
  end loop;

  -- A season by label for a governed TMDB-matched show joins it as an identified season.
  if v_tmdb is null and p_show.tmdb_id is not null then
    v_enriched := private.tv_add_to_enriched_show(p_show.id,
      (select jsonb_agg(x - 'season_number') from jsonb_array_elements(p_seasons) x));
    v_inserted := array(select jsonb_array_elements_text(v_enriched -> 'inserted')::uuid);
    if cardinality(v_inserted) > 0 and p_show.status = 'complete' then
      update public.tv_shows set status = 'confirmed' where id = p_show.id;
      v_reopened := true;
    end if;
    return jsonb_build_object(
      'show_id', p_show.id, 'show_created', false,
      'inserted', coalesce((select jsonb_agg(to_jsonb(w) - 'is_film' order by w.season_number, w.item_key)
                            from public.watchlist_items w where w.id = any(v_inserted)), '[]'),
      'existing', v_enriched -> 'existing', 'rejected', v_enriched -> 'rejected', 'reopened', v_reopened,
      'show_status', (select status from public.tv_shows where id = p_show.id));
  end if;

  for s in select * from jsonb_array_elements(p_seasons) loop
    v_num := (s ->> 'season_number')::integer;
    if v_tmdb is not null then
      select * into r from public.watchlist_items
      where user_id = v_owner and media_type = 'tv' and tmdb_id = v_tmdb and season_number = v_num;
    else
      select * into r from public.watchlist_items
      where show_id = p_show.id and tmdb_id is null and item_key = s ->> 'item_key';
    end if;
    if found then
      if r.show_id is distinct from p_show.id then
        raise exception 'integrity_fault: season % is linked to a different show', r.id using errcode = '23000';
      end if;
      v_existing := v_existing || jsonb_build_object('season_number', v_num, 'item_key', r.item_key, 'id', r.id);
      continue;
    end if;

    -- A season of this show with the same key but the other kind of identity: report, don't guess.
    select id into v_conflict from public.watchlist_items
    where show_id = p_show.id and item_key = s ->> 'item_key'
      and (case when v_tmdb is not null then tmdb_id is null else tmdb_id is not null end)
    limit 1;
    if found then
      v_rejected := v_rejected || jsonb_build_object('season_number', v_num, 'item_key', s ->> 'item_key',
        'reason', case when v_tmdb is not null then 'legacy_row_same_key' else 'identified_row_same_key' end,
        'conflicting_row_id', v_conflict);
      continue;
    end if;

    r := null;
    if v_tmdb is not null then
      insert into public.watchlist_items (item_key, title, season, theme, display_date, date_sort, watched,
        status, media_type, tmdb_id, season_number, show_id)
      values (s ->> 'item_key', s ->> 'title', s ->> 'season', coalesce(s ->> 'theme', ''),
        coalesce(s ->> 'display_date', ''), s ->> 'date_sort', false, 'confirmed', 'tv', v_tmdb, v_num, p_show.id)
      on conflict do nothing
      returning * into r;
    else
      insert into public.watchlist_items (item_key, title, season, theme, display_date, date_sort, watched, status, show_id)
      values (s ->> 'item_key', s ->> 'title', s ->> 'season', coalesce(s ->> 'theme', ''),
        coalesce(s ->> 'display_date', ''), s ->> 'date_sort', false, 'confirmed', p_show.id)
      on conflict do nothing
      returning * into r;
    end if;
    if r.id is not null then
      v_inserted := v_inserted || r.id;
    else
      -- Added by a concurrent call between the check and the insert.
      select id into v_conflict from public.watchlist_items
      where (case when v_tmdb is not null then user_id = v_owner and media_type = 'tv' and tmdb_id = v_tmdb and season_number = v_num
                  else show_id = p_show.id and item_key = s ->> 'item_key' end);
      v_existing := v_existing || jsonb_build_object('season_number', v_num, 'item_key', s ->> 'item_key', 'id', v_conflict);
    end if;
  end loop;

  if cardinality(v_inserted) > 0 and p_show.status = 'complete' then
    update public.tv_shows set status = 'confirmed' where id = p_show.id;
    v_reopened := true;
  end if;
  return jsonb_build_object(
    'show_id', p_show.id, 'show_created', false,
    'inserted', coalesce((select jsonb_agg(to_jsonb(w) - 'is_film' order by w.season_number, w.item_key)
                          from public.watchlist_items w where w.id = any(v_inserted)), '[]'),
    'existing', v_existing, 'rejected', v_rejected, 'reopened', v_reopened,
    'show_status', (select status from public.tv_shows where id = p_show.id));
end $$;

-- Missing catalog entries for one catalog (the Stage 4a insertion rules, on what
-- the catalog governs): a governed TMDB-matched show takes its seasons through the
-- enriched-show rule; a governed unmatched show gets the missing seasons; a new
-- show or film is created with its governance link (origin catalog_insert).
-- Returns {inserted[], created_shows[], reopened[], conflicts[], identified[]}.
create function private.lib_catalog_insert_v5(p_owner uuid, p_catalog text, p_defaults jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  d jsonb;
  g record;
  v_show public.tv_shows;
  v_show_id uuid;
  r public.watchlist_items;
  v_inserted uuid[] := '{}';
  v_created_shows uuid[] := '{}';
  v_reopened uuid[] := '{}';
  v_conflicts jsonb := '[]';
  v_identified jsonb := '[]';
  v_n int;
  v_enriched jsonb;
  v_created boolean;
begin
  for g in
    with defs as (
      select e.value as def, e.ordinality as ord, private.tv_show_key(p_catalog, e.value ->> 'k') as show_key
      from jsonb_array_elements(p_defaults) with ordinality e
      where e.value ->> 's' <> 'Film'
    )
    select defs.show_key,
           coalesce((select x.def ->> 't' from defs x where x.show_key = defs.show_key and split_part(x.def ->> 'k', '|', 1) = defs.show_key order by x.ord limit 1),
                    (select x.def ->> 't' from defs x where x.show_key = defs.show_key order by x.ord limit 1)) as title,
           bool_and(coalesce((defs.def ->> 'p')::boolean, false)) as all_pending,
           jsonb_agg(defs.def order by defs.ord) filter (where not exists (
             select 1 from public.watchlist_items w join public.catalog_show_links l on l.show_id = w.show_id
             where l.user_id = p_owner and l.catalog = p_catalog and w.tmdb_id is null and w.item_key = defs.def ->> 'k')) as missing
    from defs group by defs.show_key
  loop
    v_show := null;
    select s.* into v_show from public.tv_shows s join public.catalog_show_links l on l.show_id = s.id
    where l.user_id = p_owner and l.catalog = p_catalog and l.catalog_key = g.show_key
    for update of s;
    if v_show.id is not null and v_show.tmdb_id is not null then
      v_enriched := private.tv_add_to_enriched_show(v_show.id, (
        select coalesce(jsonb_agg(jsonb_build_object('item_key', x.def ->> 'k', 'title', x.def ->> 't', 'season', x.def ->> 's',
          'theme', x.def ->> 'th', 'display_date', x.def ->> 'd', 'date_sort', x.def ->> 'ds',
          'status', case when coalesce((x.def ->> 'p')::boolean, false) then 'pending' else 'confirmed' end)), '[]')
        from jsonb_array_elements(p_defaults) as x(def)
        where x.def ->> 's' <> 'Film' and private.tv_show_key(p_catalog, x.def ->> 'k') = g.show_key));
      v_n := jsonb_array_length(v_enriched -> 'inserted');
      v_inserted := v_inserted || array(select jsonb_array_elements_text(v_enriched -> 'inserted')::uuid);
      v_conflicts := v_conflicts || (v_enriched -> 'rejected');
      v_identified := v_identified || (v_enriched -> 'existing');
      if v_n > 0 and v_show.status = 'complete' then
        update public.tv_shows set status = 'confirmed' where id = v_show.id;
        v_reopened := v_reopened || v_show.id;
      end if;
      continue;
    end if;
    if g.missing is null then
      v_conflicts := v_conflicts || coalesce((
        select jsonb_agg(jsonb_build_object('item_key', w.item_key, 'reason', 'linked_to_other_show', 'row_id', w.id))
        from public.watchlist_items w join public.catalog_show_links l on l.show_id = w.show_id
        join public.tv_shows s on s.id = w.show_id
        where l.user_id = p_owner and l.catalog = p_catalog and w.tmdb_id is null
          and private.tv_show_key(p_catalog, w.item_key) = g.show_key and s.show_key <> g.show_key), '[]');
      continue;
    end if;
    v_created := false;
    if v_show.id is null then
      insert into public.tv_shows (title, show_key, tmdb_id, status)
      values (g.title, g.show_key, null, case when g.all_pending then 'pending' else 'confirmed' end)
      returning * into v_show;
      insert into public.catalog_show_links (catalog, catalog_key, show_id, origin)
      values (p_catalog, g.show_key, v_show.id, 'catalog_insert');
      v_created_shows := v_created_shows || v_show.id;
      v_created := true;
    end if;
    v_n := 0;
    for d in select * from jsonb_array_elements(g.missing) loop
      r := null;
      insert into public.watchlist_items (item_key, title, season, theme, display_date, date_sort, watched, status, show_id)
      values (d ->> 'k', d ->> 't', d ->> 's', coalesce(d ->> 'th', ''), coalesce(d ->> 'd', ''), d ->> 'ds', false,
              case when coalesce((d ->> 'p')::boolean, false) then 'pending' else 'confirmed' end, v_show.id)
      on conflict do nothing
      returning * into r;
      if r.id is not null then v_inserted := v_inserted || r.id; v_n := v_n + 1; end if;
    end loop;
    if v_n > 0 and not v_created and v_show.status = 'complete' then
      update public.tv_shows set status = 'confirmed' where id = v_show.id;
      v_reopened := v_reopened || v_show.id;
    end if;
  end loop;

  for d in select * from jsonb_array_elements(p_defaults) loop
    if d ->> 's' <> 'Film' then continue; end if;
    if exists (select 1 from public.catalog_film_links l where l.user_id = p_owner and l.catalog = p_catalog and l.entry_key = d ->> 'k') then
      continue;
    end if;
    r := null;
    insert into public.watchlist_items (item_key, title, season, theme, theme_kind, display_date, date_sort, watched, status)
    values (d ->> 'k', d ->> 't', d ->> 's', coalesce(d ->> 'th', ''), 'other', coalesce(d ->> 'd', ''), d ->> 'ds', false,
            case when coalesce((d ->> 'p')::boolean, false) then 'pending' else 'confirmed' end)
    returning * into r;
    insert into public.catalog_film_links (catalog, entry_key, item_id, origin)
    values (p_catalog, d ->> 'k', r.id, 'catalog_insert');
    v_inserted := v_inserted || r.id;
  end loop;

  return jsonb_build_object('inserted', to_jsonb(v_inserted), 'created_shows', to_jsonb(v_created_shows),
    'reopened', to_jsonb(v_reopened), 'conflicts', v_conflicts, 'identified', v_identified);
end $$;
create or replace function private.lib_catalog_insert(p_owner uuid, p_catalog text, p_defaults jsonb) returns jsonb
language sql set search_path = '' as $$ select private.lib_catalog_insert_v5(p_owner, p_catalog, p_defaults) $$;

-- A TV-season Match after library_match_season's checks (the match_tv_row rules:
-- conflicts, the status block, collection-expansion confirmation, memberships
-- moving with the row), across the whole library. A target show that a catalog
-- governs is refused again under its lock.
create or replace function private.lib_match_season_core(p_row public.watchlist_items, p_target jsonb, p_patch jsonb, p_expansion jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_owner uuid := p_row.user_id;
  r public.watchlist_items;
  v_tmdb integer;
  v_num integer;
  v_label text;
  v_key text;
  v_l public.tv_shows;
  v_t public.tv_shows;
  v_conflict uuid;
  v_target_show uuid;
  v_visible uuid[];
  v_extra uuid[];
  v_token text;
  v_created boolean := false;
  v_src_ids uuid[];
  v_tgt_ids uuid[];
  v_gone uuid[];
begin
  perform set_config('lock_timeout', '5s', true);
  if p_expansion is not null and (jsonb_typeof(p_expansion) <> 'object'
     or (p_expansion ? 'confirm' and jsonb_typeof(p_expansion -> 'confirm') not in ('string', 'null'))) then
    raise exception 'invalid_input: p_expansion %', p_expansion using errcode = '22023';
  end if;
  begin
    v_tmdb := (p_target ->> 'tmdb_id')::integer;
    v_num := (p_patch ->> 'season_number')::integer;
  exception when others then raise exception 'invalid_input: tmdb_id / season_number' using errcode = '22023'; end;
  v_label := case when v_num = 0 then 'Specials' else 'Season ' || v_num end;
  v_key := lower(btrim(coalesce(p_patch ->> 'title', '')));
  if v_tmdb is null or v_num is null or v_num < 0 or v_key = ''
     or p_patch ->> 'media_type' is distinct from 'tv' or (p_patch ->> 'tmdb_id')::integer is distinct from v_tmdb
     or p_patch ->> 'season' is distinct from v_label or p_patch ->> 'item_key' is distinct from v_key || '|' || lower(v_label)
     or not private.tv_valid_date(p_patch ->> 'date_sort') then
    raise exception 'invalid_input: match patch %', p_patch using errcode = '22023';
  end if;

  select * into r from public.watchlist_items
  where id = p_row.id and user_id = v_owner and tmdb_id is null and media_type is null and season_number is null;
  if r.id is null then raise exception 'not_found: unidentified row' using errcode = 'P0002'; end if;

  select id into v_conflict from public.watchlist_items
  where user_id = v_owner and media_type = 'tv' and tmdb_id = v_tmdb and season_number = v_num;
  if found then raise exception 'match_conflict: identity already on the list as row %', v_conflict using errcode = '23505'; end if;

  if r.show_id is not null then
    select * into v_l from public.tv_shows where id = r.show_id and user_id = v_owner for update;
  end if;
  select * into v_t from public.tv_shows where user_id = v_owner and tmdb_id = v_tmdb for update;
  if v_t.id is not null and private.lib_show_catalog(v_t.id) is not null then
    perform private.lib_refuse('match_target_governed', 'This TMDB show is part of a built-in catalog on your list, so this row wasn''t matched to it. Nothing was changed.');
  end if;
  select id into v_conflict from public.watchlist_items
  where show_id = coalesce(v_t.id, v_l.id) and item_key = p_patch ->> 'item_key' and id <> r.id;
  if found then raise exception 'match_conflict: item_key already used by row %', v_conflict using errcode = '23505'; end if;
  select * into r from public.watchlist_items
  where id = r.id and tmdb_id is null and media_type is null and season_number is null for update;
  if r.id is null then raise exception 'match_conflict: the row changed; try again' using errcode = '40001'; end if;

  if r.is_film then
    select coalesce(array_agg(collection_id order by collection_id), '{}'), coalesce(array_agg(id order by id), '{}')
      into v_visible, v_src_ids from public.collection_memberships where item_id = r.id;
  elsif v_l.id is not null then
    select coalesce(array_agg(collection_id order by collection_id), '{}'), coalesce(array_agg(id order by id), '{}')
      into v_visible, v_src_ids from public.collection_memberships where show_id = v_l.id;
  else
    v_visible := '{}';
    v_src_ids := '{}';
  end if;
  select coalesce(array_agg(id order by id), '{}') into v_tgt_ids from public.collection_memberships where show_id = v_t.id;

  if v_t.id is not null then
    if v_l.id is not null and v_t.status <> v_l.status then
      return jsonb_build_object('blocked', true, 'legacy_status', v_l.status, 'target_status', v_t.status,
                                'legacy_show_id', v_l.id, 'target_show_id', v_t.id);
    end if;
    v_target_show := v_t.id;
    select coalesce(array_agg(c order by c), '{}') into v_extra from unnest(v_visible) c
    where not exists (select 1 from public.collection_memberships m where m.show_id = v_t.id and m.collection_id = c);
    if cardinality(v_extra) > 0 then
      v_token := md5(v_t.id::text || '|' || array_to_string(v_extra, ',') || '|' ||
        coalesce((select string_agg(w.id::text, ',' order by w.id) from public.watchlist_items w where w.show_id = v_t.id), ''));
      if p_expansion is null then
        raise exception 'match_needs_confirmation: matching this row would also show all % stored seasons of "%" in %. This page can''t confirm that; reload it and match again. Nothing was changed.',
          (select count(*) from public.watchlist_items w where w.show_id = v_t.id), v_t.title,
          (select string_agg(c.name, ', ' order by c.sort_order, c.name) from public.personal_collections c where c.id = any(v_extra))
          using errcode = 'P0001';
      end if;
      if (p_expansion ->> 'confirm') is distinct from v_token then
        return jsonb_build_object('blocked', true, 'reason', 'membership_expansion', 'target_show_id', v_t.id,
          'show_title', v_t.title, 'seasons', (select count(*) from public.watchlist_items w where w.show_id = v_t.id),
          'collections', (select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.sort_order, c.name)
                          from public.personal_collections c where c.id = any(v_extra)),
          'confirmation', v_token, 'changed', (p_expansion ->> 'confirm') is not null);
      end if;
    end if;
  elsif v_l.id is not null and not exists (select 1 from public.watchlist_items where show_id = v_l.id and id <> r.id) then
    update public.tv_shows set tmdb_id = v_tmdb, title = btrim(p_patch ->> 'title'), show_key = v_key where id = v_l.id;
    v_target_show := v_l.id;
  else
    insert into public.tv_shows (title, show_key, tmdb_id, status)
    values (btrim(p_patch ->> 'title'), v_key, v_tmdb, coalesce(v_l.status, 'confirmed'))
    returning id into v_target_show;
    v_created := true;
  end if;

  if v_target_show is distinct from v_l.id then
    insert into public.collection_memberships (collection_id, show_id)
    select c, v_target_show from unnest(v_visible) c
    on conflict (collection_id, show_id) where (show_id is not null) do nothing;
  end if;
  if r.is_film then
    with d as (delete from public.collection_memberships where item_id = r.id returning id)
    select coalesce(array_agg(id order by id), '{}') into v_gone from d;
    if v_gone is distinct from v_src_ids then
      raise exception 'match_conflict: the collections of this row changed while matching; try again' using errcode = '40001';
    end if;
  else
    if exists (select 1 from unnest(v_src_ids) i where not exists (select 1 from public.collection_memberships m where m.id = i)) then
      raise exception 'match_conflict: the collections of this row changed while matching; try again' using errcode = '40001';
    end if;
  end if;
  if exists (select 1 from unnest(v_tgt_ids) i where not exists (select 1 from public.collection_memberships m where m.id = i)) then
    raise exception 'match_conflict: the collections of the matched show changed while matching; try again' using errcode = '40001';
  end if;

  update public.watchlist_items set
    title = p_patch ->> 'title', season = p_patch ->> 'season', item_key = p_patch ->> 'item_key',
    theme = coalesce(p_patch ->> 'theme', theme), display_date = coalesce(p_patch ->> 'display_date', display_date),
    date_sort = p_patch ->> 'date_sort', media_type = 'tv', tmdb_id = v_tmdb, season_number = v_num, show_id = v_target_show,
    theme_kind = null
  where id = r.id and user_id = v_owner and tmdb_id is null and media_type is null and season_number is null
  returning * into r;
  if r.id is null then raise exception 'match_conflict: the row changed; try again' using errcode = '40001'; end if;

  if v_l.id is not null and v_l.id <> v_target_show and not exists (select 1 from public.watchlist_items where show_id = v_l.id) then
    delete from public.tv_shows where id = v_l.id;
  end if;
  return jsonb_build_object('blocked', false, 'row', to_jsonb(r) - 'is_film', 'show_id', v_target_show);
end $$;

-- Deletes one TV season; a show left with no seasons goes too (its governance
-- link and memberships with it). Skip never deletes; catalog entries are skipped by the app.
create or replace function public.delete_tv_season(p_row_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('delete_tv_season', 'final');
  r public.watchlist_items;
  v_show public.tv_shows;
  v_show_deleted boolean := false;
begin
  select * into r from public.watchlist_items where id = p_row_id and user_id = v_owner and not is_film;
  if r.id is null then raise exception 'not_found: TV season' using errcode = 'P0002'; end if;
  if r.show_id is not null then
    select * into v_show from public.tv_shows where id = r.show_id and user_id = v_owner for update;
  end if;
  delete from public.watchlist_items where id = r.id and user_id = v_owner;
  if v_show.id is not null and not exists (select 1 from public.watchlist_items where show_id = v_show.id) then
    delete from public.tv_shows where id = v_show.id and user_id = v_owner;
    v_show_deleted := true;
  end if;
  return jsonb_build_object('deleted_row_id', r.id, 'show_id', v_show.id, 'show_deleted', v_show_deleted);
end $$;

-- Dates of catalog-governed entries change only inside a catalog application's
-- date step (or an admin transaction that sets watchlist.catalog_date_write).
drop trigger catalog_date_guard on public.watchlist_items;
create or replace function private.catalog_date_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.display_date is distinct from old.display_date or new.date_sort is distinct from old.date_sort)
     and coalesce(current_setting('watchlist.catalog_date_write', true), '') <> 'on'
     and (exists (select 1 from public.catalog_film_links l where l.item_id = old.id)
          or (old.show_id is not null and exists (select 1 from public.catalog_show_links l where l.show_id = old.show_id))) then
    raise exception 'catalog_apply_required: Dates of built-in catalog entries now change only through Catalog updates. Reload the page. Nothing was changed.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger catalog_date_guard before update of display_date, date_sort on public.watchlist_items
  for each row execute function private.catalog_date_guard();

-- Admin-only TMDB identity enrichment of one unmatched catalog-governed show
-- (SQL Editor, as postgres; the db/admin/tv_enrich.sql contract, storage-free).
create or replace function private.tv_enrich_show(
  p_show_id uuid, p_expected_title text, p_tmdb_id integer, p_seasons jsonb, p_apply boolean default false)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_owner uuid := (select bootstrap_owner_id from private.app_owner);
  v_show public.tv_shows;
  v_catalog text;
  v_count int;
  v_rows uuid[] := '{}';
  v_nums int[] := '{}';
  v_plan jsonb := '[]';
  v_n int;
  e jsonb;
  r public.watchlist_items;
  v_conflict uuid;
begin
  if private.tv_stage() not in ('authoritative', 'final') then
    raise exception 'enrich: not available in stage %', private.tv_stage();
  end if;
  if p_tmdb_id is null or p_tmdb_id <= 0 then raise exception 'enrich: tmdb_id required'; end if;

  select * into v_show from public.tv_shows where id = p_show_id for update;
  if not found then raise exception 'enrich: show % not found', p_show_id; end if;
  if v_show.user_id is distinct from v_owner then raise exception 'enrich: show % belongs to another owner', p_show_id; end if;
  if v_show.title is distinct from p_expected_title then
    raise exception 'enrich: show % is "%", not "%"', p_show_id, v_show.title, p_expected_title;
  end if;
  if v_show.tmdb_id is not null then raise exception 'enrich: "%" already has TMDB id %', v_show.title, v_show.tmdb_id; end if;
  v_catalog := private.lib_show_catalog(v_show.id);
  select id into v_conflict from public.tv_shows where user_id = v_show.user_id and tmdb_id = p_tmdb_id;
  if found then raise exception 'enrich: TMDB % is already show %', p_tmdb_id, v_conflict; end if;

  if jsonb_typeof(p_seasons) is distinct from 'array' then raise exception 'enrich: seasons must be a list'; end if;
  for e in select * from jsonb_array_elements(p_seasons) loop
    begin v_n := (e ->> 'season_number')::int;
    exception when others then raise exception 'enrich: season_number in %', e; end;
    if v_n is null or v_n < 0 then raise exception 'enrich: season_number in %', e; end if;
    select * into r from public.watchlist_items where id = (e ->> 'row_id')::uuid for update;
    if not found then raise exception 'enrich: row % not found', e ->> 'row_id'; end if;
    if r.show_id is distinct from v_show.id or r.user_id is distinct from v_show.user_id then
      raise exception 'enrich: row % is not a season of "%"', r.id, v_show.title;
    end if;
    if r.season is distinct from (e ->> 'season') then
      raise exception 'enrich: row % is "%", not "%"', r.id, r.season, e ->> 'season';
    end if;
    if r.media_type is not null or r.tmdb_id is not null or r.season_number is not null or r.is_film then
      raise exception 'enrich: row % is not a legacy TV season', r.id;
    end if;
    if r.id = any(v_rows) then raise exception 'enrich: row % listed twice', r.id; end if;
    if v_n = any(v_nums) then raise exception 'enrich: season_number % listed twice', v_n; end if;
    select id into v_conflict from public.watchlist_items
    where user_id = r.user_id and media_type = 'tv' and tmdb_id = p_tmdb_id and season_number = v_n;
    if found then raise exception 'enrich: TMDB % season % is already row %', p_tmdb_id, v_n, v_conflict; end if;
    v_rows := v_rows || r.id;
    v_nums := v_nums || v_n;
    v_plan := v_plan || jsonb_build_object('row_id', r.id, 'season', r.season, 'item_key', r.item_key, 'season_number', v_n);
  end loop;
  select count(*) into v_count from public.watchlist_items where show_id = v_show.id;
  if v_count <> cardinality(v_rows) then
    raise exception 'enrich: "%" has % seasons, % mapped; every season must be mapped', v_show.title, v_count, cardinality(v_rows);
  end if;

  if p_apply then
    perform private.lib_write_on();
    update public.tv_shows set tmdb_id = p_tmdb_id where id = v_show.id and tmdb_id is null;
    get diagnostics v_count = row_count;
    if v_count <> 1 then raise exception 'enrich: show changed meanwhile'; end if;
    for i in 1 .. cardinality(v_rows) loop
      update public.watchlist_items set media_type = 'tv', tmdb_id = p_tmdb_id, season_number = v_nums[i]
      where id = v_rows[i] and media_type is null and tmdb_id is null and season_number is null;
      get diagnostics v_count = row_count;
      if v_count <> 1 then raise exception 'enrich: row % changed meanwhile', v_rows[i]; end if;
    end loop;
  end if;

  return jsonb_build_object('applied', p_apply, 'show_id', v_show.id, 'title', v_show.title, 'catalog', v_catalog,
    'status', v_show.status, 'tmdb_id', p_tmdb_id, 'seasons', v_plan);
end $$;

-- ── restore_backup: format 4 (and a converted format-3 file's recovery section) ─
-- A format-4 backup replaces the owner's rows in all eight tables in one
-- transaction (ids and created_at kept; another owner's ids refused). Format 3
-- is converted in the page first (explicit, previewed, loss-aware); this
-- function never interprets a format-3 file. A converted document may carry
-- conversion {source_format: 3, …} and, while the recovery archive is active, a
-- recovery section: the original storage of every item, show and collection and
-- the file's othertv_shows rows. It is validated in full (completeness, values,
-- agreement with the document's own governance and theme kinds) and only then
-- replaces the owner's archive entries, in this transaction. It never feeds the
-- restored tables: governance and theme kinds come only from the tables.
create or replace function public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := private.current_owner_id();
  v_version text := p_backup ->> 'formatVersion';
  v_tables jsonb := p_backup -> 'tables';
  v_counts jsonb := p_backup -> 'rowCounts';
  v_conv jsonb := p_backup -> 'conversion';
  v_rec jsonb := p_backup -> 'recovery';
  v_expected jsonb := jsonb_build_object(
    'watchlist_items', jsonb_build_array('id','item_key','title','season','theme','theme_kind','display_date',
      'date_sort','watched','status','created_at','watch_with','collections','tmdb_collection_id',
      'tmdb_collection_name','media_type','tmdb_id','season_number','show_id','skipped'),
    'tv_shows', jsonb_build_array('id','title','show_key','tmdb_id','status','created_at'),
    'custom_collections', jsonb_build_array('id','name','tmdb_person_id','created_at','role'),
    'personal_collections', jsonb_build_array('id','name','catalog_id','presentation_key','sort_order','archived_at','created_at'),
    'collection_memberships', jsonb_build_array('id','collection_id','show_id','item_id','created_at'),
    'watch_with_choices', jsonb_build_array('id','token','label','sort_order','archived_at','created_at'),
    'catalog_show_links', jsonb_build_array('id','catalog','catalog_key','show_id','origin','created_at'),
    'catalog_film_links', jsonb_build_array('id','catalog','entry_key','item_id','origin','created_at'));
  v_othertv_cols jsonb := jsonb_build_array('id','tmdb_id','title','network','created_at','collection');
  v_table text;
  v_constraint text;
  v_n jsonb := '{}';
  v_k int;
  v_taken boolean;
  v_bad jsonb;
begin
  if p_backup ->> 'format' is distinct from 'watchlist-tracker-backup' then
    raise exception 'restore_invalid: not a Watchlist backup' using errcode = '22023';
  end if;
  if v_version = '1' then
    raise exception 'restore_invalid: format 1 backups predate TV shows and can no longer be restored' using errcode = '22023';
  elsif v_version = '2' then
    raise exception 'restore_invalid: format 2 backups predate personal collections and can''t be restored here' using errcode = '22023';
  elsif v_version = '3' then
    raise exception 'restore_invalid: format 3 backups are converted in the page first (Restore shows what the conversion keeps and what it can''t); nothing was changed'
      using errcode = '22023';
  elsif v_version is distinct from '4' then
    raise exception 'restore_invalid: unsupported backup format %', coalesce(v_version, '(none)') using errcode = '22023';
  end if;
  if private.tv_stage() <> 'final' then
    raise exception 'restore_invalid: format 4 needs stage final, found %', private.tv_stage() using errcode = '22023';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_backup) k)
     <@ array['conversion', 'exportedAt', 'format', 'formatVersion', 'recovery', 'rowCounts', 'tables']::text[] is not true then
    raise exception 'restore_invalid: unexpected top-level fields' using errcode = '22023';
  end if;

  if jsonb_typeof(v_tables) is distinct from 'object' or jsonb_typeof(v_counts) is distinct from 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(v_tables) k)
        is distinct from (select array_agg(k order by k collate "C") from jsonb_object_keys(v_expected) k) then
    raise exception 'restore_invalid: unexpected set of tables for format %', v_version using errcode = '22023';
  end if;
  for v_table in select jsonb_object_keys(v_expected) loop
    if jsonb_typeof(v_tables -> v_table) is distinct from 'array' then
      raise exception 'restore_invalid: % is not a list of rows', v_table using errcode = '22023';
    end if;
    if (v_counts ->> v_table) is distinct from jsonb_array_length(v_tables -> v_table)::text then
      raise exception 'restore_invalid: rowCounts.% does not match its rows', v_table using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_tables -> v_table) r
      where jsonb_typeof(r) is distinct from 'object'
         or (select array_agg(k order by k collate "C") from jsonb_object_keys(r) k)
            is distinct from (select array_agg(x order by x collate "C") from jsonb_array_elements_text(v_expected -> v_table) x)
    ) then
      raise exception 'restore_invalid: a % row does not have exactly the expected columns', v_table using errcode = '22023';
    end if;
  end loop;

  -- The conversion record and the recovery section (validated before anything changes).
  if v_conv is not null and (jsonb_typeof(v_conv) is distinct from 'object'
     or (v_conv ->> 'source_format') is distinct from '3' or coalesce(v_conv ->> 'source_sha256', '') !~ '^[0-9a-f]{64}$'
     or coalesce(v_conv ->> 'converter_version', '') = '' or coalesce(v_conv ->> 'source_exported_at', '') = '') then
    raise exception 'restore_invalid: the conversion record is malformed' using errcode = '22023';
  end if;
  if v_rec is not null then
    if v_conv is null then
      raise exception 'recovery_not_accepted: a recovery section belongs only to a converted format-3 backup; nothing was changed' using errcode = 'P0001';
    end if;
    if to_regclass('private.stage5_recovery_meta') is null then
      raise exception 'recovery_not_accepted: the recovery archive has been retired, so a recovery section can''t be kept; convert the file again without it. Nothing was changed.'
        using errcode = 'P0001';
    end if;
    if jsonb_typeof(v_rec) is distinct from 'object'
       or (select array_agg(k order by k collate "C") from jsonb_object_keys(v_rec) k) is distinct from array['othertv_shows', 'storage_map']::text[]
       or jsonb_typeof(v_rec -> 'storage_map') is distinct from 'object'
       or (select array_agg(k order by k collate "C") from jsonb_object_keys(v_rec -> 'storage_map') k)
          is distinct from array['items', 'personal_collections', 'shows']::text[]
       or jsonb_typeof(v_rec -> 'othertv_shows') is distinct from 'array'
       or exists (select 1 from jsonb_each(v_rec -> 'storage_map') m where jsonb_typeof(m.value) is distinct from 'array') then
      raise exception 'restore_invalid: the recovery section is malformed' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(v_rec -> 'storage_map' -> 'items') x
               where jsonb_typeof(x) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(x) k) is distinct from array['collection', 'id']::text[])
       or exists (select 1 from jsonb_array_elements(v_rec -> 'storage_map' -> 'shows') x
               where jsonb_typeof(x) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(x) k) is distinct from array['collection', 'id']::text[])
       or exists (select 1 from jsonb_array_elements(v_rec -> 'storage_map' -> 'personal_collections') x
               where jsonb_typeof(x) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(x) k) is distinct from array['id', 'legacy_source']::text[])
       or exists (select 1 from jsonb_array_elements(v_rec -> 'othertv_shows') x
               where jsonb_typeof(x) is distinct from 'object' or (select array_agg(k order by k collate "C") from jsonb_object_keys(x) k)
                     is distinct from (select array_agg(c order by c collate "C") from jsonb_array_elements_text(v_othertv_cols) c)) then
      raise exception 'restore_invalid: a recovery entry does not have exactly the expected fields' using errcode = '22023';
    end if;
  end if;

  perform set_config('lock_timeout', '5s', true);
  lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
    public.watch_with_choices, public.custom_collections in exclusive mode;
  perform private.lib_write_on();

  for v_table in select jsonb_object_keys(v_expected) loop
    execute format('select exists (select 1 from public.%I w join jsonb_array_elements($1) r on w.id = (r ->> ''id'')::uuid
                    where w.user_id <> $2)', v_table)
      into v_taken using v_tables -> v_table, v_owner;
    if v_taken then
      raise exception 'restore_id_collision: this backup contains ids already owned by another user; restoring it would keep those ids and break user isolation, so nothing was changed'
        using errcode = '23505';
    end if;
  end loop;

  -- (The owner's governance links go with their shows and films: foreign-key cascade.)
  delete from public.collection_memberships where user_id = v_owner;
  delete from public.watchlist_items where user_id = v_owner;
  delete from public.tv_shows where user_id = v_owner;
  delete from public.personal_collections where user_id = v_owner;
  delete from public.watch_with_choices where user_id = v_owner;
  delete from public.custom_collections where user_id = v_owner;

  begin
    insert into public.watch_with_choices (id, token, label, sort_order, archived_at, created_at)
    select id, token, label, sort_order, archived_at, created_at
    from jsonb_to_recordset(v_tables -> 'watch_with_choices') as x(id uuid, token text, label text, sort_order integer,
      archived_at timestamptz, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('watch_with_choices', v_k);

    insert into public.personal_collections (id, name, catalog_id, presentation_key, sort_order, archived_at, created_at)
    select id, name, catalog_id, presentation_key, sort_order, archived_at, created_at
    from jsonb_to_recordset(v_tables -> 'personal_collections') as x(id uuid, name text, catalog_id text, presentation_key text,
      sort_order integer, archived_at timestamptz, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('personal_collections', v_k);

    insert into public.tv_shows (id, title, show_key, tmdb_id, status, created_at)
    select id, title, show_key, tmdb_id, status, created_at
    from jsonb_to_recordset(v_tables -> 'tv_shows') as x(id uuid, title text, show_key text,
      tmdb_id integer, status text, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('tv_shows', v_k);

    insert into public.watchlist_items (id, item_key, title, season, theme, theme_kind, display_date, date_sort,
      watched, status, created_at, watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type,
      tmdb_id, season_number, show_id, skipped)
    select id, item_key, title, season, theme, theme_kind, display_date, date_sort, watched, status, created_at,
      watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number,
      show_id, skipped
    from jsonb_to_recordset(v_tables -> 'watchlist_items') as x(id uuid, item_key text, title text,
      season text, theme text, theme_kind text, display_date text, date_sort text, watched boolean, status text, created_at timestamptz,
      watch_with text[], collections text[], tmdb_collection_id integer, tmdb_collection_name text, media_type text,
      tmdb_id integer, season_number integer, show_id uuid, skipped boolean);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('watchlist_items', v_k);

    insert into public.custom_collections (id, name, tmdb_person_id, created_at, role)
    select id, name, tmdb_person_id, created_at, role
    from jsonb_to_recordset(v_tables -> 'custom_collections') as x(id uuid, name text, tmdb_person_id integer,
      created_at timestamptz, role text);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('custom_collections', v_k);

    insert into public.collection_memberships (id, collection_id, show_id, item_id, created_at)
    select id, collection_id, show_id, item_id, created_at
    from jsonb_to_recordset(v_tables -> 'collection_memberships') as x(id uuid, collection_id uuid, show_id uuid,
      item_id uuid, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('collection_memberships', v_k);

    insert into public.catalog_show_links (id, catalog, catalog_key, show_id, origin, created_at)
    select id, catalog, catalog_key, show_id, origin, created_at
    from jsonb_to_recordset(v_tables -> 'catalog_show_links') as x(id uuid, catalog text, catalog_key text, show_id uuid,
      origin text, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('catalog_show_links', v_k);

    insert into public.catalog_film_links (id, catalog, entry_key, item_id, origin, created_at)
    select id, catalog, entry_key, item_id, origin, created_at
    from jsonb_to_recordset(v_tables -> 'catalog_film_links') as x(id uuid, catalog text, entry_key text, item_id uuid,
      origin text, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('catalog_film_links', v_k);
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint like '%\_pkey' then
        raise exception 'restore_id_collision: this backup contains ids already owned by another user; restoring it would keep those ids and break user isolation, so nothing was changed'
          using errcode = '23505';
      end if;
      raise exception 'restore_invalid: the backup repeats a unique value (%), so nothing was changed', v_constraint using errcode = '22023';
    when foreign_key_violation then
      get stacked diagnostics v_constraint = constraint_name;
      raise exception 'restore_invalid: a row in the backup points at something that isn''t in it or has the wrong kind (%), so nothing was changed', v_constraint
        using errcode = '22023';
    when check_violation or not_null_violation then
      get stacked diagnostics v_constraint = constraint_name;
      raise exception 'restore_invalid: a row in the backup breaks a rule (%: %), so nothing was changed', coalesce(nullif(v_constraint, ''), 'check'), sqlerrm
        using errcode = '22023';
  end;

  if exists (select 1 from public.watchlist_items where user_id = v_owner and show_id is null and not is_film) then
    raise exception 'restore_invalid: every TV season must belong to a show in this backup' using errcode = '22023';
  end if;
  if (select count(*) from public.collection_memberships where user_id = v_owner)
       <> jsonb_array_length(v_tables -> 'collection_memberships')
     or exists (
       select 1 from jsonb_to_recordset(v_tables -> 'collection_memberships') as x(id uuid, collection_id uuid, show_id uuid, item_id uuid)
       where not exists (select 1 from public.collection_memberships m where m.id = x.id and m.user_id = v_owner
                         and m.collection_id = x.collection_id and m.show_id is not distinct from x.show_id
                         and m.item_id is not distinct from x.item_id)) then
    raise exception 'restore_invalid: the restored memberships differ from the backup' using errcode = '22023';
  end if;
  if (select count(*) from public.catalog_show_links where user_id = v_owner) <> jsonb_array_length(v_tables -> 'catalog_show_links')
     or (select count(*) from public.catalog_film_links where user_id = v_owner) <> jsonb_array_length(v_tables -> 'catalog_film_links') then
    raise exception 'restore_invalid: the restored catalog governance differs from the backup' using errcode = '22023';
  end if;

  if v_rec is not null then
    create temp table _s5map (kind text, id uuid, collection text) on commit drop;
    insert into _s5map select 'item', (x ->> 'id')::uuid, x ->> 'collection' from jsonb_array_elements(v_rec -> 'storage_map' -> 'items') x;
    insert into _s5map select 'show', (x ->> 'id')::uuid, x ->> 'collection' from jsonb_array_elements(v_rec -> 'storage_map' -> 'shows') x;
    create temp table _s5cmap (id uuid, legacy_source text) on commit drop;
    insert into _s5cmap select (x ->> 'id')::uuid, x ->> 'legacy_source' from jsonb_array_elements(v_rec -> 'storage_map' -> 'personal_collections') x;
    select jsonb_strip_nulls(jsonb_build_object(
      'repeated_ids', (select jsonb_agg(id) from (select id from _s5map group by kind, id having count(*) > 1) z),
      'items_not_covered', (select count(*) from public.watchlist_items w where w.user_id = v_owner
                            and not exists (select 1 from _s5map m where m.kind = 'item' and m.id = w.id)),
      'shows_not_covered', (select count(*) from public.tv_shows s where s.user_id = v_owner
                            and not exists (select 1 from _s5map m where m.kind = 'show' and m.id = s.id)),
      'extra_entries', (select count(*) from _s5map m where not exists (
                          select 1 from public.watchlist_items w where m.kind = 'item' and w.id = m.id and w.user_id = v_owner
                          union all select 1 from public.tv_shows s where m.kind = 'show' and s.id = m.id and s.user_id = v_owner)),
      'unknown_storage', (select count(*) from _s5map where collection is null
                          or collection not in ('disney', '90day', 'sheridan', 'othertv', 'truecrime', 'movies')),
      'show_governance', (select count(*) from _s5map m join public.tv_shows s on s.id = m.id and m.kind = 'show'
                          left join public.catalog_show_links l on l.show_id = s.id
                          where (m.collection in ('disney', '90day', 'sheridan')) is distinct from (l.catalog is not null)
                             or (l.catalog is not null and l.catalog <> m.collection)
                             or (l.catalog is null and m.collection not in ('othertv', 'truecrime'))),
      'season_storage', (select count(*) from _s5map m join public.watchlist_items w on w.id = m.id and m.kind = 'item' and w.show_id is not null
                         join _s5map ms on ms.kind = 'show' and ms.id = w.show_id where ms.collection <> m.collection),
      'film_governance', (select count(*) from _s5map m join public.watchlist_items w on w.id = m.id and m.kind = 'item' and w.is_film
                          left join public.catalog_film_links l on l.item_id = w.id
                          where (m.collection in ('disney', '90day', 'sheridan')) is distinct from (l.catalog is not null)
                             or (l.catalog is not null and l.catalog <> m.collection)
                             or (w.theme_kind = 'genre') is distinct from (m.collection = 'movies')),
      'collections_not_covered', (select count(*) from public.personal_collections c where c.user_id = v_owner
                                  and not exists (select 1 from _s5cmap m where m.id = c.id)),
      'collection_entries', (select count(*) from _s5cmap m left join public.personal_collections c on c.id = m.id and c.user_id = v_owner
                             where c.id is null or (m.legacy_source is not null and m.legacy_source not in ('disney', '90day', 'sheridan', 'truecrime'))
                                or (c.catalog_id is not null and m.legacy_source is distinct from c.catalog_id)
                                or (c.catalog_id is null and m.legacy_source in ('disney', '90day', 'sheridan'))
                                or c.presentation_key is distinct from m.legacy_source),
      'repeated_collections', (select count(*) from (select id from _s5cmap group by id having count(*) > 1) z),
      'othertv_rows', (select count(*) from jsonb_array_elements(v_rec -> 'othertv_shows') x
                       where coalesce(x ->> 'collection', '') not in ('othertv', 'truecrime') or coalesce(btrim(x ->> 'title'), '') = ''
                          or (x ->> 'tmdb_id') !~ '^[0-9]+$' or (x ->> 'id') !~ '^[0-9a-f-]{36}$' or x -> 'network' is null
                          or jsonb_typeof(x -> 'network') <> 'string'),
      'othertv_repeats', (select count(*) from (select x ->> 'collection', x ->> 'tmdb_id' from jsonb_array_elements(v_rec -> 'othertv_shows') x
                          group by 1, 2 having count(*) > 1) z)
    )) into v_bad;
    v_bad := (select coalesce(jsonb_object_agg(key, value), '{}') from jsonb_each(v_bad) where value not in ('0'::jsonb, 'null'::jsonb));
    if v_bad <> '{}'::jsonb then
      raise exception 'restore_invalid: the recovery section doesn''t match the backup (%), so nothing was changed', v_bad using errcode = '22023';
    end if;
    begin
      delete from private.stage5_recovery_records where user_id = v_owner;
      delete from private.stage5_recovery_collections where user_id = v_owner;
      delete from private.stage5_recovery_othertv where user_id = v_owner;
      delete from private.stage5_recovery_meta where user_id = v_owner;
      insert into private.stage5_recovery_records (user_id, kind, id, collection) select v_owner, kind, id, collection from _s5map;
      insert into private.stage5_recovery_collections (user_id, id, legacy_source) select v_owner, id, legacy_source from _s5cmap;
      insert into private.stage5_recovery_othertv (id, user_id, tmdb_id, title, network, created_at, collection)
      select (x ->> 'id')::uuid, v_owner, (x ->> 'tmdb_id')::integer, x ->> 'title', x ->> 'network', (x ->> 'created_at')::timestamptz, x ->> 'collection'
      from jsonb_array_elements(v_rec -> 'othertv_shows') x;
      insert into private.stage5_recovery_meta (user_id, origin, counts, hashes)
      values (v_owner, 'converted_restore',
        jsonb_build_object('items', (select count(*) from _s5map where kind = 'item'), 'shows', (select count(*) from _s5map where kind = 'show'),
          'collections', (select count(*) from _s5cmap), 'othertv_shows', jsonb_array_length(v_rec -> 'othertv_shows')),
        jsonb_build_object('source_sha256', v_conv ->> 'source_sha256',
          -- The installed archive's own content hashes (the same forms the contraction records).
          'records', (select md5(coalesce(string_agg(r.kind || ':' || r.id || ':' || r.collection, '|' order by r.kind, r.id), ''))
                      from private.stage5_recovery_records r where r.user_id = v_owner),
          'collections', (select md5(coalesce(string_agg(r.id || ':' || coalesce(r.legacy_source, ''), '|' order by r.id), ''))
                          from private.stage5_recovery_collections r where r.user_id = v_owner),
          'othertv_shows', (select md5(coalesce(string_agg((to_jsonb(r) - 'user_id')::text, '|' order by r.id), ''))
                            from private.stage5_recovery_othertv r where r.user_id = v_owner)));
    exception when others then
      get stacked diagnostics v_constraint = message_text;
      raise exception 'restore_invalid: the recovery section couldn''t be kept (%), so nothing was changed', v_constraint using errcode = '22023';
    end;
    -- The archive now holds exactly the recovery section: every entry, no other, and the
    -- recorded hashes are those of what was installed (otherwise nothing is kept at all).
    if (select count(*) from private.stage5_recovery_records where user_id = v_owner) <> (select count(*) from _s5map)
       or exists (select kind, id, collection from _s5map except select kind, id, collection from private.stage5_recovery_records where user_id = v_owner)
       or (select count(*) from private.stage5_recovery_collections where user_id = v_owner) <> (select count(*) from _s5cmap)
       or exists (select id, legacy_source from _s5cmap except select id, legacy_source from private.stage5_recovery_collections where user_id = v_owner)
       or (select count(*) from private.stage5_recovery_othertv where user_id = v_owner) <> jsonb_array_length(v_rec -> 'othertv_shows')
       or exists (select (x ->> 'id')::uuid, (x ->> 'tmdb_id')::integer, x ->> 'title', x ->> 'network', (x ->> 'created_at')::timestamptz, x ->> 'collection'
                  from jsonb_array_elements(v_rec -> 'othertv_shows') x
                  except select id, tmdb_id, title, network, created_at, collection from private.stage5_recovery_othertv where user_id = v_owner)
       or (select hashes ->> 'records' from private.stage5_recovery_meta where user_id = v_owner)
          is distinct from md5((select coalesce(string_agg(m.kind || ':' || m.id || ':' || m.collection, '|' order by m.kind, m.id), '') from _s5map m)) then
      raise exception 'restore_invalid: the recovery archive written doesn''t equal the recovery section, so nothing was changed' using errcode = '22023';
    end if;
  end if;

  return jsonb_build_object('formatVersion', 4, 'restored', v_n,
    'recovery', case when v_rec is not null then 'archived' else 'none' end,
    'converted_from', case when v_conv is not null then 3 end);
end
$$;

-- Old pages: every storage-shaped function refuses (nothing written).
create or replace function public.add_tv_seasons(p_collection text, p_show jsonb, p_seasons jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;
create or replace function public.add_tv_seasons_to_show(p_show_id uuid, p_expected jsonb, p_seasons jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;
create or replace function public.create_tv_show(p_show jsonb, p_seasons jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;
create or replace function public.match_tv_row(p_row_id uuid, p_target jsonb, p_patch jsonb, p_expansion jsonb default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;
create or replace function public.catalog_apply(p_collection text, p_defaults jsonb, p_approved text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;

create or replace function public.stage5_capabilities() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted', 'backup_format', 4,
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;

revoke all on function private.tv_show_key_override(text, text), private.tv_show_key(text, text),
  private.lib_catalog_insert_v5(uuid, text, jsonb) from public;
grant execute on function private.tv_show_key_override(text, text), private.tv_show_key(text, text),
  private.lib_catalog_insert_v5(uuid, text, jsonb) to anon, authenticated;

-- ── 5. Privilege contract ────────────────────────────────────────────────────
-- Grants: what the SECURITY INVOKER functions and restore write (a guard does not
-- grant anything); the guard triggers below refuse those writes unless the
-- transaction set watchlist.library_write.
alter table public.catalog_show_links enable row level security;
alter table public.catalog_film_links enable row level security;
create policy anon_select on public.catalog_show_links for select to anon using (true);
create policy anon_insert on public.catalog_show_links for insert to anon with check (true);
create policy anon_select on public.catalog_film_links for select to anon using (true);
create policy anon_insert on public.catalog_film_links for insert to anon with check (true);
revoke all on public.catalog_show_links, public.catalog_film_links from public, anon, authenticated;
grant select on public.catalog_show_links, public.catalog_film_links to anon, authenticated;
grant insert (id, catalog, catalog_key, show_id, origin, created_at) on public.catalog_show_links to anon, authenticated;
grant insert (id, catalog, entry_key, item_id, origin, created_at) on public.catalog_film_links to anon, authenticated;
grant insert (theme_kind), update (theme_kind) on public.watchlist_items to anon, authenticated;
grant insert (catalog_id, presentation_key) on public.personal_collections to anon, authenticated;
revoke all on private.stage5_recovery_records, private.stage5_recovery_collections, private.stage5_recovery_othertv,
  private.stage5_recovery_meta from public, anon, authenticated;
grant select, insert, delete on private.stage5_recovery_records, private.stage5_recovery_collections, private.stage5_recovery_othertv,
  private.stage5_recovery_meta to anon, authenticated;

create function private.library_write_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('watchlist.library_write', true), '') <> 'on' then
    raise exception 'library_write_required: This change is made only through the app''s library functions. Reload the page. Nothing was changed.'
      using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function private.library_write_guard() from public;

create trigger watchlist_items_insert_guard before insert on public.watchlist_items
  for each row execute function private.library_write_guard();
create trigger watchlist_items_identity_guard before update of id, media_type, tmdb_id, season_number, season, item_key, show_id, theme_kind
  on public.watchlist_items for each row
  when (new.id is distinct from old.id or new.media_type is distinct from old.media_type or new.tmdb_id is distinct from old.tmdb_id
        or new.season_number is distinct from old.season_number or new.season is distinct from old.season
        or new.item_key is distinct from old.item_key or new.show_id is distinct from old.show_id or new.theme_kind is distinct from old.theme_kind)
  execute function private.library_write_guard();
create trigger tv_shows_insert_guard before insert on public.tv_shows
  for each row execute function private.library_write_guard();
create trigger tv_shows_identity_guard before update of id, tmdb_id, show_key on public.tv_shows for each row
  when (new.id is distinct from old.id or new.tmdb_id is distinct from old.tmdb_id or new.show_key is distinct from old.show_key)
  execute function private.library_write_guard();
create trigger catalog_show_links_insert_guard before insert on public.catalog_show_links
  for each row execute function private.library_write_guard();
create trigger catalog_film_links_insert_guard before insert on public.catalog_film_links
  for each row execute function private.library_write_guard();
create trigger personal_collections_catalog_guard before insert on public.personal_collections
  for each row when (new.catalog_id is not null or new.presentation_key is not null) execute function private.library_write_guard();
create trigger personal_collections_catalog_update_guard before update of catalog_id, presentation_key on public.personal_collections
  for each row when (new.catalog_id is distinct from old.catalog_id or new.presentation_key is distinct from old.presentation_key)
  execute function private.library_write_guard();
create trigger stage5_recovery_records_guard before insert or delete on private.stage5_recovery_records
  for each row execute function private.library_write_guard();
create trigger stage5_recovery_collections_guard before insert or delete on private.stage5_recovery_collections
  for each row execute function private.library_write_guard();
create trigger stage5_recovery_othertv_guard before insert or delete on private.stage5_recovery_othertv
  for each row execute function private.library_write_guard();
create trigger stage5_recovery_meta_guard before insert or delete on private.stage5_recovery_meta
  for each row execute function private.library_write_guard();

-- ── 6. Membership triggers retire (their duties are explicit now) ─────────────
drop trigger org_auto_membership_show on public.tv_shows;
drop trigger org_auto_membership_film on public.watchlist_items;
drop trigger org_carry_membership_to_film on public.watchlist_items;
drop function private.org_auto_membership();
drop function private.org_bootstrap(uuid);

-- ── 7. Storage goes ──────────────────────────────────────────────────────────
-- Only once the archive is an exact copy of what is dropped: every othertv_shows row
-- (all columns), every record's and show's storage, every collection's legacy_source.
do $$
begin
  if (select count(*) from public.othertv_shows) <> (select count(*) from private.stage5_recovery_othertv)
     or exists (select * from public.othertv_shows except select * from private.stage5_recovery_othertv)
     or exists (select * from private.stage5_recovery_othertv except select * from public.othertv_shows) then
    raise exception 'phase5c: the archived othertv_shows rows are not an exact copy; nothing was changed';
  end if;
  if exists (select 1 from public.watchlist_items w left join private.stage5_recovery_records a on a.kind = 'item' and a.id = w.id
             where a.collection is distinct from w.collection)
     or exists (select 1 from public.tv_shows s left join private.stage5_recovery_records a on a.kind = 'show' and a.id = s.id
                where a.collection is distinct from s.collection)
     or exists (select 1 from public.personal_collections c left join private.stage5_recovery_collections a on a.id = c.id
                where a.id is null or a.legacy_source is distinct from c.legacy_source) then
    raise exception 'phase5c: the archived storage is not an exact copy; nothing was changed';
  end if;
end $$;
drop function private.catalog_run(text, jsonb);
drop function private.catalog_insert_missing(uuid, text, jsonb);
drop function private.tv_backfill(uuid);
drop function private.tv_enriched_show_for(uuid, text, text);
drop function private.tv_lock_or_create_show(uuid, text, integer, text, text, text);
drop function private.tv_is_tv_row(text, text, text);
drop function private.tv_collections();
drop function private.tv_builtin_collections();

alter table public.watchlist_items drop constraint watchlist_items_show_fkey;
alter table public.watchlist_items add constraint watchlist_items_show_fkey foreign key (show_id, user_id)
  references public.tv_shows (id, user_id) on update cascade on delete restrict;
alter table public.tv_shows drop constraint tv_shows_id_owner_collection_key;
drop index public.tv_shows_identified_key;
drop index public.tv_shows_legacy_key;
drop index public.watchlist_items_movie_identity_key;
drop index public.watchlist_items_tv_identity_key;
drop index public.watchlist_items_legacy_item_key_key;
drop index public.watchlist_items_collection_idx;
create index watchlist_items_owner_date_idx on public.watchlist_items using btree (user_id, date_sort);
alter table public.watchlist_items drop column collection;
alter table public.tv_shows drop column collection;
alter table public.personal_collections drop column legacy_source;
drop table public.othertv_shows;

-- ── 8. Verify before commit ──────────────────────────────────────────────────
do $$
declare b record; a record;
begin
  select * into b from phase5c_before;
  select
    (select count(*) from public.watchlist_items) w_n,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'theme_kind' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t) w,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t) s,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t) m,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'catalog_id' - 'presentation_key')::text, '|' order by t.id), '')) from public.personal_collections t) p,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watch_with_choices t) c,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.custom_collections t) cc,
    (select count(*) from public.catalog_show_links) gs,
    (select count(*) from public.catalog_film_links) gf,
    (select md5(coalesce(string_agg(show_id::text || ':' || catalog || ':' || catalog_key, '|' order by show_id), '')) from public.catalog_show_links) gsh,
    (select md5(coalesce(string_agg(item_id::text || ':' || catalog || ':' || entry_key, '|' order by item_id), '')) from public.catalog_film_links) gfh,
    (select md5(coalesce(string_agg(id::text || ':' || theme_kind, '|' order by id), '')) from public.watchlist_items where is_film) tk
  into a;
  if a is distinct from b then raise exception 'phase5c: a preserved value changed (before %, after %)', row_to_json(b), row_to_json(a); end if;
  if (select count(*) from private.stage5_recovery_records) <> (select count(*) from public.watchlist_items) + (select count(*) from public.tv_shows)
     or (select count(*) from private.stage5_recovery_collections) <> (select count(*) from public.personal_collections) then
    raise exception 'phase5c: the recovery archive does not cover every record';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and column_name in ('collection', 'legacy_source')) then
    raise exception 'phase5c: a storage column is still present';
  end if;
  if exists (select 1 from public.catalog_show_links l join public.tv_shows s on s.id = l.show_id where l.catalog_key <> s.show_key)
     or exists (select 1 from public.catalog_film_links l join public.watchlist_items w on w.id = l.item_id where l.entry_key <> w.item_key) then
    raise exception 'phase5c: a governance key differs from its record';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
