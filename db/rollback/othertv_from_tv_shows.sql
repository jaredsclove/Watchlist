-- Rebuilds Refresh shows' old tracking table (othertv_shows) from the identified
-- shows in tv_shows. Since 59dd6a1 the app's Refresh reads tv_shows, and from stage
-- final the database no longer keeps othertv_shows in step. Run this before
-- reverting the app to a version whose Refresh reads othertv_shows, so it doesn't
-- resume with stale tracking: shows added since are tracked again, and shows whose
-- last season was deleted aren't. Existing rows (and their network) are kept.
-- Run as postgres, in one transaction; safe to re-run.
begin;
do $$ begin
  if private.tv_stage() not in ('authoritative', 'final') then raise exception 'unexpected stage %', private.tv_stage(); end if;
end $$;
delete from public.othertv_shows o
where o.user_id = (select bootstrap_owner_id from private.app_owner)
  and not exists (select 1 from public.tv_shows s
                  where s.user_id = o.user_id and s.collection = o.collection and s.tmdb_id = o.tmdb_id);
insert into public.othertv_shows (user_id, tmdb_id, title, network, collection)
select s.user_id, s.tmdb_id, s.title,
       coalesce((select w.theme from public.watchlist_items w where w.show_id = s.id
                 order by w.season_number desc nulls last, w.date_sort desc limit 1), ''),
       s.collection
from public.tv_shows s
where s.user_id = (select bootstrap_owner_id from private.app_owner) and s.tmdb_id is not null
on conflict (user_id, collection, tmdb_id) do nothing;
commit;
