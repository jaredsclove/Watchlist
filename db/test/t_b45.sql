-- Checks for B4/B5 Batch A (prepend db/test/_prelude.sql). Run as postgres right after
-- db/b45_expand.sql on a replica. Every check works on synthetic ZZ records inside its
-- own rolled-back subtransaction and calls the database as anon, the way the app does.
-- Single-session checks: each shows one serial order (two sessions need real connections).

create or replace function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true);
$$;
-- An admin write (as postgres, with the library-write flag), then back to anon.
create or replace function pg_temp.admin(p_sql text) returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('watchlist.library_write', 'on', true);
  execute p_sql;
  perform set_config('watchlist.library_write', '', true);
  perform pg_temp.as_anon();
end $$;
-- Every column of every row of every table B45 can touch (owners included).
create or replace function pg_temp.content() returns text language sql as $$
  select concat_ws('/',
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.watchlist_items t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.tv_shows t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.collection_memberships t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.catalog_show_links t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.catalog_film_links t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.personal_collections t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.custom_collections t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.watch_with_choices t))
$$;
-- Every row except one (by id): the unrelated state a write must leave alone.
create or replace function pg_temp.content_except(p_id uuid) returns text language sql as $$
  select concat_ws('/',
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.watchlist_items t where t.id <> p_id),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.tv_shows t where t.id <> p_id),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.collection_memberships t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.catalog_show_links t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.catalog_film_links t))
$$;
-- The library-write flag lives for the rest of a transaction (each API request is one), so
-- a check that tests a guard after calling a library function switches it off first.
create or replace function pg_temp.flag_off() returns void language sql as $$
  select set_config('watchlist.library_write', '', true);
$$;
-- Deferred checks now, then deferred again (so later checks start like a fresh request).
create or replace function pg_temp.fk_now() returns void language plpgsql as $$
begin
  set constraints public.tv_shows_resume_start_fkey, public.tv_shows_resume_end_fkey immediate;
  set constraints public.tv_shows_resume_start_fkey, public.tv_shows_resume_end_fkey deferred;
end $$;
create or replace function pg_temp.refused(p_sql text, p_prefix text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like p_prefix || '%' then raise exception 'expected "%" but got: %', p_prefix, v_msg; end if;
    return;
  end;
  raise exception 'expected "%" but the call was accepted', p_prefix;
end $$;
-- A show by hand (no TMDB id) with seasons 1..n (dates 2020, 2021, …), all unwatched.
create or replace function pg_temp.show(p_title text, p_n int default 3) returns public.tv_shows language plpgsql as $$
declare v jsonb; s public.tv_shows;
begin
  v := public.library_create_show_b45(jsonb_build_object('title', p_title, 'show_key', lower(p_title), 'network', 'ZZ Net'),
    (select jsonb_agg(jsonb_build_object('item_key', lower(p_title) || '|season ' || i, 'title', p_title, 'season', 'Season ' || i,
       'theme', 'ZZ Net', 'display_date', 'ZZ', 'date_sort', (2019 + i) || '-01-01') order by i) from generate_series(1, p_n) i));
  select * into s from public.tv_shows where id = (v ->> 'show_id')::uuid;
  return s;
end $$;
create or replace function pg_temp.season(p_show uuid, p_n int) returns uuid language sql as $$
  select id from public.watchlist_items where show_id = p_show and season = 'Season ' || p_n
$$;
create or replace function pg_temp.reload(p uuid) returns public.tv_shows language sql as $$ select * from public.tv_shows where id = p $$;
create or replace function pg_temp.film(p_title text) returns public.watchlist_items language plpgsql as $$
declare v jsonb; w public.watchlist_items;
begin
  v := public.library_create_film_b45(jsonb_build_object('title', p_title, 'item_key', lower(p_title) || '|film', 'season', 'Film',
    'theme', 'Drama', 'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01', 'watched', false, 'status', 'confirmed'));
  select * into w from public.watchlist_items where id = (v ->> 'id')::uuid;
  return w;
end $$;
create or replace function pg_temp.frow(p uuid) returns public.watchlist_items language sql as $$ select * from public.watchlist_items where id = p $$;
create or replace function pg_temp.sstate(s public.tv_shows) returns jsonb language sql as $$ select private.b45_show_state(s) $$;
create or replace function pg_temp.fstate(w public.watchlist_items) returns jsonb language sql as $$ select private.b45_film_state(w) $$;
create or replace function pg_temp.season_patch(p_title text, p_tmdb int, p_num int) returns jsonb language sql as $$
  select jsonb_build_object('title', p_title, 'season', 'Season ' || p_num, 'item_key', lower(p_title) || '|season ' || p_num,
    'theme', 'ZZ Net', 'display_date', 'TBA', 'date_sort', '2099-01-01', 'media_type', 'tv', 'tmdb_id', p_tmdb, 'season_number', p_num)
$$;
create or replace function pg_temp.film_patch(p_title text, p_tmdb int) returns jsonb language sql as $$
  select jsonb_build_object('title', p_title, 'season', 'Film', 'item_key', lower(p_title) || '|film', 'theme', 'ZZ Co',
    'display_date', 'Jan 1, 2020', 'date_sort', '2020-01-01', 'media_type', 'movie', 'tmdb_id', p_tmdb, 'season_number', null)
$$;

-- ── W1: a show's state (O1 / O2 / O3) ──
select pg_temp.t('W1 O1: an explicit status choice sets the status and clears New, review and provenance; nothing else changes', $b$ do $$
declare s public.tv_shows; c text; v jsonb;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W1 A');
  perform pg_temp.admin(format('update public.tv_shows set catalog_new = true, status_review = true, legacy_status = %L, ended = true where id = %L', 'complete', s.id));
  s := pg_temp.reload(s.id); c := pg_temp.content_except(s.id);
  v := public.library_set_show_state_b45(s.id, pg_temp.sstate(s), '{"status": "watching"}');
  s := pg_temp.reload(s.id);
  if not (v ->> 'changed')::boolean or s.status <> 'watching' or s.catalog_new or s.status_review or s.legacy_status is not null or not s.ended or s.priority <> 'normal' then
    raise exception 'wrong: %', to_jsonb(s); end if;
  if pg_temp.content_except(s.id) <> c then raise exception 'unrelated state changed'; end if;
end $$ $b$);
select pg_temp.t('W1 O1 under review with the same status resolves the review (not a no-op); without review it is a no-op (nothing written)', $b$ do $$
declare s public.tv_shows; c text; v jsonb;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W1 B');
  perform pg_temp.admin(format('update public.tv_shows set status_review = true, legacy_status = %L, ended = true where id = %L', 'complete', s.id));
  s := pg_temp.reload(s.id);
  v := public.library_set_show_state_b45(s.id, pg_temp.sstate(s), '{"status": "confirmed"}');
  s := pg_temp.reload(s.id);
  if not (v ->> 'changed')::boolean or s.status_review or s.legacy_status is not null or not s.ended then raise exception 'review not resolved: %', to_jsonb(s); end if;
  c := pg_temp.content();
  v := public.library_set_show_state_b45(s.id, pg_temp.sstate(s), '{"status": "confirmed"}');
  if (v ->> 'changed')::boolean or pg_temp.content() <> c then raise exception 'a no-op wrote'; end if;
end $$ $b$);
select pg_temp.t('W1 O2: a priority change keeps review and New; clears provenance only when it is highpriority / maybe', $b$ do $$
declare s public.tv_shows; t public.tv_shows;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W1 C'); t := pg_temp.show('ZZ W1 D');
  perform pg_temp.admin(format('update public.tv_shows set priority = %L, legacy_status = %L where id = %L', 'high', 'highpriority', s.id));
  perform pg_temp.admin(format('update public.tv_shows set status_review = true, catalog_new = true, legacy_status = %L, ended = true where id = %L', 'complete', t.id));
  s := pg_temp.reload(s.id); t := pg_temp.reload(t.id);
  perform public.library_set_show_state_b45(s.id, pg_temp.sstate(s), '{"priority": "normal"}');
  perform public.library_set_show_state_b45(t.id, pg_temp.sstate(t), '{"priority": "low"}');
  s := pg_temp.reload(s.id); t := pg_temp.reload(t.id);
  if s.priority <> 'normal' or s.legacy_status is not null then raise exception 'hp provenance not cleared: %', to_jsonb(s); end if;
  if t.priority <> 'low' or not t.status_review or not t.catalog_new or t.legacy_status <> 'complete' then raise exception 'review/New/complete changed: %', to_jsonb(t); end if;
end $$ $b$);
select pg_temp.t('W1 O3: Ended changes clear complete provenance only; markers kept', $b$ do $$
declare s public.tv_shows;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W1 E');
  perform pg_temp.admin(format('update public.tv_shows set status_review = true, ended = true, legacy_status = %L where id = %L', 'complete', s.id));
  s := pg_temp.reload(s.id);
  perform public.library_set_show_state_b45(s.id, pg_temp.sstate(s), '{"ended": false}');
  s := pg_temp.reload(s.id);
  if s.ended or s.legacy_status is not null or not s.status_review then raise exception 'wrong: %', to_jsonb(s); end if;
end $$ $b$);
select pg_temp.t('W1 refusals: stale expected (target_changed), a removed status, a bad priority, an empty change; nothing written', $b$ do $$
declare s public.tv_shows; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W1 F'); c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_set_show_state_b45(%L, %L::jsonb, %L::jsonb)', s.id, pg_temp.sstate(s) || '{"priority": "high"}', '{"status": "watching"}'), 'target_changed');
  perform pg_temp.refused(format('select public.library_set_show_state_b45(%L, %L::jsonb, %L::jsonb)', s.id, pg_temp.sstate(s), '{"status": "pending"}'), 'invalid_input');
  perform pg_temp.refused(format('select public.library_set_show_state_b45(%L, %L::jsonb, %L::jsonb)', s.id, pg_temp.sstate(s), '{"status": "complete"}'), 'invalid_input');
  perform pg_temp.refused(format('select public.library_set_show_state_b45(%L, %L::jsonb, %L::jsonb)', s.id, pg_temp.sstate(s), '{"priority": "urgent"}'), 'invalid_input');
  perform pg_temp.refused(format('select public.library_set_show_state_b45(%L, %L::jsonb, %L::jsonb)', s.id, pg_temp.sstate(s), '{}'), 'invalid_input');
  perform pg_temp.refused(format('select public.library_set_show_state_b45(%L, %L::jsonb, %L::jsonb)', gen_random_uuid(), pg_temp.sstate(s), '{"status": "watching"}'), 'target_missing');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);
select pg_temp.t('W1 guards: a direct UPDATE of a show''s status, priority, Ended, markers, provenance, metadata or resume range as anon is refused (library_write_required)', $b$ do $$
declare s public.tv_shows; f text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W1 G');
  perform pg_temp.flag_off();
  foreach f in array array['status = ''watching''', 'priority = ''high''', 'ended = true', 'catalog_new = true', 'status_review = true',
    'legacy_status = ''maybe''', 'genres = ''{Drama}''', 'network = ''HBO''', 'metadata_owner_set = true'] loop
    perform pg_temp.refused(format('update public.tv_shows set %s where id = %L', f, s.id), 'library_write_required');
  end loop;
end $$ $b$);
select pg_temp.t('W1 the database refuses removed status values outright (CHECK), even with the flag', $b$ do $$
declare s public.tv_shows;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W1 H');
  perform pg_temp.refused(format('select pg_temp.admin(%L)', format('update public.tv_shows set status = %L where id = %L', 'pending', s.id)), 'new row for relation "tv_shows" violates check constraint');
end $$ $b$);

-- ── W2: the film contract ──
select pg_temp.t('W2 every selector transition gives the exact (status, watched); O1 clears New, review, provenance', $b$ do $$
declare w public.watchlist_items; st text; exp_status text; exp_watched boolean;
begin
  perform pg_temp.as_anon();
  w := pg_temp.film('ZZ W2 A');
  foreach st in array array['watched', 'to_watch', 'skipped', 'watched', 'skipped', 'to_watch'] loop
    perform pg_temp.admin(format('update public.watchlist_items set catalog_new = true, status_review = true, legacy_status = %L where id = %L', 'watching', w.id));
    w := pg_temp.frow(w.id);
    perform public.library_set_film_state_b45(w.id, pg_temp.fstate(w), jsonb_build_object('state', st));
    w := pg_temp.frow(w.id);
    exp_status := case st when 'skipped' then 'skipped' else 'confirmed' end; exp_watched := st = 'watched';
    if w.status <> exp_status or w.watched <> exp_watched or w.catalog_new or w.status_review or w.legacy_status is not null then
      raise exception 'after %: %', st, pg_temp.fstate(w); end if;
  end loop;
end $$ $b$);
select pg_temp.t('W2 the Watched button (O4) toggles watched only; it is refused on a skipped film; markers and provenance unchanged', $b$ do $$
declare w public.watchlist_items; c text;
begin
  perform pg_temp.as_anon();
  w := pg_temp.film('ZZ W2 B');
  perform pg_temp.admin(format('update public.watchlist_items set status_review = true, legacy_status = %L where id = %L', 'watching', w.id));
  w := pg_temp.frow(w.id);
  perform public.library_set_film_state_b45(w.id, pg_temp.fstate(w), '{"watched": true}');
  w := pg_temp.frow(w.id);
  if not w.watched or w.status <> 'confirmed' or not w.status_review or w.legacy_status <> 'watching' then raise exception 'wrong: %', pg_temp.fstate(w); end if;
  perform public.library_set_film_state_b45(w.id, pg_temp.fstate(w), '{"state": "skipped"}');
  w := pg_temp.frow(w.id); c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_set_film_state_b45(%L, %L::jsonb, %L::jsonb)', w.id, pg_temp.fstate(w), '{"watched": true}'), 'invalid_state');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);
select pg_temp.t('W2 an existing Skipped + Watched pair survives a priority-only change; a status change can''t create one', $b$ do $$
declare w public.watchlist_items;
begin
  perform pg_temp.as_anon();
  w := pg_temp.film('ZZ W2 C');
  perform pg_temp.admin(format('update public.watchlist_items set status = %L, watched = true where id = %L', 'skipped', w.id));
  w := pg_temp.frow(w.id);
  perform public.library_set_film_state_b45(w.id, pg_temp.fstate(w), '{"priority": "high"}');
  w := pg_temp.frow(w.id);
  if w.status <> 'skipped' or not w.watched or w.priority <> 'high' then raise exception 'pair lost: %', pg_temp.fstate(w); end if;
  perform public.library_set_film_state_b45(w.id, pg_temp.fstate(w), '{"state": "to_watch"}');
  w := pg_temp.frow(w.id);
  if w.status <> 'confirmed' or w.watched then raise exception 'pair → To Watch wrong: %', pg_temp.fstate(w); end if;
end $$ $b$);
select pg_temp.t('W2 guards: a film''s status or watched by direct PATCH as anon is refused; a season''s watched through set_season_watched still works', $b$ do $$
declare w public.watchlist_items; s public.tv_shows;
begin
  perform pg_temp.as_anon();
  w := pg_temp.film('ZZ W2 D'); s := pg_temp.show('ZZ W2 E', 1);
  perform pg_temp.flag_off();
  perform pg_temp.refused(format('update public.watchlist_items set status = %L where id = %L', 'skipped', w.id), 'library_write_required');
  perform pg_temp.refused(format('update public.watchlist_items set watched = true where id = %L', w.id), 'library_write_required');
  perform pg_temp.refused(format('update public.watchlist_items set priority = %L where id = %L', 'high', w.id), 'library_write_required');
  perform public.set_season_watched(pg_temp.season(s.id, 1), true);
  if not (select watched from public.watchlist_items where id = pg_temp.season(s.id, 1)) then raise exception 'season watched not set'; end if;
  perform pg_temp.refused(format('select pg_temp.admin(%L)', format('update public.watchlist_items set status = %L where id = %L', 'maybe', w.id)), 'new row for relation "watchlist_items" violates check constraint');
end $$ $b$);
select pg_temp.t('W2 O1 under review with the same state resolves the review; stale expected is refused', $b$ do $$
declare w public.watchlist_items; c text;
begin
  perform pg_temp.as_anon();
  w := pg_temp.film('ZZ W2 F');
  perform pg_temp.admin(format('update public.watchlist_items set status_review = true, legacy_status = %L where id = %L', 'complete', w.id));
  w := pg_temp.frow(w.id);
  perform public.library_set_film_state_b45(w.id, pg_temp.fstate(w), '{"state": "to_watch"}');
  w := pg_temp.frow(w.id);
  if w.status_review or w.legacy_status is not null then raise exception 'not resolved'; end if;
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_set_film_state_b45(%L, %L::jsonb, %L::jsonb)', w.id, pg_temp.fstate(w) || '{"watched": true}', '{"state": "skipped"}'), 'target_changed');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

-- ── W3: metadata (O7) ──
select pg_temp.t('W3 saving metadata sets the fields and metadata_owner_set (also when empty); theme and theme_kind untouched', $b$ do $$
declare s public.tv_shows; w public.watchlist_items; th text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W3 A'); w := pg_temp.film('ZZ W3 B');
  th := (select string_agg(theme, ',') from public.watchlist_items where show_id = s.id);
  perform public.library_set_metadata_b45('show', s.id, private.b45_show_metadata(s),
    '{"genres": ["Drama", "Crime"], "forms": ["Limited series"], "franchises": ["ZZ Universe"], "network": "HBO", "genre_candidates": []}');
  s := pg_temp.reload(s.id);
  if s.genres <> '{Drama,Crime}' or s.forms <> '{"Limited series"}' or s.network <> 'HBO' or not s.metadata_owner_set then raise exception 'show: %', to_jsonb(s); end if;
  if (select string_agg(theme, ',') from public.watchlist_items where show_id = s.id) <> th then raise exception 'theme changed'; end if;
  perform public.library_set_metadata_b45('film', w.id, private.b45_film_metadata(w), '{}');
  w := pg_temp.frow(w.id);
  if not w.metadata_owner_set or w.genres <> '{}' or w.theme <> 'Drama' or w.theme_kind <> 'genre' then raise exception 'film: %', to_jsonb(w); end if;
end $$ $b$);
select pg_temp.t('W3 refusals: 11 labels, an 81-character label, a repeat (case-insensitive), surrounding spaces, network on a film, stale; nothing written', $b$ do $$
declare s public.tv_shows; w public.watchlist_items; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W3 C'); w := pg_temp.film('ZZ W3 D'); c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_set_metadata_b45(%L, %L, %L::jsonb, %L::jsonb)', 'show', s.id, private.b45_show_metadata(s),
    jsonb_build_object('genres', (select jsonb_agg('G' || i) from generate_series(1, 11) i))), 'invalid_input');
  perform pg_temp.refused(format('select public.library_set_metadata_b45(%L, %L, %L::jsonb, %L::jsonb)', 'show', s.id, private.b45_show_metadata(s),
    jsonb_build_object('genres', jsonb_build_array(repeat('x', 81)))), 'invalid_input');
  perform pg_temp.refused(format('select public.library_set_metadata_b45(%L, %L, %L::jsonb, %L::jsonb)', 'show', s.id, private.b45_show_metadata(s),
    '{"genres": ["Drama", "drama"]}'), 'invalid_input');
  perform pg_temp.refused(format('select public.library_set_metadata_b45(%L, %L, %L::jsonb, %L::jsonb)', 'show', s.id, private.b45_show_metadata(s),
    '{"genres": [" Drama"]}'), 'invalid_input');
  perform pg_temp.refused(format('select public.library_set_metadata_b45(%L, %L, %L::jsonb, %L::jsonb)', 'film', w.id, private.b45_film_metadata(w),
    '{"network": "HBO"}'), 'invalid_input');
  perform pg_temp.refused(format('select public.library_set_metadata_b45(%L, %L, %L::jsonb, %L::jsonb)', 'show', s.id, private.b45_show_metadata(s) || '{"network": "X"}',
    '{"genres": []}'), 'target_changed');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);

-- ── W4 / W5: dismiss New from catalog ──
select pg_temp.t('W4/W5 dismissing New (one and several): only catalog_new (and pending provenance) clears; review untouched; a set that differs refuses the whole call', $b$ do $$
declare a public.tv_shows; b public.tv_shows; f public.watchlist_items; c text; v jsonb;
begin
  perform pg_temp.as_anon();
  a := pg_temp.show('ZZ W4 A'); b := pg_temp.show('ZZ W4 B'); f := pg_temp.film('ZZ W4 C');
  perform pg_temp.admin(format('update public.tv_shows set catalog_new = true, legacy_status = %L where id = %L', 'pending', a.id));
  perform pg_temp.admin(format('update public.tv_shows set catalog_new = true, status_review = true where id = %L', b.id));
  perform pg_temp.admin(format('update public.watchlist_items set catalog_new = true, legacy_status = %L where id = %L', 'pending', f.id));
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_dismiss_catalog_new_b45(%L::jsonb)', jsonb_build_array(jsonb_build_object('kind', 'show', 'id', a.id),
    jsonb_build_object('kind', 'show', 'id', gen_random_uuid()))), 'target_changed');
  if pg_temp.content() <> c then raise exception 'partial dismissal'; end if;
  v := public.library_dismiss_catalog_new_b45(jsonb_build_array(jsonb_build_object('kind', 'show', 'id', a.id), jsonb_build_object('kind', 'show', 'id', b.id),
    jsonb_build_object('kind', 'film', 'id', f.id)));
  a := pg_temp.reload(a.id); b := pg_temp.reload(b.id); f := pg_temp.frow(f.id);
  if (v ->> 'dismissed')::int <> 3 or a.catalog_new or a.legacy_status is not null or b.catalog_new or not b.status_review or f.catalog_new or f.legacy_status is not null then
    raise exception 'wrong: % % %', to_jsonb(a), to_jsonb(b), to_jsonb(f); end if;
  perform pg_temp.refused(format('select public.library_dismiss_catalog_new_b45(%L::jsonb)', jsonb_build_array(jsonb_build_object('kind', 'show', 'id', a.id))), 'target_changed');
end $$ $b$);

-- ── W6: dismiss review ──
select pg_temp.t('W6 keeping the current status clears review and provenance; refused when there is no review', $b$ do $$
declare s public.tv_shows;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W6 A');
  perform pg_temp.admin(format('update public.tv_shows set status_review = true, ended = true, legacy_status = %L where id = %L', 'complete', s.id));
  s := pg_temp.reload(s.id);
  perform public.library_dismiss_review_b45('show', s.id, pg_temp.sstate(s));
  s := pg_temp.reload(s.id);
  if s.status_review or s.legacy_status is not null or not s.ended or s.status <> 'confirmed' then raise exception 'wrong: %', to_jsonb(s); end if;
  perform pg_temp.refused(format('select public.library_dismiss_review_b45(%L, %L, %L::jsonb)', 'show', s.id, pg_temp.sstate(s)), 'target_changed');
end $$ $b$);

-- ── W9: additions never change an existing show's state ──
select pg_temp.t('W9 seasons added to an Ended show: status, priority, Ended and markers unchanged; ended_kept reported', $b$ do $$
declare s public.tv_shows; v jsonb;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W9 A', 1);
  perform pg_temp.admin(format('update public.tv_shows set status = %L, ended = true, priority = %L, legacy_status = %L where id = %L', 'watching', 'high', 'complete', s.id));
  s := pg_temp.reload(s.id);
  v := public.library_add_seasons_b45(s.id, jsonb_build_object('tmdb_id', null, 'show_key', s.show_key, 'catalog', null, 'network', 'ZZ Net'),
    jsonb_build_array(jsonb_build_object('item_key', s.show_key || '|season 2', 'title', s.title, 'season', 'Season 2', 'theme', 'ZZ Net', 'display_date', 'TBA', 'date_sort', '2099-01-01')));
  if not (v ->> 'ended_kept')::boolean or v ? 'reopened' then raise exception 'answer: %', v; end if;
  if pg_temp.sstate(pg_temp.reload(s.id)) <> pg_temp.sstate(s) or (pg_temp.reload(s.id)).legacy_status <> 'complete' then raise exception 'state changed'; end if;
end $$ $b$);
select pg_temp.t('W9 new records start To Watch / Normal; create refuses a non-To-Watch initial status and an owner network; film metadata validated', $b$ do $$
declare s public.tv_shows; w public.watchlist_items; v jsonb;
begin
  perform pg_temp.as_anon();
  v := public.library_create_show_b45('{"tmdb_id": 993001, "title": "ZZ W9 New", "show_key": "zz w9 new", "network": "ZZ Net", "genres": ["Drama"], "genre_candidates": ["Sci-Fi & Fantasy"], "network_candidates": ["HBO", "Max"]}',
    '[{"item_key": "zz w9 new|season 1", "title": "ZZ W9 New", "season": "Season 1", "theme": "ZZ Net", "display_date": "TBA", "date_sort": "2099-01-01", "season_number": 1}]');
  s := pg_temp.reload((v ->> 'show_id')::uuid);
  if s.status <> 'confirmed' or s.priority <> 'normal' or s.catalog_new or s.network is not null or s.network_candidates <> '{HBO,Max}'
     or s.genre_candidates <> '{"Sci-Fi & Fantasy"}' or s.genres <> '{Drama}' or s.metadata_owner_set then raise exception 'show: %', to_jsonb(s); end if;
  perform pg_temp.refused($q$select public.library_create_show_b45('{"title": "ZZ W9 P", "show_key": "zz w9 p", "initial_status": "watching"}', '[{"item_key": "zz w9 p|season 1", "title": "ZZ W9 P", "season": "Season 1", "date_sort": "2020-01-01"}]')$q$, 'invalid_input');
  perform pg_temp.refused($q$select public.library_create_show_b45('{"title": "ZZ W9 Q", "show_key": "zz w9 q", "original_network": "HBO"}', '[{"item_key": "zz w9 q|season 1", "title": "ZZ W9 Q", "season": "Season 1", "date_sort": "2020-01-01"}]')$q$, 'invalid_input');
  v := public.library_add_films_b45('[{"tmdb_id": 993002, "title": "ZZ W9 Film", "item_key": "zz w9 film|film", "date_sort": "2020-01-01", "theme": "Action", "genres": ["Action", "Adventure"], "forms": ["Animation"]}]');
  w := pg_temp.frow((v -> 'results' -> 0 ->> 'id')::uuid);
  if w.status <> 'confirmed' or w.priority <> 'normal' or w.catalog_new or w.genres <> '{Action,Adventure}' or w.forms <> '{Animation}' or w.theme_kind <> 'genre' then raise exception 'film: %', to_jsonb(w); end if;
  perform pg_temp.refused($q$select public.library_add_films_b45('[{"tmdb_id": 993003, "title": "ZZ W9 Bad", "item_key": "zz w9 bad|film", "date_sort": "2020-01-01", "genres": "Drama"}]')$q$, 'invalid_input');
end $$ $b$);

-- ── W8: catalog applications ──
select pg_temp.t('W8 preview writes nothing; apply creates To Watch / Normal / New (whatever p says); an Ended show receiving seasons keeps Ended (ended_kept); replay is stale; the old name refuses', $b$ do $$
declare c text; p jsonb; a jsonb; d jsonb; s public.tv_shows; e public.tv_shows;
begin
  perform pg_temp.as_anon();
  d := '[{"k": "zz w8 show|season 1", "t": "ZZ W8 Show", "s": "Season 1", "d": "Jan 1, 2020", "ds": "2020-01-01", "p": true},
         {"k": "zz w8 film|film", "t": "ZZ W8 Film", "s": "Film", "d": "Jan 1, 2021", "ds": "2021-01-01"}]';
  c := pg_temp.content();
  p := public.library_catalog_apply_b45('sheridan', d);
  if pg_temp.content() <> c or p -> 'document' ->> 'version' <> 'b45.1' then raise exception 'preview wrote or wrong version: %', p -> 'document' ->> 'version'; end if;
  a := public.library_catalog_apply_b45('sheridan', d, p ->> 'hash');
  s := (select x from public.tv_shows x where show_key = 'zz w8 show');
  if s.status <> 'confirmed' or s.priority <> 'normal' or not s.catalog_new or s.legacy_status is not null then raise exception 'show: %', to_jsonb(s); end if;
  if not exists (select 1 from public.watchlist_items w where item_key = 'zz w8 film|film' and status = 'confirmed' and priority = 'normal' and catalog_new and theme_kind = 'other') then
    raise exception 'film not To Watch / Normal / New'; end if;
  perform pg_temp.refused(format('select public.library_catalog_apply_b45(%L, %L::jsonb, %L)', 'sheridan', d, p ->> 'hash'), 'catalog_stale');
  perform pg_temp.admin(format('update public.tv_shows set ended = true, status = %L where id = %L', 'watching', s.id));
  d := d || '[{"k": "zz w8 show|season 2", "t": "ZZ W8 Show", "s": "Season 2", "d": "TBA", "ds": "2099-01-01"}]';
  p := public.library_catalog_apply_b45('sheridan', d);
  if not exists (select 1 from jsonb_array_elements(p -> 'document' -> 'entries') x where x ->> 'kind' = 'ended_kept' and (x ->> 'show_id')::uuid = s.id)
     or exists (select 1 from jsonb_array_elements(p -> 'document' -> 'entries') x where x ->> 'kind' = 'reopen') then raise exception 'entries: %', p -> 'document' -> 'entries'; end if;
  a := public.library_catalog_apply_b45('sheridan', d, p ->> 'hash');
  e := pg_temp.reload(s.id);
  if not e.ended or e.status <> 'watching' then raise exception 'ended show changed: %', to_jsonb(e); end if;
  perform pg_temp.refused(format('select public.library_catalog_apply(%L, %L::jsonb)', 'sheridan', d), 'client_outdated');
end $$ $b$);

-- ── W10: the resume range (O9; O1 + O9) ──
select pg_temp.t('W10 set and stop: the pair is stored or cleared; status, watched, Ended and markers unchanged', $b$ do $$
declare s public.tv_shows; v jsonb;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W10 A', 3);
  perform public.set_season_watched(pg_temp.season(s.id, 3), true);
  perform pg_temp.admin(format('update public.tv_shows set status = %L, ended = true, status_review = true where id = %L', 'watching', s.id));
  s := pg_temp.reload(s.id);
  v := public.library_set_resume_b45(s.id, jsonb_build_object('status', s.status, 'resume_start_season_id', null, 'resume_end_season_id', null),
    pg_temp.season(s.id, 1), pg_temp.season(s.id, 3));
  s := pg_temp.reload(s.id);
  if s.resume_start_season_id <> pg_temp.season(s.id, 1) or s.resume_end_season_id <> pg_temp.season(s.id, 3) or v ->> 'resume_state' <> 'active'
     or not s.ended or not s.status_review or s.status <> 'watching' then raise exception 'set: % %', to_jsonb(s), v; end if;
  v := public.library_set_resume_b45(s.id, jsonb_build_object('status', s.status, 'resume_start_season_id', s.resume_start_season_id,
    'resume_end_season_id', s.resume_end_season_id), null, null);
  s := pg_temp.reload(s.id);
  if s.resume_start_season_id is not null or s.resume_end_season_id is not null or not s.status_review then raise exception 'stop: %', to_jsonb(s); end if;
end $$ $b$);
select pg_temp.t('W10 Start watching earlier seasons on a To Watch show applies O1 (status Watching; New, review, provenance cleared) with the range', $b$ do $$
declare s public.tv_shows;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W10 B', 3);
  perform public.set_season_watched(pg_temp.season(s.id, 2), true);
  perform pg_temp.admin(format('update public.tv_shows set catalog_new = true, legacy_status = %L where id = %L', 'pending', s.id));
  s := pg_temp.reload(s.id);
  perform public.library_set_resume_b45(s.id, jsonb_build_object('status', s.status, 'resume_start_season_id', null, 'resume_end_season_id', null),
    pg_temp.season(s.id, 1), pg_temp.season(s.id, 2), true);
  s := pg_temp.reload(s.id);
  if s.status <> 'watching' or s.catalog_new or s.legacy_status is not null or s.resume_start_season_id is null then raise exception 'wrong: %', to_jsonb(s); end if;
end $$ $b$);
select pg_temp.t('W10 refusals: start watched, start skipped, boundary unwatched, start = boundary, one side only, seasons of another show, stale; nothing written', $b$ do $$
declare s public.tv_shows; o public.tv_shows; e jsonb; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W10 C', 3); o := pg_temp.show('ZZ W10 D', 2);
  perform public.set_season_watched(pg_temp.season(s.id, 3), true);
  perform public.set_season_watched(pg_temp.season(s.id, 2), true);
  perform public.set_season_watched(pg_temp.season(o.id, 2), true);
  e := jsonb_build_object('status', 'confirmed', 'resume_start_season_id', null, 'resume_end_season_id', null);
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_set_resume_b45(%L, %L::jsonb, %L, %L)', s.id, e, pg_temp.season(s.id, 2), pg_temp.season(s.id, 3)), 'invalid_range');
  perform pg_temp.refused(format('select public.library_set_resume_b45(%L, %L::jsonb, %L, %L)', s.id, e, pg_temp.season(s.id, 1), pg_temp.season(s.id, 1)), 'invalid_input');
  perform pg_temp.refused(format('select public.library_set_resume_b45(%L, %L::jsonb, %L, null)', s.id, e, pg_temp.season(s.id, 1)), 'invalid_input');
  perform pg_temp.refused(format('select public.library_set_resume_b45(%L, %L::jsonb, %L, %L)', s.id, e, pg_temp.season(s.id, 1), pg_temp.season(o.id, 2)), 'invalid_range');
  perform pg_temp.refused(format('select public.library_set_resume_b45(%L, %L::jsonb, %L, %L)', s.id, e || '{"status": "watching"}', pg_temp.season(s.id, 1), pg_temp.season(s.id, 3)), 'target_changed');
  perform public.set_season_skipped(pg_temp.season(s.id, 1), true);
  c := pg_temp.content();
  perform pg_temp.refused(format('select public.library_set_resume_b45(%L, %L::jsonb, %L, %L)', s.id, e, pg_temp.season(s.id, 1), pg_temp.season(s.id, 3)), 'invalid_range');
  if pg_temp.content() <> c then raise exception 'changed'; end if;
end $$ $b$);
select pg_temp.t('W10 resume state follows the fixed range: unwatching the boundary keeps it active; watching the range completes it; unwatching inside re-activates', $b$ do $$
declare s public.tv_shows;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ W10 E', 3);
  perform public.set_season_watched(pg_temp.season(s.id, 3), true);
  perform public.library_set_resume_b45(s.id, jsonb_build_object('status', s.status, 'resume_start_season_id', null, 'resume_end_season_id', null),
    pg_temp.season(s.id, 1), pg_temp.season(s.id, 3));
  perform public.set_season_watched(pg_temp.season(s.id, 3), false);
  if private.b45_resume_state(s.id) <> 'active' then raise exception 'boundary unwatched → %', private.b45_resume_state(s.id); end if;
  perform public.set_season_watched(pg_temp.season(s.id, 1), true);
  perform public.set_season_watched(pg_temp.season(s.id, 2), true);
  if private.b45_resume_state(s.id) <> 'complete' then raise exception 'not complete'; end if;
  perform public.set_season_watched(pg_temp.season(s.id, 2), false);
  if private.b45_resume_state(s.id) <> 'active' then raise exception 'not re-activated'; end if;
end $$ $b$);

-- ── RL: the resume range's lifecycle ──
select pg_temp.t('RL1/RL2 deleting the start through delete_tv_season (the call an old page makes too, without the library-write flag) clears the pair; nothing else changes', $b$ do $$
declare s public.tv_shows; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ RL1', 3);
  perform public.set_season_watched(pg_temp.season(s.id, 3), true);
  perform public.library_set_resume_b45(s.id, jsonb_build_object('status', s.status, 'resume_start_season_id', null, 'resume_end_season_id', null),
    pg_temp.season(s.id, 1), pg_temp.season(s.id, 3));
  c := pg_temp.content_except(pg_temp.season(s.id, 1));
  perform pg_temp.flag_off();
  if coalesce(current_setting('watchlist.library_write', true), '') = 'on' then raise exception 'flag still on'; end if;
  perform public.delete_tv_season(pg_temp.season(s.id, 1));
  s := pg_temp.reload(s.id);
  if s.resume_start_season_id is not null or s.resume_end_season_id is not null then raise exception 'pair kept'; end if;
  perform pg_temp.fk_now();
  if coalesce(current_setting('watchlist.resume_cleanup', true), '') = 'on' then raise exception 'cleanup setting left on'; end if;
end $$ $b$);
select pg_temp.t('RL1 deleting the boundary clears the pair too', $b$ do $$
declare s public.tv_shows;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ RL1B', 3);
  perform public.set_season_watched(pg_temp.season(s.id, 3), true);
  perform public.library_set_resume_b45(s.id, jsonb_build_object('status', s.status, 'resume_start_season_id', null, 'resume_end_season_id', null),
    pg_temp.season(s.id, 1), pg_temp.season(s.id, 3));
  perform public.delete_tv_season(pg_temp.season(s.id, 3));
  if (pg_temp.reload(s.id)).resume_start_season_id is not null then raise exception 'pair kept'; end if;
  perform pg_temp.fk_now();
end $$ $b$);
select pg_temp.t('RL3 sequential deletion through the final season: the range clears at the first endpoint deleted, never remains on a one-season show, and the show goes with its last season', $b$ do $$
declare s public.tv_shows; a uuid; b uuid; c uuid;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ RL3', 3);
  a := pg_temp.season(s.id, 1); b := pg_temp.season(s.id, 2); c := pg_temp.season(s.id, 3);
  perform public.set_season_watched(c, true);
  perform public.library_set_resume_b45(s.id, jsonb_build_object('status', s.status, 'resume_start_season_id', null, 'resume_end_season_id', null), a, c);
  perform public.delete_tv_season(b);
  if (pg_temp.reload(s.id)).resume_start_season_id is distinct from a then raise exception 'a middle deletion changed the range'; end if;
  perform public.delete_tv_season(a);
  if (pg_temp.reload(s.id)).resume_start_season_id is not null or (pg_temp.reload(s.id)).resume_end_season_id is not null then raise exception 'not cleared at the start'; end if;
  perform public.delete_tv_season(c);
  if exists (select 1 from public.tv_shows where id = s.id) then raise exception 'the emptied show remains'; end if;
  perform pg_temp.fk_now();
end $$ $b$);
select pg_temp.t('RL4 the guard: the resume columns can''t be written directly; under the cleanup setting only both-to-NULL with nothing else changed passes', $b$ do $$
declare s public.tv_shows;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ RL4', 3);
  perform public.set_season_watched(pg_temp.season(s.id, 3), true);
  perform pg_temp.flag_off();
  perform pg_temp.refused(format('update public.tv_shows set resume_start_season_id = %L, resume_end_season_id = %L where id = %L', pg_temp.season(s.id, 1), pg_temp.season(s.id, 3), s.id), 'library_write_required');
  perform public.library_set_resume_b45(s.id, jsonb_build_object('status', s.status, 'resume_start_season_id', null, 'resume_end_season_id', null),
    pg_temp.season(s.id, 1), pg_temp.season(s.id, 3));
  perform pg_temp.flag_off();
  perform pg_temp.refused(format('update public.tv_shows set resume_start_season_id = null, resume_end_season_id = null where id = %L', s.id), 'library_write_required');
  perform set_config('watchlist.resume_cleanup', 'on', true);
  perform pg_temp.refused(format('update public.tv_shows set resume_start_season_id = null where id = %L', s.id), 'library_write_required');
  perform pg_temp.refused(format('update public.tv_shows set resume_start_season_id = null, resume_end_season_id = null, priority = %L where id = %L', 'high', s.id), 'library_write_required');
  perform pg_temp.refused(format('update public.tv_shows set resume_start_season_id = %L, resume_end_season_id = %L where id = %L', pg_temp.season(s.id, 2), pg_temp.season(s.id, 3), s.id), 'library_write_required');
  update public.tv_shows set resume_start_season_id = null, resume_end_season_id = null where id = s.id;
  perform set_config('watchlist.resume_cleanup', '', true);
  if (pg_temp.reload(s.id)).resume_start_season_id is not null then raise exception 'not cleared'; end if;
end $$ $b$);
select pg_temp.t('RL5 same-show and same-owner: a reference to another show''s season, a film or another owner''s season is refused at commit (FK); a reversed range is accepted but inert', $b$ do $$
declare s public.tv_shows; o public.tv_shows; w public.watchlist_items; other uuid := 'aaaaaaaa-0000-4000-8000-000000000b45'; os uuid; oi uuid;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ RL5 A', 3); o := pg_temp.show('ZZ RL5 B', 2); w := pg_temp.film('ZZ RL5 F');
  perform pg_temp.refused(format('select pg_temp.admin(%L)', format('update public.tv_shows set resume_start_season_id = %L, resume_end_season_id = %L where id = %L; select pg_temp.fk_now()',
    pg_temp.season(o.id, 1), pg_temp.season(s.id, 3), s.id)), 'insert or update on table "tv_shows" violates foreign key constraint');
  perform pg_temp.refused(format('select pg_temp.admin(%L)', format('update public.tv_shows set resume_start_season_id = %L, resume_end_season_id = %L where id = %L; select pg_temp.fk_now()',
    w.id, pg_temp.season(s.id, 3), s.id)), 'insert or update on table "tv_shows" violates foreign key constraint');
  perform set_config('role', 'postgres', true);
  perform set_config('watchlist.library_write', 'on', true);
  insert into public.tv_shows (id, user_id, title, show_key, status) values (gen_random_uuid(), other, 'ZZ RL5 Other', 'zz rl5 other', 'confirmed') returning id into os;
  insert into public.watchlist_items (user_id, item_key, title, season, theme, display_date, date_sort, show_id) values (other, 'zz rl5 other|season 1', 'ZZ RL5 Other', 'Season 1', '', '', '2020-01-01', os) returning id into oi;
  perform pg_temp.refused(format('update public.tv_shows set resume_start_season_id = %L, resume_end_season_id = %L where id = %L; select pg_temp.fk_now()',
    oi, pg_temp.season(s.id, 3), s.id), 'insert or update on table "tv_shows" violates foreign key constraint');
  perform set_config('watchlist.library_write', '', true);
  perform pg_temp.as_anon();
  perform public.set_season_watched(pg_temp.season(s.id, 1), true);
  perform public.library_set_resume_b45(s.id, jsonb_build_object('status', s.status, 'resume_start_season_id', null, 'resume_end_season_id', null),
    pg_temp.season(s.id, 3), pg_temp.season(s.id, 1));
  if private.b45_resume_state(s.id) <> 'invalid' then raise exception 'reversed range not inert: %', private.b45_resume_state(s.id); end if;
end $$ $b$);
select pg_temp.t('RL7 server enforcement: moving a referenced season out of its show without clearing the range fails at commit (FK)', $b$ do $$
declare s public.tv_shows; o public.tv_shows;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ RL7 A', 3); o := pg_temp.show('ZZ RL7 B', 1);
  perform public.set_season_watched(pg_temp.season(s.id, 3), true);
  perform public.library_set_resume_b45(s.id, jsonb_build_object('status', s.status, 'resume_start_season_id', null, 'resume_end_season_id', null),
    pg_temp.season(s.id, 1), pg_temp.season(s.id, 3));
  perform pg_temp.refused(format('select pg_temp.admin(%L)', format('update public.watchlist_items set show_id = %L where id = %L; select pg_temp.fk_now()',
    o.id, pg_temp.season(s.id, 1))), '%violates foreign key constraint "tv_shows_resume_');
end $$ $b$);

-- ── W7: Match (§8.2) ──
select pg_temp.t('W7 M1 promote in place: the show keeps every value and its range', $b$ do $$
declare s public.tv_shows; r uuid; v jsonb;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ M1', 1); r := pg_temp.season(s.id, 1);
  perform pg_temp.admin(format('update public.tv_shows set priority = %L, ended = true, genres = %L, network = %L, metadata_owner_set = true where id = %L', 'high', '{Drama}', 'HBO', s.id));
  s := pg_temp.reload(s.id);
  v := public.library_match_season_b45(r, '{"tmdb_id": 994001}', pg_temp.season_patch('ZZ M1 Tmdb', 994001, 1));
  if (v ->> 'show_id')::uuid <> s.id or private.b45_show_carry(pg_temp.reload(s.id)) <> private.b45_show_carry(s) then raise exception 'wrong: %', v; end if;
end $$ $b$);
select pg_temp.t('W7 M2 new show from a legacy show that keeps other seasons: state carried; the source''s range naming the row is cleared only after the acknowledgment; the new show has none', $b$ do $$
declare s public.tv_shows; n public.tv_shows; r uuid; v jsonb; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ M2', 3); r := pg_temp.season(s.id, 1);
  perform public.set_season_watched(pg_temp.season(s.id, 3), true);
  perform public.library_set_resume_b45(s.id, jsonb_build_object('status', s.status, 'resume_start_season_id', null, 'resume_end_season_id', null), r, pg_temp.season(s.id, 3));
  perform pg_temp.admin(format('update public.tv_shows set priority = %L, catalog_new = true, legacy_status = %L, genres = %L, metadata_owner_set = true where id = %L', 'low', 'pending', '{Comedy}', s.id));
  s := pg_temp.reload(s.id); c := pg_temp.content();
  v := public.library_match_season_b45(r, '{"tmdb_id": 994002}', pg_temp.season_patch('ZZ M2 Tmdb', 994002, 1));
  if not (v ->> 'blocked')::boolean or v ->> 'reason' <> 'state_acknowledgment' or pg_temp.content() <> c then raise exception 'not blocked: %', v; end if;
  v := public.library_match_season_b45(r, '{"tmdb_id": 994002}', pg_temp.season_patch('ZZ M2 Tmdb', 994002, 1), '{}', v ->> 'confirmation');
  n := pg_temp.reload((v ->> 'show_id')::uuid);
  if n.id = s.id or n.priority <> 'low' or not n.catalog_new or n.legacy_status <> 'pending' or n.genres <> '{Comedy}' or not n.metadata_owner_set
     or n.resume_start_season_id is not null then raise exception 'new show: %', to_jsonb(n); end if;
  if (pg_temp.reload(s.id)).resume_start_season_id is not null then raise exception 'source range kept'; end if;
  perform pg_temp.fk_now();
end $$ $b$);
select pg_temp.t('W7 M3 join: the existing status block refuses differing statuses; with equal statuses the destination keeps its values after the acknowledgment; an emptied source is removed', $b$ do $$
declare d public.tv_shows; s public.tv_shows; r uuid; v jsonb; c text;
begin
  perform pg_temp.as_anon();
  v := public.library_create_show_b45('{"tmdb_id": 994003, "title": "ZZ M3 Dest", "show_key": "zz m3 dest", "network": "ZZ"}',
    '[{"item_key": "zz m3 dest|season 2", "title": "ZZ M3 Dest", "season": "Season 2", "theme": "ZZ", "display_date": "TBA", "date_sort": "2099-01-01", "season_number": 2}]');
  d := pg_temp.reload((v ->> 'show_id')::uuid);
  s := pg_temp.show('ZZ M3 Src', 1); r := pg_temp.season(s.id, 1);
  perform pg_temp.admin(format('update public.tv_shows set status = %L where id = %L', 'watching', s.id));
  v := public.library_match_season_b45(r, '{"tmdb_id": 994003}', pg_temp.season_patch('ZZ M3 Dest', 994003, 1));
  if not (v ->> 'blocked')::boolean or v ->> 'target_status' <> 'confirmed' then raise exception 'no status block: %', v; end if;
  perform pg_temp.admin(format('update public.tv_shows set status = %L, priority = %L, genres = %L where id = %L', 'confirmed', 'high', '{Drama}', s.id));
  c := pg_temp.content();
  v := public.library_match_season_b45(r, '{"tmdb_id": 994003}', pg_temp.season_patch('ZZ M3 Dest', 994003, 1));
  if v ->> 'reason' <> 'state_acknowledgment' or pg_temp.content() <> c
     or not exists (select 1 from jsonb_array_elements(v -> 'items') x where x ->> 'field' = 'priority')
     or not exists (select 1 from jsonb_array_elements(v -> 'items') x where x ->> 'field' = 'source_show' and x ->> 'effect' = 'deleted') then raise exception 'ack: %', v; end if;
  -- (a wrong token is answered as blocked again, nothing written)
  v := public.library_match_season_b45(r, '{"tmdb_id": 994003}', pg_temp.season_patch('ZZ M3 Dest', 994003, 1), '{}', 'stale-token');
  if not (v ->> 'blocked')::boolean or not (v ->> 'changed')::boolean or pg_temp.content() <> c then raise exception 'stale token accepted: %', v; end if;
  v := public.library_match_season_b45(r, '{"tmdb_id": 994003}', pg_temp.season_patch('ZZ M3 Dest', 994003, 1), '{}', v ->> 'confirmation');
  if (v ->> 'show_id')::uuid <> d.id or (pg_temp.reload(d.id)).priority <> 'normal' or (pg_temp.reload(d.id)).genres <> '{}'
     or exists (select 1 from public.tv_shows where id = s.id) then raise exception 'join: %', v; end if;
end $$ $b$);
select pg_temp.t('W7 M4 film → new show: the film''s state goes to the show (Skipped → skipped; priority, New, review, metadata); the row''s film-only values become NULL', $b$ do $$
declare w public.watchlist_items; n public.tv_shows; v jsonb;
begin
  perform pg_temp.as_anon();
  perform pg_temp.admin($q$insert into public.watchlist_items (item_key, title, season, theme, theme_kind, display_date, date_sort, status, watched,
    priority, catalog_new, status_review, legacy_status, genres, forms, franchises, companies, genre_candidates, metadata_owner_set)
    values ('zz m4 doc|film', 'ZZ M4 Doc', 'Film', 'ZZ Co', 'other', 'Jan 1, 2020', '2020-01-01', 'skipped', false,
    'high', false, false, 'highpriority', '{Crime}', '{Documentary}', '{}', '{ZZ Co}', '{}', true)$q$);
  w := (select x from public.watchlist_items x where item_key = 'zz m4 doc|film');
  v := public.library_match_season_b45(w.id, '{"tmdb_id": 994004}', pg_temp.season_patch('ZZ M4 Series', 994004, 1));
  n := pg_temp.reload((v ->> 'show_id')::uuid);
  if n.status <> 'skipped' or n.priority <> 'high' or n.legacy_status <> 'highpriority' or n.genres <> '{Crime}' or n.forms <> '{Documentary}'
     or not n.metadata_owner_set or n.ended or n.network is not null then raise exception 'show: %', to_jsonb(n); end if;
  w := pg_temp.frow(w.id);
  if w.priority is not null or w.catalog_new is not null or w.genres is not null or w.metadata_owner_set is not null or w.theme_kind is not null then raise exception 'row: %', to_jsonb(w); end if;
end $$ $b$);
select pg_temp.t('W7 M5 film → join an existing show: the destination keeps every value and its range; the film''s differing values are acknowledged first (nothing written before); film-only values become NULL', $b$ do $$
declare d public.tv_shows; w public.watchlist_items; v jsonb; c text; a uuid; b uuid;
begin
  perform pg_temp.as_anon();
  d := pg_temp.show('ZZ M5 Dest', 3);
  perform pg_temp.admin(format('update public.tv_shows set tmdb_id = 994005 where id = %L', d.id));
  perform pg_temp.admin(format('update public.watchlist_items set media_type = %L, tmdb_id = 994005, season_number = substr(season, 8)::int where show_id = %L', 'tv', d.id));
  a := pg_temp.season(d.id, 1); b := pg_temp.season(d.id, 3);
  perform pg_temp.admin(format('update public.watchlist_items set watched = true where id = %L', b));
  perform public.library_set_resume_b45(d.id, jsonb_build_object('status', 'confirmed', 'resume_start_season_id', null, 'resume_end_season_id', null), a, b);
  perform pg_temp.flag_off();
  perform pg_temp.admin($q$insert into public.watchlist_items (item_key, title, season, theme, theme_kind, display_date, date_sort, status, watched,
    priority, catalog_new, status_review, legacy_status, genres, forms, franchises, companies, genre_candidates, metadata_owner_set)
    values ('zz m5 film|film', 'ZZ M5 Film', 'Film', 'ZZ Co', 'other', 'Jan 1, 2020', '2020-01-01', 'confirmed', true,
    'high', true, false, 'pending', '{Crime}', '{}', '{}', '{}', '{}', true)$q$);
  w := (select x from public.watchlist_items x where item_key = 'zz m5 film|film');
  c := pg_temp.content();
  v := public.library_match_season_b45(w.id, '{"tmdb_id": 994005}', pg_temp.season_patch('ZZ M5 Dest', 994005, 4));
  if v ->> 'reason' <> 'state_acknowledgment' or pg_temp.content() <> c then raise exception 'ack first: %', v; end if;
  if not (v -> 'items') @> '[{"field": "priority"}, {"field": "catalog_new"}, {"field": "legacy_status"}, {"field": "genres"}, {"field": "metadata_owner_set"}]'::jsonb
     or (v -> 'items') @> '[{"field": "ended"}]'::jsonb or (v -> 'items') @> '[{"field": "status"}]'::jsonb then raise exception 'items: %', v -> 'items'; end if;
  v := public.library_match_season_b45(w.id, '{"tmdb_id": 994005}', pg_temp.season_patch('ZZ M5 Dest', 994005, 4), '{}', v ->> 'confirmation');
  d := pg_temp.reload(d.id);
  if (v ->> 'show_id')::uuid <> d.id or d.priority <> 'normal' or d.catalog_new or d.genres <> '{}' or d.metadata_owner_set or d.legacy_status is not null
     or d.resume_start_season_id <> a or d.resume_end_season_id <> b then raise exception 'destination: %', to_jsonb(d); end if;
  w := pg_temp.frow(w.id);
  if w.show_id <> d.id or not w.watched or w.priority is not null or w.catalog_new is not null or w.genres is not null or w.theme_kind is not null then raise exception 'row: %', to_jsonb(w); end if;
  if private.b45_resume_state(d.id) <> 'active' then raise exception 'range: %', private.b45_resume_state(d.id); end if;
end $$ $b$);
select pg_temp.t('W7 M6a season → film: state from the show (not the stale row copy); Ended and network dropped only after the acknowledgment; the former show removed when emptied', $b$ do $$
declare s public.tv_shows; r uuid; v jsonb; w public.watchlist_items; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ M6A', 1); r := pg_temp.season(s.id, 1);
  perform pg_temp.admin(format('update public.tv_shows set priority = %L, ended = true, network = %L, catalog_new = true, legacy_status = %L, genres = %L where id = %L', 'low', 'HBO', 'pending', '{Drama}', s.id));
  perform pg_temp.admin(format('update public.watchlist_items set status = %L where id = %L', 'pending', r));
  c := pg_temp.content();
  v := public.library_match_film_b45(r, jsonb_build_object('show_id', s.id), pg_temp.film_patch('ZZ M6A Film', 994006));
  if v ->> 'reason' <> 'state_acknowledgment' or pg_temp.content() <> c then raise exception 'ack: %', v; end if;
  v := public.library_match_film_b45(r, jsonb_build_object('show_id', s.id), pg_temp.film_patch('ZZ M6A Film', 994006), v ->> 'confirmation');
  w := pg_temp.frow(r);
  if w.status <> 'confirmed' or w.watched or w.priority <> 'low' or not w.catalog_new or w.legacy_status <> 'pending' or w.genres <> '{Drama}'
     or w.theme_kind <> 'other' or w.skipped then raise exception 'film: %', to_jsonb(w); end if;
  if exists (select 1 from public.tv_shows where id = s.id) then raise exception 'former show kept'; end if;
end $$ $b$);
select pg_temp.t('W7 M6b season → film that would be Skipped + Watched: blocked for the owner''s choice; the choice is O1 (New, review, provenance cleared); an acknowledgment alone is not a choice', $b$ do $$
declare s public.tv_shows; r uuid; v jsonb; w public.watchlist_items; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ M6B', 2); r := pg_temp.season(s.id, 1);
  perform public.set_season_watched(r, true);
  perform pg_temp.admin(format('update public.tv_shows set status = %L, catalog_new = true, status_review = true, legacy_status = %L where id = %L', 'skipped', 'maybe', s.id));
  c := pg_temp.content();
  v := public.library_match_film_b45(r, jsonb_build_object('show_id', s.id), pg_temp.film_patch('ZZ M6B Film', 994007));
  if v ->> 'reason' <> 'state_choice' or pg_temp.content() <> c then raise exception 'no choice asked: %', v; end if;
  v := public.library_match_film_b45(r, jsonb_build_object('show_id', s.id), pg_temp.film_patch('ZZ M6B Film', 994007), null, 'watched');
  w := pg_temp.frow(r);
  if w.status <> 'confirmed' or not w.watched or w.catalog_new or w.status_review or w.legacy_status is not null then raise exception 'film: %', to_jsonb(w); end if;
end $$ $b$);
select pg_temp.t('W7 M7 film → film keeps every value; old Match names refuse (client_outdated)', $b$ do $$
declare w public.watchlist_items; b jsonb;
begin
  perform pg_temp.as_anon();
  perform pg_temp.admin($q$insert into public.watchlist_items (item_key, title, season, theme, theme_kind, display_date, date_sort, status, watched,
    priority, catalog_new, status_review, legacy_status, genres, forms, franchises, companies, genre_candidates, metadata_owner_set)
    values ('zz m7 doc|film', 'ZZ M7 Doc', 'Film', 'ZZ Co', 'other', 'Jan 1, 2020', '2020-01-01', 'confirmed', true,
    'high', false, true, 'watching', '{Crime}', '{}', '{}', '{}', '{}', true)$q$);
  w := (select x from public.watchlist_items x where item_key = 'zz m7 doc|film');
  b := private.b45_film_state(w) || private.b45_film_metadata(w) || jsonb_build_object('legacy', w.legacy_status);
  perform public.library_match_film_b45(w.id, '{"show_id": null}', pg_temp.film_patch('ZZ M7 Film', 994008));
  w := pg_temp.frow(w.id);
  if private.b45_film_state(w) || private.b45_film_metadata(w) || jsonb_build_object('legacy', w.legacy_status) <> b or w.tmdb_id <> 994008 then raise exception 'changed: %', to_jsonb(w); end if;
  perform pg_temp.refused(format('select public.library_match_film(%L, %L::jsonb, %L::jsonb)', w.id, '{"show_id": null}', pg_temp.film_patch('ZZ M7 X', 994009)), 'client_outdated');
  perform pg_temp.refused(format('select public.library_match_season(%L, %L::jsonb, %L::jsonb)', w.id, '{"tmdb_id": 994010}', pg_temp.season_patch('ZZ M7 Y', 994010, 1)), 'client_outdated');
end $$ $b$);

-- ── C1: the old names an open old page calls ──
select pg_temp.t('C1 designated stubs refuse with nothing written; the deliberately supported paths keep working', $b$ do $$
declare s public.tv_shows; w public.watchlist_items; c text;
begin
  perform pg_temp.as_anon();
  s := pg_temp.show('ZZ C1', 2); w := pg_temp.film('ZZ C1 F'); c := pg_temp.content();
  perform pg_temp.flag_off();
  perform pg_temp.refused(format('select public.set_show_status(%L, %L)', s.id, 'watching'), 'client_outdated');
  perform pg_temp.refused(format('select public.set_show_status(%L, %L)', s.id, 'highpriority'), 'client_outdated');
  perform pg_temp.refused(format('select public.library_add_seasons(%L, %L::jsonb, %L::jsonb)', s.id, jsonb_build_object('tmdb_id', null, 'show_key', s.show_key, 'catalog', null),
    '[{"item_key": "zz c1|season 3", "title": "ZZ C1", "season": "Season 3", "date_sort": "2020-01-01"}]'), 'client_outdated');
  perform pg_temp.refused($q$select public.library_create_show('{"title": "ZZ C1 New", "show_key": "zz c1 new"}', '[{"item_key": "zz c1 new|season 1", "title": "ZZ C1 New", "season": "Season 1", "date_sort": "2020-01-01"}]')$q$, 'client_outdated');
  perform pg_temp.refused($q$select public.library_add_films('[{"tmdb_id": 995001, "title": "ZZ C1 Film", "item_key": "zz c1 film|film", "date_sort": "2020-01-01"}]')$q$, 'client_outdated');
  perform pg_temp.refused($q$select public.library_create_film('{"title": "ZZ C1 Hand", "item_key": "zz c1 hand|film", "season": "Film", "date_sort": "2020-01-01"}')$q$, 'client_outdated');
  perform pg_temp.refused($q$select public.library_catalog_apply('disney', '[]')$q$, 'client_outdated');
  perform pg_temp.refused(format('update public.watchlist_items set status = %L where id = %L', 'skipped', w.id), 'library_write_required');
  perform pg_temp.refused(format('update public.watchlist_items set watched = true where id = %L', w.id), 'library_write_required');
  if pg_temp.content() <> c then raise exception 'a refused call wrote'; end if;
  update public.watchlist_items set watch_with = '{}' where id = w.id;
  perform public.set_season_watched(pg_temp.season(s.id, 1), true);
  perform public.set_season_skipped(pg_temp.season(s.id, 2), true);
  perform public.delete_tv_season(pg_temp.season(s.id, 2));
end $$ $b$);

-- ── N1 / RL8–RL10: restore format 5 ──
create or replace function pg_temp.doc5() returns jsonb language plpgsql as $$
declare t jsonb := '{}'; v jsonb; name text; cols text[];
begin
  for name, cols in select * from (values
    ('watchlist_items', array['id','item_key','title','season','theme','theme_kind','display_date','date_sort','watched','status','created_at','watch_with','collections',
      'tmdb_collection_id','tmdb_collection_name','media_type','tmdb_id','season_number','show_id','skipped','priority','catalog_new','status_review','legacy_status',
      'genres','forms','franchises','companies','genre_candidates','metadata_owner_set']),
    ('tv_shows', array['id','title','show_key','tmdb_id','status','created_at','priority','ended','catalog_new','status_review','legacy_status','genres','forms','franchises',
      'companies','genre_candidates','network','network_candidates','metadata_owner_set','resume_start_season_id','resume_end_season_id']),
    ('custom_collections', array['id','name','tmdb_person_id','created_at','role']),
    ('personal_collections', array['id','name','catalog_id','presentation_key','sort_order','archived_at','created_at']),
    ('collection_memberships', array['id','collection_id','show_id','item_id','created_at']),
    ('watch_with_choices', array['id','token','label','sort_order','archived_at','created_at']),
    ('catalog_show_links', array['id','catalog','catalog_key','show_id','origin','created_at']),
    ('catalog_film_links', array['id','catalog','entry_key','item_id','origin','created_at'])) x(n, c) loop
    execute format('select coalesce(jsonb_agg((select jsonb_object_agg(c, to_jsonb(r) -> c) from unnest($1) c) order by r.id), ''[]'') from public.%I r', name) into v using cols;
    t := t || jsonb_build_object(name, v);
  end loop;
  return jsonb_build_object('format', 'watchlist-tracker-backup', 'formatVersion', 5, 'exportedAt', '2026-10-13T00:00:00Z',
    'rowCounts', (select jsonb_object_agg(k, jsonb_array_length(t -> k)) from jsonb_object_keys(t) k), 'tables', t);
end $$;
select pg_temp.t('RL8 a format-5 round trip keeps every value, an active and a completed-but-retained range included', $b$ do $$
declare a public.tv_shows; b public.tv_shows; c text; d jsonb;
begin
  perform pg_temp.as_anon();
  a := pg_temp.show('ZZ RL8 A', 3); b := pg_temp.show('ZZ RL8 B', 3);
  perform public.set_season_watched(pg_temp.season(a.id, 3), true);
  perform public.set_season_watched(pg_temp.season(b.id, 3), true);
  perform public.library_set_resume_b45(a.id, jsonb_build_object('status', a.status, 'resume_start_season_id', null, 'resume_end_season_id', null), pg_temp.season(a.id, 1), pg_temp.season(a.id, 3));
  perform public.library_set_resume_b45(b.id, jsonb_build_object('status', b.status, 'resume_start_season_id', null, 'resume_end_season_id', null), pg_temp.season(b.id, 1), pg_temp.season(b.id, 3));
  perform public.set_season_watched(pg_temp.season(b.id, 1), true);
  perform public.set_season_watched(pg_temp.season(b.id, 2), true);
  if private.b45_resume_state(a.id) <> 'active' or private.b45_resume_state(b.id) <> 'complete' then raise exception 'states'; end if;
  c := pg_temp.content(); d := pg_temp.doc5();
  perform public.restore_backup(d);
  perform pg_temp.fk_now();
  if pg_temp.content() <> c or private.b45_resume_state(a.id) <> 'active' or private.b45_resume_state(b.id) <> 'complete' then raise exception 'round trip differs'; end if;
end $$ $b$);
select pg_temp.t('RL10 restore ordering: rows in any order (shows naming seasons that come later, seasons first, reversed arrays) restore the same state', $b$ do $$
declare a public.tv_shows; c text; d jsonb;
begin
  perform pg_temp.as_anon();
  a := pg_temp.show('ZZ RL10', 3);
  perform public.set_season_watched(pg_temp.season(a.id, 3), true);
  perform public.library_set_resume_b45(a.id, jsonb_build_object('status', a.status, 'resume_start_season_id', null, 'resume_end_season_id', null), pg_temp.season(a.id, 1), pg_temp.season(a.id, 3));
  c := pg_temp.content(); d := pg_temp.doc5();
  d := jsonb_set(d, '{tables,tv_shows}', (select jsonb_agg(x order by x ->> 'id' desc) from jsonb_array_elements(d -> 'tables' -> 'tv_shows') x));
  d := jsonb_set(d, '{tables,watchlist_items}', (select jsonb_agg(x order by x ->> 'id' desc) from jsonb_array_elements(d -> 'tables' -> 'watchlist_items') x));
  perform public.restore_backup(d);
  perform pg_temp.fk_now();
  if pg_temp.content() <> c then raise exception 'differs'; end if;
end $$ $b$);
select pg_temp.t('N1 / RL9 restore refusals (nothing changed): a film without priority, a season with a priority, a film legacy outside the domain, one resume column, a range naming another show''s season or a film; formats 3 and 4 sent directly', $b$ do $$
declare a public.tv_shows; o public.tv_shows; w public.watchlist_items; c text; d jsonb; bad jsonb; i int;
begin
  perform pg_temp.as_anon();
  a := pg_temp.show('ZZ N1 A', 3); o := pg_temp.show('ZZ N1 B', 1); w := pg_temp.film('ZZ N1 F');
  perform public.set_season_watched(pg_temp.season(a.id, 3), true);
  c := pg_temp.content(); d := pg_temp.doc5();
  for i in 1 .. 7 loop
    bad := case i
      when 1 then jsonb_set(d, '{tables,watchlist_items}', (select jsonb_agg(case when x ->> 'id' = w.id::text then x || '{"priority": null}' else x end) from jsonb_array_elements(d -> 'tables' -> 'watchlist_items') x))
      when 2 then jsonb_set(d, '{tables,watchlist_items}', (select jsonb_agg(case when x ->> 'id' = pg_temp.season(a.id, 1)::text then x || '{"priority": "high"}' else x end) from jsonb_array_elements(d -> 'tables' -> 'watchlist_items') x))
      when 3 then jsonb_set(d, '{tables,watchlist_items}', (select jsonb_agg(case when x ->> 'id' = w.id::text then x || '{"legacy_status": "skipped"}' else x end) from jsonb_array_elements(d -> 'tables' -> 'watchlist_items') x))
      when 4 then jsonb_set(d, '{tables,tv_shows}', (select jsonb_agg(case when x ->> 'id' = a.id::text then x || jsonb_build_object('resume_start_season_id', pg_temp.season(a.id, 1)) else x end) from jsonb_array_elements(d -> 'tables' -> 'tv_shows') x))
      when 5 then jsonb_set(d, '{tables,tv_shows}', (select jsonb_agg(case when x ->> 'id' = a.id::text then x || jsonb_build_object('resume_start_season_id', pg_temp.season(o.id, 1), 'resume_end_season_id', pg_temp.season(a.id, 3)) else x end) from jsonb_array_elements(d -> 'tables' -> 'tv_shows') x))
      when 6 then jsonb_set(d, '{tables,tv_shows}', (select jsonb_agg(case when x ->> 'id' = a.id::text then x || jsonb_build_object('resume_start_season_id', w.id, 'resume_end_season_id', pg_temp.season(a.id, 3)) else x end) from jsonb_array_elements(d -> 'tables' -> 'tv_shows') x))
      else d || '{"formatVersion": 4}' end;
    perform pg_temp.refused(format('select public.restore_backup(%L::jsonb)', bad), 'restore_invalid');
    if pg_temp.content() <> c then raise exception 'case % changed the database', i; end if;
  end loop;
end $$ $b$);

-- ── A recovery section's other-TV rows: one per collection and numeric TMDB id ──
-- The recovery archive's contents (read as postgres; the archive is private), captured_at aside.
create or replace function pg_temp.archive() returns text language plpgsql as $$
declare v text;
begin
  perform set_config('role', 'postgres', true);
  select concat_ws('/',
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.kind, t.id), '')) from private.stage5_recovery_records t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from private.stage5_recovery_collections t),
    (select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from private.stage5_recovery_othertv t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'captured_at')::text, '|' order by t.user_id), '')) from private.stage5_recovery_meta t)) into v;
  perform pg_temp.as_anon();
  return v;
end $$;
-- The other-TV archive rows as restore_backup writes them, for comparing with a section.
create or replace function pg_temp.archived_othertv() returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('role', 'postgres', true);
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'tmdb_id', tmdb_id, 'title', title, 'network', network, 'created_at', created_at, 'collection', collection) order by id), '[]')
    into v from private.stage5_recovery_othertv;
  perform pg_temp.as_anon();
  return v;
end $$;
-- A converted format-3 document: doc5 with a conversion record and a recovery section whose
-- storage map follows the current rows' governance, and the given other-TV rows.
create or replace function pg_temp.with_recovery(d jsonb, p_otv jsonb) returns jsonb language sql as $$
  select d || jsonb_build_object(
    'conversion', jsonb_build_object('source_format', 3, 'source_sha256', repeat('b', 64), 'converter_version', 'zz-test', 'source_exported_at', '2026-10-12T00:00:00Z'),
    'recovery', jsonb_build_object('othertv_shows', p_otv, 'storage_map', jsonb_build_object(
      'shows', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'collection', coalesce(l.catalog, 'othertv')) order by s.id), '[]')
                from public.tv_shows s left join public.catalog_show_links l on l.show_id = s.id),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'collection',
                  case when w.show_id is not null then coalesce(ls.catalog, 'othertv')
                       else coalesce(lf.catalog, case when w.theme_kind = 'genre' then 'movies' else 'othertv' end) end) order by w.id), '[]')
                from public.watchlist_items w left join public.catalog_show_links ls on ls.show_id = w.show_id left join public.catalog_film_links lf on lf.item_id = w.id),
      'personal_collections', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'legacy_source', c.presentation_key) order by c.id), '[]')
                from public.personal_collections c))))
$$;
create or replace function pg_temp.otv(p_n int, p_collection text, p_tmdb jsonb) returns jsonb language sql as $$
  select jsonb_build_object('id', format('0d000000-0000-4000-8000-%s', lpad(p_n::text, 12, '0')), 'tmdb_id', p_tmdb, 'title', 'ZZ Other ' || p_n,
    'network', 'ZZ Net', 'created_at', '2026-10-01T00:00:00+00:00', 'collection', p_collection)
$$;
select pg_temp.t('recovery other-TV rows: one per collection and numeric TMDB id — valid rows restore exactly (the same id in two storages, a leading zero alone); the same show spelled differently ("0990000077" / 990000077, "00990000077" / "0990000077", in either storage) is refused with every table and the archive unchanged', $b$ do $$
declare c text; a text; d jsonb; good jsonb; bad jsonb; i int;
begin
  perform pg_temp.as_anon();
  good := jsonb_build_array(pg_temp.otv(1, 'othertv', '990000077'), pg_temp.otv(2, 'truecrime', '990000077'), pg_temp.otv(3, 'othertv', '"0990000078"'));
  c := pg_temp.content();
  d := pg_temp.with_recovery(pg_temp.doc5(), good);
  perform public.restore_backup(d);
  perform pg_temp.fk_now();
  if pg_temp.content() <> c then raise exception 'the valid restore changed the library'; end if;
  if pg_temp.archived_othertv() <> (select jsonb_agg(x || jsonb_build_object('tmdb_id', (x ->> 'tmdb_id')::int, 'created_at', (x ->> 'created_at')::timestamptz) order by x ->> 'id')
                                    from jsonb_array_elements(good) x) then
    raise exception 'the archive''s other-TV rows differ from the section: %', pg_temp.archived_othertv();
  end if;
  a := pg_temp.archive();
  -- restore_backup's temp tables drop at commit; each API request is its own transaction, this check is one.
  perform set_config('role', 'postgres', true);
  drop table if exists pg_temp._s5map, pg_temp._s5cmap;
  perform pg_temp.as_anon();
  for i in 1 .. 5 loop
    bad := good || case i
      when 1 then jsonb_build_array(pg_temp.otv(4, 'othertv', '"0990000077"'))       -- text with a leading zero vs the number
      when 2 then jsonb_build_array(pg_temp.otv(4, 'truecrime', '"0990000077"'))     -- the same, in the other storage
      when 3 then jsonb_build_array(pg_temp.otv(4, 'othertv', '"00990000078"'))      -- two spellings, both text
      when 4 then jsonb_build_array(pg_temp.otv(4, 'othertv', '990000078'))          -- the number vs "0990000078"
      else jsonb_build_array(pg_temp.otv(4, 'othertv', '"990000077"')) end;          -- the same text (refused before this fix too)
    perform pg_temp.refused(format('select public.restore_backup(%L::jsonb)', pg_temp.with_recovery(pg_temp.doc5(), bad)),
      'restore_invalid: the recovery section doesn''t match the backup ({"othertv_repeats": 1})');
    if pg_temp.content() <> c or pg_temp.archive() <> a then raise exception 'case % changed the database', i; end if;
  end loop;
end $$ $b$);

select json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq)::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from _t;
