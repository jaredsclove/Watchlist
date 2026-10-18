// Offline tests for S5: adding existing shows and films to the open collection (O4, D14): the picker,
// the batch lifecycle for Add and Undo (one request at a time, Stop, unknown outcomes, exact-id Undo),
// the results notice and the Pull rest follow-up. Whole-page harness (tests/app-harness.js); the model is
// the harness's in-memory one, not the database.
// Run from the repo root: node tests/collection-add.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('collection-add');
const test = (name, fn) => (!process.env.ONLY || name.includes(process.env.ONLY)) && T.test(name, fn);
const copy = v => JSON.parse(JSON.stringify(v));

let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
function show(o, nums) {
  const s = { id: nid('show'), collection: 'truecrime', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 100 + n, status: 'confirmed', ...o };
  const rows = nums.map(num => ({ id: nid('r'), collection: s.collection, title: s.title, theme: 'Net', status: 'pending', watched: false, skipped: false,
    show_id: s.id, media_type: 'tv', tmdb_id: s.tmdb_id, season_number: num, season: `Season ${num}`, display_date: `Jan 1, ${2010 + num}`,
    date_sort: `${2010 + num}-01-01`, item_key: `${s.show_key}|season ${num}`, watch_with: [], collections: [] }));
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'othertv', title: 'Film', theme: 'Doc', status: 'confirmed', watched: false,
  media_type: null, tmdb_id: null, season_number: null, season: 'Film', display_date: 'Jan 1, 2015', date_sort: '2015-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });

// True Crime / Docs holds Alpha and Member Film; Bravo, Charlie (two seasons), Zed (Skipped) and three films are outside it.
function lib() {
  const L = {};
  L.alpha = show({ title: 'Alpha' }, [1]);
  L.bravo = show({ title: 'Bravo', collection: 'othertv' }, [1]);
  L.charlie = show({ title: 'Charlie', collection: 'othertv' }, [1, 2]);
  L.zed = show({ title: 'Zed', collection: 'othertv', status: 'skipped' }, [1]);
  L.member = film({ title: 'Member Film', collection: 'truecrime' });
  L.f1 = film({ title: 'Film One' });
  L.f2 = film({ title: 'Film Two' });
  L.f3 = film({ title: 'Film Three' });
  const shows = ['alpha', 'bravo', 'charlie', 'zed'].map(k => L[k]);
  L.data = { rows: shows.flatMap(x => x.rows).concat([L.member, L.f1, L.f2, L.f3]), shows: shows.map(x => x.show) };
  return L;
}
const boot = (L = lib(), opts = {}) => createApp({ rows: L.data.rows, tvShows: L.data.shows, ...opts });
const TC = app => app.browseId('truecrime');
const CID = app => TC(app).split(':')[1];
async function openTC(app) { app.ctx.openBrowseCollection(TC(app)); await settle(); }
const box = app => app.el('addPickerBox').innerHTML;
const notice = app => app.el('banner').innerHTML;
const writes = app => app.requests.filter(r => r.method !== 'GET');
const rpc = (app, fn) => app.requests.filter(r => r.url.endsWith(`/rpc/${fn}`));
const members = app => app.store.collection_memberships.filter(m => m.collection_id === CID(app));
function snap(app) { const s = {}; for (const t of ['watchlist_items', 'tv_shows', 'collection_memberships']) s[t] = copy(app.store[t]); return s; }
function diff(a, b) {
  const out = {};
  for (const t of Object.keys(a)) {
    const A = new Map(a[t].map(r => [r.id, JSON.stringify(r)])), B = new Map(b[t].map(r => [r.id, JSON.stringify(r)]));
    const added = [...B.keys()].filter(k => !A.has(k)), removed = [...A.keys()].filter(k => !B.has(k)), changed = [...A.keys()].filter(k => B.has(k) && A.get(k) !== B.get(k));
    if (added.length || removed.length || changed.length) out[t] = { added, removed, changed };
  }
  return out;
}
const pick = (app, ...keys) => keys.forEach(k => app.ctx.addPickerToggle(k, true));
const resultsOf = app => JSON.parse(app.get('JSON.stringify((addBatch || {}).items || [])'));
const args = (app, kind, id) => ({ p_collection_id: CID(app), p_show_id: kind === 'show' ? id : null, p_item_id: kind === 'film' ? id : null });

// ═══ Entry and candidates (V5.1, V5.2, V5.3) ══════════════════════════════════
test('V5.1 Add to <C>… is in the heading only for a complete, current, non-archived read; it opens Idle with focus on Search and reads nothing; Cancel returns focus', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  assert.ok(app.el('viewHead').innerHTML.includes('id="collectionAddBtn"') && app.el('viewHead').innerHTML.includes('>Add to True Crime / Docs…</button>'));
  const opener = { id: 'collectionAddBtn', isConnected: true, focus() { app.ctx.document.activeElement = this; } };
  const mark = app.requests.length;
  app.ctx.openAddPicker(opener);
  assert.strictEqual(app.requests.length, mark, 'no request on opening');
  assert.strictEqual(app.el('addPickerOverlay').style.display, 'flex');
  assert.strictEqual(app.ctx.document.activeElement.id, 'addPickerSearch', 'focus on Search');
  app.ctx.closeAddPicker();
  assert.strictEqual(app.get('addPicker'), null);
  assert.strictEqual(app.ctx.document.activeElement, opener, 'focus back on the opener');
  // A read that missed a member, or a list marked out of date: no entry, and the picker refuses to open.
  app.run('listStale = true'); app.ctx.renderTable(); app.ctx.renderFilters();
  assert.ok(!app.el('viewHead').innerHTML.includes('collectionAddBtn'));
  app.ctx.openAddPicker(null);
  assert.strictEqual(app.get('addPicker'), null);
  app.run('listStale = false');
  app.store.collection_memberships.push({ id: 'zz-dangling', collection_id: CID(app), show_id: 'no-such-show', item_id: null, created_at: '2026-01-01T00:00:00Z' });
  await app.ctx.loadBrowseView(); await settle();
  assert.ok(!app.el('viewHead').innerHTML.includes('collectionAddBtn'), 'an incomplete read has no Add');
  assert.deepStrictEqual(writes(app), []);
});
test('V5.2 candidates: every saved show and film A–Z; members “Already in” without a checkbox; Skipped noted; a show says its stored seasons; an unclassified row is counted, not offered', async () => {
  const L = lib();
  const app = await boot(L);
  // A row that is neither a linked TV season nor a film (added after boot: the harness links show-less TV rows at boot).
  app.store.watchlist_items.push({ ...film({ title: 'Odd Row' }), season: 'Season X', media_type: 'tv', show_id: null });
  await openTC(app);
  app.ctx.openAddPicker(null);
  const h = box(app);
  const names = [...h.matchAll(/<span class="manage-name">([^<]*)</g)].map(m => m[1]);
  assert.deepStrictEqual(names, ['Alpha', 'Bravo', 'Charlie', 'Film One', 'Film Three', 'Film Two', 'Member Film', 'Zed']);
  const li = name => h.split('<li').find(x => x.includes(`>${name}<`));
  assert.ok(li('Alpha').includes('Already in True Crime / Docs') && !li('Alpha').includes('checkbox'), 'a member show: no checkbox');
  assert.ok(li('Member Film').includes('Already in') && !li('Member Film').includes('checkbox'));
  assert.ok(li('Charlie').includes('TV show · 2 stored seasons') && li('Charlie').includes('type="checkbox"'));
  assert.ok(li('Zed').includes('(hidden by default here)'));
  assert.ok(li('Film One').includes('Film · To Watch'));
  assert.ok(h.includes('1 saved row is neither a TV season nor a film, so it isn’t offered.'));
  assert.ok(/id="addPickerSubmit"[^>]*disabled/.test(h), 'Add disabled with nothing selected');
  app.ctx.addPickerSearch({ value: 'film t' });
  assert.deepStrictEqual([...box(app).matchAll(/<span class="manage-name">([^<]*)</g)].map(m => m[1]), ['Film Three', 'Film Two']);
});
test('V5.3 Idle: choosing, Cancel and Escape send nothing', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.openAddPicker(null);
  pick(app, `i:${L.f1.id}`, `s:${L.bravo.show.id}`);
  assert.ok(box(app).includes('>Add 2 to True Crime / Docs</button>'));
  app.ctx.addPickerKeydown({ key: 'Escape', preventDefault() {} });
  assert.strictEqual(app.get('addPicker'), null);
  app.ctx.openAddPicker(null); pick(app, `i:${L.f1.id}`); app.ctx.closeAddPicker();
  await settle();
  assert.deepStrictEqual(writes(app), []);
});

// ═══ The batch (V5.4–V5.6; F25) ════════════════════════════════════════════════
test('F25 a completed batch: the capability check, then one org_add_membership per item in listed order with exact arguments; one membership each; read again; results, then the notice', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.openAddPicker(null);
  pick(app, `i:${L.f2.id}`, `s:${L.charlie.show.id}`, `i:${L.f1.id}`);
  const before = snap(app), mark = app.requests.length;
  await app.ctx.submitAddPicker(); await settle();
  const sent = app.requests.slice(mark);
  assert.ok(sent.findIndex(r => r.url.endsWith('/rpc/org_capabilities')) < sent.findIndex(r => r.url.endsWith('/rpc/org_add_membership')));
  assert.deepStrictEqual(writes(app).map(r => r.body), [args(app, 'show', L.charlie.show.id), args(app, 'film', L.f1.id), args(app, 'film', L.f2.id)], 'A–Z order');
  const d = diff(before, snap(app));
  assert.deepStrictEqual([Object.keys(d), d.collection_memberships.added.length], [['collection_memberships'], 3], 'memberships only');
  assert.ok(sent.some(r => r.method === 'GET' && r.url.includes('/collection_memberships')), 'read again');
  assert.deepStrictEqual(resultsOf(app).map(i => i.state), ['added', 'added', 'added']);
  assert.ok(box(app).includes('Add to True Crime / Docs: 3 added.') && box(app).includes('Undo 3 confirmed additions'));
  assert.ok(app.el('tbody').innerHTML.includes('>Film One<'), 'listed in the collection now');
  app.ctx.closeAddPicker();
  assert.ok(notice(app).includes('Add to True Crime / Docs: 3 added.') && notice(app).includes('Show details') && notice(app).includes('undoAddBatch()'));
  app.ctx.toggleAddDetails();
  assert.ok(notice(app).includes('>Charlie<') && notice(app).includes('Added'));
  assert.strictEqual(app.get('writeLane'), null);
});
test('V5.4 one request at a time; the selection is locked; Stop after this one: the request out finishes, nothing further is sent, the rest Not sent; the dialog stays until it answers', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.openAddPicker(null);
  pick(app, `i:${L.f1.id}`, `i:${L.f2.id}`, `i:${L.f3.id}`);
  const g = app.hold(r => r.url.endsWith('/rpc/org_add_membership'));
  const p = app.ctx.submitAddPicker();
  await g.reached;
  assert.strictEqual(rpc(app, 'org_add_membership').length, 1, 'one in flight');
  assert.ok(box(app).includes('Adding 1 of 3… The selection is locked.') && !box(app).includes('type="checkbox"'));
  app.ctx.addPickerToggle(`i:${L.f3.id}`, false);
  assert.strictEqual(app.get('addPicker.batch.items.length'), 3, 'locked');
  app.ctx.addPickerKeydown({ key: 'Escape', preventDefault() {} }); // Escape = Stop after this one
  assert.ok(app.get('addPicker') && box(app).includes('Stopping after this one'), 'the dialog stays');
  g.release(); await p; await settle();
  assert.strictEqual(rpc(app, 'org_add_membership').length, 1, 'nothing sent after Stop');
  assert.deepStrictEqual(resultsOf(app).map(i => i.state), ['added', 'notsent', 'notsent']);
  assert.ok(box(app).includes('1 added, 2 not sent'));
  assert.strictEqual(members(app).filter(m => [L.f1.id, L.f2.id, L.f3.id].includes(m.item_id)).length, 1);
  app.ctx.closeAddPicker();
  assert.strictEqual(app.get('addPicker'), null, 'closes once answered');
});
test('V5.5 a refusal is reported and the batch goes on; Already in is reported and never undoable', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.openAddPicker(null);
  pick(app, `i:${L.f1.id}`, `i:${L.f2.id}`, `i:${L.f3.id}`);
  app.refuseNext(r => r.url.endsWith('/rpc/org_add_membership') && r.body.p_item_id === L.f1.id, 'P0001', 'org_target_missing: that show or film is no longer saved. Nothing was changed.');
  app.store.collection_memberships.push({ id: 'pre-existing', collection_id: CID(app), show_id: null, item_id: L.f3.id, created_at: '2026-01-01T00:00:00Z' }); // added elsewhere meanwhile
  await app.ctx.submitAddPicker(); await settle();
  assert.strictEqual(rpc(app, 'org_add_membership').length, 3);
  const r = resultsOf(app);
  assert.deepStrictEqual(r.map(i => i.state), ['refused', 'already', 'added']);
  assert.ok(box(app).includes('Couldn’t add: This is no longer saved.') && box(app).includes('Already in True Crime / Docs'));
  assert.ok(box(app).includes('Undo 1 confirmed addition<'), 'only the Added item');
});
for (const mode of ['before', 'after']) {
  test(`V5.5 an unknown outcome (answer lost ${mode} commit): that item Not confirmed, the rest Not sent, read again, never resent; the reread is not called an addition; the table matches the mode`, async () => {
    const L = lib();
    const app = await boot(L);
    await openTC(app);
    app.ctx.openAddPicker(null);
    pick(app, `i:${L.f1.id}`, `i:${L.f2.id}`, `i:${L.f3.id}`);
    app.loseNext(r => r.url.endsWith('/rpc/org_add_membership') && r.body.p_item_id === L.f3.id, mode); // the second, A–Z
    const before = snap(app);
    await app.ctx.submitAddPicker(); await settle();
    assert.strictEqual(rpc(app, 'org_add_membership').length, 2, 'stopped; nothing resent');
    assert.deepStrictEqual(resultsOf(app).map(i => i.state), ['added', 'unconfirmed', 'notsent']);
    const d = diff(before, snap(app));
    assert.strictEqual(d.collection_memberships.added.length, mode === 'after' ? 2 : 1, 'at most one row for the Not-confirmed item');
    const text = `Not confirmed: no clear answer came back, so this may or may not have been added. The list has been read again. It now shows Film Three as ${mode === 'after' ? 'in' : 'not in'} True Crime / Docs, but that doesn’t show whether this request added it. Nothing was sent again.`;
    assert.ok(box(app).includes(text), box(app));
    assert.ok(box(app).includes('1 added, 1 not confirmed, 1 not sent') && box(app).includes('Undo 1 confirmed addition<'), 'Undo only for the confirmed one');
  });
}

// ═══ Undo (V5.7; F26) ══════════════════════════════════════════════════════════
test('V5.7 Undo removes exactly the Added items by their returned membership ids, once; never an Already-in or Not-confirmed item', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.openAddPicker(null);
  pick(app, `i:${L.f1.id}`, `i:${L.f2.id}`, `s:${L.bravo.show.id}`, `i:${L.f3.id}`);
  app.store.collection_memberships.push({ id: 'pre-existing', collection_id: CID(app), show_id: null, item_id: L.f2.id, created_at: '2026-01-01T00:00:00Z' });
  app.loseNext(r => r.url.endsWith('/rpc/org_add_membership') && r.body.p_item_id === L.f3.id, 'after');
  await app.ctx.submitAddPicker(); await settle();
  const added = resultsOf(app).filter(i => i.state === 'added');
  assert.deepStrictEqual(added.map(i => i.title), ['Bravo', 'Film One']);
  const before = snap(app), mark = app.requests.length;
  await app.ctx.undoAddBatch(); await settle();
  const undo = app.requests.slice(mark).filter(r => r.method !== 'GET');
  assert.deepStrictEqual(undo.map(r => r.body), added.map(i => ({ p_membership_id: i.membershipId, p_collection_id: CID(app),
    p_show_id: i.kind === 'show' ? i.id : null, p_item_id: i.kind === 'film' ? i.id : null })), 'exact returned ids, nothing else');
  const d = diff(before, snap(app));
  assert.deepStrictEqual(d.collection_memberships.removed.sort(), added.map(i => i.membershipId).sort());
  assert.ok(members(app).some(m => m.id === 'pre-existing'), 'the Already-in membership is untouched');
  assert.ok(members(app).some(m => m.item_id === L.f3.id), 'the Not-confirmed one is untouched even though the reread shows it');
  assert.ok(box(app).includes('Undo adding to True Crime / Docs: 2 removed.') && !box(app).includes('undoAddBatch()'));
  const after = app.requests.length;
  await app.ctx.undoAddBatch(); await settle();
  assert.strictEqual(app.requests.length, after, 'at most once');
});
test('V5.7 an Undo whose answer is lost stops, is never resent and isn’t offered again; “removed: false” uses Manage’s words', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.openAddPicker(null);
  pick(app, `i:${L.f1.id}`, `i:${L.f2.id}`, `i:${L.f3.id}`);
  await app.ctx.submitAddPicker(); await settle();
  const r = resultsOf(app);
  app.store.collection_memberships = app.store.collection_memberships.filter(m => m.id !== r[0].membershipId); // removed elsewhere
  app.loseNext(x => x.url.endsWith('/rpc/org_remove_membership') && x.body.p_item_id === r[1].id, 'before');
  await app.ctx.undoAddBatch(); await settle();
  assert.strictEqual(rpc(app, 'org_remove_membership').length, 2, 'the third is not sent');
  const u = JSON.parse(app.get('JSON.stringify(addBatch.items.map(i => i.state))'));
  assert.deepStrictEqual(u, ['notremoved', 'unconfirmed', 'notsent']);
  assert.ok(box(app).includes('Not removed: already removed or changed elsewhere'));
  assert.ok(box(app).includes('Undo 1 confirmed addition<'), 'only the never-sent one is still offered');
  await app.ctx.undoAddBatch(); await settle();
  assert.deepStrictEqual(rpc(app, 'org_remove_membership').map(x => x.body.p_item_id), [r[0].id, r[1].id, r[2].id], 'each sent at most once');
});
test('V5.7 Undo is withdrawn when you leave the collection or after a restore', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.openAddPicker(null); pick(app, `i:${L.f1.id}`);
  await app.ctx.submitAddPicker(); await settle();
  app.ctx.closeAddPicker();
  app.ctx.switchView('alltv'); await settle();
  await openTC(app);
  const mark = app.requests.length;
  await app.ctx.undoAddBatch(); await settle();
  assert.ok(app.requests.slice(mark).every(r => r.method === 'GET') && !notice(app).includes('undoAddBatch'), 'left');
  app.ctx.openAddPicker(null); pick(app, `i:${L.f2.id}`);
  await app.ctx.submitAddPicker(); await settle();
  app.ctx.closeAddPicker();
  app.run('invalidateOrganization()');
  const mark2 = app.requests.length;
  await app.ctx.undoAddBatch(); await settle();
  assert.ok(app.requests.slice(mark2).every(r => r.method === 'GET'), 'restored');
});

// ═══ View and epoch checks (V5.8, V6.7-style navigation) ═══════════════════════
test('V5.8 navigating away mid-batch: Stop after this one; its answer is recorded, not published; the view you went to says so; nothing further is sent', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.openAddPicker(null);
  pick(app, `i:${L.f1.id}`, `i:${L.f2.id}`);
  const g = app.hold(r => r.url.endsWith('/rpc/org_add_membership'));
  const p = app.ctx.submitAddPicker();
  await g.reached;
  app.ctx.switchView('alltv'); await settle();
  assert.strictEqual(app.get('addPicker'), null, 'the dialog closes with the navigation');
  g.release(); await p; await settle();
  assert.strictEqual(rpc(app, 'org_add_membership').length, 1);
  assert.ok(notice(app).includes('Adding to True Crime / Docs stopped when you left: 1 added, 1 not sent. Open True Crime / Docs to check.'), notice(app));
  assert.ok(!notice(app).includes('undoAddBatch'), 'no Undo there');
  assert.strictEqual(app.get('activeViewId'), 'alltv');
});
test('V5.8 a restore mid-batch stops it: the rest Not sent; nothing published', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.openAddPicker(null);
  pick(app, `i:${L.f1.id}`, `i:${L.f2.id}`);
  const g = app.hold(r => r.url.endsWith('/rpc/org_add_membership'));
  const p = app.ctx.submitAddPicker();
  await g.reached;
  app.run('invalidateOrganization()');
  g.release(); await p; await settle();
  assert.strictEqual(rpc(app, 'org_add_membership').length, 1);
  assert.deepStrictEqual(resultsOf(app).map(i => [i.state, i.after || null]), [['added', 'restore'], ['notsent', null]]);
  assert.ok(notice(app).includes('your data was restored meanwhile'), notice(app));
});
test('V5.4 Stop waiting: the item becomes Not confirmed, the batch stops, the lane is held until the request settles; a late answer is only recorded', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.openAddPicker(null);
  pick(app, `i:${L.f1.id}`, `i:${L.f2.id}`);
  const g = app.hold(r => r.url.endsWith('/rpc/org_add_membership'));
  const p = app.ctx.submitAddPicker();
  await g.reached;
  app.ctx.addStopWaiting(); await settle();
  assert.deepStrictEqual(resultsOf(app).map(i => i.state), ['unconfirmed', 'notsent']);
  assert.ok(app.get('writeLane') !== null, 'the lane stays held while the request is out');
  assert.ok(box(app).includes('Close'), 'the result can be closed');
  g.release(); await p; await settle();
  assert.strictEqual(app.get('writeLane'), null);
  assert.strictEqual(rpc(app, 'org_add_membership').length, 1);
  assert.ok(box(app).includes('answered later: Added') && !box(app).includes('undoAddBatch()'), 'recorded; still not undoable');
});
test('the batch is one change: refused while another change is saved (nothing sent, the selection kept); a Remove refuses while a batch runs', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  const g = app.hold(r => r.url.endsWith('/rpc/library_set_film_state_b45'));
  const pending = app.ctx.setFilmPriority(L.member.id, 'high');
  await g.reached;
  app.ctx.openAddPicker(null); pick(app, `i:${L.f1.id}`);
  await app.ctx.submitAddPicker(); await settle();
  assert.ok(!rpc(app, 'org_add_membership').length && app.get('addPicker.batch') === null && app.get('addPicker.selected.size') === 1);
  g.release(); await pending; await settle();
  const g2 = app.hold(r => r.url.endsWith('/rpc/org_add_membership'));
  const p = app.ctx.submitAddPicker();
  await g2.reached;
  await app.ctx.removeFromCollection('film', L.member.id, null); await settle();
  assert.ok(!rpc(app, 'org_remove_membership').length, 'refused by the lane');
  g2.release(); await p; await settle();
});

// ═══ Pull rest follow-up (V5.9; F26) ═══════════════════════════════════════════
test('V5.9 Pull rest in a collection offers “Add these films to <C>…”: the picker opens Idle with exactly those films selected; nothing is added until Add', async () => {
  const L = lib();
  const saga = film({ title: 'Saga One', collection: 'movies', media_type: 'movie', tmdb_id: 501, theme: 'Action', tmdb_collection_id: 900, tmdb_collection_name: 'Saga Collection', collections: ['Saga Collection'], item_key: 'saga one|film' });
  L.data.rows.push(saga);
  const tmdb = p => {
    if (p.startsWith('/collection/900')) return { id: 900, name: 'Saga Collection', parts: [{ id: 501, title: 'Saga One', release_date: '2001-01-01' }, { id: 502, title: 'Saga Two', release_date: '2003-01-01' }, { id: 503, title: 'Saga Three', release_date: '2005-01-01' }] };
    const m = p.match(/^\/movie\/(50[23])/);
    if (m) return { id: Number(m[1]), title: m[1] === '502' ? 'Saga Two' : 'Saga Three', release_date: '2003-01-01', genres: [{ id: 28, name: 'Action' }], production_companies: [] };
    return undefined;
  };
  const app = await boot(L, { tmdb });
  app.store.collection_memberships.push({ id: 'saga-m', collection_id: CID(app), show_id: null, item_id: saga.id, created_at: '2026-01-01T00:00:00Z' });
  await openTC(app);
  await app.ctx.libraryPullRest(saga.id, 900, 'Saga'); await settle(); await settle();
  app.addEl('tmdbPreview');
  app.ctx.document.querySelectorAll = sel => sel.includes('data-movie-id') ? [{ checked: true, disabled: false, dataset: { movieId: '502' } }, { checked: true, disabled: false, dataset: { movieId: '503' } }] : [];
  const m0 = members(app).length;
  await app.ctx.addPulledCollectionMovies(); await settle(); await settle();
  const outcome = app.el('libraryOutcome').innerHTML;
  assert.ok(outcome.includes('openAddPickerForPulled(this)') && outcome.includes('Add these 2 films to True Crime / Docs…'), outcome);
  assert.strictEqual(members(app).length, m0, 'F19: no membership yet');
  app.ctx.openAddPickerForPulled(null);
  const inserted = app.store.watchlist_items.filter(r => /^Saga (Two|Three)$/.test(r.title)).map(r => `i:${r.id}`).sort();
  assert.deepStrictEqual(JSON.parse(app.get('JSON.stringify([...addPicker.selected].sort())')), inserted, 'exactly the inserted films');
  assert.strictEqual(app.get('addPicker.batch'), null, 'Idle');
  assert.ok(!rpc(app, 'org_add_membership').length, 'nothing added until Add');
  await app.ctx.submitAddPicker(); await settle();
  assert.strictEqual(rpc(app, 'org_add_membership').length, 2);
});

T.run();
