// An existing identified TV season row whose stored date is still a "TBA"
// placeholder gets TMDB's season air_date once TMDB has one. A date already
// confirmed on the row is never overwritten. Returns only the date fields to
// PATCH, or null when there is nothing to update.
function tmdbSeasonDateUpdate(row, season) {
  if (!row || row.media_type !== 'tv' || row.tmdb_id == null) return null;
  if (!/TBA/i.test(row.display_date || '')) return null;
  if (!season || !/^\d{4}-\d{2}-\d{2}$/.test(season.air_date || '')) return null;
  return { display_date: formatDisplayDate(season.air_date), date_sort: season.air_date };
}

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
    const dateUpdates = [];
    const failedShows = [];

    for (const show of trackedShows) {
      let details;
      try {
        details = await tmdbFetch(`/tv/${show.tmdb_id}`);
      } catch(e) { failedShows.push(show.title); continue; }
      const showKeyBase = show.title.toLowerCase().trim();
      const seasons = (details.seasons || []).filter(s => tmdbShowSpecials || s.season_number !== 0);
      const newOnes = [];
      seasons.forEach(s => {
        const label = s.season_number === 0 ? 'specials' : `season ${s.season_number}`;
        const existing = findExistingRow(existingRows, { itemKey: `${showKeyBase}|${label}`, mediaType: 'tv', tmdbId: show.tmdb_id, seasonNumber: s.season_number });
        if (!existing) { newOnes.push(s); return; }
        const update = existing.tmdb_id === show.tmdb_id && existing.season_number === s.season_number
          ? tmdbSeasonDateUpdate(existing, s) : null;
        if (update) dateUpdates.push({ row: existing, update });
      });
      if (newOnes.length > 0) {
        newSeasonsByShow.push({ show, details, newOnes });
      }
    }

    const lookupNote = tmdbLookupFailureNote(trackedShows.length, failedShows, 'show');
    if (lookupNote?.total) {
      previewEl.innerHTML = `<div class="tmdb-no-results">${esc(lookupNote.message)}</div>`;
      return;
    }
    const warningHtml = lookupNote ? `<div class="tmdb-refresh-summary">⚠️ ${esc(lookupNote.message)}</div>` : '';

    if (newSeasonsByShow.length === 0 && dateUpdates.length === 0) {
      previewEl.innerHTML = lookupNote
        ? `${warningHtml}<div class="tmdb-refresh-summary">No new seasons or newly confirmed dates among the shows that were checked.</div>`
        : `<div class="tmdb-refresh-summary">✓ Everything's up to date — no new seasons or newly confirmed dates found across ${trackedShows.length} tracked show${trackedShows.length===1?'':'s'}.</div>`;
      return;
    }

    let html = `<div class="tmdb-preview">${warningHtml}`;
    if (newSeasonsByShow.length > 0) {
      html += `<div class="tmdb-preview-title">New seasons found</div>`;
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
    }
    if (dateUpdates.length > 0) {
      html += `<div class="tmdb-preview-title"${newSeasonsByShow.length > 0 ? ' style="margin-top:14px"' : ''}>Newly confirmed dates</div>`;
      dateUpdates.forEach(({row, update}, idx) => {
        html += `<div class="tmdb-season-row">
          <input type="checkbox" checked data-update-idx="${idx}">
          <span class="tmdb-season-name">${esc(row.title)} — ${esc(row.season)}: ${esc(row.display_date)} → ${esc(update.display_date)}</span>
        </div>`;
      });
    }
    html += `<div class="tmdb-preview-actions">
      <button class="btn btn-accent" onclick="addRefreshedSeasons()">${dateUpdates.length > 0 ? 'Apply selected' : 'Add selected seasons'}</button>
      <button class="btn" onclick="cancelTMDBPreview()">Cancel</button>
    </div></div>`;
    previewEl.innerHTML = html;
    window.__refreshData = newSeasonsByShow;
    window.__refreshDateUpdates = dateUpdates;
  } catch(e) {
    previewEl.innerHTML = `<div class="tmdb-no-results">Refresh failed: ${esc(e.message)}</div>`;
  }
}

async function addRefreshedSeasons() {
  // The tab this preview belongs to, captured before any await: the user may
  // switch tabs or views while the writes are in flight.
  const collectionId = activeTabId;
  if (!collectionId) return;
  const data = window.__refreshData || [];
  const dateUpdates = window.__refreshDateUpdates || [];
  const checkboxes = document.querySelectorAll('#tmdbPreview input[type="checkbox"][data-show-idx]');
  const toInsert = [];
  const toUpdate = [];

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
      collection: collectionId,
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

  document.querySelectorAll('#tmdbPreview input[type="checkbox"][data-update-idx]').forEach(cb => {
    if (!cb.checked) return;
    const entry = dateUpdates[parseInt(cb.dataset.updateIdx, 10)];
    if (entry) toUpdate.push(entry);
  });

  if (toInsert.length === 0 && toUpdate.length === 0) { cancelTMDBPreview(); return; }

  let changed = false;
  let outcome = null;
  try {
    if (toInsert.length > 0 && isTvCollection(collectionId)) {
      outcome = await addTvSeasonRows(collectionId, toInsert, inserted => {
        tabData[collectionId]?.rows.push(...inserted);
        changed = true;
      });
    } else if (toInsert.length > 0) {
      const inserted = await sbFetch('POST', TABLE, toInsert);
      if (inserted) tabData[collectionId]?.rows.push(...inserted);
      changed = true;
    }
    // Only the two date fields change. The filter re-checks identity and that
    // the row still holds the placeholder we previewed, so a row confirmed
    // elsewhere in the meantime is left alone.
    for (const { row, update } of toUpdate) {
      await sbFetch('PATCH',
        `${TABLE}?id=eq.${encodeURIComponent(row.id)}&media_type=eq.tv&tmdb_id=eq.${row.tmdb_id}&season_number=eq.${row.season_number}&display_date=eq.${encodeURIComponent(row.display_date)}`,
        update
      );
      row.display_date = update.display_date;
      row.date_sort = update.date_sort;
      changed = true;
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
    if (changed) {
      tabData[collectionId]?.rows.sort((a,b) => a.date_sort.localeCompare(b.date_sort));
      if (activeTabId === collectionId) renderTable();
    }
    if (isDuplicateKeyError(e)) {
      showError(duplicateInsertMessage('try "↻ Refresh shows" again for a fresh check'));
    } else {
      showError(e.message);
    }
  }
}
