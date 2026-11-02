// ─── Personal organization (Stage 3b-1) ──────────────────────────────────────
// Your collections (Disney+, Sheridan, 90 Day, True Crime / Docs, …) and which
// shows and films belong to each are stored apart from the tab a row is saved in
// (personal_collections, collection_memberships), and so are your watch-with
// choices (watch_with_choices: a row keeps a choice's token; its label is what is
// shown). This file only reads them; organization-manage.js changes them. They load at startup without holding up the
// first view; until then, or if loading fails, the Browse collections selector
// says so and offers Retry, never an empty list. Watch-with choices have their own
// state: they are offered only once read (never the configured list or an older
// read in their place); while loading or after a failed read the controls say so
// (with Retry) and no watch-with change is sent. A database without these tables
// (the previous schema) gets "Collections unavailable" and the configured
// watch-with choices; nothing falls back to the storage tabs.

// Device layout keys of the four collections from before personal collections, by
// their presentation key (library_collection_presentation: how the page presents a
// collection it has always known; never where anything is placed), so their
// remembered Shows/Seasons and grouping survive. Every other collection uses its
// stable id. Renaming or archiving changes neither.
const ORG_LAYOUT_KEYS = {
  disney: 'watchlist_browse_layout_disney',
  sheridan: 'watchlist_browse_layout_sheridan',
  '90day': 'watchlist_browse_layout_90day',
  truecrime: 'watchlist_browse_layout_truecrime'
};
const ORG_COLLECTION_NOTES = {
  truecrime: 'Your existing combined list. True Crime and Documentary are not yet classified separately.'
};
const BROWSE_VIEW_PREFIX = 'browse:';

// Every read of these tables (startup, Retry, a collection view, after a change)
// takes a number and a read stamp when it starts. Only a read that started after the
// data now shown may replace it, and only if no change overlapped it (write-lane.js
// readFresh), so an older read that finishes last can't bring back stale collections
// or labels. A published read clears that kind's "may be out of date" flag if it is
// newer than the failed read that set it.
function orgReadStart() {
  return { seq: ++orgReadSeq, stamp: readStamp() };
}

function publishCollections(rows, read) {
  if (!readFresh(read.stamp) || read.seq < orgCollectionsSeq) return false;
  orgCollectionsSeq = read.seq;
  personalCollections = rows;
  orgState = 'ready';
  if (orgCollectionsStale && read.seq > orgCollectionsStale) orgCollectionsStale = 0;
  return true;
}

// New watch-with labels redraw the open tab or browse view if they change what it
// shows (filter options, tags, pickers); otherwise nothing is redrawn.
function publishChoices(rows, read) {
  if (!readFresh(read.stamp) || read.seq < orgChoicesSeq) return false;
  setWatchWith(() => {
    orgChoicesSeq = read.seq; watchWithChoices = rows; watchWithState = 'ready';
    if (orgChoicesStale && read.seq > orgChoicesStale) orgChoicesStale = 0;
  });
  return true;
}

// A refresh after a confirmed change failed: the kinds it couldn't read may be
// out of date (the data shown stays, marked so, with Retry). Only a read newer
// than the last published one of that kind can mark it, so an older failure never
// marks newer data stale.
function markOrgStale(kind, read) {
  if (kind === 'collections' && read.seq > orgCollectionsSeq && read.seq > orgCollectionsStale) { orgCollectionsStale = read.seq; buildBrowseBar(); }
  if (kind === 'choices' && read.seq > orgChoicesSeq && read.seq > orgChoicesStale) setWatchWith(() => { orgChoicesStale = read.seq; });
}

// Changes the watch-with state and redraws the open view if what it shows changed.
function setWatchWith(change) {
  const before = watchWithSignature();
  change();
  if (watchWithSignature() !== before) redrawForWatchWith();
  // Settings (S1) shows the watch-with count / state: its text only, in place (tabs.js; no request).
  if (typeof updateSettingsCounts === 'function') updateSettingsCounts();
}

function watchWithSignature() {
  return JSON.stringify([watchWithState, !!orgChoicesStale, watchWithChoiceList(), (watchWithChoices || []).map(c => [c.token, c.label, !!c.archived_at])]);
}

// Only what shows watch-with is redrawn, and nothing else is rebuilt: a browse
// view (All Movies, collections) redraws its rows (they show watch-with labels and
// pickers). Other views have no watch-with controls.
function redrawForWatchWith() {
  if (isBrowseView(activeViewId) && browseData && browseData.loaded) renderTable();
}


// After a restore: everything read before it is stale (no read that overlapped the
// restore publishes, write-lane.js). The selector says it is loading until the
// post-restore read arrives.
function invalidateOrganization() {
  if (typeof resetGovernance === 'function') resetGovernance(); // governance read before the restore speaks for nothing now
  orgCollectionsStale = 0;
  orgChoicesStale = 0;
  if (typeof manageInvalidate === 'function') manageInvalidate();
  orgEpoch++; // S4: a membership change or Undo prepared before the restore sends nothing
  collectionUndo = null;
  removeNotice = null;
  personalCollections = null;
  orgState = 'loading';
  setWatchWith(() => { watchWithChoices = null; watchWithState = 'loading'; });
  buildBrowseBar();
}

async function loadOrganization() {
  const read = orgReadStart();
  orgLoadSeq = read.seq;
  if (orgState !== 'ready') { orgState = 'loading'; buildBrowseBar(); }
  if (watchWithState !== 'ready') setWatchWith(() => { watchWithState = 'loading'; });
  // Each kind is published as soon as it arrives (the selector never waits for the
  // watch-with choices) and fails on its own: a failure matters only for the latest
  // load, when nothing of that kind was read since (so a collection view's newer
  // collections read never hides a failed choices read). A load refused because a
  // change overlapped it reads again once the lane is free.
  const current = () => read.seq === orgLoadSeq;
  const again = () => readAgainWhenFree(() => { if (orgLoadSeq === read.seq) loadOrganization(); });
  const collections = readPersonalCollections().then(rows => {
    if (publishCollections(rows, read)) buildBrowseBar();
    else if (current() && !readFresh(read.stamp) && orgCollectionsSeq < read.seq) again();
  }, e => {
    if (!current()) return;
    if (orgCollectionsSeq > read.seq) return;
    orgState = 'unavailable';
    console.error(e);
    buildBrowseBar();
  });
  const choices = fetchAllRowsStrict('watch_with_choices').then(rows => {
    if (!publishChoices(rows, read) && current() && !readFresh(read.stamp) && orgChoicesSeq < read.seq) again();
  }, e => {
    if (!current()) return;
    if (!watchWithChoices) {
      // Nothing read (since startup or a restore): say so, never fall back to the configured list.
      setWatchWith(() => { watchWithState = 'unavailable'; });
      console.error(e);
    } else if (watchWithState === 'loading') {
      setWatchWith(() => { watchWithState = 'ready'; }); // keep the earlier successful read
    }
  });
  await Promise.all([collections, choices]);
}

function compareCollections(a, b) {
  return (a.sort_order - b.sort_order) || compareTitles(a.name, b.name) || cmpStr(a.id, b.id);
}

// Every personal collection, with the catalog whose new records it receives (c.catalog:
// 'disney' / '90day' / 'sheridan', or null), read completely or not at all.
async function readPersonalCollections() {
  const [rows, catalogs, presentation] = await Promise.all([fetchAllRowsStrict('personal_collections'),
    fetchAllRowsStrict('library_collection_catalogs'), fetchAllRowsStrict('library_collection_presentation')]);
  const byId = new Map(catalogs.map(x => [x.collection_id, x.catalog]));
  const shown = new Map(presentation.map(x => [x.collection_id, x.presentation_key]));
  return rows.map(c => ({ ...c, catalog: byId.get(c.id) || null, presentation: shown.get(c.id) || null }));
}

// A collection as a browse destination. A catalog's collection keeps the device
// layout key it had before personal collections; any other uses its stable id.
function browseDestFromCollection(c) {
  const catalog = c.catalog || null;
  return {
    id: BROWSE_VIEW_PREFIX + c.id,
    collectionId: c.id,
    label: c.name,
    catalog,
    note: c.presentation ? ORG_COLLECTION_NOTES[c.presentation] : undefined,
    layoutKey: ORG_LAYOUT_KEYS[c.presentation] || `watchlist_browse_layout_id_${c.id}`,
    archived: !!c.archived_at
  };
}

// The selector's collections: not archived, in your order.
function activeBrowseCollections() {
  return (personalCollections || []).filter(c => !c.archived_at).sort(compareCollections).map(browseDestFromCollection);
}

function isBrowseCollectionView(id) {
  return typeof id === 'string' && id.startsWith(BROWSE_VIEW_PREFIX);
}

// Which shows and films are in one collection.
function membersOf(memberships, collectionId) {
  const showIds = new Set(), filmIds = new Set();
  (memberships || []).forEach(m => {
    if (m.collection_id !== collectionId) return;
    if (m.show_id != null) showIds.add(m.show_id);
    else if (m.item_id != null) filmIds.add(m.item_id);
  });
  return { showIds, filmIds };
}

// Watch-with: the choices to offer (not archived, in your order) and a token's
// label. Only read choices are offered; nothing while loading or after a failed read.
function watchWithChoiceList() {
  if (watchWithState !== 'ready' || !watchWithChoices) return [];
  return watchWithChoices.filter(c => !c.archived_at)
    .sort((a, b) => (a.sort_order - b.sort_order) || cmpStr(a.token, b.token))
    .map(c => ({ token: c.token, label: c.label }));
}

function watchWithUsable() {
  return watchWithState === 'ready';
}

// What the watch-with controls show instead of choices while they can't be used.
function watchWithStatusHtml() {
  if (watchWithState === 'loading') return 'Watch-with choices are loading…';
  if (watchWithState === 'unavailable') return `Watch-with choices couldn’t be loaded. <button class="btn" onclick="loadOrganization()">Retry</button>`;
  return '';
}

function watchWithLabel(token) {
  const c = (watchWithChoices || []).find(x => x.token === token);
  return c ? c.label : token;
}

// Whether a token is one of your archived choices (as last read).
function watchWithArchived(token) {
  const c = (watchWithChoices || []).find(x => x.token === token);
  return !!(c && c.archived_at);
}

