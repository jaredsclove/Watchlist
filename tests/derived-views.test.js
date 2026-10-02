// Offline tests for the derived TV views (derived-views.js): the Currently
// Watching and Coming Soon rules, their rendering, and the season-row extraction
// in render.js that the grouped tabs share with Currently Watching.
// Run from the repo root: node tests/derived-views.test.js
// No network, no database (see tests/app-harness.js).
const assert = require('assert');
const { createApp, runner } = require('./app-harness');

const T = runner('derived-views');
const test = T.test;

// Dates relative to the real local today, so render tests don't go stale.
function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const disp = iso => { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const TODAY = day(0);

let n = 0;
// A dynamic TV season row (othertv) unless overridden.
function tv(o = {}) {
  const num = o.season_number !== undefined ? o.season_number : 1;
  const date = o.date_sort || '2020-01-01';
  return {
    id: o.id || `r${String(++n).padStart(4, '0')}`,
    collection: 'othertv', title: 'Show', theme: 'HBO', status: 'confirmed', watched: false,
    media_type: 'tv', tmdb_id: 100, season_number: num,
    season: num === 0 ? 'Specials' : `Season ${num}`,
    display_date: disp(date), date_sort: date, item_key: '', watch_with: [], collections: [],
    ...o
  };
}
const tba = o => tv({ display_date: 'TBA', date_sort: '2099-01-01', ...o });
// A legacy/static row (no TMDB identity), e.g. on the Disney+ tab.
const legacy = o => tv({ collection: 'disney', media_type: null, tmdb_id: null, season_number: null, theme: 'Star Wars', ...o });
const ids = list => Array.from(list, r => r.id);

let ctx; // pure functions only need the scripts loaded
async function pure() { if (!ctx) ctx = (await createApp()).ctx; return ctx; }

// ─── Currently Watching rules ─────────────────────────────────────────────────
test('one Watching unwatched season is the up-next season', async () => {
  const c = await pure();
  const s1 = tv({ status: 'watching' });
  const { active, upToDate } = c.deriveCurrentlyWatching([s1], TODAY);
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].upNext.id, s1.id);
  assert.strictEqual(upToDate.length, 0);
});

test('earliest Watching && !watched wins (S1 complete, S2 watched, S3/S4 unwatched → S3)', async () => {
  const c = await pure();
  const rows = [
    tv({ season_number: 4, status: 'watching', date_sort: '2023-01-01' }),
    tv({ season_number: 1, status: 'complete', watched: true }),
    tv({ season_number: 3, status: 'watching', date_sort: '2022-01-01' }),
    tv({ season_number: 2, status: 'watching', watched: true, date_sort: '2021-01-01' }),
  ];
  const { active } = c.deriveCurrentlyWatching(rows, TODAY);
  assert.strictEqual(active[0].upNext.season_number, 3);
});

test('earliest qualifying season wins even when it is future-dated', async () => {
  const c = await pure();
  const rows = [tv({ season_number: 1, status: 'watching', watched: true }),
    tv({ season_number: 2, status: 'watching', date_sort: day(40) }),
    tv({ season_number: 3, status: 'watching', date_sort: day(400) })];
  const [show] = c.deriveCurrentlyWatching(rows, TODAY).active;
  assert.strictEqual(show.upNext.season_number, 2);
  assert.strictEqual(show.upNextReleased, false);
});

test('earliest qualifying season wins even when it is TBA (2099 and free-text TBA)', async () => {
  const c = await pure();
  const dyn = c.deriveCurrentlyWatching([tv({ status: 'watching', watched: true }), tba({ season_number: 3, status: 'watching' })], TODAY).active[0];
  assert.strictEqual(dyn.upNext.season_number, 3);
  assert.strictEqual(dyn.upNextReleased, false);
  const stat = c.deriveCurrentlyWatching([legacy({ title: 'Static', season: 'Season 2', status: 'watching', display_date: 'TBA 2027', date_sort: '2026-06-01' })], TODAY).active[0];
  assert.strictEqual(stat.upNextReleased, false, 'a TBA label wins over a guessed past date_sort');
});

test('all Watching seasons watched → Up to date (and not in the main list)', async () => {
  const c = await pure();
  const rows = [tv({ season_number: 1, status: 'watching', watched: true }), tv({ season_number: 2, status: 'watching', watched: true }), tv({ season_number: 3, status: 'confirmed' })];
  const { active, upToDate } = c.deriveCurrentlyWatching(rows, TODAY);
  assert.strictEqual(active.length, 0);
  assert.strictEqual(upToDate.length, 1);
  assert.strictEqual(upToDate[0].upNext, null);
});

test('an unwatched future/TBA Watching season keeps the show out of Up to date', async () => {
  const c = await pure();
  const { active, upToDate } = c.deriveCurrentlyWatching([tv({ status: 'watching', watched: true }), tba({ season_number: 2, status: 'watching' })], TODAY);
  assert.strictEqual(active.length, 1);
  assert.strictEqual(upToDate.length, 0);
});

test('shows with no Watching row are not included', async () => {
  const c = await pure();
  const { active, upToDate } = c.deriveCurrentlyWatching([tv({ status: 'confirmed' }), tv({ season_number: 2, status: 'highpriority' })], TODAY);
  assert.strictEqual(active.length + upToDate.length, 0);
});

test('numbered seasons beat Specials; Specials are up next only when nothing numbered qualifies', async () => {
  const c = await pure();
  const both = c.deriveCurrentlyWatching([tv({ season_number: 0, status: 'watching', date_sort: '2019-01-01' }), tv({ season_number: 2, status: 'watching' })], TODAY);
  assert.strictEqual(both.active[0].upNext.season_number, 2);
  const onlySpecials = c.deriveCurrentlyWatching([tv({ season_number: 0, status: 'watching' }), tv({ season_number: 1, status: 'watching', watched: true })], TODAY);
  assert.strictEqual(onlySpecials.active[0].upNext.season_number, 0);
  const staticSpecial = c.deriveCurrentlyWatching([legacy({ title: 'X', season: 'Special', status: 'watching', date_sort: '2010-01-01' }), legacy({ title: 'X', season: 'Season 3', status: 'watching' })], TODAY);
  assert.strictEqual(staticSpecial.active[0].upNext.season, 'Season 3');
});

test('static labels: "Season 5 (Part 1/Part 2)" tie-break by date; "Volume N" parses', async () => {
  const c = await pure();
  const parts = [legacy({ title: 'Saga', season: 'Season 5 (Part 2)', status: 'watching', date_sort: '2021-06-01' }),
    legacy({ title: 'Saga', season: 'Season 5 (Part 1)', status: 'watching', date_sort: '2021-01-01' }),
    legacy({ title: 'Saga', season: 'Season 10', status: 'watching', date_sort: '2020-01-01' })];
  assert.strictEqual(c.deriveCurrentlyWatching(parts, TODAY).active[0].upNext.season, 'Season 5 (Part 1)');
  const vols = [legacy({ title: 'V', season: 'Volume 2', status: 'watching', date_sort: '2019-01-01' }), legacy({ title: 'V', season: 'Volume 1', status: 'watching', date_sort: '2020-01-01' })];
  assert.strictEqual(c.deriveCurrentlyWatching(vols, TODAY).active[0].upNext.season, 'Volume 1');
});

test('the row id breaks a complete tie deterministically', async () => {
  const c = await pure();
  const a = tv({ id: 'zzz', status: 'watching' }), b = tv({ id: 'aaa', status: 'watching' });
  assert.strictEqual(c.deriveCurrentlyWatching([a, b], TODAY).active[0].upNext.id, 'aaa');
  assert.strictEqual(c.deriveCurrentlyWatching([b, a], TODAY).active[0].upNext.id, 'aaa');
});

test('static legacy TV rows with no TMDB identity work (grouped by title)', async () => {
  const c = await pure();
  const rows = [legacy({ title: 'Star Wars: The Clone Wars (2008)', season: 'Season 1', status: 'watching' }),
    legacy({ title: 'Star Wars: The Clone Wars (2008)', season: 'Season 2', status: 'confirmed' })];
  const [show] = c.deriveCurrentlyWatching(rows, TODAY).active;
  assert.strictEqual(show.collection, 'disney');
  assert.strictEqual(show.seasons.length, 2);
  assert.strictEqual(show.upNext.season, 'Season 1');
});

test('films are excluded: truecrime movies, static "Film" rows, the Movies tab', async () => {
  const c = await pure();
  const rows = [
    tv({ collection: 'truecrime', media_type: 'movie', season: 'Film', season_number: null, status: 'watching' }),
    legacy({ collection: 'sheridan', title: 'A Film', season: 'Film', status: 'watching' }),
    tv({ collection: 'movies', media_type: 'movie', season: 'Film', season_number: null, status: 'watching' }),
  ];
  const { active, upToDate } = c.deriveCurrentlyWatching(rows, TODAY);
  assert.strictEqual(active.length + upToDate.length, 0);
  assert.strictEqual(rows.filter(r => c.isTvViewRow(r)).length, 0);
  assert.ok(c.isTvViewRow(tv({ collection: 'truecrime' })), 'truecrime TV rows are included');
});

test('the same show in two collections stays two separate shows', async () => {
  const c = await pure();
  const rows = [tv({ status: 'watching' }), tv({ collection: 'truecrime', status: 'watching' })];
  const { active } = c.deriveCurrentlyWatching(rows, TODAY);
  assert.strictEqual(active.length, 2);
  assert.deepStrictEqual(Array.from(active, s => s.collection).sort(), ['othertv', 'truecrime']);
  active.forEach(s => assert.ok(s.seasons.every(r => r.collection === s.collection)));
});

test('order is A–Z by title, then collection label', async () => {
  const c = await pure();
  const rows = [
    tv({ title: 'beta', tmdb_id: 1, status: 'watching' }),
    tv({ title: 'Alpha', tmdb_id: 2, status: 'watching' }),
    legacy({ title: 'alpha', status: 'watching' }),
  ];
  const order = Array.from(c.deriveCurrentlyWatching(rows, TODAY).active, s => `${s.title}/${s.collection}`);
  assert.deepStrictEqual(order, ['alpha/disney', 'Alpha/othertv', 'beta/othertv']);
});

test('re-deriving after edits: watched advances (even to a TBA season); status changes move up next', async () => {
  const c = await pure();
  const s1 = tv({ season_number: 1, status: 'watching' });
  const s2 = tv({ season_number: 2, status: 'watching', date_sort: '2021-01-01' });
  const s3 = tba({ season_number: 3, status: 'watching' });
  const rows = [s1, s2, s3];
  s1.watched = true;
  assert.strictEqual(c.deriveCurrentlyWatching(rows, TODAY).active[0].upNext.id, s2.id);
  s2.status = 'complete';
  const next = c.deriveCurrentlyWatching(rows, TODAY).active[0];
  assert.strictEqual(next.upNext.id, s3.id);
  assert.strictEqual(next.upNextReleased, false);
  s3.status = 'confirmed';
  assert.strictEqual(c.deriveCurrentlyWatching(rows, TODAY).upToDate.length, 1, 'no unwatched Watching row left');
  s1.watched = false; // an earlier season set back to unwatched Watching becomes up next
  assert.strictEqual(c.deriveCurrentlyWatching(rows, TODAY).active[0].upNext.id, s1.id);
});

test('release test: today counts as released, tomorrow does not; local date, not UTC', async () => {
  const c = await pure();
  assert.strictEqual(c.isReleasedRow(tv({ date_sort: '2026-09-29' }), '2026-09-29'), true);
  assert.strictEqual(c.isReleasedRow(tv({ date_sort: '2026-09-30' }), '2026-09-29'), false);
  assert.strictEqual(c.isReleasedRow(tba({}), '2026-09-29'), false);
  assert.strictEqual(c.localTodayStr(new Date(2026, 8, 29, 23, 45)), '2026-09-29');
  assert.strictEqual(c.localTodayStr(new Date(2026, 0, 5, 0, 5)), '2026-01-05');
});

// ─── Coming Soon rules ────────────────────────────────────────────────────────
const D = '2026-09-29';
test('Coming Soon: confirmed future row and today included; yesterday excluded', async () => {
  const c = await pure();
  const fut = tv({ date_sort: '2026-10-14' }), today = tv({ season_number: 2, date_sort: D }), past = tv({ season_number: 3, date_sort: '2026-09-28' });
  const { dated, tba: t } = c.deriveComingSoon([fut, today, past], D);
  assert.deepStrictEqual(ids(dated), [today.id, fut.id]);
  assert.strictEqual(t.length, 0);
});

test('Coming Soon: TBA by display text regardless of guessed (even past) date_sort; 2099 is TBA', async () => {
  const c = await pure();
  const staticPast = legacy({ collection: '90day', title: 'HEA', season: 'Season 10', display_date: 'TBA 2026', date_sort: '2026-06-01' });
  const staticFuture = legacy({ title: 'Mando', display_date: 'TBA (announced)', date_sort: '2027-03-01' });
  const dyn = tba({});
  const { dated, tba: t } = c.deriveComingSoon([staticPast, staticFuture, dyn], D);
  assert.strictEqual(dated.length, 0);
  assert.deepStrictEqual(ids(t), [staticPast.id, staticFuture.id, dyn.id], 'TBA ordered by date_sort');
});

test('Coming Soon: watched and skipped excluded (dated and TBA)', async () => {
  const c = await pure();
  const rows = [tv({ date_sort: '2026-12-01', watched: true }), tv({ season_number: 2, date_sort: '2026-12-01', status: 'skipped' }),
    tba({ season_number: 3, watched: true }), tba({ season_number: 4, status: 'skipped' })];
  const { dated, tba: t } = c.deriveComingSoon(rows, D);
  assert.strictEqual(dated.length + t.length, 0);
});

test('Coming Soon: Complete / Maybe / Pending / High Priority / Watching / On List stay eligible', async () => {
  const c = await pure();
  const statuses = ['complete', 'maybe', 'pending', 'highpriority', 'watching', 'confirmed'];
  const rows = statuses.map((status, i) => tv({ tmdb_id: 500 + i, status, date_sort: '2026-11-01' }));
  assert.strictEqual(c.deriveComingSoon(rows, D).dated.length, statuses.length);
});

test('Coming Soon: TV only — every kind of film is excluded', async () => {
  const c = await pure();
  const rows = [
    tv({ collection: 'truecrime', media_type: 'movie', season: 'Film', season_number: null, date_sort: '2026-11-01' }),
    legacy({ collection: 'sheridan', title: 'Call of Duty', season: 'Film', date_sort: '2028-06-30' }),
    tv({ collection: 'movies', media_type: 'movie', season: 'Film', season_number: null, date_sort: '2026-11-01' }),
    legacy({ collection: 'disney', title: 'Film TBA', season: 'Film', display_date: 'TBA', date_sort: '2027-01-01' }),
  ];
  const { dated, tba: t } = c.deriveComingSoon(rows, D);
  assert.strictEqual(dated.length + t.length, 0);
});

test('Coming Soon: static and dynamic rows both work; order is date, title, season, collection', async () => {
  const c = await pure();
  const a = legacy({ collection: 'sheridan', title: 'Tulsa King', season: 'Season 4', date_sort: '2026-10-16' });
  const b = tv({ title: 'Elsbeth', season_number: 4, date_sort: '2026-10-08' });
  const c1 = tv({ title: 'Same Day', tmdb_id: 7, season_number: 2, date_sort: '2026-10-20' });
  const c2 = tv({ title: 'Same Day', tmdb_id: 7, season_number: 1, date_sort: '2026-10-20' });
  const d1 = tv({ collection: 'truecrime', title: 'Twin', tmdb_id: 8, date_sort: '2026-10-21' });
  const d2 = tv({ collection: 'othertv', title: 'Twin', tmdb_id: 8, date_sort: '2026-10-21' });
  const { dated } = c.deriveComingSoon([a, b, c1, c2, d1, d2], D);
  assert.deepStrictEqual(ids(dated), [b.id, a.id, c2.id, c1.id, d2.id, d1.id]);
});

// ─── Rendering ────────────────────────────────────────────────────────────────
function cwFixture() {
  return [
    // Released up next (S2)
    tv({ id: 'rel-1', title: 'Released Show', tmdb_id: 1, season_number: 1, status: 'watching', watched: true }),
    tv({ id: 'rel-2', title: 'Released Show', tmdb_id: 1, season_number: 2, status: 'watching', date_sort: day(-10) }),
    tv({ id: 'rel-3', title: 'Released Show', tmdb_id: 1, season_number: 3, status: 'confirmed', date_sort: day(90) }),
    // TBA up next (S3), plus a future season wrongly marked watched
    tv({ id: 'tba-2', title: 'TBA Show', tmdb_id: 2, season_number: 2, status: 'watching', watched: true }),
    tba({ id: 'tba-3', title: 'TBA Show', tmdb_id: 2, season_number: 3, status: 'watching' }),
    tv({ id: 'tba-4', title: 'TBA Show', tmdb_id: 2, season_number: 4, status: 'confirmed', watched: true, date_sort: day(300) }),
    // Future up next
    tv({ id: 'fut-1', title: 'Future Show', tmdb_id: 3, season_number: 1, status: 'watching', date_sort: day(20) }),
    // Up to date
    tv({ id: 'done-1', title: 'Done Show', tmdb_id: 4, season_number: 1, status: 'watching', watched: true }),
    // Static show
    legacy({ id: 'dis-1', title: 'Clone Show', season: 'Season 1', status: 'watching' }),
    // Film (excluded)
    tv({ id: 'film-1', collection: 'truecrime', media_type: 'movie', season: 'Film', season_number: null, title: 'Doc Film', status: 'watching' }),
  ];
}

// The header-row markup for one show in the desktop table.
function headerRow(app, title) {
  const rows = app.el('tbody').innerHTML.split('<tr ');
  return rows.find(r => r.includes('derived-show-row') && r.includes(`>${title}<`)) || '';
}
function card(app, title) {
  return app.el('cardList').innerHTML.split('<div class="item-card').find(c => c.includes(`>${title}<`)) || '';
}

test('render: startup shows Currently Watching with the expected shows (films excluded)', async () => {
  const app = await createApp({ rows: cwFixture() });
  const html = app.html();
  for (const t of ['Released Show', 'TBA Show', 'Future Show', 'Clone Show']) assert.ok(headerRow(app, t), `${t} shown`);
  assert.ok(!html.includes('Doc Film'), 'films excluded');
  assert.ok(headerRow(app, 'Done Show'), 'up-to-date shows are in the (expanded) Up to date section');
  assert.ok(app.el('tableHead').innerHTML.includes('Up next'));
});

test('render: a released up-next season shows status + watch controls (desktop and mobile)', async () => {
  const app = await createApp({ rows: cwFixture() });
  const row = headerRow(app, 'Released Show');
  assert.ok(row.includes("setStatus('rel-2'"));
  assert.ok(row.includes("toggleWatch('rel-2')"));
  assert.ok(row.includes('event.stopPropagation(); toggleWatch'), 'watch click does not toggle expand');
  const c = card(app, 'Released Show');
  assert.ok(c.includes("setStatus('rel-2'") && c.includes("toggleWatch('rel-2')"));
});

test('render: a TBA or future up-next season shows the date and status, but no Mark watched', async () => {
  const app = await createApp({ rows: cwFixture() });
  for (const [title, id, label] of [['TBA Show', 'tba-3', 'Season 3 · TBA'], ['Future Show', 'fut-1', `Season 1 · ${disp(day(20))}`]]) {
    const row = headerRow(app, title), c = card(app, title);
    assert.ok(row.includes(label), `${title}: ${label}`);
    assert.ok(row.includes('Upcoming') && row.includes('Not aired yet'));
    assert.ok(row.includes(`setStatus('${id}'`) && c.includes(`setStatus('${id}'`));
    assert.ok(!row.includes(`toggleWatch('${id}')`) && !c.includes(`toggleWatch('${id}')`));
  }
});

test('render: expanding a show lists every stored season; release rule applies; no delete/match', async () => {
  const app = await createApp({ rows: cwFixture() });
  app.ctx.toggleDerivedShow('othertv|tmdb:2');
  const html = app.html();
  for (const id of ['tba-2', 'tba-3', 'tba-4']) assert.ok(html.includes(`setStatus('${id}'`), `${id} listed`);
  assert.ok(!html.includes("toggleWatch('tba-3')"), 'unreleased unwatched season: no Mark watched');
  assert.ok(html.includes("toggleWatch('tba-4')"), 'unreleased but watched season keeps its toggle (undo)');
  assert.ok(html.includes("toggleWatch('tba-2')"));
  assert.ok(!html.includes('delRow(') && !html.includes('openTmdbMatch('), 'no delete or match controls');
  assert.ok(!html.includes('setShowStatus('), 'no show-level status control');
});

test('render: Up to date starts expanded, shows "Up to date", collapses, and allows undo', async () => {
  const app = await createApp({ rows: cwFixture() });
  const row = headerRow(app, 'Done Show');
  assert.ok(row, 'Up to date shows are visible when the view opens');
  assert.ok(row.includes('>Up to date<'), 'card shows "Up to date"');
  assert.ok(!app.html().includes('All watching seasons watched'));
  assert.ok(card(app, 'Done Show').includes('Up to date'), 'mobile card too');
  app.ctx.toggleDerivedSection('uptodate');
  assert.ok(!app.html().includes('Done Show'), 'the section can still be collapsed');
  app.ctx.switchView('comingsoon');
  app.ctx.switchView('watching');
  await new Promise(r => setTimeout(r, 20));
  assert.ok(headerRow(app, 'Done Show'), 'expanded again each time the view opens');
  app.ctx.toggleDerivedShow('othertv|tmdb:4');
  assert.ok(app.html().includes("toggleWatch('done-1')"), 'watched season can be unwatched');
});

test('render: source and search filters narrow Currently Watching', async () => {
  const app = await createApp({ rows: cwFixture() });
  app.el('fSource').value = 'disney';
  app.ctx.renderTable();
  assert.ok(headerRow(app, 'Clone Show'));
  assert.ok(!headerRow(app, 'Released Show'));
  app.el('fSource').value = '';
  app.el('fSearch').value = 'future';
  app.ctx.renderTable();
  assert.ok(headerRow(app, 'Future Show'));
  assert.ok(!headerRow(app, 'Clone Show'));
});

function csFixture() {
  return [
    tv({ id: 'cs-today', title: 'Today Show', tmdb_id: 11, date_sort: day(0) }),
    tv({ id: 'cs-soon', title: 'Soon Show', tmdb_id: 12, date_sort: day(5), status: 'pending' }),
    tv({ id: 'cs-past', title: 'Past Show', tmdb_id: 13, date_sort: day(-1) }),
    tba({ id: 'cs-tba', title: 'Tba Show', tmdb_id: 14 }),
    legacy({ id: 'cs-stba', title: 'Static Tba', display_date: 'TBA 2027', date_sort: day(200) }),
    tv({ id: 'cs-skip', title: 'Skipped Show', tmdb_id: 15, date_sort: day(3), status: 'skipped' }),
    tv({ id: 'cs-w', title: 'Watched Show', tmdb_id: 16, date_sort: day(3), watched: true }),
  ];
}

test('render: Coming Soon — dated rows, Today tag, TBA collapsed, status only, no watch/delete', async () => {
  const app = await createApp({ rows: csFixture() });
  app.ctx.switchView('comingsoon');
  await new Promise(r => setTimeout(r, 20));
  let html = app.html();
  assert.ok(html.includes("setStatus('cs-today'") && html.includes("setStatus('cs-soon'"));
  assert.ok(html.includes('Today'));
  assert.ok(!html.includes('Past Show') && !html.includes('Skipped Show') && !html.includes('Watched Show'));
  assert.ok(html.includes('TBA') && !html.includes('Tba Show'), 'TBA section collapsed by default');
  app.ctx.toggleDerivedSection('tba');
  html = app.html();
  assert.ok(html.includes("setStatus('cs-tba'") && html.includes("setStatus('cs-stba'"));
  assert.ok(!html.includes('toggleWatch(') && !html.includes('delRow('), 'no watch or delete controls anywhere');
  assert.ok(html.indexOf('Today Show') < html.indexOf('Soon Show'), 'chronological');
});

// ─── Season-row extraction: grouped tabs unchanged ────────────────────────────
test('grouped tab after extraction: same controls per season (desktop and mobile)', async () => {
  const rows = [
    tv({ id: 'g1', title: 'Grouped', season_number: 1, status: 'watching', watched: true }),
    tba({ id: 'g2', title: 'Grouped', season_number: 2, status: 'watching' }),
    tv({ id: 'g3', title: 'Grouped', season_number: 0, status: 'skipped' }),
    tv({ id: 'g4', title: 'Manual', media_type: null, tmdb_id: null, season_number: null, season: 'Season 1', status: 'confirmed' }),
  ];
  const app = await createApp({ rows });
  app.ctx.switchTab('othertv');
  await new Promise(r => setTimeout(r, 20));
  app.el('fWatch').value = '';
  app.ctx.toggleShowExpand('Grouped');
  app.ctx.toggleShowExpand('Manual');
  const desk = app.el('tbody').innerHTML, mob = app.el('cardList').innerHTML;
  for (const html of [desk, mob]) {
    for (const id of ['g1', 'g2', 'g3', 'g4']) {
      assert.ok(html.includes(`setStatus('${id}'`), `status ${id}`);
      assert.ok(html.includes(`delRow('${id}')`), `delete ${id}`);
    }
    assert.ok(html.includes("toggleWatch('g1')"));
    assert.ok(html.includes("toggleWatch('g2')"), 'tabs keep Mark watched on unreleased rows');
    assert.ok(!html.includes("toggleWatch('g3')"), 'skipped rows have no watch button');
    assert.ok(html.includes("openTmdbMatch('g4')") && !html.includes("openTmdbMatch('g1')"), 'match only for unidentified rows');
    assert.ok(!html.includes('Not aired yet'));
  }
  assert.ok(mob.includes('>✓</button>'), 'mobile keeps the compact watched label');
  assert.ok(desk.includes('>✓ Watched</button>'));
});

T.run();
