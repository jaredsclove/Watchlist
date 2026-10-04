-- Template for db/test/local_test_users.sql, which is NOT committed (.gitignore).
-- Copy it to that name, fill in the TEMPORARY test project's two test-user ids,
-- and run it in the same SQL Editor run, before db/test/lock_test_project.sql or
-- db/test/t_two_user.sql (prepend it). Test projects only.
select set_config('watchlist_test.user_a', 'YOUR_TEST_USER_A_UUID', false),
       set_config('watchlist_test.user_b', 'YOUR_TEST_USER_B_UUID', false);
