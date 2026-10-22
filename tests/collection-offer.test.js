// Offline tests for what a film's TMDB collection offers (collections-pull.js), in the whole-page
// harness: the add screen checks the selected film's collection once and says something only when
// there's something to say (other films to pull, all of them already added, or a failed check with
// Retry; nothing for a collection of one); the film's ⋯ menu offers Check collection while the
// contents are unknown, then Pull rest only when another film can be added; a failure stays apart
// from "nothing more" and can be retried; the lookup is page memory only, so a later fetch (Refresh
// collections, Pull rest, a new page) finds a film TMDB adds later. Checking writes nothing.
// Run from the repo root: node tests/collection-offer.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('collection-offer');
const test = T.test;

const film = (id, title, tmdbId, collectionId, o = {}) => ({ id, collection: 'movies', title, theme: 'Drama', status: 'confirmed', watched: false, skipped: false,
  media_type: 'movie', tmdb_id: tmdbId, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `${title.toLowerCase()}|film`, watch_with: [], collections: collectionId ? [`C${collectionId} Collection`] : [], show_id: null,
  tmdb_collection_id: collectionId, tmdb_collection_name: collectionId ? `C${collectionId} Collection` : null, ...o });
// In the library: a film alone in its collection, one with another film to add, a pair already
// both added, and one whose collection lookup fails.
const ROWS = () => [film('f-solo', 'Solo Film', 100, 9100), film('f-saga1', 'Saga One', 201, 9200),
  film('f-pair1', 'Pair One', 301, 9300), film('f-pair2', 'Pair Two', 302, 9300), film('f-lost', 'Lost One', 401, 9400)];
const part = (id, title) => ({ id, title, release_date: '2020-01-01' });
function tmdbOf() {
  const collections = {
    9100: [part(100, 'Solo Film')],
    9200: [part(201, 'Saga One'), part(202, 'Saga Two')],
    9300: [part(301, 'Pair One'), part(302, 'Pair Two')],
    9500: [part(500, 'Lone Movie')]
  };
  const movies = {
    500: { id: 500, title: 'Lone Movie', belongs_to_collection: { id: 9500, name: 'C9500 Collection' } },
    203: { id: 203, title: 'Saga Three', belongs_to_collection: { id: 9200, name: 'C9200 Collection' } },
    304: { id: 304, title: 'Pair Prequel', belongs_to_collection: { id: 9300, name: 'C9300 Collection' } },
    402: { id: 402, title: 'Lost Two', belongs_to_collection: { id: 9400, name: 'C9400 Collection' } },
    101: { id: 101, title: 'Solo Film 2', belongs_to_collection: { id: 9100, name: 'C9100 Collection' } }
  };
  Object.values(movies).forEach(m => Object.assign(m, { release_date: '2021-01-01', genres: [{ id: 18, name: 'Drama' }], production_companies: [] }));
  const state = { collections, movies, failing: new Set([9400]), calls: [] };
  state.fn = p => {
    state.calls.push(p);
    let m = /^\/collection\/(\d+)/.exec(p);
    if (m) return state.failing.has(+m[1]) ? { __status: 500 } : collections[m[1]] ? { id: +m[1], name: `C${m[1]} Collection`, parts: collections[m[1]] } : undefined;
    m = /^\/movie\/(\d+)/.exec(p);
    if (m) return movies[m[1]];
    if (p.startsWith('/search/movie')) {
      const q = decodeURIComponent((p.match(/query=([^&]*)/) || [])[1] || '').toLowerCase();
      return { results: Object.values(movies).filter(x => x.title.toLowerCase() === q).map(x => ({ id: x.id, title: x.title, release_date: x.release_date })) };
    }
    if (p.startsWith('/search/')) return { results: [] };
    return undefined;
  };
  return state;
}
async function boot(t = tmdbOf()) {
  const app = await createApp({ rows: ROWS(), tvShows: [], tmdb: p => t.fn(p) });
  return { app, t };
}
async function allMovies(app) {
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = ''; app.ctx.renderTable();
}
const text = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/ ([,.])/g, '$1').trim();
// One film's Collection section in its ⋯ menu (the table copy).
const section = (app, rowId) => {
  const m = app.html().match(new RegExp(`<div class="film-franchise" data-film-franchise="${rowId}">([\\s\\S]*?)</div>(?=\\s*(?:<div class="popover-section-label"|<\\/div>))`));
  return m ? m[1] : null;
};
const preview = app => text(app.el('tmdbPreview').innerHTML);
const collectionCalls = (t, id) => t.calls.filter(p => p.startsWith(`/collection/${id}`)).length;
async function pick(app, id, name) {
  app.ctx.openLibraryPanel('movie'); await settle();
  app.el('tmdbQuery').value = name; await app.ctx.searchTMDB(); await settle();
  await app.ctx.selectTMDBShow(id, name, 'movie', `tmdbResult_0_${id}`); await settle(); await settle();
}
async function check(app, rowId) { await app.ctx.checkFilmCollection(rowId); await settle(); app.ctx.renderTable(); }

// ── The film's ⋯ menu ──
test('menu: contents unknown → Check collection, never Pull rest; nothing is fetched until asked', async () => {
  const { app, t } = await boot();
  await allMovies(app);
  for (const id of ['f-solo', 'f-saga1', 'f-pair1', 'f-lost']) {
    assert.match(text(section(app, id)), /Collection 🔗 Check collection/, `${id}: Check collection`);
    assert.ok(!section(app, id).includes('libraryPullRest('), `${id}: no Pull rest yet`);
  }
  assert.strictEqual(t.calls.filter(p => p.startsWith('/collection/')).length, 0, 'opening the view fetches no collection');
});

test('menu: one-film collection → no Pull rest and no message; other films to add → Pull rest; all already added → the message', async () => {
  const { app, t } = await boot();
  await allMovies(app);
  await check(app, 'f-solo');
  assert.strictEqual(section(app, 'f-solo'), '', 'a collection of one: nothing offered, no “sole film” message');
  await check(app, 'f-saga1');
  assert.ok(section(app, 'f-saga1').includes("libraryPullRest('f-saga1', 9200,") && /Pull rest of C9200/.test(text(section(app, 'f-saga1'))));
  await check(app, 'f-pair1');
  assert.strictEqual(text(section(app, 'f-pair1')), 'Collection All collection films are already in your library.');
  assert.strictEqual(text(section(app, 'f-pair2')), 'Collection All collection films are already in your library.', 'one lookup serves every film of that collection');
  assert.strictEqual(collectionCalls(t, 9300), 1);
  assert.deepStrictEqual(app.writes(), [], 'checking writes nothing');
  const solo = app.store.watchlist_items.find(r => r.id === 'f-solo');
  assert.deepStrictEqual([solo.tmdb_collection_id, solo.tmdb_collection_name, solo.collections], [9100, 'C9100 Collection', ['C9100 Collection']], 'the film keeps its collection identity');
});

test('menu: a failed check says so (not “nothing more”) and Retry checks again', async () => {
  const { app, t } = await boot();
  await allMovies(app);
  await check(app, 'f-lost');
  const s = text(section(app, 'f-lost'));
  assert.match(s, /Couldn’t check C9400 \(TMDB error 500|Couldn’t check C9400 \(/, 'the failure is named');
  assert.match(s, /Retry$/);
  assert.ok(!/already in your library/.test(s) && !section(app, 'f-lost').includes('libraryPullRest('));
  assert.ok(section(app, 'f-lost').includes("checkFilmCollection('f-lost')"), 'Retry checks again');
  t.failing.delete(9400); t.collections[9400] = [part(401, 'Lost One'), part(402, 'Lost Two')];
  await check(app, 'f-lost');
  assert.ok(section(app, 'f-lost').includes("libraryPullRest('f-lost', 9400,"), 'after a successful retry: Pull rest');
  assert.strictEqual(collectionCalls(t, 9400), 2);
});

test('a refreshed collection gaining a film: Refresh collections fetches again and the menu then offers Pull rest; a new page starts unknown', async () => {
  const { app, t } = await boot();
  await allMovies(app);
  await check(app, 'f-solo');
  assert.strictEqual(section(app, 'f-solo'), '');
  t.collections[9100] = [part(100, 'Solo Film'), part(101, 'Solo Film 2')]; // TMDB adds a sequel
  app.ctx.openLibraryPanel('movie', 'tools'); await settle();
  await app.ctx.libraryMovieTool('collections'); await settle();
  assert.match(preview(app), /New movies found[\s\S]*Solo Film 2/, 'Refresh collections finds it');
  app.ctx.renderTable();
  assert.ok(section(app, 'f-solo').includes("libraryPullRest('f-solo', 9100,"), 'and the menu now offers Pull rest');
  const fresh = await boot(t);
  await allMovies(fresh.app);
  assert.match(text(section(fresh.app, 'f-solo')), /Check collection/, 'a new page doesn’t carry an old result');
  assert.deepStrictEqual(app.writes(), []);
});

test('Pull rest’s own preview: the same states; nothing to add has no Add selected', async () => {
  const { app } = await boot();
  await allMovies(app);
  await check(app, 'f-pair1');
  await app.ctx.libraryPullRest('f-pair1', 9300, 'C9300'); await settle(); await settle();
  assert.match(preview(app), /All collection films are already in your library\./);
  assert.ok(!app.el('tmdbPreview').innerHTML.includes('addPulledCollectionMovies()'), 'no Add selected');
  await app.ctx.libraryPullRest('f-saga1', 9200, 'C9200'); await settle(); await settle();
  assert.match(preview(app), /Saga One Jan 1, 2020 Already added Saga Two/);
  assert.ok(app.el('tmdbPreview').innerHTML.includes('addPulledCollectionMovies()'), 'Add selected for a film to add');
  assert.deepStrictEqual(app.writes(), []);
});

test('menu in a personal collection: the same Check collection and states', async () => {
  const t = tmdbOf();
  const app = await createApp({ rows: ROWS(), tvShows: [], tmdb: p => t.fn(p),
    personalCollections: [{ id: '0c000000-0000-4000-8000-0000000000c1', name: 'Mine', legacy_source: null, sort_order: 1, archived_at: null, created_at: '2026-01-01T00:00:00Z' }],
    memberships: [{ id: '0d000000-0000-4000-8000-0000000000c1', collection_id: '0c000000-0000-4000-8000-0000000000c1', show_id: null, item_id: 'f-pair1', created_at: '2026-01-01T00:00:00Z' }] });
  app.ctx.openBrowseCollection('browse:0c000000-0000-4000-8000-0000000000c1'); await settle();
  assert.match(text(section(app, 'f-pair1')), /Check collection/);
  await check(app, 'f-pair1');
  assert.strictEqual(text(section(app, 'f-pair1')), 'Collection All collection films are already in your library.', 'Pair Two is in the library, not this collection: still counted');
});

// ── The add screen ──
test('add screen: a collection of one → no “Part of” note; one check per collection', async () => {
  const { app, t } = await boot();
  await pick(app, 500, 'Lone Movie');
  assert.doesNotMatch(preview(app), /Part of|pull|Couldn’t check|collection films/, 'nothing promised');
  assert.match(preview(app), /Adds a new film to your list/);
  assert.strictEqual(collectionCalls(t, 9500), 1);
  app.ctx.libraryRenderPreview();
  assert.strictEqual(collectionCalls(t, 9500), 1, 'a redraw doesn’t fetch again');
});

test('add screen: other films to add → the note with the count; all already added → the message', async () => {
  const { app } = await boot();
  await pick(app, 203, 'Saga Three');
  assert.match(preview(app), /🔗 Part of C9200, with 1 other film — you can pull it from the film’s ⋯ menu afterwards\./, 'Saga Two (Saga One is already added)');
  app.ctx.cancelTMDBPreview();
  await pick(app, 304, 'Pair Prequel');
  assert.match(preview(app), /🔗 Part of C9300\. All collection films are already in your library\./);
  assert.deepStrictEqual(app.writes(), []);
});

test('add screen: a failed check says so with Retry (never “nothing more”), and adding still works', async () => {
  const { app, t } = await boot();
  await pick(app, 402, 'Lost Two');
  assert.match(preview(app), /🔗 Couldn’t check C9400 \(.+\)\. Retry/);
  assert.ok(app.el('tmdbPreview').innerHTML.includes('retryAddScreenCollection(9400)'));
  assert.match(preview(app), /Add film/, 'the film can still be added');
  t.failing.delete(9400); t.collections[9400] = [part(401, 'Lost One'), part(402, 'Lost Two'), part(403, 'Lost Three')];
  await app.ctx.retryAddScreenCollection(9400); await settle();
  assert.match(preview(app), /Part of C9400, with 1 other film/, 'Lost One is already added; Lost Three can be pulled');
  await app.ctx.addSelectedTMDBSeasons(); await settle(); await settle();
  const added = app.store.watchlist_items.find(r => r.tmdb_id === 402);
  assert.ok(added && added.tmdb_collection_id === 9400, 'added with its collection identity');
});

T.run();
