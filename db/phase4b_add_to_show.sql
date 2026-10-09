-- Stage 4b: add seasons to one existing show (never to another, never by
-- creating one), and create one genuinely new show (never by joining one). Two
-- functions, each one transaction.
--   * public.add_tv_seasons_to_show(p_show_id, p_expected, p_seasons): the app's
--     path for seasons added to a show that is already on the list (Add season,
--     a search result already on the list, Refresh shows). It locks that show,
--     checks that it still has the collection, TMDB id and show key the page
--     showed (p_expected), then runs the existing public.add_tv_seasons for it in
--     the same transaction, and keeps the result only if that call used this
--     show and created none. Otherwise it refuses and nothing is written:
--       target_missing  the show is gone (for example its last season was deleted),
--       target_changed  it is there but differs from what the page showed, or the
--                       seasons would have gone to another show or a new one.
--   * Season rules are add_tv_seasons' own, unchanged: labels, keys and
--     identities, existing and rejected seasons, the enriched-show join of a
--     TMDB-matched built-in show, and the Complete -> On List reopen. No show is
--     created, so the membership trigger never fires.
--   * Which seasons a show takes: an identified show outside the built-in
--     catalogs (Disney+, 90 Day, Sheridan) takes TMDB seasons (season_number);
--     an identified built-in show and a legacy show take seasons by label. An
--     identified built-in show is passed to add_tv_seasons without its TMDB id,
--     so its enriched-show join decides ("Season N" becomes season N, any other
--     label is held for review).
--   * public.create_tv_show(p_show, p_seasons): the app's path for a new show. It
--     creates the show where new shows go ('othertv') and adds the seasons to it,
--     or refuses (show_exists, nothing written) when a show with the same TMDB
--     identity is already anywhere in the library, or an unmatched show with the
--     same key is already where new shows go (also when it appears while this
--     runs: the unique show indexes decide). It never adds seasons to, or changes,
--     an existing show; adding to an existing show stays add_tv_seasons_to_show.
--     Every requested season must be added, or nothing is (create_conflict).
-- add_tv_seasons_to_show guarantees the parent, not exactly-once execution: a request that runs
-- again after its season was deleted (or a restore removed it) can add it again.
-- No table, column, index, policy, trigger, grant on a table or row changes.
-- add_tv_seasons, the Stage 4a functions, seed_tv_defaults' refusal and the date
-- guard are unchanged. Not part of db/rpc.sql (which refuses on a 4a database).
-- Run as postgres at stage final with Stage 4a installed.
-- Rollback (refuses unless installed): db/rollback/phase4b.sql.
begin;
set local lock_timeout = '5s';

do $$ begin
  if private.tv_stage() <> 'final' then raise exception 'phase4b: expected stage final, found %', private.tv_stage(); end if;
  if to_regprocedure('public.catalog_apply(text, jsonb, text)') is null then raise exception 'phase4b: Stage 4a is not installed'; end if;
  if to_regprocedure('public.add_tv_seasons_to_show(uuid, jsonb, jsonb)') is not null
     or to_regprocedure('public.create_tv_show(jsonb, jsonb)') is not null then
    raise exception 'phase4b: already applied (add_tv_seasons_to_show or create_tv_show exists)';
  end if;
end $$;

create function public.add_tv_seasons_to_show(p_show_id uuid, p_expected jsonb, p_seasons jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('add_tv_seasons_to_show', 'final');
  v_show public.tv_shows;
  v_exp_tmdb integer;
  v_by_number boolean;
  v_has_number boolean;
  s jsonb;
  v_res jsonb;
begin
  if p_show_id is null or jsonb_typeof(p_expected) is distinct from 'object'
     or coalesce(p_expected ->> 'collection', '') = '' or coalesce(p_expected ->> 'show_key', '') = '' then
    raise exception 'invalid_input: the show id and the show as the page showed it (collection, tmdb_id, show_key) are required'
      using errcode = '22023';
  end if;
  begin v_exp_tmdb := (p_expected ->> 'tmdb_id')::integer;
  exception when others then raise exception 'invalid_input: expected tmdb_id' using errcode = '22023'; end;
  if jsonb_typeof(p_seasons) is distinct from 'array' or jsonb_array_length(p_seasons) = 0 then
    raise exception 'invalid_input: seasons must be a non-empty list' using errcode = '22023';
  end if;

  -- The show, locked (the same row lock add_tv_seasons, delete_tv_season and
  -- match_tv_row take), then compared with what the page showed.
  select * into v_show from public.tv_shows where id = p_show_id and user_id = v_owner for update;
  if not found then
    raise exception 'target_missing: This show is no longer on your list, so nothing was added.' using errcode = 'P0001';
  end if;
  if v_show.collection is distinct from p_expected ->> 'collection' or v_show.tmdb_id is distinct from v_exp_tmdb
     or v_show.show_key is distinct from p_expected ->> 'show_key' then
    raise exception 'target_changed: This show changed since you chose it, so nothing was added. Look at it again.' using errcode = 'P0001';
  end if;

  -- TMDB seasons only for an identified show outside the built-in catalogs.
  v_by_number := v_show.tmdb_id is not null and not (v_show.collection = any(private.tv_builtin_collections()));
  for s in select * from jsonb_array_elements(p_seasons) loop
    v_has_number := jsonb_typeof(s) = 'object' and s ? 'season_number' and s -> 'season_number' <> 'null'::jsonb;
    if v_has_number <> v_by_number then
      raise exception 'invalid_input: this show takes %', case when v_by_number then 'TMDB seasons (season_number)' else 'seasons by label (no season_number)' end
        using errcode = '22023';
    end if;
  end loop;

  v_res := public.add_tv_seasons(v_show.collection,
    jsonb_build_object('tmdb_id', case when v_by_number then v_show.tmdb_id end, 'title', v_show.title,
                       'show_key', v_show.show_key, 'network', coalesce(p_expected ->> 'network', '')),
    p_seasons);

  -- Kept only if the seasons went to this show and no show was created; otherwise
  -- the whole call (and anything it wrote) is rolled back.
  if (v_res ->> 'show_id') is distinct from p_show_id::text or coalesce((v_res ->> 'show_created')::boolean, true) then
    raise exception 'target_changed: These seasons would not have been added to the show you chose, so nothing was added. Look at it again.'
      using errcode = 'P0001';
  end if;
  return v_res;
end $$;

create function public.create_tv_show(p_show jsonb, p_seasons jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('create_tv_show', 'final');
  v_coll constant text := 'othertv'; -- where new shows go (library.js LIBRARY_NEW_TV)
  v_tmdb integer;
  v_title text := btrim(coalesce(p_show ->> 'title', ''));
  v_key text := btrim(coalesce(p_show ->> 'show_key', ''));
  v_init text := coalesce(p_show ->> 'initial_status', 'confirmed');
  v_id uuid;
  v_res jsonb;
begin
  if jsonb_typeof(p_show) is distinct from 'object' then raise exception 'invalid_input: show' using errcode = '22023'; end if;
  begin v_tmdb := (p_show ->> 'tmdb_id')::integer;
  exception when others then raise exception 'invalid_input: show tmdb_id' using errcode = '22023'; end;
  if v_title = '' or v_key = '' then raise exception 'invalid_input: show title and show_key are required' using errcode = '22023'; end if;
  if not private.tv_valid_status(v_init) then raise exception 'invalid_input: initial_status %', v_init using errcode = '22023'; end if;
  if jsonb_typeof(p_seasons) is distinct from 'array' or jsonb_array_length(p_seasons) = 0 then
    raise exception 'invalid_input: seasons must be a non-empty list' using errcode = '22023';
  end if;

  -- A show with this TMDB identity anywhere in the library is not new.
  if v_tmdb is not null and exists (select 1 from public.tv_shows where user_id = v_owner and tmdb_id = v_tmdb) then
    raise exception 'show_exists: This show is already on your list, so nothing was added. Look at it again.' using errcode = 'P0001';
  end if;
  -- The new show, or nothing: the unique show indexes refuse a second show with this
  -- identity or (unmatched) key where new shows go, including one being added at this
  -- moment (the insert waits for it, then does nothing).
  insert into public.tv_shows (collection, title, show_key, tmdb_id, status)
  values (v_coll, v_title, v_key, v_tmdb, v_init)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    raise exception 'show_exists: This show is already on your list, so nothing was added. Look at it again.' using errcode = 'P0001';
  end if;

  -- Its seasons, by add_tv_seasons' own rules, all of them or none.
  v_res := public.add_tv_seasons(v_coll,
    jsonb_build_object('tmdb_id', v_tmdb, 'title', v_title, 'show_key', v_key, 'network', coalesce(p_show ->> 'network', '')), p_seasons);
  if (v_res ->> 'show_id') is distinct from v_id::text
     or jsonb_array_length(coalesce(v_res -> 'inserted', '[]'::jsonb)) <> jsonb_array_length(p_seasons) then
    raise exception 'create_conflict: Not every season could be added to the new show, so nothing was added. Look at it again.' using errcode = 'P0001';
  end if;
  return v_res || jsonb_build_object('show_created', true);
end $$;

revoke all on function public.add_tv_seasons_to_show(uuid, jsonb, jsonb), public.create_tv_show(jsonb, jsonb) from public;
grant execute on function public.add_tv_seasons_to_show(uuid, jsonb, jsonb), public.create_tv_show(jsonb, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
