// Offline tests for the TV-show migration's Phase 2 (shadow) app changes: TV
// structural writes (seeding defaults, Refresh shows, TMDB search add, manual
// Add entry, Match to TMDB, Delete) go through the database functions, which
// link every new season to its show; films, movies and every status, watched,
// skip and date edit stay direct writes, and no function changes a status.
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
const openTab = async (app, id) => { app.ctx.switchTab(id); await settle(); };
const writes = app => app.writes().map(r => `${r.method} ${r.url.split('/rest/v1/')[1].split('?')[0]}`);
const banner = app => app.el('errorBanner').innerHTML;
async function addManual(app, tab, title, season, date = 'Jan 1, 2027') {
  await openTab(app, tab);
  app.el('nTitle').value = title; app.el('nSeason').value = season; app.el('nTheme').value = 'HBO'; app.el('nDate').value = date;
  await app.ctx.addEntry(); await settle();
}

// ── manual Add entry ──
test('manual TV season → add_tv_seasons with the legacy show key; the season is linked; a second season joins the same show', async () => {
  const app = await createApp();
  await addManual(app, 'othertv', 'ZZ Manual', 'Season 1');
  await addManual(app, 'othertv', 'ZZ Manual', 'Season 2');
  assert.deepStrictEqual(writes(app), ['POST rpc/add_tv_seasons', 'POST rpc/add_tv_seasons']);
  const body = app.writes()[0].body;
  assert.deepStrictEqual(out(body.p_show), { tmdb_id: null, title: 'ZZ Manual', show_key: 'zz manual', network: 'HBO' });
  assert.deepStrictEqual(out(body.p_seasons), [{ item_key: 'zz manual|season 1', title: 'ZZ Manual', season: 'Season 1', theme: 'HBO',
    display_date: 'Jan 1, 2027', date_sort: '2027-01-01', season_number: null }]);
  const rows = app.get('tabData.othertv.rows');
  assert.strictEqual(rows.length, 2);
  assert.ok(rows[0].show_id && rows[0].show_id === rows[1].show_id, 'both seasons on one show');
  assert.deepStrictEqual(Array.from(rows, r => r.status), ['confirmed', 'confirmed']);
  assert.strictEqual(app.shows.length, 1);
  assert.strictEqual(banner(app), '');
});

test('manual "The Clone Wars" season on Disney+ joins the overridden show key', async () => {
  const app = await createApp();
  await addManual(app, 'disney', 'The Clone Wars', 'Season 8');
  const call = app.writes().find(r => r.url.endsWith('/rpc/add_tv_seasons'));
  assert.strictEqual(call.body.p_show.show_key, 'star wars: the clone wars (2008)');
  // Opening Disney+ seeded its defaults, including the Clone Wars seasons: Season 8 joins that same show.
  const cw = app.shows.filter(s => s.show_key === 'star wars: the clone wars (2008)');
  assert.strictEqual(cw.length, 1);
  const s8 = app.store.watchlist_items.find(r => r.item_key === 'the clone wars|season 8');
  assert.strictEqual(s8.show_id, cw[0].id);
  assert.ok(app.store.watchlist_items.filter(r => r.show_id === cw[0].id).length > 1);
});

test('manual film on a TV tab and any manual add on Movies stay a direct, unlinked insert', async () => {
  const app = await createApp();
  await addManual(app, 'truecrime', 'ZZ Doc', 'Film');
  await addManual(app, 'movies', 'ZZ Movie', 'Film');
  assert.deepStrictEqual(writes(app), ['POST watchlist_items', 'POST watchlist_items']);
  assert.ok(app.store.watchlist_items.every(r => r.show_id == null));
});

test('manual season already in the database (not in this page) → "already on your list", nothing added', async () => {
  const app = await createApp();
  await openTab(app, 'othertv');
  app.store.watchlist_items.push(legacy({ id: 'x1', title: 'ZZ Manual', item_key: 'zz manual|season 1', show_id: null }));
  await addManual(app, 'othertv', 'ZZ Manual', 'Season 1');
  assert.ok(banner(app).includes('already on your list'), banner(app));
  assert.strictEqual(app.get('tabData.othertv.rows.length'), 0);
  assert.strictEqual(app.store.watchlist_items.length, 1);
});

// ── Delete ──
test('deleting a non-default TV season → delete_tv_season; the last one removes the show and its Refresh tracking', async () => {
  const app = await createApp({ rows: [tv({ id: 'a' }), tv({ id: 'b', season_number: 2, season: 'Season 2', item_key: 'show|season 2' })],
    tvShows: [show()], othertvShows: [{ id: 'o1', tmdb_id: 100, title: 'Show', network: 'HBO', collection: 'othertv' }] });
  await openTab(app, 'othertv');
  await app.ctx.delRow('a'); await settle();
  assert.strictEqual(app.store.tv_shows.length, 1, 'show kept while it has seasons');
  await app.ctx.delRow('b'); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/delete_tv_season', 'POST rpc/delete_tv_season']);
  assert.deepStrictEqual(app.store.tv_shows, []);
  assert.deepStrictEqual(app.store.othertv_shows, []);
  assert.strictEqual(app.get('tabData.othertv.rows.length'), 0);
  assert.strictEqual(banner(app), '');
});

test('a TV season already deleted elsewhere counts as deleted (like a plain DELETE); other errors roll back', async () => {
  const app = await createApp({ rows: [tv({ id: 'a' }), tv({ id: 'b', season_number: 2, season: 'Season 2', item_key: 'show|season 2' })], tvShows: [show()] });
  await openTab(app, 'othertv');
  app.store.watchlist_items = app.store.watchlist_items.filter(r => r.id !== 'a');
  await app.ctx.delRow('a'); await settle();
  assert.strictEqual(banner(app), '');
  assert.strictEqual(app.get('tabData.othertv.rows.length'), 1);
  app.failNext(r => r.url.endsWith('/rpc/delete_tv_season'));
  await app.ctx.delRow('b'); await settle();
  assert.ok(banner(app).includes('simulated failure') || banner(app).includes('500'), banner(app));
  assert.strictEqual(app.get('tabData.othertv.rows.length'), 1, 'row put back');
});

test('deleting a movie is a plain DELETE; "deleting" a built-in default is still a skipped PATCH', async () => {
  const film = tv({ id: 'm', collection: 'movies', media_type: 'movie', season: 'Film', season_number: null, show_id: null, item_key: 'film|film' });
  const app = await createApp({ rows: [film] });
  app.ctx.switchMediaType('movie'); await settle();
  await app.ctx.delRow('m'); await settle();
  const app2 = await createApp();
  await openTab(app2, 'disney');
  const def = app2.get('tabData.disney.rows').find(r => r.season !== 'Film');
  await app2.ctx.delRow(def.id); await settle();
  assert.deepStrictEqual(writes(app), ['DELETE watchlist_items']);
  assert.deepStrictEqual(writes(app2), ['POST rpc/seed_tv_defaults', 'PATCH watchlist_items']);
  assert.strictEqual(app2.store.watchlist_items.find(r => r.id === def.id).status, 'skipped');
});

// ── Refresh shows ──
function refreshSetup(app, entries, picks) {
  app.run(`window.__refreshData = ${JSON.stringify(entries)}; window.__refreshDateUpdates = [];`);
  app.selectors['#tmdbPreview input[type="checkbox"][data-show-idx]'] = picks.map(([idx, season]) => ({ checked: true, dataset: { showIdx: String(idx), season: String(season) } }));
}
test('Refresh shows → one add_tv_seasons per show; new seasons link to the existing show; statuses untouched', async () => {
  const app = await createApp({ rows: [tv({ id: 'a', status: 'watching' })], tvShows: [show({ status: 'watching' })] });
  await openTab(app, 'othertv');
  refreshSetup(app, [
    { show: { title: 'Show', tmdb_id: 100 }, details: { networks: [{ name: 'HBO' }] }, newOnes: [{ season_number: 2, air_date: '2027-01-01' }, { season_number: 3, air_date: null }] },
    { show: { title: 'Other', tmdb_id: 200 }, details: { networks: [] }, newOnes: [{ season_number: 1, air_date: '2026-01-01' }] }
  ], [[0, 2], [0, 3], [1, 1]]);
  await app.ctx.addRefreshedSeasons(); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/add_tv_seasons', 'POST rpc/add_tv_seasons']);
  const [first, second] = app.writes().map(r => r.body);
  assert.deepStrictEqual(Array.from(first.p_seasons, s => [s.item_key, s.season_number, s.date_sort]),
    [['show|season 2', 2, '2027-01-01'], ['show|season 3', 3, '2099-01-01']]);
  assert.deepStrictEqual(out(second.p_show), { tmdb_id: 200, title: 'Other', show_key: 'other', network: 'Unknown' });
  const rows = app.store.watchlist_items;
  assert.ok(rows.filter(r => r.tmdb_id === 100).every(r => r.show_id === 's100'));
  assert.deepStrictEqual(rows.map(r => r.status).sort(), ['confirmed', 'confirmed', 'confirmed', 'watching'], 'the existing season keeps its status');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === 's100').status, 'watching', 'no reopen, no status change');
  assert.strictEqual(app.get('tabData.othertv.rows.length'), 4);
  assert.strictEqual(banner(app), '');
});

test('Refresh shows with a season added elsewhere meanwhile → the others are added, then the usual duplicate message', async () => {
  const app = await createApp({ rows: [tv({ id: 'a' })], tvShows: [show()] });
  await openTab(app, 'othertv');
  refreshSetup(app, [{ show: { title: 'Show', tmdb_id: 100 }, details: { networks: [] }, newOnes: [{ season_number: 2, air_date: '2027-01-01' }, { season_number: 3, air_date: '2028-01-01' }] }], [[0, 2], [0, 3]]);
  app.store.watchlist_items.push(tv({ id: 'z', season_number: 2, season: 'Season 2', item_key: 'show|season 2' }));
  await app.ctx.addRefreshedSeasons(); await settle();
  assert.ok(banner(app).includes('already on your list'), banner(app));
  assert.strictEqual(app.store.watchlist_items.filter(r => r.season_number === 3).length, 1);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.season_number === 2).length, 1, 'no duplicate');
});

// ── TMDB search add ──
test('TMDB search: a film on True Crime / Docs stays a direct insert with no tracking; a series uses add_tv_seasons', async () => {
  const app = await createApp();
  await openTab(app, 'truecrime');
  app.run(`tmdbSelectedShow = { id: 9, name: 'Doc Film', mediaType: 'movie', details: { production_companies: [{ name: 'Studio' }], release_date: '2020-02-02' } };`);
  const filmPrev = app.addEl('tmdbInlinePreview');
  filmPrev.querySelector = sel => (sel === 'input[type="checkbox"][data-season="film"]' ? { checked: true, disabled: false } : null);
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.deepStrictEqual(writes(app), ['POST watchlist_items']);
  app.run(`tmdbSelectedShow = { id: 10, name: 'Doc Series', mediaType: 'tv', details: { networks: [{ name: 'Netflix' }], seasons: [{ season_number: 1, air_date: '2021-03-03' }] } };`);
  const prev = app.addEl('tmdbInlinePreview');
  prev.querySelectorAll = sel => (sel === 'input[type="checkbox"][data-season]' ? [{ checked: true, disabled: false, dataset: { season: '1' } }] : []);
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.deepStrictEqual(writes(app), ['POST watchlist_items', 'POST rpc/add_tv_seasons']);
  const series = app.store.watchlist_items.find(r => r.tmdb_id === 10);
  assert.ok(series.show_id);
  assert.ok(app.store.watchlist_items.find(r => r.tmdb_id === 9).show_id == null);
  assert.deepStrictEqual(app.store.othertv_shows.map(o => [o.tmdb_id, o.network, o.collection]), [[10, 'Netflix', 'truecrime']]);
});

// ── Seeding built-in defaults ──
test('seeding sends only the defaults the old rule finds missing; a key held by an identified row is not re-seeded', async () => {
  const app0 = await createApp();
  const defaults = app0.get("COLLECTIONS.find(c => c.id === '90day').defaults");
  const [d0, d1] = defaults;
  const app = await createApp({ rows: [
    legacy({ id: 'l0', collection: '90day', item_key: d0.k, title: d0.t, season: d0.s, show_id: null }),
    tv({ id: 'i1', collection: '90day', item_key: d1.k, title: d1.t, tmdb_id: 4242, season_number: 7, season: 'Season 7', show_id: null })
  ] });
  await openTab(app, '90day');
  const call = app.writes().find(r => r.url.endsWith('/rpc/seed_tv_defaults'));
  assert.strictEqual(call.body.p_defaults.length, defaults.length - 2);
  assert.ok(!call.body.p_defaults.some(d => d.k === d0.k || d.k === d1.k));
  assert.strictEqual(app.get("tabData['90day'].rows.length"), defaults.length);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.item_key === d1.k).length, 1, 'no legacy twin of the identified row');
});

test('a fully seeded tab makes no write at all on load', async () => {
  const app0 = await createApp();
  await openTab(app0, 'sheridan');
  const app = await createApp({ rows: app0.store.watchlist_items });
  await openTab(app, 'sheridan');
  assert.deepStrictEqual(app.writes(), []);
});

// ── Old season status stays authoritative ──
test('status, watched and watch-with edits on TV seasons are still direct PATCHes, never functions', async () => {
  const app = await createApp({ rows: [tv({ id: 'a' })], tvShows: [show()] });
  await openTab(app, 'othertv');
  await app.ctx.setStatus('a', 'watching', null); await settle();
  await app.ctx.toggleWatch('a'); await settle();
  assert.deepStrictEqual(writes(app), ['PATCH watchlist_items', 'PATCH watchlist_items']);
  assert.deepStrictEqual([app.store.watchlist_items[0].status, app.store.watchlist_items[0].watched], ['watching', true]);
  assert.strictEqual(app.store.tv_shows[0].status, 'confirmed', 'the shadow show status is only updated by the resync');
});

T.run();
