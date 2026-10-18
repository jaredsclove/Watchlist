// ─── Browser history and routes (S6: O1, D12, D13, D15, D17 B, D18) ───────────
// Every area, view, collection and Settings has a hash route (no filters, no names):
//   #/tv/watching  #/tv/alltv  #/tv/comingsoon  #/movies  #/collections[/<id>]  #/settings
// Hash routes work on GitHub Pages without any server change: a reload or a link with a route
// asks the server for the same page, and the page opens the routed view (D12), fresh, with its
// default filters. A missing or unknown route opens Currently Watching (an unknown one is replaced).
//
// Entries: each navigation you make pushes one entry; startup, the Collections area's resolution
// to a collection and the fallbacks replace the current one; filters, toggles, expansion, panels,
// dialogs (D17 B), writes, rereads and Retry add none. Each entry's state carries its number.
//
// Back / Forward (one step or several) navigate to the target entry's route: only that view's
// navigation reads; never a write, a resend, a retry or an Undo. The filters that entry had in this
// page come back from page memory (D15); after a reload there are none, so defaults. Dialogs:
// an idle view-bound one (a confirmation, Details, the Add picker) is closed by its Cancel rules
// (a submitting Add / Undo batch stops after its current request and reports in the target view);
// an idle Manage or catalog dialog, or a restore not yet sent, is closed (the preparation abandoned);
// a busy one (Manage saving, a catalog applying, a restore sent) stays open over the target view and
// finishes under its own rules. Close and Escape act on a dialog only and never touch history.
//
// Leaving the app can't be held: while a change is out or a restore has been sent, the page asks
// the browser to warn first (D18; browsers may not show it). A page brought back from the browser's
// back/forward cache reports a change that was out as not confirmed and reads the open view again.
const ROUTE_VIEWS = { 'tv/watching': 'watching', 'tv/alltv': 'alltv', 'tv/comingsoon': 'comingsoon', movies: 'allmovies', collections: 'collections', settings: 'settings' };

function routeOfView(id) {
  if (isBrowseCollectionView(id)) return `#/collections/${encodeURIComponent(id.slice(BROWSE_VIEW_PREFIX.length))}`;
  const key = Object.keys(ROUTE_VIEWS).find(k => ROUTE_VIEWS[k] === id);
  return key ? `#/${key}` : null;
}

// The view a hash names; null for an unknown or malformed route; '' for none.
function viewOfRoute(hash) {
  const h = String(hash || '');
  if (h === '' || h === '#' || h === '#/') return '';
  const m = h.match(/^#\/(.*)$/);
  if (!m) return null;
  if (ROUTE_VIEWS[m[1]]) return ROUTE_VIEWS[m[1]];
  const c = m[1].match(/^collections\/([0-9A-Za-z_-]{1,64})$/);
  return c ? BROWSE_VIEW_PREFIX + c[1] : null;
}

// The area a routed view belongs to (TV / Movies remember which one Collections and Settings return to).
function mediaOfView(id) {
  return id === ALL_MOVIES_VIEW.id ? 'movie' : DERIVED_VIEWS.some(v => v.id === id) ? 'tv' : null;
}

function historyUsable() {
  return typeof history !== 'undefined' && history && typeof history.pushState === 'function' && typeof location !== 'undefined';
}

// What this page remembers of an entry it has shown (page memory only): its view, filters and visit
// state, captured when the page leaves it.
function rememberRouteEntry() {
  if (!routeEntry || !activeViewId) return;
  const viewId = activeViewId;
  const tag = `view:${viewId}`;
  const filtersRow = document.getElementById('filtersRow');
  const shown = filtersRow && filtersRow.dataset && filtersRow.dataset.tab === tag;
  routeMemory.set(routeEntry, { viewId, filters: shown ? currentViewFilters(tag) : null, browseOrigin, settingsOrigin,
    allTvSeasonVis, browseSeasonVis, browseMedia });
}

// Called by switchView once the new view is set: push or replace this view's route (or nothing
// while a traversal is already on its entry).
function noteRoute(id, entryKind) {
  if (!historyUsable()) return;
  const resolution = ['remembered', 'default', 'fallback'].includes(entryKind);
  // The Collections area's resolution (or a fallback) replaces its entry, also when a traversal opened
  // the Collections state (the entry number stays; nothing is pushed).
  const mode = resolution ? 'replace' : routeNavMode || 'push';
  const url = routeOfView(id);
  if (!url || mode === 'none') return;
  if (mode === 'push' && location.hash === url) return; // already there: no extra entry
  if (mode === 'push') {
    routeEntry += 1;
    for (const n of [...routeMemory.keys()]) if (n >= routeEntry) routeMemory.delete(n); // the Forward entries are gone
    history.pushState({ watchlist: 1, n: routeEntry }, '', url);
  } else {
    history.replaceState({ watchlist: 1, n: routeEntry }, '', url);
  }
}

// Startup (D12): the route in the address opens its view; none opens Currently Watching; an unknown
// one opens Currently Watching and is replaced. Returns the view to open.
function startupView() {
  if (!historyUsable()) return activeViewId;
  const state = history.state;
  routeEntry = state && state.watchlist && Number.isInteger(state.n) ? state.n : 1;
  const view = viewOfRoute(location.hash);
  const id = view || 'watching';
  const media = mediaOfView(id);
  if (media) activeMediaType = media;
  if (isBrowseCollectionView(id)) nextCollectionEntryKind = 'route';
  routeNavMode = 'replace';
  return id;
}

// The entry directly behind is this view (an in-app Back link then uses the browser's Back, D3 / D4).
function routeBehindIs(viewId) {
  const prev = routeMemory.get(routeEntry - 1);
  return !!prev && prev.viewId === viewId && historyUsable();
}

// ── Back / Forward ──
function onRouteTraversal(event) {
  const state = event && event.state;
  const target = viewOfRoute(location.hash);
  // Focus that was in the content being replaced goes to the current area's button afterwards; focus
  // in a dialog, elsewhere in the header or outside the app is left alone (V6.15).
  const active = document.activeElement;
  const inContent = !!active && typeof active.closest === 'function' && !!active.closest('#mainContent, #tabBar, #browseBar');
  closeDialogsForTraversal();
  rememberRouteEntry();
  if (state && state.watchlist && Number.isInteger(state.n)) routeEntry = state.n;
  else { // a route typed or linked while the page is open: a new entry of its own (the Forward ones are gone)
    routeEntry += 1;
    for (const k of [...routeMemory.keys()]) if (k >= routeEntry) routeMemory.delete(k);
  }
  // An unknown route is replaced by Currently Watching's; an entry without a number gets one.
  if (target === null || !(state && state.watchlist)) history.replaceState({ watchlist: 1, n: routeEntry }, '', target === null ? '#/tv/watching' : location.hash);
  const id = target || 'watching';
  const mem = routeMemory.get(routeEntry);
  const remembered = mem && mem.viewId === id ? mem : null;
  const media = mediaOfView(id);
  if (media) activeMediaType = media;
  if (isBrowseCollectionView(id)) nextCollectionEntryKind = 'route';
  backNavFilters = remembered && remembered.filters ? { view: id, values: remembered.filters } : null;
  if (remembered) { browseOrigin = remembered.browseOrigin || null; settingsOrigin = remembered.settingsOrigin || null; }
  routeNavMode = 'none';
  try { switchView(id); } finally { routeNavMode = null; }
  if (remembered) { // that visit's state that isn't a filter control (as Settings' Back puts it back)
    if (id === 'alltv' && remembered.allTvSeasonVis) allTvSeasonVis = remembered.allTvSeasonVis;
    if (isBrowseCollectionView(id)) {
      if (remembered.browseSeasonVis) browseSeasonVis = remembered.browseSeasonVis;
      if (remembered.browseMedia) browseMedia = remembered.browseMedia;
    }
  }
  buildMediaSwitch();
  if (inContent && !anyDialogOpen() && documentHasFocus()) {
    const btn = document.getElementById(activeArea === 'settings' ? 'settingsBtn' : `areaBtn-${activeArea}`);
    if (btn && typeof btn.focus === 'function') btn.focus();
  }
}

// D17 B: dialogs don't survive a traversal unless they are busy.
function closeDialogsForTraversal() {
  if (typeof cancelEffectDialog === 'function') cancelEffectDialog();
  if (detailsDialog && !detailsDialog.saving && typeof closeDetails === 'function') closeDetails(); // the draft is discarded
  if (typeof addPickerOnNavigate === 'function') addPickerOnNavigate();
  if (manage && !manageHasPending()) closeManage();
  if (catalogDialog && !catalogBusy()) closeCatalogUpdates();
  if (catalogChooser && !catalogDialog && typeof closeCatalogChooser === 'function') closeCatalogChooser();
  if (typeof invalidateRestorePreparation === 'function') invalidateRestorePreparation(); // a restore already sent is never interrupted
}

function anyDialogOpen() {
  return ['manageModalOverlay', 'catalogModalOverlay', 'restoreModalOverlay', 'detailsModalOverlay', 'effectModalOverlay', 'addPickerOverlay']
    .some(id => { const el = document.getElementById(id); return !!el && el.style && el.style.display === 'flex'; });
}

// ── Leaving the app (D18) and coming back (the back/forward cache) ──
let leaveWarningOn = false;
function leaveWarning(event) {
  if (typeof event.preventDefault === 'function') event.preventDefault();
  event.returnValue = '';
  return '';
}
// Registered only while a change is out or a restore has been sent.
function updateLeaveWarning() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const need = !!writeLane || (typeof restoreInFlight !== 'undefined' && !!restoreInFlight);
  if (need === leaveWarningOn) return;
  leaveWarningOn = need;
  if (need) window.addEventListener('beforeunload', leaveWarning);
  else window.removeEventListener('beforeunload', leaveWarning);
}

// A page brought back from the back/forward cache: a change that was out isn't confirmed and is never
// sent again; the open view is read again.
function onPageShow(event) {
  if (!event || !event.persisted) return;
  // A running Add / Undo batch stops, and the item that was out becomes Not confirmed (Stop waiting's
  // path: its late answer is only recorded); a Remove or Undo answer arriving now changes nothing.
  pageShowEpoch++;
  if (typeof addBatch !== 'undefined' && addBatch && addBatch.phase === 'submitting') { addBatch.stop = true; if (addBatch.abandon) addBatch.abandon(); }
  const text = writeLane ? `${writeLane.label} wasn’t confirmed: you left the page while it was being saved, so it may or may not have been saved, and it won’t be sent again. The list is being read again.` : '';
  if (typeof reloadOpenView === 'function') reloadOpenView(); // (a reread clears the error line, so the message follows it)
  if (text) showError(text);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('popstate', onRouteTraversal);
  window.addEventListener('pageshow', onPageShow);
}
