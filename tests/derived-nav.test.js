// Offline tests for how the derived TV views fit into the page: startup,
// navigation, the paginated cross-TV read, edits made from a view, and the
// capture-at-start guards on async flows that can finish after the user has
// switched tabs or views.
// Run from the repo root: node tests/derived-nav.test.js
// No network, no database (see tests/app-harness.js).
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('derived-nav');
const test = T.test;
const copyOut = v => JSON.parse(JSON.stringify(v));

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
let n = 0;
function tv(o = {}) {
  const num = o.season_number !== undefined ? o.season_number : 1;
  return {
    id: o.id || `r${String(++n).padStart(5, '0')}`,
    collection: 'othertv', title: 'Show', theme: 'HBO', status: 'confirmed', watched: false,
    media_type: 'tv', tmdb_id: 100, season_number: num, season: `Season ${num}`,
    display_date: 'Jan 1, 2020', date_sort: '2020-01-01', item_key: `show|season ${num}`, watch_with: [], collections: [],
    ...o
  };
}
const movie = o => tv({ collection: 'movies', media_type: 'movie', season: 'Film', season_number: null, theme: 'Drama', ...o });
const TV_IDS = ['disney', '90day', 'sheridan', 'othertv', 'truecrime'];
const isDerivedRead = r => r.method === 'GET' && r.url.includes('collection=in.(');
const tmdbMovie = p => {
  const m = /^\/movie\/(\d+)/.exec(p);
  return m ? { id: +m[1], title: `Film ${m[1]}`, genres: [{ name: 'Drama' }], release_date: '2001-01-01', production_companies: [] } : undefined;
};
async function openTab(app, id) { app.ctx.switchTab(id); await settle(); }
// Movies opens on All Movies (read-only); the legacy Movies tab is one click away.
async function openMovies(app) { app.ctx.switchMediaType('movie'); await settle(); app.ctx.switchTab('movies'); await settle(); }
// While a view is showing, nothing about a collection tab was redrawn over it.
function assertViewIntact(app, viewId = 'watching') {
  assert.strictEqual(app.get('activeViewId'), viewId);
  assert.strictEqual(app.get('activeTabId'), null);
  assert.strictEqual(app.el('filtersRow').dataset.tab, `view:${viewId}`);
  assert.ok(app.el('tableHead').innerHTML.includes(viewId === 'watching' ? 'Up next' : 'Premiere'));
  assert.strictEqual(app.el('errorBanner').innerHTML, '', 'no error shown');
}
const noNullCollection = app => app.writes().forEach(r => {
  (Array.isArray(r.body) ? r.body : []).forEach(b => assert.ok(b.collection, `${r.method} ${r.url} has collection ${b.collection}`));
});

// ─── Loading ──────────────────────────────────────────────────────────────────
test('startup: Currently Watching opens with one paginated GET of the TV collections, one of the shows, the personal-organization reads, and no writes', async () => {
  const app = await createApp({ rows: [tv({ status: 'watching' })] });
  assert.strictEqual(app.get('activeViewId'), 'watching');
  assert.strictEqual(app.get('activeTabId'), null);
  assert.strictEqual(app.writes().length, 0, 'no POST/PATCH/DELETE');
  const reads = app.requests.filter(isDerivedRead);
  assert.strictEqual(reads.length, 1);
  const showReads = app.requests.filter(r => r.url.includes('/rest/v1/tv_shows'));
  assert.strictEqual(showReads.length, 1);
  assert.strictEqual(showReads[0].headers['Prefer'], 'count=exact', 'shows are paginated and count-checked too');
  // Stage 3b-1: the Browse selector's collections and the watch-with choices load alongside, GET only.
  const orgReads = app.requests.filter(r => /\/rest\/v1\/(personal_collections|watch_with_choices)\?/.test(r.url));
  assert.deepStrictEqual(orgReads.map(r => r.headers['Prefer']), ['count=exact', 'count=exact']);
  assert.strictEqual(app.requests.length, 4, 'no per-tab loads, no seeding reads');
  const list = decodeURIComponent(reads[0].url.match(/collection=in\.\(([^)]*)\)/)[1]).split(',').map(x => x.replace(/"/g, ''));
  assert.deepStrictEqual(list, TV_IDS);
  assert.strictEqual(reads[0].headers['Prefer'], 'count=exact');
  assert.ok(app.el('tabBar').innerHTML.includes('class="tab active" onclick="switchView(\'watching\')"'));
  assert.strictEqual(Object.keys(app.get('tabData')).length, 0);
});

test('pagination: every page is fetched across several requests; films are filtered out', async () => {
  const rows = [];
  for (let i = 0; i < 1203; i++) rows.push(tv({ id: `p${String(i).padStart(5, '0')}`, tmdb_id: 1000 + i }));
  rows.push(tv({ id: 'film', collection: 'truecrime', media_type: 'movie', season: 'Film', season_number: null }));
  rows.push(movie({ id: 'mov' }));
  const app = await createApp({ rows });
  const reads = app.requests.filter(isDerivedRead);
  assert.deepStrictEqual(reads.map(r => r.headers.Range), ['0-499', '500-999', '1000-1499']);
  assert.strictEqual(app.get('derivedData.rows.length'), 1203);
  assert.strictEqual(app.get("derivedData.rows.some(r => r.id === 'film' || r.id === 'mov')"), false);
});

test('an exact-count mismatch fails with Retry instead of rendering an incomplete list', async () => {
  const app = await createApp({ rows: [tv({ status: 'watching' }), tv({ season_number: 2 })], countOverride: 3 });
  assert.strictEqual(app.get('derivedData'), null);
  assert.ok(app.el('tbody').innerHTML.includes('Failed to load') && app.el('tbody').innerHTML.includes('loadDerivedView()'));
  assert.ok(app.el('errorBanner').innerHTML.includes("Couldn't load every TV row"));
  assert.ok(!app.el('tbody').innerHTML.includes('derived-show-row'));
  assert.strictEqual(app.writes().length, 0);
});

test("backup's fetchAllRows(table) request is unchanged by the new filter parameter", async () => {
  const app = await createApp();
  await app.ctx.fetchAllRows('othertv_shows');
  const last = app.requests[app.requests.length - 1];
  assert.ok(last.url.endsWith('/rest/v1/othertv_shows?select=*&order=id.asc'), last.url);
});

test('no request ever uses watching/comingsoon/null as a collection', async () => {
  const app = await createApp({ rows: [tv({ status: 'watching' }), tv({ id: 'fut', season_number: 2, date_sort: day(10) })] });
  app.ctx.switchView('comingsoon'); await settle();
  await app.ctx.setStatus('fut', 'highpriority', null);
  await openTab(app, 'othertv');
  app.ctx.switchView('watching'); await settle();
  await openMovies(app);
  app.ctx.switchMediaType('tv'); await settle();
  for (const r of app.requests) {
    assert.ok(!/collection=(eq|in)\.[^&]*(watching|comingsoon|null|undefined)/.test(decodeURIComponent(r.url)), r.url);
    (Array.isArray(r.body) ? r.body : [r.body]).forEach(b => {
      if (b && 'collection' in b) assert.ok(TV_IDS.includes(b.collection) || b.collection === 'movies', JSON.stringify(b));
    });
  }
});

// ─── Navigation ───────────────────────────────────────────────────────────────
test('Movies → TV always lands on Currently Watching; Movies opens on All Movies and the legacy Movies tab loads as before', async () => {
  const app = await createApp({ rows: [movie({ id: 'm1' })] });
  await openTab(app, 'othertv');
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies');
  assert.strictEqual(app.get('activeTabId'), null);
  app.ctx.switchTab('movies'); await settle();
  assert.strictEqual(app.get('activeTabId'), 'movies');
  assert.strictEqual(app.get('activeViewId'), null);
  assert.ok(app.requests.some(r => r.method === 'GET' && r.url.includes('collection=eq.movies')));
  assert.ok(app.el('tbody').innerHTML.includes("toggleWatch('m1')"), 'movies table rendered');
  app.ctx.switchMediaType('tv'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'watching');
  assert.strictEqual(app.get('activeTabId'), null);
});

test('real collection tabs still load; opening a built-in tab only reads (Stage 4a) and says what the catalog would add', async () => {
  const app = await createApp();
  const defaults = app.get("COLLECTIONS.find(c => c.id === 'disney').defaults.length");
  await openTab(app, 'disney');
  assert.deepStrictEqual(app.writes(), [], 'opening Disney+ writes nothing');
  assert.ok(app.el('banner').innerHTML.includes(`${defaults} catalog entries are waiting`) && app.el('banner').innerHTML.includes("openCatalogUpdates('disney'"), app.el('banner').innerHTML);
  // After an explicit application every default lands once, TV seasons linked to a show, films unlinked, today's row statuses.
  await app.applyCatalog('disney');
  app.run('delete tabData.disney'); // applied outside the page: read the tab again
  app.ctx.switchTab('othertv'); await settle();
  await openTab(app, 'disney');
  assert.strictEqual(app.el('banner').innerHTML, '', 'nothing waiting once applied');
  const seeded = app.store.watchlist_items.filter(r => r.collection === 'disney');
  assert.strictEqual(seeded.length, defaults);
  assert.strictEqual(app.get('tabData.disney.rows.length'), defaults);
  assert.ok(seeded.every(r => (r.season === 'Film') === (r.show_id == null)));
  const byKey = new Map(app.get("COLLECTIONS.find(c => c.id === 'disney').defaults").map(d => [d.k, d]));
  assert.ok(seeded.every(r => r.status === (byKey.get(r.item_key).p ? 'pending' : 'confirmed')));
  assert.strictEqual(app.get('activeViewId'), null);
  assert.ok(!app.el('tabBar').innerHTML.includes('switchTab('), 'storage tabs are internal since Stage 4b (no tab bar entry)');
  assert.ok(app.el('tableHead').innerHTML.includes('Show &amp; Season'));
  await openTab(app, 'othertv');
  assert.strictEqual(app.el('tmdbPanel').style.display, 'block', 'TMDB panel back on dynamic tabs');
});

test('a late derived-view response never redraws after leaving the view', async () => {
  const app = await createApp({ rows: [tv({ status: 'watching' })] });
  const g = app.hold(isDerivedRead);
  app.ctx.switchView('comingsoon');
  await g.reached;
  await openTab(app, 'othertv');
  g.release(); await settle();
  assert.strictEqual(app.get('activeTabId'), 'othertv');
  assert.strictEqual(app.el('filtersRow').dataset.tab, 'othertv');
  assert.ok(app.el('tableHead').innerHTML.includes('Show &amp; Season'));
  // A superseded load (Coming Soon → Currently Watching) is ignored too.
  const g2 = app.hold(isDerivedRead);
  app.ctx.switchView('comingsoon');
  await g2.reached;
  app.ctx.switchView('watching'); await settle();
  g2.release(); await settle();
  assertViewIntact(app, 'watching');
});

test('a late loadTab response never paints over a view', async () => {
  const app = await createApp({ rows: [tv({ status: 'watching' })] });
  const g = app.hold(r => r.method === 'GET' && r.url.includes('collection=eq.othertv'));
  app.ctx.switchTab('othertv');
  await g.reached;
  app.ctx.switchView('watching'); await settle();
  g.release(); await settle();
  assertViewIntact(app);
  assert.strictEqual(app.get('tabData.othertv.loaded'), true, 'the tab data is still cached');
});

test('restore reload re-reads the active view (no loadTab(null))', async () => {
  const app = await createApp({ rows: [tv({ status: 'watching' })] });
  const before = app.requests.length;
  app.ctx.finishRestoreAndReload(); await settle();
  const after = app.requests.slice(before);
  // Stage 3b-1: the restored collections and watch-with choices are read again too (GET only).
  assert.deepStrictEqual(after.map(r => new URL(r.url).pathname.split('/').pop()).sort(),
    ['personal_collections', 'tv_shows', 'watch_with_choices', 'watchlist_items'], 'the TV rows, the shows and the organization');
  assert.ok(after.every(r => r.method === 'GET'));
  assert.ok(after.some(isDerivedRead) && after.some(r => r.url.includes('/rest/v1/tv_shows')));
  assertViewIntact(app);
});

// ─── Edits from a derived view ────────────────────────────────────────────────
async function watchingApp() {
  const rows = [
    tv({ id: 'w1', season_number: 1, status: 'watching', date_sort: '2020-01-01' }),
    tv({ id: 'w2', season_number: 2, status: 'watching', date_sort: '2021-01-01' }),
    tv({ id: 'c1', title: 'Later', tmdb_id: 200, season_number: 1, date_sort: day(10) }),
  ];
  const app = await createApp({ rows });
  await openTab(app, 'othertv'); // leaves a separate cached copy of the rows in tabData
  app.ctx.switchView('watching'); await settle();
  return app;
}
const rowIn = (app, where, id) => app.get(`(${where}).find(r => r.id === '${id}')`);

test('Watched from Currently Watching goes through set_season_watched by the real row id, mirrors the tab cache, re-derives', async () => {
  const app = await watchingApp();
  const before = app.writes().length;
  await app.ctx.toggleWatch('w1');
  const w = app.writes().slice(before);
  assert.strictEqual(w.length, 1);
  assert.ok(w[0].url.endsWith('/rpc/set_season_watched'), w[0].url);
  assert.deepStrictEqual(w[0].body, { p_row_id: 'w1', p_watched: true });
  assert.strictEqual(rowIn(app, 'derivedData.rows', 'w1').watched, true);
  assert.strictEqual(rowIn(app, 'tabData.othertv.rows', 'w1').watched, true, 'source tab cache kept in sync');
  assert.notStrictEqual(rowIn(app, 'derivedData.rows', 'w1'), rowIn(app, 'tabData.othertv.rows', 'w1'), 'separate copies');
  const html = app.el('tbody').innerHTML;
  assert.ok(html.includes("toggleWatch('w2')") && !html.includes("toggleWatch('w1')"), 'up next advanced to S2');
});

test('a failed Watched write rolls back the local change and mirrors nothing', async () => {
  const app = await watchingApp();
  app.failNext(r => r.url.endsWith('/rpc/set_season_watched'));
  await app.ctx.toggleWatch('w1');
  assert.strictEqual(rowIn(app, 'derivedData.rows', 'w1').watched, false);
  assert.strictEqual(rowIn(app, 'tabData.othertv.rows', 'w1').watched, false);
  assert.ok(app.el('errorBanner').innerHTML.includes('Supabase error 500'));
  assert.ok(app.el('tbody').innerHTML.includes("toggleWatch('w1')"), 'still up next');
});

test('show status from a view: Watching → Complete removes the show; Skip in Coming Soon mirrors to the tab cache', async () => {
  const app = await watchingApp();
  const showId = rowIn(app, 'derivedData.rows', 'w1').show_id;
  assert.ok(app.el('tbody').innerHTML.includes("toggleWatch('w1')"));
  await app.ctx.setShowStatusById(showId, 'complete');
  assert.ok(!app.el('tbody').innerHTML.includes('derived-show-row'), 'the show is no longer Watching');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === showId).status, 'complete');
  assert.ok(!app.writes().some(r => r.method === 'PATCH'), 'no season status PATCH');
  app.ctx.switchView('comingsoon'); await settle();
  await app.ctx.setSeasonSkipped('c1', true);
  const last = app.writes().pop();
  assert.ok(last.url.endsWith('/rpc/set_season_skipped'));
  assert.deepStrictEqual(last.body, { p_row_id: 'c1', p_skipped: true });
  assert.strictEqual(rowIn(app, 'tabData.othertv.rows', 'c1').skipped, true, 'source tab cache kept in sync');
});

// ─── Async flows that can finish after a navigation (capture-at-start guards) ─
// Each starts on a real tab, pauses at an await, switches into a view (or another
// tab), then resumes. Writes must use the captured collection, the tab cache must
// be updated, nothing may be redrawn over the view, and no error may surface.

test('guard: addRefreshedSeasons → view mid-POST: inserts into othertv, still runs its date PATCH', async () => {
  const app = await createApp({ rows: [tv({ id: 'ex1', display_date: 'TBA', date_sort: '2099-01-01' })] });
  await openTab(app, 'othertv');
  app.run(`window.__refreshData = [{ show: { title: 'Show', tmdb_id: 100 }, details: { networks: [{ name: 'HBO' }] }, newOnes: [{ season_number: 2, air_date: '2027-01-01' }] }];
    window.__refreshDateUpdates = [{ row: tabData.othertv.rows[0], update: { display_date: 'Jan 5, 2027', date_sort: '2027-01-05' } }];`);
  app.selectors['#tmdbPreview input[type="checkbox"][data-show-idx]'] = [{ checked: true, dataset: { showIdx: '0', season: '2' } }];
  app.selectors['#tmdbPreview input[type="checkbox"][data-update-idx]'] = [{ checked: true, dataset: { updateIdx: '0' } }];
  const g = app.hold(r => r.method === 'POST');
  const done = app.ctx.addRefreshedSeasons();
  await g.reached;
  app.ctx.switchView('watching'); await settle();
  g.release(); await done; await settle();
  const post = app.writes().find(r => r.method === 'POST');
  assert.ok(post.url.endsWith('/rpc/add_tv_seasons'));
  assert.strictEqual(post.body.p_collection, 'othertv');
  assert.ok(app.writes().some(r => r.method === 'PATCH' && r.url.includes('id=eq.ex1') && r.body.date_sort === '2027-01-05'), 'date PATCH not skipped');
  assert.strictEqual(app.get('tabData.othertv.rows.length'), 2);
  assertViewIntact(app);
});

test('guard: addRefreshedSeasons → another tab mid-POST: no rows land in the other tab', async () => {
  const app = await createApp({ rows: [tv({ id: 'ex1' })] });
  await openTab(app, 'truecrime');
  await openTab(app, 'othertv');
  app.run(`window.__refreshData = [{ show: { title: 'Show', tmdb_id: 100 }, details: { networks: [] }, newOnes: [{ season_number: 2, air_date: '2027-01-01' }] }]; window.__refreshDateUpdates = [];`);
  app.selectors['#tmdbPreview input[type="checkbox"][data-show-idx]'] = [{ checked: true, dataset: { showIdx: '0', season: '2' } }];
  const g = app.hold(r => r.method === 'POST');
  const done = app.ctx.addRefreshedSeasons();
  await g.reached;
  await openTab(app, 'truecrime');
  g.release(); await done; await settle();
  assert.strictEqual(app.get('tabData.truecrime.rows.length'), 0);
  assert.strictEqual(app.get('tabData.othertv.rows.length'), 2);
  assert.strictEqual(app.el('filtersRow').dataset.tab, 'truecrime');
});

test('guard: addSelectedTMDBSeasons → view mid-POST: inserts and registers the show for othertv', async () => {
  const app = await createApp();
  await openTab(app, 'othertv');
  app.run(`tmdbSelectedShow = { id: 55, name: 'New Show', mediaType: 'tv', details: { networks: [{ name: 'HBO' }], seasons: [{ season_number: 1, air_date: '2026-01-01' }] } };`);
  const prev = app.addEl('tmdbInlinePreview');
  prev.querySelectorAll = sel => (sel === 'input[type="checkbox"][data-season]' ? [{ checked: true, disabled: false, dataset: { season: '1' } }] : []);
  const g = app.hold(r => r.method === 'POST' && r.url.endsWith('/rpc/add_tv_seasons'));
  const done = app.ctx.addSelectedTMDBSeasons();
  await g.reached;
  app.ctx.switchView('watching'); await settle(); // clears tmdbSelectedShow
  g.release(); await done; await settle();
  const posts = app.writes().filter(r => r.method === 'POST');
  assert.strictEqual(posts.length, 1, 'one add_tv_seasons call; the function registers the show itself');
  assert.strictEqual(posts[0].body.p_collection, 'othertv');
  assert.deepStrictEqual(copyOut(posts[0].body.p_show), { tmdb_id: 55, title: 'New Show', show_key: 'new show', network: 'HBO' });
  assert.ok(app.store.tv_shows.some(s => s.tmdb_id === 55 && s.collection === 'othertv'), 'an identified show, which Refresh shows checks');
  assert.deepStrictEqual(app.store.othertv_shows, [], 'the old tracking table is no longer written (stage final)');
  assert.strictEqual(app.get('tabData.othertv.rows.length'), 1);
  assert.ok(app.get('tabData.othertv.rows[0].show_id'), 'the new season is linked to its show');
  assertViewIntact(app);
});

for (const [name, setup, selector, box] of [
  ['addPulledCollectionMovies',
    `window.__pullCollectionData = { collectionId: 10, collectionName: 'X', tmdbCollectionName: 'X Collection', movies: [{ id: 101, title: 'Film A' }] };`,
    '#tmdbPreview input[type="checkbox"][data-movie-id]', { checked: true, disabled: false, dataset: { movieId: '101' } }],
  ['addRefreshedCollectionMovies',
    `window.__refreshCollectionsData = [{ collectionId: 10, collectionName: 'X Collection', newOnes: [{ id: 101, title: 'Film A' }] }];`,
    '#tmdbPreview input[type="checkbox"][data-collection-idx]', { checked: true, dataset: { collectionIdx: '0', movieId: '101' } }],
  ['addPulledUniverseMovies',
    `window.__universePullKey = 'mcu';`,
    '#tmdbPreview input[type="checkbox"][data-tmdb-id]', { checked: true, disabled: false, dataset: { tmdbId: '101', title: 'Film A' } }],
  ['addPulledPersonMovies',
    `window.__personPullName = 'Some Director';`,
    '#tmdbPreview input[type="checkbox"][data-tmdb-id]', { checked: true, disabled: false, dataset: { tmdbId: '101', title: 'Film A' } }],
]) {
  test(`guard: ${name} → Currently Watching during the TMDB lookups: inserts into movies`, async () => {
    const app = await createApp({ tmdb: tmdbMovie });
    await openMovies(app);
    app.run(setup);
    app.selectors[selector] = [box];
    const g = app.hold(r => r.url.includes('/movie/101'));
    const done = app.ctx[name]();
    await g.reached;
    app.ctx.switchMediaType('tv'); await settle();
    g.release(); await done; await settle();
    const post = app.writes().find(r => r.method === 'POST');
    assert.ok(post, 'the insert still happens');
    assert.strictEqual(post.body[0].collection, 'movies');
    assert.strictEqual(app.get('tabData.movies.rows.length'), 1);
    noNullCollection(app);
    assertViewIntact(app);
  });
}

test('guard: confirmTmdbMatch → view mid-match: row matched in place, show tracked, no redraw', async () => {
  const app = await createApp({ rows: [tv({ id: 'u1', title: 'Manual', media_type: null, tmdb_id: null, season_number: null, item_key: 'manual|season 1' })] });
  await openTab(app, 'othertv');
  app.run(`window.__tmdbMatch = { rowId: 'u1', results: [], target: { mediaType: 'tv', seasonNumber: 1, details: { id: 77, name: 'Matched Show', networks: [{ name: 'HBO' }], seasons: [{ season_number: 1, air_date: '2020-01-01' }] } } };`);
  const g = app.hold(r => r.method === 'POST' && r.url.endsWith('/rpc/match_tv_row'));
  const done = app.ctx.confirmTmdbMatch();
  await g.reached;
  app.ctx.switchView('watching'); await settle();
  g.release(); await done; await settle();
  assert.deepStrictEqual(app.writes().map(r => r.url.split('/rest/v1/')[1]), ['rpc/match_tv_row'], 'one function call, no direct writes');
  assert.strictEqual(app.writes()[0].body.p_row_id, 'u1');
  assert.strictEqual(rowIn(app, 'tabData.othertv.rows', 'u1').tmdb_id, 77);
  assert.ok(rowIn(app, 'tabData.othertv.rows', 'u1').show_id, 'linked to the identified show');
  assert.ok(app.store.tv_shows.some(s => s.tmdb_id === 77 && s.collection === 'othertv'), 'an identified show, which Refresh shows checks');
  assert.strictEqual(app.get('window.__tmdbMatch'), null);
  assertViewIntact(app);
});

test('guard: addEntry → view mid-POST: inserts into othertv without touching the gone add form', async () => {
  const app = await createApp();
  await openTab(app, 'othertv');
  app.el('nTitle').value = 'ZZ Manual Show';
  app.el('nSeason').value = 'Season 1';
  app.el('nTheme').value = 'HBO';
  app.el('nDate').value = 'Jan 1, 2027';
  const g = app.hold(r => r.method === 'POST');
  const done = app.ctx.addEntry();
  await g.reached;
  app.ctx.switchView('watching'); await settle(); // the view's filter row replaces #addToggleBtn
  assert.strictEqual(app.el('addToggleBtn'), null);
  g.release(); await done; await settle();
  const post = app.writes().find(r => r.method === 'POST');
  assert.ok(post.url.endsWith('/rpc/add_tv_seasons'));
  assert.strictEqual(post.body.p_collection, 'othertv');
  assert.strictEqual(app.get('tabData.othertv.rows.length'), 1);
  assertViewIntact(app);
});

test('guard: pullPersonFilmography → view mid-backfill: tag saved, no preview written elsewhere', async () => {
  const app = await createApp({ rows: [movie({ id: 'm1', tmdb_id: 201, title: 'Old Film', item_key: 'old film|film' })] });
  await openMovies(app);
  const previewEl = app.el('tmdbPreview');
  const g = app.hold(r => r.method === 'PATCH');
  const done = app.ctx.pullPersonFilmography(1, 'Some Director', false, 'director',
    { crew: [{ job: 'Director', id: 201, title: 'Old Film', release_date: '2000-01-01' }], cast: [] });
  await g.reached;
  app.ctx.switchMediaType('tv'); await settle();
  g.release(); await done; await settle();
  const patch = app.writes().find(r => r.method === 'PATCH');
  assert.ok(patch.url.includes('id=eq.m1'));
  assert.deepStrictEqual(patch.body, { collections: ['Some Director'] });
  assert.ok(!previewEl.innerHTML.includes('Failed to load filmography'), previewEl.innerHTML);
  assertViewIntact(app);
});

test('guard: a flow started while a view is open does nothing (no collection to write to)', async () => {
  const app = await createApp();
  app.run(`window.__pullCollectionData = { collectionId: 10, collectionName: 'X', tmdbCollectionName: 'X Collection', movies: [{ id: 101, title: 'Film A' }] }; window.__personPullName = 'P'; window.__universePullKey = 'mcu';`);
  app.selectors['#tmdbPreview input[type="checkbox"][data-movie-id]'] = [{ checked: true, dataset: { movieId: '101' } }];
  for (const fn of ['addRefreshedSeasons', 'addPulledCollectionMovies', 'addRefreshedCollectionMovies', 'addPulledUniverseMovies', 'addPulledPersonMovies', 'addEntry']) {
    await app.ctx[fn]();
  }
  await app.ctx.pullPersonFilmography(1, 'P', false, 'director', { crew: [], cast: [] });
  assert.strictEqual(app.writes().length, 0);
  assertViewIntact(app);
});

T.run();
