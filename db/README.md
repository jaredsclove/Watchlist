# Database scripts

Migrations run as `postgres` in the Supabase SQL Editor, and every production step needs explicit approval and a validated backup first. The
release tiers are in `docs/STATE.md`. What each script did when it ran, and the older rehearsals: `docs/history/DB_SCRIPTS.md`.

**Current production state:** phase `contracted-cu1`, backup format 7, `access = members`, through CU1e and W1's removal. The recovery archive is
present and unused. There is no schema rollback, and none of the old rollback scripts can run against this state: repairs are fix-forward, and
data recovery is a format-7 restore through the page or `docs/ADMIN_RESTORE.md`.

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
| Prepared, **not run in production** | `simplify_restore_cleanup.sql` (`watchlist.simplify_run`): one flat `restore_backup`, the old chain, 36 dormant functions and the six archive and rollback tables removed. `simplify_preflight.sql` is its read-only check and the private archive export. Local builds include it through `tools/restore-fixture.mjs` |

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

`test/` is for local runs only: `replica_schema.sql`, `supabase_shim.sql`, `m1_test_marker.sql` and the test-only reverse scripts that `tools/db-rehearsal-cu1.mjs` runs. Older rehearsals and self-checks are in git history (`docs/history/DB_SCRIPTS.md` describes them).

Local tools:
- `PGLITE_DIR=<dir> [PG_BIN=<postgres 17 bin>] node tools/restore-test.mjs`: the restore suite. Without `PG_BIN` it skips the concurrency and timing checks on real PostgreSQL, with a notice.
- `PGLITE_DIR=<dir> node tools/db-rehearsal-cu1.mjs --backup <format-6 file>`: CU1 through CU1e and CU2. It ends by reversing its migrations, so it tests those historical states, not the final one.
- `PG_BIN=<postgres 17 bin> node tools/db-rehearsal-cu1e-pg.mjs`: real concurrency on a throwaway server.
- `node tools/cu2-local-auth-test.mjs` and `tools/w1-removal-local-test.mjs`: real Auth and PostgREST on a local Supabase stack. The W1 test is historical.
- `PGLITE_DIR=<dir> node tools/db-rehearsal-enrich.mjs --backup <format-5 file> --title <an unmatched show with several seasons>`: the admin enrichment functions at EP1.
- `node tools/m1-synthetic-library.mjs --seed <n> --out <file> --format 5|6|7`: a synthetic library built by the page's own code.
