// ─── What a film's TMDB collection offers ─────────────────────────────────────
// TMDB names a film's collection with its details, but not what else is in it. The add screen,
// the film's ⋯ menu and Pull rest share one lookup per collection (collectionLookups), kept in
// page memory only: every fetch of a collection (Check collection, Pull rest, Refresh
// collections) replaces it, and a new page starts unknown, so a film TMDB adds later is found.
function noteCollectionParts(collectionId, data) {
  const parts = (data && Array.isArray(data.parts) ? data.parts : [])
    .filter(m => m && Number.isInteger(m.id) && typeof m.title === 'string')
    .map(m => ({ id: m.id, title: m.title, release_date: m.release_date || '' }));
  collectionLookups.set(collectionId, { status: 'ready', parts });
}
// One request at a time per collection; a failure is kept (with its reason) until retried.
function checkCollection(collectionId) {
  const had = collectionLookups.get(collectionId);
  if (had && had.status === 'loading') return had.promise;
  const promise = tmdbFetch(`/collection/${collectionId}`).then(
    data => noteCollectionParts(collectionId, data),
    e => collectionLookups.set(collectionId, { status: 'failed',
      error: e && e.status === 404 ? 'TMDB has no such collection' : (e && e.message) || 'TMDB didn’t answer' }));
  collectionLookups.set(collectionId, { status: 'loading', promise });
  return promise;
}
// For one film (its TMDB id) against the films known to be in the library: unknown, loading,
// failed, sole (no other film in the collection), present (every other film already added) or
// addable (count). Matching is the movie tools' own (isAlreadyAdded).
function collectionOffer(collectionId, filmTmdbId, knownRows) {
  const l = collectionLookups.get(collectionId);
  if (!l) return { kind: 'unknown' };
  if (l.status !== 'ready') return { kind: l.status, error: l.error };
  const others = l.parts.filter(m => m.id !== filmTmdbId);
  if (!others.length) return { kind: 'sole' };
  const addable = others.filter(m => !isAlreadyAdded(knownRows || [], { itemKey: `${m.title.toLowerCase().trim()}|film`, mediaType: 'movie', tmdbId: m.id }));
  return addable.length ? { kind: 'addable', count: addable.length } : { kind: 'present' };
}
const COLLECTION_PRESENT_TEXT = 'All collection films are already in your library.';

// The film's ⋯ menu: its Collection section (in place of an unconditional Pull rest).
function filmCollectionSectionHtml(r) {
  const idArg = esc(r.id).replace(/'/g, "\\'");
  const franchise = cleanCollectionName(r.tmdb_collection_name || '') || 'the collection';
  const offer = collectionOffer(r.tmdb_collection_id, r.tmdb_id, browseData && browseData.rows);
  const label = '<div class="popover-section-label" style="margin-top:8px">Collection</div>';
  const check = text => `<button class="popover-action" onclick="checkFilmCollection('${idArg}')" aria-label="${esc(`${text}: ${franchise}`)}">${esc(text)}</button>`;
  if (offer.kind === 'unknown') return `${label}${check('🔗 Check collection')}`;
  if (offer.kind === 'loading') return `${label}<div class="popover-note" role="status" tabindex="-1">Checking ${esc(franchise)}…</div>`;
  if (offer.kind === 'failed') return `${label}<div class="popover-note" role="status" tabindex="-1">Couldn’t check ${esc(franchise)} (${esc(offer.error)}).</div>${check('Retry')}`;
  if (offer.kind === 'present') return `${label}<div class="popover-note" role="status" tabindex="-1">${COLLECTION_PRESENT_TEXT}</div>`;
  if (offer.kind === 'addable') return `${label}<button class="popover-action" onclick="libraryPullRest('${idArg}', ${r.tmdb_collection_id}, '${esc(cleanCollectionName(r.tmdb_collection_name || '')).replace(/'/g, "\\'")}')">🔗 Pull rest of ${esc(franchise)}</button>`;
  return ''; // sole: nothing to offer
}
// The sections on the page for this collection are redrawn in place (the menu stays open); focus
// that was in one moves to its new control or note.
function redrawFilmCollectionSections(collectionId) {
  const rows = (browseData && browseData.rows) || [];
  if (!rows.length) return;
  document.querySelectorAll('[data-film-franchise]').forEach(el => {
    const r = rows.find(x => x.id === el.getAttribute('data-film-franchise'));
    if (!r || r.tmdb_collection_id !== collectionId) return;
    const hadFocus = !!document.activeElement && el.contains(document.activeElement);
    el.innerHTML = filmCollectionSectionHtml(r);
    if (hadFocus) {
      // Its new control or note; for a collection of one (nothing shown), the menu's first action.
      const menu = el.closest('.more-popover');
      const next = el.querySelector('button') || el.querySelector('[tabindex="-1"]') || (menu && menu.querySelector('button'));
      if (next) next.focus();
    }
  });
}
async function checkFilmCollection(rowId) {
  const r = ((browseData && browseData.rows) || []).find(x => x.id === rowId);
  if (!r || !r.tmdb_collection_id) return;
  const pending = checkCollection(r.tmdb_collection_id);
  redrawFilmCollectionSections(r.tmdb_collection_id);
  await pending;
  redrawFilmCollectionSections(r.tmdb_collection_id);
}

// The add screen: the selected film's collection is checked once it is shown (one request); the
// note appears only when there's something to say: other films to pull, all of them already
// added, or a failed check (with Retry). Nothing while checking or for a collection of one.
function addScreenCollectionNoteHtml(details, filmTmdbId, knownRows) {
  const c = details && details.belongs_to_collection;
  if (!c || !Number.isInteger(c.id)) return '';
  const name = cleanCollectionName(c.name || '') || 'its collection';
  const offer = collectionOffer(c.id, filmTmdbId, knownRows);
  if (offer.kind === 'unknown') { checkAddScreenCollection(c.id); return ''; }
  if (offer.kind === 'failed') return `<div class="tmdb-collection-note" role="status">🔗 Couldn’t check <strong>${esc(name)}</strong> (${esc(offer.error)}). <button type="button" class="btn btn-link" onclick="retryAddScreenCollection(${c.id})">Retry</button></div>`;
  if (offer.kind === 'present') return `<div class="tmdb-collection-note">🔗 Part of <strong>${esc(name)}</strong>. ${COLLECTION_PRESENT_TEXT}</div>`;
  if (offer.kind === 'addable') return `<div class="tmdb-collection-note">🔗 Part of <strong>${esc(name)}</strong>, with ${offer.count} other film${offer.count === 1 ? '' : 's'} — you can pull ${offer.count === 1 ? 'it' : 'them'} from the film’s ⋯ menu afterwards.</div>`;
  return ''; // loading or sole
}
async function checkAddScreenCollection(collectionId) {
  const sel = tmdbSelectedShow;
  await checkCollection(collectionId);
  // Drawn again only while the same film is still shown.
  if (tmdbSelectedShow === sel && libraryPanel) libraryRenderPreview();
}
function retryAddScreenCollection(collectionId) {
  const pending = checkAddScreenCollection(collectionId);
  if (libraryPanel) libraryRenderPreview();
  return pending;
}

async function openPullCollection(rowId, collectionId, collectionName) {
  // scroll the TMDB panel into view and show loading state
  cancelTMDBPreview();
  const previewEl = document.getElementById('tmdbPreview');
  const resultsEl = document.getElementById('tmdbResults');
  if (!previewEl) return;
  resultsEl.innerHTML = '';
  const queryEl = document.getElementById('tmdbQuery');
  if (queryEl) queryEl.value = '';
  previewEl.innerHTML = `<div class="tmdb-loading">Loading ${esc(collectionName)}…</div>`;
  previewEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

  try {
    let data;
    try { data = await tmdbFetch(`/collection/${collectionId}`); }
    catch (e) {
      collectionLookups.set(collectionId, { status: 'failed', error: (e && e.message) || 'TMDB didn’t answer' });
      redrawFilmCollectionSections(collectionId);
      throw e;
    }
    noteCollectionParts(collectionId, data);
    redrawFilmCollectionSections(collectionId);
    const movies = (data.parts || []).slice().sort((a,b) => (a.release_date||'9999').localeCompare(b.release_date||'9999'));
    const existingRows = toolKnownRows(toolCollectionId()); // library-wide in All Movies (library.js)
    const film = existingRows.find(r => r.id === rowId);
    const offer = collectionOffer(collectionId, film ? film.tmdb_id : null, existingRows);

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
        ${offer.kind === 'sole' || !rowsHtml ? '<div class="tmdb-no-results">No other movies found in this collection.</div>'
          : offer.kind === 'present' ? `<div class="tmdb-refresh-summary">${COLLECTION_PRESENT_TEXT}</div>` : ''}
        ${offer.kind === 'sole' ? '' : rowsHtml}
        <div class="tmdb-preview-actions">
          ${offer.kind === 'addable' ? '<button class="btn btn-accent" onclick="addPulledCollectionMovies()">Add selected</button>' : ''}
          <button class="btn" onclick="cancelTMDBPreview()">${offer.kind === 'addable' ? 'Cancel' : 'Close'}</button>
        </div>
      </div>
    `;
  } catch(e) {
    previewEl.innerHTML = `<div class="tmdb-no-results">Failed to load collection: ${esc(e.message)}</div>`;
  }
}

// One change at a time (write-lane.js): held through the lookups, writes and the reread.
function addPulledCollectionMovies() {
  return runWrite('Adding films', () => addPulledCollectionMoviesNow());
}
async function addPulledCollectionMoviesNow() {
  const data = window.__pullCollectionData;
  if (!data) return;
  // The tab this preview belongs to, captured before any await: the TMDB lookups
  // below take a while, and the user may switch tabs or views meanwhile.
  const collectionId = toolCollectionId(); // All Movies' panel (library.js)
  if (!collectionId) return;
  const tool = toolContext(collectionId);
  const checkboxes = document.querySelectorAll('#tmdbPreview input[type="checkbox"][data-movie-id]');
  const moviesById = {};
  data.movies.forEach(m => moviesById[m.id] = m);
  const seenTmdbIds = new Set();

  const toInsert = [];
  const failedTitles = [];
  let selected = 0;
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
    selected++;
    // fetch full details for genre/runtime accuracy, same as a normal add
    let details;
    try { details = await tmdbFetch(`/movie/${movieId}`); } catch(e) { failedTitles.push(summary.title); continue; }
    toInsert.push(toolFilmRow(details, summary.title, movieId, { id: data.collectionId, name: data.tmdbCollectionName }, [data.tmdbCollectionName]));
  }

  const failureNote = tmdbAddFailureNote(selected, failedTitles, 'film');
  if (toInsert.length === 0) {
    // keep the preview open when every lookup failed, so the user can retry
    if (failureNote) showError(failureNote); else if (toolContextLive(tool)) cancelTMDBPreview();
    return;
  }

  try {
    const inserted = await libraryInsertFilms(toInsert);
    toolCachePush(tool, inserted);
    showSaved();
    if (toolContextLive(tool)) resetTMDBSearchUI();
    await toolFinished(tool);
    if (typeof collectionPullReport === 'function') collectionPullReport(tool, inserted); // S4: Pull rest from a collection
    if (failureNote) showError(failureNote);
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
  const queryEl = document.getElementById('tmdbQuery');
  if (queryEl) queryEl.value = '';
  previewEl.innerHTML = `<div class="tmdb-loading">Checking your tracked collections…</div>`;

  const td = tabData[toolCollectionId()];
  const rows = td?.rows || [];
  const known = toolKnownRows(toolCollectionId()); // library-wide in All Movies (library.js)

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
    const failedCollections = [];
    for (const [collectionId, collectionName] of collectionsMap.entries()) {
      let data;
      try { data = await tmdbFetch(`/collection/${collectionId}`); }
      catch(e) {
        collectionLookups.set(collectionId, { status: 'failed', error: (e && e.message) || 'TMDB didn’t answer' });
        failedCollections.push(cleanCollectionName(collectionName));
        continue;
      }
      noteCollectionParts(collectionId, data); // the films' menus see what this check found
      const movies = data.parts || [];
      const newOnes = movies.filter(m => !isAlreadyAdded(known, { itemKey: `${m.title.toLowerCase().trim()}|film`, mediaType: 'movie', tmdbId: m.id }));
      if (newOnes.length > 0) {
        newByCollection.push({ collectionId, collectionName: data.name || collectionName, newOnes });
      }
    }

    const lookupNote = tmdbLookupFailureNote(collectionsMap.size, failedCollections, 'collection');
    if (lookupNote?.total) {
      previewEl.innerHTML = `<div class="tmdb-no-results">${esc(lookupNote.message)}</div>`;
      return;
    }
    const warningHtml = lookupNote ? `<div class="tmdb-refresh-summary">⚠️ ${esc(lookupNote.message)}</div>` : '';

    if (newByCollection.length === 0) {
      previewEl.innerHTML = lookupNote
        ? `${warningHtml}<div class="tmdb-refresh-summary">No new movies in the collections that were checked.</div>`
        : `<div class="tmdb-refresh-summary">✓ Everything's up to date — no new movies found across ${collectionsMap.size} tracked collection${collectionsMap.size===1?'':'s'}.</div>`;
      return;
    }

    let html = `<div class="tmdb-preview">${warningHtml}<div class="tmdb-preview-title">New movies found</div>`;
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

// One change at a time (write-lane.js): held through the lookups, writes and the reread.
function addRefreshedCollectionMovies() {
  return runWrite('Adding films', () => addRefreshedCollectionMoviesNow());
}
async function addRefreshedCollectionMoviesNow() {
  const data = window.__refreshCollectionsData || [];
  // The tab this preview belongs to, captured before any await: the TMDB lookups
  // below take a while, and the user may switch tabs or views meanwhile.
  const collectionId = toolCollectionId(); // All Movies' panel (library.js)
  if (!collectionId) return;
  const tool = toolContext(collectionId);
  const checkboxes = document.querySelectorAll('#tmdbPreview input[type="checkbox"][data-collection-idx]');
  const toInsert = [];
  const failedTitles = [];
  let selected = 0;

  for (const cb of checkboxes) {
    if (!cb.checked) continue;
    const idx = parseInt(cb.dataset.collectionIdx, 10);
    const movieId = parseInt(cb.dataset.movieId, 10);
    const entry = data[idx];
    if (!entry) continue;
    const summary = entry.newOnes.find(m => m.id === movieId);
    if (!summary) continue;
    selected++;
    let details;
    try { details = await tmdbFetch(`/movie/${movieId}`); } catch(e) { failedTitles.push(summary.title); continue; }
    toInsert.push(toolFilmRow(details, summary.title, movieId, { id: entry.collectionId, name: entry.collectionName }, [entry.collectionName]));
  }

  const failureNote = tmdbAddFailureNote(selected, failedTitles, 'film');
  if (toInsert.length === 0) {
    // keep the preview open when every lookup failed, so the user can retry
    if (failureNote) showError(failureNote); else if (toolContextLive(tool)) cancelTMDBPreview();
    return;
  }

  try {
    const inserted = await libraryInsertFilms(toInsert);
    toolCachePush(tool, inserted);
    showSaved();
    if (toolContextLive(tool)) resetTMDBSearchUI();
    await toolFinished(tool);
    if (failureNote) showError(failureNote);
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
  // In All Movies (Stage 4b) the refresh runs in its "+ Add" panel (library.js).
  linkSpan.innerHTML = activeViewId
    ? `<button class="collection-refresh-link" onclick="libraryRefreshPerson('${nameEsc}')">↻ Refresh</button>`
    : `<button class="collection-refresh-link" onclick="refreshPersonCollection('${nameEsc}')">↻ Refresh</button>`;
}
