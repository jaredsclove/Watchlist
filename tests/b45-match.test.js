// Offline tests for Match under B4/B5 (plan §8.2), in the whole-page harness: the page calls
// only library_match_season_b45 / library_match_film_b45; whenever the database answers
// blocked: 'state_acknowledgment' the panel lists exactly what would be dropped or overridden
// (the earlier-seasons range included, RL6) and sends the token only when the owner confirms;
// a changed list is shown again and never sent automatically; a season that would become a
// Skipped + Watched film asks for the owner's Watched / Skipped choice before anything is sent
// (M6b, an explicit status choice); Cancel and Back send nothing. The database rules (every
// matrix cell, the FK invariant): db/test/t_b45.sql (W7, RL6, RL7).
// Run from the repo root: node tests/b45-match.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('b45-match');
const test = T.test;

let n = 0;
const uid = p => `${p}${String(++n).padStart(4, '0')}`;
const legacyShow = (o = {}) => ({ id: uid('L'), collection: 'othertv', title: o.title || 'Local', show_key: (o.title || 'local').toLowerCase(), tmdb_id: null, status: 'confirmed', ...o });
const season = (sh, num, o = {}) => ({ id: o.id || uid('r'), collection: sh.collection, title: sh.title, theme: 'Net', status: 'confirmed', watched: false, skipped: false,
  show_id: sh.id, media_type: null, tmdb_id: null, season_number: null, season: `Season ${num}`, display_date: 'Jan 1, 2020', date_sort: `20${10 + num}-01-01`,
  item_key: `${sh.show_key}|season ${num}`, watch_with: [], collections: [], ...o });
const tmdbShow = (o = {}) => ({ id: uid('T'), collection: 'othertv', title: o.title || 'Target', show_key: (o.title || 'target').toLowerCase(), tmdb_id: o.tmdb_id || 4000, status: 'confirmed', ...o });
const film = (o = {}) => ({ id: uid('f'), collection: 'truecrime', title: o.title || 'Hand Film', theme: 'Net', status: 'confirmed', watched: false, skipped: false, show_id: null,
  media_type: null, tmdb_id: null, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01', item_key: `${(o.title || 'hand film').toLowerCase()}|film`,
  watch_with: [], collections: [], ...o });

async function boot(rows, shows, view = 'alltv') {
  const app = await createApp({ rows, tvShows: shows });
  if (view === 'allmovies') { app.ctx.switchMediaType('movie'); await settle(); app.el('fWatch').value = ''; app.ctx.renderTable(); }
  else { app.ctx.switchView(view); await settle(); app.el('fStatus').value = 'all'; app.ctx.renderTable(); }
  app.addEl('tmdbMatchBody');
  return app;
}
const pickTv = (app, rowId, tmdbId, name, seasonNumber = 1) => {
  app.ctx.__tmdbMatch = { rowId, results: [], target: { mediaType: 'tv', seasonNumber, details: { id: tmdbId, name, networks: [{ name: 'Net' }], seasons: [{ season_number: seasonNumber, air_date: '2020-01-01' }] } } };
};
const pickFilm = (app, rowId, tmdbId, title) => {
  app.ctx.__tmdbMatch = { rowId, results: [], target: { mediaType: 'movie', details: { id: tmdbId, title, release_date: '2020-01-01', genres: [{ name: 'Drama' }], belongs_to_collection: null } } };
};
const panel = app => app.el('tmdbMatchBody').innerHTML.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const calls = (app, fn) => app.writes().filter(r => r.url.endsWith(`/rpc/${fn}`)).map(r => JSON.parse(JSON.stringify(r.body)));
const snap = app => JSON.stringify([app.store.watchlist_items, app.store.tv_shows, app.store.collection_memberships]);

test('M2 (a season leaves a show that keeps others, to a new show): the range naming it is listed — “The earlier-seasons choice for “Local” ends because Season 1 moves to a new show.” — nothing written until confirmed; then cleared on the source, none on the new show', async () => {
  const L = legacyShow({ status: 'watching', priority: 'high' });
  const a = season(L, 1), b = season(L, 2, { watched: true });
  Object.assign(L, { resume_start_season_id: a.id, resume_end_season_id: b.id });
  const app = await boot([a, b], [L]);
  const before = snap(app);
  pickTv(app, a.id, 6000, 'New Show');
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.strictEqual(snap(app), before, 'blocked: nothing written');
  assert.match(panel(app), /The earlier-seasons choice for “Local” ends because Season 1 moves to a new show\./);
  assert.ok(app.el('tmdbMatchBody').innerHTML.includes('confirmTmdbMatchAck()'));
  const [first] = calls(app, 'library_match_season_b45');
  assert.strictEqual(first.p_ack, null);
  app.ctx.confirmTmdbMatchAck(); await settle();
  const second = calls(app, 'library_match_season_b45')[1];
  assert.match(second.p_ack, /^[0-9a-f]{32}$/, 'the token from the answer');
  const src = app.store.tv_shows.find(s => s.id === L.id);
  assert.deepStrictEqual([src.resume_start_season_id, src.resume_end_season_id], [null, null]);
  const created = app.store.tv_shows.find(s => s.tmdb_id === 6000);
  assert.deepStrictEqual([created.status, created.priority, created.resume_start_season_id], ['watching', 'high', null], 'state carried; no range on the new show');
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === a.id).show_id, created.id);
});

test('M3 (join an existing show): the source’s differing values and its removal are listed; Cancel and Back send nothing more; a list that changed is shown again, never sent automatically', async () => {
  const L = legacyShow({ priority: 'low', ended: true, catalog_new: true, legacy_status: 'pending' });
  const a = season(L, 1);
  const T = tmdbShow({ title: 'Target', tmdb_id: 4000 });
  const t2 = season(T, 2, { media_type: 'tv', tmdb_id: 4000, season_number: 2, item_key: 'target|season 2' });
  const app = await boot([a, t2], [L, T]);
  pickTv(app, a.id, 4000, 'Target');
  await app.ctx.confirmTmdbMatch(); await settle();
  const p = panel(app);
  assert.match(p, /Priority: this row’s Low isn’t kept; the show keeps its Normal\./);
  assert.match(p, /Show ended: this row’s yes isn’t kept; the show keeps its no\./);
  assert.match(p, /New from catalog: this row’s yes isn’t kept/);
  assert.match(p, /“Local” would have no seasons left, so it is removed with its status, priority, Show ended, categories and markers\./);
  app.ctx.cancelTmdbMatch(); await settle();
  assert.strictEqual(calls(app, 'library_match_season_b45').length, 1, 'Cancel: nothing more sent');
  pickTv(app, a.id, 4000, 'Target');
  await app.ctx.confirmTmdbMatch(); await settle();
  app.store.tv_shows.find(s => s.id === L.id).priority = 'high'; // changed elsewhere before the confirmation
  app.ctx.confirmTmdbMatchAck(); await settle();
  assert.match(panel(app), /What this match would change has changed\. Before matching, check what changes:/);
  assert.match(panel(app), /this row’s ★ High isn’t kept|this row’s High isn’t kept/);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === a.id).tmdb_id, null, 'not matched with the stale token');
  await settle(50);
  assert.strictEqual(calls(app, 'library_match_season_b45').length, 3, 'never resent automatically');
  app.ctx.confirmTmdbMatchAck(); await settle();
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === a.id).show_id, T.id, 'joined after the owner confirmed the current list');
  assert.ok(!app.store.tv_shows.some(s => s.id === L.id), 'the emptied source was removed');
  const t = app.store.tv_shows.find(s => s.id === T.id);
  assert.deepStrictEqual([t.priority, t.ended, t.catalog_new], ['normal', false, false], 'the destination keeps its values');
});

test('M1 (the only season, promoted in place) and M4 (a film becomes a new show) need no acknowledgment: one call; the state is kept or carried', async () => {
  const L = legacyShow({ status: 'watching', ended: true });
  const a = season(L, 1, { watched: true });
  Object.assign(L, {});
  const f = film({ priority: 'high', catalog_new: true, legacy_status: 'pending', genres: ['Drama'] });
  const app = await boot([a, f], [L]);
  pickTv(app, a.id, 7000, 'Promoted');
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.strictEqual(calls(app, 'library_match_season_b45').length, 1);
  const s = app.store.tv_shows.find(x => x.id === L.id);
  assert.deepStrictEqual([s.tmdb_id, s.status, s.ended], [7000, 'watching', true], 'M1: the show keeps every value');
  app.ctx.switchMediaType('movie'); await settle(); app.el('fWatch').value = ''; app.ctx.renderTable(); app.addEl('tmdbMatchBody');
  pickTv(app, f.id, 7100, 'From Film');
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.strictEqual(calls(app, 'library_match_season_b45').length, 2, 'M4: one call, no acknowledgment');
  const created = app.store.tv_shows.find(x => x.tmdb_id === 7100);
  assert.deepStrictEqual([created.status, created.priority, created.catalog_new, created.legacy_status, created.genres], ['confirmed', 'high', true, 'pending', ['Drama']]);
  const row = app.store.watchlist_items.find(r => r.id === f.id);
  assert.deepStrictEqual([row.priority, row.catalog_new, row.genres], [null, null, null], 'the row’s film-only values become NULL');
});

test('M4 with a film whose old status was Watching: “The old status kept for a rollback (Watching) isn’t kept.” — acknowledged before matching', async () => {
  const f = film({ status_review: true, legacy_status: 'watching' });
  const app = await boot([f], [], 'allmovies');
  pickTv(app, f.id, 7200, 'Was Watching');
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.match(panel(app), /The old status kept for a rollback \(Watching\) isn’t kept\./);
  app.ctx.confirmTmdbMatchAck(); await settle();
  const s = app.store.tv_shows.find(x => x.tmdb_id === 7200);
  assert.deepStrictEqual([s.status_review, s.legacy_status], [true, null], 'review still carried; the provenance not');
});

test('M6a (a season becomes a film): Show ended and the network candidates are listed as dropped, and the emptied show’s removal; confirmed → the film takes the show’s state', async () => {
  const L = legacyShow({ status: 'watching', ended: true, network_candidates: ['Net'], priority: 'low' });
  const a = season(L, 1);
  const app = await boot([a], [L]);
  pickFilm(app, a.id, 800, 'Was A Season');
  await app.ctx.confirmTmdbMatch(); await settle();
  const p = panel(app);
  assert.match(p, /Show ended \(yes\): a film has none, so it isn’t kept\./);
  assert.match(p, /Network candidates \(Net\): a film has none, so it isn’t kept\./);
  assert.match(p, /“Local” would have no seasons left, so it is removed/);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === a.id).tmdb_id, null);
  app.ctx.confirmTmdbMatchAck(); await settle();
  const r = app.store.watchlist_items.find(x => x.id === a.id);
  assert.deepStrictEqual([r.media_type, r.tmdb_id, r.status, r.watched, r.priority], ['movie', 800, 'confirmed', false, 'low']);
  assert.ok(!app.store.tv_shows.some(s => s.id === L.id));
});

test('M6b (a watched season of a Skipped show): the owner chooses Watched or Skipped before anything is sent; the choice is an explicit status choice (New, review, provenance cleared)', async () => {
  const L = legacyShow({ status: 'skipped', catalog_new: true, legacy_status: 'pending' });
  const a = season(L, 1, { watched: true }), b = season(L, 2);
  const app = await boot([a, b], [L]);
  pickFilm(app, a.id, 801, 'Pair Film');
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.deepStrictEqual(calls(app, 'library_match_film_b45'), [], 'nothing sent before the choice');
  assert.match(panel(app), /is marked watched, but it is skipped \(its show is Skipped\)\. As a film it can’t be both\. Choose its status:/);
  app.ctx.renderTmdbMatchConfirm(); await settle(); // Back
  assert.deepStrictEqual(calls(app, 'library_match_film_b45'), [], 'Back: nothing sent');
  await app.ctx.confirmTmdbMatch(); await settle();
  await app.ctx.chooseTmdbMatchState('skipped'); await settle();
  const [c] = calls(app, 'library_match_film_b45');
  assert.strictEqual(c.p_choice, 'skipped');
  const r = app.store.watchlist_items.find(x => x.id === a.id);
  assert.deepStrictEqual([r.status, r.watched, r.catalog_new, r.status_review, r.legacy_status], ['skipped', false, false, false, null]);
  assert.ok(app.store.tv_shows.some(s => s.id === L.id), 'the show keeps its other season');
});

test('M6b when the database alone knows the pair (the page’s copy is stale): it answers state_choice and the panel asks; nothing was written', async () => {
  const L = legacyShow({ status: 'confirmed' });
  const a = season(L, 1, { watched: true }), b = season(L, 2);
  const app = await boot([a, b], [L]);
  app.store.tv_shows.find(s => s.id === L.id).status = 'skipped'; // skipped elsewhere after the page read it
  const before = snap(app);
  pickFilm(app, a.id, 802, 'Pair Film');
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.strictEqual(calls(app, 'library_match_film_b45').length, 1);
  assert.strictEqual(snap(app), before);
  assert.match(panel(app), /Choose its status:/);
  await app.ctx.chooseTmdbMatchState('watched'); await settle();
  const r = app.store.watchlist_items.find(x => x.id === a.id);
  assert.deepStrictEqual([r.status, r.watched], ['confirmed', true]);
});

test('M7 (film → film) keeps every value; no acknowledgment', async () => {
  const f = film({ title: 'Keep Me', priority: 'high', catalog_new: true, legacy_status: 'pending', status: 'skipped', watched: true, genres: ['Drama'] });
  const app = await boot([f], [], 'allmovies');
  pickFilm(app, f.id, 803, 'Keep Me');
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.strictEqual(calls(app, 'library_match_film_b45').length, 1);
  const r = app.store.watchlist_items.find(x => x.id === f.id);
  assert.deepStrictEqual([r.tmdb_id, r.status, r.watched, r.priority, r.catalog_new, r.legacy_status, r.genres], [803, 'skipped', true, 'high', true, 'pending', ['Drama']], 'a preserved pair stays');
});

test('the acknowledgment is bound to the row, TMDB id and season: Confirm after choosing another season sends nothing old; a lost answer to the confirmation is “can’t tell”, never resent', async () => {
  const L = legacyShow({ priority: 'low' });
  const a = season(L, 1);
  const T = tmdbShow({ tmdb_id: 4100, title: 'Other' });
  const t2 = season(T, 2, { media_type: 'tv', tmdb_id: 4100, season_number: 2, item_key: 'other|season 2' });
  const app = await boot([a, t2], [L, T]);
  pickTv(app, a.id, 4100, 'Other');
  await app.ctx.confirmTmdbMatch(); await settle();
  app.ctx.__tmdbMatch.target.seasonNumber = 3; // the owner picks another season
  app.ctx.confirmTmdbMatchAck(); await settle();
  assert.strictEqual(calls(app, 'library_match_season_b45').length, 1, 'the acknowledgment shown for Season 1 isn’t sent for Season 3');
  app.ctx.__tmdbMatch.target.seasonNumber = 1;
  // The confirmation is sent, and no answer comes back (a network failure).
  const realFetch = app.ctx.fetch;
  app.ctx.fetch = async (url, opts) => {
    if (!String(url).endsWith('/rpc/library_match_season_b45')) return realFetch(url, opts);
    app.ctx.fetch = realFetch;
    app.requests.push({ method: 'POST', url, body: JSON.parse(opts.body), headers: {} });
    throw new TypeError('Failed to fetch');
  };
  await app.ctx.confirmTmdbMatch(false, { ack: true }); await settle(); await settle(50);
  assert.match(app.el('errorBanner').innerHTML, /wasn’t confirmed \(Failed to fetch\): it may or may not have been saved, and it won’t be sent again\. The list has been read again/);
  assert.strictEqual(calls(app, 'library_match_season_b45').length, 2, 'never resent');
});

test('the page calls only the _b45 Match functions (never library_match_season / library_match_film)', async () => {
  const L = legacyShow();
  const a = season(L, 1);
  const app = await boot([a], [L]);
  pickTv(app, a.id, 7300, 'Only B45');
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.ok(!app.writes().some(r => /\/rpc\/library_match_(season|film)$/.test(r.url)));
  assert.strictEqual(calls(app, 'library_match_season_b45').length, 1);
});

T.run();
