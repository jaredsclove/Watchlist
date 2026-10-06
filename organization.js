// ─── Personal organization (Stage 3b-1) ──────────────────────────────────────
// Your collections (Disney+, Sheridan, 90 Day, True Crime / Docs, …) and which
// shows and films belong to each are stored apart from the tab a row is saved in
// (personal_collections, collection_memberships), and so are your watch-with
// choices (watch_with_choices: a row keeps a choice's token; its label is what is
// shown). This file only reads them. They load at startup without holding up the
// first view; until then, or if loading fails, the Browse collections selector
// says so and offers Retry, never an empty list. Watch-with choices have their own
// state: they are offered only once read (never the configured list or an older
// read in their place); while loading or after a failed read the controls say so
// (with Retry) and no watch-with change is sent. A database without these tables
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

// Every read of these tables (startup, Retry, a collection view, after a restore)
// takes a token when it starts. Only a read that started after the data now shown
// may replace it, and nothing read before a restore is published after it
// (invalidateOrganization), so an older read that finishes last can't bring back
// stale collections or labels.
function orgReadStart() {
  return { seq: ++orgReadSeq, epoch: orgEpoch };
}

function publishCollections(rows, read) {
  if (read.epoch !== orgEpoch || read.seq < orgCollectionsSeq) return false;
  orgCollectionsSeq = read.seq;
  personalCollections = rows;
  orgState = 'ready';
  return true;
}

// New watch-with labels redraw the open tab or browse view if they change what it
// shows (filter options, tags, pickers); otherwise nothing is redrawn.
function publishChoices(rows, read) {
  if (read.epoch !== orgEpoch || read.seq < orgChoicesSeq) return false;
  setWatchWith(() => { orgChoicesSeq = read.seq; watchWithChoices = rows; watchWithState = 'ready'; });
  return true;
}

// Changes the watch-with state and redraws the open view if what it shows changed.
function setWatchWith(change) {
  const before = watchWithSignature();
  change();
  if (watchWithSignature() !== before) redrawForWatchWith();
}

function watchWithSignature() {
  return JSON.stringify([watchWithState, watchWithChoiceList(), (watchWithChoices || []).map(c => [c.token, c.label])]);
}

// Only what shows watch-with is redrawn, and nothing else is rebuilt: in the
// Movies tab the watch-with filter is replaced in place (keeping its value when
// still offered, and keyboard focus) and the rows are redrawn with any open
// picker reopened — the Add entry form, the TMDB search, results and preview, and
// the other filters are untouched. A browse view redraws its read-only rows (they
// show watch-with labels). Other views have no watch-with controls.
function redrawForWatchWith() {
  const col = activeTabId ? COLLECTIONS.find(c => c.id === activeTabId) : null;
  if (col && col.isMovieTab && tabData[activeTabId] && tabData[activeTabId].loaded) {
    const wrap = document.getElementById('fWatchWithWrap');
    if (wrap) {
      const prev = document.getElementById('fWatchWith');
      const focused = document.activeElement && typeof document.activeElement.closest === 'function'
        && document.activeElement.closest('#fWatchWithWrap');
      wrap.innerHTML = watchWithFilterControlHtml(prev ? prev.value : '');
      if (focused) { const el = document.getElementById('fWatchWith'); if (el && typeof el.focus === 'function') el.focus(); }
    }
    redrawRowsKeepingPicker();
    return;
  }
  if (isBrowseView(activeViewId) && browseData && browseData.loaded) renderTable();
}

// Redraws the rows and reopens the watch-with picker that was open (same row, same
// table or card list), with focus back on the same choice.
function redrawRowsKeepingPicker() {
  const open = [...document.querySelectorAll('.more-popover')].find(p => p.style.display && p.style.display !== 'none');
  const listId = open && typeof open.closest === 'function' && open.closest('#cardList') ? 'cardList' : 'tbody';
  const active = document.activeElement;
  const focusedValue = open && active && typeof active.closest === 'function' && active.closest('.more-popover') === open ? active.value : null;
  renderTable();
  if (!open) return;
  const list = document.getElementById(listId);
  const again = list && list.querySelector(`[id="${open.id}"]`);
  if (!again) return;
  again.style.display = open.style.display;
  if (focusedValue != null) {
    const box = [...again.querySelectorAll('input')].find(i => i.value === focusedValue);
    if (box && typeof box.focus === 'function') box.focus();
  }
}

// After a restore: everything read before it is stale. The selector says it is
// loading until the post-restore read arrives.
function invalidateOrganization() {
  orgEpoch++;
  orgCollectionsSeq = 0;
  orgChoicesSeq = 0;
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
  // load, in the same restore epoch, when nothing of that kind was read since (so a
  // collection view's newer collections read never hides a failed choices read).
  const current = () => read.seq === orgLoadSeq && read.epoch === orgEpoch;
  const schemaAbsent = () => {
    orgState = 'absent';
    setWatchWith(() => { watchWithState = 'absent'; });
    buildBrowseBar();
  };
  const collections = fetchAllRowsStrict('personal_collections').then(rows => {
    if (publishCollections(rows, read)) buildBrowseBar();
  }, e => {
    if (!current()) return;
    if (isMissingTableError(e)) { schemaAbsent(); return; }
    if (orgCollectionsSeq > read.seq) return;
    orgState = 'unavailable';
    console.error(e);
    buildBrowseBar();
  });
  const choices = fetchAllRowsStrict('watch_with_choices').then(rows => { publishChoices(rows, read); }, e => {
    if (!current()) return;
    if (isMissingTableError(e)) { schemaAbsent(); return; }
    if (orgChoicesSeq === 0) {
      // Nothing read in this epoch: say so, never fall back to the configured list.
      setWatchWith(() => { watchWithState = 'unavailable'; });
      console.error(e);
    } else if (watchWithState === 'loading') {
      setWatchWith(() => { watchWithState = 'ready'; }); // keep this epoch's earlier successful read
    }
  });
  await Promise.all([collections, choices]);
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
// label. Only read choices are offered; the configured list only on a database
// without the table; nothing while loading or after a failed read.
function watchWithChoiceList() {
  if (watchWithState === 'absent') return WATCH_WITH_OPTIONS.map(w => ({ token: w, label: w }));
  if (watchWithState !== 'ready' || !watchWithChoices) return [];
  return watchWithChoices.filter(c => !c.archived_at)
    .sort((a, b) => (a.sort_order - b.sort_order) || cmpStr(a.token, b.token))
    .map(c => ({ token: c.token, label: c.label }));
}

function watchWithUsable() {
  return watchWithState === 'ready' || watchWithState === 'absent';
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
