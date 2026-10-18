// Offline tests for the film transition contract (B4/B5 Batch A, plan §4.2), in the whole-page
// harness, from All Movies: every cell of the table — the status selector (To Watch / Watched /
// Skipped), the Watched button, the catalog × and a priority change — from each of the four
// states (To Watch, Watched, Skipped, the preserved Skipped + Watched pair): what is sent (one
// guarded call), which transitions ask first ("This also clears Watched" / "This clears
// Watched"), what Cancel does (nothing), the O1-under-review rule, the controls that aren't
// shown, refusals and unknown outcomes. The database rules: db/test/t_b45.sql (W2).
// Run from the repo root: node tests/b45-film-contract.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('b45-film-contract');
const test = T.test;

const STATES = { to_watch: ['confirmed', false], watched: ['confirmed', true], skipped: ['skipped', false], pair: ['skipped', true] };
let n = 0;
const film = (state, o = {}) => ({ id: o.id || `f${++n}`, collection: 'movies', title: o.title || `Film ${n}`, theme: 'Drama', status: STATES[state][0], watched: STATES[state][1],
  media_type: 'movie', tmdb_id: 900 + n, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });
async function allMovies(rows, opts = {}) {
  const app = await createApp({ rows, ...opts });
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fStatus').value = 'all'; app.el('fWatch').value = ''; app.ctx.renderTable();
  return app;
}
const sent = app => app.writes().filter(r => r.url.endsWith('/rpc/library_set_film_state_b45')).map(r => JSON.parse(JSON.stringify(r.body.p_changes)));
const storedState = (app, id) => { const r = app.store.watchlist_items.find(x => x.id === id); return [r.status, r.watched]; };
const rowHtml = (app, id) => app.el('tbody').innerHTML.split('<tr').find(x => x.includes(`setStatus('${id}'`)) || '';

// ─── The status selector, every cell ──────────────────────────────────────────
const SELECTOR = [
  // from, to, sent changes (null = no-op), confirmation asked (regex or null), result
  ['to_watch', 'to_watch', null, null, 'to_watch'],
  ['to_watch', 'watched', { state: 'watched' }, null, 'watched'],
  ['to_watch', 'skipped', { state: 'skipped' }, null, 'skipped'],
  ['watched', 'to_watch', { state: 'to_watch' }, null, 'to_watch'],
  ['watched', 'watched', null, null, 'watched'],
  ['watched', 'skipped', { state: 'skipped' }, /This also clears Watched\./, 'skipped'],
  ['skipped', 'to_watch', { state: 'to_watch' }, null, 'to_watch'],
  ['skipped', 'watched', { state: 'watched' }, null, 'watched'],
  ['skipped', 'skipped', null, null, 'skipped'],
  ['pair', 'to_watch', { state: 'to_watch' }, /This clears Watched\./, 'to_watch'],
  ['pair', 'watched', { state: 'watched' }, null, 'watched'],
  ['pair', 'skipped', null, null, 'pair']
];
for (const [from, to, changes, ask, result] of SELECTOR) {
  test(`selector ${from} → ${to}: ${changes ? `one call ${JSON.stringify(changes)}` : 'no-op (nothing sent)'}${ask ? ', after a confirmation (Cancel sends nothing)' : ''}`, async () => {
    const f = film(from, { catalog_new: true, legacy_status: 'pending' });
    const app = await allMovies([f]);
    const asked = [];
    if (ask) {
      app.ctx.confirm = q => { asked.push(q); return false; };
      await app.ctx.setStatus(f.id, to); await settle();
      assert.deepStrictEqual(sent(app), [], 'Cancel: nothing sent');
      assert.match(asked[0], ask);
    }
    app.ctx.confirm = q => { asked.push(q); return true; };
    await app.ctx.setStatus(f.id, to); await settle();
    assert.deepStrictEqual(sent(app), changes ? [changes] : []);
    if (!ask) assert.strictEqual(asked.length, 0, 'no confirmation');
    assert.deepStrictEqual(storedState(app, f.id), STATES[result]);
    const r = app.store.watchlist_items.find(x => x.id === f.id);
    if (changes) assert.deepStrictEqual([r.catalog_new, r.status_review, r.legacy_status], [false, false, null], 'O1 clears New, review and provenance');
    else assert.deepStrictEqual([r.catalog_new, r.legacy_status], [true, 'pending'], 'a no-op changes nothing');
  });
}

test('O1 under review: the selector starts on a prompt; choosing the current state is sent and resolves the review (also from the pair, which stays a pair)', async () => {
  const w = film('watched', { status_review: true, legacy_status: 'watching' });
  const p = film('pair', { status_review: true, legacy_status: 'complete' });
  const app = await allMovies([w, p]);
  assert.ok(rowHtml(app, w.id).includes('<option value="" selected disabled>Choose a status…</option>'));
  const asked = [];
  app.ctx.confirm = q => { asked.push(q); return true; };
  await app.ctx.setStatus(w.id, 'watched'); await settle();
  await app.ctx.setStatus(p.id, 'skipped'); await settle();
  assert.strictEqual(asked.length, 1);
  assert.match(asked[0], /Skipped\? This clears Watched\./, 'choosing Skipped on the pair clears Watched: asked first');
  assert.deepStrictEqual(sent(app), [{ state: 'watched' }, { state: 'skipped' }]);
  assert.deepStrictEqual(storedState(app, w.id), STATES.watched);
  assert.deepStrictEqual(storedState(app, p.id), STATES.skipped, 'Skipped chosen explicitly: Watched cleared (the server never keeps a pair on a status change)');
  assert.ok(app.store.watchlist_items.filter(r => [w.id, p.id].includes(r.id)).every(r => !r.status_review && r.legacy_status === null));
});

test('the pair is shown as “✕ Skipped (marked watched)” (disabled option) and kept by a priority-only change', async () => {
  const p = film('pair', { legacy_status: 'maybe', priority: 'low' });
  const app = await allMovies([p]);
  assert.ok(rowHtml(app, p.id).includes('<option value="pair" selected disabled>✕ Skipped (marked watched)</option>'));
  await app.ctx.setFilmPriority(p.id, 'high'); await settle();
  assert.deepStrictEqual(sent(app), [{ priority: 'high' }]);
  assert.deepStrictEqual(storedState(app, p.id), STATES.pair, 'pair preserved');
  const r = app.store.watchlist_items.find(x => x.id === p.id);
  assert.deepStrictEqual([r.priority, r.legacy_status], ['high', null], 'maybe provenance encodes priority: cleared');
});

// ─── The Watched button (O4) and the catalog × ───────────────────────────────
test('Watched button: To Watch → Watched and Watched → To Watch as watched-only changes (markers kept); not shown on Skipped or the pair', async () => {
  const a = film('to_watch', { catalog_new: true, legacy_status: 'pending' }), b = film('watched', { status_review: true, legacy_status: 'complete' });
  const s = film('skipped'), p = film('pair');
  const app = await allMovies([a, b, s, p]);
  for (const x of [s, p]) assert.ok(!rowHtml(app, x.id).includes(`toggleWatch('${x.id}')`), 'not shown');
  await app.ctx.toggleWatch(a.id); await settle();
  await app.ctx.toggleWatch(b.id); await settle();
  assert.deepStrictEqual(sent(app), [{ watched: true }, { watched: false }]);
  assert.deepStrictEqual(storedState(app, a.id), STATES.watched);
  assert.deepStrictEqual(storedState(app, b.id), STATES.to_watch);
  const ra = app.store.watchlist_items.find(x => x.id === a.id), rb = app.store.watchlist_items.find(x => x.id === b.id);
  assert.deepStrictEqual([ra.catalog_new, ra.legacy_status, rb.status_review, rb.legacy_status], [true, 'pending', true, 'complete'], 'O4 changes no marker');
  await app.ctx.toggleWatch(s.id); await settle();
  assert.strictEqual(sent(app).length, 2, 'a skipped film’s Watched is never sent as a watched-only change');
});

test('catalog ×: To Watch → Skipped after the catalog confirmation; on a watched film it also says “This also clears Watched”; Cancel sends nothing; not shown on Skipped or the pair', async () => {
  const probe = await createApp();
  const defs = probe.get("COLLECTIONS.find(c => c.id === 'disney').defaults.filter(d => d.s === 'Film')").slice(0, 4);
  const cat = (state, d) => film(state, { collection: 'disney', media_type: null, tmdb_id: null, title: d.t, item_key: d.k });
  const [a, b, s, p] = [cat('to_watch', defs[0]), cat('watched', defs[1]), cat('skipped', defs[2]), cat('pair', defs[3])];
  const app = await allMovies([a, b, s, p]);
  for (const x of [s, p]) assert.ok(!rowHtml(app, x.id).includes(`delRow('${x.id}')`), 'no × on a skipped catalog film');
  // D6 (S3): the in-page dialog (tests/app-harness.js records each one and answers it per app.dialogAnswer).
  const asked = () => app.dialogs.map(d => d.text);
  app.dialogAnswer = 'cancel';
  await app.ctx.delRow(b.id); await settle();
  assert.deepStrictEqual(sent(app), [], 'Cancel: nothing sent');
  assert.match(asked()[0], /It’s part of a built-in catalog, so it is marked Skipped rather than deleted\. This also clears Watched\./);
  assert.strictEqual(app.dialogs[0].confirmLabel, 'Skip film');
  app.dialogAnswer = 'confirm';
  await app.ctx.delRow(a.id); await settle();
  await app.ctx.delRow(b.id); await settle();
  assert.ok(!/clears Watched/.test(asked()[1]), 'an unwatched film: the catalog wording only');
  assert.deepStrictEqual(sent(app), [{ state: 'skipped' }, { state: 'skipped' }]);
  assert.deepStrictEqual([storedState(app, a.id), storedState(app, b.id)], [STATES.skipped, STATES.skipped]);
  assert.ok(!app.writes().some(r => r.method === 'DELETE'), 'never deleted');
});

// ─── Refusals and unknown outcomes ────────────────────────────────────────────
test('stale (changed elsewhere): refused with nothing changed, the value put back and the view read again; never resent', async () => {
  const f = film('to_watch');
  const app = await allMovies([f]);
  app.store.watchlist_items.find(x => x.id === f.id).priority = 'high';
  await app.ctx.setStatus(f.id, 'watched'); await settle();
  assert.match(app.el('errorBanner').innerHTML, /This changed since the page showed it, so nothing was changed\. The list has been read again/);
  assert.deepStrictEqual(storedState(app, f.id), STATES.to_watch);
  assert.strictEqual(app.get(`browseData.rows.find(r => r.id === '${f.id}').priority`), 'high', 'the view shows what is stored now');
  assert.strictEqual(sent(app).length, 1);
});

test('no clear answer: reported as not confirmed, never resent; the view is read again', async () => {
  const f = film('watched');
  const app = await allMovies([f]);
  const g = app.hold(r => r.url.endsWith('/rpc/library_set_film_state_b45'));
  const p = app.ctx.setStatus(f.id, 'to_watch');
  await g.reached; g.fail(); await p; await settle(); await settle(50);
  assert.match(app.el('errorBanner').innerHTML, /This change wasn’t confirmed[\s\S]*won’t be sent again/);
  assert.strictEqual(sent(app).length, 1);
});

test('a database that would refuse a pair: a status change creating one is refused by the server (defence in depth)', async () => {
  const s = film('skipped');
  const app = await allMovies([s]);
  const res = await app.rpcHandlers.library_set_film_state_b45({ p_item_id: s.id, p_expected: { status: 'skipped', watched: false, priority: 'normal', catalog_new: false, status_review: false },
    p_changes: { watched: true } }).json();
  assert.match(res.message, /^invalid_state:/);
  assert.deepStrictEqual(storedState(app, s.id), STATES.skipped);
});

test('All Movies filters: Status To Watch · Watched · Skipped · All (except Skipped) (the pair counts as Skipped); the Watched filter is unchanged', async () => {
  const rows = [film('to_watch', { title: 'A' }), film('watched', { title: 'B' }), film('skipped', { title: 'C' }), film('pair', { title: 'D' })];
  const app = await allMovies(rows);
  const opts = [...(app.el('filtersRow').innerHTML.match(/id="fStatus"[\s\S]*?<\/select>/) || [''])[0].matchAll(/<option value="([^"]*)">([^<]*)</g)].map(m => `${m[1]}=${m[2]}`);
  assert.deepStrictEqual(opts, ['=All (except Skipped)', 'all=All statuses', 'to_watch=To Watch', 'watched=Watched', 'skipped=Skipped']);
  const titles = () => [...app.el('tbody').innerHTML.matchAll(/show-title">([^<]*)</g)].map(m => m[1]);
  for (const [v, want] of [['', ['A', 'B']], ['to_watch', ['A']], ['watched', ['B']], ['skipped', ['C', 'D']], ['all', ['A', 'B', 'C', 'D']]]) {
    app.el('fStatus').value = v; app.ctx.renderTable();
    assert.deepStrictEqual(titles(), want, v);
  }
  assert.ok(app.el('filtersRow').innerHTML.includes('id="fWatch"'));
  assert.deepStrictEqual(app.writes(), []);
});

T.run();
