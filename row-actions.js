// ─── Actions ──────────────────────────────────────────────────────────────────
// The rows the visible controls came from: All Movies' films, a collection's rows (S3: its
// read of the library) or the open derived view's TV rows. Row actions PATCH by the row's real id.
function actionRows() {
  if (activeViewId === ALL_MOVIES_VIEW.id || isBrowseCollectionView(activeViewId)) return browseData?.rows || [];
  if (isBrowseView(activeViewId)) return [];
  return activeViewId ? derivedData?.rows || [] : [];
}

// S3: a collection edits its shows and their seasons; its films stay read-only until S4, so every
// film action refuses there and sends nothing.
function collectionFilmLocked(row) {
  return isBrowseCollectionView(activeViewId) && !!row && !isTvSeason(row);
}

// After a successful PATCH, copy the saved fields onto every other in-memory copy
// of that row (the derived view's rows, the browse view's rows), without a refetch.
// epoch: the restore epoch the request started in; an answer from before a restore
// never reaches the restored caches (Stage 4b).
function mirrorRowUpdate(id, fields, epoch) {
  if (epoch !== undefined && epoch !== orgEpoch) return false;
  const lists = [];
  if (derivedData?.rows) lists.push(derivedData.rows);
  if (browseData?.rows) lists.push(browseData.rows);
  lists.forEach(rows => rows.forEach(r => { if (r.id === id) Object.assign(r, fields); }));
  return true;
}

// An answer to a change sent before a restore arrived after it: its payload is
// set aside (nothing restored is overwritten) and what is open is read again.
// It doesn't say which happened last; nothing is resent. The notice says whether the
// reread succeeded (B4/B5: no claim before the read has finished).
async function staleAfterRestore(what) {
  const head = `${what} was sent before the restore and answered afterwards.`;
  const tail = 'this doesn’t show whether the change ran before or after the restore. Check it before changing it again.';
  showNotice(`${head} The list is being read again; ${tail}`);
  const ok = typeof reloadOpenView === 'function' ? await reloadOpenView() : null;
  showNotice(ok === false ? `${head} The list couldn’t be read again (use Retry); ${tail}`
    : ok === true ? `${head} The list has been read again; ${tail}` : `${head} ${tail.replace(/^t/, 'T')}`);
}

async function toggleWatch(id) {
  const row = actionRows().find(r => r.id === id);
  if (!row || collectionFilmLocked(row)) return;
  // A skipped film's Watched changes only as a status choice (B5 §4.2: never Skipped + Watched).
  if (!isTvSeason(row) && row.status === 'skipped') {
    showError(`“${row.title}” is Skipped, so Watched changes only through its status (To Watch, Watched or Skipped). Nothing was changed.`);
    renderTable();
    return;
  }
  const newVal = !row.watched;
  const epoch = orgEpoch;
  row.watched = newVal;
  // Tracked like a publication of the row (tmdb-match.js): no older read replaces it.
  const edit = typeof matchEditStart === 'function' ? matchEditStart('rows', LIBRARY_PARTITION, id, row) : null;
  renderTable();
  const origin = typeof placedOrigin === 'function' ? placedOrigin() : null; // this action's focus placement (S3, brief §7.2)
  try {
    if (isTvSeason(row)) {
      // The database also keeps the show's compatibility values in step.
      const saved = await sbRpc('set_season_watched', { p_row_id: id, p_watched: newVal });
      if (!mirrorRowUpdate(id, saved || { watched: newVal }, epoch)) staleAfterRestore(`“${row.title}” · watched`);
      if (epoch === orgEpoch) showSaved();
    } else {
      // A film's Watched button is a watched-only change (O4): status, priority, markers unchanged.
      row.watched = !newVal;
      if (typeof matchEditEnd === 'function') matchEditEnd(edit);
      await sendFilmState(row, { watched: newVal });
      return;
    }
  } catch(e) {
    if (epoch !== orgEpoch) staleAfterRestore(`“${row.title}” · watched`);
    else if (orgErrorInfo(e).kind !== 'database') {
      // S3-D2 B: no clear answer. It may or may not have been saved: the page claims neither, never
      // resends it, and reads the open view again to show what is stored (tv-shows.js reportStateFailure).
      row.watched = !newVal;
      if (typeof matchEditEnd === 'function') matchEditEnd(edit); // ended first, so the reread can publish
      await reportStateFailure(e, epoch, origin);
      return;
    } else {
      row.watched = !newVal;
      renderTable();
      showError(e.message);
    }
  }
  if (typeof matchEditEnd === 'function') matchEditEnd(edit);
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
  return `<select class="status-select s-film-${state}" onchange="setStatus('${r.id}', this.value, this)" aria-label="Status of ${esc(r.title)}">${prompt}${options}</select>`;
}

// Selector → To Watch / Watched / Skipped (O1, one guarded call). Choosing the state already
// stored sends nothing, unless Needs status review is on (the choice resolves it). Leaving a
// watched film for Skipped, or a Skipped + Watched pair for To Watch, asks first because it
// clears Watched; Cancel sends nothing.
async function setStatus(id, state, selectEl) {
  const row = actionRows().find(r => r.id === id);
  if (collectionFilmLocked(row)) return;
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
  if (!row || collectionFilmLocked(row) || isTvSeason(row) || !PRIORITIES.includes(priority)) return;
  if (row.priority === priority) { renderTable(); return; }
  await sendFilmState(row, { priority });
}

// One guarded film change (library_set_film_state_b45). Shown at once; put back if
// refused; an answer from before a restore is set aside; an unconfirmed answer is never
// resent (the list is read again instead).
async function sendFilmState(row, changes) {
  const expected = filmStateOf(row);
  const before = { status: row.status, watched: row.watched, priority: row.priority, catalog_new: row.catalog_new,
    status_review: row.status_review, legacy_status: row.legacy_status };
  const epoch = orgEpoch;
  if (changes.state) Object.assign(row, { status: changes.state === 'skipped' ? 'skipped' : 'confirmed', watched: changes.state === 'watched',
    catalog_new: false, status_review: false, legacy_status: null });
  if ('watched' in changes) row.watched = changes.watched;
  if (changes.priority) row.priority = changes.priority;
  const what = `“${row.title}” · ${'watched' in changes ? 'watched' : changes.priority ? 'priority' : 'status'}`;
  const edit = typeof matchEditStart === 'function' ? matchEditStart('rows', LIBRARY_PARTITION, row.id, row) : null;
  renderTable();
  try {
    const res = await sbRpc('library_set_film_state_b45', { p_item_id: row.id, p_expected: expected, p_changes: changes });
    if (!mirrorRowUpdate(row.id, (res && res.row) || {}, epoch)) staleAfterRestore(what);
    else showSaved();
  } catch (e) {
    if (epoch !== orgEpoch) staleAfterRestore(what);
    else {
      Object.assign(row, before);
      if (stateNeedsReread(e)) {
        if (typeof matchEditEnd === 'function') matchEditEnd(edit);
        await reportStateFailure(e, epoch);
        return;
      }
      showError(stateErrorText(e));
    }
  }
  if (typeof matchEditEnd === 'function') matchEditEnd(edit);
  renderTable();
}

// × in All TV and All Movies, Delete… in a collection (library.js decides Skip or Delete by catalog governance).
function delRow(id) {
  if (activeViewId) return delRowInView(id);
}

async function toggleWatchWith(rowId, tag, checked) {
  const row = actionRows().find(r => r.id === rowId);
  if (!row || collectionFilmLocked(row)) return;
  if (!watchWithUsable()) { showError('Watch-with choices aren’t loaded, so nothing was changed. Try again once they are.'); renderTable(); return; }
  const current = new Set(row.watch_with || []);
  if (checked) current.add(tag); else current.delete(tag);
  const updated = [...current];
  const previous = row.watch_with || [];
  const epoch = orgEpoch;
  row.watch_with = updated;
  const edit = typeof matchEditStart === 'function' ? matchEditStart('rows', LIBRARY_PARTITION, rowId, row) : null;
  try {
    await sbFetch('PATCH', `${TABLE}?id=eq.${rowId}`, { watch_with: updated });
    if (!mirrorRowUpdate(rowId, { watch_with: updated }, epoch)) { staleAfterRestore(`“${row.title}” · watch with`); if (typeof matchEditEnd === 'function') matchEditEnd(edit); return; }
    showSaved();
    renderTable();
  } catch(e) {
    if (epoch !== orgEpoch) { staleAfterRestore(`“${row.title}” · watch with`); if (typeof matchEditEnd === 'function') matchEditEnd(edit); return; }
    row.watch_with = previous;
    renderTable();
    // An archived choice (archived since this page read the choices): say so and read them again.
    const dbMessage = typeof orgErrorInfo === 'function' ? (orgErrorInfo(e).message || String(e.message)) : String(e.message);
    if (/watch_with_archived/.test(dbMessage)) {
      const label = (dbMessage.match(/watch_with_archived: "([^"]*)"/) || [])[1] || 'That choice';
      showError(`“${label}” is archived, so it can’t be added. Nothing was changed; the watch-with choices are being read again.`);
      if (typeof retryOrgRefresh === 'function') retryOrgRefresh();
      if (typeof matchEditEnd === 'function') matchEditEnd(edit);
      return;
    }
    showError(e.message);
  }
  if (typeof matchEditEnd === 'function') matchEditEnd(edit);
}
