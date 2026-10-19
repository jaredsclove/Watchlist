-- TEST ENVIRONMENTS ONLY. The first statement of every script run on the hosted test project:
-- it refuses unless this database carries the test marker for the named project.
--   select set_config('watchlist.test_project', '<the test project ref>', false);
do $$ begin
  if to_regclass('zz_test.environment') is null
     or (select project_ref from zz_test.environment) is distinct from current_setting('watchlist.test_project', true) then
    raise exception 'not the marked test project %; nothing was changed', coalesce(current_setting('watchlist.test_project', true), '(unset)');
  end if;
end $$;
