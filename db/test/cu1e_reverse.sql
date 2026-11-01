-- TEST ENVIRONMENTS ONLY: puts back CU1's cu1_finding_take and removes CU1e's run record so the install can be
-- rehearsed again. Never a production step: production is fix-forward.
-- Refuses unless the database is marked as a test environment (db/test/m1_test_marker.sql).
begin;
do $$ begin
  if to_regclass('zz_test.environment') is null then raise exception 'cu1e reverse: not a marked test environment; nothing was changed'; end if;
  if not exists (select 1 from private.migration_runs where migration = 'cu1e') then raise exception 'cu1e reverse: CU1e is not installed; nothing was changed'; end if;
end $$;
create or replace function private.cu1_finding_take(p_owner uuid, p_finding jsonb, p_kinds text[]) returns public.update_findings
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
delete from private.migration_runs where migration = 'cu1e';
commit;
