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
  (personal collections; TV shows and seasons editable there since S3, films read-only), Settings
  (Manage collections and watch-with choices, Catalog updates, Backup & Restore). ⬇ Backup is also
  in the header.
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
| Boot, config, API | `watchlist.html`, `config.js`, `api.js`, `ui-helpers.js`, `identity.js` |
| Rendering and views | `render.js`, `tabs.js`, `derived-views.js` (TV views, list focus), `browse-views.js` (collections, All Movies) |
| Writes | `row-actions.js`, `tv-shows.js`, `library.js` (+ Add, writes from views), `metadata.js` (Details) |
| Organization | `organization.js` (reads), `organization-manage.js` (Manage dialog) |
| TMDB | `tmdb-match.js`, `tmdb-search.js`, `refresh-shows.js`, `collections-pull.js`, `person-pull.js`, `universe-pull.js` |
| Catalogs | `catalog-apply.js` (Catalog updates); catalog definitions in `config.js` |
| Backup / restore | `backup-restore.js`, `backup-format3.js` (format-3 → 4 → 5 converter) |
| Database | `db/` (migrations, rollbacks, self-checks; run order in `db/README.md`), `docs/STAGE5.md` |
| Tests and tools | `tests/` (offline whole-page harness: `app-harness.js`, `mini-dom.js`, `b45-harness.js`), `tools/` (rehearsals, identity audit) |

Every release bumps the `?v=` cache token in `watchlist.html` (current: `20261018-tvedit1`).
Pages serves files with `max-age=600`; a deployed change can take about 10 minutes to reach a browser.

## Where things stand (2026-10-18)

- **App release:** `5907029` (S3). GitHub `main` is the source of truth; check it with
  `git ls-remote origin main` at the start of a session.
- **Database (as last recorded, not freshly observed):** phase `contracted-b45`, backup format 5,
  recovery archive active. G9 (archive retirement) is paused. Rollbacks follow the recorded order
  (history §18: P1 → P2 → P3′ → D2), each with its own approval; a B4/B5 rollback is lossy.
- **B3 / B1 / B7 plan:** S1–S3 released. Not started: **S4** (film controls and membership removal
  in collections, with Undo), **S5** (add existing items to a collection), **S6** (browser history
  and routes). D10 is deferred.
- **Simplification Batch A** is approved and runs before S4 (below). Batch B comes after S6.

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

## Batch A: simplification before S4 (approved 2026-10-18; remove this section when done)

- **Scope:** one write lane (one write at a time per page, affected controls disabled while saving,
  held through the reconciliation reread); one reread path; one simple focus rule; representative
  behavioural tests. No `db/` change, no server-side safeguard change, no phone-sizing work.
- **Must hold:** an older read never publishes during or after a pending write; overlapping reads
  don't publish out of order; results never reach a view the owner has left (keep small freshness
  and view checks where the lane doesn't prevent these). Define what happens when the reread after
  a write fails, so the next operation doesn't rely on invalid state. Filter options stay current
  without disturbing the focused control, its value or its selection.
- **Uncertain writes:** keep "not confirmed, never resent, read again". A fresh read doesn't prove an
  unconfirmed write has finished on the server. If simplifying restore protection means accepting
  that risk, report the tradeoff to the owner instead of weakening it. No server-completion detection.
- Check each write path (Watched / Skip, deletes, additions, Match, Details, organization, restore)
  rather than assuming `p_expected` covers it. Remove a safeguard only when the new lifecycle covers
  its purpose, and say in the PR what replaces each removed mechanism.
- **Tests:** remove tests for removed behaviour and redundant combinations; keep one test per
  distinct data risk and key journey; no count target, no rebuilt focus matrices. Convert regex
  markup assertions only when touched or repeatedly breaking.
- **Validation:** offline suites (capped); one bounded browser check in Claude in Chrome against
  synthetic local data (as in the S3 check: 1280 and 375 px). No production access or real writes.
- **Authorized:** commits on a branch, and pushing that branch (not `main`) for review. Then one
  independent review of the completed diff before merge. No merge to `main` or deploy until the owner
  approves the reviewed result.

## Open items

- **Data access (unverified, needs a separate owner decision):** the page has no sign-in and uses
  the publishable key, and the `db/` scripts give the `anon` role broad table access (recorded
  earlier as an accepted family-app trade-off). Production's current policies have not been checked.
  If they match the scripts, anyone holding the public key can read and change the data. Moving
  configuration or adding sign-in does not by itself close anonymous access; the policies are the
  boundary. The read-only policy check needs its own authorization.
- **Carried limitations (expected to go with Batch A):** focus lost when an action's reread starts
  while focus is in a filter; typing during a quiet reread overwrites its status line.
- **Optional, not in Batch A:** phone controls under 44 px (status select, Show ended, Skip).
- The rest of the backlog (accessibility, contrast and layout items; deferred features) is in
  history §14. Bring an item back only by owner request.

## Tests

```bash
for f in tests/*.test.js tests/*.test.mjs; do perl -e 'alarm shift; exec @ARGV' 120 node --max-old-space-size=1024 "$f" || echo "FAIL $f"; done
```

At `5907029`: 39 suites, 1,318 cases, all passing (recorded, not rerun since). Syntax check:
`node --check` on each `*.js`, `tests/*.js`, `tools/*.mjs`. Database rehearsals run locally on PGlite
(`tools/db-rehearsal-*.mjs`; see `db/README.md`). The identity audit (`tools/identity-audit.mjs`)
reads production, so it needs approval.
