// Template for tools/auth-isolation-test.local.js, which is NOT committed
// (.gitignore). Copy this file to that name and fill in the TEMPORARY test
// project's values. Never put production values here: the page refuses them.
// Passwords are never stored anywhere; they're typed into the page at run time.
window.AUTH_ISOLATION_TEST_CONFIG = {
  projectRef: 'YOUR_TEST_PROJECT_REF',          // 20 lowercase letters/digits, from the test project's URL
  publishableKey: 'YOUR_TEST_PUBLISHABLE_KEY',  // the test project's sb_publishable_... key
  userA: 'YOUR_TEST_USER_A_UUID',               // owns the copied list after db/test/lock_test_project.sql
  userB: 'YOUR_TEST_USER_B_UUID'
};
