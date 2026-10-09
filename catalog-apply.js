// ─── Catalog updates (Stage 4a) ───────────────────────────────────────────────
// Opening a built-in tab (Disney+, 90 Day, Sheridan) never writes. The tab says
// how many catalog entries are waiting, and Review opens this dialog:
//   1. a freshness check: config.js read again (no cache); if its catalog for
//      this tab differs from the one this page loaded, Apply is not offered;
//   2. a preview from the database (public.catalog_apply without a hash): the
//      exact effects document, computed by running the application and rolling
//      it back, and its hash;
//   3. Apply sends the same catalog with that hash; the database commits only if
//      the effects it actually performs have exactly that hash, and returns the
//      execution receipt (the ids it created or changed);
//   4. a bounded read-back of the receipt's records before saying "verified".
// No answer is never treated as success or failure: the outcome is unknown, and
// "Check current state" reports only what the library holds now, never which
// request made it. Nothing is ever sent again automatically.
// Dialog state lives in watchlist.html (catalogDialog, catalogSession).

// Canonical JSON: object keys sorted (by code point), arrays in order, no
// whitespace; the same form as private.catalog_canon in db/phase4a_catalog.sql.
function catalogCanonical(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(catalogCanonical).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v).filter(k => v[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(k => `${JSON.stringify(k)}:${catalogCanonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

async function catalogSha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// The payload hash: what approval binds (the database computes the same one).
function catalogPayloadHash(defaults) {
  return catalogSha256(catalogCanonical(defaults));
}

function catalogDefaultsOf(collectionId, collections = COLLECTIONS) {
  const col = collections.find(c => c.id === collectionId);
  return col && Array.isArray(col.defaults) ? col.defaults : [];
}

// How many of this page's catalog entries the tab doesn't hold yet: a missing key,
// or a stored TBA date the catalog now dates. The same test the tab used to write
// with; only a hint (conflicts, for example, stay counted). The preview decides.
function catalogPendingCount(collectionId, rows) {
  const defaults = catalogDefaultsOf(collectionId);
  if (!defaults.length) return 0;
  const byKey = new Map();
  (rows || []).forEach(r => { if (!byKey.has(r.item_key)) byKey.set(r.item_key, []); byKey.get(r.item_key).push(r); });
  let n = 0;
  for (const d of defaults) {
    const rs = byKey.get(d.k);
    if (!rs) n++;
    else if (!/TBA/i.test(d.d || '') && rs.some(r => /TBA/i.test(r.display_date || ''))) n++;
  }
  return n;
}

// The tab's notice (shown in the banner area; it writes nothing).
function showCatalogNotice(collectionId) {
  const banner = document.getElementById('banner');
  if (!banner || activeTabId !== collectionId) return;
  const td = tabData[collectionId];
  const n = td && td.loaded ? catalogPendingCount(collectionId, td.rows) : 0;
  banner.innerHTML = n
    ? `<div class="banner catalog-banner">${n} catalog ${n === 1 ? 'entry is' : 'entries are'} waiting for this tab. Nothing changes until you review and apply ${n === 1 ? 'it' : 'them'}. <button class="btn" onclick="openCatalogUpdates('${esc(collectionId)}', this)">Review</button></div>`
    : '';
}

// ── The permanent entry (Stage 4b): a chooser of the built-in catalogs ──
// "Catalog updates" in the Browse bar lists each catalog with a hint of how many
// of its entries the library doesn't hold (catalogPendingCount over a complete
// read of that catalog's rows; GET only) and opens the dialog below for one.
function catalogIds() {
  return COLLECTIONS.filter(c => catalogDefaultsOf(c.id).length).map(c => c.id);
}

function openCatalogChooser(openerEl) {
  if (catalogDialog || catalogChooser) return;
  const session = ++catalogSession;
  catalogChooser = { session, opener: openerEl || document.activeElement || null, hints: {} };
  const ids = catalogIds();
  ids.forEach(id => { catalogChooser.hints[id] = { state: 'reading' }; });
  document.getElementById('catalogModalOverlay').style.display = 'flex';
  renderCatalogChooser();
  const box = document.getElementById('catalogModalBox');
  if (box && typeof box.focus === 'function') box.focus();
  ids.forEach(id => catalogChooserHint(session, id));
}

async function catalogChooserHint(session, id) {
  let hint;
  try {
    const rows = await fetchAllRowsStrict(TABLE, `collection=eq.${encodeURIComponent(id)}`);
    hint = { state: 'ready', n: catalogPendingCount(id, rows) };
  } catch (e) {
    hint = { state: 'failed' };
  }
  if (!catalogChooser || catalogChooser.session !== session) return;
  catalogChooser.hints[id] = hint;
  renderCatalogChooser();
}

function renderCatalogChooser() {
  const box = document.getElementById('catalogModalBox');
  if (!box || !catalogChooser) return;
  const hintText = h => h.state === 'reading' ? 'Checking…' : h.state === 'failed' ? 'Couldn’t check (Review still works)'
    : h.n ? `${h.n} ${h.n === 1 ? 'entry' : 'entries'} not in your list yet` : 'Nothing waiting';
  const items = catalogIds().map(id => {
    const label = COLLECTIONS.find(c => c.id === id)?.label || id;
    return `<li class="manage-item"><div class="manage-line"><span class="manage-name">${esc(label)} catalog</span>
      <span class="manage-meta">${esc(hintText(catalogChooser.hints[id] || { state: 'reading' }))}</span>
      <button class="btn" onclick="catalogChooserReview('${esc(id)}')">Review</button></div></li>`;
  }).join('');
  const active = document.activeElement;
  const hadFocus = !!active && (active === document.body || (typeof box.contains === 'function' && box.contains(active)));
  box.innerHTML = `<h2 class="modal-title" id="catalogTitle">Catalog updates</h2>
    <div class="manage-body"><p class="manage-message">The built-in catalogs add shows, seasons and films to your list only when you review and apply them. The counts are a hint; the review decides.</p>
    <ul class="manage-list">${items}</ul></div>
    <div class="modal-actions"><button class="btn" onclick="closeCatalogChooser()">Close</button></div>`;
  if (hadFocus && typeof box.focus === 'function') box.focus();
}

function closeCatalogChooser(keepOpen) {
  if (!catalogChooser) return;
  const opener = catalogChooser.opener;
  catalogChooser = null;
  if (keepOpen) return opener;
  document.getElementById('catalogModalOverlay').style.display = 'none';
  document.getElementById('catalogModalBox').innerHTML = '';
  const back = opener && opener.isConnected ? opener : document.querySelector('#browseBar .catalog-btn');
  if (back && typeof back.focus === 'function') back.focus();
  return opener;
}

function catalogChooserReview(id) {
  if (!catalogChooser) return;
  const opener = closeCatalogChooser(true);
  openCatalogUpdates(id, opener);
}

// ── Dialog ──
function openCatalogUpdates(collectionId, openerEl) {
  if (catalogDialog || !catalogDefaultsOf(collectionId).length) return;
  catalogDialog = { session: ++catalogSession, collectionId, opener: openerEl || document.activeElement || null,
    phase: 'checking', error: '', defaults: null, preview: null, approved: null, result: null, readBack: null, check: null };
  document.getElementById('catalogModalOverlay').style.display = 'flex';
  renderCatalogDialog();
  const box = document.getElementById('catalogModalBox');
  if (box && typeof box.focus === 'function') box.focus();
  catalogReview();
}

function catalogBusy() {
  return !!catalogDialog && ['applying', 'checking-state'].includes(catalogDialog.phase);
}

function closeCatalogUpdates() {
  if (!catalogDialog || catalogBusy()) return;
  const { opener, collectionId } = catalogDialog;
  catalogDialog = null;
  document.getElementById('catalogModalOverlay').style.display = 'none';
  document.getElementById('catalogModalBox').innerHTML = '';
  showCatalogNotice(collectionId);
  // The notice is redrawn, so its Review button is a new element: focus that one (or,
  // when nothing is waiting any more, the open tab), never leave focus on the page.
  const back = opener && opener.isConnected ? opener
    : document.querySelector('#browseBar .catalog-btn') || document.querySelector('#banner .catalog-banner button') || document.querySelector('#tabBar .tab.active');
  if (back && typeof back.focus === 'function') back.focus();
}

function catalogKeydown(event) {
  if (!catalogDialog && !catalogChooser) return;
  if (event.key === 'Escape') { event.preventDefault(); if (catalogDialog) closeCatalogUpdates(); else closeCatalogChooser(); return; }
  if (event.key !== 'Tab') return;
  const box = document.getElementById('catalogModalBox');
  const items = [...box.querySelectorAll('button')].filter(el => !el.disabled && el.offsetParent !== null);
  if (!items.length) { event.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === box)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

// The published config.js, read again without the browser cache, evaluated in
// isolation (it only declares constants). Returns that tab's catalog.
async function catalogPublishedDefaults(collectionId) {
  const res = await fetch('config.js', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config.js answered ${res.status}`);
  const text = await res.text();
  const collections = new Function(`${text}\n;return COLLECTIONS;`)();
  return catalogDefaultsOf(collectionId, collections);
}

const catalogLive = session => !!catalogDialog && catalogDialog.session === session;

// Freshness check, then a preview.
async function catalogReview() {
  if (!catalogDialog) return;
  const d = catalogDialog, session = d.session;
  d.phase = 'checking'; d.error = ''; d.preview = null; d.approved = null; d.result = null; d.readBack = null; d.check = null;
  renderCatalogDialog();
  const loaded = catalogDefaultsOf(d.collectionId);
  try {
    const published = await catalogPublishedDefaults(d.collectionId);
    const [a, b] = await Promise.all([catalogPayloadHash(loaded), catalogPayloadHash(published)]);
    if (!catalogLive(session)) return;
    if (a !== b) { d.phase = 'outdated'; renderCatalogDialog(); return; }
    d.defaults = loaded;
    d.payloadHash = a;
  } catch (e) {
    if (!catalogLive(session)) return;
    d.phase = 'unverified'; d.error = String(e && e.message || e); renderCatalogDialog(); return;
  }
  d.phase = 'previewing';
  renderCatalogDialog();
  try {
    const res = await sbRpc('catalog_apply', { p_collection: d.collectionId, p_defaults: d.defaults });
    if (!catalogLive(session)) return;
    d.preview = res;
    d.phase = 'preview';
  } catch (e) {
    if (!catalogLive(session)) return;
    catalogFailed(d, e, false);
  }
  renderCatalogDialog();
}

// A refusal or error the database answered (nothing from this request persists),
// or no usable answer (unknown, only for an apply).
function catalogFailed(d, e, wasApply) {
  const info = orgErrorInfo(e);
  if (info.kind !== 'database') {
    if (wasApply) { d.phase = 'unknown'; d.error = info.message; return; }
    d.phase = 'failed'; d.error = info.message; return;
  }
  if (info.status === 404 && info.pgCode === 'PGRST202') { d.phase = 'absent'; return; }
  if (info.code === 'catalog_stale') { d.phase = 'stale'; return; }
  if (info.code === 'catalog_busy' || ['55P03', '40P01', '57014'].includes(info.pgCode)) { d.phase = 'busy'; return; }
  d.phase = 'failed'; d.error = info.code ? orgRefusalText(info) : info.message;
}

async function catalogApply() {
  const d = catalogDialog;
  if (!d || d.phase !== 'preview' || !d.preview || !catalogEffectCount(d.preview.document)) return;
  const session = d.session;
  d.approved = { hash: d.preview.hash, document: d.preview.document, defaults: d.defaults };
  d.phase = 'applying';
  renderCatalogDialog();
  let res;
  try {
    res = await sbRpc('catalog_apply', { p_collection: d.collectionId, p_defaults: d.approved.defaults, p_approved: d.approved.hash });
  } catch (e) {
    if (!catalogLive(session)) return;
    catalogFailed(d, e, true);
    renderCatalogDialog();
    return;
  }
  if (!catalogLive(session)) return;
  if (!res || res.mode !== 'applied' || res.hash !== d.approved.hash) {
    d.phase = 'unknown'; d.error = 'The answer was not the expected confirmation.';
    renderCatalogDialog();
    return;
  }
  d.result = res;
  d.phase = 'applied';
  d.readBack = { state: 'reading' };
  renderCatalogDialog();
  await catalogVerify(session);
  // The tab, or the open view (Stage 4b), shows the new state (read again; nothing is written).
  delete tabData[d.collectionId];
  if (activeTabId === d.collectionId) loadTab(d.collectionId);
  else if (activeViewId) reloadOpenView();
}

// ── Comparing the library with the approved outcomes ──
// One comparison, used by the read-back after a committed apply (with the
// receipt: records by its ids, which must also match their natural keys and the
// approved links) and by "Check current state" after an unknown outcome (no
// receipt: records by their natural keys, each of which must be unique). Every
// read is strict (exact counts, aligned pages; fetchAllRowsStrict): a read that
// can't be completed throws, so absence is never inferred from it.
//
// Outcome map (effects document field → comparison; receipt value → check):
//   header: collection = this tab; target.archived = the collection's state now;
//           version, owner, payload_hash and the entries themselves are bound by
//           the approved hash (the apply answers with the same hash).
//   create_show: show_key, tmdb_id (natural key, unique); title; initial_status = status;
//           receipt show_id = that show.
//   attach: show_id exists; show_key; status (Complete → On List when this apply reopens it).
//   insert_season: item_key (unique in the tab); title, season, theme, display_date,
//           date_sort, status, watched, skipped, media_type, tmdb_id, season_number;
//           show link = the approved show (created ref or existing id);
//           receipt row_id = that row, receipt show_id = the approved show.
//   insert_film: item_key (unique); title, season, theme, display_date, date_sort,
//           status, watched, media_type, tmdb_id; unlinked; receipt row_id = that row.
//   fill_date: row_id exists with item_key; new_display, new_sort; item (film =
//           unlinked, season = linked to show_id); tracking.watched; film
//           tracking.status; season tracking.skipped and tracking.show_status of
//           show_id (On List when this apply reopens it); receipt row_id = row_id.
//           old_display / old_sort are bound by the hash (the pre-state).
//   reopen: show_id status = to; the cause row is stored and linked to that show;
//           receipt show_id = show_id. from is bound by the hash.
//   membership: collection_id = the header's target; result joined = exactly one
//           membership of the new record, in that collection; not_joined /
//           no_collection = none at all; receipt membership_id = that membership,
//           or "none" exactly when not joined.
//   excluded_conflict: item_key still not stored (reason, conflicting_id: informational).
//   noop: item_key still stored; category identified = a stored row with it has a TMDB id.
//   receipt: exactly one entry per create_show, insert_season, insert_film,
//           fill_date, reopen and membership entry, no other.
const catalogInList = ids => `in.(${ids.map(id => encodeURIComponent(`"${id}"`)).join(',')})`;
const CATALOG_RECEIPT_KINDS = ['create_show', 'insert_season', 'insert_film', 'fill_date', 'reopen', 'membership'];
const CATALOG_COMPARED_FIELDS = {
  create_show: ['title', 'tmdb_id'],
  insert_season: ['title', 'season', 'theme', 'display_date', 'date_sort', 'status', 'watched', 'skipped', 'media_type', 'tmdb_id', 'season_number'],
  insert_film: ['title', 'season', 'theme', 'display_date', 'date_sort', 'status', 'watched', 'media_type', 'tmdb_id']
};

async function catalogReadState(collectionId, doc) {
  const filter = `collection=eq.${encodeURIComponent(collectionId)}`;
  const [rows, shows, target] = await Promise.all([
    fetchAllRowsStrict(TABLE, filter), fetchAllRowsStrict('tv_shows', filter),
    doc.target ? fetchAllRowsStrict('personal_collections', `id=eq.${encodeURIComponent(doc.target.collection_id)}`) : Promise.resolve([])]);
  return { rows, shows, target: target[0] || null };
}

async function catalogCompareOutcomes(collectionId, doc, receipt) {
  const st = await catalogReadState(collectionId, doc);
  const diffs = [];
  const say = m => diffs.push(m);
  const same = (a, b) => (a ?? null) === (b ?? null);
  const of = kind => doc.entries.filter(e => e.kind === kind);
  const rc = key => (receipt && receipt[key]) || {};
  const rowById = new Map(st.rows.map(r => [r.id, r])), showById = new Map(st.shows.map(x => [x.id, x]));
  const reopened = new Set(of('reopen').map(e => e.show_id));
  const compare = (what, rec, fields, e) => {
    const bad = fields.filter(f => !same(rec[f], e[f]));
    if (bad.length) say(`${what}: ${bad.join(', ')} ${bad.length === 1 ? 'differs' : 'differ'} from what was approved`);
  };
  const rowsWithKey = key => st.rows.filter(r => r.item_key === key);

  if (doc.collection !== collectionId) say('the approved changes are for another catalog');
  if (receipt) {
    const want = doc.entries.filter(e => CATALOG_RECEIPT_KINDS.includes(e.kind)).map(e => e.key).sort();
    if (JSON.stringify(want) !== JSON.stringify(Object.keys(receipt).sort())) say('the receipt doesn’t list exactly the approved changes');
  }
  const refRec = {};
  for (const e of of('create_show')) {
    const byKey = st.shows.filter(x => x.show_key === e.show_key && same(x.tmdb_id, e.tmdb_id));
    const rec = receipt ? showById.get(rc(e.key).show_id) : (byKey.length === 1 ? byKey[0] : null);
    if (!rec || !byKey.includes(rec)) { say(`new show ${e.title}: ${receipt ? 'not found as recorded' : byKey.length > 1 ? 'more than one' : 'not found'}`); continue; }
    refRec[e.ref] = rec;
    compare(`new show ${e.title}`, rec, CATALOG_COMPARED_FIELDS.create_show, e);
    if (rec.status !== e.initial_status) say(`new show ${e.title}: status differs from what was approved`);
  }
  for (const e of of('attach')) {
    const show = showById.get(e.show_id);
    if (!show || show.show_key !== e.show_key) { say(`${e.show_key}: the show is not found`); continue; }
    if (show.status !== (reopened.has(e.show_id) ? 'confirmed' : e.status)) say(`${show.title}: status differs from what was approved`);
  }
  const insertedRow = e => {
    const byKey = rowsWithKey(e.item_key);
    if (byKey.length !== 1) { say(`${e.item_key}: ${byKey.length ? `stored ${byKey.length} times` : 'not found'}`); return null; }
    if (receipt && rc(e.key).row_id !== byKey[0].id) { say(`${e.item_key}: the receipt names another row`); return null; }
    return byKey[0];
  };
  for (const e of of('insert_season')) {
    const rec = insertedRow(e);
    if (!rec) continue;
    const showId = refRec[e.show] ? refRec[e.show].id : e.show;
    if (rec.show_id !== showId) say(`${e.item_key}: not linked to the approved show`);
    if (receipt && rc(e.key).show_id !== showId) say(`${e.item_key}: the receipt names another show`);
    compare(e.item_key, rec, CATALOG_COMPARED_FIELDS.insert_season, e);
  }
  for (const e of of('insert_film')) {
    const rec = insertedRow(e);
    if (!rec) continue;
    refRec[e.ref] = rec;
    if (rec.show_id != null) say(`${e.item_key}: linked to a show`);
    compare(e.item_key, rec, CATALOG_COMPARED_FIELDS.insert_film, e);
  }
  for (const e of of('fill_date')) {
    if (receipt && rc(e.key).row_id !== e.row_id) say(`${e.item_key}: the receipt names another row`);
    const rec = rowById.get(e.row_id);
    if (!rec || rec.item_key !== e.item_key) { say(`${e.item_key}: the dated row is not found`); continue; }
    if (rec.display_date !== e.new_display || rec.date_sort !== e.new_sort) say(`${e.item_key}: the date is ${rec.display_date}, not ${e.new_display}`);
    const t = e.tracking || {};
    if (!same(!!rec.watched, !!t.watched)) say(`${e.item_key}: watched differs from what was approved`);
    if (e.item === 'film') {
      if (rec.show_id != null) say(`${e.item_key}: linked to a show`);
      if (!same(rec.status, t.status)) say(`${e.item_key}: status differs from what was approved`);
    } else {
      if (!same(!!rec.skipped, !!t.skipped)) say(`${e.item_key}: skipped differs from what was approved`);
      if (!e.show_id || rec.show_id !== e.show_id) { say(`${e.item_key}: not linked to the approved show`); continue; }
      const show = showById.get(e.show_id);
      const wanted = reopened.has(e.show_id) ? 'confirmed' : t.show_status;
      if (!show || show.status !== wanted) say(`${e.item_key}: its show's status differs from what was approved`);
    }
  }
  for (const e of of('reopen')) {
    if (receipt && rc(e.key).show_id !== e.show_id) say('the receipt names another reopened show');
    const show = showById.get(e.show_id);
    if (!show || show.status !== e.to) say(`${(show && show.title) || 'a show'} is not On List`);
    if (!st.rows.some(r => r.item_key === e.cause && r.show_id === e.show_id)) say(`${e.cause}: the season that reopened its show is not stored on it`);
  }
  for (const e of of('excluded_conflict')) {
    if (rowsWithKey(e.item_key).length) say(`${e.item_key} (not included for review) is now stored`);
  }
  for (const e of of('noop')) {
    const held = rowsWithKey(e.item_key);
    if (!held.length) say(`${e.item_key} (already present) is no longer stored`);
    else if ((e.category === 'identified') !== held.some(r => r.tmdb_id != null)) say(`${e.item_key}: its identity differs from what was approved`);
  }
  const memberships = of('membership');
  const recIds = memberships.map(e => refRec[e.ref] && refRec[e.ref].id).filter(Boolean);
  let mems = [];
  if (recIds.length) {
    const showIds = recIds.filter(id => showById.has(id)), itemIds = recIds.filter(id => rowById.has(id));
    const [a, b] = await Promise.all([
      showIds.length ? fetchAllRowsStrict('collection_memberships', `show_id=${catalogInList(showIds)}`) : Promise.resolve([]),
      itemIds.length ? fetchAllRowsStrict('collection_memberships', `item_id=${catalogInList(itemIds)}`) : Promise.resolve([])]);
    mems = a.concat(b);
  }
  for (const e of memberships) {
    if (!same(e.collection_id, doc.target && doc.target.collection_id)) say(`${e.ref}: its approved collection isn’t this catalog’s`);
    const rec = refRec[e.ref];
    if (!rec) continue; // reported above
    const mine = mems.filter(m => m.show_id === rec.id || m.item_id === rec.id);
    if (e.result === 'joined') {
      if (mine.length !== 1 || mine[0].collection_id !== e.collection_id) say(`${e.ref}: not exactly in its approved collection`);
      else if (receipt && rc(e.key).membership_id !== mine[0].id) say(`${e.ref}: the receipt names another membership`);
    } else {
      if (mine.length) say(`${e.ref}: in a collection, though the approved result was ${e.result === 'not_joined' ? 'to stay out of the archived one' : 'none'}`);
      if (receipt && rc(e.key).membership_id !== 'none') say(`${e.ref}: the receipt names a membership, though none was approved`);
    }
  }
  if (doc.target && (!st.target || !!st.target.archived_at !== !!doc.target.archived)) say('the collection’s archive state differs from the approved state');
  return { matches: diffs.length === 0, differences: diffs };
}

async function catalogVerify(session) {
  const d = catalogDialog;
  if (!d || !d.result) return;
  d.readBack = { state: 'reading' };
  renderCatalogDialog();
  try {
    const out = await catalogCompareOutcomes(d.collectionId, d.result.document, d.result.receipt || {});
    if (!catalogLive(session)) return;
    d.readBack = { state: out.matches ? 'verified' : 'differs', differences: out.differences };
  } catch (e) {
    if (!catalogLive(session)) return;
    d.readBack = { state: 'unread', error: String(e && e.message || e) };
  }
  renderCatalogDialog();
}

// ── After an unknown outcome: what the library holds now (never who did it) ──
const CATALOG_EFFECT_KINDS = ['create_show', 'insert_season', 'insert_film', 'fill_date', 'reopen'];
function catalogEffectCount(doc) {
  return doc ? doc.entries.filter(e => CATALOG_EFFECT_KINDS.includes(e.kind)).length : 0;
}

// Compares the current records with the approved outcomes (no receipt: by natural
// keys) and takes a fresh preview of the same catalog. Present only when every
// approved outcome holds exactly; "still waiting" only when the fresh preview has
// the approved hash; otherwise different, with the differences. Never attributes,
// never resends.
async function catalogCheckState() {
  const d = catalogDialog;
  if (!d || !d.approved || !['unknown', 'checked'].includes(d.phase)) return;
  const session = d.session;
  d.phase = 'checking-state';
  renderCatalogDialog();
  let res, cmp;
  try {
    [cmp, res] = await Promise.all([
      catalogCompareOutcomes(d.collectionId, d.approved.document, null),
      sbRpc('catalog_apply', { p_collection: d.collectionId, p_defaults: d.approved.defaults })]);
  } catch (e) {
    if (!catalogLive(session)) return;
    d.phase = 'unknown';
    d.error = `Couldn't read the current state (${orgErrorInfo(e).message}).`;
    renderCatalogDialog();
    return;
  }
  if (!catalogLive(session)) return;
  d.check = cmp.matches ? 'present' : res.hash === d.approved.hash ? 'still-planned' : 'different';
  d.checkDifferences = cmp.differences;
  d.preview = res;
  d.phase = 'checked';
  renderCatalogDialog();
  // What the library holds now, also in the open view (a read).
  delete tabData[d.collectionId];
  if (activeViewId) reloadOpenView();
}

// ── Rendering ──
function catalogShowTitle(ref, doc) {
  const created = doc.entries.find(e => e.kind === 'create_show' && e.ref === ref);
  if (created) return created.title;
  const s = tvShowsById.get(ref);
  return s ? s.title : ref;
}
function catalogRowTitle(rowId, collectionId) {
  const r = ((tabData[collectionId] || {}).rows || []).find(x => x.id === rowId);
  return r ? `${r.title} · ${r.season}` : null;
}
const CATALOG_REASONS = {
  enriched_show_label: 'its label isn’t a plain “Season N” for a TMDB-matched show',
  identity_conflict: 'another saved row already has that identity',
  linked_to_other_show: 'a saved row with this key belongs to another show'
};

function catalogDocumentHtml(doc, collectionId) {
  const E = kind => doc.entries.filter(e => e.kind === kind);
  const li = (main, meta = '') => `<li class="manage-item"><div class="manage-line"><span class="manage-name">${esc(main)}</span>${meta ? `<span class="manage-meta">${esc(meta)}</span>` : ''}</div></li>`;
  const section = (title, items) => items.length ? `<h3 class="manage-subtitle">${esc(title)} (${items.length})</h3><ul class="manage-list">${items.join('')}</ul>` : '';
  const statusName = s => statusOptionLabel(s);
  const collName = doc.target ? ((personalCollections || []).find(c => c.id === doc.target.collection_id) || {}).name || 'its collection' : null;
  return [
    section('New shows', E('create_show').map(e => li(e.title, `starts ${statusName(e.initial_status)}`))),
    section('New seasons', E('insert_season').map(e => li(`${catalogShowTitle(e.show, doc)} · ${e.season}`, e.display_date))),
    section('New films', E('insert_film').map(e => li(e.title, e.display_date))),
    section('Date updates', E('fill_date').map(e => {
      const skipped = e.item === 'film' ? e.tracking.status === 'skipped' : e.tracking.skipped;
      return li(catalogRowTitle(e.row_id, collectionId) || e.item_key, `${e.old_display} → ${e.new_display}${skipped ? ' (skipped; stays skipped)' : ''}`);
    })),
    section('Back to On List', E('reopen').map(e => li(catalogShowTitle(e.show_id, doc), `Complete → On List, because of a new season`))),
    section('Collection', E('membership').map(e => {
      const title = e.ref.startsWith('S') ? catalogShowTitle(e.ref, doc) : (E('insert_film').find(f => f.ref === e.ref) || {}).title || e.ref;
      return li(title, e.result === 'joined' ? `joins ${collName}` : e.result === 'not_joined' ? `won’t join ${collName} (archived)` : 'no collection');
    })),
    section('Not included — needs review', E('excluded_conflict').map(e => {
      const d = catalogDefaultsOf(collectionId).find(x => x.k === e.item_key);
      return li(d ? `${d.t} · ${d.s}` : e.item_key, CATALOG_REASONS[e.reason] || e.reason);
    })),
    E('noop').length ? `<p class="manage-hint">${E('noop').length} catalog ${E('noop').length === 1 ? 'entry is' : 'entries are'} already in your library.</p>` : ''
  ].join('');
}

function renderCatalogDialog() {
  const box = document.getElementById('catalogModalBox');
  if (!box || !catalogDialog) return;
  const d = catalogDialog;
  const col = COLLECTIONS.find(c => c.id === d.collectionId);
  const head = `<h2 class="modal-title" id="catalogTitle">Catalog updates — ${esc(col ? col.label : d.collectionId)}</h2>`;
  const btn = (label, handler, extra = '') => `<button class="btn${extra}" onclick="${handler}">${esc(label)}</button>`;
  const close = catalogBusy() ? '<button class="btn" disabled>Close</button>' : btn('Close', 'closeCatalogUpdates()');
  const msg = (text, actions = '') => `${head}<div class="manage-body"><p class="manage-message">${esc(text)}</p></div><div class="modal-actions">${actions}${close}</div>`;
  const version = d.payloadHash ? `<p class="manage-hint">Catalog version ${esc(d.payloadHash.slice(0, 12))}${d.preview ? ` · preview ${esc(d.preview.hash.slice(0, 12))}` : ''}</p>` : '';
  let html;
  switch (d.phase) {
    case 'checking': html = msg('Checking that this page has the published catalog…'); break;
    case 'outdated': html = msg('This page has an older catalog than the one published. Reload the page and review again. Nothing was changed.'); break;
    case 'unverified': html = msg(`Couldn’t check that this page has the published catalog (${d.error}). Nothing was changed.`, btn('Try again', 'catalogReview()')); break;
    case 'previewing': html = msg('Working out what applying this catalog would change…'); break;
    case 'absent': html = msg('Catalog updates aren’t available on this database yet. Nothing was changed.'); break;
    case 'failed': html = msg(`${d.error} Nothing was changed.`, btn('Review again', 'catalogReview()')); break;
    case 'stale': html = msg('Your library or the catalog changed since this preview, so nothing was changed. Review the new preview before applying.', btn('Review again', 'catalogReview()')); break;
    case 'busy': html = msg('The database was busy, so nothing was changed. Review again in a moment.', btn('Review again', 'catalogReview()')); break;
    case 'applying': html = msg('Applying these changes… Please keep this page open.'); break;
    case 'unknown':
      html = msg(`We couldn’t confirm the result${d.error ? ` (${d.error})` : ''}. Your request may still finish, may have finished, or may have been stopped. It won’t be sent again automatically.`,
        btn('Check current state', 'catalogCheckState()'));
      break;
    case 'checking-state': html = msg('Reading what your library holds now…'); break;
    case 'checked': {
      const text = d.check === 'present'
        ? 'Your library now includes these changes. This page can’t tell whether its own request or another one made them.'
        : d.check === 'still-planned'
          ? 'These changes aren’t in your library right now. Your earlier request may still finish, or may have been stopped; this can’t be told apart from changes that were applied and later undone. You can apply again: if the earlier request has already made these changes, this one is refused.'
          : `Your library matches neither the approved changes nor the state before them, so the earlier result is still unknown. Compared with the approved changes: ${(d.checkDifferences || []).slice(0, 8).join('; ')}${(d.checkDifferences || []).length > 8 ? '; …' : ''}. The current preview is below.`;
      const showPreview = d.check !== 'present';
      html = `${head}<div class="manage-body"><p class="manage-message">${esc(text)}</p>${showPreview ? catalogDocumentHtml(d.preview.document, d.collectionId) : ''}</div>
        <div class="modal-actions">${showPreview && catalogEffectCount(d.preview.document) ? btn('Apply these changes', 'catalogApplyChecked()', ' btn-accent') : ''}${btn('Check current state', 'catalogCheckState()')}${close}</div>`;
      break;
    }
    case 'preview': {
      const n = catalogEffectCount(d.preview.document);
      const conflicts = d.preview.document.entries.filter(e => e.kind === 'excluded_conflict').length;
      html = `${head}<div class="manage-body"><p class="manage-message">${n
        ? `Applying this catalog would make these changes. Nothing has changed yet.${conflicts ? ` ${conflicts} ${conflicts === 1 ? 'entry is' : 'entries are'} not included; ${conflicts === 1 ? 'it needs' : 'they need'} review.` : ''}`
        : `Nothing to apply: your library already has everything this catalog can add.${conflicts ? ` ${conflicts} ${conflicts === 1 ? 'entry needs' : 'entries need'} review.` : ''}`}</p>
        ${version}${catalogDocumentHtml(d.preview.document, d.collectionId)}</div>
        <div class="modal-actions">${n ? btn('Apply these changes', 'catalogApply()', ' btn-accent') : ''}${close}</div>`;
      break;
    }
    case 'applied': {
      const doc = d.result.document;
      const n = catalogEffectCount(doc);
      const conflicts = doc.entries.filter(e => e.kind === 'excluded_conflict').length;
      const rb = d.readBack || {};
      const rbText = rb.state === 'reading' ? 'Checking the saved records…'
        : rb.state === 'verified' ? 'Verified: every applied change was read back as approved.'
          : rb.state === 'differs' ? `Applied, but reading back found differences (possibly later edits): ${rb.differences.join('; ')}.`
            : `Applied, but the saved records couldn’t be read back to verify (${rb.error}).`;
      html = `${head}<div class="manage-body"><p class="manage-message">${esc(`Applied ${n} ${n === 1 ? 'change' : 'changes'}${conflicts ? `; ${conflicts} ${conflicts === 1 ? 'entry' : 'entries'} not included (listed below)` : ''}.`)}</p>
        <p class="manage-status" role="status">${esc(rbText)}</p>${version}${catalogDocumentHtml(doc, d.collectionId)}</div>
        <div class="modal-actions">${rb.state === 'unread' || rb.state === 'differs' ? btn('Read again', `catalogVerify(${d.session})`) : ''}${close}</div>`;
      break;
    }
    default: html = msg('');
  }
  // A redraw replaces the focused control: keep keyboard focus in the dialog (Escape
  // and the Tab loop work only there), as Manage does.
  const active = document.activeElement;
  const hadFocus = !!active && (active === document.body || (typeof box.contains === 'function' && box.contains(active)));
  box.innerHTML = html;
  if (hadFocus && typeof box.focus === 'function') box.focus();
}

// Apply from a re-checked state: a new approval of the preview just shown.
function catalogApplyChecked() {
  const d = catalogDialog;
  if (!d || d.phase !== 'checked' || !d.preview) return;
  d.phase = 'preview';
  catalogApply();
}
