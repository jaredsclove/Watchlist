// Offline tests for Match to TMDB (tmdb-match.js): the patch built for a confirmed
// match, conflict detection, and the real open → search → choose → confirm flow
// run against stubbed TMDB and database calls. Since Stage 5 a confirmed match is
// one database function call (library_match_season_b45 / library_match_film_b45) and what
// may be matched follows catalog governance (library.js), never storage.
// Run from the repo root: node tests/tmdb-match.test.js
// No network, no database: sbFetch is a stub that only records what would be sent.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const FILES = ['config.js', 'identity.js', 'ui-helpers.js', 'metadata.js', 'tmdb-search.js', 'tmdb-match.js', 'tv-shows.js', 'library.js', 'organization-manage.js'];
const CATALOGS = ['disney', 'sheridan', '90day'];
// Governance as the read views give it (coexistence: derived from where a row is stored).
function governanceOf(rows) {
  const shows = new Map(), films = new Map(), kinds = new Map();
  for (const r of rows) {
    const c = CATALOGS.includes(r.collection) ? r.collection : null;
    if (r.show_id) { if (c) shows.set(r.show_id, c); }
    else { if (c) films.set(r.id, c); kinds.set(r.id, r.collection === 'movies' ? 'genre' : 'other'); }
  }
  // (The snapshot speaks for every row and show of the fixture.)
  return { shows, films, kinds, knownItems: new Set(rows.map(r => r.id)), knownShows: new Set(rows.filter(r => r.show_id).map(r => r.show_id)), seq: 1, epoch: 0 };
}
const copy = v => JSON.parse(JSON.stringify(v)); // into this realm, so deepStrictEqual compares values

// Rows as the app stores them
const manual = extra => ({ id: 'row-1', collection: 'movies', item_key: 'dune|season 1', title: 'Dune', season: 'Season 1', theme: 'Sci-Fi',
  display_date: 'Oct 22, 2021', date_sort: '2021-10-22', watched: true, status: 'watching', created_at: '2026-09-01T10:00:00+00:00',
  watch_with: ['Suzanne'], collections: ['Favorites'], tmdb_collection_id: null, tmdb_collection_name: null,
  media_type: null, tmdb_id: null, season_number: null, ...extra });
// TMDB detail objects (trimmed)
const DUNE_2021 = { id: 438631, title: 'Dune', release_date: '2021-09-15', genres: [{ name: 'Science Fiction' }], production_companies: [{ name: 'Legendary Pictures' }],
  belongs_to_collection: { id: 726871, name: 'Dune Collection' } };
const DUNE_1984 = { id: 841, title: 'Dune', release_date: '1984-12-14', genres: [{ name: 'Action' }], production_companies: [{ name: 'De Laurentiis' }], belongs_to_collection: null };
const RD_FEATURE = { id: 500, title: 'Reservoir Dogs', release_date: '1992-09-02', genres: [{ name: 'Crime' }], belongs_to_collection: null };
const RD_SHORT = { id: 443129, title: 'Reservoir Dogs', release_date: '1991-06-01', genres: [{ name: 'Crime' }], belongs_to_collection: null };
const SILO = { id: 125988, name: 'Silo', networks: [{ name: 'Apple TV' }], seasons: [
  { season_number: 0, air_date: null, episode_count: 1 }, { season_number: 1, air_date: '2023-05-04', episode_count: 10 }, { season_number: 2, air_date: '2024-11-14', episode_count: 10 }] };

function makeEnv({ rows = [], tmdb = () => ({}), db = {} } = {}) {
  const els = new Map();
  const el = id => { if (!els.has(id)) els.set(id, { id, innerHTML: '', value: '', style: {}, classList: { add() {}, remove() {} }, scrollIntoView() {} }); return els.get(id); };
  const log = { writes: [], saved: 0 };
  const ctx = {
    console, setTimeout: () => 0,
    document: { getElementById: el, querySelectorAll: () => [] },
    tabData: {},
    tvShowsById: new Map(),
    // a view is open (All TV / All Movies: the rows its Match controls came from)
    activeViewId: 'alltv', libraryPanel: null, libraryPanelSeq: 0, actionRows: () => rows, libraryGovernance: governanceOf(rows),
    isBrowseView: () => false, loadDerivedView() {}, loadBrowseView() {},
    fetchAllRows: async table => (table === 'tv_shows' ? [] : (() => { throw new Error(`unexpected read ${table}`); })()), // api.js (the show list after a TV match)
    isFilmRow: r => !!r && (r.media_type === 'movie' || (r.media_type == null && r.season === 'Film')), // browse-views.js
    // page state the Match flow reads (watchlist.html): request stamps and the restore epoch
    matchRequestSeq: 0, matchLatestByRow: {}, matchRefreshSeq: 0, matchRefreshStamp: null, orgEpoch: 0, matchRefreshProgress: null, matchReadSeq: 0, matchReads: [], matchPublished: { epoch: 0, rows: {}, shows: {} },
    tmdbFetch: async p => tmdb(p),
    sbFetch: async (method, p, body) => {
      if (method === 'GET') {
        if (p.startsWith('othertv_shows')) return db.tracked || [];
        if (/[?&]id=eq\./.test(p)) { const id = p.match(/[?&]id=eq\.([^&]+)/)[1]; return (db.afterPatch || rows).filter(r => r.id === id).map(r => ({ ...r })); }
        if (/tmdb_id=is\.null&item_key=eq\./.test(p)) return db.sameKey || [];
        return db.sameIdentity || [];
      }
      log.writes.push({ method, path: p, body: body ? copy(body) : null });
      if (db.fail && db.fail(method, p)) throw db.fail(method, p);
      if (p === 'rpc/library_match_season_b45') {
        if (db.blocked) return { blocked: true, legacy_status: 'watching', target_status: 'confirmed', legacy_show_id: 'L', target_show_id: 'T' };
        const row = rows.find(r => r.id === body.p_row_id);
        return { blocked: false, row: { ...row, ...body.p_patch, show_id: 'show-silo' }, show_id: 'show-silo' };
      }
      if (p === 'rpc/library_match_film_b45') {
        if (db.filmAnswer) return db.filmAnswer;
        const row = rows.find(r => r.id === body.p_row_id);
        const former = row.show_id || null;
        return { row: { ...row, ...body.p_patch, show_id: null }, former_show_id: former, former_show_deleted: !!former && !db.formerKeepsSeasons, memberships_carried: 0 };
      }
      throw new Error(`unexpected write ${method} ${p}`);
    },
    cancelTMDBPreview() {}, renderFilters() {}, renderTable() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
  // The database-function helpers from api.js (sbRpc, …), without its sbFetch.
  const api = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
  vm.runInContext(api.slice(api.indexOf('// ─── Database functions'), api.indexOf('async function tmdbFetch')), ctx);
  ctx.showSaved = () => { log.saved++; };
  ctx.cancelTMDBPreview = () => {}; // the real one (tmdb-search.js) needs a DOM
  const text = id => el(id).innerHTML.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  el('tmdbMatchQuery');
  return { ctx, log, el, banner: () => text('errorBanner'), body: () => text('tmdbMatchBody') };
}
const dup = () => { const e = new Error('Supabase error 409: {"code":"23505","message":"duplicate key value violates unique constraint \\"watchlist_items_movie_identity_key\\""}'); return e; };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── eligibility ──
test('eligible: unidentified rows no catalog governs; governed rows (a governed film, a season of a governed show) and identified rows are not', () => {
  const rows = [manual({ id: 'a' }), manual({ id: 'b', collection: 'othertv', show_id: 's1' }), manual({ id: 'c', collection: 'disney' }),
    manual({ id: 'd', collection: 'disney', show_id: 's2' }), manual({ id: 'e', media_type: 'movie', tmdb_id: 841 })];
  const { ctx } = makeEnv({ rows });
  assert.deepStrictEqual(rows.map(r => ctx.isTmdbMatchEligible(r)), [true, true, false, false, false]);
});

// ── patch building ──
test('1. manual movie row → selected movie: exact fields written', () => {
  const { ctx } = makeEnv();
  assert.deepStrictEqual(copy(ctx.buildTmdbMatchPatch(manual(), { mediaType: 'movie', details: DUNE_2021 }, true)), {
    title: 'Dune', season: 'Film', item_key: 'dune|film', theme: 'Science Fiction',
    display_date: 'Sep 15, 2021', date_sort: '2021-09-15',
    tmdb_collection_id: 726871, tmdb_collection_name: 'Dune Collection',
    media_type: 'movie', tmdb_id: 438631, season_number: null,
    collections: ['Favorites', 'Dune Collection'],
  });
});
test('2. manual TV row → selected season: exact fields written', () => {
  const { ctx } = makeEnv();
  const row = manual({ collection: 'othertv', title: 'silo', item_key: 'silo|season 2', season: 'Season 2', theme: 'Apple' });
  assert.deepStrictEqual(copy(ctx.buildTmdbMatchPatch(row, { mediaType: 'tv', details: SILO, seasonNumber: 2 }, false)), {
    title: 'Silo', season: 'Season 2', item_key: 'silo|season 2', theme: 'Apple TV',
    display_date: 'Nov 14, 2024', date_sort: '2024-11-14', media_type: 'tv', tmdb_id: 125988, season_number: 2,
  });
  const specials = ctx.buildTmdbMatchPatch(row, { mediaType: 'tv', details: SILO, seasonNumber: 0 }, false);
  assert.deepStrictEqual([specials.season, specials.item_key, specials.display_date, specials.date_sort], ['Specials', 'silo|specials', 'TBA', '2099-01-01']);
});
test('TV without a chosen (or valid) season → no patch', () => {
  const { ctx } = makeEnv();
  assert.strictEqual(ctx.buildTmdbMatchPatch(manual(), { mediaType: 'tv', details: SILO, seasonNumber: null }, false), null);
  assert.strictEqual(ctx.buildTmdbMatchPatch(manual(), { mediaType: 'tv', details: SILO, seasonNumber: 7 }, false), null);
});
test('a film whose theme isn’t a genre (theme_kind other, e.g. True Crime / Docs) uses the production company, as TMDB adds do', () => {
  const { ctx } = makeEnv();
  assert.strictEqual(ctx.buildTmdbMatchPatch(manual({ collection: 'truecrime' }), { mediaType: 'movie', details: DUNE_1984 }, false).theme, 'De Laurentiis');
});
test('3. same title, different TMDB ids: an identified same-title row does not block, the chosen id is written', () => {
  const { ctx } = makeEnv();
  const other = manual({ id: 'row-2', item_key: 'dune|film', title: 'Dune', media_type: 'movie', tmdb_id: 841 });
  const patch = ctx.buildTmdbMatchPatch(manual(), { mediaType: 'movie', details: DUNE_2021 }, true);
  assert.strictEqual(patch.tmdb_id, 438631);
  assert.strictEqual(ctx.findTmdbMatchConflict(manual(), patch, [other]), null);
});
test('4. remake vs original: each choice writes its own id and date', () => {
  const { ctx } = makeEnv();
  const a = ctx.buildTmdbMatchPatch(manual(), { mediaType: 'movie', details: DUNE_1984 }, true);
  const b = ctx.buildTmdbMatchPatch(manual(), { mediaType: 'movie', details: DUNE_2021 }, true);
  assert.deepStrictEqual([a.tmdb_id, a.date_sort, a.tmdb_collection_id], [841, '1984-12-14', null]);
  assert.deepStrictEqual([b.tmdb_id, b.date_sort, b.tmdb_collection_id], [438631, '2021-09-15', 726871]);
});
test('5. short vs feature: the selected object decides, never the title', () => {
  const { ctx } = makeEnv();
  const row = manual({ title: 'Reservoir Dogs', item_key: 'reservoir dogs|season 1' });
  assert.strictEqual(ctx.buildTmdbMatchPatch(row, { mediaType: 'movie', details: RD_FEATURE }, true).tmdb_id, 500);
  assert.strictEqual(ctx.buildTmdbMatchPatch(row, { mediaType: 'movie', details: RD_SHORT }, true).tmdb_id, 443129);
  // the short already on the list does not block matching the feature, and vice versa
  const shortOnList = manual({ id: 'row-9', title: 'Reservoir Dogs', item_key: 'reservoir dogs|film', media_type: 'movie', tmdb_id: 443129 });
  assert.strictEqual(ctx.findTmdbMatchConflict(row, ctx.buildTmdbMatchPatch(row, { mediaType: 'movie', details: RD_FEATURE }, true), [shortOnList]), null);
});
test('6. target movie identity already on the list → blocked, naming the existing row', () => {
  const { ctx } = makeEnv();
  const existing = manual({ id: 'row-2', title: 'Dune', season: 'Film', item_key: 'dune|film', media_type: 'movie', tmdb_id: 438631 });
  const c = ctx.findTmdbMatchConflict(manual(), ctx.buildTmdbMatchPatch(manual(), { mediaType: 'movie', details: DUNE_2021 }, true), [existing]);
  assert.strictEqual(c.kind, 'identity');
  assert.ok(ctx.tmdbMatchConflictMessage(c).startsWith('"Dune — Film" is already on this list'));
});
test('7. target TV season already on the list → blocked; another season of the same show is fine', () => {
  const { ctx } = makeEnv();
  const row = manual({ collection: 'othertv', item_key: 'silo|season 2' });
  const patch = ctx.buildTmdbMatchPatch(row, { mediaType: 'tv', details: SILO, seasonNumber: 2 }, false);
  const s2 = manual({ id: 'r2', collection: 'othertv', title: 'Silo', season: 'Season 2', media_type: 'tv', tmdb_id: 125988, season_number: 2 });
  const s1 = { ...s2, id: 'r1', season: 'Season 1', season_number: 1 };
  assert.strictEqual(ctx.findTmdbMatchConflict(row, patch, [s1]), null);
  assert.strictEqual(ctx.findTmdbMatchConflict(row, patch, [s1, s2]).kind, 'identity');
});
test('8. a season’s new item_key already used by an unmatched season of the show it joins → blocked; a same-named unmatched film doesn’t block a film (Stage 5)', () => {
  const { ctx } = makeEnv();
  const row = manual({ collection: 'othertv', item_key: 'silo|season 2', show_id: 'show-silo' });
  const patch = ctx.buildTmdbMatchPatch(row, { mediaType: 'tv', details: SILO, seasonNumber: 2 }, false);
  const legacy = manual({ id: 'row-3', item_key: 'silo|season 2', title: 'Silo', season: 'Season 2', show_id: 'show-silo' });
  const c = ctx.findTmdbMatchConflict(row, patch, [legacy], 'show-silo');
  assert.strictEqual(c.kind, 'item_key');
  assert.ok(ctx.tmdbMatchConflictMessage(c).includes('Another unmatched row'));
  const film = manual({ id: 'row-4', item_key: 'dune|film', title: 'Dune', season: 'Film' });
  assert.strictEqual(ctx.findTmdbMatchConflict(manual(), ctx.buildTmdbMatchPatch(manual(), { mediaType: 'movie', details: DUNE_2021 }, true), [film]), null);
});
test('the target identity blocks wherever it is saved: identity is library-wide since Stage 5', () => {
  const { ctx } = makeEnv();
  const elsewhere = manual({ id: 'row-4', collection: 'truecrime', media_type: 'movie', tmdb_id: 438631, item_key: 'dune|film' });
  assert.strictEqual(ctx.findTmdbMatchConflict(manual(), ctx.buildTmdbMatchPatch(manual(), { mediaType: 'movie', details: DUNE_2021 }, true), [elsewhere]).kind, 'identity');
});
test('10. user-owned fields are never in the patch', () => {
  const { ctx } = makeEnv();
  for (const target of [{ mediaType: 'movie', details: DUNE_2021 }, { mediaType: 'tv', details: SILO, seasonNumber: 1 }]) {
    const keys = Object.keys(ctx.buildTmdbMatchPatch(manual(), target, true));
    for (const k of ['id', 'collection', 'created_at', 'watched', 'watch_with', 'status']) assert.ok(!keys.includes(k), `${k} in patch`);
  }
  assert.ok(!('collections' in ctx.buildTmdbMatchPatch(manual(), { mediaType: 'tv', details: SILO, seasonNumber: 1 }, false)));
});
test('11. franchise tag: added once with TMDB\'s full name, user tags kept, not duplicated', () => {
  const { ctx } = makeEnv();
  const p = ctx.buildTmdbMatchPatch(manual({ collections: ['Favorites', 'Dune Collection'] }), { mediaType: 'movie', details: DUNE_2021 }, true);
  assert.ok(!('collections' in p));
  assert.deepStrictEqual([p.tmdb_collection_id, p.tmdb_collection_name], [726871, 'Dune Collection']);
  assert.deepStrictEqual(copy(ctx.buildTmdbMatchPatch(manual({ collections: null }), { mediaType: 'movie', details: DUNE_2021 }, true).collections), ['Dune Collection']);
});

// ── the real flow, stubbed ──
const searchStub = p => {
  if (p.startsWith('/search/movie')) return { results: [{ id: 841, title: 'Dune', release_date: '1984-12-14' }, { id: 438631, title: 'Dune', release_date: '2021-09-15' }] };
  if (p.startsWith('/search/tv')) return { results: [{ id: 125988, name: 'Silo', first_air_date: '2023-05-04' }] };
  if (p === '/movie/438631') return DUNE_2021;
  if (p === '/movie/841') return DUNE_1984;
  if (p === '/tv/125988') return SILO;
  throw new Error('unexpected ' + p);
};
async function openAndSearch(env, rowId = 'row-1') {
  env.ctx.openTmdbMatch(rowId);
  env.el('tmdbMatchQuery').value = 'Dune';
  await env.ctx.searchTmdbMatch();
}
test('12. opening and searching never matches automatically (no write, no target chosen)', async () => {
  const row = manual(); const env = makeEnv({ rows: [row], tmdb: searchStub });
  await openAndSearch(env);
  assert.strictEqual(env.log.writes.length, 0);
  assert.strictEqual(env.ctx.__tmdbMatch.target, null);
  assert.strictEqual(env.ctx.__tmdbMatch.results.length, 3);
  assert.ok(env.body().includes('nothing is matched until you confirm'), env.body());
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(env.log.writes.length, 0);
  assert.strictEqual(row.tmdb_id, null);
});
test('12b. choosing a series without a season → Confirm does nothing', async () => {
  const row = manual({ collection: 'othertv' }); const env = makeEnv({ rows: [row], tmdb: searchStub });
  await openAndSearch(env);
  const idx = env.ctx.__tmdbMatch.results.findIndex(r => r.mediaType === 'tv');
  await env.ctx.chooseTmdbMatchResult(idx);
  assert.strictEqual(env.ctx.__tmdbMatch.target.seasonNumber, null);
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(env.log.writes.length, 0);
});
test('confirm movie: one library_match_film_b45 call with exactly the patch and the row’s show (none), row updated in place, Saved shown', async () => {
  const row = manual(); const env = makeEnv({ rows: [row], tmdb: searchStub });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  assert.ok(env.body().includes('Dune Collection') && env.body().includes('not matched → Film 438631'), env.body());
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(env.log.writes.length, 1);
  const w = env.log.writes[0];
  assert.deepStrictEqual([w.method, w.path], ['POST', 'rpc/library_match_film_b45']);
  assert.deepStrictEqual(w.body.p_expected, { show_id: null });
  assert.strictEqual(w.body.p_row_id, 'row-1');
  assert.strictEqual(w.body.p_patch.tmdb_id, 438631);
  assert.ok(!('collection' in w.body.p_patch) && !('theme_kind' in w.body.p_patch), 'no storage, no kind: the database keeps them');
  assert.deepStrictEqual([row.id, row.tmdb_id, row.media_type, row.watched, row.status, row.created_at], ['row-1', 438631, 'movie', true, 'watching', '2026-09-01T10:00:00+00:00']);
  assert.deepStrictEqual(copy(row.watch_with), ['Suzanne']);
  assert.strictEqual(env.log.saved, 1);
});
async function matchSiloS1(db) {
  const row = manual({ collection: 'othertv' });
  const env = makeEnv({ rows: [row], tmdb: searchStub, db });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.mediaType === 'tv'));
  env.ctx.chooseTmdbMatchSeason(1);
  await env.ctx.confirmTmdbMatch();
  return { row, env, writes: env.log.writes.map(w => `${w.method} ${w.path.split('?')[0]}`) };
}
test('confirm TV season → one library_match_season_b45 call with the exact patch and target; the database tracks the show; no other write', async () => {
  const { row, env, writes } = await matchSiloS1({});
  assert.deepStrictEqual(writes, ['POST rpc/library_match_season_b45']);
  const call = env.log.writes[0].body;
  assert.strictEqual(call.p_row_id, 'row-1');
  assert.deepStrictEqual(call.p_target, { tmdb_id: 125988, network: 'Apple TV' });
  assert.deepStrictEqual(call.p_patch, copy(env.ctx.buildTmdbMatchPatch(manual({ collection: 'othertv' }), { mediaType: 'tv', details: SILO, seasonNumber: 1 }, false)));
  assert.deepStrictEqual([row.tmdb_id, row.season_number, row.season, row.title, row.show_id], [125988, 1, 'Season 1', 'Silo', 'show-silo']);
  assert.strictEqual(env.banner(), '');
  assert.strictEqual(env.log.saved, 1);
});
test('confirm TV season, the database finds a conflict (match_conflict 23505) → friendly message, row untouched, no Saved', async () => {
  const conflict = new Error('Supabase error 409: {"code":"23505","message":"match_conflict: identity already on the list as row x"}');
  const { row, env } = await matchSiloS1({ fail: (m, p) => (p === 'rpc/library_match_season_b45' ? conflict : null) });
  assert.strictEqual(row.tmdb_id, null);
  assert.ok(env.banner().includes('added to this list somewhere else'), env.banner());
  assert.strictEqual(env.log.saved, 0);
});
test('confirm TV season, the row was matched elsewhere (not_found) → "changed somewhere else", no Saved', async () => {
  const gone = new Error('Supabase error 404: {"code":"P0002","message":"not_found: unidentified row"}');
  const { row, env } = await matchSiloS1({ fail: (m, p) => (p === 'rpc/library_match_season_b45' ? gone : null) });
  assert.strictEqual(row.tmdb_id, null);
  assert.ok(env.banner().includes('changed somewhere else'), env.banner());
  assert.strictEqual(env.log.saved, 0);
});
test('confirm film for a row linked as a TV season → one library_match_film_b45 call naming its show; the database unlinks it and removes the emptied show (one transaction)', async () => {
  const row = manual({ collection: 'truecrime', show_id: 'show-legacy' });
  const env = makeEnv({ rows: [row], tmdb: searchStub });
  env.ctx.tvShowsById.set('show-legacy', { id: 'show-legacy' });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  await env.ctx.confirmTmdbMatch();
  assert.deepStrictEqual(env.log.writes.map(w => `${w.method} ${w.path}`), ['POST rpc/library_match_film_b45']);
  assert.deepStrictEqual(env.log.writes[0].body.p_expected, { show_id: 'show-legacy' });
  assert.ok(!('show_id' in env.log.writes[0].body.p_patch), 'the database unlinks it');
  assert.deepStrictEqual([row.show_id, row.media_type], [null, 'movie']);
  assert.strictEqual(env.ctx.tvShowsById.has('show-legacy'), false, 'the removed show is dropped from the page');
  assert.strictEqual(env.log.saved, 1);
});
test('confirm film, the former show still has seasons → matched, the show kept, no error', async () => {
  const row = manual({ collection: 'truecrime', show_id: 'show-legacy' });
  const env = makeEnv({ rows: [row], tmdb: searchStub, db: { formerKeepsSeasons: true } });
  env.ctx.tvShowsById.set('show-legacy', { id: 'show-legacy' });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(row.tmdb_id, 438631);
  assert.strictEqual(env.ctx.tvShowsById.has('show-legacy'), true);
  assert.strictEqual(env.banner(), '');
  assert.strictEqual(env.log.saved, 1);
});
test('confirm TV season blocked (target show has another status) → nothing written beyond the call, clear message, no Saved', async () => {
  const { row, env, writes } = await matchSiloS1({ blocked: true });
  assert.deepStrictEqual(writes, ['POST rpc/library_match_season_b45']);
  assert.strictEqual(row.tmdb_id, null);
  assert.ok(/Not matched: "Silo" is already on this list as To Watch, but this row's show is Watching/.test(env.banner()), env.banner());
  assert.strictEqual(env.log.saved, 0);
});
test('confirm film for an unlinked row → p_expected names no show; the patch carries no show_id at all', async () => {
  const row = manual({ collection: 'truecrime', show_id: null });
  const env = makeEnv({ rows: [row], tmdb: searchStub });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  await env.ctx.confirmTmdbMatch();
  const w = env.log.writes.find(x => x.path === 'rpc/library_match_film_b45');
  assert.deepStrictEqual(w.body.p_expected, { show_id: null });
  assert.ok(!('show_id' in w.body.p_patch));
});
test('6b. confirm when the database already has the target identity → no write, clear message', async () => {
  const row = manual();
  const existing = manual({ id: 'row-2', title: 'Dune', season: 'Film', item_key: 'dune|film', media_type: 'movie', tmdb_id: 438631 });
  const env = makeEnv({ rows: [row], tmdb: searchStub, db: { sameIdentity: [existing] } });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(env.log.writes.length, 0);
  assert.strictEqual(row.tmdb_id, null);
  assert.ok(env.banner().includes('"Dune — Film" is already on this list'), env.banner());
});
test('8b. confirm a season when an unmatched season of that show already uses the new item_key → no write', async () => {
  const row = manual({ collection: 'othertv', show_id: 'show-silo', title: 'silo', item_key: 'silo|season 7' });
  const env = makeEnv({ rows: [row], tmdb: searchStub,
    db: { sameKey: [manual({ id: 'row-3', collection: 'othertv', title: 'Silo', item_key: 'silo|season 1', season: 'Season 1', show_id: 'show-silo' })] } });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.mediaType === 'tv'));
  env.ctx.chooseTmdbMatchSeason(1);
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(env.log.writes.length, 0);
  assert.ok(env.banner().includes('Another unmatched row'), env.banner());
});
test('9. a 23505 from the database (race) → friendly message, row untouched, no Saved', async () => {
  const row = manual();
  const env = makeEnv({ rows: [row], tmdb: searchStub, db: { fail: (m, p) => p === 'rpc/library_match_film_b45' ? dup() : null } });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(row.tmdb_id, null);
  assert.strictEqual(env.log.saved, 0);
  assert.ok(env.banner().includes('added to this list somewhere else just now, so nothing was changed'), env.banner());
});
test('row matched elsewhere first (library_match_film_b45: not_found) → reported, not claimed as saved', async () => {
  const row = manual();
  const gone = new Error('Supabase error 404: {"code":"P0002","message":"not_found: unidentified row"}');
  const env = makeEnv({ rows: [row], tmdb: searchStub, db: { fail: (m, p) => p === 'rpc/library_match_film_b45' ? gone : null } });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(row.tmdb_id, null);
  assert.strictEqual(env.log.saved, 0);
  assert.ok(env.banner().includes('changed somewhere else'), env.banner());
});

// ── Failures after the match was sent (hosted check H-1 and its review) ──
const timeoutErr = () => new Error('Supabase error 500: {"code":"57014","details":null,"hint":null,"message":"canceling statement due to statement timeout"}');
async function confirmDune(env) {
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  await env.ctx.confirmTmdbMatch();
}
test('film: an answer whose row isn’t the match → reported as changed elsewhere, page row untouched, not claimed as saved', async () => {
  // (Stage 5: there is no separate read-back; library_match_film_b45 answers with the row in the same transaction.)
  const row = manual({ collection: 'truecrime', show_id: 'show-legacy' });
  const env = makeEnv({ rows: [row], tmdb: searchStub, db: { filmAnswer: { row: { ...row, media_type: 'movie', tmdb_id: 841 } } } });
  await confirmDune(env);
  assert.deepStrictEqual(env.log.writes.map(w => w.path), ['rpc/library_match_film_b45']);
  assert.deepStrictEqual([row.tmdb_id, row.show_id], [null, 'show-legacy']);
  assert.strictEqual(env.log.saved, 0);
  assert.ok(env.banner().includes('changed somewhere else'), env.banner());
});
test('film: library_match_film_b45 times out (57014, one transaction, cancelled) → "cancelled, nothing was matched", row untouched', async () => {
  const row = manual();
  const env = makeEnv({ rows: [row], tmdb: searchStub, db: { fail: (m, p) => p === 'rpc/library_match_film_b45' ? timeoutErr() : null } });
  await confirmDune(env);
  assert.strictEqual(row.tmdb_id, null);
  assert.strictEqual(env.log.saved, 0);
  assert.ok(env.banner().includes('didn’t finish the match in time, so it was cancelled and nothing was matched'), env.banner());
});
test('film: library_match_film_b45 gets no answer (network failure) → "can\'t tell whether it was saved", row untouched', async () => {
  const row = manual();
  const env = makeEnv({ rows: [row], tmdb: searchStub, db: { fail: (m, p) => p === 'rpc/library_match_film_b45' ? new TypeError('Failed to fetch') : null } });
  await confirmDune(env);
  assert.strictEqual(row.tmdb_id, null);
  assert.strictEqual(env.log.saved, 0);
  assert.ok(/no answer came back from the database \(Failed to fetch\), so the page can't tell whether it was saved/.test(env.banner()), env.banner());
});
test('TV season: library_match_season_b45 times out (57014, one transaction) → "cancelled, nothing was matched"', async () => {
  const { row, env } = await matchSiloS1({ fail: (m, p) => p === 'rpc/library_match_season_b45' ? timeoutErr() : null });
  assert.strictEqual(row.tmdb_id, null);
  assert.strictEqual(env.log.saved, 0);
  assert.ok(env.banner().includes('didn’t finish the match in time, so it was cancelled and nothing was matched'), env.banner());
});
test('TV season: library_match_season_b45 gets no answer (network failure) → "can\'t tell whether it was saved"', async () => {
  const { row, env } = await matchSiloS1({ fail: (m, p) => p === 'rpc/library_match_season_b45' ? new TypeError('Failed to fetch') : null });
  assert.strictEqual(row.tmdb_id, null);
  assert.ok(/can't tell whether it was saved/.test(env.banner()), env.banner());
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
