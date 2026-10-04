async function setShowStatus(title, status) {
  const td = tabData[activeTabId];
  if (!td) return;
  const rows = td.rows.filter(r => r.title === title);
  if (rows.length === 0) return;

  const previousStatuses = rows.map(r => r.status);
  rows.forEach(r => { r.status = status; });
  renderTable();

  try {
    await sbFetch('PATCH',
      `${TABLE}?collection=eq.${encodeURIComponent(activeTabId)}&title=eq.${encodeURIComponent(title)}`,
      { status }
    );
    showSaved();
  } catch(e) {
    rows.forEach((r, i) => { r.status = previousStatuses[i]; });
    renderTable();
    showError(e.message);
  }
}


// ─── Actions ──────────────────────────────────────────────────────────────────
// The rows the visible controls came from: the open derived view's cross-TV rows,
// or the active collection tab's rows. Row actions PATCH by the row's real id
// either way.
function actionRows() {
  if (activeViewId) return derivedData?.rows || [];
  return tabData[activeTabId]?.rows || [];
}

// After a successful PATCH, copy the saved fields onto every other in-memory copy
// of that row (the derived view's rows and any loaded tab), so the source tab's
// cache stays correct without a refetch or a re-seed.
function mirrorRowUpdate(id, fields) {
  const lists = Object.values(tabData).map(td => td?.rows || []);
  if (derivedData?.rows) lists.push(derivedData.rows);
  lists.forEach(rows => rows.forEach(r => { if (r.id === id) Object.assign(r, fields); }));
}

async function toggleWatch(id) {
  const row = actionRows().find(r => r.id === id);
  if (!row) return;
  const newVal = !row.watched;
  row.watched = newVal;
  renderTable();
  try {
    await sbFetch('PATCH', `${TABLE}?id=eq.${id}`, { watched: newVal });
    mirrorRowUpdate(id, { watched: newVal });
    showSaved();
  } catch(e) {
    row.watched = !newVal;
    renderTable();
    showError(e.message);
  }
}

async function setStatus(id, status, selectEl) {
  const row = actionRows().find(r => r.id === id);
  if (!row) return;
  const old = row.status;
  row.status = status;
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
    mirrorRowUpdate(id, { status });
    showSaved();
    // full re-render to update watch button availability and stats
    renderTable();
  } catch(e) {
    row.status = old;
    renderTable();
    showError(e.message);
  }
}

async function delRow(id) {
  if (!confirm('Remove this entry?')) return;
  const td = tabData[activeTabId];
  if (!td) return; // collection tabs only; derived views have no delete control
  const idx = td.rows.findIndex(r => r.id === id);
  if (idx === -1) return;
  const row = td.rows[idx];

  // If this row came from the tab's built-in default list, a hard delete would
  // just get silently re-created the next time the tab loads (loadTab reseeds
  // any default key missing from the database). So for defaults, "delete" instead
  // sets status to 'skipped' — same reversible mechanism already used everywhere
  // else in the app (hidden from the default view, visible under "Skipped", and
  // restorable via the existing "↩ Keep" control). Non-default items (anything
  // added manually or pulled from TMDB) have nothing to reseed from, so they keep
  // the exact hard-delete behavior as before.
  const col = COLLECTIONS.find(c => c.id === row.collection);
  const isDefaultItem = col && Array.isArray(col.defaults) && col.defaults.some(d => d.k === row.item_key);

  if (isDefaultItem) {
    const previousStatus = row.status;
    row.status = 'skipped';
    renderTable();
    try {
      await sbFetch('PATCH', `${TABLE}?id=eq.${id}`, { status: 'skipped' });
      showSaved();
    } catch(e) {
      row.status = previousStatus;
      renderTable();
      showError(e.message);
    }
    return;
  }

  const [removed] = td.rows.splice(idx, 1);
  renderTable();
  try {
    if (isTvSeasonRow(removed.collection, removed.media_type, removed.season)) {
      // delete_tv_season also removes the show once its last season is gone.
      // A season already deleted elsewhere counts as deleted, like a plain DELETE.
      try {
        await sbRpc('delete_tv_season', { p_row_id: id });
      } catch(e) {
        if (!String(e.message).includes('not_found:')) throw e;
      }
    } else {
      await sbFetch('DELETE', `${TABLE}?id=eq.${id}`, null);
    }
    showSaved();
  } catch(e) {
    td.rows.splice(idx, 0, removed);
    renderTable();
    showError(e.message);
  }
}

function toggleAdd() {
  addOpen = !addOpen;
  document.getElementById('addForm').style.display = addOpen ? 'block' : 'none';
  document.getElementById('addToggleBtn').textContent = addOpen ? '✕ Cancel' : '+ Add entry';
}

function toggleFilters() {
  const el = document.getElementById('filtersRow');
  el.classList.toggle('collapsed');
  const chevron = document.getElementById('filterToggleChevron');
  if (chevron) chevron.textContent = el.classList.contains('collapsed') ? '▾' : '▴';
}

async function addEntry() {
  // The tab this entry is for, captured before the await below: the user may
  // switch tabs or views while the insert is in flight.
  const collectionId = activeTabId;
  if (!collectionId) return;
  const title  = document.getElementById('nTitle').value.trim();
  const season = document.getElementById('nSeason').value.trim() || 'Season 1';
  const theme  = document.getElementById('nTheme').value;
  const date   = document.getElementById('nDate').value.trim();
  if (!title || !date) { alert('Please fill in title and premiere date.'); return; }
  const key = title.toLowerCase().trim() + '|' + season.toLowerCase().trim();
  // Client-side duplicate check against every loaded row in this collection
  // (legacy or TMDB-identified). Keeps manual-add behavior independent of the
  // database's (collection, item_key) uniqueness, which will later apply only
  // to rows with tmdb_id IS NULL.
  if ((tabData[collectionId]?.rows || []).some(r => r.item_key === key)) {
    showError('This title and season is already on your list.');
    return;
  }
  const ds  = parseDate(date);
  const newRow = {
    collection: collectionId,
    item_key: key,
    title, season, theme,
    display_date: date,
    date_sort: ds,
    watched: false,
    status: 'confirmed'
  };
  try {
    let inserted = null;
    if (isTvSeasonRow(collectionId, null, season)) {
      // A TV season joins its show (by show key) through add_tv_seasons.
      const alreadyListed = await addTvSeasonRows(collectionId, [newRow], rows => { inserted = rows; });
      if (alreadyListed > 0) { showError('This title and season is already on your list.'); return; }
    } else {
      inserted = await sbFetch('POST', TABLE, [newRow]);
    }
    const td = tabData[collectionId];
    if (inserted && inserted[0] && td) {
      td.rows.push(inserted[0]);
      td.rows.sort((a,b) => a.date_sort.localeCompare(b.date_sort));
    }
    showSaved();
    if (activeTabId !== collectionId) return;
    document.getElementById('nTitle').value = '';
    document.getElementById('nDate').value = '';
    document.getElementById('nSeason').value = 'Season 1';
    toggleAdd();
    renderTable();
  } catch(e) {
    if (isDuplicateKeyError(e)) {
      showError('This title and season is already on your list.');
    } else {
      showError(e.message);
    }
  }
}

async function toggleWatchWith(rowId, tag, checked) {
  const row = actionRows().find(r => r.id === rowId);
  if (!row) return;
  const current = new Set(row.watch_with || []);
  if (checked) current.add(tag); else current.delete(tag);
  const updated = [...current];
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
    showError(e.message);
  }
}
