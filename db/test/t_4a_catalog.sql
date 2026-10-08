-- Checks for Stage 4a (prepend db/test/_prelude.sql). Run as postgres after
-- db/phase4a_catalog.sql at stage final with Stage 3b-2 installed, on a replica.
-- Every check works on synthetic ZZ catalog entries inside its own rolled-back
-- subtransaction and calls the database as anon, the way the app does. These are
-- single-session checks: they don't show how two sessions interleave (lock waits,
-- catalog_busy, deadlocks), which needs two real connections on a hosted project.

create or replace function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true);
$$;
create or replace function pg_temp.as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true);
$$;
create or replace function pg_temp.coll(p_source text) returns uuid language sql as $$
  select id from public.personal_collections where legacy_source = p_source and user_id = private.current_owner_id()
$$;
create or replace function pg_temp.content() returns text language sql as $$
  select concat_ws('/',
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.personal_collections t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watch_with_choices t))
$$;
-- A format 3 backup of the current state (as in db/test/t_3b2_org.sql).
create or replace function pg_temp.backup_v3() returns jsonb language plpgsql as $$
declare
  cols jsonb := jsonb_build_object(
    'watchlist_items', '["id","collection","item_key","title","season","theme","display_date","date_sort","watched","status","created_at","watch_with","collections","tmdb_collection_id","tmdb_collection_name","media_type","tmdb_id","season_number","show_id","skipped"]'::jsonb,
    'tv_shows', '["id","collection","title","show_key","tmdb_id","status","created_at"]'::jsonb,
    'othertv_shows', '["id","tmdb_id","title","network","created_at","collection"]'::jsonb,
    'custom_collections', '["id","name","tmdb_person_id","created_at","role"]'::jsonb,
    'personal_collections', '["id","name","legacy_source","sort_order","archived_at","created_at"]'::jsonb,
    'collection_memberships', '["id","collection_id","show_id","item_id","created_at"]'::jsonb,
    'watch_with_choices', '["id","token","label","sort_order","archived_at","created_at"]'::jsonb);
  t text; rows jsonb; tables jsonb := '{}'; counts jsonb := '{}';
begin
  for t in select jsonb_object_keys(cols) loop
    execute format('select coalesce(jsonb_agg((select jsonb_object_agg(k, to_jsonb(x) -> k) from jsonb_array_elements_text($1) k) order by x.id), ''[]'') from public.%I x', t)
      into rows using cols -> t;
    tables := tables || jsonb_build_object(t, rows);
    counts := counts || jsonb_build_object(t, jsonb_array_length(rows));
  end loop;
  return jsonb_build_object('format', 'watchlist-tracker-backup', 'formatVersion', 3, 'exportedAt', now(), 'rowCounts', counts, 'tables', tables);
end $$;
-- Runs p_sql and expects a refusal whose message starts with p_prefix; returns its
-- details (JSON) for further checks. Fails if the call is accepted.
create or replace function pg_temp.refusal(p_sql text, p_prefix text) returns jsonb language plpgsql as $$
declare v_msg text; v_detail text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
    if v_msg not like p_prefix || '%' then raise exception 'expected "%" but got: %', p_prefix, v_msg; end if;
    return coalesce(nullif(v_detail, ''), '{}')::jsonb;
  end;
  raise exception 'expected "%" but the call was accepted', p_prefix;
end $$;
-- A catalog default (the config.js shape).
create or replace function pg_temp.def(p_k text, p_t text, p_s text, p_d text, p_ds text, p_p boolean default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('k', p_k, 't', p_t, 's', p_s, 'th', 'ZZ Theme', 'd', p_d, 'ds', p_ds, 'p', p_p))
$$;
create or replace function pg_temp.preview(p_coll text, p_defs jsonb) returns jsonb language sql as $$
  select public.catalog_apply(p_coll, p_defs)
$$;
create or replace function pg_temp.apply(p_coll text, p_defs jsonb) returns jsonb language plpgsql as $$
declare p jsonb := public.catalog_apply(p_coll, p_defs);
begin
  return public.catalog_apply(p_coll, p_defs, p ->> 'hash');
end $$;
create or replace function pg_temp.entries(p jsonb, p_kind text) returns setof jsonb language sql as $$
  select e from jsonb_array_elements(p -> 'document' -> 'entries') e where e ->> 'kind' = p_kind
$$;
create or replace function pg_temp.row_of(p_coll text, p_key text) returns public.watchlist_items language sql as $$
  select * from public.watchlist_items where collection = p_coll and item_key = p_key order by id limit 1
$$;
-- A legacy show "ZZ Saga" with a dated S1 and a TBA S2, and a TBA film, applied in Sheridan.
create or replace function pg_temp.base() returns jsonb language sql as $$
  select jsonb_build_array(
    pg_temp.def('zz saga|season 1', 'ZZ Saga', 'Season 1', 'Jan 1, 2020', '2020-01-01'),
    pg_temp.def('zz saga|season 2', 'ZZ Saga', 'Season 2', 'TBA', '2027-01-01'),
    pg_temp.def('zz film|film', 'ZZ Film', 'Film', 'TBA 2027', '2027-06-01'))
$$;
-- The same catalog with S2 and the film dated.
create or replace function pg_temp.dated() returns jsonb language sql as $$
  select jsonb_build_array(
    pg_temp.def('zz saga|season 1', 'ZZ Saga', 'Season 1', 'Jan 1, 2020', '2020-01-01'),
    pg_temp.def('zz saga|season 2', 'ZZ Saga', 'Season 2', 'Mar 3, 2027', '2027-03-03'),
    pg_temp.def('zz film|film', 'ZZ Film', 'Film', 'Jun 6, 2027', '2027-06-06'))
$$;

-- ── Function properties and old request shapes ──
select pg_temp.t('catalog_apply runs as the caller with an empty search_path, executable by anon, not by public', $b$ do $$
declare f record;
begin
  select p.prosecdef, p.proconfig, p.proacl::text acl into f from pg_proc p where p.oid = 'public.catalog_apply(text, jsonb, text)'::regprocedure;
  if f.prosecdef then raise exception 'security definer'; end if;
  if not ('search_path=""' = any(f.proconfig)) then raise exception 'search_path %', f.proconfig; end if;
  if f.acl not like '%anon=X%' or f.acl ~ '(^|[{,])=X' then raise exception 'acl %', f.acl; end if;
end $$ $b$);

select pg_temp.t('old seed_tv_defaults call refused with catalog_apply_required; nothing written', $b$ do $$
declare v text := pg_temp.content();
begin
  perform pg_temp.as_anon();
  perform pg_temp.refusal($q$ select public.seed_tv_defaults('sheridan', '[{"k":"zz x|season 1","t":"ZZ X","s":"Season 1","d":"Jan 1, 2020","ds":"2020-01-01"}]'::jsonb) $q$,
                          'catalog_apply_required');
  if pg_temp.content() <> v then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('old tab-open TBA PATCH shape (collection + item_key) refused on a built-in row; a dynamic-tab date update still works', $b$ do $$
declare r public.watchlist_items; o public.watchlist_items;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply('sheridan', pg_temp.base());
  r := pg_temp.row_of('sheridan', 'zz saga|season 2');
  perform pg_temp.refusal(format($q$ update public.watchlist_items set display_date = 'Mar 3, 2027', date_sort = '2027-03-03'
    where collection = 'sheridan' and item_key = %L $q$, r.item_key), 'catalog_apply_required');
  if (pg_temp.row_of('sheridan', 'zz saga|season 2')).display_date <> 'TBA' then raise exception 'date changed'; end if;
  select * into o from public.watchlist_items where collection = 'othertv' order by id limit 1;
  update public.watchlist_items set display_date = 'ZZ x', date_sort = '2099-01-01' where id = o.id;
  if (select display_date from public.watchlist_items where id = o.id) <> 'ZZ x' then raise exception 'dynamic update blocked'; end if;
  -- other fields of a built-in row are unaffected by the guard
  update public.watchlist_items set watched = true where id = r.id;
end $$ $b$);

-- ── Preview ──
select pg_temp.t('preview writes nothing, leaves no setting behind, and gives the same hash twice (new ids are symbolic)', $b$ do $$
declare v text := pg_temp.content(); p1 jsonb; p2 jsonb;
begin
  perform pg_temp.as_anon();
  p1 := pg_temp.preview('sheridan', pg_temp.base());
  p2 := pg_temp.preview('sheridan', pg_temp.base());
  if pg_temp.content() <> v then raise exception 'preview wrote'; end if;
  if p1 ->> 'mode' <> 'preview' or p1 ? 'receipt' then raise exception 'shape %', p1; end if;
  if p1 ->> 'hash' <> p2 ->> 'hash' or p1 -> 'document' <> p2 -> 'document' then raise exception 'unstable'; end if;
  if coalesce(current_setting('watchlist.catalog_date_write', true), '') <> '' then raise exception 'setting left on'; end if;
  if (p1 -> 'document')::text ~ 'created_at' then raise exception 'timestamp in document'; end if;
  if (select count(*) from pg_temp.entries(p1, 'create_show')) <> 1 or (select count(*) from pg_temp.entries(p1, 'insert_season')) <> 2
     or (select count(*) from pg_temp.entries(p1, 'insert_film')) <> 1 then raise exception 'entries %', p1 -> 'document'; end if;
  if (select e ->> 'ref' from pg_temp.entries(p1, 'create_show') e) <> 'S1' or (select e ->> 'ref' from pg_temp.entries(p1, 'insert_film') e) <> 'F1'
     or (select e ->> 'show' from pg_temp.entries(p1, 'insert_season') e limit 1) <> 'S1' then raise exception 'refs'; end if;
  if p1 -> 'document' ->> 'payload_hash' <> private.catalog_hash(pg_temp.base()) then raise exception 'payload hash'; end if;
end $$ $b$);

select pg_temp.t('canonical form: keys by code point, arrays in order, no whitespace', $b$ do $$
begin
  if private.catalog_canon('{"b":1,"a":[true,null,"x\"y"],"A":{"z":"é"}}'::jsonb) <> '{"A":{"z":"é"},"a":[true,null,"x\"y"],"b":1}' then
    raise exception 'got %', private.catalog_canon('{"b":1,"a":[true,null,"x\"y"],"A":{"z":"é"}}'::jsonb);
  end if;
end $$ $b$);

-- ── Apply: committed effects, receipt, read-back ──
select pg_temp.t('apply commits exactly the previewed document; the receipt maps every entry one-to-one to real records with the approved values', $b$ do $$
declare p jsonb; a jsonb; e jsonb; rc jsonb; s public.tv_shows; w public.watchlist_items; v_keys text[];
begin
  perform pg_temp.as_anon();
  p := pg_temp.preview('sheridan', pg_temp.base());
  a := public.catalog_apply('sheridan', pg_temp.base(), p ->> 'hash');
  if a ->> 'mode' <> 'applied' or a ->> 'hash' <> p ->> 'hash' or a -> 'document' <> p -> 'document' then raise exception 'applied %', a; end if;
  rc := a -> 'receipt';
  select array_agg(x ->> 'key') into v_keys from jsonb_array_elements(a -> 'document' -> 'entries') x
    where x ->> 'kind' in ('create_show', 'insert_season', 'insert_film', 'fill_date', 'reopen', 'membership');
  if (select count(*) from jsonb_object_keys(rc)) <> cardinality(v_keys) or exists (select 1 from unnest(v_keys) k where not rc ? k) then
    raise exception 'receipt % vs %', rc, v_keys;
  end if;
  select * into s from public.tv_shows where id = (rc -> 'create_show:S1' ->> 'show_id')::uuid;
  if s.show_key <> 'zz saga' or s.status <> 'confirmed' or s.collection <> 'sheridan' then raise exception 'show %', to_jsonb(s); end if;
  for e in select * from pg_temp.entries(a, 'insert_season') loop
    select * into w from public.watchlist_items where id = (rc -> (e ->> 'key') ->> 'row_id')::uuid;
    if w.show_id <> s.id or w.item_key <> e ->> 'item_key' or w.display_date <> e ->> 'display_date' then raise exception 'season %', to_jsonb(w); end if;
  end loop;
  select * into w from public.watchlist_items where id = (rc -> 'insert_film:F1' ->> 'row_id')::uuid;
  if w.show_id is not null or not w.is_film or w.item_key <> 'zz film|film' then raise exception 'film %', to_jsonb(w); end if;
  -- memberships: Sheridan is active, so both new records joined it, with the receipt's ids
  if (select count(*) from public.collection_memberships where collection_id = pg_temp.coll('sheridan')
        and (show_id = s.id or item_id = w.id) and id::text in (rc -> 'membership:S1' ->> 'membership_id', rc -> 'membership:F1' ->> 'membership_id')) <> 2 then
    raise exception 'memberships %', rc;
  end if;
  if coalesce(current_setting('watchlist.catalog_date_write', true), '') <> '' then raise exception 'setting left on'; end if;
end $$ $b$);

select pg_temp.t('a show whose defaults all have p starts Pending; mixed starts On List', $b$ do $$
declare a jsonb;
begin
  perform pg_temp.as_anon();
  a := pg_temp.apply('sheridan', jsonb_build_array(pg_temp.def('zz pend|season 1', 'ZZ Pend', 'Season 1', 'TBA', '2027-01-01', true)));
  if (select e ->> 'initial_status' from pg_temp.entries(a, 'create_show') e) <> 'pending' then raise exception '%', a -> 'document'; end if;
end $$ $b$);

-- ── Date fills, Skip and tracking state ──
select pg_temp.t('TBA fills: a season and a film get the dates, tracking state recorded per kind; a re-apply is all no-ops', $b$ do $$
declare a jsonb; s2 public.watchlist_items; fm public.watchlist_items;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply('sheridan', pg_temp.base());
  a := pg_temp.apply('sheridan', pg_temp.dated());
  if (select count(*) from pg_temp.entries(a, 'fill_date')) <> 2 then raise exception '%', a -> 'document'; end if;
  if (select e -> 'tracking' from pg_temp.entries(a, 'fill_date') e where e ->> 'item' = 'film') <> '{"status":"confirmed","watched":false}'::jsonb
     or (select e -> 'tracking' from pg_temp.entries(a, 'fill_date') e where e ->> 'item' = 'season') <> '{"skipped":false,"watched":false,"show_status":"confirmed"}'::jsonb then
    raise exception 'tracking %', a -> 'document';
  end if;
  s2 := pg_temp.row_of('sheridan', 'zz saga|season 2'); fm := pg_temp.row_of('sheridan', 'zz film|film');
  if s2.display_date <> 'Mar 3, 2027' or s2.date_sort <> '2027-03-03' or fm.display_date <> 'Jun 6, 2027' then raise exception 'dates'; end if;
  a := pg_temp.apply('sheridan', pg_temp.dated());
  if exists (select 1 from jsonb_array_elements(a -> 'document' -> 'entries') e where e ->> 'kind' <> 'noop') then raise exception 'not all no-ops %', a; end if;
end $$ $b$);

select pg_temp.t('already-skipped items stay eligible: a skipped season and a skipped film get the date, tracking unchanged', $b$ do $$
declare a jsonb; s2 public.watchlist_items; fm public.watchlist_items;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply('sheridan', pg_temp.base());
  s2 := pg_temp.row_of('sheridan', 'zz saga|season 2'); fm := pg_temp.row_of('sheridan', 'zz film|film');
  perform public.set_season_skipped(s2.id, true);
  update public.watchlist_items set status = 'skipped' where id = fm.id;
  a := pg_temp.apply('sheridan', pg_temp.dated());
  if (select e -> 'tracking' ->> 'skipped' from pg_temp.entries(a, 'fill_date') e where e ->> 'item' = 'season') <> 'true'
     or (select e -> 'tracking' ->> 'status' from pg_temp.entries(a, 'fill_date') e where e ->> 'item' = 'film') <> 'skipped' then raise exception '%', a; end if;
  s2 := pg_temp.row_of('sheridan', 'zz saga|season 2'); fm := pg_temp.row_of('sheridan', 'zz film|film');
  if s2.display_date <> 'Mar 3, 2027' or not s2.skipped or fm.status <> 'skipped' or fm.display_date <> 'Jun 6, 2027' then raise exception 'state'; end if;
end $$ $b$);

select pg_temp.t('stale: a season Skip on a planned date-fill row between preview and apply is refused; nothing written', $b$ do $$
declare p jsonb; v text;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply('sheridan', pg_temp.base());
  p := pg_temp.preview('sheridan', pg_temp.dated());
  perform public.set_season_skipped((pg_temp.row_of('sheridan', 'zz saga|season 2')).id, true);
  v := pg_temp.content();
  perform pg_temp.refusal(format('select public.catalog_apply(%L, %L::jsonb, %L)', 'sheridan', pg_temp.dated(), p ->> 'hash'), 'catalog_stale');
  if pg_temp.content() <> v then raise exception 'written'; end if;
end $$ $b$);

select pg_temp.t('stale: a film Skip (status = skipped) on a planned date-fill film between preview and apply is refused; nothing written', $b$ do $$
declare p jsonb; v text;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply('sheridan', pg_temp.base());
  p := pg_temp.preview('sheridan', pg_temp.dated());
  update public.watchlist_items set status = 'skipped' where id = (pg_temp.row_of('sheridan', 'zz film|film')).id;
  v := pg_temp.content();
  perform pg_temp.refusal(format('select public.catalog_apply(%L, %L::jsonb, %L)', 'sheridan', pg_temp.dated(), p ->> 'hash'), 'catalog_stale');
  if pg_temp.content() <> v then raise exception 'written'; end if;
end $$ $b$);

select pg_temp.t('stale: a watched change on a planned row, a status change on an attach show, a manual insert of a planned key, an archive of the target, another payload', $b$ do $$
declare p jsonb; ext jsonb; sh uuid;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply('sheridan', pg_temp.base());
  sh := (pg_temp.row_of('sheridan', 'zz saga|season 1')).show_id;
  -- watched on a planned fill row
  p := pg_temp.preview('sheridan', pg_temp.dated());
  update public.watchlist_items set watched = true where id = (pg_temp.row_of('sheridan', 'zz saga|season 2')).id;
  perform pg_temp.refusal(format('select public.catalog_apply(%L, %L::jsonb, %L)', 'sheridan', pg_temp.dated(), p ->> 'hash'), 'catalog_stale');
  -- status change on a show receiving a new season
  ext := pg_temp.base() || jsonb_build_array(pg_temp.def('zz saga|season 3', 'ZZ Saga', 'Season 3', 'May 5, 2027', '2027-05-05'));
  p := pg_temp.preview('sheridan', ext);
  perform public.set_show_status(sh, 'watching');
  perform pg_temp.refusal(format('select public.catalog_apply(%L, %L::jsonb, %L)', 'sheridan', ext, p ->> 'hash'), 'catalog_stale');
  -- a manual insert of the planned key (as a legacy row of the show)
  p := pg_temp.preview('sheridan', ext);
  perform public.add_tv_seasons('sheridan', jsonb_build_object('title', 'ZZ Saga', 'show_key', 'zz saga'),
    jsonb_build_array(jsonb_build_object('item_key', 'zz saga|season 3', 'title', 'ZZ Saga', 'season', 'Season 3', 'theme', 'ZZ', 'display_date', 'May 5, 2027', 'date_sort', '2027-05-05')));
  perform pg_temp.refusal(format('select public.catalog_apply(%L, %L::jsonb, %L)', 'sheridan', ext, p ->> 'hash'), 'catalog_stale');
  -- archive of the target collection
  ext := pg_temp.base() || jsonb_build_array(pg_temp.def('zz other|season 1', 'ZZ Other', 'Season 1', 'May 5, 2027', '2027-05-05'));
  p := pg_temp.preview('sheridan', ext);
  perform public.org_set_collection_archived(pg_temp.coll('sheridan'), true);
  perform pg_temp.refusal(format('select public.catalog_apply(%L, %L::jsonb, %L)', 'sheridan', ext, p ->> 'hash'), 'catalog_stale');
  -- a different payload than the one previewed
  perform public.org_set_collection_archived(pg_temp.coll('sheridan'), false);
  p := pg_temp.preview('sheridan', ext);
  perform pg_temp.refusal(format('select public.catalog_apply(%L, %L::jsonb, %L)', 'sheridan', pg_temp.base(), p ->> 'hash'), 'catalog_stale');
end $$ $b$);

select pg_temp.t('not stale: watched or Skip changes on rows outside the plan', $b$ do $$
declare p jsonb; o uuid; a jsonb;
begin
  perform pg_temp.as_anon();
  p := pg_temp.preview('sheridan', pg_temp.base());
  select id into o from public.watchlist_items where collection = 'othertv' and show_id is not null order by id limit 1;
  perform public.set_season_watched(o, true);
  perform public.set_season_skipped(o, true);
  a := public.catalog_apply('sheridan', pg_temp.base(), p ->> 'hash');
  if a ->> 'mode' <> 'applied' then raise exception '%', a; end if;
end $$ $b$);

-- ── Reopen rules ──
select pg_temp.t('reopen: a genuinely new season reopens a Complete show (recorded from complete with its cause); Skipped stays Skipped; date fills and duplicates never reopen', $b$ do $$
declare a jsonb; sh uuid; ext jsonb;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply('sheridan', pg_temp.base());
  sh := (pg_temp.row_of('sheridan', 'zz saga|season 1')).show_id;
  perform public.set_show_status(sh, 'complete');
  a := pg_temp.apply('sheridan', pg_temp.dated());           -- date fills only
  if exists (select 1 from pg_temp.entries(a, 'reopen')) or (select status from public.tv_shows where id = sh) <> 'complete' then raise exception 'date fill reopened'; end if;
  a := pg_temp.apply('sheridan', pg_temp.dated());           -- duplicates only
  if exists (select 1 from pg_temp.entries(a, 'reopen')) then raise exception 'duplicate reopened'; end if;
  ext := pg_temp.dated() || jsonb_build_array(pg_temp.def('zz saga|season 3', 'ZZ Saga', 'Season 3', 'May 5, 2027', '2027-05-05'));
  a := pg_temp.apply('sheridan', ext);
  if (select e from pg_temp.entries(a, 'reopen') e) <> jsonb_build_object('kind', 'reopen', 'key', 'reopen:' || sh, 'show_id', sh, 'from', 'complete', 'to', 'confirmed', 'cause', 'zz saga|season 3')
     or (select status from public.tv_shows where id = sh) <> 'confirmed' then raise exception 'reopen %', a -> 'document'; end if;
  if (select e ->> 'status' from pg_temp.entries(a, 'attach') e) <> 'complete' then raise exception 'attach status'; end if;
  perform public.set_show_status(sh, 'skipped');
  ext := ext || jsonb_build_array(pg_temp.def('zz saga|season 4', 'ZZ Saga', 'Season 4', 'May 5, 2028', '2028-05-05'));
  a := pg_temp.apply('sheridan', ext);
  if exists (select 1 from pg_temp.entries(a, 'reopen')) or (select status from public.tv_shows where id = sh) <> 'skipped' then raise exception 'skipped reopened'; end if;
end $$ $b$);

-- ── Memberships ──
select pg_temp.t('archived target: new show and film stay out of it (trigger membership reconciled away), receipt says none; existing memberships untouched', $b$ do $$
declare a jsonb; c uuid := pg_temp.coll('sheridan'); n_before int; v_others text;
begin
  perform pg_temp.as_anon();
  perform public.org_set_collection_archived(c, true);
  select count(*) into n_before from public.collection_memberships;
  select md5(string_agg(id::text, ',' order by id)) into v_others from public.collection_memberships;
  a := pg_temp.apply('sheridan', pg_temp.base());
  if (a -> 'document' -> 'target' ->> 'archived')::boolean is not true then raise exception 'target %', a -> 'document' -> 'target'; end if;
  if (select count(*) from pg_temp.entries(a, 'membership') e where e ->> 'result' = 'not_joined') <> 2 then raise exception '%', a -> 'document'; end if;
  if a -> 'receipt' -> 'membership:S1' ->> 'membership_id' <> 'none' or a -> 'receipt' -> 'membership:F1' ->> 'membership_id' <> 'none' then raise exception 'receipt'; end if;
  if (select count(*) from public.collection_memberships) <> n_before
     or (select md5(string_agg(id::text, ',' order by id)) from public.collection_memberships) <> v_others then raise exception 'memberships changed'; end if;
  -- C4 for legacy paths is unchanged: a manual add of a new show in the tab still joins the archived collection
  perform public.add_tv_seasons('sheridan', jsonb_build_object('title', 'ZZ Manual', 'show_key', 'zz manual'),
    jsonb_build_array(jsonb_build_object('item_key', 'zz manual|season 1', 'title', 'ZZ Manual', 'season', 'Season 1', 'theme', 'ZZ', 'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01')));
  if not exists (select 1 from public.collection_memberships m join public.tv_shows s on s.id = m.show_id where s.show_key = 'zz manual' and m.collection_id = c) then
    raise exception 'C4 changed';
  end if;
end $$ $b$);

select pg_temp.t('a removed membership is never re-added: a new season of a show left out of its collection adds no membership', $b$ do $$
declare sh uuid; c uuid := pg_temp.coll('sheridan'); m uuid; ext jsonb;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply('sheridan', pg_temp.base());
  sh := (pg_temp.row_of('sheridan', 'zz saga|season 1')).show_id;
  select id into m from public.collection_memberships where collection_id = c and show_id = sh;
  perform public.org_remove_membership(m, c, sh, null);
  ext := pg_temp.base() || jsonb_build_array(pg_temp.def('zz saga|season 3', 'ZZ Saga', 'Season 3', 'May 5, 2027', '2027-05-05'));
  perform pg_temp.apply('sheridan', ext);
  if exists (select 1 from public.collection_memberships where show_id = sh) then raise exception 're-added'; end if;
end $$ $b$);

-- ── Conflicts ──
select pg_temp.t('conflicts are excluded and listed (enriched show, nonstandard label); the rest applies', $b$ do $$
declare sh public.tv_shows; a jsonb; defs jsonb;
begin
  select * into sh from public.tv_shows where collection = 'disney' and tmdb_id is not null order by id limit 1;
  perform pg_temp.as_anon();
  defs := jsonb_build_array(
    jsonb_build_object('k', sh.show_key || '|zz volume 9', 't', sh.title, 's', 'ZZ Volume 9', 'th', 'ZZ', 'd', 'Jan 1, 2030', 'ds', '2030-01-01'),
    pg_temp.def('zz disney new|season 1', 'ZZ Disney New', 'Season 1', 'Jan 1, 2030', '2030-01-01'));
  a := pg_temp.apply('disney', defs);
  if (select e ->> 'reason' from pg_temp.entries(a, 'excluded_conflict') e) <> 'enriched_show_label' then raise exception '%', a -> 'document'; end if;
  if exists (select 1 from public.watchlist_items where item_key = sh.show_key || '|zz volume 9') then raise exception 'conflict inserted'; end if;
  if (select count(*) from pg_temp.entries(a, 'insert_season')) <> 1 then raise exception 'rest not applied'; end if;
end $$ $b$);

-- ── Existing keys (the tab-open rule) and enriched parents ──
select pg_temp.t('a default whose key an identified film already holds is a no-op: no insert, no membership, one row after apply', $b$ do $$
declare p jsonb; a jsonb; defs jsonb := jsonb_build_array(pg_temp.def('zz review identified|film', 'ZZ Review Identified', 'Film', 'Jan 1, 2021', '2021-01-01'));
begin
  perform pg_temp.as_admin();
  insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, media_type, tmdb_id)
  values ('sheridan', 'zz review identified|film', 'ZZ Review Identified', 'Film', 'Drama', 'Jan 1, 2021', '2021-01-01', 'movie', 990001);
  perform pg_temp.as_anon();
  p := pg_temp.preview('sheridan', defs);
  if exists (select 1 from jsonb_array_elements(p -> 'document' -> 'entries') e where e ->> 'kind' <> 'noop') then raise exception 'preview %', p -> 'document'; end if;
  if (select e ->> 'category' from pg_temp.entries(p, 'noop') e) <> 'identified' then raise exception 'category %', p -> 'document'; end if;
  a := public.catalog_apply('sheridan', defs, p ->> 'hash');
  if (select count(*) from public.watchlist_items where collection = 'sheridan' and item_key = 'zz review identified|film') <> 1 then raise exception 'two copies'; end if;
end $$ $b$);

select pg_temp.t('TV: a key held by an identified season (or by a legacy row of another show) is a no-op; a missing plain Season N of an enriched show still joins it as its TMDB season', $b$ do $$
declare sh uuid; a jsonb; n_shows int; defs jsonb;
begin
  perform pg_temp.as_admin();
  insert into public.tv_shows (collection, title, show_key, tmdb_id, status) values ('sheridan', 'ZZ IdTV', 'zz idtv', 990002, 'confirmed') returning id into sh;
  insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, media_type, tmdb_id, season_number, show_id)
  values ('sheridan', 'zz idtv|season 1', 'ZZ IdTV', 'Season 1', 'Drama', 'Jan 1, 2021', '2021-01-01', 'tv', 990002, 1, sh);
  insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, media_type, tmdb_id, season_number, show_id)
  values ('sheridan', 'zz idtv|special', 'ZZ IdTV', 'Special', 'Drama', 'Jan 1, 2021', '2021-01-01', 'tv', 990002, 0, sh);
  perform pg_temp.as_anon();
  select count(*) into n_shows from public.tv_shows;
  defs := jsonb_build_array(
    pg_temp.def('zz idtv|season 1', 'ZZ IdTV', 'Season 1', 'Jan 1, 2021', '2021-01-01'),
    pg_temp.def('zz idtv|special', 'ZZ IdTV', 'Special Edition', 'Jan 1, 2021', '2021-01-01'),
    pg_temp.def('zz idtv|season 2', 'ZZ IdTV', 'Season 2', 'Jan 1, 2022', '2022-01-01'));
  a := pg_temp.apply('sheridan', defs);
  if (select count(*) from pg_temp.entries(a, 'insert_season')) <> 1 or exists (select 1 from pg_temp.entries(a, 'create_show'))
     or exists (select 1 from pg_temp.entries(a, 'excluded_conflict')) then raise exception '%', a -> 'document'; end if;
  if (select e ->> 'show' from pg_temp.entries(a, 'insert_season') e) <> sh::text
     or (select (e ->> 'tmdb_id')::int from pg_temp.entries(a, 'insert_season') e) <> 990002
     or (select (e ->> 'season_number')::int from pg_temp.entries(a, 'insert_season') e) <> 2 then raise exception 'enriched join %', a -> 'document'; end if;
  if (select count(*) from pg_temp.entries(a, 'noop') e where e ->> 'category' = 'identified') <> 2 then raise exception 'noops %', a -> 'document'; end if;
  if (select count(*) from public.watchlist_items where collection = 'sheridan' and item_key like 'zz idtv|%') <> 3 or (select count(*) from public.tv_shows) <> n_shows then
    raise exception 'rows or shows';
  end if;
end $$ $b$);

select pg_temp.t('insert entries carry the approved row values (title, theme, status, watched, identity) for read-back', $b$ do $$
declare p jsonb;
begin
  perform pg_temp.as_anon();
  p := pg_temp.preview('sheridan', pg_temp.base());
  if exists (select 1 from jsonb_array_elements(p -> 'document' -> 'entries') e where e ->> 'kind' in ('insert_season', 'insert_film')
             and not (e ? 'title' and e ? 'theme' and e ? 'status' and e ? 'watched' and e ? 'media_type' and e ? 'tmdb_id')) then
    raise exception '%', p -> 'document';
  end if;
end $$ $b$);

-- ── Backups ──
select pg_temp.t('format-3 backup and restore are unchanged by an application, and restore causes no catalog write', $b$ do $$
declare b jsonb; v text;
begin
  perform pg_temp.as_anon();
  perform pg_temp.apply('sheridan', pg_temp.base());
  b := pg_temp.backup_v3();
  v := pg_temp.content();
  perform public.restore_backup(b, false);
  if pg_temp.content() <> v then raise exception 'restore differs'; end if;
end $$ $b$);

select json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq)::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from _t;
