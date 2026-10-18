// Offline tests for the Match collection-expansion confirmation (Stage 3b-2,
// tmdb-match.js): the database's existing token protocol (preview {}, confirm
// {"confirm": token}, changed proposals, vanished expansions) through the panel;
// archive markers only from a fresh read; the proposal bound to the row, TMDB id
// and season; a delayed reply after Cancel. (Since Batch A a confirmed Match is shown by
// reading the open view again inside the write lane: tests/write-lane.test.js.)
// Run from the repo root: node tests/match-expansion.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('match-expansion');
const test = T.test;
const TS = '2026-10-01T00:00:00+00:00';
const uuid = (p, n) => `${p}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A show "Target Show" (TMDB 4000) in True Crime / Docs with a stored Season 2, and an
// unidentified film row of the same title there that is also in Disney+ — matching
// it as Season 1 would show the show's seasons in Disney+ (an expansion).
function fixture() {
  const showId = uuid('5a', 1);
  const tvShow = { id: showId, collection: 'truecrime', title: 'Target Show', show_key: 'target show', tmdb_id: 4000, status: 'confirmed', created_at: TS };
  const s2 = { id: uuid('5b', 2), collection: 'truecrime', item_key: 'target show|season 2', title: 'Target Show', season: 'Season 2', theme: 'Net',
    display_date: 'Jan 1, 2021', date_sort: '2021-01-01', watched: false, status: 'confirmed', created_at: TS, watch_with: [], collections: [],
    tmdb_collection_id: null, tmdb_collection_name: null, media_type: 'tv', tmdb_id: 4000, season_number: 2, show_id: showId, skipped: false };
  const legacy = { id: uuid('f0', 3), collection: 'truecrime', item_key: 'target show|film', title: 'Target Show', season: 'Film', theme: 'Net',
    display_date: 'Jan 1, 2020', date_sort: '2020-01-01', watched: true, status: 'confirmed', created_at: TS, watch_with: [], collections: [],
    tmdb_collection_id: null, tmdb_collection_name: null, media_type: null, tmdb_id: null, season_number: null, show_id: null, skipped: false };
  return { tvShow, s2, legacy };
}
async function boot() {
  const f = fixture();
  const app = await createApp({ rows: [f.s2, f.legacy], tvShows: [f.tvShow] });
  const disney = app.store.personal_collections.find(c => c.legacy_source === 'disney');
  app.store.collection_memberships.push({ id: uuid('0d', 900), collection_id: disney.id, show_id: null, item_id: f.legacy.id, created_at: TS });
  app.ctx.switchMediaType('movie'); await settle(); // the unidentified film is listed in All Movies (Stage 5: no storage tabs)
  app.el('fWatch').value = ''; app.ctx.renderTable(); // every watched state, so a watched edit keeps it listed
  app.addEl('tmdbMatchBody');
  return { app, f, disney };
}
const select = (app, rowId, season = 1, tmdb = 4000) => {
  app.ctx.__tmdbMatch = { rowId, results: [], target: { mediaType: 'tv', seasonNumber: season,
    details: { id: tmdb, name: 'Target Show', networks: [{ name: 'Net' }], seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 3, air_date: '2022-01-01' }] } } };
};
const rpcCalls = app => app.requests.filter(r => r.url.includes('/rpc/library_match_season_b45'));
const panel = app => app.el('tmdbMatchBody').innerHTML;
// The page's row: the open view's copy (Stage 5: views hold rows; there is no tab cache).
const pageRow = (app, id) => app.get(`(browseData && browseData.rows || []).find(r => r.id === ${JSON.stringify(id)})`);
const membersOfShow = (app, id) => app.store.collection_memberships.filter(m => m.show_id === id).map(m => m.collection_id).sort();

test('preview: the panel names the collections from the reply and the seasons; nothing is written; a fresh collections read comes first', async () => {
  const { app, f } = await boot();
  select(app, f.legacy.id);
  const before = app.requests.length;
  await app.ctx.confirmTmdbMatch(); await settle();
  const after = app.requests.slice(before);
  assert.deepStrictEqual(after.filter(r => r.method !== 'GET').map(r => new URL(r.url).pathname.split('/').pop()), ['library_match_season_b45']);
  assert.deepStrictEqual(rpcCalls(app)[0].body.p_expansion, {});
  assert.ok(after.some(r => r.method === 'GET' && r.url.includes('/personal_collections')), 'a fresh read of the collections');
  assert.match(panel(app), /Matching also adds a show to collections/);
  assert.match(panel(app), /all 1 stored season<\/strong> of “Target Show” \(and any added later\) in: <strong>Disney\+<\/strong>/);
  assert.match(panel(app), /as Season 1 also shows/);
  assert.ok(!/archived/.test(panel(app).split('in:')[1].split('</p>')[0]), 'Disney+ is not marked archived');
  assert.ok(app.store.watchlist_items.find(r => r.id === f.legacy.id).tmdb_id == null, 'nothing matched');
});

test('archive markers come only from the fresh read, never from the page’s older list', async () => {
  const { app, f, disney } = await boot();
  // The page's list says Disney+ is active; the database now has it archived.
  disney.archived_at = TS;
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.match(panel(app), /<strong>Disney\+<\/strong> \(archived: not shown in Collections\)/);
});

test('if the fresh read fails, the panel says it couldn’t check archive state and shows no markers (even if the older list had one)', async () => {
  const { app, f } = await boot();
  app.get('personalCollections').find(c => c.catalog_id === 'disney').archived_at = TS; // stale cached marker
  app.failNext(r => r.method === 'GET' && r.url.includes('/personal_collections'));
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.match(panel(app), /Couldn’t check which of these collections are archived/);
  assert.ok(!/\(archived/.test(panel(app)), 'no marker from the cached list');
  assert.match(panel(app), /Match and add to these collections<\/button>/, 'confirming is still possible');
});

test('confirm sends the reply’s token and applies: the show joins Disney+, the row is matched', async () => {
  const { app, f, disney } = await boot();
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  const token = app.ctx.__tmdbMatch.proposal.token;
  await app.ctx.confirmTmdbMatch(true); await settle();
  assert.deepStrictEqual(rpcCalls(app)[1].body.p_expansion, { confirm: token });
  const row = app.store.watchlist_items.find(r => r.id === f.legacy.id);
  assert.strictEqual(row.show_id, f.tvShow.id);
  assert.ok(membersOfShow(app, f.tvShow.id).includes(disney.id));
});

test('a changed proposal (a season added meanwhile) writes nothing and is shown again; it is never confirmed automatically', async () => {
  const { app, f } = await boot();
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  app.store.watchlist_items.push({ ...f.s2, id: uuid('5b', 7), item_key: 'target show|season 3', season: 'Season 3', season_number: 3 });
  await app.ctx.confirmTmdbMatch(true); await settle();
  assert.strictEqual(rpcCalls(app).length, 2, 'one confirm call, no automatic retry');
  assert.match(panel(app), /This changed since you looked\. Check and confirm again\./);
  assert.match(panel(app), /all 2 stored seasons/);
  assert.ok(app.store.watchlist_items.find(r => r.id === f.legacy.id).tmdb_id == null, 'nothing written');
  await app.ctx.confirmTmdbMatch(true); await settle();
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === f.legacy.id).show_id, f.tvShow.id, 'a fresh confirmation applies');
});

test('a vanished expansion (the show joined Disney+ meanwhile) applies on confirm without another prompt', async () => {
  const { app, f, disney } = await boot();
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  app.store.collection_memberships.push({ id: uuid('0d', 901), collection_id: disney.id, show_id: f.tvShow.id, item_id: null, created_at: TS });
  await app.ctx.confirmTmdbMatch(true); await settle();
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === f.legacy.id).show_id, f.tvShow.id);
});

test('the proposal is bound to the row, TMDB id and season: changing the season, Back or Cancel discards it; a confirm without one sends nothing', async () => {
  const { app, f } = await boot();
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.ok(app.ctx.__tmdbMatch.proposal);
  app.ctx.chooseTmdbMatchSeason(3);
  assert.strictEqual(app.ctx.__tmdbMatch.proposal, null, 'season change discards');
  const n = rpcCalls(app).length;
  await app.ctx.confirmTmdbMatch(true); await settle();
  assert.strictEqual(rpcCalls(app).length, n, 'nothing sent without a current proposal');
  app.ctx.chooseTmdbMatchSeason(1);
  await app.ctx.confirmTmdbMatch(); await settle();
  app.ctx.renderTmdbMatchConfirm(); // Back
  assert.strictEqual(app.ctx.__tmdbMatch.proposal, null, 'Back discards');
  // A proposal for another season can't be confirmed for this one.
  await app.ctx.confirmTmdbMatch(); await settle();
  app.ctx.__tmdbMatch.target.seasonNumber = 3;
  const k = rpcCalls(app).length;
  await app.ctx.confirmTmdbMatch(true); await settle();
  assert.strictEqual(rpcCalls(app).length, k, 'mismatched season: nothing sent');
});

test('while a match call is in flight, Confirm, the seasons and Back wait; Cancel closes and the outcome is still reported', async () => {
  const { app, f } = await boot();
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  const g = app.hold(r => r.url.includes('/rpc/library_match_season_b45'));
  const p = app.ctx.confirmTmdbMatch(true);
  await g.reached;
  assert.match(panel(app), /disabled>Matching…<\/button>/);
  const before = app.ctx.__tmdbMatch.target.seasonNumber;
  app.ctx.chooseTmdbMatchSeason(3);
  assert.strictEqual(app.ctx.__tmdbMatch.target.seasonNumber, before, 'season choice waits');
  const n = rpcCalls(app).length;
  await app.ctx.confirmTmdbMatch(true);
  assert.strictEqual(rpcCalls(app).length, n, 'no second call');
  app.ctx.cancelTmdbMatch();
  g.release(); await p; await settle();
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === f.legacy.id).show_id, f.tvShow.id, 'the confirmed match ran');
  assert.ok(pageRow(app, f.legacy.id).tmdb_id === 4000, 'applied (the page’s row was still current)');
});

test('a delayed blocked answer after Cancel is dropped (it wrote nothing)', async () => {
  const { app, f } = await boot();
  select(app, f.legacy.id);
  const g = app.hold(r => r.url.includes('/rpc/library_match_season_b45'));
  const p = app.ctx.confirmTmdbMatch();
  await g.reached;
  app.ctx.cancelTmdbMatch();
  app.el('tmdbMatchBody').innerHTML = 'closed';
  g.release(); await p; await settle();
  assert.strictEqual(panel(app), 'closed', 'no panel drawn');
  assert.strictEqual(app.ctx.__tmdbMatch, null);
});

test('the status-conflict answer keeps its message; an old-shape call is never sent with personal collections', async () => {
  const { app, f } = await boot();
  const legacyShow = { id: uuid('5a', 20), collection: 'truecrime', title: 'Target Show', show_key: 'target show x', tmdb_id: null, status: 'watching', created_at: TS };
  app.store.tv_shows.push(legacyShow);
  const row = app.store.watchlist_items.find(r => r.id === f.legacy.id);
  Object.assign(row, { season: 'Season 1', item_key: 'target show x|season 1', show_id: legacyShow.id });
  pageRow(app, f.legacy.id).show_id = legacyShow.id;
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.match(app.el('errorBanner').innerHTML, /Give both the same status first/);
  assert.ok(rpcCalls(app).every(c => c.body.p_expansion !== undefined));
});

T.run();
