-- Rollback of Stage 4b (db/phase4b_add_to_show.sql), in one transaction. Refuses
-- unless Stage 4b is installed. Drops public.add_tv_seasons_to_show and
-- public.create_tv_show only; every show and season they added stays. Run only
-- after the app no longer calls them (revert the app first): an open Stage 4b
-- page then reports that adding a show or adding to an existing show isn't
-- available, and never falls back to add_tv_seasons. Run as postgres.
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regprocedure('public.add_tv_seasons_to_show(uuid, jsonb, jsonb)') is null
     or to_regprocedure('public.create_tv_show(jsonb, jsonb)') is null then
    raise exception 'phase4b rollback: Stage 4b is not installed';
  end if;
end $$;

drop function public.add_tv_seasons_to_show(uuid, jsonb, jsonb);
drop function public.create_tv_show(jsonb, jsonb);

notify pgrst, 'reload schema';
commit;
