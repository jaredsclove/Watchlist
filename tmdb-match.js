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

// withConfirmation: the user confirmed the collection expansion shown in the panel;
// it is sent only while the panel still shows that proposal for this row, TMDB id
// and season.
async function confirmTmdbMatch(withConfirmation) {
  const m = window.__tmdbMatch;
  const row = tmdbMatchRow();
  if (!m?.target || !row || m.inFlight) return;
  const isMoviesTab = !!COLLECTIONS.find(c => c.id === activeTabId)?.isMovieTab;
  const patch = buildTmdbMatchPatch(row, m.target, isMoviesTab);
  if (!patch) return;
  let expansion = {};
  if (withConfirmation === true) {
    const p = m.proposal;
    if (!p || p.rowId !== row.id || p.tmdbId !== patch.tmdb_id || p.seasonNumber !== patch.season_number) return;
    expansion = { confirm: p.token };
  }
  // Each call's stamp: a delayed answer is checked against what the page shows now.
  const stamp = { seq: ++matchRequestSeq, rowId: row.id, epoch: orgEpoch, rowObj: row, collection: row.collection, title: patch.title };
  matchLatestByRow[row.id] = stamp.seq;
  matchLatestStamp[row.id] = stamp; // settled (and applied, if it changed the row) when this call ends
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
    const stillCurrent = stamp.epoch === orgEpoch && matchLatestByRow[row.id] === stamp.seq
      && (tabData[stamp.collection]?.rows || []).includes(stamp.rowObj);
    stamp.applied = true; // the database applied it (shown below, or through a refresh)
    if (!stillCurrent) {
      if (window.__tmdbMatch === m) { window.__tmdbMatch = null; cancelTMDBPreview(); }
      refreshAfterMatch(stamp, stamp.epoch !== orgEpoch);
      return;
    }
    Object.assign(row, fresh);
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
    // A refresh waiting on this Match of the row can now finish (or read again).
    stamp.settled = true;
    matchRefreshReevaluate();
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

// ─── After a match that couldn't be put into the page ─────────────────────────
// The confirmed Match outcome stays reported; refresh progress is reported apart
// from it. A refresh fetches the row, the shows and the collections without
// publishing anything, then decides each part (row, shows) when its result
// arrives, the same way for a success and a failure:
//   * nothing newer happened → its own result decides: published and accepted,
//     or failed;
//   * a newer read of that part already completed (the tab was read again, the
//     page's row changed, the shows were read again) → that read is current: the
//     part is accepted and nothing older is published;
//   * a newer read of that part is still in progress (a show read, or a Match of
//     the row) → that read owns the part: the notice stays "Refreshing…" until it
//     is accepted or fails (then the failure, with Retry). A Match of the row that
//     ends without changing it hands the part back to a fresh read (read-only).
// "Refreshed." only when every part is accepted; a failure keeps the Match outcome
// and offers Retry, which only reads. A newer refresh takes over the notice and
// keeps the earlier outcomes; a restore (epoch change) starts the read again under
// the new epoch. Retired results publish nothing and never change the notice.
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

// Show reads (tv-shows.js) report when they start and end, so a newer one can own a part.
function matchShowReadStarted(collectionId) {
  const read = { id: ++matchShowReadSeq, collection: collectionId, state: 'pending', error: null };
  matchShowReads.push(read);
  if (matchShowReads.length > 50) matchShowReads = matchShowReads.slice(-50);
  return read;
}

function matchShowReadSettled(read, error) {
  read.state = error ? 'failed' : 'ok';
  read.error = error ? String(error.message || error) : null;
  matchRefreshReevaluate();
}

function refreshAfterMatch(stamp, restored) {
  const prev = matchRefreshProgress;
  const carry = prev && prev.state !== 'done' && prev.state !== 'failed' ? prev : null;
  const titles = [...new Set([...(carry ? carry.titles : []), stamp.title])];
  const progress = { seq: ++matchRefreshSeq, stamp, epoch: orgEpoch, titles, restored: !!restored || !!(carry && carry.restored),
    state: 'pending', error: null, parts: {} };
  matchRefreshProgress = progress;
  matchRefreshStamp = stamp;
  matchRefreshNotice(progress);
  // What the page shows now; a newer read or change of a part decides that part.
  const tab0 = tabData[stamp.collection];
  const rowSig = () => { const t = tabData[stamp.collection]; const r = t && t.rows ? t.rows.find(x => x.id === stamp.rowId) : null; return r ? JSON.stringify(r) : null; };
  const row0 = rowSig();
  const match0 = matchLatestStamp[stamp.rowId] || null;
  const showsMap0 = tvShowsById, showRead0 = matchShowReadSeq;
  const tv = isTvCollection(stamp.collection);
  const read = orgReadStart();
  return Promise.allSettled([
    sbFetch('GET', `${TABLE}?id=eq.${stamp.rowId}&select=*`, null),
    tv ? sbFetch('GET', `tv_shows?collection=eq.${encodeURIComponent(stamp.collection)}&select=*`, null) : Promise.resolve(null),
    orgState === 'absent' ? Promise.resolve(null) : fetchAllRowsStrict('personal_collections')
  ]).then(([rowRes, showsRes, collsRes]) => {
    if (progress !== matchRefreshProgress) return; // a newer refresh owns the notice
    if (progress.epoch !== orgEpoch) { refreshAfterMatch(stamp, true); return; }
    const err = r => String((r.reason && r.reason.message) || r.reason);
    // Collections aren't part of the match: published, or marked possibly out of date.
    if (collsRes.status === 'fulfilled') { if (collsRes.value && publishCollections(collsRes.value, read)) buildBrowseBar(); }
    else if (orgState !== 'absent') markOrgStale('collections', read);
    // The row.
    const newerMatch = matchLatestStamp[stamp.rowId] && matchLatestStamp[stamp.rowId] !== match0 ? matchLatestStamp[stamp.rowId] : null;
    if (tabData[stamp.collection] !== tab0 || rowSig() !== row0) progress.parts.row = { state: 'ok' };
    else if (newerMatch && !newerMatch.settled) progress.parts.row = { state: 'pending', match: newerMatch };
    else if (rowRes.status === 'fulfilled') {
      const td = tabData[stamp.collection];
      if (td && td.loaded) {
        const i = td.rows.findIndex(r => r.id === stamp.rowId);
        const now = (rowRes.value || [])[0];
        if (now && i >= 0) td.rows[i] = now;
        else if (now) td.rows.push(now);
        else if (i >= 0) td.rows.splice(i, 1);
        td.rows.sort((a, b) => String(a.date_sort).localeCompare(String(b.date_sort)));
      }
      progress.parts.row = { state: 'ok', published: true };
    } else progress.parts.row = { state: 'failed', error: err(rowRes) };
    // The shows.
    if (tv) {
      const newerReads = matchShowReads.filter(x => x.id > showRead0 && (x.collection === stamp.collection || x.collection === '*'));
      if (tvShowsById !== showsMap0) progress.parts.shows = { state: 'ok' };
      else if (newerReads.length) progress.parts.shows = { state: 'pending', reads: newerReads };
      else if (showsRes.status === 'fulfilled') {
        tvShowsReadSeq++;
        for (const [id, sh] of tvShowsById) if (sh.collection === stamp.collection) tvShowsById.delete(id);
        noteTvShows(showsRes.value || []);
        progress.parts.shows = { state: 'ok', published: true };
      } else progress.parts.shows = { state: 'failed', error: err(showsRes) };
    }
    matchRefreshEvaluate(progress);
  });
}

// A part owned by a newer read finishes when that read does.
function matchRefreshReevaluate() {
  if (matchRefreshProgress) matchRefreshEvaluate(matchRefreshProgress);
}

function matchRefreshEvaluate(progress) {
  if (progress !== matchRefreshProgress || progress.state !== 'pending' || !progress.parts.row) return;
  for (const part of Object.values(progress.parts)) {
    if (part.state !== 'pending') continue;
    if (part.reads) {
      if (part.reads.some(x => x.state === 'pending')) continue;
      // The newest replacement decides.
      const last = part.reads[part.reads.length - 1];
      if (last.state === 'failed') { part.state = 'failed'; part.error = last.error; }
      else part.state = 'ok';
    } else if (part.match && part.match.settled) {
      if (part.match.applied) part.state = 'ok';
      // That Match ended without changing the row: read again (read only).
      else { refreshAfterMatch(progress.stamp, progress.restored); return; }
    }
  }
  const parts = Object.values(progress.parts);
  const failed = parts.find(p => p.state === 'failed');
  if (failed) { progress.state = 'failed'; progress.error = failed.error; }
  else if (parts.every(p => p.state === 'ok')) progress.state = 'done';
  matchRefreshNotice(progress);
  if (progress.state === 'done' && activeTabId === progress.stamp.collection) { renderFilters(); renderTable(); }
}

function retryMatchRefresh() {
  if (matchRefreshStamp) refreshAfterMatch(matchRefreshStamp, false);
}
