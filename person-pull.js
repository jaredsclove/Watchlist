function togglePersonCollectionPrompt() {
  personCollectionPromptOpen = !personCollectionPromptOpen;
  const el = document.getElementById('personCollectionPrompt');
  if (!el) return;
  if (personCollectionPromptOpen) {
    el.style.display = 'block';
    el.innerHTML = `
      <div class="person-collection-prompt">
        <input id="personNameInput" type="text" placeholder="Director or actor name…" onkeydown="if(event.key==='Enter'){searchPersonForCollection();}">
        <button class="btn btn-accent" onclick="searchPersonForCollection()">Search</button>
      </div>
      <div id="personMatchResults"></div>
    `;
  } else {
    el.style.display = 'none';
    el.innerHTML = '';
  }
}

async function searchPersonForCollection() {
  const name = document.getElementById('personNameInput').value.trim();
  const resultsEl = document.getElementById('personMatchResults');
  if (!name) return;
  resultsEl.innerHTML = `<div class="tmdb-loading">Searching…</div>`;
  try {
    const data = await tmdbFetch(`/search/person?query=${encodeURIComponent(name)}`);
    const matches = (data.results || []).slice(0, 5);
    if (matches.length === 0) {
      resultsEl.innerHTML = `<div class="tmdb-no-results">No one found matching "${esc(name)}".</div>`;
      return;
    }
    resultsEl.innerHTML = matches.map(p => {
      const photo = p.profile_path ? `https://image.tmdb.org/t/p/w92${p.profile_path}` : '';
      const known = (p.known_for || []).map(k => k.title || k.name).filter(Boolean).slice(0,3).join(', ');
      const nameEsc = esc(p.name).replace(/'/g,"\\'");
      return `<div class="person-match-item" onclick="selectPersonForCollection(${p.id}, '${nameEsc}')">
        ${photo ? `<img class="person-match-photo" src="${photo}" alt="">` : '<div class="person-match-photo"></div>'}
        <div class="person-match-info">
          <div class="person-match-name">${esc(p.name)}</div>
          ${known ? `<div class="person-match-known">Known for: ${esc(known)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    resultsEl.innerHTML = `<div class="tmdb-no-results">Search failed: ${esc(e.message)}</div>`;
  }
}

async function selectPersonForCollection(personId, personName) {
  document.getElementById('personMatchResults').innerHTML = '';
  document.getElementById('personCollectionPrompt').style.display = 'none';
  personCollectionPromptOpen = false;
  cancelTMDBPreview();

  const previewEl = document.getElementById('tmdbPreview');
  previewEl.innerHTML = `<div class="tmdb-loading">Checking ${esc(personName)}'s credits…</div>`;

  let credits;
  try {
    credits = await tmdbFetch(`/person/${personId}/movie_credits`);
  } catch(e) {
    previewEl.innerHTML = `<div class="tmdb-no-results">Failed to load credits: ${esc(e.message)}</div>`;
    return;
  }
  const directorCount = (credits.crew || []).filter(c => c.job === 'Director').length;
  const castCount = (credits.cast || []).length;

  // smart default: if they've directed anything, default to Director; otherwise Actor
  const defaultRole = directorCount > 0 ? 'director' : 'actor';
  window.__personPullPending = { personId, personName, credits };

  previewEl.innerHTML = `
    <div class="tmdb-preview">
      <div class="tmdb-preview-header">
        <div class="tmdb-preview-title">${esc(personName)}</div>
        <div class="tmdb-result-meta">Which credits should count toward this collection?</div>
      </div>
      <div class="person-role-options">
        ${directorCount > 0 ? `<label class="person-role-option"><input type="radio" name="personRole" value="director" ${defaultRole==='director'?'checked':''}> Director only (${directorCount} film${directorCount===1?'':'s'})</label>` : ''}
        <label class="person-role-option"><input type="radio" name="personRole" value="actor" ${defaultRole==='actor'?'checked':''}> Actor only, lead/major roles (billing ≤ 15)</label>
        <label class="person-role-option"><input type="radio" name="personRole" value="actor-all"> Actor only, every credited role (${castCount} total — often very noisy)</label>
        ${directorCount > 0 ? `<label class="person-role-option"><input type="radio" name="personRole" value="both"> Both director and major acting roles</label>` : ''}
      </div>
      <div class="tmdb-preview-actions">
        <button class="btn btn-accent" onclick="confirmPersonRole()">Continue</button>
        <button class="btn" onclick="cancelTMDBPreview()">Cancel</button>
      </div>
    </div>
  `;
}

async function confirmPersonRole() {
  const pending = window.__personPullPending;
  if (!pending) return;
  const selected = document.querySelector('input[name="personRole"]:checked');
  const role = selected ? selected.value : 'director';
  await pullPersonFilmography(pending.personId, pending.personName, /*isNewCollection*/ true, role, pending.credits);
}

async function pullPersonFilmography(personId, personName, isNewCollection, role, preloadedCredits) {
  cancelTMDBPreview();
  const resultsEl = document.getElementById('tmdbResults');
  const previewEl = document.getElementById('tmdbPreview');
  resultsEl.innerHTML = '';
  previewEl.innerHTML = `<div class="tmdb-loading">Loading ${esc(personName)}'s filmography…</div>`;

  const td = tabData[activeTabId];
  const existingRows = td?.rows || [];

  try {
    const credits = preloadedCredits || await tmdbFetch(`/person/${personId}/movie_credits`);
    const CAST_ORDER_CUTOFF = 15; // roughly "billed in the main cast", excludes background/cameo noise
    const asDirector = (credits.crew || []).filter(c => c.job === 'Director');
    const asMajorCast = (credits.cast || []).filter(c => typeof c.order === 'number' && c.order <= CAST_ORDER_CUTOFF);
    const asAllCast = credits.cast || [];

    let sourceLists = [];
    if (role === 'director') sourceLists = [asDirector];
    else if (role === 'actor') sourceLists = [asMajorCast];
    else if (role === 'actor-all') sourceLists = [asAllCast];
    else if (role === 'both') sourceLists = [asDirector, asMajorCast];
    else sourceLists = [asDirector]; // fallback default

    const merged = new Map();
    sourceLists.flat().forEach(m => { if (!merged.has(m.id)) merged.set(m.id, m); });
    const movies = [...merged.values()].sort((a,b) => (a.release_date||'9999').localeCompare(b.release_date||'9999'));

    if (isNewCollection) {
      // save the collection definition once (including the role filter), so a later refresh
      // knows who to re-check and applies the same director/actor filter consistently
      try {
        await sbFetch('POST', 'custom_collections', [{ name: personName, tmdb_person_id: personId, role }]);
      } catch(e) {
        // Expected: this collection name already exists (unique constraint on name) —
        // fine, nothing to do. Anything else is a real failure and should be surfaced,
        // since it means the "↻ Refresh" link for this collection won't work later.
        if (!(e.message.includes('23505') || e.message.includes('duplicate key'))) {
          showError(`Movies added, but couldn't save this collection for future refresh checks: ${e.message}`);
        }
      }
    }

    let backfilled = 0;
    const found = [];
    for (const m of movies) {
      const title = m.title;
      const key = `${title.toLowerCase().trim()}|film`;
      // TMDB-first: a genuine tmdb_id match on an existing movie row means this
      // IS the same film, regardless of title text. Uses the same shared helper
      // as every other TMDB-driven flow, so this can't drift out of sync with
      // the canonical identity rules.
      const existingRow = findExistingRow(existingRows, { itemKey: key, mediaType: 'movie', tmdbId: m.id });
      if (existingRow) {
        const currentCollections = existingRow.collections || [];
        if (!currentCollections.includes(personName)) {
          const updated = [...currentCollections, personName];
          try {
            await sbFetch('PATCH', `${TABLE}?id=eq.${existingRow.id}`, { collections: updated });
            existingRow.collections = updated;
            backfilled++;
          } catch(e) { /* non-fatal */ }
        }
        found.push({ title, alreadyAdded: true, releaseDate: m.release_date });
      } else {
        found.push({ title, tmdbId: m.id, releaseDate: m.release_date, alreadyAdded: false });
      }
    }

    // Two or more credits with the same title (e.g. a short and the feature it
    // became) are different TMDB films. Show their years prominently and leave
    // them all unchecked so the user picks explicitly; unique titles keep the
    // default-checked behavior.
    const titleCounts = {};
    found.forEach(m => { const k = normalizeTmdbTitle(m.title); titleCounts[k] = (titleCounts[k] || 0) + 1; });
    const isSameTitleAlt = m => titleCounts[normalizeTmdbTitle(m.title)] > 1;
    const sameTitleCount = found.filter(isSameTitleAlt).length;

    const rowsHtml = found.map(m => {
      const date = m.releaseDate ? formatDisplayDate(m.releaseDate) : 'TBA';
      const alt = isSameTitleAlt(m);
      const year = m.releaseDate ? m.releaseDate.slice(0, 4) : 'year unknown';
      return `<div class="tmdb-season-row ${m.alreadyAdded?'already-added':''}">
        <input type="checkbox" ${m.alreadyAdded?'disabled':(alt?'':'checked')} data-tmdb-id="${m.tmdbId||''}" data-title="${esc(m.title)}" id="pc_${m.tmdbId||m.title.replace(/\W/g,'')}">
        <span class="tmdb-season-name">${esc(m.title)}${alt ? ` <strong>(${esc(year)})</strong>` : ''}</span>
        <span class="tmdb-season-meta">${esc(date)}</span>
        ${m.alreadyAdded ? '<span class="tmdb-already-tag">Already added</span>' : ''}
        ${alt ? '<span class="tmdb-already-tag">Same title as another credit — check the year</span>' : ''}
      </div>`;
    }).join('');

    const backfillHtml = backfilled > 0
      ? `<div class="tmdb-refresh-summary">✓ Tagged ${backfilled} already-added movie${backfilled===1?'':'s'} with "${esc(personName)}" that were missing it.</div>`
      : '';

    window.__personPullName = personName;

    previewEl.innerHTML = `
      <div class="tmdb-preview">
        <div class="tmdb-preview-header">
          <div class="tmdb-preview-title">${esc(personName)}</div>
          <div class="tmdb-result-meta">${found.filter(f=>!f.alreadyAdded).length} new, ${found.filter(f=>f.alreadyAdded).length} already on your list — everything's checked, deselect anything you don't want${sameTitleCount ? ` (${sameTitleCount} same-title credits are left unchecked for you to choose)` : ''}</div>
        </div>
        ${backfillHtml}
        ${rowsHtml || '<div class="tmdb-no-results">No film credits found.</div>'}
        <div class="tmdb-preview-actions">
          <button class="btn btn-accent" onclick="addPulledPersonMovies()">Add selected</button>
          <button class="btn" onclick="cancelTMDBPreview()">Cancel</button>
        </div>
      </div>
    `;
    if (backfilled > 0) { showSaved(); renderFilters(); renderTable(); }
  } catch(e) {
    previewEl.innerHTML = `<div class="tmdb-no-results">Failed to load filmography: ${esc(e.message)}</div>`;
  }
}

async function addPulledPersonMovies() {
  const personName = window.__personPullName;
  if (!personName) return;
  const isMoviesTab = COLLECTIONS.find(c => c.id === activeTabId)?.isMovieTab;
  const checkboxes = document.querySelectorAll('#tmdbPreview input[type="checkbox"][data-tmdb-id]');
  const seenTmdbIds = new Set();
  const toInsert = [];

  for (const cb of checkboxes) {
    if (!cb.checked || cb.disabled) continue;
    const tmdbId = cb.dataset.tmdbId;
    const title = cb.dataset.title;
    if (!tmdbId) continue;
    // Dedupe by tmdbId, not by title/item_key — every selected checkbox here
    // already carries a real TMDB movie ID, so two different movies that
    // happen to share a title must never be conflated into one skipped entry.
    if (seenTmdbIds.has(tmdbId)) continue; // guard against the exact same movie appearing twice in this batch
    seenTmdbIds.add(tmdbId);
    const key = `${title.toLowerCase().trim()}|film`;
    let details;
    try { details = await tmdbFetch(`/movie/${tmdbId}`); } catch(e) { continue; }
    const network = isMoviesTab
      ? ((details.genres && details.genres[0]?.name) || 'Film')
      : ((details.production_companies && details.production_companies[0]?.name) || 'Film');
    const displayDate = details.release_date ? formatDisplayDate(details.release_date) : 'TBA';
    const dateSort = details.release_date || '2099-01-01';
    const belongsTo = details.belongs_to_collection;
    const collections = belongsTo ? [cleanCollectionName(belongsTo.name), personName] : [personName];
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
    if (e.message.includes('23505') || e.message.includes('duplicate key')) {
      showError(`One or more of these movies is already on your list but wasn't detected in time — try clicking "+ start a person collection" again for a fresh check, or reload the page first.`);
    } else {
      showError(e.message);
    }
  }
}

async function refreshPersonCollection(collectionName) {
  try {
    const rows = await sbFetch('GET', `custom_collections?name=eq.${encodeURIComponent(collectionName)}&select=*`, null);
    const entry = (rows || [])[0];
    if (!entry) {
      showError(`Couldn't find a linked person for "${collectionName}" — it may be an older collection from before this feature existed.`);
      return;
    }
    await pullPersonFilmography(entry.tmdb_person_id, entry.name, /*isNewCollection*/ false, entry.role || 'director');
    document.getElementById('tmdbPreview')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch(e) {
    showError(e.message);
  }
}
