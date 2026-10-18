// S2: Collections as a primary area (B3) and the remembered collection (O2). The checks
// C1–C15 of the S2 brief (rev2 §8.1), in the offline harness: the in-memory model stands in
// for the database, so these show the page's handling, not the real functions.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('collections-nav');
const test = T.test;

const ID = { disney: '0c000000-0000-4000-8000-000000000001', sheridan: '0c000000-0000-4000-8000-000000000002',
  '90day': '0c000000-0000-4000-8000-000000000003', truecrime: '0c000000-0000-4000-8000-000000000004' };
const V = k => `browse:${ID[k]}`;
const KEY = 'watchlist_last_collection';
const TS = '2026-10-01T00:00:00+00:00';
const uuid = (p, n) => `${p}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let n = 0;
const show = (o, seasons) => {
  const id = uuid('5a', ++n);
  const s = { id, collection: 'disney', title: 'Show', show_key: (o.title || 'show').toLowerCase(), tmdb_id: null, status: 'confirmed', created_at: TS, ...o };
  const rows = seasons.map(label => ({ id: uuid('5b', ++n), collection: s.collection, item_key: `${s.show_key}|${label.toLowerCase()}`, title: s.title,
    season: label, theme: 'Drama', display_date: 'Jan 1, 2020', date_sort: '2020-01-01', watched: false, status: 'confirmed', created_at: TS,
    watch_with: [], collections: [], tmdb_collection_id: null, tmdb_collection_name: null, media_type: null, tmdb_id: null, season_number: null,
    show_id: id, skipped: false }));
  return { show: s, rows };
};
const film = o => ({ id: uuid('f0', ++n), collection: 'movies', item_key: `film ${n}|film`, title: 'Film', season: 'Film', theme: 'Drama',
  display_date: 'Jan 1, 2020', date_sort: '2020-01-01', watched: false, status: 'confirmed', created_at: TS, watch_with: [], collections: [],
  tmdb_collection_id: null, tmdb_collection_name: null, media_type: 'movie', tmdb_id: 7000 + n, season_number: null, show_id: null, skipped: false, ...o });
function library() {
  const xs = [show({ title: 'Andor', status: 'watching' }, ['Season 1', 'Season 2']), show({ title: 'Tulsa King', collection: 'sheridan' }, ['Season 1']),
    show({ title: 'Severance', collection: 'othertv', tmdb_id: 95396 }, ['Season 1']), show({ title: '90 Day Fiancé', collection: '90day' }, ['Season 1']),
    film({ title: 'Sicario', collection: 'sheridan', media_type: null, tmdb_id: null }), film({ title: 'Dune' })];
  return { rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) };
}
const PCS = () => ['disney', 'sheridan', '90day', 'truecrime'].map((src, i) => ({ id: ID[src], name: ['Disney+', 'Sheridan', '90 Day', 'True Crime / Docs'][i],
  legacy_source: src, sort_order: i + 1, archived_at: null, created_at: TS }));

// A device storage that records what it is asked to do; fail: { get, set, remove, noRemove }.
function memStore(initial = {}, fail = {}) {
  const data = { ...initial }, log = [];
  const s = {
    data, log, fail,
    getItem: k => { if (fail.get) throw new Error('SecurityError: denied'); return k in data ? data[k] : null; },
    setItem: (k, v) => { if (fail.set) throw new Error('QuotaExceededError'); log.push(['set', k, String(v)]); data[k] = String(v); }
  };
  if (!fail.noRemove) s.removeItem = k => { if (fail.remove) throw new Error('SecurityError: denied'); log.push(['remove', k]); delete data[k]; };
  return s;
}
async function boot(opts = {}) {
  const d = opts.data || library();
  return createApp({ rows: d.rows, tvShows: d.shows, ...opts });
}
const html = app => app.el('tbody').innerHTML;
const bar = app => app.el('browseBar').innerHTML;
const head = app => app.el('viewHead').innerHTML;
const banner = app => app.el('banner').innerHTML;
const tabs = app => [...bar(app).matchAll(/<button type="button" role="tab" class="([^"]*)" id="ctab-([^"]+)" aria-controls="([^"]*)" aria-selected="(true|false)" tabindex="(-?\d)"[^>]*>([^<]*)</g)]
  .map(m => ({ cls: m[1], id: m[2], controls: m[3], selected: m[4] === 'true', tabindex: Number(m[5]), label: m[6] }));
const labels = app => tabs(app).map(t => t.label);
const coll = (app, k) => app.store.personal_collections.find(c => c.id === ID[k]);
// (stage5_capabilities and org_capabilities are the read-only capability checks made at startup and when Manage opens.)
const writes = app => app.requests.filter(r => r.method !== 'GET' || (/\/rpc\//.test(r.url) && !/\/rpc\/(stage5|org)_capabilities$/.test(r.url)));
const reqs = (app, from) => app.requests.slice(from).map(r => new URL(r.url).pathname.split('/').pop());
const current = app => {
  const h = app.el('mediaSwitch').innerHTML + app.el('settingsEntry').innerHTML;
  return { count: (h.match(/aria-current="page"/g) || []).length,
    which: (h.match(/id="(areaBtn-[a-z]+|settingsBtn)"[^>]*aria-current="page"/) || [])[1] || (h.match(/aria-current="page"[^>]*onclick="openSettings/) ? 'settingsBtn' : null) };
};
// Records focus(), setAttribute() / removeAttribute() and scrollIntoView() (the harness's DOM has none of the first three).
function spyDom(app) {
  const doc = app.ctx.document, orig = doc.getElementById, log = { focus: [], scroll: [] };
  const inChooser = id => /^ctab-/.test(id) || id === 'collectionsRetry' || id === 'collectionsCreate';
  doc.getElementById = id => {
    const e = orig(id);
    if (e && !e.__spied) {
      e.__spied = true;
      e.attrs = e.attrs || {};
      e.focus = () => { log.focus.push(id); doc.activeElement = e; };
      e.setAttribute = (a, v) => { e.attrs[a] = String(v); };
      e.removeAttribute = a => { delete e.attrs[a]; };
      e.scrollIntoView = o => { log.scroll.push([id, o]); };
      e.closest = sel => (sel === '#browseBar' && inChooser(id) ? {} : null);
    }
    return e;
  };
  return log;
}
const focusOn = (app, id) => { const e = app.ctx.document.getElementById(id); app.ctx.document.activeElement = e; return e; };
const focusOutside = app => { app.ctx.document.activeElement = { id: 'elsewhere', closest: () => null }; };
const panel = app => app.ctx.document.getElementById('mainContent').attrs || {};
const stale = async app => { app.failNext(r => r.url.includes('/rest/v1/personal_collections?')); app.ctx.retryOrgRefresh(); await settle(); };
const holdOwnRead = app => app.hold(r => r.url.includes('/rest/v1/collection_memberships?'));
const archive = (app, ...ks) => ks.forEach(k => { coll(app, k).archived_at = TS; });

// ─── C1 (V2.1), C2 (V2.2), C10 ───────────────────────────────────────────────
test('C1 the primary row: TV · Movies · Collections, words for names, the phone rules in styles.css', async () => {
  const app = await boot();
  const m = app.el('mediaSwitch').innerHTML;
  const btns = [...m.matchAll(/<button class="media-switch-btn[^"]*" id="areaBtn-([a-z]+)"[^>]*onclick="([^"]+)"><span class="media-switch-icon" aria-hidden="true">([^<]+)<\/span> ([^<]+)<\/button>/g)]
    .map(x => [x[1], x[2], x[3], x[4]]);
  assert.deepStrictEqual(btns, [['tv', "switchMediaType('tv')", '📺', 'TV'], ['movie', "switchMediaType('movie')", '🎬', 'Movies'], ['collections', 'openCollections(this)', '🗂', 'Collections']]);
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(css, /@media \(max-width: 359px\) \{\s*\.media-switch-icon \{ display: none; \}/);
  const phone = css.slice(css.indexOf('@media (max-width: 700px)'));
  // S2V2-1: equal shares (flex-basis 0, no min-content floor), one line, narrower side padding.
  assert.match(phone, /\.media-switch-btn \{ flex: 1 1 0; min-width: 0; padding: 8px 6px; white-space: nowrap; text-align: center; min-height: 44px; \}/);
  assert.match(phone, /\.collection-tab \{ min-height: 44px; \}/);
  assert.match(css, /\.collection-tabs \{[^}]*overflow-x: auto;/);
});

test('C2 exactly one current page: the open area’s button, or the gear on Settings', async () => {
  const app = await boot();
  const expect = (area, which) => {
    assert.strictEqual(app.get('activeArea'), area);
    assert.deepStrictEqual(current(app), { count: 1, which }, `${area}: ${JSON.stringify(current(app))}`);
  };
  expect('tv', 'areaBtn-tv');
  for (const v of ['alltv', 'comingsoon']) { app.ctx.switchView(v); await settle(); expect('tv', 'areaBtn-tv'); }
  app.ctx.switchMediaType('movie'); await settle(); expect('movie', 'areaBtn-movie');
  app.ctx.openCollections(null); await settle(); expect('collections', 'areaBtn-collections');
  assert.ok(app.get('activeViewId').startsWith('browse:'));
  app.ctx.openSettings(null); expect('settings', 'settingsBtn');
  app.ctx.switchMediaType('tv'); await settle();
  // The Collections state: loading, unavailable, none.
  app.run("orgState = 'loading'; personalCollections = null");
  app.ctx.openCollections(null); expect('collections', 'areaBtn-collections');
  assert.strictEqual(app.get('activeViewId'), 'collections');
  app.ctx.switchMediaType('tv'); app.run("orgState = 'unavailable'");
  app.ctx.openCollections(null); expect('collections', 'areaBtn-collections');
  const none = await boot({ personalCollections: [] });
  none.ctx.openCollections(null); await settle();
  assert.deepStrictEqual(current(none), { count: 1, which: 'areaBtn-collections' });
  const st = await boot({ storage: memStore({ [KEY]: ID.sheridan }) }); // the stale Collections state
  st.store.personal_collections = st.store.personal_collections.filter(c => c.id !== ID.sheridan);
  st.ctx.retryOrgRefresh(); await settle(); await stale(st);
  st.ctx.openCollections(null); await settle();
  assert.strictEqual(st.get('activeViewId'), 'collections');
  assert.deepStrictEqual(current(st), { count: 1, which: 'areaBtn-collections' });
});

test('C10 no Browse row in TV, Movies or Settings; the chooser only in the Collections area', async () => {
  const app = await boot();
  const all = () => ['mediaSwitch', 'tabBar', 'browseBar', 'viewHead', 'filtersRow'].map(id => app.el(id).innerHTML).join('');
  const check = where => { assert.strictEqual(bar(app), '', where); assert.ok(!/browseSelect|Browse collections/.test(all()), where); };
  check('TV');
  for (const v of ['alltv', 'comingsoon']) { app.ctx.switchView(v); await settle(); check(v); }
  app.ctx.switchMediaType('movie'); await settle(); check('Movies');
  app.ctx.openSettings(null); check('Settings');
  app.ctx.openCollections(null); await settle();
  assert.ok(bar(app).includes('role="tablist"'));
  assert.strictEqual(app.el('tabBar').innerHTML, '');
  assert.strictEqual(app.el('tabBar').hidden, true, 'no view tabs in the Collections area');
});

// ─── C3 (V2.3), C4 (V2.5) ────────────────────────────────────────────────────
test('C3 independent access: the same collection from Currently Watching, All TV, All Movies and Settings; only the Back origin differs', async () => {
  const data = library(); // one fixture, so the rows' ids are the same in every page
  for (const stored of [{}, { [KEY]: ID.sheridan }]) {
    const seen = [];
    for (const from of ['watching', 'alltv', 'allmovies', 'settings-from-alltv', 'settings-from-movies']) {
      const app = await boot({ data, storage: memStore(stored) });
      if (from === 'alltv' || from === 'settings-from-alltv') { app.ctx.switchView('alltv'); await settle(); app.el('fSearch').value = 'and'; app.ctx.renderTable(); }
      if (from === 'allmovies' || from === 'settings-from-movies') { app.ctx.switchMediaType('movie'); await settle(); }
      if (from.startsWith('settings')) app.ctx.openSettings(null);
      app.ctx.openCollections(null); await settle();
      seen.push([app.get('activeViewId'), html(app), app.get('browseMedia')]);
    }
    assert.ok(seen.every(s => s[0] === seen[0][0] && s[1] === seen[0][1] && s[2] === 'all'), JSON.stringify(seen.map(s => s[0])));
    assert.strictEqual(seen[0][0], stored[KEY] ? V('sheridan') : V('disney'));
  }
});

test('C4 the tabs: active collections in your order; a tab is a fresh entry keeping the first origin; the open tab does nothing; no layout key on entry; the selected tab scrolled into view', async () => {
  const pcs = PCS();
  pcs[0].name = 'Mouse House'; pcs[2].archived_at = TS;
  pcs.push({ id: uuid('0c', 9), name: 'Anime', legacy_source: null, sort_order: 0, archived_at: null, created_at: TS });
  const store = memStore();
  const app = await boot({ personalCollections: pcs, storage: store, width: 375 });
  const log = spyDom(app);
  app.ctx.openCollections(null); await settle();
  assert.deepStrictEqual(labels(app), ['Anime', 'Mouse House', 'Sheridan', 'True Crime / Docs']);
  assert.deepStrictEqual(tabs(app).filter(t => t.selected).map(t => t.label), ['Anime']);
  assert.ok(log.scroll.some(([id, o]) => id === `ctab-${uuid('0c', 9)}` && o.block === 'nearest' && o.inline === 'nearest'), JSON.stringify(log.scroll));
  app.ctx.selectCollectionTab(ID.disney); await settle();
  app.el('fSearch').value = 'x'; app.el('fStatus').value = 'all'; app.ctx.renderTable();
  app.ctx.setBrowseMedia('movie'); await settle();
  app.ctx.selectCollectionTab(ID.sheridan); await settle();
  assert.strictEqual(app.get('activeViewId'), V('sheridan'));
  assert.deepStrictEqual([app.el('fSearch').value, app.el('fStatus').value, app.get('browseMedia'), app.get('browseSeasonVis')], ['', '', 'all', 'notskipped']);
  assert.strictEqual(app.get('browseOrigin.viewId'), 'watching', 'the first origin is kept');
  const before = app.requests.length;
  app.ctx.selectCollectionTab(ID.sheridan); await settle();
  assert.strictEqual(app.requests.length, before, 'the open tab sends nothing');
  assert.ok(store.log.every(([, k]) => k === KEY), 'no layout key written on entry: ' + JSON.stringify(store.log));
  assert.deepStrictEqual(store.log.map(x => x[2]), [ID.disney, ID.sheridan]);
});

// ─── C5 (V2.6) ────────────────────────────────────────────────────────────────
test('C5 states: Loading, Unavailable + Retry (a Retry that succeeds resolves), absent, None + Create, the stale mark; status lines; never a partial list', async () => {
  const app = await boot();
  app.run("orgState = 'loading'; personalCollections = null");
  const g = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
  app.failNext(r => r.url.includes('/rest/v1/personal_collections?'));
  const loading = app.ctx.loadOrganization();
  await g.reached;
  app.ctx.openCollections(null);
  assert.strictEqual(bar(app), '<p class="collections-state" role="status">Loading collections…</p>');
  assert.strictEqual(html(app), '', 'no list');
  g.release(); await loading; await settle();
  assert.strictEqual(app.get('orgState'), 'unavailable');
  assert.strictEqual(bar(app), '<p class="collections-state" role="status">Collections unavailable</p> <button class="btn collections-retry" id="collectionsRetry" onclick="loadOrganization()">Retry</button>');
  assert.strictEqual(app.get('activeViewId'), 'collections');
  await app.ctx.loadOrganization(); await settle();
  assert.strictEqual(app.get('activeViewId'), V('disney'), 'Retry succeeding while on the state resolves');
  // One of the three collection reads failing: no tabs.
  app.ctx.switchMediaType('tv'); await settle();
  app.run("orgState = 'loading'; personalCollections = null");
  app.failNext(r => r.url.includes('/rest/v1/library_collection_presentation?'));
  app.ctx.openCollections(null); await app.ctx.loadOrganization(); await settle();
  assert.ok(!bar(app).includes('role="tablist"') && bar(app).includes('Collections unavailable'));
  // Absent and none.
  const absent = await boot({ org: false });
  absent.ctx.openCollections(null); await settle();
  assert.strictEqual(bar(absent), '<p class="collections-state" role="status">Collections aren’t available on this database.</p>');
  const none = await boot({ personalCollections: [] });
  none.ctx.openCollections(null); await settle();
  assert.strictEqual(bar(none), '<p class="collections-state" role="status">No collections yet.</p> <button class="btn btn-link collections-create" id="collectionsCreate" onclick="openSettings(this)">Create one in Settings &amp; Management</button>');
  // The stale mark beside the tabs (a collection open).
  const st = await boot();
  st.ctx.openCollections(null); await settle();
  await stale(st);
  assert.match(bar(st), /role="tablist"[\s\S]*Collections may be out of date · <button class="btn" id="collectionsRetry" onclick="retryOrgRefresh\(\)">Retry<\/button>/);
});

// ─── C6 (V2.7) ────────────────────────────────────────────────────────────────
test('C6 Back names the origin view and returns with its filters once; the first origin is kept; Settings’ origin; no origin, no link', async () => {
  for (const [media, view, label] of [['tv', 'watching', 'Currently Watching'], ['tv', 'alltv', 'All TV'], ['tv', 'comingsoon', 'Coming Soon'], ['movie', 'allmovies', 'All Movies']]) {
    const app = await boot();
    app.ctx.switchMediaType(media); await settle(); app.ctx.switchView(view); await settle();
    app.el('fSearch').value = 'zz'; app.ctx.renderTable();
    app.ctx.openCollections(null); await settle();
    assert.ok(head(app).includes(`<button class="btn browse-back" onclick="browseBack()">← Back to ${label}</button>`), label);
    app.ctx.selectCollectionTab(ID.sheridan); await settle();
    assert.ok(head(app).includes(`← Back to ${label}`), 'a tab switch keeps the first origin');
    app.ctx.browseBack(); await settle();
    assert.deepStrictEqual([app.get('activeViewId'), app.el('fSearch').value], [view, 'zz']);
    app.ctx.switchView(view); await settle();
    assert.strictEqual(app.el('fSearch').value, '', 'once only');
  }
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  app.ctx.openSettings(null);
  app.ctx.openCollections(null); await settle();
  assert.ok(head(app).includes('← Back to All TV'), 'from Settings: Settings’ origin');
  app.ctx.switchMediaType('movie'); await settle(); app.ctx.openSettings(null);
  app.run('settingsOrigin = null');
  app.ctx.openCollections(null); await settle();
  assert.ok(!head(app).includes('browseBack()'), 'no origin, no link');
  const fromCol = await boot();
  fromCol.ctx.switchView('comingsoon'); await settle();
  fromCol.ctx.openCollections(null); await settle();
  fromCol.ctx.openSettings(null);
  fromCol.ctx.switchMediaType('tv'); await settle();
  fromCol.ctx.openSettings(null);
  fromCol.ctx.openCollections(null); await settle();
  assert.ok(head(fromCol).includes('← Back to Currently Watching'));
  fromCol.ctx.openSettings(null);
  fromCol.run(`settingsOrigin = { mediaType: 'tv', viewId: '${V('disney')}', filters: {}, browseOrigin: { mediaType: 'tv', viewId: 'comingsoon', filters: {} } }`);
  fromCol.ctx.openCollections(null); await settle();
  assert.ok(head(fromCol).includes('← Back to Coming Soon'), 'Settings opened from a collection: that collection’s origin');
  fromCol.ctx.openSettings(null);
  fromCol.run(`settingsOrigin = { mediaType: 'tv', viewId: 'collections', filters: {}, browseOrigin: null }`);
  fromCol.ctx.openCollections(null); await settle();
  assert.ok(!head(fromCol).includes('browseBack()'), 'Settings opened from the Collections state with no origin: no link');
  fromCol.ctx.switchMediaType('tv'); await settle();
  assert.deepStrictEqual([fromCol.get('activeViewId'), fromCol.el('fSearch').value], ['watching', '']);
});

// ─── C7 (V2.8, simulated write) ──────────────────────────────────────────────
// The collection heading as a browser would hold it: every write of #viewHead replaces the Edit
// collection button with a new one (the old one is disconnected), found by its selector.
function editButtonModel(app) {
  const head = app.el('viewHead');
  const desc = Object.getOwnPropertyDescriptor(head, 'innerHTML');
  let gen = 0, el = null, elGen = -1;
  Object.defineProperty(head, 'innerHTML', { configurable: true, get: () => desc.get.call(head), set: v => { gen++; desc.set.call(head, v); } });
  const focused = [];
  const current = () => {
    if (!head.innerHTML.includes('browse-edit-members')) return null;
    if (elGen !== gen) {
      const mine = gen;
      el = { id: `editCollection#${mine}`, matches: sel => sel === '.browse-edit-members', get isConnected() { return gen === mine; },
        focus() { focused.push(this.id); app.ctx.document.activeElement = this; } };
      elGen = gen;
    }
    return el;
  };
  app.ctx.document.querySelector = sel => (sel === '.browse-edit-members' ? current() : null);
  return { current, focused };
}
async function editedCollection(app) {
  app.ctx.openCollections(null); await settle();
  const model = editButtonModel(app);
  const opener = model.current();
  app.ctx.document.activeElement = opener;
  app.ctx.openManage('members', ID.disney, opener); await settle();
  app.ctx.manageAddMember('s', app.store.tv_shows.find(s => s.title === 'Severance').id); await settle();
  return { model, opener };
}
test('C7 Edit collection opens Manage at this collection’s members; after a simulated add, Close rereads the collection and focus follows the redrawn Edit collection (in-memory model)', async () => {
  const app = await boot();
  app.ctx.openCollections(null); await settle();
  assert.ok(head(app).includes(`<button class="btn btn-link browse-edit-members" onclick="openManage('members', '${ID.disney}', this)">Edit collection</button>`));
  assert.ok(!head(app).includes('Edit members'));
  app.ctx.switchMediaType('tv'); await settle();
  const before = writes(app).length;
  const { model, opener } = await editedCollection(app);
  assert.deepStrictEqual([app.get('manage.view'), app.get('manage.collectionId'), app.get('manage.openerSelector')], ['members', ID.disney, '.browse-edit-members']);
  const w = writes(app).slice(before);
  assert.ok(w.length === 1 && w[0].url.endsWith('/rpc/org_add_membership'), 'one simulated membership write');
  const g = holdOwnRead(app);
  const i = app.requests.length;
  app.ctx.closeManage();
  // Batch A: the shown collection is read again in place, so the heading (and the opener) stays until the read is in.
  assert.strictEqual(opener.isConnected, true, 'the heading stays while the collection is read again');
  assert.strictEqual(app.ctx.document.activeElement, opener, 'focus back on the opener at once');
  await g.reached; g.release(); await settle();
  assert.strictEqual(opener.isConnected, false, 'the loaded view drew the heading again');
  const final = model.current();
  assert.ok(final.isConnected && app.ctx.document.activeElement === final, `focus on the final Edit collection: ${model.focused}`);
  assert.ok(app.requests.slice(i).some(r => r.method === 'GET' && r.url.includes('/rest/v1/collection_memberships?')), 'the collection read again');
  assert.ok(app.requests.slice(i).every(r => r.method === 'GET'), 'the reread is GET only');
  assert.match(html(app), /Severance/);
  assert.strictEqual(app.get('collectionEntry.kind'), 'default', 'the reread keeps the entry');
});

test('C7 the reread’s focus return never steals focus: not after navigating away, nor once focus has moved elsewhere', async () => {
  for (const act of ['navigate', 'move']) {
    const app = await boot();
    const { model } = await editedCollection(app);
    const g = holdOwnRead(app);
    app.ctx.closeManage();
    const n = model.focused.length;
    if (act === 'navigate') { app.ctx.switchMediaType('tv'); await settle(); }
    else app.ctx.document.activeElement = { id: 'elsewhere', isConnected: true, closest: () => null };
    await g.reached; g.release(); await settle();
    assert.strictEqual(model.focused.length, n, `${act}: ${model.focused}`);
    if (act === 'move') assert.strictEqual(app.ctx.document.activeElement.id, 'elsewhere');
  }
});

// ─── C8 (V2.10) ───────────────────────────────────────────────────────────────
test('C8 no write from any Collections chooser control; the collection note verbatim in every collection (S3, as amended by S4); the chooser exposes navigation only', async () => {
  const app = await boot();
  spyDom(app);
  app.ctx.openCollections(null); await settle();
  const allowed = new Set(['selectCollectionTab', 'collectionTabsKeydown', 'retryOrgRefresh', 'loadOrganization', 'openSettings']);
  for (const k of ['disney', 'sheridan', '90day', 'truecrime']) {
    app.ctx.selectCollectionTab(ID[k]); await settle();
    const name = coll(app, k).name.replace('&', '&amp;');
    assert.ok(head(app).includes(`The shows and films in your ${name} collection. Changing a show or film here changes it in your library everywhere; Remove takes it out of ${name} only.`), k);
    const hs = [...bar(app).matchAll(/on(?:click|keydown)="([A-Za-z]+)\(/g)].map(m => m[1]);
    assert.ok(hs.every(h => allowed.has(h)), hs.join(','));
    app.ctx.collectionTabsKeydown({ key: 'ArrowRight', target: app.ctx.document.getElementById(`ctab-${ID[k]}`), preventDefault() {} });
  }
  app.ctx.openManage('members', ID.truecrime, null); await settle(); app.ctx.closeManage(); await settle();
  await stale(app); app.ctx.retryOrgRefresh(); await settle();
  app.ctx.browseBack(); await settle();
  assert.deepStrictEqual(writes(app), []);
});

// ─── C9 (V2.11) ───────────────────────────────────────────────────────────────
test('C9a,b,i only this key, holding the id; a tab and the resolution to it write it; a new page opens it; nothing else is stored', async () => {
  const store = memStore();
  const app = await boot({ storage: store });
  app.ctx.openCollections(null); await settle();
  assert.deepStrictEqual(store.log, [], 'the no-key default writes nothing');
  app.ctx.selectCollectionTab(ID.sheridan); await settle();
  assert.deepStrictEqual(store.log, [['set', KEY, ID.sheridan]]);
  app.ctx.browseBack(); await settle();
  app.ctx.openCollections(null); await settle();
  assert.strictEqual(app.get('activeViewId'), V('sheridan'));
  assert.strictEqual(app.get('collectionEntry.kind'), 'remembered');
  assert.deepStrictEqual(store.log.slice(1), [['set', KEY, ID.sheridan]], 'the resolution re-writes the same id');
  // Other entries write nothing: Settings and back, Back, other views, a reload of the view.
  app.ctx.openSettings(null); app.ctx.settingsBack(); await settle();
  app.ctx.reloadOpenView(); await settle();
  app.ctx.browseBack(); await settle();
  for (const v of ['alltv', 'comingsoon']) { app.ctx.switchView(v); await settle(); }
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(store.log.length, 2);
  // A layout change writes only its own key.
  app.ctx.openCollections(null); await settle();
  app.ctx.setBrowsePresentation('seasons'); await settle();
  assert.deepStrictEqual(store.log.slice(2).map(x => x[1]).filter(k => k !== KEY), ['watchlist_browse_layout_sheridan']);
  assert.ok(Object.keys(store.data).every(k => k === KEY || k.startsWith('watchlist_browse_layout_')), JSON.stringify(store.data));
  // A new page with the same storage: boot is still Currently Watching; Collections opens it.
  const again = await boot({ storage: store });
  assert.strictEqual(again.get('activeViewId'), 'watching');
  again.ctx.openCollections(null); await settle();
  assert.strictEqual(again.get('activeViewId'), V('sheridan'));
});

test('C9c,d D16: archived or deleted → the first active collection, the key removed, the notice; nothing written; the next press has no notice', async () => {
  for (const how of ['archived', 'deleted']) {
    const pcs = PCS();
    if (how === 'archived') pcs[1].archived_at = TS; else pcs.splice(1, 1);
    const store = memStore({ [KEY]: ID.sheridan });
    const app = await boot({ personalCollections: pcs, storage: store });
    app.ctx.openCollections(null); await settle();
    assert.strictEqual(app.get('activeViewId'), V('disney'), how);
    assert.strictEqual(app.get('collectionEntry.kind'), 'fallback');
    assert.ok(!(KEY in store.data), 'the key removed');
    assert.ok(!store.log.some(x => x[0] === 'set'), 'no fallback write');
    assert.strictEqual(banner(app), '<div class="banner" role="status">Your last collection isn’t available any more; showing Disney+.</div>');
    app.ctx.switchMediaType('tv'); await settle();
    app.ctx.openCollections(null); await settle();
    assert.strictEqual(app.get('activeViewId'), V('disney'));
    assert.strictEqual(banner(app), '', 'no notice the second time');
  }
});

test('C9e a held collections read: Loading, then the remembered collection — only while still on the Collections state', async () => {
  // (A collection chosen before a held answer is C14 (3).)
  for (const leave of [null, 'tv', 'movie', 'settings']) {
    const store = memStore({ [KEY]: ID.sheridan });
    const app = await boot({ storage: store });
    app.run("orgState = 'loading'; personalCollections = null");
    const g = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
    const p = app.ctx.loadOrganization();
    await g.reached;
    app.ctx.switchView('alltv'); await settle();
    app.ctx.openCollections(null);
    assert.match(bar(app), /Loading collections…/);
    if (leave === 'tv' || leave === 'movie') { app.ctx.switchMediaType(leave); await settle(); }
    if (leave === 'settings') app.ctx.openSettings(null);
    const where = app.get('activeViewId');
    g.release(); await p; await settle();
    if (!leave) assert.strictEqual(app.get('activeViewId'), V('sheridan'));
    else assert.strictEqual(app.get('activeViewId'), where, `stayed in ${leave}`);
    assert.strictEqual(store.data[KEY], ID.sheridan);
  }
});

test('C9e (hold, choose, release) an organization read held while you choose another collection can neither redirect you nor overwrite the choice when it is released', async () => {
  // (1) The held read is older than the one that resolved: it can't publish.
  let store = memStore({ [KEY]: ID.sheridan });
  let app = await boot({ storage: store });
  unresolve(app);
  const g = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
  const held = app.ctx.loadOrganization();
  await g.reached;
  app.ctx.openCollections(null);
  assert.strictEqual(app.get('activeViewId'), 'collections');
  await app.ctx.loadOrganization(); await settle(); // a newer read publishes and resolves
  assert.strictEqual(app.get('activeViewId'), V('sheridan'));
  app.ctx.selectCollectionTab(ID['90day']); await settle();
  app.store.personal_collections = app.store.personal_collections.filter(c => c.id !== ID['90day']); // what the held read will say
  g.release(); await held; await settle();
  assert.deepStrictEqual([app.get('activeViewId'), store.data[KEY], banner(app)], [V('90day'), ID['90day'], ''], '(1)');
  assert.ok(app.get('personalCollections').some(c => c.id === ID['90day']), '(1) the older read did not publish');
  // (2) The held read is a newer Retry on the stale Collections state: it publishes, but you have chosen meanwhile.
  store = memStore({ [KEY]: ID.sheridan });
  app = await boot({ storage: store });
  app.store.personal_collections = app.store.personal_collections.filter(c => c.id !== ID.sheridan);
  app.ctx.retryOrgRefresh(); await settle(); await stale(app);
  app.ctx.openCollections(null); await settle();
  assert.strictEqual(app.get('activeViewId'), 'collections', '(2) unresolved while stale');
  const g2 = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
  app.ctx.retryOrgRefresh(); await g2.reached;
  app.ctx.selectCollectionTab(ID.truecrime); await settle();
  g2.release(); await settle();
  assert.strictEqual(app.get('orgCollectionsStale'), 0, '(2) the Retry published');
  assert.deepStrictEqual([app.get('activeViewId'), store.data[KEY], banner(app)], [V('truecrime'), ID.truecrime, ''], '(2) no redirect, no D16, the choice kept');
});

test('C9f,g a failed read keeps the key byte-identical; none on an applicable read removes it', async () => {
  const store = memStore({ [KEY]: ID.sheridan });
  const app = await boot({ storage: store });
  app.run("orgState = 'loading'; personalCollections = null");
  app.failNext(r => r.url.includes('/rest/v1/personal_collections?'));
  app.ctx.openCollections(null); await app.ctx.loadOrganization(); await settle();
  assert.strictEqual(app.get('orgState'), 'unavailable');
  assert.deepStrictEqual([store.data[KEY], store.log], [ID.sheridan, []]);
  const none = memStore({ [KEY]: ID.sheridan });
  const app2 = await boot({ personalCollections: [], storage: none });
  app2.ctx.openCollections(null); await settle();
  assert.ok(!(KEY in none.data));
  assert.match(bar(app2), /No collections yet\./);
});

test('C9h1 readable storage, setItem failing: this visit opens the new choice (visit memory wins); storage keeps the older id; a later save recovers', async () => {
  const store = memStore({ [KEY]: ID.sheridan });
  const app = await boot({ storage: store });
  store.fail.set = true;
  app.ctx.openCollections(null); await settle(); // the remembered Sheridan (its re-write fails quietly)
  app.ctx.selectCollectionTab(ID['90day']); await settle();
  app.ctx.switchMediaType('tv'); await settle();
  app.ctx.openCollections(null); await settle();
  assert.strictEqual(app.get('activeViewId'), V('90day'), 'not the older stored Sheridan');
  assert.strictEqual(store.data[KEY], ID.sheridan);
  assert.strictEqual(app.consoleErrors.length, 0);
  assert.ok(!app.el('errorBanner').innerHTML);
  store.fail.set = false;
  app.ctx.selectCollectionTab(ID.truecrime); await settle();
  assert.strictEqual(app.get('lastCollectionVisit.diverged'), false);
  assert.strictEqual(store.data[KEY], ID.truecrime);
  app.ctx.switchMediaType('tv'); await settle(); app.ctx.openCollections(null); await settle();
  assert.strictEqual(app.get('activeViewId'), V('truecrime'));
  const later = await boot({ storage: memStore({ [KEY]: ID.sheridan }) }); // a later visit sees only storage (disclosed)
  later.ctx.openCollections(null); await settle();
  assert.strictEqual(later.get('activeViewId'), V('sheridan'));
});

test('C9h2 removeItem failing, or missing: a forgotten collection stays forgotten for the visit even when it becomes active again', async () => {
  for (const fail of [{ remove: true }, { noRemove: true }]) {
    const pcs = PCS(); pcs[1].archived_at = TS;
    const store = memStore({ [KEY]: ID.sheridan }, fail);
    const app = await boot({ personalCollections: pcs, storage: store });
    app.ctx.openCollections(null); await settle();
    assert.strictEqual(app.get('activeViewId'), V('disney'));
    assert.match(banner(app), /isn’t available any more/);
    assert.strictEqual(store.data[KEY], ID.sheridan, 'storage still holds it');
    coll(app, 'sheridan').archived_at = null;
    app.ctx.retryOrgRefresh(); await settle();
    assert.ok(app.get('personalCollections').some(c => c.id === ID.sheridan && !c.archived_at), 'Sheridan active again');
    app.ctx.switchMediaType('tv'); await settle();
    app.ctx.openCollections(null); await settle();
    assert.strictEqual(app.get('activeViewId'), V('disney'), JSON.stringify(fail));
    assert.strictEqual(banner(app), '');
    assert.strictEqual(app.consoleErrors.length, 0);
  }
});

test('C9h3 getItem failing (setItem works): the first collection with no write; a choice is used through visit memory and saved', async () => {
  const store = memStore({ [KEY]: ID.sheridan });
  const app = await boot({ storage: store });
  store.fail.get = true;
  app.ctx.openCollections(null); await settle();
  assert.strictEqual(app.get('activeViewId'), V('disney'));
  assert.deepStrictEqual(store.log, []);
  app.ctx.selectCollectionTab(ID['90day']); await settle();
  app.ctx.switchMediaType('tv'); await settle();
  app.ctx.openCollections(null); await settle();
  assert.strictEqual(app.get('activeViewId'), V('90day'));
  assert.strictEqual(store.data[KEY], ID['90day']);
  assert.strictEqual(app.consoleErrors.length, 0);
});

test('C9h4 the localStorage getter throwing: visit memory only; no error; D16 and the default write nothing', async () => {
  const pcs = PCS();
  const app = await boot({ personalCollections: pcs });
  Object.defineProperty(app.ctx, 'localStorage', { configurable: true, get() { throw new Error('SecurityError: storage blocked'); } });
  app.ctx.openCollections(null); await settle();
  assert.strictEqual(app.get('activeViewId'), V('disney'));
  app.ctx.selectCollectionTab(ID.sheridan); await settle();
  app.ctx.switchMediaType('tv'); await settle();
  app.ctx.openCollections(null); await settle();
  assert.strictEqual(app.get('activeViewId'), V('sheridan'), 'visit memory');
  coll(app, 'sheridan').archived_at = TS;
  app.ctx.retryOrgRefresh(); await settle();
  app.ctx.switchMediaType('tv'); await settle();
  app.ctx.openCollections(null); await settle();
  assert.strictEqual(app.get('activeViewId'), V('disney'), 'D16 from visit memory');
  assert.strictEqual(app.get('JSON.stringify(lastCollectionVisit)'), JSON.stringify({ known: true, id: null, diverged: true }));
  assert.strictEqual(app.consoleErrors.length, 0);
  assert.ok(!app.el('errorBanner').innerHTML);
});

test('C9h5 no fallback or default id is ever stored or remembered, in every storage mode', async () => {
  for (const fail of [{}, { set: true }, { remove: true }, { noRemove: true }, { get: true }]) {
    const pcs = PCS(); pcs[1].archived_at = TS;
    const store = memStore({ [KEY]: ID.sheridan });
    const app = await boot({ personalCollections: pcs, storage: store });
    Object.assign(store.fail, fail);
    if (fail.noRemove) delete store.removeItem;
    app.ctx.openCollections(null); await settle(); // D16 (or, with get failing, the default)
    app.ctx.switchMediaType('tv'); await settle();
    app.ctx.openCollections(null); await settle(); // the default
    assert.ok(!store.log.some(x => x[0] === 'set'), JSON.stringify([fail, store.log]));
    assert.notStrictEqual(app.get('lastCollectionVisit.id'), ID.disney, 'visit memory never holds the fallback');
    assert.strictEqual(app.get('readLastCollection()'), null, 'nothing remembered after D16 / the default');
  }
});

test('C9k after a restore (simulated) the key is untouched; the next press applies D16 to the restored list', async () => {
  const store = memStore({ [KEY]: ID.sheridan });
  const app = await boot({ storage: store });
  app.ctx.openSettings(null);
  app.store.personal_collections = app.store.personal_collections.filter(c => c.id !== ID.sheridan); // the restored data no longer has it
  app.ctx.invalidateOrganization();
  app.ctx.finishRestoreAndReload(); await settle();
  assert.strictEqual(store.data[KEY], ID.sheridan);
  app.ctx.settingsBack(); await settle();
  app.ctx.openCollections(null); await settle();
  assert.strictEqual(app.get('activeViewId'), V('disney'));
  assert.ok(!(KEY in store.data));
});

// ─── C9l: stale lists (finding 2 and R2-1) ───────────────────────────────────
test('C9l a stale list without the remembered collection: nothing opens, the key is kept; Retry failing keeps it; Retry succeeding resolves (D16 or the remembered one); leaving first means no navigation; a tab still records', async () => {
  for (const variant of ['absent', 'present', 'leave', 'tab']) {
    const pcs = PCS(); pcs.splice(1, 1); // the shown list has no Sheridan
    const store = memStore({ [KEY]: ID.sheridan });
    const app = await boot({ personalCollections: pcs, storage: store });
    await stale(app);
    assert.ok(app.get('orgCollectionsStale') > 0);
    app.ctx.openCollections(null); await settle();
    assert.strictEqual(app.get('activeViewId'), 'collections', 'no automatic entry');
    assert.match(bar(app), /role="tablist"[\s\S]*<p class="collections-state" role="status">Your last collection couldn’t be checked because your collections may be out of date\. Retry, or choose a collection above\.<\/p> <button class="btn collections-retry" id="collectionsRetry" onclick="retryOrgRefresh\(\)">Retry<\/button>/);
    assert.strictEqual(store.data[KEY], ID.sheridan);
    await stale(app);
    assert.deepStrictEqual([app.get('activeViewId'), store.data[KEY]], ['collections', ID.sheridan], 'a failed Retry changes nothing');
    if (variant === 'tab') {
      app.ctx.selectCollectionTab(ID['90day']); await settle();
      assert.strictEqual(store.data[KEY], ID['90day']);
      continue;
    }
    if (variant === 'present') app.store.personal_collections.push({ ...PCS()[1] });
    if (variant === 'leave') { app.ctx.switchMediaType('tv'); await settle(); }
    app.ctx.retryOrgRefresh(); await settle();
    assert.strictEqual(app.get('orgCollectionsStale'), 0);
    if (variant === 'absent') {
      assert.strictEqual(app.get('activeViewId'), V('disney'));
      assert.ok(!(KEY in store.data));
      assert.match(banner(app), /Your last collection isn’t available any more; showing Disney\+\./);
    } else if (variant === 'present') {
      assert.strictEqual(app.get('activeViewId'), V('sheridan'));
      assert.strictEqual(store.data[KEY], ID.sheridan);
    } else {
      assert.strictEqual(app.get('activeViewId'), 'watching', 'no navigation after leaving');
      assert.strictEqual(store.data[KEY], ID.sheridan);
      app.ctx.openCollections(null); await settle();
      assert.strictEqual(app.get('activeViewId'), V('disney'), 'the next press resolves by the same rules (D16)');
      assert.ok(!(KEY in store.data));
    }
  }
});

test('C9l (R2-1) a stale empty list: its own line and Retry, no tab list, the key kept; a confirmed empty list removes it; a list with collections resolves; leaving first means no navigation', async () => {
  for (const variant of ['empty', 'collections', 'without', 'leave']) {
    const store = memStore({ [KEY]: ID.sheridan });
    const app = await boot({ personalCollections: [], storage: store });
    await stale(app);
    app.ctx.openCollections(null); await settle();
    assert.strictEqual(bar(app), '<p class="collections-state" role="status">Your collections couldn’t be refreshed, so this may be out of date.</p> <button class="btn collections-retry" id="collectionsRetry" onclick="retryOrgRefresh()">Retry</button>');
    assert.ok(!/tablist|collectionsCreate|No collections yet|above/.test(bar(app)));
    assert.deepStrictEqual([app.get('activeViewId'), store.data[KEY]], ['collections', ID.sheridan]);
    await stale(app);
    assert.strictEqual(store.data[KEY], ID.sheridan, 'a failed Retry keeps the key');
    if (variant === 'collections') app.store.personal_collections.push(...PCS());
    if (variant === 'without') app.store.personal_collections.push(...PCS().filter(c => c.id !== ID.sheridan)); // active, but not the remembered one
    if (variant === 'leave') { app.store.personal_collections.push(...PCS()); app.ctx.switchMediaType('movie'); await settle(); }
    app.ctx.retryOrgRefresh(); await settle();
    if (variant === 'empty') {
      assert.match(bar(app), /No collections yet\.[\s\S]*collectionsCreate/);
      assert.ok(!(KEY in store.data), 'a confirmed empty list removes it');
    } else if (variant === 'collections') {
      assert.strictEqual(app.get('activeViewId'), V('sheridan'), 'the existing rules: the remembered collection opens');
      assert.strictEqual(store.data[KEY], ID.sheridan);
    } else if (variant === 'without') {
      assert.deepStrictEqual([app.get('activeViewId'), app.get('collectionEntry.kind')], [V('disney'), 'fallback'], 'D16 on the confirmed list');
      assert.ok(!(KEY in store.data), 'the key removed');
      assert.ok(!store.log.some(x => x[0] === 'set'), 'no fallback write');
      assert.match(banner(app), /Your last collection isn’t available any more; showing Disney\+\./);
    } else {
      assert.strictEqual(app.get('activeViewId'), 'allmovies', 'no navigation after leaving');
      assert.strictEqual(store.data[KEY], ID.sheridan);
      app.ctx.openCollections(null); await settle();
      assert.strictEqual(app.get('activeViewId'), V('sheridan'));
    }
  }
});

// ─── C11 (§4) ─────────────────────────────────────────────────────────────────
// Restore through the new entry path (S1's own races, N7–N9 / N16, still pass unchanged).
function withDownloads(app) { app.downloads = 0; app.ctx.downloadJSON = () => { app.downloads++; }; return app; }
async function backupFile(app) {
  const text = JSON.stringify(await app.ctx.buildBackupObject());
  let release;
  return { file: { text: () => new Promise(r => { release = () => r(text); }) }, release: () => release(), text };
}
const modalOpen = app => app.el('restoreModalOverlay').style.display === 'flex';
const restoreWrites = app => app.requests.filter(r => r.method !== 'GET');
const unresolve = app => app.run("orgState = 'loading'; personalCollections = null"); // collections not read yet: openCollections stays on the state

test('C11a on the unresolved Collections state all five restore entry points refuse (no file chooser, dialog, safety backup or restore sent)', async () => {
  const app = withDownloads(await boot());
  const { text } = await backupFile(app);
  unresolve(app);
  app.ctx.openCollections(null);
  assert.strictEqual(app.get('activeViewId'), 'collections');
  let clicked = 0;
  app.el('restoreFileInput').click = () => { clicked++; };
  app.ctx.handleRestoreClick();
  assert.strictEqual(clicked, 0, 'handleRestoreClick');
  assert.strictEqual(app.get('restoreEligibleView()'), false);
  assert.strictEqual(app.get('restoreSessionLive(restoreSessionSeq)'), false, 'restoreSessionLive');
  await app.ctx.handleRestoreFileSelected({ target: { files: [{ text: async () => text }], value: 'x' } }); await settle();
  assert.ok(!modalOpen(app), 'handleRestoreFileSelected');
  app.ctx.__b = JSON.parse(text);
  app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 5');
  await app.ctx.executeRestore(); await settle();
  assert.strictEqual(app.downloads, 0, 'executeRestore');
  app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 5');
  await app.ctx.continueRestoreAfterSafetyConfirm('safety.json'); await settle();
  assert.strictEqual(app.requests.filter(r => r.url.endsWith('/rpc/restore_backup')).length, 0, 'continueRestoreAfterSafetyConfirm');
  assert.deepStrictEqual(restoreWrites(app), []);
});

for (const [point, label] of [['text', 'the file text is being read'], ['preview', 'the preview is reading current data'], ['safety', 'the safety backup is being built'],
  ['confirm', 'the safety-backup confirmation is showing'], ['phase', 'the final phase check is pending']]) {
  test(`C11b pressing Collections while ${label} abandons the preparation: released continuations show no dialog, download or write`, async () => {
    for (const where of ['unresolved state', 'resolving to a collection']) {
      const app = withDownloads(await boot());
      const { file, release, text } = await backupFile(app);
      app.ctx.switchView('alltv'); await settle();
      app.ctx.openSettings(null);
      const go = () => { if (where === 'unresolved state') unresolve(app); app.ctx.openCollections(null); };
      if (point === 'text') {
        const done = app.ctx.handleRestoreFileSelected({ target: { files: [file], value: 'x' } });
        go(); await settle(); release(); await done; await settle();
      } else if (point === 'preview') {
        const done = app.ctx.handleRestoreFileSelected({ target: { files: [file], value: 'x' } });
        const g = app.hold(r => r.method === 'GET' && r.url.includes('/rest/v1/watchlist_items?select=*&'));
        release(); await g.reached;
        go(); await settle(); g.release(); await done; await settle();
      } else {
        await app.ctx.handleRestoreFileSelected({ target: { files: [{ text: async () => text }], value: 'x' } }); await settle();
        assert.ok(app.el('restoreModalBox').innerHTML.includes('executeRestore()'), 'armed');
        if (point === 'safety') {
          const g = app.hold(r => r.method === 'GET' && r.url.includes('/rest/v1/watchlist_items?'));
          const tail = app.ctx.executeRestore(); await g.reached;
          go(); await settle(); g.release(); await tail; await settle();
        } else {
          await app.ctx.executeRestore(); await settle();
          assert.strictEqual(app.downloads, 1, 'the safety backup was downloaded before leaving');
          if (point === 'confirm') { go(); await settle(); }
          else {
            const g = app.hold(r => r.url.endsWith('/rpc/stage5_capabilities'));
            const tail = app.ctx.continueRestoreAfterSafetyConfirm('safety.json'); await g.reached;
            go(); await settle(); g.release(); await tail; await settle();
          }
        }
      }
      const tag = `${point} / ${where}`;
      assert.strictEqual(app.get('activeArea'), 'collections', tag);
      assert.ok(!modalOpen(app), `${tag}: no restore dialog`);
      assert.strictEqual(app.get('pendingRestoreData'), null, `${tag}: nothing pending`);
      assert.strictEqual(app.downloads, point === 'confirm' || point === 'phase' ? 1 : 0, `${tag}: no safety backup after leaving`);
      await app.ctx.executeRestore(); await app.ctx.continueRestoreAfterSafetyConfirm('x.json'); await settle();
      assert.deepStrictEqual(restoreWrites(app), [], `${tag}: no POST/PATCH/DELETE/RPC`);
    }
  });
}

test('C11c a submitted restore is not interrupted by Collections; it verifies, and Close & reload data on the state lets the reloaded collections resolve it', async () => {
  const app = withDownloads(await boot());
  const { text } = await backupFile(app);
  app.ctx.openSettings(null);
  app.ctx.__b = JSON.parse(text);
  app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 5');
  const g = app.hold(r => r.url.endsWith('/rpc/restore_backup'));
  const sent = app.ctx.continueRestoreAfterSafetyConfirm('safety.json');
  await g.reached;
  assert.strictEqual(app.get('restoreInFlight'), true);
  unresolve(app);
  app.ctx.openCollections(null);
  assert.strictEqual(app.get('activeViewId'), 'collections');
  assert.ok(modalOpen(app), 'the in-flight restore keeps its dialog');
  g.release(); await sent; await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  const calls = [];
  const real = app.ctx.loadDerivedView;
  app.ctx.loadDerivedView = () => { calls.push('derived'); return real(); };
  app.ctx.finishRestoreAndReload(); await settle();
  assert.strictEqual(app.get('restoreInFlight'), false);
  assert.deepStrictEqual(calls, [], 'no list loader on the state');
  assert.ok(app.get('activeViewId').startsWith('browse:'), 'the reloaded collections resolved it');
});

// ─── C12 (finding 5) ──────────────────────────────────────────────────────────
test('C12a the unresolved state calls no list loader and sends no request but the organization reads', async () => {
  const setups = {
    loading: async app => { app.run("orgState = 'loading'; personalCollections = null"); },
    unavailable: async app => { app.run("orgState = 'unavailable'"); },
    absent: null,
    none: null,
    stale: async app => { app.store.personal_collections = app.store.personal_collections.filter(c => c.id !== ID.sheridan); app.ctx.retryOrgRefresh(); await settle(); await stale(app); },
    'stale empty': null
  };
  for (const [name, setup] of Object.entries(setups)) {
    const opts = name === 'absent' ? { org: false } : name === 'none' || name === 'stale empty' ? { personalCollections: [] } : {};
    const app = await boot({ ...opts, storage: memStore({ [KEY]: ID.sheridan }) });
    if (setup) await setup(app);
    if (name === 'stale empty') await stale(app);
    app.ctx.openCollections(null); await settle();
    assert.strictEqual(app.get('activeViewId'), 'collections', name);
    const calls = [];
    app.ctx.loadDerivedView = () => { calls.push('derived'); return null; };
    app.ctx.loadBrowseView = () => { calls.push('browse'); return null; };
    app.ctx.loadOrganization = () => Promise.resolve();
    const i = app.requests.length;
    app.ctx.renderFilters(); app.ctx.renderTable();
    assert.strictEqual(app.ctx.reloadOpenView(), true, name);
    app.ctx.buildBrowseBar();
    app.ctx.finishRestoreAndReload(); await settle();
    assert.deepStrictEqual(calls, [], name);
    assert.deepStrictEqual(reqs(app, i), [], name);
    assert.deepStrictEqual(['tbody', 'cardList', 'filtersRow', 'viewHead'].map(id => app.el(id).innerHTML), ['', '', '', ''], name);
    assert.strictEqual(app.get('activeViewId'), 'collections');
  }
});

test('C12b resolution opens exactly one collection and reads it: from Collections, from Settings’ Back to the state, from a publish on the state; never from elsewhere', async () => {
  const wrap = app => { const calls = []; const orig = app.ctx.openBrowseCollection; app.ctx.openBrowseCollection = id => { calls.push(id); return orig(id); }; return calls; };
  const app = await boot();
  let calls = wrap(app);
  let i = app.requests.length;
  app.ctx.openCollections(null); await settle();
  assert.deepStrictEqual(calls, [V('disney')]);
  assert.strictEqual(app.get('activeViewId'), V('disney'));
  assert.ok(reqs(app, i).includes('collection_memberships') && reqs(app, i).includes('watchlist_items'), 'that collection’s ordinary reads');
  // Settings' Back to a Collections-state origin.
  const b = await boot();
  b.run("orgState = 'loading'; personalCollections = null");
  b.ctx.openCollections(null);
  b.ctx.openSettings(null);
  await b.ctx.loadOrganization(); await settle();
  assert.strictEqual(b.get('activeViewId'), 'settings', 'a publish on Settings resolves nothing');
  calls = wrap(b);
  b.ctx.settingsBack(); await settle();
  assert.deepStrictEqual(calls, [V('disney')]);
  // A publish while on the state; and one while elsewhere.
  const c = await boot();
  c.run("orgState = 'loading'; personalCollections = null");
  c.ctx.openCollections(null);
  calls = wrap(c);
  await c.ctx.loadOrganization(); await settle();
  assert.deepStrictEqual(calls, [V('disney')]);
  c.ctx.switchMediaType('tv'); await settle();
  calls.length = 0;
  await c.ctx.loadOrganization(); await settle();
  c.ctx.retryOrgRefresh(); await settle();
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(c.get('activeViewId'), 'watching');
});

test('C12c since S6 only history.js uses the History API, hash routes and the leave-page warning (tests/history-routes.test.js)', () => {
  const root = path.join(__dirname, '..');
  const files = fs.readdirSync(root).filter(f => f.endsWith('.js') && f !== 'history.js').concat('watchlist.html');
  for (const f of files) assert.ok(!/pushState|replaceState|popstate|hashchange|location\.hash|beforeunload/.test(fs.readFileSync(path.join(root, f), 'utf8')), f);
  assert.ok(/pushState/.test(fs.readFileSync(path.join(root, 'history.js'), 'utf8')));
});

// ─── C13 (I-5 A) ──────────────────────────────────────────────────────────────
test('C13 the four strings no longer name Browse', async () => {
  const app = await boot();
  app.run("orgState = 'unavailable'");
  assert.strictEqual(app.get('settingsCollectionsText()'), 'Couldn’t be read. Open Collections and use Retry.');
  const root = path.join(__dirname, '..');
  const src = f => fs.readFileSync(path.join(root, f), 'utf8');
  assert.ok(src('organization-manage.js').includes('Hides ${esc(c.name)} from Collections.') && src('organization-manage.js').includes('(Collections hide Skipped by default)'));
  assert.ok(src('tmdb-match.js').includes('(archived: not shown in Collections)'));
  const all = fs.readdirSync(root).filter(f => f.endsWith('.js')).map(src).join('\n');
  for (const old of ['use Retry beside Browse collections', 'from Browse collections.', 'Browse hides Skipped by default', 'not shown in Browse)']) assert.ok(!all.includes(old), old);
});

// ─── C14 (finding 3) ──────────────────────────────────────────────────────────
test('C14 (1) a remembered entry whose own read confirms it gone gets D16; with none left, the Collections state and the key removed', async () => {
  const store = memStore({ [KEY]: ID.sheridan });
  const app = await boot({ storage: store });
  archive(app, 'sheridan'); // the page still lists it active
  app.ctx.openCollections(null); await settle();
  assert.strictEqual(app.get('activeViewId'), V('disney'));
  assert.strictEqual(app.get('collectionEntry.kind'), 'fallback');
  assert.ok(!(KEY in store.data));
  assert.ok(!store.log.some(x => x[0] === 'set' && x[2] === ID.disney));
  assert.match(banner(app), /role="status">Your last collection isn’t available any more; showing Disney\+\./);
  const s2 = memStore({ [KEY]: ID.sheridan });
  const lone = await boot({ storage: s2 });
  archive(lone, 'disney', 'sheridan', '90day', 'truecrime');
  lone.ctx.openCollections(null); await settle();
  assert.strictEqual(lone.get('activeViewId'), 'collections');
  assert.match(bar(lone), /No collections yet\./);
  assert.ok(!(KEY in s2.data));
});

test('C14 (2)–(4) a delayed remembered read: going to TV, choosing another tab or opening Settings first means no redirect, removal or notice', async () => {
  for (const act of ['tv', 'tab', 'settings']) {
    const store = memStore({ [KEY]: ID.sheridan });
    const app = await boot({ storage: store });
    archive(app, 'sheridan');
    const g = holdOwnRead(app);
    app.ctx.openCollections(null);
    await g.reached;
    if (act === 'tv') { app.ctx.switchMediaType('tv'); await settle(); }
    if (act === 'tab') { app.ctx.selectCollectionTab(ID['90day']); await settle(); }
    if (act === 'settings') app.ctx.openSettings(null);
    const where = app.get('activeViewId');
    g.release(); await settle();
    assert.strictEqual(app.get('activeViewId'), where, act);
    assert.strictEqual(banner(app), '', act);
    assert.strictEqual(store.data[KEY], act === 'tab' ? ID['90day'] : ID.sheridan, act);
  }
});

test('C14 (5)–(9) tab, return, default and fallback entries found gone: the message, no redirect; the key removed only when confirmed and naming it', async () => {
  // (5) a tab entry, confirmed.
  let store = memStore();
  let app = await boot({ storage: store });
  app.ctx.openCollections(null); await settle();
  archive(app, 'sheridan');
  app.ctx.selectCollectionTab(ID.sheridan); await settle();
  assert.strictEqual(app.get('activeViewId'), V('sheridan'), '(5) no redirect');
  assert.match(html(app), /This collection isn’t available any more\. Choose another collection above\./);
  assert.ok(!(KEY in store.data), '(5) it named this one');
  // (6) a tab entry, not confirmed (a newer refresh failed).
  store = memStore();
  app = await boot({ storage: store });
  app.ctx.openCollections(null); await settle();
  archive(app, 'sheridan');
  const g = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
  app.ctx.selectCollectionTab(ID.sheridan);
  await g.reached;
  await stale(app);
  g.release(); await settle();
  assert.match(html(app), /This collection isn’t available any more\./);
  assert.strictEqual(store.data[KEY], ID.sheridan, '(6) kept');
  assert.strictEqual(app.get('activeViewId'), V('sheridan'));
  // (7) a fallback entry found gone.
  const pcs = PCS(); pcs[1].archived_at = TS;
  store = memStore({ [KEY]: ID.sheridan });
  app = await boot({ personalCollections: pcs, storage: store });
  archive(app, 'disney');
  app.ctx.openCollections(null); await settle();
  assert.deepStrictEqual([app.get('activeViewId'), app.get('collectionEntry.kind')], [V('disney'), 'fallback'], '(7) no further redirect');
  assert.match(html(app), /This collection isn’t available any more\./);
  // (8) a default entry found gone.
  store = memStore();
  app = await boot({ storage: store });
  archive(app, 'disney');
  app.ctx.openCollections(null); await settle();
  assert.deepStrictEqual([app.get('activeViewId'), app.get('collectionEntry.kind')], [V('disney'), 'default'], '(8)');
  assert.deepStrictEqual(store.log, [], '(8) no key change');
  // (9) a return entry: Settings' Back after the collection was archived (in Manage).
  store = memStore();
  app = await boot({ storage: store });
  app.ctx.openCollections(null); await settle();
  app.ctx.selectCollectionTab(ID.sheridan); await settle();
  app.ctx.openSettings(null);
  archive(app, 'sheridan');
  app.ctx.settingsBack(); await settle();
  assert.deepStrictEqual([app.get('activeViewId'), app.get('collectionEntry.kind')], [V('sheridan'), 'return'], '(9) no redirect');
  assert.match(html(app), /This collection isn’t available any more\. Choose another collection above\./);
  assert.ok(!(KEY in store.data), '(9) it named this one');
});

// ─── C15 (finding 4, R2-2) ────────────────────────────────────────────────────
test('C15 the chooser is a complete tabs pattern: roles, one selected, roving tabindex, the panel labelled by the open tab only', async () => {
  const app = await boot();
  spyDom(app);
  app.ctx.openCollections(null); await settle();
  assert.match(bar(app), /^<div role="tablist" aria-label="Collections" class="collection-tabs" onkeydown="collectionTabsKeydown\(event\)">/);
  const t = tabs(app);
  assert.strictEqual(t.length, 4);
  assert.strictEqual(new Set(t.map(x => x.id)).size, 4);
  assert.ok(t.every(x => x.controls === 'mainContent'));
  assert.deepStrictEqual(t.map(x => [x.selected, x.tabindex]), [[true, 0], [false, -1], [false, -1], [false, -1]]);
  assert.deepStrictEqual(panel(app), { role: 'tabpanel', 'aria-labelledby': `ctab-${ID.disney}` });
  app.ctx.switchMediaType('tv'); await settle();
  assert.deepStrictEqual(panel(app), {}, 'outside the area: no panel role');
  // On the state (a stale list without the remembered one): none selected, the first focusable.
  const s = await boot({ storage: memStore({ [KEY]: ID.sheridan }) });
  spyDom(s);
  s.store.personal_collections = s.store.personal_collections.filter(c => c.id !== ID.sheridan);
  s.ctx.retryOrgRefresh(); await settle(); await stale(s);
  s.ctx.openCollections(null); await settle();
  assert.deepStrictEqual(tabs(s).map(x => [x.selected, x.tabindex]), [[false, 0], [false, -1], [false, -1]]);
  assert.deepStrictEqual(panel(s), {});
});

test('C15 keys move focus and tabindex without opening anything; Enter / Space are the buttons’ own; focus returns only when it was in the chooser', async () => {
  const app = await boot();
  const log = spyDom(app);
  app.ctx.openCollections(null); await settle();
  const ids = tabs(app).map(x => `ctab-${x.id}`);
  const before = app.requests.length;
  let prevented = 0;
  const key = (k, from) => app.ctx.collectionTabsKeydown({ key: k, target: app.ctx.document.getElementById(from), preventDefault: () => { prevented++; } });
  key('ArrowRight', ids[3]); assert.strictEqual(log.focus.at(-1), ids[0], 'wraps to the first');
  key('ArrowLeft', ids[0]); assert.strictEqual(log.focus.at(-1), ids[3], 'wraps to the last');
  key('Home', ids[2]); assert.strictEqual(log.focus.at(-1), ids[0]);
  key('End', ids[0]); assert.strictEqual(log.focus.at(-1), ids[3]);
  key('ArrowRight', ids[1]); assert.strictEqual(log.focus.at(-1), ids[2]);
  assert.deepStrictEqual(ids.map(id => app.ctx.document.getElementById(id).tabIndex), [-1, -1, 0, -1]);
  assert.strictEqual(prevented, 5);
  const n = log.focus.length;
  key('a', ids[2]); key('Enter', ids[2]);
  assert.strictEqual(log.focus.length, n); assert.strictEqual(prevented, 5, 'other keys are left alone');
  assert.strictEqual(app.requests.length, before, 'arrows open nothing');
  assert.strictEqual(app.get('activeViewId'), V('disney'));
  assert.ok(bar(app).includes(`onclick="selectCollectionTab('${ID.sheridan}')"`), 'Enter / Space: the button’s click');
  // Activation with focus in the chooser: focus on the new selected tab.
  focusOn(app, `ctab-${ID.sheridan}`);
  app.ctx.selectCollectionTab(ID.sheridan); await settle();
  assert.strictEqual(log.focus.at(-1), `ctab-${ID.sheridan}`);
  // A publish redraw: back on the selected tab; with focus elsewhere, nothing moves.
  focusOn(app, `ctab-${ID.sheridan}`); log.focus.length = 0;
  app.ctx.retryOrgRefresh(); await settle();
  assert.deepStrictEqual(log.focus, [`ctab-${ID.sheridan}`]);
  focusOutside(app); log.focus.length = 0;
  app.ctx.retryOrgRefresh(); await settle();
  app.ctx.selectCollectionTab(ID.disney); await settle();
  assert.deepStrictEqual(log.focus, []);
  // The Collections button keeps focus after being pressed.
  app.ctx.switchMediaType('tv'); await settle();
  const btn = focusOn(app, 'areaBtn-collections');
  app.ctx.openCollections(btn); await settle();
  assert.strictEqual(log.focus.at(-1), 'areaBtn-collections');
});

test('C15 (delayed) the Collections button keeps focus through a later resolution and an asynchronous D16 — unless focus has moved elsewhere', async () => {
  const cases = {
    // the list is pending when Collections is pressed; its publication resolves the default
    resolution: { key: null, prepare: app => { unresolve(app); }, hold: 'personal_collections', expect: 'disney', notice: false },
    // the pending list arrives without the remembered collection: D16 at resolution
    'D16 at resolution': { key: 'sheridan', prepare: app => { unresolve(app); app.store.personal_collections = app.store.personal_collections.filter(c => c.id !== ID.sheridan); }, hold: 'personal_collections', expect: 'disney', notice: true },
    // the remembered collection opens, and its own read confirms it gone: D16 after that read
    'D16 after the own read': { key: 'sheridan', prepare: app => { archive(app, 'sheridan'); }, hold: 'collection_memberships', expect: 'disney', notice: true }
  };
  for (const [name, c] of Object.entries(cases)) {
    for (const moved of [false, true]) {
      const app = await boot({ storage: memStore(c.key ? { [KEY]: ID[c.key] } : {}) });
      const log = spyDom(app);
      c.prepare(app);
      const g = app.hold(r => r.url.includes(`/rest/v1/${c.hold}?`));
      const pending = c.hold === 'personal_collections' ? app.ctx.loadOrganization() : null;
      if (pending) await g.reached;
      const btn = focusOn(app, 'areaBtn-collections');
      app.ctx.openCollections(btn);
      if (!pending) await g.reached;
      assert.strictEqual(log.focus.at(-1), 'areaBtn-collections', `${name}: kept at once`);
      if (moved) focusOutside(app);
      log.focus.length = 0;
      g.release(); await (pending || Promise.resolve()); await settle();
      assert.strictEqual(app.get('activeViewId'), V(c.expect), name);
      if (c.notice) assert.match(banner(app), /isn’t available any more/, name);
      if (moved) assert.deepStrictEqual(log.focus, [], `${name}: focus moved elsewhere is left there`);
      else {
        assert.ok(log.focus.length >= 1 && log.focus.every(id => id === 'areaBtn-collections'), `${name}: ${log.focus}`);
        assert.strictEqual(app.ctx.document.activeElement, app.ctx.document.getElementById('areaBtn-collections'), `${name}: on the button now drawn`);
      }
    }
  }
});

// An open collection that its own read finds gone, per entry kind (no D16 except a confirmed remembered entry).
async function unavailable(kind, { others = true, stale: isStale = false, focus = 'tab' } = {}) {
  const store = memStore(kind === 'fallback' ? { [KEY]: ID['90day'] } : {});
  const pcs = PCS();
  if (kind === 'fallback') pcs[2].archived_at = TS; // the remembered 90 Day is gone: D16 opens Disney+
  const app = await boot({ storage: store, personalCollections: pcs });
  const log = spyDom(app);
  const target = kind === 'default' || kind === 'fallback' ? 'disney' : 'sheridan';
  if (kind === 'tab' || kind === 'return') { app.ctx.openCollections(null); await settle(); }
  if (kind === 'return') { app.ctx.selectCollectionTab(ID.sheridan); await settle(); app.ctx.openSettings(null); }
  if (kind === 'remembered') store.data[KEY] = ID.sheridan;
  archive(app, ...(others ? [target] : ['disney', 'sheridan', '90day', 'truecrime']));
  const g = holdOwnRead(app);
  if (kind === 'tab') app.ctx.selectCollectionTab(ID[target]);
  else if (kind === 'return') app.ctx.settingsBack();
  else app.ctx.openCollections(null);
  await g.reached;
  if (isStale) await stale(app);
  if (focus === 'tab') focusOn(app, `ctab-${ID[target]}`); else focusOutside(app);
  log.focus.length = 0;
  g.release(); await settle();
  return { app, log, store, target };
}

test('C15 (u1, u2, u7) unavailable with other tabs, for every non-D16 entry kind: none selected, the first focusable, no panel role or missing reference, focus to the first tab, no redirect', async () => {
  for (const [kind, opts] of [['tab', {}], ['return', {}], ['default', {}], ['fallback', {}], ['remembered', { stale: true }]]) {
    const { app, log, target } = await unavailable(kind, opts);
    assert.strictEqual(app.get('activeViewId'), V(target), `${kind}: no redirect`);
    const t = tabs(app);
    assert.ok(!t.some(x => x.id === ID[target]), `${kind}: its tab is gone`);
    assert.ok(t.every(x => !x.selected), kind);
    assert.deepStrictEqual(t.map(x => x.tabindex), [0, ...Array(t.length - 1).fill(-1)], kind);
    assert.deepStrictEqual(panel(app), {}, kind);
    assert.ok(!(bar(app) + app.el('mainContent').innerHTML).includes(`ctab-${ID[target]}`), kind);
    assert.match(html(app), /id="collectionUnavailableRow" tabindex="-1" data-unavailable="1">This collection isn’t available any more\. Choose another collection above\./, kind);
    assert.deepStrictEqual(log.focus, [`ctab-${t[0].id}`], `${kind}: the removed tab’s focus goes to the first remaining tab`);
    if (kind === 'remembered') assert.match(html(app), /Read again/);
  }
  const { app, log } = await unavailable('tab', { focus: 'elsewhere' });
  assert.deepStrictEqual(log.focus, [], 'focus elsewhere is not moved');
  // u7: keyboard entry after u1.
  const first = tabs(app)[0];
  app.ctx.collectionTabsKeydown({ key: 'ArrowRight', target: app.ctx.document.getElementById(`ctab-${first.id}`), preventDefault() {} });
  assert.strictEqual(log.focus.at(-1), `ctab-${tabs(app)[1].id}`);
  app.ctx.selectCollectionTab(tabs(app)[1].id); await settle();
  assert.strictEqual(app.get('collectionEntry.kind'), 'tab');
});

test('C15 (u3–u6) no tab left — applicable empty, stale empty, nothing to focus — for each applicable entry kind; and the not-confirmed listed tab', async () => {
  // u3: an applicable empty list (tab, return, default, fallback; a confirmed remembered entry gets D16 instead: C14 (1)).
  for (const kind of ['tab', 'return', 'default', 'fallback']) {
    const { app, log, target } = await unavailable(kind, { others: false });
    assert.strictEqual(app.get('activeViewId'), V(target), `u3 ${kind}: no redirect`);
    assert.ok(!bar(app).includes('tablist'), `u3 ${kind}: no empty tab list`);
    assert.match(bar(app), /No collections yet\.[\s\S]*collectionsCreate/, `u3 ${kind}`);
    assert.deepStrictEqual(panel(app), {}, `u3 ${kind}`);
    assert.match(html(app), /data-unavailable="1">This collection isn’t available any more\.<\/td>/, `u3 ${kind}: one sentence`);
    assert.deepStrictEqual(log.focus, ['collectionsCreate'], `u3 ${kind}`);
    // u5: no tab and no button (the collections reloading): the visible message.
    focusOn(app, 'collectionsCreate'); log.focus.length = 0;
    app.ctx.invalidateOrganization();
    assert.deepStrictEqual(log.focus, ['collectionUnavailableRow'], `u5 ${kind}`);
  }
  // u4: a stale empty list (every non-D16 kind, incl. a remembered entry, which it leaves unconfirmed).
  for (const kind of ['tab', 'return', 'default', 'fallback', 'remembered']) {
    const { app, log, target, store } = await unavailable(kind, { others: false, stale: true });
    assert.strictEqual(app.get('activeViewId'), V(target), `u4 ${kind}: no redirect`);
    assert.ok(!bar(app).includes('tablist'), `u4 ${kind}`);
    assert.match(bar(app), /Your collections couldn’t be refreshed, so this may be out of date\.[\s\S]*collectionsRetry/, `u4 ${kind}`);
    assert.deepStrictEqual(panel(app), {}, `u4 ${kind}`);
    assert.deepStrictEqual(log.focus, ['collectionsRetry'], `u4 ${kind}`);
    if (kind === 'tab' || kind === 'return' || kind === 'remembered') assert.strictEqual(store.data[KEY], ID.sheridan, `u4 ${kind}: the key kept (not confirmed)`);
    if (kind === 'remembered') assert.match(html(app), /Read again/);
  }
  // u6: not confirmed, its tab still listed (a newer list published first).
  const store = memStore();
  const a6 = await boot({ storage: store });
  spyDom(a6);
  a6.ctx.openCollections(null); await settle();
  const g = a6.hold(r => r.url.includes('/rest/v1/personal_collections?')); // the own read's collections
  a6.ctx.selectCollectionTab(ID.sheridan);
  await g.reached;
  a6.ctx.retryOrgRefresh(); await settle(); // publishes Sheridan active
  archive(a6, 'sheridan');
  g.release(); await settle(); // the older own read can't publish
  assert.match(html(a6), /This collection isn’t available any more\./);
  assert.deepStrictEqual(tabs(a6).filter(x => x.selected).map(x => x.id), [ID.sheridan]);
  assert.deepStrictEqual(panel(a6), { role: 'tabpanel', 'aria-labelledby': `ctab-${ID.sheridan}` });
  assert.strictEqual(store.data[KEY], ID.sheridan, 'u6: not confirmed, kept');
});

// ─── S2V2-2: Retry keeps the focus intent across loading ─────────────────────
// A browser-like focus model: document.activeElement falls back to <body> once the focused element
// has been removed by a redraw (as in Chrome), so a lost focus is what the page sees.
function liveFocus(app) {
  const doc = app.ctx.document, orig = doc.getElementById, log = [];
  const body = { id: 'body', tagName: 'BODY', closest: () => null };
  const inChooser = id => /^ctab-/.test(id) || id === 'collectionsRetry' || id === 'collectionsCreate';
  let focused = null, pageFocus = true;
  doc.body = body;
  doc.getElementById = id => {
    const e = orig(id);
    if (e && !e.__live) {
      e.__live = true;
      e.focus = () => { log.push(id); focused = e; };
      e.setAttribute = () => {}; e.removeAttribute = () => {}; e.scrollIntoView = () => {};
      e.closest = sel => (sel === '#browseBar' && inChooser(id) ? {} : null);
      Object.defineProperty(e, 'isConnected', { configurable: true, get: () => orig(id) === e });
    }
    return e;
  };
  Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => (focused && focused.isConnected !== false ? focused : body), set: v => { focused = v; } });
  doc.hasFocus = () => pageFocus;
  return { log, body, setPageFocus: v => { pageFocus = v; }, focusOn: id => { focused = doc.getElementById(id); return focused; },
    elsewhere: () => { focused = { id: 'elsewhere', isConnected: true, closest: () => null }; }, active: () => doc.activeElement };
}
const intentOf = app => app.get("typeof chooserFocusIntent === 'undefined' ? null : chooserFocusIntent"); // null on a tree without the intent
async function unavailableState(app) {
  app.run("orgState = 'loading'; personalCollections = null");
  app.failNext(r => r.url.includes('/rest/v1/personal_collections?'));
  app.ctx.openCollections(null); await app.ctx.loadOrganization(); await settle();
  assert.strictEqual(app.get('orgState'), 'unavailable');
  assert.match(bar(app), /id="collectionsRetry" onclick="loadOrganization\(\)"/);
}
// Retry pressed with keyboard focus on it (its own handler, loadOrganization), its read held.
async function pressRetry(app, f) {
  f.focusOn('collectionsRetry'); f.log.length = 0;
  const g = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
  const p = app.ctx.loadOrganization();
  await g.reached;
  assert.match(bar(app), /Loading collections…/);
  assert.strictEqual(f.active(), f.body, 'while loading, focus has nothing to stay on (the Retry button is gone)');
  return { g, p };
}

test('R1 Retry in "Collections unavailable" that succeeds: focus comes back to the selected tab (it was lost while loading)', async () => {
  const app = await boot(); const f = liveFocus(app);
  await unavailableState(app);
  const { g, p } = await pressRetry(app, f);
  g.release(); await p; await settle();
  assert.strictEqual(app.get('activeViewId'), V('disney'));
  assert.strictEqual(f.active(), app.ctx.document.getElementById(`ctab-${ID.disney}`), `focus on the selected tab: ${f.log}`);
  assert.strictEqual(intentOf(app), null);
});

test('R2 Retry that finds no collections (confirmed empty): focus on Create', async () => {
  const app = await boot(); const f = liveFocus(app);
  await unavailableState(app);
  app.store.personal_collections = [];
  const { g, p } = await pressRetry(app, f);
  g.release(); await p; await settle();
  assert.match(bar(app), /No collections yet\./);
  assert.strictEqual(f.active(), app.ctx.document.getElementById('collectionsCreate'), `${f.log}`);
});

test('R3 Retry that fails again: focus on the new Retry', async () => {
  const app = await boot(); const f = liveFocus(app);
  await unavailableState(app);
  const { g, p } = await pressRetry(app, f);
  g.fail(); await p; await settle();
  assert.strictEqual(app.get('orgState'), 'unavailable');
  const again = app.ctx.document.getElementById('collectionsRetry');
  assert.ok(again && again.isConnected, 'Retry drawn again');
  assert.strictEqual(f.active(), again, `${f.log}`);
});

test('R4–R7 the held intent never steals focus: focus moved elsewhere, Collections left, page without focus, or a superseded load', async () => {
  for (const act of ['moved', 'left', 'page', 'superseded']) {
    const app = await boot(); const f = liveFocus(app);
    await unavailableState(app);
    const { g, p } = await pressRetry(app, f);
    let g2 = null, p2 = null;
    if (act === 'moved') f.elsewhere();
    if (act === 'left') { app.ctx.switchMediaType('tv'); await settle(); }
    if (act === 'page') f.setPageFocus(false);
    if (act === 'superseded') { g2 = app.hold(r => r.url.includes('/rest/v1/personal_collections?')); p2 = app.ctx.loadOrganization(); await g2.reached; }
    g.release(); await p; await settle();
    if (g2) { g2.release(); await p2; await settle(); }
    assert.deepStrictEqual(f.log, [], `${act}: ${f.log}`);
    assert.strictEqual(intentOf(app), null, `${act}: intent cleared`);
    if (act === 'moved') assert.strictEqual(f.active().id, 'elsewhere');
    if (act === 'left') assert.strictEqual(app.get('activeViewId'), 'watching');
    if (act === 'page') { f.setPageFocus(true); app.ctx.retryOrgRefresh(); await settle(); assert.deepStrictEqual(f.log, [], 'no late restore'); }
  }
});

test('R8 the stale-list Retry: a repeated failure keeps focus on Retry; success moves it to the selected tab (state and collection view)', async () => {
  // On the stale Collections state (the remembered collection not in the shown list).
  let store = memStore({ [KEY]: ID.sheridan });
  let app = await boot({ storage: store }); let f = liveFocus(app);
  app.store.personal_collections = app.store.personal_collections.filter(c => c.id !== ID.sheridan);
  app.ctx.retryOrgRefresh(); await settle(); await stale(app);
  app.ctx.openCollections(null); await settle();
  assert.strictEqual(app.get('activeViewId'), 'collections');
  f.focusOn('collectionsRetry'); f.log.length = 0;
  await stale(app);
  assert.strictEqual(f.active(), app.ctx.document.getElementById('collectionsRetry'), `failure: ${f.log}`);
  app.store.personal_collections.push({ ...PCS()[1] });
  f.log.length = 0;
  app.ctx.retryOrgRefresh(); await settle();
  assert.strictEqual(app.get('activeViewId'), V('sheridan'));
  assert.strictEqual(f.active(), app.ctx.document.getElementById(`ctab-${ID.sheridan}`), `success: ${f.log}`);
  // The stale mark beside an open collection's tabs.
  app = await boot(); f = liveFocus(app);
  app.ctx.openCollections(null); await settle();
  await stale(app);
  assert.ok(f.focusOn('collectionsRetry'), 'the stale mark’s Retry has the chooser id');
  f.log.length = 0;
  await stale(app);
  assert.strictEqual(f.active(), app.ctx.document.getElementById('collectionsRetry'), `failure: ${f.log}`);
  app.ctx.retryOrgRefresh(); await settle();
  assert.ok(!bar(app).includes('may be out of date'));
  assert.strictEqual(f.active(), app.ctx.document.getElementById(`ctab-${ID.disney}`), `success: ${f.log}`);
});

test('R9 Retry success with the remembered collection gone: D16 (fallback, notice, key removed, nothing saved) and focus on the selected tab', async () => {
  const store = memStore({ [KEY]: ID.sheridan });
  const app = await boot({ storage: store }); const f = liveFocus(app);
  await unavailableState(app);
  app.store.personal_collections = app.store.personal_collections.filter(c => c.id !== ID.sheridan);
  const { g, p } = await pressRetry(app, f);
  g.release(); await p; await settle();
  assert.deepStrictEqual([app.get('activeViewId'), app.get('collectionEntry.kind')], [V('disney'), 'fallback']);
  assert.match(banner(app), /Your last collection isn’t available any more; showing Disney\+\./);
  assert.ok(!(KEY in store.data));
  assert.ok(!store.log.some(x => x[0] === 'set'), 'no fallback write');
  assert.strictEqual(f.active(), app.ctx.document.getElementById(`ctab-${ID.disney}`), `${f.log}`);
});

// ─── S2V2-2 (rev3): an abandoned Retry focus return is cancelled for good ───────
// S2_BEHAVIOUR_ONLY=1 skips the checks of internal state (the held intent, the listener count), so the
// observable outcome can be compared on a tree without the cancellation (mutation evidence).
const internal = check => { if (!process.env.S2_BEHAVIOUR_ONLY) check(); };
// liveFocus plus the page events the cancellation listens to: listeners on document / window are
// recorded, and focus arriving on an element (a user's move, or a script's focus()) dispatches focusin.
function liveEvents(app) {
  const f = liveFocus(app), doc = app.ctx.document, win = app.ctx;
  const reg = { document: [], window: [] };
  const on = where => (type, fn, opt) => reg[where].push({ type, fn, capture: opt === true || !!(opt && opt.capture) });
  const off = where => (type, fn, opt) => { const c = opt === true || !!(opt && opt.capture); const i = reg[where].findIndex(l => l.type === type && l.fn === fn && l.capture === c); if (i >= 0) reg[where].splice(i, 1); };
  doc.addEventListener = on('document'); doc.removeEventListener = off('document');
  win.addEventListener = on('window'); win.removeEventListener = off('window');
  doc.visibilityState = 'visible';
  const fire = (where, type, target) => reg[where].filter(l => l.type === type).slice().forEach(l => l.fn({ type, target }));
  // focus() on any element also fires focusin, as in a browser.
  const getById = doc.getElementById;
  doc.getElementById = id => { const e = getById(id); if (e && !e.__evented) { e.__evented = true; const fo = e.focus; e.focus = () => { fo(); fire('document', 'focusin', e); }; } return e; };
  return Object.assign(f, { reg, count: () => reg.document.length + reg.window.length,
    userFocus: () => { f.elsewhere(); fire('document', 'focusin', doc.activeElement); },
    backToBody: () => { f.focusOn('no-such-element'); },
    pageBlur: () => { f.setPageFocus(false); fire('window', 'blur', win); }, pageFocus: () => { f.setPageFocus(true); fire('window', 'focus', win); },
    hide: () => { doc.visibilityState = 'hidden'; fire('document', 'visibilitychange', doc); }, show: () => { doc.visibilityState = 'visible'; fire('document', 'visibilitychange', doc); } });
}

test('X1 Retry held → the page loses focus → regains it → the answer arrives: no focus return (cancelled at the blur); listeners removed', async () => {
  const app = await boot(); const f = liveEvents(app);
  await unavailableState(app);
  const { g, p } = await pressRetry(app, f);
  internal(() => assert.ok(intentOf(app), 'the Retry button’s own removal did not cancel the intent'));
  internal(() => assert.strictEqual(f.count(), 3, 'focusin, blur and visibilitychange listeners while the intent is held'));
  f.pageBlur();
  internal(() => assert.strictEqual(intentOf(app), null, 'cancelled by the blur'));
  internal(() => assert.strictEqual(f.count(), 0, 'listeners removed on cancel'));
  f.pageFocus();
  g.release(); await p; await settle();
  assert.strictEqual(app.get('activeViewId'), V('disney'));
  assert.deepStrictEqual(f.log, [], `no focus return: ${f.log}`);
  assert.strictEqual(f.active(), f.body);
});

test('X2 Retry held → focus deliberately moves elsewhere → returns to the body → the answer arrives: no focus return', async () => {
  const app = await boot(); const f = liveEvents(app);
  await unavailableState(app);
  const { g, p } = await pressRetry(app, f);
  f.userFocus();
  internal(() => assert.strictEqual(intentOf(app), null, 'cancelled by focus arriving elsewhere'));
  internal(() => assert.strictEqual(f.count(), 0));
  f.backToBody();
  assert.strictEqual(f.active(), f.body, 'focus is back on the body before the answer');
  g.release(); await p; await settle();
  assert.deepStrictEqual(f.log, [], `no focus return: ${f.log}`);
});

test('X3 Retry held → the page is hidden → shown again → the answer arrives: no focus return; a visible-again event alone cancels nothing', async () => {
  const app = await boot(); const f = liveEvents(app);
  await unavailableState(app);
  const { g, p } = await pressRetry(app, f);
  f.show();
  internal(() => assert.ok(intentOf(app), 'visibilitychange to visible does not cancel'));
  f.hide();
  internal(() => assert.strictEqual(intentOf(app), null));
  internal(() => assert.strictEqual(f.count(), 0));
  f.show();
  g.release(); await p; await settle();
  assert.deepStrictEqual(f.log, [], `${f.log}`);
});

test('X4 an uninterrupted Retry still returns focus (selected tab, Create, Retry) and removes its listeners; navigation and a superseded load remove them too', async () => {
  for (const outcome of ['success', 'empty', 'failure']) {
    const app = await boot(); const f = liveEvents(app);
    await unavailableState(app);
    if (outcome === 'empty') app.store.personal_collections = [];
    const { g, p } = await pressRetry(app, f);
    internal(() => assert.strictEqual(f.count(), 3, outcome));
    if (outcome === 'failure') g.fail(); else g.release();
    await p; await settle();
    const want = outcome === 'success' ? `ctab-${ID.disney}` : outcome === 'empty' ? 'collectionsCreate' : 'collectionsRetry';
    assert.strictEqual(f.active(), app.ctx.document.getElementById(want), `${outcome}: ${f.log}`);
    internal(() => assert.strictEqual(intentOf(app), null, outcome));
    internal(() => assert.strictEqual(f.count(), 0, `${outcome}: listeners removed`));
  }
  for (const act of ['left', 'superseded']) {
    const app = await boot(); const f = liveEvents(app);
    await unavailableState(app);
    const { g, p } = await pressRetry(app, f);
    let g2 = null, p2 = null;
    if (act === 'left') { app.ctx.switchMediaType('tv'); await settle(); }
    else { g2 = app.hold(r => r.url.includes('/rest/v1/personal_collections?')); p2 = app.ctx.loadOrganization(); await g2.reached; }
    internal(() => assert.strictEqual(f.count(), 0, `${act}: listeners removed when the intent is dropped`));
    g.release(); await p; await settle();
    if (g2) { g2.release(); await p2; await settle(); }
    assert.deepStrictEqual(f.log.filter(id => id !== 'areaBtn-tv'), [], `${act}: ${f.log}`);
    internal(() => assert.strictEqual(f.count(), 0));
  }
});

// ─── O-1: the keyboard-focused tab is scrolled fully into view ────────────────────
test('K1 Arrow / Home / End scroll the newly focused tab into view (nearest), without opening it or sending anything; Enter / Space stay the buttons’ own', async () => {
  const app = await boot();
  const log = spyDom(app);
  app.ctx.openCollections(null); await settle();
  const ids = tabs(app).map(x => `ctab-${x.id}`);
  const before = app.requests.length;
  for (const [key, from, to] of [['ArrowRight', 0, 1], ['ArrowLeft', 0, 3], ['Home', 2, 0], ['End', 0, 3], ['ArrowRight', 3, 0]]) {
    log.scroll.length = 0;
    app.ctx.collectionTabsKeydown({ key, target: app.ctx.document.getElementById(ids[from]), preventDefault() {} });
    assert.strictEqual(log.focus.at(-1), ids[to], key);
    assert.strictEqual(JSON.stringify(log.scroll), JSON.stringify([[ids[to], { block: 'nearest', inline: 'nearest' }]]), `${key}: scrolled into view`); // (the options object comes from the page's realm)
  }
  log.scroll.length = 0; const n = log.focus.length;
  for (const key of ['Enter', ' ']) app.ctx.collectionTabsKeydown({ key, target: app.ctx.document.getElementById(ids[1]), preventDefault() { throw new Error('not prevented'); } });
  assert.deepStrictEqual([log.scroll.length, log.focus.length], [0, n], 'Enter / Space are not handled by the key handler');
  assert.strictEqual(app.requests.length, before, 'no request');
  assert.strictEqual(app.get('activeViewId'), V('disney'), 'nothing opened');
});

T.run();
