-- B4/B5 Batch A: viewing status, priority, Show ended, markers, categorized
-- metadata, the earlier-seasons resume range, backup format 5. One transaction.
-- Run as postgres on a contracted database (Stage 5c, recovery archive active).
-- Order:
--   1. preconditions (stage, phase, archive, owner choices) and the lock set;
--   2. what must survive, and the restore points the rollback uses (the definitions
--      this script replaces, the status check, the function / trigger inventory
--      and the schema as they are now);
--   3. columns, the status mapping (with the owner's recorded choices), checks;
--   4. guards, the resume cleanup trigger, grants;
--   5. versioned library functions (_b45), refusing stubs for the changed names,
--      restore_backup (format 5), stage5_capabilities, the rollback report;
--   6. verify every preserved value and the mapping before commit.
-- The owner's choices for every Complete show and every film whose status is
-- 'watching' or 'complete' are a session setting set by a preamble in the same run:
--   select set_config('watchlist.b45_choices', '{"shows": {"<id>": "watching"}, "films": {}}', false);
-- Without a choice for each such record (and only for them) nothing is changed.
-- Rollback: db/rollback/b45.sql (dry run report, report-bound approval).
begin;
set local lock_timeout = '5s';

-- ── 1. Preconditions ─────────────────────────────────────────────────────────
do $$ begin
  if private.tv_stage() <> 'final' then raise exception 'b45: expected stage final, found %', private.tv_stage(); end if;
  if to_regprocedure('public.stage5_capabilities()') is null then raise exception 'b45: Stage 5 is not installed'; end if;
  if public.stage5_capabilities() ->> 'phase' = 'contracted-b45' then raise exception 'b45: already applied'; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted' then
    raise exception 'b45: expected phase contracted, found %', public.stage5_capabilities() ->> 'phase';
  end if;
  if to_regclass('private.stage5_recovery_meta') is null then
    raise exception 'b45: the recovery archive is not active; nothing was changed';
  end if;
end $$;

lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
  public.watch_with_choices, public.custom_collections, public.catalog_show_links, public.catalog_film_links in exclusive mode;
lock table private.stage5_recovery_records, private.stage5_recovery_collections, private.stage5_recovery_othertv,
  private.stage5_recovery_meta in share mode;

-- Every status must be a known one; every Complete show and every watching / complete
-- film must have exactly one recorded owner choice, and no other record may have one.
do $$
declare
  v_raw text := current_setting('watchlist.b45_choices', true);
  v jsonb;
  v_bad jsonb;
begin
  if coalesce(v_raw, '') = '' then v := '{"shows": {}, "films": {}}';
  else
    begin v := v_raw::jsonb;
    exception when others then raise exception 'b45: watchlist.b45_choices is not JSON; nothing was changed'; end;
  end if;
  if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(coalesce(v -> 'shows', '{}')) <> 'object'
     or jsonb_typeof(coalesce(v -> 'films', '{}')) <> 'object'
     or exists (select 1 from jsonb_object_keys(v) k where k not in ('shows', 'films')) then
    raise exception 'b45: watchlist.b45_choices must be {"shows": {id: status}, "films": {id: status}}; nothing was changed';
  end if;
  select jsonb_strip_nulls(jsonb_build_object(
    'unknown_show_status', (select jsonb_agg(jsonb_build_object('id', id, 'status', status)) from public.tv_shows
      where status not in ('confirmed', 'highpriority', 'watching', 'complete', 'pending', 'maybe', 'skipped')),
    'unknown_film_status', (select jsonb_agg(jsonb_build_object('id', id, 'status', status)) from public.watchlist_items
      where is_film and status not in ('confirmed', 'highpriority', 'watching', 'complete', 'pending', 'maybe', 'skipped')),
    'complete_show_without_choice', (select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title)) from public.tv_shows s
      where s.status = 'complete' and not (coalesce(v -> 'shows', '{}') ? s.id::text)),
    'film_without_choice', (select jsonb_agg(jsonb_build_object('id', w.id, 'title', w.title, 'status', w.status)) from public.watchlist_items w
      where w.is_film and w.status in ('watching', 'complete') and not (coalesce(v -> 'films', '{}') ? w.id::text)),
    'show_choice_for_other_record', (select jsonb_agg(k) from jsonb_object_keys(coalesce(v -> 'shows', '{}')) k
      where not exists (select 1 from public.tv_shows s where s.id::text = k and s.status = 'complete')),
    'film_choice_for_other_record', (select jsonb_agg(k) from jsonb_object_keys(coalesce(v -> 'films', '{}')) k
      where not exists (select 1 from public.watchlist_items w where w.id::text = k and w.is_film and w.status in ('watching', 'complete'))),
    'invalid_show_choice', (select jsonb_agg(e.key) from jsonb_each_text(coalesce(v -> 'shows', '{}')) e where e.value not in ('confirmed', 'watching', 'skipped')),
    'invalid_film_choice', (select jsonb_agg(e.key) from jsonb_each_text(coalesce(v -> 'films', '{}')) e where e.value not in ('confirmed', 'skipped'))
  )) into v_bad;
  if v_bad <> '{}'::jsonb then raise exception 'b45: the owner choices or the statuses don''t allow the migration; nothing was changed: %', v_bad; end if;
  create temp table b45_choices on commit drop as select v as choices;
end $$;

-- ── 2. What must survive; restore points for the rollback ───────────────────
create temp table b45_before on commit drop as
select
  (select md5(coalesce(string_agg((to_jsonb(t) - 'status')::text, '|' order by t.id), '')) from public.tv_shows t) shows_rest,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'status')::text, '|' order by t.id), '')) from public.watchlist_items t) items_rest,
  (select md5(coalesce(string_agg(t.id || ':' || t.status, '|' order by t.id), '')) from public.watchlist_items t where not t.is_film) season_status,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.personal_collections t) collections,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.collection_memberships t) memberships,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.watch_with_choices t) choices,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.custom_collections t) custom,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.catalog_show_links t) show_links,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.catalog_film_links t) film_links,
  (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.stage5_recovery_records t) a_records,
  (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.stage5_recovery_collections t) a_collections,
  (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.stage5_recovery_othertv t) a_othertv,
  (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.stage5_recovery_meta t) a_meta;
create temp table b45_old on commit drop as
select 'show'::text kind, id, status, null::boolean watched from public.tv_shows
union all select 'film', id, status, watched from public.watchlist_items where is_film;

-- The restore points (kept until a rollback or a later, separately approved clean-up).
create table private.b45_meta (
  singleton boolean primary key default true constraint b45_meta_singleton check (singleton),
  installed_at timestamptz not null default now(),
  baseline_inventory jsonb not null,
  baseline_schema jsonb not null,
  choices jsonb not null
);
create table private.b45_saved (
  kind text not null constraint b45_saved_kind_check check (kind in ('function', 'constraint')),
  name text primary key,
  definition text not null
);
revoke all on private.b45_meta, private.b45_saved from public, anon, authenticated;

-- The function and trigger inventory (as tools/db-rehearsal-5.mjs and the 5a rollback
-- read it) and the schema (columns, constraints, indexes, grants, policies, RLS).
create function private.b45_inventory() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'stage', (select private.tv_stage()),
    'functions', (select jsonb_object_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
        jsonb_build_object('src', md5(pg_get_functiondef(p.oid)), 'acl', coalesce(p.proacl::text, ''), 'secdef', p.prosecdef,
          'config', coalesce(array_to_string(p.proconfig, ','), '')))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prokind = 'f'),
    'triggers', (select jsonb_object_agg(c.relname || '.' || t.tgname, t.tgenabled::text || ' ' || md5(pg_get_triggerdef(t.oid)))
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relnamespace in ('public'::regnamespace, 'private'::regnamespace)))
$$;
create function private.b45_schema() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'columns', (select jsonb_agg(x order by x) from (select table_schema || '.' || table_name || '.' || column_name || ' ' || data_type || ' ' ||
      is_nullable || ' ' || coalesce(column_default, '') || ' ' || coalesce(generation_expression, '') x
      from information_schema.columns where table_schema in ('public', 'private') and table_name not like 'b45\_%') s),
    'constraints', (select jsonb_agg(x order by x) from (select c.conrelid::regclass::text || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid) x
      from pg_constraint c where c.connamespace in ('public'::regnamespace, 'private'::regnamespace) and c.contype <> 'n'
        and c.conrelid::regclass::text not like 'private.b45\_%') s),
    'indexes', (select jsonb_agg(indexdef order by indexdef) from pg_indexes where schemaname in ('public', 'private') and tablename not like 'b45\_%'),
    'column_grants', (select jsonb_agg(x order by x) from (select table_schema || '.' || table_name || '.' || column_name || ' ' || grantee || ' ' || privilege_type x
      from information_schema.column_privileges where table_schema in ('public', 'private') and grantee in ('anon', 'authenticated', 'service_role')
        and table_name not like 'b45\_%') s),
    'table_grants', (select jsonb_agg(x order by x) from (select table_schema || '.' || table_name || ' ' || grantee || ' ' || privilege_type x
      from information_schema.role_table_grants where table_schema in ('public', 'private') and grantee in ('anon', 'authenticated', 'service_role')
        and table_name not like 'b45\_%') s),
    'policies', (select jsonb_agg(x order by x) from (select tablename || '.' || policyname || ' ' || cmd || ' ' || roles::text || ' ' ||
      coalesce(qual, '') || ' ' || coalesce(with_check, '') x from pg_policies where schemaname = 'public') s),
    'rls', (select jsonb_agg(x order by x) from (select relname || ' ' || relrowsecurity x from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r') s))
$$;
revoke all on function private.b45_inventory(), private.b45_schema() from public;

insert into private.b45_saved (kind, name, definition)
select 'function', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
from pg_proc p
where p.oid in ('public.set_show_status(uuid, text)'::regprocedure, 'public.library_add_seasons(uuid, jsonb, jsonb)'::regprocedure,
  'public.library_create_show(jsonb, jsonb)'::regprocedure, 'public.library_add_films(jsonb)'::regprocedure,
  'public.library_create_film(jsonb)'::regprocedure, 'public.library_match_season(uuid, jsonb, jsonb, jsonb)'::regprocedure,
  'public.library_match_film(uuid, jsonb, jsonb)'::regprocedure, 'public.library_catalog_apply(text, jsonb, text)'::regprocedure,
  'public.restore_backup(jsonb, boolean)'::regprocedure, 'public.stage5_capabilities()'::regprocedure);
insert into private.b45_saved (kind, name, definition)
select 'constraint', 'tv_shows_status_check', pg_get_constraintdef(c.oid)
from pg_constraint c where c.conrelid = 'public.tv_shows'::regclass and c.conname = 'tv_shows_status_check';
do $$ begin
  if (select count(*) from private.b45_saved) <> 11 then raise exception 'b45: a restore point is missing; nothing was changed'; end if;
end $$;
-- (b45_inventory / b45_schema are this script's own objects; the baseline leaves them out.)
insert into private.b45_meta (baseline_inventory, baseline_schema, choices)
select private.b45_inventory() #- '{functions,private.b45_inventory()}' #- '{functions,private.b45_schema()}', private.b45_schema(), choices
from b45_choices;

-- ── 3. Columns, the status mapping, checks ───────────────────────────────────
-- A label list: at most 10 values, each trimmed, 1–80 characters, no case-insensitive repeats.
create function private.b45_labels_ok(p text[]) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and cardinality(p) <= 10
    and not exists (select 1 from unnest(p) x where x is null or x <> btrim(x) or length(x) < 1 or length(x) > 80)
    and (select count(distinct lower(x)) from unnest(p) x) = cardinality(p)
$$;

alter table public.tv_shows
  add column priority text not null default 'normal' constraint tv_shows_priority_check check (priority in ('high', 'normal', 'low')),
  add column ended boolean not null default false,
  add column catalog_new boolean not null default false,
  add column status_review boolean not null default false,
  add column legacy_status text constraint tv_shows_legacy_status_check check (legacy_status in ('pending', 'highpriority', 'maybe', 'complete')),
  add column genres text[] not null default '{}',
  add column forms text[] not null default '{}',
  add column franchises text[] not null default '{}',
  add column companies text[] not null default '{}',
  add column genre_candidates text[] not null default '{}',
  add column network text constraint tv_shows_network_check check (network is null or (network = btrim(network) and length(network) between 1 and 80)),
  add column network_candidates text[] not null default '{}',
  add column metadata_owner_set boolean not null default false,
  add column resume_start_season_id uuid,
  add column resume_end_season_id uuid;
alter table public.tv_shows add constraint tv_shows_labels_check check (private.b45_labels_ok(genres) and private.b45_labels_ok(forms)
  and private.b45_labels_ok(franchises) and private.b45_labels_ok(companies) and private.b45_labels_ok(genre_candidates)
  and private.b45_labels_ok(network_candidates));
alter table public.tv_shows add constraint tv_shows_resume_pair_check
  check ((resume_start_season_id is null and resume_end_season_id is null)
         or (resume_start_season_id is not null and resume_end_season_id is not null and resume_start_season_id <> resume_end_season_id));

-- Films carry the new values; season rows carry none (no defaults: every insert path states them).
alter table public.watchlist_items
  add column priority text,
  add column catalog_new boolean,
  add column status_review boolean,
  add column legacy_status text,
  add column genres text[],
  add column forms text[],
  add column franchises text[],
  add column companies text[],
  add column genre_candidates text[],
  add column metadata_owner_set boolean;
update public.watchlist_items set priority = 'normal', catalog_new = false, status_review = false, genres = '{}', forms = '{}',
  franchises = '{}', companies = '{}', genre_candidates = '{}', metadata_owner_set = false
where is_film;

-- The status mapping (approved plan §7.1; the owner's choices for Complete shows and
-- watching / complete films). Season rows' compatibility status is not touched.
update public.tv_shows s set
  status = case s.status
    when 'pending' then 'confirmed' when 'highpriority' then 'confirmed' when 'maybe' then 'confirmed'
    when 'complete' then (select c.choices -> 'shows' ->> s.id::text from b45_choices c) else s.status end,
  priority = case s.status when 'highpriority' then 'high' when 'maybe' then 'low' else 'normal' end,
  ended = s.status = 'complete',
  catalog_new = s.status = 'pending',
  legacy_status = case when s.status in ('pending', 'highpriority', 'maybe', 'complete') then s.status end
where s.status in ('pending', 'highpriority', 'maybe', 'complete');
update public.watchlist_items w set
  status = case when w.status in ('watching', 'complete') then (select c.choices -> 'films' ->> w.id::text from b45_choices c) else 'confirmed' end,
  priority = case w.status when 'highpriority' then 'high' when 'maybe' then 'low' else 'normal' end,
  catalog_new = w.status = 'pending',
  legacy_status = w.status
where w.is_film and w.status in ('pending', 'highpriority', 'maybe', 'watching', 'complete');

alter table public.tv_shows drop constraint tv_shows_status_check;
alter table public.tv_shows add constraint tv_shows_status_check check (status in ('confirmed', 'watching', 'skipped'));
alter table public.watchlist_items add constraint watchlist_items_b45_film_check check (
  case when coalesce(media_type = 'movie', false) or (media_type is null and season = 'Film') then
    status in ('confirmed', 'skipped') and priority is not null and priority in ('high', 'normal', 'low')
    and catalog_new is not null and status_review is not null and metadata_owner_set is not null
    and (legacy_status is null or legacy_status in ('pending', 'highpriority', 'maybe', 'watching', 'complete'))
    and private.b45_labels_ok(genres) and private.b45_labels_ok(forms) and private.b45_labels_ok(franchises)
    and private.b45_labels_ok(companies) and private.b45_labels_ok(genre_candidates)
  else
    priority is null and catalog_new is null and status_review is null and legacy_status is null and genres is null and forms is null
    and franchises is null and companies is null and genre_candidates is null and metadata_owner_set is null
  end);

-- The resume range names two seasons of the same show and owner (deferred: a restore
-- inserts shows before their seasons; a Match clears it before moving a season).
create unique index watchlist_items_id_show_owner_key on public.watchlist_items using btree (id, show_id, user_id);
alter table public.tv_shows
  add constraint tv_shows_resume_start_fkey foreign key (resume_start_season_id, id, user_id)
    references public.watchlist_items (id, show_id, user_id) deferrable initially deferred,
  add constraint tv_shows_resume_end_fkey foreign key (resume_end_season_id, id, user_id)
    references public.watchlist_items (id, show_id, user_id) deferrable initially deferred;
create index tv_shows_resume_start_idx on public.tv_shows using btree (resume_start_season_id) where resume_start_season_id is not null;
create index tv_shows_resume_end_idx on public.tv_shows using btree (resume_end_season_id) where resume_end_season_id is not null;

-- ── 4. Guards, the resume cleanup, grants ────────────────────────────────────
-- Status, priority, Ended, markers, provenance, metadata and the resume range change
-- only through the _b45 functions (or restore / approved admin scripts), which set
-- watchlist.library_write. The one exception: the resume cleanup below may set both
-- resume columns to NULL and change nothing else, under its own transaction-local
-- setting, so any path that deletes a referenced season (an old page's
-- delete_tv_season included) keeps working.
create function private.b45_show_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('watchlist.library_write', true), '') = 'on' then return new; end if;
  if coalesce(current_setting('watchlist.resume_cleanup', true), '') = 'on'
     and new.resume_start_season_id is null and new.resume_end_season_id is null
     and (to_jsonb(new) - 'resume_start_season_id' - 'resume_end_season_id') = (to_jsonb(old) - 'resume_start_season_id' - 'resume_end_season_id') then
    return new;
  end if;
  raise exception 'library_write_required: This change is made only through the app''s library functions. Reload the page. Nothing was changed.'
    using errcode = 'P0001';
end $$;
create trigger tv_shows_b45_guard before update on public.tv_shows for each row
  when (new.status is distinct from old.status or new.priority is distinct from old.priority or new.ended is distinct from old.ended
        or new.catalog_new is distinct from old.catalog_new or new.status_review is distinct from old.status_review
        or new.legacy_status is distinct from old.legacy_status or new.genres is distinct from old.genres or new.forms is distinct from old.forms
        or new.franchises is distinct from old.franchises or new.companies is distinct from old.companies
        or new.genre_candidates is distinct from old.genre_candidates or new.network is distinct from old.network
        or new.network_candidates is distinct from old.network_candidates or new.metadata_owner_set is distinct from old.metadata_owner_set
        or new.resume_start_season_id is distinct from old.resume_start_season_id or new.resume_end_season_id is distinct from old.resume_end_season_id)
  execute function private.b45_show_guard();
create trigger watchlist_items_b45_guard before update on public.watchlist_items for each row
  when ((old.is_film and (new.status is distinct from old.status or new.watched is distinct from old.watched))
        or new.priority is distinct from old.priority or new.catalog_new is distinct from old.catalog_new
        or new.status_review is distinct from old.status_review or new.legacy_status is distinct from old.legacy_status
        or new.genres is distinct from old.genres or new.forms is distinct from old.forms or new.franchises is distinct from old.franchises
        or new.companies is distinct from old.companies or new.genre_candidates is distinct from old.genre_candidates
        or new.metadata_owner_set is distinct from old.metadata_owner_set)
  execute function private.library_write_guard();

create function private.b45_resume_cleanup() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.tv_shows where resume_start_season_id = old.id or resume_end_season_id = old.id) then
    perform set_config('watchlist.resume_cleanup', 'on', true);
    update public.tv_shows set resume_start_season_id = null, resume_end_season_id = null
    where resume_start_season_id = old.id or resume_end_season_id = old.id;
    perform set_config('watchlist.resume_cleanup', '', true);
  end if;
  return old;
end $$;
create trigger watchlist_items_resume_cleanup before delete on public.watchlist_items
  for each row execute function private.b45_resume_cleanup();

-- The SECURITY INVOKER functions and restore write these columns.
grant insert (priority, ended, catalog_new, status_review, legacy_status, genres, forms, franchises, companies, genre_candidates,
              network, network_candidates, metadata_owner_set, resume_start_season_id, resume_end_season_id),
      update (priority, ended, catalog_new, status_review, legacy_status, genres, forms, franchises, companies, genre_candidates,
              network, network_candidates, metadata_owner_set, resume_start_season_id, resume_end_season_id)
  on public.tv_shows to anon, authenticated;
grant insert (priority, catalog_new, status_review, legacy_status, genres, forms, franchises, companies, genre_candidates, metadata_owner_set),
      update (priority, catalog_new, status_review, legacy_status, genres, forms, franchises, companies, genre_candidates, metadata_owner_set)
  on public.watchlist_items to anon, authenticated;

-- ── 5. Functions ─────────────────────────────────────────────────────────────
-- A guarded state refusal: the record differs from what the page showed.
create function private.b45_changed() returns void
language plpgsql set search_path = '' as $$
begin
  perform private.lib_refuse('target_changed', 'This changed since the page showed it, so nothing was changed. Look at it again.');
end $$;

-- Season order within a show (derived-views.js seasonOrder / compareSeasons: numbered
-- seasons before specials, then the number, date, label, id; collate "C").
create function private.b45_is_special(r public.watchlist_items) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(r.season_number = 0, false) or btrim(coalesce(r.season, '')) ~* '^specials?$'
$$;
create function private.b45_season_number(r public.watchlist_items) returns integer
language sql immutable set search_path = '' as $$
  select coalesce(r.season_number, (regexp_match(coalesce(r.season, ''), '^(?:Season|Volume)\s+(\d+)', 'i'))[1]::integer)
$$;
-- The main progression of a show, in order (the numbered seasons; every season of a specials-only show).
create function private.b45_main_seasons(p_show_id uuid) returns table (id uuid, ord bigint, watched boolean, skipped boolean)
language sql stable set search_path = '' as $$
  with s as (select w.id, w.watched, w.skipped, private.b45_is_special(w) sp, private.b45_season_number(w) num,
                    coalesce(w.date_sort, '') ds, coalesce(w.season, '') lbl
             from public.watchlist_items w where w.show_id = p_show_id),
       m as (select * from s where not sp or not exists (select 1 from s x where not x.sp))
  select m.id, row_number() over (order by m.sp, m.num nulls last, m.ds collate "C", m.lbl collate "C", m.id::text collate "C"),
    m.watched, m.skipped
  from m
$$;
-- A resume range's state: 'active' (a season remains), 'complete' (none), 'invalid' (no range,
-- an end not in the main progression, or a start not before the end).
create function private.b45_resume_state(p_show_id uuid) returns text
language plpgsql stable set search_path = '' as $$
declare s public.tv_shows; a bigint; b bigint;
begin
  select * into s from public.tv_shows where id = p_show_id;
  if s.resume_start_season_id is null then return null; end if;
  select ord into a from private.b45_main_seasons(p_show_id) m where m.id = s.resume_start_season_id;
  select ord into b from private.b45_main_seasons(p_show_id) m where m.id = s.resume_end_season_id;
  if a is null or b is null or a >= b then return 'invalid'; end if;
  return case when exists (select 1 from private.b45_main_seasons(p_show_id) m where m.ord >= a and m.ord < b and not m.watched and not m.skipped)
              then 'active' else 'complete' end;
end $$;

-- The B45 state of a record as the page shows it.
create function private.b45_show_state(s public.tv_shows) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('status', s.status, 'priority', s.priority, 'ended', s.ended, 'catalog_new', s.catalog_new,
    'status_review', s.status_review)
$$;
create function private.b45_film_state(w public.watchlist_items) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('status', w.status, 'watched', w.watched, 'priority', w.priority, 'catalog_new', w.catalog_new,
    'status_review', w.status_review)
$$;
-- The metadata of a record as the page shows it (network fields for shows only).
create function private.b45_show_metadata(s public.tv_shows) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('genres', to_jsonb(s.genres), 'forms', to_jsonb(s.forms), 'franchises', to_jsonb(s.franchises),
    'companies', to_jsonb(s.companies), 'genre_candidates', to_jsonb(s.genre_candidates), 'network', s.network,
    'network_candidates', to_jsonb(s.network_candidates), 'metadata_owner_set', s.metadata_owner_set)
$$;
create function private.b45_film_metadata(w public.watchlist_items) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('genres', to_jsonb(w.genres), 'forms', to_jsonb(w.forms), 'franchises', to_jsonb(w.franchises),
    'companies', to_jsonb(w.companies), 'genre_candidates', to_jsonb(w.genre_candidates), 'metadata_owner_set', w.metadata_owner_set)
$$;
-- A label list from a request (null or absent: empty), or invalid_input.
create function private.b45_labels(p jsonb, p_field text) returns text[]
language plpgsql immutable set search_path = '' as $$
declare v text[];
begin
  if p is null or p = 'null'::jsonb then return '{}'; end if;
  if jsonb_typeof(p) <> 'array' or exists (select 1 from jsonb_array_elements(p) x where jsonb_typeof(x) <> 'string') then
    raise exception 'invalid_input: % must be a list of labels', p_field using errcode = '22023';
  end if;
  v := array(select jsonb_array_elements_text(p));
  if not private.b45_labels_ok(v) then
    raise exception 'invalid_input: % (at most 10 labels, each 1–80 characters with no surrounding spaces, no repeats)', p_field using errcode = '22023';
  end if;
  return v;
end $$;

-- ── O1 / O2 / O3: a show's state ──
-- p_expected: {status, priority, ended, catalog_new, status_review} as the page showed them.
-- p_changes: any of {status (O1, an explicit viewing-status choice), priority (O2), ended (O3)}.
-- O1 clears catalog_new, status_review and legacy_status; O2 clears legacy_status only when it
-- is highpriority / maybe; O3 only when it is complete. A request that changes nothing (and isn't
-- an explicit choice while review is on) writes nothing.
create function public.library_set_show_state_b45(p_show_id uuid, p_expected jsonb, p_changes jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_set_show_state_b45', 'final');
  s public.tv_shows;
  n public.tv_shows;
begin
  if p_show_id is null or jsonb_typeof(p_expected) is distinct from 'object' or jsonb_typeof(p_changes) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_changes) k where k not in ('status', 'priority', 'ended'))
     or not (p_changes ? 'status' or p_changes ? 'priority' or p_changes ? 'ended')
     or (p_changes ? 'status' and coalesce(p_changes ->> 'status', '') not in ('confirmed', 'watching', 'skipped'))
     or (p_changes ? 'priority' and coalesce(p_changes ->> 'priority', '') not in ('high', 'normal', 'low'))
     or (p_changes ? 'ended' and jsonb_typeof(p_changes -> 'ended') is distinct from 'boolean') then
    raise exception 'invalid_input: show state change %', p_changes using errcode = '22023';
  end if;
  perform private.lib_write_on();
  select * into s from public.tv_shows where id = p_show_id and user_id = v_owner for update;
  if not found then perform private.lib_refuse('target_missing', 'This show is no longer on your list, so nothing was changed.'); end if;
  if private.b45_show_state(s) is distinct from (p_expected - 'title') then perform private.b45_changed(); end if;
  n := s;
  if p_changes ? 'status' then
    n.status := p_changes ->> 'status'; n.catalog_new := false; n.status_review := false; n.legacy_status := null;
  end if;
  if p_changes ? 'priority' then
    n.priority := p_changes ->> 'priority';
    if n.priority is distinct from s.priority and n.legacy_status in ('highpriority', 'maybe') then n.legacy_status := null; end if;
  end if;
  if p_changes ? 'ended' then
    n.ended := (p_changes ->> 'ended')::boolean;
    if n.ended is distinct from s.ended and n.legacy_status = 'complete' then n.legacy_status := null; end if;
  end if;
  -- An explicit status choice is never a no-op while review is on (it resolves the review).
  if not (p_changes ? 'status' and s.status_review)
     and n.status = s.status and n.priority = s.priority and n.ended = s.ended
     and (not (p_changes ? 'status') or (s.catalog_new = false and s.legacy_status is null)) then
    return jsonb_build_object('changed', false, 'show', to_jsonb(s));
  end if;
  update public.tv_shows set status = n.status, priority = n.priority, ended = n.ended, catalog_new = n.catalog_new,
    status_review = n.status_review, legacy_status = n.legacy_status
  where id = s.id returning * into n;
  return jsonb_build_object('changed', true, 'show', to_jsonb(n));
end $$;

-- ── O1 / O2 / O4: a film's state ──
-- p_changes: any of {state: 'to_watch' | 'watched' | 'skipped' (O1), watched: boolean (O4,
-- only on a film that isn't Skipped), priority (O2)}. A change to status or watched that
-- would give Skipped + Watched is refused; a priority change leaves an existing pair as it is.
create function public.library_set_film_state_b45(p_item_id uuid, p_expected jsonb, p_changes jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_set_film_state_b45', 'final');
  w public.watchlist_items;
  n public.watchlist_items;
begin
  if p_item_id is null or jsonb_typeof(p_expected) is distinct from 'object' or jsonb_typeof(p_changes) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_changes) k where k not in ('state', 'watched', 'priority'))
     or not (p_changes ? 'state' or p_changes ? 'watched' or p_changes ? 'priority')
     or (p_changes ? 'state' and p_changes ? 'watched')
     or (p_changes ? 'state' and coalesce(p_changes ->> 'state', '') not in ('to_watch', 'watched', 'skipped'))
     or (p_changes ? 'watched' and jsonb_typeof(p_changes -> 'watched') is distinct from 'boolean')
     or (p_changes ? 'priority' and coalesce(p_changes ->> 'priority', '') not in ('high', 'normal', 'low')) then
    raise exception 'invalid_input: film state change %', p_changes using errcode = '22023';
  end if;
  perform private.lib_write_on();
  select * into w from public.watchlist_items where id = p_item_id and user_id = v_owner for update;
  if not found or not w.is_film then perform private.lib_refuse('target_missing', 'This film is no longer on your list, so nothing was changed.'); end if;
  if private.b45_film_state(w) is distinct from (p_expected - 'title') then perform private.b45_changed(); end if;
  n := w;
  if p_changes ? 'state' then
    n.status := case p_changes ->> 'state' when 'skipped' then 'skipped' else 'confirmed' end;
    n.watched := p_changes ->> 'state' = 'watched';
    n.catalog_new := false; n.status_review := false; n.legacy_status := null;
  end if;
  if p_changes ? 'watched' then
    if w.status = 'skipped' then
      perform private.lib_refuse('invalid_state', 'A skipped film can''t be marked watched here; choose Watched as its status. Nothing was changed.');
    end if;
    n.watched := (p_changes ->> 'watched')::boolean;
  end if;
  if p_changes ? 'priority' then
    n.priority := p_changes ->> 'priority';
    if n.priority is distinct from w.priority and n.legacy_status in ('highpriority', 'maybe') then n.legacy_status := null; end if;
  end if;
  if (p_changes ? 'state' or p_changes ? 'watched') and n.status = 'skipped' and n.watched then
    perform private.lib_refuse('invalid_state', 'A film can''t be both Skipped and Watched. Nothing was changed.');
  end if;
  if not (p_changes ? 'state' and w.status_review)
     and n.status = w.status and n.watched = w.watched and n.priority = w.priority
     and (not (p_changes ? 'state') or (w.catalog_new = false and w.legacy_status is null)) then
    return jsonb_build_object('changed', false, 'row', to_jsonb(w) - 'is_film');
  end if;
  update public.watchlist_items set status = n.status, watched = n.watched, priority = n.priority, catalog_new = n.catalog_new,
    status_review = n.status_review, legacy_status = n.legacy_status
  where id = w.id returning * into n;
  return jsonb_build_object('changed', true, 'row', to_jsonb(n) - 'is_film');
end $$;

-- ── O7: metadata ──
-- p_kind 'show' | 'film'; p_expected: the record's metadata as the page showed it (every field);
-- p_metadata: the fields to set (genres, forms, franchises, companies, genre_candidates, and for
-- a show network and network_candidates). Saving always records the owner's choice
-- (metadata_owner_set), also when every field is left empty.
create function public.library_set_metadata_b45(p_kind text, p_id uuid, p_expected jsonb, p_metadata jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_set_metadata_b45', 'final');
  v_allowed text[] := case when p_kind = 'show' then array['genres', 'forms', 'franchises', 'companies', 'genre_candidates', 'network', 'network_candidates']
                           else array['genres', 'forms', 'franchises', 'companies', 'genre_candidates'] end;
  s public.tv_shows;
  w public.watchlist_items;
  v_net text;
begin
  if p_kind not in ('show', 'film') or p_id is null or jsonb_typeof(p_expected) is distinct from 'object'
     or jsonb_typeof(p_metadata) is distinct from 'object' or exists (select 1 from jsonb_object_keys(p_metadata) k where not (k = any(v_allowed))) then
    raise exception 'invalid_input: metadata %', p_metadata using errcode = '22023';
  end if;
  -- (each list is checked before anything is written)
  perform private.b45_labels(p_metadata -> f, f) from unnest(array['genres', 'forms', 'franchises', 'companies', 'genre_candidates', 'network_candidates']) f
  where p_metadata ? f;
  if p_metadata ? 'network' and p_metadata -> 'network' <> 'null'::jsonb then
    if jsonb_typeof(p_metadata -> 'network') <> 'string' or p_metadata ->> 'network' <> btrim(p_metadata ->> 'network')
       or length(p_metadata ->> 'network') not between 1 and 80 then
      raise exception 'invalid_input: network' using errcode = '22023';
    end if;
    v_net := p_metadata ->> 'network';
  end if;
  perform private.lib_write_on();
  if p_kind = 'show' then
    select * into s from public.tv_shows where id = p_id and user_id = v_owner for update;
    if not found then perform private.lib_refuse('target_missing', 'This show is no longer on your list, so nothing was changed.'); end if;
    if private.b45_show_metadata(s) is distinct from p_expected then perform private.b45_changed(); end if;
    update public.tv_shows set
      genres = case when p_metadata ? 'genres' then private.b45_labels(p_metadata -> 'genres', 'genres') else genres end,
      forms = case when p_metadata ? 'forms' then private.b45_labels(p_metadata -> 'forms', 'forms') else forms end,
      franchises = case when p_metadata ? 'franchises' then private.b45_labels(p_metadata -> 'franchises', 'franchises') else franchises end,
      companies = case when p_metadata ? 'companies' then private.b45_labels(p_metadata -> 'companies', 'companies') else companies end,
      genre_candidates = case when p_metadata ? 'genre_candidates' then private.b45_labels(p_metadata -> 'genre_candidates', 'genre_candidates') else genre_candidates end,
      network = case when p_metadata ? 'network' then v_net else network end,
      network_candidates = case when p_metadata ? 'network_candidates' then private.b45_labels(p_metadata -> 'network_candidates', 'network_candidates') else network_candidates end,
      metadata_owner_set = true
    where id = s.id returning * into s;
    return jsonb_build_object('show', to_jsonb(s));
  end if;
  select * into w from public.watchlist_items where id = p_id and user_id = v_owner for update;
  if not found or not w.is_film then perform private.lib_refuse('target_missing', 'This film is no longer on your list, so nothing was changed.'); end if;
  if private.b45_film_metadata(w) is distinct from p_expected then perform private.b45_changed(); end if;
  update public.watchlist_items set
    genres = case when p_metadata ? 'genres' then private.b45_labels(p_metadata -> 'genres', 'genres') else genres end,
    forms = case when p_metadata ? 'forms' then private.b45_labels(p_metadata -> 'forms', 'forms') else forms end,
    franchises = case when p_metadata ? 'franchises' then private.b45_labels(p_metadata -> 'franchises', 'franchises') else franchises end,
    companies = case when p_metadata ? 'companies' then private.b45_labels(p_metadata -> 'companies', 'companies') else companies end,
    genre_candidates = case when p_metadata ? 'genre_candidates' then private.b45_labels(p_metadata -> 'genre_candidates', 'genre_candidates') else genre_candidates end,
    metadata_owner_set = true
  where id = w.id returning * into w;
  return jsonb_build_object('row', to_jsonb(w) - 'is_film');
end $$;

-- ── O5: dismiss New from catalog (one, or all shown), atomically ──
-- p_expected: [{kind: 'show' | 'film', id}] exactly as the page showed them; every one must
-- still be new and the set must be exactly the current set's subset named, or nothing changes.
create function public.library_dismiss_catalog_new_b45(p_expected jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_dismiss_catalog_new_b45', 'final');
  v_shows uuid[];
  v_films uuid[];
  v_n int;
begin
  if jsonb_typeof(p_expected) is distinct from 'array' or jsonb_array_length(p_expected) = 0
     or exists (select 1 from jsonb_array_elements(p_expected) x where jsonb_typeof(x) <> 'object' or x ->> 'kind' not in ('show', 'film')
                or coalesce(x ->> 'id', '') !~ '^[0-9a-f-]{36}$') then
    raise exception 'invalid_input: the records to dismiss' using errcode = '22023';
  end if;
  v_shows := array(select distinct (x ->> 'id')::uuid from jsonb_array_elements(p_expected) x where x ->> 'kind' = 'show');
  v_films := array(select distinct (x ->> 'id')::uuid from jsonb_array_elements(p_expected) x where x ->> 'kind' = 'film');
  if cardinality(v_shows) + cardinality(v_films) <> jsonb_array_length(p_expected) then
    raise exception 'invalid_input: a record is listed twice' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  perform 1 from public.tv_shows where id = any(v_shows) and user_id = v_owner for update;
  perform 1 from public.watchlist_items where id = any(v_films) and user_id = v_owner for update;
  select (select count(*) from public.tv_shows where id = any(v_shows) and user_id = v_owner and catalog_new)
       + (select count(*) from public.watchlist_items where id = any(v_films) and user_id = v_owner and is_film and catalog_new) into v_n;
  if v_n <> jsonb_array_length(p_expected) then
    raise exception 'target_changed: % of the % records shown are no longer new from the catalog, so nothing was changed. Look at the list again.',
      jsonb_array_length(p_expected) - v_n, jsonb_array_length(p_expected) using errcode = 'P0001';
  end if;
  update public.tv_shows set catalog_new = false, legacy_status = case when legacy_status = 'pending' then null else legacy_status end
  where id = any(v_shows);
  update public.watchlist_items set catalog_new = false, legacy_status = case when legacy_status = 'pending' then null else legacy_status end
  where id = any(v_films);
  return jsonb_build_object('dismissed', v_n);
end $$;

-- ── O6: keep the current status (dismiss Needs status review) ──
create function public.library_dismiss_review_b45(p_kind text, p_id uuid, p_expected jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_dismiss_review_b45', 'final');
  s public.tv_shows;
  w public.watchlist_items;
begin
  if p_kind not in ('show', 'film') or p_id is null or jsonb_typeof(p_expected) is distinct from 'object' then
    raise exception 'invalid_input: review dismissal' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  if p_kind = 'show' then
    select * into s from public.tv_shows where id = p_id and user_id = v_owner for update;
    if not found then perform private.lib_refuse('target_missing', 'This show is no longer on your list, so nothing was changed.'); end if;
    if private.b45_show_state(s) is distinct from p_expected or not s.status_review then perform private.b45_changed(); end if;
    update public.tv_shows set status_review = false, legacy_status = null where id = s.id returning * into s;
    return jsonb_build_object('show', to_jsonb(s));
  end if;
  select * into w from public.watchlist_items where id = p_id and user_id = v_owner for update;
  if not found or not w.is_film then perform private.lib_refuse('target_missing', 'This film is no longer on your list, so nothing was changed.'); end if;
  if private.b45_film_state(w) is distinct from p_expected or not w.status_review then perform private.b45_changed(); end if;
  update public.watchlist_items set status_review = false, legacy_status = null where id = w.id returning * into w;
  return jsonb_build_object('row', to_jsonb(w) - 'is_film');
end $$;

-- ── O9 (and O1 + O9): the earlier-seasons resume range ──
-- p_expected: {status, resume_start_season_id, resume_end_season_id} as the page showed them.
-- p_start / p_end: both null (Stop) or the start season (unwatched, not skipped) and the end
-- boundary (watched), two different seasons of this show. p_set_watching: "Start watching
-- earlier seasons" on a show that isn't Watching (an explicit status choice: O1 as well).
-- The order (start before boundary) is the page's: a reversed range is inert, never a wrong mark.
create function public.library_set_resume_b45(p_show_id uuid, p_expected jsonb, p_start uuid, p_end uuid, p_set_watching boolean default false)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_set_resume_b45', 'final');
  s public.tv_shows;
  a public.watchlist_items;
  b public.watchlist_items;
begin
  if p_show_id is null or jsonb_typeof(p_expected) is distinct from 'object' or (p_start is null) <> (p_end is null)
     or (p_start is not null and p_start = p_end) or (p_set_watching and p_start is null) then
    raise exception 'invalid_input: resume range' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  select * into s from public.tv_shows where id = p_show_id and user_id = v_owner for update;
  if not found then perform private.lib_refuse('target_missing', 'This show is no longer on your list, so nothing was changed.'); end if;
  if jsonb_build_object('status', s.status, 'resume_start_season_id', s.resume_start_season_id, 'resume_end_season_id', s.resume_end_season_id)
     is distinct from p_expected then perform private.b45_changed(); end if;
  if p_set_watching and s.status = 'watching' then
    raise exception 'invalid_input: the show is already Watching' using errcode = '22023';
  end if;
  if p_start is not null then
    select * into a from public.watchlist_items where id = p_start and show_id = s.id and user_id = v_owner;
    select * into b from public.watchlist_items where id = p_end and show_id = s.id and user_id = v_owner;
    if a.id is null or b.id is null then
      perform private.lib_refuse('invalid_range', 'Those seasons aren''t seasons of this show, so nothing was changed. Look at it again.');
    end if;
    if a.watched or a.skipped or not b.watched then
      perform private.lib_refuse('invalid_range', 'The first season must be unwatched and not skipped, and the last one before it watched. Nothing was changed. Look at it again.');
    end if;
  end if;
  if p_set_watching then
    update public.tv_shows set status = 'watching', catalog_new = false, status_review = false, legacy_status = null,
      resume_start_season_id = p_start, resume_end_season_id = p_end
    where id = s.id returning * into s;
  else
    update public.tv_shows set resume_start_season_id = p_start, resume_end_season_id = p_end where id = s.id returning * into s;
  end if;
  return jsonb_build_object('show', to_jsonb(s), 'resume_state', private.b45_resume_state(s.id));
end $$;

-- ── Additions (the 5a functions' contract; new records start To Watch / Normal) ──
-- New films: every film column stated (the row-class check has no defaults to fall back on).
create function private.lib_insert_film_b45(p_owner uuid, f jsonb, p_kind text, p_catalog_new boolean) returns uuid
language plpgsql set search_path = '' as $$
declare v uuid;
begin
  if p_kind is null or p_kind not in ('genre', 'other') then
    raise exception 'integrity_fault: theme kind %', p_kind using errcode = '23000';
  end if;
  if coalesce(f ->> 'status', 'confirmed') <> 'confirmed' then
    raise exception 'invalid_input: a new film starts To Watch' using errcode = '22023';
  end if;
  insert into public.watchlist_items (item_key, title, season, theme, theme_kind, display_date, date_sort, watched, status,
    watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number,
    priority, catalog_new, status_review, legacy_status, genres, forms, franchises, companies, genre_candidates, metadata_owner_set)
  values (f ->> 'item_key', btrim(f ->> 'title'), 'Film', coalesce(f ->> 'theme', ''), p_kind, coalesce(f ->> 'display_date', ''),
    f ->> 'date_sort', coalesce((f ->> 'watched')::boolean, false), 'confirmed',
    coalesce(array(select jsonb_array_elements_text(f -> 'watch_with')), '{}'),
    coalesce(array(select jsonb_array_elements_text(f -> 'collections')), '{}'),
    (f ->> 'tmdb_collection_id')::integer, f ->> 'tmdb_collection_name',
    case when f ->> 'tmdb_id' is not null then 'movie' end, (f ->> 'tmdb_id')::integer, null,
    'normal', p_catalog_new, false, null,
    private.b45_labels(f -> 'genres', 'genres'), private.b45_labels(f -> 'forms', 'forms'),
    private.b45_labels(f -> 'franchises', 'franchises'), private.b45_labels(f -> 'companies', 'companies'),
    private.b45_labels(f -> 'genre_candidates', 'genre_candidates'), false)
  on conflict do nothing
  returning id into v;
  return v;
end $$;

-- Seasons for a show already on the list: library_add_seasons' contract (5a) unchanged;
-- a show's status, priority and Ended are never changed by an addition. The answer adds
-- ended_kept (the show is marked ended and keeps it).
create function public.library_add_seasons_b45(p_show_id uuid, p_expected jsonb, p_seasons jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_add_seasons_b45', 'final');
  v_show public.tv_shows;
  v_exp_tmdb integer;
  v_catalog text;
  v_by_number boolean;
  v_has_number boolean;
  s jsonb;
  v_res jsonb;
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
  v_res := private.lib_add_to_show(v_show, p_expected ->> 'network', p_seasons, v_by_number);
  if (select status from public.tv_shows where id = v_show.id) is distinct from v_show.status then
    raise exception 'integrity_fault: an addition changed the show''s status' using errcode = '23000';
  end if;
  return (v_res - 'reopened') || jsonb_build_object('ended_kept', v_show.ended and jsonb_array_length(coalesce(v_res -> 'inserted', '[]')) > 0);
end $$;

-- A genuinely new show (library_create_show's contract), To Watch / Normal, with the
-- metadata the page took from TMDB: genres, forms, companies, genre_candidates (combined
-- source categories, unresolved) and network_candidates (Original network stays empty).
create function public.library_create_show_b45(p_show jsonb, p_seasons jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_create_show_b45', 'final');
  v_tmdb integer;
  v_title text := btrim(coalesce(p_show ->> 'title', ''));
  v_key text := btrim(coalesce(p_show ->> 'show_key', ''));
  v_distinct uuid[];
  v_id uuid;
  v_show public.tv_shows;
  v_res jsonb;
  v_genres text[]; v_forms text[]; v_franchises text[]; v_companies text[]; v_gc text[]; v_nc text[];
begin
  if jsonb_typeof(p_show) is distinct from 'object' then raise exception 'invalid_input: show' using errcode = '22023'; end if;
  begin
    v_tmdb := (p_show ->> 'tmdb_id')::integer;
    v_distinct := private.lib_distinct_ids(p_show -> 'distinct_from');
  exception when others then raise exception 'invalid_input: show tmdb_id / distinct_from' using errcode = '22023'; end;
  if v_title = '' or v_key = '' then raise exception 'invalid_input: show title and show_key are required' using errcode = '22023'; end if;
  if coalesce(p_show ->> 'initial_status', 'confirmed') <> 'confirmed' then
    raise exception 'invalid_input: a new show starts To Watch' using errcode = '22023';
  end if;
  if p_show ? 'original_network' then raise exception 'invalid_input: Original network is set only by the owner' using errcode = '22023'; end if;
  v_genres := private.b45_labels(p_show -> 'genres', 'genres'); v_forms := private.b45_labels(p_show -> 'forms', 'forms');
  v_franchises := private.b45_labels(p_show -> 'franchises', 'franchises'); v_companies := private.b45_labels(p_show -> 'companies', 'companies');
  v_gc := private.b45_labels(p_show -> 'genre_candidates', 'genre_candidates'); v_nc := private.b45_labels(p_show -> 'network_candidates', 'network_candidates');
  if jsonb_typeof(p_seasons) is distinct from 'array' or jsonb_array_length(p_seasons) = 0 then
    raise exception 'invalid_input: seasons must be a non-empty list' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  if v_tmdb is not null then
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
  v_id := private.lib_new_show_row(v_owner, v_title, v_key, v_tmdb, 'confirmed');
  if v_id is null then
    perform private.lib_refuse('show_exists', 'This show is already on your list, so nothing was added. Look at it again.');
  end if;
  update public.tv_shows set genres = v_genres, forms = v_forms, franchises = v_franchises, companies = v_companies,
    genre_candidates = v_gc, network_candidates = v_nc
  where id = v_id returning * into v_show;
  v_res := private.lib_add_to_show(v_show, p_show ->> 'network', p_seasons, v_tmdb is not null);
  if jsonb_array_length(coalesce(v_res -> 'inserted', '[]'::jsonb)) <> jsonb_array_length(p_seasons) then
    perform private.lib_refuse('create_conflict', 'Not every season could be added to the new show, so nothing was added. Look at it again.');
  end if;
  return (v_res - 'reopened') || jsonb_build_object('show_created', true, 'show', (select to_jsonb(x) from public.tv_shows x where x.id = v_id));
end $$;

-- TMDB films (library_add_films' contract), To Watch / Normal, with their metadata.
create function public.library_add_films_b45(p_films jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_add_films_b45', 'final');
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
  for f in select * from jsonb_array_elements(p_films) loop
    perform private.lib_valid_film(f, true);
    perform private.b45_labels(f -> x, x) from unnest(array['genres', 'forms', 'franchises', 'companies', 'genre_candidates']) x;
  end loop;
  if (select count(distinct x ->> 'tmdb_id') from jsonb_array_elements(p_films) x) <> jsonb_array_length(p_films) then
    raise exception 'invalid_input: a film is listed twice' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  for f in select * from jsonb_array_elements(p_films) loop
    select id into v_id from public.watchlist_items where user_id = v_owner and media_type = 'movie' and tmdb_id = (f ->> 'tmdb_id')::integer;
    v_twins := case when v_id is null then private.lib_catalog_twins(v_owner, 'film', f ->> 'item_key', f ->> 'title', private.lib_distinct_ids(f -> 'distinct_from')) end;
    if v_id is null and cardinality(v_twins) > 0 then
      v_results := v_results || jsonb_build_object('index', i, 'outcome', 'catalog_candidate', 'candidates', to_jsonb(v_twins));
    elsif v_id is null then
      v_id := private.lib_insert_film_b45(v_owner, f, 'genre', false);
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

-- A film typed by hand (library_create_film's contract), To Watch / Normal.
create function public.library_create_film_b45(p_film jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_create_film_b45', 'final');
  v_distinct uuid[];
  v_id uuid;
begin
  perform private.lib_valid_film(p_film, false);
  perform private.b45_labels(p_film -> x, x) from unnest(array['genres', 'forms', 'franchises', 'companies', 'genre_candidates']) x;
  v_distinct := private.lib_distinct_ids(p_film -> 'distinct_from');
  perform private.lib_write_on();
  perform pg_advisory_xact_lock(hashtext(v_owner::text || '|film|' || (p_film ->> 'item_key')));
  if exists (select 1 from public.watchlist_items where user_id = v_owner and is_film and tmdb_id is null
             and item_key = p_film ->> 'item_key' and not (id = any(v_distinct))) then
    perform private.lib_refuse('film_exists', 'A film with this name is already on your list, so nothing was added. Look at it again.');
  end if;
  perform private.lib_refuse_twins(private.lib_catalog_twins(v_owner, 'film', p_film ->> 'item_key', p_film ->> 'title', v_distinct), 'film', 'added');
  v_id := private.lib_insert_film_b45(v_owner, p_film, 'genre', false);
  if v_id is null then
    perform private.lib_refuse('film_exists', 'A film with this name is already on your list, so nothing was added. Look at it again.');
  end if;
  return jsonb_build_object('id', v_id, 'row', (select to_jsonb(w) - 'is_film' from public.watchlist_items w where w.id = v_id));
end $$;

-- ── Match (plan §8.2) ──
-- The acknowledgment: whenever a Match drops or overrides a value the owner can see, the
-- function answers blocked: 'state_acknowledgment' with the exact list and a token; only a
-- call carrying that token proceeds (the collection-expansion confirmation's pattern).
create function private.b45_ack_token(p_items jsonb) returns text
language sql immutable set search_path = '' as $$
  select md5(coalesce(p_items, '[]'::jsonb)::text)
$$;
-- The differences between two show-shaped states (status excluded: the status block decides it).
create function private.b45_state_diff(p_from jsonb, p_to jsonb, p_fields text[]) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('field', f, 'source', p_from -> f, 'destination', p_to -> f) order by f), '[]')
  from unnest(p_fields) f where (p_from -> f) is distinct from (p_to -> f)
$$;
create function private.b45_show_carry(s public.tv_shows) returns jsonb
language sql immutable set search_path = '' as $$
  select private.b45_show_state(s) || private.b45_show_metadata(s) || jsonb_build_object('legacy_status', s.legacy_status)
$$;

create function private.lib_match_season_core_b45(p_row public.watchlist_items, p_target jsonb, p_patch jsonb, p_expansion jsonb, p_ack text)
returns jsonb
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
  v_src_ids uuid[];
  v_tgt_ids uuid[];
  v_gone uuid[];
  v_ack jsonb := '[]';
  v_src jsonb;
  v_emptied boolean;
  v_fields text[] := array['priority', 'ended', 'catalog_new', 'status_review', 'legacy_status', 'genres', 'forms', 'franchises',
    'companies', 'genre_candidates', 'network', 'network_candidates', 'metadata_owner_set'];
  v_film_status text;
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

  -- The source's state as a show would hold it.
  if r.is_film then
    v_film_status := case when r.status = 'skipped' then 'skipped' else 'confirmed' end;
    v_src := jsonb_build_object('status', v_film_status, 'priority', r.priority, 'ended', false, 'catalog_new', r.catalog_new,
      'status_review', r.status_review, 'legacy_status', case when r.legacy_status in ('pending', 'highpriority', 'maybe') then r.legacy_status end,
      'genres', to_jsonb(r.genres), 'forms', to_jsonb(r.forms), 'franchises', to_jsonb(r.franchises), 'companies', to_jsonb(r.companies),
      'genre_candidates', to_jsonb(r.genre_candidates), 'network', null, 'network_candidates', '[]'::jsonb,
      'metadata_owner_set', r.metadata_owner_set);
    if r.legacy_status in ('watching', 'complete') then
      v_ack := v_ack || jsonb_build_object('field', 'legacy_status', 'source', r.legacy_status, 'effect', 'not_carried');
    end if;
  elsif v_l.id is not null then
    v_src := private.b45_show_carry(v_l);
  end if;
  v_emptied := v_l.id is not null and not exists (select 1 from public.watchlist_items where show_id = v_l.id and id <> r.id);

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
    -- M3 / M5: the destination keeps its values; the source's differing values are acknowledged.
    if v_src is not null then
      v_ack := v_ack || private.b45_state_diff(v_src, private.b45_show_carry(v_t), v_fields)
        || case when r.is_film and v_film_status is distinct from v_t.status
                then jsonb_build_array(jsonb_build_object('field', 'status', 'source', v_film_status, 'destination', v_t.status)) else '[]' end;
    end if;
  elsif v_l.id is not null and v_emptied then
    v_target_show := v_l.id; -- M1: the show is promoted in place and keeps everything
  end if;
  -- A season that leaves its show clears that show's resume range when the range names it (M2 / M3).
  if v_l.id is not null and v_target_show is distinct from v_l.id
     and (v_l.resume_start_season_id = r.id or v_l.resume_end_season_id = r.id) then
    v_ack := v_ack || jsonb_build_object('field', 'resume', 'show_id', v_l.id, 'effect', 'cleared');
  end if;
  if v_l.id is not null and v_target_show is distinct from v_l.id and v_emptied then
    v_ack := v_ack || jsonb_build_object('field', 'source_show', 'show_id', v_l.id, 'effect', 'deleted', 'values', private.b45_show_carry(v_l));
  end if;
  if jsonb_array_length(v_ack) > 0 and p_ack is distinct from private.b45_ack_token(v_ack) then
    return jsonb_build_object('blocked', true, 'reason', 'state_acknowledgment', 'items', v_ack,
      'confirmation', private.b45_ack_token(v_ack), 'changed', p_ack is not null);
  end if;

  if v_target_show is null then
    -- M2 / M4: a new show, carrying the source's state (a film's mapped status).
    insert into public.tv_shows (title, show_key, tmdb_id, status, priority, ended, catalog_new, status_review, legacy_status,
      genres, forms, franchises, companies, genre_candidates, network, network_candidates, metadata_owner_set)
    values (btrim(p_patch ->> 'title'), v_key, v_tmdb, coalesce(v_src ->> 'status', 'confirmed'), coalesce(v_src ->> 'priority', 'normal'),
      coalesce((v_src ->> 'ended')::boolean, false), coalesce((v_src ->> 'catalog_new')::boolean, false),
      coalesce((v_src ->> 'status_review')::boolean, false), v_src ->> 'legacy_status',
      private.b45_labels(v_src -> 'genres', 'genres'), private.b45_labels(v_src -> 'forms', 'forms'),
      private.b45_labels(v_src -> 'franchises', 'franchises'), private.b45_labels(v_src -> 'companies', 'companies'),
      private.b45_labels(v_src -> 'genre_candidates', 'genre_candidates'), v_src ->> 'network',
      private.b45_labels(v_src -> 'network_candidates', 'network_candidates'), coalesce((v_src ->> 'metadata_owner_set')::boolean, false))
    returning id into v_target_show;
  elsif v_target_show = v_l.id then
    update public.tv_shows set tmdb_id = v_tmdb, title = btrim(p_patch ->> 'title'), show_key = v_key where id = v_l.id;
  end if;
  if v_l.id is not null and v_target_show is distinct from v_l.id
     and (v_l.resume_start_season_id = r.id or v_l.resume_end_season_id = r.id) then
    update public.tv_shows set resume_start_season_id = null, resume_end_season_id = null where id = v_l.id;
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

  -- The row becomes a season: film-only values leave it (carried to the show above, or acknowledged).
  update public.watchlist_items set
    title = p_patch ->> 'title', season = p_patch ->> 'season', item_key = p_patch ->> 'item_key',
    theme = coalesce(p_patch ->> 'theme', theme), display_date = coalesce(p_patch ->> 'display_date', display_date),
    date_sort = p_patch ->> 'date_sort', media_type = 'tv', tmdb_id = v_tmdb, season_number = v_num, show_id = v_target_show,
    theme_kind = null, priority = null, catalog_new = null, status_review = null, legacy_status = null, genres = null, forms = null,
    franchises = null, companies = null, genre_candidates = null, metadata_owner_set = null
  where id = r.id and user_id = v_owner and tmdb_id is null and media_type is null and season_number is null
  returning * into r;
  if r.id is null then raise exception 'match_conflict: the row changed; try again' using errcode = '40001'; end if;

  if v_l.id is not null and v_l.id <> v_target_show and not exists (select 1 from public.watchlist_items where show_id = v_l.id) then
    delete from public.tv_shows where id = v_l.id;
  end if;
  return jsonb_build_object('blocked', false, 'row', to_jsonb(r) - 'is_film', 'show_id', v_target_show,
    'discarded_source_state', v_ack);
end $$;

-- library_match_season's contract (5a), with the field rules and acknowledgment above.
create function public.library_match_season_b45(p_row_id uuid, p_target jsonb, p_patch jsonb, p_expansion jsonb default '{}'::jsonb, p_ack text default null)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_match_season_b45', 'final');
  r public.watchlist_items;
  v_tmdb integer;
  v_t uuid;
begin
  begin v_tmdb := (p_target ->> 'tmdb_id')::integer;
  exception when others then raise exception 'invalid_input: tmdb_id' using errcode = '22023'; end;
  if v_tmdb is null then raise exception 'invalid_input: tmdb_id' using errcode = '22023'; end if;
  perform private.lib_write_on();
  perform pg_advisory_xact_lock(hashtext(v_owner::text || '|tvid|' || v_tmdb));
  r := private.lib_match_row(v_owner, p_row_id);
  if r.is_film and private.lib_film_theme_kind(r.id) = 'genre' then
    perform private.lib_refuse('genre_film_season', 'A film whose theme is a genre can''t be matched to a TV season. Nothing was changed.');
  end if;
  select id into v_t from public.tv_shows where user_id = v_owner and tmdb_id = v_tmdb;
  if v_t is not null and private.lib_show_catalog(v_t) is not null then
    perform private.lib_refuse('match_target_governed', 'This TMDB show is part of a built-in catalog on your list, so this row wasn''t matched to it. Nothing was changed.');
  end if;
  if v_t is null then
    perform private.lib_refuse_twins(private.lib_catalog_twins(v_owner, 'show', lower(btrim(coalesce(p_patch ->> 'title', ''))), p_patch ->> 'title',
      private.lib_distinct_ids(p_patch -> 'distinct_from')), 'show', 'matched');
  end if;
  return private.lib_match_season_core_b45(r, p_target, p_patch - 'distinct_from', p_expansion, p_ack);
end $$;

-- library_match_film's contract (5a). A film stays a film with all its values (M7). A
-- season becomes a film (M6) taking its state from its show (never the stale row copy):
-- Skipped when the show is Skipped or the season was skipped (and it isn't watched), else
-- To Watch / Watched by its watched flag; when that would be Skipped + Watched, the owner's
-- explicit choice p_choice ('watched' | 'skipped') is required and applied as a status
-- choice (O1: New and review cleared, no provenance). Ended and network don't exist on a
-- film (acknowledged); complete provenance isn't carried (acknowledged).
create function public.library_match_film_b45(p_row_id uuid, p_expected jsonb, p_patch jsonb, p_ack text default null, p_choice text default null)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_distinct uuid[] := private.lib_distinct_ids(p_patch -> 'distinct_from');
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_match_film_b45', 'final');
  r public.watchlist_items;
  v_tmdb integer;
  v_coll_id integer;
  v_former public.tv_shows;
  v_kind text;
  v_carried int := 0;
  v_deleted boolean := false;
  v_ack jsonb := '[]';
  v_skip boolean;
  v_status text;
  v_watched boolean;
  v_choice boolean := false;
begin
  perform set_config('lock_timeout', '5s', true);
  p_patch := p_patch - 'distinct_from';
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
     or (p_patch ? 'collections' and jsonb_typeof(p_patch -> 'collections') is distinct from 'array')
     or (p_choice is not null and p_choice not in ('watched', 'skipped')) then
    raise exception 'invalid_input: match patch %', p_patch using errcode = '22023';
  end if;
  perform private.lib_write_on();
  r := private.lib_match_row(v_owner, p_row_id);
  if r.show_id is distinct from (p_expected ->> 'show_id')::uuid then
    perform private.lib_refuse('match_conflict', 'This row changed somewhere else before the match was saved, so nothing was matched.');
  end if;
  if r.show_id is not null then select * into v_former from public.tv_shows where id = r.show_id for update; end if;
  select * into r from public.watchlist_items
  where id = r.id and tmdb_id is null and media_type is null and season_number is null and show_id is not distinct from v_former.id for update;
  if r.id is null then
    perform private.lib_refuse('match_conflict', 'This row changed somewhere else before the match was saved, so nothing was matched.');
  end if;
  if exists (select 1 from public.watchlist_items where user_id = v_owner and media_type = 'movie' and tmdb_id = v_tmdb) then
    perform private.lib_refuse('match_conflict', 'This TMDB film is already on your list, so nothing was matched.');
  end if;
  perform private.lib_refuse_twins(array(select x from unnest(private.lib_catalog_twins(v_owner, 'film', p_patch ->> 'item_key', p_patch ->> 'title', v_distinct)) x
    where x <> r.id), 'film', 'matched');
  v_kind := case when r.is_film then private.lib_film_theme_kind(r.id) else 'other' end;

  if r.is_film then
    -- M7: a film keeps every value.
    r := private.lib_film_match_update(r.id, p_patch, v_tmdb, v_coll_id, v_kind);
    return jsonb_build_object('row', to_jsonb(r) - 'is_film', 'former_show_id', null, 'former_show_deleted', false,
      'memberships_carried', 0, 'discarded_source_state', '[]'::jsonb);
  end if;

  -- M6: the film's state from its show.
  v_skip := v_former.status = 'skipped' or r.skipped;
  if v_skip and r.watched then
    if p_choice is null then
      return jsonb_build_object('blocked', true, 'reason', 'state_choice', 'choices', jsonb_build_array('watched', 'skipped'));
    end if;
    v_choice := true;
    v_status := case when p_choice = 'skipped' then 'skipped' else 'confirmed' end;
    v_watched := p_choice = 'watched';
  else
    if p_choice is not null then raise exception 'invalid_input: no choice is needed for this row' using errcode = '22023'; end if;
    v_status := case when v_skip then 'skipped' else 'confirmed' end;
    v_watched := r.watched;
  end if;
  if v_former.ended then v_ack := v_ack || jsonb_build_object('field', 'ended', 'source', true, 'effect', 'dropped'); end if;
  if v_former.network is not null then v_ack := v_ack || jsonb_build_object('field', 'network', 'source', v_former.network, 'effect', 'dropped'); end if;
  if cardinality(v_former.network_candidates) > 0 then
    v_ack := v_ack || jsonb_build_object('field', 'network_candidates', 'source', to_jsonb(v_former.network_candidates), 'effect', 'dropped');
  end if;
  if not v_choice and v_former.legacy_status = 'complete' then
    v_ack := v_ack || jsonb_build_object('field', 'legacy_status', 'source', 'complete', 'effect', 'not_carried');
  end if;
  if v_former.resume_start_season_id = r.id or v_former.resume_end_season_id = r.id then
    v_ack := v_ack || jsonb_build_object('field', 'resume', 'show_id', v_former.id, 'effect', 'cleared');
  end if;
  if not exists (select 1 from public.watchlist_items where show_id = v_former.id and id <> r.id) then
    v_ack := v_ack || jsonb_build_object('field', 'source_show', 'show_id', v_former.id, 'effect', 'deleted', 'values', private.b45_show_carry(v_former));
  end if;
  if jsonb_array_length(v_ack) > 0 and p_ack is distinct from private.b45_ack_token(v_ack) then
    return jsonb_build_object('blocked', true, 'reason', 'state_acknowledgment', 'items', v_ack,
      'confirmation', private.b45_ack_token(v_ack), 'changed', p_ack is not null);
  end if;

  if v_former.resume_start_season_id = r.id or v_former.resume_end_season_id = r.id then
    update public.tv_shows set resume_start_season_id = null, resume_end_season_id = null where id = v_former.id;
  end if;
  update public.watchlist_items set
    title = btrim(p_patch ->> 'title'), season = 'Film', item_key = p_patch ->> 'item_key',
    theme = coalesce(p_patch ->> 'theme', theme), display_date = coalesce(p_patch ->> 'display_date', display_date),
    date_sort = p_patch ->> 'date_sort', tmdb_collection_id = v_coll_id, tmdb_collection_name = p_patch ->> 'tmdb_collection_name',
    collections = case when p_patch ? 'collections' then coalesce(array(select jsonb_array_elements_text(p_patch -> 'collections')), '{}') else collections end,
    media_type = 'movie', tmdb_id = v_tmdb, season_number = null, show_id = null, theme_kind = v_kind, skipped = false,
    status = v_status, watched = v_watched, priority = v_former.priority,
    catalog_new = case when v_choice then false else v_former.catalog_new end,
    status_review = case when v_choice then false else v_former.status_review end,
    legacy_status = case when v_choice then null when v_former.legacy_status in ('pending', 'highpriority', 'maybe') then v_former.legacy_status end,
    genres = v_former.genres, forms = v_former.forms, franchises = v_former.franchises, companies = v_former.companies,
    genre_candidates = v_former.genre_candidates, metadata_owner_set = v_former.metadata_owner_set
  where id = r.id
  returning * into r;

  insert into public.collection_memberships (collection_id, item_id)
  select m.collection_id, r.id from public.collection_memberships m where m.show_id = v_former.id
  on conflict (collection_id, item_id) where (item_id is not null) do nothing;
  select count(*) into v_carried from public.collection_memberships m
  where m.item_id = r.id and m.collection_id in (select collection_id from public.collection_memberships where show_id = v_former.id);
  if not exists (select 1 from public.watchlist_items where show_id = v_former.id) then
    delete from public.tv_shows where id = v_former.id;
    v_deleted := true;
  end if;
  return jsonb_build_object('row', to_jsonb(r) - 'is_film', 'former_show_id', v_former.id, 'former_show_deleted', v_deleted,
    'memberships_carried', v_carried, 'discarded_source_state', v_ack, 'state_choice', case when v_choice then p_choice end);
end $$;

-- ── Catalog application (effects document b45.1) ──
-- lib_catalog_insert_v5's rules, except: every record a catalog creates is To Watch /
-- Normal / New from catalog (p is accepted and no longer decides anything); seasons
-- added to an existing show never change it (no reopen).
create function private.lib_catalog_insert_b45(p_owner uuid, p_catalog text, p_defaults jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  d jsonb;
  g record;
  v_show public.tv_shows;
  r public.watchlist_items;
  v_inserted uuid[] := '{}';
  v_created_shows uuid[] := '{}';
  v_conflicts jsonb := '[]';
  v_identified jsonb := '[]';
  v_enriched jsonb;
  v_film uuid;
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
          'theme', x.def ->> 'th', 'display_date', x.def ->> 'd', 'date_sort', x.def ->> 'ds', 'status', 'confirmed')), '[]')
        from jsonb_array_elements(p_defaults) as x(def)
        where x.def ->> 's' <> 'Film' and private.tv_show_key(p_catalog, x.def ->> 'k') = g.show_key));
      v_inserted := v_inserted || array(select jsonb_array_elements_text(v_enriched -> 'inserted')::uuid);
      v_conflicts := v_conflicts || (v_enriched -> 'rejected');
      v_identified := v_identified || (v_enriched -> 'existing');
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
    if v_show.id is null then
      insert into public.tv_shows (title, show_key, tmdb_id, status, priority, catalog_new)
      values (g.title, g.show_key, null, 'confirmed', 'normal', true)
      returning * into v_show;
      insert into public.catalog_show_links (catalog, catalog_key, show_id, origin)
      values (p_catalog, g.show_key, v_show.id, 'catalog_insert');
      v_created_shows := v_created_shows || v_show.id;
    end if;
    for d in select * from jsonb_array_elements(g.missing) loop
      r := null;
      insert into public.watchlist_items (item_key, title, season, theme, display_date, date_sort, watched, status, show_id)
      values (d ->> 'k', d ->> 't', d ->> 's', coalesce(d ->> 'th', ''), coalesce(d ->> 'd', ''), d ->> 'ds', false, 'confirmed', v_show.id)
      on conflict do nothing
      returning * into r;
      if r.id is not null then v_inserted := v_inserted || r.id; end if;
    end loop;
  end loop;

  for d in select * from jsonb_array_elements(p_defaults) loop
    if d ->> 's' <> 'Film' then continue; end if;
    if exists (select 1 from public.catalog_film_links l where l.user_id = p_owner and l.catalog = p_catalog and l.entry_key = d ->> 'k') then
      continue;
    end if;
    v_film := private.lib_insert_film_b45(p_owner, jsonb_build_object('item_key', d ->> 'k', 'title', d ->> 't', 'theme', coalesce(d ->> 'th', ''),
      'display_date', coalesce(d ->> 'd', ''), 'date_sort', d ->> 'ds'), 'other', true);
    if v_film is null then raise exception 'integrity_fault: a catalog film couldn''t be inserted' using errcode = '23000'; end if;
    insert into public.catalog_film_links (catalog, entry_key, item_id, origin)
    values (p_catalog, d ->> 'k', v_film, 'catalog_insert');
    v_inserted := v_inserted || v_film;
  end loop;

  return jsonb_build_object('inserted', to_jsonb(v_inserted), 'created_shows', to_jsonb(v_created_shows),
    'reopened', '[]'::jsonb, 'conflicts', v_conflicts, 'identified', v_identified);
end $$;

-- catalog_run5 (5a) with lib_catalog_insert_b45: new records' entries carry priority and
-- catalog_new; an existing show that is marked ended and receives seasons is noted
-- (ended_kept) instead of reopened. Version b45.1.
create function private.catalog_run_b45(p_catalog text, p_defaults jsonb) returns jsonb
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
  v_pre_ended jsonb;
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
  perform set_config('lock_timeout', '2s', true);
  begin
    perform private.lib_catalog_lock();
  exception when lock_not_available or deadlock_detected then
    raise exception 'catalog_busy: The database was busy, so nothing was changed. Review again in a moment.' using errcode = 'P0001';
  end;
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

  select coalesce(jsonb_object_agg(id::text, status), '{}'), coalesce(jsonb_object_agg(id::text, ended), '{}')
    into v_pre_status, v_pre_ended
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
  select coalesce(jsonb_agg(e.value order by e.ordinality), '[]') into v_keep
  from jsonb_array_elements(v_missing) with ordinality e
  where exists (select 1 from jsonb_array_elements(v_keep) k where k ->> 'k' = e.value ->> 'k');
  v_ins := private.lib_catalog_insert_b45(v_owner, p_catalog, v_keep);

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

  for x in select s.* from public.tv_shows s where (v_refs ? s.id::text) loop
    v_entries := v_entries || jsonb_build_object('kind', 'create_show', 'key', 'create_show:' || (v_refs ->> x.id::text),
      'ref', v_refs ->> x.id::text, 'show_key', x.show_key, 'title', x.title, 'tmdb_id', x.tmdb_id, 'initial_status', x.status,
      'priority', x.priority, 'catalog_new', x.catalog_new);
    v_receipt := v_receipt || jsonb_build_object('create_show:' || (v_refs ->> x.id::text), jsonb_build_object('show_id', x.id));
  end loop;
  for x in select distinct s.id, s.show_key from public.watchlist_items w join public.tv_shows s on s.id = w.show_id
           where w.id = any(array(select jsonb_array_elements_text(v_ins -> 'inserted')::uuid)) and not (v_refs ? s.id::text) loop
    v_entries := v_entries || jsonb_build_object('kind', 'attach', 'key', 'attach:' || x.id, 'show_id', x.id, 'show_key', x.show_key,
      'status', v_pre_status ->> x.id::text);
    if coalesce((v_pre_ended ->> x.id::text)::boolean, false) then
      v_entries := v_entries || jsonb_build_object('kind', 'ended_kept', 'key', 'ended_kept:' || x.id, 'show_id', x.id, 'show_key', x.show_key);
      v_receipt := v_receipt || jsonb_build_object('ended_kept:' || x.id, jsonb_build_object('show_id', x.id));
    end if;
  end loop;
  for x in select w.*, s.show_key from public.watchlist_items w left join public.tv_shows s on s.id = w.show_id
           where w.id = any(array(select jsonb_array_elements_text(v_ins -> 'inserted')::uuid)) loop
    if x.is_film then
      v_entries := v_entries || jsonb_build_object('kind', 'insert_film', 'key', 'insert_film:' || (v_refs ->> x.id::text),
        'ref', v_refs ->> x.id::text, 'item_key', x.item_key, 'title', x.title, 'season', x.season, 'theme', x.theme,
        'display_date', x.display_date, 'date_sort', x.date_sort, 'status', x.status, 'watched', x.watched,
        'media_type', x.media_type, 'tmdb_id', x.tmdb_id, 'priority', x.priority, 'catalog_new', x.catalog_new);
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
  if exists (select 1 from jsonb_each(v_refs) rf
             where not exists (select 1 from public.tv_shows s where s.id = rf.key::uuid and s.status = 'confirmed' and s.priority = 'normal' and s.catalog_new)
               and not exists (select 1 from public.watchlist_items w where w.id = rf.key::uuid and w.status = 'confirmed' and w.priority = 'normal' and w.catalog_new)) then
    raise exception 'integrity_fault: a new record is not To Watch / Normal / New from catalog' using errcode = '23000';
  end if;
  if exists (select 1 from public.tv_shows s where s.user_id = v_owner and (v_pre_status ? s.id::text)
             and (s.status is distinct from v_pre_status ->> s.id::text or s.ended is distinct from (v_pre_ended ->> s.id::text)::boolean)) then
    raise exception 'integrity_fault: an existing show''s status or Ended changed' using errcode = '23000';
  end if;
  if exists (select 1 from jsonb_array_elements(v_fills) ff join public.watchlist_items w on w.id = (ff ->> 'row_id')::uuid
             where w.display_date is distinct from ff ->> 'new_display' or w.date_sort is distinct from ff ->> 'new_sort') then
    raise exception 'integrity_fault: a date fill did not hold' using errcode = '23000';
  end if;

  select coalesce(jsonb_agg(e order by case e ->> 'kind' when 'create_show' then 1 when 'attach' then 2 when 'insert_season' then 3
                    when 'insert_film' then 4 when 'fill_date' then 5 when 'ended_kept' then 6 when 'membership' then 7
                    when 'excluded_conflict' then 8 else 9 end, e ->> 'key' collate "C"), '[]')
    into v_entries from jsonb_array_elements(v_entries) e;
  v_doc := jsonb_build_object('version', 'b45.1', 'owner', v_owner, 'catalog', p_catalog, 'payload_hash', v_payload_hash,
    'target', case when v_target.id is null then null else jsonb_build_object('collection_id', v_target.id, 'archived', v_target.archived_at is not null) end,
    'entries', v_entries);
  return jsonb_build_object('document', v_doc, 'hash', private.catalog_hash(v_doc), 'receipt', v_receipt);
end $$;

create function public.library_catalog_apply_b45(p_catalog text, p_defaults jsonb, p_approved text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v jsonb;
begin
  perform private.tv_require_stage('library_catalog_apply_b45', 'final');
  begin
    if p_approved is null then
      begin
        v := private.catalog_run_b45(p_catalog, p_defaults);
        raise exception 'catalog_preview_rollback' using errcode = 'P0001';
      exception when sqlstate 'P0001' then
        if sqlerrm <> 'catalog_preview_rollback' then raise; end if;
      end;
      return jsonb_build_object('mode', 'preview', 'document', v -> 'document', 'hash', v ->> 'hash');
    end if;
    v := private.catalog_run_b45(p_catalog, p_defaults);
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

-- ── Old names whose meaning changed: refusing stubs (nothing written) ──
create or replace function public.set_show_status(p_show_id uuid, p_status text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;
create or replace function public.library_add_seasons(p_show_id uuid, p_expected jsonb, p_seasons jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;
create or replace function public.library_create_show(p_show jsonb, p_seasons jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;
create or replace function public.library_add_films(p_films jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;
create or replace function public.library_create_film(p_film jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;
create or replace function public.library_match_season(p_row_id uuid, p_target jsonb, p_patch jsonb, p_expansion jsonb default '{}'::jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;
create or replace function public.library_match_film(p_row_id uuid, p_expected jsonb, p_patch jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;
create or replace function public.library_catalog_apply(p_catalog text, p_defaults jsonb, p_approved text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: This page is out of date. Reload it. Nothing was changed.' using errcode = 'P0001';
end $$;

-- ── restore_backup: format 5 ──
-- A format-5 backup replaces the owner's rows in all eight tables in one transaction
-- (ids and created_at kept; another owner's ids refused). Formats 3 and 4 are converted in
-- the page first (format 3 → 4 → 5). A converted document may carry conversion
-- {source_format: '3' | '4', …}; a recovery section is accepted only with source_format '3'
-- and while the archive is active (the 5c rules), and replaces the owner's archive entries.
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
      'tmdb_collection_name','media_type','tmdb_id','season_number','show_id','skipped',
      'priority','catalog_new','status_review','legacy_status','genres','forms','franchises','companies','genre_candidates','metadata_owner_set'),
    'tv_shows', jsonb_build_array('id','title','show_key','tmdb_id','status','created_at',
      'priority','ended','catalog_new','status_review','legacy_status','genres','forms','franchises','companies','genre_candidates',
      'network','network_candidates','metadata_owner_set','resume_start_season_id','resume_end_season_id'),
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
  elsif v_version in ('3', '4') then
    raise exception 'restore_invalid: format % backups are converted in the page first (Restore shows what the conversion keeps and what it can''t); nothing was changed', v_version
      using errcode = '22023';
  elsif v_version is distinct from '5' then
    raise exception 'restore_invalid: unsupported backup format %', coalesce(v_version, '(none)') using errcode = '22023';
  end if;
  if private.tv_stage() <> 'final' then
    raise exception 'restore_invalid: format 5 needs stage final, found %', private.tv_stage() using errcode = '22023';
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

  if v_conv is not null and (jsonb_typeof(v_conv) is distinct from 'object'
     or (v_conv ->> 'source_format') not in ('3', '4') or coalesce(v_conv ->> 'source_sha256', '') !~ '^[0-9a-f]{64}$'
     or coalesce(v_conv ->> 'converter_version', '') = '' or coalesce(v_conv ->> 'source_exported_at', '') = '') then
    raise exception 'restore_invalid: the conversion record is malformed' using errcode = '22023';
  end if;
  if v_rec is not null then
    if v_conv is null or (v_conv ->> 'source_format') is distinct from '3' then
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

  delete from public.collection_memberships where user_id = v_owner;
  -- (the owner's shows lose their resume ranges with them; the ranges come back from the file)
  update public.tv_shows set resume_start_season_id = null, resume_end_season_id = null
  where user_id = v_owner and resume_start_season_id is not null;
  delete from public.watchlist_items where user_id = v_owner;
  delete from public.tv_shows where user_id = v_owner;
  delete from public.personal_collections where user_id = v_owner;
  delete from public.watch_with_choices where user_id = v_owner;
  delete from public.custom_collections where user_id = v_owner;

  begin
    -- (whatever the session's mode: shows name seasons inserted after them)
    set constraints public.tv_shows_resume_start_fkey, public.tv_shows_resume_end_fkey deferred;
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

    insert into public.tv_shows (id, title, show_key, tmdb_id, status, created_at, priority, ended, catalog_new, status_review,
      legacy_status, genres, forms, franchises, companies, genre_candidates, network, network_candidates, metadata_owner_set,
      resume_start_season_id, resume_end_season_id)
    select id, title, show_key, tmdb_id, status, created_at, priority, ended, catalog_new, status_review,
      legacy_status, genres, forms, franchises, companies, genre_candidates, network, network_candidates, metadata_owner_set,
      resume_start_season_id, resume_end_season_id
    from jsonb_to_recordset(v_tables -> 'tv_shows') as x(id uuid, title text, show_key text,
      tmdb_id integer, status text, created_at timestamptz, priority text, ended boolean, catalog_new boolean, status_review boolean,
      legacy_status text, genres text[], forms text[], franchises text[], companies text[], genre_candidates text[], network text,
      network_candidates text[], metadata_owner_set boolean, resume_start_season_id uuid, resume_end_season_id uuid);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('tv_shows', v_k);

    insert into public.watchlist_items (id, item_key, title, season, theme, theme_kind, display_date, date_sort,
      watched, status, created_at, watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type,
      tmdb_id, season_number, show_id, skipped, priority, catalog_new, status_review, legacy_status, genres, forms, franchises,
      companies, genre_candidates, metadata_owner_set)
    select id, item_key, title, season, theme, theme_kind, display_date, date_sort, watched, status, created_at,
      watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number,
      show_id, skipped, priority, catalog_new, status_review, legacy_status, genres, forms, franchises, companies, genre_candidates,
      metadata_owner_set
    from jsonb_to_recordset(v_tables -> 'watchlist_items') as x(id uuid, item_key text, title text,
      season text, theme text, theme_kind text, display_date text, date_sort text, watched boolean, status text, created_at timestamptz,
      watch_with text[], collections text[], tmdb_collection_id integer, tmdb_collection_name text, media_type text,
      tmdb_id integer, season_number integer, show_id uuid, skipped boolean, priority text, catalog_new boolean, status_review boolean,
      legacy_status text, genres text[], forms text[], franchises text[], companies text[], genre_candidates text[], metadata_owner_set boolean);
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
    -- The resume ranges are checked now (deferred until the seasons were in).
    set constraints public.tv_shows_resume_start_fkey, public.tv_shows_resume_end_fkey immediate;
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
      -- One row per collection and numeric TMDB id ("0990000077" and 990000077 are the same show);
      -- an id that isn't digits is counted by othertv_rows instead.
      'othertv_repeats', (select count(*) from (select x ->> 'collection',
                                 case when (x ->> 'tmdb_id') ~ '^[0-9]+$' then (x ->> 'tmdb_id')::numeric end
                          from jsonb_array_elements(v_rec -> 'othertv_shows') x where (x ->> 'tmdb_id') ~ '^[0-9]+$'
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

  return jsonb_build_object('formatVersion', 5, 'restored', v_n,
    'recovery', case when v_rec is not null then 'archived' else 'none' end,
    'converted_from', case when v_conv is not null then (v_conv ->> 'source_format')::int end);
end
$$;

create or replace function public.stage5_capabilities() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted-b45', 'backup_format', 5, 'b45', 1,
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;

-- ── The B45 rollback report (db/rollback/b45_report.sql runs it; db/rollback/b45.sql binds to it) ──
-- The rollback's status for one record (plan §10.2) and its tier.
create function private.b45_inverse(p_kind text, p_status text, p_priority text, p_ended boolean, p_catalog_new boolean,
  p_review boolean, p_legacy text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_img jsonb; v_cur jsonb; v_diff jsonb;
begin
  v_cur := jsonb_build_object('priority', p_priority, 'ended', coalesce(p_ended, false), 'catalog_new', p_catalog_new);
  if p_legacy is not null then
    v_img := case p_legacy
      when 'pending' then jsonb_build_object('priority', 'normal', 'ended', false, 'catalog_new', true)
      when 'highpriority' then jsonb_build_object('priority', 'high', 'ended', false, 'catalog_new', false)
      when 'maybe' then jsonb_build_object('priority', 'low', 'ended', false, 'catalog_new', false)
      when 'complete' then jsonb_build_object('priority', 'normal', 'ended', p_kind = 'show', 'catalog_new', false)
      else jsonb_build_object('priority', 'normal', 'ended', false, 'catalog_new', false) end;
    select coalesce(jsonb_object_agg(k, v_cur -> k), '{}') into v_diff from jsonb_object_keys(v_img) k where (v_cur -> k) is distinct from (v_img -> k);
    if p_review and p_legacy in ('pending', 'highpriority', 'maybe') then v_diff := v_diff || jsonb_build_object('status_review', true); end if;
    return jsonb_build_object('status', p_legacy, 'tier', case when v_diff = '{}'::jsonb then '1' else '1L' end, 'discarded', v_diff);
  end if;
  if p_priority = 'normal' and not coalesce(p_ended, false) and not p_catalog_new and not p_review then
    return jsonb_build_object('status', p_status, 'tier', '2', 'discarded', '{}'::jsonb);
  end if;
  return jsonb_build_object('tier', '3',
    'status', case when p_status = 'skipped' then 'skipped' when p_status = 'watching' then 'watching'
                   when coalesce(p_ended, false) then 'complete' when p_catalog_new then 'pending'
                   when p_priority = 'high' then 'highpriority' when p_priority = 'low' then 'maybe' else 'confirmed' end,
    'discarded', jsonb_strip_nulls(jsonb_build_object('status', p_status, 'priority', nullif(p_priority, 'normal'),
      'ended', case when p_ended then true end, 'catalog_new', case when p_catalog_new then true end,
      'status_review', case when p_review then true end)));
end $$;

-- Everything the rollback reads or preserves, bound row for row; what it would project and
-- discard. Deterministic (no time, no session values): equal state → equal report.
create function private.b45_rollback_report() returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_binding jsonb := '{}';
  v_backup jsonb := '{}';
  v_t text;
  v jsonb;
  v_cols jsonb := jsonb_build_object(
    'watchlist_items', array['id','item_key','title','season','theme','theme_kind','display_date','date_sort','watched','status','created_at',
      'watch_with','collections','tmdb_collection_id','tmdb_collection_name','media_type','tmdb_id','season_number','show_id','skipped',
      'priority','catalog_new','status_review','legacy_status','genres','forms','franchises','companies','genre_candidates','metadata_owner_set'],
    'tv_shows', array['id','title','show_key','tmdb_id','status','created_at','priority','ended','catalog_new','status_review','legacy_status',
      'genres','forms','franchises','companies','genre_candidates','network','network_candidates','metadata_owner_set',
      'resume_start_season_id','resume_end_season_id'],
    'custom_collections', array['id','name','tmdb_person_id','created_at','role'],
    'personal_collections', array['id','name','catalog_id','presentation_key','sort_order','archived_at','created_at'],
    'collection_memberships', array['id','collection_id','show_id','item_id','created_at'],
    'watch_with_choices', array['id','token','label','sort_order','archived_at','created_at'],
    'catalog_show_links', array['id','catalog','catalog_key','show_id','origin','created_at'],
    'catalog_film_links', array['id','catalog','entry_key','item_id','origin','created_at']);
  v_projected jsonb;
  v_metadata jsonb;
  v_resume jsonb;
  v_tiers jsonb;
begin
  -- (a) the binding: every column of every row (owners included), the inventory, the capability.
  for v_t in select unnest(array['public.tv_shows', 'public.watchlist_items', 'public.custom_collections', 'public.personal_collections',
      'public.collection_memberships', 'public.watch_with_choices', 'public.catalog_show_links', 'public.catalog_film_links',
      'private.stage5_recovery_records', 'private.stage5_recovery_collections', 'private.stage5_recovery_othertv', 'private.stage5_recovery_meta']) loop
    execute format('select jsonb_build_object(''n'', count(*), ''md5'', md5(coalesce(string_agg(to_jsonb(t)::text, ''|'' order by to_jsonb(t)::text), ''''))) from %s t', v_t)
      into v;
    v_binding := v_binding || jsonb_build_object(v_t, v);
  end loop;
  -- (b) backup-comparable digests: exactly the format-5 columns (no user_id), by id.
  for v_t in select jsonb_object_keys(v_cols) loop
    execute format('select jsonb_build_object(''n'', count(*), ''md5'', md5(coalesce(string_agg(
        (select jsonb_object_agg(c, to_jsonb(t) -> c) from unnest($1) c)::text, ''|'' order by t.id), ''''))) from public.%I t', v_t)
      into v using array(select jsonb_array_elements_text(v_cols -> v_t));
    v_backup := v_backup || jsonb_build_object(v_t, v);
  end loop;
  -- (c) tiers, projections, discarded values.
  with x as (
    select 'show' kind, s.id, s.title, s.status, null::boolean watched,
      private.b45_inverse('show', s.status, s.priority, s.ended, s.catalog_new, s.status_review, s.legacy_status) inv,
      jsonb_build_object('status', s.status, 'priority', s.priority, 'ended', s.ended, 'catalog_new', s.catalog_new,
        'status_review', s.status_review, 'legacy_status', s.legacy_status) cur
    from public.tv_shows s
    union all
    select 'film', w.id, w.title, w.status, w.watched,
      private.b45_inverse('film', w.status, w.priority, null, w.catalog_new, w.status_review, w.legacy_status),
      jsonb_build_object('status', w.status, 'watched', w.watched, 'priority', w.priority, 'catalog_new', w.catalog_new,
        'status_review', w.status_review, 'legacy_status', w.legacy_status)
    from public.watchlist_items w where w.is_film
  )
  select
    (select jsonb_object_agg(k, n) from (select kind || ':' || (inv ->> 'tier') k, count(*) n from x group by 1) z),
    coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'title', title, 'current', cur, 'rollback_status', inv ->> 'status',
        'tier', inv ->> 'tier', 'discarded', inv -> 'discarded') order by kind, id) from x where inv ->> 'tier' in ('1L', '3')), '[]')
  into v_tiers, v_projected;
  select coalesce(jsonb_agg(m order by m ->> 'kind', m ->> 'id'), '[]') into v_metadata from (
    select jsonb_build_object('kind', 'show', 'id', s.id, 'title', s.title, 'values', private.b45_show_metadata(s)) m from public.tv_shows s
    where s.metadata_owner_set or s.network is not null or cardinality(s.genres) + cardinality(s.forms) + cardinality(s.franchises)
      + cardinality(s.companies) + cardinality(s.genre_candidates) + cardinality(s.network_candidates) > 0
    union all
    select jsonb_build_object('kind', 'film', 'id', w.id, 'title', w.title, 'values', private.b45_film_metadata(w)) from public.watchlist_items w
    where w.is_film and (w.metadata_owner_set or cardinality(w.genres) + cardinality(w.forms) + cardinality(w.franchises)
      + cardinality(w.companies) + cardinality(w.genre_candidates) > 0)) z;
  select coalesce(jsonb_agg(jsonb_build_object('show_id', s.id, 'title', s.title,
      'start', (select season from public.watchlist_items where id = s.resume_start_season_id),
      'end', (select season from public.watchlist_items where id = s.resume_end_season_id),
      'state', private.b45_resume_state(s.id)) order by s.id), '[]')
    into v_resume from public.tv_shows s where s.resume_start_season_id is not null;
  return jsonb_build_object('version', 'b45-rollback-report-1',
    'binding', jsonb_build_object('tables', v_binding, 'inventory_md5', md5(private.b45_inventory()::text),
      'capability', public.stage5_capabilities()),
    'baseline_inventory_md5', (select md5(baseline_inventory::text) from private.b45_meta),
    'backup_digests', v_backup,
    'tiers', coalesce(v_tiers, '{}'), 'projected', v_projected, 'discarded_metadata', v_metadata, 'discarded_resume', v_resume,
    'lossy', jsonb_array_length(v_projected) + jsonb_array_length(v_metadata) + jsonb_array_length(v_resume));
end $$;

-- ── Permissions ──────────────────────────────────────────────────────────────
revoke all on function
  private.b45_labels_ok(text[]), private.b45_show_guard(), private.b45_resume_cleanup(), private.b45_changed(),
  private.b45_is_special(public.watchlist_items), private.b45_season_number(public.watchlist_items), private.b45_main_seasons(uuid),
  private.b45_resume_state(uuid), private.b45_show_state(public.tv_shows), private.b45_film_state(public.watchlist_items),
  private.b45_show_metadata(public.tv_shows), private.b45_film_metadata(public.watchlist_items), private.b45_labels(jsonb, text),
  private.lib_insert_film_b45(uuid, jsonb, text, boolean), private.b45_ack_token(jsonb), private.b45_state_diff(jsonb, jsonb, text[]),
  private.b45_show_carry(public.tv_shows), private.lib_match_season_core_b45(public.watchlist_items, jsonb, jsonb, jsonb, text),
  private.lib_catalog_insert_b45(uuid, text, jsonb), private.catalog_run_b45(text, jsonb),
  private.b45_inverse(text, text, text, boolean, boolean, boolean, text), private.b45_rollback_report(),
  public.library_set_show_state_b45(uuid, jsonb, jsonb), public.library_set_film_state_b45(uuid, jsonb, jsonb),
  public.library_set_metadata_b45(text, uuid, jsonb, jsonb), public.library_dismiss_catalog_new_b45(jsonb),
  public.library_dismiss_review_b45(text, uuid, jsonb), public.library_set_resume_b45(uuid, jsonb, uuid, uuid, boolean),
  public.library_add_seasons_b45(uuid, jsonb, jsonb), public.library_create_show_b45(jsonb, jsonb), public.library_add_films_b45(jsonb),
  public.library_create_film_b45(jsonb), public.library_match_season_b45(uuid, jsonb, jsonb, jsonb, text),
  public.library_match_film_b45(uuid, jsonb, jsonb, text, text), public.library_catalog_apply_b45(text, jsonb, text)
from public;
grant execute on function
  private.b45_labels_ok(text[]), private.b45_changed(),
  private.b45_is_special(public.watchlist_items), private.b45_season_number(public.watchlist_items), private.b45_main_seasons(uuid),
  private.b45_resume_state(uuid), private.b45_show_state(public.tv_shows), private.b45_film_state(public.watchlist_items),
  private.b45_show_metadata(public.tv_shows), private.b45_film_metadata(public.watchlist_items), private.b45_labels(jsonb, text),
  private.lib_insert_film_b45(uuid, jsonb, text, boolean), private.b45_ack_token(jsonb), private.b45_state_diff(jsonb, jsonb, text[]),
  private.b45_show_carry(public.tv_shows), private.lib_match_season_core_b45(public.watchlist_items, jsonb, jsonb, jsonb, text),
  private.lib_catalog_insert_b45(uuid, text, jsonb), private.catalog_run_b45(text, jsonb),
  public.library_set_show_state_b45(uuid, jsonb, jsonb), public.library_set_film_state_b45(uuid, jsonb, jsonb),
  public.library_set_metadata_b45(text, uuid, jsonb, jsonb), public.library_dismiss_catalog_new_b45(jsonb),
  public.library_dismiss_review_b45(text, uuid, jsonb), public.library_set_resume_b45(uuid, jsonb, uuid, uuid, boolean),
  public.library_add_seasons_b45(uuid, jsonb, jsonb), public.library_create_show_b45(jsonb, jsonb), public.library_add_films_b45(jsonb),
  public.library_create_film_b45(jsonb), public.library_match_season_b45(uuid, jsonb, jsonb, jsonb, text),
  public.library_match_film_b45(uuid, jsonb, jsonb, text, text), public.library_catalog_apply_b45(text, jsonb, text)
to anon, authenticated;

-- ── 6. Verify before commit ──────────────────────────────────────────────────
do $$
declare b record; a record; v_bad jsonb;
begin
  select * into b from b45_before;
  select
    (select md5(coalesce(string_agg((to_jsonb(t) - 'status' - 'priority' - 'ended' - 'catalog_new' - 'status_review' - 'legacy_status' - 'genres'
      - 'forms' - 'franchises' - 'companies' - 'genre_candidates' - 'network' - 'network_candidates' - 'metadata_owner_set'
      - 'resume_start_season_id' - 'resume_end_season_id')::text, '|' order by t.id), '')) from public.tv_shows t) shows_rest,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'status' - 'priority' - 'catalog_new' - 'status_review' - 'legacy_status' - 'genres'
      - 'forms' - 'franchises' - 'companies' - 'genre_candidates' - 'metadata_owner_set')::text, '|' order by t.id), '')) from public.watchlist_items t) items_rest,
    (select md5(coalesce(string_agg(t.id || ':' || t.status, '|' order by t.id), '')) from public.watchlist_items t where not t.is_film) season_status,
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.personal_collections t) collections,
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.collection_memberships t) memberships,
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.watch_with_choices t) choices,
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.custom_collections t) custom,
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.catalog_show_links t) show_links,
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.catalog_film_links t) film_links,
    (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.stage5_recovery_records t) a_records,
    (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.stage5_recovery_collections t) a_collections,
    (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.stage5_recovery_othertv t) a_othertv,
    (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.stage5_recovery_meta t) a_meta
  into a;
  if a is distinct from b then raise exception 'b45: a preserved value changed (before %, after %)', row_to_json(b), row_to_json(a); end if;
  -- Every status, priority, Ended, marker and provenance value is exactly the mapping of the old status.
  select jsonb_strip_nulls(jsonb_build_object(
    'shows', (select jsonb_agg(s.id) from public.tv_shows s join b45_old o on o.kind = 'show' and o.id = s.id
      where (s.status, s.priority, s.ended, s.catalog_new, s.status_review, s.legacy_status) is distinct from (
        case o.status when 'pending' then 'confirmed' when 'highpriority' then 'confirmed' when 'maybe' then 'confirmed'
          when 'complete' then (select c.choices -> 'shows' ->> s.id::text from b45_choices c) else o.status end,
        case o.status when 'highpriority' then 'high' when 'maybe' then 'low' else 'normal' end,
        o.status = 'complete', o.status = 'pending', false,
        case when o.status in ('pending', 'highpriority', 'maybe', 'complete') then o.status end)),
    'films', (select jsonb_agg(w.id) from public.watchlist_items w join b45_old o on o.kind = 'film' and o.id = w.id
      where (w.status, w.watched, w.priority, w.catalog_new, w.status_review, w.legacy_status) is distinct from (
        case when o.status in ('watching', 'complete') then (select c.choices -> 'films' ->> w.id::text from b45_choices c)
             when o.status in ('pending', 'highpriority', 'maybe') then 'confirmed' else o.status end,
        o.watched,
        case o.status when 'highpriority' then 'high' when 'maybe' then 'low' else 'normal' end,
        o.status = 'pending', false,
        case when o.status in ('pending', 'highpriority', 'maybe', 'watching', 'complete') then o.status end)),
    'film_metadata', (select count(*) from public.watchlist_items w where w.is_film and (w.genres <> '{}' or w.forms <> '{}' or w.franchises <> '{}'
      or w.companies <> '{}' or w.genre_candidates <> '{}' or w.metadata_owner_set)),
    'show_metadata', (select count(*) from public.tv_shows s where s.genres <> '{}' or s.forms <> '{}' or s.franchises <> '{}' or s.companies <> '{}'
      or s.genre_candidates <> '{}' or s.network is not null or s.network_candidates <> '{}' or s.metadata_owner_set
      or s.resume_start_season_id is not null),
    'counts', case when (select count(*) from b45_old) <> (select count(*) from public.tv_shows) + (select count(*) from public.watchlist_items where is_film)
      then true end))
  into v_bad;
  v_bad := (select coalesce(jsonb_object_agg(key, value), '{}') from jsonb_each(v_bad) where value not in ('0'::jsonb, 'null'::jsonb));
  if v_bad <> '{}'::jsonb then raise exception 'b45: the mapping didn''t hold: %', v_bad; end if;
  if public.stage5_capabilities() ->> 'phase' <> 'contracted-b45' then raise exception 'b45: capability not updated'; end if;
end $$;

notify pgrst, 'reload schema';
commit;
