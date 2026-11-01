// Offline tests for item 10 (db/cu1e_missing_season.sql; collection-updates.js cuRecordOutcome) in the whole-page harness
// (tests/cu1-harness.js stands in for the database): a TMDB-listed season that's missing comes back on every Refresh
// shows, unless a hold or the owner's decision keeps it out, and Refresh says which. The database's own rules, retries and
// concurrency are in tools/db-rehearsal-cu1.mjs and tools/db-rehearsal-cu1e-pg.mjs.
// Run from the repo root: node tests/missing-season.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('missing-season');
const test = T.test;
const TS = '2026-10-01T00:00:00+00:00';
let n = 0;
const uuid = p => `${p}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const text = html => String(html).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/’/g, "'").replace(/\s+/g, ' ').trim();
const showOf = (o = {}) => ({ id: uuid('5a000000'), collection: 'othertv', title: 'Listed', show_key: 'listed', tmdb_id: 81, status: 'confirmed', created_at: TS, ...o });
const seasonOf = (sh, num) => ({ id: uuid('5b000000'), collection: sh.collection, title: sh.title, theme: 'Net', status: 'confirmed', watched: false, skipped: false,
  show_id: sh.id, media_type: 'tv', tmdb_id: sh.tmdb_id, season_number: num, season: `Season ${num}`, display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `${sh.show_key}|season ${num}`, watch_with: [], collections: [], created_at: TS, tmdb_collection_id: null, tmdb_collection_name: null });
const tmdb = p => (p === '/tv/81' ? { id: 81, status: 'Ended', networks: [{ id: 1, name: 'Net' }], created_by: [], seasons: [1, 2, 3].map(s => ({ season_number: s, air_date: '2020-01-01', episode_count: 2 })) } : /season/.test(p) ? { episodes: [] } : undefined);

async function library() {
  const show = showOf();
  const app = await createApp({ rows: [1, 2, 3].map(s => seasonOf(show, s)), tvShows: [show], tmdb });
  await app.run(`runWrite('n', () => sbRpc('library_cu_sync_show_network', { p_show_id: ${JSON.stringify(show.id)}, p_networks: ['Net'], p_expected: { tmdb_id: 81, network: null, network_candidates: [], metadata_owner_set: false } }))`);
  return { app, show };
}
const has = (app, show, s) => app.store.watchlist_items.filter(r => r.show_id === show.id && r.season_number === s).length;
const remove = (app, show, s) => { const i = app.store.watchlist_items.findIndex(r => r.show_id === show.id && r.season_number === s); app.store.watchlist_items.splice(i, 1); };
async function refresh(app) {
  app.ctx.switchView('alltv'); await settle();
  app.ctx.openLibraryPanel('tv', 'refresh'); await settle();
  await app.ctx.cuRefreshShows(); await settle();
  return text(app.el('tmdbPreview').innerHTML);
}
const season3 = app => app.store.update_findings.find(f => f.kind === 'new_season' && f.subject.season_number === 3);

test('a season deleted again and again comes back every time, one row each time', async () => {
  const { app, show } = await library();
  for (let i = 0; i < 3; i++) {
    remove(app, show, 3);
    assert.match(await refresh(app), /Listed · Season 3: added/, `cycle ${i + 1}`);
    assert.strictEqual(has(app, show, 3), 1);
  }
  const writes = app.writes().filter(r => r.url.endsWith('/rpc/library_cu_reconcile_season')).length;
  await refresh(app);
  assert.strictEqual(app.writes().filter(r => r.url.endsWith('/rpc/library_cu_reconcile_season')).length, writes, 'a season that exists isn’t sent');
});

test('a hold keeps it out and says so; removing the hold lets the next Refresh restore it', async () => {
  const { app, show } = await library();
  remove(app, show, 3); await refresh(app); remove(app, show, 3);
  await app.run(`runWrite('h', () => sbRpc('library_cu_save_hold', { p_hold: { kind: 'standing_decision', show_id: ${JSON.stringify(show.id)}, subject_label: 'Season 3', decision: 'zz', effect: 'do_not_add', reopen: { on: 'owner_only' } } }))`);
  assert.match(await refresh(app), /Season 3: a standing decision covers it/);
  assert.strictEqual(has(app, show, 3), 0);
  await app.run(`runWrite('d', () => sbRpc('library_cu_delete_hold', { p_id: ${JSON.stringify(app.store.update_holds[0].id)}, p_expected_decision: 'zz' }))`);
  assert.match(await refresh(app), /Season 3: added/);
  assert.strictEqual(has(app, show, 3), 1);
});

for (const [status, re] of [['dismissed', /Left out by your decision \(1\) Listed · Season 3: you dismissed it; add the season by hand if you want it Couldn't check or apply \(0\)/],
  ['not_now', /Left out by your decision \(1\) Listed · Season 3: you set it to Not now; add the season by hand if you want it Couldn't check or apply \(0\)/]]) {
  test(`${status}: the season stays out, Refresh says so, and nothing is added or changed`, async () => {
    const { app, show } = await library();
    remove(app, show, 3); await refresh(app); remove(app, show, 3);
    Object.assign(season3(app), { status, decided_at: TS });
    const t = await refresh(app);
    assert.match(t, re);
    assert.doesNotMatch(t, /already on your list/);
    assert.strictEqual(has(app, show, 3), 0);
    assert.strictEqual(season3(app).status, status);
  });
}

test('“already on your list” appears only for the database’s answer about a season it found', async () => {
  const { app } = await library();
  const r = () => app.ctx.cuEmptyResults('tmdb');
  const op = { type: 'season', what: 'Listed · Season 3', args: { p_finding: { source: 'tmdb' } } };
  const a = r(); app.ctx.cuRecordOutcome(op, { outcome: 'not_pending', status: 'applied', reason: '' }, a);
  assert.deepStrictEqual(Array.from(a.applied), ['Listed · Season 3: already on your list']);
  const a2 = r(); app.ctx.cuRecordOutcome(op, { outcome: 'already', status: 'applied', reason: 'existing' }, a2);
  assert.deepStrictEqual(Array.from(a2.applied), ['Listed · Season 3: already on your list'], 'the database’s own “it exists” answer');
  const b = r(); app.ctx.cuRecordOutcome({ ...op, args: { p_finding: { id: 'x' } } }, { outcome: 'not_pending', status: 'applied', reason: '' }, b);
  assert.strictEqual(b.applied.length, 0, 'a research finding’s answer says nothing about the season');
  const c = r(); app.ctx.cuRecordOutcome({ type: 'date', what: 'Listed · Season 3', args: { p_finding: { source: 'tmdb' } } }, { outcome: 'not_pending', status: 'applied', reason: '' }, c);
  assert.strictEqual(c.applied.length, 0, 'nor does a date’s');
  const d = r(); app.ctx.cuRecordOutcome(op, { outcome: 'not_pending', status: 'set_aside', reason: 'skipped' }, d);
  assert.match(d.setAside[0], /not added — the show is Skipped/);
  assert.strictEqual(d.decisions.length, 0, 'a Skipped show is no decision on the finding');
  const e = r(); app.ctx.cuRecordOutcome(op, { outcome: 'not_pending', status: 'dismissed', reason: '' }, e);
  assert.strictEqual(e.setAside.length + e.failed.length, 0, 'a decision isn’t filed as a failure');
  assert.strictEqual(e.decisions.length, 1);
});

test('an existing Skipped season isn’t sent, and stays Skipped', async () => {
  const { app, show } = await library();
  app.store.watchlist_items.find(r => r.show_id === show.id && r.season_number === 3).skipped = true;
  await refresh(app);
  assert.strictEqual(app.writes().filter(r => r.url.endsWith('/rpc/library_cu_reconcile_season')).length, 0);
  assert.strictEqual(has(app, show, 3), 1);
});

T.run();
