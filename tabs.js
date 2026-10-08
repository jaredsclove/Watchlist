// ─── Tab bar ──────────────────────────────────────────────────────────────────
function buildTabs() {
  const bar = document.getElementById('tabBar');
  // Views (Currently Watching, All TV, Coming Soon; All Movies) come first; they aren't collections.
  const viewTabs = tabViewsFor(activeMediaType).map(v =>
    `<div class="tab${v.id===activeViewId?' active':''}" onclick="switchView('${v.id}')">
      <span class="tab-icon">${v.icon}</span>${esc(v.label)}
    </div>`
  ).join('');
  const visibleCollections = COLLECTIONS.filter(c => c.mediaType === activeMediaType);
  bar.innerHTML = viewTabs + (viewTabs ? '<div class="tab-sep"></div>' : '') + visibleCollections.map(c =>
    `<div class="tab${!activeViewId && c.id===activeTabId?' active':''}" onclick="switchTab('${c.id}')">
      <span class="tab-icon">${c.icon}</span>${esc(legacyTabLabel(c))}
    </div>`
  ).join('');
  buildBrowseBar();
  updateRestoreVisibility();
}

function buildMediaSwitch() {
  const el = document.getElementById('mediaSwitch');
  if (!el) return;
  el.innerHTML = `
    <button class="media-switch-btn${activeMediaType==='tv'?' active':''}" onclick="switchMediaType('tv')">📺 TV</button>
    <button class="media-switch-btn${activeMediaType==='movie'?' active':''}" onclick="switchMediaType('movie')">🎬 Movies</button>
  `;
}

function switchMediaType(type) {
  if (type === activeMediaType && !isBrowseCollectionView(activeViewId)) return;
  activeMediaType = type;
  // Each area lands on its first view: TV → Currently Watching, Movies → All Movies.
  const firstView = landingViewFor(type);
  const firstInMode = COLLECTIONS.find(c => c.mediaType === type);
  if (firstView) {
    switchView(firstView.id);
  } else if (firstInMode) {
    switchTab(firstInMode.id);
  }
  buildMediaSwitch();
}

function switchTab(id) {
  activeViewId = null;
  activeTabId = id;
  browseOrigin = null;
  backNavFilters = null;
  viewFilterMemory = { tag: null, values: {} };
  invalidateRestorePreparation();
  addOpen = false;
  tmdbSelectedShow = null;
  expandedShows = new Set();
  document.getElementById('addForm').style.display = 'none';
  document.getElementById('banner').innerHTML = '';
  buildTabs();
  const td = tabData[id];
  if (!td || !td.loaded) {
    loadTab(id);
  } else {
    showCatalogNotice(id);
    renderFilters();
    renderTable();
  }
}

// Opens a derived view, or a read-only browse view (browse-views.js).
// activeTabId becomes null, so no collection is active: anything that would
// write `collection: activeTabId` is refused by the DB's NOT NULL, and a late
// loadTab() never paints over the view.
function switchView(id) {
  activeViewId = id;
  activeTabId = null;
  // Back from a collection keeps its origin only while collections are open,
  // and its saved filters only for the view it returns to.
  if (!isBrowseCollectionView(id)) browseOrigin = null;
  else enterBrowseCollection(id);
  if (backNavFilters && backNavFilters.view !== id) backNavFilters = null;
  viewFilterMemory = { tag: null, values: {} }; // a fresh entry starts from the defaults (Back puts its filters back itself)
  browseData = null;
  invalidateRestorePreparation();
  addOpen = false;
  tmdbSelectedShow = null;
  expandedShows = new Set();
  derivedSectionOpen = { uptodate: true, tba: false, alltvTba: false };
  // All TV: the remembered Shows / Seasons choice; the Seasons visibility starts at All (except Skipped).
  if (id === 'alltv') allTvPresentation = readAllTvPresentation();
  allTvSeasonVis = 'notskipped';
  derivedData = null;
  document.getElementById('addForm').style.display = 'none';
  document.getElementById('banner').innerHTML = '';
  const tmdbPanel = document.getElementById('tmdbPanel');
  tmdbPanel.style.display = 'none';
  tmdbPanel.innerHTML = '';
  buildTabs();
  if (isBrowseView(id)) loadBrowseView();
  else loadDerivedView();
}

// ─── Load tab data from Supabase ─────────────────────────────────────────────
async function loadTab(collectionId) {
  // Only show the loading state if this is still the tab the user is looking at —
  // if they've already switched tabs by the time this fires, don't touch the DOM.
  if (activeTabId === collectionId) {
    document.getElementById('tbody').innerHTML = `<tr><td colspan="6" class="loading">Loading…</td></tr>`;
    document.getElementById('cardList').innerHTML = `<div class="loading">Loading…</div>`;
    document.getElementById('statsRow').innerHTML = '';
    document.getElementById('filtersRow').innerHTML = '';
    showError('');
  }

  // Tracked (tmdb-match.js): it publishes only if no newer read of this tab published
  // first and no restore happened meanwhile, and it can satisfy a refresh after a Match.
  const read = typeof matchReadStart === 'function' ? matchReadStart('tab', collectionId) : null;
  try {
    let rows = await sbFetch('GET',
      `${TABLE}?collection=eq.${encodeURIComponent(collectionId)}&order=date_sort.asc&select=*`,
      null
    );

    // Opening a tab only reads (Stage 4a): built-in catalog entries are added and
    // dated only through Catalog updates (catalog-apply.js). A TV tab's statuses
    // live on its shows.
    if (isTvCollection(collectionId)) await loadTvShows(collectionId);

    rows.sort((a,b) => a.date_sort.localeCompare(b.date_sort));

    if (read) {
      if (!matchMayPublishTab(read)) { matchReadSettle(read, null); return; } // retired: a newer read (or a restore) came first
      // A row that a newer read or an edit already published keeps that newer state:
      // its newer version, its absence (deleted), or its presence (added). Rows kept
      // because of an edit aren't covered by this read.
      const newer = matchNewerRows(read, collectionId);
      const current = tabData[collectionId];
      const kept = new Set();
      const merged = rows.filter(r => !newer[r.id]);
      for (const [rowId, e] of Object.entries(newer)) {
        const shown = (current && current.rows.find(r => r.id === rowId)) || e.row;
        if (e.row && shown) merged.push(shown);
        if (e.kind === 'edit') kept.add(rowId);
      }
      rows = merged;
      rows.sort((a,b) => a.date_sort.localeCompare(b.date_sort));
      read.keptRows = kept;
      matchNotePublished('tabs', collectionId, read);
    }
    // Always cache the result, even if the user has navigated away — this keeps
    // tabData correct and avoids redundant reloads when they switch back.
    tabData[collectionId] = { rows, loaded: true, newKeys: [] };
    if (read) matchReadSettle(read, null);

    // But only touch the visible DOM if this tab is still the one being viewed.
    if (activeTabId !== collectionId) return;

    showCatalogNotice(collectionId);
    renderFilters();
    renderTable();
  } catch(e) {
    // A failure of a retired read (a newer read of this tab succeeded, or a restore
    // came since) replaces nothing on the page.
    const retired = !!read && !matchMayPublishTab(read);
    if (read && read.state === 'pending') matchReadSettle(read, e, retired);
    if (retired) { console.error(e); return; }
    if (activeTabId !== collectionId) { console.error(e); return; }
    showError(e.message);
    document.getElementById('tbody').innerHTML = `<tr><td colspan="6" class="loading">Failed to load. Check console for details.</td></tr>`;
    document.getElementById('cardList').innerHTML = `<div class="loading">Failed to load. Check console for details.</div>`;
    console.error(e);
  }
}
