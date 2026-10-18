# Stage 5 — the library without storage

Stage 5 removes "storage" (`watchlist_items.collection`, `tv_shows.collection`,
`personal_collections.legacy_source`, `othertv_shows`) as a concept. What decided how a
record may be edited becomes **catalog governance** (the built-in catalog that governs a
record), and what a film's theme means becomes **`theme_kind`** (`genre` or `other`).
Personal collections stay many-to-many and independent of governance.

This file is the implementation contract for the G1 implementation. `docs/STATE.md`
is the current project state; nothing here authorizes a production step.

**Status (2026-10-14).** Stage 5 ran through 5c and its clean-up (G8); the phase-specific statements below describe
Stage 5 as implemented and are **historical** unless marked "since B4/B5". Since then **B4/B5 Batch A** (database
`db/b45_expand.sql`, page `cb0d43d`, 2026-10-14) changed the phase to **`contracted-b45`**, with **backup format 5**
(format-4 and format-3 files are converted in the restore preview). The **recovery archive remains active**.
**G9 (archive retirement) is PAUSED** (owner decision, 2026-10-13: keep rollback available): its earlier brief was
written against the pre-B4/B5 state, so its pins are stale, and any resumption needs a revised brief and separate
approvals. B4/B5 details: `docs/history/HANDOFF-2026-10-18.md` §4g and §18; scripts: `db/README.md`.

## Phases

| Phase | What runs | Database | Page |
|---|---|---|---|
| 5.0 | baseline (Stage 4b) | storage | Stage 4b |
| 5a | `db/phase5a_expand.sql` | storage is the source of truth; read views derived from it; `library_*` functions; identity indexes; `stage5_capabilities()` → `coexistence` | Stage 4b pages keep working, except a catalog **apply** (refused, `client_outdated`) |
| 5b | the Stage 5 page | unchanged | storage-free page; backups stay format 3 |
| soak | at least 48 hours after 5b is verified (elapsed time alone authorizes nothing) | | |
| 5c | `db/phase5c_contract.sql` | governance tables, `theme_kind`, `catalog_id`, guards, recovery archive; storage dropped; `stage5_capabilities()` → `contracted` | backups format 4; old pages refused (`client_outdated`) |
| 5c clean-up (G8) | the page only (`aeb9f73`, released 2026-10-12) | unchanged | format-3 export and direct format-3 restore removed; backup and restore only on a `contracted` database (format 4); the explicit format-3 → 4 converter kept indefinitely |
| B4/B5 Batch A (since 2026-10-14, current) | `db/b45_expand.sql` with the owner-choice preamble; the page `cb0d43d` | status, priority, Show ended, markers, provenance, categorized metadata (existing records initialized empty; no legacy theme mapped) and the earlier-seasons range; `_b45` functions, the changed names `client_outdated` stubs; `restore_backup` format 5; `stage5_capabilities()` → `contracted-b45`; archive active | backups format 5; format 4 and format 3 converted in the preview; old pages keep only the supported id-based edits |
| later | archive retirement (G9) | **paused**; a separate, explicit approval with a revised brief, only after backup/restore and recovery verification and the owner's decision to relinquish rollback | |

Rollbacks: `db/rollback/phase5a.sql` (to Stage 4b exactly; bound to the G3 baseline inventory, plan §3(b): it
refuses without it and aborts unless the restored `catalog_apply` and function inventory equal it — `db/README.md`),
`db/rollback/phase5c.sql`
(to coexistence while the recovery archive exists; fix-forward only once it is retired).

**Since B4/B5, `db/rollback/phase5c.sql` refuses while B4/B5 is installed** (phase ≠ `contracted`); it can't run
against the current state. Recovery from the current state, each step separately approved: (1) a fresh format-5
backup made by the B4/B5 page, validated (P1); (2) the B4/B5 rollback: the dry-run report
(`db/rollback/b45_report.sql`) with its loss disclosures, the P1 association and the report-bound approval naming
the report, the P1 file and any accepted loss (`tools/b45-backup-digest.mjs`), then `db/rollback/b45.sql` and its
verification against the stored pre-B4/B5 baseline; (3) revert the B4/B5 app commits so the page is the G8 app
again, verify on Pages and reload every page; (4) only then the D2 sequence described below (5b app, format-4
backup, `db/rollback/phase5c.sql`, format-3 backup). Details: `db/README.md`, `docs/history/HANDOFF-2026-10-18.md` §18.

## The write boundary (U4)

All library functions are `SECURITY INVOKER` with an empty `search_path`; no Stage 5
function is `SECURITY DEFINER`. In 5c, column grants allow what those functions write, and
guard triggers refuse those writes unless the transaction set `watchlist.library_write`
(only `private.lib_write_on()`, called by the library functions, restore and approved
admin scripts, sets it). This is not a security boundary against someone with the anon key
and raw SQL access; it keeps old pages and accidental direct writes from changing identity,
governance or theme meaning. Sign-in is out of scope.

## G1 contract clarifications

### 1. Rollback fidelity (`db/rollback/phase5c.sql`)

Preserved exactly: every record, show, membership, personal collection, watch-with choice
and person collection with every field, id and `created_at`; each record's governing
catalog (as its storage); `othertv_shows` row for row from the archive; `legacy_source` for
every collection that existed at contraction (True Crime / Docs included; it must agree with
the collection's `catalog_id` and `presentation_key`).

Discarded, and listed in the report the rollback returns: the governance links' own `id`,
`origin` and `created_at` (Stage 5a has no place for them; the report lists every link
exactly); `theme_kind`, `catalog_id` and `presentation_key` (only after each is checked to
equal what the restored storage says); the archive itself.

Records created after the contraction have no archive entry and get a deterministic
storage: governed → its catalog; an ungoverned show → the one storage its archived seasons
share (a Match made it from rows kept there, as Stage 5a does), else `othertv`; an
ungoverned film → `movies` when its theme is a genre, else `othertv`; a season → its show's. The report
counts them (`records_by_rule`).

Personal collections created after the contraction have no archive entry: their
`legacy_source` becomes their `presentation_key` (null when they have none; it equals
`catalog_id` whenever both are set). The report counts
them (`collections_without_archive_entry`).

The rollback refuses, changing nothing, when Stage 5a can't represent the state: two
unmatched shows (or two unidentified rows) that would share a key in one storage — for
example two same-named shows created on purpose after the contraction (`distinct_from`);
archived storage that disagrees with governance or theme meaning; a governance key that
differs from its record's key; a `legacy_source` that would repeat. Once the archive is
retired it refuses everything: recovery is fix-forward.

(As of G8; since B4/B5 the following steps come only after the B4/B5 rollback and the B4/B5 app reversion, above.)
After a rollback, format-4 backups can't be restored (Stage 5a takes format 3): take a
format-3 backup right after the rollback. Since the 5c clean-up (G8, `aeb9f73`) the deployed
page makes and restores backups only on a contracted database, so it can't take that
format-3 backup: before any separately approved 5c rollback, restore the 5b app first
(revert the G8 commit) and verify it on Pages, then take a format-4 backup with it, run the
rollback, and take the format-3 backup with the 5b page immediately. A converted format-3 restore made while
contracted records its own archive (`origin: converted_restore`), so a later rollback
recovers that file's storage.

### 2. Catalog concurrency

A catalog application (`library_catalog_apply` → `private.catalog_run5`) takes
`tv_shows` and `watchlist_items` in EXCLUSIVE mode before it reads anything. Every library
write (`library_add_seasons`, `library_create_show`, `library_add_films`,
`library_create_film`, `library_match_season`, `library_match_film`) first calls
`private.lib_write_on()`, which takes the same two tables, in the same order, in ROW
EXCLUSIVE mode — conflicting with the catalog's lock and with no other write. A library
write and a catalog application therefore never interleave; whichever runs second reads,
under READ COMMITTED, the other's committed records:

- a creation or Match first, then the catalog: the new or changed record is a candidate
  (same key or same normalized title, not governed by that catalog), so the catalog entry is
  excluded as `existing_record` (one candidate) or `ambiguous` (several), with the candidate
  ids; it is never adopted, merged, re-governed or duplicated (U7);
- the catalog first, then a creation the page prepared earlier: a governed record with the
  same key or the same normalized title is not in the page's `distinct_from`, so the
  creation is refused (`catalog_candidate`, with the candidates; see 7 below); a Match into
  the catalog's show is refused (`match_target_governed`, U1).

Two creations of the same unmatched key are also serialized by a per-key advisory lock.
The locks are taken before any read in each function (checked statically and by the held
locks in `db/test/t_5a_expand.sql`). A library write waiting on a catalog application is
bounded by the statement timeout; the page reports a timeout as "didn't finish in time,
nothing was added". The catalog side keeps Stage 4a's 2-second lock timeout
(`catalog_busy`).

Operations on one TMDB show identity are serialized as well (C3 correction, 2026-10-10;
the G2 hosted run had shown a season Match failing with a raw unique-index error after
waiting on a concurrent creation). `library_create_show` (when the show has a TMDB id) and
`library_match_season` take a per-identity transaction lock — `pg_advisory_xact_lock` on
`hashtext(owner || '|tvid|' || tmdb_id)` — after `lib_write_on()` and before any read of the
target, in both phases (both functions come from 5a; 5c doesn't redefine them). Whichever
runs second resolves the target from the other's committed result:

- a Match after a creation (or after another Match) of its identity joins that show; the
  existing rules apply to it unchanged — the status block, `match_target_governed`, catalog
  twins, `match_conflict` for a season the show already holds, and the collection-expansion
  confirmation (the answer is `blocked` with a confirmation token and nothing is written
  until the page confirms; the confirmed Match then joins and carries the collections);
- a creation after a Match that promoted its own single-season show onto the identity, or
  inserted a new show for it, is refused `show_exists`;
- a wait ends at the statement timeout (57014) with nothing of the waiting call written.

This was verified locally with two real sessions and lock samples on PostgreSQL 17.11 (both
orders, coexistence and contracted; promotion and new-show insertion; Match × Match;
a genuine season conflict; cancellation) — see `db/test/t_5a_expand.sql` /
`t_5c_contract.sql` for the single-session checks; the hosted check is G2. The Stage 4b-era
RPCs (`add_tv_seasons`, `create_tv_show`, `match_tv_row`) do not take this lock and are
unchanged during coexistence, as the coexistence contract requires: an old page and a new
page acting on one identity at the same moment are protected only by the unique index (an
old-page addition racing a new-page creation still yields one show, `show_exists` or the
old call's "existing" answer).

Locally (PGlite, one session) only the two serial orders can be shown. The real-session
specification (G2) is under "G2 requirements" below.

### 3. Phase transitions (5a ⇄ 5c while something is being prepared)

- **Backup**: the format is read before and after the table reads; a change in between,
  or a table read refused because the update removed a column, gives no file and the
  message "The database was updated while the backup was being read, so no file was made."
  If the phase can't be read at all, no file is made (never a guessed format). Since the
  5c clean-up (G8) a backup is made only on a `contracted` database (format 4); on any other
  phase, or without the capability, no file is made and no table is read. Since B4/B5 the
  page makes backups only at `contracted-b45` (format 5).
- **Restore**: the preview pins the database's format; the safety backup must still be in
  that format, or the restore is aborted before any download or restore call. A document
  sent after a transition is refused by `restore_backup` itself (format 3 on a contracted
  database, format 4 before contraction): one call, never converted or resent
  automatically, and the safety file is named. Since the 5c clean-up (G8) a restore is
  offered only on a `contracted` database; a format-3 file is restored only through the
  explicit conversion. Since B4/B5 restore is offered only at `contracted-b45` and sends only
  format 5 (format 4 converted 4 → 5, format 3 converted 3 → 4 → 5).
- **Writes**: every `library_*` function has the same signature and answers in both phases,
  so a write prepared in 5a and sent after 5c succeeds or is refused with a stated reason;
  the page never falls back to an older function. An unclear answer is reported as
  unconfirmed and never resent.
- **Startup**: the page reads `stage5_capabilities()` once with GET; a database without it
  shows its own notice (`#phaseBanner`), which no view's message replaces.

### 4. `othertv_shows`

Dropping it at contraction is the target. Inside `db/phase5c_contract.sql`, the drop only
happens after the archive is checked to be an exact copy (every row and column, by set
equality), together with every record's and collection's storage. Before 5c runs, exact
recovery must be rehearsed on the fresh pre-contraction backup
(`tools/db-rehearsal-5.mjs`: "rollback of 5c right after the contraction: exact recovery
from the archive"). If that rehearsal fails, the contraction is **blocked**: there is no
variant of 5c that keeps the table, and it is not run.

### 5. Phase gate (the page)

The page writes only after `stage5_capabilities()` has answered with a phase it can write
to (`coexistence` or `contracted`). Until then every non-GET request is refused in the page
(`update_required`: "This page needs a database update that hasn’t been made yet, so nothing was changed."), a
catalog application reports the update as missing, and a restore preview is not offered.
Before `restore_backup` is sent, the capability is read again: the document's format must
still be the database's (format 4 ⇔ contracted, else format 3), or nothing is sent ("Restore
not sent …"). Since the 5c clean-up (G8) the phase must be `contracted` and the document
format 4; nothing else is ever sent. Since B4/B5 the phase must be `contracted-b45` and the
document format 5, and a missing `_b45` function or B4/B5 column stops the page until reload.

### 6. Governance in the page

What the page knows about governance (and so the × action and Match eligibility) comes
from the newest governance read of the current restore epoch. A read publishes only if it
is newer than what is published and started in the current epoch; an older read finishing
late (after another library read, a view read, a navigation, a closed panel or a restore)
never replaces it. A restore resets it. A record that no published read covers (it appeared
after that read, or no read finished since a restore) is treated as unknown: × deletes
nothing and says so, and Match isn't offered, until a read covers it.

### 7. Catalog collisions (U7, both orders)

A record a catalog governs and a record the user creates are never merged, adopted or
silently duplicated, whichever comes first:

- user record first, catalog second: the catalog entry is excluded (`existing_record` /
  `ambiguous`, with the candidate ids), as above;
- catalog first, user record second: `library_create_show` (identified or not),
  `library_create_film`, `library_add_films` (per film, outcome `catalog_candidate`), a
  season Match that creates a show (`library_match_season` when no show has that TMDB id:
  the new show's key is its normalized title) and a film Match (`library_match_film`: the
  matched film's new key and title) refuse a record whose key or normalized title equals a
  governed record's, unless that record's id is in `distinct_from` (`catalog_candidate`, with
  the candidate ids). Both Match functions read `distinct_from` from the patch for this check
  and never store it.

What the page does with the candidates:

- additions (+ Add): the preview lists the similar records it read; "Add as a new show" /
  "film" sends their ids; a candidate that appears after the preview is never acknowledged
  silently ("Your list changed since this preview");
- Match: the page reads every candidate the database named (GET, with the catalog that
  governs it) and shows each one (title, date for a film, TMDB id or "not matched to TMDB",
  its catalog, and whether it shares the name or only the key) beside the proposed target
  (TMDB id and season). "Different — match anyway" is offered only once every candidate was
  read and is governed by a catalog; a failed or incomplete read offers Retry (read-only)
  instead. The confirmation sends exactly the ids shown, for that target only; if the
  database then names a record not shown, all of them are shown again for a new
  confirmation, never resent automatically.

Explicitly confirmed distinct same-title works stay distinct: a record created or matched
with the governed record in `distinct_from` is kept as its own record, the catalog never
adopts it, and later catalog applications exclude it as an existing record.

## Behavior changes and known limitations

New in Stage 5 (owner decisions recorded):

- **True Crime / Docs** keeps its note ("not yet classified separately") and its saved device
  layout key (`watchlist_browse_layout_truecrime`) through a presentation key, independent of
  storage routing and governance: in 5a the read view `library_collection_presentation`
  derives it from `legacy_source`; 5c stores it (`personal_collections.presentation_key`,
  one of `disney`, `90day`, `sheridan`, `truecrime`, unique per owner, equal to
  `catalog_id` when both are set), format 4 carries it and the format-3 converter sets it
  from `legacy_source`. True Crime / Docs governs nothing.
- **A film whose theme is a genre can't be matched to a TV season**, in both phases, as in
  Stage 4b (`genre_film_season`; the page says so before sending). A film whose theme isn't
  a genre (True Crime / Docs) can be.
- **Same-title works**: see 7 above (the creation is refused until the
  user confirms they are different).
- **Coexistence (5a) limit** that lifts at contraction: a same-key unmatched show already
  where new shows are stored stays one show even with `distinct_from`.
- **Match** searches films first for a film row and series first otherwise (by the row's
  kind, not by storage); a film's genre theme follows `theme_kind`. The `'mixed'` search
  mode in `tmdb-search.js` (the former True Crime / Docs tab's split) is no longer chosen by
  any caller; it is left in place (removal is separate clean-up).
- **Match refresh**: its obligation now covers the whole library (one partition, not a
  tab), and the show list is always part of it (the show read was already issued). Its own
  reads (and Retry, GET only) complete it.

Pre-existing view limitations (Stage 4b views already behaved this way; not new in Stage 5,
and not fixed here):

- A view's own read that overlapped an edit or a Match can redraw the value from before the
  edit until the view is read again (the saved value is unaffected). Only the storage tabs
  had a protected cache, and they are removed; their tests didn't cover views.
- A view's read never completed a Match refresh; it still doesn't.

Pre-existing risks noticed in review, unchanged by Stage 5:

- Restore reports "nothing was changed" for any failed response, including a lost reply
  after a committed transaction (an unknown outcome).
- A backup is several reads, not one transactional snapshot.
- A restore document repeating an id is refused as `restore_id_collision` (its existing
  wording).
- **All Movies' watch-with filter** lists the values in use and needs no choice list; when
  choices can't be loaded, each film's picker says so with Retry.
- **Catalog read-back**: a record moved out of what the catalog governs reads back as
  "not found" (a difference), never as verified.
- `config.js` still declares an unused `BACKUP_TABLES` (it names `othertv_shows`); it was
  unused before Stage 5 and is left for the catalog-source owner.

## Tests

- Offline (whole-page harness): every suite in `tests/`. `tests/stage5-app.test.js` covers
  the phase read and gate, the request and source scans (A13, page side), contracted flows,
  format 4 and the format-3 conversion (presentation keys included), phase transitions, the
  U1 / U7 behavior, catalog collisions in both orders and True Crime / Docs in both phases;
  `tests/governance.test.js` covers governance publication (overlapping and late reads,
  navigation, restore, uncovered rows). Twelve tests of the removed storage tabs were
  retired (listed in `tests/match-expansion.test.js`); "a newer Match of the same row
  doesn't retire the refresh's own read" was ported to the view. The 5c clean-up (G8) added
  `stage5-app` cases for backup and restore outside `contracted` (no file, no format probe,
  nothing sent), the format-4-only send, a converter refusal and a converted-document
  validation failure; format 1–3 files in tests come from a test-only fixture builder
  (`legacyBackupFixture` in `tests/app-harness.js`).
- Database (PGlite, one session): `db/test/t_5a_expand.sql`, `db/test/t_5c_contract.sql`
  (restore refusals each start from a valid document and change one thing; the recovery
  section, archive hashes, the classification CHECK, presentation keys and catalog
  collisions in both orders); the full rehearsal `tools/db-rehearsal-5.mjs` (see
  `db/README.md`), on every retained format-3 backup. The rehearsal adds three synthetic
  records with fixed ids to each replica, so its Match / rollback branches never depend on
  what a backup contains; checks that use a backup's own records say so. It also injects a
  failure before every top-level statement of each of the four scripts (and after `begin`,
  before `commit`), proves each injected error was the one raised, and compares the complete
  state afterwards (catalog, owners, ACLs, every row of every public and private table with
  its owner, the archive, the session's write flag), with a control showing that a partial
  commit is detected. This shows that each script's single transaction leaves nothing behind
  when it is abandoned after an error; that the Supabase SQL Editor abandons (never commits)
  a script that failed partway is checked in G2. A format-3 restore during coexistence that
  changes ids and storage is followed by contraction and an exact rollback.
- Not covered locally: two sessions (any concurrency), real PostgREST and hosted roles, old
  pages against a real deployment, a phone.

## G2 requirements (not done in G1)

A7 (old pages against each phase on a real deployment) and A12 (privileges on the hosted
roles) have **not** passed; G1 only checked the local equivalents. G2 needs a disposable
Postgres with PostgREST semantics and at least two real client sessions, e.g. a hosted
test project or a local Supabase stack, plus a real browser:

1. Two-session catalog concurrency, each started in both orders and with the second
   statement issued while the first is still open:
   - `library_catalog_apply` vs `library_create_show` (no identity) for the catalog show's
     key, and for an unrelated key with the same normalized title;
   - `library_catalog_apply` vs `library_create_film` for the catalog film's key and title;
   - `library_catalog_apply` vs `library_match_season` / `library_match_film` turning an
     unmatched record into a candidate;
   - two `library_create_show` calls for the same unmatched key;
   - `library_create_show` vs `library_match_season` creating the same show identity;
   - two `library_match_season` calls for different seasons of a TMDB show that doesn't
     exist yet (each looks up the target, then inserts or updates: ROW EXCLUSIVE locks don't
     serialize two library writers, so both must join one show, or one must be refused with
     a stated reason — a unique-index error alone is not acceptable evidence; since the C3
     correction both serialize on the identity lock, see §2 — verified locally, hosted
     pending);
   - a membership change vs a Match of the same record (memberships carried over);
   - additions, deletions and Matches vs a restore;
   - expected: never two unidentified records with one key; the catalog entry excluded with
     the candidate's id, or the creation refused; no deadlock other than a reported
     `catalog_busy` / timeout; nothing partial; the page's messages as in the harness.
2. Phase transitions with a real page open: 5a applied while a backup, a restore preview
   and an addition are in progress; 5c applied likewise; then the same with the rollbacks.
3. A7 matrix: a Stage 4b page and a Stage 5 page against 4b, 5a, 5c and after each rollback
   (reads, additions, Match, catalog preview/apply, backup, restore).
4. A12: the hosted `anon` / `authenticated` grants, row security on the link tables, the
   private schema not exposed through the API, the guard triggers.
5. A browser check of the Stage 5 page at desktop and phone width on each phase.
6. The SQL Editor (the way scripts are run) with a failure injected partway through a script
   on the disposable database: nothing committed, nothing left behind.
