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

- `main` is the source of truth; check it with `git ls-remote origin main`. Last release: Books Review's TBA date suggestions (owner's
  request; PR #109, `18f9228`), 2026-11-27 UTC, page only: an official site's "To Be Announced" for a book with no date (or
  already TBA) is no longer offered; an open item of that kind isn't shown or counted, and the next Refresh closes it
  through the existing close list (no decision saved, the book unchanged); a known date changed to TBA stays for review as
  "Mark date as TBA". Cache token `20261127-booktba`. Verified: 63 offline suites (1511; the new case fails without the
  fix); Pages built, changed files byte-identical to `main`; live, read-only with writes blocked: the owner's open Sleep
  Tight, Evangeline item (no date → TBA) is still stored but not shown or counted (Review: "Nothing to review"), the book
  still has no chosen date, The Kill Artist and The Unlikely Spy still Finished, no write attempted. Not verified: a live
  Refresh closing the stored item (it would change the owner's findings); real phones.
- Previous release: Books' Library and Following tabs
  and collapsible Library groups (owner's request; PR #107, `25a59ac`), 2026-11-27 UTC, page only: Following replaces Series
  and Authors (followed authors with their page, series, Add/Skip/Add all and other books; then other followed series); a
  series also followed under its followed author shows once there with its own automatic-adding and Stop following controls;
  author and series follows stay independent; `#/books/series` and `#/books/authors` open `#/books/following`. Library
  headings (author, series, Standalone books) are disclosures, open at first, kept for the page session, counts when closed,
  display only; even indentation author → series → title. Cache token `20261127-bookfollow`. Verified: 63 offline suites
  (1510); local Chrome with synthetic data: author alone, series alone, both (no duplicate), automatic adding and Stop
  following the author by real clicks (the series follow and its setting kept), old routes, Library collapse by click and
  keyboard with focus and counts, choices kept across tabs, 1444 and 375 px; Pages built, changed files byte-identical to
  `main`; live, read-only with writes blocked: the old route opens Following, Gabriel Allon once under Daniel Silva with its
  own controls, a Library group collapsed with its count, The Kill Artist and The Unlikely Spy still Finished, no write
  attempted. Not verified: real phones.
- Earlier: the Books Library grouped by author,
  series and reading order (owner's request; PR #105, `8f09233`), 2026-11-27 UTC, page only: the visible books under compact
  headings (author A–Z by first-listed author, "Unknown author" last; each series A–Z in series order; then "Standalone
  books" by date, undated last; empty headings not drawn; each book once by its own saved author and series); a "#" column
  keeps the real series number when earlier books are filtered out; co-authors beside the title; desktop genres on one
  measured line with +N (Games' fitter, refitted on resize). No sort control existed, so this is the Library's order. Cache
  token `20261127-booklib`. Verified: 63 offline suites (1509); local Chrome with synthetic data (several authors, series and
  standalones, missing author, position and date, Finished filtered): ordering, empty groups, +N by click and keyboard with
  focus kept, refit at 1100–1500 px, cards at 375 and 800 px, no horizontal scroll; Pages built, changed files byte-identical
  to `main`; live, read-only with writes blocked: the owner's library grouped (Daniel Silva → Gabriel Allon #2–#26, Michael
  Osbourne, Standalone books), +N and Fewer, The Kill Artist and The Unlikely Spy still Finished, no write attempted. Not
  verified: real phones.
- Earlier: Books fixes from the owner's
  Silva walkthrough (item 6, BK1b; PR #103, `b5d0b26`), 2026-11-27 UTC, ordinary function tier: "new" for a follow means not in
  its starting catalog (decision kind `baseline`, saved on follow; follows made before get one on their next refresh, which
  offers nothing new for them that time) instead of "released within 180 days" (why Ransom showed as new); a series-only
  follow checks only that series' links on the official site, the author's whole Hardcover catalog is read for matching, and
  an open website item for a title Hardcover lists for the author is closed (no decision changes); Add all in series / Add all
  books (Series, Authors, + Add book's browse; confirmed inline; hidden records and companions never; saved books unchanged;
  partial or unconfirmed outcomes reported after a reread); + Add book's hidden toggles (they redrew the main view, not the
  dialog) with their own state and focus; the dialog's status select arrow (a `background` shorthand reset its repeat); a
  compact "?" placeholder-date mark explained on focus, hover or tap. Database `db/bk1b_baselines.sql` (phase and backup
  format unchanged). Cache token `20261127-bk1b`. Verified: 63 offline suites (1507, with a synthetic reproduction of the
  walkthrough); BK1/BK1b database tests (94) and the restore suite (212) on PGlite and PostgreSQL 17; a local synthetic Chrome
  check of the whole sequence with real clicks and keys (desktop and 375 px; focus; repeated refreshes; Add all around
  Finished books and a skip). No Fable review (no new restore, isolation or write path: Add all uses the existing add with
  its refusal keys). Release: pre-release format-10 backup validated; the SQL Editor's text checked against the file's hash;
  run record confirmed by a separate read (phase, format and book row counts unchanged; nothing executable by anon); Pages
  built, changed files byte-identical to `main`; live, read-only with writes blocked: Series' Add all count and
  confirmation (cancelled), + Add book's author browse with the "Show 20" and "Show 46" hidden toggles opening and closing at
  once; post-release backup identical to the pre-release one in all 33 tables. Not verified: real phones; a live Refresh,
  follow or Add all (each would change the owner's library). The owner's next Refresh saves baselines for the two existing
  follows and closes the two open official-site items if Hardcover lists those titles for the author; the open Ransom item
  stays for the owner to decide.
- Earlier: Books (item 6, BK1; PR #101, `307eb1a`), 2026-11-27 UTC, schema tier: a Books area (Library, Series,
  Authors) with Hardcover as the catalog through the `books` Edge Function (secret `HARDCOVER_TOKEN`, a `read:catalog` key of
  the owner's Hardcover account, replaced when it expires) and Refresh books reading supported official book-listing pages.
  Database `db/bk1_books.sql` (phase `contracted-bk1`, backup format 10). Fable reviewed the database, restore, function and
  isolation once.
- Earlier: All Movies' Genres and Groups
  columns (owner's request; PR #99, `c4a4ea4`), 2026-11-24 UTC, page only: desktop rows read Title | Genres | Groups |
  Release | Status | Watched | ⋯ with fixed columns; franchise, collection-tag and watch-with pills moved from under the
  title to Groups; each pill cell one measured line with +N (Fewer wraps; a lone long pill gets an ellipsis); cards list
  genres, then groups. Collections' film rows, TV and Games unchanged. Cache token `20261124-movielayout`. Verified: 61
  offline suites (1449); local Chrome with synthetic data at 1100–1500 px and 375 px, both themes (resizing refits; real
  Tab/Enter on +N and a pill keep focus; only cache writes); Pages built, changed files byte-identical to `main`; live,
  read-only: 39 film rows all one line, no pill past its cell, nothing pressed. Not verified: real phones.
- Earlier: Mark S1 watched on a fully marked show row (PR #97, `62d5edb`), 2026-11-17 UTC: with every listed
  episode marked, the collapsed show row offers the season's Mark season watched, withheld while a listed episode has a
  known future air date. Limitation: a closed list checks only the cached last episode's date.
- Earlier: one retry after Supabase's "JWT issued at future" (PR #95, `53b32e5`), 2026-11-13 UTC: a database
  read refused with exactly that 401 is sent once more after 2 s with fresh session headers; writes never resent.
- Earlier: shorter game genre labels (PR #93, `6051c2f`), 2026-11-12 UTC: IGDB's long genre names shortened (display only).
- Earlier: the Games Library layout cleanup (PR #91, `59a08ec`), 2026-11-12 UTC: Platform and Release columns, a measured
  one-line genre row, one status-control width, one summary line.
- Earlier: the Games Library's default status filter (PR #89, `e9aa5af`), 2026-11-12 UTC: All except Finished and
  Skipped is the default; when the list empties, focus goes to the "No games match" note.
- Earlier: first episode of a season not started (PR #87, `63089a3`), 2026-11-12 UTC: a Watching show's
  actionable up-next season with a known episode list shows its first unwatched episode and Mark E1 watched.
- Earlier: TC1, the member's TMDB cache across devices (PR #85, `91fd862`), 2026-11-12 UTC, schema tier: episode
  lists, show scores and first-air dates in `public.tmdb_tv_cache` (owner-only, revision-checked writes, never in backups,
  untouched by restore, capability `tc1`), a bounded background queue saving through the write lane, a daily Cron expiry at
  150 days. Fable reviewed once (two findings fixed). Live: 205 rows filled, a fresh load with 0 TMDB requests, backups
  before and after identical in all 27 tables.
- Earlier: franchise boundaries (PR #83, `63af41e`), 2026-11-11 UTC: in Franchise / release order, a headed franchise
  followed by games without a heading ends with a heading-sized gap and a firmer line.
- Earlier: Skip / Unskip all versions named with the release year (PR #81, `c223b7a`), 2026-11-11 UTC: their accessible
  names and tooltips read "Skip all versions of God of War (2005)".
- Earlier: "Skip all versions" wording (PR #79, `95daceb`), 2026-11-11 UTC: franchise views say Skip all versions and
  "game" and "versions" instead of "spot".
- Earlier: single games placed by title (PR #77, `de9ca11`), 2026-11-11 UTC: in Franchise / release order, a
  franchise with one visible game is placed by that game's title.
- Earlier: Franchise / release order (PR #75, `63dd87a`), 2026-11-11 UTC: the Games Library's and game collections'
  default groups saved games by broad franchise, spots in original release order, with headings; collections have their own
  sort. Not verified live: game collections (the owner has none); headings in dark mode.
- Earlier: Games walkthrough fixes (PR #73, `215a409`), 2026-11-11 UTC: franchises list only versions on the chosen
  platforms; a saved version's status is editable in its franchise row.
- Earlier: genre colour families (PR #71, `78cb7fd`), 2026-11-11 UTC: genre pills in six muted families on TV, films
  and games.
- Earlier: Games drawn as TV (PR #69, `8579546`), 2026-11-11 UTC: TV's tabs, toolbar, rows and cards for Games.
- Earlier: Search your games caret fix (PR #67, `2dfba5b`), 2026-11-11 UTC: the screen's focus record keeps a text
  box's caret and selection.
- Earlier: + Add game's search caret (PR #65, `ebde4fe`), 2026-11-11 UTC: the dialog keeps a focused text box's caret
  and selection across a redraw; a text box focused anew gets its caret at the end.
- Earlier: game length removed (owner's
  decision; PR #62, `ef444b1`, then the function in PR #63, `5587a0b`), 2026-11-10/11 UTC, presentation tier with a function
  redeploy: no time-to-beat reads, estimates, play-style setting, Length sort or HowLongToBeat link; no migration and no backup
  format change (`game_settings.play_style` stays as a legacy value, sent back unchanged). Rollout: the page first (cache token
  `20261110-nolength`, 33 versioned files; Pages built; the 11 changed files byte-identical to `main`), then, after the 10-minute
  cache window, the `igdb` function (version 2) without `game_time_to_beats`, except that such a query from a page opened before
  the change is answered with an empty list and never sent to IGDB (temporary; the pre-change page, run offline against it,
  completed search, add, follow and Refresh). Verified: 57 offline suites (1378); the restore suite (182); a local synthetic
  browser check (a remembered "Length, then Critic" sort became Critic alone); live on the owner's account: Settings showing
  PS5 with no play style, IGDB search, preview, save and Refresh through the new function and with the old one, an old-style
  batch answered empty; the temporary game and the IGDB cache removed; the backups before and after identical in every table.
- Earlier: games (G1, item 5; PR #60, `5ada6c4`), 2026-11-10 UTC, schema tier (backup format 9; Fable review once, five fixed).
  Sorting library views (item 13; PR #58, `2dc1256`), 2026-11-10 UTC, presentation tier; Q1 (item 7; PR #56)
  2026-11-05 UTC.
- Database phase `contracted-bk1` with TC1 (capability `tc1`) and BK1, backup format 10 (thirty-three tables, no `user_id`, never the IGDB, TMDB or book cache), `access = members`, research per member. One flat
  `public.restore_backup`; the recovery archive is retired, exported privately first. The API exposes only `public` and `graphql_public`. The owner's production library holds the collection setup; one
  retained test account has no membership and reaches nothing (`docs/MEMBER_RECOVERY.md`).
- **Standing decisions:** W1 is removed; item 11 is abandoned; item 10 (CU1e) stays. `pg_graphql` stays disabled: enabling it needs a new explicit
  decision (`db/README.md`). A member's crafted request on their own records is an accepted limitation; it can't reach another account.
- **Restore** runs through the signed-in page or `docs/ADMIN_RESTORE.md`. Hosted restore performance has not been measured.
- **Repairs are fix-forward.** Reopening anonymous access is never a recovery step. Data recovery is a format-10 restore.

## Code map (classic globals; mutable page state is in `watchlist.html`)

| Area | Files |
|---|---|
| Boot, config, API | `watchlist.html`, `config.js`, `auth.js`, `api.js` (the writable phase, the stop switch), `write-lane.js`, `ui-helpers.js`, `identity.js`, `history.js` (routes) |
| Rendering and views | `render.js`, `tabs.js`, `derived-views.js` (TV views, list focus), `browse-views.js` (collections, All Movies) |
| Writes | `row-actions.js`, `tv-shows.js`, `library.js` (+ Add, writes from views, the movie tools' film row), `metadata.js` (Details) |
| Episodes, ratings | `episodes.js`, `show-ratings.js`, `tmdb-cache.js` (the member’s TMDB cache, TC1) |
| Organization | `organization.js`, `organization-manage.js`, `collection-members.js`; planning queues `queues.js`; sorting `view-sort.js` |
| Games (G1) | `games.js` (the area, Settings → Games), `games-data.js` (IGDB records and the rules), `games-research.js` (the games research brief and findings); the IGDB proxy `supabase/functions/igdb` |
| Books (BK1) | `books.js` (the area, Review, + Add book, Refresh books), `books-data.js` (Hardcover records, list and series rules, what Refresh finds); the Hardcover and official-site proxy `supabase/functions/books` |
| TMDB | `tmdb-match.js`, `tmdb-search.js`, `collections-pull.js`, `person-pull.js`, `universe-pull.js` |
| Collection updates | `collection-updates.js`, `collection-research.js`, `collection-settings.js` |
| Backup / restore | `backup-restore.js` (reads formats 5–10 and writes format 10) |
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
- Item 13 not verified: real phones.
- TC1 not verified: real phones; whether TMDB exposes Retry-After to the page (if not, a 429 counts as a two-minute wait);
  another member's first fill. Accepted limits: the expiry job can't run while a Free project is paused, so during a long
  pause rows can outlive TMDB's six-month limit until the first run after resuming; a page opened before TC1 keeps its own
  per-device copy until reloaded.
- G1 not verified: real phones (the TV-style Games rows and cards were checked at 390 and 820 px in desktop Chrome only; queue dragging on touch included; the browser check finished one drop with a dispatched
  pointerup); a status change from a franchise row on production (checked locally with synthetic data only); live games research (no games brief researched or findings imported on production); a member's Not out yet and
  franchise Up next on production data. (Game length, whose IGDB figures were unreliable, was removed by the owner's decision on
  2026-11-10.) Unresolved provider-terms point: whether the Twitch agreement's deletion duty reaches backup
  files members have downloaded (`docs/APP_BEHAVIOR.md`, "Games").
- Temporary: the `igdb` function answers `game_time_to_beats` with an empty list for pages opened before game length was
  removed (`EMPTY_ENDPOINTS` in `supabase/functions/igdb/core.mjs`). Remove it in a later function deploy, once no such page can
  still be open.
- BK1 not verified: real phones; a live Refresh books, follow or add; another member's use. Accepted limits: website discovery reads
  book-listing pages, not news feeds (an announcement may be found later than its first news post); a site the shared rule
  doesn't recognise is checked on Hardcover only until a small maintenance change supports it; Hardcover's 1 January dates are
  shown as given with a compact possible-placeholder mark; a follow made before BK1b counts what Hardcover lists at its first
  refresh after BK1b as already seen; Add all stops at the first failure (later titles not tried, as reported); the Hardcover key must be replaced when it expires (Refresh and search
  then fail until it is). Open point: Hardcover's website terms forbid compiling a database from the Site without permission,
  and its API rules allow API data in a personal project; the owner chose to proceed (a note to Hardcover support would settle it).
- Pre-existing (seen in Q1's review): a film with collection-update records of its own (an alias, a hold, a remembered removal)
  can't be deleted from the page, because those tables guard deletes; queue entries don't add to this.

## Tests

`tests/run.sh` runs every offline suite with the caps above; `tests/run.sh tests/<suite>.test.js` runs the ones named. It fails a suite that exits
non-zero, is killed, or doesn't end on a complete "N/N passed" line. Syntax check: `node --check` on each `*.js`, `tests/*.js`, `tools/*.mjs`.
Database tests run locally (`db/README.md`). The identity audit reads production, so it needs approval.
