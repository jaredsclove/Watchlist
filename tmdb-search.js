const TMDB_SEARCH_LIMIT = 6;

// Picks the search hits to show. 'movie' and 'tv' list that type first and
// use any room left for the other type, so the other type can't crowd it out;
// 'mixed' keeps the original split of up to 4 series then up to 4 films. Each type
// stays in TMDB's relevance order, and the list is capped at TMDB_SEARCH_LIMIT.
function selectTmdbSearchResults(tvResults, movieResults, mode) {
  if (mode === 'mixed') return [...tvResults.slice(0, 4), ...movieResults.slice(0, 4)].slice(0, TMDB_SEARCH_LIMIT);
  const [primary, secondary] = mode === 'movie' ? [movieResults, tvResults] : [tvResults, movieResults];
  return [...primary, ...secondary].slice(0, TMDB_SEARCH_LIMIT);
}

// A result row is a button (Enter or Space chooses it, as a click does).
function tmdbResultKeydown(event) {
  if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;
  if (typeof event.preventDefault === 'function') event.preventDefault();
  if (event.currentTarget && typeof event.currentTarget.click === 'function') event.currentTarget.click();
}

// opts.focusResults: focus moves to the first result (a search sent from the toolbar's field).
async function searchTMDB(opts = {}) {
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
    // The "+ Add" panel (library.js) searches by its media.
    // A mixed collection (All media) shows both kinds: the result chosen decides the media type.
    const mode = libraryPanel && libraryPanel.mixed ? 'mixed' : libraryPanel && libraryPanel.media === 'movie' ? 'movie' : 'tv';
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
      return `<div class="tmdb-result-item" id="${resultId}" role="button" tabindex="0" onkeydown="tmdbResultKeydown(event)" onclick="selectTMDBShow(${r.id}, '${titleEsc}', '${r.mediaType}', '${resultId}')">
        ${poster ? `<img class="tmdb-result-poster" src="${poster}" alt="">` : '<div class="tmdb-result-poster"></div>'}
        <div class="tmdb-result-info">
          <div class="tmdb-result-title">${esc(title)} ${typeTag}</div>
          <div class="tmdb-result-meta">${year}${r.origin_country?.length ? ' · ' + esc(r.origin_country.join(', ')) : ''}</div>
        </div>
      </div>`;
    }).join('')}</div>`;
    const first = opts.focusResults && resultsEl.querySelector ? resultsEl.querySelector('.tmdb-result-item') : null;
    if (first && typeof first.focus === 'function') first.focus();
  } catch(e) {
    resultsEl.innerHTML = `<div class="tmdb-no-results">Search failed: ${esc(e.message)}</div>`;
  }
}

async function selectTMDBShow(tmdbId, name, mediaType, resultId) {
  tmdbSelectedShow = { id: tmdbId, name, mediaType: mediaType || 'tv', resultId };
  tmdbShowSpecials = false;

  // remove any previously-inserted inline preview (only one can be open at a time)
  const oldPreview = document.getElementById('tmdbInlinePreview');
  if (oldPreview) oldPreview.remove();

  // insert a fresh preview container directly after the clicked result row
  const resultRow = document.getElementById(resultId);
  const previewContainer = document.createElement('div');
  previewContainer.id = 'tmdbInlinePreview';
  previewContainer.tabIndex = -1; // focus goes to the preview, never to its Add button: a second Enter adds nothing
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
    if (tmdbSelectedShow.mediaType === 'tv') noteShowRating(tmdbId, details); // item 2 (show-ratings.js)
    renderTMDBPreview();
    if (typeof previewContainer.focus === 'function' && previewContainer.isConnected) previewContainer.focus();
  } catch(e) {
    previewContainer.innerHTML = `<div class="tmdb-no-results">Failed to load details: ${esc(e.message)}</div>`;
  }
}

function getTMDBPreviewContainer() {
  return document.getElementById('tmdbInlinePreview') || document.getElementById('tmdbPreview');
}

// The preview of a chosen result belongs to the view's "+ Add" panel (library.js).
function renderTMDBPreview() {
  if (libraryPanel) libraryRenderPreview();
}

function toggleTMDBSpecials() {
  tmdbShowSpecials = document.getElementById('tmdbSpecialsToggle').checked;
  renderTMDBPreview();
}

function cancelTMDBPreview() {
  const resultId = tmdbSelectedShow && tmdbSelectedShow.resultId;
  tmdbSelectedShow = null;
  const inlinePreview = document.getElementById('tmdbInlinePreview');
  const hadFocus = !!inlinePreview && typeof inlinePreview.contains === 'function' && inlinePreview.contains(document.activeElement);
  if (inlinePreview) inlinePreview.remove();
  const row = hadFocus && resultId ? document.getElementById(resultId) : null; // Cancel: back to the result it came from
  if (row && typeof row.focus === 'function') row.focus();
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

function addSelectedTMDBSeasons() {
  if (libraryPanel) return librarySubmitSelection();
}
