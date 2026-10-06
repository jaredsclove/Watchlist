// ─── Match to TMDB ────────────────────────────────────────────────────────────
// Gives an unidentified row on a dynamic tab (a manual "+ Add entry" row) the TMDB
// identity the user explicitly picks: search → click a result → for a series, pick
// the season → confirm a before/after summary. Nothing is guessed from the title,
// and the first result is never taken automatically. The row is updated in place,
// so its id, created_at, watched, watch_with, status and tags are kept.
// Static-tab defaults are not eligible: loadTab reseeds them by item_key, so a
// rewritten item_key would bring the default back as a duplicate.

function isTmdbMatchEligible(row) {
  const col = COLLECTIONS.find(c => c.id === row.collection);
  return !!col?.dynamic && row.tmdb_id == null && row.media_type == null && row.season_number == null;
}

// The fields a confirmed match writes, in the same shape the app gives rows it adds
// from TMDB. target: { mediaType: 'movie', details } for a film (TMDB /movie/{id}),
// or { mediaType: 'tv', details, seasonNumber } for a season (TMDB /tv/{id}).
// Returns null for a series with no valid season chosen.
function buildTmdbMatchPatch(row, target, isMoviesTab) {
  const d = target.details;
  if (target.mediaType === 'movie') {
    const belongsTo = d.belongs_to_collection;
    const patch = {
      title: d.title,
      season: 'Film',
      item_key: `${d.title.toLowerCase().trim()}|film`,
      theme: isMoviesTab
        ? ((d.genres && d.genres[0]?.name) || 'Film')
        : ((d.production_companies && d.production_companies[0]?.name) || 'Film'),
      display_date: d.release_date ? formatDisplayDate(d.release_date) : 'TBA',
      date_sort: d.release_date || '2099-01-01',
      tmdb_collection_id: belongsTo ? belongsTo.id : null,
      tmdb_collection_name: belongsTo ? belongsTo.name : null,
      media_type: 'movie',
      tmdb_id: d.id,
      season_number: null
    };
    // keep the user's tags; only add TMDB's franchise name if it isn't there yet
    const tags = row.collections || [];
    if (belongsTo && !tags.includes(belongsTo.name)) patch.collections = [...tags, belongsTo.name];
    return patch;
  }
  const num = target.seasonNumber;
  const s = Number.isInteger(num) ? (d.seasons || []).find(x => x.season_number === num) : null;
  if (!s) return null;
  const label = num === 0 ? 'Specials' : `Season ${num}`;
  return {
    title: d.name,
    season: label,
    item_key: `${d.name.toLowerCase().trim()}|${label.toLowerCase()}`,
    theme: (d.networks && d.networks[0]?.name) || 'Unknown',
    display_date: s.air_date ? formatDisplayDate(s.air_date) : 'TBA',
    date_sort: s.air_date || '2099-01-01',
    media_type: 'tv',
    tmdb_id: d.id,
    season_number: num
  };
}

// Another row in the same collection that blocks the match: one that already has
// the target TMDB identity, or an unidentified row already using the new item_key.
// Identified rows that merely share the title (a different TMDB id) never block it.
function findTmdbMatchConflict(row, patch, rows) {
  const others = rows.filter(r => r.id !== row.id && r.collection === row.collection);
  const sameIdentity = others.find(r => r.media_type === patch.media_type && r.tmdb_id === patch.tmdb_id &&
    (patch.media_type === 'movie' || r.season_number === patch.season_number));
  if (sameIdentity) return { kind: 'identity', row: sameIdentity };
  const sameLegacyKey = others.find(r => r.tmdb_id == null && r.item_key === patch.item_key);
  if (sameLegacyKey) return { kind: 'item_key', row: sameLegacyKey };
  return null;
}

function tmdbMatchConflictMessage(conflict) {
  const who = `"${conflict.row.title} — ${conflict.row.season}"`;
  return conflict.kind === 'identity'
    ? `${who} is already on this list as that TMDB ${conflict.row.media_type === 'movie' ? 'film' : 'season'}. Nothing was changed; remove one of the two rows yourself if they're the same.`
    : `Another unmatched row, ${who}, already uses that title and season. Nothing was changed; match or remove that row first.`;
}

// ─── UI ───────────────────────────────────────────────────────────────────────
// State lives in window.__tmdbMatch while the panel is open:
// { rowId, results, target: { mediaType, details, seasonNumber } }

function tmdbMatchRow() {
  const m = window.__tmdbMatch;
  return m ? (tabData[activeTabId]?.rows || []).find(r => r.id === m.rowId) : null;
}

function openTmdbMatch(rowId) {
  const row = (tabData[activeTabId]?.rows || []).find(r => r.id === rowId);
  if (!row || !isTmdbMatchEligible(row)) return;
  cancelTMDBPreview();
  document.querySelectorAll('.more-popover').forEach(p => p.style.display = 'none');
  document.getElementById('tmdbResults').innerHTML = '';
  window.__tmdbMatch = { rowId, results: [], target: null };
  const previewEl = document.getElementById('tmdbPreview');
  previewEl.innerHTML = `
    <div class="tmdb-preview">
      <div class="tmdb-preview-title">Match to TMDB</div>
      <div class="tmdb-result-meta">${esc(row.title)} — ${esc(row.season)} · ${esc(row.display_date)}</div>
      <div class="tmdb-search-row" style="margin-top:10px">
        <input id="tmdbMatchQuery" type="text" value="${esc(row.title)}" onkeydown="if(event.key==='Enter'){searchTmdbMatch();}">
        <button class="btn btn-accent" onclick="searchTmdbMatch()">Search</button>
        <button class="btn" onclick="cancelTmdbMatch()">Cancel</button>
      </div>
      <div id="tmdbMatchBody"></div>
    </div>`;
  previewEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  searchTmdbMatch();
}

function cancelTmdbMatch() {
  window.__tmdbMatch = null;
  cancelTMDBPreview();
}

async function searchTmdbMatch() {
  const m = window.__tmdbMatch;
  const body = document.getElementById('tmdbMatchBody');
  const query = document.getElementById('tmdbMatchQuery')?.value.trim();
  if (!m || !body) return;
  if (!query) { body.innerHTML = ''; return; }
  m.target = null;
  body.innerHTML = `<div class="tmdb-loading">Searching…</div>`;
  try {
    const [tvData, movieData] = await Promise.all([
      tmdbFetch(`/search/tv?query=${encodeURIComponent(query)}&page=1`),
      tmdbFetch(`/search/movie?query=${encodeURIComponent(query)}&page=1`)
    ]);
    const tvResults = (tvData.results || []).map(r => ({ ...r, mediaType: 'tv' }));
    const movieResults = (movieData.results || []).map(r => ({ ...r, mediaType: 'movie' }));
    m.results = selectTmdbSearchResults(tvResults, movieResults, tmdbSearchModeFor(COLLECTIONS.find(c => c.id === activeTabId)));
    if (m.results.length === 0) { body.innerHTML = `<div class="tmdb-no-results">No results found for "${esc(query)}".</div>`; return; }
    body.innerHTML = `<div class="tmdb-refresh-summary">Pick the exact title — nothing is matched until you confirm.</div>
      <div class="tmdb-result-list">${m.results.map((r, idx) => {
        const isMovie = r.mediaType === 'movie';
        const dateStr = isMovie ? r.release_date : r.first_air_date;
        return `<div class="tmdb-result-item" onclick="chooseTmdbMatchResult(${idx})">
          <div class="tmdb-result-info">
            <div class="tmdb-result-title">${esc(isMovie ? r.title : r.name)} <span class="tmdb-type-tag ${isMovie ? 'tmdb-type-movie' : 'tmdb-type-tv'}">${isMovie ? 'Film' : 'Series'}</span></div>
            <div class="tmdb-result-meta">${dateStr ? esc(dateStr.substring(0, 4)) : '—'}${r.origin_country?.length ? ' · ' + esc(r.origin_country.join(', ')) : ''} · TMDB ${r.id}</div>
          </div>
        </div>`;
      }).join('')}</div>`;
  } catch(e) {
    body.innerHTML = `<div class="tmdb-no-results">Search failed: ${esc(e.message)}</div>`;
  }
}

async function chooseTmdbMatchResult(idx) {
  const m = window.__tmdbMatch;
  const body = document.getElementById('tmdbMatchBody');
  const picked = m?.results[idx];
  if (!picked || !body) return;
  body.innerHTML = `<div class="tmdb-loading">Loading details…</div>`;
  try {
    const details = await tmdbFetch(`/${picked.mediaType}/${picked.id}`);
    m.target = { mediaType: picked.mediaType, details, seasonNumber: null };
    renderTmdbMatchConfirm();
  } catch(e) {
    body.innerHTML = `<div class="tmdb-no-results">Failed to load details: ${esc(e.message)}</div>
      <div class="tmdb-preview-actions"><button class="btn" onclick="searchTmdbMatch()">Back to results</button></div>`;
  }
}

function chooseTmdbMatchSeason(num) {
  const m = window.__tmdbMatch;
  if (!m?.target) return;
  m.target.seasonNumber = num;
  renderTmdbMatchConfirm();
}

function renderTmdbMatchConfirm() {
  const m = window.__tmdbMatch;
  const row = tmdbMatchRow();
  const body = document.getElementById('tmdbMatchBody');
  if (!m?.target || !row || !body) return;
  const { mediaType, details } = m.target;
  const isMoviesTab = !!COLLECTIONS.find(c => c.id === activeTabId)?.isMovieTab;
  let html = `<div class="tmdb-result-title" style="margin-top:10px">${esc(mediaType === 'movie' ? details.title : details.name)}
    <span class="tmdb-type-tag ${mediaType === 'movie' ? 'tmdb-type-movie' : 'tmdb-type-tv'}">${mediaType === 'movie' ? 'Film' : 'Series'}</span> · TMDB ${details.id}</div>`;
  if (mediaType === 'tv') {
    // No season is pre-selected: the user must choose one.
    const seasons = (details.seasons || []).slice().sort((a, b) => a.season_number - b.season_number);
    html += `<div class="tmdb-refresh-summary">Which season is this row?</div>` + (seasons.map(s => `
      <label class="tmdb-season-row">
        <input type="radio" name="tmdbMatchSeason" ${m.target.seasonNumber === s.season_number ? 'checked' : ''} onchange="chooseTmdbMatchSeason(${s.season_number})">
        <span class="tmdb-season-name">${s.season_number === 0 ? 'Specials' : `Season ${s.season_number}`}</span>
        <span class="tmdb-season-meta">${s.episode_count || 0} episodes · ${s.air_date ? esc(formatDisplayDate(s.air_date)) : 'TBA'}</span>
      </label>`).join('') || '<div class="tmdb-no-results">This series has no seasons on TMDB.</div>');
  }
  const patch = buildTmdbMatchPatch(row, m.target, isMoviesTab);
  if (patch) {
    const line = (label, before, after) => `<div class="modal-row"><span>${esc(label)}</span><span>${before === after ? esc(String(after)) : `${esc(String(before))} → <strong>${esc(String(after))}</strong>`}</span></div>`;
    const tmdbAfter = `${patch.media_type === 'movie' ? 'Film' : 'Series'} ${patch.tmdb_id}${patch.season_number != null ? `, season ${patch.season_number}` : ''}`;
    const addedTag = patch.collections ? patch.collections[patch.collections.length - 1] : null;
    html += `<div class="tmdb-refresh-summary" style="margin-top:12px">This row will change:</div>
      ${line('Title', row.title, patch.title)}
      ${line('Season', row.season, patch.season)}
      ${line('Date', row.display_date, patch.display_date)}
      ${line(isMoviesTab ? 'Genre' : 'Network', row.theme, patch.theme)}
      ${line('TMDB', 'not matched', tmdbAfter)}
      ${addedTag ? line('Tag added', '—', addedTag) : ''}
      <div class="tmdb-refresh-summary">Kept as is: watched, status, watch with${row.collections?.length ? ', existing tags' : ''}.</div>`;
  }
  html += `<div class="tmdb-preview-actions" style="flex-wrap:wrap">
      <button class="btn btn-accent" onclick="confirmTmdbMatch()" ${patch ? '' : 'disabled'}>Confirm match</button>
      <button class="btn" onclick="searchTmdbMatch()">Back to results</button>
      <button class="btn" onclick="cancelTmdbMatch()">Cancel</button>
    </div>`;
  body.innerHTML = html;
}

async function confirmTmdbMatch() {
  const m = window.__tmdbMatch;
  const row = tmdbMatchRow();
  if (!m?.target || !row) return;
  const isMoviesTab = !!COLLECTIONS.find(c => c.id === activeTabId)?.isMovieTab;
  const patch = buildTmdbMatchPatch(row, m.target, isMoviesTab);
  if (!patch) return;
  const viaShowFunction = patch.media_type === 'tv' && isTvCollection(row.collection);
  // How far the match got, so a failure is reported for what actually happened:
  // 'check' (nothing sent yet), 'write' (the match was sent: match_tv_row or the
  // guarded PATCH, each one database transaction), 'verify' (the database accepted
  // the PATCH; the page is reading the row back to see what it now holds).
  let stage = 'check';
  try {
    // Fresh check against the database (not just this page's copy): does another row
    // already hold this identity, or an unmatched row already use the new item_key?
    const identityFilter = `media_type=eq.${patch.media_type}&tmdb_id=eq.${patch.tmdb_id}` +
      (patch.media_type === 'tv' ? `&season_number=eq.${patch.season_number}` : '');
    const col = `collection=eq.${encodeURIComponent(row.collection)}`;
    const [sameIdentity, sameKey] = await Promise.all([
      sbFetch('GET', `${TABLE}?${col}&${identityFilter}&select=*`, null),
      sbFetch('GET', `${TABLE}?${col}&tmdb_id=is.null&item_key=eq.${encodeURIComponent(patch.item_key)}&select=*`, null)
    ]);
    const conflict = findTmdbMatchConflict(row, patch, [...(sameIdentity || []), ...(sameKey || [])]);
    if (conflict) { showError(tmdbMatchConflictMessage(conflict)); return; }

    // Only a row that is still unmatched is updated; the database's unique indexes
    // are the final guard against a match made elsewhere at the same moment.
    let fresh;
    stage = 'write';
    if (viaShowFunction) {
      // match_tv_row moves the season to its identified show (checked by Refresh
      // shows from then on) and re-checks both conflicts in the database.
      // p_expansion asks the database to refuse (and describe) a match that would
      // show a target show's other seasons in more collections; the previous
      // schema has no such parameter, so it's sent only with personal collections.
      const res = await sbRpc('match_tv_row', { p_row_id: row.id, p_target: { tmdb_id: patch.tmdb_id, network: patch.theme }, p_patch: patch,
        ...(typeof orgState !== 'undefined' && orgState === 'absent' ? {} : { p_expansion: {} }) });
      if (res && res.blocked && res.reason === 'membership_expansion') {
        const names = (res.collections || []).map(c => c.name).join(', ');
        showError(`Not matched: "${patch.title}" is already on this list, and matching would also show all ${res.seasons} of its saved seasons in ${names}. `
          + 'Confirming that isn’t available yet, so nothing was changed.');
        return;
      }
      if (res && res.blocked) {
        // The identified show is already on this list with a different status;
        // nothing was written. Matching never changes a show's status.
        showError(`Not matched: "${patch.title}" is already on this list as ${statusOptionLabel(res.target_status).replace(/^\S+ /, '')}, `
          + `but this row's show is ${statusOptionLabel(res.legacy_status).replace(/^\S+ /, '')}. Give both the same status first, then match again.`);
        return;
      }
      fresh = res && res.row;
    } else {
      // A row matched as a film leaves the show it belonged to as a TV season.
      const formerShowId = row.show_id ?? null;
      const body = formerShowId != null ? { ...patch, show_id: null } : patch;
      await sbFetch('PATCH', `${TABLE}?id=eq.${row.id}&tmdb_id=is.null&media_type=is.null&season_number=is.null`, body);
      stage = 'verify';
      [fresh] = await sbFetch('GET', `${TABLE}?id=eq.${row.id}&select=*`, null) || [];
      // A show left with no seasons is removed, like deleting its last season.
      // The season link's ON DELETE RESTRICT refuses this while any season remains
      // (restrict_violation 23001; 23503 accepted too).
      if (formerShowId != null && fresh && fresh.show_id == null) {
        try {
          await sbFetch('DELETE', `tv_shows?id=eq.${formerShowId}`, null);
          tvShowsById.delete(formerShowId);
        } catch(e) {
          if (!/23001|23503/.test(String(e.message))) showError(`Matched, but couldn't remove the now-empty show: ${e.message}`);
        }
      }
    }
    if (!fresh || fresh.tmdb_id !== patch.tmdb_id || fresh.media_type !== patch.media_type || fresh.season_number !== patch.season_number) {
      showError('This row changed somewhere else before the match was saved, so nothing was matched. Reload the page and try again.');
      return;
    }
    Object.assign(row, fresh);
    // The season may have joined an existing show, or its show may now be identified.
    if (viaShowFunction) {
      try { await loadTvShows(row.collection); }
      catch(e) { showError(`Matched, but couldn't reload the show list: ${e.message}`); }
    }
  } catch(e) {
    const msg = String(e && e.message);
    // The PATCH was accepted (it changes the row only if it was still unmatched), but
    // the read-back failed: the outcome is unknown, so it isn't reported either way.
    if (stage === 'verify') {
      showError(`The database accepted the match, but the page couldn't read the row back to confirm the result (${msg}). `
        + 'It may already be matched: reload the page and check this row before matching it again.');
      return;
    }
    // The match was sent but no database answer came back (a network failure, not an
    // error from the database): it may or may not have been saved.
    if (stage === 'write' && !/^Supabase error \d+:/.test(msg)) {
      showError(`The match was sent, but no answer came back from the database (${msg}), so the page can't tell whether it was saved. `
        + 'Reload the page and check this row before matching it again.');
      return;
    }
    showError(/not_found: unidentified row|match_conflict: the row changed/.test(msg)
      ? 'This row changed somewhere else before the match was saved, so nothing was matched. Reload the page and try again.'
      // Another change to the same collections or show at the same moment: the
      // database refused the match as a whole (re-check or deadlock), so nothing was applied.
      : /match_conflict: the collections|40P01|deadlock detected/.test(msg)
        ? 'Something else was changing the same show or collections at that moment, so nothing was matched. Try again.'
      // The database cancelled the match transaction for taking too long (its lock wait
      // or the API's statement time limit): cancelled as a whole, nothing was applied.
      : /55P03|57014|lock timeout|statement timeout/.test(msg)
        ? 'The database didn’t finish the match in time, so it was cancelled and nothing was matched. Another change may have been using the same rows; try again.'
      : isDuplicateKeyError(e)
        ? 'That TMDB title was added to this list somewhere else just now, so nothing was changed. Reload the page to see it.'
        : msg);
    return;
  }

  // row.collection is where the row lives; the user may have switched tabs or
  // views while the checks and writes above were in flight.
  if (window.__tmdbMatch === m) window.__tmdbMatch = null;
  tabData[row.collection]?.rows.sort((a, b) => a.date_sort.localeCompare(b.date_sort));
  showSaved();
  if (activeTabId !== row.collection) return;
  cancelTMDBPreview();
  renderFilters();
  renderTable();
}
