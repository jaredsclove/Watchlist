// Offline tests for Match to TMDB (tmdb-match.js): the patch built for a confirmed
// match, conflict detection, and the real open → search → choose → confirm flow
// run against stubbed TMDB and database calls.
// Run from the repo root: node tests/tmdb-match.test.js
// No network, no database: sbFetch is a stub that only records what would be sent.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const FILES = ['config.js', 'identity.js', 'ui-helpers.js', 'tmdb-search.js', 'tmdb-match.js', 'tv-shows.js'];
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

function makeEnv({ rows = [], tab = 'movies', tmdb = () => ({}), db = {} } = {}) {
  const els = new Map();
  const el = id => { if (!els.has(id)) els.set(id, { id, innerHTML: '', value: '', classList: { add() {}, remove() {} }, scrollIntoView() {} }); return els.get(id); };
  const log = { writes: [], saved: 0 };
  const ctx = {
    console, setTimeout: () => 0,
    document: { getElementById: el, querySelectorAll: () => [] },
    tabData: { [tab]: { rows, loaded: true, newKeys: [] } },
    tvShowsById: new Map(),
    activeTabId: tab,
    tmdbFetch: async p => tmdb(p),
    sbFetch: async (method, p, body) => {
      if (method === 'GET') {
        if (p.startsWith('othertv_shows')) return db.tracked || [];
        if (/id=eq\./.test(p) && !/collection=/.test(p)) { const id = p.match(/id=eq\.([^&]+)/)[1]; return (db.afterPatch || rows).filter(r => r.id === id).map(r => ({ ...r })); }
        if (/tmdb_id=is\.null&item_key=eq\./.test(p)) return db.sameKey || [];
        return db.sameIdentity || [];
      }
      log.writes.push({ method, path: p, body: body ? copy(body) : null });
      if (db.fail && db.fail(method, p)) throw db.fail(method, p);
      if (p === 'rpc/match_tv_row') {
        if (db.blocked) return { blocked: true, legacy_status: 'watching', target_status: 'complete', legacy_show_id: 'L', target_show_id: 'T' };
        const row = rows.find(r => r.id === body.p_row_id);
        return { blocked: false, row: { ...row, ...body.p_patch, show_id: 'show-silo' }, show_id: 'show-silo' };
      }
      if (method === 'PATCH') { const id = p.match(/id=eq\.([^&]+)/)[1]; db.afterPatch = rows.map(r => r.id === id ? { ...r, ...body } : r); }
      return null;
    },
    cancelTMDBPreview() {}, renderFilters() {}, renderTable() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
  // The TV-write helpers from api.js (isTvCollection, sbRpc, …), without its sbFetch.
  const api = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
  vm.runInContext(api.slice(api.indexOf('// ─── TV structural writes'), api.indexOf('async function tmdbFetch')), ctx);
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
test('eligible: unidentified rows on dynamic tabs only; static defaults and identified rows are not', () => {
  const { ctx } = makeEnv();
  assert.strictEqual(ctx.isTmdbMatchEligible(manual()), true);
  assert.strictEqual(ctx.isTmdbMatchEligible(manual({ collection: 'othertv' })), true);
  assert.strictEqual(ctx.isTmdbMatchEligible(manual({ collection: 'disney' })), false);
  assert.strictEqual(ctx.isTmdbMatchEligible(manual({ media_type: 'movie', tmdb_id: 841 })), false);
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
test('Movie on a non-Movies tab (True Crime / Docs) uses the production company, as TMDB adds do', () => {
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
test('8. new item_key already used by another unmatched row → blocked', () => {
  const { ctx } = makeEnv();
  const legacy = manual({ id: 'row-3', item_key: 'dune|film', title: 'Dune', season: 'Film' });
  const c = ctx.findTmdbMatchConflict(manual(), ctx.buildTmdbMatchPatch(manual(), { mediaType: 'movie', details: DUNE_2021 }, true), [legacy]);
  assert.strictEqual(c.kind, 'item_key');
  assert.ok(ctx.tmdbMatchConflictMessage(c).includes('Another unmatched row'));
});
test('rows in another collection never block', () => {
  const { ctx } = makeEnv();
  const elsewhere = manual({ id: 'row-4', collection: 'truecrime', media_type: 'movie', tmdb_id: 438631, item_key: 'dune|film' });
  assert.strictEqual(ctx.findTmdbMatchConflict(manual(), ctx.buildTmdbMatchPatch(manual(), { mediaType: 'movie', details: DUNE_2021 }, true), [elsewhere]), null);
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
  const row = manual({ collection: 'othertv' }); const env = makeEnv({ tab: 'othertv', rows: [row], tmdb: searchStub });
  await openAndSearch(env);
  const idx = env.ctx.__tmdbMatch.results.findIndex(r => r.mediaType === 'tv');
  await env.ctx.chooseTmdbMatchResult(idx);
  assert.strictEqual(env.ctx.__tmdbMatch.target.seasonNumber, null);
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(env.log.writes.length, 0);
});
test('confirm movie: guarded PATCH of exactly the patch, row updated in place, Saved shown', async () => {
  const row = manual(); const env = makeEnv({ rows: [row], tmdb: searchStub });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  assert.ok(env.body().includes('Dune Collection') && env.body().includes('not matched → Film 438631'), env.body());
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(env.log.writes.length, 1);
  const w = env.log.writes[0];
  assert.strictEqual(w.method, 'PATCH');
  assert.strictEqual(w.path, 'watchlist_items?id=eq.row-1&tmdb_id=is.null&media_type=is.null&season_number=is.null');
  assert.strictEqual(w.body.tmdb_id, 438631);
  assert.deepStrictEqual([row.id, row.tmdb_id, row.media_type, row.watched, row.status, row.created_at], ['row-1', 438631, 'movie', true, 'watching', '2026-09-01T10:00:00+00:00']);
  assert.deepStrictEqual(copy(row.watch_with), ['Suzanne']);
  assert.strictEqual(env.log.saved, 1);
});
async function matchSiloS1(db) {
  const row = manual({ collection: 'othertv' });
  const env = makeEnv({ tab: 'othertv', rows: [row], tmdb: searchStub, db });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.mediaType === 'tv'));
  env.ctx.chooseTmdbMatchSeason(1);
  await env.ctx.confirmTmdbMatch();
  return { row, env, writes: env.log.writes.map(w => `${w.method} ${w.path.split('?')[0]}`) };
}
test('confirm TV season on a TV tab → one match_tv_row call with the exact patch and target; the database tracks the show; no other write', async () => {
  const { row, env, writes } = await matchSiloS1({});
  assert.deepStrictEqual(writes, ['POST rpc/match_tv_row']);
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
  const { row, env } = await matchSiloS1({ fail: (m, p) => (p === 'rpc/match_tv_row' ? conflict : null) });
  assert.strictEqual(row.tmdb_id, null);
  assert.ok(env.banner().includes('added to this list somewhere else'), env.banner());
  assert.strictEqual(env.log.saved, 0);
});
test('confirm TV season, the row was matched elsewhere (not_found) → "changed somewhere else", no Saved', async () => {
  const gone = new Error('Supabase error 404: {"code":"P0002","message":"not_found: unidentified row"}');
  const { row, env } = await matchSiloS1({ fail: (m, p) => (p === 'rpc/match_tv_row' ? gone : null) });
  assert.strictEqual(row.tmdb_id, null);
  assert.ok(env.banner().includes('changed somewhere else'), env.banner());
  assert.strictEqual(env.log.saved, 0);
});
test('confirm film for a row linked as a TV season → the guarded PATCH also unlinks it (films never link to a show)', async () => {
  const row = manual({ collection: 'truecrime', show_id: 'show-legacy' });
  const env = makeEnv({ tab: 'truecrime', rows: [row], tmdb: searchStub });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  await env.ctx.confirmTmdbMatch();
  const patch = env.log.writes.find(w => w.method === 'PATCH');
  assert.strictEqual(patch.body.show_id, null);
  assert.strictEqual(patch.body.media_type, 'movie');
  assert.strictEqual(row.show_id, null);
  // The former show is removed if it has no seasons left (ON DELETE RESTRICT refuses otherwise).
  assert.deepStrictEqual(env.log.writes.map(w => `${w.method} ${w.path}`), ['PATCH watchlist_items?id=eq.row-1&tmdb_id=is.null&media_type=is.null&season_number=is.null', 'DELETE tv_shows?id=eq.show-legacy']);
  assert.strictEqual(env.log.saved, 1);
});
test('confirm film, the former show still has seasons (23503) → matched, no error', async () => {
  const row = manual({ collection: 'truecrime', show_id: 'show-legacy' });
  const restrict = new Error('Supabase error 409: {"code":"23503","message":"update or delete on table \\"tv_shows\\" violates foreign key constraint"}');
  const env = makeEnv({ tab: 'truecrime', rows: [row], tmdb: searchStub, db: { fail: (m, p) => (m === 'DELETE' ? restrict : null) } });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(row.tmdb_id, 438631);
  assert.strictEqual(env.banner(), '');
  assert.strictEqual(env.log.saved, 1);
});
test('confirm TV season blocked (target show has another status) → nothing written beyond the call, clear message, no Saved', async () => {
  const { row, env, writes } = await matchSiloS1({ blocked: true });
  assert.deepStrictEqual(writes, ['POST rpc/match_tv_row']);
  assert.strictEqual(row.tmdb_id, null);
  assert.ok(/Not matched: "Silo" is already on this list as Complete, but this row's show is Watching/.test(env.banner()), env.banner());
  assert.strictEqual(env.log.saved, 0);
});
test('confirm film for an unlinked row → the PATCH carries no show_id at all', async () => {
  const row = manual({ collection: 'truecrime', show_id: null });
  const env = makeEnv({ tab: 'truecrime', rows: [row], tmdb: searchStub });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  await env.ctx.confirmTmdbMatch();
  assert.ok(!('show_id' in env.log.writes.find(w => w.method === 'PATCH').body));
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
test('8b. confirm when an unmatched row already uses the new item_key → no write', async () => {
  const row = manual();
  const env = makeEnv({ rows: [row], tmdb: searchStub, db: { sameKey: [manual({ id: 'row-3', item_key: 'dune|film', season: 'Film' })] } });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 841));
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(env.log.writes.length, 0);
  assert.ok(env.banner().includes('Another unmatched row'), env.banner());
});
test('9. a 23505 from the database (race) → friendly message, row untouched, no Saved', async () => {
  const row = manual();
  const env = makeEnv({ rows: [row], tmdb: searchStub, db: { fail: m => m === 'PATCH' ? dup() : null } });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(row.tmdb_id, null);
  assert.strictEqual(env.log.saved, 0);
  assert.ok(env.banner().includes('added to this list somewhere else just now, so nothing was changed'), env.banner());
});
test('row matched elsewhere first (guarded PATCH changes nothing) → reported, not claimed as saved', async () => {
  const row = manual();
  const env = makeEnv({ rows: [row], tmdb: searchStub });
  await openAndSearch(env);
  await env.ctx.chooseTmdbMatchResult(env.ctx.__tmdbMatch.results.findIndex(r => r.id === 438631));
  // simulate: the row now has another identity in the database, so the guarded PATCH matched 0 rows
  env.ctx.sbFetch = async (m, p) => m === 'GET' && /id=eq\.row-1&select/.test(p) ? [{ ...row, media_type: 'movie', tmdb_id: 841 }] : (m === 'GET' ? [] : null);
  await env.ctx.confirmTmdbMatch();
  assert.strictEqual(env.log.saved, 0);
  assert.ok(env.banner().includes('changed somewhere else'), env.banner());
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
