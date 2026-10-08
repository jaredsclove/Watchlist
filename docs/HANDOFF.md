# Watchlist Tracker — Handoff for a new Claude Code session

> **Read this whole document before doing anything.** It summarizes several long prior sessions. Treat the **actual repo, live site and production database as authoritative**; if anything here disagrees with them, trust them and report the difference. Your first task is at the very end (§19) and is read-only.
>
> **This file, `docs/HANDOFF.md` in the Watchlist repo, is the single canonical Watchlist handoff.** Update it here, in the repo, and commit documentation changes separately from app-code changes. Any copy kept outside the repo is not authoritative.
>
> **This repo is public.** Keep this file free of personal details, machine-specific paths, backup locations and infrastructure identifiers that the app doesn't already publish.
>
> **Last updated 2026-10-08**, after **local release preparation of the list filters** (app commit **`90738a8`**, cache token `20261008-filters1`; **committed locally only — NOT pushed and NOT deployed**; the live site still runs `fdc5023`; §4d, §18): filter pills (genre / theme / network, legacy collection tags, watch-with) that toggle one value per filter in every list view, All Movies' **Watched** filter (Unwatched only on entry), All TV's Shows-only **progress** filter, filters kept for the visit through redraws, reloads, Retry and Back, a read-only watched pill, and Manage's add search above the member list. Client-side only: no schema, data or write-path change. Before it, the **Stage 3b-2 release: editing personal organization** (§18). The production database migration (`db/phase3b2_org_write.sql`: the read-only `org_capabilities` and eight owner-scoped organization write functions, and a rule that refuses newly adding an archived watch-with choice; no table or row change) and the app release **`fdc5023`** (cache token `20261008-manage1`): a **Manage** dialog to create, rename, archive and unarchive collections, add and remove members, and create, rename and archive watch-with choices, plus the Match expansion confirmation. Verified in production: the capability and every organization **read**, the write functions' catalog definitions and grants, unchanged data, and the live page; **no organization write was tested in production** (owner decision; §18). A new validated format-3 baseline was taken. The release freeze was **lifted by the owner** on 2026-10-08; that authorizes no catalog refresh. Before it, **`c3c0443`: the "Before the 90 Days" theme pill is styled** (its CSS class name differed in letter case from the one the app renders; token `20261006-badge1`; §18). Before it, **`bc75a19`: Seasons views hide individually skipped seasons by default** (a new "All (except Skipped)" TV seasons choice in Browse collections and All TV; token `20261006-skipped1`; §4a, §4c, §18). Before it, the **Stage 3b-1 personal organization release** (§18): the production database migration (`db/phase3b_org.sql`), the app release **`dde4079`** (cache token `20261006-org1`), the first validated **format-3** backup, and the updated `/refresh-catalogs` skill. Personal collections, collection memberships and watch-with choices are now stored in the database and drive Browse collections and the watch-with controls (§4c, §5, §10). Stage 3b-1 itself had no editing UI; Stage 3b-2 (above) added it. The **`/refresh-catalogs` freeze**, kept from the database phase, was **lifted by the owner** after the release; the skill stays user-invoked only, and lifting the freeze authorized no refresh (§18). Before it: the deployment of **44 px phone targets for the Browse show expand buttons** (`ca092dd`), which followed the **Browse collection presentation** (Shows / Seasons and Separate / Combined; `dec78d4`, `575e6c4`; §4c, §18), which followed **Stage 3a: read-only Browse collections and All Movies** (`e89a932`, `540f411`). Before it: the **The Bear consolidation** (one Disney+ show; production, 2026-10-06) and the deployment of **All TV** (Stage 1 of the post-enrichment architecture, `4331e81`) (§4a, §18), then the show status control's plain labels (`97ab608`) and All TV's **Shows / Seasons** presentation (`77ff0ab`). Before that (2026-10-05): TMDB identity enrichment of the built-in collections (Sheridan, Disney+, 90 Day and the follow-ups), which is effectively complete under the current schema and standing decisions. The first-class TV-show model is at stage `final`: a TV show's status lives on its show (`tv_shows.status`); seasons hold watched, skipped, identity, dates and metadata. Remaining held identity cases and the future sign-in (Auth/RLS) project each need separate approval.

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

**Derived TV views** (not collections; §4a): **▶ Currently Watching** (the default landing view), **🗂 All TV** and **📅 Coming Soon**. They read across every TV collection and store nothing of their own.

**Read-only browse views** (Stage 3a; §4c): a **Browse collections** selector in both media areas opens **Disney+**, **Sheridan**, **90 Day** or **True Crime / Docs** with their TV shows and films together, and **🎞️ All Movies** (every saved film, whatever tab stores it) is where Movies opens. A collection can list its TV as **Shows or Seasons** and show TV and films **Separate or Combined** (remembered per collection on the device). They only read; changes are made in the existing tabs and views.

**Collections (tabs)** — row counts verified 2026-10-06 (after The Bear consolidation):

| id | Label | `mediaType` | Kind | Rows |
|---|---|---|---|---|
| `disney` | Disney+ | tv | static (hand-curated `DEFAULTS`) | 182 |
| `90day` | 90 Day | tv | static | 72 |
| `sheridan` | Sheridan | tv | static | 42 |
| `othertv` | Other TV | tv | dynamic (TMDB) | 350 |
| `truecrime` | True Crime / Docs | tv | dynamic, **`mixedMedia: true`** (3 TV seasons + 4 films) | 7 |
| `movies` | Movies | movie | dynamic, `isMovieTab: true` | 61 |

TV tab order: **Currently Watching · All TV · Coming Soon │ Disney+ · 90 Day · Sheridan · Other TV · True Crime / Docs**. Movies: **All Movies │ Movies (legacy)** (the `movies` collection tab, relabelled; it keeps every Movies tool). The Browse collections selector sits under the tab bar in both areas.

**Static tabs** are seeded from `DEFAULTS` in `config.js`:
- `loadTab()` re-inserts any missing default by `item_key` and refreshes their TBA dates by `item_key`.
- `loadTab()` runs **only when that tab is opened**. Since `fc9f796`, startup opens Currently Watching, not Disney+, so boot no longer seeds or refreshes Disney+ on every visit. A new static default shows up in the derived views only after its tab has been opened once.
- These rows are **legacy/unidentified by design** (no TMDB ids).

**Dynamic tabs** are populated through TMDB flows. Every current dynamic row carries a TMDB identity.

---

## 2. Repository & deployment state

- **Working copy:** the local Git checkout of this repo. **Never work from loose copies outside the checkout** (such as files in a downloads folder).
- **Branch:** `main` is the source of truth. The deployed Pages site must match it byte-for-byte.
- **Current HEAD (local, not pushed):** the documentation commit **"Update handoff for the list-filter release (not deployed)"**, the commit that last updated this file. Its parent is **`90738a8`** (list filters; app code; **local only, not pushed or deployed**, §18) ← `c3437c0` ("Update handoff after the Stage 3b-2 release"; = `origin/main`, the last pushed commit) ← `fdc5023` (Stage 3b-2 release: cache token) ← `942ae8e` … `3fe49c5` (the 20 Stage 3b-2 commits, §18) ← `536e05c` (handoff after the theme-pill fix) ← `c3c0443` (style the "Before the 90 Days" theme pill).
  - The **last app-code commit** is `90738a8`, "List filters: filter pills, All Movies watched filter, All TV progress, Manage add first" (`browse-views.js`, `collections-pull.js`, `derived-views.js`, `organization-manage.js`, `render.js`, `styles.css`, `tabs.js`, `watchlist.html` with the token `20261008-filters1`, the new suite `tests/filter-pills.test.js` and three updated suites). **Not pushed and not deployed**: GitHub Pages still serves `fdc5023` (§18 gives the deployment verification and rollback).
  - The **last deployed app-code commit** is `fdc5023`, "Stage 3b-2 release: cache token 20261008-manage1" (the token only), on top of the Stage 3b-2 app commits `53971a5`…`942ae8e`. They were pushed together (`536e05c..fdc5023`, a fast-forward) and **deployed and verified** on 2026-10-08: all 21 app files and all 17 versioned assets byte-identical on GitHub Pages, and the live page's 338 top-level functions equal to the release (§18). Before it: `c3c0443`, "Style the "Before the 90 Days" theme pill" (two selectors in `styles.css`, the token `20261006-badge1` in `watchlist.html`, and one test), **deployed and verified** on 2026-10-06: all 20 app files and all 16 versioned assets byte-identical on GitHub Pages, and the live page's 263 top-level functions equal to the release (§18). Before it: `bc75a19`, "Hide individually skipped seasons by default in Seasons views" (`browse-views.js`, `derived-views.js`, `tabs.js`, `watchlist.html` with the token `20261006-skipped1`, and tests), **deployed and verified** on 2026-10-06: all 20 app files and all 16 versioned assets byte-identical on GitHub Pages, and the live page's 263 top-level functions equal to the release (§18). Before it: `dde4079`, "Stage 3b-1: report Match failures by how far the match got", the last of the eleven **Stage 3b-1** commits `8791bdb`…`dde4079` (database scripts, the app's reading of personal collections and watch-with choices, three review rounds, test-only hosted helpers, and two Match message fixes; §18). They were pushed together and **deployed and verified** on 2026-10-06: all 20 app files byte-identical on GitHub Pages, all 16 versioned assets (`20261006-org1`, including the new `organization.js`) byte-identical, and the live page's 263 top-level functions equal to the release code. The production database migration ran just before the push (§18). Before it: `ca092dd`, "Give Browse show expand buttons 44px targets on phones" (one phone-only CSS rule in `styles.css` and the token `20261006-expand1` in `watchlist.html`), **deployed and verified** on 2026-10-06: all 19 app files byte-identical on GitHub Pages, all 15 versioned assets 200 and byte-identical, and the live page using the new stylesheet (§18). Before it: `dec78d4`, "Add Shows/Seasons and Separate/Combined to Browse collections", and `575e6c4`, "Give Browse collection controls 44px touch targets on phones" (`browse-views.js`, `styles.css`, `tabs.js`, `watchlist.html` with the token `20261006-layout1`, the new suite `tests/browse-presentation.test.js`, two lines of `tests/browse-views.test.js`), pushed together and **deployed and verified** on 2026-10-06: all 19 app files byte-identical on GitHub Pages, all 15 versioned assets 200 and byte-identical, and the live page running the new code (§18). Before them: `e89a932`, "Add read-only Browse collections and All Movies (Stage 3a)", and `540f411`, "Abandon stale restores on navigation; keep focus in browse views" (new `browse-views.js` and `tests/browse-views.test.js`; `api.js`, `backup-restore.js`, `derived-views.js`, `render.js`, `row-actions.js`, `styles.css`, `tabs.js`, `tv-shows.js`, `watchlist.html` with the token `20261006-browse1`; three existing tests adjusted because Movies now opens on All Movies), pushed together and **deployed and verified** on 2026-10-06: all 19 app files byte-identical on GitHub Pages, all 15 versioned assets 200 and byte-identical, and the live page running the new code (§18). Before them: `77ff0ab`, "Add a Shows / Seasons presentation to All TV" (`derived-views.js`, `tabs.js`, `styles.css`, `watchlist.html` with the token `20261006-seasons1`, and the new suite `tests/all-tv-seasons.test.js`), **deployed and verified** on 2026-10-06: all 18 app files byte-identical on GitHub Pages, all 14 versioned assets 200 and byte-identical, and the live page running the new code (§18). Before it: `97ab608` (plain status labels, token `20261006-status1`), `4331e81`, "Add the All TV derived view (Stage 1, Shows mode)" (token `20261005-alltv1`), then `2186a11` (one-line `config.js` change).
  - The working tree is clean.
- **Tracked files:** 93 (92 before `90738a8` added `tests/filter-pills.test.js`).
  - 21 app files: 20 JS/CSS + `watchlist.html` (`organization.js` added by Stage 3b-1, `organization-manage.js` by Stage 3b-2).
  - 1 doc: `docs/HANDOFF.md` (this file).
  - 34 files in `db/` (including `db/admin/tv_enrich.sql`, `db/test/t_enrich.sql`, the Stage 3b-2 `db/phase3b2_org_write.sql`, `db/rollback/phase3b2.sql`, `db/test/t_3b2_org.sql`, and the Stage 3b-1 `db/phase3b_org.sql`, `db/rollback/phase3b.sql`, `db/test/t_3b_org.sql` and the **test-project-only** `db/test/hosted_helpers.sql`): the migration scripts, rollbacks, stage switches, test-project-only scripts, SQL self-checks and a local-values template (`db/README.md` gives the run order).
  - `.gitignore`: excludes the two local test-project value files.
  - 26 files in `tests/`: 23 test suites, the shared `tests/app-harness.js`, the TV-model reference `tests/tv-model-reference.js` and its shared cases `tests/fixtures/tv-model-cases.json`.
  - 10 files in `tools/` (8 tools including `db-rehearsal-3b.mjs` and `db-rehearsal-3b2.mjs`, one local-values template, and `identity-exceptions.json`).
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
| `39c8919`…`528aab2` | TMDB enrichment of the built-in collections and its follow-ups (tools, audit exceptions, two `config.js` date corrections, the guard fix `0c3c434`, handoff updates; §18) |
| `4331e81` | Add the All TV derived view (Stage 1, Shows mode) |
| `ae4d177` | Update handoff after The Bear consolidation and the All TV deployment |
| `97ab608` | Show the plain status in the show-level status control |
| `da2640d` | Update handoff after the status-label change |
| `77ff0ab` | Add a Shows / Seasons presentation to All TV |
| `649f3fd` | Update handoff after the All TV Shows / Seasons release |
| `e89a932` | Add read-only Browse collections and All Movies (Stage 3a) |
| `540f411` | Abandon stale restores on navigation; keep focus in browse views |
| `aa0f142` | Update handoff after the Stage 3a deployment |
| `dec78d4` | Add Shows/Seasons and Separate/Combined to Browse collections |
| `575e6c4` | Give Browse collection controls 44px touch targets on phones |
| `e91ba51` | Update handoff after the collection presentation release |
| `ca092dd` | Give Browse show expand buttons 44px targets on phones |
| `afac120` | Update handoff after the expand-button release |
| `8791bdb` | Add Stage 3b-1 database scripts: personal collections, memberships, watch-with choices |
| `1e7159c` | Read personal collections and memberships in the app (Stage 3b-1) |
| `ee8e820` | List the Stage 3b-1 scripts and rehearsal in db/README.md |
| `513a264` | Stage 3b-1 review fixes (database): watch-with integrity, stricter rollback, Match locking |
| `9a054b1` | Stage 3b-1 review fixes (app): refresh organization after restore; Browse wording |
| `1a1fbfd` | Stage 3b-1 second review (database): lock order, restore lock mode, honest rollback contract |
| `b26b1f0` | Stage 3b-1 second review (app): watch-with choices have their own state |
| `ac33ff7` | Stage 3b-1 third review (app): targeted watch-with refresh, Retry beside the filter |
| `c88ecd1` | Add test-project-only helpers for the Stage 3b-1 hosted concurrency checks |
| `b9b5376` | Stage 3b-1: treat a statement timeout during Match as a concurrent change |
| `dde4079` | Stage 3b-1: report Match failures by how far the match got |
| `febcce9` | Update handoff after the Stage 3b-1 release |
| `6000f1a` | Record the lifted refresh freeze and the test-environment cleanup |
| `bc75a19` | Hide individually skipped seasons by default in Seasons views |
| `f0438a8` | Update handoff after the skipped-season default |
| `c3c0443` | Style the "Before the 90 Days" theme pill |
| `536e05c` | Update handoff after the theme-pill fix |
| `3fe49c5` | Stage 3b-2 (database): organization write functions, rollback, self-checks |
| `53971a5` | Stage 3b-2 (app): Manage collections, watch-with choices, Match confirmation |
| `7accb0f` | Stage 3b-2 (tests): Manage dialog, Match confirmation, harness model |
| `cd76f55` | Stage 3b-2 (tests): the write-barrier test's earlier read answers with pre-change data |
| `8894c8f` | Stage 3b-2 (tests): pin the write-barrier publication rule |
| `8c247c8` | Stage 3b-2 (tooling): rehearsal edits use current names; --export-pre |
| `7919a12` | Stage 3b-2 (app): return focus to the control that opened Manage |
| `5e7c518` | Stage 3b-2 (app): dialog fits 375 px |
| `1a23a16` | Stage 3b-2 (tooling): export the rehearsal's replica builder |
| `93b6dee` | Stage 3b-2 review fix 1: Match refresh publishes nothing older than the page |
| `39d02ad` | Stage 3b-2 review fixes 2-4: ambiguous HTTP errors, per-request uncertainty, per-kind refresh |
| `1bb0459` | Stage 3b-2 review round 2: Match refresh progress follows its replacement read |
| `7133c2c` | Stage 3b-2 review round 3: refresh obligations and tracked read ownership |
| `8f7c6e0` | Stage 3b-2 review round 3 (tests): older tab and derived-view reads after newer data |
| `47e6cea` | Stage 3b-2 review round 4: publication order covers row presence, edits and failures |
| `745b4fa` | Stage 3b-2 review round 4: coverage tests found by deliberate breaks |
| `3b336fc` | Stage 3b-2 review round 5: protect edits across their whole lifecycle |
| `cd4caa5` | Stage 3b-2 review round 5: coverage tests found by deliberate breaks |
| `9486e0f` | Stage 3b-2 (app): keep keyboard focus in Manage when the focused control is redrawn |
| `942ae8e` | Stage 3b-2 (app): redraw an open view when a Match refresh completes |
| `fdc5023` | Stage 3b-2 release: cache token 20261008-manage1 |
| `c3437c0` | Update handoff after the Stage 3b-2 release |
| `90738a8` | List filters: filter pills, All Movies watched filter, All TV progress, Manage add first (**local; not pushed or deployed**) |
| *(this commit)* | Update handoff for the list-filter release (not deployed) |

The five commits `a13c1fb`…`e2c1c16` are catalog refreshes made with the `/refresh-catalogs` skill. `8e92095`…`789d4f5` are the derived-views feature. `6dfa0cd` added this handoff (docs only). `e003694` makes Up to date start expanded, and `1486404` adds its status label and next-season text; `bd4c068` and `af600e3` update this handoff (docs only). `e6d5822`…`b39584e` are Phase 0 of the TV-show migration (§18); only `02f304f` changes app files. `b266a5b` is Phase 1a (app files and tests); Phase 1b/1c ran the already-committed `db/` scripts on production and needed no commit. `09f24aa` is the Phase 2 app change; Phase 2's database step ran the committed `db/rpc.sql` and the Phase 2 block of `db/stages.sql`.

**Script load order** (in `watchlist.html`; the order matters):

`config.js → identity.js → api.js → ui-helpers.js → backup-restore.js → tabs.js → render.js → row-actions.js → tmdb-search.js → collections-pull.js → universe-pull.js → person-pull.js → refresh-shows.js → tmdb-match.js → derived-views.js → tv-shows.js → organization.js → browse-views.js → inline <script>`

The inline script owns the mutable state and the boot sequence:

`buildMediaSwitch(); buildTabs(); switchView(activeViewId); updateBackupAgeIndicator();` and (Stage 3b-1) `loadOrganization()`, which reads the personal collections and watch-with choices in the background without holding up the first view.

That opens **TV → Currently Watching**. The boot makes only paginated GETs (five since 3b-1: the TV rows, the shows, `personal_collections`, `watch_with_choices`); it doesn't call `loadTab()`.

**Cache-busting token (manual; no build system):**
- `watchlist.html` requests 16 JS files and `styles.css` with `?v=20261008-filters1` (since `90738a8`, **not yet deployed**; earlier tokens: `?v=20261008-manage1` at `fdc5023` (the live site), `?v=20261007-manage1` in `53971a5`…`942ae8e` (never served), `?v=20261006-badge1` at `c3c0443`, `?v=20261006-skipped1` at `bc75a19`, `?v=20261006-org1` at `dde4079` (introduced in `1e7159c`), `?v=20261006-expand1` at `ca092dd`, `?v=20261006-layout1` at `575e6c4`, `?v=20261006-browse1` at `540f411`, `?v=20261006-seasons1` at `77ff0ab`, `?v=20261006-status1` at `97ab608`, `?v=20261005-alltv1` at `4331e81`, `?v=20261005-enrich1` at `4550060`, `?v=20261005-final1` at `bc43e2c`, `?v=20261005-refresh1` at `59dd6a1`, `?v=20261005-phase3` at `62b5b71`, `?v=20261005-phase2` at `09f24aa`, `?v=20261005-phase1a` at `b266a5b`, `?v=20261004-restore1` at `02f304f`, `?v=20260929-derived1`, `?v=20261002-uptodate1` at `e003694`, `?v=20261003-uptodate2` at `1486404`): `api.js`, `backup-restore.js`, `tabs.js`, `render.js`, `row-actions.js`, `tmdb-search.js`, `collections-pull.js`, `universe-pull.js`, `person-pull.js`, `refresh-shows.js`, `tmdb-match.js`, `derived-views.js`, `tv-shows.js`, `organization.js`, `organization-manage.js`, `browse-views.js`.
- **Rule: when a deployment changes any versioned JS/CSS file, bump the token in `watchlist.html`** (for example `?v=20261015-x1`). This makes a new page load fresh copies instead of stale cached JS that doesn't match it. GitHub Pages caches files for 10 minutes.
- **`config.js`, `identity.js` and `ui-helpers.js` are deliberately unversioned.** The `/refresh-catalogs` workflow refreshes `config.js` by its plain URL (`fetch('config.js', {cache:'reload'})`), which only works while the page loads it without a token. If a future change to `identity.js` or `ui-helpers.js` must ship together with the page, add a token to that file then. Keep `config.js` unversioned unless the refresh workflow is updated too.
- An old cached page may keep running the old app for up to about 10 minutes after a deploy. That's accepted; the token guarantees that a **new** page never loads stale JS.

`tools/`, `tests/` and `db/` files are **never** loaded by the app.

**Before any change:** run `git status`, confirm the branch and commit, and inspect the tree.

---

## 3. File map & responsibilities (current, regenerated from the repo)

| File | Lines | Owns |
|---|---:|---|
| `watchlist.html` | 230 | Markup (including `#browseBar` and `#viewHead` for the browse views), **all mutable page state** (`let` vars, §4, including the Stage 3b-1 organization state (`personalCollections`, `watchWithChoices`, `orgState`, `watchWithState` and the read-sequencing counters), `tvShowsById`, the loaded `tv_shows` rows by id, and the browse-view state including a collection's presentation, grouping, TV seasons choice and date sections, and the restore-session state, and since `90738a8` `viewFilterMemory`, the open derived or browse view's filter values for the visit), script tags (with the `?v=` cache token, §2), boot. Has some harmless orphaned comment headers left over from the modular split. |
| `styles.css` | 584 | All CSS, including the browse views (selector bar, heading, section rows, read-only labels, expand buttons, the presentation / grouping controls and section buttons, with 44 px phone targets scoped to `.browse-controls`, `.section-toggle` and the show `.expand-btn`), the All TV Shows / Seasons switch and the "date needs review" tag, the derived-view styles (source badge, Upcoming/Today tags, "Not aired yet", the "Up to date" pill), status pills for every status, the show-scoped status select and the Skip / Keep button. Since `90738a8`: the selected filter pill (`.filter-pill[aria-pressed="true"]`: an accent ring drawn with `box-shadow`, so a badge's inline colours can't hide it, and ✕; a focus outline), the read-only watched pill `.ro-watch` / `.ro-watch.watched` (replaces `.ro-watched` and `.ro-label`) and `.manage-members-head`. |
| `config.js` | 448 | Constants: Supabase URL/key, `TABLE`, backup constants (`BACKUP_TABLES`, `BACKUP_FORMAT`, `BACKUP_FORMAT_VERSION`, `BACKUP_PAGE_SIZE`), `COLLECTIONS` + `DEFAULTS` (`truecrime` has `mixedMedia: true`), `WATCH_WITH_OPTIONS` (the household's fixed watch-with tags), `MCU_MOVIES` (39 `{t, id}` entries), `TMDB_TOKEN`/`TMDB_BASE`, `NETWORK_COLORS`, `UNIVERSE_LISTS` (`mcu`), `LAST_BACKUP_KEY`, `SHOW_KEY_OVERRIDES` (Phase 1a: maps `disney|the clone wars` to `star wars: the clone wars (2008)`, mirroring the database's `private.tv_show_key_override`). **Deliberately unversioned** (§2). |
| `identity.js` | 80 | `findExistingRow`, `isAlreadyAdded`, `normalizeTmdbTitle`, `pickTmdbMovieCandidate` (automated flows only), `isDuplicateKeyError`, `duplicateInsertMessage`, `cleanCollectionName` (display only). |
| `api.js` | 207 | `sbFetch`; `fetchAllRowsStrict(table, filter?)` (the browse views' complete read: every page must carry an exact Content-Range total, line up with the previous page, keep the same total and repeat no row id, and the rows read must equal the total, or it throws; `fetchAllRows` and its callers are unchanged); `fetchAllRows(table, filter?, select = '*')` (backups pass their exact columns) (paginated, exact-count verified; the optional PostgREST filter is used by the derived views, and backup/restore call it without one); **TV structural writes (Phase 2):** `TV_COLLECTION_IDS`, `isTvCollection`, `isTvSeasonRow`, `tvShowKey` (mirrors the database's TV-row and show-key rules, including `SHOW_KEY_OVERRIDES`), `sbRpc`, and `addTvSeasonRows` (one `add_tv_seasons` call per show; returns `{inserted, alreadyListed, rejected, reopened}` and keeps `tvShowsById` current). `tmdbFetch`. A failed `tmdbFetch` throws `TMDB error <status>` with **`err.status` attached**. (`deleteAllRows`/`batchInsertRows` were removed in `02f304f`.) |
| `ui-helpers.js` | 109 | `esc` (HTML-escapes `& < > "`); badge/color helpers; `parseDate`, `formatDisplayDate`, `showSaved`, `showError`; the **TMDB failure-reporting helpers** `tmdbNameList`, `tmdbLookupFailureNote`, `tmdbAddFailureNote`. |
| `backup-restore.js` | 689 | Building and downloading backups in **format 1, 2 or 3** (since Stage 3b-1, `detectBackupFormat` also probes `personal_collections`; production is format 3, seven tables; `validateOrganizationRows` checks the organization tables; a format-2 file is refused in the preview with guidance; a successful restore marks the organization stale (`invalidateOrganization`) and reloads it; earlier: `detectBackupFormat` probes `tv_shows` read-only; `BACKUP_FORMATS` lists each format's tables and exact columns; `user_id` is never included); the **hardened** validator (`validateBackupObject`, `RESTORE_COLUMNS`/`RESTORE_COLUMNS_V2`, `restoreValueProblem`, `validateBackupRows`, `validateTvShowRows`, `identityLossErrors`); the guarded restore flow, which now replaces all tables with **one call to the database function `restore_backup`** (§10), and post-restore verification. **Restore sessions (`540f411`):** `restoreSessionLive`, `invalidateRestorePreparation` — navigation abandons a restore that hasn't reached the database, every step re-checks after each await, and Restore does nothing in a browse view (§10). `finishRestoreAndReload` reloads the active browse view, derived view or tab. |
| `tabs.js` | 226 | `buildTabs` (view tabs first — `tabViewsFor`: the derived views in TV, All Movies in Movies — then collections, with `legacyTabLabel`; also draws the Browse collections bar and shows/hides Restore), `buildMediaSwitch`, `switchMediaType` (TV lands on Currently Watching, Movies on All Movies), `switchTab` (clears `activeViewId`), `switchView` (opens a derived or browse view; sets `activeTabId = null`; abandons a restore being prepared; resets the derived sections and All TV's season visibility, and reads the remembered All TV presentation), and `loadTab`, which reseeds static defaults (on TV tabs only the defaults missing by `item_key`, through `seed_tv_defaults`) and refreshes TBA defaults by `item_key`; then loads the tab's shows (`loadTvShows`) and notes any Complete show reopened by seeding. `switchTab` and `switchView` reset `viewFilterMemory` (a fresh entry starts from the filter defaults). |
| `render.js` | 755 | Since Stage 3b-1 the watch-with filter (`watchWithFilterControlHtml`, in its own `#fWatchWithWrap` with **Retry** beside it after a failed read), the row picker and the tags show the stored choices' labels (values are tokens). `renderFilters` and `renderTable` (both hand off to the browse-view renderers for a browse view, otherwise to the derived-view renderers when `activeViewId` is set); status filter by show status (`displayStatus`) and off-list state (`isOffList`), plus "Up to date only"; stats count TV statuses per show. **Flat** tabs (`renderFlatTable`): a TV season has the show-scoped status control, Watched and Skip / Keep; × on a built-in TV season means Skip. **Grouped** tabs (`renderGroupedTable`): one group per show (`show_id`), with the show control and an Up to date tag; seasons have Skip / Keep + Watched (+ × delete, Match); a True Crime / Docs film is its own group with its row status. Movies (`renderMoviesTable`) unchanged. Shared season helpers `seasonSubRowHtml`, `seasonSubCardHtml`, `seasonWatchControlHtml`, `seasonRowControlHtml`. **Filter pills (`90738a8`, §4d):** `FILTER_PILLS`, `filterPillHtml`, `toggleFilterSelect`, `toggleFilterPill`, `themeFilterSelectHtml`, `collectionTagPillsHtml`, `watchWithPillsHtml`; every theme / genre / network, collection-tag and watch-with label in the legacy renderers is a filter pill. |
| `row-actions.js` | 228 | `actionRows()` (empty in a browse view, so no row action can act there) and `mirrorRowUpdate()`; `toggleWatch` (a TV season through `set_season_watched`, a film by PATCH); `setStatus` (films only; ignored for a TV season); `delRow` (× on a built-in TV season → Skip via `setSeasonSkipped`, no confirm; a built-in film → status `skipped` after a confirm; anything else is really deleted after a confirm, a TV season through `delete_tv_season`, which removes an emptied show); `toggleAdd`, `toggleFilters`, `addEntry` (a TV season via `add_tv_seasons`), `toggleWatchWith` (since 3b-1 it sends nothing while the watch-with choices are loading or failed). |
| `tmdb-search.js` | 316 | Manual TMDB search: `tmdbSearchModeFor`, `selectTmdbSearchResults` (per-tab result selection, cap 6), `searchTMDB`, select/preview, `addSelectedTMDBSeasons` (captures collection and show id before its awaits; TV seasons on a TV tab go through `add_tv_seasons`, which also registers the show), `cancelTMDBPreview`, `resetTMDBSearchUI`. |
| `collections-pull.js` | 301 | Pull rest of collection, Refresh collections (with lookup-failure accounting), `updateCollectionRefreshLink` (the filter-from-tag helpers were replaced by render.js's filter pills in `90738a8`). Both add flows capture the collection before their awaits. |
| `universe-pull.js` | 217 | `pullUniverse` (id-backed; conservative title fallback; separates a genuine 404 "not found" from a failed request) and `addPulledUniverseMovies` (captures the collection before its awaits). |
| `person-pull.js` | 324 | Person search/select/role, `pullPersonFilmography` (same-title handling, tag backfill; captures the collection and won't redraw or write a preview into another tab or view), `addPulledPersonMovies`, `refreshPersonCollection`. |
| `refresh-shows.js` | 200 | `tmdbSeasonDateUpdate`, `refreshShows` (checks the tab's **identified shows from `tv_shows`** — `othertv_shows` is no longer read; new seasons, TBA→date updates, lookup-failure accounting), `addRefreshedSeasons` (captures the collection before its awaits; new seasons go through `add_tv_seasons`, one call per show). |
| `tmdb-match.js` | 336 | **Match to TMDB** (§7.3; Stage 3b-1: `match_tv_row` is called with `p_expansion` and a refused collection expansion is explained; failures are reported by how far the match got — nothing sent, sent, or a film PATCH accepted but not read back (`dde4079`)): `isTmdbMatchEligible`, `buildTmdbMatchPatch`, `findTmdbMatchConflict`, `tmdbMatchConflictMessage`, the UI (`openTmdbMatch`, `searchTmdbMatch`, `chooseTmdbMatchResult`, `chooseTmdbMatchSeason`, `renderTmdbMatchConfirm`, `cancelTmdbMatch`), and `confirmTmdbMatch` (finishes against `row.collection`; a TV-season match on a TV tab goes through `match_tv_row`; a film match on a row linked as a TV season also sets `show_id` to null, since films are never linked, then deletes the show if that emptied it (refused by ON DELETE RESTRICT — `23001` — otherwise, which is not an error); a blocked match (the target show has another status) explains itself and writes nothing). |
| `derived-views.js` | 828 | **Currently Watching / All TV (Shows or Seasons) / Coming Soon** (§4a). All TV Seasons: `ALLTV_PRESENTATION_KEY`, `ALLTV_SEASON_VIS`, `readAllTvPresentation`, `isValidDateSort`, `allTvSeasonVisible`, `deriveAllTvSeasons(items, vis)` (seasons of the filtered All TV shows: TBA / date needs review / dated, classified before sorting), `setAllTvPresentation`, `setAllTvSeasonVis`, `renderAllTvSeasons`, `allTvSeasonRowHtml`. Also: `DERIVED_VIEWS`; pure rules (`isTvViewRow`, `isTbaRow`, `localTodayStr`, `isReleasedRow`, `seasonOrder`/`compareSeasons`, `deriveCurrentlyWatching(rows, shows, today)` = the Watching shows with up next and Up to date, `deriveAllTv(rows, shows, today)` = every show with a linked season plus counts of TV rows it can't list, `allTvStatusMatches`, `deriveComingSoon(rows, shows, today)`); the loader (`loadDerivedView`: TV rows + all shows, both paginated); the filters (`renderDerivedFilters`; the Status select only in All TV; puts Search / Source / Status back once when Back returns from a collection); explicit per-view dispatch in `renderDerivedTable` / `updateDerivedTableHeader`; the renderers (`derivedShowHtml` for Watching and All TV cards, `neutralNextLabel`, `renderAllTv`, Skip only in Coming Soon) and toggles. Since `90738a8` (§4d): `themeMatchesRow`, `themeMatchesShow`, `ALLTV_PROGRESS_LABELS`, `allTvProgressMatches`, `derivedThemeChoices`; `deriveAllTvSeasons(items, vis, rowMatches)`; a Theme filter in all three views and All TV's Shows-only Progress filter; theme badges are filter pills (`themeBadgeHtml(collectionId, theme, owner)`); `loadDerivedView` keeps the visit's filters (`holdViewFilters`). |
| `docs/HANDOFF.md` | — | **This handoff**, the single canonical copy. Never loaded by the app. |
| `tools/tmdb-enrich-candidates.mjs` | 120 | Read-only (GET-only) TMDB enrichment review for one built-in collection (`disney`/`90day`/`sheridan`): legacy shows, TMDB candidates with details, proposed `Season N` → N mappings and the audit grade each would get (§16, §18). Proposals only; never picks a match. Grades with the owner-approved exceptions. |
| `tools/identity-audit.mjs` | 380 | Read-only (GET-only) production identity audit with A/B/C/D grading (§16). Pure grading functions are separated from network access. Applies the owner-approved exceptions. |
| `tools/identity-exceptions.json` | 60 | Owner-approved audit exceptions (§16): each turns one specific C into B while its bound values match. No row ids. |
| `db/` | — | **TV-show migration** (§18): `phase0_restore_v1.sql` (installed in production), the Phase 1b/1c migrations, `tv_model.sql`, `rpc.sql`, `restore_backup.sql` (owner-scoped), `stages.sql`, `rollback/`, `future/auth_switchover.sql` (future sign-in project only) and `test/` (test-project-only scripts and self-checking SQL). Run order in `db/README.md`. On production: `phase0_restore_v1.sql` (Phase 0), then `phase1b_ownership.sql` + `restore_backup.sql` (1b), then `phase1c_tv_schema.sql` + `tv_model.sql` + `phase1c_backfill.sql` (1c). then `rpc.sql` + the Phase 2 block of `stages.sql` (Phase 2, 2026-10-05). The Phase 3 and later blocks of `stages.sql` have **not** run on production. |
| `tools/db-rehearsal.mjs`, `db/test/rehearsal-steps.mjs` | 93, 229 | Local rehearsal of every `db/` script on PGlite against a production replica and a real backup (PGlite isn't a repo dependency). |
| `tools/db-rehearsal-3b.mjs` | 215 | Local Stage 3b-1 rehearsal on PGlite: replica at stage `final` from a format-2 backup, the migration, `db/test/t_3b_org.sql`, refused replay, the guarded rollback back to the identical catalog, re-apply, and the future sign-in script (§18). |
| `tools/db-rehearsal-3b2.mjs` | 222 | Local Stage 3b-2 rehearsal on PGlite: replica at stage `final` with Stage 3b-1 from a format-2 or format-3 backup, `db/phase3b2_org_write.sql` (data unchanged), second run refused, `db/test/t_3b2_org.sql` (24) and `t_3b_org.sql` (28) self-checks, 3b-2 edits as anon, `db/rollback/phase3b2.sql` (schema = 3b-1, edits kept) and re-apply; `--export-edited` / `--export-pre` write format-3 files; exports `buildReplica`. |
| `tools/db-rehearsal-rest.mjs` | 210 | API-level rehearsal against a test project with its publishable key; refuses the production URL. |
| `tools/tv-model-expectations.mjs` | 91 | Emits the reference model's answers as a self-check SQL script for a test project. |
| `tools/auth-isolation-test.html` | 455 | Two-user isolation test with genuine Supabase Auth sessions against the temporary test project only (hard-locked; passwords typed by the owner; no persistence). |
| `tests/tv-model-reference.js` + `tests/fixtures/tv-model-cases.json` | 156, 45 | The approved TV-model rules (up next, Up to date, status migration, compatibility values) and shared cases; not a suite. |
| `tv-shows.js` | 177 | **Phase 3 show model**: `TV_STATUS_ORDER`, `isTvSeason`, `showOfRow`, `displayStatus`, `isOffList`; `loadTvShows`/`loadAllTvShows`; the approved up-next and Up to date rules (`mainSeasonList`, `remainingSeasons`, `upNextSeason`, `isShowUpToDate`); `showStatusSelectHtml` (options show the plain status, e.g. "▶ Watching"; tooltip "Show status — applies to every season of …" and option group "Applies to all seasons of …"; the "Show:" prefix was removed in `97ab608`), `seasonSkipButtonHtml`; actions `setShowStatusById` (`set_show_status`; does nothing in a browse view), `setSeasonSkipped` (`set_season_skipped`); add outcome messages (`showTvAddOutcome`, `showNotice`). Never reads a TV season's `status`. |
| `tests/tv-model.test.js` | 108 | The TV-model reference (43 cases). |
| `tests/backup-format.test.js` | 110 | Backup formats 1, 2 and 3: read-only format probe, exact columns, never `user_id`, format-2 show/link validation, and restore across formats (a format-1 file is refused into a format-2 database) (6 cases). |
| `tests/restore-rpc.test.js` | 73 | Restore makes one `rpc/restore_backup` call, reports failures as "nothing was changed", and still verifies every field (3 cases). |
| `tests/identity-candidate.test.js` | 80 | `pickTmdbMovieCandidate` (9 cases). |
| `tests/title-attribute.test.js` | 38 | `esc()` round-trips titles in HTML attributes (5 cases). |
| `tests/season-date-update.test.js` | 62 | `tmdbSeasonDateUpdate` TBA→date rule (8 cases). |
| `tests/identity-audit.test.mjs` | 211 | Offline audit grading controls, including Reservoir Dogs, the owner-approved exceptions, exception reporting and unknown runtimes (67 cases). |
| `tests/restore-validation.test.js` | 123 | Pre-delete restore validation and identity-loss protection (35 cases). |
| `tests/search-selection.test.js` | 92 | Per-tab TMDB search selection (10 cases). |
| `tests/row-popover.test.js` | 88 | `toggleMorePopover` targets the tapped row's popover (5 cases). |
| `tests/tmdb-failures.test.js` | 247 | Outage, partial-failure and partial-add reporting across the real flows, with stubbed calls (21 cases). |
| `tests/tmdb-match.test.js` | 405 | Match to TMDB patch/conflict rules and the stubbed flow, including `match_tv_row`, the blocked match, the film-match unlink and empty-show removal, and (Stage 3b-1) failures by stage: a film PATCH accepted then not read back, a cancelled PATCH, no answer, and `match_tv_row` timeouts (33 cases). |
| `tests/organization.test.js` | 590 | Stage 3b-1 personal organization in the whole-page harness: the shared watch-with lists, membership-based Browse, startup and Retry states, stale and failed reads, restore of format 3 and refusal of format 2, watch-with labels, tokens and pickers with unfinished work kept, and Match's concurrency messages (30 cases). |
| `tests/organization-manage.test.js` | 805 | Stage 3b-2 Manage dialog in the whole-page harness: capability states, each edit and its refusals, uncertainty and reconciliation, Undo, focus, the write barrier and refresh obligations, and (`90738a8`) the add search before the member list (46 cases). |
| `tests/match-expansion.test.js` | 1121 | Stage 3b-2 Match expansion confirmation and Match refresh publication rules (57 cases). |
| `tests/tv-writes.test.js` | 337 | TV write routing: which writes use the TV functions and which stay direct; linking, the Clone Wars key, duplicates and "Already on your list", last-season delete, the seeding rule, Complete-show reopen (Refresh and seeding), Skipped shows stay Skipped, Refresh shows reading identified shows from `tv_shows` (19 cases). |
| `tests/all-tv-seasons.test.js` | 477 | All TV Shows / Seasons (§4a): first-use Shows and the switch, shared filters kept across toggles, visibility kept across toggles and reset on re-entry/reload (default All (except Skipped), `bc75a19`), the To watch / Watched / Skipped predicates including both flags and Skipped shows, the Shows full-context exception, oldest-first order with year headers and deterministic ties, TBA (incl. guessed dates) and date-needs-review separation and counts, read-only show status, scoped Watched / Skip edits with rollback, unchanged release controls, counts and empty states, device storage fallback, phone width (26 cases). |
| `tests/all-tv.test.js` | 352 | All TV (§4a): tab position and unchanged startup, GET-only loading, count-mismatch/failure Retry, stale responses, membership by show status with Skipped hidden by default, Status/Source/Search filters and their persistence, duplicate identities kept apart, deterministic order, unlinked/missing-parent reporting, Watching-only Up to date, neutral Next labels, expansion controls, the show/season actions by real id with rollback, phone width (19 cases). |
| `tests/app-harness.js` | 661 | **Shared harness, not a suite.** Runs the whole page in a Node `vm` (every script in `watchlist.html` order plus its inline state/boot script) against a fake DOM and an in-memory Supabase/TMDB stand-in. Supports pausing a request (`hold`) to simulate navigation mid-await, forced failures, and count mismatches. It also has independent in-memory versions of the browser-facing TV functions in the shadow and authoritative stages (`stage` option, default `final` like production; reopen and the Match block included; the tracking table only in shadow/authoritative; the compatibility copies aren't simulated), and links fixture TV rows to shows the way the backfill does. `format1: true` gives a database without `tv_shows`. No network. |
| `tests/derived-views.test.js` | 321 | Phase 3 view rules: up next and Up to date equal the reference model on every shared case; membership by show status; Coming Soon eligibility; rendering of show controls, Skip / Keep, Coming Soon's Skip-only controls, flat and grouped tabs, the Up to date filter; and a test that scrambling the season `status` column changes nothing (21 cases, including the check that every built-in theme has a badge style for dark and light, `c3c0443`). |
| `tests/derived-nav.test.js` | 413 | Startup, pagination and exact-count checks, navigation races, edits from a view (real id, mirrored cache, rollback), and the nine async guards (24 cases). Movies now opens on All Movies, so its Movies steps open the legacy Movies tab explicitly. |
| `organization.js` | 227 | **Stage 3b-1 personal organization (read-only)** (§4c, §5): `loadOrganization` (startup, Retry, after a restore; collections and watch-with choices published separately; a database without the tables gives "Collections unavailable" and the configured watch-with list), read tokens (`orgReadStart`, `publishCollections`, `publishChoices`, `invalidateOrganization`) so an older read never replaces newer data, `ORG_LAYOUT_KEYS` (the four original collections keep their device layout keys), `activeBrowseCollections`, `membersOf`, `watchWithChoiceList`, `watchWithLabel`, `watchWithUsable`, `watchWithStatusHtml`, and the targeted redraw (`redrawForWatchWith`, `redrawRowsKeepingPicker`) that keeps unfinished work and an open picker. |
| `organization-manage.js` | 830 | **Stage 3b-2 personal organization editing** (§4c, §5): the **Manage** dialog (`openManage`, `closeManage`) for collections (create, rename, archive / unarchive), members (add / remove a whole show or a film, with Undo) and watch-with choices (create, rename, archive / unarchive). Opening first checks `GET rpc/org_capabilities` (read-only; cached as "yes" for the session); every change calls one `org_*` function guarded by the values the page showed; an ambiguous answer is reconciled by a read and never re-sent; organization refreshes after edits keep unfinished work. Members view (`90738a8`): the add search and its results come before the "Members (N)" list. |
| `browse-views.js` | 902 | **Browse collections and All Movies** (§4c; since Stage 3b-1 a collection's members come from `collection_memberships`, read with `personal_collections` when the view opens). Presentation (`dec78d4`): `BROWSE_PRESENTATIONS`, `BROWSE_GROUPINGS`, `BROWSE_SEASON_VIS_LABELS`, `BROWSE_SECTION_DEFAULTS`; pure `deriveBrowsePresentation`, `compareBrowseAz`, `compareBrowseTie`, `chronoBuckets`, `browseEntryTitle` / `browseEntryId` / `browseEntrySource`; `enterBrowseCollection`, `readBrowseLayout`, `saveBrowseLayout`, `setBrowsePresentation`, `setBrowseGrouping`, `setBrowseSeasonVis`, `toggleBrowseSection`; renderers `browseEntryHtml`, `browseSeasonEntryHtml`, `browseSubsectionHtml`. Stage 3a: `ALL_MOVIES_VIEW`, `LEGACY_TAB_LABELS` (the constant collection list and layout-key prefix of Stage 3a were replaced in 3b-1 by the personal collections, `BROWSE_VIEW_PREFIX` and `ORG_LAYOUT_KEYS` in `organization.js`); pure rules `isFilmRow`, `uniqueById`, `compareFilms`, `deriveBrowseCollection`, `deriveAllMovies`; navigation `openBrowseCollection`, `browseBack`, `takeBackNavFilters`, `tabViewsFor`, `landingViewFor`, `buildBrowseBar`, `updateRestoreVisibility`; the loader `loadBrowseView` (both tables concurrently with `fetchAllRowsStrict`; a stale response is dropped); read-only renderers (`renderBrowseFilters`, `renderBrowseTable`, `renderBrowseCollection`, `renderAllMovies`, `browseShowHtml`, `browseFilmHtml`); `setBrowseMedia`, `toggleBrowseShow` with keyboard focus kept (`focusedContainerOf`, `refocus`). Since `90738a8` (§4d): `browseFilmMatches`, `BROWSE_WATCH_LABELS`, `browseWatchMatches`, the visit's filter values (`VIEW_FILTER_IDS`, `currentViewFilters`, `viewFilterStart`, `holdViewFilters`, `applyViewFilters`; also used by `derived-views.js`), `browseFilterBase`, `filmTagFiltersHtml`; All Movies' Watched filter and the Theme / collection-tag / watch-with filters; `browseWatchedHtml` draws the read-only watched pill. |
| `tests/browse-presentation.test.js` | 494 | Collection presentation (§4c; the TV seasons default All (except Skipped), `bc75a19`): controls per media, the four presentations and Movies-only A–Z, parent-show titles, chronology and ties under shuffles, TBA / Date needs review, TV seasons and its note, counts across all 12 combinations, filters kept across changes, empty states, preferences (per collection, only on change, invalid or unavailable storage), focus, expansion, the scoped phone controls, and read-only controls in every combination (18 cases). |
| `tests/filter-pills.test.js` | 423 | The list filters (`90738a8`, §4d): All Movies' Unwatched-only default, a changed choice kept through redraws, direct reloads, a failed read then Retry and Back, and reset on fresh entry; pills toggle, replace and clear with the selected state in table and cards; choices from the whole view; collection-tag and watch-with (renamed label, stored token) pills in All Movies and collection films; theme on any stored season of a show with every season kept, per season in Seasons; All TV progress rules (future, skipped seasons, Skipped shows, all-skipped shows) and a hidden Progress not filtering; Currently Watching and Coming Soon; legacy tabs; keyboard focus; a pill without its control is text; selected styling vs inline badge colours; no request or write (18 cases). |
| `tests/browse-views.test.js` | 842 | The browse views (§4c): navigation from TV and Movies, membership and classification, identity and state, filters, counts, order under shuffles, dates, empty/error states, strict reads (irregular pages, missing/malformed/changing totals, repeats, misaligned and early-empty pages, HTTP errors), races, read-only DOM and inert actions, the restore-navigation race at four points plus the confirmation guards, keyboard focus, phone width, and unchanged derived views (49 cases). |

**Totals:**
- **353** global functions (`90738a8` added 18 — six filter-pill helpers in `render.js`, four in `derived-views.js`, eight in `browse-views.js` — and removed the three filter-from-tag helpers of `collections-pull.js`; 338 before; Stage 3b-2 added 75, mostly in `organization-manage.js`, `tmdb-match.js` and `organization.js`; 263 before; Stage 3b-1 added 22, mostly in `organization.js`; 241 before; the collection presentation added 17; 224 before; Stage 3a added 36: 31 in `browse-views.js`, `fetchAllRowsStrict`, `restoreSessionLive`, `invalidateRestorePreparation`, `focusedContainerOf`, `refocus`; 188 before; Shows / Seasons added 8: `readAllTvPresentation`, `isValidDateSort`, `allTvSeasonVisible`, `deriveAllTvSeasons`, `setAllTvPresentation`, `setAllTvSeasonVis`, `renderAllTvSeasons`, `allTvSeasonRowHtml`; 180 before; All TV added `deriveAllTv`, `allTvStatusMatches`, `renderAllTv`, `neutralNextLabel`; 176 before), with no duplicate definitions (155 after Phase 2; Phase 3 added `tv-shows.js` and the new renderer helpers and removed the title-based `setShowStatus` and `nextStoredSeason`; cleanup removed `hasWatchableSoonSeason`).
- **85** distinct inline-handler names found by the literal sweep (§16; `90738a8` added `toggleFilterPill`, which never writes, and removed `toggleThemeFilterFromTag`, `toggleWatchWithFilterFromTag` and `toggleCollectionFilterFromTag`; 87 before; Stage 3b-2 added 22: the Manage dialog's 19 controls, the Match proposal's Back (`renderTmdbMatchConfirm`) and the Retry buttons `retryMatchRefresh` / `retryOrgRefresh`; 65 before; Stage 3b-1 added `loadOrganization`, the Retry buttons), all defined, plus `setBrowsePresentation` and `setBrowseGrouping`, which `browse-views.js` builds through a template and the sweep can't see (defined; covered by the read-only DOM tests). The presentation added those two and `setBrowseSeasonVis` and `toggleBrowseSection`, none of which writes; 62 before. Stage 3a added `openBrowseCollection`, `browseBack`, `setBrowseMedia`, `toggleBrowseShow` and `loadBrowseView`, none of which writes; 57 before; `setAllTvPresentation` and `setAllTvSeasonVis` added by Shows / Seasons). Phase 3 added `setShowStatusById` and `setSeasonSkipped` and removed `setShowStatus`.
- **574** offline test cases across 23 suites (`90738a8` added the 18-case `filter-pills` suite and one `organization-manage` case; 555 before; Stage 3b-2 added the 45-case `organization-manage` and 57-case `match-expansion` suites; 453 before; `c3c0443` added one `derived-views` case; 452 before; `bc75a19` added one `all-tv-seasons` and one `browse-presentation` case; 450 before; Stage 3b-1 added the 30-case `organization` suite and 5 `tmdb-match` cases; 415 before; the presentation added the 18-case `browse-presentation` suite; 397 before; Stage 3a added the 49-case `browse-views` suite; 348 before; Shows / Seasons added the 26-case `all-tv-seasons` suite; 322 before; All TV added the 19-case `all-tv` suite; 303 before it; 291 before the Single Life exception and reporting tests; 258 after the Sheridan enrichment; 255 before Phase 3; 248 at the end of the migration; the audit exceptions and unknown-runtime fix added 33 `identity-audit` cases): `derived-views` 20, `tmdb-match` 33, `tv-writes` 19, `identity-audit` 67, `organization` 30.

---

## 4. State & global architecture

**Mutable state lives in the inline script in `watchlist.html`.** This is deliberate; don't move it without approval.
- `activeMediaType`: `'tv'` or `'movie'`.
- `activeViewId`: the open derived view (`'watching'`, `'alltv'` or `'comingsoon'`), or `null` when a collection tab is open. It starts as `'watching'`.
- `activeTabId`: the open collection id, or **`null` while a derived view is open**. It starts as `null`.
- `tabData`: `{ [collectionId]: { rows, loaded, newKeys } }`. Tabs load **lazily, one collection at a time**. The derived views never write into it.
- `derivedData`: `{ rows, loaded }`, the cross-TV rows for the derived views, kept apart from `tabData`.
- `derivedLoadSeq`: a counter that lets a late derived-view load see that it has been superseded.
- `allTvPresentation`: All TV's `'shows'` or `'seasons'`; read from the device (`localStorage` key `watchlist_alltv_presentation`, outside backups; anything unusable → `'shows'`) each time All TV is entered.
- `allTvSeasonVis`: All TV Seasons visibility, `'notskipped'` (All (except Skipped), the default since `bc75a19`) / `'all'` / `'towatch'` / `'watched'` / `'skipped'`; kept across Shows/Seasons toggles; reset to `'notskipped'` on every view switch (and on reload). Never stored on the device.
- `browseData`: `{ rows, showsById, loaded }`, the browse views' complete read (§4c), kept apart from `tabData` and `derivedData`; `browseLoadSeq` drops a superseded load.
- `browseMedia`: a collection's `'all'` / `'tv'` / `'movie'`; All media on every entry.
- `browsePresentation` (`'shows'` / `'seasons'`) and `browseGrouping` (`'separate'` / `'combined'`): read on every collection entry from the device (`localStorage` key `watchlist_browse_layout_<collection>`, JSON `{presentation, grouping}`, outside backups; anything unusable → Shows + Separate) and written only when changed. `browseSeasonVis` (TV seasons; All on every entry, never stored) and `browseSectionOpen` (TBA collapsed, Date needs review expanded on every entry).
- `browseOrigin`: where Back returns from a collection (`{ mediaType, viewId, filters }`; `viewId` is null when it was opened from a legacy tab); `backNavFilters`: the Search / Source / Status Back puts back once.
- **Stage 3b-1 organization (`organization.js`):** `personalCollections` and `watchWithChoices` (the rows read; `null` until loaded), `orgState` and `watchWithState` (`'loading'` / `'ready'` / `'unavailable'` (failed: Retry) / `'absent'` (a database without the tables)), and `orgLoadSeq`, `orgReadSeq`, `orgCollectionsSeq`, `orgChoicesSeq`, `orgEpoch` (each read takes a number when it starts; only a newer read may replace what is shown, and a restore bumps the epoch so nothing read before it is published after it).
- `restoreSessionSeq`, `restoreInFlight`: the restore being prepared (navigation bumps the number) and whether `restore_backup` has been sent (§10).
- `derivedSectionOpen`: `{ uptodate, tba, alltvTba }`, the collapsible sections. Reset to `{ uptodate: true, tba: false, alltvTba: false }` (Up to date open, TBA sections closed) whenever a view is entered.
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
- The derived views render their own filter row (`fSearch` and a Source select, `fSource`; All TV adds a show Status select, `fStatus`, the Shows / Seasons switch and, in Seasons only, `fSeasonVis`, whose value lives in `allTvSeasonVis`) and mark it `view:watching`, `view:alltv` or `view:comingsoon`, so the same keep-on-re-render / reset-on-switch rule applies.
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

### 4a. Derived TV views: Currently Watching, All TV and Coming Soon (`fc9f796`, `4331e81`; live)

**They are not collections.**
- They're listed in `DERIVED_VIEWS` (in `derived-views.js`, separate from `COLLECTIONS`) and tracked by `activeViewId`.
- No row, backup, restore schema or query ever uses `watching`, `alltv` or `comingsoon` as a `collection` value.
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

**All TV** (Stage 1, Shows mode; `4331e81`, deployed 2026-10-06):
- **Position:** between Currently Watching and Coming Soon. The app still opens on Currently Watching.
- **Membership:** one card per show (`show_id`) with at least one linked season, **whatever its status**. Same loader as the other views (GET only; no seeding, no TBA refresh, no TMDB). Films are never listed. TV rows that aren't linked, or are linked to a show that wasn't loaded, are **counted and reported** above the list, never grouped (0 on production).
- **Order:** A–Z by title, then collection label, then show id. Shows from different collections stay separate cards, even with the same TMDB id.
- **Filters:** title search, Source, and show **Status**: the default **All (except Skipped)** (Complete stays visible), **All statuses**, or one status (Skipped included). Kept across same-view re-renders and edits; reset when switching views. Watching and Coming Soon have no Status filter.
- **Card:** the show status control, source and theme badges, progress, and the next season. A Watching show uses the Currently Watching rules: in progress (up-next season with Mark watched) or the **Up to date** tag. **Only a Watching show can be Up to date**; any other status shows a neutral "Next: Season N · date" (Upcoming / premiere date TBA) or "No remaining season on your list". A Skipped or Maybe show is dimmed.
- **Expanded:** every stored season with Watched (release rule: "Not aired yet" until it airs) and **Skip / Keep**. No add, no delete, no Match, no Seasons mode.
- **Stats:** shows (not seasons), Watching, Up to date, for the filtered list. Empty states: "No TV shows on your list yet." / "No shows match your filters."
- **Production (2026-10-06):** 186 shows by default (196 with All statuses, 10 Skipped); 10 Watching, 4 Up to date.

**All TV — Shows / Seasons presentation** (`77ff0ab`, deployed 2026-10-06):
- **Switch:** "Shows | Seasons" at the start of All TV's filter row (above the collapsible panel on phones). **Shows is the first-use default** and is exactly the All TV above. The choice is **remembered on this device only** (`localStorage`, outside backups and the database); missing, invalid or unavailable storage → Shows. Toggling reloads nothing and writes nothing.
- **Shared filters:** Search, Source and show Status apply in both layouts, select the same shows, and keep their values across toggles. Expanded shows stay expanded.
- **Seasons list:** the seasons of the shows that pass those filters.
  - **Classified before sorting:** genuine **TBA** (`/TBA/i` in `display_date` or the 2099 sentinel; wins over a guessed `date_sort`), **date needs review** (not TBA and no valid `YYYY-MM-DD` date), **dated** (the rest).
  - Dated seasons are **oldest first** under **year headers**. Ties: title, season order (numbered before Specials), collection, row id. Fully deterministic.
  - TBA and date-needs-review share one **collapsed** "TBA / no date" section with separate sub-groups and counts. Review rows are labeled "date needs review", are **not counted as TBA**, and are never tagged Upcoming/Today.
- **Season visibility (Seasons only):** a select, **All (except Skipped)** (default since `bc75a19`) / All seasons / To watch / Watched / Skipped.
  - **All (except Skipped)** = every season except those skipped on their own (the season's `skipped` flag); they are also left out of the counts. **All seasons** lists them too. The Status filter acts on the shows only, so it never hides a season of a show that passes it.
  - **To watch** = not watched, not season-skipped, and not of a Skipped show.
  - **Watched** = the season's `watched`; **Skipped** = the season's own `skipped` flag. These are independent: a season with both flags is in both, and never in To watch. Seasons of a Skipped show (shown when Status includes Skipped) are never To watch, but appear under Watched/Skipped when their flag is set.
  - The choice survives Seasons → Shows → Seasons and resets to All (except Skipped) on leaving All TV or reloading.
  - **Approved exception:** it never affects Shows; expanding a show in Shows always lists every stored season.
- **Season rows:** the show status as a **read-only label** (tooltip: applies to every season; change it in Shows), the existing Watched control with the **unchanged release rule** ("Not aired yet" for future/TBA; a date-needs-review row behaves as the existing rule says, today 0 rows), Skip / Keep ("Show skipped" for a Skipped show). No Up to date tag, add, delete or Match.
- **Stats:** Seasons / Shows / TBA (+ Date needs review when > 0). **Empty states:** no shows at all / no shows match / no seasons match / no dated seasons (see TBA).
- **Production (2026-10-06):** 615 seasons by default (637 with All statuses); To watch 493 (174 shows, 21 TBA), Watched 83, Skipped 39; 22 TBA (17 with guessed dates in the whole library); 0 dates needing review; 30 year headers, 1997–2027.

**Filters (all three views):** title search and a Source (collection) select, plus Status in All TV (and season visibility in All TV Seasons). Stats: In progress / Up to date; Shows / Watching / Up to date; or Dated / Next 30 days / TBA.

**Edits from a view:**
- Show status → `setShowStatusById` → `set_show_status`; Watched → `toggleWatch` → `set_season_watched`; Skip / Keep → `setSeasonSkipped` → `set_season_skipped`. All by real ids; the database writes the compatibility copies.
- After a successful write, `mirrorRowUpdate()` copies the saved row onto every cached copy (`tabData[*]`, `derivedData`); a show change updates `tvShowsById`. A failed write rolls back and shows the error.

**Startup and navigation:**
- The app opens on **TV → Currently Watching**.
- **Movies → TV always returns to Currently Watching**; it doesn't restore the last TV tab.
- Collection tabs behave as before.
- `finishRestoreAndReload()` reloads the active view or tab.

### 4c. Browse collections and All Movies (Stage 3a: `e89a932`, `540f411`; presentation: `dec78d4`, `575e6c4`; membership-based since Stage 3b-1, `dde4079`; live)

**Since Stage 3b-1 (deployed 2026-10-06):** the selector lists the owner's **personal collections** (`personal_collections`, not archived, in their order), loaded at startup without holding up the first view; until they arrive it says so, and a failed read shows **"Collections unavailable" + Retry**, never an empty list. A collection's view id is `browse:<collection id>`. **Membership comes from `collection_memberships`** (a whole show or a film), read when the view opens — no longer from the storage tab. At the cutover the four collections (Disney+, Sheridan, 90 Day, True Crime / Docs) were bootstrapped with exactly what each tab stored (135 shows + 16 films), so every count below was unchanged by the release. The four original collections keep their device layout keys (`watchlist_browse_layout_disney` etc.); any later collection uses its id. There is **no UI to change collections or memberships yet** (Stage 3b-2, not implemented). The bullets below describe Stage 3a; where they say "storage tab", read "membership" for a collection's contents (All Movies still lists every film from every tab).

**Since Stage 3b-2 (deployed 2026-10-08):** a **Manage** button beside the selector, **Edit members** in a collection's heading and **Manage choices…** beside the Movies watch-with filter open one dialog (`organization-manage.js`) that edits collections, memberships and watch-with choices through the `org_*` functions (§5). Archived collections leave the selector (their members stay saved everywhere else); archived choices aren't offered for new assignment, stay shown on rows that have them, and are listed under "Archived" in the Movies filter. Originals (Disney+, Sheridan, 90 Day, True Crime / Docs) can be renamed and archived; their tabs are unaffected.

**Read-only views over what's saved**, defined in `browse-views.js` (not `config.js`). Like the derived views they are not collections: `activeViewId` holds `browse-disney`, `browse-sheridan`, `browse-90day`, `browse-truecrime` or `allmovies`, `activeTabId` is null, and no destination id is ever sent as a `collection` value.
- **Navigation:** the **Browse collections** selector (under the tab bar, in TV and Movies) opens a collection titled e.g. **"Sheridan — All media"**, with **← Back to TV / Movies**. Back returns to the view it was opened from with its Search / Source / Status (All TV's season visibility still resets, as on every entry), or to the area's first view if it was opened from a legacy tab, without running that tab's loader. **Movies opens on All Movies**; the `movies` tab is shown as **Movies (legacy)** and keeps every tool. The app still opens on Currently Watching.
- **Membership (Stage 3a; since 3b-1 the stored memberships, above)** was the storage tab only (`collection`): no tags, themes, titles, TMDB credits or aliases add anything, so a film stored in Movies with a "Sheridan" tag isn't in Sheridan. True Crime / Docs says: *Your existing combined list. True Crime and Documentary are not yet classified separately.*
- **Classification:** a film is `media_type = 'movie'`, or a legacy row labelled `Film`; an explicit `media_type = 'tv'` is never a film. TV seasons are `isTvViewRow` rows grouped by `show_id` (a season whose show is missing or in another collection is counted in a notice, never listed or turned into a film). Specials, Volumes and Parts keep their classification (the 14 Disney+ Special candidates stay TV). All Movies reports rows that are neither TV nor film.
- **A collection:** a **TV** section (one entry per show, A–Z, then source, then show id; expand for every stored season in season order with Watched / Season skipped as text) and a **Movies** section (films A–Z, then source, then row id), each with its filtered count; **All media / TV / Movies** hides a section without changing membership. Search and **Status** (default **All (except Skipped)**; All statuses; or one) apply to the show status for TV and the film's own status; they survive media changes and reset on every fresh entry. Stats: Shows · Season entries (Specials and parts included) · Films. Up to date only for a Watching show. Dates: TBA (text or sentinel) wins over a guessed date; an invalid date is labelled "date needs review"; a valid future date is Upcoming.
- **Presentation (`dec78d4`, `575e6c4`):** three independent controls in a collection — media (All media / TV / Movies), **TV presentation** (Shows / Seasons; hidden for Movies only) and **grouping** (Separate / Combined; All media only). First use is All media + Shows + Separate.
  - **Shows** lists show groups A–Z (expandable as above); **Movies only is always A–Z**, whatever the hidden presentation; **Seasons** lists TV season entries and films **oldest first** (Separate: per section; **Combined: interleaved**), with ascending year headers. A season entry is **displayed and sorted by its parent show's title**, then its stored label (saved rows unchanged; All TV's Seasons list keeps its own behaviour).
  - **Ties:** A–Z by title, TV before film, source, id; equal dates by title, TV before film, season order (two seasons), source, row id. Fully deterministic.
  - **Dates (Seasons):** classified before sorting — genuine **TBA** (text or the 2099 sentinel; wins over a guessed date) in a collapsed **TBA** section; no valid date in a separate, expanded **Date needs review** section; both are buttons with `aria-expanded` and keep focus, per section (Separate) or shared (Combined). This intentionally differs from All TV's single "TBA / no date" section.
  - **TV seasons: All (except Skipped) / All / To watch / Watched / Skipped** (Seasons only, inside the filter panel; All TV's semantics) narrows TV season entries only, never films. **All (except Skipped)** is the default on every entry (since `bc75a19`): seasons skipped on their own are hidden and not counted (the Status filter acts on shows and films only, so before this a skipped season of an On List show was listed, greyed, under the default Status); **All** lists them, labelled "Season skipped". A show whose listed seasons are all hidden isn't counted as a show in Seasons. When films are visible and the choice is To watch, Watched or Skipped, the view says "Films aren't filtered by this." Kept for the visit across Shows / Seasons and media changes. Shows is unaffected: an expanded show lists every stored season.
  - **Counts** keep Shows, Season entries and Films apart (Seasons: the shows contributing listed entries); grouping never changes counts or members; collapsed sections still count.
  - **Device preference:** only the presentation and grouping, per collection, written only when changed (never on entry), independent of All TV's key.
  - **Phones:** media, presentation and grouping sit outside the collapsible panel (presentation and grouping side by side at 375 px, stacked at 300 px); their buttons and the section buttons are at least 44 px tall, and since `ca092dd` the show expand buttons are at least 44 × 44 px with the 20 px chevron centred (all scoped to these views; desktop sizes and All TV's toggle are unchanged).
  - **Production (2026-10-06):** Disney+ Seasons: 166 dated TV entries 2003–2027 + 9 TBA; To watch 94 shows · 162 season entries (films 2, unfiltered); no production row needs date review (that section was verified with synthetic rows in the isolated preview).
- **All Movies:** every film from every tab (the same row, not a copy), Search, Source (the storage tab, not streaming availability), Status. Since `90738a8` (local, not deployed; §4d) also **Watched** (Unwatched only on entry), genre / theme, collection tag and watch-with, and its tags and watch-with labels are filter pills (before: plain text).
- **Strictly read-only:** the loader reads `watchlist_items` and `tv_shows` concurrently with `fetchAllRowsStrict` (exact counts, aligned pages, no repeats) and shows Retry on any failure, never a partial or empty list; it never calls `loadTab` (which can seed defaults and PATCH TBA dates) and never fills `tabData`. A response for an earlier entry is dropped. The two reads are concurrent but not a transactionally consistent snapshot; a broken link found that way is reported with "Read again". The rendered controls only search, filter, expand and navigate. `actionRows()` is empty and `setShowStatusById` does nothing there; **Restore is hidden** and its entry points do nothing; Backup stays. This is a guarantee about these views, not an app-wide write lock: a legacy tab's in-flight seeding isn't cancelled by opening a browse view.
- **Keyboard:** expand and section buttons are labelled ("Show/Hide seasons of …", `aria-expanded`); after expanding, collapsing, or changing media, presentation or grouping, focus returns to the same control. On phones the heading and the media choice stay outside the collapsible filter panel.
- **Production (2026-10-06):** Disney+ 101 shows · 175 season entries · 2 films by default (103 · 178 · 4 with All statuses); Sheridan 13 · 33 · 8 (14 · 34 · 8); 90 Day 9 · 56 · 0 (15 · 72 · 0); True Crime / Docs 3 · 3 · 4; All Movies 74 films by default, 77 with All statuses (Movies 61, Disney+ 4, Sheridan 8, True Crime / Docs 4), 43 watched. No broken links, no unclassified rows, no repeated identities.

### 4d. List filters and filter pills (`90738a8`; committed locally, **not deployed**)

Client-side only: filtering redraws the loaded rows and never sends a request or writes. Status, Watched / Skip / Keep and other action controls, source badges and informational tags are unchanged.
- **Filter pills** (`render.js`): a genre / theme / network badge, a legacy **collection tag** (cleaned name; a saved content tag, never a personal collection) and a **watch-with** label (filtered by its stored **token**, showing the choice's current label) are buttons wherever they appear: Currently Watching, All TV (both presentations), Coming Soon, All Movies, Browse collections (films' tags and watch-with; every theme badge) and the legacy tabs. **One value per filter:** clicking the selected pill clears it, another pill replaces it. Every pill with the selected value shows `aria-pressed="true"`, an accent ring and ✕ (title "Remove this filter (…)"); Enter and Space work, and keyboard focus stays on the same pill after the redraw (else the filter control). The collapsed phone filter panel opens so the active choice is visible. On the legacy Movies tab a collection tag still updates that tab's ↻ Refresh link (a read); nowhere else. A pill whose filter control isn't shown is plain text.
- **Filter controls:** a Theme select in all five views (choices from every show, season or film the view lists before filtering, so a choice can always be changed or cleared); in All Movies and in a collection whose films are shown, Collection tag and Watch with selects (offered when some film has one). Different filters combine with AND.
- **Theme matching:** a film or season by its own theme; a **show** when **any stored season** has it. A matched show keeps **all** its seasons for progress, up next, Up to date and expansion; its badge still shows its up-next (or first) season's theme, so a show matched through another season shows an unselected pill (accepted; the active filter is in the select). In Seasons presentations the theme applies to each season.
- **All Movies Watched:** *Any watched state / Unwatched only / Watched only*, on the stored `watched` flag (never the status). **Unwatched only on entry**; Status still hides Skipped films by default. Stats: **Shown** (the list) and Films · Watched · To watch counted before the Watched filter.
- **All TV progress (Shows only):** *Any progress / Has unwatched seasons / All non-skipped seasons watched*, on the seasons' flags, never the show status (Status filters separately). Skipped seasons don't count; future unwatched seasons do. **Has unwatched seasons never matches a Skipped show** (the To watch rule of Seasons); **All non-skipped seasons watched** needs at least one non-skipped season and can match a Skipped show when Status includes Skipped. In Seasons the control is hidden and doesn't filter; the existing TV seasons choice is unchanged.
- **Collections:** while a collection-tag or watch-with filter is set, no TV is listed (only films carry them), and the view says so; with TV only, those controls are hidden and don't filter.
- **Kept for the visit** (`viewFilterMemory`): every value survives redraws, presentation and media changes, a direct reload, a failed read and Retry (`holdViewFilters` before a loader clears the row), and Back (the origin's values, including hidden ones). A control hidden by the current mode keeps its value without filtering. A fresh entry (`switchView` / `switchTab`) starts from the defaults. Browse views' Retry now keeps filters (before: reset).
- **Read-only watched state** in Browse views: a grey "Not watched" / green "✓ Watched" pill in the Watched button's colours, not a control.
- **Manage → Edit members:** the add search and its results come before the "Members (N)" list.
- **Validation (local):** offline 574/574 (23 suites), handler sweep 85 / 353; an isolated real-Chrome check (local page, the app files against an in-memory synthetic backend, every other request refused) at desktop and in a 375 px frame: pills by mouse and keyboard, selected state, All Movies and All TV filters and reloads, desktop and phone Manage, legacy selected pills; only GETs, no console errors from page load on. Not checked on a physical phone; not deployed.

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
- `tv_shows` (since 1c, below).
- **Since Stage 3b-1:** `personal_collections`, `collection_memberships`, `watch_with_choices` (below).

Postgres is 17.6. RLS is enabled and permissive: the anon role can select, insert, update and delete on every public table, which is an accepted family-app trade-off (16 anon policies before 3b-1: the original 12 plus 4 on `tv_shows`; Stage 3b-1 added 12 on its three tables, with column grants that keep `user_id`, `legacy_source` and choice tokens out of client writes and allow memberships to be inserted or deleted but never edited). Since Stage 3b-1 there are five triggers (below); before it there were none. API roles' statement time limits (read from production, 2026-10-06): anon 3 s, authenticated 8 s; a blocked API call is cancelled with 57014 at that limit even where a function's own lock wait is longer.

**Since Phase 1 (2026-10-04) and Phase 2 (2026-10-05):**
- **Ownership (1b):** every public table has `user_id uuid NOT NULL`, defaulting to `private.current_owner_id()`, the bootstrap owner in `private.app_owner` (one owner; no production Auth users; no foreign key to `auth.users`). Clients can't write `user_id`: INSERT/UPDATE are granted per column, excluding it. Reads return it. The unique keys below are per owner (`user_id` leads each). `private` is closed to clients.
- **TV schema (1c):** `tv_shows` (`id`, `user_id`, `collection`, `title`, `show_key`, `tmdb_id`, `status` in `pending/confirmed/watching/maybe/complete/skipped`, `created_at`), and on `watchlist_items` `show_id uuid` (nullable) and `skipped bool NOT NULL default false`. Composite FK `(show_id, user_id, collection)` → `tv_shows(id, user_id, collection)`, ON UPDATE CASCADE, ON DELETE RESTRICT. Checks: films can't link; `skipped` requires `show_id`. Helper functions in `private` come from `db/tv_model.sql`.
- **Stage:** `private.migration_stage` = **`final`** (since 2026-10-05 14:32 UTC; `authoritative` from 14:02). **`tv_shows.status` is the TV workflow status.** Season rows are authoritative for watched, skipped, identity, dates and metadata. The season `status` column stays populated (it was normalized to the approved projection at the Phase 3 switch and verified exact for all 196 shows just before `final`) but **is no longer written for TV** (the functions skip `private.tv_project_legacy_status` at `final`) and is never read by the app; it is not dropped. At `final` the functions also **no longer maintain `othertv_shows`**; Refresh shows reads the identified shows in `tv_shows` instead (`59dd6a1`), and `othertv_shows` stays in the database, unused (64 rows, equal to the identified shows when `final` began). Reopen: a genuinely new season added to a Complete show (Refresh, TMDB add, manual add, seeding) reopens it On List, atomically; duplicates, date-only updates, Match and Restore don't. Skipped shows stay Skipped. **Enriched built-in shows (Disney+, 90 Day, Sheridan only):** a later season of a TMDB-matched built-in show — from seeding (a catalog refresh) or a manual Add entry — joins that show as TMDB season N when its label is exactly `Season N` (reopen rule applies); any other label, or an item key / TMDB season held by another row, is **rejected for review** (the app says "Not added — needs review"; a held-back built-in season repeats that note on each load of the tab); a second show is never created. Other TV and True Crime / Docs keep their behavior.
- **Stage 3b-1 (production migration 2026-10-06, `db/phase3b_org.sql`, one self-verifying transaction; §18):**
  - `personal_collections` (`id`, `user_id`, `name`, `legacy_source` (`disney`/`sheridan`/`90day`/`truecrime` for the four original collections, else null), `sort_order`, `archived_at`, `created_at`); names unique per owner ignoring case, archived ones included. Bootstrapped: Disney+, Sheridan, 90 Day, True Crime / Docs.
  - `collection_memberships` (`id`, `user_id`, `collection_id`, exactly one of `show_id` / `item_id`, `created_at`, generated `item_is_film`): a whole TV show or a **film** in a collection. A film target is enforced by a composite foreign key to `watchlist_items (id, user_id, is_film)`, so a TV season can never be a member. Bootstrapped: exactly what each mapped tab stored (135 shows + 16 films).
  - `watch_with_choices` (`id`, `user_id`, `token`, `label`, `sort_order`, `archived_at`, `created_at`): rows keep storing tokens in `watch_with`; a label can change without rewriting rows. Labels unique per owner ignoring case. A trigger refuses a row value that isn't a choice (and NULL values), and a choice still used on a row can't be deleted or have its token changed. Bootstrapped: Alone, Suzanne, Rina, Whole Family (the configured list, which already covered every used value).
  - `watchlist_items.is_film`: **generated** (`media_type = 'movie'`, or a legacy row labelled `Film`); clients can't write it; it appears in `select=*`. Fingerprints exclude it (§16).
  - **Temporary membership trigger** (`org_auto_membership_show`, `org_auto_membership_film`, `org_carry_membership_to_film`): a genuinely new `tv_shows` row or film in Disney+, Sheridan, 90 Day or True Crime / Docs joins that tab's collection; a TV season matched as a film keeps its show's collections. It never fires on reads, refreshes, ordinary edits, skipped duplicates, failed inserts or new seasons of an existing show, so it never puts back a removed membership; Other TV and Movies have no mapped collection. **It stays until the legacy creation paths retire or are routed through membership-aware functions, through separately approved work; it does not expire automatically at Stage 3b-2.** The other two triggers are `org_check_watch_with` and `org_guard_watch_with_choice`.
  - `restore_backup` accepts **format 3 only** and replaces all seven tables, organization included (§10); `match_tv_row` gained `p_expansion` and keeps memberships when Match converts a row (§7.3).
  - **Direct collection edits** (admin or direct REST; since Stage 3b-2 the app edits only through the `org_*` functions) may make the old storage-based Browse views (of a pre-3b-1 page) differ from the membership-based views; they don't inherently corrupt organization data.
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

- **Stage 3b-2 (production migration 2026-10-08, `db/phase3b2_org_write.sql`, SHA-256 `e8e0f41e0042101d91780d06c9d94f962780bef5e2cb8c949b01a278b3ea9048`, one transaction; §18):** functions only, no table, column, index, constraint, policy, table-grant or row change.
  - `public.org_capabilities()` (read-only, `{"org_write":1}`) and eight write functions: `org_create_collection`, `org_rename_collection`, `org_set_collection_archived`, `org_add_membership`, `org_remove_membership`, `org_create_choice`, `org_rename_choice`, `org_set_choice_archived`; helpers `private.org_refuse`, `private.org_clean_text`. All security invoker, `search_path` empty, executable by `anon` and `authenticated` (not PUBLIC). Each is one transaction, owner-scoped, guarded by the values the page showed (`org_conflict` instead of overwriting a newer change), and refuses with readable `org_*` messages.
  - The trigger function `private.org_check_watch_with` now also refuses an UPDATE that **newly adds an archived choice** (`23514 watch_with_archived`); rows that already carry it keep it, and an INSERT (restore) is accepted.
  - **Rollback:** `db/rollback/phase3b2.sql` (after an app revert) drops the 11 functions and restores the 3b-1 trigger body; it keeps every row and every 3b-2 edit, after which newly adding an archived choice is no longer refused. Rehearsed locally and on the hosted test project.

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
- **Since Stage 3b-1 (`dde4079`):**
  - A TV-season match calls `match_tv_row` with `p_expansion: {}`; memberships move with the row. If joining an existing show would show its other saved seasons in more collections, the database **refuses and explains**, and nothing is written. Since Stage 3b-2 the page shows that proposal ("Matching also adds a show to collections", archived ones marked from a fresh read) and **Match and add to these collections** re-sends with the confirmation token. A pre-3b-1 page's three-argument call gets the same refusal as an error message.
  - A concurrent change refused by the database (40001 re-check or a 40P01 deadlock victim) says "Something else was changing the same show or collections at that moment, so nothing was matched. Try again." A transaction cancelled for time (55P03 lock wait or 57014 statement limit) says it was cancelled and nothing was matched.
  - A film match is a guarded PATCH and then a separate read-back: if the PATCH was accepted but the read-back failed, or a write got no answer at all, the page says the outcome is unconfirmed — "reload the page and check this row before matching it again" — and changes nothing locally (it doesn't remove a former show either).
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

- Exports every table of the database's format with paginated, exact-count-verified fetches (**seven since Stage 3b-1**).
- JSON shape: `{ format: 'watchlist-tracker-backup', formatVersion, exportedAt, rowCounts, tables }`.
- **Format (since `b266a5b`):** the app probes `tv_shows?select=id&limit=1` (read-only). 200 → **format 2**: four tables (`watchlist_items` with 20 columns incl. `show_id`/`skipped`, `tv_shows` 7, `othertv_shows` 6, `custom_collections` 5). 404 `PGRST205` → **format 1**: the original three tables. Anything else aborts. Each table is fetched with its exact column list, so **`user_id` is never in a backup**. **Since Stage 3b-1 a 200 from `personal_collections` too → format 3**: the four format-2 tables plus `personal_collections` (6 columns), `collection_memberships` (5) and `watch_with_choices` (6); the generated `is_film` / `item_is_film` are never included. **Production is format 3** (since 2026-10-06).
- Filename: `watchlist-backup-YYYY-MM-DD-HHMM.json`.
- The same backup can be produced from Node by running the app's own `config.js`/`api.js`/`backup-restore.js` in a `vm` sandbox and calling `buildBackupObject()` + `validateBackupObject()`. That's how the recent backups were taken.

### Restore (⬆ Restore): the flow

1. The file is parsed and run through **`validateBackupObject`**.
2. The preview fetches the current data and runs **`identityLossErrors`** against it.
3. **`executeRestore`** builds a safety backup of the current data **and validates it in memory**, including the identity-loss check against it. Any failure aborts with "nothing was changed".
4. The safety backup is downloaded (`watchlist-pre-restore-*.json`), and the user confirms they can see it.
5. One call to the database function **`restore_backup(p_backup, p_allow_v1_reset)`** (since 1b: `db/restore_backup.sql`, owner-scoped and stage-aware) replaces **the current owner's** rows **in a single transaction**, preserving ids and `created_at`. It re-checks the format, version, the table set, `rowCounts` and each row's exact columns, and any error rolls everything back. The preview refuses a format-2 file while the database is format 1, and **since Phase 3 refuses a format-1 file into the format-2 database** (TV show status exists only in `tv_shows`, which a format-1 file lacks); `p_allow_v1_reset` is always sent as `false`. **Since Stage 3b-1 the preview refuses a format-2 file** ("This backup is format 2, from before personal collections … Nothing was changed") without sending a restore request, and the database refuses formats 1 and 2 as well; a format-3 restore replaces all seven tables, collections, memberships (exclusions included) and watch-with choices exactly as the file holds them, then the app reloads the organization. The database refuses format 1 at stage `authoritative` too. (Before `02f304f` the app deleted and batch-inserted table by table.)
6. The data is re-fetched and verified field by field against the backup.

**Restore sessions (`540f411`):** a restore being prepared (file read, preview, safety backup, confirmation) belongs to the view it started in. Any navigation abandons it and closes its dialog unless `restore_backup` has already been sent; each step re-checks after every await, so a late step never opens a dialog or downloads anything; and both confirmation steps refuse to run in a browse view, where Restore is hidden.

### Recovery since Stage 3b-1 (precise)

- **Format-2 backups are refused on the new schema.** They become usable again only after a permitted rollback of Stage 3b-1 (`db/rollback/phase3b.sql`, which needs its own approval).
- **That rollback depends on current-state representability, not on history.** It runs only when the old model can represent the current state exactly — each owner has exactly the four original collections with their original names and order, none archived; memberships equal what the tabs store; every configured watch-with value is a choice, every other choice is used on a row, labels equal tokens, none archived, in canonical order — and otherwise refuses, changing nothing. Having changed collections at some point doesn't by itself block it; a current state the old model can't hold does. (The script's header comment says "refuses if the organization changed"; the checks above are the contract.) If it refuses, recovery is to fix forward, or take a format-3 backup and decide explicitly about a lossy rollback.
- **The current recovery baseline is format 3** (below). Format-3 files can't be restored on a pre-3b-1 database.

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
- **`restore_backup` (production):** `restore_backup(jsonb, boolean)` returning jsonb; plpgsql; `SECURITY INVOKER`; `search_path` set to empty; executable by `anon`, `authenticated` and `service_role`, not `PUBLIC`. Since 1b its body matches `db/restore_backup.sql` exactly (verified by MD5 in the catalog; it replaced the Phase 0 `db/phase0_restore_v1.sql`). At stage `authoritative` (since Phase 3) it accepted **format 2 only**; format 1 is refused whatever `p_allow_v1_reset` says (format 1 was accepted with that flag in `tv_schema`/`shadow`). **Since Stage 3b-1 (2026-10-06) it is the `db/phase3b_org.sql` version and accepts format 3 only** (source verified equal to the repository after the migration). **It has never been called on production**; its behavior was verified locally (PGlite) and on temporary test projects, and the format-3 baseline was restored successfully into an isolated local replica of the migrated schema.
- **Minor:** safety-backup filenames only go down to the minute. Two restores in the same minute could make a browser rename the second download to "(1)", while the dialog shows the original name.

### Rehearsal (2026-09-26)

- A **temporary, isolated Supabase project** was created with a schema copied from production; the catalog diff was clean. The **real** restore code ran in a Node harness with a fetch guard that blocked the production host.
- Results:
  - The restore reproduced production **byte-for-byte**, matching the SQL fingerprints.
  - The safety-backup recovery drill passed.
  - All 22 failure-injection cases behaved as expected. After hardening, every data-level bad backup is rejected **before DELETE**.
- **That rehearsal project has since been deleted.** A second temporary test project, created for the TV-show migration (§18), was deleted by the owner on 2026-10-05 once the migration was complete; rehearsals now run locally (PGlite). A third temporary test project was created on 2026-10-06 for the Stage 3b-1 hosted checks (synthetic data only, §18); **the owner deleted it on 2026-10-06** after the release, and its local credentials and test app copies were removed.
- The **browser UI smoke test** of restore (file picker and real download) was **intentionally skipped** by owner decision. The harness exercised the same functions.
- **Never run a destructive restore on production just to test it.**

### Latest known-good backups

- Backups are kept **outside the repo**, never committed. Ask the owner where current backups live.
- **The current recovery baseline (2026-10-08 05:02 UTC, right after the Stage 3b-2 app release, §18):** **format 3, validated by the release code, all seven tables**: 714 / 196 / 64 / 1 / 4 / 151 / 4. Its seven per-table data hashes equal the backup taken just before the Stage 3b-2 database migration (04:10 UTC): Stage 3b-2 changed no data. It restores into a local replica, and the Stage 3b-2 rehearsal passes on it.
- Previous: **the Stage 3b-1 baseline (2026-10-06 23:21 UTC, right after the Stage 3b-1 app release, §18):** **format 3, validated, all seven tables**: 714 / 196 / 64 / 1 / 4 / 151 / 4 (`watchlist_items` / `tv_shows` / `othertv_shows` / `custom_collections` / `personal_collections` / `collection_memberships` / `watch_with_choices`), built and validated with the deployed release's own code; an independent read-back was identical, and restoring it into an isolated local replica of the migrated schema gave all seven tables equal to the file and to production field by field. The last format-2 backup was taken at 23:10 UTC just before the migration (714 / 196 / 64 / 1); it is restorable only after a permitted rollback (above).
- Historical: the latest format-2 backup before that era (2026-10-05 20:11 UTC, right after the Disney+ enrichment) was 719 / 197 / 64 / 1, taken with the deployed app's own backup code. Historical: the first format-2 backup (718 / 196 / 64 / 1) was taken 2026-10-04 22:26 UTC after Phase 1c (`b266a5b`). The last format-1 backup (718 / 64 / 1) was taken 22:17 UTC, immediately before Phase 1b; the original-column content of the three tables was unchanged by Phase 1.
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

**Added 2026-10-06 (collection presentation deployment):**
- Live checks of the deployed site load the page into a same-origin frame (host: the deployed `config.js` URL) whose `fetch` is replaced after `document.open()` and before the page HTML is written, so production writes are blocked **before any app script runs**; console errors are captured the same way.
- **Device preferences are the owner's settings.** Before a live check, capture every `watchlist_browse_layout_*` value and All TV's `watchlist_alltv_presentation` value (or its absence); afterwards restore every captured value exactly, remove only layout keys that didn't exist before, never write All TV's key or clear other storage, and report the result. A private helper for this is kept outside the repo with the other browser tooling.

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
- **Personal organization (Stage 3b-1, 2026-10-06):** collections and memberships are stored, owner-scoped, and separate from the storage tab; a membership is a whole show or a film; watch-with values are tokens with editable labels; format 3 is the only restorable format; the temporary trigger stays until the legacy creation paths retire or are made membership-aware (separately approved; not tied to 3b-2); True Crime / Docs stays one transitional combined collection; the 16 collection films aren't moved and the Disney+ Specials aren't reclassified. Editing collections, memberships and choices: Stage 3b-2 (next bullet).
- **Personal organization editing (Stage 3b-2, 2026-10-08):** one Manage dialog beside the Browse selector (watch-with choices in it, with a link from the Movies filter); archived collections are read-only until unarchived; Match preserves memberships in archived collections and marks them from a fresh read; no reordering; names and labels are trimmed only; all edits go through the `org_*` functions; originals can be renamed and archived. **No production write test** at release (owner decision): the organization write path was verified on a hosted synthetic test project and locally, not in production (§18).
- **Current confirmed-date drift (2026-09-30 audit, grade B, expected review items, not defects). Do not change either date unless the user decides to:**
  - The Traitors S5 (`othertv`, tmdb 215943, season 5): stored `2026-09-17`, TMDB `2026-09-16`.
  - Avengers: Doomsday (`movies`, tmdb 1003596): stored `2026-12-16`, TMDB `2026-12-15`.
- **Derived views, v1 decisions (2026-09-29; superseded where Phase 3 changed them — show-level status, the released-only Up to date rule and Skip / Keep, §4a):**
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
- **Keyboard access to show expansion outside Browse collections (deferred, 2026-10-06):** All TV, Currently Watching and the grouped TV tabs expand a show through a clickable table row or card header, not a button, so a keyboard user can't expand it. The Browse collection views use labelled buttons. Fixing it changes markup in otherwise stable views and needs its own plan.
- **Top-bar overflow at extreme zoom (pre-existing, 2026-10-06):** at 300 px with 150 % page zoom the top bar's Backup / Restore group overflows the page horizontally by about 56 px (unrelated to the Browse views; seen in an isolated preview).
- **Restore safety-backup filename** only goes down to the minute (§10).
- **Stage 3b-1 follow-ups (2026-10-06):**
  - After **Retry inside an open watch-with picker**, keyboard focus lands on the page body (the button is replaced); Retry beside the Movies filter keeps focus on the filter.
  - A restore cancelled by the API's statement time limit shows "Restore failed — nothing was changed" followed by the raw timeout text (accurate, but could say "try again").
  - After an **unconfirmed** film match (PATCH accepted, read-back failed), the page doesn't remove a former show left with no seasons; a reload shows the true state.
  - The app's "last backup" reminder isn't updated by backups taken with the private script; a backup with the app's ⬇ Backup updates it.
- **Review the two B-grade date drifts** (§13) and decide whether to update them (user decision; never auto-applied).
- **Canonical SQL fingerprints** (§16) were last recorded on 2026-09-28. The 2026-09-30 check used the anon-key hash method (§11a) and showed no change across the deployment. Re-run the SQL form when convenient.
- Possible derived-view enhancements, **not planned**: restore the last TV tab on Movies → TV; date-horizon filters in Coming Soon; ignoring a leading "The" when sorting.

### Larger / deferred

- Bulk actions (including a show-level status control in Currently Watching, deliberately left out of v1).
- Books/Games media types.
- **Stage 3b-2, personal organization controls:** **released 2026-10-08** (`fdc5023`, §18). Remaining: the organization write path's first production use is the owner's own (no production write test was run).
- **Retiring the temporary membership trigger:** only when the legacy creation paths retire or are routed through membership-aware functions (separately approved work).
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
- **Stage 3b-1 personal organization storage** (database, app `dde4079`, format-3 baseline, refresh-catalogs skill; 2026-10-06)
- **Stage 3b-1 test environment cleanup** (2026-10-06): the owner deleted the temporary test project; the local test server was stopped and the local test credentials and generated test app copies were deleted (synthetic fixtures and review evidence kept privately)

---

## 15. Not recently re-tested — not known broken

- **A full destructive restore on production:** never run. Rehearsed only in isolated test projects (the 2026-09-26 one, since deleted, and the 2026-10-04 TV-migration test project, deleted 2026-10-05, where the transactional `restore_backup` ran over the real API as both the anonymous and signed-in roles).
- **The restore UI's browser plumbing** (the file picker and the real download). (Stage 3b-1's hosted browser checks fed files to the real preview code and stubbed only the download.)
- **A format-3 restore on production:** never run; the format-3 baseline was restored only into an isolated local replica (§10).
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
node tests/tmdb-match.test.js             # expect 33/33
node tests/identity-audit.test.mjs        # expect 67/67
node tests/derived-views.test.js          # expect 21/21
node tests/derived-nav.test.js            # expect 24/24
node tests/tv-model.test.js               # expect 43/43
node tests/restore-rpc.test.js            # expect 3/3
node tests/backup-format.test.js          # expect 6/6
node tests/tv-writes.test.js              # expect 19/19
node tests/all-tv.test.js                 # expect 19/19
node tests/all-tv-seasons.test.js         # expect 27/27
node tests/browse-views.test.js           # expect 49/49
node tests/browse-presentation.test.js    # expect 19/19
node tests/organization.test.js           # expect 30/30
node tests/organization-manage.test.js    # expect 46/46
node tests/match-expansion.test.js        # expect 57/57
node tests/filter-pills.test.js           # expect 18/18
# total: 574 cases across 23 suites (tests/app-harness.js and tests/tv-model-reference.js are helpers, not suites)
```

### Handler/global sweep

Every inline-handler name must be a defined function. Expected (at `90738a8`): **85** handler names, none undefined, and no duplicate global function definitions (353 functions; the deployed `fdc5023` has 87 / 338). (`setBrowsePresentation` and `setBrowseGrouping` are built through a template, so this literal sweep doesn't list them; they are defined.)

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

wc -l < /tmp/handlers          # expect 85
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
# last result (2026-10-06, after The Bear consolidation): 714 rows fetched (639 identified)
#         A 589 / B 50 / C 0 / D 0, RESULT: PASS (594 / 50 before; the 5 removed duplicate rows were all A)
#         B rows: kept date drifts within 31 days, title-suffix/punctuation drift, 8 provisional
#         future seasons (7 Disney+, Dutton Ranch S2) and the 6 owner-approved exceptions, all "applied" (§16, §17, §18).
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
- **Owner-approved exceptions (2026-10-05, `tools/identity-exceptions.json`):** a reviewed, evidence-backed case can turn **one specific C finding into B (never A)**. Each exception is bound to the collection, media type, TMDB id, season (where it has one) and the exact local and TMDB values it was approved for, with a reason and evidence URLs; if any bound value changes, the finding is a C again. An exception never applies to a D, to a provisional season, or to any other finding, so remaining C/D still fail. The file is validated (a malformed file aborts the audit with no result), and the audit lists every exception as *applied* or *not applied* with the reason. Current six (all *applied* since The Single Life was enriched on 2026-10-05): Star Wars: Visions "Volume 1/2/3" → seasons 1/2/3 (114478; label bound to its season and TMDB's season name), Star Wars Rebels S2 stored premiere 2015-06-20 vs TMDB 2015-10-14 (60554; "The Siege of Lothal"), the curated title "Star Wars: The Acolyte" (114479; TMDB lists it only as a working title), and 90 Day: The Single Life S1 stored TLC premiere 2021-08-09 vs TMDB's discovery+ date 2021-02-21 (118422). When an exception covers its own finding but another finding leaves the row C or D, the report says **"applied, ROW STILL FAILS"** and the audit still fails. New exceptions need the owner's approval.
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

**Since Stage 3b-1 (normalization):** `w_n_all` above now includes the generated `is_film`, so compare across the migration with `md5(string_agg((to_jsonb(t) - 'user_id' - 'is_film')::text, '|' order by t.id))` (`w_n_all_norm`; on 2026-10-06 it equalled the pre-migration `w_n_all`). Add the organization tables — `collection_memberships` as `to_jsonb(t) - 'user_id' - 'item_is_film'`, `personal_collections` and `watch_with_choices` as `to_jsonb(t) - 'user_id'`, with their counts — and check `is_film` consistency: `select count(*) from public.watchlist_items where is_film is distinct from (coalesce(media_type = 'movie', false) or (media_type is null and season = 'Film'))` must be 0. `w_o`, `o_o`, `c_o` and `s_n_all` are unaffected.

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
- **Refresh shows (Other TV):** 61 identified shows (from `tv_shows`; 62 from the Dutton Ranch enrichment until The Bear consolidation, 2026-10-06; this line said 61 throughout, which was stale in between). Tehran S4 is offered (a policy decision not to add it), and nothing else (last re-verified 2026-10-05, at 62 shows).
- **True Crime / Docs Refresh shows:** 3 tracked shows, "Everything's up to date".
- **Search "Dune":**
  - Movies → 6 films including Dune: Part Two.
  - Other TV → series first.
  - True Crime / Docs → 4 series then films.
- **Outage simulation:** Refresh shows and Refresh collections say "Couldn't check TMDB right now… Nothing was changed" (never "up to date").
- **Mobile 375 px:** the "⋯" popover on a movie card opens inside that card.
- **Derived views:** see the 2026-09-30 checklist in §15 (startup GET-only; TBA up-next season without Mark watched; Up to date section; Coming Soon today row and TBA section; no films; Movies → TV).
- **After any temporary test:** all fingerprints equal the session's starting baseline, and the audit equals the session's starting audit (589 A / 50 B / 0 C / 0 D as of 2026-10-06).

---

## 17. Source-of-truth baseline (verified 2026-10-08, after the Stage 3b-2 release; local list-filter commits noted)

**Local, not deployed (2026-10-08):** `main` is two commits ahead of `origin/main` (`90738a8` app code, then this handoff update); the remote, GitHub Pages and production are as below. Until those commits are pushed and verified, the deployed baseline stays `c3437c0` / `fdc5023`.

```text
Repo:                     the local Git checkout of this repo (github.com/jaredsclove/Watchlist)
Branch:                   main; origin/main = c3437c0 (local main is 2 commits ahead until pushed), working tree clean
HEAD:                     local: "Update handoff for the list-filter release (not deployed)" ← 90738a8 ← c3437c0; pushed: "Update handoff after the Stage 3b-2 release" (docs-only; parent fdc5023 ← 942ae8e … 3fe49c5 ← 536e05c ← c3c0443 …)
Last database change:     Stage 3b-2, db/phase3b2_org_write.sql (SHA-256 e8e0f41e0042101d91780d06c9d94f962780bef5e2cb8c949b01a278b3ea9048),
                          migrated in production 2026-10-08 (functions only; no data change). Before it Stage 3b-1, db/phase3b_org.sql
                          (46bf0f89727a160844131ded00517606c7e0959c2aa23e78c87abfcde9599123), 2026-10-06
Last app-code commit:     90738a8  list filters (local, NOT deployed; token 20261008-filters1)
Last deployed app code:   fdc5023  Stage 3b-2 release (token only; app commits 53971a5…942ae8e), deployed and verified on Pages 2026-10-08;
                          before it c3c0443 ("Before the 90 Days" theme pill) and dde4079 (the Stage 3b-1 release)
Tracked files:            93 at 90738a8 (21 app, 1 doc, 34 in db/, 26 in tests/, 10 in tools/, .gitignore); 92 at fdc5023
                          all 21 app files byte-identical on GitHub Pages (verified at fdc5023); 17 versioned assets identical;
                          running page's 338 functions equal to fdc5023
Offline tests:            574/574 passing (23 suites) at 90738a8; 85 inline handlers by the literal sweep, none undefined; 353 functions, no duplicates
                          (fdc5023: 555/555, 22 suites, 87 handlers, 338 functions)
Cache token:              ?v=20261008-filters1 at 90738a8 (not served yet); live ?v=20261008-manage1 (16 JS files + styles.css); config.js, identity.js, ui-helpers.js unversioned

watchlist_items:          714 rows
othertv_shows:             64 rows
custom_collections:         1 row   ("Quentin Tarantino", tmdb_person_id 138, director)
personal_collections:       4 rows  Disney+, Sheridan, 90 Day, True Crime / Docs (in that order, none archived)
collection_memberships:   151 rows  135 shows + 16 films (Disney+ 103 + 4, Sheridan 14 + 8, 90 Day 15 + 0, True Crime / Docs 3 + 4),
                                    equal to what each tab stored at the cutover
watch_with_choices:         4 rows  Alone, Suzanne, Rina, Whole Family (labels = tokens; Rina and Suzanne in use)
tv_shows:                 196 rows  (disney 103, othertv 61, 90day 15, sheridan 14, truecrime 3; 166 identified:
                          disney 85, othertv 61, sheridan 9, 90day 8, truecrime 3)
                          show status (authoritative): confirmed (On List) 139, pending 34, watching 10, skipped 10,
                          complete 2, maybe 1, highpriority 0
TV seasons linked:        637 of 637 TV rows; 77 non-TV rows (films) unlinked; 39 seasons skipped = true (Tales of the Jedi S2 added 2026-10-05); 126 rows watched
Compatibility copies:     season status = the approved projection for all 196 shows at the start of final; no longer written

Fingerprints:             not published here. Compute the current baseline read-only (SQL MD5, §16; or the
                          anon-key hash method, §11a). Unchanged by Phase 0–2; Phase 3 changed only 84 season status copies (normalization).

Database:                 stage final (§5, since 2026-10-05 14:32 UTC). user_id NOT NULL on all public tables, one bootstrap
                          owner, owns every row; clients can't write user_id. tv_shows.status is authoritative for TV;
                          season status populated but unused; othertv_shows populated but unused. public.restore_backup (= db/restore_backup.sql), private helpers (= db/tv_model.sql)
                          and the TV functions (= db/rpc.sql at 0c3c434), all verified by MD5. private.tv_add_to_enriched_show
                          source MD5 73478474edae6c0dd573615d12079be4 (guard fix, installed 2026-10-05; 31 public/private functions). No production Auth users, no FK to auth.users.
                          RLS: 16 permissive anon policies (the original 12 + 4 on tv_shows), plus 12 on the Stage 3b-1 tables.
                          Stage 3b-1 (2026-10-06): the three organization tables, generated watchlist_items.is_film (77 films,
                          0 inconsistent), 5 org_* triggers (3 temporary membership triggers, the watch-with check, the choice guard),
                          match_tv_row(p_row_id, p_target, p_patch, p_expansion) and the format-3 restore_backup (sources equal to the
                          repository); 35 public/private functions (31 + 4 new private). PostgreSQL 17.6; API statement limits:
                          anon 3 s, authenticated 8 s.

Rows per tab:             disney 182, 90day 72, sheridan 42, othertv 350, truecrime 7 (3 TV + 4 films), movies 61
TV rows in derived views: 637 (all linked to a show); All TV lists 196 shows (186 by default, Skipped hidden)
Films (All Movies):       77 (movies 61, disney 4, sheridan 8, truecrime 4; 74 shown by default, 3 Skipped); 43 watched
Unidentified rows:        75 (static DEFAULTs not enriched; 0 manual dynamic rows)

Identity audit:           714 rows, 639 identified → 590 A / 49 B / 0 C / 0 D, PASS (node tools/identity-audit.mjs, 2026-10-06,
                          before and after the Stage 3b-1 migration, identical row for row). Marshals S1 became A: TMDB now lists
                          2026-03-01, the stored date (TMDB-side change; was 589 / 50).
                          B = The Traitors S5 (one-day drift, kept) + 90 Day Fiancé S4 and The Last Resort S1
                          (stored dates kept, within 31 days) + Proud Family S1 and S3 (one-day differences, kept) + 35 Disney+ seasons: stored dates
                          within 31 days, title differences such as "(Netflix)"/"(2008)" suffixes or "–" vs "-", and 7
                          provisional future seasons (Alien: Earth S2, Daredevil: Born Again S3, Marvel Zombies S2,
                          Shōgun S2, Maul – Shadow Lord S2, X-Men '97 S3, Your Friendly Neighborhood Spider-Man S2)
                          + Dutton Ranch S2 (provisional future season; Sheridan) + Star Wars Rebels S1 (10-day difference, kept) + Love in Paradise S4 (7-day difference, kept)
                          + 6 owner-approved exceptions (§16): Rebels S2, The Acolyte S1, Star Wars: Visions Volume 1/2/3,
                          The Single Life S1
Collection consistency:   42 rows / 16 TMDB collections / 0 problems (last verified 2026-09-26)

Backups:                  kept outside the repo. Sheridan enrichment: before 18:54 UTC, after 19:04 UTC. Disney+ enrichment: before
                          19:51 UTC, after 20:11 UTC. Tales of the Jedi skip: before 21:08, after 21:09. 90 Day enrichment: before
                          21:35 UTC, after 21:38 UTC. Proud Family S2 correction: before 21:47, after 21:48 UTC.
                          Proud Family enrichment: before 21:53, after 21:54 UTC. Guard-fix install: before 22:24, after 22:27 UTC.
                          Rebels/Acolyte/Visions enrichment: before 22:31, after 22:36 UTC. Love in Paradise S3 correction: before 23:05,
                          after 23:07 UTC. Single Life / Love in Paradise enrichment: before 23:34, after 23:36 UTC.
                          Dutton Ranch enrichment: before 23:55, after 23:58 UTC (2026-10-05; format 2, 719/197/64/1, valid).
                          The Bear consolidation: before 13:15, after 13:18 UTC (2026-10-06; format 2, 714/196/64/1 after, valid).
                          Stage 3a deployment (no data change): read-only snapshots before 14:58 and after 15:03 UTC (2026-10-06), identical.
                          Collection presentation deployment (no data change): read-only snapshots before and after the live check (2026-10-06), identical.
                          Expand-button deployment (no data change): read-only snapshots before and after the live check (2026-10-06), identical.
                          Stage 3b-1: format 2 before the migration 23:10 UTC (714/196/64/1, valid); FORMAT 3 recovery baseline
                          23:21 UTC (714/196/64/1/4/151/4, valid; restored into an isolated local replica = production).

Tags:
  post-tmdb-migration-modularization → c5b592e
  post-same-title-schema-fix         → 8ec56c0
  pre-derived-views                  → e2c1c16   (local only, not pushed)
  pre-tv-shows                       → b266a5b   (local only, not pushed)

Supabase:                 the production project. The temporary Stage 3b-2 test project was deleted by the owner (owner-reported, 2026-10-08). The temporary Stage 3b-1 test project (synthetic data) was deleted by the
                          owner on 2026-10-06; the TV-migration test project was deleted by the owner on 2026-10-05. Local rehearsals: tools/db-rehearsal.mjs, tools/db-rehearsal-3b.mjs and tools/db-rehearsal-3b2.mjs on PGlite.

refresh-catalogs:         skill updated for Stage 3b-1 in both copies, identical, SHA-256
                          b1035661202b4b9e4d6c85e989e35c815eebcf7a1845c4631cba6f6e650a1364; the release freeze was lifted by the owner on 2026-10-06;
                          the skill is user-invoked only (no refresh has been run since). Stage 3b-2 needed no skill change; its release freeze
                          (2026-10-08, database through app verification) was lifted by the owner on 2026-10-08, authorizing no refresh.
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

### Completed: TMDB identity enrichment — The Single Life and Love in Paradise (2026-10-05, approved)

- **Scope:** these two 90 Day shows only. **90 Day: The Single Life → 118422**, Season 1–5 → TMDB seasons 1–5; **90 Day Fiancé: Love in Paradise → 128495**, Season 1–4 → TMDB seasons 1–4. Labels are plain `Season N`; nothing else in 90 Day was touched (Happily Ever After? held with its Season 10 row unchanged; the six Skipped shows unchanged).
- **Rehearsal (local, exact replica of a fresh snapshot): 56/56** — pre-flight 9 rows / 0 mismatches, dry run = manifest, guards, atomicity, only identity fields change, all nine stored dates kept, up next unchanged for all 197 shows, duplicates refused, the 90 Day / Disney+ / Sheridan tabs GET-only and byte-identical, Currently Watching / Coming Soon byte-identical, seeding all 72 / 182 / 42 defaults a no-op, a later `Season N` joins and `Season N (Part 1)` is held for review, backup/restore exact, rollbacks exact. The unchanged `tools/identity-audit.mjs`, run against the replica's post-enrichment rows, predicted 642 identified, 593 A / 49 B / 0 C / 0 D (and reproduced the real 586 / 47 on the pre-state). The production-run helpers were rehearsed on simulated per-show states before use. Offline 303/303; the repo DB rehearsal passes.
- **Production run:** baseline re-checked (repo clean at the previous handoff commit; stage `final`; 719 / 197 / 642 linked; 633 identified rows, 164 identified shows; audit 586 / 47 / 0 / 0; catalog unchanged: 31 functions, guard source `73478474…`); fresh validated backup (tables equal to the rehearsed snapshot; regenerated files byte-identical); read-only checks (target TMDB ids unused, 0 duplicate show/season identities, 0 link mismatches); pre-flight 9 rows / 0 mismatches / 0 extra seasons; **admin dry run identical to the rehearsal (hash)**; then two SQL Editor runs, The Single Life then Love in Paradise, one show per atomic self-verifying statement, each hash-checked before Run and verified read-only (identity, full-table diff, counts, duplicates, links, audit) before the next. After The Single Life: 638 identified, 590 A / 48 B / 0 C / 0 D. Each intermediate production state equalled the rehearsed simulation byte for byte.
- **Written (only):** 2 × `tv_shows.tmdb_id` and 9 × (`media_type` → `tv`, `tmdb_id`, `season_number`). **Field-level diff of validated pre/post backups: exactly those 29 fields, nothing else** — titles, labels, item_keys, collection, show links, dates (incl. Single Life S1 Aug 9, 2021 and Love in Paradise S3 Apr 17, 2023 / S4 Apr 15, 2024), show and row statuses, watched/skipped flags and created_at unchanged; `othertv_shows` and `custom_collections` byte-identical.
- **Grades:** The Single Life S1 **B** via the owner-approved `single-life-s1-tlc-premiere` exception (C without it; no other season uses it), S2–S5 A; Love in Paradise S1–S3 A (S3 after the correction), S4 **B** only for the 7-day difference (stored Apr 15 vs TMDB Apr 22, 2024; kept), no exception. **Audit 642 identified, 593 A / 49 B / 0 C / 0 D, PASS**; all six exceptions now *applied*.
- **Checks:** post-verify 719 / 197 / 642 linked, 8 identified 90 Day shows (166 overall), 642 identified rows, 0 mismatches, 0 duplicate shows or seasons, 0 unlinked TV rows, 0 linked films. On replicas of the real pre/post backups: up next identical for all 197 shows; 90 Day, Disney+ and Sheridan tabs GET-only and byte-identical; Currently Watching and Coming Soon byte-identical; the post-run backup validates; seeding all 72 90 Day, 182 Disney+ and 42 Sheridan defaults → 0 inserts, 0 conflicts, 0 reopened, 0 changes. Deployed site in Chrome with writes blocked in page memory: the 90 Day tab loaded with GETs only (no seeding, no review note), both shows with their stored labels, dates and watched/skipped flags; Currently Watching 6 + 4, Coming Soon 13 dated / 21 TBA; 0 write attempts; no console errors. Production equal to the post-run backup afterwards.
- **Rollback, if ever needed:** per-show identity-only guarded rollback scripts were generated and rehearsed; kept outside the repo with the run files (they contain row ids). Nothing has been rolled back.

### Remaining legacy TV shows — read-only inventory (2026-10-05)

All 31 legacy shows were reviewed against TMDB (and fresh web evidence where a hold depended on it). Other TV and True Crime / Docs have none. No clean candidate remained except Dutton Ranch, whose hold the owner lifted (below). After it, **30** remain:
- **Intentionally held (8):** Happily Ever After? (no confirmed Season 10); the six Skipped 90 Day shows (each would match cleanly, kept unchanged by decision); Wonder Man (cancelled; S2 skipped; would grade B / provisional B, but the provisional rule does not read TMDB's "Canceled" status, so passing is not evidence).
- **Structurally incompatible (4):** Yellowstone (`Season 5 (Part 1)` / `(Part 2)` are both TMDB season 5), Star Wars: Clone Wars (2003) (`Volume 1` = TMDB seasons 1+2), Limitless with Chris Hemsworth (S2 is a separate TMDB show, "Limitless: Live Better Now"), Star Wars: Tales of the Jedi (TMDB has no S2; the local S2 is Tales of the Empire, already its own enriched show). Each would need a schema extension or an owner-approved restructuring.
- **TV-row → film reclassification candidates (14):** the Disney+ single-row `Special` shows, each a TMDB movie (separate future project).
- **Waiting on TMDB (4):** Mayor of Kingstown (TMDB lists 4 seasons; S5 is confirmed final but unlisted, and the local label `Season 5 (Final)` would itself need explicit approval), The Madison (TMDB lists S1 and an empty S3, no S2; never map 2 → 3), 1944 and 6666 (not on TMDB).

### Completed: TMDB identity enrichment — Dutton Ranch (2026-10-05, approved)

- **Owner decision (option A):** Dutton Ranch → **299167**, `Season 1` → TMDB season 1, `Season 2` → **provisional** season 2 under the provisional-future-season rule (§16). Evidence for S2: the renewal announced by Paramount+ and reported by Variety, The Hollywood Reporter and TheWrap; S1 premiered May 15, 2026 and TMDB lists it. TMDB does not list S2 yet.
- **Provisional rule checked:** the parent show matches (S1 A); the label is exactly `Season 2`; the stored date is `TBA (announced)`; TMDB's highest listed season is 1, so 2 is the next with no gap; no TMDB season is named `Season 2`. Simulated: once TMDB lists S2 the normal path grades it (A undated / B dated); released-but-unlisted, a `Season 2 (Part 1)` label or a gap would each be D.
- **Rehearsal (local, exact replica of a fresh snapshot): 59/59** — pre-flight 2 rows, dry run = manifest, guards, atomicity, identity-only diff, both stored dates (incl. the TBA text and its guessed sort date) kept, up next unchanged for all 197 shows, duplicates refused, the 90 Day / Disney+ / Sheridan tabs GET-only and byte-identical, Currently Watching / Coming Soon byte-identical, seeding all defaults a no-op, the existing S1/S2 are no-ops through seeding and manual add, a later plain `Season 3` joins as season 3, `Season 3 (Part 1)` is held for review, no second Dutton Ranch show can be created (TMDB-keyed or legacy-key add), backup/restore and rollback exact. The unchanged audit, run against the replica's post-enrichment rows, predicted 644 identified, 594 A / 50 B / 0 C / 0 D. The production-run helpers were rehearsed on a simulated post-apply state first. Offline 303/303; the repo DB rehearsal passes.
- **Production run:** baseline re-checked (repo clean at the previous handoff commit; stage `final`; 719 / 197 / 642 linked; 642 identified rows, 166 identified shows; audit 593 / 49 / 0 / 0; catalog unchanged: 31 functions, guard source `73478474…`); fresh validated backup (tables equal to the rehearsed snapshot; regenerated files byte-identical); read-only checks (299167 unused, 0 duplicate identities, 0 link mismatches); pre-flight 2 rows / 0 mismatches / 0 extra seasons; **admin dry run identical to the rehearsal (hash)**; one atomic self-verifying statement (hash-checked), verified read-only. The post-apply production state equalled the rehearsed simulation byte for byte.
- **Written (only):** `tv_shows.tmdb_id` null → 299167; on Season 1 and Season 2: `media_type` → `tv`, `tmdb_id` → 299167, `season_number` → 1 / 2. **Field-level diff of validated pre/post backups: exactly those 7 fields, nothing else** — title, labels, item_keys, collection, show status (On List), dates (May 15, 2026; `TBA (announced)` with its sort date), watched/skipped (all false), links and created_at unchanged; other tables byte-identical.
- **Grades and checks:** S1 **A**; S2 **B** only for "provisional future season not yet listed by TMDB (season 2)", no exception. **Audit 644 identified, 594 A / 50 B / 0 C / 0 D, PASS.** Post-verify 719 / 197 / 642 linked, 9 identified Sheridan shows (167 overall), 0 mismatches, 0 duplicate shows or seasons, 0 unlinked TV rows, 0 linked films. On replicas of the real backups: up next identical for all 197 shows; tabs and both views byte-identical; the post-run backup validates; seeding all 72 / 182 / 42 defaults → 0 inserts, 0 conflicts, 0 reopened, 0 changes. Deployed site in Chrome with writes blocked: the Sheridan tab loaded with GETs only (no seeding, no review note), Dutton Ranch once with `Season 1` May 15, 2026 and `Season 2` TBA (announced); S2 still in Coming Soon's TBA section; Currently Watching 6 + 4, Coming Soon 13 dated / 21 TBA; 0 write attempts; no console errors. Production equal to the post-run backup afterwards.
- **Rollback, if ever needed:** a guarded identity-only rollback was generated and rehearsed; kept outside the repo with the run files (it contains row ids). Not run.
- **With this, TV identity enrichment is effectively complete under the current schema and standing decisions.** Future work: recheck Mayor of Kingstown, The Madison and Happily Ever After? when TMDB or the evidence changes; the separate film-reclassification project for the 14 Specials; a schema extension only if the owner wants the structurally incompatible shows matched.

### Completed: The Bear consolidation (2026-10-06, approved)

- **Why:** The Bear (TMDB 136315) existed twice: a Disney+ show (Pending, built-in defaults, theme Drama) and an Other TV show (On List, theme Hulu), each with Seasons 1–5 and no viewing state (nothing watched or skipped, no watch-with tags). Owner decision: one TMDB-matched show with all released seasons, in Disney+, On List, before All TV launched. The Disney+ copy is the only possible survivor: its rows are built-in defaults, so deleting them would reseed them.
- **Evidence (read-only):** TMDB 136315 is Ended with 5 seasons, all aired, dates equal to both copies; production rows, owner, stage and function sources equal to an exact local replica (hash-compared in the SQL Editor); the Disney+ defaults equal the 5 surviving rows.
- **Mechanism:** one self-verifying admin `DO` block (a single transaction) run once in the SQL Editor, hash-checked in the page before Run. It checks stage `final` and that the owner resolver equals the expected owner, sets a 5 s lock timeout, then locks both shows and every season row in id order. Holding those locks, it re-checks the complete state against an exact manifest (show and season content hashes, season sets, no other The Bear rows or shows, global counts). It deletes the 5 Other TV seasons through `delete_tv_season` (the last call removes their show) and sets the Disney+ show to On List through `set_show_status`. It verifies everything before commit (survivor exact, up next = Season 1, data outside The Bear unchanged, counts, the `othertv_shows` row unchanged); any mismatch rolls the whole block back, and a second run fails with its own "already applied" error. A guarded recovery block (reinstates the removed show and seasons with their original ids, only if nothing about The Bear changed since) was prepared and rehearsed; it was **not** run. The execution files contain row ids and are kept outside the repo.
- **Rehearsal (local PGlite replica of a fresh snapshot): 58/58.** Covered: success; every guard (stage, owner, changed status, watched or watch-with on a season, a changed date, an extra season added through `add_tv_seasons`, an unrelated insert, another show with the same TMDB id); injected failures at four points (full rollback); a forced self-check failure; a replay; recovery and its refusals (later edits, The Bear re-added to Other TV, nothing to undo); later unrelated data preserved by both apply and recovery; seeding all Disney+ defaults and re-adding The Bear (both no-ops); both app versions (Disney+ and Other TV tabs GET-only, Currently Watching and Coming Soon byte-identical, valid backups). The locking analysis covers every app write path, including the direct watch-with and date PATCHes. The checks run after the locks are taken, so a change committed before the block makes it refuse; a single-connection rehearsal can't demonstrate concurrent sessions, so all app tabs were closed during the run.
- **Production (2026-10-06 ~13:17 UTC):** fresh validated backup identical to the rehearsed snapshot; preflight and catalog unchanged; one run, committed. **Field-level backup diff: exactly the 5 Other TV seasons and their show removed, and the Disney+ show's status Pending → On List; nothing else** (`othertv_shows` and `custom_collections` byte-identical; the 5 Disney+ seasons, their dates, Drama theme and creation dates unchanged). The unused `othertv_shows` row for 136315 is left as it is. Post-verify all true: 714 / 196 / 64 / 1, 637 linked, 639 identified rows, 166 identified shows, 61 identified Other TV shows (Refresh shows). **Audit 589 A / 50 B / 0 C / 0 D** (the 5 removed rows were A; findings identical to the rehearsed prediction). Deployed site with writes blocked: Disney+ lists The Bear once (Seasons 1–5, On List), Other TV no longer lists it, 0 write attempts; production equal to the post-run backup afterwards.
- **Consequence:** The Bear is no longer covered by Other TV's Refresh shows; any future season would come through the Disney+ catalog (the show has ended).

### Completed: All TV — Stage 1 of the post-enrichment architecture (`4331e81`, deployed 2026-10-06, approved)

- **Scope:** the approved Stage 1 (§4a): All TV in Shows mode between Currently Watching and Coming Soon; A–Z; Search / Source / show Status with Skipped hidden by default; the existing show status, Watched and Skip / Keep only; no add, delete, Match, Seasons mode, schema or loading changes (`fetchAllRows` unchanged). Up to date only for Watching shows. Explicit per-view render, header and stats dispatch. Cache token `20261005-alltv1`.
- **Offline:** 322/322 (the new `all-tv` suite: 19 cases; existing 303 unchanged); syntax clean; 55 handlers, none undefined; 180 functions, no duplicates. Each of six deliberate code breaks made at least one new test fail. On the real production snapshot, before and after the consolidation, at 1200 and 375 px: startup, Currently Watching, Coming Soon, all five TV tabs and Movies rendered **byte-identical to the previous app**, and All TV loaded with GETs only.
- **Independent review** of the commit and The Bear package: no blocking issues.
- **Isolated browser check (before deployment):** the committed code served on localhost from a private copy of the snapshot, with a page security policy refusing every outside connection and the show/season actions simulated in page memory. Checked in Chrome at desktop width and 375 px: tab position, A–Z order, combined filters and their persistence, the default and every status, expansion, Watched / Not aired yet, Skip / Keep and show status changes, Watching-only Up to date, empty states, other views and tabs, The Bear once. No console messages; no production requests.
- **Deployment:** pushed `4331e81` (exactly the reviewed commit; no other remote changes); Pages build succeeded; all 18 app files byte-identical, 14 versioned assets 200 and identical. Live check in Chrome with writes blocked in page memory, at desktop and 375 px (a same-origin 375 px frame):
  - the loaded `derived-views.js` equals the commit;
  - All TV shows 186 shows by default (196 with All statuses), 10 Watching and 4 Up to date (only Watching shows get the tag), A–Z, The Bear once (Disney+, On List);
  - every status filter, a combined filter surviving a re-render, the empty state, and Severance's TBA season as "Not aired yet";
  - Currently Watching 6 + 4; Coming Soon 12 dated / 6 next 30 days / 21 TBA; all five TV tabs and Movies load; Movies → TV returns to Currently Watching;
  - 0 write attempts, no console messages, production unchanged afterwards.
  - The write controls were not clicked on production: they were exercised in the isolated check and the offline suites.
- **Coming Soon 13 → 12 dated:** a date effect, not a data change. 90 Day: Hunt for Love Season 2 is dated 2026-10-05 and left the list on 2026-10-06; The Bear was never in Coming Soon (all its seasons have aired).
- **Rollback:** `git revert 4331e81` (restores the previous token and views). It doesn't touch data, and it doesn't undo The Bear consolidation, which stands on its own.

### Completed: plain status labels in the show status control (`97ab608`, deployed 2026-10-06, owner request)

- **Change:** the show-level status select listed "Show: ▶ Watching" etc.; its options now read just the status ("▶ Watching", "✓ On List", …) wherever it appears (Currently Watching, All TV, every TV collection tab). It stays show-scoped through its tooltip and option-group heading. Films keep their row-level status control. One line in `tv-shows.js`, the matching test, and the cache token `20261006-status1`. No other change.
- **Verification:** offline 322/322 (16 suites); 55 handlers, 180 functions. On the production snapshot, at 1200 and 375 px, every view and tab rendered identically to the previous app except the removed prefix, with no writes. Deployed: Pages build succeeded, 18 app files and 14 versioned assets byte-identical, the live page's `tv-shows.js` equal to the commit. Live check with writes blocked: 0 options with "Show:" across Currently Watching, All TV (incl. All statuses), Disney+, Other TV and True Crime / Docs; every control kept its tooltip and option group; Coming Soon's read-only labels unchanged; all requests GETs, 0 writes, no console messages; production byte-identical before and after.
- **Rollback:** `git revert 97ab608`.

### Completed: All TV Shows / Seasons presentation (`77ff0ab`, deployed 2026-10-06, approved)

- **Scope (approved plan, all owner decisions applied):** §4a. All TV only; no change to other views, schema, data, classification, seeding, authentication or release rules.
- **Offline:** 348/348 across 17 suites (new `all-tv-seasons`: 26); syntax clean; 57 handlers, 188 functions. Ten deliberate code breaks (TBA-before-sort, tie order, To watch, overlap, filter preservation, visibility memory and reset, Shows leakage, storage fallback, review vs TBA) each failed at least one test.
- **Real data (offline, fresh read-only backup):** at 1200 and 375 px, startup, Currently Watching, Coming Soon, All TV Shows (default, All statuses, Skipped, Watching, expanded), all five TV tabs and Movies byte-identical to the previous app; the All TV filter row differed only by the switch; Seasons counts as in §4a; no TBA season among dated rows.
- **Independent review** of the commit: no blocking issues (348 tests, syntax, handlers, preview files and CSP confirmed).
- **Isolated browser check (before deployment):** the committed code on localhost with snapshot data, a CSP refusing outside connections and Watched / Skip simulated in page memory, at desktop and 375 px. No console messages; only localhost requests.
- **Deployment:** pushed `77ff0ab` (the reviewed commit only; no remote changes); Pages build succeeded; 18 app files and 14 assets (`20261006-seasons1`) byte-identical; the live page (fresh URL) loaded the committed `derived-views.js` (hash). Live check with writes blocked in page memory, desktop and 375 px (same-origin frame):
  - first use opens in Shows; the switch, the remembered choice after a reload, and the visibility reset on re-entry and reload;
  - Search / Source / Status kept across toggles and the same shows in both layouts; To watch restored after Seasons → Shows → Seasons, while the Shows output stayed byte-identical and the select was hidden there; Shows expansion listing all 6 seasons of a show that To watch narrows to 5;
  - all 593 dated rows in the computed order under 30 ascending year headers; order deterministic under 25 shuffles;
  - TBA section collapsed with 22 TBA, opening to "Not aired yet" rows;
  - every Watched control identical to the existing rule; read-only status labels with no selects on season rows; no add, delete or Match;
  - Currently Watching 6 + 4, Coming Soon 12 / 6 / 21, all five TV tabs and Movies unchanged;
  - 0 write attempts, no console messages; production table hashes identical before and after. No production editing control was used.
  - The test's remembered "Seasons" choice was then removed from the browser, so the owner's next visit starts at the default.
- **First click after page load (investigated):** in automated sessions the first click (sometimes the first two) after a navigation didn't change the view. An event logger installed in the page recorded **no** pointer, mouse or click event at all for those clicks, on the All TV tab and on Coming Soon alike. After the automation took a screenshot, the next click delivered all events and opened All TV. A click dispatched inside the page 212 ms after load opened All TV at once. Conclusion: an input-delivery artifact of the browser automation, not an app defect. The owner confirmed on 2026-10-06 that a physical mouse click opens All TV the first time.
- **Known limitations:** no production season currently has an invalid date or both watched and skipped flags, so those paths are covered by the offline suite only. A date-needs-review season with an empty `date_sort` would offer Mark watched under today's release rule (unchanged by decision).
- **Rollback:** `git revert 77ff0ab` (no data involved; the old app ignores the stored key).

### Completed: Stage 3a — Browse collections and All Movies (`e89a932`, `540f411`, deployed 2026-10-06, approved)

- **Scope (the approved plan's recommended defaults):** §4c. A Browse collections selector in TV and Movies for Disney+, Sheridan, 90 Day and the transitional True Crime / Docs; All media by default with separate TV and Movies sections; Shows-only collection TV sections (All TV's Shows / Seasons unchanged); read-only All Movies as the Movies landing view with the legacy Movies tab kept; storage-derived membership; strictly read-only views. No production data, schema, membership storage, reclassification (the 14 Disney+ Specials stay TV), tab retirement, authentication or refresh-catalogs change. The Bear was not touched again.
- **Follow-up before release (`540f411`, from an independent review):** (1) a restore whose file text, preview reads or safety backup resolved after navigating into a browse view could open the Restore dialog there — restores are now abandoned on navigation and re-checked after every await, and the confirmation steps refuse in a browse view (§10); (2) expanding/collapsing a show or changing All media / TV / Movies lost keyboard focus — focus now returns to the same control. A second independent review found no blocking issues.
- **Offline (before deployment):** 397/397 across 18 suites (the new `browse-views` suite: 49 cases, including the restore race at four points with an armed control); three existing tests now open the legacy Movies tab explicitly because Movies opens on All Movies. Deliberate breaks of film inclusion, membership, read-only rendering, the stale-response checks, the strict-read guards, the restore guards and the focus restore each failed at least one test. On a fresh read-only snapshot of production, every existing view and tab (Currently Watching, All TV incl. Seasons and statuses, Coming Soon, the five TV tabs, Movies) rendered byte-identical to `649f3fd` at 1200 and 375 px, with no writes.
- **Isolated browser check (before deployment):** the committed code on localhost with snapshot data, a security policy refusing outside connections and a request stub installed before the app's scripts, in Chrome at desktop width and 375 px, by mouse and keyboard: collections, media, filters, expansion and focus, Back, All Movies; GETs only, nothing blocked, no console messages.
- **Deployment:** `origin/main` was still `649f3fd`; pushed exactly `e89a932` and `540f411`; the Pages build succeeded; all 19 app files and all 15 versioned assets (`20261006-browse1`, including `browse-views.js`) 200 and byte-identical to `540f411`.
- **Live check (2026-10-06, Chrome, desktop 1280 px and a 375 px frame):** the deployed page was loaded into a same-origin frame whose `fetch` was replaced **before any app script ran** (every non-GET and every non-Supabase request refused and logged; the boot reads appeared in its log). The running code equalled the commit (22 key function sources hash-equal; 15 versioned assets at `20261006-browse1`). Exercised: All TV with a search → Disney+ from the selector (counts as in §4c; Restore hidden) → keyboard Movies / All media with focus kept → keyboard expand and collapse with focus kept → Sheridan, 90 Day, True Crime / Docs (default and All statuses; no warnings) → Back to All TV with its search restored → Movies → All Movies (74 / 77; per-source counts; only read-only handlers) → TV → Coming Soon (12 dated / 6 next 30 days / 21 TBA); at 375 px: Sheridan, keyboard media and card expansion with focus kept, Back to Currently Watching (6 + 4), All Movies (74 cards, no overflow). **0 write attempts** (desktop 30 requests, phone 12, all GETs of `watchlist_items` / `tv_shows`; nothing blocked). Legacy tabs, editing controls, Restore, imports and refreshes were not used. Production table hashes and counts (714 / 196 / 64 / 1) identical before and after (read-only snapshots, compared privately). The console reader was attached after the frames loaded and recorded no messages from then on.
- **Known limitations:** the two reads are concurrent but not one consistent snapshot; opening a browse view doesn't cancel a legacy tab's in-flight seeding; membership is storage-only until personal membership storage (Stage 3b; done in Stage 3b-1, §4c); the collection selector's native dropdown was set by script in automated checks (everything else by real clicks and keys); not checked on a physical phone.
- **Rollback:** `git revert 540f411 e89a932` (restores the previous token and views; no data is involved). Reverting only `540f411` would bring back the restore race, so revert both together.

### Completed: Browse collection presentation (`dec78d4`, `575e6c4`, deployed 2026-10-06, approved)

- **Scope (approved plan and refinements):** §4c. Shows / Seasons and Separate / Combined in the four collections; Movies-only A–Z; Seasons oldest first, Combined interleaved; parent-show titles; separate TBA (collapsed) and Date needs review (expanded) sections; "TV seasons" never filters films; counts independent of grouping; per-collection device preference written only on change; 44 px phone targets scoped to the collection controls (`575e6c4`, after review). Membership, classification, All TV and the read-only boundary unchanged; no data, schema or refresh-catalogs change.
- **Before deployment (earlier evidence, not rerun at release):** offline suites incl. deliberate breaks of each new rule (each caught after fixture tightening); on a fresh read-only production snapshot every previously existing view (four collections' default view under each media choice, All TV Shows and Seasons, Currently Watching, Coming Soon, All Movies) byte-identical to `aa0f142` at 1200 and 375 px with no writes; isolated Chrome previews (localhost, outside connections refused before the app's scripts) at desktop, 375 and 300 px, including Date needs review with synthetic rows (separate per media, shared in Combined, expanded, counted, apart from TBA) and a rehearsal of the preference capture/restore procedure. Two independent reviews found no blocking issues.
- **Release (fresh):** `origin/main` was still `aa0f142`; offline 415/415 at `575e6c4`; pushed exactly `dec78d4` and `575e6c4`; the Pages build succeeded; all 19 app files and all 15 versioned assets (`20261006-layout1`) 200 and byte-identical; the running page's presentation, preference and navigation code hash-equal to the commit (24 functions).
- **Live check (fresh, Chrome, desktop 1280 px and a 375 px frame; writes blocked and console captured before any app script ran):** Disney+ Shows + Separate (101 · 175 · 2), keyboard to Seasons and Combined with focus kept; 166 dated TV entries oldest first, years 2003–2027 ascending per section; Combined 168 dated entries strictly oldest first, the 2008 Clone Wars film before its show's Season 1, counts unchanged; TBA (9) opened by keyboard with focus kept, all genuinely TBA; TV seasons To watch 94 · 162 / Watched 7 · 11 / Skipped 2 · 2 with films unfiltered and the note; Movies only A–Z with no year headers while Seasons was chosen; Shows + Combined A–Z (103 shows + 4 films with All statuses; the show before the same-title film); Search and Status kept across changes; Back to Currently Watching (6 + 4); per-collection persistence within the visit and across a fresh load (Disney+ reopened in Seasons, Sheridan stayed Shows + Separate); Coming Soon unchanged (12 / 6 / 21). Phone: every collection control and section button 44 px, side by side at 375 px, stacked at 300 px, labels fit, no overflow; keyboard Combined and card TBA with focus kept. **0 write attempts** (desktop 18 requests, phone 9, all GETs of `watchlist_items` / `tv_shows`; nothing blocked); **no console messages**. No production row needs date review, so that section relies on the synthetic preview. Legacy tabs, editing controls, Restore, imports and refreshes were not used.
- **Device preferences:** captured before the check (no Browse layout keys existed; All TV's key present); afterwards the one layout key created by the test was removed, nothing else rewritten, All TV's value unchanged and the other storage byte-identical.
- **Production:** table counts and hashes (714 / 196 / 64 / 1) identical before and after (read-only snapshots, compared privately).
- **Known limitations:** the show expand buttons inside rows keep their size; the collection dropdown was set by script in automated checks; not checked on a physical phone; the earlier Stage 3a limitations stand.
- **Rollback:** `git revert 575e6c4 dec78d4` (restores the Stage 3a views and token; leftover `watchlist_browse_layout_*` keys are then ignored; no data is involved).

### Completed: 44 px phone targets for Browse show expand buttons (`ca092dd`, deployed 2026-10-06, approved)

- **Change:** one rule inside the ≤ 700 px media query — `.expand-btn` at least 44 × 44 px, non-shrinking, the 20 px chevron centred, no negative margins — plus the token `20261006-expand1`. The button exists only in the Browse collection views (and on phones only their cards show), so desktop sizes, All TV, markup, JavaScript, behaviour, data and preferences are unchanged.
- **Before deployment (earlier evidence, not rerun at release):** offline 415/415; a markup-preservation comparison on a fresh read-only snapshot (rendered HTML identical to `e91ba51` in every compared view; this checks markup, not appearance); an isolated Chrome preview with a synthetic very long title at 375 and 300 px and at 150 % zoom (buttons 44 × 44 / 66 × 66 inside their cards, no title overlap, focus outline inside the card, keyboard expand/collapse with focus kept; desktop 28 × 28 and All TV unchanged). The 150 % zoom check found the pre-existing top-bar overflow (§14), identical with and without the rule.
- **Release (fresh):** `origin/main` was still `e91ba51`; the diff was exactly the CSS rule and the token (`watchlist.html` token-only); pushed `ca092dd` only; the Pages build succeeded; all 19 app files and all 15 versioned assets (`20261006-expand1`) 200 and byte-identical; the live page loaded the committed stylesheet (hash-equal) with the phone rule active.
- **Live check (fresh, Chrome; writes blocked and console captured before any app script ran):** at 375 px and 300 px all 101 Disney+ show expand buttons measured exactly 44 × 44, inside their cards (at least 13 px from the edge), no title overlap, chevron 20 × 20 centred, no horizontal overflow; Enter expanded and collapsed a show with focus kept on the same button and its outline inside the card; Back to Currently Watching; All TV's toggle still 32 px on phones (186 · 10 · 4). Desktop 1280 px: the 101 expand buttons still 28 × 28 (`min-height: auto`), All TV's toggle still 28 px. **0 write attempts** (phone 12 requests, desktop 9, all GETs of `watchlist_items` / `tv_shows`; nothing blocked); **no console messages**. No legacy tab, editing control, Restore, import or refresh was used.
- **Device preferences:** captured before the check (one existing Browse layout, All TV's key present); the check created and changed none, so restore removed and rewrote nothing; the existing layout, All TV's value and the other storage are byte-identical.
- **Production:** table counts and hashes (714 / 196 / 64 / 1) identical before and after (read-only snapshots, compared privately).
- **Known limitations:** not checked on a physical phone; text enlargement was simulated with page zoom; the two §14 findings above are deferred.
- **Rollback:** `git revert ca092dd` (restores the previous rule set and token; no data involved).

### Completed: Stage 3b-1 — personal organization storage (`8791bdb`…`dde4079`, deployed 2026-10-06, approved phase by phase)

- **Scope:** §4c, §5, §10. Owner-scoped personal collections, memberships (whole shows or films) and watch-with choices in the database; generated `is_film`; the temporary membership trigger; membership-based Browse collections with a non-blocking startup selector; watch-with labels and choices read from the database (values unchanged); backup format 3; `restore_backup` for format 3 only; Match keeps memberships and refuses an unconfirmed collection expansion. **No editing UI** (Stage 3b-2, not implemented). Nothing moved the 16 collection films, reclassified the Specials, retired tabs, or added sign-in.
- **Reviews and fixes before release:** three independent read-only reviews (organization refresh after restore, watch-with integrity, rollback safeguards, Match lock order, a watch-with state of its own, unfinished work kept during a refresh, Retry beside the filter), then hosted checks (below) and two Match message fixes (`b9b5376`, `dde4079`: a statement-time-limit cancellation is reported as cancelled; a film match whose PATCH was accepted but not read back is reported as unconfirmed). Offline 450/450 across 20 suites.
- **Hosted checks (approved; a temporary Supabase project with synthetic data only):** migration self-checks 28/28; API 17/17 (generated column, grants and RLS, private functions hidden, old three-argument Match call, refusals); restore 5/5; **13/13 two-session cases with the overlap proven from the database's own lock views**, including two real deadlocks between a direct-API membership insert and restore / Match (one side rolled back in about 2.2–2.6 s; the data then equalled the winner's solo result exactly and the victim's retry gave the serial result); locks held 9 s by another session (calls cancelled at about 3.1 s, nothing changed); browser checks of loading, failed reads and Retry, label changes with unfinished work and an open picker, format-2 refusal by the new and old app; the old app on the new schema. **Limitations:** Postgres chose the same deadlock victim in every run, so the other branch wasn't exercised; the API's one automatic re-run of a 40001 transaction was observed on the test project only; TMDB results were represented by placeholder content; the deadlocks need a direct-API membership insert, which the app never makes.
- **Database phase (approved):** repo and Pages verified; refresh-catalogs frozen and other tabs closed; production's version and API time limits read from the catalog; baseline, catalog, fingerprints and audit captured; a fresh validated format-2 backup; the migration **rehearsed locally on exactly that backup (PASS; 135 + 16 memberships, 4 choices)**. The reviewed `db/phase3b_org.sql` (SHA-256 `46bf0f89727a160844131ded00517606c7e0959c2aa23e78c87abfcde9599123`) ran in the SQL Editor after the editor text's hash was checked. **Verified read-only:** collections and every collection's member set equal the backup's manifest by id; choices; the 5 triggers; the 4-argument `match_tv_row` and `restore_backup` equal to the repository; `is_film` consistent; tracking fingerprints unchanged (normalized, §16); audit identical. The deployed pre-3b-1 page was then checked with writes blocked before boot: GET-only, every view rendered, no console errors.
- **App phase (approved):** token `20261006-org1` kept (never served before; same release date; unversioned files unchanged). Pushed `afac120..dde4079`; all 20 app files and 16 versioned assets byte-identical; the running page's 263 functions equal to the release. **First format-3 recovery baseline** built and validated by the release code (seven tables), confirmed by an independent read-back and by a restore into an isolated local replica of the migrated schema (all seven tables equal, field by field). Live check with writes blocked, console captured and device preferences restored: memberships equal the manifest; Shows / Seasons, Separate / Combined, oldest-first order and the media filter work; a saved Sheridan layout was kept; watch-with labels; all TV and Movies views as before; a real format-2 file refused in the preview with no restore request; **all requests were GETs**; production unchanged.
- **Skill phase (approved):** both `/refresh-catalogs` copies (the installed skill and the owner's editing copy) updated to identical text, verified SHA-256 `b1035661202b4b9e4d6c85e989e35c815eebcf7a1845c4631cba6f6e650a1364`: validated format-3 baselines covering all seven tables, the normalized fingerprints, preservation of collections, memberships, exclusions and watch-with choices, the trigger's effect on genuinely new shows and films, before/after organization checks, and the recovery wording above. Installing it did **not** lift the freeze.
- **Rollback / recovery:** app → `git revert` of the release commits (the database stays compatible with the previous app while the organization is storage-derived); database → `db/rollback/phase3b.sql`, only when the current state is representable by the old model (§10); otherwise fix forward.

### Completed: skipped seasons hidden by default in Seasons views (`bc75a19`, deployed 2026-10-06, owner-approved plan, released step by step)

- **Problem (owner report):** in a collection's Seasons view, with Status "All (except Skipped)", seasons skipped on their own were still listed (greyed). Status filters shows and films; a season's own `skipped` flag was governed only by "TV seasons: All", which included them (90 Day: 30 of 56 season entries). All TV's Seasons view behaved the same.
- **Change:** the TV seasons choice in Browse collections and All TV gained **All (except Skipped)**, the default on every entry: seasons skipped on their own are hidden and not counted; **All** lists them, labelled. The Status filter is unchanged. Shows view is unchanged (an expanded show lists every season). The "Films aren't filtered by this" note shows only for To watch / Watched / Skipped. No data or database change.
- **Offline:** 452/452 (two new cases; existing expectations that assumed the old default updated); deliberate breaks of the default and of the new rule each failed several tests.
- **Deployment:** `origin/main` was `6000f1a`; pushed `bc75a19`; the Pages build succeeded; all 20 app files and 16 versioned assets (`20261006-skipped1`) byte-identical, directly and as received by Chrome.
- **Live check (writes blocked before boot, console captured, device preferences restored):** the running page's 263 functions equal the release; 90 Day (its saved Seasons + Combined layout applied): 26 season entries by default, 56 under All (30 labelled skipped), 30 under Skipped; Disney+: 173 by default, 175 under All (one of its two skipped seasons is TBA, so it sits in the collapsed TBA section); All TV Seasons: 576 by default, 615 under All seasons, 39 under Skipped; the pulldowns list the new default first and selected; the note rule; Shows expansion still lists a skipped season. **18 requests, all GETs; nothing blocked; no console messages.** All TV was switched to Seasons in page memory only, so the device's saved "Shows" choice wasn't written; a temporary Disney+ layout key was removed afterwards and all browser storage was identical. The production fingerprint queries were not run (the write-block and request log show no write).
- **Rollback:** `git revert bc75a19` (restores the previous default and token; no data involved).

### Completed: "Before the 90 Days" theme pill styled (`c3c0443`, deployed 2026-10-06, owner-approved plan, released step by step)

- **Problem (owner report):** in the 90 Day views the "Before the 90 Days" theme pill showed as plain text with no visible outline. `badgeClass` keeps the theme's letter case, so it renders `b-Beforethe90Days`, but `styles.css` defined `.b-BeforeThe90Days`; CSS class names are case-sensitive, so the pill fell back to the plain badge (no background, transparent border). It had been that way since the original upload. Every other built-in theme already matched.
- **Change:** the two selectors (dark and light) renamed to `.b-Beforethe90Days`; colours unchanged; `badgeClass`, the theme name and stored data untouched. A new `derived-views` test checks that every theme of Disney+, 90 Day and Sheridan has a badge style for both colour schemes.
- **Offline:** 453/453; with the old selector restored the new test failed.
- **Deployment:** pushed `c3c0443` after `f0438a8`; the Pages build succeeded; all 20 app files and 16 versioned assets (`20261006-badge1`) byte-identical, directly and as received by Chrome.
- **Live check (writes blocked before boot, console captured, device preferences restored):** the running page's 263 functions equal the release; the loaded stylesheet has the corrected rule for dark and light and no old selector; in the 90 Day collection all 6 "Before the 90 Days" pills render purple text, background and a visible 1 px border (dark mode; the light rule was confirmed in the stylesheet, not on screen); Main Show and Happily Ever After unchanged; 10 requests, all GETs; nothing blocked; no console messages; browser storage identical.
- **Rollback:** `git revert c3c0443`.

### Completed: Stage 3b-2 — editing personal organization (`3fe49c5`…`fdc5023`, released 2026-10-08, approved phase by phase)

- **Scope:** §4c, §5. The Manage dialog (collections create / rename / archive / unarchive; members add / remove with Undo; watch-with choices create / rename / archive / unarchive), the Match expansion confirmation, and the database functions `org_capabilities` + eight `org_*` writers with the archived-choice rule. No table, column or row change; no backup-format change; no skill change.
- **Local implementation and reviews:** five independent review rounds with fixes, real-browser validation, offline 555/555 (22 suites), deliberate-break coverage, the lock model, no-edit equivalence against `c3c0443`, and compatibility runs of the pre-3b and 3b-1 apps on the 3b-2 database.
- **Hosted gate on a temporary synthetic test project** (owner-approved; legacy anon key): the H1–H21 two-session matrix including H20 (lock waits cancelled at the 3 s statement limit, nothing changed), the API checks, rollback / re-apply, and browser checks of both old page versions. **Closed by the owner with documented limitations:**
  1. an archived collection's member staying visible in its source tab was established by code and data, not browser-observed;
  2. the old-page request account was resource-timing based, not a full trace;
  3. disclosed deviations: one extra archive of a synthetic choice, and opening the 3b-1 page's 90 Day tab on the synthetic project seeded catalog rows there (`seed_tv_defaults`; existing behaviour: a static tab inserts missing catalog entries);
  4. test procedures must account for that seeding;
  5. the test project holds the seeded rows;
  6. production's publishable-key path was not exercised there.
- **Real-data rehearsal:** one GET-only production backup; the migration, self-checks, rollback and re-apply on it; no-edit rendering equivalence (2,328 states, 0 differences); compatibility flows of the 3b-1 and pre-3b apps on the edited real data.
- **Database phase (2026-10-08, approved):**
  - baseline: catalog preflight, seven-table fingerprints, identity audit 590 / 49 / 0 / 0;
  - a fresh validated format-3 backup and the rehearsal on exactly it;
  - the migration run once after the editor-text hash and project checks: success;
  - verification: the 12 function definitions and grants, the 5 triggers, unchanged `match_tv_row` / `restore_backup` / `delete_tv_season`; the function inventory changed only by the intended 12; all seven table fingerprints equal before and after;
  - the deployed `c3c0443` page checked with writes blocked before boot: GET-only, every view and legacy tab, no seed attempt.
- **App phase (2026-10-08, approved):**
  - token `20261008-manage1`; pushed `536e05c..fdc5023` as a fast-forward; all 21 app files and 17 versioned assets byte-identical; the live page's 338 functions equal to the release;
  - live check with writes blocked before boot, every request logged, device preferences restored: capability GET 200 `{"org_write":1}`; Manage reads (collections, choices, members); every view and legacy tab; the Match expansion panel shown via a page-memory stub (no `match_tv_row` call); 88 requests, all GETs, nothing blocked, no console messages;
  - a new validated format-3 baseline whose data equals the pre-migration backup; live memberships equal to it; the rehearsal passes on it.
- **Verified in production vs not tested:**
  - **Verified:** `org_capabilities` visible and executable through the deployed page's publishable-key configuration; every organization **read** the app makes; the catalog definitions and grants of the eight write functions and the new trigger body; unchanged data.
  - **Not tested in production** (owner decision: no production write test): any organization **write** (collection, membership or choice edits; Match with confirmation) and the archived-choice refusal. These were exercised only on the hosted synthetic test project (with its legacy anon key, not the publishable key) and locally. **The owner's first real organization edit is the first production use of that path**; if it fails, nothing is written (each function is one transaction) and the page shows the refusal or uncertainty.
- **Freeze:** kept from the database phase through app verification; **lifted by the owner on 2026-10-08**. Lifting it authorized no catalog refresh and no production write test.
- **Rollback / recovery:**
  - app → `git revert --no-commit 536e05c..fdc5023` and one commit (the tree returns to `536e05c`, token `20261006-badge1`; 3b-1 pages work on the 3b-2 database);
  - database → `db/rollback/phase3b2.sql` after the app revert (keeps every row and every 3b-2 edit; afterwards newly adding an archived choice is no longer refused);
  - `db/rollback/phase3b.sql` only while the state is representable by the pre-3b model; otherwise fix forward. Any restore needs its own approval.

### Prepared locally, not deployed: list filters (`90738a8`, 2026-10-08, owner-requested)

- **Scope:** §4d. Five user-reported issues: Manage's add search above the member list; an All Movies "Unwatched only" filter; the unstyled "Not watched"; genre / theme pills as toggle filters throughout (extended by the owner to collection tags and watch-with, Currently Watching and Coming Soon); All TV's matching filter, watched-state and pill behaviour. Proposal and decisions are kept outside the repo. Client-side only: no schema, data, write-path, backup-format or skill change; no new device-storage key.
- **Review:** one independent review finding (a change followed directly by a reload or Retry lost the selection, because the loaders cleared the controls before the visit's values were saved) was fixed with `holdViewFilters` and regression tests that fail without the fix. The skipped-show progress rules, the "To watch" stat label and the mixed-theme badge were accepted.
- **Validation (local):** offline 574/574 across 23 suites, syntax clean, handler sweep 85 handlers (none undefined) / 353 functions (no duplicates); the isolated real-Chrome check described in §4d. **Not deployed; no production access.**
- **Known limitations:** a show matched through another season's theme shows its usual (unselected) badge; Manage's search input keeps its pre-existing plain styling (out of scope); 375 px was checked in a frame of the page, not on a physical phone.
- **Deployment (needs the owner's approval for the push):**
  1. `git status` clean; `main` = this docs commit on `90738a8` on `c3437c0`; push `c3437c0..HEAD` to `origin/main` as a fast-forward (no force, no tags).
  2. After about a minute: all 21 app files on GitHub Pages byte-identical to `main`, and all 17 `?v=20261008-filters1` assets 200 and byte-identical.
  3. Live check in a real Chrome tab (§11 rules 12–14), writes blocked before boot (§11a), device preferences captured and restored: the running page's 353 top-level functions equal to `90738a8`; every request a GET and nothing blocked; no console errors; All Movies opens on Unwatched only; a genre, collection-tag and watch-with pill each select, show ✕, clear and replace; All TV theme and progress; a changed filter survives a reload and Back; Currently Watching and Coming Soon theme pills; a legacy tab's selected pill; Manage → Edit members shows the search first (no add or remove).
  4. Read-only data fingerprint (anon-key hash, §11a) before and after the live check: equal.
- **Rollback (preserves all user data):** `git revert 90738a8` (one commit; it restores the `fdc5023` app files and the `20261008-manage1` token), push as a fast-forward, then the same Pages byte check against `fdc5023`. No database step: this release changes no table, function, row or backup format and adds no device-storage key. A page that is already open keeps running the code it loaded until it is reloaded, however long that is. A newly opened page may for a short while still receive a cached `watchlist.html` (GitHub Pages caches for about 10 minutes); the cache token keeps its scripts consistent with that HTML. Either version reads and writes the same data the same way.

### Next

- **List filters (`90738a8`) are prepared locally and not deployed**; pushing and deploying need the owner's approval (above).
- **Stage 4a (explicit catalog application) stays deferred**; it needs its own plan and approval.
- **Stage 3b-2 is released** (2026-10-08) and its release freeze is **lifted** by the owner; the skill stays user-invoked only, and lifting the freeze authorized no refresh.
- **Owner housekeeping:** the temporary Stage 3b-2 test project was deleted by the owner (owner-reported, 2026-10-08); the first real organization edit is the first production use of the write path (above).
- **Earlier status, still current:** nothing else is prepared. Later architecture stages (explicit catalog application (4a), tab retirement (4b), sign-in) each need their own plan and approval; Stage 3a (§4c), Stage 3b-1 and Stage 3b-2 are done. Under the current schema and standing decisions, TV identity enrichment is effectively complete: the 30 remaining legacy shows are all held, structurally incompatible, film-reclassification candidates or waiting on TMDB (inventory below).
- **Held / unchanged:** Happily Ever After? (no confirmed renewal found), the six Skipped 90 Day shows, Wonder Man, Tales of the Jedi (S2 skipped), Clone Wars (2003), Limitless, the 14 Specials, the waiting Sheridan shows (Mayor of Kingstown, The Madison, 1944, 6666) and Yellowstone.
- **The TV-show migration is complete.** Enrichment continues only on approval (same process: read-only review → owner decisions → rehearsal → dry run → per-show apply); the 90 Day review is done and its decisions are carried out. No production write or schema change without approval. Parts/volumes or any non-`Season N` label are never forced into a season number (as with Yellowstone; Star Wars: Visions' Volume N → N was mapped only by explicit owner approval, and a new Volume is still held for review). Recheck the waiting Sheridan shows and the held Disney+ cases (Wonder Man; the audit-blocked shows) when TMDB or the owner's decisions change. The separate **future sign-in (Auth/RLS) project** (`db/future/auth_switchover.sql`) needs its own approval.
- **Identity audit:** 590 A / 49 B / 0 C / 0 D is the baseline (2026-10-06, Stage 3b-1; Marshals S1 became A through a TMDB correction; 589 / 50 after The Bear consolidation). TMDB data can change upstream; a benign TMDB correction that changes A/B is explained and accepted as the new baseline, not treated as a regression. A provisional B becomes normal grading once TMDB lists the season, or **D** if the season is released while TMDB still doesn't list it. Any C or D, or an unexplained A→B, is a stop condition.
- Other candidate follow-ups are listed in §14. For example: review the B-grade date drift.
- **Any static-tab catalog refresh uses the `/refresh-catalogs` skill**, which only the owner invokes. Startup no longer opens Disney+, so the skill opens the Disney+ tab explicitly. Since Stage 3b-1 a refresh needs a validated format-3 baseline and the organization checks the skill describes.

---

## 19. Your first task — read-only

1. Inspect the actual repo (your local Git checkout of `jaredsclove/Watchlist`).
2. Run `git status`.
3. Confirm the branch is `main` and compare it with `origin/main`. As written, local `main` is **two commits ahead** (`90738a8` and this handoff update, not pushed); if they have since been pushed and deployed, §18 should say so.
4. Confirm `HEAD` is the docs commit "Update handoff for the list-filter release (not deployed)" (it follows `90738a8`, which follows `c3437c0`) (§2). The last app-code commit is `90738a8` (not deployed); the last deployed one is `fdc5023`. If it isn't, report the difference. Later commits, such as catalog refreshes or handoff updates, may legitimately exist; list them.
5. Inspect the file tree and compare it with §3: 93 tracked files, and roughly the listed line counts.
6. Run the offline checks in §16: syntax, all 23 test suites (574 cases), and the handler sweep (85 handlers, none undefined, 353 functions, no duplicates). Optionally, confirm GitHub Pages matches the deployed commit (`fdc5023` app files until the list filters are deployed). The identity audit is read-only and may also be run (expect 590 A / 49 B / 0 C / 0 D). **Don't run `/refresh-catalogs`: it is user-invoked only.**
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
