// ─── Games (G1, next-gen item 5; db/g1_games.sql, games-data.js) ───────────────
// The Games area: Library (each saved game version with its platforms, status, priority, genres, scores and length), Franchises
// (followed franchises as collapsed rows: Up next or Caught up, and Coming), and Collections (private, hand-made game
// collections). Search and details come from IGDB through the igdb function (supabase/functions/igdb); the page never holds
// IGDB's secret. Saving a game follows nothing; following saves nothing. Everything here writes through the one write lane and
// reads again through reloadOpenView; focus follows the list's rule (the same control of the same game, else its ⋯, else a
// neighbour's).

const GAMES_VIEWS = { games: 'library', gamesfranchises: 'franchises', gamescollections: 'collections' };
const GAMES_VIEW_LABELS = { games: 'Library', gamesfranchises: 'Franchises', gamescollections: 'Collections' };
const GAMES_LAST_COLLECTION_KEY = 'watchlist_last_game_collection';
function isGamesView(id = activeViewId) { return Object.prototype.hasOwnProperty.call(GAMES_VIEWS, id); }
function openGames() { if (activeArea !== 'games') switchView('games'); }

// ── Reading ──
async function loadGamesView() {
  if (!isGamesView()) return null;
  const seq = ++gamesLoadSeq, stamp = readStamp(), inPlace = !!gamesData && gamesData.loaded;
  if (inPlace) { beginListReread(); showError(''); } else { showError(''); paintGamesMessage('Loading…', false); }
  try {
    const data = await readGamesData();
    if (seq !== gamesLoadSeq || !isGamesView()) return null;
    if (!readFresh(stamp)) { readAgainWhenFree(() => { if (seq === gamesLoadSeq && isGamesView()) loadGamesView(); }); return null; }
    gamesData = data;
    gamesSettingsRead = { status: 'ready', settings: data.settings }; // (the same row Settings shows)
    if (inPlace) endListReread(true);
    renderGamesView();
    return true;
  } catch (e) {
    console.error(e);
    if (seq !== gamesLoadSeq || !isGamesView()) return null;
    if (inPlace) { endListReread(false, 'loadGamesView', e); return false; }
    showError(`Couldn’t read your games, so nothing is shown rather than an incomplete list. ${e.message}`);
    paintGamesMessage('Failed to load.', true);
    return false;
  }
}
// Every game table of the member (shared with Queues and Settings).
async function readGamesData() {
  const [settings, entries, follows, decisions, collections, members, titles] = await Promise.all(['game_settings', 'game_entries', 'game_follows',
    'game_decisions', 'game_collections', 'game_collection_members', 'game_titles'].map(t => fetchAllRows(t)));
  return gamesDataFrom({ settings, entries, follows, decisions, collections, members, titles });
}
function gamesDataFrom(t) {
  const cache = new Map();
  (t.titles || []).forEach(r => { if (r && r.data && r.data.v === 1) cache.set(r.igdb_id, r.data); });
  const decisions = new Map((t.decisions || []).map(d => [gameDecisionKey(d.kind, d.igdb_id, d.platform), d]));
  return { loaded: true, settings: (t.settings || [])[0] || null, entries: t.entries || [], follows: t.follows || [], decisions, decisionRows: t.decisions || [],
    collections: (t.collections || []).slice().sort((a, b) => compareTitles(a.name, b.name)), members: t.members || [], cache };
}
function gamesState(data = gamesData, today = localTodayStr()) {
  const s = data && data.settings;
  return { cache: data ? data.cache : new Map(), entries: data ? data.entries : [], decisions: data ? data.decisions : new Map(),
    platforms: s ? s.platforms : null, style: s ? s.play_style : 'main', today };
}
// A saved game as its rows show it.
function gameEntryView(e, st) {
  const rec = st.cache.get(e.igdb_id) || null;
  const recs = rec ? [rec].concat((e.port_ids || []).map(p => st.cache.get(p)).filter(Boolean)) : [];
  const avail = gameAvailability(recs, st);
  return { entry: e, rec, avail, title: rec ? rec.name : e.title, hidden: !!avail.hiddenByPlatforms, length: gameLengthOf(rec, st.style),
    genres: rec ? rec.genres : [], dateKey: avail.line ? avail.line.key : null };
}

// ── Drawing ──
function hideListForGames() {
  ['viewHead', 'filtersRow', 'statsRow', 'tbody', 'cardList'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
  SETTINGS_LIST_CONTAINERS.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  const filtersRow = document.getElementById('filtersRow');
  if (filtersRow) filtersRow.dataset.tab = '';
  ['settingsScreen', 'queuesScreen'].forEach(id => { const el = document.getElementById(id); if (el) { el.style.display = 'none'; el.innerHTML = ''; } });
}
function paintGamesMessage(text, withRetry) {
  hideListForGames();
  const screen = document.getElementById('gamesScreen');
  if (!screen) return;
  screen.style.display = '';
  screen.innerHTML = `<h2 class="games-title">Games</h2><div class="loading"${withRetry ? '' : ' tabindex="-1" data-loading="1"'}>${esc(text)}${withRetry ? ' <button class="btn" data-retry="1" onclick="loadGamesView()">Retry</button>' : ''}</div>`;
}
function renderGamesView() {
  if (!isGamesView() || !gamesData || !gamesData.loaded) return;
  const rec = captureGamesFocus();
  hideListForGames();
  const screen = document.getElementById('gamesScreen');
  if (!screen) return;
  screen.style.display = '';
  const st = gamesState(), view = GAMES_VIEWS[activeViewId];
  const tabs = Object.keys(GAMES_VIEWS).map(id => `<button type="button" class="tab${id === activeViewId ? ' active' : ''}"${id === activeViewId ? ' aria-current="page"' : ''} onclick="switchView('${id}')">${GAMES_VIEW_LABELS[id]}</button>`).join('');
  const review = gamesReviewItems(gamesData);
  const noPlatforms = !st.platforms || !st.platforms.length;
  const head = `<div class="games-head"><h2 class="games-title" id="gamesTitle" tabindex="-1">Games</h2>
      <div class="games-tabs tabs" role="group" aria-label="Games views">${tabs}</div>
      <div class="games-actions">
        <button class="btn btn-accent" data-gaction="add" onclick="openGamesAdd(this)">+ Add game</button>
        <button class="btn" data-gaction="refresh" onclick="refreshGames()"${gamesRefreshing ? ' disabled' : ''}>${gamesRefreshing ? 'Refreshing…' : 'Refresh'}</button>
        ${review.length ? `<button class="btn" data-gaction="review" onclick="openGamesReview(this)">Review (${review.length})</button>` : ''}
      </div></div>
    ${noPlatforms ? `<p class="games-note" data-games-prompt="1">Choose your platforms in <button class="btn-link" onclick="openSettings(this, 'games')">Settings → Games</button> to see only what you can play, with dates for your systems.</p>` : ''}
    ${gamesReport ? `<div class="games-report" role="status">${gamesReport}</div>` : ''}`;
  let body = '';
  if (view === 'library') body = gamesLibraryHtml(st);
  else if (view === 'franchises') body = gamesFranchisesHtml(st);
  else body = gamesCollectionsHtml(st);
  screen.innerHTML = head + body;
  if (view === 'library' && typeof renderSortLine === 'function') renderSortLine();
  applyGamesFocus(rec);
}

// Library: the search, genre and status filters, the sort, and one row per visible game.
function gamesLibraryHtml(st) {
  const all = gamesData.entries.map(e => gameEntryView(e, st));
  const shown = all.filter(v => !v.hidden), hidden = all.length - shown.length;
  const genres = [...new Set(shown.flatMap(v => v.genres))].sort(compareTitles);
  const f = gamesFilters;
  const term = normalTitle(f.search);
  const list = shown.filter(v => (!term || normalTitle(v.title).includes(term))
    && (!f.genre || v.genres.includes(f.genre))
    && (f.status === 'all' ? true : f.status === 'notskipped' ? v.entry.status !== 'skipped' : v.entry.status === f.status));
  const usual = (a, b) => (b.entry.priority === 'high') - (a.entry.priority === 'high') || compareTitles(a.title, b.title) || cmpStr(a.entry.id, b.entry.id);
  const sorted = typeof sortForView === 'function' ? sortForView(list.map(v => ({ kind: 'game', v })), (a, b) => usual(a.v, b.v)).map(x => x.v) : list.sort(usual);
  const statusOpts = [['notskipped', 'All except Skipped'], ['all', 'All'], ...Object.entries(GAME_STATUS_LABELS)];
  const toolbar = `<div class="games-toolbar">
      <label class="visually-hidden" for="gSearch">Search your games</label>
      <input id="gSearch" class="search-input" type="search" placeholder="Search your games" value="${esc(f.search)}" oninput="setGamesFilter('search', this.value)">
      <label class="visually-hidden" for="gGenre">Genre</label>
      <select id="gGenre" onchange="setGamesFilter('genre', this.value)"><option value="">All genres</option>${genres.map(g => `<option value="${esc(g)}"${f.genre === g ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>
      <label class="visually-hidden" for="gStatus">Status</label>
      <select id="gStatus" onchange="setGamesFilter('status', this.value)">${statusOpts.map(([v, l]) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      ${typeof sortButtonHtml === 'function' ? sortButtonHtml() : ''}
      <span class="games-count" id="gamesCount">${countUnit(list.length, 'game', 'games')}${list.length !== shown.length ? ` of ${shown.length}` : ''}</span>
    </div><div id="sortLine" class="sort-line-box"></div>`;
  const hiddenNote = hidden ? `<p class="games-note">${countUnit(hidden, 'saved game isn’t', 'saved games aren’t')} on your platforms, so ${hidden === 1 ? 'it is' : 'they are'} hidden here and in your queues (${hidden === 1 ? 'its' : 'their'} status, priority, collections and queue places are kept). ${hidden === 1 ? 'It comes' : 'They come'} back when a platform you choose has ${hidden === 1 ? 'it' : 'them'}.</p>` : '';
  if (!gamesData.entries.length) return toolbar + `<div class="games-empty" data-games-empty="1" tabindex="-1"><p>No games yet. Use <strong>+ Add game</strong> to search IGDB and save one.</p></div>`;
  return toolbar + hiddenNote + (sorted.length ? `<ul class="games-list" aria-label="Your games">${sorted.map(v => gameRowHtml(v, st)).join('')}</ul>`
    : `<div class="games-empty" data-games-empty="1" tabindex="-1"><p>No games match these filters.</p></div>`);
}
function gameStatusSelectHtml(e, where = 'library') {
  const idArg = jsArg(e.id);
  return `<select class="game-status" data-gaction="status" aria-label="${esc(`Status of ${e.title}`)}" onchange="setGameStatus('${idArg}', this.value, '${where}')">${Object.entries(GAME_STATUS_LABELS)
    .map(([v, l]) => `<option value="${v}"${e.status === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
const jsArg = s => esc(String(s)).replace(/'/g, "\\'");
function gameScoresText(rec) {
  if (!rec) return '';
  const parts = [];
  if (rec.critic) parts.push(`Critics ${rec.critic.score} · IGDB (${rec.critic.count})`);
  if (rec.player) parts.push(`Players ${rec.player.score} · IGDB (${rec.player.count})`);
  return parts.join(' · ');
}
function gameRowHtml(v, st) {
  const e = v.entry, id = esc(e.id), idArg = jsArg(e.id), line = v.avail.line;
  const lineText = v.rec ? (line ? gameLineText(line) : 'Not announced on your platforms') : 'Details not loaded yet: use Refresh';
  const prio = e.priority === 'high' ? '<span class="game-prio" title="High priority" aria-label="High priority">★</span>' : e.priority === 'low' ? '<span class="game-prio-low">Low</span>' : '';
  const hold = line && line.rec && line.row.prec === 'day' && !line.evidence
    ? (line.held ? `<button class="popover-action" data-gaction="out" onclick="closeRowMenu(this); clearNotOutYet(${line.rec.id}, '${line.platform}')">It’s out (end my hold)</button>`
      : line.isReleased ? `<button class="popover-action" data-gaction="notout" onclick="closeRowMenu(this); setNotOutYet(${line.rec.id}, '${line.platform}', '${line.key}', '${line.row.prec}')">Not out yet on ${esc(GAME_PLATFORM_LABEL[line.platform])}</button>` : '') : '';
  const follows = v.rec ? v.rec.collections.filter(c => !gamesData.follows.some(f => f.igdb_collection_id === c.id)) : [];
  const menu = `<span class="more-cell"><button type="button" class="more-btn" data-gaction="more" aria-expanded="false" onclick="toggleMorePopover('g-${id}', this)" aria-label="${esc(`More for ${v.title}`)}">⋯</button>
      <div class="more-popover" id="more-popover-g-${id}" style="display:none">
        <div class="popover-section-label">Priority</div>
        ${['high', 'normal', 'low'].map(p => `<button class="popover-action" data-gaction="prio-${p}" onclick="closeRowMenu(this); setGamePriority('${idArg}', '${p}')"${e.priority === p ? ' disabled' : ''}>${p === 'high' ? '★ High' : p === 'normal' ? 'Normal' : 'Low'}</button>`).join('')}
        <div class="popover-section-label" style="margin-top:8px">Organize</div>
        <button class="popover-action" data-gaction="queue" onclick="openAddToQueueFromMenu(this, 'game', '${idArg}')">Add to queue…</button>
        <button class="popover-action" data-gaction="collect" onclick="closeRowMenu(this); openGameCollectionAdd('${idArg}', this)">Add to collection…</button>
        ${follows.map(c => `<button class="popover-action" data-gaction="follow" onclick="closeRowMenu(this); followFranchise(${c.id}, '${jsArg(c.name)}')">Follow ${esc(c.name)}</button>`).join('')}
        ${hold}
        <button class="popover-action" data-gaction="details" onclick="closeRowMenu(this); openGameDetails(${e.igdb_id}, this)">Details…</button>
        <button class="popover-action" data-gaction="delete" onclick="closeRowMenu(this); confirmDeleteGame('${idArg}')">Delete from library…</button>
      </div></span>`;
  return `<li class="game-row${e.status === 'skipped' ? ' game-skipped' : ''}" data-game="${id}">
      <div class="game-main">
        <div class="game-title-line"><button type="button" class="btn-link game-title" data-gaction="open" onclick="openGameDetails(${e.igdb_id}, this)">${esc(v.title)}</button>${prio}</div>
        <div class="game-line">${esc(lineText)}</div>
        <div class="game-meta">${v.genres.map(g => `<button type="button" class="badge meta-chip meta-genres badge-clickable" data-gaction="genre" onclick="setGamesFilter('genre', '${jsArg(g)}')">${esc(g)}</button>`).join('')}
          ${v.rec && gameScoresText(v.rec) ? `<span class="game-scores">${esc(gameScoresText(v.rec))}</span>` : ''}
          <span class="game-length${v.length.reliable ? '' : ' muted'}">${esc(gameLengthText(v.length))} <span class="visually-hidden">(${esc(GAME_STYLE_LABELS[st.style])})</span></span></div>
      </div>
      <div class="game-actions">${gameStatusSelectHtml(e)}${menu}</div>
    </li>`;
}
function setGamesFilter(key, value) {
  gamesFilters[key] = value;
  renderGamesView();
  const id = { search: 'gSearch', genre: 'gGenre', status: 'gStatus' }[key];
  if (key === 'genre' && document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-gaction') === 'genre') focusFilterTarget('gGenre');
  else if (id) { const el = document.getElementById(id); if (el && document.activeElement !== el && key === 'search') { el.focus(); el.setSelectionRange && el.setSelectionRange(el.value.length, el.value.length); } }
}

// Franchises: one collapsed row per followed franchise.
function gamesFranchisesHtml(st) {
  if (!gamesData.follows.length) return `<div class="games-empty" data-games-empty="1" tabindex="-1"><p>You follow no franchises. Follow one from a game’s ⋯ menu or from <strong>+ Add game</strong>: its Up next and Coming appear here. Saving a game doesn’t follow its franchise.</p></div>`;
  const rows = gamesData.follows.slice().sort((a, b) => compareTitles(a.name, b.name)).map(f => {
    const sum = franchiseSummary(f, st), open = gamesExpanded.has(f.id), id = esc(f.id), idArg = jsArg(f.id);
    const known = sum.spots.length > 0;
    const up = !known ? 'Not read from IGDB yet: use Refresh'
      : sum.upNext ? `Up next: ${sum.upNext.version.rec.name} · ${gameLineText(sum.upNext.version.avail.released[0])}` : 'Caught up';
    const upNoy = sum.upNext && sum.upNext.version.avail.released[0] && !sum.upNext.version.avail.released[0].evidence
      ? `<button class="btn btn-link" data-gaction="notout" onclick="setNotOutYet(${sum.upNext.version.avail.released[0].rec.id}, '${sum.upNext.version.avail.released[0].platform}', '${sum.upNext.version.avail.released[0].key}', '${sum.upNext.version.avail.released[0].row.prec}')">Not out yet</button>` : '';
    const coming = sum.coming.length ? `<div class="franchise-coming">Coming: ${esc(sum.coming[0].version.rec.name)} · ${esc(gameLineText(sum.coming[0].c))}${sum.coming.length > 1 ? ` <span class="muted">(+${sum.coming.length - 1} more)</span>` : ''}</div>` : '';
    return `<li class="franchise-row" data-follow="${id}">
        <div class="franchise-top">
          <button type="button" class="expand-btn" data-gaction="expand" aria-expanded="${open}" aria-label="${esc(`${open ? 'Collapse' : 'Expand'} ${f.name}`)}" onclick="toggleFranchise('${idArg}')">${open ? '▾' : '▸'}</button>
          <div class="franchise-main"><div class="franchise-name">${esc(f.name)}</div>
            <div class="franchise-up${sum.caughtUp && known ? ' muted' : ''}">${esc(up)} ${upNoy}</div>${coming}</div>
        </div>
        ${open ? franchiseSpotsHtml(f, sum, st) : ''}
      </li>`;
  }).join('');
  return `<ul class="franchise-list" aria-label="Followed franchises">${rows}</ul>`;
}
function franchiseSpotsHtml(f, sum, st) {
  const spots = sum.spots.map(s => {
    const versions = s.versions.map(v => {
      const status = v.entry ? GAME_STATUS_LABELS[v.entry.status] : '';
      const line = v.avail.line ? gameLineText(v.avail.line) : 'Not on your platforms';
      const save = v.entry ? `<span class="game-state">${esc(status)}</span>` : `<button class="btn btn-link" data-gaction="save-${v.rec.id}" onclick="saveGameRecord(${v.rec.id})">Save</button>`;
      return `<li class="spot-version"><span class="spot-version-name">${esc(v.rec.name)}${v.rec.type !== 'main' ? ` <span class="muted">(${esc(v.rec.type === 'standalone' ? 'standalone' : v.rec.type)})</span>` : ''}</span>
        <span class="spot-version-line">${esc(line)}</span>${save}</li>`;
    }).join('');
    const label = s.skipped ? 'Spot skipped' : s.finished ? 'Finished' : s.spinoff && !s.included ? 'Spin-off (not counted)' : s.spinoff ? 'Spin-off (counted)' : '';
    const actions = [
      `<button class="btn btn-link" data-gaction="skipspot-${s.id}" onclick="toggleSkipSpot(${s.id}, ${s.skipped})">${s.skipped ? 'Unskip this spot' : 'Skip this spot'}</button>`,
      s.spinoff ? `<button class="btn btn-link" data-gaction="include-${s.id}" onclick="toggleIncludeSpinoff(${s.id}, ${s.included})">${s.included ? 'Don’t count it' : 'Count it toward Caught up'}</button>` : ''].join('');
    return `<li class="spot${s.done ? ' spot-done' : ''}${s.included ? '' : ' spot-excluded'}" data-spot="${s.id}">
        <div class="spot-head"><span class="spot-title">${esc(s.title)}</span> <span class="muted">${esc(s.first ? s.first.slice(0, 4) : 'TBA')}</span>${label ? ` <span class="game-state">${esc(label)}</span>` : ''}</div>
        <ul class="spot-versions">${versions}</ul><div class="spot-actions">${actions}</div></li>`;
  }).join('');
  return `<div class="franchise-detail"><ol class="spot-list" aria-label="${esc(`${f.name} in release order`)}">${spots || '<li class="muted">Nothing read from IGDB yet: use Refresh.</li>'}</ol>
    <p class="games-note">Main-series games count toward Caught up; spin-offs only when you count them. An original, a remaster and a remake share one spot: finishing any of them completes it.</p>
    <button class="btn" data-gaction="unfollow" onclick="unfollowFranchise('${jsArg(f.id)}')">Stop following ${esc(f.name)}</button></div>`;
}
function toggleFranchise(id) { if (gamesExpanded.has(id)) gamesExpanded.delete(id); else gamesExpanded.add(id); renderGamesView(); }

// Collections: the member's game collections, one open at a time.
function gamesCollectionsHtml(st) {
  const cs = gamesData.collections;
  if (!cs.some(c => c.id === gamesCollectionId)) {
    let last = null; try { last = userStorage.getItem(GAMES_LAST_COLLECTION_KEY); } catch (e) { last = null; }
    gamesCollectionId = (cs.find(c => c.id === last) || cs[0] || {}).id || null;
  }
  const c = cs.find(x => x.id === gamesCollectionId) || null;
  const select = cs.length ? `<label for="gCollection">Collection</label> <select id="gCollection" data-gaction="cselect" onchange="selectGameCollection(this.value)">${cs.map(x => `<option value="${esc(x.id)}"${c && x.id === c.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : '';
  const edit = gamesCollectionEdit;
  const manage = c ? (edit && edit.id === c.id && edit.mode === 'rename'
    ? `<label class="visually-hidden" for="gCollectionRename">New name</label><input id="gCollectionRename" class="search-input" maxlength="100" value="${esc(edit.value)}" oninput="gamesCollectionEdit.value = this.value"> <button class="btn btn-accent" data-gaction="crename-save" onclick="renameGameCollection()">Save</button> <button class="btn" data-gaction="crename-cancel" onclick="gamesCollectionEdit = null; renderGamesView()">Cancel</button>`
    : edit && edit.id === c.id && edit.mode === 'delete'
      ? `<span>Delete “${esc(c.name)}”? Its games stay in your library.</span> <button class="btn-danger" data-gaction="cdelete-confirm" onclick="deleteGameCollection()">Delete collection</button> <button class="btn" data-gaction="cdelete-cancel" onclick="gamesCollectionEdit = null; renderGamesView()">Cancel</button>`
      : `<button class="btn" data-gaction="crename" onclick="gamesCollectionEdit = { id: '${jsArg(c.id)}', mode: 'rename', value: '${jsArg(c.name)}' }; renderGamesView(); focusFilterTarget('gCollectionRename')">Rename</button> <button class="btn" data-gaction="cdelete" onclick="gamesCollectionEdit = { id: '${jsArg(c.id)}', mode: 'delete' }; renderGamesView()">Delete…</button>`) : '';
  const create = `<div class="queue-new"><label for="gCollectionNew">New collection</label> <input id="gCollectionNew" class="search-input" maxlength="100" placeholder="Name" value="${esc(gamesCollectionNew)}" oninput="gamesCollectionNew = this.value" onkeydown="if (event.key === 'Enter') { event.preventDefault(); createGameCollection(); }"> <button class="btn" data-gaction="ccreate" onclick="createGameCollection()">Create</button></div>`;
  let body;
  if (!c) body = '<div class="games-empty" data-games-empty="1" tabindex="-1"><p>No game collections yet. Make one here, then add games with <strong>Add to collection…</strong> in a game’s ⋯ menu.</p></div>';
  else {
    const ms = gamesData.members.filter(m => m.collection_id === c.id);
    const views = ms.map(m => ({ m, e: gamesData.entries.find(e => e.id === m.entry_id) })).filter(x => x.e).map(x => ({ ...x, v: gameEntryView(x.e, st) }))
      .sort((a, b) => compareTitles(a.v.title, b.v.title));
    const shown = views.filter(x => !x.v.hidden);
    body = shown.length ? `<ul class="games-list" aria-label="${esc(c.name)}">${shown.map(x => `<li class="game-row" data-game="${esc(x.e.id)}">
        <div class="game-main"><div class="game-title-line"><button type="button" class="btn-link game-title" data-gaction="open" onclick="openGameDetails(${x.e.igdb_id}, this)">${esc(x.v.title)}</button></div>
          <div class="game-line">${esc(x.v.avail.line ? gameLineText(x.v.avail.line) : '')}</div></div>
        <div class="game-actions"><span class="game-state">${esc(GAME_STATUS_LABELS[x.e.status])}</span>
          <button class="btn" data-gaction="cremove" onclick="removeFromGameCollection('${jsArg(x.m.id)}')">Remove</button></div></li>`).join('')}</ul>`
      : `<div class="games-empty" data-games-empty="1" tabindex="-1"><p>“${esc(c.name)}” has no games${views.length ? ' on your platforms' : ''} yet.</p></div>`;
    if (views.length > shown.length) body += `<p class="games-note">${countUnit(views.length - shown.length, 'game in this collection isn’t', 'games in this collection aren’t')} on your platforms and ${views.length - shown.length === 1 ? 'is' : 'are'} hidden; ${views.length - shown.length === 1 ? 'it stays' : 'they stay'} in the collection.</p>`;
  }
  return `<div class="games-toolbar">${select} ${manage}</div>${create}${body}`;
}
function selectGameCollection(id) {
  gamesCollectionId = id; gamesCollectionEdit = null;
  try { userStorage.setItem(GAMES_LAST_COLLECTION_KEY, id); } catch (e) { /* not remembered */ }
  renderGamesView();
}

// ── Focus (the list's rule, for this screen) ──
function captureGamesFocus() {
  if (gamesFocusIntent) { const i = gamesFocusIntent; gamesFocusIntent = null; return i; }
  if (!documentHasFocus()) return null;
  const a = document.activeElement;
  if (!a || typeof a.closest !== 'function' || !a.closest('#gamesScreen')) return null;
  const rowEl = a.closest('[data-game], [data-follow]');
  const hookEl = a.closest('[data-gaction]');
  const attr = rowEl ? (rowEl.getAttribute('data-game') != null ? 'data-game' : 'data-follow') : null;
  const screen = document.getElementById('gamesScreen');
  const ids = attr ? [...screen.querySelectorAll(`[${attr}]`)].map(x => x.getAttribute(attr)) : [];
  const row = rowEl ? rowEl.getAttribute(attr) : null, at = ids.indexOf(row);
  return { attr, row, hook: hookEl ? hookEl.getAttribute('data-gaction') : null, id: a.id || null,
    next: at >= 0 ? ids.slice(at + 1) : [], prev: at >= 0 ? ids.slice(0, at).reverse() : [] };
}
function applyGamesFocus(rec) {
  if (!rec || !documentHasFocus()) return;
  const screen = document.getElementById('gamesScreen');
  if (!screen || typeof screen.querySelector !== 'function') return;
  const q = JSON.stringify.bind(JSON);
  const usable = el => !!el && !el.disabled && typeof el.focus === 'function';
  let el = null;
  if (rec.row) {
    const inRow = (r, sel) => screen.querySelector(`[${rec.attr}=${q(String(r))}] ${sel}`);
    if (rec.hook) el = inRow(rec.row, `[data-gaction=${q(rec.hook)}]`);
    if (!usable(el)) el = inRow(rec.row, '[data-gaction="more"], [data-gaction="expand"]');
    for (const r of rec.next.concat(rec.prev)) { if (usable(el)) break; el = inRow(r, '[data-gaction="more"], [data-gaction="expand"]'); }
  } else if (rec.id) el = document.getElementById(rec.id);
  else if (rec.hook) el = screen.querySelector(`[data-gaction=${q(rec.hook)}]`);
  if (!usable(el)) el = screen.querySelector('[data-games-empty], #gSearch, #gamesTitle');
  if (usable(el)) el.focus();
}

// ── IGDB, through the igdb function ──
async function igdbQueries(queries) {
  const out = {};
  for (let i = 0; i < queries.length; i += 10) {
    const headers = await authHeaders({ 'Content-Type': 'application/json' });
    let res;
    try { res = await fetch(`${SUPABASE_URL}/functions/v1/igdb`, { method: 'POST', headers, body: JSON.stringify({ queries: queries.slice(i, i + 10) }) }); }
    catch (e) { throw new Error('IGDB couldn’t be reached. Try again later.'); }
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (!res.ok || !j || !Array.isArray(j.results)) throw new Error((j && j.message) || `IGDB couldn’t be reached (${res.status}). Try again later.`);
    for (const r of j.results) { if (r.error) throw new Error(`IGDB refused a request (${r.error}). Try again later.`); out[r.name] = r.data; }
  }
  return out;
}
// IGDB records by id (and their time to beat), in batches; Map(id → cache record).
async function igdbRecords(ids) {
  const list = [...new Set(ids)].filter(Number.isInteger);
  const queries = [];
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500).join(',');
    queries.push({ name: `g${i}`, endpoint: 'games', body: `fields ${IGDB_GAME_FIELDS}; where id = (${part}); limit 500;` },
      { name: `t${i}`, endpoint: 'game_time_to_beats', body: `fields game_id,hastily,normally,completely,count; where game_id = (${part}); limit 500;` });
  }
  const out = new Map();
  if (!queries.length) return out;
  const r = await igdbQueries(queries);
  const ttb = new Map();
  Object.keys(r).filter(k => k[0] === 't').forEach(k => (r[k] || []).forEach(t => ttb.set(t.game_id, igdbHours(t))));
  Object.keys(r).filter(k => k[0] === 'g').forEach(k => (r[k] || []).forEach(g => out.set(g.id, igdbRecord(g, { hours: ttb.get(g.id) || null }))));
  return out;
}
// The records a version brings along: its parent, ports, remasters and remakes (one level).
const relatedIds = rec => [rec.parent, ...rec.ports, ...rec.remasters, ...rec.remakes].filter(Boolean);
async function igdbRecordsWithRelated(ids, known = new Map()) {
  const first = await igdbRecords(ids);
  const more = [...first.values()].flatMap(relatedIds).filter(id => !first.has(id));
  const second = await igdbRecords(more);
  second.forEach((v, k) => first.set(k, v));
  // Memberships already known for these records are kept (a franchise refresh sets them).
  first.forEach((v, k) => { const old = known.get(k); if (old && old.m) v.m = { ...old.m, ...v.m }; });
  return first;
}
function cacheRows(recs) { return [...recs.values()].map(r => ({ igdb_id: r.id, data: { ...r, fetched: new Date().toISOString() } })); }
async function putCache(recs) {
  const rows = cacheRows(recs);
  for (let i = 0; i < rows.length; i += 500) await sbRpc('library_game_titles_put', { p_rows: rows.slice(i, i + 500) });
  if (gamesData) recs.forEach((v, k) => gamesData.cache.set(k, v));
}

// ── + Add game: search IGDB, preview the versions, save one or follow its franchise ──
function openGamesAdd(opener) {
  gamesAdd = { session: ++gamesAddSeq, query: '', status: 'idle', results: [], pick: null, related: new Map(), message: '', opener: opener || null };
  showGameDialog(renderGamesAddHtml());
  focusFilterTarget('gAddSearch');
}
function renderGamesAddHtml() {
  const a = gamesAdd;
  if (!a) return '';
  let body = '';
  if (a.status === 'searching') body = '<p class="modal-progress">Searching IGDB…</p>';
  else if (a.status === 'error') body = `<p class="modal-error" role="alert">${esc(a.message)}</p>`;
  else if (a.pick) body = gamesAddPreviewHtml(a);
  else if (a.status === 'ready') body = a.results.length ? `<ul class="games-results">${a.results.map(r => `<li><button class="btn-link" data-gaction="pick-${r.id}" onclick="pickGameResult(${r.id})">${esc(r.name)}</button> <span class="muted">${esc([r.first ? r.first.slice(0, 4) : 'TBA', r.type !== 'main' ? r.type : ''].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>` : '<p>No games found.</p>';
  return `<h2 class="modal-title" id="gameDialogTitle">Add a game</h2>
    <div class="games-search-row"><label class="visually-hidden" for="gAddSearch">Search IGDB</label>
      <input id="gAddSearch" class="search-input" type="search" placeholder="Search IGDB" value="${esc(a.query)}" oninput="gamesAdd.query = this.value" onkeydown="if (event.key === 'Enter') { event.preventDefault(); searchGamesAdd(); }">
      <button class="btn" onclick="searchGamesAdd()">Search</button></div>
    ${body}
    <p class="games-note">Game data from IGDB.com. Saving a game doesn’t follow its franchise.</p>
    <div class="modal-actions"><button class="btn" onclick="closeGameDialog()">Close</button></div>`;
}
async function searchGamesAdd() {
  const a = gamesAdd;
  if (!a) return;
  const q = String(a.query || '').replace(/["\\]/g, ' ').trim();
  if (!q) return;
  const session = a.session;
  a.status = 'searching'; a.pick = null; showGameDialog(renderGamesAddHtml());
  try {
    const r = await igdbQueries([{ name: 'search', endpoint: 'games', body: `search "${q}"; fields ${IGDB_GAME_FIELDS}; where game_type = (0,4,8,9,10,11) & version_parent = null; limit 20;` }]);
    if (!gamesAdd || gamesAdd.session !== session) return;
    a.results = (r.search || []).map(g => igdbRecord(g)); a.status = 'ready';
  } catch (e) {
    if (!gamesAdd || gamesAdd.session !== session) return;
    a.status = 'error'; a.message = e.message;
  }
  showGameDialog(renderGamesAddHtml());
  focusFilterTarget('gAddSearch');
}
async function pickGameResult(id) {
  const a = gamesAdd;
  if (!a) return;
  const session = a.session;
  a.status = 'searching'; showGameDialog(renderGamesAddHtml());
  try {
    const recs = await igdbRecordsWithRelated([id], gamesData ? gamesData.cache : new Map());
    if (!gamesAdd || gamesAdd.session !== session) return;
    a.related = recs; a.pick = recs.get(id) || a.results.find(r => r.id === id); a.status = 'ready';
  } catch (e) {
    if (!gamesAdd || gamesAdd.session !== session) return;
    a.status = 'error'; a.message = e.message;
  }
  showGameDialog(renderGamesAddHtml());
  const first = document.querySelector('#gameDialogBox [data-gaction^="savev-"], #gameDialogBox [data-gaction^="followc-"]');
  if (first && typeof first.focus === 'function') first.focus();
}
function gamesAddPreviewHtml(a) {
  const st = gamesState(), cache = new Map([...(gamesData ? gamesData.cache : new Map()), ...a.related]);
  const pick = a.pick, anchor = cache.get(gameAnchor(pick, cache)) || pick;
  const versions = [anchor, ...[...anchor.remasters, ...anchor.remakes].map(x => cache.get(x)).filter(Boolean)];
  if (!versions.some(v => v.id === pick.id)) versions.push(pick);
  const saved = new Map(); (gamesData ? gamesData.entries : []).forEach(e => { saved.set(e.igdb_id, e); (e.port_ids || []).forEach(p => saved.set(p, e)); });
  const rows = versions.map(v => {
    const ports = gamePlainPorts(v, cache).map(p => cache.get(p)).filter(Boolean);
    const av = gameAvailability([v, ...ports], { ...st, cache });
    const kind = v.id === anchor.id ? 'Original' : v.type === 'remake' ? 'Remake' : v.type === 'remaster' ? 'Remaster' : v.type;
    const e = saved.get(v.id);
    const action = e ? `<span class="game-state">In your library (${esc(GAME_STATUS_LABELS[e.status])})</span>` : `<button class="btn btn-accent" data-gaction="savev-${v.id}" onclick="saveGameRecord(${v.id})">Save</button>`;
    return `<li class="spot-version"><span class="spot-version-name">${esc(v.name)} <span class="muted">${esc(kind)} · ${esc(v.first ? v.first.slice(0, 4) : 'TBA')}</span></span>
      <span class="spot-version-line">${esc(av.line ? gameLineText(av.line) : 'Not on your platforms')}${ports.length ? ` · with ${countUnit(ports.length, 'port', 'ports')}` : ''}</span>${action}</li>`;
  }).join('');
  const follows = pick.collections.concat(anchor.id !== pick.id ? anchor.collections : []).filter((c, i, l) => l.findIndex(x => x.id === c.id) === i).map(c => {
    const on = gamesData && gamesData.follows.some(f => f.igdb_collection_id === c.id);
    return on ? `<span class="game-state">Following ${esc(c.name)}</span>` : `<button class="btn" data-gaction="followc-${c.id}" onclick="followFranchise(${c.id}, '${jsArg(c.name)}')">Follow ${esc(c.name)}</button>`;
  }).join(' ');
  return `<div class="games-preview"><h3>${esc(pick.name)}</h3>
    <p class="games-note">Versions of this game. An original, a remaster and a remake are separate games you can save and queue on their own; finishing any of them completes the franchise spot. Ports for another system join the version they port.</p>
    <ul class="spot-versions">${rows}</ul>
    ${follows ? `<div class="games-follow">${follows}</div>` : ''}
    <button class="btn-link" onclick="gamesAdd.pick = null; showGameDialog(renderGamesAddHtml())">← Back to results</button></div>`;
}
// Saves one IGDB record as a game version: Want to play, Normal, its spot (the original it counts for) and its plain ports.
async function saveGameRecord(id) {
  const cache = new Map([...(gamesData ? gamesData.cache : new Map()), ...(gamesAdd ? gamesAdd.related : new Map())]);
  let recs = cache;
  if (!cache.get(id)) { try { recs = await igdbRecordsWithRelated([id], cache); recs.forEach((v, k) => cache.set(k, v)); } catch (e) { showError(e.message); return; } }
  const rec = cache.get(id);
  if (!rec) return;
  const taken = new Set(); (gamesData ? gamesData.entries : []).forEach(e => { taken.add(e.igdb_id); (e.port_ids || []).forEach(p => taken.add(p)); });
  const ports = gamePlainPorts(rec, cache).filter(p => !taken.has(p));
  const spot = gameAnchor(rec, cache);
  const keep = new Map([[rec.id, rec], ...ports.map(p => [p, cache.get(p)]).filter(x => x[1]), ...(cache.get(spot) ? [[spot, cache.get(spot)]] : []),
    ...relatedIds(rec).map(x => [x, cache.get(x)]).filter(x => x[1])]);
  await runWrite(`“${rec.name}” · save`, async () => {
    try {
      await putCache(keep);
      const made = await sbRpc('library_game_add', { p_igdb_id: rec.id, p_title: rec.name.slice(0, 300), p_spot_igdb_id: spot, p_port_ids: ports, p_status: 'want', p_priority: 'normal' });
      if (gamesData && made) gamesData.entries.push(made);
      showSaved();
      showNotice(`Saved “${rec.name}” as Want to play.`);
      if (gamesAdd) showGameDialog(renderGamesAddHtml());
      if (isGamesView()) renderGamesView();
      writeLane.after.push(() => { if (isGamesView()) reloadOpenView(); });
    } catch (e) {
      if (gamesAdd) { gamesAdd.message = stateErrorText(e); }
      showError(stateErrorText(e));
      if (stateNeedsReread(e) && isGamesView()) await reloadOpenView();
    }
  }, { list: isGamesView() });
}

// ── Changes from the rows ──
async function setGameStatus(entryId, status, where = 'library') {
  const src = where === 'queue' && queuesData && queuesData.games ? queuesData.games : gamesData;
  const e = src && src.entries.find(x => x.id === entryId);
  if (!e || e.status === status) return;
  await gameSet(e, status, e.priority, where);
}
async function setGamePriority(entryId, priority) {
  const e = gamesData && gamesData.entries.find(x => x.id === entryId);
  if (!e || e.priority === priority) return;
  await gameSet(e, e.status, priority, 'library');
}
async function gameSet(e, status, priority, where) {
  const label = `“${e.title}” · ${status !== e.status ? GAME_STATUS_LABELS[status] : 'priority'}`;
  await runWrite(label, async lane => {
    const before = { status: e.status, priority: e.priority };
    e.status = status; e.priority = priority;
    if (where === 'queue') { if (typeof noteQueueSaved === 'function') { renderQueuesView(); } } else renderGamesView();
    try {
      const r = await sbRpc('library_game_set', { p_entry_id: e.id, p_expected: before, p_status: status, p_priority: priority });
      showSaved();
      if (r && r.queue_entries_removed) showNotice(`“${e.title}” is Finished, so it left ${countUnit(r.queue_entries_removed, 'queue', 'queues')}. You can queue it again to replay it.`);
      lane.after.push(() => reloadOpenView());
    } catch (err) {
      e.status = before.status; e.priority = before.priority;
      if (stateNeedsReread(err)) { await reportStateFailure(err); return; }
      showError(stateErrorText(err));
      if (where === 'queue') renderQueuesView(); else renderGamesView();
    }
  }, { list: true });
}
function confirmDeleteGame(entryId) {
  const e = gamesData && gamesData.entries.find(x => x.id === entryId);
  if (!e) return;
  showGameDialog(`<h2 class="modal-title" id="gameDialogTitle">Delete “${esc(e.title)}”?</h2>
    <p>It leaves your library, every queue and every game collection. Your decisions about its releases stay.</p>
    <div class="modal-actions"><button class="btn" onclick="closeGameDialog()">Cancel</button>
      <button class="btn-danger" id="gDeleteConfirm" onclick="deleteGame('${jsArg(e.id)}')">Delete from library</button></div>`);
  focusFilterTarget('gDeleteConfirm');
}
async function deleteGame(entryId) {
  const e = gamesData && gamesData.entries.find(x => x.id === entryId);
  if (!e) { closeGameDialog(); return; }
  // Focus afterwards: the next game's ⋯, else the previous one's (the list's rule), not the dialog's opener that goes away.
  const box = document.getElementById('gamesScreen');
  const ids = box && typeof box.querySelectorAll === 'function' ? [...box.querySelectorAll('[data-game]')].map(x => x.getAttribute('data-game')) : [];
  const at = ids.indexOf(e.id);
  gamesFocusIntent = { attr: 'data-game', row: e.id, hook: 'more', next: at >= 0 ? ids.slice(at + 1) : [], prev: at >= 0 ? ids.slice(0, at).reverse() : [] };
  closeGameDialog(false);
  await runWrite(`“${e.title}” · delete`, async lane => {
    try {
      const r = await sbRpc('library_game_delete', { p_entry_id: e.id, p_expected_status: e.status });
      gamesData.entries = gamesData.entries.filter(x => x.id !== e.id);
      gamesData.members = gamesData.members.filter(m => m.entry_id !== e.id);
      showSaved();
      showNotice(`Deleted “${e.title}”${r && r.queue_entries_removed ? `; it left ${countUnit(r.queue_entries_removed, 'queue', 'queues')}` : ''}.`);
      renderGamesView();
      lane.after.push(() => reloadOpenView());
    } catch (err) {
      if (stateNeedsReread(err)) { await reportStateFailure(err); return; }
      showError(stateErrorText(err));
    }
  }, { list: true });
}
// A standing decision (games-data.js): set (value) or cleared (null), with the value the page showed.
async function setGameDecision(kind, igdbId, platform, value, label) {
  const key = gameDecisionKey(kind, igdbId, platform || ''), cur = gamesData && gamesData.decisions.get(key);
  await runWrite(label, async lane => {
    try {
      await sbRpc('library_game_decision_set', { p_kind: kind, p_igdb_id: igdbId, p_platform: platform || '', p_expected: cur ? cur.value : null, p_value: value });
      if (value === null) gamesData.decisions.delete(key); else gamesData.decisions.set(key, { kind, igdb_id: igdbId, platform: platform || '', value });
      showSaved();
      renderGamesView();
      lane.after.push(() => reloadOpenView());
    } catch (err) {
      if (stateNeedsReread(err)) { await reportStateFailure(err); return; }
      showError(stateErrorText(err));
    }
  }, { list: true });
}
// Not out yet: holds this one platform release out of the member's Up next while IGDB's row is as shown (its date and precision).
function setNotOutYet(igdbId, platform, dateKey, precision) {
  return setGameDecision('not_out_yet', igdbId, platform, { date: dateKey, precision }, `Not out yet on ${GAME_PLATFORM_LABEL[platform] || platform}`);
}
function clearNotOutYet(igdbId, platform) { return setGameDecision('not_out_yet', igdbId, platform, null, 'It’s out'); }
function toggleSkipSpot(spotId, skipped) { return setGameDecision('skip_spot', spotId, '', skipped ? null : {}, skipped ? 'Unskip this spot' : 'Skip this spot'); }
function toggleIncludeSpinoff(spotId, included) { return setGameDecision('include_spinoff', spotId, '', included ? null : {}, included ? 'Don’t count the spin-off' : 'Count the spin-off'); }

// ── Following ──
async function followFranchise(collectionId, name) {
  let recs;
  try { recs = await readFranchise(collectionId, gamesData ? gamesData.cache : new Map()); } catch (e) { showError(`${e.message} Nothing was changed.`); return; }
  await runWrite(`Follow ${name}`, async lane => {
    try {
      const f = await sbRpc('library_game_follow', { p_collection_igdb_id: collectionId, p_name: String(name).slice(0, 200) || `Series ${collectionId}` });
      await putCache(recs);
      if (gamesData && f) gamesData.follows.push(f);
      showSaved();
      showNotice(`Following ${name}. Its Up next and Coming are in Games → Franchises. Nothing was added to your library or queues.`);
      if (gamesAdd) showGameDialog(renderGamesAddHtml());
      if (isGamesView()) renderGamesView();
      lane.after.push(() => { if (isGamesView()) reloadOpenView(); });
    } catch (err) {
      showError(stateErrorText(err));
      if (stateNeedsReread(err) && isGamesView()) await reloadOpenView();
    }
  }, { list: isGamesView() });
}
async function unfollowFranchise(followId) {
  const f = gamesData && gamesData.follows.find(x => x.id === followId);
  if (!f) return;
  await runWrite(`Stop following ${f.name}`, async lane => {
    try {
      await sbRpc('library_game_unfollow', { p_follow_id: f.id });
      gamesData.follows = gamesData.follows.filter(x => x.id !== f.id);
      gamesExpanded.delete(f.id);
      showSaved();
      showNotice(`You no longer follow ${f.name}. Your saved games, queues and collections are unchanged.`);
      renderGamesView();
      lane.after.push(() => reloadOpenView());
    } catch (err) {
      if (stateNeedsReread(err)) { await reportStateFailure(err); return; }
      showError(stateErrorText(err));
    }
  }, { list: true });
}
// A franchise from IGDB: its series' members (main and spin-off) with their records and related versions.
async function readFranchise(collectionId, known) {
  const r = await igdbQueries([{ name: 'm', endpoint: 'collection_memberships', body: `fields game,type; where collection = ${collectionId}; limit 500;` }]);
  const types = new Map((r.m || []).map(x => [typeof x.game === 'object' ? x.game.id : x.game, IGDB_MEMBERSHIP[typeof x.type === 'object' ? x.type.id : x.type] || 'member']));
  const recs = await igdbRecordsWithRelated([...types.keys()], known);
  recs.forEach((rec, id) => { rec.m = { ...(rec.m || {}) }; if (types.has(id)) rec.m[collectionId] = types.get(id); else delete rec.m[collectionId]; });
  return recs;
}

// ── Refresh: followed franchises' membership (new games), known games (new ports, dates, platforms) ──
async function refreshGames() {
  if (!gamesData || gamesRefreshing) return;
  if (writeLane) { showError(LANE_BUSY_TEXT(writeLane.label)); return; }
  gamesRefreshing = true; gamesReport = ''; renderGamesView();
  const old = new Map(gamesData.cache), st = gamesState(); // (a copy: saving the new records changes gamesData.cache)
  const before = new Map(gamesData.follows.map(f => [f.id, franchiseSummary(f, st)]));
  let recs = new Map();
  try {
    for (const f of gamesData.follows) (await readFranchise(f.igdb_collection_id, old)).forEach((v, k) => recs.set(k, { ...(recs.get(k) || {}), ...v, m: { ...((recs.get(k) || {}).m || {}), ...v.m } }));
    const savedIds = gamesData.entries.flatMap(e => [e.igdb_id, ...(e.port_ids || [])]).filter(id => !recs.has(id));
    (await igdbRecordsWithRelated(savedIds, old)).forEach((v, k) => { if (!recs.has(k)) recs.set(k, v); });
  } catch (e) {
    gamesRefreshing = false; gamesReport = '';
    showError(`Refresh couldn’t read IGDB (${e.message}), so nothing was changed.`);
    renderGamesView();
    return;
  }
  await runWrite('Refresh games', async lane => {
    const notes = [];
    try {
      await putCache(recs);
      // New ordinary ports of saved games join them (IGDB types them as ports of that record), guarded by what was read.
      const cache = gamesData.cache, taken = new Set(gamesData.entries.flatMap(e => [e.igdb_id, ...(e.port_ids || [])]));
      for (const e of gamesData.entries) {
        const add = gamePlainPorts(cache.get(e.igdb_id), cache).filter(p => !taken.has(p));
        if (!add.length) continue;
        const ports = [...(e.port_ids || []), ...add];
        await sbRpc('library_game_relink', { p_entry_id: e.id, p_expected: { spot_igdb_id: e.spot_igdb_id, port_ids: e.port_ids || [] }, p_spot_igdb_id: e.spot_igdb_id, p_port_ids: ports });
        add.forEach(p => taken.add(p)); e.port_ids = ports;
        notes.push(`${countUnit(add.length, 'port', 'ports')} joined “${e.title}”`);
      }
      const now = gamesState();
      for (const f of gamesData.follows) {
        const a = before.get(f.id), b = franchiseSummary(f, now);
        const had = new Set(a ? a.coming.map(c => `${c.version.rec.id}|${c.c.platform}`) : []);
        b.coming.filter(c => !had.has(`${c.version.rec.id}|${c.c.platform}`) && !old.has(c.version.rec.id)).forEach(c => notes.push(`New in ${f.name}: ${c.version.rec.name} · ${gameLineText(c.c)}`));
        const upA = a && a.upNext ? a.upNext.version.rec.id : null, upB = b.upNext ? b.upNext.version.rec.id : null;
        if (upA !== upB) notes.push(`${f.name}: ${b.upNext ? `Up next is now ${b.upNext.version.rec.name}` : 'Caught up'}`);
      }
      showSaved();
      gamesReport = notes.length ? `<strong>Refresh:</strong> ${notes.map(esc).join(' · ')}. Nothing was added to Want to play or your queues.` : 'Refresh: no changes from IGDB.';
      lane.after.push(() => reloadOpenView());
    } catch (err) {
      showError(stateErrorText(err));
      if (stateNeedsReread(err)) await reloadOpenView();
    }
  }, { list: true });
  gamesRefreshing = false;
  if (isGamesView()) renderGamesView();
}

// ── Review: relationship changes and ambiguous chains for saved games ──
function gamesReviewItems(data) {
  if (!data) return [];
  const cache = data.cache, items = [];
  for (const e of data.entries) {
    const rec = cache.get(e.igdb_id);
    if (!rec) continue;
    const derived = gameAnchor(rec, cache);
    const keep = data.decisions.get(gameDecisionKey('keep_link', e.igdb_id));
    const kept = keep && keep.value && keep.value.spot_igdb_id === derived;
    if (gameAmbiguousChain(rec, cache) && !keep) {
      items.push({ kind: 'chain', entry: e, rec, derived, text: `IGDB lists “${rec.name}” as a ${rec.type} of a port (${(cache.get(rec.parent) || {}).name || 'another record'}). It counts for the same franchise spot as ${(cache.get(derived) || {}).name || 'its original'}.` });
    } else if (derived !== e.spot_igdb_id && !kept) {
      items.push({ kind: 'spot', entry: e, rec, derived, text: `IGDB now places “${rec.name}” under ${(cache.get(derived) || {}).name || `IGDB ${derived}`}; your progress counts it under ${(cache.get(e.spot_igdb_id) || {}).name || `IGDB ${e.spot_igdb_id}`}.` });
    }
  }
  return items;
}
function openGamesReview(opener) {
  const items = gamesReviewItems(gamesData);
  gamesReviewOpener = opener || null;
  showGameDialog(`<h2 class="modal-title" id="gameDialogTitle">Review IGDB changes</h2>
    <p class="games-note">Your saved games, statuses and queue places don’t change until you choose. “Keep mine” stays decided until IGDB changes again.</p>
    <ul class="games-review">${items.map((it, i) => `<li><p>${esc(it.text)}</p>
      ${it.kind === 'spot' ? `<button class="btn btn-accent" onclick="reviewUseIgdb(${i})">Use IGDB’s</button> ` : `<button class="btn btn-accent" onclick="reviewKeep(${i})">Keep it a separate version</button> `}
      <button class="btn" onclick="reviewKeep(${i})">${it.kind === 'spot' ? 'Keep mine' : 'Decide later'}</button></li>`).join('') || '<li>Nothing to review.</li>'}</ul>
    <div class="modal-actions"><button class="btn" onclick="closeGameDialog()">Close</button></div>`);
}
async function reviewUseIgdb(i) {
  const it = gamesReviewItems(gamesData)[i];
  if (!it) return;
  closeGameDialog();
  await runWrite(`“${it.entry.title}” · link`, async lane => {
    try {
      await sbRpc('library_game_relink', { p_entry_id: it.entry.id, p_expected: { spot_igdb_id: it.entry.spot_igdb_id, port_ids: it.entry.port_ids || [] }, p_spot_igdb_id: it.derived, p_port_ids: it.entry.port_ids || [] });
      it.entry.spot_igdb_id = it.derived;
      showSaved(); renderGamesView();
      lane.after.push(() => reloadOpenView());
    } catch (err) { if (stateNeedsReread(err)) { await reportStateFailure(err); return; } showError(stateErrorText(err)); }
  }, { list: true });
}
function reviewKeep(i) {
  const it = gamesReviewItems(gamesData)[i];
  if (!it) return;
  closeGameDialog();
  return setGameDecision('keep_link', it.entry.igdb_id, '', { spot_igdb_id: it.derived, port_ids: it.entry.port_ids || [], kind: it.kind }, `“${it.entry.title}” · keep`);
}

// ── Collections ──
async function createGameCollection(name = gamesCollectionNew, after = null) {
  const n = String(name || '').trim();
  if (!n) { showError('Give the new collection a name. Nothing was changed.'); return null; }
  let made = null;
  await runWrite('New game collection', async lane => {
    try {
      made = await sbRpc('library_game_collection_create', { p_name: n });
      gamesData.collections = gamesData.collections.concat([made]).sort((a, b) => compareTitles(a.name, b.name));
      gamesCollectionNew = ''; gamesCollectionId = made.id;
      showSaved(); if (isGamesView()) renderGamesView();
      if (after) after(made);
      lane.after.push(() => { if (isGamesView()) reloadOpenView(); });
    } catch (err) { showError(stateErrorText(err)); if (stateNeedsReread(err) && isGamesView()) await reloadOpenView(); }
  }, { list: isGamesView() });
  return made;
}
async function renameGameCollection() {
  const ed = gamesCollectionEdit, c = ed && gamesData.collections.find(x => x.id === ed.id);
  if (!c) return;
  const n = String(ed.value || '').trim();
  if (!n || n === c.name) { gamesCollectionEdit = null; renderGamesView(); return; }
  await runWrite(`“${c.name}” · rename`, async lane => {
    try {
      await sbRpc('library_game_collection_rename', { p_collection_id: c.id, p_expected_name: c.name, p_name: n });
      c.name = n; gamesCollectionEdit = null; gamesFocusIntent = { hook: 'crename' };
      showSaved(); renderGamesView();
      lane.after.push(() => reloadOpenView());
    } catch (err) { if (stateNeedsReread(err)) { gamesCollectionEdit = null; await reportStateFailure(err); return; } showError(stateErrorText(err)); }
  }, { list: true });
}
async function deleteGameCollection() {
  const ed = gamesCollectionEdit, c = ed && gamesData.collections.find(x => x.id === ed.id);
  if (!c) return;
  const count = gamesData.members.filter(m => m.collection_id === c.id).length;
  await runWrite(`“${c.name}” · delete`, async lane => {
    try {
      await sbRpc('library_game_collection_delete', { p_collection_id: c.id, p_expected_count: count });
      gamesData.collections = gamesData.collections.filter(x => x.id !== c.id);
      gamesData.members = gamesData.members.filter(m => m.collection_id !== c.id);
      gamesCollectionEdit = null; gamesCollectionId = null; gamesFocusIntent = { id: 'gCollectionNew' };
      showSaved(); showNotice(`“${c.name}” was deleted. Its games stay in your library.`); renderGamesView();
      lane.after.push(() => reloadOpenView());
    } catch (err) { gamesCollectionEdit = null; if (stateNeedsReread(err)) { await reportStateFailure(err); return; } showError(stateErrorText(err)); renderGamesView(); }
  }, { list: true });
}
async function removeFromGameCollection(memberId) {
  const m = gamesData && gamesData.members.find(x => x.id === memberId);
  if (!m) return;
  await runWrite('Remove from collection', async lane => {
    gamesData.members = gamesData.members.filter(x => x !== m);
    renderGamesView();
    try {
      await sbRpc('library_game_collection_remove', { p_member_id: memberId });
      showSaved();
      lane.after.push(() => reloadOpenView());
    } catch (err) { gamesData.members.push(m); if (stateNeedsReread(err)) { await reportStateFailure(err); return; } showError(stateErrorText(err)); renderGamesView(); }
  }, { list: true });
}
function openGameCollectionAdd(entryId, opener) {
  const e = gamesData && gamesData.entries.find(x => x.id === entryId);
  if (!e) return;
  gamesCollectionAdd = { entryId, opener, choice: gamesData.collections[0] ? gamesData.collections[0].id : null, name: '' };
  renderGameCollectionAdd();
}
function renderGameCollectionAdd() {
  const a = gamesCollectionAdd, e = a && gamesData.entries.find(x => x.id === a.entryId);
  if (!e) return;
  const opts = gamesData.collections.map(c => {
    const has = gamesData.members.some(m => m.collection_id === c.id && m.entry_id === e.id);
    return `<label class="queue-add-option${has ? ' queue-add-blocked' : ''}"><input type="radio" name="gCollAdd" value="${esc(c.id)}"${a.choice === c.id && !has ? ' checked' : ''}${has ? ' disabled' : ''} onchange="gamesCollectionAdd.choice = this.value"> ${esc(c.name)}${has ? ' <span class="queue-add-note">Already in it</span>' : ''}</label>`;
  }).join('');
  showGameDialog(`<h2 class="modal-title" id="gameDialogTitle">Add “${esc(e.title)}” to a collection</h2>
    <fieldset class="queue-add-queues"><legend>Collection</legend>${opts || '<p class="queue-add-note">You have no game collections yet. Make one here.</p>'}
      <div class="queue-new"><label for="gCollAddNew">New collection</label> <input id="gCollAddNew" class="search-input" maxlength="100" value="${esc(a.name)}" oninput="gamesCollectionAdd.name = this.value">
        <button class="btn" onclick="createGameCollection(gamesCollectionAdd.name, c => { gamesCollectionAdd.choice = c.id; gamesCollectionAdd.name = ''; renderGameCollectionAdd(); })">Create</button></div></fieldset>
    <p class="games-note">A collection is yours alone. It doesn’t change the game’s status, queues or franchise.</p>
    <div class="modal-actions"><button class="btn" onclick="closeGameDialog()">Cancel</button> <button class="btn btn-accent" id="gCollAddSubmit" onclick="submitGameCollectionAdd()">Add</button></div>`);
}
async function submitGameCollectionAdd() {
  const a = gamesCollectionAdd, e = a && gamesData.entries.find(x => x.id === a.entryId), c = a && gamesData.collections.find(x => x.id === a.choice);
  if (!e || !c) return;
  await runWrite(`“${e.title}” · collection`, async lane => {
    try {
      const m = await sbRpc('library_game_collection_add', { p_collection_id: c.id, p_entry_id: e.id });
      gamesData.members.push(m);
      closeGameDialog();
      showSaved(); showNotice(`Added “${e.title}” to “${c.name}”.`); renderGamesView();
      lane.after.push(() => reloadOpenView());
    } catch (err) { showError(stateErrorText(err)); if (stateNeedsReread(err)) await reloadOpenView(); }
  }, { list: true });
}

// ── Details (IGDB's facts, the member's holds, and Store or publisher evidence with research access) ──
function openGameDetails(igdbId, opener) {
  const st = gamesState(), rec = st.cache.get(igdbId);
  const e = gamesData.entries.find(x => x.igdb_id === igdbId);
  gamesDetailsOpener = opener || null;
  if (!rec) { showGameDialog(`<h2 class="modal-title" id="gameDialogTitle">${esc(e ? e.title : `IGDB ${igdbId}`)}</h2><p>Its details haven’t been read from IGDB yet. Use Refresh.</p><div class="modal-actions"><button class="btn" onclick="closeGameDialog()">Close</button></div>`); return; }
  const recs = [rec].concat(e ? (e.port_ids || []).map(p => st.cache.get(p)).filter(Boolean) : []);
  const rows = recs.flatMap(r => r.releases.map(row => ({ r, row }))).sort((a, b) => cmpStr(a.row.p, b.row.p) || cmpStr(gameDateKey(a.row), gameDateKey(b.row)));
  const statusWords = { full: 'Full release', none: 'Release', beta: 'Beta (doesn’t count)', alpha: 'Alpha (doesn’t count)', early: 'Early access (doesn’t count)', advanced: 'Advanced access (doesn’t count)',
    offline: 'Offline', cancelled: 'Cancelled', compat: 'Compatibility listing (doesn’t count)', patch: 'Optimization patch (doesn’t count)', other: 'Other' };
  const len = recs[0].hours, style = st.style, lens = ['main', 'main_extra', 'completionist'].map(s => ({ s, l: gameLengthOf(rec, s) }));
  const holds = gamesData.decisionRows.filter(d => (d.kind === 'not_out_yet' || d.kind === 'available') && recs.some(r => r.id === d.igdb_id));
  const evidence = researchEnabled ? `<div class="modal-section"><div class="modal-label">Record Store or publisher evidence (research)</div>
      <p class="games-note">A current PlayStation Store or publisher page that says this version is available confirms it, even without an exact day.</p>
      <label>Platform <select id="gEvPlatform">${(st.platforms && st.platforms.length ? st.platforms : ['ps5']).map(p => `<option value="${p}">${esc(GAME_PLATFORM_LABEL[p])}</option>`).join('')}</select></label>
      <label>Known as <select id="gEvPrec"><option value="day">a day</option><option value="month">a month</option><option value="quarter">a quarter</option><option value="year">a year</option></select></label>
      <label>Date <input id="gEvDate" placeholder="2027-03-14, 2027-03, 2027-Q1 or 2027"></label>
      <label>Source <input id="gEvUrl" type="url" placeholder="https://"></label>
      <button class="btn" onclick="saveGameEvidence(${rec.id})">Save evidence</button></div>` : '';
  showGameDialog(`<h2 class="modal-title" id="gameDialogTitle">${esc(rec.name)}</h2>
    <div class="modal-section"><div class="modal-label">From IGDB</div>
      <p>${esc([rec.type === 'main' ? 'Game' : rec.type, rec.first ? `first released ${rec.first}` : 'not released yet', rec.genres.join(', ')].filter(Boolean).join(' · '))}</p>
      <p>${esc(gameScoresText(rec) || 'No scores on IGDB.')}</p></div>
    <div class="modal-section"><div class="modal-label">Releases (dates per IGDB)</div><ul class="manage-list">${rows.map(({ r, row }) => `<li>${esc(GAME_PLATFORM_LABEL[row.p])} · ${esc(gameDateText(row))}${row.r != null ? ` · ${esc(IGDB_REGIONS[row.r] || '')}` : ''} · ${esc(statusWords[row.s] || row.s)}${r.id !== rec.id ? ` · ${esc(r.name)}` : ''}${row.p === 'ps4' && onPs4OnlyList(r) ? ' · on Sony’s PS4-only list' : ''}</li>`).join('') || '<li>None listed.</li>'}</ul></div>
    <div class="modal-section"><div class="modal-label">Length (IGDB time to beat, ${len ? countUnit(len.count, 'submission', 'submissions') : 'none'})</div><ul class="manage-list">${lens.map(({ s, l }) => `<li>${esc(GAME_STYLE_LABELS[s])}: ${l.value == null ? 'unknown' : `${l.value} h${l.reliable ? '' : ' — reported, but the estimate is unreliable'}`}${s === style ? ' (your play style)' : ''}</li>`).join('')}</ul>
      <p><a href="${esc(gameSearchHltbUrl(rec.name))}" target="_blank" rel="noopener noreferrer">Search HowLongToBeat</a>${rec.store ? ` · <a href="${esc(rec.store)}" target="_blank" rel="noopener noreferrer">PlayStation Store (US)</a>` : ''}</p></div>
    ${holds.length ? `<div class="modal-section"><div class="modal-label">Your decisions</div><ul class="manage-list">${holds.map(d => `<li>${d.kind === 'not_out_yet' ? `Not out yet on ${esc(GAME_PLATFORM_LABEL[d.platform])} (IGDB’s ${esc(d.value.date)})` : `Available on ${esc(GAME_PLATFORM_LABEL[d.platform])} (Store or publisher evidence)`}</li>`).join('')}</ul></div>` : ''}
    ${evidence}
    <div class="modal-actions"><button class="btn" onclick="closeGameDialog()">Close</button></div>`);
}
function saveGameEvidence(igdbId) {
  const p = (document.getElementById('gEvPlatform') || {}).value, prec = (document.getElementById('gEvPrec') || {}).value;
  const date = String((document.getElementById('gEvDate') || {}).value || '').trim(), url = String((document.getElementById('gEvUrl') || {}).value || '').trim();
  if (!/^https:\/\/\S+$/.test(url)) { showError('Give the Store or publisher page’s address (https://…). Nothing was changed.'); return; }
  const v = { precision: prec, evidence: [{ url, recorded: localTodayStr() }] };
  let m;
  if (prec === 'day' && (m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date))) v.date = date;
  else if (prec === 'month' && (m = /^(\d{4})-(\d{2})$/.exec(date))) { v.year = +m[1]; v.month = +m[2]; }
  else if (prec === 'quarter' && (m = /^(\d{4})-Q([1-4])$/i.exec(date))) { v.year = +m[1]; v.quarter = +m[2]; }
  else if (prec === 'year' && (m = /^(\d{4})$/.exec(date))) v.year = +m[1];
  else { showError('The date doesn’t match what you chose (2027-03-14, 2027-03, 2027-Q1 or 2027). Nothing was changed.'); return; }
  closeGameDialog();
  return setGameDecision('available', igdbId, p, v, 'Store or publisher evidence');
}

// ── The dialog ──
function showGameDialog(html) {
  const overlay = document.getElementById('gameDialogOverlay'), box = document.getElementById('gameDialogBox');
  if (!overlay || !box) return;
  if (overlay.style.display === 'none') gamesDialogOpener = document.activeElement || null;
  box.innerHTML = html;
  overlay.style.display = 'flex';
  if (document.activeElement && !box.contains(document.activeElement) && typeof box.focus === 'function') box.focus();
}
function closeGameDialog(returnFocus = true) {
  const overlay = document.getElementById('gameDialogOverlay'), box = document.getElementById('gameDialogBox');
  const opener = gamesDialogOpener;
  gamesAdd = null; gamesCollectionAdd = null; gamesDialogOpener = null;
  if (overlay) overlay.style.display = 'none';
  if (box) box.innerHTML = '';
  // (an opener redrawn meanwhile: its successor, found by its hook; else the heading)
  const hook = opener && typeof opener.getAttribute === 'function' ? opener.getAttribute('data-gaction') : null;
  if (returnFocus) returnDialogFocus(opener, () => (hook && document.querySelector(`#gamesScreen [data-gaction="${hook}"]`)) || document.getElementById('gamesTitle') || document.getElementById('mainContent'));
}
function gameDialogKeydown(event) {
  dialogKeydown(event, document.getElementById('gameDialogBox'), 'button, input, select, a, [tabindex="0"]', closeGameDialog);
}
function gamesOnNavigate() {
  const overlay = document.getElementById('gameDialogOverlay');
  if (overlay && overlay.style.display !== 'none' && !writeLane) closeGameDialog();
  gamesCollectionEdit = null; gamesReport = '';
}

// ── Settings → Games (platforms and play style; they follow the member across devices and are in backups) ──
function gamesSettingHtml() {
  const s = gamesSettingsRead && gamesSettingsRead.settings, state = gamesSettingsRead ? gamesSettingsRead.status : 'loading';
  const plats = s ? s.platforms : [], style = s ? s.play_style : 'main';
  const body = state === 'loading' ? '<p class="settings-text">Loading…</p>' : state === 'error' ? `<p class="settings-status warn">Couldn’t be read. <button class="btn" onclick="readGamesSettings(true)">Retry</button></p>`
    : `<fieldset class="settings-fieldset"><legend>My platforms</legend>${GAME_PLATFORMS.map(p => `<label class="settings-check"><input type="checkbox" class="games-platform" value="${p.key}"${plats.includes(p.key) ? ' checked' : ''} onchange="saveGamesSettings()"> ${esc(p.label)}</label>`).join('')}</fieldset>
      <p class="settings-text">With PS5 chosen, PS4 games that play on PS5 show too, labelled “PS4 · Playable on PS5” with their PS4 date (unless Sony lists them as PS4 only). Games on none of your platforms are hidden but keep their status, priority, collections and queue places.</p>
      <fieldset class="settings-fieldset"><legend>My play style (for game length)</legend>${Object.entries(GAME_STYLE_LABELS).map(([v, l]) => `<label class="settings-check"><input type="radio" name="gamesStyle" class="games-style" value="${v}"${style === v ? ' checked' : ''} onchange="saveGamesSettings()"> ${esc(l)}</label>`).join('')}</fieldset>`;
  return `<section class="settings-card" aria-labelledby="settingsGamesTitle"><h3 id="settingsGamesTitle" tabindex="-1">Games</h3>${body}
    <p class="settings-text">Saved with your library, so they follow you to every device and come back with a restore.</p></section>`;
}
// Read once at sign-in (and again by Retry, or after a refused save), like the collections, so opening Settings reads nothing.
async function readGamesSettings(redraw) {
  const stamp = readStamp();
  if (redraw) { gamesSettingsRead = { status: 'loading' }; redrawGamesSetting(); }
  try {
    const rows = await fetchAllRows('game_settings');
    if (!readFresh(stamp)) { readAgainWhenFree(() => readGamesSettings(false)); return; }
    gamesSettingsRead = { status: 'ready', settings: rows[0] || null };
  } catch (e) { gamesSettingsRead = { status: 'error' }; }
  redrawGamesSetting();
}
// The Games card alone, in place (focus kept on the same choice).
function redrawGamesSetting() {
  const card = document.getElementById('settingsGamesTitle');
  if (!isSettingsView() || !card || typeof card.closest !== 'function') return;
  const sec = card.closest('section');
  if (!sec) return;
  const value = document.activeElement && document.activeElement.value;
  sec.outerHTML = gamesSettingHtml();
  refocusGamesSetting(value);
}
function refocusGamesSetting(value) {
  if (!value) return;
  const el = document.querySelector(`.games-platform[value=${JSON.stringify(value)}], .games-style[value=${JSON.stringify(value)}]`);
  if (el && typeof el.focus === 'function') el.focus();
}
async function saveGamesSettings() {
  if (!gamesSettingsRead || gamesSettingsRead.status !== 'ready') return;
  const s = gamesSettingsRead.settings;
  const platforms = [...document.querySelectorAll('.games-platform')].filter(x => x.checked).map(x => x.value);
  const styleEl = [...document.querySelectorAll('.games-style')].find(x => x.checked);
  const style = styleEl ? styleEl.value : (s ? s.play_style : 'main');
  const focused = document.activeElement && document.activeElement.value;
  await runWrite('Games settings', async lane => {
    try {
      const saved = await sbRpc('library_game_settings_save', { p_expected: s ? { platforms: s.platforms, play_style: s.play_style } : null, p_platforms: platforms, p_play_style: style });
      gamesSettingsRead = { status: 'ready', settings: saved };
      if (gamesData) gamesData.settings = saved;
      showSaved();
    } catch (err) {
      showError(stateErrorText(err));
      lane.after.push(() => readGamesSettings(false));
    }
    redrawGamesSetting();
  });
}
