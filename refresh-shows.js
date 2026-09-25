async function refreshShows() {
  cancelTMDBPreview();
  const previewEl = document.getElementById('tmdbPreview');
  const resultsEl = document.getElementById('tmdbResults');
  resultsEl.innerHTML = '';
  previewEl.innerHTML = `<div class="tmdb-loading">Checking for new seasons…</div>`;

  try {
    const trackedShows = await sbFetch('GET', `othertv_shows?collection=eq.${encodeURIComponent(activeTabId)}&select=*`, null);
    if (!trackedShows || trackedShows.length === 0) {
      previewEl.innerHTML = `<div class="tmdb-no-results">No shows added via search yet — nothing to refresh.</div>`;
      return;
    }

    const existingRows = tabData[activeTabId]?.rows || [];
    const newSeasonsByShow = [];

    for (const show of trackedShows) {
      let details;
      try {
        details = await tmdbFetch(`/tv/${show.tmdb_id}`);
      } catch(e) { continue; }
      const showKeyBase = show.title.toLowerCase().trim();
      const seasons = (details.seasons || []).filter(s => tmdbShowSpecials || s.season_number !== 0);
      const newOnes = seasons.filter(s => {
        const label = s.season_number === 0 ? 'specials' : `season ${s.season_number}`;
        return !isAlreadyAdded(existingRows, { itemKey: `${showKeyBase}|${label}`, mediaType: 'tv', tmdbId: show.tmdb_id, seasonNumber: s.season_number });
      });
      if (newOnes.length > 0) {
        newSeasonsByShow.push({ show, details, newOnes });
      }
    }

    if (newSeasonsByShow.length === 0) {
      previewEl.innerHTML = `<div class="tmdb-refresh-summary">✓ Everything's up to date — no new seasons found across ${trackedShows.length} tracked show${trackedShows.length===1?'':'s'}.</div>`;
      return;
    }

    let html = `<div class="tmdb-preview"><div class="tmdb-preview-title">New seasons found</div>`;
    newSeasonsByShow.forEach(({show, newOnes}, idx) => {
      html += `<div style="margin-top:10px"><div class="tmdb-result-title">${esc(show.title)}</div>`;
      newOnes.forEach(s => {
        const label = s.season_number === 0 ? 'Specials' : `Season ${s.season_number}`;
        const date = s.air_date ? formatDisplayDate(s.air_date) : 'TBA';
        html += `<div class="tmdb-season-row">
          <input type="checkbox" checked data-show-idx="${idx}" data-season="${s.season_number}">
          <span class="tmdb-season-name">${esc(label)}</span>
          <span class="tmdb-season-meta">${s.episode_count||0} episodes · ${esc(date)}</span>
        </div>`;
      });
      html += `</div>`;
    });
    html += `<div class="tmdb-preview-actions">
      <button class="btn btn-accent" onclick="addRefreshedSeasons()">Add selected seasons</button>
      <button class="btn" onclick="cancelTMDBPreview()">Cancel</button>
    </div></div>`;
    previewEl.innerHTML = html;
    window.__refreshData = newSeasonsByShow;
  } catch(e) {
    previewEl.innerHTML = `<div class="tmdb-no-results">Refresh failed: ${esc(e.message)}</div>`;
  }
}

async function addRefreshedSeasons() {
  const data = window.__refreshData || [];
  const checkboxes = document.querySelectorAll('#tmdbPreview input[type="checkbox"][data-show-idx]');
  const toInsert = [];

  checkboxes.forEach(cb => {
    if (!cb.checked) return;
    const idx = parseInt(cb.dataset.showIdx, 10);
    const num = parseInt(cb.dataset.season, 10);
    const entry = data[idx];
    if (!entry) return;
    const s = entry.newOnes.find(x => x.season_number === num);
    if (!s) return;
    const network = (entry.details.networks && entry.details.networks[0]?.name) || 'Unknown';
    const seasonLabel = num === 0 ? 'Specials' : `Season ${num}`;
    const key = `${entry.show.title.toLowerCase().trim()}|${seasonLabel.toLowerCase()}`;
    const displayDate = s.air_date ? formatDisplayDate(s.air_date) : 'TBA';
    const dateSort = s.air_date || '2099-01-01';
    toInsert.push({
      collection: activeTabId,
      item_key: key,
      title: entry.show.title,
      season: seasonLabel,
      theme: network,
      display_date: displayDate,
      date_sort: dateSort,
      watched: false,
      status: 'confirmed',
      media_type: 'tv',
      tmdb_id: entry.show.tmdb_id,
      season_number: num
    });
  });

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
      showError(duplicateInsertMessage('try "↻ Refresh shows" again for a fresh check'));
    } else {
      showError(e.message);
    }
  }
}
