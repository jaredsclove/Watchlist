// Offline tests for how the derived TV views fit into the page: startup,
// navigation, the paginated TV read, edits made from a view, and the guards on
// async flows that can finish after the user has switched views. Since Stage 5
// there are no storage tabs; the flows start from a view's "+ Add" panel.
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
const isDerivedRead = r => r.method === 'GET' && r.url.includes('is_film=eq.false');
const tmdbMovie = p => {
  const m = /^\/movie\/(\d+)/.exec(p);
  return m ? { id: +m[1], title: `Film ${m[1]}`, genres: [{ name: 'Drama' }], release_date: '2001-01-01', production_companies: [] } : undefined;
};
// Movies opens on All Movies; its "+ Add" panel runs the movie tools on a complete library read.
async function openMovieTools(app) {
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openLibraryPanel('movie', 'tools'); await settle();
  assert.strictEqual(await app.ctx.libraryPrepareMovieTools(), true);
  await settle();
}
// While a view is showing, nothing about a collection tab was redrawn over it.
function assertViewIntact(app, viewId = 'watching') {
  assert.strictEqual(app.get('activeViewId'), viewId);
  assert.strictEqual(app.get('typeof activeTabId'), 'undefined', 'no storage tab state (Stage 5)');
  assert.strictEqual(app.el('filtersRow').dataset.tab, `view:${viewId}`);
  assert.ok(app.el('tableHead').innerHTML.includes(viewId === 'watching' ? 'Up next' : 'Premiere'));
  assert.strictEqual(app.el('errorBanner').innerHTML, '', 'no error shown');
}
const noStorage = app => assert.deepStrictEqual(app.storageRequests().map(r => r.url), [], 'no request names a storage value');

// ─── Loading ──────────────────────────────────────────────────────────────────
test('startup: Currently Watching opens with one paginated GET of the TV rows, one of the shows, the governance and personal-organization reads, and no writes', async () => {
  const app = await createApp({ rows: [tv({ status: 'watching' })] });
  assert.strictEqual(app.get('activeViewId'), 'watching');
  assert.strictEqual(app.get('typeof activeTabId'), 'undefined', 'no storage tab state (Stage 5)');
  assert.strictEqual(app.writes().length, 0, 'no POST/PATCH/DELETE');
  const reads = app.requests.filter(isDerivedRead);
  assert.strictEqual(reads.length, 1);
  const showReads = app.requests.filter(r => r.url.includes('/rest/v1/tv_shows'));
  assert.strictEqual(showReads.length, 1);
  assert.strictEqual(showReads[0].headers['Prefer'], 'count=exact', 'shows are paginated and count-checked too');
  // Stage 3b-1: the Browse selector's collections and the watch-with choices load alongside, GET only.
  const orgReads = app.requests.filter(r => /\/rest\/v1\/(personal_collections|watch_with_choices|library_collection_catalogs|library_collection_presentation)\?/.test(r.url));
  assert.deepStrictEqual(orgReads.map(r => r.headers['Prefer']), ['count=exact', 'count=exact', 'count=exact', 'count=exact']);
  // Stage 5: catalog governance (three read views) and the database's phase.
  const govReads = app.requests.filter(r => /\/rest\/v1\/library_(catalog_shows|catalog_films|film_theme_kinds)\?/.test(r.url));
  assert.strictEqual(govReads.length, 3);
  assert.ok(app.requests.some(r => r.method === 'GET' && r.url.endsWith('/rpc/stage5_capabilities')));
  // EP1: the owner's episode marks are read with the rows.
  assert.strictEqual(app.requests.filter(r => /\/rest\/v1\/episode_marks\?/.test(r.url)).length, 1);
  // Item 4: the per-show update settings (the "New season" flag) are read with the rows.
  assert.strictEqual(app.requests.filter(r => /\/rest\/v1\/show_update_settings\?/.test(r.url)).length, 1);
  assert.strictEqual(app.requests.length, 12, 'no per-storage loads, no seeding reads');
  assert.ok(reads[0].url.includes('is_film=eq.false') && !reads[0].url.includes('collection='), 'TV rows by kind, never by storage');
  assert.strictEqual(reads[0].headers['Prefer'], 'count=exact');
  noStorage(app);
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
  await app.ctx.fetchAllRows('tv_shows');
  const last = app.requests[app.requests.length - 1];
  assert.ok(last.url.endsWith('/rest/v1/tv_shows?select=*&order=id.asc'), last.url);
});

test('no request ever names a view or a storage value (Stage 5)', async () => {
  const app = await createApp({ rows: [tv({ status: 'watching' }), tv({ id: 'fut', season_number: 2, date_sort: day(10) })] });
  app.ctx.switchView('comingsoon'); await settle();
  await app.ctx.setStatus('fut', 'highpriority', null);
  app.ctx.switchView('alltv'); await settle();
  app.ctx.switchView('watching'); await settle();
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.switchMediaType('tv'); await settle();
  for (const r of app.requests) assert.ok(!/(watching|comingsoon|alltv|allmovies)/.test(decodeURIComponent(r.url.split('?')[1] || '')), r.url);
  noStorage(app);
});

// ─── Navigation ───────────────────────────────────────────────────────────────
test('Movies → TV always lands on Currently Watching; Movies opens on All Movies, which lists every film with its actions (no storage tabs since Stage 5)', async () => {
  const app = await createApp({ rows: [movie({ id: 'm1' })] });
  app.ctx.switchView('alltv'); await settle();
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies');
  assert.strictEqual(app.get('typeof activeTabId'), 'undefined', 'no storage tab state (Stage 5)');
  assert.strictEqual(app.get('typeof switchTab'), 'undefined');
  assert.ok(app.el('tbody').innerHTML.includes("toggleWatch('m1')"), 'All Movies lists the film with its controls');
  app.ctx.switchMediaType('tv'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'watching');
  assert.strictEqual(app.get('typeof activeTabId'), 'undefined', 'no storage tab state (Stage 5)');
});

test('a late derived-view response never redraws after leaving the view', async () => {
  const app = await createApp({ rows: [tv({ status: 'watching' })] });
  const g = app.hold(isDerivedRead);
  app.ctx.switchView('comingsoon');
  await g.reached;
  app.ctx.switchMediaType('movie'); await settle();
  g.release(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies');
  assert.ok(!app.el('tbody').innerHTML.includes('derived-show-row'), 'Coming Soon never drew over All Movies');
  // A superseded load (Coming Soon → Currently Watching) is ignored too.
  const g2 = app.hold(isDerivedRead);
  app.ctx.switchView('comingsoon');
  await g2.reached;
  app.ctx.switchView('watching'); await settle();
  g2.release(); await settle();
  assertViewIntact(app, 'watching');
});

test('a late All Movies response never paints over a derived view', async () => {
  const app = await createApp({ rows: [tv({ status: 'watching' }), movie({ id: 'm1' })] });
  const g = app.hold(r => r.method === 'GET' && r.url.includes('/rest/v1/watchlist_items?') && !r.url.includes('is_film='));
  app.ctx.switchMediaType('movie');
  await g.reached;
  app.ctx.switchMediaType('tv'); await settle();
  g.release(); await settle();
  assertViewIntact(app);
  assert.ok(!app.el('tbody').innerHTML.includes("toggleWatch('m1')"));
});

test('restore reload re-reads the active view (no loadTab(null))', async () => {
  const app = await createApp({ rows: [tv({ status: 'watching' })] });
  const before = app.requests.length;
  app.ctx.finishRestoreAndReload(); await settle();
  const after = app.requests.slice(before);
  // Stage 3b-1: the restored collections and watch-with choices are read again too (GET only).
  assert.deepStrictEqual(after.map(r => new URL(r.url).pathname.split('/').pop()).sort(),
    ['episode_marks', 'library_catalog_films', 'library_catalog_shows', 'library_collection_catalogs', 'library_collection_presentation', 'library_film_theme_kinds', 'personal_collections', 'show_update_settings', 'tv_shows', 'watch_with_choices', 'watchlist_items'],
    'the TV rows, the shows, the episode marks (EP1), the show settings (item 4), the governance and the organization');
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
  app.ctx.switchView('watching'); await settle();
  return app;
}
const rowIn = (app, where, id) => app.get(`(${where}).find(r => r.id === '${id}')`);

test('Watched from Currently Watching goes through set_season_watched by the real row id, mirrors the view’s rows, re-derives', async () => {
  const app = await watchingApp();
  const before = app.writes().length;
  await app.ctx.toggleWatch('w1');
  const w = app.writes().slice(before);
  assert.strictEqual(w.length, 1);
  assert.ok(w[0].url.endsWith('/rpc/set_season_watched'), w[0].url);
  assert.deepStrictEqual(w[0].body, { p_row_id: 'w1', p_watched: true });
  assert.strictEqual(rowIn(app, 'derivedData.rows', 'w1').watched, true);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === 'w1').watched, true, 'saved');
  const html = app.el('tbody').innerHTML;
  assert.ok(html.includes("toggleWatch('w2')") && !html.includes("toggleWatch('w1')"), 'up next advanced to S2');
});

test('a failed Watched write rolls back the local change and mirrors nothing', async () => {
  const app = await watchingApp();
  app.refuseNext(r => r.url.endsWith('/rpc/set_season_watched'), 'P0002', 'not_found: TV season'); // S3-D2 B: a refusal (an unclear answer now reads the view again)
  await app.ctx.toggleWatch('w1');
  assert.strictEqual(rowIn(app, 'derivedData.rows', 'w1').watched, false);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === 'w1').watched, false);
  assert.ok(app.el('errorBanner').innerHTML.includes('Supabase error 400'));
  assert.ok(app.el('tbody').innerHTML.includes("toggleWatch('w1')"), 'still up next');
});

test('show status from a view: Watching → To Watch removes the show; Skip in Coming Soon is saved by row id', async () => {
  const app = await watchingApp();
  const showId = rowIn(app, 'derivedData.rows', 'w1').show_id;
  assert.ok(app.el('tbody').innerHTML.includes("toggleWatch('w1')"));
  await app.ctx.setShowStateById(showId, { status: 'confirmed' });
  assert.ok(!app.el('tbody').innerHTML.includes('derived-show-row'), 'the show is no longer Watching');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === showId).status, 'confirmed');
  assert.ok(!app.writes().some(r => r.method === 'PATCH'), 'no season status PATCH');
  app.ctx.switchView('comingsoon'); await settle();
  await app.ctx.setSeasonSkipped('c1', true);
  const last = app.writes().pop();
  assert.ok(last.url.endsWith('/rpc/set_season_skipped'));
  assert.deepStrictEqual(last.body, { p_row_id: 'c1', p_skipped: true });
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === 'c1').skipped, true, 'saved');
});

// ─── Async flows that can finish after a navigation ───────────────────────────
// Each starts in a view (its "+ Add" panel), pauses at an await, switches to another
// view, then resumes. The write still goes to the intended record by id, through a
// library function, with no storage value; nothing is redrawn over the new view.

const tmdbTv = p => {
  const m = /^\/tv\/(\d+)/.exec(p);
  return m ? { id: +m[1], name: 'New Show', networks: [{ name: 'HBO' }], seasons: [{ season_number: 1, air_date: '2026-01-01', episode_count: 8 }, { season_number: 2, air_date: '2027-01-01', episode_count: 8 }] } : undefined;
};

test('guard: a TMDB search add → another view mid-call: one library_create_show_b45 call, the new show and its seasons, nothing redrawn', async () => {
  const app = await createApp({ tmdb: tmdbTv });
  app.ctx.switchView('alltv'); await settle();
  app.ctx.openLibraryPanel('tv'); await settle();
  app.run(`tmdbSelectedShow = { id: 55, name: 'New Show', mediaType: 'tv', details: { networks: [{ name: 'HBO' }], seasons: [{ season_number: 1, air_date: '2026-01-01' }] } };`);
  app.ctx.renderTMDBPreview();
  const prev = app.addEl('tmdbInlinePreview');
  prev.querySelectorAll = sel => (sel === 'input[type="checkbox"][data-season]' ? [{ checked: true, disabled: false, dataset: { season: '1' } }] : []);
  const g = app.hold(r => r.method === 'POST' && r.url.endsWith('/rpc/library_create_show_b45'));
  const done = app.ctx.addSelectedTMDBSeasons();
  await g.reached;
  app.ctx.switchView('watching'); await settle();
  g.release(); await done; await settle();
  const posts = app.writes();
  assert.deepStrictEqual(posts.map(r => r.url.split('/rest/v1/')[1]), ['rpc/library_create_show_b45']);
  // (network: the seasons' label, as before; B4: TMDB networks become candidates — Original network is never set automatically.)
  assert.deepStrictEqual(copyOut(posts[0].body.p_show), { tmdb_id: 55, title: 'New Show', show_key: 'new show', network: 'HBO',
    genres: [], forms: [], genre_candidates: [], companies: [], network_candidates: ['HBO'] });
  const show = app.store.tv_shows.find(sh => sh.tmdb_id === 55);
  assert.ok(show && app.store.watchlist_items.some(r => r.show_id === show.id && r.season_number === 1));
  noStorage(app);
  assertViewIntact(app);
});

test('guard: Match from All TV → another view mid-match: one library_match_season_b45 call by row id, row matched in place, no redraw', async () => {
  const app = await createApp({ rows: [tv({ id: 'u1', title: 'Manual', media_type: null, tmdb_id: null, season_number: null, item_key: 'manual|season 1' })] });
  app.ctx.switchView('alltv'); await settle();
  app.run(`window.__tmdbMatch = { rowId: 'u1', results: [], target: { mediaType: 'tv', seasonNumber: 1, details: { id: 77, name: 'Matched Show', networks: [{ name: 'HBO' }], seasons: [{ season_number: 1, air_date: '2020-01-01' }] } } };`);
  const g = app.hold(r => r.method === 'POST' && r.url.endsWith('/rpc/library_match_season_b45'));
  const done = app.ctx.confirmTmdbMatch();
  await g.reached;
  app.ctx.switchView('watching'); await settle();
  g.release(); await done; await settle();
  assert.deepStrictEqual(app.writes().map(r => r.url.split('/rest/v1/')[1]), ['rpc/library_match_season_b45'], 'one function call, no direct writes');
  assert.strictEqual(app.writes()[0].body.p_row_id, 'u1');
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === 'u1').tmdb_id, 77);
  assert.ok(app.store.tv_shows.some(s => s.tmdb_id === 77), 'an identified show, which Refresh shows checks');
  assert.strictEqual(app.get('window.__tmdbMatch'), null);
  noStorage(app);
  assertViewIntact(app);
});

test('guard: a new show by hand → another view mid-call: library_create_show_b45 (distinct_from: none shown), nothing redrawn', async () => {
  const app = await createApp();
  app.ctx.switchView('alltv'); await settle();
  app.ctx.openLibraryPanel('tv', 'manual'); await settle();
  app.el('nTitle').value = 'ZZ Manual Show'; app.el('nSeason').value = 'Season 1'; app.el('nTheme').value = 'HBO'; app.el('nDate').value = 'Jan 1, 2027';
  const g = app.hold(r => r.method === 'POST' && r.url.endsWith('/rpc/library_create_show_b45'));
  const done = app.ctx.libraryManualShow();
  await g.reached;
  app.ctx.switchView('watching'); await settle();
  g.release(); await done; await settle();
  const post = app.writes().find(r => r.url.endsWith('/rpc/library_create_show_b45'));
  assert.deepStrictEqual(copyOut(post.body.p_show), { tmdb_id: null, title: 'ZZ Manual Show', show_key: 'zz manual show', network: 'HBO', distinct_from: [] });
  assert.ok(app.store.tv_shows.some(sh => sh.show_key === 'zz manual show'));
  noStorage(app);
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
  test(`guard: ${name} from All Movies' panel → Currently Watching during the TMDB lookups: the film is added (library_add_films, genre theme)`, async () => {
    const app = await createApp({ tmdb: tmdbMovie });
    await openMovieTools(app);
    app.run(setup);
    app.selectors[selector] = [box];
    const g = app.hold(r => r.url.includes('/movie/101'));
    const done = app.ctx[name]();
    await g.reached;
    app.ctx.switchMediaType('tv'); await settle();
    g.release(); await done; await settle();
    const post = app.writes().find(r => r.url.endsWith('/rpc/library_add_films_b45'));
    assert.ok(post, 'the insert still happens');
    assert.strictEqual(post.body.p_films[0].tmdb_id, 101);
    assert.strictEqual(post.body.p_films[0].theme, 'Drama', 'a genre theme');
    assert.ok(app.store.watchlist_items.some(r => r.tmdb_id === 101 && r.media_type === 'movie'));
    noStorage(app);
    assertViewIntact(app);
  });
}

test('guard: pullPersonFilmography from All Movies → another view mid-backfill: the tag is saved on a film whose theme is a genre, no preview written elsewhere', async () => {
  const app = await createApp({ rows: [movie({ id: 'm1', tmdb_id: 201, title: 'Old Film', item_key: 'old film|film' })] });
  await openMovieTools(app);
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
  noStorage(app);
  assertViewIntact(app);
});

test('guard: a movie tool without All Movies’ prepared panel does nothing', async () => {
  const app = await createApp();
  app.run(`window.__pullCollectionData = { collectionId: 10, collectionName: 'X', tmdbCollectionName: 'X Collection', movies: [{ id: 101, title: 'Film A' }] }; window.__personPullName = 'P'; window.__universePullKey = 'mcu';`);
  app.selectors['#tmdbPreview input[type="checkbox"][data-movie-id]'] = [{ checked: true, dataset: { movieId: '101' } }];
  for (const fn of ['addPulledCollectionMovies', 'addRefreshedCollectionMovies', 'addPulledUniverseMovies', 'addPulledPersonMovies']) {
    await app.ctx[fn]();
  }
  await app.ctx.pullPersonFilmography(1, 'P', false, 'director', { crew: [], cast: [] });
  assert.strictEqual(app.writes().length, 0);
  assertViewIntact(app);
});

T.run();
