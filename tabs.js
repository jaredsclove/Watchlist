// ─── Tab bar ──────────────────────────────────────────────────────────────────
function buildTabs() {
  const bar = document.getElementById('tabBar');
  // The views (Currently Watching, All TV, Coming Soon; All Movies). There are no
  // storage tabs (Stage 4b), and since Stage 5 no record has a storage at all.
  bar.innerHTML = tabViewsFor(activeMediaType).map(v =>
    `<div class="tab${v.id===activeViewId?' active':''}" onclick="switchView('${v.id}')">
      <span class="tab-icon">${v.icon}</span>${esc(v.label)}
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
  if (firstView) switchView(firstView.id);
  buildMediaSwitch();
}

// Opens a derived view, or a read-only browse view (browse-views.js).
function switchView(id) {
  activeViewId = id;
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
  closeLibraryPanel(); // the "+ Add" panel belongs to the view it was opened in
  document.getElementById('addForm').style.display = 'none';
  document.getElementById('banner').innerHTML = '';
  const tmdbPanel = document.getElementById('tmdbPanel');
  tmdbPanel.style.display = 'none';
  tmdbPanel.innerHTML = '';
  buildTabs();
  if (isBrowseView(id)) loadBrowseView();
  else loadDerivedView();
}
