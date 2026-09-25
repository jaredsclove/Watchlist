async function pullUniverse(universeKey) {
  const universe = UNIVERSE_LISTS[universeKey];
  if (!universe) return;
  cancelTMDBPreview();
  const resultsEl = document.getElementById('tmdbResults');
  const previewEl = document.getElementById('tmdbPreview');
  resultsEl.innerHTML = '';
  previewEl.innerHTML = `<div class="tmdb-loading">Looking up ${esc(universe.label)} titles…</div>`;

  const td = tabData[activeTabId];
  const existingRows = td?.rows || [];
  const found = [];
  const notFound = [];
  let backfilled = 0;

  for (const title of universe.titles) {
    // Step 1: always resolve the real TMDB match first — never skip this based
    // on a title-only guess, so we always know the real tmdb_id before deciding
    // whether this is already on the list.
    let match;
    try {
      const data = await tmdbFetch(`/search/movie?query=${encodeURIComponent(title)}`);
      match = (data.results || []).find(m => m.title.toLowerCase() === title.toLowerCase()) || (data.results || [])[0];
    } catch(e) {
      match = null;
    }
    if (!match) {
      notFound.push(title);
      continue;
    }

    // Step 2: now check existing rows using TMDB-first identity, falling back
    // to item_key only for rows that haven't been backfilled with a tmdb_id yet.
    // Uses the same shared helper as every other TMDB-driven flow, so this
    // logic can't drift out of sync with the canonical identity rules.
    const key = `${title.toLowerCase().trim()}|film`;
    const existingRow = findExistingRow(existingRows, { itemKey: key, mediaType: 'movie', tmdbId: match.id });

    if (existingRow) {
      found.push({ title, alreadyAdded: true });
      // backfill the universe tag if this row predates the universe-pull feature
      const currentCollections = existingRow.collections || [];
      if (!currentCollections.includes(universe.label)) {
        const updated = [...currentCollections, universe.label];
        try {
          await sbFetch('PATCH', `${TABLE}?id=eq.${existingRow.id}`, { collections: updated });
          existingRow.collections = updated;
          backfilled++;
        } catch(e) { /* non-fatal — leave it as-is if the patch fails */ }
      }
    } else {
      found.push({ title, tmdbId: match.id, releaseDate: match.release_date, alreadyAdded: false });
    }
  }

  found.sort((a,b) => (a.releaseDate||'9999').localeCompare(b.releaseDate||'9999'));

  const rowsHtml = found.map(m => {
    const date = m.releaseDate ? formatDisplayDate(m.releaseDate) : 'TBA';
    return `<div class="tmdb-season-row ${m.alreadyAdded?'already-added':''}">
      <input type="checkbox" ${m.alreadyAdded?'disabled':'checked'} data-tmdb-id="${m.tmdbId||''}" data-title="${esc(m.title).replace(/'/g,"\\'")}" id="uni_${m.tmdbId||m.title.replace(/\W/g,'')}">
      <span class="tmdb-season-name">${esc(m.title)}</span>
      <span class="tmdb-season-meta">${esc(date)}</span>
      ${m.alreadyAdded ? '<span class="tmdb-already-tag">Already added</span>' : ''}
    </div>`;
  }).join('');

  const notFoundHtml = notFound.length
    ? `<div class="tmdb-refresh-summary">Couldn't find on TMDB: ${notFound.map(esc).join(', ')}</div>`
    : '';
  const backfillHtml = backfilled > 0
    ? `<div class="tmdb-refresh-summary">✓ Tagged ${backfilled} already-added movie${backfilled===1?'':'s'} with "${esc(universe.label)}" that were missing it.</div>`
    : '';

  window.__universePullKey = universeKey;

  previewEl.innerHTML = `
    <div class="tmdb-preview">
      <div class="tmdb-preview-header">
        <div class="tmdb-preview-title">${esc(universe.label)}</div>
        <div class="tmdb-result-meta">${found.filter(f=>!f.alreadyAdded).length} new, ${found.filter(f=>f.alreadyAdded).length} already on your list</div>
      </div>
      ${backfillHtml}
      ${rowsHtml || '<div class="tmdb-no-results">Nothing found.</div>'}
      ${notFoundHtml}
      <div class="tmdb-preview-actions">
        <button class="btn btn-accent" onclick="addPulledUniverseMovies()">Add selected</button>
        <button class="btn" onclick="cancelTMDBPreview()">Cancel</button>
      </div>
    </div>
  `;
  if (backfilled > 0) { showSaved(); renderTable(); }
}

async function addPulledUniverseMovies() {
  const universeKey = window.__universePullKey;
  const universe = UNIVERSE_LISTS[universeKey];
  const isMoviesTab = COLLECTIONS.find(c => c.id === activeTabId)?.isMovieTab;
  const checkboxes = document.querySelectorAll('#tmdbPreview input[type="checkbox"][data-tmdb-id]');
  const toInsert = [];

  for (const cb of checkboxes) {
    if (!cb.checked || cb.disabled) continue;
    const tmdbId = cb.dataset.tmdbId;
    const title = cb.dataset.title;
    if (!tmdbId) continue;
    let details;
    try { details = await tmdbFetch(`/movie/${tmdbId}`); } catch(e) { continue; }
    const network = isMoviesTab
      ? ((details.genres && details.genres[0]?.name) || 'Film')
      : ((details.production_companies && details.production_companies[0]?.name) || 'Film');
    const key = `${title.toLowerCase().trim()}|film`;
    const displayDate = details.release_date ? formatDisplayDate(details.release_date) : 'TBA';
    const dateSort = details.release_date || '2099-01-01';
    const belongsTo = details.belongs_to_collection;
    const collections = belongsTo ? [cleanCollectionName(belongsTo.name), universe?.label || universeKey] : [universe?.label || universeKey];
    toInsert.push({
      collection: activeTabId,
      item_key: key,
      title,
      season: 'Film',
      theme: network,
      display_date: displayDate,
      date_sort: dateSort,
      watched: false,
      status: 'confirmed',
      tmdb_collection_id: belongsTo ? belongsTo.id : null,
      tmdb_collection_name: belongsTo ? cleanCollectionName(belongsTo.name) : null,
      collections,
      media_type: 'movie',
      tmdb_id: parseInt(tmdbId, 10),
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
      showError(duplicateInsertMessage('try the universe pull again for a fresh check'));
    } else {
      showError(e.message);
    }
  }
}
