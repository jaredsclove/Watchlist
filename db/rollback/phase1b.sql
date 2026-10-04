-- Rollback of Phase 1b, in one transaction: puts back the single-owner
-- uniqueness rules and table-level grants, removes user_id and the private
-- schema, and reinstalls the Phase 0 restore function. Only valid while a single
-- owner exists (it refuses otherwise). Run as postgres, only with approval, after
-- db/rollback/phase2_and_1c.sql (or if Phase 1c never ran).
-- Then run db/phase0_restore_v1.sql to reinstall the pre-ownership restore.
begin;

do $$ begin
  if to_regclass('public.tv_shows') is not null then raise exception 'rollback: run db/rollback/phase2_and_1c.sql first'; end if;
  if (select count(distinct user_id) from (select user_id from public.watchlist_items union all select user_id from public.othertv_shows
      union all select user_id from public.custom_collections) x) > 1 then
    raise exception 'rollback: more than one owner exists; single-owner uniqueness cannot be restored';
  end if;
end $$;

create unique index watchlist_items_movie_identity_key_v1 on public.watchlist_items
  using btree (collection, media_type, tmdb_id) where ((media_type = 'movie'::text) and (tmdb_id is not null));
drop index public.watchlist_items_movie_identity_key;
alter index public.watchlist_items_movie_identity_key_v1 rename to watchlist_items_movie_identity_key;
create unique index watchlist_items_tv_identity_key_v1 on public.watchlist_items
  using btree (collection, media_type, tmdb_id, season_number)
  where ((media_type = 'tv'::text) and (tmdb_id is not null) and (season_number is not null));
drop index public.watchlist_items_tv_identity_key;
alter index public.watchlist_items_tv_identity_key_v1 rename to watchlist_items_tv_identity_key;
create unique index watchlist_items_legacy_item_key_key_v1 on public.watchlist_items
  using btree (collection, item_key) where (tmdb_id is null);
drop index public.watchlist_items_legacy_item_key_key;
alter index public.watchlist_items_legacy_item_key_key_v1 rename to watchlist_items_legacy_item_key_key;
drop index public.watchlist_items_collection_idx;
create index watchlist_items_collection_idx on public.watchlist_items using btree (collection, date_sort);

alter table public.othertv_shows drop constraint othertv_shows_user_collection_tmdb_id_key,
  add constraint othertv_shows_collection_tmdb_id_key unique (collection, tmdb_id);
alter table public.custom_collections drop constraint custom_collections_user_name_key,
  add constraint custom_collections_name_key unique (name);

drop function public.restore_backup(jsonb, boolean);
alter table public.watchlist_items drop column user_id;
alter table public.othertv_shows drop column user_id;
alter table public.custom_collections drop column user_id;

revoke insert (id, collection, item_key, title, season, theme, display_date, date_sort, watched, status, created_at,
               watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number),
       update (id, collection, item_key, title, season, theme, display_date, date_sort, watched, status, created_at,
               watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number)
  on public.watchlist_items from anon, authenticated;
revoke insert (id, tmdb_id, title, network, created_at, collection), update (id, tmdb_id, title, network, created_at, collection)
  on public.othertv_shows from anon, authenticated;
revoke insert (id, name, tmdb_person_id, created_at, role), update (id, name, tmdb_person_id, created_at, role)
  on public.custom_collections from anon, authenticated;
grant all on public.watchlist_items, public.othertv_shows, public.custom_collections to anon, authenticated;

drop schema private cascade;

commit;
