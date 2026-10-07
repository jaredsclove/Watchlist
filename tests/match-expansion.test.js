// Offline tests for the Match collection-expansion confirmation (Stage 3b-2,
// tmdb-match.js): the database's existing token protocol (preview {}, confirm
// {"confirm": token}, changed proposals, vanished expansions) through the panel;
// archive markers only from a fresh read; the proposal bound to the row, TMDB id
// and season; delayed replies after Cancel, a newer read, a newer match or a
// restore; and the refresh messages ("Refreshed." only after an accepted read).
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
  app.ctx.switchTab('truecrime'); await settle();
  app.addEl('tmdbMatchBody');
  return { app, f, disney };
}
const select = (app, rowId, season = 1, tmdb = 4000) => {
  app.ctx.__tmdbMatch = { rowId, results: [], target: { mediaType: 'tv', seasonNumber: season,
    details: { id: tmdb, name: 'Target Show', networks: [{ name: 'Net' }], seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 3, air_date: '2022-01-01' }] } } };
};
const rpcCalls = app => app.requests.filter(r => r.url.includes('/rpc/match_tv_row'));
const panel = app => app.el('tmdbMatchBody').innerHTML;
const notice = app => app.el('noticeBanner').innerHTML;
const membersOfShow = (app, id) => app.store.collection_memberships.filter(m => m.show_id === id).map(m => m.collection_id).sort();

test('preview: the panel names the collections from the reply and the seasons; nothing is written; a fresh collections read comes first', async () => {
  const { app, f } = await boot();
  select(app, f.legacy.id);
  const before = app.requests.length;
  await app.ctx.confirmTmdbMatch(); await settle();
  const after = app.requests.slice(before);
  assert.deepStrictEqual(after.filter(r => r.method !== 'GET').map(r => new URL(r.url).pathname.split('/').pop()), ['match_tv_row']);
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
  assert.match(panel(app), /<strong>Disney\+<\/strong> \(archived: not shown in Browse\)/);
});

test('if the fresh read fails, the panel says it couldn’t check archive state and shows no markers (even if the older list had one)', async () => {
  const { app, f } = await boot();
  app.get('personalCollections').find(c => c.legacy_source === 'disney').archived_at = TS; // stale cached marker
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
  const g = app.hold(r => r.url.includes('/rpc/match_tv_row'));
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
  assert.ok(app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).tmdb_id === 4000, 'applied (the page’s row was still current)');
});

test('a delayed blocked answer after Cancel is dropped (it wrote nothing)', async () => {
  const { app, f } = await boot();
  select(app, f.legacy.id);
  const g = app.hold(r => r.url.includes('/rpc/match_tv_row'));
  const p = app.ctx.confirmTmdbMatch();
  await g.reached;
  app.ctx.cancelTmdbMatch();
  app.el('tmdbMatchBody').innerHTML = 'closed';
  g.release(); await p; await settle();
  assert.strictEqual(panel(app), 'closed', 'no panel drawn');
  assert.strictEqual(app.ctx.__tmdbMatch, null);
});

test('a delayed success after a newer read of the row: reported, not inserted; "Refreshed." only after the fresh read is accepted', async () => {
  const { app, f } = await boot();
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  const g = app.hold(r => r.url.includes('/rpc/match_tv_row'));
  const p = app.ctx.confirmTmdbMatch(true);
  await g.reached;
  // A newer read replaced the page's rows (new objects).
  app.get('tabData').truecrime.rows = app.get('tabData').truecrime.rows.map(r => ({ ...r, title: r.id === f.legacy.id ? 'Target Show (newer read)' : r.title }));
  const refresh = app.hold(r => r.method === 'GET' && r.url.includes(`id=eq.${f.legacy.id}`));
  g.release();
  await refresh.reached;
  assert.match(notice(app), /Matched “Target Show”\. Refreshing to show what is saved now…/);
  assert.ok(!/Refreshed\./.test(notice(app)), 'no "Refreshed" before the read is accepted');
  assert.strictEqual(app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).title, 'Target Show (newer read)', 'the reply’s row was not inserted');
  refresh.release(); await p; await settle();
  assert.match(notice(app), /Refreshed\./);
  assert.strictEqual(app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).tmdb_id, 4000, 'the fresh read shows the match');
});

test('a failed refresh keeps the Match outcome, offers Retry that only reads, and never says the match failed', async () => {
  const { app, f } = await boot();
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  const g = app.hold(r => r.url.includes('/rpc/match_tv_row'));
  const p = app.ctx.confirmTmdbMatch(true);
  await g.reached;
  app.get('tabData').truecrime.rows = app.get('tabData').truecrime.rows.map(r => ({ ...r }));
  app.failNext(r => r.method === 'GET' && r.url.includes(`id=eq.${f.legacy.id}`));
  g.release(); await p; await settle();
  assert.match(notice(app), /Matched “Target Show”, but the current data couldn’t be refreshed/);
  assert.match(notice(app), /retryMatchRefresh\(\)">Retry/);
  assert.ok(!/not matched|nothing was matched|failed to match/i.test(notice(app)));
  const before = app.requests.length;
  app.ctx.retryMatchRefresh(); await settle();
  const sent = app.requests.slice(before);
  assert.ok(sent.length && sent.every(r => r.method === 'GET' && !r.url.includes('/rpc/')), 'Retry sends only GET reads');
  assert.match(notice(app), /Refreshed\./);
});

test('a superseded refresh never says "Refreshed"; only the newer read’s acceptance does', async () => {
  const { app, f } = await boot();
  app.store.watchlist_items.find(r => r.id === f.legacy.id).tmdb_id = null;
  const stamp = { seq: 99, rowId: f.legacy.id, epoch: app.get('orgEpoch'), rowObj: null, collection: 'truecrime', title: 'Target Show' };
  const first = app.hold(r => r.method === 'GET' && r.url.includes(`id=eq.${f.legacy.id}`));
  const p1 = app.ctx.refreshAfterMatch(stamp, false);
  await first.reached;
  const second = app.hold(r => r.method === 'GET' && r.url.includes(`id=eq.${f.legacy.id}`));
  const p2 = app.ctx.refreshAfterMatch(stamp, false);
  await second.reached;
  first.release(); await p1; await settle();
  assert.ok(!/Refreshed\./.test(notice(app)), 'the retired read says nothing');
  second.release(); await p2; await settle();
  assert.match(notice(app), /Refreshed\./);
});

test('Match vs restore (i): the match ran before the restore; the late success is reported with no order claim, its payload discarded, the fresh read shows the restored state', async () => {
  const { app, f } = await boot();
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  const snapshot = JSON.parse(JSON.stringify(app.store.watchlist_items));
  const g = app.hold(r => r.url.includes('/rpc/match_tv_row'));
  const original = app.rpcHandlers.match_tv_row;
  app.rpcHandlers.match_tv_row = body => {
    const res = original(body);                               // the match executes …
    app.store.watchlist_items = JSON.parse(JSON.stringify(snapshot)); // … then a restore replaces the data
    app.run('orgEpoch++');                                     // (the page's restore epoch)
    return res;
  };
  const p = app.ctx.confirmTmdbMatch(true);
  await g.reached; g.release(); await p; await settle();
  assert.match(notice(app), /Matched “Target Show”\. Your data was also restored while this match was in progress\./);
  assert.ok(!/before|after/.test(notice(app).replace(/<[^>]+>/g, '')), 'no execution-order claim');
  assert.match(notice(app), /Refreshed\./);
  assert.strictEqual(app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).tmdb_id, null, 'the restored (unmatched) row is shown, not the reply’s');
});

test('Match vs restore (ii): a delayed match executes after the restore; the success is reported with no order claim and the fresh read shows the matched row', async () => {
  const { app, f } = await boot();
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  const g = app.hold(r => r.url.includes('/rpc/match_tv_row'));
  const p = app.ctx.confirmTmdbMatch(true);
  await g.reached;                       // held in transport
  app.run('orgEpoch++');                 // the restore happens first (same data restored)
  app.get('tabData').truecrime.rows = JSON.parse(JSON.stringify(app.store.watchlist_items)); // its reload (unmatched)
  g.release(); await p; await settle(); // then the match executes on the restored data
  assert.match(notice(app), /Matched “Target Show”\. Your data was also restored while this match was in progress\./);
  assert.match(notice(app), /Refreshed\./);
  assert.strictEqual(app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).tmdb_id, 4000,
    'the fresh read after the reply shows the match, which the restore’s reload (taken earlier) didn’t');
});

test('a restore while the refresh runs starts the read again under the new epoch; "Refreshed." only from that read', async () => {
  const { app, f } = await boot();
  const stamp = { seq: 5, rowId: f.legacy.id, epoch: app.get('orgEpoch'), rowObj: null, collection: 'truecrime', title: 'Target Show' };
  const first = app.hold(r => r.method === 'GET' && r.url.includes(`id=eq.${f.legacy.id}`));
  const p = app.ctx.refreshAfterMatch(stamp, false);
  await first.reached;
  app.run('orgEpoch++');
  const again = app.hold(r => r.method === 'GET' && r.url.includes(`id=eq.${f.legacy.id}`));
  first.release(); await p;
  await again.reached;
  assert.ok(!/Refreshed\./.test(notice(app)));
  assert.match(notice(app), /restored while this match was in progress/);
  again.release(); await settle();
  assert.match(notice(app), /Refreshed\./);
});

test('the status-conflict answer keeps its message; an old-shape call is never sent with personal collections', async () => {
  const { app, f } = await boot();
  const legacyShow = { id: uuid('5a', 20), collection: 'truecrime', title: 'Target Show', show_key: 'target show x', tmdb_id: null, status: 'watching', created_at: TS };
  app.store.tv_shows.push(legacyShow);
  const row = app.store.watchlist_items.find(r => r.id === f.legacy.id);
  Object.assign(row, { season: 'Season 1', item_key: 'target show x|season 1', show_id: legacyShow.id });
  app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).show_id = legacyShow.id;
  select(app, f.legacy.id);
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.match(app.el('errorBanner').innerHTML, /Give both the same status first/);
  assert.ok(rpcCalls(app).every(c => c.body.p_expansion !== undefined));
});

// ── Refresh publication guards (review finding 1) ──
const refreshStamp = (app, f) => ({ seq: 1, rowId: f.legacy.id, epoch: app.get('orgEpoch'), rowObj: null, collection: 'truecrime', title: 'Target Show' });
// Answer a held request with what the database held before (the older read's view), then put the newer state back.
const releaseWithOlder = async (app, g, table, older, p) => {
  const now = app.store[table]; app.store[table] = older; g.release(); await p; await settle(); app.store[table] = now;
};

test('a newer tab read that completed first is the accepted replacement: the older refresh never overwrites it; "Refreshed." comes from that read', async () => {
  const { app, f } = await boot();
  const older = JSON.parse(JSON.stringify(app.store.watchlist_items));
  const held = app.hold(r => r.method === 'GET' && r.url.includes(`watchlist_items?id=eq.${f.legacy.id}`));
  const p = app.ctx.refreshAfterMatch(refreshStamp(app, f), false);
  await held.reached;
  app.store.watchlist_items.find(r => r.id === f.legacy.id).title = 'Newer Read';
  await app.run('loadTab("truecrime")'); await settle();
  assert.strictEqual(app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).title, 'Newer Read');
  await releaseWithOlder(app, held, 'watchlist_items', older, p);
  assert.strictEqual(app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).title, 'Newer Read', 'not overwritten by the older refresh');
  assert.match(notice(app), /Matched “Target Show”\. Refreshed\./, 'the replacement read (tab and its show read) was accepted; the outcome stays reported');
});

test('(guard) after a newer Match changed the page row, the older refresh never overwrites it; the page row is the accepted current state', async () => {
  const { app, f } = await boot();
  const held = app.hold(r => r.method === 'GET' && r.url.includes(`watchlist_items?id=eq.${f.legacy.id}`));
  const p = app.ctx.refreshAfterMatch(refreshStamp(app, f), false);
  await held.reached;
  // A newer Match of this row applied to the page, with the bookkeeping confirmTmdbMatch does on apply.
  app.run(`(() => { const r = matchReadStart('match', 'truecrime', '${f.legacy.id}'); matchLatestByRow['${f.legacy.id}'] = 99;
    tabData.truecrime.rows.find(x => x.id === '${f.legacy.id}').title = 'After Newer Match';
    r.applied = true; matchNotePublished('rows', '${f.legacy.id}', r); matchReadSettle(r, null); })()`);
  held.release(); await p; await settle();
  assert.strictEqual(app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).title, 'After Newer Match');
  assert.ok(!/couldn’t be refreshed/.test(notice(app)));
  assert.match(notice(app), /Refreshed\./, 'the applied newer Match covers the row');
});

test('a delayed show response from a refresh never overwrites a newer show read that completed (the shared show cache); that read is accepted', async () => {
  const { app, f } = await boot();
  const older = JSON.parse(JSON.stringify(app.store.tv_shows));
  const held = app.hold(r => r.method === 'GET' && r.url.includes('tv_shows?collection=eq.truecrime'));
  const p = app.ctx.refreshAfterMatch(refreshStamp(app, f), false);
  await held.reached;
  app.store.tv_shows.find(s => s.id === f.tvShow.id).status = 'complete';
  await app.run('loadTvShows("truecrime")'); await settle();
  assert.strictEqual(app.get('tvShowsById').get(f.tvShow.id).status, 'complete');
  await releaseWithOlder(app, held, 'tv_shows', older, p);
  assert.strictEqual(app.get('tvShowsById').get(f.tvShow.id).status, 'complete', 'the older show response was not published');
  assert.match(notice(app), /Refreshed\./, 'the newer show read was accepted');
});

test('a show response from before a restore is never published (the restarted refresh publishes the new epoch’s data)', async () => {
  const { app, f } = await boot();
  const older = JSON.parse(JSON.stringify(app.store.tv_shows));
  older.find(s => s.id === f.tvShow.id).status = 'watching';           // what the pre-restore read saw (distinct from the boot value)
  const first = app.hold(r => r.method === 'GET' && r.url.includes('tv_shows?collection=eq.truecrime'));
  const p = app.ctx.refreshAfterMatch(refreshStamp(app, f), false);
  await first.reached;
  app.run('orgEpoch++');                                               // a restore …
  app.store.tv_shows.find(s => s.id === f.tvShow.id).status = 'maybe';  // … with different show data
  const second = app.hold(r => r.method === 'GET' && r.url.includes('tv_shows?collection=eq.truecrime'));
  const now = app.store.tv_shows; app.store.tv_shows = older; first.release(); await p; await settle(); app.store.tv_shows = now;
  await second.reached;
  assert.notStrictEqual(app.get('tvShowsById').get(f.tvShow.id)?.status, 'watching', 'the pre-restore response was not published');
  assert.ok(!/Refreshed\./.test(notice(app)));
  second.release(); await settle(); await settle();
  assert.strictEqual(app.get('tvShowsById').get(f.tvShow.id).status, 'maybe');
  assert.match(notice(app), /Refreshed\./);
});

// ── Refresh progress ownership (review round 2) ──
// A Match that the database applies while a newer read replaced the page's rows, so its result isn't
// current and it refreshes (the real confirm path). Returns the held match call.
async function matchNotCurrent(app, rowId, tmdb, name) {
  app.ctx.__tmdbMatch = { rowId, results: [], target: { mediaType: 'tv', seasonNumber: 1,
    details: { id: tmdb, name, networks: [{ name: 'Net' }], seasons: [{ season_number: 1, air_date: '2020-01-01' }] } } };
  const g = app.hold(r => r.url.includes('/rpc/match_tv_row'));
  const p = app.ctx.confirmTmdbMatch();
  await g.reached;
  app.get('tabData').truecrime.rows = app.get('tabData').truecrime.rows.map(r => ({ ...r })); // a newer read replaced the rows
  return { g, p };
}
const rowGet = id => r => r.method === 'GET' && r.url.includes(`watchlist_items?id=eq.${id}`);
const showsGet = r => r.method === 'GET' && r.url.includes('tv_shows?collection=eq.truecrime');

test('a replacement show read still pending keeps "Refreshing…"; when it succeeds, "Refreshed."', async () => {
  const { app, f } = await boot();
  const ownShows = app.hold(showsGet);
  const { g, p } = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  g.release(); await ownShows.reached;
  const replacement = app.hold(showsGet);
  const rp = app.run('loadTvShows("truecrime")');                       // an ordinary show read starts
  await replacement.reached;
  ownShows.fail(); await p; await settle();                             // the refresh's own show read fails: the replacement owns the shows
  assert.match(notice(app), /Matched “Target Show”\. Refreshing to show what is saved now…/, 'still pending: the replacement owns the shows part');
  assert.ok(!/Refreshed|couldn’t/.test(notice(app)));
  replacement.release(); await rp; await settle();
  assert.match(notice(app), /Matched “Target Show”\. Refreshed\./);
});

test('a replacement show read that fails leaves the Match outcome, the warning and a read-only Retry', async () => {
  const { app, f } = await boot();
  const ownShows = app.hold(showsGet);
  const { g, p } = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  g.release(); await ownShows.reached;
  const replacement = app.hold(showsGet);
  const rp = app.run('loadTvShows("truecrime")').catch(() => {});
  await replacement.reached;
  ownShows.fail(); await p; await settle();
  assert.match(notice(app), /Refreshing/);
  replacement.fail(); await rp; await settle();
  assert.match(notice(app), /Matched “Target Show”, but the current data couldn’t be refreshed/);
  assert.match(notice(app), /retryMatchRefresh\(\)">Retry/);
  const before = app.requests.length;
  app.ctx.retryMatchRefresh(); await settle();
  const sent = app.requests.slice(before);
  assert.ok(sent.length && sent.every(r => r.method === 'GET' && !r.url.includes('/rpc/')), 'Retry only reads');
  assert.match(notice(app), /Refreshed\./);
});

test('an older refresh that fails after a newer ordinary read succeeded doesn’t announce a failure; the newer read is accepted', async () => {
  const { app, f } = await boot();
  const { g, p } = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  const own = app.hold(rowGet(f.legacy.id));
  g.release(); await own.reached;
  await app.run('loadTab("truecrime")'); await settle();               // a newer ordinary read succeeds (rows and shows)
  own.fail(); await p; await settle();                                   // then the older refresh's read fails
  assert.ok(!/couldn’t be refreshed/.test(notice(app)), 'no failure for data that a newer read already refreshed');
  assert.match(notice(app), /Matched “Target Show”\. Refreshed\./);
});

test('a newer Match (another row) joins the refresh; its reads succeed; both outcomes stay; "Refreshed." only once the first row’s read completes too', async () => {
  const { app, f } = await boot();
  const other = { ...f.legacy, id: 'f0000000-0000-4000-8000-000000000099', item_key: 'other show|film', title: 'Other Show' };
  app.store.watchlist_items.push({ ...other }); app.get('tabData').truecrime.rows.push({ ...other });
  const x = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  const ownX = app.hold(rowGet(f.legacy.id));
  x.g.release(); await ownX.reached;
  const y = await matchNotCurrent(app, other.id, 6000, 'Other Show');
  y.g.release(); await y.p; await settle();
  assert.match(notice(app), /Matched “Target Show”\. Matched “Other Show”\. Refreshing/, 'the first row is still to be read');
  ownX.release(); await x.p; await settle();
  assert.strictEqual(app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).tmdb_id, 5000);
  assert.match(notice(app), /Matched “Target Show”\. Matched “Other Show”\. Refreshed\./);
});

test('a newer Match supersedes the refresh and its refresh fails: both outcomes, the warning and Retry; the older result changes nothing', async () => {
  const { app, f } = await boot();
  const other = { ...f.legacy, id: 'f0000000-0000-4000-8000-000000000098', item_key: 'other show|film', title: 'Other Show' };
  app.store.watchlist_items.push({ ...other }); app.get('tabData').truecrime.rows.push({ ...other });
  const x = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  const ownX = app.hold(rowGet(f.legacy.id));
  x.g.release(); await ownX.reached;
  const y = await matchNotCurrent(app, other.id, 6000, 'Other Show');
  app.failNext(rowGet(other.id));
  y.g.release(); await y.p; await settle();
  assert.match(notice(app), /Matched “Target Show” and “Other Show”, but the current data couldn’t be refreshed/);
  assert.match(notice(app), /Retry/);
  ownX.release(); await x.p; await settle();
  assert.match(notice(app), /Matched “Target Show” and “Other Show”, but the current data couldn’t be refreshed/, 'the second row still failed: unchanged');
  assert.strictEqual(app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).tmdb_id, 5000, 'the first row was published by its own read');
});

test('a newer Match of the same row still in progress doesn’t retire the refresh’s own read (nothing newer was accepted); it ends without a change and is never re-sent', async () => {
  const { app, f } = await boot();
  const x = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  const own = app.hold(rowGet(f.legacy.id));
  x.g.release(); await own.reached;
  // The page still shows the row unmatched: the user matches it again.
  app.ctx.__tmdbMatch = { rowId: f.legacy.id, results: [], target: { mediaType: 'tv', seasonNumber: 1,
    details: { id: 5000, name: 'Target Show', networks: [], seasons: [{ season_number: 1, air_date: '2020-01-01' }] } } };
  const g2 = app.hold(r => r.url.includes('/rpc/match_tv_row'));
  const p2 = app.ctx.confirmTmdbMatch();
  await g2.reached;
  own.release(); await x.p; await settle();
  assert.strictEqual(app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).tmdb_id, 5000, 'the own read was accepted');
  assert.match(notice(app), /Matched “Target Show”\. Refreshed\./);
  g2.release(); await p2; await settle(); await settle();               // it ends without changing the row (already matched)
  assert.match(notice(app), /Matched “Target Show”\. Refreshed\./, 'unchanged by the newer Match that changed nothing');
  assert.strictEqual(app.requests.filter(r => r.url.includes('/rpc/match_tv_row')).length, 2, 'only the user’s two match calls');
  assert.strictEqual(app.get('tabData').truecrime.rows.find(r => r.id === f.legacy.id).tmdb_id, 5000, 'the fresh read shows the match');
});

// ── Refresh obligations and read ownership (review round 3) ──
const within = (p, n = 300) => Promise.race([p.then(() => true), (async () => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); return false; })()]);
const tabGet = r => r.method === 'GET' && r.url.includes('watchlist_items?collection=eq.truecrime');
const pageRow = (app, id) => app.get('tabData').truecrime.rows.find(r => r.id === id);
const addOtherRow = (app, f, id) => {
  const other = { ...f.legacy, id, item_key: 'other show|film', title: 'Other Show' };
  app.store.watchlist_items.push({ ...other }); app.get('tabData').truecrime.rows.push({ ...other });
  return other;
};

test('round 3: two matched rows with overlapping refreshes — both rows are current before the combined notice says "Refreshed."', async () => {
  const { app, f } = await boot();
  const other = addOtherRow(app, f, 'f0000000-0000-4000-8000-000000000097');
  const x = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  const ownX = app.hold(rowGet(f.legacy.id));
  x.g.release(); assert.ok(await within(ownX.reached));
  const y = await matchNotCurrent(app, other.id, 6000, 'Other Show');
  y.g.release(); await within(y.p); await settle();
  assert.strictEqual(pageRow(app, other.id).tmdb_id, 6000, 'the second row is current');
  assert.strictEqual(pageRow(app, f.legacy.id).tmdb_id, null, 'the first row is not yet');
  assert.match(notice(app), /Matched “Target Show”\. Matched “Other Show”\. Refreshing/, 'not "Refreshed" while the first row is stale');
  ownX.release(); await within(x.p); await settle();
  assert.strictEqual(pageRow(app, f.legacy.id).tmdb_id, 5000, 'the first row is current');
  assert.match(notice(app), /Matched “Target Show”\. Matched “Other Show”\. Refreshed\./);
});

test('round 3: failure and Retry with two unresolved rows — Retry reads every unresolved row (GET only, Match not re-sent)', async () => {
  const { app, f } = await boot();
  const other = addOtherRow(app, f, 'f0000000-0000-4000-8000-000000000096');
  const x = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  const ownX = app.hold(rowGet(f.legacy.id));
  x.g.release(); assert.ok(await within(ownX.reached));
  app.failNext(rowGet(other.id));
  const y = await matchNotCurrent(app, other.id, 6000, 'Other Show');
  y.g.release(); await within(y.p); await settle();
  ownX.fail(); await within(x.p); await settle();
  assert.match(notice(app), /Matched “Target Show” and “Other Show”, but the current data couldn’t be refreshed/);
  const before = app.requests.length, matches = app.requests.filter(r => r.url.includes('/rpc/match_tv_row')).length;
  app.ctx.retryMatchRefresh(); await settle(); await settle();
  const sent = app.requests.slice(before);
  assert.ok(sent.every(r => r.method === 'GET'), 'Retry only reads');
  assert.ok(sent.some(r => rowGet(f.legacy.id)(r)) && sent.some(r => rowGet(other.id)(r)), 'both unresolved rows are read again');
  assert.strictEqual(app.requests.filter(r => r.url.includes('/rpc/match_tv_row')).length, matches, 'Match not re-sent');
  assert.strictEqual(pageRow(app, f.legacy.id).tmdb_id, 5000);
  assert.strictEqual(pageRow(app, other.id).tmdb_id, 6000);
  assert.match(notice(app), /Refreshed\./);
});

test('round 3: a restore after the refresh handed ownership to a replacement tab read — the old-epoch read neither publishes nor completes; fresh reads decide', async () => {
  const { app, f } = await boot();
  const x = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  const ownRow = app.hold(rowGet(f.legacy.id));
  x.g.release(); assert.ok(await within(ownRow.reached));
  const tabRead = app.hold(tabGet);
  const tp = app.run('loadTab("truecrime")');
  assert.ok(await within(tabRead.reached));
  ownRow.fail(); await within(x.p); await settle();
  assert.match(notice(app), /Refreshing/, 'the pending tab read owns the row');
  const older = JSON.parse(JSON.stringify(app.store.watchlist_items));
  app.store.watchlist_items.find(r => r.id === f.legacy.id).title = 'Restored Title';   // the restore's data
  const again = app.hold(rowGet(f.legacy.id));
  app.run('invalidateOrganization()');                                                // a restore in this page (epoch++)
  assert.ok(await within(again.reached), 'the refresh reads again under the new epoch');
  const tabBefore = app.get('tabData').truecrime;
  const now = app.store.watchlist_items; app.store.watchlist_items = older;
  tabRead.release(); await within(tp); await settle(); app.store.watchlist_items = now;  // the old-epoch tab read completes
  assert.strictEqual(app.get('tabData').truecrime, tabBefore, 'the old-epoch tab read did not publish');
  assert.ok(!/Refreshed\./.test(notice(app)), 'and did not complete the refresh');
  again.release(); await settle(); await settle();
  assert.strictEqual(pageRow(app, f.legacy.id).title, 'Restored Title', 'the new-epoch read published');
  assert.match(notice(app), /Refreshed\./);
});

test('round 3: replacement A pending, then a newer replacement B succeeds — A doesn’t block completion and later neither publishes nor changes the notice', async () => {
  const { app, f } = await boot();
  const ownShows = app.hold(showsGet);
  const x = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  x.g.release(); assert.ok(await within(ownShows.reached)); await settle();
  const a = app.hold(showsGet);
  const ap = app.run('loadTvShows("truecrime")');
  assert.ok(await within(a.reached));
  const older = JSON.parse(JSON.stringify(app.store.tv_shows));
  ownShows.release(); await within(x.p); await settle();                              // the refresh's own result: A is newer and pending
  app.store.tv_shows.find(s => s.id === f.tvShow.id).status = 'complete';
  await app.run('loadTvShows("truecrime")'); await settle();                           // replacement B succeeds
  assert.strictEqual(app.get('tvShowsById').get(f.tvShow.id).status, 'complete');
  assert.match(notice(app), /Matched “Target Show”\. Refreshed\./, 'B completes it; A doesn’t block');
  older.find(s => s.id === f.tvShow.id).status = 'watching';
  await releaseWithOlder(app, a, 'tv_shows', older, ap);                              // A finishes last with older data
  assert.strictEqual(app.get('tvShowsById').get(f.tvShow.id).status, 'complete', 'A did not publish over B');
  assert.match(notice(app), /Matched “Target Show”\. Refreshed\./, 'A did not change the notice');
});

test('round 3: replacement A fails after a newer replacement B succeeded — no obsolete failure notice', async () => {
  const { app, f } = await boot();
  const ownShows = app.hold(showsGet);
  const x = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  x.g.release(); assert.ok(await within(ownShows.reached)); await settle();
  const a = app.hold(showsGet);
  const ap = app.run('loadTvShows("truecrime")').catch(() => {});
  assert.ok(await within(a.reached));
  ownShows.release(); await within(x.p); await settle();
  app.store.tv_shows.find(s => s.id === f.tvShow.id).status = 'complete';
  await app.run('loadTvShows("truecrime")'); await settle();                           // B succeeds
  a.fail(); await within(ap); await settle();                                          // then A fails
  assert.ok(!/couldn’t be refreshed/.test(notice(app)), 'no obsolete failure');
  assert.match(notice(app), /Refreshed\./);
  assert.strictEqual(app.get('tvShowsById').get(f.tvShow.id).status, 'complete');
});

test('round 3: a real loadTab stays pending (the notice too), then succeeds — "Refreshed." from it; the older own read never overwrites it', async () => {
  const { app, f } = await boot();
  const x = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  const ownRow = app.hold(rowGet(f.legacy.id));
  x.g.release(); assert.ok(await within(ownRow.reached));
  const tabRead = app.hold(tabGet);
  const tp = app.run('loadTab("truecrime")');
  assert.ok(await within(tabRead.reached));
  await settle();
  assert.match(notice(app), /Refreshing/);
  tabRead.release(); await within(tp); await settle(); await settle();
  assert.strictEqual(pageRow(app, f.legacy.id).tmdb_id, 5000, 'the tab read shows the match');
  assert.match(notice(app), /Matched “Target Show”\. Refreshed\./, 'completed by the tab read');
  const older = JSON.parse(JSON.stringify(app.store.watchlist_items));
  older.find(r => r.id === f.legacy.id).title = 'Older';
  await releaseWithOlder(app, ownRow, 'watchlist_items', older, x.p);
  assert.notStrictEqual(pageRow(app, f.legacy.id).title, 'Older', 'the older own read did not publish');
});

test('round 3: a real loadTab that fails (after the own read also failed) — the Match outcome remains, with a read-only Retry', async () => {
  const { app, f } = await boot();
  const x = await matchNotCurrent(app, f.legacy.id, 5000, 'Target Show');
  const ownRow = app.hold(rowGet(f.legacy.id));
  x.g.release(); assert.ok(await within(ownRow.reached));
  const tabRead = app.hold(tabGet);
  const tp = app.run('loadTab("truecrime")');
  assert.ok(await within(tabRead.reached));
  ownRow.fail(); await within(x.p); await settle();
  assert.match(notice(app), /Refreshing/, 'the pending tab read still owns the row');
  tabRead.fail(); await within(tp); await settle();
  assert.match(notice(app), /Matched “Target Show”, but the current data couldn’t be refreshed/);
  assert.match(notice(app), /retryMatchRefresh\(\)">Retry/);
  const before = app.requests.length;
  app.ctx.retryMatchRefresh(); await settle(); await settle();
  assert.ok(app.requests.slice(before).every(r => r.method === 'GET'), 'Retry only reads');
  assert.strictEqual(pageRow(app, f.legacy.id).tmdb_id, 5000);
  assert.match(notice(app), /Refreshed\./);
});

T.run();
