-- TEST ENVIRONMENTS ONLY: removes W1 so its install can be rehearsed again. Never a production step: production
-- is fix-forward.
-- Refuses unless the database is marked as a test environment (db/test/m1_test_marker.sql).
begin;
do $$ begin
  if to_regclass('zz_test.environment') is null then raise exception 'w1 reverse: not a marked test environment; nothing was changed'; end if;
  if to_regprocedure('private.lib_authorized()') is null then raise exception 'w1 reverse: W1 is not installed; nothing was changed'; end if;
end $$;
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p, unnest(p.proconfig) x where x = 'xmloption=document' loop
    execute format('alter function %s reset xmloption', f);
  end loop;
end $$;
create or replace function private.lib_write_on() returns void
language plpgsql set search_path = '' as $$
begin
  lock table public.tv_shows, public.watchlist_items in row exclusive mode;
  perform set_config('watchlist.library_write', 'on', true);
end $$;
create or replace function private.library_write_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('watchlist.library_write', true), '') <> 'on' then
    raise exception 'library_write_required: This change is made only through the app''s library functions. Reload the page. Nothing was changed.'
      using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create or replace function private.b45_show_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('watchlist.library_write', true), '') = 'on' then return new; end if;
  if coalesce(current_setting('watchlist.resume_cleanup', true), '') = 'on'
     and new.resume_start_season_id is null and new.resume_end_season_id is null
     and (to_jsonb(new) - 'resume_start_season_id' - 'resume_end_season_id') = (to_jsonb(old) - 'resume_start_season_id' - 'resume_end_season_id') then
    return new;
  end if;
  raise exception 'library_write_required: This change is made only through the app''s library functions. Reload the page. Nothing was changed.'
    using errcode = 'P0001';
end $$;
drop function private.lib_authorized();
delete from private.migration_runs where migration = 'w1';
commit;
