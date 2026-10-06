// Offline tests for All TV's Shows / Seasons presentation (derived-views.js):
// Shows stays the first-use default and unchanged; Seasons lists the seasons of
// the shows that pass Search / Source / show Status, oldest first with year
// headers and deterministic ties; genuine TBA and dates needing review go to one
// collapsed section, labelled and counted separately; the Seasons-only
// visibility choice (All seasons / To watch / Watched / Skipped) survives layout
// toggles and resets on re-entry; season rows show the show status read-only and
// keep the existing Watched and Skip / Keep controls; the presentation is
// remembered on the device and storage failures fall back to Shows.
// Run from the repo root: node tests/all-tv-seasons.test.js
// No network, no database (see tests/app-harness.js).
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('all-tv-seasons');
const test = T.test;

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const disp = iso => { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };

let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
// A show and its seasons. Season specs: { num | season, w, s (skipped), date, tba, display, id }.
// Each season's own status is deliberately misleading ('pending'): it must not matter.
function show(o, specs) {
  const s = { id: nid('show'), collection: 'othertv', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 500 + n, status: 'confirmed', ...o };
  const identified = s.tmdb_id != null;
  const rows = specs.map(sp => {
    const num = sp.num !== undefined ? sp.num : null;
    const label = sp.season || (num === 0 ? 'Specials' : `Season ${num}`);
    const date = sp.tba ? '2099-01-01' : (sp.date !== undefined ? sp.date : '2020-01-01');
    return {
      id: sp.id || nid('r'), collection: s.collection, title: s.title, theme: 'HBO', status: 'pending',
      watched: !!sp.w, skipped: !!sp.s, show_id: s.id,
      media_type: identified ? 'tv' : null, tmdb_id: identified ? s.tmdb_id : null, season_number: identified ? num : null,
      season: label, display_date: sp.display || (sp.tba ? 'TBA' : (/^\d{4}-\d{2}-\d{2}$/.test(date) ? disp(date) : 'unknown')), date_sort: date,
      item_key: `${s.show_key}|${label.toLowerCase()}`, watch_with: [], collections: []
    };
  });
  return { show: s, rows };
}
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows), shows: xs.map(x => x.show) });

async function openAllTv(data, opts = {}) {
  const app = await createApp({ rows: data.rows, tvShows: data.shows, ...opts });
  app.ctx.switchView('alltv'); await settle();
  return app;
}
async function seasons(app) { app.ctx.setAllTvPresentation('seasons'); await settle(); }
async function shows(app) { app.ctx.setAllTvPresentation('shows'); await settle(); }
const tbody = app => app.el('tbody').innerHTML;
const cards = app => app.el('cardList').innerHTML;
// Season rows in document order, as "Title · Season" (desktop) or from cards.
const seasonRows = app => [...tbody(app).matchAll(/<span class="show-title">([^<]*)<\/span>\s*<span class="season-lbl"> · ([^<]*)<\/span>/g)].map(m => `${m[1]} · ${m[2]}`);
const seasonCards = app => [...cards(app).matchAll(/<span class="card-title">([^<]*)<\/span>\s*<span class="card-season">([^<]*)<\/span>/g)].map(m => `${m[1]} · ${m[2]}`);
const showCards = app => [...tbody(app).matchAll(/toggleDerivedShow\('([^']+)'\)/g)].map(m => m[1]).filter((x, i, a) => a.indexOf(x) === i);
const statNums = app => [...app.el('statsRow').innerHTML.matchAll(/stat-num">(\d+)<\/div><div class="stat-label">([^<]*)</g)].map(m => `${m[1]} ${m[2]}`);
const setF = (app, id, v) => { app.el(id).value = v; app.ctx.renderTable(); };
function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

// ─── Defaults and layout ──────────────────────────────────────────────────────
test('first use opens All TV in Shows: the switch shows Shows active, no season-visibility select, the Stage 1 cards', async () => {
  const a = show({ title: 'Alpha', status: 'watching' }, [{ num: 1, date: day(-3) }]);
  const app = await openAllTv(all(a));
  const f = app.el('filtersRow').innerHTML;
  assert.strictEqual(app.get('allTvPresentation'), 'shows');
  assert.ok(f.includes(`aria-pressed="true" onclick="setAllTvPresentation('shows')"`));
  assert.ok(f.includes(`aria-pressed="false" onclick="setAllTvPresentation('seasons')"`));
  assert.ok(!f.includes('fSeasonVis'));
  assert.ok(tbody(app).includes('derived-show-row') && app.el('tableHead').innerHTML.includes('<th>Next</th>'));
  assert.ok(f.indexOf('view-toggle') < f.indexOf('filterToggleBtn'), 'the switch sits outside the collapsible panel');
});

test('switching to Seasons: header, visibility select at All seasons, no request and no write', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1 }]);
  const app = await openAllTv(all(a));
  const before = app.requests.length;
  await seasons(app);
  assert.strictEqual(app.requests.length, before, 'toggling makes no request');
  assert.strictEqual(app.el('fSeasonVis').value, 'all');
  assert.ok(app.el('filtersRow').innerHTML.includes('onchange="setAllTvSeasonVis(this.value)"'));
  assert.ok(app.el('tableHead').innerHTML.includes('<th>Show &amp; Season</th><th>Source</th><th>Premiere</th><th>Show status</th>'));
  assert.deepStrictEqual(seasonRows(app), ['Alpha · Season 1']);
  assert.strictEqual(app.writes().length, 0);
});

test('Watching and Coming Soon have no Shows/Seasons switch and are unaffected by the stored choice', async () => {
  const a = show({ title: 'Alpha', status: 'watching' }, [{ num: 1, date: day(-3) }, { num: 2, date: day(9) }]);
  const plain = await createApp({ rows: a.rows, tvShows: [a.show] });
  const out = async app => { const o = []; for (const v of ['watching', 'comingsoon']) { app.ctx.switchView(v); await settle(); o.push(app.html(), app.el('filtersRow').innerHTML, app.el('tableHead').innerHTML); } return o; };
  const base = await out(plain);
  const stored = await createApp({ rows: a.rows, tvShows: [a.show] });
  stored.ctx.localStorage = memoryStorage({ watchlist_alltv_presentation: 'seasons' });
  stored.ctx.switchView('alltv'); await settle();
  assert.strictEqual(stored.get('allTvPresentation'), 'seasons');
  assert.deepStrictEqual(await out(stored), base);
  assert.ok(!base[1].includes('view-toggle') && !base[4].includes('view-toggle'));
});

// ─── Shared filters across toggles ───────────────────────────────────────────
test('Search, Source and show Status keep their values across Shows → Seasons → Shows and select the same shows', async () => {
  const a = show({ title: 'Andor', collection: 'disney', tmdb_id: null, status: 'watching' }, [{ season: 'Season 1' }, { season: 'Season 2', date: '2025-04-22' }]);
  const b = show({ title: 'Andor Talk', collection: 'othertv', status: 'confirmed' }, [{ num: 1 }]);
  const c = show({ title: 'Andorra', collection: 'disney', tmdb_id: null, status: 'skipped' }, [{ season: 'Season 1' }]);
  const d = show({ title: 'Bluey', collection: 'disney', tmdb_id: null }, [{ season: 'Season 1' }]);
  const app = await openAllTv(all(a, b, c, d));
  app.el('fSearch').value = 'andor'; app.el('fSource').value = 'disney'; app.el('fStatus').value = 'all'; app.ctx.renderTable();
  const showIds = showCards(app);
  assert.deepStrictEqual(showIds, [a.show.id, c.show.id]);
  const showsHtml = tbody(app);
  await seasons(app);
  for (const [id, v] of [['fSearch', 'andor'], ['fSource', 'disney'], ['fStatus', 'all']]) assert.strictEqual(app.el(id).value, v, id);
  const rowShowIds = [...new Set(app.get('derivedData').rows.filter(r => seasonRows(app).includes(`${r.title} · ${r.season}`)).map(r => r.show_id))];
  assert.deepStrictEqual(rowShowIds.sort(), [...showIds].sort(), 'Seasons lists seasons of exactly the Shows-mode shows');
  await shows(app);
  for (const [id, v] of [['fSearch', 'andor'], ['fSource', 'disney'], ['fStatus', 'all']]) assert.strictEqual(app.el(id).value, v, id);
  assert.strictEqual(tbody(app), showsHtml, 'Shows output identical after the round trip');
});

test('expanded shows stay expanded across toggles', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1 }, { num: 2 }]);
  const app = await openAllTv(all(a));
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  const expanded = tbody(app);
  await seasons(app); await shows(app);
  assert.strictEqual(tbody(app), expanded);
  assert.strictEqual((tbody(app).match(/sub-row/g) || []).length, 2);
});

// ─── Season visibility memory ────────────────────────────────────────────────
test('the visibility choice survives Seasons → Shows → Seasons and never changes Shows', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1, w: true }, { num: 2 }, { num: 3, s: true, date: '2021-01-01' }]);
  const app = await openAllTv(all(a));
  const showsBase = tbody(app) + app.el('statsRow').innerHTML;
  await seasons(app);
  app.ctx.setAllTvSeasonVis('towatch'); await settle();
  assert.deepStrictEqual(seasonRows(app), ['Alpha · Season 2']);
  await shows(app);
  assert.strictEqual(app.el('fSeasonVis'), null, 'not rendered in Shows');
  assert.strictEqual(tbody(app) + app.el('statsRow').innerHTML, showsBase, 'Shows unchanged by the Seasons choice');
  await seasons(app);
  assert.strictEqual(app.el('fSeasonVis').value, 'towatch');
  assert.deepStrictEqual(seasonRows(app), ['Alpha · Season 2']);
});

test('leaving All TV or reloading resets visibility to All seasons; the Shows/Seasons choice is remembered on the device', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1, w: true }, { num: 2 }]);
  const storage = memoryStorage();
  const app = await createApp({ rows: a.rows, tvShows: [a.show] });
  app.ctx.localStorage = storage;
  app.ctx.switchView('alltv'); await settle();
  await seasons(app);
  assert.strictEqual(storage.m.get('watchlist_alltv_presentation'), 'seasons');
  app.ctx.setAllTvSeasonVis('watched'); await settle();
  app.ctx.switchView('watching'); await settle();
  app.ctx.switchView('alltv'); await settle();
  assert.strictEqual(app.get('allTvPresentation'), 'seasons');
  assert.strictEqual(app.el('fSeasonVis').value, 'all');
  assert.strictEqual(seasonRows(app).length, 2);
  // A reload: a fresh page with the same device storage.
  const reloaded = await createApp({ rows: a.rows, tvShows: [a.show] });
  reloaded.ctx.localStorage = storage;
  reloaded.ctx.switchView('alltv'); await settle();
  assert.strictEqual(reloaded.get('allTvPresentation'), 'seasons');
  assert.strictEqual(reloaded.get('allTvSeasonVis'), 'all');
  assert.strictEqual(reloaded.el('fSeasonVis').value, 'all');
  assert.ok(![...storage.m.keys()].some(k => /vis/i.test(k)), 'the visibility choice is never stored');
});

test('an invalid visibility value is ignored', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1 }]);
  const app = await openAllTv(all(a));
  await seasons(app);
  app.ctx.setAllTvSeasonVis('bogus'); await settle();
  assert.strictEqual(app.get('allTvSeasonVis'), 'all');
  app.ctx.setAllTvPresentation('cards'); await settle();
  assert.strictEqual(app.get('allTvPresentation'), 'seasons');
});

// ─── Predicates ──────────────────────────────────────────────────────────────
test('predicates: To watch = unwatched, not season-skipped, not a Skipped show; Watched and Skipped are independent flags', async () => {
  const a = show({ title: 'Alpha', status: 'watching' }, [
    { num: 1, w: true, date: '2020-01-01' },            // watched
    { num: 2, s: true, date: '2020-02-01' },            // season-skipped
    { num: 3, w: true, s: true, date: '2020-03-01' },   // both
    { num: 4, date: '2020-04-01' }                      // neither
  ]);
  const z = show({ title: 'Zed', status: 'skipped' }, [
    { num: 1, w: true, date: '2021-01-01' },            // watched, Skipped show
    { num: 2, s: true, date: '2021-02-01' },            // season-skipped, Skipped show
    { num: 3, date: '2021-03-01' }                      // neither, Skipped show
  ]);
  const app = await openAllTv(all(a, z));
  setF(app, 'fStatus', 'all');
  await seasons(app);
  const list = async vis => { app.ctx.setAllTvSeasonVis(vis); await settle(); return seasonRows(app); };
  assert.deepStrictEqual(await list('all'), ['Alpha · Season 1', 'Alpha · Season 2', 'Alpha · Season 3', 'Alpha · Season 4', 'Zed · Season 1', 'Zed · Season 2', 'Zed · Season 3']);
  assert.deepStrictEqual(await list('towatch'), ['Alpha · Season 4'], 'never a watched, skipped or Skipped-show season');
  assert.deepStrictEqual(await list('watched'), ['Alpha · Season 1', 'Alpha · Season 3', 'Zed · Season 1']);
  assert.deepStrictEqual(await list('skipped'), ['Alpha · Season 2', 'Alpha · Season 3', 'Zed · Season 2']);
  // The pure function agrees, and a both-flag season is in Watched and Skipped.
  const items = app.ctx.deriveAllTv(app.get('derivedData').rows, app.get('tvShowsById'), day(0)).items;
  const ids = vis => Array.from(app.ctx.deriveAllTvSeasons(items, vis).dated, r => r.id);
  const both = a.rows[2].id;
  assert.ok(ids('watched').includes(both) && ids('skipped').includes(both) && !ids('towatch').includes(both));
});

test('with the default Status and no both-flag season, To watch, Watched and Skipped partition All seasons', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1, w: true }, { num: 2, s: true }, { num: 3 }, { num: 4, tba: true }]);
  const b = show({ title: 'Beta', status: 'complete' }, [{ num: 1, w: true }, { num: 2, date: day(30) }]);
  const z = show({ title: 'Zed', status: 'skipped' }, [{ num: 1 }]);
  const app = await openAllTv(all(a, b, z));
  const items = app.ctx.deriveAllTv(app.get('derivedData').rows, app.get('tvShowsById'), day(0)).items
    .filter(x => app.ctx.allTvStatusMatches(x.show.status, ''));
  const set = vis => { const o = app.ctx.deriveAllTvSeasons(items, vis); return [...o.dated, ...o.tba, ...o.review].map(r => r.id).sort(); };
  const parts = [...set('towatch'), ...set('watched'), ...set('skipped')].sort();
  assert.deepStrictEqual(parts, set('all'));
  assert.strictEqual(new Set(parts).size, parts.length, 'disjoint');
  assert.ok(!set('all').includes(z.rows[0].id), 'Skipped shows are out under the default Status');
});

test('approved exception: with To watch in Seasons, expanding a show in Shows still lists every stored season', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1, w: true }, { num: 2, s: true }, { num: 3 }]);
  const app = await openAllTv(all(a));
  await seasons(app);
  app.ctx.setAllTvSeasonVis('towatch'); await settle();
  assert.deepStrictEqual(seasonRows(app), ['Alpha · Season 3']);
  await shows(app);
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  assert.strictEqual((tbody(app).match(/sub-row/g) || []).length, 3);
  assert.strictEqual((cards(app).match(/card-subseason-row/g) || []).length, 3);
});

// ─── Ordering ────────────────────────────────────────────────────────────────
test('oldest first across shows and collections, under year headers', async () => {
  const a = show({ title: 'Alpha', collection: 'othertv' }, [{ num: 1, date: '2019-05-01' }, { num: 2, date: '2023-01-10' }]);
  const b = show({ title: 'Beta', collection: 'disney', tmdb_id: null }, [{ season: 'Season 1', date: '2018-11-12' }, { season: 'Season 2', date: '2023-01-09' }]);
  const app = await openAllTv(all(a, b));
  await seasons(app);
  assert.deepStrictEqual(seasonRows(app), ['Beta · Season 1', 'Alpha · Season 1', 'Beta · Season 2', 'Alpha · Season 2']);
  assert.deepStrictEqual(seasonCards(app), seasonRows(app), 'mobile cards in the same order');
  const years = [...tbody(app).matchAll(/<tr class="year-group"><td colspan="6">(\d{4})<\/td><\/tr>/g)].map(m => m[1]);
  assert.deepStrictEqual(years, ['2018', '2019', '2023']);
  assert.deepStrictEqual([...cards(app).matchAll(/<div class="card-year-group">(\d{4})<\/div>/g)].map(m => m[1]), years);
});

test('same-date ties: title, then season order (Specials after numbered), then collection, then id — independent of input order', async () => {
  const D = '2022-06-01';
  const x1 = show({ title: 'Same', collection: 'othertv', tmdb_id: 901 }, [{ num: 0, date: D, id: 'r-sp' }, { num: 2, date: D, id: 'r-s2' }, { num: 1, date: D, id: 'r-s1' }]);
  const x2 = show({ title: 'Same', collection: 'disney', tmdb_id: null }, [{ season: 'Season 1', date: D, id: 'r-d1' }]);
  const x3 = show({ title: 'Same', collection: 'disney', tmdb_id: null, show_key: 'same 2' }, [{ season: 'Season 1', date: D, id: 'r-d0' }]);
  const aa = show({ title: 'Aardvark' }, [{ num: 1, date: D, id: 'r-aa' }]);
  const app = await openAllTv(all(x1, x2, x3, aa));
  const items = app.ctx.deriveAllTv(app.get('derivedData').rows, app.get('tvShowsById'), day(0)).items;
  const expected = ['r-aa', 'r-d0', 'r-d1', 'r-s1', 'r-s2', 'r-sp'];
  for (let i = 0; i < 20; i++) {
    const shuffled = items.map(it => ({ ...it, seasons: [...it.seasons].sort(() => Math.random() - 0.5) })).sort(() => Math.random() - 0.5);
    assert.deepStrictEqual(Array.from(app.ctx.deriveAllTvSeasons(shuffled, 'all').dated, r => r.id), expected);
  }
});

// ─── TBA and dates needing review ─────────────────────────────────────────────
test('genuine TBA (text with a guessed date, or the 2099 sentinel) is never dated; the section starts collapsed with its count', async () => {
  const a = show({ title: 'Alpha', collection: 'disney', tmdb_id: null }, [
    { season: 'Season 1', date: '2020-03-01' },
    { season: 'Season 2', date: '2027-06-01', display: 'TBA 2027' },   // guessed date_sort
    { season: 'Season 3', date: '2020-01-01', display: 'TBA (announced)' } // guessed date in the past
  ]);
  const b = show({ title: 'Beta' }, [{ num: 4, tba: true }]);
  const app = await openAllTv(all(a, b));
  await seasons(app);
  assert.deepStrictEqual(seasonRows(app), ['Alpha · Season 1'], 'only the confirmed date is in the dated list (section collapsed)');
  assert.ok(tbody(app).includes(`toggleDerivedSection('alltvTba')`) && tbody(app).includes('TBA / no date <span class="section-count">3 TBA</span>'));
  assert.deepStrictEqual(statNums(app), ['4 Seasons', '2 Shows', '3 TBA']);
  app.ctx.toggleDerivedSection('alltvTba'); await settle();
  assert.deepStrictEqual(seasonRows(app), ['Alpha · Season 1', 'Alpha · Season 2', 'Alpha · Season 3', 'Beta · Season 4']);
  assert.ok(tbody(app).includes('<td colspan="6">TBA</td>'));
  assert.ok(!/upcoming-tag|today-tag/.test(tbody(app).split('<td colspan="6">TBA</td>')[1]), 'TBA rows are never tagged as dated');
});

test('the TBA section is independent of Coming Soon’s and resets to collapsed on re-entry', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1, tba: true }]);
  const app = await openAllTv(all(a));
  await seasons(app);
  app.ctx.toggleDerivedSection('alltvTba'); await settle();
  assert.strictEqual(app.get('derivedSectionOpen.tba'), false, 'Coming Soon’s TBA state untouched');
  assert.strictEqual(app.get('derivedSectionOpen.alltvTba'), true);
  app.ctx.switchView('comingsoon'); await settle();
  app.ctx.switchView('alltv'); await settle();
  assert.strictEqual(app.get('derivedSectionOpen.alltvTba'), false);
  assert.deepStrictEqual(seasonRows(app), []);
});

test('dates needing review (empty, malformed, impossible) are labelled separately and not counted as TBA', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1, date: '', display: '' }, { num: 2, date: 'soon', display: 'Soon' }, { num: 3, date: '2026-02-30', display: 'Feb 30, 2026' }, { num: 4, tba: true }, { num: 5, date: '2024-01-01' }]);
  const app = await openAllTv(all(a));
  await seasons(app);
  assert.deepStrictEqual(statNums(app), ['5 Seasons', '1 Show', '1 TBA', '3 Date needs review']);
  assert.ok(tbody(app).includes('TBA / no date <span class="section-count">1 TBA · 3 date needs review</span>'));
  assert.deepStrictEqual(seasonRows(app), ['Alpha · Season 5']);
  app.ctx.toggleDerivedSection('alltvTba'); await settle();
  const sec = tbody(app).split('TBA / no date')[1];
  assert.ok(sec.indexOf('<td colspan="6">TBA</td>') < sec.indexOf('<td colspan="6">Date needs review</td>'));
  const review = sec.split('<td colspan="6">Date needs review</td>')[1];
  assert.strictEqual((review.match(/review-tag">date needs review</g) || []).length, 3);
  assert.ok(!/upcoming-tag|today-tag/.test(review), 'never described as dated, upcoming or aired');
  assert.strictEqual((cards(app).match(/review-tag/g) || []).length, 3, 'labelled on mobile too');
  assert.ok(app.ctx.isValidDateSort('2024-02-29') && !app.ctx.isValidDateSort('2023-02-29') && !app.ctx.isValidDateSort('2024-1-01'));
});

// ─── Season rows: controls and scoped edits ──────────────────────────────────
test('the show status is a read-only label with a show-scoped tooltip; it follows a change made in Shows', async () => {
  const a = show({ title: 'Alpha', status: 'confirmed' }, [{ num: 1 }, { num: 2 }]);
  const app = await openAllTv(all(a));
  await seasons(app);
  assert.ok(!/<select class="status-select|setShowStatusById/.test(tbody(app) + cards(app)), 'no status select on season rows');
  assert.strictEqual((tbody(app).match(/title="Show status — applies to every season of Alpha. Switch to Shows to change it.">✓ On List<\/span>/g) || []).length, 2);
  await shows(app);
  await app.ctx.setShowStatusById(a.show.id, 'watching'); await settle();
  await seasons(app);
  assert.strictEqual((tbody(app).match(/status-pill s-watching/g) || []).length, 2);
  assert.ok(!tbody(app).includes('s-caughtup'), 'no Up to date tag on season rows');
});

test('Mark watched and Skip on a season row: one function call each for that row id, mirrored, row kept or dropped by the visibility choice', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1, date: day(-40) }, { num: 2, date: day(-20) }]);
  const app = await createApp({ rows: a.rows, tvShows: [a.show] });
  app.ctx.switchTab('othertv'); await settle();
  app.ctx.switchView('alltv'); await settle();
  await seasons(app);
  assert.ok(tbody(app).includes(`toggleWatch('${a.rows[0].id}')`) && tbody(app).includes(`setSeasonSkipped('${a.rows[0].id}', true)`));
  await app.ctx.toggleWatch(a.rows[0].id); await settle();
  assert.deepStrictEqual(app.writes().map(r => [r.url.split('/rest/v1/')[1], r.body.p_row_id]), [['rpc/set_season_watched', a.rows[0].id]]);
  assert.strictEqual(app.get('tabData.othertv.rows').find(r => r.id === a.rows[0].id).watched, true, 'mirrored into the loaded tab');
  assert.ok(tbody(app).includes('✓ Watched') && seasonRows(app).length === 2, 'All seasons: the row stays, now watched');
  app.ctx.setAllTvSeasonVis('towatch'); await settle();
  assert.deepStrictEqual(seasonRows(app), ['Alpha · Season 2']);
  await app.ctx.setSeasonSkipped(a.rows[1].id, true); await settle();
  assert.deepStrictEqual(app.writes().slice(1).map(r => [r.url.split('/rest/v1/')[1], r.body.p_row_id, r.body.p_skipped]), [['rpc/set_season_skipped', a.rows[1].id, true]]);
  assert.ok(tbody(app).includes('No seasons match your filters.'));
  assert.ok(!app.writes().some(r => /set_show_status/.test(r.url) || ['PATCH', 'DELETE'].includes(r.method) || (r.method === 'POST' && !/\/rpc\//.test(r.url))));
});

test('a failed season edit rolls back and reports the error', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1, date: day(-40) }]);
  const app = await openAllTv(all(a));
  await seasons(app);
  app.failNext(r => r.url.endsWith('/rpc/set_season_watched'));
  await app.ctx.toggleWatch(a.rows[0].id); await settle();
  assert.strictEqual(app.get('derivedData').rows[0].watched, false);
  assert.ok(app.el('errorBanner').innerHTML.length > 0);
  assert.ok(tbody(app).includes(`toggleWatch('${a.rows[0].id}')">Mark watched`));
});

test('release controls unchanged: future and TBA show "Not aired yet", released shows Mark watched, watched keeps its toggle', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1, date: day(-5) }, { num: 2, w: true, date: day(-1) }, { num: 3, date: day(12) }, { num: 4, tba: true }, { num: 5, date: day(0) }]);
  const app = await openAllTv(all(a));
  await seasons(app);
  app.ctx.toggleDerivedSection('alltvTba'); await settle();
  const rowOf = s => tbody(app).split('<tr').find(x => x.includes(`season-lbl"> · ${s}<`));
  assert.ok(rowOf('Season 1').includes('Mark watched'));
  assert.ok(rowOf('Season 2').includes('✓ Watched'));
  assert.ok(rowOf('Season 3').includes('Not aired yet') && rowOf('Season 3').includes('upcoming-tag'));
  assert.ok(rowOf('Season 4').includes('Not aired yet'));
  assert.ok(rowOf('Season 5').includes('today-tag') && rowOf('Season 5').includes('Mark watched'));
  // Same answer as the existing control used in Shows' expanded seasons.
  for (const r of a.rows) assert.ok(rowOf(r.season).includes(app.ctx.seasonWatchControlHtml(r, { requireReleased: true, today: day(0) }, false)));
});

test('seasons of a Skipped show read "Show skipped", have no Skip / Keep and are dimmed', async () => {
  const z = show({ title: 'Zed', status: 'skipped' }, [{ num: 1 }]);
  const app = await openAllTv(all(z));
  await seasons(app);
  assert.ok(tbody(app).includes('No shows match your filters.'), 'hidden by the default Status');
  setF(app, 'fStatus', 'skipped');
  const row = tbody(app);
  assert.ok(row.includes('Show skipped') && !row.includes('setSeasonSkipped(') && row.includes('class="row-skipped"'));
});

test('the season status column is never read: scrambling it changes nothing in Seasons', async () => {
  const mk = st => { const a = show({ id: 'S1', title: 'Alpha', status: 'watching' }, [{ id: 'A1', num: 1, w: true }, { id: 'A2', num: 2, date: day(-3) }, { id: 'A3', num: 3, tba: true }]); a.rows.forEach(r => { r.status = st; }); return a; };
  const outs = [];
  for (const st of ['skipped', 'complete', 'watching']) { const app = await openAllTv(all(mk(st))); await seasons(app); app.ctx.toggleDerivedSection('alltvTba'); await settle(); outs.push(tbody(app) + cards(app) + app.el('statsRow').innerHTML); }
  assert.strictEqual(outs[0], outs[1]); assert.strictEqual(outs[1], outs[2]);
});

// ─── Counts and empty states ─────────────────────────────────────────────────
test('counts and the four empty states', async () => {
  const empty = await openAllTv({ rows: [], shows: [] });
  await seasons(empty);
  assert.ok(tbody(empty).includes('No TV shows on your list yet.'));
  const a = show({ title: 'Alpha' }, [{ num: 1, w: true }, { num: 2, tba: true }]);
  const app = await openAllTv(all(a));
  await seasons(app);
  assert.deepStrictEqual(statNums(app), ['2 Seasons', '1 Show', '1 TBA']);
  setF(app, 'fSearch', 'zzz');
  assert.ok(tbody(app).includes('No shows match your filters.'));
  setF(app, 'fSearch', '');
  app.ctx.setAllTvSeasonVis('skipped'); await settle();
  assert.ok(tbody(app).includes('No seasons match your filters.') && cards(app).includes('No seasons match your filters.'));
  app.ctx.setAllTvSeasonVis('towatch'); await settle();
  assert.ok(tbody(app).includes('No dated seasons; see TBA / no date below.'));
  assert.deepStrictEqual(statNums(app), ['1 Season', '1 Show', '1 TBA']);
});

// ─── Device storage ──────────────────────────────────────────────────────────
test('unusable storage falls back to Shows: a garbage value, a missing key, or storage that throws', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1 }]);
  for (const storage of [memoryStorage({ watchlist_alltv_presentation: 'grid' }), memoryStorage()]) {
    const app = await createApp({ rows: a.rows, tvShows: [a.show] });
    app.ctx.localStorage = storage;
    app.ctx.switchView('alltv'); await settle();
    assert.strictEqual(app.get('allTvPresentation'), 'shows');
  }
  const app = await createApp({ rows: a.rows, tvShows: [a.show] });
  Object.defineProperty(app.ctx, 'localStorage', { configurable: true, get() { throw new Error('SecurityError: storage blocked'); } });
  app.ctx.switchView('alltv'); await settle();
  assert.strictEqual(app.get('allTvPresentation'), 'shows');
  await seasons(app);
  assert.strictEqual(app.get('allTvPresentation'), 'seasons', 'the switch still works for this page');
  assert.deepStrictEqual(seasonRows(app), ['Alpha · Season 1']);
  assert.strictEqual(app.consoleErrors.length, 0);
  assert.strictEqual(app.writes().length, 0, 'the preference never reaches the database');
});

// ─── Loading and phone width ─────────────────────────────────────────────────
test('opening All TV in Seasons (remembered) loads with GETs only and refuses an incomplete read', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1 }, { num: 2 }]);
  const app = await createApp({ rows: a.rows, tvShows: [a.show], countOverride: 9 });
  app.ctx.localStorage = memoryStorage({ watchlist_alltv_presentation: 'seasons' });
  app.ctx.switchView('alltv'); await settle();
  assert.ok(tbody(app).includes('Failed to load') && !tbody(app).includes('season-lbl'));
  assert.ok(app.requests.every(r => r.method === 'GET'));
});

test('phone width: the switch stays outside the collapsed panel; cards carry the label, Watched and Skip / Keep', async () => {
  const a = show({ title: 'Alpha' }, [{ num: 1, date: day(-2) }]);
  const app = await openAllTv(all(a), { width: 375 });
  await seasons(app);
  assert.ok(app.el('filtersRow').classList.contains('collapsed'));
  const f = app.el('filtersRow').innerHTML;
  assert.ok(f.indexOf('view-toggle') < f.indexOf('filters-inner') && f.indexOf('fSeasonVis') > f.indexOf('filters-inner'));
  const c = cards(app);
  assert.ok(c.includes('status-pill s-confirmed') && c.includes(`toggleWatch('${a.rows[0].id}')`) && c.includes(`setSeasonSkipped('${a.rows[0].id}', true)`));
});

T.run();
