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
  const ambiguous = []; // { title, candidates } — more than one TMDB film has this exact title
  let backfilled = 0;

  for (const entry of universe.titles) {
    // Step 1: resolve the real TMDB film before deciding anything. An entry with
    // a configured id ({ t, id }) is fetched directly by that id — no title
    // search. A plain-string (or { t, y }) entry is searched, but only an
    // unambiguous exact-title result is accepted (pickTmdbMovieCandidate); there
    // is no first-result fallback.
    const title = typeof entry === 'string' ? entry : entry.t;
    const configuredId = typeof entry === 'object' && entry.id ? entry.id : null;
    let match = null;
    if (configuredId) {
      try { match = await tmdbFetch(`/movie/${configuredId}`); } catch(e) { match = null; }
    } else {
      let results = [];
      try {
        const data = await tmdbFetch(`/search/movie?query=${encodeURIComponent(title)}`);
        results = data.results || [];
      } catch(e) { results = []; }
      const picked = pickTmdbMovieCandidate(results, title, typeof entry === 'object' ? entry.y : null);
      if (picked.ambiguous) {
        // Never auto-select, insert or tag here — the user picks explicitly below.
        ambiguous.push({ title, candidates: picked.ambiguous });
        continue;
      }
      match = picked.match || null;
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
      <input type="checkbox" ${m.alreadyAdded?'disabled':'checked'} data-tmdb-id="${m.tmdbId||''}" data-title="${esc(m.title)}" id="uni_${m.tmdbId||m.title.replace(/\W/g,'')}">
      <span class="tmdb-season-name">${esc(m.title)}</span>
      <span class="tmdb-season-meta">${esc(date)}</span>
      ${m.alreadyAdded ? '<span class="tmdb-already-tag">Already added</span>' : ''}
    </div>`;
  }).join('');

  // Ambiguous titles: list every same-title candidate with its release year,
  // unchecked, so nothing is chosen unless the user ticks it. Candidates already
  // on the list (by TMDB id) are shown disabled. No tag backfill happens here.
  const ambiguousHtml = ambiguous.length
    ? `<div class="tmdb-refresh-summary">Needs your choice — more than one TMDB film is titled exactly like these. Tick the one you mean, if any.</div>` +
      ambiguous.map(a => a.candidates
        .slice().sort((x, y) => (x.release_date || '9999').localeCompare(y.release_date || '9999'))
        .map(c => {
          const onList = !!findExistingRow(existingRows, { itemKey: null, mediaType: 'movie', tmdbId: c.id });
          const year = c.release_date ? c.release_date.slice(0, 4) : 'year unknown';
          return `<div class="tmdb-season-row ${onList ? 'already-added' : ''}">
            <input type="checkbox" ${onList ? 'disabled' : ''} data-tmdb-id="${c.id}" data-title="${esc(a.title)}" id="uni_${c.id}">
            <span class="tmdb-season-name">${esc(c.title)} (${esc(year)})</span>
            <span class="tmdb-season-meta">${c.release_date ? esc(formatDisplayDate(c.release_date)) : 'TBA'} · TMDB ${c.id}</span>
            ${onList ? '<span class="tmdb-already-tag">Already added</span>' : ''}
          </div>`;
        }).join('')).join('')
    : '';

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
        <div class="tmdb-result-meta">${found.filter(f=>!f.alreadyAdded).length} new, ${found.filter(f=>f.alreadyAdded).length} already on your list${ambiguous.length ? `, ${ambiguous.length} need${ambiguous.length===1?'s':''} your choice` : ''}</div>
      </div>
      ${backfillHtml}
      ${rowsHtml || (ambiguous.length ? '' : '<div class="tmdb-no-results">Nothing found.</div>')}
      ${ambiguousHtml}
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
