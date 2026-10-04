-- Phase 1c (part 1): user-owned TV shows, in one transaction.
--   * public.tv_shows, one per owner + collection + show identity;
--   * watchlist_items.show_id (seasons only) and watchlist_items.skipped;
--   * the season → show link enforcing the same owner and collection.
-- The existing app stays authoritative; nothing reads these yet.
-- Run as postgres after db/phase1b_ownership.sql + db/restore_backup.sql, then
-- db/tv_model.sql and db/phase1c_backfill.sql.
begin;

do $$ begin
  if private.tv_stage() <> 'ownership' then raise exception 'phase1c: expected stage ownership, found %', private.tv_stage(); end if;
end $$;

create table public.tv_shows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id(),
  collection text not null,
  title text not null,
  show_key text not null,
  tmdb_id integer,
  status text not null default 'confirmed'
    constraint tv_shows_status_check check (status in
      ('confirmed', 'highpriority', 'watching', 'complete', 'pending', 'maybe', 'skipped')),
  created_at timestamptz not null default now(),
  constraint tv_shows_text_check check (btrim(title) <> '' and btrim(show_key) <> ''),
  constraint tv_shows_id_owner_collection_key unique (id, user_id, collection)
);
create unique index tv_shows_identified_key on public.tv_shows using btree (user_id, collection, tmdb_id)
  where (tmdb_id is not null);
create unique index tv_shows_legacy_key on public.tv_shows using btree (user_id, collection, show_key)
  where (tmdb_id is null);

-- Same access rules as the other tables until the sign-in project.
alter table public.tv_shows enable row level security;
create policy anon_select on public.tv_shows for select to anon using (true);
create policy anon_insert on public.tv_shows for insert to anon with check (true);
create policy anon_update on public.tv_shows for update to anon using (true) with check (true);
create policy anon_delete on public.tv_shows for delete to anon using (true);
revoke all on public.tv_shows from anon, authenticated;
grant select, delete on public.tv_shows to anon, authenticated;
grant insert (id, collection, title, show_key, tmdb_id, status, created_at),
      update (id, collection, title, show_key, tmdb_id, status, created_at)
  on public.tv_shows to anon, authenticated;

alter table public.watchlist_items add column show_id uuid, add column skipped boolean not null default false;
alter table public.watchlist_items
  add constraint watchlist_items_show_fkey foreign key (show_id, user_id, collection)
    references public.tv_shows (id, user_id, collection) on update cascade on delete restrict,
  add constraint watchlist_items_show_link_check
    check (show_id is null or (season <> 'Film' and media_type is distinct from 'movie')),
  add constraint watchlist_items_skipped_check check (not skipped or show_id is not null);
create index watchlist_items_show_id_idx on public.watchlist_items using btree (show_id);
-- The database functions run with the caller's permissions, so browser roles
-- need write access to the two new columns.
grant insert (show_id, skipped), update (show_id, skipped) on public.watchlist_items to anon, authenticated;

update private.migration_stage set stage = 'tv_schema', changed_at = now();

commit;
