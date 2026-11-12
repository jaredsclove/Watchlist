# Database scripts

Migrations run as `postgres` in the Supabase SQL Editor, and every production step needs explicit approval and a validated backup first. The
release tiers are in `docs/STATE.md`. What each script did when it ran, and the older rehearsals: `docs/history/DB_SCRIPTS.md`.

**Current production state:** phase `contracted-g1`, backup format 9, `access = members`, through CU1e, W1's removal, the simplification, Q1, G1 (2026-11-10) and TC1 (the TMDB cache, 2026-11-12; capability `tc1`), with the `igdb` Edge Function deployed and the pg_cron extension enabled for TC1's expiry job. The recovery
archive is retired, exported privately first. There is no schema rollback, and none of the old rollback scripts can run against this state: repairs are fix-forward, and
data recovery is a format-9 restore through the page or `docs/ADMIN_RESTORE.md`.

## Run order

To rebuild a local database, the order is the replay in `tools/db-rehearsal-cu1e-pg.mjs`:

| Step | Scripts |
|---|---|
| Base (`test/` first) | `test/supabase_shim.sql` (PGlite and bare PostgreSQL), `test/replica_schema.sql` (the pre-migration schema), `phase0_restore_v1.sql` |
| Phases 1b–2 | `phase1b_ownership.sql`, `restore_backup.sql`, `phase1c_tv_schema.sql`, `tv_model.sql`, `rpc.sql`, `admin/tv_enrich.sql`, then stage `final` (`stages.sql`) |
| Stages 3–5 | `phase3b_org.sql`, `phase3b2_org_write.sql`, `phase4a_catalog.sql`, `phase4b_add_to_show.sql`, `phase5a_expand.sql`, `phase5c_contract.sql` |
| B4/B5 | `b45_expand.sql` (preamble `watchlist.b45_choices`) |
| M1 | `m1_access.sql` (preamble `watchlist.m1_owner`, `watchlist.m1_run`) |
| EP1 | `ep1_episode_marks.sql` (`watchlist.ep1_run`); `admin/tv_enrich_partial.sql` (`watchlist.enrich_run`) |
| CU1 | `cu1_collection_updates.sql`, `cu1b_hold_edit.sql`, `cu1c_date_equivalence.sql`, `cu1d_network_and_marks.sql`, then `cu2_research_access.sql`, `cu1e_missing_season.sql` (each `watchlist.<name>_run`; CU2 also `watchlist.cu2_owner`) |
| W1 (history) | `w1_write_scope.sql` then `w1_removal.sql`, applied in production and never to be run again there |
| Simplification | `simplify_restore_cleanup.sql` (`watchlist.simplify_run`), applied in production and refused on a rerun: one flat `restore_backup`, the old chain, 36 dormant functions and the six archive and rollback tables removed. `simplify_preflight.sql` is its read-only check and the private archive export. Local builds include it through `tools/restore-fixture.mjs` |
| Q1 | `q1_queues.sql` (`watchlist.q1_run`): the queue tables, their functions, completion and identity triggers, `restore_backup` at format 8, phase `contracted-q1`. Local tests: `tools/q1-test.mjs`, `tools/q1-local-api-test.mjs`; the restore suite and both tools apply it after the simplification. Its triggers (completion, identity) delete or move queue rows with the write flag set for themselves, and put the flag back. Queue entries guard inserts and updates only, so a film's direct delete cascades to them; lock order everywhere is library rows, then the queue tables, then the member's queue lock |

| G1 | `g1_games.sql` (`watchlist.g1_run`): the six game tables and the IGDB cache, their functions, `queue_entries.game_entry_id` (exactly one of a show, a library row or a game), `library_queue_add_game` and `library_queue_set_order` (a whole queue's order in one guarded write), completion (a game set to Finished leaves every queue), `restore_backup` at format 9, phase `contracted-g1`. Every existing row is fingerprinted unchanged. Local tests: `tools/g1-test.mjs`, `tools/g1-local-api-test.mjs`; the restore suite applies it after Q1. Lock order: a game entry's row, then the member's games lock (`private.g1_lock`) or the queue lock |

| TC1 | `tc1_tmdb_cache.sql` (`watchlist.tc1_run`; needs the pg_cron extension enabled first, Dashboard → Integrations → Cron): `public.tmdb_tv_cache`, each member's TMDB show details and season episode lists (owner-only, function-only writes, never in a backup, untouched by restore); `library_tmdb_cache_put` (a row written only when the stored revision is the one the page sent; revisions from `private.tmdb_cache_rev`, never reused) and `library_tmdb_cache_purge`; `private.tmdb_cache_expire` and the daily Cron job `watchlist-tmdb-cache-expiry`, which deletes rows of this table older than 150 days and nothing else. Phase and backup format unchanged (capability `tc1: 1`). Every existing row is fingerprinted unchanged. Local runs load `test/pg_cron_shim.sql` first (jobs recorded, never run). Local tests: `tools/tc1-test.mjs`; the restore suite applies it after G1 |

The `igdb` Edge Function (`supabase/functions/igdb`, deployed with `verify_jwt = false`, `supabase/config.toml`) is the page's only route to IGDB; its secrets `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` are set in the dashboard by the owner. It checks membership itself through `rpc/stage5_capabilities` with the caller's token. Since game length was removed (2026-11-10) it no longer reads time to beat; a `game_time_to_beats` query from a page opened before that is answered with an empty list (temporary). Offline: `tests/igdb-proxy.test.mjs`; on a local stack: `tools/g1-local-api-test.mjs`. `tools/igdb-feasibility.mjs` runs read-only IGDB requests from this machine with a credential file kept outside the repo.

The local replays leave out W1 and its removal: the removal's test showed the catalog afterwards equals the one before W1, so together they add nothing to the state a replay needs.

Conventions for a migration: one transaction; a run label and lock first, then its preconditions; a run id in the preamble, recorded in
`private.migration_runs` and confirmed with a separate read (a missing record means "not committed" only once the transaction is known to have
ended; never rerun to find out); explicit revokes from `anon`, verified before commit; the owner's id only in the preamble, never in a file.

## How writes are authorized

**Function-only writes.** A guarded table or column changes only through a library function. `private.lib_write_on` sets the transaction-local `watchlist.library_write`, the guards (`library_write_guard`, `b45_show_guard`) read it, and it ends with the transaction. Most functions call `lib_write_on`; a few set the flag themselves. Row security and membership keep accounts apart, and CU2's research guard is separate: none of them read this flag.

**Accepted limitations (owner, 2026-11-01).** This is for trusted people on their own library. It isn't a security boundary between a member and their own records:
- **GraphQL stays disabled, as a standing decision.** `pg_graphql` isn't installed. Enabling it needs a new explicit decision, because the flag lasts for the transaction: one GraphQL request could chain a library function with a direct write on the caller's own rows. Other accounts' rows stay out of reach. W1 closed this and was removed, since GraphQL off already covers it.
- **Direct deletes and some direct updates aren't guarded (item 11, abandoned).** A member's crafted request can delete their own seasons, shows, films, collections, memberships and choices, or change a title, a season's watched, skipped or theme, or a collection's name, skipping checks the page and library functions apply, such as mark counts and the catalog skip-only rule. It can also add a membership to an archived collection. It reaches only their own rows, and backups recover it.

**A TV function can't be reinstalled from `rpc.sql`.** Since Stage 4a it refuses to run, and the sequence once documented for it is unsafe. If a function ever needs reinstalling, write a targeted migration for that function. Never run `rpc.sql` with a client that continues after an error.

## Tests

`test/` is for local runs only: `replica_schema.sql`, `supabase_shim.sql`, `pg_cron_shim.sql`, `m1_test_marker.sql` and the test-only reverse scripts that `tools/db-rehearsal-cu1.mjs` runs. Older rehearsals and self-checks are in git history (`docs/history/DB_SCRIPTS.md` describes them).

Local tools:
- `PGLITE_DIR=<dir> [PG_BIN=<postgres 17 bin>] node tools/q1-test.mjs`: Q1 (queues) on PGlite, and simultaneous saves on real PostgreSQL with `PG_BIN`.
- `PGLITE_DIR=<dir> [PG_BIN=<postgres 17 bin>] node tools/g1-test.mjs`: G1 (games) on PGlite, and simultaneous saves on real PostgreSQL with `PG_BIN`.
- `PGLITE_DIR=<dir> [PG_BIN=<postgres 17 bin>] node tools/tc1-test.mjs`: TC1 (the TMDB cache) on PGlite: writes against the revision the page saw, a row deleted and made again, validation, isolation, the purge, the expiry and restore leaving the cache alone; two simultaneous writes on real PostgreSQL with `PG_BIN`.
- `LOCAL_SERVICE_KEY=<key> node tools/g1-local-api-test.mjs --api http://127.0.0.1:54321 --key <key> --container <db container> --project <a folder under $HOME with the stack's supabase/config.toml>`: G1 through real Auth, PostgREST and the Edge Function runtime (a fake IGDB; Colima mounts only the home folder, so the function's folder must be there).
- `LOCAL_SERVICE_KEY=<key> node tools/q1-local-api-test.mjs --api http://127.0.0.1:54321 --key <key> --container <db container>`: Q1 through real Auth and PostgREST on a fresh local stack.
- `PGLITE_DIR=<dir> [PG_BIN=<postgres 17 bin>] node tools/restore-test.mjs`: the restore suite. Without `PG_BIN` it skips the concurrency and timing checks on real PostgreSQL, with a notice.
- `PGLITE_DIR=<dir> node tools/db-rehearsal-cu1.mjs --backup <format-6 file>`: CU1 through CU1e and CU2. It ends by reversing its migrations, so it tests those historical states, not the final one.
- `PG_BIN=<postgres 17 bin> node tools/db-rehearsal-cu1e-pg.mjs`: real concurrency on a throwaway server.
- `node tools/cu2-local-auth-test.mjs` and `tools/w1-removal-local-test.mjs`: real Auth and PostgREST on a local Supabase stack. The W1 test is historical.
- `PGLITE_DIR=<dir> node tools/db-rehearsal-enrich.mjs --backup <format-5 file> --title <an unmatched show with several seasons>`: the admin enrichment functions at EP1.
- `node tools/m1-synthetic-library.mjs --seed <n> --out <file> --format 5|6|7`: a synthetic library built by the page's own code.
