// ─── First-class TV shows (TV-show migration, Phase 3: show status authoritative) ──
// A TV season row belongs to one show in tv_shows (row.show_id). The show holds
// the workflow status (On List, High Priority, Watching, Complete, Pending,
// Maybe, Skipped); the season row holds watched, skipped, its identity, dates
// and metadata. The season row's own `status` column is now only a compatibility
// copy the database writes for rollback: nothing in this file reads it. Films,
// including True Crime / Docs films and static "Film" rows, keep their row-level
// status and are never linked to a show. Shows are loaded into tvShowsById
// (page state in watchlist.html) together with the rows that show them.

const TV_STATUS_ORDER = ['watching', 'highpriority', 'confirmed', 'complete', 'pending', 'maybe', 'skipped'];

// The one partition tracked reads and edits use (tmdb-match.js): the whole
// library. Show lists and rows are never divided by where they were stored.
const LIBRARY_PARTITION = 'library';

// A TV season: media_type 'tv', or a row without an identity that isn't a film
// (every row is a film or a linked TV season; the database checks it).
function isTvSeason(r) {
  return !!r && (r.media_type === 'tv' || (r.media_type == null && (r.season || '') !== 'Film'));
}

function showOfRow(r) {
  return r && r.show_id ? tvShowsById.get(r.show_id) || null : null;
}

// The status shown for any row: its show's status for a TV season, the row's own
// status for a film.
function displayStatus(r) {
  if (!isTvSeason(r)) return r.status;
  const show = showOfRow(r);
  return show ? show.status : 'confirmed';
}

// Out of the to-watch list: a skipped season, any season of a Skipped show, or a skipped film.
function isOffList(r) {
  if (!isTvSeason(r)) return r.status === 'skipped';
  return !!r.skipped || displayStatus(r) === 'skipped';
}

function noteTvShows(shows) {
  (shows || []).forEach(s => tvShowsById.set(s.id, s));
}

// Every show, paginated and exact-count checked. Show reads are tracked
// (tmdb-match.js): each publishes only if it is the newest read of the list in the
// current restore epoch and no edit of a show is pending or newer, so a read that
// finishes late never replaces newer shows, and each can satisfy a refresh after a Match.
async function loadAllTvShows() {
  const read = typeof matchReadStart === 'function' ? matchReadStart('shows', '*') : null;
  try {
    const shows = await fetchAllRows('tv_shows');
    publishAllTvShows(read, shows);
    if (read) matchReadSettle(read, null);
  } catch (e) {
    if (read) matchReadSettle(read, e);
    throw e;
  }
}

// Replaces the whole show list; nothing if a newer full read published or the epoch
// changed. While a show edit is pending, or one ended after this read started, the
// shows already on the page are kept (that newer state wins) and this read covers nothing.
function publishAllTvShows(read, shows) {
  if (read && !matchMayPublishShows(read, '*')) return false;
  let next = new Map(shows.map(s => [s.id, s]));
  if (read) {
    const e = matchPublished.shows[LIBRARY_PARTITION];
    const newer = !!e && (e.id > read.id || matchEditPending('shows', LIBRARY_PARTITION));
    if (newer) next = new Map(tvShowsById);
    // A show list kept because of an edit isn't covered by this read.
    read.keptRows = new Set(newer && e.kind === 'edit' ? [LIBRARY_PARTITION] : []);
    matchNotePublished('shows', '*', read);
  }
  tvShowsById = next;
  return true;
}

// ─── Up next and Up to date (the approved rules; tests/tv-model-reference.js) ─
// Seasons are sorted with compareSeasons. The main progression is the numbered
// seasons (all seasons for a specials-only title). Progress is the furthest
// watched season of the main list; the remaining seasons are the unwatched,
// non-skipped ones after it; up next is the first of those (it may be future or
// TBA). Earlier unwatched seasons stay listed but never move progress back.
function mainSeasonList(sorted) {
  const numbered = sorted.filter(r => !isSpecialRow(r));
  return numbered.length ? numbered : sorted;
}

function remainingSeasons(seasons) {
  const main = mainSeasonList([...seasons].sort(compareSeasons));
  let furthest = -1;
  main.forEach((r, i) => { if (r.watched) furthest = i; });
  return main.slice(furthest + 1).filter(r => !r.watched && !r.skipped);
}

function upNextSeason(seasons) {
  return remainingSeasons(seasons)[0] || null;
}

// A Watching show is Up to date when none of its remaining seasons has aired yet.
function isShowUpToDate(seasons, today) {
  return !remainingSeasons(seasons).some(r => isReleasedRow(r, today));
}

// ─── Controls ─────────────────────────────────────────────────────────────────
function statusOptionLabel(status) {
  return { confirmed: '✓ On List', highpriority: '⭐ High Priority', watching: '▶ Watching', complete: '◆ Complete',
    pending: '⏳ Pending', maybe: '? Maybe Later', skipped: '✕ Skipped' }[status] || status;
}

// The show-level status control. Options show the plain status; the tooltip and the
// option group say it applies to every season of the show.
function showStatusSelectHtml(show, opts = {}) {
  if (!show) return '<span class="confirmed-lbl">—</span>';
  const stop = opts.stopPropagation;
  const options = TV_STATUS_ORDER.map(s => `<option value="${s}"${s === show.status ? ' selected' : ''}>${statusOptionLabel(s)}</option>`).join('');
  return `<select class="status-select show-status-select s-${show.status}" title="Show status — applies to every season of ${esc(show.title)}"${stop ? ' onclick="event.stopPropagation()"' : ''} onchange="${stop ? 'event.stopPropagation(); ' : ''}setShowStatusById('${show.id}', this.value)"><optgroup label="Applies to all seasons of ${esc(show.title)}">${options}</optgroup></select>`;
}

// Skip / Keep for one season (never deletes anything).
function seasonSkipButtonHtml(r, opts = {}) {
  const stop = opts.stopPropagation ? 'event.stopPropagation(); ' : '';
  return r.skipped
    ? `<button class="skip-btn kept" onclick="${stop}setSeasonSkipped('${r.id}', false)" title="Put this season back on the list">↩ Keep</button>`
    : `<button class="skip-btn" onclick="${stop}setSeasonSkipped('${r.id}', true)" title="Skip this season (it stays on the list, hidden)">Skip</button>`;
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function setShowStatusById(showId, status) {
  if (isBrowseView(activeViewId)) return; // read-only views never write
  const show = tvShowsById.get(showId);
  if (!show || show.status === status) return;
  const old = show.status;
  const epoch = orgEpoch;
  show.status = status;
  const edit = typeof matchEditStart === 'function' ? matchEditStart('shows', LIBRARY_PARTITION, LIBRARY_PARTITION) : null;
  renderTable();
  try {
    const saved = await sbRpc('set_show_status', { p_show_id: showId, p_status: status });
    // An answer from before a restore never reaches the restored shows (Stage 4b).
    if (epoch !== orgEpoch) { if (typeof matchEditEnd === 'function') matchEditEnd(edit); staleAfterRestore(`“${show.title}” · show status`); return; }
    if (saved) Object.assign(show, saved);
    showSaved();
  } catch(e) {
    if (epoch !== orgEpoch) { if (typeof matchEditEnd === 'function') matchEditEnd(edit); staleAfterRestore(`“${show.title}” · show status`); return; }
    show.status = old;
    showError(e.message);
  }
  if (typeof matchEditEnd === 'function') matchEditEnd(edit);
  renderTable();
}

async function setSeasonSkipped(id, skipped) {
  const row = actionRows().find(r => r.id === id);
  if (!row || !isTvSeason(row)) return;
  const old = !!row.skipped;
  if (old === skipped) return;
  const epoch = orgEpoch;
  row.skipped = skipped;
  const edit = typeof matchEditStart === 'function' ? matchEditStart('rows', LIBRARY_PARTITION, id, row) : null;
  renderTable();
  try {
    const saved = await sbRpc('set_season_skipped', { p_row_id: id, p_skipped: skipped });
    if (!mirrorRowUpdate(id, saved || { skipped }, epoch)) { if (typeof matchEditEnd === 'function') matchEditEnd(edit); staleAfterRestore(`“${row.title}” · ${row.season}`); return; }
    showSaved();
  } catch(e) {
    if (epoch !== orgEpoch) { if (typeof matchEditEnd === 'function') matchEditEnd(edit); staleAfterRestore(`“${row.title}” · ${row.season}`); return; }
    row.skipped = old;
    showError(e.message);
  }
  if (typeof matchEditEnd === 'function') matchEditEnd(edit);
  renderTable();
}

function showNotice(msg) {
  const el = document.getElementById('banner');
  if (el) el.innerHTML = msg ? `<div class="banner">${esc(msg)}</div>` : '';
}
