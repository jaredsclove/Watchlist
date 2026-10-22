// Offline tests for TMDB show ratings (next-gen item 2, first part; show-ratings.js) in the whole-page
// harness: the display rules (vote thresholds, missing and zero scores, rounding and colour bands),
// the per-device cache (per account), the one on-demand request when a show is expanded (none when the
// cached score is fresh, never repeated after a failure on the same page), the scores the page's own
// TMDB show reads leave, the tap / keyboard vote-count note, phone sizes and contrast (calculated, not
// rendered), and Settings' Credits. Ratings never write, and a missing or failed one leaves the
// ordinary controls in place.
// Run from the repo root: node tests/show-ratings.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createApp, runner, settle, userKeyOf } = require('./app-harness');

const T = runner('show-ratings');
const test = T.test;
const ROOT = path.join(__dirname, '..');
const KEY = 'watchlist-tmdb-show-ratings';
const DAY = 24 * 60 * 60 * 1000;

const TS = '2026-10-01T00:00:00+00:00';
let n = 0;
const uuid = p => `${p}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
// Synthetic shows: two matched to (made-up) TMDB ids, one by label only.
function library() {
  const show = (title, key, tmdbId, status = 'watching') => ({ id: uuid('6a000000'), collection: 'othertv', title, show_key: key, tmdb_id: tmdbId, status, created_at: TS });
  const a = show('ZZ Synthetic Alpha', 'zz-alpha', 900001), b = show('ZZ Synthetic Beta', 'zz-beta', 900002), c = show('ZZ Synthetic Local', 'zz-local', null);
  const season = (sh, num, o = {}) => ({ id: uuid('6b000000'), collection: 'othertv', title: sh.title, theme: 'Apple TV', status: 'confirmed', watched: false, skipped: false,
    show_id: sh.id, media_type: sh.tmdb_id ? 'tv' : null, tmdb_id: sh.tmdb_id, season_number: sh.tmdb_id ? num : null, season: `Season ${num}`,
    display_date: 'Jan 1, 2022', date_sort: `202${num}-01-01`, item_key: `${sh.show_key}|season ${num}`, watch_with: [], collections: [], created_at: TS,
    tmdb_collection_id: null, tmdb_collection_name: null, ...o });
  return { a, b, c, rows: [season(a, 1, { watched: true }), season(a, 2), season(b, 1), season(c, 1)], shows: [a, b, c] };
}
function memoryStorage(init = {}, { failWrites = false } = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { if (failWrites) throw new Error('quota'); m.set(k, String(v)); }, removeItem: k => m.delete(k), map: m };
}
const cached = entries => ({ [userKeyOf(KEY)]: JSON.stringify(entries) });
// TMDB show details for the synthetic ids (path → body); anything else is a 404.
const details = map => p => { const m = /^\/tv\/(\d+)$/.exec(p); return m && map[m[1]] !== undefined ? map[m[1]] : undefined; };
async function boot(o = {}) {
  const lib = library();
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows, tmdb: o.tmdb || details({}), storage: o.storage || memoryStorage(), width: o.width || 1200 });
  app.ctx.switchView(o.view || 'alltv'); await settle();
  return { app, lib };
}
const html = app => app.el('tbody').innerHTML;
const card = app => app.el('cardList').innerHTML;
const ratingReads = app => app.requests.filter(r => r.url.startsWith('https://api.themoviedb.org/3/tv/')).map(r => `${r.method} ${r.url.slice('https://api.themoviedb.org/3'.length)}`);
const writes = app => app.requests.filter(r => r.method !== 'GET' || (/\/rpc\//.test(r.url) && !r.url.endsWith('/rpc/stage5_capabilities')));

// ── Display rules (pure) ──
test('vote thresholds: fewer than 10 blank; 10–99 an asterisk and "Limited votes: N."; 100 and up plain, the count on tap/focus', async () => {
  const { app } = await boot();
  const m = e => app.ctx.showRatingModel(e);
  assert.strictEqual(m({ a: 8.2, c: 9 }), null, '9 votes: blank');
  assert.strictEqual(m({ a: 8.2, c: 0 }), null, '0 votes: blank');
  const ten = m({ a: 8.2, c: 10 });
  assert.strictEqual(ten.text, 'TMDB 8.2/10*'); assert.strictEqual(ten.note, 'Limited votes: 10.'); assert.ok(ten.limited);
  assert.strictEqual(m({ a: 8.2, c: 63 }).note, 'Limited votes: 63.');
  const ninetyNine = m({ a: 8.2, c: 99 });
  assert.strictEqual(ninetyNine.text, 'TMDB 8.2/10*');
  const hundred = m({ a: 8.2, c: 100 });
  assert.strictEqual(hundred.text, 'TMDB 8.2/10'); assert.strictEqual(hundred.note, 'TMDB votes: 100.'); assert.ok(!hundred.limited);
  assert.strictEqual(m({ a: 8.957, c: 18900 }).note, 'TMDB votes: 18,900.');
  assert.strictEqual(m({ a: 8.2, c: 63 }).label, 'TMDB rating 8.2 out of 10. Limited votes: 63.', 'a screen reader hears the count without opening it');
  assert.strictEqual(m({ a: 8.2, c: 1987 }).label, 'TMDB rating 8.2 out of 10. 1,987 votes.');
});

test('missing data: no score, a zero score, a score rounding to 0.0, no or an unusable vote count, or a nonsense score → blank (never "No TMDB score")', async () => {
  const { app } = await boot();
  const m = e => app.ctx.showRatingModel(e);
  for (const e of [null, undefined, {}, { a: null, c: 500 }, { a: 0, c: 500 }, { a: 0.04, c: 500 }, { a: -1, c: 500 }, { a: 10.5, c: 500 },
    { a: NaN, c: 500 }, { a: '8.2', c: 500 }, { a: 8.2 }, { a: 8.2, c: null }, { a: 8.2, c: 50.5 }, { a: 8.2, c: '500' }]) {
    assert.strictEqual(m(e), null, JSON.stringify(e));
  }
  assert.strictEqual(m({ a: 10, c: 500 }).text, 'TMDB 10.0/10', '10 is a valid score');
});

test('rounding to one decimal, and the colour band follows the rounded score (8.0+, 7.0–7.9, below 7.0)', async () => {
  const { app } = await boot();
  const r = a => { const x = app.ctx.showRatingModel({ a, c: 500 }); return `${x.text.slice(5, -3)} ${x.band}`; };
  assert.strictEqual(r(8.0), '8.0 high');
  assert.strictEqual(r(7.95), '8.0 high', '7.95 rounds to 8.0: green');
  assert.strictEqual(r(7.949), '7.9 mid');
  assert.strictEqual(r(7.0), '7.0 mid');
  assert.strictEqual(r(6.95), '7.0 mid', '6.95 rounds to 7.0: amber');
  assert.strictEqual(r(6.949), '6.9 low');
  assert.strictEqual(r(8.153), '8.2 high');
  assert.strictEqual(r(1.2), '1.2 low');
});

// ── In the views ──
test('a cached score shows with the show\'s categories, in rows and phone cards; an uncached show has an empty slot; a show not matched to TMDB has none', async () => {
  const now = Date.now();
  const { app, lib } = await boot({ storage: memoryStorage(cached({ 900001: { a: 8.153, c: 1987, t: now }, 900002: { a: 6.7, c: 50, t: now } })) });
  for (const s of [html(app), card(app)]) {
    assert.match(s, /<button type="button" class="tmdb-rating r-high" data-action="rating" aria-label="TMDB rating 8\.2 out of 10\. 1,987 votes\." onclick="toggleShowRatingNote\(this, event\)" onblur="this\.removeAttribute\('data-open'\)">TMDB 8\.2\/10<\/button><span class="tmdb-rating-note" aria-hidden="true">TMDB votes: 1,987\.<\/span>/);
    assert.match(s, /class="tmdb-rating r-low"[^>]*>TMDB 6\.7\/10\*<\/button><span class="tmdb-rating-note" aria-hidden="true">Limited votes: 50\.<\/span>/);
    assert.ok(!s.includes('No TMDB score'));
  }
  assert.ok(!html(app).includes(`data-rating-of="null"`), 'no slot for a show without a TMDB id');
  assert.strictEqual((html(app).match(/data-rating-of="/g) || []).length, 2, 'one slot per matched show in the rows');
  // The rating is in the categories cell, not in the title or the controls.
  const row = html(app).split('<tr').find(x => x.includes(`data-show-row="${lib.a.id}"`));
  const cells = row.split('<td');
  assert.ok(cells[2].includes('tmdb-rating'), 'the second cell (categories) holds it');
  assert.ok(!cells[1].includes('tmdb-rating') && !cells[4].includes('tmdb-rating'), 'not with the title or the status controls');
  // Currently Watching too.
  app.ctx.switchView('watching'); await settle();
  assert.match(html(app), /TMDB 8\.2\/10</);
  assert.strictEqual(writes(app).length, 0);
});

test('fewer than 10 votes, a zero score or a missing count in the cache: the slot stays empty', async () => {
  const now = Date.now();
  const { app } = await boot({ storage: memoryStorage(cached({ 900001: { a: 8.2, c: 9, t: now }, 900002: { a: 0, c: 0, t: now } })) });
  for (const s of [html(app), card(app)]) {
    assert.ok(s.includes('<span class="tmdb-rating-slot" data-rating-of="900001"></span>'));
    assert.ok(s.includes('<span class="tmdb-rating-slot" data-rating-of="900002"></span>'));
  }
});

// ── On demand ──
test('expanding an uncached show reads its TMDB show details once; the score is cached for this account and shown; expanding again reads nothing', async () => {
  const storage = memoryStorage();
  const { app, lib } = await boot({ storage, tmdb: details({ 900001: { id: 900001, vote_average: 7.91, vote_count: 603, seasons: [] } }) });
  assert.deepStrictEqual(ratingReads(app), [], 'nothing is read just to show a view');
  app.ctx.toggleDerivedShow(lib.a.id); await settle();
  assert.deepStrictEqual(ratingReads(app), ['GET /tv/900001']);
  app.ctx.renderTable();
  assert.match(html(app), /class="tmdb-rating r-mid"[^>]*>TMDB 7\.9\/10</);
  const stored = JSON.parse(storage.map.get(userKeyOf(KEY)));
  assert.deepStrictEqual(Object.keys(stored), ['900001']);
  assert.strictEqual(stored[900001].a, 7.91); assert.strictEqual(stored[900001].c, 603); assert.ok(Math.abs(stored[900001].t - Date.now()) < 5000);
  app.ctx.toggleDerivedShow(lib.a.id); await settle(); // collapse
  app.ctx.toggleDerivedShow(lib.a.id); await settle(); // expand again
  assert.deepStrictEqual(ratingReads(app), ['GET /tv/900001'], 'not read again');
  app.ctx.toggleDerivedShow(lib.c.id); await settle();
  assert.deepStrictEqual(ratingReads(app), ['GET /tv/900001'], 'a show not matched to TMDB reads nothing');
  assert.strictEqual(writes(app).length, 0, 'no write');
});

test('a fresh cached score (under 7 days) is not read again; an older one is read again on expansion and replaced', async () => {
  const now = Date.now();
  const storage = memoryStorage(cached({ 900001: { a: 8.2, c: 500, t: now - 6 * DAY }, 900002: { a: 7.2, c: 500, t: now - 8 * DAY } }));
  const { app, lib } = await boot({ storage, tmdb: details({ 900002: { vote_average: 7.6, vote_count: 520 } }) });
  app.ctx.toggleDerivedShow(lib.a.id); await settle();
  assert.deepStrictEqual(ratingReads(app), []);
  assert.match(html(app), /TMDB 7\.2\/10</, 'the older score shows until a newer one arrives');
  app.ctx.toggleDerivedShow(lib.b.id); await settle();
  assert.deepStrictEqual(ratingReads(app), ['GET /tv/900002']);
  app.ctx.renderTable();
  assert.match(html(app), /TMDB 7\.6\/10</);
  assert.ok(!html(app).includes('TMDB 7.2/10'));
});

test('request failures (an HTTP error, a network failure): nothing shown or cached, controls unchanged, no write, and not requested again on this page', async () => {
  for (const fail of [() => ({ __status: 500 }), () => { throw new Error('offline'); }]) {
    const storage = memoryStorage();
    const { app, lib } = await boot({ storage, tmdb: p => (p === '/tv/900001' ? fail() : undefined) });
    const before = html(app).replace(/ data-rating-of="\d+"/g, '');
    app.ctx.toggleDerivedShow(lib.a.id); await settle();
    app.ctx.toggleDerivedShow(lib.a.id); await settle();
    assert.strictEqual(html(app).replace(/ data-rating-of="\d+"/g, ''), before, 'the list is as it was (collapsed again)');
    app.ctx.toggleDerivedShow(lib.a.id); await settle();
    assert.deepStrictEqual(ratingReads(app), ['GET /tv/900001'], 'one attempt per page');
    assert.ok(html(app).includes('<span class="tmdb-rating-slot" data-rating-of="900001"></span>'));
    assert.ok(!storage.map.has(userKeyOf(KEY)), 'nothing cached');
    assert.match(html(app), /data-action="details"/, 'the expanded show\'s actions are there');
    assert.match(html(app), /data-action="status"/);
    assert.strictEqual(writes(app).length, 0);
    assert.deepStrictEqual(app.consoleErrors, []);
  }
});

test('an answer without scores is kept as "no score" (blank) so the show isn\'t read again until the entry is old', async () => {
  const storage = memoryStorage();
  const { app, lib } = await boot({ storage, tmdb: details({ 900002: { id: 900002, name: 'x' } }) });
  app.ctx.toggleDerivedShow(lib.b.id); await settle();
  const stored = JSON.parse(storage.map.get(userKeyOf(KEY)));
  assert.deepStrictEqual([stored[900002].a, stored[900002].c], [null, null]);
  app.ctx.renderTable();
  assert.ok(html(app).includes('<span class="tmdb-rating-slot" data-rating-of="900002"></span>'));
});

test('storage that refuses writes: the score still shows on this page (page memory); a broken stored value reads as empty', async () => {
  const storage = memoryStorage({ [userKeyOf(KEY)]: '{not json' }, { failWrites: true });
  const { app, lib } = await boot({ storage, tmdb: details({ 900001: { vote_average: 8.04, vote_count: 120 } }) });
  assert.ok(html(app).includes('<span class="tmdb-rating-slot" data-rating-of="900001"></span>'));
  app.ctx.toggleDerivedShow(lib.a.id); await settle();
  app.ctx.renderTable();
  assert.match(html(app), /class="tmdb-rating r-high"[^>]*>TMDB 8\.0\/10</);
  assert.deepStrictEqual(app.consoleErrors, []);
});

test('the cache belongs to the signed-in account: another account\'s entry isn\'t used', async () => {
  const other = '0a000000-0000-4000-8000-0000000000bb';
  const storage = memoryStorage({ [`${KEY}::${other}`]: JSON.stringify({ 900001: { a: 9.1, c: 900, t: Date.now() } }) });
  const { app } = await boot({ storage });
  assert.ok(!html(app).includes('TMDB 9.1'));
});

test('show details the page already reads (Refresh shows) leave scores in the cache without extra requests', async () => {
  const storage = memoryStorage();
  const { app } = await boot({ storage, tmdb: details({ 900001: { id: 900001, vote_average: 8.5, vote_count: 2000, seasons: [] }, 900002: { id: 900002, vote_average: 6.2, vote_count: 40, seasons: [] } }) });
  // The Refresh shows path's per-show hook, as library.js calls it with each show's details.
  app.ctx.noteShowRating(900001, { vote_average: 8.5, vote_count: 2000 });
  app.ctx.noteShowRating(900002, { vote_average: 6.2, vote_count: 40 });
  app.ctx.renderTable();
  assert.match(html(app), /TMDB 8\.5\/10</);
  assert.match(html(app), /TMDB 6\.2\/10\*</);
  assert.deepStrictEqual(ratingReads(app), []);
  const src = fs.readFileSync(path.join(ROOT, 'library.js'), 'utf8');
  assert.strictEqual((src.match(/noteShowRating\(show\.tmdb_id, (?:d|details)\)/g) || []).length, 2, 'Refresh shows and Add season both record the score');
  assert.match(fs.readFileSync(path.join(ROOT, 'tmdb-search.js'), 'utf8'), /if \(tmdbSelectedShow\.mediaType === 'tv'\) noteShowRating\(tmdbId, details\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'tmdb-match.js'), 'utf8'), /if \(picked\.mediaType === 'tv'\) noteShowRating\(picked\.id, details\)/);
});

test('the cache keeps at most 1000 entries, dropping the oldest', async () => {
  const entries = {};
  for (let i = 0; i < 1000; i++) entries[100000 + i] = { a: 7, c: 100, t: 1000 + i };
  const storage = memoryStorage(cached(entries));
  const { app } = await boot({ storage });
  app.ctx.noteShowRating(900001, { vote_average: 8, vote_count: 200 });
  const stored = JSON.parse(storage.map.get(userKeyOf(KEY)));
  assert.strictEqual(Object.keys(stored).length, 1000);
  assert.ok(!('100000' in stored) && '100001' in stored && '900001' in stored);
});

// ── The vote-count note: tap, click, keyboard ──
test('tap or click (Enter / Space activate a button) toggles the note without expanding the show; blur closes it; keyboard focus shows it (CSS)', async () => {
  const { app } = await boot();
  const attrs = new Map();
  const btn = { getAttribute: k => (attrs.has(k) ? attrs.get(k) : null), setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k) };
  let stopped = 0;
  const ev = { stopPropagation: () => { stopped++; } };
  app.ctx.toggleShowRatingNote(btn, ev);
  assert.strictEqual(btn.getAttribute('data-open'), '1'); assert.strictEqual(stopped, 1, 'the row\'s expand handler doesn\'t see the tap');
  app.ctx.toggleShowRatingNote(btn, ev);
  assert.strictEqual(btn.getAttribute('data-open'), null);
  // The row and card expand handlers also ignore a click that lands on a button (toggleDerivedShow).
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.match(css, /\.tmdb-rating-note \{ display: none;/);
  assert.match(css, /\.tmdb-rating\[data-open="1"\] \+ \.tmdb-rating-note, \.tmdb-rating:focus-visible \+ \.tmdb-rating-note \{ display: inline; \}/);
  assert.match(css, /\.tmdb-rating:focus-visible \{ outline: 2px solid var\(--accent\)/);
  // The note sits in the flow (no popup), so on a phone it wraps inside the card instead of overflowing.
  assert.match(css, /\.tmdb-rating-slot \{ display: inline-flex; align-items: center; flex-wrap: wrap;/);
});

test('focus: the rating is a list control found by identity (data-action="rating"), so a redraw returns focus to it', async () => {
  const now = Date.now();
  const { app, lib } = await boot({ storage: memoryStorage(cached({ 900001: { a: 8.2, c: 500, t: now } })) });
  const hook = app.ctx.focusHookOf({ closest: sel => {
    if (sel === '[data-item], [data-show-of]') return { getAttribute: a => (a === 'data-item' ? lib.a.id : null) };
    if (sel === '[data-action]') return { getAttribute: () => 'rating' };
    return null;
  } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(hook.hook)), { kind: 'action', value: 'rating', item: lib.a.id, season: null });
});

test('phones: the rating is a 44 px target; desktop and phone cards both carry it', async () => {
  const now = Date.now();
  const { app } = await boot({ width: 375, storage: memoryStorage(cached({ 900001: { a: 8.2, c: 500, t: now } })) });
  assert.match(card(app), /card-meta[\s\S]*?tmdb-rating r-high/);
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.match(css, /@media \(max-width: 700px\) \{\n  \.tmdb-rating \{ min-height: 44px; min-width: 44px; padding: 0 6px; \}/);
});

test('contrast: each band colour is 4.5:1 or more on the page, surface and surface2 in both schemes (calculated)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const tok = light => {
    const block = light ? css.match(/@media \(prefers-color-scheme: light\) \{\s*:root \{([\s\S]*?)\}\s*\}/)[1] : css.match(/^:root \{([\s\S]*?)\}/m)[1];
    return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map(m => [m[1], m[2]]));
  };
  const bands = light => {
    const at = light ? css.indexOf('.tmdb-rating.r-high', css.indexOf('@media (prefers-color-scheme: light) {\n  .tmdb-rating.r-high') ) : css.indexOf('.tmdb-rating.r-high');
    const part = css.slice(at, at + 200);
    return ['high', 'mid', 'low'].map(b => new RegExp(`\\.tmdb-rating\\.r-${b} \\{ color: (#[0-9a-fA-F]{6}); \\}`).exec(part)[1]);
  };
  for (const light of [false, true]) {
    const t = tok(light);
    for (const c of bands(light)) for (const bg of ['bg', 'surface', 'surface2']) {
      assert.ok(contrast(c, t[bg]) >= 4.5, `${light ? 'light' : 'dark'} ${c} on ${bg}: ${contrast(c, t[bg]).toFixed(2)}`);
    }
  }
});

// ── Credits ──
test('Settings ends with a Credits card: the official TMDB logo (unmodified file), the required notice, no popup', async () => {
  const { app } = await boot();
  app.ctx.openSettings(null); await settle();
  const s = app.el('settingsScreen').innerHTML;
  const cards = [...s.matchAll(/<section class="settings-card[^"]*" aria-labelledby="(\w+)"/g)].map(m => m[1]);
  assert.strictEqual(cards[cards.length - 1], 'settingsCreditsTitle', 'the last card');
  assert.match(s, /<h3 id="settingsCreditsTitle">Credits<\/h3>/);
  assert.match(s, /<img src="assets\/tmdb-logo\.svg" alt="TMDB \(The Movie Database\)" width="110" height="14">/);
  assert.ok(s.includes('<p class="settings-text">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>'));
  const svg = fs.readFileSync(path.join(ROOT, 'assets', 'tmdb-logo.svg'), 'utf8');
  assert.strictEqual(svg.length, 2065, 'the file as downloaded from TMDB\'s logos page');
  assert.ok(/^<svg /.test(svg) && !/<script|\son\w+=|href="http/i.test(svg), 'an image only');
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.match(css, /\.tmdb-credit-logo img \{ display: block; height: 14px; width: auto; \}/, 'smaller than the app\'s own 16 px name');
  assert.match(css, /\.settings-credits \{ grid-column: 1 \/ -1; \}/);
});

T.run();
