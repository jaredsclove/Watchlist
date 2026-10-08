// Offline tests for the app's TV writes on the first-class show model: TV
// structural writes (an explicit catalog application, Refresh shows, TMDB search add, manual
// Add entry, Match to TMDB, Delete) go through the database functions, which
// link every new season to its show and reopen a Complete show that gets a
// genuinely new season; show status, Watched and Skip go through their functions;
// films, movies and date edits stay direct writes.
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
  assert.strictEqual(app.store.tv_shows.length, 1);
  assert.strictEqual(banner(app), '');
});

test('manual "The Clone Wars" season on Disney+ joins the overridden show key', async () => {
  const app = await createApp();
  await app.applyCatalog('disney'); // the owner applied the Disney+ catalog (Stage 4a)
  await addManual(app, 'disney', 'The Clone Wars', 'Season 8');
  const call = app.writes().find(r => r.url.endsWith('/rpc/add_tv_seasons'));
  assert.strictEqual(call.body.p_show.show_key, 'star wars: the clone wars (2008)');
  // The applied catalog holds the Clone Wars seasons: Season 8 joins that same show.
  const cw = app.store.tv_shows.filter(s => s.show_key === 'star wars: the clone wars (2008)');
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
test('deleting a non-default TV season → delete_tv_season; the last one removes the show, so Refresh shows no longer offers it', async () => {
  const app = await createApp({ rows: [tv({ id: 'a' }), tv({ id: 'b', season_number: 2, season: 'Season 2', item_key: 'show|season 2' })],
    tvShows: [show()], othertvShows: [{ id: 'o1', tmdb_id: 100, title: 'Show', network: 'HBO', collection: 'othertv' }] });
  await openTab(app, 'othertv');
  await app.ctx.delRow('a'); await settle();
  assert.strictEqual(app.store.tv_shows.length, 1, 'show kept while it has seasons');
  await app.ctx.delRow('b'); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/delete_tv_season', 'POST rpc/delete_tv_season']);
  assert.deepStrictEqual(app.store.tv_shows, []);
  assert.strictEqual(app.store.othertv_shows.length, 1, 'the old tracking row is left alone (unused at stage final)');
  assert.strictEqual(app.get('tabData.othertv.rows.length'), 0);
  assert.strictEqual(banner(app), '');
  await app.ctx.refreshShows(); await settle();
  assert.ok(app.el('tmdbPreview').innerHTML.includes('nothing to refresh'), 'Refresh finds no show to check');
  assert.ok(!app.requests.some(r => !r.url.includes('/rest/v1/')), 'no TMDB lookup for the deleted show');
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

test('deleting a movie is a plain DELETE; × on a built-in TV season skips it (set_season_skipped); × on a built-in film is the skipped PATCH', async () => {
  const film = tv({ id: 'm', collection: 'movies', media_type: 'movie', season: 'Film', season_number: null, show_id: null, item_key: 'film|film' });
  const app = await createApp({ rows: [film] });
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.switchTab('movies'); await settle(); // Movies opens on the read-only All Movies
  await app.ctx.delRow('m'); await settle();
  assert.deepStrictEqual(writes(app), ['DELETE watchlist_items']);
  const app2 = await createApp();
  await app2.applyCatalog('disney');
  await openTab(app2, 'disney');
  const def = app2.get('tabData.disney.rows').find(r => r.season !== 'Film');
  const defFilm = app2.get('tabData.disney.rows').find(r => r.season === 'Film');
  await app2.ctx.delRow(def.id); await settle();
  await app2.ctx.delRow(defFilm.id); await settle();
  assert.deepStrictEqual(writes(app2), ['POST rpc/set_season_skipped', 'PATCH watchlist_items'], 'opening the tab wrote nothing');
  const stored = id => app2.store.watchlist_items.find(r => r.id === id);
  assert.strictEqual(stored(def.id).skipped, true, 'the season is skipped, nothing deleted');
  assert.strictEqual(stored(defFilm.id).status, 'skipped');
  assert.strictEqual(app2.store.watchlist_items.length, app2.get("COLLECTIONS.find(c => c.id === 'disney').defaults.length"));
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

test('Refresh shows checks the tab\'s identified shows from tv_shows (not the old tracking table); legacy shows are skipped', async () => {
  const legacyShow = { id: 's200', collection: 'othertv', title: 'Legacy', show_key: 'legacy', tmdb_id: null, status: 'confirmed' };
  const app = await createApp({ rows: [tv({ id: 'a' }), legacy({ id: 'l', title: 'Legacy', item_key: 'legacy|season 1', show_id: 's200' })],
    tvShows: [show(), legacyShow], othertvShows: [],
    tmdb: p => (p === '/tv/100' ? { id: 100, name: 'Show', networks: [{ name: 'HBO' }], seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2027-01-01' }] } : undefined) });
  await openTab(app, 'othertv');
  await app.ctx.refreshShows(); await settle();
  const reads = app.requests.filter(r => r.method === 'GET').map(r => r.url.split('/rest/v1/')[1] || r.url);
  assert.ok(reads.some(u => u.startsWith('tv_shows?collection=eq.othertv&select=id,title,tmdb_id')), reads.join(' | '));
  assert.ok(!reads.some(u => u.startsWith('othertv_shows')), 'the old tracking table is not read');
  const tmdbCalls = app.requests.filter(r => !r.url.includes('/rest/v1/')).map(r => r.url);
  assert.ok(tmdbCalls.length === 1 && tmdbCalls[0].includes('/tv/100'), 'only the identified show is looked up');
  const data = app.get('window.__refreshData');
  assert.strictEqual(data.length, 1);
  assert.deepStrictEqual(Array.from(data[0].newOnes, s => s.season_number), [2]);
  assert.strictEqual(data[0].show.title, 'Show');
  assert.deepStrictEqual(app.writes(), [], 'the preview writes nothing');
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
  assert.ok(app.store.tv_shows.some(s => s.tmdb_id === 10 && s.collection === 'truecrime'), 'an identified show, which Refresh shows checks');
  assert.deepStrictEqual(app.store.othertv_shows, [], 'the old tracking table is no longer written (stage final)');
});

// ── Seeding built-in defaults ──
test('opening a tab never seeds; an explicit catalog application adds only the defaults missing by the old rule; a key held by an identified row is not re-added', async () => {
  const app0 = await createApp();
  const defaults = app0.get("COLLECTIONS.find(c => c.id === '90day').defaults");
  const [d0, d1] = defaults;
  const app = await createApp({ rows: [
    legacy({ id: 'l0', collection: '90day', item_key: d0.k, title: d0.t, season: d0.s, show_id: null }),
    tv({ id: 'i1', collection: '90day', item_key: d1.k, title: d1.t, tmdb_id: 4242, season_number: Number(/\d+/.exec(d1.s)[0]), season: d1.s, show_id: null })
  ] });
  await openTab(app, '90day');
  assert.deepStrictEqual(app.writes(), [], 'opening the tab wrote nothing');
  assert.strictEqual(app.get("tabData['90day'].rows.length"), 2);
  const a = await app.applyCatalog('90day');
  assert.strictEqual(a.document.entries.filter(e => e.kind === 'insert_season' || e.kind === 'insert_film').length, defaults.length - 2);
  assert.ok(!a.document.entries.some(e => (e.kind === 'insert_season' || e.kind === 'insert_film') && (e.item_key === d0.k || e.item_key === d1.k)));
  assert.strictEqual(app.store.watchlist_items.filter(r => r.collection === '90day').length, defaults.length);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.item_key === d1.k).length, 1, 'no legacy twin of the identified row');
});

test('a fully seeded tab makes no write at all on load', async () => {
  const app0 = await createApp();
  await app0.applyCatalog('sheridan');
  const app = await createApp({ rows: app0.store.watchlist_items, tvShows: app0.store.tv_shows });
  await openTab(app, 'sheridan');
  assert.deepStrictEqual(app.writes(), []);
});

// ── Enriched (TMDB-matched) built-in shows ──
// A seeded Sheridan tab where Landman and Mayor of Kingstown have been matched to
// TMDB (identity only) and one built-in season of each is missing again.
async function enrichedSheridan() {
  const app0 = await createApp();
  await app0.applyCatalog('sheridan');
  const rows = app0.store.watchlist_items, shows = app0.store.tv_shows;
  const enrich = (key, tmdb) => {
    const show = shows.find(x => x.show_key === key);
    show.tmdb_id = tmdb;
    for (const r of rows.filter(x => x.show_id === show.id)) {
      const m = /^Season (\d+)$/.exec(r.season);
      if (m) Object.assign(r, { media_type: 'tv', tmdb_id: tmdb, season_number: Number(m[1]) });
    }
    return show;
  };
  const landman = enrich('landman', 157741), mayor = enrich('mayor of kingstown', 97951);
  const drop = new Set([rows.find(r => r.item_key === 'landman|season 3').id, rows.find(r => r.show_id === mayor.id && r.media_type == null).id]);
  const app = await createApp({ rows: rows.filter(r => !drop.has(r.id)), tvShows: shows });
  return { app, landman, mayor, showCount: shows.length };
}
test('a missing built-in season of a TMDB-matched show rejoins it as that TMDB season; a non-"Season N" one is excluded for review', async () => {
  const { app, landman, mayor, showCount } = await enrichedSheridan();
  await openTab(app, 'sheridan');
  assert.deepStrictEqual(app.writes(), [], 'opening the tab wrote nothing');
  const a = await app.applyCatalog('sheridan');
  const back = app.store.watchlist_items.find(r => r.item_key === 'landman|season 3');
  assert.ok(back && back.show_id === landman.id && back.tmdb_id === 157741 && back.season_number === 3 && back.media_type === 'tv', JSON.stringify(back));
  assert.ok(!app.store.watchlist_items.some(r => r.show_id === mayor.id && /Final/.test(r.season)), '"Season 5 (Final)" not added');
  assert.strictEqual(app.store.tv_shows.length, showCount, 'no second show');
  const excluded = a.document.entries.filter(e => e.kind === 'excluded_conflict');
  assert.ok(excluded.some(e => e.reason === 'enriched_show_label' && /^mayor of kingstown\|/.test(e.item_key)), JSON.stringify(excluded));
});
test('manual Add entry on a built-in tab: a plain "Season N" of a matched show joins it; "Season 4 (Part 1)" is refused for review', async () => {
  const { app, landman, showCount } = await enrichedSheridan();
  await app.applyCatalog('sheridan');
  await addManual(app, 'sheridan', 'Landman', 'Season 4');
  const s4 = app.store.watchlist_items.find(r => r.item_key === 'landman|season 4');
  assert.ok(s4 && s4.show_id === landman.id && s4.tmdb_id === 157741 && s4.season_number === 4, JSON.stringify(s4));
  await addManual(app, 'sheridan', 'Landman', 'Season 4 (Part 1)');
  assert.ok(!app.store.watchlist_items.some(r => r.item_key === 'landman|season 4 (part 1)'));
  assert.ok(/needs review/.test(banner(app)) && /only a plain/.test(banner(app)), banner(app));
  assert.strictEqual(app.store.tv_shows.length, showCount, 'no second show');
});

// ── Old season status stays authoritative ──
test('show status, Watched and Skip go through their functions; films keep direct PATCHes; no season status is ever written', async () => {
  const film = tv({ id: 'f', collection: 'truecrime', media_type: 'movie', season: 'Film', season_number: null, tmdb_id: 900, show_id: null, item_key: 'doc|film' });
  const app = await createApp({ rows: [tv({ id: 'a' }), film], tvShows: [show()] });
  await openTab(app, 'othertv');
  await app.ctx.setShowStatusById('s100', 'watching'); await settle();
  await app.ctx.toggleWatch('a'); await settle();
  await app.ctx.setSeasonSkipped('a', true); await settle();
  await app.ctx.setStatus('a', 'complete', null); await settle(); // a TV season has no row-level status: ignored
  await openTab(app, 'truecrime');
  await app.ctx.setStatus('f', 'watching', null); await settle();
  await app.ctx.toggleWatch('f'); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/set_show_status', 'POST rpc/set_season_watched', 'POST rpc/set_season_skipped', 'PATCH watchlist_items', 'PATCH watchlist_items']);
  assert.ok(!app.writes().some(r => r.body && r.url.includes('watchlist_items?id=eq.a')), 'no direct write to the TV season');
  assert.strictEqual(app.store.tv_shows[0].status, 'watching');
  const a = app.store.watchlist_items.find(r => r.id === 'a');
  assert.deepStrictEqual([a.watched, a.skipped, a.status], [true, true, 'confirmed']);
});

// ── Complete-show reopen and add outcomes (authoritative stage) ──
test('Refresh adding a genuinely new season to a Complete show reopens it On List, atomically, with a notice', async () => {
  const app = await createApp({ rows: [tv({ id: 'a', watched: true })], tvShows: [show({ status: 'complete' })] });
  await openTab(app, 'othertv');
  refreshSetup(app, [{ show: { title: 'Show', tmdb_id: 100 }, details: { networks: [] }, newOnes: [{ season_number: 2, air_date: '2027-01-01' }] }], [[0, 2]]);
  await app.ctx.addRefreshedSeasons(); await settle();
  assert.strictEqual(app.store.tv_shows[0].status, 'confirmed');
  assert.strictEqual(app.get("tvShowsById.get('s100').status"), 'confirmed', 'the page shows the reopened status');
  assert.ok(app.el('banner').innerHTML.includes('&quot;Show&quot; was Complete and got a new season'), app.el('banner').innerHTML);
  assert.strictEqual(banner(app), '');
});

test('a request whose seasons are all already listed: "Already on your list.", no reopen; a mix reports counts', async () => {
  const app = await createApp({ rows: [tv({ id: 'a' })], tvShows: [show({ status: 'complete' })] });
  await openTab(app, 'othertv');
  refreshSetup(app, [{ show: { title: 'Show', tmdb_id: 100 }, details: { networks: [] }, newOnes: [{ season_number: 1, air_date: '2020-01-01' }] }], [[0, 1]]);
  await app.ctx.addRefreshedSeasons(); await settle();
  assert.ok(banner(app).includes('Already on your list.'), banner(app));
  assert.strictEqual(app.store.tv_shows[0].status, 'complete', 'a duplicate is a no-op: no reopen');
  refreshSetup(app, [{ show: { title: 'Show', tmdb_id: 100 }, details: { networks: [] }, newOnes: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 3, air_date: '2028-01-01' }] }], [[0, 1], [0, 3]]);
  await app.ctx.addRefreshedSeasons(); await settle();
  assert.ok(banner(app).includes('Added 1 season; 1 already on your list.'), banner(app));
});

test('applying a catalog with a new built-in season reopens a Complete show; a Skipped show stays Skipped', async () => {
  const app0 = await createApp();
  await app0.applyCatalog('90day');
  const all = app0.store.watchlist_items, shows = app0.store.tv_shows;
  // Two multi-season shows: drop one season of each, mark one show Complete and the other Skipped.
  const multi = shows.filter(s => all.filter(r => r.show_id === s.id).length > 1).slice(0, 2);
  const [c, k] = multi;
  c.status = 'complete'; k.status = 'skipped';
  const gone = [all.find(r => r.show_id === c.id), all.find(r => r.show_id === k.id)].map(r => r.id);
  const app = await createApp({ rows: all.filter(r => !gone.includes(r.id)), tvShows: shows });
  await openTab(app, '90day');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === c.id).status, 'complete', 'opening the tab changed nothing');
  const a = await app.applyCatalog('90day');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === c.id).status, 'confirmed');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === k.id).status, 'skipped');
  assert.deepStrictEqual(a.document.entries.filter(e => e.kind === 'reopen').map(e => [e.show_id, e.from, e.to]), [[c.id, 'complete', 'confirmed']]);
});

T.run();
