// Offline tests for S1: the Settings & Management screen (B7) and the header Backup
// button (O5), in the whole-page harness. Restore is prepared and confirmed only on
// Settings (D11); an already-submitted restore is never interrupted. Settings reads
// nothing; its buttons open the existing dialogs and flows.
// Run from the repo root: node tests/settings.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('settings');
const test = T.test;

// A small library with real UUIDs and every column, so its backup is valid (as tests/browse-views.test.js).
function restoreLibrary() {
  const u = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const at = '2026-01-01T00:00:00+00:00';
  const showRow = { id: u(1), collection: 'disney', title: 'Andor', show_key: 'andor', tmdb_id: null, status: 'watching', created_at: at };
  const base = { theme: 'Star Wars', watch_with: [], collections: [], tmdb_collection_id: null, tmdb_collection_name: null, created_at: at, skipped: false };
  return {
    shows: [showRow],
    rows: [
      { ...base, id: u(2), collection: 'disney', item_key: 'andor|season 1', title: 'Andor', season: 'Season 1', display_date: 'Sep 21, 2022', date_sort: '2022-09-21',
        watched: true, status: 'confirmed', media_type: null, tmdb_id: null, season_number: null, show_id: u(1) },
      { ...base, id: u(3), collection: 'movies', item_key: 'dune|film', title: 'Dune', season: 'Film', display_date: 'Oct 22, 2021', date_sort: '2021-10-22',
        watched: false, status: 'confirmed', media_type: 'movie', tmdb_id: 438631, season_number: null, show_id: null }
    ]
  };
}
async function boot(opts = {}) {
  const lib = restoreLibrary();
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows, ...opts });
  app.downloads = 0;
  app.ctx.downloadJSON = () => { app.downloads++; };
  return app;
}
const screen = app => app.el('settingsScreen').innerHTML;
const modalOpen = app => app.el('restoreModalOverlay').style.display === 'flex';
const restoreWrites = app => app.requests.filter(r => r.method !== 'GET');
const firstCollection = app => app.get('activeBrowseCollections()[0].id');
async function backupFile(app) {
  const text = JSON.stringify(await app.ctx.buildBackupObject());
  let release;
  return { file: { text: () => new Promise(r => { release = () => r(text); }) }, release: () => release(), text };
}
const memStore = (initial = {}) => { const data = { ...initial }; return { data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: k => { delete data[k]; } }; };

// ─── N1, N2: entry, selected state, no reads ─────────────────────────────────────
test('N1 the labelled gear opens Settings: the gear is the current page, no area is active, no tab or Browse row, the list hidden', async () => {
  const app = await boot();
  assert.match(app.el('settingsEntry').innerHTML, /id="settingsBtn" aria-label="Settings &amp; Management" onclick="openSettings\(this\)">⚙ Settings</);
  assert.ok(!app.el('settingsEntry').innerHTML.includes('aria-current'), 'not current before');
  assert.ok(/media-switch-btn active/.test(app.el('mediaSwitch').innerHTML), 'TV active before');
  app.ctx.openSettings(null);
  assert.strictEqual(app.get('activeViewId'), 'settings');
  assert.ok(app.el('settingsEntry').innerHTML.includes('aria-current="page"'));
  assert.ok(!/media-switch-btn active/.test(app.el('mediaSwitch').innerHTML), 'no primary button active on Settings');
  assert.strictEqual(app.el('tabBar').hidden, true);
  assert.strictEqual(app.el('tabBar').innerHTML, '');
  assert.strictEqual(app.el('browseBar').innerHTML, '');
  for (const id of ['viewHead', 'filtersRow', 'statsRow', 'tbody', 'cardList']) assert.strictEqual(app.el(id).innerHTML, '', `${id} empty`);
  assert.strictEqual(app.el('desktopTable').style.display, 'none');
  assert.strictEqual(app.el('cardList').style.display, 'none');
  assert.strictEqual(app.el('settingsScreen').style.display, '');
  assert.match(screen(app), /id="settingsTitle"[^>]*>⚙ Settings &amp; Management</);
  assert.match(screen(app), /settingsBack\(\)">← Back to library</);
  for (const t of ['Library management', 'Catalog updates', 'Backup &amp; Restore']) assert.ok(screen(app).includes(`>${t}</h3>`), t);
  app.ctx.switchMediaType('tv'); await settle();
  assert.strictEqual(app.el('settingsScreen').style.display, 'none', 'hidden again on leaving');
  assert.strictEqual(app.el('desktopTable').style.display, '');
  assert.strictEqual(app.el('cardList').style.display, '');
  assert.ok(!app.el('settingsEntry').innerHTML.includes('aria-current'));
});

test('N2 entering Settings sends no request; the counts come from what is already loaded', async () => {
  const app = await boot();
  const before = app.requests.length;
  app.ctx.openSettings(null); await settle();
  assert.strictEqual(app.requests.length, before, 'no request');
  const collections = app.get('personalCollections');
  const archived = collections.filter(c => c.archived_at).length;
  assert.ok(screen(app).includes(`${collections.length - archived} active · ${archived} archived`));
  assert.ok(screen(app).includes(`${app.get('watchWithChoices').filter(c => !c.archived_at).length} active`));
});

// ─── N3, N4: the moved controls and focus ───────────────────────────────────────
test('N3 each Settings button calls the same function with the same arguments as before (and itself as the opener)', async () => {
  const app = await boot();
  app.ctx.openSettings(null);
  const html = screen(app);
  assert.ok(html.includes(`onclick="openManage('collections', null, this)">Manage collections…`));
  assert.ok(html.includes(`onclick="openManage('choices', null, this)">Manage watch-with choices…`));
  assert.ok(html.includes('onclick="openCatalogChooser(this)">Review catalog updates…'));
  assert.ok(html.includes('id="settingsBackupBtn" onclick="handleBackupClick(this)">⬇ Download backup'));
  assert.ok(html.includes('onclick="handleRestoreClick()">⬆ Restore from a backup file…'));
  const calls = [];
  app.ctx.openManage = (...a) => calls.push(['openManage', ...a.map(x => (x && typeof x === 'object' ? 'opener' : x))]);
  app.ctx.openCatalogChooser = o => calls.push(['openCatalogChooser', o ? 'opener' : o]);
  for (const m of html.matchAll(/onclick="((?:openManage|openCatalogChooser)\([^"]*\))"/g)) app.run(`(function () { ${m[1]}; }).call({ id: 'x' })`.replace(/this/g, '{ id: "x" }'));
  assert.deepStrictEqual(calls, [['openManage', 'collections', null, 'opener'], ['openManage', 'choices', null, 'opener'], ['openCatalogChooser', 'opener']]);
});

test('N4 closing Manage or the catalog chooser / dialog returns focus to its Settings button, or to the redrawn equivalent', async () => {
  const app = await boot();
  app.ctx.openSettings(null);
  const focused = [];
  const opener = (cls, connected) => ({ isConnected: connected, matches: sel => sel === cls, focus: () => focused.push(`${cls} (opener)`) });
  app.ctx.document.querySelector = sel => ({ focus: () => focused.push(`${sel} (redrawn)`) });
  app.ctx.openManage('collections', null, opener('.settings-manage-collections', true)); await settle();
  app.ctx.closeManage(); await settle();
  app.ctx.openManage('choices', null, opener('.settings-manage-choices', false)); await settle();
  app.ctx.closeManage(); await settle();
  app.ctx.openCatalogChooser(opener('.settings-catalog-btn', true)); await settle();
  app.ctx.closeCatalogChooser(); await settle();
  app.ctx.openCatalogChooser({ isConnected: false }); await settle();
  app.ctx.closeCatalogChooser(); await settle();
  app.ctx.openCatalogUpdates('sheridan', { isConnected: false }); await settle();
  app.ctx.closeCatalogUpdates(); await settle();
  assert.deepStrictEqual(focused, ['.settings-manage-collections (opener)', '.settings-manage-choices (redrawn)', '.settings-catalog-btn (opener)',
    '#settingsScreen .settings-catalog-btn (redrawn)', '#settingsScreen .settings-catalog-btn (redrawn)']);
});

// ─── N5, N6: Back to library and the primary buttons ────────────────────────────
test('N5 Back to library returns to the origin view with that visit\'s filters (hidden values too); a collection keeps its own Back', async () => {
  const app = await boot();
  // Currently Watching, Coming Soon and All Movies: the view is restored.
  for (const [media, view] of [['tv', 'watching'], ['tv', 'comingsoon'], ['movie', 'allmovies']]) {
    app.ctx.switchMediaType(media); await settle();
    app.ctx.switchView(view); await settle();
    app.el('fSearch').value = 'zz-' + view;
    app.ctx.openSettings(null);
    app.ctx.settingsBack(); await settle();
    assert.strictEqual(app.get('activeViewId'), view);
    assert.strictEqual(app.get('activeMediaType'), media);
    assert.strictEqual(app.el('fSearch').value, 'zz-' + view, `${view}: Search put back`);
  }
  // All TV with a value hidden by Seasons (Progress applies in Shows only).
  app.ctx.switchMediaType('tv'); await settle();
  app.ctx.switchView('alltv'); await settle();
  app.ctx.setAllTvPresentation('shows'); await settle();
  app.el('fStatus').value = 'all';
  app.el('fProgress').value = 'unwatched';
  app.ctx.renderTable();
  app.ctx.setAllTvPresentation('seasons'); await settle();
  app.ctx.openSettings(null);
  assert.strictEqual(app.get('settingsOrigin.filters.fProgress'), 'unwatched', 'the hidden value is carried');
  app.ctx.settingsBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'alltv');
  assert.strictEqual(app.el('fStatus').value, 'all');
  assert.strictEqual(app.get('viewFilterMemory.values.fProgress'), 'unwatched', 'the hidden value is kept for the visit');
  // A collection opened from All TV: Back to library returns to it, and its own Back still goes to All TV.
  const col = firstCollection(app);
  app.ctx.openBrowseCollection(col); await settle();
  app.ctx.openSettings(null);
  app.ctx.settingsBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), col);
  assert.strictEqual(app.get('browseOrigin.viewId'), 'alltv');
  assert.ok(app.el('viewHead').innerHTML.includes('← Back to All TV'));
  app.ctx.browseBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'alltv');
  assert.strictEqual(app.el('fStatus').value, 'all', 'the collection\'s Back still puts All TV\'s filters back');
  // No origin: the TV landing view.
  app.run('settingsOrigin = null');
  app.ctx.openSettings(null); app.run('settingsOrigin = null');
  app.ctx.settingsBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'watching');
});

test('N6 on Settings the primary buttons follow their landing rules, even when the area already matches', async () => {
  const app = await boot();
  assert.strictEqual(app.get('activeMediaType'), 'tv');
  app.ctx.openSettings(null);
  app.ctx.switchMediaType('tv'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'watching', 'TV is not a dead button on Settings');
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openSettings(null);
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies', 'Movies is not a dead button on Settings');
  app.ctx.openSettings(null);
  const before = app.get('restoreSessionSeq');
  app.ctx.openSettings(null); // the gear while on Settings: no navigation
  assert.strictEqual(app.get('restoreSessionSeq'), before, 'no navigation, so nothing is abandoned');
});

// ─── N7–N9: restore eligibility (D11) ───────────────────────────────────────────
const VIEWS = [['watching', 'tv'], ['alltv', 'tv'], ['comingsoon', 'tv'], ['allmovies', 'movie'], ['collection', 'tv'], ['settings', 'tv']];
async function goTo(app, [view, media]) {
  if (view === 'settings') { app.ctx.openSettings(null); return; }
  app.ctx.switchMediaType(media); await settle();
  if (view === 'collection') app.ctx.openBrowseCollection(firstCollection(app)); else app.ctx.switchView(view);
  await settle();
}
test('N7 rule R: every restore entry point runs only on Settings (Currently Watching, All TV, Coming Soon, All Movies and collections refuse)', async () => {
  for (const v of VIEWS) {
    const app = await boot();
    const { text } = await backupFile(app);
    await goTo(app, v);
    const allowed = v[0] === 'settings';
    let clicked = 0;
    app.el('restoreFileInput').click = () => { clicked++; };
    app.ctx.handleRestoreClick();
    assert.strictEqual(clicked, allowed ? 1 : 0, `${v[0]}: handleRestoreClick`);
    assert.strictEqual(app.get('restoreEligibleView()'), allowed, `${v[0]}: restoreEligibleView`);
    assert.strictEqual(app.get('restoreSessionLive(restoreSessionSeq)'), allowed, `${v[0]}: restoreSessionLive`);
    await app.ctx.handleRestoreFileSelected({ target: { files: [{ text: async () => text }], value: 'x' } }); await settle();
    assert.strictEqual(modalOpen(app) && app.el('restoreModalBox').innerHTML.includes('executeRestore()'), allowed, `${v[0]}: handleRestoreFileSelected`);
    app.ctx.__b = JSON.parse(text);
    app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 5');
    await app.ctx.executeRestore(); await settle();
    assert.strictEqual(app.downloads, allowed ? 1 : 0, `${v[0]}: executeRestore (safety backup)`);
    app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 5');
    await app.ctx.continueRestoreAfterSafetyConfirm('safety.json'); await settle();
    const sent = app.requests.filter(r => r.url.endsWith('/rpc/restore_backup')).length;
    assert.strictEqual(sent, allowed ? 1 : 0, `${v[0]}: continueRestoreAfterSafetyConfirm`);
    if (!allowed) assert.deepStrictEqual(restoreWrites(app), [], `${v[0]}: nothing written`);
  }
});

const NAVS = [
  ['Back to library', app => app.ctx.settingsBack()],
  ['TV', app => app.ctx.switchMediaType('tv')],
  ['Movies', app => app.ctx.switchMediaType('movie')],
  ['a view', app => app.ctx.switchView('comingsoon')],
  ['the Browse selector', app => app.ctx.openBrowseCollection(firstCollection(app))]
];
for (const [point, label] of [['text', 'the file text arrives'], ['preview', 'the preview is reading current data'], ['safety', 'the safety backup is being built'], ['confirm', 'the safety-backup confirmation is showing']]) {
  test(`N8 restore race on Settings: any navigation while ${label} abandons the restore (no dialog, download or write afterwards)`, async () => {
    for (const [navName, nav] of NAVS) {
      const app = await boot();
      const { file, release } = await backupFile(app);
      app.ctx.switchView('alltv'); await settle();
      app.ctx.openSettings(null); // with an origin, so Back to library navigates
      const done = app.ctx.handleRestoreFileSelected({ target: { files: [file], value: 'x' } });
      let tail = done;
      if (point === 'text') {
        nav(app); await settle(); release(); await done; await settle();
      } else if (point === 'preview') {
        const g = app.hold(r => r.method === 'GET' && r.url.includes('/rest/v1/watchlist_items?select=*&'));
        release(); await g.reached;
        nav(app); await settle(); g.release(); await done; await settle();
      } else {
        release(); await done; await settle();
        assert.ok(app.el('restoreModalBox').innerHTML.includes('executeRestore()'), `${navName}: armed`);
        if (point === 'safety') {
          const g = app.hold(r => r.method === 'GET' && r.url.includes('/rest/v1/watchlist_items?'));
          tail = app.ctx.executeRestore(); await g.reached;
          nav(app); await settle(); g.release(); await tail; await settle();
        } else {
          await app.ctx.executeRestore(); await settle();
          assert.strictEqual(app.downloads, 1, `${navName}: the safety backup was downloaded before leaving`);
          nav(app); await settle();
        }
      }
      assert.ok(!modalOpen(app), `${navName} (${point}): no restore dialog`);
      assert.strictEqual(app.get('pendingRestoreData'), null, `${navName} (${point}): nothing pending`);
      assert.strictEqual(app.downloads, point === 'confirm' ? 1 : 0, `${navName} (${point}): no safety backup after leaving`);
      await app.ctx.executeRestore(); await app.ctx.continueRestoreAfterSafetyConfirm('x.json'); await settle();
      assert.deepStrictEqual(restoreWrites(app), [], `${navName} (${point}): no POST/PATCH/DELETE/RPC`);
      assert.notStrictEqual(app.get('activeViewId'), 'settings', `${navName}: navigated`);
    }
  });
}

test('N9 after submission navigation does not abandon the restore; it verifies and "Close & reload data" reloads the view then open', async () => {
  for (const leave of [false, true]) {
    const app = await boot();
    const { text } = await backupFile(app);
    app.ctx.openSettings(null);
    app.ctx.__b = JSON.parse(text);
    app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 5');
    const g = app.hold(r => r.url.endsWith('/rpc/restore_backup'));
    const sent = app.ctx.continueRestoreAfterSafetyConfirm('safety.json');
    await g.reached;
    assert.strictEqual(app.get('restoreInFlight'), true);
    if (leave) { app.ctx.switchView('alltv'); await settle(); }
    assert.ok(modalOpen(app), 'the in-flight restore keeps its dialog');
    g.release(); await sent; await settle();
    assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
    let derived = 0;
    const real = app.ctx.loadDerivedView;
    app.ctx.loadDerivedView = () => { derived++; return real(); };
    app.ctx.finishRestoreAndReload(); await settle();
    assert.strictEqual(app.get('restoreInFlight'), false);
    assert.strictEqual(derived, leave ? 1 : 0, leave ? 'the list view open then is reloaded' : 'Settings: no list loader');
    if (!leave) assert.match(screen(app), /id="settingsTitle"/, 'Settings drawn again');
  }
});

// ─── N10a, N10b, N11: reload branches and redraw guards ─────────────────────────
function spies(app) {
  const counts = { loadOrganization: 0, loadDerivedView: 0, loadBrowseView: 0 };
  for (const name of Object.keys(counts)) {
    const real = app.ctx[name];
    app.ctx[name] = (...a) => { counts[name]++; return real(...a); };
  }
  return counts;
}
test('N10a finishRestoreAndReload on Settings: the modal and panel closed, tabData cleared, organization reloaded, Settings drawn again; no list loader', async () => {
  const app = await boot();
  app.ctx.openSettings(null);
  app.run("tabData = { x: { rows: [] } }");
  app.ctx.showRestoreModal('<div>result</div>');
  app.el('settingsScreen').innerHTML = 'stale';
  const counts = spies(app);
  const before = app.requests.length;
  app.ctx.finishRestoreAndReload(); await settle();
  assert.ok(!modalOpen(app), 'modal closed');
  assert.strictEqual(app.get('libraryPanel'), null, 'panel closed');
  assert.strictEqual(app.get('Object.keys(tabData).length'), 0, 'tabData cleared');
  assert.deepStrictEqual(counts, { loadOrganization: 1, loadDerivedView: 0, loadBrowseView: 0 });
  assert.match(screen(app), /id="settingsTitle"/);
  const reads = app.requests.slice(before).map(r => r.url.split('/rest/v1/')[1].split('?')[0]);
  // The organization read (loadOrganization → readPersonalCollections reads the collections with their catalog and presentation views).
  assert.ok(reads.every(t => ['personal_collections', 'library_collection_catalogs', 'library_collection_presentation', 'watch_with_choices'].includes(t)), 'organization reads only: ' + reads.join(', '));
});

test('N10b reloadOpenView on Settings: Settings drawn again and true returned; no organization reload, no list load, no request', async () => {
  const app = await boot();
  app.ctx.openSettings(null);
  app.el('settingsScreen').innerHTML = 'stale';
  const counts = spies(app);
  const before = app.requests.length;
  const res = app.ctx.reloadOpenView(); await settle();
  assert.strictEqual(res, true);
  assert.match(screen(app), /id="settingsTitle"/);
  assert.deepStrictEqual(counts, { loadOrganization: 0, loadDerivedView: 0, loadBrowseView: 0 });
  assert.strictEqual(app.requests.length, before, 'no request');
});

test('N11 a late redraw on Settings (filters, list) draws nothing', async () => {
  const app = await boot();
  app.ctx.openSettings(null);
  app.ctx.renderFilters();
  app.ctx.renderTable();
  app.ctx.redrawForWatchWith();
  for (const id of ['filtersRow', 'tbody', 'cardList', 'statsRow', 'viewHead']) assert.strictEqual(app.el(id).innerHTML, '', `${id} untouched`);
  assert.match(screen(app), /id="settingsTitle"/, 'Settings still shown');
});

// ─── N12, N13: Backup (O5) ──────────────────────────────────────────────────────
test('N12 Backup in the header and on Settings: one build and download per press; while busy both disabled and the pressed one says "Backing up…"; a second press does nothing', async () => {
  for (const pressedId of ['backupBtn', 'settingsBackupBtn', null]) {
    const app = await boot();
    app.ctx.openSettings(null);
    let builds = 0, resolve;
    app.ctx.buildBackupObject = () => { builds++; return new Promise(r => { resolve = () => r({ formatVersion: 5 }); }); };
    const pressed = pressedId ? app.el(pressedId) : undefined;
    const run = app.ctx.handleBackupClick(pressed);
    const busyId = pressedId || 'backupBtn';
    const otherId = busyId === 'backupBtn' ? 'settingsBackupBtn' : 'backupBtn';
    assert.strictEqual(app.el(busyId).disabled, true);
    assert.strictEqual(app.el(otherId).disabled, true, 'both disabled');
    assert.strictEqual(app.el(busyId).textContent, 'Backing up…');
    assert.strictEqual(app.el(otherId).textContent, otherId === 'backupBtn' ? '⬇ Backup' : '⬇ Download backup');
    await app.ctx.handleBackupClick(app.el('backupBtn'));
    await app.ctx.handleBackupClick(app.el('settingsBackupBtn'));
    assert.strictEqual(builds, 1, 'a press while busy does nothing');
    resolve(); await run; await settle();
    assert.strictEqual(app.downloads, 1);
    for (const [id, label] of [['backupBtn', '⬇ Backup'], ['settingsBackupBtn', '⬇ Download backup']]) {
      assert.strictEqual(app.el(id).disabled, false, `${id} enabled again`);
      assert.strictEqual(app.el(id).textContent, label);
    }
  }
  // A failure: reported as before, both buttons restored.
  const app = await boot();
  app.ctx.openSettings(null);
  app.ctx.buildBackupObject = async () => { throw new Error('boom'); };
  await app.ctx.handleBackupClick(app.el('settingsBackupBtn')); await settle();
  assert.match(app.el('errorBanner').innerHTML, /Backup failed: boom/);
  assert.strictEqual(app.downloads, 0);
  assert.deepStrictEqual([app.el('backupBtn').disabled, app.el('settingsBackupBtn').disabled], [false, false]);
});

test('N13 the backup status is the same text and colour in the header link and on Settings, updated after a backup; no request', async () => {
  const day = 24 * 60 * 60 * 1000;
  for (const [stored, text, cls] of [
    [null, 'No backup yet', 'warn'],
    [0, 'Backed up today', ''],
    [13, 'Backup: 13d ago', ''],
    [20, 'Backup: 20d ago', 'warn'],
    [40, 'Backup recommended (40d ago)', 'urgent']
  ]) {
    const storage = memStore(stored == null ? {} : { watchlist_last_backup_at: new Date(Date.now() - stored * day - 60 * 60 * 1000).toISOString() });
    const app = await boot({ storage });
    app.ctx.openSettings(null);
    const before = app.requests.length;
    app.ctx.updateBackupAgeIndicator();
    assert.strictEqual(app.requests.length, before, 'no request');
    assert.strictEqual(app.el('backupAgeIndicator').textContent, text);
    assert.strictEqual(app.el('backupAgeIndicator').className, cls ? `backup-age ${cls}` : 'backup-age');
    assert.ok(screen(app).includes(`class="settings-status${cls ? ' ' + cls : ''}" id="settingsBackupStatus">${text}</p>`), `Settings: ${text}`);
    assert.strictEqual(app.el('settingsBackupStatus').textContent, text, 'updated in place on Settings');
    assert.strictEqual(app.el('settingsBackupStatus').className, cls ? `settings-status ${cls}` : 'settings-status');
  }
  const storage = memStore();
  const app = await boot({ storage });
  app.ctx.openSettings(null);
  await app.ctx.handleBackupClick(app.el('settingsBackupBtn')); await settle();
  assert.ok(storage.data.watchlist_last_backup_at, 'recorded');
  assert.strictEqual(app.el('backupAgeIndicator').textContent, 'Backed up today');
  assert.strictEqual(app.el('settingsBackupStatus').textContent, 'Backed up today');
  assert.strictEqual(app.el('settingsBackupStatus').className, 'settings-status');
});

// ─── N14, N15: where Restore and the management controls are ───────────────────
test('N14 Restore is offered only on Settings: no Restore control in the header, the Browse row or any view', async () => {
  const app = await boot();
  assert.strictEqual(app.el('restoreBtn'), null, 'no header Restore');
  const html = () => ['mediaSwitch', 'settingsEntry', 'tabBar', 'browseBar', 'viewHead', 'filtersRow', 'tbody', 'cardList'].map(id => app.el(id).innerHTML).join('');
  for (const v of VIEWS.filter(x => x[0] !== 'settings')) {
    await goTo(app, v);
    assert.ok(!html().includes('handleRestoreClick'), `${v[0]}: no Restore control`);
  }
  app.ctx.openSettings(null);
  assert.ok(screen(app).includes('handleRestoreClick()'), 'on Settings');
});

test('N15 (S2) no Browse row in the library; the Collections chooser keeps Retry and "may be out of date", without Manage or Catalog updates; the header keeps Backup and the status link', async () => {
  const app = await boot();
  const bar = () => app.el('browseBar').innerHTML;
  assert.strictEqual(bar(), '', 'S2: no Browse row in the library');
  app.ctx.openCollections(null); await settle();
  assert.ok(bar().includes('role="tablist"') && !bar().includes('browseSelect'), 'the chooser, not a select');
  assert.ok(!/openManage\(|openCatalogChooser\(/.test(bar()), 'no Manage or Catalog updates in the chooser');
  app.run('orgCollectionsStale = 99; buildBrowseBar()');
  assert.ok(/Collections may be out of date[\s\S]*retryOrgRefresh\(\)/.test(bar()));
  app.run("orgState = 'unavailable'; buildBrowseBar()");
  assert.ok(bar().includes('onclick="loadOrganization()">Retry'));
  assert.ok(!/openManage\(|openCatalogChooser\(/.test(bar()));
  app.ctx.switchMediaType('movie'); await settle();
  assert.ok(!app.el('filtersRow').innerHTML.includes('openManage('), 'All Movies: no in-context Manage link, as at the baseline (none exists there)');
  // The header: Backup kept (O5), the status link opens Settings at Backup & Restore (D8).
  const page = require('fs').readFileSync(require('path').join(__dirname, '..', 'watchlist.html'), 'utf8');
  assert.ok(page.includes('<button class="btn" id="backupBtn" onclick="handleBackupClick(this)">⬇ Backup</button>'));
  assert.ok(page.includes(`<button class="backup-age" id="backupAgeIndicator" title="Open Backup &amp; Restore in Settings" onclick="openSettings(this, 'backup')"></button>`));
  assert.ok(!page.includes('id="restoreBtn"'));
  app.ctx.openSettings(app.el('backupAgeIndicator'), 'backup');
  assert.strictEqual(app.get('activeViewId'), 'settings');
});

// ─── S1 review corrections ───────────────────────────────────────────────────────
// N5b (finding 2): the Settings round trip keeps the origin's TV seasons choice (All TV and
// collections) and a collection's media, with the effective filtering; a fresh entry still resets them.
test('N5b Back to library keeps All TV\'s TV seasons choice and a collection\'s media and TV seasons choice, with the same listing; a fresh entry still resets them', async () => {
  const storage = memStore();
  const app = await boot({ storage });
  const andorS1 = 'Andor</span>';
  // All TV, Seasons, TV seasons "To watch": Andor S1 (watched) is not listed.
  app.ctx.switchView('alltv'); await settle();
  app.ctx.setAllTvPresentation('seasons'); await settle();
  assert.ok(app.el('tbody').innerHTML.includes('Season 1'), 'listed under the default');
  app.ctx.setAllTvSeasonVis('towatch'); await settle();
  assert.ok(!app.el('tbody').innerHTML.includes('Season 1'), 'not listed under To watch');
  app.el('fSearch').value = 'and';
  app.ctx.openSettings(null);
  app.ctx.settingsBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'alltv');
  assert.strictEqual(app.get('allTvSeasonVis'), 'towatch', 'the TV seasons choice is kept');
  assert.strictEqual(app.el('fSeasonVis').value, 'towatch', 'its control shows it');
  assert.strictEqual(app.el('fSearch').value, 'and', 'an ordinary filter too');
  assert.ok(!app.el('tbody').innerHTML.includes('Season 1'), 'and the listing is filtered by it');
  // A fresh entry to All TV still starts from All (except Skipped).
  app.ctx.switchView('watching'); await settle();
  app.ctx.switchView('alltv'); await settle();
  assert.strictEqual(app.get('allTvSeasonVis'), 'notskipped', 'fresh entry unchanged');
  // A collection with a show and a film: media Movies only.
  const col = firstCollection(app);
  app.store.collection_memberships.push({ id: '0d000000-0000-4000-8000-000000000099', collection_id: col.replace('browse:', ''), show_id: null,
    item_id: '00000000-0000-4000-8000-000000000003', created_at: '2026-10-06T00:00:00+00:00' });
  app.ctx.openBrowseCollection(col); await settle();
  assert.ok(app.el('tbody').innerHTML.includes(andorS1) && app.el('tbody').innerHTML.includes('Dune'), 'both listed under All media');
  app.ctx.setBrowseMedia('movie'); await settle();
  assert.ok(!app.el('tbody').innerHTML.includes(andorS1) && app.el('tbody').innerHTML.includes('Dune'), 'Movies only');
  app.ctx.openSettings(null);
  app.ctx.settingsBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), col);
  assert.strictEqual(app.get('browseMedia'), 'movie', 'the media choice is kept');
  assert.ok(app.el('filtersRow').innerHTML.includes('data-media="movie" aria-pressed="true"'), 'its control shows it');
  assert.ok(app.el('viewHead').innerHTML.includes('— Movies</h2>'), 'the heading says it');
  assert.ok(!app.el('tbody').innerHTML.includes(andorS1) && app.el('tbody').innerHTML.includes('Dune'), 'and the listing is filtered by it');
  assert.strictEqual(app.get('browseOrigin.viewId'), 'alltv', 'the collection\'s own Back origin is kept');
  // The collection in Seasons with TV seasons "To watch" (TV only).
  app.ctx.setBrowseMedia('tv'); await settle();
  app.ctx.setBrowsePresentation('seasons'); await settle();
  app.ctx.setBrowseSeasonVis('towatch'); await settle();
  assert.ok(!app.el('tbody').innerHTML.includes('Season 1'));
  app.ctx.openSettings(null);
  app.ctx.settingsBack(); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.get('[browseMedia, browsePresentation, browseSeasonVis]'))), ['tv', 'seasons', 'towatch']);
  assert.ok(app.el('filtersRow').innerHTML.includes('<option value="towatch" selected>TV seasons: To watch'), 'its control shows it');
  assert.ok(!app.el('tbody').innerHTML.includes('Season 1'), 'and the listing is filtered by it');
  // A fresh entry to the collection still resets media and TV seasons.
  app.ctx.switchView('watching'); await settle();
  app.ctx.openBrowseCollection(col); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.get('[browseMedia, browseSeasonVis]'))), ['all', 'notskipped'], 'fresh entry unchanged');
});

// N16 (finding 1): the final phase read before sending. A navigation, or a newer restore being
// prepared, while it is pending: the old continuation returns with no dialog, download or write.
async function preparedOnSettings(app) {
  const { text } = await backupFile(app);
  app.ctx.switchView('alltv'); await settle();
  app.ctx.openSettings(null);
  await app.ctx.handleRestoreFileSelected({ target: { files: [{ text: async () => text }], value: 'x' } }); await settle();
  await app.ctx.executeRestore(); await settle();
  assert.ok(app.el('restoreModalBox').innerHTML.includes('continueRestoreAfterSafetyConfirm'), 'at the safety confirmation');
  return text;
}
const capHold = app => app.hold(r => r.url.endsWith('/rpc/stage5_capabilities'));
for (const outcome of ['success', 'failure']) {
  test(`N16a navigation while the final phase read is pending (${outcome}): no dialog, download or write; the view is left alone`, async () => {
    for (const [navName, nav] of NAVS) {
      const app = await boot();
      await preparedOnSettings(app);
      const downloads = app.downloads;
      const g = capHold(app);
      const cont = app.ctx.continueRestoreAfterSafetyConfirm('safety.json');
      await g.reached;
      nav(app); await settle();
      const view = app.get('activeViewId');
      if (outcome === 'success') g.release(); else g.fail();
      await cont; await settle();
      assert.ok(!modalOpen(app), `${navName}: no dialog`);
      assert.strictEqual(app.el('restoreModalBox').innerHTML, '', `${navName}: nothing drawn in the restore dialog`);
      assert.strictEqual(app.downloads, downloads, `${navName}: no download`);
      assert.deepStrictEqual(restoreWrites(app), [], `${navName}: no write`);
      assert.strictEqual(app.get('activeViewId'), view, `${navName}: the view is left alone`);
      assert.strictEqual(app.get('restoreInFlight'), false);
    }
  });
  test(`N16b a newer restore prepared while the old final phase read is pending (${outcome}): the old continuation leaves the newer one alone`, async () => {
    const app = await boot();
    const text = await preparedOnSettings(app);
    app.run('__old = pendingRestoreData');
    const g = capHold(app);
    const cont = app.ctx.continueRestoreAfterSafetyConfirm('safety.json');
    await g.reached;
    // A newer preparation on Settings (a new file chosen): its preview opens.
    await app.ctx.handleRestoreFileSelected({ target: { files: [{ text: async () => text }], value: 'x' } }); await settle();
    const newer = app.el('restoreModalBox').innerHTML;
    assert.ok(newer.includes('executeRestore()'), 'the newer preparation is at its preview');
    assert.strictEqual(app.get('pendingRestoreData === __old'), false);
    const downloads = app.downloads;
    if (outcome === 'success') g.release(); else g.fail();
    await cont; await settle();
    assert.strictEqual(app.el('restoreModalBox').innerHTML, newer, 'the newer preparation\'s dialog is untouched');
    assert.ok(modalOpen(app));
    assert.ok(app.get('pendingRestoreData') && app.get('pendingRestoreData !== __old'), 'the newer preparation is still pending');
    assert.strictEqual(app.downloads, downloads, 'no download');
    assert.deepStrictEqual(restoreWrites(app), [], 'nothing sent: neither the old nor the newer backup');
    // The newer preparation still completes normally.
    await app.ctx.executeRestore(); await settle();
    await app.ctx.continueRestoreAfterSafetyConfirm('safety2.json'); await settle();
    assert.strictEqual(app.requests.filter(r => r.url.endsWith('/rpc/restore_backup')).length, 1, 'the newer restore is sent once');
    assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  });
}
test('N16c control: with no navigation the held final phase read releases into the send, and the submitted restore verifies as before', async () => {
  const app = await boot();
  await preparedOnSettings(app);
  const g = capHold(app);
  const cont = app.ctx.continueRestoreAfterSafetyConfirm('safety.json');
  await g.reached;
  g.release(); await cont; await settle();
  assert.strictEqual(app.requests.filter(r => r.url.endsWith('/rpc/restore_backup')).length, 1);
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
});

// N17 (finding 3): Settings' watch-with state follows the existing read as it completes or
// fails: the text is updated in place (no redraw, no request of its own).
for (const outcome of ['success', 'failure']) {
  test(`N17 a delayed watch-with read (${outcome}) updates Settings in place, also when collections finish first; no request of its own`, async () => {
    const app = await boot();
    app.run("watchWithChoices = null; watchWithState = 'loading'; orgChoicesSeq = 0");
    app.ctx.openSettings(null);
    assert.ok(screen(app).includes('id="settingsChoicesText">Loading…</p>'));
    const drawn = screen(app);
    const g = app.hold(r => r.url.includes('/watch_with_choices?'));
    const before = app.requests.length;
    const loading = app.ctx.loadOrganization();
    await g.reached; await settle();
    // Collections finished first: their count is shown; watch-with still loading.
    const c = app.get('personalCollections');
    assert.strictEqual(app.el('settingsCollectionsText').textContent, `${c.filter(x => !x.archived_at).length} active · ${c.filter(x => x.archived_at).length} archived`);
    assert.strictEqual(app.el('settingsChoicesText').textContent, 'Loading…', 'still loading while the read is pending');
    if (outcome === 'success') g.release(); else g.fail();
    await loading; await settle();
    const expected = outcome === 'success' ? `${app.get('watchWithChoices').filter(x => !x.archived_at).length} active` : 'Couldn’t be read.';
    assert.strictEqual(app.el('settingsChoicesText').textContent, expected, 'updated in place');
    assert.strictEqual(screen(app), drawn, 'Settings was not redrawn (controls and focus kept)');
    const reads = app.requests.slice(before).map(r => r.url.split('/rest/v1/')[1].split('?')[0]);
    assert.strictEqual(reads.filter(t => t === 'watch_with_choices').length, 1, 'only the existing read: ' + reads.join(', '));
    assert.ok(reads.every(t => ['personal_collections', 'library_collection_catalogs', 'library_collection_presentation', 'watch_with_choices'].includes(t)));
  });
}
test('N17b a stale watch-with read never changes Settings: a read that overlapped a restore publishes nothing; a fresh read follows', async () => {
  const app = await boot();
  app.ctx.openSettings(null);
  const shown = app.el('settingsChoicesText').textContent || screen(app).match(/id="settingsChoicesText">([^<]*)</)[1];
  const g = app.hold(r => r.url.includes('/watch_with_choices?'));
  const old = app.ctx.loadOrganization();
  await g.reached;
  const oldSeq = app.get('orgReadSeq');
  app.run('writeSent(); writeSettled()'); // the restore request was sent and answered (api.js sbFetch)
  app.ctx.invalidateOrganization(); // a restore: everything read before it is stale
  assert.strictEqual(app.el('settingsChoicesText').textContent, 'Loading…', 'the restore\'s reset is shown');
  app.store.watch_with_choices.push({ id: '0e000000-0000-4000-8000-000000000099', token: 'Zed', label: 'Zed', sort_order: 99, archived_at: null });
  g.release(); await old;
  assert.strictEqual(app.el('settingsChoicesText').textContent, 'Loading…', 'the pre-restore read did not publish');
  await settle();
  assert.ok(app.get('orgChoicesSeq') > oldSeq, 'what Settings shows comes from a read started after the restore');
  assert.ok(shown);
});

T.run();
