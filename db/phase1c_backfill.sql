-- Phase 1c (part 2): create the bootstrap owner's shows, link every TV season,
-- set show statuses and season skip flags, then check every expected count.
-- One transaction: any mismatch rolls the whole backfill back.
--
-- The expected counts are production's as of 2026-10-04. Re-confirm them
-- read-only immediately before running; if production has changed, stop and
-- explain the difference before editing them.
begin;

do $$
declare
  v_owner uuid := (select bootstrap_owner_id from private.app_owner);
  r jsonb;
  e jsonb := '{
    "watchlist_items": 718, "tv_rows": 641, "non_tv_rows": 77, "shows": 196,
    "by_collection": {"disney": 103, "othertv": 61, "90day": 15, "sheridan": 14, "truecrime": 3},
    "identified": 64, "skipped_flags": 38,
    "statuses": {"watching": 10, "confirmed": 138, "complete": 2, "pending": 35, "skipped": 10, "maybe": 1}
  }';
  got jsonb;
begin
  r := private.tv_backfill(v_owner);
  raise notice 'tv_backfill: %', r;
  r := private.tv_shadow_resync(v_owner);
  raise notice 'tv_shadow_resync: %', r;

  got := jsonb_build_object(
    'watchlist_items', (select count(*) from public.watchlist_items),
    'tv_rows', (select count(*) from public.watchlist_items where private.tv_is_tv_row(collection, media_type, season)),
    'non_tv_rows', (select count(*) from public.watchlist_items where not private.tv_is_tv_row(collection, media_type, season)),
    'shows', (select count(*) from public.tv_shows),
    'by_collection', (select jsonb_object_agg(collection, n) from (select collection, count(*) n from public.tv_shows group by collection) x),
    'identified', (select count(*) from public.tv_shows where tmdb_id is not null),
    'skipped_flags', (select count(*) from public.watchlist_items where skipped),
    'statuses', (select jsonb_object_agg(status, n) from (select status, count(*) n from public.tv_shows group by status) x));
  if got <> e then
    raise exception 'phase1c backfill: counts differ. expected % got %', e, got;
  end if;

  if exists (select 1 from public.watchlist_items where private.tv_is_tv_row(collection, media_type, season) and show_id is null)
     or exists (select 1 from public.watchlist_items where not private.tv_is_tv_row(collection, media_type, season) and show_id is not null)
     or exists (select 1 from public.watchlist_items w join public.tv_shows s on s.id = w.show_id
                where s.user_id <> w.user_id or s.collection <> w.collection
                   or s.tmdb_id is distinct from w.tmdb_id
                   or (s.tmdb_id is null and s.show_key <> private.tv_show_key(w.collection, w.item_key)))
     or exists (select 1 from public.tv_shows s where not exists (select 1 from public.watchlist_items w where w.show_id = s.id))
     or exists (select 1 from public.tv_shows where user_id <> v_owner) then
    raise exception 'phase1c backfill: link consistency check failed';
  end if;

  if (select count(*) from public.watchlist_items w join public.tv_shows s on s.id = w.show_id
      where s.title = 'Star Wars: The Clone Wars (2008)' and s.collection = 'disney') <> 7
     or exists (select 1 from public.watchlist_items where item_key = 'star wars: the clone wars (2008)|film' and show_id is not null) then
    raise exception 'phase1c backfill: Clone Wars merge check failed';
  end if;
end $$;

commit;
