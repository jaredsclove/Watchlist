# Watchlist Tracker — Handoff for a new Claude Code session

> **Read this whole document before doing anything.** It summarizes several long prior sessions. Treat the **actual repo, live site and production database as authoritative**; if anything here disagrees with them, trust them and report the difference. Your first task is at the very end (§19) and is read-only.
>
> **This file, `docs/HANDOFF.md` in the Watchlist repo, is the single canonical Watchlist handoff.** Update it here, in the repo, and commit documentation changes separately from app-code changes. Any copy kept outside the repo is not authoritative.
>
> **This repo is public.** Keep this file free of personal details, machine-specific paths, backup locations and infrastructure identifiers that the app doesn't already publish.
>
> **Last updated 2026-10-02**, when it moved into the repo. The content was first written on 2026-09-26 at commit `4b2d7c9` and brought up to date after the **Currently Watching / Coming Soon** derived views were deployed and verified at commit `789d4f5` (2026-09-30). Facts marked "last verified 2026-09-26" were not re-checked in the 2026-09-30 update.

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

`caughtup` is **derived for display only** and is never stored.

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
- **Current HEAD:** the documentation commit **"Add canonical Watchlist project handoff"**, the commit that adds this file. Its parent is `789d4f5`. (A file can't contain its own commit hash; run `git log -1` to see it.)
  - The **last app-code commit** is `789d4f5f0282922a47f54041f59bd9d3f1d250d1`, "Add offline tests for derived views, navigation and async guards". Everything that runs in the app is identical to `789d4f5`.
  - The working tree is clean.
  - All 17 app files are byte-identical on GitHub Pages (verified 2026-09-30 at `789d4f5`; this commit changes no app file).
- **Tracked files:** 31 (30 before this handoff was added).
  - 17 app files: 16 JS/CSS + `watchlist.html`.
  - 1 doc: `docs/HANDOFF.md` (this file).
  - 12 files in `tests/`: 11 test suites plus the shared `tests/app-harness.js`, which isn't a suite.
  - 1 tool.
- **Known-good tags** (annotated; these are rollback points):
  - `post-tmdb-migration-modularization` → `c5b592e` (after the TMDB identity migration + modular split, before any Claude Code changes)
  - `post-same-title-schema-fix` → `8ec56c0` (after the same-title schema fix, before identity hardening)
  - `pre-derived-views` → `e2c1c16` (just before the derived views). **Local only, not pushed**; ask before pushing it.
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
| *(this commit)* | Add canonical Watchlist project handoff |

The five commits `a13c1fb`…`e2c1c16` are catalog refreshes made with the `/refresh-catalogs` skill. `8e92095`…`789d4f5` are the derived-views feature. The final commit adds this handoff (docs only).

**Script load order** (in `watchlist.html`; the order matters):

`config.js → identity.js → api.js → ui-helpers.js → backup-restore.js → tabs.js → render.js → row-actions.js → tmdb-search.js → collections-pull.js → universe-pull.js → person-pull.js → refresh-shows.js → tmdb-match.js → derived-views.js → inline <script>`

The inline script owns the mutable state and the boot sequence:

`buildMediaSwitch(); buildTabs(); switchView(activeViewId); updateBackupAgeIndicator();`

That opens **TV → Currently Watching**. The boot makes only paginated GETs; it doesn't call `loadTab()`.

**Cache-busting token (manual; no build system):**
- `watchlist.html` requests 12 JS files and `styles.css` with `?v=20260929-derived1`: `api.js`, `backup-restore.js`, `tabs.js`, `render.js`, `row-actions.js`, `tmdb-search.js`, `collections-pull.js`, `universe-pull.js`, `person-pull.js`, `refresh-shows.js`, `tmdb-match.js`, `derived-views.js`.
- **Rule: when a deployment changes any versioned JS/CSS file, bump the token in `watchlist.html`** (for example `?v=20261015-x1`). This makes a new page load fresh copies instead of stale cached JS that doesn't match it. GitHub Pages caches files for 10 minutes.
- **`config.js`, `identity.js` and `ui-helpers.js` are deliberately unversioned.** The `/refresh-catalogs` workflow refreshes `config.js` by its plain URL (`fetch('config.js', {cache:'reload'})`), which only works while the page loads it without a token. If a future change to `identity.js` or `ui-helpers.js` must ship together with the page, add a token to that file then. Keep `config.js` unversioned unless the refresh workflow is updated too.
- An old cached page may keep running the old app for up to about 10 minutes after a deploy. That's accepted; the token guarantees that a **new** page never loads stale JS.

`tools/` and `tests/` files are **never** loaded by the app.

**Before any change:** run `git status`, confirm the branch and commit, and inspect the tree.

---

## 3. File map & responsibilities (current, regenerated from the repo)

| File | Lines | Owns |
|---|---:|---|
| `watchlist.html` | 177 | Markup, **all mutable page state** (`let` vars, §4), script tags (with the `?v=` cache token, §2), boot. Has some harmless orphaned comment headers left over from the modular split. |
| `styles.css` | 483 | All CSS, including the derived-view styles (source badge, Upcoming/Today tags, "Not aired yet", collapsible section rows, tab separator). Mobile rules apply below 700px: the desktop `<table id="desktopTable">` is hidden and `#cardList` cards are shown instead. |
| `config.js` | 442 | Constants: Supabase URL/key, `TABLE`, backup constants (`BACKUP_TABLES`, `BACKUP_FORMAT`, `BACKUP_FORMAT_VERSION`, `BACKUP_PAGE_SIZE`), `COLLECTIONS` + `DEFAULTS` (`truecrime` has `mixedMedia: true`), `WATCH_WITH_OPTIONS` (the household's fixed watch-with tags), `MCU_MOVIES` (39 `{t, id}` entries), `TMDB_TOKEN`/`TMDB_BASE`, `NETWORK_COLORS`, `WATCHABLE_SOON_DAYS` (60), `UNIVERSE_LISTS` (`mcu`), `LAST_BACKUP_KEY`. **Unchanged by the derived views and deliberately unversioned** (§2). |
| `identity.js` | 80 | `findExistingRow`, `isAlreadyAdded`, `normalizeTmdbTitle`, `pickTmdbMovieCandidate` (automated flows only), `isDuplicateKeyError`, `duplicateInsertMessage`, `cleanCollectionName` (display only). |
| `api.js` | 119 | `sbFetch`; `fetchAllRows(table, filter?)` (paginated, exact-count verified; the optional PostgREST filter is used by the derived views, and backup/restore call it without one); `deleteAllRows`, `batchInsertRows`, `tmdbFetch`. A failed `tmdbFetch` throws `TMDB error <status>` with **`err.status` attached**. |
| `ui-helpers.js` | 119 | `esc` (HTML-escapes `& < > "`); badge/color helpers; `hasWatchableSoonSeason` (derives "Caught Up"); `parseDate`, `formatDisplayDate`, `showSaved`, `showError`; the **TMDB failure-reporting helpers** `tmdbNameList`, `tmdbLookupFailureNote`, `tmdbAddFailureNote`. |
| `backup-restore.js` | 525 | Building and downloading backups; the **hardened** validator (`validateBackupObject`, `RESTORE_COLUMNS`, `restoreValueProblem`, `validateBackupRows`, `identityLossErrors`); the guarded restore flow and post-restore verification. `finishRestoreAndReload` reloads the active derived view or tab. |
| `tabs.js` | 158 | `buildTabs` (derived-view tabs first, then collections), `buildMediaSwitch`, `switchMediaType` (TV always lands on Currently Watching), `switchTab` (clears `activeViewId`), `switchView` (opens a derived view; sets `activeTabId = null`), and `loadTab`, which reseeds static defaults and refreshes TBA defaults by `item_key`. |
| `render.js` | 623 | `renderFilters` and `renderTable` (both hand off to the derived-view renderers when `activeViewId` is set); `renderFilters` keeps filter state on same-tab re-renders. The flat, movies and grouped tables/cards. The shared season-row helpers `seasonWatchControlHtml`, `seasonSubRowHtml` and `seasonSubCardHtml`, used by the grouped tabs (output byte-identical to before) and by Currently Watching. Also popovers (`toggleMorePopover` targets the popover inside the clicked `.more-cell`/`.card-top`), status options, expand/collapse, and the **Match to TMDB entry points** for eligible rows. |
| `row-actions.js` | 221 | `actionRows()` (the open view's rows or the active tab's rows) and `mirrorRowUpdate()` (copies a saved change onto every cached copy of that row); `setShowStatus`, `toggleWatch`, `setStatus`, `delRow` (a default row becomes `skipped`; any other row is hard-deleted after a `confirm()`; decides "default" from `row.collection`), `toggleAdd`, `toggleFilters`, `addEntry` (manual add with a client-side duplicate guard; captures the collection before its await), `toggleWatchWith`. |
| `tmdb-search.js` | 320 | Manual TMDB search: `tmdbSearchModeFor`, `selectTmdbSearchResults` (per-tab result selection, cap 6), `searchTMDB`, select/preview, `addSelectedTMDBSeasons` (captures collection and show id before its awaits), `cancelTMDBPreview`, `resetTMDBSearchUI`. |
| `collections-pull.js` | 347 | Pull rest of collection, Refresh collections (with lookup-failure accounting), `updateCollectionRefreshLink`, filter-from-tag helpers. Both add flows capture the collection before their awaits. |
| `universe-pull.js` | 217 | `pullUniverse` (id-backed; conservative title fallback; separates a genuine 404 "not found" from a failed request) and `addPulledUniverseMovies` (captures the collection before its awaits). |
| `person-pull.js` | 324 | Person search/select/role, `pullPersonFilmography` (same-title handling, tag backfill; captures the collection and won't redraw or write a preview into another tab or view), `addPulledPersonMovies`, `refreshPersonCollection`. |
| `refresh-shows.js` | 189 | `tmdbSeasonDateUpdate`, `refreshShows` (new seasons, TBA→date updates, lookup-failure accounting), `addRefreshedSeasons` (captures the collection before its awaits). |
| `tmdb-match.js` | 271 | **Match to TMDB** (§7.3): `isTmdbMatchEligible`, `buildTmdbMatchPatch`, `findTmdbMatchConflict`, `tmdbMatchConflictMessage`, the UI (`openTmdbMatch`, `searchTmdbMatch`, `chooseTmdbMatchResult`, `chooseTmdbMatchSeason`, `renderTmdbMatchConfirm`, `cancelTmdbMatch`), and `confirmTmdbMatch` (finishes against `row.collection`). |
| `derived-views.js` | 470 | **Currently Watching / Coming Soon** (§4a): `DERIVED_VIEWS`; pure rules (`isTvViewRow`, `isTbaRow`, `localTodayStr`, `isReleasedRow`, `seasonOrder`/`compareSeasons`, `showGroupKey`, `deriveCurrentlyWatching`, `deriveComingSoon`); the loader (`loadDerivedView`, `tvRowsFilter`); the filters, renderers and toggles (`toggleDerivedShow`, `toggleDerivedSection`). |
| `docs/HANDOFF.md` | — | **This handoff**, the single canonical copy. Never loaded by the app. |
| `tools/identity-audit.mjs` | 261 | Read-only (GET-only) production identity audit with A/B/C/D grading (§16). Pure grading functions are separated from network access. |
| `tests/identity-candidate.test.js` | 80 | `pickTmdbMovieCandidate` (9 cases). |
| `tests/title-attribute.test.js` | 38 | `esc()` round-trips titles in HTML attributes (5 cases). |
| `tests/season-date-update.test.js` | 62 | `tmdbSeasonDateUpdate` TBA→date rule (8 cases). |
| `tests/identity-audit.test.mjs` | 76 | Offline audit grading controls, including Reservoir Dogs (14 cases). |
| `tests/restore-validation.test.js` | 123 | Pre-delete restore validation and identity-loss protection (35 cases). |
| `tests/search-selection.test.js` | 92 | Per-tab TMDB search selection (10 cases). |
| `tests/row-popover.test.js` | 88 | `toggleMorePopover` targets the tapped row's popover (5 cases). |
| `tests/tmdb-failures.test.js` | 244 | Outage, partial-failure and partial-add reporting across the real flows, with stubbed calls (21 cases). |
| `tests/tmdb-match.test.js` | 300 | Match to TMDB patch/conflict rules and the stubbed flow (24 cases). |
| `tests/app-harness.js` | 219 | **Shared harness, not a suite.** Runs the whole page in a Node `vm` (every script in `watchlist.html` order plus its inline state/boot script) against a fake DOM and an in-memory Supabase/TMDB stand-in. Supports pausing a request (`hold`) to simulate navigation mid-await, forced failures, and count mismatches. No network. |
| `tests/derived-views.test.js` | 417 | Currently Watching / Coming Soon rules, their rendering, and the grouped-tab season rows after the extraction (30 cases). |
| `tests/derived-nav.test.js` | 389 | Startup, pagination and exact-count checks, navigation races, edits from a view (real id, mirrored cache, rollback), and the nine async guards (24 cases). |

**Totals:**
- 148 global functions, with no duplicate definitions.
- **54** distinct inline-handler names, all defined. The derived views added `switchView`, `loadDerivedView`, `toggleDerivedShow` and `toggleDerivedSection`.
- **185** offline test cases across 11 suites: 131 existing, 30 in `derived-views`, 24 in `derived-nav`.

---

## 4. State & global architecture

**Mutable state lives in the inline script in `watchlist.html`.** This is deliberate; don't move it without approval.
- `activeMediaType`: `'tv'` or `'movie'`.
- `activeViewId`: the open derived view (`'watching'` or `'comingsoon'`), or `null` when a collection tab is open. It starts as `'watching'`.
- `activeTabId`: the open collection id, or **`null` while a derived view is open**. It starts as `null`.
- `tabData`: `{ [collectionId]: { rows, loaded, newKeys } }`. Tabs load **lazily, one collection at a time**. The derived views never write into it.
- `derivedData`: `{ rows, loaded }`, the cross-TV rows for the derived views, kept apart from `tabData`.
- `derivedLoadSeq`: a counter that lets a late derived-view load see that it has been superseded.
- `derivedSectionOpen`: `{ uptodate, tba }`, the collapsible sections. Reset when a view is entered.
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
- `othertv` and `truecrime` use `renderGroupedTable`, which groups rows **by title**. Each group has an aggregate status and a derived Caught Up; its seasons appear when expanded.
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

**Currently Watching** (the default landing view):
- One card per **collection + show**. The key is `collection|tmdb:<id>`, falling back to `collection|title:<lowercased title>`. Shows are **never merged across collections**.
- A show is included if at least one row has `status === 'watching'`.
- **Up next** = the earliest row with `status === 'watching' && !watched`, in season order. **Release date doesn't affect which season is up next.**
  - **Season order:** numbered seasons before specials (`season_number === 0` or a `Special(s)` label); then season number (`season_number`, or the number parsed from "Season N…" / "Volume N"); then `date_sort`; then label; then row id.
  - **Released** means not TBA and `date_sort <= today`, where today is the **local** date (`localTodayStr`, not UTC). It's recomputed on every render, with no timer.
  - A released up-next season has its status select and the normal watch toggle.
  - An **unreleased (future or TBA)** up-next season stays the visible season and shows its stored date or "TBA", an **Upcoming** tag, the status select, and **"Not aired yet" instead of Mark watched**. Example: "Season 3 · TBA".
  - Once its stored date arrives (or a TBA gets a real date), the watch toggle appears on the next render.
- **Up to date** (collapsed by default) holds shows that have Watching rows but **no unwatched Watching rows**.
  - It's independent of the existing 60-day **Caught Up** rule (`hasWatchableSoonSeason`), which is unchanged.
  - A show whose next Watching season is future or TBA is **not** Up to date.
  - Up to date shows can be expanded, so a watched state can be undone.
- **Expanding** a show lists every stored season of that show in that collection, using the shared season-row helpers.
  - The same release rule applies: unwatched unreleased seasons have no Mark watched.
  - A row already marked watched keeps its "✓ Watched" toggle so it can be undone.
- Order: **A–Z by title** (`localeCompare`, base sensitivity; a leading "The" is not skipped), then collection label.
- Each card shows a source badge (collection icon + label) and a network/theme badge.
- **Not in the view:** delete (×), Match to TMDB, the show-level status control (`setShowStatus`), Add entry, and the TMDB panel.

**Coming Soon:**
- Eligible rows: TV rows with `watched !== true` and `status !== 'skipped'`. Every other status is included: On List, High Priority, Watching, Pending, Maybe and Complete.
- **Dated section:** rows that aren't TBA, with `date_sort >= today` (local date).
  - **Today is included**, with a **Today** tag. Earlier dates are excluded.
  - Order: `date_sort`, then title, then season order, then collection. Grouped by month.
- **TBA section** (collapsed by default): every eligible row where `/TBA/i` matches `display_date` **or** `date_sort === '2099-01-01'`, **whatever its `date_sort`**.
  - That includes static free-text TBA rows with a guessed, already-past `date_sort` (for example 90 Day Fiancé: HEA S10, "TBA 2026" → `2026-06-01`) and dynamic 2099 rows.
  - Ordered by `date_sort`, then title.
- Each row has the **status select only**: **no watch button** (not even for rows dated today) and **no delete**.

**Filters (both views):** title search and a Source (collection) select. Stats: In progress / Up to date, or Dated / Next 30 days / TBA.

**Edits from a view:**
- `toggleWatch`, `setStatus` and `toggleWatchWith` find the row through `actionRows()` and PATCH **`id=eq.<real row id>`**, the same as on the tabs.
- After a successful PATCH, `mirrorRowUpdate()` copies the saved fields onto every other cached copy of that row (any loaded `tabData[*]` and `derivedData`). If the PATCH fails, only the original is rolled back and nothing is mirrored.
- The view re-derives straight away: marking the up-next season watched moves the card to the next qualifying season, or into Up to date.

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

There are no foreign keys and no triggers. RLS is enabled and permissive: the anon role can select, insert, update and delete on all three tables, which is an accepted family-app trade-off. Postgres is 17.6.

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
- `othertv_shows`: `othertv_shows_collection_tmdb_id_key` UNIQUE, plus indexes on `collection` and `tmdb_id`.
- `custom_collections`: `custom_collections_name_key` UNIQUE, plus an index on `tmdb_person_id`.
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
- JSON shape: `{ format: 'watchlist-tracker-backup', formatVersion: 1, exportedAt, rowCounts, tables }`.
- Filename: `watchlist-backup-YYYY-MM-DD-HHMM.json`.
- The same backup can be produced from Node by running the app's own `config.js`/`api.js`/`backup-restore.js` in a `vm` sandbox and calling `buildBackupObject()` + `validateBackupObject()`. That's how the recent backups were taken.

### Restore (⬆ Restore): the flow

1. The file is parsed and run through **`validateBackupObject`**.
2. The preview fetches the current data and runs **`identityLossErrors`** against it.
3. **`executeRestore`** builds a safety backup of the current data **and validates it in memory**, including the identity-loss check against it. Any failure aborts with "nothing was changed".
4. The safety backup is downloaded (`watchlist-pre-restore-*.json`), and the user confirms they can see it.
5. For each table in order (`watchlist_items` → `othertv_shows` → `custom_collections`): delete all rows, then batch-insert in groups of 200, preserving ids and `created_at`.
6. The data is re-fetched and verified field by field against the backup.

### Checks that run before any DELETE (`8c935f3`)

- **Header:** `format`, a numeric `formatVersion` ≤ 1, `exportedAt`, and all three tables present as arrays.
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

- **`RESTORE_COLUMNS` must be updated whenever the schema gains a column.** Until it is, restore **safely refuses every backup**, including the safety backup.
- **Remaining risk:** a mixed state is still possible if a real infrastructure or runtime fault (network or server error) hits **after** a delete, because there's no cross-table transaction. The app then shows "MIXED state" and points to the safety backup. **A transactional restore RPC is deferred.**
- **Minor:** safety-backup filenames only go down to the minute. Two restores in the same minute could make a browser rename the second download to "(1)", while the dialog shows the original name.

### Rehearsal (2026-09-26)

- A **temporary, isolated Supabase project** was created with a schema copied from production; the catalog diff was clean. The **real** restore code ran in a Node harness with a fetch guard that blocked the production host.
- Results:
  - The restore reproduced production **byte-for-byte**, matching the SQL fingerprints.
  - The safety-backup recovery drill passed.
  - All 22 failure-injection cases behaved as expected. After hardening, every data-level bad backup is rejected **before DELETE**.
- **That rehearsal project has since been deleted.** It is not available. Recreate one only with approval.
- The **browser UI smoke test** of restore (file picker and real download) was **intentionally skipped** by owner decision. The harness exercised the same functions.
- **Never run a destructive restore on production just to test it.**

### Latest known-good backups

- Backups are kept **outside the repo**, never committed. Ask the owner where current backups live.
- **No existing backup matches the current production baseline** (718 / 64 / 1): the most recent validated backups predate the last catalog writes. The derived-views deployment made no data changes, so no backup was needed for it.
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

### 11a. Tooling notes from the prior environment

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

Other intentional behaviors:

- `"Caught Up"` is **derived**, never stored. A group whose aggregate status is `watching` is shown as Caught Up when `hasWatchableSoonSeason` finds nothing watchable within `WATCHABLE_SOON_DAYS` (60). This applies to the grouped tabs only; Currently Watching's **Up to date** section uses its own rule (§4a).
- `"Complete"` is a real stored status.
- Deleting a **default static row** sets `status='skipped'` instead of hard-deleting it. Other rows are hard-deleted after a `confirm()`.

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
- **`hasWatchableSoonSeason` compares dates in UTC** (`toISOString()`), so the tabs' Caught Up boundary shifts in the evening in US time zones. The derived views use local dates. Not changed; noted for a possible separate fix.
- **Review the two B-grade date drifts** (§13) and decide whether to update them (user decision; never auto-applied).
- **Canonical SQL fingerprints** (§16) were last recorded on 2026-09-28. The 2026-09-30 check used the anon-key hash method (§11a) and showed no change across the deployment. Re-run the SQL form when convenient.
- Possible derived-view enhancements, **not planned**: restore the last TV tab on Movies → TV; date-horizon filters in Coming Soon; ignoring a leading "The" when sorting.

### Larger / deferred

- Bulk actions (including a show-level status control in Currently Watching, deliberately left out of v1).
- Books/Games media types.
- Transactional restore RPC (`dry_run` capable) to remove the remaining mixed-state window.
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

---

## 15. Not recently re-tested — not known broken

- **A full destructive restore on production:** never re-run. It was rehearsed only in the isolated, now-deleted project.
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
  - Up to date: collapsed, 4 shows. Expandable, with an undo toggle.
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

for f in *.js tests/*.js tests/*.mjs tools/*.mjs; do
  node --check "$f" || echo "SYNTAX FAIL $f"
done

node tests/identity-candidate.test.js     # expect 9/9
node tests/title-attribute.test.js        # expect 5/5
node tests/season-date-update.test.js     # expect 8/8
node tests/restore-validation.test.js     # expect 35/35
node tests/search-selection.test.js       # expect 10/10
node tests/row-popover.test.js            # expect 5/5
node tests/tmdb-failures.test.js          # expect 21/21
node tests/tmdb-match.test.js             # expect 24/24
node tests/identity-audit.test.mjs        # expect 14/14
node tests/derived-views.test.js          # expect 30/30
node tests/derived-nav.test.js            # expect 24/24
# total: 185 cases across 11 suites (tests/app-harness.js is a helper, not a suite)
```

### Handler/global sweep

Every inline-handler name must be a defined function. Expected: **54** handler names, none undefined, and no duplicate global function definitions (148 functions).

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

wc -l < /tmp/handlers          # expect 54
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
# expect (2026-09-30): 718 rows fetched (422 identified, 296 legacy)
#         A 420 / B 2 / C 0 / D 0, RESULT: PASS
#         The 2 B rows are the known one-day date drifts (§13): The Traitors S5 and Avengers: Doomsday.
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

### Production fingerprints (read-only; SQL Editor)

```sql
-- Expected counts (2026-09-30): 718 / 64 / 1.
-- Run this read-only at the start of any session that might write, and use the result
-- as that session's baseline; re-run it afterwards to prove nothing else changed.
select
  (select count(*) from public.watchlist_items) w_n,
  (select md5(string_agg(t::text,'|' order by id)) from public.watchlist_items t) w_h,
  (select count(*) from public.othertv_shows) o_n,
  (select md5(string_agg(t::text,'|' order by id)) from public.othertv_shows t) o_h,
  (select count(*) from public.custom_collections) c_n,
  (select md5(string_agg(t::text,'|' order by id)) from public.custom_collections t) c_h;
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
- **Refresh shows (Other TV):** 60 tracked shows. Tehran S4 is offered (a policy decision not to add it), and nothing else.
- **True Crime / Docs Refresh shows:** 3 tracked shows, "Everything's up to date".
- **Search "Dune":**
  - Movies → 6 films including Dune: Part Two.
  - Other TV → series first.
  - True Crime / Docs → 4 series then films.
- **Outage simulation:** Refresh shows and Refresh collections say "Couldn't check TMDB right now… Nothing was changed" (never "up to date").
- **Mobile 375 px:** the "⋯" popover on a movie card opens inside that card.
- **Derived views:** see the 2026-09-30 checklist in §15 (startup GET-only; TBA up-next season without Mark watched; Up to date section; Coming Soon today row and TBA section; no films; Movies → TV).
- **After any temporary test:** all three fingerprints equal the baseline, and the audit shows 420 A / 2 B / 0 C / 0 D.

---

## 17. Source-of-truth baseline (verified 2026-09-30)

```text
Repo:                     the local Git checkout of this repo (github.com/jaredsclove/Watchlist)
Branch:                   main (in sync with origin/main), working tree clean
HEAD:                     "Add canonical Watchlist project handoff" (docs-only; adds this file; parent 789d4f5)
Last app-code commit:     789d4f5f0282922a47f54041f59bd9d3f1d250d1  "Add offline tests for derived views, navigation and async guards"
Tracked files:            31 (17 app, 1 doc = docs/HANDOFF.md, 12 in tests/ = 11 suites + app-harness.js, 1 tool)
                          all 17 app files byte-identical on GitHub Pages (verified at 789d4f5)
Offline tests:            185/185 passing (11 suites); 54 inline handlers, none undefined; 148 functions, no duplicates
Cache token:              ?v=20260929-derived1 (12 JS files + styles.css); config.js unversioned

watchlist_items:          718 rows
othertv_shows:             64 rows
custom_collections:         1 row   ("Quentin Tarantino", tmdb_person_id 138, director)

Fingerprints:             not published here. Compute the current baseline read-only (SQL MD5, §16; or the
                          anon-key hash method, §11a). Content was unchanged before vs after the 2026-09-30 deploy.

Rows per tab:             disney 182, 90day 72, sheridan 42, othertv 354, truecrime 7 (3 TV + 4 films), movies 61
TV rows in derived views: 641
Unidentified rows:        296 (all static DEFAULTs, 53 skipped; 0 manual dynamic rows)

Identity audit:           718 rows, 422 identified → 420 A / 2 B / 0 C / 0 D, PASS (node tools/identity-audit.mjs)
                          B = one-day confirmed-date drift, expected review items (§13): The Traitors S5, Avengers: Doomsday
Collection consistency:   42 rows / 16 TMDB collections / 0 problems (last verified 2026-09-26)

Backups:                  kept outside the repo. None matches 718/64/1. Take and validate a fresh backup before any approved write.

Tags:
  post-tmdb-migration-modularization → c5b592e
  post-same-title-schema-fix         → 8ec56c0
  pre-derived-views                  → e2c1c16   (local only, not pushed)

Supabase:                 one production project. The temporary rehearsal project was deleted.
```

---

## 18. Recent completed work and what's next

### Completed: Currently Watching and Coming Soon (2026-09-29 to 09-30)

- **Process:** a planning-only round and a revised plan (both reviewed by the user), then implementation with offline tests first, then a checkpoint review, then the push, then deployed verification with writes blocked.
- **Commits:** `8e92095`, `aa6e71a`, `fc9f796`, `789d4f5`. There were no schema, data, RLS or backup-format changes.
- **Behavior:** §4a. **Async guards:** §4b. **Cache token:** §2. **Verification:** §15.
- **Rollback, if ever needed:** `git revert` those four commits (or compare against the local tag `pre-derived-views` → `e2c1c16`). No data needs undoing.

### Next

- **There is no approved next feature.** Wait for the user's task.
- Candidate follow-ups are listed in §14. For example: review the two B-grade date drifts, possibly fix the UTC date comparison in `hasWatchableSoonSeason`, and re-run the canonical SQL fingerprints.
- **Any static-tab catalog refresh uses the `/refresh-catalogs` skill.** Startup no longer opens Disney+, so the skill opens the Disney+ tab explicitly.

---

## 19. Your first task — read-only

1. Inspect the actual repo (your local Git checkout of `jaredsclove/Watchlist`).
2. Run `git status`.
3. Confirm the branch is `main` and in sync with `origin/main`.
4. Confirm `HEAD` is the documentation commit "Add canonical Watchlist project handoff", whose parent is `789d4f5f0282922a47f54041f59bd9d3f1d250d1` (the last app-code commit). If it isn't, report the difference. Later commits, such as catalog refreshes or handoff updates, may legitimately exist; list them.
5. Inspect the file tree and compare it with §3: 31 tracked files, and roughly the listed line counts.
6. Run the offline checks in §16: syntax, all 11 test suites (185 cases), and the handler sweep (54 handlers, none undefined, no duplicate functions). Optionally, confirm GitHub Pages matches `main`. The identity audit is read-only and may also be run (expect 420 A / 2 B / 0 C / 0 D).
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
