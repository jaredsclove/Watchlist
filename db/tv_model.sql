-- TV-show model in the database (installed in Phase 1c, re-runnable).
-- The rules mirror tests/tv-model-reference.js and are checked against the same
-- cases (tests/fixtures/tv-model-cases.json) by tools/db-rehearsal.mjs.
--
-- Helpers run with the caller's permissions and are reachable only from other
-- functions (the private schema is not exposed by the API). The two admin
-- functions at the end are for the SQL Editor only.

-- ── Shared configuration ─────────────────────────────────────────────────────
-- The TV collections (COLLECTIONS with mediaType 'tv' in config.js).
create or replace function private.tv_collections() returns text[]
language sql immutable set search_path = '' as $$
  select array['disney', '90day', 'sheridan', 'othertv', 'truecrime']::text[]
$$;

-- A TV season row (isTvViewRow in derived-views.js): a TV collection, and either
-- media_type 'tv' or a legacy row that isn't a film.
create or replace function private.tv_is_tv_row(p_collection text, p_media_type text, p_season text) returns boolean
language sql immutable set search_path = '' as $$
  -- Never null, so "not tv_is_tv_row(...)" is safe for legacy rows (media_type null).
  select coalesce(p_collection = any(private.tv_collections()), false)
     and (coalesce(p_media_type = 'tv', false) or (p_media_type is null and coalesce(p_season, '') <> 'Film'))
$$;

-- Reviewed show-key overrides: collection + item_key prefix → show key. Must
-- equal SHOW_KEY_OVERRIDES in config.js (checked by tools/db-rehearsal.mjs).
create or replace function private.tv_show_key_override(p_collection text, p_prefix text) returns text
language sql immutable set search_path = '' as $$
  select v.show_key
  from (values ('disney', 'the clone wars', 'star wars: the clone wars (2008)')) as v(collection, prefix, show_key)
  where v.collection = p_collection and v.prefix = p_prefix
$$;

-- A legacy show's key: the item_key prefix, unless a reviewed override applies.
create or replace function private.tv_show_key(p_collection text, p_item_key text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(private.tv_show_key_override(p_collection, split_part(coalesce(p_item_key, ''), '|', 1)),
                  split_part(coalesce(p_item_key, ''), '|', 1))
$$;

-- ── Season order (seasonOrder/compareSeasons in derived-views.js) ────────────
create or replace function private.tv_is_special(p_season text, p_season_number integer) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_season_number = 0, false) or coalesce(p_season, '') ~* '^\s*specials?\s*$'
$$;

-- season_number when stored; otherwise the N in "Season N…" / "Volume N…";
-- otherwise last.
create or replace function private.tv_season_num(p_season text, p_season_number integer) returns double precision
language sql immutable set search_path = '' as $$
  select coalesce(p_season_number::double precision,
                  ((regexp_match(coalesce(p_season, ''), '^(?:Season|Volume)\s+(\d+)', 'i'))[1])::double precision,
                  'Infinity'::double precision)
$$;

-- ── Up next ──────────────────────────────────────────────────────────────────
-- The first unwatched, non-skipped season after the furthest watched season of
-- the main list (numbered seasons when there are any, otherwise all). Release
-- dates don't matter here. Null when nothing remains.
create or replace function private.tv_up_next(p_show_id uuid) returns uuid
language sql stable set search_path = '' as $$
  with s as (
    select id, watched, skipped, private.tv_is_special(season, season_number) as sp,
           row_number() over (order by private.tv_is_special(season, season_number),
                                       private.tv_season_num(season, season_number),
                                       coalesce(date_sort, '') collate "C", coalesce(season, '') collate "C", id) as rn
    from public.watchlist_items where show_id = p_show_id
  ),
  m as (select * from s where not sp or not exists (select 1 from s where not sp)),
  f as (select coalesce(max(rn) filter (where watched), 0) as fp from m)
  select m.id from m, f where m.rn > f.fp and not m.watched and not m.skipped order by m.rn limit 1
$$;

-- The season that carries 'watching' in the compatibility values: up next;
-- else the furthest watched season; else the first season of the main list.
create or replace function private.tv_watching_anchor(p_show_id uuid) returns uuid
language sql stable set search_path = '' as $$
  with s as (
    select id, watched, private.tv_is_special(season, season_number) as sp,
           row_number() over (order by private.tv_is_special(season, season_number),
                                       private.tv_season_num(season, season_number),
                                       coalesce(date_sort, '') collate "C", coalesce(season, '') collate "C", id) as rn
    from public.watchlist_items where show_id = p_show_id
  ),
  m as (select * from s where not sp or not exists (select 1 from s where not sp))
  select coalesce(private.tv_up_next(p_show_id),
                  (select id from m where watched order by rn desc limit 1),
                  (select id from m order by rn limit 1))
$$;

-- ── Compatibility values (Phase 3 and stabilization only) ────────────────────
-- Writes the deprecated season status so a rollback to the old app shows the
-- same show status and up next. Never read by the new code.
create or replace function private.tv_project_legacy_status(p_show_id uuid) returns void
language plpgsql set search_path = '' as $$
declare
  v_status text;
  v_anchor uuid;
begin
  select status into v_status from public.tv_shows
  where id = p_show_id and user_id = private.current_owner_id();
  if not found then raise exception 'not_found: show' using errcode = 'P0002'; end if;
  if v_status = 'watching' then v_anchor := private.tv_watching_anchor(p_show_id); end if;
  update public.watchlist_items w set status = x.s
  from (
    select id, case
      when v_status = 'skipped' or skipped then 'skipped'
      when v_status = 'watching' then case when id = v_anchor then 'watching' else 'confirmed' end
      else v_status end as s
    from public.watchlist_items where show_id = p_show_id
  ) x
  where w.id = x.id and w.status is distinct from x.s;
end $$;

-- ── Admin (SQL Editor only) ──────────────────────────────────────────────────
-- Links the owner's unlinked TV season rows to their shows, creating any
-- missing show (status set later by tv_shadow_resync). Safe to re-run.
create or replace function private.tv_backfill(p_user_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_created int := 0; v_k int; v_linked int;
begin
  if private.tv_stage() not in ('tv_schema', 'shadow') then
    raise exception 'tv_backfill: not available in stage %', private.tv_stage();
  end if;

  insert into public.tv_shows (user_id, collection, title, show_key, tmdb_id, status)
  select p_user_id, collection, title, split_part(item_key, '|', 1), tmdb_id, 'confirmed'
  from (
    select distinct on (collection, tmdb_id) collection, tmdb_id, title, item_key
    from public.watchlist_items
    where user_id = p_user_id and show_id is null and tmdb_id is not null
      and private.tv_is_tv_row(collection, media_type, season)
    order by collection, tmdb_id, private.tv_is_special(season, season_number),
             private.tv_season_num(season, season_number), date_sort collate "C", season collate "C", id
  ) g
  on conflict do nothing;
  get diagnostics v_k = row_count; v_created := v_created + v_k;

  -- Legacy shows take the title of the first season whose own key is the show key
  -- (for an override, the canonical show's title).
  insert into public.tv_shows (user_id, collection, title, show_key, tmdb_id, status)
  select p_user_id, collection, title, show_key, null, 'confirmed'
  from (
    select distinct on (collection, show_key) collection, show_key, title
    from (
      select w.*, private.tv_show_key(w.collection, w.item_key) as show_key
      from public.watchlist_items w
      where w.user_id = p_user_id and w.show_id is null and w.tmdb_id is null
        and private.tv_is_tv_row(w.collection, w.media_type, w.season)
    ) x
    order by collection, show_key, (split_part(item_key, '|', 1) = show_key) desc,
             private.tv_is_special(season, season_number), private.tv_season_num(season, season_number),
             date_sort collate "C", season collate "C", id
  ) g
  on conflict do nothing;
  get diagnostics v_k = row_count; v_created := v_created + v_k;

  update public.watchlist_items w set show_id = s.id
  from public.tv_shows s
  where w.user_id = p_user_id and w.show_id is null and private.tv_is_tv_row(w.collection, w.media_type, w.season)
    and s.user_id = p_user_id and s.collection = w.collection
    and ((w.tmdb_id is not null and s.tmdb_id = w.tmdb_id)
      or (w.tmdb_id is null and s.tmdb_id is null and s.show_key = private.tv_show_key(w.collection, w.item_key)));
  get diagnostics v_linked = row_count;

  return jsonb_build_object('shows_created', v_created, 'rows_linked', v_linked,
    'unlinked_tv_rows', (select count(*) from public.watchlist_items
                         where user_id = p_user_id and show_id is null
                           and private.tv_is_tv_row(collection, media_type, season)));
end $$;

-- Recomputes every show's status and the season skip flags from the season
-- statuses, using the approved rules. Only while the old season status is
-- authoritative (tv_schema, shadow). Deletes shows left with no seasons. Any
-- unmapped pattern aborts the whole resync and names the shows.
create or replace function private.tv_shadow_resync(p_user_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_unmapped text;
  v_deleted int;
begin
  if private.tv_stage() not in ('tv_schema', 'shadow') then
    raise exception 'tv_shadow_resync: not available in stage %', private.tv_stage();
  end if;

  delete from public.tv_shows s
  where s.user_id = p_user_id and not exists (select 1 from public.watchlist_items w where w.show_id = s.id);
  get diagnostics v_deleted = row_count;

  create temp table _resync on commit drop as
  select id, title, act,
    case
      when act is null then 'skipped'
      when cardinality(act) = 1 then act[1]
      when 'watching' = any(act) and act <@ array['watching', 'confirmed', 'pending']::text[] then 'watching'
      when cardinality(act) = 2 and act @> array['confirmed', 'pending']::text[] then 'confirmed'
    end as new_status
  from (
    select s.id, s.title,
           array_agg(distinct w.status order by w.status) filter (where w.status <> 'skipped') as act
    from public.tv_shows s join public.watchlist_items w on w.show_id = s.id
    where s.user_id = p_user_id
    group by s.id, s.title
  ) a;

  select string_agg(format('%s [%s]', title, array_to_string(act, '+')), '; ') into v_unmapped
  from _resync where new_status is null;
  if v_unmapped is not null then
    raise exception 'tv_shadow_resync: unmapped status patterns: %', v_unmapped;
  end if;

  update public.tv_shows s set status = r.new_status
  from _resync r where s.id = r.id and s.status is distinct from r.new_status;

  update public.watchlist_items w set skipped = (w.status = 'skipped' and s.status <> 'skipped')
  from public.tv_shows s
  where w.show_id = s.id and s.user_id = p_user_id
    and w.skipped is distinct from (w.status = 'skipped' and s.status <> 'skipped');

  drop table _resync;
  return jsonb_build_object(
    'shows', (select count(*) from public.tv_shows where user_id = p_user_id),
    'empty_shows_deleted', v_deleted,
    'statuses', (select jsonb_object_agg(status, n) from (select status, count(*) n from public.tv_shows
                 where user_id = p_user_id group by status) x),
    'skipped_flags', (select count(*) from public.watchlist_items where user_id = p_user_id and skipped));
end $$;

-- ── Permissions ──────────────────────────────────────────────────────────────
revoke all on function private.tv_collections(), private.tv_is_tv_row(text, text, text),
  private.tv_show_key_override(text, text), private.tv_show_key(text, text),
  private.tv_is_special(text, integer), private.tv_season_num(text, integer),
  private.tv_up_next(uuid), private.tv_watching_anchor(uuid), private.tv_project_legacy_status(uuid),
  private.tv_backfill(uuid), private.tv_shadow_resync(uuid)
  from public;
grant execute on function private.tv_collections(), private.tv_is_tv_row(text, text, text),
  private.tv_show_key_override(text, text), private.tv_show_key(text, text),
  private.tv_is_special(text, integer), private.tv_season_num(text, integer),
  private.tv_up_next(uuid), private.tv_watching_anchor(uuid), private.tv_project_legacy_status(uuid)
  to anon, authenticated;
revoke all on function private.tv_backfill(uuid), private.tv_shadow_resync(uuid) from anon, authenticated;
