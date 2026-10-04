-- Owner-scoped transactional restore (installed in Phase 1b, replacing the
-- Phase 0 version; same signature). Restores the backup into the current
-- owner's list only:
--   * backup files carry no user_id; every restored row is owned by
--     private.current_owner_id() through the column defaults;
--   * object ids and created_at are kept exactly;
--   * if any id in the backup already belongs to another owner, the restore is
--     refused, because keeping that id would break user isolation;
--   * everything happens in one transaction, so any failure changes nothing.
-- Accepted formats depend on the migration stage:
--   ownership                 → v1
--   tv_schema, shadow         → v2; v1 only with p_allow_v1_reset (empties the
--                               owner's shows; run private.tv_backfill afterwards)
--   authoritative, final      → v2 only, and every TV row must be linked
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
