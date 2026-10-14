// Offline tests for how TMDB lookup failures are reported: the message helpers in
// ui-helpers.js, the movie tools' refresh / pull / add flows run against stubbed
// TMDB and database calls, and Refresh shows in the whole-page harness (Stage 5:
// it runs in the "+ Add" panel on a complete library read).
// Run from the repo root: node tests/tmdb-failures.test.js
// No network, no database. Nothing here can write anywhere: sbFetch is a stub
// that only records what would have been sent.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const FILES = ['config.js', 'identity.js', 'ui-helpers.js', 'metadata.js', 'refresh-shows.js', 'collections-pull.js', 'universe-pull.js', 'person-pull.js', 'library.js'];
const { createApp, settle } = require('./app-harness');

// A fresh sandbox per test, as All Movies' "+ Add" panel with its tools prepared
// (the films cache filled from a complete read). tmdb(path) decides each TMDB
// response: return a value, or throw via fail(status) / down().
function makeEnv({ tmdb, rows = [], checkboxes = [] }) {
  const els = new Map();
  const el = id => {
    if (!els.has(id)) els.set(id, { id, innerHTML: '', value: '', classList: { add() {}, remove() {} }, scrollIntoView() {} });
    return els.get(id);
  };
  const log = { posts: [], saved: 0, cancelled: 0, reset: 0, tmdbCalls: 0 };
  const ctx = {
    console, setTimeout: () => 0,
    document: { getElementById: el, querySelectorAll: () => checkboxes },
    tabData: { films: { rows, loaded: true, newKeys: [], known: rows.slice() } },
    // page state the tool context reads (library.js): All Movies with its prepared panel
    activeViewId: 'allmovies', orgEpoch: 0,
    libraryPanel: { session: 1, media: 'movie', mode: 'tools', viewId: 'allmovies', epoch: 0, toolsReady: true },
    tmdbShowSpecials: false,
    tmdbFetch: async p => { log.tmdbCalls++; return tmdb(p); },
    sbFetch: async (method, p) => { throw new Error(`unexpected ${method} ${p}`); },
    // Films are added through library_add_films_b45 (body: the films, recorded as sent).
    sbRpc: async (name, body) => {
      if (name !== 'library_add_films_b45') throw new Error(`unexpected rpc ${name}`);
      log.posts.push({ table: `rpc/${name}`, body: JSON.parse(JSON.stringify(body.p_films)) });
      const inserted = body.p_films.map((r, i) => ({ id: `new-${i}`, ...r }));
      return { results: inserted.map((r, i) => ({ index: i, outcome: 'inserted', id: r.id })), inserted };
    },
    showNotice() {}, isBrowseView: id => id === 'allmovies', loadBrowseView() {},
    cancelTMDBPreview: () => { log.cancelled++; },
    resetTMDBSearchUI: () => { log.reset++; },
    renderFilters() {}, renderTable() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
  ctx.showSaved = () => { log.saved++; };
  const text = id => el(id).innerHTML.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
  return { ctx, log, preview: () => text('tmdbPreview'), banner: () => text('errorBanner') };
}
const fail = status => { const e = new Error(`TMDB error ${status}`); e.status = status; throw e; };
const down = () => { throw new TypeError('Failed to fetch'); };

// Fixtures: tracked shows whose stored seasons already match TMDB
const shows = [
  { tmdb_id: 1, title: 'Alpha', collection: 'othertv' },
  { tmdb_id: 2, title: 'Bravo', collection: 'othertv' },
  { tmdb_id: 3, title: 'Charlie', collection: 'othertv' },
];
const seasonRow = (tmdb_id, title) => ({ id: `r${tmdb_id}`, collection: 'othertv', item_key: `${title.toLowerCase()}|season 1`, title, season: 'Season 1',
  display_date: 'Jan 1, 2020', date_sort: '2020-01-01', media_type: 'tv', tmdb_id, season_number: 1 });
const showRows = shows.map(s => seasonRow(s.tmdb_id, s.title));
const tvDetails = id => ({ id, seasons: [{ season_number: 1, air_date: '2020-01-01', episode_count: 8 }] });
const cb = data => ({ checked: true, disabled: false, dataset: data });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── helpers ──
test('lookup note: no failures → null', () => {
  assert.strictEqual(vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'ui-helpers.js'), 'utf8') + ';tmdbLookupFailureNote(60, [], "show")'), null);
});
test('lookup note: all failed → total outage message', () => {
  const env = makeEnv({ tmdb: () => ({}) });
  const n = env.ctx.tmdbLookupFailureNote(60, Array(60).fill('x'), 'show');
  assert.strictEqual(n.total, true);
  assert.strictEqual(n.message, "Couldn't check TMDB right now. 60 of 60 show lookups failed. Nothing was changed.");
});
test('lookup note: partial → incomplete warning naming the failures', () => {
  const env = makeEnv({ tmdb: () => ({}) });
  const n = env.ctx.tmdbLookupFailureNote(60, ['Silo', 'Fauda', 'Tehran'], 'show');
  assert.strictEqual(n.total, false);
  assert.strictEqual(n.message, 'Checked 57 of 60 shows. 3 TMDB lookups failed (Silo, Fauda, Tehran), so this result may be incomplete.');
});
test('add note: partial and total', () => {
  const env = makeEnv({ tmdb: () => ({}) });
  assert.strictEqual(env.ctx.tmdbAddFailureNote(2, [], 'film'), null);
  assert.strictEqual(env.ctx.tmdbAddFailureNote(2, ['Lost Boys: The Thirst'], 'film'),
    "Added 1 of 2 selected films. Couldn't load TMDB details for Lost Boys: The Thirst, so it was not added.");
  assert.ok(env.ctx.tmdbAddFailureNote(2, ['A', 'B'], 'film').includes('any of the 2 selected films, so nothing was added'));
  assert.ok(env.ctx.tmdbAddFailureNote(1, ['A'], 'film').includes('the selected film, so nothing was added'));
});

// ── Refresh shows (whole page: All TV's "+ Add" panel) ──
function libraryOf(rows) {
  const tvShows = shows.map(sh => ({ id: `show-${sh.tmdb_id}`, collection: 'othertv', title: sh.title, show_key: sh.title.toLowerCase(), tmdb_id: sh.tmdb_id, status: 'confirmed' }));
  return { tvShows, rows: rows.map(r => ({ theme: 'Net', status: 'confirmed', watched: false, skipped: false, watch_with: [], collections: [], ...r, show_id: `show-${r.tmdb_id}` })) };
}
async function refreshShows({ rows = showRows, tmdb }) {
  const app = await createApp({ ...libraryOf(rows), tmdb: p => p.startsWith('/tv/') ? tmdb(p) : undefined });
  app.ctx.switchView('alltv'); await settle();
  app.ctx.openLibraryPanel('tv', 'refresh'); await settle();
  await app.ctx.libraryRefreshShows(); await settle();
  assert.deepStrictEqual(app.writes(), [], 'checking writes nothing');
  return app.el('tmdbPreview').innerHTML.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/’/g, "'").replace(/\s+/g, ' ').trim();
}
const status = code => ({ __status: code });
test('Refresh shows: all lookups succeed, nothing new → true "up to date"', async () => {
  const p = await refreshShows({ tmdb: p => tvDetails(+p.split('/')[2]) });
  assert.ok(p.startsWith("Everything's up to date"), p);
});
test('Refresh shows: every lookup fails (HTTP 500) → outage message, no "up to date"', async () => {
  assert.strictEqual(await refreshShows({ tmdb: () => status(500) }), "Couldn't check TMDB right now. 3 of 3 show lookups failed. Nothing was changed.");
});
test('Refresh shows: network down → outage message', async () => {
  const p = await refreshShows({ tmdb: () => down() });
  assert.ok(p.startsWith("Couldn't check TMDB right now."), p);
});
test('Refresh shows: partial failure, nothing new → incomplete warning, no "up to date"', async () => {
  const p = await refreshShows({ tmdb: p => p === '/tv/2' ? status(503) : tvDetails(+p.split('/')[2]) });
  assert.ok(!p.includes('Everything'), p);
  assert.ok(p.includes('Checked 2 of 3 shows. 1 TMDB lookup failed (Bravo)'), p);
});
test('Refresh shows: partial failure still shows new seasons and TBA→date updates from shows that loaded', async () => {
  const rows = [seasonRow(1, 'Alpha'), seasonRow(2, 'Bravo'), { ...seasonRow(3, 'Charlie'), display_date: 'TBA', date_sort: '2099-01-01' }];
  const p = await refreshShows({ rows, tmdb: p => {
    if (p === '/tv/2') return status(500);
    if (p === '/tv/1') return { id: 1, seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2027-05-01', episode_count: 6 }] };
    return { id: 3, seasons: [{ season_number: 1, air_date: '2026-11-26' }] };
  } });
  assert.ok(p.includes('Checked 2 of 3 shows') && p.includes('Alpha') && p.includes('Season 2'), p);
  assert.ok(p.includes('Charlie · Season 1 TBA → Nov 26, 2026'), p);
});

// ── Refresh collections ──
const collRows = [
  { id: 'm1', collection: 'movies', item_key: 'a|film', title: 'A', media_type: 'movie', tmdb_id: 11, tmdb_collection_id: 100, tmdb_collection_name: 'Alpha Collection' },
  { id: 'm2', collection: 'movies', item_key: 'b|film', title: 'B', media_type: 'movie', tmdb_id: 21, tmdb_collection_id: 200, tmdb_collection_name: 'Bravo Collection' },
];
const collection = id => ({ id, name: id === 100 ? 'Alpha Collection' : 'Bravo Collection', parts: [{ id: id === 100 ? 11 : 21, title: id === 100 ? 'A' : 'B', release_date: '2001-01-01' }] });
test('Refresh collections: all lookups succeed, nothing new → true "up to date"', async () => {
  const env = makeEnv({ rows: collRows, tmdb: p => collection(+p.split('/')[2]) });
  await env.ctx.refreshCollections();
  assert.ok(env.preview().startsWith("✓ Everything's up to date"), env.preview());
});
test('Refresh collections: every lookup fails → outage message', async () => {
  const env = makeEnv({ rows: collRows, tmdb: () => fail(500) });
  await env.ctx.refreshCollections();
  assert.strictEqual(env.preview(), "Couldn't check TMDB right now. 2 of 2 collection lookups failed. Nothing was changed.");
});
test('Refresh collections: partial failure → incomplete warning naming the collection', async () => {
  const env = makeEnv({ rows: collRows, tmdb: p => p === '/collection/200' ? down() : collection(100) });
  await env.ctx.refreshCollections();
  assert.ok(!env.preview().includes('Everything'), env.preview());
  assert.ok(env.preview().includes('Checked 1 of 2 collections. 1 TMDB lookup failed (Bravo)'), env.preview());
});

// ── Universe pull ──
test('Universe: outage → TMDB error, not "Couldn\'t find on TMDB"', async () => {
  const env = makeEnv({ rows: [], tmdb: () => fail(500) });
  await env.ctx.pullUniverse('mcu');
  const n = vm.runInContext('UNIVERSE_LISTS.mcu.titles.length', env.ctx);
  assert.strictEqual(env.preview(), `Couldn't check TMDB right now. ${n} of ${n} title lookups failed. Nothing was changed.`);
  assert.ok(!env.preview().includes("Couldn't find"));
});
test('Universe: a genuine 404 is "not found"; a failed request is reported separately', async () => {
  const titles = vm.runInContext('UNIVERSE_LISTS.mcu.titles', makeEnv({ tmdb: () => ({}) }).ctx);
  const [first, second] = [titles[0], titles[1]];
  const env = makeEnv({ rows: [], tmdb: p => {
    if (p === `/movie/${first.id}`) fail(404);
    if (p === `/movie/${second.id}`) fail(503);
    return { id: +p.split('/')[2], title: 'X', release_date: '2010-01-01' };
  } });
  await env.ctx.pullUniverse('mcu');
  const p = env.preview();
  assert.ok(p.includes(`Couldn't find on TMDB: ${first.t}`), p);
  assert.ok(!p.includes(`Couldn't find on TMDB: ${first.t}, ${second.t}`), p);
  assert.ok(p.includes(`1 TMDB lookup failed (${second.t})`), p);
});

// ── Apply / add ──
const pullData = { collectionId: 109076, collectionName: 'Lost Boys', tmdbCollectionName: 'Lost Boys Collection',
  movies: [{ id: 13489, title: 'Lost Boys: The Tribe' }, { id: 46812, title: 'Lost Boys: The Thirst' }] };
const movieDetails = id => ({ id, genres: [{ name: 'Horror' }], release_date: '2008-07-29' });
function pullEnv(tmdb) {
  const env = makeEnv({ rows: [], tmdb, checkboxes: pullData.movies.map(m => cb({ movieId: String(m.id) })) });
  env.ctx.__pullCollectionData = pullData;
  return env;
}
test('Pull collection Apply: 2 selected, 1 lookup fails → 1 inserted + explicit warning', async () => {
  const env = pullEnv(p => p === '/movie/46812' ? fail(500) : movieDetails(13489));
  await env.ctx.addPulledCollectionMovies();
  assert.strictEqual(env.log.posts.length, 1);
  assert.deepStrictEqual(env.log.posts[0].body.map(r => r.title), ['Lost Boys: The Tribe']);
  assert.strictEqual(env.log.saved, 1);
  assert.ok(env.banner().includes("Added 1 of 2 selected films. Couldn't load TMDB details for Lost Boys: The Thirst, so it was not added."), env.banner());
});
test('Pull collection Apply: every lookup fails → nothing written, no "Saved", clear error, preview kept', async () => {
  const env = pullEnv(() => down());
  await env.ctx.addPulledCollectionMovies();
  assert.strictEqual(env.log.posts.length, 0);
  assert.strictEqual(env.log.saved, 0);
  assert.strictEqual(env.log.cancelled, 0);
  assert.ok(env.banner().includes("Couldn't load TMDB details for any of the 2 selected films, so nothing was added."), env.banner());
});
test('Pull collection Apply: all lookups succeed → both inserted, no warning (unchanged path)', async () => {
  const env = pullEnv(p => movieDetails(+p.split('/')[2]));
  await env.ctx.addPulledCollectionMovies();
  assert.strictEqual(env.log.posts[0].body.length, 2);
  assert.strictEqual(env.log.saved, 1);
  assert.strictEqual(env.banner(), '');
});
test('Refresh collections Apply: 1 of 2 fails → 1 inserted + warning', async () => {
  const env = makeEnv({ rows: [], tmdb: p => p === '/movie/2' ? fail(500) : movieDetails(1),
    checkboxes: [cb({ collectionIdx: '0', movieId: '1' }), cb({ collectionIdx: '0', movieId: '2' })] });
  env.ctx.__refreshCollectionsData = [{ collectionId: 5, collectionName: 'X Collection', newOnes: [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }] }];
  await env.ctx.addRefreshedCollectionMovies();
  assert.deepStrictEqual(env.log.posts[0].body.map(r => r.title), ['One']);
  assert.ok(env.banner().includes('Added 1 of 2 selected films') && env.banner().includes('Two'), env.banner());
});
test('Universe Apply: every lookup fails → nothing written, clear error', async () => {
  const env = makeEnv({ rows: [], tmdb: () => fail(502),
    checkboxes: [cb({ tmdbId: '1', title: 'One' }), cb({ tmdbId: '2', title: 'Two' })] });
  env.ctx.__universePullKey = 'mcu';
  await env.ctx.addPulledUniverseMovies();
  assert.strictEqual(env.log.posts.length, 0);
  assert.strictEqual(env.log.saved, 0);
  assert.ok(env.banner().includes('nothing was added'), env.banner());
});
test('Person Apply: 1 of 2 fails → 1 inserted + warning', async () => {
  const env = makeEnv({ rows: [], tmdb: p => p === '/movie/2' ? down() : movieDetails(1),
    checkboxes: [cb({ tmdbId: '1', title: 'One' }), cb({ tmdbId: '2', title: 'Two' })] });
  env.ctx.__personPullName = 'Someone';
  await env.ctx.addPulledPersonMovies();
  assert.deepStrictEqual(env.log.posts[0].body.map(r => r.title), ['One']);
  assert.strictEqual(env.log.saved, 1);
  assert.ok(env.banner().includes("Added 1 of 2 selected films. Couldn't load TMDB details for Two"), env.banner());
});
test('Apply with nothing selected still just closes the preview (unchanged)', async () => {
  const env = makeEnv({ rows: [], tmdb: () => ({}), checkboxes: [] });
  env.ctx.__personPullName = 'Someone';
  await env.ctx.addPulledPersonMovies();
  assert.strictEqual(env.log.cancelled, 1);
  assert.strictEqual(env.banner(), '');
});

(async () => {
  let passed = 0;
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('PASS', t.name); }
    catch (e) { console.log('FAIL', t.name, '\n ', e.message); }
  }
  console.log(`${passed}/${tests.length} passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
