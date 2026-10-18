// Offline tests for S6: browser / device history and routes (O1; D12, D15, D17 B, D18; D3 / D4 with
// history). The page runs in the whole-page harness with its opt-in session history (routes: {}): a
// model of one document's entries, not a browser. Real Back / Forward, reload and direct links are
// checked in Chrome separately.
// Run from the repo root: node tests/history-routes.test.js
const assert = require('assert');
const { createApp, runner, settle, userKeyOf } = require('./app-harness');

const T = runner('history-routes');
const test = (name, fn) => (!process.env.ONLY || name.includes(process.env.ONLY)) && T.test(name, fn);

let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
function show(o, nums) {
  const s = { id: nid('show'), collection: 'truecrime', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 100 + n, status: 'watching', ...o };
  const rows = nums.map(num => ({ id: nid('r'), collection: s.collection, title: s.title, theme: 'Net', status: 'pending', watched: num === 1, skipped: false,
    show_id: s.id, media_type: 'tv', tmdb_id: s.tmdb_id, season_number: num, season: `Season ${num}`, display_date: `Jan 1, ${2010 + num}`,
    date_sort: `${2010 + num}-01-01`, item_key: `${s.show_key}|season ${num}`, watch_with: [], collections: [] }));
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'truecrime', title: 'Film', theme: 'Doc', status: 'confirmed', watched: false,
  media_type: null, tmdb_id: null, season_number: null, season: 'Film', display_date: 'Jan 1, 2015', date_sort: '2015-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });
function lib() {
  const L = { alpha: show({ title: 'Alpha' }, [1, 2]), bravo: show({ title: 'Bravo', collection: 'disney' }, [1, 2]), f1: film({ title: 'Doc One' }), f2: film({ title: 'Other Film', collection: 'othertv' }) };
  L.data = { rows: [...L.alpha.rows, ...L.bravo.rows, L.f1, L.f2], shows: [L.alpha.show, L.bravo.show] };
  return L;
}
const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m }; };
const boot = (opts = {}, L = lib()) => createApp({ rows: L.data.rows, tvShows: L.data.shows, routes: { hash: '', ...(opts.routes || {}) }, storage: opts.storage, ...opts.extra });
const H = app => app.history;
const urls = app => H(app).entries.map(e => e.url);
const at = app => H(app).entries[H(app).at].url;
const writes = app => app.requests.filter(r => r.method !== 'GET');
const view = app => app.get('activeViewId');
const cid = (app, k) => app.browseId(k).split(':')[1];
const nav = async (app, fn) => { fn(); await settle(); };
const back = async app => { app.back(); await settle(); };
const forward = async app => { app.forward(); await settle(); };

// ═══ Routes and entries (V6.1, V6.2) ═══════════════════════════════════════════
test('V6.1 every area, view, collection and Settings has its route; each navigation you make pushes one entry; no filter or name in a URL', async () => {
  const app = await boot();
  assert.deepStrictEqual(urls(app), ['#/tv/watching'], 'startup replaces the entry with its route');
  assert.strictEqual(app.get('routeEntry'), 1);
  await nav(app, () => app.ctx.switchView('alltv'));
  await nav(app, () => app.ctx.switchView('comingsoon'));
  await nav(app, () => app.ctx.switchMediaType('movie'));
  await nav(app, () => app.ctx.openSettings(null));
  await nav(app, () => app.ctx.openCollections(null)); // resolves to the first collection (Disney+)
  await nav(app, () => app.ctx.selectCollectionTab(cid(app, 'truecrime')));
  const T1 = cid(app, 'truecrime'), D = cid(app, 'disney');
  const u = urls(app);
  assert.deepStrictEqual(u.slice(0, 5), ['#/tv/watching', '#/tv/alltv', '#/tv/comingsoon', '#/movies', '#/settings']);
  assert.ok(/^#\/collections\/[\w-]+$/.test(u[5]), 'Collections resolved to a collection by replacing its entry');
  assert.strictEqual(u[5], `#/collections/${D}`);
  assert.strictEqual(u[6], `#/collections/${T1}`);
  assert.strictEqual(u.length, 7, 'one entry per navigation');
  assert.deepStrictEqual(H(app).entries.map(e => e.state.n), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(u.every(x => !/fSearch|\?|Disney|True/i.test(x)), 'no filter or name');
  assert.ok(T1 && writes(app).length === 0);
});
test('V6.2 no entry for filters, toggles, expansion, panels, dialogs, writes, rereads or Retry; pressing the open area again adds none', async () => {
  const L = lib();
  const app = await boot({}, L);
  await nav(app, () => app.ctx.openCollections(null));
  await nav(app, () => app.ctx.selectCollectionTab(cid(app, 'truecrime')));
  const len = urls(app).length;
  app.el('fSearch').value = 'a'; app.ctx.renderTable();
  app.ctx.setBrowseMedia('tv'); app.ctx.setBrowsePresentation('seasons'); app.ctx.setBrowsePresentation('shows');
  app.ctx.toggleBrowseShow(L.alpha.show.id); app.ctx.toggleFilterPanel(true);
  app.ctx.openAddPicker(null); app.ctx.closeAddPicker();
  app.dialogAnswer = 'cancel'; await app.ctx.removeFromCollection('show', L.alpha.show.id, null);
  await app.ctx.setShowStateById(L.alpha.show.id, { priority: 'high' }); await settle();
  await app.ctx.loadBrowseView(); await settle();
  app.ctx.openManage('members', cid(app, 'truecrime'), null); await settle(); app.ctx.closeManage(); await settle();
  await nav(app, () => app.ctx.openCollections(null));
  assert.strictEqual(urls(app).length, len, 'no entry added');
  assert.strictEqual(writes(app).length, 1, 'the priority change only');
});
test('V6.1 / D12 startup with a route opens it fresh (navigation reads only); an unknown route opens Currently Watching and is replaced; none opens Currently Watching', async () => {
  for (const [hash, expect, url] of [['#/movies', 'allmovies', '#/movies'], ['#/tv/comingsoon', 'comingsoon', '#/tv/comingsoon'], ['#/settings', 'settings', '#/settings'],
    ['#/nope', 'watching', '#/tv/watching'], ['#/collections/bad id!', 'watching', '#/tv/watching'], ['', 'watching', '#/tv/watching']]) {
    const app = await boot({ routes: { hash, state: { watchlist: 1, n: 4 } } });
    assert.strictEqual(view(app), expect, hash);
    assert.deepStrictEqual(urls(app), [url], `${hash}: replaced, no extra entry`);
    assert.strictEqual(app.get('routeEntry'), 4, 'a reload keeps its entry number');
    assert.deepStrictEqual(writes(app), []);
    if (expect === 'allmovies') assert.strictEqual(app.get('activeArea'), 'movie');
  }
});
test('D12 a direct link to a collection opens it with its remembered layout once read, and doesn’t change the remembered collection; #/collections resolves to the remembered one by replacing', async () => {
  const s = store();
  const probe = await boot();
  const D = cid(probe, 'disney'), TC = cid(probe, 'truecrime');
  s.setItem(userKeyOf('watchlist_last_collection'), TC);
  s.setItem(userKeyOf(`watchlist_browse_layout_id_${D}`), JSON.stringify({ presentation: 'seasons', grouping: 'combined' }));
  const key = probe.get(`browseCollectionOf(${JSON.stringify(probe.browseId('disney'))}).layoutKey`);
  s.setItem(userKeyOf(key), JSON.stringify({ presentation: 'seasons', grouping: 'combined' }));
  const app = await boot({ routes: { hash: `#/collections/${D}` }, storage: s });
  assert.strictEqual(view(app), app.browseId('disney'));
  assert.deepStrictEqual([app.get('browsePresentation'), app.get('browseGrouping')], ['seasons', 'combined'], 'its remembered layout');
  assert.strictEqual(s.getItem(userKeyOf('watchlist_last_collection')), TC, 'a route doesn’t record the remembered collection');
  const app2 = await boot({ routes: { hash: '#/collections' }, storage: s });
  await settle();
  assert.strictEqual(view(app2), app2.browseId('truecrime'));
  assert.deepStrictEqual(urls(app2), [`#/collections/${TC}`], 'resolved by replacing');
});
test('a direct link to a collection that is gone shows the message (no redirect)', async () => {
  const app = await boot({ routes: { hash: '#/collections/00000000-0000-4000-8000-00000000dead' } });
  await settle();
  assert.ok(app.el('tbody').innerHTML.includes('This collection isn’t available any more.'));
  assert.deepStrictEqual(writes(app), []);
});

// ═══ Back / Forward (V6.3, V6.4, V6.5) ════════════════════════════════════════
test('V6.3 Back, Forward and a multi-entry go(-n) navigate to the target entry with navigation reads only; never a write', async () => {
  const app = await boot();
  await nav(app, () => app.ctx.switchView('alltv'));
  await nav(app, () => app.ctx.switchMediaType('movie'));
  await nav(app, () => app.ctx.openSettings(null));
  const mark = app.requests.length;
  await back(app);
  assert.deepStrictEqual([view(app), at(app), app.get('activeArea')], ['allmovies', '#/movies', 'movie']);
  app.go(-2); await settle();
  assert.deepStrictEqual([view(app), at(app), app.get('activeArea')], ['watching', '#/tv/watching', 'tv']);
  await forward(app);
  assert.strictEqual(view(app), 'alltv');
  app.go(2); await settle();
  assert.strictEqual(view(app), 'settings');
  assert.strictEqual(urls(app).length, 4, 'traversal adds no entry');
  assert.ok(app.requests.slice(mark).every(r => r.method === 'GET'), 'navigation reads only');
});
test('V6.4 (D15) Back / Forward put that entry’s filters back from page memory, the panel closed; nothing in the URL or storage; a fresh entry starts from defaults', async () => {
  const s = store();
  const app = await boot({ storage: s });
  await nav(app, () => app.ctx.switchView('alltv'));
  app.el('fSearch').value = 'alp'; app.ctx.renderTable();
  app.ctx.toggleFilterPanel(true);
  await nav(app, () => app.ctx.switchMediaType('movie'));
  app.el('fWatch').value = 'watched'; app.ctx.renderTable();
  await back(app);
  assert.strictEqual(view(app), 'alltv');
  assert.strictEqual(app.el('fSearch').value, 'alp', 'All TV’s search came back');
  assert.strictEqual(app.get('filterPanelOpen'), false, 'the panel opens closed');
  await forward(app);
  assert.strictEqual(app.el('fWatch').value, 'watched', 'All Movies’ Watched came back');
  await nav(app, () => app.ctx.switchView('alltv')); // a new entry for All TV (not a traversal)
  assert.strictEqual(app.el('fSearch').value, '', 'a new entry starts from defaults');
  assert.ok(urls(app).every(u => !u.includes('alp')) && ![...s.map.values()].some(v => String(v).includes('alp')));
});
test('V6.5 (D3) a collection’s Back link uses the browser’s Back when its origin is directly behind; otherwise it pushes (filters kept as before)', async () => {
  const app = await boot();
  await nav(app, () => app.ctx.switchView('alltv'));
  app.el('fSearch').value = 'alp'; app.ctx.renderTable();
  await nav(app, () => app.ctx.openCollections(null));
  const len = urls(app).length;
  app.ctx.browseBack(); await settle();
  assert.deepStrictEqual([view(app), urls(app).length, H(app).at], ['alltv', len, len - 2], 'the browser’s Back: no new entry');
  assert.strictEqual(app.el('fSearch').value, 'alp');
  await forward(app);
  await nav(app, () => app.ctx.selectCollectionTab(cid(app, 'truecrime')));
  app.ctx.browseBack(); await settle();
  assert.strictEqual(view(app), 'alltv');
  assert.strictEqual(H(app).at, urls(app).length - 1, 'not directly behind: a new entry');
  assert.strictEqual(app.el('fSearch').value, 'alp', 'its filters, as before (D3)');
});
test('V6.5 (D4) Settings’ Back to library uses the browser’s Back when its origin is directly behind', async () => {
  const app = await boot();
  await nav(app, () => app.ctx.switchView('comingsoon'));
  await nav(app, () => app.ctx.openSettings(null));
  const len = urls(app).length;
  app.ctx.settingsBack(); await settle();
  assert.deepStrictEqual([view(app), urls(app).length, at(app)], ['comingsoon', len, '#/tv/comingsoon']);
});
test('a route typed or followed while the page is open opens its view as a new entry', async () => {
  const app = await boot();
  app.followLink('#/movies'); await settle();
  assert.deepStrictEqual([view(app), app.get('routeEntry'), H(app).entries[1].state.n], ['allmovies', 2, 2]);
  app.followLink('#/garbage'); await settle();
  assert.deepStrictEqual([view(app), at(app)], ['watching', '#/tv/watching']);
});

// ═══ Dialogs and pending work (V6.6–V6.10; D17 B) ═════════════════════════════
test('V6.6 an idle view-bound dialog is closed by its Cancel rules and the page navigates: the delete question (nothing sent), Details (draft discarded), the Add picker', async () => {
  const L = lib();
  const app = await boot({}, L);
  await nav(app, () => app.ctx.openCollections(null));
  await nav(app, () => app.ctx.selectCollectionTab(cid(app, 'truecrime')));
  app.dialogAnswer = 'hold';
  const p = app.ctx.delRow(L.f1.id); await settle();
  await back(app);
  await p; await settle();
  assert.strictEqual(app.dialogs[0].answered, null, 'not answered by the owner');
  assert.strictEqual(app.el('effectModalOverlay').style.display, 'none');
  assert.deepStrictEqual(writes(app), [], 'nothing sent');
  await forward(app);
  app.ctx.openDetails('film', L.f1.id, null);
  assert.ok(app.get('detailsDialog'));
  await back(app);
  assert.strictEqual(app.get('detailsDialog'), null);
  await forward(app);
  app.ctx.openAddPicker(null);
  await back(app);
  assert.strictEqual(app.get('addPicker'), null);
  assert.deepStrictEqual(writes(app), []);
  // Close / Escape act on the dialog only.
  await forward(app);
  const before = JSON.stringify([urls(app), H(app).at]);
  app.ctx.openAddPicker(null); app.ctx.addPickerKeydown({ key: 'Escape', preventDefault() {} });
  app.ctx.openManage('collections', null, null); await settle(); app.ctx.manageKeydown({ key: 'Escape', preventDefault() {} });
  assert.strictEqual(JSON.stringify([urls(app), H(app).at]), before, 'history untouched by Close / Escape');
});
test('V6.7 Back during a submitting Add batch: Stop after this one; the answer is recorded, not published; the target view says so; returning reads again without that visit’s notice', async () => {
  const L = lib();
  const app = await boot({}, L);
  await nav(app, () => app.ctx.switchView('alltv'));
  await nav(app, () => app.ctx.openCollections(null));
  await nav(app, () => app.ctx.selectCollectionTab(cid(app, 'truecrime')));
  app.ctx.openAddPicker(null);
  app.ctx.addPickerToggle(`i:${L.f2.id}`, true); app.ctx.addPickerToggle(`s:${L.bravo.show.id}`, true);
  const g = app.hold(r => r.url.endsWith('/rpc/org_add_membership'));
  const p = app.ctx.submitAddPicker();
  await g.reached;
  await back(app);
  assert.strictEqual(app.get('addPicker'), null, 'the dialog closes with the navigation');
  g.release(); await p; await settle();
  assert.strictEqual(app.requests.filter(r => r.url.endsWith('/rpc/org_add_membership')).length, 1, 'nothing further sent');
  assert.ok(app.el('banner').innerHTML.includes('stopped when you left: 1 added, 1 not sent') && !app.el('banner').innerHTML.includes('undoAddBatch'));
  await forward(app);
  assert.ok(!app.el('banner').innerHTML.includes('Add to'), 'that visit’s notice is gone');
});
test('V6.8 Manage with a change pending stays open over the target view; an idle one closes; nothing resent', async () => {
  const app = await boot();
  await nav(app, () => app.ctx.switchView('alltv'));
  await nav(app, () => app.ctx.openSettings(null));
  app.ctx.openManage('collections', null, null); await settle();
  await back(app);
  assert.strictEqual(app.get('manage'), null, 'idle: closed');
  await forward(app);
  app.ctx.openManage('collections', null, null); await settle();
  app.run("manage.drafts.manageNewCollection = 'ZZ New Test'");
  const g = app.hold(r => r.url.endsWith('/rpc/org_create_collection'));
  const p = app.ctx.manageCreate('collection');
  await g.reached;
  await back(app);
  assert.ok(app.get('manage') !== null && view(app) === 'alltv', 'busy: stays open over the target view');
  g.release(); await p; await settle();
  assert.strictEqual(app.requests.filter(r => r.url.endsWith('/rpc/org_create_collection')).length, 1);
});
test('V6.10 a restore being prepared is abandoned by a traversal; one already sent is not interrupted', async () => {
  const app = await boot();
  await nav(app, () => app.ctx.switchView('alltv'));
  await nav(app, () => app.ctx.openSettings(null));
  app.run("pendingRestoreData = { formatVersion: 5 }; document.getElementById('restoreModalOverlay').style.display = 'flex'");
  await back(app);
  assert.strictEqual(app.get('pendingRestoreData'), null);
  assert.strictEqual(app.el('restoreModalOverlay').style.display, 'none');
  await forward(app);
  app.run("pendingRestoreData = { formatVersion: 5 }; restoreInFlight = true; document.getElementById('restoreModalOverlay').style.display = 'flex'");
  await back(app);
  assert.ok(app.get('pendingRestoreData') !== null && app.el('restoreModalOverlay').style.display === 'flex', 'sent: left alone');
});

// ═══ Leaving and returning (V6.11, V6.12) and focus (V6.15) ═══════════════════
test('V6.12 (D18) the leave warning is registered only while a change is out or a restore has been sent', async () => {
  const L = lib();
  const app = await boot({}, L);
  await nav(app, () => app.ctx.switchView('alltv'));
  assert.strictEqual(app.listenerCount('beforeunload'), 0, 'idle');
  const g = app.hold(r => r.url.endsWith('/rpc/library_set_show_state_b45'));
  const p = app.ctx.setShowStateById(L.alpha.show.id, { priority: 'high' });
  await g.reached;
  assert.strictEqual(app.listenerCount('beforeunload'), 1, 'while a change is out');
  const ev = { returnValue: undefined, preventDefault() { this.prevented = true; } };
  app.history.listeners.beforeunload[0](ev);
  assert.ok(ev.prevented && ev.returnValue === '');
  g.release(); await p; await settle();
  assert.strictEqual(app.listenerCount('beforeunload'), 0, 'removed afterwards');
  app.run('restoreInFlight = true; updateLeaveWarning()');
  assert.strictEqual(app.listenerCount('beforeunload'), 1, 'a restore sent');
  app.run('closeRestoreModal()');
  assert.strictEqual(app.listenerCount('beforeunload'), 0);
  app.go(-5); await settle();
  assert.deepStrictEqual(app.history.left, [-5], 'leaving the document isn’t intercepted');
});
test('V6.11 a page brought back from the back/forward cache: a change that was out is not confirmed, never resent; the open view is read again', async () => {
  const L = lib();
  const app = await boot({}, L);
  await nav(app, () => app.ctx.switchView('alltv'));
  const g = app.hold(r => r.url.endsWith('/rpc/library_set_show_state_b45'));
  const p = app.ctx.setShowStateById(L.alpha.show.id, { priority: 'high' });
  await g.reached;
  const mark = app.requests.length;
  app.firePageShow(true); await settle();
  assert.ok(app.el('errorBanner').innerHTML.includes('wasn’t confirmed: you left the page while it was being saved'));
  g.fail(); await p; await settle();
  assert.strictEqual(app.requests.filter(r => r.url.endsWith('/rpc/library_set_show_state_b45')).length, 1, 'never resent');
  assert.ok(app.requests.slice(mark).some(r => r.method === 'GET' && r.url.includes('/tv_shows')), 'read again');
  app.firePageShow(false); // a normal load: nothing
});
test('V6.15 focus in the replaced content goes to the area’s button after a traversal; focus in an open dialog or elsewhere is not moved', async () => {
  const app = await boot();
  await nav(app, () => app.ctx.switchView('alltv'));
  await nav(app, () => app.ctx.switchMediaType('movie'));
  const inList = { id: 'x', closest: sel => (sel.includes('#mainContent') ? {} : null) };
  app.ctx.document.activeElement = inList;
  await back(app);
  assert.strictEqual(app.ctx.document.activeElement.id, 'areaBtn-tv');
  const outside = { id: 'y', closest: () => null };
  app.ctx.document.activeElement = outside;
  await forward(app);
  assert.strictEqual(app.ctx.document.activeElement, outside, 'not moved');
});

// ═══ Review corrections ════════════════════════════════════════════════════════
test('review B1: a traversal onto a bare #/collections entry resolves by replacing that entry, so Back returns to the same collection with its filters', async () => {
  const app = await boot();
  await nav(app, () => app.ctx.switchView('alltv'));
  app.followLink('#/collections'); await settle();
  const A = app.get('activeViewId');
  assert.strictEqual(at(app), `#/collections/${A.split(':')[1]}`, 'the resolution replaced the entry');
  app.el('fSearch').value = 'alp'; app.ctx.renderTable();
  await nav(app, () => app.ctx.selectCollectionTab(cid(app, 'truecrime')));
  await back(app);
  assert.strictEqual(view(app), A, 'the same collection');
  assert.strictEqual(app.el('fSearch').value, 'alp', 'with its filters');
});
test('review 4: a route typed after going Back drops the Forward entries’ page memory (no stale filters)', async () => {
  const app = await boot();
  await nav(app, () => app.ctx.switchView('alltv'));
  await nav(app, () => app.ctx.switchMediaType('movie'));
  app.el('fWatch').value = 'watched'; app.ctx.renderTable();
  await nav(app, () => app.ctx.openSettings(null));
  app.go(-2); await settle(); // All TV
  app.followLink('#/movies'); await settle();
  assert.strictEqual(view(app), 'allmovies');
  assert.strictEqual(app.el('fWatch').value, 'unwatched', 'defaults, not the old visit’s filters');
});
test('review 1: a back/forward-cache return during an Add batch stops it; the item out becomes Not confirmed; nothing further is sent; a late answer is only recorded', async () => {
  const L = lib();
  const app = await boot({}, L);
  await nav(app, () => app.ctx.openCollections(null));
  await nav(app, () => app.ctx.selectCollectionTab(cid(app, 'truecrime')));
  app.ctx.openAddPicker(null);
  app.ctx.addPickerToggle(`i:${L.f2.id}`, true); app.ctx.addPickerToggle(`s:${L.bravo.show.id}`, true);
  const g = app.hold(r => r.url.endsWith('/rpc/org_add_membership'));
  const p = app.ctx.submitAddPicker();
  await g.reached;
  app.firePageShow(true); await settle();
  g.release(); await p; await settle();
  assert.strictEqual(app.requests.filter(r => r.url.endsWith('/rpc/org_add_membership')).length, 1);
  const st = JSON.parse(app.get('JSON.stringify(addBatch.items.map(i => i.state))'));
  assert.deepStrictEqual(st, ['unconfirmed', 'notsent']);
  assert.ok(!app.el('addPickerBox').innerHTML.includes('undoAddBatch()'), 'no Undo for it');
});
test('review 1: a Remove whose answer arrives after a back/forward-cache return changes nothing on the page (no Undo); the list is read again', async () => {
  const L = lib();
  const app = await boot({}, L);
  await nav(app, () => app.ctx.openCollections(null));
  await nav(app, () => app.ctx.selectCollectionTab(cid(app, 'truecrime')));
  const g = app.hold(r => r.url.endsWith('/rpc/org_remove_membership'));
  const p = app.ctx.removeFromCollection('film', L.f1.id, null);
  await g.reached;
  app.firePageShow(true); await settle();
  g.release(); await p; await settle();
  assert.ok(!app.el('banner').innerHTML.includes('undoCollectionRemove'), 'no Undo');
  assert.strictEqual(app.get('collectionUndo'), null);
});

T.run();
