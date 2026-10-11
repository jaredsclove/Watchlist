-- Rollback of the Stage 5c contraction (db/phase5c_contract.sql) to the Stage 5a
-- (coexistence) state, in one transaction. The Stage 5 page works before and
-- after it; Stage 4b pages work again once it has run.
--
-- It refuses (nothing changed) unless the current state is representable in
-- Stage 5a, where storage is the source of truth:
--   * the recovery archive is present (once it is retired, recovery is
--     fix-forward only);
--   * every surviving record's archived storage agrees with its governance and,
--     for a film, with what its theme means (genre ⇔ Movies), and a season's with
--     its show's;
--   * records without an archive entry (created after the contraction) get a
--     deterministic storage: governed → its catalog; an ungoverned show →
--     the one storage its archived seasons share (a Match made it from rows
--     kept there), else othertv; an ungoverned film → movies when its theme is
--     a genre, else othertv; a season → its show's;
--   * the per-storage keys can be rebuilt: no two unmatched shows, and no two
--     unidentified rows, end up with the same key in one storage (same-title
--     records created after the contraction make this refuse);
--   * every governance key equals its record's key (Stage 5a derives it);
--   * legacy_source comes back from the archive (True Crime / Docs included)
--     and must agree with the collection's catalog_id and presentation_key; a
--     collection created after the contraction gets its presentation_key (null
--     when none); legacy_source stays unique per owner.
-- What it preserves: every record and its fields, ids and created_at, every
-- membership, collection and choice, each record's governing catalog, and
-- othertv_shows exactly as archived. What it discards (Stage 5a has no place
-- for it), listed in the report this script returns: the governance links'
-- own ids, origins and created_at, and the archive itself. theme_kind,
-- catalog_id and presentation_key are discarded after being checked to equal
-- what storage now says. Restored
-- columns come back at the end of their tables (physical column order only).
-- Backups taken in format 4 can't be restored on the result: take a format-3
-- backup straight after (with a Stage 5 page that still has the format-3 export).
-- Never part of a reinstall sequence; doesn't touch db/rpc.sql. Run as postgres.
-- The two GENERATED sections are written by tools/stage5-rollback-gen.mjs from
-- local replicas (the rehearsal checks they are current); don't edit them by hand.
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regprocedure('public.stage5_capabilities()') is null or public.stage5_capabilities() ->> 'phase' is distinct from 'contracted' then
    raise exception 'phase5c rollback: the database is not contracted (Stage 5c is not installed)';
  end if;
  if to_regclass('private.stage5_recovery_meta') is null then
    raise exception 'phase5c rollback: the recovery archive has been retired, so the contraction can''t be rolled back; recovery is fix-forward only';
  end if;
end $$;

lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
  public.watch_with_choices, public.custom_collections, public.catalog_show_links, public.catalog_film_links in exclusive mode;

-- ── Where each record goes, and whether that is representable ────────────────
-- A show made since the contraction (no archive entry) goes with its catalog, else with
-- the one storage its archived seasons share (a Match made it from rows kept there, as
-- Stage 5a does), else where new shows go.
create temp table s5rb_show on commit drop as
select s.id, s.user_id, s.show_key, s.tmdb_id, l.catalog, l.catalog_key, a.collection as archived,
  coalesce(a.collection, l.catalog,
    (select min(ai.collection) from public.watchlist_items w join private.stage5_recovery_records ai on ai.kind = 'item' and ai.id = w.id
     where w.show_id = s.id having count(distinct ai.collection) = 1),
    'othertv') as collection, case when a.collection is null then 'rule' else 'archive' end as source
from public.tv_shows s
left join public.catalog_show_links l on l.show_id = s.id
left join private.stage5_recovery_records a on a.kind = 'show' and a.id = s.id;

create temp table s5rb_item on commit drop as
select w.id, w.user_id, w.item_key, w.tmdb_id, w.is_film, w.show_id, w.theme_kind, l.catalog, l.entry_key, a.collection as archived,
  case when w.show_id is not null then (select x.collection from s5rb_show x where x.id = w.show_id)
       else coalesce(a.collection, l.catalog, case when w.theme_kind = 'genre' then 'movies' else 'othertv' end) end as collection,
  case when a.collection is null then 'rule' else 'archive' end as source
from public.watchlist_items w
left join public.catalog_film_links l on l.item_id = w.id
left join private.stage5_recovery_records a on a.kind = 'item' and a.id = w.id;

create temp table s5rb_coll on commit drop as
select c.id, c.user_id, c.catalog_id, c.presentation_key, a.id is not null as archived, a.legacy_source as archived_source,
  case when a.id is not null then a.legacy_source else c.presentation_key end as legacy_source
from public.personal_collections c left join private.stage5_recovery_collections a on a.id = c.id;

do $$
declare v jsonb;
begin
  select jsonb_strip_nulls(jsonb_build_object(
    'show_archive_disagrees_with_governance', (select jsonb_agg(id order by id) from s5rb_show where archived is not null
      and ((archived in ('disney', '90day', 'sheridan')) is distinct from (catalog is not null) or (catalog is not null and catalog <> archived))),
    'season_archive_disagrees_with_show', (select jsonb_agg(id order by id) from s5rb_item where show_id is not null and archived is not null
      and archived <> collection),
    'film_archive_disagrees_with_governance', (select jsonb_agg(id order by id) from s5rb_item where is_film and archived is not null
      and ((archived in ('disney', '90day', 'sheridan')) is distinct from (catalog is not null) or (catalog is not null and catalog <> archived)
           or (theme_kind = 'genre') is distinct from (archived = 'movies'))),
    'governance_key_differs', (select jsonb_agg(id order by id) from (
      select id from s5rb_show where catalog is not null and catalog_key <> show_key
      union all select id from s5rb_item where catalog is not null and entry_key <> item_key) z),
    'unmatched_show_key_collision', (select jsonb_agg(ids) from (select array_agg(id order by id) ids from s5rb_show where tmdb_id is null
      group by user_id, collection, show_key having count(*) > 1) z),
    'unidentified_item_key_collision', (select jsonb_agg(ids) from (select array_agg(id order by id) ids from s5rb_item where tmdb_id is null
      group by user_id, collection, item_key having count(*) > 1) z),
    'collection_archive_disagrees_with_catalog', (select jsonb_agg(id order by id) from s5rb_coll where archived
      and ((catalog_id is not null and archived_source is distinct from catalog_id)
           or (catalog_id is null and archived_source in ('disney', '90day', 'sheridan'))
           or presentation_key is distinct from archived_source)),
    'presentation_disagrees_with_catalog', (select jsonb_agg(id order by id) from s5rb_coll where not archived
      and catalog_id is not null and presentation_key is distinct from catalog_id),
    'legacy_source_collision', (select jsonb_agg(ids) from (select array_agg(id order by id) ids from s5rb_coll where legacy_source is not null
      group by user_id, legacy_source having count(*) > 1) z),
    'unclassified_rows', (select jsonb_agg(id order by id) from s5rb_item where not is_film and show_id is null)
  )) into v;
  if v <> '{}'::jsonb then
    raise exception 'phase5c rollback: the current state can''t be represented in Stage 5a, so nothing was changed (recovery is fix-forward): %', v;
  end if;
end $$;

-- What is discarded, returned after commit; what must survive, checked before it.
create temp table s5rb_report on commit preserve rows as
select jsonb_build_object(
  'discarded_show_links', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'show_id', show_id, 'catalog', catalog, 'origin', origin,
    'created_at', created_at) order by id), '[]') from public.catalog_show_links),
  'discarded_film_links', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'item_id', item_id, 'catalog', catalog, 'origin', origin,
    'created_at', created_at) order by id), '[]') from public.catalog_film_links),
  'records_from_archive', (select count(*) from s5rb_item where source = 'archive') + (select count(*) from s5rb_show where source = 'archive'),
  'records_by_rule', (select count(*) from s5rb_item where source = 'rule') + (select count(*) from s5rb_show where source = 'rule'),
  'collections_without_archive_entry', (select count(*) from s5rb_coll where not archived)) as report;
create temp table s5rb_before on commit drop as
select
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'theme_kind' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t) w,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t) s,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t) m,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'catalog_id' - 'presentation_key')::text, '|' order by t.id), '')) from public.personal_collections t) p,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watch_with_choices t) c,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.custom_collections t) cc,
  (select md5(coalesce(string_agg(show_id::text || ':' || catalog, '|' order by show_id), '')) from public.catalog_show_links) gs,
  (select md5(coalesce(string_agg(item_id::text || ':' || catalog, '|' order by item_id), '')) from public.catalog_film_links) gf;

-- ── Storage columns and keys back ────────────────────────────────────────────
alter table public.tv_shows add column collection text;
update public.tv_shows s set collection = r.collection from s5rb_show r where r.id = s.id;
alter table public.tv_shows alter column collection set not null;
alter table public.watchlist_items add column collection text;
update public.watchlist_items w set collection = r.collection from s5rb_item r where r.id = w.id;
alter table public.watchlist_items alter column collection set not null;
alter table public.personal_collections add column legacy_source text;
update public.personal_collections c set legacy_source = r.legacy_source from s5rb_coll r where r.id = c.id;
alter table public.personal_collections add constraint personal_collections_legacy_source_check
  check (legacy_source in ('disney', 'sheridan', '90day', 'truecrime'));
create unique index personal_collections_legacy_source_key on public.personal_collections using btree (user_id, legacy_source)
  where (legacy_source is not null);

alter table public.tv_shows add constraint tv_shows_id_owner_collection_key unique (id, user_id, collection);
alter table public.watchlist_items drop constraint watchlist_items_show_fkey;
alter table public.watchlist_items add constraint watchlist_items_show_fkey foreign key (show_id, user_id, collection)
  references public.tv_shows (id, user_id, collection) on update cascade on delete restrict;
create unique index tv_shows_identified_key on public.tv_shows using btree (user_id, collection, tmdb_id)
  where (tmdb_id is not null);
create unique index tv_shows_legacy_key on public.tv_shows using btree (user_id, collection, show_key)
  where (tmdb_id is null);
create unique index watchlist_items_movie_identity_key on public.watchlist_items
  using btree (user_id, collection, media_type, tmdb_id) where ((media_type = 'movie'::text) and (tmdb_id is not null));
create unique index watchlist_items_tv_identity_key on public.watchlist_items
  using btree (user_id, collection, media_type, tmdb_id, season_number)
  where ((media_type = 'tv'::text) and (tmdb_id is not null) and (season_number is not null));
create unique index watchlist_items_legacy_item_key_key on public.watchlist_items
  using btree (user_id, collection, item_key) where (tmdb_id is null);
drop index public.watchlist_items_owner_date_idx;
create index watchlist_items_collection_idx on public.watchlist_items using btree (user_id, collection, date_sort);

grant insert (collection), update (collection) on public.tv_shows to anon, authenticated;
grant insert (collection), update (collection) on public.watchlist_items to anon, authenticated;
grant insert (legacy_source) on public.personal_collections to anon, authenticated;

-- ── othertv_shows, exactly as archived ───────────────────────────────────────
-- BEGIN GENERATED-OTHERTV
create table public.othertv_shows (
  id uuid default gen_random_uuid() not null,
  tmdb_id integer not null,
  title text not null,
  network text default ''::text not null,
  created_at timestamp with time zone default now() not null,
  collection text default 'othertv'::text not null,
  user_id uuid default private.current_owner_id() not null,
  constraint othertv_shows_pkey PRIMARY KEY (id),
  constraint othertv_shows_user_collection_tmdb_id_key UNIQUE (user_id, collection, tmdb_id)
);
CREATE INDEX othertv_shows_collection_idx ON public.othertv_shows USING btree (collection);
CREATE INDEX othertv_shows_tmdb_id_idx ON public.othertv_shows USING btree (tmdb_id);
alter table public.othertv_shows enable row level security;
create policy anon_delete on public.othertv_shows as permissive for delete to anon using (true);
create policy anon_insert on public.othertv_shows as permissive for insert to anon with check (true);
create policy anon_select on public.othertv_shows as permissive for select to anon using (true);
create policy anon_update on public.othertv_shows as permissive for update to anon using (true) with check (true);
revoke all on public.othertv_shows from public, anon, authenticated, service_role;
grant delete, references, select, trigger, truncate on public.othertv_shows to anon;
grant delete, references, select, trigger, truncate on public.othertv_shows to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.othertv_shows to service_role;
grant insert (collection, created_at, id, network, title, tmdb_id) on public.othertv_shows to anon;
grant update (collection, created_at, id, network, title, tmdb_id) on public.othertv_shows to anon;
grant insert (collection, created_at, id, network, title, tmdb_id) on public.othertv_shows to authenticated;
grant update (collection, created_at, id, network, title, tmdb_id) on public.othertv_shows to authenticated;
-- END GENERATED-OTHERTV
insert into public.othertv_shows (id, tmdb_id, title, network, created_at, collection, user_id)
select id, tmdb_id, title, network, created_at, collection, user_id from private.stage5_recovery_othertv;

-- ── Functions, views and triggers as Stage 5a has them ───────────────────────
-- BEGIN GENERATED-CATALOG
-- Triggers the contraction added or changed.
drop trigger catalog_film_links_insert_guard on catalog_film_links;
drop trigger catalog_show_links_insert_guard on catalog_show_links;
drop trigger personal_collections_catalog_guard on personal_collections;
drop trigger personal_collections_catalog_update_guard on personal_collections;
drop trigger stage5_recovery_collections_guard on private.stage5_recovery_collections;
drop trigger stage5_recovery_meta_guard on private.stage5_recovery_meta;
drop trigger stage5_recovery_othertv_guard on private.stage5_recovery_othertv;
drop trigger stage5_recovery_records_guard on private.stage5_recovery_records;
drop trigger tv_shows_identity_guard on tv_shows;
drop trigger tv_shows_insert_guard on tv_shows;
drop trigger catalog_date_guard on watchlist_items;
drop trigger watchlist_items_identity_guard on watchlist_items;
drop trigger watchlist_items_insert_guard on watchlist_items;
-- The read views as Stage 5a defines them (over storage).
create or replace view public.library_catalog_films with (security_invoker = true) as
SELECT id,
    id AS item_id,
    collection AS catalog,
    item_key AS entry_key,
    'migrated_from_storage'::text AS origin
   FROM watchlist_items w
  WHERE (is_film AND (collection = ANY (ARRAY['disney'::text, '90day'::text, 'sheridan'::text])));
create or replace view public.library_catalog_shows with (security_invoker = true) as
SELECT id,
    id AS show_id,
    collection AS catalog,
    show_key AS catalog_key,
    'migrated_from_storage'::text AS origin
   FROM tv_shows s
  WHERE (collection = ANY (ARRAY['disney'::text, '90day'::text, 'sheridan'::text]));
create or replace view public.library_collection_catalogs with (security_invoker = true) as
SELECT id,
    id AS collection_id,
    legacy_source AS catalog
   FROM personal_collections c
  WHERE (legacy_source = ANY (ARRAY['disney'::text, '90day'::text, 'sheridan'::text]));
create or replace view public.library_collection_presentation with (security_invoker = true) as
SELECT id,
    id AS collection_id,
    legacy_source AS presentation_key
   FROM personal_collections c
  WHERE (legacy_source = ANY (ARRAY['disney'::text, '90day'::text, 'sheridan'::text, 'truecrime'::text]));
create or replace view public.library_film_theme_kinds with (security_invoker = true) as
SELECT id,
    id AS item_id,
        CASE
            WHEN (collection = 'movies'::text) THEN 'genre'::text
            ELSE 'other'::text
        END AS theme_kind
   FROM watchlist_items w
  WHERE is_film;
-- Functions the contraction added.
drop function private.lib_catalog_insert_v5(uuid,text,jsonb);
drop function private.library_write_guard();
drop function private.tv_show_key(text,text);
drop function private.tv_show_key_override(text,text);
-- Functions the contraction changed or removed, verbatim from Stage 5a, with their grants
-- (bodies checked when they run, as pg_dump does: a SQL function may name one defined after it).
set local check_function_bodies = off;
CREATE OR REPLACE FUNCTION private.catalog_date_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if (new.display_date is distinct from old.display_date or new.date_sort is distinct from old.date_sort)
     and coalesce(current_setting('watchlist.catalog_date_write', true), '') <> 'on' then
    raise exception 'catalog_apply_required: Dates of built-in catalog entries now change only through Catalog updates. Reload the page. Nothing was changed.'
      using errcode = 'P0001';
  end if;
  return new;
end $function$;
revoke all on function private.catalog_date_guard() from public, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION private.catalog_insert_missing(p_owner uuid, p_collection text, p_defaults jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  d jsonb;
  g record;
  v_show public.tv_shows;
  v_show_id uuid;
  v_created boolean;
  r public.watchlist_items;
  v_inserted uuid[] := '{}';
  v_created_shows uuid[] := '{}';
  v_reopened uuid[] := '{}';
  v_conflicts jsonb := '[]';
  v_identified jsonb := '[]';
  v_n int;
  v_enriched jsonb;
begin
  for g in
    with defs as (
      select e.value as def, e.ordinality as ord, private.tv_show_key(p_collection, e.value ->> 'k') as show_key
      from jsonb_array_elements(p_defaults) with ordinality e
      where e.value ->> 's' <> 'Film'
    )
    select defs.show_key,
           coalesce((select x.def ->> 't' from defs x where x.show_key = defs.show_key and split_part(x.def ->> 'k', '|', 1) = defs.show_key order by x.ord limit 1),
                    (select x.def ->> 't' from defs x where x.show_key = defs.show_key order by x.ord limit 1)) as title,
           bool_and(coalesce((defs.def ->> 'p')::boolean, false)) as all_pending,
           jsonb_agg(defs.def order by defs.ord) filter (where not exists (
             select 1 from public.watchlist_items w
             where w.user_id = p_owner and w.collection = p_collection and w.tmdb_id is null and w.item_key = defs.def ->> 'k')) as missing
    from defs group by defs.show_key
  loop
    v_show_id := private.tv_enriched_show_for(p_owner, p_collection, g.show_key);
    if v_show_id is not null then
      select * into v_show from public.tv_shows where id = v_show_id;
      v_enriched := private.tv_add_to_enriched_show(v_show_id, (
        select coalesce(jsonb_agg(jsonb_build_object('item_key', x.def ->> 'k', 'title', x.def ->> 't', 'season', x.def ->> 's',
          'theme', x.def ->> 'th', 'display_date', x.def ->> 'd', 'date_sort', x.def ->> 'ds',
          'status', case when coalesce((x.def ->> 'p')::boolean, false) then 'pending' else 'confirmed' end)), '[]')
        from jsonb_array_elements(p_defaults) as x(def)
        where x.def ->> 's' <> 'Film' and private.tv_show_key(p_collection, x.def ->> 'k') = g.show_key));
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
        from public.watchlist_items w join public.tv_shows s on s.id = w.show_id
        where w.user_id = p_owner and w.collection = p_collection and w.tmdb_id is null
          and private.tv_show_key(p_collection, w.item_key) = g.show_key and s.show_key <> g.show_key), '[]');
      continue;
    end if;
    select show_id, created into v_show_id, v_created
    from private.tv_lock_or_create_show(p_owner, p_collection, null, g.show_key, g.title,
                                        case when g.all_pending then 'pending' else 'confirmed' end);
    select * into v_show from public.tv_shows where id = v_show_id;
    if v_created then v_created_shows := v_created_shows || v_show.id; end if;
    v_n := 0;
    for d in select * from jsonb_array_elements(g.missing) loop
      r := null;
      insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched, status, show_id)
      values (p_collection, d ->> 'k', d ->> 't', d ->> 's', coalesce(d ->> 'th', ''), coalesce(d ->> 'd', ''), d ->> 'ds', false,
              case when coalesce((d ->> 'p')::boolean, false) then 'pending' else 'confirmed' end, v_show.id)
      on conflict (user_id, collection, item_key) where (tmdb_id is null) do nothing
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
    r := null;
    insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched, status)
    values (p_collection, d ->> 'k', d ->> 't', d ->> 's', coalesce(d ->> 'th', ''), coalesce(d ->> 'd', ''), d ->> 'ds', false,
            case when coalesce((d ->> 'p')::boolean, false) then 'pending' else 'confirmed' end)
    on conflict (user_id, collection, item_key) where (tmdb_id is null) do nothing
    returning * into r;
    if r.id is not null then v_inserted := v_inserted || r.id; end if;
  end loop;

  return jsonb_build_object('inserted', to_jsonb(v_inserted), 'created_shows', to_jsonb(v_created_shows),
    'reopened', to_jsonb(v_reopened), 'conflicts', v_conflicts, 'identified', v_identified);
end $function$;
revoke all on function private.catalog_insert_missing(uuid,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function private.catalog_insert_missing(uuid,text,jsonb) to anon;
grant execute on function private.catalog_insert_missing(uuid,text,jsonb) to authenticated;
CREATE OR REPLACE FUNCTION private.catalog_run(p_collection text, p_defaults jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_owner uuid := private.current_owner_id();
  d jsonb;
  v_keys text[] := '{}';
  v_payload_hash text;
  v_missing jsonb;
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
  v_film_ids uuid[] := '{}';
  v_mem_id uuid;
  v_doc jsonb;
  x record;
begin
  -- S1: locks in the canonical table order (shows, items, collections), before
  -- any read. EXCLUSIVE still lets reads through; every writer waits.
  perform set_config('lock_timeout', '2s', true);
  begin
    lock table public.tv_shows, public.watchlist_items in exclusive mode;
    lock table public.personal_collections in share mode;
  exception when lock_not_available or deadlock_detected then
    raise exception 'catalog_busy: The database was busy, so nothing was changed. Review again in a moment.' using errcode = 'P0001';
  end;

  -- S2: the payload (the former seed validation) and its hash.
  if p_collection is null or not (p_collection = any(private.tv_builtin_collections())) then
    raise exception 'invalid_input: % has no built-in catalog', p_collection using errcode = '22023';
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

  -- State before any write, read under the locks.
  select coalesce(jsonb_object_agg(id::text, status), '{}') into v_pre_status
  from public.tv_shows where user_id = v_owner and collection = p_collection;
  select count(*) into v_rows_before from public.watchlist_items where user_id = v_owner;
  select count(*) into v_shows_before from public.tv_shows where user_id = v_owner;
  select * into v_target from public.personal_collections where user_id = v_owner and legacy_source = p_collection;
  -- Date-fill candidates: a stored TBA date whose default is no longer TBA (the
  -- tab-open rule). Skipped items stay eligible; the fill touches dates only.
  select coalesce(jsonb_agg(jsonb_build_object('row_id', w.id, 'item_key', w.item_key, 'is_film', w.is_film, 'show_id', w.show_id,
           'old_display', w.display_date, 'old_sort', w.date_sort, 'new_display', e.value ->> 'd', 'new_sort', e.value ->> 'ds',
           'watched', w.watched, 'skipped', w.skipped, 'status', w.status) order by w.id), '[]')
    into v_fills
  from public.watchlist_items w join jsonb_array_elements(p_defaults) e on e.value ->> 'k' = w.item_key
  where w.user_id = v_owner and w.collection = p_collection
    and w.display_date ~* 'tba' and (e.value ->> 'd') !~* 'tba';

  -- S3: inserts. Only defaults whose item_key no row of this tab holds yet (the
  -- tab-open rule: a key held by any row, identified or not, is never added
  -- again); enriched-show defaults among them still join their show.
  select coalesce(jsonb_agg(e.value order by e.ordinality), '[]') into v_missing
  from jsonb_array_elements(p_defaults) with ordinality e
  where not exists (select 1 from public.watchlist_items w
                    where w.user_id = v_owner and w.collection = p_collection and w.item_key = e.value ->> 'k');
  v_ins := private.catalog_insert_missing(v_owner, p_collection, v_missing);

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
    v_film_ids := v_film_ids || x.id;
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

  -- S6: memberships of the records created here. The trigger added the C4
  -- membership; an archived target loses it again (only records created in this
  -- transaction, which nothing else can reference yet).
  for x in select key as id, value #>> '{}' as ref from jsonb_each(v_refs) order by value #>> '{}' collate "C" loop
    v_mem_id := null;
    if v_target.id is not null and v_target.archived_at is not null then
      delete from public.collection_memberships
      where collection_id = v_target.id and (show_id = x.id::uuid or item_id = x.id::uuid);
    elsif v_target.id is not null then
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
  for d in select * from jsonb_array_elements(p_defaults) loop
    if exists (select 1 from jsonb_array_elements(v_entries) e
               where e ->> 'item_key' = d ->> 'k' and e ->> 'kind' in ('insert_season', 'insert_film', 'fill_date', 'excluded_conflict')) then
      continue;
    end if;
    v_entries := v_entries || jsonb_build_object('kind', 'noop', 'key', 'noop:' || (d ->> 'k'), 'item_key', d -> 'k',
      'category', case when exists (select 1 from public.watchlist_items w where w.user_id = v_owner and w.collection = p_collection
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
  if exists (select 1 from jsonb_array_elements(v_fills) ff join public.watchlist_items w on w.id = (ff ->> 'row_id')::uuid
             where w.display_date is distinct from ff ->> 'new_display' or w.date_sort is distinct from ff ->> 'new_sort') then
    raise exception 'integrity_fault: a date fill did not hold' using errcode = '23000';
  end if;

  select coalesce(jsonb_agg(e order by case e ->> 'kind' when 'create_show' then 1 when 'attach' then 2 when 'insert_season' then 3
                    when 'insert_film' then 4 when 'fill_date' then 5 when 'reopen' then 6 when 'membership' then 7
                    when 'excluded_conflict' then 8 else 9 end, e ->> 'key' collate "C"), '[]')
    into v_entries from jsonb_array_elements(v_entries) e;
  v_doc := jsonb_build_object('version', '4a.1', 'owner', v_owner, 'collection', p_collection, 'payload_hash', v_payload_hash,
    'target', case when v_target.id is null then null else jsonb_build_object('collection_id', v_target.id, 'archived', v_target.archived_at is not null) end,
    'entries', v_entries);
  return jsonb_build_object('document', v_doc, 'hash', private.catalog_hash(v_doc), 'receipt', v_receipt);
end $function$;
revoke all on function private.catalog_run(text,jsonb) from public, anon, authenticated, service_role;
grant execute on function private.catalog_run(text,jsonb) to anon;
grant execute on function private.catalog_run(text,jsonb) to authenticated;
CREATE OR REPLACE FUNCTION private.lib_add_to_show(p_show tv_shows, p_network text, p_seasons jsonb, p_by_number boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$;
revoke all on function private.lib_add_to_show(tv_shows,text,jsonb,boolean) from public, anon, authenticated, service_role;
grant execute on function private.lib_add_to_show(tv_shows,text,jsonb,boolean) to anon;
grant execute on function private.lib_add_to_show(tv_shows,text,jsonb,boolean) to authenticated;
CREATE OR REPLACE FUNCTION private.lib_catalog_insert(p_owner uuid, p_catalog text, p_defaults jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$ select private.catalog_insert_missing(p_owner, p_catalog, p_defaults) $function$;
revoke all on function private.lib_catalog_insert(uuid,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function private.lib_catalog_insert(uuid,text,jsonb) to anon;
grant execute on function private.lib_catalog_insert(uuid,text,jsonb) to authenticated;
CREATE OR REPLACE FUNCTION private.lib_catalog_target(p_owner uuid, p_catalog text)
 RETURNS personal_collections
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select * from public.personal_collections where user_id = p_owner and legacy_source = p_catalog
$function$;
revoke all on function private.lib_catalog_target(uuid,text) from public, anon, authenticated, service_role;
grant execute on function private.lib_catalog_target(uuid,text) to anon;
grant execute on function private.lib_catalog_target(uuid,text) to authenticated;
CREATE OR REPLACE FUNCTION private.lib_film_catalog(p_item_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select w.collection from public.watchlist_items w where w.id = p_item_id and w.is_film and w.collection = any(private.lib_catalogs())
$function$;
revoke all on function private.lib_film_catalog(uuid) from public, anon, authenticated, service_role;
grant execute on function private.lib_film_catalog(uuid) to anon;
grant execute on function private.lib_film_catalog(uuid) to authenticated;
CREATE OR REPLACE FUNCTION private.lib_film_match_update(p_row_id uuid, p_patch jsonb, p_tmdb integer, p_coll_id integer, p_kind text)
 RETURNS watchlist_items
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$;
revoke all on function private.lib_film_match_update(uuid,jsonb,integer,integer,text) from public, anon, authenticated, service_role;
grant execute on function private.lib_film_match_update(uuid,jsonb,integer,integer,text) to anon;
grant execute on function private.lib_film_match_update(uuid,jsonb,integer,integer,text) to authenticated;
CREATE OR REPLACE FUNCTION private.lib_film_theme_kind(p_item_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case when not w.is_film then null when w.collection = 'movies' then 'genre' else 'other' end
  from public.watchlist_items w where w.id = p_item_id
$function$;
revoke all on function private.lib_film_theme_kind(uuid) from public, anon, authenticated, service_role;
grant execute on function private.lib_film_theme_kind(uuid) to anon;
grant execute on function private.lib_film_theme_kind(uuid) to authenticated;
CREATE OR REPLACE FUNCTION private.lib_insert_film(p_owner uuid, f jsonb, p_kind text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$;
revoke all on function private.lib_insert_film(uuid,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function private.lib_insert_film(uuid,jsonb,text) to anon;
grant execute on function private.lib_insert_film(uuid,jsonb,text) to authenticated;
CREATE OR REPLACE FUNCTION private.lib_match_season_core(p_row watchlist_items, p_target jsonb, p_patch jsonb, p_expansion jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  -- (A film stored with the films has a genre theme; library_match_season refuses it first.)
  if exists (select 1 from public.tv_shows where user_id = p_row.user_id and tmdb_id = (p_target ->> 'tmdb_id')::integer
             and collection is distinct from p_row.collection) then
    perform private.lib_refuse('match_conflict', 'This TMDB show is already on your list in a part this update can''t join yet, so nothing was matched.');
  end if;
  return public.match_tv_row(p_row.id, p_target, p_patch, coalesce(p_expansion, '{}'::jsonb));
end $function$;
revoke all on function private.lib_match_season_core(watchlist_items,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function private.lib_match_season_core(watchlist_items,jsonb,jsonb,jsonb) to anon;
grant execute on function private.lib_match_season_core(watchlist_items,jsonb,jsonb,jsonb) to authenticated;
CREATE OR REPLACE FUNCTION private.lib_new_show_row(p_owner uuid, p_title text, p_key text, p_tmdb integer, p_status text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v uuid;
begin
  insert into public.tv_shows (collection, title, show_key, tmdb_id, status)
  values ('othertv', p_title, p_key, p_tmdb, p_status)
  on conflict do nothing
  returning id into v;
  return v;
end $function$;
revoke all on function private.lib_new_show_row(uuid,text,text,integer,text) from public, anon, authenticated, service_role;
grant execute on function private.lib_new_show_row(uuid,text,text,integer,text) to anon;
grant execute on function private.lib_new_show_row(uuid,text,text,integer,text) to authenticated;
CREATE OR REPLACE FUNCTION private.lib_set_theme_kind(p_item_id uuid, p_kind text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if p_kind is distinct from private.lib_film_theme_kind(p_item_id) then
    raise exception 'integrity_fault: theme kind % does not match where the film is stored', p_kind using errcode = '23000';
  end if;
end $function$;
revoke all on function private.lib_set_theme_kind(uuid,text) from public, anon, authenticated, service_role;
grant execute on function private.lib_set_theme_kind(uuid,text) to anon;
grant execute on function private.lib_set_theme_kind(uuid,text) to authenticated;
CREATE OR REPLACE FUNCTION private.lib_show_catalog(p_show_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select s.collection from public.tv_shows s where s.id = p_show_id and s.collection = any(private.lib_catalogs())
$function$;
revoke all on function private.lib_show_catalog(uuid) from public, anon, authenticated, service_role;
grant execute on function private.lib_show_catalog(uuid) to anon;
grant execute on function private.lib_show_catalog(uuid) to authenticated;
CREATE OR REPLACE FUNCTION private.org_auto_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_coll uuid;
begin
  if tg_op = 'UPDATE' then
    -- A TV season matched as a film keeps every collection its show was in.
    insert into public.collection_memberships (collection_id, item_id)
    select m.collection_id, new.id from public.collection_memberships m where m.show_id = old.show_id
    on conflict (collection_id, item_id) where (item_id is not null) do nothing;
    return null;
  end if;
  select c.id into v_coll from public.personal_collections c
  where c.user_id = new.user_id and c.legacy_source = new.collection;
  if v_coll is null then return null; end if;
  if tg_table_name = 'tv_shows' then
    insert into public.collection_memberships (collection_id, show_id) values (v_coll, new.id)
    on conflict (collection_id, show_id) where (show_id is not null) do nothing;
  else
    insert into public.collection_memberships (collection_id, item_id) values (v_coll, new.id)
    on conflict (collection_id, item_id) where (item_id is not null) do nothing;
  end if;
  return null;
end $function$;
revoke all on function private.org_auto_membership() from public, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION private.org_bootstrap(p_owner uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_config text[] := array['Alone', 'Suzanne', 'Rina', 'Whole Family'];
  v jsonb;
begin
  if exists (select 1 from public.personal_collections where user_id = p_owner)
     or exists (select 1 from public.watch_with_choices where user_id = p_owner) then
    raise exception 'org_bootstrap: owner % already has organization data', p_owner;
  end if;
  insert into public.personal_collections (user_id, name, legacy_source, sort_order)
  values (p_owner, 'Disney+', 'disney', 1), (p_owner, 'Sheridan', 'sheridan', 2),
         (p_owner, '90 Day', '90day', 3), (p_owner, 'True Crime / Docs', 'truecrime', 4);
  insert into public.collection_memberships (user_id, collection_id, show_id)
  select p_owner, c.id, s.id from public.tv_shows s
  join public.personal_collections c on c.user_id = p_owner and c.legacy_source = s.collection
  where s.user_id = p_owner;
  insert into public.collection_memberships (user_id, collection_id, item_id)
  select p_owner, c.id, w.id from public.watchlist_items w
  join public.personal_collections c on c.user_id = p_owner and c.legacy_source = w.collection
  where w.user_id = p_owner and w.is_film;

  if exists (
    select 1 from (select distinct t from (select unnest(v_config) t union
                   select unnest(watch_with) from public.watchlist_items where user_id = p_owner) x) y
    group by lower(t) having count(*) > 1
  ) then
    raise exception 'org_bootstrap: watch-with values differ only by case; an owner decision is needed';
  end if;
  insert into public.watch_with_choices (user_id, token, label, sort_order)
  select p_owner, t, t, row_number() over (order by k, lower(t), t)
  from (
    select t, array_position(v_config, t) k from unnest(v_config) t
    union
    select t, null from (select distinct unnest(watch_with) t from public.watchlist_items where user_id = p_owner) a
    where not (t = any(v_config))
  ) x;

  v := jsonb_build_object(
    'collections', (select count(*) from public.personal_collections where user_id = p_owner),
    'show_memberships', (select count(*) from public.collection_memberships where user_id = p_owner and show_id is not null),
    'film_memberships', (select count(*) from public.collection_memberships where user_id = p_owner and item_id is not null),
    'watch_with_choices', (select count(*) from public.watch_with_choices where user_id = p_owner));
  return v;
end $function$;
revoke all on function private.org_bootstrap(uuid) from public, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION private.tv_add_to_enriched_show(p_show_id uuid, p_seasons jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    -- The row this item_key already names, if any: checked before the label rule,
    -- so a season already on the show with its identity is a no-op even when its
    -- label is nonstandard (it must carry the same label and a season number).
    select * into v_row from public.watchlist_items
    where user_id = p_show.user_id and collection = p_show.collection and item_key = s ->> 'item_key'
    order by id limit 1;
    if found and v_row.show_id = p_show.id and v_row.media_type = 'tv' and v_row.tmdb_id = p_show.tmdb_id
       and v_row.season_number is not null
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
    where user_id = p_show.user_id and collection = p_show.collection and media_type = 'tv'
      and tmdb_id = p_show.tmdb_id and season_number = v_num;
    if found then
      v_rejected := v_rejected || jsonb_build_object('item_key', s ->> 'item_key', 'season', s ->> 'season',
        'reason', 'identity_conflict', 'conflicting_row_id', v_conflict);
      continue;
    end if;
    r := null;
    insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched,
      status, media_type, tmdb_id, season_number, show_id)
    values (p_show.collection, s ->> 'item_key', s ->> 'title', s ->> 'season', coalesce(s ->> 'theme', ''),
      coalesce(s ->> 'display_date', ''), s ->> 'date_sort', false, coalesce(s ->> 'status', 'confirmed'),
      'tv', p_show.tmdb_id, v_num, p_show.id)
    on conflict do nothing
    returning * into r;
    if r.id is not null then v_inserted := v_inserted || r.id;
    else v_rejected := v_rejected || jsonb_build_object('item_key', s ->> 'item_key', 'season', s ->> 'season', 'reason', 'identity_conflict');
    end if;
  end loop;
  return jsonb_build_object('inserted', to_jsonb(v_inserted), 'existing', v_existing, 'rejected', v_rejected);
end $function$;
revoke all on function private.tv_add_to_enriched_show(uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function private.tv_add_to_enriched_show(uuid,jsonb) to anon;
grant execute on function private.tv_add_to_enriched_show(uuid,jsonb) to authenticated;
CREATE OR REPLACE FUNCTION private.tv_backfill(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$;
revoke all on function private.tv_backfill(uuid) from public, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION private.tv_builtin_collections()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$ select array['disney', '90day', 'sheridan']::text[] $function$;
revoke all on function private.tv_builtin_collections() from public, anon, authenticated, service_role;
grant execute on function private.tv_builtin_collections() to anon;
grant execute on function private.tv_builtin_collections() to authenticated;
CREATE OR REPLACE FUNCTION private.tv_collections()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select array['disney', '90day', 'sheridan', 'othertv', 'truecrime']::text[]
$function$;
revoke all on function private.tv_collections() from public, anon, authenticated, service_role;
grant execute on function private.tv_collections() to anon;
grant execute on function private.tv_collections() to authenticated;
CREATE OR REPLACE FUNCTION private.tv_enrich_show(p_show_id uuid, p_expected_title text, p_tmdb_id integer, p_seasons jsonb, p_apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_owner uuid := (select bootstrap_owner_id from private.app_owner);
  v_show public.tv_shows;
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
  select id into v_conflict from public.tv_shows
  where user_id = v_show.user_id and collection = v_show.collection and tmdb_id = p_tmdb_id;
  if found then raise exception 'enrich: TMDB % is already show % in %', p_tmdb_id, v_conflict, v_show.collection; end if;

  if jsonb_typeof(p_seasons) is distinct from 'array' then raise exception 'enrich: seasons must be a list'; end if;
  for e in select * from jsonb_array_elements(p_seasons) loop
    begin v_n := (e ->> 'season_number')::int;
    exception when others then raise exception 'enrich: season_number in %', e; end;
    if v_n is null or v_n < 0 then raise exception 'enrich: season_number in %', e; end if;
    select * into r from public.watchlist_items where id = (e ->> 'row_id')::uuid for update;
    if not found then raise exception 'enrich: row % not found', e ->> 'row_id'; end if;
    if r.show_id is distinct from v_show.id or r.user_id is distinct from v_show.user_id or r.collection is distinct from v_show.collection then
      raise exception 'enrich: row % is not a season of "%"', r.id, v_show.title;
    end if;
    if r.season is distinct from (e ->> 'season') then
      raise exception 'enrich: row % is "%", not "%"', r.id, r.season, e ->> 'season';
    end if;
    if r.media_type is not null or r.tmdb_id is not null or r.season_number is not null
       or not private.tv_is_tv_row(r.collection, r.media_type, r.season) then
      raise exception 'enrich: row % is not a legacy TV season', r.id;
    end if;
    if r.id = any(v_rows) then raise exception 'enrich: row % listed twice', r.id; end if;
    if v_n = any(v_nums) then raise exception 'enrich: season_number % listed twice', v_n; end if;
    select id into v_conflict from public.watchlist_items
    where user_id = r.user_id and collection = r.collection and media_type = 'tv' and tmdb_id = p_tmdb_id and season_number = v_n;
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

  return jsonb_build_object('applied', p_apply, 'show_id', v_show.id, 'title', v_show.title, 'collection', v_show.collection,
    'status', v_show.status, 'tmdb_id', p_tmdb_id, 'seasons', v_plan);
end $function$;
revoke all on function private.tv_enrich_show(uuid,text,integer,jsonb,boolean) from public, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION private.tv_enriched_show_for(p_owner uuid, p_collection text, p_show_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v uuid; v_n int;
begin
  if not (p_collection = any(private.tv_builtin_collections())) then return null; end if;
  select count(*) into v_n from public.tv_shows
  where user_id = p_owner and collection = p_collection and show_key = p_show_key and tmdb_id is not null;
  if v_n = 0 then return null; end if;
  if v_n > 1 then raise exception 'integrity_fault: % TMDB-matched shows share the key %', v_n, p_show_key using errcode = '23000'; end if;
  select id into v from public.tv_shows
  where user_id = p_owner and collection = p_collection and show_key = p_show_key and tmdb_id is not null for update;
  return v;
end $function$;
revoke all on function private.tv_enriched_show_for(uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function private.tv_enriched_show_for(uuid,text,text) to anon;
grant execute on function private.tv_enriched_show_for(uuid,text,text) to authenticated;
CREATE OR REPLACE FUNCTION private.tv_is_tv_row(p_collection text, p_media_type text, p_season text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  -- Never null, so "not tv_is_tv_row(...)" is safe for legacy rows (media_type null).
  select coalesce(p_collection = any(private.tv_collections()), false)
     and (coalesce(p_media_type = 'tv', false) or (p_media_type is null and coalesce(p_season, '') <> 'Film'))
$function$;
revoke all on function private.tv_is_tv_row(text,text,text) from public, anon, authenticated, service_role;
grant execute on function private.tv_is_tv_row(text,text,text) to anon;
grant execute on function private.tv_is_tv_row(text,text,text) to authenticated;
CREATE OR REPLACE FUNCTION private.tv_lock_or_create_show(p_owner uuid, p_collection text, p_tmdb_id integer, p_show_key text, p_title text, p_initial_status text)
 RETURNS TABLE(show_id uuid, created boolean)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_id uuid;
begin
  for attempt in 1..2 loop
    if p_tmdb_id is not null then
      select id into v_id from public.tv_shows
      where user_id = p_owner and collection = p_collection and tmdb_id = p_tmdb_id for update;
    else
      select id into v_id from public.tv_shows
      where user_id = p_owner and collection = p_collection and tmdb_id is null and show_key = p_show_key for update;
    end if;
    if v_id is not null then show_id := v_id; created := false; return next; return; end if;
    if attempt = 1 then
      insert into public.tv_shows (collection, title, show_key, tmdb_id, status)
      values (p_collection, p_title, p_show_key, p_tmdb_id, p_initial_status)
      on conflict do nothing
      returning id into v_id;
      if v_id is not null then show_id := v_id; created := true; return next; return; end if;
    end if;
  end loop;
  raise exception 'integrity_fault: could not create or find show %', p_show_key using errcode = '23000';
end $function$;
revoke all on function private.tv_lock_or_create_show(uuid,text,integer,text,text,text) from public, anon, authenticated, service_role;
grant execute on function private.tv_lock_or_create_show(uuid,text,integer,text,text,text) to anon;
grant execute on function private.tv_lock_or_create_show(uuid,text,integer,text,text,text) to authenticated;
CREATE OR REPLACE FUNCTION private.tv_show_key(p_collection text, p_item_key text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select coalesce(private.tv_show_key_override(p_collection, split_part(coalesce(p_item_key, ''), '|', 1)),
                  split_part(coalesce(p_item_key, ''), '|', 1))
$function$;
revoke all on function private.tv_show_key(text,text) from public, anon, authenticated, service_role;
grant execute on function private.tv_show_key(text,text) to anon;
grant execute on function private.tv_show_key(text,text) to authenticated;
CREATE OR REPLACE FUNCTION private.tv_show_key_override(p_collection text, p_prefix text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select v.show_key
  from (values ('disney', 'the clone wars', 'star wars: the clone wars (2008)')) as v(collection, prefix, show_key)
  where v.collection = p_collection and v.prefix = p_prefix
$function$;
revoke all on function private.tv_show_key_override(text,text) from public, anon, authenticated, service_role;
grant execute on function private.tv_show_key_override(text,text) to anon;
grant execute on function private.tv_show_key_override(text,text) to authenticated;
CREATE OR REPLACE FUNCTION public.add_tv_seasons(p_collection text, p_show jsonb, p_seasons jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('add_tv_seasons', 'shadow', 'authoritative', 'final');
  v_tmdb integer;
  v_title text := btrim(coalesce(p_show ->> 'title', ''));
  v_key text := coalesce(p_show ->> 'show_key', '');
  v_init text := coalesce(p_show ->> 'initial_status', 'confirmed');
  v_network text := coalesce(p_show ->> 'network', '');
  v_show public.tv_shows;
  v_show_id uuid;
  v_created boolean;
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
  begin v_tmdb := (p_show ->> 'tmdb_id')::integer;
  exception when others then raise exception 'invalid_input: show tmdb_id' using errcode = '22023'; end;
  if p_collection is null or not (p_collection = any(private.tv_collections())) then
    raise exception 'invalid_input: % is not a TV collection', p_collection using errcode = '22023';
  end if;
  if v_title = '' or btrim(v_key) = '' then raise exception 'invalid_input: show title and show_key are required' using errcode = '22023'; end if;
  if not private.tv_valid_status(v_init) then raise exception 'invalid_input: initial_status %', v_init using errcode = '22023'; end if;
  if jsonb_typeof(p_seasons) is distinct from 'array' or jsonb_array_length(p_seasons) = 0 then
    raise exception 'invalid_input: seasons must be a non-empty list' using errcode = '22023';
  end if;

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
      if s ->> 'season' = 'Film' or private.tv_show_key(p_collection, s ->> 'item_key') <> v_key then
        raise exception 'invalid_input: season % does not belong to show %', s ->> 'item_key', v_key using errcode = '22023';
      end if;
      v_ident := s ->> 'item_key';
    end if;
    if v_ident = any(v_seen) then raise exception 'invalid_input: season % requested twice', v_ident using errcode = '22023'; end if;
    v_seen := v_seen || v_ident;
  end loop;

  -- A legacy-keyed season of an enriched built-in show joins that show.
  if v_tmdb is null then
    v_show_id := private.tv_enriched_show_for(v_owner, p_collection, v_key);
    if v_show_id is not null then
      select * into v_show from public.tv_shows where id = v_show_id;
      v_enriched := private.tv_add_to_enriched_show(v_show_id,
        (select jsonb_agg(x - 'season_number') from jsonb_array_elements(p_seasons) x));
      v_inserted := array(select jsonb_array_elements_text(v_enriched -> 'inserted')::uuid);
      if cardinality(v_inserted) > 0 and v_stage in ('authoritative', 'final') and v_show.status = 'complete' then
        update public.tv_shows set status = 'confirmed' where id = v_show.id;
        v_reopened := true;
      end if;
      if cardinality(v_inserted) > 0 and v_stage = 'authoritative' then perform private.tv_project_legacy_status(v_show.id); end if;
      return jsonb_build_object(
        'show_id', v_show.id, 'show_created', false,
        'inserted', coalesce((select jsonb_agg(to_jsonb(w) order by w.season_number, w.item_key)
                              from public.watchlist_items w where w.id = any(v_inserted)), '[]'),
        'existing', v_enriched -> 'existing', 'rejected', v_enriched -> 'rejected', 'reopened', v_reopened,
        'show_status', (select status from public.tv_shows where id = v_show.id));
    end if;
  end if;

  select show_id, created into v_show_id, v_created
  from private.tv_lock_or_create_show(v_owner, p_collection, v_tmdb, v_key, v_title, v_init);
  select * into v_show from public.tv_shows where id = v_show_id;

  for s in select * from jsonb_array_elements(p_seasons) loop
    v_num := (s ->> 'season_number')::integer;
    if v_tmdb is not null then
      select * into r from public.watchlist_items
      where user_id = v_owner and collection = p_collection and media_type = 'tv' and tmdb_id = v_tmdb and season_number = v_num;
    else
      select * into r from public.watchlist_items
      where user_id = v_owner and collection = p_collection and tmdb_id is null and item_key = s ->> 'item_key';
    end if;
    if found then
      if r.show_id is not null and r.show_id <> v_show.id then
        raise exception 'integrity_fault: season % is linked to a different show', r.id using errcode = '23000';
      end if;
      v_existing := v_existing || jsonb_build_object('season_number', v_num, 'item_key', r.item_key, 'id', r.id);
      continue;
    end if;

    -- A row with the same key but the other kind of identity: report, don't guess.
    select id into v_conflict from public.watchlist_items
    where user_id = v_owner and collection = p_collection and item_key = s ->> 'item_key'
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
      insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched,
        status, media_type, tmdb_id, season_number, show_id)
      values (p_collection, s ->> 'item_key', s ->> 'title', s ->> 'season', coalesce(s ->> 'theme', ''),
        coalesce(s ->> 'display_date', ''), s ->> 'date_sort', false, 'confirmed', 'tv', v_tmdb, v_num, v_show.id)
      on conflict (user_id, collection, media_type, tmdb_id, season_number)
        where ((media_type = 'tv'::text) and (tmdb_id is not null) and (season_number is not null)) do nothing
      returning * into r;
    else
      insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched,
        status, show_id)
      values (p_collection, s ->> 'item_key', s ->> 'title', s ->> 'season', coalesce(s ->> 'theme', ''),
        coalesce(s ->> 'display_date', ''), s ->> 'date_sort', false, 'confirmed', v_show.id)
      on conflict (user_id, collection, item_key) where (tmdb_id is null) do nothing
      returning * into r;
    end if;
    if r.id is not null then
      v_inserted := v_inserted || r.id;
    else
      -- Added by a concurrent call between the check and the insert.
      select id into v_conflict from public.watchlist_items
      where user_id = v_owner and collection = p_collection
        and (case when v_tmdb is not null then media_type = 'tv' and tmdb_id = v_tmdb and season_number = v_num
                  else tmdb_id is null and item_key = s ->> 'item_key' end);
      v_existing := v_existing || jsonb_build_object('season_number', v_num, 'item_key', s ->> 'item_key', 'id', v_conflict);
    end if;
  end loop;

  if cardinality(v_inserted) > 0 and v_stage in ('authoritative', 'final') and v_show.status = 'complete' then
    update public.tv_shows set status = 'confirmed' where id = v_show.id;
    v_reopened := true;
  end if;
  if v_tmdb is not null and v_stage in ('shadow', 'authoritative') then
    insert into public.othertv_shows (tmdb_id, title, network, collection)
    values (v_tmdb, v_title, v_network, p_collection)
    on conflict (user_id, collection, tmdb_id) do nothing;
  end if;
  if v_stage = 'authoritative' then perform private.tv_project_legacy_status(v_show.id); end if;

  return jsonb_build_object(
    'show_id', v_show.id, 'show_created', v_created,
    'inserted', coalesce((select jsonb_agg(to_jsonb(w) order by w.season_number, w.item_key)
                          from public.watchlist_items w where w.id = any(v_inserted)), '[]'),
    'existing', v_existing, 'rejected', v_rejected, 'reopened', v_reopened,
    'show_status', (select status from public.tv_shows where id = v_show.id));
end $function$;
revoke all on function add_tv_seasons(text,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function add_tv_seasons(text,jsonb,jsonb) to anon;
grant execute on function add_tv_seasons(text,jsonb,jsonb) to authenticated;
grant execute on function add_tv_seasons(text,jsonb,jsonb) to service_role;
CREATE OR REPLACE FUNCTION public.add_tv_seasons_to_show(p_show_id uuid, p_expected jsonb, p_seasons jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('add_tv_seasons_to_show', 'final');
  v_show public.tv_shows;
  v_exp_tmdb integer;
  v_by_number boolean;
  v_has_number boolean;
  s jsonb;
  v_res jsonb;
begin
  if p_show_id is null or jsonb_typeof(p_expected) is distinct from 'object'
     or coalesce(p_expected ->> 'collection', '') = '' or coalesce(p_expected ->> 'show_key', '') = '' then
    raise exception 'invalid_input: the show id and the show as the page showed it (collection, tmdb_id, show_key) are required'
      using errcode = '22023';
  end if;
  begin v_exp_tmdb := (p_expected ->> 'tmdb_id')::integer;
  exception when others then raise exception 'invalid_input: expected tmdb_id' using errcode = '22023'; end;
  if jsonb_typeof(p_seasons) is distinct from 'array' or jsonb_array_length(p_seasons) = 0 then
    raise exception 'invalid_input: seasons must be a non-empty list' using errcode = '22023';
  end if;

  -- The show, locked (the same row lock add_tv_seasons, delete_tv_season and
  -- match_tv_row take), then compared with what the page showed.
  select * into v_show from public.tv_shows where id = p_show_id and user_id = v_owner for update;
  if not found then
    raise exception 'target_missing: This show is no longer on your list, so nothing was added.' using errcode = 'P0001';
  end if;
  if v_show.collection is distinct from p_expected ->> 'collection' or v_show.tmdb_id is distinct from v_exp_tmdb
     or v_show.show_key is distinct from p_expected ->> 'show_key' then
    raise exception 'target_changed: This show changed since you chose it, so nothing was added. Look at it again.' using errcode = 'P0001';
  end if;

  -- TMDB seasons only for an identified show outside the built-in catalogs.
  v_by_number := v_show.tmdb_id is not null and not (v_show.collection = any(private.tv_builtin_collections()));
  for s in select * from jsonb_array_elements(p_seasons) loop
    v_has_number := jsonb_typeof(s) = 'object' and s ? 'season_number' and s -> 'season_number' <> 'null'::jsonb;
    if v_has_number <> v_by_number then
      raise exception 'invalid_input: this show takes %', case when v_by_number then 'TMDB seasons (season_number)' else 'seasons by label (no season_number)' end
        using errcode = '22023';
    end if;
  end loop;

  v_res := public.add_tv_seasons(v_show.collection,
    jsonb_build_object('tmdb_id', case when v_by_number then v_show.tmdb_id end, 'title', v_show.title,
                       'show_key', v_show.show_key, 'network', coalesce(p_expected ->> 'network', '')),
    p_seasons);

  -- Kept only if the seasons went to this show and no show was created; otherwise
  -- the whole call (and anything it wrote) is rolled back.
  if (v_res ->> 'show_id') is distinct from p_show_id::text or coalesce((v_res ->> 'show_created')::boolean, true) then
    raise exception 'target_changed: These seasons would not have been added to the show you chose, so nothing was added. Look at it again.'
      using errcode = 'P0001';
  end if;
  return v_res;
end $function$;
revoke all on function add_tv_seasons_to_show(uuid,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function add_tv_seasons_to_show(uuid,jsonb,jsonb) to anon;
grant execute on function add_tv_seasons_to_show(uuid,jsonb,jsonb) to authenticated;
grant execute on function add_tv_seasons_to_show(uuid,jsonb,jsonb) to service_role;
CREATE OR REPLACE FUNCTION public.catalog_apply(p_collection text, p_defaults jsonb, p_approved text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$;
revoke all on function catalog_apply(text,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function catalog_apply(text,jsonb,text) to anon;
grant execute on function catalog_apply(text,jsonb,text) to authenticated;
grant execute on function catalog_apply(text,jsonb,text) to service_role;
CREATE OR REPLACE FUNCTION public.create_tv_show(p_show jsonb, p_seasons jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('create_tv_show', 'final');
  v_coll constant text := 'othertv'; -- where new shows go (library.js LIBRARY_NEW_TV)
  v_tmdb integer;
  v_title text := btrim(coalesce(p_show ->> 'title', ''));
  v_key text := btrim(coalesce(p_show ->> 'show_key', ''));
  v_init text := coalesce(p_show ->> 'initial_status', 'confirmed');
  v_id uuid;
  v_res jsonb;
begin
  if jsonb_typeof(p_show) is distinct from 'object' then raise exception 'invalid_input: show' using errcode = '22023'; end if;
  begin v_tmdb := (p_show ->> 'tmdb_id')::integer;
  exception when others then raise exception 'invalid_input: show tmdb_id' using errcode = '22023'; end;
  if v_title = '' or v_key = '' then raise exception 'invalid_input: show title and show_key are required' using errcode = '22023'; end if;
  if not private.tv_valid_status(v_init) then raise exception 'invalid_input: initial_status %', v_init using errcode = '22023'; end if;
  if jsonb_typeof(p_seasons) is distinct from 'array' or jsonb_array_length(p_seasons) = 0 then
    raise exception 'invalid_input: seasons must be a non-empty list' using errcode = '22023';
  end if;

  -- A show with this TMDB identity anywhere in the library is not new.
  if v_tmdb is not null and exists (select 1 from public.tv_shows where user_id = v_owner and tmdb_id = v_tmdb) then
    raise exception 'show_exists: This show is already on your list, so nothing was added. Look at it again.' using errcode = 'P0001';
  end if;
  -- The new show, or nothing: the unique show indexes refuse a second show with this
  -- identity or (unmatched) key where new shows go, including one being added at this
  -- moment (the insert waits for it, then does nothing).
  insert into public.tv_shows (collection, title, show_key, tmdb_id, status)
  values (v_coll, v_title, v_key, v_tmdb, v_init)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    raise exception 'show_exists: This show is already on your list, so nothing was added. Look at it again.' using errcode = 'P0001';
  end if;

  -- Its seasons, by add_tv_seasons' own rules, all of them or none.
  v_res := public.add_tv_seasons(v_coll,
    jsonb_build_object('tmdb_id', v_tmdb, 'title', v_title, 'show_key', v_key, 'network', coalesce(p_show ->> 'network', '')), p_seasons);
  if (v_res ->> 'show_id') is distinct from v_id::text
     or jsonb_array_length(coalesce(v_res -> 'inserted', '[]'::jsonb)) <> jsonb_array_length(p_seasons) then
    raise exception 'create_conflict: Not every season could be added to the new show, so nothing was added. Look at it again.' using errcode = 'P0001';
  end if;
  return v_res || jsonb_build_object('show_created', true);
end $function$;
revoke all on function create_tv_show(jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function create_tv_show(jsonb,jsonb) to anon;
grant execute on function create_tv_show(jsonb,jsonb) to authenticated;
grant execute on function create_tv_show(jsonb,jsonb) to service_role;
CREATE OR REPLACE FUNCTION public.delete_tv_season(p_row_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('delete_tv_season', 'shadow', 'authoritative', 'final');
  r public.watchlist_items;
  v_show public.tv_shows;
  v_show_deleted boolean := false;
begin
  select * into r from public.watchlist_items
  where id = p_row_id and user_id = v_owner and private.tv_is_tv_row(collection, media_type, season);
  if r.id is null then raise exception 'not_found: TV season' using errcode = 'P0002'; end if;
  if r.show_id is not null then
    select * into v_show from public.tv_shows where id = r.show_id and user_id = v_owner for update;
  end if;
  delete from public.watchlist_items where id = r.id and user_id = v_owner;
  if v_show.id is not null then
    if not exists (select 1 from public.watchlist_items where show_id = v_show.id) then
      delete from public.tv_shows where id = v_show.id and user_id = v_owner;
      v_show_deleted := true;
      if v_show.tmdb_id is not null and v_stage in ('shadow', 'authoritative') then
        delete from public.othertv_shows
        where user_id = v_owner and collection = v_show.collection and tmdb_id = v_show.tmdb_id;
      end if;
    elsif v_stage = 'authoritative' then
      perform private.tv_project_legacy_status(v_show.id);
    end if;
  end if;
  return jsonb_build_object('deleted_row_id', r.id, 'show_id', v_show.id, 'show_deleted', v_show_deleted);
end $function$;
revoke all on function delete_tv_season(uuid) from public, anon, authenticated, service_role;
grant execute on function delete_tv_season(uuid) to anon;
grant execute on function delete_tv_season(uuid) to authenticated;
grant execute on function delete_tv_season(uuid) to service_role;
CREATE OR REPLACE FUNCTION public.match_tv_row(p_row_id uuid, p_target jsonb, p_patch jsonb, p_expansion jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('match_tv_row', 'final');
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
  -- Every lock below waits at most 5 s (then this call fails and changes nothing).
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
  where id = p_row_id and user_id = v_owner and collection = any(private.tv_collections())
    and tmdb_id is null and media_type is null and season_number is null;
  if r.id is null then raise exception 'not_found: unidentified row' using errcode = 'P0002'; end if;

  select id into v_conflict from public.watchlist_items
  where user_id = v_owner and collection = r.collection and media_type = 'tv' and tmdb_id = v_tmdb and season_number = v_num;
  if found then raise exception 'match_conflict: identity already on the list as row %', v_conflict using errcode = '23505'; end if;
  select id into v_conflict from public.watchlist_items
  where user_id = v_owner and collection = r.collection and tmdb_id is null and item_key = p_patch ->> 'item_key' and id <> r.id;
  if found then raise exception 'match_conflict: item_key already used by row %', v_conflict using errcode = '23505'; end if;

  if r.show_id is not null then
    select * into v_l from public.tv_shows where id = r.show_id and user_id = v_owner for update;
  end if;
  select * into v_t from public.tv_shows
  where user_id = v_owner and collection = r.collection and tmdb_id = v_tmdb for update;
  -- Lock order as everywhere else: shows (above), then the row. No table lock on
  -- memberships: a membership added to the row or either show waits for these row
  -- locks (its foreign-key check); one removed meanwhile is caught below, because
  -- the exact membership rows read here must still exist when this call finishes
  -- (otherwise match_conflict 40001: nothing is changed and the page can try again).
  select * into r from public.watchlist_items
  where id = r.id and tmdb_id is null and media_type is null and season_number is null for update;
  if r.id is null then raise exception 'match_conflict: the row changed; try again' using errcode = '40001'; end if;

  -- The collections the row is visible in now (a film's own, or its show's), and
  -- the target show's, by membership row.
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
    insert into public.tv_shows (collection, title, show_key, tmdb_id, status)
    values (r.collection, btrim(p_patch ->> 'title'), v_key, v_tmdb, coalesce(v_l.status, 'confirmed'))
    returning id into v_target_show;
    v_created := true;
  end if;

  -- Memberships move with the row (none of this runs for an in-place match).
  if v_created then
    delete from public.collection_memberships where show_id = v_target_show; -- the trigger's default, if any
  end if;
  if v_target_show is distinct from v_l.id then
    insert into public.collection_memberships (collection_id, show_id)
    select c, v_target_show from unnest(v_visible) c
    on conflict (collection_id, show_id) where (show_id is not null) do nothing;
  end if;
  if r.is_film then
    -- Before it stops being a film; exactly the memberships read above must go.
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
    date_sort = p_patch ->> 'date_sort', media_type = 'tv', tmdb_id = v_tmdb, season_number = v_num, show_id = v_target_show
  where id = r.id and user_id = v_owner and tmdb_id is null and media_type is null and season_number is null
  returning * into r;
  if r.id is null then raise exception 'match_conflict: the row changed; try again' using errcode = '40001'; end if;

  if v_l.id is not null and v_l.id <> v_target_show and not exists (select 1 from public.watchlist_items where show_id = v_l.id) then
    delete from public.tv_shows where id = v_l.id;
  end if;
  return jsonb_build_object('blocked', false, 'row', to_jsonb(r) - 'is_film', 'show_id', v_target_show);
end $function$;
revoke all on function match_tv_row(uuid,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function match_tv_row(uuid,jsonb,jsonb,jsonb) to anon;
grant execute on function match_tv_row(uuid,jsonb,jsonb,jsonb) to authenticated;
grant execute on function match_tv_row(uuid,jsonb,jsonb,jsonb) to service_role;
CREATE OR REPLACE FUNCTION public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_owner uuid := private.current_owner_id();
  v_version text := p_backup ->> 'formatVersion';
  v_tables jsonb := p_backup -> 'tables';
  v_counts jsonb := p_backup -> 'rowCounts';
  v_expected jsonb := jsonb_build_object(
    'watchlist_items', jsonb_build_array('id','collection','item_key','title','season','theme','display_date',
      'date_sort','watched','status','created_at','watch_with','collections','tmdb_collection_id',
      'tmdb_collection_name','media_type','tmdb_id','season_number','show_id','skipped'),
    'tv_shows', jsonb_build_array('id','collection','title','show_key','tmdb_id','status','created_at'),
    'othertv_shows', jsonb_build_array('id','tmdb_id','title','network','created_at','collection'),
    'custom_collections', jsonb_build_array('id','name','tmdb_person_id','created_at','role'),
    'personal_collections', jsonb_build_array('id','name','legacy_source','sort_order','archived_at','created_at'),
    'collection_memberships', jsonb_build_array('id','collection_id','show_id','item_id','created_at'),
    'watch_with_choices', jsonb_build_array('id','token','label','sort_order','archived_at','created_at'));
  v_table text;
  v_constraint text;
  v_n jsonb := '{}';
  v_k int;
  v_taken boolean;
begin
  if p_backup ->> 'format' is distinct from 'watchlist-tracker-backup' then
    raise exception 'restore_invalid: not a Watchlist backup' using errcode = '22023';
  end if;
  if v_version = '1' then
    raise exception 'restore_invalid: format 1 backups predate TV shows and can no longer be restored' using errcode = '22023';
  elsif v_version = '2' then
    raise exception 'restore_invalid: format 2 backups predate personal collections and can''t be restored here; restore a format 3 backup (made after the personal-collections update) instead'
      using errcode = '22023';
  elsif v_version is distinct from '3' then
    raise exception 'restore_invalid: unsupported backup format %', coalesce(v_version, '(none)') using errcode = '22023';
  end if;
  if private.tv_stage() <> 'final' then
    raise exception 'restore_invalid: format 3 needs stage final, found %', private.tv_stage() using errcode = '22023';
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

  -- EXCLUSIVE (reads continue): it waits for every transaction holding row locks
  -- or writing on these tables to finish, in the same table order the app's
  -- functions use (shows, then rows, then organization), before replacing
  -- anything, so a restore never holds a table while waiting for a row that an
  -- app call holds (5 s timeout; then nothing changes). Other owners' rows are never touched.
  perform set_config('lock_timeout', '5s', true);
  lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
    public.watch_with_choices, public.othertv_shows, public.custom_collections in exclusive mode;

  -- Ids that belong to another owner.
  for v_table in select jsonb_object_keys(v_expected) loop
    execute format('select exists (select 1 from public.%I w join jsonb_array_elements($1) r on w.id = (r ->> ''id'')::uuid
                    where w.user_id <> $2)', v_table)
      into v_taken using v_tables -> v_table, v_owner;
    if v_taken then
      raise exception 'restore_id_collision: this backup contains ids already owned by another user; restoring it would keep those ids and break user isolation, so nothing was changed'
        using errcode = '23505';
    end if;
  end loop;

  delete from public.collection_memberships where user_id = v_owner;
  delete from public.watchlist_items where user_id = v_owner;
  delete from public.tv_shows where user_id = v_owner;
  delete from public.personal_collections where user_id = v_owner;
  delete from public.watch_with_choices where user_id = v_owner;
  delete from public.othertv_shows where user_id = v_owner;
  delete from public.custom_collections where user_id = v_owner;

  begin
    insert into public.watch_with_choices (id, token, label, sort_order, archived_at, created_at)
    select id, token, label, sort_order, archived_at, created_at
    from jsonb_to_recordset(v_tables -> 'watch_with_choices') as x(id uuid, token text, label text, sort_order integer,
      archived_at timestamptz, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('watch_with_choices', v_k);

    insert into public.personal_collections (id, name, legacy_source, sort_order, archived_at, created_at)
    select id, name, legacy_source, sort_order, archived_at, created_at
    from jsonb_to_recordset(v_tables -> 'personal_collections') as x(id uuid, name text, legacy_source text,
      sort_order integer, archived_at timestamptz, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('personal_collections', v_k);

    insert into public.tv_shows (id, collection, title, show_key, tmdb_id, status, created_at)
    select id, collection, title, show_key, tmdb_id, status, created_at
    from jsonb_to_recordset(v_tables -> 'tv_shows') as x(id uuid, collection text, title text, show_key text,
      tmdb_id integer, status text, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('tv_shows', v_k);

    insert into public.watchlist_items (id, collection, item_key, title, season, theme, display_date, date_sort,
      watched, status, created_at, watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type,
      tmdb_id, season_number, show_id, skipped)
    select id, collection, item_key, title, season, theme, display_date, date_sort, watched, status, created_at,
      watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number,
      show_id, skipped
    from jsonb_to_recordset(v_tables -> 'watchlist_items') as x(id uuid, collection text, item_key text, title text,
      season text, theme text, display_date text, date_sort text, watched boolean, status text, created_at timestamptz,
      watch_with text[], collections text[], tmdb_collection_id integer, tmdb_collection_name text, media_type text,
      tmdb_id integer, season_number integer, show_id uuid, skipped boolean);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('watchlist_items', v_k);

    insert into public.othertv_shows (id, tmdb_id, title, network, created_at, collection)
    select id, tmdb_id, title, network, created_at, collection
    from jsonb_to_recordset(v_tables -> 'othertv_shows') as x(id uuid, tmdb_id integer, title text, network text,
      created_at timestamptz, collection text);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('othertv_shows', v_k);

    insert into public.custom_collections (id, name, tmdb_person_id, created_at, role)
    select id, name, tmdb_person_id, created_at, role
    from jsonb_to_recordset(v_tables -> 'custom_collections') as x(id uuid, name text, tmdb_person_id integer,
      created_at timestamptz, role text);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('custom_collections', v_k);

    -- The backup's memberships are authoritative: drop whatever the trigger added
    -- for the restored shows and films, then put back exactly the backup's.
    delete from public.collection_memberships where user_id = v_owner;
    insert into public.collection_memberships (id, collection_id, show_id, item_id, created_at)
    select id, collection_id, show_id, item_id, created_at
    from jsonb_to_recordset(v_tables -> 'collection_memberships') as x(id uuid, collection_id uuid, show_id uuid,
      item_id uuid, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('collection_memberships', v_k);
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
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      raise exception 'restore_invalid: a row in the backup breaks a rule (%: %), so nothing was changed', coalesce(nullif(v_constraint, ''), 'check'), sqlerrm
        using errcode = '22023';
  end;

  if exists (
    select 1 from public.watchlist_items
    where user_id = v_owner and show_id is null and private.tv_is_tv_row(collection, media_type, season)
  ) then
    raise exception 'restore_invalid: every TV season must belong to a show in this backup' using errcode = '22023';
  end if;
  -- Exactly the backup's memberships, nothing added and nothing missing.
  if (select count(*) from public.collection_memberships where user_id = v_owner)
       <> jsonb_array_length(v_tables -> 'collection_memberships')
     or exists (
       select 1 from jsonb_to_recordset(v_tables -> 'collection_memberships') as x(id uuid, collection_id uuid, show_id uuid, item_id uuid)
       where not exists (select 1 from public.collection_memberships m where m.id = x.id and m.user_id = v_owner
                         and m.collection_id = x.collection_id and m.show_id is not distinct from x.show_id
                         and m.item_id is not distinct from x.item_id)) then
    raise exception 'restore_invalid: the restored memberships differ from the backup' using errcode = '22023';
  end if;

  return jsonb_build_object('formatVersion', 3, 'restored', v_n);
end
$function$;
revoke all on function restore_backup(jsonb,boolean) from public, anon, authenticated, service_role;
grant execute on function restore_backup(jsonb,boolean) to anon;
grant execute on function restore_backup(jsonb,boolean) to authenticated;
grant execute on function restore_backup(jsonb,boolean) to service_role;
CREATE OR REPLACE FUNCTION public.stage5_capabilities()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object('stage5', 1, 'phase', 'coexistence', 'backup_format', 3, 'recovery_archive', 'none')
$function$;
revoke all on function stage5_capabilities() from public, anon, authenticated, service_role;
grant execute on function stage5_capabilities() to anon;
grant execute on function stage5_capabilities() to authenticated;
grant execute on function stage5_capabilities() to service_role;
set local check_function_bodies = on;
-- Stage 5a triggers.
CREATE TRIGGER org_auto_membership_show AFTER INSERT ON public.tv_shows FOR EACH ROW EXECUTE FUNCTION private.org_auto_membership();
CREATE TRIGGER catalog_date_guard BEFORE UPDATE OF display_date, date_sort ON public.watchlist_items FOR EACH ROW WHEN (((old.collection = ANY (private.tv_builtin_collections())) OR (new.collection = ANY (private.tv_builtin_collections())))) EXECUTE FUNCTION private.catalog_date_guard();
CREATE TRIGGER org_auto_membership_film AFTER INSERT ON public.watchlist_items FOR EACH ROW WHEN (new.is_film) EXECUTE FUNCTION private.org_auto_membership();
CREATE TRIGGER org_carry_membership_to_film AFTER UPDATE OF show_id ON public.watchlist_items FOR EACH ROW WHEN (((old.show_id IS NOT NULL) AND (new.show_id IS NULL) AND new.is_film)) EXECUTE FUNCTION private.org_auto_membership();
-- END GENERATED-CATALOG

-- ── What Stage 5a doesn't have ───────────────────────────────────────────────
drop table public.catalog_film_links;
drop table public.catalog_show_links;
alter table public.watchlist_items drop constraint watchlist_items_theme_kind_check;
alter table public.watchlist_items drop constraint watchlist_items_classified_check;
alter table public.watchlist_items drop column theme_kind;
alter table public.personal_collections drop column catalog_id;
alter table public.personal_collections drop column presentation_key;
drop table private.stage5_recovery_meta;
drop table private.stage5_recovery_othertv;
drop table private.stage5_recovery_collections;
drop table private.stage5_recovery_records;

-- ── Verify before commit ─────────────────────────────────────────────────────
do $$
declare b record; a record;
begin
  select * into b from s5rb_before;
  select
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'collection' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t) w,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'collection')::text, '|' order by t.id), '')) from public.tv_shows t) s,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t) m,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'legacy_source')::text, '|' order by t.id), '')) from public.personal_collections t) p,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watch_with_choices t) c,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.custom_collections t) cc,
    (select md5(coalesce(string_agg(show_id::text || ':' || catalog, '|' order by show_id), '')) from public.library_catalog_shows) gs,
    (select md5(coalesce(string_agg(item_id::text || ':' || catalog, '|' order by item_id), '')) from public.library_catalog_films) gf
  into a;
  if a is distinct from b then raise exception 'phase5c rollback: a preserved value changed (before %, after %)', row_to_json(b), row_to_json(a); end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'coexistence' then
    raise exception 'phase5c rollback: the functions were not put back';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

select report from s5rb_report;
