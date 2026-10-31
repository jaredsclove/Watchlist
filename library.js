// ─── The library (Stage 4b; without storage since Stage 5) ──────────────────────
// Everything is reached from TV (Currently Watching, All TV, Coming Soon), Movies
// (All Movies) and Browse. No record has a storage: what decides how a record may
// be edited is the built-in catalog that governs it (catalog governance, read from
// library_catalog_shows / library_catalog_films), and what a film's theme means
// (library_film_theme_kinds). This file holds those rules; they give exactly the
// answers the old storage rules gave. Governance is not a provenance record.
//
// Adding: the "+ Add" panel searches TMDB or takes an entry by hand. Before
// anything is sent it reads the whole library (complete reads, or nothing is
// sent) and decides where the addition goes:
//   * a show already on the list gets its seasons through library_add_seasons,
//     which refuses (and writes nothing) if that show is gone or changed, instead
//     of creating another one (the intended parent, not exactly-once delivery);
//   * a genuinely new show is created with all its seasons, or not at all, by
//     library_create_show; a new film by library_add_films / library_create_film;
//   * a matching title is shown and the user chooses; "add as new" sends the ids of
//     the same-named unmatched records the page showed (distinct_from), so a repeat
//     or a race is refused, never a second copy. Nothing is merged or guessed.
// Results are never merged into what the page shows: the open view is read again,
// inside the change's write lane (write-lane.js), only while it is still the view.
// Collections are a separate, optional step after a creation, reported separately.

// The movie tools' cache of films (tabData; not a storage): see libraryPrepareMovieTools.
const TOOL_FILMS = 'films';

// ─── Catalog governance (read with every view and library read) ───────────────
// A snapshot: { shows: Map(show_id → catalog), films: Map(item_id → catalog),
// kinds: Map(item_id → 'genre' | 'other'), knownShows / knownItems: the shows and rows
// read in the same operation (what the snapshot can speak for), seq, stamp }.
// Each read takes its number and a read stamp when it starts. Only a read newer than
// the published snapshot that no change overlapped (write-lane.js readFresh) publishes;
// an older read that finishes late never replaces newer governance. A record the
// published snapshot doesn't cover has no known policy: it is neither deleted nor
// matched (editPolicyOf).
let governanceReadSeq = 0;

async function readGovernance() {
  const seq = ++governanceReadSeq, stamp = readStamp();
  const [shows, films, kinds] = await Promise.all([fetchAllRowsStrict('library_catalog_shows'),
    fetchAllRowsStrict('library_catalog_films'), fetchAllRowsStrict('library_film_theme_kinds')]);
  return { shows: new Map(shows.map(x => [x.show_id, x.catalog])), films: new Map(films.map(x => [x.item_id, x.catalog])),
    kinds: new Map(kinds.map(x => [x.item_id, x.theme_kind])), knownShows: new Set(), knownItems: new Set(), seq, stamp };
}

// The rows and shows read together with a snapshot: what it can speak for.
function governanceCovers(gov, rows, shows) {
  (rows || []).forEach(r => gov.knownItems.add(r.id));
  (shows || []).forEach(s => gov.knownShows.add(s.id));
  return gov;
}

function publishGovernance(gov) {
  if (!gov || !readFresh(gov.stamp) || gov.seq <= (libraryGovernance.seq || 0)) return false;
  libraryGovernance = gov;
  return true;
}

// After a restore nothing read before it speaks for the data: no record has a known
// policy until a read started after it publishes one.
function resetGovernance() {
  libraryGovernance = { shows: new Map(), films: new Map(), kinds: new Map(), knownShows: new Set(), knownItems: new Set(),
    seq: governanceReadSeq };
}

// Whether the published snapshot speaks for this record (a season through its show).
function governanceKnows(r) {
  const g = libraryGovernance;
  return !!r && !!g.knownShows && (r.show_id ? g.knownShows.has(r.show_id) : g.knownItems.has(r.id));
}

// The catalog that governs a show, or a row (a season through its show; a film itself).
function showCatalogOf(show) {
  return show ? libraryGovernance.shows.get(show.id) || null : null;
}
function rowCatalogOf(r) {
  if (!r) return null;
  return (r.show_id ? libraryGovernance.shows.get(r.show_id) : libraryGovernance.films.get(r.id)) || null;
}
// What a film's theme means: 'genre' or 'other' (null for a TV season or an unknown row).
function filmThemeKindOf(r) {
  return r ? libraryGovernance.kinds.get(r.id) || null : null;
}

// ─── Editing rules (by governance) ────────────────────────────────────────────
// A catalog entry: a record a built-in catalog governs (since item 4 the config-based lists are
// retired, so every governed record counts, as the lists' entries did). × skips it (a TV season:
// the season's skip flag; a film: its status) and never deletes it; anything else is deleted after
// a confirmation.
function isCatalogEntry(r) {
  return !!rowCatalogOf(r);
}
// The built-in catalogs' names (their governance stays on the records they hold).
const CATALOG_LABELS = { disney: 'Disney+', '90day': '90 Day', sheridan: 'Sheridan' };
function catalogLabel(catalogId) {
  return CATALOG_LABELS[catalogId] || catalogId;
}

function editPolicyOf(r) {
  // Unknown governance never permits a delete or a Match (a read that can speak for the record decides).
  if (!governanceKnows(r)) return { isDefault: null, matchable: false, deleteEffect: 'unknown' };
  const isDefault = isCatalogEntry(r);
  return { isDefault, matchable: isTmdbMatchEligible(r), deleteEffect: isDefault ? (isTvSeason(r) ? 'skip' : 'skip-film') : 'delete' };
}

// How seasons are added to a show already on the list: 'tmdb' (TMDB seasons) for
// an identified show no catalog governs; 'label' (by label) for a governed
// TMDB-matched show (a plain "Season N" becomes TMDB season N, any other label is
// held for review) and for a show without a TMDB identity.
function showAddKind(show) {
  return show.tmdb_id != null && !showCatalogOf(show) ? 'tmdb' : 'label';
}

// A hint only: a built-in catalog governs this show.
function catalogListingOf(show) {
  const c = showCatalogOf(show);
  return c ? catalogLabel(c) : null;
}

// The show as the page shows it: the database refuses if it no longer matches.
function libraryExpected(show, network) {
  return { tmdb_id: show.tmdb_id ?? null, show_key: show.show_key, catalog: showCatalogOf(show), network: network || '' };
}

function librarySeasonLabel(n) {
  return n === 0 ? 'Specials' : `Season ${n}`;
}

// A TMDB season for an identified show (its stored show key, so the database's
// key rule holds).
function libraryTmdbSeason(show, s, network) {
  const label = librarySeasonLabel(s.season_number);
  return { item_key: `${show.show_key}|${label.toLowerCase()}`, title: show.title, season: label, theme: network || '',
    display_date: s.air_date ? formatDisplayDate(s.air_date) : 'TBA', date_sort: s.air_date || '2099-01-01', season_number: s.season_number };
}

// A season by label for a show (its stored show key: the database checks it).
function libraryLabelSeason(show, label, displayDate, theme) {
  const l = String(label || '').trim();
  return { item_key: `${show.show_key}|${l.toLowerCase()}`, title: show.title, season: l, theme: theme || '',
    display_date: displayDate, date_sort: parseDate(displayDate) };
}

// The seasons of a new show from its TMDB details (the same rows a TMDB add has always made).
function libraryNewShowSeasons(tmdbId, name, details, nums) {
  const key = name.toLowerCase().trim();
  const byNum = new Map((details.seasons || []).map(s => [s.season_number, s]));
  return nums.filter(n => byNum.has(n)).map(n => {
    const s = byNum.get(n), label = librarySeasonLabel(n);
    return { item_key: `${key}|${label.toLowerCase()}`, title: name, season: label, theme: (details.networks && details.networks[0]?.name) || 'Unknown',
      display_date: s.air_date ? formatDisplayDate(s.air_date) : 'TBA', date_sort: s.air_date || '2099-01-01', season_number: n };
  });
}

// ─── Reading the library ──────────────────────────────────────────────────────
// Every row, every show and the governance, complete or not at all
// (fetchAllRowsStrict). It is a read, not a lock: something can change between it
// and a write, which is why every addition is checked again by the database.
async function readLibrary() {
  const [rows, shows, gov] = await Promise.all([fetchAllRowsStrict(TABLE), fetchAllRowsStrict('tv_shows'), readGovernance()]);
  publishGovernance(governanceCovers(gov, rows, shows));
  return { rows, shows, showsById: new Map(shows.map(s => [s.id, s])) };
}

// Where a TMDB series goes. existing: one show has this identity; ambiguous: more
// than one (the database allows one since Stage 5; kept for safety); similar: none
// has it, but unidentified shows have the same title; new.
function routeTvResult(lib, tmdbId, name) {
  const same = lib.shows.filter(s => s.tmdb_id === tmdbId);
  if (same.length > 1) return { kind: 'ambiguous', candidates: same };
  if (same.length === 1) return { kind: 'existing', show: same[0] };
  const similar = librarySimilarShows(lib, name, String(name || '').toLowerCase().trim());
  return similar.length ? { kind: 'similar', candidates: similar } : { kind: 'new' };
}

// What a new record must be acknowledged against (the database refuses it otherwise:
// show_exists / film_exists / catalog_candidate): unmatched records with the same
// title, and records a catalog governs with the same title or key. The ids the page
// showed go with "add as new" as distinct_from: works the owner confirmed as different.
const libraryNorm = t => String(t || '').trim().toLowerCase();
function librarySimilarShows(lib, title, key) {
  return lib.shows.filter(s => (s.tmdb_id == null && (libraryNorm(s.title) === libraryNorm(title) || s.show_key === key))
    || (showCatalogOf(s) && (libraryNorm(s.title) === libraryNorm(title) || s.show_key === key)));
}
function librarySimilarFilms(lib, title, key) {
  return lib.rows.filter(r => isFilmRow(r) && ((r.tmdb_id == null && (libraryNorm(r.title) === libraryNorm(title) || r.item_key === key))
    || (rowCatalogOf(r) && (libraryNorm(r.title) === libraryNorm(title) || r.item_key === key))));
}
const libraryIds = list => list.map(x => x.id).sort();

// Where a TMDB film goes: present (the identity is already saved), similar (an
// unidentified film with the same title), or new.
function routeFilmResult(lib, tmdbId, title) {
  const films = lib.rows.filter(isFilmRow);
  const same = films.filter(r => r.media_type === 'movie' && r.tmdb_id === tmdbId);
  if (same.length) return { kind: 'present', rows: same };
  const similar = librarySimilarFilms(lib, title, `${String(title || '').toLowerCase().trim()}|film`);
  return similar.length ? { kind: 'similar', rows: similar } : { kind: 'new' };
}

// ─── Year filter (All TV, All Movies) ─────────────────────────────────────────
// A year only for a valid date that isn't TBA (a TBA entry's guessed date isn't a year).
function rowYear(r) {
  return !isTbaRow(r) && isValidDateSort(r.date_sort) ? r.date_sort.slice(0, 4) : null;
}

function yearFilterSelectHtml(rows) {
  const years = [...new Set(rows.map(rowYear).filter(Boolean))].sort();
  if (!years.length) return '';
  return `<select id="fYear" onchange="renderTable()" aria-label="Year">
        <option value="">All years</option>${years.map(y => `<option value="${y}">${y}</option>`).join('')}
      </select>`;
}

// ─── The open view, read again ────────────────────────────────────────────────
// The one reread path: after a change (inside its write lane), Retry and Read again.
// A view that already shows a complete list is read in place (derived-views.js
// loadDerivedView, browse-views.js loadBrowseView). Returns true / false (failed) /
// null (superseded, or nothing to read).
function reloadOpenView() {
  if (typeof isSettingsView === 'function' && isSettingsView()) { renderSettings(); return true; } // Settings (S1): drawn again; nothing is read
  if (typeof isCollectionsStateView === 'function' && isCollectionsStateView()) { renderCollectionsState(); buildBrowseBar({ resolve: false }); return true; } // the Collections state (S2): drawn again; nothing is read or opened
  if (isBrowseView(activeViewId)) return loadBrowseView();
  else if (activeViewId) return loadDerivedView();
  return null;
}

// What a write started from: answers are reported in the panel only while the same
// view and panel are open.
function libraryContext() {
  return { session: libraryPanel ? libraryPanel.session : 0, viewId: activeViewId, quick: libraryPanel ? libraryPanel.quick : null };
}

function libraryLive(session) {
  return !!libraryPanel && libraryPanel.session === session && libraryPanel.viewId === activeViewId;
}

// Reported in the panel while it is open, otherwise above the list. Callers report
// after starting the view's reload (a reload clears the error line).
function libraryReport(ctx, text, isError, extraHtml = '') {
  if (libraryLive(ctx.session)) {
    const el = document.getElementById('libraryOutcome');
    if (el) { el.innerHTML = `<div class="${isError ? 'error-banner' : 'banner'}">${isError ? '⚠️ ' : ''}${esc(text)}</div>${extraHtml}`; return; }
  }
  if (isError) showError(text); else showNotice(text);
}

// A title just created: its optional next step in the panel. From a search begun in a collection, an
// outcome reported after the panel closed says the title didn't reach that collection.
function libraryReportCreated(ctx, text, target, title) {
  const panelOpen = libraryLive(ctx.session);
  libraryReport(ctx, !panelOpen && ctx.quick ? `${text} It isn’t in ${ctx.quick.label}.` : text, false, libraryMembershipHtml(ctx, target, title));
}

// A failed request: unknown (no clear answer: it may still have happened), or a
// refusal (nothing was written by this call).
function libraryFailure(e, what, feature = 'Adding to an existing show') {
  const info = orgErrorInfo(e);
  if (info.kind !== 'database') {
    return { unknown: true, text: `${what}: no clear answer came back (${info.message}), so it isn’t confirmed. The list may or may not show it now, and an earlier request may still complete. Check before adding again. If you reload, this page won’t know whether that request finished.` };
  }
  if (info.status === 404 && info.pgCode === 'PGRST202') return { text: `${feature} isn’t available on this database. Nothing was added.` };
  if (/^(target_missing|target_changed|show_exists|create_conflict|film_exists|client_outdated|library_write_required|update_required|catalog_candidate)$/.test(info.code)) return { text: orgRefusalText(info) };
  if (/^(55P03|57014)$/.test(info.pgCode)) return { text: `${what}: the database didn’t finish in time, so it was cancelled. Nothing was added.` };
  if (info.pgCode === '23505') return { text: `${what}: it’s already on your list (added somewhere else just now). Nothing was added.` };
  return { text: `${what} was refused (${info.message}). Nothing was added.` };
}

const libraryList = items => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const LIBRARY_REVIEW_TEXT = {
  enriched_show_label: 'this show takes plain “Season N” labels, so it needs review',
  identity_conflict: 'another entry already holds that season, so it needs review',
  legacy_row_same_key: 'an entry with the same name is already saved, so it needs review',
  identified_row_same_key: 'an entry with the same name is already saved, so it needs review'
};

// The answer of library_add_seasons / library_create_show, item by item.
function libraryAddText(res, title) {
  const inserted = (res.inserted || []).map(r => `“${r.season}”`);
  const parts = [inserted.length ? `Added ${libraryList(inserted)} to “${title}”.` : `Nothing new was added to “${title}”.`];
  const existing = (res.existing || []).length;
  if (existing) parts.push(`${existing} ${existing === 1 ? 'season was' : 'seasons were'} already on your list.`);
  for (const x of res.rejected || []) parts.push(`“${x.season || x.item_key}” wasn’t added: ${LIBRARY_REVIEW_TEXT[x.reason] || x.reason}.`);
  // B5: an addition never changes the show's status, priority or Show ended.
  if (res.ended_kept) parts.push(`“${title}” is marked ended; it stays marked ended.`);
  if (res.unmapped && res.unmapped.length) parts.push(`TMDB categories not used: ${res.unmapped.join(', ')}.`);
  return parts.join(' ');
}

// ─── The panel ────────────────────────────────────────────────────────────────
const LIBRARY_MODES = {
  tv: [['search', 'Search TMDB'], ['manual', 'New show by hand'], ['refresh', 'Refresh shows']],
  movie: [['search', 'Search TMDB'], ['manual', 'New film by hand'], ['tools', 'Collections & people']]
};

function libraryAddButtonHtml(media) {
  return `<button class="btn add-open-btn" onclick="openLibraryPanel('${media}')">+ Add</button>`;
}

function openLibraryPanel(media, mode = 'search', extra = {}) {
  if (!activeViewId || (media !== 'tv' && media !== 'movie')) return;
  if (window.__tmdbMatch) window.__tmdbMatch = null;
  cancelTMDBPreview();
  libraryPanel = { session: ++libraryPanelSeq, media, mode, viewId: activeViewId, lib: null, libState: 'reading',
    libError: '', choice: null, bound: null, seasonShowId: null, seasonDetails: null, refresh: null, manualConfirm: null, ...extra };
  renderLibraryPanel();
  libraryLoad(libraryPanel.session);
}

// The Close button: focus goes back to what opened the panel, while it's on the page.
function libraryPanelClose() {
  const fromField = !!(libraryPanel && libraryPanel.fromField);
  closeLibraryPanel();
  const field = fromField ? document.getElementById('tmdbQuickQuery') : null;
  const target = field && field.offsetParent !== null ? field : document.querySelector('.add-open-btn');
  if (target && typeof target.focus === 'function') target.focus();
}

// ─── The toolbar's TMDB search (desktop; below that, + Add reaches the same search) ───
// It only fills in the panel's search: searching and previewing read TMDB and nothing else, and
// adding is the panel's own, confirmed in its preview. media: 'tv', 'movie' or, in a mixed collection,
// 'mixed' (both kinds, each tagged; the result chosen decides the type).
function tmdbQuickHtml(media, dest) {
  const name = dest ? `Search TMDB to add to your library, then choose collections for ${dest.label}` : 'Search TMDB to add';
  return `<form class="tmdb-quick" role="search" onsubmit="event.preventDefault(); tmdbQuickSubmit('${media}')"><input id="tmdbQuickQuery" type="search" placeholder="Search TMDB to add…" aria-label="${esc(name)}" value="${esc(tmdbQuickText)}" oninput="tmdbQuickText = this.value"><button type="submit" class="tmdb-quick-go" aria-label="Search TMDB">⏎</button></form>`;
}
function tmdbQuickSubmit(media) {
  const field = document.getElementById('tmdbQuickQuery');
  const query = field ? field.value.trim() : '';
  if (!query) return;
  const dest = isBrowseCollectionView(activeViewId) ? currentBrowseDest() : null;
  openLibraryPanel(media === 'movie' ? 'movie' : 'tv', 'search', { mixed: media === 'mixed', fromField: true,
    quick: dest ? { collectionId: dest.collectionId, label: dest.label } : null });
  const input = document.getElementById('tmdbQuery');
  if (input) input.value = query;
  return searchTMDB({ focusResults: true });
}

// A title the panel didn't create, in the search that began in a collection: where it stands there.
// Adding goes through the collection's own picker, with this title selected.
function libraryCollectionFollowHtml(key, title) {
  const p = libraryPanel;
  if (!p || !p.quick || !isBrowseCollectionView(activeViewId) || !browseData || !browseData.members) return '';
  const [kind, id] = key.split(':');
  if ((kind === 's' ? browseData.members.showIds : browseData.members.filmIds).has(id)) return `<div class="tmdb-refresh-summary">Already in ${esc(p.quick.label)}.</div>`;
  if (!collectionAddAllowed()) return `<div class="tmdb-refresh-summary">“${esc(title)}” isn’t in ${esc(p.quick.label)}. It can’t be added right now: the collection may be out of date.</div>`;
  return `<div class="library-members"><span class="tmdb-refresh-summary">“${esc(title)}” isn’t in ${esc(p.quick.label)}.</span>
    <button class="btn" onclick="openAddPicker(this, ['${esc(key)}'])">Add to ${esc(p.quick.label)}…</button></div>`;
}

function closeLibraryPanel() {
  libraryPanel = null;
  tmdbSelectedShow = null;
  if (window.__tmdbMatch) window.__tmdbMatch = null;
  const el = document.getElementById('libraryPanel');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

function setLibraryMode(mode) {
  if (!libraryPanel || !(LIBRARY_MODES[libraryPanel.media] || []).some(([m]) => m === mode)) return;
  if (window.__tmdbMatch) window.__tmdbMatch = null;
  cancelTMDBPreview();
  Object.assign(libraryPanel, { mode, choice: null, bound: null, refresh: null, manualConfirm: null, seasonShowId: null, seasonDetails: null });
  renderLibraryPanel();
}

// The whole library, read for this panel (again after each write).
async function libraryLoad(session) {
  const p = libraryPanel;
  if (!p || p.session !== session) return;
  p.libState = 'reading';
  libraryStateLine();
  try {
    const lib = await readLibrary();
    if (!libraryLive(session)) return;
    p.lib = lib;
    p.libState = 'ready';
  } catch (e) {
    if (!libraryLive(session)) return;
    p.libState = 'failed';
    p.libError = e.message;
  }
  libraryStateLine();
  if (p.mode === 'season') renderLibraryBody();
  else if (tmdbSelectedShow && tmdbSelectedShow.details) renderTMDBPreview();
}

function libraryStateLine() {
  const el = document.getElementById('libraryState');
  const p = libraryPanel;
  if (!el || !p) return;
  el.innerHTML = p.libState === 'reading' ? 'Reading your list…'
    : p.libState === 'failed' ? `Couldn’t read your whole list (${esc(p.libError)}), so nothing can be added right now. <button class="btn" onclick="libraryLoad(${p.session})">Retry</button>` : '';
}

function renderLibraryPanel() {
  const el = document.getElementById('libraryPanel');
  const p = libraryPanel;
  if (!el || !p) return;
  const modes = (LIBRARY_MODES[p.media] || []).map(([m, label]) =>
    `<button class="view-toggle-btn${p.mode === m ? ' active' : ''}" aria-pressed="${p.mode === m}" onclick="setLibraryMode('${m}')">${label}</button>`).join('');
  const pull = p.mode === 'pull'; // S4: Pull rest from a collection (no other modes)
  const title = pull ? `Pull rest of ${p.pullName || 'the franchise'}` : p.quick ? 'Add to library, then choose collections' : p.media === 'movie' ? 'Add films' : 'Add TV';
  el.style.display = 'block';
  el.innerHTML = `<div class="library-head">
      <strong>${esc(title)}</strong>
      ${pull || p.quick ? '' : `<div class="view-toggle" role="group" aria-label="How to add">${modes}</div>`}
      <button class="btn" onclick="libraryPanelClose()">Close</button>
    </div>
    ${p.quick ? `<div class="tmdb-refresh-summary">Adding to your library comes first. ${esc(p.quick.label)} is preselected at the next step, and it’s only added when you confirm there.</div>` : ''}
    <div id="libraryState" class="tmdb-refresh-summary"></div>
    <div id="libraryOutcome" role="status"></div>
    <div id="libraryBody"></div>`;
  libraryStateLine();
  renderLibraryBody();
}

function renderLibraryBody() {
  const el = document.getElementById('libraryBody');
  const p = libraryPanel;
  if (!el || !p) return;
  const searchRow = `<div class="tmdb-search-row">
      <input id="tmdbQuery" type="text" placeholder="${p.mixed ? 'Search for a show or film…' : p.media === 'movie' ? 'Search for a film…' : 'Search for a show…'}" onkeydown="if(event.key==='Enter'){searchTMDB();}">
      <button class="btn btn-accent" onclick="searchTMDB()">Search</button>
    </div>`;
  const results = '<div id="tmdbResults" aria-live="polite"></div><div id="tmdbPreview"></div>';
  if (p.mode === 'search') el.innerHTML = searchRow + results;
  else if (p.mode === 'match' || p.mode === 'pull') el.innerHTML = results;
  else if (p.mode === 'manual') el.innerHTML = p.media === 'movie' ? libraryManualFilmHtml() : libraryManualShowHtml();
  else if (p.mode === 'refresh') el.innerHTML = `<div class="tmdb-search-row"><button class="btn" onclick="cuRefreshShows()">↻ Check every show with TMDB</button>
      <span class="tmdb-refresh-summary">Every show in your library, catalog and collection shows included (Skipped shows only when you keep checking them). New seasons, TBA and future dates, episode lists and matches are updated automatically; anything uncertain waits for your review. TMDB only: announcements come from research briefs (Settings → Collection updates).</span></div>${results}`;
  else if (p.mode === 'tools') el.innerHTML = `<div class="tmdb-search-row">
        <button class="btn" onclick="libraryMovieTool('collections')" title="Check your tracked collections/franchises for films you haven't added yet">↻ Refresh collections</button>
      </div>
      <div class="tmdb-universe-row">
        <button class="universe-link" onclick="libraryMovieTool('mcu')">+ pull entire MCU</button>
        <span class="universe-sep">·</span>
        <button class="universe-link" onclick="libraryMovieTool('person')">+ start a person collection</button>
      </div>
      <div id="personCollectionPrompt" style="display:none"></div>${results}`;
  else if (p.mode === 'season') el.innerHTML = librarySeasonHtml();
}

// ─── Search results: where a choice goes ──────────────────────────────────────
// Called by renderTMDBPreview (tmdb-search.js) while the panel is open.
function libraryRenderPreview() {
  const previewEl = getTMDBPreviewContainer();
  const p = libraryPanel;
  if (!previewEl || !p || !tmdbSelectedShow || !tmdbSelectedShow.details) return;
  const sel = tmdbSelectedShow;
  if (p.libState !== 'ready') {
    previewEl.innerHTML = `<div class="tmdb-loading">${p.libState === 'failed' ? 'Your list couldn’t be read, so nothing can be added (Retry above).' : 'Checking your list…'}</div>`;
    return;
  }
  const actions = (label, handler, extra = '') => `<div class="tmdb-preview-actions">${label ? `<button class="btn btn-accent" onclick="${handler}"${extra}>${esc(label)}</button>` : ''}<button class="btn" onclick="cancelTMDBPreview()">Cancel</button></div>`;
  const header = meta => `<div class="tmdb-preview-header"><div><div class="tmdb-preview-title">${esc(sel.name)}</div><div class="tmdb-result-meta">${esc(meta)}</div></div></div>`;
  const choice = p.choice && p.choice.tmdbId === sel.id && p.choice.mediaType === sel.mediaType ? p.choice : null;

  if (sel.mediaType === 'movie') {
    const d = sel.details;
    const route = choice && choice.asNew ? { kind: 'new' } : routeFilmResult(p.lib, sel.id, sel.name);
    const meta = `Film · ${d.release_date ? formatDisplayDate(d.release_date) : 'TBA'}`;
    if (route.kind === 'present') {
      p.bound = null;
      previewEl.innerHTML = `<div class="tmdb-preview">${header(meta)}<div class="tmdb-refresh-summary">Already on your list${route.rows.length > 1 ? ` (${route.rows.length} records)` : ''}. Nothing to add.</div>${route.rows.length === 1 ? libraryCollectionFollowHtml(`i:${route.rows[0].id}`, sel.name) : ''}${actions('', '')}</div>`;
      return;
    }
    if (route.kind === 'similar') {
      p.bound = null;
      p.similarShown = libraryIds(route.rows);
      previewEl.innerHTML = `<div class="tmdb-preview">${header(meta)}<div class="tmdb-refresh-summary">A film called “${esc(route.rows[0].title)}” is already on your list${route.rows[0].tmdb_id == null ? ', not matched to TMDB' : ''}${rowCatalogOf(route.rows[0]) ? ` (in the ${esc(catalogLabel(rowCatalogOf(route.rows[0])))} catalog)` : ''}. It may be the same film; nothing is merged.</div>
        <div class="tmdb-preview-actions"><button class="btn" onclick="libraryChoose(${sel.id}, 'movie', null, true)">Add as a new film anyway</button><button class="btn" onclick="cancelTMDBPreview()">Cancel</button></div></div>`;
      return;
    }
    p.bound = { kind: 'new-film', tmdbId: sel.id, mediaType: 'movie' };
    previewEl.innerHTML = `<div class="tmdb-preview">${header(meta)}
      ${addScreenCollectionNoteHtml(d, sel.id, p.lib.rows)}
      <div class="tmdb-refresh-summary">Adds a new film to your list.</div>${actions('Add film', 'addSelectedTMDBSeasons()')}</div>`;
    return;
  }

  const details = sel.details;
  const network = (details.networks && details.networks[0]?.name) || 'Unknown';
  let route = routeTvResult(p.lib, sel.id, sel.name);
  if (route.kind === 'similar') p.similarShown = libraryIds(route.candidates);
  if (choice && choice.showId) {
    const s = p.lib.showsById.get(choice.showId);
    route = s ? { kind: 'existing', show: s } : route;
  } else if (choice && choice.asNew && route.kind === 'similar') route = { kind: 'new' };

  if (route.kind === 'ambiguous') {
    p.bound = null;
    previewEl.innerHTML = `<div class="tmdb-preview">${header(network)}<div class="tmdb-refresh-summary">This show is on your list more than once (nothing is merged automatically). Choose which one to add seasons to:</div>
      ${route.candidates.map(s => `<div class="tmdb-season-row"><span class="tmdb-season-name">${esc(s.title)}</span>
        <span class="tmdb-season-meta">${esc(statusOptionLabel(s.status))} · ${p.lib.rows.filter(r => r.show_id === s.id).length} seasons</span>
        <button class="btn" onclick="libraryChoose(${sel.id}, 'tv', '${esc(s.id)}')">Use this one</button></div>`).join('')}${actions('', '')}</div>`;
    return;
  }
  if (route.kind === 'similar') {
    p.bound = null;
    const s = route.candidates[0];
    previewEl.innerHTML = `<div class="tmdb-preview">${header(network)}<div class="tmdb-refresh-summary">“${esc(s.title)}” is already on your list${s.tmdb_id == null ? ', not matched to TMDB' : ''}${showCatalogOf(s) ? ` (in the ${esc(catalogLabel(showCatalogOf(s)))} catalog)` : ''}. It may be the same show; nothing is merged.</div>
      <div class="tmdb-preview-actions" style="flex-wrap:wrap">
        <button class="btn" onclick="openAddSeason('${esc(s.id)}')">Add a season to “${esc(s.title)}” by hand</button>
        <button class="btn" onclick="libraryChoose(${sel.id}, 'tv', null, true)">Add as a new show</button>
        <button class="btn" onclick="cancelTMDBPreview()">Cancel</button></div></div>`;
    return;
  }
  if (route.kind === 'existing' && showAddKind(route.show) === 'label') {
    p.bound = null;
    const s = route.show, listed = catalogListingOf(s);
    previewEl.innerHTML = `<div class="tmdb-preview">${header(network)}<div class="tmdb-refresh-summary">“${esc(s.title)}” is already on your list. TMDB seasons can’t be added to it here; you can add a season to it by hand (a plain “Season N” becomes TMDB season N; any other label is held for review).${listed ? ` The ${esc(listed)} catalog governs this show.` : ''}</div>
      <div class="tmdb-preview-actions"><button class="btn btn-accent" onclick="openAddSeason('${esc(s.id)}')">Add a season by hand</button><button class="btn" onclick="cancelTMDBPreview()">Cancel</button></div></div>`;
    return;
  }

  // TMDB seasons: for the show already on the list, or a new show.
  const existing = route.kind === 'existing' ? route.show : null;
  const have = n => existing ? p.lib.rows.some(r => r.show_id === existing.id && r.season_number === n) : false;
  const seasons = (details.seasons || []).filter(s => tmdbShowSpecials || s.season_number !== 0).sort((a, b) => a.season_number - b.season_number);
  p.bound = existing
    ? { kind: 'existing', tmdbId: sel.id, mediaType: 'tv', showId: existing.id, expected: libraryExpected(existing, network) }
    : { kind: 'new-show', tmdbId: sel.id, mediaType: 'tv' };
  const rows = seasons.map(s => {
    const done = have(s.season_number);
    return `<div class="tmdb-season-row ${done ? 'already-added' : ''}">
      <input type="checkbox" ${done ? 'disabled' : 'checked'} data-season="${s.season_number}" id="szn_${s.season_number}">
      <span class="tmdb-season-name">${esc(librarySeasonLabel(s.season_number))}</span>
      <span class="tmdb-season-meta">${s.episode_count || 0} episodes · ${esc(s.air_date ? formatDisplayDate(s.air_date) : 'TBA')}</span>
      ${done ? '<span class="tmdb-already-tag">Already added</span>' : ''}
    </div>`;
  }).join('');
  previewEl.innerHTML = `<div class="tmdb-preview">
      <div class="tmdb-preview-header"><div><div class="tmdb-preview-title">${esc(sel.name)}</div><div class="tmdb-result-meta">${esc(network)}</div></div>
        <label class="tmdb-specials-toggle"><input type="checkbox" id="tmdbSpecialsToggle" ${tmdbShowSpecials ? 'checked' : ''} onchange="toggleTMDBSpecials()"> Include specials</label></div>
      <div class="tmdb-refresh-summary">${existing ? `Adds seasons to “${esc(existing.title)}”, already on your list.` : 'Adds a new show to your list.'}</div>
      ${existing ? libraryCollectionFollowHtml(`s:${existing.id}`, existing.title) : ''}
      ${rows || '<div class="tmdb-no-results">No seasons found.</div>'}
      ${actions(existing ? `Add to “${existing.title}”` : 'Add as a new show', 'addSelectedTMDBSeasons()')}
    </div>`;
}

// An explicit choice for an ambiguous or similar result (never made automatically).
function libraryChoose(tmdbId, mediaType, showId, asNew) {
  if (!libraryPanel) return;
  // "Add as new": the records the preview showed are acknowledged as different works.
  libraryPanel.choice = { tmdbId, mediaType, showId: showId || null, asNew: !!asNew, ack: asNew ? (libraryPanel.similarShown || []).slice() : [] };
  renderTMDBPreview();
}

// The checked seasons of the open preview.
function libraryCheckedSeasons() {
  const c = getTMDBPreviewContainer();
  const boxes = c ? c.querySelectorAll('input[type="checkbox"][data-season]') : [];
  const nums = [];
  boxes.forEach(cb => { if (cb.checked && !cb.disabled) nums.push(parseInt(cb.dataset.season, 10)); });
  return nums;
}

// Called by addSelectedTMDBSeasons (tmdb-search.js) while the panel is open. The
// route bound by the preview is used as it was shown: the library is read again,
// and a different route means "look again" with nothing sent.
async function librarySubmitSelection() {
  const p = libraryPanel, sel = tmdbSelectedShow;
  if (!p || !sel || !sel.details || !p.bound || p.bound.tmdbId !== sel.id || p.busy) return;
  const bound = p.bound, details = sel.details, name = sel.name;
  const nums = sel.mediaType === 'movie' ? [] : libraryCheckedSeasons();
  if (sel.mediaType !== 'movie' && !nums.length) return;
  const ctx = libraryContext();
  p.busy = true;
  try {
    let lib;
    try { lib = await readLibrary(); }
    catch (e) { libraryReport(ctx, `Couldn’t read your whole list (${e.message}), so nothing was added.`, true); return; }
    if (!libraryLive(ctx.session)) return;
    p.lib = lib;
    const ack = p.choice && p.choice.asNew ? p.choice.ack || [] : [];
    // A similar record that appeared after the preview (not acknowledged) means the preview no longer applies.
    const unacknowledged = sel.mediaType === 'movie'
      ? libraryIds(librarySimilarFilms(lib, name, `${name.toLowerCase().trim()}|film`)).filter(id => !ack.includes(id))
      : libraryIds(librarySimilarShows(lib, name, name.toLowerCase().trim())).filter(id => !ack.includes(id));
    const now = sel.mediaType === 'movie'
      ? (routeFilmResult(lib, sel.id, name).kind === 'present' ? 'present' : unacknowledged.length ? 'similar' : 'new')
      : bound.kind === 'existing' ? (lib.showsById.get(bound.showId) ? 'existing' : 'gone')
      : (routeTvResult(lib, sel.id, name).kind === 'existing' || routeTvResult(lib, sel.id, name).kind === 'ambiguous') ? 'existing'
      : unacknowledged.length ? 'similar' : 'new';
    const same = bound.kind === 'existing'
      ? now === 'existing' && JSON.stringify(libraryExpected(lib.showsById.get(bound.showId), bound.expected.network)) === JSON.stringify(bound.expected)
      : now === 'new';
    if (!same) {
      libraryReport(ctx, 'Your list changed since this preview, so nothing was added. Look at it again.', true);
      renderTMDBPreview();
      return;
    }
    if (sel.mediaType === 'movie') return await libraryAddFilm(ctx, { ...libraryFilmFromTmdb(sel.id, name, details), ...(ack.length ? { distinct_from: ack } : {}) },
      undefined, (md => md.unmapped.concat(md.omitted))(tmdbMetadata('movie', details)));
    if (bound.kind === 'existing') {
      const show = lib.showsById.get(bound.showId);
      const byNum = new Map((details.seasons || []).map(s => [s.season_number, s]));
      const seasons = nums.filter(n => byNum.has(n)).map(n => libraryTmdbSeason(show, byNum.get(n), bound.expected.network));
      return await librarySendToShow(ctx, show, seasons, bound.expected.network);
    }
    return await libraryNewShow(ctx, { tmdb_id: sel.id, title: name, show_key: name.toLowerCase().trim(),
      network: (details.networks && details.networks[0]?.name) || 'Unknown', ...creationMetadata('tv', details),
      ...(ack.length ? { distinct_from: ack } : {}) }, libraryNewShowSeasons(sel.id, name, details, nums), (md => md.unmapped.concat(md.omitted))(tmdbMetadata('tv', details)));
  } finally {
    if (libraryPanel === p) p.busy = false;
  }
}

function libraryFilmFromTmdb(tmdbId, name, details) {
  const belongsTo = details.belongs_to_collection;
  return { item_key: `${name.toLowerCase().trim()}|film`, title: name, season: 'Film',
    theme: (details.genres && details.genres[0]?.name) || 'Film',
    display_date: details.release_date ? formatDisplayDate(details.release_date) : 'TBA', date_sort: details.release_date || '2099-01-01',
    watched: false, status: 'confirmed', ...creationMetadata('movie', details),
    tmdb_collection_id: belongsTo ? belongsTo.id : null, tmdb_collection_name: belongsTo ? belongsTo.name : null,
    collections: belongsTo ? [belongsTo.name] : [], media_type: 'movie', tmdb_id: tmdbId, season_number: null };
}

// ─── Sending ──────────────────────────────────────────────────────────────────
// Seasons for a show already on the list: refused by the database if that show is
// gone or changed. The answer's show is checked again here.
async function librarySendToShow(ctx, show, seasons, network) {
  return await runWrite(`Adding to “${show.title}”`, async () => {
    let res;
    try {
      res = await sbRpc('library_add_seasons_b45', { p_show_id: show.id, p_expected: libraryExpected(show, network), p_seasons: seasons });
    } catch (e) {
      const f = libraryFailure(e, `Adding to “${show.title}”`);
      await libraryAfterWrite(ctx);
      libraryReport(ctx, f.text, true);
      return { failed: true, unknown: !!f.unknown };
    }
    if (!res || res.show_id !== show.id || res.show_created) {
      await libraryAfterWrite(ctx);
      libraryReport(ctx, `The answer named a different show than “${show.title}”, so this isn’t reported as an addition to it. Check your list before adding again.`, true);
      return { failed: true };
    }
    if ((res.inserted || []).length) showSaved();
    await libraryAfterWrite(ctx);
    libraryReport(ctx, libraryAddText(res, show.title), !!(res.rejected || []).length && !(res.inserted || []).length,
      libraryCollectionFollowHtml(`s:${show.id}`, show.title));
    return { res };
  }) || { failed: true };
}

// A new show, through library_create_show: created with all its seasons, or refused
// (show_exists / create_conflict, nothing written) when a show with this identity,
// or an unmatched one with this key the page didn't show (distinct_from), is there
// by then. It never joins a show.
async function libraryNewShow(ctx, showInfo, seasons, unmapped = []) {
  if (!seasons.length) return;
  await runWrite(`Adding “${showInfo.title}”`, async () => {
    let res;
    try {
      res = await sbRpc('library_create_show_b45', { p_show: showInfo, p_seasons: seasons });
    } catch (e) {
      const f = libraryFailure(e, `Adding “${showInfo.title}”`, 'Adding a new show');
      await libraryAfterWrite(ctx);
      libraryReport(ctx, f.text, true);
      return;
    }
    const networkNote = res && res.show_created ? await libraryConfirmNetwork(showInfo, res.show_id) : '';
    await libraryAfterWrite(ctx);
    if (!res || !res.show_created) { // not expected from library_create_show_b45; never reported as a new show
      libraryReport(ctx, `The answer didn’t confirm a new show “${showInfo.title}”. Check your list before adding again.`, true);
      return;
    }
    if ((res.inserted || []).length) showSaved();
    libraryReportCreated(ctx, [libraryAddText({ ...res, unmapped }, showInfo.title), networkNote].filter(Boolean).join(' '), { show_id: res.show_id }, showInfo.title);
  });
}
// A new TMDB show's network (CU1d): creation can't set one, so a sole TMDB network is confirmed straight after, in
// the same change; several wait for the owner's choice. The show is added either way: a confirmation that fails
// is never resent, and the next Refresh shows confirms it. The sentence for the outcome ('' when there's nothing to say).
async function libraryConfirmNetwork(showInfo, showId) {
  const names = showInfo.network_candidates || [];
  if (showInfo.tmdb_id == null || !names.length) return '';
  if (names.length > 1) return `TMDB lists several networks (${names.join(', ')}); choose one in the show’s Details.`;
  try {
    await sbRpc('library_cu_sync_show_network', { p_show_id: showId, p_networks: names,
      p_expected: { tmdb_id: showInfo.tmdb_id, network: null, network_candidates: names, metadata_owner_set: false } });
    return '';
  } catch (e) { return `Its network (${names[0]}) couldn’t be confirmed just now; Refresh shows will try again.`; }
}

// A film: from TMDB through library_add_films (already on the list: reported, not
// added again), or typed by hand through library_create_film (distinct_from: the
// same-named unmatched films the page showed).
// unmapped: TMDB categories the approved lists don't take (named in the outcome, never guessed).
async function libraryAddFilm(ctx, film, distinctFrom, unmapped = []) {
  await runWrite(`Adding “${film.title}”`, async () => {
    let saved;
    try {
      if (film.tmdb_id != null) {
        const res = await sbRpc('library_add_films_b45', { p_films: [film] });
        const out = res && res.results && res.results[0];
        if (out && out.outcome === 'catalog_candidate') {
          await libraryAfterWrite(ctx);
          libraryReport(ctx, `A built-in catalog film with this name is on your list (it may be the same film), so “${film.title}” wasn’t added. Look at it again.`, true);
          return;
        }
        if (!out || out.outcome !== 'inserted') {
          await libraryAfterWrite(ctx);
          libraryReport(ctx, `“${film.title}” is already on your list (added somewhere else just now). Nothing was added.`, true);
          return;
        }
        saved = { id: out.id };
      } else {
        const res = await sbRpc('library_create_film_b45', { p_film: { ...film, distinct_from: distinctFrom || [] } });
        saved = res && res.id ? { id: res.id } : null;
      }
    } catch (e) {
      const f = libraryFailure(e, `Adding “${film.title}”`, 'Adding a film');
      await libraryAfterWrite(ctx);
      libraryReport(ctx, f.text, true);
      return;
    }
    showSaved();
    await libraryAfterWrite(ctx);
    libraryReportCreated(ctx, `Added “${film.title}”.${unmapped.length ? ` TMDB categories not used: ${unmapped.join(', ')}.` : ''}`, saved ? { item_id: saved.id } : null, film.title);
  });
}

// After any answer (a refusal or no clear answer too): the open view and the panel's
// library are read again, while the lane is still held. An unclear answer is never resent.
async function libraryAfterWrite(ctx) {
  const reads = [];
  if (activeViewId && activeViewId === ctx.viewId) reads.push(reloadOpenView());
  if (libraryLive(ctx.session)) {
    cancelTMDBPreview();
    reads.push(libraryLoad(ctx.session));
  }
  await Promise.allSettled(reads);
}

// ─── Collections after a creation (optional, separate) ────────────────────────
function libraryMembershipHtml(ctx, target, title) {
  if (!target || !libraryLive(ctx.session)) return '';
  const quick = libraryPanel.quick;
  const notYet = quick ? `“${esc(title)}” is in your library but not in ${esc(quick.label)} yet.` : '';
  const colls = orgState === 'ready' ? activeBrowseCollections() : [];
  if (!colls.length || (quick && !colls.some(c => c.collectionId === quick.collectionId))) {
    return notYet ? `<div class="library-members"><span class="tmdb-refresh-summary">${notYet} Your collections can’t be changed here right now.</span></div>` : '';
  }
  libraryPanel.memberTarget = { ...target, title };
  const preselected = c => quick && c.collectionId === quick.collectionId ? ' checked' : '';
  return `<div class="library-members"><span class="tmdb-refresh-summary">${notYet ? `${notYet} Press Add to collections to add it:` : `Also add “${esc(title)}” to collections (optional):`}</span>
    ${colls.map(c => `<label class="ww-option"><input type="checkbox" data-collection-id="${esc(c.collectionId)}"${preselected(c)}> ${esc(c.label)}</label>`).join('')}
    <button class="btn" onclick="libraryAddMemberships()">Add to collections</button></div>`;
}

// One org_add_membership per chosen collection, each reported on its own. The
// addition itself is already saved and is never repeated or undone here.
async function libraryAddMemberships() {
  const p = libraryPanel;
  if (!p || !p.memberTarget || p.membersBusy) return;
  const target = p.memberTarget;
  const box = document.getElementById('libraryOutcome');
  const chosen = [];
  (box ? box.querySelectorAll('input[type="checkbox"][data-collection-id]') : []).forEach(cb => { if (cb.checked) chosen.push(cb.dataset.collectionId); });
  if (!chosen.length) return;
  const ctx = libraryContext();
  await runWrite(`“${target.title}” · collections`, async () => {
    p.membersBusy = true;
    const lines = [];
    for (const id of chosen) {
      const name = (personalCollections || []).find(c => c.id === id)?.name || 'that collection';
      try {
        const res = await sbRpc('org_add_membership', { p_collection_id: id, p_show_id: target.show_id || null, p_item_id: target.item_id || null });
        lines.push(res && res.added === false ? `Already in ${name}.` : `Added to ${name}.`);
      } catch (e) {
        const info = orgErrorInfo(e);
        lines.push(info.kind !== 'database'
          ? `${name}: no clear answer came back, so it isn’t confirmed; check in Manage.`
          : `Couldn’t add to ${name}: ${orgRefusalText(info)}`);
      }
    }
    if (libraryPanel === p) { p.membersBusy = false; p.memberTarget = null; }
    libraryReport(ctx, `“${target.title}” is saved. ${lines.join(' ')}`, false);
    if (activeViewId === ctx.viewId && isBrowseCollectionView(activeViewId)) await reloadOpenView();
  });
}

// ─── By hand ──────────────────────────────────────────────────────────────────
function libraryManualShowHtml() {
  return `<div class="add-form-grid">
      <div><label>Title</label><input id="nTitle" type="text" placeholder="Show title"></div>
      <div><label>Season</label><input id="nSeason" type="text" value="Season 1"></div>
      <div><label>Network</label><input id="nTheme" type="text" placeholder="e.g. HBO, Netflix"></div>
      <div><label>Premiere date</label><input id="nDate" type="text" placeholder="e.g. Jan 12, 2014"></div>
      <button class="btn btn-accent" onclick="libraryManualShow()">Add new show</button>
    </div>
    <div id="libraryManualNote"></div>`;
}

function libraryManualFilmHtml() {
  return `<div class="add-form-grid">
      <div><label>Title</label><input id="nTitle" type="text" placeholder="Film title"></div>
      <div><label>Genre</label><input id="nTheme" type="text" placeholder="e.g. Drama"></div>
      <div><label>Release date</label><input id="nDate" type="text" placeholder="e.g. Jan 12, 2014"></div>
      <button class="btn btn-accent" onclick="libraryManualFilm()">Add new film</button>
    </div>
    <div id="libraryManualNote"></div>`;
}

const libraryVal = id => (document.getElementById(id)?.value || '').trim();

// A new show typed in by hand (no TMDB identity; it can be matched later). Shows
// with the same title already on the list are pointed out first; nothing is
// merged. "Add as a new show" sends the ids of the same-named unmatched shows it
// showed (distinct_from): a different work with the same name can be kept, and a
// repeat or a race is refused instead of making a second copy.
async function libraryManualShow() {
  const p = libraryPanel;
  if (!p || p.busy) return;
  const title = libraryVal('nTitle'), season = libraryVal('nSeason') || 'Season 1', theme = libraryVal('nTheme'), date = libraryVal('nDate');
  if (!title || !date) { libraryReport(libraryContext(), 'Please fill in the title and premiere date.', true); return; }
  if (season === 'Film') { libraryReport(libraryContext(), 'Films are added in Movies.', true); return; }
  const ctx = libraryContext();
  p.busy = true;
  try {
    let lib;
    try { lib = await readLibrary(); }
    catch (e) { libraryReport(ctx, `Couldn’t read your whole list (${e.message}), so nothing was added.`, true); return; }
    if (!libraryLive(ctx.session)) return;
    p.lib = lib;
    const key = `${title.toLowerCase()}|${season.toLowerCase()}`;
    const showKey = key.split('|')[0];
    const t = title.toLowerCase();
    // Every same-titled show, and any show the database would ask about (librarySimilarShows):
    // the ids the page shows here are what "Add as a new show" acknowledges.
    const similar = [...new Map([...lib.shows.filter(s => String(s.title || '').trim().toLowerCase() === t),
      ...librarySimilarShows(lib, title, showKey)].map(s => [s.id, s])).values()];
    const sameKey = libraryIds(similar);
    const confirmed = p.manualConfirm && p.manualConfirm.key === key ? p.manualConfirm : null;
    if (similar.length && (!confirmed || sameKey.some(id => !confirmed.ids.includes(id)))) {
      p.manualConfirm = { key, ids: sameKey };
      const note = document.getElementById('libraryManualNote');
      if (note) note.innerHTML = `<div class="tmdb-refresh-summary">“${esc(similar[0].title)}” is already on your list${similar.length > 1 ? ` (${similar.length} times)` : ''}. Add a season to it, or add a separate new show? Nothing is merged.</div>
        <div class="tmdb-preview-actions" style="flex-wrap:wrap">${similar.map(s => `<button class="btn" onclick="openAddSeason('${esc(s.id)}')">Add a season to “${esc(s.title)}”${similar.length > 1 ? ` (${esc(statusOptionLabel(s.status))})` : ''}</button>`).join('')}
        <button class="btn" onclick="libraryManualShow()">Add as a new show</button></div>`;
      return;
    }
    libraryClearManualNote(p); // the question is answered: sent once with the records it listed
    await libraryNewShow(ctx, { tmdb_id: null, title, show_key: showKey, network: theme, distinct_from: sameKey },
      [{ item_key: key, title, season, theme, display_date: date, date_sort: parseDate(date) }]);
  } finally {
    if (libraryPanel === p) p.busy = false;
  }
}

function libraryClearManualNote(p) {
  p.manualConfirm = null;
  const note = document.getElementById('libraryManualNote');
  if (note) note.innerHTML = '';
}

async function libraryManualFilm() {
  const p = libraryPanel;
  if (!p || p.busy) return;
  const title = libraryVal('nTitle'), theme = libraryVal('nTheme'), date = libraryVal('nDate');
  if (!title || !date) { libraryReport(libraryContext(), 'Please fill in the title and release date.', true); return; }
  const ctx = libraryContext();
  p.busy = true;
  try {
    let lib;
    try { lib = await readLibrary(); }
    catch (e) { libraryReport(ctx, `Couldn’t read your whole list (${e.message}), so nothing was added.`, true); return; }
    if (!libraryLive(ctx.session)) return;
    p.lib = lib;
    const key = `${title.toLowerCase()}|film`;
    const similar = [...new Map([...lib.rows.filter(r => isFilmRow(r) && String(r.title || '').trim().toLowerCase() === title.toLowerCase()),
      ...librarySimilarFilms(lib, title, key)].map(r => [r.id, r])).values()];
    const sameKey = libraryIds(similar); // what "Add as a new film" acknowledges
    const confirmed = p.manualConfirm && p.manualConfirm.key === key ? p.manualConfirm : null;
    if (similar.length && (!confirmed || sameKey.some(id => !confirmed.ids.includes(id)))) {
      p.manualConfirm = { key, ids: sameKey };
      const note = document.getElementById('libraryManualNote');
      if (note) note.innerHTML = `<div class="tmdb-refresh-summary">A film called “${esc(similar[0].title)}” is already on your list. Add another one anyway? Nothing is merged.</div>
        <div class="tmdb-preview-actions"><button class="btn" onclick="libraryManualFilm()">Add as a new film</button></div>`;
      return;
    }
    libraryClearManualNote(p);
    // A film is labelled 'Film' (All Movies lists exactly those and identified films).
    await libraryAddFilm(ctx, { item_key: key, title, season: 'Film', theme, display_date: date,
      date_sort: parseDate(date), watched: false, status: 'confirmed' }, sameKey);
  } finally {
    if (libraryPanel === p) p.busy = false;
  }
}

// ─── Add a season to one show ─────────────────────────────────────────────────
// From All TV ("Add season…") or a search result. The show's kind decides the
// path (showAddKind); the show is bound as shown and checked again by the database.
function openAddSeason(showId) {
  if (!activeViewId) return;
  if (!libraryPanel || libraryPanel.media !== 'tv') openLibraryPanel('tv', 'season', { seasonShowId: showId });
  else {
    if (window.__tmdbMatch) window.__tmdbMatch = null;
    cancelTMDBPreview();
    Object.assign(libraryPanel, { mode: 'season', seasonShowId: showId, seasonDetails: null, bound: null, choice: null });
    renderLibraryPanel();
  }
}

function librarySeasonShow() {
  const p = libraryPanel;
  return p && p.lib ? p.lib.showsById.get(p.seasonShowId) || null : null;
}

function librarySeasonHtml() {
  const p = libraryPanel;
  if (p.libState !== 'ready') return `<div class="tmdb-loading">${p.libState === 'failed' ? 'Your list couldn’t be read (Retry above).' : 'Checking your list…'}</div>`;
  const show = librarySeasonShow();
  if (!show) return '<div class="tmdb-no-results">This show is no longer on your list.</div>';
  const seasons = p.lib.rows.filter(r => r.show_id === show.id).sort(compareSeasons);
  const have = `<div class="tmdb-refresh-summary">On your list: ${seasons.map(r => esc(r.season)).join(', ') || 'no seasons'}.</div>`;
  if (showAddKind(show) === 'tmdb') {
    if (!p.seasonDetails) { libraryLoadSeasonDetails(p.session, show); return `<div class="tmdb-preview-title">${esc(show.title)}</div>${have}<div class="tmdb-loading">Loading seasons from TMDB…</div>`; }
    if (p.seasonDetails.error) return `<div class="tmdb-preview-title">${esc(show.title)}</div>${have}<div class="tmdb-no-results">Couldn’t load its seasons from TMDB (${esc(p.seasonDetails.error)}).</div>`;
    const network = (p.seasonDetails.networks && p.seasonDetails.networks[0]?.name) || seasons[0]?.theme || '';
    p.bound = { kind: 'season-tmdb', showId: show.id, expected: libraryExpected(show, network) };
    const rows = (p.seasonDetails.seasons || []).slice().sort((a, b) => a.season_number - b.season_number).map(s => {
      const done = seasons.some(r => r.season_number === s.season_number);
      return `<div class="tmdb-season-row ${done ? 'already-added' : ''}">
        <input type="checkbox" ${done ? 'disabled' : ''} data-season="${s.season_number}">
        <span class="tmdb-season-name">${esc(librarySeasonLabel(s.season_number))}</span>
        <span class="tmdb-season-meta">${s.episode_count || 0} episodes · ${esc(s.air_date ? formatDisplayDate(s.air_date) : 'TBA')}</span>
        ${done ? '<span class="tmdb-already-tag">Already added</span>' : ''}</div>`;
    }).join('');
    return `<div class="tmdb-preview" id="librarySeasonPick"><div class="tmdb-preview-title">${esc(show.title)}</div>${have}
      <div class="tmdb-refresh-summary">Seasons of this show come from TMDB. Choose the ones to add:</div>${rows || '<div class="tmdb-no-results">TMDB lists no seasons.</div>'}
      <div class="tmdb-preview-actions"><button class="btn btn-accent" onclick="librarySubmitSeason()">Add to “${esc(show.title)}”</button></div></div>`;
  }
  const listed = catalogListingOf(show);
  p.bound = { kind: 'season-label', showId: show.id, expected: libraryExpected(show, '') };
  const theme = seasons.length ? seasons[seasons.length - 1].theme : '';
  return `<div class="tmdb-preview"><div class="tmdb-preview-title">${esc(show.title)}</div>${have}
    <div class="tmdb-refresh-summary">${show.tmdb_id != null ? 'This show is matched to TMDB: a plain “Season N” becomes its TMDB season N; any other label is held for review.' : 'This show isn’t matched to TMDB; the season is added by its label.'}${listed ? ` The ${esc(listed)} catalog governs this show.` : ''}</div>
    <div class="add-form-grid">
      <div><label>Season</label><input id="nSeason" type="text" placeholder="e.g. Season 2"></div>
      <div><label>Premiere date</label><input id="nDate" type="text" placeholder="e.g. Jan 12, 2027 or TBA 2027"></div>
      <div><label>Theme / network</label><input id="nTheme" type="text" value="${esc(theme)}"></div>
      <button class="btn btn-accent" onclick="librarySubmitSeason()">Add to “${esc(show.title)}”</button>
    </div></div>`;
}

async function libraryLoadSeasonDetails(session, show) {
  try {
    const d = await tmdbFetch(`/tv/${show.tmdb_id}`);
    noteSeasonEpisodeCounts(show.tmdb_id, d && d.seasons); // EP1: totals for collapsed seasons (episodes.js)
    noteShowRating(show.tmdb_id, d); // item 2: the show's TMDB score (show-ratings.js)
    if (!libraryLive(session) || libraryPanel.seasonShowId !== show.id) return;
    libraryPanel.seasonDetails = d;
  } catch (e) {
    if (!libraryLive(session) || libraryPanel.seasonShowId !== show.id) return;
    libraryPanel.seasonDetails = { error: e.message };
  }
  renderLibraryBody();
}

async function librarySubmitSeason() {
  const p = libraryPanel;
  if (!p || p.mode !== 'season' || !p.bound || p.busy) return;
  const bound = p.bound, ctx = libraryContext();
  let make;
  if (bound.kind === 'season-tmdb') {
    const pick = document.getElementById('librarySeasonPick');
    const nums = [];
    (pick ? pick.querySelectorAll('input[type="checkbox"][data-season]') : []).forEach(cb => { if (cb.checked && !cb.disabled) nums.push(parseInt(cb.dataset.season, 10)); });
    if (!nums.length) return;
    const byNum = new Map((p.seasonDetails.seasons || []).map(s => [s.season_number, s]));
    make = show => nums.filter(n => byNum.has(n)).map(n => libraryTmdbSeason(show, byNum.get(n), bound.expected.network));
  } else {
    const label = libraryVal('nSeason'), date = libraryVal('nDate'), theme = libraryVal('nTheme');
    if (!label || !date) { libraryReport(ctx, 'Please fill in the season and premiere date.', true); return; }
    if (label === 'Film') { libraryReport(ctx, 'A film isn’t a season; add films in Movies.', true); return; }
    make = show => [libraryLabelSeason(show, label, date, theme)];
  }
  p.busy = true;
  try {
    let lib;
    try { lib = await readLibrary(); }
    catch (e) { libraryReport(ctx, `Couldn’t read your whole list (${e.message}), so nothing was added.`, true); return; }
    if (!libraryLive(ctx.session)) return;
    p.lib = lib;
    const show = lib.showsById.get(bound.showId);
    if (!show || JSON.stringify(libraryExpected(show, bound.expected.network)) !== JSON.stringify(bound.expected)) {
      libraryReport(ctx, 'This show changed or is gone since you opened it, so nothing was added. Look at it again.', true);
      renderLibraryBody();
      return;
    }
    await librarySendToShow(ctx, show, make(show), bound.expected.network);
  } finally {
    if (libraryPanel === p) p.busy = false;
  }
}

// ─── Refresh shows ────────────────────────────────────────────────────────────
// Library-wide and TMDB only since item 4: collection-updates.js cuRefreshShows.

// ─── Movie tools (Refresh collections, MCU, person collections, Pull rest) ────
// The tools add films (genre themes, theme_kind 'genre') and run in All Movies on a
// complete library read; they report in the panel.
function toolCollectionId() {
  return libraryPanel && libraryPanel.media === 'movie' && libraryPanel.viewId === activeViewId && libraryPanel.toolsReady ? TOOL_FILMS : null;
}

// The tool's context: still current while the same panel is open in the same view (a
// restore closes the panel and clears the tool's cache, backup-restore.js).
function toolContext(collectionId) {
  return { collectionId, session: libraryPanel ? libraryPanel.session : 0, viewId: activeViewId };
}

function toolContextLive(t) {
  return libraryLive(t.session);
}

// After a tool's write: the open view is read again.
function toolFinished(t) {
  if (activeViewId === t.viewId) return reloadOpenView();
  return null;
}

// Rows a tool adds go into its cache (while it is still the cache the tool read).
function toolCachePush(t, rows) {
  if (!rows || !toolContextLive(t)) return;
  const td = tabData[t.collectionId];
  if (td) {
    td.rows.push(...rows); td.rows.sort((a, b) => a.date_sort.localeCompare(b.date_sort));
    if (td.known) td.known.push(...rows);
  }
}

// What a tool compares a TMDB film with to say "already added": the films whose
// theme is a genre (the old Movies list: by TMDB identity, or by name for its
// unmatched films) plus every TMDB-identified film anywhere. Tag backfills touch
// only the first group (td.rows), as before.
function toolKnownRows(collectionId) {
  const td = tabData[collectionId];
  return (td && (td.known || td.rows)) || [];
}

// One film a movie tool adds (Pull collection, Refresh collections, a person or a universe
// pull), from its TMDB details: titled as the tool listed it, with a genre theme (theme_kind
// 'genre'), To Watch and unwatched. tmdbCollection: the TMDB collection it belongs to
// ({ id, name }) or none; collections: its collection tags.
function toolFilmRow(details, title, tmdbId, tmdbCollection, collections) {
  return {
    item_key: `${title.toLowerCase().trim()}|film`,
    title,
    season: 'Film',
    theme: (details.genres && details.genres[0]?.name) || 'Film',
    display_date: details.release_date ? formatDisplayDate(details.release_date) : 'TBA',
    date_sort: details.release_date || '2099-01-01',
    watched: false,
    status: 'confirmed',
    ...creationMetadata('movie', details, title),
    tmdb_collection_id: tmdbCollection ? tmdbCollection.id : null,
    tmdb_collection_name: tmdbCollection ? tmdbCollection.name : null,
    collections,
    media_type: 'movie',
    tmdb_id: tmdbId,
    season_number: null
  };
}

// Films added by a tool, through library_add_films: each one inserted, or reported
// as already on the list (added elsewhere meanwhile); never changed, never twice.
async function libraryInsertFilms(rows) {
  const res = await sbRpc('library_add_films_b45', { p_films: rows });
  const existing = (res.results || []).filter(x => x.outcome === 'existing').length;
  const twins = (res.results || []).filter(x => x.outcome === 'catalog_candidate').map(x => rows[x.index] && rows[x.index].title).filter(Boolean);
  const notes = [];
  if (existing) notes.push(`${existing} of these ${existing === 1 ? 'film was' : 'films were'} already on your list (added somewhere else meanwhile), so ${existing === 1 ? 'it wasn’t' : 'they weren’t'} added again.`);
  if (twins.length) notes.push(`Not added: ${twins.join(', ')} — a built-in catalog film with the same name is on your list (it may be the same film). If it’s a different film, add it from Search.`);
  // §5.2: what TMDB sourcing left out is named, never guessed.
  const sourcing = takeSourcingNote((res.inserted || []).map(r => r.title));
  if (sourcing) notes.push(sourcing);
  if (notes.length) showNotice(notes.join(' '));
  return res.inserted || [];
}

// A tool runs only on a complete read of the whole library (strict paging and
// counts, with the governance); a failed or incomplete read lets nothing be imported.
async function libraryPrepareMovieTools() {
  const p = libraryPanel;
  if (!p || p.media !== 'movie') return false;
  const session = p.session;
  p.toolsReady = false;
  delete tabData[TOOL_FILMS];
  let all;
  try { all = (await readLibrary()).rows; }
  catch (e) {
    if (libraryLive(session)) libraryReport(libraryContext(), `Couldn’t read your whole list (${e.message}), so this tool can’t run right now. Nothing was changed.`, true);
    return false;
  }
  if (!libraryLive(session)) return false;
  const own = all.filter(r => isFilmRow(r) && filmThemeKindOf(r) === 'genre').sort((a, b) => String(a.date_sort).localeCompare(String(b.date_sort)));
  const elsewhere = all.filter(r => !own.includes(r) && r.media_type === 'movie' && r.tmdb_id != null);
  tabData[TOOL_FILMS] = { rows: own, loaded: true, newKeys: [], known: own.concat(elsewhere) };
  p.toolsReady = true;
  return true;
}

async function libraryMovieTool(which, arg) {
  if (!libraryPanel || libraryPanel.media !== 'movie') return;
  if (!await libraryPrepareMovieTools()) return;
  if (which === 'collections') return refreshCollections();
  if (which === 'mcu') return pullUniverse('mcu');
  if (which === 'person') return togglePersonCollectionPrompt();
  if (which === 'person-refresh') return refreshPersonCollection(arg);
}

// The ↻ Refresh link beside All Movies' collection-tag filter (a person collection).
async function libraryRefreshPerson(name) {
  if (activeViewId !== ALL_MOVIES_VIEW.id) return;
  openLibraryPanel('movie', 'tools');
  return libraryMovieTool('person-refresh', name);
}

// From a film's ⋯ menu in All Movies or (S4) a collection (a film whose theme is a genre): its
// franchise. In a collection the panel shows only this preview (the general tools stay in Movies),
// and the films it adds go to the library, not to the collection (collection-members.js reports it).
async function libraryPullRest(rowId, collectionId, name) {
  const inCollection = isBrowseCollectionView(activeViewId);
  if (activeViewId !== ALL_MOVIES_VIEW.id && !inCollection) return;
  openLibraryPanel('movie', inCollection ? 'pull' : 'tools', inCollection ? { pullName: name } : {});
  if (!await libraryPrepareMovieTools()) return;
  return openPullCollection(rowId, collectionId, name);
}

// ─── Delete or skip from a view ───────────────────────────────────────────────
// The editing rules (editPolicyOf): a catalog TV season is skipped, a catalog film
// gets status Skipped after a confirmation, anything else is
// deleted after a confirmation (a TV season through delete_tv_season, which also
// removes a show left empty). The row leaves the view at once and comes back if
// the delete is refused; an unclear answer is reported as such, never as done.
// D6 (S3): the confirmation is an in-page dialog named by its effect (askEffect). What the page
// showed is checked again after the answer: if the view, the row or its editing
// rule changed while the question was open, nothing is sent. In a collection a confirmed delete reads
// the collection again (its last season takes the show and its memberships with it).
async function delRowInView(id) {
  const rows = actionRows();
  const row = rows.find(r => r.id === id);
  if (!row) return;
  const policy = editPolicyOf(row);
  if (policy.deleteEffect === 'unknown') {
    showNotice(`This page couldn’t confirm whether “${row.title}” is a built-in catalog entry, so nothing was deleted. The list has been read again; try again.`);
    if (typeof reloadOpenView === 'function') reloadOpenView();
    return;
  }
  if (policy.deleteEffect === 'skip') { await setSeasonSkipped(id, true); return; }
  const viewId = activeViewId;
  // After the answer: the same view, the row still listed, its rule unchanged (D6).
  const stillAsShown = () => {
    if (activeViewId !== viewId) return null;
    const now = actionRows().find(r => r.id === id);
    if (now && editPolicyOf(now).deleteEffect === policy.deleteEffect) return now;
    showNotice(`“${row.title}” changed while the question was open, so nothing was changed. The list has been read again.`);
    reloadOpenView();
    return null;
  };
  if (policy.deleteEffect === 'skip-film') {
    // The film contract (B5): Skip is an explicit status choice; on a watched film it also clears Watched.
    if (!await askEffect(`Skip “${row.title}”? It’s part of a built-in catalog, so it is marked Skipped rather than deleted.${row.watched ? ' This also clears Watched.' : ''}`, 'Skip film')) return;
    const now = stillAsShown();
    if (now) await sendFilmState(now, { state: 'skipped' });
    return;
  }
  const show = isTvSeason(row) ? showOfRow(row) : null;
  const what = isTvSeason(row) ? `“${row.title}” · ${row.season}` : `“${row.title}”`;
  // EP1: the marks the dialog names go with the request; the database refuses another count.
  const marksShown = isTvSeason(row) ? episodeMarkCount(row.id) : 0;
  if (!await askEffect(deleteEffectText(row, show), 'Delete from library')) return;
  const current = stillAsShown();
  if (!current) return;
  return deleteFromLibrary(current, viewId, what, marksShown);
}

// D6 (S3): what a delete from the library does, in the dialog's words. A season is named by its
// show; "last season" is what this page's read shows (the database decides, and the answer says so).
function deleteEffectText(row, show) {
  // S4: in a collection the dialog also points to Remove, which changes only that collection.
  const dest = isBrowseCollectionView(activeViewId) ? currentBrowseDest() : null;
  if (!isTvSeason(row)) return `Delete “${row.title}” from your library? It is removed everywhere: All Movies and every collection it’s in.`
    + (dest ? ` To keep it but take it out of ${dest.label} only, use Remove from ${dest.label} instead.` : '');
  const title = show ? show.title : row.title;
  const last = !actionRows().some(r => r.id !== row.id && r.show_id && r.show_id === row.show_id);
  // A season that starts or bounds its show's earlier-seasons range: deleting it ends that choice (§4.7.5).
  const endsRange = !!show && (show.resume_start_season_id === row.id || show.resume_end_season_id === row.id);
  const marks = episodeMarkCount(row.id);
  return `Delete “${title} · ${row.season}” from your library? It is removed everywhere: All TV, Currently Watching and every collection it’s in.`
    + (marks ? ` Its ${marks} episode mark${marks === 1 ? ' is' : 's are'} deleted with it.` : '')
    + (last ? ' This is the show’s last season, so the show is deleted too, along with its place in every collection.' : '')
    // CU1: Refresh shows adds a season TMDB still lists, so a deleted matched season comes back; Skip keeps it unwatched.
    + (!last && row.tmdb_id != null && row.season_number != null ? ' While TMDB still lists this season, Refresh shows will add it again. To keep it without it counting as something to watch, use Skip instead.' : '')
    + (endsRange ? ` The earlier-seasons choice for “${show.title}” ends too.` : '')
    + (dest ? ` To keep it but take the show out of ${dest.label} only, use Remove show from ${dest.label} instead.` : '');
}

async function deleteFromLibrary(row, viewId, what, marksShown = 0) {
  await runWrite(`Delete ${what}`, async () => {
    const id = row.id;
    const rows = actionRows();
    const idx = rows.indexOf(row);
    if (idx >= 0) rows.splice(idx, 1);
    renderTable();
    try {
      if (isTvSeason(row)) {
        try {
          const res = await sbRpc('delete_tv_season', { p_row_id: id, p_marks_expected: marksShown });
          if (res && res.show_deleted) tvShowsById.delete(res.show_id);
          episodeMarks.delete(id); // its marks went with it (EP1)
        } catch (e) {
          if (!String(e.message).includes('not_found:')) throw e; // already gone counts as deleted
        }
      } else {
        await sbFetch('DELETE', `${TABLE}?id=eq.${id}`, null);
      }
      Object.values(tabData).forEach(td => { if (td && td.rows) td.rows = td.rows.filter(r => r.id !== id); });
      showSaved();
      if (activeViewId === viewId) {
        if (isBrowseCollectionView(viewId)) await reloadOpenView(); // the collection's members may have changed (S3)
        else renderTable();
      }
    } catch (e) {
      const info = orgErrorInfo(e);
      if (info.kind === 'database' && idx >= 0 && activeViewId === viewId && actionRows() === rows) rows.splice(idx, 0, row);
      // An unclear answer: the view is read again (that clears the error line, so it is reported after).
      if (activeViewId === viewId) { if (info.kind === 'database') renderTable(); else await reloadOpenView(); }
      showError(info.kind === 'database'
        ? `Couldn’t delete ${what}: ${info.message}. Nothing was changed.`
        : `The delete of ${what} was sent, but no clear answer came back (${info.message}). Reload and check before deleting again.`);
    }
  }, { list: true });
}

// ─── Effect-named confirmations (D6, S3) ──────────────────────────────────────
// One in-page dialog (effectModalOverlay, watchlist.html) whose buttons name the effect. Cancel has
// the default focus; Escape cancels; Tab stays on its two buttons; focus returns to the control that
// opened it. One at a time (a second question while one is open is answered Cancel), and leaving the
// view answers Cancel (tabs.js switchView). Resolves true only for the effect button.
let effectDialog = null; // { resolve, opener }
function askEffect(text, confirmLabel) {
  if (effectDialog) return Promise.resolve(false);
  const overlay = document.getElementById('effectModalOverlay');
  const box = document.getElementById('effectModalBox');
  if (!overlay || !box) return Promise.resolve(false);
  // S4: a question asked from a film's ⋯ menu returns focus to that row's ⋯ button: the menu itself is
  // closed by the click that answers the question, which would leave focus nowhere.
  let opener = document.activeElement || null;
  const menu = opener && typeof opener.closest === 'function' ? opener.closest('.more-popover') : null;
  const row = menu ? menu.closest('.more-cell, .card-top') : null;
  const more = row ? row.querySelector('.more-btn') : null;
  if (more) opener = more;
  return new Promise(resolve => {
    effectDialog = { resolve, opener };
    box.innerHTML = `<p class="effect-text" id="effectModalText">${esc(text)}</p>
      <div class="modal-actions"><button class="btn" id="effectCancel" onclick="answerEffectDialog(false)">Cancel</button>
        <button class="btn btn-danger" id="effectConfirm" onclick="answerEffectDialog(true)">${esc(confirmLabel)}</button></div>`;
    overlay.style.display = 'flex';
    const cancel = document.getElementById('effectCancel');
    if (cancel && typeof cancel.focus === 'function') cancel.focus();
  });
}
function answerEffectDialog(ok, returnFocus = true) {
  const d = effectDialog;
  if (!d) return;
  effectDialog = null;
  const overlay = document.getElementById('effectModalOverlay');
  const box = document.getElementById('effectModalBox');
  if (overlay) overlay.style.display = 'none';
  if (box) box.innerHTML = '';
  if (returnFocus) returnDialogFocus(d.opener, null);
  d.resolve(!!ok);
}
function cancelEffectDialog() {
  answerEffectDialog(false, false);
}
function effectDialogKeydown(e) {
  if (!e || !effectDialog) return;
  if (e.key === 'Escape') { if (typeof e.preventDefault === 'function') e.preventDefault(); answerEffectDialog(false); return; }
  if (e.key !== 'Tab') return;
  const buttons = ['effectCancel', 'effectConfirm'].map(id => document.getElementById(id)).filter(Boolean);
  if (buttons.length < 2) return;
  const at = buttons.indexOf(document.activeElement);
  const next = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
  if (typeof e.preventDefault === 'function') e.preventDefault();
  if (typeof buttons[next].focus === 'function') buttons[next].focus();
}
