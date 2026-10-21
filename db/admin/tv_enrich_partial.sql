-- Admin enrichment extensions (after EP1): two admin-only functions beside the unchanged strict
-- private.tv_enrich_show. One transaction, run as postgres on a contracted-ep1 database.
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.enrich_run', '<a fresh run id, recorded before running>', false);
--
-- private.tv_enrich_show_partial(p_owner, p_show_id, p_expected_title, p_tmdb_id, p_seasons, p_unmatched, p_apply)
--   Gives an unmatched catalog show a TMDB identity while some of its seasons are deliberately left
--   unmatched (a provisional season TMDB doesn't list yet). Every season of the show is accounted for:
--   p_seasons matches [{row_id, season, season_number}], p_unmatched leaves [{row_id, season}] as they
--   are; both lists are non-empty and disjoint and together are exactly the show's seasons. No matched
--   season may take the plain number of a season left unmatched ("Season 10" left → nothing matched to 10).
-- private.tv_enrich_season(p_owner, p_show_id, p_expected_title, p_tmdb_id, p_row_id, p_expected_season,
--   p_season_number, p_apply)
--   Later: gives one unmatched season of a show already matched to the same TMDB show its identity.
--   Only plain "Season N" → N and "Specials" → 0; any other label or number is refused. A season that has
--   an identity is never rematched or moved.
--
-- Both: the owner is named explicitly and must be a library member owning the show; the show, then every
-- season of it, is locked before anything is checked; every check runs on the dry run (p_apply false, a
-- preview) and again inside the applying call, in the same transaction as the writes. Only the TMDB
-- identity fields change (tv_shows.tmdb_id; a season's media_type, tmdb_id, season_number): viewing state,
-- curation, memberships, catalog links and episode marks are untouched and are verified unchanged.
-- Any refusal changes nothing. Neither function is executable by an application role.
--
-- Completion: this install committed if and only if private.migration_runs holds its run id (a fresh read
-- in a separate execution). Never rerun to find out; a rerun is refused once this committed.
begin;
select set_config('application_name', 'watchlist-enrich-' || coalesce(nullif(current_setting('watchlist.enrich_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;

-- ── 1. Preconditions ───────────────────────────────────────────────────────────
create temp table en_ctx on commit drop as
select nullif(current_setting('watchlist.enrich_run', true), '') as run_id,
  (select md5(prosrc) || ':' || coalesce(array_to_string(proacl, ','), '') || ':' || prosecdef::text || ':' || coalesce(array_to_string(proconfig, ','), '')
   from pg_proc where oid = to_regprocedure('private.tv_enrich_show(uuid, text, integer, jsonb, boolean)')) as strict_sig;
do $$
declare c record;
begin
  select * into c from en_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'enrich-partial: set watchlist.enrich_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if private.tv_stage() <> 'final' then raise exception 'enrich-partial: expected stage final, found %', private.tv_stage(); end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-ep1' then
    raise exception 'enrich-partial: expected phase contracted-ep1, found %', public.stage5_capabilities() ->> 'phase';
  end if;
  if c.strict_sig is null then raise exception 'enrich-partial: private.tv_enrich_show is missing; nothing was changed'; end if;
  if to_regprocedure('private.tv_enrich_show_partial(uuid, uuid, text, integer, jsonb, jsonb, boolean)') is not null
     or to_regprocedure('private.tv_enrich_season(uuid, uuid, text, integer, uuid, text, integer, boolean)') is not null then
    raise exception 'enrich-partial: already installed; nothing was changed';
  end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'enrich-partial: run id % is already recorded; use a fresh one', c.run_id; end if;
end $$;

-- ── 2. Partial enrichment ──────────────────────────────────────────────────────
create function private.tv_enrich_show_partial(p_owner uuid, p_show_id uuid, p_expected_title text, p_tmdb_id integer,
  p_seasons jsonb, p_unmatched jsonb, p_apply boolean default false)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_show public.tv_shows;
  v_catalog text;
  v_rows uuid[] := '{}';
  v_nums int[] := '{}';
  v_left uuid[] := '{}';
  v_left_nums int[] := '{}';
  v_plan jsonb := '[]';
  v_kept jsonb := '[]';
  v_before jsonb;
  v_count int;
  v_n int;
  e jsonb;
  r public.watchlist_items;
  v_conflict uuid;
begin
  if private.tv_stage() <> 'final' then raise exception 'enrich: not available in stage %', private.tv_stage(); end if;
  if p_owner is null or not exists (select 1 from private.library_members m where m.user_id = p_owner) then
    raise exception 'enrich: % is not a library member', p_owner;
  end if;
  if p_tmdb_id is null or p_tmdb_id <= 0 then raise exception 'enrich: tmdb_id required'; end if;
  if jsonb_typeof(p_seasons) is distinct from 'array' or jsonb_array_length(p_seasons) = 0 then
    raise exception 'enrich: at least one season must be matched';
  end if;
  if jsonb_typeof(p_unmatched) is distinct from 'array' or jsonb_array_length(p_unmatched) = 0 then
    raise exception 'enrich: partial enrichment leaves at least one season unmatched; to match every season use private.tv_enrich_show';
  end if;

  -- Locks first: the show, then every season of it.
  select * into v_show from public.tv_shows where id = p_show_id for update;
  if not found then raise exception 'enrich: show % not found', p_show_id; end if;
  perform 1 from public.watchlist_items w where w.show_id = v_show.id order by w.id for update;
  if v_show.user_id is distinct from p_owner then raise exception 'enrich: show % belongs to another owner', p_show_id; end if;
  if v_show.title is distinct from p_expected_title then
    raise exception 'enrich: show % is "%", not "%"', p_show_id, v_show.title, p_expected_title;
  end if;
  if v_show.tmdb_id is not null then raise exception 'enrich: "%" already has TMDB id %', v_show.title, v_show.tmdb_id; end if;
  v_catalog := private.lib_show_catalog(v_show.id);
  select id into v_conflict from public.tv_shows where user_id = p_owner and tmdb_id = p_tmdb_id;
  if found then raise exception 'enrich: TMDB % is already show %', p_tmdb_id, v_conflict; end if;

  -- The seasons matched (the strict function's checks).
  for e in select * from jsonb_array_elements(p_seasons) loop
    begin v_n := (e ->> 'season_number')::int;
    exception when others then raise exception 'enrich: season_number in %', e; end;
    if v_n is null or v_n < 0 then raise exception 'enrich: season_number in %', e; end if;
    begin select * into r from public.watchlist_items where id = (e ->> 'row_id')::uuid;
    exception when invalid_text_representation then raise exception 'enrich: row_id in %', e; end;
    if r.id is null then raise exception 'enrich: row % not found', e ->> 'row_id'; end if;
    if r.show_id is distinct from v_show.id or r.user_id is distinct from p_owner then
      raise exception 'enrich: row % is not a season of "%"', r.id, v_show.title;
    end if;
    if r.season is distinct from (e ->> 'season') then raise exception 'enrich: row % is "%", not "%"', r.id, r.season, e ->> 'season'; end if;
    if r.media_type is not null or r.tmdb_id is not null or r.season_number is not null or r.is_film then
      raise exception 'enrich: row % is not an unmatched TV season', r.id;
    end if;
    if r.id = any(v_rows) then raise exception 'enrich: row % listed twice', r.id; end if;
    if v_n = any(v_nums) then raise exception 'enrich: season_number % listed twice', v_n; end if;
    select id into v_conflict from public.watchlist_items
    where user_id = p_owner and media_type = 'tv' and tmdb_id = p_tmdb_id and season_number = v_n;
    if found then raise exception 'enrich: TMDB % season % is already row %', p_tmdb_id, v_n, v_conflict; end if;
    v_rows := v_rows || r.id;
    v_nums := v_nums || v_n;
    v_plan := v_plan || jsonb_build_object('row_id', r.id, 'season', r.season, 'item_key', r.item_key, 'season_number', v_n);
  end loop;

  -- The seasons deliberately left unmatched.
  for e in select * from jsonb_array_elements(p_unmatched) loop
    begin select * into r from public.watchlist_items where id = (e ->> 'row_id')::uuid;
    exception when invalid_text_representation then raise exception 'enrich: row_id in %', e; end;
    if r.id is null then raise exception 'enrich: row % not found', e ->> 'row_id'; end if;
    if r.show_id is distinct from v_show.id or r.user_id is distinct from p_owner then
      raise exception 'enrich: row % is not a season of "%"', r.id, v_show.title;
    end if;
    if r.season is distinct from (e ->> 'season') then raise exception 'enrich: row % is "%", not "%"', r.id, r.season, e ->> 'season'; end if;
    if r.media_type is not null or r.tmdb_id is not null or r.season_number is not null or r.is_film then
      raise exception 'enrich: row % is not an unmatched TV season', r.id;
    end if;
    if r.id = any(v_rows) then raise exception 'enrich: row % is both matched and left unmatched', r.id; end if;
    if r.id = any(v_left) then raise exception 'enrich: row % listed twice', r.id; end if;
    v_left := v_left || r.id;
    v_n := case when r.season ~ '^Season [1-9][0-9]{0,3}$' then substring(r.season from 8)::int when r.season = 'Specials' then 0 end;
    if v_n is not null then v_left_nums := v_left_nums || v_n; end if;
    v_kept := v_kept || jsonb_build_object('row_id', r.id, 'season', r.season, 'item_key', r.item_key);
  end loop;
  if v_nums && v_left_nums then
    raise exception 'enrich: a matched season takes the number of a season left unmatched (%)',
      (select array_agg(x) from unnest(v_nums) x where x = any(v_left_nums));
  end if;
  select count(*) into v_count from public.watchlist_items where show_id = v_show.id;
  if v_count <> cardinality(v_rows) + cardinality(v_left) then
    raise exception 'enrich: "%" has % seasons, % matched and % left unmatched; every season must be accounted for',
      v_show.title, v_count, cardinality(v_rows), cardinality(v_left);
  end if;

  if p_apply then
    select jsonb_agg(to_jsonb(w) order by w.id) into v_before from public.watchlist_items w where w.id = any(v_left);
    perform private.lib_write_on();
    update public.tv_shows set tmdb_id = p_tmdb_id where id = v_show.id and tmdb_id is null;
    get diagnostics v_count = row_count;
    if v_count <> 1 then raise exception 'enrich: show changed meanwhile'; end if;
    for i in 1 .. cardinality(v_rows) loop
      update public.watchlist_items set media_type = 'tv', tmdb_id = p_tmdb_id, season_number = v_nums[i]
      where id = v_rows[i] and media_type is null and tmdb_id is null and season_number is null;
      get diagnostics v_count = row_count;
      if v_count <> 1 then raise exception 'enrich: row % changed meanwhile', v_rows[i]; end if;
    end loop;
    if (select jsonb_agg(to_jsonb(w) order by w.id) from public.watchlist_items w where w.id = any(v_left)) is distinct from v_before then
      raise exception 'enrich: a season left unmatched changed';
    end if;
  end if;

  return jsonb_build_object('applied', p_apply, 'owner', p_owner, 'show_id', v_show.id, 'title', v_show.title, 'catalog', v_catalog,
    'status', v_show.status, 'tmdb_id', p_tmdb_id, 'seasons', v_plan, 'unmatched', v_kept);
end $$;

-- ── 3. Later-season matching ───────────────────────────────────────────────────
create function private.tv_enrich_season(p_owner uuid, p_show_id uuid, p_expected_title text, p_tmdb_id integer,
  p_row_id uuid, p_expected_season text, p_season_number integer, p_apply boolean default false)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_show public.tv_shows;
  r public.watchlist_items;
  v_before jsonb;
  v_count int;
  v_conflict uuid;
  v_ident text[] := array['media_type', 'tmdb_id', 'season_number'];
begin
  if private.tv_stage() <> 'final' then raise exception 'enrich: not available in stage %', private.tv_stage(); end if;
  if p_owner is null or not exists (select 1 from private.library_members m where m.user_id = p_owner) then
    raise exception 'enrich: % is not a library member', p_owner;
  end if;
  if p_tmdb_id is null or p_tmdb_id <= 0 then raise exception 'enrich: tmdb_id required'; end if;
  if p_season_number is null or p_season_number < 0 then raise exception 'enrich: season_number required'; end if;

  -- Locks first: the show, then every season of it.
  select * into v_show from public.tv_shows where id = p_show_id for update;
  if not found then raise exception 'enrich: show % not found', p_show_id; end if;
  perform 1 from public.watchlist_items w where w.show_id = v_show.id order by w.id for update;
  if v_show.user_id is distinct from p_owner then raise exception 'enrich: show % belongs to another owner', p_show_id; end if;
  if v_show.title is distinct from p_expected_title then
    raise exception 'enrich: show % is "%", not "%"', p_show_id, v_show.title, p_expected_title;
  end if;
  if v_show.tmdb_id is null then
    raise exception 'enrich: "%" is not matched to TMDB; use private.tv_enrich_show or private.tv_enrich_show_partial', v_show.title;
  end if;
  if v_show.tmdb_id is distinct from p_tmdb_id then
    raise exception 'enrich: "%" is matched to TMDB %, not %', v_show.title, v_show.tmdb_id, p_tmdb_id;
  end if;

  select * into r from public.watchlist_items where id = p_row_id;
  if r.id is null then raise exception 'enrich: row % not found', p_row_id; end if;
  if r.show_id is distinct from v_show.id or r.user_id is distinct from p_owner then
    raise exception 'enrich: row % is not a season of "%"', r.id, v_show.title;
  end if;
  if r.season is distinct from p_expected_season then raise exception 'enrich: row % is "%", not "%"', r.id, r.season, p_expected_season; end if;
  if r.media_type is not null or r.tmdb_id is not null or r.season_number is not null or r.is_film then
    raise exception 'enrich: row % already has an identity (or is not a TV season); rematching or moving one is refused', r.id;
  end if;
  -- Only a plain label maps, to its own number.
  if not ((p_season_number = 0 and r.season = 'Specials')
          or (p_season_number > 0 and r.season = 'Season ' || p_season_number)) then
    raise exception 'enrich: "%" can''t be matched to season %: only "Season N" → N and "Specials" → 0', r.season, p_season_number;
  end if;
  select id into v_conflict from public.watchlist_items
  where user_id = p_owner and media_type = 'tv' and tmdb_id = p_tmdb_id and season_number = p_season_number;
  if found then raise exception 'enrich: TMDB % season % is already row %', p_tmdb_id, p_season_number, v_conflict; end if;

  if p_apply then
    v_before := to_jsonb(r) - v_ident;
    perform private.lib_write_on();
    update public.watchlist_items set media_type = 'tv', tmdb_id = p_tmdb_id, season_number = p_season_number
    where id = r.id and media_type is null and tmdb_id is null and season_number is null;
    get diagnostics v_count = row_count;
    if v_count <> 1 then raise exception 'enrich: row % changed meanwhile', r.id; end if;
    if (select to_jsonb(w) - v_ident from public.watchlist_items w where w.id = r.id) is distinct from v_before then
      raise exception 'enrich: row % changed beyond its identity', r.id;
    end if;
  end if;

  return jsonb_build_object('applied', p_apply, 'owner', p_owner, 'show_id', v_show.id, 'title', v_show.title,
    'catalog', private.lib_show_catalog(v_show.id), 'tmdb_id', p_tmdb_id,
    'season', jsonb_build_object('row_id', r.id, 'season', r.season, 'item_key', r.item_key, 'season_number', p_season_number));
end $$;

-- ── 4. Grants: admin only ──────────────────────────────────────────────────────
revoke all on function private.tv_enrich_show_partial(uuid, uuid, text, integer, jsonb, jsonb, boolean),
  private.tv_enrich_season(uuid, uuid, text, integer, uuid, text, integer, boolean) from public, anon, authenticated;

-- ── 5. The run record, then verify before commit ───────────────────────────────
insert into private.migration_runs (run_id, migration) select run_id, 'enrich-partial' from en_ctx;
do $$
declare f regprocedure;
begin
  foreach f in array array['private.tv_enrich_show_partial(uuid, uuid, text, integer, jsonb, jsonb, boolean)'::regprocedure,
                           'private.tv_enrich_season(uuid, uuid, text, integer, uuid, text, integer, boolean)'::regprocedure] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = f and a.grantee = 0) then
      raise exception 'enrich-partial: % is executable by an application role or PUBLIC', f;
    end if;
    if (select prosecdef from pg_proc where oid = f) then raise exception 'enrich-partial: % must not be SECURITY DEFINER', f; end if;
  end loop;
  if (select md5(prosrc) || ':' || coalesce(array_to_string(proacl, ','), '') || ':' || prosecdef::text || ':' || coalesce(array_to_string(proconfig, ','), '')
      from pg_proc where oid = 'private.tv_enrich_show(uuid, text, integer, jsonb, boolean)'::regprocedure) is distinct from (select strict_sig from en_ctx) then
    raise exception 'enrich-partial: private.tv_enrich_show changed';
  end if;
  if not exists (select 1 from private.migration_runs r join en_ctx c on c.run_id = r.run_id where r.migration = 'enrich-partial') then
    raise exception 'enrich-partial: the run record does not hold this run';
  end if;
end $$;

select 'ENRICH-PARTIAL|' || (select run_id from en_ctx) as result;
commit;
