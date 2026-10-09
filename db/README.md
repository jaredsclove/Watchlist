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
| Stage 3b-2 | `phase3b2_org_write.sql` (stage `final`, after Stage 3b-1) | Functions only: `org_capabilities` (read-only) and owner-scoped write functions for collections, memberships (whole show or film, the show or film locked first) and watch-with choices; an UPDATE that newly adds an archived watch-with choice is refused (rows keep the ones they have; an INSERT may carry them, so restore stays exact); one transaction |
| Rollback 3b-2 | `rollback/phase3b2.sql` | Drops the 3b-2 functions and puts back the Stage 3b-1 watch-with check verbatim; keeps every row and every edit (the database then no longer refuses newly added archived choices) |
| Stage 4a | `phase4a_catalog.sql` (stage `final`, after Stage 3b-2) | Functions and one trigger: `catalog_apply` (preview by an always-rolled-back run; apply only when the hash of the effects it performs equals the approved hash; returns the effects document and the execution receipt), the former seeding logic moved to `private.catalog_insert_missing`, `seed_tv_defaults` replaced by a refusal (`catalog_apply_required`), and `catalog_date_guard` (built-in rows' dates change only inside `catalog_apply`'s date step, or an admin transaction that sets `watchlist.catalog_date_write` deliberately); no table or row change; one transaction. After Stage 4a, `rpc.sql` refuses to run (its first statement checks for `catalog_apply`), because it would put the old tab-open `seed_tv_defaults` back for every open old page; see "Stage 4a maintenance" below |
| Rollback 4a | `rollback/phase4a.sql` | Drops the 4a functions and trigger and restores `seed_tv_defaults` verbatim from `rpc.sql`; keeps every row. **Re-enables implicit writes for every open old page immediately**: a separate owner decision, paired with reverting the refresh-catalogs copies |
| Stage 4b | `phase4b_add_to_show.sql` (stage `final`, after Stage 4a) | Two functions, each one transaction. `add_tv_seasons_to_show(p_show_id, p_expected, p_seasons)` adds seasons to a show already on the list: it locks that show, refuses (`target_missing` / `target_changed`, nothing written) if it is gone or no longer has the collection, TMDB id and show key the page showed, runs the existing `add_tv_seasons` for it and keeps the result only if the seasons went to that show and no show was created. `create_tv_show(p_show, p_seasons)` creates a genuinely new show where new shows go (`othertv`) with all its seasons, or refuses (`show_exists` when the TMDB identity is a show anywhere or the identity / unmatched key is taken there, including at that moment through the unique show indexes; `create_conflict` when not every season can be added); it never adds to or changes an existing show. Season rules are `add_tv_seasons`' own; no table, row, trigger or other function changes. Not part of `rpc.sql` |
| Rollback 4b | `rollback/phase4b.sql` | Drops those two functions only; keeps every row. Run after the app no longer calls them (a Stage 4b page then reports that adding a show or adding to an existing show isn't available and never falls back) |
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
- Stage 3b-2, local: `PGLITE_DIR=<dir> node tools/db-rehearsal-3b2.mjs <format-2 or format-3 backup.json> [--export-edited <out.json>]`
  (replica with Stage 3b-1, migration, `test/t_3b2_org.sql` and `test/t_3b_org.sql`, refused replay, edits, rollback back to
  the Stage 3b-1 catalog with the edits kept, re-apply). One session: it doesn't show how two sessions interleave.
- Stage 4a, local: `PGLITE_DIR=<dir> node tools/db-rehearsal-4a.mjs <format-3 backup.json> [--evidence <dir>]` (replica with
  Stage 3b-2, migration, `test/t_4a_catalog.sql`, refused replay, every built-in catalog previewed twice and after a restore
  with shuffled rows, the app's payload hash compared with the database's, rollback back to the exact pre-4a catalog with
  data unchanged, re-apply). One session: lock waits, `catalog_busy` and deadlocks between sessions need two real
  connections. `node tools/catalog-payload-hash.mjs [commit]` prints each catalog's payload hash at a commit.
- Stage 4b, local: `PGLITE_DIR=<dir> node tools/db-rehearsal-4b.mjs <format-3 backup.json> [--evidence <dir>]` (replica with
  Stage 4a, migration (exactly its two functions added), refused replay, `test/t_4b_add_to_show.sql` and `test/t_4a_catalog.sql`,
  the requests the app composes (`library.js`) for each kind of show sent to the real functions in rolled-back transactions,
  rollback back to the Stage 4a catalog, re-apply). One session: lock waits and timing between sessions aren't shown. It
  does not run the Stage 4a maintenance sequence, and Stage 4b doesn't use it (that sequence has a known, separate issue).
- Model vs reference on a test project: `node tools/tv-model-expectations.mjs <backup.json>` prints a self-check script.

## Stage 4a maintenance

- With Stage 4a installed, `rpc.sql` refuses to run, so it can't silently re-enable tab-open seeding.
- **There is currently no supported way to reinstall a TV function from `rpc.sql` on a 4a database.** The sequence earlier
  documented here (`rollback/phase4a.sql`, then `rpc.sql`, then `phase4a_catalog.sql`) is known to be unsafe and must not
  be used: besides re-enabling tab-open seeding and old pages' date writes while it runs, `rpc.sql` puts back the
  pre-Stage 3b-1 three-argument `match_tv_row` next to the current four-argument one, and nothing in the sequence removes
  it again (found in the Stage 4b local rehearsal, 2026-10-08; not repaired).
- If a TV function ever has to be reinstalled, that needs its own reviewed plan and approval, written for that change (for
  example a targeted script that replaces only that function and checks the whole function inventory afterwards). Never run
  `rpc.sql` with a client that continues after an error.
- **Known outdated text in `rpc.sql`:** the comment above its Stage 4a guard ("the supported sequence is in db/README.md")
  and its refusal message ("Follow 'Stage 4a maintenance'") still imply a supported sequence. `rpc.sql` is
  production-verified and was deliberately not edited in Stage 4b; correct that wording only with a separately approved change.

