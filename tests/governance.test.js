// Offline tests for publishing catalog governance (library.js readGovernance /
// publishGovernance / governanceKnows), in the whole-page harness. The editing policy
// (Skip a catalog entry, Delete anything else; Match only an ungoverned row) comes from
// the newest governance read of the current restore epoch. An older read that finishes
// late — after another library read, a view read, a navigation, a closed panel or a
// restore — never replaces it, and a record no published read speaks for is neither
// deleted nor matched. Every test asserts the mutation actually sent.
// Run from the repo root: node tests/governance.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('governance');
const test = T.test;

const TS = '2026-10-01T00:00:00+00:00';
const SID = '5a000000-0000-4000-8000-000000000001', RID = '5b000000-0000-4000-8000-000000000001';
const andor = { id: SID, collection: 'disney', title: 'Andor', show_key: 'andor', tmdb_id: null, status: 'confirmed', created_at: TS };
const season = { id: RID, collection: 'disney', title: 'Andor', item_key: 'andor|season 1', season: 'Season 1', theme: 'Star Wars', date_sort: '2020-01-01',
  display_date: 'Jan 1, 2020', status: 'confirmed', watched: false, skipped: false, show_id: SID, tmdb_id: null, media_type: null, season_number: null,
  watch_with: [], collections: [], created_at: TS };
const LINKS = r => r.method === 'GET' && r.url.includes('/library_catalog_shows?');
async function boot(phase = 'contracted') {
  const app = await createApp({ tvShows: [andor], rows: [season], stage5: phase });
  app.ctx.switchView('alltv'); await settle();
  return app;
}
const policy = app => app.get(`JSON.stringify(editPolicyOf(derivedData.rows.find(r => r.id === ${JSON.stringify(RID)})))`);
const sent = app => app.writes().map(r => r.url.split('/rpc/')[1] || r.url.split('/rest/v1/')[1]);
// × on the season, as the page does it; then what was sent and what is stored.
async function cross(app) {
  app.ctx.confirm = () => true;
  await app.ctx.delRowInView(RID); await settle();
  return { sent: sent(app), stored: app.store.watchlist_items.find(r => r.id === RID) };
}
const isSkip = out => out.sent.length === 1 && out.sent[0] === 'set_season_skipped' && out.stored && out.stored.skipped === true;

for (const phase of ['coexistence', 'contracted']) {
  test(`(${phase}) an older library read that finishes after a newer view read never replaces its governance: × still skips, never deletes`, async () => {
    const app = await boot(phase);
    assert.match(policy(app), /"deleteEffect":"skip"/);
    const g = app.hold(LINKS);
    const old = app.ctx.readLibrary();
    await g.reached;
    app.ctx.switchView('alltv'); await settle();             // a newer view read publishes current governance
    g.releaseWith({ tv_shows: [] });                         // the old read answers without Andor's governance
    await old; await settle();
    assert.match(policy(app), /"deleteEffect":"skip"/);
    assert.ok(isSkip(await cross(app)), JSON.stringify(sent(app)));
  });
}

test('two overlapping library reads finishing out of order: the newer one’s governance stays', async () => {
  const app = await boot();
  const g1 = app.hold(LINKS);
  const first = app.ctx.readLibrary();
  await g1.reached;
  const second = app.ctx.readLibrary();
  await second; await settle();                              // the newer read publishes first
  g1.releaseWith({ tv_shows: [] });
  await first; await settle();
  assert.match(policy(app), /"deleteEffect":"skip"/);
  assert.strictEqual(app.get(`isTmdbMatchEligible(derivedData.rows.find(r => r.id === ${JSON.stringify(RID)}))`), false);
  assert.ok(isSkip(await cross(app)));
});

test('navigation and a closed panel: a library read the panel started, finishing after a later view read, publishes nothing', async () => {
  const app = await boot();
  app.ctx.openLibraryPanel('tv'); // its library read
  const g = app.hold(LINKS);
  app.ctx.openLibraryPanel('tv', 'manual'); // a newer panel read, held
  await g.reached;
  app.ctx.closeLibraryPanel();
  app.ctx.switchView('comingsoon'); await settle();
  app.ctx.switchView('alltv'); await settle();               // newer view reads
  g.releaseWith({ tv_shows: [] }); await settle();
  assert.match(policy(app), /"deleteEffect":"skip"/);
  assert.ok(isSkip(await cross(app)));
});

test('restore: a read started before it publishes nothing; until a read in the new epoch, × deletes nothing and Match isn’t offered', async () => {
  const app = await boot();
  const g = app.hold(LINKS);
  const old = app.ctx.readLibrary();
  await g.reached;
  const hold = app.hold(r => r.method === 'GET' && r.url.includes('/watchlist_items?') && r.url.includes('is_film=eq.false'));
  app.ctx.invalidateOrganization(); app.ctx.finishRestoreAndReload();    // a completed restore; its view reload is held
  await hold.reached;
  g.releaseWith({ tv_shows: [] }); await old; await settle();
  assert.strictEqual(app.get('libraryGovernance.knownShows.size'), 0, 'nothing from the old epoch published');
  assert.match(policy(app), /"deleteEffect":"unknown"/);
  assert.strictEqual(app.get(`isTmdbMatchEligible(derivedData.rows.find(r => r.id === ${JSON.stringify(RID)}))`), false);
  const out = await cross(app);
  assert.deepStrictEqual(out.sent, [], 'nothing sent');
  assert.ok(out.stored && !out.stored.skipped);
  assert.match(app.el('banner').innerHTML, /couldn’t confirm whether “Andor” is a built-in catalog entry, so nothing was deleted/);
  hold.release(); await settle(); await settle();
  assert.match(policy(app), /"deleteEffect":"skip"/, 'the new epoch’s read decides again');
  assert.ok(isSkip(await cross(app)));
});

test('a row the published governance doesn’t cover (it appeared after that read) is neither deleted nor matched', async () => {
  const app = await boot();
  const late = { ...season, id: '5b000000-0000-4000-8000-000000000099', show_id: '5a000000-0000-4000-8000-000000000099', item_key: 'later|season 1', title: 'Later' };
  app.run(`derivedData.rows.push(${JSON.stringify(late)})`);
  assert.match(app.get(`JSON.stringify(editPolicyOf(derivedData.rows.find(r => r.id === ${JSON.stringify(late.id)})))`), /"deleteEffect":"unknown"/);
  app.ctx.confirm = () => true;
  await app.ctx.delRowInView(late.id); await settle();
  assert.deepStrictEqual(sent(app), []);
});

T.run();
