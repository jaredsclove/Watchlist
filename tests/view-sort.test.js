// Offline tests for sorting library views (next-gen item 13; view-sort.js) in the whole-page harness:
// successive sorts (the chosen field first, earlier fields breaking ties in their order), reversing a
// tie-breaker in place, unknown values last in either direction, the values sorting reads (Series
// premiere from TMDB's first-air date in this device's cache, never a stored season's date; Next
// unwatched season premiere from the row's up-next season; the shown rating), section boundaries
// (Currently Watching's two sections, Coming Soon's months and TBA, a collection's TV / Movies or All
// media), each collection layout's own menu and sort, Reset to default, ✕, focus, the rating note,
// remembering per member in this browser (Settings' toggle on and off), and the first-air date read
// when a show is expanded. Sorting never fetches or writes.
// Synthetic data only. Run from the repo root: node tests/view-sort.test.js
const assert = require('assert');
const { createApp, runner, settle, userKeyOf } = require('./app-harness');

const T = runner('view-sort');
const test = T.test;
const SORTS = 'watchlist_view_sorts', REMEMBER = 'watchlist_remember_sorts', RATINGS = 'watchlist-tmdb-show-ratings';
const OTHER_USER = '0a000000-0000-4000-8000-0000000000bb';
const DAY = 24 * 60 * 60 * 1000;
const TS = '2026-10-01T00:00:00+00:00';

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const show = (id, title, tmdb, status, o = {}) => ({ id, collection: 'othertv', title, show_key: title.toLowerCase(), tmdb_id: tmdb, status, priority: 'normal', created_at: TS, ...o });
const season = (s, num, date, o = {}) => ({ id: `${s.id}-s${num}`, collection: s.collection, title: s.title, theme: 'Net', status: 'confirmed', watched: false, skipped: false,
  show_id: s.id, media_type: 'tv', tmdb_id: s.tmdb_id, season_number: num, season: `Season ${num}`, display_date: /^\d/.test(date) ? date : date, date_sort: date === 'TBA' ? '2099-01-01' : date,
  item_key: `${s.show_key}|season ${num}`, watch_with: [], collections: [], created_at: TS, ...o });
const film = (id, title, date, o = {}) => ({ id, collection: 'disney', title, theme: 'Studio', status: 'confirmed', watched: false, skipped: false, media_type: null, tmdb_id: null,
  season_number: null, season: 'Film', display_date: date === 'TBA' ? 'TBA' : date, date_sort: date === 'TBA' ? '2099-01-01' : date, item_key: `${title.toLowerCase()}|film`,
  watch_with: [], collections: [], show_id: null, priority: 'normal', created_at: TS, ...o });

// The TV library. Ratings and first-air dates are this device's cache (fresh); Dune Show is stored from
// Season 4 only and its entry has no first-air date; Fir's TMDB entry says it has none (f: null).
function tvLibrary() {
  const A = show('show-a', 'Apple', 101, 'watching', { priority: 'high' });
  const B = show('show-b', 'Birch', 102, 'watching');
  const C = show('show-c', 'Cedar', 103, 'confirmed', { priority: 'low' });
  const D = show('show-d', 'Dune Show', 104, 'confirmed');
  const E = show('show-e', 'Elm', 105, 'skipped');
  const F = show('show-f', 'Fir', 106, 'watching', { priority: 'high' });
  const rows = [
    season(A, 1, '2010-05-01', { watched: true }), season(A, 2, '2012-05-01'),
    season(B, 1, '2018-03-01', { watched: true }), season(B, 2, '2019-03-01', { skipped: true }), season(B, 3, '2021-03-01'),
    season(C, 1, '2015-01-01'),
    season(D, 4, '2024-06-01'),
    season(E, 1, 'TBA', { display_date: 'TBA' }),
    season(F, 1, '2022-02-01', { watched: true })
  ];
  return { rows, shows: [A, B, C, D, E, F] };
}
const fresh = Date.now() - DAY;
const RATING_CACHE = {
  101: { a: 8.0, c: 500, f: '2010-05-01', t: fresh }, 102: { a: 8.04, c: 500, f: '2018-03-01', t: fresh }, 103: { a: 7.0, c: 500, f: '2015-01-01', t: fresh },
  104: { a: 9.0, c: 500, t: fresh }, 105: { a: 9.5, c: 5, f: '2020-01-01', t: fresh }, 106: { a: 7.96, c: 500, f: null, t: fresh }
};
function memoryStorage(init = {}, { failWrites = false } = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { if (failWrites) throw new Error('quota'); m.set(k, String(v)); }, removeItem: k => m.delete(k), map: m };
}
const withRatings = (extra = {}, user) => ({ [userKeyOf(RATINGS, user)]: JSON.stringify(RATING_CACHE), ...extra });
const otherSession = { access_token: 'harness-token', user: { id: OTHER_USER, email: 'member@test.invalid' } };
const details = map => p => { const m = /^\/tv\/(\d+)$/.exec(p); return m && map[m[1]] !== undefined ? map[m[1]] : undefined; };

async function boot(o = {}) {
  const lib = o.lib || tvLibrary();
  const storage = o.storage || memoryStorage(withRatings({}, o.session ? OTHER_USER : undefined));
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows, tmdb: o.tmdb || details({}), storage, session: o.session, width: o.width || 1200 });
  if (o.view !== null) { app.ctx.switchView(o.view || 'alltv'); await settle(); }
  if (o.allStatuses) setFilter(app, 'fStatus', 'all');
  trackFocus(app);
  return { app, lib, storage };
}
const setFilter = (app, id, value) => { app.el(id).value = value; app.ctx.renderTable(); };
// The list in order: '# Month' headings, '== section' headings, then each listed item's id.
function order(app) {
  const out = [];
  const re = /<tr class="year-group"><td[^>]*>([^<]*)<\/td>|<t[hd][^>]*data-section="(\w+)"|<button[^>]*data-section="(\w+)"|<tr [^>]*data-item="([^"]+)"[^>]*data-row-section/g;
  for (const m of app.el('tbody').innerHTML.matchAll(re)) {
    if (m[1]) out.push(`# ${m[1]}`);
    else if (m[2] || m[3]) out.push(`== ${m[2] || m[3]}`);
    else out.push(m[4]);
  }
  return out;
}
const ids = app => order(app).filter(x => !x.startsWith('#') && !x.startsWith('=='));
const S = x => `show-${x}`;
const line = app => app.el('sortLine').innerHTML;
const menuFields = app => { app.ctx.toggleSortMenu(true); const f = [...app.el('sortMenu').innerHTML.matchAll(/<span class="sort-option-label">([^<]*)</g)].map(m => m[1]); app.ctx.toggleSortMenu(false); return f; };
const arrows = app => [...line(app).matchAll(/<span class="sort-chip-label">([^<]*)<\/span><button[^>]*class="sort-dir"[^>]*>([↑↓])</g)].map(m => `${m[1]} ${m[2]}`);
// The control the page last focused (focusFilterTarget), recorded: the harness's toolbar elements don't take focus.
function trackFocus(app) {
  const orig = app.ctx.focusFilterTarget;
  app.ctx.focusFilterTarget = id => { app.lastFocus = id; orig(id); };
}
const focusedId = app => app.lastFocus;
const tmdbReads = app => app.requests.filter(r => r.url.startsWith('https://api.themoviedb.org/3/')).map(r => r.url.slice('https://api.themoviedb.org/3'.length));
const writes = app => app.requests.filter(r => r.method !== 'GET' || (/\/rpc\//.test(r.url) && !r.url.endsWith('/rpc/stage5_capabilities')));
const stored = (storage, user) => JSON.parse(storage.getItem(userKeyOf(SORTS, user)) || 'null');

// ── Successive sorts ──
test('successive sorts: newest Series premiere, then highest Rating → newer shows first among equal ratings; the usual order breaks the last ties', async () => {
  const { app } = await boot({ allStatuses: true });
  assert.deepStrictEqual(ids(app), ['a', 'b', 'c', 'd', 'e', 'f'].map(S), 'usual order: A–Z');
  assert.strictEqual(line(app), '', 'no sort line in the usual order');
  app.ctx.chooseSortField('premiere');
  // Elm 2020, Birch 2018, Cedar 2015, Apple 2010; unknown last by title: Dune Show (stored from Season 4, no first-air date), Fir (TMDB has none).
  assert.deepStrictEqual(ids(app), ['e', 'b', 'c', 'a', 'd', 'f'].map(S));
  app.ctx.chooseSortField('rating');
  // Dune 9.0; the 8.0s by premiere, newest first (Birch 2018, Apple 2010, Fir unknown); Cedar 7.0; Elm unrated (5 votes) last.
  assert.deepStrictEqual(ids(app), ['d', 'b', 'a', 'f', 'c', 'e'].map(S));
  assert.deepStrictEqual(arrows(app), ['Rating ↓', 'Series premiere ↓'], 'the active fields in order, each with its arrow');
  assert.match(line(app), /Reset to default/);
  assert.strictEqual(writes(app).length, 0, 'sorting writes nothing');
});

test('reversing a tie-breaker changes only its direction and keeps it in place; reversing the primary reverses its order with unknowns still last', async () => {
  const { app } = await boot({ allStatuses: true });
  app.ctx.chooseSortField('premiere'); app.ctx.chooseSortField('rating');
  app.ctx.reverseSortField('premiere');
  assert.deepStrictEqual(arrows(app), ['Rating ↓', 'Series premiere ↑'], 'still second');
  assert.deepStrictEqual(ids(app), ['d', 'a', 'b', 'f', 'c', 'e'].map(S), 'the 8.0s oldest first, unknown premiere still last; rating still primary');
  assert.strictEqual(focusedId(app), 'sortDir-premiere', 'focus stays on the reversed arrow');
  app.ctx.reverseSortField('rating');
  assert.deepStrictEqual(ids(app), ['c', 'a', 'b', 'f', 'd', 'e'].map(S), 'lowest first; unrated Elm still last');
  assert.match(line(app), /aria-label="Rating, lowest first\. Reverse to highest first"/);
});

test('choosing a field already in the sort makes it first with its own direction; choosing the first field again changes nothing', async () => {
  const { app } = await boot({ allStatuses: true });
  app.ctx.chooseSortField('premiere'); app.ctx.reverseSortField('premiere');
  app.ctx.chooseSortField('rating');
  app.ctx.chooseSortField('premiere');
  assert.deepStrictEqual(arrows(app), ['Series premiere ↑', 'Rating ↓'], 'moved first, kept ↑; rating behind it');
  const before = ids(app);
  app.ctx.chooseSortField('premiere');
  assert.deepStrictEqual(arrows(app), ['Series premiere ↑', 'Rating ↓']);
  assert.deepStrictEqual(ids(app), before);
  assert.strictEqual(focusedId(app), 'sortBtn', 'choosing from the list returns focus to Sort');
});

// ── The values ──
test('Next unwatched season premiere: the up-next season (skipped seasons passed over), earliest first; TBA and caught-up shows last either way', async () => {
  const { app } = await boot({ allStatuses: true });
  app.ctx.chooseSortField('next');
  // Apple S2 2012, Cedar 2015, Birch S3 2021 (S2 skipped), Dune S4 2024; Elm TBA and Fir (nothing left) last.
  assert.deepStrictEqual(ids(app), ['a', 'c', 'b', 'd', 'e', 'f'].map(S));
  app.ctx.reverseSortField('next');
  assert.deepStrictEqual(ids(app), ['d', 'b', 'c', 'a', 'e', 'f'].map(S));
});

test('Series premiere is TMDB’s first-air date only: a show stored from Season 4 without a cached date is unknown (never Season 4’s date), last in either direction', async () => {
  const { app } = await boot({ allStatuses: true });
  app.ctx.chooseSortField('premiere'); app.ctx.reverseSortField('premiere');
  assert.deepStrictEqual(ids(app), ['a', 'c', 'b', 'e', 'd', 'f'].map(S), 'oldest first; Dune Show and Fir still last');
  assert.strictEqual(app.ctx.showFirstAirDate(app.get('tvShowsById').get('show-d')), null);
  assert.strictEqual(app.ctx.showFirstAirDate(app.get('tvShowsById').get('show-f')), null);
});

test('Status: Watching → To Watch → Skipped, reversed by its arrow; Priority: High first; filters still decide what is listed', async () => {
  const { app } = await boot({ allStatuses: true });
  app.ctx.chooseSortField('status');
  assert.deepStrictEqual(ids(app), ['a', 'b', 'f', 'c', 'd', 'e'].map(S));
  app.ctx.reverseSortField('status');
  assert.deepStrictEqual(ids(app), ['e', 'c', 'd', 'a', 'b', 'f'].map(S));
  assert.match(line(app), /Status, Skipped first\. Reverse to Watching first/);
  app.ctx.resetViewSort(); app.ctx.chooseSortField('priority');
  assert.deepStrictEqual(ids(app), ['a', 'f', 'b', 'd', 'e', 'c'].map(S));
  setFilter(app, 'fStatus', '');
  assert.deepStrictEqual(ids(app), ['a', 'f', 'b', 'd', 'c'].map(S), 'the default status filter still leaves Skipped out');
});

test('menus: each view offers only its own fields', async () => {
  const { app } = await boot();
  assert.deepStrictEqual(menuFields(app), ['Title', 'Series premiere', 'Next unwatched season premiere', 'Rating', 'Status', 'Priority']);
  app.ctx.switchView('watching'); await settle();
  assert.deepStrictEqual(menuFields(app), ['Title', 'Series premiere', 'Next unwatched season premiere', 'Rating', 'Priority'], 'every show here is Watching');
  app.ctx.switchView('comingsoon'); await settle();
  assert.deepStrictEqual(menuFields(app), ['Title', 'Season premiere', 'Show rating', 'Status', 'Priority']);
  app.ctx.switchView('alltv'); await settle();
  app.ctx.setAllTvPresentation('seasons'); await settle();
  assert.ok(!app.el('filtersRow').innerHTML.includes('id="sortBtn"'), 'All TV Seasons is not sorted');
  assert.strictEqual(line(app), '');
});

// ── Sections ──
test('Currently Watching: sorted within In progress and within Caught up; nothing crosses a section', async () => {
  const { app } = await boot({ view: 'watching' });
  assert.deepStrictEqual(order(app), ['== inprogress', S('a'), S('b'), '== uptodate', S('f')]);
  app.ctx.chooseSortField('premiere');
  assert.deepStrictEqual(order(app), ['== inprogress', S('b'), S('a'), '== uptodate', S('f')]);
});

function comingSoonLibrary() {
  const m = new Date(); m.setDate(1); m.setMonth(m.getMonth() + 2);
  const ym = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
  const n = new Date(m); n.setMonth(n.getMonth() + 1);
  const ym2 = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
  const G = show('show-g', 'Gale', 201, 'watching'), H = show('show-h', 'Hollow', 202, 'confirmed'), I = show('show-i', 'Ivy', 203, 'confirmed'), J = show('show-j', 'Juniper', 204, 'confirmed');
  const rows = [season(G, 1, `${ym}-03`), season(G, 2, `${ym2}-05`), season(H, 1, `${ym}-28`), season(I, 1, `${ym}-10`), season(J, 1, 'TBA', { display_date: 'TBA' }), season(I, 2, 'TBA', { display_date: 'TBA' })];
  const cache = { 201: { a: 7.5, c: 500, f: '2001-01-01', t: fresh }, 202: { a: 8.5, c: 500, f: '2002-01-01', t: fresh }, 203: { a: 8.5, c: 500, f: '2003-01-01', t: fresh }, 204: { a: 9.0, c: 500, f: '2004-01-01', t: fresh } };
  return { lib: { rows, shows: [G, H, I, J] }, cache };
}
test('Coming Soon: Season premiere within each month (Nov 28 before Nov 3), months in date order and TBA last; Show rating first with premiere breaking ties either way', async () => {
  const { lib, cache } = comingSoonLibrary();
  const { app } = await boot({ lib, view: 'comingsoon', storage: memoryStorage({ [userKeyOf(RATINGS)]: JSON.stringify(cache) }) });
  app.ctx.toggleDerivedSection('tba'); await settle();
  const months = order(app).filter(x => x.startsWith('#'));
  assert.strictEqual(months.length, 2);
  const usual = ['show-g-s1', 'show-i-s1', 'show-h-s1', 'show-g-s2', 'show-i-s2', 'show-j-s1'];
  assert.deepStrictEqual(ids(app), usual, 'premiere, then title (TBA: Ivy before Juniper)');
  app.ctx.chooseSortField('season');
  assert.deepStrictEqual(ids(app), usual, 'Season premiere earliest first is the usual order');
  app.ctx.reverseSortField('season');
  assert.deepStrictEqual(order(app).filter(x => x.startsWith('#')), months, 'month headings stay in date order');
  assert.deepStrictEqual(ids(app), ['show-h-s1', 'show-i-s1', 'show-g-s1', 'show-g-s2', 'show-i-s2', 'show-j-s1'], 'the 28th before the 10th before the 3rd; TBA still last');
  assert.ok(order(app).indexOf('== tba') > order(app).indexOf('show-g-s2'), 'TBA after every month');
  app.ctx.chooseSortField('rating');
  assert.deepStrictEqual(arrows(app), ['Show rating ↓', 'Season premiere ↓']);
  assert.deepStrictEqual(ids(app), ['show-h-s1', 'show-i-s1', 'show-g-s1', 'show-g-s2', 'show-j-s1', 'show-i-s2'], 'equal 8.5s: the 28th first; TBA by rating');
  app.ctx.reverseSortField('season');
  assert.deepStrictEqual(ids(app), ['show-i-s1', 'show-h-s1', 'show-g-s1', 'show-g-s2', 'show-j-s1', 'show-i-s2'], 'the tie-breaker reversed in place');
  app.ctx.chooseSortField('status');
  assert.deepStrictEqual(ids(app).slice(0, 3), ['show-g-s1', 'show-i-s1', 'show-h-s1'], 'Watching first within the month, then the rest by rating and premiere');
});

// ── Collections ──
function collectionLibrary() {
  const P = show('show-p', 'Pine', 301, 'watching', { collection: 'disney' }), Q = show('show-q', 'Quince', 302, 'confirmed', { collection: 'disney' });
  const rows = [season(P, 1, '2019-04-01', { watched: true }), season(P, 2, '2023-04-01'), season(Q, 1, '2005-09-01'),
    film('film-r', 'Rowan', '2021-07-09', { watched: true }), film('film-s', 'Sage', '2001-01-01', { priority: 'high' }), film('film-t', 'Teak', 'TBA'),
    film('film-u', 'Umber', '2010-01-01', { status: 'skipped' })];
  const cache = { 301: { a: 8.2, c: 500, f: '2019-04-01', t: fresh }, 302: { a: 6.5, c: 8, f: '2005-09-01', t: fresh } };
  return { lib: { rows, shows: [P, Q] }, cache };
}
const DISNEY = 'browse:0c000000-0000-4000-8000-000000000001';
async function bootCollection(o = {}) {
  const { lib, cache } = collectionLibrary();
  const storage = o.storage || memoryStorage({ [userKeyOf(RATINGS)]: JSON.stringify(cache) });
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows, tmdb: details({}), storage, width: 1200 });
  app.ctx.openBrowseCollection(DISNEY); await settle();
  return { app, storage };
}
test('a collection: Separate sorts within TV and within Movies; Combined mixes them (films unrated and without an up-next season, so last there)', async () => {
  const { app } = await bootCollection();
  assert.deepStrictEqual(menuFields(app), ['Title', 'Premiere or release', 'Next unwatched season premiere', 'Rating', 'Status', 'Priority']);
  app.ctx.chooseSortField('premiere');
  assert.deepStrictEqual(order(app), ['== tv', S('p'), S('q'), '== film', 'film-r', 'film-s', 'film-t'], 'newest first within each section; TBA last');
  app.ctx.setBrowseGrouping('combined'); await settle();
  assert.deepStrictEqual(ids(app), ['film-r', S('p'), S('q'), 'film-s', 'film-t'], 'one section: 2021, 2019, 2005, 2001, TBA');
  app.ctx.chooseSortField('rating');
  assert.deepStrictEqual(ids(app), [S('p'), 'film-r', S('q'), 'film-s', 'film-t'], 'Pine 8.2; Quince (8 votes) and the films unrated, by premiere');
  app.ctx.chooseSortField('status');
  assert.deepStrictEqual(ids(app), [S('p'), S('q'), 'film-s', 'film-t', 'film-r'], 'Watching, To Watch (shows and films), Watched');
  assert.match(line(app), /Some shows have no rating on this device\./, 'Quince has too few votes to show a rating');
});

test('each collection layout has its own menu and keeps its own sort: Movies only offers Title, Release date, Status, Priority; switching back restores each order; Seasons has none', async () => {
  const { app, storage } = await bootCollection();
  app.ctx.chooseSortField('premiere');
  const allMedia = order(app);
  app.ctx.setBrowseMedia('movie'); await settle();
  assert.deepStrictEqual(menuFields(app), ['Title', 'Release date', 'Status', 'Priority']);
  assert.strictEqual(line(app), '', 'Movies only starts in its usual order');
  app.ctx.chooseSortField('title'); app.ctx.reverseSortField('title');
  assert.deepStrictEqual(ids(app), ['film-t', 'film-s', 'film-r']);
  assert.deepStrictEqual(arrows(app), ['Title ↓']);
  app.ctx.setBrowseMedia('all'); await settle();
  assert.deepStrictEqual(order(app), allMedia, 'All media’s sort is back');
  assert.deepStrictEqual(arrows(app), ['Premiere or release ↓']);
  app.ctx.setBrowseMedia('tv'); await settle();
  assert.deepStrictEqual(menuFields(app), ['Title', 'Series premiere', 'Next unwatched season premiere', 'Rating', 'Status', 'Priority']);
  app.ctx.setBrowseMedia('movie'); await settle();
  assert.deepStrictEqual(ids(app), ['film-t', 'film-s', 'film-r'], 'Movies only’s sort is back');
  app.ctx.setBrowseMedia('all'); await settle();
  app.ctx.setBrowsePresentation('seasons'); await settle();
  assert.ok(!app.el('filtersRow').innerHTML.includes('id="sortBtn"'), 'Seasons is chronological: no Sort');
  assert.strictEqual(line(app), '');
  app.ctx.setBrowsePresentation('shows'); await settle();
  assert.deepStrictEqual(order(app), allMedia);
  const saved = stored(storage).views;
  assert.deepStrictEqual(Object.keys(saved).sort(), [`${DISNEY}:all`, `${DISNEY}:movie`], 'saved per collection and layout');
});

test('All Movies: Release date newest first, TBA last either way; Status To Watch → Watched → Skipped', async () => {
  const { app } = await bootCollection();
  app.ctx.switchView('allmovies'); await settle();
  setFilter(app, 'fWatch', ''); setFilter(app, 'fStatus', 'all');
  assert.deepStrictEqual(menuFields(app), ['Title', 'Release date', 'Status', 'Priority']);
  app.ctx.chooseSortField('premiere');
  assert.deepStrictEqual(ids(app), ['film-r', 'film-u', 'film-s', 'film-t']);
  app.ctx.reverseSortField('premiere');
  assert.deepStrictEqual(ids(app), ['film-s', 'film-u', 'film-r', 'film-t']);
  app.ctx.chooseSortField('status');
  assert.deepStrictEqual(ids(app), ['film-s', 'film-t', 'film-r', 'film-u']);
});

// ── Reset, ✕ and focus ──
test('Reset to default: shown whenever the view has its own sort; clears every field at once; other views keep theirs; ✕ removes one field', async () => {
  const { app } = await boot({ allStatuses: true });
  app.ctx.chooseSortField('premiere'); app.ctx.chooseSortField('rating'); app.ctx.chooseSortField('priority');
  app.ctx.removeSortField('rating');
  assert.deepStrictEqual(arrows(app), ['Priority ↓', 'Series premiere ↓'], '✕ takes one field out');
  assert.strictEqual(focusedId(app), 'sortDir-premiere', 'focus: the next field’s arrow');
  app.ctx.removeSortField('premiere');
  assert.strictEqual(focusedId(app), 'sortDir-priority', 'else the previous one’s');
  app.ctx.chooseSortField('rating');
  app.ctx.switchView('watching'); await settle();
  app.ctx.chooseSortField('premiere');
  app.ctx.switchView('alltv'); await settle(); setFilter(app, 'fStatus', 'all');
  assert.ok(app.el('sortReset'), 'Reset to default is shown');
  app.ctx.resetViewSort();
  assert.strictEqual(line(app), '', 'no fields left');
  assert.deepStrictEqual(ids(app), ['a', 'b', 'c', 'd', 'e', 'f'].map(S), 'the usual order');
  assert.strictEqual(focusedId(app), 'sortBtn');
  app.ctx.switchView('watching'); await settle();
  assert.deepStrictEqual(arrows(app), ['Series premiere ↓'], 'Currently Watching keeps its own sort');
});

test('keyboard: the Sort list is a disclosure; Escape closes it and focuses Sort; its options name the direction and position', async () => {
  const { app } = await boot();
  app.ctx.chooseSortField('rating');
  app.ctx.toggleSortMenu();
  assert.strictEqual(app.el('sortMenu').hidden, false);
  assert.strictEqual(app.el('sortBtn').attrs['aria-expanded'], 'true');
  const menu = app.el('sortMenu').innerHTML;
  assert.match(menu, /aria-label="Rating, highest first: sorted by this first"/);
  assert.match(menu, /aria-label="Sort by Series premiere first, newest first"/);
  let prevented = false;
  app.ctx.sortMenuKeydown({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.ok(prevented);
  assert.strictEqual(app.el('sortMenu').hidden, true);
  assert.strictEqual(app.el('sortBtn').attrs['aria-expanded'], 'false');
  assert.strictEqual(focusedId(app), 'sortBtn');
});

test('a row whose value changes moves at the next redraw; the rating note shows only while a rating field is active and a listed show has none', async () => {
  const { app } = await boot({ allStatuses: true });
  app.ctx.chooseSortField('premiere');
  assert.ok(!line(app).includes('sortRatingNote'));
  app.ctx.chooseSortField('rating');
  assert.match(line(app), /<span class="sort-note" id="sortRatingNote">Some shows have no rating on this device\.<\/span>/, 'Elm has too few votes');
  setFilter(app, 'fStatus', '');
  assert.ok(!line(app).includes('sortRatingNote'), 'Elm not listed: no note');
  app.get('tvShowsById').get('show-c').priority = 'high';
  app.ctx.resetViewSort(); app.ctx.chooseSortField('priority');
  assert.deepStrictEqual(ids(app).slice(0, 3), ['a', 'c', 'f'].map(S));
});

// ── Remembering ──
test('remembering on (the default): each view’s full field order and directions come back after a reload, separately for each member in this browser; a reset survives a reload', async () => {
  const storage = memoryStorage({ ...withRatings(), ...withRatings({}, OTHER_USER) });
  const { app } = await boot({ storage, allStatuses: true });
  app.ctx.chooseSortField('premiere'); app.ctx.chooseSortField('rating'); app.ctx.reverseSortField('premiere');
  app.ctx.switchView('watching'); await settle(); app.ctx.chooseSortField('next');
  assert.deepStrictEqual(stored(storage).views, { alltv: [{ f: 'rating', d: 'desc' }, { f: 'premiere', d: 'asc' }], watching: [{ f: 'next', d: 'asc' }] });
  const { app: again } = await boot({ storage, allStatuses: true });
  assert.deepStrictEqual(arrows(again), ['Rating ↓', 'Series premiere ↑']);
  assert.deepStrictEqual(ids(again), ['d', 'a', 'b', 'f', 'c', 'e'].map(S));
  const { app: other } = await boot({ storage, session: otherSession, allStatuses: true });
  assert.strictEqual(line(other), '', 'another member in the same browser starts in the usual order');
  other.ctx.chooseSortField('title'); other.ctx.reverseSortField('title');
  assert.deepStrictEqual(stored(storage, OTHER_USER).views, { alltv: [{ f: 'title', d: 'desc' }] });
  again.ctx.resetViewSort();
  assert.deepStrictEqual(stored(storage).views, { watching: [{ f: 'next', d: 'asc' }] }, 'the reset is saved; other views keep theirs');
  const { app: third } = await boot({ storage, allStatuses: true });
  assert.strictEqual(line(third), '', 'the reset survives a reload');
  third.ctx.switchView('watching'); await settle();
  assert.deepStrictEqual(arrows(third), ['Next unwatched season premiere ↑']);
  assert.deepStrictEqual(stored(storage, OTHER_USER).views, { alltv: [{ f: 'title', d: 'desc' }] }, 'the other member’s sort untouched');
});

test('remembering off: switching views keeps each sort while open; turning it off forgets this member’s saved sorts in every view; a reload starts in the usual order; turning it on saves the open page’s', async () => {
  const storage = memoryStorage({ ...withRatings(), ...withRatings({}, OTHER_USER) });
  const { app: other } = await boot({ storage, session: otherSession });
  other.ctx.chooseSortField('rating');
  const { app } = await boot({ storage, allStatuses: true });
  app.ctx.chooseSortField('premiere');
  app.ctx.switchView('watching'); await settle(); app.ctx.chooseSortField('next');
  app.ctx.switchView('settings'); await settle();
  const settings = app.el('settingsScreen').innerHTML;
  assert.match(settings, /<input type="checkbox" class="settings-remember-sorts" checked onchange="setRememberViewSorts\(this\.checked\)"> Remember each view’s sort when I reopen Watchlist<\/label>/);
  app.ctx.setRememberViewSorts(false);
  assert.strictEqual(storage.getItem(userKeyOf(SORTS)), null, 'every saved sort of this member is gone');
  assert.strictEqual(storage.getItem(userKeyOf(REMEMBER)), 'off');
  assert.deepStrictEqual(stored(storage, OTHER_USER).views, { alltv: [{ f: 'rating', d: 'desc' }] }, 'another member’s are kept');
  app.ctx.switchView('alltv'); await settle();
  assert.deepStrictEqual(arrows(app), ['Series premiere ↓'], 'the open page keeps its sorts');
  app.ctx.chooseSortField('rating');
  app.ctx.switchView('watching'); await settle();
  assert.deepStrictEqual(arrows(app), ['Next unwatched season premiere ↑']);
  assert.strictEqual(storage.getItem(userKeyOf(SORTS)), null, 'nothing saved while off');
  const { app: reloaded } = await boot({ storage, allStatuses: true });
  assert.strictEqual(line(reloaded), '', 'a reload starts in the usual order');
  reloaded.ctx.chooseSortField('priority');
  reloaded.ctx.switchView('settings'); await settle();
  reloaded.ctx.setRememberViewSorts(true);
  assert.deepStrictEqual(stored(storage).views, { alltv: [{ f: 'priority', d: 'desc' }] }, 'on: the open page’s sorts are saved');
  const { app: last } = await boot({ storage, allStatuses: true });
  assert.deepStrictEqual(arrows(last), ['Priority ↓']);
});

test('storage that refuses writes: sorts hold for the open page; the Settings choice says it applies only until the page closes', async () => {
  const storage = memoryStorage(withRatings(), { failWrites: true });
  const { app } = await boot({ storage, allStatuses: true });
  app.ctx.chooseSortField('rating');
  app.ctx.switchView('watching'); await settle();
  app.ctx.switchView('alltv'); await settle();
  assert.deepStrictEqual(arrows(app), ['Rating ↓']);
  app.ctx.switchView('settings'); await settle();
  app.ctx.setRememberViewSorts(false);
  assert.match(app.el('settingsSortNote').textContent, /applies only until this page is closed or reloaded/);
});

// ── The first-air date: expansion, never sorting ──
test('a show with a fresh rating cached before this release (no first-air date) reads its details on its first expansion; the date is kept and sorts it; sorting never fetches', async () => {
  const { app, storage } = await boot({ allStatuses: true, tmdb: details({ 104: { vote_average: 9.0, vote_count: 510, first_air_date: '2009-09-09' }, 105: { vote_average: 9.5, vote_count: 5, first_air_date: '' } }) });
  ['premiere', 'rating', 'next', 'status', 'priority', 'title'].forEach(f => app.ctx.chooseSortField(f));
  app.ctx.reverseSortField('rating'); app.ctx.resetViewSort(); app.ctx.chooseSortField('premiere');
  assert.deepStrictEqual(tmdbReads(app), [], 'sorting reads nothing');
  app.ctx.toggleDerivedShow('show-d'); await settle();
  assert.deepStrictEqual(tmdbReads(app), ['/tv/104'], 'its first expansion reads the missing date');
  const entry = JSON.parse(storage.getItem(userKeyOf(RATINGS)))[104];
  assert.strictEqual(entry.f, '2009-09-09');
  app.ctx.toggleDerivedShow('show-d'); app.ctx.toggleDerivedShow('show-d'); await settle();
  assert.deepStrictEqual(tmdbReads(app), ['/tv/104'], 'once');
  app.ctx.renderTable();
  assert.deepStrictEqual(ids(app), ['e', 'b', 'c', 'a', 'd', 'f'].map(S), 'Dune Show (2009) now sorts after Apple (2010)');
  app.ctx.toggleDerivedShow('show-f'); app.ctx.toggleDerivedShow('show-a'); await settle();
  assert.deepStrictEqual(tmdbReads(app), ['/tv/104'], 'entries with a date, or known to have none (f: null), read nothing');
  assert.strictEqual(writes(app).length, 0);
});

test('TMDB has no first-air date: kept as unknown (f: null) under the usual cache rules, so the show isn’t read again until the entry is old', async () => {
  const cache = { ...RATING_CACHE, 104: { a: 9.0, c: 500, t: fresh } };
  const storage = memoryStorage({ [userKeyOf(RATINGS)]: JSON.stringify(cache) });
  const { app } = await boot({ storage, tmdb: details({ 104: { vote_average: 9.0, vote_count: 510, first_air_date: '' } }) });
  app.ctx.toggleDerivedShow('show-d'); await settle();
  assert.deepStrictEqual(tmdbReads(app), ['/tv/104']);
  assert.strictEqual(JSON.parse(storage.getItem(userKeyOf(RATINGS)))[104].f, null);
  const { app: again } = await boot({ storage, tmdb: details({ 104: { vote_average: 9.0, vote_count: 510, first_air_date: '2009-09-09' } }) });
  again.ctx.toggleDerivedShow('show-d'); await settle();
  assert.deepStrictEqual(tmdbReads(again), [], 'a fresh entry known to have no date isn’t read again on a new page');
  const old = JSON.parse(storage.getItem(userKeyOf(RATINGS)));
  old[104].t = Date.now() - 8 * DAY;
  storage.setItem(userKeyOf(RATINGS), JSON.stringify(old));
  const { app: later } = await boot({ storage, tmdb: details({ 104: { vote_average: 9.0, vote_count: 510, first_air_date: '2009-09-09' } }) });
  later.ctx.toggleDerivedShow('show-d'); await settle();
  assert.deepStrictEqual(tmdbReads(later), ['/tv/104'], 'an old entry is read again, as for scores');
  assert.strictEqual(JSON.parse(storage.getItem(userKeyOf(RATINGS)))[104].f, '2009-09-09');
});

test('Refresh shows’ show details fill first-air dates; details without the field keep the date already known', async () => {
  const { app, storage } = await boot();
  app.ctx.noteShowRating(103, { vote_average: 7.1, vote_count: 600 });
  assert.strictEqual(JSON.parse(storage.getItem(userKeyOf(RATINGS)))[103].f, '2015-01-01', 'no first_air_date field: kept');
  app.ctx.noteShowRating(104, { vote_average: 9.0, vote_count: 600, first_air_date: '2009-09-09' });
  assert.strictEqual(app.ctx.showFirstAirDate(app.get('tvShowsById').get('show-d')), '2009-09-09');
  app.ctx.noteShowRating(106, { vote_average: 8, vote_count: 600, first_air_date: 'soon' });
  assert.strictEqual(JSON.parse(storage.getItem(userKeyOf(RATINGS)))[106].f, null, 'not a real date: unknown');
});

T.run();
