// A database read refused with HTTP 401 PGRST303 "JWT issued at future" (the hosted API's clock lagging after idling) is sent
// once more after a short wait (api.js dbRead); anything else, and any write, is handled as before.
// Run from the repo root: node tests/read-retry.test.js
const assert = require('assert');
const { createApp, runner, settle, HARNESS_USER } = require('./app-harness');

const T = runner('read-retry');
const test = T.test;
const OTHER = '0b000000-0000-4000-8000-0000000000bb';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const linkedRow = n => ({ id: uuid(n), collection: 'othertv', item_key: `show ${n}|season 1`, title: `Show ${n}`, season: 'Season 1', theme: 'HBO',
  display_date: 'Jan 1, 2020', date_sort: '2020-01-01', watched: false, status: 'confirmed', created_at: '2026-01-01T00:00:00+00:00', watch_with: [],
  collections: [], tmdb_collection_id: null, tmdb_collection_name: null, media_type: 'tv', tmdb_id: n, season_number: 1, show_id: uuid(5000 + n), skipped: false });
const showRow = n => ({ id: uuid(5000 + n), collection: 'othertv', title: `Show ${n}`, show_key: `show ${n}`, tmdb_id: n, status: 'confirmed', created_at: '2026-01-01T00:00:00+00:00' });
const lib = (...ns) => ({ rows: ns.map(linkedRow), tvShows: ns.map(showRow) });

const ITEMS = r => r.method === 'GET' && r.url.includes('/rest/v1/watchlist_items?');
const CATALOG = r => r.method === 'GET' && r.url.includes('/rest/v1/library_catalog_shows?');
const future = (app, pred) => app.refuseNext(pred, 'PGRST303', 'JWT issued at future', 401);
const count = (app, pred, from = 0) => app.requests.slice(from).filter(pred).length;
const shown = app => app.el('tbody').innerHTML;
const banner = app => (app.el('phaseBanner') || {}).innerHTML || '';
// A wait the test releases: app.readDelayGate until release().
function holdDelay(app) {
  let release; app.readDelayGate = new Promise(r => { release = r; });
  return () => { app.readDelayGate = null; release(); };
}

test('All TV: the error, then success: one wait of about two seconds, one more request, the normal list', async () => {
  const app = await createApp(lib(1, 2));
  const from = app.requests.length;
  future(app, ITEMS);
  app.ctx.switchView('alltv'); await settle(60);
  assert.strictEqual(count(app, ITEMS, from), 2, 'sent once more');
  assert.deepStrictEqual(app.readDelays, [2000]);
  assert.ok(shown(app).includes('Show 1') && shown(app).includes('Show 2'), 'the normal load');
  assert.ok(!shown(app).includes('Failed to load'));
  assert.strictEqual(banner(app), '', 'no sign-in notice');
  assert.strictEqual(app.writes().length, 0);
});

test('the strict read (library_catalog_shows, as Currently Watching reads it): retried once, then complete', async () => {
  const app = await createApp(lib(1));
  const from = app.requests.length;
  future(app, CATALOG);
  const out = await app.run('readLibrary().then(l => ({ ok: true, n: l ? 1 : 0 }), e => ({ ok: false, m: e.message }))');
  assert.ok(out.ok, out.m);
  assert.strictEqual(count(app, CATALOG, from), 2);
  assert.deepStrictEqual(app.readDelays, [2000]);
});

test('repeated failure: one retry only; the load-error screen and Retry, never a partial list; Retry then works', async () => {
  const app = await createApp(lib(1));
  const from = app.requests.length;
  future(app, ITEMS); future(app, ITEMS);
  app.ctx.switchView('alltv'); await settle(60);
  assert.strictEqual(count(app, ITEMS, from), 2, 'bounded: the first request and one retry');
  assert.deepStrictEqual(app.readDelays, [2000]);
  assert.ok(shown(app).includes('Failed to load') && shown(app).includes('loadDerivedView()'));
  assert.ok(!shown(app).includes('derived-show-row'), 'nothing partial');
  assert.ok(app.el('errorBanner').innerHTML.includes("Couldn't load every TV row") && app.el('errorBanner').innerHTML.includes('JWT issued at future'));
  assert.strictEqual(banner(app), '', 'this error alone is not an ended sign-in');
  app.ctx.loadDerivedView(); await settle(60); // the manual Retry
  assert.ok(shown(app).includes('Show 1'));
  assert.strictEqual(app.writes().length, 0);
});

test('a later page failing the same way: each request is retried at most once, and the read still fails whole', async () => {
  const app = await createApp(lib(1));
  future(app, CATALOG); future(app, CATALOG);
  const out = await app.run('readLibrary().then(() => ({ ok: true }), e => ({ ok: false, m: e.message }))');
  assert.ok(!out.ok && /Failed reading library_catalog_shows \(offset 0\): 401 .*JWT issued at future/.test(out.m), out.m);
  assert.deepStrictEqual(app.readDelays, [2000]);
});

test('other authentication errors are not retried: a different message, a different code, another status', async () => {
  for (const [code, message, status] of [['PGRST303', 'JWT expired', 401], ['PGRST301', 'JWT issued at future', 401], ['PGRST303', 'JWT issued at future', 403]]) {
    const app = await createApp(lib(1));
    const from = app.requests.length;
    app.refuseNext(ITEMS, code, message, status);
    app.ctx.switchView('alltv'); await settle(60);
    assert.strictEqual(count(app, ITEMS, from), 1, `${code} ${message} ${status}: not sent again`);
    assert.deepStrictEqual(app.readDelays, []);
    assert.ok(shown(app).includes('Failed to load'));
  }
});

test('single reads (sbFetch GET): retried once; a genuine 401 still shows the sign-in notice; this one never does', async () => {
  const app = await createApp(lib(1));
  const CAP = r => r.method === 'GET' && r.url.includes('/rpc/stage5_capabilities');
  let from = app.requests.length;
  future(app, CAP);
  let out = await app.run("sbFetch('GET', 'rpc/stage5_capabilities', null).then(c => ({ ok: !!c }), e => ({ ok: false, m: e.message }))");
  assert.ok(out.ok, out.m);
  assert.strictEqual(count(app, CAP, from), 2);
  assert.strictEqual(banner(app), '');
  from = app.requests.length;
  future(app, CAP); future(app, CAP);
  out = await app.run("sbFetch('GET', 'rpc/stage5_capabilities', null).then(() => ({ ok: true }), e => ({ ok: false, m: e.message }))");
  assert.ok(!out.ok && /JWT issued at future/.test(out.m));
  assert.strictEqual(count(app, CAP, from), 2, 'bounded');
  assert.strictEqual(banner(app), '', 'not shown as an ended sign-in');
  from = app.requests.length;
  app.refuseNext(CAP, 'PGRST303', 'JWT expired', 401);
  out = await app.run("sbFetch('GET', 'rpc/stage5_capabilities', null).then(() => ({ ok: true }), e => ({ ok: false, m: e.message }))");
  assert.ok(!out.ok);
  assert.strictEqual(count(app, CAP, from), 1);
  assert.match(banner(app), /Your sign-in has ended/, 'a genuine rejection keeps its notice');
});

test('a single read (sbFetch GET) whose session changed during the wait: the retry reads the headers again, so nothing is sent', async () => {
  const app = await createApp(lib(1));
  const CAP = r => r.method === 'GET' && r.url.includes('/rpc/stage5_capabilities');
  const release = holdDelay(app);
  const from = app.requests.length;
  future(app, CAP);
  const p = app.run("sbFetch('GET', 'rpc/stage5_capabilities', null).then(() => ({ ok: true }), e => ({ ok: false, notSent: !!e.notSent }))");
  await settle(40);
  app.session = null;
  release();
  const out = await p;
  assert.ok(!out.ok && out.notSent, 'refused before sending');
  assert.strictEqual(count(app, CAP, from), 1);
});

test('writes are never sent again: a change refused this way is a refusal, nothing replayed, no sign-in notice', async () => {
  const app = await createApp(lib(1));
  const WRITE = r => r.url.includes('/rpc/org_create_collection');
  future(app, WRITE);
  await app.run(`runWrite('Create collection', () => sbRpc('org_create_collection', { p_id: ${JSON.stringify(uuid(9100))}, p_name: 'ZZ New' })).catch(e => (window.__lastError = e, null))`);
  await settle();
  assert.strictEqual(app.requests.filter(WRITE).length, 1, 'sent once');
  assert.deepStrictEqual(app.readDelays, []);
  assert.match(String(app.get('window.__lastError.message')), /JWT issued at future/);
  assert.deepStrictEqual(app.store.personal_collections.filter(c => c.name === 'ZZ New'), []);
  assert.strictEqual(banner(app), '');
});

test('navigating away during the wait: the old view never publishes', async () => {
  const app = await createApp(lib(1));
  const release = holdDelay(app);
  future(app, ITEMS);
  app.ctx.switchView('alltv'); await settle(40);
  assert.deepStrictEqual(app.readDelays, [2000], 'waiting');
  app.ctx.switchView('coming'); await settle(40);
  const comingHtml = shown(app);
  release(); await settle(60);
  assert.strictEqual(app.get('activeViewId'), 'coming');
  assert.strictEqual(shown(app), comingHtml, 'the All TV read did not draw over Coming Soon');
});

test('signed out or another account during the wait: the retry is refused before it is sent', async () => {
  const app = await createApp(lib(1));
  let release = holdDelay(app);
  let from = app.requests.length;
  future(app, ITEMS);
  app.ctx.switchView('alltv'); await settle(40);
  app.session = null; // the session ended elsewhere
  release(); await settle(60);
  assert.strictEqual(count(app, ITEMS, from), 1, 'no second request without a session');
  assert.ok(shown(app).includes('Failed to load'));
  assert.match(banner(app), /Your sign-in has ended/);

  const app2 = await createApp(lib(1));
  app2.reloadCount = 0; app2.ctx.location = Object.assign(app2.ctx.location || {}, { reload: () => { app2.reloadCount++; } });
  release = holdDelay(app2);
  from = app2.requests.length;
  future(app2, ITEMS);
  app2.ctx.switchView('alltv'); await settle(40);
  app2.session = { access_token: 'other-token', user: { id: OTHER, email: 'ob@test.invalid' } }; // without the Auth event yet
  release(); await settle(60);
  assert.strictEqual(count(app2, ITEMS, from), 1, 'nothing sent with the other account');
  assert.ok(!app2.requests.slice(from).some(r => (r.headers.Authorization || '').includes('other-token')));
  assert.ok(!shown(app2).includes('derived-show-row'));
  assert.strictEqual(app2.reloadCount, 1, 'the page reloads for the other account');
  assert.strictEqual(app2.get('pageUser.id'), HARNESS_USER);
});

test('a change saved during the wait: the overlapping read does not publish; the list is read again', async () => {
  const app = await createApp(lib(1));
  const release = holdDelay(app);
  const from = app.requests.length;
  future(app, ITEMS);
  app.ctx.switchView('alltv'); await settle(40);
  await app.run(`runWrite('Create collection', () => sbRpc('org_create_collection', { p_id: ${JSON.stringify(uuid(9101))}, p_name: 'ZZ During' }))`);
  release(); await settle(80);
  assert.ok(count(app, ITEMS, from) >= 3, 'the refused read, its retry, and a fresh read after the change');
  assert.ok(shown(app).includes('Show 1'));
  assert.ok(!shown(app).includes('Failed to load'));
});

T.run();
