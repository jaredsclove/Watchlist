-- CU1c: date equivalence (item 4, after CU1). One transaction, run as postgres on a contracted-cu1 database.
-- Design: docs/ITEM4_DESIGN.md §4.4.
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.cu1c_run', '<a fresh run id, recorded before running>', false);
--
-- Replaces public.library_cu_set_season_date (same signature, grants and security mode) so that:
--   * an exact date is a full display date ("Jan 15, 2027") whose date_sort is that same, real calendar date
--     (private.cu1c_exact_date); TBA and every window are not exact and their date_sort is never compared;
--   * two exact dates within one calendar day are the same date: the finding is set aside with reason
--     same_date_within_one_day and the row keeps its date (TMDB and research, review included);
--   * a TMDB finding never changes a stored exact date without an owner review decision: it stays pending with
--     reason tmdb_date_differs (an owner's Apply in review still changes it when two or more days apart);
--   * everything else is unchanged: TBA or window to an exact date is filled automatically; qualified research
--     moves a future exact date (strictly after today) to another future date; the finding, expected-value,
--     research-gate, setup, hold and protected-value checks and the aired rule stay as they were.
-- No table, column, status, capability or backup-format change.
--
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate
-- execution). Never rerun to find out; a rerun is refused once this committed. No rollback (fix-forward);
-- db/test/cu1c_reverse.sql is for test environments only.
begin;
select set_config('application_name', 'watchlist-cu1c-' || coalesce(nullif(current_setting('watchlist.cu1c_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;
lock table public.update_findings, public.watchlist_items, public.update_holds in share row exclusive mode;

-- ── 1. Preconditions ───────────────────────────────────────────────────────────
create temp table cu1c_ctx on commit drop as
select nullif(current_setting('watchlist.cu1c_run', true), '') as run_id,
  (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.library_cu_set_season_date(uuid, jsonb, jsonb, jsonb, boolean)')) as fn_src,
  (select coalesce(array_to_string(proacl, ','), '') || ':' || prosecdef::text || ':' || coalesce(array_to_string(proconfig, ','), '')
   from pg_proc where oid = to_regprocedure('public.library_cu_set_season_date(uuid, jsonb, jsonb, jsonb, boolean)')) as fn_meta,
  (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.stage5_capabilities()')) as caps_src,
  (select md5(coalesce(string_agg(md5(x::text), ',' order by x.id), '')) from public.update_findings x) as findings_md5,
  (select md5(coalesce(string_agg(md5(x::text), ',' order by x.id), '')) from public.watchlist_items x) as items_md5,
  (select md5(coalesce(string_agg(md5(x::text), ',' order by x.id), '')) from public.update_holds x) as holds_md5;
do $$
declare c record;
begin
  select * into c from cu1c_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'cu1c: set watchlist.cu1c_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-cu1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '7' then
    raise exception 'cu1c: expected phase contracted-cu1 with backup format 7, found % / %; nothing was changed',
      public.stage5_capabilities() ->> 'phase', public.stage5_capabilities() ->> 'backup_format';
  end if;
  if not exists (select 1 from private.migration_runs where migration = 'cu1') then raise exception 'cu1c: CU1 has no run record; nothing was changed'; end if;
  if exists (select 1 from private.migration_runs where migration = 'cu1c') or to_regprocedure('private.cu1c_exact_date(text, text)') is not null then
    raise exception 'cu1c: already installed; nothing was changed';
  end if;
  if c.fn_src is distinct from 'b3d2acd388992f380ab97b217a0c8c8e' then
    raise exception 'cu1c: library_cu_set_season_date isn''t CU1''s version (source md5 %); nothing was changed', c.fn_src;
  end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'cu1c: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
end $$;

-- ── 2. Exact dates ─────────────────────────────────────────────────────────────
-- The date of an exact stored date, or null: the display is "Mon D, YYYY" (as the page writes it) and date_sort is
-- that same real calendar date (so "Feb 29, 2027" or a mismatched pair is not exact). TBA and windows are null.
create function private.cu1c_exact_date(p_display text, p_sort text) returns date
language plpgsql immutable set search_path = '' as $$
declare v date;
begin
  if coalesce(p_display, '') !~ '^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [1-9][0-9]?, [0-9]{4}$' or coalesce(p_sort, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  begin v := p_sort::date; exception when others then return null; end;
  if to_char(v, 'YYYY-MM-DD') <> p_sort or to_char(v, 'Mon') || ' ' || extract(day from v)::int || ', ' || to_char(v, 'YYYY') <> p_display then return null; end if;
  return v;
end $$;
revoke all on function private.cu1c_exact_date(text, text) from public, anon, authenticated;

-- ── 3. The guarded date path ───────────────────────────────────────────────────
-- Automatic: a stored TBA or window → an exact date; qualified research: a future exact date → another future exact
-- date. TMDB against an exact date, anything aired, a protected date or a standing decision: only by an owner review
-- decision (and its reopening condition). Two exact dates within a day: the same date (set aside, the stored date kept).
create or replace function public.library_cu_set_season_date(p_row_id uuid, p_expected jsonb, p_new jsonb, p_finding jsonb, p_review boolean default false)
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
  v_old date;
  v_new date;
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
  -- CU1c: two exact dates within a calendar day are the same date. The finding is set aside by this rule (not an
  -- owner decision) and the stored date stays, on review too, for TMDB and research alike.
  v_old := private.cu1c_exact_date(w.display_date, w.date_sort);
  v_new := private.cu1c_exact_date(p_new ->> 'display_date', p_new ->> 'date_sort');
  if v_old is not null and v_new is not null and abs(v_new - v_old) <= 1 then
    return private.cu1_finish(f.id, 'policy', 'set_aside', 'same_date_within_one_day', jsonb_build_object('outcome', 'kept', 'row_id', w.id,
      'stored', jsonb_build_object('display_date', w.display_date, 'date_sort', w.date_sort)));
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
  -- CU1c: TMDB never changes a stored exact date without an owner review decision.
  if f.source = 'tmdb' and v_old is not null and not p_review then return private.cu1_finish(f.id, 'policy', 'pending', 'tmdb_date_differs', null); end if;
  -- A stored TBA or window (not an exact date) is filled; an exact date still to come (strictly after today) follows
  -- qualified research to another future date. A window's date_sort is a guess and isn't compared.
  v_auto := (p_new ->> 'display_date') !~* 'tba' and (v_old is null
    or (v_old > v_today and private.cu1_date(p_new ->> 'date_sort') > v_today));
  if not v_auto and not p_review then return private.cu1_finish(f.id, 'policy', 'pending', 'date_needs_review', null); end if;
  perform set_config('watchlist.catalog_date_write', 'on', true);
  update public.watchlist_items set display_date = p_new ->> 'display_date', date_sort = p_new ->> 'date_sort' where id = w.id and user_id = v_owner;
  perform set_config('watchlist.catalog_date_write', '', true);
  return private.cu1_finish(f.id, 'applied', 'applied', '', jsonb_build_object('outcome', 'updated', 'row_id', w.id,
    'from', jsonb_build_object('display_date', w.display_date, 'date_sort', w.date_sort),
    'to', jsonb_build_object('display_date', p_new ->> 'display_date', 'date_sort', p_new ->> 'date_sort')));
end $$;

-- ── 4. The run record, then verify before commit ───────────────────────────────
insert into private.migration_runs (run_id, migration) select run_id, 'cu1c' from cu1c_ctx;
do $$
declare c record; f regprocedure := 'public.library_cu_set_season_date(uuid, jsonb, jsonb, jsonb, boolean)'::regprocedure;
begin
  select * into c from cu1c_ctx;
  if (select coalesce(array_to_string(proacl, ','), '') || ':' || prosecdef::text || ':' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = f) is distinct from c.fn_meta then
    raise exception 'cu1c: the date function''s grants, security mode or settings changed';
  end if;
  if (select md5(prosrc) from pg_proc where oid = f) = 'b3d2acd388992f380ab97b217a0c8c8e' then raise exception 'cu1c: the date function wasn''t replaced'; end if;
  if has_function_privilege('anon', f, 'execute') then raise exception 'cu1c: anon can execute the date function'; end if;
  if has_function_privilege('authenticated', 'private.cu1c_exact_date(text, text)'::regprocedure, 'execute')
     or has_function_privilege('anon', 'private.cu1c_exact_date(text, text)'::regprocedure, 'execute') then
    raise exception 'cu1c: an application role can execute private.cu1c_exact_date';
  end if;
  if (select md5(prosrc) from pg_proc where oid = 'public.stage5_capabilities()'::regprocedure) is distinct from c.caps_src then raise exception 'cu1c: the capability changed'; end if;
  if (select md5(coalesce(string_agg(md5(x::text), ',' order by x.id), '')) from public.update_findings x) is distinct from c.findings_md5
     or (select md5(coalesce(string_agg(md5(x::text), ',' order by x.id), '')) from public.watchlist_items x) is distinct from c.items_md5
     or (select md5(coalesce(string_agg(md5(x::text), ',' order by x.id), '')) from public.update_holds x) is distinct from c.holds_md5 then
    raise exception 'cu1c: a row changed';
  end if;
  -- The exact-date rule, on literals (no table touched).
  if private.cu1c_exact_date('Jan 15, 2027', '2027-01-15') is distinct from date '2027-01-15'
     or private.cu1c_exact_date('Jan 5, 2027', '2027-01-05') is distinct from date '2027-01-05'
     or private.cu1c_exact_date('Feb 29, 2028', '2028-02-29') is distinct from date '2028-02-29'
     or private.cu1c_exact_date('Feb 29, 2027', '2027-02-29') is not null
     or private.cu1c_exact_date('Jan 05, 2027', '2027-01-05') is not null
     or private.cu1c_exact_date('Jan 15, 2027', '2027-01-16') is not null
     or private.cu1c_exact_date('TBA 2027', '2027-12-31') is not null
     or private.cu1c_exact_date('TBA', '2099-01-01') is not null then
    raise exception 'cu1c: the exact-date rule failed its checks';
  end if;
  if not exists (select 1 from private.migration_runs r where r.run_id = c.run_id and r.migration = 'cu1c') then raise exception 'cu1c: the run record does not hold this run'; end if;
end $$;

select 'CU1C|' || (select run_id from cu1c_ctx) as result;
commit;
