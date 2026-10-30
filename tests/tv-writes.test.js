// Offline tests for the app's TV writes on the first-class show model (Stage 5:
// from the views and their "+ Add" panel; no storage tabs): new shows, seasons
// added to a show on the list, Refresh shows, TMDB search adds and Match go
// through the library_* database functions, which link every new season to its
// show and reopen a Complete show that gets a genuinely new season; Delete goes
// through delete_tv_season; show status, Watched and Skip go through their
// functions; films and date edits stay direct writes; catalog entries arrive
// only through an explicit catalog application.
// Run from the repo root: node tests/tv-writes.test.js
// No network, no database (see tests/app-harness.js for the function stand-ins).
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('tv-writes');
const test = T.test;
const out = v => JSON.parse(JSON.stringify(v));

let n = 0;
const tv = (o = {}) => {
  const num = o.season_number !== undefined ? o.season_number : 1;
  return { id: o.id || `r${String(++n).padStart(5, '0')}`, collection: 'othertv', title: 'Show', theme: 'HBO', status: 'confirmed',
    watched: false, media_type: 'tv', tmdb_id: 100, season_number: num, season: `Season ${num}`, display_date: 'Jan 1, 2020',
    date_sort: '2020-01-01', item_key: `show|season ${num}`, watch_with: [], collections: [], show_id: 's100', skipped: false, ...o };
};
const legacy = (o = {}) => tv({ media_type: null, tmdb_id: null, season_number: null, ...o });
const show = (o = {}) => ({ id: 's100', collection: 'othertv', title: 'Show', show_key: 'show', tmdb_id: 100, status: 'confirmed', ...o });
const writes = app => app.writes().map(r => `${r.method} ${r.url.split('/rest/v1/')[1].split('?')[0]}`);
const banner = app => app.el('errorBanner').innerHTML;
const outcome = app => (app.el('libraryOutcome')?.innerHTML || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const noStorage = app => assert.deepStrictEqual(app.storageRequests().map(r => r.url), [], 'no request names a storage value');
async function allTv(app) { app.ctx.switchView('alltv'); await settle(); app.el('fStatus').value = 'all'; app.ctx.renderTable(); }
async function newShowByHand(app, title, season, date = 'Jan 1, 2027') {
  app.ctx.openLibraryPanel('tv', 'manual'); await settle();
  app.el('nTitle').value = title; app.el('nSeason').value = season; app.el('nTheme').value = 'HBO'; app.el('nDate').value = date;
  await app.ctx.libraryManualShow(); await settle();
}
async function addSeasonByHand(app, showId, season, date = 'Jan 1, 2027') {
  app.ctx.openAddSeason(showId); await settle(); await settle();
  app.el('nSeason').value = season; app.el('nDate').value = date; app.el('nTheme').value = 'HBO';
  await app.ctx.librarySubmitSeason(); await settle();
}
// Refresh shows (item 4): library-wide, TMDB only, automatic (collection-updates.js cuRefreshShows).
async function refreshShows(app) {
  app.ctx.openLibraryPanel('tv', 'refresh'); await settle();
  await app.ctx.cuRefreshShows(); await settle();
}
const results = app => app.el('tmdbPreview').innerHTML.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/’/g, "'").replace(/\s+/g, ' ').trim();
// TMDB show details by id; the appended season lists answer empty.
const tmdbShows = shows => p => {
  const m = /^\/tv\/(\d+)(\?append_to_response=.*)?$/.exec(p);
  if (!m || !shows[m[1]]) return undefined;
  return m[2] ? {} : { id: +m[1], networks: [{ name: 'HBO' }], ...shows[m[1]] };
};

// ── New shows and seasons by hand ──
test('a new show by hand → library_create_show_b45 (no identity, the season linked); a second season goes to that show through library_add_seasons_b45', async () => {
  const app = await createApp();
  await allTv(app);
  await newShowByHand(app, 'ZZ Manual', 'Season 1');
  assert.deepStrictEqual(writes(app), ['POST rpc/library_create_show_b45']);
  const body = app.writes()[0].body;
  assert.deepStrictEqual(out(body.p_show), { tmdb_id: null, title: 'ZZ Manual', show_key: 'zz manual', network: 'HBO', distinct_from: [] });
  assert.deepStrictEqual(out(body.p_seasons), [{ item_key: 'zz manual|season 1', title: 'ZZ Manual', season: 'Season 1', theme: 'HBO',
    display_date: 'Jan 1, 2027', date_sort: '2027-01-01' }]);
  const created = app.store.tv_shows.find(s => s.show_key === 'zz manual');
  await addSeasonByHand(app, created.id, 'Season 2');
  assert.deepStrictEqual(writes(app), ['POST rpc/library_create_show_b45', 'POST rpc/library_add_seasons_b45']);
  const rows = app.store.watchlist_items.filter(r => r.title === 'ZZ Manual');
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every(r => r.show_id === created.id), 'both seasons on one show');
  assert.deepStrictEqual(Array.from(rows, r => r.status), ['confirmed', 'confirmed']);
  assert.strictEqual(app.store.tv_shows.length, 1);
  assert.strictEqual(banner(app), '');
  noStorage(app);
});

test('a season added by hand to the catalog’s "The Clone Wars" joins that show (its overridden show key), never a second show', async () => {
  // The governed show as an earlier catalog application left it (the config-based lists are retired since item 4).
  const app = await createApp({ rows: [tv({ id: 'cw1', collection: 'disney', title: 'Star Wars: The Clone Wars', item_key: 'the clone wars|season 7', season: 'Season 7',
    media_type: null, tmdb_id: null, season_number: null, show_id: 'scw', theme: 'Star Wars' })],
    tvShows: [{ id: 'scw', collection: 'disney', title: 'Star Wars: The Clone Wars', show_key: 'star wars: the clone wars (2008)', tmdb_id: null, status: 'confirmed' }] });
  await allTv(app);
  const cw = app.store.tv_shows.filter(s => s.show_key === 'star wars: the clone wars (2008)');
  assert.strictEqual(cw.length, 1);
  await addSeasonByHand(app, cw[0].id, 'Season 8');
  const call = app.writes().find(r => r.url.endsWith('/rpc/library_add_seasons_b45'));
  assert.strictEqual(call.body.p_show_id, cw[0].id);
  assert.deepStrictEqual(out(call.body.p_expected), { tmdb_id: null, show_key: 'star wars: the clone wars (2008)', catalog: 'disney', network: '' });
  const s8 = app.store.watchlist_items.find(r => r.show_id === cw[0].id && r.season === 'Season 8');
  assert.ok(s8, 'joined the show');
  assert.strictEqual(app.store.tv_shows.filter(s => s.show_key === 'star wars: the clone wars (2008)').length, 1);
});

test('a film by hand → library_create_film_b45, never linked to a show', async () => {
  const app = await createApp();
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openLibraryPanel('movie', 'manual'); await settle();
  app.el('nTitle').value = 'ZZ Doc'; app.el('nTheme').value = 'Documentary'; app.el('nDate').value = 'Jan 1, 2027';
  await app.ctx.libraryManualFilm(); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_create_film_b45']);
  assert.ok(app.store.watchlist_items.every(r => r.show_id == null));
  noStorage(app);
});

test('a season already saved (by another page after this one read the list) → reported as already on the list; nothing added twice', async () => {
  const app = await createApp({ rows: [legacy({ id: 'l1', title: 'ZZ Manual', item_key: 'zz manual|season 1', show_id: 's9' })],
    tvShows: [{ id: 's9', collection: 'othertv', title: 'ZZ Manual', show_key: 'zz manual', tmdb_id: null, status: 'confirmed' }] });
  await allTv(app);
  app.ctx.openAddSeason('s9'); await settle(); await settle();
  app.store.watchlist_items.push(legacy({ id: 'l2', title: 'ZZ Manual', season: 'Season 2', item_key: 'zz manual|season 2', show_id: 's9' }));
  app.el('nSeason').value = 'Season 2'; app.el('nDate').value = 'Jan 1, 2027'; app.el('nTheme').value = 'HBO';
  await app.ctx.librarySubmitSeason(); await settle();
  assert.match(outcome(app), /already on your list/);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.item_key === 'zz manual|season 2').length, 1);
});

// ── Delete ──
test('deleting a TV season that isn’t a catalog entry → delete_tv_season; the last one removes the show, so Refresh shows no longer offers it', async () => {
  const app = await createApp({ rows: [tv({ id: 'a' }), tv({ id: 'b', season_number: 2, season: 'Season 2', item_key: 'show|season 2' })],
    tvShows: [show()], othertvShows: [{ id: 'o1', tmdb_id: 100, title: 'Show', network: 'HBO', collection: 'othertv' }] });
  await allTv(app);
  app.ctx.confirm = () => true;
  await app.ctx.delRowInView('a'); await settle();
  assert.strictEqual(app.store.tv_shows.length, 1, 'show kept while it has seasons');
  await app.ctx.delRowInView('b'); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/delete_tv_season', 'POST rpc/delete_tv_season']);
  assert.deepStrictEqual(app.store.tv_shows, []);
  assert.strictEqual(app.store.othertv_shows.length, 1, 'the old tracking table is left alone (dropped only at contraction)');
  assert.strictEqual(banner(app), '');
  const tmdbBefore = app.requests.filter(r => !r.url.includes('/rest/v1/')).length;
  await refreshShows(app);
  assert.ok(results(app).includes('Checked 0 shows'), 'Refresh finds no show to check');
  assert.strictEqual(app.requests.filter(r => !r.url.includes('/rest/v1/')).length, tmdbBefore, 'no TMDB lookup for the deleted show');
});

test('a TV season already deleted elsewhere counts as deleted; another error is reported and the view read again', async () => {
  const app = await createApp({ rows: [tv({ id: 'a' }), tv({ id: 'b', season_number: 2, season: 'Season 2', item_key: 'show|season 2' })], tvShows: [show()] });
  await allTv(app);
  app.ctx.confirm = () => true;
  app.store.watchlist_items = app.store.watchlist_items.filter(r => r.id !== 'a');
  await app.ctx.delRowInView('a'); await settle();
  assert.strictEqual(banner(app), '');
  app.failNext(r => r.url.endsWith('/rpc/delete_tv_season'));
  await app.ctx.delRowInView('b'); await settle();
  assert.ok(banner(app).length > 0, 'reported');
  assert.ok(app.get("derivedData.rows.some(r => r.id === 'b')"), 'row back after reading the view again');
});

test('deleting a film is a plain DELETE; × on a catalog season skips it (set_season_skipped); × on a catalog film is Skipped through the film function (B4/B5)', async () => {
  const film = tv({ id: 'm', collection: 'movies', media_type: 'movie', season: 'Film', season_number: null, show_id: null, item_key: 'film|film', tmdb_id: 77 });
  const app = await createApp({ rows: [film] });
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.confirm = () => true;
  await app.ctx.delRowInView('m'); await settle();
  assert.deepStrictEqual(writes(app), ['DELETE watchlist_items']);
  // Governed records as an earlier catalog application left them (the lists are retired since item 4).
  const app2 = await createApp({ rows: [tv({ id: 'cs1', collection: 'disney', title: 'ZZ Catalog Alpha', item_key: 'zz catalog alpha|season 1', show_id: 'sca',
      media_type: null, tmdb_id: null, season_number: null, theme: 'Star Wars' }),
    tv({ id: 'cf1', collection: 'disney', title: 'ZZ Catalog Film One', item_key: 'zz catalog film one|film', season: 'Film', media_type: null, tmdb_id: null, season_number: null, show_id: null, theme: 'Star Wars' })],
    tvShows: [{ id: 'sca', collection: 'disney', title: 'ZZ Catalog Alpha', show_key: 'zz catalog alpha', tmdb_id: null, status: 'confirmed' }] });
  app2.ctx.confirm = () => true;
  const def = app2.store.watchlist_items.find(r => r.season !== 'Film' && !r.skipped);
  const defFilm = app2.store.watchlist_items.find(r => r.season === 'Film' && r.status !== 'skipped');
  await allTv(app2);
  await app2.ctx.delRowInView(def.id); await settle();
  app2.ctx.switchMediaType('movie'); await settle();
  app2.el('fStatus').value = 'all'; app2.el('fWatch').value = ''; app2.ctx.renderTable();
  await app2.ctx.delRowInView(defFilm.id); await settle();
  assert.deepStrictEqual(writes(app2), ['POST rpc/set_season_skipped', 'POST rpc/library_set_film_state_b45'], 'the views wrote nothing else');
  const stored = id => app2.store.watchlist_items.find(r => r.id === id);
  assert.strictEqual(stored(def.id).skipped, true, 'the season is skipped, nothing deleted');
  assert.strictEqual(stored(defFilm.id).status, 'skipped');
  assert.strictEqual(app2.store.watchlist_items.length, 2, 'nothing deleted');
});

// ── Refresh shows (item 4: automatic, through library_cu_reconcile_season) ──
test('Refresh shows → one library_cu_reconcile_season per new season; new seasons link to the existing show; statuses untouched', async () => {
  const app = await createApp({
    rows: [tv({ id: 'a', status: 'watching' }), tv({ id: 'o', title: 'Other', tmdb_id: 200, item_key: 'other|season 1', show_id: 's200' })],
    tvShows: [show({ status: 'watching' }), show({ id: 's200', title: 'Other', show_key: 'other', tmdb_id: 200 })],
    tmdb: tmdbShows({ 100: { name: 'Show', seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2027-01-01', episode_count: 8 }, { season_number: 3, air_date: null, episode_count: 0 }] },
      200: { name: 'Other', networks: [], seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2026-01-01', episode_count: 6 }] } }) });
  await allTv(app);
  await refreshShows(app);
  assert.deepStrictEqual(writes(app).filter(w => !w.endsWith('library_cu_sync_show_network')), ['POST rpc/library_cu_reconcile_season', 'POST rpc/library_cu_reconcile_season', 'POST rpc/library_cu_reconcile_season']);
  const calls = app.writes().filter(r => r.url.endsWith('/rpc/library_cu_reconcile_season')).map(r => r.body);
  assert.deepStrictEqual(calls.map(b => [b.p_show_id, b.p_season.season_number, b.p_season.date_sort]),
    [['s200', 2, '2026-01-01'], ['s100', 2, '2027-01-01'], ['s100', 3, '2099-01-01']]);
  assert.deepStrictEqual(out(calls[0].p_expected), { tmdb_id: 200, show_key: 'other' });
  const rows = app.store.watchlist_items;
  assert.ok(rows.some(r => r.show_id === 's100' && r.season_number === 2 && r.tmdb_id === 100), 'Season 2 added to the show, identified');
  assert.ok(!rows.some(r => r.show_id === 's100' && r.season_number === 3), 'an undated season with no episodes waits for announcement evidence');
  assert.match(results(app), /Show · Season 3: TMDB lists it without a date or episodes/);
  assert.strictEqual(rows.find(r => r.id === 'a').status, 'watching', 'the existing season keeps its status');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === 's100').status, 'watching', 'no reopen, no status change');
  assert.strictEqual(banner(app), '');
  noStorage(app);
});

test('Refresh shows with a season added elsewhere meanwhile → the database finds it; never added twice', async () => {
  const app = await createApp({ rows: [tv({ id: 'a' })], tvShows: [show()],
    tmdb: tmdbShows({ 100: { name: 'Show', seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2027-01-01', episode_count: 8 }, { season_number: 3, air_date: '2028-01-01', episode_count: 8 }] } }) });
  await allTv(app);
  // The season appears while the check reads TMDB (another page saved it).
  const g = app.hold(r => r.url.includes('/rpc/library_cu_reconcile_season'));
  const done = refreshShows(app);
  await g.reached;
  app.store.watchlist_items.push(tv({ id: 'z', season_number: 2, season: 'Season 2', item_key: 'show|season 2' }));
  g.release();
  await done; await settle();
  assert.match(results(app), /Show · Season 3: added/);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.season_number === 3).length, 1);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.season_number === 2).length, 1, 'no duplicate');
});

test('Refresh shows checks every show, catalog shows included, from the library read (never the old tracking table); an unmatched show is looked up by title', async () => {
  const legacyShow = { id: 's200', collection: 'disney', title: 'Legacy', show_key: 'legacy', tmdb_id: null, status: 'confirmed' };
  const app = await createApp({ rows: [tv({ id: 'a' }), legacy({ id: 'l', collection: 'disney', title: 'Legacy', item_key: 'legacy|season 1', show_id: 's200' })],
    tvShows: [show(), legacyShow], othertvShows: [],
    tmdb: p => p.startsWith('/search/tv') ? { results: [] } : tmdbShows({ 100: { name: 'Show', seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2027-01-01', episode_count: 8 }] } })(p) });
  await allTv(app);
  const before = app.requests.length;
  await refreshShows(app);
  const reads = app.requests.slice(before).filter(r => r.method === 'GET').map(r => r.url.split('/rest/v1/')[1] || r.url);
  assert.ok(!reads.some(u => u.startsWith('othertv_shows')), 'the old tracking table is not read');
  const tmdbCalls = app.requests.slice(before).filter(r => !r.url.includes('/rest/v1/')).map(r => r.url);
  assert.ok(tmdbCalls.some(u => u.includes('/tv/100')) && tmdbCalls.some(u => u.includes('/search/tv?query=Legacy')), 'the matched show and the unmatched catalog show are both checked');
  assert.match(results(app), /Checked 2 shows \(1 matched to TMDB, 1 not yet matched\)/);
  assert.ok(app.store.watchlist_items.some(r => r.show_id === 's100' && r.season_number === 2));
});

// ── TMDB search add ──
test('TMDB search: a film goes through library_add_films_b45; a series through library_create_show_b45; the old tracking table is never written', async () => {
  const app = await createApp({ tmdb: p => (p === '/movie/9' ? { id: 9, title: 'Doc Film', release_date: '2020-02-02', genres: [{ name: 'Documentary' }] } : undefined) });
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openLibraryPanel('movie'); await settle();
  app.run(`tmdbSelectedShow = { id: 9, name: 'Doc Film', mediaType: 'movie', details: { title: 'Doc Film', genres: [{ name: 'Documentary' }], release_date: '2020-02-02' } };`);
  app.run(`libraryPanel.choice = { tmdbId: 9, mediaType: 'movie', route: { kind: 'new' } };`);
  await app.ctx.libraryChoose(9, 'movie', null, true); await settle();
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_add_films_b45']);
  app.ctx.switchMediaType('tv'); await allTv(app);
  app.ctx.openLibraryPanel('tv'); await settle();
  app.run(`tmdbSelectedShow = { id: 10, name: 'Doc Series', mediaType: 'tv', details: { name: 'Doc Series', networks: [{ name: 'Netflix' }], seasons: [{ season_number: 1, air_date: '2021-03-03' }] } };`);
  await app.ctx.libraryChoose(10, 'tv', null, true); await settle();
  app.el('tmdbPreview').querySelectorAll = sel => (sel.includes('data-season') ? [{ checked: true, disabled: false, dataset: { season: '1' } }] : []);
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_add_films_b45', 'POST rpc/library_create_show_b45', 'POST rpc/library_cu_sync_show_network']);
  const series = app.store.watchlist_items.find(r => r.tmdb_id === 10);
  assert.ok(series && series.show_id);
  assert.ok(app.store.watchlist_items.find(r => r.tmdb_id === 9).show_id == null);
  assert.ok(app.store.tv_shows.some(s => s.tmdb_id === 10), 'an identified show, which Refresh shows checks');
  assert.deepStrictEqual(app.store.othertv_shows, [], 'the old tracking table is not written');
  noStorage(app);
});

// ── Enriched (TMDB-matched) catalog shows ──
// A Sheridan-governed show matched to TMDB (identity only), as an earlier catalog application and the
// admin matching left it (the config-based lists are retired since item 4).
async function enrichedSheridan() {
  const landman = { id: 'sland', collection: 'sheridan', title: 'ZZ Catalog Landman', show_key: 'zz catalog landman', tmdb_id: 157741, status: 'confirmed' };
  const rows = [1, 2].map(n => tv({ id: `land${n}`, collection: 'sheridan', title: landman.title, item_key: `zz catalog landman|season ${n}`, season: `Season ${n}`,
    tmdb_id: 157741, season_number: n, show_id: 'sland', theme: 'Landman' }));
  const app = await createApp({ rows, tvShows: [landman] });
  return { app, landman, showCount: 1 };
}
test('a season added by hand to a governed TMDB-matched show: a plain "Season N" joins it as that TMDB season; "Season 4 (Part 1)" is held for review', async () => {
  const { app, landman, showCount } = await enrichedSheridan();
  await allTv(app);
  await addSeasonByHand(app, landman.id, 'Season 4');
  const s4 = app.store.watchlist_items.find(r => r.item_key === 'zz catalog landman|season 4');
  assert.ok(s4 && s4.show_id === landman.id && s4.tmdb_id === 157741 && s4.season_number === 4, JSON.stringify(s4));
  await addSeasonByHand(app, landman.id, 'Season 4 (Part 1)');
  assert.ok(!app.store.watchlist_items.some(r => r.item_key === 'zz catalog landman|season 4 (part 1)'));
  assert.match(outcome(app), /needs review/);
  assert.strictEqual(app.store.tv_shows.length, showCount, 'no second show');
});

// ── Show status, Watched and Skip ──
test('show status, Watched and Skip go through their functions; films go through the guarded film function (B4/B5); no season status is ever written', async () => {
  const film = tv({ id: 'f', collection: 'truecrime', media_type: 'movie', season: 'Film', season_number: null, tmdb_id: 900, show_id: null, item_key: 'doc|film' });
  const app = await createApp({ rows: [tv({ id: 'a' }), film], tvShows: [show()] });
  await allTv(app);
  await app.ctx.setShowStateById('s100', { status: 'watching' }); await settle();
  await app.ctx.toggleWatch('a'); await settle();
  await app.ctx.setSeasonSkipped('a', true); await settle();
  await app.ctx.setStatus('a', 'watched', null); await settle(); // a TV season has no row-level status: ignored
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fStatus').value = 'all'; app.el('fWatch').value = ''; app.ctx.renderTable();
  await app.ctx.setStatus('f', 'skipped', null); await settle();
  await app.ctx.toggleWatch('f'); await settle(); // a skipped film: Watched is a status choice, refused as a watched-only change
  assert.deepStrictEqual(writes(app), ['POST rpc/library_set_show_state_b45', 'POST rpc/set_season_watched', 'POST rpc/set_season_skipped',
    'POST rpc/library_set_film_state_b45'], 'Watched on a skipped film sends nothing');
  assert.match(banner(app), /is Skipped, so Watched changes only through its status \(To Watch, Watched or Skipped\)\. Nothing was changed\./);
  const f = app.store.watchlist_items.find(r => r.id === 'f');
  assert.deepStrictEqual([f.status, f.watched], ['skipped', false], 'never Skipped + Watched');
  assert.ok(!app.writes().some(r => r.body && r.url.includes('watchlist_items?id=eq.a')), 'no direct write to the TV season');
  assert.strictEqual(app.store.tv_shows[0].status, 'watching');
  const a = app.store.watchlist_items.find(r => r.id === 'a');
  assert.deepStrictEqual([a.watched, a.skipped, a.status], [true, true, 'confirmed']);
});

// ── Complete-show reopen and add outcomes ──
// ── B4/B5: an addition never changes a show's status, priority or Show ended ──
test('Refresh adding a genuinely new season to a show marked ended keeps its status and Show ended, flags it, and says so', async () => {
  const app = await createApp({ rows: [tv({ id: 'a', watched: true })], tvShows: [show({ status: 'watching', ended: true })],
    tmdb: tmdbShows({ 100: { name: 'Show', seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2027-01-01', episode_count: 8 }] } }) });
  await allTv(app);
  await refreshShows(app);
  assert.deepStrictEqual([app.store.tv_shows[0].status, app.store.tv_shows[0].ended], ['watching', true]);
  assert.ok(app.store.watchlist_items.some(r => r.season_number === 2), 'the season was added');
  assert.ok(app.store.show_update_settings.some(x => x.show_id === 's100' && x.new_season_after_ended_at), 'flagged: New season after Ended');
  assert.match(results(app), /stays marked ended; flagged/i);
  assert.ok(!/back On List|reopen/i.test(results(app)));
  assert.match(app.html(), /cu-flag-tag/, 'the flag shows on the show');
  assert.strictEqual(banner(app), '');
});

test('a season that is already listed by the time it is sent: a no-op; nothing changes on the show (Ended kept, not flagged)', async () => {
  const app = await createApp({ rows: [tv({ id: 'a' })], tvShows: [show({ status: 'watching', ended: true })],
    tmdb: tmdbShows({ 100: { name: 'Show', seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 3, air_date: '2028-01-01', episode_count: 8 }] } }) });
  await allTv(app);
  // A request racing with another page: Season 3 arrives elsewhere after the check.
  const g = app.hold(r => r.url.includes('/rpc/library_cu_reconcile_season'));
  const done = refreshShows(app);
  await g.reached;
  app.store.watchlist_items.push(tv({ id: 'z3', season_number: 3, season: 'Season 3', item_key: 'show|season 3' }));
  g.release();
  await done; await settle();
  assert.strictEqual(app.store.watchlist_items.filter(r => r.season_number === 3).length, 1, 'no duplicate');
  assert.deepStrictEqual([app.store.tv_shows[0].status, app.store.tv_shows[0].ended], ['watching', true], 'a duplicate is a no-op');
  assert.ok(!app.store.show_update_settings.some(x => x.new_season_after_ended_at), 'nothing was added, so nothing is flagged');
});

T.run();
