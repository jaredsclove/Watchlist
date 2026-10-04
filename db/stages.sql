-- Migration stage switches. Run ONE block at a time, as postgres, only at its
-- approved step. Each checks the stage it expects before changing anything.

-- Phase 2 — shadow model (after db/rpc.sql is installed):
-- begin;
--   do $$ begin if private.tv_stage() <> 'tv_schema' then raise exception 'expected tv_schema'; end if; end $$;
--   update private.migration_stage set stage = 'shadow', changed_at = now();
-- commit;

-- Phase 3 — switch-over (after a fresh v2 backup and the final resync):
-- begin;
--   do $$ begin
--     if private.tv_stage() <> 'shadow' then raise exception 'expected shadow'; end if;
--     if exists (select 1 from public.watchlist_items where show_id is null
--                and private.tv_is_tv_row(collection, media_type, season)) then
--       raise exception 'unlinked TV seasons: run tv_backfill and tv_shadow_resync first';
--     end if;
--   end $$;
--   update private.migration_stage set stage = 'authoritative', changed_at = now();
-- commit;

-- Clean-up C1 — stop writing compatibility values (after stabilization, approved):
-- begin;
--   do $$ begin if private.tv_stage() <> 'authoritative' then raise exception 'expected authoritative'; end if; end $$;
--   update private.migration_stage set stage = 'final', changed_at = now();
-- commit;

-- Rollback of Phase 3 (with a git revert of the app to the Phase 2 version):
-- begin;
--   do $$ begin if private.tv_stage() <> 'authoritative' then raise exception 'expected authoritative'; end if; end $$;
--   update private.migration_stage set stage = 'shadow', changed_at = now();
--   select private.tv_shadow_resync((select bootstrap_owner_id from private.app_owner));
-- commit;
