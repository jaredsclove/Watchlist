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
  if to_regclass('private.zz_test_environment') is not null then raise exception 'already marked as %',
    (select project_ref from private.zz_test_environment); end if;
end $$;
create table private.zz_test_environment (project_ref text not null, marked_at timestamptz not null default now());
revoke all on private.zz_test_environment from public, anon, authenticated;
insert into private.zz_test_environment (project_ref) values (current_setting('watchlist.test_project'));
commit;
