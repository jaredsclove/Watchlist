// ─── Games (G1, next-gen item 5; db/g1_games.sql, games-data.js) ───────────────
// The Games area, drawn as TV (TV's tabs, toolbar, rows and cards): Library (each saved game version with its platforms, status, priority, genres and scores), Franchises
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
    platforms: s ? s.platforms : null, today };
}
// A saved game as its rows show it.
function gameEntryView(e, st) {
  const rec = st.cache.get(e.igdb_id) || null;
  const recs = rec ? [rec].concat((e.port_ids || []).map(p => st.cache.get(p)).filter(Boolean)) : [];
  const avail = gameAvailability(recs, st);
  return { entry: e, rec, avail, title: rec ? rec.name : e.title, hidden: !!avail.hiddenByPlatforms,
    genres: rec ? rec.genres : [], dateKey: avail.line ? avail.line.key : null, group: gameGroupOf(e, st.cache) };
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
  const noPlatforms = !st.platforms || !st.platforms.length;
  // As TV: the views are the secondary tab row (tabs.js); the heading is for screen readers and focus.
  const head = `<h2 class="visually-hidden games-title" id="gamesTitle" tabindex="-1">Games: ${esc(GAMES_VIEW_LABELS[activeViewId])}</h2>
    ${noPlatforms ? `<p class="games-note" data-games-prompt="1">Choose your platforms in <button class="btn-link" onclick="openSettings(this, 'games')">Settings → Games</button> to see only what you can play, with dates for your systems.</p>` : ''}
    ${gamesReport ? `<div class="games-report" role="status">${gamesReport}</div>` : ''}`;
  let body = '';
  if (view === 'library') body = gamesLibraryHtml(st);
  else if (view === 'franchises') body = gamesFranchisesHtml(st);
  else body = gamesCollectionsHtml(st);
  screen.innerHTML = head + body;
  if ((view === 'library' || view === 'collections') && typeof renderSortLine === 'function') renderSortLine();
  applyGamesFocus(rec);
}
// + Add game, Refresh and Review: after the line's other controls, as TV's + Add.
function gamesActionsHtml() {
  const review = gamesReviewItems(gamesData).concat(typeof gamesResearchReviewItems === 'function' ? gamesResearchReviewItems(gamesData) : []);
  return `<span class="games-actions"><button class="btn add-open-btn" data-gaction="add" onclick="openGamesAdd(this)">+ Add game</button>
    <button class="btn" data-gaction="refresh" onclick="refreshGames()"${gamesRefreshing ? ' disabled' : ''}>${gamesRefreshing ? 'Refreshing…' : 'Refresh'}</button>
    ${review.length ? `<button class="btn" data-gaction="review" onclick="openGamesReview(this)">Review (${review.length})</button>` : ''}</span>`;
}
// TV's toolbar (render.js filterBarHtml, styles.css .list-toolbar): one line, then the Filters panel, the chips and the sort line; the count at the end.
function gamesToolbarHtml({ line = '', panel = '', chips = '', sort = false, count = '' }) {
  return `<div class="list-toolbar games-toolbar"><div class="filters"><div class="filter-line">${line}${gamesActionsHtml()}</div>${panel}${chips}${sort ? '<div id="sortLine" class="sort-line-box"></div>' : ''}</div>
    ${count ? `<div class="stats-row"><p class="count-line" id="gamesCount">${esc(count)}</p></div>` : ''}</div>`;
}

// The Library's Status filter: the default (owner, 2026-11-12) lists what is still to play (Want to play, Playing, Paused);
// the wider groups and each single status stay choosable. Visibility only: statuses, queues and franchises are untouched.
const GAMES_STATUS_DEFAULT = 'unfinished';
const GAMES_STATUS_GROUP_LABELS = { unfinished: 'All except Finished and Skipped', notskipped: 'All except Skipped', all: 'All' };
function gameStatusMatches(status, filter) {
  if (filter === 'all') return true;
  if (filter === 'notskipped') return status !== 'skipped';
  if (filter === 'unfinished') return status !== 'skipped' && status !== 'finished';
  return status === filter;
}
// Library: Search, Filters (genre, status), Sort and the count; then one row per visible game (cards on narrow screens).
function gamesLibraryHtml(st) {
  const all = gamesData.entries.map(e => gameEntryView(e, st));
  const shown = all.filter(v => !v.hidden), hidden = all.length - shown.length;
  const genres = [...new Set(shown.flatMap(v => v.genres))].sort(compareTitles);
  const f = gamesFilters;
  const term = normalTitle(f.search);
  const list = shown.filter(v => (!term || normalTitle(v.title).includes(term))
    && (!f.genre || v.genres.includes(f.genre))
    && gameStatusMatches(v.entry.status, f.status));
  const statusOpts = [...Object.entries(GAMES_STATUS_GROUP_LABELS), ...Object.entries(GAME_STATUS_LABELS)];
  const isDefault = f.status === GAMES_STATUS_DEFAULT;
  const applied = [f.genre ? ['genre', 'Genre', f.genre] : null, !isDefault ? ['status', 'Status', (statusOpts.find(o => o[0] === f.status) || [])[1] || f.status] : null].filter(Boolean);
  const open = gamesFiltersOpen;
  const line = `<label class="visually-hidden" for="gSearch">Search your games</label>
      <input id="gSearch" class="search-input" type="search" placeholder="Search your games" value="${esc(f.search)}" oninput="setGamesFilter('search', this.value)">
      <button type="button" class="btn filter-more-btn" id="gFiltersBtn" aria-expanded="${open}" aria-controls="gFilters" onclick="toggleGamesFilters()">Filters${applied.length ? `<span class="filter-count" aria-hidden="true">${applied.length}</span><span class="visually-hidden">, ${applied.length} active</span>` : ''} <span aria-hidden="true">${open ? '▴' : '▾'}</span></button>${typeof sortButtonHtml === 'function' ? sortButtonHtml() : ''}`;
  const field = (label, id, control) => `<div class="filter-field"><label class="filter-field-label" for="${id}">${esc(label)}</label>${control}</div>`;
  const panel = `<div class="filter-more" id="gFilters" role="group" aria-label="Filters" onkeydown="gamesFiltersKeydown(event)"${open ? '' : ' hidden'}>
      <div class="filter-group" role="group" aria-label="Categories"><span class="filter-group-title" aria-hidden="true">Categories</span>${field('Genre', 'gGenre', `<select id="gGenre"${f.genre ? ' class="filter-set"' : ''} onchange="setGamesFilter('genre', this.value)"><option value="">Any genre</option>${genres.map(g => `<option value="${esc(g)}"${f.genre === g ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>`)}</div>
      <div class="filter-group" role="group" aria-label="Your marks"><span class="filter-group-title" aria-hidden="true">Your marks</span>${field('Status', 'gStatus', `<select id="gStatus"${!isDefault ? ' class="filter-set"' : ''} onchange="setGamesFilter('status', this.value)">${statusOpts.map(([v, l]) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}</div>
    </div>`;
  const chip = ([k, l, t]) => `<button type="button" id="gchip-${k}" class="filter-chip" aria-label="${esc(`Remove filter: ${l}, ${t}`)}" title="${esc(`Remove filter: ${l}, ${t}`)}" onclick="removeGamesFilter('${k}')"><span class="chip-k">${esc(l)}:</span> <span class="chip-v">${esc(t)}</span><span class="chip-x" aria-hidden="true">✕</span></button>`;
  const chips = `<div class="filter-chips" id="gFilterChips">${isDefault ? `<span class="filter-default">Status: ${esc(GAMES_STATUS_GROUP_LABELS[GAMES_STATUS_DEFAULT])}</span>` : ''}${applied.length
    ? `<div class="chip-group" role="group" aria-label="Active filters"><span class="chips-label" aria-hidden="true">Active:</span>${applied.map(chip).join('')}</div>` : ''}${applied.length || f.search
    ? '<button type="button" class="btn-link filter-clear" id="gFilterClear" onclick="clearGamesFilters()">Clear filters</button>' : ''}</div>`;
  const count = gamesData.entries.length ? (list.length !== shown.length ? `${list.length} of ${countUnit(shown.length, 'game', 'games')}` : countUnit(list.length, 'game', 'games')) : '';
  const toolbar = gamesToolbarHtml({ line, panel, chips, sort: true, count });
  const hiddenNote = hidden ? `<p class="games-note">${countUnit(hidden, 'saved game isn’t', 'saved games aren’t')} on your platforms, so ${hidden === 1 ? 'it is' : 'they are'} hidden here and in your queues (${hidden === 1 ? 'its' : 'their'} status, priority, collections and queue places are kept). ${hidden === 1 ? 'It comes' : 'They come'} back when a platform you choose has ${hidden === 1 ? 'it' : 'them'}.</p>` : '';
  if (!gamesData.entries.length) return toolbar + `<div class="games-empty" data-games-empty="1" tabindex="-1"><p>No games yet. Use <strong>+ Add game</strong> to search IGDB and save one.</p></div>`;
  return toolbar + hiddenNote + (list.length ? gamesTableHtml(gamesOrderedParts(list, v => gameRowParts(v)), 'Your games', 'Status')
    : `<div class="games-empty" data-games-empty="1" tabindex="-1"><p>No games match these filters.</p></div>`);
}
// The visible games in the view's order: an explicit sort (view-sort.js) across the whole list, its ties in Franchise / release
// order; else Franchise / release order itself, with a small heading over each franchise that has two or more visible games
// and a divider where such a franchise ends and games without a heading follow.
// Counted after filters and platforms: a franchise with one visible game is placed by that game's shown title, as a standalone
// game (owner, 2026-11-11), so filtering a group down to one, or a second game joining it, can move it (focus follows the game).
function gamesOrderedParts(views, partsOf) {
  const visible = new Map();
  views.forEach(v => { if (v.group.grouped) visible.set(v.group.key, (visible.get(v.group.key) || 0) + 1); });
  const placed = new Map(views.map(v => [v, v.group.grouped && visible.get(v.group.key) < 2
    ? { ...v.group, key: `t:${v.entry.id}`, name: v.title, grouped: false } : v.group]));
  const usual = (a, b) => gameDefaultCompare(placed.get(a.v), placed.get(b.v));
  const sorted = typeof sortForView === 'function' ? sortForView(views.map(v => ({ kind: 'game', v })), usual).map(x => x.v)
    : views.slice().sort((a, b) => gameDefaultCompare(placed.get(a), placed.get(b)));
  const grouped = !(typeof viewSortActive === 'function' && viewSortActive());
  const out = [];
  sorted.forEach((v, i) => {
    const g = placed.get(v), prev = sorted[i - 1] && placed.get(sorted[i - 1]);
    // A headed franchise followed by a game without a heading: a gap and a divider close the franchise (a heading already
    // marks the other boundaries, so they get no second gap). Decorative: hidden from assistive technology.
    if (grouped && !g.grouped && prev && prev.grouped) {
      out.push({ row: '<tr class="game-group-end" aria-hidden="true"><td colspan="4"></td></tr>',
        card: '<div class="game-group-end" aria-hidden="true"></div>' });
    }
    if (grouped && g.grouped && !(prev && prev.key === g.key)) {
      out.push({ row: `<tr class="game-group-head" data-group="${esc(g.key)}"><td colspan="4"><span class="game-group-name" role="heading" aria-level="3">${esc(g.name)}</span></td></tr>`,
        card: `<div class="game-group-head" data-group="${esc(g.key)}"><span class="game-group-name" role="heading" aria-level="3">${esc(g.name)}</span></div>` });
    }
    out.push(partsOf(v));
  });
  return out;
}
// The desktop table and the narrow-screen cards (styles.css shows one of them, at TV's breakpoint).
function gamesTableHtml(parts, label, last) {
  return `<table class="games-table" aria-label="${esc(label)}"><thead><tr><th>Game</th><th class="col-cats">Genres</th><th class="col-plat">Platform · Release</th><th>${esc(last)}</th></tr></thead>
    <tbody>${parts.map(p => p.row).join('')}</tbody></table>
    <div class="card-list games-cards" aria-label="${esc(label)}">${parts.map(p => p.card).join('')}</div>`;
}
// A game's status, as quiet as TV's (the status-select colours: Want to play and Skipped plain).
const GAME_STATUS_LOOK = { want: 'confirmed', playing: 'watching', paused: 'maybe', finished: 'complete', skipped: 'skipped' };
function gameStatusSelectHtml(e, where = 'library', hook = 'status') {
  const idArg = jsArg(e.id);
  return `<select class="status-select game-status s-${GAME_STATUS_LOOK[e.status] || 'confirmed'}" data-gaction="${hook}" aria-label="${esc(`Status of ${e.title}`)}" onchange="setGameStatus('${idArg}', this.value, '${where}')">${Object.entries(GAME_STATUS_LABELS)
    .map(([v, l]) => `<option value="${v}"${e.status === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
const jsArg = s => esc(String(s)).replace(/'/g, "\\'");
// Details: the two scores in words, with their source and counts.
function gameScoresText(rec) {
  if (!rec) return '';
  const parts = [];
  if (rec.critic) parts.push(`Critics ${rec.critic.score} · IGDB (${rec.critic.count})`);
  if (rec.player) parts.push(`Players ${rec.player.score} · IGDB (${rec.player.count})`);
  return parts.join(' · ');
}
// A row's compact score beside the title, as TV's TMDB score: "C 83" (critics) or "P 81" (players), coloured by the score;
// its source, scale and count are behind a tap or keyboard focus and in its accessible name (show-ratings.js toggleShowRatingNote).
function gameRatingParts(s, kind) {
  if (!s || !Number.isFinite(s.score)) return null;
  const critic = kind === 'critic', n = Number(s.count) || 0;
  const note = `${critic ? 'Critic' : 'Player'} score: ${s.score} out of 100 · ${n.toLocaleString('en-US')} ${critic ? (n === 1 ? 'critic review' : 'critic reviews') : (n === 1 ? 'player rating' : 'player ratings')} on IGDB.`;
  const band = s.score >= 80 ? 'high' : s.score >= 70 ? 'mid' : 'low';
  return { button: `<button type="button" class="tmdb-rating r-${band} rk-${kind}" data-gaction="rating-${kind}" aria-label="${esc(note)}" onclick="toggleShowRatingNote(this, event)" onblur="this.removeAttribute('data-open')"><span class="rating-k" aria-hidden="true">${critic ? 'C' : 'P'}</span>\u00a0${s.score}</button>`,
    note: `<span class="tmdb-rating-note note-${kind}" aria-hidden="true">${esc(note)}</span>` };
}
// Both scores, then both notes (so an open note goes below the pair, not between them).
function gameRatingsHtml(rec) {
  const parts = rec ? [gameRatingParts(rec.critic, 'critic'), gameRatingParts(rec.player, 'player')].filter(Boolean) : [];
  return parts.length ? `<span class="game-ratings">${parts.map(p => p.button).join(' ')}${parts.map(p => p.note).join('')}</span>` : '';
}
// The title as TV draws it (★ before, Low after, the scores between), opening Details.
function gameTitleHtml(v, opts = {}) {
  const e = v.entry, ratings = opts.ratings === false ? '' : gameRatingsHtml(v.rec);
  return `<span class="show-title-main">${priorityMarkHtml(e.priority)}<button type="button" class="show-title game-title-btn" data-gaction="open" onclick="event.stopPropagation(); openGameDetails(${e.igdb_id}, this)">${esc(v.title)}</button>${ratings ? ` ${ratings}` : ''}${priorityMarkHtml(e.priority, true)}</span>`;
}
// One release line: the platform ("PS5", or "PS4 · Playable on PS5") and its date or TBA. The repeated "per IGDB" is screen-reader
// text and a tooltip (Details lists every release with its source); a hold or Store / publisher evidence stays visible.
function gameLineHtml(c) {
  if (!c) return '';
  const from = GAME_PLATFORM_LABEL[c.from] || c.from;
  const region = c.row.r != null && c.row.r !== 2 && c.row.r !== 8 ? ` (${IGDB_REGIONS[c.row.r] || 'another region'})` : '';
  const date = gameDateText(c.row), tba = date === 'Date TBA';
  const plat = c.native ? esc(from) : `${esc(from)} · <span class="game-compat">Playable on PS5</span>`;
  const basis = c.evidence ? '<span class="game-basis"><span class="visually-hidden"> · </span>Store or publisher</span>'
    : c.held ? '<span class="game-basis game-held"><span class="visually-hidden"> · </span>not out yet (your hold)</span>'
    : c.row.prec === 'day' ? '<span class="visually-hidden"> · per IGDB</span>' : '';
  const upcoming = !c.isReleased && !tba && !c.held;
  return `<span class="game-line" title="${esc(gameLineText(c))}"><span class="game-plat">${plat}</span><span class="game-when${tba ? ' game-tba' : upcoming ? ' game-upcoming' : ''}"><span class="visually-hidden"> · </span>${esc(date + region)}</span>${upcoming ? '<span class="upcoming-tag">Upcoming</span>' : ''}${basis}</span>`;
}
function gamePlatformHtml(v) {
  if (!v.rec) return '<span class="game-line muted">Details not loaded yet: use Refresh</span>';
  return v.avail.line ? gameLineHtml(v.avail.line) : '<span class="game-line muted">Not announced on your platforms</span>';
}
// Genre pills as TV's category pills: a pill filters (pressed while it is the filter); a desktop row shows what fits, then +N.
const GAME_GENRE_BUDGET = 26;
function gameGenrePillsHtml(v, budget = 0, plain = false) {
  const all = v.genres || [], owner = `game:${v.entry.id}`;
  const open = expandedCategoryOwners.has(owner);
  const fit = budget ? categoryFitCount(all.map(g => ['genres', g]), budget) : all.length;
  const shown = open ? all.length : fit, hidden = all.length - fit;
  const pill = g => { if (plain) return `<span class="badge meta-chip meta-genres g-${genreFamily(g)}">${esc(g)}</span>`; // (a collection: the Library's filter isn't here)
    const pressed = gamesFilters.genre === g;
    return `<button type="button" class="badge meta-chip meta-genres g-${genreFamily(g)} badge-clickable filter-pill" data-gaction="${esc(`genre:${g}`)}" aria-pressed="${pressed}" title="${esc(pressed ? `Remove this filter (${g})` : `Filter by “${g}”`)}" onclick="event.stopPropagation(); toggleGamesGenre('${jsArg(g)}')">${esc(g)}</button>`; };
  const more = hidden ? `<button type="button" class="meta-more" data-gaction="cats-more" aria-expanded="${open}" aria-label="${open ? 'Show fewer genres' : `Show ${hidden} more genre${hidden === 1 ? '' : 's'}`}" onclick="event.stopPropagation(); toggleGameGenres('${jsArg(owner)}')">${open ? 'Fewer' : `+${hidden}`}</button>` : '';
  return all.slice(0, shown).map(pill).join('') + more;
}
function toggleGameGenres(owner) { if (expandedCategoryOwners.has(owner)) expandedCategoryOwners.delete(owner); else expandedCategoryOwners.add(owner); renderGamesView(); }
function toggleGamesGenre(g) { setGamesFilter('genre', gamesFilters.genre === g ? '' : g); }
// A game's ⋯ (TV's menu: Priority first, then Organize).
function gameMenuHtml(v) {
  const e = v.entry, id = esc(e.id), idArg = jsArg(e.id), line = v.avail.line;
  const hold = line && line.rec && line.row.prec === 'day' && !line.evidence
    ? (line.held ? `<button class="popover-action" data-gaction="out" onclick="closeRowMenu(this); clearNotOutYet(${line.rec.id}, '${line.platform}')">It’s out (end my hold)</button>`
      : line.isReleased ? `<button class="popover-action" data-gaction="notout" onclick="closeRowMenu(this); setNotOutYet(${line.rec.id}, '${line.platform}', '${line.key}', '${line.row.prec}')">Not out yet on ${esc(GAME_PLATFORM_LABEL[line.platform])}</button>` : '') : '';
  const follows = v.rec ? v.rec.collections.filter(c => !gamesData.follows.some(f => f.igdb_collection_id === c.id)) : [];
  return `<span class="more-cell" onclick="event.stopPropagation()"><button type="button" class="more-btn" data-gaction="more" aria-expanded="false" onclick="toggleMorePopover('g-${id}', this)" title="Priority and more" aria-label="${esc(`More for ${v.title}`)}">⋯</button>
      <div class="more-popover" id="more-popover-g-${id}" style="display:none">
        <div class="popover-section-label">Priority</div>
        <span class="state-action"><select class="priority-select p-${e.priority}" data-gaction="priority" aria-label="${esc(`Priority of ${v.title}`)}" title="Priority" onchange="closeRowMenu(this); setGamePriority('${idArg}', this.value)">${PRIORITIES.map(p => `<option value="${p}"${p === e.priority ? ' selected' : ''}>${PRIORITY_LABELS[p]}</option>`).join('')}</select></span>
        <div class="popover-section-label" style="margin-top:8px">Organize</div>
        <button class="popover-action" data-gaction="queue" onclick="openAddToQueueFromMenu(this, 'game', '${idArg}')">Add to queue…</button>
        <button class="popover-action" data-gaction="collect" onclick="closeRowMenu(this); openGameCollectionAdd('${idArg}', this)">Add to collection…</button>
        ${follows.map(c => `<button class="popover-action" data-gaction="follow" onclick="closeRowMenu(this); followFranchise(${c.id}, '${jsArg(c.name)}')">Follow ${esc(c.name)}</button>`).join('')}
        ${hold}
        <button class="popover-action" data-gaction="details" onclick="closeRowMenu(this); openGameDetails(${e.igdb_id}, this)">Details…</button>
        <button class="popover-action" data-gaction="delete" onclick="closeRowMenu(this); confirmDeleteGame('${idArg}')">Delete from library…</button>
      </div></span>`;
}
// A game's desktop row and its card. opts.member (a collection's row): its status as a label and Remove, no ⋯.
function gameRowParts(v, opts = {}) {
  const e = v.entry, id = esc(e.id), dim = e.status === 'skipped' ? ' row-skipped' : '';
  const member = opts.member;
  const menu = member ? '' : gameMenuHtml(v);
  const title = gameTitleHtml(v);
  const status = member
    ? `<span class="status-pill s-${GAME_STATUS_LOOK[e.status] || 'confirmed'} game-state">${esc(GAME_STATUS_LABELS[e.status])}</span> <button class="btn" data-gaction="cremove" onclick="removeFromGameCollection('${jsArg(member.id)}')">Remove</button>`
    : `<span class="state-action">${gameStatusSelectHtml(e)}</span>`;
  const row = `<tr class="game-row${dim}" data-game="${id}">
      <td><div class="show-title-row"><div class="show-title-left">${title}</div>${menu}</div></td>
      <td>${gameGenrePillsHtml(v, GAME_GENRE_BUDGET, !!member)}</td>
      <td class="date-cell game-plat-cell">${gamePlatformHtml(v)}</td>
      <td class="game-status-cell">${status}</td>
    </tr>`;
  const card = `<div class="item-card game-card${dim}" data-game="${id}">
      <div class="card-top"><div class="card-title-block"><span class="card-title">${title}</span></div>${menu}</div>
      <div class="card-meta"><span class="card-season">${gamePlatformHtml(v)}</span>${v.genres.length ? `<span class="card-labels">${gameGenrePillsHtml(v, 0, !!member)}</span>` : ''}
        <span class="card-actions card-complete">${status}</span></div>
    </div>`;
  return { row, card };
}
function setGamesFilter(key, value) {
  gamesFilters[key] = value;
  renderGamesView();
  const id = { search: 'gSearch', genre: 'gGenre', status: 'gStatus' }[key];
  if (id) { const el = document.getElementById(id); if (el && document.activeElement !== el && key === 'search') { el.focus(); el.setSelectionRange && el.setSelectionRange(el.value.length, el.value.length); } }
}
function removeGamesFilter(key) {
  gamesFilters[key] = key === 'status' ? GAMES_STATUS_DEFAULT : '';
  renderGamesView();
  // Focus: the other chip, else Search (as TV's chips).
  const other = key === 'genre' ? 'gchip-status' : 'gchip-genre';
  focusFilterTarget(document.getElementById(other) ? other : 'gSearch');
}
function clearGamesFilters() {
  gamesFilters = { search: '', genre: '', status: GAMES_STATUS_DEFAULT };
  renderGamesView();
  focusFilterTarget('gSearch');
}
function toggleGamesFilters(open = !gamesFiltersOpen) {
  gamesFiltersOpen = !!open;
  renderGamesView();
}
function gamesFiltersKeydown(e) {
  if (!e || e.key !== 'Escape' || !gamesFiltersOpen) return;
  if (typeof e.preventDefault === 'function') e.preventDefault();
  gamesFiltersOpen = false;
  renderGamesView();
  focusFilterTarget('gFiltersBtn');
}

// Franchises: one row per followed franchise, as TV's shows: expand, then aligned Up next and Coming; expanded, its spots in
// release order with their versions beneath (TV's seasons under a show).
function gameNextHtml(label, name, c, extra = '') {
  return `<span class="visually-hidden">${esc(label)}: </span><span class="fr-name">${esc(name)}</span>${c ? `<span class="visually-hidden"> · </span>${gameLineHtml(c)}` : ''}${extra}`;
}
function franchiseParts(f, st) {
  const sum = franchiseSummary(f, st), open = gamesExpanded.has(f.id), id = esc(f.id), idArg = jsArg(f.id);
  const known = sum.spots.length > 0;
  const rel = sum.upNext && sum.upNext.version.avail.released[0];
  const upNoy = rel && !rel.evidence
    ? ` <button class="btn btn-link" data-gaction="notout" onclick="event.stopPropagation(); setNotOutYet(${rel.rec.id}, '${rel.platform}', '${rel.key}', '${rel.row.prec}')">Not out yet</button>` : '';
  const up = !known ? '<span class="muted">Not read from IGDB yet: use Refresh</span>'
    : sum.upNext ? gameNextHtml('Up next', sum.upNext.version.rec.name, rel, upNoy) : '<span class="visually-hidden">Up next: </span><span class="status-pill s-caughtup">Caught up</span>';
  const coming = sum.coming.length ? gameNextHtml('Coming', sum.coming[0].version.rec.name, sum.coming[0].c, sum.coming.length > 1 ? ` <span class="muted">(+${sum.coming.length - 1} more)</span>` : '') : '<span class="muted">—</span>';
  const expand = `<button type="button" class="expand-btn" data-gaction="expand" aria-expanded="${open}" aria-label="${esc(`${open ? 'Hide' : 'Show'} the games of ${f.name}`)}" onclick="event.stopPropagation(); toggleFranchise('${idArg}')"><span class="expand-chevron">${open ? '▾' : '▸'}</span></button>`;
  const name = `<span class="show-title-main"><span class="show-title">${esc(f.name)}</span></span>`;
  // Visibility only (as the Library's hidden games): a version with no release on a chosen platform (native, or a PS4 game
  // playable on PS5; upcoming and TBA releases count) isn't listed, and a spot left with none isn't either. Progress, Up next,
  // Caught up and Coming are worked out from every version, so a hidden one keeps counting (a Finished PS3 original still
  // completes its spot). A saved game without IGDB details (as after a restore) still shows in the Library, unchanged.
  const shownSpots = sum.spots.map(s => ({ ...s, versions: s.versions.filter(v => !v.avail.hiddenByPlatforms) })).filter(s => s.versions.length);
  const hiddenVersions = sum.spots.reduce((n, s) => n + s.versions.filter(v => v.avail.hiddenByPlatforms).length, 0);
  const spots = open ? shownSpots : [];
  // A saved version: the Library's status control (the same guarded change); else Save.
  const versionStatus = v => (v.entry ? `<span class="state-action">${gameStatusSelectHtml(v.entry, 'franchise', `status-v${v.rec.id}`)}</span>`
    : `<button class="btn btn-link" data-gaction="save-${v.rec.id}" onclick="saveGameRecord(${v.rec.id})">Save</button>`);
  const versionName = v => `${esc(v.rec.name)}${v.rec.type !== 'main' ? ` <span class="muted">(${esc(v.rec.type === 'standalone' ? 'standalone' : v.rec.type)})</span>` : ''}`;
  const versionLine = v => (v.avail.line ? gameLineHtml(v.avail.line) : '<span class="game-line muted">Not on your platforms</span>');
  const spotLabel = s => (s.skipped ? 'All versions skipped' : s.finished ? 'Finished' : s.spinoff && !s.included ? 'Spin-off (not counted)' : s.spinoff ? 'Spin-off (counted)' : '');
  // Skip all versions (the skip_spot decision): this game, with its remasters and remakes, leaves Up next and Caught up until undone.
  // (A single version's Skipped status is separate: that version alone is passed over.)
  // Its name for screen readers and the tooltip: the title with the original's release year, so games sharing a title differ
  // ("God of War (2005)", "God of War (2018)"); "release year unknown" when IGDB has none. The visible label stays short.
  const spotName = s => `${s.title} (${s.first ? s.first.slice(0, 4) : 'release year unknown'})`;
  const spotActions = s => `<button class="btn btn-link" data-gaction="skipspot-${s.id}" aria-label="${esc(`${s.skipped ? 'Unskip' : 'Skip'} all versions of ${spotName(s)}`)}" title="${esc(s.skipped ? `Count ${spotName(s)} in Up next and Caught up again` : `Leave ${spotName(s)} and all its versions out of Up next and Caught up until you unskip it`)}" onclick="toggleSkipSpot(${s.id}, ${s.skipped})">${s.skipped ? 'Unskip all versions' : 'Skip all versions'}</button>${s.spinoff
    ? ` <button class="btn btn-link" data-gaction="include-${s.id}" onclick="toggleIncludeSpinoff(${s.id}, ${s.included})">${s.included ? 'Don’t count it' : 'Count it toward Caught up'}</button>` : ''}`;
  const spotHead = s => `<span class="season-lbl spot-title">${esc(s.title)}</span> <span class="muted">${esc(s.first ? s.first.slice(0, 4) : 'TBA')}</span>${spotLabel(s) ? ` <span class="state-tag">${esc(spotLabel(s))}</span>` : ''}`;
  const hiddenNote = hiddenVersions ? ` ${countUnit(hiddenVersions, 'version isn’t', 'versions aren’t')} on your platforms, so ${hiddenVersions === 1 ? 'it is' : 'they are'} hidden here (${hiddenVersions === 1 ? 'its' : 'their'} progress still counts).` : '';
  const note = `<p class="games-note">Main-series games count toward Caught up; spin-offs only when you count them. A game’s original, remasters and remakes are versions of that one game: finishing any version counts the game as done. Skip all versions leaves the game out of Up next and Caught up until you unskip it; a single version set to Skipped is passed over on its own.${hiddenNote}</p>`;
  const unfollow = `<button class="btn" data-gaction="unfollow" onclick="unfollowFranchise('${idArg}')">Stop following ${esc(f.name)}</button>`;
  const of = `data-follow-of="${id}"`;
  let row = `<tr class="show-group-row franchise-row" data-follow="${id}" onclick="toggleFranchise('${idArg}')">
      <td><div class="show-title-row">${expand}<div class="show-title-left">${name}</div></div></td>
      <td class="date-cell fr-next">${up}</td><td class="date-cell fr-coming">${coming}</td><td></td></tr>`;
  if (open) {
    row += spots.map(s => `<tr class="sub-row spot-row${s.done ? ' spot-done' : ''}${s.included ? '' : ' spot-excluded'}" ${of} data-spot="${s.id}">
        <td style="padding-left:28px">${spotHead(s)}</td><td colspan="2"></td><td class="spot-actions">${spotActions(s)}</td></tr>`
      + s.versions.map(v => `<tr class="sub-row spot-version" ${of} data-spot-of="${s.id}"><td class="spot-version-name">${versionName(v)}</td>
        <td colspan="2" class="date-cell">${versionLine(v)}</td><td>${versionStatus(v)}</td></tr>`).join('')).join('')
      + (known ? '' : `<tr class="sub-row" ${of}><td style="padding-left:28px" colspan="4" class="muted">Nothing read from IGDB yet: use Refresh.</td></tr>`)
      + `<tr class="sub-row show-actions-row" ${of}><td style="padding-left:28px" colspan="4">${note}${unfollow}</td></tr>`;
  }
  const card = `<div class="item-card show-group-card franchise-card" data-follow="${id}">
      <div class="card-top" onclick="toggleFranchise('${idArg}')" style="cursor:pointer">${expand}<div class="card-title-block"><span class="card-title">${name}</span></div></div>
      <div class="card-meta fr-card-meta"><span class="card-season fr-next"><span class="fr-label" aria-hidden="true">Up next</span>${up}</span>${sum.coming.length ? `<span class="card-date fr-coming"><span class="fr-label" aria-hidden="true">Coming</span>${coming}</span>` : ''}</div>
      ${open ? `<div class="card-subseasons">${spots.map(s => `<div class="card-subseason-row spot-card" data-spot="${s.id}"><div>${spotHead(s)}</div>
          ${s.versions.map(v => `<div class="spot-version-card"><span class="spot-version-name">${versionName(v)}</span><span class="card-date">${versionLine(v)}</span><span class="card-actions">${versionStatus(v)}</span></div>`).join('')}
          <div class="card-actions spot-actions">${spotActions(s)}</div></div>`).join('')}${known ? '' : '<p class="muted">Nothing read from IGDB yet: use Refresh.</p>'}
        <div class="card-subseason-row show-actions">${note}${unfollow}</div></div>` : ''}
    </div>`;
  return { row, card };
}
function gamesFranchisesHtml(st) {
  const toolbar = gamesToolbarHtml({ count: gamesData.follows.length ? countUnit(gamesData.follows.length, 'franchise followed', 'franchises followed') : '' });
  if (!gamesData.follows.length) return toolbar + `<div class="games-empty" data-games-empty="1" tabindex="-1"><p>You follow no franchises. Follow one from a game’s ⋯ menu or from <strong>+ Add game</strong>: its Up next and Coming appear here. Saving a game doesn’t follow its franchise.</p></div>`;
  const parts = gamesData.follows.slice().sort((a, b) => compareTitles(a.name, b.name)).map(f => franchiseParts(f, st));
  return toolbar + `<table class="games-table franchise-table" aria-label="Followed franchises"><thead><tr><th>Franchise</th><th class="col-next">Up next</th><th class="col-next">Coming</th><th></th></tr></thead>
    <tbody>${parts.map(p => p.row).join('')}</tbody></table>
    <div class="card-list games-cards" aria-label="Followed franchises">${parts.map(p => p.card).join('')}</div>`;
}
function toggleFranchise(id) { if (gamesExpanded.has(id)) gamesExpanded.delete(id); else gamesExpanded.add(id); renderGamesView(); }

// Collections: the member's game collections, one open at a time; its games as the Library draws them.
function gamesCollectionsHtml(st) {
  const cs = gamesData.collections;
  if (!cs.some(c => c.id === gamesCollectionId)) {
    let last = null; try { last = userStorage.getItem(GAMES_LAST_COLLECTION_KEY); } catch (e) { last = null; }
    gamesCollectionId = (cs.find(c => c.id === last) || cs[0] || {}).id || null;
  }
  const c = cs.find(x => x.id === gamesCollectionId) || null;
  const select = cs.length ? `<label class="visually-hidden" for="gCollection">Collection</label><select id="gCollection" class="games-collection-select" data-gaction="cselect" onchange="selectGameCollection(this.value)">${cs.map(x => `<option value="${esc(x.id)}"${c && x.id === c.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : '';
  const edit = gamesCollectionEdit;
  const manage = c ? (edit && edit.id === c.id && edit.mode === 'rename'
    ? `<label class="visually-hidden" for="gCollectionRename">New name</label><input id="gCollectionRename" class="search-input" maxlength="100" value="${esc(edit.value)}" oninput="gamesCollectionEdit.value = this.value"> <button class="btn btn-accent" data-gaction="crename-save" onclick="renameGameCollection()">Save</button> <button class="btn" data-gaction="crename-cancel" onclick="gamesCollectionEdit = null; renderGamesView()">Cancel</button>`
    : edit && edit.id === c.id && edit.mode === 'delete'
      ? `<span>Delete “${esc(c.name)}”? Its games stay in your library.</span> <button class="btn-danger" data-gaction="cdelete-confirm" onclick="deleteGameCollection()">Delete collection</button> <button class="btn" data-gaction="cdelete-cancel" onclick="gamesCollectionEdit = null; renderGamesView()">Cancel</button>`
      : `<button class="btn" data-gaction="crename" onclick="gamesCollectionEdit = { id: '${jsArg(c.id)}', mode: 'rename', value: '${jsArg(c.name)}' }; renderGamesView(); focusFilterTarget('gCollectionRename')">Rename</button> <button class="btn" data-gaction="cdelete" onclick="gamesCollectionEdit = { id: '${jsArg(c.id)}', mode: 'delete' }; renderGamesView()">Delete…</button>`) : '';
  const create = `<div class="queue-new games-collection-new"><label for="gCollectionNew">New collection</label> <input id="gCollectionNew" class="search-input" maxlength="100" placeholder="Name" value="${esc(gamesCollectionNew)}" oninput="gamesCollectionNew = this.value" onkeydown="if (event.key === 'Enter') { event.preventDefault(); createGameCollection(); }"> <button class="btn" data-gaction="ccreate" onclick="createGameCollection()">Create</button></div>`;
  let body, count = '';
  if (!c) body = '<div class="games-empty" data-games-empty="1" tabindex="-1"><p>No game collections yet. Make one here, then add games with <strong>Add to collection…</strong> in a game’s ⋯ menu.</p></div>';
  else {
    const ms = gamesData.members.filter(m => m.collection_id === c.id);
    const views = ms.map(m => ({ m, e: gamesData.entries.find(e => e.id === m.entry_id) })).filter(x => x.e).map(x => ({ ...gameEntryView(x.e, st), member: x.m }));
    const shown = views.filter(v => !v.hidden);
    count = countUnit(shown.length, 'game', 'games');
    body = shown.length ? gamesTableHtml(gamesOrderedParts(shown, v => gameRowParts(v, { member: v.member })), c.name, 'Status')
      : `<div class="games-empty" data-games-empty="1" tabindex="-1"><p>“${esc(c.name)}” has no games${views.length ? ' on your platforms' : ''} yet.</p></div>`;
    if (views.length > shown.length) body += `<p class="games-note">${countUnit(views.length - shown.length, 'game in this collection isn’t', 'games in this collection aren’t')} on your platforms and ${views.length - shown.length === 1 ? 'is' : 'are'} hidden; ${views.length - shown.length === 1 ? 'it stays' : 'they stay'} in the collection.</p>`;
  }
  // Sort (its own per collection, view-sort.js), when a collection is open.
  const sortBtn = c && typeof sortButtonHtml === 'function' ? sortButtonHtml() : '';
  return gamesToolbarHtml({ line: `${select}${sortBtn}${manage ? ` <span class="games-collection-manage">${manage}</span>` : ''}`, count, sort: !!c }) + create + body;
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
  // (an expanded franchise's rows in the table are siblings of its row, marked data-follow-of; on cards they are inside it)
  const rowEl = a.closest('[data-game], [data-follow], [data-follow-of]');
  const hookEl = a.closest('[data-gaction]');
  const attr = rowEl ? (rowEl.getAttribute('data-game') != null ? 'data-game' : 'data-follow') : null;
  const screen = document.getElementById('gamesScreen');
  const ids = attr ? [...new Set([...screen.querySelectorAll(`[${attr}]`)].map(x => x.getAttribute(attr)))] : []; // (a game's row and its card)
  const row = rowEl ? rowEl.getAttribute(attr) ?? rowEl.getAttribute('data-follow-of') : null, at = ids.indexOf(row);
  // (a text box being typed in, such as Search your games, keeps its caret and selection)
  const sel = a.id && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd, a.selectionDirection || 'none'] : null;
  return { attr, row, hook: hookEl ? hookEl.getAttribute('data-gaction') : null, id: a.id || null, sel,
    next: at >= 0 ? ids.slice(at + 1) : [], prev: at >= 0 ? ids.slice(0, at).reverse() : [] };
}
function applyGamesFocus(rec) {
  if (!rec || !documentHasFocus()) return;
  const screen = document.getElementById('gamesScreen');
  if (!screen || typeof screen.querySelector !== 'function') return;
  const q = JSON.stringify.bind(JSON);
  const usable = el => !!el && !el.disabled && typeof el.focus === 'function';
  // The desktop row or the narrow-screen card, whichever is shown (styles.css): the first copy that has a box.
  const shownOf = sel => { const all = [...screen.querySelectorAll(sel)]; return all.find(x => typeof x.getClientRects !== 'function' || x.getClientRects().length > 0) || all[0] || null; };
  let el = null;
  if (rec.row) {
    const inRow = (r, sel) => shownOf(`[${rec.attr}=${q(String(r))}] ${sel}, [${rec.attr}-of=${q(String(r))}] ${sel}`);
    if (rec.hook) el = inRow(rec.row, `[data-gaction=${q(rec.hook)}]`);
    // A franchise version just saved: its new status control (Save is gone).
    if (!usable(el) && rec.hook && /^save-\d+$/.test(rec.hook)) el = inRow(rec.row, `[data-gaction=${q(`status-v${rec.hook.slice(5)}`)}]`);
    if (!usable(el)) el = inRow(rec.row, '[data-gaction="more"], [data-gaction="expand"]');
    for (const r of rec.next.concat(rec.prev)) { if (usable(el)) break; el = inRow(r, '[data-gaction="more"], [data-gaction="expand"]'); }
  } else if (rec.id) el = document.getElementById(rec.id);
  else if (rec.hook) el = shownOf(`[data-gaction=${q(rec.hook)}]`);
  // Nothing left in the list: the empty note, else Search, else the screen's heading (in that order, not document order).
  if (!usable(el)) el = ['[data-games-empty]', '#gSearch', '#gamesTitle'].map(sel => screen.querySelector(sel)).find(usable) || null;
  if (!usable(el)) return;
  el.focus();
  if (rec.sel && el.id === rec.id && typeof el.setSelectionRange === 'function') el.setSelectionRange(...rec.sel);
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
// IGDB records by id, in batches; Map(id → cache record).
async function igdbRecords(ids) {
  const list = [...new Set(ids)].filter(Number.isInteger);
  const queries = [];
  for (let i = 0; i < list.length; i += 400) { // (400 ids keep a query well under the function's body limit)
    const part = list.slice(i, i + 400).join(',');
    queries.push({ name: `g${i}`, endpoint: 'games', body: `fields ${IGDB_GAME_FIELDS}; where id = (${part}); limit 500;` });
  }
  const out = new Map();
  if (!queries.length) return out;
  const r = await igdbQueries(queries);
  Object.keys(r).forEach(k => (r[k] || []).forEach(g => out.set(g.id, igdbRecord(g))));
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
    <p class="games-note">Versions of this game. An original, a remaster and a remake are separate games you can save and queue on their own; finishing any of them counts this game as done in its franchise. Ports for another system join the version they port.</p>
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
  // Its ports are joined only once their own records have been read (a port not read yet is fetched first).
  const unread = rec.ports.filter(p => !cache.get(p));
  if (unread.length) { try { (await igdbRecords(unread)).forEach((v, k) => cache.set(k, v)); } catch (e) { showError(`${e.message} Nothing was changed.`); return; } }
  const ports = gamePlainPorts(rec, cache, true).filter(p => !taken.has(p));
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
function toggleSkipSpot(spotId, skipped) { return setGameDecision('skip_spot', spotId, '', skipped ? null : {}, skipped ? 'Unskip all versions' : 'Skip all versions'); }
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
    // Memberships of followed series come from this Refresh's franchise reads alone (a game IGDB drops from a series leaves it);
    // other keys (series no longer followed) are kept as cached.
    const followed = new Set(gamesData.follows.map(f => String(f.igdb_collection_id))), memberOf = new Map();
    for (const f of gamesData.follows) (await readFranchise(f.igdb_collection_id, old)).forEach((v, k) => {
      recs.set(k, v);
      if (v.m && v.m[f.igdb_collection_id]) (memberOf.get(k) || memberOf.set(k, {}).get(k))[f.igdb_collection_id] = v.m[f.igdb_collection_id];
    });
    // Every saved record with its related records (ports included), also those the franchises read: a port is joined only once read.
    const savedIds = gamesData.entries.flatMap(e => [e.igdb_id, ...(e.port_ids || [])]);
    (await igdbRecordsWithRelated(savedIds, old)).forEach((v, k) => recs.set(k, v));
    recs.forEach((v, k) => {
      const kept = Object.fromEntries(Object.entries((old.get(k) || {}).m || {}).filter(([c]) => !followed.has(String(c))));
      v.m = { ...kept, ...(memberOf.get(k) || {}) };
    });
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
        const add = gamePlainPorts(cache.get(e.igdb_id), cache, true).filter(p => !taken.has(p));
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
    if (gameRetyped(rec)) {
      const what = rec.versionParent ? 'an edition of another record' : `a ${rec.type}`;
      if (!(keep && keep.value && keep.value.retype === what)) items.push({ kind: 'retype', entry: e, rec, derived: e.spot_igdb_id, what,
        text: `IGDB now lists “${rec.name}” as ${what}. It still counts as the same game in its franchise, with its status and queue places.` });
      continue;
    }
    if (rec.parent && !cache.get(rec.parent)) continue; // (its original not read yet: nothing to compare until Refresh)
    if (gameAmbiguousChain(rec, cache) && !keep) {
      items.push({ kind: 'chain', entry: e, rec, derived, text: `IGDB lists “${rec.name}” as a ${rec.type} of a port (${(cache.get(rec.parent) || {}).name || 'another record'}). It counts as a version of the same game as ${(cache.get(derived) || {}).name || 'its original'}.` });
    } else if (derived !== e.spot_igdb_id && !kept) {
      items.push({ kind: 'spot', entry: e, rec, derived, text: `IGDB now places “${rec.name}” under ${(cache.get(derived) || {}).name || `IGDB ${derived}`}; your progress counts it under ${(cache.get(e.spot_igdb_id) || {}).name || `IGDB ${e.spot_igdb_id}`}.` });
    }
  }
  return items;
}
function openGamesReview(opener) {
  const items = gamesReviewItems(gamesData), research = typeof gamesResearchReviewItems === 'function' ? gamesResearchReviewItems(gamesData) : [];
  gamesReviewOpener = opener || null;
  const evidence = d => (d.value.evidence || []).map(e => `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.source === 'playstation_store' ? 'PlayStation Store' : 'Publisher')}</a>`).join(' · ');
  showGameDialog(`<h2 class="modal-title" id="gameDialogTitle">Review IGDB changes and research</h2>
    <p class="games-note">Your saved games, statuses and queue places don’t change until you choose. “Keep mine” stays decided until IGDB changes again.</p>
    <ul class="games-review">${items.map((it, i) => `<li><p>${esc(it.text)}</p>
      ${it.kind === 'retype' ? `<button class="btn btn-accent" onclick="reviewKeep(${i})">Keep counting it</button>`
        : `${it.kind === 'spot' ? `<button class="btn btn-accent" onclick="reviewUseIgdb(${i})">Use IGDB’s</button> ` : `<button class="btn btn-accent" onclick="reviewKeep(${i})">Keep it a separate version</button> `}
      <button class="btn" onclick="reviewKeep(${i})">${it.kind === 'spot' ? 'Keep mine' : 'Decide later'}</button>`}</li>`).join('')}
    ${research.map((it, i) => `<li data-research-item="${i}"><p>${esc(it.text)} <span class="muted">Evidence (Claude’s assessment): ${evidence(it.decision)}</span></p>
      ${it.action ? `<button class="btn btn-accent" onclick="gamesResearchChoose(${i}, true)">${esc(gamesResearchActionLabel(it.action))}</button> ` : '<span class="muted">Already as research says.</span> '}
      <button class="btn" onclick="gamesResearchChoose(${i}, false)">Dismiss</button></li>`).join('')}
    ${items.length || research.length ? '' : '<li>Nothing to review.</li>'}</ul>
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
  return setGameDecision('keep_link', it.entry.igdb_id, '', { spot_igdb_id: it.derived, port_ids: it.entry.port_ids || [], kind: it.kind, ...(it.what ? { retype: it.what } : {}) }, `“${it.entry.title}” · keep`);
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
      if (typeof setViewSortSpec === 'function') setViewSortSpec({ key: `gamescollections:${c.id}` }, []); // (its sort is forgotten too)
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
    ${rec.store ? `<p><a href="${esc(rec.store)}" target="_blank" rel="noopener noreferrer">PlayStation Store (US)</a></p>` : ''}
    ${holds.length ? `<div class="modal-section"><div class="modal-label">Your decisions</div><ul class="manage-list">${holds.map(d => `<li>${d.kind === 'not_out_yet' ? `Not out yet on ${esc(GAME_PLATFORM_LABEL[d.platform])} (IGDB’s ${esc(d.value.date)})` : `Available on ${esc(GAME_PLATFORM_LABEL[d.platform])}`}${d.basis === 'research' ? ` · research ${esc(d.value.research_date || '')}: ${(d.value.evidence || []).map(e => `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.source === 'playstation_store' ? 'PlayStation Store' : 'publisher')}</a>`).join(', ')}` : ''}</li>`).join('')}</ul></div>` : ''}
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
  // A text box being typed in keeps its focus, caret and selection across the redraw (a search
  // finishing, a save or follow ending), as the app's other search boxes do.
  const was = document.activeElement, keep = was && was.id && box.contains(was) && typeof was.selectionStart === 'number'
    ? { id: was.id, start: was.selectionStart, end: was.selectionEnd, dir: was.selectionDirection } : null;
  box.innerHTML = html;
  overlay.style.display = 'flex';
  if (document.activeElement && !box.contains(document.activeElement) && typeof box.focus === 'function') box.focus();
  const again = keep && document.getElementById(keep.id);
  if (again && box.contains(again) && typeof again.focus === 'function') {
    again.focus();
    if (typeof again.setSelectionRange === 'function') again.setSelectionRange(keep.start, keep.end, keep.dir || 'none');
  }
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

// ── Settings → Games (platforms; they follow the member across devices and are in backups) ──
// game_settings.play_style is a legacy field (game length was removed, 2026-11-10): never shown, kept as saved on every save.
function gamesSettingHtml() {
  const s = gamesSettingsRead && gamesSettingsRead.settings, state = gamesSettingsRead ? gamesSettingsRead.status : 'loading';
  const plats = s ? s.platforms : [];
  const body = state === 'loading' ? '<p class="settings-text">Loading…</p>' : state === 'error' ? `<p class="settings-status warn">Couldn’t be read. <button class="btn" onclick="readGamesSettings(true)">Retry</button></p>`
    : `<fieldset class="settings-fieldset"><legend>My platforms</legend>${GAME_PLATFORMS.map(p => `<label class="settings-check"><input type="checkbox" class="games-platform" value="${p.key}"${plats.includes(p.key) ? ' checked' : ''} onchange="saveGamesSettings()"> ${esc(p.label)}</label>`).join('')}</fieldset>
      <p class="settings-text">With PS5 chosen, PS4 games that play on PS5 show too, labelled “PS4 · Playable on PS5” with their PS4 date (unless Sony lists them as PS4 only). Games on none of your platforms are hidden but keep their status, priority, collections and queue places.</p>`;
  return `<section class="settings-card" aria-labelledby="settingsGamesTitle"><h3 id="settingsGamesTitle" tabindex="-1">Games</h3>${body}
    <p class="settings-text">Saved with your library, so they follow you to every device and come back with a restore.</p>${typeof gamesResearchSettingHtml === 'function' ? gamesResearchSettingHtml() : ''}</section>`;
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
  const el = document.querySelector(`.games-platform[value=${JSON.stringify(value)}]`);
  if (el && typeof el.focus === 'function') el.focus();
}
async function saveGamesSettings() {
  if (!gamesSettingsRead || gamesSettingsRead.status !== 'ready') return;
  const s = gamesSettingsRead.settings;
  const platforms = [...document.querySelectorAll('.games-platform')].filter(x => x.checked).map(x => x.value);
  const style = s ? s.play_style : 'main'; // (the legacy value, sent back unchanged)
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
