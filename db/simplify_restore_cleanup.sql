-- One flat restore, and the retired database objects removed. One transaction, run as postgres on a contracted-cu1 database.
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.simplify_run', '<a fresh run id, recorded before running>', false);
-- Before running it in production: export the recovery archive privately with db/simplify_preflight.sql. A library backup doesn't hold it.
--
-- Section 2 replaces public.restore_backup, same signature and grants, with one function over all nineteen tables, and drops the chain
-- behind it: private.restore_backup_v5, _v6, _v7 and their two helpers. Accepted files are the same, with two intended differences:
--   * `conversion` and `recovery` sections are accepted and ignored in any shape. The archive they fed goes in section 3. The page and the
--     admin tool leave them out, and `p_allow_v1_reset` stays unused.
--   * an id in an eight-table row must be spelled as a uuid is exported, as the other eleven tables already required. The page refuses
--     anything else itself.
-- Section 3 drops functions nothing can reach any more (stubs for old pages, the retired catalog and rollback functions, the two dismissal
-- functions) and the archive and rollback tables. A tab open from before these pages keeps working until a removed dismissal call fails, then stops writing until reloaded.
-- To keep the old chain, omit section 2 and the restore names from section 4; section 3's archive tables and rollback report then stay too.
--
-- Installing changes no library row, and section 4 checks that. Running restore later replaces a library: reinstalling an older function
-- wouldn't repair one restored wrongly, which is why the safety backup comes first and the page verifies afterwards. No phase, capability
-- shape or backup-format change; stage5_capabilities() answers recovery_archive = 'retired' because the archive is gone.
--
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate execution). Never rerun to
-- find out; a rerun is refused once this committed. No rollback (fix-forward); earlier definitions are in git.
begin;
select set_config('application_name', 'watchlist-simplify-' || coalesce(nullif(current_setting('watchlist.simplify_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;
do $$
begin
  if exists (select 1 from private.migration_runs r where r.migration = 'simplify') then raise exception 'simplify: already installed; nothing was changed'; end if;
end $$;
lock table private.stage5_recovery_records, private.stage5_recovery_collections, private.stage5_recovery_othertv,
  private.stage5_recovery_meta, private.b45_meta, private.b45_saved in access exclusive mode;
lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships, public.watch_with_choices,
  public.custom_collections, public.catalog_show_links, public.catalog_film_links, public.episode_marks, public.update_setup,
  public.collection_definitions, public.collection_exclusions, public.update_holds, public.record_aliases, public.membership_removals,
  public.show_update_settings, public.research_briefs, public.research_imports, public.update_findings in share row exclusive mode;

-- ── 1. Preconditions and the before-state ─────────────────────────────────────
create temp table simplify_tables (t text primary key) on commit drop;
insert into simplify_tables values ('private.library_members'), ('public.tv_shows'), ('public.watchlist_items'), ('public.personal_collections'),
  ('public.collection_memberships'), ('public.watch_with_choices'), ('public.custom_collections'), ('public.catalog_show_links'),
  ('public.catalog_film_links'), ('public.episode_marks'), ('public.update_setup'), ('public.collection_definitions'),
  ('public.collection_exclusions'), ('public.update_holds'), ('public.record_aliases'), ('public.membership_removals'),
  ('public.show_update_settings'), ('public.research_briefs'), ('public.research_imports'), ('public.update_findings');
create or replace function pg_temp.simplify_fp() returns text language plpgsql as $$
declare r record; v text; v_all text := '';
begin
  for r in select t from simplify_tables order by t loop
    execute format('select coalesce(md5(string_agg(md5(x::text), '','' order by md5(x::text))), '''') from %s x', r.t) into v;
    v_all := v_all || r.t || ':' || v || ';';
  end loop;
  return md5(v_all);
end $$;
create temp table simplify_ctx on commit drop as
select nullif(current_setting('watchlist.simplify_run', true), '') as run_id, pg_temp.simplify_fp() as library_before;
do $$
declare c record;
begin
  select * into c from simplify_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'simplify: set watchlist.simplify_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'simplify: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-cu1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '7' then
    raise exception 'simplify: expected phase contracted-cu1 with backup format 7; nothing was changed';
  end if;
  -- What the new function relies on: the research guard's flag, and the chain it replaces.
  if to_regprocedure('private.research_write_guard()') is null or to_regprocedure('private.restore_backup_v7(jsonb, boolean)') is null
     or (select prosrc from pg_proc where oid = 'public.restore_backup(jsonb, boolean)'::regprocedure) !~ 'private\.restore_backup_v7' then
    raise exception 'simplify: public.restore_backup is not the wrapper around private.restore_backup_v7; nothing was changed';
  end if;
end $$;

-- ── 2. The restore ─────────────────────────────────────────────────────────────
-- One function for all nineteen tables: refuse what can't be a format-7 library, replace the caller's rows in one transaction, then compare
-- the final state with the file. Formats 5 and 6 are converted in the page or the admin tool first. Row security and the owner's id scope
-- every delete and check; user_id isn't in a file, so every insert takes the caller by default. An id held by another account stops at the
-- primary key, which sees rows row security hides; the composite foreign keys keep every reference inside the caller's library.
create or replace function public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean default false)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_version text := p_backup ->> 'formatVersion';
  v_tables jsonb := p_backup -> 'tables';
  v_counts jsonb := p_backup -> 'rowCounts';
  -- Every table of a format-7 backup, references first, with its columns.
  v_spec text[][] := array[
    ['watch_with_choices', 'id uuid, token text, label text, sort_order integer, archived_at timestamptz, created_at timestamptz'],
    ['personal_collections', 'id uuid, name text, catalog_id text, presentation_key text, sort_order integer, archived_at timestamptz, created_at timestamptz'],
    ['tv_shows', 'id uuid, title text, show_key text, tmdb_id integer, status text, created_at timestamptz, priority text, ended boolean, catalog_new boolean, status_review boolean, legacy_status text, genres text[], forms text[], franchises text[], companies text[], genre_candidates text[], network text, network_candidates text[], metadata_owner_set boolean, resume_start_season_id uuid, resume_end_season_id uuid'],
    ['watchlist_items', 'id uuid, item_key text, title text, season text, theme text, theme_kind text, display_date text, date_sort text, watched boolean, status text, created_at timestamptz, watch_with text[], collections text[], tmdb_collection_id integer, tmdb_collection_name text, media_type text, tmdb_id integer, season_number integer, show_id uuid, skipped boolean, priority text, catalog_new boolean, status_review boolean, legacy_status text, genres text[], forms text[], franchises text[], companies text[], genre_candidates text[], metadata_owner_set boolean'],
    ['custom_collections', 'id uuid, name text, tmdb_person_id integer, created_at timestamptz, role text'],
    ['collection_memberships', 'id uuid, collection_id uuid, show_id uuid, item_id uuid, created_at timestamptz'],
    ['catalog_show_links', 'id uuid, catalog text, catalog_key text, show_id uuid, origin text, created_at timestamptz'],
    ['catalog_film_links', 'id uuid, catalog text, entry_key text, item_id uuid, origin text, created_at timestamptz'],
    ['episode_marks', 'id uuid, season_id uuid, tmdb_episode_id integer, episode_number integer'],
    ['update_setup', 'id uuid, setup_confirmed_at timestamptz, source text'],
    ['collection_definitions', 'id uuid, collection_id uuid, version integer, mode text, rules jsonb, evidence jsonb, summary text, rule_hashes jsonb, evidence_hash text, confirmed_at timestamptz'],
    ['collection_exclusions', 'id uuid, collection_id uuid, kind text, title text, match_text text, tmdb_id integer, media text, note text, created_at timestamptz'],
    ['update_holds', 'id uuid, kind text, collection_id uuid, show_id uuid, item_id uuid, subject_label text, field text, protected_value text, decision text, effect text, reopen jsonb, decided_on date, created_at timestamptz'],
    ['record_aliases', 'id uuid, show_id uuid, item_id uuid, alias text, match_text text, evidence jsonb, created_at timestamptz'],
    ['membership_removals', 'id uuid, collection_id uuid, show_id uuid, item_id uuid, removed_at timestamptz'],
    ['show_update_settings', 'id uuid, show_id uuid, follow_when_skipped boolean, new_season_after_ended_at timestamptz, updated_at timestamptz'],
    ['research_briefs', 'id uuid, exported_at timestamptz, collections jsonb, checks jsonb'],
    ['research_imports', 'id uuid, brief_id uuid, file_sha256 text, imported_at timestamptz, counts jsonb'],
    ['update_findings', 'id uuid, fingerprint text, source text, kind text, status text, reason text, collection_id uuid, show_id uuid, item_id uuid, season_id uuid, subject jsonb, proposed jsonb, expected jsonb, evidence jsonb, assessment jsonb, rule_id text, definition_version integer, rule_hash text, evidence_hash text, brief_id uuid, first_seen_at timestamptz, last_seen_at timestamptz, decided_at timestamptz, applied_at timestamptz, result jsonb']];
  v_restored jsonb := '{}';
  t text; v_cols text; v_names text; v_keys text[]; v_k int; v_same boolean; v_detail text; i int;
begin
  if p_backup ->> 'format' is distinct from 'watchlist-tracker-backup' then
    raise exception 'restore_invalid: not a Watchlist backup' using errcode = '22023';
  end if;
  if v_version in ('1', '2', '3', '4') then
    raise exception 'restore_invalid: format % backups can no longer be restored; nothing was changed', v_version using errcode = '22023';
  elsif v_version in ('5', '6') then
    raise exception 'restore_invalid: format % backups are converted in the page first; nothing was changed', v_version using errcode = '22023';
  elsif v_version is distinct from '7' then
    raise exception 'restore_invalid: unsupported backup format %', coalesce(v_version, '(none)') using errcode = '22023';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_backup) k)
     <@ array['conversion', 'exportedAt', 'format', 'formatVersion', 'recovery', 'rowCounts', 'tables']::text[] is not true then
    raise exception 'restore_invalid: unexpected top-level fields' using errcode = '22023';
  end if;
  if jsonb_typeof(v_tables) is distinct from 'object' or jsonb_typeof(v_counts) is distinct from 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(v_tables) k)
        is distinct from (select array_agg(v_spec[n][1] order by v_spec[n][1] collate "C") from generate_subscripts(v_spec, 1) n) then
    raise exception 'restore_invalid: unexpected set of tables for format 7' using errcode = '22023';
  end if;
  for i in 1 .. array_length(v_spec, 1) loop
    t := v_spec[i][1];
    if jsonb_typeof(v_tables -> t) is distinct from 'array' then raise exception 'restore_invalid: % is not a list of rows', t using errcode = '22023'; end if;
    if (v_counts ->> t) is distinct from jsonb_array_length(v_tables -> t)::text then
      raise exception 'restore_invalid: rowCounts.% does not match its rows', t using errcode = '22023';
    end if;
    v_keys := array(select k from (select split_part(c, ' ', 1) k from unnest(string_to_array(v_spec[i][2], ', ')) c) q order by k collate "C");
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

  perform set_config('lock_timeout', '5s', true);
  lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
    public.watch_with_choices, public.custom_collections in exclusive mode;
  perform private.lib_write_on();
  -- Restoring saved data isn't a research operation (private.research_write_guard). Cleared below; a failure discards it with the transaction.
  perform set_config('watchlist.research_restore', 'on', true);

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
  delete from public.collection_memberships where user_id = v_owner;
  -- (the ranges come back from the file)
  update public.tv_shows set resume_start_season_id = null, resume_end_season_id = null
  where user_id = v_owner and resume_start_season_id is not null;
  delete from public.watchlist_items where user_id = v_owner; -- episode marks and film links go with these
  delete from public.tv_shows where user_id = v_owner;        -- and show links with these
  delete from public.personal_collections where user_id = v_owner;
  delete from public.watch_with_choices where user_id = v_owner;
  delete from public.custom_collections where user_id = v_owner;

  begin
    -- (whatever the session's mode: shows name seasons inserted after them)
    set constraints public.tv_shows_resume_start_fkey, public.tv_shows_resume_end_fkey deferred;
    for i in 1 .. array_length(v_spec, 1) loop
      t := v_spec[i][1]; v_cols := v_spec[i][2];
      v_names := (select string_agg(split_part(c, ' ', 1), ', ') from unnest(string_to_array(v_cols, ', ')) c);
      execute format('insert into public.%I (%s) select %s from jsonb_to_recordset($1) as x(%s)', t, v_names, v_names, v_cols) using v_tables -> t;
      get diagnostics v_k = row_count;
      v_restored := v_restored || jsonb_build_object(t, v_k);
    end loop;
    set constraints public.tv_shows_resume_start_fkey, public.tv_shows_resume_end_fkey immediate;
  exception
    when unique_violation then
      get stacked diagnostics v_detail = constraint_name;
      if v_detail like '%\_pkey' or v_detail like '%\_id\_key' then
        raise exception 'restore_id_collision: this backup contains ids already owned by another user; restoring it would keep those ids and break user isolation, so nothing was changed'
          using errcode = '23505';
      end if;
      raise exception 'restore_invalid: the backup repeats a % row (%), so nothing was changed', t, v_detail using errcode = '22023';
    when foreign_key_violation then
      get stacked diagnostics v_detail = constraint_name;
      raise exception 'restore_invalid: a row in the backup points at something that isn''t in it or has the wrong kind (%), so nothing was changed', v_detail using errcode = '22023';
    when check_violation or not_null_violation or raise_exception or invalid_text_representation or numeric_value_out_of_range
         or datetime_field_overflow or invalid_datetime_format then
      get stacked diagnostics v_detail = message_text;
      raise exception 'restore_invalid: a % row in the backup breaks a rule (%), so nothing was changed', t, v_detail using errcode = '22023';
  end;

  -- The final state, every field of every table, after every insert and trigger: this owner has exactly the file's rows. The ids are unique,
  -- so equal counts and no file row missing mean the two sets are equal.
  for i in 1 .. array_length(v_spec, 1) loop
    t := v_spec[i][1]; v_cols := v_spec[i][2];
    v_names := (select string_agg(split_part(c, ' ', 1), ', ') from unnest(string_to_array(v_cols, ', ')) c);
    execute format('select (select count(*) from public.%I where user_id = $2) = jsonb_array_length($1) and not exists (select %s from jsonb_to_recordset($1) as x(%s) except select %s from public.%I where user_id = $2)',
      t, v_names, v_cols, v_names, t) into v_same using v_tables -> t, v_owner;
    if not v_same then raise exception 'restore_invalid: the restored % differ from the backup, so nothing was changed', t using errcode = '22023'; end if;
  end loop;

  perform set_config('watchlist.research_restore', '', true);
  return jsonb_build_object('formatVersion', 7, 'restored', v_restored);
end $$;

drop function private.restore_backup_v7(jsonb, boolean);
drop function private.restore_backup_v6(jsonb, boolean);
drop function private.restore_backup_v5(jsonb, boolean);
drop function private.cu1_backup_columns();
drop function private.cu1_backup_tables();

-- ── 3. Dormant functions and the archive ───────────────────────────────────────
-- No cascade: anything still depending on one of these stops the migration. The admin enrichment functions stay, and
-- public.org_capabilities stays for the Manage dialog.
drop function public.add_tv_seasons(text, jsonb, jsonb);
drop function public.add_tv_seasons_to_show(uuid, jsonb, jsonb);
drop function public.catalog_apply(text, jsonb, text);
drop function public.create_tv_show(jsonb, jsonb);
drop function public.library_add_films(jsonb);
drop function public.library_add_seasons(uuid, jsonb, jsonb);
drop function public.library_catalog_apply(text, jsonb, text);
drop function public.library_catalog_apply_b45(text, jsonb, text);
drop function public.library_create_film(jsonb);
drop function public.library_create_show(jsonb, jsonb);
drop function public.library_dismiss_catalog_new_b45(jsonb);
drop function public.library_dismiss_review_b45(text, uuid, jsonb);
drop function public.library_match_film(uuid, jsonb, jsonb);
drop function public.library_match_season(uuid, jsonb, jsonb, jsonb);
drop function public.match_tv_row(uuid, jsonb, jsonb, jsonb);
drop function public.seed_tv_defaults(text, jsonb);
drop function public.set_show_status(uuid, text);
drop function private.b45_rollback_report();
drop function private.b45_inverse(text, text, text, boolean, boolean, boolean, text);
drop function private.b45_inventory();
drop function private.b45_schema();
drop function private.catalog_run5(text, jsonb);
drop function private.catalog_run_b45(text, jsonb);
drop function private.catalog_hash(jsonb);
drop function private.catalog_canon(jsonb);
drop function private.lib_catalog_candidates(uuid, text, text, text, text);
drop function private.lib_catalog_insert(uuid, text, jsonb);
drop function private.lib_catalog_insert_b45(uuid, text, jsonb);
drop function private.lib_catalog_insert_v5(uuid, text, jsonb);
drop function private.lib_catalog_lock();
drop function private.lib_catalog_target(uuid, text);
drop function private.lib_catalogs();
drop function private.lib_insert_film(uuid, jsonb, text);
drop function private.lib_match_season_core(public.watchlist_items, jsonb, jsonb, jsonb);
drop function private.lib_set_theme_kind(uuid, text);
drop function private.tv_shadow_resync(uuid);

drop table private.stage5_recovery_records;
drop table private.stage5_recovery_collections;
drop table private.stage5_recovery_othertv;
drop table private.stage5_recovery_meta;
drop table private.b45_meta;
drop table private.b45_saved;

-- ── 4. Self-check and the run record ───────────────────────────────────────────
insert into private.migration_runs (run_id, migration) select run_id, 'simplify' from simplify_ctx;
do $$
declare c record; v_left text;
begin
  select * into c from simplify_ctx;
  -- No function or trigger left names anything dropped above: a plpgsql body isn't tracked as a dependency, so read the sources.
  select string_agg(n.nspname || '.' || p.proname, ', ') into v_left from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.prosrc ~ '\m(restore_backup_v[567]|cu1_backup_columns|cu1_backup_tables|stage5_recovery_(records|collections|othertv)|b45_meta|b45_saved|b45_rollback_report|b45_inverse|b45_inventory|b45_schema|catalog_run5|catalog_run_b45|catalog_hash|catalog_canon|lib_catalog_candidates|lib_catalog_insert|lib_catalog_insert_b45|lib_catalog_insert_v5|lib_catalog_lock|lib_catalog_target|lib_catalogs|lib_insert_film|lib_match_season_core|lib_set_theme_kind|tv_shadow_resync|library_dismiss_catalog_new_b45|library_dismiss_review_b45)\M';
  if v_left is not null then raise exception 'simplify: still named by %', v_left; end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'restore_backup') <> 1
     or (select prosecdef from pg_proc where oid = 'public.restore_backup(jsonb, boolean)'::regprocedure)
     or not has_function_privilege('authenticated', 'public.restore_backup(jsonb, boolean)', 'execute')
     or has_function_privilege('anon', 'public.restore_backup(jsonb, boolean)', 'execute')
     or to_regprocedure('public.org_capabilities()') is null then
    raise exception 'simplify: restore_backup or org_capabilities is not as designed';
  end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-cu1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '7'
     or public.stage5_capabilities() ->> 'recovery_archive' is distinct from 'retired' then
    raise exception 'simplify: the capability changed: %', public.stage5_capabilities();
  end if;
  if pg_temp.simplify_fp() is distinct from c.library_before then raise exception 'simplify: a library row or a membership changed'; end if;
end $$;

select 'SIMPLIFY|' || json_build_object('run', (select run_id from simplify_ctx)) as result;

notify pgrst, 'reload schema';
commit;
