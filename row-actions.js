// ─── Actions ──────────────────────────────────────────────────────────────────
// The rows the visible controls came from: All Movies' films, a collection's rows (S3: its
// read of the library) or the open derived view's TV rows. Row actions PATCH by the row's real id.
function actionRows() {
  if (activeViewId === ALL_MOVIES_VIEW.id || isBrowseCollectionView(activeViewId)) return browseData?.rows || [];
  if (isBrowseView(activeViewId)) return [];
  return activeViewId ? derivedData?.rows || [] : [];
}

// After a confirmed change, copy the saved fields onto every in-memory copy of that row
// (the derived view's rows, the browse view's rows), without a refetch.
function mirrorRowUpdate(id, fields) {
  const lists = [];
  if (derivedData?.rows) lists.push(derivedData.rows);
  if (browseData?.rows) lists.push(browseData.rows);
  lists.forEach(rows => rows.forEach(r => { if (r.id === id) Object.assign(r, fields); }));
}

async function toggleWatch(id) {
  const row = actionRows().find(r => r.id === id);
  if (!row) return;
  // A skipped film's Watched changes only as a status choice (B5 §4.2: never Skipped + Watched).
  if (!isTvSeason(row) && row.status === 'skipped') {
    showError(`“${row.title}” is Skipped, so Watched changes only through its status (To Watch, Watched or Skipped). Nothing was changed.`);
    renderTable();
    return;
  }
  const newVal = !row.watched;
  // A film's Watched button is a watched-only change (O4): status, priority, markers unchanged.
  if (!isTvSeason(row)) { await sendFilmState(row, { watched: newVal }); return; }
  await runWrite(`“${row.title}” · watched`, async () => {
    row.watched = newVal;
    renderTable();
    try {
      // The database also keeps the show's compatibility values in step.
      const saved = await sbRpc('set_season_watched', { p_row_id: id, p_watched: newVal });
      mirrorRowUpdate(id, saved || { watched: newVal });
      showSaved();
    } catch(e) {
      row.watched = !newVal;
      if (orgErrorInfo(e).kind !== 'database') {
        // S3-D2 B: no clear answer. It may or may not have been saved: the page claims neither, never
        // resends it, and reads the open view again to show what is stored (tv-shows.js reportStateFailure).
        await reportStateFailure(e);
        return;
      }
      renderTable();
      showError(e.message);
    }
  }, { list: true });
}

// ─── The film contract (B5 §4.2) ──────────────────────────────────────────────
// A film's state as the page shows it (the expected values of a guarded change).
function filmStateOf(r) {
  return { status: r.status, watched: !!r.watched, priority: r.priority, catalog_new: !!r.catalog_new, status_review: !!r.status_review };
}
// The film status control: To Watch / Watched / Skipped over the stored status and
// watched flag; a Skipped + Watched pair is shown as such. While Needs status review is
// on, the control starts on a prompt, so any choice (the current one included) is explicit.
function filmStatusSelectHtml(r) {
  const state = filmViewState(r);
  const prompt = r.status_review ? '<option value="" selected disabled>Choose a status…</option>' : '';
  const states = state === 'pair' ? ['pair', 'to_watch', 'watched', 'skipped'] : ['to_watch', 'watched', 'skipped'];
  const options = states.map(v => `<option value="${v}"${!r.status_review && v === state ? ' selected' : ''}${v === 'pair' ? ' disabled' : ''}>${FILM_STATE_LABELS[v]}</option>`).join('');
  return `<select class="status-select s-film-${state}${r.status_review ? ' status-needs-choice' : ''}" onchange="setStatus('${r.id}', this.value, this)" aria-label="Status of ${esc(r.title)}">${prompt}${options}</select>`;
}

// Selector → To Watch / Watched / Skipped (O1, one guarded call). Choosing the state already
// stored sends nothing, unless Needs status review is on (the choice resolves it). Leaving a
// watched film for Skipped, or a Skipped + Watched pair for To Watch, asks first because it
// clears Watched; Cancel sends nothing.
async function setStatus(id, state, selectEl) {
  const row = actionRows().find(r => r.id === id);
  if (!row || isTvSeason(row) || !['to_watch', 'watched', 'skipped'].includes(state)) { renderTable(); return; }
  const current = filmViewState(row);
  if (state === current && !row.status_review) { renderTable(); return; }
  if (current === 'pair' && state === 'skipped' && !row.status_review) { renderTable(); return; }
  // (Skipped chosen on a pair is reached only under review: an explicit choice, which clears Watched.)
  const clearsWatched = (current === 'watched' && state === 'skipped') || (current === 'pair' && state !== 'watched');
  if (clearsWatched && !confirm(current === 'watched' ? `Skip “${row.title}”? This also clears Watched.`
    : state === 'skipped' ? `Keep “${row.title}” Skipped? This clears Watched.` : `Mark “${row.title}” To Watch? This clears Watched.`)) {
    renderTable();
    return;
  }
  await sendFilmState(row, { state });
}

// Priority (O2): status, watched and markers unchanged; an existing pair stays a pair.
async function setFilmPriority(id, priority) {
  const row = actionRows().find(r => r.id === id);
  if (!row || isTvSeason(row) || !PRIORITIES.includes(priority)) return;
  if (row.priority === priority) { renderTable(); return; }
  await sendFilmState(row, { priority });
}

// One guarded film change (library_set_film_state_b45). Shown at once; put back if
// refused; an unconfirmed answer is never resent (the list is read again instead).
async function sendFilmState(row, changes) {
  const what = `“${row.title}” · ${'watched' in changes ? 'watched' : changes.priority ? 'priority' : 'status'}`;
  await runWrite(what, async () => {
    const expected = filmStateOf(row);
    const before = { status: row.status, watched: row.watched, priority: row.priority, catalog_new: row.catalog_new,
      status_review: row.status_review, legacy_status: row.legacy_status };
    if (changes.state) Object.assign(row, { status: changes.state === 'skipped' ? 'skipped' : 'confirmed', watched: changes.state === 'watched',
      catalog_new: false, status_review: false, legacy_status: null });
    if ('watched' in changes) row.watched = changes.watched;
    if (changes.priority) row.priority = changes.priority;
    renderTable();
    try {
      const res = await sbRpc('library_set_film_state_b45', { p_item_id: row.id, p_expected: expected, p_changes: changes });
      mirrorRowUpdate(row.id, (res && res.row) || {});
      showSaved();
    } catch (e) {
      Object.assign(row, before);
      if (stateNeedsReread(e)) { await reportStateFailure(e); return; }
      showError(stateErrorText(e));
    }
    renderTable();
  }, { list: true });
}

// × in All TV and All Movies, Delete… in a collection (library.js decides Skip or Delete by catalog governance).
function delRow(id) {
  if (activeViewId) return delRowInView(id);
}

async function toggleWatchWith(rowId, tag, checked) {
  const row = actionRows().find(r => r.id === rowId);
  if (!row) return;
  if (!watchWithUsable()) { showError('Watch-with choices aren’t loaded, so nothing was changed. Try again once they are.'); renderTable(); return; }
  const current = new Set(row.watch_with || []);
  if (checked) current.add(tag); else current.delete(tag);
  const updated = [...current];
  await runWrite(`“${row.title}” · watch with`, async () => {
    const previous = row.watch_with || [];
    row.watch_with = updated;
    try {
      await sbFetch('PATCH', `${TABLE}?id=eq.${rowId}`, { watch_with: updated });
      mirrorRowUpdate(rowId, { watch_with: updated });
      showSaved();
      renderTable();
    } catch(e) {
      row.watch_with = previous;
      renderTable();
      // An archived choice (archived since this page read the choices): say so and read them again.
      const dbMessage = typeof orgErrorInfo === 'function' ? (orgErrorInfo(e).message || String(e.message)) : String(e.message);
      if (/watch_with_archived/.test(dbMessage)) {
        const label = (dbMessage.match(/watch_with_archived: "([^"]*)"/) || [])[1] || 'That choice';
        showError(`“${label}” is archived, so it can’t be added. Nothing was changed; the watch-with choices are being read again.`);
        if (typeof retryOrgRefresh === 'function') await retryOrgRefresh();
        return;
      }
      showError(e.message);
    }
  }, { list: true });
}
