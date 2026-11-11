# Watchlist: how the app behaves

Current behaviour by area, for when a task touches it. `docs/STATE.md` is the startup document; read this only as needed.
The code wins over this file; report any difference.

A personal TV and film watchlist: a static page on GitHub Pages (`watchlist.html` + classic-script
JS files, no build step) with a Supabase (PostgREST) backend and TMDB for identities and metadata.
Members sign in with an email and a password (accounts are created by the library owner; there is no
public sign-up). Each member's library is theirs alone: the database allows a signed-in member only their
own rows, and nothing to anyone signed out. Collaborative editing of a shared library is not a goal.

- **Views:** TV (Currently Watching, All TV, Coming Soon), Movies (All Movies), Queues (Q1, below), Collections
  (personal collections: shows, seasons and, since S4, films editable there; Remove from a
  collection with Undo; Add to <collection>…, S5), Settings (Manage collections and watch-with
  choices, Collection updates, Backup & Restore; Backup & Restore is the first card, and Account's password form opens
  from "Change password…"). Since S6 every view
  has a hash route (`#/tv/watching` … `#/collections/<id>`, `#/settings`) and browser Back / Forward work.
- **Layout (compact interface):** one app bar holds the title, TV · Movies · Collections and Settings (on phones, a
  non-sticky row of the areas and a gear, no logo); the areas and view tabs are words only (no icons). Then one list
  toolbar (`.list-toolbar`: toggles, Search, scope selects, Filters, + Add, the count), wrapping in page order. The
  status filter (default "All except Skipped") and a collection's Separate / Combined are in the Filters panel; while
  the status filter is on its default, the chip row says "Status: All except Skipped", and another value is a chip and
  counts on Filters. At 1100 px and wider, "Search TMDB to add" sits right after library search (collections too),
  styled the same (field, search icon, size) and kept compact together (about 220 px and 300 px), with an explicit Search
  button; library search filters as you type and has none. TMDB search is sent only by Enter or Search: it fills
  the + Add panel's own search, and adding stays that panel's, confirmed in its preview. Lists are tables from 1100 px, cards
  below it, in two columns between 701 and 1099 px. A collection's title, note, Back and Edit share a compact header; its tabs
  are one scrolling row at every width. In a collection, TMDB adds to the library first, then the existing "Add to collections"
  step opens with that collection preselected: two steps, never atomic, and nothing joins the collection until that button. Backup and its date
  are only in Settings' Backup & Restore; no backup, or 14 days or more, puts ⚠ on the Settings control (with the status
  in its name) and it then opens on that section. Show rows read expand · title · ⋯. On a phone card the chevron starts on
  the card's one left margin, and the season line, progress, labels and actions flow below it from that margin, with progress
  beside the date when it fits; category labels are small pills inside 32 px targets, and Up to date is quiet text. Show
  cards read the next target, then progress and the action on one line when they fit, then (All TV, collections) the
  categories; Currently Watching cards show categories only when expanded. An expanded show's controls share rows, and
  each season's label and actions share a line when they fit. Status is a quiet directly editable
  select; read-only statuses (Seasons lists, Coming Soon) are plain coloured words, To Watch neutral and green kept for
  watched. Skip is a plain outlined button. Desktop progress bars are hidden at 0%, and cells without an action are empty
  (no "—"). Coming Soon shows "Nov 18" under its month headings; All Movies counts "12 films · 0 watched" ("8 of 12 films
  · 0 of 12 watched" when filtered). Priority is edited in the row's ⋯ (shows and films; Seasons lists show it
  only); High shows ★ and Low the word, Normal nothing. The show-row shortcut reads "Mark S4 watched" (Specials or another
  short label by name, "Mark Volume 2 watched"; else "Mark season watched"; its name and tooltip name the season; the
  episode list's offer keeps "Mark Season N watched"), as do an expanded show's season rows, where it sits with Skip in
  one group across the action columns (Match and Delete set apart after them); flat Seasons lists keep "Mark watched".
  Season progress reads "1/3 seasons watched". In show views (Currently Watching, All TV Shows, collections) the desktop
  column is "Action" and Up next has more room.
- **Planning queues (Q1, item 7):** the app bar's Queues (`#/queues`) shows one of the member's named queues at a time,
  chosen in a selector in their saved order (the last one shown is remembered on this browser). Manage queues, on the page,
  makes, renames and deletes queues (the confirmation names the entry count; the library is never touched) and moves them up
  and down. An entry is a film, a whole show or one season; the same item may be in several queues, once per queue, and a
  queue never holds a whole show beside one of its seasons (several distinct seasons are fine). Entries are reordered by
  dragging the ⠿ handle (mouse or touch; the handle alone takes the gesture, so the page scrolls as usual and Esc cancels), or
  with ↑ / ↓ and the ⋯ menu's Move to top / bottom; every way sends one guarded move with the order the page showed (a
  queue changed elsewhere is refused and read again). Focus stays on the control used, the other move button at an end, the
  moved entry's move control after a drop, the next entry's ⋯ after Remove. Rows read the title (a link that opens the item:
  a season or show in All TV as Shows for that visit, searched, expanded and focused; a film in All Movies), a kind line
  ("Whole show · Up next Season 3", "Season 1 · Mar 4 · Upcoming", "Film · Jul 9, 2023") and a state label (Watched,
  Skipped, Complete, the show's status). Films and seasons offer their ordinary Mark watched; a whole show its status select
  and the show row's own action (Mark E9 watched / Mark S3 watched). Add to queue… is in shows' and films' ⋯ menus, and
  Queue… beside a season in All TV's and a collection's Seasons lists and Coming Soon: one dialog, reading the queues fresh,
  says per queue why the choice can't go there ("Already in this queue (#3)", "The whole show is in this queue", "Has
  Season 2 of this show"), can make a new queue, and adds at the bottom without changing any status (already watched or
  complete items may be added and keep their label). **Completion** is the database's, in the same transaction: a film or
  season going from unwatched to watched leaves every queue; an ended show whose last unwatched regular season is marked
  watched, or whose Show ended is turned on with every regular season watched (at least one regular season, none skipped;
  specials never count), loses its whole-show entries everywhere. Nothing else removes an entry: reads, Refresh shows'
  new seasons, restore, edits, Skip, episode marks (the last episode doesn't complete a season) and unmarking (removed entries
  don't come back). An ongoing show caught up stays. **Matching** keeps the rule: a season moved into a show a queue holds
  whole leaves that queue; a whole-show entry of the show the season emptied is carried to where it went (another show, or the
  film it became), a duplicate merged into the entry already there at its place; Match reports any such queue change.
  Deleting a film, season or show removes its entries. A change made from the queue reads it again once it ends.
- **Games (G1, item 5; `games.js`, `games-data.js`, `db/g1_games.sql`):** the app bar's Games (`#/games`, `#/games/franchises`,
  `#/games/collections`) has three views. **Library:** each saved game version (an IGDB record) with its platform line, status
  (Want to play, Playing, Paused, Finished, Skipped; a select), priority (⋯; ★ High, Low), genres (chips that filter), separate
  source-labelled scores ("Critics 87 · IGDB (9)", "Players 78 · IGDB (258)"); search, Genre and Status filters (default All
  except Skipped); Sort with Title, Release date, Status, Priority, Critic score and Player score (item 13's sort line and
  remembering). **Game length was removed by the owner's decision (2026-11-10):** no estimates, play style, Length sort,
  HowLongToBeat link or time-to-beat reads; a remembered sort that included Length keeps its other fields (the usual order when
  none remain), and `game_settings.play_style` stays as a legacy value, never shown, sent back unchanged on each save and kept in
  backups. **Platforms** (Settings → Games; one row in the database, so they follow the member and are in backups; read once at
  sign-in, so opening Settings reads nothing): a game shows only when a qualifying release on a chosen platform exists; with PS5
  chosen, a released PS4 game counts as "PS4 · Playable on PS5" with its PS4 date unless it is on Sony's PS4-only list
  (`games-data.js`, with the date checked). Hidden games keep their status, priority, collections and queue places and come back
  when a chosen platform has them; a note counts them. **Release rule** (owner, 2026-11-10): a qualifying row (Full Release or
  no status; never beta, alpha, early or advanced access, a compatibility listing, an optimization patch, offline or cancelled)
  with a full date on a chosen platform (North America or Worldwide rows first) is playable on that date, labelled "PS5 · Oct 23,
  2026 · per IGDB"; a month, quarter, year or TBA never becomes playable by its period ending and stays under Coming; Store or
  publisher evidence recorded with research access (Details) confirms availability at the precision it gives ("· Store or
  publisher"). **Not out yet** (⋯, and beside a franchise's Up next; every member) holds that one platform release out of the
  member's Up next while IGDB's row keeps that date and precision; a changed row ends it by itself; "It's out" ends it.
  **Franchises:** following is explicit (a game's ⋯ or + Add game) and saving follows nothing. A followed franchise (an IGDB
  series) is a collapsed row: "Up next: <version> · <platform line>" or Caught up, and "Coming: …" (+N more). Up next is the earliest
  counted spot, by its original's release date, that isn't Finished or skipped and has a playable version: the member's saved
  version first (Playing, Paused, Want to play), else a native release, else one playable through compatibility. A spot is an
  original with its remasters and remakes (separate games, saved and queued on their own; finishing any completes the spot) and
  its plain ports (IGDB records typed Port of that version, joined to its saved entry, their dates kept per platform). A Skipped
  version is passed over alone; "Skip this spot" passes the whole spot. Main-series games count (IGDB's series membership
  Member); spin-offs count once "Count it toward Caught up" is chosen. Coming lists announced releases on a chosen platform for
  counted spots not done, and a native edition coming for any version (a native PS5 release after a finished PS4 version) without
  moving the franchise off Caught up. **Refresh** reads each followed series' membership (new games) and every known record
  (new platform rows, dates, ports), saves the cache, joins new plain ports to saved games (guarded by what was read) and reports
  new titles under Coming and Up next changes; it adds nothing to Want to play or a queue. **Review** lists saved games whose IGDB
  spot changed, or that sit on an ambiguous chain (a remaster of a port); nothing changes until the member picks "Use IGDB's"
  (a guarded relink) or "Keep mine" (kept until IGDB changes again). **Collections:** private, hand-made game collections
  (create, rename, delete, add from a game's ⋯, Remove); membership is independent of queues, following and status. **Details:**
  IGDB's release rows (with the ones that don't count named) and the PlayStation Store page when IGDB lists one. **IGDB** is reached only through the `igdb` function
  (`supabase/functions/igdb`): it holds the client secret, answers only members (it asks PostgREST's `stage5_capabilities` with
  the caller's token), and passes an allow-list of read-only queries (a `game_time_to_beats` query from a page opened before game length was removed is
  answered with an empty list, temporarily); the page caches what it reads per member (`game_titles`,
  replaceable, never in backups; `library_game_titles_purge` empties it). **Games research** (members with research access;
  `games-research.js`): Settings → Games → Download games research brief lists what IGDB alone can't settle (announced releases
  on the member's platforms in followed franchises, releases in the last 60 days dated only by IGDB, PS4 games counted through
  Sony's rule, ambiguous relationships, uncounted spin-offs); the owner researches it with Claude (the refresh-catalogs skill)
  and imports the findings file (`watchlist-games-research-findings`, version 1) with Import games findings…. Every finding
  needs title-specific evidence (a PlayStation Store page on playstation.com, or the publisher's official page) checked on or
  before its research date; a file with any finding of the wrong shape is refused whole. Availability and compatibility
  findings become decisions at once (Available at the precision the source gives; or a Not out yet hold carrying the
  evidence, for a release not out yet or a PS4 game Sony's Store lists as PS4 only); relationship and series-role findings are
  kept and offered in Games → Review ("Join it as a port", "Use research's spot", "Count it toward Caught up", "Skip this
  spot", or Dismiss), and an unsaved version already follows a relationship finding in its franchise. A decision that carries
  evidence is research: the database refuses it without research access. Evidence content is Claude's assessment, shown as
  such; the page checks its shape only. **Backups (format 9)** carry the member's own game records: `game_settings`
  (platforms, and the legacy `play_style`), `game_entries` (IGDB id, spot and joined port ids, the title as saved from IGDB, status, priority,
  timestamps), `game_follows` (the IGDB series id and its name as saved), `game_decisions` (kind, IGDB id, platform, basis
  and value: a hold's IGDB date and precision, evidence links and research dates, kept link choices), `game_collections`,
  `game_collection_members`, and each queue entry's `game_entry_id`. IGDB's details stay out: release rows, genres, scores,
  store links and relationships are in the cache only and come back with Refresh. The basis (an
  implementation choice, documented here): the Twitch Developer Services Agreement (12/04/2024), under which IGDB is offered,
  allows Twitch data to be used to benefit the end user, bars sharing it with third parties, and requires deleting it on
  request; a backup is the member's own file of their own choices, and the database copy (cache and records) can be deleted.
  Unresolved: the agreement doesn't say whether its deletion duty reaches files a member has already downloaded, and those
  can't be recalled.
- **Games in queues (G1):** Add to queue… in a game's ⋯; the entry reads "Game · <platform line>" with the status select.
  Adding changes no status; setting a game to Finished takes it out of every queue (the database, in the same transaction); it
  can be queued again for a replay. A game on none of the member's platforms is hidden in the queue ("+N hidden") and keeps its
  numbered place: moving a shown entry puts the shown ones back into the other places in their new order, saved as one guarded
  write of the whole order (`library_queue_set_order`, with the order the page has, hidden entries included). Example: [Dune,
  hidden Switch game, Severance S2, Astro Bot] with Astro Bot to the top is [Astro Bot, hidden, Dune, Severance S2]; Dune to
  the bottom is [Severance S2, hidden, Astro Bot, Dune]. A queue with nothing hidden moves as before (`library_queue_move`).
- **Show ended (UI polish 2):** set in a show's Details, not the expanded show. It is part of Details' draft: Cancel
  discards it, Save sends what changed, the categories (`library_set_metadata_b45`) and then Show ended
  (`library_set_show_state_b45`), each with its own expected values, in one write lane; not one transaction. Save with
  Show ended unchanged sends the categories as before. A refused or unconfirmed categories save sends nothing more. Once
  the categories are saved they become the dialog's baseline, so Save again sends only Show ended. A refused Show ended is
  said ("Categories saved. Show ended wasn't changed: …") and kept as the draft; an unconfirmed one is never called
  unchanged: the list is read again and the dialog says what it shows (saved as chosen, or not yet, with the request
  possibly still completing), or that it isn't known when that read fails.
- **Sorting (item 13, `view-sort.js`):** the toolbar's Sort lists the fields the open view offers, each with its
  starting direction: Currently Watching Title, Series premiere, Next unwatched season premiere, Rating and Priority; All TV
  in Shows the same plus Status; Coming Soon Title, Season premiere, Show rating, Status and Priority; All Movies Title,
  Release date, Status and Priority; a collection by its layout (All media: Title, Premiere or release, Next unwatched
  season premiere, Rating, Status, Priority; TV the same with Series premiere; Movies only as All Movies). The flat Seasons
  presentations (All TV's and a collection's), Queues and the seasons inside an expanded show aren't sorted. Choosing a
  field makes it first; fields already chosen keep their order behind it and break ties (a field chosen again keeps its
  direction). The sort line, shown only while the view has its own sort, lists the fields in order, each with its ↑ or ↓
  (reverses it in place) and ✕ (takes it out), then Reset to default, which clears the whole sort of that view (that
  layout of a collection). The view's usual order is always the last tie-breaker. Sorting happens within each section
  (Currently Watching's In progress and Caught up; Coming Soon within each month, months in date order and TBA last; a
  collection's TV and Movies, or All media); filters still decide what is listed and counts are unchanged. Unknown
  values go last in either direction: no date, TBA, no rating shown, or a field the item doesn't have (a film has no
  rating or up-next season). Series premiere is TMDB's first-air date from the per-device show cache (`show-ratings.js`,
  "f"), never a stored season's date: it fills from the show details the page already reads, so Refresh shows can fill
  dates for the shows it checks, and expanding a show reads its details when its entry is missing, old or has no date
  (a read without a date keeps it unknown until the entry is old). Sorting itself never fetches or writes. Next
  unwatched season premiere is the date of the season the row's Up next / Next names (an active earlier-seasons range
  first; skipped seasons passed over; TBA or nothing left is unknown). Rating is the rounded score the row shows; with a
  rating field active and a listed show unrated, the line says "Some shows have no rating on this device." Status
  groups: Watching → To Watch → Watched → Skipped (a Skipped film marked watched is Skipped); Priority High first. Rows
  are sorted at every redraw, so a row can move after a change (focus follows the item). Each view's sort is page memory
  while Watchlist is open; with Settings' "Remember each view’s sort when I reopen Watchlist" on (the default) it is also
  saved per account in this browser (`watchlist_view_sorts`, a collection once per layout) and comes back after a
  reload. Turning it off deletes that account's saved sorts on this browser (the open page keeps its sorts) and views then
  open in their usual order; turning it on saves the open page's. Not in the database or backups.
- **Films' delete (UI polish 2):** in the film's ⋯ menu ("Delete from library…", or "Skip film (built-in catalog)…"),
  with the same question and call as before; no separate ×. Season deletes are unchanged. Film collection tags are
  rounded pills like the categories, still teal.
- **Open Episodes list and phone dialogs (UI polish 2):** checkboxes and episode labels in aligned columns, titles
  wrapping, the air date at the right (under the title on phones), the bulk controls in a group of their own, watched
  episodes quieter. On phones the + Add panel keeps its title and Close on one line and the ways to add on the next
  (labels wrap inside them; item 12), with the search field and its button side by side; dialogs take nearly the whole
  screen, sized to what is visible, with their action buttons kept in view while the body scrolls.
- **Categories (UI polish):** pills in a stable priority, network, franchises, genres, forms (each group in its stored
  order). A desktop row shows one line: the pills that fit its view's character budget (smaller below 1240 px, where the
  show views' column is at its minimum), the first always whole, then a "+N" button that shows the rest inline and reads
  "Fewer" while they are shown (page memory per row, reset on reload; focus stays on it). An unusually long label may wrap.
  Cards list every pill; every pill filters as before.
- **Show rows' Up next / Next (UI refine):** a released season reads by its label alone ("Season 2"); its premiere is
  in its expanded row, its Episodes summary and Coming Soon. An upcoming season keeps its date or TBA text and Upcoming.
  Flat Seasons lists and Coming Soon keep their dates. The column is narrower and wraps, so the action sits beside it.
- **Episode-aware show rows (EP5):** a show row's Up next, Action and Progress describe one target, its up-next season
  as chosen before (Earlier seasons included; marks never choose it). When the row offers an action (Watching, not up to
  date, the season aired) and that season has marks: with its next unwatched episode known, "Season 35 · Episode 9" (the
  title below in the same type, while titles are shown by default), "Mark E9 watched" (the same one-episode change,
  ignoring a held key's repeats and, for a second after a row action settles, further presses on that show's row action)
  and "S35 · 8/12 episodes watched" with its bar (episode progress names its season: "S35", or a season's whole name,
  which may wrap); with every listed episode marked, "All listed episodes watched", no row action (the season is
  completed from its expanded row or its list), focus going to the show's expand button; with no numbered list on this
  device, the season, Mark S4 watched and the existing episode progress ("N episodes marked", or N/T from a
  count only while the marks are fewer), a bar only with a known total. Anything else reads as before. While the row shows
  a season's episodes, that season's expanded row has only Episodes, Mark S4 watched and Skip (its premiere is in its
  open list's summary), and the expanded show carries the season progress line; that line leaves the skipped count to
  "Show skipped seasons (N)" (a Skipped show keeps it; an all-skipped show keeps the control's note). Phone cards read Up
  next, progress and action, then the categories on their own line.
  Genres are neutral-gray pills, the same shape and size as the form, franchise and network pills and filter buttons like them.
- **Film collections (TMDB):** a film TMDB places in a collection keeps that identity. Its ⋯ menu offers Check
  collection while the collection's contents are unknown on this page, then Pull rest only when another film can be
  added, "All collection films are already in your library." when none can, nothing for a collection of one, or a
  failed check with Retry. The + Add screen checks the selected film's collection once and shows the same states as
  a note. The lookup is page memory only and every fetch replaces it (Check collection, Pull rest, Refresh
  collections), so a film TMDB adds later is found on the next check or page load.
- **Skipped seasons in an expanded show:** seasons skipped on their own are hidden until "Show skipped seasons (N)",
  beside Details, lists them in season order (with Keep); it then reads "Hide skipped seasons (N)". The control appears
  only when the show has a skipped season; when every season is, a note says "All N seasons are skipped". The choice is
  per show and page memory only (redraws, collapsing and other views keep it; a reload or account change resets it). It is
  the same in Currently Watching, All TV and collections. A show whose own status is Skipped lists every season as
  before. Display only: progress, up next, earlier seasons and the flat Seasons lists use every season.
- **Episode progress (EP1–EP5):** an expanded show's TMDB-matched seasons have an inline Episodes list (from TMDB,
  one open at a time) with a checkbox per episode and one "Mark watched through [Episode N ▾] [Apply]" control above
  it (marks only the unmarked episodes up to N; starts on the first unmarked, keeps the choice). Titles are hidden
  behind a Show title button per episode unless Settings' "Show episode titles by default" is on (per account,
  this browser only; a choice that can't be saved holds for the open page). A season with
  marks reads "N/T episodes watched" (T from a per-device cache of the list; "N episodes marked" when unknown). An expanded
  season shows the season, that progress and Episodes on one line, with the next-unwatched text on a smaller line below.
  After that progress (EP3), "Next unwatched: E6" names the first listed episode without a mark, with " — Title" only
  while titles are shown by default; it comes from the open list or the per-device cache and is hidden when the list is
  unknown, empty or fully marked, or the season is watched or skipped. That cache (replaceable device storage, not
  library data or backups) holds each list's episode ids and, since EP3, numbers and titles; a list cached before EP3
  has ids only, so its line appears after the list is opened once. On an expanded season's row and phone card (not the
  flat Seasons lists or Coming Soon), the line ends with a "Mark E6 watched" button (EP4): the same one-episode change as
  that episode's checkbox, without opening the list; it marks only the episode it names (sends nothing if another is
  next by then), ignores a held key's repeats and, for a second after a mark settles, further clicks on that season's
  button. Focus stays on it; when it goes (the last listed episode marked), focus goes to that season's Episodes. The
  list stays the way to mark another episode or undo one. Show-level Watching is unchanged; nothing completes a season automatically (a fully checked list offers
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
  TMDB-matched season lets Refresh shows add it back while TMDB lists it, each time, unless a hold or the owner's decision keeps it out (CU1e). Holds (standing decisions, protected values,
  identity holds) come from the setup file or are added and edited in Settings → Collections and rules (edits in
  place through `library_cu_update_hold`, CU1b; a hold changed meanwhile is refused).
- **Research access (CU2; design `docs/ITEM4_DESIGN.md` §4.6):** per member, off by default, switched in the database only
  (`private.library_members.research_enabled`; `docs/MEMBER_RECOVERY.md`). Without it, Settings' card is "Show updates" (Review
  updates, Skipped shows), review lists TMDB findings only, and no research control or wording shows; ordinary collections,
  Refresh shows and backup and restore are unchanged. It restricts research operations, not a member's own saved data: rows stay
  readable and in backups, and existing holds keep governing TMDB operations. The page follows `stage5_capabilities().research`
  (anything but true hides the controls) and a `research_not_enabled` refusal; the database decides. Review offers "Continue
  applying imported updates", on a click only, for findings an interrupted import left unevaluated (research; new season, date or
  alias; pending with no reason; record still present): the automatic rules (`p_review` false) on a fresh read.
- **Data:** `game_settings`, `game_entries`, `game_follows`, `game_decisions`, `game_collections`, `game_collection_members` and the
  cache `game_titles` (G1), `watch_queues` and `queue_entries` (Q1), `watchlist_items` (seasons and films), `tv_shows`, `custom_collections`,
  `personal_collections`, `collection_memberships`, `watch_with_choices`, `catalog_show_links`,
  `catalog_film_links`, `episode_marks` (watched episodes of TMDB-matched seasons; no dates or titles), and since
  CU1 `update_setup`, `collection_definitions`, `collection_exclusions`, `update_holds`, `record_aliases`,
  `membership_removals`, `show_update_settings`, `update_findings`, `research_briefs`, `research_imports`. The research guard
  (`private.research_write_guard`, CU2) sits on all of those except `membership_removals` and `show_update_settings`.
  Rows are owner-scoped: `user_id` is the signed-in member (`auth.uid()`), never sent
  by the client; membership is `private.library_members`.
- **Writes** go mainly through database functions (the `library_*_b45` family, `org_*`,
  `set_season_watched` / `set_season_skipped`, `library_set_episode_marks`, `library_add_watched_season_marks`,
  `library_cu_sync_show_network`, `delete_tv_season`, `restore_backup`).
  Some take `p_expected` values and refuse a stale write; not every path does, so check each one before relying
  on it. `delete_tv_season` takes the mark count the page showed: a page from before EP1 can't delete a marked season.
- **Backup** is format 9 (twenty-seven tables: format 8's twenty-one — format 7's nineteen plus the two queue tables, with
  both orders — plus six game tables; queue entries carry `game_entry_id`; no `user_id`; never the IGDB cache). **Restore**
  converts a file of format 5 to 8 to format 9 first (a format-5 file has no marks, a format-6 file no collection updates, a
  format-7 file no queues, a format-8 file no games; the preview says what a restore removes) and leaves out any `conversion` or `recovery` section an old file carries, saying so.
  Formats 1 to 4 are refused (`docs/ADMIN_RESTORE.md` has the offline route). It validates the file, checks for identity loss, makes and validates a safety backup,
  then replaces the owner's rows in one database transaction and verifies field by field.

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
  redraw keeps the focused control, its value and caret. Two additions: when the focused season is hidden because it
  is now skipped, focus goes to its show's "Show skipped seasons" control; when a focused "Mark E6 watched" is gone,
  focus goes to its season's Episodes toggle. Deletions and other redraws follow the chain (a show row's action that is
  gone, as after its last listed episode, falls to the show's expand button). A Games screen redraw (each keystroke in Search
  your games) and a Games dialog redraw (+ Add game's search finishing, a save or follow ending) keep a focused text box's
  focus, caret and selection the same way; a text box
  focused anew after a redraw (from the Search button, a Rename) gets its caret at the end.
- **Accepted limitations (Batch A):** after a refused change is rolled back,
  focus doesn't return to the control it started from; focus doesn't follow a pending save across the
  phone/desktop switch; opening another view during a change (a long Refresh shows or movie-tool run
  included) shows "Loading…" until the lane is free; Manage has no Stop waiting; watch-with and
  deletes still send no expected values (the lane and the out-of-date pause cover a stale list).
