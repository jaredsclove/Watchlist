# Database scripts for the first-class TV-show migration

Run as `postgres` in the Supabase SQL Editor, one approved step at a time. Every
production step needs explicit approval and a fresh validated backup first.

| Step | Script(s) | What it does |
|---|---|---|
| Phase 0 | `phase0_restore_v1.sql` | Transactional restore (format 1) for the current schema |
| Phase 1b | `phase1b_ownership.sql`, then `restore_backup.sql` | Bootstrap owner, `user_id` everywhere, per-owner uniqueness, column write grants; owner-scoped restore |
| Phase 1c | `phase1c_tv_schema.sql`, `tv_model.sql`, `phase1c_backfill.sql` | `tv_shows`, `show_id`/`skipped`, the season link; model functions; backfill with exact-count assertions |
| Phase 2 | `rpc.sql`, then the Phase 2 block in `stages.sql` | Browser-facing functions; stage → shadow |
| Phase 3 | the Phase 3 block in `stages.sql` | Stage → authoritative (the switch-over) |
| Clean-up C1 | the C1 block in `stages.sql` | Stop writing compatibility values |
| Rollbacks | `stages.sql` (Phase 3), `rollback/phase2_and_1c.sql`, `rollback/phase1b.sql` + `phase0_restore_v1.sql` | Undo each phase |
| Future sign-in | `future/auth_switchover.sql` | Not part of this migration |

`test/` is for test projects and local runs only: `replica_schema.sql` (the
pre-migration production schema), `supabase_shim.sql` (PGlite only), and the
self-checking `t_*.sql` scripts (prepend `_prelude.sql`; every check rolls back
its own writes).

Test-project values (project ref, publishable key, test-user ids) are never
committed. Supply them through the untracked files `db/test/local_test_users.sql`
and `tools/auth-isolation-test.local.js` (both in `.gitignore`); copy the
committed `*.example.*` templates. The scripts and the test page refuse to run
without them, and the page refuses production values.

Rehearsals:
- Local: `PGLITE_DIR=<dir with @electric-sql/pglite> node tools/db-rehearsal.mjs <backup.json>`
  (set `EXPECT_FINGERPRINT=w/o/c` to compare with production's fingerprints).
- Test project API: `TEST_SUPABASE_URL=… TEST_SUPABASE_KEY=<publishable> node tools/db-rehearsal-rest.mjs <command>`
  (refuses the production URL).
- Model vs reference on a test project: `node tools/tv-model-expectations.mjs <backup.json>` prints a self-check script.
