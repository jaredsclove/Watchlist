// ─── Tab bar ──────────────────────────────────────────────────────────────────
function buildTabs() {
  const bar = document.getElementById('tabBar');
  // The views (Currently Watching, All TV, Coming Soon; All Movies). There are no
  // storage tabs (Stage 4b), and since Stage 5 no record has a storage at all.
  // An area with a single view (Movies: All Movies) has no secondary row at all; its
  // content heading names the view (B9).
  // Settings (S1) has no view tabs, and nor has the Collections area (S2): its chooser is drawn
  // by buildBrowseBar.
  const views = isSettingsView() || activeArea === 'collections' ? [] : tabViewsFor(activeMediaType);
  bar.hidden = views.length <= 1;
  bar.innerHTML = views.length <= 1 ? '' : views.map(v =>
    `<div class="tab${v.id===activeViewId?' active':''}" onclick="switchView('${v.id}')">
      <span class="tab-icon">${v.icon}</span>${esc(v.label)}
    </div>`
  ).join('');
  buildBrowseBar();
  updateRestoreVisibility();
}

// The primary buttons (S2: TV · Movies · Collections) and the header's Settings entry (S1):
// exactly one of them is the current page — the open area's button, or the gear on Settings.
function buildMediaSwitch() {
  const el = document.getElementById('mediaSwitch');
  const onSettings = isSettingsView();
  // S2: a redraw (also a later one, when Collections resolves or falls back after a read) keeps
  // keyboard focus on the Collections button if it is still there; TV and Movies are unchanged.
  const active = document.activeElement;
  const keepCollections = !!el && !!active && active.id === 'areaBtn-collections'
    && (typeof documentHasFocus !== 'function' || documentHasFocus());
  const cls = area => (activeArea === area ? ' active' : '');
  const cur = area => (activeArea === area ? ' aria-current="page"' : '');
  if (el) {
    el.innerHTML = `<button class="media-switch-btn${cls('tv')}" id="areaBtn-tv"${cur('tv')} onclick="switchMediaType('tv')"><span class="media-switch-icon" aria-hidden="true">📺</span> TV</button>`
      + `<button class="media-switch-btn${cls('movie')}" id="areaBtn-movie"${cur('movie')} onclick="switchMediaType('movie')"><span class="media-switch-icon" aria-hidden="true">🎬</span> Movies</button>`
      + `<button class="media-switch-btn${cls('collections')}" id="areaBtn-collections"${cur('collections')} onclick="openCollections(this)"><span class="media-switch-icon" aria-hidden="true">🗂</span> Collections</button>`;
    const again = keepCollections ? document.getElementById('areaBtn-collections') : null;
    if (again && again !== active && typeof again.focus === 'function') again.focus();
  }
  const entry = document.getElementById('settingsEntry');
  if (entry) entry.innerHTML = `<button class="btn gear-btn" id="settingsBtn" aria-label="Settings &amp; Management"${onSettings ? ' aria-current="page"' : ''} onclick="openSettings(this)">⚙ Settings</button>`;
}

function switchMediaType(type) {
  if (type === activeArea) return; // already there (TV on a TV view stays put); from Collections or Settings it lands
  activeMediaType = type;
  // Each area lands on its first view: TV → Currently Watching, Movies → All Movies.
  const firstView = landingViewFor(type);
  if (firstView) switchView(firstView.id);
  buildMediaSwitch();
}

// Opens a derived view, or a read-only browse view (browse-views.js).
function switchView(id) {
  // S3: another view answers an open effect dialog Cancel (nothing is sent). A reread of the
  // list being left (its busy mark and status line, an out-of-date mark) goes with it.
  if (typeof clearListReread === 'function') clearListReread();
  if (typeof cancelEffectDialog === 'function') cancelEffectDialog();
  if (routeNavMode !== 'none' && typeof rememberRouteEntry === 'function') rememberRouteEntry(); // S6 (D15): the entry being left, in page memory
  collectionUndo = null; // S4: Undo belongs to the collection visit it was offered in
  removeNotice = null;
  if (typeof addPickerOnNavigate === 'function') addPickerOnNavigate(); // S5: an idle picker closes; a running batch stops after its current request
  activeViewId = id;
  activeArea = areaOfView(id);
  // Back from a collection keeps its origin only while the Collections area is open,
  // and its saved filters only for the view it returns to.
  if (!isCollectionsAreaView(id)) browseOrigin = null;
  if (isBrowseCollectionView(id)) enterBrowseCollection(id);
  collectionEntry = isBrowseCollectionView(id) ? { viewId: id, kind: nextCollectionEntryKind || 'tab' } : null;
  if (typeof noteRoute === 'function') noteRoute(id, nextCollectionEntryKind); // S6: push or replace this view's route
  nextCollectionEntryKind = null;
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
  buildMediaSwitch();
  buildTabs();
  // The Collections state may have resolved its default inside buildTabs (buildBrowseBar):
  // that opened a collection, so this entry is over.
  if (activeViewId !== id) return;
  if (isSettingsView(id)) { renderSettings(); return; }
  if (isCollectionsStateView(id)) { renderCollectionsState(); return; }
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

// ─── Areas (S2) ───────────────────────────────────────────────────────────────
// The Collections area is a collection view (browse:<id>) or, while no collection is open
// yet, the Collections state (loading, unavailable, none…; browse-views.js).
const COLLECTIONS_VIEW_ID = 'collections';

function isCollectionsStateView(id = activeViewId) {
  return id === COLLECTIONS_VIEW_ID;
}

function isCollectionsAreaView(id = activeViewId) {
  return isCollectionsStateView(id) || isBrowseCollectionView(id);
}

function areaOfView(id) {
  if (isSettingsView(id)) return 'settings';
  if (isCollectionsAreaView(id)) return 'collections';
  return activeMediaType;
}

// Where a collection's Back returns when the Collections area is entered from here: a TV /
// Movies view with its filters; from Settings, Settings' own origin (D3). Null: no Back link.
function collectionsOriginFromHere() {
  if (isSettingsView()) {
    const o = settingsOrigin;
    if (!o || !o.viewId) return null;
    if (isCollectionsAreaView(o.viewId)) return o.browseOrigin || null;
    return { mediaType: o.mediaType, viewId: o.viewId, filters: o.filters || {} };
  }
  const viewId = activeViewId;
  if (!viewId || isCollectionsAreaView(viewId)) return null;
  return { mediaType: activeMediaType, viewId, filters: currentViewFilters(`view:${viewId}`) };
}

// The Collections button: the remembered collection (O2), else the first (browse-views.js
// resolveCollectionsDefault). Pressing it inside the area does nothing. The redrawn button
// keeps keyboard focus (buildMediaSwitch).
function openCollections(opener) {
  if (activeArea === 'collections') return;
  browseOrigin = collectionsOriginFromHere();
  switchView(COLLECTIONS_VIEW_ID);
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
  // S6 (D4): when the view it returns to is the entry directly behind, the browser's Back does it
  // (its filters come back from page memory), so the two Backs agree.
  if (origin && origin.viewId && typeof routeBehindIs === 'function' && routeBehindIs(origin.viewId)) { history.back(); return; }
  if (!origin || !origin.viewId) {
    activeMediaType = 'tv';
    buildMediaSwitch();
    switchView(landingViewFor('tv').id);
    buildMediaSwitch();
    return;
  }
  activeMediaType = origin.mediaType;
  backNavFilters = { view: origin.viewId, values: origin.filters || {} };
  browseOrigin = isCollectionsAreaView(origin.viewId) ? origin.browseOrigin || null : null;
  if (isBrowseCollectionView(origin.viewId)) nextCollectionEntryKind = 'return';
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
  if (orgState !== 'ready') return orgState === 'loading' ? 'Loading…' : 'Couldn’t be read. Open Collections and use Retry.';
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

// Credits (item 2): TMDB's attribution, as its terms ask: an approved logo, less prominent than the
// app's own, and the notice, in the app's credits.
function creditsSectionHtml() {
  return `<section class="settings-card settings-credits" aria-labelledby="settingsCreditsTitle">
        <h3 id="settingsCreditsTitle">Credits</h3>
        <a class="tmdb-credit-logo" href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer"><img src="assets/tmdb-logo.svg" alt="TMDB (The Movie Database)" width="110" height="14"></a>
        <p class="settings-text">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <p class="settings-text">Show, season, episode and film details, and the TMDB scores shown with shows, come from TMDB.</p>
      </section>`;
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
      ${accountSectionHtml()}
      ${episodeTitlesSettingHtml()}
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
      ${cuSettingsSectionHtml()}
      <section class="settings-card" aria-labelledby="settingsBackupTitle">
        <h3 id="settingsBackupTitle" tabindex="-1">Backup &amp; Restore</h3>
        <p class="settings-status${status.cls ? ' ' + status.cls : ''}" id="settingsBackupStatus">${esc(status.text)}</p>
        <div class="settings-actions">
          <button class="btn" id="settingsBackupBtn" onclick="handleBackupClick(this)"${busy}>${backupBusy && backupPressedId === 'settingsBackupBtn' ? 'Backing up…' : BACKUP_LABELS.settingsBackupBtn}</button>
          <button class="btn settings-restore-btn" onclick="handleRestoreClick()">⬆ Restore from a backup file…</button>
        </div>
        <p class="settings-text">Restore checks the file first, downloads a safety copy of your current data, asks you to confirm, then replaces everything in one transaction. Leaving this screen before you confirm cancels it.</p>
      </section>
      ${creditsSectionHtml()}
    </div>`;
  updateCuSettingsStatus(); // item 4 (collection-settings.js): a read only
}
