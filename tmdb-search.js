const TMDB_SEARCH_LIMIT = 6;

// Which kind of search hits a tab is for: 'movie' (Movies), 'mixed' (a tab that
// deliberately holds both series and films, e.g. True Crime / Docs) or 'tv'.
function tmdbSearchModeFor(col) {
  if (col?.isMovieTab) return 'movie';
  if (col?.mixedMedia) return 'mixed';
  return 'tv';
}

// Picks the search hits to show. 'movie' and 'tv' list the tab's own type first and
// use any room left for the other type, so the other type can't crowd it out;
// 'mixed' keeps the original split of up to 4 series then up to 4 films. Each type
// stays in TMDB's relevance order, and the list is capped at TMDB_SEARCH_LIMIT.
function selectTmdbSearchResults(tvResults, movieResults, mode) {
  if (mode === 'mixed') return [...tvResults.slice(0, 4), ...movieResults.slice(0, 4)].slice(0, TMDB_SEARCH_LIMIT);
  const [primary, secondary] = mode === 'movie' ? [movieResults, tvResults] : [tvResults, movieResults];
  return [...primary, ...secondary].slice(0, TMDB_SEARCH_LIMIT);
}

async function searchTMDB() {
  const query = document.getElementById('tmdbQuery').value.trim();
  const resultsEl = document.getElementById('tmdbResults');
  cancelTMDBPreview();
  if (!query) { resultsEl.innerHTML = ''; return; }

  resultsEl.innerHTML = `<div class="tmdb-loading">Searching…</div>`;
  try {
    const [tvData, movieData] = await Promise.all([
      tmdbFetch(`/search/tv?query=${encodeURIComponent(query)}&page=1`),
      tmdbFetch(`/search/movie?query=${encodeURIComponent(query)}&page=1`)
    ]);
    const tvResults = (tvData.results || []).map(r => ({ ...r, mediaType: 'tv' }));
    const movieResults = (movieData.results || []).map(r => ({ ...r, mediaType: 'movie' }));
    const mode = tmdbSearchModeFor(COLLECTIONS.find(c => c.id === activeTabId));
    const results = selectTmdbSearchResults(tvResults, movieResults, mode);

    if (results.length === 0) {
      resultsEl.innerHTML = `<div class="tmdb-no-results">No results found for "${esc(query)}".</div>`;
      return;
    }
    resultsEl.innerHTML = `<div class="tmdb-result-list">${results.map((r, idx) => {
      const isMovie = r.mediaType === 'movie';
      const title = isMovie ? r.title : r.name;
      const dateStr = isMovie ? r.release_date : r.first_air_date;
      const year = dateStr ? dateStr.substring(0,4) : '—';
      const poster = r.poster_path ? `https://image.tmdb.org/t/p/w92${r.poster_path}` : '';
      const typeTag = isMovie ? '<span class="tmdb-type-tag tmdb-type-movie">Film</span>' : '<span class="tmdb-type-tag tmdb-type-tv">Series</span>';
      const titleEsc = esc(title).replace(/'/g,"\\'");
      const resultId = `tmdbResult_${idx}_${r.id}`;
      return `<div class="tmdb-result-item" id="${resultId}" onclick="selectTMDBShow(${r.id}, '${titleEsc}', '${r.mediaType}', '${resultId}')">
        ${poster ? `<img class="tmdb-result-poster" src="${poster}" alt="">` : '<div class="tmdb-result-poster"></div>'}
        <div class="tmdb-result-info">
          <div class="tmdb-result-title">${esc(title)} ${typeTag}</div>
          <div class="tmdb-result-meta">${year}${r.origin_country?.length ? ' · ' + esc(r.origin_country.join(', ')) : ''}</div>
        </div>
      </div>`;
    }).join('')}</div>`;
  } catch(e) {
    resultsEl.innerHTML = `<div class="tmdb-no-results">Search failed: ${esc(e.message)}</div>`;
  }
}

async function selectTMDBShow(tmdbId, name, mediaType, resultId) {
  tmdbSelectedShow = { id: tmdbId, name, mediaType: mediaType || 'tv' };
  tmdbShowSpecials = false;

  // remove any previously-inserted inline preview (only one can be open at a time)
  const oldPreview = document.getElementById('tmdbInlinePreview');
  if (oldPreview) oldPreview.remove();

  // insert a fresh preview container directly after the clicked result row
  const resultRow = document.getElementById(resultId);
  const previewContainer = document.createElement('div');
  previewContainer.id = 'tmdbInlinePreview';
  if (resultRow) {
    resultRow.insertAdjacentElement('afterend', previewContainer);
    resultRow.classList.add('tmdb-result-item-selected');
  } else {
    // fallback: no matching row found (e.g. called from elsewhere) — use the old fixed panel
    const fallback = document.getElementById('tmdbPreview');
    if (fallback) fallback.appendChild(previewContainer);
  }

  previewContainer.innerHTML = `<div class="tmdb-loading">Loading details…</div>`;
  try {
    const details = await tmdbFetch(`/${tmdbSelectedShow.mediaType}/${tmdbId}`);
    tmdbSelectedShow.details = details;
    renderTMDBPreview();
  } catch(e) {
    previewContainer.innerHTML = `<div class="tmdb-no-results">Failed to load details: ${esc(e.message)}</div>`;
  }
}

function getTMDBPreviewContainer() {
  return document.getElementById('tmdbInlinePreview') || document.getElementById('tmdbPreview');
}

function renderTMDBPreview() {
  const previewEl = getTMDBPreviewContainer();
  if (!previewEl || !tmdbSelectedShow || !tmdbSelectedShow.details) return;
  const details = tmdbSelectedShow.details;
  const existingRows = tabData[activeTabId]?.rows || [];
  const showKeyBase = tmdbSelectedShow.name.toLowerCase().trim();

  if (tmdbSelectedShow.mediaType === 'movie') {
    const isMoviesTab = COLLECTIONS.find(c => c.id === activeTabId)?.isMovieTab;
    const network = isMoviesTab
      ? ((details.genres && details.genres[0]?.name) || 'Film')
      : ((details.production_companies && details.production_companies[0]?.name) || 'Film');
    const key = `${showKeyBase}|film`;
    const alreadyAdded = isAlreadyAdded(existingRows, { itemKey: key, mediaType: 'movie', tmdbId: tmdbSelectedShow.id });
    const date = details.release_date ? formatDisplayDate(details.release_date) : 'TBA';
    const runtime = details.runtime ? `${details.runtime} min` : '';
    const belongsTo = details.belongs_to_collection;
    previewEl.innerHTML = `
      <div class="tmdb-preview">
        <div class="tmdb-preview-header">
          <div>
            <div class="tmdb-preview-title">${esc(tmdbSelectedShow.name)}</div>
            <div class="tmdb-result-meta">${esc(network)}</div>
          </div>
        </div>
        ${belongsTo ? `<div class="tmdb-collection-note">🔗 Part of <strong>${esc(cleanCollectionName(belongsTo.name))}</strong> — you can pull the rest of this collection after adding.</div>` : ''}
        <div class="tmdb-season-row ${alreadyAdded?'already-added':''}">
          <input type="checkbox" ${alreadyAdded?'disabled':'checked'} data-season="film" id="szn_film">
          <span class="tmdb-season-name">Film</span>
          <span class="tmdb-season-meta">${esc(runtime)}${runtime?' · ':''}${esc(date)}</span>
          ${alreadyAdded ? '<span class="tmdb-already-tag">Already added</span>' : ''}
        </div>
        <div class="tmdb-preview-actions">
          <button class="btn btn-accent" onclick="addSelectedTMDBSeasons()">Add film</button>
          <button class="btn" onclick="cancelTMDBPreview()">Cancel</button>
        </div>
      </div>
    `;
    return;
  }

  const network = (details.networks && details.networks[0]?.name) || 'Unknown';

  let seasons = (details.seasons || []).filter(s => tmdbShowSpecials || s.season_number !== 0);
  seasons.sort((a,b) => a.season_number - b.season_number);

  const rowsHtml = seasons.map(s => {
    const seasonLabel = s.season_number === 0 ? 'Specials' : `Season ${s.season_number}`;
    const key = `${showKeyBase}|${seasonLabel.toLowerCase()}`;
    const alreadyAdded = isAlreadyAdded(existingRows, { itemKey: key, mediaType: 'tv', tmdbId: tmdbSelectedShow.id, seasonNumber: s.season_number });
    const date = s.air_date ? formatDisplayDate(s.air_date) : 'TBA';
    return `<div class="tmdb-season-row ${alreadyAdded?'already-added':''}">
      <input type="checkbox" ${alreadyAdded?'disabled':'checked'} data-season="${s.season_number}" id="szn_${s.season_number}">
      <span class="tmdb-season-name">${esc(seasonLabel)}</span>
      <span class="tmdb-season-meta">${s.episode_count||0} episodes · ${esc(date)}</span>
      ${alreadyAdded ? '<span class="tmdb-already-tag">Already added</span>' : ''}
    </div>`;
  }).join('');

  previewEl.innerHTML = `
    <div class="tmdb-preview">
      <div class="tmdb-preview-header">
        <div>
          <div class="tmdb-preview-title">${esc(tmdbSelectedShow.name)}</div>
          <div class="tmdb-result-meta">${esc(network)}</div>
        </div>
        <label class="tmdb-specials-toggle">
          <input type="checkbox" id="tmdbSpecialsToggle" ${tmdbShowSpecials?'checked':''} onchange="toggleTMDBSpecials()">
          Include specials
        </label>
      </div>
      ${rowsHtml || '<div class="tmdb-no-results">No seasons found.</div>'}
      <div class="tmdb-preview-actions">
        <button class="btn btn-accent" onclick="addSelectedTMDBSeasons()">Add selected seasons</button>
        <button class="btn" onclick="cancelTMDBPreview()">Cancel</button>
      </div>
    </div>
  `;
}

function toggleTMDBSpecials() {
  tmdbShowSpecials = document.getElementById('tmdbSpecialsToggle').checked;
  renderTMDBPreview();
}

function cancelTMDBPreview() {
  tmdbSelectedShow = null;
  const inlinePreview = document.getElementById('tmdbInlinePreview');
  if (inlinePreview) inlinePreview.remove();
  document.querySelectorAll('.tmdb-result-item-selected').forEach(el => el.classList.remove('tmdb-result-item-selected'));
  // fallback panel (used only if no result row match was found) — clear it too, harmless if empty
  const fallback = document.getElementById('tmdbPreview');
  if (fallback) fallback.innerHTML = '';
}

function resetTMDBSearchUI() {
  cancelTMDBPreview();
  const resultsEl = document.getElementById('tmdbResults');
  if (resultsEl) resultsEl.innerHTML = '';
  const queryEl = document.getElementById('tmdbQuery');
  if (queryEl) queryEl.value = '';
}

async function addSelectedTMDBSeasons() {
  if (!tmdbSelectedShow || !tmdbSelectedShow.details) return;
  // Captured before any await: switching tabs or views clears tmdbSelectedShow
  // and changes activeTabId while the writes are in flight.
  const collectionId = activeTabId;
  if (!collectionId) return;
  const showId = tmdbSelectedShow.id;
  const details = tmdbSelectedShow.details;
  const showName = tmdbSelectedShow.name;
  const showKeyBase = showName.toLowerCase().trim();
  const isMovie = tmdbSelectedShow.mediaType === 'movie';

  let toInsert = [];
  let network;

  if (isMovie) {
    const previewContainer = getTMDBPreviewContainer();
    const cb = previewContainer?.querySelector('input[type="checkbox"][data-season="film"]');
    if (!cb || !cb.checked || cb.disabled) { cancelTMDBPreview(); return; }
    // for the Movies tab, use genre as theme; for True Crime/Docs (movies mixed in there) fall back to production company
    const isMoviesTab = COLLECTIONS.find(c => c.id === collectionId)?.isMovieTab;
    if (isMoviesTab) {
      network = (details.genres && details.genres[0]?.name) || 'Film';
    } else {
      network = (details.production_companies && details.production_companies[0]?.name) || 'Film';
    }
    const key = `${showKeyBase}|film`;
    const displayDate = details.release_date ? formatDisplayDate(details.release_date) : 'TBA';
    const dateSort = details.release_date || '2099-01-01';
    const belongsTo = details.belongs_to_collection;
    toInsert.push({
      collection: collectionId,
      item_key: key,
      title: showName,
      season: 'Film',
      theme: network,
      display_date: displayDate,
      date_sort: dateSort,
      watched: false,
      status: 'confirmed',
      tmdb_collection_id: belongsTo ? belongsTo.id : null,
      tmdb_collection_name: belongsTo ? belongsTo.name : null,
      collections: belongsTo ? [belongsTo.name] : [],
      media_type: 'movie',
      tmdb_id: showId,
      season_number: null
    });
  } else {
    network = (details.networks && details.networks[0]?.name) || 'Unknown';
    const previewContainer = getTMDBPreviewContainer();
    const checkboxes = previewContainer ? previewContainer.querySelectorAll('input[type="checkbox"][data-season]') : [];
    const seasonsByNum = {};
    (details.seasons || []).forEach(s => seasonsByNum[s.season_number] = s);

    checkboxes.forEach(cb => {
      if (!cb.checked || cb.disabled) return;
      const num = parseInt(cb.dataset.season, 10);
      const s = seasonsByNum[num];
      if (!s) return;
      const seasonLabel = num === 0 ? 'Specials' : `Season ${num}`;
      const key = `${showKeyBase}|${seasonLabel.toLowerCase()}`;
      const displayDate = s.air_date ? formatDisplayDate(s.air_date) : 'TBA';
      const dateSort = s.air_date || '2099-01-01';
      toInsert.push({
        collection: collectionId,
        item_key: key,
        title: showName,
        season: seasonLabel,
        theme: network,
        display_date: displayDate,
        date_sort: dateSort,
        watched: false,
        status: 'confirmed',
        media_type: 'tv',
        tmdb_id: showId,
        season_number: num
      });
    });
  }

  if (toInsert.length === 0) { cancelTMDBPreview(); return; }

  // TV seasons on a TV tab go through add_tv_seasons, which links them to their
  // show (an identified show is then checked by Refresh shows).
  const viaShowFunction = !isMovie && isTvCollection(collectionId);
  let outcome = null;
  try {
    if (viaShowFunction) {
      outcome = await addTvSeasonRows(collectionId, toInsert, inserted => tabData[collectionId]?.rows.push(...inserted));
    } else {
      const inserted = await sbFetch('POST', TABLE, toInsert);
      if (inserted) tabData[collectionId]?.rows.push(...inserted);
    }
    tabData[collectionId]?.rows.sort((a,b) => a.date_sort.localeCompare(b.date_sort));


    showSaved();
    if (activeTabId === collectionId) {
      resetTMDBSearchUI();
      renderFilters();
      renderTable();
    }
    if (outcome) showTvAddOutcome(outcome);
  } catch(e) {
    if (viaShowFunction) {
      tabData[collectionId]?.rows.sort((a,b) => a.date_sort.localeCompare(b.date_sort));
      if (activeTabId === collectionId) renderTable();
    }
    if (isDuplicateKeyError(e)) {
      showError(duplicateInsertMessage('try searching again for a fresh check'));
    } else {
      showError(e.message);
    }
  }
}
