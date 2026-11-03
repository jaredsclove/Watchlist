# Watchlist: how the app behaves

Current behaviour by area, for when a task touches it. `docs/STATE.md` is the startup document; read this only as needed.
The code wins over this file; report any difference.

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
  select. Priority is edited in the row's ⋯ (shows and films; Seasons lists show it
  only); High shows ★ and Low the word, Normal nothing. The show-row shortcut reads "Mark watched" (its name and tooltip
  name the season; the episode list's offer keeps "Mark Season N watched"). Season progress reads "1/3 seasons watched".
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
- **Episode progress (EP1–EP4):** an expanded show's TMDB-matched seasons have an inline Episodes list (from TMDB,
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
- **Data:** `watchlist_items` (seasons and films), `tv_shows`, `custom_collections`,
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
- **Backup** is format 7 (nineteen tables: format 6's nine plus collection updates' ten; no `user_id`). **Restore**
  converts a format-5 or -6 file to format 7 first (a format-5 file has no marks, a format-6 file no collection
  updates; the preview says what a restore removes) and leaves out any `conversion` or `recovery` section an old file carries, saying so.
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
  focus goes to its season's Episodes toggle. Deletions and other redraws follow the chain.
- **Accepted limitations (Batch A):** after a refused change is rolled back,
  focus doesn't return to the control it started from; focus doesn't follow a pending save across the
  phone/desktop switch; opening another view during a change (a long Refresh shows or movie-tool run
  included) shows "Loading…" until the lane is free; Manage has no Stop waiting; watch-with and
  deletes still send no expected values (the lane and the out-of-date pause cover a stale list).
