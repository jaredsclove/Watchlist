# Watchlist Tracker: current state

Read this first in every session. It is the only startup document; keep it short (about 150 lines).
History lives in git and in `docs/history/` (the full handoff up to 2026-10-18). Read history only
when a task needs it. The repo, the deployed site and the production database outrank this file;
report any difference.

**This repo is public.** Keep personal details, machine paths, backup locations, private record
names and evidence hashes out of it.

## The app

A personal TV and film watchlist: a static page on GitHub Pages (`watchlist.html` + classic-script
JS files, no build step) with a Supabase (PostgREST) backend and TMDB for identities and metadata.
Each database has one owner using it from one device at a time. A second user would get their own
database; collaborative editing of a shared database is not a goal.

- **Views:** TV (Currently Watching, All TV, Coming Soon), Movies (All Movies), Collections
  (personal collections: shows, seasons and, since S4, films editable there; Remove from a
  collection with Undo; Add to <collection>…, S5), Settings (Manage collections and watch-with
  choices, Catalog updates, Backup & Restore). ⬇ Backup is also in the header. Since S6 every view
  has a hash route (`#/tv/watching` … `#/collections/<id>`, `#/settings`) and browser Back / Forward work.
- **Data:** `watchlist_items` (seasons and films), `tv_shows`, `custom_collections`,
  `personal_collections`, `collection_memberships`, `watch_with_choices`, `catalog_show_links`,
  `catalog_film_links`. Rows are owner-scoped (`user_id`, never sent by the client).
- **Writes** go mainly through database functions (the `library_*_b45` family, `org_*`,
  `set_season_watched` / `set_season_skipped`, `delete_tv_season`, `restore_backup`). Some take
  `p_expected` values and refuse a stale write; not every path does, so check each one before relying on it.
- **Backup** is format 5 (eight tables, no `user_id`). **Restore** validates the file, checks for
  identity loss, makes and validates a safety backup, then replaces the owner's rows in one
  database transaction and verifies field by field.

## Code map (classic globals; mutable page state is in `watchlist.html`)

| Area | Files |
|---|---|
| Boot, config, API | `watchlist.html`, `config.js`, `api.js` (the writable phase, the stop switch), `write-lane.js` (one change at a time; read freshness), `ui-helpers.js` (incl. dialog keyboard and focus return), `identity.js`, `history.js` (routes, Back / Forward, leave warning) |
| Rendering and views | `render.js`, `tabs.js`, `derived-views.js` (TV views, list focus), `browse-views.js` (collections, All Movies) |
| Writes | `row-actions.js`, `tv-shows.js`, `library.js` (+ Add, writes from views, the movie tools' film row), `metadata.js` (Details) |
| Organization | `organization.js` (reads), `organization-manage.js` (Manage dialog; the membership request, answer and Undo rules both UIs use), `collection-members.js` (Remove / Undo and the Add picker from a collection view) |
| TMDB | `tmdb-match.js`, `tmdb-search.js`, `refresh-shows.js`, `collections-pull.js`, `person-pull.js`, `universe-pull.js` |
| Catalogs | `catalog-apply.js` (Catalog updates); catalog definitions in `config.js` |
| Backup / restore | `backup-restore.js`, `backup-format3.js` (format-3 → 4 → 5 converter) |
| Database | `db/` (migrations, rollbacks, self-checks; run order in `db/README.md`), `docs/STAGE5.md` |
| Tests and tools | `tests/` (offline whole-page harness: `app-harness.js`, `mini-dom.js`, `b45-harness.js`), `tools/` (rehearsals, identity audit) |

Every release bumps the `?v=` cache token in `watchlist.html` (released: `20261018-s4s6`; on the `simplify-batch-b` branch, not released: `20261018-batchb`).
Pages serves files with `max-age=600`; a deployed change can take about 10 minutes to reach a browser.

## Where things stand (2026-10-18)

- **App release:** `f6a81fc`, S4–S6 of the B3 / B1 / B7 plan in one release (PR #2; released
  2026-10-18 UTC; previous release `9487ce8`, simplification Batch A).
  GitHub `main` is the source of truth; check it with `git ls-remote origin main` at the start of a session.
- **Database (as last recorded, not freshly observed):** phase `contracted-b45`, backup format 5,
  recovery archive active. G9 (archive retirement) is paused. Rollbacks follow the recorded order
  (history §18: P1 → P2 → P3′ → D2), each with its own approval; a B4/B5 rollback is lossy.
- **B3 / B1 / B7 plan is complete:** S1–S6 released. S4–S6 (`afaba21` S4, `df69346` S5, `9c3a5f7` S6,
  token and review corrections up to `f6a81fc`) shipped together; PR #2 holds the review, the
  findings' dispositions and the validation limits. D10 is deferred. Release validation: offline
  43 suites, 1,157/1,157 (capped); one independent review (Fable) plus a focused follow-up; bounded
  Claude in Chrome checks on a local synthetic backend (1280 / 375 px; S6 with real Back / Forward,
  reload and direct links); the Pages build and deployment succeeded and 53 deployed responses (the
  page and every referenced file, plain and versioned) were byte-identical to `f6a81fc`. A read-only
  live check passed (owner-approved; non-GET requests refused in the page): the new version loaded;
  routes, real Back / Forward and a reload on a collection route worked; a film's Remove dialog and
  the Add picker opened and were cancelled; only GET requests, no console errors; browser storage
  was unchanged and left as before. No production write.
- **Rollback of S4–S6:** no database migration, but the app's new actions change saved data
  (memberships, film state, deletes, Match, Pull rest), and reverting code doesn't reverse them. The
  stage commits depend on each other: revert the whole set together, newest first, tested like any
  change. It needs its own approval.
- **Simplification Batch A is complete** (A1 `e5cee7b`; A2–A5 `2f3050b` plus review corrections `9487ce8`,
  PR #1).
- **Simplification Batch B: implemented on branch `simplify-batch-b`, not released** (PR #3 holds the B0
  inventory, the changes, the review and the validation limits). B1 retired the pre-B4/B5 phases from
  the app's checks, the harness and the tests (the fail-closed phase check, the stop switch and the
  mismatch notice are unchanged); B2 shares the membership request / answer / Undo rules between Manage
  and the collection view and one dialog keyboard / focus helper; B3 one film-row builder for the movie
  tools; B4 tests and docs. No database change. Merge and release are the owner's decision.
- **Recovery reference (not a recipe):** before and after Batch B, the deployed page meets a rolled-back
  (`contracted`) database the same way: the mismatch notice, no usable list, no backup, every write
  refused; Batch B adds no outage between P2 and P3′. P3′'s verified target stays the application files
  of `aeb9f73` (documentation-only commits excluded); reaching it means removing every application commit
  after `aeb9f73`, which now includes Batch A, S4–S6 and, once released, Batch B. The procedure is the
  owner's (history §18).

## How we work

1. **Claude owns** planning, implementation, testing and routine corrections. The record is git: a
   branch, a reviewable diff and a short closeout (what changed, what was given up, protections
   kept, validation and its limits, open decisions). No briefs, evidence packages, hash manifests or
   line-by-line approval for UI work, refactors or test changes.
2. **One task per session.** Start from this file and a short task prompt. If a session needs
   a context summary, the task was too big; split it.
3. **Explicit owner approval is still required for:** any production access (reads included);
   destructive operations; restore; credentials; changes to `db/`, schema, policies, grants or
   database contracts; removing a safeguard that protects saved data; merging or pushing to `main`;
   deploying; pushing tags. A task prompt may grant some of these for that task.
4. **Independent review is selective.** Claude recommends it, with the concrete risk, for material
   database-contract changes, destructive operations, restore, security or data isolation, removed
   data safeguards, a hard unresolved bug or a specific architectural decision. The owner decides.
   A review covers the completed change once and reports blocking / worth fixing / optional together;
   Claude fixes the findings in one batch; one focused follow-up checks closure. A further round
   needs a stated reason.
5. **Plans** are short (about one page) with at most one revision. Size limits in this file are
   targets, not rules to seek exceptions from.
6. **Escalate** only a material scope change, an unresolved data-integrity risk or an action outside
   the authorization; not routine implementation or test adjustments.

## Durable rules

- Work only in the git checkout, never in loose copies. No history rewrites or force-pushes.
- Keep the architecture: classic globals, inline handlers, page state in `watchlist.html`, no build
  step, modules or framework, unless approved as its own project.
- **Database work** (unchanged from the former handoff §11 rules 4–9):
  - No schema, RLS, identity-rule or backup/restore behaviour change without a written plan approved first.
  - Sequence: read-only audit → proposal → dry run / preflight → **explicit owner approval** →
    execute → verify. Capture the before-state first (affected rows, fingerprints of all relevant
    tables, constraint and index state). Use guarded, single-transaction SQL with row-count
    assertions and a rollback script where appropriate. App writes use guarded filters (id plus
    expected current values).
  - Take and validate a fresh backup before any approved production write or destructive work.
    Never run a destructive restore on production to test it.
  - Never silently fix production data while investigating; report first. If an unexpected material
    issue is found, stop and report before fixing it.
  - Report verification honestly: static inspection, offline tests, local tests, live-page tests
    (page memory or simulated writes) and deployed-site checks are different things.
  - Live testing uses clearly named temporary rows (`ZZ … Test`) or page memory only; record
    temporary ids at creation, change and delete only those ids, and prove production is back to
    baseline. Restore is not a cleanup path once a test row has a TMDB identity. A live test that
    writes needs approval first.
- Built-in catalog dates change only through Catalog updates. `db/rpc.sql` can't reinstall
  functions on the current database. Storage (`collection`) is internal; interface code reaches it
  only through `library.js`.
- **Browser:** never use the built-in preview pane. Browser work, when authorized, uses Claude in
  Chrome. Never type passwords or credentials; tell the owner what to enter and wait.
- **Node tests** always run with a heap cap and a time limit (an uncapped run once crashed the machine):
  `perl -e 'alarm shift; exec @ARGV' 120 node --max-old-space-size=1024 tests/<suite>.test.js`
- `/refresh-catalogs` is user-invoked only.
- When the owner must edit a local file, give a `nano` command, not `open -e`.

## Writes, reads and focus (since Batch A, `9487ce8`)

- **One write lane** (`write-lane.js`): one change at a time per page, from before its optimistic
  redraw until the reread that reconciles it has finished. While it is held the list's controls look
  unavailable (focus kept) and any other change is refused before anything is shown or sent.
  `api.js sbFetch` refuses a write sent outside the lane.
- **Reads** publish only if no change overlapped them (`readFresh`) and they are the newest of their
  kind; a refused read reads again once the lane is free.
- **One reread path** (`reloadOpenView`): a shown list is read again in place. If that reread fails,
  the list stays, marked out of date, and changes from it (Match included) are refused until a read
  succeeds (Retry).
- **Unconfirmed changes:** not confirmed, never resent, the list read again. A fresh read doesn't prove
  the request finished; a request with no clear answer could still complete after a later restore
  (unchanged from before Batch A; no server-completion detection).
- **Collection membership (S4, S5):** Remove / Undo from a collection and each Add or Undo batch are
  one change each through the lane (`{ list: true }`), using the existing `org_*` functions with the
  ids the view read; the collection is read again inside the lane. History traversal only navigates
  (reads); it never writes, resends, retries or undoes. Accepted with the release: the leave warning
  stays registered through a change's reconciling reread (it over-warns, never under-warns); Back
  with an idle Manage that saved changes starts its collection reread before navigating (a wasted read).
- **One focus rule:** a redraw moves focus only if it was in the list (B6 chain F-1…F-7); a filter-row
  redraw keeps the focused control, its value and caret.
- **Accepted limitations (owner-approved with the release):** after a refused change is rolled back,
  focus doesn't return to the control it started from; focus doesn't follow a pending save across the
  phone/desktop switch; opening another view during a change (a long Refresh shows or movie-tool run
  included) shows "Loading…" until the lane is free; Manage has no Stop waiting; watch-with and
  deletes still send no expected values (the lane and the out-of-date pause cover a stale list).
- **Batch A release validation:** offline 40 suites, 1,100/1,100 (capped, each printing its summary);
  one independent review plus a focused follow-up on its three findings; a bounded Claude in Chrome
  check on a local synthetic backend (1280 px; 375 px in a fixed-width frame; light only; no 300 px,
  dark or touch). Release: `main` fast-forwarded to the reviewed `9487ce8`; the Pages build and
  deployment succeeded; the page and the 18 other changed files were byte-identical to the commit
  (plain and versioned URLs). A read-only live smoke check passed with non-GET requests blocked in
  the page: TV, a show expanded, Search, a collection, a show there, Delete… opened and cancelled;
  only GET requests, none blocked, no console errors; the browser's stored preferences were checked
  and left exactly as before. No production write.

## Open items

- **Data access (unverified, needs a separate owner decision):** the page has no sign-in and uses
  the publishable key, and the `db/` scripts give the `anon` role broad table access (recorded
  earlier as an accepted family-app trade-off). Production's current policies have not been checked.
  If they match the scripts, anyone holding the public key can read and change the data. Moving
  configuration or adding sign-in does not by itself close anonymous access; the policies are the
  boundary. The read-only policy check needs its own authorization.
- **Optional, not scheduled:** phone controls under 44 px (status select, Show ended, Skip).
- The rest of the backlog (accessibility, contrast and layout items; deferred features) is in
  history §14. Bring an item back only by owner request.

## Tests

```bash
for f in tests/*.test.js tests/*.test.mjs; do perl -e 'alarm shift; exec @ARGV' 120 node --max-old-space-size=1024 "$f" || echo "FAIL $f"; done
```

At `9487ce8`: 40 suites, 1,100 cases, all passing (Batch A removed the focus matrices and
publication-number tests; `tests/write-lane.test.js` is new). At `f6a81fc`: 43 suites, 1,157 cases
(`collection-films`, `collection-add`, `history-routes` are new; the harness has an opt-in session
history, `routes: {}`). On `simplify-batch-b` (not released): 43 suites, 1,153 cases. The harness models
B4/B5, a rolled-back (5c) database, no Stage 5 and an unknown phase only (no older stages, no loading of
earlier releases); `b45-compat` keeps C2 and the stop-until-reload cases. `catalog-apply` waits for the
dialog's state instead of a fixed number of turns, so its load flake is fixed on the branch (at
`f6a81fc` and earlier, rerun it alone before treating a failure as a regression). Check that every suite prints its
"N/N passed" line: a suite can exit 0 without it. Syntax check:
`node --check` on each `*.js`, `tests/*.js`, `tools/*.mjs`. Database rehearsals run locally on PGlite
(`tools/db-rehearsal-*.mjs`; see `db/README.md`). The identity audit (`tools/identity-audit.mjs`)
reads production, so it needs approval.
