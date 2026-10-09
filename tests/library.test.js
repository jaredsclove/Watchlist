// Offline tests for Stage 4b, the library without sources (library.js and the
// views that use it), in the whole-page harness: no storage tabs, badges or Source
// filters; the "+ Add" panel's routing (a show already on the list, ambiguous and
// similar results, new shows and films) and the exact requests it sends; the three
// ways of adding to an existing show and the parent check of every answer; a show
// changed or gone (refused by the database, never recreated); a database without
// the function (no fallback); unclear answers (never resent); a restore or a view
// change while a request is out; Refresh shows (one call per show, partial results
// kept); collections after a creation (a separate step); Year; duplicates; All
// Movies' and All TV's actions; Catalog updates from the Browse bar.
// The database function itself is checked on PGlite (db/test/t_4b_add_to_show.sql,
// tools/db-rehearsal-4b.mjs); the harness's add_tv_seasons_to_show is an
// independent stand-in.
// Run from the repo root: node tests/library.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('library');
const test = T.test;

let n = 0;
const nid = p => `${p}-${String(++n).padStart(4, '0')}`;
// A show and its seasons. Season specs: { num (TMDB season), label, w, s, date, display, key }.
function show(o, specs) {
  const s = { id: nid('show'), collection: 'othertv', title: 'Show', tmdb_id: null, status: 'confirmed', ...o };
  s.show_key = o.show_key || s.title.toLowerCase();
  const rows = specs.map((sp, i) => {
    const label = sp.label || (sp.num === 0 ? 'Specials' : `Season ${sp.num ?? i + 1}`);
    return { id: nid('r'), collection: s.collection, title: s.title, theme: 'Net', status: 'confirmed', watched: !!sp.w, skipped: !!sp.s,
      show_id: s.id, media_type: s.tmdb_id != null ? 'tv' : null, tmdb_id: s.tmdb_id, season_number: s.tmdb_id != null ? (sp.num ?? i + 1) : null,
      season: label, display_date: sp.display || 'Jan 1, 2020', date_sort: sp.date || `202${i}-01-01`, item_key: sp.key || `${s.show_key}|${label.toLowerCase()}`,
      watch_with: [], collections: [] };
  });
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'movies', title: 'Film', theme: 'Drama', status: 'confirmed', watched: false,
  media_type: 'movie', tmdb_id: null, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) });

// TMDB: two searches and details by id.
const TMDB = {
  '/tv/95396': { id: 95396, name: 'Severance', networks: [{ name: 'Apple TV' }], seasons: [
    { season_number: 1, air_date: '2022-02-18', episode_count: 9 }, { season_number: 2, air_date: '2025-01-17', episode_count: 10 },
    { season_number: 3, air_date: null, episode_count: 0 }] },
  '/tv/153312': { id: 153312, name: 'Tulsa King', networks: [{ name: 'Paramount+' }], seasons: [
    { season_number: 1, air_date: '2022-11-13', episode_count: 9 }, { season_number: 2, air_date: '2024-09-15', episode_count: 10 }] },
  '/tv/136315': { id: 136315, name: 'The Bear', networks: [{ name: 'FX' }], seasons: [{ season_number: 1, air_date: '2022-06-23', episode_count: 8 }, { season_number: 9, air_date: null, episode_count: 0 }] },
  '/tv/777': { id: 777, name: 'Brand New', networks: [{ name: 'HBO' }], seasons: [{ season_number: 1, air_date: '2026-01-01', episode_count: 6 }, { season_number: 2, air_date: null, episode_count: 0 }] },
  '/tv/888': { id: 888, name: 'Local Show', networks: [{ name: 'BBC' }], seasons: [{ season_number: 1, air_date: '2019-01-01', episode_count: 6 }] },
  '/movie/999': { id: 999, title: 'New Film', release_date: '2026-05-01', genres: [{ name: 'Comedy' }], belongs_to_collection: null },
  '/movie/438631': { id: 438631, title: 'Dune', release_date: '2021-09-15', genres: [{ name: 'Science Fiction' }], belongs_to_collection: { id: 726871, name: 'Dune Collection' } },
  '/movie/555': { id: 555, title: 'Lamp Light', release_date: '2020-01-01', genres: [{ name: 'Drama' }], belongs_to_collection: null },
  '/collection/726871': { id: 726871, name: 'Dune Collection', parts: [{ id: 438631, title: 'Dune', release_date: '2021-09-15' }, { id: 693134, title: 'Dune: Part Two', release_date: '2024-02-27' }] },
  '/movie/693134': { id: 693134, title: 'Dune: Part Two', release_date: '2024-02-27', genres: [{ name: 'Science Fiction' }], belongs_to_collection: { id: 726871, name: 'Dune Collection' } },
  '/person/42/movie_credits': { crew: [{ id: 438631, title: 'Dune', job: 'Director', release_date: '2021-09-15' }, { id: 693134, title: 'Dune: Part Two', job: 'Director', release_date: '2024-02-27' }], cast: [] }
};
const tmdb = p => {
  if (p.startsWith('/search/')) {
    const q = decodeURIComponent((p.match(/query=([^&]*)/) || [])[1] || '').toLowerCase();
    const tv = Object.values(TMDB).filter(x => x.name && x.name.toLowerCase().includes(q)).map(x => ({ id: x.id, name: x.name, first_air_date: '2022-01-01' }));
    const mv = Object.values(TMDB).filter(x => x.title && x.title.toLowerCase().includes(q)).map(x => ({ id: x.id, title: x.title, release_date: x.release_date }));
    return { results: p.startsWith('/search/tv') ? tv : mv };
  }
  return TMDB[p];
};

function library() {
  return all(
    show({ title: 'Severance', tmdb_id: 95396, status: 'watching' }, [{ num: 1, w: true }, { num: 2 }]),                       // identified, dynamic storage
    show({ title: 'Tulsa King', collection: 'sheridan', tmdb_id: 153312 }, [{ num: 1 }]),                                        // identified, built-in (enriched)
    show({ title: 'Andor', collection: 'disney' }, [{ label: 'Season 1' }]),                                                     // legacy, built-in
    show({ title: 'Local Show' }, [{ label: 'Season 1', date: '2019-01-01' }]),                                                  // legacy, dynamic (Match-eligible)
    show({ title: 'The Bear', collection: 'disney', tmdb_id: 136315 }, [{ num: 1 }]),                                            // one identity, two records
    show({ title: 'The Bear', show_key: 'the bear', tmdb_id: 136315, status: 'watching' }, [{ num: 1 }]),
    film({ id: 'f-dune', title: 'Dune', tmdb_id: 438631, tmdb_collection_id: 726871, tmdb_collection_name: 'Dune Collection', collections: ['Dune Collection'], date_sort: '2021-09-15' }),
    film({ id: 'f-lamp', title: 'Lamp Light', collection: 'disney', media_type: null, item_key: 'lamp light|film', date_sort: '2019-06-01' }),
    film({ id: 'f-man', title: 'Manual Film', media_type: null, item_key: 'manual film|film', date_sort: '2018-02-02' })
  );
}

async function boot(data = library(), opts = {}) { return createApp({ rows: data.rows, tvShows: data.shows, tmdb, ...opts }); }
const showOf = (app, title, coll) => app.store.tv_shows.find(s => s.title === title && (!coll || s.collection === coll));
const rpc = (app, name) => app.requests.filter(r => r.method === 'POST' && r.url.endsWith(`/rpc/${name}`));
const writes = app => app.writes().map(r => `${r.method} ${r.url.split('/rest/v1/')[1].split('?')[0]}`);
const outcome = app => (app.el('libraryOutcome')?.innerHTML || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const preview = app => app.el('tmdbPreview').innerHTML.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const banners = app => (app.el('banner').innerHTML + app.el('errorBanner').innerHTML + app.el('noticeBanner').innerHTML).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
async function openPanel(app, media = 'tv', mode) {
  app.ctx.openLibraryPanel(media); await settle();
  if (mode) { app.ctx.setLibraryMode(mode); await settle(); }
}
async function choose(app, id, name, type = 'tv') {
  app.el('tmdbQuery').value = name; await app.ctx.searchTMDB(); await settle();
  await app.ctx.selectTMDBShow(id, name, type, `tmdbResult_0_${id}`); await settle();
}
const tick = (app, nums) => { app.el('tmdbPreview').querySelectorAll = sel => (sel.includes('data-season') ? nums.map(x => ({ checked: true, disabled: false, dataset: { season: String(x) } })) : []); };
const type = (app, values) => Object.entries(values).forEach(([id, v]) => { app.el(id).value = v; });
async function allTv(app) { app.ctx.switchView('alltv'); await settle(); }
// A held request that is never sent fails the test instead of leaving it waiting.
const reached = gate => Promise.race([gate.reached, new Promise((_, no) => setTimeout(() => no(new Error('the held request was never sent')), 3000))]);

// ─── No sources on the page ───────────────────────────────────────────────────
test('the tab bars hold only the views; the Browse bar offers Catalog updates; no Source filter or storage badge in any view', async () => {
  const app = await boot();
  for (const [media, views] of [['tv', ['watching', 'alltv', 'comingsoon']], ['movie', ['allmovies']]]) {
    app.ctx.switchMediaType(media); await settle();
    const bar = app.el('tabBar').innerHTML;
    assert.deepStrictEqual([...bar.matchAll(/switchView\('([^']+)'\)/g)].map(m => m[1]), views);
    assert.ok(!bar.includes('switchTab(') && !bar.includes('legacy'));
    assert.ok(app.el('browseBar').innerHTML.includes('onclick="openCatalogChooser(this)"'));
    for (const v of views) {
      app.ctx.switchView(v); await settle();
      const page = app.el('filtersRow').innerHTML + app.el('tableHead').innerHTML + app.html();
      assert.ok(!/fSource|source-badge|Stored in|All TV sources|All sources/.test(page), `${v} shows no storage`);
      assert.ok(app.el('filtersRow').innerHTML.includes(`openLibraryPanel('${media}')`), `${v} has + Add`);
    }
  }
  app.ctx.openBrowseCollection(app.browseId('sheridan')); await settle();
  assert.ok(!/source-badge|Stored in/.test(app.html()) && app.el('viewHead').innerHTML.includes('Change shows in All TV and films in All Movies'));
  assert.deepStrictEqual(app.writes(), []);
});

test('opening every view, the + Add panel in each mode and the Catalog updates chooser only reads', async () => {
  const app = await boot();
  for (const v of ['watching', 'alltv', 'comingsoon']) {
    app.ctx.switchView(v); await settle();
    for (const m of ['search', 'manual', 'refresh']) await openPanel(app, 'tv', m);
  }
  app.ctx.switchMediaType('movie'); await settle();
  for (const m of ['search', 'manual', 'tools']) await openPanel(app, 'movie', m);
  app.ctx.openCatalogChooser(null); await settle();
  assert.match(app.el('catalogModalBox').innerHTML, /Disney\+ catalog[\s\S]*90 Day catalog[\s\S]*Sheridan catalog/);
  assert.match(app.el('catalogModalBox').innerHTML, /entries not in your list yet|Nothing waiting/);
  app.ctx.closeCatalogChooser(); await settle();
  assert.deepStrictEqual(app.writes(), [], 'GET only');
});

// ─── The editing rules (unchanged) ────────────────────────────────────────────
test('editing rules and add kinds reproduce the tabs exactly: catalog entries skip, Match only for unidentified rows outside the catalogs', async () => {
  const probe = await createApp();
  const defSeason = probe.get("COLLECTIONS.find(c => c.id === 'disney').defaults.find(d => d.s !== 'Film')");
  const defFilm = probe.get("COLLECTIONS.find(c => c.id === 'disney').defaults.find(d => d.s === 'Film')");
  const app = await boot();
  const P = r => app.ctx.editPolicyOf(r);
  const base = { collection: 'disney', media_type: null, tmdb_id: null, season_number: null, show_id: 'x' };
  assert.strictEqual(P({ ...base, item_key: defSeason.k, season: defSeason.s }).deleteEffect, 'skip');
  assert.strictEqual(P({ ...base, item_key: defFilm.k, season: 'Film', show_id: null }).deleteEffect, 'skip-film');
  assert.strictEqual(P({ ...base, item_key: 'not in the catalog|season 1', season: 'Season 1' }).deleteEffect, 'delete', 'built-in storage alone is not a catalog entry');
  assert.strictEqual(P({ ...base, item_key: 'x|season 1', season: 'Season 1' }).matchable, false, 'no Match in built-in storage');
  assert.strictEqual(P({ ...base, collection: 'othertv', item_key: 'x|season 1', season: 'Season 1' }).matchable, true);
  assert.strictEqual(app.ctx.showAddKind(showOf(app, 'Severance')), 'tmdb');
  assert.strictEqual(app.ctx.showAddKind(showOf(app, 'Tulsa King')), 'label');
  assert.strictEqual(app.ctx.showAddKind(showOf(app, 'Andor')), 'label');
  assert.strictEqual(app.ctx.catalogListingOf({ collection: 'disney', show_key: 'zz not in any catalog' }), null, 'stored with a catalog is not listed by it');
  assert.strictEqual(app.ctx.catalogListingOf({ collection: 'othertv', show_key: 'andor' }), null, 'no catalog outside the built-in ones');
  const listed = probe.get(`tvShowKey('disney', COLLECTIONS.find(c => c.id === 'disney').defaults.find(d => d.s !== 'Film').k)`);
  assert.strictEqual(app.ctx.catalogListingOf({ collection: 'disney', show_key: listed }), 'Disney+');
});

// ─── Adding to a show already on the list ─────────────────────────────────────
test('a TMDB result already on the list (identified, outside the catalogs): its seasons go to that show through add_tv_seasons_to_show', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app);
  await choose(app, 95396, 'Severance');
  const sev = showOf(app, 'Severance');
  assert.match(preview(app), /Adds seasons to “Severance”, already on your list/);
  assert.match(app.el('tmdbPreview').innerHTML, /data-season="1"[^>]*>[\s\S]*Already added/);
  tick(app, [3]);
  const before = app.store.tv_shows.length;
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  const [call] = rpc(app, 'add_tv_seasons_to_show');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(call.body)), { p_show_id: sev.id, p_expected: { collection: 'othertv', tmdb_id: 95396, show_key: 'severance', network: 'Apple TV' },
    p_seasons: [{ item_key: 'severance|season 3', title: 'Severance', season: 'Season 3', theme: 'Apple TV', display_date: 'TBA', date_sort: '2099-01-01', season_number: 3 }] });
  assert.strictEqual(rpc(app, 'add_tv_seasons').length, 0, 'never the create path');
  assert.strictEqual(app.store.tv_shows.length, before);
  assert.ok(app.store.watchlist_items.some(r => r.show_id === sev.id && r.season_number === 3));
  assert.match(outcome(app), /Added “Season 3” to “Severance”\./);
  assert.ok(!outcome(app).includes('collections'), 'no membership offer: nothing was created');
});

test('a TMDB result whose show is a built-in, TMDB-matched show: no TMDB add; Add season by hand sends a label season, which joins as TMDB season N', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app);
  await choose(app, 153312, 'Tulsa King');
  assert.match(preview(app), /“Tulsa King” is already on your list\. TMDB seasons can’t be added to it here/);
  assert.ok(!preview(app).includes('Catalog updates will'), 'no promise that a catalog supplies its seasons');
  assert.ok(!app.el('tmdbPreview').innerHTML.includes('addSelectedTMDBSeasons'), 'no TMDB add offered');
  const tk = showOf(app, 'Tulsa King');
  app.ctx.openAddSeason(tk.id); await settle(); await settle();
  type(app, { nSeason: 'Season 2', nDate: 'Sep 15, 2024', nTheme: 'Paramount+' });
  await app.ctx.librarySubmitSeason(); await settle();
  const [call] = rpc(app, 'add_tv_seasons_to_show');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(call.body.p_expected)), { collection: 'sheridan', tmdb_id: 153312, show_key: 'tulsa king', network: '' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(call.body.p_seasons)), [{ item_key: 'tulsa king|season 2', title: 'Tulsa King', season: 'Season 2', theme: 'Paramount+', display_date: 'Sep 15, 2024', date_sort: '2024-09-15' }]);
  const added = app.store.watchlist_items.find(r => r.show_id === tk.id && r.season === 'Season 2');
  assert.ok(added && added.season_number === 2 && added.tmdb_id === 153312, 'the enriched-show join made it season 2');
  assert.match(outcome(app), /Added “Season 2” to “Tulsa King”/);
});

test('a built-in TMDB-matched show: a nonstandard label is held for review and reported as not added', async () => {
  const app = await boot();
  await allTv(app);
  app.ctx.openAddSeason(showOf(app, 'Tulsa King').id); await settle(); await settle();
  type(app, { nSeason: 'Season 2 (Part 1)', nDate: 'TBA 2027', nTheme: '' });
  await app.ctx.librarySubmitSeason(); await settle();
  assert.match(outcome(app), /Nothing new was added to “Tulsa King”\. “Season 2 \(Part 1\)” wasn’t added: this show takes plain “Season N” labels, so it needs review\./);
  assert.ok(!app.store.watchlist_items.some(r => r.season === 'Season 2 (Part 1)'));
});

test('a legacy show (built-in or not): Add season by hand joins it by its stored key; no identity is guessed', async () => {
  const app = await boot();
  await allTv(app);
  for (const title of ['Andor', 'Local Show']) {
    const s = showOf(app, title);
    app.ctx.openAddSeason(s.id); await settle(); await settle();
    assert.match(app.el('libraryBody').innerHTML, /isn’t matched to TMDB; the season is added by its label/);
    type(app, { nSeason: 'Season 2', nDate: 'TBA 2027', nTheme: 'Net' });
    await app.ctx.librarySubmitSeason(); await settle();
    const r = app.store.watchlist_items.find(x => x.show_id === s.id && x.season === 'Season 2');
    assert.ok(r && r.tmdb_id == null && r.season_number == null && r.item_key === `${s.show_key}|season 2`, title);
  }
  assert.strictEqual(rpc(app, 'add_tv_seasons').length, 0);
});

test('an identified show outside the catalogs gets TMDB seasons from Add season (never a hand-typed season, which would make a second show)', async () => {
  const app = await boot();
  await allTv(app);
  const sev = showOf(app, 'Severance');
  app.ctx.openAddSeason(sev.id); await settle(); await settle();
  assert.match(app.el('libraryBody').innerHTML, /Seasons of this show come from TMDB/);
  assert.ok(!app.el('libraryBody').innerHTML.includes('id="nSeason"'), 'no label field');
  app.el('librarySeasonPick').querySelectorAll = () => [{ checked: true, disabled: false, dataset: { season: '3' } }];
  await app.ctx.librarySubmitSeason(); await settle();
  assert.deepStrictEqual(rpc(app, 'add_tv_seasons_to_show').map(r => r.body.p_seasons[0].season_number), [3]);
});

test('the show changed after the preview but before sending (seen by the fresh read): nothing is sent', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app);
  await choose(app, 95396, 'Severance');
  tick(app, [3]);
  showOf(app, 'Severance').show_key = 'severance (renamed)';
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.strictEqual(rpc(app, 'add_tv_seasons_to_show').length, 0);
  assert.match(outcome(app), /Your list changed since this preview, so nothing was added/);
});

test('the show is deleted while the request is on its way: the database refuses (target_missing); nothing is recreated or reported as added', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app);
  await choose(app, 95396, 'Severance');
  tick(app, [3]);
  const sev = showOf(app, 'Severance');
  const gate = app.hold(r => r.url.endsWith('/rpc/add_tv_seasons_to_show'));
  const done = app.ctx.addSelectedTMDBSeasons();
  await reached(gate);
  app.store.watchlist_items = app.store.watchlist_items.filter(r => r.show_id !== sev.id);
  app.store.tv_shows = app.store.tv_shows.filter(s => s.id !== sev.id);
  const shows = app.store.tv_shows.length;
  gate.release(); await done; await settle();
  assert.strictEqual(app.store.tv_shows.length, shows, 'no show recreated');
  assert.ok(!app.store.watchlist_items.some(r => r.tmdb_id === 95396));
  assert.match(outcome(app), /This show is no longer on your list, so nothing was added\./);
  assert.ok(!/Added “Season 3”/.test(outcome(app)));
});

test('a Match in between gives the show another identity: refused (target_changed), nothing written', async () => {
  const app = await boot();
  await allTv(app);
  const local = showOf(app, 'Local Show');
  app.ctx.openAddSeason(local.id); await settle(); await settle();
  type(app, { nSeason: 'Season 2', nDate: 'TBA 2027', nTheme: '' });
  const gate = app.hold(r => r.url.endsWith('/rpc/add_tv_seasons_to_show'));
  const done = app.ctx.librarySubmitSeason();
  await reached(gate);
  local.tmdb_id = 888; local.show_key = 'local show'; // what a Match of its only season can do
  const before = JSON.stringify(app.store);
  gate.release(); await done; await settle();
  assert.strictEqual(JSON.stringify(app.store), before);
  assert.match(outcome(app), /This show changed since you chose it, so nothing was added/);
});

test('an answer naming another show is not reported as an addition to the chosen show', async () => {
  const app = await boot();
  await allTv(app);
  const andor = showOf(app, 'Andor');
  app.rpcHandlers.add_tv_seasons_to_show = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ show_id: 'someone-else', show_created: false, inserted: [], existing: [], rejected: [] }) });
  app.ctx.openAddSeason(andor.id); await settle(); await settle();
  type(app, { nSeason: 'Season 2', nDate: 'TBA 2027', nTheme: '' });
  await app.ctx.librarySubmitSeason(); await settle();
  assert.match(outcome(app), /The answer named a different show than “Andor”, so this isn’t reported as an addition to it/);
  assert.ok(!/Added/.test(outcome(app)));
});

test('a database without add_tv_seasons_to_show: says so, nothing added, and never falls back to add_tv_seasons', async () => {
  const app = await boot(library(), { addToShow: false });
  await allTv(app); await openPanel(app);
  await choose(app, 95396, 'Severance');
  tick(app, [3]);
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.strictEqual(rpc(app, 'add_tv_seasons').length, 0);
  assert.match(outcome(app), /Adding to an existing show isn’t available on this database\. Nothing was added\./);
});

test('no clear answer (network failure): reported as unconfirmed, never resent, no "Saved"; a later read doesn’t resolve it', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app);
  await choose(app, 95396, 'Severance');
  tick(app, [3]);
  let saved = 0; app.ctx.showSaved = () => { saved++; };
  const gate = app.hold(r => r.url.endsWith('/rpc/add_tv_seasons_to_show'));
  const done = app.ctx.addSelectedTMDBSeasons();
  await reached(gate); gate.fail(); await done; await settle();
  assert.strictEqual(rpc(app, 'add_tv_seasons_to_show').length, 1, 'sent once');
  assert.strictEqual(saved, 0);
  assert.match(outcome(app), /no clear answer came back[\s\S]*isn’t confirmed[\s\S]*an earlier request may still complete[\s\S]*If you reload, this page won’t know whether that request finished/);
  app.ctx.loadDerivedView(); await settle();
  assert.strictEqual(rpc(app, 'add_tv_seasons_to_show').length, 1, 'still not resent');
});

// ─── Ambiguous and similar results ────────────────────────────────────────────
test('one TMDB identity on two records: nothing is sent until the user picks one; the pick is the target', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app);
  await choose(app, 136315, 'The Bear');
  assert.match(preview(app), /This show is on your list more than once \(nothing is merged automatically\)/);
  assert.ok(!app.el('tmdbPreview').innerHTML.includes('addSelectedTMDBSeasons'));
  const other = showOf(app, 'The Bear', 'othertv');
  app.ctx.libraryChoose(136315, 'tv', other.id); await settle();
  assert.match(preview(app), /Adds seasons to “The Bear”, already on your list/);
  tick(app, [9]);
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.deepStrictEqual(rpc(app, 'add_tv_seasons_to_show').map(r => r.body.p_show_id), [other.id]);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.tmdb_id === 136315 && r.season_number === 9).length, 1);
});

test('a TMDB show whose title matches an unidentified show: an explicit choice; "Add as a new show" goes to create_tv_show, which refuses a show whose seasons would collide (no empty second show)', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app);
  await choose(app, 888, 'Local Show');
  assert.match(preview(app), /“Local Show” is already on your list, not matched to TMDB\. It may be the same show; nothing is merged\./);
  assert.ok(!app.el('tmdbPreview').innerHTML.includes('addSelectedTMDBSeasons'));
  app.ctx.libraryChoose(888, 'tv', null, true); await settle();
  assert.match(preview(app), /Adds a new show to your list/);
  tick(app, [1]);
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  const [call] = rpc(app, 'create_tv_show');
  assert.strictEqual(rpc(app, 'add_tv_seasons').length, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(call.body.p_show)), { tmdb_id: 888, title: 'Local Show', show_key: 'local show', network: 'BBC' });
  // Its "Season 1" key is already held by the unmatched Local Show's season, so the new show can't hold it:
  // refused as a whole (the old create path would have left an empty second show).
  assert.strictEqual(app.store.tv_shows.filter(s => s.title === 'Local Show').length, 1);
  assert.match(outcome(app), /Not every season could be added to the new show, so nothing was added\./);
});

// ─── New items, collections after them ────────────────────────────────────────
test('a new TMDB show goes to the internal place for new shows (create_tv_show, othertv); collections are offered as a separate, optional step', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app);
  await choose(app, 777, 'Brand New');
  tick(app, [1, 2]);
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  const [call] = rpc(app, 'create_tv_show');
  assert.ok(!('p_collection' in call.body), 'the database decides where new shows go');
  assert.deepStrictEqual(call.body.p_seasons.map(s => [s.item_key, s.season_number]), [['brand new|season 1', 1], ['brand new|season 2', 2]]);
  const created = showOf(app, 'Brand New');
  assert.ok(created && created.collection === 'othertv');
  assert.ok(!app.store.collection_memberships.some(m => m.show_id === created.id), 'no membership implied');
  assert.match(outcome(app), /Added “Season 1” and “Season 2” to “Brand New”\.[\s\S]*Also add “Brand New” to collections \(optional\)/);
  // Collections: one call per chosen collection, each reported; creation is untouched by a failure.
  const sheridan = app.store.personal_collections.find(c => c.legacy_source === 'sheridan');
  const disney = app.store.personal_collections.find(c => c.legacy_source === 'disney');
  app.store.personal_collections.find(c => c.id === disney.id).archived_at = '2026-10-08T00:00:00Z'; // archived meanwhile: refused
  app.el('libraryOutcome').querySelectorAll = () => [{ checked: true, dataset: { collection: sheridan.id } }, { checked: true, dataset: { collection: disney.id } }];
  const rowsBefore = app.store.watchlist_items.length;
  await app.ctx.libraryAddMemberships(); await settle();
  assert.deepStrictEqual(rpc(app, 'org_add_membership').map(r => [r.body.p_collection_id, r.body.p_show_id]), [[sheridan.id, created.id], [disney.id, created.id]]);
  assert.match(outcome(app), /“Brand New” is saved\. Added to Sheridan\. Couldn’t add to Disney\+: This collection is archived/);
  assert.strictEqual(app.store.watchlist_items.length, rowsBefore, 'the addition itself is kept');
});

test('a new film (TMDB) goes to the films’ internal place; one already saved anywhere is "Already on your list"', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  await openPanel(app, 'movie');
  await choose(app, 438631, 'Dune', 'movie');
  assert.match(preview(app), /Already on your list/);
  await choose(app, 999, 'New Film', 'movie');
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  const post = app.writes().find(r => r.method === 'POST' && r.url.includes('/watchlist_items'));
  assert.strictEqual(post.body[0].collection, 'movies');
  assert.strictEqual(post.body[0].media_type, 'movie');
  assert.match(outcome(app), /Added “New Film”\./);
  assert.ok(app.html().includes('New Film'), 'All Movies read again');
});

test('a film by hand is labelled Film, so All Movies lists it; a same-title film is pointed out first', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  await openPanel(app, 'movie', 'manual');
  type(app, { nTitle: 'Lamp Light', nTheme: 'Drama', nDate: 'Jan 1, 2020' });
  await app.ctx.libraryManualFilm(); await settle();
  assert.match(app.el('libraryManualNote').innerHTML, /A film called “Lamp Light” is already on your list/);
  assert.strictEqual(app.writes().length, 0);
  type(app, { nTitle: 'Handmade', nTheme: 'Drama', nDate: 'Mar 3, 2021' });
  await app.ctx.libraryManualFilm(); await settle();
  const post = app.writes().find(r => r.method === 'POST');
  assert.deepStrictEqual([post.body[0].collection, post.body[0].season, post.body[0].item_key, post.body[0].date_sort], ['movies', 'Film', 'handmade|film', '2021-03-03']);
  app.el('fWatch').value = ''; app.ctx.renderTable();
  assert.ok(app.html().includes('Handmade'), 'listed in All Movies');
});

test('a show by hand goes to othertv without an identity; a same-title show is pointed out first (add a season to it, or a separate show)', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app, 'tv', 'manual');
  type(app, { nTitle: 'Andor', nSeason: 'Season 1', nTheme: 'Disney+', nDate: 'Nov 1, 2022' });
  await app.ctx.libraryManualShow(); await settle();
  assert.match(app.el('libraryManualNote').innerHTML, /“Andor” is already on your list[\s\S]*openAddSeason/);
  assert.strictEqual(app.writes().length, 0);
  type(app, { nTitle: 'Hand Show', nSeason: 'Season 1', nTheme: 'BBC', nDate: 'Jan 5, 2023' });
  await app.ctx.libraryManualShow(); await settle();
  const [call] = rpc(app, 'create_tv_show');
  assert.strictEqual(call.body.p_show.tmdb_id, null);
  assert.strictEqual(call.body.p_seasons[0].item_key, 'hand show|season 1');
  assert.ok(app.ctx.isTmdbMatchEligible(app.store.watchlist_items.find(r => r.title === 'Hand Show')), 'it can be matched later');
});

// ─── Refresh shows ────────────────────────────────────────────────────────────
test('Refresh shows checks every identified show that takes TMDB seasons, one protected call per show; a refusal is scoped to its show and earlier results are kept', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app, 'tv', 'refresh');
  await app.ctx.libraryRefreshShows(); await settle();
  assert.match(preview(app), /Severance[\s\S]*Season 3[\s\S]*The Bear[\s\S]*Season 9/);
  assert.ok(!preview(app).includes('Tulsa King'), 'a built-in TMDB-matched show isn’t refreshed from TMDB');
  const found = app.get('libraryPanel.refresh.found').map(f => f.show.title);
  const bearIdx = found.indexOf('The Bear'), sevIdx = found.indexOf('Severance');
  app.selectors['#tmdbPreview input[type="checkbox"][data-show-idx]'] = [
    { checked: true, dataset: { showIdx: String(sevIdx), season: '3' } }, { checked: true, dataset: { showIdx: String(bearIdx), season: '9' } }];
  app.selectors['#tmdbPreview input[type="checkbox"][data-update-idx]'] = [];
  // The Bear (whichever record comes first) is deleted while the calls are out: refused, the next call still runs.
  const target = app.get('libraryPanel.refresh.found')[bearIdx].show.id;
  const gate = app.hold(r => r.url.endsWith('/rpc/add_tv_seasons_to_show') && r.body.p_show_id === target);
  const done = app.ctx.libraryApplyRefresh();
  await reached(gate);
  app.store.watchlist_items = app.store.watchlist_items.filter(r => r.show_id !== target);
  app.store.tv_shows = app.store.tv_shows.filter(s => s.id !== target);
  gate.release(); await done; await settle();
  const calls = rpc(app, 'add_tv_seasons_to_show');
  assert.strictEqual(calls.length, 2);
  assert.match(outcome(app), /Added “Season 3” to “Severance”\./);
  assert.match(outcome(app), /“The Bear”: This show is no longer on your list, so nothing was added\./);
  assert.ok(!app.store.tv_shows.some(s => s.id === target), 'not recreated');
});

test('Refresh shows: an unclear answer stops sending; earlier results stay reported', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app, 'tv', 'refresh');
  await app.ctx.libraryRefreshShows(); await settle();
  const found = app.get('libraryPanel.refresh.found');
  app.selectors['#tmdbPreview input[type="checkbox"][data-show-idx]'] = found.map((f, i) => ({ checked: true, dataset: { showIdx: String(i), season: String(f.fresh[0].season_number) } }));
  app.selectors['#tmdbPreview input[type="checkbox"][data-update-idx]'] = [];
  let k = 0;
  const gate = app.hold(r => r.url.endsWith('/rpc/add_tv_seasons_to_show') && ++k === 2);
  const done = app.ctx.libraryApplyRefresh();
  await reached(gate); gate.fail(); await done; await settle();
  assert.strictEqual(rpc(app, 'add_tv_seasons_to_show').length, 2, `no call after the unclear one (of ${found.length})`);
  assert.match(outcome(app), /Added “Season/);
  assert.match(outcome(app), /no clear answer came back[\s\S]*Nothing more was sent\./);
});

// ─── Restore and navigation while a request is out ────────────────────────────
test('an answer that arrives after a restore is set aside: the view is read again and the report doesn’t say which ran last; no retry', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app);
  await choose(app, 95396, 'Severance');
  tick(app, [3]);
  const gate = app.hold(r => r.url.endsWith('/rpc/add_tv_seasons_to_show'));
  const done = app.ctx.addSelectedTMDBSeasons();
  await reached(gate);
  app.ctx.invalidateOrganization(); app.ctx.finishRestoreAndReload(); await settle(); // what a completed restore does (the epoch moves on)
  assert.strictEqual(app.get('libraryPanel'), null, 'the panel closed with the restore');
  const gets = app.requests.length;
  gate.release(); await done; await settle();
  assert.match(banners(app), /answered afterwards\. The list has been read again\. This doesn’t show whether the addition ran before or after the restore/);
  assert.ok(app.requests.slice(gets).some(r => r.method === 'GET' && r.url.includes('/watchlist_items?')), 'read again');
  assert.strictEqual(rpc(app, 'add_tv_seasons_to_show').length, 1);
});

test('leaving the view while a request is out: the panel closes, nothing is painted into the next view, the result is still reported', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app);
  await choose(app, 95396, 'Severance');
  tick(app, [3]);
  const gate = app.hold(r => r.url.endsWith('/rpc/add_tv_seasons_to_show'));
  const done = app.ctx.addSelectedTMDBSeasons();
  await reached(gate);
  app.ctx.switchView('comingsoon'); await settle();
  const comingSoon = app.html();
  gate.release(); await done; await settle();
  assert.strictEqual(app.get('libraryPanel'), null);
  assert.strictEqual(app.get('activeViewId'), 'comingsoon');
  assert.strictEqual(app.html(), comingSoon, 'Coming Soon untouched');
  assert.match(banners(app), /Added “Season 3” to “Severance”/);
});

test('the panel closed in the same view while a request is out: the result is reported above the list and survives the view’s reload', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app);
  await choose(app, 95396, 'Severance');
  tick(app, [3]);
  const sev = showOf(app, 'Severance');
  const gate = app.hold(r => r.url.endsWith('/rpc/add_tv_seasons_to_show'));
  const done = app.ctx.addSelectedTMDBSeasons();
  await reached(gate);
  app.ctx.closeLibraryPanel();
  app.store.tv_shows = app.store.tv_shows.filter(s => s.id !== sev.id);
  app.store.watchlist_items = app.store.watchlist_items.filter(r => r.show_id !== sev.id);
  gate.release(); await done; await settle();
  assert.match(app.el('errorBanner').innerHTML, /This show is no longer on your list, so nothing was added\./);
});

// ─── All TV and All Movies actions ────────────────────────────────────────────
test('All TV: Delete on a season that isn’t a catalog entry (delete_tv_season by id); a catalog season has Skip / Keep instead; a refused delete comes back', async () => {
  const probe = await createApp();
  const def = probe.get("COLLECTIONS.find(c => c.id === 'disney').defaults.find(d => d.s !== 'Film')");
  const cat = show({ title: def.t, collection: 'disney', show_key: def.k.split('|')[0] }, [{ label: def.s, key: def.k }]);
  const data = library(); data.rows.push(...cat.rows); data.shows.push(cat.show);
  const app = await boot(data);
  await allTv(app);
  app.el('fStatus').value = 'all'; app.ctx.renderTable();
  app.ctx.toggleDerivedShow(cat.show.id); await settle();
  assert.ok(!app.html().includes(`delRow('${cat.rows[0].id}')`), 'no Delete on a catalog entry');
  const local = showOf(app, 'Local Show');
  const row = app.store.watchlist_items.find(r => r.show_id === local.id);
  app.ctx.toggleDerivedShow(local.id); await settle();
  assert.ok(app.html().includes(`delRow('${row.id}')`) && app.html().includes(`openTmdbMatch('${row.id}')`), 'Delete and Match on an eligible row');
  app.failNext(r => r.url.endsWith('/rpc/delete_tv_season'));
  await app.ctx.delRow(row.id); await settle();
  assert.ok(app.html().includes(`delRow('${row.id}')`), 'a refused (HTTP error, ambiguous) delete is reported, then the view is read again');
  assert.match(banners(app), /no clear answer came back|Couldn’t delete/);
  await app.ctx.delRow(row.id); await settle();
  assert.deepStrictEqual(rpc(app, 'delete_tv_season').map(r => r.body.p_row_id), [row.id, row.id]);
  assert.ok(!app.store.tv_shows.some(s => s.id === local.id), 'the emptied show is gone');
  assert.ok(!app.html().includes('Local Show'));
});

test('All TV: Match from an expanded show sends match_tv_row for that row and reads the view again', async () => {
  const app = await boot();
  await allTv(app);
  const local = showOf(app, 'Local Show');
  const row = app.store.watchlist_items.find(r => r.show_id === local.id);
  app.ctx.toggleDerivedShow(local.id); await settle();
  app.ctx.openTmdbMatch(row.id); await settle();
  assert.strictEqual(app.get('libraryPanel.mode'), 'match');
  app.el('tmdbMatchQuery').value = 'Local Show'; await app.ctx.searchTmdbMatch(); await settle();
  await app.ctx.chooseTmdbMatchResult(app.get("window.__tmdbMatch.results.findIndex(r => r.id === 888)")); await settle();
  app.ctx.chooseTmdbMatchSeason(1); await settle();
  const gets = app.requests.length;
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.deepStrictEqual(rpc(app, 'match_tv_row').map(r => r.body.p_row_id), [row.id]);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === row.id).tmdb_id, 888);
  assert.ok(app.requests.slice(gets).some(r => r.method === 'GET' && r.url.includes('collection=in.')), 'All TV read again');
  assert.match(outcome(app), /Matched “Local Show”\./);
});

test('All Movies: status, Watched and watch-with by the film’s id, for a film wherever it is stored; a catalog film is skipped, never deleted', async () => {
  const probe = await createApp();
  const def = probe.get("COLLECTIONS.find(c => c.id === 'disney').defaults.find(d => d.s === 'Film')");
  const data = library(); data.rows.push(film({ id: 'f-cat', title: def.t, collection: 'disney', media_type: null, item_key: def.k }));
  const app = await boot(data);
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = ''; app.el('fStatus').value = 'all'; app.ctx.renderTable();
  assert.ok(app.html().includes(`toggleWatchWith('f-lamp'`), 'watch-with for a film stored in Disney+ (D2)');
  await app.ctx.setStatus('f-lamp', 'watching'); await app.ctx.toggleWatch('f-lamp'); await app.ctx.toggleWatchWith('f-lamp', 'Rina', true); await settle();
  assert.deepStrictEqual(app.writes().map(r => [r.method, r.url.split('?')[1], JSON.stringify(r.body)]),
    [['PATCH', 'id=eq.f-lamp', '{"status":"watching"}'], ['PATCH', 'id=eq.f-lamp', '{"watched":true}'], ['PATCH', 'id=eq.f-lamp', '{"watch_with":["Rina"]}']]);
  assert.ok(app.html().includes('title="Skip (built-in catalog film)"'));
  await app.ctx.delRow('f-cat'); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.writes().at(-1).body)), { status: 'skipped' });
  assert.ok(app.store.watchlist_items.some(r => r.id === 'f-cat'), 'never deleted');
  await app.ctx.delRow('f-man'); await settle();
  assert.deepStrictEqual(writes(app).at(-1), 'DELETE watchlist_items');
  assert.ok(!app.store.watchlist_items.some(r => r.id === 'f-man'));
  assert.ok(!app.html().includes('Manual Film'));
  assert.ok(app.html().includes(`openTmdbMatch('${'f-man'}')`) === false);
});

test('All Movies: a failed status change is put back and not reported as saved', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  let saved = 0; app.ctx.showSaved = () => { saved++; };
  app.failNext(r => r.method === 'PATCH');
  await app.ctx.setStatus('f-dune', 'skipped'); await settle();
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === 'f-dune').status, 'confirmed');
  assert.strictEqual(app.get("browseData.rows.find(r => r.id === 'f-dune').status"), 'confirmed');
  assert.strictEqual(saved, 0);
});

test('All Movies: Pull rest of a franchise runs in the panel against the films’ storage and adds there', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = ''; app.ctx.renderTable();
  assert.ok(app.html().includes("libraryPullRest('f-dune', 726871"));
  await app.ctx.libraryPullRest('f-dune', 726871, 'Dune'); await settle();
  assert.match(preview(app), /Dune[\s\S]*Already added[\s\S]*Dune: Part Two/);
  app.selectors['#tmdbPreview input[type="checkbox"][data-movie-id]'] = [{ checked: true, disabled: false, dataset: { movieId: '693134' } }];
  await app.ctx.addPulledCollectionMovies(); await settle();
  const post = app.writes().find(r => r.method === 'POST');
  assert.deepStrictEqual([post.body[0].collection, post.body[0].tmdb_id, post.body[0].tmdb_collection_id], ['movies', 693134, 726871]);
  assert.ok(app.html().includes('Dune: Part Two'), 'All Movies read again');
});

// ─── Year, duplicates ─────────────────────────────────────────────────────────
test('Year: All TV Shows keeps a show with any season of that year (all its seasons stay); Seasons filters each season; TBA has no year; All Movies by release year', async () => {
  const data = all(
    show({ title: 'Old New', tmdb_id: 5001 }, [{ num: 1, date: '2019-03-01' }, { num: 2, date: '2024-05-01' }]),
    show({ title: 'Only TBA', tmdb_id: 5002 }, [{ num: 1, date: '2024-06-01', display: 'TBA 2024' }]),
    film({ title: 'Film 2024', tmdb_id: 6001, date_sort: '2024-02-02' }), film({ title: 'Film 2019', tmdb_id: 6002, date_sort: '2019-02-02' }));
  const app = await boot(data);
  await allTv(app);
  assert.deepStrictEqual([...app.el('filtersRow').innerHTML.matchAll(/<option value="(\d{4})">/g)].map(m => m[1]), ['2019', '2024'], 'TBA’s guessed date is no year');
  app.el('fYear').value = '2024'; app.ctx.renderTable();
  assert.ok(app.html().includes('Old New') && !app.html().includes('Only TBA'));
  app.ctx.toggleDerivedShow(showOf(app, 'Old New').id); await settle();
  assert.strictEqual((app.el('tbody').innerHTML.match(/sub-row/g) || []).length, 3, 'both seasons and Add season');
  app.ctx.setAllTvPresentation('seasons'); await settle();
  assert.strictEqual(app.el('fYear').value, '2024', 'kept across Shows → Seasons');
  assert.ok(app.html().includes('Season 2') && !app.html().includes('· Season 1'));
  app.ctx.loadDerivedView(); await settle();
  assert.strictEqual(app.el('fYear').value, '2024', 'kept through a reload');
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = ''; app.el('fYear').value = '2019'; app.ctx.renderTable();
  assert.ok(app.html().includes('Film 2019') && !app.html().includes('Film 2024'));
});

test('duplicates: one TMDB identity on two records is marked on each, its tooltip naming their storage; a single record isn’t', async () => {
  const app = await boot();
  await allTv(app);
  const bears = (app.html().match(/Duplicate on your list/g) || []).length;
  assert.ok(bears >= 2, 'both The Bear records');
  assert.match(app.html(), /stored under: (Disney\+, Other TV|Other TV, Disney\+)/);
  app.el('fSearch').value = 'severance'; app.ctx.renderTable();
  assert.ok(!app.html().includes('Duplicate on your list'));
});

// ─── Catalog updates from the Browse bar ──────────────────────────────────────
test('Catalog updates from the Browse bar: hints by GET, Review opens the dialog for that catalog, and an apply reads the open view again', async () => {
  const app = await boot();
  await allTv(app);
  app.ctx.openCatalogChooser(null); await settle();
  assert.ok(app.requests.some(r => r.method === 'GET' && r.url.includes('collection=eq.sheridan')));
  app.ctx.catalogChooserReview('sheridan');
  for (let i = 0; i < 20 && app.get('catalogDialog.phase') !== 'preview'; i++) await settle();
  assert.strictEqual(app.get('catalogChooser'), null);
  assert.strictEqual(app.get('catalogDialog.collectionId'), 'sheridan');
  assert.match(app.el('catalogModalBox').innerHTML, /Catalog updates — Sheridan/);
  const gets = app.requests.length;
  await app.ctx.catalogApply(); await settle();
  assert.deepStrictEqual(rpc(app, 'catalog_apply').length, 2, 'preview, then apply');
  assert.ok(app.requests.slice(gets).some(r => r.method === 'GET' && r.url.includes('collection=in.')), 'All TV read again');
  assert.ok(app.html().includes(app.get("COLLECTIONS.find(c => c.id === 'sheridan').defaults.find(d => d.s !== 'Film').t")), 'the applied shows are listed');
});

// ─── Review fixes (2026-10-08) ────────────────────────────────────────────────
test('a show by hand named like an unmatched show already stored with new shows: "new show" is refused, nothing sent; adding to it is offered through the checked path', async () => {
  const app = await boot();
  await allTv(app); await openPanel(app, 'tv', 'manual');
  type(app, { nTitle: 'Local Show', nSeason: 'Season 2', nTheme: 'BBC', nDate: 'Jan 5, 2023' });
  await app.ctx.libraryManualShow(); await settle();
  await app.ctx.libraryManualShow(); await settle(); // asking again changes nothing
  assert.strictEqual(app.writes().length, 0, 'nothing sent');
  const note = app.el('libraryManualNote').innerHTML;
  assert.match(note, /A separate new show called “Local Show” can’t be added[\s\S]*Nothing was added/);
  assert.ok(note.includes(`openAddSeason('${showOf(app, 'Local Show').id}')`) && !note.includes('libraryManualShow()'), 'only the explicit, checked alternative');
  app.ctx.openAddSeason(showOf(app, 'Local Show').id); await settle(); await settle();
  type(app, { nSeason: 'Season 2', nDate: 'Jan 5, 2023', nTheme: 'BBC' });
  await app.ctx.librarySubmitSeason(); await settle();
  assert.deepStrictEqual(rpc(app, 'add_tv_seasons_to_show').map(r => r.body.p_show_id), [showOf(app, 'Local Show').id]);
  assert.strictEqual(rpc(app, 'add_tv_seasons').length, 0);
});

test('a new show whose name or identity is taken while the request is out: refused (show_exists); nothing added and the show that appeared is untouched', async () => {
  for (const [label, fill, appear] of [
    ['by hand', async app => { await openPanel(app, 'tv', 'manual'); type(app, { nTitle: 'Race Show', nSeason: 'Season 1', nTheme: 'BBC', nDate: 'Jan 5, 2023' }); return [app.ctx.libraryManualShow()]; },
      { id: 'show-race', collection: 'othertv', title: 'Race Show', show_key: 'race show', tmdb_id: null, status: 'pending' }],
    ['from TMDB', async app => { await openPanel(app); await choose(app, 777, 'Brand New'); tick(app, [1]); return [app.ctx.addSelectedTMDBSeasons()]; },
      { id: 'show-race', collection: 'truecrime', title: 'Brand New', show_key: 'brand new', tmdb_id: 777, status: 'pending' }]]) {
    const app = await boot();
    await allTv(app);
    const gate = app.hold(r => r.url.endsWith('/rpc/create_tv_show'));
    const [done] = await fill(app); // the request's promise, not awaited until released
    await reached(gate);
    app.store.tv_shows.push({ ...appear });
    const rows = app.store.watchlist_items.length;
    gate.release(); await done; await settle();
    assert.match(outcome(app), /This show is already on your list, so nothing was added\./, label);
    assert.strictEqual(app.store.watchlist_items.length, rows, `${label}: no season added`);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(app.store.tv_shows.find(x => x.id === 'show-race'))), appear, `${label}: the show that appeared is unchanged`);
    assert.strictEqual(rpc(app, 'add_tv_seasons').length + rpc(app, 'add_tv_seasons_to_show').length, 0, `${label}: never added to it`);
    assert.ok(!outcome(app).includes('collections (optional)'));
  }
});

test('Refresh shows: a date that changed between the check and Apply is reported as out of date, not saved; nothing is overwritten', async () => {
  const data = all(show({ title: 'Severance', tmdb_id: 95396 }, [{ num: 1 }, { num: 2, display: 'TBA', date: '2099-01-01' }]));
  const app = await boot(data);
  await allTv(app); await openPanel(app, 'tv', 'refresh');
  await app.ctx.libraryRefreshShows(); await settle();
  assert.strictEqual(app.get('libraryPanel.refresh.updates.length'), 1);
  app.selectors['#tmdbPreview input[type="checkbox"][data-show-idx]'] = [];
  app.selectors['#tmdbPreview input[type="checkbox"][data-update-idx]'] = [{ checked: true, dataset: { updateIdx: '0' } }];
  const s2 = app.store.watchlist_items.find(r => r.title === 'Severance' && r.season_number === 2);
  Object.assign(s2, { display_date: 'Feb 1, 2025', date_sort: '2025-02-01' }); // dated elsewhere after the check
  let saved = 0; app.ctx.showSaved = () => { saved++; };
  await app.ctx.libraryApplyRefresh(); await settle();
  const patch = app.writes().find(r => r.method === 'PATCH');
  assert.ok(patch && /return=representation/.test(patch.headers.Prefer), 'asks for the changed rows');
  assert.strictEqual(s2.display_date, 'Feb 1, 2025', 'the newer date is kept');
  assert.strictEqual(saved, 0, 'not counted as saved');
  assert.match(app.el('libraryOutcome').innerHTML, /error-banner[\s\S]*not changed — its date is no longer TBA \(it changed after the check\), so this part of the preview is out of date/);
});

test('Refresh shows: a date that still matched is confirmed from the rows the update returned', async () => {
  const data = all(show({ title: 'Severance', tmdb_id: 95396 }, [{ num: 1 }, { num: 2, display: 'TBA', date: '2099-01-01' }]));
  const app = await boot(data);
  await allTv(app); await openPanel(app, 'tv', 'refresh');
  await app.ctx.libraryRefreshShows(); await settle();
  app.selectors['#tmdbPreview input[type="checkbox"][data-show-idx]'] = [];
  app.selectors['#tmdbPreview input[type="checkbox"][data-update-idx]'] = [{ checked: true, dataset: { updateIdx: '0' } }];
  let saved = 0; app.ctx.showSaved = () => { saved++; };
  await app.ctx.libraryApplyRefresh(); await settle();
  assert.strictEqual(app.store.watchlist_items.find(r => r.title === 'Severance' && r.season_number === 2).date_sort, '2025-01-17');
  assert.strictEqual(saved, 1);
  assert.match(outcome(app), /Severance · Season 2: date set to Jan 17, 2025\./);
});

test('restore while Refresh shows is sending: no further call or date update is sent after it', async () => {
  const data = all(
    show({ title: 'Severance', tmdb_id: 95396 }, [{ num: 1 }, { num: 2, display: 'TBA', date: '2099-01-01' }]),
    show({ title: 'The Bear', tmdb_id: 136315 }, [{ num: 1 }, { num: 2, display: 'TBA', date: '2099-01-01' }]));
  TMDB['/tv/136315'].seasons[1] = { season_number: 2, air_date: '2023-06-22', episode_count: 10 };
  const app = await boot(data);
  await allTv(app); await openPanel(app, 'tv', 'refresh');
  await app.ctx.libraryRefreshShows(); await settle();
  assert.strictEqual(app.get('libraryPanel.refresh.updates.length'), 2);
  app.selectors['#tmdbPreview input[type="checkbox"][data-show-idx]'] = [];
  app.selectors['#tmdbPreview input[type="checkbox"][data-update-idx]'] = [{ checked: true, dataset: { updateIdx: '0' } }, { checked: true, dataset: { updateIdx: '1' } }];
  const gate = app.hold(r => r.method === 'PATCH');
  const done = app.ctx.libraryApplyRefresh();
  await reached(gate);
  app.ctx.invalidateOrganization(); app.ctx.finishRestoreAndReload(); await settle(); // a restore completes
  gate.release(); await done; await settle();
  assert.strictEqual(app.writes().filter(r => r.method === 'PATCH').length, 1, 'the second date update was not sent');
  assert.match(banners(app), /Refresh shows answered after a restore[\s\S]*Nothing more was sent/);
  TMDB['/tv/136315'].seasons[1] = { season_number: 9, air_date: null, episode_count: 0 };
});

test('a Watched answer that arrives after a restore never overwrites the restored cache; the view is read again', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = ''; app.ctx.renderTable();
  const before = JSON.parse(JSON.stringify(app.store.watchlist_items));
  const gate = app.hold(r => r.method === 'PATCH' && r.url.includes('id=eq.f-dune'));
  const done = app.ctx.toggleWatch('f-dune');
  await reached(gate);
  // The restore completes (the database is the restored data; the view reads it again).
  app.ctx.invalidateOrganization(); app.ctx.finishRestoreAndReload(); await settle();
  const restoredRow = app.get("browseData.rows.find(r => r.id === 'f-dune')");
  assert.strictEqual(restoredRow.watched, false);
  // The change ran on the pre-restore data; only its answer arrives now.
  gate.releaseWith({ watchlist_items: before }); await done; await settle();
  assert.strictEqual(app.get("browseData.rows.find(r => r.id === 'f-dune').watched"), false, 'the stale answer was not copied into the restored cache');
  assert.match(banners(app), /watched was sent before the restore and answered afterwards\. The list has been read again/);
});

test('status and watch-with answers after a restore are set aside the same way; a show status answer too', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = ''; app.ctx.renderTable();
  for (const [label, run] of [['status', () => app.ctx.setStatus('f-dune', 'watching')], ['watch with', () => app.ctx.toggleWatchWith('f-dune', 'Rina', true)]]) {
    const before = JSON.parse(JSON.stringify(app.store.watchlist_items));
    const gate = app.hold(r => r.method === 'PATCH' && r.url.includes('id=eq.f-dune'));
    const done = run();
    await reached(gate);
    app.ctx.invalidateOrganization(); app.ctx.finishRestoreAndReload(); await settle();
    gate.releaseWith({ watchlist_items: before }); await done; await settle();
    const row = app.get("browseData.rows.find(r => r.id === 'f-dune')");
    assert.ok(row.status === 'confirmed' && !(row.watch_with || []).includes('Rina'), label);
    assert.match(banners(app), new RegExp(`${label} was sent before the restore`));
  }
  app.ctx.switchMediaType('tv'); app.ctx.switchView('alltv'); await settle();
  const sev = showOf(app, 'Severance');
  const shows = JSON.parse(JSON.stringify(app.store.tv_shows));
  const gate = app.hold(r => r.url.endsWith('/rpc/set_show_status'));
  const done = app.ctx.setShowStatusById(sev.id, 'complete');
  await reached(gate);
  app.ctx.invalidateOrganization(); app.ctx.finishRestoreAndReload(); await settle();
  gate.releaseWith({ tv_shows: shows }); await done; await settle();
  assert.strictEqual(app.get(`tvShowsById.get('${sev.id}').status`), 'watching', 'the restored show status stays');
  assert.match(banners(app), /show status was sent before the restore/);
});

test('Movie tools in All Movies check identities across the whole library: a franchise film stored under Disney+ is "Already added" and not imported again', async () => {
  const data = library();
  data.rows.push(film({ id: 'f-dune2', title: 'Dune: Part Two', collection: 'disney', tmdb_id: 693134, date_sort: '2024-02-27' }));
  const app = await boot(data);
  app.ctx.switchMediaType('movie'); await settle();
  await app.ctx.libraryPullRest('f-dune', 726871, 'Dune'); await settle();
  assert.ok(app.requests.some(r => r.method === 'GET' && r.url.includes('/watchlist_items?') && r.headers.Range), 'a complete (paged) read');
  assert.match(preview(app), /Dune: Part Two[\s\S]*Already added/);
  app.selectors['#tmdbPreview input[type="checkbox"][data-movie-id]'] = []; // nothing left to choose
  await app.ctx.addPulledCollectionMovies(); await settle();
  assert.strictEqual(app.writes().filter(r => r.method === 'POST').length, 0);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.tmdb_id === 693134).length, 1);
});

test('Movie tools: a failed or incomplete library read lets nothing be imported', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openLibraryPanel('movie', 'tools'); await settle();
  app.failNext(r => r.method === 'GET' && r.url.includes('/watchlist_items?'));
  await app.ctx.libraryMovieTool('collections'); await settle();
  assert.match(outcome(app), /Couldn’t read your whole list[\s\S]*Nothing was changed/);
  assert.strictEqual(app.get('libraryPanel.toolsReady'), false);
  assert.strictEqual(app.get("toolCollectionId()"), null, 'no tool can run');
  assert.strictEqual(app.writes().length, 0);
});

test('Movie tools: a person collection tags only films stored with the films; one stored elsewhere is "Already added" and left as it is', async () => {
  const data = library();
  data.rows.push(film({ id: 'f-dune2', title: 'Dune: Part Two', collection: 'disney', tmdb_id: 693134, date_sort: '2024-02-27' }));
  const app = await boot(data, { customCollections: [{ id: 'cc-1', name: 'Denis', tmdb_person_id: 42, role: 'director' }] });
  app.ctx.switchMediaType('movie'); await settle();
  await app.ctx.libraryRefreshPerson('Denis'); await settle();
  const patches = app.writes().filter(r => r.method === 'PATCH');
  assert.deepStrictEqual(patches.map(r => r.url.split('?')[1]), ['id=eq.f-dune'], 'only the film stored with the films gets the tag');
  assert.ok(!(app.store.watchlist_items.find(r => r.id === 'f-dune2').collections || []).includes('Denis'));
  assert.match(preview(app), /Dune: Part Two[\s\S]*Already added/);
});

test('Refresh shows whose only call has no clear answer: no "Saved"; reported as unconfirmed', async () => {
  const data = all(show({ title: 'Severance', tmdb_id: 95396 }, [{ num: 1 }, { num: 2 }]));
  const app = await boot(data);
  await allTv(app); await openPanel(app, 'tv', 'refresh');
  await app.ctx.libraryRefreshShows(); await settle();
  app.selectors['#tmdbPreview input[type="checkbox"][data-show-idx]'] = [{ checked: true, dataset: { showIdx: '0', season: '3' } }];
  app.selectors['#tmdbPreview input[type="checkbox"][data-update-idx]'] = [];
  let saved = 0; app.ctx.showSaved = () => { saved++; };
  const gate = app.hold(r => r.url.endsWith('/rpc/add_tv_seasons_to_show'));
  const done = app.ctx.libraryApplyRefresh();
  await reached(gate); gate.fail(); await done; await settle();
  assert.strictEqual(saved, 0);
  assert.match(app.el('libraryOutcome').innerHTML, /error-banner[\s\S]*no clear answer came back[\s\S]*Nothing more was sent/);
});

T.run();
