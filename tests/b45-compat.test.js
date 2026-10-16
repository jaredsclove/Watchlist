// Offline tests for page compatibility around B4/B5 (plan §10.4, C1 / C2), in the whole-page
// harness:
//   * C1 forward: the real earlier pages — G8 (aeb9f73) and 5b (f58bed7), exported from this
//     repository's history into a temporary directory — against the B4/B5 database: a fresh
//     load writes nothing; an already open page (it cached the 5c phase) is refused by the
//     stubs and the guards with nothing changed, and its deliberately supported paths
//     (season watched / skip, delete — the earlier-seasons range cleaned up — watch-with,
//     org_*) keep working; no backup file; no restore sent;
//   * C2 reverse: this page after a B4/B5 rollback: a fresh load writes nothing and shows the
//     state-changed notice instead of lists without the B4/B5 columns; an open page's _b45
//     call is reported ("doesn’t match"), stops further writes, and is never replaced by an
//     older name; the unchanged names send exactly the arguments G8 sends; no backup file;
//     a code scan that this page calls no old name.
// The server side (request shapes generated from that code; full-table snapshots):
// db/test/t_b45.sql (C1, RL1/RL2) and tools/db-rehearsal-b45.mjs.
// Run from the repo root: node tests/b45-compat.test.js (needs git and this repository's history)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('b45-compat');
const test = T.test;
const ROOT = path.join(__dirname, '..');
const OLD = {};
for (const c of ['aeb9f73', 'f58bed7']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `watchlist-${c}-`));
  execSync(`git -C "${ROOT}" archive ${c} | tar -x -C "${dir}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
  OLD[c] = dir;
}
process.on('exit', () => { for (const d of Object.values(OLD)) fs.rmSync(d, { recursive: true, force: true }); });

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
const lastAnswer = async app => { const r = app.requests.at(-1); return r; };

// ─── C1: earlier pages on the B4/B5 database ──────────────────────────────────
for (const [c, label] of [['aeb9f73', 'G8'], ['f58bed7', '5b']]) {
  test(`C1 (${label} ${c}) fresh load on B4/B5: the phase isn’t one it writes to, so it refuses every write before sending; no backup file`, async () => {
    const lib = library();
    const app = await createApp({ rows: lib.rows, tvShows: lib.shows, source: OLD[c] }); // the B4/B5 database (default)
    assert.strictEqual(app.get('stage5Phase'), null);
    app.ctx.switchView('alltv'); await settle();
    const before = state(app);
    await app.ctx.setShowStatusById(lib.sev.id, 'complete'); await settle();
    await app.ctx.toggleWatch(lib.s1.id); await settle();
    await app.ctx.setSeasonSkipped(lib.s3.id, true); await settle();
    const res = await app.ctx.buildBackupObject().then(() => 'made', e => e.message);
    assert.notStrictEqual(res, 'made', 'no backup file');
    assert.deepStrictEqual(writes(app), [], 'nothing sent');
    assert.strictEqual(state(app), before);
  });

  test(`C1 (${label} ${c}) already open when B4/B5 is installed: the stubs and guards refuse with nothing changed; season watched / skip, delete (range cleaned up), watch-with and org_* keep working`, async () => {
    const lib = library();
    const app = await createApp({ rows: lib.rows, tvShows: lib.shows, source: OLD[c], stage5: 'contracted' });
    app.ctx.switchView('alltv'); await settle();
    assert.strictEqual(app.get('stage5Phase'), 'contracted', 'the page cached the 5c phase');
    app.migrateB45();
    // The owner set an earlier-seasons range on the B4/B5 page meanwhile (S1, boundary S2).
    Object.assign(app.store.tv_shows[0], { resume_start_season_id: lib.s1.id, resume_end_season_id: lib.s2.id });
    // Refused: set_show_status (stub), a film's status and watched (guard).
    for (const [what, run, re] of [
      ['set_show_status', () => app.ctx.setShowStatusById(lib.sev.id, 'complete'), /client_outdated|out of date/i],
      ['film status PATCH', async () => { app.ctx.switchMediaType('movie'); await settle(); return app.ctx.setStatus(lib.film.id, 'watching', null); }, /library_write_required|library functions/i],
      ['film watched PATCH', () => app.ctx.toggleWatch(lib.film.id), /library_write_required|library functions/i]
    ]) {
      const before = state(app);
      const sent = app.requests.length;
      await run(); await settle();
      const answers = app.requests.slice(sent).filter(r => r.method !== 'GET');
      assert.strictEqual(answers.length, 1, `${what}: one request`);
      assert.strictEqual(state(app), before, `${what}: nothing changed`);
      assert.match(banners(app) + (app.el('tbody').innerHTML || ''), re, what);
    }
    // The old library functions are stubs (as an open old page would call them).
    for (const fn of ['library_add_seasons', 'library_create_show', 'library_add_films', 'library_create_film', 'library_match_season', 'library_match_film', 'library_catalog_apply']) {
      const before = state(app);
      const r = await (await app.ctx.fetch(`${app.get('SUPABASE_URL')}/rest/v1/rpc/${fn}`, { method: 'POST', headers: {}, body: '{}' })).json();
      assert.match(r.message, /^client_outdated:/, fn);
      assert.strictEqual(state(app), before, fn);
    }
    // Supported: season watched and skip, watch-with, a membership; then deleting the range's start.
    app.ctx.switchMediaType('tv'); await settle(); app.ctx.switchView('alltv'); await settle();
    await app.ctx.toggleWatch(lib.s3.id); await settle();
    assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s3.id).watched, true, 'set_season_watched');
    await app.ctx.setSeasonSkipped(lib.s3.id, true); await settle();
    assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s3.id).skipped, true, 'set_season_skipped');
    app.ctx.switchMediaType('movie'); await settle();
    await app.ctx.toggleWatchWith(lib.film.id, 'Rina', true); await settle();
    assert.deepStrictEqual(app.store.watchlist_items.find(r => r.id === lib.film.id).watch_with, ['Rina'], 'watch-with PATCH');
    const col = app.store.personal_collections[0];
    const m = await (await app.ctx.fetch(`${app.get('SUPABASE_URL')}/rest/v1/rpc/org_add_membership`, { method: 'POST', headers: {}, body: JSON.stringify({ p_collection_id: col.id, p_show_id: lib.sev.id, p_item_id: null }) })).json();
    assert.ok(m && !m.code, 'org_* works');
    const showBefore = { ...app.store.tv_shows[0] };
    app.ctx.switchMediaType('tv'); await settle(); app.ctx.switchView('alltv'); await settle();
    app.ctx.confirm = () => true;
    await app.ctx.delRowInView(lib.s1.id); await settle();
    assert.ok(!app.store.watchlist_items.some(r => r.id === lib.s1.id), 'delete_tv_season works');
    const after = app.store.tv_shows[0];
    assert.deepStrictEqual([after.resume_start_season_id, after.resume_end_season_id], [null, null], 'the range naming it is cleared');
    for (const k of Object.keys(showBefore)) if (!k.startsWith('resume_')) assert.deepStrictEqual(after[k], showBefore[k], `show ${k} unchanged`);
    // No backup file once the database is B4/B5; a restore isn’t sent.
    const res = await app.ctx.buildBackupObject().then(() => 'made', e => e.message);
    assert.notStrictEqual(res, 'made');
    assert.ok(!app.requests.some(r => r.url.endsWith('/rpc/restore_backup')));
  });
}

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

test('C2 unchanged names on 5c: an open B page sends exactly the arguments G8 sends (set_season_watched, set_season_skipped, delete_tv_season, watch-with PATCH), and they succeed', async () => {
  // Each view was loaded before the rollback committed (a view read afterwards shows the notice instead).
  const run = async (who, mediaType, ops) => {
    n = 0; // identical ids in both libraries
    const lib = library();
    const app = await createApp({ rows: lib.rows, tvShows: lib.shows, ...(who === 'g8' ? { source: OLD.aeb9f73, stage5: 'contracted' } : {}) });
    if (mediaType === 'movie') { app.ctx.switchMediaType('movie'); await settle(); } else { app.ctx.switchView('alltv'); await settle(); }
    if (who === 'b45') app.rollbackB45();
    app.ctx.confirm = () => true;
    await ops(app, lib);
    assert.ok(!/does not exist|schema cache|client_outdated|library_write_required/.test(banners(app)), `${who}: ${banners(app)}`);
    return { shapes: app.writes().map(r => [r.method, r.url.split('/rest/v1/')[1], JSON.stringify(r.body)]), store: app.store };
  };
  const tvOps = async (app, lib) => {
    await app.ctx.toggleWatch(lib.s1.id); await settle();
    await app.ctx.setSeasonSkipped(lib.s3.id, true); await settle();
    await app.ctx.delRowInView(lib.s2.id); await settle();
  };
  const filmOps = async (app, lib) => { await app.ctx.toggleWatchWith(lib.film.id, 'Rina', true); await settle(); };
  const [bTv, gTv, bFilm, gFilm] = [await run('b45', 'tv', tvOps), await run('g8', 'tv', tvOps), await run('b45', 'movie', filmOps), await run('g8', 'movie', filmOps)];
  assert.deepStrictEqual(bTv.shapes, gTv.shapes);
  assert.deepStrictEqual(bFilm.shapes, gFilm.shapes);
  assert.deepStrictEqual(bTv.shapes.concat(bFilm.shapes).map(x => x[1].split('?')[0]), ['rpc/set_season_watched', 'rpc/set_season_skipped', 'rpc/delete_tv_season', 'watchlist_items']);
  const s1 = bTv.store.watchlist_items.find(r => r.season === 'Season 1'), s3 = bTv.store.watchlist_items.find(r => r.season === 'Season 3');
  assert.deepStrictEqual([s1.watched, s3.skipped, bTv.store.watchlist_items.some(r => r.season === 'Season 2')], [true, true, false], 'they succeeded');
  assert.deepStrictEqual(bFilm.store.watchlist_items.find(r => r.title === 'Dune').watch_with, ['Rina']);
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
  assert.strictEqual(cap.phase, 'contracted-b45', `${label}: (the capability really does still say B4/B5)`);
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
  assert.match(app.el('errorBanner').innerHTML + app.el('tbody').innerHTML, /This page and the database don’t match/);
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
  assert.ok(calls.filter(x => /^library_/.test(x)).every(x => /_b45$/.test(x)), calls.join(', '));
  assert.ok(!calls.includes('set_show_status'));
});

T.run();
