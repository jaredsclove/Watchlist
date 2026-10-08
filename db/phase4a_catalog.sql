-- Stage 4a: explicit catalog application, in one transaction.
--   * public.catalog_apply(p_collection, p_defaults, p_approved): the only write
--     of a built-in catalog (Disney+, 90 Day, Sheridan). Without p_approved it is
--     a preview: it runs the real application inside a block that is always
--     rolled back and returns the effects document and its hash. With the hash of
--     a preview it runs the same steps again, under the same locks, and commits
--     only if the hash of the effects it actually performed equals p_approved;
--     then it also returns the execution receipt (the ids it created or changed).
--   * public.seed_tv_defaults keeps its signature but refuses: opening a tab
--     never writes catalog entries again (old pages get a readable refusal).
--   * a date guard on built-in-catalog rows: their display_date / date_sort
--     change only inside catalog_apply's date step (or an owner-run admin
--     transaction that sets the same transaction-local setting deliberately).
-- No table, column, index, policy or grant on a table changes; no row changes.
-- Membership policy (owner decision, 2026-10-08): a show or film the apply
-- creates joins its built-in collection unless that collection is archived; the
-- membership trigger stays enabled and the apply reconciles in its own
-- transaction (the Stage 3b pattern; no trigger suppression).
-- Run as postgres at stage final with Stage 3b-2 installed.
-- Rollback (refuses unless installed): db/rollback/phase4a.sql.
begin;
set local lock_timeout = '5s';

do $$ begin
  if private.tv_stage() <> 'final' then raise exception 'phase4a: expected stage final, found %', private.tv_stage(); end if;
  if to_regprocedure('public.org_capabilities()') is null then raise exception 'phase4a: Stage 3b-2 is not installed'; end if;
  if to_regprocedure('public.catalog_apply(text, jsonb, text)') is not null then raise exception 'phase4a: already applied (catalog_apply exists)'; end if;
end $$;

-- ── Canonical JSON and hash ──────────────────────────────────────────────────
-- Object keys sorted by code point (collation "C"), array order kept, no
-- whitespace; strings and numbers as jsonb prints them (the same escaping as
-- JSON.stringify for the values used here). Shared with the app and tools
-- (catalog-apply.js catalogCanonical, tools/catalog-payload-hash.mjs).
create function private.catalog_canon(p jsonb) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p is null then return 'null'; end if;
  case jsonb_typeof(p)
    when 'object' then
      return '{' || coalesce((select string_agg(to_json(k)::text || ':' || private.catalog_canon(p -> k), ',' order by k collate "C")
                              from jsonb_object_keys(p) k), '') || '}';
    when 'array' then
      return '[' || coalesce((select string_agg(private.catalog_canon(e), ',' order by o)
                              from jsonb_array_elements(p) with ordinality x(e, o)), '') || ']';
    else
      return p::text;
  end case;
end $$;

create function private.catalog_hash(p jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(private.catalog_canon(p), 'UTF8')), 'hex')
$$;

-- ── Insertion (the former seed_tv_defaults body, unchanged in behaviour) ─────
-- Inserts the catalog's missing rows: legacy shows by key (a new show starts
-- Pending only if every one of its defaults has p), defaults of an enriched show
-- through tv_add_to_enriched_show (no second show; nonstandard labels and
-- identity clashes are returned as conflicts), films unlinked. A Complete show
-- that receives a genuinely inserted season is reopened to On List.
-- Returns {inserted[], created_shows[], reopened[], conflicts[], identified[]}.
create function private.catalog_insert_missing(p_owner uuid, p_collection text, p_defaults jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  d jsonb;
  g record;
  v_show public.tv_shows;
  v_show_id uuid;
  v_created boolean;
  r public.watchlist_items;
  v_inserted uuid[] := '{}';
  v_created_shows uuid[] := '{}';
  v_reopened uuid[] := '{}';
  v_conflicts jsonb := '[]';
  v_identified jsonb := '[]';
  v_n int;
  v_enriched jsonb;
begin
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
             where w.user_id = p_owner and w.collection = p_collection and w.tmdb_id is null and w.item_key = defs.def ->> 'k')) as missing
    from defs group by defs.show_key
  loop
    v_show_id := private.tv_enriched_show_for(p_owner, p_collection, g.show_key);
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
      v_identified := v_identified || (v_enriched -> 'existing');
      if v_n > 0 and v_show.status = 'complete' then
        update public.tv_shows set status = 'confirmed' where id = v_show.id;
        v_reopened := v_reopened || v_show.id;
      end if;
      continue;
    end if;
    if g.missing is null then
      v_conflicts := v_conflicts || coalesce((
        select jsonb_agg(jsonb_build_object('item_key', w.item_key, 'reason', 'linked_to_other_show', 'row_id', w.id))
        from public.watchlist_items w join public.tv_shows s on s.id = w.show_id
        where w.user_id = p_owner and w.collection = p_collection and w.tmdb_id is null
          and private.tv_show_key(p_collection, w.item_key) = g.show_key and s.show_key <> g.show_key), '[]');
      continue;
    end if;
    select show_id, created into v_show_id, v_created
    from private.tv_lock_or_create_show(p_owner, p_collection, null, g.show_key, g.title,
                                        case when g.all_pending then 'pending' else 'confirmed' end);
    select * into v_show from public.tv_shows where id = v_show_id;
    if v_created then v_created_shows := v_created_shows || v_show.id; end if;
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
    if v_n > 0 and not v_created and v_show.status = 'complete' then
      update public.tv_shows set status = 'confirmed' where id = v_show.id;
      v_reopened := v_reopened || v_show.id;
    end if;
  end loop;

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

  return jsonb_build_object('inserted', to_jsonb(v_inserted), 'created_shows', to_jsonb(v_created_shows),
    'reopened', to_jsonb(v_reopened), 'conflicts', v_conflicts, 'identified', v_identified);
end $$;

-- ── One application: steps S1–S7 ────────────────────────────────────────────
-- Returns {document, hash, receipt}. The document holds no generated ids or
-- timestamps (new records are S1…, F1…); the receipt maps each document entry
-- (by its key) to the actual ids. Called only by catalog_apply.
create function private.catalog_run(p_collection text, p_defaults jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  d jsonb;
  v_keys text[] := '{}';
  v_payload_hash text;
  v_missing jsonb;
  v_pre_status jsonb;
  v_fills jsonb := '[]';
  f jsonb;
  r public.watchlist_items;
  v_ins jsonb;
  v_target public.personal_collections;
  v_rows_before int; v_shows_before int;
  v_entries jsonb := '[]';
  v_receipt jsonb := '{}';
  v_refs jsonb := '{}';
  v_n int := 0;
  v_m int := 0;
  v_film_ids uuid[] := '{}';
  v_mem_id uuid;
  v_doc jsonb;
  x record;
begin
  -- S1: locks in the canonical table order (shows, items, collections), before
  -- any read. EXCLUSIVE still lets reads through; every writer waits.
  perform set_config('lock_timeout', '2s', true);
  begin
    lock table public.tv_shows, public.watchlist_items in exclusive mode;
    lock table public.personal_collections in share mode;
  exception when lock_not_available or deadlock_detected then
    raise exception 'catalog_busy: The database was busy, so nothing was changed. Review again in a moment.' using errcode = 'P0001';
  end;

  -- S2: the payload (the former seed validation) and its hash.
  if p_collection is null or not (p_collection = any(private.tv_builtin_collections())) then
    raise exception 'invalid_input: % has no built-in catalog', p_collection using errcode = '22023';
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
  v_payload_hash := private.catalog_hash(p_defaults);

  -- State before any write, read under the locks.
  select coalesce(jsonb_object_agg(id::text, status), '{}') into v_pre_status
  from public.tv_shows where user_id = v_owner and collection = p_collection;
  select count(*) into v_rows_before from public.watchlist_items where user_id = v_owner;
  select count(*) into v_shows_before from public.tv_shows where user_id = v_owner;
  select * into v_target from public.personal_collections where user_id = v_owner and legacy_source = p_collection;
  -- Date-fill candidates: a stored TBA date whose default is no longer TBA (the
  -- tab-open rule). Skipped items stay eligible; the fill touches dates only.
  select coalesce(jsonb_agg(jsonb_build_object('row_id', w.id, 'item_key', w.item_key, 'is_film', w.is_film, 'show_id', w.show_id,
           'old_display', w.display_date, 'old_sort', w.date_sort, 'new_display', e.value ->> 'd', 'new_sort', e.value ->> 'ds',
           'watched', w.watched, 'skipped', w.skipped, 'status', w.status) order by w.id), '[]')
    into v_fills
  from public.watchlist_items w join jsonb_array_elements(p_defaults) e on e.value ->> 'k' = w.item_key
  where w.user_id = v_owner and w.collection = p_collection
    and w.display_date ~* 'tba' and (e.value ->> 'd') !~* 'tba';

  -- S3: inserts. Only defaults whose item_key no row of this tab holds yet (the
  -- tab-open rule: a key held by any row, identified or not, is never added
  -- again); enriched-show defaults among them still join their show.
  select coalesce(jsonb_agg(e.value order by e.ordinality), '[]') into v_missing
  from jsonb_array_elements(p_defaults) with ordinality e
  where not exists (select 1 from public.watchlist_items w
                    where w.user_id = v_owner and w.collection = p_collection and w.item_key = e.value ->> 'k');
  v_ins := private.catalog_insert_missing(v_owner, p_collection, v_missing);

  -- S4: date fills, each guarded by the old value; the date-write setting is on
  -- only around these statements.
  perform set_config('watchlist.catalog_date_write', 'on', true);
  for f in select * from jsonb_array_elements(v_fills) loop
    r := null;
    update public.watchlist_items set display_date = f ->> 'new_display', date_sort = f ->> 'new_sort'
    where id = (f ->> 'row_id')::uuid and display_date = f ->> 'old_display' and date_sort = f ->> 'old_sort'
    returning * into r;
    if r.id is null then
      perform set_config('watchlist.catalog_date_write', '', true);
      raise exception 'integrity_fault: date fill of % found a different value under lock', f ->> 'row_id' using errcode = '23000';
    end if;
  end loop;
  perform set_config('watchlist.catalog_date_write', '', true);

  -- Symbolic references for new records: shows by show_key, films by item_key.
  for x in select s.id, s.show_key from public.tv_shows s
           where s.id = any(array(select jsonb_array_elements_text(v_ins -> 'created_shows')::uuid)) order by s.show_key collate "C", s.id loop
    v_n := v_n + 1;
    v_refs := v_refs || jsonb_build_object(x.id::text, 'S' || v_n);
  end loop;
  for x in select w.id, w.item_key from public.watchlist_items w
           where w.id = any(array(select jsonb_array_elements_text(v_ins -> 'inserted')::uuid)) and w.is_film
           order by w.item_key collate "C", w.id loop
    v_m := v_m + 1;
    v_refs := v_refs || jsonb_build_object(x.id::text, 'F' || v_m);
    v_film_ids := v_film_ids || x.id;
  end loop;

  -- Entries (no generated ids for new records) and the receipt.
  for x in select s.* from public.tv_shows s where (v_refs ? s.id::text) loop
    v_entries := v_entries || jsonb_build_object('kind', 'create_show', 'key', 'create_show:' || (v_refs ->> x.id::text),
      'ref', v_refs ->> x.id::text, 'show_key', x.show_key, 'title', x.title, 'tmdb_id', x.tmdb_id, 'initial_status', x.status);
    v_receipt := v_receipt || jsonb_build_object('create_show:' || (v_refs ->> x.id::text), jsonb_build_object('show_id', x.id));
  end loop;
  for x in select distinct s.id, s.show_key from public.watchlist_items w join public.tv_shows s on s.id = w.show_id
           where w.id = any(array(select jsonb_array_elements_text(v_ins -> 'inserted')::uuid)) and not (v_refs ? s.id::text) loop
    v_entries := v_entries || jsonb_build_object('kind', 'attach', 'key', 'attach:' || x.id, 'show_id', x.id, 'show_key', x.show_key,
      'status', v_pre_status ->> x.id::text);
  end loop;
  for x in select w.*, s.show_key from public.watchlist_items w left join public.tv_shows s on s.id = w.show_id
           where w.id = any(array(select jsonb_array_elements_text(v_ins -> 'inserted')::uuid)) loop
    if x.is_film then
      v_entries := v_entries || jsonb_build_object('kind', 'insert_film', 'key', 'insert_film:' || (v_refs ->> x.id::text),
        'ref', v_refs ->> x.id::text, 'item_key', x.item_key, 'title', x.title, 'season', x.season, 'theme', x.theme,
        'display_date', x.display_date, 'date_sort', x.date_sort, 'status', x.status, 'watched', x.watched,
        'media_type', x.media_type, 'tmdb_id', x.tmdb_id);
      v_receipt := v_receipt || jsonb_build_object('insert_film:' || (v_refs ->> x.id::text), jsonb_build_object('row_id', x.id));
    else
      v_entries := v_entries || jsonb_build_object('kind', 'insert_season', 'key', 'insert_season:' || x.show_key || '|' || x.item_key,
        'show', coalesce(v_refs ->> x.show_id::text, x.show_id::text), 'item_key', x.item_key, 'title', x.title, 'season', x.season,
        'theme', x.theme, 'display_date', x.display_date, 'date_sort', x.date_sort, 'status', x.status, 'watched', x.watched,
        'skipped', x.skipped, 'media_type', x.media_type, 'tmdb_id', x.tmdb_id, 'season_number', x.season_number);
      v_receipt := v_receipt || jsonb_build_object('insert_season:' || x.show_key || '|' || x.item_key,
        jsonb_build_object('row_id', x.id, 'show_id', x.show_id));
    end if;
  end loop;
  for f in select * from jsonb_array_elements(v_fills) loop
    v_entries := v_entries || jsonb_build_object('kind', 'fill_date', 'key', 'fill_date:' || (f ->> 'row_id'),
      'row_id', f -> 'row_id', 'item_key', f -> 'item_key', 'item', case when (f ->> 'is_film')::boolean then 'film' else 'season' end,
      'show_id', f -> 'show_id',
      'old_display', f -> 'old_display', 'old_sort', f -> 'old_sort', 'new_display', f -> 'new_display', 'new_sort', f -> 'new_sort',
      'tracking', case when (f ->> 'is_film')::boolean
                       then jsonb_build_object('watched', f -> 'watched', 'status', f -> 'status')
                       else jsonb_build_object('watched', f -> 'watched', 'skipped', f -> 'skipped',
                                               'show_status', v_pre_status -> (f ->> 'show_id')) end);
    v_receipt := v_receipt || jsonb_build_object('fill_date:' || (f ->> 'row_id'), jsonb_build_object('row_id', f -> 'row_id'));
  end loop;
  for x in select s.id, (select min(w.item_key collate "C") from public.watchlist_items w
                          where w.show_id = s.id and w.id = any(array(select jsonb_array_elements_text(v_ins -> 'inserted')::uuid))) cause
           from public.tv_shows s where s.id = any(array(select jsonb_array_elements_text(v_ins -> 'reopened')::uuid)) loop
    v_entries := v_entries || jsonb_build_object('kind', 'reopen', 'key', 'reopen:' || x.id, 'show_id', x.id,
      'from', v_pre_status ->> x.id::text, 'to', 'confirmed', 'cause', x.cause);
    v_receipt := v_receipt || jsonb_build_object('reopen:' || x.id, jsonb_build_object('show_id', x.id));
  end loop;

  -- S6: memberships of the records created here. The trigger added the C4
  -- membership; an archived target loses it again (only records created in this
  -- transaction, which nothing else can reference yet).
  for x in select key as id, value #>> '{}' as ref from jsonb_each(v_refs) order by value #>> '{}' collate "C" loop
    v_mem_id := null;
    if v_target.id is not null and v_target.archived_at is not null then
      delete from public.collection_memberships
      where collection_id = v_target.id and (show_id = x.id::uuid or item_id = x.id::uuid);
    elsif v_target.id is not null then
      select id into v_mem_id from public.collection_memberships
      where collection_id = v_target.id and (show_id = x.id::uuid or item_id = x.id::uuid);
    end if;
    v_entries := v_entries || jsonb_build_object('kind', 'membership', 'key', 'membership:' || x.ref, 'ref', x.ref,
      'collection_id', v_target.id, 'archived', v_target.archived_at is not null,
      'result', case when v_target.id is null then 'no_collection' when v_target.archived_at is not null then 'not_joined' else 'joined' end);
    v_receipt := v_receipt || jsonb_build_object('membership:' || x.ref,
      jsonb_build_object('membership_id', case when v_mem_id is null then to_jsonb('none'::text) else to_jsonb(v_mem_id) end));
  end loop;

  -- Conflicts (excluded from the approved subset) and no-ops.
  for f in select * from jsonb_array_elements(v_ins -> 'conflicts') loop
    v_entries := v_entries || jsonb_build_object('kind', 'excluded_conflict', 'key', 'excluded_conflict:' || (f ->> 'item_key'),
      'item_key', f -> 'item_key', 'reason', f -> 'reason', 'conflicting_id', coalesce(f -> 'conflicting_row_id', f -> 'row_id', 'null'::jsonb));
  end loop;
  for d in select * from jsonb_array_elements(p_defaults) loop
    if exists (select 1 from jsonb_array_elements(v_entries) e
               where e ->> 'item_key' = d ->> 'k' and e ->> 'kind' in ('insert_season', 'insert_film', 'fill_date', 'excluded_conflict')) then
      continue;
    end if;
    v_entries := v_entries || jsonb_build_object('kind', 'noop', 'key', 'noop:' || (d ->> 'k'), 'item_key', d -> 'k',
      'category', case when exists (select 1 from public.watchlist_items w where w.user_id = v_owner and w.collection = p_collection
                                     and w.item_key = d ->> 'k' and w.tmdb_id is not null)
                            or exists (select 1 from jsonb_array_elements(v_ins -> 'identified') i where i ->> 'item_key' = d ->> 'k')
                       then 'identified' else 'present' end);
  end loop;

  -- S7: post-conditions.
  if (select count(*) from public.watchlist_items where user_id = v_owner) <> v_rows_before + jsonb_array_length(v_ins -> 'inserted')
     or (select count(*) from public.tv_shows where user_id = v_owner) <> v_shows_before + jsonb_array_length(v_ins -> 'created_shows') then
    raise exception 'integrity_fault: unexpected row count after the catalog application' using errcode = '23000';
  end if;
  if exists (select 1 from public.watchlist_items w
             where w.id = any(array(select jsonb_array_elements_text(v_ins -> 'inserted')::uuid))
               and ((w.is_film and w.show_id is not null) or (not w.is_film and w.show_id is null))) then
    raise exception 'integrity_fault: an inserted row is linked wrongly' using errcode = '23000';
  end if;
  if exists (select 1 from jsonb_each(v_refs) rf
             where (select count(*) from public.collection_memberships m where m.show_id = rf.key::uuid or m.item_id = rf.key::uuid)
                   <> case when v_target.id is not null and v_target.archived_at is null then 1 else 0 end) then
    raise exception 'integrity_fault: a new record has an unexpected membership' using errcode = '23000';
  end if;
  if exists (select 1 from jsonb_array_elements(v_fills) ff join public.watchlist_items w on w.id = (ff ->> 'row_id')::uuid
             where w.display_date is distinct from ff ->> 'new_display' or w.date_sort is distinct from ff ->> 'new_sort') then
    raise exception 'integrity_fault: a date fill did not hold' using errcode = '23000';
  end if;

  select coalesce(jsonb_agg(e order by case e ->> 'kind' when 'create_show' then 1 when 'attach' then 2 when 'insert_season' then 3
                    when 'insert_film' then 4 when 'fill_date' then 5 when 'reopen' then 6 when 'membership' then 7
                    when 'excluded_conflict' then 8 else 9 end, e ->> 'key' collate "C"), '[]')
    into v_entries from jsonb_array_elements(v_entries) e;
  v_doc := jsonb_build_object('version', '4a.1', 'owner', v_owner, 'collection', p_collection, 'payload_hash', v_payload_hash,
    'target', case when v_target.id is null then null else jsonb_build_object('collection_id', v_target.id, 'archived', v_target.archived_at is not null) end,
    'entries', v_entries);
  return jsonb_build_object('document', v_doc, 'hash', private.catalog_hash(v_doc), 'receipt', v_receipt);
end $$;

-- ── public.catalog_apply ─────────────────────────────────────────────────────
-- Preview (p_approved null): steps S1–S7 in a block that is always rolled back
-- (writes, the date-write setting and the locks taken inside it are undone);
-- returns {mode: 'preview', document, hash}. Apply: the same steps, then
-- catalog_stale (and a full rollback) unless the effects hash equals
-- p_approved; returns {mode: 'applied', document, hash, receipt, applied_at}.
create function public.catalog_apply(p_collection text, p_defaults jsonb, p_approved text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v jsonb;
begin
  perform private.tv_require_stage('catalog_apply', 'final');
  begin
    if p_approved is null then
      begin
        v := private.catalog_run(p_collection, p_defaults);
        raise exception 'catalog_preview_rollback' using errcode = 'P0001';
      exception when sqlstate 'P0001' then
        if sqlerrm <> 'catalog_preview_rollback' then raise; end if;
      end;
      return jsonb_build_object('mode', 'preview', 'document', v -> 'document', 'hash', v ->> 'hash');
    end if;
    v := private.catalog_run(p_collection, p_defaults);
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

-- ── Old pages: tab-open seeding refused ──────────────────────────────────────
create or replace function public.seed_tv_defaults(p_collection text, p_defaults jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'catalog_apply_required: Catalog updates are now reviewed and applied explicitly. Reload the page. Nothing was changed.'
    using errcode = 'P0001';
end $$;

-- ── Date guard on built-in-catalog rows ──────────────────────────────────────
-- Refuses a changed display_date or date_sort on a Disney+, 90 Day or Sheridan
-- row unless the transaction-local setting watchlist.catalog_date_write is 'on'.
-- Only catalog_run's date step sets it (and clears it straight after); an
-- owner-run admin correction may set it deliberately inside its own transaction.
-- Kept until a separately reviewed replacement makes old pages' requests harmless.
create function private.catalog_date_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.display_date is distinct from old.display_date or new.date_sort is distinct from old.date_sort)
     and coalesce(current_setting('watchlist.catalog_date_write', true), '') <> 'on' then
    raise exception 'catalog_apply_required: Dates of built-in catalog entries now change only through Catalog updates. Reload the page. Nothing was changed.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger catalog_date_guard before update of display_date, date_sort on public.watchlist_items
  for each row when (old.collection = any(private.tv_builtin_collections()) or new.collection = any(private.tv_builtin_collections()))
  execute function private.catalog_date_guard();

-- ── Permissions ──────────────────────────────────────────────────────────────
revoke all on function private.catalog_canon(jsonb), private.catalog_hash(jsonb), private.catalog_insert_missing(uuid, text, jsonb),
  private.catalog_run(text, jsonb), private.catalog_date_guard(), public.catalog_apply(text, jsonb, text) from public;
grant execute on function private.catalog_canon(jsonb), private.catalog_hash(jsonb), private.catalog_insert_missing(uuid, text, jsonb),
  private.catalog_run(text, jsonb), public.catalog_apply(text, jsonb, text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
