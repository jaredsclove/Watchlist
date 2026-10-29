-- TEST ENVIRONMENTS ONLY: puts a test database back to CU1's date function (drops CU1c's helper and run record) so
-- the CU1c install can be rehearsed again. Never a production step: production is fix-forward.
-- Refuses unless the database is marked as a test environment (db/test/m1_test_marker.sql).
begin;
do $$ begin
  if to_regclass('zz_test.environment') is null then raise exception 'cu1c reverse: not a marked test environment; nothing was changed'; end if;
  if to_regprocedure('private.cu1c_exact_date(text, text)') is null then raise exception 'cu1c reverse: CU1c is not installed; nothing was changed'; end if;
end $$;
-- CU1's function, verbatim.
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
do $$ begin
  if (select md5(prosrc) from pg_proc where oid = 'public.library_cu_set_season_date(uuid, jsonb, jsonb, jsonb, boolean)'::regprocedure) <> 'b3d2acd388992f380ab97b217a0c8c8e' then
    raise exception 'cu1c reverse: CU1''s function wasn''t restored exactly';
  end if;
end $$;
drop function private.cu1c_exact_date(text, text);
delete from private.migration_runs where migration = 'cu1c';
commit;
