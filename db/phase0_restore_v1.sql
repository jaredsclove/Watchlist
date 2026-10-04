-- Phase 0: transactional restore for the current (pre-ownership) schema.
-- Replaces the app's table-by-table delete/insert loop with one database call,
-- so a failure part-way through can no longer leave a mixed state: any error
-- rolls back every table. Accepts format v1 only. The app keeps all of its own
-- validation, safety backup and verification; this function re-checks the shape
-- and enforces every database constraint inside the transaction.
--
-- Replaced in Phase 1b by the owner-scoped version (db/restore_backup.sql),
-- which keeps the same signature.
create or replace function public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tables jsonb := p_backup -> 'tables';
  v_counts jsonb := p_backup -> 'rowCounts';
  v_expected jsonb := jsonb_build_object(
    'watchlist_items', jsonb_build_array('id','collection','item_key','title','season','theme','display_date','date_sort',
      'watched','status','created_at','watch_with','collections','tmdb_collection_id','tmdb_collection_name',
      'media_type','tmdb_id','season_number'),
    'othertv_shows', jsonb_build_array('id','tmdb_id','title','network','created_at','collection'),
    'custom_collections', jsonb_build_array('id','name','tmdb_person_id','created_at','role'));
  v_table text;
  v_n_items int; v_n_shows int; v_n_cols int;
begin
  if p_backup ->> 'format' is distinct from 'watchlist-tracker-backup' then
    raise exception 'restore_invalid: not a Watchlist backup' using errcode = '22023';
  end if;
  if p_backup ->> 'formatVersion' is distinct from '1' then
    raise exception 'restore_invalid: this database accepts backup format 1 only (got %)', p_backup ->> 'formatVersion'
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_tables) is distinct from 'object' or jsonb_typeof(v_counts) is distinct from 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(v_tables) k)
        is distinct from array['custom_collections','othertv_shows','watchlist_items'] then
    raise exception 'restore_invalid: expected exactly the tables watchlist_items, othertv_shows, custom_collections'
      using errcode = '22023';
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

  delete from public.watchlist_items where id is not null;
  delete from public.othertv_shows where id is not null;
  delete from public.custom_collections where id is not null;

  insert into public.watchlist_items (id, collection, item_key, title, season, theme, display_date, date_sort, watched,
    status, created_at, watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number)
  select id, collection, item_key, title, season, theme, display_date, date_sort, watched,
    status, created_at, watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number
  from jsonb_to_recordset(v_tables -> 'watchlist_items') as x(id uuid, collection text, item_key text, title text,
    season text, theme text, display_date text, date_sort text, watched boolean, status text, created_at timestamptz,
    watch_with text[], collections text[], tmdb_collection_id integer, tmdb_collection_name text, media_type text,
    tmdb_id integer, season_number integer);
  get diagnostics v_n_items = row_count;

  insert into public.othertv_shows (id, tmdb_id, title, network, created_at, collection)
  select id, tmdb_id, title, network, created_at, collection
  from jsonb_to_recordset(v_tables -> 'othertv_shows') as x(id uuid, tmdb_id integer, title text, network text,
    created_at timestamptz, collection text);
  get diagnostics v_n_shows = row_count;

  insert into public.custom_collections (id, name, tmdb_person_id, created_at, role)
  select id, name, tmdb_person_id, created_at, role
  from jsonb_to_recordset(v_tables -> 'custom_collections') as x(id uuid, name text, tmdb_person_id integer,
    created_at timestamptz, role text);
  get diagnostics v_n_cols = row_count;

  return jsonb_build_object('formatVersion', 1, 'restored', jsonb_build_object(
    'watchlist_items', v_n_items, 'othertv_shows', v_n_shows, 'custom_collections', v_n_cols));
end
$$;

revoke all on function public.restore_backup(jsonb, boolean) from public;
grant execute on function public.restore_backup(jsonb, boolean) to anon, authenticated;
