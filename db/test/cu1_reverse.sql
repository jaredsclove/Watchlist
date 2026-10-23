-- TEST ENVIRONMENTS ONLY (refuses without db/test/m1_test_marker.sql's marker). Puts a test database
-- back as it was before db/cu1_collection_updates.sql, so CU1 can be rehearsed again. It is not a
-- production rollback: CU1 has none (fix-forward). It refuses while any row exists in CU1's tables
-- (definitions, holds, findings and the rest), so nothing saved is discarded here.
begin;
set local lock_timeout = '10s';
lock table public.tv_shows, public.watchlist_items, public.collection_memberships, private.migration_runs in access exclusive mode;

do $$
declare t text; v boolean;
begin
  if to_regclass('zz_test.environment') is null then raise exception 'cu1_reverse: not a marked test environment; nothing was changed'; end if;
  if to_regclass('public.update_findings') is null then raise exception 'cu1_reverse: CU1 is not installed'; end if;
  foreach t in array private.cu1_backup_tables() loop
    execute format('select exists (select 1 from public.%I)', t) into v;
    if v then raise exception 'cu1_reverse: % has rows; remove them first. Nothing was changed', t; end if;
  end loop;
end $$;

drop function public.restore_backup(jsonb, boolean);
alter function private.restore_backup_v6(jsonb, boolean) set schema public;
alter function public.restore_backup_v6(jsonb, boolean) rename to restore_backup;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure::text f from pg_proc p
           where (p.pronamespace = 'public'::regnamespace and p.proname like 'library\_cu\_%')
              or (p.pronamespace = 'private'::regnamespace and p.proname like 'cu1\_%' and p.proname not in ('cu1_backup_tables'))
           order by case when p.proname in ('cu1_norm', 'cu1_rules_ok', 'cu1_evidence_settings_ok', 'cu1_reopen_ok', 'cu1_str_ok', 'cu1_str_list_ok',
             'cu1_int_ok', 'cu1_bool_ok', 'cu1_domain_ok') then 1 else 0 end loop
    execute format('drop function if exists %s cascade', r.f);
  end loop;
end $$;
drop table public.update_findings, public.research_imports, public.research_briefs, public.show_update_settings, public.membership_removals,
  public.record_aliases, public.update_holds, public.collection_exclusions, public.collection_definitions, public.update_setup;
do $$
declare r record;
begin
  for r in select p.oid::regprocedure::text f from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname like 'cu1\_%' loop
    execute format('drop function %s', r.f);
  end loop;
end $$;

-- The Stage 3b-2 membership functions (db/phase3b2_org_write.sql), verbatim.
create or replace function public.org_add_membership(p_collection_id uuid, p_show_id uuid default null, p_item_id uuid default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_film boolean;
  v_show uuid;
  c public.personal_collections;
  m public.collection_memberships;
begin
  perform set_config('lock_timeout', '5s', true);
  if (p_show_id is null) = (p_item_id is null) then
    perform private.org_refuse('invalid_input', 'add exactly one show or film. Nothing was changed.');
  end if;
  if p_show_id is not null then
    perform 1 from public.tv_shows where id = p_show_id and user_id = v_owner for key share;
    if not found then perform private.org_refuse('org_target_missing', 'that show is no longer saved. Nothing was changed.'); end if;
  else
    select is_film, show_id into v_film, v_show from public.watchlist_items where id = p_item_id and user_id = v_owner for key share;
    if not found then perform private.org_refuse('org_target_missing', 'that film is no longer saved. Nothing was changed.'); end if;
    if not v_film then
      perform private.org_refuse('org_not_film', 'that row is no longer a film (it may have been matched as a TV season). Nothing was changed.',
        jsonb_build_object('show_id', v_show, 'show_title', (select title from public.tv_shows where id = v_show)));
    end if;
  end if;
  select * into c from public.personal_collections where id = p_collection_id and user_id = v_owner for share;
  if c.id is null then perform private.org_refuse('org_not_found', 'this collection is no longer available. Nothing was changed.'); end if;
  if c.archived_at is not null then
    perform private.org_refuse('org_archived', 'this collection is archived; unarchive it to change its members. Nothing was changed.');
  end if;
  if p_show_id is not null then
    insert into public.collection_memberships (collection_id, show_id) values (c.id, p_show_id)
    on conflict (collection_id, show_id) where (show_id is not null) do nothing returning * into m;
    if m.id is null then
      select * into m from public.collection_memberships where collection_id = c.id and show_id = p_show_id;
      return jsonb_build_object('membership', to_jsonb(m) - 'user_id' - 'item_is_film', 'added', false);
    end if;
  else
    insert into public.collection_memberships (collection_id, item_id) values (c.id, p_item_id)
    on conflict (collection_id, item_id) where (item_id is not null) do nothing returning * into m;
    if m.id is null then
      select * into m from public.collection_memberships where collection_id = c.id and item_id = p_item_id;
      return jsonb_build_object('membership', to_jsonb(m) - 'user_id' - 'item_is_film', 'added', false);
    end if;
  end if;
  return jsonb_build_object('membership', to_jsonb(m) - 'user_id' - 'item_is_film', 'added', true);
end $$;

create or replace function public.org_remove_membership(p_membership_id uuid, p_collection_id uuid, p_show_id uuid default null, p_item_id uuid default null)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_film boolean;
  v_show uuid;
  c public.personal_collections;
  v_gone uuid;
begin
  perform set_config('lock_timeout', '5s', true);
  if p_membership_id is null or (p_show_id is null) = (p_item_id is null) then
    perform private.org_refuse('invalid_input', 'name the membership and exactly one show or film. Nothing was changed.');
  end if;
  if p_show_id is not null then
    perform 1 from public.tv_shows where id = p_show_id and user_id = v_owner for key share;
    if not found then return jsonb_build_object('removed', false, 'reason', 'target_missing'); end if;
  else
    select is_film, show_id into v_film, v_show from public.watchlist_items where id = p_item_id and user_id = v_owner for key share;
    if not found then return jsonb_build_object('removed', false, 'reason', 'target_missing'); end if;
    if not v_film then
      return jsonb_build_object('removed', false, 'reason', 'not_film', 'show_id', v_show,
        'show_title', (select title from public.tv_shows where id = v_show));
    end if;
  end if;
  select * into c from public.personal_collections where id = p_collection_id and user_id = v_owner for share;
  if c.id is null then perform private.org_refuse('org_not_found', 'this collection is no longer available. Nothing was changed.'); end if;
  if c.archived_at is not null then
    perform private.org_refuse('org_archived', 'this collection is archived; unarchive it to change its members. Nothing was changed.');
  end if;
  delete from public.collection_memberships
  where id = p_membership_id and user_id = v_owner and collection_id = c.id
    and show_id is not distinct from p_show_id and item_id is not distinct from p_item_id
  returning id into v_gone;
  if v_gone is null then return jsonb_build_object('removed', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('removed', true, 'membership_id', v_gone);
end $$;

-- The B4/B5 catalog application (db/b45_expand.sql), verbatim.
create or replace function public.library_catalog_apply_b45(p_catalog text, p_defaults jsonb, p_approved text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v jsonb;
begin
  perform private.tv_require_stage('library_catalog_apply_b45', 'final');
  begin
    if p_approved is null then
      begin
        v := private.catalog_run_b45(p_catalog, p_defaults);
        raise exception 'catalog_preview_rollback' using errcode = 'P0001';
      exception when sqlstate 'P0001' then
        if sqlerrm <> 'catalog_preview_rollback' then raise; end if;
      end;
      return jsonb_build_object('mode', 'preview', 'document', v -> 'document', 'hash', v ->> 'hash');
    end if;
    v := private.catalog_run_b45(p_catalog, p_defaults);
  exception when lock_not_available or deadlock_detected then
    raise exception 'catalog_busy: The database was busy, so nothing was changed. Review again in a moment.' using errcode = 'P0001';
  end;
  if v ->> 'hash' is distinct from p_approved then
    raise exception 'catalog_stale: Your library or the catalog changed since this preview, so nothing was changed. Review again.'
      using errcode = 'P0001', detail = jsonb_build_object('hash', v ->> 'hash')::text;
  end if;
  return jsonb_build_object('mode', 'applied', 'document', v -> 'document', 'hash', v ->> 'hash', 'receipt', v -> 'receipt',
    'applied_at', now());
end $$;

-- The EP1 capability (db/ep1_episode_marks.sql), verbatim.
create or replace function public.stage5_capabilities() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('stage5', 1, 'phase', 'contracted-ep1', 'backup_format', 6, 'b45', 1, 'ep1', 1, 'access', 'members',
    -- Whether the caller is a member now (M1): a signed-in non-member's reads return no rows.
    'member', private.is_member(),
    'recovery_archive', case when to_regclass('private.stage5_recovery_meta') is null then 'retired' else 'active' end)
$$;
revoke execute on function public.stage5_capabilities() from public, anon;
grant execute on function public.stage5_capabilities() to authenticated;
delete from private.migration_runs where migration = 'cu1';

notify pgrst, 'reload schema';
commit;
