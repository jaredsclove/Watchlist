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
  choices, Collection updates, Backup & Restore). Since S6 every view
  has a hash route (`#/tv/watching` … `#/collections/<id>`, `#/settings`) and browser Back / Forward work.
- **Layout (compact interface):** one app bar holds the title, TV · Movies · Collections and Settings (on phones, a
  non-sticky row of the areas and a gear, no logo); view tabs below it; then one list toolbar (`.list-toolbar`: toggles,
  Search that grows, scope selects, More filters, + Add, the count), wrapping in page order. At 1100 px and wider it also
  holds "Search TMDB to add" (1240 px in a collection, whose toggles need the room), sent only by Enter or its button: it fills
  the + Add panel's own search, and adding stays that panel's, confirmed in its preview. Lists are tables from 1100 px, cards
  below it, in two columns between 701 and 1099 px. A collection's title, note, Back and Edit share a compact header; its tabs
  are one scrolling row at every width. In a collection, TMDB adds to the library first, then the existing "Add to collections"
  step opens with that collection preselected: two steps, never atomic, and nothing joins the collection until that button. Backup and its date
  are only in Settings' Backup & Restore; no backup, or 14 days or more, puts ⚠ on the Settings control (with the status
  in its name) and it then opens on that section. Show rows read expand · title · ⋯. On a phone card the chevron starts on
  the card's one left margin, and the season line, progress, labels and actions flow below it from that margin, with progress
  beside the date when it fits; category labels are small pills inside 32 px targets, and Up to date is quiet text. Status is a quiet directly editable
  select ("Choose a status…" is never quiet). Priority is edited in the row's ⋯ (shows and films; Seasons lists show it
  only); High shows ★ and Low the word, Normal nothing. The show-row shortcut reads "Mark watched" (its name and tooltip
  name the season; the episode list's offer keeps "Mark Season N watched"). Season progress reads "1/3 seasons watched".
  Clickable genres are subdued filter buttons ("Crime · Drama"), underlined on hover, 32 px tall on phones.
- **Film collections (TMDB):** a film TMDB places in a collection keeps that identity. Its ⋯ menu offers Check
  collection while the collection's contents are unknown on this page, then Pull rest only when another film can be
  added, "All collection films are already in your library." when none can, nothing for a collection of one, or a
  failed check with Retry. The + Add screen checks the selected film's collection once and shows the same states as
  a note. The lookup is page memory only and every fetch replaces it (Check collection, Pull rest, Refresh
  collections), so a film TMDB adds later is found on the next check or page load.
- **Episode progress (EP1, EP2, EP3):** an expanded show's TMDB-matched seasons have an inline Episodes list (from TMDB,
  one open at a time) with a checkbox per episode and one "Mark watched through [Episode N ▾] [Apply]" control above
  it (marks only the unmarked episodes up to N; starts on the first unmarked, keeps the choice). Titles are hidden
  behind a Show title button per episode unless Settings' "Show episode titles by default" is on (per account,
  this browser only; a choice that can't be saved holds for the open page). A season with
  marks reads "In progress · N/T watched" (T from a per-device cache of the list; "N marked" when unknown).
  Beside that progress (EP3), "Next unwatched: E6" names the first listed episode without a mark, with " — Title" only
  while titles are shown by default; it comes from the open list or the per-device cache and is hidden when the list is
  unknown, empty or fully marked, or the season is watched or skipped. That cache (replaceable device storage, not
  library data or backups) holds each list's episode ids and, since EP3, numbers and titles; a list cached before EP3
  has ids only, so its line appears after the list is opened once. Show-level Watching is unchanged; nothing completes a season automatically (a fully checked list offers
  Mark season watched); a watched or skipped season's episodes are locked and its marks kept. The same
  controls are in collections; the flat Seasons lists show progress only; Coming Soon has no episode list.
- **TMDB show ratings (item 2, first part):** a TMDB-matched show's score sits directly after its title (since PR #20;
  its explanation on a line below, PR #21) in show rows and cards (Currently Watching, All TV, collections) as the
  number alone, slightly smaller than the title, "8.2" ("8.2*" under 100 votes), coloured by
  the rounded score (8.0+, 7.0–7.9, below 7.0); blank under 10 votes or without a score or count. Tap or keyboard
  focus shows "TMDB: 8.2 out of 10 · N votes" (also the accessible label). Scores are a per-device, per-account cache
  (`show-ratings.js`; not library data or backups), filled from show details other paths read (Refresh shows, Add
  season, a TMDB preview, Match) and by one read when a show is expanded whose score is missing or over 7 days old;
  views never fetch to display. Settings ends with Credits (TMDB's logo and notice). Season and episode scores aren't
  shown.
- **Collection updates (item 4, CU1; design `docs/ITEM4_DESIGN.md`):** TV → + Add → Refresh shows checks every show
  with TMDB (Skipped shows only when followed): new seasons, guarded dates, later matching and per-device episode
  lists, which refresh by airing lifecycle (a season counts as finished on TMDB's Ended/Canceled status, an aired
  finale, or a later regular season having started; a finished season is read again only without a cached list or
  when its count changes; opening a list always reads fresh). Announcements come from a research brief (Settings →
  Collection updates) researched with the private `/refresh-catalogs` skill; its findings file is imported, checked
  and applied under each collection's definition (Manual / Follow / Discover), exclusions and holds. Coverage is
  compared with the checks stored with the brief; insufficient or conflicting evidence stays blocked ("waiting for
  more research"); new titles always wait for the owner. Catalog-governed entries are skip-only; deleting another
  TMDB-matched season lets Refresh shows add it back while TMDB lists it. Holds (standing decisions, protected values,
  identity holds) come from the setup file or are added and edited in Settings → Collections and rules (edits in
  place through `library_cu_update_hold`, CU1b; a hold changed meanwhile is refused).
- **Data:** `watchlist_items` (seasons and films), `tv_shows`, `custom_collections`,
  `personal_collections`, `collection_memberships`, `watch_with_choices`, `catalog_show_links`,
  `catalog_film_links`, `episode_marks` (watched episodes of TMDB-matched seasons; no dates or titles), and since
  CU1 `update_setup`, `collection_definitions`, `collection_exclusions`, `update_holds`, `record_aliases`,
  `membership_removals`, `show_update_settings`, `update_findings`, `research_briefs`, `research_imports`.
  Rows are owner-scoped: `user_id` is the signed-in member (`auth.uid()`), never sent
  by the client; membership is `private.library_members`.
- **Writes** go mainly through database functions (the `library_*_b45` family, `org_*`,
  `set_season_watched` / `set_season_skipped`, `library_set_episode_marks`, `library_add_watched_season_marks`,
  `library_cu_sync_show_network`, `delete_tv_season`, `restore_backup`).
  Some take `p_expected` values and refuse a stale write; not every path does, so check each one before relying
  on it. `delete_tv_season` takes the mark count the page showed: a page from before EP1 can't delete a marked season.
- **Backup** is format 7 (nineteen tables: format 6's nine plus collection updates' ten; no `user_id`). **Restore**
  converts a format-3 to -6 file to format 7 first (a format-5 file has no marks, a format-6 file no collection
  updates; the preview says what a restore removes), validates the file, checks for identity loss, makes and validates a safety backup,
  then replaces the owner's rows in one database transaction and verifies field by field.

## Code map (classic globals; mutable page state is in `watchlist.html`)

| Area | Files |
|---|---|
| Boot, config, API | `watchlist.html`, `config.js`, `auth.js` (sign-in, the bound account, per-account storage, Account controls, pending notes), `api.js` (the writable phase, the stop switch), `write-lane.js` (one change at a time; read freshness), `ui-helpers.js` (incl. dialog keyboard and focus return), `identity.js`, `history.js` (routes, Back / Forward, leave warning) |
| Rendering and views | `render.js`, `tabs.js`, `derived-views.js` (TV views, list focus), `browse-views.js` (collections, All Movies) |
| Writes | `row-actions.js`, `tv-shows.js`, `library.js` (+ Add, writes from views, the movie tools' film row), `metadata.js` (Details) |
| Episode progress | `episodes.js` (marks read with each view, the list cache, progress text, the inline list, mark writes); its rows in `render.js` (`seasonSubRowHtml` / `seasonSubCardHtml`) |
| TMDB show ratings | `show-ratings.js` (item 2: the show-level score and its per-device cache, filled on expansion and from the show details other paths read); shown with the categories in `derived-views.js` `derivedShowHtml`; Settings' Credits in `tabs.js` with `assets/tmdb-logo.svg` |
| Organization | `organization.js` (reads), `organization-manage.js` (Manage dialog; the membership request, answer and Undo rules both UIs use), `collection-members.js` (Remove / Undo and the Add picker from a collection view) |
| TMDB | `tmdb-match.js`, `tmdb-search.js`, `collections-pull.js`, `person-pull.js`, `universe-pull.js` |
| Collection updates | `collection-updates.js` (Refresh shows, results, review), `collection-research.js` (briefs, findings import, the setup file), `collection-settings.js` (Settings section, definitions editor, dialogs) |
| Backup / restore | `backup-restore.js` (formats 4–7; 4 → 5, 5 → 6 and 6 → 7 converters), `backup-format3.js` (format-3 → 4 converter) |
| Database | `db/` (migrations, rollbacks, self-checks; run order in `db/README.md`), `docs/STAGE5.md` |
| Tests and tools | `tests/` (offline whole-page harness: `app-harness.js`, `mini-dom.js`, `b45-harness.js`), `tools/` (rehearsals, identity audit, admin restore, the hosted test pages) |

Every release bumps the `?v=` cache token in `watchlist.html` (current: `20261031-density`). The tests
check only that all 29 versioned files share one token; before releasing, check that it differs from
the previous release's: `git show <previous release>:watchlist.html | grep -oE '[?]v=[A-Za-z0-9_-]+' | sort -u`.
Pages serves files with `max-age=600`; a deployed change can take about 10 minutes to reach a browser.

## Where things stand (2026-10-30)

GitHub `main` is the source of truth; check it with `git ls-remote origin main` at the start of a session.
Each release's PR holds its review, validation and limits: Batch A [#1], S4–S6 [#2], Batch B [#3],
test runner and token check [#4], M1 sign-in and owner-only access [#7], EP1 episode progress [#9],
admin enrichment extensions [#11], EP2 episode-list controls [#12], EP3 next unwatched episode [#14], film-collection suggestions [#16],
TMDB show ratings [#18], rating beside the title [#20] and [#21], collection updates (CU1) [#23], the hold editor
(CU1b) [#25], date equivalence (CU1c) [#27], sole networks and Watched-season episode lists (CU1d) [#29], the compact interface [#32].

- **Release:** `5d588f2`, the compact interface (item 8; PR #32, the branch's four commits rebased, same tree as the
  reviewed head `f254b62`), released 2026-10-30 UTC. Presentation and interaction only: no migration, and no write, backup-format or
  saved-data change. Validation: offline 1216/1216; a local browser check with synthetic data at 1280, 375 and 300 px in
  light and dark. Space above the first item at 1280 / 375 / 300 px, before → after: Currently Watching 261 → 178 /
  412 → 207 / 412 → 207; All TV 293 → 178 / 502 → 244 / 522 → 244; Coming Soon 292 → 178 / 429 → 217 / 449 → 217; All
  Movies 312 → 144 / 538 → 197 / 576 → 197. Verified after deployment: Pages built `5d588f2`; the 35 application files
  are byte-identical and all 29 versioned files carry `20261030-compact`. On the live site, signed in, read-only: desktop
  navigation, ⋯ (opens, Escape closes and returns focus, doesn't expand), an expanded show, and Settings' Backup &
  Restore (no Backup button or date in the header; the ⚠ correctly absent after a same-day backup). At 375 and 300 px, in
  same-origin frames, one in light and one in dark for each check: Currently Watching, All TV and All Movies at the measured space (All Movies
  215 at 300 px, its longer count wrapping), no sideways overflow, no clipped card content, labels 32 px, ⋯ on screen, an expanded card,
  Coming Soon and a collection. No status, priority, episode mark or library row was changed. The network log, kept
  only for the last part of the check, shows only GET requests to the database; the opened and closed menus and the
  expansions sent no write. No backup was taken, because nothing was to change. Not verified: real phones, Safari, Firefox, native select popups by
  pointer, a live status or priority change (offline tests cover them), the Download backup button itself, and the live
  ⚠ states (offline, and "No backup yet" with synthetic data). An older tab keeps working until reloaded.

- **Since the CU1d release (owner's use, 2026-10-30; compared in a valid format-7 backup against the post-deploy one):**
  the owner ran Refresh shows, chose networks from its results and used Mark all. 27 shows gained a network (17 automatic
  with the Details flag still off, 10 through Details, 9 of them from several candidates), each one of its saved
  candidates; no confirmed network was replaced or cleared, and no show waits with candidates (25 have no network: 22
  unmatched and 3 matched with none from TMDB). Mark all added 28 marks on 3 Watched seasons, whose status stayed
  Watched; no mark was removed and no season's Watched changed. Refresh also matched one show and one season to TMDB
  and set one date (two findings, both applied). No row was added or removed in the library tables. Findings: 23 (14
  applied, 6 waiting for more research, 1 accepted, 2 dismissed), none waiting for a decision. Not yet seen in use:
  the completion suggestion and Not now.

- **Release:** `0cac052`, sole-network confirmation, Watched-season episode lists, the completion suggestion and Mark all
  episodes watched (items 1 and 4; PR #29, the branch's two commits rebased, same tree as the reviewed head), released
  2026-10-30 UTC with database migration `db/cu1d_network_and_marks.sql` (two functions; no table, column, trigger,
  policy, status, capability or backup-format change). Design: `docs/ITEM4_DESIGN.md` §4.5. Behaviour: a sole TMDB network
  is confirmed at Add and in Refresh shows without being recorded as the owner's choice; several networks, or a show saved
  in Details, are listed under "Choose a network" (also when nothing needs writing); a confirmed network is never
  replaced and missing TMDB data blanks nothing. A Watched season without marks shows its list as reference. A fully
  checked list reads TMDB afresh and, on strict evidence, strengthens the existing Mark season watched offer; Watched
  changes only when the owner confirms, and Not now is per account on the device. Mark all episodes watched is explicit
  and literal on a Watched season, guarded by the identity the list was read for; `library_set_episode_marks` keeps the
  lock; Watched and marks otherwise stay separate. Before release: offline 1203/1203; the CU1 → CU1b → CU1c → CU1d
  rehearsal on PGlite (262 checks, a failure injected after each of CU1d's 14 statements, rematches, stale writes,
  isolation, a format-7 backup round trip, the test reverse); a local browser check with synthetic data at desktop, 375
  and 300 px; a Fable review of the two functions and their page callers (nothing blocking or worth fixing). Release: a
  pre-release format-7 backup validated; a read-only preflight (phase `contracted-cu1`, format 7, CU1 to CU1c's run
  records, CU1d absent, its dependencies present, 22 holds, 21 findings, no other writers); the SQL Editor's contents
  checked against the run file's hash and run as written (its RLS prompt concerned the migration's own temp table); the
  run record confirmed by a separate read (both functions' sources equal the file, security invoker, members only, anon
  and PUBLIC none). The post-migration backup validated and equals the pre-release one field by field (19 tables, 1,363
  rows, no differences). Merged only after that, because merging deploys. Verified after deployment: Pages built `0cac052`
  (delayed by a GitHub incident); the 35 application files are byte-identical and all 29 versioned files carry
  `20261030-cu1d`; the reloaded page runs in `contracted-cu1` without console errors; two Watched seasons without marks
  show their lists read-only (no checkboxes) with Mark all offered. Those reads sent no writes, and a third backup equals
  the post-migration one. No production network, mark, status, hold or finding was changed; Refresh shows was not run
  and Mark all, Not now and "Choose a network" weren't used on the live site, so they're verified offline and with
  synthetic data only. Limits: TMDB's status, finale tags and counts are contributor data, so the suggestion is not a
  guarantee, and real finale and network data were not sampled; an automatic network is TMDB's current one, not always
  the original; a blank network on a show saved in Details is offered again on each Refresh; Mark all has no single undo.

- **Earlier release:** `697d123`, date equivalence (item 4; PR #27, the branch's five commits rebased, same tree as the
  reviewed head), released 2026-10-29 UTC with database migration `db/cu1c_date_equivalence.sql` (replaces
  `library_cu_set_season_date`, adds `private.cu1c_exact_date`; no table, status, capability or backup-format
  change). Behaviour (design §4.4): an exact date is a full display date whose `date_sort` is that same real date;
  two exact dates within one calendar day are the same date (the stored date kept, the finding set aside by the
  rule as `same_date_within_one_day`, TMDB and research alike, review included; Refresh doesn't send them, imports
  record research ones set aside, an older pending one shows Keep your date); TMDB never changes a stored exact
  date without an owner review (two or more days wait as `tmdb_date_differs`); qualified research still moves a
  future exact date to another future date; only an exact new date is automatic. Preserved: TBA is filled as
  before; a hand-typed window (no "TBA") is filled only while its date is still to come and a passed one isn't
  re-checked (as CU1); "today counts as aired" (strictly after today is future) on both paths; aired dates,
  protected values and holds need review; exact → window or TBA goes to review; TMDB without a date never blanks a
  date. Before release: offline 1182/1182; the CU1 → CU1b → CU1c rehearsal on PGlite (189 checks, a failure
  injected after each of CU1c's 14 statements, every rule through the real SQL, one-day findings non-actionable
  across repeated TMDB sends, repeated imports and older-page calls, the test reverse and a reinstall); a local
  browser check with synthetic data; a Fable review of the guarded date function (every CU1 check preserved in
  order; a non-exact research value auto-applying, the widened hand-window rule and the helper's grants fixed and
  confirmed in a follow-up). Release: a pre-release format-7 backup validated; the quiet window held; a read-only
  preflight (phase `contracted-cu1`, format 7, CU1's run record, CU1c absent, the date function exactly CU1's
  source, 22 holds, 21 findings, no pending date finding); the SQL Editor's contents checked against the file's
  hash and run as written (its RLS prompt concerned the migration's own temp table); the run record confirmed by
  a separate read (function replaced, members only; helper not executable by anon). Verified after deployment:
  the post-migration backup validated and equals the pre-release one field by field; Pages built `697d123`; the
  33 application files are byte-identical and carry `20261028-dates`; the reloaded page loads the new code without
  console errors and its review opens unchanged (nothing waiting, six waiting for research). No production date,
  hold or finding was changed (the two dates named in the release approval included); Refresh shows and research
  imports were not run. Limits: a set-aside one-day finding stays set aside if the stored date is later
  hand-edited; the page's "today" is UTC and the database's its session time zone, so near midnight a fill can
  become a review item (never the reverse); an older page's import reopens a one-day research finding briefly
  before the same import sets it aside again.

- **Earlier release:** `21c3707`, the hold editor and setup-status fix (item 4; PR #25, the branch's seven commits rebased,
  same tree as the reviewed head), released 2026-10-24 UTC with database migration `db/cu1b_hold_edit.sql` (one
  function, `library_cu_update_hold`; no table, capability or backup-format change). Adds and edits holds in
  Collections and rules (in place: same id and created_at; stored shape, value and collection kept unless changed;
  an unchanged form sends nothing; a stale edit is refused); a confirmed setup import updates Settings' status at
  once. Before release: offline 1176/1176; the CU1 rehearsal followed by CU1b on PGlite with a failure injected after
  each of CU1b's 13 statements (and CU1's 89), editing, refusals (stale, invalid, another member, signed out), the
  write guard and a backup round trip; local browser checks with synthetic data (add and edit through the real
  controls, stale remove and edit refused with a visible message, the status right after a real import, 375 and 300
  px); a Fable review of the contract and editor (findings fixed and confirmed closed, including show-wide protected
  values, which five production holds use); a local check that every production hold opens in the editor and saves
  unchanged. Release: a pre-release format-7 backup validated (identical to the post-setup one); the quiet window
  held; a read-only preflight (phase `contracted-cu1`, format 7, CU1's run record, the function absent, 23 holds);
  the SQL Editor's contents checked against the file's hash and run as written (its RLS prompt concerned the
  migration's own temp table); the run record confirmed by a separate read (function present, members only, the
  holds' fingerprint unchanged); merged and deployed. Verified after deployment: Pages built `21c3707`; the 34
  application files are byte-identical and carry `20261023-holds`; the reloaded page runs in `contracted-cu1`; the
  post-release backup validated and equals the pre-release one field by field; Collections and rules lists the 23
  holds, each with Edit, and one opened in the editor showed its stored values and was closed without saving (no
  write request sent). No production hold was added, edited or removed; Refresh shows and research findings were
  not run.

- **Earlier release:** `4e858c1`, collection updates (item 4, CU1; PR #23, the branch's ten commits rebased, same tree as
  the reviewed head), released 2026-10-23 UTC with database migration `db/cu1_collection_updates.sql` (backup
  format 7). Before release: offline 1167/1167; the CU1 rehearsal on PGlite with a failure injected after each of
  its 89 statements, the admin runbook at format 7 and the release's backup checks; the EP1 rehearsal with the
  runbook at format 6; local browser checks with synthetic data (research round trip through the real file picker,
  re-import refused, review, Disney+ preview, delete dialog, lifecycle refresh decisions, light mode, 375 and 300
  px); one bounded real research run against a synthetic library; Fable reviews of the implementation and of the
  recovery and backup work (findings closed). Release: a pre-migration format-6 backup validated offline; the
  migration applied once (a read-only preflight first; the SQL Editor's contents checked against the file's hash;
  run as written, without the editor's RLS rewrite, since the migration enables and verifies RLS itself) and its
  run record confirmed by a separate read (phase `contracted-cu1`, backup format 7, RLS on the ten new tables);
  merged and deployed promptly. Verified after deployment: Pages built `4e858c1`; the application files are
  byte-identical to the commit and carry `20261023-cu1`; the retired scripts are gone; the reloaded page runs
  in `contracted-cu1`. The first format-7 backup validated, and the pre-migration backup converted to format 7
  equalled it field by field (no library change; the migration's own preservation checks passed). The collection
  setup file was then imported (3 definitions, 8 exclusions, 23 holds; one hold's show reference corrected in the
  private file to the show's current title, owner-approved), read back from a new backup (every hold matches the
  file, the protected Season 3 date included; the library's own tables unchanged), and that backup validated.
  Refresh shows and research findings were not run in production. Limits: the TMDB completion signals and network
  results are contributor data and can be missing, late or wrong, and cached episode lists can go stale; three of
  the four trade outlets refuse automated reading, so research leans on official sources.

- **Earlier app release:** `8baebb1`, the show rating directly after the title (PR #20, `4d850b5`, and its correction PR
  #21, `8baebb1`, which keeps the score beside the title when its explanation opens), released 2026-10-22 UTC
  (interface only; no database, backup or saved-data change; fetching, cache and Credits unchanged). Before release:
  offline 1238/1238, and local browser checks with synthetic data and every explanation open (desktop rows and a
  collection; 375 and 300 px Currently Watching and All TV with a long title: score beside the title or on the
  next line when a long title fills it, explanation below inside the row or card, no overlap with the expand button
  or season line, 44 × 44 targets, no overflow; a real tap doesn't expand). Verified after deployment (read-only):
  Pages built `8baebb1` and serves `20261022-rnote` on all 28 versioned files, all 34 application files
  byte-identical; after a hard reload (Pages caches `watchlist.html` for 10 minutes) both scored shows' scores sit 6
  px after their titles on the same line, not with the categories; a click opened the explanation below without
  expanding, the score stayed beside the title, keyboard focus showed it; in same-origin frames at 375 and 300 px
  every score was beside its title, 44 × 44, explanations inside the cards, no overlap or overflow; no console errors.
  Expanding one more TMDB-matched show (during #20's check) sent one TMDB show read and nothing else; no writes were
  sent and Refresh shows wasn't run. #20 alone was live briefly: its open explanation moved the score to a new line
  on desktop rows (fixed by #21). Limits: a very long desktop title puts the score on the next line; not observed
  live: an asterisked, amber or red score.
- **Earlier release:** `acc8262`, TMDB show ratings and Settings Credits (PR #18; commits `3a1026c` and `acc8262`, the
  branch's two commits rebased, same tree), released 2026-10-22 UTC (interface and device storage only; no database,
  backup or saved-data change). Before release: offline 1238/1238, and local browser checks with synthetic data at
  desktop, 375 and 300 px (one read per expanded show, no writes, the tap and keyboard explanation, 44 px targets, no
  overflow, collections, Credits). Verified after deployment (read-only): Pages built `acc8262` and serves
  `20261022-rate` on all 28 versioned files; all 34 application files byte-identical to the commit; the signed-in
  page loads in phase `contracted-ep1` with no console errors. Expanding one TMDB-matched show sent one TMDB show
  read and nothing else, and showed its green score; a click and keyboard focus showed the explanation (the show
  stayed expanded); Settings ended with Credits, its logo loaded. No writes were sent and Refresh shows wasn't run.
  Not observed live: an asterisked, amber or red score, a failed read, and the phone layout. Limits: scores appear
  only after a show is expanded (or after Refresh shows, Add season, a preview or Match) on each device; a tab already
  open doesn't see scores another tab cached.
- **Before that:** `2299166`, film-collection suggestions (PR #16; commits `dd585c4` and `2299166`, the branch's
  two commits rebased, same tree), released 2026-10-22 UTC (interface only; no database, backup or saved-data
  change). Before release: offline 1220/1220, and local browser checks with synthetic data only: every menu state
  with real clicks (the menu stays open, focus kept), Refresh collections finding a film added later, the add-screen
  notes, and at 375 and 300 px a long collection name, a failed check and its Retry (fits, no overflow; the add
  screen's Retry was made 44 × 44 px on phones). Verified after deployment (read-only): Pages built `2299166` and
  serves `20261022-coll` on all 27 versioned files, each (and `config.js` and `watchlist.html`) byte-identical to
  the commit; the signed-in All Movies page loads in phase `contracted-ep1` with no console errors; every film's
  menu offered Check collection and none offered Pull rest before a check; one film in a one-film TMDB collection
  was checked live (a TMDB read) and then showed nothing, with the menu still open; no writes were sent. Not
  observed live: Pull rest after a check, "All collection films are already in your library.", a failed check,
  and the add-screen notes (no film was searched or added). Limits: "already in your library" uses the movie tools'
  title-or-TMDB-id matching; the menu checks only when asked.
- **Previous app releases:** `f01f0fa`, EP3 "Next unwatched" line (PR #14, 2026-10-22 UTC; interface and device
  storage only): verified deployed read-only; the line itself wasn't seen live (no episode marks at the check).
  `b7c698a`, EP2 episode-list controls (PR #12, 2026-10-21; interface and device storage
  only): verified deployed, with the owner's phone checks and an owner-operated write smoke test. `45f12d9`, EP1
  episode progress (PR #9, 2026-10-21): `db/ep1_episode_marks.sql` applied once, original tables preserved in the
  first format-6 backup, signed-out access refused, a desktop mark / clear smoke test. Each PR holds the details.
- **Database (as observed at the CU1d release, 2026-10-30):** phase `contracted-cu1` (B4/B5 with M1 owner-only
  access, `access = members`, episode marks and collection updates), backup format 7, recovery archive active, the
  collection setup imported. G9 (archive retirement) is paused. The API exposes only `public` and `graphql_public`;
  the format-5 and format-6 restores are kept as `private.restore_backup_v5` and `private.restore_backup_v6`,
  reachable only through `restore_backup`. **Repairs are fix-forward:** the B4/B5 and D2 rollbacks are retired,
  EP1, CU1, CU1b, CU1c and CU1d have none (`db/test/cu1_reverse.sql`, `cu1b_reverse.sql`, `cu1c_reverse.sql` and
  `cu1d_reverse.sql` are for test environments only; CU1d's run record confirmed 2026-10-30), and reopening anonymous access
  is never a recovery step. Data recovery is a format-7 restore through the signed-in page, or
  `docs/ADMIN_RESTORE.md` (its tool exports and checks the database's own format); accounts,
  `docs/MEMBER_RECOVERY.md`.
- **Admin enrichment extensions** (PR #11; database only, not an app release): `db/admin/tv_enrich_partial.sql`
  installed in production on 2026-10-21, with its run record confirmed by a separate read. It adds
  `private.tv_enrich_show_partial` and `private.tv_enrich_season`. Verified after the install: no application
  role can execute either function, the strict `private.tv_enrich_show` is unchanged, and no library data
  changed. One owner-approved batch then matched a few catalog shows and some of their seasons in a single
  transaction, leaving the rest of each show's seasons unmatched on purpose. Verified by a separate commit read,
  a post-batch read, a before/after backup comparison and the owner's in-app checks: only the intended TMDB
  identity fields changed, and every other row, episode marks included, is identical. A season left unmatched
  is matched later only as its own approved step, and only where the current model allows it: a plain
  `Season N` of the same TMDB show, once confirmed. Split seasons, seasons that belong to a different TMDB
  show, and non-plain labels stay unmatched.
- **Done:** the B3 / B1 / B7 plan (S1–S6; D10 deferred), simplification Batches A and B.
- **Reverting releases** (each needs its own approval, tested like any change):
  - S4–S6: no database migration, but the app's actions change saved data (memberships, film state,
    deletes, Match, Pull rest) and reverting code doesn't reverse them. The stage commits depend on each
    other: revert the set together, newest first.
  - Batch B: no saved-data effect; a code revert of its commits, newest first.
  - M1: not revertible by a code revert. Earlier pages can't use the locked database (they fail closed:
    writes refused, reads error); repairs are fix-forward.
  - CU1d: the page can be reverted by a code revert of `0cac052` and `1ffd079`, newest first; the two functions stay
    (fix-forward), unused by older pages; networks and marks set with it stay as saved.
  - Date equivalence (CU1c): the page can be reverted by a code revert of its five commits, newest first; the
    CU1c function stays (fix-forward) and keeps its rules for any page (an older page's TMDB differences on exact
    dates then wait in review instead of applying).
  - Hold editor (CU1b): the page can be reverted by a code revert of its seven commits, newest first (holds added or
    edited with it stay as saved); `library_cu_update_hold` stays (fix-forward), unused by older pages.
  - CU1: not revertible by a code revert. Pages from before CU1 stop against the CU1 database (phase mismatch);
    repairs are fix-forward.
  - Rating beside the title: no saved-data effect; a code revert of `8baebb1` and `4d850b5`, newest first.
  - TMDB show ratings: no database or saved-data effect; a code revert of `acc8262` and `3a1026c`, newest first
    (the device cache key is then ignored).
  - Film-collection suggestions: no database or saved-data effect; a code revert of `2299166` and `dd585c4`,
    newest first.
  - EP3: no database or saved-data effect; a code revert of `f01f0fa` (the cache's numbers and titles are then
    ignored).
  - EP2: no database or saved-data effect beyond the marks an owner sets with it; a code revert of `b7c698a`
    (the setting's device key is then ignored).
  - EP1: not revertible by a code revert. The M1 page against the EP1 database keeps its ordinary writes, but
    its backups and restores are refused and the database refuses its delete of a marked season; repairs are
    fix-forward.
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
[#9]: https://github.com/jaredsclove/Watchlist/pull/9
[#11]: https://github.com/jaredsclove/Watchlist/pull/11
[#12]: https://github.com/jaredsclove/Watchlist/pull/12
[#14]: https://github.com/jaredsclove/Watchlist/pull/14
[#16]: https://github.com/jaredsclove/Watchlist/pull/16
[#18]: https://github.com/jaredsclove/Watchlist/pull/18
[#20]: https://github.com/jaredsclove/Watchlist/pull/20
[#21]: https://github.com/jaredsclove/Watchlist/pull/21
[#23]: https://github.com/jaredsclove/Watchlist/pull/23
[#25]: https://github.com/jaredsclove/Watchlist/pull/25
[#27]: https://github.com/jaredsclove/Watchlist/pull/27
[#29]: https://github.com/jaredsclove/Watchlist/pull/29
[#32]: https://github.com/jaredsclove/Watchlist/pull/32

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
- **Merging to `main` deploys the page.** When a page needs a migration, merge only after the migration's run record is
  confirmed.
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
- Built-in catalog dates change only through the collection-update date functions (Refresh shows, an imported
  finding or a review decision). `db/rpc.sql` can't reinstall
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
- **Collection updates (CU1):** the individual-hold editor gap and the stale setup-status line after import are
  resolved (PR #25, CU1b); dates within a day are the same date (PR #27, CU1c). The owner ran the first production
  Refresh shows and research import before CU1c, and Refresh shows again after CU1d. Still open: a page can't detect CU1b before calling it (a page deployed before its migration stops its
  writes on Edit until reloaded).
- **Optional, not scheduled:** on an
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

The harness models EP1 (the default), B4/B5 before EP1, a rolled-back (5c) database, no Stage 5 and an
unknown phase only; its session history is opt-in (`routes: {}`). `tests/episodes.test.js` also runs the
released M1 page (from git) against the EP1 database. `b45-compat` keeps C2 and the stop-until-reload cases. Syntax check:
`node --check` on each `*.js`, `tests/*.js`, `tools/*.mjs`. Database rehearsals run locally on PGlite
(`tools/db-rehearsal-*.mjs`; see `db/README.md`). The identity audit (`tools/identity-audit.mjs`)
reads production, so it needs approval.
