-- FUTURE sign-in project only. Not part of the TV migration; never run on
-- production without that project's own approval. Rehearsed in Phase 0 on the
-- test project (db/test/t_two_user.sql).
--
-- Installs two admin functions (SQL Editor only):
--   private.auth_move_owner(p_to)  moves every bootstrap-owned row to a real
--     Auth account in one transaction, adds the user_id → auth.users links
--     (ON DELETE RESTRICT: deleting a login never deletes a Watchlist), and makes
--     the bootstrap value that account, so defaults stay right until the lock;
--   private.auth_lock()  the lock migration: the owner becomes the signed-in user
--     only (no fallback, error when nobody is signed in), the bootstrap table is
--     dropped, the open anon rules are replaced by owner-only rules, and
--     anonymous access to tables and functions is revoked. Deploy together with
--     the login-required app, before any second account exists.
-- Usage (each in its own approved step):
--   begin; select private.auth_move_owner('<auth user id>'); commit;
--   begin; select private.auth_lock(); commit;

create or replace function private.auth_move_owner(p_to uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_from uuid := (select bootstrap_owner_id from private.app_owner);
  v_before jsonb;
  v_after jsonb;
  t text;
begin
  if not exists (select 1 from auth.users where id = p_to) then raise exception 'auth_move_owner: no Auth user %', p_to; end if;
  if v_from = p_to then raise exception 'auth_move_owner: already moved'; end if;
  if exists (select 1 from public.watchlist_items where user_id = p_to) or exists (select 1 from public.tv_shows where user_id = p_to)
     or exists (select 1 from public.custom_collections where user_id = p_to)
     or (to_regclass('public.othertv_shows') is not null and exists (select 1 from public.othertv_shows where user_id = p_to)) then
    raise exception 'auth_move_owner: the account already owns rows';
  end if;
  v_before := jsonb_build_object(
    'items', (select count(*) from public.watchlist_items), 'shows', (select count(*) from public.tv_shows),
    'people', (select count(*) from public.custom_collections), 'owned_items', (select count(*) from public.watchlist_items where user_id = v_from));

  -- Personal organization (Stage 3b): its links include the owner, so they are
  -- checked once at the end, after every table has moved.
  if to_regclass('public.collection_memberships') is not null then
    set constraints public.collection_memberships_collection_fkey, public.collection_memberships_show_fkey,
      public.collection_memberships_item_fkey deferred;
  end if;
  -- Shows first: the season link cascades the new owner to every linked season.
  update public.tv_shows set user_id = p_to where user_id = v_from;
  -- Then everything without a show: movies, films, unlinked rows.
  update public.watchlist_items set user_id = p_to where user_id = v_from;
  update public.custom_collections set user_id = p_to where user_id = v_from;
  if to_regclass('public.othertv_shows') is not null then
    update public.othertv_shows set user_id = p_to where user_id = v_from;
  end if;
  if to_regclass('public.personal_collections') is not null then
    update public.personal_collections set user_id = p_to where user_id = v_from;
    update public.collection_memberships set user_id = p_to where user_id = v_from;
    update public.watch_with_choices set user_id = p_to where user_id = v_from;
    -- Every table has moved: check the organization links now.
    set constraints public.collection_memberships_collection_fkey, public.collection_memberships_show_fkey,
      public.collection_memberships_item_fkey immediate;
  end if;
  update private.app_owner set bootstrap_owner_id = p_to;

  foreach t in array array['watchlist_items', 'tv_shows', 'custom_collections', 'othertv_shows',
                           'personal_collections', 'collection_memberships', 'watch_with_choices'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I add constraint %I foreign key (user_id) references auth.users (id) on delete restrict',
                   t, t || '_user_id_fkey');
  end loop;

  v_after := jsonb_build_object(
    'items', (select count(*) from public.watchlist_items), 'shows', (select count(*) from public.tv_shows),
    'people', (select count(*) from public.custom_collections), 'owned_items', (select count(*) from public.watchlist_items where user_id = p_to));
  if v_after <> v_before then raise exception 'auth_move_owner: counts changed % → %', v_before, v_after; end if;
  if exists (select 1 from public.watchlist_items where user_id = v_from) or exists (select 1 from public.tv_shows where user_id = v_from)
     or exists (select 1 from public.custom_collections where user_id = v_from)
     or (to_regclass('public.othertv_shows') is not null and exists (select 1 from public.othertv_shows where user_id = v_from)) then
    raise exception 'auth_move_owner: rows left on the bootstrap owner';
  end if;
  if to_regclass('public.personal_collections') is not null then
    if exists (select 1 from public.personal_collections where user_id = v_from)
       or exists (select 1 from public.collection_memberships where user_id = v_from)
       or exists (select 1 from public.watch_with_choices where user_id = v_from) then
      raise exception 'auth_move_owner: organization rows left on the bootstrap owner';
    end if;
  end if;
  return jsonb_build_object('from', v_from, 'to', p_to, 'counts', v_after);
end $$;

create or replace function private.auth_lock() returns void
language plpgsql set search_path = '' as $$
declare t text; p text;
begin
  -- The owner is the signed-in user, and only the signed-in user.
  create or replace function private.current_owner_id() returns uuid
  language plpgsql stable security invoker set search_path = '' as $f$
  declare v uuid := auth.uid();
  begin
    if v is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
    return v;
  end $f$;
  revoke all on function private.current_owner_id() from public, anon;
  grant execute on function private.current_owner_id() to authenticated;
  drop table private.app_owner;

  foreach t in array array['watchlist_items', 'tv_shows', 'custom_collections', 'othertv_shows',
                           'personal_collections', 'collection_memberships', 'watch_with_choices'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    foreach p in array array['anon_select', 'anon_insert', 'anon_update', 'anon_delete'] loop
      execute format('drop policy if exists %I on public.%I', p, t);
    end loop;
    execute format('create policy owner_only on public.%I for all to authenticated
                    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;

  revoke execute on all functions in schema public from anon;
  revoke execute on all functions in schema private from anon;
  revoke usage on schema private from anon;
end $$;

revoke all on function private.auth_move_owner(uuid), private.auth_lock() from public, anon, authenticated;
