// ─── Tab bar ──────────────────────────────────────────────────────────────────
function buildTabs() {
  const bar = document.getElementById('tabBar');
  // The views (Currently Watching, All TV, Coming Soon; All Movies). There are no
  // storage tabs (Stage 4b), and since Stage 5 no record has a storage at all.
  // An area with a single view (Movies: All Movies) has no secondary row at all; its
  // content heading names the view (B9).
  // Settings (S1) has no view tabs.
  const views = isSettingsView() ? [] : tabViewsFor(activeMediaType);
  bar.hidden = views.length <= 1;
  bar.innerHTML = views.length <= 1 ? '' : views.map(v =>
    `<div class="tab${v.id===activeViewId?' active':''}" onclick="switchView('${v.id}')">
      <span class="tab-icon">${v.icon}</span>${esc(v.label)}
    </div>`
  ).join('');
  buildBrowseBar();
  updateRestoreVisibility();
}

// The primary buttons and the header's Settings entry (S1): on Settings no area is
// active and the gear is the current page.
function buildMediaSwitch() {
  const el = document.getElementById('mediaSwitch');
  const onSettings = isSettingsView();
  if (el) {
    el.innerHTML = `
    <button class="media-switch-btn${!onSettings && activeMediaType==='tv'?' active':''}" onclick="switchMediaType('tv')">📺 TV</button>
    <button class="media-switch-btn${!onSettings && activeMediaType==='movie'?' active':''}" onclick="switchMediaType('movie')">🎬 Movies</button>
  `;
  }
  const entry = document.getElementById('settingsEntry');
  if (entry) entry.innerHTML = `<button class="btn gear-btn" id="settingsBtn" aria-label="Settings &amp; Management"${onSettings ? ' aria-current="page"' : ''} onclick="openSettings(this)">⚙ Settings</button>`;
}

function switchMediaType(type) {
  if (type === activeMediaType && !isBrowseCollectionView(activeViewId) && !isSettingsView()) return;
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
  if (!isSettingsView(id)) settingsOrigin = null; // Settings' Back applies only while Settings is open
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
  if (isSettingsView(id)) { renderSettings(); return; }
  showListContainers();
  if (isBrowseView(id)) loadBrowseView();
  else loadDerivedView();
}

// ─── Settings & Management (B7, S1) ───────────────────────────────────────────
// A screen, not a dialog: switchView(SETTINGS_VIEW_ID) shows it in place of the list
// (no tab row, no Browse row, no filters). It reads nothing: the counts come from what is
// already loaded, the backup status from this device (backup-restore.js). Each button
// opens the existing dialog or flow unchanged. Restore runs only here (restoreEligibleView).
const SETTINGS_VIEW_ID = 'settings';
const SETTINGS_LIST_CONTAINERS = ['desktopTable', 'cardList'];

function isSettingsView(id = activeViewId) {
  return id === SETTINGS_VIEW_ID;
}

// opener: the control pressed; section 'backup' puts focus on the Backup & Restore card.
// Pressing it while Settings is open is no navigation (a restore being prepared stays).
function openSettings(opener, section) {
  if (!isSettingsView()) {
    const viewId = activeViewId;
    // The view's visit state that isn't a filter control: All TV's and a collection's TV seasons
    // choice and a collection's media (put back by settingsBack only; a fresh entry resets them).
    settingsOrigin = { mediaType: activeMediaType, viewId, filters: viewId ? currentViewFilters(`view:${viewId}`) : {}, browseOrigin,
      allTvSeasonVis, browseSeasonVis, browseMedia };
    const origin = settingsOrigin;
    switchView(SETTINGS_VIEW_ID);
    settingsOrigin = origin;
    buildMediaSwitch();
  }
  const target = document.getElementById(section === 'backup' ? 'settingsBackupTitle' : 'settingsTitle');
  if (target && typeof target.focus === 'function') target.focus();
}

// "Back to library" (D4): the view Settings was opened from, with that visit's filters
// (put back once, as a collection's Back does); a collection keeps its own Back origin.
function settingsBack() {
  const origin = settingsOrigin;
  if (!origin || !origin.viewId) {
    activeMediaType = 'tv';
    buildMediaSwitch();
    switchView(landingViewFor('tv').id);
    buildMediaSwitch();
    return;
  }
  activeMediaType = origin.mediaType;
  backNavFilters = { view: origin.viewId, values: origin.filters || {} };
  browseOrigin = isBrowseCollectionView(origin.viewId) ? origin.browseOrigin || null : null;
  switchView(origin.viewId);
  // switchView reset the visit state as for a fresh entry; the round trip puts the origin's back
  // before its list is drawn (the loader draws after its read).
  if (origin.viewId === 'alltv' && origin.allTvSeasonVis) allTvSeasonVis = origin.allTvSeasonVis;
  if (isBrowseCollectionView(origin.viewId)) {
    if (origin.browseSeasonVis) browseSeasonVis = origin.browseSeasonVis;
    if (origin.browseMedia) browseMedia = origin.browseMedia;
  }
  buildMediaSwitch();
}

function showListContainers() {
  const screen = document.getElementById('settingsScreen');
  if (screen) { screen.style.display = 'none'; screen.innerHTML = ''; }
  SETTINGS_LIST_CONTAINERS.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });
}

function settingsCollectionsText() {
  if (orgState === 'absent') return 'Collections aren’t available on this database.';
  if (orgState !== 'ready') return orgState === 'loading' ? 'Loading…' : 'Couldn’t be read. Return to the library and use Retry beside Browse collections.';
  const all = personalCollections || [];
  const archived = all.filter(c => c.archived_at).length;
  return `${all.length - archived} active · ${archived} archived`;
}

function settingsChoicesText() {
  if (watchWithState === 'absent') return 'Watch-with choices aren’t available on this database.';
  if (watchWithState !== 'ready') return watchWithState === 'loading' ? 'Loading…' : 'Couldn’t be read.';
  return `${(watchWithChoices || []).filter(c => !c.archived_at).length} active`;
}

// The counts only (no redraw, so focus and the buttons stay): after a collections read.
function updateSettingsCounts() {
  const c = document.getElementById('settingsCollectionsText');
  if (c) c.textContent = settingsCollectionsText();
  const w = document.getElementById('settingsChoicesText');
  if (w) w.textContent = settingsChoicesText();
}

function renderSettings() {
  const screen = document.getElementById('settingsScreen');
  if (!screen) return;
  ['viewHead', 'filtersRow', 'statsRow', 'tbody', 'cardList'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
  SETTINGS_LIST_CONTAINERS.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  const filtersRow = document.getElementById('filtersRow');
  if (filtersRow) filtersRow.dataset.tab = '';
  const status = backupStatus();
  const busy = backupBusy ? ' disabled' : '';
  screen.style.display = '';
  screen.innerHTML = `<div class="settings-head">
      <button class="btn settings-back" onclick="settingsBack()">← Back to library</button>
      <h2 class="settings-title" id="settingsTitle" tabindex="-1">⚙ Settings &amp; Management</h2>
    </div>
    <div class="settings-grid">
      <section class="settings-card" aria-labelledby="settingsLibraryTitle">
        <h3 id="settingsLibraryTitle">Library management</h3>
        <div class="settings-sub">Collections</div>
        <p class="settings-text" id="settingsCollectionsText">${esc(settingsCollectionsText())}</p>
        <p class="settings-text">Create, rename, Archive or Unarchive collections, and edit their members.</p>
        <div class="settings-actions"><button class="btn settings-manage-collections" onclick="openManage('collections', null, this)">Manage collections…</button></div>
        <div class="settings-sub">Watch-with choices</div>
        <p class="settings-text" id="settingsChoicesText">${esc(settingsChoicesText())}</p>
        <div class="settings-actions"><button class="btn settings-manage-choices" onclick="openManage('choices', null, this)">Manage watch-with choices…</button></div>
      </section>
      <section class="settings-card" aria-labelledby="settingsCatalogTitle">
        <h3 id="settingsCatalogTitle">Catalog updates</h3>
        <p class="settings-text">The built-in catalogs add shows, seasons and films to your list only when you review and apply them.</p>
        <div class="settings-actions"><button class="btn settings-catalog-btn" onclick="openCatalogChooser(this)">Review catalog updates…</button></div>
      </section>
      <section class="settings-card" aria-labelledby="settingsBackupTitle">
        <h3 id="settingsBackupTitle" tabindex="-1">Backup &amp; Restore</h3>
        <p class="settings-status${status.cls ? ' ' + status.cls : ''}" id="settingsBackupStatus">${esc(status.text)}</p>
        <div class="settings-actions">
          <button class="btn" id="settingsBackupBtn" onclick="handleBackupClick(this)"${busy}>${backupBusy && backupPressedId === 'settingsBackupBtn' ? 'Backing up…' : BACKUP_LABELS.settingsBackupBtn}</button>
          <button class="btn settings-restore-btn" onclick="handleRestoreClick()">⬆ Restore from a backup file…</button>
        </div>
        <p class="settings-text">Restore checks the file first, downloads a safety copy of your current data, asks you to confirm, then replaces everything in one transaction. Leaving this screen before you confirm cancels it.</p>
      </section>
    </div>`;
}
