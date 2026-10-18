// Offline tests for simplification Batch A (write-lane.js) in the whole-page harness: one change
// at a time per page, held through the reread that reconciles it; reads that overlap a change
// never publish (during or after it) and overlapping reads never publish out of order; a reread
// after a change that fails pauses changes from the list until a read succeeds; an unconfirmed
// change is never resent; a restore waits for the lane; and the one focus rule (focus in the list
// follows the redraw; a filter-row redraw keeps the focused filter control, its value and caret).
// One test per data risk or journey; the flows' own outcomes are covered by their suites.
// Run from the repo root: node tests/write-lane.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');
const { makeMiniDom } = require('./mini-dom');

const T = runner('write-lane');
const test = T.test;

let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
function show(o, specs) {
  const s = { id: nid('show'), collection: 'othertv', title: o.title || 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 100 + n, status: 'watching', ...o };
  const rows = specs.map(sp => {
    const num = sp.num !== undefined ? sp.num : 1;
    const label = `Season ${num}`;
    const date = sp.date || `20${10 + num}-01-01`;
    return { id: sp.id || nid('r'), collection: s.collection, title: s.title, theme: sp.theme || 'HBO', status: 'confirmed', watched: !!sp.w, skipped: false, show_id: s.id,
      media_type: 'tv', tmdb_id: s.tmdb_id, season_number: num, season: label, display_date: date, date_sort: date,
      item_key: `${s.show_key}|${label.toLowerCase()}`, watch_with: [], collections: [] };
  });
  return { show: s, rows };
}
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows), shows: xs.map(x => x.show) });
async function open(view, data) {
  const app = await createApp({ rows: data.rows, tvShows: data.shows });
  app.ctx.switchView(view); await settle();
  if (app.el('fStatus')) { app.el('fStatus').value = 'all'; app.ctx.renderTable(); }
  return app;
}
const fixture = () => {
  const a = show({ title: 'Alpha' }, [{ num: 1, w: true }, { num: 2 }]);
  const b = show({ title: 'Bravo' }, [{ num: 1 }]);
  return { a, b, data: all(a, b) };
};
const banner = app => app.el('errorBanner').innerHTML;
const pageRow = (app, id) => app.get(`derivedData.rows.find(r => r.id === ${JSON.stringify(id)})`);
const storeRow = (app, id) => app.store.watchlist_items.find(r => r.id === id);
const rpc = (app, fn) => app.writes().filter(r => r.url.endsWith(`/rpc/${fn}`));
const isShowsRead = r => r.method === 'GET' && r.url.includes('/tv_shows');

test('one change at a time: a second change while one is saved is refused before anything is shown or sent; the lane is held through the reconciling reread', async () => {
  const { a, b, data } = fixture();
  const app = await open('alltv', data);
  const g = app.hold(r => r.url.endsWith('/rpc/set_season_watched'));
  const p = app.ctx.toggleWatch(a.rows[1].id);
  await g.reached;
  assert.strictEqual(app.get('writeLane.label'), '“Alpha” · watched');
  await app.ctx.setShowStateById(b.show.id, { priority: 'high' });
  assert.deepStrictEqual(rpc(app, 'library_set_show_state_b45'), [], 'nothing sent for the second change');
  assert.match(banner(app), /⚠️ “Alpha” · watched is still being saved\. Nothing else was changed/);
  assert.strictEqual(app.get('tvShowsById').get(b.show.id).priority || 'normal', 'normal', 'nothing shown for it either');
  // An unconfirmed answer: the lane stays held while the list is read again.
  const reread = app.hold(isShowsRead);
  g.lose('after'); await reread.reached;
  assert.ok(app.get('writeLane'), 'held through the reread');
  reread.release(); await p; await settle();
  assert.strictEqual(app.get('writeLane'), null, 'free once the reread is in');
  assert.strictEqual(rpc(app, 'set_season_watched').length, 1, 'never resent');
  assert.match(banner(app), /wasn’t confirmed.*won’t be sent again.*The list has been read again/);
  assert.strictEqual(!!pageRow(app, a.rows[1].id).watched, true, 'the page shows what is stored (lost after commit)');
});

test('an older read never publishes during or after a pending change; the reread after the change shows what is stored', async () => {
  const { a, data } = fixture();
  const app = await open('alltv', data);
  const id = a.rows[1].id;
  const older = app.hold(isShowsRead);
  const pr = app.ctx.loadDerivedView(); // started before the change
  await older.reached;
  const g = app.hold(r => r.url.endsWith('/rpc/set_season_watched'));
  const pw = app.ctx.toggleWatch(id);
  await g.reached;
  older.releaseWith({ watchlist_items: JSON.parse(JSON.stringify(app.store.watchlist_items)) }); await pr; await settle();
  assert.strictEqual(pageRow(app, id).watched, true, 'during: the older read did not replace the optimistic value');
  g.release(); await pw; await settle(); await settle();
  assert.strictEqual(pageRow(app, id).watched, true, 'after: still the saved value');
  assert.strictEqual(storeRow(app, id).watched, true);
  assert.strictEqual(app.get('writeLane'), null);
});

test('overlapping reads never publish out of order: an older view read that finishes last changes nothing', async () => {
  const { a, data } = fixture();
  const app = await open('alltv', data);
  const g1 = app.hold(isShowsRead);
  const p1 = app.ctx.loadDerivedView();
  await g1.reached;
  const before = JSON.parse(JSON.stringify(app.store.watchlist_items));
  storeRow(app, a.rows[1].id).watched = true; // changed elsewhere between the two reads
  await app.ctx.loadDerivedView(); await settle();
  assert.strictEqual(pageRow(app, a.rows[1].id).watched, true, 'the newer read published');
  g1.releaseWith({ watchlist_items: before }); await p1; await settle();
  assert.strictEqual(pageRow(app, a.rows[1].id).watched, true, 'the older read did not replace it');
});

test('a read refused because a change overlapped it reads again once the lane is free; the view left meanwhile gets nothing from the change', async () => {
  const { a, data } = fixture();
  const app = await open('alltv', data);
  const g = app.hold(r => r.url.endsWith('/rpc/set_season_watched'));
  const p = app.ctx.toggleWatch(a.rows[1].id);
  await g.reached;
  app.ctx.switchView('comingsoon'); await settle(); // its first read overlaps the change
  g.release(); await p; await settle(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'comingsoon');
  assert.ok(app.get('derivedData && derivedData.loaded'), 'Coming Soon was read again after the change and is shown');
  assert.ok(!/Loading…/.test(app.el('tbody').innerHTML));
});

test('a reread after a change that fails keeps the list, marked out of date; changes from it are paused (nothing sent) until Retry reads it', async () => {
  const { a, b, data } = fixture();
  const app = await open('alltv', data);
  app.refuseNext(r => r.url.endsWith('/rpc/library_set_show_state_b45'), 'P0001', 'target_changed: This changed since the page showed it, so nothing was changed. Look at it again.');
  app.failNext(isShowsRead);
  await app.ctx.setShowStateById(a.show.id, { priority: 'high' }); await settle();
  assert.match(app.el('readStatus').innerHTML, /couldn’t be read again.*changes from it are paused.*Retry/);
  assert.ok(/Alpha/.test(app.el('tbody').innerHTML), 'the last complete list stays');
  assert.strictEqual(app.get('listStale'), true);
  const sent = app.writes().length;
  await app.ctx.toggleWatch(b.rows[0].id); await settle();
  assert.strictEqual(app.writes().length, sent, 'nothing sent from an out-of-date list');
  assert.match(banner(app), /may be out of date and nothing was changed\. Use Retry/);
  assert.strictEqual(!!pageRow(app, b.rows[0].id).watched, false, 'the control shows what is stored');
  await app.ctx.loadDerivedView(); await settle(); // Retry
  assert.strictEqual(app.get('listStale'), false);
  assert.strictEqual(app.el('readStatus').innerHTML, '');
  await app.ctx.toggleWatch(b.rows[0].id); await settle();
  assert.strictEqual(rpc(app, 'set_season_watched').length, 1, 'changes work again');
});

test('every change goes through the lane: a request sent outside it is refused before anything is sent', async () => {
  const { a, data } = fixture();
  const app = await open('alltv', data);
  const sent = app.writes().length;
  await assert.rejects(app.run(`sbRpc('set_season_watched', { p_row_id: ${JSON.stringify(a.rows[1].id)}, p_watched: true })`), /not started through the write lane/);
  assert.strictEqual(app.writes().length, sent);
});

test('a restore waits for the lane: continuing while a change is saved sends nothing and says why', async () => {
  const { a, data } = fixture();
  const app = await open('alltv', data);
  const g = app.hold(r => r.url.endsWith('/rpc/set_season_watched'));
  const p = app.ctx.toggleWatch(a.rows[1].id);
  await g.reached;
  app.run(`pendingRestoreData = { formatVersion: 5, tables: {} }; restoreEligibleView = () => true;`);
  await app.ctx.continueRestoreAfterSafetyConfirm('safety.json'); await settle();
  assert.deepStrictEqual(app.writes().filter(r => r.url.includes('restore_backup')), []);
  assert.match(app.el('restoreModalBox') ? app.el('restoreModalBox').innerHTML : '', /Restore not sent[\s\S]*is still being saved/);
  g.release(); await p; await settle();
});

// The harness's filter controls get focus, a caret and filter-row membership, as a browser's have.
function filterControls(app, dom) {
  const doc = app.ctx.document, orig = doc.getElementById;
  doc.getElementById = id => {
    const el = orig(id);
    if (el && /^f[A-Z]/.test(id) && !el.focus) {
      el.focus = () => { doc.activeElement = el; dom.docEvent('focusin', el); };
      el.setSelectionRange = (s, e, d) => { el.selectionStart = s; el.selectionEnd = e; el.selectionDirection = d; };
    }
    return el;
  };
  const row = app.el('filtersRow');
  row.contains = n => !!n && !!n.id && orig(n.id) === n && row.innerHTML.includes(`id="${n.id}"`);
  return id => doc.getElementById(id);
}

test('the focus rule: during and after a change\'s reread, focus in Search keeps its value and caret while the filter options update', async () => {
  const { a, data } = fixture();
  const app = await open('alltv', data);
  const dom = makeMiniDom(app);
  dom.hide('cardList');
  const f = filterControls(app, dom);
  app.refuseNext(r => r.url.endsWith('/rpc/library_set_show_state_b45'), 'P0001', 'target_changed: This changed since the page showed it, so nothing was changed. Look at it again.');
  storeRow(app, a.rows[0].id).theme = 'Netflix'; // a new original label, read by the reread
  const reread = app.hold(isShowsRead);
  const p = app.ctx.setShowStateById(a.show.id, { priority: 'high' });
  await reread.reached;
  const search = f('fSearch');
  search.focus(); search.value = 'Al'; search.setSelectionRange(1, 2, 'forward');
  app.ctx.renderTable();
  reread.release(); await p; await settle();
  const now = f('fSearch');
  assert.ok(now !== search, 'the filter row was redrawn');
  assert.strictEqual(app.ctx.document.activeElement, now, 'Search keeps focus');
  assert.deepStrictEqual([now.value, now.selectionStart, now.selectionEnd, now.selectionDirection], ['Al', 1, 2, 'forward']);
  assert.ok(app.el('filtersRow').innerHTML.includes('value="Netflix"'), 'the options are current');
});

test('the focus rule: focus on a list control follows its redraw after a change; focus outside the list is never moved', async () => {
  const { a, b, data } = fixture();
  const app = await open('alltv', data);
  const dom = makeMiniDom(app);
  dom.hide('cardList');
  const sel = `[data-item="${a.show.id}"] [data-action="priority"] select`;
  dom.focus('tbody', sel);
  await app.ctx.setShowStateById(a.show.id, { priority: 'high' }); await settle();
  assert.strictEqual(dom.active(), dom.in('tbody', sel), 'the same control, redrawn');
  const outside = dom.outside();
  await app.ctx.setShowStateById(b.show.id, { priority: 'low' }); await settle();
  assert.strictEqual(dom.active(), outside, 'focus outside the list stays');
});

T.run();
