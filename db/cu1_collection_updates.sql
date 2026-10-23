-- CU1: collection updates (next-gen item 4). One transaction, run as postgres on a contracted-ep1
-- database with M1 owner-only access (access = members). Design: docs/ITEM4_DESIGN.md.
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.cu1_run', '<a fresh run id, recorded before running>', false);
-- What it adds (no existing table, column, constraint or row changes):
--   * ten owner-only tables: update_setup, collection_definitions, collection_exclusions, update_holds,
--     record_aliases, membership_removals, show_update_settings, update_findings, research_briefs,
--     research_imports. Rows change only inside the library functions below or a restore
--     (private.library_write_guard), with M1's policies and nothing for anon.
--   * the guarded functions (library_cu_*): definitions, exclusions, holds, show settings, the setup
--     import, briefs and findings, and the applying functions (season reconciliation, identity, season
--     mapping, dates, aliases, accepting a new title). Every applying function re-reads the current
--     state under lock and records its finding's outcome in the same transaction.
--   * org_remove_membership / org_add_membership (same signatures) record and clear removals.
--   * library_catalog_apply_b45 becomes a client_outdated refusal (the config-based catalog workflow is
--     retired); governance links, the date guard and the duplicate-name rule stay.
--   * public.restore_backup takes format 7 (format 6's nine tables plus the ten); the format-6 function
--     is kept unchanged as private.restore_backup_v6.
--   * stage5_capabilities(): phase contracted-cu1, backup_format 7.
-- Order: 0. run label, locks; 1. preconditions and the before-state; 2. tables, guards, policies;
-- 3. helpers; 4. functions; 5. grants; 6. capability and run record; 7. verify before commit.
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate
-- execution); never rerun to find out. No rollback (fix-forward); test environments only:
-- db/test/cu1_reverse.sql.
begin;
select set_config('application_name', 'watchlist-cu1-' || coalesce(nullif(current_setting('watchlist.cu1_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';

-- ── 0. Locks before any check ──────────────────────────────────────────────────
lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
  public.watch_with_choices, public.custom_collections, public.catalog_show_links, public.catalog_film_links, public.episode_marks,
  private.stage5_recovery_records, private.stage5_recovery_collections, private.stage5_recovery_othertv,
  private.stage5_recovery_meta, private.library_members, private.migration_runs in access exclusive mode;

-- ── 1. Preconditions and the before-state ──────────────────────────────────────
create temp table cu1_ctx on commit drop as select nullif(current_setting('watchlist.cu1_run', true), '') as run_id;
create temp table cu1_tables (schema_name text, table_name text) on commit drop;
insert into cu1_tables values
  ('public', 'watchlist_items'), ('public', 'tv_shows'), ('public', 'custom_collections'), ('public', 'personal_collections'),
  ('public', 'collection_memberships'), ('public', 'watch_with_choices'), ('public', 'catalog_show_links'), ('public', 'catalog_film_links'),
  ('public', 'episode_marks'), ('private', 'stage5_recovery_records'), ('private', 'stage5_recovery_collections'),
  ('private', 'stage5_recovery_othertv'), ('private', 'stage5_recovery_meta'), ('private', 'library_members');

do $$
declare c record;
begin
  select * into c from cu1_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'cu1: set watchlist.cu1_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if to_regclass('public.update_findings') is not null then raise exception 'cu1: already applied (public.update_findings exists); nothing was changed'; end if;
  if private.tv_stage() <> 'final' then raise exception 'cu1: expected stage final, found %', private.tv_stage(); end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-ep1' then
    raise exception 'cu1: expected phase contracted-ep1, found %', public.stage5_capabilities() ->> 'phase';
  end if;
  if public.stage5_capabilities() ->> 'access' is distinct from 'members' then raise exception 'cu1: expected M1 owner-only access (access = members); nothing was changed'; end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'cu1: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
  if to_regprocedure('public.restore_backup(jsonb, boolean)') is null or to_regprocedure('private.restore_backup_v6(jsonb, boolean)') is not null
     or to_regprocedure('public.org_add_membership(uuid, uuid, uuid)') is null or to_regprocedure('public.org_remove_membership(uuid, uuid, uuid, uuid)') is null
     or to_regprocedure('public.library_catalog_apply_b45(text, jsonb, text)') is null then
    raise exception 'cu1: the functions it replaces are not as expected; nothing was changed';
  end if;
  if (select prosrc from pg_proc where oid = 'public.restore_backup(jsonb, boolean)'::regprocedure) !~ 'v_version is distinct from ''6''' then
    raise exception 'cu1: public.restore_backup is not the format-6 function; nothing was changed';
  end if;
end $$;

create or replace function pg_temp.cu1_fp(p_schema text, p_table text) returns text language plpgsql as $$
declare v text;
begin
  execute format('select md5(coalesce(string_agg(x, ''|'' order by x), '''')) from (select to_jsonb(t)::text x from %I.%I t) s', p_schema, p_table) into v;
  return v;
end $$;
create temp table cu1_before on commit drop as select schema_name, table_name, pg_temp.cu1_fp(schema_name, table_name) fp from cu1_tables;
create temp table cu1_checked (ran boolean) on commit drop;
create temp table cu1_fn_before on commit drop as
select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'private') and has_function_privilege('authenticated', p.oid, 'execute');

-- ── 2. Helpers (pure checks first: the tables' CHECK constraints use them) ──────
-- The text two titles are compared by: lower case, apostrophes dropped, every other run of non-letters
-- and non-digits a single space, trimmed, a leading "the " dropped (collection-updates.js cuNorm is the same).
create function private.cu1_norm(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(btrim(regexp_replace(regexp_replace(lower(coalesce(p, '')), '[''’]', '', 'g'), '[^a-z0-9]+', ' ', 'g')), '^the ', '')
$$;

create function private.cu1_str_ok(v jsonb, p_max int) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(v) = 'string' and btrim(v #>> '{}') <> '' and char_length(v #>> '{}') <= p_max
$$;
create function private.cu1_str_list_ok(v jsonb, p_items int, p_max int, p_allowed text[] default null) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(v) = 'array' and jsonb_array_length(v) <= p_items
    and not exists (select 1 from jsonb_array_elements(v) e
                    where not private.cu1_str_ok(e, p_max) or (p_allowed is not null and not ((e #>> '{}') = any(p_allowed))))
    and (select count(distinct e #>> '{}') from jsonb_array_elements(v) e) = jsonb_array_length(v)
$$;
create function private.cu1_int_ok(v jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select v is null or (jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^[1-9][0-9]{0,8}$')
$$;
create function private.cu1_bool_ok(v jsonb) returns boolean
language sql immutable set search_path = '' as $$ select v is null or jsonb_typeof(v) = 'boolean' $$;

-- A definition's rules: a list of typed rules, each with only its type's fields (docs/ITEM4_DESIGN.md §2).
create function private.cu1_rules_ok(p jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare r jsonb; v_type text; v_keys text[]; v_allowed text[];
begin
  if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p) > 20 then return false; end if;
  if (select count(distinct e ->> 'id') from jsonb_array_elements(p) e) <> jsonb_array_length(p) then return false; end if;
  for r in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(r) is distinct from 'object' or coalesce(r ->> 'id', '') !~ '^[a-z0-9_-]{1,40}$' then return false; end if;
    v_type := r ->> 'type';
    v_allowed := case v_type
      when 'franchise' then array['id', 'type', 'label', 'root_title', 'root_tmdb_id', 'title_roots', 'official_spinoffs', 'relations',
        'search_networks', 'media', 'announced']
      when 'platform_premiere' then array['id', 'type', 'label', 'platform', 'platform_tmdb_network_id', 'region', 'media', 'genres', 'official_domains_hint']
      when 'person_role' then array['id', 'type', 'label', 'person', 'person_tmdb_id', 'series_roles', 'film_roles', 'writer_threshold', 'announced']
      when 'explicit_list' then array['id', 'type', 'label', 'titles']
      when 'written' then array['id', 'type', 'label', 'text']
    end;
    if v_allowed is null then return false; end if;
    select array_agg(k) into v_keys from jsonb_object_keys(r) k;
    if not (v_keys <@ v_allowed) then return false; end if;
    if r ? 'label' and not private.cu1_str_ok(r -> 'label', 200) then return false; end if;
    if v_type = 'franchise' and not (private.cu1_str_ok(r -> 'root_title', 200) and private.cu1_int_ok(r -> 'root_tmdb_id')
        and private.cu1_str_list_ok(coalesce(r -> 'title_roots', '[]'), 20, 100)
        and private.cu1_bool_ok(r -> 'official_spinoffs')
        and private.cu1_str_list_ok(coalesce(r -> 'relations', '[]'), 3, 20, array['spinoff', 'prequel', 'sequel'])
        and private.cu1_str_list_ok(coalesce(r -> 'search_networks', '[]'), 20, 100)
        and coalesce(r ->> 'media', 'series') in ('series', 'films', 'both') and private.cu1_bool_ok(r -> 'announced')) then return false; end if;
    if v_type = 'platform_premiere' and not (private.cu1_str_ok(r -> 'platform', 100) and private.cu1_int_ok(r -> 'platform_tmdb_network_id')
        and coalesce(r ->> 'region', '') ~ '^[A-Z]{2}$' and coalesce(r ->> 'media', 'series') in ('series', 'films', 'both')
        and (coalesce(r -> 'genres', '"all"') = '"all"' or private.cu1_str_list_ok(r -> 'genres', 30, 60))
        and private.cu1_str_list_ok(coalesce(r -> 'official_domains_hint', '[]'), 20, 100)) then return false; end if;
    if v_type = 'person_role' and not (private.cu1_str_ok(r -> 'person', 200) and private.cu1_int_ok(r -> 'person_tmdb_id')
        and private.cu1_str_list_ok(coalesce(r -> 'series_roles', '[]'), 5, 30, array['creator', 'co_creator', 'showrunner', 'writer', 'executive_producer'])
        and private.cu1_str_list_ok(coalesce(r -> 'film_roles', '[]'), 3, 30, array['director', 'writer', 'producer'])
        and jsonb_array_length(coalesce(r -> 'series_roles', '[]')) + jsonb_array_length(coalesce(r -> 'film_roles', '[]')) > 0
        and coalesce(r ->> 'writer_threshold', 'series') in ('series', 'episode') and private.cu1_bool_ok(r -> 'announced')) then return false; end if;
    if v_type = 'explicit_list' and not (jsonb_typeof(r -> 'titles') = 'array' and jsonb_array_length(r -> 'titles') between 1 and 200
        and not exists (select 1 from jsonb_array_elements(r -> 'titles') t
                        where jsonb_typeof(t) is distinct from 'object' or not private.cu1_str_ok(t -> 'title', 200)
                           or not private.cu1_int_ok(t -> 'tmdb_id') or coalesce(t ->> 'media', 'tv') not in ('tv', 'movie')
                           or exists (select 1 from jsonb_object_keys(t) k where k not in ('title', 'tmdb_id', 'media')))) then return false; end if;
    if v_type = 'written' and not private.cu1_str_ok(r -> 'text', 2000) then return false; end if;
  end loop;
  return true;
end $$;

-- Evidence settings: the agreed standard, the collection's official domains and the trade outlets.
create function private.cu1_domain_ok(v jsonb) returns boolean
language sql immutable set search_path = '' as $$ select jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' and char_length(v #>> '{}') <= 100 $$;
create function private.cu1_evidence_settings_ok(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object'
    and (select array_agg(k order by k) from jsonb_object_keys(p) k) = array['official_domains', 'standard', 'trades']
    and p ->> 'standard' = 'official_or_two_trades'
    and jsonb_typeof(p -> 'official_domains') = 'array' and jsonb_array_length(p -> 'official_domains') <= 50
    and not exists (select 1 from jsonb_array_elements(p -> 'official_domains') d where not private.cu1_domain_ok(d))
    and jsonb_typeof(p -> 'trades') = 'array' and jsonb_array_length(p -> 'trades') <= 50
    and not exists (select 1 from jsonb_array_elements(p -> 'trades') t
                    where jsonb_typeof(t) is distinct from 'object' or coalesce(t ->> 'id', '') !~ '^[a-z0-9_-]{1,40}$'
                       or not private.cu1_str_ok(t -> 'name', 100) or jsonb_typeof(t -> 'domains') is distinct from 'array'
                       or jsonb_array_length(t -> 'domains') not between 1 and 10
                       or exists (select 1 from jsonb_array_elements(t -> 'domains') d where not private.cu1_domain_ok(d))
                       or exists (select 1 from jsonb_object_keys(t) k where k not in ('id', 'name', 'domains')))
    and (select count(distinct t ->> 'id') from jsonb_array_elements(p -> 'trades') t) = jsonb_array_length(p -> 'trades')
$$;

-- A standing decision's reopening condition.
create function private.cu1_reopen_ok(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object'
    and p ->> 'on' in ('official_date_or_window', 'official_or_two_trades', 'named_source', 'renewal_cast_date_cancellation', 'owner_only', 'new_evidence')
    and not exists (select 1 from jsonb_object_keys(p) k where k not in ('on', 'source_domains', 'source_name'))
    and (p ->> 'on' <> 'named_source' or (jsonb_typeof(p -> 'source_domains') = 'array' and jsonb_array_length(p -> 'source_domains') between 1 and 10
         and not exists (select 1 from jsonb_array_elements(p -> 'source_domains') d where not private.cu1_domain_ok(d))))
$$;

-- What a definition version's findings are checked against: one hash per rule over its eligibility
-- fields (its label and the networks to search aren't eligibility), and one over the evidence settings.
create function private.cu1_rule_hashes(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(r ->> 'id', md5((r - 'label' - 'search_networks' - 'official_domains_hint')::text)), '{}'::jsonb)
  from jsonb_array_elements(p) r
$$;

create function private.cu1_host(p_url text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(lower(substring(coalesce(p_url, '') from '^https://([^/:?#]+)')), '^www\.', '')
$$;
create function private.cu1_host_in(p_host text, p_domains jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p_host is not null and exists (select 1 from jsonb_array_elements_text(coalesce(p_domains, '[]')) d where p_host = d or p_host like '%.' || d)
$$;
create function private.cu1_date(p text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p::date;
exception when others then return null;
end $$;

-- The structure and policy of a finding's evidence (never its content, which is Claude's assessment):
-- null when it meets the standard, else the reason. p_after: evidence must be published after that day
-- (a reopened decision); p_named: only an official source on these domains counts.
create function private.cu1_evidence_ok(p_evidence jsonb, p_assessment jsonb, p_settings jsonb, p_after date default null, p_named jsonb default null)
returns text
language plpgsql stable set search_path = '' as $$
declare
  v_std text := p_assessment ->> 'standard';
  v_on date := private.cu1_date(p_assessment ->> 'researched_on');
  v_official boolean;
  v_trades int;
begin
  if jsonb_typeof(p_assessment -> 'conflict') = 'boolean' and (p_assessment ->> 'conflict')::boolean then return 'conflict'; end if;
  if v_std is null or v_std not in ('official', 'two_trades') then return 'evidence_insufficient'; end if;
  if v_on is null or jsonb_typeof(p_evidence) is distinct from 'array' then return 'evidence_incomplete'; end if;
  select exists (select 1 from jsonb_array_elements(p_evidence) e
                 where e ->> 'source_type' = 'official' and private.cu1_date(e ->> 'published_on') <= v_on
                   and (p_after is null or private.cu1_date(e ->> 'published_on') > p_after)
                   and private.cu1_host_in(private.cu1_host(e ->> 'url'), coalesce(p_named, p_settings -> 'official_domains')))
    into v_official;
  if p_named is not null then return case when v_official then null else 'evidence_named_source_missing' end; end if;
  select count(distinct t ->> 'id') into v_trades
  from jsonb_array_elements(p_evidence) e join jsonb_array_elements(p_settings -> 'trades') t on t ->> 'id' = e ->> 'outlet'
  where e ->> 'source_type' = 'trade' and coalesce(e ->> 'attribution', 'original') = 'original'
    and private.cu1_date(e ->> 'published_on') <= v_on and (p_after is null or private.cu1_date(e ->> 'published_on') > p_after)
    and private.cu1_host_in(private.cu1_host(e ->> 'url'), t -> 'domains');
  if v_official or v_trades >= 2 then return null; end if;
  return 'evidence_below_standard';
end $$;

-- ── 3. Tables, guards and policies ─────────────────────────────────────────────
-- Composite foreign keys (x_id, user_id) keep every reference inside one owner's library.

create table public.update_setup (
  id uuid not null default gen_random_uuid() constraint update_setup_id_key unique,
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  setup_confirmed_at timestamptz not null default now(),
  source text not null constraint update_setup_source_check check (source = 'setup_file'),
  constraint update_setup_pkey primary key (user_id)
);

create table public.collection_definitions (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  collection_id uuid not null,
  version integer not null constraint collection_definitions_version_check check (version > 0),
  mode text not null constraint collection_definitions_mode_check check (mode in ('manual', 'follow', 'discover')),
  rules jsonb not null default '[]'::jsonb,
  evidence jsonb not null,
  summary text not null default '' constraint collection_definitions_summary_check check (char_length(summary) <= 4000),
  rule_hashes jsonb not null default '{}'::jsonb,
  evidence_hash text not null default '',
  confirmed_at timestamptz not null default now(),
  constraint collection_definitions_pkey primary key (id),
  constraint collection_definitions_version_key unique (user_id, collection_id, version),
  constraint collection_definitions_collection_fkey foreign key (collection_id, user_id)
    references public.personal_collections (id, user_id) on delete cascade,
  constraint collection_definitions_rules_check check (private.cu1_rules_ok(rules)),
  constraint collection_definitions_evidence_check check (private.cu1_evidence_settings_ok(evidence))
);

create table public.collection_exclusions (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  collection_id uuid not null,
  kind text not null constraint collection_exclusions_kind_check check (kind in ('title', 'every_version', 'series_and_spinoffs')),
  title text not null constraint collection_exclusions_title_check check (btrim(title) <> '' and char_length(title) <= 200),
  match_text text not null constraint collection_exclusions_match_check check (match_text <> '' and match_text = private.cu1_norm(title)),
  tmdb_id integer constraint collection_exclusions_tmdb_check check (tmdb_id > 0),
  media text not null default 'any' constraint collection_exclusions_media_check check (media in ('tv', 'movie', 'any')),
  note text not null default '' constraint collection_exclusions_note_check check (char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  constraint collection_exclusions_pkey primary key (id),
  constraint collection_exclusions_key unique (user_id, collection_id, kind, match_text),
  constraint collection_exclusions_collection_fkey foreign key (collection_id, user_id)
    references public.personal_collections (id, user_id) on delete cascade
);

create table public.update_holds (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  kind text not null constraint update_holds_kind_check check (kind in ('standing_decision', 'protected_value', 'identity_hold')),
  collection_id uuid,
  show_id uuid,
  item_id uuid,
  subject_label text constraint update_holds_label_check check (subject_label is null or (btrim(subject_label) <> '' and char_length(subject_label) <= 200)),
  field text constraint update_holds_field_check check (field in ('display_date', 'title', 'season_label')),
  protected_value text constraint update_holds_value_check check (char_length(protected_value) <= 200),
  decision text not null constraint update_holds_decision_check check (btrim(decision) <> '' and char_length(decision) <= 2000),
  effect text not null constraint update_holds_effect_check check (effect in ('keep_value', 'do_not_add', 'require_qualifying_evidence',
    'stay_skipped_unmatched', 'block_matching', 'block_season_mapping')),
  reopen jsonb not null constraint update_holds_reopen_check check (private.cu1_reopen_ok(reopen)),
  decided_on date,
  created_at timestamptz not null default now(),
  constraint update_holds_pkey primary key (id),
  constraint update_holds_collection_fkey foreign key (collection_id, user_id) references public.personal_collections (id, user_id) on delete cascade,
  constraint update_holds_show_fkey foreign key (show_id, user_id) references public.tv_shows (id, user_id) on delete cascade,
  constraint update_holds_item_fkey foreign key (item_id, user_id) references public.watchlist_items (id, user_id) on delete cascade,
  constraint update_holds_subject_check check (show_id is not null or item_id is not null or subject_label is not null),
  constraint update_holds_shape_check check (case kind
    when 'protected_value' then field is not null and (show_id is not null or item_id is not null) and effect = 'keep_value'
    when 'identity_hold' then field is null and (show_id is not null or item_id is not null) and effect in ('block_matching', 'block_season_mapping')
    else field is null and effect in ('keep_value', 'do_not_add', 'require_qualifying_evidence', 'stay_skipped_unmatched') end)
);

create table public.record_aliases (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  show_id uuid,
  item_id uuid,
  alias text not null constraint record_aliases_alias_check check (btrim(alias) <> '' and char_length(alias) <= 200),
  match_text text not null constraint record_aliases_match_check check (match_text <> '' and match_text = private.cu1_norm(alias)),
  evidence jsonb not null default '[]'::jsonb constraint record_aliases_evidence_check check (jsonb_typeof(evidence) = 'array'),
  created_at timestamptz not null default now(),
  constraint record_aliases_pkey primary key (id),
  constraint record_aliases_target_check check ((show_id is null) <> (item_id is null)),
  constraint record_aliases_show_fkey foreign key (show_id, user_id) references public.tv_shows (id, user_id) on delete cascade,
  constraint record_aliases_item_fkey foreign key (item_id, user_id) references public.watchlist_items (id, user_id) on delete cascade
);
create unique index record_aliases_show_key on public.record_aliases (show_id, match_text) where show_id is not null;
create unique index record_aliases_item_key on public.record_aliases (item_id, match_text) where item_id is not null;

create table public.membership_removals (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  collection_id uuid not null,
  show_id uuid,
  item_id uuid,
  removed_at timestamptz not null default now(),
  constraint membership_removals_pkey primary key (id),
  constraint membership_removals_target_check check ((show_id is null) <> (item_id is null)),
  constraint membership_removals_collection_fkey foreign key (collection_id, user_id) references public.personal_collections (id, user_id) on delete cascade,
  constraint membership_removals_show_fkey foreign key (show_id, user_id) references public.tv_shows (id, user_id) on delete cascade,
  constraint membership_removals_item_fkey foreign key (item_id, user_id) references public.watchlist_items (id, user_id) on delete cascade
);
create unique index membership_removals_show_key on public.membership_removals (collection_id, show_id) where show_id is not null;
create unique index membership_removals_item_key on public.membership_removals (collection_id, item_id) where item_id is not null;

create table public.show_update_settings (
  id uuid not null default gen_random_uuid() constraint show_update_settings_id_key unique,
  show_id uuid not null,
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  follow_when_skipped boolean not null default false,
  new_season_after_ended_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint show_update_settings_pkey primary key (show_id),
  constraint show_update_settings_show_fkey foreign key (show_id, user_id) references public.tv_shows (id, user_id) on delete cascade
);

create table public.research_briefs (
  id uuid not null,
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  exported_at timestamptz not null default now(),
  collections jsonb not null constraint research_briefs_collections_check check (jsonb_typeof(collections) = 'array'),
  constraint research_briefs_pkey primary key (id),
  constraint research_briefs_id_owner_key unique (id, user_id)
);

create table public.research_imports (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  brief_id uuid not null,
  file_sha256 text not null constraint research_imports_sha_check check (file_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz not null default now(),
  counts jsonb not null default '{}'::jsonb,
  constraint research_imports_pkey primary key (id),
  constraint research_imports_file_key unique (user_id, file_sha256),
  constraint research_imports_brief_fkey foreign key (brief_id, user_id) references public.research_briefs (id, user_id) on delete cascade
);

-- Findings keep plain ids of the records they name (no foreign key: a finding outlives a deleted record
-- and is then set aside); every function looks records up with the owner's id.
create table public.update_findings (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id() references auth.users (id) on delete restrict,
  fingerprint text not null constraint update_findings_fingerprint_check check (fingerprint ~ '^[a-z_]+:[0-9a-f]{64}$'),
  source text not null constraint update_findings_source_check check (source in ('tmdb', 'research')),
  kind text not null constraint update_findings_kind_check check (kind in ('new_season', 'date', 'alias', 'new_show', 'new_film',
    'cancellation', 'identity', 'season_mapping', 'renewal_none')),
  status text not null constraint update_findings_status_check check (status in ('pending', 'needs_evidence', 'conflict', 'needs_research',
    'set_aside', 'not_now', 'excluded', 'accepted', 'applied', 'dismissed')),
  reason text not null default '' constraint update_findings_reason_check check (char_length(reason) <= 200),
  collection_id uuid,
  show_id uuid,
  item_id uuid,
  season_id uuid,
  subject jsonb not null default '{}'::jsonb constraint update_findings_subject_check check (jsonb_typeof(subject) = 'object'),
  proposed jsonb not null default '{}'::jsonb constraint update_findings_proposed_check check (jsonb_typeof(proposed) = 'object'),
  expected jsonb not null default '{}'::jsonb constraint update_findings_expected_check check (jsonb_typeof(expected) = 'object'),
  evidence jsonb not null default '[]'::jsonb constraint update_findings_evidence_check check (jsonb_typeof(evidence) = 'array'),
  assessment jsonb not null default '{}'::jsonb constraint update_findings_assessment_check check (jsonb_typeof(assessment) = 'object'),
  rule_id text constraint update_findings_rule_check check (rule_id ~ '^[a-z0-9_-]{1,40}$'),
  definition_version integer,
  rule_hash text,
  evidence_hash text,
  brief_id uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  decided_at timestamptz,
  applied_at timestamptz,
  result jsonb,
  constraint update_findings_pkey primary key (id),
  constraint update_findings_fingerprint_key unique (user_id, fingerprint),
  constraint update_findings_research_check check (source = 'tmdb' or (collection_id is not null and brief_id is not null))
);

do $$
declare t text;
begin
  foreach t in array array['update_setup', 'collection_definitions', 'collection_exclusions', 'update_holds', 'record_aliases',
    'membership_removals', 'show_update_settings', 'research_briefs', 'research_imports', 'update_findings'] loop
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function private.library_write_guard()', t || '_write_guard', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t);
    execute format('create policy owner_update on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t);
    execute format('create policy members_only on public.%I as restrictive for all to authenticated using ((select private.is_member())) with check ((select private.is_member()))', t);
  end loop;
end $$;

-- ── 4. Functions ───────────────────────────────────────────────────────────────
-- Lookups over the new tables.
-- A record a built-in catalog governs (the records the setup file's holds describe).
create function private.cu1_governed(p_show uuid, p_item uuid) returns boolean
language sql stable set search_path = '' as $$
  select (p_show is not null and exists (select 1 from public.catalog_show_links l where l.show_id = p_show))
      or (p_item is not null and exists (select 1 from public.catalog_film_links l where l.item_id = p_item))
      or (p_item is not null and exists (select 1 from public.watchlist_items w join public.catalog_show_links l on l.show_id = w.show_id where w.id = p_item))
$$;
create function private.cu1_setup_ok(p_owner uuid, p_show uuid, p_item uuid) returns boolean
language sql stable set search_path = '' as $$
  select not private.cu1_governed(p_show, p_item) or exists (select 1 from public.update_setup s where s.user_id = p_owner)
$$;

-- A collection's current definition (its highest version), or null.
create function private.cu1_current_definition(p_owner uuid, p_collection uuid) returns public.collection_definitions
language sql stable set search_path = '' as $$
  select * from public.collection_definitions d where d.user_id = p_owner and d.collection_id = p_collection order by d.version desc limit 1
$$;

-- Whether a subject is excluded from a collection: by TMDB id, or its title, aliases or working titles
-- (single title: equal; every version: contains the phrase; series and spin-offs: the series itself or
-- a subject that names it as its root).
create function private.cu1_excluded(p_owner uuid, p_collection uuid, p_subject jsonb) returns boolean
language sql stable set search_path = '' as $$
  with t as (
    select private.cu1_norm(x) n from (
      select p_subject ->> 'title' x
      union all select jsonb_array_elements_text(case when jsonb_typeof(p_subject -> 'aliases') = 'array' then p_subject -> 'aliases' else '[]' end)
      union all select jsonb_array_elements_text(case when jsonb_typeof(p_subject -> 'working_titles') = 'array' then p_subject -> 'working_titles' else '[]' end)) q
    where coalesce(x, '') <> '')
  select exists (
    select 1 from public.collection_exclusions e
    where e.user_id = p_owner and e.collection_id = p_collection and (
      (e.tmdb_id is not null and jsonb_typeof(p_subject -> 'tmdb_id') = 'number' and (p_subject ->> 'tmdb_id') ~ '^[1-9][0-9]{0,8}$'
       and e.tmdb_id = (p_subject ->> 'tmdb_id')::integer)
      or (e.kind = 'title' and e.match_text in (select n from t))
      or (e.kind = 'every_version' and exists (select 1 from t where (' ' || t.n || ' ') like ('% ' || e.match_text || ' %')))
      or (e.kind = 'series_and_spinoffs' and (e.match_text in (select n from t)
          or e.match_text = private.cu1_norm(p_subject ->> 'spinoff_of')))))
$$;

-- The hold that applies to a record (and, for a season, its label), if any; identity holds first.
create function private.cu1_hold_for(p_owner uuid, p_kinds text[], p_show uuid, p_item uuid, p_label text) returns public.update_holds
language sql stable set search_path = '' as $$
  select h.* from public.update_holds h
  where h.user_id = p_owner and h.kind = any(p_kinds)
    and ((p_item is not null and h.item_id = p_item)
      or (p_show is not null and h.show_id = p_show and h.item_id is null
          and (h.subject_label is null or (p_label is not null and private.cu1_norm(h.subject_label) = private.cu1_norm(p_label)))))
  order by case h.kind when 'identity_hold' then 0 when 'standing_decision' then 1 else 2 end, h.created_at, h.id
  limit 1
$$;

-- Whether a reopened standing decision's condition is met by this finding (owner_only: only an owner's
-- review decision reopens it, with no evidence condition).
create function private.cu1_reopen_met(h public.update_holds, f public.update_findings, p_settings jsonb, p_review boolean) returns boolean
language plpgsql stable set search_path = '' as $$
begin
  if h.reopen ->> 'on' = 'owner_only' then return p_review; end if;
  if f.source <> 'research' or p_settings is null then return false; end if;
  return private.cu1_evidence_ok(f.evidence, f.assessment, p_settings, h.decided_on,
    case when h.reopen ->> 'on' = 'named_source' then h.reopen -> 'source_domains' end) is null;
end $$;

-- Findings: an applying function takes either a research finding by id ({"id": …}; its stored content is
-- what counts) or a TMDB finding's content (source tmdb; inserted, or found again by its fingerprint).
-- Locked for the rest of the transaction.
create function private.cu1_finding_take(p_owner uuid, p_finding jsonb, p_kinds text[]) returns public.update_findings
language plpgsql set search_path = '' as $$
declare f public.update_findings; v_id uuid;
begin
  if jsonb_typeof(p_finding) is distinct from 'object' then raise exception 'invalid_input: finding' using errcode = '22023'; end if;
  if p_finding ? 'id' then
    begin v_id := (p_finding ->> 'id')::uuid; exception when others then raise exception 'invalid_input: finding id' using errcode = '22023'; end;
    select * into f from public.update_findings where id = v_id and user_id = p_owner for update;
    if f.id is null then perform private.lib_refuse('target_missing', 'This finding is no longer saved, so nothing was changed. Check again.'); end if;
  else
    if p_finding ->> 'source' is distinct from 'tmdb' or coalesce(p_finding ->> 'fingerprint', '') !~ '^[a-z_]+:[0-9a-f]{64}$'
       or not ((p_finding ->> 'kind') = any(p_kinds))
       or jsonb_typeof(coalesce(p_finding -> 'subject', '{}')) <> 'object' or jsonb_typeof(coalesce(p_finding -> 'proposed', '{}')) <> 'object'
       or jsonb_typeof(coalesce(p_finding -> 'expected', '{}')) <> 'object' then
      raise exception 'invalid_input: TMDB finding' using errcode = '22023';
    end if;
    begin
      insert into public.update_findings (fingerprint, source, kind, status, show_id, item_id, season_id, subject, proposed, expected)
      values (p_finding ->> 'fingerprint', 'tmdb', p_finding ->> 'kind', 'pending', (p_finding ->> 'show_id')::uuid, (p_finding ->> 'item_id')::uuid,
        (p_finding ->> 'season_id')::uuid, coalesce(p_finding -> 'subject', '{}'), coalesce(p_finding -> 'proposed', '{}'), coalesce(p_finding -> 'expected', '{}'))
      on conflict (user_id, fingerprint) do nothing;
    exception when invalid_text_representation then raise exception 'invalid_input: TMDB finding ids' using errcode = '22023';
    end;
    select * into f from public.update_findings where user_id = p_owner and fingerprint = p_finding ->> 'fingerprint' for update;
    -- A TMDB finding a policy outcome parked (needs_evidence, set_aside) and the owner hasn't decided is
    -- checked again with what TMDB says now (a later date and episodes, a show no longer Skipped);
    -- owner decisions (Not now, Dismiss) and final outcomes stand.
    if f.source = 'tmdb' and f.status in ('needs_evidence', 'set_aside') and f.decided_at is null then
      update public.update_findings set status = 'pending', reason = '', subject = coalesce(p_finding -> 'subject', subject),
        proposed = coalesce(p_finding -> 'proposed', proposed), expected = coalesce(p_finding -> 'expected', expected), last_seen_at = now()
      where id = f.id returning * into f;
    end if;
  end if;
  if not (f.kind = any(p_kinds)) then raise exception 'invalid_input: a % finding can''t be applied here', f.kind using errcode = '22023'; end if;
  return f;
end $$;

-- Records a finding's outcome (in the caller's transaction, with the library change if there is one).
create function private.cu1_finish(p_id uuid, p_outcome text, p_status text, p_reason text, p_result jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare f public.update_findings;
begin
  update public.update_findings set status = p_status, reason = coalesce(p_reason, ''), result = coalesce(p_result, result),
    last_seen_at = now(), applied_at = case when p_status in ('applied', 'accepted') then now() else applied_at end,
    decided_at = case when p_status in ('applied', 'accepted') then now() else decided_at end
  where id = p_id returning * into f;
  return jsonb_build_object('outcome', p_outcome, 'finding_id', f.id, 'status', f.status, 'reason', f.reason, 'result', f.result);
end $$;

-- A finding an applying function may still act on: pending (an owner review decision also needs pending).
create function private.cu1_not_actionable(f public.update_findings) returns jsonb
language sql stable set search_path = '' as $$
  select case when f.status <> 'pending' then jsonb_build_object('outcome', 'not_pending', 'finding_id', f.id, 'status', f.status, 'reason', f.reason, 'result', f.result) end
$$;

-- Collection research findings only: the current collection mode, definition hashes, membership,
-- exclusions and evidence structure, re-read now. Null when it may proceed, else 'status:reason'.
-- (TMDB findings come from library-wide Refresh shows: no collection mode or definition applies.)
create function private.cu1_research_gate(f public.update_findings, p_owner uuid, p_new_title boolean) returns text
language plpgsql stable set search_path = '' as $$
declare d public.collection_definitions; v_ev text;
begin
  if f.source <> 'research' then return null; end if;
  d := private.cu1_current_definition(p_owner, f.collection_id);
  if d.id is null then return 'set_aside:no_definition'; end if;
  if d.mode = 'manual' then return 'set_aside:collection_manual'; end if;
  if p_new_title and d.mode <> 'discover' then return 'set_aside:collection_not_discovering'; end if;
  if not p_new_title and (f.show_id is not null or f.item_id is not null) then
    if exists (select 1 from public.membership_removals r where r.user_id = p_owner and r.collection_id = f.collection_id
               and (r.show_id = f.show_id or r.item_id = f.item_id)) then return 'set_aside:removed_from_collection'; end if;
    if not exists (select 1 from public.collection_memberships m where m.user_id = p_owner and m.collection_id = f.collection_id
                   and (m.show_id = f.show_id or m.item_id = f.item_id)) then return 'set_aside:not_in_collection'; end if;
  end if;
  if f.evidence_hash is distinct from d.evidence_hash then return 'needs_research:evidence_rules_changed'; end if;
  if f.rule_id is not null then
    if not (d.rule_hashes ? f.rule_id) then return 'set_aside:rule_removed'; end if;
    if f.rule_hash is distinct from d.rule_hashes ->> f.rule_id then return 'needs_research:rule_changed'; end if;
  end if;
  if private.cu1_excluded(p_owner, f.collection_id, f.subject) then return 'excluded:excluded'; end if;
  v_ev := private.cu1_evidence_ok(f.evidence, f.assessment, d.evidence);
  if v_ev = 'conflict' then return 'conflict:conflict'; end if;
  if v_ev is not null then return 'needs_evidence:' || v_ev; end if;
  return null;
end $$;
create function private.cu1_gate_finish(f public.update_findings, p_gate text) returns jsonb
language sql set search_path = '' as $$
  select private.cu1_finish(f.id, 'policy', split_part(p_gate, ':', 1), split_part(p_gate, ':', 2), null)
$$;
-- The evidence settings a research finding is checked against (its collection's current definition).
create function private.cu1_settings_of(f public.update_findings, p_owner uuid) returns jsonb
language sql stable set search_path = '' as $$
  select case when f.source = 'research' then (private.cu1_current_definition(p_owner, f.collection_id)).evidence end
$$;

-- Standing decisions and identity holds for an applying function: null to proceed, else 'status:reason'
-- (or 'refuse:…' when an owner review decision can't meet the hold's reopening condition).
-- require_qualifying_evidence proceeds automatically on research evidence meeting its condition;
-- every other standing decision needs an owner review decision meeting the condition. Identity holds
-- are never overridden here (the owner removes the hold first).
create function private.cu1_hold_gate(p_owner uuid, f public.update_findings, p_show uuid, p_item uuid, p_label text, p_review boolean, p_identity boolean)
returns text
language plpgsql stable set search_path = '' as $$
declare h public.update_holds; v_settings jsonb := private.cu1_settings_of(f, p_owner);
begin
  if p_identity then
    h := private.cu1_hold_for(p_owner, array['identity_hold'], p_show, p_item, p_label);
    if h.id is not null then return 'pending:identity_hold'; end if;
  end if;
  -- Every standing decision that applies is consulted; the most restrictive outcome wins.
  for h in select x.* from public.update_holds x
           where x.user_id = p_owner and x.kind = 'standing_decision'
             and ((p_item is not null and x.item_id = p_item)
               or (p_show is not null and x.show_id = p_show and x.item_id is null
                   and (x.subject_label is null or (p_label is not null and private.cu1_norm(x.subject_label) = private.cu1_norm(p_label)))))
           order by x.created_at, x.id loop
    continue when h.effect = 'stay_skipped_unmatched' and not p_identity;
    continue when h.effect = 'require_qualifying_evidence' and f.source = 'research' and private.cu1_reopen_met(h, f, v_settings, false);
    if p_review then
      continue when private.cu1_reopen_met(h, f, v_settings, true);
      return 'refuse:reopen_condition_not_met';
    end if;
    return 'pending:standing_decision';
  end loop;
  return null;
end $$;

create function private.cu1_label(n integer) returns text
language sql immutable set search_path = '' as $$ select case when n = 0 then 'Specials' else 'Season ' || n end $$;

-- ── Seasons: reconcile one discovered season with the stored rows (docs/ITEM4_DESIGN.md §3) ──
-- p_season: { season_number, display_date, date_sort, episode_count }. p_row_id: with an owner review
-- decision, the unidentified row the owner chose for an ambiguous correspondence.
create function public.library_cu_reconcile_season(p_show_id uuid, p_expected jsonb, p_season jsonb, p_finding jsonb,
  p_review boolean default false, p_row_id uuid default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_cu_reconcile_season', 'final');
  f public.update_findings;
  s public.tv_shows;
  v_n integer;
  v_label text;
  v_gate text;
  v_row uuid;
  v_plain uuid[];
  v_named uuid[];
  v_key text;
  v_theme text;
  v_display text;
  v_sort text;
  v_identified boolean;
  v_flagged boolean := false;
  v_before jsonb;
  r jsonb;
begin
  if p_show_id is null or jsonb_typeof(p_expected) is distinct from 'object' or jsonb_typeof(p_season) is distinct from 'object'
     or coalesce(p_season ->> 'season_number', '') !~ '^[0-9]{1,4}$' then
    raise exception 'invalid_input: show, expected values and season number are required' using errcode = '22023';
  end if;
  v_n := (p_season ->> 'season_number')::integer;
  v_label := private.cu1_label(v_n);
  perform private.lib_write_on();
  f := private.cu1_finding_take(v_owner, p_finding, array['new_season']);
  r := private.cu1_not_actionable(f);
  if r is not null then if p_review then perform private.lib_refuse('finding_not_pending', 'This finding was already decided, so nothing was changed.'); end if; return r; end if;

  select * into s from public.tv_shows where id = p_show_id and user_id = v_owner for update;
  if s.id is null then perform private.lib_refuse('target_missing', 'This show is no longer on your list, so nothing was changed.'); end if;
  if s.tmdb_id is distinct from (p_expected ->> 'tmdb_id')::integer or s.show_key is distinct from p_expected ->> 'show_key' then perform private.b45_changed(); end if;
  perform 1 from public.watchlist_items where show_id = s.id and user_id = v_owner for update;
  v_before := jsonb_build_object('status', s.status, 'priority', s.priority, 'ended', s.ended);

  -- Basis
  if f.source = 'tmdb' then
    if s.tmdb_id is null then raise exception 'invalid_input: a TMDB season needs a TMDB-matched show' using errcode = '22023'; end if;
    if not private.tv_valid_date(p_season ->> 'date_sort') or coalesce(p_season ->> 'display_date', '') = '' then
      raise exception 'invalid_input: a TMDB season needs its date fields' using errcode = '22023';
    end if;
    if (p_season ->> 'display_date') ~* 'tba' and coalesce((p_season ->> 'episode_count')::integer, 0) = 0 then
      return private.cu1_finish(f.id, 'policy', 'needs_evidence', 'tmdb_undated_empty', null);
    end if;
  else
    v_gate := private.cu1_research_gate(f, v_owner, false);
    if v_gate is not null then return private.cu1_gate_finish(f, v_gate); end if;
    if (f.subject ->> 'season_number') is distinct from v_n::text then raise exception 'invalid_input: the season isn''t the finding''s' using errcode = '22023'; end if;
  end if;
  if f.show_id is not null and f.show_id <> s.id then raise exception 'invalid_input: the show isn''t the finding''s' using errcode = '22023'; end if;
  if not p_review and not private.cu1_setup_ok(v_owner, s.id, null) then
    return private.cu1_finish(f.id, 'policy', 'pending', 'setup_required', null);
  end if;
  if s.status = 'skipped' and not coalesce((select follow_when_skipped from public.show_update_settings where show_id = s.id), false) then
    return private.cu1_finish(f.id, 'policy', 'set_aside', 'skipped', null);
  end if;

  -- The stored rows decide (identified first, then unidentified; never the page's view).
  if s.tmdb_id is not null then
    select id into v_row from public.watchlist_items where user_id = v_owner and media_type = 'tv' and tmdb_id = s.tmdb_id and season_number = v_n;
    if v_row is not null then
      if (select show_id from public.watchlist_items where id = v_row) is distinct from s.id then
        return private.cu1_finish(f.id, 'policy', 'pending', 'tmdb_season_elsewhere', jsonb_build_object('row_id', v_row));
      end if;
      return private.cu1_finish(f.id, 'already', 'applied', 'existing', jsonb_build_object('outcome', 'existing', 'row_id', v_row));
    end if;
  end if;
  v_gate := private.cu1_hold_gate(v_owner, f, s.id, null, v_label, p_review, f.source = 'tmdb');
  if v_gate like 'refuse:%' then perform private.lib_refuse('reopen_condition_not_met', 'The decision held for this season isn''t reopened by this evidence, so nothing was changed.'); end if;
  if v_gate is not null then return private.cu1_gate_finish(f, v_gate); end if;

  select coalesce(array_agg(id order by id) filter (where season = v_label and v_n > 0), '{}'),
         coalesce(array_agg(id order by id) filter (where not (season = v_label and v_n > 0)
           and ((v_n > 0 and season ~* ('(^|[^0-9])' || v_n || '([^0-9]|$)')) or (v_n = 0 and btrim(season) ~* '^specials?'))), '{}')
    into v_plain, v_named
  from public.watchlist_items where show_id = s.id and user_id = v_owner and tmdb_id is null;

  if p_review and p_row_id is not null then
    if not (p_row_id = any(v_plain || v_named)) then raise exception 'invalid_input: the chosen row isn''t an unidentified season of this show matching this number' using errcode = '22023'; end if;
    v_row := p_row_id;
  elsif cardinality(v_plain) = 1 and cardinality(v_named) = 0 then
    v_row := v_plain[1];
  elsif cardinality(v_plain) + cardinality(v_named) > 0 then
    return private.cu1_finish(f.id, 'policy', 'pending', 'ambiguous_correspondence', jsonb_build_object('candidates', to_jsonb(v_plain || v_named)));
  end if;

  if v_row is not null then
    if f.source = 'tmdb' then
      -- An identity hold on the chosen row's own label (a review may pick a "Part" or "Final" row) is never overridden.
      if (private.cu1_hold_for(v_owner, array['identity_hold'], s.id, v_row, (select season from public.watchlist_items where id = v_row))).id is not null then
        return private.cu1_finish(f.id, 'policy', 'pending', 'identity_hold', jsonb_build_object('row_id', v_row));
      end if;
      update public.watchlist_items set media_type = 'tv', tmdb_id = s.tmdb_id, season_number = v_n where id = v_row and user_id = v_owner and tmdb_id is null;
      return private.cu1_finish(f.id, 'applied', 'applied', '', jsonb_build_object('outcome', 'mapped', 'row_id', v_row));
    end if;
    return private.cu1_finish(f.id, 'already', 'applied', 'existing', jsonb_build_object('outcome', 'existing', 'row_id', v_row));
  end if;

  -- Genuinely absent: created.
  v_key := s.show_key || '|' || lower(v_label);
  if exists (select 1 from public.watchlist_items where show_id = s.id and item_key = v_key) then
    return private.cu1_finish(f.id, 'policy', 'pending', 'key_conflict', null);
  end if;
  v_identified := f.source = 'tmdb';
  v_display := case when v_identified then p_season ->> 'display_date' else coalesce(nullif(f.proposed ->> 'display_date', ''), 'TBA') end;
  v_sort := case when v_identified then p_season ->> 'date_sort' else coalesce(nullif(f.proposed ->> 'date_sort', ''), '2099-01-01') end;
  if not private.tv_valid_date(v_sort) or char_length(v_display) > 40 then raise exception 'invalid_input: season date' using errcode = '22023'; end if;
  select theme into v_theme from public.watchlist_items where show_id = s.id order by season_number desc nulls last, date_sort desc, id limit 1;
  insert into public.watchlist_items (item_key, title, season, theme, display_date, date_sort, watched, status, media_type, tmdb_id, season_number, show_id, skipped)
  values (v_key, s.title, v_label, coalesce(v_theme, ''), v_display, v_sort, false, 'confirmed',
    case when v_identified then 'tv' end, case when v_identified then s.tmdb_id end, case when v_identified then v_n end, s.id, false)
  returning id into v_row;
  if s.ended then
    insert into public.show_update_settings (show_id, new_season_after_ended_at) values (s.id, now())
    on conflict (show_id) do update set new_season_after_ended_at = now(), updated_at = now();
    v_flagged := true;
  end if;
  if (select jsonb_build_object('status', status, 'priority', priority, 'ended', ended) from public.tv_shows where id = s.id) is distinct from v_before then
    raise exception 'integrity_fault: an addition changed the show''s status' using errcode = '23000';
  end if;
  return private.cu1_finish(f.id, 'applied', 'applied', '', jsonb_build_object('outcome', 'created', 'row_id', v_row, 'identified', v_identified,
    'ended_flagged', v_flagged));
end $$;

-- ── Dates (the only new path that sets watchlist.catalog_date_write) ──
-- Automatic: a stored TBA → an exact date; a future exact date → another future exact date. Anything else,
-- a protected date or a standing decision, only by an owner review decision (and its reopening condition).
create function public.library_cu_set_season_date(p_row_id uuid, p_expected jsonb, p_new jsonb, p_finding jsonb, p_review boolean default false)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_cu_set_season_date', 'final');
  f public.update_findings;
  w public.watchlist_items;
  v_gate text;
  v_today date := current_date;
  v_auto boolean;
  r jsonb;
begin
  if p_row_id is null or jsonb_typeof(p_expected) is distinct from 'object' or jsonb_typeof(p_new) is distinct from 'object'
     or not private.tv_valid_date(p_new ->> 'date_sort') or coalesce(btrim(p_new ->> 'display_date'), '') = '' or char_length(p_new ->> 'display_date') > 40 then
    raise exception 'invalid_input: row, expected and new date' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  f := private.cu1_finding_take(v_owner, p_finding, array['date']);
  r := private.cu1_not_actionable(f);
  if r is not null then if p_review then perform private.lib_refuse('finding_not_pending', 'This finding was already decided, so nothing was changed.'); end if; return r; end if;
  select * into w from public.watchlist_items where id = p_row_id and user_id = v_owner;
  if w.id is null then perform private.lib_refuse('target_missing', 'This row is no longer on your list, so nothing was changed.'); end if;
  if w.show_id is not null then perform 1 from public.tv_shows where id = w.show_id and user_id = v_owner for update; end if;
  select * into w from public.watchlist_items where id = p_row_id and user_id = v_owner for update;
  if w.display_date is distinct from p_expected ->> 'display_date' or w.date_sort is distinct from p_expected ->> 'date_sort' then perform private.b45_changed(); end if;
  if coalesce(f.season_id, f.item_id) is distinct from w.id then
    raise exception 'invalid_input: the row isn''t the finding''s' using errcode = '22023';
  end if;
  if w.display_date = p_new ->> 'display_date' and w.date_sort = p_new ->> 'date_sort' then
    return private.cu1_finish(f.id, 'already', 'applied', 'existing', jsonb_build_object('outcome', 'existing', 'row_id', w.id));
  end if;
  if f.source = 'tmdb' then
    if w.media_type is distinct from 'tv' or w.tmdb_id is null then raise exception 'invalid_input: a TMDB date needs an identified season' using errcode = '22023'; end if;
  else
    v_gate := private.cu1_research_gate(f, v_owner, false);
    if v_gate is not null then return private.cu1_gate_finish(f, v_gate); end if;
  end if;
  if not p_review and not private.cu1_setup_ok(v_owner, w.show_id, w.id) then
    return private.cu1_finish(f.id, 'policy', 'pending', 'setup_required', null);
  end if;
  v_gate := private.cu1_hold_gate(v_owner, f, w.show_id, w.id, w.season, p_review, false);
  if v_gate like 'refuse:%' then perform private.lib_refuse('reopen_condition_not_met', 'The decision held for this date isn''t reopened by this evidence, so nothing was changed.'); end if;
  if v_gate is not null then return private.cu1_gate_finish(f, v_gate); end if;
  if not p_review and exists (select 1 from public.update_holds h where h.user_id = v_owner and h.kind = 'protected_value' and h.field = 'display_date'
                              and (h.item_id = w.id or (h.show_id = w.show_id and h.item_id is null))) then
    return private.cu1_finish(f.id, 'policy', 'pending', 'protected_value', null);
  end if;
  v_auto := (p_new ->> 'display_date') !~* 'tba' and (w.display_date ~* 'tba'
    or (private.cu1_date(w.date_sort) > v_today and private.cu1_date(p_new ->> 'date_sort') > v_today));
  if not v_auto and not p_review then return private.cu1_finish(f.id, 'policy', 'pending', 'date_needs_review', null); end if;
  perform set_config('watchlist.catalog_date_write', 'on', true);
  update public.watchlist_items set display_date = p_new ->> 'display_date', date_sort = p_new ->> 'date_sort' where id = w.id and user_id = v_owner;
  perform set_config('watchlist.catalog_date_write', '', true);
  return private.cu1_finish(f.id, 'applied', 'applied', '', jsonb_build_object('outcome', 'updated', 'row_id', w.id,
    'from', jsonb_build_object('display_date', w.display_date, 'date_sort', w.date_sort),
    'to', jsonb_build_object('display_date', p_new ->> 'display_date', 'date_sort', p_new ->> 'date_sort')));
end $$;

-- ── Identity: attach a TMDB show identity to an unmatched show ──
-- Requires the TMDB title to equal the show's title or an evidenced alias (otherwise an owner review
-- decision); refuses identity holds, a TMDB id another show has and, without review, any season label
-- that isn't a plain "Season N". Title and key unchanged; plain seasons TMDB lists are mapped, the rest stay
-- unidentified (awaiting TMDB).
create function public.library_cu_attach_identity(p_show_id uuid, p_expected jsonb, p_tmdb_id integer, p_listed jsonb, p_finding jsonb,
  p_review boolean default false) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_cu_attach_identity', 'final');
  f public.update_findings;
  s public.tv_shows;
  v_gate text;
  v_mapped uuid[] := '{}';
  v_left uuid[] := '{}';
  w record;
  v_n integer;
  r jsonb;
begin
  if p_show_id is null or p_tmdb_id is null or p_tmdb_id <= 0 or jsonb_typeof(p_expected) is distinct from 'object' or jsonb_typeof(p_listed) is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(p_listed) x where jsonb_typeof(x) <> 'number' or (x #>> '{}') !~ '^[0-9]{1,4}$') then
    raise exception 'invalid_input: show, TMDB id and listed seasons' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  f := private.cu1_finding_take(v_owner, p_finding, array['identity']);
  if f.source <> 'tmdb' then raise exception 'invalid_input: an identity comes from TMDB' using errcode = '22023'; end if;
  r := private.cu1_not_actionable(f);
  if r is not null then if p_review then perform private.lib_refuse('finding_not_pending', 'This finding was already decided, so nothing was changed.'); end if; return r; end if;
  select * into s from public.tv_shows where id = p_show_id and user_id = v_owner for update;
  if s.id is null then perform private.lib_refuse('target_missing', 'This show is no longer on your list, so nothing was changed.'); end if;
  if s.tmdb_id = p_tmdb_id then return private.cu1_finish(f.id, 'already', 'applied', 'existing', jsonb_build_object('outcome', 'existing')); end if;
  if s.tmdb_id is not null or s.title is distinct from p_expected ->> 'title' or s.show_key is distinct from p_expected ->> 'show_key' then perform private.b45_changed(); end if;
  perform 1 from public.watchlist_items where show_id = s.id and user_id = v_owner for update;
  if (f.subject ->> 'tmdb_id') is distinct from p_tmdb_id::text or (f.show_id is not null and f.show_id <> s.id) then
    raise exception 'invalid_input: the identity isn''t the finding''s' using errcode = '22023';
  end if;
  if not p_review and not private.cu1_setup_ok(v_owner, s.id, null) then return private.cu1_finish(f.id, 'policy', 'pending', 'setup_required', null); end if;
  v_gate := private.cu1_hold_gate(v_owner, f, s.id, null, null, p_review, true);
  if v_gate like 'refuse:%' then perform private.lib_refuse('reopen_condition_not_met', 'The decision held for this show isn''t reopened, so nothing was changed.'); end if;
  if v_gate is not null then return private.cu1_gate_finish(f, v_gate); end if;
  if exists (select 1 from public.tv_shows where user_id = v_owner and tmdb_id = p_tmdb_id) then
    return private.cu1_finish(f.id, 'policy', 'pending', 'tmdb_taken', null);
  end if;
  if not p_review and private.cu1_norm(f.subject ->> 'tmdb_title') <> private.cu1_norm(s.title)
     and not exists (select 1 from public.record_aliases a where a.user_id = v_owner and a.show_id = s.id and a.match_text = private.cu1_norm(f.subject ->> 'tmdb_title')) then
    return private.cu1_finish(f.id, 'policy', 'pending', 'title_differs', null);
  end if;
  if not p_review and exists (select 1 from public.watchlist_items where show_id = s.id and private.tv_plain_season_number(season) is null) then
    return private.cu1_finish(f.id, 'policy', 'pending', 'nonstandard_labels', null);
  end if;
  update public.tv_shows set tmdb_id = p_tmdb_id where id = s.id and user_id = v_owner;
  for w in select id, season from public.watchlist_items where show_id = s.id and tmdb_id is null order by id loop
    v_n := private.tv_plain_season_number(w.season);
    if v_n is not null and p_listed @> to_jsonb(v_n)
       and not exists (select 1 from public.watchlist_items x where x.user_id = v_owner and x.media_type = 'tv' and x.tmdb_id = p_tmdb_id and x.season_number = v_n)
       and (private.cu1_hold_for(v_owner, array['identity_hold'], s.id, null, w.season)).id is null then
      update public.watchlist_items set media_type = 'tv', tmdb_id = p_tmdb_id, season_number = v_n where id = w.id;
      v_mapped := v_mapped || w.id;
    else
      v_left := v_left || w.id;
    end if;
  end loop;
  return private.cu1_finish(f.id, 'applied', 'applied', '', jsonb_build_object('outcome', 'attached', 'mapped', to_jsonb(v_mapped), 'unidentified', to_jsonb(v_left)));
end $$;

-- A TMDB finding the page holds for the owner's review without applying anything (a possible match
-- that fails the page's year or anchor tests, or more than one candidate). Kept pending with its reason.
create function public.library_cu_note_finding(p_finding jsonb, p_reason text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  f public.update_findings;
begin
  if coalesce(p_reason, '') !~ '^[a-z_]{1,60}$' then raise exception 'invalid_input: reason' using errcode = '22023'; end if;
  perform private.lib_write_on();
  f := private.cu1_finding_take(v_owner, p_finding, array['identity']);
  if f.status <> 'pending' then return private.cu1_not_actionable(f); end if;
  return private.cu1_finish(f.id, 'policy', 'pending', p_reason, null);
end $$;

-- ── Aliases (research evidence; never changes a title) ──
create function public.library_cu_add_alias(p_show_id uuid, p_item_id uuid, p_alias text, p_finding jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_cu_add_alias', 'final');
  f public.update_findings;
  v_gate text;
  v_id uuid;
  r jsonb;
begin
  if (p_show_id is null) = (p_item_id is null) or coalesce(btrim(p_alias), '') = '' or char_length(p_alias) > 200 or private.cu1_norm(p_alias) = '' then
    raise exception 'invalid_input: alias' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  f := private.cu1_finding_take(v_owner, p_finding, array['alias']);
  if f.source <> 'research' then raise exception 'invalid_input: an alias comes from research evidence' using errcode = '22023'; end if;
  r := private.cu1_not_actionable(f);
  if r is not null then return r; end if;
  if f.show_id is distinct from p_show_id or f.item_id is distinct from p_item_id or f.proposed ->> 'alias' is distinct from p_alias then
    raise exception 'invalid_input: the alias isn''t the finding''s' using errcode = '22023';
  end if;
  if p_show_id is not null then perform 1 from public.tv_shows where id = p_show_id and user_id = v_owner for update;
  else perform 1 from public.watchlist_items where id = p_item_id and user_id = v_owner for update; end if;
  if not found then perform private.lib_refuse('target_missing', 'This record is no longer on your list, so nothing was changed.'); end if;
  v_gate := private.cu1_research_gate(f, v_owner, false);
  if v_gate is not null then return private.cu1_gate_finish(f, v_gate); end if;
  insert into public.record_aliases (show_id, item_id, alias, match_text, evidence)
  values (p_show_id, p_item_id, btrim(p_alias), private.cu1_norm(p_alias), f.evidence)
  on conflict do nothing returning id into v_id;
  if v_id is null then return private.cu1_finish(f.id, 'already', 'applied', 'existing', jsonb_build_object('outcome', 'existing')); end if;
  return private.cu1_finish(f.id, 'applied', 'applied', '', jsonb_build_object('outcome', 'added', 'alias_id', v_id));
end $$;

-- ── Accepting a new show or film (owner review decision) ──
-- p_choice: { "action": "create", "show": {title, show_key, tmdb_id?, seasons: [{season_number, display_date, date_sort}]}
--             | "film": {title, tmdb_id?, display_date, date_sort}, "distinct_from": [ids], "add_back": bool }
--         | { "action": "same_as", "show_id" | "item_id", "add_back": bool }
create function public.library_cu_accept_finding(p_finding_id uuid, p_choice jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('library_cu_accept_finding', 'final');
  f public.update_findings;
  c public.personal_collections;
  v_gate text;
  v_show uuid;
  v_item uuid;
  v_distinct uuid[];
  v_title text;
  v_key text;
  v_tmdb integer;
  v_dups uuid[];
  x jsonb;
  v_n integer;
  v_added boolean;
  v_names text[];
begin
  if p_finding_id is null or jsonb_typeof(p_choice) is distinct from 'object' or p_choice ->> 'action' not in ('create', 'same_as') then
    raise exception 'invalid_input: finding and choice' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  select * into f from public.update_findings where id = p_finding_id and user_id = v_owner for update;
  if f.id is null then perform private.lib_refuse('target_missing', 'This finding is no longer saved, so nothing was changed.'); end if;
  if f.status <> 'pending' then perform private.lib_refuse('finding_not_pending', 'This finding was already decided, so nothing was changed.'); end if;
  if f.kind not in ('new_show', 'new_film') or f.source <> 'research' then raise exception 'invalid_input: only a researched new show or film is accepted' using errcode = '22023'; end if;
  v_gate := private.cu1_research_gate(f, v_owner, true);
  if v_gate is not null then return private.cu1_gate_finish(f, v_gate); end if;
  select * into c from public.personal_collections where id = f.collection_id and user_id = v_owner for share;
  if c.id is null then perform private.lib_refuse('org_not_found', 'This collection is no longer available, so nothing was changed.'); end if;
  if c.archived_at is not null then perform private.lib_refuse('org_archived', 'This collection is archived; unarchive it first. Nothing was changed.'); end if;
  v_names := array(select x2 from (select f.subject ->> 'title' x2
    union all select jsonb_array_elements_text(case when jsonb_typeof(f.subject -> 'working_titles') = 'array' then f.subject -> 'working_titles' else '[]' end)) q
    where coalesce(x2, '') <> '');

  if p_choice ->> 'action' = 'same_as' then
    begin v_show := (p_choice ->> 'show_id')::uuid; v_item := (p_choice ->> 'item_id')::uuid;
    exception when others then raise exception 'invalid_input: same_as' using errcode = '22023'; end;
    if (v_show is null) = (v_item is null) or (f.kind = 'new_show' and v_show is null) or (f.kind = 'new_film' and v_item is null) then
      raise exception 'invalid_input: same_as names one show (for a show) or one film (for a film)' using errcode = '22023';
    end if;
    if v_show is not null then perform 1 from public.tv_shows where id = v_show and user_id = v_owner for update;
    else perform 1 from public.watchlist_items where id = v_item and user_id = v_owner and is_film for update; end if;
    if not found then perform private.lib_refuse('target_missing', 'That record is no longer on your list, so nothing was changed.'); end if;
  else
    begin v_distinct := private.lib_distinct_ids(p_choice -> 'distinct_from'); exception when others then raise exception 'invalid_input: distinct_from' using errcode = '22023'; end;
    x := case when f.kind = 'new_show' then p_choice -> 'show' else p_choice -> 'film' end;
    if jsonb_typeof(x) is distinct from 'object' or coalesce(btrim(x ->> 'title'), '') = '' or char_length(x ->> 'title') > 200 then
      raise exception 'invalid_input: the new record' using errcode = '22023';
    end if;
    v_title := btrim(x ->> 'title');
    begin v_tmdb := (x ->> 'tmdb_id')::integer; exception when others then raise exception 'invalid_input: tmdb_id' using errcode = '22023'; end;
    -- Possible duplicates: the same TMDB id, or a title or alias equal to the new title or a working title,
    -- unless the owner listed that record as a different work.
    select coalesce(array_agg(distinct d order by d), '{}') into v_dups from (
      select s.id d from public.tv_shows s where f.kind = 'new_show' and s.user_id = v_owner and not (s.id = any(v_distinct))
        and ((v_tmdb is not null and s.tmdb_id = v_tmdb) or private.cu1_norm(s.title) in (select private.cu1_norm(n) from unnest(v_names || v_title) n)
             or exists (select 1 from public.record_aliases a where a.show_id = s.id and a.match_text in (select private.cu1_norm(n) from unnest(v_names || v_title) n)))
      union all
      select w.id from public.watchlist_items w where f.kind = 'new_film' and w.user_id = v_owner and w.is_film and not (w.id = any(v_distinct))
        and ((v_tmdb is not null and w.tmdb_id = v_tmdb) or private.cu1_norm(w.title) in (select private.cu1_norm(n) from unnest(v_names || v_title) n)
             or exists (select 1 from public.record_aliases a where a.item_id = w.id and a.match_text in (select private.cu1_norm(n) from unnest(v_names || v_title) n)))) q;
    if cardinality(v_dups) > 0 then
      raise exception 'possible_duplicate: A record with this TMDB identity, title or alias is already on your list. Choose it, or confirm this is a different work. Nothing was changed.'
        using errcode = 'P0001', detail = jsonb_build_object('candidates', to_jsonb(v_dups))::text;
    end if;
    if f.kind = 'new_show' then
      v_key := lower(v_title);
      perform pg_advisory_xact_lock(hashtext(v_owner::text || case when v_tmdb is null then '|tv|' || v_key else '|tvid|' || v_tmdb end));
      perform private.lib_refuse_twins(private.lib_catalog_twins(v_owner, 'show', v_key, v_title, v_distinct), 'show', 'added');
      if jsonb_typeof(x -> 'seasons') is distinct from 'array' or jsonb_array_length(x -> 'seasons') not between 1 and 50 then
        raise exception 'invalid_input: seasons' using errcode = '22023';
      end if;
      v_show := private.lib_new_show_row(v_owner, v_title, v_key, v_tmdb, 'confirmed');
      if v_show is null then perform private.lib_refuse('show_exists', 'A show with this name is already on your list, so nothing was added. Look at it again.'); end if;
      for x in select * from jsonb_array_elements(p_choice -> 'show' -> 'seasons') loop
        if coalesce(x ->> 'season_number', '') !~ '^[0-9]{1,4}$' or not private.tv_valid_date(x ->> 'date_sort') or coalesce(x ->> 'display_date', '') = '' then
          raise exception 'invalid_input: season %', x using errcode = '22023';
        end if;
        v_n := (x ->> 'season_number')::integer;
        insert into public.watchlist_items (item_key, title, season, theme, display_date, date_sort, watched, status, media_type, tmdb_id, season_number, show_id, skipped)
        values (v_key || '|' || lower(private.cu1_label(v_n)), v_title, private.cu1_label(v_n), coalesce(btrim(x ->> 'theme'), ''), x ->> 'display_date', x ->> 'date_sort',
          false, 'confirmed', case when v_tmdb is not null and (x ->> 'identified')::boolean then 'tv' end,
          case when v_tmdb is not null and (x ->> 'identified')::boolean then v_tmdb end,
          case when v_tmdb is not null and (x ->> 'identified')::boolean then v_n end, v_show, false);
      end loop;
    else
      v_key := lower(v_title) || '|film';
      perform private.lib_refuse_twins(private.lib_catalog_twins(v_owner, 'film', v_key, v_title, v_distinct), 'film', 'added');
      if not private.tv_valid_date(x ->> 'date_sort') or coalesce(x ->> 'display_date', '') = '' then raise exception 'invalid_input: film date' using errcode = '22023'; end if;
      v_item := private.lib_insert_film_b45(v_owner, jsonb_build_object('item_key', v_key, 'title', v_title, 'theme', coalesce(x ->> 'theme', ''),
        'display_date', x ->> 'display_date', 'date_sort', x ->> 'date_sort', 'tmdb_id', v_tmdb), 'other', false);
      if v_item is null then perform private.lib_refuse('film_exists', 'This film is already on your list, so nothing was added. Look at it again.'); end if;
    end if;
  end if;

  -- The membership; a recorded removal only with the owner's explicit choice to add it back.
  if exists (select 1 from public.membership_removals r where r.user_id = v_owner and r.collection_id = c.id and (r.show_id = v_show or r.item_id = v_item))
     and not coalesce((p_choice ->> 'add_back')::boolean, false) then
    perform private.lib_refuse('removed_from_collection', 'You removed this from the collection earlier. Choose to add it back, or leave it out. Nothing was changed.');
  end if;
  insert into public.collection_memberships (collection_id, show_id, item_id) values (c.id, v_show, v_item) on conflict do nothing;
  get diagnostics v_n = row_count;
  v_added := v_n > 0;
  delete from public.membership_removals r where r.user_id = v_owner and r.collection_id = c.id and (r.show_id = v_show or r.item_id = v_item);
  insert into public.record_aliases (show_id, item_id, alias, match_text, evidence)
  select v_show, v_item, btrim(n), private.cu1_norm(n), f.evidence from unnest(v_names) n
  where private.cu1_norm(n) <> '' and private.cu1_norm(n) <> private.cu1_norm(coalesce(v_title,
    (select title from public.tv_shows where id = v_show), (select title from public.watchlist_items where id = v_item)))
  on conflict do nothing;
  -- The accepted finding names its record from now on (aliases, anchors and later findings use it).
  update public.update_findings set show_id = v_show, item_id = v_item where id = f.id;
  return private.cu1_finish(f.id, 'applied', 'accepted', '', jsonb_build_object('outcome', p_choice ->> 'action', 'show_id', v_show, 'item_id', v_item,
    'membership_added', v_added));
end $$;

-- ── Owner decisions on findings ──
create function public.library_cu_set_finding_status(p_id uuid, p_expected_status text, p_status text, p_note text default '', p_exclusion jsonb default null)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  f public.update_findings;
begin
  if p_id is null or coalesce(p_status, '') not in ('not_now', 'dismissed', 'excluded', 'pending') or char_length(coalesce(p_note, '')) > 200 then
    raise exception 'invalid_input: finding status' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  select * into f from public.update_findings where id = p_id and user_id = v_owner for update;
  if f.id is null then perform private.lib_refuse('target_missing', 'This finding is no longer saved, so nothing was changed.'); end if;
  if f.status is distinct from p_expected_status then perform private.b45_changed(); end if;
  if not ((f.status in ('pending', 'needs_evidence', 'conflict', 'needs_research') and p_status in ('not_now', 'dismissed', 'excluded'))
          or (f.status = 'not_now' and p_status in ('pending', 'dismissed')) or (f.status = 'set_aside' and p_status = 'dismissed')) then
    perform private.lib_refuse('invalid_transition', 'This finding can''t be changed that way. Nothing was changed.');
  end if;
  if p_status = 'excluded' then
    if f.collection_id is null or jsonb_typeof(p_exclusion) is distinct from 'object' or p_exclusion ->> 'kind' not in ('title', 'every_version', 'series_and_spinoffs')
       or coalesce(btrim(p_exclusion ->> 'title'), '') = '' then
      raise exception 'invalid_input: an exclusion needs a collection, a kind and a title' using errcode = '22023';
    end if;
    insert into public.collection_exclusions (collection_id, kind, title, match_text, tmdb_id, media, note)
    values (f.collection_id, p_exclusion ->> 'kind', btrim(p_exclusion ->> 'title'), private.cu1_norm(p_exclusion ->> 'title'),
      (p_exclusion ->> 'tmdb_id')::integer, coalesce(p_exclusion ->> 'media', 'any'), coalesce(p_exclusion ->> 'note', ''))
    on conflict do nothing;
  end if;
  update public.update_findings set status = p_status, reason = coalesce(p_note, ''), decided_at = now(), last_seen_at = now()
  where id = f.id returning * into f;
  return to_jsonb(f) - 'user_id';
end $$;

-- ── Briefs and imports ──
-- Registers an exported brief: each collection's current definition version and hashes, as the brief
-- carries them (Follow and Discover collections only).
create function public.library_cu_register_brief(p_id uuid, p_collections jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_out jsonb := '[]';
  v_c uuid;
  d public.collection_definitions;
begin
  if p_id is null or jsonb_typeof(p_collections) is distinct from 'array' or jsonb_array_length(p_collections) not between 1 and 50 then
    raise exception 'invalid_input: brief' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  for v_c in select (x #>> '{}')::uuid from jsonb_array_elements(p_collections) x loop
    d := private.cu1_current_definition(v_owner, v_c);
    if d.id is null or d.mode = 'manual' then
      perform private.lib_refuse('no_definition', 'A chosen collection has no confirmed Follow or Discover definition, so no brief was made.');
    end if;
    v_out := v_out || jsonb_build_object('collection_id', v_c, 'definition_id', d.id, 'definition_version', d.version, 'mode', d.mode,
      'rule_hashes', d.rule_hashes, 'evidence_hash', d.evidence_hash);
  end loop;
  insert into public.research_briefs (id, collections) values (p_id, v_out);
  return jsonb_build_object('id', p_id, 'collections', v_out);
end $$;

-- One findings file: refused when already imported (by its SHA-256). Each finding's version and hashes
-- come from the brief's record, never the file. A new fingerprint starts in the status the page routed it
-- to; an existing one merges new evidence and changes status only as docs/ITEM4_DESIGN.md §3.3 allows.
create function public.library_cu_record_findings(p_brief_id uuid, p_file_sha256 text, p_findings jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  b public.research_briefs;
  x jsonb;
  bc jsonb;
  f public.update_findings;
  v_new_urls jsonb;
  v_newer boolean;
  v_status text;
  v_routed text;
  v_out jsonb := '[]';
  v_counts jsonb := '{}';
begin
  if p_brief_id is null or coalesce(p_file_sha256, '') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_findings) is distinct from 'array' or jsonb_array_length(p_findings) > 2000 then
    raise exception 'invalid_input: findings import' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  select * into b from public.research_briefs where id = p_brief_id and user_id = v_owner;
  if b.id is null then perform private.lib_refuse('unknown_brief', 'This findings file names a brief this account didn''t export, so nothing was imported.'); end if;
  if exists (select 1 from public.research_imports where user_id = v_owner and file_sha256 = p_file_sha256) then
    perform private.lib_refuse('already_imported', 'This findings file was already imported, so nothing changed.');
  end if;
  for x in select * from jsonb_array_elements(p_findings) loop
    v_routed := coalesce(x ->> 'routed_status', '');
    if jsonb_typeof(x) is distinct from 'object' or coalesce(x ->> 'fingerprint', '') !~ '^[a-z_]+:[0-9a-f]{64}$'
       or v_routed not in ('pending', 'needs_evidence', 'conflict', 'needs_research', 'set_aside')
       or coalesce(x ->> 'kind', '') not in ('new_season', 'date', 'alias', 'new_show', 'new_film', 'cancellation', 'renewal_none')
       or jsonb_typeof(x -> 'evidence') is distinct from 'array' or jsonb_typeof(x -> 'assessment') is distinct from 'object'
       or jsonb_typeof(x -> 'subject') is distinct from 'object' or (x ? 'rule_id' and coalesce(x ->> 'rule_id', '') !~ '^[a-z0-9_-]{1,40}$') then
      raise exception 'invalid_input: finding %', x ->> 'fingerprint' using errcode = '22023';
    end if;
    select e into bc from jsonb_array_elements(b.collections) e where e ->> 'collection_id' = x ->> 'collection_id';
    if bc is null then raise exception 'invalid_input: finding % names a collection the brief didn''t carry', x ->> 'fingerprint' using errcode = '22023'; end if;
    if (x ->> 'show_id' is not null and not exists (select 1 from public.tv_shows where id = (x ->> 'show_id')::uuid and user_id = v_owner))
       or (x ->> 'item_id' is not null and not exists (select 1 from public.watchlist_items where id = (x ->> 'item_id')::uuid and user_id = v_owner))
       or (x ->> 'season_id' is not null and not exists (select 1 from public.watchlist_items where id = (x ->> 'season_id')::uuid and user_id = v_owner)) then
      raise exception 'invalid_input: finding % names a record that isn''t in your library', x ->> 'fingerprint' using errcode = '22023';
    end if;
    select * into f from public.update_findings where user_id = v_owner and fingerprint = x ->> 'fingerprint' for update;
    if f.id is null then
      insert into public.update_findings (fingerprint, source, kind, status, reason, collection_id, show_id, item_id, season_id, subject, proposed, expected,
        evidence, assessment, rule_id, definition_version, rule_hash, evidence_hash, brief_id)
      values (x ->> 'fingerprint', 'research', x ->> 'kind', v_routed, coalesce(x ->> 'reason', ''), (x ->> 'collection_id')::uuid,
        (x ->> 'show_id')::uuid, (x ->> 'item_id')::uuid, (x ->> 'season_id')::uuid, x -> 'subject', coalesce(x -> 'proposed', '{}'), coalesce(x -> 'expected', '{}'),
        x -> 'evidence', x -> 'assessment', x ->> 'rule_id', (bc ->> 'definition_version')::integer,
        case when x ? 'rule_id' then bc -> 'rule_hashes' ->> (x ->> 'rule_id') end, bc ->> 'evidence_hash', b.id)
      returning * into f;
      v_status := f.status;
    else
      if f.source <> 'research' or f.kind <> x ->> 'kind' then raise exception 'invalid_input: finding % changed kind', x ->> 'fingerprint' using errcode = '22023'; end if;
      select coalesce(jsonb_agg(e), '[]') into v_new_urls from jsonb_array_elements(x -> 'evidence') e
      where not exists (select 1 from jsonb_array_elements(f.evidence) o where o ->> 'url' = e ->> 'url');
      select exists (select 1 from jsonb_array_elements(v_new_urls) e where f.decided_at is not null and private.cu1_date(e ->> 'published_on') > f.decided_at::date) into v_newer;
      v_status := case
        when f.status in ('excluded', 'accepted', 'applied', 'dismissed') then f.status
        when f.status = 'not_now' then case when v_newer and v_routed = 'pending' then 'pending' else 'not_now' end
        when f.status = 'set_aside' then case when b.exported_at > coalesce(f.decided_at, f.last_seen_at) and v_routed = 'pending' then 'pending' else 'set_aside' end
        when f.status in ('needs_evidence', 'conflict', 'needs_research') then
          case when v_routed = 'pending' and (jsonb_array_length(v_new_urls) > 0 or f.evidence_hash is distinct from bc ->> 'evidence_hash'
                    or f.rule_hash is distinct from bc -> 'rule_hashes' ->> f.rule_id) then 'pending' else v_routed end
        else v_routed end;
      update public.update_findings set
        evidence = case when f.status in ('excluded', 'accepted', 'applied', 'dismissed') then f.evidence else f.evidence || v_new_urls end,
        assessment = case when f.status in ('excluded', 'accepted', 'applied', 'dismissed') then f.assessment else x -> 'assessment' end,
        status = v_status, reason = case when v_status <> f.status then coalesce(x ->> 'reason', '') else f.reason end,
        definition_version = case when v_status = 'pending' and f.status <> 'pending' then (bc ->> 'definition_version')::integer else f.definition_version end,
        rule_hash = case when v_status = 'pending' and f.status <> 'pending' and f.rule_id is not null then bc -> 'rule_hashes' ->> f.rule_id else f.rule_hash end,
        evidence_hash = case when v_status = 'pending' and f.status <> 'pending' then bc ->> 'evidence_hash' else f.evidence_hash end,
        brief_id = case when v_status = 'pending' and f.status <> 'pending' then b.id else f.brief_id end,
        last_seen_at = now()
      where id = f.id returning * into f;
    end if;
    v_out := v_out || jsonb_build_object('fingerprint', f.fingerprint, 'id', f.id, 'status', f.status);
    v_counts := jsonb_set(v_counts, array[f.status], to_jsonb(coalesce((v_counts ->> f.status)::integer, 0) + 1));
  end loop;
  insert into public.research_imports (brief_id, file_sha256, counts) values (b.id, p_file_sha256, v_counts);
  return jsonb_build_object('findings', v_out, 'counts', v_counts);
end $$;

-- ── Definitions, exclusions, holds, show settings, setup ──
create function public.library_cu_save_definition(p_collection_id uuid, p_expected_version integer, p_mode text, p_rules jsonb, p_evidence jsonb, p_summary text)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  d public.collection_definitions;
begin
  if p_collection_id is null or p_expected_version is null or p_expected_version < 0 then raise exception 'invalid_input: definition' using errcode = '22023'; end if;
  perform private.lib_write_on();
  perform 1 from public.personal_collections where id = p_collection_id and user_id = v_owner for update;
  if not found then perform private.lib_refuse('org_not_found', 'This collection is no longer available, so nothing was changed.'); end if;
  if coalesce((private.cu1_current_definition(v_owner, p_collection_id)).version, 0) <> p_expected_version then perform private.b45_changed(); end if;
  if not private.cu1_rules_ok(coalesce(p_rules, 'null')) or not private.cu1_evidence_settings_ok(coalesce(p_evidence, 'null')) then
    raise exception 'invalid_input: rules or evidence settings' using errcode = '22023';
  end if;
  insert into public.collection_definitions (collection_id, version, mode, rules, evidence, summary, rule_hashes, evidence_hash)
  values (p_collection_id, p_expected_version + 1, p_mode, p_rules, p_evidence, coalesce(p_summary, ''), private.cu1_rule_hashes(p_rules), md5(p_evidence::text))
  returning * into d;
  return to_jsonb(d) - 'user_id';
end $$;

create function public.library_cu_set_exclusion(p_collection_id uuid, p_op text, p_exclusion jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_id uuid;
begin
  if p_collection_id is null or coalesce(p_op, '') not in ('add', 'remove') or jsonb_typeof(p_exclusion) is distinct from 'object'
     or (p_op = 'add' and coalesce(p_exclusion ->> 'kind', '') not in ('title', 'every_version', 'series_and_spinoffs')) then
    raise exception 'invalid_input: exclusion' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  perform 1 from public.personal_collections where id = p_collection_id and user_id = v_owner for update;
  if not found then perform private.lib_refuse('org_not_found', 'This collection is no longer available, so nothing was changed.'); end if;
  if p_op = 'add' then
    insert into public.collection_exclusions (collection_id, kind, title, match_text, tmdb_id, media, note)
    values (p_collection_id, p_exclusion ->> 'kind', btrim(p_exclusion ->> 'title'), private.cu1_norm(p_exclusion ->> 'title'),
      (p_exclusion ->> 'tmdb_id')::integer, coalesce(p_exclusion ->> 'media', 'any'), coalesce(p_exclusion ->> 'note', ''))
    on conflict do nothing returning id into v_id;
    return jsonb_build_object('added', v_id is not null, 'id', v_id);
  end if;
  delete from public.collection_exclusions where id = (p_exclusion ->> 'id')::uuid and collection_id = p_collection_id and user_id = v_owner
    and title = p_exclusion ->> 'title' returning id into v_id;
  return jsonb_build_object('removed', v_id is not null, 'id', v_id);
end $$;

create function private.cu1_insert_hold(p_hold jsonb) returns uuid
language plpgsql set search_path = '' as $$
declare v uuid;
begin
  if jsonb_typeof(p_hold) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_hold) k where k not in ('kind', 'collection_id', 'show_id', 'item_id', 'subject_label', 'field',
       'protected_value', 'decision', 'effect', 'reopen', 'decided_on')) then
    raise exception 'invalid_input: hold' using errcode = '22023';
  end if;
  insert into public.update_holds (kind, collection_id, show_id, item_id, subject_label, field, protected_value, decision, effect, reopen, decided_on)
  values (p_hold ->> 'kind', (p_hold ->> 'collection_id')::uuid, (p_hold ->> 'show_id')::uuid, (p_hold ->> 'item_id')::uuid, nullif(btrim(p_hold ->> 'subject_label'), ''),
    p_hold ->> 'field', p_hold ->> 'protected_value', btrim(p_hold ->> 'decision'), p_hold ->> 'effect', p_hold -> 'reopen', (p_hold ->> 'decided_on')::date)
  returning id into v;
  return v;
exception
  when foreign_key_violation then raise exception 'invalid_input: a hold names a record or collection that isn''t yours' using errcode = '22023';
  when check_violation or invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
    raise exception 'invalid_input: hold %', sqlerrm using errcode = '22023';
end $$;
create function public.library_cu_save_hold(p_hold jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); v uuid;
begin
  perform private.lib_write_on();
  v := private.cu1_insert_hold(p_hold);
  return (select to_jsonb(h) - 'user_id' from public.update_holds h where h.id = v and h.user_id = v_owner);
end $$;
create function public.library_cu_delete_hold(p_id uuid, p_expected_decision text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); v uuid;
begin
  perform private.lib_write_on();
  delete from public.update_holds where id = p_id and user_id = v_owner and decision = p_expected_decision returning id into v;
  if v is null then perform private.b45_changed(); end if;
  return jsonb_build_object('deleted', v);
end $$;

create function public.library_cu_set_show_settings(p_show_id uuid, p_expected jsonb, p_follow_when_skipped boolean, p_clear_ended_flag boolean) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  st public.show_update_settings;
begin
  if p_show_id is null or jsonb_typeof(p_expected) is distinct from 'object' or p_follow_when_skipped is null or p_clear_ended_flag is null then
    raise exception 'invalid_input: show settings' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  perform 1 from public.tv_shows where id = p_show_id and user_id = v_owner for update;
  if not found then perform private.lib_refuse('target_missing', 'This show is no longer on your list, so nothing was changed.'); end if;
  select * into st from public.show_update_settings where show_id = p_show_id;
  if coalesce(st.follow_when_skipped, false) is distinct from (p_expected ->> 'follow_when_skipped')::boolean
     or (st.new_season_after_ended_at is not null) is distinct from (p_expected ->> 'flagged')::boolean then perform private.b45_changed(); end if;
  insert into public.show_update_settings (show_id, follow_when_skipped, new_season_after_ended_at)
  values (p_show_id, p_follow_when_skipped, null)
  on conflict (show_id) do update set follow_when_skipped = excluded.follow_when_skipped,
    new_season_after_ended_at = case when p_clear_ended_flag then null else public.show_update_settings.new_season_after_ended_at end, updated_at = now()
  returning * into st;
  return to_jsonb(st) - 'user_id';
end $$;

-- The setup file (built-in definitions, exclusions and holds, resolved and confirmed in the page), in one
-- transaction; refused for a collection that already has a definition. Records the setup row.
create function public.library_cu_import_setup(p_doc jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  x jsonb;
  v_defs int := 0; v_excl int := 0; v_holds int := 0; v_n int;
begin
  if jsonb_typeof(p_doc) is distinct from 'object' or jsonb_typeof(p_doc -> 'definitions') is distinct from 'array'
     or jsonb_typeof(p_doc -> 'exclusions') is distinct from 'array' or jsonb_typeof(p_doc -> 'holds') is distinct from 'array' then
    raise exception 'invalid_input: setup' using errcode = '22023';
  end if;
  perform private.lib_write_on();
  for x in select * from jsonb_array_elements(p_doc -> 'definitions') loop
    perform 1 from public.personal_collections where id = (x ->> 'collection_id')::uuid and user_id = v_owner for update;
    if not found then perform private.lib_refuse('org_not_found', 'A collection in the setup is no longer available, so nothing was imported.'); end if;
    if exists (select 1 from public.collection_definitions where user_id = v_owner and collection_id = (x ->> 'collection_id')::uuid) then
      perform private.lib_refuse('definition_exists', 'A collection in the setup already has a definition, so nothing was imported.');
    end if;
    if not private.cu1_rules_ok(coalesce(x -> 'rules', 'null')) or not private.cu1_evidence_settings_ok(coalesce(x -> 'evidence', 'null')) then
      raise exception 'invalid_input: setup definition rules or evidence' using errcode = '22023';
    end if;
    insert into public.collection_definitions (collection_id, version, mode, rules, evidence, summary, rule_hashes, evidence_hash)
    values ((x ->> 'collection_id')::uuid, 1, x ->> 'mode', x -> 'rules', x -> 'evidence', coalesce(x ->> 'summary', ''),
      private.cu1_rule_hashes(x -> 'rules'), md5((x -> 'evidence')::text));
    v_defs := v_defs + 1;
  end loop;
  for x in select * from jsonb_array_elements(p_doc -> 'exclusions') loop
    insert into public.collection_exclusions (collection_id, kind, title, match_text, tmdb_id, media, note)
    values ((x ->> 'collection_id')::uuid, x ->> 'kind', btrim(x ->> 'title'), private.cu1_norm(x ->> 'title'), (x ->> 'tmdb_id')::integer,
      coalesce(x ->> 'media', 'any'), coalesce(x ->> 'note', ''))
    on conflict do nothing;
    get diagnostics v_n = row_count; v_excl := v_excl + v_n;
  end loop;
  for x in select * from jsonb_array_elements(p_doc -> 'holds') loop
    perform private.cu1_insert_hold(x);
    v_holds := v_holds + 1;
  end loop;
  insert into public.update_setup (source) values ('setup_file')
  on conflict (user_id) do update set setup_confirmed_at = now();
  return jsonb_build_object('definitions', v_defs, 'exclusions', v_excl, 'holds', v_holds);
end $$;

-- ── Memberships: removals are remembered (same signatures as Stage 3b-2) ──
create or replace function public.org_add_membership(p_collection_id uuid, p_show_id uuid default null, p_item_id uuid default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_film boolean;
  v_show uuid;
  c public.personal_collections;
  m public.collection_memberships;
  v_added boolean := true;
begin
  perform set_config('lock_timeout', '5s', true);
  if (p_show_id is null) = (p_item_id is null) then
    perform private.org_refuse('invalid_input', 'add exactly one show or film. Nothing was changed.');
  end if;
  if p_show_id is not null then
    perform 1 from public.tv_shows where id = p_show_id and user_id = v_owner for key share;
    if not found then perform private.org_refuse('org_target_missing', 'that show is no longer saved. Nothing was changed.'); end if;
  else
    select is_film, show_id into v_film, v_show from public.watchlist_items where id = p_item_id and user_id = v_owner for key share;
    if not found then perform private.org_refuse('org_target_missing', 'that film is no longer saved. Nothing was changed.'); end if;
    if not v_film then
      perform private.org_refuse('org_not_film', 'that row is no longer a film (it may have been matched as a TV season). Nothing was changed.',
        jsonb_build_object('show_id', v_show, 'show_title', (select title from public.tv_shows where id = v_show)));
    end if;
  end if;
  select * into c from public.personal_collections where id = p_collection_id and user_id = v_owner for share;
  if c.id is null then perform private.org_refuse('org_not_found', 'this collection is no longer available. Nothing was changed.'); end if;
  if c.archived_at is not null then
    perform private.org_refuse('org_archived', 'this collection is archived; unarchive it to change its members. Nothing was changed.');
  end if;
  if p_show_id is not null then
    insert into public.collection_memberships (collection_id, show_id) values (c.id, p_show_id)
    on conflict (collection_id, show_id) where (show_id is not null) do nothing returning * into m;
    if m.id is null then
      select * into m from public.collection_memberships where collection_id = c.id and show_id = p_show_id;
      v_added := false;
    end if;
  else
    insert into public.collection_memberships (collection_id, item_id) values (c.id, p_item_id)
    on conflict (collection_id, item_id) where (item_id is not null) do nothing returning * into m;
    if m.id is null then
      select * into m from public.collection_memberships where collection_id = c.id and item_id = p_item_id;
      v_added := false;
    end if;
  end if;
  -- CU1: an owner's add (or Undo of a removal) clears a remembered removal.
  perform set_config('watchlist.library_write', 'on', true);
  delete from public.membership_removals r where r.user_id = v_owner and r.collection_id = c.id
    and (r.show_id = p_show_id or r.item_id = p_item_id);
  return jsonb_build_object('membership', to_jsonb(m) - 'user_id' - 'item_is_film', 'added', v_added);
end $$;

create or replace function public.org_remove_membership(p_membership_id uuid, p_collection_id uuid, p_show_id uuid default null, p_item_id uuid default null)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_film boolean;
  v_show uuid;
  c public.personal_collections;
  v_gone uuid;
begin
  perform set_config('lock_timeout', '5s', true);
  if p_membership_id is null or (p_show_id is null) = (p_item_id is null) then
    perform private.org_refuse('invalid_input', 'name the membership and exactly one show or film. Nothing was changed.');
  end if;
  if p_show_id is not null then
    perform 1 from public.tv_shows where id = p_show_id and user_id = v_owner for key share;
    if not found then return jsonb_build_object('removed', false, 'reason', 'target_missing'); end if;
  else
    select is_film, show_id into v_film, v_show from public.watchlist_items where id = p_item_id and user_id = v_owner for key share;
    if not found then return jsonb_build_object('removed', false, 'reason', 'target_missing'); end if;
    if not v_film then
      return jsonb_build_object('removed', false, 'reason', 'not_film', 'show_id', v_show,
        'show_title', (select title from public.tv_shows where id = v_show));
    end if;
  end if;
  select * into c from public.personal_collections where id = p_collection_id and user_id = v_owner for share;
  if c.id is null then perform private.org_refuse('org_not_found', 'this collection is no longer available. Nothing was changed.'); end if;
  if c.archived_at is not null then
    perform private.org_refuse('org_archived', 'this collection is archived; unarchive it to change its members. Nothing was changed.');
  end if;
  delete from public.collection_memberships
  where id = p_membership_id and user_id = v_owner and collection_id = c.id
    and show_id is not distinct from p_show_id and item_id is not distinct from p_item_id
  returning id into v_gone;
  if v_gone is null then return jsonb_build_object('removed', false, 'reason', 'not_found'); end if;
  -- CU1: the owner's removal is remembered, so a later discovery doesn't offer it back unasked.
  perform set_config('watchlist.library_write', 'on', true);
  if p_show_id is not null then
    insert into public.membership_removals (collection_id, show_id) values (c.id, p_show_id)
    on conflict (collection_id, show_id) where (show_id is not null) do update set removed_at = now();
  else
    insert into public.membership_removals (collection_id, item_id) values (c.id, p_item_id)
    on conflict (collection_id, item_id) where (item_id is not null) do update set removed_at = now();
  end if;
  return jsonb_build_object('removed', true, 'membership_id', v_gone);
end $$;

-- ── Retirement of the config-based catalog workflow ──
create or replace function public.library_catalog_apply_b45(p_catalog text, p_defaults jsonb, p_approved text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'client_outdated: Catalog updates were replaced by collection updates. Reload the page. Nothing was changed.' using errcode = 'P0001';
end $$;

-- ── restore_backup, format 7 ──
-- The format-6 function (unchanged, now private) restores its nine tables; the owner's rows in CU1's ten
-- tables are deleted first, then inserted from the file and verified row for row, in the same transaction.
-- Formats 3–6 are converted in the page first (6 → 7 adds the ten tables empty). A converted document may
-- carry conversion { source_format: '3' | '4' | '5' | '6', … }.
create function private.cu1_backup_columns() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'update_setup', 'id uuid, setup_confirmed_at timestamptz, source text',
    'collection_definitions', 'id uuid, collection_id uuid, version integer, mode text, rules jsonb, evidence jsonb, summary text, rule_hashes jsonb, evidence_hash text, confirmed_at timestamptz',
    'collection_exclusions', 'id uuid, collection_id uuid, kind text, title text, match_text text, tmdb_id integer, media text, note text, created_at timestamptz',
    'update_holds', 'id uuid, kind text, collection_id uuid, show_id uuid, item_id uuid, subject_label text, field text, protected_value text, decision text, effect text, reopen jsonb, decided_on date, created_at timestamptz',
    'record_aliases', 'id uuid, show_id uuid, item_id uuid, alias text, match_text text, evidence jsonb, created_at timestamptz',
    'membership_removals', 'id uuid, collection_id uuid, show_id uuid, item_id uuid, removed_at timestamptz',
    'show_update_settings', 'id uuid, show_id uuid, follow_when_skipped boolean, new_season_after_ended_at timestamptz, updated_at timestamptz',
    'research_briefs', 'id uuid, exported_at timestamptz, collections jsonb',
    'research_imports', 'id uuid, brief_id uuid, file_sha256 text, imported_at timestamptz, counts jsonb',
    'update_findings', 'id uuid, fingerprint text, source text, kind text, status text, reason text, collection_id uuid, show_id uuid, item_id uuid, season_id uuid, subject jsonb, proposed jsonb, expected jsonb, evidence jsonb, assessment jsonb, rule_id text, definition_version integer, rule_hash text, evidence_hash text, brief_id uuid, first_seen_at timestamptz, last_seen_at timestamptz, decided_at timestamptz, applied_at timestamptz, result jsonb')
$$;
-- Insertion order (references first).
create function private.cu1_backup_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array['update_setup', 'collection_definitions', 'collection_exclusions', 'update_holds', 'record_aliases', 'membership_removals',
    'show_update_settings', 'research_briefs', 'research_imports', 'update_findings']
$$;

alter function public.restore_backup(jsonb, boolean) rename to restore_backup_v6;
alter function public.restore_backup_v6(jsonb, boolean) set schema private;
create function public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean default false)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_version text := p_backup ->> 'formatVersion';
  v_tables jsonb := p_backup -> 'tables';
  v_counts jsonb := p_backup -> 'rowCounts';
  v_conv jsonb := p_backup -> 'conversion';
  v_cols jsonb := private.cu1_backup_columns();
  v_inner jsonb;
  v_out jsonb;
  v_restored jsonb := '{}';
  t text;
  v_spec text;
  v_names text;
  v_keys text[];
  v_k int;
  v_bad boolean;
  v_constraint text;
begin
  if p_backup ->> 'format' is distinct from 'watchlist-tracker-backup' then
    raise exception 'restore_invalid: not a Watchlist backup' using errcode = '22023';
  end if;
  if v_version in ('1', '2') then
    raise exception 'restore_invalid: format % backups can no longer be restored', v_version using errcode = '22023';
  elsif v_version in ('3', '4', '5', '6') then
    raise exception 'restore_invalid: format % backups are converted in the page first (Restore shows what the conversion keeps and what it can''t); nothing was changed', v_version
      using errcode = '22023';
  elsif v_version is distinct from '7' then
    raise exception 'restore_invalid: unsupported backup format %', coalesce(v_version, '(none)') using errcode = '22023';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_backup) k)
     <@ array['conversion', 'exportedAt', 'format', 'formatVersion', 'recovery', 'rowCounts', 'tables']::text[] is not true then
    raise exception 'restore_invalid: unexpected top-level fields' using errcode = '22023';
  end if;
  if jsonb_typeof(v_tables) is distinct from 'object' or jsonb_typeof(v_counts) is distinct from 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(v_tables) k)
        is distinct from (select array_agg(k order by k collate "C") from unnest(array['catalog_film_links', 'catalog_show_links', 'collection_memberships',
          'custom_collections', 'episode_marks', 'personal_collections', 'tv_shows', 'watch_with_choices', 'watchlist_items'] || private.cu1_backup_tables()) k) then
    raise exception 'restore_invalid: unexpected set of tables for format 7' using errcode = '22023';
  end if;
  foreach t in array private.cu1_backup_tables() loop
    if jsonb_typeof(v_tables -> t) is distinct from 'array' then raise exception 'restore_invalid: % is not a list of rows', t using errcode = '22023'; end if;
    if (v_counts ->> t) is distinct from jsonb_array_length(v_tables -> t)::text then
      raise exception 'restore_invalid: rowCounts.% does not match its rows', t using errcode = '22023';
    end if;
    v_keys := array(select k from (select btrim(split_part(c, ' ', 1)) k from unnest(string_to_array(v_cols ->> t, ', ')) c) q order by k collate "C");
    if exists (select 1 from jsonb_array_elements(v_tables -> t) r
               where jsonb_typeof(r) is distinct from 'object' or (select array_agg(k order by k collate "C") from jsonb_object_keys(r) k) is distinct from v_keys) then
      raise exception 'restore_invalid: a % row does not have exactly the expected columns', t using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(v_tables -> t) r
               where jsonb_typeof(r -> 'id') is distinct from 'string' or (r ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'restore_invalid: a % row has an id that isn''t a uuid, so nothing was changed', t using errcode = '22023';
    end if;
  end loop;
  if jsonb_array_length(v_tables -> 'update_setup') > 1 then raise exception 'restore_invalid: more than one update_setup row' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(v_tables -> 'collection_definitions') d
             where not private.cu1_rules_ok(coalesce(d -> 'rules', 'null')) or not private.cu1_evidence_settings_ok(coalesce(d -> 'evidence', 'null'))
                or d -> 'rule_hashes' is distinct from private.cu1_rule_hashes(d -> 'rules') or d ->> 'evidence_hash' is distinct from md5((d -> 'evidence')::text)) then
    raise exception 'restore_invalid: a collection definition in the backup isn''t consistent, so nothing was changed' using errcode = '22023';
  end if;
  if v_conv is not null and (jsonb_typeof(v_conv) is distinct from 'object' or (v_conv ->> 'source_format') not in ('3', '4', '5', '6')) then
    raise exception 'restore_invalid: the conversion record is malformed' using errcode = '22023';
  end if;
  if v_conv is not null and (v_conv ->> 'source_format') = '6'
     and (coalesce(v_conv ->> 'source_sha256', '') !~ '^[0-9a-f]{64}$' or coalesce(v_conv ->> 'converter_version', '') = ''
          or coalesce(v_conv ->> 'source_exported_at', '') = '' or p_backup ? 'recovery') then
    raise exception 'restore_invalid: the conversion record is malformed' using errcode = '22023';
  end if;

  -- The owner's rows in CU1's tables go first (the format-6 restore then replaces the nine tables).
  perform private.lib_write_on();
  delete from public.update_findings where user_id = v_owner;
  delete from public.research_imports where user_id = v_owner;
  delete from public.research_briefs where user_id = v_owner;
  delete from public.record_aliases where user_id = v_owner;
  delete from public.membership_removals where user_id = v_owner;
  delete from public.show_update_settings where user_id = v_owner;
  delete from public.update_holds where user_id = v_owner;
  delete from public.collection_exclusions where user_id = v_owner;
  delete from public.collection_definitions where user_id = v_owner;
  delete from public.update_setup where user_id = v_owner;

  v_inner := (p_backup - 'formatVersion' - 'tables' - 'rowCounts' - 'conversion')
    || jsonb_build_object('formatVersion', 6, 'tables', v_tables - private.cu1_backup_tables(), 'rowCounts', v_counts - private.cu1_backup_tables())
    || case when v_conv is not null and (v_conv ->> 'source_format') <> '6' then jsonb_build_object('conversion', v_conv) else '{}'::jsonb end;
  v_out := private.restore_backup_v6(v_inner, p_allow_v1_reset);

  perform private.lib_write_on();
  foreach t in array private.cu1_backup_tables() loop
    v_spec := v_cols ->> t;
    v_names := (select string_agg(split_part(c, ' ', 1), ', ') from unnest(string_to_array(v_spec, ', ')) c);
    execute format('select count(*) from public.%I where user_id = $1', t) into v_k using v_owner;
    if v_k <> 0 then raise exception 'restore_invalid: % rows remained after the library was replaced, so nothing was changed', t using errcode = '22023'; end if;
    begin
      execute format('insert into public.%I (%s) select %s from jsonb_to_recordset($1) as x(%s)', t, v_names, v_names, v_spec) using v_tables -> t;
      get diagnostics v_k = row_count;
    exception
      when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint like '%_pkey' or v_constraint like '%_id_key' then
          raise exception 'restore_id_collision: this backup contains ids already owned by another user; restoring it would keep those ids and break user isolation, so nothing was changed'
            using errcode = '23505';
        end if;
        raise exception 'restore_invalid: the backup repeats a % row (%), so nothing was changed', t, v_constraint using errcode = '22023';
      when foreign_key_violation then
        raise exception 'restore_invalid: a % row in the backup points at a record that isn''t in it, so nothing was changed', t using errcode = '22023';
      when check_violation or not_null_violation or raise_exception or invalid_text_representation or numeric_value_out_of_range
           or datetime_field_overflow or invalid_datetime_format then
        get stacked diagnostics v_constraint = message_text;
        raise exception 'restore_invalid: a % row in the backup breaks a rule (%), so nothing was changed', t, v_constraint using errcode = '22023';
    end;
    execute format('select exists (select %s from jsonb_to_recordset($1) as x(%s) except select %s from public.%I where user_id = $2)', v_names, v_spec, v_names, t)
      into v_bad using v_tables -> t, v_owner;
    if v_bad or v_k <> jsonb_array_length(v_tables -> t) then
      raise exception 'restore_invalid: the restored % differ from the backup', t using errcode = '22023';
    end if;
    v_restored := v_restored || jsonb_build_object(t, v_k);
  end loop;

  return jsonb_build_object('formatVersion', 7, 'restored', (v_out -> 'restored') || v_restored,
    'recovery', v_out -> 'recovery', 'converted_from', case when v_conv is not null then (v_conv ->> 'source_format')::int end);
end $$;

-- ── 5. Grants ──────────────────────────────────────────────────────────────────
-- Explicit, then verified: default privileges owned by supabase_admin can't be relied on. The functions
-- are security invoker, so authenticated holds the table privileges they use; the write guards refuse
-- any direct write.
do $$
declare t text; v_cols text;
begin
  foreach t in array private.cu1_backup_tables() loop
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
    from information_schema.columns where table_schema = 'public' and table_name = t and column_name <> 'user_id';
    execute format('grant select, delete on public.%I to authenticated', t);
    execute format('grant insert (%s), update (%s) on public.%I to authenticated', v_cols, v_cols, t);
  end loop;
end $$;
create temp table cu1_new_fns on commit drop as
select p.oid::regprocedure::text f from pg_proc p
where (p.pronamespace = 'private'::regnamespace and (p.proname like 'cu1\_%' or p.proname = 'restore_backup_v6'))
   or (p.pronamespace = 'public'::regnamespace and p.proname like 'library\_cu\_%');
do $$
declare r record;
begin
  for r in select f from cu1_new_fns union all select unnest(array['public.restore_backup(jsonb,boolean)', 'public.org_add_membership(uuid,uuid,uuid)',
    'public.org_remove_membership(uuid,uuid,uuid,uuid)', 'public.library_catalog_apply_b45(text,jsonb,text)']) loop
    execute format('revoke all on function %s from public, anon', r.f);
    execute format('grant execute on function %s to authenticated', r.f);
  end loop;
end $$;

-- ── 6. The capability and the run record ───────────────────────────────────────
create or replace function public.stage5_capabilities() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted-cu1', 'backup_format', 7, 'b45', 1, 'ep1', 1, 'cu1', 1, 'access', 'members',
    'member', private.is_member(),
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;
revoke execute on function public.stage5_capabilities() from public, anon;
grant execute on function public.stage5_capabilities() to authenticated;
insert into private.migration_runs (run_id, migration) select run_id, 'cu1' from cu1_ctx;

-- ── 7. Verify before commit ────────────────────────────────────────────────────
do $$
declare v_bad jsonb; v_owner uuid; v_tmdb integer; v_show uuid; v_show2 uuid; v_out jsonb; t text; v_row uuid;
begin
  -- (a) every existing row unchanged; the new tables empty
  select jsonb_agg(b.schema_name || '.' || b.table_name) into v_bad from cu1_before b where b.fp is distinct from pg_temp.cu1_fp(b.schema_name, b.table_name);
  if v_bad is not null then raise exception 'cu1: content changed in %', v_bad; end if;
  foreach t in array private.cu1_backup_tables() loop
    execute format('select case when exists (select 1 from public.%I) then to_jsonb(%L::text) end', t, t) into v_bad;
    if v_bad is not null then raise exception 'cu1: % is not empty', t; end if;
  end loop;

  -- (b) the run record
  if not exists (select 1 from private.migration_runs r join cu1_ctx c on c.run_id = r.run_id where r.migration = 'cu1') then
    raise exception 'cu1: the run record does not hold this run';
  end if;
  if has_table_privilege('authenticated', 'private.migration_runs', 'select') or has_table_privilege('anon', 'private.migration_runs', 'select') then
    raise exception 'cu1: the run record is reachable by an application role';
  end if;

  -- (c) anon: no privilege on any app relation, column or function, nor the private schema
  select jsonb_agg(c.oid::regclass) into v_bad from pg_class c
  where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'v', 'm', 'S', 'f', 'p')
    and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update')
      or has_table_privilege('anon', c.oid, 'delete') or has_table_privilege('anon', c.oid, 'truncate')
      or has_table_privilege('anon', c.oid, 'references') or has_table_privilege('anon', c.oid, 'trigger')
      or exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                 and (has_column_privilege('anon', c.oid, a.attnum, 'select') or has_column_privilege('anon', c.oid, a.attnum, 'insert')
                      or has_column_privilege('anon', c.oid, a.attnum, 'update'))));
  if v_bad is not null then raise exception 'cu1: anon has privileges on %', v_bad; end if;
  select jsonb_agg(p.oid::regprocedure) into v_bad from pg_proc p
  where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and has_function_privilege('anon', p.oid, 'execute');
  if v_bad is not null then raise exception 'cu1: anon can execute %', v_bad; end if;
  if has_schema_privilege('anon', 'private', 'usage') then raise exception 'cu1: anon has usage on private'; end if;

  -- (d) authenticated: exactly the functions it had plus the new ones; no user_id writes, no truncate
  select jsonb_agg(f) into v_bad from (
    (select f from cu1_fn_before union select f from cu1_new_fns)
    except (select p.oid::regprocedure::text from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
            and has_function_privilege('authenticated', p.oid, 'execute'))) z;
  if v_bad is not null then raise exception 'cu1: authenticated can''t execute %', v_bad; end if;
  select jsonb_agg(f) into v_bad from (
    (select p.oid::regprocedure::text f from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
       and has_function_privilege('authenticated', p.oid, 'execute'))
    except (select f from cu1_fn_before union select f from cu1_new_fns)) z;
  if v_bad is not null then raise exception 'cu1: authenticated can execute unexpected functions %', v_bad; end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'restore_backup') <> 1 then
    raise exception 'cu1: more than one restore_backup signature in public';
  end if;
  foreach t in array private.cu1_backup_tables() loop
    if has_column_privilege('authenticated', ('public.' || t)::regclass, 'user_id', 'insert') or has_column_privilege('authenticated', ('public.' || t)::regclass, 'user_id', 'update')
       or has_table_privilege('authenticated', ('public.' || t)::regclass, 'truncate') or not has_table_privilege('authenticated', ('public.' || t)::regclass, 'select') then
      raise exception 'cu1: unexpected privileges on %', t;
    end if;
    -- (e) policies: RLS on, exactly M1's five
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception 'cu1: RLS is off on %', t; end if;
    if (select array_agg(policyname || ':' || cmd || ':' || permissive || ':' || array_to_string(roles, ',') order by policyname)
        from pg_policies where schemaname = 'public' and tablename = t)
       is distinct from array['members_only:ALL:RESTRICTIVE:authenticated', 'owner_delete:DELETE:PERMISSIVE:authenticated',
                              'owner_insert:INSERT:PERMISSIVE:authenticated', 'owner_select:SELECT:PERMISSIVE:authenticated',
                              'owner_update:UPDATE:PERMISSIVE:authenticated'] then
      raise exception 'cu1: unexpected policies on %', t;
    end if;
  end loop;
  if exists (select 1 from pg_policies where schemaname in ('public', 'private') and (roles && array['anon', 'public']::name[])) then
    raise exception 'cu1: a policy applies to anon or PUBLIC';
  end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-cu1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '7' then
    raise exception 'cu1: capability not updated';
  end if;

  -- (f) synthetic write checks for the first member (always rolled back): a TMDB show gets a season by
  -- reconciliation, the same season again is a no-op, its TBA date is filled, and an unmatched show takes an
  -- identity with its plain season mapped; a direct write to a CU1 table is refused.
  select m.user_id into v_owner from private.library_members m order by m.user_id limit 1;
  if v_owner is not null then
    select min(x) into v_tmdb from generate_series(2147470000, 2147470999) x
    where not exists (select 1 from public.tv_shows s where s.user_id = v_owner and s.tmdb_id in (x, x + 1));
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    begin
      v_out := public.library_create_show_b45(
        jsonb_build_object('tmdb_id', v_tmdb, 'title', 'ZZ CU1 Migration Check', 'show_key', 'zz cu1 migration check', 'network', 'ZZ'),
        jsonb_build_array(jsonb_build_object('item_key', 'zz cu1 migration check|season 1', 'title', 'ZZ CU1 Migration Check', 'season', 'Season 1',
          'theme', 'ZZ', 'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01', 'season_number', 1)));
      v_show := (v_out -> 'show' ->> 'id')::uuid;
      v_out := public.library_cu_reconcile_season(v_show, jsonb_build_object('tmdb_id', v_tmdb, 'show_key', 'zz cu1 migration check'),
        '{"season_number": 2, "display_date": "TBA", "date_sort": "2099-01-01", "episode_count": 8}',
        jsonb_build_object('source', 'tmdb', 'kind', 'new_season', 'fingerprint', 'new_season:' || repeat('a', 64), 'show_id', v_show));
      if v_out ->> 'outcome' <> 'applied' or v_out -> 'result' ->> 'outcome' <> 'created' then raise exception 'cu1-check: reconcile did not create: %', v_out; end if;
      v_row := (v_out -> 'result' ->> 'row_id')::uuid;
      v_out := public.library_cu_reconcile_season(v_show, jsonb_build_object('tmdb_id', v_tmdb, 'show_key', 'zz cu1 migration check'),
        '{"season_number": 2, "display_date": "TBA", "date_sort": "2099-01-01", "episode_count": 8}',
        jsonb_build_object('source', 'tmdb', 'kind', 'new_season', 'fingerprint', 'new_season:' || repeat('b', 64), 'show_id', v_show));
      if v_out -> 'result' ->> 'outcome' <> 'existing' then raise exception 'cu1-check: a second reconcile was not a no-op: %', v_out; end if;
      v_out := public.library_cu_set_season_date(v_row, '{"display_date": "TBA", "date_sort": "2099-01-01"}', '{"display_date": "Jan 1, 2099", "date_sort": "2099-01-01"}',
        jsonb_build_object('source', 'tmdb', 'kind', 'date', 'fingerprint', 'date:' || repeat('c', 64), 'show_id', v_show, 'season_id', v_row));
      if v_out ->> 'outcome' <> 'applied' or (select display_date from public.watchlist_items where id = v_row) <> 'Jan 1, 2099' then
        raise exception 'cu1-check: the TBA date was not filled: %', v_out;
      end if;
      v_out := public.library_create_show_b45(jsonb_build_object('title', 'ZZ CU1 Unmatched Check', 'show_key', 'zz cu1 unmatched check', 'network', 'ZZ'),
        jsonb_build_array(jsonb_build_object('item_key', 'zz cu1 unmatched check|season 1', 'title', 'ZZ CU1 Unmatched Check', 'season', 'Season 1',
          'theme', 'ZZ', 'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01')));
      v_show2 := (v_out -> 'show' ->> 'id')::uuid;
      v_out := public.library_cu_attach_identity(v_show2, '{"title": "ZZ CU1 Unmatched Check", "show_key": "zz cu1 unmatched check"}', v_tmdb + 1, '[1]',
        jsonb_build_object('source', 'tmdb', 'kind', 'identity', 'fingerprint', 'identity:' || repeat('d', 64), 'show_id', v_show2,
          'subject', jsonb_build_object('tmdb_id', v_tmdb + 1, 'tmdb_title', 'ZZ CU1 Unmatched Check')));
      if v_out ->> 'outcome' <> 'applied' or jsonb_array_length(v_out -> 'result' -> 'mapped') <> 1 then raise exception 'cu1-check: identity not attached: %', v_out; end if;
      perform set_config('watchlist.library_write', '', true);
      begin
        insert into public.update_setup (source) values ('setup_file');
        raise exception 'cu1-check: a direct write to update_setup succeeded';
      exception when raise_exception then
        if sqlerrm !~ '^library_write_required: ' then raise; end if;
      end;
      raise exception 'cu1-rollback';
    exception when raise_exception then
      if sqlerrm <> 'cu1-rollback' then raise; end if;
    end;
    perform set_config('role', 'none', true);
    insert into cu1_checked values (true);
  end if;
  perform set_config('request.jwt.claims', '', true);

  -- (a) again, after the simulated writes
  select jsonb_agg(b.schema_name || '.' || b.table_name) into v_bad from cu1_before b where b.fp is distinct from pg_temp.cu1_fp(b.schema_name, b.table_name);
  if v_bad is not null then raise exception 'cu1: content changed in % (after the checks)', v_bad; end if;
  foreach t in array private.cu1_backup_tables() loop
    execute format('select case when exists (select 1 from public.%I) then to_jsonb(%L::text) end', t, t) into v_bad;
    if v_bad is not null then raise exception 'cu1: % is not empty (after the checks)', t; end if;
  end loop;
end $$;

select 'CU1|' || json_build_object('run', (select run_id from cu1_ctx), 'checked_writes', exists (select 1 from cu1_checked)) as result;

notify pgrst, 'reload schema';
commit;
