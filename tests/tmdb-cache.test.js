// Offline tests for the member's TMDB cache across devices (TC1; tmdb-cache.js, db/tc1_tmdb_cache.sql as tests/tc1-harness.js
// models it) in the whole-page harness, with the background queue on: a fresh phone showing what another device saved without
// reading TMDB; what is read again and when (in progress a day, Watched with marks 30 days, shows a week, 150 days the limit);
// conflicting writes (another device's write since, a row deleted, or deleted and made again: never replaced by an old
// response); saves through the write lane with the busy state, only while the page is idle, followed by the reread; bounded
// retries, 404s, TMDB's Retry-After honoured in full (waited for, or deferred to a later read, never early); failed saves; a
// database without the cache; the account changing mid-request; a restore holding the lane; episodes added, removed and
// renumbered keeping every mark; and nothing ever marking a season watched.
// Run from the repo root: node tests/tmdb-cache.test.js
const assert = require('assert');
const { createApp, runner, settle, clone } = require('./app-harness');
const TC1 = require('./tc1-harness');

const T = runner('tmdb-cache');
const test = T.test;
const TS = '2026-10-01T00:00:00+00:00';
const DAY = 24 * 60 * 60 * 1000;
let n = 0;
const uuid = p => `${p}-0000-4000-8000-${String(++n).padStart(12, '0')}`;

// Severance (TMDB 95396, made-up episode ids): Season 1 watched with a mark, Season 2 in progress, Season 3 untouched; ZZ Other
// (TMDB 95397) has no marks; a show without a TMDB id has nothing to read.
function library() {
  const show = (title, key, tmdbId, status) => ({ id: uuid('5a000000'), collection: 'othertv', title, show_key: key, tmdb_id: tmdbId, status, created_at: TS });
  const sev = show('Severance', 'severance', 95396, 'confirmed'), other = show('ZZ Other', 'zz-other', 95397, 'confirmed'), loc = show('ZZ Local', 'zz-local', null, 'confirmed');
  const season = (sh, num, o = {}) => ({ id: uuid('5b000000'), collection: 'othertv', title: sh.title, theme: 'Apple TV', status: 'confirmed', watched: false, skipped: false,
    show_id: sh.id, media_type: sh.tmdb_id ? 'tv' : null, tmdb_id: sh.tmdb_id, season_number: sh.tmdb_id ? num : null, season: `Season ${num}`,
    display_date: 'Jan 1, 2022', date_sort: `202${num}-01-01`, item_key: `${sh.show_key}|season ${num}`, watch_with: [], collections: [], created_at: TS,
    tmdb_collection_id: null, tmdb_collection_name: null, ...o });
  const s1 = season(sev, 1, { watched: true }), s2 = season(sev, 2), s3 = season(sev, 3), o1 = season(other, 1), l1 = season(loc, 1);
  return { sev, other, loc, s1, s2, s3, o1, l1, rows: [s1, s2, s3, o1, l1], shows: [sev, other, loc] };
}
const mark = (season, id, num) => ({ id: uuid('0f000000'), season_id: season.id, tmdb_episode_id: id, episode_number: num });
const E = (id, num, name = `Title ${num}`) => ({ id, episode_number: num, name, air_date: '2025-01-0' + Math.min(num, 9) });
const S2 = [E(9001, 1), E(9002, 2), E(9003, 3)], S1 = [E(8001, 1), E(8002, 2)];
// (Season counts left out where a test needs a season with marks and no known total.)
const NO_COUNTS = { 95396: { id: 95396, vote_average: 8.4, vote_count: 2400, first_air_date: '2022-02-18', seasons: [] }, 95397: { id: 95397, vote_average: 6.9, vote_count: 80, seasons: [] } };
const SHOWS = { 95396: { id: 95396, vote_average: 8.4, vote_count: 2400, first_air_date: '2022-02-18', seasons: [{ season_number: 1, episode_count: 2 }, { season_number: 2, episode_count: 3 }] },
  95397: { id: 95397, vote_average: 6.9, vote_count: 80, first_air_date: '2019-01-01', seasons: [] } };
// TMDB: o.seasons ({ "<show>:<season>": episodes }), o.shows (details by id); o.hook(path) runs first (and may return an answer).
const tmdbOf = (o = {}) => p => {
  if (o.hook) { const v = o.hook(p); if (v !== undefined) return v; }
  let m = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(p);
  if (m) { const eps = (o.seasons || { '95396:2': S2, '95396:1': S1 })[`${m[1]}:${m[2]}`]; return eps ? { id: 1, episodes: eps } : undefined; }
  m = /^\/tv\/(\d+)$/.exec(p);
  return m ? (o.shows || SHOWS)[m[1]] : undefined;
};
async function boot(o = {}) {
  const lib = o.lib || library();
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows, tmdb: tmdbOf(o), episodeMarks: (o.marks || (l => [mark(l.s1, 8001, 1), mark(l.s2, 9001, 1)]))(lib),
    tmdbCache: o.cache === undefined ? [] : o.cache, tmdbQueue: 'manual', width: 1200, ...(o.extra || {}) });
  if (o.clock != null) app.clock = o.clock;
  if (o.before) o.before(app);
  app.run('tmdbQueueEnabled = true');
  app.ctx.switchView('alltv'); await drain();
  app.ctx.toggleDerivedShow(lib.sev.id); await drain();
  return { app, lib };
}
const drain = () => settle(400);
const text = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|’/g, '’').replace(/\s+/g, ' ');
const html = app => app.el('tbody').innerHTML + app.el('cardList').innerHTML;
const seasonRow = (app, r) => (app.el('tbody').innerHTML.match(new RegExp(`<tr[^>]*data-season-row="${r.id}"[\\s\\S]*?</tr>`)) || [''])[0];
const tmdbReads = app => app.requests.filter(r => r.url.startsWith('https://api.themoviedb.org/3/')).map(r => r.url.slice('https://api.themoviedb.org/3'.length));
const puts = app => app.requests.filter(r => r.url.endsWith('/rpc/library_tmdb_cache_put'));
const putKeys = app => puts(app).flatMap(r => r.body.p_rows.map(x => `${x.kind}:${x.tmdb_id}:${x.season_number}@${x.base_rev}`));
const libraryWrites = app => app.writes().filter(r => !r.url.endsWith('/rpc/library_tmdb_cache_put'));
const rowOf = (app, kind, id, num) => app.store.tmdb_tv_cache.find(r => r.kind === kind && r.tmdb_id === id && r.season_number === (kind === 'show' ? -1 : num));
const ago = ms => new Date(Date.now() - ms).toISOString();

test('a fresh phone: what the desktop saved shows at once (N/T, next episode, Mark E2, the rating), without reading TMDB', async () => {
  const desk = await boot();
  assert.deepStrictEqual(tmdbReads(desk.app).sort(), ['/tv/95396', '/tv/95396/season/1', '/tv/95396/season/2', '/tv/95397'],
    'the desktop reads what it lacks: the marked seasons’ lists and every TMDB-matched show; nothing for an unmarked season or an unmatched show');
  assert.deepStrictEqual(putKeys(desk.app).sort(), ['season:95396:1@0', 'season:95396:2@0', 'show:95396:-1@0', 'show:95397:-1@0'], 'saved as new rows');
  assert.deepStrictEqual(rowOf(desk.app, 'season', 95396, 2).data, { ids: [9001, 9002, 9003], numbers: [1, 2, 3], names: ['Title 1', 'Title 2', 'Title 3'], last: { type: null, air: '2025-01-03' } });
  assert.deepStrictEqual(rowOf(desk.app, 'show', 95396).data, { a: 8.4, c: 2400, f: '2022-02-18' });
  assert.deepStrictEqual(libraryWrites(desk.app), [], 'no library change: no mark, no Watched');
  // The phone: the same account, a new browser (nothing stored here), TMDB never answering.
  const phone = await boot({ cache: clone(desk.app.store.tmdb_tv_cache), hook: () => { throw new Error('TMDB should not be read'); } });
  assert.deepStrictEqual(tmdbReads(phone.app), [], 'nothing is read from TMDB');
  const row = text(seasonRow(phone.app, phone.lib.s2));
  assert.match(row, /1\/3 episodes watched/);
  assert.match(row, /Next unwatched: E2/);
  assert.match(seasonRow(phone.app, phone.lib.s2), />Mark E2 watched</);
  assert.match(html(phone.app), /data-action="rating"[^>]*>8\.4<\/button>/);
  assert.deepStrictEqual(phone.app.writes(), [], 'and nothing is written');
});

test('while a list is still being read the row says so; marks show throughout; a season TMDB has no list for says it is unavailable for now', async () => {
  const lib = library();
  const gate = { app: null };
  const { app } = await boot({ lib, shows: NO_COUNTS, before: a => { gate.app = a; gate.held = a.hold(r => r.url.endsWith('/tv/95396/season/2')); } });
  assert.match(text(seasonRow(app, lib.s2)), /1 episode marked · loading the episode list/);
  gate.held.release(); await drain();
  assert.match(text(seasonRow(app, lib.s2)), /1\/3 episodes watched/);
  const b = await boot({ shows: NO_COUNTS, seasons: { '95396:1': S1 } });
  assert.match(text(seasonRow(b.app, b.lib.s2)), /1 episode marked · episode list unavailable for now/, 'a 404: not asked again on this load');
  assert.strictEqual(tmdbReads(b.app).filter(p => p === '/tv/95396/season/2').length, 1);
});

test('what is read again: an in-progress list a day old, a Watched season’s list 30 days old, a show a week old; rows past 150 days are ignored', async () => {
  const cache = [
    TC1.seasonCache(95396, 2, [9001, 9002], null, null, ago(DAY + 60000)), // in progress, a day old: read again
    TC1.seasonCache(95396, 1, [8001, 8002], null, null, ago(29 * DAY)), // Watched, 29 days: kept
    TC1.showCache(95396, 8.0, 900, '2022-02-18', ago(6 * DAY)), // 6 days: kept
    TC1.showCache(95397, 6.0, 50, null, ago(160 * DAY)) // past the limit: ignored (not shown) and read
  ];
  const { app, lib } = await boot({ cache });
  assert.deepStrictEqual(tmdbReads(app).sort(), ['/tv/95396/season/2', '/tv/95397']);
  assert.deepStrictEqual(putKeys(app).sort(), [`season:95396:2@${cache[0].rev}`, `show:95397:-1@${cache[3].rev}`], 'each saved over the revision the page held');
  assert.match(text(seasonRow(app, lib.s2)), /1\/3 episodes watched/, 'the new list');
  const fresh = await boot({ cache: [TC1.seasonCache(95396, 2, [9001, 9002, 9003], [1, 2, 3], null, ago(DAY - 60000)), TC1.seasonCache(95396, 1, [8001, 8002], null, null, ago(31 * DAY)),
    TC1.showCache(95396, 8.0, 900, null, ago(8 * DAY)), TC1.showCache(95397, 6.0, 50, null, ago(DAY))] });
  assert.deepStrictEqual(tmdbReads(fresh.app).sort(), ['/tv/95396', '/tv/95396/season/1'], 'a list under a day stays; 31 days and 8 days are read');
});

test('another device saved since this page read the row: the page’s older write is ignored and the newer row stands, shown after the reread', async () => {
  const cache = [TC1.seasonCache(95396, 2, [9001], [1], null, ago(2 * DAY)), TC1.showCache(95396, 8.0, 900, null, ago(DAY)), TC1.showCache(95397, 6, 50, null, ago(DAY)),
    TC1.seasonCache(95396, 1, [8001, 8002], null, null, ago(DAY))];
  const box = {};
  const { app, lib } = await boot({ cache, before: a => { box.app = a; }, hook: p => {
    // While this page's request is out, the phone saves a newer list (a new revision).
    if (p === '/tv/95396/season/2') { const r = box.app.store.tmdb_tv_cache.find(x => x.kind === 'season' && x.tmdb_id === 95396 && x.season_number === 2);
      Object.assign(r, { data: { ids: [9001, 9002, 9003, 9005], numbers: [1, 2, 3, 4], names: ['', '', '', ''], last: null }, rev: r.rev + 50000, fetched_at: new Date().toISOString() }); }
  } });
  const r = rowOf(app, 'season', 95396, 2);
  assert.deepStrictEqual(r.data.ids, [9001, 9002, 9003, 9005], 'the other device’s row stands');
  assert.strictEqual(putKeys(app)[0], `season:95396:2@${cache[0].rev}`, 'the page wrote against the revision it held before asking TMDB');
  assert.match(text(seasonRow(app, lib.s2)), /1\/4 episodes watched/, 'the page shows the stored row');
});

test('a row deleted, or deleted and made again, while a request is out: the old response never overwrites the replacement', async () => {
  const mk = () => [TC1.seasonCache(95396, 2, [9001], [1], null, ago(2 * DAY)), TC1.showCache(95396, 8.0, 900, null, ago(DAY)), TC1.showCache(95397, 6, 50, null, ago(DAY)),
    TC1.seasonCache(95396, 1, [8001, 8002], null, null, ago(DAY))];
  {
    const cache = mk(), box = {};
    const { app } = await boot({ cache, before: a => { box.app = a; }, hook: p => {
      if (p === '/tv/95396/season/2') box.app.store.tmdb_tv_cache = box.app.store.tmdb_tv_cache.filter(x => !(x.kind === 'season' && x.season_number === 2)); // purged
    } });
    assert.deepStrictEqual(putKeys(app).filter(k => k.startsWith('season:95396:2')), [`season:95396:2@${cache[0].rev}`, 'season:95396:2@0'], 'refused (no row), then saved once as a new row');
    assert.deepStrictEqual(rowOf(app, 'season', 95396, 2).data.ids, [9001, 9002, 9003]);
  }
  {
    const cache = mk(), box = {};
    const { app } = await boot({ cache, before: a => { box.app = a; }, hook: p => {
      if (p !== '/tv/95396/season/2') return undefined;
      // Purged and made again by another device: the same key, a revision never used before.
      box.app.store.tmdb_tv_cache = box.app.store.tmdb_tv_cache.filter(x => !(x.kind === 'season' && x.season_number === 2));
      box.app.store.tmdb_tv_cache.push(TC1.seasonCache(95396, 2, [9001, 9002, 9003, 9004], [1, 2, 3, 4]));
      return undefined;
    } });
    const r = rowOf(app, 'season', 95396, 2);
    assert.deepStrictEqual(r.data.ids, [9001, 9002, 9003, 9004], 'the replacement stands');
    assert.ok(r.rev !== cache[0].rev, 'with its own revision');
    assert.strictEqual(putKeys(app).filter(k => k.startsWith('season:95396:2')).length, 1, 'one refused write, nothing resent');
  }
});

test('saves go through the write lane with the busy state, wait while the page is in use, and end with the reread', async () => {
  const lib = library();
  const box = {};
  const { app } = await boot({ lib, clock: Date.now(), before: a => { box.app = a; a.run('tmdbLastInput = tmdbNow()'); box.held = a.hold(r => r.url.endsWith('/rpc/library_tmdb_cache_put')); } });
  assert.ok(app.delays.filter(d => d === 1000).length >= 3, 'it waited (a second at a time) until the page had been idle for three seconds');
  await box.held.reached;
  assert.strictEqual(app.get('writeLane && writeLane.label'), 'The TMDB update', 'the lane is held');
  assert.strictEqual(app.el('tbody').attrs['aria-busy'], 'true', 'the list is marked busy');
  const before = app.requests.length;
  box.held.release(); await drain();
  assert.strictEqual(app.get('writeLane'), null);
  assert.ok(app.requests.slice(before).some(r => r.url.includes('/rest/v1/tmdb_tv_cache?')), 'the open view is read again');
  assert.ok(!app.requests.some(r => /pending_write/.test(JSON.stringify(r.body || ''))));
  // A change the member makes while a save holds the lane is refused like any other, nothing sent.
  const c = await boot({ lib: library(), before: a => { box.c = a.hold(r => r.url.endsWith('/rpc/library_tmdb_cache_put')); } });
  await box.c.reached;
  const sent = c.app.writes().length;
  await c.app.ctx.setSeasonSkipped(c.lib.s3.id, true); await settle();
  assert.strictEqual(c.app.writes().length, sent, 'nothing else was sent');
  assert.match(c.app.el('errorBanner').innerHTML, /The TMDB update is still being saved\. Nothing else was changed/);
  box.c.release(); await drain();
});

test('a dialog open or a text box focused postpones the save; closing it lets it run', async () => {
  const box = {};
  const { app } = await boot({ clock: Date.now(), before: a => { a.run('cuModal = { kind: "zz" }'); box.app = a; } });
  assert.strictEqual(puts(app).length, 0, 'nothing saved while a dialog is open');
  assert.ok(app.delays.length > 10);
  app.run('cuModal = null'); await drain();
  assert.ok(puts(app).length >= 1, 'saved once it closed');
});

test('TMDB’s Retry-After: a short one is waited for in full; a long one stops the queue until a later read after that time, never earlier', async () => {
  const seen = [], box = {};
  const short = await boot({ clock: Date.now(), before: a => { box.a = a; }, hook: p => {
    if (p !== '/tv/95396/season/2') return undefined;
    seen.push(box.a.clock);
    return seen.length === 1 ? { __status: 429, __headers: { 'retry-after': '7' } } : undefined;
  } });
  assert.ok(seen.length === 2 && seen[1] - seen[0] >= 7000, `asked again only after the full 7 seconds (${seen[1] - seen[0]} ms)`);
  assert.strictEqual(tmdbReads(short.app).filter(p => p === '/tv/95396/season/2').length, 2, 'then asked again');
  assert.match(text(seasonRow(short.app, short.lib.s2)), /1\/3 episodes watched/);
  // 120 seconds: more than the queue waits for. It stops, and a later read resumes it; it never asks before the interval ends.
  let hit = 0;
  const t0 = Date.now(), at = [], lb = {};
  const long = await boot({ clock: t0, before: a => { lb.a = a; }, hook: p => {
    if (p !== '/tv/95396/season/2') return undefined;
    at.push(lb.a.clock - t0);
    return hit++ === 0 ? { __status: 429, __headers: { 'retry-after': '120' } } : undefined;
  } });
  assert.deepStrictEqual(at.length, 1);
  assert.ok(!long.app.delays.some(d => d > 60000), 'it doesn’t sit waiting longer than a minute');
  const total = tmdbReads(long.app).length;
  long.app.clock = t0 + 30000; long.app.run('loadDerivedView()'); await drain();
  assert.strictEqual(tmdbReads(long.app).length, total, `a read 30 seconds later sends nothing to TMDB (90 seconds still to wait): ${tmdbReads(long.app)}`);
  long.app.clock = t0 + 121000; long.app.run('loadDerivedView()'); await drain();
  assert.strictEqual(at.length, 2, 'a read after the interval resumes it');
  assert.ok(at[1] >= 120000, `never before the full interval (${at[1]} ms)`);
  assert.match(text(seasonRow(long.app, long.lib.s2)), /1\/3 episodes watched/);
  // With a minute or less left, a later read waits out the rest, then asks.
  let hit2 = 0;
  const at2 = [], lb2 = {};
  const mid = await boot({ clock: t0, before: a => { lb2.a = a; }, hook: p => {
    if (p !== '/tv/95396/season/2') return undefined;
    at2.push(lb2.a.clock - t0);
    return hit2++ === 0 ? { __status: 429, __headers: { 'retry-after': '120' } } : undefined;
  } });
  mid.app.clock = t0 + 70000; mid.app.run('loadDerivedView()'); await drain();
  assert.ok(at2.length === 2 && at2[1] >= 120000, `waited the remaining time in full (${at2[1]} ms)`);
  // Three pauses are allowed per load; a fourth stops the queue.
  const always = await boot({ clock: Date.now(), hook: () => ({ __status: 429, __headers: { 'retry-after': '2' } }) });
  assert.ok(tmdbReads(always.app).length <= 4 * 4, 'bounded');
  const n1 = tmdbReads(always.app).length;
  always.app.clock += 10 * 60000; always.app.run('loadDerivedView()'); await drain();
  assert.strictEqual(tmdbReads(always.app).length, n1, 'stopped for this load');
});

test('failures are bounded: two tries per item, the second at least 30 seconds later; five failures in a row stop the queue for this load', async () => {
  const t0 = Date.now();
  const { app, lib } = await boot({ clock: t0, shows: NO_COUNTS, hook: p => (p === '/tv/95396/season/2' ? { __status: 500 } : undefined) });
  assert.strictEqual(tmdbReads(app).filter(p => p === '/tv/95396/season/2').length, 1, 'one try so far');
  assert.match(text(seasonRow(app, lib.s2)), /1 episode marked · loading the episode list/, 'still to be tried');
  app.clock = t0 + 31000; app.run('kickTmdbQueue()'); await drain();
  assert.strictEqual(tmdbReads(app).filter(p => p === '/tv/95396/season/2').length, 2, 'the second try');
  app.clock = t0 + 120000; app.run('loadDerivedView()'); await drain();
  assert.strictEqual(tmdbReads(app).filter(p => p === '/tv/95396/season/2').length, 2, 'never a third on this load');
  assert.match(text(seasonRow(app, lib.s2)), /1 episode marked · episode list unavailable for now/);
  // Everything failing: five in a row, then nothing more.
  const down = await boot({ clock: t0, hook: () => { throw new Error('offline'); } });
  assert.strictEqual(tmdbReads(down.app).length, 4, 'the first batch (four items)');
  down.app.clock = t0 + 40000; down.app.run('loadDerivedView()'); await drain();
  assert.strictEqual(tmdbReads(down.app).length, 5, 'the fifth failure in a row stops it');
  down.app.clock = t0 + 400000; down.app.run('loadDerivedView()'); await drain();
  assert.strictEqual(tmdbReads(down.app).length, 5);
  assert.match(text(seasonRow(down.app, down.lib.s2)), /1 episode marked/, 'saved marks show throughout');
  assert.deepStrictEqual(down.app.writes(), []);
});

test('a save that fails keeps the readings on this page; two failed saves stop saving for this load; no unknown-outcome note is left', async () => {
  const storage = { m: new Map(), getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }, setItem(k, v) { this.m.set(k, String(v)); }, removeItem(k) { this.m.delete(k); } };
  const box = {};
  const { app, lib } = await boot({ extra: { storage }, before: a => { a.failNext(r => r.url.endsWith('/rpc/library_tmdb_cache_put')); a.failNext(r => r.url.endsWith('/rpc/library_tmdb_cache_put')); box.app = a; } });
  assert.strictEqual(puts(app).length, 2);
  assert.strictEqual(app.store.tmdb_tv_cache.length, 0);
  assert.match(text(seasonRow(app, lib.s2)), /1\/3 episodes watched/, 'shown from this page’s readings');
  assert.ok(![...storage.m.keys()].some(k => k.startsWith('watchlist_pending_write:')), 'no pending-write note');
  app.run('loadDerivedView()'); await drain();
  assert.strictEqual(puts(app).length, 2, 'no more saves on this load');
});

test('a database without the cache (before the migration): nothing is saved; the readings show on this page', async () => {
  const { app, lib } = await boot({ cache: false });
  assert.strictEqual(puts(app).length, 0);
  assert.match(text(seasonRow(app, lib.s2)), /1\/3 episodes watched/);
  assert.match(html(app), /data-action="rating"[^>]*>8\.4<\/button>/);
  assert.deepStrictEqual(app.consoleErrors, []);
});

test('the account changing while a request is out: its answer is dropped and nothing is saved for either account', async () => {
  const box = {};
  const { app } = await boot({ before: a => { box.held = a.hold(r => r.url.endsWith('/tv/95396/season/2')); } });
  await box.held.reached;
  app.run(`pageUser = { id: '0a000000-0000-4000-8000-0000000000bb', email: 'x' }`);
  box.held.release(); await drain();
  assert.ok(!putKeys(app).some(k => k.startsWith('season:95396:2')), 'the list read for the first account isn’t saved');
});

test('a restore holding the lane: saves wait for it; the cache is untouched by the restore', async () => {
  const box = {};
  const { app } = await boot({ before: a => { a.run(`__laneHold = beginWrite('Restore')`); box.app = a; } });
  assert.strictEqual(puts(app).length, 0, 'nothing saved while the restore holds the lane');
  app.run('endWrite(__laneHold)'); app.run('kickTmdbQueue()'); await drain();
  assert.ok(puts(app).length >= 1);
});

test('episodes added, removed and renumbered: every mark is kept by episode id, the next episode follows the new list, nothing is marked watched', async () => {
  const cache = [TC1.seasonCache(95396, 2, [9001, 9002, 9003], [1, 2, 3], ['', '', ''], ago(2 * DAY))];
  // TMDB now: 9002 renumbered to E1, 9001 removed, 9004 added as E2; 9003 removed.
  const { app, lib } = await boot({ cache, marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9002, 2), mark(l.s1, 8001, 1)],
    seasons: { '95396:2': [E(9002, 1), E(9004, 2)], '95396:1': S1 } });
  const row = text(seasonRow(app, lib.s2));
  assert.match(row, /1\/2 episodes watched · 1 not listed/, 'the kept mark for a removed episode is shown apart');
  assert.match(row, /Next unwatched: E2/);
  assert.deepStrictEqual(libraryWrites(app), [], 'no mark changed, no Watched set');
  assert.strictEqual(app.store.episode_marks.filter(m => m.season_id === lib.s2.id).length, 2);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s2.id).watched, false);
  // Every listed episode marked: offered, never applied.
  const all = await boot({ marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9002, 2), mark(l.s2, 9003, 3), mark(l.s1, 8001, 1)] });
  assert.deepStrictEqual(libraryWrites(all.app), []);
  assert.strictEqual(all.app.store.watchlist_items.find(r => r.id === all.lib.s2.id).watched, false);
});

test('a preview of a show not in the library is shown but not saved; an answer without a known request isn’t saved', async () => {
  const { app } = await boot();
  const before = puts(app).length;
  app.run(`noteTmdbData(tmdbShowKey(424242), { a: 7, c: 100, f: null }, '0', false); noteShowRating(434343, { vote_average: 7, vote_count: 100 }); kickTmdbQueue()`);
  await drain();
  assert.ok(!putKeys(app).slice(before).some(k => /424242|434343/.test(k)));
});

test('a very long season (several hundred episodes) is saved without its titles, or kept on the page if still too long; the other rows are saved', async () => {
  const many = n => Array.from({ length: n }, (_, i) => E(500000 + i, i + 1, `A fairly ordinary episode title number ${i + 1}`));
  const { app, lib } = await boot({ seasons: { '95396:2': many(900), '95396:1': S1 } });
  const r = rowOf(app, 'season', 95396, 2);
  assert.ok(r && r.data.ids.length === 900 && r.data.names.length === 0, 'saved, without titles');
  assert.match(text(seasonRow(app, lib.s2)), /0\/900 episodes watched · 1 not listed/);
  assert.ok(rowOf(app, 'show', 95396) && rowOf(app, 'season', 95396, 1), 'the rest of the batch is saved');
  const huge = await boot({ seasons: { '95396:2': many(4000), '95396:1': S1 } });
  assert.ok(!rowOf(huge.app, 'season', 95396, 2), 'too long even without titles: not sent');
  assert.ok(rowOf(huge.app, 'show', 95396) && rowOf(huge.app, 'season', 95396, 1), 'and nothing else is held up');
  assert.match(text(seasonRow(huge.app, huge.lib.s2)), /0\/4000 episodes watched · 1 not listed/, 'shown from this page');
  assert.ok(!huge.app.get('tmdbQueue.savingStopped'));
});

test('a batch the database refuses isn’t sent again, so later saves still run', async () => {
  const { app } = await boot({ before: a => a.refuseNext(r => r.url.endsWith('/rpc/library_tmdb_cache_put'), '22023', 'invalid_input: cache rows') });
  assert.strictEqual(puts(app).length, 1);
  app.run(`noteShowRating(95396, Object.assign({ vote_average: 9, vote_count: 3000 }, {}))`);
  app.run(`tmdbCacheFresh.get('show:95396').base = '0'; tmdbQueue.unsaved.add('show:95396'); kickTmdbQueue()`); await drain();
  assert.strictEqual(puts(app).length, 2, 'a later save is sent');
  assert.ok(rowOf(app, 'show', 95396));
});

test('Add to queue, a queue drag, Match, a restore preview, a games dialog or the Games view count as the page in use', async () => {
  const { app } = await boot();
  assert.strictEqual(app.run('tmdbPageIdle()'), true, 'idle to begin with');
  for (const [set, clear] of [['queueAdd = {}', 'queueAdd = null'], ['queueDrag = {}', 'queueDrag = null'], ['window.__tmdbMatch = {}', 'window.__tmdbMatch = null'],
    ['pendingRestoreData = {}', 'pendingRestoreData = null'], ['gamesCollectionAdd = {}', 'gamesCollectionAdd = null'], ['gamesAdd = {}', 'gamesAdd = null'],
    ["activeViewId = 'games'", "activeViewId = 'alltv'"]]) {
    app.run(set);
    assert.strictEqual(app.run('tmdbPageIdle()'), false, set);
    app.run(clear);
  }
  assert.strictEqual(app.run('tmdbPageIdle()'), true);
  // A games Details or Review dialog opened once (its opener is kept after it closes) doesn't hold saves back afterwards.
  app.run('gamesDetailsOpener = {}; gamesReviewOpener = {}');
  assert.strictEqual(app.run('tmdbPageIdle()'), true, 'outside Games, a closed games dialog doesn’t count');
});

test('a 429 without a readable Retry-After counts as a long wait: deferred to a later read, never retried sooner', async () => {
  const t0 = Date.now(), at = [], box = {};
  let hit = 0;
  const { app } = await boot({ clock: t0, before: a => { box.a = a; }, hook: p => {
    if (p !== '/tv/95396/season/2') return undefined;
    at.push(box.a.clock - t0);
    return hit++ === 0 ? { __status: 429 } : undefined;
  } });
  app.clock = t0 + 50000; app.run('loadDerivedView()'); await drain();
  assert.strictEqual(at.length, 1, 'not asked again 50 seconds later');
  app.clock = t0 + 125000; app.run('loadDerivedView()'); await drain();
  assert.ok(at.length === 2 && at[1] >= 120000);
});

T.run();
