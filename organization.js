// ─── Personal organization (Stage 3b-1) ──────────────────────────────────────
// Your collections (Disney+, Sheridan, 90 Day, True Crime / Docs, …) and which
// shows and films belong to each are stored apart from the tab a row is saved in
// (personal_collections, collection_memberships), and so are your watch-with
// choices (watch_with_choices: a row keeps a choice's token; its label is what is
// shown). This file only reads them. They load at startup without holding up the
// first view; until then, or if loading fails, the Browse collections selector
// says so and offers Retry, never an empty list. A database without these tables
// (the previous schema) gets "Collections unavailable" and the configured
// watch-with choices; nothing falls back to the storage tabs.

// Device layout keys of the four collections that existed before personal
// collections, kept so their remembered Shows/Seasons and grouping survive.
// Every other collection uses its stable id. Renaming or archiving changes neither.
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

// PostgREST's answer for a table that doesn't exist (the previous schema).
function isMissingTableError(e) {
  const msg = String(e && e.message || '');
  return /: 404 /.test(msg) && msg.includes('PGRST205');
}

async function loadOrganization() {
  const seq = ++orgLoadSeq;
  orgState = 'loading';
  buildBrowseBar();
  try {
    const [collections, choices] = await Promise.all([fetchAllRowsStrict('personal_collections'), fetchAllRowsStrict('watch_with_choices')]);
    if (seq !== orgLoadSeq) return;
    personalCollections = collections;
    watchWithChoices = choices;
    orgState = 'ready';
  } catch (e) {
    if (seq !== orgLoadSeq) return;
    orgState = isMissingTableError(e) ? 'absent' : 'unavailable';
    if (orgState === 'unavailable') console.error(e);
  }
  buildBrowseBar();
}

function compareCollections(a, b) {
  return (a.sort_order - b.sort_order) || compareTitles(a.name, b.name) || cmpStr(a.id, b.id);
}

// A collection as a browse destination.
function browseDestFromCollection(c) {
  const source = c.legacy_source || null;
  return {
    id: BROWSE_VIEW_PREFIX + c.id,
    collectionId: c.id,
    label: c.name,
    legacySource: source,
    note: source ? ORG_COLLECTION_NOTES[source] : undefined,
    layoutKey: ORG_LAYOUT_KEYS[source] || `watchlist_browse_layout_id_${c.id}`,
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
// label. Before the choices load, or without the table, the configured list.
function watchWithChoiceList() {
  if (!watchWithChoices) return WATCH_WITH_OPTIONS.map(w => ({ token: w, label: w }));
  return watchWithChoices.filter(c => !c.archived_at)
    .sort((a, b) => (a.sort_order - b.sort_order) || cmpStr(a.token, b.token))
    .map(c => ({ token: c.token, label: c.label }));
}

function watchWithLabel(token) {
  const c = (watchWithChoices || []).find(x => x.token === token);
  return c ? c.label : token;
}
