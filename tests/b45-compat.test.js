// Offline tests for this page against a database that isn't (or is no longer) B4/B5 (plan
// §10.4, C2), in the whole-page harness:
//   * after a B4/B5 rollback: a fresh load writes nothing and shows the state-changed notice
//     instead of lists without the B4/B5 columns; an open page's _b45 call is reported
//     ("doesn’t match"), stops further writes, and is never replaced by an older name; the
//     unchanged names send exactly the arguments the 5c database takes (those of G8,
//     aeb9f73); no backup file; a code scan that this page calls no old name;
//   * stop until reload: once a B4/B5 function is missing or a read lacks the B4/B5 columns,
//     nothing is written, backed up or restored until the page is reloaded, even though the
//     capability still reads B4/B5.
// (Batch B retired C1, the earlier releases' own behaviour on the B4/B5 database.)
// The server side: db/test/t_b45.sql (RL1/RL2) and tools/db-rehearsal-b45.mjs.
// Run from the repo root: node tests/b45-compat.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('b45-compat');
const test = T.test;
const ROOT = path.join(__dirname, '..');

const TS = '2026-10-01T00:00:00+00:00';
let n = 0;
const uuid = p => `${p}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
function library() {
  const sev = { id: uuid('5a000000'), collection: 'othertv', title: 'Severance', show_key: 'severance', tmdb_id: 95396, status: 'watching', created_at: TS };
  const season = (num, o = {}) => ({ id: uuid('5b000000'), collection: 'othertv', title: 'Severance', theme: 'Apple TV', status: 'confirmed', watched: false, skipped: false,
    show_id: sev.id, media_type: 'tv', tmdb_id: 95396, season_number: num, season: `Season ${num}`, display_date: 'Jan 1, 2022', date_sort: `202${num}-01-01`,
    item_key: `severance|season ${num}`, watch_with: [], collections: [], created_at: TS, tmdb_collection_id: null, tmdb_collection_name: null, ...o });
  const s1 = season(1), s2 = season(2, { watched: true }), s3 = season(3);
  const film = { id: uuid('f0000000'), collection: 'movies', title: 'Dune', theme: 'Drama', status: 'confirmed', watched: false, skipped: false, show_id: null,
    media_type: 'movie', tmdb_id: 438631, season_number: null, season: 'Film', display_date: 'Oct 22, 2021', date_sort: '2021-10-22', item_key: 'dune|film',
    watch_with: [], collections: [], created_at: TS, tmdb_collection_id: null, tmdb_collection_name: null };
  return { sev, s1, s2, s3, film, rows: [s1, s2, s3, film], shows: [sev] };
}
const writes = app => app.writes().map(r => `${r.method} ${r.url.split('/rest/v1/')[1].split('?')[0]}`);
const state = app => JSON.stringify([app.store.watchlist_items, app.store.tv_shows, app.store.collection_memberships, app.store.watch_with_choices, app.store.personal_collections]);
const banners = app => ['phaseBanner', 'banner', 'errorBanner', 'noticeBanner'].map(id => (app.el(id) || {}).innerHTML || '').join(' ').replace(/<[^>]+>/g, ' ');

// ─── C2: this page after a B4/B5 rollback ─────────────────────────────────────
test('C2 fresh load on the rolled-back (5c) database: no list without the B4/B5 columns (the state-changed notice instead), no edit offered, every write refused before sending', async () => {
  const lib = library();
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows, stage5: 'contracted' });
  assert.strictEqual(app.get('stage5Phase'), null);
  app.ctx.switchView('alltv'); await settle();
  assert.match(app.el('tbody').innerHTML + banners(app), /This page and the database don’t match/);
  assert.ok(!app.el('tbody').innerHTML.includes('derived-show-row'), 'no list');
  await app.ctx.toggleWatch(lib.s1.id); await settle();
  await app.ctx.setShowStateById(lib.sev.id, { status: 'skipped' }); await settle();
  const res = await app.ctx.buildBackupObject().then(() => 'made', e => e.message);
  assert.notStrictEqual(res, 'made');
  assert.deepStrictEqual(writes(app), []);
});

test('C2 open page when B4/B5 is rolled back: a _b45 call answers 404 → “This page and the database don’t match … Reload the page.”, no older name tried, later writes refused before sending; a re-read shows the notice', async () => {
  const lib = library();
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows });
  app.ctx.switchView('alltv'); await settle();
  app.rollbackB45();
  const before = state(app);
  await app.ctx.setShowStateById(lib.sev.id, { priority: 'high' }); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_set_show_state_b45']);
  assert.match(banners(app), /This page and the database don’t match \(the database may have been updated or rolled back\), so nothing was changed\. Reload the page\./);
  assert.strictEqual(app.get('stage5Phase'), null);
  assert.strictEqual(state(app), before);
  await app.ctx.toggleWatch(lib.s1.id); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_set_show_state_b45'], 'refused before sending');
  app.ctx.loadDerivedView(); await settle();
  assert.match(app.el('tbody').innerHTML + banners(app), /This page and the database don’t match/);
});

// EP1: delete_tv_season takes the season's mark count, which a database before EP1 doesn't have: that call
// answers 404 and stops the page like a missing _b45 function (never an unguarded delete).
test('C2 unchanged names on 5c: an open page sends exactly the arguments the 5c database takes (set_season_watched, set_season_skipped, watch-with PATCH; as G8 sends them), and they succeed; its delete (EP1, with the mark count) is refused and stops the page', async () => {
  // Each view was loaded before the rollback committed (a view read afterwards shows the notice instead).
  const run = async (mediaType, ops) => {
    const lib = library();
    const app = await createApp({ rows: lib.rows, tvShows: lib.shows });
    if (mediaType === 'movie') { app.ctx.switchMediaType('movie'); await settle(); } else { app.ctx.switchView('alltv'); await settle(); }
    app.rollbackB45();
    app.ctx.confirm = () => true;
    await ops(app, lib);
    if (mediaType !== 'tv-delete') assert.ok(!/does not exist|schema cache|client_outdated|library_write_required/.test(banners(app)), banners(app));
    return { app, lib, shapes: app.writes().map(r => [r.method, r.url.split('/rest/v1/')[1], r.body]), store: app.store };
  };
  const tv = await run('tv', async (app, lib) => {
    await app.ctx.toggleWatch(lib.s1.id); await settle();
    await app.ctx.setSeasonSkipped(lib.s3.id, true); await settle();
  });
  assert.deepStrictEqual(tv.shapes, [
    ['POST', 'rpc/set_season_watched', { p_row_id: tv.lib.s1.id, p_watched: true }],
    ['POST', 'rpc/set_season_skipped', { p_row_id: tv.lib.s3.id, p_skipped: true }]
  ]);
  const del = await run('tv-delete', async (app, lib) => { await app.ctx.delRowInView(lib.s2.id); await settle(); });
  assert.deepStrictEqual(del.shapes, [['POST', 'rpc/delete_tv_season', { p_row_id: del.lib.s2.id, p_marks_expected: 0 }]]);
  assert.ok(del.store.watchlist_items.some(r => r.season === 'Season 2'), 'nothing deleted');
  assert.match(banners(del.app), /This page and the database don’t match/);
  assert.strictEqual(del.app.get('b45Stopped'), true, 'the page stops until it is reloaded');
  const film = await run('movie', async (app, lib) => { await app.ctx.toggleWatchWith(lib.film.id, 'Rina', true); await settle(); });
  assert.deepStrictEqual(film.shapes, [['PATCH', `watchlist_items?id=eq.${film.lib.film.id}`, { watch_with: ['Rina'] }]]);
  const s1 = tv.store.watchlist_items.find(r => r.season === 'Season 1'), s3 = tv.store.watchlist_items.find(r => r.season === 'Season 3');
  assert.deepStrictEqual([s1.watched, s3.skipped], [true, true], 'they succeeded');
  assert.deepStrictEqual(film.store.watchlist_items.find(r => r.title === 'Dune').watch_with, ['Rina']);
});

// ─── GA-1 review 4: stop until reload ─────────────────────────────────────────
// The schema-cache case: the capability (and every later read of it) still says B4/B5, but a
// _b45 function answers 404 PGRST202. The page must not resume because the capability says so.
async function stoppedChecks(app, lib, label) {
  const n = app.writes().length;
  assert.strictEqual(app.get('stage5Phase'), null, `${label}: phase cleared`);
  assert.strictEqual(app.get('b45Stopped'), true, `${label}: stopped`);
  await app.ctx.toggleWatch(lib.s1.id); await settle();
  await app.ctx.setShowStateById(lib.sev.id, { priority: 'low' }); await settle();
  await app.ctx.setSeasonSkipped(lib.s3.id, true); await settle();
  assert.strictEqual(app.writes().length, n, `${label}: later writes are refused before sending, though the capability still reads B4/B5`);
  const cap = await (await app.ctx.fetch(`${app.get('SUPABASE_URL')}/rest/v1/rpc/stage5_capabilities`, {})).json();
  assert.strictEqual(cap.phase, 'contracted-cu1', `${label}: (the capability really does still say the page's phase)`);
  const res = await app.ctx.buildBackupObject().then(() => 'made', e => e.message);
  assert.match(res, /This page and the database don’t match[\s\S]*Reload the page\. No file was made\./, `${label}: no backup file`);
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  app.ctx.__b = { formatVersion: 5 };
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /Restore isn't available[\s\S]*This page and the database don’t match/, `${label}: no restore`);
  assert.match(app.el('phaseBanner').innerHTML, /Reload the page\. Until then this page changes nothing\./, `${label}: a persistent notice`);
  app.ctx.switchView('alltv'); await settle(); // S1: back to the list view the checks started from
  app.ctx.loadDerivedView(); await settle();
  assert.match(app.el('phaseBanner').innerHTML, /Until then this page changes nothing/, `${label}: the notice survives a view read`);
  assert.strictEqual(app.writes().length, n);
}
test('stop until reload (schema-cache case): a _b45 function missing while the capability still reports B4/B5 stops every later write, backup and restore; only a reload resumes', async () => {
  const lib = library();
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows });
  app.ctx.switchView('alltv'); await settle();
  const gone = { code: 'PGRST202', details: null, hint: null, message: 'Could not find the function public.library_set_show_state_b45 in the schema cache' };
  app.rpcHandlers.library_set_show_state_b45 = () => ({ ok: false, status: 404, text: async () => JSON.stringify(gone), json: async () => gone, headers: { get: () => null } });
  await app.ctx.setShowStateById(lib.sev.id, { priority: 'high' }); await settle();
  assert.match(app.el('errorBanner').innerHTML, /This page and the database don’t match/);
  await stoppedChecks(app, lib, 'schema cache');
  const lib2 = library();
  const fresh = await createApp({ rows: lib2.rows, tvShows: lib2.shows }); // the reload
  fresh.ctx.switchView('alltv'); await settle();
  await fresh.ctx.toggleWatch(lib2.s1.id); await settle();
  assert.deepStrictEqual(fresh.writes().map(r => r.url.split('/rpc/')[1]), ['set_season_watched'], 'a reloaded page writes again');
});

test('stop until reload: a read without the B4/B5 columns while the capability reports B4/B5 stops the page the same way', async () => {
  const lib = library();
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows });
  app.ctx.switchView('alltv'); await settle();
  // A read lacking a B4/B5 column (the capability still says B4/B5): the list answer without priority.
  const realFetch = app.ctx.fetch;
  app.ctx.fetch = async (url, opts) => {
    const res = await realFetch(url, opts);
    if (!/\/rest\/v1\/tv_shows\?/.test(url) || (opts && opts.method && opts.method !== 'GET')) return res;
    const rows = (await res.json()).map(r => { const c = { ...r }; delete c.priority; return c; });
    return { ok: true, status: 200, headers: res.headers, json: async () => rows, text: async () => JSON.stringify(rows) };
  };
  await app.run('loadDerivedView()'); await settle();
  app.ctx.fetch = realFetch;
  assert.match(app.el('errorBanner').innerHTML + app.el('readStatus').innerHTML, /This page and the database don’t match/);
  await stoppedChecks(app, lib, 'missing column');
});

test('C2 code scan: no app script calls an old name (set_show_status, the library_* adds, Match or catalog apply without _b45); every library_* call it makes is a _b45 function or a read view', () => {
  const html = fs.readFileSync(path.join(ROOT, 'watchlist.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"?]+\.js)[^"]*"/g)].map(m => m[1]);
  const OLD_NAMES = /\b(set_show_status|library_add_seasons|library_create_show|library_add_films|library_create_film|library_match_season|library_match_film|library_catalog_apply)\b(?!_b45)/;
  const hits = [];
  for (const f of scripts) fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    if (OLD_NAMES.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
  });
  assert.deepStrictEqual(hits, []);
  const calls = scripts.flatMap(f => [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/sbRpc\('([a-z0-9_]+)'/g)].map(m => m[1]));
  assert.ok(calls.filter(x => /^library_/.test(x)).every(x => /_b45$/.test(x) || x === 'library_set_episode_marks' || /^library_cu_[a-z_]+$/.test(x)), calls.join(', ')); // (EP1's own function; CU1's library_cu_*)
  assert.ok(!calls.includes('set_show_status'));
});

T.run();
