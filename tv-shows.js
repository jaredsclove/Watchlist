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

function noteTvShows(shows) {
  (shows || []).forEach(s => tvShowsById.set(s.id, s));
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
// What the show's next season is: the range's first season while it is active,
// otherwise the normal up next.
function effectiveUpNext(show, seasons) {
  const range = resumeRange(show, seasons);
  if (range && range.state === 'active') return range.sequence[0];
  return upNextSeason(seasons);
}

// ─── Controls ─────────────────────────────────────────────────────────────────
function statusOptionLabel(status) {
  return SHOW_STATUS_LABELS[status] || status;
}
// The label without its symbol (“To Watch”, “Watching”, “Skipped”), for running text.
function plainStatusLabel(status) {
  return String(statusOptionLabel(status)).replace(/^[▶✕✓★] /, '');
}
function priorityLabel(p) {
  return PRIORITY_LABELS[p] || 'Normal';
}

// High: a star before the title, with an accessible label; Normal: nothing; Low: a quiet
// text label after the title (after: true).
function priorityMarkHtml(priority, after = false) {
  if (priority === 'high' && !after) return '<span class="priority-high" role="img" aria-label="High priority" title="High priority">★</span> ';
  if (priority === 'low' && after) return ' <span class="priority-low" title="Low priority">Low</span>';
  return '';
}
// The markers: Ended (shows), New from catalog, Needs status review.
function stateTagsHtml(rec, kind) {
  return (kind === 'show' && rec.ended ? ' <span class="state-tag ended-tag" title="You marked this show as ended">Ended</span>' : '')
    + (rec.catalog_new ? ' <span class="state-tag new-tag" title="Added by a catalog update">New</span>' : '')
    + (rec.status_review ? ' <span class="state-tag review-tag-b45" title="Restored from an older backup whose status couldn’t be carried over: choose a status or keep this one">Review status</span>' : '');
}

// The show-level status control. While Needs status review is on, the control starts on
// a prompt, so choosing any status — the current one included — is an explicit choice.
function showStatusSelectHtml(show, opts = {}) {
  if (!show) return '<span class="confirmed-lbl">—</span>';
  const stop = opts.stopPropagation;
  const prompt = show.status_review ? '<option value="" selected disabled>Choose a status…</option>' : '';
  const options = TV_STATUS_ORDER.map(s => `<option value="${s}"${!show.status_review && s === show.status ? ' selected' : ''}>${statusOptionLabel(s)}</option>`).join('');
  return `<select class="status-select show-status-select s-${show.status}" aria-label="Status of ${esc(show.title)}" title="Show status — applies to every season of ${esc(show.title)}"${stop ? ' onclick="event.stopPropagation()"' : ''} onchange="${stop ? 'event.stopPropagation(); ' : ''}setShowStateById('${show.id}', { status: this.value })">${prompt}<optgroup label="Applies to all seasons of ${esc(show.title)}">${options}</optgroup></select>`;
}
// Priority (shows and films): kind 'show' | 'film'.
function prioritySelectHtml(rec, kind, opts = {}) {
  const stop = opts.stopPropagation;
  const fn = kind === 'show' ? `setShowStateById('${rec.id}', { priority: this.value })` : `setFilmPriority('${rec.id}', this.value)`;
  return `<select class="priority-select p-${rec.priority}" aria-label="Priority of ${esc(rec.title)}" title="Priority"${stop ? ' onclick="event.stopPropagation()"' : ''} onchange="${stop ? 'event.stopPropagation(); ' : ''}${fn}">${PRIORITIES.map(p =>
    `<option value="${p}"${p === rec.priority ? ' selected' : ''}>${PRIORITY_LABELS[p]}</option>`).join('')}</select>`;
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
// to what is stored sends nothing, except a status choice while Needs status review is on
// (it resolves the review). Shown at once; put back if refused; an answer from before a
// restore is set aside; an unknown outcome is never resent.
async function setShowStateById(showId, changes) {
  if (activeViewId === ALL_MOVIES_VIEW.id) return; // All Movies lists no show (S3: collections edit shows)
  const show = tvShowsById.get(showId);
  if (!show || !changes) return;
  const explicitReview = 'status' in changes && show.status_review;
  const differs = Object.keys(changes).some(k => (k === 'ended' ? !!show.ended !== !!changes.ended : show[k] !== changes[k]));
  if (!differs && !explicitReview) { renderTable(); return; }
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

// O6: keep the current status (Needs status review cleared, the old status no longer kept).
async function keepCurrentStatus(kind, id) {
  // All Movies: films; a collection: shows only (S3; its films stay read-only).
  if (isBrowseView(activeViewId) && activeViewId !== ALL_MOVIES_VIEW.id && kind !== 'show') return;
  const rec = kind === 'show' ? tvShowsById.get(id) : actionRows().find(r => r.id === id);
  if (!rec || !rec.status_review) return;
  await runWrite(`“${rec.title}” · status review`, async () => {
    const expected = kind === 'show' ? showStateOf(rec) : filmStateOf(rec);
    try {
      const res = await sbRpc('library_dismiss_review_b45', { p_kind: kind, p_id: id, p_expected: expected });
      if (kind === 'show' && res && res.show) Object.assign(rec, res.show);
      else if (res && res.row) mirrorRowUpdate(id, res.row);
      showSaved();
    } catch (e) {
      await reportStateFailure(e);
      return;
    }
    renderTable();
  }, { list: true });
}

// O5: dismiss New from catalog for the records given ([{kind, id}]), all or nothing.
async function dismissCatalogNew(list) {
  // A collection dismisses only shows (S3; its films stay read-only).
  if (isBrowseCollectionView(activeViewId) && (list || []).some(x => x.kind !== 'show')) return;
  if (!list || !list.length) return;
  if (list.length > 1 && !confirm(`Dismiss “New from catalog” on the ${list.length} records shown? Their status and priority don’t change.`)) return;
  await runWrite('New from catalog', async () => {
    try {
      await sbRpc('library_dismiss_catalog_new_b45', { p_expected: list.map(x => ({ kind: x.kind, id: x.id })) });
      list.forEach(x => {
        const rec = x.kind === 'show' ? tvShowsById.get(x.id) : null;
        if (rec) { rec.catalog_new = false; if (rec.legacy_status === 'pending') rec.legacy_status = null; }
        else mirrorRowUpdate(x.id, { catalog_new: false });
      });
      showSaved();
    } catch (e) {
      await reportStateFailure(e);
      return;
    }
    renderTable();
  }, { list: true });
}
function dismissShowNew(id) { dismissCatalogNew([{ kind: 'show', id }]); }
// O5, all: the New-from-catalog records the open view shows — exactly that set, in one call
// (the database refuses the whole call if it no longer matches). Offered from two records up.
function dismissAllNewHtml(records) {
  shownNewRecords = records;
  if (records.length < 2) return { row: '', card: '' };
  const text = `${records.length} of the records shown are New from catalog.`;
  const btn = `<button class="btn btn-link" onclick="dismissShownNew()">Dismiss “New” on these ${records.length}</button>`;
  return { row: `<tr class="empty-row"><td colspan="6">${esc(text)} ${btn}</td></tr>`, card: `<div class="empty-row" style="padding:0.5rem 0">${esc(text)} ${btn}</div>` };
}
function dismissShownNew() {
  if (shownNewRecords.length >= 2) return dismissCatalogNew(shownNewRecords.slice());
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
