-- TEST ENVIRONMENTS ONLY (refuses without db/test/m1_test_marker.sql's marker). Puts a test database
-- back as it was before db/ep1_episode_marks.sql, so EP1 can be rehearsed again. It is not a
-- production rollback: EP1 has none (fix-forward). It refuses while any episode mark exists (remove
-- them first, through the app or by deleting their seasons), so nothing saved is discarded here.
begin;
set local lock_timeout = '10s';
lock table public.tv_shows, public.watchlist_items, private.migration_runs in access exclusive mode;

do $$ begin
  if to_regclass('zz_test.environment') is null then raise exception 'ep1_reverse: not a marked test environment; nothing was changed'; end if;
  if to_regclass('public.episode_marks') is null then raise exception 'ep1_reverse: EP1 is not installed'; end if;
  if exists (select 1 from public.episode_marks) then raise exception 'ep1_reverse: episode marks exist; remove them first. Nothing was changed'; end if;
end $$;

drop function public.library_set_episode_marks(uuid, jsonb, boolean, jsonb);
drop function public.restore_backup(jsonb, boolean);
alter function private.restore_backup_v5(jsonb, boolean) set schema public;
alter function public.restore_backup_v5(jsonb, boolean) rename to restore_backup;
drop function public.delete_tv_season(uuid, integer);
-- The Stage 5c definition (db/phase5c_contract.sql), verbatim.
create or replace function public.delete_tv_season(p_row_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('delete_tv_season', 'final');
  r public.watchlist_items;
  v_show public.tv_shows;
  v_show_deleted boolean := false;
begin
  select * into r from public.watchlist_items where id = p_row_id and user_id = v_owner and not is_film;
  if r.id is null then raise exception 'not_found: TV season' using errcode = 'P0002'; end if;
  if r.show_id is not null then
    select * into v_show from public.tv_shows where id = r.show_id and user_id = v_owner for update;
  end if;
  delete from public.watchlist_items where id = r.id and user_id = v_owner;
  if v_show.id is not null and not exists (select 1 from public.watchlist_items where show_id = v_show.id) then
    delete from public.tv_shows where id = v_show.id and user_id = v_owner;
    v_show_deleted := true;
  end if;
  return jsonb_build_object('deleted_row_id', r.id, 'show_id', v_show.id, 'show_deleted', v_show_deleted);
end $$;
revoke all on function public.delete_tv_season(uuid) from public, anon;
grant execute on function public.delete_tv_season(uuid) to authenticated;

drop table public.episode_marks;
drop trigger watchlist_items_ep1_identity_guard on public.watchlist_items;
drop function private.ep1_identity_guard();
drop function private.ep1_mark_season_check();
alter table public.watchlist_items drop constraint watchlist_items_id_owner_key;

-- The M1 capability (db/m1_access.sql), verbatim.
create or replace function public.stage5_capabilities() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted-b45', 'backup_format', 5, 'b45', 1, 'access', 'members',
    -- Whether the caller is a member now. A signed-in non-member's reads return no rows (RLS), so pages and
    -- exports check this explicitly before treating anything they read as the library (never an empty one).
    'member', private.is_member(),
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;
revoke execute on function public.stage5_capabilities() from public, anon;
grant execute on function public.stage5_capabilities() to authenticated;
delete from private.migration_runs where migration = 'ep1';

notify pgrst, 'reload schema';
commit;
