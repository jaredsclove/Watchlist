-- Rollback of Stage 4a (db/phase4a_catalog.sql), in one transaction. Refuses
-- unless Stage 4a is installed. Restores public.seed_tv_defaults exactly as
-- db/rpc.sql defines it (tab-open seeding works again), drops the date guard,
-- public.catalog_apply and its private helpers. No table or row changes: every
-- catalog application already made stays.
-- IMPORTANT: this re-enables implicit writes immediately for every open page of
-- an earlier app version (tab-open seeding and the tab-open TBA date PATCH). It
-- is a separate owner decision, paired with reverting both refresh-catalogs
-- copies to their tab-opening instructions. Run as postgres.
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regprocedure('public.catalog_apply(text, jsonb, text)') is null then
    raise exception 'phase4a rollback: Stage 4a is not installed';
  end if;
end $$;

drop trigger catalog_date_guard on public.watchlist_items;
drop function public.catalog_apply(text, jsonb, text);
drop function private.catalog_run(text, jsonb);
drop function private.catalog_insert_missing(uuid, text, jsonb);
drop function private.catalog_date_guard();
drop function private.catalog_hash(jsonb);
drop function private.catalog_canon(jsonb);

-- The pre-4a definition, copied verbatim from db/rpc.sql (its grants were kept
-- by create or replace).
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

notify pgrst, 'reload schema';
commit;
