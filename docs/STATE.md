# Watchlist Tracker: current state

Read this first in every session. It is the only startup document; keep it short. The repo, the deployed site and the production
database outrank this file; report any difference.

**This repo is public.** Keep personal details, machine paths, backup locations, private record names and evidence hashes out of it.

| Need | Read |
|---|---|
| How a feature behaves; writes, reads and focus | `docs/APP_BEHAVIOR.md` |
| Collection updates and research access (the live design) | `docs/ITEM4_DESIGN.md` |
| Database scripts and rules | `db/README.md` |
| Restoring without the page; member accounts | `docs/ADMIN_RESTORE.md`, `docs/MEMBER_RECOVERY.md` |
| The feature backlog (the one list) | `docs/NEXT_GEN_FEATURES.md` |
| Past releases and how things got here (only when a task needs it) | `docs/history/`, git, the release PRs |

## The app

A personal TV and film watchlist for the owner and a few trusted friends and family, each with a separate library: a static page on
GitHub Pages (`watchlist.html` + classic-script JS files, no build step) with a Supabase (PostgREST) backend and TMDB for identities and
metadata. Members sign in with an email and a password; the owner creates accounts. The database allows a signed-in member only their own
rows, and nothing to anyone signed out. Collaborative editing of a shared library is not a goal.

Favour understandable behaviour, faster development and lower maintenance. Skip enterprise-style hardening, redundant safeguards and
protection against hypothetical administrator mistakes or trusted people manipulating their own records. Keep account isolation,
membership enforcement, research permissions, holds, reliable backup and restore, and useful stale-write protection.

## Production now

- `main` is the source of truth; check it with `git ls-remote origin main`. Last release: sorting library views (item 13;
  PR #58, `2dc1256`), released 2026-11-10 UTC, presentation tier: the Sort list and sort line, Series premiere from TMDB's
  first-air date in the per-device show cache, Settings' "Remember each view’s sort when I reopen Watchlist" (default on). No
  database or backup change. Cache token `20261110-sort` (30 versioned files). Verified: 55 offline suites; a local synthetic
  check (desktop, 900 px, 375 / 300 px, keyboard, two members, the toggle on and off); the Pages build and the deployed files
  byte-identical to `main`; a read-only live check of All TV (two fields, a reversed tie-breaker, kept after a reload with
  remembering on, then reset to its prior usual order; no expansion, no database write).
- Previous release: named planning queues (Q1, item 7; PR #56, `6716da4`), 2026-11-05 UTC; `db/q1_queues.sql` applied before the
  merge (run record confirmed by a separate read; library tables identical in the backups before and after).
- Database phase `contracted-q1`, backup format 8 (twenty-one tables, no `user_id`), `access = members`, research per member. One flat
  `public.restore_backup`; the recovery archive is retired, exported privately first. The API exposes only `public` and `graphql_public`. The owner's production library holds the collection setup; one
  retained test account has no membership and reaches nothing (`docs/MEMBER_RECOVERY.md`).
- **Standing decisions:** W1 is removed; item 11 is abandoned; item 10 (CU1e) stays. `pg_graphql` stays disabled: enabling it needs a new explicit
  decision (`db/README.md`). A member's crafted request on their own records is an accepted limitation; it can't reach another account.
- **Restore** runs through the signed-in page or `docs/ADMIN_RESTORE.md`. Hosted restore performance has not been measured.
- **Repairs are fix-forward.** Reopening anonymous access is never a recovery step. Data recovery is a format-8 restore.

## Code map (classic globals; mutable page state is in `watchlist.html`)

| Area | Files |
|---|---|
| Boot, config, API | `watchlist.html`, `config.js`, `auth.js`, `api.js` (the writable phase, the stop switch), `write-lane.js`, `ui-helpers.js`, `identity.js`, `history.js` (routes) |
| Rendering and views | `render.js`, `tabs.js`, `derived-views.js` (TV views, list focus), `browse-views.js` (collections, All Movies) |
| Writes | `row-actions.js`, `tv-shows.js`, `library.js` (+ Add, writes from views, the movie tools' film row), `metadata.js` (Details) |
| Episodes, ratings | `episodes.js`, `show-ratings.js` |
| Organization | `organization.js`, `organization-manage.js`, `collection-members.js`; planning queues `queues.js`; sorting `view-sort.js` |
| TMDB | `tmdb-match.js`, `tmdb-search.js`, `collections-pull.js`, `person-pull.js`, `universe-pull.js` |
| Collection updates | `collection-updates.js`, `collection-research.js`, `collection-settings.js` |
| Backup / restore | `backup-restore.js` (reads formats 5–8 and writes format 8) |
| Database | `db/` (migrations and tests; run order in `db/README.md`) |
| Tests and tools | `tests/` (offline whole-page harness: `app-harness.js`, `mini-dom.js`, `b45-harness.js`), `tools/` (see `db/README.md`) |

## How we work

1. **Claude owns** planning, implementation, testing and routine corrections. The record is git: a branch, a reviewable diff and a concise
   closeout (below). No briefs, evidence packages or line-by-line approval for UI work, refactors or test changes.
2. **One task per session.** Start from this file and a short task prompt.
3. **Explicit owner approval is still required for:** any production access (reads included); destructive operations; restore; credentials;
   changes to `db/`, schema, policies, grants or database contracts; removing a safeguard that protects saved data; merging or pushing to
   `main`; deploying; pushing tags. A task prompt may grant some of these for that task.
4. **Independent review is selective.** Claude recommends it, with the concrete risk, for material database-contract changes, destructive
   operations, restore, data isolation, removed data safeguards or a hard unresolved bug; the owner decides. A review covers the completed
   change once; Claude fixes the findings in one batch; one focused follow-up checks closure.
5. **Plans** are short, with at most one revision. **Escalate** only a material scope change, an unresolved data-integrity risk or an action
   outside the authorization.

## Releases

Scale the checks to the behaviour affected, not to the kind of file. A function-only change isn't automatically low risk, and a page-only
change can affect saved data. Production steps always need the owner's approval, and **merging to `main` deploys the page**: when a page needs a
migration, merge after the migration's run record is confirmed.

| Tier | What it takes |
|---|---|
| **Presentation** (page only, no saved-data effect) | Appropriate tests; a new cache token; Pages built; a quick check of the changed behaviour |
| **Ordinary function change** | A short transactional migration with its relevant preconditions; a validated backup; a run record confirmed by a separate read; targeted behaviour verification; a before/after data comparison suited to what could change |
| **Restore, account access, schema or data preservation** | As above, plus focused checks that address the change's concrete risks, named in its plan (real PostgreSQL, the local stack, a real page) |

- Every release: bump the `?v=` token in `watchlist.html` if any page file changed. The tests check that all versioned files share one token;
  check by hand that it differs from the previous release's. Pages serves with `max-age=600`, so a change can take about 10 minutes to appear.
- Not required: failure injection after every statement; a reverse script for a new single-transaction migration; hash manifests; repeated
  evidence packages. Existing reverse scripts stay while `tools/db-rehearsal-cu1.mjs` uses them.
- **Closeout:** what changed, what was given up, what was verified and how (static, offline, local, live), what wasn't, and open decisions. Record
  a release in a few lines here and in its PR; long records don't belong in this file.

## Durable rules

- Work only in the git checkout, never in loose copies. No history rewrites or force-pushes.
- Keep the architecture: classic globals, inline handlers, page state in `watchlist.html`, no build step, modules or framework.
- One write lane, one reread path, one focus rule (`docs/APP_BEHAVIOR.md`).
- **Production data:** take and validate a fresh backup before any approved production write or destructive work. Never run a destructive
  restore on production to test it. Never silently fix production data while investigating; report first. App writes use guarded filters.
- Report verification honestly: static inspection, offline tests, local tests, live-page tests and deployed-site checks are different things.
- Live testing uses clearly named temporary rows (`ZZ … Test`) or page memory only; a live test that writes needs approval, and production ends
  back at its baseline. Restore is not a cleanup path once a test row has a TMDB identity.
- Built-in catalog dates change only through the collection-update date functions. `db/rpc.sql` can't reinstall functions on the current
  database. Storage (`collection`) is internal; interface code reaches it only through `library.js`.
- **Browser:** never use the built-in preview pane. Browser work, when authorized, uses Claude in Chrome. Never type passwords or credentials.
- **Node tests** always run with a heap cap and a time limit (an uncapped run once crashed the machine):
  `perl -e 'alarm shift; exec @ARGV' 120 node --max-old-space-size=1024 tests/<suite>.test.js`
- `/refresh-catalogs` is user-invoked only. When the owner must edit a local file, give a `nano` command, not `open -e`.

## Open items

- A page can't detect CU1b before calling it (a page deployed before its migration stops its writes on Edit until reloaded).
- Not yet verified on production: research-access Continue; CU1e's restored season, until the owner runs Refresh shows.
- Deleting a removed member's library is deferred (`docs/MEMBER_RECOVERY.md`). Every migration revokes from `anon` explicitly, because default
  privileges owned by `supabase_admin` can't be changed by `postgres`.
- Optional: on an unknown database phase, a refused season toggle shows the raw refusal text.
- Q1 not verified: real phones (touch dragging was checked with emulated pointer events only), completion through a real
  watched mark on the live site (left unchanged; covered locally and through a local API stack).
- Item 13 not verified: real phones; Series premiere on production (the owner's device cache has no first-air dates until
  Refresh shows or a show's expansion reads its details, so the field is unknown for every show there for now).
- Pre-existing (seen in Q1's review): a film with collection-update records of its own (an alias, a hold, a remembered removal)
  can't be deleted from the page, because those tables guard deletes; queue entries don't add to this.

## Tests

`tests/run.sh` runs every offline suite with the caps above; `tests/run.sh tests/<suite>.test.js` runs the ones named. It fails a suite that exits
non-zero, is killed, or doesn't end on a complete "N/N passed" line. Syntax check: `node --check` on each `*.js`, `tests/*.js`, `tools/*.mjs`.
Database tests run locally (`db/README.md`). The identity audit reads production, so it needs approval.
