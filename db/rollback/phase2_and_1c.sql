-- Rollback of Phase 2 and Phase 1c, in one transaction: removes the TV
-- functions, the season link, show_id/skipped and tv_shows, and returns the
-- stage to 'ownership'. Pre-existing columns are untouched, so the existing app
-- keeps working throughout. Run as postgres, only with approval, after reverting
-- the app to a version that doesn't call these functions.
-- If Phase 3 ran, first roll it back (db/stages.sql) so season statuses are current.
begin;

do $$ begin
  if private.tv_stage() not in ('tv_schema', 'shadow') then
    raise exception 'rollback: stage is %; roll back Phase 3 first', private.tv_stage();
  end if;
end $$;

drop function if exists public.add_tv_seasons(text, jsonb, jsonb), public.seed_tv_defaults(text, jsonb),
  public.set_show_status(uuid, text), public.set_season_watched(uuid, boolean), public.set_season_skipped(uuid, boolean),
  public.delete_tv_season(uuid), public.match_tv_row(uuid, jsonb, jsonb),
  private.tv_require_stage(text, text[]), private.tv_valid_date(text), private.tv_valid_status(text),
  private.tv_lock_or_create_show(uuid, text, integer, text, text, text), private.tv_lock_season(uuid, uuid),
  private.tv_backfill(uuid), private.tv_shadow_resync(uuid), private.tv_project_legacy_status(uuid),
  private.tv_watching_anchor(uuid), private.tv_up_next(uuid);

alter table public.watchlist_items
  drop constraint watchlist_items_show_fkey,
  drop constraint watchlist_items_show_link_check,
  drop constraint watchlist_items_skipped_check;
drop index public.watchlist_items_show_id_idx;
alter table public.watchlist_items drop column show_id, drop column skipped;
drop table public.tv_shows;

-- tv_is_tv_row and the other pure helpers stay: db/restore_backup.sql uses them.
update private.migration_stage set stage = 'ownership', changed_at = now();

commit;
