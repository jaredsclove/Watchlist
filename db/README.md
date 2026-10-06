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
| Rollbacks | `rollback/final.sql` (C1: stage final → authoritative + re-project every show), `rollback/othertv_from_tv_shows.sql` (before reverting the app to a version whose Refresh reads `othertv_shows`, i.e. before `59dd6a1`), `stages.sql` (Phase 3), `rollback/phase2_and_1c.sql`, `rollback/phase1b.sql` + `phase0_restore_v1.sql` | Undo each phase, newest first |
| Admin enrichment | `admin/tv_enrich.sql` (`private.tv_enrich_show`) | Adds an approved TMDB identity to one legacy built-in show and its seasons (dry run by default; admin only). The guard in `rpc.sql` makes later seasons of an enriched built-in show join it |
| Stage 3b-1 | `phase3b_org.sql` (stage `final`) | Personal collections, memberships and watch-with choices; generated `watchlist_items.is_film`; the temporary membership trigger; `restore_backup` for format 3 only; `match_tv_row` keeping memberships (adds `p_expansion`); bootstrap from what each tab stores; self-verifying, one transaction |
| Rollback 3b-1 | `rollback/phase3b.sql` | Refuses unless the organization is exactly what the old model holds; then removes it and puts back the previous `restore_backup` and `match_tv_row` |
| Future sign-in | `future/auth_switchover.sql` | Not part of this migration (covers the Stage 3b-1 tables) |

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
- Stage 3b-1, local: `PGLITE_DIR=<dir> node tools/db-rehearsal-3b.mjs <format-2 backup.json>` (replica at stage final,
  migration, `test/t_3b_org.sql`, refused replay, guarded rollback back to the identical catalog, re-apply, sign-in script).
- Model vs reference on a test project: `node tools/tv-model-expectations.mjs <backup.json>` prints a self-check script.
