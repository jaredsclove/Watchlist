// ─── Actions ──────────────────────────────────────────────────────────────────
// The rows the visible controls came from: All Movies' films or the open derived
// view's TV rows. Row actions PATCH by the row's real id. The read-only collection
// views have none, so no row action can act there.
function actionRows() {
  if (activeViewId === ALL_MOVIES_VIEW.id) return browseData?.rows || [];
  if (isBrowseView(activeViewId)) return [];
  return activeViewId ? derivedData?.rows || [] : [];
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
// It doesn't say which happened last; nothing is resent.
function staleAfterRestore(what) {
  showNotice(`${what} was sent before the restore and answered afterwards. The list has been read again; this doesn’t show whether the change ran before or after the restore. Check it before changing it again.`);
  if (typeof reloadOpenView === 'function') reloadOpenView();
}

async function toggleWatch(id) {
  const row = actionRows().find(r => r.id === id);
  if (!row) return;
  const newVal = !row.watched;
  const epoch = orgEpoch;
  row.watched = newVal;
  // Tracked like a publication of the row (tmdb-match.js): no older read replaces it.
  const edit = typeof matchEditStart === 'function' ? matchEditStart('rows', LIBRARY_PARTITION, id, row) : null;
  renderTable();
  try {
    if (isTvSeason(row)) {
      // The database also keeps the show's compatibility values in step.
      const saved = await sbRpc('set_season_watched', { p_row_id: id, p_watched: newVal });
      if (!mirrorRowUpdate(id, saved || { watched: newVal }, epoch)) staleAfterRestore(`“${row.title}” · watched`);
    } else {
      await sbFetch('PATCH', `${TABLE}?id=eq.${id}`, { watched: newVal });
      if (!mirrorRowUpdate(id, { watched: newVal }, epoch)) staleAfterRestore(`“${row.title}” · watched`);
    }
    if (epoch === orgEpoch) showSaved();
  } catch(e) {
    if (epoch !== orgEpoch) staleAfterRestore(`“${row.title}” · watched`);
    else {
      row.watched = !newVal;
      renderTable();
      showError(e.message);
    }
  }
  if (typeof matchEditEnd === 'function') matchEditEnd(edit);
}

// Row-level status: films only. A TV season's status is its show's (setShowStatusById).
async function setStatus(id, status, selectEl) {
  const row = actionRows().find(r => r.id === id);
  if (!row || isTvSeason(row)) return;
  const old = row.status;
  const epoch = orgEpoch;
  row.status = status;
  const edit = typeof matchEditStart === 'function' ? matchEditStart('rows', LIBRARY_PARTITION, id, row) : null;
  // update select styling immediately
  if (selectEl) {
    selectEl.className = `status-select s-${status}`;
  }
  // update row/card opacity immediately (works for both desktop <tr> and mobile .item-card)
  const container = selectEl?.closest('tr, .item-card');
  if (container) {
    const dimClass = status==='skipped'?'row-skipped':status==='maybe'?'row-maybe':'';
    if (container.tagName === 'TR') {
      container.className = dimClass;
    } else {
      container.className = `item-card ${dimClass}`;
    }
  }
  try {
    await sbFetch('PATCH', `${TABLE}?id=eq.${id}`, { status });
    if (!mirrorRowUpdate(id, { status }, epoch)) staleAfterRestore(`“${row.title}” · status`);
    else {
      showSaved();
      // full re-render to update watch button availability and stats
      renderTable();
    }
  } catch(e) {
    if (epoch !== orgEpoch) staleAfterRestore(`“${row.title}” · status`);
    else {
      row.status = old;
      renderTable();
      showError(e.message);
    }
  }
  if (typeof matchEditEnd === 'function') matchEditEnd(edit);
}

// × in All TV and All Movies (library.js decides Skip or Delete by catalog governance).
function delRow(id) {
  if (activeViewId) return delRowInView(id);
}

function toggleFilters() {
  const el = document.getElementById('filtersRow');
  el.classList.toggle('collapsed');
  const chevron = document.getElementById('filterToggleChevron');
  if (chevron) chevron.textContent = el.classList.contains('collapsed') ? '▾' : '▴';
}

async function toggleWatchWith(rowId, tag, checked) {
  const row = actionRows().find(r => r.id === rowId);
  if (!row) return;
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
