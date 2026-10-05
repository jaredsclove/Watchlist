-- Browser-facing TV functions (installed in Phase 2, re-runnable).
-- Every function:
--   * runs with the caller's permissions (SECURITY INVOKER), fixed empty search_path;
--   * resolves the owner once from private.current_owner_id() and never accepts
--     a user_id; every lookup, update and delete is scoped to that owner, and
--     another owner's ids answer not_found;
--   * behaves according to the migration stage (private.tv_stage()):
--       shadow        old season status is authoritative: seasons are linked to
--                     shows, no reopen, no compatibility values, no status block;
--       authoritative show status is authoritative: reopen on, Match status
--                     block on, compatibility values written;
--       final         as authoritative, without compatibility values.
-- Errors are raised with a stable prefix the app can map to messages:
--   invalid_input, not_found, not_available, integrity_fault, match_conflict.

create or replace function private.tv_require_stage(p_function text, variadic p_stages text[]) returns text
language plpgsql stable set search_path = '' as $$
declare v text := private.tv_stage();
begin
  if not (v = any(p_stages)) then
    raise exception 'not_available: % is not available in stage %', p_function, v using errcode = '55000';
  end if;
  return v;
end $$;

create or replace function private.tv_valid_date(p text) returns boolean
language sql immutable set search_path = '' as $$ select coalesce(p ~ '^\d{4}-\d{2}-\d{2}$', false) $$;

create or replace function private.tv_valid_status(p text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p = any(array['confirmed','highpriority','watching','complete','pending','maybe','skipped']), false)
$$;

-- Built-in collections (the catalog tabs, no TMDB search). A show there can be
-- given a TMDB identity by admin enrichment (db/admin/tv_enrich.sql); later
-- built-in or manual seasons of it must join that show, never a second one.
create or replace function private.tv_builtin_collections() returns text[]
language sql immutable set search_path = '' as $$ select array['disney', '90day', 'sheridan']::text[] $$;

-- The season number of a plain "Season N" label (N >= 1); null for anything else
-- (Specials, parts, volumes, "Season 5 (Final)", …).
create or replace function private.tv_plain_season_number(p_label text) returns integer
language sql immutable set search_path = '' as $$
  select case when p_label ~ '^Season [1-9][0-9]{0,3}$' then substring(p_label from 8)::integer end
$$;

-- Adds seasons (legacy-keyed: item_key, label, dates) to an enriched built-in show
-- as identified seasons: a plain "Season N" becomes TMDB season N of the show.
-- Per season: the same item_key already on that identity → existing (no-op); a
-- label that isn't a plain "Season N", or an item_key/identity held by another
-- row → rejected for review. Inserts nothing else and never creates a show.
-- p_seasons items: {item_key, title, season, theme?, display_date?, date_sort, status?}.
-- Returns {inserted uuid[], existing jsonb, rejected jsonb}.
create or replace function private.tv_add_to_enriched_show(p_show_id uuid, p_seasons jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  p_show public.tv_shows;
  s jsonb;
  v_num integer;
  v_row public.watchlist_items;
  v_conflict uuid;
  r public.watchlist_items;
  v_inserted uuid[] := '{}';
  v_existing jsonb := '[]';
  v_rejected jsonb := '[]';
begin
  select * into p_show from public.tv_shows where id = p_show_id;
  for s in select * from jsonb_array_elements(p_seasons) loop
    v_num := private.tv_plain_season_number(s ->> 'season');
    if v_num is null then
      v_rejected := v_rejected || jsonb_build_object('item_key', s ->> 'item_key', 'season', s ->> 'season',
        'reason', 'enriched_show_label', 'show_id', p_show.id);
      continue;
    end if;
    select * into v_row from public.watchlist_items
    where user_id = p_show.user_id and collection = p_show.collection and item_key = s ->> 'item_key'
    order by id limit 1;
    if found then
      if v_row.show_id = p_show.id and v_row.media_type = 'tv' and v_row.tmdb_id = p_show.tmdb_id and v_row.season_number = v_num then
        v_existing := v_existing || jsonb_build_object('season_number', v_num, 'item_key', v_row.item_key, 'id', v_row.id);
      else
        v_rejected := v_rejected || jsonb_build_object('item_key', s ->> 'item_key', 'season', s ->> 'season',
          'reason', 'identity_conflict', 'conflicting_row_id', v_row.id);
      end if;
      continue;
    end if;
    select id into v_conflict from public.watchlist_items
    where user_id = p_show.user_id and collection = p_show.collection and media_type = 'tv'
      and tmdb_id = p_show.tmdb_id and season_number = v_num;
    if found then
      v_rejected := v_rejected || jsonb_build_object('item_key', s ->> 'item_key', 'season', s ->> 'season',
        'reason', 'identity_conflict', 'conflicting_row_id', v_conflict);
      continue;
    end if;
    r := null;
    insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched,
      status, media_type, tmdb_id, season_number, show_id)
    values (p_show.collection, s ->> 'item_key', s ->> 'title', s ->> 'season', coalesce(s ->> 'theme', ''),
      coalesce(s ->> 'display_date', ''), s ->> 'date_sort', false, coalesce(s ->> 'status', 'confirmed'),
      'tv', p_show.tmdb_id, v_num, p_show.id)
    on conflict do nothing
    returning * into r;
    if r.id is not null then v_inserted := v_inserted || r.id;
    else v_rejected := v_rejected || jsonb_build_object('item_key', s ->> 'item_key', 'season', s ->> 'season', 'reason', 'identity_conflict');
    end if;
  end loop;
  return jsonb_build_object('inserted', to_jsonb(v_inserted), 'existing', v_existing, 'rejected', v_rejected);
end $$;

-- The enriched show a built-in, legacy-keyed season belongs to, by show key: one
-- show → its id (the show is locked); none → null; more than one → raises (ambiguous).
create or replace function private.tv_enriched_show_for(p_owner uuid, p_collection text, p_show_key text) returns uuid
language plpgsql set search_path = '' as $$
declare v uuid; v_n int;
begin
  if not (p_collection = any(private.tv_builtin_collections())) then return null; end if;
  select count(*) into v_n from public.tv_shows
  where user_id = p_owner and collection = p_collection and show_key = p_show_key and tmdb_id is not null;
  if v_n = 0 then return null; end if;
  if v_n > 1 then raise exception 'integrity_fault: % TMDB-matched shows share the key %', v_n, p_show_key using errcode = '23000'; end if;
  select id into v from public.tv_shows
  where user_id = p_owner and collection = p_collection and show_key = p_show_key and tmdb_id is not null for update;
  return v;
end $$;

-- Locks one of the owner's shows, creating it when missing; returns its id and
-- whether it was created. Two concurrent calls resolve to the same show (the
-- insert skips duplicates, then the existing row is locked).
create or replace function private.tv_lock_or_create_show(
  p_owner uuid, p_collection text, p_tmdb_id integer, p_show_key text, p_title text, p_initial_status text)
returns table (show_id uuid, created boolean)
language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  for attempt in 1..2 loop
    if p_tmdb_id is not null then
      select id into v_id from public.tv_shows
      where user_id = p_owner and collection = p_collection and tmdb_id = p_tmdb_id for update;
    else
      select id into v_id from public.tv_shows
      where user_id = p_owner and collection = p_collection and tmdb_id is null and show_key = p_show_key for update;
    end if;
    if v_id is not null then show_id := v_id; created := false; return next; return; end if;
    if attempt = 1 then
      insert into public.tv_shows (collection, title, show_key, tmdb_id, status)
      values (p_collection, p_title, p_show_key, p_tmdb_id, p_initial_status)
      on conflict do nothing
      returning id into v_id;
      if v_id is not null then show_id := v_id; created := true; return next; return; end if;
    end if;
  end loop;
  raise exception 'integrity_fault: could not create or find show %', p_show_key using errcode = '23000';
end $$;

-- ── add_tv_seasons ───────────────────────────────────────────────────────────
-- Adds seasons to one of the owner's shows (Refresh shows, TMDB search add,
-- manual Add entry on a TV tab). p_show: {tmdb_id?, title, show_key,
-- initial_status?, network?}. Each season: {item_key, title, season, theme,
-- display_date, date_sort, season_number?}. Identified shows take TMDB seasons
-- (season_number required); legacy shows take manual seasons.
-- Result: {show_id, show_created, inserted[], existing[], rejected[], reopened, show_status}.
create or replace function public.add_tv_seasons(p_collection text, p_show jsonb, p_seasons jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('add_tv_seasons', 'shadow', 'authoritative', 'final');
  v_tmdb integer;
  v_title text := btrim(coalesce(p_show ->> 'title', ''));
  v_key text := coalesce(p_show ->> 'show_key', '');
  v_init text := coalesce(p_show ->> 'initial_status', 'confirmed');
  v_network text := coalesce(p_show ->> 'network', '');
  v_show public.tv_shows;
  v_show_id uuid;
  v_created boolean;
  s jsonb;
  v_num integer;
  v_label text;
  v_ident text;
  v_seen text[] := '{}';
  r public.watchlist_items;
  v_conflict uuid;
  v_inserted uuid[] := '{}';
  v_existing jsonb := '[]';
  v_rejected jsonb := '[]';
  v_reopened boolean := false;
  v_enriched jsonb;
begin
  begin v_tmdb := (p_show ->> 'tmdb_id')::integer;
  exception when others then raise exception 'invalid_input: show tmdb_id' using errcode = '22023'; end;
  if p_collection is null or not (p_collection = any(private.tv_collections())) then
    raise exception 'invalid_input: % is not a TV collection', p_collection using errcode = '22023';
  end if;
  if v_title = '' or btrim(v_key) = '' then raise exception 'invalid_input: show title and show_key are required' using errcode = '22023'; end if;
  if not private.tv_valid_status(v_init) then raise exception 'invalid_input: initial_status %', v_init using errcode = '22023'; end if;
  if jsonb_typeof(p_seasons) is distinct from 'array' or jsonb_array_length(p_seasons) = 0 then
    raise exception 'invalid_input: seasons must be a non-empty list' using errcode = '22023';
  end if;

  -- Validate everything before writing anything.
  for s in select * from jsonb_array_elements(p_seasons) loop
    if jsonb_typeof(s) is distinct from 'object' or coalesce(s ->> 'item_key', '') = '' or coalesce(btrim(s ->> 'title'), '') = ''
       or coalesce(btrim(s ->> 'season'), '') = '' or not private.tv_valid_date(s ->> 'date_sort') then
      raise exception 'invalid_input: season %', s using errcode = '22023';
    end if;
    if v_tmdb is not null then
      begin v_num := (s ->> 'season_number')::integer;
      exception when others then raise exception 'invalid_input: season_number in %', s using errcode = '22023'; end;
      v_label := case when v_num = 0 then 'Specials' else 'Season ' || v_num end;
      if v_num is null or v_num < 0 or s ->> 'season' <> v_label or s ->> 'item_key' <> v_key || '|' || lower(v_label) then
        raise exception 'invalid_input: season % does not match its number and show', s using errcode = '22023';
      end if;
      v_ident := v_num::text;
    else
      if s ? 'season_number' and s -> 'season_number' <> 'null'::jsonb then
        raise exception 'invalid_input: a legacy season has no season_number' using errcode = '22023';
      end if;
      if s ->> 'season' = 'Film' or private.tv_show_key(p_collection, s ->> 'item_key') <> v_key then
        raise exception 'invalid_input: season % does not belong to show %', s ->> 'item_key', v_key using errcode = '22023';
      end if;
      v_ident := s ->> 'item_key';
    end if;
    if v_ident = any(v_seen) then raise exception 'invalid_input: season % requested twice', v_ident using errcode = '22023'; end if;
    v_seen := v_seen || v_ident;
  end loop;

  -- A legacy-keyed season of an enriched built-in show joins that show.
  if v_tmdb is null then
    v_show_id := private.tv_enriched_show_for(v_owner, p_collection, v_key);
    if v_show_id is not null then
      select * into v_show from public.tv_shows where id = v_show_id;
      v_enriched := private.tv_add_to_enriched_show(v_show_id,
        (select jsonb_agg(x - 'season_number') from jsonb_array_elements(p_seasons) x));
      v_inserted := array(select jsonb_array_elements_text(v_enriched -> 'inserted')::uuid);
      if cardinality(v_inserted) > 0 and v_stage in ('authoritative', 'final') and v_show.status = 'complete' then
        update public.tv_shows set status = 'confirmed' where id = v_show.id;
        v_reopened := true;
      end if;
      if cardinality(v_inserted) > 0 and v_stage = 'authoritative' then perform private.tv_project_legacy_status(v_show.id); end if;
      return jsonb_build_object(
        'show_id', v_show.id, 'show_created', false,
        'inserted', coalesce((select jsonb_agg(to_jsonb(w) order by w.season_number, w.item_key)
                              from public.watchlist_items w where w.id = any(v_inserted)), '[]'),
        'existing', v_enriched -> 'existing', 'rejected', v_enriched -> 'rejected', 'reopened', v_reopened,
        'show_status', (select status from public.tv_shows where id = v_show.id));
    end if;
  end if;

  select show_id, created into v_show_id, v_created
  from private.tv_lock_or_create_show(v_owner, p_collection, v_tmdb, v_key, v_title, v_init);
  select * into v_show from public.tv_shows where id = v_show_id;

  for s in select * from jsonb_array_elements(p_seasons) loop
    v_num := (s ->> 'season_number')::integer;
    if v_tmdb is not null then
      select * into r from public.watchlist_items
      where user_id = v_owner and collection = p_collection and media_type = 'tv' and tmdb_id = v_tmdb and season_number = v_num;
    else
      select * into r from public.watchlist_items
      where user_id = v_owner and collection = p_collection and tmdb_id is null and item_key = s ->> 'item_key';
    end if;
    if found then
      if r.show_id is not null and r.show_id <> v_show.id then
        raise exception 'integrity_fault: season % is linked to a different show', r.id using errcode = '23000';
      end if;
      v_existing := v_existing || jsonb_build_object('season_number', v_num, 'item_key', r.item_key, 'id', r.id);
      continue;
    end if;

    -- A row with the same key but the other kind of identity: report, don't guess.
    select id into v_conflict from public.watchlist_items
    where user_id = v_owner and collection = p_collection and item_key = s ->> 'item_key'
      and (case when v_tmdb is not null then tmdb_id is null else tmdb_id is not null end)
    limit 1;
    if found then
      v_rejected := v_rejected || jsonb_build_object('season_number', v_num, 'item_key', s ->> 'item_key',
        'reason', case when v_tmdb is not null then 'legacy_row_same_key' else 'identified_row_same_key' end,
        'conflicting_row_id', v_conflict);
      continue;
    end if;

    r := null;
    if v_tmdb is not null then
      insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched,
        status, media_type, tmdb_id, season_number, show_id)
      values (p_collection, s ->> 'item_key', s ->> 'title', s ->> 'season', coalesce(s ->> 'theme', ''),
        coalesce(s ->> 'display_date', ''), s ->> 'date_sort', false, 'confirmed', 'tv', v_tmdb, v_num, v_show.id)
      on conflict (user_id, collection, media_type, tmdb_id, season_number)
        where ((media_type = 'tv'::text) and (tmdb_id is not null) and (season_number is not null)) do nothing
      returning * into r;
    else
      insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched,
        status, show_id)
      values (p_collection, s ->> 'item_key', s ->> 'title', s ->> 'season', coalesce(s ->> 'theme', ''),
        coalesce(s ->> 'display_date', ''), s ->> 'date_sort', false, 'confirmed', v_show.id)
      on conflict (user_id, collection, item_key) where (tmdb_id is null) do nothing
      returning * into r;
    end if;
    if r.id is not null then
      v_inserted := v_inserted || r.id;
    else
      -- Added by a concurrent call between the check and the insert.
      select id into v_conflict from public.watchlist_items
      where user_id = v_owner and collection = p_collection
        and (case when v_tmdb is not null then media_type = 'tv' and tmdb_id = v_tmdb and season_number = v_num
                  else tmdb_id is null and item_key = s ->> 'item_key' end);
      v_existing := v_existing || jsonb_build_object('season_number', v_num, 'item_key', s ->> 'item_key', 'id', v_conflict);
    end if;
  end loop;

  if cardinality(v_inserted) > 0 and v_stage in ('authoritative', 'final') and v_show.status = 'complete' then
    update public.tv_shows set status = 'confirmed' where id = v_show.id;
    v_reopened := true;
  end if;
  if v_tmdb is not null and v_stage in ('shadow', 'authoritative') then
    insert into public.othertv_shows (tmdb_id, title, network, collection)
    values (v_tmdb, v_title, v_network, p_collection)
    on conflict (user_id, collection, tmdb_id) do nothing;
  end if;
  if v_stage = 'authoritative' then perform private.tv_project_legacy_status(v_show.id); end if;

  return jsonb_build_object(
    'show_id', v_show.id, 'show_created', v_created,
    'inserted', coalesce((select jsonb_agg(to_jsonb(w) order by w.season_number, w.item_key)
                          from public.watchlist_items w where w.id = any(v_inserted)), '[]'),
    'existing', v_existing, 'rejected', v_rejected, 'reopened', v_reopened,
    'show_status', (select status from public.tv_shows where id = v_show.id));
end $$;

-- ── seed_tv_defaults ─────────────────────────────────────────────────────────
-- Lazy, per-owner seeding of a built-in tab's DEFAULTS (the app sends the tab's
-- whole default list; config.js stays the source). Inserts only missing rows.
-- A new show starts Pending when every one of its entries has p, otherwise On
-- List. TV rows link to their show; films stay unlinked with today's row status.
-- Result: {inserted[], shows_created, reopened[], conflicts[]}.
create or replace function public.seed_tv_defaults(p_collection text, p_defaults jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('seed_tv_defaults', 'shadow', 'authoritative', 'final');
  d jsonb;
  v_keys text[] := '{}';
  g record;
  v_show public.tv_shows;
  v_show_id uuid;
  v_created boolean;
  v_shows_created int := 0;
  r public.watchlist_items;
  v_inserted uuid[] := '{}';
  v_reopened uuid[] := '{}';
  v_conflicts jsonb := '[]';
  v_n int;
  v_enriched jsonb;
begin
  if p_collection is null or not (p_collection = any(private.tv_collections())) then
    raise exception 'invalid_input: % is not a TV collection', p_collection using errcode = '22023';
  end if;
  if jsonb_typeof(p_defaults) is distinct from 'array' then raise exception 'invalid_input: defaults must be a list' using errcode = '22023'; end if;
  for d in select * from jsonb_array_elements(p_defaults) loop
    if jsonb_typeof(d) is distinct from 'object' or coalesce(d ->> 'k', '') not like '%|%' or coalesce(btrim(d ->> 't'), '') = ''
       or coalesce(btrim(d ->> 's'), '') = '' or not private.tv_valid_date(d ->> 'ds')
       or (d ? 'p' and jsonb_typeof(d -> 'p') <> 'boolean') then
      raise exception 'invalid_input: default %', d using errcode = '22023';
    end if;
    if (d ->> 'k') = any(v_keys) then raise exception 'invalid_input: default % listed twice', d ->> 'k' using errcode = '22023'; end if;
    v_keys := v_keys || (d ->> 'k');
  end loop;

  -- TV defaults whose row is missing, by show.
  for g in
    with defs as (
      select e.value as def, e.ordinality as ord, private.tv_show_key(p_collection, e.value ->> 'k') as show_key
      from jsonb_array_elements(p_defaults) with ordinality e
      where e.value ->> 's' <> 'Film'
    )
    select defs.show_key,
           coalesce((select x.def ->> 't' from defs x where x.show_key = defs.show_key and split_part(x.def ->> 'k', '|', 1) = defs.show_key order by x.ord limit 1),
                    (select x.def ->> 't' from defs x where x.show_key = defs.show_key order by x.ord limit 1)) as title,
           bool_and(coalesce((defs.def ->> 'p')::boolean, false)) as all_pending,
           jsonb_agg(defs.def order by defs.ord) filter (where not exists (
             select 1 from public.watchlist_items w
             where w.user_id = v_owner and w.collection = p_collection and w.tmdb_id is null and w.item_key = defs.def ->> 'k')) as missing
    from defs group by defs.show_key
  loop
    -- Defaults of an enriched built-in show join that show as identified seasons
    -- (a default already on it is a no-op; anything else is reported for review).
    v_show_id := private.tv_enriched_show_for(v_owner, p_collection, g.show_key);
    if v_show_id is not null then
      select * into v_show from public.tv_shows where id = v_show_id;
      v_enriched := private.tv_add_to_enriched_show(v_show_id, (
        select coalesce(jsonb_agg(jsonb_build_object('item_key', x.def ->> 'k', 'title', x.def ->> 't', 'season', x.def ->> 's',
          'theme', x.def ->> 'th', 'display_date', x.def ->> 'd', 'date_sort', x.def ->> 'ds',
          'status', case when coalesce((x.def ->> 'p')::boolean, false) then 'pending' else 'confirmed' end)), '[]')
        from jsonb_array_elements(p_defaults) as x(def)
        where x.def ->> 's' <> 'Film' and private.tv_show_key(p_collection, x.def ->> 'k') = g.show_key));
      v_n := jsonb_array_length(v_enriched -> 'inserted');
      v_inserted := v_inserted || array(select jsonb_array_elements_text(v_enriched -> 'inserted')::uuid);
      v_conflicts := v_conflicts || (v_enriched -> 'rejected');
      if v_n > 0 and v_stage in ('authoritative', 'final') and v_show.status = 'complete' then
        update public.tv_shows set status = 'confirmed' where id = v_show.id;
        v_reopened := v_reopened || v_show.id;
      end if;
      if v_n > 0 and v_stage = 'authoritative' then perform private.tv_project_legacy_status(v_show.id); end if;
      continue;
    end if;
    if g.missing is null then
      -- Every row exists; report any that is linked to a different show.
      v_conflicts := v_conflicts || coalesce((
        select jsonb_agg(jsonb_build_object('item_key', w.item_key, 'reason', 'linked_to_other_show', 'row_id', w.id))
        from public.watchlist_items w join public.tv_shows s on s.id = w.show_id
        where w.user_id = v_owner and w.collection = p_collection and w.tmdb_id is null
          and private.tv_show_key(p_collection, w.item_key) = g.show_key and s.show_key <> g.show_key), '[]');
      continue;
    end if;
    select show_id, created into v_show_id, v_created
    from private.tv_lock_or_create_show(v_owner, p_collection, null, g.show_key, g.title,
                                        case when g.all_pending then 'pending' else 'confirmed' end);
    select * into v_show from public.tv_shows where id = v_show_id;
    if v_created then v_shows_created := v_shows_created + 1; end if;
    v_n := 0;
    for d in select * from jsonb_array_elements(g.missing) loop
      r := null;
      insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched, status, show_id)
      values (p_collection, d ->> 'k', d ->> 't', d ->> 's', coalesce(d ->> 'th', ''), coalesce(d ->> 'd', ''), d ->> 'ds', false,
              case when coalesce((d ->> 'p')::boolean, false) then 'pending' else 'confirmed' end, v_show.id)
      on conflict (user_id, collection, item_key) where (tmdb_id is null) do nothing
      returning * into r;
      if r.id is not null then v_inserted := v_inserted || r.id; v_n := v_n + 1; end if;
    end loop;
    if v_n > 0 and not v_created and v_stage in ('authoritative', 'final') and v_show.status = 'complete' then
      update public.tv_shows set status = 'confirmed' where id = v_show.id;
      v_reopened := v_reopened || v_show.id;
    end if;
    if v_n > 0 and v_stage = 'authoritative' then perform private.tv_project_legacy_status(v_show.id); end if;
  end loop;

  -- Films: unlinked, today's row status.
  for d in select * from jsonb_array_elements(p_defaults) loop
    if d ->> 's' <> 'Film' then continue; end if;
    r := null;
    insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched, status)
    values (p_collection, d ->> 'k', d ->> 't', d ->> 's', coalesce(d ->> 'th', ''), coalesce(d ->> 'd', ''), d ->> 'ds', false,
            case when coalesce((d ->> 'p')::boolean, false) then 'pending' else 'confirmed' end)
    on conflict (user_id, collection, item_key) where (tmdb_id is null) do nothing
    returning * into r;
    if r.id is not null then v_inserted := v_inserted || r.id; end if;
  end loop;

  return jsonb_build_object(
    'inserted', coalesce((select jsonb_agg(to_jsonb(w) order by w.date_sort, w.item_key) from public.watchlist_items w
                          where w.id = any(v_inserted)), '[]'),
    'shows_created', v_shows_created, 'reopened', to_jsonb(v_reopened), 'conflicts', v_conflicts);
end $$;

-- ── Show status, watched, skip (authoritative stages only) ───────────────────
create or replace function public.set_show_status(p_show_id uuid, p_status text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('set_show_status', 'authoritative', 'final');
  v_show public.tv_shows;
begin
  if not private.tv_valid_status(p_status) then raise exception 'invalid_input: status %', p_status using errcode = '22023'; end if;
  update public.tv_shows set status = p_status where id = p_show_id and user_id = v_owner returning * into v_show;
  if v_show.id is null then raise exception 'not_found: show' using errcode = 'P0002'; end if;
  if v_stage = 'authoritative' then perform private.tv_project_legacy_status(v_show.id); end if;
  return to_jsonb(v_show);
end $$;

create or replace function private.tv_lock_season(p_owner uuid, p_row_id uuid) returns public.watchlist_items
language plpgsql set search_path = '' as $$
declare r public.watchlist_items;
begin
  select * into r from public.watchlist_items where id = p_row_id and user_id = p_owner and show_id is not null;
  if r.id is null then raise exception 'not_found: TV season' using errcode = 'P0002'; end if;
  perform 1 from public.tv_shows where id = r.show_id for update;
  return r;
end $$;

create or replace function public.set_season_watched(p_row_id uuid, p_watched boolean) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('set_season_watched', 'authoritative', 'final');
  r public.watchlist_items;
begin
  if p_watched is null then raise exception 'invalid_input: watched' using errcode = '22023'; end if;
  r := private.tv_lock_season(v_owner, p_row_id);
  update public.watchlist_items set watched = p_watched where id = r.id;
  if v_stage = 'authoritative' then perform private.tv_project_legacy_status(r.show_id); end if;
  return (select to_jsonb(w) from public.watchlist_items w where w.id = r.id);
end $$;

create or replace function public.set_season_skipped(p_row_id uuid, p_skipped boolean) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('set_season_skipped', 'authoritative', 'final');
  r public.watchlist_items;
begin
  if p_skipped is null then raise exception 'invalid_input: skipped' using errcode = '22023'; end if;
  r := private.tv_lock_season(v_owner, p_row_id);
  update public.watchlist_items set skipped = p_skipped where id = r.id;
  if v_stage = 'authoritative' then perform private.tv_project_legacy_status(r.show_id); end if;
  return (select to_jsonb(w) from public.watchlist_items w where w.id = r.id);
end $$;

-- ── delete_tv_season ─────────────────────────────────────────────────────────
-- Deletes one of the owner's TV seasons. When it was the show's last season the
-- show goes too, with the owner's othertv_shows entry for it (so Refresh shows
-- can't bring it back). Skip never deletes; built-in rows are skipped by the app.
create or replace function public.delete_tv_season(p_row_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('delete_tv_season', 'shadow', 'authoritative', 'final');
  r public.watchlist_items;
  v_show public.tv_shows;
  v_show_deleted boolean := false;
begin
  select * into r from public.watchlist_items
  where id = p_row_id and user_id = v_owner and private.tv_is_tv_row(collection, media_type, season);
  if r.id is null then raise exception 'not_found: TV season' using errcode = 'P0002'; end if;
  if r.show_id is not null then
    select * into v_show from public.tv_shows where id = r.show_id and user_id = v_owner for update;
  end if;
  delete from public.watchlist_items where id = r.id and user_id = v_owner;
  if v_show.id is not null then
    if not exists (select 1 from public.watchlist_items where show_id = v_show.id) then
      delete from public.tv_shows where id = v_show.id and user_id = v_owner;
      v_show_deleted := true;
      if v_show.tmdb_id is not null and v_stage in ('shadow', 'authoritative') then
        delete from public.othertv_shows
        where user_id = v_owner and collection = v_show.collection and tmdb_id = v_show.tmdb_id;
      end if;
    elsif v_stage = 'authoritative' then
      perform private.tv_project_legacy_status(v_show.id);
    end if;
  end if;
  return jsonb_build_object('deleted_row_id', r.id, 'show_id', v_show.id, 'show_deleted', v_show_deleted);
end $$;

-- ── match_tv_row ─────────────────────────────────────────────────────────────
-- Match to TMDB for one of the owner's unidentified rows, targeting a TV season.
-- p_target: {tmdb_id, network?}; p_patch: the fields buildTmdbMatchPatch makes
-- for a TV season. Moves the row from its legacy show L to the identified show
-- T. In the authoritative stages, if T already exists with a different status
-- than L, nothing is written and the result says blocked.
-- Result: {row, show_id, blocked, legacy_status?, target_status?}.
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

-- ── Permissions ──────────────────────────────────────────────────────────────
revoke all on function private.tv_require_stage(text, text[]), private.tv_valid_date(text), private.tv_valid_status(text),
  private.tv_lock_or_create_show(uuid, text, integer, text, text, text), private.tv_lock_season(uuid, uuid),
  private.tv_builtin_collections(), private.tv_plain_season_number(text), private.tv_add_to_enriched_show(uuid, jsonb),
  private.tv_enriched_show_for(uuid, text, text) from public;
grant execute on function private.tv_require_stage(text, text[]), private.tv_valid_date(text), private.tv_valid_status(text),
  private.tv_lock_or_create_show(uuid, text, integer, text, text, text), private.tv_lock_season(uuid, uuid),
  private.tv_builtin_collections(), private.tv_plain_season_number(text), private.tv_add_to_enriched_show(uuid, jsonb),
  private.tv_enriched_show_for(uuid, text, text) to anon, authenticated;

revoke all on function public.add_tv_seasons(text, jsonb, jsonb), public.seed_tv_defaults(text, jsonb),
  public.set_show_status(uuid, text), public.set_season_watched(uuid, boolean), public.set_season_skipped(uuid, boolean),
  public.delete_tv_season(uuid), public.match_tv_row(uuid, jsonb, jsonb) from public;
grant execute on function public.add_tv_seasons(text, jsonb, jsonb), public.seed_tv_defaults(text, jsonb),
  public.set_show_status(uuid, text), public.set_season_watched(uuid, boolean), public.set_season_skipped(uuid, boolean),
  public.delete_tv_season(uuid), public.match_tv_row(uuid, jsonb, jsonb) to anon, authenticated;
