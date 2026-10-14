-- Rollback of B4/B5 Batch A (db/b45_expand.sql) to the contracted Stage 5c state, in one
-- transaction. Run as postgres, only with a separately approved report:
--   1. P1: a validated format-5 backup made by the B45 page (its file SHA-256 recorded);
--   2. dry run: db/rollback/b45_report.sql gives the report and its SHA-256; the report's
--      backup_digests are compared with the P1 file (they must be equal: the backup is of
--      the state being rolled back);
--   3. approval of one token binding the report SHA-256, the P1 file's SHA-256 and the loss
--      acceptance: tools/b45-backup-digest.mjs <P1 file> --report <dry-run output> [--lossy]
--      checks that the file is of the reported state and prints the token to approve;
--   4. this script, preceded in the same run by the preamble that tool prints only when given
--      the approved token (--approval <token>) and the same P1 file (it refuses a file whose
--      SHA-256 isn't the approved one):
--        select set_config('watchlist.b45_rollback_approved', '<report sha256>', false),
--               set_config('watchlist.b45_rollback_lossy', 'accepted' | '', false),
--               set_config('watchlist.b45_rollback_p1_sha256', '<P1 file sha256>', false),
--               set_config('watchlist.b45_rollback_p1_digests', '<the P1 file''s backup digests (JSON)>', false),
--               set_config('watchlist.b45_rollback_approval', '<the approved token>', false),
--               set_config('watchlist.b45_rollback_baseline_md5', '<md5 of the pre-B45 inventory captured read-only at GA-2>', false);
--      The token is sha256('b45-rollback-approval|<report sha256>|<P1 sha256>|<accepted or empty>').
-- It takes the full lock set, recomputes the report under lock and refuses before any
-- change unless its SHA-256 equals the approved one (any change to any column of any row
-- of the 12 tables, to the inventory or to the capability since the dry run refuses), and
-- unless the stored baseline is the one named, the approval token is the one for that report,
-- that P1 file hash and that loss acceptance, and the state's backup digests equal the P1
-- file's (the approved file is a backup of exactly this state). Then it projects every status (exactly where
-- provenance or plain values allow, by the reported projection otherwise), removes every
-- B45 object, reinstalls the definitions B45 replaced, and verifies that the function and
-- trigger inventory and the schema equal the pre-B45 baseline, that every Stage 5c column
-- of every row keeps its pre-rollback value, and that every status equals the report.
-- After it: the database is contracted 5c exactly as before B45 (the pinned
-- db/rollback/phase5c.sql applies again, under D2's own approvals).
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regprocedure('public.stage5_capabilities()') is null or public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-b45' then
    raise exception 'b45 rollback: B4/B5 Batch A is not installed (phase %); nothing was changed', public.stage5_capabilities() ->> 'phase';
  end if;
  if to_regclass('private.b45_meta') is null then
    raise exception 'b45 rollback: the restore points are missing; nothing was changed';
  end if;
  if coalesce(current_setting('watchlist.b45_rollback_approved', true), '') !~ '^[0-9a-f]{64}$' then
    raise exception 'b45 rollback: no approved report (watchlist.b45_rollback_approved); nothing was changed';
  end if;
  if coalesce(current_setting('watchlist.b45_rollback_baseline_md5', true), '') is distinct from (select md5(baseline_inventory::text) from private.b45_meta) then
    raise exception 'b45 rollback: the stored pre-B45 baseline is not the one named (watchlist.b45_rollback_baseline_md5); nothing was changed';
  end if;
  -- The approval binds the report, the exact P1 file and the loss acceptance (one token).
  if coalesce(current_setting('watchlist.b45_rollback_p1_sha256', true), '') !~ '^[0-9a-f]{64}$' then
    raise exception 'b45 rollback: no P1 backup file hash (watchlist.b45_rollback_p1_sha256); nothing was changed';
  end if;
  if coalesce(current_setting('watchlist.b45_rollback_p1_digests', true), '') = '' then
    raise exception 'b45 rollback: no P1 backup digests (watchlist.b45_rollback_p1_digests); nothing was changed';
  end if;
  if coalesce(current_setting('watchlist.b45_rollback_approval', true), '') is distinct from encode(sha256(convert_to('b45-rollback-approval|'
       || current_setting('watchlist.b45_rollback_approved', true) || '|' || current_setting('watchlist.b45_rollback_p1_sha256', true) || '|'
       || coalesce(current_setting('watchlist.b45_rollback_lossy', true), ''), 'UTF8')), 'hex') then
    raise exception 'b45 rollback: the approval doesn''t name this report, this P1 backup file and this loss acceptance; nothing was changed';
  end if;
end $$;

lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
  public.watch_with_choices, public.custom_collections, public.catalog_show_links, public.catalog_film_links in exclusive mode;
lock table private.stage5_recovery_records, private.stage5_recovery_collections, private.stage5_recovery_othertv,
  private.stage5_recovery_meta in exclusive mode;
lock table private.b45_meta, private.b45_saved in exclusive mode;

-- ── The report, under lock, bound to the approval ────────────────────────────
create temp table b45rb_report on commit preserve rows as select private.b45_rollback_report() as report;
do $$
declare v jsonb := (select report from b45rb_report); v_hash text;
begin
  v_hash := encode(sha256(convert_to(v::text, 'UTF8')), 'hex');
  if v_hash is distinct from current_setting('watchlist.b45_rollback_approved', true) then
    raise exception 'b45 rollback: the state differs from the approved report (approved %, now %); nothing was changed',
      current_setting('watchlist.b45_rollback_approved', true), v_hash;
  end if;
  if (v ->> 'lossy')::int > 0 and coalesce(current_setting('watchlist.b45_rollback_lossy', true), '') <> 'accepted' then
    raise exception 'b45 rollback: the report lists % projected or discarded values and their loss is not accepted; nothing was changed', v ->> 'lossy';
  end if;
  -- The approved P1 file is a backup of exactly this state (its digests, computed by the tool
  -- from the file whose hash was approved, equal the state's under lock).
  if (v -> 'backup_digests') is distinct from current_setting('watchlist.b45_rollback_p1_digests', true)::jsonb then
    raise exception 'b45 rollback: the approved P1 backup file is not a backup of this state; nothing was changed';
  end if;
end $$;

-- What must survive: every Stage 5c column of every row (statuses checked separately).
create temp table b45rb_before on commit drop as
select
  (select md5(coalesce(string_agg((to_jsonb(t) - 'status' - 'priority' - 'ended' - 'catalog_new' - 'status_review' - 'legacy_status' - 'genres'
      - 'forms' - 'franchises' - 'companies' - 'genre_candidates' - 'network' - 'network_candidates' - 'metadata_owner_set'
      - 'resume_start_season_id' - 'resume_end_season_id')::text, '|' order by t.id), '')) from public.tv_shows t) shows,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'status' - 'priority' - 'catalog_new' - 'status_review' - 'legacy_status' - 'genres'
      - 'forms' - 'franchises' - 'companies' - 'genre_candidates' - 'metadata_owner_set')::text, '|' order by t.id), '')) from public.watchlist_items t) items,
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
-- Every record's rollback status (the report's projection, tier by tier).
create temp table b45rb_status on commit drop as
select 'show'::text kind, s.id, private.b45_inverse('show', s.status, s.priority, s.ended, s.catalog_new, s.status_review, s.legacy_status) ->> 'status' status
from public.tv_shows s
union all
select 'film', w.id, private.b45_inverse('film', w.status, w.priority, null, w.catalog_new, w.status_review, w.legacy_status) ->> 'status'
from public.watchlist_items w where w.is_film;
create temp table b45rb_saved on commit drop as select * from private.b45_saved;
create temp table b45rb_baseline on commit drop as select baseline_inventory, baseline_schema from private.b45_meta;

-- ── The B45 objects go ───────────────────────────────────────────────────────
drop trigger tv_shows_b45_guard on public.tv_shows;
drop trigger watchlist_items_b45_guard on public.watchlist_items;
drop trigger watchlist_items_resume_cleanup on public.watchlist_items;
alter table public.tv_shows drop constraint tv_shows_status_check;
alter table public.watchlist_items drop constraint watchlist_items_b45_film_check;
update public.tv_shows s set status = x.status from b45rb_status x where x.kind = 'show' and x.id = s.id and s.status is distinct from x.status;
update public.watchlist_items w set status = x.status from b45rb_status x where x.kind = 'film' and x.id = w.id and w.status is distinct from x.status;
do $$ begin
  execute 'alter table public.tv_shows add constraint tv_shows_status_check ' ||
    (select definition from b45rb_saved where kind = 'constraint' and name = 'tv_shows_status_check');
end $$;
alter table public.tv_shows drop constraint tv_shows_resume_start_fkey, drop constraint tv_shows_resume_end_fkey;
drop index public.tv_shows_resume_start_idx;
drop index public.tv_shows_resume_end_idx;
drop index public.watchlist_items_id_show_owner_key;
alter table public.tv_shows
  drop column priority, drop column ended, drop column catalog_new, drop column status_review, drop column legacy_status,
  drop column genres, drop column forms, drop column franchises, drop column companies, drop column genre_candidates,
  drop column network, drop column network_candidates, drop column metadata_owner_set,
  drop column resume_start_season_id, drop column resume_end_season_id;
alter table public.watchlist_items
  drop column priority, drop column catalog_new, drop column status_review, drop column legacy_status,
  drop column genres, drop column forms, drop column franchises, drop column companies, drop column genre_candidates,
  drop column metadata_owner_set;

-- The definitions B45 replaced, exactly as they were (create or replace keeps their grants).
do $$
declare d record;
begin
  for d in select name, definition from b45rb_saved where kind = 'function' order by name loop
    execute d.definition;
  end loop;
end $$;
-- Every function B45 added (anything not in the baseline), except the two that verify below.
do $$
declare f record;
begin
  -- (signatures rendered as private.b45_inventory renders them: with an empty search_path)
  perform set_config('search_path', '', true);
  for f in select p.oid::regprocedure sig, n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' k
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.prokind = 'f'
             and p.oid not in ('private.b45_inventory()'::regprocedure, 'private.b45_schema()'::regprocedure) loop
    if not ((select baseline_inventory from b45rb_baseline) -> 'functions' ? f.k) then
      execute format('drop function %s', f.sig);
    end if;
  end loop;
end $$;

-- ── Verify before commit ─────────────────────────────────────────────────────
do $$
declare b record; a record; v_inv jsonb; v_base jsonb := (select baseline_inventory from b45rb_baseline); v_bad jsonb;
begin
  v_inv := private.b45_inventory() #- '{functions,private.b45_inventory()}' #- '{functions,private.b45_schema()}';
  if v_inv is distinct from v_base then
    select jsonb_strip_nulls(jsonb_build_object(
      'missing', (select jsonb_agg(k) from jsonb_object_keys(v_base -> 'functions') k where not ((v_inv -> 'functions') ? k)),
      'extra', (select jsonb_agg(k) from jsonb_object_keys(v_inv -> 'functions') k where not ((v_base -> 'functions') ? k)),
      'changed', (select jsonb_agg(k) from jsonb_object_keys(v_base -> 'functions') k
                  where (v_inv -> 'functions') ? k and (v_inv -> 'functions' -> k) is distinct from (v_base -> 'functions' -> k)),
      'triggers', case when (v_inv -> 'triggers') is distinct from (v_base -> 'triggers') then true end,
      'stage', case when (v_inv -> 'stage') is distinct from (v_base -> 'stage') then true end)) into v_bad;
    raise exception 'b45 rollback: the restored inventory differs from the pre-B45 baseline: %', v_bad;
  end if;
  if private.b45_schema() is distinct from (select baseline_schema from b45rb_baseline) then
    raise exception 'b45 rollback: the restored schema differs from the pre-B45 baseline';
  end if;
  select * into b from b45rb_before;
  select
    (select md5(coalesce(string_agg((to_jsonb(t) - 'status')::text, '|' order by t.id), '')) from public.tv_shows t) shows,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'status')::text, '|' order by t.id), '')) from public.watchlist_items t) items,
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
  if a is distinct from b then raise exception 'b45 rollback: a preserved value changed (before %, after %)', row_to_json(b), row_to_json(a); end if;
  if exists (select 1 from b45rb_status x left join public.tv_shows s on x.kind = 'show' and s.id = x.id
             left join public.watchlist_items w on x.kind = 'film' and w.id = x.id
             where coalesce(s.status, w.status) is distinct from x.status) then
    raise exception 'b45 rollback: a status differs from the report';
  end if;
  if public.stage5_capabilities() ->> 'phase' <> 'contracted' then raise exception 'b45 rollback: the capability was not restored'; end if;
end $$;

drop function private.b45_inventory();
drop function private.b45_schema();
drop table private.b45_meta;
drop table private.b45_saved;
select set_config('watchlist.b45_rollback_approved', '', false), set_config('watchlist.b45_rollback_lossy', '', false),
  set_config('watchlist.b45_rollback_baseline_md5', '', false), set_config('watchlist.b45_rollback_p1_sha256', '', false),
  set_config('watchlist.b45_rollback_p1_digests', '', false), set_config('watchlist.b45_rollback_approval', '', false);
notify pgrst, 'reload schema';
commit;
select report from b45rb_report;
