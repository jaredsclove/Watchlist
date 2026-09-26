async function openPullCollection(rowId, collectionId, collectionName) {
  // scroll the TMDB panel into view and show loading state
  cancelTMDBPreview();
  const previewEl = document.getElementById('tmdbPreview');
  const resultsEl = document.getElementById('tmdbResults');
  if (!previewEl) return;
  resultsEl.innerHTML = '';
  document.getElementById('tmdbQuery').value = '';
  previewEl.innerHTML = `<div class="tmdb-loading">Loading ${esc(collectionName)}…</div>`;
  previewEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

  try {
    const data = await tmdbFetch(`/collection/${collectionId}`);
    const movies = (data.parts || []).slice().sort((a,b) => (a.release_date||'9999').localeCompare(b.release_date||'9999'));
    const existingRows = tabData[activeTabId]?.rows || [];

    const rowsHtml = movies.map(m => {
      const key = `${m.title.toLowerCase().trim()}|film`;
      const alreadyAdded = isAlreadyAdded(existingRows, { itemKey: key, mediaType: 'movie', tmdbId: m.id });
      const date = m.release_date ? formatDisplayDate(m.release_date) : 'TBA';
      return `<div class="tmdb-season-row ${alreadyAdded?'already-added':''}">
        <input type="checkbox" ${alreadyAdded?'disabled':'checked'} data-movie-id="${m.id}" id="pull_${m.id}">
        <span class="tmdb-season-name">${esc(m.title)}</span>
        <span class="tmdb-season-meta">${esc(date)}</span>
        ${alreadyAdded ? '<span class="tmdb-already-tag">Already added</span>' : ''}
      </div>`;
    }).join('');

    // collectionName (cleaned) is for display; store TMDB's own collection name
    window.__pullCollectionData = { collectionId, collectionName, tmdbCollectionName: data.name || collectionName, movies };

    previewEl.innerHTML = `
      <div class="tmdb-preview">
        <div class="tmdb-preview-header">
          <div class="tmdb-preview-title">${esc(collectionName)}</div>
        </div>
        ${rowsHtml || '<div class="tmdb-no-results">No other movies found in this collection.</div>'}
        <div class="tmdb-preview-actions">
          <button class="btn btn-accent" onclick="addPulledCollectionMovies()">Add selected</button>
          <button class="btn" onclick="cancelTMDBPreview()">Cancel</button>
        </div>
      </div>
    `;
  } catch(e) {
    previewEl.innerHTML = `<div class="tmdb-no-results">Failed to load collection: ${esc(e.message)}</div>`;
  }
}

async function addPulledCollectionMovies() {
  const data = window.__pullCollectionData;
  if (!data) return;
  const isMoviesTab = COLLECTIONS.find(c => c.id === activeTabId)?.isMovieTab;
  const checkboxes = document.querySelectorAll('#tmdbPreview input[type="checkbox"][data-movie-id]');
  const moviesById = {};
  data.movies.forEach(m => moviesById[m.id] = m);
  const seenTmdbIds = new Set();

  const toInsert = [];
  for (const cb of checkboxes) {
    if (!cb.checked || cb.disabled) continue;
    const movieId = parseInt(cb.dataset.movieId, 10);
    const summary = moviesById[movieId];
    if (!summary) continue;
    // Dedupe by tmdbId, not by title/item_key — same defensive pattern as
    // addPulledPersonMovies. This is an additional layer in front of the
    // database's own uniqueness enforcement, not a replacement for it —
    // it only prevents the same movie appearing twice within THIS pending
    // batch before the insert call is made.
    if (seenTmdbIds.has(movieId)) continue;
    seenTmdbIds.add(movieId);
    // fetch full details for genre/runtime accuracy, same as a normal add
    let details;
    try { details = await tmdbFetch(`/movie/${movieId}`); } catch(e) { continue; }
    const network = isMoviesTab
      ? ((details.genres && details.genres[0]?.name) || 'Film')
      : ((details.production_companies && details.production_companies[0]?.name) || 'Film');
    const key = `${summary.title.toLowerCase().trim()}|film`;
    const displayDate = details.release_date ? formatDisplayDate(details.release_date) : 'TBA';
    const dateSort = details.release_date || '2099-01-01';
    toInsert.push({
      collection: activeTabId,
      item_key: key,
      title: summary.title,
      season: 'Film',
      theme: network,
      display_date: displayDate,
      date_sort: dateSort,
      watched: false,
      status: 'confirmed',
      tmdb_collection_id: data.collectionId,
      tmdb_collection_name: data.tmdbCollectionName,
      collections: [data.tmdbCollectionName],
      media_type: 'movie',
      tmdb_id: movieId,
      season_number: null
    });
  }

  if (toInsert.length === 0) { cancelTMDBPreview(); return; }

  try {
    const inserted = await sbFetch('POST', TABLE, toInsert);
    if (inserted) tabData[activeTabId].rows.push(...inserted);
    tabData[activeTabId].rows.sort((a,b) => a.date_sort.localeCompare(b.date_sort));
    showSaved();
    resetTMDBSearchUI();
    renderFilters();
    renderTable();
  } catch(e) {
    if (isDuplicateKeyError(e)) {
      showError(duplicateInsertMessage('try "🔗 Pull rest of collection" again for a fresh check'));
    } else {
      showError(e.message);
    }
  }
}

async function refreshCollections() {
  cancelTMDBPreview();
  const previewEl = document.getElementById('tmdbPreview');
  const resultsEl = document.getElementById('tmdbResults');
  resultsEl.innerHTML = '';
  document.getElementById('tmdbQuery').value = '';
  previewEl.innerHTML = `<div class="tmdb-loading">Checking your tracked collections…</div>`;

  const td = tabData[activeTabId];
  const rows = td?.rows || [];

  // distinct collections already represented in this tab's movies
  const collectionsMap = new Map(); // id -> name
  rows.forEach(r => {
    if (r.tmdb_collection_id) collectionsMap.set(r.tmdb_collection_id, r.tmdb_collection_name || 'Collection');
  });

  if (collectionsMap.size === 0) {
    previewEl.innerHTML = `<div class="tmdb-no-results">No tracked collections yet — add a movie that belongs to a franchise (e.g. a Marvel or Bourne film) to start tracking one.</div>`;
    return;
  }

  try {
    const newByCollection = [];
    for (const [collectionId, collectionName] of collectionsMap.entries()) {
      let data;
      try { data = await tmdbFetch(`/collection/${collectionId}`); } catch(e) { continue; }
      const movies = data.parts || [];
      const newOnes = movies.filter(m => !isAlreadyAdded(rows, { itemKey: `${m.title.toLowerCase().trim()}|film`, mediaType: 'movie', tmdbId: m.id }));
      if (newOnes.length > 0) {
        newByCollection.push({ collectionId, collectionName: data.name || collectionName, newOnes });
      }
    }

    if (newByCollection.length === 0) {
      previewEl.innerHTML = `<div class="tmdb-refresh-summary">✓ Everything's up to date — no new movies found across ${collectionsMap.size} tracked collection${collectionsMap.size===1?'':'s'}.</div>`;
      return;
    }

    let html = `<div class="tmdb-preview"><div class="tmdb-preview-title">New movies found</div>`;
    newByCollection.forEach(({collectionName, newOnes}, idx) => {
      html += `<div style="margin-top:10px"><div class="tmdb-result-title">${esc(collectionName)}</div>`;
      newOnes.forEach(m => {
        const date = m.release_date ? formatDisplayDate(m.release_date) : 'TBA';
        html += `<div class="tmdb-season-row">
          <input type="checkbox" checked data-collection-idx="${idx}" data-movie-id="${m.id}">
          <span class="tmdb-season-name">${esc(m.title)}</span>
          <span class="tmdb-season-meta">${esc(date)}</span>
        </div>`;
      });
      html += `</div>`;
    });
    html += `<div class="tmdb-preview-actions">
      <button class="btn btn-accent" onclick="addRefreshedCollectionMovies()">Add selected</button>
      <button class="btn" onclick="cancelTMDBPreview()">Cancel</button>
    </div></div>`;
    previewEl.innerHTML = html;
    window.__refreshCollectionsData = newByCollection;
  } catch(e) {
    previewEl.innerHTML = `<div class="tmdb-no-results">Refresh failed: ${esc(e.message)}</div>`;
  }
}

async function addRefreshedCollectionMovies() {
  const data = window.__refreshCollectionsData || [];
  const isMoviesTab = COLLECTIONS.find(c => c.id === activeTabId)?.isMovieTab;
  const checkboxes = document.querySelectorAll('#tmdbPreview input[type="checkbox"][data-collection-idx]');
  const toInsert = [];

  for (const cb of checkboxes) {
    if (!cb.checked) continue;
    const idx = parseInt(cb.dataset.collectionIdx, 10);
    const movieId = parseInt(cb.dataset.movieId, 10);
    const entry = data[idx];
    if (!entry) continue;
    const summary = entry.newOnes.find(m => m.id === movieId);
    if (!summary) continue;
    let details;
    try { details = await tmdbFetch(`/movie/${movieId}`); } catch(e) { continue; }
    const network = isMoviesTab
      ? ((details.genres && details.genres[0]?.name) || 'Film')
      : ((details.production_companies && details.production_companies[0]?.name) || 'Film');
    const key = `${summary.title.toLowerCase().trim()}|film`;
    const displayDate = details.release_date ? formatDisplayDate(details.release_date) : 'TBA';
    const dateSort = details.release_date || '2099-01-01';
    toInsert.push({
      collection: activeTabId,
      item_key: key,
      title: summary.title,
      season: 'Film',
      theme: network,
      display_date: displayDate,
      date_sort: dateSort,
      watched: false,
      status: 'confirmed',
      tmdb_collection_id: entry.collectionId,
      tmdb_collection_name: entry.collectionName,
      collections: [entry.collectionName],
      media_type: 'movie',
      tmdb_id: movieId,
      season_number: null
    });
  }

  if (toInsert.length === 0) { cancelTMDBPreview(); return; }

  try {
    const inserted = await sbFetch('POST', TABLE, toInsert);
    if (inserted) tabData[activeTabId].rows.push(...inserted);
    tabData[activeTabId].rows.sort((a,b) => a.date_sort.localeCompare(b.date_sort));
    showSaved();
    resetTMDBSearchUI();
    renderFilters();
    renderTable();
  } catch(e) {
    if (isDuplicateKeyError(e)) {
      showError(duplicateInsertMessage('try "↻ Refresh collections" again for a fresh check'));
    } else {
      showError(e.message);
    }
  }
}

function updateCollectionRefreshLink() {
  const select = document.getElementById('fCollection');
  const linkSpan = document.getElementById('collectionRefreshLink');
  if (!select || !linkSpan) return;
  const selected = select.value;
  // Only person collections (rows in custom_collections, the table
  // refreshPersonCollection() looks up) can be refreshed. Franchise and universe
  // tags (e.g. "Toy Story", "MCU") are never in that table, so they get no link.
  if (selected && personCollectionNames === null) {
    personCollectionNames = sbFetch('GET', 'custom_collections?select=name', null).then(
      rows => { personCollectionNames = new Set((rows || []).map(r => r.name)); updateCollectionRefreshLink(); },
      () => { personCollectionNames = null; }
    );
  }
  if (!selected || !(personCollectionNames instanceof Set) || !personCollectionNames.has(selected)) {
    linkSpan.innerHTML = '';
    return;
  }
  const nameEsc = esc(selected).replace(/'/g,"\\'");
  linkSpan.innerHTML = `<button class="collection-refresh-link" onclick="refreshPersonCollection('${nameEsc}')">↻ Refresh</button>`;
}

function toggleThemeFilterFromTag(theme) {
  const select = document.getElementById('fTheme');
  if (!select) return;
  const isAlreadySelected = select.value === theme;
  select.value = isAlreadySelected ? '' : theme;
  // if the filter row is collapsed (mobile), expand it so the active filter is visible
  const filtersEl = document.getElementById('filtersRow');
  if (filtersEl && filtersEl.classList.contains('collapsed')) {
    filtersEl.classList.remove('collapsed');
    const chevron = document.getElementById('filterToggleChevron');
    if (chevron) chevron.textContent = '▴';
  }
  renderTable();
}

function toggleWatchWithFilterFromTag(watchWithName) {
  const select = document.getElementById('fWatchWith');
  if (!select) return;
  const isAlreadySelected = select.value === watchWithName;
  select.value = isAlreadySelected ? '' : watchWithName;
  // if the filter row is collapsed (mobile), expand it so the active filter is visible
  const filtersEl = document.getElementById('filtersRow');
  if (filtersEl && filtersEl.classList.contains('collapsed')) {
    filtersEl.classList.remove('collapsed');
    const chevron = document.getElementById('filterToggleChevron');
    if (chevron) chevron.textContent = '▴';
  }
  renderTable();
}

function toggleCollectionFilterFromTag(collectionName) {
  const select = document.getElementById('fCollection');
  if (!select) return; // filter dropdown not built yet (e.g. no collections tagged at all)
  const isAlreadySelected = select.value === collectionName;
  select.value = isAlreadySelected ? '' : collectionName;
  // if the filter row is collapsed (mobile), expand it so the active filter is visible
  const filtersEl = document.getElementById('filtersRow');
  if (filtersEl && filtersEl.classList.contains('collapsed')) {
    filtersEl.classList.remove('collapsed');
    const chevron = document.getElementById('filterToggleChevron');
    if (chevron) chevron.textContent = '▴';
  }
  updateCollectionRefreshLink();
  renderTable();
}
