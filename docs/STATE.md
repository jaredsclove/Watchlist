# Watchlist Tracker: current state

Read this first in every session. It is the only startup document; keep it short.
History lives in git and in `docs/history/` (the full handoff up to 2026-10-18). Read history only
when a task needs it. The repo, the deployed site and the production database outrank this file;
report any difference.

**This repo is public.** Keep personal details, machine paths, backup locations, private record
names and evidence hashes out of it.

## The app

A personal TV and film watchlist: a static page on GitHub Pages (`watchlist.html` + classic-script
JS files, no build step) with a Supabase (PostgREST) backend and TMDB for identities and metadata.
Members sign in with an email and a password (accounts are created by the library owner; there is no
public sign-up). Each member's library is theirs alone: the database allows a signed-in member only their
own rows, and nothing to anyone signed out. Collaborative editing of a shared library is not a goal.

- **Views:** TV (Currently Watching, All TV, Coming Soon), Movies (All Movies), Collections
  (personal collections: shows, seasons and, since S4, films editable there; Remove from a
  collection with Undo; Add to <collection>…, S5), Settings (Manage collections and watch-with
  choices, Catalog updates, Backup & Restore). ⬇ Backup is also in the header. Since S6 every view
  has a hash route (`#/tv/watching` … `#/collections/<id>`, `#/settings`) and browser Back / Forward work.
- **Data:** `watchlist_items` (seasons and films), `tv_shows`, `custom_collections`,
  `personal_collections`, `collection_memberships`, `watch_with_choices`, `catalog_show_links`,
  `catalog_film_links`. Rows are owner-scoped: `user_id` is the signed-in member (`auth.uid()`), never sent
  by the client; membership is `private.library_members`.
- **Writes** go mainly through database functions (the `library_*_b45` family, `org_*`,
  `set_season_watched` / `set_season_skipped`, `delete_tv_season`, `restore_backup`). Some take
  `p_expected` values and refuse a stale write; not every path does, so check each one before relying on it.
- **Backup** is format 5 (eight tables, no `user_id`). **Restore** validates the file, checks for
  identity loss, makes and validates a safety backup, then replaces the owner's rows in one
  database transaction and verifies field by field.

## Code map (classic globals; mutable page state is in `watchlist.html`)

| Area | Files |
|---|---|
| Boot, config, API | `watchlist.html`, `config.js`, `auth.js` (sign-in, the bound account, per-account storage, Account controls, pending notes), `api.js` (the writable phase, the stop switch), `write-lane.js` (one change at a time; read freshness), `ui-helpers.js` (incl. dialog keyboard and focus return), `identity.js`, `history.js` (routes, Back / Forward, leave warning) |
| Rendering and views | `render.js`, `tabs.js`, `derived-views.js` (TV views, list focus), `browse-views.js` (collections, All Movies) |
| Writes | `row-actions.js`, `tv-shows.js`, `library.js` (+ Add, writes from views, the movie tools' film row), `metadata.js` (Details) |
| Organization | `organization.js` (reads), `organization-manage.js` (Manage dialog; the membership request, answer and Undo rules both UIs use), `collection-members.js` (Remove / Undo and the Add picker from a collection view) |
| TMDB | `tmdb-match.js`, `tmdb-search.js`, `refresh-shows.js`, `collections-pull.js`, `person-pull.js`, `universe-pull.js` |
| Catalogs | `catalog-apply.js` (Catalog updates); catalog definitions in `config.js` |
| Backup / restore | `backup-restore.js`, `backup-format3.js` (format-3 → 4 → 5 converter) |
| Database | `db/` (migrations, rollbacks, self-checks; run order in `db/README.md`), `docs/STAGE5.md` |
| Tests and tools | `tests/` (offline whole-page harness: `app-harness.js`, `mini-dom.js`, `b45-harness.js`), `tools/` (rehearsals, identity audit) |

Every release bumps the `?v=` cache token in `watchlist.html` (current: `20261019-m1`). The tests
check only that all 26 versioned files share one token; before releasing, check that it differs from
the previous release's: `git show <previous release>:watchlist.html | grep -oE '[?]v=[A-Za-z0-9_-]+' | sort -u`.
Pages serves files with `max-age=600`; a deployed change can take about 10 minutes to reach a browser.

## Where things stand (2026-10-20)

GitHub `main` is the source of truth; check it with `git ls-remote origin main` at the start of a session.
Each release's PR holds its review, validation and limits: Batch A [#1], S4–S6 [#2], Batch B [#3],
test runner and token check [#4], M1 sign-in and owner-only access [#7].

- **App release:** `502570a`, M1 sign-in and owner-only access (PR #7), released 2026-10-20: `db/m1_access.sql`
  applied to production once (its run record confirmed by a separate read), then the page deployed. Verified after
  deployment: the owner signs in on the deployed page; a backup made then is identical, table by table, to the one
  made just before the migration; signed-out requests to tables, views, functions and GraphQL are refused.
- **Database (as last recorded, not freshly observed):** phase `contracted-b45` with M1 owner-only access
  (`access = members`), backup format 5, recovery archive active. G9 (archive retirement) is paused.
  **Repairs are fix-forward:** the B4/B5 and D2 rollbacks are retired (they refuse against the M1 state),
  and reopening anonymous access is never a recovery step. Data recovery is a format-5 restore through
  the signed-in page, or `docs/ADMIN_RESTORE.md`; accounts, `docs/MEMBER_RECOVERY.md`.
- **Done:** the B3 / B1 / B7 plan (S1–S6; D10 deferred), simplification Batches A and B.
- **Reverting releases** (each needs its own approval, tested like any change):
  - S4–S6: no database migration, but the app's actions change saved data (memberships, film state,
    deletes, Match, Pull rest) and reverting code doesn't reverse them. The stage commits depend on each
    other: revert the set together, newest first.
  - Batch B: no saved-data effect; a code revert of its commits, newest first.
  - M1: not revertible by a code revert. Earlier pages can't use the locked database (they fail closed:
    writes refused, reads error); repairs are fix-forward.
- **Recovery reference before M1 (historical; those rollbacks are now retired):** the deployed page meets a rolled-back (`contracted`) database
  with the mismatch notice, no usable list, no backup and every write refused. P3′'s verified target is
  the application files of `aeb9f73` (documentation-only commits excluded); reaching it means removing
  every application commit after `aeb9f73` (now including Batch A, S4–S6 and Batch B). The procedure is
  the owner's (history §18).

[#1]: https://github.com/jaredsclove/Watchlist/pull/1
[#2]: https://github.com/jaredsclove/Watchlist/pull/2
[#3]: https://github.com/jaredsclove/Watchlist/pull/3
[#4]: https://github.com/jaredsclove/Watchlist/pull/4
[#7]: https://github.com/jaredsclove/Watchlist/pull/7

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
  (reads); it never writes, resends, retries or undoes. Accepted (S4–S6): the leave warning
  stays registered through a change's reconciling reread (it over-warns, never under-warns); Back
  with an idle Manage that saved changes starts its collection reread before navigating (a wasted read).
- **One focus rule:** a redraw moves focus only if it was in the list (B6 chain F-1…F-7); a filter-row
  redraw keeps the focused control, its value and caret.
- **Accepted limitations (Batch A):** after a refused change is rolled back,
  focus doesn't return to the control it started from; focus doesn't follow a pending save across the
  phone/desktop switch; opening another view during a change (a long Refresh shows or movie-tool run
  included) shows "Loading…" until the lane is free; Manage has no Stop waiting; watch-with and
  deletes still send no expected values (the lane and the out-of-date pause cover a stale list).

## Open items

- **Access (M1):** signed-out callers get nothing (no table, view or function; the `db/` scripts before
  M1 granted `anon` broad access, which M1 removes). Default privileges owned by `supabase_admin` can't
  be changed by `postgres`, so every later migration revokes from `anon` explicitly and verifies before
  commit. Deleting a removed member's library is deferred (`docs/MEMBER_RECOVERY.md`).
- **Optional, not scheduled:** phone controls under 44 px (status select, Show ended, Skip); on an
  unknown database phase, a refused season toggle shows the raw refusal text (`Supabase error 412: {…}`)
  instead of a sentence (polish, not a blocker).
- **Deferred (owner, 2026-10-18):** archiving the historical `db/` and `tools/` scripts. They stay
  unchanged unless their presence causes a concrete maintenance problem.
- The rest of the backlog (accessibility, contrast and layout items; deferred features) is in
  history §14. Bring an item back only by owner request.

## Tests

```bash
tests/run.sh
```

It runs every `tests/*.test.js` and `tests/*.test.mjs` with the caps above (120 s, 1024 MB) and fails a
suite that exits non-zero, is killed by the time limit (or a signal), or whose last "N/N passed" line is
missing or has unequal numbers (an incomplete run that exits 0). It prints one line per suite (a
failure gives the reason, exit status and last summary line) and `suites=N failing=N cases=P/T`, and
exits non-zero if any suite failed. `tests/run.sh tests/<suite>.test.js` runs only the suites named.

The harness models B4/B5, a rolled-back (5c) database, no Stage 5 and an unknown phase only; its
session history is opt-in (`routes: {}`). `b45-compat` keeps C2 and the stop-until-reload cases. Syntax check:
`node --check` on each `*.js`, `tests/*.js`, `tools/*.mjs`. Database rehearsals run locally on PGlite
(`tools/db-rehearsal-*.mjs`; see `db/README.md`). The identity audit (`tools/identity-audit.mjs`)
reads production, so it needs approval.
