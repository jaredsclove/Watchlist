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

function isTvSeason(r) {
  return !!r && isTvSeasonRow(r.collection, r.media_type, r.season);
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

// Replaces one collection's shows (after its rows were read or seeded).
async function loadTvShows(collectionId) {
  const shows = await sbFetch('GET', `tv_shows?collection=eq.${encodeURIComponent(collectionId)}&select=*`, null);
  for (const [id, s] of tvShowsById) if (s.collection === collectionId) tvShowsById.delete(id);
  noteTvShows(shows);
}

// Every show, paginated and exact-count checked (the derived views).
async function loadAllTvShows() {
  const shows = await fetchAllRows('tv_shows');
  tvShowsById = new Map(shows.map(s => [s.id, s]));
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

// The show-level status control: clearly scoped to the whole show.
function showStatusSelectHtml(show, opts = {}) {
  if (!show) return '<span class="confirmed-lbl">—</span>';
  const stop = opts.stopPropagation;
  const options = TV_STATUS_ORDER.map(s => `<option value="${s}"${s === show.status ? ' selected' : ''}>Show: ${statusOptionLabel(s)}</option>`).join('');
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
  const show = tvShowsById.get(showId);
  if (!show || show.status === status) return;
  const old = show.status;
  show.status = status;
  renderTable();
  try {
    const saved = await sbRpc('set_show_status', { p_show_id: showId, p_status: status });
    if (saved) Object.assign(show, saved);
    showSaved();
  } catch(e) {
    show.status = old;
    showError(e.message);
  }
  renderTable();
}

async function setSeasonSkipped(id, skipped) {
  const row = actionRows().find(r => r.id === id);
  if (!row || !isTvSeason(row)) return;
  const old = !!row.skipped;
  if (old === skipped) return;
  row.skipped = skipped;
  renderTable();
  try {
    const saved = await sbRpc('set_season_skipped', { p_row_id: id, p_skipped: skipped });
    mirrorRowUpdate(id, saved || { skipped });
    showSaved();
  } catch(e) {
    row.skipped = old;
    showError(e.message);
  }
  renderTable();
}

// Results of add_tv_seasons calls (see addTvSeasonRows): what to tell the user.
// All requested seasons already listed → "Already on your list."; a mix → counts;
// a Complete show that got a genuinely new season is back On List.
function tvAddOutcomeMessages(outcome) {
  const { inserted, alreadyListed, rejected, reopened } = outcome;
  const review = outcome.review || [];
  const notes = [];
  if (review.length) notes.push(tvReviewMessage(review));
  if (inserted === 0 && alreadyListed > 0 && rejected === 0 && !review.length) notes.push('Already on your list.');
  else if ((alreadyListed > 0 || rejected > 0) && !(inserted === 0 && review.length)) {
    const parts = [`Added ${inserted} season${inserted === 1 ? '' : 's'}`];
    if (alreadyListed > 0) parts.push(`${alreadyListed} already on your list`);
    if (rejected > 0) parts.push(`${rejected} not added because an entry with the same title and season is already on your list`);
    notes.push(parts.join('; ') + '.');
  }
  const reopenedNote = reopened.length
    ? `${reopened.map(t => `"${t}"`).join(', ')} ${reopened.length === 1 ? 'was' : 'were'} Complete and got a new season, so ${reopened.length === 1 ? 'it is' : 'they are'} back On List.`
    : '';
  return { warning: notes.join(' '), notice: reopenedNote };
}

// Seasons of a TMDB-matched built-in show that weren't added, for a person to review.
function tvReviewMessage(review) {
  const parts = review.map(x => x.reason === 'enriched_show_label'
    ? `"${x.season}"${x.title ? ` of "${x.title}"` : ''} (the show is matched to TMDB, so only a plain "Season N" can be added automatically)`
    : `"${x.season}"${x.title ? ` of "${x.title}"` : ''} (that TMDB season is already on your list under another entry)`);
  return `Not added — needs review: ${parts.join('; ')}.`;
}

function showTvAddOutcome(outcome) {
  const { warning, notice } = tvAddOutcomeMessages(outcome);
  if (warning) showError(warning);
  if (notice) showNotice(notice);
}

function showNotice(msg) {
  const el = document.getElementById('banner');
  if (el) el.innerHTML = msg ? `<div class="banner">${esc(msg)}</div>` : '';
}
