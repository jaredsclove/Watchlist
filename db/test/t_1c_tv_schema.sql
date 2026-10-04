-- Checks after Phase 1c schema + backfill (prepend db/test/_prelude.sql). Run as postgres.

select pg_temp.t('1c: every TV season linked to exactly one show of the same owner and collection; no film linked', $b$ do $$
begin
  if exists (select 1 from public.watchlist_items where private.tv_is_tv_row(collection, media_type, season) and show_id is null) then
    raise exception 'unlinked TV season';
  end if;
  if exists (select 1 from public.watchlist_items where not private.tv_is_tv_row(collection, media_type, season) and show_id is not null) then
    raise exception 'non-TV row linked';
  end if;
  if exists (select 1 from public.watchlist_items w join public.tv_shows s on s.id = w.show_id
             where s.user_id <> w.user_id or s.collection <> w.collection or s.tmdb_id is distinct from w.tmdb_id) then
    raise exception 'season and show disagree';
  end if;
end $$ $b$);

select pg_temp.t('1c: spot checks of migrated show statuses and skip flags', $b$ do $$
declare s text; n int;
begin
  select status into s from public.tv_shows where collection = 'othertv' and title = 'The Traitors';
  if s is distinct from 'watching' then raise exception 'The Traitors: %', s; end if;
  select status into s from public.tv_shows where collection = 'disney' and title = 'Star Wars: The Clone Wars (2008)';
  if s is distinct from 'watching' then raise exception 'Clone Wars: %', s; end if;
  select status into s from public.tv_shows where title = 'Breaking Bad';
  if s is distinct from 'complete' then raise exception 'Breaking Bad: %', s; end if;
  select status into s from public.tv_shows where title = 'The Mandalorian' and collection = 'disney';
  if s is distinct from 'confirmed' then raise exception 'The Mandalorian (fully watched, On List): %', s; end if;
  select status into s from public.tv_shows where title = 'Landman';
  if s is distinct from 'confirmed' then raise exception 'Landman (On List + Pending): %', s; end if;
  select status into s from public.tv_shows where title = 'The Bear' and collection = 'disney';
  if s is distinct from 'pending' then raise exception 'The Bear: %', s; end if;
  select status into s from public.tv_shows where title = 'Darcey & Stacey';
  if s is distinct from 'skipped' then raise exception 'Darcey & Stacey: %', s; end if;
  select count(*) into n from public.watchlist_items w join public.tv_shows t on t.id = w.show_id where t.title = 'Darcey & Stacey' and w.skipped;
  if n <> 0 then raise exception 'Darcey & Stacey flags %', n; end if;
  select count(*) into n from public.watchlist_items w join public.tv_shows t on t.id = w.show_id where t.title = 'Love Island USA' and w.skipped;
  if n <> 7 then raise exception 'Love Island USA flags %', n; end if;
  select count(*) into n from public.watchlist_items w join public.tv_shows t on t.id = w.show_id
   where t.title = 'The Traitors' and w.skipped;
  if n <> 0 then raise exception 'The Traitors flags %', n; end if;
end $$ $b$);

select pg_temp.t('1c: the link rejects a season pointing at another owner''s show or another collection''s show', $b$ do $$
declare v_row uuid; v_other uuid; v_coll uuid;
begin
  select id into v_row from public.watchlist_items where collection = 'othertv' and show_id is not null limit 1;
  insert into public.tv_shows (user_id, collection, title, show_key) values (gen_random_uuid(), 'othertv', 'ZZ', 'zz') returning id into v_other;
  insert into public.tv_shows (collection, title, show_key) values ('disney', 'ZZ', 'zz') returning id into v_coll;
  begin update public.watchlist_items set show_id = v_other where id = v_row; raise exception 'cross-owner link accepted';
  exception when foreign_key_violation then null; end;
  begin update public.watchlist_items set show_id = v_coll where id = v_row; raise exception 'cross-collection link accepted';
  exception when foreign_key_violation then null; end;
end $$ $b$);

select pg_temp.t('1c: films and movies can never be linked; skipped needs a show', $b$ do $$
declare v_show uuid; v_film uuid; v_movie uuid;
begin
  select id into v_film from public.watchlist_items where collection = 'disney' and season = 'Film' limit 1;
  select id into v_movie from public.watchlist_items where media_type = 'movie' limit 1;
  insert into public.tv_shows (collection, title, show_key) values ('disney', 'ZZ', 'zz film') returning id into v_show;
  begin update public.watchlist_items set show_id = v_show where id = v_film; raise exception 'film linked';
  exception when check_violation then null; end;
  begin update public.watchlist_items set skipped = true where id = v_movie; raise exception 'skipped movie';
  exception when check_violation then null; end;
end $$ $b$);

select pg_temp.t('1c: show ids reject deleting a show that still has seasons', $b$ do $$
declare v_show uuid;
begin
  select show_id into v_show from public.watchlist_items where show_id is not null limit 1;
  begin delete from public.tv_shows where id = v_show; raise exception 'show with seasons deleted';
  exception when restrict_violation or foreign_key_violation then null; end;
end $$ $b$);

select pg_temp.t('1c: changing a show''s owner cascades to its linked seasons (the future account move)', $b$ do $$
declare v_show uuid; o uuid := gen_random_uuid(); n int; m int;
begin
  select show_id into v_show from public.watchlist_items where show_id is not null group by show_id order by count(*) desc limit 1;
  select count(*) into n from public.watchlist_items where show_id = v_show;
  update public.tv_shows set user_id = o where id = v_show;
  select count(*) into m from public.watchlist_items where show_id = v_show and user_id = o;
  if m <> n then raise exception 'cascade moved % of %', m, n; end if;
end $$ $b$);

select pg_temp.t('1c: tv_shows permissions: anon cannot write user_id; anon inserts are owned; uniqueness per owner', $b$ do $$
declare r public.tv_shows;
begin
  if has_column_privilege('anon', 'public.tv_shows', 'user_id', 'INSERT') or has_column_privilege('anon', 'public.tv_shows', 'user_id', 'UPDATE') then
    raise exception 'anon can write tv_shows.user_id';
  end if;
  if not (has_column_privilege('anon', 'public.watchlist_items', 'show_id', 'UPDATE') and has_column_privilege('anon', 'public.watchlist_items', 'skipped', 'UPDATE')) then
    raise exception 'anon cannot write show_id/skipped';
  end if;
  insert into public.tv_shows (user_id, collection, title, show_key, tmdb_id) values (gen_random_uuid(), 'othertv', 'ZZ', 'zz', 999000010);
  perform set_config('role', 'anon', true);
  insert into public.tv_shows (collection, title, show_key, tmdb_id) values ('othertv', 'ZZ', 'zz', 999000010) returning * into r;
  if r.user_id is distinct from private.current_owner_id() then raise exception 'not owned'; end if;
  begin insert into public.tv_shows (collection, title, show_key, tmdb_id) values ('othertv', 'ZZ2', 'zz2', 999000010);
    raise exception 'duplicate identified show for one owner'; exception when unique_violation then null; end;
  begin insert into public.tv_shows (collection, title, show_key, user_id) values ('othertv', 'ZZ', 'zz', gen_random_uuid());
    raise exception 'anon set tv_shows.user_id'; exception when insufficient_privilege then null; end;
end $$ $b$);

select pg_temp.t('1c: tv_shows has RLS on with the same four anon policies as the other tables', $b$ do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.tv_shows'::regclass) then raise exception 'RLS off'; end if;
  if (select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies where tablename = 'tv_shows')
     is distinct from 'anon_delete:DELETE,anon_insert:INSERT,anon_select:SELECT,anon_update:UPDATE' then
    raise exception 'policies differ';
  end if;
end $$ $b$);

select json_agg(json_build_object('check', name, 'ok', ok, 'detail', detail) order by seq)::text as results,
       count(*) filter (where ok) || '/' || count(*) as passed
from _t;
