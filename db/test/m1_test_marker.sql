-- TEST ENVIRONMENTS ONLY. Marks a database as a Watchlist test environment, so that test-only
-- scripts (db/test/m1_reverse.sql, the hosted-pass scripts) refuse to run anywhere else.
-- Before running it on a hosted project, check the project ref in the dashboard URL against the
-- named test project, and set it here:
--   select set_config('watchlist.test_project', '<the test project ref, or "local">', false);
begin;
do $$ begin
  if coalesce(current_setting('watchlist.test_project', true), '') !~ '^[a-z0-9-]{3,40}$' then
    raise exception 'set watchlist.test_project to the test project ref (or local) first';
  end if;
  if to_regclass('zz_test.environment') is not null then raise exception 'already marked as %',
    (select project_ref from zz_test.environment); end if;
end $$;
-- Its own schema (never exposed, no browser grants), so it can be installed before the app's schemas exist.
create schema zz_test;
revoke all on schema zz_test from public, anon, authenticated;
create table zz_test.environment (project_ref text not null, marked_at timestamptz not null default now());
revoke all on zz_test.environment from public, anon, authenticated;
insert into zz_test.environment (project_ref) values (current_setting('watchlist.test_project'));
commit;
