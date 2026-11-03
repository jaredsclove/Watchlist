// Offline tests for the UI-polish batch (release 2): Show ended moved into Details, saved by Save with the categories
// (two guarded calls in one write lane, not one transaction), with partial and unconfirmed saves reported honestly
// and a retry that never resends saved categories; a film's delete in its ⋯ menu; Settings' Backup & Restore first
// and the password form behind "Change password…". The Episodes list, dialogs and tags are layout only (browser
// checks).
// Run from the repo root: node tests/ui-polish-2.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('ui-polish-2');
const test = T.test;

let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
function show(o, specs) {
  const s = { id: nid('show'), collection: 'othertv', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 100 + n, status: 'confirmed', ...o };
  const rows = specs.map(sp => ({
    id: nid('r'), collection: s.collection, title: s.title, theme: 'HBO', status: 'pending', watched: !!sp.w, skipped: false, show_id: s.id,
    media_type: 'tv', tmdb_id: s.tmdb_id, season_number: sp.num, season: `Season ${sp.num}`, display_date: 'Jan 1, 2020',
    date_sort: '2020-01-01', item_key: `${s.show_key}|season ${sp.num}`, watch_with: [], collections: []
  }));
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'movies', title: 'Film', theme: 'Drama', status: 'confirmed', watched: false,
  media_type: 'movie', tmdb_id: 900 + n, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) });
const boot = async data => { const app = await createApp({ rows: data.rows, tvShows: data.shows }); app.ctx.switchView('alltv'); await settle(); return app; };
const rpcs = (app, name) => app.writes().filter(r => r.url.endsWith(`/rpc/${name}`));
const calls = app => app.writes().map(r => r.url.split('/rpc/')[1]);
const box = app => app.el('detailsModalBox').innerHTML;
const text = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const isOpen = app => !!app.get('detailsDialog');
const stored = (app, id) => app.store.tv_shows.find(s => s.id === id);
const genre = (app, g, on) => app.ctx.detailsToggle('genres', app.get('GENRES').indexOf(g), on);
const metaRpc = r => r.url.endsWith('/rpc/library_set_metadata_b45'), stateRpc = r => r.url.endsWith('/rpc/library_set_show_state_b45');
const subject = () => show({ title: 'Ender', status: 'watching', genres: ['Drama'] }, [{ num: 1, w: true }, { num: 2 }]);

test('Show ended is in Details, not the expanded show; Cancel sends nothing and keeps the stored value', async () => {
  const a = subject();
  const app = await boot(all(a));
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  assert.ok(!app.el('tbody').innerHTML.includes('{ ended: this.checked }'), 'not in the expanded show');
  app.ctx.openDetails('show', a.show.id, null);
  assert.match(box(app), /<input type="checkbox" id="detailsEnded" onchange="detailsSetEnded\(this.checked\)"> Show ended<\/label>/, 'unchecked, as stored');
  app.ctx.detailsSetEnded(true);
  app.ctx.closeDetails();
  assert.deepStrictEqual(app.writes(), [], 'Cancel: nothing sent');
  assert.strictEqual(stored(app, a.show.id).ended, false);
  app.ctx.openDetails('show', a.show.id, null);
  assert.ok(!/id="detailsEnded" checked/.test(box(app)), 'a new opening starts from what is stored');
  const f = film({ title: 'F' });
  const app2 = await boot(all(f));
  app2.ctx.switchMediaType('movie'); await settle();
  app2.ctx.openDetails('film', f.id, null);
  assert.ok(!box(app2).includes('detailsEnded'), 'films have no Show ended');
});

test('Save: only Show ended changed sends only Show ended; both changed send the categories, then Show ended, in one lane; nothing changed saves the categories as before', async () => {
  const a = subject(), b = subject(), c = subject();
  const app = await boot(all(a, b, c));
  app.ctx.openDetails('show', a.show.id, null);
  app.ctx.detailsSetEnded(true);
  await app.ctx.saveDetails(); await settle();
  assert.deepStrictEqual(calls(app), ['library_set_show_state_b45']);
  assert.deepStrictEqual(rpcs(app, 'library_set_show_state_b45')[0].body.p_changes, { ended: true });
  assert.strictEqual(stored(app, a.show.id).ended, true);
  assert.ok(!isOpen(app), 'closed once saved');
  app.ctx.openDetails('show', b.show.id, null);
  genre(app, 'Crime', true); app.ctx.detailsSetEnded(true);
  const held = app.hold(stateRpc);
  const saving = app.ctx.saveDetails();
  await held.reached;
  assert.ok(app.get('writeLane'), 'the lane is held across both calls');
  await app.ctx.setShowStateById(c.show.id, { priority: 'high' });
  held.release(); await saving; await settle();
  assert.deepStrictEqual(calls(app).slice(1), ['library_set_metadata_b45', 'library_set_show_state_b45'], 'categories, then Show ended; the other change was refused');
  assert.deepStrictEqual(stored(app, b.show.id).genres.slice().sort(), ['Crime', 'Drama']);
  assert.strictEqual(stored(app, b.show.id).ended, true);
  app.ctx.openDetails('show', c.show.id, null);
  await app.ctx.saveDetails(); await settle();
  assert.deepStrictEqual(calls(app).slice(3), ['library_set_metadata_b45'], 'Show ended unchanged: the categories call as before');
});

test('a refused categories save sends no Show ended; the dialog keeps the draft as before', async () => {
  const a = subject();
  const app = await boot(all(a));
  app.ctx.openDetails('show', a.show.id, null);
  genre(app, 'Crime', true); app.ctx.detailsSetEnded(true);
  app.refuseNext(metaRpc, 'P0001', 'target_changed: This changed since the page showed it, so nothing was changed. Look at it again.');
  await app.ctx.saveDetails(); await settle();
  assert.deepStrictEqual(calls(app), ['library_set_metadata_b45'], 'no Show ended call');
  assert.strictEqual(stored(app, a.show.id).ended, false);
  assert.ok(isOpen(app) && app.get('detailsDialog.stale') === 'changed', 'the existing stale lock');
});

test('categories saved, then Show ended refused: said exactly; Save again sends only Show ended against the new baseline', async () => {
  const a = subject();
  const app = await boot(all(a));
  app.ctx.openDetails('show', a.show.id, null);
  genre(app, 'Crime', true); app.ctx.detailsSetEnded(true);
  app.refuseNext(stateRpc, 'P0001', 'invalid_state: That change isn’t allowed now. Nothing was changed.');
  await app.ctx.saveDetails(); await settle();
  assert.deepStrictEqual(calls(app), ['library_set_metadata_b45', 'library_set_show_state_b45']);
  assert.ok(isOpen(app), 'the dialog stays');
  assert.match(text(box(app)), /Categories saved\. Show ended wasn’t changed: /);
  assert.ok(/id="detailsEnded" checked/.test(box(app)), 'the unsaved choice is kept');
  assert.deepStrictEqual(stored(app, a.show.id).genres.slice().sort(), ['Crime', 'Drama'], 'the categories are saved');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.get('detailsDialog.snapshot.genres'))).sort(), ['Crime', 'Drama'], 'and are the new baseline');
  await app.ctx.saveDetails(); await settle();
  assert.deepStrictEqual(calls(app), ['library_set_metadata_b45', 'library_set_show_state_b45', 'library_set_show_state_b45'], 'the retry sends only Show ended');
  assert.strictEqual(stored(app, a.show.id).ended, true);
  assert.ok(!isOpen(app));
});

test('Show ended unconfirmed: never called "not changed"; the list read again decides what is reported, and an unsettled result is said to be unknown', async () => {
  // The answer is lost after the database applied it: the reread shows it saved.
  const a = subject();
  const app = await boot(all(a));
  app.ctx.openDetails('show', a.show.id, null);
  genre(app, 'Crime', true); app.ctx.detailsSetEnded(true);
  app.loseNext(stateRpc, 'after');
  await app.ctx.saveDetails(); await settle();
  assert.strictEqual(stored(app, a.show.id).ended, true, 'it was applied');
  assert.doesNotMatch(text(box(app)), /wasn’t changed/);
  assert.match(text(box(app)), /Categories saved\. The list was read again and shows Show ended on, as chosen\./);
  assert.strictEqual(app.get('detailsDialog.endedBase'), true, 'its baseline follows what is stored');
  // Lost before it was applied: the reread shows it off; that may still change, so it isn't called refused.
  const b = subject();
  const app2 = await boot(all(b));
  app2.ctx.openDetails('show', b.show.id, null);
  app2.ctx.detailsSetEnded(true);
  app2.loseNext(stateRpc, 'before');
  await app2.ctx.saveDetails(); await settle();
  assert.strictEqual(stored(app2, b.show.id).ended, false);
  assert.match(text(box(app2)), /The list was read again and shows Show ended off; the request may still complete later\. Check it before saving again\./);
  assert.doesNotMatch(text(box(app2)), /Categories saved/, 'no categories call was made');
  assert.ok(/id="detailsEnded" checked/.test(box(app2)), 'the choice is kept for a later Save');
  // The reread itself fails: unknown.
  const c = subject();
  const app3 = await boot(all(c));
  app3.ctx.openDetails('show', c.show.id, null);
  app3.ctx.detailsSetEnded(true);
  app3.loseNext(stateRpc, 'before');
  app3.failNext(r => r.method === 'GET');
  await app3.ctx.saveDetails(); await settle();
  assert.match(text(box(app3)), /isn’t known whether it was saved/);
});

// ─── Films ────────────────────────────────────────────────────────────────────
test('All Movies: a film has no ×; Delete from library… is in its ⋯ menu and deletes as before', async () => {
  const f = film({ title: 'Gone' });
  const app = await boot(all(f, film({ title: 'Kept' })));
  app.ctx.switchMediaType('movie'); await settle();
  const row = app.el('tbody').innerHTML.split('</tr>').find(r => r.includes(`data-item="${f.id}"`));
  const card = app.el('cardList').innerHTML.split('<div class="item-card').find(c => c.includes(`data-item="${f.id}"`));
  for (const h of [row, card]) {
    assert.ok(!/>×<\/button>/.test(h), 'no ×');
    assert.match(h, new RegExp(`<button class="popover-action popover-danger" onclick="delRow\\('${f.id}'\\)" aria-label="Delete Gone from your library">Delete from library…</button>`));
  }
  await app.ctx.delRow(f.id); await settle();
  assert.ok(!app.store.watchlist_items.some(r => r.id === f.id), 'deleted after the confirmation');
  assert.ok(app.store.watchlist_items.some(r => r.title === 'Kept'));
});

// ─── Settings ─────────────────────────────────────────────────────────────────
test('Settings: Backup & Restore first; the password form opens from "Change password…" and Cancel closes and clears it', async () => {
  const app = await boot(all(subject()));
  app.ctx.openSettings(null);
  const html = app.el('settingsScreen').innerHTML;
  const cards = [...html.matchAll(/<section class="settings-card" aria-labelledby="(\w+)"/g)].map(m => m[1]);
  assert.strictEqual(cards[0], 'settingsBackupTitle', 'first');
  assert.match(html, /<button type="button" class="btn" id="accountPasswordToggle" aria-expanded="false" aria-controls="accountPasswordForm" onclick="toggleAccountPassword\(\)">Change password…<\/button>/);
  assert.match(html, /<form class="account-password" id="accountPasswordForm" hidden /, 'closed');
  const form = { hidden: true }, btn = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, focus() { focused = 'btn'; } };
  const field = id => ({ value: 'x', focus() { focused = id; } });
  const fields = { accountCurrentPassword: field('accountCurrentPassword'), accountNewPassword: field('accountNewPassword'), accountNewPassword2: field('accountNewPassword2') };
  let focused = '';
  const orig = app.ctx.document.getElementById;
  app.ctx.document.getElementById = id => (id === 'accountPasswordForm' ? form : id === 'accountPasswordToggle' ? btn : fields[id] || orig(id));
  app.ctx.toggleAccountPassword();
  assert.ok(!form.hidden && btn.attrs['aria-expanded'] === 'true' && focused === 'accountCurrentPassword', 'open, focus in the first field');
  app.ctx.toggleAccountPassword(false);
  assert.ok(form.hidden && btn.attrs['aria-expanded'] === 'false' && focused === 'btn', 'closed, focus back on the button');
  assert.deepStrictEqual(Object.values(fields).map(f => f.value), ['', '', ''], 'what was typed is cleared');
  app.ctx.document.getElementById = orig;
  assert.deepStrictEqual(app.writes(), []);
});

T.run();
