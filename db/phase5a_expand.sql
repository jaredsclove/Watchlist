-- Stage 5a: expand (coexistence), in one transaction. Additive only.
--   * Library-wide identity: one show per TMDB identity, one film per TMDB
--     identity, one season per TMDB season, one season label per show — across
--     every storage value. Created only when the current data already satisfies
--     them (the collision inventory below aborts with a report otherwise; any
--     collision is reconciled first, separately).
--   * Read views over storage: library_catalog_shows / library_catalog_films
--     (catalog governance) and library_film_theme_kinds (what a film's theme
--     means). Derived from storage: every state stays representable in backup
--     format 3, and every old creation path keeps them correct by construction.
--   * The new write contract, library_*: storage-free signatures used only by
--     the new page. They rest on a few phase-dependent private primitives that
--     the contraction (db/phase5c_contract.sql) replaces; the public functions
--     themselves don't change at contraction.
--   * Old pages keep every function they call, with the same inputs and meaning.
--     Two new refusals: a cross-storage identity duplicate (unique index), and
--     the old catalog_apply's apply step (client_outdated; its preview stays):
--     catalog application is unavailable until the new page is verified.
--   * stage5_capabilities() tells the new page which phase it is talking to.
-- No row changes. Storage (collection) stays the source of truth until the
-- contraction. Run as postgres at stage final with Stage 4b installed.
-- Rollback (refuses unless installed and not contracted): db/rollback/phase5a.sql.
begin;
set local lock_timeout = '5s';

do $$ begin
  if private.tv_stage() <> 'final' then raise exception 'phase5a: expected stage final, found %', private.tv_stage(); end if;
  if to_regprocedure('public.create_tv_show(jsonb, jsonb)') is null then raise exception 'phase5a: Stage 4b is not installed'; end if;
  if to_regprocedure('public.stage5_capabilities()') is not null then raise exception 'phase5a: already applied (stage5_capabilities exists)'; end if;
end $$;

-- The data before anything changes (compared at the end: 5a changes no row).
create temp table phase5a_before on commit drop as
select
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watchlist_items t) w,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t) s,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.collection_memberships t) m,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.personal_collections t) p;

-- ── Collision inventory: reconcile first, never enforce over a collision ─────
lock table public.tv_shows, public.watchlist_items in share mode;
do $$
declare v jsonb;
begin
  select jsonb_strip_nulls(jsonb_build_object(
    'duplicate_show_identity', (select jsonb_agg(jsonb_build_object('tmdb_id', tmdb_id, 'ids', ids)) from (
      select tmdb_id, array_agg(id order by id) ids from public.tv_shows where tmdb_id is not null group by user_id, tmdb_id having count(*) > 1) x),
    'duplicate_film_identity', (select jsonb_agg(jsonb_build_object('tmdb_id', tmdb_id, 'ids', ids)) from (
      select tmdb_id, array_agg(id order by id) ids from public.watchlist_items where media_type = 'movie' and tmdb_id is not null
      group by user_id, tmdb_id having count(*) > 1) x),
    'duplicate_season_identity', (select jsonb_agg(jsonb_build_object('tmdb_id', tmdb_id, 'season_number', season_number, 'ids', ids)) from (
      select tmdb_id, season_number, array_agg(id order by id) ids from public.watchlist_items
      where media_type = 'tv' and tmdb_id is not null and season_number is not null group by user_id, tmdb_id, season_number having count(*) > 1) x),
    'duplicate_season_key_in_show', (select jsonb_agg(jsonb_build_object('show_id', show_id, 'item_key', item_key, 'ids', ids)) from (
      select show_id, item_key, array_agg(id order by id) ids from public.watchlist_items where show_id is not null
      group by show_id, item_key having count(*) > 1) x),
    'duplicate_catalog_show_key', (select jsonb_agg(jsonb_build_object('catalog', collection, 'show_key', show_key, 'ids', ids)) from (
      select collection, show_key, array_agg(id order by id) ids from public.tv_shows where collection in ('disney', '90day', 'sheridan')
      group by user_id, collection, show_key having count(*) > 1) x),
    'duplicate_catalog_film_key', (select jsonb_agg(jsonb_build_object('catalog', collection, 'item_key', item_key, 'ids', ids)) from (
      select collection, item_key, array_agg(id order by id) ids from public.watchlist_items
      where is_film and collection in ('disney', '90day', 'sheridan') group by user_id, collection, item_key having count(*) > 1) x),
    'unclassified_rows', (select jsonb_agg(id order by id) from public.watchlist_items where not is_film and show_id is null),
    'linked_films', (select jsonb_agg(id order by id) from public.watchlist_items where is_film and show_id is not null)
  )) into v;
  if v <> '{}'::jsonb then
    raise exception 'phase5a: identity collisions must be reconciled before Stage 5 enforces uniqueness; nothing was changed: %', v;
  end if;
end $$;

-- ── Library-wide identity (in addition to the per-storage keys, which old pages'
-- functions still name in their ON CONFLICT clauses) ─────────────────────────
create unique index tv_shows_library_identity_key on public.tv_shows using btree (user_id, tmdb_id)
  where (tmdb_id is not null);
create unique index watchlist_items_library_movie_key on public.watchlist_items using btree (user_id, tmdb_id)
  where ((media_type = 'movie'::text) and (tmdb_id is not null));
create unique index watchlist_items_library_tv_key on public.watchlist_items using btree (user_id, tmdb_id, season_number)
  where ((media_type = 'tv'::text) and (tmdb_id is not null) and (season_number is not null));
create unique index watchlist_items_show_item_key on public.watchlist_items using btree (show_id, item_key)
  where (show_id is not null);

-- ── Read views (derived from storage until the contraction) ──────────────────
-- Catalog governance: which built-in catalog governs a show or film (its
-- editing policy). Not a general provenance record.
create view public.library_catalog_shows with (security_invoker = true) as
  select s.id, s.id as show_id, s.collection as catalog, s.show_key as catalog_key, 'migrated_from_storage'::text as origin
  from public.tv_shows s where s.collection in ('disney', '90day', 'sheridan');
create view public.library_catalog_films with (security_invoker = true) as
  select w.id, w.id as item_id, w.collection as catalog, w.item_key as entry_key, 'migrated_from_storage'::text as origin
  from public.watchlist_items w where w.is_film and w.collection in ('disney', '90day', 'sheridan');
-- What a film's theme means: 'genre' (films stored with Movies) or 'other'.
create view public.library_film_theme_kinds with (security_invoker = true) as
  select w.id, w.id as item_id, case when w.collection = 'movies' then 'genre' else 'other' end as theme_kind
  from public.watchlist_items w where w.is_film;
-- Which personal collections receive a catalog's new records (the catalog id), so
-- the page never reads legacy_source.
create view public.library_collection_catalogs with (security_invoker = true) as
  select c.id, c.id as collection_id, c.legacy_source as catalog
  from public.personal_collections c where c.legacy_source in ('disney', '90day', 'sheridan');
-- How the page presents a collection it has always known (its explanatory note and the
-- device layout key it remembered before personal collections): a presentation key,
-- never used to place, govern or edit anything. Derived from legacy_source here; a
-- stored column from the contraction on.
create view public.library_collection_presentation with (security_invoker = true) as
  select c.id, c.id as collection_id, c.legacy_source as presentation_key
  from public.personal_collections c where c.legacy_source in ('disney', '90day', 'sheridan', 'truecrime');
revoke all on public.library_catalog_shows, public.library_catalog_films, public.library_film_theme_kinds,
  public.library_collection_catalogs, public.library_collection_presentation from public, anon, authenticated;
grant select on public.library_catalog_shows, public.library_catalog_films, public.library_film_theme_kinds,
  public.library_collection_catalogs, public.library_collection_presentation to anon, authenticated;

-- ── Helpers that don't depend on the phase ───────────────────────────────────
create function private.lib_catalogs() returns text[]
language sql immutable set search_path = '' as $$ select array['disney', '90day', 'sheridan']::text[] $$;

-- Marks this transaction as a supported library write (the contraction's guards
-- refuse direct writes without it). Transaction-local; only these functions set it.
-- It also takes the two library tables, in the catalog application's order, in a
-- mode that conflicts with that application's EXCLUSIVE locks (and with no other
-- write): a library write and a catalog application never interleave. Each library
-- function calls this before its checks, so whichever runs second reads the other's
-- committed records — a catalog application sees a show, film or match made just
-- before as a candidate (excluded, never adopted), and a creation sees the catalog's
-- new show or film (show_exists / film_exists), never leaving an unidentified twin.
create function private.lib_write_on() returns void
language plpgsql set search_path = '' as $$
begin
  lock table public.tv_shows, public.watchlist_items in row exclusive mode;
  perform set_config('watchlist.library_write', 'on', true);
end $$;

-- A refusal with a stable code prefix (never 40001, which the API re-runs).
create function private.lib_refuse(p_code text, p_message text) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception '%: %', p_code, p_message using errcode = 'P0001';
end $$;

-- ── Phase-dependent primitives (coexistence: storage is the source) ──────────
-- The catalog that governs a show / film, or null.
create function private.lib_show_catalog(p_show_id uuid) returns text
language sql stable set search_path = '' as $$
  select s.collection from public.tv_shows s where s.id = p_show_id and s.collection = any(private.lib_catalogs())
$$;
create function private.lib_film_catalog(p_item_id uuid) returns text
language sql stable set search_path = '' as $$
  select w.collection from public.watchlist_items w where w.id = p_item_id and w.is_film and w.collection = any(private.lib_catalogs())
$$;
-- What a film's theme means ('genre' / 'other'); null for a TV season.
create function private.lib_film_theme_kind(p_item_id uuid) returns text
language sql stable set search_path = '' as $$
  select case when not w.is_film then null when w.collection = 'movies' then 'genre' else 'other' end
  from public.watchlist_items w where w.id = p_item_id
$$;
-- Records a film's theme meaning. Coexistence: storage carries it (Movies =
-- genre), so this only checks that the request agrees with it.
create function private.lib_set_theme_kind(p_item_id uuid, p_kind text) returns void
language plpgsql set search_path = '' as $$
begin
  if p_kind is distinct from private.lib_film_theme_kind(p_item_id) then
    raise exception 'integrity_fault: theme kind % does not match where the film is stored', p_kind using errcode = '23000';
  end if;
end $$;
-- The personal collection a catalog's new records join (null: none).
create function private.lib_catalog_target(p_owner uuid, p_catalog text) returns public.personal_collections
language sql stable set search_path = '' as $$
  select * from public.personal_collections where user_id = p_owner and legacy_source = p_catalog
$$;
-- The locks a catalog application takes, canonical order (shows, items, collections).
create function private.lib_catalog_lock() returns void
language plpgsql set search_path = '' as $$
begin
  lock table public.tv_shows, public.watchlist_items in exclusive mode;
  lock table public.personal_collections in share mode;
end $$;
-- Inserts missing catalog entries (the Stage 4a logic, in the catalog's storage).
create function private.lib_catalog_insert(p_owner uuid, p_catalog text, p_defaults jsonb) returns jsonb
language sql set search_path = '' as $$ select private.catalog_insert_missing(p_owner, p_catalog, p_defaults) $$;
-- A new show row (where new shows go), or null when the unique show indexes refuse it.
create function private.lib_new_show_row(p_owner uuid, p_title text, p_key text, p_tmdb integer, p_status text) returns uuid
language plpgsql set search_path = '' as $$
declare v uuid;
begin
  insert into public.tv_shows (collection, title, show_key, tmdb_id, status)
  values ('othertv', p_title, p_key, p_tmdb, p_status)
  on conflict do nothing
  returning id into v;
  return v;
end $$;
-- Seasons for one locked show. Coexistence: the existing add_tv_seasons in the
-- show's storage; the answer must name this show and no created one.
create function private.lib_add_to_show(p_show public.tv_shows, p_network text, p_seasons jsonb, p_by_number boolean) returns jsonb
language plpgsql set search_path = '' as $$
declare v_res jsonb;
begin
  v_res := public.add_tv_seasons(p_show.collection,
    jsonb_build_object('tmdb_id', case when p_by_number then p_show.tmdb_id end, 'title', p_show.title,
                       'show_key', p_show.show_key, 'network', coalesce(p_network, '')),
    p_seasons);
  if (v_res ->> 'show_id') is distinct from p_show.id::text or coalesce((v_res ->> 'show_created')::boolean, true) then
    perform private.lib_refuse('target_changed', 'These seasons would not have been added to the show you chose, so nothing was added. Look at it again.');
  end if;
  return v_res;
end $$;
-- A new film row (where new films go), or null when a unique index refuses it.
create function private.lib_insert_film(p_owner uuid, f jsonb, p_kind text) returns uuid
language plpgsql set search_path = '' as $$
declare v uuid;
begin
  if p_kind is distinct from 'genre' then
    raise exception 'integrity_fault: new films carry genre themes' using errcode = '23000';
  end if;
  insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched, status,
    watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number)
  values ('movies', f ->> 'item_key', btrim(f ->> 'title'), 'Film', coalesce(f ->> 'theme', ''), coalesce(f ->> 'display_date', ''),
    f ->> 'date_sort', coalesce((f ->> 'watched')::boolean, false), coalesce(f ->> 'status', 'confirmed'),
    coalesce(array(select jsonb_array_elements_text(f -> 'watch_with')), '{}'),
    coalesce(array(select jsonb_array_elements_text(f -> 'collections')), '{}'),
    (f ->> 'tmdb_collection_id')::integer, f ->> 'tmdb_collection_name',
    case when f ->> 'tmdb_id' is not null then 'movie' end, (f ->> 'tmdb_id')::integer, null)
  on conflict do nothing
  returning id into v;
  return v;
end $$;
-- A TV-season Match after the checks in library_match_season. Coexistence:
-- match_tv_row in the row's storage; a TMDB show that is stored apart from the
-- row can't be joined until the contraction (refused, nothing written).
create function private.lib_match_season_core(p_row public.watchlist_items, p_target jsonb, p_patch jsonb, p_expansion jsonb) returns jsonb
language plpgsql set search_path = '' as $$
begin
  -- (A film stored with the films has a genre theme; library_match_season refuses it first.)
  if exists (select 1 from public.tv_shows where user_id = p_row.user_id and tmdb_id = (p_target ->> 'tmdb_id')::integer
             and collection is distinct from p_row.collection) then
    perform private.lib_refuse('match_conflict', 'This TMDB show is already on your list in a part this update can''t join yet, so nothing was matched.');
  end if;
  return public.match_tv_row(p_row.id, p_target, p_patch, coalesce(p_expansion, '{}'::jsonb));
end $$;

-- The row a film Match writes (identity, film fields, unlinked) and what its
-- theme means. Coexistence: storage carries the meaning (checked, not written).
create function private.lib_film_match_update(p_row_id uuid, p_patch jsonb, p_tmdb integer, p_coll_id integer, p_kind text)
returns public.watchlist_items
language plpgsql set search_path = '' as $$
declare r public.watchlist_items;
begin
  update public.watchlist_items set
    title = btrim(p_patch ->> 'title'), season = 'Film', item_key = p_patch ->> 'item_key',
    theme = coalesce(p_patch ->> 'theme', theme), display_date = coalesce(p_patch ->> 'display_date', display_date),
    date_sort = p_patch ->> 'date_sort', tmdb_collection_id = p_coll_id, tmdb_collection_name = p_patch ->> 'tmdb_collection_name',
    collections = case when p_patch ? 'collections' then coalesce(array(select jsonb_array_elements_text(p_patch -> 'collections')), '{}') else collections end,
    media_type = 'movie', tmdb_id = p_tmdb, season_number = null, show_id = null
  where id = p_row_id
  returning * into r;
  perform private.lib_set_theme_kind(r.id, p_kind);
  return r;
end $$;

-- ── stage5_capabilities ──────────────────────────────────────────────────────
create function public.stage5_capabilities() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'coexistence', 'backup_format', 3, 'recovery_archive', 'none')
$$;

-- ── Old pages: catalog_apply previews still work, applies are refused ────────
create or replace function public.catalog_apply(p_collection text, p_defaults jsonb, p_approved text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v jsonb;
begin
  perform private.tv_require_stage('catalog_apply', 'final');
  if p_approved is not null then
    raise exception 'client_outdated: Catalog updates are applied from the updated page now. Reload the page. Nothing was changed.'
      using errcode = 'P0001';
  end if;
  begin
    begin
      v := private.catalog_run(p_collection, p_defaults);
      raise exception 'catalog_preview_rollback' using errcode = 'P0001';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'catalog_preview_rollback' then raise; end if;
    end;
    return jsonb_build_object('mode', 'preview', 'document', v -> 'document', 'hash', v ->> 'hash');
  exception when lock_not_available or deadlock_detected then
    raise exception 'catalog_busy: The database was busy, so nothing was changed. Review again in a moment.' using errcode = 'P0001';
  end;
end $$;


-- ── The catalog collision rule, from the other side ─────────────────────────
-- A catalog application excludes an entry when a record it doesn't govern has the
-- entry's key or the same normalized title (lib_catalog_candidates). Symmetrically,
-- creating a record, or a Match that names or renames one, is refused when a record a
-- catalog governs has its key or the same normalized title — unless the page listed
-- that record as a different work (distinct_from). Whichever runs second therefore
-- never leaves an unacknowledged catalog twin; works the owner confirmed as distinct
-- stay possible. (The locks in lib_write_on order the two.)
create function private.lib_catalog_twins(p_owner uuid, p_kind text, p_key text, p_title text, p_distinct uuid[]) returns uuid[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(id order by id), '{}') from (
    select s.id from public.tv_shows s
    where p_kind = 'show' and s.user_id = p_owner and private.lib_show_catalog(s.id) is not null
      and (s.show_key = p_key or lower(btrim(s.title)) = lower(btrim(p_title))) and not (s.id = any(coalesce(p_distinct, '{}')))
    union
    select w.id from public.watchlist_items w
    where p_kind = 'film' and w.user_id = p_owner and w.is_film and private.lib_film_catalog(w.id) is not null
      and (w.item_key = p_key or lower(btrim(w.title)) = lower(btrim(p_title))) and not (w.id = any(coalesce(p_distinct, '{}')))
  ) x
$$;
create function private.lib_refuse_twins(p_twins uuid[], p_kind text, p_outcome text) returns void
language plpgsql set search_path = '' as $$
begin
  if cardinality(coalesce(p_twins, '{}')) = 0 then return; end if;
  raise exception 'catalog_candidate: A built-in catalog % with this name is on your list (it may be the same %), so nothing was %. Look at it again.',
    case when p_kind = 'show' then 'show' else 'film' end, case when p_kind = 'show' then 'show' else 'film' end, p_outcome
    using errcode = 'P0001', detail = jsonb_build_object('candidates', to_jsonb(p_twins))::text;
end $$;
-- The ids a request lists as different works (distinct_from), or a refusal.
create function private.lib_distinct_ids(p jsonb) returns uuid[]
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p = 'null'::jsonb then return '{}'; end if;
  if jsonb_typeof(p) <> 'array' then raise exception 'invalid_input: distinct_from must be a list of ids' using errcode = '22023'; end if;
  return coalesce(array(select (jsonb_array_elements_text(p))::uuid), '{}');
exception when invalid_text_representation then
  raise exception 'invalid_input: distinct_from must be a list of ids' using errcode = '22023';
end $$;

-- ── library_add_seasons ──────────────────────────────────────────────────────
-- Seasons for a show already on the list (Add season, a search result already on
-- the list, Refresh shows). Locks the show and refuses (nothing written) when it
-- is gone (target_missing) or no longer has the TMDB id, show key and governing
-- catalog the page showed (target_changed). An identified show that no catalog
-- governs takes TMDB seasons (season_number); a governed or unidentified show
-- takes seasons by label (a governed TMDB-matched show joins "Season N" as TMDB
-- season N; other labels are held for review). Guarantees the intended parent,
-- not exactly-once delivery: a delayed request can re-add a season that was
-- deleted (or restored away) meanwhile.
create function public.library_add_seasons(p_show_id uuid, p_expected jsonb, p_seasons jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_add_seasons', 'final');
  v_show public.tv_shows;
  v_exp_tmdb integer;
  v_catalog text;
  v_by_number boolean;
  v_has_number boolean;
  s jsonb;
begin
  if p_show_id is null or jsonb_typeof(p_expected) is distinct from 'object' or coalesce(p_expected ->> 'show_key', '') = ''
     or not (p_expected ? 'tmdb_id') or not (p_expected ? 'catalog') then
    raise exception 'invalid_input: the show id and the show as the page showed it (tmdb_id, show_key, catalog) are required'
      using errcode = '22023';
  end if;
  begin v_exp_tmdb := (p_expected ->> 'tmdb_id')::integer;
  exception when others then raise exception 'invalid_input: expected tmdb_id' using errcode = '22023'; end;
  if jsonb_typeof(p_seasons) is distinct from 'array' or jsonb_array_length(p_seasons) = 0 then
    raise exception 'invalid_input: seasons must be a non-empty list' using errcode = '22023';
  end if;
  perform private.lib_write_on();

  select * into v_show from public.tv_shows where id = p_show_id and user_id = v_owner for update;
  if not found then perform private.lib_refuse('target_missing', 'This show is no longer on your list, so nothing was added.'); end if;
  v_catalog := private.lib_show_catalog(v_show.id);
  if v_show.tmdb_id is distinct from v_exp_tmdb or v_show.show_key is distinct from p_expected ->> 'show_key'
     or v_catalog is distinct from (p_expected ->> 'catalog') then
    perform private.lib_refuse('target_changed', 'This show changed since you chose it, so nothing was added. Look at it again.');
  end if;

  v_by_number := v_show.tmdb_id is not null and v_catalog is null;
  for s in select * from jsonb_array_elements(p_seasons) loop
    v_has_number := jsonb_typeof(s) = 'object' and s ? 'season_number' and s -> 'season_number' <> 'null'::jsonb;
    if v_has_number <> v_by_number then
      raise exception 'invalid_input: this show takes %', case when v_by_number then 'TMDB seasons (season_number)' else 'seasons by label (no season_number)' end
        using errcode = '22023';
    end if;
  end loop;
  return private.lib_add_to_show(v_show, p_expected ->> 'network', p_seasons, v_by_number);
end $$;

-- ── library_create_show ──────────────────────────────────────────────────────
-- A genuinely new show with all its requested seasons, or nothing:
--   show_exists     its TMDB identity is a show anywhere in the library; or (no
--                   identity) an unmatched show with the same key exists that the
--                   page didn't confirm as a different work (p_show.distinct_from:
--                   the ids it showed); or the unique show indexes refuse it now;
--   create_conflict not every season could be added.
-- Two creations of the same unmatched key are serialized (advisory lock), so a
-- repeat or a race is refused, never a second show. Never adds to an existing show.
create function public.library_create_show(p_show jsonb, p_seasons jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_create_show', 'final');
  v_tmdb integer;
  v_title text := btrim(coalesce(p_show ->> 'title', ''));
  v_key text := btrim(coalesce(p_show ->> 'show_key', ''));
  v_init text := coalesce(p_show ->> 'initial_status', 'confirmed');
  v_distinct uuid[];
  v_id uuid;
  v_show public.tv_shows;
  v_res jsonb;
begin
  if jsonb_typeof(p_show) is distinct from 'object' then raise exception 'invalid_input: show' using errcode = '22023'; end if;
  begin
    v_tmdb := (p_show ->> 'tmdb_id')::integer;
    v_distinct := private.lib_distinct_ids(p_show -> 'distinct_from');
  exception when others then raise exception 'invalid_input: show tmdb_id / distinct_from' using errcode = '22023'; end;
  if v_title = '' or v_key = '' then raise exception 'invalid_input: show title and show_key are required' using errcode = '22023'; end if;
  if not private.tv_valid_status(v_init) then raise exception 'invalid_input: initial_status %', v_init using errcode = '22023'; end if;
  if jsonb_typeof(p_seasons) is distinct from 'array' or jsonb_array_length(p_seasons) = 0 then
    raise exception 'invalid_input: seasons must be a non-empty list' using errcode = '22023';
  end if;
  perform private.lib_write_on();

  if v_tmdb is not null then
    -- The TMDB identity is serialized with library_match_season (same lock): a Match
    -- that would take this identity commits first, or waits for this creation.
    perform pg_advisory_xact_lock(hashtext(v_owner::text || '|tvid|' || v_tmdb));
    if exists (select 1 from public.tv_shows where user_id = v_owner and tmdb_id = v_tmdb) then
      perform private.lib_refuse('show_exists', 'This show is already on your list, so nothing was added. Look at it again.');
    end if;
  else
    perform pg_advisory_xact_lock(hashtext(v_owner::text || '|tv|' || v_key));
    if exists (select 1 from public.tv_shows where user_id = v_owner and tmdb_id is null and show_key = v_key
               and not (id = any(v_distinct))) then
      perform private.lib_refuse('show_exists', 'A show with this name is already on your list, so nothing was added. Look at it again.');
    end if;
  end if;
  perform private.lib_refuse_twins(private.lib_catalog_twins(v_owner, 'show', v_key, v_title, v_distinct), 'show', 'added');
  v_id := private.lib_new_show_row(v_owner, v_title, v_key, v_tmdb, v_init);
  if v_id is null then
    perform private.lib_refuse('show_exists', 'This show is already on your list, so nothing was added. Look at it again.');
  end if;
  select * into v_show from public.tv_shows where id = v_id;
  v_res := private.lib_add_to_show(v_show, p_show ->> 'network', p_seasons, v_tmdb is not null);
  if jsonb_array_length(coalesce(v_res -> 'inserted', '[]'::jsonb)) <> jsonb_array_length(p_seasons) then
    perform private.lib_refuse('create_conflict', 'Not every season could be added to the new show, so nothing was added. Look at it again.');
  end if;
  return v_res || jsonb_build_object('show_created', true);
end $$;

-- ── Films ────────────────────────────────────────────────────────────────────
-- Validates one film as the app sends it; returns it normalized.
create function private.lib_valid_film(f jsonb, p_identified boolean) returns jsonb
language plpgsql set search_path = '' as $$
declare v_tmdb integer;
begin
  if jsonb_typeof(f) is distinct from 'object' or coalesce(btrim(f ->> 'title'), '') = '' or coalesce(f ->> 'item_key', '') not like '%|film'
     or not private.tv_valid_date(f ->> 'date_sort') or (f ? 'status' and not private.tv_valid_status(f ->> 'status'))
     or (f ? 'collections' and jsonb_typeof(f -> 'collections') is distinct from 'array')
     or (f ? 'watch_with' and jsonb_typeof(f -> 'watch_with') is distinct from 'array') then
    raise exception 'invalid_input: film %', f using errcode = '22023';
  end if;
  begin v_tmdb := (f ->> 'tmdb_id')::integer; perform (f ->> 'tmdb_collection_id')::integer;
  exception when others then raise exception 'invalid_input: film ids in %', f using errcode = '22023'; end;
  if p_identified and (v_tmdb is null or v_tmdb <= 0) then raise exception 'invalid_input: film needs a TMDB id' using errcode = '22023'; end if;
  if not p_identified and v_tmdb is not null then raise exception 'invalid_input: a film typed by hand has no TMDB id' using errcode = '22023'; end if;
  return f;
end $$;

-- TMDB films (search, collections, MCU, people), each reported on its own:
-- inserted, or existing (its TMDB identity is already a film anywhere, also when
-- added at this moment by someone else). Never changes an existing film.
create function public.library_add_films(p_films jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_add_films', 'final');
  f jsonb;
  i int := 0;
  v_id uuid;
  v_results jsonb := '[]';
  v_inserted uuid[] := '{}';
  v_twins uuid[];
begin
  if jsonb_typeof(p_films) is distinct from 'array' or jsonb_array_length(p_films) = 0 then
    raise exception 'invalid_input: films must be a non-empty list' using errcode = '22023';
  end if;
  for f in select * from jsonb_array_elements(p_films) loop perform private.lib_valid_film(f, true); end loop;
  if (select count(distinct x ->> 'tmdb_id') from jsonb_array_elements(p_films) x) <> jsonb_array_length(p_films) then
    raise exception 'invalid_input: a film is listed twice' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  for f in select * from jsonb_array_elements(p_films) loop
    select id into v_id from public.watchlist_items where user_id = v_owner and media_type = 'movie' and tmdb_id = (f ->> 'tmdb_id')::integer;
    v_twins := case when v_id is null then private.lib_catalog_twins(v_owner, 'film', f ->> 'item_key', f ->> 'title', private.lib_distinct_ids(f -> 'distinct_from')) end;
    if v_id is null and cardinality(v_twins) > 0 then
      -- A catalog film with this name: not added unless the page listed it as a different film.
      v_results := v_results || jsonb_build_object('index', i, 'outcome', 'catalog_candidate', 'candidates', to_jsonb(v_twins));
    elsif v_id is null then
      v_id := private.lib_insert_film(v_owner, f, 'genre');
      if v_id is not null then
        v_inserted := v_inserted || v_id;
        v_results := v_results || jsonb_build_object('index', i, 'outcome', 'inserted', 'id', v_id);
      else
        select id into v_id from public.watchlist_items where user_id = v_owner and media_type = 'movie' and tmdb_id = (f ->> 'tmdb_id')::integer;
        v_results := v_results || jsonb_build_object('index', i, 'outcome', 'existing', 'id', v_id);
      end if;
    else
      v_results := v_results || jsonb_build_object('index', i, 'outcome', 'existing', 'id', v_id);
    end if;
    i := i + 1;
  end loop;
  return jsonb_build_object('results', v_results,
    'inserted', coalesce((select jsonb_agg(to_jsonb(w) - 'is_film' order by w.date_sort, w.id) from public.watchlist_items w where w.id = any(v_inserted)), '[]'));
end $$;

-- A film typed by hand (no TMDB identity). An unmatched film with the same key
-- that the page didn't confirm as a different film (p_film.distinct_from) refuses
-- it (film_exists); creations of the same key are serialized.
create function public.library_create_film(p_film jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_create_film', 'final');
  v_distinct uuid[];
  v_id uuid;
begin
  perform private.lib_valid_film(p_film, false);
  v_distinct := private.lib_distinct_ids(p_film -> 'distinct_from');
  perform private.lib_write_on();
  perform pg_advisory_xact_lock(hashtext(v_owner::text || '|film|' || (p_film ->> 'item_key')));
  if exists (select 1 from public.watchlist_items where user_id = v_owner and is_film and tmdb_id is null
             and item_key = p_film ->> 'item_key' and not (id = any(v_distinct))) then
    perform private.lib_refuse('film_exists', 'A film with this name is already on your list, so nothing was added. Look at it again.');
  end if;
  perform private.lib_refuse_twins(private.lib_catalog_twins(v_owner, 'film', p_film ->> 'item_key', p_film ->> 'title', v_distinct), 'film', 'added');
  v_id := private.lib_insert_film(v_owner, p_film, 'genre');
  if v_id is null then
    perform private.lib_refuse('film_exists', 'A film with this name is already on your list, so nothing was added. Look at it again.');
  end if;
  return jsonb_build_object('id', v_id, 'row', (select to_jsonb(w) - 'is_film' from public.watchlist_items w where w.id = v_id));
end $$;

-- ── Match ────────────────────────────────────────────────────────────────────
-- Only an unidentified row that no catalog governs (a film's own catalog, a
-- season's show's) may be matched: the same rule as before, enforced here.
create function private.lib_match_row(p_owner uuid, p_row_id uuid) returns public.watchlist_items
language plpgsql set search_path = '' as $$
declare r public.watchlist_items;
begin
  select * into r from public.watchlist_items
  where id = p_row_id and user_id = p_owner and tmdb_id is null and media_type is null and season_number is null;
  if r.id is null then raise exception 'not_found: unidentified row' using errcode = 'P0002'; end if;
  if (r.is_film and private.lib_film_catalog(r.id) is not null)
     or (r.show_id is not null and private.lib_show_catalog(r.show_id) is not null) then
    perform private.lib_refuse('not_eligible', 'Entries of a built-in catalog can''t be matched to TMDB here. Nothing was changed.');
  end if;
  return r;
end $$;

-- A row matched as a TV season (the match_tv_row contract: conflicts, the status
-- block, the collection-expansion confirmation). A TMDB show that a catalog
-- governs is refused (match_target_governed): the row and all its state stay
-- untouched, and nothing is joined.
create function public.library_match_season(p_row_id uuid, p_target jsonb, p_patch jsonb, p_expansion jsonb default '{}'::jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_match_season', 'final');
  r public.watchlist_items;
  v_tmdb integer;
  v_t uuid;
begin
  begin v_tmdb := (p_target ->> 'tmdb_id')::integer;
  exception when others then raise exception 'invalid_input: tmdb_id' using errcode = '22023'; end;
  if v_tmdb is null then raise exception 'invalid_input: tmdb_id' using errcode = '22023'; end if;
  perform private.lib_write_on();
  -- The TMDB identity is serialized with library_create_show and other Matches (same
  -- lock), before any check reads the target: a concurrent creation or Match of this
  -- identity commits first and is then resolved here as the existing target (joined,
  -- or refused by the usual status / governance / conflict / confirmation rules), so
  -- this row's show is never renamed onto, nor a second show created for, an identity
  -- that is being created meanwhile.
  perform pg_advisory_xact_lock(hashtext(v_owner::text || '|tvid|' || v_tmdb));
  r := private.lib_match_row(v_owner, p_row_id);
  -- A film whose theme is a genre stays a film (as before Stage 5: only rows kept with TV could become seasons).
  if r.is_film and private.lib_film_theme_kind(r.id) = 'genre' then
    perform private.lib_refuse('genre_film_season', 'A film whose theme is a genre can''t be matched to a TV season. Nothing was changed.');
  end if;
  select id into v_t from public.tv_shows where user_id = v_owner and tmdb_id = v_tmdb;
  if v_t is not null and private.lib_show_catalog(v_t) is not null then
    perform private.lib_refuse('match_target_governed', 'This TMDB show is part of a built-in catalog on your list, so this row wasn''t matched to it. Nothing was changed.');
  end if;
  -- No show has this identity yet: the match names a show (a new one, or this row's show renamed).
  if v_t is null then
    perform private.lib_refuse_twins(private.lib_catalog_twins(v_owner, 'show', lower(btrim(coalesce(p_patch ->> 'title', ''))), p_patch ->> 'title',
      private.lib_distinct_ids(p_patch -> 'distinct_from')), 'show', 'matched');
  end if;
  return private.lib_match_season_core(r, p_target, p_patch - 'distinct_from', p_expansion);
end $$;

-- A row matched as a film, in one transaction: the identity is set, a season
-- leaves its show (whose collections it keeps, archived ones included), and a
-- show left with no seasons is removed. p_expected: {show_id} as the page showed
-- the row. Refusals: not_found, not_eligible, match_conflict (the row changed, or
-- the film's TMDB identity is already on the list). Nothing partial.
create function public.library_match_film(p_row_id uuid, p_expected jsonb, p_patch jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_distinct uuid[] := private.lib_distinct_ids(p_patch -> 'distinct_from');
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_match_film', 'final');
  r public.watchlist_items;
  v_tmdb integer;
  v_coll_id integer;
  v_former uuid;
  v_kind text;
  v_carried int := 0;
  v_deleted boolean := false;
begin
  perform set_config('lock_timeout', '5s', true);
  p_patch := p_patch - 'distinct_from'; -- (the acknowledgement isn't part of the row)
  begin
    v_tmdb := (p_patch ->> 'tmdb_id')::integer;
    v_coll_id := (p_patch ->> 'tmdb_collection_id')::integer;
  exception when others then raise exception 'invalid_input: match patch ids' using errcode = '22023'; end;
  if jsonb_typeof(p_expected) is distinct from 'object' or not (p_expected ? 'show_id')
     or jsonb_typeof(p_patch) is distinct from 'object' or v_tmdb is null or v_tmdb <= 0
     or p_patch ->> 'media_type' is distinct from 'movie' or p_patch ->> 'season' is distinct from 'Film'
     or coalesce(btrim(p_patch ->> 'title'), '') = ''
     or p_patch ->> 'item_key' is distinct from lower(btrim(p_patch ->> 'title')) || '|film'
     or (p_patch ? 'season_number' and p_patch -> 'season_number' <> 'null'::jsonb)
     or not private.tv_valid_date(p_patch ->> 'date_sort')
     or (p_patch ? 'collections' and jsonb_typeof(p_patch -> 'collections') is distinct from 'array') then
    raise exception 'invalid_input: match patch %', p_patch using errcode = '22023';
  end if;
  perform private.lib_write_on();
  r := private.lib_match_row(v_owner, p_row_id);
  if r.show_id is distinct from (p_expected ->> 'show_id')::uuid then
    perform private.lib_refuse('match_conflict', 'This row changed somewhere else before the match was saved, so nothing was matched.');
  end if;
  v_former := r.show_id;
  -- Lock order as everywhere: the show, then the row.
  if v_former is not null then perform 1 from public.tv_shows where id = v_former for update; end if;
  select * into r from public.watchlist_items
  where id = r.id and tmdb_id is null and media_type is null and season_number is null and show_id is not distinct from v_former for update;
  if r.id is null then
    perform private.lib_refuse('match_conflict', 'This row changed somewhere else before the match was saved, so nothing was matched.');
  end if;
  if exists (select 1 from public.watchlist_items where user_id = v_owner and media_type = 'movie' and tmdb_id = v_tmdb) then
    perform private.lib_refuse('match_conflict', 'This TMDB film is already on your list, so nothing was matched.');
  end if;
  perform private.lib_refuse_twins(array(select x from unnest(private.lib_catalog_twins(v_owner, 'film', p_patch ->> 'item_key', p_patch ->> 'title', v_distinct)) x
    where x <> r.id), 'film', 'matched');
  -- A film keeps what its theme means; a season becomes a film whose theme is a company name.
  v_kind := case when r.is_film then private.lib_film_theme_kind(r.id) else 'other' end;

  r := private.lib_film_match_update(r.id, p_patch, v_tmdb, v_coll_id, v_kind);

  if v_former is not null then
    insert into public.collection_memberships (collection_id, item_id)
    select m.collection_id, r.id from public.collection_memberships m where m.show_id = v_former
    on conflict (collection_id, item_id) where (item_id is not null) do nothing;
    select count(*) into v_carried from public.collection_memberships m
    where m.item_id = r.id and m.collection_id in (select collection_id from public.collection_memberships where show_id = v_former);
    if not exists (select 1 from public.watchlist_items where show_id = v_former) then
      delete from public.tv_shows where id = v_former;
      v_deleted := true;
    end if;
  end if;
  return jsonb_build_object('row', to_jsonb(r) - 'is_film', 'former_show_id', v_former, 'former_show_deleted', v_deleted,
    'memberships_carried', v_carried);
end $$;

-- ── Catalog application (effects document 5.1) ───────────────────────────────
-- Unmatched-or-governed candidates for a catalog entry that would be created: a
-- show / film this catalog doesn't govern whose key or (normalized) title is the
-- same. Any candidate excludes the entry for review (never adopted, merged,
-- re-governed or duplicated).
create function private.lib_catalog_candidates(p_owner uuid, p_catalog text, p_kind text, p_key text, p_title text) returns uuid[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(id order by id), '{}') from (
    select s.id from public.tv_shows s
    where p_kind = 'show' and s.user_id = p_owner and coalesce(private.lib_show_catalog(s.id), '') <> p_catalog
      and (s.show_key = p_key or lower(btrim(s.title)) = lower(btrim(p_title)))
    union
    select w.id from public.watchlist_items w
    where p_kind = 'film' and w.user_id = p_owner and w.is_film and coalesce(private.lib_film_catalog(w.id), '') <> p_catalog
      and (w.item_key = p_key or lower(btrim(w.title)) = lower(btrim(p_title)))
  ) x
$$;

-- One application, steps S1–S7 as in Stage 4a, on what the catalog governs, with
-- the collision rule. Returns {document, hash, receipt}.
create function private.catalog_run5(p_catalog text, p_defaults jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  d jsonb;
  g record;
  v_keys text[] := '{}';
  v_payload_hash text;
  v_rows uuid[];
  v_missing jsonb;
  v_keep jsonb := '[]';
  v_excluded jsonb := '[]';
  v_cands uuid[];
  v_pre_status jsonb;
  v_fills jsonb := '[]';
  f jsonb;
  r public.watchlist_items;
  v_ins jsonb;
  v_target public.personal_collections;
  v_rows_before int; v_shows_before int;
  v_entries jsonb := '[]';
  v_receipt jsonb := '{}';
  v_refs jsonb := '{}';
  v_n int := 0;
  v_m int := 0;
  v_mem_id uuid;
  v_doc jsonb;
  x record;
begin
  -- S1: locks, canonical order, before any read.
  perform set_config('lock_timeout', '2s', true);
  begin
    perform private.lib_catalog_lock();
  exception when lock_not_available or deadlock_detected then
    raise exception 'catalog_busy: The database was busy, so nothing was changed. Review again in a moment.' using errcode = 'P0001';
  end;

  -- S2: the payload and its hash.
  if p_catalog is null or not (p_catalog = any(private.lib_catalogs())) then
    raise exception 'invalid_input: % is not a built-in catalog', p_catalog using errcode = '22023';
  end if;
  if jsonb_typeof(p_defaults) is distinct from 'array' then raise exception 'invalid_input: defaults must be a list' using errcode = '22023'; end if;
  for d in select * from jsonb_array_elements(p_defaults) loop
    if jsonb_typeof(d) is distinct from 'object' or coalesce(d ->> 'k', '') not like '%|%' or coalesce(btrim(d ->> 't'), '') = ''
       or coalesce(btrim(d ->> 's'), '') = '' or not private.tv_valid_date(d ->> 'ds')
       or (d ? 'p' and jsonb_typeof(d -> 'p') <> 'boolean') then
      raise exception 'invalid_input: default %', d using errcode = '22023';
    end if;
    if (d ->> 'k') = any(v_keys) then raise exception 'invalid_input: default % listed twice', d ->> 'k' using errcode = '22023'; end if;
    v_keys := v_keys || (d ->> 'k');
  end loop;
  v_payload_hash := private.catalog_hash(p_defaults);
  perform private.lib_write_on();

  -- State before any write, read under the locks: what this catalog governs.
  select coalesce(jsonb_object_agg(id::text, status), '{}') into v_pre_status
  from public.tv_shows where user_id = v_owner and private.lib_show_catalog(id) = p_catalog;
  select coalesce(array_agg(w.id), '{}') into v_rows from public.watchlist_items w
  where w.user_id = v_owner and ((w.show_id is not null and private.lib_show_catalog(w.show_id) = p_catalog)
                                 or (w.is_film and private.lib_film_catalog(w.id) = p_catalog));
  select count(*) into v_rows_before from public.watchlist_items where user_id = v_owner;
  select count(*) into v_shows_before from public.tv_shows where user_id = v_owner;
  v_target := private.lib_catalog_target(v_owner, p_catalog);
  select coalesce(jsonb_agg(jsonb_build_object('row_id', w.id, 'item_key', w.item_key, 'is_film', w.is_film, 'show_id', w.show_id,
           'old_display', w.display_date, 'old_sort', w.date_sort, 'new_display', e.value ->> 'd', 'new_sort', e.value ->> 'ds',
           'watched', w.watched, 'skipped', w.skipped, 'status', w.status) order by w.id), '[]')
    into v_fills
  from public.watchlist_items w join jsonb_array_elements(p_defaults) e on e.value ->> 'k' = w.item_key
  where w.id = any(v_rows) and w.display_date ~* 'tba' and (e.value ->> 'd') !~* 'tba';

  -- S3: inserts. Defaults whose key no record of this catalog holds; an entry
  -- that would create a record with any candidate elsewhere is excluded.
  select coalesce(jsonb_agg(e.value order by e.ordinality), '[]') into v_missing
  from jsonb_array_elements(p_defaults) with ordinality e
  where not exists (select 1 from public.watchlist_items w where w.id = any(v_rows) and w.item_key = e.value ->> 'k');
  for g in
    with defs as (
      select e.value as def, e.ordinality as ord, private.tv_show_key(p_catalog, e.value ->> 'k') as show_key
      from jsonb_array_elements(v_missing) with ordinality e where e.value ->> 's' <> 'Film')
    select defs.show_key,
           coalesce((select dd.def ->> 't' from defs dd where dd.show_key = defs.show_key and split_part(dd.def ->> 'k', '|', 1) = defs.show_key order by dd.ord limit 1),
                    (select dd.def ->> 't' from defs dd where dd.show_key = defs.show_key order by dd.ord limit 1)) as title,
           jsonb_agg(defs.def order by defs.ord) as defs
    from defs group by defs.show_key
  loop
    if exists (select 1 from public.tv_shows s where s.user_id = v_owner and s.show_key = g.show_key
               and private.lib_show_catalog(s.id) = p_catalog) then
      v_keep := v_keep || g.defs;
      continue;
    end if;
    v_cands := private.lib_catalog_candidates(v_owner, p_catalog, 'show', g.show_key, g.title);
    if cardinality(v_cands) = 0 then v_keep := v_keep || g.defs; continue; end if;
    for d in select * from jsonb_array_elements(g.defs) loop
      v_excluded := v_excluded || jsonb_build_object('item_key', d ->> 'k', 'reason', case when cardinality(v_cands) > 1 then 'ambiguous' else 'existing_record' end,
        'candidates', to_jsonb(v_cands));
    end loop;
  end loop;
  for d in select * from jsonb_array_elements(v_missing) loop
    if d ->> 's' <> 'Film' then continue; end if;
    v_cands := private.lib_catalog_candidates(v_owner, p_catalog, 'film', d ->> 'k', d ->> 't');
    if cardinality(v_cands) = 0 then v_keep := v_keep || jsonb_build_array(d); continue; end if;
    v_excluded := v_excluded || jsonb_build_object('item_key', d ->> 'k', 'reason', case when cardinality(v_cands) > 1 then 'ambiguous' else 'existing_record' end,
      'candidates', to_jsonb(v_cands));
  end loop;
  -- Keep the catalog's own order for the inserts.
  select coalesce(jsonb_agg(e.value order by e.ordinality), '[]') into v_keep
  from jsonb_array_elements(v_missing) with ordinality e
  where exists (select 1 from jsonb_array_elements(v_keep) k where k ->> 'k' = e.value ->> 'k');
  v_ins := private.lib_catalog_insert(v_owner, p_catalog, v_keep);

  -- S4: date fills, each guarded by the old value; the date-write setting is on
  -- only around these statements.
  perform set_config('watchlist.catalog_date_write', 'on', true);
  for f in select * from jsonb_array_elements(v_fills) loop
    r := null;
    update public.watchlist_items set display_date = f ->> 'new_display', date_sort = f ->> 'new_sort'
    where id = (f ->> 'row_id')::uuid and display_date = f ->> 'old_display' and date_sort = f ->> 'old_sort'
    returning * into r;
    if r.id is null then
      perform set_config('watchlist.catalog_date_write', '', true);
      raise exception 'integrity_fault: date fill of % found a different value under lock', f ->> 'row_id' using errcode = '23000';
    end if;
  end loop;
  perform set_config('watchlist.catalog_date_write', '', true);

  -- Symbolic references for new records: shows by show_key, films by item_key.
  for x in select s.id, s.show_key from public.tv_shows s
           where s.id = any(array(select jsonb_array_elements_text(v_ins -> 'created_shows')::uuid)) order by s.show_key collate "C", s.id loop
    v_n := v_n + 1;
    v_refs := v_refs || jsonb_build_object(x.id::text, 'S' || v_n);
  end loop;
  for x in select w.id, w.item_key from public.watchlist_items w
           where w.id = any(array(select jsonb_array_elements_text(v_ins -> 'inserted')::uuid)) and w.is_film
           order by w.item_key collate "C", w.id loop
    v_m := v_m + 1;
    v_refs := v_refs || jsonb_build_object(x.id::text, 'F' || v_m);
  end loop;

  -- Entries (no generated ids for new records) and the receipt.
  for x in select s.* from public.tv_shows s where (v_refs ? s.id::text) loop
    v_entries := v_entries || jsonb_build_object('kind', 'create_show', 'key', 'create_show:' || (v_refs ->> x.id::text),
      'ref', v_refs ->> x.id::text, 'show_key', x.show_key, 'title', x.title, 'tmdb_id', x.tmdb_id, 'initial_status', x.status);
    v_receipt := v_receipt || jsonb_build_object('create_show:' || (v_refs ->> x.id::text), jsonb_build_object('show_id', x.id));
  end loop;
  for x in select distinct s.id, s.show_key from public.watchlist_items w join public.tv_shows s on s.id = w.show_id
           where w.id = any(array(select jsonb_array_elements_text(v_ins -> 'inserted')::uuid)) and not (v_refs ? s.id::text) loop
    v_entries := v_entries || jsonb_build_object('kind', 'attach', 'key', 'attach:' || x.id, 'show_id', x.id, 'show_key', x.show_key,
      'status', v_pre_status ->> x.id::text);
  end loop;
  for x in select w.*, s.show_key from public.watchlist_items w left join public.tv_shows s on s.id = w.show_id
           where w.id = any(array(select jsonb_array_elements_text(v_ins -> 'inserted')::uuid)) loop
    if x.is_film then
      v_entries := v_entries || jsonb_build_object('kind', 'insert_film', 'key', 'insert_film:' || (v_refs ->> x.id::text),
        'ref', v_refs ->> x.id::text, 'item_key', x.item_key, 'title', x.title, 'season', x.season, 'theme', x.theme,
        'display_date', x.display_date, 'date_sort', x.date_sort, 'status', x.status, 'watched', x.watched,
        'media_type', x.media_type, 'tmdb_id', x.tmdb_id);
      v_receipt := v_receipt || jsonb_build_object('insert_film:' || (v_refs ->> x.id::text), jsonb_build_object('row_id', x.id));
    else
      v_entries := v_entries || jsonb_build_object('kind', 'insert_season', 'key', 'insert_season:' || x.show_key || '|' || x.item_key,
        'show', coalesce(v_refs ->> x.show_id::text, x.show_id::text), 'item_key', x.item_key, 'title', x.title, 'season', x.season,
        'theme', x.theme, 'display_date', x.display_date, 'date_sort', x.date_sort, 'status', x.status, 'watched', x.watched,
        'skipped', x.skipped, 'media_type', x.media_type, 'tmdb_id', x.tmdb_id, 'season_number', x.season_number);
      v_receipt := v_receipt || jsonb_build_object('insert_season:' || x.show_key || '|' || x.item_key,
        jsonb_build_object('row_id', x.id, 'show_id', x.show_id));
    end if;
  end loop;
  for f in select * from jsonb_array_elements(v_fills) loop
    v_entries := v_entries || jsonb_build_object('kind', 'fill_date', 'key', 'fill_date:' || (f ->> 'row_id'),
      'row_id', f -> 'row_id', 'item_key', f -> 'item_key', 'item', case when (f ->> 'is_film')::boolean then 'film' else 'season' end,
      'show_id', f -> 'show_id',
      'old_display', f -> 'old_display', 'old_sort', f -> 'old_sort', 'new_display', f -> 'new_display', 'new_sort', f -> 'new_sort',
      'tracking', case when (f ->> 'is_film')::boolean
                       then jsonb_build_object('watched', f -> 'watched', 'status', f -> 'status')
                       else jsonb_build_object('watched', f -> 'watched', 'skipped', f -> 'skipped',
                                               'show_status', v_pre_status -> (f ->> 'show_id')) end);
    v_receipt := v_receipt || jsonb_build_object('fill_date:' || (f ->> 'row_id'), jsonb_build_object('row_id', f -> 'row_id'));
  end loop;
  for x in select s.id, (select min(w.item_key collate "C") from public.watchlist_items w
                          where w.show_id = s.id and w.id = any(array(select jsonb_array_elements_text(v_ins -> 'inserted')::uuid))) cause
           from public.tv_shows s where s.id = any(array(select jsonb_array_elements_text(v_ins -> 'reopened')::uuid)) loop
    v_entries := v_entries || jsonb_build_object('kind', 'reopen', 'key', 'reopen:' || x.id, 'show_id', x.id,
      'from', v_pre_status ->> x.id::text, 'to', 'confirmed', 'cause', x.cause);
    v_receipt := v_receipt || jsonb_build_object('reopen:' || x.id, jsonb_build_object('show_id', x.id));
  end loop;

  -- S6: memberships of the records created here, written explicitly: they join
  -- the catalog's collection unless it is archived (then they don't).
  for x in select key as id, value #>> '{}' as ref from jsonb_each(v_refs) order by value #>> '{}' collate "C" loop
    v_mem_id := null;
    if v_target.id is not null and v_target.archived_at is not null then
      delete from public.collection_memberships
      where collection_id = v_target.id and (show_id = x.id::uuid or item_id = x.id::uuid);
    elsif v_target.id is not null then
      if left(x.ref, 1) = 'S' then
        insert into public.collection_memberships (collection_id, show_id) values (v_target.id, x.id::uuid)
        on conflict (collection_id, show_id) where (show_id is not null) do nothing;
      else
        insert into public.collection_memberships (collection_id, item_id) values (v_target.id, x.id::uuid)
        on conflict (collection_id, item_id) where (item_id is not null) do nothing;
      end if;
      select id into v_mem_id from public.collection_memberships
      where collection_id = v_target.id and (show_id = x.id::uuid or item_id = x.id::uuid);
    end if;
    v_entries := v_entries || jsonb_build_object('kind', 'membership', 'key', 'membership:' || x.ref, 'ref', x.ref,
      'collection_id', v_target.id, 'archived', v_target.archived_at is not null,
      'result', case when v_target.id is null then 'no_collection' when v_target.archived_at is not null then 'not_joined' else 'joined' end);
    v_receipt := v_receipt || jsonb_build_object('membership:' || x.ref,
      jsonb_build_object('membership_id', case when v_mem_id is null then to_jsonb('none'::text) else to_jsonb(v_mem_id) end));
  end loop;

  -- Conflicts (excluded from the approved subset) and no-ops.
  for f in select * from jsonb_array_elements(v_ins -> 'conflicts') loop
    v_entries := v_entries || jsonb_build_object('kind', 'excluded_conflict', 'key', 'excluded_conflict:' || (f ->> 'item_key'),
      'item_key', f -> 'item_key', 'reason', f -> 'reason', 'conflicting_id', coalesce(f -> 'conflicting_row_id', f -> 'row_id', 'null'::jsonb));
  end loop;
  for f in select * from jsonb_array_elements(v_excluded) loop
    v_entries := v_entries || jsonb_build_object('kind', 'excluded_conflict', 'key', 'excluded_conflict:' || (f ->> 'item_key'),
      'item_key', f -> 'item_key', 'reason', f -> 'reason', 'candidates', f -> 'candidates');
  end loop;
  for d in select * from jsonb_array_elements(p_defaults) loop
    if exists (select 1 from jsonb_array_elements(v_entries) e
               where e ->> 'item_key' = d ->> 'k' and e ->> 'kind' in ('insert_season', 'insert_film', 'fill_date', 'excluded_conflict')) then
      continue;
    end if;
    v_entries := v_entries || jsonb_build_object('kind', 'noop', 'key', 'noop:' || (d ->> 'k'), 'item_key', d -> 'k',
      'category', case when exists (select 1 from public.watchlist_items w where w.id = any(v_rows)
                                     and w.item_key = d ->> 'k' and w.tmdb_id is not null)
                            or exists (select 1 from jsonb_array_elements(v_ins -> 'identified') i where i ->> 'item_key' = d ->> 'k')
                       then 'identified' else 'present' end);
  end loop;

  -- S7: post-conditions.
  if (select count(*) from public.watchlist_items where user_id = v_owner) <> v_rows_before + jsonb_array_length(v_ins -> 'inserted')
     or (select count(*) from public.tv_shows where user_id = v_owner) <> v_shows_before + jsonb_array_length(v_ins -> 'created_shows') then
    raise exception 'integrity_fault: unexpected row count after the catalog application' using errcode = '23000';
  end if;
  if exists (select 1 from public.watchlist_items w
             where w.id = any(array(select jsonb_array_elements_text(v_ins -> 'inserted')::uuid))
               and ((w.is_film and w.show_id is not null) or (not w.is_film and w.show_id is null))) then
    raise exception 'integrity_fault: an inserted row is linked wrongly' using errcode = '23000';
  end if;
  if exists (select 1 from jsonb_each(v_refs) rf
             where (select count(*) from public.collection_memberships m where m.show_id = rf.key::uuid or m.item_id = rf.key::uuid)
                   <> case when v_target.id is not null and v_target.archived_at is null then 1 else 0 end) then
    raise exception 'integrity_fault: a new record has an unexpected membership' using errcode = '23000';
  end if;
  if exists (select 1 from jsonb_each(v_refs) rf
             where coalesce(private.lib_show_catalog(rf.key::uuid), private.lib_film_catalog(rf.key::uuid)) is distinct from p_catalog) then
    raise exception 'integrity_fault: a new record is not governed by its catalog' using errcode = '23000';
  end if;
  if exists (select 1 from jsonb_array_elements(v_fills) ff join public.watchlist_items w on w.id = (ff ->> 'row_id')::uuid
             where w.display_date is distinct from ff ->> 'new_display' or w.date_sort is distinct from ff ->> 'new_sort') then
    raise exception 'integrity_fault: a date fill did not hold' using errcode = '23000';
  end if;

  select coalesce(jsonb_agg(e order by case e ->> 'kind' when 'create_show' then 1 when 'attach' then 2 when 'insert_season' then 3
                    when 'insert_film' then 4 when 'fill_date' then 5 when 'reopen' then 6 when 'membership' then 7
                    when 'excluded_conflict' then 8 else 9 end, e ->> 'key' collate "C"), '[]')
    into v_entries from jsonb_array_elements(v_entries) e;
  v_doc := jsonb_build_object('version', '5.1', 'owner', v_owner, 'catalog', p_catalog, 'payload_hash', v_payload_hash,
    'target', case when v_target.id is null then null else jsonb_build_object('collection_id', v_target.id, 'archived', v_target.archived_at is not null) end,
    'entries', v_entries);
  return jsonb_build_object('document', v_doc, 'hash', private.catalog_hash(v_doc), 'receipt', v_receipt);
end $$;

-- Preview (p_approved null): the whole application in a block that is always
-- rolled back; {mode: 'preview', document, hash}. Apply: the same steps, kept
-- only if the hash of the effects actually performed equals p_approved
-- (catalog_stale otherwise, nothing written); {mode: 'applied', …, receipt}.
create function public.library_catalog_apply(p_catalog text, p_defaults jsonb, p_approved text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v jsonb;
begin
  perform private.tv_require_stage('library_catalog_apply', 'final');
  begin
    if p_approved is null then
      begin
        v := private.catalog_run5(p_catalog, p_defaults);
        raise exception 'catalog_preview_rollback' using errcode = 'P0001';
      exception when sqlstate 'P0001' then
        if sqlerrm <> 'catalog_preview_rollback' then raise; end if;
      end;
      return jsonb_build_object('mode', 'preview', 'document', v -> 'document', 'hash', v ->> 'hash');
    end if;
    v := private.catalog_run5(p_catalog, p_defaults);
  exception when lock_not_available or deadlock_detected then
    raise exception 'catalog_busy: The database was busy, so nothing was changed. Review again in a moment.' using errcode = 'P0001';
  end;
  if v ->> 'hash' is distinct from p_approved then
    raise exception 'catalog_stale: Your library or the catalog changed since this preview, so nothing was changed. Review again.'
      using errcode = 'P0001', detail = jsonb_build_object('hash', v ->> 'hash')::text;
  end if;
  return jsonb_build_object('mode', 'applied', 'document', v -> 'document', 'hash', v ->> 'hash', 'receipt', v -> 'receipt',
    'applied_at', now());
end $$;

-- ── Permissions ──────────────────────────────────────────────────────────────
revoke all on function
  private.lib_catalogs(), private.lib_write_on(), private.lib_refuse(text, text), private.lib_show_catalog(uuid),
  private.lib_film_catalog(uuid), private.lib_film_theme_kind(uuid), private.lib_set_theme_kind(uuid, text),
  private.lib_catalog_target(uuid, text), private.lib_catalog_lock(), private.lib_catalog_insert(uuid, text, jsonb),
  private.lib_new_show_row(uuid, text, text, integer, text), private.lib_add_to_show(public.tv_shows, text, jsonb, boolean),
  private.lib_insert_film(uuid, jsonb, text), private.lib_match_season_core(public.watchlist_items, jsonb, jsonb, jsonb),
  private.lib_valid_film(jsonb, boolean), private.lib_match_row(uuid, uuid), private.lib_catalog_candidates(uuid, text, text, text, text),
  private.lib_film_match_update(uuid, jsonb, integer, integer, text),
  private.lib_catalog_twins(uuid, text, text, text, uuid[]), private.lib_refuse_twins(uuid[], text, text), private.lib_distinct_ids(jsonb),
  private.catalog_run5(text, jsonb),
  public.stage5_capabilities(), public.library_add_seasons(uuid, jsonb, jsonb), public.library_create_show(jsonb, jsonb),
  public.library_add_films(jsonb), public.library_create_film(jsonb), public.library_match_season(uuid, jsonb, jsonb, jsonb),
  public.library_match_film(uuid, jsonb, jsonb), public.library_catalog_apply(text, jsonb, text)
from public;
grant execute on function
  private.lib_catalogs(), private.lib_write_on(), private.lib_refuse(text, text), private.lib_show_catalog(uuid),
  private.lib_film_catalog(uuid), private.lib_film_theme_kind(uuid), private.lib_set_theme_kind(uuid, text),
  private.lib_catalog_target(uuid, text), private.lib_catalog_lock(), private.lib_catalog_insert(uuid, text, jsonb),
  private.lib_new_show_row(uuid, text, text, integer, text), private.lib_add_to_show(public.tv_shows, text, jsonb, boolean),
  private.lib_insert_film(uuid, jsonb, text), private.lib_match_season_core(public.watchlist_items, jsonb, jsonb, jsonb),
  private.lib_valid_film(jsonb, boolean), private.lib_match_row(uuid, uuid), private.lib_catalog_candidates(uuid, text, text, text, text),
  private.lib_film_match_update(uuid, jsonb, integer, integer, text),
  private.lib_catalog_twins(uuid, text, text, text, uuid[]), private.lib_refuse_twins(uuid[], text, text), private.lib_distinct_ids(jsonb),
  private.catalog_run5(text, jsonb),
  public.stage5_capabilities(), public.library_add_seasons(uuid, jsonb, jsonb), public.library_create_show(jsonb, jsonb),
  public.library_add_films(jsonb), public.library_create_film(jsonb), public.library_match_season(uuid, jsonb, jsonb, jsonb),
  public.library_match_film(uuid, jsonb, jsonb), public.library_catalog_apply(text, jsonb, text)
to anon, authenticated;

-- ── Verify before commit: no row changed ─────────────────────────────────────
do $$
declare b record; a record;
begin
  select * into b from phase5a_before;
  select
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watchlist_items t) w,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t) s,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.collection_memberships t) m,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.personal_collections t) p
  into a;
  if a is distinct from b then raise exception 'phase5a: data changed during the migration'; end if;
  if (select count(*) from public.library_catalog_shows) <> (select count(*) from public.tv_shows where collection in ('disney', '90day', 'sheridan'))
     or (select count(*) from public.library_catalog_films) <> (select count(*) from public.watchlist_items where is_film and collection in ('disney', '90day', 'sheridan')) then
    raise exception 'phase5a: governance views disagree with storage';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
