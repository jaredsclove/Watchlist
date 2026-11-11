// Offline tests for games (G1, next-gen item 5; games-data.js, games.js, queues.js) in the whole-page harness: the Games area
// and its routes, Settings → Games (platforms, read at sign-in, saved with expected values; game length removed 2026-11-10), platform lines
// (native, "PS4 · Playable on PS5", Sony's PS4-only list, betas and patches left out), the release rule (a full date passing
// on a selected platform, partial dates and TBA staying under Coming, Not out yet held only while IGDB's row is unchanged),
// hiding games outside the selection, followed franchises (Up next, Caught up, Coming; versions sharing a spot; Skipped
// versions; Skip this spot; spin-offs counted by choice; a native edition coming after a finished PS4 version), + Add game
// (IGDB through the function; saving follows nothing; following saves nothing), mixed queues with hidden games keeping their
// places (the worked example), Finished leaving queues, collections, genre filter and sort, Refresh (new titles under Coming,
// joined ports, nothing added), review, and backups (format 9 without the IGDB cache; a restore shows saved games with IGDB
// unavailable). The database's rules are modelled in tests/g1-harness.js; the real ones are tested by tools/g1-test.mjs.
// Synthetic data only ("ZZ …", made-up IGDB ids). Run from the repo root: node tests/games.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');
const { makeMiniDom } = require('./mini-dom');

const T = runner('games');
const test = T.test;
const DAY = 86400000;
const day = off => { const d = new Date(Date.now() + off * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const unix = s => Math.floor(Date.parse(`${s}T12:00:00Z`) / 1000);
const ID = (p, k) => `${p}-0000-4000-8000-${String(k).padStart(12, '0')}`;
const TS = '2026-11-01T00:00:00+00:00';

// ── IGDB, as the function answers (raw games, references as ids) ──
const PS5 = 167, PS4 = 48, SWITCH = 130, PS3 = 9, FULL = 6, PATCH = 36, BETA = 2, WW = 8;
const rd = (platform, date, o = {}) => ({ platform, date: date ? unix(date) : null, date_format: date ? 0 : 7, status: FULL, release_region: WW, ...o });
const RAW = {
  101: { id: 101, name: 'ZZ War 4', game_type: 0, first_release_date: unix('2007-11-05'), remasters: [102], ports: [103], collections: [{ id: 7001, name: 'ZZ War' }], release_dates: [rd(PS3, '2007-11-05')] },
  102: { id: 102, name: 'ZZ War 4 Remastered', game_type: 9, parent_game: 101, first_release_date: unix('2016-11-04'), collections: [{ id: 7001, name: 'ZZ War' }], release_dates: [rd(PS4, '2016-11-04'), rd(PS4, '2016-10-05', { status: 34 })], aggregated_rating: 86.9, aggregated_rating_count: 9, rating: 78.3, rating_count: 258, genres: [{ name: 'Shooter' }] },
  103: { id: 103, name: 'ZZ War 4 Handheld', game_type: 11, parent_game: 101, first_release_date: unix('2009-11-10'), release_dates: [] },
  110: { id: 110, name: 'ZZ War (2019)', game_type: 0, first_release_date: unix('2019-10-25'), collections: [{ id: 7001, name: 'ZZ War' }], release_dates: [rd(PS4, '2019-10-25'), rd(PS5, '2021-06-17', { status: PATCH })], aggregated_rating: 80.1, aggregated_rating_count: 11, rating: 79.6, rating_count: 476, genres: [{ name: 'Shooter' }] },
  120: { id: 120, name: 'ZZ War Next', game_type: 0, collections: [{ id: 7001, name: 'ZZ War' }], release_dates: [rd(PS5, null)] },
  130: { id: 130, name: 'ZZ War Pocket', game_type: 0, first_release_date: unix('2015-01-01'), collections: [{ id: 7001, name: 'ZZ War' }], release_dates: [rd(PS4, '2015-01-01')] },
  140: { id: 140, name: 'ZZ Shooter', game_type: 0, first_release_date: unix(day(-18)), release_dates: [rd(PS5, day(-18)), rd(PS5, day(-40), { status: BETA })], genres: [{ name: 'Shooter' }], aggregated_rating: 65, aggregated_rating_count: 4, rating: 40, rating_count: 72 },
  150: { id: 150, name: 'ZZ Switch Game', game_type: 0, first_release_date: unix('2020-03-01'), release_dates: [rd(SWITCH, '2020-03-01')], genres: [{ name: 'Puzzle' }] },
  160: { id: 160, name: 'Shadwen', game_type: 0, first_release_date: unix('2016-05-01'), release_dates: [rd(PS4, '2016-05-01')] },
  170: { id: 170, name: 'ZZ Saga One', game_type: 0, first_release_date: unix('2018-02-02'), collections: [{ id: 7002, name: 'ZZ Saga' }], release_dates: [rd(PS4, '2018-02-02'), { platform: PS5, date: unix('2027-01-01'), date_format: 2, y: 2027, status: FULL, release_region: WW }] },
  180: { id: 180, name: 'ZZ Astro', game_type: 0, first_release_date: unix('2024-09-06'), release_dates: [rd(PS5, '2024-09-06')], genres: [{ name: 'Platform' }] },
  200: { id: 200, name: 'ZZ The Extremely Long Chronicle of the Northern Lighthouse Keepers: Definitive Director’s Cut', game_type: 0, release_dates: [rd(PS5, day(40))],
    genres: ['Adventure', 'Role-playing (RPG)', 'Strategy', 'Simulator', 'Indie'].map(name => ({ name })) },
  190: { id: 190, name: 'ZZ Month Past', game_type: 0, release_dates: [{ platform: PS5, date: unix('2026-01-01'), date_format: 1, y: 2026, m: 1, status: FULL, release_region: WW }] }
};
const TTB = { 110: { game_id: 110, hastily: 11.9 * 3600, normally: 7.2 * 3600, completely: 15 * 3600, count: 12 }, 140: { game_id: 140, hastily: 3468 * 3600, normally: 1758 * 3600, completely: 205 * 3600, count: 9 },
  102: { game_id: 102, hastily: 6 * 3600, normally: 6.4 * 3600, completely: 16.5 * 3600, count: 5 }, 180: { game_id: 180, hastily: 12 * 3600, normally: 18 * 3600, completely: 30 * 3600, count: 20 } };
const MEMBERS = { 7001: [[101, 1], [102, 1], [110, 1], [120, 1], [130, 2]], 7002: [[170, 1]] };
// The igdb function's answers (games.js asks for records by id, searches, memberships and time to beat).
function igdbStub(raw = RAW, members = MEMBERS) {
  const calls = [];
  const fn = queries => { calls.push(queries); return queries.map(q => {
    const ids = (q.body.match(/where (?:id|game_id) = \(([^)]*)\)/) || [])[1];
    const list = ids ? ids.split(',').map(Number) : [];
    if (q.endpoint === 'games' && /^search/.test(q.body)) { const term = q.body.match(/search "([^"]*)"/)[1].toLowerCase(); return { name: q.name, data: Object.values(raw).filter(g => g.name.toLowerCase().includes(term)) }; }
    if (q.endpoint === 'games') return { name: q.name, data: list.map(id => raw[id]).filter(Boolean) };
    if (q.endpoint === 'game_time_to_beats') throw new Error('harness: time to beat is no longer read');
    if (q.endpoint === 'collection_memberships') { const c = Number(q.body.match(/collection = (\d+)/)[1]); return { name: q.name, data: (members[c] || []).map(([game, type]) => ({ game, type })) }; }
    return { name: q.name, data: [] };
  }); };
  fn.calls = calls;
  return fn;
}

// ── The member's saved data ──
async function bootWith(opts = {}) {
  const app0 = await createApp({ storage: memoryStorage() }); // (only to reach the page's own igdbRecord)
  // (a cache written before game length was removed still carries `hours`: kept here for some records, to show it is ignored)
  const rec = (id, m = {}) => ({ ...JSON.parse(JSON.stringify(app0.ctx.igdbRecord(RAW[id]))), ...(TTB[id] ? { hours: { main: 9, main_extra: 12, completionist: 20, count: 3 } } : {}), m });
  const titles = (opts.cache || [101, 102, 103, 110, 120, 130, 140, 150, 160, 170, 180, 190]).map(id => {
    const m = {}; Object.entries(MEMBERS).forEach(([c, l]) => l.forEach(([g, t]) => { if (g === id) m[c] = t === 2 ? 'spinoff' : 'member'; }));
    return { id: ID('6f000000', id), igdb_id: id, data: rec(id, m), fetched_at: TS };
  });
  const games = { game_settings: opts.settings === null ? [] : [{ id: ID('60000000', 1), platforms: opts.platforms || ['ps5'], play_style: opts.style || 'main', updated_at: TS }],
    game_entries: opts.entries || [], game_follows: opts.follows || [], game_decisions: opts.decisions || [], game_collections: opts.collections || [], game_collection_members: opts.members || [],
    game_titles: opts.noCache ? [] : titles };
  const app = await createApp({ rows: opts.rows || [], tvShows: opts.shows || [], games, queues: opts.queues, igdb: opts.igdb === undefined ? igdbStub() : opts.igdb, storage: opts.storage || memoryStorage(), research: opts.research ?? true });
  app.dom = makeMiniDom(app, ['gamesScreen', 'queuesScreen', 'gameDialogBox', 'settingsScreen']);
  app.dom.hide('cardList');
  return app;
}
const memoryStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), get length() { return m.size; }, key: i => [...m.keys()][i] }; };
const entry = (k, igdb, o = {}) => ({ id: ID('61000000', k), igdb_id: igdb, spot_igdb_id: o.spot ?? igdb, port_ids: o.ports || [], title: RAW[igdb] ? RAW[igdb].name : `ZZ ${igdb}`, status: o.status || 'want', priority: o.priority || 'normal', created_at: TS, updated_at: TS });
const follow = (k, cid, name) => ({ id: ID('62000000', k), igdb_collection_id: cid, name, created_at: TS });
const screen = app => app.el('gamesScreen').innerHTML;
const dialog = app => app.el('gameDialogBox').innerHTML;
const text = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
// A game's desktop row, a franchise's row with its expanded rows (the table; the narrow-screen cards repeat them), the table's order.
const tableOf = app => screen(app).split('</tbody>')[0];
const rowOf = (app, id) => (tableOf(app).split('<tr class="game-row').find(x => x.includes(`data-game="${id}"`)) || '');
const franchiseOf = (app, id) => text(tableOf(app).split('<tr class="show-group-row franchise-row').find(x => x.includes(`data-follow="${id}"`)) || '');
const libraryOrder = app => [...tableOf(app).matchAll(/<tr class="game-row[^"]*" data-game="([^"]+)"/g)].map(m => m[1]);
const cardOf = (app, id) => (screen(app).split('</tbody>')[1] || '').split('<div class="item-card game-card').find(x => x.includes(`data-game="${id}"`)) || '';
const rpcs = (app, fn) => app.requests.filter(r => r.url.endsWith(`/rpc/${fn}`));
const reads = (app, table) => app.requests.filter(r => r.method === 'GET' && new RegExp(`/rest/v1/${table}\\?`).test(r.url));
async function openGames(app, view = 'games') { app.ctx.switchView(view); await settle(); }

test('the Games area: an app-bar button, its routes and three views; no list toolbar, tabs bar or Browse row', async () => {
  const app = await bootWith();
  assert.match(app.el('mediaSwitch').innerHTML, /id="areaBtn-games"[^>]*onclick="openGames\(\)">Games<\/button>/);
  app.ctx.openGames(); await settle();
  assert.strictEqual(app.get('activeArea'), 'games');
  assert.match(app.el('mediaSwitch').innerHTML, /id="areaBtn-games" aria-current="page"/);
  assert.deepStrictEqual(['games', 'gamesfranchises', 'gamescollections'].map(v => app.get(`routeOfView("${v}")`)), ['#/games', '#/games/franchises', '#/games/collections']);
  assert.strictEqual(app.get('viewOfRoute("#/games/franchises")'), 'gamesfranchises');
  // As TV: the views are the tab row; the heading is for screen readers and focus.
  assert.strictEqual(text(app.el('tabBar').innerHTML), 'Library Franchises Collections');
  assert.match(app.el('tabBar').innerHTML, /class="tab active" aria-current="page" onclick="switchView\('games'\)">Library</);
  assert.match(screen(app), /<h2 class="visually-hidden games-title" id="gamesTitle"[^>]*>Games: Library<\/h2>/);
  assert.match(text(screen(app)), /No games yet\. Use \+ Add game to search IGDB and save one\./);
  assert.deepStrictEqual(app.writes().filter(r => !/functions\/v1\/igdb/.test(r.url)).map(r => r.url), [], 'no database write (the IGDB function is a read)');
});

test('Settings → Games: read once at sign-in, so opening Settings reads nothing; saving sends what the page showed; a stale save is refused and read again', async () => {
  const app = await bootWith({ settings: null });
  assert.strictEqual(reads(app, 'game_settings').length, 1, 'read at sign-in');
  app.ctx.openSettings(null); await settle();
  const before = app.requests.length;
  app.ctx.openSettings(null); await settle();
  assert.strictEqual(app.requests.length, before, 'Settings itself reads nothing');
  const card = app.el('settingsScreen').innerHTML;
  assert.match(text(card), /My platforms PS5 PS4 Switch 2 Switch Xbox Series X\|S Xbox One PC/);
  assert.match(text(card), /PS4 · Playable on PS5/);
  assert.doesNotMatch(text(card), /play style|Main story|Completionist|length/i, 'no play style any more');
  app.ctx.document.querySelectorAll = sel => (sel === '.games-platform' ? [{ value: 'ps5', checked: true }, { value: 'switch', checked: false }] : []);
  await app.ctx.saveGamesSettings(); await settle();
  const [call] = rpcs(app, 'library_game_settings_save');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(call.body)), { p_expected: null, p_platforms: ['ps5'], p_play_style: 'main' }, 'a first save sends the legacy default');
  assert.deepStrictEqual(app.store.game_settings.map(s => [s.platforms, s.play_style]), [[['ps5'], 'main']]);
  app.store.game_settings[0].platforms = ['ps5', 'switch']; // another device changed them
  await app.ctx.saveGamesSettings(); await settle();
  assert.match(app.el('errorBanner').innerHTML, /changed since the page showed it/);
  await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.get('gamesSettingsRead.settings.platforms'))), ['ps5', 'switch'], 'read again: what is saved now');
});

test('platform lines: native PS5 per IGDB, PS4 · Playable on PS5 with the PS4 date, Sony’s PS4-only list hidden, a patch row not native, betas and advanced access left out', async () => {
  const app = await bootWith({ entries: [entry(1, 102), entry(2, 110), entry(3, 140), entry(4, 150), entry(5, 160)] });
  await openGames(app);
  assert.match(text(rowOf(app, ID('61000000', 1))), /PS4 · Playable on PS5 · Nov 4, 2016/, 'the full release, not its advanced access');
  assert.match(text(rowOf(app, ID('61000000', 2))), /PS4 · Playable on PS5 · Oct 25, 2019/, 'an optimization patch on PS5 is no native release');
  assert.match(text(rowOf(app, ID('61000000', 3))), /PS5 · [A-Z][a-z]{2} \d+, \d{4} · per IGDB/, 'a full date passed on PS5 (the beta row ignored)');
  assert.strictEqual(rowOf(app, ID('61000000', 4)), '', 'a Switch-only game is hidden with PS5 only');
  assert.strictEqual(rowOf(app, ID('61000000', 5)), '', 'a PS4 game on Sony’s PS4-only list is hidden');
  assert.match(text(screen(app)), /2 saved games aren’t on your platforms, so they are hidden here and in your queues \(their status, priority, collections and queue places are kept\)/);
  // Compact C and P beside the title; the source, scale and counts in each one's name and its tap / focus note.
  const r1 = rowOf(app, ID('61000000', 1));
  assert.match(r1, /data-gaction="rating-critic" aria-label="Critic score: 87 out of 100 · 9 critic reviews on IGDB\."[^>]*><span class="rating-k" aria-hidden="true">C<\/span>\u00a087<\/button>/, 'the critic score');
  assert.match(r1, /<span class="tmdb-rating-note note-critic" aria-hidden="true">Critic score: 87 out of 100 · 9 critic reviews on IGDB\.<\/span><span class="tmdb-rating-note note-player" aria-hidden="true">Player score: 78/, 'the notes after both scores');
  assert.match(r1, /data-gaction="rating-player" aria-label="Player score: 78 out of 100 · 258 player ratings on IGDB\."[^>]*><span class="rating-k" aria-hidden="true">P<\/span>\u00a078</, 'the player score, separate');
  assert.ok(r1.indexOf('rating-critic') < r1.indexOf('rating-player') && r1.indexOf('data-gaction="open"') < r1.indexOf('rating-critic'), 'beside the title: critics, then players');
  assert.doesNotMatch(text(screen(app)), /Estimate unreliable|Length unknown| h · IGDB|HowLongToBeat/, 'no game length anywhere (a legacy cache’s hours are ignored)');
  app.store.game_settings[0].platforms = ['ps5', 'switch'];
  await openGames(app);
  assert.match(text(rowOf(app, ID('61000000', 4))), /Switch · Mar 1, 2020 · per IGDB/, 'Switch chosen: it comes back, status kept');
  assert.strictEqual(rowOf(app, ID('61000000', 5)), '', 'still hidden: not playable on PS5');
});

test('the release rule: a month that has ended or TBA stays under Coming; Not out yet holds a release out until IGDB’s row changes; It’s out ends the hold', async () => {
  const app = await bootWith({ entries: [entry(1, 140), entry(2, 190), entry(3, 120)] });
  await openGames(app);
  assert.match(text(rowOf(app, ID('61000000', 2))), /PS5 · Jan 2026$|PS5 · Jan 2026 /, 'a month that has ended isn’t playable: no basis, shown as its month');
  assert.match(text(rowOf(app, ID('61000000', 3))), /PS5 · Date TBA/);
  const st = app.run('gamesState()');
  assert.strictEqual(app.run(`gameAvailability([gamesData.cache.get(190)], gamesState()).playable`), false);
  assert.strictEqual(app.run(`gameAvailability([gamesData.cache.get(120)], gamesState()).playable`), false);
  assert.strictEqual(app.run(`gameAvailability([gamesData.cache.get(140)], gamesState()).playable`), true);
  void st;
  await app.ctx.setNotOutYet(140, 'ps5', day(-18), 'day'); await settle();
  const [call] = rpcs(app, 'library_game_decision_set');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(call.body)), { p_kind: 'not_out_yet', p_igdb_id: 140, p_platform: 'ps5', p_expected: null, p_value: { date: day(-18), precision: 'day' } });
  assert.match(text(rowOf(app, ID('61000000', 1))), /not out yet \(your hold\)/);
  assert.strictEqual(app.run(`gameAvailability([gamesData.cache.get(140)], gamesState()).playable`), false, 'held out of Up next');
  // IGDB corrects the date: the row changed, so the hold no longer applies.
  const t = app.store.game_titles.find(x => x.igdb_id === 140);
  t.data.releases = t.data.releases.map(r => (r.s === 'full' ? { ...r, d: day(-3) } : r));
  await openGames(app);
  assert.match(text(rowOf(app, ID('61000000', 1))), /per IGDB/, 'the corrected row counts again without any action');
  t.data.releases = t.data.releases.map(r => (r.s === 'full' ? { ...r, d: day(-18) } : r));
  await openGames(app);
  assert.match(text(rowOf(app, ID('61000000', 1))), /your hold/, 'the unchanged row stays held');
  await app.ctx.clearNotOutYet(140, 'ps5'); await settle();
  assert.strictEqual(app.store.game_decisions.length, 0);
  assert.match(text(rowOf(app, ID('61000000', 1))), /per IGDB/);
});

test('a member without research access can hold a release; recording Store evidence needs research access, and confirms a release known only to the month', async () => {
  const app = await bootWith({ entries: [entry(1, 190)], research: false });
  await openGames(app);
  await app.ctx.setGameDecision('available', 190, 'ps5', { precision: 'month', year: 2026, month: 1, evidence: [{ url: 'https://zz.example.com/store' }] }, 'evidence'); await settle();
  assert.match(app.el('errorBanner').innerHTML, /needs research access/);
  const r = await bootWith({ entries: [entry(1, 190)], research: true });
  await openGames(r);
  await r.ctx.setGameDecision('available', 190, 'ps5', { precision: 'month', year: 2026, month: 1, evidence: [{ url: 'https://zz.example.com/store' }] }, 'evidence'); await settle();
  assert.match(text(rowOf(r, ID('61000000', 1))), /PS5 · Jan 2026 · Store or publisher/, 'available, at the precision the source gives');
  assert.strictEqual(r.run(`gameAvailability([gamesData.cache.get(190)], gamesState()).playable`), true);
});

test('TV’s presentation: rows and cards, C / P beside the title, TV’s genre pills with +N, a quiet status select, aligned platform and release', async () => {
  const all = [101, 102, 103, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200];
  const app = await bootWith({ cache: all, entries: [entry(1, 102, { priority: 'high' }), entry(2, 200, { priority: 'low' }), entry(3, 120, { status: 'playing' })] });
  await openGames(app);
  const html = screen(app);
  assert.match(html, /<table class="games-table" aria-label="Your games"><thead><tr><th>Game<\/th><th class="col-cats">Genres<\/th><th class="col-plat">Platform · Release<\/th><th>Status<\/th><\/tr><\/thead>/);
  assert.match(html, /<div class="card-list games-cards" aria-label="Your games">/, 'the cards for narrow screens');
  for (const k of [1, 2, 3]) assert.ok(rowOf(app, ID('61000000', k)) && cardOf(app, ID('61000000', k)), 'each game has a row and a card');
  // TV's priority marks: ★ before the title, Low after.
  assert.match(rowOf(app, ID('61000000', 1)), /<span class="priority-high" role="img" aria-label="High priority" title="High priority">★<\/span> <button type="button" class="show-title game-title-btn"/);
  assert.match(rowOf(app, ID('61000000', 2)), /Director’s Cut<\/button> <span class="priority-low" title="Low priority">Low<\/span>/, 'no scores: nothing between the title and Low');
  assert.doesNotMatch(rowOf(app, ID('61000000', 2)), /rating-critic|rating-player/, 'a missing score shows nothing');
  // Genres: what fits the row (then +N, which shows the rest); the card lists every pill.
  const r2 = rowOf(app, ID('61000000', 2));
  assert.match(r2, /data-gaction="genre:Adventure" aria-pressed="false"/);
  assert.match(r2, /class="meta-more" data-gaction="cats-more" aria-expanded="false" aria-label="Show 4 more genres"[^>]*>\+4</);
  assert.strictEqual((cardOf(app, ID('61000000', 2)).match(/data-gaction="genre:/g) || []).length, 5);
  app.ctx.toggleGameGenres(`game:${ID('61000000', 2)}`);
  assert.strictEqual((rowOf(app, ID('61000000', 2)).match(/data-gaction="genre:/g) || []).length, 5, '+4 shows them');
  assert.match(rowOf(app, ID('61000000', 2)), />Fewer</);
  // The status: TV's quiet select (Want to play and Skipped plain; Playing blue).
  assert.match(rowOf(app, ID('61000000', 1)), /<select class="status-select game-status s-confirmed" data-gaction="status"/);
  assert.match(rowOf(app, ID('61000000', 3)), /<select class="status-select game-status s-watching" data-gaction="status"/);
  // Platform and release: PS4 on PS5 says so; upcoming and TBA are told apart; "per IGDB" is screen-reader text and a tooltip.
  assert.match(rowOf(app, ID('61000000', 1)), /<span class="game-plat">PS4 · <span class="game-compat">Playable on PS5<\/span><\/span><span class="game-when">/);
  assert.match(rowOf(app, ID('61000000', 1)), /<span class="visually-hidden"> · per IGDB<\/span>/);
  assert.match(rowOf(app, ID('61000000', 2)), /<span class="game-plat">PS5<\/span><span class="game-when game-upcoming">/, 'a date to come');
  assert.match(rowOf(app, ID('61000000', 3)), /<span class="game-when game-tba"><span class="visually-hidden"> · <\/span>Date TBA<\/span>/);
  assert.doesNotMatch(text(html), /Critics \d+ · IGDB/, 'no repeated source text in the list');
  // TV's ⋯: Priority as a select first.
  assert.match(rowOf(app, ID('61000000', 1)), /<div class="popover-section-label">Priority<\/div>\s*<span class="state-action"><select class="priority-select p-high" data-gaction="priority"/);
});

test('the Library toolbar is TV’s: Search, Filters (Genre, Status) with its count and chips, Sort, + Add game; a pill filters and keeps focus', async () => {
  const app = await bootWith({ entries: [entry(1, 102), entry(2, 140), entry(3, 180, { status: 'skipped' })] });
  await openGames(app);
  const bar = () => screen(app).split('<table')[0];
  assert.match(bar(), /<div class="list-toolbar games-toolbar"><div class="filters"><div class="filter-line">/);
  assert.match(bar(), /id="gFiltersBtn" aria-expanded="false" aria-controls="gFilters"[^>]*>Filters <span aria-hidden="true">▾<\/span>/);
  assert.match(bar(), /id="gFilters" role="group" aria-label="Filters"[^>]*hidden>/, 'the panel starts closed');
  assert.match(bar(), /<span class="filter-default">Status: All except Skipped<\/span>/);
  assert.match(bar(), /<p class="count-line" id="gamesCount">2 of 3 games<\/p>/, 'as TV: shown of listed');
  app.ctx.toggleGamesFilters();
  assert.match(bar(), /id="gFiltersBtn" aria-expanded="true"/);
  assert.doesNotMatch(bar(), /id="gFilters"[^>]*hidden>/);
  app.ctx.gamesFiltersKeydown({ key: 'Escape', preventDefault() {} });
  assert.match(bar(), /id="gFilters"[^>]*hidden>/, 'Escape closes it');
  // A pill sets the genre filter: pressed, a chip and a count on Filters; focus stays on the pill.
  app.dom.focus('gamesScreen', `[data-game="${ID('61000000', 1)}"] [data-gaction="genre:Shooter"]`);
  app.ctx.toggleGamesGenre('Shooter');
  const a = app.dom.active();
  assert.deepStrictEqual([a.closest('[data-game]').getAttribute('data-game'), a.getAttribute('data-gaction'), a.getAttribute('aria-pressed')], [ID('61000000', 1), 'genre:Shooter', 'true']);
  assert.match(bar(), /Filters<span class="filter-count" aria-hidden="true">1<\/span><span class="visually-hidden">, 1 active<\/span>/);
  assert.match(bar(), /id="gchip-genre" class="filter-chip" aria-label="Remove filter: Genre, Shooter"/);
  assert.match(bar(), /<p class="count-line" id="gamesCount">2 of 3 games<\/p>/);
  app.ctx.setGamesFilter('status', 'all');
  assert.match(bar(), /id="gchip-status"[^>]*aria-label="Remove filter: Status, All"/);
  app.ctx.removeGamesFilter('genre');
  assert.doesNotMatch(bar(), /gchip-genre/);
  assert.strictEqual(libraryOrder(app).length, 3, 'Status All lists the skipped game too');
  app.ctx.clearGamesFilters();
  assert.strictEqual(libraryOrder(app).length, 2);
  assert.match(bar(), /data-gaction="add" onclick="openGamesAdd\(this\)">\+ Add game<\/button>/);
});

test('franchises as TV’s shows: expand, aligned Up next and Coming; expanded, spots in release order with their versions beneath, then Stop following', async () => {
  const app = await bootWith({ follows: [follow(1, 7001, 'ZZ War')], entries: [entry(1, 102, { status: 'playing' })] });
  await openGames(app, 'gamesfranchises');
  const t = () => tableOf(app);
  assert.match(t(), /<thead><tr><th>Franchise<\/th><th class="col-next">Up next<\/th><th class="col-next">Coming<\/th><th><\/th><\/tr><\/thead>/);
  assert.match(t(), /<button type="button" class="expand-btn" data-gaction="expand" aria-expanded="false" aria-label="Show the games of ZZ War"[^>]*><span class="expand-chevron">▸<\/span><\/button>/);
  assert.match(screen(app), /<p class="count-line" id="gamesCount">1 franchise followed<\/p>/);
  app.ctx.toggleFranchise(ID('62000000', 1));
  assert.match(t(), /aria-expanded="true" aria-label="Hide the games of ZZ War"/);
  const spots = [...t().matchAll(/<tr class="sub-row spot-row[^"]*" data-follow-of="[^"]+" data-spot="(\d+)">/g)].map(m => Number(m[1]));
  assert.deepStrictEqual(spots, [130, 102, 110, 120], 'the spots, oldest first; the PS3-only original (no release on PS5) isn’t listed');
  assert.match(t(), /<tr class="sub-row spot-version" data-follow-of="[^"]+" data-spot-of="\d+"><td class="spot-version-name">ZZ War 4 Remastered <span class="muted">\(remaster\)<\/span><\/td>[\s\S]*?data-gaction="status-v102"[^>]*>[\s\S]*?<option value="playing" selected>Playing<\/option>/, 'a saved version shows its status control');
  assert.match(t(), /data-gaction="save-110"[^>]*>Save<\/button>/, 'an unsaved one offers Save');
  assert.match(t(), /data-gaction="unfollow"[^>]*>Stop following ZZ War<\/button>/);
  assert.match(screen(app).split('</tbody>')[1], /<div class="item-card show-group-card franchise-card" data-follow="[^"]+">[\s\S]*class="card-subseasons"/, 'the card expands too');
});

test('followed franchise: Up next through a remaster that became playable later keeps its original’s place; Coming shows a TBA main-series title; spin-offs don’t count unless chosen', async () => {
  const app = await bootWith({ follows: [follow(1, 7001, 'ZZ War')] });
  await openGames(app, 'gamesfranchises');
  const row = franchiseOf(app, ID('62000000', 1));
  assert.match(row, /Up next: ZZ War 4 Remastered · PS4 · Playable on PS5 · Nov 4, 2016/, row);
  assert.match(row, /Coming: ZZ War Next · PS5 · Date TBA/);
  app.ctx.toggleFranchise(ID('62000000', 1));
  const open = text(screen(app));
  assert.ok(open.indexOf('ZZ War 4 2007') < open.indexOf('ZZ War Pocket 2015') && open.indexOf('ZZ War Pocket 2015') < open.indexOf('ZZ War (2019) 2019'), 'spots in original release order: ' + open);
  assert.match(open, /ZZ War Pocket 2015 Spin-off \(not counted\)/);
  assert.match(open, /ZZ War 4 Remastered \(remaster\) PS4 · Playable on PS5 · Nov 4, 2016 · per IGDB Save/, 'the remaster is a version of the 2007 spot');
  assert.doesNotMatch(open, /ZZ War 4 Handheld/, 'a port without a selected platform isn’t a separate version to show');
  assert.deepStrictEqual(app.writes().filter(r => !/functions\/v1\/igdb/.test(r.url)).map(r => r.url), [], 'no database write (the IGDB function is a read)');
});

test('versions and spots: finishing the remaster completes the spot; a skipped original leaves its remaster eligible; Skip this spot passes the whole spot; a spin-off counts once chosen', async () => {
  const f = follow(1, 7001, 'ZZ War');
  const skipOriginal = await bootWith({ follows: [f], entries: [entry(1, 101, { status: 'skipped' })] });
  await openGames(skipOriginal, 'gamesfranchises');
  assert.match(franchiseOf(skipOriginal, f.id), /Up next: ZZ War 4 Remastered/, 'skipping one version applies only to that version');
  const app = await bootWith({ follows: [f], entries: [entry(1, 102, { spot: 101, status: 'playing' })] });
  await openGames(app, 'gamesfranchises');
  assert.match(franchiseOf(app, f.id), /Up next: ZZ War 4 Remastered/, 'the saved version (Playing) is Up next');
  await app.ctx.setGameStatus(ID('61000000', 1), 'finished'); await settle();
  await openGames(app, 'gamesfranchises');
  assert.match(franchiseOf(app, f.id), /Up next: ZZ War \(2019\) · PS4 · Playable on PS5 · Oct 25, 2019/, 'a distinct game with a reused title is its own, later spot');
  await app.ctx.toggleIncludeSpinoff(130, false); await settle();
  await openGames(app, 'gamesfranchises');
  assert.match(franchiseOf(app, f.id), /Up next: ZZ War Pocket/, 'a counted spin-off takes its place by original release');
  await app.ctx.toggleSkipSpot(130, false); await settle();
  await openGames(app, 'gamesfranchises');
  assert.match(franchiseOf(app, f.id), /Up next: ZZ War \(2019\)/, 'Skip this spot passes over it');
  assert.deepStrictEqual(app.store.game_decisions.map(d => [d.kind, d.igdb_id]).sort(), [['include_spinoff', 130], ['skip_spot', 130]]);
  assert.strictEqual(app.store.game_entries[0].status, 'finished', 'decisions change no status');
});

test('a native edition coming after a finished PS4 version: Coming with its own date, the franchise stays Caught up, progress kept', async () => {
  const f = follow(2, 7002, 'ZZ Saga');
  const app = await bootWith({ follows: [f], entries: [entry(1, 170, { status: 'finished' })] });
  await openGames(app, 'gamesfranchises');
  const row = franchiseOf(app, f.id);
  assert.match(row, /Caught up/);
  assert.match(row, /Coming: ZZ Saga One · PS5 · 2027/, row);
  assert.strictEqual(app.store.game_entries[0].status, 'finished');
});

test('+ Add game: IGDB through the function; the preview groups an original with its remaster; Save records the spot and plain ports and follows nothing; Follow saves nothing', async () => {
  const stub = igdbStub();
  const app = await bootWith({ igdb: stub, noCache: true });
  await openGames(app);
  app.ctx.openGamesAdd(null);
  app.run(`gamesAdd.query = 'zz war 4'`);
  await app.ctx.searchGamesAdd(); await settle();
  assert.match(text(dialog(app)), /ZZ War 4 2007 ZZ War 4 Remastered 2016 · remaster/);
  await app.ctx.pickGameResult(101); await settle();
  const d = text(dialog(app));
  assert.match(d, /ZZ War 4 Original · 2007 Not on your platforms · with 1 port Save/);
  assert.match(d, /ZZ War 4 Remastered Remaster · 2016 PS4 · Playable on PS5 · Nov 4, 2016 · per IGDB Save/);
  assert.match(d, /Follow ZZ War/);
  assert.match(d, /Saving a game doesn’t follow its franchise/);
  await app.ctx.saveGameRecord(102); await settle();
  const add = rpcs(app, 'library_game_add');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(add[0].body)), { p_igdb_id: 102, p_title: 'ZZ War 4 Remastered', p_spot_igdb_id: 101, p_port_ids: [], p_status: 'want', p_priority: 'normal' });
  assert.ok(app.requests.indexOf(rpcs(app, 'library_game_titles_put')[0]) < app.requests.indexOf(add[0]), 'cached first, then saved');
  assert.strictEqual(app.store.game_follows.length, 0, 'saving follows nothing');
  await app.ctx.saveGameRecord(101); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rpcs(app, 'library_game_add')[1].body)).p_port_ids, [103], 'the original takes its plain port record');
  const n = app.store.game_entries.length;
  await app.ctx.followFranchise(7001, 'ZZ War'); await settle();
  assert.strictEqual(app.store.game_follows.length, 1);
  assert.strictEqual(app.store.game_entries.length, n, 'following saves nothing');
  assert.ok(stub.calls.flat().some(q => q.endpoint === 'collection_memberships' && /collection = 7001/.test(q.body)), 'its membership read from IGDB');
  assert.ok(app.requests.filter(r => /functions\/v1\/igdb/.test(r.url)).every(r => /^Bearer /.test(r.headers.Authorization) && r.headers.apikey), 'the function is called with the member’s token and the publishable key');
});

// The harness's DOM keeps no caret: the search box gets one here (a browser's focus() leaves a
// fresh input's caret at the start), and the dialog knows what it holds.
function caretDom(app, boxId = 'gAddSearch', value = () => app.get('gamesAdd').query, inside = 'gameDialogBox') {
  const doc = app.ctx.document, orig = doc.getElementById;
  doc.getElementById = id => {
    const e = orig(id);
    if (e && id === boxId && !e.__caret) {
      Object.assign(e, { __caret: true, tagName: 'INPUT', type: 'search', value: value(), selectionStart: 0, selectionEnd: 0, selectionDirection: 'none' });
      e.focus = () => { doc.activeElement = e; };
      e.setSelectionRange = (a, b, d) => Object.assign(e, { selectionStart: a, selectionEnd: b, selectionDirection: d || 'none' });
      e.closest = sel => (sel === `#${inside}` ? orig(inside) : null);
      e.getAttribute = () => null;
    }
    return e;
  };
  const box = orig(inside);
  box.contains = n => !!n && n === orig(boxId);
  box.focus = () => { doc.activeElement = box; };
  return () => doc.getElementById(boxId);
}

test('Search your games: each keystroke’s redraw keeps the box focused with its caret and selection where they were', async () => {
  const app = await bootWith({ igdb: igdbStub(), noCache: true });
  await openGames(app);
  const search = caretDom(app, 'gSearch', () => app.get('gamesFilters').search || '', 'gamesScreen'), doc = app.ctx.document;
  let el = search(); el.focus();
  // "zz wr" typed, then the caret moved back between "w" and "r" and "a" typed: "zz war".
  for (const [v, at] of [['z', 1], ['zz', 2], ['zz w', 4], ['zz wr', 5], ['zz war', 5]]) {
    el.value = v; el.setSelectionRange(at, at);
    app.ctx.setGamesFilter('search', v);
    const now = search();
    assert.notStrictEqual(now, el, 'the screen was redrawn');
    assert.strictEqual(doc.activeElement, now, `still focused after "${v}"`);
    assert.deepStrictEqual([now.selectionStart, now.selectionEnd], [at, at], `the caret where it was after "${v}"`);
    el = now;
  }
  el.setSelectionRange(3, 6, 'backward'); app.ctx.setGamesFilter('search', 'zz war');
  assert.deepStrictEqual([search().selectionStart, search().selectionEnd, search().selectionDirection], [3, 6, 'backward'], 'a selection kept too');
});

test('+ Add game: the search box keeps its focus, caret and selection across a search’s redraws; focused anew, its caret is at the end', async () => {
  const app = await bootWith({ igdb: igdbStub(), noCache: true });
  await openGames(app);
  const search = caretDom(app), doc = app.ctx.document;
  app.ctx.openGamesAdd(null);
  let el = search();
  assert.strictEqual(doc.activeElement, el, 'focused on opening');
  // Typing "zz war 4" with "war" selected backwards, then Enter: two redraws (Searching…, the results).
  el.value = 'zz war 4'; app.run(`gamesAdd.query = 'zz war 4'`); el.setSelectionRange(3, 6, 'backward');
  await app.ctx.searchGamesAdd(); await settle();
  assert.match(text(dialog(app)), /ZZ War 4 Remastered/);
  const after = search();
  assert.notStrictEqual(after, el, 'the box was redrawn');
  assert.strictEqual(doc.activeElement, after, 'still focused');
  assert.deepStrictEqual([after.selectionStart, after.selectionEnd, after.selectionDirection], [3, 6, 'backward'], 'the same caret and selection');
  // From the Search button: the redrawn box takes focus with its caret at the end, not the start.
  doc.activeElement = null;
  await app.ctx.searchGamesAdd(); await settle();
  el = search();
  assert.strictEqual(doc.activeElement, el);
  assert.deepStrictEqual([el.selectionStart, el.selectionEnd], [8, 8], 'caret after the text, so Backspace deletes from the end');
});

test('IGDB unavailable: search says so and nothing is written', async () => {
  const app = await bootWith({ igdb: null });
  await openGames(app);
  app.ctx.openGamesAdd(null);
  app.run(`gamesAdd.query = 'zz'`);
  await app.ctx.searchGamesAdd(); await settle();
  assert.match(text(dialog(app)), /IGDB couldn’t be reached\. Try again later\./);
  assert.deepStrictEqual(app.writes().filter(r => !/functions\/v1\/igdb/.test(r.url)).map(r => r.url), [], 'no database write (the IGDB function is a read)');
});

// The worked example: [Dune, hidden Switch game, Severance S2, Astro Bot].
function exampleQueue() {
  const show = { id: ID('63000000', 1), collection: 'othertv', title: 'ZZ Severance', show_key: 'zz severance', tmdb_id: 501, status: 'watching', created_at: TS, ended: false };
  const s2 = { id: ID('64000000', 2), created_at: TS, collection: 'othertv', title: 'ZZ Severance', theme: 'ZZ', status: 'pending', watched: false, skipped: false, show_id: show.id, media_type: 'tv', tmdb_id: 501, season_number: 2, season: 'Season 2', display_date: 'Jan 17, 2025', date_sort: '2025-01-17', item_key: 'zz severance|season 2', watch_with: [], collections: [] };
  const dune = { id: ID('65000000', 1), created_at: TS, collection: 'movies', title: 'ZZ Dune', theme: 'Drama', status: 'confirmed', watched: false, media_type: 'movie', tmdb_id: 601, season_number: null, season: 'Film', display_date: 'Mar 1, 2024', date_sort: '2024-03-01', item_key: 'zz dune|film', watch_with: [], collections: [], show_id: null, skipped: false };
  const sw = entry(1, 150), astro = entry(2, 180, { status: 'want' });
  const Q = ID('66000000', 1), E = k => ID('67000000', k);
  const queues = { watch_queues: [{ id: Q, name: 'ZZ Weekend', sort_order: 1, created_at: TS }], queue_entries: [
    { id: E(1), queue_id: Q, show_id: null, item_id: dune.id, game_entry_id: null, position: 1, created_at: TS },
    { id: E(2), queue_id: Q, show_id: null, item_id: null, game_entry_id: sw.id, position: 2, created_at: TS },
    { id: E(3), queue_id: Q, show_id: null, item_id: s2.id, game_entry_id: null, position: 3, created_at: TS },
    { id: E(4), queue_id: Q, show_id: null, item_id: null, game_entry_id: astro.id, position: 4, created_at: TS }] };
  return { rows: [s2, dune], shows: [show], entries: [sw, astro], queues, Q, E };
}
const queueScreen = app => app.el('queuesScreen').innerHTML;
const queueOrder = app => [...queueScreen(app).matchAll(/<li class="queue-entry[^"]*" data-entry="([^"]+)"/g)].map(m => m[1]);
const stored = (app, Q) => app.store.queue_entries.filter(e => e.queue_id === Q).sort((a, b) => a.position - b.position).map(e => e.id);

test('a mixed queue with a hidden game: it keeps its numbered place while the visible entries move, both ways, in one whole-queue write; Switch chosen again shows both orders right', async () => {
  const x = exampleQueue();
  const app = await bootWith({ rows: x.rows, shows: x.shows, entries: x.entries, queues: x.queues });
  app.ctx.openQueues(); await settle();
  assert.deepStrictEqual(queueOrder(app), [x.E(1), x.E(3), x.E(4)], 'the Switch game is hidden with PS5 only');
  assert.match(text(queueScreen(app)), /3 entries \(\+1 hidden\)/);
  assert.match(text(queueScreen(app)), /1 game on none of your platforms is hidden here and keeps its place while you reorder the others/);
  assert.match(text(queueScreen(app)), /ZZ Astro .*Game · PS5 · Sep 6, 2024 · per IGDB/);
  await app.ctx.moveQueueEntry(x.E(4), 1); await settle();
  const [c1] = rpcs(app, 'library_queue_set_order');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(c1.body)), { p_queue_id: x.Q, p_expected: [x.E(1), x.E(2), x.E(3), x.E(4)], p_order: [x.E(4), x.E(2), x.E(1), x.E(3)] });
  assert.deepStrictEqual(stored(app, x.Q), [x.E(4), x.E(2), x.E(1), x.E(3)], 'Astro Bot to the top: [Astro Bot, hidden Switch game, Dune, Severance S2]');
  assert.deepStrictEqual(rpcs(app, 'library_queue_move'), [], 'not the one-entry move');
  // From the original order, Dune to the bottom.
  app.store.queue_entries.forEach(e => { e.position = [x.E(1), x.E(2), x.E(3), x.E(4)].indexOf(e.id) + 1; });
  app.ctx.openQueues(); app.ctx.switchView('queues'); await settle();
  await app.ctx.moveQueueEntry(x.E(1), 3); await settle();
  assert.deepStrictEqual(stored(app, x.Q), [x.E(3), x.E(2), x.E(4), x.E(1)], 'Dune to the bottom: [Severance S2, hidden Switch game, Astro Bot, Dune]');
  app.store.game_settings[0].platforms = ['ps5', 'switch'];
  app.ctx.switchView('watching'); await settle(); app.ctx.openQueues(); await settle();
  assert.deepStrictEqual(queueOrder(app), [x.E(3), x.E(2), x.E(4), x.E(1)], 'with Switch chosen again, every entry where it was saved');
});

test('a queue with nothing hidden still moves with the one-entry move; a stale whole-queue order is refused and read again; Finished from the queue takes the game out of it', async () => {
  const x = exampleQueue();
  const app = await bootWith({ rows: x.rows, shows: x.shows, entries: x.entries, queues: x.queues, platforms: ['ps5', 'switch'] });
  app.ctx.openQueues(); await settle();
  await app.ctx.moveQueueEntry(x.E(4), 1); await settle();
  assert.strictEqual(rpcs(app, 'library_queue_move').length, 1, 'nothing hidden: library_queue_move, as before');
  assert.deepStrictEqual(rpcs(app, 'library_queue_set_order'), []);
  const hidden = await bootWith({ rows: x.rows, shows: x.shows, entries: x.entries, queues: x.queues });
  hidden.ctx.openQueues(); await settle();
  hidden.store.queue_entries.find(e => e.id === x.E(3)).position = 0; // another device moved Severance to the top
  await hidden.ctx.moveQueueEntry(x.E(4), 1); await settle();
  assert.match(hidden.el('errorBanner').innerHTML, /changed since the page showed it/);
  assert.deepStrictEqual(queueOrder(hidden), [x.E(3), x.E(1), x.E(4)], 'read again: what is saved');
  await hidden.ctx.setGameStatus(x.entries[1].id, 'finished', 'queue'); await settle();
  assert.ok(!hidden.store.queue_entries.some(e => e.game_entry_id === x.entries[1].id), 'Finished: out of every queue');
  assert.deepStrictEqual(queueOrder(hidden), [x.E(3), x.E(1)], 'read back after the change');
  assert.match(hidden.el('banner').innerHTML, /is Finished, so it left 1 queue\. You can queue it again to replay it\./);
});

test('Add to queue… for a game: refused once it is in that queue; adding changes no status', async () => {
  const x = exampleQueue();
  const app = await bootWith({ rows: x.rows, shows: x.shows, entries: x.entries, queues: { watch_queues: x.queues.watch_queues, queue_entries: [] } });
  await openGames(app);
  app.ctx.openAddToQueue('game', x.entries[1].id, null, null); await settle();
  await app.ctx.submitQueueAdd(); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rpcs(app, 'library_queue_add_game')[0].body)), { p_queue_id: x.Q, p_entry_id: x.entries[1].id });
  assert.strictEqual(app.store.game_entries.find(e => e.id === x.entries[1].id).status, 'want');
  app.ctx.openAddToQueue('game', x.entries[1].id, null, null); await settle();
  assert.match(app.el('queueAddBox').innerHTML, /Already in this queue \(#1\)/);
});

test('collections: create, add and remove; membership is independent of queues, following and Finished; the genre filter narrows the library; a backup and restore keep the membership', async () => {
  const app = await bootWith({ entries: [entry(1, 102), entry(2, 140), entry(3, 180)], follows: [follow(1, 7001, 'ZZ War')] });
  await openGames(app, 'gamescollections');
  await app.ctx.createGameCollection('ZZ Couch'); await settle();
  const C = app.store.game_collections[0].id;
  app.ctx.openGameCollectionAdd(ID('61000000', 1), null);
  await app.ctx.submitGameCollectionAdd(); await settle();
  app.ctx.openGameCollectionAdd(ID('61000000', 3), null);
  await app.ctx.submitGameCollectionAdd(); await settle();
  assert.deepStrictEqual(app.store.game_collection_members.map(m => m.entry_id), [ID('61000000', 1), ID('61000000', 3)], JSON.stringify(app.store.game_collection_members) + app.el('errorBanner').innerHTML);
  await openGames(app, 'gamescollections');
  assert.match(text(screen(app)), /ZZ Astro .*ZZ War 4 Remastered/);
  await app.ctx.setGameStatus(ID('61000000', 1), 'finished'); await settle();
  await app.ctx.unfollowFranchise(ID('62000000', 1)); await settle();
  assert.strictEqual(app.store.game_collection_members.length, 2, 'Finished and unfollowing leave the collection alone');
  const backup = await app.ctx.buildBackupObject();
  assert.strictEqual(backup.formatVersion, 9);
  assert.deepStrictEqual(Object.keys(backup.tables).filter(t => /^game_/.test(t)), ['game_settings', 'game_entries', 'game_follows', 'game_decisions', 'game_collections', 'game_collection_members'], 'no IGDB cache in a backup');
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(backup)), []);
  const m = app.store.game_collection_members.find(x => x.entry_id === ID('61000000', 3));
  await app.ctx.removeFromGameCollection(m.id); await settle();
  assert.strictEqual(app.store.game_collection_members.length, 1);
  assert.strictEqual(app.store.game_entries.length, 3, 'removing from a collection keeps the game');
  app.ctx.openSettings(null);
  app.ctx.__b = backup;
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.deepStrictEqual(app.store.game_collection_members.map(x => [x.collection_id, x.entry_id]), [[C, ID('61000000', 1)], [C, ID('61000000', 3)]], 'the restore brings the membership back');
  await openGames(app);
  app.ctx.setGamesFilter('genre', 'Platform');
  assert.deepStrictEqual(libraryOrder(app), [ID('61000000', 3)], 'the genre filter');
  app.ctx.setGamesFilter('genre', '');
  app.ctx.setGamesFilter('status', 'all');
  assert.strictEqual(libraryOrder(app).length, 3);
});

test('sorting the library: critic and player scores are separate fields; there is no Length field', async () => {
  const app = await bootWith({ entries: [entry(1, 102), entry(2, 110), entry(3, 140), entry(4, 180)], style: 'completionist' });
  await openGames(app);
  app.ctx.chooseSortField('critic'); await settle();
  assert.deepStrictEqual(libraryOrder(app), [ID('61000000', 1), ID('61000000', 2), ID('61000000', 3), ID('61000000', 4)], 'critics, highest first; no score last');
  app.ctx.chooseSortField('player'); await settle();
  assert.deepStrictEqual(libraryOrder(app).slice(0, 3), [ID('61000000', 2), ID('61000000', 1), ID('61000000', 3)], 'players, highest first');
  assert.doesNotMatch(app.run('sortMenuHtml(viewSortContext())'), /Length/);
  const before = libraryOrder(app);
  app.ctx.chooseSortField('length'); await settle();
  assert.deepStrictEqual(libraryOrder(app), before, 'a Length field no longer exists: nothing changes');
});

test('a remembered sort that includes Length: Length is dropped, the other fields keep their order and directions; Length alone gives the usual order', async () => {
  const HU = '0a000000-0000-4000-8000-0000000000aa';
  const stored = views => { const st = memoryStorage(); st.setItem(`watchlist_view_sorts::${HU}`, JSON.stringify({ v: 1, views })); return st; };
  const entries = [entry(1, 102), entry(2, 110), entry(3, 140), entry(4, 180)];
  const app = await bootWith({ entries, storage: stored({ games: [{ f: 'length', d: 'asc' }, { f: 'player', d: 'asc' }, { f: 'title', d: 'desc' }] }) });
  await openGames(app);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.run("viewSortSpec(viewSortContext())"))), [{ f: 'player', d: 'asc' }, { f: 'title', d: 'desc' }]);
  assert.deepStrictEqual(libraryOrder(app).slice(0, 3), [ID('61000000', 3), ID('61000000', 1), ID('61000000', 2)], 'players lowest first, as remembered');
  assert.doesNotMatch(app.el('sortLine') ? app.el('sortLine').innerHTML : screen(app), /Length/);
  const only = await bootWith({ entries, storage: stored({ games: [{ f: 'length', d: 'desc' }] }) });
  await openGames(only);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(only.run("viewSortSpec(viewSortContext())"))), []);
  const usual = await bootWith({ entries });
  await openGames(usual);
  assert.deepStrictEqual(libraryOrder(only), libraryOrder(usual), 'Length alone: the usual order');
});

test('game length is gone from Details, the add preview and the queue; adding a game and Refresh read no time to beat', async () => {
  const app = await bootWith({ entries: [entry(1, 140)], follows: [follow(1, 7001, 'ZZ War')], queues: { watch_queues: [{ id: ID('66000000', 9), name: 'ZZ Q', sort_order: 1, created_at: TS }],
    queue_entries: [{ id: ID('67000000', 9), queue_id: ID('66000000', 9), show_id: null, item_id: null, game_entry_id: ID('61000000', 1), position: 1, created_at: TS }] } });
  await openGames(app);
  app.ctx.openGameDetails(140, null);
  assert.doesNotMatch(text(dialog(app)), /Length|time to beat|HowLongToBeat|play style/i);
  app.ctx.closeGameDialog();
  app.ctx.openGamesAdd(null);
  app.run(`gamesAdd.query = 'zz war'`);
  await app.ctx.searchGamesAdd(); await settle();
  await app.ctx.pickGameResult(110); await settle();
  assert.doesNotMatch(text(dialog(app)), /Length| h · IGDB|HowLongToBeat/);
  await app.ctx.saveGameRecord(110); await settle();
  assert.ok(app.store.game_entries.some(e => e.igdb_id === 110), 'saved');
  app.ctx.closeGameDialog();
  await app.ctx.refreshGames(); await settle();
  assert.doesNotMatch(app.el('errorBanner').innerHTML, /couldn’t/);
  assert.ok(app.igdb.calls.length > 0 && !app.igdb.calls.flat().some(q => q.endpoint === 'game_time_to_beats'), 'no time-to-beat request');
  app.ctx.openQueues(); await settle();
  assert.doesNotMatch(text(app.el('queuesScreen').innerHTML), /Length| h · IGDB|Estimate/);
});

test('settings: a saved legacy play style is kept as it is when the platforms change', async () => {
  const app = await bootWith({ style: 'completionist' });
  app.ctx.openSettings(null); await settle();
  app.ctx.document.querySelectorAll = sel => (sel === '.games-platform' ? [{ value: 'ps5', checked: true }, { value: 'switch', checked: true }] : []);
  await app.ctx.saveGamesSettings(); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rpcs(app, 'library_game_settings_save')[0].body)), { p_expected: { platforms: ['ps5'], play_style: 'completionist' }, p_platforms: ['ps5', 'switch'], p_play_style: 'completionist' });
  assert.deepStrictEqual(app.store.game_settings.map(s => [s.platforms, s.play_style]), [[['ps5', 'switch'], 'completionist']]);
});

test('Refresh: a new main-series announcement appears under Coming, nothing is added to Want to play or a queue; a new plain port joins its saved game; the report says so', async () => {
  const raw = { ...RAW, 121: { id: 121, name: 'ZZ War Next Two', game_type: 0, collections: [{ id: 7001, name: 'ZZ War' }], release_dates: [{ platform: PS5, date: unix('2027-07-01'), date_format: 5, y: 2027, status: FULL, release_region: WW }] },
    102: { ...RAW[102], ports: [104] }, 104: { id: 104, name: 'ZZ War 4 Remastered (Switch)', game_type: 11, parent_game: 102, release_dates: [rd(SWITCH, '2021-01-01')] } };
  const members = { ...MEMBERS, 7001: [...MEMBERS[7001], [121, 1]] };
  const app = await bootWith({ igdb: igdbStub(raw, members), entries: [entry(1, 102, { spot: 101, status: 'finished' })], follows: [follow(1, 7001, 'ZZ War')] });
  await openGames(app, 'gamesfranchises');
  const wants = app.store.game_entries.length;
  await app.ctx.refreshGames(); await settle();
  assert.match(text(screen(app)), /New in ZZ War: ZZ War Next Two · PS5 · Q3 2027/);
  assert.match(text(screen(app)), /Nothing was added to Want to play or your queues\./);
  assert.strictEqual(app.store.game_entries.length, wants);
  assert.deepStrictEqual(app.store.game_entries[0].port_ids, [104], 'the new port joined the saved remaster');
  const [relink] = rpcs(app, 'library_game_relink');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(relink.body.p_expected)), { spot_igdb_id: 101, port_ids: [] }, 'guarded by what was read');
  assert.match(franchiseOf(app, ID('62000000', 1)), /Coming: ZZ War Next Two · PS5 · Q3 2027 Upcoming \(\+1 more\)/, 'the earliest coming first; TBA last');
});

test('review: IGDB moving a saved version to another spot changes nothing until the member chooses; Keep mine stays decided; Use IGDB’s relinks with what was shown', async () => {
  const app = await bootWith({ entries: [entry(1, 102, { spot: 999 })] });
  await openGames(app);
  assert.match(screen(app), /Review \(1\)/);
  app.ctx.openGamesReview(null);
  assert.match(text(dialog(app)), /IGDB now places “ZZ War 4 Remastered” under ZZ War 4; your progress counts it under IGDB 999\./);
  await app.ctx.reviewKeep(0); await settle();
  assert.deepStrictEqual(app.store.game_decisions.map(d => [d.kind, d.igdb_id, d.value.spot_igdb_id]), [['keep_link', 102, 101]]);
  await openGames(app);
  assert.doesNotMatch(screen(app), /Review \(/, 'kept: no longer asked while IGDB says the same');
  const other = await bootWith({ entries: [entry(1, 102, { spot: 999 })] });
  await openGames(other);
  await other.ctx.reviewUseIgdb(0); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rpcs(other, 'library_game_relink')[0].body)), { p_entry_id: ID('61000000', 1), p_expected: { spot_igdb_id: 999, port_ids: [] }, p_spot_igdb_id: 101, p_port_ids: [] });
  assert.strictEqual(other.store.game_entries[0].status, 'want', 'a relink changes no status');
});

test('a restore with IGDB unavailable: saved games come back and show, with their status, even before IGDB is read again', async () => {
  const app = await bootWith({ entries: [entry(1, 102, { status: 'playing' })], igdb: null, noCache: true });
  await openGames(app);
  assert.match(text(rowOf(app, ID('61000000', 1))), /ZZ War 4 Remastered [\s\S]*Details not loaded yet: use Refresh/);
  assert.match(rowOf(app, ID('61000000', 1)), /<option value="playing" selected>/);
  await app.ctx.refreshGames(); await settle();
  assert.match(app.el('errorBanner').innerHTML, /Refresh couldn’t read IGDB \(IGDB couldn’t be reached\. Try again later\.\), so nothing was changed\./);
  assert.deepStrictEqual(app.writes().filter(r => !/functions\/v1\/igdb/.test(r.url)).map(r => r.url), [], 'no database write (the IGDB function is a read)');
});

test('focus: a status change keeps focus on that game’s status select; a deleted game’s focus goes to the next game’s ⋯', async () => {
  const app = await bootWith({ entries: [entry(1, 102), entry(2, 140), entry(3, 180)] });
  await openGames(app);
  const ids = libraryOrder(app);
  app.dom.focus('gamesScreen', `[data-game="${ids[0]}"] [data-gaction="status"]`);
  await app.ctx.setGameStatus(ids[0], 'playing'); await settle();
  const a = app.dom.active();
  assert.strictEqual(a.closest('[data-game]').getAttribute('data-game'), ids[0]);
  assert.strictEqual(a.getAttribute('data-gaction'), 'status');
  app.dom.focus('gamesScreen', `[data-game="${ids[1]}"] [data-gaction="more"]`);
  const e = app.store.game_entries.find(x => x.id === ids[1]);
  await app.ctx.deleteGame(ids[1]); await settle();
  void e;
  const b = app.dom.active();
  assert.deepStrictEqual([b.closest('[data-game]').getAttribute('data-game'), b.getAttribute('data-gaction')], [ids[2], 'more'], 'the next game’s ⋯');
});

test('leaving Games for any other view (by route, Back or a button) hides the Games screen; Games hides Queues', async () => {
  const app = await bootWith({ entries: [entry(1, 180)] });
  await openGames(app);
  assert.notStrictEqual(app.el('gamesScreen').style.display, 'none');
  for (const v of ['queues', 'settings', 'watching', 'collections']) {
    app.ctx.switchView(v); await settle();
    assert.strictEqual(app.el('gamesScreen').style.display, 'none', `${v}: no Games screen`);
    assert.strictEqual(app.el('gamesScreen').innerHTML, '');
    await openGames(app);
  }
  app.ctx.openQueues(); await settle();
  await openGames(app);
  assert.strictEqual(app.el('queuesScreen').style.display, 'none', 'Games: no Queues screen');
});

// ── Games research (games-research.js) ──
const EV = (source = 'playstation_store', url = 'https://store.playstation.com/zz/123') => [{ source, url, checked: day(-1) }];
const findings = list => JSON.stringify({ format: 'watchlist-games-research-findings', version: 1, research_date: day(-1), findings: list });

test('games research: the brief lists announcements, recent IGDB-only releases, PS4 games counted through Sony’s rule, unclear relationships and uncounted spin-offs; only with research access', async () => {
  const app = await bootWith({ follows: [follow(1, 7001, 'ZZ War')], entries: [entry(1, 140), entry(2, 102, { spot: 999 }), entry(3, 120)] });
  await openGames(app);
  const brief = app.run('gamesBuildBrief(gamesData)');
  assert.strictEqual(brief.format, 'watchlist-games-research-brief');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(brief.platforms)), ['ps5']);
  const ids = k => JSON.parse(JSON.stringify(brief.checks[k].map(x => x.igdb_id))).sort((a, b) => a - b);
  assert.deepStrictEqual(ids('announcements'), [120], 'ZZ War Next (TBA on PS5): ' + JSON.stringify(brief.checks.announcements));
  assert.deepStrictEqual(ids('recent'), [140], 'released 18 days ago, dated only by IGDB');
  assert.deepStrictEqual(ids('compatibility'), [102], 'Up next plays on PS5 only through the PS4 rule');
  assert.ok(brief.checks.relationships.some(x => x.igdb_id === 102 && x.question === 'which_spot'), 'the saved remaster IGDB places elsewhere');
  assert.deepStrictEqual(ids('roles'), [130], 'the uncounted spin-off');
  app.ctx.openSettings(null); await settle();
  assert.match(app.el('settingsScreen').innerHTML, /Download games research brief/);
  const none = await bootWith({ research: false });
  none.ctx.openSettings(null); await settle();
  assert.doesNotMatch(none.el('settingsScreen').innerHTML, /games research/i, 'no research controls without access');
  await none.ctx.gamesImportFindings(findings([]));
  assert.match(none.el('errorBanner').innerHTML + none.el('banner').innerHTML, /Games findings: 0 decisions recorded|research access/);
});

test('games research: an import applies availability and compatibility findings with their evidence, keeps relationships and roles for Review, and skips what it can’t apply', async () => {
  const app = await bootWith({ follows: [follow(1, 7001, 'ZZ War')], entries: [entry(1, 101, { status: 'skipped' }), entry(2, 140), entry(3, 120)] });
  await openGames(app);
  const r = await app.ctx.gamesImportFindings(findings([
    { type: 'availability', igdb_id: 120, platform: 'ps5', status: 'available', precision: 'month', year: 2026, month: 10, evidence: EV() },
    { type: 'availability', igdb_id: 140, platform: 'ps5', status: 'not_yet', evidence: EV('publisher', 'https://zz-publisher.example.com/news') },
    { type: 'compatibility', igdb_id: 110, status: 'ps4_only', evidence: EV() },
    { type: 'relationship', igdb_id: 103, relation: 'port_of', target_igdb_id: 101, evidence: EV('publisher', 'https://zz-publisher.example.com/a') },
    { type: 'role', igdb_id: 130, role: 'main', igdb_collection_id: 7001, evidence: EV('publisher', 'https://zz-publisher.example.com/b') },
    { type: 'availability', igdb_id: 999999, platform: 'ps5', status: 'available', precision: 'year', year: 2027, evidence: EV() },
    { type: 'availability', igdb_id: 180, platform: 'ps5', status: 'not_found' }]));
  await settle();
  assert.ok(r, app.el('errorBanner').innerHTML);
  assert.strictEqual(r.done.length, 5, JSON.stringify(r));
  assert.strictEqual(r.skipped.length, 2);
  const d = k => app.store.game_decisions.filter(x => x.kind === k).map(x => [x.igdb_id, x.platform, x.basis]);
  assert.deepStrictEqual(d('available'), [[120, 'ps5', 'research']]);
  assert.deepStrictEqual(d('not_out_yet').sort(), [[110, 'ps5', 'research'], [140, 'ps5', 'research']], 'holds that carry evidence are research');
  assert.deepStrictEqual(d('research_link'), [[103, '', 'research']]);
  assert.deepStrictEqual(d('research_role'), [[130, '', 'research']]);
  await openGames(app);
  assert.match(text(rowOf(app, ID('61000000', 3))), /PS5 · Oct 2026 · Store or publisher/, 'confirmed at the month the source gives');
  assert.match(text(rowOf(app, ID('61000000', 2))), /not out yet \(your hold\)/);
  assert.match(screen(app), /Review \(2\)/);
  app.ctx.openGamesReview(null);
  assert.match(text(dialog(app)), /Research \(\d{4}-\d{2}-\d{2}\) says “ZZ War 4 Handheld” is a port of ZZ War 4\. Evidence \(Claude’s assessment\): Publisher Join it to “ZZ War 4” as a port/);
  assert.match(text(dialog(app)), /says “ZZ War Pocket” is main series\. .* Count it toward Caught up/);
  await app.ctx.gamesResearchChoose(0, true); await settle();
  assert.deepStrictEqual(app.store.game_entries.find(e => e.igdb_id === 101).port_ids, [103], 'joined as a port, guarded by what was shown');
  assert.strictEqual(app.store.game_entries.find(e => e.igdb_id === 101).status, 'skipped', 'no status changed');
  await openGames(app);
  await app.ctx.gamesResearchChoose(0, false); await settle();
  assert.deepStrictEqual(d('research_role'), [], 'dismissed: the finding is gone');
  assert.ok(!app.store.game_decisions.some(x => x.kind === 'include_spinoff'), 'and nothing was counted');
  const again = await app.ctx.gamesImportFindings(findings([{ type: 'availability', igdb_id: 120, platform: 'ps5', status: 'available', precision: 'month', year: 2026, month: 10, evidence: EV() }]));
  assert.strictEqual(again.done.length, 0, 'the same finding again: already recorded, nothing sent');
});

test('games research: a findings file of the wrong shape, or with weak evidence, is refused whole', async () => {
  const app = await bootWith({ entries: [entry(1, 120)] });
  await openGames(app);
  for (const [label, f] of [
    ['no evidence', { type: 'availability', igdb_id: 120, platform: 'ps5', status: 'available', precision: 'year', year: 2027 }],
    ['a Store page off playstation.com', { type: 'availability', igdb_id: 120, platform: 'ps5', status: 'available', precision: 'year', year: 2027, evidence: EV('playstation_store', 'https://zz.example.com/store') }],
    ['an http address', { type: 'availability', igdb_id: 120, platform: 'ps5', status: 'available', precision: 'year', year: 2027, evidence: EV('publisher', 'http://zz.example.com/') }],
    ['checked after the research date', { type: 'availability', igdb_id: 120, platform: 'ps5', status: 'available', precision: 'year', year: 2027, evidence: [{ source: 'publisher', url: 'https://zz.example.com', checked: day(5) }] }],
    ['an unknown source', { type: 'availability', igdb_id: 120, platform: 'ps5', status: 'available', precision: 'year', year: 2027, evidence: [{ source: 'forum', url: 'https://zz.example.com', checked: day(-1) }] }],
    ['an available release without a date', { type: 'availability', igdb_id: 120, platform: 'ps5', status: 'available', evidence: EV() }],
    ['an unknown relation', { type: 'relationship', igdb_id: 120, relation: 'sequel', evidence: EV('publisher', 'https://zz.example.com') }]]) {
    const before = app.writes().length;
    await app.ctx.gamesImportFindings(findings([f]));
    assert.match(app.el('errorBanner').innerHTML, /can’t be imported, so nothing was changed/, label);
    assert.strictEqual(app.writes().length, before, `${label}: nothing sent`);
  }
  await app.ctx.gamesImportFindings(JSON.stringify({ format: 'watchlist-research-findings', version: 1, findings: [] }));
  assert.match(app.el('errorBanner').innerHTML, /isn’t a games findings file/);
});

test('backup → restore with IGDB unavailable: a member’s whole games data comes back exactly — titles, statuses, priorities, collections, decisions, platforms and play style, ports, the mixed queue’s full order with its hidden game; a later Refresh fills details and changes no choice', async () => {
  const x = exampleQueue();
  const decisions = [{ id: ID('6d000000', 1), kind: 'not_out_yet', igdb_id: 140, platform: 'ps5', value: { date: day(-18), precision: 'day' }, basis: 'member', created_at: TS },
    { id: ID('6d000000', 2), kind: 'include_spinoff', igdb_id: 130, platform: '', value: {}, basis: 'member', created_at: TS },
    { id: ID('6d000000', 3), kind: 'research_role', igdb_id: 110, platform: '', value: { role: 'main', evidence: EV('publisher', 'https://zz.example.com'), research_date: day(-1) }, basis: 'research', created_at: TS }];
  const entries = [...x.entries, entry(3, 101, { ports: [103], status: 'finished', priority: 'high' }), entry(4, 140, { status: 'paused', priority: 'low' })];
  const collections = [{ id: ID('68000000', 1), name: 'ZZ Couch', created_at: TS }];
  const members = [{ id: ID('69000000', 1), collection_id: collections[0].id, entry_id: entries[1].id, created_at: TS }, { id: ID('69000000', 2), collection_id: collections[0].id, entry_id: entries[2].id, created_at: TS }];
  const src = await bootWith({ rows: x.rows, shows: x.shows, entries, queues: x.queues, follows: [follow(1, 7001, 'ZZ War')], decisions, collections, members, style: 'completionist' });
  const backup = JSON.parse(JSON.stringify(await src.ctx.buildBackupObject()));
  assert.strictEqual(backup.formatVersion, 9);
  assert.ok(!('game_titles' in backup.tables), 'no provider details in the file');
  assert.deepStrictEqual(Object.keys(backup.tables.game_entries[0]), ['id', 'igdb_id', 'spot_igdb_id', 'port_ids', 'title', 'status', 'priority', 'created_at', 'updated_at'], 'saved fields only');
  // Another device, an empty library and no IGDB: restore the file through the page.
  const dst = await bootWith({ rows: [], shows: [], settings: null, noCache: true, igdb: null, queues: { watch_queues: [], queue_entries: [] } });
  dst.ctx.openSettings(null); await settle();
  await dst.ctx.handleRestoreFileSelected({ target: { files: [{ text: async () => JSON.stringify(backup) }], value: 'x' } }); await settle();
  await dst.ctx.executeRestore(); await settle();
  await dst.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.match(dst.el('restoreModalBox').innerHTML, /restored and verified/);
  const pick = (st, t, keys) => st[t].map(r => keys.map(k => JSON.stringify(r[k])).join('|')).sort();
  for (const [t, keys] of [['game_entries', ['id', 'igdb_id', 'spot_igdb_id', 'port_ids', 'title', 'status', 'priority']], ['game_settings', ['platforms', 'play_style']], ['game_follows', ['igdb_collection_id', 'name']],
    ['game_decisions', ['kind', 'igdb_id', 'platform', 'value', 'basis']], ['game_collections', ['id', 'name']], ['game_collection_members', ['collection_id', 'entry_id']], ['queue_entries', ['id', 'queue_id', 'show_id', 'item_id', 'game_entry_id', 'position']]]) {
    assert.deepStrictEqual(pick(dst.store, t, keys), pick(src.store, t, keys), `${t} restored exactly`);
  }
  // Without IGDB details every saved game is still there, by its saved title and status; the queue shows every entry in order.
  await openGames(dst);
  assert.deepStrictEqual(libraryOrder(dst).length, 4, 'all four games listed (nothing hidden without details)');
  assert.match(text(rowOf(dst, entries[2].id)), /★ ZZ War 4 [\s\S]*Details not loaded yet: use Refresh/);
  assert.match(rowOf(dst, entries[2].id), /<option value="finished" selected>/);
  dst.ctx.openQueues(); await settle();
  assert.deepStrictEqual(queueOrder(dst), [x.E(1), x.E(2), x.E(3), x.E(4)], 'the full order, the Switch game included, at its place');
  // IGDB back: Refresh fills the details; no choice changes; the Switch game is hidden again in its place.
  dst.igdb = igdbStub(); // (the harness asks app.igdb on each request)
  const before = JSON.stringify(pick(dst.store, 'game_entries', ['status', 'priority', 'spot_igdb_id', 'port_ids', 'title'])) + JSON.stringify(pick(dst.store, 'game_decisions', ['kind', 'igdb_id', 'value'])) + JSON.stringify(pick(dst.store, 'queue_entries', ['id', 'position']));
  await openGames(dst);
  await dst.ctx.refreshGames(); await settle();
  assert.ok(dst.store.game_titles.length > 0, 'details cached again');
  assert.strictEqual(JSON.stringify(pick(dst.store, 'game_entries', ['status', 'priority', 'spot_igdb_id', 'port_ids', 'title'])) + JSON.stringify(pick(dst.store, 'game_decisions', ['kind', 'igdb_id', 'value'])) + JSON.stringify(pick(dst.store, 'queue_entries', ['id', 'position'])), before, 'no status, priority, link, decision or queue place changed');
  await openGames(dst);
  assert.match(text(rowOf(dst, entries[3].id)), /not out yet \(your hold\)/, 'the restored hold applies to the refreshed row');
  dst.ctx.openQueues(); await settle();
  assert.deepStrictEqual(queueOrder(dst), [x.E(1), x.E(3), x.E(4)], 'the Switch game is hidden again, its place kept');
});

// ── Review fixes (Fable, 2026-11-10) ──
test('a port record not read yet is never joined: saving reads it first, and joins it only when IGDB types it a port of that version', async () => {
  const raw = { ...RAW, 102: { ...RAW[102], ports: [105, 106] }, 105: { id: 105, name: 'ZZ War 4 Remastered Collection', game_type: 9, parent_game: 110, release_dates: [] },
    106: { id: 106, name: 'ZZ War 4 Remastered (Switch)', game_type: 11, parent_game: 102, release_dates: [rd(SWITCH, '2021-01-01')] } };
  const app = await bootWith({ igdb: igdbStub(raw), noCache: true });
  await openGames(app);
  app.ctx.openGamesAdd(null);
  app.run(`gamesAdd.related = new Map([[102, igdbRecord(${JSON.stringify(raw[102])})], [101, igdbRecord(${JSON.stringify(raw[101])})]])`);
  await app.ctx.saveGameRecord(102); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rpcs(app, 'library_game_add')[0].body)).p_port_ids, [106], 'the real port joins; a remaster of another game listed among the ports doesn’t');
});

test('Refresh joins a new port only after reading its record (also for a saved version a franchise read already brings)', async () => {
  const raw = { ...RAW, 102: { ...RAW[102], ports: [107, 108] }, 107: { id: 107, name: 'ZZ War 4 Remastered Ultimate', game_type: 3, release_dates: [] },
    108: { id: 108, name: 'ZZ War 4 Remastered (Switch)', game_type: 11, parent_game: 102, release_dates: [] } };
  const app = await bootWith({ igdb: igdbStub(raw), entries: [entry(1, 102, { spot: 101 })], follows: [follow(1, 7001, 'ZZ War')] });
  await openGames(app);
  await app.ctx.refreshGames(); await settle();
  assert.deepStrictEqual(app.store.game_entries[0].port_ids, [108], 'only the record IGDB types as its port');
});

test('a saved game IGDB retypes (an edition, a bundle) keeps counting for its stored spot; Review says so once', async () => {
  const f = follow(1, 7001, 'ZZ War');
  const app = await bootWith({ follows: [f], entries: [entry(1, 102, { spot: 101, status: 'finished' })] });
  const t = app.store.game_titles.find(x => x.igdb_id === 102);
  t.data.versionParent = 101;
  await openGames(app, 'gamesfranchises');
  assert.match(franchiseOf(app, f.id), /Up next: ZZ War \(2019\)/, 'the 2007 spot stays finished');
  assert.match(screen(app), /Review \(1\)/);
  app.ctx.openGamesReview(null);
  assert.match(text(dialog(app)), /IGDB now lists “ZZ War 4 Remastered” as an edition of another record\. It still counts for its franchise spot/);
  await app.ctx.reviewKeep(0); await settle();
  await openGames(app);
  assert.doesNotMatch(screen(app), /Review \(/, 'decided: not asked again while IGDB says the same');
  assert.strictEqual(app.store.game_entries[0].spot_igdb_id, 101);
});

test('no spot review while a saved version’s original hasn’t been read (after a restore onto an empty cache)', async () => {
  const app = await bootWith({ entries: [entry(1, 102, { spot: 101 })], cache: [102] });
  await openGames(app);
  assert.doesNotMatch(screen(app), /Review \(/);
});

test('Refresh: a saved game IGDB drops from a followed series leaves that franchise; a game in two followed series keeps both', async () => {
  const members = { 7001: [[101, 1], [110, 1], [120, 1], [130, 2]], 7002: [[170, 1], [110, 1]] }; // 102 dropped from ZZ War; 110 also in ZZ Saga
  const app = await bootWith({ igdb: igdbStub(RAW, members), entries: [entry(1, 102, { spot: 102 }), entry(2, 110)], follows: [follow(1, 7001, 'ZZ War'), follow(2, 7002, 'ZZ Saga')] });
  await openGames(app);
  await app.ctx.refreshGames(); await settle();
  const m = id => JSON.parse(JSON.stringify(app.store.game_titles.find(t => t.igdb_id === id).data.m));
  assert.deepStrictEqual(m(102), {}, 'no longer a member of ZZ War');
  assert.deepStrictEqual(m(110), { 7001: 'member', 7002: 'member' });
});

// ── Walkthrough fixes (2026-11-11): platform filtering in expanded franchises, status in franchise rows, the Library's order ──
const versionNames = app => [...tableOf(app).matchAll(/<td class="spot-version-name">([^<]+)/g)].map(m => m[1].trim());
const spotIds = app => [...tableOf(app).matchAll(/<tr class="sub-row spot-row[^"]*" data-follow-of="[^"]+" data-spot="(\d+)">/g)].map(m => Number(m[1]));
const rpcCalls = (app, fn) => app.writes().filter(r => r.url.includes(`/rpc/${fn}`)).map(r => JSON.parse(JSON.stringify(r.body)));
test('an expanded franchise lists only versions on the chosen platforms (PS4 playable on PS5, TBA and partial dates included) and no spot left with none; progress, Up next and saved data are unchanged, also switching platforms back and forth', async () => {
  RAW[135] = { id: 135, name: 'ZZ War Vita Tales', game_type: 0, first_release_date: unix('2012-02-15'), collections: [{ id: 7001, name: 'ZZ War' }], release_dates: [rd(PS3, '2012-02-15')] };
  MEMBERS[7001].push([135, 1]);
  try {
    const f = follow(1, 7001, 'ZZ War');
    const queues = { watch_queues: [{ id: ID('66000000', 9), name: 'ZZ Q', sort_order: 1, created_at: TS }],
      queue_entries: [{ id: ID('67000000', 9), queue_id: ID('66000000', 9), show_id: null, item_id: null, game_entry_id: ID('61000000', 2), position: 1, created_at: TS }] };
    const app = await bootWith({ follows: [f], entries: [entry(1, 101, { status: 'finished' }), entry(2, 110)], queues, cache: [101, 102, 103, 110, 120, 130, 135] });
    const before = JSON.stringify([app.store.game_entries, app.store.queue_entries, app.store.game_decisions]);
    const look = async () => { await openGames(app, 'gamesfranchises'); if (!app.get('gamesExpanded').has(f.id)) app.ctx.toggleFranchise(f.id); };
    const ps5 = async () => {
      await look();
      assert.deepStrictEqual(versionNames(app), ['ZZ War 4 Remastered', 'ZZ War Pocket', 'ZZ War (2019)', 'ZZ War Next'], 'the PS3 original and the PS3-only game are hidden; PS4 games playable on PS5 and the TBA one stay');
      assert.deepStrictEqual(spotIds(app), [101, 130, 110, 120], 'the PS3-only game’s spot is gone; the 2007 spot stays through its remaster');
      assert.doesNotMatch(tableOf(app), /Not on your platforms/);
      const open = text(screen(app));
      assert.match(open, /ZZ War 4 2007 Finished/, 'the hidden, finished original still completes its spot');
      assert.match(franchiseOf(app, f.id), /Up next: ZZ War \(2019\) · PS4 · Playable on PS5/);
      assert.match(franchiseOf(app, f.id), /Coming: ZZ War Next · PS5 · Date TBA/);
      assert.match(open, /2 versions aren’t on your platforms, so they are hidden here \(their progress still counts\)\./);
    };
    await ps5();
    app.store.game_settings[0].platforms = ['switch'];
    app.ctx.switchView('games'); await settle(); await look();
    assert.deepStrictEqual(spotIds(app), [], 'nothing of ZZ War is on Switch');
    assert.match(text(screen(app)), /6 versions aren’t on your platforms/);
    app.store.game_settings[0].platforms = ['ps5', 'ps4'];
    app.ctx.switchView('games'); await settle(); await look();
    assert.ok(versionNames(app).includes('ZZ War (2019)') && !versionNames(app).includes('ZZ War Vita Tales'), 'PS4 chosen: native PS4 versions');
    app.store.game_settings[0].platforms = ['ps5'];
    app.ctx.switchView('games'); await settle();
    await ps5();
    assert.strictEqual(JSON.stringify([app.store.game_entries, app.store.queue_entries, app.store.game_decisions]), before, 'visibility only: statuses, spots, queue places and decisions unchanged');
    assert.deepStrictEqual(app.writes().filter(r => !/functions\/v1\/igdb/.test(r.url)).map(r => r.url), [], 'no write');
  } finally { delete RAW[135]; MEMBERS[7001].pop(); }
});

test('a franchise with no platforms chosen lists every version; a saved version whose details are missing (after a restore) still shows in the Library', async () => {
  const app = await bootWith({ follows: [follow(1, 7001, 'ZZ War')], settings: null });
  await openGames(app, 'gamesfranchises'); app.ctx.toggleFranchise(ID('62000000', 1));
  assert.ok(versionNames(app).includes('ZZ War 4'), 'nothing chosen: everything shows');
  const restored = await bootWith({ entries: [entry(1, 101, { status: 'finished' })], igdb: null, noCache: true });
  await openGames(restored);
  assert.deepStrictEqual(libraryOrder(restored), [ID('61000000', 1)], 'missing IGDB details never hide a saved game');
});

test('a saved version’s status in its franchise row is the Library’s control and its guarded change: Up next, Caught up and queues follow at once, the franchise stays open, focus stays; Save hands focus to the new control', async () => {
  const f = follow(1, 7001, 'ZZ War');
  const queues = { watch_queues: [{ id: ID('66000000', 9), name: 'ZZ Q', sort_order: 1, created_at: TS }],
    queue_entries: [1, 2].map(k => ({ id: ID('67000000', k), queue_id: ID('66000000', 9), show_id: null, item_id: null, game_entry_id: ID('61000000', k), position: k, created_at: TS })) };
  const app = await bootWith({ follows: [f], entries: [entry(1, 102, { spot: 101 }), entry(2, 110)], queues });
  await openGames(app, 'gamesfranchises'); app.ctx.toggleFranchise(f.id);
  const sel = id => (tableOf(app).match(new RegExp(`<select class="status-select game-status [^"]*" data-gaction="status-v${id}" aria-label="([^"]+)"[^>]*>([\\s\\S]*?)</select>`)) || []);
  assert.strictEqual(sel(102)[1], 'Status of ZZ War 4 Remastered');
  assert.match(sel(102)[2], /<option value="want" selected>Want to play<\/option>/);
  assert.match(screen(app).split('</tbody>')[1], /data-gaction="status-v102"/, 'the card has it too');
  assert.doesNotMatch(tableOf(app), /status-pill s-confirmed">Want to play/, 'no plain status text');
  assert.match(franchiseOf(app, f.id), /Up next: ZZ War 4 Remastered/);
  // Keyboard: the select focused, Finished chosen.
  app.dom.focus('gamesScreen', '[data-gaction="status-v102"]');
  await app.ctx.setGameStatus(ID('61000000', 1), 'finished', 'franchise'); await settle();
  assert.deepStrictEqual(rpcCalls(app, 'library_game_set')[0], { p_entry_id: ID('61000000', 1), p_expected: { status: 'want', priority: 'normal' }, p_status: 'finished', p_priority: 'normal' }, 'the guarded change, with what was shown');
  assert.strictEqual(app.dom.active().getAttribute('data-gaction'), 'status-v102', 'focus stays on that version’s control');
  assert.ok(app.get('gamesExpanded').has(f.id), 'still expanded');
  assert.match(sel(102)[2], /<option value="finished" selected>/);
  assert.match(text(screen(app)), /ZZ War 4 2007 Finished/);
  assert.match(franchiseOf(app, f.id), /Up next: ZZ War \(2019\)/, 'Up next moves on');
  assert.deepStrictEqual(app.store.queue_entries.map(e => [e.game_entry_id, e.position]), [[ID('61000000', 2), 2]], 'Finished took that game out of its queue; the other keeps its place');
  assert.match(app.el('banner').innerHTML, /“ZZ War 4 Remastered” is Finished, so it left 1 queue\./);
  app.dom.focus('gamesScreen', '[data-gaction="status-v110"]');
  await app.ctx.setGameStatus(ID('61000000', 2), 'finished', 'franchise'); await settle();
  assert.match(franchiseOf(app, f.id), /Caught up/, 'every counted spot done');
  await app.ctx.toggleIncludeSpinoff(130, false); await settle();
  assert.match(franchiseOf(app, f.id), /Up next: ZZ War Pocket/, 'a counted spin-off becomes Up next');
  app.dom.focus('gamesScreen', '[data-gaction="save-130"]');
  await app.ctx.saveGameRecord(130); await settle();
  assert.strictEqual(app.dom.active().getAttribute('data-gaction'), 'status-v130', 'after Save, focus is on the new status control');
  const pocket = app.store.game_entries.find(e => e.igdb_id === 130);
  await app.ctx.setGameStatus(pocket.id, 'finished', 'franchise'); await settle();
  assert.match(franchiseOf(app, f.id), /Caught up/, 'finishing it returns the franchise to Caught up');
  assert.deepStrictEqual(app.store.game_entries.map(e => e.status), ['finished', 'finished', 'finished']);
});

test('the Library’s usual order (High first, then A to Z) doesn’t use status: a status change moves nothing, the same on redraw, reread and Refresh; an explicit sort with its directions applies at once, focus following the moved row', async () => {
  const app = await bootWith({ entries: [entry(1, 102), entry(2, 140), entry(3, 180), entry(4, 110, { priority: 'high' })] });
  await openGames(app);
  const usual = libraryOrder(app);
  assert.deepStrictEqual(usual, [4, 3, 2, 1].map(k => ID('61000000', k)), 'High first, then A to Z');
  app.dom.focus('gamesScreen', `[data-game="${ID('61000000', 3)}"] [data-gaction="status"]`);
  await app.ctx.setGameStatus(ID('61000000', 3), 'finished'); await settle();
  assert.deepStrictEqual(libraryOrder(app), usual, 'redrawn after the save: unchanged');
  await app.ctx.loadGamesView(); await settle();
  assert.deepStrictEqual(libraryOrder(app), usual, 'read again: the same');
  await app.ctx.refreshGames(); await settle();
  assert.deepStrictEqual(libraryOrder(app), usual, 'Refresh: the same');
  // Status (Playing first … Skipped last), then Title Z to A.
  app.ctx.chooseSortField('title'); app.ctx.reverseSortField('title'); app.ctx.chooseSortField('status');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.ctx.viewSortSpec(app.ctx.viewSortContext()))), [{ f: 'status', d: 'asc' }, { f: 'title', d: 'desc' }]);
  const sorted = libraryOrder(app);
  assert.deepStrictEqual(sorted, [1, 4, 2, 3].map(k => ID('61000000', k)), 'Want to play Z to A (“ZZ War 4…” after “ZZ War (2019)” A to Z), then the Finished one');
  app.dom.focus('gamesScreen', `[data-game="${ID('61000000', 1)}"] [data-gaction="status"]`);
  await app.ctx.setGameStatus(ID('61000000', 1), 'finished'); await settle();
  const moved = libraryOrder(app);
  assert.deepStrictEqual(moved, [4, 2, 1, 3].map(k => ID('61000000', k)), 'at once: the newly Finished game among the Finished, Z to A');
  const a = app.dom.active();
  assert.deepStrictEqual([a.closest('[data-game]').getAttribute('data-game'), a.getAttribute('data-gaction')], [ID('61000000', 1), 'status'], 'focus follows the moved row');
  await app.ctx.loadGamesView(); await settle();
  assert.deepStrictEqual(libraryOrder(app), moved, 'read again: the same order');
  app.ctx.reverseSortField('status');
  assert.deepStrictEqual(libraryOrder(app), [1, 3, 4, 2].map(k => ID('61000000', k)), 'reversed: Finished before Want to play, each still Z to A');
});

T.run();
