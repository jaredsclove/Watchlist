-- TEST PROJECTS ONLY. Recreates the production schema as it was before the
-- TV-show migration (inspected live 2026-10-04): the three tables, their
-- defaults, constraints and indexes, RLS with the permissive anon policies, and
-- the table grants. Never run on production.
create table public.watchlist_items (
  id uuid not null default gen_random_uuid(),
  collection text not null,
  item_key text not null,
  title text not null,
  season text not null default ''::text,
  theme text not null default ''::text,
  display_date text not null default ''::text,
  date_sort text not null default ''::text,
  watched boolean not null default false,
  status text not null default 'confirmed'::text,
  created_at timestamptz not null default now(),
  watch_with text[] default '{}'::text[],
  collections text[] default '{}'::text[],
  tmdb_collection_id integer,
  tmdb_collection_name text,
  media_type text,
  tmdb_id integer,
  season_number integer,
  constraint watchlist_items_pkey primary key (id),
  constraint watchlist_items_identity_shape_check check (
    ((media_type is null) and (tmdb_id is null) and (season_number is null))
    or ((not (media_type is distinct from 'tv'::text)) and (tmdb_id is not null) and (season_number is not null))
    or ((not (media_type is distinct from 'movie'::text)) and (tmdb_id is not null) and (season_number is null)))
);
create index watchlist_items_collection_idx on public.watchlist_items using btree (collection, date_sort);
create index watchlist_items_tmdb_collection_idx on public.watchlist_items using btree (tmdb_collection_id);
create unique index watchlist_items_legacy_item_key_key on public.watchlist_items using btree (collection, item_key)
  where (tmdb_id is null);
create unique index watchlist_items_movie_identity_key on public.watchlist_items using btree (collection, media_type, tmdb_id)
  where ((media_type = 'movie'::text) and (tmdb_id is not null));
create unique index watchlist_items_tv_identity_key on public.watchlist_items using btree (collection, media_type, tmdb_id, season_number)
  where ((media_type = 'tv'::text) and (tmdb_id is not null) and (season_number is not null));

create table public.othertv_shows (
  id uuid not null default gen_random_uuid(),
  tmdb_id integer not null,
  title text not null,
  network text not null default ''::text,
  created_at timestamptz not null default now(),
  collection text not null default 'othertv'::text,
  constraint othertv_shows_pkey primary key (id),
  constraint othertv_shows_collection_tmdb_id_key unique (collection, tmdb_id)
);
create index othertv_shows_collection_idx on public.othertv_shows using btree (collection);
create index othertv_shows_tmdb_id_idx on public.othertv_shows using btree (tmdb_id);

create table public.custom_collections (
  id uuid not null default gen_random_uuid(),
  name text not null,
  tmdb_person_id integer not null,
  created_at timestamptz not null default now(),
  role text default 'director'::text,
  constraint custom_collections_pkey primary key (id),
  constraint custom_collections_name_key unique (name)
);
create index custom_collections_person_idx on public.custom_collections using btree (tmdb_person_id);

alter table public.watchlist_items enable row level security;
alter table public.othertv_shows enable row level security;
alter table public.custom_collections enable row level security;

create policy anon_select on public.watchlist_items for select to anon using (true);
create policy anon_insert on public.watchlist_items for insert to anon with check (true);
create policy anon_update on public.watchlist_items for update to anon using (true) with check (true);
create policy anon_delete on public.watchlist_items for delete to anon using (true);
create policy anon_select on public.othertv_shows for select to anon using (true);
create policy anon_insert on public.othertv_shows for insert to anon with check (true);
create policy anon_update on public.othertv_shows for update to anon using (true) with check (true);
create policy anon_delete on public.othertv_shows for delete to anon using (true);
create policy anon_select on public.custom_collections for select to anon using (true);
create policy anon_insert on public.custom_collections for insert to anon with check (true);
create policy anon_update on public.custom_collections for update to anon using (true) with check (true);
create policy anon_delete on public.custom_collections for delete to anon using (true);

grant all on public.watchlist_items, public.othertv_shows, public.custom_collections to anon, authenticated, service_role;
