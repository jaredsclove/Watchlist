// ─── Derived TV views: Currently Watching, All TV, Coming Soon ───────────────
// Views over every TV season and show (tv_shows) in the library. They store
// nothing of their own, seed nothing, call no TMDB and touch no backup or restore.
// While one is open, activeViewId holds its id. Edits go through the show and
// season actions (tv-shows.js, row-actions.js), by the show's or the row's real id.
// Defined here rather than in config.js so the catalog-refresh workflow's
// config.js cache handling is unaffected.
const DERIVED_VIEWS = [
  { id: 'watching',   label: 'Currently Watching', icon: '▶',  mediaType: 'tv' },
  { id: 'alltv',      label: 'All TV',             icon: '🗂', mediaType: 'tv' },
  { id: 'comingsoon', label: 'Coming Soon',        icon: '📅', mediaType: 'tv' }
];

// ─── Row rules (pure) ─────────────────────────────────────────────────────────
// A TV season row (tv-shows.js isTvSeason): never a film (media_type 'movie', or a
// row without an identity labelled 'Film').
function isTvViewRow(r) {
  return !!r && (r.media_type === 'tv' || (r.media_type == null && (r.season || '') !== 'Film'));
}

// Dynamic rows store TMDB's TBA as 'TBA' / '2099-01-01'; static rows use free
// text such as "TBA 2027" with a guessed date_sort, so the text decides.
function isTbaRow(r) {
  return /TBA/i.test(r.display_date || '') || r.date_sort === '2099-01-01';
}

// Today's date in the viewer's own time zone, as YYYY-MM-DD.
function localTodayStr(now) {
  const d = now || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Aired on or before today, going by the stored date only (no TMDB lookup).
function isReleasedRow(r, today) {
  return !isTbaRow(r) && (r.date_sort || '') <= today;
}

function isSpecialRow(r) {
  return r.season_number === 0 || /^Specials?$/i.test((r.season || '').trim());
}

// season_number when stored; otherwise the number in a static label such as
// "Season 5 (Part 1)" or "Volume 2"; otherwise last.
function seasonNumberOf(r) {
  if (r.season_number != null) return r.season_number;
  const m = /^(?:Season|Volume)\s+(\d+)/i.exec(r.season || '');
  return m ? parseInt(m[1], 10) : Infinity;
}

function cmpStr(a, b) {
  a = a || ''; b = b || '';
  return a < b ? -1 : a > b ? 1 : 0;
}

// Season order within a show: numbered seasons before specials, then season
// number, then date, then label.
function seasonOrder(a, b) {
  const sa = isSpecialRow(a) ? 1 : 0, sb = isSpecialRow(b) ? 1 : 0;
  if (sa !== sb) return sa - sb;
  const na = seasonNumberOf(a), nb = seasonNumberOf(b);
  if (na !== nb) return na < nb ? -1 : 1;
  return cmpStr(a.date_sort, b.date_sort) || cmpStr(a.season, b.season);
}

// Fully deterministic: the row id breaks any remaining tie.
function compareSeasons(a, b) {
  return seasonOrder(a, b) || cmpStr(a.id, b.id);
}

function compareTitles(a, b) {
  return (a || '').localeCompare(b || '', undefined, { sensitivity: 'base' });
}

// Watching shows (tv_shows.status), each with its seasons in sorted order, its up
// next season and whether it is Up to date (none of its remaining seasons has
// aired). Up to date is a state, not a stored status. Both lists are A–Z by
// title, then show id. `shows` is a Map or list of tv_shows rows.
// B4/B5 §4.7: a show whose stored seasons are all skipped isn't listed; a show marked
// ended with nothing left after its furthest watched season leaves too (it stays Watching
// and is in All TV as "Caught up · Ended") unless its earlier-seasons range is active,
// which brings it back with that range's first season as up next. Nothing here changes
// a status, Ended or a watched mark.
function deriveCurrentlyWatching(rows, shows, today) {
  const seasonsByShow = new Map();
  rows.forEach(r => {
    if (!isTvViewRow(r) || !r.show_id) return;
    if (!seasonsByShow.has(r.show_id)) seasonsByShow.set(r.show_id, []);
    seasonsByShow.get(r.show_id).push(r);
  });
  const active = [], upToDate = [];
  for (const show of (typeof shows.values === 'function' && typeof shows.get === 'function' ? shows.values() : shows)) {
    if (show.status !== 'watching') continue;
    const seasons = (seasonsByShow.get(show.id) || []).sort(compareSeasons);
    if (seasons.length === 0 || allSeasonsSkipped(seasons)) continue;
    const range = resumeRange(show, seasons);
    const resuming = !!range && range.state === 'active';
    if (!resuming && isEndedExit(show, seasons)) continue;
    const upNext = resuming ? range.sequence[0] : upNextSeason(seasons);
    const item = {
      key: show.id,
      show,
      title: show.title,
      seasons,
      upNext,
      upNextReleased: upNext ? isReleasedRow(upNext, today) : false,
      upToDate: !resuming && isShowUpToDate(seasons, today),
      resume: range
    };
    (item.upToDate ? upToDate : active).push(item);
  }
  const byTitle = (a, b) => compareTitles(a.title, b.title)
    || cmpStr(a.key, b.key);
  return { active: active.sort(byTitle), upToDate: upToDate.sort(byTitle) };
}

// Every show with at least one linked season, whatever its status, each with its
// seasons in sorted order and its up next season. Up to date only for a Watching
// show (the same rule as Currently Watching); no other status ever gets it.
// A–Z by title, then show id. TV rows that can't be listed —
// unlinked, or linked to a show that wasn't loaded — are counted, never guessed
// into a group.
function deriveAllTv(rows, shows, today) {
  const showMap = typeof shows.get === 'function' ? shows : new Map(shows.map(s => [s.id, s]));
  const seasonsByShow = new Map();
  let unlinked = 0, missingShow = 0;
  rows.forEach(r => {
    if (!isTvViewRow(r)) return;
    if (!r.show_id) { unlinked++; return; }
    if (!showMap.has(r.show_id)) { missingShow++; return; }
    if (!seasonsByShow.has(r.show_id)) seasonsByShow.set(r.show_id, []);
    seasonsByShow.get(r.show_id).push(r);
  });
  const items = [];
  for (const show of showMap.values()) {
    const seasons = (seasonsByShow.get(show.id) || []).sort(compareSeasons);
    if (seasons.length === 0) continue;
    const range = resumeRange(show, seasons);
    const resuming = !!range && range.state === 'active';
    const upNext = resuming ? range.sequence[0] : upNextSeason(seasons);
    // (Up to date keeps today's rule, §4.3: Ended plays no part; an active earlier-seasons range is in progress.)
    const endedExit = !resuming && isEndedExit(show, seasons);
    const allSkipped = allSeasonsSkipped(seasons);
    items.push({
      key: show.id,
      show,
      title: show.title,
      seasons,
      upNext,
      upNextReleased: upNext ? isReleasedRow(upNext, today) : false,
      upToDate: show.status === 'watching' && !resuming && isShowUpToDate(seasons, today),
      resume: range,
      endedExit,
      allSkipped
    });
  }
  items.sort((a, b) => compareTitles(a.title, b.title)
    || cmpStr(a.key, b.key));
  return { items, unlinked, missingShow };
}

// All TV's Status filter: '' (the default) is every status except Skipped,
// 'all' is every status, anything else is that one show status.
function allTvStatusMatches(status, fStatus) {
  if (fStatus === 'all') return true;
  if (!fStatus) return status !== 'skipped';
  return status === fStatus;
}

// The theme / genre / network filter ('' = any): a row's own theme; a show when any
// of its stored seasons has it (the show still keeps all its seasons).
function themeMatchesRow(r, fTheme) {
  return !fTheme || r.theme === fTheme;
}
function themeMatchesShow(seasons, fTheme) {
  return !fTheme || seasons.some(r => r.theme === fTheme);
}

// All TV Shows' progress filter, on the seasons' own flags, never the show status
// (Status filters that separately). Skipped seasons don't count. Has unwatched
// seasons: at least one season neither watched nor skipped, aired or not, and
// never a Skipped show (the To watch rule of Seasons). All non-skipped seasons
// watched: at least one such season and every one watched, whatever the show status.
const ALLTV_PROGRESS_LABELS = { '': 'Any progress', unwatched: 'Has unwatched seasons', allwatched: 'All non-skipped seasons watched' };
function allTvProgressMatches(item, fProgress) {
  const kept = item.seasons.filter(r => !r.skipped);
  if (fProgress === 'unwatched') return item.show.status !== 'skipped' && kept.some(r => !r.watched);
  if (fProgress === 'allwatched') return kept.length > 0 && kept.every(r => r.watched);
  return true;
}

// ─── All TV: Shows / Seasons presentation ────────────────────────────────────
// Shows (one card per show) is the first-use default. The choice is remembered
// on this device only (not in backups or the database); without usable storage
// All TV simply opens in Shows.
const ALLTV_PRESENTATION_KEY = 'watchlist_alltv_presentation';
const ALLTV_SEASON_VIS = ['notskipped', 'all', 'towatch', 'watched', 'skipped'];
const ALLTV_SEASON_VIS_LABELS = { notskipped: 'All (except Skipped)', all: 'All seasons', towatch: 'To watch', watched: 'Watched', skipped: 'Skipped' };

function readAllTvPresentation() {
  try {
    return localStorage.getItem(ALLTV_PRESENTATION_KEY) === 'seasons' ? 'seasons' : 'shows';
  } catch (e) {
    return 'shows';
  }
}

// A real calendar date in YYYY-MM-DD form.
function isValidDateSort(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return false;
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}

// Seasons-mode visibility. Watched and Skipped (the season's own flag) are
// independent: a season with both flags is in both. To watch is neither, and
// never a season of a Skipped show. All (except Skipped), the default, leaves out
// seasons skipped on their own; All lists every season. (Status filters shows.)
function allTvSeasonVisible(r, show, vis) {
  if (vis === 'notskipped') return !r.skipped;
  if (vis === 'towatch') return !r.watched && !r.skipped && show.status !== 'skipped';
  if (vis === 'watched') return !!r.watched;
  if (vis === 'skipped') return !!r.skipped;
  return true;
}

// The seasons of the given All TV shows (deriveAllTv items, already filtered by
// Search / Theme / Year / show Status) that pass the visibility choice and rowMatches
// (the theme filter), split before any sorting: genuine TBA (text or
// sentinel; wins over a guessed date_sort), dates needing review (not TBA, no
// valid date) and dated seasons, oldest first. Ties: title, season order, row id.
function deriveAllTvSeasons(items, vis, rowMatches = () => true) {
  const rows = items.flatMap(it => it.seasons.filter(r => allTvSeasonVisible(r, it.show, vis) && rowMatches(r)));
  const tieOrder = (a, b) => compareTitles(a.title, b.title)
    || seasonOrder(a, b)
    || cmpStr(a.id, b.id);
  const tba = rows.filter(isTbaRow).sort(tieOrder);
  const review = rows.filter(r => !isTbaRow(r) && !isValidDateSort(r.date_sort)).sort(tieOrder);
  const dated = rows.filter(r => !isTbaRow(r) && isValidDateSort(r.date_sort))
    .sort((a, b) => cmpStr(a.date_sort, b.date_sort) || tieOrder(a, b));
  return { dated, tba, review, total: rows.length, showCount: new Set(rows.map(r => r.show_id)).size };
}

function setAllTvPresentation(mode) {
  if (activeViewId !== 'alltv' || (mode !== 'shows' && mode !== 'seasons') || mode === allTvPresentation) return;
  allTvPresentation = mode;
  try { localStorage.setItem(ALLTV_PRESENTATION_KEY, mode); } catch (e) { /* storage unavailable: this page only */ }
  renderFilters();
  renderTable();
}

function setAllTvSeasonVis(vis) {
  if (!ALLTV_SEASON_VIS.includes(vis)) return;
  allTvSeasonVis = vis;
  renderTable();
}

// Linked, unwatched, non-skipped seasons of a show that isn't Skipped: those with
// a confirmed date from today on, and those still TBA (whatever their guessed date_sort).
function deriveComingSoon(rows, shows, today) {
  const showOf = r => (typeof shows.get === 'function' ? shows.get(r.show_id) : shows.find(s => s.id === r.show_id));
  const eligible = rows.filter(r => {
    if (!isTvViewRow(r) || !r.show_id || r.watched || r.skipped) return false;
    const show = showOf(r);
    return !!show && show.status !== 'skipped';
  });
  const order = (a, b) => cmpStr(a.date_sort, b.date_sort)
    || compareTitles(a.title, b.title)
    || seasonOrder(a, b)
    || cmpStr(a.id, b.id);
  return {
    dated: eligible.filter(r => !isTbaRow(r) && (r.date_sort || '') >= today).sort(order),
    tba: eligible.filter(isTbaRow).sort(order)
  };
}

// ─── Loading ──────────────────────────────────────────────────────────────────
function tvRowsFilter() {
  return 'is_film=eq.false';
}

// Paginated, exact-count-checked reads of every TV season, every show and the
// catalog governance. GET only: no seeding, no TBA refresh. Refetched each time a
// view is entered.
// Returns true once the view shows a complete read, false when the read failed (Retry is
// shown), null when a newer read or another view took over.
// opts.operation (S3, brief §7.2): the reread an operation's answer asked for (reloadOpenView); it
// may move focus only while that operation's own placement (opts.origin) is still held. Without
// it, it never moves focus, and when the owner's focus is in the list it reads quietly, keeping the
// list on screen. The owner's own reload (Retry; no opts) keeps the B6 rules below.
async function loadDerivedView(opts = {}) {
  const viewId = activeViewId;
  if (!viewId) return null;
  const seq = ++derivedLoadSeq;
  // B6: focus in the list is recorded now and moved to the loading message; after the read
  // the focus rules run against the new data (a failed read focuses Retry; a superseded
  // read moves nothing). A loading message already focused carries the earlier record's place.
  // After the read, focus moves only if it is still on that loading message: the owner may
  // have gone to a header control, a filter or a dialog meanwhile, and that focus is theirs.
  const op = !!(opts && opts.operation);
  const focusRec = op ? operationFocusOrigin(opts.origin) : captureListFocus();
  const quiet = op && !focusRec && !!derivedData && derivedData.loaded && listHasOwnerFocus();
  const quietToken = quiet ? beginQuietReread() : null;
  if (!quiet) {
    dropQuietReread();
    document.getElementById('statsRow').innerHTML = '';
    holdViewFilters(viewId); // a reload or Retry keeps this visit's filters (browse-views.js)
    document.getElementById('filtersRow').innerHTML = '';
    showError('');
    paintDerivedMessage('Loading…', false);
    if (focusRec) placeListFocus('[data-loading]', focusRec);
  }
  const showsRead = typeof matchReadStart === 'function' ? matchReadStart('shows', '*') : null; // tracked (tmdb-match.js)
  try {
    const [rows, shows, gov] = await Promise.all([fetchAllRows(TABLE, tvRowsFilter()), fetchAllRows('tv_shows'), readGovernance()]);
    requireB45Shape(shows, 'priority');
    requireB45Shape(rows, 'priority');
    publishAllTvShows(showsRead, shows);
    if (showsRead) matchReadSettle(showsRead, null);
    if (seq !== derivedLoadSeq || activeViewId !== viewId) return null;
    publishGovernance(governanceCovers(gov, rows, shows));
    derivedData = { rows: rows.filter(isTvViewRow), loaded: true };
    const repair = lostFocusRepairDue(focusRec);
    if (quiet) endQuietReread(quietToken, false);
    const filterFocus = captureFilterFocus();
    renderFilters();
    const listing = renderDerivedTable(focusRec && focusIsPlaced(focusRec) ? focusRec : null);
    restoreFilterFocus(filterFocus);
    if (repair) repairLostFocus(focusRec.container, listing);
    return true;
  } catch(e) {
    console.error(e);
    if (showsRead && showsRead.state === 'pending') matchReadSettle(showsRead, e);
    if (seq !== derivedLoadSeq || activeViewId !== viewId) return null;
    if (quiet) { endQuietReread(quietToken, true, 'loadDerivedView'); return false; }
    const owned = !!focusRec && focusIsPlaced(focusRec);
    const repair = lostFocusRepairDue(focusRec);
    showError(`Couldn't load every TV row, so nothing is shown rather than an incomplete list. ${e.message}`);
    paintDerivedMessage('Failed to load.', true);
    if (owned) placeListFocus('[data-retry]', focusRec);
    else if (repair) placeListFocus('[data-retry]', blankFocusRecord(focusRec.container));
    return false;
  }
}

// ─── Operation rereads and focus (S3, brief §7.2) ─────────────────────────────
// An operation's reread (reloadOpenView) may use the operation's own placement only while it is
// still held (R2, R3): a placement the owner ended (a key, pointer or touch press, focus anywhere
// else — another control in the list too —, leaving the window, hiding the page, another view)
// is never revived by its reread, the chain or Retry (R4).
function operationFocusOrigin(origin) {
  return origin && focusIsPlaced(origin) ? origin : null;
}
// The owner's focus is on something in the list (not this page's loading message or Retry).
function listHasOwnerFocus() {
  if (!documentHasFocus()) return false;
  const a = document.activeElement;
  return !!a && typeof a.closest === 'function' && !!a.closest('#tbody, #cardList') && !a.closest('[data-loading], [data-retry]');
}
// R5, the quiet reread: the list stays as drawn (so the owner's control survives), marked busy, with
// a status line outside it. A failure keeps the last complete list and offers Retry beside the line.
function setListBusy(busy) {
  ['tbody', 'cardList'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (busy && typeof el.setAttribute === 'function') el.setAttribute('aria-busy', 'true');
    else if (!busy && typeof el.removeAttribute === 'function') el.removeAttribute('aria-busy');
  });
}
// The busy state belongs to the newest quiet reread only (review finding 2): a newer read, quiet or not,
// or another view takes it over, and an older read that ends later never clears or rewrites it.
let quietReread = null;
function beginQuietReread() {
  const token = {};
  quietReread = token;
  setListBusy(true);
  document.getElementById('statsRow').innerHTML = '<p class="reread-status" role="status">Reading the list again…</p>';
  return token;
}
function endQuietReread(token, failed, retryFn) {
  if (!token || token !== quietReread) return;
  quietReread = null;
  setListBusy(false);
  document.getElementById('statsRow').innerHTML = failed
    ? `<p class="reread-status" role="status">The list couldn’t be read again, so what is shown may be out of date. <button class="btn" onclick="${retryFn}()">Retry</button></p>`
    : '';
}
// A newer read that isn't quiet, or another view (switchView): the pending quiet reread's busy mark and
// status line go; its own end then changes nothing.
function dropQuietReread() {
  if (!quietReread) return;
  quietReread = null;
  setListBusy(false);
  const stats = document.getElementById('statsRow');
  if (stats && /class="reread-status"/.test(stats.innerHTML)) stats.innerHTML = '';
}
// Review finding 1: a quiet reread's end redraws the filter row (its values are kept, viewFilterStart),
// which would drop the owner's focus there (Search included, entered while the read was pending) and
// the caret. The focused filter control is noted before the redraw and focused again after it.
function captureFilterFocus() {
  if (!documentHasFocus()) return null;
  const a = document.activeElement, row = document.getElementById('filtersRow');
  if (!a || !a.id || !row || typeof row.contains !== 'function' || !row.contains(a)) return null;
  const sel = typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd, a.selectionDirection || 'none'] : null;
  return { id: a.id, sel };
}
function restoreFilterFocus(rec) {
  if (!rec) return;
  const el = document.getElementById(rec.id);
  if (!el || typeof el.focus !== 'function' || document.activeElement === el) return;
  el.focus();
  if (rec.sel && typeof el.setSelectionRange === 'function') el.setSelectionRange(rec.sel[0], rec.sel[1], rec.sel[2]);
}
// R7: the element that has focus is this reread's own loading message (or Retry), focused for an
// operation whose placement has ended since: the redraw removes it, so focus is repaired.
function lostFocusRepairDue(rec) {
  if (!rec || focusIsPlaced(rec) || !documentHasFocus()) return false;
  const a = document.activeElement;
  return !!a && typeof a.closest === 'function' && !!a.closest('[data-loading], [data-retry]');
}
function blankFocusRecord(container) {
  return { container, key: null, section: null, hook: null, next: [], prev: [] };
}
// Only while focus is lost (on the page, or on an element the redraw removed): the view's first
// heading or toggle, else its first entry, else its empty message (F-7) — never the operation's target.
function repairLostFocus(container, listing) {
  if (!documentHasFocus()) return;
  const a = document.activeElement;
  // This reread's own message or Retry that the redraw removed counts as lost (it is no longer listed).
  const box = visibleListBox(container);
  const removedMessage = !!a && typeof a.closest === 'function' && !!a.closest('[data-loading], [data-retry]')
    && !(box && [...box.querySelectorAll('[data-loading], [data-retry]')].includes(a));
  const lost = !a || a === document.body || a === document.documentElement || a.isConnected === false || removedMessage;
  if (lost) applyListFocus(blankFocusRecord(container), listing || null);
}

// The loading and failure messages (B6): the loading text can take focus from the page
// (tabindex -1) while a reload runs; Retry is the focus after a failed one.
function paintDerivedMessage(text, withRetry) {
  const retry = withRetry ? ` <button class="btn" data-retry="1" onclick="loadDerivedView()">Retry</button>` : '';
  const hook = withRetry ? '' : ' tabindex="-1" data-loading="1"';
  document.getElementById('tbody').innerHTML = `<tr><td colspan="${derivedColspan()}" class="loading"${hook}>${esc(text)}${retry}</td></tr>`;
  document.getElementById('cardList').innerHTML = `<div class="loading"${hook}>${esc(text)}${retry}</div>`;
}


// ─── Filters ──────────────────────────────────────────────────────────────────
// What a derived view's category, priority and marker choices are drawn from: every show
// the view lists before any filter (Coming Soon: the shows of its seasons).
function derivedFilterRecords() {
  if (!derivedData || !derivedData.loaded) return [];
  const today = localTodayStr();
  if (activeViewId === 'comingsoon') {
    const { dated, tba } = deriveComingSoon(derivedData.rows, tvShowsById, today);
    return dated.concat(tba).map(r => showOfRow(r)).filter(Boolean);
  }
  const items = activeViewId === 'watching'
    ? (({ active, upToDate }) => active.concat(upToDate))(deriveCurrentlyWatching(derivedData.rows, tvShowsById, today))
    : deriveAllTv(derivedData.rows, tvShowsById, today).items;
  return items.map(x => x.show);
}

// What a derived view's original-label choices are drawn from: every show (with all its
// seasons) or season the view lists before any filter.
function derivedThemeChoices() {
  if (!derivedData || !derivedData.loaded) return [];
  const today = localTodayStr();
  if (activeViewId === 'comingsoon') {
    const { dated, tba } = deriveComingSoon(derivedData.rows, tvShowsById, today);
    return dated.concat(tba).map(r => r.theme);
  }
  const items = activeViewId === 'watching'
    ? (({ active, upToDate }) => active.concat(upToDate))(deriveCurrentlyWatching(derivedData.rows, tvShowsById, today))
    : deriveAllTv(derivedData.rows, tvShowsById, today).items;
  return items.flatMap(x => x.seasons.map(r => r.theme));
}

// B10: one filter bar (render.js filterBarHtml). Visible: Search, Status (All TV) and, in Seasons,
// which seasons to list; everything else in the More filters panel.
function renderDerivedFilters() {
  const filtersRowEl = document.getElementById('filtersRow');
  const tag = `view:${activeViewId}`;
  // Back from a collection (browse-views.js) puts this view's filters back once.
  const { restored, values } = viewFilterStart(tag, filtersRowEl);
  filterPanelStart(tag, restored);
  // Show status (All TV only); the default hides Skipped shows.
  const statusSelect = activeViewId === 'alltv'
    ? `
      <select id="fStatus" onchange="renderTable()" aria-label="Status">
        <option value="">All (except Skipped)</option>
        <option value="all">All statuses</option>
        ${TV_STATUS_ORDER.map(s => `<option value="${s}">${esc(plainStatusLabel(s))}</option>`).join('')}
      </select>`
    : '';
  // All TV only: the Shows / Seasons switch (outside the collapsible panel) and,
  // in Seasons only, which seasons to list; in Shows only, the progress filter.
  const presentationToggle = activeViewId === 'alltv'
    ? `
    <div class="view-toggle" role="group" aria-label="Presentation">${[['shows', 'Shows'], ['seasons', 'Seasons']].map(([mode, label]) =>
      `<button class="view-toggle-btn${allTvPresentation === mode ? ' active' : ''}" aria-pressed="${allTvPresentation === mode}" onclick="setAllTvPresentation('${mode}')">${label}</button>`).join('')}</div>`
    : '';
  const seasonVisSelect = activeViewId === 'alltv' && allTvPresentation === 'seasons'
    ? `
      <select id="fSeasonVis" onchange="setAllTvSeasonVis(this.value)" aria-label="Seasons" title="Which seasons to list (Seasons only)">${ALLTV_SEASON_VIS.map(v =>
        `<option value="${v}">Seasons: ${ALLTV_SEASON_VIS_LABELS[v]}</option>`).join('')}
      </select>`
    : '';
  const progressSelect = activeViewId === 'alltv' && allTvPresentation === 'shows'
    ? `
      <select id="fProgress" onchange="renderTable()" aria-label="Progress" title="Which shows to list by their seasons’ watched state (Shows only)">${Object.entries(ALLTV_PROGRESS_LABELS).map(([value, text]) =>
        `<option value="${value}">${text}</option>`).join('')}</select>`
    : '';
  const themeSelect = themeFilterSelectHtml(derivedThemeChoices());
  // B4: one select per category (shows' own metadata; seasons inherit), priority and markers.
  const categoryFields = categoryFilterSelectsHtml(derivedFilterRecords());
  // Year (All TV only, Stage 4b): from every season the view lists before filtering.
  const yearSelect = activeViewId === 'alltv' && derivedData && derivedData.loaded
    ? yearFilterSelectHtml(deriveAllTv(derivedData.rows, tvShowsById, localTodayStr()).items.flatMap(x => x.seasons)) : '';

  filtersRowEl.innerHTML = filterBarHtml({
    lead: `${presentationToggle}${libraryAddButtonHtml('tv')}`,
    line: `${statusSelect}${seasonVisSelect}`,
    cats: [categoryFields],
    marks: [filterFieldHtml('Priority', 'fPriority', priorityFilterSelectHtml()), markerFilterChecksHtml()],
    more: [filterFieldHtml('Year', 'fYear', yearSelect), filterFieldHtml('Progress', 'fProgress', progressSelect), filterFieldHtml('Original label', 'fTheme', themeSelect)]
  });
  filtersRowEl.dataset.tab = tag;
  const seasonVisEl = document.getElementById('fSeasonVis');
  if (seasonVisEl) seasonVisEl.value = allTvSeasonVis;

  const tmdbPanel = document.getElementById('tmdbPanel');
  tmdbPanel.style.display = 'none';
  tmdbPanel.innerHTML = '';

  applyViewFilters(tag, values);
}

// ─── Rendering ────────────────────────────────────────────────────────────────
// carried: the focus a reload recorded before its read (loadDerivedView); otherwise the
// focus is recorded here, just before the redraw (B6).
function renderDerivedTable(carried) {
  if (!derivedData || !derivedData.loaded) return;
  const rec = carried || captureListFocus();
  const today = localTodayStr();
  const val = id => document.getElementById(id)?.value || ''; // a control that isn't shown doesn't filter
  const fSearch = val('fSearch').trim().toLowerCase();
  const fTheme = val('fTheme');
  const cats = categoryFilterValues(), fPriority = val('fPriority'), markers = markerFilterValues();
  // Search, priority, markers and categories, on the show (a season by its show).
  const showKeep = show => !!show && categoryMatches(metadataOf(show), cats) && priorityMatches(show.priority, fPriority) && markerMatches(show, markers);
  const keep = x => (!fSearch || (x.title || '').toLowerCase().includes(fSearch)) && showKeep(x.show || showOfRow(x));
  updateDerivedTableHeader();
  let listing = null;
  if (activeViewId === 'comingsoon') listing = renderComingSoon(today, r => keep(r) && themeMatchesRow(r, fTheme));
  else if (activeViewId === 'alltv') listing = renderAllTv(today, keep, val('fStatus'), fTheme, val('fProgress'), val('fYear'));
  else if (activeViewId === 'watching') listing = renderCurrentlyWatching(today, x => keep(x) && themeMatchesShow(x.seasons, fTheme));
  renderFilterBarState(); // B10: chips, More filters count (render.js)
  if (rec) applyListFocus(rec, listing || null);
  return listing;
}

function updateDerivedTableHeader() {
  const thead = document.getElementById('tableHead');
  if (!thead) return;
  const heads = {
    comingsoon: `<tr><th>Show &amp; Season</th><th>Categories</th><th>Premiere</th><th>Status</th><th></th></tr>`,
    alltv: `<tr><th>Show</th><th>Categories</th><th>Next</th><th>Status</th><th>Watched</th><th>Progress</th></tr>`,
    alltvSeasons: `<tr><th>Show &amp; Season</th><th>Categories</th><th>Premiere</th><th>Show status</th><th>Watched</th><th></th></tr>`,
    // B6: no Status column (every show here is Watching; status is changed in the expanded show).
    watching: `<tr><th>Show</th><th>Categories</th><th>Up next</th><th>Watched</th><th>Progress</th></tr>`
  };
  const key = activeViewId === 'alltv' && allTvPresentation === 'seasons' ? 'alltvSeasons' : activeViewId;
  if (heads[key]) thead.innerHTML = heads[key];
}

// Dynamic tabs store the network (TV) or genre (Movies) as the theme; static tabs
// use themed badges. Either is a filter pill for the view's theme filter (render.js).
// catalog: the catalog that governs the row or show (library.js), or null. A
// catalog's themes have their own badge styles; anything else is a network colour.
function themeBadgeHtml(catalog, theme, owner = '') {
  if (!theme) return '';
  const look = catalog ? { cls: `badge ${badgeClass(theme)}` } : { cls: 'badge', attrs: networkBadgeStyle(theme) };
  return filterPillHtml('theme', theme, theme, { ...look, title: `Filter by “${theme}”`, owner });
}

// ─── Compact counts (B8) ──────────────────────────────────────────────────────
// Two scopes only: shown (after every filter, defaults included) and total (the view's
// whole set of that unit with every filter cleared). Units are always written. "Showing N
// of T" (a count line) or "N of T" (a heading) only when N ≠ T; a secondary count names its
// scope ("of these": the shown items; "library": the total). Counts come from the rows the
// view already read; nothing is counted from a read that failed or is still loading (the
// line is cleared then).
function countUnit(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
function countScoped(n, total, one, many) {
  return n === total ? countUnit(total, one, many) : `Showing ${n} of ${countUnit(total, one, many)}`;
}
function headingCount(n, total, one, many) {
  return `· ${n === total ? countUnit(total, one, many) : `${n} of ${countUnit(total, one, many)}`}`;
}
function countLineHtml(text) {
  return `<p class="count-line">${esc(text)}</p>`;
}

// The open view's column count: Currently Watching (B6) and Coming Soon have five columns,
// All TV six. Full-width rows (headings, sections, messages, expanded actions) span exactly that.
function derivedColspan() {
  return activeViewId === 'watching' || activeViewId === 'comingsoon' ? 5 : 6;
}
// A full-width row from a shared helper written for six columns (tv-shows.js dismissAllNewHtml),
// fitted to the open view.
function fitColspan(out) {
  return { ...out, row: (out.row || '').replace(/colspan="6"/g, `colspan="${derivedColspan()}"`) };
}

// A collapsible section's header: a real button (keyboard, aria-expanded), as in the
// Browse views (B6).
function derivedSectionHtml(name, label, count) {
  const open = !!derivedSectionOpen[name];
  const btn = `<button type="button" class="section-toggle" data-section="${name}" aria-expanded="${open}" onclick="toggleDerivedSection('${name}')"><span class="expand-chevron">${open ? '▾' : '▸'}</span> ${esc(label)} <span class="section-count">${count}</span></button>`;
  return {
    row: `<tr class="derived-section-row"><td colspan="${derivedColspan()}">${btn}</td></tr>`,
    card: `<div class="derived-section-card">${btn}</div>`
  };
}

// A section heading that doesn't collapse (Currently Watching's In progress): focusable by
// the page only (tabindex -1), so focus can land on it after a redraw (B6).
function derivedHeadingHtml(name, label, count) {
  return {
    row: `<tr class="derived-section-row derived-heading-row"><th colspan="${derivedColspan()}" scope="colgroup" tabindex="-1" data-section="${name}">${esc(label)} <span class="section-count">${count}</span></th></tr>`,
    card: `<h3 class="derived-section-card derived-heading-card" tabindex="-1" data-section="${name}">${esc(label)} <span class="section-count">${count}</span></h3>`
  };
}

// A view's empty-state message: focusable by the page only, the focus fallback of an empty view.
// extra: markup after the text (B10: Clear filters in a "no matches" message).
function derivedEmptyHtml(msg, pad = '2rem', extra = '') {
  return {
    row: `<tr class="empty-row"><td colspan="${derivedColspan()}" tabindex="-1" data-empty="1">${esc(msg)}${extra}</td></tr>`,
    card: `<div class="empty-row" style="padding:${pad} 0" tabindex="-1" data-empty="1">${esc(msg)}${extra}</div>`
  };
}

function renderCurrentlyWatching(today, keep) {
  const { active, upToDate } = deriveCurrentlyWatching(derivedData.rows, tvShowsById, today);
  const shownActive = active.filter(keep);
  const shownUpToDate = upToDate.filter(keep);

  // B8: the counts are in the section headings (shows), not tiles.
  document.getElementById('statsRow').innerHTML = '';

  const dismissAll = fitColspan(dismissAllNewHtml(shownActive.concat(derivedSectionOpen.uptodate ? shownUpToDate : [])
    .filter(x => x.show.catalog_new).map(x => ({ kind: 'show', id: x.show.id }))));
  let html = dismissAll.row, cardHtml = dismissAll.card;
  // B6: the upper section has its own heading (it doesn't collapse).
  const heading = derivedHeadingHtml('inprogress', 'In progress', headingCount(shownActive.length, active.length, 'show', 'shows'));
  html += heading.row;
  cardHtml += heading.card;
  shownActive.forEach(show => {
    const out = derivedShowHtml(show, today);
    html += out.row;
    cardHtml += out.card;
  });

  if (shownActive.length === 0) {
    const msg = active.length + upToDate.length === 0
      ? 'Nothing is marked Watching yet. Set a show to ▶ Watching in All TV and it shows up here.'
      : active.length === 0
        ? 'Nothing in progress. Every Watching show is caught up.'
        : 'No in-progress shows match your filters.';
    const out = derivedEmptyHtml(msg, '2rem', active.length ? filterEmptyClearHtml() : '');
    html += out.row;
    cardHtml += out.card;
  }

  // B6: the lower section is "Caught up" (the Up to date rule itself is unchanged).
  // B8: shown whenever it has shows (also when filters leave none), with its count.
  if (upToDate.length > 0) {
    const section = derivedSectionHtml('uptodate', 'Caught up', headingCount(shownUpToDate.length, upToDate.length, 'show', 'shows'));
    html += section.row;
    cardHtml += section.card;
    if (derivedSectionOpen.uptodate) {
      shownUpToDate.forEach(show => {
        const out = derivedShowHtml(show, today);
        html += out.row;
        cardHtml += out.card;
      });
      if (shownUpToDate.length === 0) {
        const msg = 'No caught-up shows match your filters.', clear = filterEmptyClearHtml();
        html += `<tr class="empty-row"><td colspan="${derivedColspan()}">${esc(msg)}${clear}</td></tr>`;
        cardHtml += `<div class="empty-row" style="padding:1rem 0">${esc(msg)}${clear}</div>`;
      }
    }
  }

  document.getElementById('tbody').innerHTML = html;
  document.getElementById('cardList').innerHTML = cardHtml;
  // What the focus chain needs (B6): each section's listed shows, whether it is drawn and open.
  return { sections: [
    { name: 'inprogress', shown: true, open: true, heading: true, keys: shownActive.map(x => x.key) },
    { name: 'uptodate', shown: upToDate.length > 0, open: !!derivedSectionOpen.uptodate, heading: true, keys: shownUpToDate.map(x => x.key) }
  ] };
}

// All TV: every show with a linked season, filtered by title, theme, year and show
// status; the show count is shows, not seasons.
// Shows: Theme matches any stored season and Progress applies; Seasons: Theme
// applies to each season (Progress is a Shows filter and isn't shown there).
function renderAllTv(today, keep, fStatus, fTheme = '', fProgress = '', fYear = '') {
  const { items, unlinked, missingShow } = deriveAllTv(derivedData.rows, tvShowsById, today);
  const listed = items.filter(x => keep(x) && allTvStatusMatches(x.show.status, fStatus));
  if (allTvPresentation === 'seasons') return renderAllTvSeasons(today, items, listed, unlinked + missingShow, fTheme, fYear);
  // Year: a show with any stored season of that year (it keeps all its seasons).
  const shown = listed.filter(x => themeMatchesShow(x.seasons, fTheme) && allTvProgressMatches(x, fProgress)
    && (!fYear || x.seasons.some(r => rowYear(r) === fYear)));

  // B8: shows listed of every show with a linked season (all statuses); of these, Watching and up to date.
  const ofThese = shown.length ? ` · of these, ${shown.filter(x => x.show.status === 'watching').length} Watching, ${shown.filter(x => x.upToDate).length} up to date` : '';
  document.getElementById('statsRow').innerHTML = countLineHtml(countScoped(shown.length, items.length, 'show', 'shows') + ofThese);

  const dismissAll = dismissAllNewHtml(shown.filter(x => x.show.catalog_new).map(x => ({ kind: 'show', id: x.show.id })));
  let html = dismissAll.row, cardHtml = dismissAll.card;
  const notListed = unlinked + missingShow;
  if (notListed > 0) {
    const msg = `⚠️ ${notListed} TV season${notListed === 1 ? ' isn’t' : 's aren’t'} linked to a loaded show, so ${notListed === 1 ? 'it isn’t' : 'they aren’t'} listed here.`;
    html += `<tr class="empty-row"><td colspan="6">${esc(msg)}</td></tr>`;
    cardHtml += `<div class="empty-row" style="padding:1rem 0">${esc(msg)}</div>`;
  }
  shown.forEach(item => {
    const out = derivedShowHtml(item, today);
    html += out.row;
    cardHtml += out.card;
  });
  if (shown.length === 0) {
    const out = derivedEmptyHtml(items.length === 0 ? 'No TV shows on your list yet.' : 'No shows match your filters.', '2rem', items.length ? filterEmptyClearHtml() : '');
    html += out.row;
    cardHtml += out.card;
  }

  document.getElementById('tbody').innerHTML = html;
  document.getElementById('cardList').innerHTML = cardHtml;
  // One list, no heading (the focus chain's fallback is its first show).
  return { sections: [{ name: 'all', shown: true, open: true, heading: false, keys: shown.map(x => x.key) }] };
}

// All TV, Seasons: the seasons of the shows that pass Search / Theme / Year / show
// Status, narrowed by the Seasons-only visibility choice. Dated seasons oldest
// first under year headers; genuine TBA and dates needing review in one
// collapsed section, labelled and counted separately.
function renderAllTvSeasons(today, items, shown, notListed, fTheme = '', fYear = '') {
  const { dated, tba, review, total, showCount } = deriveAllTvSeasons(shown, allTvSeasonVis, r => themeMatchesRow(r, fTheme) && (!fYear || rowYear(r) === fYear));
  // B8: the seasons listed and the shows they come from (no total: the Seasons choice is a list mode).
  document.getElementById('statsRow').innerHTML = countLineHtml(`Showing ${countUnit(total, 'season', 'seasons')}${total ? ` from ${countUnit(showCount, 'show', 'shows')}` : ''}`);

  let html = '', cardHtml = '';
  const note = msg => {
    html += `<tr class="empty-row"><td colspan="6">${esc(msg)}</td></tr>`;
    cardHtml += `<div class="empty-row" style="padding:1rem 0">${esc(msg)}</div>`;
  };
  if (notListed > 0) note(`⚠️ ${notListed} TV season${notListed === 1 ? ' isn’t' : 's aren’t'} linked to a loaded show, so ${notListed === 1 ? 'it isn’t' : 'they aren’t'} listed here.`);

  if (total === 0) {
    const out = derivedEmptyHtml(items.length === 0 ? 'No TV shows on your list yet.' : shown.length === 0 ? 'No shows match your filters.' : 'No seasons match your filters.', '1rem', items.length ? filterEmptyClearHtml() : '');
    html += out.row;
    cardHtml += out.card;
  } else if (dated.length === 0) {
    note('No dated seasons; see TBA / no date below.');
  }

  let lastYear = '';
  dated.forEach(r => {
    const year = r.date_sort.substring(0, 4);
    if (year !== lastYear) {
      html += `<tr class="year-group"><td colspan="6">${esc(year)}</td></tr>`;
      cardHtml += `<div class="card-year-group">${esc(year)}</div>`;
      lastYear = year;
    }
    const out = allTvSeasonRowHtml(r, today, false, 'dated');
    html += out.row;
    cardHtml += out.card;
  });

  if (tba.length + review.length > 0) {
    const count = `· ${countUnit(tba.length, 'TBA season', 'TBA seasons')}${review.length ? ` · ${review.length} ${review.length === 1 ? 'season needs' : 'seasons need'} a date review` : ''}`;
    const section = derivedSectionHtml('alltvTba', 'TBA / no date', count);
    html += section.row;
    cardHtml += section.card;
    if (derivedSectionOpen.alltvTba) {
      [['TBA', tba, false], ['Date needs review', review, true]].forEach(([label, list, needsReview]) => {
        if (!list.length) return;
        html += `<tr class="year-group"><td colspan="6">${esc(label)}</td></tr>`;
        cardHtml += `<div class="card-year-group">${esc(label)}</div>`;
        list.forEach(r => {
          const out = allTvSeasonRowHtml(r, today, needsReview, 'alltvTba');
          html += out.row;
          cardHtml += out.card;
        });
      });
    }
  }

  document.getElementById('tbody').innerHTML = html;
  document.getElementById('cardList').innerHTML = cardHtml;
  // The focus chain's listing (B6): season items, dated (no heading) and TBA / no date (a toggle).
  return { sections: [
    { name: 'dated', shown: dated.length > 0, open: true, heading: false, keys: dated.map(r => r.id) },
    { name: 'alltvTba', shown: tba.length + review.length > 0, open: !!derivedSectionOpen.alltvTba, heading: true, keys: tba.concat(review).map(r => r.id) }
  ] };
}

// One season in All TV's Seasons list: the show's status as a read-only label
// (it applies to every season; it's changed in Shows), the existing Watched
// control (release rule unchanged) and Skip / Keep. A date that isn't valid is
// shown as stored and labelled "date needs review", never as aired.
// B6: the row is a focus item (data-item; its title takes focus from the page) and each
// control has a stable identity (data-action).
function allTvSeasonRowHtml(r, today, needsReview, section = 'dated') {
  const item = seasonItemAttrs(r, section);
  const status = displayStatus(r);
  const show = showOfRow(r) || {};
  const rowClass = isOffList(r) ? 'row-skipped' : '';
  const dated = !needsReview && !isTbaRow(r);
  const todayTag = dated && r.date_sort === today ? '<span class="today-tag">Today</span>' : '';
  const upcomingTag = dated && r.date_sort > today ? '<span class="upcoming-tag">Upcoming</span>' : '';
  const reviewTag = needsReview ? '<span class="review-tag">date needs review</span>' : '';
  const statusPill = `<span class="status-pill s-${status}" title="Show status — applies to every season of ${esc(r.title)}. Switch to Shows to change it.">${esc(statusOptionLabel(status))}</span>`;
  const releaseOpts = { requireReleased: true, today };
  const badges = metadataChipsHtml(metadataOf(r), r.id, themeBadgeHtml(rowCatalogOf(r), r.theme, r.id));
  const row = `<tr class="${rowClass}"${item}>
      <td tabindex="-1" data-primary="1">
        ${priorityMarkHtml(show.priority)}<span class="show-title">${esc(r.title)}</span>${priorityMarkHtml(show.priority, true)}
        <span class="season-lbl"> · ${esc(r.season)}</span>
        ${todayTag}
      </td>
      <td>${badges}</td>
      <td class="date-cell">${esc(r.display_date)}${upcomingTag}${reviewTag}</td>
      <td>${statusPill}</td>
      <td>${seasonActionHtml('season-watch', seasonWatchControlHtml(r, releaseOpts, false))}</td>
      <td>${seasonActionHtml('season-control', seasonRowControlHtml(r))}</td>
    </tr>`;
  const card = `<div class="item-card ${rowClass}"${item}>
      <div class="card-top">
        <div class="card-title-block" tabindex="-1" data-primary="1">
          <span class="card-title">${priorityMarkHtml(show.priority)}${esc(r.title)}${priorityMarkHtml(show.priority, true)}</span>
          <span class="card-season">${esc(r.season)}</span>
          ${todayTag}
        </div>
      </div>
      <div class="card-meta">
        ${badges}
        <span class="card-date">${esc(r.display_date)}</span>${upcomingTag}${reviewTag}
      </div>
      <div class="card-actions">${statusPill} ${seasonActionHtml('season-watch', seasonWatchControlHtml(r, releaseOpts, true))} ${seasonActionHtml('season-control', seasonRowControlHtml(r))}</div>
    </div>`;
  return { row, card };
}

// A next-season line (B6): "Season 3 · Nov 12, 2026" with no "Next:" prefix (the column
// heading says it). A stored date that is empty or just "TBA" reads "Date TBA"; any other
// stored text ("2026 (TBA)", "2027 (announced)") is kept, so what it says isn't lost. On a phone card
// (no column heading) a screen reader hears "Next season:" first; only before an actual
// next-season value, never before a status such as "No upcoming season listed".
const SR_NEXT_SEASON = '<span class="visually-hidden">Next season: </span>';
function nextDateText(r) {
  const text = (r.display_date || '').trim();
  // Only an empty or bare "TBA" becomes "Date TBA"; any other stored text says something (a
  // year, "announced", "2026 (TBA)"), also on a row dated by the 2099 sentinel, and is kept.
  if (isTbaRow(r) && (!text || /^TBA$/i.test(text))) return 'Date TBA';
  return esc(text);
}
function nextSeasonLabel(upNext, released, card = false, upcomingOnTba = false) {
  const upcoming = !released && (upcomingOnTba || !isTbaRow(upNext)) ? '<span class="upcoming-tag">Upcoming</span>' : '';
  return `${card ? SR_NEXT_SEASON : ''}${esc(upNext.season)} · ${nextDateText(upNext)}${upcoming}`;
}

// A show that isn't in progress or Up to date (any status but a Watching one
// being watched): what's next on its list, without calling it in progress.
function neutralNextLabel(upNext, released, card = false) {
  if (!upNext) return 'No remaining season on your list';
  return nextSeasonLabel(upNext, released, card);
}

// The show-level expand button (B6): a real, labelled button in every show row and card of
// Currently Watching and All TV, so a keyboard reaches a show's seasons and actions. It
// stops the event, so one activation toggles once (the row's own click handler never runs).
function derivedExpandBtnHtml(key, keyArg, title, isExpanded) {
  return `<button type="button" class="expand-btn" data-show-key="${esc(key)}" data-primary="1" aria-expanded="${isExpanded}" aria-label="${isExpanded ? 'Hide' : 'Show'} seasons and actions of ${esc(title)}" onclick="event.stopPropagation(); toggleDerivedShow('${keyArg}')"><span class="expand-chevron">${isExpanded ? '▾' : '▸'}</span></button>`;
}

// A show's season progress as text: watched of non-skipped seasons, and skipped ones.
function showProgressText(seasons) {
  const kept = seasons.filter(s => !s.skipped);
  const skipped = seasons.length - kept.length;
  if (!kept.length) return `${seasons.length} season${seasons.length === 1 ? '' : 's'} · all skipped`;
  const watched = kept.filter(s => s.watched).length;
  return `${watched} of ${kept.length} season${kept.length === 1 ? '' : 's'} watched${skipped ? ` · ${skipped} skipped` : ''}`;
}

// One show: a header row/card with its up-next season (or, when Up to date,
// what is next on the list), the show-level status control and, for a Watching
// show in progress, the up-next season's watch control; expanded, every season
// of the show with Watched and Skip / Keep. Currently Watching passes only
// Watching shows; All TV passes shows of every status.
// B6: in Currently Watching there is no status control on the row (it is in the expanded
// show, with priority), and a caught-up show's row is compact (no progress, no "—").
// S3: a collection's show entry is All TV's (browse-views.js browseShowHtml). opts: { section
// (its focus section), kindTag (Combined), dateHtml (the collection's date text for a season),
// expandBtn (the collection's own expand button, given isExpanded) }.
function derivedShowHtml(item, today, opts = {}) {
  const { key, show, seasons, upNext, upToDate } = item;
  const inProgress = !upToDate && show.status === 'watching' && !!upNext;
  const dimClass = show.status === 'skipped' ? ' row-skipped' : '';
  const isExpanded = expandedShows.has(key);
  const keyArg = esc(key).replace(/'/g, "\\'");
  const theme = (upNext || seasons[0]).theme;
  const badges = metadataChipsHtml(show, key, themeBadgeHtml(showCatalogOf(show), theme, key));
  const range = item.resume;
  const resumeTag = range && range.state === 'active' && range.start
    ? ` <span class="state-tag resume-tag" title="Watching earlier seasons">Earlier seasons from ${esc(range.start.season)}</span>` : '';
  const titleHtml = `${priorityMarkHtml(show.priority)}<span class="show-title">${esc(item.title)}</span>${priorityMarkHtml(show.priority, true)}${stateTagsHtml(show, 'show')}${resumeTag}`;

  const trackable = seasons.filter(s => !s.skipped);
  const watchedCount = trackable.filter(s => s.watched).length;
  const progressPct = trackable.length > 0 ? Math.round(watchedCount / trackable.length * 100) : 0;
  const progressLabel = trackable.length > 0 ? `${watchedCount}/${trackable.length} watched` : `${seasons.length} season${seasons.length === 1 ? '' : 's'}`;
  const progressBarHtml = trackable.length > 0
    ? `<div class="mini-progress-track"><div class="mini-progress-fill" style="width:${progressPct}%"></div></div>`
    : '';

  const gap = gapSeasons(seasons);
  const gapNote = gap.length ? ` <span class="gap-note">${gap.length} earlier season${gap.length === 1 ? '' : 's'} unwatched</span>` : '';
  // Ended is on, yet a stored season hasn't aired: informational (§4.3); it changes nothing.
  const upcomingNote = show.ended && seasons.some(s => !s.skipped && !isReleasedRow(s, today))
    ? ' <span class="gap-note">Marked ended, but an upcoming season is listed</span>' : '';
  // F5 amendment (owner, 2026-10-13; display only): a show labelled "Caught up · Ended" or
  // "All seasons skipped" doesn't also show the "Up to date" pill. Up to date itself (its
  // calculation, the stats count, Currently Watching) is unchanged.
  const collection = isBrowseCollectionView(activeViewId);
  const stateLabel = item.endedExit ? 'ended' : item.allSkipped && (activeViewId === 'alltv' || collection) ? 'skipped' : null;
  const nextFor = card => (stateLabel === 'ended'
    ? `<span class="caught-ended">Caught up · Ended</span>${gapNote}`
    : stateLabel === 'skipped'
      ? '<span class="confirmed-lbl">All seasons skipped</span>'
      : upToDate
        ? upToDateNextLabel(upNext, card)
        : inProgress
          ? nextSeasonLabel(upNext, item.upNextReleased, card, true)
          : neutralNextLabel(upNext, item.upNextReleased, card)) + upcomingNote;
  const nextCell = nextFor(false), nextCard = nextFor(true);
  const upToDatePill = upToDate && !stateLabel ? ' <span class="status-pill s-caughtup">Up to date</span>' : '';
  const releaseOpts = { requireReleased: true, today };
  // All TV (Stage 4b): an expanded show also offers Match (an eligible row), Delete (a row
  // that isn't a built-in catalog entry; those have Skip / Keep) and Add season. S3: a collection's
  // show entry has the same (shows are edited in collections; films aren't).
  // D6 / S3-D1: the delete control is named by its effect: × in All TV, "Delete…" in a collection.
  const allTv = activeViewId === 'alltv' || collection;
  const cw = activeViewId === 'watching';
  const subOpts = r => ({ isNew: false, showMatch: allTv && isTmdbMatchEligible(r), showDelete: allTv && editPolicyOf(r).deleteEffect === 'delete',
    deleteName: `Delete ${r.season} of ${show.title} from your library`, deleteLabel: collection ? 'Delete…' : '',
    dateHtml: opts.dateHtml, requireReleased: true, today, showOf: key, cwOrder: cw });
  const addSeasonBtn = allTv ? `<button class="btn btn-link" data-action="add-season" onclick="event.stopPropagation(); openAddSeason('${keyArg}')">+ Add season…</button>` : '';
  // B2: the show-level shortcut names the season it marks (the up-next season, or the
  // earlier-seasons range's next one).
  const shortcutOpts = { ...releaseOpts, shortcutOf: show };
  const watchCell = inProgress ? seasonWatchControlHtml(upNext, { ...shortcutOpts, stopPropagation: true }, false) : '<span class="confirmed-lbl">—</span>';
  const expandBtn = opts.expandBtn ? opts.expandBtn(isExpanded) : derivedExpandBtnHtml(key, keyArg, item.title, isExpanded);
  // The focus hooks (B6): the show's row or card, and the section it is listed in.
  const section = cw ? (upToDate ? 'uptodate' : 'inprogress') : opts.section || 'all';
  const kindTag = opts.kindTag || '';
  const showAttrs = `data-item="${esc(key)}" data-show-row="${esc(key)}" data-row-section="${section}"`;
  const ofAttr = `data-show-of="${esc(key)}"`;

  if (cw) {
    const shortcut = inProgress ? seasonWatchControlHtml(upNext, { ...shortcutOpts, stopPropagation: true }, false) : '';
    const cells = upToDate
      ? `<td class="date-cell" colspan="3">${nextCell}</td>`
      : `<td class="date-cell">${nextCell}</td><td>${shortcut}</td><td class="card-date">${progressLabel}${progressBarHtml}</td>`;
    let row = `<tr class="show-group-row derived-show-row${dimClass}" ${showAttrs} onclick="toggleDerivedShow('${keyArg}', event)">
      <td>
        <div class="show-title-row">
          <div class="show-title-left">${titleHtml}</div>
          ${expandBtn}
        </div>
      </td>
      <td>${badges}</td>
      ${cells}
    </tr>`;
    if (isExpanded) row += `<tr class="sub-row show-actions-row" ${ofAttr}><td style="padding-left:28px" colspan="${derivedColspan()}" onclick="event.stopPropagation()">${showActionsHtml(item, keyArg, { state: true, progress: true })}</td></tr>`
      + seasons.map(r => seasonSubRowHtml(r, subOpts(r))).join('');

    // Phone card, top to bottom: title (expand button), season line, categories, progress,
    // the shortcut; expanded: the actions, then the seasons. A caught-up card shows its
    // categories and progress only when expanded.
    const meta = !upToDate
      ? `<div class="card-meta">${badges} <span class="card-date">${progressLabel}</span>${progressBarHtml}</div>`
      : isExpanded ? `<div class="card-meta">${badges} <span class="card-date">${showProgressText(seasons)}</span></div>` : '';
    const card = `<div class="item-card show-group-card${dimClass}" ${showAttrs}>
      <div class="card-top" onclick="toggleDerivedShow('${keyArg}', event)" style="cursor:pointer">
        <div class="card-title-block">
          <span class="card-title">${titleHtml}</span>
          <span class="card-season">${nextCard}</span>
        </div>
        ${expandBtn}
      </div>
      ${meta}
      ${inProgress ? `<div class="card-actions shortcut-actions" onclick="event.stopPropagation()">${shortcut}</div>` : ''}
      ${isExpanded ? `<div class="card-subseasons"><div class="card-subseason-row show-actions" onclick="event.stopPropagation()">${showActionsHtml(item, keyArg, { state: true })}</div>${seasons.map(r => seasonSubCardHtml(r, subOpts(r))).join('')}</div>` : ''}
    </div>`;
    return { row, card };
  }

  const actions = isExpanded ? showActionsHtml(item, keyArg) : '';
  let row = `<tr class="show-group-row derived-show-row${dimClass}" ${showAttrs} onclick="toggleDerivedShow('${keyArg}', event)">
      <td>
        <div class="show-title-row">
          <div class="show-title-left">${titleHtml}${kindTag}</div>
          ${expandBtn}
        </div>
      </td>
      <td>${badges}</td>
      <td class="date-cell">${nextCell}</td>
      <td><span class="state-action" data-action="status">${showStatusSelectHtml(show, { stopPropagation: true })}</span> <span class="state-action" data-action="priority">${prioritySelectHtml(show, 'show', { stopPropagation: true })}</span>${upToDatePill}</td>
      <td>${watchCell}</td>
      <td class="card-date">${progressLabel}${progressBarHtml}</td>
    </tr>`;
  if (isExpanded) row += `<tr class="sub-row show-actions-row" ${ofAttr}><td style="padding-left:28px" colspan="6" onclick="event.stopPropagation()">${actions}</td></tr>`
    + seasons.map(r => seasonSubRowHtml(r, subOpts(r))).join('')
    + (addSeasonBtn ? `<tr class="sub-row" ${ofAttr}><td style="padding-left:28px" colspan="6">${addSeasonBtn}</td></tr>` : '');

  const card = `<div class="item-card show-group-card${dimClass}" ${showAttrs}>
      <div class="card-top" onclick="toggleDerivedShow('${keyArg}', event)" style="cursor:pointer">
        <div class="card-title-block">
          <span class="card-title">${titleHtml}</span>${kindTag}
          <span class="card-season">${nextCard}</span>
        </div>
        ${expandBtn}
      </div>
      <div class="card-meta">
        ${badges}
        <span class="card-date">${progressLabel}</span>
        ${progressBarHtml}
      </div>
      <div class="card-actions" onclick="event.stopPropagation()">
        <span class="state-action" data-action="status">${showStatusSelectHtml(show)}</span> <span class="state-action" data-action="priority">${prioritySelectHtml(show, 'show')}</span>${upToDatePill}
        ${inProgress ? seasonWatchControlHtml(upNext, shortcutOpts, false) : ''}
      </div>
      ${isExpanded ? `<div class="card-subseasons"><div class="card-subseason-row show-actions" onclick="event.stopPropagation()">${actions}</div>${seasons.map(r => seasonSubCardHtml(r, subOpts(r))).join('')}${addSeasonBtn ? `<div class="card-subseason-row" ${ofAttr}>${addSeasonBtn}</div>` : ''}</div>` : ''}
    </div>`;

  return { row, card };
}

// An expanded show's own actions (B4/B5): Details, Show ended, the markers, and the
// earlier-seasons range (Watch earlier seasons; the chooser; Stop).
// opts.state (B6, Currently Watching): the status and priority selects come first, labelled
// (the row has none); opts.progress: a line of season progress. data-action marks each
// control for focus after a redraw.
function showActionsHtml(item, keyArg, opts = {}) {
  const { show, seasons } = item;
  const range = item.resume;
  const gap = gapSeasons(seasons);
  const parts = [];
  if (opts.state) {
    parts.push(`<label class="state-field" data-action="status"><span class="state-field-label">Status</span> ${showStatusSelectHtml(show)}</label>`,
      `<label class="state-field" data-action="priority"><span class="state-field-label">Priority</span> ${prioritySelectHtml(show, 'show')}</label>`);
  }
  if (opts.progress) parts.push(`<span class="show-progress-line">${showProgressText(seasons)}</span>`);
  parts.push(`<button class="btn btn-link" data-action="details" onclick="openDetails('show', '${keyArg}', this)">Details…</button>`,
    `<label class="ended-check" data-action="ended"><input type="checkbox"${show.ended ? ' checked' : ''} onchange="setShowStateById('${keyArg}', { ended: this.checked })"> Show ended</label>`);
  if (show.catalog_new) parts.push(`<button class="btn btn-link" data-action="dismiss-new" onclick="dismissShowNew('${keyArg}')">Dismiss “New”</button>`);
  if (show.status_review) parts.push(`<button class="btn btn-link" data-action="keep-status" onclick="keepCurrentStatus('show', '${keyArg}')">Keep current status</button>`);
  if (range) {
    const note = range.state === 'active' ? `Watching earlier seasons from ${esc(range.start ? range.start.season : '')}`
      : range.state === 'complete' ? 'Earlier seasons done' : 'Earlier-seasons range no longer applies; choose again or stop';
    parts.push(`<span class="gap-note">${note}</span> <button class="btn btn-link" data-action="stop-resume" onclick="stopResume('${keyArg}')">Stop watching earlier seasons</button>`);
  }
  if (gap.length && !(range && range.state === 'active')) {
    const label = show.status === 'watching' ? 'Watch earlier seasons…' : 'Start watching earlier seasons…';
    parts.push(`<button class="btn btn-link" data-action="open-resume" aria-expanded="${resumePickerFor === show.id}" onclick="openResumePicker('${keyArg}')">${label}</button>`);
    if (resumePickerFor === show.id) {
      parts.push(`<div class="resume-picker" role="group" aria-label="Start from">${gap.map(r =>
        `<button class="btn" data-action="resume-start-${esc(r.id)}" onclick="startResume('${keyArg}', '${esc(r.id)}')">Start from ${esc(r.season)}</button>`).join(' ')}</div>`);
    }
  }
  return `<div class="show-actions-inner${opts.state ? ' show-actions-state' : ''}">${parts.join(' ')}</div>`;
}

// What is next for an Up to date show, from what's stored in the list (no TMDB
// lookup): a future or TBA up-next season, or none listed. B6: it never says or implies
// that nothing has been announced or that a show isn't renewed.
function upToDateNextLabel(upNext, card = false) {
  if (!upNext) return `<span title="Based on the seasons stored in your list. New seasons are added with + Add (Refresh shows or Add season) or by Catalog updates.">No upcoming season listed</span>`;
  return nextSeasonLabel(upNext, false, card);
}

function renderComingSoon(today, keep) {
  const { dated, tba } = deriveComingSoon(derivedData.rows, tvShowsById, today);
  const shownDated = dated.filter(keep);
  const shownTba = tba.filter(keep);
  const in30 = new Date();
  in30.setDate(in30.getDate() + 30);
  const cutoff30 = localTodayStr(in30);

  // B8: dated seasons shown of every eligible dated season; of these, the next 30 days.
  const soon = shownDated.length ? ` · of these, ${shownDated.filter(r => r.date_sort <= cutoff30).length} in the next 30 days` : '';
  document.getElementById('statsRow').innerHTML = countLineHtml(countScoped(shownDated.length, dated.length, 'dated season', 'dated seasons') + soon);

  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  let html = '', cardHtml = '', lastMonth = '';
  shownDated.forEach(r => {
    const month = r.date_sort.substring(0, 7);
    if (month !== lastMonth) {
      const label = `${months[parseInt(month.substring(5, 7), 10) - 1] || ''} ${month.substring(0, 4)}`;
      html += `<tr class="year-group"><td colspan="${derivedColspan()}">${esc(label)}</td></tr>`;
      cardHtml += `<div class="card-year-group">${esc(label)}</div>`;
      lastMonth = month;
    }
    const out = comingSoonRowHtml(r, today, 'dated');
    html += out.row;
    cardHtml += out.card;
  });

  if (shownDated.length === 0) {
    const out = derivedEmptyHtml(dated.length === 0 ? 'Nothing with a confirmed date is coming up.' : 'No dated entries match your filters.', '2rem', dated.length ? filterEmptyClearHtml() : '');
    html += out.row;
    cardHtml += out.card;
  }

  if (shownTba.length > 0) {
    const section = derivedSectionHtml('tba', 'TBA', headingCount(shownTba.length, tba.length, 'season', 'seasons'));
    html += section.row;
    cardHtml += section.card;
    if (derivedSectionOpen.tba) {
      shownTba.forEach(r => {
        const out = comingSoonRowHtml(r, today, 'tba');
        html += out.row;
        cardHtml += out.card;
      });
    }
  }

  document.getElementById('tbody').innerHTML = html;
  document.getElementById('cardList').innerHTML = cardHtml;
  // The focus chain's listing (B6): season items, dated (no heading) and TBA (a toggle).
  return { sections: [
    { name: 'dated', shown: shownDated.length > 0, open: true, heading: false, keys: shownDated.map(r => r.id) },
    { name: 'tba', shown: shownTba.length > 0, open: !!derivedSectionOpen.tba, heading: true, keys: shownTba.map(r => r.id) }
  ] };
}

// Date details, the show's status as a label, and Skip only: Coming
// Soon is about availability, so there is no status menu, watch control or delete.
function comingSoonRowHtml(r, today, section = 'dated') {
  const item = seasonItemAttrs(r, section);
  const status = displayStatus(r);
  const show = showOfRow(r) || {};
  const rowClass = '';
  const chips = metadataChipsHtml(metadataOf(r), r.id, themeBadgeHtml(rowCatalogOf(r), r.theme, r.id));
  const todayTag = r.date_sort === today ? '<span class="today-tag">Today</span>' : '';
  const statusPill = `<span class="status-pill s-${status}" title="Show status">${esc(statusOptionLabel(status))}</span>`;
  const skip = seasonActionHtml('season-control', seasonSkipButtonHtml(r));
  const row = `<tr class="${rowClass}"${item}>
      <td tabindex="-1" data-primary="1">
        ${priorityMarkHtml(show.priority)}<span class="show-title">${esc(r.title)}</span>${priorityMarkHtml(show.priority, true)}
        <span class="season-lbl"> · ${esc(r.season)}</span>
        ${todayTag}
      </td>
      <td>${chips}</td>
      <td class="date-cell">${esc(r.display_date)}</td>
      <td>${statusPill}</td>
      <td>${skip}</td>
    </tr>`;
  const card = `<div class="item-card ${rowClass}"${item}>
      <div class="card-top">
        <div class="card-title-block" tabindex="-1" data-primary="1">
          <span class="card-title">${priorityMarkHtml(show.priority)}${esc(r.title)}${priorityMarkHtml(show.priority, true)}</span>
          <span class="card-season">${esc(r.season)}</span>
          ${todayTag}
        </div>
      </div>
      <div class="card-meta">
        ${chips}
        <span class="card-date">${esc(r.display_date)}</span>
      </div>
      <div class="card-actions">${statusPill} ${skip}</div>
    </div>`;
  return { row, card };
}

// ev: the click on a show's row or card header (B6). A click that started on a control in
// it (a button, select, checkbox, link, a filter pill) belongs to that control, so the row
// doesn't also toggle; the expand button calls this without an event.
function toggleDerivedShow(key, ev) {
  const target = ev && ev.target;
  if (target && typeof target.closest === 'function' && target.closest('button, select, input, label, a, textarea')) return;
  if (expandedShows.has(key)) expandedShows.delete(key);
  else expandedShows.add(key);
  renderTable();
}

// ─── Focus after a redraw (B6) ────────────────────────────────────────────────
// A redraw replaces the list's markup, so the focused control is gone. After an action
// redraw (expanding, a section toggle, a write, a reload) focus goes to the first of
// these that applies (the proposal's F-1 … F-7):
//   F-1 the same control; F-2 the show's new shortcut, else its item's main control; F-3 the
//   toggle of the collapsed section it moved into; F-4 the empty-state message when the
//   view lists nothing; F-5 the next (else previous) item still listed in its section;
//   F-6 its section's toggle or heading; F-7 the first section heading, else the first item.
// Only when focus was in the list (#tbody / #cardList) before the redraw. Filter redraws
// (Search, the filter controls, Back) keep focus where it is, and a filter pill keeps its
// own rule (render.js toggleFilterPill), even when the list becomes empty.
//
// Items (data-item): a show (Currently Watching, All TV Shows), whose main control is its
// expand button, or a season (Coming Soon, All TV Seasons), whose title takes focus from the
// page. Controls are found by identity (the item or season and data-action), never by position.
//
// The original action keeps its target across the redraws it causes (an optimistic redraw,
// then the answer or the rollback, or a reload): the page's one placement (focusPlacement in
// watchlist.html) remembers the record focus was moved for, until the owner does anything
// (placeFocus). A cancelled placement is final: nothing revives it.
const FOCUS_HOOKS = [['shortcut', 'data-shortcut-show'], ['action', 'data-action'], ['item', 'data-primary'],
  ['section', 'data-section'], ['empty', 'data-empty'], ['loading', 'data-loading']];

// A season row in Coming Soon and All TV Seasons as a focus item (B6).
function seasonItemAttrs(r, section) {
  return ` data-item="${esc(r.id)}" data-season-row="${esc(r.id)}" data-row-section="${section}"`;
}

function captureListFocus() {
  if (!documentHasFocus()) return null; // the owner is outside the app: nothing to carry back
  const owned = placedOrigin();
  if (owned) return owned; // still the page's placement: the original action's record
  const active = document.activeElement;
  if (!active || typeof active.closest !== 'function') return null;
  const container = ['tbody', 'cardList'].find(id => active.closest(`#${id}`));
  if (!container || active.closest('.filter-pill')) return null;
  // A loading message holds focus only for the page's own placement; once that placement is
  // cancelled, focus left on it is no new action to carry.
  if (active.closest('[data-loading]')) return null;
  const box = document.getElementById(container);
  const { key, hook } = focusHookOf(active);
  // The item's section and its neighbours in that section, in listed order.
  const items = [...box.querySelectorAll('[data-item]')];
  const own = key ? items.find(r => r.getAttribute('data-item') === key) : null;
  const section = own ? own.getAttribute('data-row-section') : null;
  const peers = items.filter(r => r.getAttribute('data-row-section') === section).map(r => r.getAttribute('data-item'));
  const at = peers.indexOf(key);
  return { container, key, section, hook,
    next: at >= 0 ? peers.slice(at + 1) : [], prev: at >= 0 ? peers.slice(0, at).reverse() : [] };
}

// What identifies a focused element in the list, the same in both layouts: its item (show or
// season) and its hook (shortcut, action, item's main control, section, message).
function focusHookOf(active) {
  const attrOf = (el, a) => (el ? el.getAttribute(a) : null);
  const itemEl = active.closest('[data-item], [data-show-of]');
  const key = attrOf(itemEl, 'data-item') || attrOf(itemEl, 'data-show-of');
  const seasonEl = active.closest('[data-season-row]');
  let hook = null;
  for (const [kind, attr] of FOCUS_HOOKS) {
    const el = active.closest(`[${attr}]`);
    if (el) { hook = { kind, value: el.getAttribute(attr) }; break; }
  }
  if (hook && hook.kind === 'action') { hook.item = key; hook.season = attrOf(seasonEl, 'data-season-row'); }
  if (hook && hook.kind === 'item') hook.value = key;
  return { key, hook };
}

// The target after a redraw, from what was recorded (rec) and what the view now lists
// (listing: { sections: [{ name, shown, open, heading, keys }] }). present(t) says whether
// target t is in the redrawn, visible list. Pure: no DOM.
function focusChainTarget(rec, listing, present) {
  if (!rec) return null;
  if (rec.hook && rec.hook.kind !== 'loading' && present(rec.hook)) return rec.hook; // F-1
  if (!listing) return null;
  const shown = listing.sections.filter(s => s.shown);
  const sectionOf = k => shown.find(s => s.keys.includes(k)) || null;
  const anyListed = shown.some(s => s.keys.length > 0);
  const item = k => ({ kind: 'item', value: k });
  const firstFallback = () => { // F-7: the first heading or toggle, else the first listed item
    const h = shown.find(s => s.heading);
    if (h) return { kind: 'section', value: h.name };
    const s = shown.find(x => x.open && x.keys.length);
    return s ? item(s.keys[0]) : { kind: 'empty' };
  };
  const sec = rec.key ? sectionOf(rec.key) : null;
  if (sec && sec.open) { // F-2
    const sc = { kind: 'shortcut', value: rec.key };
    return present(sc) ? sc : item(rec.key);
  }
  if (sec) return { kind: 'section', value: sec.name }; // F-3
  if (!anyListed) return { kind: 'empty' }; // F-4
  if (!rec.key) return firstFallback();
  for (const k of rec.next.concat(rec.prev)) { // F-5
    const s = sectionOf(k);
    if (s && s.name === rec.section) return s.open ? item(k) : { kind: 'section', value: s.name };
  }
  const own = shown.find(s => s.name === rec.section);
  if (own) return own.heading ? { kind: 'section', value: own.name } : firstFallback(); // F-6
  return firstFallback(); // F-7
}

// Shown on the page (not in a hidden layout or collapsed away); without layout (the offline
// harness) everything counts as shown.
function isRendered(el) {
  return !!el && (typeof el.getClientRects !== 'function' || el.getClientRects().length > 0);
}
// The list container to use: the one focus was in if it is still shown, else the other
// (the window may have crossed the phone width meanwhile); never a hidden layout.
function visibleListBox(preferred) {
  for (const id of [preferred, preferred === 'tbody' ? 'cardList' : 'tbody']) {
    const box = document.getElementById(id);
    if (box && typeof box.querySelector === 'function' && isRendered(box)) return box;
  }
  return null;
}

// The element for a target inside one list container.
function focusTargetElement(box, t) {
  if (!box || !t) return null;
  const q = sel => box.querySelector(sel);
  const v = x => JSON.stringify(String(x));
  const focusable = el => (!el ? null : el.matches('button, select, input, [tabindex]') ? el : el.querySelector('button, select, input, [tabindex]'));
  let el = null;
  if (t.kind === 'action') {
    el = t.season
      ? q(`[data-season-row=${v(t.season)}] [data-action=${v(t.value)}]`)
      : q(`[data-item=${v(t.item)}] [data-action=${v(t.value)}], [data-show-of=${v(t.item)}] [data-action=${v(t.value)}]`);
  } else if (t.kind === 'item') el = q(`[data-item=${v(t.value)}] [data-primary]`);
  else if (t.kind === 'empty') el = q('[data-empty]');
  else if (t.kind === 'loading') el = q('[data-loading]');
  else {
    const attr = { shortcut: 'data-shortcut-show', section: 'data-section' }[t.kind];
    if (attr) el = q(`[${attr}=${v(t.value)}]`);
  }
  el = focusable(el);
  return isRendered(el) ? el : null;
}

// The page has keyboard focus (the owner hasn't gone to another window or outside the app's
// frame); without a browser (the offline harness) it always has.
function documentHasFocus() {
  return typeof document.hasFocus !== 'function' || document.hasFocus();
}

// Moves focus to el for the action recorded in origin, and makes that the page's placement
// (focusPlacement, watchlist.html; the previous one ends). The placement is cancelled, for
// good, by anything that isn't the page's own doing: focus arriving anywhere else, a key,
// pointer or touch press anywhere (on el too: that starts a new action of the owner's own),
// or the window losing focus (the owner went outside the app). S3: also the page being hidden
// (as the S2 chooser's focus return), and a view change (tabs.js switchView ends it).
const PLACEMENT_ACTIONS = ['keydown', 'pointerdown', 'mousedown', 'touchstart'];
function placeFocus(el, origin) {
  if (!el || typeof el.focus !== 'function') return;
  endFocusPlacement();
  el.focus();
  if (document.activeElement !== el) return;
  const doc = el.ownerDocument || document;
  const win = doc.defaultView || null;
  const p = { el, origin, cancelled: false };
  const cancel = () => { p.cancelled = true; p.stop(); if (focusPlacement === p) focusPlacement = null; };
  const onFocusIn = e => { if (e.target !== el) cancel(); };
  const onHidden = () => { if (doc.visibilityState === 'hidden') cancel(); };
  p.stop = () => {
    if (typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('focusin', onFocusIn, true);
      doc.removeEventListener('visibilitychange', onHidden, true);
      PLACEMENT_ACTIONS.forEach(t => doc.removeEventListener(t, cancel, true));
    }
    if (win && typeof win.removeEventListener === 'function') { win.removeEventListener('blur', cancel); win.removeEventListener('resize', relocatePlacedFocus); }
  };
  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('focusin', onFocusIn, true);
    doc.addEventListener('visibilitychange', onHidden, true);
    PLACEMENT_ACTIONS.forEach(t => doc.addEventListener(t, cancel, true));
  }
  if (win && typeof win.addEventListener === 'function') { win.addEventListener('blur', cancel); win.addEventListener('resize', relocatePlacedFocus); }
  focusPlacement = p;
}

// The window was resized while the page's placement is held: if the placed element is no
// longer shown (the phone / desktop layouts swapped), move focus to the same control in the
// layout now shown, for the same action. A write whose answer comes without a redraw, or a
// reload still reading, then ends with focus where its action left it (correction batch 3).
function relocatePlacedFocus() {
  const p = focusPlacement;
  if (!p || p.cancelled || !documentHasFocus() || isRendered(p.el)) return;
  const active = document.activeElement;
  if (active && active !== p.el && active !== document.body && active !== document.documentElement) return;
  const { hook } = typeof p.el.closest === 'function' ? focusHookOf(p.el) : { hook: null };
  const box = visibleListBox(p.origin.container);
  const el = box && hook ? focusTargetElement(box, hook) : null;
  if (el) placeFocus(el, p.origin);
}
function endFocusPlacement() {
  if (focusPlacement) { focusPlacement.cancelled = true; focusPlacement.stop(); }
  focusPlacement = null;
}

// The record the page's placement still holds, or null. Held while focus is on the placed
// element, or (PV2-F2, and the same for a pending write) on the page body only because the
// browser took it off an element that left the layout (hidden by the phone / desktop switch,
// or removed). Any cancellation is final; focus on the body for any other reason never counts.
function placedOrigin() {
  const p = focusPlacement;
  if (!p || p.cancelled || !documentHasFocus()) return null;
  const active = document.activeElement;
  if (active === p.el) return p.origin;
  const onBody = !active || active === document.body || active === document.documentElement;
  return onBody && (!p.el.isConnected || !isRendered(p.el)) ? p.origin : null;
}
function focusIsPlaced(origin) {
  return !!origin && placedOrigin() === origin;
}
// One element of the visible list container (the loading message, Retry).
function placeListFocus(selector, origin) {
  if (!documentHasFocus()) return;
  const box = visibleListBox(origin.container);
  const el = box ? box.querySelector(selector) : null;
  if (isRendered(el)) placeFocus(el, origin);
}

function applyListFocus(rec, listing) {
  if (!rec || !documentHasFocus()) return; // never pull focus back from outside the app
  const box = visibleListBox(rec.container);
  if (!box) return;
  const t = focusChainTarget(rec, listing, x => !!focusTargetElement(box, x));
  // Never back to the page: the first visible section control, item or message.
  // (Section toggles are buttons; headings, item titles and messages take focus from the page.)
  const el = focusTargetElement(box, t)
    || [...box.querySelectorAll('[data-section], [data-primary], [data-empty]')].find(isRendered);
  if (el) placeFocus(el, rec);
}

function toggleDerivedSection(name) {
  derivedSectionOpen[name] = !derivedSectionOpen[name];
  renderTable();
}
