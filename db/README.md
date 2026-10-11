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
| Stage 5a (expand) | `phase5a_expand.sql` (stage `final`, after Stage 4b) | Coexistence: storage stays the source of truth. Aborts on any identity collision (duplicate TMDB show / film / season, two seasons of a show with one key, duplicate catalog keys, unclassified rows) before adding anything. Adds the four library identity indexes, the five read views (`library_catalog_shows`, `library_catalog_films`, `library_film_theme_kinds`, `library_collection_catalogs`, `library_collection_presentation`, derived from storage, `security_invoker`), `stage5_capabilities()` (`phase: coexistence`, backup format 3) and the storage-free `library_*` functions the Stage 5 page calls (`library_add_seasons`, `library_create_show`, `library_add_films`, `library_create_film`, `library_match_season`, `library_match_film`, `library_catalog_apply`), each SECURITY INVOKER, each taking `tv_shows` and `watchlist_items` in ROW EXCLUSIVE mode before its checks so it never interleaves with a catalog application. Creating (or matching to a new show) a record with the same key or normalized title as a record a catalog governs is refused (`catalog_candidate`, with the candidates) unless the caller names that record in `distinct_from`; a film whose theme is a genre can't be matched to a TV season (`genre_film_season`), as in Stage 4b. The Stage 4a `catalog_apply` keeps its preview but refuses applies (`client_outdated`); an old page's other functions keep working. No stored value changes; one transaction. See `docs/STAGE5.md` |
| Rollback 5a | `rollback/phase5a.sql` | Bound to the G3 baseline (Stage 5 plan §3(b)): the exact function inventory captured read-only from production before 5a (SHA-256 `180b5fb5…`, kept privately with the G3 evidence). **Invocation:** one SQL Editor run whose text is the one-statement preamble `select set_config('watchlist.rollback5a_baseline', $g3inv$<the exact G3 inventory text>$g3inv$, false);` followed by this file; Run is gated on the SHA-256 of that combined text. Refuses, changing nothing, when the baseline is missing (`baseline missing`) or isn't exactly G3's (`baseline invalid`), and unless the phase is coexistence; drops every 5a object and puts back the Stage 4a `catalog_apply` verbatim; before commit compares the restored `catalog_apply` source md5 and the whole function and trigger inventory (signatures, source md5, grants, security mode, configuration; triggers; stage) with the baseline and aborts on any difference (`restored catalog_apply source …` / `restored inventory differs from G3: missing […], extra […], changed […], triggers […]`); on success clears the setting (the catalog is then Stage 4b exactly; data unchanged) |
| Stage 5c (contract) | `phase5c_contract.sql` (after 5a, the 5b page verified and the readiness checks in `docs/STAGE5.md`, including a rehearsed exact recovery of `othertv_shows`) | Archives every record's and collection's storage and every `othertv_shows` row (private schema), creates the governance tables (`catalog_show_links`, `catalog_film_links`: one governing catalog per record), `personal_collections.catalog_id` and `presentation_key` (the True Crime / Docs note and layout, independent of governance), `watchlist_items.theme_kind` (required for every film) and a CHECK that every row is a film or a linked season, switches the read views and the `library_*` primitives to them, installs the write boundary (column grants for what the invoker functions write; guard triggers that refuse those writes unless the transaction set `watchlist.library_write`), turns the old functions into `client_outdated` stubs, `restore_backup` to format 4 (with a converted format-3 file's recovery section, whose installed archive is hashed and checked against that section before commit), drops the membership triggers, storage columns, `legacy_source`, the storage keys and helpers, and `othertv_shows`; verifies every preserved field, the archive and the governance before commit |
| Rollback 5c | `rollback/phase5c.sql` (two sections generated by `tools/stage5-rollback-gen.mjs`) | Back to coexistence while the archive exists: storage and `othertv_shows` from the archive, records created since by a stated rule; refuses (nothing changed) what Stage 5a can't represent and, once the archive is retired, everything (fix-forward). Returns a report of what it discards (governance link ids, origins and created_at) |
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
  the requests the Stage 4b page composes (`library.js`; skipped for the Stage 5 page) sent to the real functions in rolled-back transactions,
  rollback back to the Stage 4a catalog, re-apply). One session: lock waits and timing between sessions aren't shown. It
  does not run the Stage 4a maintenance sequence, and Stage 4b doesn't use it (that sequence has a known, separate issue).
- Stage 5, local: `PGLITE_DIR=<dir> node tools/db-rehearsal-5.mjs <format-3 backup.json> --baseline5a <G3 inventory> [--evidence <dir>]` (5a: no stored
  value changes and exactly its objects added, refused replay, `test/t_5a_expand.sql` and `test/t_4b_add_to_show.sql`, the
  app's own `library_*` requests, rollback to the Stage 4b catalog (equal to the G3 baseline) and re-apply, and the rollback's
  refusals of a missing or wrong baseline and of each kind of difference from it, each leaving the complete state unchanged; 5c: every preserved field kept by id,
  governance equal to the storage it replaces, `test/t_5c_contract.sql`, the same calls answering alike in both phases, a
  format-4 backup restored with every governance field kept row for row, and a converted format-3 file restored (archive
  hashes recorded); the page's edit policy, Match eligibility and theme meaning of every row equal the Stage 4b rule after
  5a and after 5c; rollback of 5c: exact recovery of storage and `othertv_shows` (also after coexistence writes by a
  Stage 5 and an old page), the exact discarded-link report, the 5a catalog, the rule for records made since, refusals,
  a changed format-4 restore followed by a rollback, a format-3 restore during coexistence that changes ids and storage
  followed by contraction and an exact rollback; failure injection before every top-level statement of the four
  scripts, each leaving the complete state unchanged; the generated rollback sections current). Three synthetic records
  with fixed ids (an unidentified show, a True Crime / Docs film, a genre film) are added to each replica, so no branch
  depends on what a saved backup happens to contain. One session:
  how two sessions interleave (locks, timeouts) needs real connections. After any change to `phase5a_expand.sql` or
  `phase5c_contract.sql`, regenerate the rollback sections:
  `PGLITE_DIR=<dir> node tools/stage5-rollback-gen.mjs <format-3 backup.json> --write` (`--check` compares).
- Model vs reference on a test project: `node tools/tv-model-expectations.mjs <backup.json>` prints a self-check script
  (it writes the pre-Stage-5c schema; it doesn't apply to a contracted database).

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

