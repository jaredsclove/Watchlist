// ─── The library without sources (Stage 4b) ───────────────────────────────────
// Everything is reached from TV (Currently Watching, All TV, Coming Soon), Movies
// (All Movies) and Browse; the old storage tabs are gone from the page. Where a
// record is stored (its `collection`, the old tab) stays in the database but is
// internal: this file is the only place the interface asks about it, and its rules
// below are exactly the ones the tabs had. Nothing here moves, merges or
// reclassifies a record.
//
// Adding: the "+ Add" panel searches TMDB or takes an entry by hand. Before
// anything is sent it reads the whole library (complete reads, or nothing is
// sent) and decides where the addition goes:
//   * a show already on the list gets its seasons through the database function
//     add_tv_seasons_to_show, which refuses (and writes nothing) if that show is
//     gone or changed, instead of creating another one;
//   * a genuinely new show goes to the internal place for new shows (LIBRARY_NEW_TV)
//     through add_tv_seasons, a new film to LIBRARY_NEW_FILM;
//   * an identity found more than once, or only a matching title, is shown and the
//     user chooses; nothing is merged or guessed.
// Results are never merged into what the page shows: the open view is read again
// (only while it is still the view and the restore epoch the request started in).
// Collections are a separate, optional step after a creation, reported separately.

const LIBRARY_BUILTIN = ['disney', '90day', 'sheridan'];
const LIBRARY_NEW_TV = 'othertv';
const LIBRARY_NEW_FILM = 'movies';

function libraryStorageLabel(id) {
  return COLLECTIONS.find(c => c.id === id)?.label || id;
}

// ─── Editing rules (exactly what the tabs did) ────────────────────────────────
// × on a row of the page's built-in catalog skips it (a TV season: the season's
// skip flag; a film: its status) and never deletes it; anything else is deleted
// after a confirmation. Match only for an unidentified row outside the built-in
// catalogs (isTmdbMatchEligible).
function editPolicyOf(r) {
  const isDefault = isDefaultRow(r);
  return { isDefault, matchable: isTmdbMatchEligible(r), deleteEffect: isDefault ? (isTvSeason(r) ? 'skip' : 'skip-film') : 'delete' };
}

// How seasons are added to a show already on the list: 'tmdb' (TMDB seasons) for
// an identified show outside the built-in catalogs; 'label' (by label) for an
// identified built-in show (a plain "Season N" becomes TMDB season N, any other
// label is held for review) and for a show without a TMDB identity.
function showAddKind(show) {
  return show.tmdb_id != null && !LIBRARY_BUILTIN.includes(show.collection) ? 'tmdb' : 'label';
}

// A hint only: the page's catalog has an entry for this show. Being stored with a
// built-in catalog doesn't mean the catalog covers it.
function catalogListingOf(show) {
  if (!LIBRARY_BUILTIN.includes(show.collection)) return null;
  const listed = catalogDefaultsOf(show.collection).some(d => d.s !== 'Film' && tvShowKey(show.collection, d.k) === show.show_key);
  return listed ? libraryStorageLabel(show.collection) : null;
}

// The show as the page shows it: the database refuses if it no longer matches.
function libraryExpected(show, network) {
  return { collection: show.collection, tmdb_id: show.tmdb_id ?? null, show_key: show.show_key, network: network || '' };
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

// A season by label for a show (its stored show key: the database finds the show by it).
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
// Every row and every show, complete or not at all (fetchAllRowsStrict). It is a
// read, not a lock: something can change between it and a write, which is why
// additions to an existing show are checked again by the database.
async function readLibrary() {
  const [rows, shows] = await Promise.all([fetchAllRowsStrict(TABLE), fetchAllRowsStrict('tv_shows')]);
  return { rows, shows, showsById: new Map(shows.map(s => [s.id, s])) };
}

// Where a TMDB series goes. existing: one show has this identity; ambiguous: more
// than one; similar: none has it, but unidentified shows have the same title; new.
function routeTvResult(lib, tmdbId, name) {
  const same = lib.shows.filter(s => s.tmdb_id === tmdbId);
  if (same.length > 1) return { kind: 'ambiguous', candidates: same };
  if (same.length === 1) return { kind: 'existing', show: same[0] };
  const t = String(name || '').trim().toLowerCase();
  const similar = lib.shows.filter(s => s.tmdb_id == null && String(s.title || '').trim().toLowerCase() === t);
  return similar.length ? { kind: 'similar', candidates: similar } : { kind: 'new' };
}

// Where a TMDB film goes: present (the identity is already saved, anywhere),
// similar (an unidentified film with the same title), or new.
function routeFilmResult(lib, tmdbId, title) {
  const films = lib.rows.filter(isFilmRow);
  const same = films.filter(r => r.media_type === 'movie' && r.tmdb_id === tmdbId);
  if (same.length) return { kind: 'present', rows: same };
  const t = String(title || '').trim().toLowerCase();
  const similar = films.filter(r => r.tmdb_id == null && String(r.title || '').trim().toLowerCase() === t);
  return similar.length ? { kind: 'similar', rows: similar } : { kind: 'new' };
}

// ─── Duplicates (the one place storage is shown) ──────────────────────────────
// Two records with one TMDB identity are never merged automatically; the marker
// says so and its tooltip names where each one is stored.
function duplicateShowTagHtml(show) {
  if (!show || show.tmdb_id == null) return '';
  const same = [...tvShowsById.values()].filter(s => s.tmdb_id === show.tmdb_id);
  if (same.length < 2) return '';
  const where = same.map(s => libraryStorageLabel(s.collection)).join(', ');
  return `<span class="dup-tag" title="${esc(`${same.length} records on your list have this TMDB identity (stored under: ${where}). They are not merged automatically.`)}">Duplicate on your list</span>`;
}

function duplicateFilmTagHtml(r, rows) {
  if (!r || r.media_type !== 'movie' || r.tmdb_id == null) return '';
  const same = (rows || []).filter(x => x.media_type === 'movie' && x.tmdb_id === r.tmdb_id);
  if (same.length < 2) return '';
  const where = same.map(x => libraryStorageLabel(x.collection)).join(', ');
  return `<span class="dup-tag" title="${esc(`${same.length} records on your list have this TMDB identity (stored under: ${where}). They are not merged automatically.`)}">Duplicate on your list</span>`;
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
function reloadOpenView() {
  if (isBrowseView(activeViewId)) loadBrowseView();
  else if (activeViewId) loadDerivedView();
}

// What a write started from: answers are used only while the same view (and panel)
// is open and no restore has happened since.
function libraryContext() {
  return { session: libraryPanel ? libraryPanel.session : 0, viewId: activeViewId, epoch: orgEpoch };
}

function libraryLive(session) {
  return !!libraryPanel && libraryPanel.session === session && libraryPanel.viewId === activeViewId && libraryPanel.epoch === orgEpoch;
}

// After a confirmed answer: false (nothing published) when a restore came in
// between — the answer is discarded and the view read again.
function libraryAnswerCurrent(ctx, title) {
  if (ctx.epoch === orgEpoch) return true;
  showNotice(`An addition sent before the restore (“${title}”) answered afterwards. The list has been read again. This doesn’t show whether the addition ran before or after the restore; check “${title}” before adding it again.`);
  if (activeViewId) reloadOpenView();
  return false;
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

// A failed request: unknown (no clear answer: it may still have happened), or a
// refusal (nothing was written by this call).
function libraryFailure(e, what, feature = 'Adding to an existing show') {
  const info = orgErrorInfo(e);
  if (info.kind !== 'database') {
    return { unknown: true, text: `${what}: no clear answer came back (${info.message}), so it isn’t confirmed. The list may or may not show it now, and an earlier request may still complete. Check before adding again. If you reload, this page won’t know whether that request finished.` };
  }
  if (info.status === 404 && info.pgCode === 'PGRST202') return { text: `${feature} isn’t available on this database. Nothing was added.` };
  if (/^(target_missing|target_changed|show_exists|create_conflict)$/.test(info.code)) return { text: orgRefusalText(info) };
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

// The answer of add_tv_seasons / add_tv_seasons_to_show, item by item.
function libraryAddText(res, title) {
  const inserted = (res.inserted || []).map(r => `“${r.season}”`);
  const parts = [inserted.length ? `Added ${libraryList(inserted)} to “${title}”.` : `Nothing new was added to “${title}”.`];
  const existing = (res.existing || []).length;
  if (existing) parts.push(`${existing} ${existing === 1 ? 'season was' : 'seasons were'} already on your list.`);
  for (const x of res.rejected || []) parts.push(`“${x.season || x.item_key}” wasn’t added: ${LIBRARY_REVIEW_TEXT[x.reason] || x.reason}.`);
  if (res.reopened) parts.push(`“${title}” was Complete and is back On List.`);
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
  libraryPanel = { session: ++libraryPanelSeq, media, mode, viewId: activeViewId, epoch: orgEpoch, lib: null, libState: 'reading',
    libError: '', choice: null, bound: null, seasonShowId: null, seasonDetails: null, refresh: null, manualConfirm: null, ...extra };
  renderLibraryPanel();
  libraryLoad(libraryPanel.session);
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
  const title = p.media === 'movie' ? 'Add films' : 'Add TV';
  el.style.display = 'block';
  el.innerHTML = `<div class="library-head">
      <strong>${title}</strong>
      <div class="view-toggle" role="group" aria-label="How to add">${modes}</div>
      <button class="btn" onclick="closeLibraryPanel()">Close</button>
    </div>
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
      <input id="tmdbQuery" type="text" placeholder="${p.media === 'movie' ? 'Search for a film…' : 'Search for a show…'}" onkeydown="if(event.key==='Enter'){searchTMDB();}">
      <button class="btn btn-accent" onclick="searchTMDB()">Search</button>
    </div>`;
  const results = '<div id="tmdbResults"></div><div id="tmdbPreview"></div>';
  if (p.mode === 'search') el.innerHTML = searchRow + results;
  else if (p.mode === 'match') el.innerHTML = results;
  else if (p.mode === 'manual') el.innerHTML = p.media === 'movie' ? libraryManualFilmHtml() : libraryManualShowHtml();
  else if (p.mode === 'refresh') el.innerHTML = `<div class="tmdb-search-row"><button class="btn" onclick="libraryRefreshShows()">↻ Check for new seasons</button>
      <span class="tmdb-refresh-summary">Shows matched to TMDB whose seasons come from TMDB.</span></div>${results}`;
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
      previewEl.innerHTML = `<div class="tmdb-preview">${header(meta)}<div class="tmdb-refresh-summary">Already on your list${route.rows.length > 1 ? ` (${route.rows.length} records — see “Duplicate on your list” in All Movies)` : ''}. Nothing to add.</div>${actions('', '')}</div>`;
      return;
    }
    if (route.kind === 'similar') {
      p.bound = null;
      previewEl.innerHTML = `<div class="tmdb-preview">${header(meta)}<div class="tmdb-refresh-summary">A film called “${esc(route.rows[0].title)}” is already on your list, not matched to TMDB. It may be the same film; nothing is merged.</div>
        <div class="tmdb-preview-actions"><button class="btn" onclick="libraryChoose(${sel.id}, 'movie', null, true)">Add as a new film anyway</button><button class="btn" onclick="cancelTMDBPreview()">Cancel</button></div></div>`;
      return;
    }
    p.bound = { kind: 'new-film', tmdbId: sel.id, mediaType: 'movie' };
    previewEl.innerHTML = `<div class="tmdb-preview">${header(meta)}
      ${d.belongs_to_collection ? `<div class="tmdb-collection-note">🔗 Part of <strong>${esc(cleanCollectionName(d.belongs_to_collection.name))}</strong> — you can pull the rest of it from the film’s ⋯ menu afterwards.</div>` : ''}
      <div class="tmdb-refresh-summary">Adds a new film to your list.</div>${actions('Add film', 'addSelectedTMDBSeasons()')}</div>`;
    return;
  }

  const details = sel.details;
  const network = (details.networks && details.networks[0]?.name) || 'Unknown';
  let route = routeTvResult(p.lib, sel.id, sel.name);
  if (choice && choice.showId) {
    const s = p.lib.showsById.get(choice.showId);
    route = s ? { kind: 'existing', show: s } : route;
  } else if (choice && choice.asNew && route.kind === 'similar') route = { kind: 'new' };

  if (route.kind === 'ambiguous') {
    p.bound = null;
    previewEl.innerHTML = `<div class="tmdb-preview">${header(network)}<div class="tmdb-refresh-summary">This show is on your list more than once (nothing is merged automatically). Choose which one to add seasons to:</div>
      ${route.candidates.map(s => `<div class="tmdb-season-row"><span class="tmdb-season-name">${esc(s.title)}</span>
        <span class="tmdb-season-meta">${esc(statusOptionLabel(s.status))} · ${p.lib.rows.filter(r => r.show_id === s.id).length} seasons · stored under ${esc(libraryStorageLabel(s.collection))}</span>
        <button class="btn" onclick="libraryChoose(${sel.id}, 'tv', '${esc(s.id)}')">Use this one</button></div>`).join('')}${actions('', '')}</div>`;
    return;
  }
  if (route.kind === 'similar') {
    p.bound = null;
    const s = route.candidates[0];
    previewEl.innerHTML = `<div class="tmdb-preview">${header(network)}<div class="tmdb-refresh-summary">“${esc(s.title)}” is already on your list, not matched to TMDB. It may be the same show; nothing is merged.</div>
      <div class="tmdb-preview-actions" style="flex-wrap:wrap">
        <button class="btn" onclick="openAddSeason('${esc(s.id)}')">Add a season to “${esc(s.title)}” by hand</button>
        <button class="btn" onclick="libraryChoose(${sel.id}, 'tv', null, true)">Add as a new show</button>
        <button class="btn" onclick="cancelTMDBPreview()">Cancel</button></div></div>`;
    return;
  }
  if (route.kind === 'existing' && showAddKind(route.show) === 'label') {
    p.bound = null;
    const s = route.show, listed = catalogListingOf(s);
    previewEl.innerHTML = `<div class="tmdb-preview">${header(network)}<div class="tmdb-refresh-summary">“${esc(s.title)}” is already on your list. TMDB seasons can’t be added to it here; you can add a season to it by hand (a plain “Season N” becomes TMDB season N; any other label is held for review).${listed ? ` The ${esc(listed)} catalog lists this show.` : ''}</div>
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
      ${rows || '<div class="tmdb-no-results">No seasons found.</div>'}
      ${actions(existing ? `Add to “${existing.title}”` : 'Add as a new show', 'addSelectedTMDBSeasons()')}
    </div>`;
}

// An explicit choice for an ambiguous or similar result (never made automatically).
function libraryChoose(tmdbId, mediaType, showId, asNew) {
  if (!libraryPanel) return;
  libraryPanel.choice = { tmdbId, mediaType, showId: showId || null, asNew: !!asNew };
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
    const now = sel.mediaType === 'movie'
      ? (p.choice && p.choice.asNew ? 'new' : routeFilmResult(lib, sel.id, name).kind)
      : bound.kind === 'existing' ? (lib.showsById.get(bound.showId) ? 'existing' : 'gone') : routeTvResult(lib, sel.id, name).kind;
    const same = bound.kind === 'existing'
      ? now === 'existing' && JSON.stringify(libraryExpected(lib.showsById.get(bound.showId), bound.expected.network)) === JSON.stringify(bound.expected)
      : bound.kind === 'new-show' ? now === 'new' || (now === 'similar' && p.choice && p.choice.asNew) : now === 'new';
    if (!same) {
      libraryReport(ctx, 'Your list changed since this preview, so nothing was added. Look at it again.', true);
      renderTMDBPreview();
      return;
    }
    if (sel.mediaType === 'movie') return await libraryAddFilm(ctx, libraryFilmFromTmdb(sel.id, name, details));
    if (bound.kind === 'existing') {
      const show = lib.showsById.get(bound.showId);
      const byNum = new Map((details.seasons || []).map(s => [s.season_number, s]));
      const seasons = nums.filter(n => byNum.has(n)).map(n => libraryTmdbSeason(show, byNum.get(n), bound.expected.network));
      return await librarySendToShow(ctx, show, seasons, bound.expected.network);
    }
    return await libraryNewShow(ctx, { tmdb_id: sel.id, title: name, show_key: name.toLowerCase().trim(),
      network: (details.networks && details.networks[0]?.name) || 'Unknown' }, libraryNewShowSeasons(sel.id, name, details, nums));
  } finally {
    if (libraryPanel === p) p.busy = false;
  }
}

function libraryFilmFromTmdb(tmdbId, name, details) {
  const belongsTo = details.belongs_to_collection;
  return { collection: LIBRARY_NEW_FILM, item_key: `${name.toLowerCase().trim()}|film`, title: name, season: 'Film',
    theme: (details.genres && details.genres[0]?.name) || 'Film',
    display_date: details.release_date ? formatDisplayDate(details.release_date) : 'TBA', date_sort: details.release_date || '2099-01-01',
    watched: false, status: 'confirmed', tmdb_collection_id: belongsTo ? belongsTo.id : null, tmdb_collection_name: belongsTo ? belongsTo.name : null,
    collections: belongsTo ? [belongsTo.name] : [], media_type: 'movie', tmdb_id: tmdbId, season_number: null };
}

// ─── Sending ──────────────────────────────────────────────────────────────────
// Seasons for a show already on the list: refused by the database if that show is
// gone or changed. The answer's show is checked again here.
async function librarySendToShow(ctx, show, seasons, network) {
  let res;
  try {
    res = await sbRpc('add_tv_seasons_to_show', { p_show_id: show.id, p_expected: libraryExpected(show, network), p_seasons: seasons });
  } catch (e) {
    if (!libraryAnswerCurrent(ctx, show.title)) return { failed: true };
    const f = libraryFailure(e, `Adding to “${show.title}”`);
    if (!f.unknown) libraryAfterWrite(ctx);
    libraryReport(ctx, f.text, true);
    return { failed: true, unknown: !!f.unknown };
  }
  if (!libraryAnswerCurrent(ctx, show.title)) return { discarded: true };
  if (!res || res.show_id !== show.id || res.show_created) {
    libraryAfterWrite(ctx);
    libraryReport(ctx, `The answer named a different show than “${show.title}”, so this isn’t reported as an addition to it. Check your list before adding again.`, true);
    return { failed: true };
  }
  if ((res.inserted || []).length) showSaved();
  libraryAfterWrite(ctx);
  libraryReport(ctx, libraryAddText(res, show.title), !!(res.rejected || []).length && !(res.inserted || []).length);
  return { res };
}

// A new show, through create_tv_show: created where new shows go (LIBRARY_NEW_TV)
// with all its seasons, or refused (show_exists / create_conflict, nothing written)
// when a show with this identity or key is there by then. It never joins a show.
async function libraryNewShow(ctx, showInfo, seasons) {
  if (!seasons.length) return;
  let res;
  try {
    res = await sbRpc('create_tv_show', { p_show: showInfo, p_seasons: seasons });
  } catch (e) {
    if (!libraryAnswerCurrent(ctx, showInfo.title)) return;
    const f = libraryFailure(e, `Adding “${showInfo.title}”`, 'Adding a new show');
    if (!f.unknown) libraryAfterWrite(ctx);
    libraryReport(ctx, f.text, true);
    return;
  }
  if (!libraryAnswerCurrent(ctx, showInfo.title)) return;
  libraryAfterWrite(ctx);
  if (!res || !res.show_created) { // not expected from create_tv_show; never reported as a new show
    libraryReport(ctx, `The answer didn’t confirm a new show “${showInfo.title}”. Check your list before adding again.`, true);
    return;
  }
  if ((res.inserted || []).length) showSaved();
  libraryReport(ctx, libraryAddText(res, showInfo.title), false, libraryMembershipHtml(ctx, { show_id: res.show_id }, showInfo.title));
}

async function libraryAddFilm(ctx, row) {
  let inserted;
  try {
    inserted = await sbFetch('POST', TABLE, [row]);
  } catch (e) {
    if (!libraryAnswerCurrent(ctx, row.title)) return;
    const f = libraryFailure(e, `Adding “${row.title}”`);
    if (!f.unknown) libraryAfterWrite(ctx);
    libraryReport(ctx, f.text, true);
    return;
  }
  if (!libraryAnswerCurrent(ctx, row.title)) return;
  const saved = inserted && inserted[0];
  showSaved();
  libraryAfterWrite(ctx);
  libraryReport(ctx, `Added “${row.title}”.`, false, saved ? libraryMembershipHtml(ctx, { item_id: saved.id }, row.title) : '');
}

// After any answer in the same epoch: the open view and the panel's library are read again.
function libraryAfterWrite(ctx) {
  if (ctx.epoch !== orgEpoch) return;
  if (activeViewId && activeViewId === ctx.viewId) reloadOpenView();
  if (libraryLive(ctx.session)) {
    cancelTMDBPreview();
    libraryLoad(ctx.session);
  }
}

// ─── Collections after a creation (optional, separate) ────────────────────────
function libraryMembershipHtml(ctx, target, title) {
  if (!libraryLive(ctx.session) || orgState !== 'ready') return '';
  const colls = activeBrowseCollections();
  if (!colls.length) return '';
  libraryPanel.memberTarget = { ...target, title };
  return `<div class="library-members"><span class="tmdb-refresh-summary">Also add “${esc(title)}” to collections (optional):</span>
    ${colls.map(c => `<label class="ww-option"><input type="checkbox" data-collection="${esc(c.collectionId)}"> ${esc(c.label)}</label>`).join('')}
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
  (box ? box.querySelectorAll('input[type="checkbox"][data-collection]') : []).forEach(cb => { if (cb.checked) chosen.push(cb.dataset.collection); });
  if (!chosen.length) return;
  const ctx = libraryContext();
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
    if (ctx.epoch !== orgEpoch) break;
  }
  if (libraryPanel === p) { p.membersBusy = false; p.memberTarget = null; }
  libraryReport(ctx, `“${target.title}” is saved. ${lines.join(' ')}`, false);
  if (ctx.epoch === orgEpoch && activeViewId === ctx.viewId && isBrowseCollectionView(activeViewId)) reloadOpenView();
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

// A new show typed in by hand (no TMDB identity; it can be matched later). A show
// with the same title already on the list is pointed out first; nothing is merged.
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
    const t = title.toLowerCase();
    const similar = lib.shows.filter(s => String(s.title || '').trim().toLowerCase() === t);
    // A show typed by hand is kept apart from others only by its name: a second
    // unmatched show with the same name can't be created next to an existing one
    // (the database would add the season to it). Never reinterpret "new show" as
    // "add to that show": offer that explicitly, through the checked path.
    const occupant = lib.shows.find(s => s.collection === LIBRARY_NEW_TV && s.tmdb_id == null && s.show_key === tvShowKey(LIBRARY_NEW_TV, key));
    if (occupant) {
      const note = document.getElementById('libraryManualNote');
      if (note) note.innerHTML = `<div class="tmdb-refresh-summary">A separate new show called “${esc(title)}” can’t be added: “${esc(occupant.title)}” is already on your list without a TMDB match, and two such shows can’t be kept apart. Nothing was added. You can add the season to it instead.</div>
        <div class="tmdb-preview-actions"><button class="btn" onclick="openAddSeason('${esc(occupant.id)}')">Add a season to “${esc(occupant.title)}”</button></div>`;
      p.manualConfirm = null;
      return;
    }
    if (similar.length && p.manualConfirm !== key) {
      p.manualConfirm = key;
      const note = document.getElementById('libraryManualNote');
      if (note) note.innerHTML = `<div class="tmdb-refresh-summary">“${esc(similar[0].title)}” is already on your list${similar.length > 1 ? ` (${similar.length} times)` : ''}. Add a season to it, or add a separate new show? Nothing is merged.</div>
        <div class="tmdb-preview-actions" style="flex-wrap:wrap">${similar.map(s => `<button class="btn" onclick="openAddSeason('${esc(s.id)}')">Add a season to “${esc(s.title)}”${similar.length > 1 ? ` (${esc(statusOptionLabel(s.status))})` : ''}</button>`).join('')}
        <button class="btn" onclick="libraryManualShow()">Add as a new show</button></div>`;
      return;
    }
    await libraryNewShow(ctx, { tmdb_id: null, title, show_key: tvShowKey(LIBRARY_NEW_TV, key), network: theme },
      [{ item_key: key, title, season, theme, display_date: date, date_sort: parseDate(date) }]);
  } finally {
    if (libraryPanel === p) p.busy = false;
  }
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
    const similar = lib.rows.filter(r => isFilmRow(r) && String(r.title || '').trim().toLowerCase() === title.toLowerCase());
    if (similar.length && p.manualConfirm !== key) {
      p.manualConfirm = key;
      const note = document.getElementById('libraryManualNote');
      if (note) note.innerHTML = `<div class="tmdb-refresh-summary">A film called “${esc(similar[0].title)}” is already on your list. Add another one anyway? Nothing is merged.</div>
        <div class="tmdb-preview-actions"><button class="btn" onclick="libraryManualFilm()">Add as a new film</button></div>`;
      return;
    }
    // A film is labelled 'Film' (All Movies lists exactly those and identified films).
    await libraryAddFilm(ctx, { collection: LIBRARY_NEW_FILM, item_key: key, title, season: 'Film', theme, display_date: date,
      date_sort: parseDate(date), watched: false, status: 'confirmed' });
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
    <div class="tmdb-refresh-summary">${show.tmdb_id != null ? 'This show is matched to TMDB: a plain “Season N” becomes its TMDB season N; any other label is held for review.' : 'This show isn’t matched to TMDB; the season is added by its label.'}${listed ? ` The ${esc(listed)} catalog lists this show.` : ''}</div>
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
// New TMDB seasons for every identified show that takes TMDB seasons (showAddKind),
// and TBA → date updates on their stored seasons. Read only until Apply.
async function libraryRefreshShows() {
  const p = libraryPanel;
  if (!p || p.mode !== 'refresh') return;
  const session = p.session;
  cancelTMDBPreview();
  const previewEl = document.getElementById('tmdbPreview');
  if (previewEl) previewEl.innerHTML = '<div class="tmdb-loading">Checking for new seasons…</div>';
  let lib;
  try { lib = await readLibrary(); }
  catch (e) { if (libraryLive(session) && previewEl) previewEl.innerHTML = `<div class="tmdb-no-results">Couldn’t read your whole list (${esc(e.message)}). Nothing was checked.</div>`; return; }
  if (!libraryLive(session)) return;
  p.lib = lib;
  const shows = lib.shows.filter(s => showAddKind(s) === 'tmdb').sort((a, b) => compareTitles(a.title, b.title) || cmpStr(a.id, b.id));
  if (!shows.length) { previewEl.innerHTML = '<div class="tmdb-no-results">No shows matched to TMDB — nothing to refresh.</div>'; return; }
  const found = [], updates = [], failed = [];
  for (const show of shows) {
    let details;
    try { details = await tmdbFetch(`/tv/${show.tmdb_id}`); } catch (e) { failed.push(show.title); continue; }
    if (!libraryLive(session)) return;
    const rows = lib.rows.filter(r => r.show_id === show.id);
    const fresh = [];
    for (const s of (details.seasons || []).filter(x => tmdbShowSpecials || x.season_number !== 0)) {
      const stored = rows.find(r => r.season_number === s.season_number);
      if (!stored) { fresh.push(s); continue; }
      const update = stored.tmdb_id === show.tmdb_id ? tmdbSeasonDateUpdate(stored, s) : null;
      if (update) updates.push({ row: stored, update, title: show.title });
    }
    if (fresh.length) found.push({ show, details, fresh });
  }
  if (!libraryLive(session)) return;
  const note = tmdbLookupFailureNote(shows.length, failed, 'show');
  if (note?.total) { previewEl.innerHTML = `<div class="tmdb-no-results">${esc(note.message)}</div>`; return; }
  p.refresh = { found, updates };
  const warn = note ? `<div class="tmdb-refresh-summary">⚠️ ${esc(note.message)}</div>` : '';
  if (!found.length && !updates.length) { previewEl.innerHTML = `${warn}<div class="tmdb-no-results">${note ? 'Nothing new among the shows that could be checked.' : 'Everything’s up to date.'}</div>`; return; }
  previewEl.innerHTML = `<div class="tmdb-preview">${warn}
    ${found.map((f, i) => `<div class="tmdb-preview-title" style="margin-top:8px">${esc(f.show.title)}</div>${f.fresh.map(s => `<label class="tmdb-season-row">
      <input type="checkbox" checked data-show-idx="${i}" data-season="${s.season_number}">
      <span class="tmdb-season-name">${esc(librarySeasonLabel(s.season_number))}</span>
      <span class="tmdb-season-meta">${s.episode_count || 0} episodes · ${esc(s.air_date ? formatDisplayDate(s.air_date) : 'TBA')}</span></label>`).join('')}`).join('')}
    ${updates.length ? `<div class="tmdb-preview-title" style="margin-top:8px">Confirmed dates</div>${updates.map((u, i) => `<label class="tmdb-season-row">
      <input type="checkbox" checked data-update-idx="${i}"><span class="tmdb-season-name">${esc(u.title)} · ${esc(u.row.season)}</span>
      <span class="tmdb-season-meta">${esc(u.row.display_date)} → ${esc(u.update.display_date)}</span></label>`).join('')}` : ''}
    <div class="tmdb-preview-actions"><button class="btn btn-accent" onclick="libraryApplyRefresh()">Apply selected</button><button class="btn" onclick="cancelTMDBPreview()">Cancel</button></div></div>`;
}

// One protected call per show. A refusal ("nothing was added" for that show only)
// moves on to the next show; an answer that isn't clear stops sending anything
// more. Earlier results stay reported.
async function libraryApplyRefresh() {
  const p = libraryPanel;
  if (!p || !p.refresh || p.busy) return;
  const { found, updates } = p.refresh;
  const ctx = libraryContext();
  const picks = new Map(), dates = [];
  document.querySelectorAll('#tmdbPreview input[type="checkbox"][data-show-idx]').forEach(cb => {
    if (!cb.checked) return;
    const i = parseInt(cb.dataset.showIdx, 10);
    if (!picks.has(i)) picks.set(i, []);
    picks.get(i).push(parseInt(cb.dataset.season, 10));
  });
  document.querySelectorAll('#tmdbPreview input[type="checkbox"][data-update-idx]').forEach(cb => { if (cb.checked) dates.push(updates[parseInt(cb.dataset.updateIdx, 10)]); });
  if (!picks.size && !dates.length) return;
  p.busy = true;
  const lines = [];
  let stopped = false, confirmed = 0; // confirmed: answers that saved something (the only reason to say "Saved")
  try {
    let lib;
    try { lib = await readLibrary(); }
    catch (e) { libraryReport(ctx, `Couldn’t read your whole list (${e.message}), so nothing was added.`, true); return; }
    if (!libraryLive(ctx.session)) return;
    for (const [i, nums] of picks) {
      if (ctx.epoch !== orgEpoch) { stopped = true; break; } // a restore since: nothing more is sent
      const f = found[i];
      const show = lib.showsById.get(f.show.id);
      const network = (f.details.networks && f.details.networks[0]?.name) || 'Unknown';
      if (!show || JSON.stringify(libraryExpected(show, network)) !== JSON.stringify(libraryExpected(f.show, network))) {
        lines.push(`“${f.show.title}”: it changed or is gone since the check, so nothing was sent for it.`);
        continue;
      }
      const byNum = new Map(f.fresh.map(s => [s.season_number, s]));
      let res;
      try {
        res = await sbRpc('add_tv_seasons_to_show', { p_show_id: show.id, p_expected: libraryExpected(show, network),
          p_seasons: nums.filter(n => byNum.has(n)).map(n => libraryTmdbSeason(show, byNum.get(n), network)) });
      } catch (e) {
        const fl = libraryFailure(e, `“${show.title}”`);
        lines.push(fl.unknown ? fl.text : `“${show.title}”: ${fl.text}`);
        if (fl.unknown || ctx.epoch !== orgEpoch) { stopped = true; break; }
        continue;
      }
      if (ctx.epoch !== orgEpoch) { stopped = true; lines.push(`“${show.title}” answered after a restore; that answer was set aside.`); break; }
      if (!res || res.show_id !== show.id || res.show_created) { lines.push(`“${show.title}”: the answer named a different show, so it isn’t reported as added. Check it.`); continue; }
      if ((res.inserted || []).length) confirmed++;
      lines.push(libraryAddText(res, show.title));
    }
    // Confirmed dates: only the two date fields, only while the row still holds the previewed value.
    for (const u of stopped ? [] : dates) {
      if (ctx.epoch !== orgEpoch) { stopped = true; break; } // a restore since: nothing more is sent
      try {
        const changed = await libraryPatchReturning(`${TABLE}?id=eq.${encodeURIComponent(u.row.id)}&media_type=eq.tv&tmdb_id=eq.${u.row.tmdb_id}&season_number=eq.${u.row.season_number}&display_date=eq.${encodeURIComponent(u.row.display_date)}`, u.update);
        if (changed.length === 1 && changed[0].id === u.row.id && changed[0].display_date === u.update.display_date) {
          confirmed++;
          lines.push(`${u.title} · ${u.row.season}: date set to ${u.update.display_date}.`);
        } else {
          lines.push(`${u.title} · ${u.row.season}: not changed — its date is no longer ${u.row.display_date} (it changed after the check), so this part of the preview is out of date. Check again.`);
        }
      } catch (e) {
        const fl = libraryFailure(e, `${u.title} · ${u.row.season} date`);
        lines.push(fl.text);
        if (fl.unknown) { stopped = true; break; }
      }
    }
  } finally {
    if (libraryPanel === p) { p.busy = false; p.refresh = null; }
  }
  if (stopped) lines.push('Nothing more was sent.');
  if (ctx.epoch !== orgEpoch) {
    showNotice(`Refresh shows answered after a restore. ${lines.join(' ')} The list has been read again; check these shows before adding again.`);
    if (activeViewId) reloadOpenView();
    return;
  }
  if (confirmed) showSaved();
  libraryAfterWrite(ctx);
  libraryReport(ctx, lines.join(' '), !confirmed);
}

// A guarded PATCH that answers with the rows it changed (PostgREST
// return=representation), so "no row matched" is told apart from a change.
// Errors as sbFetch reports them.
async function libraryPatchReturning(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  const text = await res.text();
  const rows = text ? JSON.parse(text) : [];
  return Array.isArray(rows) ? rows : [];
}

// ─── Movie tools (Refresh collections, MCU, person collections, Pull rest) ────
// The existing tools add films to the internal place for films. In All Movies they
// work on that storage's rows (read first, GET only), and report in the panel.
function toolCollectionId() {
  if (activeTabId) return activeTabId;
  return libraryPanel && libraryPanel.media === 'movie' && libraryPanel.viewId === activeViewId && libraryPanel.toolsReady ? LIBRARY_NEW_FILM : null;
}

// The tool's context: still current while the same tab is open, or the same panel
// in the same view and restore epoch.
function toolContext(collectionId) {
  return { collectionId, tab: activeTabId, session: libraryPanel ? libraryPanel.session : 0, viewId: activeViewId, epoch: orgEpoch };
}

function toolContextLive(t) {
  if (t.tab) return activeTabId === t.collectionId;
  return libraryLive(t.session) && t.epoch === orgEpoch;
}

// After a tool's write: the tab redraws (the old way) or the open view is read again.
function toolFinished(t) {
  if (t.tab) { if (activeTabId === t.collectionId) { cancelTMDBPreview(); renderFilters(); renderTable(); } return; }
  if (t.epoch === orgEpoch && activeViewId === t.viewId) reloadOpenView();
}

// Rows a tool adds go into the storage cache only within the epoch they were read in.
function toolCachePush(t, rows) {
  if (!rows || t.epoch !== orgEpoch) return;
  const td = tabData[t.collectionId];
  if (td) {
    td.rows.push(...rows); td.rows.sort((a, b) => a.date_sort.localeCompare(b.date_sort));
    if (td.known) td.known.push(...rows);
  }
}

// What a tool compares a TMDB film with to say "already added": in All Movies, the
// films' own storage (by TMDB identity, or by name for its unmatched films, as on
// the old tab) plus every TMDB-identified film stored anywhere else; on a tab,
// that tab's rows. A film stored elsewhere is never written by a tool.
function toolKnownRows(collectionId) {
  const td = tabData[collectionId];
  return (td && (td.known || td.rows)) || [];
}

// In All Movies a tool runs only on a complete read of the whole library (strict
// paging and counts); a failed or incomplete read lets nothing be imported.
async function libraryPrepareMovieTools() {
  const p = libraryPanel;
  if (!p || p.media !== 'movie') return false;
  const session = p.session, epoch = orgEpoch;
  p.toolsReady = false;
  delete tabData[LIBRARY_NEW_FILM];
  let all;
  try { all = await fetchAllRowsStrict(TABLE); }
  catch (e) {
    if (libraryLive(session)) libraryReport(libraryContext(), `Couldn’t read your whole list (${e.message}), so this tool can’t run right now. Nothing was changed.`, true);
    return false;
  }
  if (!libraryLive(session) || epoch !== orgEpoch) return false;
  const own = all.filter(r => r.collection === LIBRARY_NEW_FILM).sort((a, b) => String(a.date_sort).localeCompare(String(b.date_sort)));
  const elsewhere = all.filter(r => r.collection !== LIBRARY_NEW_FILM && r.media_type === 'movie' && r.tmdb_id != null);
  tabData[LIBRARY_NEW_FILM] = { rows: own, loaded: true, newKeys: [], known: own.concat(elsewhere) };
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

// From a film's ⋯ menu in All Movies: its franchise, into the films' storage.
async function libraryPullRest(rowId, collectionId, name) {
  if (activeViewId !== ALL_MOVIES_VIEW.id) return;
  openLibraryPanel('movie', 'tools');
  if (!await libraryPrepareMovieTools()) return;
  return openPullCollection(rowId, collectionId, name);
}

// ─── Delete or skip from a view ───────────────────────────────────────────────
// The tabs' rules (editPolicyOf): a built-in catalog TV season is skipped, a
// built-in catalog film gets status Skipped after a confirmation, anything else is
// deleted after a confirmation (a TV season through delete_tv_season, which also
// removes a show left empty). The row leaves the view at once and comes back if
// the delete is refused; an unclear answer is reported as such, never as done.
async function delRowInView(id) {
  const rows = actionRows();
  const row = rows.find(r => r.id === id);
  if (!row) return;
  const policy = editPolicyOf(row);
  if (policy.deleteEffect === 'skip') { await setSeasonSkipped(id, true); return; }
  if (policy.deleteEffect === 'skip-film') {
    if (!confirm(`Skip “${row.title}”? It’s part of a built-in catalog, so it is marked Skipped rather than deleted.`)) return;
    await setStatus(id, 'skipped');
    return;
  }
  const what = isTvSeason(row) ? `“${row.title}” · ${row.season}` : `“${row.title}”`;
  if (!confirm(`Delete ${what}? This removes it from your list.`)) return;
  const viewId = activeViewId, epoch = orgEpoch;
  const idx = rows.indexOf(row);
  rows.splice(idx, 1);
  const edit = typeof matchEditStart === 'function' ? matchEditStart('rows', row.collection, id, null) : null;
  renderTable();
  try {
    if (isTvSeason(row)) {
      try {
        const res = await sbRpc('delete_tv_season', { p_row_id: id });
        if (res && res.show_deleted && epoch === orgEpoch) tvShowsById.delete(res.show_id);
      } catch (e) {
        if (!String(e.message).includes('not_found:')) throw e; // already gone counts as deleted
      }
    } else {
      await sbFetch('DELETE', `${TABLE}?id=eq.${id}`, null);
    }
    if (epoch === orgEpoch) Object.values(tabData).forEach(td => { if (td && td.rows) td.rows = td.rows.filter(r => r.id !== id); });
    showSaved();
    if (epoch === orgEpoch && activeViewId === viewId) renderTable();
  } catch (e) {
    const info = orgErrorInfo(e);
    if (epoch === orgEpoch && activeViewId === viewId && actionRows() === rows) {
      if (info.kind === 'database') rows.splice(idx, 0, row);
      if (typeof matchEditRevert === 'function' && info.kind === 'database') matchEditRevert(edit, row);
    }
    // An unclear answer: the view is read again (that clears the error line, so it is reported after).
    if (epoch === orgEpoch && activeViewId === viewId) { if (info.kind === 'database') renderTable(); else reloadOpenView(); }
    showError(info.kind === 'database'
      ? `Couldn’t delete ${what}: ${info.message}. Nothing was changed.`
      : `The delete of ${what} was sent, but no clear answer came back (${info.message}). Reload and check before deleting again.`);
  }
  if (typeof matchEditEnd === 'function') matchEditEnd(edit);
}
