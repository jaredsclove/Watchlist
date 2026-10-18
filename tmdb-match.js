// ─── Match to TMDB ────────────────────────────────────────────────────────────
// Gives an unidentified row (one typed by hand) the TMDB identity the user
// explicitly picks: search → click a result → for a series, pick the season →
// confirm a before/after summary. Nothing is guessed from the title, and the first
// result is never taken automatically. The row is updated in place, so its id,
// created_at, watched, watch_with, status and tags are kept. Entries a catalog
// governs are not eligible (the same rule as before Stage 5; the database checks it).

function isTmdbMatchEligible(row) {
  return !!row && row.tmdb_id == null && row.media_type == null && row.season_number == null && governanceKnows(row) && !rowCatalogOf(row);
}

// The fields a confirmed match writes, in the same shape the app gives rows it adds
// from TMDB. target: { mediaType: 'movie', details } for a film (TMDB /movie/{id}),
// or { mediaType: 'tv', details, seasonNumber } for a season (TMDB /tv/{id}).
// genreTheme: a film's theme is its genre (a film whose theme_kind is 'genre'),
// otherwise its production company. Returns null for a series with no valid season chosen.
function buildTmdbMatchPatch(row, target, genreTheme) {
  const d = target.details;
  if (target.mediaType === 'movie') {
    const belongsTo = d.belongs_to_collection;
    const patch = {
      title: d.title,
      season: 'Film',
      item_key: `${d.title.toLowerCase().trim()}|film`,
      theme: genreTheme
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

// Another row that blocks the match: one that already has the target TMDB identity
// (anywhere in the library), or, for a season, an unmatched row of the show it would
// join that already uses the new item_key. Identified rows that merely share the
// title (a different TMDB id) never block it. targetShowId: the show with the
// target TMDB identity, if any.
function findTmdbMatchConflict(row, patch, rows, targetShowId) {
  const others = rows.filter(r => r.id !== row.id);
  const sameIdentity = others.find(r => r.media_type === patch.media_type && r.tmdb_id === patch.tmdb_id &&
    (patch.media_type === 'movie' || r.season_number === patch.season_number));
  if (sameIdentity) return { kind: 'identity', row: sameIdentity };
  const sameLegacyKey = patch.media_type === 'tv'
    ? others.find(r => r.tmdb_id == null && r.item_key === patch.item_key && r.show_id && r.show_id === (targetShowId || row.show_id))
    : null;
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

// The rows the Match controls came from: the open view's (All TV, All Movies), whose
// Match panel is the view's "+ Add" panel.
function tmdbMatchRows() {
  return actionRows();
}

function tmdbMatchRow() {
  const m = window.__tmdbMatch;
  return m ? tmdbMatchRows().find(r => r.id === m.rowId) : null;
}

// The kind of row decides the search (films first for a film, series first
// otherwise) and, for a film, what its theme means.
function tmdbMatchSearchMode(row) {
  return row && isFilmRow(row) ? 'movie' : 'tv';
}
function tmdbMatchGenreTheme(row) {
  return !!row && isFilmRow(row) && filmThemeKindOf(row) === 'genre';
}

function openTmdbMatch(rowId) {
  const row = tmdbMatchRows().find(r => r.id === rowId);
  if (!row || !isTmdbMatchEligible(row)) return;
  openLibraryPanel(isFilmRow(row) ? 'movie' : 'tv', 'match');
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
    m.results = selectTmdbSearchResults(tvResults, movieResults, tmdbMatchSearchMode(tmdbMatchRow()));
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
  const genreTheme = tmdbMatchGenreTheme(row);
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
  const patch = buildTmdbMatchPatch(row, m.target, genreTheme);
  if (patch) {
    const line = (label, before, after) => `<div class="modal-row"><span>${esc(label)}</span><span>${before === after ? esc(String(after)) : `${esc(String(before))} → <strong>${esc(String(after))}</strong>`}</span></div>`;
    const tmdbAfter = `${patch.media_type === 'movie' ? 'Film' : 'Series'} ${patch.tmdb_id}${patch.season_number != null ? `, season ${patch.season_number}` : ''}`;
    const addedTag = patch.collections ? patch.collections[patch.collections.length - 1] : null;
    html += `<div class="tmdb-refresh-summary" style="margin-top:12px">This row will change:</div>
      ${line('Title', row.title, patch.title)}
      ${line('Season', row.season, patch.season)}
      ${line('Date', row.display_date, patch.display_date)}
      ${line(mediaType === 'tv' ? 'Network' : genreTheme ? 'Genre' : 'Company', row.theme, patch.theme)}
      ${line('TMDB', 'not matched', tmdbAfter)}
      ${addedTag ? line('Tag added', '—', addedTag) : ''}
      <div class="tmdb-refresh-summary">Kept as is: watched, watch with${row.collections?.length ? ', existing tags' : ''}. Status, priority and categories follow the record they end up on; anything that changes is shown before the match is saved.</div>`;
  }
  html += `<div class="tmdb-preview-actions" style="flex-wrap:wrap">
      <button class="btn btn-accent" onclick="confirmTmdbMatch()" ${patch ? '' : 'disabled'}>Confirm match</button>
      <button class="btn" onclick="searchTmdbMatch()">Back to results</button>
      <button class="btn" onclick="cancelTmdbMatch()">Cancel</button>
    </div>`;
  body.innerHTML = html;
}

// ── B4/B5: what a Match drops or overrides, shown before it is saved ──
// The database answers blocked: 'state_acknowledgment' with the exact list and a token
// whenever a value the owner can see would be dropped or overridden; only a call carrying
// that token goes ahead. A season that would become a Skipped + Watched film needs the
// owner's explicit choice (an explicit status choice). Neither is ever sent automatically.
const MATCH_FIELD_LABELS = { status: 'Status', priority: 'Priority', ended: 'Show ended', catalog_new: 'New from catalog', status_review: 'Needs status review',
  legacy_status: 'The old status kept for a rollback', genres: 'Genres', forms: 'Form', franchises: 'Franchise / universe', companies: 'Production company',
  genre_candidates: 'Unresolved source categories', network: 'Original network', network_candidates: 'Network candidates', metadata_owner_set: 'Categories saved by you' };
const MATCH_LEGACY_LABELS = { pending: 'Pending', highpriority: 'High priority', maybe: 'Maybe', watching: 'Watching', complete: 'Complete' };
function matchAckValue(field, v) {
  if (v == null || (Array.isArray(v) && !v.length)) return 'none';
  if (field === 'status') return plainStatusLabel(v);
  if (field === 'legacy_status') return MATCH_LEGACY_LABELS[v] || v;
  if (field === 'priority') return PRIORITY_LABELS[v] || v;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return Array.isArray(v) ? v.join(', ') : String(v);
}
// ctx: { row, where } — the row being matched and where it goes ('a new show', '“T”', 'a film').
function matchAckItemText(x, ctx = {}) {
  const label = MATCH_FIELD_LABELS[x.field] || x.field;
  const source = x.show_id && typeof tvShowsById !== 'undefined' ? tvShowsById.get(x.show_id) : null;
  const sourceTitle = source ? `“${source.title}”` : 'the show this season leaves';
  if (x.field === 'source_show') return `${sourceTitle} would have no seasons left, so it is removed with its status, priority, Show ended, categories and markers.`;
  if (x.field === 'resume') return `The earlier-seasons choice for ${sourceTitle} ends because ${ctx.row ? ctx.row.season : 'this season'} moves to ${ctx.where || 'another record'}.`;
  if (x.effect === 'not_carried') return `${label} (${matchAckValue(x.field, x.source)}) isn’t kept.`;
  if (x.effect === 'dropped') return `${label} (${matchAckValue(x.field, x.source)}): a film has none, so it isn’t kept.`;
  return `${label}: this row’s ${matchAckValue(x.field, x.source)} isn’t kept; the show keeps its ${matchAckValue(x.field, x.destination)}.`;
}
function renderMatchAck(m) {
  const body = document.getElementById('tmdbMatchBody');
  if (!body || !m.ack) return;
  body.innerHTML = `<div class="tmdb-refresh-summary" style="margin-top:10px" role="status">${m.ack.changed ? 'What this match would change has changed. ' : ''}Before matching, check what changes:</div>
    <ul class="manage-list">${m.ack.items.map(x => `<li>${esc(matchAckItemText(x, m.ack.ctx))}</li>`).join('')}</ul>
    <div class="tmdb-preview-actions" style="flex-wrap:wrap">
      <button class="btn btn-accent" onclick="confirmTmdbMatchAck()">Match with these changes</button>
      <button class="btn" onclick="renderTmdbMatchConfirm()">Back</button>
      <button class="btn" onclick="cancelTmdbMatch()">Cancel</button>
    </div>`;
}
function confirmTmdbMatchAck() {
  const m = window.__tmdbMatch;
  if (!m || !m.ack) return;
  confirmTmdbMatch(false, { ack: true, choice: m.ack.choice || null });
}
function renderMatchStateChoice(m, row) {
  const body = document.getElementById('tmdbMatchBody');
  if (!body) return;
  m.choiceFor = row.id;
  body.innerHTML = `<div class="tmdb-refresh-summary" style="margin-top:10px">“${esc(row.title)} · ${esc(row.season)}” is marked watched, but it is skipped${row.skipped ? '' : ' (its show is Skipped)'}. As a film it can’t be both. Choose its status:</div>
    <div class="tmdb-preview-actions" style="flex-wrap:wrap">
      <button class="btn btn-accent" onclick="chooseTmdbMatchState('watched')">Watched</button>
      <button class="btn" onclick="chooseTmdbMatchState('skipped')">Skipped (clears Watched)</button>
      <button class="btn" onclick="renderTmdbMatchConfirm()">Back</button>
      <button class="btn" onclick="cancelTmdbMatch()">Cancel</button>
    </div>`;
}
function chooseTmdbMatchState(choice) {
  const m = window.__tmdbMatch;
  const row = tmdbMatchRow();
  if (!m || !row || m.choiceFor !== row.id || !['watched', 'skipped'].includes(choice)) return;
  confirmTmdbMatch(false, { choice });
}

// withConfirmation: the user confirmed the collection expansion shown in the panel;
// it is sent only while the panel still shows that proposal for this row, TMDB id
// and season. opts.ack: the acknowledgment shown for this row, TMDB id and season is
// sent with it; opts.choice: the owner's Watched / Skipped choice (a season becoming a film).
async function confirmTmdbMatch(withConfirmation, opts = {}) {
  const m = window.__tmdbMatch;
  const row = tmdbMatchRow();
  if (!m?.target || !row || m.inFlight) return;
  const patch = buildTmdbMatchPatch(row, m.target, tmdbMatchGenreTheme(row));
  if (!patch) return;
  // A film whose theme is a genre stays a film (as before Stage 5; the database refuses it too).
  if (patch.media_type === 'tv' && tmdbMatchGenreTheme(row)) {
    showError('A film whose theme is a genre can’t be matched to a TV season. Choose a film result instead. Nothing was changed.');
    return;
  }
  let expansion = {};
  if (withConfirmation === true) {
    const p = m.proposal;
    if (!p || p.rowId !== row.id || p.tmdbId !== patch.tmdb_id || p.seasonNumber !== patch.season_number) return;
    expansion = { confirm: p.token };
    m.lastExpansion = { rowId: row.id, tmdbId: patch.tmdb_id, seasonNumber: patch.season_number, expansion };
  } else if (opts.ack && m.lastExpansion && m.lastExpansion.rowId === row.id && m.lastExpansion.tmdbId === patch.tmdb_id
             && m.lastExpansion.seasonNumber === patch.season_number) {
    expansion = m.lastExpansion.expansion;
  }
  const ackToken = opts.ack && m.ack && m.ack.rowId === row.id && m.ack.tmdbId === patch.tmdb_id && m.ack.seasonNumber === (patch.season_number ?? null)
    ? m.ack.token : null;
  if (opts.ack && !ackToken) return;
  const choice = opts.choice || null;
  // M6b: a season that would become a Skipped + Watched film: the owner chooses first.
  if (patch.media_type === 'movie' && isTvSeason(row) && row.watched && (row.skipped || (showOfRow(row) || {}).status === 'skipped') && !choice) {
    renderMatchStateChoice(m, row);
    return;
  }
  // One change at a time (write-lane.js): the lane is held through the reread below.
  const lane = beginWrite(`Match “${row.title}”`, { list: true }); // refused while the list is out of date (write-lane.js)
  if (!lane) return;
  const stamp = { seq: ++matchRequestSeq, title: patch.title };
  m.inFlight = stamp.seq;
  if (m.proposal) renderMatchProposal(m);
  const viaShowFunction = patch.media_type === 'tv';
  // How far the match got, so a failure is reported for what actually happened:
  // 'check' (nothing sent yet) or 'write' (the match was sent: library_match_season
  // or library_match_film, each one database transaction that answers with the row).
  let stage = 'check';
  try {
    // Fresh check against the database (not just this page's copy): does another row
    // already hold this identity, or (a season) an unmatched row of the show it joins
    // already use the new item_key?
    const identityFilter = `media_type=eq.${patch.media_type}&tmdb_id=eq.${patch.tmdb_id}` +
      (patch.media_type === 'tv' ? `&season_number=eq.${patch.season_number}` : '');
    const [sameIdentity, sameKey, targetShows] = await Promise.all([
      sbFetch('GET', `${TABLE}?${identityFilter}&select=*`, null),
      sbFetch('GET', `${TABLE}?tmdb_id=is.null&item_key=eq.${encodeURIComponent(patch.item_key)}&select=*`, null),
      patch.media_type === 'tv' ? sbFetch('GET', `tv_shows?tmdb_id=eq.${patch.tmdb_id}&select=id`, null) : Promise.resolve([])
    ]);
    const conflict = findTmdbMatchConflict(row, patch, [...(sameIdentity || []), ...(sameKey || [])], ((targetShows || [])[0] || {}).id);
    if (conflict) { showError(tmdbMatchConflictMessage(conflict)); return; }

    // Only a row that is still unmatched is updated; the database's unique indexes
    // are the final guard against a match made elsewhere at the same moment.
    let fresh;
    stage = 'write';
    if (viaShowFunction) {
      // library_match_season moves the season to its identified show (checked by
      // Refresh shows from then on), re-checks the conflicts, refuses a show a catalog
      // governs, and refuses (and describes) a match that would show the target
      // show's other seasons in more collections until the user confirms (p_expansion).
      const res = await sbRpc('library_match_season_b45', { p_row_id: row.id, p_target: { tmdb_id: patch.tmdb_id, network: patch.theme }, p_patch: tmdbMatchAck(m, patch),
        p_expansion: expansion, p_ack: ackToken });
      if (m.inFlight === stamp.seq) m.inFlight = 0;
      // A blocked answer wrote nothing: it's shown only if the panel still shows this request.
      const panelCurrent = window.__tmdbMatch === m;
      if (res && res.blocked && res.reason === 'state_acknowledgment') {
        if (!panelCurrent || m.target?.details?.id !== patch.tmdb_id || (m.target.seasonNumber ?? null) !== patch.season_number) return;
        const joins = typeof tvShowsById !== 'undefined' && [...tvShowsById.values()].find(sh => sh.tmdb_id === patch.tmdb_id);
        m.ack = { rowId: row.id, tmdbId: patch.tmdb_id, seasonNumber: patch.season_number ?? null, token: res.confirmation, items: res.items || [], changed: !!res.changed, choice: null,
          ctx: { row, where: joins ? `“${joins.title}”` : 'a new show' } };
        renderMatchAck(m);
        return;
      }
      if (res && res.blocked && res.reason === 'membership_expansion') {
        if (!panelCurrent || m.target?.details?.id !== patch.tmdb_id || (m.target.seasonNumber ?? null) !== patch.season_number) return;
        await showMatchProposal(m, res, row, patch);
        return;
      }
      if (res && res.blocked && !panelCurrent) return;
      if (res && res.blocked) {
        // The identified show is already on this list with a different status;
        // nothing was written. Matching never changes a show's status.
        showError(`Not matched: "${patch.title}" is already on this list as ${plainStatusLabel(res.target_status)}, `
          + `but this row's show is ${plainStatusLabel(res.legacy_status)}. Give both the same status first, then match again.`);
        return;
      }
      fresh = res && res.row;
    } else {
      // library_match_film: in one transaction the row gets the film identity, a season
      // leaves its show (keeping that show's collections, archived ones included), and
      // a show left with no seasons is removed. Refused (nothing written) if the row
      // changed since this page read it.
      const res = await sbRpc('library_match_film_b45', { p_row_id: row.id, p_expected: { show_id: row.show_id ?? null }, p_patch: tmdbMatchAck(m, patch),
        p_ack: ackToken, p_choice: choice });
      if (res && res.blocked) {
        if (m.inFlight === stamp.seq) m.inFlight = 0;
        if (window.__tmdbMatch !== m || m.target?.details?.id !== patch.tmdb_id) return;
        if (res.reason === 'state_choice') { renderMatchStateChoice(m, row); return; }
        m.ack = { rowId: row.id, tmdbId: patch.tmdb_id, seasonNumber: null, token: res.confirmation, items: res.items || [], changed: !!res.changed, choice,
          ctx: { row, where: 'a film' } };
        renderMatchAck(m);
        return;
      }
      fresh = res && res.row;
    }
    if (m.inFlight === stamp.seq) m.inFlight = 0;
    if (!fresh || fresh.tmdb_id !== patch.tmdb_id || fresh.media_type !== patch.media_type || fresh.season_number !== patch.season_number) {
      showError('This row changed somewhere else before the match was saved, so nothing was matched. Reload the page and try again.');
      return;
    }
    // Confirmed. The page shows it by reading the open view again (the one reread path,
    // library.js reloadOpenView), never by merging the answer, while the lane is still held.
    if (window.__tmdbMatch === m) window.__tmdbMatch = null;
    cancelTMDBPreview();
    showSaved();
    const ok = activeViewId ? await reloadOpenView() : null;
    const text = `Matched “${patch.title}”.${ok === false ? ' The list couldn’t be read again, so it may be out of date; use Retry.' : ''}`;
    if (libraryPanel) libraryReport(libraryContext(), text, ok === false);
    else if (ok === false) showError(text);
  } catch(e) {
    if (m.inFlight === stamp.seq) m.inFlight = 0;
    const msg = String(e && e.message);
    // The match was sent but no clear answer came back (no answer, or one that doesn't show
    // whether it committed): not confirmed, never sent again; the open view is read again
    // (the shared reconciliation; a failed reread pauses changes from the list until a read works).
    if (stage === 'write' && orgErrorInfo(e).kind !== 'database') {
      if (window.__tmdbMatch === m) { window.__tmdbMatch = null; cancelTMDBPreview(); }
      const text = `The match of “${patch.title}” wasn’t confirmed (${orgErrorInfo(e).message}): it may or may not have been saved, and it won’t be sent again.`;
      showError(text);
      const ok = activeViewId ? await reloadOpenView() : null;
      showError(text + rereadText(ok));
      return;
    }
    if (/catalog_candidate/.test(msg) && window.__tmdbMatch === m) {
      // A built-in catalog record has the name or key this match would give: matched only
      // once the owner has seen every such record (read now) and confirms they are
      // different works. A refusal after a confirmation names records not yet seen: all of
      // them, the confirmed ones included, are shown again for a new confirmation.
      const info = orgErrorInfo(e);
      const prev = m.catalogTwins;
      const again = !!(prev && prev.confirmed && prev.tmdbId === patch.tmdb_id && prev.seasonNumber === patch.season_number);
      const named = ((info.detail && info.detail.candidates) || []).map(String);
      const ids = [...new Set([...(again ? prev.confirmed.ids : []), ...named])].sort();
      m.catalogTwins = { kind: viaShowFunction ? 'show' : 'film', tmdbId: patch.tmdb_id, seasonNumber: patch.season_number,
        target: { title: patch.title, season: patch.season, mediaType: patch.media_type, itemKey: patch.item_key, rowTitle: row.title },
        ids, info, records: null, complete: false, readFailed: null, readSeq: 0, confirmed: null, changed: again };
      renderTmdbMatchTwins(m, true);
      loadTmdbMatchTwins(m);
      return;
    }
    showError(/match_target_governed|not_eligible|genre_film_season|catalog_candidate/.test(msg) ? orgRefusalText(orgErrorInfo(e))
      : /not_found: unidentified row|match_conflict: the row changed|match_conflict: This row changed/.test(msg)
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
    endWrite(lane);
  }
}

// The acknowledgement a Match carries: exactly the catalog records the owner saw and
// confirmed as different works, only for the target they were shown with.
function tmdbMatchAck(m, patch) {
  const c = m.catalogTwins && m.catalogTwins.confirmed;
  return c && c.tmdbId === patch.tmdb_id && c.seasonNumber === patch.season_number ? { ...patch, distinct_from: c.ids } : patch;
}

// Reads every candidate the database named, with the catalog that governs it (GET only).
// Confirming is possible only once every one was read and is governed by a catalog; a
// failed or incomplete read offers Retry, which reads again.
async function loadTmdbMatchTwins(m) {
  const t = m && m.catalogTwins;
  if (!t) return;
  const seq = ++t.readSeq;
  t.records = null; t.complete = false; t.readFailed = null;
  renderTmdbMatchTwins(m);
  try {
    if (!t.ids.length) throw new Error('the database named no records');
    const list = t.ids.map(encodeURIComponent).join(',');
    const [recs, links] = await Promise.all(t.kind === 'show'
      ? [sbFetch('GET', `tv_shows?id=in.(${list})&select=*`, null), sbFetch('GET', `library_catalog_shows?show_id=in.(${list})&select=*`, null)]
      : [sbFetch('GET', `${TABLE}?id=in.(${list})&select=*`, null), sbFetch('GET', `library_catalog_films?item_id=in.(${list})&select=*`, null)]);
    if (window.__tmdbMatch !== m || m.catalogTwins !== t || t.readSeq !== seq) return;
    const byId = new Map((recs || []).map(r => [String(r.id), r]));
    const catalogOf = new Map((links || []).map(l => [String(t.kind === 'show' ? l.show_id : l.item_id), l.catalog]));
    t.records = t.ids.map(id => ({ id, rec: byId.get(id) || null, catalog: catalogOf.get(id) || null }));
    t.complete = t.records.every(x => x.rec && x.catalog);
  } catch (e) {
    if (window.__tmdbMatch !== m || m.catalogTwins !== t || t.readSeq !== seq) return;
    t.readFailed = String((e && e.message) || e);
  }
  renderTmdbMatchTwins(m);
}

// The candidates beside the proposed target. Drawn only while the panel shows them
// (force: the first drawing), so a late read never replaces another step of the panel.
function renderTmdbMatchTwins(m, force) {
  const t = m && m.catalogTwins;
  const body = document.getElementById('tmdbMatchBody');
  if (!t) return;
  if (!body) { showError(orgRefusalText(t.info)); return; }
  if (!force && !document.getElementById('tmdbMatchTwins')) return;
  const g = t.target, word = t.kind === 'show' ? 'show' : 'film', n = t.ids.length;
  const targetText = g.mediaType === 'tv'
    ? `“${esc(g.title)}”, ${esc(g.season)} (TMDB series ${t.tmdbId}, season ${t.seasonNumber})`
    : `“${esc(g.title)}” (TMDB film ${t.tmdbId})`;
  const label = c => esc(typeof catalogLabel === 'function' ? catalogLabel(c) : c);
  const norm = v => String(v || '').trim().toLowerCase();
  const why = r => t.kind === 'show'
    ? (norm(r.title) === norm(g.title) ? 'same name' : `same list key (“${esc(r.show_key)}”)`)
    : (norm(r.title) === norm(g.title) ? 'same name' : `same list key (“${esc(r.item_key)}”)`);
  const item = x => {
    if (!x.rec) return `<li>A record this page couldn’t read (it may have been changed or removed)</li>`;
    const r = x.rec;
    const ident = r.tmdb_id != null ? `TMDB ${esc(String(r.tmdb_id))}` : 'not matched to TMDB';
    const when = t.kind === 'film' ? ` · ${esc(r.display_date || r.date_sort || 'no date')}` : '';
    const gov = x.catalog ? `${label(x.catalog)} catalog` : 'no catalog governs it now';
    return `<li><strong>${esc(r.title)}</strong>${when} · ${ident} · ${gov} · ${why(r)}</li>`;
  };
  const reading = !t.records && !t.readFailed;
  const ready = !!t.records && t.complete && !t.readFailed && !m.inFlight;
  const retry = `<button class="btn" onclick="loadTmdbMatchTwins(window.__tmdbMatch)">Retry</button>`;
  body.innerHTML = `<div class="tmdb-preview" id="tmdbMatchTwins">
    ${t.changed ? '<div class="tmdb-refresh-summary">The catalog records this match is close to changed since you confirmed. Check them and confirm again.</div>' : ''}
    <p class="tmdb-expansion">Matching “${esc(g.rowTitle)}” to ${targetText} would give it the name or key of
      ${n === 1 ? `a built-in catalog ${word}` : `${n} built-in catalog ${word}s`} on your list. Nothing was matched.</p>
    ${reading ? `<div class="tmdb-refresh-summary">Reading ${n === 1 ? 'that record' : 'those records'}…</div>` : ''}
    ${t.records ? `<ul class="tmdb-twin-list">${t.records.map(item).join('')}</ul>` : ''}
    ${t.readFailed ? `<div class="tmdb-refresh-summary">Couldn’t read ${n === 1 ? 'that record' : 'those records'} (${esc(t.readFailed)}), so this can’t be confirmed yet. ${retry}</div>` : ''}
    ${t.records && !t.complete ? `<div class="tmdb-refresh-summary">Not every one could be read as a catalog ${word}, so this can’t be confirmed. ${retry}</div>` : ''}
    <div class="tmdb-preview-actions"><button class="btn btn-accent" onclick="confirmTmdbMatchDistinct()"${ready ? '' : ' disabled'}>${m.inFlight ? 'Matching…' : `${n === 1 ? 'It is' : 'They are'} different — match anyway`}</button>
    <button class="btn" onclick="renderTmdbMatchConfirm()">Back</button></div></div>`;
}
async function confirmTmdbMatchDistinct() {
  const m = window.__tmdbMatch;
  const t = m && m.catalogTwins;
  if (!t || !t.records || !t.complete || t.readFailed || m.inFlight) return;
  t.confirmed = { ids: t.records.map(x => x.id), tmdbId: t.tmdbId, seasonNumber: t.seasonNumber };
  await confirmTmdbMatch();
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
    const colls = await readPersonalCollections();
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
  const names = (res.collections || []).map(c => `<strong>${esc(c.name)}</strong>${p.archived && p.archived.has(c.id) ? ' (archived: not shown in Collections)' : ''}`).join(', ');
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

