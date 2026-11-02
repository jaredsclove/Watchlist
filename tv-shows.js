// ─── First-class TV shows (TV-show migration, Phase 3: show status authoritative) ──
// A TV season row belongs to one show in tv_shows (row.show_id). The show holds
// the viewing status (B4/B5: To Watch — stored 'confirmed' — Watching, Skipped), its
// priority, Show ended, the New from catalog and Needs status review markers, its
// categorized metadata and its earlier-seasons resume range; the season row holds
// watched, skipped, its identity, dates and its original label (theme). The season row's own `status` column is now only a compatibility
// copy the database writes for rollback: nothing in this file reads it. Films,
// including True Crime / Docs films and static "Film" rows, keep their row-level
// status and are never linked to a show. Shows are loaded into tvShowsById
// (page state in watchlist.html) together with the rows that show them.

const TV_STATUS_ORDER = ['confirmed', 'watching', 'skipped'];

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


// The show list, read with every view (derived-views.js, browse-views.js). A read publishes
// only if it is the newest one started and no change overlapped it (write-lane.js readFresh),
// so a read that finishes late never replaces newer shows. Returns whether it published.
let showsReadSeq = 0;
function startShowsRead() {
  return { seq: ++showsReadSeq, stamp: readStamp() };
}
function publishAllTvShows(read, shows) {
  if (read.seq !== showsReadSeq || !readFresh(read.stamp)) return false;
  tvShowsById = new Map(shows.map(s => [s.id, s]));
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

// ─── Currently Watching: Ended exit, all-skipped, the earlier-seasons range (§4.7) ──
// The main progression, sorted; the last of its non-skipped seasons (stored, released or
// not); the gap: unwatched, non-skipped main seasons before the furthest watched one.
function mainSeasons(seasons) {
  return mainSeasonList([...seasons].sort(compareSeasons));
}
function gapSeasons(seasons) {
  const main = mainSeasons(seasons);
  let furthest = -1;
  main.forEach((r, i) => { if (r.watched) furthest = i; });
  return main.slice(0, Math.max(furthest, 0)).filter(r => !r.watched && !r.skipped);
}
// Every stored season skipped (specials included); not a claim that anything was watched.
function allSeasonsSkipped(seasons) {
  return seasons.length > 0 && seasons.every(r => r.skipped);
}
// Show ended, at least one non-skipped main season, and nothing left after the furthest
// watched one (all watched, or the last reached with earlier seasons unwatched).
function isEndedExit(show, seasons) {
  return !!show && !!show.ended && mainSeasons(seasons).some(r => !r.skipped) && remainingSeasons(seasons).length === 0;
}
// The fixed range (start inclusive, boundary exclusive, both stored): every unwatched,
// non-skipped main season ordered at or after the start and before the boundary,
// evaluated now. An endpoint that isn't a main season of the show, or a start that no
// longer precedes the boundary, gives an empty (inert) range.
function resumeRange(show, seasons) {
  if (!show || !show.resume_start_season_id || !show.resume_end_season_id) return null;
  const main = mainSeasons(seasons);
  const a = main.findIndex(r => r.id === show.resume_start_season_id);
  const b = main.findIndex(r => r.id === show.resume_end_season_id);
  if (a < 0 || b < 0 || a >= b) return { start: main[a] || null, sequence: [], state: 'invalid' };
  const sequence = main.slice(a, b).filter(r => !r.watched && !r.skipped);
  return { start: main[a], sequence, state: sequence.length ? 'active' : 'complete' };
}

// ─── Controls ─────────────────────────────────────────────────────────────────
function statusOptionLabel(status) {
  return SHOW_STATUS_LABELS[status] || status;
}
// The label without its symbol (“To Watch”, “Watching”, “Skipped”), for running text.
function plainStatusLabel(status) {
  return String(statusOptionLabel(status)).replace(/^[▶✕✓★] /, '');
}

// High: a star before the title, with an accessible label; Normal: nothing; Low: a quiet
// text label after the title (after: true).
function priorityMarkHtml(priority, after = false) {
  if (priority === 'high' && !after) return '<span class="priority-high" role="img" aria-label="High priority" title="High priority">★</span> ';
  if (priority === 'low' && after) return ' <span class="priority-low" title="Low priority">Low</span>';
  return '';
}
// The marker: Ended (shows).
function stateTagsHtml(rec, kind) {
  return (kind === 'show' && rec.ended ? ' <span class="state-tag ended-tag" title="You marked this show as ended">Ended</span>' : '')
    + (kind === 'show' && typeof cuEndedFlagHtml === 'function' ? cuEndedFlagHtml(rec) : '')
}

// The show-level status control.
function showStatusSelectHtml(show, opts = {}) {
  if (!show) return '<span class="confirmed-lbl">—</span>';
  const stop = opts.stopPropagation;
  const options = TV_STATUS_ORDER.map(s => `<option value="${s}"${s === show.status ? ' selected' : ''}>${statusOptionLabel(s)}</option>`).join('');
  return `<select class="status-select show-status-select s-${show.status}" aria-label="Status of ${esc(show.title)}" title="Show status — applies to every season of ${esc(show.title)}"${stop ? ' onclick="event.stopPropagation()"' : ''} onchange="${stop ? 'event.stopPropagation(); ' : ''}setShowStateById('${show.id}', { status: this.value })"><optgroup label="Applies to all seasons of ${esc(show.title)}">${options}</optgroup></select>`;
}
// Priority (shows and films; kind 'show' | 'film'), in the row's ⋯ menu. Choosing closes the menu.
function prioritySelectHtml(rec, kind) {
  const fn = kind === 'show' ? `setShowStateById('${rec.id}', { priority: this.value })` : `setFilmPriority('${rec.id}', this.value)`;
  return `<select class="priority-select p-${rec.priority}" aria-label="Priority of ${esc(rec.title)}" title="Priority" onchange="closeRowMenu(this); ${fn}">${PRIORITIES.map(p =>
    `<option value="${p}"${p === rec.priority ? ' selected' : ''}>${PRIORITY_LABELS[p]}</option>`).join('')}</select>`;
}
// A show row's ⋯ (the show's priority). It sits at the far right of the title area, apart from the
// expand button before the title; a click in it never expands the row (toggleDerivedShow).
function showMenuHtml(show, keyArg) {
  return `<span class="more-cell"><button type="button" class="more-btn" data-action="more" aria-expanded="false" onclick="toggleMorePopover('${keyArg}', this)" title="Priority" aria-label="${esc(`More for ${show.title}`)}">⋯</button>
        <div class="more-popover" id="more-popover-${esc(show.id)}" style="display:none"><div class="popover-section-label">Priority</div><span class="state-action" data-action="priority">${prioritySelectHtml(show, 'show')}</span></div></span>`;
}

// Skip / Keep for one season (never deletes anything).
function seasonSkipButtonHtml(r, opts = {}) {
  const stop = opts.stopPropagation ? 'event.stopPropagation(); ' : '';
  return r.skipped
    ? `<button class="skip-btn kept" onclick="${stop}setSeasonSkipped('${r.id}', false)" title="Put this season back on the list">↩ Keep</button>`
    : `<button class="skip-btn" onclick="${stop}setSeasonSkipped('${r.id}', true)" title="Skip this season (it stays on the list, hidden)">Skip</button>`;
}

// ─── Actions ──────────────────────────────────────────────────────────────────
// The show's state as the page shows it (the expected values of a guarded change).
function showStateOf(show) {
  return { status: show.status, priority: show.priority, ended: !!show.ended, catalog_new: !!show.catalog_new, status_review: !!show.status_review };
}

// A guarded change of a show's state (library_set_show_state_b45): changes is any of
// { status } (an explicit viewing-status choice), { priority }, { ended }. A choice equal
// to what is stored sends nothing. Shown at once; put back if refused; an answer from before a
// restore is set aside; an unknown outcome is never resent.
async function setShowStateById(showId, changes) {
  if (activeViewId === ALL_MOVIES_VIEW.id) return; // All Movies lists no show (S3: collections edit shows)
  const show = tvShowsById.get(showId);
  if (!show || !changes) return;
  const differs = Object.keys(changes).some(k => (k === 'ended' ? !!show.ended !== !!changes.ended : show[k] !== changes[k]));
  if (!differs) { renderTable(); return; }
  const what = `“${show.title}” · ${'status' in changes ? 'show status' : 'priority' in changes ? 'priority' : 'Show ended'}`;
  await runWrite(what, async () => {
    const expected = showStateOf(show);
    const before = { ...show };
    Object.assign(show, changes);
    if ('status' in changes) Object.assign(show, { catalog_new: false, status_review: false, legacy_status: null });
    renderTable();
    try {
      const res = await sbRpc('library_set_show_state_b45', { p_show_id: showId, p_expected: expected, p_changes: changes });
      if (res && res.show) Object.assign(show, res.show);
      showSaved();
    } catch(e) {
      Object.keys(show).forEach(k => { if (!(k in before)) delete show[k]; });
      Object.assign(show, before);
      if (stateNeedsReread(e)) { await reportStateFailure(e); return; }
      showError(stateErrorText(e));
    }
    renderTable();
  }, { list: true });
}

// ─── A refused or unconfirmed state change (every B4/B5 action) ───────────────
// A refusal changed nothing. An answer that never came (or can't be read) is reported as
// not confirmed and is never resent. When the page's copy is what was wrong (the record
// changed, went away, or no longer allows the change) or the outcome is unknown, the open
// view is read again (inside the change's write lane) and the message says whether that
// read succeeded.
const STALE_STATE_CODES = ['target_changed', 'target_missing', 'invalid_range', 'invalid_state'];
function stateUnconfirmed(e) {
  return orgErrorInfo(e).kind !== 'database';
}
function stateNeedsReread(e) {
  const info = orgErrorInfo(e);
  return info.kind !== 'database' || STALE_STATE_CODES.includes(info.code);
}
// The words for the failure itself (no claim about reading the list again).
function stateErrorText(e) {
  const info = orgErrorInfo(e);
  if (info.kind !== 'database') return `This change wasn’t confirmed (${info.message}): it may or may not have been saved, and it won’t be sent again.`;
  // (The database's own sentence: for Dismiss all it states how many of the records shown changed.)
  if (info.code) return orgRefusalText(info).replace(/ Look at (it|the list) again\.$/, '');
  return `${info.message} Nothing was changed.`;
}
// What the reread did, appended to the failure's words.
function rereadText(ok) {
  return ok === true ? ' The list has been read again; look at it again.'
    : ok === false ? ' The list couldn’t be read again, so what is shown may be out of date; use Retry.' : '';
}
// Shows the failure, reads the open view again when that helps and shows the failure again
// with the reread's result (a view read clears the banner). Returns the reread's result
// (true / false / null when none was made or it was superseded).
async function reportStateFailure(e) {
  const text = stateErrorText(e);
  showError(text);
  if (!stateNeedsReread(e) || typeof reloadOpenView !== 'function') { renderTable(); return null; }
  const ok = await reloadOpenView();
  showError(text + rereadText(ok));
  return ok ?? null;
}

// O9: watch earlier seasons. resumePicker names the show whose gap seasons are offered.
function openResumePicker(showId) {
  resumePickerFor = resumePickerFor === showId ? null : showId;
  renderTable();
}
async function startResume(showId, startId) {
  const show = tvShowsById.get(showId);
  const seasons = actionRows().filter(r => r.show_id === showId); // the open view's rows (a collection's too, S3)
  if (!show) return;
  const main = mainSeasons(seasons);
  let furthest = -1;
  main.forEach((r, i) => { if (r.watched) furthest = i; });
  const boundary = main[furthest];
  if (!boundary || !gapSeasons(seasons).some(r => r.id === startId)) return;
  const setWatching = show.status !== 'watching';
  if (setWatching && !confirm(`Start watching earlier seasons of “${show.title}”? This sets the status to Watching.`)) return;
  await sendResume(show, startId, boundary.id, setWatching);
}
async function stopResume(showId) {
  const show = tvShowsById.get(showId);
  if (!show || !show.resume_start_season_id) return;
  await sendResume(show, null, null, false);
}
async function sendResume(show, startId, endId, setWatching) {
  if (activeViewId === ALL_MOVIES_VIEW.id) return; // a show action (TV views and, since S3, collections)
  await runWrite(`“${show.title}” · earlier seasons`, async () => {
    const expected = { status: show.status, resume_start_season_id: show.resume_start_season_id || null, resume_end_season_id: show.resume_end_season_id || null };
    try {
      const res = await sbRpc('library_set_resume_b45', { p_show_id: show.id, p_expected: expected, p_start: startId, p_end: endId, p_set_watching: setWatching });
      if (res && res.show) Object.assign(show, res.show);
      resumePickerFor = null;
      if (detailsDialog) detailsDialog.picker = false;
      showSaved();
    } catch (e) {
      resumePickerFor = null;
      await reportStateFailure(e);
      if (typeof renderDetails === 'function' && detailsDialog) renderDetails();
      return;
    }
    renderTable();
    if (typeof renderDetails === 'function' && detailsDialog) renderDetails();
  }, { list: true });
}

async function setSeasonSkipped(id, skipped) {
  const row = actionRows().find(r => r.id === id);
  if (!row || !isTvSeason(row)) return;
  const old = !!row.skipped;
  if (old === skipped) return;
  await runWrite(`“${row.title}” · ${row.season}`, async () => {
    row.skipped = skipped;
    renderTable();
    try {
      const saved = await sbRpc('set_season_skipped', { p_row_id: id, p_skipped: skipped });
      mirrorRowUpdate(id, saved || { skipped });
      showSaved();
    } catch(e) {
      row.skipped = old;
      if (orgErrorInfo(e).kind !== 'database') {
        // S3-D2 B: no clear answer. It may or may not have been saved: the page claims neither, never
        // resends it, and reads the open view again to show what is stored.
        await reportStateFailure(e);
        return;
      }
      showError(e.message);
    }
    renderTable();
  }, { list: true });
}

function showNotice(msg) {
  const el = document.getElementById('banner');
  if (el) el.innerHTML = msg ? `<div class="banner">${esc(msg)}</div>` : '';
}
