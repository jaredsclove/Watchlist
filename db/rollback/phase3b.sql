-- Rollback of Stage 3b-1, in one transaction. Run as postgres, only with
-- approval, after reverting the app to a version without personal collections.
--
-- It refuses unless the old model can show everything that is stored now, so
-- dropping the organization tables loses no information:
--   * the collections are exactly the four created by db/phase3b_org.sql
--     (original names, order and sources, none archived, no others);
--   * the memberships are exactly what each mapped tab stores (no removed,
--     added or cross-tab membership);
--   * every configured watch-with value is a choice, every other choice is a value
--     used on one of its owner's rows, all plain (token = label, not archived) and
--     in the canonical order; and every row value is a choice. (An unused choice
--     that isn't configured is refused even if it came from the bootstrap: nothing
--     trustworthy distinguishes it from one added later.)
-- The check covers every owner of anything, so removing all of an owner's
-- organization rows is refused too.
-- If the check fails, nothing is changed: keep the new schema, or take a
-- format 3 backup and an explicit decision before any lossy rollback.
--
-- Then it removes the triggers, the organization tables, is_film and the extra
-- keys, and puts back the previous restore_backup (format 2, db/restore_backup.sql)
-- and match_tv_row (db/rpc.sql) exactly; the rehearsal compares the whole
-- catalog with the pre-migration one.
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.personal_collections') is null then raise exception 'rollback 3b: not applied'; end if;
end $$;

lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
  public.watch_with_choices in access exclusive mode;

do $$
declare v_config text[] := array['Alone', 'Suzanne', 'Rina', 'Whole Family'];
begin
  -- Every owner of anything, including an owner whose organization rows were all removed.
  create temporary table rb_owners on commit drop as
    select user_id from public.watchlist_items union select user_id from public.tv_shows
    union select user_id from public.personal_collections union select user_id from public.watch_with_choices
    union select user_id from public.collection_memberships;

  -- Collections: exactly the four bootstrap collections per owner (by their immutable
  -- legacy_source, unique per owner), unchanged and unarchived.
  if exists (
    select 1 from rb_owners o
    where (select count(*) from public.personal_collections c where c.user_id = o.user_id) <> 4
       or (select count(*) from public.personal_collections c where c.user_id = o.user_id and c.archived_at is null
             and (c.legacy_source, c.name, c.sort_order) in
                 (('disney', 'Disney+', 1), ('sheridan', 'Sheridan', 2), ('90day', '90 Day', 3), ('truecrime', 'True Crime / Docs', 4))) <> 4
  ) then
    raise exception 'rollback 3b refused: collections were renamed, archived, reordered, added or removed';
  end if;

  -- Memberships: exactly what each mapped tab stores, derived from the fixed tab mapping
  -- (not from the remaining collection rows), in both directions.
  if exists (
    (select s.user_id, s.collection, s.id, null::uuid from public.tv_shows s
       where s.collection in ('disney', 'sheridan', '90day', 'truecrime')
     union all
     select w.user_id, w.collection, null::uuid, w.id from public.watchlist_items w
       where w.is_film and w.collection in ('disney', 'sheridan', '90day', 'truecrime'))
    except
    select m.user_id, c.legacy_source, m.show_id, m.item_id from public.collection_memberships m
      join public.personal_collections c on c.id = m.collection_id
  ) or exists (
    select m.user_id, c.legacy_source, m.show_id, m.item_id from public.collection_memberships m
      left join public.personal_collections c on c.id = m.collection_id
    except
    (select s.user_id, s.collection, s.id, null::uuid from public.tv_shows s
       where s.collection in ('disney', 'sheridan', '90day', 'truecrime')
     union all
     select w.user_id, w.collection, null::uuid, w.id from public.watchlist_items w
       where w.is_film and w.collection in ('disney', 'sheridan', '90day', 'truecrime'))
  ) then
    raise exception 'rollback 3b refused: memberships differ from what the tabs store';
  end if;

  -- Watch-with, judged only by what the old model can show (no creation timestamps:
  -- created_at can be written on insert and is kept by restore, so it proves nothing):
  -- every configured value present; every other choice is a value used on one of its
  -- owner's rows (the rows keep it, and the old app shows it as before); all plain
  -- (token = label, not archived) and in the canonical relative order (configured
  -- order, then A–Z). A choice whose only trace is its definition is refused, whether
  -- bootstrap history or added through the API: its origin can't be proved.
  if exists (
    select 1 from rb_owners o
    where (select count(*) from public.watch_with_choices c where c.user_id = o.user_id and c.token = any(v_config)) <> cardinality(v_config)
  ) or exists (
    select 1 from public.watch_with_choices c
    where c.token <> c.label or c.archived_at is not null
       or not (c.token = any(v_config)
               or exists (select 1 from public.watchlist_items w where w.user_id = c.user_id and c.token = any(w.watch_with)))
  ) or exists (
    select 1 from (
      select row_number() over (partition by c.user_id order by c.sort_order, c.token) by_sort,
             row_number() over (partition by c.user_id order by array_position(v_config, c.token) nulls last, lower(c.token), c.token) canonical
      from public.watch_with_choices c) x
    where x.by_sort <> x.canonical
  ) then
    raise exception 'rollback 3b refused: watch-with choices were renamed, archived, reordered or removed, or one is defined but used nowhere';
  end if;
  if exists (select 1 from public.watchlist_items w, unnest(coalesce(w.watch_with, '{}'::text[])) t
             where not exists (select 1 from public.watch_with_choices c where c.user_id = w.user_id and c.token = t)) then
    raise exception 'rollback 3b refused: a row uses a watch-with value with no choice';
  end if;
end $$;

drop trigger org_auto_membership_show on public.tv_shows;
drop trigger org_auto_membership_film on public.watchlist_items;
drop trigger org_carry_membership_to_film on public.watchlist_items;
drop trigger org_check_watch_with on public.watchlist_items;
drop trigger org_guard_watch_with_choice on public.watch_with_choices;
drop table public.collection_memberships;
drop table public.personal_collections;
drop table public.watch_with_choices;
drop function private.org_auto_membership();
drop function private.org_check_watch_with();
drop function private.org_guard_watch_with_choice();
drop function private.org_bootstrap(uuid);
drop index public.watchlist_items_id_owner_film_key;
alter table public.watchlist_items drop column is_film;
alter table public.tv_shows drop constraint tv_shows_id_owner_key;
drop function public.match_tv_row(uuid, jsonb, jsonb, jsonb);

-- ── match_tv_row as in db/rpc.sql (verbatim) ──
create or replace function public.match_tv_row(p_row_id uuid, p_target jsonb, p_patch jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('match_tv_row', 'shadow', 'authoritative', 'final');
  r public.watchlist_items;
  v_tmdb integer;
  v_num integer;
  v_label text;
  v_key text;
  v_l public.tv_shows;
  v_t public.tv_shows;
  v_conflict uuid;
  v_target_show uuid;
begin
  begin
    v_tmdb := (p_target ->> 'tmdb_id')::integer;
    v_num := (p_patch ->> 'season_number')::integer;
  exception when others then raise exception 'invalid_input: tmdb_id / season_number' using errcode = '22023'; end;
  v_label := case when v_num = 0 then 'Specials' else 'Season ' || v_num end;
  v_key := lower(btrim(coalesce(p_patch ->> 'title', '')));
  if v_tmdb is null or v_num is null or v_num < 0 or v_key = ''
     or p_patch ->> 'media_type' is distinct from 'tv' or (p_patch ->> 'tmdb_id')::integer is distinct from v_tmdb
     or p_patch ->> 'season' is distinct from v_label or p_patch ->> 'item_key' is distinct from v_key || '|' || lower(v_label)
     or not private.tv_valid_date(p_patch ->> 'date_sort') then
    raise exception 'invalid_input: match patch %', p_patch using errcode = '22023';
  end if;

  select * into r from public.watchlist_items
  where id = p_row_id and user_id = v_owner and collection = any(private.tv_collections())
    and tmdb_id is null and media_type is null and season_number is null;
  if r.id is null then raise exception 'not_found: unidentified row' using errcode = 'P0002'; end if;

  select id into v_conflict from public.watchlist_items
  where user_id = v_owner and collection = r.collection and media_type = 'tv' and tmdb_id = v_tmdb and season_number = v_num;
  if found then raise exception 'match_conflict: identity already on the list as row %', v_conflict using errcode = '23505'; end if;
  select id into v_conflict from public.watchlist_items
  where user_id = v_owner and collection = r.collection and tmdb_id is null and item_key = p_patch ->> 'item_key' and id <> r.id;
  if found then raise exception 'match_conflict: item_key already used by row %', v_conflict using errcode = '23505'; end if;

  if r.show_id is not null then
    select * into v_l from public.tv_shows where id = r.show_id and user_id = v_owner for update;
  end if;
  select * into v_t from public.tv_shows
  where user_id = v_owner and collection = r.collection and tmdb_id = v_tmdb for update;

  if v_t.id is not null then
    if v_stage in ('authoritative', 'final') and v_l.id is not null and v_t.status <> v_l.status then
      return jsonb_build_object('blocked', true, 'legacy_status', v_l.status, 'target_status', v_t.status,
                                'legacy_show_id', v_l.id, 'target_show_id', v_t.id);
    end if;
    v_target_show := v_t.id;
  elsif v_l.id is not null and not exists (select 1 from public.watchlist_items where show_id = v_l.id and id <> r.id) then
    update public.tv_shows set tmdb_id = v_tmdb, title = btrim(p_patch ->> 'title'), show_key = v_key where id = v_l.id;
    v_target_show := v_l.id;
  else
    insert into public.tv_shows (collection, title, show_key, tmdb_id, status)
    values (r.collection, btrim(p_patch ->> 'title'), v_key, v_tmdb, coalesce(v_l.status, 'confirmed'))
    returning id into v_target_show;
  end if;

  update public.watchlist_items set
    title = p_patch ->> 'title', season = p_patch ->> 'season', item_key = p_patch ->> 'item_key',
    theme = coalesce(p_patch ->> 'theme', theme), display_date = coalesce(p_patch ->> 'display_date', display_date),
    date_sort = p_patch ->> 'date_sort', media_type = 'tv', tmdb_id = v_tmdb, season_number = v_num, show_id = v_target_show
  where id = r.id and user_id = v_owner and tmdb_id is null and media_type is null and season_number is null
  returning * into r;
  if r.id is null then raise exception 'match_conflict: the row changed; try again' using errcode = '40001'; end if;

  if v_l.id is not null and v_l.id <> v_target_show and not exists (select 1 from public.watchlist_items where show_id = v_l.id) then
    delete from public.tv_shows where id = v_l.id;
  end if;
  if v_stage in ('shadow', 'authoritative') then
    insert into public.othertv_shows (tmdb_id, title, network, collection)
    values (v_tmdb, btrim(p_patch ->> 'title'), coalesce(p_target ->> 'network', p_patch ->> 'theme', ''), r.collection)
    on conflict (user_id, collection, tmdb_id) do nothing;
  end if;
  if v_stage = 'authoritative' then
    perform private.tv_project_legacy_status(v_target_show);
    if v_l.id is not null and v_l.id <> v_target_show and exists (select 1 from public.tv_shows where id = v_l.id) then
      perform private.tv_project_legacy_status(v_l.id);
    end if;
  end if;
  return jsonb_build_object('blocked', false, 'row', to_jsonb(r), 'show_id', v_target_show);
end $$;
revoke all on function public.match_tv_row(uuid, jsonb, jsonb) from public;
grant execute on function public.match_tv_row(uuid, jsonb, jsonb) to anon, authenticated;

-- ── restore_backup as in db/restore_backup.sql (verbatim) ──
create or replace function public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_stage();
  v_version text := p_backup ->> 'formatVersion';
  v_tables jsonb := p_backup -> 'tables';
  v_counts jsonb := p_backup -> 'rowCounts';
  v_item_cols jsonb := jsonb_build_array('id','collection','item_key','title','season','theme','display_date',
    'date_sort','watched','status','created_at','watch_with','collections','tmdb_collection_id',
    'tmdb_collection_name','media_type','tmdb_id','season_number');
  v_expected jsonb;
  v_table text;
  v_has_shows boolean := v_stage <> 'ownership';
  v_constraint text;
  v_n jsonb := '{}';
  v_k int;
begin
  if p_backup ->> 'format' is distinct from 'watchlist-tracker-backup' then
    raise exception 'restore_invalid: not a Watchlist backup' using errcode = '22023';
  end if;
  if v_version = '1' then
    if v_stage in ('authoritative', 'final') then
      raise exception 'restore_invalid: format 1 backups predate TV shows and can no longer be restored'
        using errcode = '22023';
    end if;
    if v_stage in ('tv_schema', 'shadow') and not p_allow_v1_reset then
      raise exception 'restore_needs_confirmation: a format 1 backup empties your TV shows; confirm to continue'
        using errcode = '22023';
    end if;
  elsif v_version = '2' then
    if v_stage = 'ownership' then
      raise exception 'restore_invalid: format 2 backups need the TV-show schema' using errcode = '22023';
    end if;
  else
    raise exception 'restore_invalid: unsupported backup format %', coalesce(v_version, '(none)') using errcode = '22023';
  end if;

  v_expected := jsonb_build_object(
    'watchlist_items', case when v_version = '2' then v_item_cols || '["show_id","skipped"]'::jsonb else v_item_cols end,
    'othertv_shows', jsonb_build_array('id','tmdb_id','title','network','created_at','collection'),
    'custom_collections', jsonb_build_array('id','name','tmdb_person_id','created_at','role'));
  if v_version = '2' then
    v_expected := v_expected || jsonb_build_object('tv_shows',
      jsonb_build_array('id','collection','title','show_key','tmdb_id','status','created_at'));
  end if;

  if jsonb_typeof(v_tables) is distinct from 'object' or jsonb_typeof(v_counts) is distinct from 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(v_tables) k)
        is distinct from (select array_agg(k order by k collate "C") from jsonb_object_keys(v_expected) k) then
    raise exception 'restore_invalid: unexpected set of tables for format %', v_version using errcode = '22023';
  end if;
  for v_table in select jsonb_object_keys(v_expected) loop
    if jsonb_typeof(v_tables -> v_table) is distinct from 'array' then
      raise exception 'restore_invalid: % is not a list of rows', v_table using errcode = '22023';
    end if;
    if (v_counts ->> v_table) is distinct from jsonb_array_length(v_tables -> v_table)::text then
      raise exception 'restore_invalid: rowCounts.% does not match its rows', v_table using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_tables -> v_table) r
      where jsonb_typeof(r) is distinct from 'object'
         or (select array_agg(k order by k collate "C") from jsonb_object_keys(r) k)
            is distinct from (select array_agg(x order by x collate "C") from jsonb_array_elements_text(v_expected -> v_table) x)
    ) then
      raise exception 'restore_invalid: a % row does not have exactly the expected columns', v_table using errcode = '22023';
    end if;
  end loop;

  -- Ids that belong to another owner (visible before sign-in; after sign-in the
  -- access rules hide them and the primary key catches the same case below).
  if exists (select 1 from public.watchlist_items w join jsonb_array_elements(v_tables -> 'watchlist_items') r
               on w.id = (r ->> 'id')::uuid where w.user_id <> v_owner)
     or exists (select 1 from public.othertv_shows w join jsonb_array_elements(v_tables -> 'othertv_shows') r
               on w.id = (r ->> 'id')::uuid where w.user_id <> v_owner)
     or exists (select 1 from public.custom_collections w join jsonb_array_elements(v_tables -> 'custom_collections') r
               on w.id = (r ->> 'id')::uuid where w.user_id <> v_owner)
     or (v_version = '2' and exists (select 1 from public.tv_shows w join jsonb_array_elements(v_tables -> 'tv_shows') r
               on w.id = (r ->> 'id')::uuid where w.user_id <> v_owner)) then
    raise exception 'restore_id_collision: this backup contains ids already owned by another user; restoring it would keep those ids and break user isolation, so nothing was changed'
      using errcode = '23505';
  end if;

  delete from public.watchlist_items where user_id = v_owner;
  if v_has_shows then delete from public.tv_shows where user_id = v_owner; end if;
  delete from public.othertv_shows where user_id = v_owner;
  delete from public.custom_collections where user_id = v_owner;

  begin
    if v_version = '2' then
      insert into public.tv_shows (id, collection, title, show_key, tmdb_id, status, created_at)
      select id, collection, title, show_key, tmdb_id, status, created_at
      from jsonb_to_recordset(v_tables -> 'tv_shows') as x(id uuid, collection text, title text, show_key text,
        tmdb_id integer, status text, created_at timestamptz);
      get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('tv_shows', v_k);

      insert into public.watchlist_items (id, collection, item_key, title, season, theme, display_date, date_sort,
        watched, status, created_at, watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type,
        tmdb_id, season_number, show_id, skipped)
      select id, collection, item_key, title, season, theme, display_date, date_sort, watched, status, created_at,
        watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number,
        show_id, skipped
      from jsonb_to_recordset(v_tables -> 'watchlist_items') as x(id uuid, collection text, item_key text, title text,
        season text, theme text, display_date text, date_sort text, watched boolean, status text, created_at timestamptz,
        watch_with text[], collections text[], tmdb_collection_id integer, tmdb_collection_name text, media_type text,
        tmdb_id integer, season_number integer, show_id uuid, skipped boolean);
    else
      insert into public.watchlist_items (id, collection, item_key, title, season, theme, display_date, date_sort,
        watched, status, created_at, watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type,
        tmdb_id, season_number)
      select id, collection, item_key, title, season, theme, display_date, date_sort, watched, status, created_at,
        watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number
      from jsonb_to_recordset(v_tables -> 'watchlist_items') as x(id uuid, collection text, item_key text, title text,
        season text, theme text, display_date text, date_sort text, watched boolean, status text, created_at timestamptz,
        watch_with text[], collections text[], tmdb_collection_id integer, tmdb_collection_name text, media_type text,
        tmdb_id integer, season_number integer);
    end if;
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('watchlist_items', v_k);

    insert into public.othertv_shows (id, tmdb_id, title, network, created_at, collection)
    select id, tmdb_id, title, network, created_at, collection
    from jsonb_to_recordset(v_tables -> 'othertv_shows') as x(id uuid, tmdb_id integer, title text, network text,
      created_at timestamptz, collection text);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('othertv_shows', v_k);

    insert into public.custom_collections (id, name, tmdb_person_id, created_at, role)
    select id, name, tmdb_person_id, created_at, role
    from jsonb_to_recordset(v_tables -> 'custom_collections') as x(id uuid, name text, tmdb_person_id integer,
      created_at timestamptz, role text);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('custom_collections', v_k);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint like '%\_pkey' then
      raise exception 'restore_id_collision: this backup contains ids already owned by another user; restoring it would keep those ids and break user isolation, so nothing was changed'
        using errcode = '23505';
    end if;
    raise;
  end;

  if v_stage in ('authoritative', 'final') and exists (
    select 1 from public.watchlist_items
    where user_id = v_owner and show_id is null and private.tv_is_tv_row(collection, media_type, season)
  ) then
    raise exception 'restore_invalid: every TV season must belong to a show in this backup' using errcode = '22023';
  end if;

  return jsonb_build_object('formatVersion', v_version::int, 'restored', v_n);
end
$$;

revoke all on function public.restore_backup(jsonb, boolean) from public;
grant execute on function public.restore_backup(jsonb, boolean) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
