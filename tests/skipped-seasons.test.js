// Offline tests for skipped seasons in an expanded show (derived-views.js listedSeasons,
// skippedSeasonsControlHtml, toggleSkippedSeasons, hiddenSkippedTarget): a season skipped on its own is
// listed only after "Show skipped seasons (N)"; the choice is page memory per show; a Skipped show lists
// every season as before. Display only: progress, up next and earlier seasons read every season.
// Run from the repo root: node tests/skipped-seasons.test.js
// No network, no database (see tests/app-harness.js); focus uses the test-only DOM (tests/mini-dom.js).
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');
const { makeMiniDom } = require('./mini-dom');

const T = runner('skipped-seasons');
const test = T.test;

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
// A show (stored in True Crime / Docs, so it is a member of that collection) and its seasons.
// Season specs: { num, w, s (skipped) }; season n aired n * 100 days before the last.
function show(o, specs) {
  const s = { id: nid('show'), collection: 'truecrime', title: 'Show', show_key: (o.title || 'show').toLowerCase(), tmdb_id: null, status: 'confirmed', ...o };
  const rows = specs.map(sp => ({
    id: nid('r'), collection: s.collection, title: s.title, theme: 'Net', status: 'pending', watched: !!sp.w, skipped: !!sp.s,
    show_id: s.id, media_type: s.tmdb_id ? 'tv' : null, tmdb_id: s.tmdb_id, season_number: s.tmdb_id ? sp.num : null,
    season: `Season ${sp.num}`, display_date: 'Jan 1, 2020', date_sort: day(-1000 + sp.num * 100),
    item_key: `${s.show_key}|season ${sp.num}`, watch_with: [], collections: []
  }));
  return { show: s, rows };
}
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows), tvShows: xs.map(x => x.show) });
function recordingStorage() {
  const m = new Map(), sets = [];
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { sets.push(k); m.set(k, String(v)); }, removeItem: k => m.delete(k), sets };
}
async function boot(data, opts = {}) {
  const app = await createApp({ ...data, ...opts });
  app.ctx.switchView(opts.view || 'alltv'); await settle();
  return app;
}
const tbody = app => app.el('tbody').innerHTML;
const cards = app => app.el('cardList').innerHTML;
const seasonsIn = s => [...s.matchAll(/<span class="season-lbl">([^<]*)<\/span>/g)].map(m => m[1]);
const control = s => (s.match(/<button class="btn btn-link" data-action="skipped-seasons"[^>]*>[^<]*<\/button>/) || [''])[0];
const label = s => control(s).replace(/<[^>]+>/g, '');
const writes = app => app.requests.filter(r => r.method !== 'GET');

test('some skipped: hidden by default; "Show skipped seasons (N)" beside Details reveals them in season order; Hide puts it back', async () => {
  const a = show({ title: 'Long Run' }, [{ num: 1, s: true }, { num: 2, s: true }, { num: 3, w: true }, { num: 4, s: true }, { num: 5 }]);
  const app = await boot(all(a));
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  for (const s of [tbody(app), cards(app)]) {
    assert.deepStrictEqual(seasonsIn(s), ['Season 3', 'Season 5']);
    assert.strictEqual(label(s), 'Show skipped seasons (3)');
    assert.ok(/aria-expanded="false"/.test(control(s)));
    assert.ok(s.indexOf('Details…') < s.indexOf('data-action="skipped-seasons"') && s.indexOf('data-action="skipped-seasons"') < s.indexOf('Show ended'), 'directly after Details');
    assert.ok(!/seasons are skipped|only season is skipped/.test(s), 'no all-skipped note');
  }
  app.ctx.toggleSkippedSeasons(a.show.id); await settle();
  for (const s of [tbody(app), cards(app)]) {
    assert.deepStrictEqual(seasonsIn(s), ['Season 1', 'Season 2', 'Season 3', 'Season 4', 'Season 5'], 'normal season order');
    assert.strictEqual(label(s), 'Hide skipped seasons (3)');
    assert.ok(/aria-expanded="true"/.test(control(s)));
  }
  assert.ok(tbody(app).includes(`setSeasonSkipped('${a.rows[0].id}', false)`), 'a revealed season keeps its Keep');
  app.ctx.toggleSkippedSeasons(a.show.id); await settle();
  assert.deepStrictEqual(seasonsIn(tbody(app)), ['Season 3', 'Season 5']);
  assert.deepStrictEqual(writes(app), [], 'nothing is written');
});

test('none skipped: no control, no zero count', async () => {
  const a = show({ title: 'Clean' }, [{ num: 1, w: true }, { num: 2 }]);
  const app = await boot(all(a));
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  assert.ok(!tbody(app).includes('skipped-seasons') && !cards(app).includes('skipped-seasons'));
  assert.deepStrictEqual(seasonsIn(tbody(app)), ['Season 1', 'Season 2']);
});

test('all skipped: "All N seasons are skipped" with the control; one season reads "The only season is skipped"', async () => {
  const a = show({ title: 'Every One' }, [{ num: 1, s: true }, { num: 2, s: true }, { num: 3, s: true }]);
  const b = show({ title: 'Single' }, [{ num: 1, s: true }]);
  const app = await boot(all(a, b));
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  app.ctx.toggleDerivedShow(b.show.id); await settle();
  for (const s of [tbody(app), cards(app)]) {
    assert.ok(s.includes('All 3 seasons are skipped') && s.includes('Show skipped seasons (3)'));
    assert.ok(s.includes('The only season is skipped') && s.includes('Show skipped seasons (1)'));
    assert.deepStrictEqual(seasonsIn(s), [], 'no season listed');
    assert.ok(s.includes('All seasons skipped'), 'the collapsed label is unchanged');
  }
  assert.ok(tbody(app).includes(`openAddSeason('${a.show.id}')`), 'Add season is still offered');
  app.ctx.toggleSkippedSeasons(a.show.id); await settle();
  assert.ok(tbody(app).includes('All 3 seasons are skipped') && tbody(app).includes('Hide skipped seasons (3)'));
  assert.deepStrictEqual(seasonsIn(tbody(app)), ['Season 1', 'Season 2', 'Season 3']);
});

test('a Skipped show (its own status) lists every season as before, with no control or note', async () => {
  const z = show({ title: 'Dropped', status: 'skipped' }, [{ num: 1, w: true }, { num: 2, s: true }, { num: 3 }]);
  const app = await boot(all(z));
  app.el('fStatus').value = 'all'; app.ctx.renderTable();
  app.ctx.toggleDerivedShow(z.show.id); await settle();
  for (const s of [tbody(app), cards(app)]) {
    assert.deepStrictEqual(seasonsIn(s), ['Season 1', 'Season 2', 'Season 3']);
    assert.ok(!s.includes('skipped-seasons') && !/seasons are skipped/.test(s));
    assert.ok(s.includes('Show skipped'), 'the "Show skipped" label as before');
  }
});

test('page memory per show: kept across redraws, collapse and re-expand, and other views (Currently Watching, a collection); no storage', async () => {
  const storage = recordingStorage();
  const a = show({ title: 'Kept', status: 'watching' }, [{ num: 1, w: true }, { num: 2, s: true }, { num: 3 }]);
  const b = show({ title: 'Other', status: 'watching' }, [{ num: 1, s: true }, { num: 2 }]);
  const app = await boot(all(a, b), { storage, view: 'watching' });
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  app.ctx.toggleDerivedShow(b.show.id); await settle();
  assert.strictEqual((tbody(app).match(/Show skipped seasons \(1\)/g) || []).length, 2, 'Currently Watching has the control');
  const before = storage.sets.length;
  app.ctx.toggleSkippedSeasons(a.show.id); await settle();
  app.ctx.renderTable();
  app.ctx.toggleDerivedShow(a.show.id); await settle(); // collapse
  app.ctx.toggleDerivedShow(a.show.id); await settle(); // re-expand
  assert.ok(tbody(app).includes(`data-season-row="${a.rows[1].id}"`), 'still revealed');
  assert.ok(!tbody(app).includes(`data-season-row="${b.rows[0].id}"`), 'per show: the other stays hidden');
  app.ctx.switchView('alltv'); await settle();
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  assert.ok(tbody(app).includes(`data-season-row="${a.rows[1].id}"`) && tbody(app).includes('Hide skipped seasons (1)'), 'All TV: the same choice');
  app.ctx.openBrowseCollection(app.browseId('truecrime')); await settle();
  app.ctx.toggleBrowseShow(a.show.id); await settle();
  app.ctx.toggleBrowseShow(b.show.id); await settle();
  assert.ok(tbody(app).includes(`data-season-row="${a.rows[1].id}"`) && !tbody(app).includes(`data-season-row="${b.rows[0].id}"`), 'a collection: the same choice');
  assert.ok(cards(app).includes('Hide skipped seasons (1)') && cards(app).includes('Show skipped seasons (1)'), 'and its phone cards');
  assert.strictEqual(storage.sets.length, before, 'nothing stored in the browser');
  assert.deepStrictEqual(writes(app), [], 'nothing written');
});

test('a collection: the count and list come from the collection’s own seasons of the show', async () => {
  const a = show({ title: 'Member' }, [{ num: 1, s: true }, { num: 2, s: true }, { num: 3 }]);
  const app = await boot(all(a));
  app.ctx.openBrowseCollection(app.browseId('truecrime')); await settle();
  app.el('fStatus').value = 'all'; app.ctx.renderTable();
  app.ctx.toggleBrowseShow(a.show.id); await settle();
  assert.strictEqual(label(tbody(app)), 'Show skipped seasons (2)');
  assert.deepStrictEqual(seasonsIn(tbody(app)), ['Season 3']);
  app.ctx.toggleSkippedSeasons(a.show.id); await settle();
  assert.deepStrictEqual(seasonsIn(tbody(app)), ['Season 1', 'Season 2', 'Season 3']);
  assert.ok(tbody(app).includes(`setSeasonSkipped('${a.rows[0].id}', false)`));
});

test('hidden or shown, progress, up next and earlier seasons are the same', async () => {
  // Season 1 unwatched before the watched Season 3 (a gap); Season 2 skipped; Season 4 up next.
  const a = show({ title: 'Gap', status: 'watching' }, [{ num: 1 }, { num: 2, s: true }, { num: 3, w: true }, { num: 4 }]);
  const app = await boot(all(a), { view: 'watching' });
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  app.ctx.openResumePicker(a.show.id); await settle();
  const strip = s => s.replace(/<tr class="[^"]*sub-row"[^>]*data-season-row[\s\S]*?<\/tr>/g, '').replace(/<div class="card-subseason-row" data-season-row[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g, '')
    .replace(/<button class="btn btn-link" data-action="skipped-seasons"[^>]*>[^<]*<\/button>/g, '');
  const hidden = { t: strip(tbody(app)), c: strip(cards(app)) };
  assert.ok(hidden.t.includes('<span class="show-progress-line">1/3 seasons watched</span>') && hidden.t.includes('Start from Season 1') && !hidden.t.includes('Start from Season 2'));
  assert.ok(hidden.t.includes('Season 4'), 'up next');
  app.ctx.toggleSkippedSeasons(a.show.id); await settle();
  assert.strictEqual(strip(tbody(app)), hidden.t, 'the show row and actions are unchanged (table)');
  assert.strictEqual(strip(cards(app)), hidden.c, 'the show card and actions are unchanged');
});

test('Skip hides the season and moves focus to the control; Keep of the last one removes the control; a refusal brings the row back', async () => {
  const a = show({ title: 'Focus' }, [{ num: 1, w: true }, { num: 2 }, { num: 3 }]);
  const app = await boot(all(a));
  const dom = makeMiniDom(app);
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  const toggle = box => dom.in(box, `[data-show-of="${a.show.id}"] [data-action="skipped-seasons"], [data-item="${a.show.id}"] [data-action="skipped-seasons"]`);
  for (const box of ['tbody', 'cardList']) {
    const id = box === 'tbody' ? a.rows[1].id : a.rows[2].id;
    dom.focus(box, `[data-season-row="${id}"] [data-action="season-control"] button`);
    await app.ctx.setSeasonSkipped(id, true); await settle();
    assert.ok(!app.el(box).innerHTML.includes(`data-season-row="${id}"`), `${box}: hidden`);
    assert.ok(dom.active() === toggle(box), `${box}: focus on the show’s control`);
  }
  assert.strictEqual(label(tbody(app)), 'Show skipped seasons (2)');
  assert.deepStrictEqual(writes(app).map(r => [r.url.split('/rpc/')[1], r.body.p_skipped]), [['set_season_skipped', true], ['set_season_skipped', true]]);
  // Revealed: Skip and Keep keep the row and focus on its control; Keep of the last one removes the control.
  app.ctx.toggleSkippedSeasons(a.show.id); await settle();
  for (const id of [a.rows[1].id, a.rows[2].id]) {
    dom.focus('tbody', `[data-season-row="${id}"] [data-action="season-control"] button`);
    await app.ctx.setSeasonSkipped(id, false); await settle();
    assert.ok(dom.active() === dom.in('tbody', `[data-season-row="${id}"] [data-action="season-control"] button`), 'the same season’s Skip');
  }
  assert.ok(!tbody(app).includes('skipped-seasons') && !cards(app).includes('skipped-seasons'), 'no skipped season left: no control');
  // A refused Skip (hidden): the row comes back.
  app.ctx.toggleSkippedSeasons(a.show.id); await settle(); // back to hidden (the choice was still Shown)
  app.refuseNext(r => r.url.endsWith('/rpc/set_season_skipped'), 'P0002', 'not_found: TV season');
  await app.ctx.setSeasonSkipped(a.rows[1].id, true); await settle();
  assert.ok(tbody(app).includes(`data-season-row="${a.rows[1].id}"`) && !tbody(app).includes('skipped-seasons'), 'refused: listed again, no control');
});

test('focus: only a season hidden as skipped goes to the control; a season that disappears otherwise keeps the existing chain', async () => {
  const a = show({ title: 'Chain', status: 'watching' }, [{ num: 1, w: true }, { num: 2, s: true }, { num: 3 }, { num: 4 }]);
  const app = await boot(all(a));
  const dom = makeMiniDom(app);
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  // Season 4 is deleted elsewhere; the view is read again while focus is on its Skip.
  dom.focus('tbody', `[data-season-row="${a.rows[3].id}"] [data-action="season-control"] button`);
  app.store.watchlist_items.splice(app.store.watchlist_items.findIndex(r => r.id === a.rows[3].id), 1);
  await app.ctx.reloadOpenView(); await settle();
  assert.ok(!tbody(app).includes(`data-season-row="${a.rows[3].id}"`));
  const el = dom.active();
  assert.ok(el && el.attrs && el.attrs['data-action'] !== 'skipped-seasons' && el === (dom.in('tbody', `[data-shortcut-show="${a.show.id}"]`) || dom.in('tbody', `[data-show-key="${a.show.id}"]`)),
    'the show’s shortcut or expand button, as before');
});

test('an open episode list hides with its season on Skip, returns locked when revealed, and comes back intact on a refusal', async () => {
  const a = show({ title: 'Listed', tmdb_id: 4242 }, [{ num: 1, w: true }, { num: 2 }, { num: 3 }]);
  const eps = [{ id: 7001, episode_number: 1, name: 'One', air_date: '2020-01-01' }, { id: 7002, episode_number: 2, name: 'Two', air_date: '2020-01-08' }];
  const tmdb = p => (/^\/tv\/4242\/season\/\d+$/.test(p) ? { id: 1, episodes: eps } : undefined);
  const app = await boot(all(a), { tmdb });
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  app.ctx.toggleEpisodes(a.rows[1].id); await settle();
  assert.ok(tbody(app).includes('Episode 1'), 'the list is open');
  app.refuseNext(r => r.url.endsWith('/rpc/set_season_skipped'), 'P0002', 'not_found: TV season');
  await app.ctx.setSeasonSkipped(a.rows[1].id, true); await settle();
  assert.ok(tbody(app).includes('Episode 1') && tbody(app).includes(`data-season-row="${a.rows[1].id}"`), 'refused: the row and its list are back');
  await app.ctx.setSeasonSkipped(a.rows[1].id, true); await settle();
  assert.ok(!tbody(app).includes('Episode 1') && !tbody(app).includes(`data-season-row="${a.rows[1].id}"`), 'hidden with its row');
  app.ctx.toggleSkippedSeasons(a.show.id); await settle();
  assert.ok(tbody(app).includes('This season is skipped, so its episodes are locked'), 'revealed: the list, locked');
});

T.run();
