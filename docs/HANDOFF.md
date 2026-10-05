# Watchlist Tracker — Handoff for a new Claude Code session

> **Read this whole document before doing anything.** It summarizes several long prior sessions. Treat the **actual repo, live site and production database as authoritative**; if anything here disagrees with them, trust them and report the difference. Your first task is at the very end (§19) and is read-only.
>
> **This file, `docs/HANDOFF.md` in the Watchlist repo, is the single canonical Watchlist handoff.** Update it here, in the repo, and commit documentation changes separately from app-code changes. Any copy kept outside the repo is not authoritative.
>
> **This repo is public.** Keep this file free of personal details, machine-specific paths, backup locations and infrastructure identifiers that the app doesn't already publish.
>
> **Last updated 2026-10-05**, after **TMDB identity enrichment of 81 Disney+ shows** (after the 8 Sheridan shows) and the follow-up: owner-approved audit exceptions, the Tales of the Jedi S2 skip, the **Proud Family S2 date correction (completed)**, the **TMDB enrichment of 6 90 Day shows (completed)**, the **TMDB enrichment of The Proud Family: Louder and Prouder (completed)**, the Rebels / Acolyte / Visions enrichment and the **Love in Paradise S3 date correction (completed)** (§18) on the completed first-class TV-show model (stage `final`). A TV show's status lives on its show (`tv_shows.status`); seasons hold watched, skipped, identity, dates and metadata. Enrichment adds identity only. Further enrichment (Visions, Rebels, The Acolyte, The Single Life, held 90 Day/Disney+/Sheridan cases) and the future sign-in (Auth/RLS) project each need separate approval.

---

## 1. Project overview

**What it is:** A personal streaming watchlist tracker for one family (TV + movies). It tracks what to watch, what's watched, per-person "watch with" tags, statuses, and a derived "Caught Up" state.

**Statuses** (stored in `status`):
- `confirmed` (shown as "On List")
- `highpriority`
- `watching`
- `complete`
- `pending`
- `maybe` (Maybe Later)
- `skipped`

Since Phase 3 (§18) these are **show** statuses for TV (stored in `tv_shows`) and row statuses for films. **Up to date** is a derived state of a Watching show (none of its remaining seasons has aired), never stored. The old 60-day **Caught Up** state is retired.

**Deployed:** a static site on GitHub Pages.
- Live URL: `https://jaredsclove.github.io/Watchlist/watchlist.html`
- Repo: `jaredsclove/Watchlist` on GitHub. Pages serves `main` directly, and a push to `main` is live in about 40–60 s.

**Architecture (intentional; do not casually modernize):**
- **Plain HTML/CSS/JS.** No build step, no bundler, no framework.
- **Classic `<script src>` files sharing one global scope** (not ES modules). Every function is a plain global.
- **Inline event handlers** (`onclick="fnName(...)"`, `onchange=…`), many generated at runtime inside template strings. Converting to modules would break them. That is a deliberately deferred separate project that needs explicit approval.
- **Supabase backend** (Postgres + PostgREST), called directly from the browser with the publishable key in `config.js`.
- **TMDB API** for movie/TV metadata, via a public read token in `config.js`. This is an accepted trade-off.

**Derived TV views** (not collections; §4a): **▶ Currently Watching** (the default landing view) and **📅 Coming Soon**. They read across every TV collection and store nothing of their own.

**Collections (tabs)** — row counts verified 2026-09-30:

| id | Label | `mediaType` | Kind | Rows |
|---|---|---|---|---|
| `disney` | Disney+ | tv | static (hand-curated `DEFAULTS`) | 182 |
| `90day` | 90 Day | tv | static | 72 |
| `sheridan` | Sheridan | tv | static | 42 |
| `othertv` | Other TV | tv | dynamic (TMDB) | 354 |
| `truecrime` | True Crime / Docs | tv | dynamic, **`mixedMedia: true`** (3 TV seasons + 4 films) | 7 |
| `movies` | Movies | movie | dynamic, `isMovieTab: true` | 61 |

TV tab order: **Currently Watching · Coming Soon │ Disney+ · 90 Day · Sheridan · Other TV · True Crime / Docs**. Movies has one tab.

**Static tabs** are seeded from `DEFAULTS` in `config.js`:
- `loadTab()` re-inserts any missing default by `item_key` and refreshes their TBA dates by `item_key`.
- `loadTab()` runs **only when that tab is opened**. Since `fc9f796`, startup opens Currently Watching, not Disney+, so boot no longer seeds or refreshes Disney+ on every visit. A new static default shows up in the derived views only after its tab has been opened once.
- These rows are **legacy/unidentified by design** (no TMDB ids).

**Dynamic tabs** are populated through TMDB flows. Every current dynamic row carries a TMDB identity.

---

## 2. Repository & deployment state

- **Working copy:** the local Git checkout of this repo. **Never work from loose copies outside the checkout** (such as files in a downloads folder).
- **Branch:** `main` is the source of truth. The deployed Pages site must match it byte-for-byte.
- **Current HEAD:** the documentation commit **"Update handoff after the Love in Paradise S3 date correction"**, the commit that last updated this file. Its parent is `2186a11` (`config.js`: Love in Paradise S3 date, §18) ← `34b8150` (handoff: Rebels, Acolyte and Visions TMDB enrichment) ← `0c3c434` (database: enriched-show guard fix for existing nonstandard labels, `db/rpc.sql` + `db/test/t_enrich.sql`; no app files) ← `76016c1` (handoff: Proud Family TMDB enrichment) ← `35d7895` ← `71cc336` ← `c1893a1`. (A file can't contain its own commit hash; run `git log -1` to see it.)
  - The **last app-code commit** is `2186a11`, a one-line `config.js` change (Love in Paradise S3 date, §18), **deployed and verified** on 2026-10-05 (all 18 app files byte-identical on Pages; 14 versioned assets 200). The previous app-code commit is `24dc443`, a one-line `config.js` change (Proud Family S2 date), pushed with `1513aea` after the 2026-10-05 GitHub Actions outage; before that `4550060`, "Explain seasons of a TMDB-matched built-in show that need review". Check `git status` for this commit.
  - The working tree is clean.
  - All 18 app files were verified byte-identical on GitHub Pages at `4550060` on 2026-10-05, and all 14 versioned assets returned 200 with the token `20261005-enrich1`.
- **Tracked files:** 73.
  - 18 app files: 17 JS/CSS + `watchlist.html`.
  - 1 doc: `docs/HANDOFF.md` (this file).
  - 27 files in `db/` (including `db/admin/tv_enrich.sql` and `db/test/t_enrich.sql`): the migration scripts, rollbacks, stage switches, test-project-only scripts, SQL self-checks and a local-values template (`db/README.md` gives the run order).
  - `.gitignore`: excludes the two local test-project value files.
  - 18 files in `tests/`: 15 test suites, the shared `tests/app-harness.js`, the TV-model reference `tests/tv-model-reference.js` and its shared cases `tests/fixtures/tv-model-cases.json`.
  - 8 files in `tools/` (6 tools, one local-values template, and `identity-exceptions.json`).
- **Known-good tags** (annotated; these are rollback points):
  - `post-tmdb-migration-modularization` → `c5b592e` (after the TMDB identity migration + modular split, before any Claude Code changes)
  - `post-same-title-schema-fix` → `8ec56c0` (after the same-title schema fix, before identity hardening)
  - `pre-derived-views` → `e2c1c16` (just before the derived views). **Local only, not pushed**; ask before pushing it.
  - `pre-tv-shows` → `b266a5b` (Phase 1a deployed, taken just before the production Phase 1b migration). **Local only, not pushed**; ask before pushing it.
  - Ask before pushing any new tag.
- **History:** early commits are a series of "Add files via upload". Everything after that has descriptive messages.

**Commits since `3675650`, oldest first:**

| Commit | Message |
|---|---|
| `335104c` | Refresh confirmed dates for existing TV seasons |
| `b90de71` | Add reusable identity audit tool |
| `8c935f3` | Harden restore validation before delete |
| `0155979` | Prioritize relevant TMDB search results |
| `338583a` | Fix mobile row popovers |
| `2a3c0de` | Improve TMDB failure reporting |
| `f8e31ac` | Add Match to TMDB for manual rows |
| `4e050c2` | Wrap Match to TMDB confirm buttons on narrow screens |
| `4b2d7c9` | Skip redundant tracked-show inserts |
| `a13c1fb` | Update 90 Day dates: Last Resort S3, Hunt for Love S2, Other Way S8 |
| `2499437` | Update Disney+ dates: 8 titles |
| `dc9e726` | Add Disney+ entry: Star Wars: Maul – Shadow Lord S2 |
| `dc315a8` | Update Disney+ defaults: 11 new entries, Punisher date fix |
| `e2c1c16` | Update Sheridan defaults: Call of Duty film, date fixes |
| `8e92095` | Allow fetchAllRows to take a PostgREST filter |
| `aa6e71a` | Capture the collection before awaits in async add/match flows |
| `fc9f796` | Add Currently Watching and Coming Soon derived TV views |
| `789d4f5` | Add offline tests for derived views, navigation and async guards |
| `6dfa0cd` | Add canonical Watchlist project handoff |
| `e003694` | Open Currently Watching with Up to date expanded |
| `bd4c068` | Update handoff for the Up to date default |
| `1486404` | Show Up to date status and the next stored season on Up to date cards |
| `af600e3` | Update handoff for Up to date status and next season |
| `e6d5822` | Add TV-show model reference and offline tests |
| `02f304f` | Restore through one transactional database function |
| `2c2bb6d` | Add local database rehearsal tooling and production replica schema |
| `11e9b9e` | Add ownership and TV-show schema migrations with self-checks |
| `a12c59d` | Add TV database functions, restore and isolation checks, rollbacks |
| `b5e1470` | Add API-level and model-expectation rehearsal tools; document db run order |
| `b39584e` | Add genuine-Auth two-user isolation test page for the test project |
| `2bc3410` | Update handoff after Phase 0 of the TV-show migration |
| `9eb622a` | Move test-project identifiers into untracked local config |
| `c445702` | Note the test-project identifier cleanup in the handoff |
| `535ddf7` | Add browser and password working rules to the handoff |
| `b266a5b` | Phase 1a: back up and restore in format 1 or 2, without user_id |
| `f7b44ec` | Update handoff after Phase 1 of the TV-show migration |
| `09f24aa` | Phase 2: route TV structural writes through the shadow TV functions |
| `9d40ba7` | Update handoff after the initial Phase 2 deployment |
| `c93a36f` | Record Phase 2 readiness criterion 12 in the handoff |
| `a182eae` | Phase 3: show-level TV status, Skip/Keep seasons, Up to date everywhere |
| `62b5b71` | Accept any Map-like show collection in the derived views |
| `28181c2` | Update handoff after Phase 3 of the TV-show migration |
| `1127320` | Treat ON DELETE RESTRICT (23001) as 'show still has seasons' after a film match |
| `59dd6a1` | Refresh shows checks the tab's identified shows from tv_shows |
| `dbc7580` | Add rollback scripts for the final stage and Refresh tracking |
| `bc43e2c` | Cleanup after the final stage: retire Caught Up, stop writing Refresh tracking |
| `75ee4d4` | Update handoff after completing the TV-show migration |
| `4fe7ad6` | Record the deletion of the temporary test project in the handoff |
| `a5c0a12` | Admin TMDB enrichment for built-in shows, and the guard for their later seasons |
| `f38ebad` | Identity audit: provisional B for a next season not yet listed by TMDB |
| `4550060` | Explain seasons of a TMDB-matched built-in show that need review |
| *(this commit)* | Update handoff after the Sheridan TMDB enrichment |

The five commits `a13c1fb`…`e2c1c16` are catalog refreshes made with the `/refresh-catalogs` skill. `8e92095`…`789d4f5` are the derived-views feature. `6dfa0cd` added this handoff (docs only). `e003694` makes Up to date start expanded, and `1486404` adds its status label and next-season text; `bd4c068` and `af600e3` update this handoff (docs only). `e6d5822`…`b39584e` are Phase 0 of the TV-show migration (§18); only `02f304f` changes app files. `b266a5b` is Phase 1a (app files and tests); Phase 1b/1c ran the already-committed `db/` scripts on production and needed no commit. `09f24aa` is the Phase 2 app change; Phase 2's database step ran the committed `db/rpc.sql` and the Phase 2 block of `db/stages.sql`.

**Script load order** (in `watchlist.html`; the order matters):

`config.js → identity.js → api.js → ui-helpers.js → backup-restore.js → tabs.js → render.js → row-actions.js → tmdb-search.js → collections-pull.js → universe-pull.js → person-pull.js → refresh-shows.js → tmdb-match.js → derived-views.js → inline <script>`

The inline script owns the mutable state and the boot sequence:

`buildMediaSwitch(); buildTabs(); switchView(activeViewId); updateBackupAgeIndicator();`

That opens **TV → Currently Watching**. The boot makes only paginated GETs; it doesn't call `loadTab()`.

**Cache-busting token (manual; no build system):**
- `watchlist.html` requests 13 JS files and `styles.css` with `?v=20261005-enrich1` (earlier tokens: `?v=20261005-final1` at `bc43e2c`, `?v=20261005-refresh1` at `59dd6a1`, `?v=20261005-phase3` at `62b5b71`, `?v=20261005-phase2` at `09f24aa`, `?v=20261005-phase1a` at `b266a5b`, `?v=20261004-restore1` at `02f304f`, `?v=20260929-derived1`, `?v=20261002-uptodate1` at `e003694`, `?v=20261003-uptodate2` at `1486404`): `api.js`, `backup-restore.js`, `tabs.js`, `render.js`, `row-actions.js`, `tmdb-search.js`, `collections-pull.js`, `universe-pull.js`, `person-pull.js`, `refresh-shows.js`, `tmdb-match.js`, `derived-views.js`, `tv-shows.js`.
- **Rule: when a deployment changes any versioned JS/CSS file, bump the token in `watchlist.html`** (for example `?v=20261015-x1`). This makes a new page load fresh copies instead of stale cached JS that doesn't match it. GitHub Pages caches files for 10 minutes.
- **`config.js`, `identity.js` and `ui-helpers.js` are deliberately unversioned.** The `/refresh-catalogs` workflow refreshes `config.js` by its plain URL (`fetch('config.js', {cache:'reload'})`), which only works while the page loads it without a token. If a future change to `identity.js` or `ui-helpers.js` must ship together with the page, add a token to that file then. Keep `config.js` unversioned unless the refresh workflow is updated too.
- An old cached page may keep running the old app for up to about 10 minutes after a deploy. That's accepted; the token guarantees that a **new** page never loads stale JS.

`tools/`, `tests/` and `db/` files are **never** loaded by the app.

**Before any change:** run `git status`, confirm the branch and commit, and inspect the tree.

---

## 3. File map & responsibilities (current, regenerated from the repo)

| File | Lines | Owns |
|---|---:|---|
| `watchlist.html` | 180 | Markup, **all mutable page state** (`let` vars, §4, including `tvShowsById`, the loaded `tv_shows` rows by id), script tags (with the `?v=` cache token, §2), boot. Has some harmless orphaned comment headers left over from the modular split. |
| `styles.css` | 499 | All CSS, including the derived-view styles (source badge, Upcoming/Today tags, "Not aired yet", the "Up to date" pill), status pills for every status, the show-scoped status select and the Skip / Keep button. |
| `config.js` | 448 | Constants: Supabase URL/key, `TABLE`, backup constants (`BACKUP_TABLES`, `BACKUP_FORMAT`, `BACKUP_FORMAT_VERSION`, `BACKUP_PAGE_SIZE`), `COLLECTIONS` + `DEFAULTS` (`truecrime` has `mixedMedia: true`), `WATCH_WITH_OPTIONS` (the household's fixed watch-with tags), `MCU_MOVIES` (39 `{t, id}` entries), `TMDB_TOKEN`/`TMDB_BASE`, `NETWORK_COLORS`, `UNIVERSE_LISTS` (`mcu`), `LAST_BACKUP_KEY`, `SHOW_KEY_OVERRIDES` (Phase 1a: maps `disney|the clone wars` to `star wars: the clone wars (2008)`, mirroring the database's `private.tv_show_key_override`). **Deliberately unversioned** (§2). |
| `identity.js` | 80 | `findExistingRow`, `isAlreadyAdded`, `normalizeTmdbTitle`, `pickTmdbMovieCandidate` (automated flows only), `isDuplicateKeyError`, `duplicateInsertMessage`, `cleanCollectionName` (display only). |
| `api.js` | 145 | `sbFetch`; `fetchAllRows(table, filter?, select = '*')` (backups pass their exact columns) (paginated, exact-count verified; the optional PostgREST filter is used by the derived views, and backup/restore call it without one); **TV structural writes (Phase 2):** `TV_COLLECTION_IDS`, `isTvCollection`, `isTvSeasonRow`, `tvShowKey` (mirrors the database's TV-row and show-key rules, including `SHOW_KEY_OVERRIDES`), `sbRpc`, and `addTvSeasonRows` (one `add_tv_seasons` call per show; returns `{inserted, alreadyListed, rejected, reopened}` and keeps `tvShowsById` current). `tmdbFetch`. A failed `tmdbFetch` throws `TMDB error <status>` with **`err.status` attached**. (`deleteAllRows`/`batchInsertRows` were removed in `02f304f`.) |
| `ui-helpers.js` | 109 | `esc` (HTML-escapes `& < > "`); badge/color helpers; `parseDate`, `formatDisplayDate`, `showSaved`, `showError`; the **TMDB failure-reporting helpers** `tmdbNameList`, `tmdbLookupFailureNote`, `tmdbAddFailureNote`. |
| `backup-restore.js` | 590 | Building and downloading backups in **format 1 or 2** (`detectBackupFormat` probes `tv_shows` read-only; `BACKUP_FORMATS` lists each format's tables and exact columns; `user_id` is never included); the **hardened** validator (`validateBackupObject`, `RESTORE_COLUMNS`/`RESTORE_COLUMNS_V2`, `restoreValueProblem`, `validateBackupRows`, `validateTvShowRows`, `identityLossErrors`); the guarded restore flow, which now replaces all tables with **one call to the database function `restore_backup`** (§10), and post-restore verification. `finishRestoreAndReload` reloads the active derived view or tab. |
| `tabs.js` | 173 | `buildTabs` (derived-view tabs first, then collections), `buildMediaSwitch`, `switchMediaType` (TV always lands on Currently Watching), `switchTab` (clears `activeViewId`), `switchView` (opens a derived view; sets `activeTabId = null`), and `loadTab`, which reseeds static defaults (on TV tabs only the defaults missing by `item_key`, through `seed_tv_defaults`) and refreshes TBA defaults by `item_key`; then loads the tab's shows (`loadTvShows`) and notes any Complete show reopened by seeding. |
| `render.js` | 644 | `renderFilters` and `renderTable` (both hand off to the derived-view renderers when `activeViewId` is set); status filter by show status (`displayStatus`) and off-list state (`isOffList`), plus "Up to date only"; stats count TV statuses per show. **Flat** tabs (`renderFlatTable`): a TV season has the show-scoped status control, Watched and Skip / Keep; × on a built-in TV season means Skip. **Grouped** tabs (`renderGroupedTable`): one group per show (`show_id`), with the show control and an Up to date tag; seasons have Skip / Keep + Watched (+ × delete, Match); a True Crime / Docs film is its own group with its row status. Movies (`renderMoviesTable`) unchanged. Shared season helpers `seasonSubRowHtml`, `seasonSubCardHtml`, `seasonWatchControlHtml`, `seasonRowControlHtml`. |
| `row-actions.js` | 225 | `actionRows()` and `mirrorRowUpdate()`; `toggleWatch` (a TV season through `set_season_watched`, a film by PATCH); `setStatus` (films only; ignored for a TV season); `delRow` (× on a built-in TV season → Skip via `setSeasonSkipped`, no confirm; a built-in film → status `skipped` after a confirm; anything else is really deleted after a confirm, a TV season through `delete_tv_season`, which removes an emptied show); `toggleAdd`, `toggleFilters`, `addEntry` (a TV season via `add_tv_seasons`), `toggleWatchWith`. |
| `tmdb-search.js` | 316 | Manual TMDB search: `tmdbSearchModeFor`, `selectTmdbSearchResults` (per-tab result selection, cap 6), `searchTMDB`, select/preview, `addSelectedTMDBSeasons` (captures collection and show id before its awaits; TV seasons on a TV tab go through `add_tv_seasons`, which also registers the show), `cancelTMDBPreview`, `resetTMDBSearchUI`. |
| `collections-pull.js` | 347 | Pull rest of collection, Refresh collections (with lookup-failure accounting), `updateCollectionRefreshLink`, filter-from-tag helpers. Both add flows capture the collection before their awaits. |
| `universe-pull.js` | 217 | `pullUniverse` (id-backed; conservative title fallback; separates a genuine 404 "not found" from a failed request) and `addPulledUniverseMovies` (captures the collection before its awaits). |
| `person-pull.js` | 324 | Person search/select/role, `pullPersonFilmography` (same-title handling, tag backfill; captures the collection and won't redraw or write a preview into another tab or view), `addPulledPersonMovies`, `refreshPersonCollection`. |
| `refresh-shows.js` | 200 | `tmdbSeasonDateUpdate`, `refreshShows` (checks the tab's **identified shows from `tv_shows`** — `othertv_shows` is no longer read; new seasons, TBA→date updates, lookup-failure accounting), `addRefreshedSeasons` (captures the collection before its awaits; new seasons go through `add_tv_seasons`, one call per show). |
| `tmdb-match.js` | 296 | **Match to TMDB** (§7.3): `isTmdbMatchEligible`, `buildTmdbMatchPatch`, `findTmdbMatchConflict`, `tmdbMatchConflictMessage`, the UI (`openTmdbMatch`, `searchTmdbMatch`, `chooseTmdbMatchResult`, `chooseTmdbMatchSeason`, `renderTmdbMatchConfirm`, `cancelTmdbMatch`), and `confirmTmdbMatch` (finishes against `row.collection`; a TV-season match on a TV tab goes through `match_tv_row`; a film match on a row linked as a TV season also sets `show_id` to null, since films are never linked, then deletes the show if that emptied it (refused by ON DELETE RESTRICT — `23001` — otherwise, which is not an error); a blocked match (the target show has another status) explains itself and writes nothing). |
| `derived-views.js` | 490 | **Currently Watching / Coming Soon** (§4a): `DERIVED_VIEWS`; pure rules (`isTvViewRow`, `isTbaRow`, `localTodayStr`, `isReleasedRow`, `seasonOrder`/`compareSeasons`, `deriveCurrentlyWatching(rows, shows, today)` = the Watching shows with up next and Up to date, `deriveComingSoon(rows, shows, today)`); the loader (`loadDerivedView`: TV rows + all shows, both paginated); the renderers (show control on every Watching card, Skip only in Coming Soon) and toggles. |
| `docs/HANDOFF.md` | — | **This handoff**, the single canonical copy. Never loaded by the app. |
| `tools/tmdb-enrich-candidates.mjs` | 120 | Read-only (GET-only) TMDB enrichment review for one built-in collection (`disney`/`90day`/`sheridan`): legacy shows, TMDB candidates with details, proposed `Season N` → N mappings and the audit grade each would get (§16, §18). Proposals only; never picks a match. Grades with the owner-approved exceptions. |
| `tools/identity-audit.mjs` | 380 | Read-only (GET-only) production identity audit with A/B/C/D grading (§16). Pure grading functions are separated from network access. Applies the owner-approved exceptions. |
| `tools/identity-exceptions.json` | 60 | Owner-approved audit exceptions (§16): each turns one specific C into B while its bound values match. No row ids. |
| `db/` | — | **TV-show migration** (§18): `phase0_restore_v1.sql` (installed in production), the Phase 1b/1c migrations, `tv_model.sql`, `rpc.sql`, `restore_backup.sql` (owner-scoped), `stages.sql`, `rollback/`, `future/auth_switchover.sql` (future sign-in project only) and `test/` (test-project-only scripts and self-checking SQL). Run order in `db/README.md`. On production: `phase0_restore_v1.sql` (Phase 0), then `phase1b_ownership.sql` + `restore_backup.sql` (1b), then `phase1c_tv_schema.sql` + `tv_model.sql` + `phase1c_backfill.sql` (1c). then `rpc.sql` + the Phase 2 block of `stages.sql` (Phase 2, 2026-10-05). The Phase 3 and later blocks of `stages.sql` have **not** run on production. |
| `tools/db-rehearsal.mjs`, `db/test/rehearsal-steps.mjs` | 93, 229 | Local rehearsal of every `db/` script on PGlite against a production replica and a real backup (PGlite isn't a repo dependency). |
| `tools/db-rehearsal-rest.mjs` | 210 | API-level rehearsal against a test project with its publishable key; refuses the production URL. |
| `tools/tv-model-expectations.mjs` | 91 | Emits the reference model's answers as a self-check SQL script for a test project. |
| `tools/auth-isolation-test.html` | 420 | Two-user isolation test with genuine Supabase Auth sessions against the temporary test project only (hard-locked; passwords typed by the owner; no persistence). |
| `tests/tv-model-reference.js` + `tests/fixtures/tv-model-cases.json` | 156, 45 | The approved TV-model rules (up next, Up to date, status migration, compatibility values) and shared cases; not a suite. |
| `tv-shows.js` | 165 | **Phase 3 show model**: `TV_STATUS_ORDER`, `isTvSeason`, `showOfRow`, `displayStatus`, `isOffList`; `loadTvShows`/`loadAllTvShows`; the approved up-next and Up to date rules (`mainSeasonList`, `remainingSeasons`, `upNextSeason`, `isShowUpToDate`); `showStatusSelectHtml` ("Show: …", "Applies to all seasons of …"), `seasonSkipButtonHtml`; actions `setShowStatusById` (`set_show_status`), `setSeasonSkipped` (`set_season_skipped`); add outcome messages (`showTvAddOutcome`, `showNotice`). Never reads a TV season's `status`. |
| `tests/tv-model.test.js` | 108 | The TV-model reference (43 cases). |
| `tests/backup-format.test.js` | 109 | Backup formats 1 and 2: read-only format probe, exact columns, never `user_id`, format-2 show/link validation, and restore across formats (a format-1 file is refused into a format-2 database) (6 cases). |
| `tests/restore-rpc.test.js` | 73 | Restore makes one `rpc/restore_backup` call, reports failures as "nothing was changed", and still verifies every field (3 cases). |
| `tests/identity-candidate.test.js` | 80 | `pickTmdbMovieCandidate` (9 cases). |
| `tests/title-attribute.test.js` | 38 | `esc()` round-trips titles in HTML attributes (5 cases). |
| `tests/season-date-update.test.js` | 62 | `tmdbSeasonDateUpdate` TBA→date rule (8 cases). |
| `tests/identity-audit.test.mjs` | 211 | Offline audit grading controls, including Reservoir Dogs, the owner-approved exceptions, exception reporting and unknown runtimes (67 cases). |
| `tests/restore-validation.test.js` | 123 | Pre-delete restore validation and identity-loss protection (35 cases). |
| `tests/search-selection.test.js` | 92 | Per-tab TMDB search selection (10 cases). |
| `tests/row-popover.test.js` | 88 | `toggleMorePopover` targets the tapped row's popover (5 cases). |
| `tests/tmdb-failures.test.js` | 247 | Outage, partial-failure and partial-add reporting across the real flows, with stubbed calls (21 cases). |
| `tests/tmdb-match.test.js` | 354 | Match to TMDB patch/conflict rules and the stubbed flow, including `match_tv_row`, the blocked match, the film-match unlink and empty-show removal (28 cases). |
| `tests/tv-writes.test.js` | 294 | TV write routing: which writes use the TV functions and which stay direct; linking, the Clone Wars key, duplicates and "Already on your list", last-season delete, the seeding rule, Complete-show reopen (Refresh and seeding), Skipped shows stay Skipped, Refresh shows reading identified shows from `tv_shows` (17 cases). |
| `tests/app-harness.js` | 495 | **Shared harness, not a suite.** Runs the whole page in a Node `vm` (every script in `watchlist.html` order plus its inline state/boot script) against a fake DOM and an in-memory Supabase/TMDB stand-in. Supports pausing a request (`hold`) to simulate navigation mid-await, forced failures, and count mismatches. It also has independent in-memory versions of the browser-facing TV functions in the shadow and authoritative stages (`stage` option, default `final` like production; reopen and the Match block included; the tracking table only in shadow/authoritative; the compatibility copies aren't simulated), and links fixture TV rows to shows the way the backfill does. `format1: true` gives a database without `tv_shows`. No network. |
| `tests/derived-views.test.js` | 293 | Phase 3 view rules: up next and Up to date equal the reference model on every shared case; membership by show status; Coming Soon eligibility; rendering of show controls, Skip / Keep, Coming Soon's Skip-only controls, flat and grouped tabs, the Up to date filter; and a test that scrambling the season `status` column changes nothing (20 cases). |
| `tests/derived-nav.test.js` | 409 | Startup, pagination and exact-count checks, navigation races, edits from a view (real id, mirrored cache, rollback), and the nine async guards (24 cases). |

**Totals:**
- 176 global functions (175 + `tvReviewMessage`), with no duplicate definitions (155 after Phase 2; Phase 3 added `tv-shows.js` and the new renderer helpers and removed the title-based `setShowStatus` and `nextStoredSeason`; cleanup removed `hasWatchableSoonSeason`).
- **55** distinct inline-handler names, all defined. Phase 3 added `setShowStatusById` and `setSeasonSkipped` and removed `setShowStatus`.
- **303** offline test cases across 15 suites (291 before the Single Life exception and reporting tests; 258 after the Sheridan enrichment; 255 before Phase 3; 248 at the end of the migration; the audit exceptions and unknown-runtime fix added 33 `identity-audit` cases): `derived-views` 20, `tmdb-match` 28, `tv-writes` 19, `identity-audit` 67.

---

## 4. State & global architecture

**Mutable state lives in the inline script in `watchlist.html`.** This is deliberate; don't move it without approval.
- `activeMediaType`: `'tv'` or `'movie'`.
- `activeViewId`: the open derived view (`'watching'` or `'comingsoon'`), or `null` when a collection tab is open. It starts as `'watching'`.
- `activeTabId`: the open collection id, or **`null` while a derived view is open**. It starts as `null`.
- `tabData`: `{ [collectionId]: { rows, loaded, newKeys } }`. Tabs load **lazily, one collection at a time**. The derived views never write into it.
- `derivedData`: `{ rows, loaded }`, the cross-TV rows for the derived views, kept apart from `tabData`.
- `derivedLoadSeq`: a counter that lets a late derived-view load see that it has been superseded.
- `derivedSectionOpen`: `{ uptodate, tba }`, the collapsible sections. Reset to `{ uptodate: true, tba: false }` (Up to date open, TBA closed) whenever a view is entered.
- `addOpen`
- `tmdbSelectedShow`
- `tmdbShowSpecials`
- `expandedShows`: a Set. On the grouped tabs it holds titles; in Currently Watching it holds show keys such as `othertv|tmdb:95396`. It's reset on every tab or view switch.
- `personCollectionPromptOpen`
- `personCollectionNames`: `null`, then a Promise while loading, then a `Set` of `custom_collections` names.
- `pendingRestoreData`

**Flow-scoped scratch state on `window`** (an existing pattern):
- `window.__pullCollectionData`
- `__refreshCollectionsData`
- `__refreshData`
- `__refreshDateUpdates`
- `__universePullKey`
- `__personPullName`
- `__personPullPending`
- `__tmdbMatch`: `{ rowId, results, target: { mediaType, details, seasonNumber } }` while the Match panel is open.

**Filter state** isn't stored in variables:
- `renderTable()` reads it straight from the DOM controls (`fSearch`, `fTheme`, `fYear`, `fCollection`, `fWatchWith`, `fWatch`, `fStatus`).
- `renderFilters()` records which tab it rendered in `#filtersRow.dataset.tab`. On a same-tab re-render it restores those controls, `tmdbQuery`, and the collapsed state.
- The derived views render their own filter row (`fSearch` and a Source select, `fSource`) and mark it `view:watching` or `view:comingsoon`, so the same keep-on-re-render / reset-on-switch rule applies.
- Switching tabs or views resets filters.

**Rendering:**
- Static tabs use the flat renderer.
- `othertv` and `truecrime` use `renderGroupedTable`, which groups TV seasons **by show** (`show_id`; a film is its own group). Each show group has the show's status control and, for a Watching show, an Up to date tag; its seasons appear when expanded.
- `movies` uses `renderMoviesTable`.
- The derived views use `renderDerivedTable` in `derived-views.js`. `renderFilters()` and `renderTable()` hand off to the derived renderers whenever `activeViewId` is set.
- Each renderer produces **both** desktop table rows and mobile cards. The "⋯" popover markup is duplicated in both, with the same `id`. That's why `toggleMorePopover(rowId, this)` finds the popover through the button's container, not by id.

**Rules:**
- Keep classic globals, inline handlers, the file layout, and the state location.
- ES modules, frameworks, or a state-management refactor are **out of scope** unless explicitly approved as a separate project.
- New feature files follow the existing per-feature pattern (for example `tmdb-match.js`, `derived-views.js`) and are added to the script order.

### 4a. Derived TV views: Currently Watching and Coming Soon (`fc9f796`, live)

**They are not collections.**
- They're listed in `DERIVED_VIEWS` (in `derived-views.js`, separate from `COLLECTIONS`) and tracked by `activeViewId`.
- No row, backup, restore schema or query ever uses `watching` or `comingsoon` as a `collection` value.
- While a view is open `activeTabId` is `null`. Anything that would write `collection: activeTabId` is refused by the database's NOT NULL, and a late `loadTab()` can't paint over the view.

**Which rows count as TV** (`isTvViewRow`):
- The collection has `mediaType: 'tv'`: `disney`, `90day`, `sheridan`, `othertv`, `truecrime`.
- The row is `media_type = 'tv'`, or it's a legacy row (`media_type` null) whose `season` isn't `'Film'`.
- That excludes the Movies tab, `truecrime` films and static `Film` rows. Static legacy rows and rows with no TMDB identity are included.
- **No TMDB lookup is needed** to render either view.

**Loading:**
- `loadDerivedView()` makes one **read-only** call: `fetchAllRows(TABLE, 'collection=in.("disney","90day","sheridan","othertv","truecrime")')`.
  - It's paginated (500 per page), and the exact count from Content-Range must match or it throws.
  - On a mismatch or error the view shows **Retry**, never a partial list.
- It never seeds, never refreshes TBA dates, and never fills `tabData`.
- It refetches every time a view is entered. `derivedLoadSeq` plus an `activeViewId` check stop a late response from drawing after you've left, or over a newer load.

**Since Phase 3 (2026-10-05) both views read the show model** (`tv-shows.js`): a TV season's status is its show's (`tv_shows.status`); the season row holds watched, skipped, identity, dates and metadata. The season `status` column is a compatibility copy and is never read.

**Currently Watching** (the default landing view):
- **Membership:** shows whose `tv_shows.status = 'watching'` (with at least one linked season). One card per show; shows are never merged across collections.
- **Season order:** numbered seasons before specials (`season_number === 0` or a `Special(s)` label); then season number (`season_number`, or the number parsed from "Season N…" / "Volume N"); then `date_sort`; then label; then row id.
- **Up next (approved rule):** the main progression is the numbered seasons (all seasons for a specials-only title); progress is the furthest watched season of that list; the remaining seasons are the unwatched, non-skipped ones after it; up next is the first of those. Earlier unwatched seasons stay listed but never move progress back. A future or TBA season can be up next. Specials never move progress when numbered seasons exist.
- **Up to date (one rule everywhere):** a Watching show is Up to date when **none of its remaining seasons has aired**. Released = not TBA, `date_sort ≠ 2099-01-01`, and `date_sort <= today` (the **local** date). Up to date is a state, not a stored status; when an aired season appears, the show moves back to In progress. The old 60-day Caught Up rule is retired.
- **In progress** cards: the up-next season and date (an Upcoming tag if not aired), the **show status control**, and Mark watched on the up-next season ("Not aired yet" until it airs).
- **Up to date** section (expanded by default): the show status control plus an **Up to date** tag; Up next shows **"Next: Season N · <date>"** / **"· premiere date TBA"** for a future or TBA up-next season, or **"No new season on your list yet"**.
- **Expanding** a show lists every season with Watched (release rule applies) and **Skip / Keep**. No delete, no Match.
- Order: A–Z by title, then collection label. Each card shows a source badge and a network/theme badge.
- **Known change at the switch:** Severance moved from In progress to Up to date (its remaining season hasn't aired).

**Coming Soon:**
- Eligible: linked TV seasons that are unwatched, not skipped, and whose show isn't Skipped.
- **Dated section:** not TBA, `date_sort >= today` (local); today included with a **Today** tag; ordered by date, title, season order, collection; grouped by month.
- **TBA section** (collapsed by default): `/TBA/i` in `display_date` or `date_sort === '2099-01-01'`, whatever the guessed `date_sort`.
- Controls: **Skip only** (and the show status as a read-only label). No status menu, no watch control, no delete.

**Filters (both views):** title search and a Source (collection) select. Stats: In progress / Up to date, or Dated / Next 30 days / TBA.

**Edits from a view:**
- Show status → `setShowStatusById` → `set_show_status`; Watched → `toggleWatch` → `set_season_watched`; Skip / Keep → `setSeasonSkipped` → `set_season_skipped`. All by real ids; the database writes the compatibility copies.
- After a successful write, `mirrorRowUpdate()` copies the saved row onto every cached copy (`tabData[*]`, `derivedData`); a show change updates `tvShowsById`. A failed write rolls back and shows the error.

**Startup and navigation:**
- The app opens on **TV → Currently Watching**.
- **Movies → TV always returns to Currently Watching**; it doesn't restore the last TV tab.
- Collection tabs behave as before.
- `finishRestoreAndReload()` reloads the active view or tab.

### 4b. Async capture-at-start guards (`aa6e71a`)

**Nine functions** used to read `activeTabId` again after an `await`. Each now captures the real collection id **before its first `await`**, uses it for every write and cache update, and **redraws only if that collection is still active**:

1. `addRefreshedSeasons`
2. `addSelectedTMDBSeasons` (also captures the show id, because a switch clears `tmdbSelectedShow`)
3. `addPulledCollectionMovies`
4. `addRefreshedCollectionMovies`
5. `addPulledUniverseMovies`
6. `addPulledPersonMovies`
7. `confirmTmdbMatch` (uses `row.collection`, which is authoritative)
8. `addEntry`
9. `pullPersonFilmography` (plus a null guard on the preview element)

This prevents wrong-collection writes after switching tabs or views, `tabData[null]` crashes, skipped follow-up writes (Refresh shows' TBA→date PATCHes, the `othertv_shows` registration), and redraws or previews landing in another tab. It also fixes the **pre-existing** wrong-collection race between two ordinary tabs.

- A flow started while a view is open does nothing, because there's no collection to write to.
- **Reviewed and left unchanged:** the preview-only flows `refreshShows`, `openPullCollection`, `searchTMDB`, `searchTmdbMatch` and `selectTMDBShow`. Their stale results go into DOM nodes that are detached after you navigate, and nothing is written.
- **Rule for new async flows:** capture the collection before the first `await`, and gate redraws on `activeTabId === collectionId`.

---

## 5. Database / schema model

**Tables:**
- `watchlist_items`: the main table.
- `othertv_shows`: the shows tracked for Refresh shows. Unique on `(collection, tmdb_id)`.
- `custom_collections`: person collections. Unique on `name`.

Postgres is 17.6. RLS is enabled and permissive: the anon role can select, insert, update and delete on every public table, which is an accepted family-app trade-off (16 anon policies: the original 12 plus 4 on `tv_shows`). No triggers.

**Since Phase 1 (2026-10-04) and Phase 2 (2026-10-05):**
- **Ownership (1b):** every public table has `user_id uuid NOT NULL`, defaulting to `private.current_owner_id()`, the bootstrap owner in `private.app_owner` (one owner; no production Auth users; no foreign key to `auth.users`). Clients can't write `user_id`: INSERT/UPDATE are granted per column, excluding it. Reads return it. The unique keys below are per owner (`user_id` leads each). `private` is closed to clients.
- **TV schema (1c):** `tv_shows` (`id`, `user_id`, `collection`, `title`, `show_key`, `tmdb_id`, `status` in `pending/confirmed/watching/maybe/complete/skipped`, `created_at`), and on `watchlist_items` `show_id uuid` (nullable) and `skipped bool NOT NULL default false`. Composite FK `(show_id, user_id, collection)` → `tv_shows(id, user_id, collection)`, ON UPDATE CASCADE, ON DELETE RESTRICT. Checks: films can't link; `skipped` requires `show_id`. Helper functions in `private` come from `db/tv_model.sql`.
- **Stage:** `private.migration_stage` = **`final`** (since 2026-10-05 14:32 UTC; `authoritative` from 14:02). **`tv_shows.status` is the TV workflow status.** Season rows are authoritative for watched, skipped, identity, dates and metadata. The season `status` column stays populated (it was normalized to the approved projection at the Phase 3 switch and verified exact for all 196 shows just before `final`) but **is no longer written for TV** (the functions skip `private.tv_project_legacy_status` at `final`) and is never read by the app; it is not dropped. At `final` the functions also **no longer maintain `othertv_shows`**; Refresh shows reads the identified shows in `tv_shows` instead (`59dd6a1`), and `othertv_shows` stays in the database, unused (64 rows, equal to the identified shows when `final` began). Reopen: a genuinely new season added to a Complete show (Refresh, TMDB add, manual add, seeding) reopens it On List, atomically; duplicates, date-only updates, Match and Restore don't. Skipped shows stay Skipped. **Enriched built-in shows (Disney+, 90 Day, Sheridan only):** a later season of a TMDB-matched built-in show — from seeding (a catalog refresh) or a manual Add entry — joins that show as TMDB season N when its label is exactly `Season N` (reopen rule applies); any other label, or an item key / TMDB season held by another row, is **rejected for review** (the app says "Not added — needs review"; a held-back built-in season repeats that note on each load of the tab); a second show is never created. Other TV and True Crime / Docs keep their behavior.
- **Functions:** `public.restore_backup` (owner-scoped, §10), the `private` helpers (`db/tv_model.sql`) and `db/rpc.sql`: `add_tv_seasons`, `seed_tv_defaults`, `match_tv_row`, `delete_tv_season`, `set_show_status`, `set_season_watched`, `set_season_skipped` — all used by the app since Phase 3. All are SECURITY INVOKER with an empty `search_path`, executable by `anon`/`authenticated`, not `PUBLIC`.

The column lists below are the original columns; `user_id`, `show_id` and `skipped` come after them.

**Columns (verified from the catalog):**
- `watchlist_items`:
  - `id` uuid PK (default `gen_random_uuid()`)
  - `collection`, `item_key`, `title`: text, NOT NULL
  - `season`, `theme`, `display_date`, `date_sort`: text, NOT NULL, default `''`
  - `watched`: bool, NOT NULL, default `false`
  - `status`: text, NOT NULL, default `'confirmed'`
  - `created_at`: timestamptz, NOT NULL, default `now()`
  - `watch_with`, `collections`: text[], nullable, default `'{}'`
  - `tmdb_collection_id` int, `tmdb_collection_name` text, `media_type` text, `tmdb_id` int, `season_number` int: all nullable
- `othertv_shows`:
  - `id` uuid PK
  - `tmdb_id` int, `title` text: NOT NULL
  - `network` text: NOT NULL, default `''`
  - `created_at` timestamptz
  - `collection` text: NOT NULL, default `'othertv'`
- `custom_collections`:
  - `id` uuid PK
  - `name` text: NOT NULL, unique
  - `tmdb_person_id` int: NOT NULL
  - `created_at` timestamptz
  - `role` text: default `'director'`

### `watchlist_items` identity model (canonical)

| Shape | `media_type` | `tmdb_id` | `season_number` | Uniqueness |
|---|---|---|---|---|
| Movie | `'movie'` | not null | **null** | `(collection, tmdb_id)` |
| TV season | `'tv'` | not null | **not null** (0 = Specials) | `(collection, tmdb_id, season_number)` |
| Legacy/manual | null | null | null | `(collection, item_key)` |

### Constraints and indexes (verified live)

- `watchlist_items_pkey`: PRIMARY KEY (`id`).
- `watchlist_items_movie_identity_key`: UNIQUE (`collection, media_type, tmdb_id`) WHERE `media_type='movie' AND tmdb_id IS NOT NULL`. The redundant `media_type` key column is harmless and was kept by owner decision.
- `watchlist_items_tv_identity_key`: UNIQUE (`collection, media_type, tmdb_id, season_number`) WHERE `media_type='tv' AND tmdb_id IS NOT NULL AND season_number IS NOT NULL`.
- `watchlist_items_legacy_item_key_key`: UNIQUE (`collection`, `item_key`) **WHERE `tmdb_id IS NULL`**.
- `watchlist_items_identity_shape_check`: a CHECK allowing **exactly** the three shapes above. It's written with `IS NOT DISTINCT FROM`, so NULLs can't slip through.
- Non-unique indexes: `watchlist_items_collection_idx` (`collection`, `date_sort`) and `watchlist_items_tmdb_collection_idx` (`tmdb_collection_id`).
- `othertv_shows`: `othertv_shows_user_collection_tmdb_id_key` UNIQUE (`user_id, collection, tmdb_id`; was `othertv_shows_collection_tmdb_id_key` before 1b), plus indexes on `collection` and `tmdb_id`.
- `custom_collections`: `custom_collections_user_name_key` UNIQUE (`user_id, name`; was `custom_collections_name_key`), plus an index on `tmdb_person_id`.
- **Since 1b, `user_id` leads every unique key** (the three `watchlist_items` identity indexes keep their names and predicates) and `watchlist_items_collection_idx` is (`user_id, collection, date_sort`).
- **Since 1c:** `tv_shows_identified_key` UNIQUE (`user_id, collection, tmdb_id`), `tv_shows_legacy_key` UNIQUE (`user_id, collection, show_key`), `tv_shows_id_owner_collection_key` (the FK target), and `watchlist_items_show_id_idx`.
- **Removed:** the old global UNIQUE (`collection`, `item_key`). It used to block same-title films with different TMDB ids.

### Legacy fallback rule

`findExistingRow` in `identity.js` matches by `(media_type, tmdb_id[, season_number])` first. It falls back to `item_key` **only when the existing row has `tmdb_id == null`**. A row with a different non-null `tmdb_id` must never match by title or `item_key` alone.

**`item_key` format:** the lowercase, trimmed title plus the season label, for example `tehran|season 1`, `toy story|film`, or `breaking bad|specials`.

**Date conventions** (these matter for date-based views):
- Dynamic rows:
  - `date_sort` is `YYYY-MM-DD`.
  - A TMDB TBA is stored as `display_date='TBA'` / `date_sort='2099-01-01'`.
- Static DEFAULT rows:
  - They may use free-text dates such as `"2026 (TBA)"` or `"TBA (announced)"`, with a **guessed** `date_sort` such as `2027-06-01`, not 2099.
- TBA is detected everywhere with `/TBA/i` on `display_date`. The derived views also treat `date_sort = '2099-01-01'` as TBA, and they never use a TBA row's guessed `date_sort` to decide whether it has been released.
- Every stored `date_sort` in production currently matches `YYYY-MM-DD`.

---

## 6. Migration / history summary

- **Dynamic tabs** (`othertv`, `truecrime`, `movies`) are fully migrated: every row has a TMDB identity.
- **Static tabs** (296 rows as of 2026-09-30) are intentionally legacy. All 296 unidentified rows in production are static DEFAULTs: 53 are `skipped`, and there are **zero** manual rows on dynamic tabs.
- **Same-title schema fix (done):** replaced the global `item_key` uniqueness with the legacy-only partial index plus the shape CHECK.
- **Reservoir Dogs data fix (done):** row `c15c8855-…` was moved from 443129 (the 1991 12-minute short) to 500 (the 1992 feature).
  - **Root cause:** an early person pull deduplicated credits by title.
  - **Prevention:** credits are now deduplicated by TMDB id, ids always come from TMDB objects, same-title credits need an explicit choice, and automated matches never take the first result.
- **Stale TBA dates (done, `335104c`):**
  - Silo S4 was corrected to Jul 8, 2027, and The Hunting Wives S2 to Nov 26, 2026.
  - Both were applied through the new Refresh shows path, not SQL.
- **Production identity audit (2026-09-30):** 718 rows, 422 identified → **420 A / 2 B / 0 C / 0 D — PASS**. The two B rows are expected review items (confirmed-date drift of one day), not defects; see §13 and §17.
- **Collection consistency** (last verified 2026-09-26): 42 rows across 16 TMDB collections, with 0 name problems and 0 tag-spelling problems.

---

## 7. TMDB identity safety rules (implemented)

**A TMDB identity comes from an explicit TMDB object, never an unverified title guess.**

### 7.1 Automated / semi-automated flows

- **Manual search:**
  - The user clicks a specific result showing the year, Film/Series type and country; the id is carried directly.
  - Result selection follows the tab (`0155979`):
    - **Movies**: films first, up to 6; TV only fills leftover slots.
    - **Other TV**: series first; films only fill leftover slots.
    - **True Crime / Docs** (`mixedMedia`): the original mixed split, up to 4 series and then films, capped at 6.
  - TMDB's order is kept within each type. The regression case is "Dune" on Movies, which must include Dune: Part Two.
- **Pull rest / Refresh collections:** ids come from the `/collection/{id}` parts.
- **Person pull / refresh:**
  - Ids come from `/person/{id}/movie_credits`, and batches are deduplicated by `tmdb_id`.
  - Same-title credits are shown with the year, flagged, and **left unchecked**.
- **Refresh shows:**
  - Uses `othertv_shows.tmdb_id`, registered when a show is added or matched.
  - It offers new seasons, and also **TBA → confirmed-date updates** on existing identified seasons.
  - Those updates change only `display_date`/`date_sort`, through a guarded PATCH filtered on `id`, `media_type`, `tmdb_id`, `season_number` and the TBA value.
  - Already-confirmed dates are never overwritten.
- **MCU universe:**
  - `MCU_MOVIES` entries are `{ t, id }` with verified ids, fetched directly by id.
  - Plain-title entries go through `pickTmdbMovieCandidate`: exact normalized title match, optional year, never the first result, never popularity or vote count, and ambiguous candidates shown unchecked.
- **Manual adds (`addEntry`)** stay unidentified by design. They're protected by the client-side `item_key` check and the legacy partial unique index.
- **Race-condition duplicates** are rejected by the database and shown through `isDuplicateKeyError` / `duplicateInsertMessage`.

### 7.2 TMDB failure reporting (`2a3c0de`)

- Every multi-lookup flow counts attempted and failed lookups (`tmdbLookupFailureNote`).
- **All lookups fail:** "Couldn't check TMDB right now. N of N … lookups failed. Nothing was changed." There's no preview and no "up to date".
- **Some fail:** the results that worked are shown, plus a ⚠️ warning naming the failures and saying the result may be incomplete.
- **"Everything's up to date"** appears only when every lookup succeeded.
- **Universe pull:** an HTTP **404** for a configured id counts as a genuine "not found". Any other error counts as a failed check.
- **Add flows** (collection pull, refresh collections, universe, person), per `tmdbAddFailureNote`:
  - Films whose details fail aren't inserted; the rest are.
  - The result is reported as "Added X of Y… couldn't load TMDB details for Z".
  - If all fail, nothing is written, "Saved" isn't shown, and the preview stays open for a retry.

### 7.3 Match to TMDB (`f8e31ac`, `4e050c2`, `4b2d7c9`)

- **Eligible rows:** unidentified rows (`tmdb_id`, `media_type` and `season_number` all null) on **dynamic** tabs, which in practice means manual adds.
  - **Static DEFAULTs are deliberately excluded.** `loadTab` reseeds by `item_key`, so a rewritten `item_key` would bring the default back as a duplicate.
- **Entry points:**
  - "🎯 Match to TMDB" in the Movies "⋯" popover.
  - The season line on the grouped TV tabs (desktop sub-row and mobile sub-season row).
- **Flow:**
  - Search, prefilled with the row title and using the same per-tab result selection.
  - The user clicks one result, which shows title, Film/Series, year, country and TMDB id.
  - For a series the user **must choose the season**: radio buttons, none preselected, Confirm disabled until chosen.
  - A before/after summary, then **Confirm**.
  - There's no first-result or title-only auto-match, and `pickTmdbMovieCandidate` is not used.
- **The write:**
  - The row is updated **in place** with a PATCH filtered on `id=eq.<id>&tmdb_id=is.null&media_type=is.null&season_number=is.null`, then re-read to confirm the new identity.
  - **Preserved:** `id`, `collection`, `created_at`, `watched`, `watch_with`, `status`, and existing tags.
  - **Movie sets:**
    - `media_type='movie'`, `tmdb_id`, `season_number=null`
    - `title`, `season='Film'`, `item_key='<title>|film'`
    - `display_date`/`date_sort` from the release date
    - `theme`: genre on Movies, production company elsewhere
    - `tmdb_collection_id`/`name`
    - TMDB's full franchise name is appended to `collections` if it's missing
  - **TV sets:**
    - `media_type='tv'`, `tmdb_id`, `season_number`
    - `title` (the show name), `season` ("Season N" or "Specials"), `item_key`
    - `display_date`/`date_sort` from the season's air date
    - `theme` (the network)
    - Then the show is registered in `othertv_shows`, **only if it isn't already tracked** in that collection (a GET pre-check, `4b2d7c9`). A 23505 is still handled quietly as a race backstop.
- **Protections checked in the database before writing:**
  - Another row in the collection already has the target identity → blocked, and the message names that row.
  - An unmatched row already uses the new `item_key` → blocked.
  - Nothing is ever merged.
  - Identified rows that only share the title (a different TMDB id) never block a match.
  - The database's unique indexes are the final guard; a 23505 is shown as a friendly message.
- **Production live test (2026-09-26):**
  - Two temporary ZZ rows were used. One was matched to Dune (1984, 841); the other to Breaking Bad Specials (1396, season 0).
  - The duplicate-block attempts against Reservoir Dogs (500) and Silo S1 were blocked with 0 writes.
  - Both matched rows graded A in the audit.
  - Both rows were deleted by id, and all three fingerprints returned exactly to baseline.
- **Undo:** there's no "Unmatch" (§13). Restoring a pre-match backup is **refused** by the restore identity-loss safeguard (§10).

---

## 8. Canonical collection-tag rules

- `tmdb_collection_name` stores **TMDB's exact collection name**, for example `Toy Story Collection`.
- The franchise entry in `collections[]` stores **exactly the same string**.
- `" Collection"` is stripped **for display only**, by `cleanCollectionName()`.
- Filters, tags, the "Pull rest of X" label and the search preview note show the short form, for example `Toy Story`. Filtering compares the cleaned display values.
- Pull rest and Refresh collections store `/collection/{id}` `data.name`. Search, person, universe and Match store `belongs_to_collection.name`.
- Person tags (e.g. `Quentin Tarantino`) and universe tags (e.g. `MCU`) coexist with the franchise tag in `collections[]`.
- **Invariant:** each `tmdb_collection_id` maps to exactly one stored name and one franchise spelling, equal to TMDB's live name.
- Current production: **42 rows / 16 collections / 0 problems.**
- The Collections **↻ Refresh** link appears **only** when the selection is a `name` in `custom_collections`. Currently that's just `Quentin Tarantino` (tmdb_person_id 138, role director).

---

## 9. Escaping / title transport rules

- **Fixed bug:** titles with apostrophes used to be stored with a literal backslash, because `data-title` attributes used `esc(title).replace(/'/g,"\\'")`.
- **Rule:** in **HTML attributes** such as `data-title="…"` or `value="…"`, use `esc()` only. Never apply JavaScript `\'` escaping to HTML attribute values.
- **Inline JS handler strings** such as `onclick="fn('…')"` are a different context. There, `esc(x).replace(/'/g,"\\'")` is **correct and still needed**. Don't "fix" those just because they contain apostrophe escaping.
- **Known edge case:** a title containing a literal `\` could still break inline handler strings (§14).
- **Tests:** `tests/title-attribute.test.js`. A real-browser `dataset.title` round-trip was verified earlier.

---

## 10. Backup / restore (hardened)

### Backup (⬇ Backup)

- Exports all three tables with paginated, exact-count-verified fetches.
- JSON shape: `{ format: 'watchlist-tracker-backup', formatVersion, exportedAt, rowCounts, tables }`.
- **Format (since `b266a5b`):** the app probes `tv_shows?select=id&limit=1` (read-only). 200 → **format 2**: four tables (`watchlist_items` with 20 columns incl. `show_id`/`skipped`, `tv_shows` 7, `othertv_shows` 6, `custom_collections` 5). 404 `PGRST205` → **format 1**: the original three tables. Anything else aborts. Each table is fetched with its exact column list, so **`user_id` is never in a backup**. Production is now format 2.
- Filename: `watchlist-backup-YYYY-MM-DD-HHMM.json`.
- The same backup can be produced from Node by running the app's own `config.js`/`api.js`/`backup-restore.js` in a `vm` sandbox and calling `buildBackupObject()` + `validateBackupObject()`. That's how the recent backups were taken.

### Restore (⬆ Restore): the flow

1. The file is parsed and run through **`validateBackupObject`**.
2. The preview fetches the current data and runs **`identityLossErrors`** against it.
3. **`executeRestore`** builds a safety backup of the current data **and validates it in memory**, including the identity-loss check against it. Any failure aborts with "nothing was changed".
4. The safety backup is downloaded (`watchlist-pre-restore-*.json`), and the user confirms they can see it.
5. One call to the database function **`restore_backup(p_backup, p_allow_v1_reset)`** (since 1b: `db/restore_backup.sql`, owner-scoped and stage-aware) replaces **the current owner's** rows **in a single transaction**, preserving ids and `created_at`. It re-checks the format, version, the table set, `rowCounts` and each row's exact columns, and any error rolls everything back. The preview refuses a format-2 file while the database is format 1, and **since Phase 3 refuses a format-1 file into the format-2 database** (TV show status exists only in `tv_shows`, which a format-1 file lacks); `p_allow_v1_reset` is always sent as `false`. The database refuses format 1 at stage `authoritative` too. (Before `02f304f` the app deleted and batch-inserted table by table.)
6. The data is re-fetched and verified field by field against the backup.

### Checks that run before any DELETE (`8c935f3`)

- **Header:** `format`, a `formatVersion` of 1 or 2, `exportedAt`, and exactly that format's tables present as arrays.
- **Format 2 shows and links (`validateTvShowRows`):** show statuses, non-empty title/`show_key`, no duplicate identified or legacy shows, every `show_id` present in the backup and in the same collection, no linked films, `skipped` only on linked rows.
- **`rowCounts` is required** for all three tables, as non-negative integers equal to the array lengths.
- **Exact column set per row**, taken from **`RESTORE_COLUMNS`** (which mirrors the live schema): unknown and missing columns are both rejected. Key presence is checked separately from nullability.
- **Value types:** uuid; text; `date_sort` as `YYYY-MM-DD`; ISO timestamps; booleans; 32-bit integers; `text[]` of strings; NOT NULL vs. nullable per column.
- **Identity shape**, mirroring the database CHECK.
- **Duplicates:** row ids in every table; movie, TV and legacy identities; tracked shows `(collection, tmdb_id)`; person-collection names. The error names the conflicting key.
- **Pre-identity backups** (no `media_type`/`tmdb_id`/`season_number` columns at all) are refused, with a message explaining they predate the TMDB identity migration. For example, a pre-identity backup from before the migration used to "succeed" while dropping all 414 identities.
- **`identityLossErrors`** refuses a restore when:
  - rows identified now would come back unidentified, or
  - the backup has no identified rows while the database has some.

  As a consequence, **after a Match to TMDB, a pre-match backup can't be restored.**

### Limits and notes

- **`RESTORE_COLUMNS`/`RESTORE_COLUMNS_V2` must be updated whenever the schema gains a column.** Backups request exact columns, so a new column is simply left out of backups until it's added there (and to `restore_backup`).
- **The mixed-state window is closed:** restore is one database transaction, so a failed restore leaves the data exactly as it was; the app says "nothing was changed" and names the safety backup.
- **`restore_backup` (production):** `restore_backup(jsonb, boolean)` returning jsonb; plpgsql; `SECURITY INVOKER`; `search_path` set to empty; executable by `anon`, `authenticated` and `service_role`, not `PUBLIC`. Since 1b its body matches `db/restore_backup.sql` exactly (verified by MD5 in the catalog; it replaced the Phase 0 `db/phase0_restore_v1.sql`). At stage `authoritative` (since Phase 3) it accepts **format 2 only**; format 1 is refused whatever `p_allow_v1_reset` says (format 1 was accepted with that flag in `tv_schema`/`shadow`). **It has never been called on production**; its behavior was verified locally and on the test project.
- **Minor:** safety-backup filenames only go down to the minute. Two restores in the same minute could make a browser rename the second download to "(1)", while the dialog shows the original name.

### Rehearsal (2026-09-26)

- A **temporary, isolated Supabase project** was created with a schema copied from production; the catalog diff was clean. The **real** restore code ran in a Node harness with a fetch guard that blocked the production host.
- Results:
  - The restore reproduced production **byte-for-byte**, matching the SQL fingerprints.
  - The safety-backup recovery drill passed.
  - All 22 failure-injection cases behaved as expected. After hardening, every data-level bad backup is rejected **before DELETE**.
- **That rehearsal project has since been deleted.** A second temporary test project, created for the TV-show migration (§18), was deleted by the owner on 2026-10-05 once the migration was complete; rehearsals now run locally (PGlite).
- The **browser UI smoke test** of restore (file picker and real download) was **intentionally skipped** by owner decision. The harness exercised the same functions.
- **Never run a destructive restore on production just to test it.**

### Latest known-good backups

- Backups are kept **outside the repo**, never committed. Ask the owner where current backups live.
- **The latest validated backup (2026-10-05 20:11 UTC, right after the Disney+ enrichment, §18):** format 2, 719 / 197 / 64 / 1 (`watchlist_items` / `tv_shows` / `othertv_shows` / `custom_collections`), taken with the deployed app's own backup code. Historical: the first format-2 backup (718 / 196 / 64 / 1) was taken 2026-10-04 22:26 UTC after Phase 1c (`b266a5b`). The last format-1 backup (718 / 64 / 1) was taken 22:17 UTC, immediately before Phase 1b; the original-column content of the three tables was unchanged by Phase 1.
- Older backups are **historical** reference points, not the current operational backup. A future session must **take and validate a fresh backup before any approved production write**, rather than relying on an old file.
- **Always take and validate a fresh backup before any destructive database work.**

---

## 11. Working rules for Claude Code (important)

1. Start every task by inspecting the repo:
   - `git status`
   - branch
   - commit
   - file tree

   The repo and the deployed site are authoritative.

   **Never work from loose copies outside the Git checkout** (such as a downloads folder).

2. Do not change the architecture (classic globals, inline handlers, state in `watchlist.html`, the current file layout) without explicit approval.

3. **Narrow diffs only.** No unrelated cleanup, renames, refactors or formatting churn.

4. No schema, RLS, identity-rule or backup/restore behavior changes without a written plan approved first.

5. **Database work always follows this sequence:**

   1. read-only audit
   2. proposal
   3. dry run / preflight
   4. **explicit user approval**
   5. execute
   6. verify

   Capture the before-state first:
   - affected rows
   - fingerprints (all three tables when relevant)
   - relevant constraint/index state

   Use guarded, single-transaction SQL with row-count assertions and a rollback script where appropriate. App-driven writes must use guarded filters (id plus expected current values).

6. **Never silently fix production data** while investigating. Report first.

7. If an unexpected material issue is found, **stop and report before fixing it**.

8. Report verification honestly, and distinguish:
   - static inspection
   - mocked/offline tests
   - local tests
   - live-page tests (including page-memory or simulated writes)
   - deployed-site verification

   Never claim something was tested when it was only inspected.

9. Test with:
   - clearly named temporary rows such as `"ZZ … Test"`, or
   - page-memory-only setups (preferred when they give enough confidence)

   **Record the ids of temporary rows immediately after creation, modify only those ids, delete them by id afterwards, and prove production is back to baseline** (all three table fingerprints unchanged; audit unchanged).

   Once a temporary row has gained a TMDB identity, **normal Restore is not a cleanup path**: the identity-loss safeguard will refuse a pre-test backup. Clean up by id.

   Do not create permanent `custom_collections` rows solely for tests without approval. Where applicable, use person pulls with `isNewCollection=false` (e.g. `refreshPersonCollection('Quentin Tarantino')`).

   Any live production test that writes needs explicit approval first.

10. Git:
    - descriptive commit messages
    - no history rewrites
    - no force-push
    - after pushing, confirm GitHub Pages matches `main` byte-for-byte
    - **confirm the live page is actually running the new code.** GitHub Pages sends `max-age=600`, so browsers can serve stale `.js` for about 10 minutes (§11a).

11. Ask before outward-facing actions such as pushing tags, unless already approved for the task.

12. **Never use the Claude preview pane (the in-app / built-in browser) for anything** — not for viewing the app, smoke checks, test pages or local files, and never start a dev server through the preview tooling.

13. **Always use a real tab in the owner's Chrome** (Claude in Chrome) for every browser task, including the Supabase dashboard / SQL Editor, the deployed site and test pages.

14. **Pause and tell the owner whenever a test-account login or a password is needed.** Never type passwords or credentials yourself; say exactly what to enter and where, then wait until the owner confirms it's done.

### 11a. Tooling notes from the prior environment

> **Superseded where they conflict with rules 12–14:** the notes below mention the in-app browser and local preview from earlier sessions. Do the same work in a real Chrome tab instead.

**These are environment-specific. Use them only if the same desktop/browser tooling is available. If it isn't, adapt the workflow safely and report the limitation rather than assuming these exact mechanics are required.**

- **Database catalog/SQL access:**
  - This was done in the **Supabase SQL Editor**, in the owner's logged-in browser session (driven through a browser-automation tool). The anon key can't read Postgres catalogs.
  - The workflow set the SQL with `window.monaco.editor.getModels()[0].setValue(...)`, verified the exact text, clicked Run, and read the result grid from the DOM (`[role=row]` / `[role=gridcell]`).
  - The tool's output filter can mask long hex strings, so split hashes into chunks, or compare against the expected value inside the page and return a boolean.
  - A "Leave site?" dialog can block navigation away from an edited query tab; opening a new tab avoids it.
  - Supabase may save queries as "Untitled query" under Private.
- **Read-only REST checks** can use the anon key from `config.js` (GET only), or `tools/identity-audit.mjs`.
- **Browser cache workaround (important):**
  - A cache-busted page URL or cmd+shift+R did **not** reliably refresh cached scripts in the in-app browser.
  - What worked: in the page, run `fetch('<file>.js', {cache:'reload'})` for each changed file (and `watchlist.html` if its script tags changed), then `location.reload()`.
  - Then **hash-verify**: SHA-256 of the relevant functions' `toString()` in the page must equal the same functions loaded from the local source in a Node `vm`.
- **Live-page testing without writes:**
  - Install a fetch wrapper in page memory that logs every request and blocks (or answers in memory) Supabase writes.
  - For approved live tests, use an **allowlist** (only the temporary rows' ids).
  - TMDB outages can be simulated the same way (HTTP 500/503/404 or `TypeError('Failed to fetch')`).
  - Reload the page afterwards to discard in-memory state.
- **Phone-width checks:** the in-app browser's mobile preset (375×812) emulates a phone viewport. It isn't a physical device.
- **Local preview:**
  - The local preview tooling in that environment was configured for a **different project**. Don't modify another project's configuration or start its servers; a project-level preview config wasn't honored.
  - The in-app browser can't run `file://` apps, and running ad-hoc dev servers wasn't allowed in that environment.
  - Practical approach: test deployed code in page memory, or run the app's classic scripts in a Node `vm` harness.
- **Offline test pattern:**
  - Tests load classic scripts into a `vm` context, as the page does.
  - Values created inside the vm are a different JS realm, so copy them (`Array.from`, or JSON round-trip) before `assert.deepStrictEqual`.
  - Top-level `function` declarations in later-loaded files override same-named stubs; set stubs **after** loading.
- **Isolated rehearsal:** the harness pattern ran the real `backup-restore.js` in a `vm` with the Supabase URL/key substituted in memory and a fetch guard that allowed only the test host. The test Supabase project was deleted afterwards; the free plan allows 2 projects.

**Added 2026-09-30 (derived-views deployment):**
- **Versioned assets:** because most JS files now carry a `?v=` token (§2), a fresh `watchlist.html` requests brand-new URLs. To load a deploy in the in-app browser:
  1. Open a same-origin page that isn't the app, such as the raw `config.js` URL.
  2. Run `fetch('watchlist.html', {cache:'reload'})` there.
  3. Then open the app.
  4. Confirm in the network log that every `?v=` asset returned 200.
- **The boot is now GET-only**, so loading the deployed app is write-free. Install the page-memory write-block before clicking anything.
- Confirm which Supabase requests a page made from the page itself (resource timings, or the write-block's log), not only from a browser tool's network panel.
- **Verification workflow for app changes:**
  - thorough offline `vm` tests (`tests/app-harness.js` runs the whole page)
  - then deployed-page verification with writes blocked
  - with `git revert` as the rollback
  Running undeployed local code inside the live page isn't part of the workflow. Never interact with write-capable controls until the write-block is confirmed installed.
- A quick **read-only data fingerprint** without the SQL Editor: GET each table with the anon key (`?select=*&order=id.asc`, `Range: 0-9999`, `Prefer: count=exact`) and take the SHA-256 of `JSON.stringify(rows)`. Compare it only with another value made the same way; it isn't comparable to the SQL MD5 fingerprints (§16). Take a fresh baseline at the start of any session that might write.

---

## 12. Completed fixes — do not reopen without cause

| Fix | Commit |
|---|---|
| Dynamic TMDB identity migration; canonical `findExistingRow`; friendly 23505 handling; modular split; backup/restore | before `c5b592e` (tag `post-tmdb-migration-modularization`) |
| `addEntry()` client-side duplicate guard | `8ec56c0` |
| Same-title schema fix (DB) + Reservoir Dogs data fix (DB) | DB-only; tag `post-same-title-schema-fix` at `8ec56c0` |
| Id-backed MCU list, `pickTmdbMovieCandidate`, hardened `pullUniverse`, same-title person-credit UX, identity tests | `f9bbe62` |
| Apostrophe escaping in pull flows + title-attribute tests | `b82d578` |
| Canonical TMDB collection-name storage | `61058db` |
| Person-pull preview survives tag backfill | `d6aea9e` |
| Filter/search state preserved across same-tab re-renders | `5fc7ccd` |
| ↻ Refresh link only for real person collections | `3675650` |
| Refresh shows: TBA → confirmed-date updates on existing seasons (Silo S4, Hunting Wives S2 corrected) | `335104c` |
| Reusable read-only identity audit (`tools/identity-audit.mjs`) + offline controls | `b90de71` |
| Restore validation hardened before delete; safety-backup validation; identity-loss protection | `8c935f3` |
| TMDB search results follow the tab (crowding fix; `mixedMedia` on True Crime / Docs) | `0155979` |
| Mobile "⋯" popover (Watch with / Pull rest) works under 700px | `338583a` |
| Honest TMDB outage, partial-failure and partial-add reporting | `2a3c0de` |
| Match to TMDB for manual rows on dynamic tabs | `f8e31ac`, `4e050c2` |
| Match to TMDB skips redundant `othertv_shows` inserts | `4b2d7c9` |
| `fetchAllRows` accepts an optional PostgREST filter (backup/restore unchanged) | `8e92095` |
| Capture-at-start guards on 9 async add/match flows; fixes wrong-collection writes when switching tabs mid-flow (§4b) | `aa6e71a` |
| **Currently Watching** (default landing view) and **Coming Soon** derived TV views; boot no longer opens or seeds Disney+; `?v=` cache token (§2, §4a) | `fc9f796` |
| Offline page harness + derived-view, navigation and async-guard tests (54 cases) | `789d4f5` |
| Canonical handoff moved into the repo (`docs/HANDOFF.md`) | `6dfa0cd` |
| Up to date starts expanded; its cards read "Up to date"; cache token `?v=20261002-uptodate1` | `e003694` |
| Up to date cards: "Up to date" status label, and the next stored season (none / TBA / date / available) in Up next; cache token `?v=20261003-uptodate2` | `1486404` |

Other intentional behaviors:

- **TV status is show-level** (Phase 3): one status per show in `tv_shows`; seasons have Watched and Skip / Keep. **Up to date** (a Watching show none of whose remaining seasons has aired) is derived, never stored, and used everywhere; the 60-day **Caught Up** state is retired and its code removed (`bc43e2c`).
- `"Complete"` is a real stored show status; a genuinely new season reopens a Complete show to On List (Skipped shows stay Skipped).
- × on a **built-in TV season** skips it (reversible with ↩ Keep; never deletes). × on a **built-in film** sets its row status `skipped` after a confirm. Other rows are really deleted after a `confirm()`; deleting the last season of a show deletes the show (and, for an identified show, its Refresh-shows tracking).
- Match to TMDB never changes a show's status: it's **blocked** when the target show is already on the list with a different status; matching a TV season as a film unlinks it and removes a show it empties.

---

## 13. Product decisions (current policy)

- **Tehran Season 4:** do **not** add it yet; it's still effectively a TBA shell. Refresh shows may keep surfacing it. Add it later, once TMDB has useful season metadata.
- **Confirmed TV air dates:**
  - TBA → confirmed date is automatic (through Refresh shows, with the user clicking Apply).
  - An already-confirmed date is **never silently overwritten** when TMDB later changes it.
  - If confirmed-date drift appears, **surface it for review** (for example via the audit). Never auto-apply it to production.
- **Unmatch from TMDB:** deliberately **not built**. If a real mistaken match happens, design it as a separate feature that restores canonical legacy fields safely.
- **Restore UI browser smoke test:** skipped by choice; it may be revisited later.
- **Current confirmed-date drift (2026-09-30 audit, grade B, expected review items, not defects). Do not change either date unless the user decides to:**
  - The Traitors S5 (`othertv`, tmdb 215943, season 5): stored `2026-09-17`, TMDB `2026-09-16`.
  - Avengers: Doomsday (`movies`, tmdb 1003596): stored `2026-12-16`, TMDB `2026-12-15`.
- **Derived views, v1 decisions (2026-09-29):**
  - Up next = the earliest `Watching && !watched` season, **even if future or TBA**, shown without Mark watched.
  - **Up to date** only when every Watching season is watched.
  - A–Z order.
  - No show-level bulk status control and no delete control in either view.
  - Coming Soon: status select only, **no watch button** (including rows dated today); excludes only watched and skipped rows.
  - Up to date starts **expanded** (owner request, 2026-10-02, `e003694`). Coming Soon's TBA section still starts collapsed.
  - Up to date cards show "Up to date" in the Status column and the next stored season in Up next (owner request, 2026-10-03, `1486404`).
  - **Option A (2026-10-03):** a later season that has aired but isn't set to Watching is only *displayed* ("available since …"); it doesn't move the show back to In progress. Auto-promoting it, or having Refresh shows add new seasons as Watching, would be a separate change.
  - Movies → TV always returns to Currently Watching.
  - No date-horizon filters in v1.
  - The release boundary is re-derived on render only; there's no midnight timer.

---

## 14. Open issues / backlog

### Small / optional

- **Mobile tap targets:**
  - The × delete is 27×26 px (it does ask for confirmation).
  - Genre, collection and person tags are 19 px tall.
  - Status dropdowns and "Mark watched" are 30 px tall.
- **Stat cards:** the "Complete" progress bar sticks about 8 px outside its card, and "To watch" wraps onto two lines.
- **Refresh collections** group headers show the full "X Collection" wording instead of the short form.
- **Person pull:** the same-title header count includes already-added credits.
- **Universe pull:** already-added films have no date attached, so they sort to the bottom.
- **Rare two-tab first-load race** on a static tab can collide while reseeding defaults; `loadTab` can then show a raw database error.
- **A literal `\` in a title** could break inline JavaScript handler strings.
- **Restore safety-backup filename** only goes down to the minute (§10).
- **Review the two B-grade date drifts** (§13) and decide whether to update them (user decision; never auto-applied).
- **Canonical SQL fingerprints** (§16) were last recorded on 2026-09-28. The 2026-09-30 check used the anon-key hash method (§11a) and showed no change across the deployment. Re-run the SQL form when convenient.
- Possible derived-view enhancements, **not planned**: restore the last TV tab on Movies → TV; date-horizon filters in Coming Soon; ignoring a leading "The" when sorting.

### Larger / deferred

- Bulk actions (including a show-level status control in Currently Watching, deliberately left out of v1).
- Books/Games media types.
- **First-class TV shows with per-user ownership** (§18): **complete** (stage `final` since 2026-10-05, §18). The future sign-in (Auth/RLS) project is separate and needs its own approval.
- Possible **Unmatch from TMDB** feature (§13).

### Technical debt / intentional choices

- 296 static-tab rows remain legacy by design and aren't eligible for Match to TMDB.
- New MCU films must be added to `config.js` with verified ids.
- A TMDB collection rename would be **detected** by the consistency check but not reconciled automatically.
- The public TMDB read token and the permissive family-app RLS are accepted trade-offs.

### Closed since the previous handoff (do not re-add)

- The stale TBA-date problem
- Search crowding
- The mobile movie popover
- TMDB outage honesty
- Match to TMDB
- Formalizing the identity audit
- Restore validator hardening
- **Currently Watching and Coming Soon** (live since `fc9f796`, verified 2026-09-30)
- The cross-tab wrong-collection async race (`aa6e71a`)
- The restore mixed-state window (transactional restore, `02f304f` + production function, 2026-10-04)

---

## 15. Not recently re-tested — not known broken

- **A full destructive restore on production:** never run. Rehearsed only in isolated test projects (the 2026-09-26 one, since deleted, and the 2026-10-04 TV-migration test project, deleted 2026-10-05, where the transactional `restore_backup` ran over the real API as both the anonymous and signed-in roles).
- **The restore UI's browser plumbing** (the file picker and the real download).
- **Behavior on a physical phone.** Layout was checked only at 375 px browser emulation.

Items verified on 2026-09-26:
- True Crime / Docs Refresh shows (3 tracked shows, correct).
- Phone-width layout at 375 px (no overflow).
- TMDB slow, HTTP-error and network-down paths in every TMDB flow, after the fix.

**Derived-views deployment, verified 2026-09-30** on the deployed site. The page-memory write-block was installed before any interaction; every request afterwards was a GET, and **0 writes were attempted**:
- **Assets:** all 13 `?v=20260929-derived1` assets returned 200 and are byte-identical to `main`, including `derived-views.js`. The browser ran the new code.
- **Startup:** TV → Currently Watching. The boot made 2 paginated GETs of the 5 TV collections (641 TV rows) and nothing else. Disney+ was not loaded or seeded.
- **Desktop Currently Watching:**
  - 7 shows in progress, correctly A–Z, from both dynamic and static (legacy, no TMDB id) collections, with source badges.
  - A TBA up-next season showed "TBA", Upcoming and **no Mark watched**. Released seasons show Mark watched.
  - Expand and collapse work; an expanded show lists every stored season, with the release rule applied.
  - Up to date: collapsed, 4 shows (the default at the time; since `e003694` it starts expanded). Expandable, with an undo toggle.
  - Search, the Source filter, and the filter reset on view switch all work.
- **Desktop Coming Soon:**
  - 17 dated rows in date order; a row dated today was included, with a Today tag.
  - TBA is collapsed, 21 rows, including the static free-text "TBA 2026" row whose guessed `date_sort` is already past.
  - Status selects only; 0 watch buttons, 0 delete buttons.
- No films in either view.
- Movies works normally, Movies → TV lands on Currently Watching, and Other TV works normally after a view.
- No console errors.
- **Mobile, 375×812 browser emulation (not a physical phone):**
  - No horizontal overflow; cards stack.
  - Filters work; expansion, Up to date, Coming Soon and TBA all work; Movies ↔ TV works.
  - The tab bar scrolls sideways within itself, like before.
- **Production data** was unchanged before vs after (anon-key hashes, §17). The identity audit: 420 A / 2 B / 0 C / 0 D.

---

## 16. Testing assets

### Offline (no network)

```bash
# from the repo root

for f in *.js tests/*.js tests/*.mjs tools/*.mjs db/test/*.mjs; do
  node --check "$f" || echo "SYNTAX FAIL $f"
done

node tests/identity-candidate.test.js     # expect 9/9
node tests/title-attribute.test.js        # expect 5/5
node tests/season-date-update.test.js     # expect 8/8
node tests/restore-validation.test.js     # expect 35/35
node tests/search-selection.test.js       # expect 10/10
node tests/row-popover.test.js            # expect 5/5
node tests/tmdb-failures.test.js          # expect 21/21
node tests/tmdb-match.test.js             # expect 28/28
node tests/identity-audit.test.mjs        # expect 67/67
node tests/derived-views.test.js          # expect 20/20
node tests/derived-nav.test.js            # expect 24/24
node tests/tv-model.test.js               # expect 43/43
node tests/restore-rpc.test.js            # expect 3/3
node tests/backup-format.test.js          # expect 6/6
node tests/tv-writes.test.js              # expect 19/19
# total: 303 cases across 15 suites (tests/app-harness.js and tests/tv-model-reference.js are helpers, not suites)
```

### Handler/global sweep

Every inline-handler name must be a defined function. Expected: **55** handler names, none undefined, and no duplicate global function definitions (176 functions).

```bash
# from the repo root

grep -hoE '^(async )?function [A-Za-z0-9_]+' *.js \
  | awk '{print $NF}' \
  | sort -u > /tmp/defs

grep -hoE 'on(click|change|input|keydown)="[^"]*' *.js watchlist.html \
  | grep -oE '[A-Za-z_][A-Za-z0-9_]*\(' \
  | tr -d '(' \
  | sort -u \
  | grep -vxE 'if|replace|stopPropagation' > /tmp/handlers

wc -l < /tmp/handlers          # expect 55
comm -23 /tmp/handlers /tmp/defs
# expect no output

grep -hoE '^(async )?function [A-Za-z0-9_]+' *.js \
  | awk '{print $NF}' \
  | sort \
  | uniq -d
# expect no duplicates
```

### Identity audit (read-only, production)

```bash
# from the repo root
node tools/identity-audit.mjs
# last result (2026-10-05, after the Proud Family enrichment): 719 rows fetched (625 identified)
#         A 584 / B 41 / C 0 / D 0, RESULT: PASS
#         B rows: kept date drifts within 31 days, title-suffix/punctuation drift, and 7 provisional
#         future Disney+ seasons (§17, §18). All 6 exceptions "not applied" (none of those shows enriched).
#         Counts change with normal use: compare against a fresh run, not these numbers.
# exit codes: 0 = pass, 1 = C/D rows found, 2 = aborted (no result)
```

- It prints the Supabase host, the timestamp, and a read-only statement before starting.
- Every request is a GET, and any failed fetch or incomplete read aborts.
- About 13 movies are listed as "same-title works on TMDB". These are informational; all grade A.
- The audit makes many TMDB calls and can take a few minutes. A network timeout aborts it with "AUDIT ABORTED (no result)"; that isn't a data finding, so just re-run it.
- **Grades:**
  - **A**: exact title or accepted official alternative title (US/GB, excluding working/promotional/former titles); dates match; season identity matches.
  - **B**: benign drift, such as numeral/punctuation/article title differences, TBA→dated, dates within 31 days, or genre drift.
  - **C**: needs review, such as a material date mismatch, short vs. feature with a same-title feature available, a better-fitting same-title work, or a documentary mismatch.
  - **D**: wrong identity, such as a missing id or season, or a different title plus a date mismatch.
- The looser title matching here is **for grading only**. `identity.js` stays strict for writes.
- **Provisional future seasons (owner rule, 2026-10-05):** a season TMDB doesn't list is **D**, except a **B — "provisional future season not yet listed by TMDB (… not TMDB-verified)"** when *all* hold: its label is exactly `Season N`; N is **exactly the next season after TMDB's highest listed season** (no gap, no lower number); no TMDB season already carries the name `Season N`; it is TBA or future-dated; and the show title matches. Once it is released and still absent from TMDB it is **D**. When TMDB lists it, normal grading applies. Every other missing-season case needs review; never invent or change a season number to improve a grade.
- **Owner-approved exceptions (2026-10-05, `tools/identity-exceptions.json`):** a reviewed, evidence-backed case can turn **one specific C finding into B (never A)**. Each exception is bound to the collection, media type, TMDB id, season (where it has one) and the exact local and TMDB values it was approved for, with a reason and evidence URLs; if any bound value changes, the finding is a C again. An exception never applies to a D, to a provisional season, or to any other finding, so remaining C/D still fail. The file is validated (a malformed file aborts the audit with no result), and the audit lists every exception as *applied* or *not applied* with the reason. Current six (since the 2026-10-05 enrichment of Visions, Rebels and The Acolyte, the first five are *applied*; The Single Life is not enriched, so its exception is "not applied"): Star Wars: Visions "Volume 1/2/3" → seasons 1/2/3 (114478; label bound to its season and TMDB's season name), Star Wars Rebels S2 stored premiere 2015-06-20 vs TMDB 2015-10-14 (60554; "The Siege of Lothal"), the curated title "Star Wars: The Acolyte" (114479; TMDB lists it only as a working title), and 90 Day: The Single Life S1 stored TLC premiere 2021-08-09 vs TMDB's discovery+ date 2021-02-21 (118422). When an exception covers its own finding but another finding leaves the row C or D, the report says **"applied, ROW STILL FAILS"** and the audit still fails. New exceptions need the owner's approval.
- **Unknown runtime (2026-10-05):** a same-title TMDB work counts as a feature only with a known runtime of at least 40 minutes; TMDB's 0 means unknown, so an empty record no longer creates a short-versus-feature C (the date-based "fits the stored date better" check is unchanged).

### Production fingerprints (read-only; SQL Editor)

```sql
-- Last known counts (2026-10-05, after the Disney+ enrichment): 719 / 64 / 1, and 197 tv_shows.
-- Normal use changes these; the baseline is whatever this returns at the start of the session.
-- Run this read-only at the start of any session that might write, and use the result
-- as that session's baseline; re-run it afterwards to prove nothing else changed.
-- The o_* hashes use the ORIGINAL columns only, so they are comparable with
-- pre-Phase-1 values (whole-row t::text now includes user_id/show_id/skipped).
-- The n_* hashes cover the Phase 1c additions (everything except user_id).
select
  (select count(*) from public.watchlist_items) w_n,
  (select md5(string_agg(row(t.id, t.collection, t.item_key, t.title, t.season, t.theme, t.display_date, t.date_sort,
     t.watched, t.status, t.created_at, t.watch_with, t.collections, t.tmdb_collection_id, t.tmdb_collection_name,
     t.media_type, t.tmdb_id, t.season_number)::text, '|' order by t.id)) from public.watchlist_items t) w_o,
  (select count(*) from public.othertv_shows) o_n,
  (select md5(string_agg(row(t.id, t.tmdb_id, t.title, t.network, t.created_at, t.collection)::text, '|' order by t.id))
     from public.othertv_shows t) o_o,
  (select count(*) from public.custom_collections) c_n,
  (select md5(string_agg(row(t.id, t.name, t.tmdb_person_id, t.created_at, t.role)::text, '|' order by t.id))
     from public.custom_collections t) c_o,
  (select count(*) from public.tv_shows) s_n,
  (select md5(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id)) from public.watchlist_items t) w_n_all,
  (select md5(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id)) from public.tv_shows t) s_n_all;
```

Collection consistency (expect 0 rows from each):

```sql
select tmdb_collection_id, array_agg(distinct tmdb_collection_name)
from public.watchlist_items
where tmdb_collection_id is not null
group by 1
having count(distinct tmdb_collection_name) > 1;

select w.tmdb_collection_id, array_agg(distinct c)
from public.watchlist_items w, unnest(w.collections) c
where w.tmdb_collection_id is not null
  and regexp_replace(c, '\s+Collection\s*$', '', 'i')
      = regexp_replace(w.tmdb_collection_name, '\s+Collection\s*$', '', 'i')
group by 1
having count(distinct c) > 1;
```

### Useful live regression checks

Use page memory, with writes blocked, unless a write is explicitly approved.

- **MCU pull** with all films present: 39 direct `/movie/{id}` lookups, 0 title searches, 0 database writes, and "0 new, 39 already on your list".
- **Refresh shows (Other TV):** 61 identified shows (from `tv_shows`). Tehran S4 is offered (a policy decision not to add it), and nothing else (re-verified 2026-10-05).
- **True Crime / Docs Refresh shows:** 3 tracked shows, "Everything's up to date".
- **Search "Dune":**
  - Movies → 6 films including Dune: Part Two.
  - Other TV → series first.
  - True Crime / Docs → 4 series then films.
- **Outage simulation:** Refresh shows and Refresh collections say "Couldn't check TMDB right now… Nothing was changed" (never "up to date").
- **Mobile 375 px:** the "⋯" popover on a movie card opens inside that card.
- **Derived views:** see the 2026-09-30 checklist in §15 (startup GET-only; TBA up-next season without Mark watched; Up to date section; Coming Soon today row and TBA section; no films; Movies → TV).
- **After any temporary test:** all fingerprints equal the session's starting baseline, and the audit equals the session's starting audit (586 A / 47 B / 0 C / 0 D as of 2026-10-05).

---

## 17. Source-of-truth baseline (verified 2026-10-05, after the migration was completed)

```text
Repo:                     the local Git checkout of this repo (github.com/jaredsclove/Watchlist)
Branch:                   main (in sync with origin/main), working tree clean
HEAD:                     "Update handoff after the Love in Paradise S3 date correction" (docs-only; parent 2186a11 ← 34b8150)
Last database commit:     0c3c434  enriched-show guard fix (db/rpc.sql + db/test/t_enrich.sql), installed in production 2026-10-05
Last app-code commit:     2186a11  config.js: Love in Paradise S3 date (deployed and verified on Pages, 2026-10-05)
Tracked files:            73 (18 app, 1 doc, 27 in db/, 18 in tests/, 8 in tools/, .gitignore)
                          all 18 app files byte-identical on GitHub Pages (verified at 2186a11); 14 versioned assets 200
Offline tests:            303/303 passing (15 suites); 55 inline handlers, none undefined; 176 functions, no duplicates
Cache token:              ?v=20261005-enrich1 (13 JS files + styles.css); config.js unversioned

watchlist_items:          719 rows
othertv_shows:             64 rows
custom_collections:         1 row   ("Quentin Tarantino", tmdb_person_id 138, director)
tv_shows:                 197 rows  (disney 103, othertv 62, 90day 15, sheridan 14, truecrime 3; 164 identified:
                          disney 85, othertv 62, sheridan 8, 90day 6, truecrime 3)
                          show status (authoritative): confirmed (On List) 138, pending 35, watching 10, skipped 10,
                          complete 2, maybe 1, highpriority 0
TV seasons linked:        642 of 642 TV rows; 77 non-TV rows (films) unlinked; 39 seasons skipped = true (Tales of the Jedi S2 added 2026-10-05); 126 rows watched
Compatibility copies:     season status = the approved projection for all 196 shows at the start of final; no longer written

Fingerprints:             not published here. Compute the current baseline read-only (SQL MD5, §16; or the
                          anon-key hash method, §11a). Unchanged by Phase 0–2; Phase 3 changed only 84 season status copies (normalization).

Database:                 stage final (§5, since 2026-10-05 14:32 UTC). user_id NOT NULL on all public tables, one bootstrap
                          owner, owns every row; clients can't write user_id. tv_shows.status is authoritative for TV;
                          season status populated but unused; othertv_shows populated but unused. public.restore_backup (= db/restore_backup.sql), private helpers (= db/tv_model.sql)
                          and the TV functions (= db/rpc.sql at 0c3c434), all verified by MD5. private.tv_add_to_enriched_show
                          source MD5 73478474edae6c0dd573615d12079be4 (guard fix, installed 2026-10-05; 31 public/private functions). No production Auth users, no FK to auth.users.
                          RLS: 16 permissive anon policies (the original 12 + 4 on tv_shows).

Rows per tab:             disney 182, 90day 72, sheridan 42, othertv 355, truecrime 7 (3 TV + 4 films), movies 61
TV rows in derived views: 642 (all linked to a show)
Unidentified rows:        86 (static DEFAULTs not enriched; 0 manual dynamic rows)

Identity audit:           719 rows, 633 identified → 586 A / 47 B / 0 C / 0 D, PASS (node tools/identity-audit.mjs, 2026-10-05)
                          B = The Traitors S5 and Marshals S1 (one-day drifts, kept) + 90 Day Fiancé S4 and The Last Resort S1
                          (stored dates kept, within 31 days) + Proud Family S1 and S3 (one-day differences, kept) + 35 Disney+ seasons: stored dates
                          within 31 days, title differences such as "(Netflix)"/"(2008)" suffixes or "–" vs "-", and 7
                          provisional future seasons (Alien: Earth S2, Daredevil: Born Again S3, Marvel Zombies S2,
                          Shōgun S2, Maul – Shadow Lord S2, X-Men '97 S3, Your Friendly Neighborhood Spider-Man S2)
                          + Star Wars Rebels S1 (10-day difference, kept) + 5 owner-approved exceptions (§16): Rebels S2,
                          The Acolyte S1, Star Wars: Visions Volume 1/2/3
Collection consistency:   42 rows / 16 TMDB collections / 0 problems (last verified 2026-09-26)

Backups:                  kept outside the repo. Sheridan enrichment: before 18:54 UTC, after 19:04 UTC. Disney+ enrichment: before
                          19:51 UTC, after 20:11 UTC. Tales of the Jedi skip: before 21:08, after 21:09. 90 Day enrichment: before
                          21:35 UTC, after 21:38 UTC. Proud Family S2 correction: before 21:47, after 21:48 UTC.
                          Proud Family enrichment: before 21:53, after 21:54 UTC. Guard-fix install: before 22:24, after 22:27 UTC.
                          Rebels/Acolyte/Visions enrichment: before 22:31, after 22:36 UTC. Love in Paradise S3 correction: before 23:05,
                          after 23:07 UTC (2026-10-05; format 2, 719/197/64/1, valid).

Tags:
  post-tmdb-migration-modularization → c5b592e
  post-same-title-schema-fix         → 8ec56c0
  pre-derived-views                  → e2c1c16   (local only, not pushed)
  pre-tv-shows                       → b266a5b   (local only, not pushed)

Supabase:                 the production project only. The temporary TV-migration test project was deleted by the owner
                          on 2026-10-05; rehearsals run locally (tools/db-rehearsal.mjs on PGlite).
```

---

## 18. Recent completed work and what's next

### Completed: Currently Watching and Coming Soon (2026-09-29 to 09-30)

- **Process:** a planning-only round and a revised plan (both reviewed by the user), then implementation with offline tests first, then a checkpoint review, then the push, then deployed verification with writes blocked.
- **Commits:** `8e92095`, `aa6e71a`, `fc9f796`, `789d4f5`. There were no schema, data, RLS or backup-format changes.
- **Behavior:** §4a. **Async guards:** §4b. **Cache token:** §2. **Verification:** §15.
- **Rollback, if ever needed:** `git revert` those four commits (or compare against the local tag `pre-derived-views` → `e2c1c16`). No data needs undoing.

### Completed: Phase 0 of the first-class TV-show migration (2026-10-04)

The approved design (planned over several review rounds): user-owned `tv_shows` with show-level status, seasons with `watched` and `skipped`, up next derived from the furthest watched season, one released-only "Up to date" rule, the Complete → On List reopen rule, a bootstrap owner until a later sign-in project, owner-scoped database functions, and per-user transactional restore. `db/README.md` lists the scripts in phase order.

- **Production change (approved):** the transactional v1 `restore_backup` function (§10) and the app change that calls it (`02f304f`, token `?v=20261004-restore1`). Nothing else changed in production; no restore was executed.
- **At the end of Phase 0, production was still on the old single-user schema:** no `user_id`, no `tv_shows`, no `private` schema, no production Auth users.
- **Local rehearsal** (PGlite, real backup): every phase, 82 SQL self-checks, all 196 migrated shows equal to the JavaScript reference, shadow → switch-over → rollback with no status lost, and a full rollback leaving the schema identical and the data equal to production's fingerprints.
- **Test project rehearsal** (Supabase): the same scripts and checks; direct inserts through the real API with `user_id` protected; concurrent adds; v2 restore round trip; switch-over and rollback; and a **genuine-Auth two-user isolation test through the real API: 39/39** (reads, direct writes, `user_id` tampering, every browser-facing function, seeding, reopen, restore, cross-user id collisions, signed-out access). Sessions were not persisted and both users were signed out.
- **Test project state:** locked: the copied production data belongs to test user A; owner-only authenticated access rules; no anonymous access to tables or functions. Deleting the temporary project is planned once Phase 1 rehearsals no longer need it.
- **Test-project identifiers (cleanup `9eb622a`):** the current repo no longer contains the temporary project's ref, its publishable key or the test-user ids. They're supplied locally through untracked files (`tools/auth-isolation-test.local.js`, `db/test/local_test_users.sql`; templates `*.example.*`, excluded by `.gitignore`); the page and scripts refuse to run without them, and the page refuses production values. Older public Git history (the Phase 0 commits up to `2bc3410`) still contains the former values: none is a credential, the project is locked, and **no history rewrite was done** by owner decision. They become inert when the project is deleted.
- **Disclosures** (all reported to the owner at the time):
  - one POST to production's `rpc/restore_backup` endpoint, before the function existed, to check it wasn't installed; it returned 404 and nothing ran. Production capability checks now use the catalog only;
  - a browser batch the owner rejected had already applied Phase 1b to the test project (test project only); it was verified and kept, as the step was then approved;
  - an attempt to serve a test page through the app's preview tool briefly started an unrelated project's dev server; it was stopped within seconds and the added configuration removed.

### Completed: Phase 1 of the TV-show migration (2026-10-04, approved)

- **Starting baseline:** 718 / 64 / 1, the old single-user schema, Phase 0 `restore_backup` only; a validated format-1 backup taken immediately before.
- **1a (app, `b266a5b`, token `?v=20261005-phase1a`):** backup/restore in format 1 or 2 without `user_id` (§10), `SHOW_KEY_OVERRIDES` (Clone Wars). No visible behavior change. Verified: 17 app files byte-identical on Pages, 13 assets 200, GET-only load, a valid format-1 backup, no console errors.
- **Local tag `pre-tv-shows` → `b266a5b`** (not pushed), after a fresh validated format-1 backup and fingerprints.
- **1b (production SQL):** `db/phase1b_ownership.sql` + `db/restore_backup.sql`, run exactly as committed (file hashes checked in the editor before each run). Verified from the catalog only (no production write probes): one owner owning 718 / 64 / 1, 0 NULL `user_id`, `user_id` NOT NULL with the owner as the default, the exact expected indexes, `user_id` writable by no client role and every other column writable, `private` closed, function sources equal to the files, 0 Auth users, fingerprints unchanged, a valid format-1 backup, app loads.
- **1c (production SQL):** `db/phase1c_tv_schema.sql` + `db/tv_model.sql` + `db/phase1c_backfill.sql` (whose exact-count assertions passed). Results: 196 shows (Disney+ 103, Other TV 61, 90 Day 15, Sheridan 14, True Crime / Docs 3), 64 identified; 641 TV rows linked, 0 TV unlinked, 77 non-TV unlinked; 38 skipped flags; statuses watching 10, confirmed (On List) 138, complete 2, pending 35, skipped 10, maybe 1; 0 unmapped. **Clone Wars:** one show "Star Wars: The Clone Wars (2008)" with Seasons 1–7; the 2008 film is unlinked.
- **1c verification:** 0 duplicate shows, 0 cross-owner or cross-collection links, 0 TMDB mismatches; original-column fingerprints unchanged; identity audit 421 A / 1 B / 0 C / 0 D; **all 196 production shows equal the JavaScript reference** (status, skipped seasons and up next; one canonical MD5 computed both ways); every `private` helper and `restore_backup` source equals the committed files by MD5, and the shared cases pass against those files locally (`tools/db-rehearsal.mjs`, 8/8 `t_1c` checks) and passed on the test project; a fresh **format-2 backup** taken with the deployed code is valid (4 tables, 20/7/6/5 columns, no `user_id`); the app still loads with GET only and shows the old model.
- **Rollback readiness:** `db/rollback/phase2_and_1c.sql` (undoes 1c), then `db/rollback/phase1b.sql` + `db/phase0_restore_v1.sql` (undoes 1b), rehearsed in Phase 0 (above); the pre-1b format-1 backup; `pre-tv-shows` for the app. App code needs no rollback for 1b/1c.

### Completed: initial Phase 2 (shadow) deployment (2026-10-05, approved)

- **Baseline before:** stage `tv_schema`; 718 items, 641 TV rows (all linked), 196 shows, 38 skipped flags, statuses as in §17; fingerprints unchanged since Phase 1; identity audit 421 A / 1 B / 0 C / 0 D. A fresh validated format-2 backup was taken first (content identical to the after-1c backup).
- **Database (production SQL, exact committed files, hash-checked in the editor):** `db/rpc.sql` (all 26 `public`/`private` function sources then equal a local build of the committed files by MD5), then the Phase 2 block of `db/stages.sql` (stage → `shadow`), then `private.tv_shadow_resync` for the owner: fully mapped, nothing changed (196 shows, same statuses, 38 flags, 0 empty shows).
- **App (`09f24aa`, token `?v=20261005-phase2`):** six TV structural paths use the functions: default seeding (`seed_tv_defaults`, only the defaults missing by `item_key`), Refresh shows and TMDB search TV add (`add_tv_seasons`, one call per show; it also registers the show for Refresh), manual Add entry of a TV season (`add_tv_seasons`, legacy show key incl. the Clone Wars override), Match to a TV season (`match_tv_row`) and Delete of a non-default TV season (`delete_tv_season`). Films, movies and every status, watched, skip, watch-with and date edit stay direct writes. A season the database already has is reported with the usual "already on your list" messages.
- **Approved behaviors:** (1) **Match to film** of a row linked as a TV season sets its `show_id` to null in the same update (films are never linked); a legacy show left empty is removed by the next resync. (2) **Deleting the last season** of a show deletes the now-empty show and, for an identified show, its Refresh-shows tracking entry; skipping a season never deletes anything.
- **Verification:** the database equals the JavaScript reference for all 196 shows (one canonical MD5); old aggregate status = shadow status for every show; shadow status and skip flags = the approved rules (0 unmapped); 0 unlinked TV rows, 0 linked films, 0 owner/collection/TMDB mismatches, 0 duplicate show identities; Currently Watching membership and up next unchanged; Coming Soon identical (13 dated, 21 TBA). **Known future-model difference (not shown in Phase 2):** Severance becomes Up to date under the released-only rule. On production data the Phase 2 app renders all 9 tabs and views byte-identically to the previous app with no writes; the Chrome smoke check made reads only and production stayed byte-identical. Offline 255/255; local end-to-end run of the app's real function calls against the committed SQL (18/18); the full local rehearsal incl. every rollback passes. A post-deploy format-2 backup taken with `09f24aa` validates.
- **Rollback (rehearsed):** app → `git revert 09f24aa` (back to the Phase 1a app); database → `db/rollback/phase2_and_1c.sql` (removes the TV functions, links, `skipped` and `tv_shows`; stage → `ownership`), then `db/rollback/phase1b.sql` + `db/phase0_restore_v1.sql` if needed. Validated format-2 backups exist from before and after the deployment.

### Phase 3 readiness (event-driven; met 2026-10-05)

There is no fixed waiting period. Report Phase 3 as ready for approval only when all hold:
1. the Phase 2 deployment and smoke checks are clean (done 2026-10-05);
2. 0 unexplained old-vs-shadow differences; 3. 0 unlinked TV rows; 4. 0 owner/collection mismatches; 5. 0 duplicate show identities; 6. 0 linked films; 7. 0 unmapped status patterns; 8. the database-vs-JavaScript comparison is clean; 9. the Coming Soon comparison is clean; 10. a format-2 backup validates; 11. the rollback rehearsal stays green;
12. **at least one real TV structural write** (Refresh adding a genuinely new season, a manual or TMDB TV add, default seeding of a new season, Match to TMDB, or a dynamic TV-season delete) has happened under Phase 2, and its row was verified read-only: linked at once to the right show (used or created), right owner and collection, the old season status intact, the shadow status derivable, no duplicate show, the resync fully mapped, old-vs-shadow still clean.

**All 12 criteria were met on 2026-10-05; Phase 3 was then approved.** Criterion 12 was satisfied by an owner-approved controlled production write at stage `shadow`: through the live deployed app, Add entry on the Sheridan tab added the season `ZZ Phase2 Test` to the existing legacy show `1923` via `add_tv_seasons`. It linked at once to that show (no new show), with correct owner and collection; the season status stayed authoritative; the shadow stayed derivable; the resync stayed fully mapped; old-vs-shadow (0 differences), database-vs-JavaScript and Coming Soon all stayed clean; the identity audit stayed 421/1/0/0. The live app's Delete then removed it via `delete_tv_season`, and production returned exactly to the pre-test state (every fingerprint equal; the backups before and after match). A legacy show was used on purpose: a synthetic season on a TMDB-identified show would need a fake TMDB season identity, which the audit would grade D.

(Phase 2's stop condition, a Complete show getting a new season, never occurred; Phase 3's reopen rule now handles it.)

### Completed: Phase 3 — show status authoritative (2026-10-05, approved)

- **Pre-switch:** baseline exact (718 / 641 TV / 196 shows, 641 linked, 0 unlinked, 38 skip flags, statuses as §17, audit 421/1/0/0, 0 Auth users); a fresh validated format-2 backup (14:00 UTC); the final `tv_shadow_resync` was fully mapped and changed nothing; old-vs-shadow, database-vs-JavaScript (one canonical MD5), Coming Soon and link checks all clean.
- **App first, then switch:** the Phase 3 app (`a182eae`, `62b5b71`) was built and tested before any production change: offline suites; a local end-to-end run of the real app against the committed SQL at `authoritative` (show status, Watched, Skip / Keep with exact projections, reopen, "Already on your list", blocked Match, film-match unlink + empty-show removal, last-season delete, built-in × = Skip, format-1 restore refused, database up next = app up next for every show, Phase 3 rollback keeps every status); the full committed rehearsal including every rollback.
- **Switch (one guarded transaction, owner-approved):** the committed Phase 3 block of `db/stages.sql` (guards: stage must be `shadow`, no unlinked TV seasons; stage → `authoritative`) followed, before `commit`, by the committed `private.tv_project_legacy_status` for every show, so every compatibility copy matches the approved projection. Rehearsed locally on the same data first (only `status` changed; a second run is refused by the guard). Production effect, verified by a field-by-field backup diff: **exactly 84 season `status` copies across 15 shows** (75 watching→confirmed, 9 pending→confirmed; e.g. Survivor, Curb Your Enthusiasm, Better Call Saul, and nine On List shows with one pending season), each the predicted value; **no other field and no other table changed**; show statuses, watched, skipped and links unchanged.
- **Verified after the switch and deploy:** stage `authoritative`; projection exact for 196/196 shows; old aggregate status = show status for all; database = JavaScript reference; function sources unchanged; Pages = `main` (14 assets, token `20261005-phase3`); Chrome smoke check (reads only, no errors); Currently Watching 6 in progress + 4 Up to date (Severance moved to Up to date as expected); Coming Soon identical to before (13 dated, 21 TBA) with Skip-only controls; films unchanged and unlinked; Clone Wars one show (Season 1 = Watching anchor); identity audit 421/1/0/0.
- **Functional checks on production (owner-approved, ordinary reversible actions, net zero change):** on 1923 (Sheridan) — the show control ("Show: …", "Applies to all seasons of 1923") set Watching → the show joined Currently Watching with the projection exact; Mark watched advanced up next; Skip made it Up to date, Keep restored it; × on its built-in season skipped (no delete), Keep restored; back to On List → it left Currently Watching. On Dark Winds (Other TV) the grouped show control round-tripped. Every step made exactly one function call; afterwards the database was byte-identical to before. A real dynamic delete was not run on production (it would delete real data); it is covered by the local end-to-end run.
- **Rollback (rehearsed, not needed):** app → `git revert 62b5b71 a182eae`; database → the "Rollback of Phase 3" block of `db/stages.sql` (stage → `shadow` + `tv_shadow_resync`, which rebuilds show statuses from the compatibility copies; every status is kept), then if needed `db/rollback/phase2_and_1c.sql` etc. Backups before (14:00) and after (14:08) the switch are kept.

### Completed: stabilization exit test and the final stage (2026-10-05, approved)

Instead of a waiting period, an immediate exit test (owner decision), then `final`:
- **Exit criteria, all green:** integrity (196 shows, 641 linked, 0 unlinked, 0 linked films, 0 owner/collection/TMDB mismatches, 0 duplicates, 0 unmapped; Clone Wars and films correct); projection exact 196/196; derived views (up next for all 196 = database = reference; Currently Watching 6 + 4; Coming Soon 13 + 21 identical to the old app; the scramble test proves no TV view reads season status); backup/restore (format-2 backups valid without `user_id`; format 1 refused; a format-2 restore of the production snapshot round-trips exactly, locally); rollback (full rehearsal green). Local checks ran on an exact replica of production (its own ids, through the real `restore_backup`) with the committed functions as `anon`: reopen (new season → On List in the same call; duplicate, date-only update, Match and a Skipped show don't reopen), add (mixed counts, invalid input fails the whole call, identity conflict rejected, repeats are no-ops), delete (non-final season keeps the show, last season removes it, Skip never deletes, films unchanged), Match (TV → TV, TV → film with show removal, conflicting status blocked, no reopen, no linked film).
- **Refresh date-only edge case:** 206 date-only edits on every season of all 10 Watching shows changed no up next and left no compatibility copy stale: a Refresh date update only touches identified seasons (unique season numbers), and no Watching show's order depends on a date. Harmless; and at `final` the copies aren't written anyway (rollback re-projects, below).
- **Found and fixed before `final`:** (1) a film match whose show kept other seasons showed a misleading error, because RESTRICT answers `23001`, not `23503` (`1127320`; data was never affected); (2) at `final` the functions stop keeping `othertv_shows`, which Refresh read — Refresh now reads the identified shows in `tv_shows` (`59dd6a1`); on production both gave the same 64 shows (61 Other TV + 3 True Crime / Docs; same TMDB ids, titles, collections), and the real Refresh preview offered exactly Tehran S4, as before.
- **Final:** a validated backup (14:30 UTC) and projection 196/196 one last time; then the committed C1 block of `db/stages.sql` (guard: stage must be `authoritative`), hash-checked. No data changed (pre/post backups identical); stage `final`; database = JavaScript; Pages = `main`; Chrome smoke clean (Refresh reads only `tv_shows`); identity audit 421/1/0/0.
- **Cleanup (`bc43e2c`):** removed the retired Caught Up helper and constant and the app's last writes to `othertv_shows`; the test harness defaults to stage `final`. Not done, by design: dropping the season `status` column or `othertv_shows`.
- **Rollback from `final` (rehearsed locally from a production replica with drift):** keep the new app → `db/rollback/final.sql` (stage → `authoritative` + re-project every show). Revert the app to a version whose Refresh reads `othertv_shows` (before `59dd6a1`) → also `db/rollback/othertv_from_tv_shows.sql` first, then the Phase 3 rollback block, then `git revert`; further back as before. Every show status, the old app's status/up-next derivation and its Refresh list were verified after each step.
- **The temporary test project** was deleted by the owner on 2026-10-05 (no longer needed: all rehearsals run locally on PGlite). Its identifiers in older Git history and in the untracked local config files are now inert; `tools/auth-isolation-test.html` and `tools/db-rehearsal-rest.mjs` would need a new test project before reuse (e.g. for the future sign-in project).

### Completed: TMDB identity enrichment — Sheridan (2026-10-05, approved)

A separate identity-only project for legacy shows in the built-in collections, starting with Sheridan. **Rule: no ambiguous match without the owner's explicit decision; "no match" is a valid permanent outcome; season mappings are never forced.**
- **Review (read-only):** all 14 legacy Sheridan shows checked against TMDB search, details and Taylor Sheridan's TMDB credits. Owner decisions: **approved** 1883 (118357), 1923 (157744), Landman (157741), Tulsa King (153312), Marshals (290856; keep the stored Mar 1 date), Lawmen: Bass Reeves (157732), Frisco King (296244), Special Ops: Lioness (113962 "Lioness"; keep the local title). **Wait** until TMDB lists the season cleanly: Mayor of Kingstown (Season 5), Dutton Ranch (Season 2), The Madison (TMDB lists 1 and an empty 3, no 2; don't map 2→3). **Yellowstone:** unmatched — Season 5 Part 1/Part 2 are both TMDB season 5 (episodes 1–8 / 9–14) and the schema can't represent parts without an extension (not part of this project). **1944, 6666:** no match for now (not on TMDB).
- **Mechanism (`a5c0a12`):** `private.tv_enrich_show(show_id, expected_title, tmdb_id, seasons, apply = false)` (`db/admin/tv_enrich.sql`): admin only (not executable by anon/authenticated/PUBLIC); dry run by default; one show per transaction; guards for expected title, owner, collection, already-matched show, duplicate show identity, every season mapped exactly once with its current label, duplicate season numbers and existing season identities. It changes only `tv_shows.tmdb_id` and, per season, `media_type = 'tv'` (required by the identity shape check), `tmdb_id`, `season_number`. Plus the built-in-season guard (§5) and the audit rule (§16).
- **Production run:** fresh validated backup; the generated calls re-checked against current data (all 8 matched; one unrelated real write had happened meanwhile — "WAR" S1 added from TMDB search on Other TV, linked correctly); `db/rpc.sql` and `db/admin/tv_enrich.sql` installed hash-checked (31 function sources = the committed files; permissions verified); app `4550060` deployed (Pages verified, read-only smoke clean); production dry runs equal to the plan; then one transaction per show, each verified: counts 719/197/642 linked unchanged, every non-identity field and the other tables byte-identical, up next and statuses unchanged, 0 mismatches/duplicates.
- **Result (field-by-field backup diff):** 8 shows × `tmdb_id`; 17 seasons × (`media_type`, `tmdb_id`, `season_number`); all in Sheridan; nothing else changed. Identity audit 438 A / 2 B / 0 C / 0 D (440 identified; the new B is Marshals S1's one-day date difference, kept). The Sheridan tab loads with reads only and the same titles/dates.

### Completed: TMDB identity enrichment — Disney+ (2026-10-05, approved)

Same rules and mechanism as Sheridan (above).
- **Review (read-only):** all 103 legacy Disney+ shows (`tools/tmdb-enrich-candidates.mjs disney`, plus TMDB details, alternative-title types, episode lists, networks/companies and extra searches). **Owner decisions:** 73 shows approved as proposed; **Doctor Who → 239770** (the 2024 run; not 57243 or 121); 7 shows with a **provisional future season** approved after each season was confirmed by a public announcement and a repo record (Alien: Earth 157239 S2, Daredevil: Born Again 202555 S3, Marvel Zombies 138505 S2, Shōgun 126308 S2, Star Wars: Maul – Shadow Lord 289219 S2, X-Men '97 138502 S3, Your Friendly Neighborhood Spider-Man 138503 S2). Every mapped label is exactly `Season N` → TMDB season N.
- **Held (unchanged, owner decision):** **Wonder Man** — TMDB marks it Canceled while the catalog has Season 2 (TBA); needs separate research.
- **Unmatched (21, owner decision; nothing changed):**
  - *valid identity, blocked only by audit metadata rules (later resolved: Proud Family, Visions, Rebels and The Acolyte were enriched on 2026-10-05, below):* Star Wars: Visions (114478; Volume N = TMDB N, but non-`Season N` labels grade C), Star Wars Rebels (60554; stored S2 date is "The Siege of Lothal", a TMDB special → C), The Proud Family: Louder and Prouder (125438; stored S2 date Sep 28, 2023 vs TMDB Feb 1, 2023 → C), Star Wars: The Acolyte (114479; "Star Wars: The Acolyte" is only a TMDB working title → C);
  - *incompatible season structure:* Star Wars: Clone Wars (2003) (3122; Volume 1 = TMDB S1+S2), Limitless with Chris Hemsworth (Season 2 is a separate TMDB show, 296258), Star Wars: Tales of the Jedi (203085; TMDB has no S2 → D);
  - *movie vs TV:* 14 single-row "Special" shows that TMDB lists as movies (Ciao Alberto, Frozen Fever, Guardians of the Galaxy Holiday Special, Lamp Life, LEGO Star Wars Holiday Special / Summer Vacation / Terrifying Tales / The Mandalorian, Muppets Haunted Mansion, Myth: A Frozen Tale, Olaf's Frozen Adventure, Once Upon a Snowman, Werewolf by Night, The Punisher: One Last Kill).
  The audit, schema, labels, dates and classifications were not changed to make these pass.
- **Rehearsal (local, PGlite):** replica built from the committed `db/*.sql` and stage blocks, then the fresh production snapshot loaded through `restore_backup` at stage `final` (field-by-field equal to the snapshot). `db/phase1c_backfill.sql` asserts the 2026-10-04 counts (718 rows), so its expected counts were replaced **in memory only** with the snapshot's; the file is unchanged. 43/43 checks: exact generated files by SHA-256; pre-flight and dry run equal to the manifest; guards (wrong title, unmapped/duplicate season, foreign row, wrong label, identified/unknown show); atomicity (a failed apply, including a self-check failure injected with a replica-only trigger, leaves nothing); per-show and whole-batch diffs; up next for all 197 shows; duplicate prevention; the app harness (Disney+ tab GET-only and byte-identical, Currently Watching / Coming Soon rendered byte-identically, seeding all 182 defaults a no-op, later `Season N` joins / other labels rejected); expected grades; and the per-show identity-only rollback scripts (replica back to the snapshot exactly).
- **Production run:** fresh validated backup (table hashes equal to the rehearsed snapshot; regenerated files byte-identical, so no re-rehearsal); catalog check (31 `public`/`private` function sources by MD5, `tv_enrich_show` not executable by anon/authenticated, stage `final`) equal to the rehearsed environment; read-only pre-flight (144 rows, 0 mismatches) and production dry run (equal to the rehearsed output by hash); then **81 SQL Editor runs, one show per statement/transaction**, each pasted with its SHA-256 checked in the page before Run. Each statement re-verified itself in the transaction (nothing but that show's identity changed; counts and up next unchanged) and each result was checked again read-only against the pre-run backup before the next run. No failure, retry or partial state.
- **Result:** post-verification 719 / 197 / 642 linked, 81 Disney+ shows and 144 seasons identified, 584 identified rows, 0 mismatches/duplicates. **Field-by-field backup diff:** exactly 81 × `tv_shows.tmdb_id` and 144 × (`media_type`, `tmdb_id`, `season_number`), each the planned value; `othertv_shows` and `custom_collections` byte-identical; 0 unexpected changes. Identity audit **547 A / 37 B / 0 C / 0 D** (exactly as predicted; no TMDB drift during the run). Deployed site in Chrome with writes blocked in page memory: the Disney+ tab loaded with 2 GETs (no seeding, no review note), Currently Watching 6 + 4 and Coming Soon 13 dated + 21 TBA as before, 0 write attempts.
- **Rollback, if ever needed:** per-show identity-only guarded rollback scripts were generated and rehearsed; they are kept outside the repo with the run files (they contain row ids). A Restore is not a rollback path (its identity-loss check refuses pre-run backups). Nothing has been rolled back.
- **Findings left for the owner at the time:** Wonder Man S2 vs TMDB "Canceled"; Daredevil: Born Again S3 reported as the final season, premiering March 2027 (standing decision keeps "TBA 2027"; outside this work); Tales of the Jedi S2 (Oct 26, 2023) and Proud Family: Louder and Prouder S2 (Sep 28, 2023) — resolved in the follow-up below; Dutton Ranch (Sheridan) S1 is now on TMDB (299167) and its S2 would now qualify as provisional B — still held.


### Follow-up on the remaining Disney+ cases (2026-10-05, owner decisions)

- **Audit exceptions and unknown-runtime fix (`d71be11`, approved; tools/tests only):** §16. Grades the next enrichment would get with this code (live TMDB, 2026-10-05), **for approval later (all enriched later on 2026-10-05 with exactly these grades, below):** Star Wars: Visions 114478 Volume 1/2/3 → 1/2/3: B, B, B (exceptions); Star Wars Rebels 60554 S1–S4 → 1–4: B (10-day difference, no exception), B (exception), A, A; Star Wars: The Acolyte 114479 S1: B (exception); The Proud Family: Louder and Prouder 125438 S1–S4 → 1–4: B, **A** (after the date correction; C before it), B, A. Total 4 A / 8 B / 0 C / 0 D.
- **The Proud Family: Louder and Prouder S2 date → Feb 1, 2023 (approved historical correction, not a routine refresh):** Disney's Dec 13, 2022 announcement (Futon Critic reprint; Out.com) and Newsweek/TMDB: all ten episodes released on Disney+ on Feb 1, 2023 (Disney Channel from Mar 4, 2023); the stored Sep 28, 2023 matched no release. `config.js` changed in `24dc443` (one line; `config.js` is unversioned). Production: one guarded single-row update of `display_date`/`date_sort` only, with a read-only dry run and a guarded rollback (files kept outside the repo; they contain the row id), rehearsed locally on an exact replica (21/21: exactly 2 fields of 1 row change, up next unchanged for all 197 shows, a second run is refused, the Disney+ tab stays GET-only with the new config before and after the row changes, Currently Watching / Coming Soon unchanged, rollback restores the snapshot exactly). **Status: waiting** — deploy and verify the config first (blocked by the GitHub Actions outage), then present the fresh production dry run and get the owner's approval before the database write.
- **Star Wars: Tales of the Jedi S2 — skipped, row and default kept, show unmatched (done 2026-10-05):** Evidence-based interpretation: StarWars.com announced a *Tales of the Jedi* Season 2 at Celebration Europe (Apr 8, 2023); it was released on May 4, 2024 as *Star Wars: Tales of the Empire* ("the second installment of the 'Tales' series", Disney+ press, Apr 4, 2024; "a follow-up to Tales of the Jedi", Lucasfilm), which the catalog already has as its own enriched show (251091). The local S2 entry (Oct 26, 2023) is read as that announced season; its date alone doesn't prove where the entry came from. Through the live app (one `set_season_skipped` call, all other writes blocked): the only production change was that row's `skipped` false → true (backup diff). Reversible with Keep. The show stays unmatched: every season must be mapped and TMDB 203085 has no season 2 (a released missing season grades D), and a season can't point at 251091. Deleting the row or its default would need an explicit exception to the no-delete rule.
- **Wonder Man — unchanged by owner decision:** Season 1 (Jan 27, 2026) and Season 2 (TBA, **already skipped**) stay as they are and the show stays unmatched. Renewed March 2026; cancelled July 2026 (Variety, THR, Deadline; co-creator Andrew Guest confirmed it on Instagram). The cancellation history is not deleted to permit enrichment.
- **Unchanged:** Clone Wars (2003), Limitless, the 14 Specials (each verified as a TMDB movie; a reclassification would change labels, the built-in list and show links, and three would still grade C), held Sheridan shows, the Daredevil date question, 90 Day.


### 90 Day identity review (2026-10-05, read-only; proposals awaiting the owner's decisions)

Baseline before the review: repo 3 commits ahead of `origin/main` (not pushed; GitHub Actions outage), deployed app = `origin/main` (differs from local only in the unpushed `config.js` line); production unchanged since the Tales of the Jedi skip; audit 584 identified, 547 A / 37 B / 0 C / 0 D. All 15 legacy 90 Day shows (72 seasons, all plain `Season N`; the built-in list equals the database, so nothing would seed) reviewed with `tools/tmdb-enrich-candidates.mjs 90day`, TMDB details/episode lists and outside sources. Grades below come from the local audit and are **identical under the deployed audit** (no exception applies to any 90 Day row). None of the refresh skill's excluded 90 Day titles is a local show; their TMDB entries (Pillow Talk, Between the Sheets companions, Love Games, HEA Strikes Back!) were never proposed.
- **Certain (6 shows, 37 seasons: 35 A / 2 B):** 90 Day Fiancé 61575 (S1–S12; S4 B: stored Sep 11, 2016 is episode 2, TMDB season Aug 22), 90 Day Fiancé UK 205154 (S1–S4; the UK version, local title says so), Before the 90 Days 73319 (S1–S8), The Other Way 90046 (S1–S8), 90 Day: Hunt for Love 290564 (S1–S2), 90 Day: The Last Resort 230272 (S1–S3; S1 B: stored Aug 28, 2023 is episode 3, TMDB season Aug 14). Every season `Season N` → TMDB N.
- **Needs the owner's decision:** *Happily Ever After?* 67757 — S1–S9 A, but S10 (TBA 2026) would be a provisional B and **no confirmed renewal was found** (standing decision 2026-09-28; TV Insider, Dec 2025); passing the audit is not evidence of a renewal, and every season must be mapped. **Owner decision: hold.** *Love in Paradise* 128495 — S1/S2 A, S4 B, S3 C: stored Jun 16, 2023 vs the Apr 17, 2023 TLC/discovery+ premiere (TMDB agrees; the stored date matches no source) — likely a catalog date error; options: hold, or an approved historical correction like Proud Family. *The Single Life* 118422 — S2–S5 A, S1 C: stored Aug 9, 2021 is the real TLC premiere (Monsters & Critics) of a season that streamed on discovery+ from Feb 21, 2021 (TMDB's date) — a legitimate premiere, like Rebels; options: hold, or a narrowly bound `season_date` exception (would need approval), never a date change to pass.
- **Skipped shows — flagged, not proposed (owner decision needed to even consider):** 90 Day Fiancé: Bares All → 115029 "90 Day Bares All" (B, B: title form), Foody Call → 124081 "90 Day: Foody Call" (B), Self-Quarantined → 101451 (A), What Now? → 74920 (B, A, B, A), Darcey & Stacey → 107128 (A×4), The Family Chantel → 91169 (A×4; standing decision: whole show skipped, TMDB's S5 not added — enrichment never adds seasons).
- **Expected effect if only the Certain group were enriched:** 621 identified, 582 A / 39 B / 0 C / 0 D. Field changes per show: `tv_shows.tmdb_id`; per season `media_type` → `'tv'`, `tmdb_id`, `season_number` = N; nothing else.
- Evidence (contains row ids) is kept outside the repo with the other run files.

**Owner decisions on the 90 Day review (2026-10-05):**
- **Certain group approved for preparation and local rehearsal only** (6 shows, 37 seasons; production enrichment needs separate approval). Manifest and exact SQL (pre-flight, dry run, apply ×6, post-verify, rollback ×6; kept outside the repo, they contain row ids) generated from a fresh production snapshot; local rehearsal on an exact replica **46/46**: pre-flight 37 rows / 0 mismatches; dry run = manifest; guards and atomicity as for Disney+; only `tv_shows.tmdb_id` (6) and 37 × (`media_type`, `tmdb_id`, `season_number`) change; watched (126) and skipped (39) flags, season status copies and every show status unchanged; the two B-grade stored dates kept (90 Day Fiancé S4 Sep 11, 2016; The Last Resort S1 Aug 28, 2023); up next unchanged for all 197 shows; duplicates refused (re-run, second show with 61575, unique season index); 90 Day tab GET-only and byte-identical; Currently Watching / Coming Soon rendered identically; seeding the 72 defaults is a no-op; a later `Season 13` joins, `Season 13 (Part 1)` is held for review; rollbacks restore the snapshot. **Expected audit after the batch: 621 identified, 582 A / 39 B / 0 C / 0 D** (same under the deployed audit).
- **Happily Ever After?:** hold (above).
- **Love in Paradise S3 (proposed historical correction, not implemented):** Apr 17, 2023 established by E! News (Mar 28, 2023: "premiering April 17 on TLC"), corroborated by Variety's spring premiere-date exclusive, a WBD release ("TLC Announces The Return Of Six Fan-Favorite Series Beginning In April"; the page now 404s) and TMDB (episode 1 Apr 17, 2023). Exact proposal: `config.js` line `90 day fiancé: love in paradise|season 3` `d:'Jun 16, 2023',ds:'2023-06-16'` → `d:'Apr 17, 2023',ds:'2023-04-17'`, plus one guarded single-row update of `display_date`/`date_sort` (dry run, apply and rollback prepared outside the repo, not run). The season stays watched; its order within the show is unchanged. After the correction, enrichment would grade S1 A, S2 A, S3 A, S4 B.
- **The Single Life S1 (proposed exception, not implemented):** keeps the stored Aug 9, 2021 TLC premiere (Monsters & Critics, Aug 3, 2021: "premieres Monday, August 9 at 9/8c on TLC", after its discovery+ run); discovery+ premiere Feb 21, 2021 (Discovery release Jan 25, 2021, reprinted by The Futon Critic; TV Insider). Proposed entry: `season_date`, `90day` · tv 118422 · season 1 · local `date_sort` 2021-08-09 · TMDB `air_date` 2021-02-21, with https evidence only (the validator rejects the http-only Futon Critic link). Checked in memory with the current audit: S1 → B with it, C without; C again if either date changes, if mapped to another season, or in another collection; a row that is D for another reason stays D.
- **Finding for the owner (no change made):** when an exception's finding occurs on a row that is D for another reason, the grade correctly stays D (still fails), but the audit lists that exception as "applied". A reporting refinement (e.g. "applied, row still fails") could be considered with separate approval; it affects `d71be11` too.
- **Skipped shows:** unchanged (The Family Chantel included; no seasons added).


### Completed: TMDB identity enrichment — 90 Day (2026-10-05, approved)

- **Batch:** the 6 Certain shows / 37 seasons above (90 Day Fiancé 61575, 90 Day Fiancé UK 205154, Before the 90 Days 73319, The Other Way 90046, 90 Day: Hunt for Love 290564, 90 Day: The Last Resort 230272).
- **Production run:** fresh validated backup; files regenerated from it byte-identical to the rehearsed set (no re-rehearsal); catalog (31 function sources, privileges, stage `final`) = rehearsed; pre-flight 37 rows / 0 mismatches; production dry run identical to the rehearsal (hash); then 6 SQL Editor runs, one show per statement/transaction, each hash-checked before Run, self-verifying, and verified read-only against the pre-run backup before the next. No failure, retry or partial state.
- **Result:** post-verify 719 / 197 / 642 linked, 6 shows + 37 seasons identified, 621 identified rows, 0 mismatches/duplicates. **Backup diff:** exactly 6 × `tv_shows.tmdb_id` + 37 × (`media_type`, `tmdb_id`, `season_number`), each as planned; 0 unexpected changes; every date (incl. the two kept B dates), title, label, key, status, watched/skipped flag and link unchanged. **Audit 621 identified, 582 A / 39 B / 0 C / 0 D** (as predicted). Deployed site with writes blocked: 90 Day tab 2 GETs, no seeding, no write attempts; Currently Watching 6 + 4, Coming Soon 13 dated / 21 TBA. Rollback files kept privately, not run.

### Follow-up after the 90 Day run (2026-10-05)
- **Proud Family S2 date correction — completed in production 2026-10-05 (owner-approved):** config deployed and verified first; the fresh read-only dry run matched exactly one row (would_update 1, already_corrected 0) and equalled the rehearsal; the exact rehearsed guarded update (hash-checked; raises unless exactly one row) succeeded; the re-read showed would_update 0, already_corrected 1. **Changed:** `display_date` "Sep 28, 2023" → "Feb 1, 2023" and `date_sort` 2023-09-28 → 2023-02-01 on that one row; **no other field of that row and nothing in any other row or table changed** (field-by-field diff of validated pre/post format-2 backups). Status (pending), watched/skipped (false/false), title, label, item_key, show link and TMDB identity (none) are unchanged. Audit unchanged: **621 identified, 582 A / 39 B / 0 C / 0 D**. The guarded rollback file exists privately (outside the repo) and **was not run**. At that point Proud Family was still unenriched and ready for separately approved TMDB enrichment (125438; expected S1 B, S2 A, S3 B, S4 A) — **done later the same day (below)**.
- **The Single Life S1 exception (`c1893a1`, approved):** implemented with tests, plus "applied, ROW STILL FAILS" reporting (§16). The show is **not enriched**.
- **Love in Paradise S3 (at that point no change; unresolved — corrected later the same day, below):** still requires an official network/streamer source or the two-independent-trades standard; secondary articles citing Variety do not count as two independent trades. The date is consistent in accessible coverage — Screen Rant (Feb 28, 2023, citing Variety: "season 3 will debut on Monday, April 17"), TV Shows Ace (Mar 1, 2023, Variety reporting TLC's release: "Monday, April 17 … 8 p.m."), E! News (Mar 28, 2023) and TMDB — but the trade source itself (Variety's exclusive) and the WBD release could not be opened, so it is **not yet verified by an accessible official or trade source**.


### Completed: TMDB identity enrichment — The Proud Family: Louder and Prouder (2026-10-05, approved)

- **Scope:** this one show only, TMDB 125438 (owner-approved; no other enrichment in this run). Local display title and the curated labels `Season 1`–`Season 4` kept exactly; mapped Season N → TMDB season N.
- **Before writing (read-only):** repo `main` = `origin/main`, clean; stage `final`; counts 719 / 197 / 642 linked, 621 identified rows; audit 582 A / 39 B / 0 C / 0 D; the show still legacy (no TMDB id, Pending); S2 still Feb 1, 2023 / 2023-02-01; no Disney+ show or row already using 125438; all four seasons linked to the same show; production unchanged since the S2 correction's post-run backup. Fresh validated format-2 backup.
- **Rehearsal (local, exact replica of a fresh snapshot): 46/46** — pre-flight, dry run = manifest, guards, atomicity, only the identity fields change, all four stored dates and every watched/skipped flag and status unchanged, up next unchanged for all 197 shows, duplicates refused (re-run, a second show with 125438, the unique season index), Disney+ tab GET-only and byte-identical, Currently Watching / Coming Soon identical, seeding the 182 defaults a no-op, a later `Season 5` joins and `Season 5 (Part 1)` is held for review, rollback restores the snapshot.
- **Production:** regenerated files byte-identical to the rehearsed set; catalog (31 function sources, privileges, stage) = rehearsed; pre-flight 4 rows / 0 mismatches; **admin dry run identical to the rehearsal**; then one atomic, self-verifying `private.tv_enrich_show` call (not the user-facing Match flow), verified read-only against the pre-run backup.
- **Written (only):** `tv_shows.tmdb_id` null → 125438; on Seasons 1–4: `media_type` null → `tv`, `tmdb_id` null → 125438, `season_number` null → 1/2/3/4. **Field-level diff of validated pre/post format-2 backups: exactly those 13 fields, nothing else** — title, item_keys, labels, collection, show status (pending), watched/skipped (all false), display_date/date_sort (incl. Feb 1, 2023), created_at and links unchanged; other tables unchanged.
- **Checks:** post-verify 719 / 197 / 642 linked, 625 identified rows, 0 mismatches, 0 duplicate shows or seasons. **Grades: S1 B, S2 A, S3 B, S4 A** (S1/S3 one-day differences kept; no date changed). **Audit 625 identified, 584 A / 41 B / 0 C / 0 D, PASS.** Deployed Disney+ tab with writes blocked: 2 GETs, no seeding, no write attempts, Proud Family shown as one show with its four seasons and stored dates; Currently Watching 6 + 4, Coming Soon 13 dated / 21 TBA. The guarded rollback file exists privately and was not run.

### Completed: enriched-show guard fix (`0c3c434`, 2026-10-05, approved)

- **Problem found in rehearsal:** with Visions enriched, seeding all 182 Disney+ defaults returned three `enriched_show_label` review conflicts for the existing Volume 1/2/3 rows (0 inserts, 0 changes). `private.tv_add_to_enriched_show` applied the plain-`Season N` label rule before checking whether the item_key already names a season of the show. The live app only seeds missing keys, so there was no user-visible effect, but seeding must be idempotent.
- **Fix (smallest change):** the existing-row check now runs first. A row already on the enriched show with its identity (same TMDB id, a season number, and the same label — or, for a plain `Season N`, season N) is *existing* (no-op) whatever its label. Everything else is unchanged: a **new** nonstandard label (Volume/Part/Special…) is still held for review (`enriched_show_label`) and never given a season number; a new plain `Season N` still attaches as TMDB season N; a key or identity held by another row is still `identity_conflict`; no show is ever created.
- **Tests:** 3 new `t_enrich` checks (now 10/10): existing Volume 1–3 → no-op through seeding and manual add, data byte-identical; new Volume 4 (and a relabelled existing key) → held, nothing inserted; new Season 4 → season 4, repeat → no-op, a second key for season 1 → `identity_conflict`; one show throughout. Full DB rehearsal green; offline 303/303.
- **Production install (approved separately):** only that function, from the committed file, in one self-checking statement (refused unless stage `final` and the deployed source was the previous committed version; afterwards it checked the new source hash, signature, result type, language, SECURITY INVOKER, empty `search_path`, owner, privileges and that no other function changed; rehearsed locally first). Catalog afterwards: source MD5 `73478474edae6c0dd573615d12079be4`; signature, security, `search_path` and privileges (anon/authenticated, not PUBLIC) unchanged; the other 30 functions identical; stage `final`. No data changed (pre/post backups identical); audit unchanged. The function was not exercised with a production write.

### Completed: TMDB identity enrichment — Star Wars Rebels, Star Wars: The Acolyte, Star Wars: Visions (2026-10-05, approved)

- **Scope:** these three shows only. Star Wars Rebels → 60554 (Season 1–4 → 1–4), Star Wars: The Acolyte → 114479 (Season 1 → 1; local title kept), Star Wars: Visions → 114478 (**Volume 1/2/3 → seasons 1/2/3, owner-approved; labels kept exactly as `Volume N`, not renamed**). No other Disney+ show; Wonder Man and Tales of the Jedi stay NO MATCH; Clone Wars (2003) and Limitless stay unmatched; the 14 Specials stay as they are (candidates for a separate, later TV-row → film reclassification project).
- **Rehearsal (local, exact replica of a fresh snapshot, with the guard fix): 48/48**, including all 182 Disney+ defaults seeding as a clean no-op and a future `Volume 4` held for review.
- **Production run:** baseline re-checked (stage `final`, 719 / 197 / 642 linked, 625 identified rows, audit 584 / 41 / 0 / 0, guard source and catalog as installed, repo clean); fresh validated format-2 backup; files regenerated from it byte-identical to the rehearsed set; read-only checks (target identities unused, 0 duplicate show/season identities, 0 link mismatches); pre-flight 8 rows / 0 mismatches / 0 extra seasons; **admin dry run identical to the rehearsal (hash)**; then three SQL Editor runs in order Rebels → The Acolyte → Visions, one show per atomic self-verifying statement, each hash-checked before Run and verified read-only (per-show identity, full-table diff, counts, duplicates, links, audit) before the next.
- **Written (only):** 3 × `tv_shows.tmdb_id` and 8 × (`media_type` → `tv`, `tmdb_id`, `season_number`). **Field-level diff of validated pre/post backups: exactly those 27 fields, nothing else** — titles, labels (incl. `Volume 1/2/3`), item_keys, dates (incl. Rebels S2 Jun 20, 2015), statuses, watched/skipped flags, links and created_at unchanged; `othertv_shows` and `custom_collections` byte-identical.
- **Checks:** post-verify 719 / 197 / 642 linked, 633 identified rows, 0 mismatches, 0 duplicate shows or seasons. **Grades:** Rebels S1 B (10-day difference), S2 B (exception), S3 A, S4 A; The Acolyte S1 B (exception); Visions Volume 1/2/3 B, B, B (exceptions). **Audit 633 identified, 586 A / 47 B / 0 C / 0 D, PASS** (as predicted). On replicas of the real pre/post backups (deployed function sources): up next identical for all 197 shows; Disney+ tab GET-only and byte-identical; Currently Watching and Coming Soon byte-identical; seeding all 182 Disney+ defaults → 0 inserts, 0 conflicts, 0 changes; existing Visions Volume 1–3 → existing; a hypothetical `Volume 4` → held for review; a hypothetical plain `Season 4` → attaches as season 4 (rolled back; no production row was created); a TMDB-keyed add of Visions creates no second show. Deployed site in Chrome with writes blocked in page memory: Disney+ loaded with GETs only, 0 write attempts, no review note, no console errors; Rebels, The Acolyte and Visions each shown as one show with their stored labels and dates; Currently Watching 6 + 4, Coming Soon 13 dated + 21 TBA as before; production byte-identical to the post-run backup afterwards.
- **Rollback, if ever needed:** per-show identity-only guarded rollback scripts were generated and rehearsed; kept outside the repo with the run files (they contain row ids). Nothing has been rolled back.

### Completed: Love in Paradise S3 date correction (2026-10-05, approved)

- **Owner decisions (2026-10-05 review):** The Single Life approved as a clean enrichment candidate (not enriched); Love in Paradise S3 correction approved; Happily Ever After? held (its Season 10 row unchanged; still no confirmed renewal); the six Skipped 90 Day shows unchanged.
- **Evidence (meets the official-source standard):** TLC's own media release on the Warner Bros. Discovery pressroom, dated Monday, Feb 27, 2023 ("TLC Announces the Return of Six Fan-Favorite Series Beginning in April"): *90 Day Fiancé: Love in Paradise* "Premieres Monday, April 17 at 8pm ET/PT", an all-new season with the couple "First seen in Season 2". Readable in a real browser (automated fetches are refused). TMDB 128495 agrees (S3 2023-04-17). The stored Jun 16, 2023 matched no release.
- **Config (`2186a11`):** the one built-in default `90 day fiancé: love in paradise|season 3` → `d:'Apr 17, 2023', ds:'2023-04-17'`; no other change. Pushed and verified on Pages (18 app files byte-identical, 14 assets 200) before the database write. Seeding matches by `item_key` and only TBA dates are refreshed, so either deploy order is write-free (rehearsed).
- **Rehearsal (local, exact replica of a fresh snapshot): 42/42** — dry run, exactly 2 fields of 1 row change, re-run refused, the 633 identified rows byte-identical, up next unchanged for all 197 shows, seeding all 90 Day / Disney+ / Sheridan defaults a no-op before and after, every tab GET-only, the 90 Day tab shows Apr 17, 2023 and S3 moves one place up (before Before the 90 Days S6, Jun 4, 2023), every other tab and both views byte-identical, backup/restore round trip, rollback exact. Offline 303/303; the repo DB rehearsal passes.
- **Production:** fresh validated backup (tables equal to the rehearsed snapshot); catalog unchanged (31 functions, stage `final`); target row exactly as expected (Season 3, Jun 16, 2023 / 2023-06-16, watched, not skipped, show On List, no TMDB identity); read-only dry run identical to the rehearsal (would update 1, already corrected 0); then the hash-checked guarded update (refuses unless exactly that row in exactly that state). Re-read: would update 0, already corrected 1.
- **Changed (field-level diff of validated pre/post format-2 backups):** exactly `display_date` "Jun 16, 2023" → "Apr 17, 2023" and `date_sort` 2023-06-16 → 2023-04-17 on that one row; the other 718 rows, all `tv_shows`, `othertv_shows` and `custom_collections` unchanged. Title, label, item_key, show link, status, watched (true), skipped (false) and TMDB fields (null) unchanged.
- **Checks:** audit **633 identified, 586 A / 47 B / 0 C / 0 D, PASS**, every row's grade identical to before (the show is still legacy); on replicas of the real backups: 0 duplicates, 0 link problems, 642 linked, up next identical for all 197 shows, seeding all defaults with the deployed config 0 inserts / 0 conflicts / 0 reopened, all 72 90 Day defaults equal their rows, both backups validate. Deployed site in Chrome with writes blocked in page memory: Love in Paradise S3 shows Apr 17, 2023 (Jun 16, 2023 gone), its one-place move is the only order change, every tab and view loaded with GETs only (0 write attempts), no review note, no console errors; Currently Watching 6 + 4, Coming Soon 13 dated / 21 TBA. Production equal to the post-run backup afterwards.
- **Rollback:** a guarded inverse statement exists privately (it contains the row id), was rehearsed, and **was not run**.
- **Love in Paradise stays legacy/unmatched** and is now eligible for a separate enrichment decision (expected S1 A, S2 A, S3 A, S4 B — S4 stored Apr 15, 2024 vs TMDB Apr 22, within 31 days).

### Next

- **Pending owner approval:** enrichment of The Single Life (TMDB 118422, Season 1–5 → 1–5; owner-approved as a clean candidate on 2026-10-05; exception in place; expected B A A A A) and of Love in Paradise (128495, Season 1–4 → 1–4; eligible since the S3 correction; expected A A A B). Neither is prepared; each needs its own approval and the usual review → rehearsal → production process.
- **Held / unchanged:** Happily Ever After? (no confirmed renewal found), the six Skipped 90 Day shows, Wonder Man, Tales of the Jedi (S2 skipped), Clone Wars (2003), Limitless, the 14 Specials, the Sheridan held shows.
- **The TV-show migration is complete.** Enrichment continues only on approval (same process: read-only review → owner decisions → rehearsal → dry run → per-show apply); the 90 Day review is done and awaits decisions. No production write, no schema change, no 90 Day until approved. Parts/volumes or any non-`Season N` label are never forced into a season number (as with Yellowstone; Star Wars: Visions' Volume N → N was mapped only by explicit owner approval, and a new Volume is still held for review). Recheck the waiting Sheridan shows and the held Disney+ cases (Wonder Man; the audit-blocked shows) when TMDB or the owner's decisions change. The separate **future sign-in (Auth/RLS) project** (`db/future/auth_switchover.sql`) needs its own approval.
- **Identity audit:** 586 A / 47 B / 0 C / 0 D is the baseline (after the Rebels/Acolyte/Visions enrichment, 2026-10-05). TMDB data can change upstream; a benign TMDB correction that changes A/B is explained and accepted as the new baseline, not treated as a regression. A provisional B becomes normal grading once TMDB lists the season, or **D** if the season is released while TMDB still doesn't list it. Any C or D, or an unexplained A→B, is a stop condition.
- Other candidate follow-ups are listed in §14. For example: review the B-grade date drift.
- **Any static-tab catalog refresh uses the `/refresh-catalogs` skill.** Startup no longer opens Disney+, so the skill opens the Disney+ tab explicitly.

---

## 19. Your first task — read-only

1. Inspect the actual repo (your local Git checkout of `jaredsclove/Watchlist`).
2. Run `git status`.
3. Confirm the branch is `main` and in sync with `origin/main`.
4. Confirm `HEAD` is the docs commit "Update handoff after the Rebels, Acolyte and Visions TMDB enrichment" (it follows `0c3c434`, `76016c1` and `35d7895`); check that it is pushed (§2). The previous app-code commit is `4550060`, "Explain seasons of a TMDB-matched built-in show that need review". If it isn't, report the difference. Later commits, such as catalog refreshes or handoff updates, may legitimately exist; list them.
5. Inspect the file tree and compare it with §3: 73 tracked files, and roughly the listed line counts.
6. Run the offline checks in §16: syntax, all 15 test suites (303 cases), and the handler sweep (55 handlers, none undefined, no duplicate functions). Optionally, confirm GitHub Pages matches `main`. The identity audit is read-only and may also be run (expect 586 A / 47 B / 0 C / 0 D).
7. **Do not modify anything:**
   - no code
   - no schema
   - no production data
   - no tags
   - no config
8. Report any discrepancy between this handoff and the actual repo or site.
9. If everything matches, say:

   **"Handoff accepted"**

10. Then summarize the current state in a few lines and **wait for the user's next task**. No next feature is pre-approved (§18).
