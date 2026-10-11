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
async function refreshShows(app) {
  app.ctx.openLibraryPanel('tv', 'refresh'); await settle();
  await app.ctx.libraryRefreshShows(); await settle();
}
const pick = (app, picks) => {
  app.selectors['#tmdbPreview input[type="checkbox"][data-show-idx]'] = picks.map(([idx, season]) => ({ checked: true, dataset: { showIdx: String(idx), season: String(season) } }));
  app.selectors['#tmdbPreview input[type="checkbox"][data-update-idx]'] = [];
};
const tmdbShows = shows => p => {
  const m = /^\/tv\/(\d+)$/.exec(p);
  return m && shows[m[1]] ? { id: +m[1], networks: [{ name: 'HBO' }], ...shows[m[1]] } : undefined;
};

// ── New shows and seasons by hand ──
test('a new show by hand → library_create_show (no identity, the season linked); a second season goes to that show through library_add_seasons', async () => {
  const app = await createApp();
  await allTv(app);
  await newShowByHand(app, 'ZZ Manual', 'Season 1');
  assert.deepStrictEqual(writes(app), ['POST rpc/library_create_show']);
  const body = app.writes()[0].body;
  assert.deepStrictEqual(out(body.p_show), { tmdb_id: null, title: 'ZZ Manual', show_key: 'zz manual', network: 'HBO', distinct_from: [] });
  assert.deepStrictEqual(out(body.p_seasons), [{ item_key: 'zz manual|season 1', title: 'ZZ Manual', season: 'Season 1', theme: 'HBO',
    display_date: 'Jan 1, 2027', date_sort: '2027-01-01' }]);
  const created = app.store.tv_shows.find(s => s.show_key === 'zz manual');
  await addSeasonByHand(app, created.id, 'Season 2');
  assert.deepStrictEqual(writes(app), ['POST rpc/library_create_show', 'POST rpc/library_add_seasons']);
  const rows = app.store.watchlist_items.filter(r => r.title === 'ZZ Manual');
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every(r => r.show_id === created.id), 'both seasons on one show');
  assert.deepStrictEqual(Array.from(rows, r => r.status), ['confirmed', 'confirmed']);
  assert.strictEqual(app.store.tv_shows.length, 1);
  assert.strictEqual(banner(app), '');
  noStorage(app);
});

test('a season added by hand to the catalog’s "The Clone Wars" joins that show (its overridden show key), never a second show', async () => {
  const app = await createApp();
  await app.applyCatalog('disney'); // the owner applied the Disney+ catalog
  await allTv(app);
  const cw = app.store.tv_shows.filter(s => s.show_key === 'star wars: the clone wars (2008)');
  assert.strictEqual(cw.length, 1);
  await addSeasonByHand(app, cw[0].id, 'Season 8');
  const call = app.writes().find(r => r.url.endsWith('/rpc/library_add_seasons'));
  assert.strictEqual(call.body.p_show_id, cw[0].id);
  assert.deepStrictEqual(out(call.body.p_expected), { tmdb_id: null, show_key: 'star wars: the clone wars (2008)', catalog: 'disney', network: '' });
  const s8 = app.store.watchlist_items.find(r => r.show_id === cw[0].id && r.season === 'Season 8');
  assert.ok(s8, 'joined the show');
  assert.strictEqual(app.store.tv_shows.filter(s => s.show_key === 'star wars: the clone wars (2008)').length, 1);
});

test('a film by hand → library_create_film, never linked to a show', async () => {
  const app = await createApp();
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openLibraryPanel('movie', 'manual'); await settle();
  app.el('nTitle').value = 'ZZ Doc'; app.el('nTheme').value = 'Documentary'; app.el('nDate').value = 'Jan 1, 2027';
  await app.ctx.libraryManualFilm(); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_create_film']);
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
  assert.ok(app.el('tmdbPreview').innerHTML.includes('nothing to refresh'), 'Refresh finds no show to check');
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

test('deleting a film is a plain DELETE; × on a catalog season skips it (set_season_skipped); × on a catalog film is the skipped PATCH', async () => {
  const film = tv({ id: 'm', collection: 'movies', media_type: 'movie', season: 'Film', season_number: null, show_id: null, item_key: 'film|film', tmdb_id: 77 });
  const app = await createApp({ rows: [film] });
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.confirm = () => true;
  await app.ctx.delRowInView('m'); await settle();
  assert.deepStrictEqual(writes(app), ['DELETE watchlist_items']);
  const app0 = await createApp();
  await app0.applyCatalog('disney');
  const app2 = await createApp({ rows: app0.store.watchlist_items, tvShows: app0.store.tv_shows });
  app2.ctx.confirm = () => true;
  const def = app2.store.watchlist_items.find(r => r.season !== 'Film' && !r.skipped);
  const defFilm = app2.store.watchlist_items.find(r => r.season === 'Film' && r.status !== 'skipped');
  await allTv(app2);
  await app2.ctx.delRowInView(def.id); await settle();
  app2.ctx.switchMediaType('movie'); await settle();
  app2.el('fStatus').value = 'all'; app2.el('fWatch').value = ''; app2.ctx.renderTable();
  await app2.ctx.delRowInView(defFilm.id); await settle();
  assert.deepStrictEqual(writes(app2), ['POST rpc/set_season_skipped', 'PATCH watchlist_items'], 'the views wrote nothing else');
  const stored = id => app2.store.watchlist_items.find(r => r.id === id);
  assert.strictEqual(stored(def.id).skipped, true, 'the season is skipped, nothing deleted');
  assert.strictEqual(stored(defFilm.id).status, 'skipped');
  assert.strictEqual(app2.store.watchlist_items.length, app2.get("COLLECTIONS.find(c => c.id === 'disney').defaults.length"));
});

// ── Refresh shows ──
test('Refresh shows → one library_add_seasons per show; new seasons link to the existing show; statuses untouched', async () => {
  const app = await createApp({
    rows: [tv({ id: 'a', status: 'watching' }), tv({ id: 'o', title: 'Other', tmdb_id: 200, item_key: 'other|season 1', show_id: 's200' })],
    tvShows: [show({ status: 'watching' }), show({ id: 's200', title: 'Other', show_key: 'other', tmdb_id: 200 })],
    tmdb: tmdbShows({ 100: { name: 'Show', seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2027-01-01' }, { season_number: 3, air_date: null }] },
      200: { name: 'Other', networks: [], seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2026-01-01' }] } }) });
  await allTv(app);
  await refreshShows(app);
  const found = app.get('libraryPanel.refresh.found').map(f => f.show.id);
  pick(app, [[found.indexOf('s100'), 2], [found.indexOf('s100'), 3], [found.indexOf('s200'), 2]]);
  await app.ctx.libraryApplyRefresh(); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_add_seasons', 'POST rpc/library_add_seasons']);
  const byShow = Object.fromEntries(app.writes().map(r => [r.body.p_show_id, r.body]));
  assert.deepStrictEqual(Array.from(byShow.s100.p_seasons, s => [s.item_key, s.season_number, s.date_sort]),
    [['show|season 2', 2, '2027-01-01'], ['show|season 3', 3, '2099-01-01']]);
  assert.deepStrictEqual(out(byShow.s200.p_expected), { tmdb_id: 200, show_key: 'other', catalog: null, network: 'Unknown' });
  const rows = app.store.watchlist_items;
  assert.ok(rows.filter(r => r.tmdb_id === 100).every(r => r.show_id === 's100'));
  assert.strictEqual(rows.find(r => r.id === 'a').status, 'watching', 'the existing season keeps its status');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === 's100').status, 'watching', 'no reopen, no status change');
  assert.strictEqual(banner(app), '');
  noStorage(app);
});

test('Refresh shows with a season added elsewhere meanwhile → the others are added; the one already there is reported, never added twice', async () => {
  const app = await createApp({ rows: [tv({ id: 'a' })], tvShows: [show()],
    tmdb: tmdbShows({ 100: { name: 'Show', seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2027-01-01' }, { season_number: 3, air_date: '2028-01-01' }] } }) });
  await allTv(app);
  await refreshShows(app);
  pick(app, [[0, 2], [0, 3]]);
  app.store.watchlist_items.push(tv({ id: 'z', season_number: 2, season: 'Season 2', item_key: 'show|season 2' }));
  await app.ctx.libraryApplyRefresh(); await settle();
  assert.match(outcome(app), /already on your list/);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.season_number === 3).length, 1);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.season_number === 2).length, 1, 'no duplicate');
});

test('Refresh shows checks the identified shows no catalog governs, from the library read (never the old tracking table); shows without an identity are skipped', async () => {
  const legacyShow = { id: 's200', collection: 'othertv', title: 'Legacy', show_key: 'legacy', tmdb_id: null, status: 'confirmed' };
  const app = await createApp({ rows: [tv({ id: 'a' }), legacy({ id: 'l', title: 'Legacy', item_key: 'legacy|season 1', show_id: 's200' })],
    tvShows: [show(), legacyShow], othertvShows: [],
    tmdb: tmdbShows({ 100: { name: 'Show', seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2027-01-01' }] } }) });
  await allTv(app);
  const before = app.requests.length;
  await refreshShows(app);
  const reads = app.requests.slice(before).filter(r => r.method === 'GET').map(r => r.url.split('/rest/v1/')[1] || r.url);
  assert.ok(!reads.some(u => u.startsWith('othertv_shows')), 'the old tracking table is not read');
  const tmdbCalls = app.requests.slice(before).filter(r => !r.url.includes('/rest/v1/')).map(r => r.url);
  assert.ok(tmdbCalls.length === 1 && tmdbCalls[0].includes('/tv/100'), 'only the identified show is looked up');
  const found = app.get('libraryPanel.refresh.found');
  assert.strictEqual(found.length, 1);
  assert.deepStrictEqual(Array.from(found[0].fresh, s => s.season_number), [2]);
  assert.strictEqual(found[0].show.title, 'Show');
  assert.deepStrictEqual(app.writes(), [], 'the preview writes nothing');
});

// ── TMDB search add ──
test('TMDB search: a film goes through library_add_films; a series through library_create_show; the old tracking table is never written', async () => {
  const app = await createApp({ tmdb: p => (p === '/movie/9' ? { id: 9, title: 'Doc Film', release_date: '2020-02-02', genres: [{ name: 'Documentary' }] } : undefined) });
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openLibraryPanel('movie'); await settle();
  app.run(`tmdbSelectedShow = { id: 9, name: 'Doc Film', mediaType: 'movie', details: { title: 'Doc Film', genres: [{ name: 'Documentary' }], release_date: '2020-02-02' } };`);
  app.run(`libraryPanel.choice = { tmdbId: 9, mediaType: 'movie', route: { kind: 'new' } };`);
  await app.ctx.libraryChoose(9, 'movie', null, true); await settle();
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_add_films']);
  app.ctx.switchMediaType('tv'); await allTv(app);
  app.ctx.openLibraryPanel('tv'); await settle();
  app.run(`tmdbSelectedShow = { id: 10, name: 'Doc Series', mediaType: 'tv', details: { name: 'Doc Series', networks: [{ name: 'Netflix' }], seasons: [{ season_number: 1, air_date: '2021-03-03' }] } };`);
  await app.ctx.libraryChoose(10, 'tv', null, true); await settle();
  app.el('tmdbPreview').querySelectorAll = sel => (sel.includes('data-season') ? [{ checked: true, disabled: false, dataset: { season: '1' } }] : []);
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_add_films', 'POST rpc/library_create_show']);
  const series = app.store.watchlist_items.find(r => r.tmdb_id === 10);
  assert.ok(series && series.show_id);
  assert.ok(app.store.watchlist_items.find(r => r.tmdb_id === 9).show_id == null);
  assert.ok(app.store.tv_shows.some(s => s.tmdb_id === 10), 'an identified show, which Refresh shows checks');
  assert.deepStrictEqual(app.store.othertv_shows, [], 'the old tracking table is not written');
  noStorage(app);
});

// ── Catalog entries arrive only through an explicit application ──
test('no view seeds; an explicit catalog application adds only the entries missing by the old rule; a key held by an identified row is not re-added', async () => {
  const app0 = await createApp();
  const defaults = app0.get("COLLECTIONS.find(c => c.id === '90day').defaults");
  const [d0, d1] = defaults;
  const app = await createApp({ rows: [
    legacy({ id: 'l0', collection: '90day', item_key: d0.k, title: d0.t, season: d0.s, show_id: null }),
    tv({ id: 'i1', collection: '90day', item_key: d1.k, title: d1.t, tmdb_id: 4242, season_number: Number(/\d+/.exec(d1.s)[0]), season: d1.s, show_id: null })
  ] });
  for (const v of ['alltv', 'comingsoon', 'watching']) { app.ctx.switchView(v); await settle(); }
  app.ctx.openBrowseCollection(app.browseId('90day')); await settle();
  assert.deepStrictEqual(app.writes(), [], 'no view wrote anything');
  const a = await app.applyCatalog('90day');
  assert.strictEqual(a.document.entries.filter(e => e.kind === 'insert_season' || e.kind === 'insert_film').length, defaults.length - 2);
  assert.ok(!a.document.entries.some(e => (e.kind === 'insert_season' || e.kind === 'insert_film') && (e.item_key === d0.k || e.item_key === d1.k)));
  assert.strictEqual(app.store.watchlist_items.filter(r => r.collection === '90day').length, defaults.length);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.item_key === d1.k).length, 1, 'no legacy twin of the identified row');
});

// ── Enriched (TMDB-matched) catalog shows ──
// An applied Sheridan catalog where Landman and Mayor of Kingstown have been
// matched to TMDB (identity only) and one catalog season of each is missing again.
async function enrichedSheridan() {
  const app0 = await createApp();
  await app0.applyCatalog('sheridan');
  const rows = app0.store.watchlist_items, shows = app0.store.tv_shows;
  const enrich = (key, tmdb) => {
    const s = shows.find(x => x.show_key === key);
    s.tmdb_id = tmdb;
    for (const r of rows.filter(x => x.show_id === s.id)) {
      const m = /^Season (\d+)$/.exec(r.season);
      if (m) Object.assign(r, { media_type: 'tv', tmdb_id: tmdb, season_number: Number(m[1]) });
    }
    return s;
  };
  const landman = enrich('landman', 157741), mayor = enrich('mayor of kingstown', 97951);
  const drop = new Set([rows.find(r => r.item_key === 'landman|season 3').id, rows.find(r => r.show_id === mayor.id && r.media_type == null).id]);
  const app = await createApp({ rows: rows.filter(r => !drop.has(r.id)), tvShows: shows });
  return { app, landman, mayor, showCount: shows.length };
}
test('a missing catalog season of a TMDB-matched show rejoins it as that TMDB season; a non-"Season N" one is excluded for review', async () => {
  const { app, landman, mayor, showCount } = await enrichedSheridan();
  await allTv(app);
  assert.deepStrictEqual(app.writes(), [], 'the view wrote nothing');
  const a = await app.applyCatalog('sheridan');
  const back = app.store.watchlist_items.find(r => r.item_key === 'landman|season 3');
  assert.ok(back && back.show_id === landman.id && back.tmdb_id === 157741 && back.season_number === 3 && back.media_type === 'tv', JSON.stringify(back));
  assert.ok(!app.store.watchlist_items.some(r => r.show_id === mayor.id && /Final/.test(r.season)), '"Season 5 (Final)" not added');
  assert.strictEqual(app.store.tv_shows.length, showCount, 'no second show');
  const excluded = a.document.entries.filter(e => e.kind === 'excluded_conflict');
  assert.ok(excluded.some(e => e.reason === 'enriched_show_label' && /^mayor of kingstown\|/.test(e.item_key)), JSON.stringify(excluded));
});
test('a season added by hand to a governed TMDB-matched show: a plain "Season N" joins it as that TMDB season; "Season 4 (Part 1)" is held for review', async () => {
  const { app, landman, showCount } = await enrichedSheridan();
  await app.applyCatalog('sheridan');
  await allTv(app);
  await addSeasonByHand(app, landman.id, 'Season 4');
  const s4 = app.store.watchlist_items.find(r => r.item_key === 'landman|season 4');
  assert.ok(s4 && s4.show_id === landman.id && s4.tmdb_id === 157741 && s4.season_number === 4, JSON.stringify(s4));
  await addSeasonByHand(app, landman.id, 'Season 4 (Part 1)');
  assert.ok(!app.store.watchlist_items.some(r => r.item_key === 'landman|season 4 (part 1)'));
  assert.match(outcome(app), /needs review/);
  assert.strictEqual(app.store.tv_shows.length, showCount, 'no second show');
});

// ── Show status, Watched and Skip ──
test('show status, Watched and Skip go through their functions; films keep direct PATCHes; no season status is ever written', async () => {
  const film = tv({ id: 'f', collection: 'truecrime', media_type: 'movie', season: 'Film', season_number: null, tmdb_id: 900, show_id: null, item_key: 'doc|film' });
  const app = await createApp({ rows: [tv({ id: 'a' }), film], tvShows: [show()] });
  await allTv(app);
  await app.ctx.setShowStatusById('s100', 'watching'); await settle();
  await app.ctx.toggleWatch('a'); await settle();
  await app.ctx.setSeasonSkipped('a', true); await settle();
  await app.ctx.setStatus('a', 'complete', null); await settle(); // a TV season has no row-level status: ignored
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fStatus').value = 'all'; app.el('fWatch').value = ''; app.ctx.renderTable();
  await app.ctx.setStatus('f', 'watching', null); await settle();
  await app.ctx.toggleWatch('f'); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/set_show_status', 'POST rpc/set_season_watched', 'POST rpc/set_season_skipped', 'PATCH watchlist_items', 'PATCH watchlist_items']);
  assert.ok(!app.writes().some(r => r.body && r.url.includes('watchlist_items?id=eq.a')), 'no direct write to the TV season');
  assert.strictEqual(app.store.tv_shows[0].status, 'watching');
  const a = app.store.watchlist_items.find(r => r.id === 'a');
  assert.deepStrictEqual([a.watched, a.skipped, a.status], [true, true, 'confirmed']);
});

// ── Complete-show reopen and add outcomes ──
test('Refresh adding a genuinely new season to a Complete show reopens it On List, atomically, and says so', async () => {
  const app = await createApp({ rows: [tv({ id: 'a', watched: true })], tvShows: [show({ status: 'complete' })],
    tmdb: tmdbShows({ 100: { name: 'Show', seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2027-01-01' }] } }) });
  await allTv(app);
  await refreshShows(app);
  pick(app, [[0, 2]]);
  await app.ctx.libraryApplyRefresh(); await settle();
  assert.strictEqual(app.store.tv_shows[0].status, 'confirmed');
  assert.match(outcome(app), /“Show” was Complete and is back On List\./);
  assert.strictEqual(banner(app), '');
});

test('a season that is already listed by the time it is sent: reported, no reopen', async () => {
  const app = await createApp({ rows: [tv({ id: 'a' })], tvShows: [show({ status: 'complete' })],
    tmdb: tmdbShows({ 100: { name: 'Show', seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 3, air_date: '2028-01-01' }] } }) });
  await allTv(app);
  // A request racing with another page: Season 3 arrives elsewhere after the preview.
  await refreshShows(app);
  pick(app, [[0, 3]]);
  app.store.watchlist_items.push(tv({ id: 'z3', season_number: 3, season: 'Season 3', item_key: 'show|season 3' }));
  await app.ctx.libraryApplyRefresh(); await settle();
  assert.match(outcome(app), /already on your list/);
  assert.strictEqual(app.store.tv_shows[0].status, 'complete', 'a duplicate is a no-op: no reopen');
});

test('applying a catalog with a new catalog season reopens a Complete show; a Skipped show stays Skipped', async () => {
  const app0 = await createApp();
  await app0.applyCatalog('90day');
  const all = app0.store.watchlist_items, shows = app0.store.tv_shows;
  // Two multi-season shows: drop one season of each, mark one show Complete and the other Skipped.
  const multi = shows.filter(s => all.filter(r => r.show_id === s.id).length > 1).slice(0, 2);
  const [c, k] = multi;
  c.status = 'complete'; k.status = 'skipped';
  const gone = [all.find(r => r.show_id === c.id), all.find(r => r.show_id === k.id)].map(r => r.id);
  const app = await createApp({ rows: all.filter(r => !gone.includes(r.id)), tvShows: shows });
  await allTv(app);
  assert.strictEqual(app.store.tv_shows.find(s => s.id === c.id).status, 'complete', 'opening the view changed nothing');
  const a = await app.applyCatalog('90day');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === c.id).status, 'confirmed');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === k.id).status, 'skipped');
  assert.deepStrictEqual(a.document.entries.filter(e => e.kind === 'reopen').map(e => [e.show_id, e.from, e.to]), [[c.id, 'complete', 'confirmed']]);
});

T.run();
