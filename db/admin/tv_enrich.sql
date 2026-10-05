-- Admin-only TMDB identity enrichment for one legacy TV show (SQL Editor, as postgres).
-- Adds identity only: tv_shows.tmdb_id, and on each of the show's seasons the TV
-- identity the schema requires together (media_type = 'tv', tmdb_id, season_number).
-- Nothing else changes: title, show_key, item_key, season label, collection, status,
-- watched, skipped, dates, created_at and links stay exactly as they are.
-- Every season of the show must be mapped (an identified show has only identified
-- seasons). p_apply = false (default) validates and returns the exact plan without
-- writing; p_apply = true writes it in the caller's transaction (all or nothing).
-- Not executable by the browser roles.
create or replace function private.tv_enrich_show(
  p_show_id uuid, p_expected_title text, p_tmdb_id integer, p_seasons jsonb, p_apply boolean default false)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_owner uuid := (select bootstrap_owner_id from private.app_owner);
  v_show public.tv_shows;
  v_count int;
  v_rows uuid[] := '{}';
  v_nums int[] := '{}';
  v_plan jsonb := '[]';
  v_n int;
  e jsonb;
  r public.watchlist_items;
  v_conflict uuid;
begin
  if private.tv_stage() not in ('authoritative', 'final') then
    raise exception 'enrich: not available in stage %', private.tv_stage();
  end if;
  if p_tmdb_id is null or p_tmdb_id <= 0 then raise exception 'enrich: tmdb_id required'; end if;

  select * into v_show from public.tv_shows where id = p_show_id for update;
  if not found then raise exception 'enrich: show % not found', p_show_id; end if;
  if v_show.user_id is distinct from v_owner then raise exception 'enrich: show % belongs to another owner', p_show_id; end if;
  if v_show.title is distinct from p_expected_title then
    raise exception 'enrich: show % is "%", not "%"', p_show_id, v_show.title, p_expected_title;
  end if;
  if v_show.tmdb_id is not null then raise exception 'enrich: "%" already has TMDB id %', v_show.title, v_show.tmdb_id; end if;
  select id into v_conflict from public.tv_shows
  where user_id = v_show.user_id and collection = v_show.collection and tmdb_id = p_tmdb_id;
  if found then raise exception 'enrich: TMDB % is already show % in %', p_tmdb_id, v_conflict, v_show.collection; end if;

  if jsonb_typeof(p_seasons) is distinct from 'array' then raise exception 'enrich: seasons must be a list'; end if;
  for e in select * from jsonb_array_elements(p_seasons) loop
    begin v_n := (e ->> 'season_number')::int;
    exception when others then raise exception 'enrich: season_number in %', e; end;
    if v_n is null or v_n < 0 then raise exception 'enrich: season_number in %', e; end if;
    select * into r from public.watchlist_items where id = (e ->> 'row_id')::uuid for update;
    if not found then raise exception 'enrich: row % not found', e ->> 'row_id'; end if;
    if r.show_id is distinct from v_show.id or r.user_id is distinct from v_show.user_id or r.collection is distinct from v_show.collection then
      raise exception 'enrich: row % is not a season of "%"', r.id, v_show.title;
    end if;
    if r.season is distinct from (e ->> 'season') then
      raise exception 'enrich: row % is "%", not "%"', r.id, r.season, e ->> 'season';
    end if;
    if r.media_type is not null or r.tmdb_id is not null or r.season_number is not null
       or not private.tv_is_tv_row(r.collection, r.media_type, r.season) then
      raise exception 'enrich: row % is not a legacy TV season', r.id;
    end if;
    if r.id = any(v_rows) then raise exception 'enrich: row % listed twice', r.id; end if;
    if v_n = any(v_nums) then raise exception 'enrich: season_number % listed twice', v_n; end if;
    select id into v_conflict from public.watchlist_items
    where user_id = r.user_id and collection = r.collection and media_type = 'tv' and tmdb_id = p_tmdb_id and season_number = v_n;
    if found then raise exception 'enrich: TMDB % season % is already row %', p_tmdb_id, v_n, v_conflict; end if;
    v_rows := v_rows || r.id;
    v_nums := v_nums || v_n;
    v_plan := v_plan || jsonb_build_object('row_id', r.id, 'season', r.season, 'item_key', r.item_key, 'season_number', v_n);
  end loop;
  select count(*) into v_count from public.watchlist_items where show_id = v_show.id;
  if v_count <> cardinality(v_rows) then
    raise exception 'enrich: "%" has % seasons, % mapped; every season must be mapped', v_show.title, v_count, cardinality(v_rows);
  end if;

  if p_apply then
    update public.tv_shows set tmdb_id = p_tmdb_id where id = v_show.id and tmdb_id is null;
    get diagnostics v_count = row_count;
    if v_count <> 1 then raise exception 'enrich: show changed meanwhile'; end if;
    for i in 1 .. cardinality(v_rows) loop
      update public.watchlist_items set media_type = 'tv', tmdb_id = p_tmdb_id, season_number = v_nums[i]
      where id = v_rows[i] and media_type is null and tmdb_id is null and season_number is null;
      get diagnostics v_count = row_count;
      if v_count <> 1 then raise exception 'enrich: row % changed meanwhile', v_rows[i]; end if;
    end loop;
  end if;

  return jsonb_build_object('applied', p_apply, 'show_id', v_show.id, 'title', v_show.title, 'collection', v_show.collection,
    'status', v_show.status, 'tmdb_id', p_tmdb_id, 'seasons', v_plan);
end $$;

revoke all on function private.tv_enrich_show(uuid, text, integer, jsonb, boolean) from public, anon, authenticated;
