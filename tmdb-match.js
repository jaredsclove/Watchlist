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
// { rowId, results, target: { mediaType, details, seasonNumber }, proposal, inFlight }
// proposal (Stage 3b-2): a collection expansion the database described, bound to
// this row, TMDB id and season and to the reply's token; anything that changes
// what is being matched discards it. inFlight: the request number of a match call
// in progress (Confirm, the seasons and Back wait for it; Cancel doesn't).

// The rows the Match controls came from: the open tab's, or (Stage 4b) the open
// view's (All TV, All Movies), whose Match panel is the view's "+ Add" panel.
function tmdbMatchRows() {
  return activeViewId ? actionRows() : (tabData[activeTabId]?.rows || []);
}

function tmdbMatchRow() {
  const m = window.__tmdbMatch;
  return m ? tmdbMatchRows().find(r => r.id === m.rowId) : null;
}

// The kind of row a Match is for decides the search and the theme, as on its tab.
function tmdbMatchCollection(row) {
  return COLLECTIONS.find(c => c.id === (row ? row.collection : activeTabId));
}

function openTmdbMatch(rowId) {
  const row = tmdbMatchRows().find(r => r.id === rowId);
  if (!row || !isTmdbMatchEligible(row)) return;
  if (activeViewId) openLibraryPanel(isFilmRow(row) ? 'movie' : 'tv', 'match');
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
  if (window.__tmdbMatch) window.__tmdbMatch.proposal = null;
  window.__tmdbMatch = null;
  cancelTMDBPreview();
}

async function searchTmdbMatch() {
  const m = window.__tmdbMatch;
  const body = document.getElementById('tmdbMatchBody');
  const query = document.getElementById('tmdbMatchQuery')?.value.trim();
  if (!m || !body || m.inFlight) return;
  if (!query) { body.innerHTML = ''; return; }
  m.target = null;
  m.proposal = null;
  body.innerHTML = `<div class="tmdb-loading">Searching…</div>`;
  try {
    const [tvData, movieData] = await Promise.all([
      tmdbFetch(`/search/tv?query=${encodeURIComponent(query)}&page=1`),
      tmdbFetch(`/search/movie?query=${encodeURIComponent(query)}&page=1`)
    ]);
    const tvResults = (tvData.results || []).map(r => ({ ...r, mediaType: 'tv' }));
    const movieResults = (movieData.results || []).map(r => ({ ...r, mediaType: 'movie' }));
    m.results = selectTmdbSearchResults(tvResults, movieResults, tmdbSearchModeFor(tmdbMatchCollection(tmdbMatchRow())));
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
  if (!picked || !body || m.inFlight) return;
  m.proposal = null;
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
  if (!m?.target || m.inFlight) return;
  m.proposal = null;
  m.target.seasonNumber = num;
  renderTmdbMatchConfirm();
}

function renderTmdbMatchConfirm() {
  const m = window.__tmdbMatch;
  const row = tmdbMatchRow();
  const body = document.getElementById('tmdbMatchBody');
  if (!m?.target || !row || !body || m.inFlight) return;
  m.proposal = null; // Back from a collection expansion: it no longer applies
  const { mediaType, details } = m.target;
  const isMoviesTab = !!tmdbMatchCollection(row)?.isMovieTab;
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

// withConfirmation: the user confirmed the collection expansion shown in the panel;
// it is sent only while the panel still shows that proposal for this row, TMDB id
// and season.
async function confirmTmdbMatch(withConfirmation) {
  const m = window.__tmdbMatch;
  const row = tmdbMatchRow();
  if (!m?.target || !row || m.inFlight) return;
  const isMoviesTab = !!tmdbMatchCollection(row)?.isMovieTab;
  const patch = buildTmdbMatchPatch(row, m.target, isMoviesTab);
  if (!patch) return;
  let expansion = {};
  if (withConfirmation === true) {
    const p = m.proposal;
    if (!p || p.rowId !== row.id || p.tmdbId !== patch.tmdb_id || p.seasonNumber !== patch.season_number) return;
    expansion = { confirm: p.token };
  }
  // Each call's stamp: a delayed answer is checked against what the page shows now.
  const stamp = { seq: ++matchRequestSeq, rowId: row.id, epoch: orgEpoch, rowObj: row, collection: row.collection, title: patch.title, viewId: activeViewId };
  matchLatestByRow[row.id] = stamp.seq;
  // Tracked like a read of the row: when the match is applied to the page it covers the row
  // (a refresh waiting on it is satisfied); otherwise it covers nothing.
  stamp.read = matchReadStart('match', row.collection, row.id);
  m.inFlight = stamp.seq;
  if (m.proposal) renderMatchProposal(m);
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
        ...(typeof orgState !== 'undefined' && orgState === 'absent' ? {} : { p_expansion: expansion }) });
      if (m.inFlight === stamp.seq) m.inFlight = 0;
      // A blocked answer wrote nothing: it's shown only if the panel still shows this request.
      const panelCurrent = window.__tmdbMatch === m && matchLatestByRow[row.id] === stamp.seq && stamp.epoch === orgEpoch;
      if (res && res.blocked && res.reason === 'membership_expansion') {
        if (!panelCurrent || m.target?.details?.id !== patch.tmdb_id || (m.target.seasonNumber ?? null) !== patch.season_number) return;
        await showMatchProposal(m, res, row, patch);
        return;
      }
      if (res && res.blocked && !panelCurrent) return;
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
    if (m.inFlight === stamp.seq) m.inFlight = 0;
    if (!fresh || fresh.tmdb_id !== patch.tmdb_id || fresh.media_type !== patch.media_type || fresh.season_number !== patch.season_number) {
      showError('This row changed somewhere else before the match was saved, so nothing was matched. Reload the page and try again.');
      return;
    }
    // A confirmed success is always reported; its row is put into the page only
    // while it is still current (same restore epoch, the page's copy of the row not
    // replaced by a newer read, no newer match of this row). Otherwise a fresh read,
    // under the current guards, shows what is saved now.
    const inView = !!stamp.viewId && activeViewId === stamp.viewId && actionRows().includes(stamp.rowObj);
    const stillCurrent = stamp.epoch === orgEpoch && matchLatestByRow[row.id] === stamp.seq
      && ((tabData[stamp.collection]?.rows || []).includes(stamp.rowObj) || inView);
    if (!stillCurrent) {
      if (window.__tmdbMatch === m) { window.__tmdbMatch = null; cancelTMDBPreview(); }
      refreshAfterMatch(stamp, stamp.epoch !== orgEpoch);
      // A view (Stage 4b) is read again under its own guards, keeping its filters.
      if (stamp.viewId && stamp.epoch === orgEpoch && activeViewId === stamp.viewId) reloadOpenView();
      return;
    }
    Object.assign(row, fresh);
    stamp.read.applied = true; // the page now shows the row as the database returned it
    matchNotePublished('rows', row.id, stamp.read, row);
    // The season may have joined an existing show, or its show may now be identified.
    if (viaShowFunction) {
      try { await loadTvShows(row.collection); }
      catch(e) { showError(`Matched, but couldn't reload the show list: ${e.message}`); }
    }
  } catch(e) {
    if (m.inFlight === stamp.seq) m.inFlight = 0;
    const msg = String(e && e.message);
    // After a restore in this page, an earlier attempt's error is labelled as such.
    const earlier = stamp.epoch !== orgEpoch ? `An earlier match attempt for “${patch.title}”: ` : '';
    const showError = text => window.showError(earlier + text);
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
  } finally {
    if (m.inFlight === stamp.seq) {
      m.inFlight = 0;
      if (window.__tmdbMatch === m && m.proposal) renderMatchProposal(m);
    }
    // The tracked Match ends: applied to the page (covers its row) or not (covers nothing).
    if (stamp.read.state === 'pending') matchReadSettle(stamp.read, null, !stamp.read.applied);
  }

  // row.collection is where the row lives; the user may have switched tabs or
  // views while the checks and writes above were in flight.
  if (window.__tmdbMatch === m) window.__tmdbMatch = null;
  tabData[row.collection]?.rows.sort((a, b) => a.date_sort.localeCompare(b.date_sort));
  showSaved();
  // In a view (Stage 4b) the match is reported in its panel and the view is read again.
  if (stamp.viewId && activeViewId === stamp.viewId) {
    cancelTMDBPreview();
    if (libraryPanel) libraryReport(libraryContext(), `Matched “${patch.title}”.`, false);
    reloadOpenView();
    return;
  }
  if (activeTabId !== row.collection) return;
  cancelTMDBPreview();
  renderFilters();
  renderTable();
}

// ─── Collection expansion confirmation (Stage 3b-2) ──────────────────────────
// The database described an expansion (matching this row into a show already on
// the list would show all of that show's stored seasons in more collections). The
// names come from that reply; whether a collection is archived comes only from a
// fresh read made now (never the page's older list); if that read fails, the
// panel says it couldn't check. Nothing is applied until the user confirms, and a
// changed proposal is shown again, never confirmed automatically.
async function showMatchProposal(m, res, row, patch) {
  const p = { rowId: row.id, tmdbId: patch.tmdb_id, seasonNumber: patch.season_number, seasonLabel: patch.season,
    targetShowId: res.target_show_id, token: res.confirmation, reply: res, archived: null, checkFailed: false };
  m.proposal = p;
  renderMatchProposal(m);
  const read = orgReadStart();
  try {
    const colls = await fetchAllRowsStrict('personal_collections');
    if (publishCollections(colls, read)) buildBrowseBar();
    p.archived = new Set(colls.filter(c => c.archived_at).map(c => c.id));
  } catch (e) {
    p.checkFailed = true;
  }
  if (window.__tmdbMatch !== m || m.proposal !== p) return;
  renderMatchProposal(m);
}

function renderMatchProposal(m) {
  const body = document.getElementById('tmdbMatchBody');
  const p = m && m.proposal;
  if (!body || !p) return;
  const res = p.reply;
  const checking = !p.archived && !p.checkFailed;
  const names = (res.collections || []).map(c => `<strong>${esc(c.name)}</strong>${p.archived && p.archived.has(c.id) ? ' (archived: not shown in Browse)' : ''}`).join(', ');
  const busy = !!m.inFlight;
  body.innerHTML = `<div class="tmdb-refresh-summary" style="margin-top:12px"><strong>Matching also adds a show to collections.</strong></div>
    ${res.changed ? '<div class="tmdb-refresh-summary">This changed since you looked. Check and confirm again.</div>' : ''}
    <p class="tmdb-expansion">“${esc(res.show_title)}” is already on your list. Matching this row as ${esc(p.seasonLabel)} also shows
      <strong>all ${Number(res.seasons) || 0} stored season${Number(res.seasons) === 1 ? '' : 's'}</strong> of “${esc(res.show_title)}” (and any added later) in: ${names}.</p>
    ${checking ? '<div class="tmdb-refresh-summary">Checking which of these collections are archived…</div>' : ''}
    ${p.checkFailed ? '<div class="tmdb-refresh-summary">Couldn’t check which of these collections are archived.</div>' : ''}
    <div class="tmdb-refresh-summary">Removing “${esc(res.show_title)}” from one of these collections later also removes this season from it.</div>
    <div class="tmdb-preview-actions" style="flex-wrap:wrap">
      <button class="btn btn-accent" onclick="confirmTmdbMatch(true)"${busy || checking ? ' disabled' : ''}>${busy ? 'Matching…' : 'Match and add to these collections'}</button>
      <button class="btn" onclick="renderTmdbMatchConfirm()"${busy ? ' disabled' : ''}>Back</button>
      <button class="btn" onclick="cancelTmdbMatch()">Cancel</button>
    </div>`;
}

// ─── Tracked reads (shared with tabs.js, tv-shows.js, derived-views.js, row-actions.js) ─
// Every read of a tab, a row or a show list, every Match call and every edit made
// on this page takes a number when it starts and records the restore epoch. The
// newest publication of each tab, row and show list is remembered (by number and
// kind; for a row also whether it is present, and the row itself). A read publishes
// only if it is newer than that in the current epoch; an older read that finishes
// late, or one from before a restore, publishes nothing. An edit counts as a
// publication from its optimistic start, so no older read replaces what the user
// changed. While any edit of a row (or show list) is pending, no read publishes it;
// when an edit ends its marker moves to a new number, so a read that overlapped the
// edit stays older than its saved (or reverted) result. Edits never satisfy a
// refresh; a read retired by an edit is void, and the refresh reads again once no
// edit of that row (or show list) is pending.
function matchPublishedReset() {
  if (matchPublished.epoch !== orgEpoch) matchPublished = { epoch: orgEpoch, tabs: {}, rows: {}, shows: {} };
}

function matchReadStart(kind, collection, rowId) {
  matchPublishedReset();
  const read = { id: ++matchReadSeq, kind, collection, rowId: rowId || null, epoch: orgEpoch, state: 'pending', error: null,
    applied: false, keptRows: null }; // keptRows: rows (or, for '*', show lists) kept because of an edit
  matchReads.push(read);
  if (matchReads.length > 300) { // trim settled history; a pending read or edit is never dropped
    const cut = matchReads.length - 300;
    matchReads = matchReads.filter((r, i) => i >= cut || r.state === 'pending');
  }
  return read;
}

// void: the call ended without covering anything (a Match that changed nothing on the
// page, an edit, or a read whose data an edit made stale).
function matchReadSettle(read, error, voided) {
  read.state = voided ? 'void' : error ? 'failed' : 'ok';
  read.error = error ? String(error.message || error) : null;
  matchRefreshReevaluate();
}

// row: for kind 'rows', the row as now shown (an object) or null when it is gone.
function matchNotePublished(kind, key, read, row) {
  matchPublishedReset();
  const cur = matchPublished[kind][key];
  if (read.epoch !== orgEpoch || (cur && cur.id > read.id)) return;
  matchPublished[kind][key] = kind === 'rows'
    ? { id: read.id, kind: read.kind, collection: read.collection, row: row === undefined ? (cur ? cur.row : null) : row }
    : { id: read.id, kind: read.kind };
}

const matchPubId = entry => (entry ? entry.id : 0);

function matchMayPublishTab(read) {
  matchPublishedReset();
  return read.epoch === orgEpoch && read.id > matchPubId(matchPublished.tabs[read.collection]);
}

// An edit of this row (kind 'rows', key = row id) or show list (kind 'shows', key =
// collection) is still pending in the current epoch.
function matchEditPending(kind, key) {
  return matchReads.some(r => r.kind === 'edit' && r.state === 'pending' && r.epoch === orgEpoch
    && (kind === 'rows' ? r.rowId === key : !r.rowId && r.collection === key));
}

// A read of this row / show list that an edit makes stale: one is pending, or one ended after the read started.
function matchRowEditBlocks(read, rowId) {
  const e = matchPublished.rows[rowId];
  return read.epoch === orgEpoch && (matchEditPending('rows', rowId) || !!(e && e.kind === 'edit' && e.id > read.id));
}

function matchMayPublishRow(read, collection, rowId) {
  matchPublishedReset();
  return read.epoch === orgEpoch && read.id > Math.max(matchPubId(matchPublished.tabs[collection]), matchPubId(matchPublished.rows[rowId]))
    && !matchEditPending('rows', rowId);
}

function matchMayPublishShows(read, collection) {
  matchPublishedReset();
  const newest = collection === '*' ? matchPubId(matchPublished.shows['*'])
    : Math.max(matchPubId(matchPublished.shows[collection]), matchPubId(matchPublished.shows['*']));
  return read.epoch === orgEpoch && read.id > newest && (collection === '*' || !matchEditPending('shows', collection));
}

// Rows of a tab that a read newer than this one published (present or gone), for a
// tab read to keep: { rowId: { row (null = gone), kind } }.
function matchNewerRows(read, collection) {
  matchPublishedReset();
  const out = {};
  for (const [rowId, e] of Object.entries(matchPublished.rows)) {
    if (e.collection === collection && (e.id > read.id || matchEditPending('rows', rowId))) out[rowId] = e;
  }
  return out;
}

// An edit of this show list is pending, or one ended after this read started.
function matchShowsBlockedByEdit(read, collection) {
  const e = matchPublished.shows[collection];
  return read.epoch === orgEpoch && (matchEditPending('shows', collection) || !!(e && e.kind === 'edit' && e.id > read.id));
}

// An edit made on this page (rows: key = row id, row = the row as now shown or null if
// removed; shows: key = collection).
function matchEditStart(kind, collection, key, row) {
  if (typeof orgEpoch === 'undefined') return null;
  const read = matchReadStart('edit', collection, kind === 'rows' ? key : null);
  matchNotePublished(kind, key, read, row);
  return read;
}

// A reverted edit puts the row back as it was (same publication number).
function matchEditRevert(read, row) {
  if (!read) return;
  const e = matchPublished.rows[read.rowId];
  if (e && e.id === read.id) e.row = row;
}

// The edit's result (saved or reverted) is published under a new number, newer than
// every read that started while it was pending.
function matchEditEnd(read) {
  if (!read) return;
  matchPublishedReset();
  if (read.epoch === orgEpoch) {
    const id = ++matchReadSeq;
    if (read.rowId) {
      const cur = matchPublished.rows[read.rowId];
      matchPublished.rows[read.rowId] = { id, kind: 'edit', collection: read.collection, row: cur ? cur.row : null };
    } else matchPublished.shows[read.collection] = { id, kind: 'edit' };
  }
  matchReadSettle(read, null, true);
}

// ─── After a match that couldn't be put into the page ─────────────────────────
// The confirmed Match outcomes stay reported; refresh progress is reported apart
// from them. Each such Match adds obligations — its row, and for a TV collection
// that collection's shows — to the open refresh; obligations accumulate across
// Matches until every one is satisfied, and Retry reads every unsatisfied one.
// An obligation is satisfied by any read that covers it, started after it was
// opened, in the current restore epoch, and succeeded (the refresh's own reads,
// a tab read for its rows, a show read for its shows, a Match of the row applied
// to the page). While none has succeeded and one is still running it stays
// pending ("Refreshing…"); when all of them failed, it has failed (the warning
// with a read-only Retry). "Refreshed." only when every obligation is satisfied.
// A restore voids everything from the old epoch: every obligation is re-opened and
// read again. Matches are never re-sent.
function setMatchNotice(text, withRetry) {
  const el = document.getElementById('noticeBanner');
  if (!el) return;
  el.innerHTML = text ? `<div class="notice-banner" role="status">${esc(text)}${withRetry
    ? ' <button class="btn" onclick="retryMatchRefresh()">Retry</button>' : ''}</div>` : '';
}

function matchRefreshNotice(progress) {
  const outcomes = progress.titles.map(t => `Matched “${t}”.`).join(' ');
  const restored = progress.restored ? ' Your data was also restored while this match was in progress.' : '';
  if (progress.state === 'failed') {
    const who = progress.titles.map(t => `“${t}”`).join(' and ');
    setMatchNotice(`Matched ${who}, but the current data couldn’t be refreshed (${progress.error}).`, true);
  } else if (progress.state === 'done') setMatchNotice(`${outcomes}${restored} Refreshed.`);
  else setMatchNotice(`${outcomes}${restored} Refreshing to show what is saved now…`);
}

function refreshAfterMatch(stamp, restored) {
  let progress = matchRefreshProgress;
  if (!progress || progress.state === 'done') {
    progress = { titles: [], restored: false, epoch: orgEpoch, units: {}, state: 'pending', error: null };
    matchRefreshProgress = progress;
  }
  if (!progress.titles.includes(stamp.title)) progress.titles.push(stamp.title);
  if (restored) progress.restored = true;
  matchRefreshStamp = stamp;
  // Open (or re-open) this Match's obligations: only reads started from now on count.
  const opened = [{ key: `row:${stamp.rowId}`, kind: 'row', collection: stamp.collection, rowId: stamp.rowId }];
  if (isTvCollection(stamp.collection)) opened.push({ key: `shows:${stamp.collection}`, kind: 'shows', collection: stamp.collection });
  const units = opened.map(u => (progress.units[u.key] = { ...u, since: matchReadSeq, state: 'pending', error: null }));
  progress.state = 'pending';
  matchRefreshNotice(progress);
  return matchRefreshRead(units);
}

// Reads the given obligations (read only) and the collections (best effort).
function matchRefreshRead(units) {
  const reads = units.map(u => (u.kind === 'row' ? matchReadRow(u) : loadTvShows(u.collection).catch(() => {})));
  if (orgState !== 'absent') {
    const read = orgReadStart();
    reads.push(fetchAllRowsStrict('personal_collections').then(c => { if (publishCollections(c, read)) buildBrowseBar(); },
      () => markOrgStale('collections', read)));
  }
  return Promise.allSettled(reads).then(() => matchRefreshReevaluate());
}

function matchReadRow(unit) {
  const read = matchReadStart('row', unit.collection, unit.rowId);
  return sbFetch('GET', `${TABLE}?id=eq.${unit.rowId}&select=*`, null).then(rows => {
    const now = (rows || [])[0] || null;
    if (!matchMayPublishRow(read, unit.collection, unit.rowId)) {
      // Retired. An edit made it stale: it covers nothing (a current read follows).
      matchReadSettle(read, null, matchRowEditBlocks(read, unit.rowId));
      return;
    }
    const td = tabData[unit.collection];
    if (td && td.loaded) {
      const i = td.rows.findIndex(r => r.id === unit.rowId);
      if (now && i >= 0) td.rows[i] = now;
      else if (now) td.rows.push(now);
      else if (i >= 0) td.rows.splice(i, 1);
      td.rows.sort((a, b) => String(a.date_sort).localeCompare(String(b.date_sort)));
      if (activeTabId === unit.collection) { renderFilters(); renderTable(); }
    }
    matchNotePublished('rows', unit.rowId, read, now);
    matchReadSettle(read, null);
  }, e => matchReadSettle(read, e));
}

function matchReadCovers(read, unit) {
  if (unit.kind === 'shows') return read.kind === 'shows' && (read.collection === unit.collection
    || (read.collection === '*' && !(read.keptRows && read.keptRows.has(unit.collection))));
  if (read.kind === 'tab') return read.collection === unit.collection && !(read.keptRows && read.keptRows.has(unit.rowId));
  if (read.kind === 'row') return read.rowId === unit.rowId;
  return read.kind === 'match' && read.rowId === unit.rowId && read.applied;
}

function matchRefreshReevaluate() {
  if (matchRefreshProgress) matchRefreshEvaluate(matchRefreshProgress);
}

function matchRefreshEvaluate(progress) {
  if (progress !== matchRefreshProgress || progress.state === 'done') return;
  // A restore since: nothing from the old epoch counts; every obligation is read again.
  if (progress.epoch !== orgEpoch) {
    progress.epoch = orgEpoch;
    progress.restored = true;
    const all = Object.values(progress.units);
    all.forEach(u => { u.since = matchReadSeq; u.state = 'pending'; u.error = null; });
    progress.state = 'pending';
    matchRefreshNotice(progress);
    matchRefreshRead(all);
    return;
  }
  let failed = null;
  const rereads = [];
  for (const u of Object.values(progress.units)) {
    const covering = matchReads.filter(r => r.id > u.since && r.epoch === orgEpoch && r.state !== 'void' && matchReadCovers(r, u));
    if (covering.some(r => r.state === 'ok')) u.state = 'ok';
    else if (covering.some(r => r.state === 'pending')) u.state = 'pending';
    else if (!covering.length) {
      // Nothing covers it (its read was retired by an edit): read again once no edit of it is pending.
      u.state = 'pending';
      const editing = matchReads.some(r => r.kind === 'edit' && r.state === 'pending' && r.epoch === orgEpoch
        && (u.kind === 'row' ? r.rowId === u.rowId : r.collection === u.collection && !r.rowId));
      if (!editing) { u.since = matchReadSeq; rereads.push(u); }
    }
    else { u.state = 'failed'; u.error = covering[covering.length - 1].error; failed = failed || u; }
  }
  const units = Object.values(progress.units);
  const before = progress.state;
  progress.state = failed ? 'failed' : units.every(u => u.state === 'ok') ? 'done' : 'pending';
  progress.error = failed ? failed.error : null;
  matchRefreshNotice(progress);
  // The refreshed data is shown now: its collection's tab, or a view drawn across collections (All TV,
  // Currently Watching, Coming Soon, Browse), which draws from the same row and show caches.
  if (progress.state === 'done' && before !== 'done' && (units.some(u => u.collection === activeTabId) || activeViewId)) { renderFilters(); renderTable(); }
  if (rereads.length) matchRefreshRead(rereads);
}

// Retry: reads every obligation that isn't satisfied (read only; nothing is re-sent).
function retryMatchRefresh() {
  const progress = matchRefreshProgress;
  if (!progress) return;
  const open = Object.values(progress.units).filter(u => u.state !== 'ok');
  open.forEach(u => { u.since = matchReadSeq; u.state = 'pending'; u.error = null; });
  progress.state = 'pending';
  matchRefreshNotice(progress);
  return matchRefreshRead(open);
}
