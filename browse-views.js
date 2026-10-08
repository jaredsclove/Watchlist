// ─── Browse collections and All Movies (read-only cross-media views) ─────────
// A collection destination (Disney+, Sheridan, 90 Day, True Crime / Docs, …; your
// personal collections, organization.js) shows its member TV shows (with every
// stored season) and films together, and All Movies shows every saved film,
// whichever tab it is stored in. Membership is the stored list of members only:
// the tab a row is saved in, tags, themes, titles and TMDB credits add nothing,
// and the storage tab appears only as the source badge. Nothing here writes: the
// loader only reads (it never calls loadTab, which can seed defaults and PATCH
// TBA dates), and the controls only search, filter, expand and navigate.
// Changes are made in the existing tabs and views. A collection can list TV as
// Shows or Seasons and show TV and films Separate or Combined (remembered per
// collection on this device); Shows and Movies only are A–Z, Seasons is oldest
// first. While one of these is open,
// activeViewId holds its id ('browse:<collection id>') and activeTabId is null;
// its rows live in browseData, apart from tabData and derivedData. Defined here
// rather than in config.js so the catalog-refresh workflow's config.js cache
// handling is unaffected.
const ALL_MOVIES_VIEW = { id: 'allmovies', label: 'All Movies', icon: '🎞️', mediaType: 'movie' };
// The existing Movies tab keeps its tools; its tab says it's the legacy place to edit.
const LEGACY_TAB_LABELS = { movies: 'Movies (legacy)' };
const BROWSE_MEDIA_LABELS = { all: 'All media', tv: 'TV', movie: 'Movies' };
// A collection's TV presentation and grouping, remembered on this device per
// collection (never on entry, only when changed) under its layout key
// (organization.js); separate from All TV's choice.
const BROWSE_PRESENTATIONS = { shows: 'Shows', seasons: 'Seasons' };
const BROWSE_GROUPINGS = { separate: 'Separate', combined: 'Combined' };
const BROWSE_SEASON_VIS_LABELS = { notskipped: 'All (except Skipped)', all: 'All', towatch: 'To watch', watched: 'Watched', skipped: 'Skipped' };
// Collapsible date sections: TBA starts collapsed, Date needs review expanded.
const BROWSE_SECTION_DEFAULTS = { tvTba: false, filmTba: false, allTba: false, tvReview: true, filmReview: true, allReview: true };

// A collection destination from the loaded collections (organization.js).
function browseCollectionOf(id) {
  if (!isBrowseCollectionView(id)) return null;
  const c = (personalCollections || []).find(x => BROWSE_VIEW_PREFIX + x.id === id);
  return c ? browseDestFromCollection(c) : null;
}

// The open collection: as just read by its view, else as loaded at startup.
function currentBrowseDest() {
  return (browseData && browseData.dest) || browseCollectionOf(activeViewId);
}

function isBrowseView(id) {
  return id === ALL_MOVIES_VIEW.id || isBrowseCollectionView(id);
}

function legacyTabLabel(c) {
  return LEGACY_TAB_LABELS[c.id] || c.label;
}

// The view tabs of a media area, in order; the first is where the area opens
// (TV → Currently Watching, Movies → All Movies).
function tabViewsFor(mediaType) {
  return [...DERIVED_VIEWS, ALL_MOVIES_VIEW].filter(v => v.mediaType === mediaType);
}

function landingViewFor(mediaType) {
  return tabViewsFor(mediaType)[0] || null;
}

// ─── Classification and projections (pure) ───────────────────────────────────
// A film: an identified movie, or a legacy row labelled 'Film'. An explicit
// media_type 'tv' is never a film, whatever its label; a row that is neither TV
// nor a film is reported, never guessed into either.
function isFilmRow(r) {
  return !!r && (r.media_type === 'movie' || (r.media_type == null && r.season === 'Film'));
}

// One entry per row id.
function uniqueById(rows) {
  const byId = new Map();
  rows.forEach(r => { if (r && r.id != null && !byId.has(r.id)) byId.set(r.id, r); });
  return [...byId.values()];
}

function compareFilms(a, b) {
  return compareTitles(a.title, b.title)
    || compareTitles(collectionLabel(a.collection), collectionLabel(b.collection))
    || cmpStr(a.id, b.id);
}

// The members of one collection (members: { showIds, filmIds }, organization.js):
// TV shows (one per member show, every stored season in season order, up next,
// and Up to date for a Watching show only) and films, both A–Z. A membership
// whose show or film wasn't read (or isn't a film) is counted in badLinks, never
// guessed or repaired; a member show with no stored season lists nothing.
function deriveBrowseCollection(rows, showsById, members, today) {
  const seasonsByShow = new Map();
  const films = [];
  const rowsById = new Map(uniqueById(rows).map(r => [r.id, r]));
  let badLinks = 0;
  rowsById.forEach(r => {
    if (isTvViewRow(r)) {
      if (!r.show_id || !members.showIds.has(r.show_id) || !showsById.has(r.show_id)) return;
      if (!seasonsByShow.has(r.show_id)) seasonsByShow.set(r.show_id, []);
      seasonsByShow.get(r.show_id).push(r);
    } else if (isFilmRow(r) && members.filmIds.has(r.id)) {
      films.push(r);
    }
  });
  members.showIds.forEach(id => { if (!showsById.has(id)) badLinks++; });
  members.filmIds.forEach(id => { const r = rowsById.get(id); if (!r || !isFilmRow(r)) badLinks++; });
  const shows = [...seasonsByShow.entries()].map(([id, seasons]) => {
    const show = showsById.get(id);
    seasons.sort(compareSeasons);
    const upNext = upNextSeason(seasons);
    return {
      key: id,
      show,
      collection: show.collection,
      title: show.title,
      seasons,
      upNext,
      upNextReleased: upNext ? isReleasedRow(upNext, today) : false,
      upToDate: show.status === 'watching' && isShowUpToDate(seasons, today)
    };
  });
  shows.sort((a, b) => compareTitles(a.title, b.title)
    || compareTitles(collectionLabel(a.collection), collectionLabel(b.collection))
    || cmpStr(a.key, b.key));
  return { shows, films: films.sort(compareFilms), badLinks, unclassified: 0 };
}

// Every saved film, whatever tab stores it (the same row, not a copy).
function deriveAllMovies(rows) {
  const films = [];
  let unclassified = 0;
  uniqueById(rows).forEach(r => {
    if (isFilmRow(r)) films.push(r);
    else if (!isTvViewRow(r)) unclassified++;
  });
  return { films: films.sort(compareFilms), unclassified };
}

// ─── Presentation (pure) ──────────────────────────────────────────────────────
// Entries of a collection view: { kind: 'show', item } (a show group), { kind:
// 'season', row, show } or { kind: 'film', row }. A season is titled by its
// parent show, so it sorts and reads like the show it belongs to; its row is not
// changed. TV comes before a film with the same title.
function browseEntryTitle(e) {
  return e.kind === 'film' ? e.row.title : e.kind === 'show' ? e.item.title : e.show.title;
}
function browseEntryId(e) {
  return e.kind === 'show' ? e.item.key : e.row.id;
}
function browseEntrySource(e) {
  return collectionLabel(e.kind === 'show' ? e.item.collection : e.row.collection);
}
// A–Z: title, TV before film, source, id.
function compareBrowseAz(a, b) {
  return compareTitles(browseEntryTitle(a), browseEntryTitle(b))
    || (a.kind === 'film') - (b.kind === 'film')
    || compareTitles(browseEntrySource(a), browseEntrySource(b))
    || cmpStr(browseEntryId(a), browseEntryId(b));
}
// Undated and equal-date ties: title, TV before film, season order (two
// seasons), source, row id.
function compareBrowseTie(a, b) {
  return compareTitles(browseEntryTitle(a), browseEntryTitle(b))
    || (a.kind === 'film') - (b.kind === 'film')
    || (a.kind === 'season' && b.kind === 'season' ? seasonOrder(a.row, b.row) : 0)
    || compareTitles(browseEntrySource(a), browseEntrySource(b))
    || cmpStr(a.row.id, b.row.id);
}
// Chronological: classified before sorting. Genuine TBA (text or sentinel, whatever
// a guessed date_sort says), date needs review (no valid date), and dated entries
// oldest first.
function chronoBuckets(entries) {
  const tba = entries.filter(e => isTbaRow(e.row)).sort(compareBrowseTie);
  const review = entries.filter(e => !isTbaRow(e.row) && !isValidDateSort(e.row.date_sort)).sort(compareBrowseTie);
  const dated = entries.filter(e => !isTbaRow(e.row) && isValidDateSort(e.row.date_sort))
    .sort((a, b) => cmpStr(a.row.date_sort, b.row.date_sort) || compareBrowseTie(a, b));
  return { dated, tba, review };
}

// A collection as shown: the filtered shows and films (Search on the show or film
// title, Status on the show or the film's own row, Theme on any stored season of a
// show (on the season itself in Seasons) or the film's own; collection tag and
// watch-with are carried by films only, so while one is set no TV is listed),
// counts, and the sections to draw. opts: { media, presentation, grouping,
// seasonVis, textMatches, fStatus, fTheme, fCollection, fWatchWith }. A show keeps
// all its seasons for progress, up next and expansion.
// Seasons lists TV season entries (narrowed by seasonVis, never films) and puts
// everything chronological; Shows and Movies-only are A–Z. Grouping only chooses
// one interleaved section or one per media: it never changes counts or members.
function deriveBrowsePresentation(base, opts) {
  const withTv = opts.media !== 'movie', withFilms = opts.media !== 'tv';
  const seasons = withTv && opts.presentation === 'seasons';
  const combined = opts.media === 'all' && opts.grouping === 'combined';
  const shows = base.shows.filter(x => opts.textMatches(x.title) && allTvStatusMatches(x.show.status, opts.fStatus)
    && (seasons || themeMatchesShow(x.seasons, opts.fTheme)) && !opts.fCollection && !opts.fWatchWith);
  const films = base.films.filter(r => browseFilmMatches(r, opts));
  const tv = !withTv ? []
    : seasons
      ? shows.flatMap(item => item.seasons.filter(r => allTvSeasonVisible(r, item.show, opts.seasonVis) && themeMatchesRow(r, opts.fTheme))
        .map(row => ({ kind: 'season', row, show: item.show })))
      : shows.map(item => ({ kind: 'show', item }));
  const filmEntries = withFilms ? films.map(row => ({ kind: 'film', row })) : [];
  const counts = {
    shows: !withTv ? 0 : seasons ? new Set(tv.map(e => e.show.id)).size : shows.length,
    entries: !withTv ? 0 : seasons ? tv.length : shows.reduce((n, x) => n + x.seasons.length, 0),
    films: filmEntries.length
  };
  const chrono = seasons; // Seasons is chronological for films too; Shows and Movies-only are A–Z
  const arrange = list => (chrono ? { chrono: true, ...chronoBuckets(list) } : { chrono: false, az: list.slice().sort(compareBrowseAz) });
  const sections = combined
    ? [{ key: 'all', label: 'All media', entries: tv.concat(filmEntries), ...arrange(tv.concat(filmEntries)) }]
    : [
      ...(withTv ? [{ key: 'tv', label: 'TV', entries: tv, ...arrange(tv) }] : []),
      ...(withFilms ? [{ key: 'film', label: 'Movies', entries: filmEntries, ...arrange(filmEntries) }] : [])
    ];
  return { withTv, withFilms, seasons, combined, counts, sections, baseShows: base.shows.length, baseFilms: base.films.length };
}

// A film by every filter but Watched: Search, Status (its own row), Theme, a
// legacy collection tag (cleaned name, as shown) and a watch-with token.
function browseFilmMatches(r, f) {
  return f.textMatches(r.title) && allTvStatusMatches(r.status, f.fStatus) && themeMatchesRow(r, f.fTheme)
    && (!f.fCollection || (r.collections || []).some(c => cleanCollectionName(c) === f.fCollection))
    && (!f.fWatchWith || (r.watch_with || []).includes(f.fWatchWith));
}

// All Movies' Watched filter, on the stored watched flag (not the status).
const BROWSE_WATCH_LABELS = { '': 'Any watched state', unwatched: 'Unwatched only', watched: 'Watched only' };
function browseWatchMatches(r, fWatch) {
  return fWatch === 'unwatched' ? !r.watched : fWatch === 'watched' ? !!r.watched : true;
}

// ─── Filter values of the derived and browse views ───────────────────────────
// A view's filter values are kept for the visit (viewFilterMemory): a redraw (a
// presentation, media or other change, Retry) puts every value back, including
// those of a control the current mode doesn't show, which doesn't filter while
// hidden. A fresh entry starts from the view's defaults; Back puts back the
// values the view had when a collection was opened from it.
const VIEW_FILTER_IDS = ['fSearch', 'fSource', 'fStatus', 'fWatch', 'fTheme', 'fCollection', 'fWatchWith', 'fProgress'];

function currentViewFilters(tag) {
  const values = viewFilterMemory.tag === tag ? { ...viewFilterMemory.values } : {};
  VIEW_FILTER_IDS.forEach(id => { const el = document.getElementById(id); if (el) values[id] = el.value; });
  return values;
}

// Before the filter row is redrawn: whether this is a redraw of the same view
// (or Back), and the values its new controls get.
function viewFilterStart(tag, filtersRowEl, defaults = {}) {
  const restored = takeBackNavFilters(activeViewId);
  const keepState = filtersRowEl.dataset.tab === tag || !!restored;
  return { restored, keepState, values: { ...defaults, ...(restored || (keepState ? currentViewFilters(tag) : {})) } };
}

// Before a loader clears the filter row (reload, Retry, a refresh): the visit keeps the
// controls' current values. Only for this view's own controls, and only once the visit
// has drawn them: a fresh entry (switchView reset the memory) or another view's row keeps nothing.
function holdViewFilters(viewId) {
  const tag = `view:${viewId}`;
  if (viewFilterMemory.tag !== tag || document.getElementById('filtersRow').dataset.tab !== tag) return;
  viewFilterMemory = { tag, values: currentViewFilters(tag) };
}

// After it is drawn: each shown control takes its value (a choice it doesn't offer
// leaves its default), and the visit remembers them all.
function applyViewFilters(tag, values) {
  for (const [id, value] of Object.entries(values)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === value)) continue;
    el.value = value;
  }
  viewFilterMemory = { tag, values: { ...values } };
}

// ─── Navigation ───────────────────────────────────────────────────────────────
// Opens a collection. Back returns to where it was opened from: the same view
// with its filters, or the area's first view when that was a legacy tab (whose
// loader can write). Opening one collection from another keeps the first origin.
function openBrowseCollection(id) {
  if (!browseCollectionOf(id)) return;
  if (!isBrowseCollectionView(activeViewId)) {
    const safeView = activeViewId && !isBrowseCollectionView(activeViewId) ? activeViewId : null;
    const filters = safeView ? currentViewFilters(`view:${safeView}`) : {};
    browseOrigin = { mediaType: activeMediaType, viewId: safeView, filters };
  }
  switchView(id);
}

function browseBack() {
  const origin = browseOrigin || { mediaType: activeMediaType, viewId: null, filters: null };
  const target = origin.viewId || landingViewFor(origin.mediaType).id;
  activeMediaType = origin.mediaType;
  backNavFilters = origin.viewId && origin.filters ? { view: target, values: origin.filters } : null;
  buildMediaSwitch();
  switchView(target);
}

// The filters Back puts back on the view it returns to (once).
function takeBackNavFilters(viewId) {
  if (!backNavFilters || backNavFilters.view !== viewId) return null;
  const values = backNavFilters.values;
  backNavFilters = null;
  return values;
}

// The selector: your collections once loaded; while loading, or after a failed
// load, it says so (with Retry) rather than showing an empty list.
function buildBrowseBar() {
  const bar = document.getElementById('browseBar');
  if (!bar) return;
  const label = `<label class="browse-bar-label" for="browseSelect">Browse collections</label>`;
  if (orgState !== 'ready') {
    const text = orgState === 'loading' ? 'Loading collections…' : 'Collections unavailable';
    const retry = orgState === 'loading' ? '' : ` <button class="btn" onclick="loadOrganization()">Retry</button>`;
    bar.innerHTML = `${label}
    <select id="browseSelect" disabled><option value="" selected>${text}</option></select>${retry}`;
    return;
  }
  const list = activeBrowseCollections();
  const activeId = isBrowseCollectionView(activeViewId) ? activeViewId : null;
  // Stage 3b-2: Manage opens the organization editor (organization-manage.js); after a
  // failed refresh the list is kept and marked as possibly out of date.
  const stale = orgCollectionsStale ? ` <span class="browse-stale">Collections may be out of date · <button class="btn" onclick="retryOrgRefresh()">Retry</button></span>` : '';
  bar.innerHTML = `${label}
    <select id="browseSelect" onchange="openBrowseCollection(this.value)"${list.length ? '' : ' disabled'}>
      <option value=""${activeId ? '' : ' selected'}>${list.length ? 'Choose a collection…' : 'No collections yet'}</option>${list.map(c =>
        `<option value="${esc(c.id)}"${activeId === c.id ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}
    </select> <button class="btn browse-manage" onclick="openManage('collections', null, this)">Manage</button>${stale}`;
}

// Restore is hidden (and its entry points do nothing) while a read-only view is
// open; the view heading is shown only there.
function updateRestoreVisibility() {
  const btn = document.getElementById('restoreBtn');
  if (btn) btn.style.display = isBrowseView(activeViewId) ? 'none' : '';
  const head = document.getElementById('viewHead');
  if (head) head.innerHTML = isBrowseView(activeViewId) ? browseHeadHtml() : '';
}

// Re-rendering replaces the controls, so keyboard focus is put back on the
// matching control (same container) when it was in one of these containers.
function focusedContainerOf(ids) {
  const active = document.activeElement;
  if (!active || typeof active.closest !== 'function') return null;
  return ids.find(id => active.closest(`#${id}`)) || null;
}

function refocus(containerId, selector) {
  const el = containerId ? document.getElementById(containerId)?.querySelector(selector) : null;
  if (el && typeof el.focus === 'function') el.focus();
}

function setBrowseMedia(media) {
  if (!isBrowseCollectionView(activeViewId) || !BROWSE_MEDIA_LABELS[media] || media === browseMedia) return;
  const container = focusedContainerOf(['filtersRow']);
  browseMedia = media;
  renderFilters();
  renderTable();
  refocus(container, `[data-media="${media}"]`);
}

// Every fresh entry to a collection: All media, TV seasons All (except Skipped), date sections at
// their defaults, and this collection's remembered Shows/Seasons and grouping.
function enterBrowseCollection(id) {
  const dest = browseCollectionOf(id);
  browseMedia = 'all';
  browseSeasonVis = 'notskipped';
  browseSectionOpen = { ...BROWSE_SECTION_DEFAULTS };
  const layout = readBrowseLayout(dest ? dest.layoutKey : null);
  browsePresentation = layout.presentation;
  browseGrouping = layout.grouping;
}

// Anything missing, unknown or unreadable falls back to Shows + Separate.
function readBrowseLayout(key) {
  const layout = { presentation: 'shows', grouping: 'separate' };
  if (!key) return layout;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && saved.presentation === 'seasons') layout.presentation = 'seasons';
    if (saved && saved.grouping === 'combined') layout.grouping = 'combined';
  } catch (e) { /* storage unavailable or unreadable: defaults */ }
  return layout;
}

function saveBrowseLayout() {
  const dest = currentBrowseDest();
  if (!dest) return;
  try {
    localStorage.setItem(dest.layoutKey, JSON.stringify({ presentation: browsePresentation, grouping: browseGrouping }));
  } catch (e) { /* storage unavailable: this visit only */ }
}

function setBrowsePresentation(mode) {
  if (!isBrowseCollectionView(activeViewId) || !BROWSE_PRESENTATIONS[mode] || mode === browsePresentation) return;
  const container = focusedContainerOf(['filtersRow']);
  browsePresentation = mode;
  saveBrowseLayout();
  renderFilters();
  renderTable();
  refocus(container, `[data-presentation="${mode}"]`);
}

function setBrowseGrouping(grouping) {
  if (!isBrowseCollectionView(activeViewId) || !BROWSE_GROUPINGS[grouping] || grouping === browseGrouping) return;
  const container = focusedContainerOf(['filtersRow']);
  browseGrouping = grouping;
  saveBrowseLayout();
  renderFilters();
  renderTable();
  refocus(container, `[data-grouping="${grouping}"]`);
}

// TV seasons (Seasons only): which season entries to list; never films. Kept for
// the visit across Shows/Seasons and media changes; All on every fresh entry.
function setBrowseSeasonVis(vis) {
  if (!isBrowseCollectionView(activeViewId) || !BROWSE_SEASON_VIS_LABELS[vis]) return;
  browseSeasonVis = vis;
  renderTable();
}

function toggleBrowseSection(name) {
  if (!isBrowseCollectionView(activeViewId) || !(name in BROWSE_SECTION_DEFAULTS)) return;
  const container = focusedContainerOf(['tbody', 'cardList']);
  browseSectionOpen[name] = !browseSectionOpen[name];
  renderTable();
  refocus(container, `[data-section="${name}"]`);
}

function toggleBrowseShow(key) {
  if (!isBrowseView(activeViewId)) return;
  const container = focusedContainerOf(['tbody', 'cardList']);
  if (expandedShows.has(key)) expandedShows.delete(key);
  else expandedShows.add(key);
  renderTable();
  refocus(container, `[data-show-key=${JSON.stringify(String(key))}]`);
}

// ─── Loading ──────────────────────────────────────────────────────────────────
// Every row and every show (and, for a collection, every collection and
// membership), read completely (fetchAllRowsStrict) or not at all. GET only.
// Refetched on every entry and on Retry; filters, media and expansion work on
// the loaded snapshot. A response for an earlier entry is dropped. The reads are
// concurrent, not one transaction: a membership whose show or film wasn't read
// is reported (Read again), never repaired.
async function loadBrowseView() {
  const viewId = activeViewId;
  if (!isBrowseView(viewId)) return;
  const seq = ++browseLoadSeq;
  browseData = null;
  document.getElementById('statsRow').innerHTML = '';
  // The filter row's view tag stays: Retry (or a refresh) puts this visit's filters back
  // (viewFilterMemory, holding the current controls first); a fresh entry has already reset them (switchView).
  holdViewFilters(viewId);
  document.getElementById('filtersRow').innerHTML = '';
  document.getElementById('viewHead').innerHTML = browseHeadHtml();
  showError('');
  paintBrowseMessage('Loading…', false);
  try {
    const isCollection = isBrowseCollectionView(viewId);
    const orgRead = orgReadStart();
    const [rows, shows, collections, memberships] = await Promise.all([fetchAllRowsStrict(TABLE), fetchAllRowsStrict('tv_shows'),
      ...(isCollection ? [fetchAllRowsStrict('personal_collections'), fetchAllRowsStrict('collection_memberships')] : [])]);
    if (seq !== browseLoadSeq || activeViewId !== viewId) return;
    let dest = null, members = null;
    if (isCollection) {
      if (publishCollections(collections, orgRead)) buildBrowseBar();
      const c = collections.find(x => BROWSE_VIEW_PREFIX + x.id === viewId);
      if (!c || c.archived_at) {
        document.getElementById('viewHead').innerHTML = `<div class="browse-head"><button class="btn browse-back" onclick="browseBack()">← Back</button></div>`;
        paintBrowseMessage('This collection isn’t available any more.', false);
        return;
      }
      dest = browseDestFromCollection(c);
      members = membersOf(memberships, c.id);
    }
    browseData = { rows, showsById: new Map(shows.map(s => [s.id, s])), dest, members, loaded: true };
    renderFilters();
    renderTable();
  } catch(e) {
    console.error(e);
    if (seq !== browseLoadSeq || activeViewId !== viewId) return;
    showError(`Couldn't read everything that's saved, so nothing is shown rather than an incomplete list. ${e.message}`);
    paintBrowseMessage('Failed to load.', true);
  }
}

function paintBrowseMessage(text, withRetry) {
  const retry = withRetry ? ` <button class="btn" onclick="loadBrowseView()">Retry</button>` : '';
  document.getElementById('tbody').innerHTML = `<tr><td colspan="6" class="loading">${esc(text)}${retry}</td></tr>`;
  document.getElementById('cardList').innerHTML = `<div class="loading">${esc(text)}${retry}</div>`;
}

// ─── Filters ──────────────────────────────────────────────────────────────────
// The heading (title, Back, explanation) sits above the stats; in a collection,
// All media / TV / Movies stays outside the collapsible filter panel on phones.
function browseHeadHtml() {
  const dest = currentBrowseDest();
  if (!isBrowseCollectionView(activeViewId)) {
    return `<div class="browse-head">
      <h2 class="browse-title">${ALL_MOVIES_VIEW.icon} All Movies</h2>
      <p class="browse-note">Every saved film, whichever tab it's stored in. Read-only: make changes in Movies (legacy) or in the tab the film is stored in.</p>
    </div>`;
  }
  const backTo = (browseOrigin ? browseOrigin.mediaType : activeMediaType) === 'movie' ? 'Movies' : 'TV';
  if (!dest) return `<div class="browse-head"><button class="btn browse-back" onclick="browseBack()">← Back to ${backTo}</button></div>`;
  const icon = COLLECTIONS.find(c => c.id === dest.legacySource)?.icon || '';
  // A collection lists its members, which can be saved in any tab (each shows its
  // tab as its source), so the note never points at a same-named tab.
  const notes = [dest.note, `Read-only: the shows and films in your ${dest.label} collection. Make changes in the tab each one is saved in (shown as its source).`].filter(Boolean);
  return `<div class="browse-head">
      <button class="btn browse-back" onclick="browseBack()">← Back to ${backTo}</button>
      <button class="btn btn-link browse-edit-members" onclick="openManage('members', '${esc(dest.collectionId)}', this)">Edit members</button>
      <h2 class="browse-title">${icon} ${esc(dest.label)} — ${BROWSE_MEDIA_LABELS[browseMedia]}</h2>
      ${notes.map(n => `<p class="browse-note">${esc(n)}</p>`).join('')}
    </div>`;
}

// What a browse view's filter choices are drawn from: every loaded show and film
// of the view, whatever is shown, so a choice can always be changed or cleared.
function browseFilterBase() {
  if (!browseData || !browseData.loaded) return { shows: [], films: [] };
  if (!isBrowseCollectionView(activeViewId)) return { shows: [], films: deriveAllMovies(browseData.rows).films };
  if (!browseData.members) return { shows: [], films: [] };
  return deriveBrowseCollection(browseData.rows, browseData.showsById, browseData.members, localTodayStr());
}

// Collection tag and watch-with filters for the films' existing labels (offered
// only when some film has one). Watch-with is by token, labelled as the choice is now.
function filmTagFiltersHtml(films) {
  const tags = [...new Set(films.flatMap(r => (r.collections || []).map(cleanCollectionName)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const tokens = [...new Set(films.flatMap(r => r.watch_with || []).filter(Boolean))]
    .map(t => ({ t, label: watchWithArchived(t) ? `${watchWithLabel(t)} (archived)` : watchWithLabel(t) }))
    .sort((a, b) => a.label.localeCompare(b.label) || cmpStr(a.t, b.t));
  const tagSelect = tags.length
    ? `<select id="fCollection" onchange="renderTable()" aria-label="Collection tag">
        <option value="">All collection tags</option>${tags.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
      </select>` : '';
  const wwSelect = tokens.length
    ? `<select id="fWatchWith" onchange="renderTable()" aria-label="Watch with">
        <option value="">Watch with: anyone</option>${tokens.map(w => `<option value="${esc(w.t)}">${esc(w.label)}</option>`).join('')}
      </select>` : '';
  return tagSelect + wwSelect;
}

function renderBrowseFilters() {
  const filtersRowEl = document.getElementById('filtersRow');
  const tag = `view:${activeViewId}`;
  const dest = isBrowseCollectionView(activeViewId);
  // All Movies opens on Unwatched only; a changed choice is kept for the visit and by Back.
  const { restored, keepState, values } = viewFilterStart(tag, filtersRowEl, dest ? {} : { fWatch: 'unwatched' });
  const wasCollapsed = filtersRowEl.classList.contains('collapsed');
  const base = browseFilterBase();
  const mediaToggle = dest
    ? `<div class="view-toggle" role="group" aria-label="Media">${Object.entries(BROWSE_MEDIA_LABELS).map(([media, label]) =>
        `<button class="view-toggle-btn${browseMedia === media ? ' active' : ''}" data-media="${media}" aria-pressed="${browseMedia === media}" onclick="setBrowseMedia('${media}')">${label}</button>`).join('')}</div>`
    : '';
  // Shows/Seasons (not for Movies only) and Separate/Combined (All media only),
  // outside the collapsible panel; TV seasons (Seasons only) inside it.
  const toggleGroup = (label, attr, setter, options, current) =>
    `<div class="view-toggle" role="group" aria-label="${label}">${Object.entries(options).map(([value, text]) =>
      `<button class="view-toggle-btn${current === value ? ' active' : ''}" data-${attr}="${value}" aria-pressed="${current === value}" onclick="${setter}('${value}')">${text}</button>`).join('')}</div>`;
  const layoutToggles = dest && browseMedia !== 'movie'
    ? `<div class="browse-toggles">${browseMedia !== 'movie' ? toggleGroup('TV presentation', 'presentation', 'setBrowsePresentation', BROWSE_PRESENTATIONS, browsePresentation) : ''}${browseMedia === 'all' ? toggleGroup('Grouping', 'grouping', 'setBrowseGrouping', BROWSE_GROUPINGS, browseGrouping) : ''}</div>`
    : '';
  const seasonVisSelect = dest && browseMedia !== 'movie' && browsePresentation === 'seasons'
    ? `<select id="fSeasonVis" onchange="setBrowseSeasonVis(this.value)" aria-label="TV seasons">${Object.entries(BROWSE_SEASON_VIS_LABELS).map(([value, text]) =>
        `<option value="${value}"${browseSeasonVis === value ? ' selected' : ''}>TV seasons: ${text}</option>`).join('')}</select>`
    : '';
  // Source (All Movies only) is the tab a film is stored in, not where it streams.
  const sourceSelect = dest
    ? ''
    : `<select id="fSource" onchange="renderTable()" aria-label="Stored in">
        <option value="">All sources</option>${COLLECTIONS.map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}
      </select>`;
  const watchSelect = dest
    ? ''
    : `<select id="fWatch" onchange="renderTable()" aria-label="Watched">${Object.entries(BROWSE_WATCH_LABELS).map(([value, text]) =>
        `<option value="${value}"${value === 'unwatched' ? ' selected' : ''}>${text}</option>`).join('')}</select>`;
  const themes = base.shows.flatMap(x => x.seasons.map(r => r.theme)).concat(base.films.map(r => r.theme));
  const themeSelect = themeFilterSelectHtml(themes, 'All genres / themes', 'Genre or theme');
  // The films' labels: only while films are shown (a collection's TV only hides them, and they don't filter then).
  const tagFilters = !dest || browseMedia !== 'tv' ? filmTagFiltersHtml(base.films) : '';
  document.getElementById('viewHead').innerHTML = browseHeadHtml();
  // .browse-controls scopes the larger phone touch targets to these views (All TV's toggle is unchanged).
  filtersRowEl.innerHTML = `${dest ? `<div class="browse-controls">${mediaToggle}${layoutToggles}</div>` : ''}
    <button class="filter-toggle-btn" onclick="toggleFilters()" id="filterToggleBtn">
      <span>🔍 Search &amp; Filter</span><span id="filterToggleChevron">▾</span>
    </button>
    <div class="filters-inner">
      <span class="filter-label">Filter:</span>
      <input class="search-input" id="fSearch" type="text" placeholder="Search titles…" aria-label="Search titles" oninput="renderTable()">
      ${sourceSelect}
      <select id="fStatus" onchange="renderTable()" aria-label="Status">
        <option value="">All (except Skipped)</option>
        <option value="all">All statuses</option>
        ${TV_STATUS_ORDER.map(s => `<option value="${s}">${esc(statusOptionLabel(s))}${s === 'skipped' ? '' : ' only'}</option>`).join('')}
      </select>${watchSelect}${themeSelect}${tagFilters}${seasonVisSelect}
    </div>
  `;
  filtersRowEl.dataset.tab = tag;
  if (window.innerWidth <= 700) filtersRowEl.classList.add('collapsed');

  const tmdbPanel = document.getElementById('tmdbPanel');
  tmdbPanel.style.display = 'none';
  tmdbPanel.innerHTML = '';

  applyViewFilters(tag, values);
  if (keepState && !restored && filtersRowEl.classList.contains('collapsed') !== wasCollapsed) toggleFilters();
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function renderBrowseTable() {
  if (!browseData || !browseData.loaded) return;
  const thead = document.getElementById('tableHead');
  if (thead) thead.innerHTML = `<tr><th>Title</th><th>Source</th><th>Next / Release</th><th>Status</th><th>Watched</th><th>Progress</th></tr>`;
  const today = localTodayStr();
  const val = id => document.getElementById(id)?.value || ''; // a control that isn't shown doesn't filter
  const q = val('fSearch').trim().toLowerCase();
  const f = { textMatches: title => !q || (title || '').toLowerCase().includes(q), fStatus: val('fStatus'),
    fTheme: val('fTheme'), fCollection: val('fCollection'), fWatchWith: val('fWatchWith') };
  const dest = currentBrowseDest();
  if (isBrowseCollectionView(activeViewId)) { if (dest) renderBrowseCollection(dest, today, f); }
  else renderAllMovies(today, { ...f, fSource: val('fSource'), fWatch: val('fWatch') });
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function browseNoteHtml(msg, extra = '') {
  return {
    row: `<tr class="empty-row"><td colspan="6">${esc(msg)}${extra}</td></tr>`,
    card: `<div class="empty-row" style="padding:1rem 0">${esc(msg)}${extra}</div>`
  };
}

function browseSectionHtml(label, count) {
  return {
    row: `<tr class="browse-section-row"><th colspan="6" scope="colgroup">${esc(label)} <span class="section-count">${esc(count)}</span></th></tr>`,
    card: `<h3 class="browse-section-card">${esc(label)} <span class="section-count">${esc(count)}</span></h3>`
  };
}

// One collection, as chosen by media, TV presentation and grouping: a TV and a
// Movies section (Separate) or one interleaved section (Combined), each A–Z
// (Shows; Movies only) or chronological (Seasons) with TBA and Date needs review
// apart. Counts keep shows, season entries and films apart and don't depend on
// grouping. Status is the show's for TV and the film's own.
function renderBrowseCollection(dest, today, f) {
  const base = deriveBrowseCollection(browseData.rows, browseData.showsById, browseData.members, today);
  const v = deriveBrowsePresentation(base, { media: browseMedia, presentation: browsePresentation, grouping: browseGrouping,
    seasonVis: browseSeasonVis, ...f });
  const { counts } = v;

  const stats = [];
  if (v.withTv) stats.push([counts.shows, counts.shows === 1 ? 'Show' : 'Shows'], [counts.entries, counts.entries === 1 ? 'Season entry' : 'Season entries']);
  if (v.withFilms) stats.push([counts.films, counts.films === 1 ? 'Film' : 'Films']);
  document.getElementById('statsRow').innerHTML = derivedStatsHtml(stats);

  let html = '', cardHtml = '';
  const add = out => { html += out.row; cardHtml += out.card; };
  if (base.badLinks > 0) {
    // Describes this read, not the data: a show or film can be missing from it because the read was
    // incomplete or something changed meanwhile.
    add(browseNoteHtml(`⚠️ This read didn’t include ${plural(base.badLinks, 'member', 'members')} of this collection, so ${base.badLinks === 1 ? 'it isn’t' : 'they aren’t'} listed. That usually means the read was incomplete or something changed meanwhile; it doesn’t mean anything was deleted. Nothing was changed.`,
      ` <button class="btn" onclick="loadBrowseView()">Read again</button>`));
  }
  if (base.unclassified > 0) {
    add(browseNoteHtml(`⚠️ ${plural(base.unclassified, 'saved entry here is', 'saved entries here are')} neither a TV season nor a film, so ${base.unclassified === 1 ? 'it isn’t' : 'they aren’t'} listed.`));
  }
  if (v.withTv && (f.fCollection || f.fWatchWith)) {
    add(browseNoteHtml('Only films carry collection tags and watch-with choices, so no TV is listed while one of those filters is set.'));
  }
  // Only a choice that narrows by watched or skipped state; the default and All don't need it.
  if (v.seasons && v.withFilms && ['towatch', 'watched', 'skipped'].includes(browseSeasonVis)) {
    add(browseNoteHtml(`TV seasons: ${BROWSE_SEASON_VIS_LABELS[browseSeasonVis]}. Films aren’t filtered by this.`));
  }
  const countLabel = {
    tv: `${plural(counts.shows, 'show', 'shows')} · ${plural(counts.entries, 'season entry', 'season entries')}`,
    film: plural(counts.films, 'film', 'films'),
    all: `${plural(counts.shows, 'show', 'shows')} · ${plural(counts.entries, 'season entry', 'season entries')} · ${plural(counts.films, 'film', 'films')}`
  };
  v.sections.forEach(section => {
    add(browseSectionHtml(section.label, countLabel[section.key]));
    const entryHtml = (e, needsReview) => browseEntryHtml(e, today, v.combined, needsReview);
    if (!section.chrono) {
      section.az.forEach(e => add(entryHtml(e, false)));
    } else {
      let lastYear = '';
      section.dated.forEach(e => {
        const year = e.row.date_sort.substring(0, 4);
        if (year !== lastYear) {
          add({ row: `<tr class="year-group"><td colspan="6">${esc(year)}</td></tr>`, card: `<div class="card-year-group">${esc(year)}</div>` });
          lastYear = year;
        }
        add(entryHtml(e, false));
      });
      if (section.entries.length > 0 && section.dated.length === 0) add(browseNoteHtml('No dated entries; see below.'));
      [['Tba', 'TBA', section.tba, false], ['Review', 'Date needs review', section.review, true]].forEach(([suffix, label, list, needsReview]) => {
        if (!list.length) return;
        const name = section.key + suffix;
        add(browseSubsectionHtml(name, label, list.length));
        if (browseSectionOpen[name]) list.forEach(e => add(entryHtml(e, needsReview)));
      });
    }
    if (section.entries.length === 0) {
      const msg = section.key === 'tv'
        ? (v.baseShows === 0 ? `No TV shows in ${dest.label}.` : v.seasons ? 'No TV seasons match these filters.' : 'No TV shows match these filters.')
        : section.key === 'film'
          ? (v.baseFilms === 0 ? 'No films in this collection.' : 'No films match these filters.')
          : (v.baseShows + v.baseFilms === 0 ? `Nothing in ${dest.label}.` : 'Nothing matches these filters.');
      add(browseNoteHtml(msg));
    }
  });
  document.getElementById('tbody').innerHTML = html;
  document.getElementById('cardList').innerHTML = cardHtml;
}

function browseEntryHtml(e, today, combined, needsReview) {
  if (e.kind === 'show') return browseShowHtml(e.item, today, combined);
  if (e.kind === 'film') return browseFilmHtml(e.row, today);
  return browseSeasonEntryHtml(e, today, combined);
}

// A collapsible date section (TBA, Date needs review): a real button, so it can
// be reached and toggled by keyboard; focus returns to it after redrawing.
function browseSubsectionHtml(name, label, count) {
  const open = !!browseSectionOpen[name];
  const btn = `<button class="section-toggle" data-section="${name}" aria-expanded="${open}" onclick="toggleBrowseSection('${name}')"><span class="expand-chevron">${open ? '▾' : '▸'}</span> ${esc(label)} <span class="section-count">${count}</span></button>`;
  return { row: `<tr class="browse-subsection-row"><td colspan="6">${btn}</td></tr>`, card: `<div class="browse-subsection-card">${btn}</div>` };
}

// The totals count the films that pass every filter but Watched (so Unwatched only
// doesn't zero Watched); Shown counts what the list holds.
function renderAllMovies(today, f) {
  const { films, unclassified } = deriveAllMovies(browseData.rows);
  const matching = films.filter(r => (!f.fSource || r.collection === f.fSource) && browseFilmMatches(r, f));
  const shown = matching.filter(r => browseWatchMatches(r, f.fWatch));
  const watched = matching.filter(r => r.watched).length;
  document.getElementById('statsRow').innerHTML = derivedStatsHtml([
    [shown.length, 'Shown'],
    [matching.length, matching.length === 1 ? 'Film' : 'Films'],
    [watched, 'Watched'],
    [matching.length - watched, 'To watch']
  ]);
  let html = '', cardHtml = '';
  const add = out => { html += out.row; cardHtml += out.card; };
  if (unclassified > 0) {
    add(browseNoteHtml(`⚠️ ${plural(unclassified, 'saved entry is', 'saved entries are')} neither a TV season nor a film, so ${unclassified === 1 ? 'it isn’t' : 'they aren’t'} listed.`));
  }
  shown.forEach(r => add(browseFilmHtml(r, today)));
  if (shown.length === 0) add(browseNoteHtml(films.length === 0 ? 'No films saved yet.' : 'No films match these filters.'));
  document.getElementById('tbody').innerHTML = html;
  document.getElementById('cardList').innerHTML = cardHtml;
}

function browseStatusPillHtml(status, title) {
  return `<span class="status-pill s-${esc(status)}" title="${esc(title)}">${esc(statusOptionLabel(status))}</span>`;
}

// A stored date as text, with what it means: TBA (text or sentinel, whatever the
// guessed date_sort), "date needs review" (no valid date), or Upcoming. Never a
// release year that isn't stored.
function browseDateHtml(r, today) {
  if (isTbaRow(r)) return /TBA/i.test(r.display_date || '') ? esc(r.display_date) : `${esc(r.display_date)} <span class="ro-tag">TBA</span>`;
  if (!isValidDateSort(r.date_sort)) return `${esc(r.display_date)}<span class="review-tag">date needs review</span>`;
  return `${esc(r.display_date)}${r.date_sort > today ? '<span class="upcoming-tag">Upcoming</span>' : ''}`;
}

// The stored watched state as a label (not a control: these views change nothing).
function browseWatchedHtml(watched) {
  return watched ? '<span class="ro-watch watched">✓ Watched</span>' : '<span class="ro-watch">Not watched</span>';
}

// A show: its status, progress and what's next, as text; a labelled button
// expands every stored season (watched and skipped shown separately). Nothing
// on it changes anything.
function browseShowHtml(item, today, combined) {
  const { key, show, seasons, upNext, upToDate } = item;
  const inProgress = !upToDate && show.status === 'watching' && !!upNext;
  const dimClass = show.status === 'skipped' ? ' row-skipped' : show.status === 'maybe' ? ' row-maybe' : '';
  const isExpanded = expandedShows.has(key);
  const keyArg = esc(key).replace(/'/g, "\\'");
  const theme = (upNext || seasons[0]).theme;
  const badges = `${sourceBadgeHtml(item.collection)} ${themeBadgeHtml(item.collection, theme, key)}`;
  const trackable = seasons.filter(s => !s.skipped);
  const watchedCount = trackable.filter(s => s.watched).length;
  const skippedCount = seasons.length - trackable.length;
  const pct = trackable.length > 0 ? Math.round(watchedCount / trackable.length * 100) : 0;
  const watchedLabel = `${watchedCount}/${trackable.length} watched${skippedCount ? ` · ${skippedCount} skipped` : ''}`;
  const entriesLabel = plural(seasons.length, 'season entry', 'season entries');
  const bar = trackable.length > 0 ? `<div class="mini-progress-track"><div class="mini-progress-fill" style="width:${pct}%"></div></div>` : '';
  const upcomingTag = upNext && !item.upNextReleased ? '<span class="upcoming-tag">Upcoming</span>' : '';
  const nextLabel = upToDate
    ? upToDateNextLabel(upNext)
    : inProgress
      ? `Up next: ${esc(upNext.season)} · ${esc(upNext.display_date)}${upcomingTag}`
      : neutralNextLabel(upNext, item.upNextReleased);
  const statusHtml = browseStatusPillHtml(show.status, `Show status — applies to every season of ${show.title}`)
    + (upToDate ? ' <span class="status-pill s-caughtup">Up to date</span>' : '');
  const expandBtn = `<button class="expand-btn" data-show-key="${esc(key)}" aria-expanded="${isExpanded}" aria-label="${isExpanded ? 'Hide' : 'Show'} seasons of ${esc(item.title)}" onclick="toggleBrowseShow('${keyArg}')"><span class="expand-chevron">${isExpanded ? '▾' : '▸'}</span></button>`;

  let row = `<tr class="show-group-row browse-show-row${dimClass}">
      <td><div class="show-title-row"><div class="show-title-left"><span class="show-title">${esc(item.title)}</span>${combined ? '<span class="ro-tag">TV show</span>' : ''}</div>${expandBtn}</div></td>
      <td>${badges}</td>
      <td class="date-cell">${nextLabel}</td>
      <td>${statusHtml}</td>
      <td class="card-date">${watchedLabel}</td>
      <td class="card-date">${entriesLabel}${bar}</td>
    </tr>`;
  if (isExpanded) row += seasons.map(r => `<tr class="sub-row${r.skipped ? ' row-skipped' : ''}">
        <td style="padding-left:28px"><span class="season-lbl">${esc(r.season)}</span></td>
        <td></td>
        <td class="date-cell">${browseDateHtml(r, today)}</td>
        <td>${r.skipped ? '<span class="ro-tag">Season skipped</span>' : ''}</td>
        <td>${browseWatchedHtml(r.watched)}</td>
        <td></td>
      </tr>`).join('');

  const card = `<div class="item-card show-group-card${dimClass}">
      <div class="card-top">
        <div class="card-title-block">
          <span class="card-title">${esc(item.title)}</span>${combined ? '<span class="ro-tag">TV show</span>' : ''}
          <span class="card-season">${nextLabel}</span>
        </div>
        ${expandBtn}
      </div>
      <div class="card-meta">
        ${badges}
        <span class="card-date">${watchedLabel} · ${entriesLabel}</span>
        ${bar}
      </div>
      <div class="card-actions">${statusHtml}</div>
      ${isExpanded ? `<div class="card-subseasons">${seasons.map(r => `<div class="card-subseason-row${r.skipped ? ' row-skipped' : ''}">
          <span class="card-season">${esc(r.season)} · ${browseDateHtml(r, today)}</span>
          <div class="card-actions">${browseWatchedHtml(r.watched)}${r.skipped ? ' <span class="ro-tag">Season skipped</span>' : ''}</div>
        </div>`).join('')}</div>` : ''}
    </div>`;
  return { row, card };
}

// One TV season entry (Seasons): titled by its show, then its stored label; the
// show's status, the season's watched and skipped flags, all as text.
function browseSeasonEntryHtml(e, today, combined) {
  const { row: r, show } = e;
  const dimClass = show.status === 'skipped' || r.skipped ? 'row-skipped' : show.status === 'maybe' ? 'row-maybe' : '';
  const badges = `${sourceBadgeHtml(r.collection)} ${themeBadgeHtml(r.collection, r.theme, r.id)}`;
  const kindTag = combined ? '<span class="ro-tag">TV</span>' : '';
  const statusHtml = browseStatusPillHtml(show.status, `Show status — applies to every season of ${show.title}`);
  const skippedHtml = r.skipped ? '<span class="ro-tag">Season skipped</span>' : '';
  const row = `<tr class="browse-season-row ${dimClass}">
      <td><span class="show-title">${esc(show.title)}</span><span class="season-lbl"> · ${esc(r.season)}</span>${kindTag}</td>
      <td>${badges}</td>
      <td class="date-cell">${browseDateHtml(r, today)}</td>
      <td>${statusHtml}</td>
      <td>${browseWatchedHtml(r.watched)}</td>
      <td>${skippedHtml}</td>
    </tr>`;
  const card = `<div class="item-card ${dimClass}">
      <div class="card-top">
        <div class="card-title-block">
          <span class="card-title">${esc(show.title)}</span>
          <span class="card-season">${esc(r.season)}${kindTag}</span>
        </div>
      </div>
      <div class="card-meta">
        ${badges}
        <span class="card-date">${browseDateHtml(r, today)}</span>
      </div>
      <div class="card-actions">${statusHtml} ${browseWatchedHtml(r.watched)}${skippedHtml ? ` ${skippedHtml}` : ''}</div>
    </div>`;
  return { row, card };
}

// A film: the row's own status and watched state; its existing collection tags and
// watch-with choices as filter pills (they filter the list; they change nothing).
function browseFilmHtml(r, today) {
  const dimClass = r.status === 'skipped' ? 'row-skipped' : r.status === 'maybe' ? 'row-maybe' : '';
  const badges = `${sourceBadgeHtml(r.collection)} ${themeBadgeHtml(r.collection, r.theme, r.id)}`;
  const pills = collectionTagPillsHtml((r.collections || []).map(cleanCollectionName), r.id) + watchWithPillsHtml(r.watch_with || [], r.id);
  const labelsHtml = pills ? `<div class="ro-labels">${pills}</div>` : '';
  const statusHtml = browseStatusPillHtml(r.status, 'Film status');
  const row = `<tr class="browse-film-row ${dimClass}">
      <td><span class="show-title">${esc(r.title)}</span><span class="season-lbl"> · Film</span>${labelsHtml}</td>
      <td>${badges}</td>
      <td class="date-cell">${browseDateHtml(r, today)}</td>
      <td>${statusHtml}</td>
      <td>${browseWatchedHtml(r.watched)}</td>
      <td></td>
    </tr>`;
  const card = `<div class="item-card ${dimClass}">
      <div class="card-top">
        <div class="card-title-block">
          <span class="card-title">${esc(r.title)}</span>
          <span class="card-season">Film</span>
        </div>
      </div>
      <div class="card-meta">
        ${badges}
        <span class="card-date">${browseDateHtml(r, today)}</span>
      </div>
      ${labelsHtml}
      <div class="card-actions">${statusHtml} ${browseWatchedHtml(r.watched)}</div>
    </div>`;
  return { row, card };
}
