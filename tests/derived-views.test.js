// Offline tests for the derived TV views (derived-views.js) on the first-class
// show model (Phase 3): Currently Watching membership is the show status, up next
// and Up to date follow the approved rules (checked against tests/tv-model-reference.js
// on every shared case), Coming Soon takes linked, unwatched, non-skipped seasons
// of shows that aren't Skipped; and the rendering of those views and of the
// collection tabs' show-level controls. A TV season's own `status` column is a
// compatibility copy: these tests scramble it to prove nothing reads it.
// Run from the repo root: node tests/derived-views.test.js
// No network, no database (see tests/app-harness.js).
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');
const M = require('./tv-model-reference');
const CASES = require('./fixtures/tv-model-cases.json');

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
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
// A show and its seasons. Season specs: { num | season, w, s (skipped), date, tba }.
// Each season's own status is deliberately misleading ('pending'): it must not matter.
function show(o, specs) {
  const s = { id: nid('show'), collection: 'othertv', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 100, status: 'confirmed', ...o };
  const identified = s.tmdb_id != null;
  const rows = specs.map(sp => {
    const num = sp.num !== undefined ? sp.num : null;
    const label = sp.season || (num === 0 ? 'Specials' : `Season ${num}`);
    const date = sp.tba ? '2099-01-01' : (sp.date || '2020-01-01');
    return {
      id: sp.id || nid('r'), collection: s.collection, title: s.title, theme: 'HBO', status: 'pending',
      watched: !!sp.w, skipped: !!sp.s, show_id: s.id,
      media_type: identified ? 'tv' : null, tmdb_id: identified ? s.tmdb_id : null, season_number: identified ? num : null,
      season: label, display_date: sp.tba ? 'TBA' : (sp.display || disp(date)), date_sort: date,
      item_key: `${s.show_key}|${label.toLowerCase()}`, watch_with: [], collections: []
    };
  });
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'truecrime', title: 'Doc Film', theme: 'Studio', status: 'watching', watched: false,
  media_type: 'movie', tmdb_id: 900, season_number: null, season: 'Film', display_date: disp(day(5)), date_sort: day(5),
  item_key: 'doc film|film', watch_with: [], collections: [], show_id: null, skipped: false, ...o });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) });
const ids = list => Array.from(list, r => r.id);

let ctx; // pure functions only need the scripts loaded
async function pure() { if (!ctx) ctx = (await createApp()).ctx; return ctx; }
const cw = async (data, today = TODAY) => (await pure()).deriveCurrentlyWatching(data.rows, data.shows, today);
const cs = async (data, today = TODAY) => (await pure()).deriveComingSoon(data.rows, data.shows, today);

// ─── The approved up-next / Up to date rules ──────────────────────────────────
test('app up next and Up to date equal the reference model on every shared case', async () => {
  const c = await pure();
  for (const k of CASES.upNext) {
    const seasons = M.caseSeasons(k.seasons, CASES.today);
    const next = c.upNextSeason(seasons);
    assert.strictEqual(next ? next.id : null, k.upNext, k.name);
    assert.strictEqual(c.isShowUpToDate(seasons, CASES.today), k.upToDate, k.name);
  }
  assert.ok(CASES.upNext.length >= 7);
});

test('membership is the show status: a Watching show is in, other statuses are out, whatever its seasons say', async () => {
  const w = show({ title: 'In', status: 'watching' }, [{ num: 1 }]);
  const others = ['confirmed', 'highpriority', 'complete', 'pending', 'maybe', 'skipped'].map(st => show({ title: st, status: st, tmdb_id: null }, [{ season: 'Season 1' }]));
  others.forEach(o => o.rows.forEach(r => { r.status = 'watching'; })); // compatibility copies say Watching: ignored
  const { active, upToDate } = await cw(all(w, ...others));
  assert.deepStrictEqual(Array.from([...active, ...upToDate], x => x.title), ['In']);
});

test('up next is the first unwatched, non-skipped season after the furthest watched one', async () => {
  const a = show({ status: 'watching' }, [{ num: 1, w: true }, { num: 2 }, { num: 3, w: true }, { num: 4 }]);
  assert.strictEqual((await cw(all(a))).active[0].upNext.season_number, 4, 'older unwatched S2 never moves progress back');
  const b = show({ status: 'watching' }, [{ num: 1, w: true }, { num: 2, s: true }, { num: 3 }]);
  assert.strictEqual((await cw(all(b))).active[0].upNext.season_number, 3, 'skipped S2 is passed over');
  const c = show({ status: 'watching' }, [{ num: 3 }, { num: 1 }, { num: 2 }]);
  assert.strictEqual((await cw(all(c))).active[0].upNext.season_number, 1, 'nothing watched → first season');
});

test('Up to date: no remaining season has aired; a future or TBA up-next season is still "next"', async () => {
  const fut = show({ title: 'Future', status: 'watching' }, [{ num: 1, w: true }, { num: 2, date: day(30) }]);
  const tbaShow = show({ title: 'Tba', status: 'watching', tmdb_id: 101 }, [{ num: 1, w: true }, { num: 2, tba: true }]);
  const done = show({ title: 'Done', status: 'watching', tmdb_id: 102 }, [{ num: 1, w: true }, { num: 2, w: true }]);
  const aired = show({ title: 'Aired', status: 'watching', tmdb_id: 103 }, [{ num: 1, w: true }, { num: 2, date: day(-1) }, { num: 3, date: day(30) }]);
  const { active, upToDate } = await cw(all(fut, tbaShow, done, aired));
  assert.deepStrictEqual(Array.from(active, x => x.title), ['Aired']);
  assert.deepStrictEqual(Array.from(upToDate, x => x.title), ['Done', 'Future', 'Tba']);
  assert.strictEqual(upToDate.find(x => x.title === 'Future').upNext.season_number, 2);
  assert.strictEqual(upToDate.find(x => x.title === 'Done').upNext, null);
});

test('released means not TBA and dated on or before local today (today counts; a TBA label beats a guessed date)', async () => {
  const c = await pure();
  const today = show({ status: 'watching' }, [{ num: 1, w: true }, { num: 2, date: TODAY }]);
  const tomorrow = show({ status: 'watching', tmdb_id: 101 }, [{ num: 1, w: true }, { num: 2, date: day(1) }]);
  assert.strictEqual(c.isShowUpToDate(today.rows, TODAY), false);
  assert.strictEqual(c.isShowUpToDate(tomorrow.rows, TODAY), true);
  const guessed = show({ status: 'watching', tmdb_id: null, title: 'Static' }, [{ season: 'Season 1', w: true }, { season: 'Season 2', date: '2020-06-01', display: 'TBA 2027' }]);
  assert.strictEqual(c.isShowUpToDate(guessed.rows, TODAY), true);
});

test('specials never move progress when numbered seasons exist; a specials-only title progresses through them', async () => {
  const mixed = show({ status: 'watching' }, [{ num: 0, date: '2019-01-01' }, { num: 1, w: true }, { num: 2 }]);
  assert.strictEqual((await cw(all(mixed))).active[0].upNext.season_number, 2);
  const onlySpecials = show({ status: 'watching', tmdb_id: null, title: 'Specials only' }, [{ season: 'Special 1', w: true }, { season: 'Special 2' }]);
  // Without numbered seasons every season is in the progression list.
  assert.ok((await cw(all(onlySpecials))).active.length + (await cw(all(onlySpecials))).upToDate.length === 1);
});

test('the known future-model difference: a Severance-like show (all aired seasons watched, next one dated) is Up to date', async () => {
  const sev = show({ title: 'Severance', status: 'watching' }, [{ num: 1, w: true }, { num: 2, w: true }, { num: 3, date: day(200) }]);
  const { active, upToDate } = await cw(all(sev));
  assert.strictEqual(active.length, 0);
  assert.strictEqual(upToDate[0].upNext.season_number, 3);
});

test('films and unlinked rows are never in Currently Watching; the same title in two collections is two shows', async () => {
  const a = show({ title: 'Twin', status: 'watching' }, [{ num: 1 }]);
  const b = show({ title: 'Twin', status: 'watching', collection: 'truecrime' }, [{ num: 1 }]);
  const unlinked = { ...a.rows[0], id: nid('u'), show_id: null };
  const { active } = await cw({ rows: [...a.rows, ...b.rows, unlinked, film()], shows: [a.show, b.show] });
  assert.strictEqual(active.length, 2);
  assert.deepStrictEqual(Array.from(active, x => x.collection), ['othertv', 'truecrime'], 'A–Z, then collection label');
  assert.ok(active.every(x => x.seasons.length === 1));
});

// ─── Coming Soon ──────────────────────────────────────────────────────────────
test('Coming Soon: linked unwatched seasons dated today or later, plus TBA; yesterday out', async () => {
  const s = show({ status: 'confirmed' }, [{ num: 1, date: day(-1) }, { num: 2, date: TODAY }, { num: 3, date: day(9) }, { num: 4, tba: true }]);
  const { dated, tba } = await cs(all(s));
  assert.deepStrictEqual(Array.from(dated, r => r.season_number), [2, 3]);
  assert.deepStrictEqual(Array.from(tba, r => r.season_number), [4]);
});

test('Coming Soon: watched and skipped seasons, and every season of a Skipped show, are excluded; other statuses stay', async () => {
  const s = show({ status: 'complete' }, [{ num: 1, date: day(3), w: true }, { num: 2, date: day(4), s: true }, { num: 3, date: day(5) }]);
  const sk = show({ status: 'skipped', tmdb_id: 101, title: 'Skipped show' }, [{ num: 1, date: day(6) }]);
  const others = ['highpriority', 'watching', 'pending', 'maybe'].map((st, i) => show({ status: st, tmdb_id: 200 + i, title: st }, [{ num: 1, date: day(7) }]));
  const { dated } = await cs(all(s, sk, ...others));
  assert.deepStrictEqual(Array.from(dated, r => r.title).sort(), ['Show', 'highpriority', 'maybe', 'pending', 'watching']);
});

test('Coming Soon: films and unlinked rows are excluded; order is date, title, season, collection', async () => {
  const b = show({ title: 'Bravo', status: 'confirmed' }, [{ num: 2, date: day(5) }, { num: 1, date: day(5) }]);
  const a = show({ title: 'Alpha', status: 'confirmed', tmdb_id: 101 }, [{ num: 1, date: day(5) }, { num: 3, date: day(2) }]);
  const unlinked = { ...a.rows[0], id: nid('u'), show_id: null };
  const { dated } = await cs({ rows: [...b.rows, ...a.rows, unlinked, film({ date_sort: day(5) })], shows: [a.show, b.show] });
  assert.deepStrictEqual(Array.from(dated, r => `${r.title} ${r.season_number}`), ['Alpha 3', 'Alpha 1', 'Bravo 1', 'Bravo 2']);
});

// ─── Rendering: Currently Watching and Coming Soon ────────────────────────────
async function viewApp(data) {
  const app = await createApp({ rows: data.rows, tvShows: data.shows });
  await settle();
  return app;
}
const tbody = app => app.el('tbody').innerHTML;
const cards = app => app.el('cardList').innerHTML;

test('render: both kinds of Watching cards carry the show-level status control; Up to date is a tag, not a status', async () => {
  const p = show({ title: 'Progress', status: 'watching' }, [{ num: 1, w: true }, { num: 2, date: day(-3) }]);
  const u = show({ title: 'Current', status: 'watching', tmdb_id: 101 }, [{ num: 1, w: true }, { num: 2, date: day(40) }]);
  const app = await viewApp(all(p, u));
  for (const html of [tbody(app), cards(app)]) {
    assert.strictEqual((html.match(/setShowStatusById\(/g) || []).length, 2, 'one show control per card');
    assert.ok(!/setStatus\(/.test(html), 'no row-level status control for TV');
    assert.ok(html.includes('Up to date</span>'));
    assert.ok(html.includes(`Next: Season 2 · ${disp(day(40))}`));
  }
  assert.ok(app.el('statsRow').innerHTML.includes('In progress') && app.el('statsRow').innerHTML.includes('Up to date'));
  assert.ok(tbody(app).includes(`toggleWatch('${p.rows[1].id}')`), 'released up next: Mark watched');
  assert.ok(!tbody(app).includes(`toggleWatch('${u.rows[1].id}')`), 'up to date: no watch control for the future season');
});

test('render: the show control is clearly show-scoped (label and "applies to all seasons")', async () => {
  const p = show({ title: 'Scoped', status: 'watching' }, [{ num: 1 }]);
  const app = await viewApp(all(p));
  assert.ok(tbody(app).includes('Show: ▶ Watching'));
  assert.ok(tbody(app).includes('Applies to all seasons of Scoped'));
});

test('render: an expanded Watching show lists every season with Watched and Skip / Keep, no delete or match', async () => {
  const p = show({ title: 'Expand', status: 'watching' }, [{ num: 1, w: true }, { num: 2, date: day(-3) }, { num: 3, s: true, date: day(-2) }]);
  const app = await viewApp(all(p));
  app.ctx.toggleDerivedShow(p.show.id); await settle();
  const html = tbody(app);
  assert.ok(html.includes(`setSeasonSkipped('${p.rows[1].id}', true)`));
  assert.ok(html.includes(`setSeasonSkipped('${p.rows[2].id}', false)`), 'skipped season offers Keep');
  assert.ok(!/delRow\(|openTmdbMatch\(/.test(html));
});

test('render: changing the show status from Currently Watching calls set_show_status and moves the show', async () => {
  const p = show({ title: 'Move', status: 'watching' }, [{ num: 1, date: day(-3) }]);
  const app = await viewApp(all(p));
  await app.ctx.setShowStatusById(p.show.id, 'complete'); await settle();
  const call = app.writes().find(r => r.url.endsWith('/rpc/set_show_status'));
  assert.deepStrictEqual([call.body.p_show_id, call.body.p_status], [p.show.id, 'complete']);
  assert.strictEqual(app.store.tv_shows[0].status, 'complete');
  assert.ok(!tbody(app).includes('derived-show-row'), 'no Watching shows left');
  assert.strictEqual(app.writes().length, 1, 'one show write, no season PATCHes');
});

test('render: Coming Soon has Skip only — no status menu, no watch control, no delete; Skip removes the row', async () => {
  const s = show({ title: 'Soon', status: 'pending' }, [{ num: 1, date: TODAY }, { num: 2, tba: true }]);
  const app = await createApp({ rows: s.rows, tvShows: [s.show] });
  app.ctx.switchView('comingsoon'); await settle();
  const html = tbody(app) + cards(app);
  assert.ok(html.includes('Today'));
  assert.ok(html.includes(`setSeasonSkipped('${s.rows[0].id}', true)`));
  assert.ok(!/<select|toggleWatch\(|delRow\(|setShowStatusById\(/.test(html));
  assert.ok(html.includes('⏳ Pending'), 'the show status is shown as a label');
  await app.ctx.setSeasonSkipped(s.rows[0].id, true); await settle();
  assert.ok(app.writes().some(r => r.url.endsWith('/rpc/set_season_skipped')));
  assert.ok(!tbody(app).includes(`setSeasonSkipped('${s.rows[0].id}'`));
});

// ─── Rendering: collection tabs ───────────────────────────────────────────────
test('flat tab (Disney+): TV rows get the show control and Skip; × on a built-in season means Skip; films stay row-level', async () => {
  const app0 = await createApp();
  app0.ctx.switchTab('disney'); await settle();
  const app = await createApp({ rows: app0.store.watchlist_items, tvShows: app0.store.tv_shows });
  app.ctx.switchTab('disney'); await settle();
  const rows = app.get('tabData.disney.rows');
  const tvRow = rows.find(r => r.season !== 'Film' && !r.skipped);
  const filmRow = rows.find(r => r.season === 'Film');
  const html = tbody(app);
  assert.ok(html.includes(`setShowStatusById('${tvRow.show_id}'`));
  assert.ok(html.includes(`setSeasonSkipped('${tvRow.id}', true)`));
  assert.ok(html.includes(`setStatus('${filmRow.id}'`), 'films keep the row status control');
  assert.ok(html.includes('title="Skip this season"'));
  await app.ctx.delRow(tvRow.id); await settle();
  assert.deepStrictEqual(app.writes().map(r => r.url.split('/rest/v1/')[1]), ['rpc/set_season_skipped']);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === tvRow.id).skipped, true, 'skipped, not deleted');
});

test('grouped tab: one group per show (by show_id) with the show control; seasons have Skip / Keep + Watched; True Crime films unchanged', async () => {
  const s = show({ title: 'Grouped', status: 'watching', collection: 'truecrime' }, [{ num: 1, w: true }, { num: 2, date: day(-1) }]);
  const f = film();
  const app = await createApp({ rows: [...s.rows, f], tvShows: [s.show] });
  app.ctx.switchTab('truecrime'); await settle();
  app.ctx.toggleShowExpand(`show:${s.show.id}`); await settle();
  const html = tbody(app);
  assert.strictEqual((html.match(/show-group-row/g) || []).length, 2, 'the show and the film');
  assert.ok(html.includes(`setShowStatusById('${s.show.id}'`));
  assert.ok(html.includes(`setSeasonSkipped('${s.rows[1].id}', true)`));
  assert.ok(html.includes(`toggleWatch('${s.rows[1].id}')`));
  assert.ok(html.includes(`setStatus('${f.id}'`), 'the film keeps its row-level status');
  assert.ok(!html.includes(`setStatus('${s.rows[0].id}'`), 'no row-level status for a season');
});

test('grouped tab filters: "Watching only" lists every Watching show; "Up to date only" just the up-to-date ones', async () => {
  const p = show({ title: 'Progress', status: 'watching' }, [{ num: 1, w: true }, { num: 2, date: day(-3) }]);
  const u = show({ title: 'Current', status: 'watching', tmdb_id: 101 }, [{ num: 1, w: true }]);
  const o = show({ title: 'Listed', status: 'confirmed', tmdb_id: 102 }, [{ num: 1 }]);
  const app = await createApp({ rows: [...p.rows, ...u.rows, ...o.rows], tvShows: [p.show, u.show, o.show] });
  app.ctx.switchTab('othertv'); await settle();
  const titles = () => [...tbody(app).matchAll(/<span class="show-title">([^<]+)<\/span>/g)].map(m => m[1]);
  app.el('fWatch').value = '';
  app.el('fStatus').value = 'watching'; app.ctx.renderTable();
  assert.deepStrictEqual(titles(), ['Progress', 'Current']);
  app.el('fStatus').value = 'uptodate'; app.ctx.renderTable();
  assert.deepStrictEqual(titles(), ['Current']);
  app.el('fStatus').value = ''; app.ctx.renderTable();
  assert.deepStrictEqual(titles(), ['Progress', 'Current', 'Listed'], 'Watching in progress, Watching up to date, then On List');
});

test('the season status column is never read for TV: scrambling it changes no view or tab', async () => {
  const p = show({ title: 'A', status: 'watching' }, [{ num: 1, w: true }, { num: 2, date: day(-3) }, { num: 3, tba: true }]);
  const q = show({ title: 'B', status: 'maybe', tmdb_id: 101 }, [{ num: 1, date: day(4) }, { num: 2, s: true }]);
  const render = async scramble => {
    const data = all(p, q);
    const rows = data.rows.map(r => ({ ...r, status: scramble }));
    const app = await createApp({ rows, tvShows: data.shows.map(s => ({ ...s })) });
    const out = [tbody(app), app.el('statsRow').innerHTML];
    app.ctx.switchView('comingsoon'); await settle(); out.push(tbody(app));
    app.ctx.switchTab('othertv'); await settle(); app.el('fWatch').value = ''; app.ctx.renderTable(); out.push(tbody(app), app.el('statsRow').innerHTML);
    return out.join('\n');
  };
  const a = await render('skipped'), b = await render('watching'), c = await render('complete');
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
});

T.run();
