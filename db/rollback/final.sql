-- Rollback of Clean-up C1: stage final → authoritative, keeping the current app.
-- While final, the database stopped writing the compatibility copies (the season
-- status column), so every show is re-projected here; a later Phase 3 rollback
-- (stage → shadow + tv_shadow_resync, db/stages.sql) then rebuilds the right
-- statuses from them. Before reverting the app to a version whose Refresh shows
-- reads othertv_shows (anything before 59dd6a1), also run othertv_from_tv_shows.sql.
-- Run as postgres, in one transaction.
begin;
do $$ begin if private.tv_stage() <> 'final' then raise exception 'expected final'; end if; end $$;
update private.migration_stage set stage = 'authoritative', changed_at = now();
do $$ declare s record; begin
  for s in select id from public.tv_shows where user_id = (select bootstrap_owner_id from private.app_owner) loop
    perform private.tv_project_legacy_status(s.id);
  end loop;
end $$;
commit;
