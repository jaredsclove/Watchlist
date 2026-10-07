-- Stage 3b-2: editing personal organization, in one transaction. Functions only:
-- no table, column, index, constraint, grant on a table, policy or backup-format
-- change. Adds
--   * public.org_capabilities(): read-only; lets a page see that editing is
--     available without sending a change;
--   * owner-scoped write functions for collections (create, rename, archive /
--     unarchive), memberships (add / remove a whole show or a film) and watch-with
--     choices (create, change the label, archive / unarchive). Each is one
--     transaction, guarded by the values the page showed, and never overwrites a
--     newer change;
--   * one changed rule: an UPDATE that newly adds an archived watch-with choice to
--     a row is refused. Rows that already carry it keep it; an INSERT that carries
--     one (restore) is accepted, so a restore stays exact with every trigger on.
-- Membership writes lock the show or film first, then the collection, then touch
-- memberships: the same table order as restore_backup and match_tv_row (shows,
-- rows, collections, memberships, choices).
-- Run as postgres at stage final, after db/phase3b_org.sql (Stage 3b-1).
-- Rollback (functions only; keeps every edit): db/rollback/phase3b2.sql.
begin;
set local lock_timeout = '5s';

do $$ begin
  if private.tv_stage() <> 'final' then raise exception 'phase3b2: expected stage final, found %', private.tv_stage(); end if;
  if to_regclass('public.personal_collections') is null then
    raise exception 'phase3b2: Stage 3b-1 (db/phase3b_org.sql) is not installed';
  end if;
  if to_regprocedure('public.org_capabilities()') is not null then
    raise exception 'phase3b2: already applied (org_capabilities exists)';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgname in ('org_auto_membership_show', 'org_auto_membership_film',
      'org_carry_membership_to_film', 'org_check_watch_with', 'org_guard_watch_with_choice')) <> 5 then
    raise exception 'phase3b2: the five Stage 3b-1 organization triggers are not all present';
  end if;
  if to_regprocedure('public.match_tv_row(uuid, jsonb, jsonb, jsonb)') is null then
    raise exception 'phase3b2: match_tv_row with the Stage 3b-1 confirmation argument is not installed';
  end if;
  -- The trigger body replaced below must be exactly the Stage 3b-1 one (the
  -- rollback puts that one back).
  if (select md5(prosrc) from pg_proc where oid = 'private.org_check_watch_with()'::regprocedure)
     <> '41520d4ff23d80b4adb5a676ebcd8b7e' then
    raise exception 'phase3b2: private.org_check_watch_with is not the Stage 3b-1 version';
  end if;
end $$;

-- ── Helpers ──
-- Refusals are P0001 with a stable prefix and a sentence any page can show as is;
-- details carries JSON (the current record, the conflicting record) for the page.
create function private.org_refuse(p_code text, p_message text, p_detail jsonb default null) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code || ': ' || p_message, detail = coalesce(p_detail::text, '');
end $$;
revoke all on function private.org_refuse(text, text, jsonb) from public;
grant execute on function private.org_refuse(text, text, jsonb) to anon, authenticated;

-- A collection name or choice label as stored: trimmed, not empty, at most 100.
create function private.org_clean_text(p_text text, p_what text) returns text
language plpgsql immutable security invoker set search_path = '' as $$
declare v text := btrim(coalesce(p_text, ''));
begin
  if v = '' then
    perform private.org_refuse('org_invalid_' || p_what, format('the %s is empty. Nothing was changed.', p_what));
  end if;
  if char_length(v) > 100 then
    perform private.org_refuse('org_invalid_' || p_what, format('the %s is longer than 100 characters. Nothing was changed.', p_what));
  end if;
  return v;
end $$;
revoke all on function private.org_clean_text(text, text) from public;
grant execute on function private.org_clean_text(text, text) to anon, authenticated;

-- ── Capability (read-only) ──
create function public.org_capabilities() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('org_write', 1)
$$;
revoke all on function public.org_capabilities() from public;
grant execute on function public.org_capabilities() to anon, authenticated;

-- ── Collections ──
-- p_id is chosen by the page, so a repeated request for the same collection finds
-- the one already created (existing: true) and changes nothing, even if it was
-- renamed or archived since.
create function public.org_create_collection(p_id uuid, p_name text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_name text;
  c public.personal_collections;
  x public.personal_collections;
  v_constraint text;
begin
  perform set_config('lock_timeout', '5s', true);
  if p_id is null then perform private.org_refuse('invalid_input', 'a new collection needs an id. Nothing was changed.'); end if;
  v_name := private.org_clean_text(p_name, 'name');
  begin
    insert into public.personal_collections (id, name, sort_order)
    values (p_id, v_name, (select coalesce(max(sort_order), 0) + 1 from public.personal_collections where user_id = v_owner))
    on conflict (id) do nothing
    returning * into c;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint <> 'personal_collections_name_key' then raise; end if;
    select * into x from public.personal_collections where user_id = v_owner and lower(name) = lower(v_name);
    perform private.org_refuse('org_name_taken',
      format('%s collection is already called "%s". Nothing was changed.', case when x.archived_at is null then 'another' else 'an archived' end, x.name),
      jsonb_build_object('conflict_id', x.id, 'archived', x.archived_at is not null, 'name', x.name));
  end;
  if c.id is null then
    select * into c from public.personal_collections where id = p_id and user_id = v_owner;
    if c.id is null then
      perform private.org_refuse('org_id_taken', 'that id is already in use. Nothing was changed; try again.');
    end if;
    return jsonb_build_object('collection', to_jsonb(c) - 'user_id', 'existing', true);
  end if;
  return jsonb_build_object('collection', to_jsonb(c) - 'user_id', 'existing', false);
end $$;

-- Renames only if the name is still the one the page showed.
create function public.org_rename_collection(p_id uuid, p_expected_name text, p_name text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_name text;
  c public.personal_collections;
  x public.personal_collections;
  v_constraint text;
begin
  perform set_config('lock_timeout', '5s', true);
  v_name := private.org_clean_text(p_name, 'name');
  select * into c from public.personal_collections where id = p_id and user_id = v_owner for no key update;
  if c.id is null then perform private.org_refuse('org_not_found', 'this collection is no longer available. Nothing was changed.'); end if;
  if c.name is distinct from p_expected_name then
    perform private.org_refuse('org_conflict', format('this collection was renamed elsewhere to "%s". Nothing was changed.', c.name),
      jsonb_build_object('current', to_jsonb(c) - 'user_id'));
  end if;
  if c.name = v_name then return jsonb_build_object('collection', to_jsonb(c) - 'user_id'); end if;
  begin
    update public.personal_collections set name = v_name where id = c.id returning * into c;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint <> 'personal_collections_name_key' then raise; end if;
    select * into x from public.personal_collections where user_id = v_owner and lower(name) = lower(v_name) and id <> p_id;
    perform private.org_refuse('org_name_taken',
      format('%s collection is already called "%s". Nothing was changed.', case when x.archived_at is null then 'another' else 'an archived' end, x.name),
      jsonb_build_object('conflict_id', x.id, 'archived', x.archived_at is not null, 'name', x.name));
  end;
  return jsonb_build_object('collection', to_jsonb(c) - 'user_id');
end $$;

-- Archive (p_archived true) needs the collection active now; unarchive needs it
-- archived now. Otherwise nothing is written and the current record is returned
-- in the refusal, so a request based on an older view never reverses a newer one.
create function public.org_set_collection_archived(p_id uuid, p_archived boolean) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  c public.personal_collections;
begin
  perform set_config('lock_timeout', '5s', true);
  if p_archived is null then perform private.org_refuse('invalid_input', 'archive or unarchive? Nothing was changed.'); end if;
  select * into c from public.personal_collections where id = p_id and user_id = v_owner for no key update;
  if c.id is null then perform private.org_refuse('org_not_found', 'this collection is no longer available. Nothing was changed.'); end if;
  if (c.archived_at is not null) = p_archived then
    perform private.org_refuse('org_conflict',
      format('this collection is already %s. Nothing was changed.', case when p_archived then 'archived' else 'active' end),
      jsonb_build_object('current', to_jsonb(c) - 'user_id'));
  end if;
  update public.personal_collections set archived_at = case when p_archived then now() end where id = c.id returning * into c;
  return jsonb_build_object('collection', to_jsonb(c) - 'user_id');
end $$;

-- ── Memberships ──
-- Lock order: the show or film first (a Match, a deletion or a change of kind of
-- that show or film waits for this, or this waits for it), then the collection
-- (an archive or rename waits, or this waits), then the membership itself.
create function public.org_add_membership(p_collection_id uuid, p_show_id uuid default null, p_item_id uuid default null) returns jsonb
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

-- Removes exactly the membership named, and only while it still joins that
-- collection and that show or film; never another record.
create function public.org_remove_membership(p_membership_id uuid, p_collection_id uuid, p_show_id uuid default null, p_item_id uuid default null)
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

-- ── Watch-with choices ──
-- New choices get the token ww:<id>; rows store the token, the label is display only.
create function public.org_create_choice(p_id uuid, p_label text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_label text;
  c public.watch_with_choices;
  x public.watch_with_choices;
  v_constraint text;
begin
  perform set_config('lock_timeout', '5s', true);
  if p_id is null then perform private.org_refuse('invalid_input', 'a new choice needs an id. Nothing was changed.'); end if;
  v_label := private.org_clean_text(p_label, 'label');
  begin
    insert into public.watch_with_choices (id, token, label, sort_order)
    values (p_id, 'ww:' || p_id::text, v_label,
            (select coalesce(max(sort_order), 0) + 1 from public.watch_with_choices where user_id = v_owner))
    on conflict (id) do nothing
    returning * into c;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'watch_with_choices_token_key' then
      perform private.org_refuse('org_id_taken', 'that id is already in use. Nothing was changed; try again.');
    end if;
    if v_constraint <> 'watch_with_choices_label_key' then raise; end if;
    select * into x from public.watch_with_choices where user_id = v_owner and lower(label) = lower(v_label);
    perform private.org_refuse('org_label_taken',
      format('%s watch-with choice is already called "%s". Nothing was changed.', case when x.archived_at is null then 'another' else 'an archived' end, x.label),
      jsonb_build_object('conflict_id', x.id, 'archived', x.archived_at is not null, 'label', x.label));
  end;
  if c.id is null then
    select * into c from public.watch_with_choices where id = p_id and user_id = v_owner;
    if c.id is null then
      perform private.org_refuse('org_id_taken', 'that id is already in use. Nothing was changed; try again.');
    end if;
    return jsonb_build_object('choice', to_jsonb(c) - 'user_id', 'existing', true);
  end if;
  return jsonb_build_object('choice', to_jsonb(c) - 'user_id', 'existing', false);
end $$;

create function public.org_rename_choice(p_id uuid, p_expected_label text, p_label text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_label text;
  c public.watch_with_choices;
  x public.watch_with_choices;
  v_constraint text;
begin
  perform set_config('lock_timeout', '5s', true);
  v_label := private.org_clean_text(p_label, 'label');
  select * into c from public.watch_with_choices where id = p_id and user_id = v_owner for no key update;
  if c.id is null then perform private.org_refuse('org_not_found', 'this watch-with choice is no longer available. Nothing was changed.'); end if;
  if c.label is distinct from p_expected_label then
    perform private.org_refuse('org_conflict', format('this watch-with choice was renamed elsewhere to "%s". Nothing was changed.', c.label),
      jsonb_build_object('current', to_jsonb(c) - 'user_id'));
  end if;
  if c.label = v_label then return jsonb_build_object('choice', to_jsonb(c) - 'user_id'); end if;
  begin
    update public.watch_with_choices set label = v_label where id = c.id returning * into c;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint <> 'watch_with_choices_label_key' then raise; end if;
    select * into x from public.watch_with_choices where user_id = v_owner and lower(label) = lower(v_label) and id <> p_id;
    perform private.org_refuse('org_label_taken',
      format('%s watch-with choice is already called "%s". Nothing was changed.', case when x.archived_at is null then 'another' else 'an archived' end, x.label),
      jsonb_build_object('conflict_id', x.id, 'archived', x.archived_at is not null, 'label', x.label));
  end;
  return jsonb_build_object('choice', to_jsonb(c) - 'user_id');
end $$;

create function public.org_set_choice_archived(p_id uuid, p_archived boolean) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  c public.watch_with_choices;
begin
  perform set_config('lock_timeout', '5s', true);
  if p_archived is null then perform private.org_refuse('invalid_input', 'archive or unarchive? Nothing was changed.'); end if;
  select * into c from public.watch_with_choices where id = p_id and user_id = v_owner for no key update;
  if c.id is null then perform private.org_refuse('org_not_found', 'this watch-with choice is no longer available. Nothing was changed.'); end if;
  if (c.archived_at is not null) = p_archived then
    perform private.org_refuse('org_conflict',
      format('this watch-with choice is already %s. Nothing was changed.', case when p_archived then 'archived' else 'active' end),
      jsonb_build_object('current', to_jsonb(c) - 'user_id'));
  end if;
  update public.watch_with_choices set archived_at = case when p_archived then now() end where id = c.id returning * into c;
  return jsonb_build_object('choice', to_jsonb(c) - 'user_id');
end $$;

do $$ declare f text; begin
  foreach f in array array['org_create_collection(uuid, text)', 'org_rename_collection(uuid, text, text)',
    'org_set_collection_archived(uuid, boolean)', 'org_add_membership(uuid, uuid, uuid)', 'org_remove_membership(uuid, uuid, uuid, uuid)',
    'org_create_choice(uuid, text)', 'org_rename_choice(uuid, text, text)', 'org_set_choice_archived(uuid, boolean)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;

-- ── Watch-with: an archived choice can't be newly added to a row ──
-- Unchanged from Stage 3b-1: no NULL element, every token one of the owner's
-- choices, those choices locked FOR KEY SHARE. New: on an UPDATE, a token the row
-- didn't have before must not be an archived choice. Tokens the row already has
-- stay, whatever their state, and an INSERT (a restore) may carry archived ones.
create or replace function private.org_check_watch_with() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_wanted int; v_found int; v_bad text;
begin
  if new.watch_with is null or cardinality(new.watch_with) = 0 then return new; end if;
  if array_position(new.watch_with, null) is not null then
    raise exception 'watch_with_invalid: a watch-with value is empty' using errcode = '23514';
  end if;
  select count(distinct t) into v_wanted from unnest(new.watch_with) t;
  select count(*) into v_found from (
    select 1 from public.watch_with_choices c where c.user_id = new.user_id and c.token = any(new.watch_with) for key share
  ) x;
  if v_found <> v_wanted then
    select t into v_bad from unnest(new.watch_with) t
    where not exists (select 1 from public.watch_with_choices c where c.user_id = new.user_id and c.token = t) limit 1;
    raise exception 'watch_with_invalid: "%" is not one of your watch-with choices', coalesce(v_bad, '?') using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    select c.label into v_bad from public.watch_with_choices c
    where c.user_id = new.user_id and c.archived_at is not null and c.token = any(new.watch_with)
      and not (c.token = any(coalesce(old.watch_with, '{}'::text[])))
    order by c.sort_order, c.token limit 1;
    if v_bad is not null then
      raise exception 'watch_with_archived: "%" is archived; reload the page to see your current choices. Nothing was changed.', v_bad
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';

commit;
