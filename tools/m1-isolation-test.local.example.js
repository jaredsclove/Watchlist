// Template for tools/m1-isolation-test.local.js, which is NOT committed (.gitignore). Copy this file to that
// name and fill in the TEMPORARY test project's values. Never production values: the page refuses them.
// Passwords are never stored anywhere; they're typed into the page at run time.
window.M1_ISOLATION_TEST_CONFIG = {
  projectRef: 'YOUR_TEST_PROJECT_REF',           // 20 lowercase letters/digits, from the test project's URL
  publishableKey: 'YOUR_TEST_PUBLISHABLE_KEY',   // the test project's sb_publishable_... key
  userA: 'MEMBER_A_UUID',                        // the owner the M1 migration ran for
  userB: 'MEMBER_B_UUID',                        // added to private.library_members after M1
  syntheticA: 'synthetic-1.json',                // tools/m1-synthetic-library.mjs --seed 1 (the seeded library)
  syntheticB: 'synthetic-2.json'                 // --seed 2
};
