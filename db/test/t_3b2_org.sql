-- Checks for Stage 3b-2 (prepend db/test/_prelude.sql). Run as postgres after
-- db/phase3b2_org_write.sql, at stage final, on a replica or test project. Every
-- check works on synthetic ZZ rows inside its own rolled-back subtransaction and
-- calls the database as anon, the way the app does. These are single-session
-- checks: they don't show how two sessions interleave (that needs two real
-- connections, on a hosted test project).

create or replace function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true);
$$;
create or replace function pg_temp.as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true);
$$;
create or replace function pg_temp.coll(p_source text) returns uuid language sql as $$
  select id from public.personal_collections where legacy_source = p_source and user_id = private.current_owner_id()
$$;
create or replace function pg_temp.legacy_film(p_coll text, p_title text) returns uuid language sql as $$
  insert into public.watchlist_items (collection, item_key, title, season, date_sort)
  values (p_coll, lower(p_title) || '|film', p_title, 'Film', '2020-01-01') returning id
$$;
create or replace function pg_temp.match_patch(p_title text, p_tmdb int, p_num int) returns jsonb language sql as $$
  select jsonb_build_object('title', p_title, 'season', 'Season ' || p_num, 'item_key', lower(p_title) || '|season ' || p_num,
    'theme', 'ZZ Net', 'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01', 'media_type', 'tv', 'tmdb_id', p_tmdb, 'season_number', p_num)
$$;
-- Tracking content (everything except owner and generated columns): organization
-- edits must never change it.
create or replace function pg_temp.tracking() returns text language sql as $$
  select concat_ws('/',
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.othertv_shows t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.custom_collections t))
$$;
create or replace function pg_temp.content() returns text language sql as $$
  select concat_ws('/', pg_temp.tracking(),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.personal_collections t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watch_with_choices t))
$$;
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
create or replace function pg_temp.one_show() returns uuid language sql as $$
  select id from public.tv_shows where user_id = private.current_owner_id() order by id limit 1
$$;
create or replace function pg_temp.season_of_any_show() returns uuid language sql as $$
  select id from public.watchlist_items where show_id is not null and user_id = private.current_owner_id() order by id limit 1
$$;

-- ── Capability and function properties ──
select pg_temp.t('org_capabilities: read-only, answers {"org_write": 1}, changes nothing', $b$ do $$
declare v_before text := pg_temp.content(); r jsonb;
begin
  perform pg_temp.as_anon();
  r := public.org_capabilities();
  if r <> '{"org_write": 1}'::jsonb then raise exception 'got %', r; end if;
  if (select provolatile from pg_proc where oid = 'public.org_capabilities()'::regprocedure) <> 's' then raise exception 'not STABLE'; end if;
  if pg_temp.content() <> v_before then raise exception 'changed data'; end if;
end $$ $b$);

select pg_temp.t('every 3b-2 function runs as the caller with an empty search_path, executable by anon, not by public', $b$ do $$
declare f record; n int := 0;
begin
  for f in select p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl::text acl from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where (s.nspname = 'public' and p.proname like 'org\_%') or (s.nspname = 'private' and p.proname in ('org_refuse', 'org_clean_text')) loop
    n := n + 1;
    if f.prosecdef then raise exception '% is security definer', f.proname; end if;
    if not ('search_path=""' = any(f.proconfig)) then raise exception '% has no empty search_path (%)', f.proname, f.proconfig; end if;
    if f.acl not like '%anon=X%' then raise exception '% not executable by anon (%)', f.proname, f.acl; end if;
    if f.acl ~ '(^|[{,])=X' then raise exception '% executable by public (%)', f.proname, f.acl; end if;
  end loop;
  if n <> 11 then raise exception 'expected 11 functions (9 public + 2 private helpers), found %', n; end if;
end $$ $b$);

-- ── Create collection: trimming, order, same-id idempotence, uniqueness ──
select pg_temp.t('create collection: trimmed, at the end of the order, no legacy source; a repeat with the same id returns it unmodified', $b$ do $$
declare r jsonb; r2 jsonb; v_max int; id1 uuid := 'c3b20000-0000-4000-8000-000000000001';
begin
  perform pg_temp.as_anon();
  select max(sort_order) into v_max from public.personal_collections;
  r := public.org_create_collection(id1, '   ZZ Faves  ');
  if r -> 'collection' ->> 'name' <> 'ZZ Faves' or (r ->> 'existing')::boolean then raise exception 'create: %', r; end if;
  if (r -> 'collection' ->> 'sort_order')::int <> v_max + 1 or r -> 'collection' ->> 'legacy_source' is not null
     or r -> 'collection' ->> 'archived_at' is not null or r -> 'collection' ? 'user_id' then raise exception 'record: %', r; end if;
  r2 := public.org_create_collection(id1, 'ZZ Faves');
  if not (r2 ->> 'existing')::boolean or r2 -> 'collection' <> r -> 'collection' then raise exception 'repeat: %', r2; end if;
  -- the id decides: a repeat with another name returns the stored record as is
  r2 := public.org_create_collection(id1, 'ZZ Something Else');
  if not (r2 ->> 'existing')::boolean or r2 -> 'collection' ->> 'name' <> 'ZZ Faves' then raise exception 'other name: %', r2; end if;
  -- same id while the name is taken by a different record: the id arbiter wins, nothing inserted
  r2 := public.org_create_collection(id1, 'Disney+');
  if not (r2 ->> 'existing')::boolean or r2 -> 'collection' ->> 'name' <> 'ZZ Faves' then raise exception 'taken name, same id: %', r2; end if;
  if (select count(*) from public.personal_collections where id = id1) <> 1 then raise exception 'duplicated'; end if;
end $$ $b$);

select pg_temp.t('create collection: a same-id repeat after a rename or an archive returns the current record and never reverses it', $b$ do $$
declare r jsonb; id1 uuid := 'c3b20000-0000-4000-8000-000000000002';
begin
  perform pg_temp.as_anon();
  perform public.org_create_collection(id1, 'ZZ First');
  perform public.org_rename_collection(id1, 'ZZ First', 'ZZ Renamed');
  r := public.org_create_collection(id1, 'ZZ First');
  if not (r ->> 'existing')::boolean or r -> 'collection' ->> 'name' <> 'ZZ Renamed' then raise exception 'after rename: %', r; end if;
  perform public.org_set_collection_archived(id1, true);
  r := public.org_create_collection(id1, 'ZZ First');
  if not (r ->> 'existing')::boolean or r -> 'collection' ->> 'archived_at' is null then raise exception 'after archive: %', r; end if;
  if (select name from public.personal_collections where id = id1) <> 'ZZ Renamed' then raise exception 'reversed'; end if;
end $$ $b$);

select pg_temp.t('create collection: names are unique ignoring case and spaces, archived ones included; the refusal names the conflict', $b$ do $$
declare d jsonb; id1 uuid := 'c3b20000-0000-4000-8000-000000000003';
begin
  perform pg_temp.as_anon();
  perform public.org_create_collection(id1, 'ZZ Faves');
  d := pg_temp.refusal($q$select public.org_create_collection('c3b20000-0000-4000-8000-000000000004', ' zz faves ')$q$, 'org_name_taken:');
  if (d ->> 'conflict_id')::uuid <> id1 or (d ->> 'archived')::boolean then raise exception 'active conflict detail: %', d; end if;
  perform public.org_set_collection_archived(id1, true);
  d := pg_temp.refusal($q$select public.org_create_collection('c3b20000-0000-4000-8000-000000000004', 'ZZ FAVES')$q$, 'org_name_taken:');
  if (d ->> 'conflict_id')::uuid <> id1 or not (d ->> 'archived')::boolean then raise exception 'archived conflict detail: %', d; end if;
  perform pg_temp.refusal($q$select public.org_create_collection('c3b20000-0000-4000-8000-000000000004', 'disney+')$q$, 'org_name_taken:');
  if exists (select 1 from public.personal_collections where id = 'c3b20000-0000-4000-8000-000000000004') then raise exception 'inserted'; end if;
end $$ $b$);

select pg_temp.t('create collection: empty, blank or over-long names and a missing id are refused; nothing is written', $b$ do $$
declare v_before text := pg_temp.content();
begin
  perform pg_temp.as_anon();
  perform pg_temp.refusal($q$select public.org_create_collection('c3b20000-0000-4000-8000-000000000005', '')$q$, 'org_invalid_name:');
  perform pg_temp.refusal($q$select public.org_create_collection('c3b20000-0000-4000-8000-000000000005', '    ')$q$, 'org_invalid_name:');
  perform pg_temp.refusal($q$select public.org_create_collection('c3b20000-0000-4000-8000-000000000005', null)$q$, 'org_invalid_name:');
  perform pg_temp.refusal(format('select public.org_create_collection(%L, %L)', 'c3b20000-0000-4000-8000-000000000005', repeat('x', 101)), 'org_invalid_name:');
  perform public.org_create_collection('c3b20000-0000-4000-8000-000000000006', repeat('y', 100)); -- 100 is allowed
  perform pg_temp.refusal($q$select public.org_create_collection(null, 'ZZ No Id')$q$, 'invalid_input:');
  if (select count(*) from public.personal_collections where id = 'c3b20000-0000-4000-8000-000000000005') <> 0 then raise exception 'written'; end if;
end $$ $b$);

select pg_temp.t('create collection / choice: an id owned by another owner is refused as org_id_taken (not as a name conflict)', $b$ do $$
begin
  perform pg_temp.as_admin();
  insert into public.personal_collections (id, user_id, name, sort_order)
  values ('c3b20000-0000-4000-8000-0000000000aa', '99999999-0000-4000-8000-000000000002', 'ZZ Theirs', 1);
  insert into public.watch_with_choices (id, user_id, token, label, sort_order)
  values ('e3b20000-0000-4000-8000-0000000000aa', '99999999-0000-4000-8000-000000000002', 'ww:e3b20000-0000-4000-8000-0000000000aa', 'ZZ Theirs', 1);
  perform pg_temp.as_anon();
  perform pg_temp.refusal($q$select public.org_create_collection('c3b20000-0000-4000-8000-0000000000aa', 'ZZ Mine')$q$, 'org_id_taken:');
  perform pg_temp.refusal($q$select public.org_create_choice('e3b20000-0000-4000-8000-0000000000aa', 'ZZ Mine')$q$, 'org_id_taken:');
end $$ $b$);

-- ── Rename and archive (guarded) ──
select pg_temp.t('rename collection: guarded by the name the page showed; case-only change allowed; conflicts and missing ids refused', $b$ do $$
declare d jsonb; r jsonb; v_disney uuid;
begin
  perform pg_temp.as_anon();
  v_disney := pg_temp.coll('disney');
  d := pg_temp.refusal(format('select public.org_rename_collection(%L, %L, %L)', v_disney, 'Not The Name', 'ZZ D'), 'org_conflict:');
  if d -> 'current' ->> 'name' <> 'Disney+' then raise exception 'current: %', d; end if;
  r := public.org_rename_collection(v_disney, 'Disney+', 'DISNEY+');
  if r -> 'collection' ->> 'name' <> 'DISNEY+' or r -> 'collection' ->> 'legacy_source' <> 'disney' then raise exception 'case-only: %', r; end if;
  perform pg_temp.refusal(format('select public.org_rename_collection(%L, %L, %L)', v_disney, 'DISNEY+', ' sheridan '), 'org_name_taken:');
  perform pg_temp.refusal(format('select public.org_rename_collection(%L, %L, %L)', gen_random_uuid(), 'x', 'y'), 'org_not_found:');
  perform pg_temp.refusal(format('select public.org_rename_collection(%L, %L, %L)', v_disney, 'DISNEY+', ''), 'org_invalid_name:');
  r := public.org_rename_collection(v_disney, 'DISNEY+', 'DISNEY+'); -- same name: no change
  if (select name from public.personal_collections where id = v_disney) <> 'DISNEY+' then raise exception 'changed'; end if;
end $$ $b$);

select pg_temp.t('archive / unarchive collection: strict; a request for the state it already has is refused with the current record; members, order and source kept', $b$ do $$
declare d jsonb; r jsonb; v uuid; n int; o int;
begin
  perform pg_temp.as_anon();
  v := pg_temp.coll('90day');
  select count(*) into n from public.collection_memberships where collection_id = v;
  select sort_order into o from public.personal_collections where id = v;
  r := public.org_set_collection_archived(v, true);
  if r -> 'collection' ->> 'archived_at' is null then raise exception 'not archived'; end if;
  d := pg_temp.refusal(format('select public.org_set_collection_archived(%L, true)', v), 'org_conflict:');
  if d -> 'current' ->> 'archived_at' is null then raise exception 'detail: %', d; end if;
  if (select count(*) from public.collection_memberships where collection_id = v) <> n then raise exception 'members changed'; end if;
  r := public.org_set_collection_archived(v, false);
  if r -> 'collection' ->> 'archived_at' is not null or (r -> 'collection' ->> 'sort_order')::int <> o
     or r -> 'collection' ->> 'legacy_source' <> '90day' then raise exception 'unarchive: %', r; end if;
  perform pg_temp.refusal(format('select public.org_set_collection_archived(%L, false)', v), 'org_conflict:');
  perform pg_temp.refusal(format('select public.org_set_collection_archived(%L, true)', gen_random_uuid()), 'org_not_found:');
end $$ $b$);

-- ── Memberships ──
select pg_temp.t('add: a whole show (any storage tab) and a film; a repeat is a no-op returning the existing membership; tracking unchanged', $b$ do $$
declare v_track text; r jsonb; r2 jsonb; c uuid := 'c3b20000-0000-4000-8000-000000000010'; s uuid; f uuid;
begin
  perform pg_temp.as_anon();
  perform public.org_create_collection(c, 'ZZ Mix');
  s := (select id from public.tv_shows where user_id = private.current_owner_id() and collection = 'othertv' order by id limit 1);
  if s is null then s := pg_temp.one_show(); end if;
  f := pg_temp.legacy_film('movies', 'ZZ Film A');
  v_track := pg_temp.tracking();
  r := public.org_add_membership(c, s, null);
  if not (r ->> 'added')::boolean or (r -> 'membership' ->> 'show_id')::uuid <> s or r -> 'membership' ? 'item_is_film' then raise exception 'show: %', r; end if;
  r2 := public.org_add_membership(c, s, null);
  if (r2 ->> 'added')::boolean or r2 -> 'membership' ->> 'id' <> r -> 'membership' ->> 'id' then raise exception 'repeat: %', r2; end if;
  r := public.org_add_membership(c, null, f);
  if not (r ->> 'added')::boolean or (r -> 'membership' ->> 'item_id')::uuid <> f then raise exception 'film: %', r; end if;
  if pg_temp.tracking() <> v_track then raise exception 'tracking changed'; end if;
  if (select count(*) from public.collection_memberships where collection_id = c) <> 2 then raise exception 'count'; end if;
end $$ $b$);

select pg_temp.t('add: refused for an archived collection, a missing collection or target, a TV season given as a film, or a bad target', $b$ do $$
declare c uuid := 'c3b20000-0000-4000-8000-000000000011'; s uuid := pg_temp.one_show(); season uuid := pg_temp.season_of_any_show(); d jsonb;
begin
  perform pg_temp.as_anon();
  perform public.org_create_collection(c, 'ZZ Arch');
  perform public.org_set_collection_archived(c, true);
  perform pg_temp.refusal(format('select public.org_add_membership(%L, %L, null)', c, s), 'org_archived:');
  perform pg_temp.refusal(format('select public.org_add_membership(%L, %L, null)', gen_random_uuid(), s), 'org_not_found:');
  perform public.org_set_collection_archived(c, false);
  perform pg_temp.refusal(format('select public.org_add_membership(%L, %L, null)', c, gen_random_uuid()), 'org_target_missing:');
  perform pg_temp.refusal(format('select public.org_add_membership(%L, null, %L)', c, gen_random_uuid()), 'org_target_missing:');
  d := pg_temp.refusal(format('select public.org_add_membership(%L, null, %L)', c, season), 'org_not_film:');
  if d ->> 'show_id' is null then raise exception 'not_film detail: %', d; end if;
  perform pg_temp.refusal(format('select public.org_add_membership(%L, %L, %L)', c, s, season), 'invalid_input:');
  perform pg_temp.refusal(format('select public.org_add_membership(%L, null, null)', c), 'invalid_input:');
  if exists (select 1 from public.collection_memberships where collection_id = c) then raise exception 'written'; end if;
end $$ $b$);

select pg_temp.t('remove: exactly the membership named, while it still joins that collection and target; otherwise removed:false and nothing else touched', $b$ do $$
declare c uuid := 'c3b20000-0000-4000-8000-000000000012'; c2 uuid := 'c3b20000-0000-4000-8000-000000000013';
  s uuid := pg_temp.one_show(); s2 uuid; m uuid; m2 uuid; r jsonb;
begin
  perform pg_temp.as_anon();
  perform public.org_create_collection(c, 'ZZ R1');
  perform public.org_create_collection(c2, 'ZZ R2');
  s2 := (select id from public.tv_shows where user_id = private.current_owner_id() and id <> s order by id limit 1);
  m := (public.org_add_membership(c, s, null) -> 'membership' ->> 'id')::uuid;
  m2 := (public.org_add_membership(c2, s, null) -> 'membership' ->> 'id')::uuid;
  -- wrong collection or wrong target for that id: nothing removed
  r := public.org_remove_membership(m, c2, s, null);
  if (r ->> 'removed')::boolean or r ->> 'reason' <> 'not_found' then raise exception 'wrong collection: %', r; end if;
  r := public.org_remove_membership(m, c, s2, null);
  if (r ->> 'removed')::boolean then raise exception 'wrong target: %', r; end if;
  if not exists (select 1 from public.collection_memberships where id = m) or not exists (select 1 from public.collection_memberships where id = m2) then
    raise exception 'removed a membership it should not have'; end if;
  r := public.org_remove_membership(m, c, s, null);
  if not (r ->> 'removed')::boolean or (r ->> 'membership_id')::uuid <> m then raise exception 'remove: %', r; end if;
  r := public.org_remove_membership(m, c, s, null);
  if (r ->> 'removed')::boolean or r ->> 'reason' <> 'not_found' then raise exception 'repeat: %', r; end if;
  if not exists (select 1 from public.collection_memberships where id = m2) then raise exception 'other collection affected'; end if;
end $$ $b$);

select pg_temp.t('remove: a removed-and-re-added pair (new id) is untouched by a removal naming the old id', $b$ do $$
declare c uuid := 'c3b20000-0000-4000-8000-000000000014'; s uuid := pg_temp.one_show(); m uuid; m_new uuid; r jsonb;
begin
  perform pg_temp.as_anon();
  perform public.org_create_collection(c, 'ZZ Readd');
  m := (public.org_add_membership(c, s, null) -> 'membership' ->> 'id')::uuid;
  perform public.org_remove_membership(m, c, s, null);           -- another page removes it …
  m_new := (public.org_add_membership(c, s, null) -> 'membership' ->> 'id')::uuid; -- … and adds it again
  if m_new = m then raise exception 'same id'; end if;
  r := public.org_remove_membership(m, c, s, null);              -- the late original removal
  if (r ->> 'removed')::boolean or r ->> 'reason' <> 'not_found' then raise exception 'late removal: %', r; end if;
  if not exists (select 1 from public.collection_memberships where id = m_new and collection_id = c and show_id = s) then
    raise exception 'replacement membership was touched'; end if;
end $$ $b$);

select pg_temp.t('remove / add: an archived or missing collection is refused; a deleted target answers target_missing', $b$ do $$
declare c uuid := 'c3b20000-0000-4000-8000-000000000015'; f uuid; m uuid; r jsonb;
begin
  perform pg_temp.as_anon();
  perform public.org_create_collection(c, 'ZZ Gone');
  f := pg_temp.legacy_film('movies', 'ZZ Film B');
  m := (public.org_add_membership(c, null, f) -> 'membership' ->> 'id')::uuid;
  perform public.org_set_collection_archived(c, true);
  perform pg_temp.refusal(format('select public.org_remove_membership(%L, %L, null, %L)', m, c, f), 'org_archived:');
  perform public.org_set_collection_archived(c, false);
  perform pg_temp.refusal(format('select public.org_remove_membership(%L, %L, null, %L)', m, gen_random_uuid(), f), 'org_not_found:');
  delete from public.watchlist_items where id = f; -- the film is deleted: its memberships cascade away
  r := public.org_remove_membership(m, c, null, f);
  if (r ->> 'removed')::boolean or r ->> 'reason' <> 'target_missing' then raise exception 'target missing: %', r; end if;
  perform pg_temp.refusal(format('select public.org_add_membership(%L, null, %L)', c, f), 'org_target_missing:');
end $$ $b$);

select pg_temp.t('remove after Match turned the film into a TV season: removed:false (not_film); the show it became keeps the collection', $b$ do $$
declare c uuid := 'c3b20000-0000-4000-8000-000000000016'; f uuid; m uuid; r jsonb; v_show uuid;
begin
  perform pg_temp.as_anon();
  perform public.org_create_collection(c, 'ZZ Docs Fav');
  f := pg_temp.legacy_film('truecrime', 'ZZ Doc');
  m := (public.org_add_membership(c, null, f) -> 'membership' ->> 'id')::uuid;
  r := public.match_tv_row(f, '{"tmdb_id": 990011001, "network": "ZZ Net"}', pg_temp.match_patch('ZZ Doc', 990011001, 1), '{}');
  if (r ->> 'blocked')::boolean then raise exception 'match blocked: %', r; end if;
  v_show := (r ->> 'show_id')::uuid;
  r := public.org_remove_membership(m, c, null, f);
  if (r ->> 'removed')::boolean or r ->> 'reason' <> 'not_film' or (r ->> 'show_id')::uuid <> v_show then raise exception 'remove: %', r; end if;
  if not exists (select 1 from public.collection_memberships where collection_id = c and show_id = v_show) then raise exception 'show lost it'; end if;
  perform pg_temp.refusal(format('select public.org_add_membership(%L, null, %L)', c, f), 'org_not_film:');
end $$ $b$);

select pg_temp.t('a show membership covers seasons added later (no copy, nothing fetched)', $b$ do $$
declare c uuid := 'c3b20000-0000-4000-8000-000000000017'; r jsonb; v_show uuid; n0 int;
begin
  perform pg_temp.as_anon();
  perform public.org_create_collection(c, 'ZZ Later');
  r := public.add_tv_seasons('othertv', '{"title": "ZZ Grow", "show_key": "zz grow"}',
    '[{"item_key": "zz grow|season 1", "title": "ZZ Grow", "season": "Season 1", "theme": "ZZ Net", "display_date": "Jan 1, 2020", "date_sort": "2020-01-01"}]');
  v_show := (r ->> 'show_id')::uuid;
  perform public.org_add_membership(c, v_show, null);
  select count(*) into n0 from public.collection_memberships where collection_id = c;
  perform public.add_tv_seasons('othertv', '{"title": "ZZ Grow", "show_key": "zz grow"}',
    '[{"item_key": "zz grow|season 2", "title": "ZZ Grow", "season": "Season 2", "theme": "ZZ Net", "display_date": "Jan 1, 2021", "date_sort": "2021-01-01"}]');
  if (select count(*) from public.collection_memberships where collection_id = c) <> n0 then raise exception 'memberships changed'; end if;
  if (select count(*) from public.watchlist_items where show_id = v_show) <> 2 then raise exception 'seasons'; end if;
end $$ $b$);

-- ── Watch-with choices ──
select pg_temp.t('create choice: token ww:<id>, trimmed label, end of order; same-id repeat returns it unmodified; labels unique ignoring case', $b$ do $$
declare r jsonb; r2 jsonb; d jsonb; id1 uuid := 'e3b20000-0000-4000-8000-000000000001'; v_max int;
begin
  perform pg_temp.as_anon();
  select max(sort_order) into v_max from public.watch_with_choices;
  r := public.org_create_choice(id1, '  ZZ Grandma ');
  if r -> 'choice' ->> 'token' <> 'ww:' || id1 or r -> 'choice' ->> 'label' <> 'ZZ Grandma' or (r ->> 'existing')::boolean
     or (r -> 'choice' ->> 'sort_order')::int <> v_max + 1 then raise exception 'create: %', r; end if;
  r2 := public.org_create_choice(id1, 'ZZ Other');
  if not (r2 ->> 'existing')::boolean or r2 -> 'choice' ->> 'label' <> 'ZZ Grandma' then raise exception 'repeat: %', r2; end if;
  d := pg_temp.refusal($q$select public.org_create_choice('e3b20000-0000-4000-8000-000000000002', 'rina')$q$, 'org_label_taken:');
  if (d ->> 'archived')::boolean then raise exception 'detail: %', d; end if;
  perform public.org_set_choice_archived(id1, true);
  d := pg_temp.refusal($q$select public.org_create_choice('e3b20000-0000-4000-8000-000000000002', 'zz grandma')$q$, 'org_label_taken:');
  if not (d ->> 'archived')::boolean or (d ->> 'conflict_id')::uuid <> id1 then raise exception 'archived detail: %', d; end if;
  perform pg_temp.refusal($q$select public.org_create_choice('e3b20000-0000-4000-8000-000000000002', ' ')$q$, 'org_invalid_label:');
end $$ $b$);

select pg_temp.t('rename / archive choice: guarded like collections; the token never changes, rows are never rewritten', $b$ do $$
declare v_id uuid; v_tok text; v_rows text; d jsonb; r jsonb;
begin
  perform pg_temp.as_anon();
  select id, token into v_id, v_tok from public.watch_with_choices where token = 'Rina';
  select md5(string_agg(to_jsonb(w)::text, '|' order by id)) into v_rows from public.watchlist_items w;
  d := pg_temp.refusal(format('select public.org_rename_choice(%L, %L, %L)', v_id, 'Nope', 'X'), 'org_conflict:');
  if d -> 'current' ->> 'label' <> 'Rina' then raise exception 'detail %', d; end if;
  r := public.org_rename_choice(v_id, 'Rina', 'Rina M.');
  if r -> 'choice' ->> 'token' <> v_tok or r -> 'choice' ->> 'label' <> 'Rina M.' then raise exception 'rename %', r; end if;
  perform pg_temp.refusal(format('select public.org_rename_choice(%L, %L, %L)', v_id, 'Rina M.', 'suzanne'), 'org_label_taken:');
  perform public.org_set_choice_archived(v_id, true);
  perform pg_temp.refusal(format('select public.org_set_choice_archived(%L, true)', v_id), 'org_conflict:');
  perform public.org_set_choice_archived(v_id, false);
  perform pg_temp.refusal(format('select public.org_set_choice_archived(%L, false)', v_id), 'org_conflict:');
  if (select md5(string_agg(to_jsonb(w)::text, '|' order by id)) from public.watchlist_items w) <> v_rows then raise exception 'rows rewritten'; end if;
end $$ $b$);

-- ── Archived watch-with tokens (the exact rule) ──
select pg_temp.t('archived choice: an UPDATE newly adding it is refused (watch_with_archived, 23514); the row is unchanged', $b$ do $$
declare f uuid; v_id uuid; v_state text;
begin
  perform pg_temp.as_anon();
  f := pg_temp.legacy_film('movies', 'ZZ Film C');
  select id into v_id from public.watch_with_choices where token = 'Suzanne';
  perform public.org_set_choice_archived(v_id, true);   -- committed before the assignment begins (H13a, one session)
  select md5(to_jsonb(w)::text) into v_state from public.watchlist_items w where id = f;
  begin
    update public.watchlist_items set watch_with = array['Suzanne'] where id = f;
    raise exception 'accepted';
  exception when sqlstate '23514' then
    if sqlerrm not like 'watch_with_archived: "Suzanne" is archived; reload the page%' then raise exception 'message: %', sqlerrm; end if;
  end;
  if (select md5(to_jsonb(w)::text) from public.watchlist_items w where id = f) <> v_state then raise exception 'row changed'; end if;
end $$ $b$);

select pg_temp.t('archived choice: rows that already carry it keep it through unrelated edits and other tokens; removing it is allowed; re-adding is refused until unarchived', $b$ do $$
declare f uuid; v_id uuid;
begin
  perform pg_temp.as_anon();
  f := pg_temp.legacy_film('movies', 'ZZ Film D');
  update public.watchlist_items set watch_with = array['Rina'] where id = f;
  select id into v_id from public.watch_with_choices where token = 'Rina';
  perform public.org_set_choice_archived(v_id, true);
  update public.watchlist_items set watched = true where id = f;                         -- unrelated edit
  update public.watchlist_items set watch_with = array['Rina', 'Alone'] where id = f;    -- keeps Rina, adds an active choice
  if (select watch_with from public.watchlist_items where id = f) <> array['Rina', 'Alone'] then raise exception 'not kept'; end if;
  update public.watchlist_items set watch_with = array['Alone'] where id = f;            -- removal
  begin
    update public.watchlist_items set watch_with = array['Alone', 'Rina'] where id = f;  -- newly added again
    raise exception 'accepted';
  exception when sqlstate '23514' then if sqlerrm not like 'watch_with_archived:%' then raise exception '%', sqlerrm; end if; end;
  perform public.org_set_choice_archived(v_id, false);
  update public.watchlist_items set watch_with = array['Alone', 'Rina'] where id = f;    -- allowed once unarchived
end $$ $b$);

select pg_temp.t('archived choice: an INSERT carrying it is accepted (the restore exception); undefined tokens are still refused', $b$ do $$
declare v_id uuid;
begin
  perform pg_temp.as_anon();
  select id into v_id from public.watch_with_choices where token = 'Rina';
  perform public.org_set_choice_archived(v_id, true);
  insert into public.watchlist_items (collection, item_key, title, season, date_sort, watch_with)
  values ('movies', 'zz film e|film', 'ZZ Film E', 'Film', '2020-01-01', array['Rina']);
  begin
    insert into public.watchlist_items (collection, item_key, title, season, date_sort, watch_with)
    values ('movies', 'zz film f|film', 'ZZ Film F', 'Film', '2020-01-01', array['ZZ Nobody']);
    raise exception 'accepted';
  exception when sqlstate '23514' then if sqlerrm not like 'watch_with_invalid:%' then raise exception '%', sqlerrm; end if; end;
end $$ $b$);

select pg_temp.t('restore round trip with 3b-2 edits (archived choice in use, archived collection with members, renamed original, cross-storage member, ww: token) is exact, triggers on', $b$ do $$
declare b jsonb; v text; c uuid := 'c3b20000-0000-4000-8000-000000000020'; e uuid := 'e3b20000-0000-4000-8000-000000000020';
  f uuid; v_rina uuid;
begin
  perform pg_temp.as_anon();
  perform public.org_create_collection(c, 'ZZ Restore');
  perform public.org_add_membership(c, (select id from public.tv_shows where collection = 'othertv' order by id limit 1), null);
  f := pg_temp.legacy_film('movies', 'ZZ Film G');
  perform public.org_add_membership(c, null, f);
  perform public.org_set_collection_archived(c, true);
  perform public.org_rename_collection(pg_temp.coll('sheridan'), 'Sheridan', 'ZZ Sheridan Renamed');
  perform public.org_create_choice(e, 'ZZ Neighbour');
  update public.watchlist_items set watch_with = array['ww:' || e::text, 'Rina'] where id = f;
  select id into v_rina from public.watch_with_choices where token = 'Rina';
  perform public.org_set_choice_archived(v_rina, true);
  b := pg_temp.backup_v3();
  v := pg_temp.content();
  perform public.restore_backup(b, false);
  if pg_temp.content() <> v then raise exception 'restore not exact'; end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and tgname like 'org\_%') <> 5 then raise exception 'triggers'; end if;
end $$ $b$);

select pg_temp.t('3b-1 rules unchanged: a choice in use still can''t be deleted; a TV season still can''t be a film member', $b$ do $$
declare c uuid := pg_temp.coll('disney'); season uuid := pg_temp.season_of_any_show();
begin
  perform pg_temp.as_anon();
  update public.watchlist_items set watch_with = array['Alone'] where id = (select id from public.watchlist_items where is_film order by id limit 1);
  begin delete from public.watch_with_choices where token = 'Alone'; raise exception 'deleted';
  exception when sqlstate '23503' then null; end;
  begin insert into public.collection_memberships (collection_id, item_id) values (c, season); raise exception 'inserted';
  exception when sqlstate '23503' then null; end;
end $$ $b$);

select pg_temp.t('every organization edit leaves tracking content unchanged (a sequence of all eight write functions)', $b$ do $$
declare v_track text := pg_temp.tracking(); c uuid := 'c3b20000-0000-4000-8000-000000000030'; e uuid := 'e3b20000-0000-4000-8000-000000000030'; m uuid;
begin
  perform pg_temp.as_anon();
  perform public.org_create_collection(c, 'ZZ Seq');
  perform public.org_rename_collection(c, 'ZZ Seq', 'ZZ Seq 2');
  m := (public.org_add_membership(c, pg_temp.one_show(), null) -> 'membership' ->> 'id')::uuid;
  perform public.org_remove_membership(m, c, pg_temp.one_show(), null);
  perform public.org_set_collection_archived(c, true);
  perform public.org_set_collection_archived(c, false);
  perform public.org_create_choice(e, 'ZZ Seq');
  perform public.org_rename_choice(e, 'ZZ Seq', 'ZZ Seq 2');
  perform public.org_set_choice_archived(e, true);
  perform public.org_set_choice_archived(e, false);
  if pg_temp.tracking() <> v_track then raise exception 'tracking changed'; end if;
end $$ $b$);

select json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq)::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from _t;
