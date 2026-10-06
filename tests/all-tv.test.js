// Offline tests for the All TV derived view (derived-views.js): one card per show
// (show_id) of every status, A–Z; Search / Source / show Status filters with
// Skipped hidden by default; Up to date only for a Watching show; the existing
// show status, Watched and Skip / Keep actions by real id; and GET-only loading
// that refuses incomplete reads. A TV season's own `status` column is a
// compatibility copy: these tests scramble it to prove nothing reads it.
// Run from the repo root: node tests/all-tv.test.js
// No network, no database (see tests/app-harness.js).
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('all-tv');
const test = T.test;

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
  const s = { id: nid('show'), collection: 'othertv', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 100 + n, status: 'confirmed', ...o };
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
const film = o => ({ id: nid('f'), collection: 'truecrime', title: 'Doc Film', theme: 'Studio', status: 'confirmed', watched: false,
  media_type: 'movie', tmdb_id: 900, season_number: null, season: 'Film', display_date: disp(day(5)), date_sort: day(5),
  item_key: 'doc film|film', watch_with: [], collections: [], show_id: null, skipped: false, ...o });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) });

async function openAllTv(data, opts = {}) {
  const app = await createApp({ rows: data.rows, tvShows: data.shows, ...opts });
  app.ctx.switchView('alltv'); await settle();
  return app;
}
const titlesShown = app => [...app.el('tbody').innerHTML.matchAll(/<span class="show-title">([^<]*)<\/span>/g)].map(m => m[1]);
const cardTitles = app => [...app.el('cardList').innerHTML.matchAll(/<span class="card-title">([^<]*)<\/span>/g)].map(m => m[1]);
const setFilter = (app, id, value) => { app.el(id).value = value; app.ctx.renderTable(); };
const statNums = app => [...app.el('statsRow').innerHTML.matchAll(/stat-num">(\d+)</g)].map(m => Number(m[1]));

// ─── Navigation and loading ───────────────────────────────────────────────────
test('All TV sits between Currently Watching and Coming Soon, before the collection tabs; startup is unchanged', async () => {
  const app = await createApp();
  const bar = app.el('tabBar').innerHTML;
  const at = id => bar.indexOf(`switchView('${id}')`);
  assert.ok(at('watching') >= 0 && at('watching') < at('alltv') && at('alltv') < at('comingsoon'));
  assert.ok(at('comingsoon') < bar.indexOf('tab-sep') && bar.indexOf('tab-sep') < bar.indexOf("switchTab('disney')"));
  assert.strictEqual(app.get('activeViewId'), 'watching', 'the app still opens on Currently Watching');
  app.ctx.switchMediaType('movie'); await settle();
  assert.ok(!app.el('tabBar').innerHTML.includes("switchView('alltv')"), 'not a Movies view');
  app.ctx.switchMediaType('tv'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'watching', 'Movies → TV still lands on Currently Watching');
});

test('entering All TV makes GET requests only: TV rows and every show, paginated; no seeding, no TMDB', async () => {
  const s = show({ title: 'Alpha' }, [{ num: 1 }]);
  const app = await createApp({ rows: s.rows, tvShows: [s.show] });
  const before = app.requests.length;
  app.ctx.switchView('alltv'); await settle();
  const reqs = app.requests.slice(before);
  assert.ok(reqs.length >= 2 && reqs.every(r => r.method === 'GET'), 'reads only');
  assert.ok(reqs.some(r => r.url.includes('/rest/v1/watchlist_items?') && r.url.includes('collection=in.') && r.headers.Range));
  assert.ok(reqs.some(r => r.url.includes('/rest/v1/tv_shows?') && r.headers.Range));
  assert.ok(!reqs.some(r => /rpc\/|themoviedb/.test(r.url)));
  assert.strictEqual(app.writes().length, 0);
  assert.strictEqual(app.get('activeTabId'), null);
  assert.strictEqual(app.get('tabData.disney'), undefined, 'no collection tab was loaded');
});

test('a reported-count mismatch or a failed read shows Retry, never a partial list', async () => {
  const s = show({ title: 'Alpha' }, [{ num: 1 }, { num: 2 }]);
  const app = await openAllTv(all(s), { countOverride: 5 });
  assert.ok(app.el('tbody').innerHTML.includes('Failed to load') && app.el('tbody').innerHTML.includes('loadDerivedView()'));
  assert.ok(!app.el('tbody').innerHTML.includes('derived-show-row'));
  const app2 = await createApp({ rows: s.rows, tvShows: [s.show] });
  app2.failNext(r => r.method === 'GET' && r.url.includes('/rest/v1/tv_shows'));
  app2.ctx.switchView('alltv'); await settle();
  assert.ok(app2.el('tbody').innerHTML.includes('Failed to load'));
  assert.ok(app2.el('errorBanner').innerHTML.includes("Couldn't load every TV row"));
  app2.ctx.loadDerivedView(); await settle(); // Retry
  assert.deepStrictEqual(titlesShown(app2), ['Alpha']);
  assert.strictEqual(app2.writes().length, 0);
});

test('a late All TV response never draws after leaving the view or over a newer view', async () => {
  const s = show({ title: 'Alpha', status: 'watching' }, [{ num: 1 }]);
  const app = await createApp({ rows: s.rows, tvShows: [s.show] });
  const g = app.hold(r => r.method === 'GET' && r.url.includes('collection=in.'));
  app.ctx.switchView('alltv');
  await g.reached;
  app.ctx.switchView('comingsoon'); await settle();
  g.release(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'comingsoon');
  assert.ok(app.el('tableHead').innerHTML.includes('Show &amp; Season'));
  assert.strictEqual(app.el('fStatus'), null, 'Coming Soon has no Status filter');
});

// ─── Membership, grouping and order ───────────────────────────────────────────
test('one card per show of every status except Skipped by default; Complete stays; season status copies are ignored', async () => {
  const shows = ['watching', 'highpriority', 'confirmed', 'complete', 'pending', 'maybe', 'skipped']
    .map(st => show({ title: `T-${st}`, status: st }, [{ num: 1, w: true }, { num: 2 }]));
  shows.forEach(x => x.rows.forEach(r => { r.status = 'skipped'; })); // compatibility copies say Skipped: ignored
  const app = await openAllTv(all(...shows));
  assert.deepStrictEqual(titlesShown(app),
    ['T-complete', 'T-confirmed', 'T-highpriority', 'T-maybe', 'T-pending', 'T-watching']);
  assert.deepStrictEqual(cardTitles(app), titlesShown(app), 'mobile cards list the same shows');
  assert.strictEqual(statNums(app)[0], 6, 'the count is shows, not seasons');
});

test('Status filter: All statuses adds Skipped shows; Skipped lists only them; a single status lists only that status', async () => {
  const a = show({ title: 'A', status: 'skipped' }, [{ num: 1 }]);
  const b = show({ title: 'B', status: 'complete' }, [{ num: 1, w: true }]);
  const c = show({ title: 'C', status: 'watching' }, [{ num: 1 }]);
  const app = await openAllTv(all(a, b, c));
  assert.deepStrictEqual(titlesShown(app), ['B', 'C']);
  setFilter(app, 'fStatus', 'all');      assert.deepStrictEqual(titlesShown(app), ['A', 'B', 'C']);
  setFilter(app, 'fStatus', 'skipped');  assert.deepStrictEqual(titlesShown(app), ['A']);
  setFilter(app, 'fStatus', 'complete'); assert.deepStrictEqual(titlesShown(app), ['B']);
  setFilter(app, 'fStatus', 'watching'); assert.deepStrictEqual(titlesShown(app), ['C']);
  const options = [...app.el('filtersRow').innerHTML.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
  for (const v of ['', 'all', 'watching', 'highpriority', 'confirmed', 'complete', 'pending', 'maybe', 'skipped']) assert.ok(options.includes(v), v);
  assert.ok(!options.includes('uptodate'), 'Up to date is a state, not a status');
});

test('same title in two collections and the same TMDB id in two collections stay separate cards, ordered A–Z, then source, then id', async () => {
  const d = show({ title: 'The Bear', collection: 'disney', tmdb_id: 136315, status: 'pending' }, [{ num: 1 }]);
  const o = show({ title: 'The Bear', collection: 'othertv', tmdb_id: 136315 }, [{ num: 1 }]);
  const z = show({ title: 'zeta', collection: 'othertv' }, [{ num: 1 }]);
  const a = show({ title: 'Alpha', collection: 'sheridan', tmdb_id: null }, [{ season: 'Season 1' }]);
  const app = await openAllTv(all(z, o, d, a));
  assert.deepStrictEqual(titlesShown(app), ['Alpha', 'The Bear', 'The Bear', 'zeta']);
  const body = app.el('tbody').innerHTML;
  assert.ok(body.indexOf(`toggleDerivedShow('${d.show.id}')`) < body.indexOf(`toggleDerivedShow('${o.show.id}')`), 'Disney+ before Other TV');
  const items = app.ctx.deriveAllTv(app.get('derivedData').rows, app.get('tvShowsById'), TODAY).items;
  assert.deepStrictEqual(Array.from(items, x => x.key), [a.show.id, d.show.id, o.show.id, z.show.id]);
  // Two shows with equal title and source: the show id decides, deterministically.
  const p = show({ id: 'show-b', title: 'Twin' }, [{ num: 1 }]), q = show({ id: 'show-a', title: 'Twin' }, [{ num: 1 }]);
  const r = app.ctx.deriveAllTv([...p.rows, ...q.rows], [p.show, q.show], TODAY).items;
  assert.deepStrictEqual(Array.from(r, x => x.key), ['show-a', 'show-b']);
});

test('films, unlinked rows and rows of a missing show never become groups; the view says how many seasons it could not list', async () => {
  const s = show({ title: 'Alpha' }, [{ num: 1 }]);
  const legacyFilm = { ...film({ collection: 'sheridan', media_type: null, tmdb_id: null, season: 'Film', item_key: 'x|film' }) };
  const pure = (await createApp()).ctx;
  const orphan = { ...s.rows[0], id: 'orphan', show_id: 'no-such-show' };
  const unlinked = { ...s.rows[0], id: 'unlinked', show_id: null };
  const out = pure.deriveAllTv([...s.rows, film(), legacyFilm, orphan, unlinked], [s.show], TODAY);
  assert.deepStrictEqual(Array.from(out.items, x => x.title), ['Alpha']);
  assert.strictEqual(out.items[0].seasons.length, 1);
  assert.strictEqual(out.unlinked, 1);
  assert.strictEqual(out.missingShow, 1);
  const app = await openAllTv({ rows: [...s.rows, film(), orphan], shows: [s.show] });
  assert.deepStrictEqual(titlesShown(app), ['Alpha']);
  assert.ok(app.el('tbody').innerHTML.includes('1 TV season isn’t linked to a loaded show'));
  assert.ok(!app.el('tbody').innerHTML.includes('Doc Film'));
});

test('a show without linked seasons is not listed; an empty library and an empty filter result say so differently', async () => {
  const empty = await openAllTv({ rows: [], shows: [{ id: 'lonely', collection: 'othertv', title: 'Lonely', show_key: 'lonely', tmdb_id: 1, status: 'confirmed' }] });
  assert.ok(empty.el('tbody').innerHTML.includes('No TV shows on your list yet.'));
  const s = show({ title: 'Alpha' }, [{ num: 1 }]);
  const app = await openAllTv(all(s));
  setFilter(app, 'fSearch', 'zzz');
  assert.ok(app.el('tbody').innerHTML.includes('No shows match your filters.'));
  assert.ok(app.el('cardList').innerHTML.includes('No shows match your filters.'));
});

// ─── Up next and Up to date ───────────────────────────────────────────────────
test('Up to date only for a Watching show: Complete and future-only On List shows never get the pill', async () => {
  const w = show({ title: 'W', status: 'watching' }, [{ num: 1, w: true }, { num: 2, date: day(20) }]);  // Up to date
  const p = show({ title: 'P', status: 'watching' }, [{ num: 1, w: true }, { num: 2, date: day(-5) }]); // in progress
  const c = show({ title: 'C', status: 'complete' }, [{ num: 1, w: true }]);                          // nothing remaining
  const f = show({ title: 'F', status: 'confirmed' }, [{ num: 1, date: day(30) }]);                   // future only
  const t = show({ title: 'T', status: 'confirmed' }, [{ num: 1, tba: true }]);                       // TBA only
  const app = await openAllTv(all(w, p, c, f, t));
  const items = app.ctx.deriveAllTv(app.get('derivedData').rows, app.get('tvShowsById'), TODAY).items;
  const ut = Object.fromEntries(Array.from(items, x => [x.title, x.upToDate]));
  assert.deepStrictEqual(ut, { C: false, F: false, P: false, T: false, W: true });
  const rowOf = title => app.el('tbody').innerHTML.split('<tr').find(x => x.includes(`show-title">${title}<`));
  assert.ok(rowOf('W').includes('s-caughtup">Up to date') && rowOf('W').includes(`Next: Season 2 · ${disp(day(20))}`));
  assert.ok(rowOf('P').includes(`Season 2 · ${disp(day(-5))}`) && rowOf('P').includes('toggleWatch('), 'in progress: Mark watched on up next');
  assert.ok(!rowOf('P').includes('Next: '), 'an in-progress Watching show keeps the Watching up-next label');
  assert.ok(rowOf('C').includes('No remaining season on your list') && !rowOf('C').includes('Up to date'));
  assert.ok(rowOf('F').includes(`Next: Season 1 · ${disp(day(30))}<span class="upcoming-tag">Upcoming`) && !rowOf('F').includes('Up to date'));
  assert.ok(rowOf('T').includes('Next: Season 1 · premiere date TBA'));
  for (const x of ['C', 'F', 'T']) {
    assert.ok(!rowOf(x).includes('toggleWatch('), `${x}: no collapsed watch control`);
    assert.ok(!/In progress/.test(rowOf(x)), `${x}: never labelled in progress`);
  }
  assert.deepStrictEqual(statNums(app), [5, 2, 1], 'Shows, Watching, Up to date');
});

test('up next uses the whole show, not a filtered subset; Specials never move progress', async () => {
  const s = show({ title: 'S', status: 'confirmed' }, [{ num: 0, w: true }, { num: 1, w: true }, { num: 2, date: day(-1) }, { num: 3 }]);
  const app = await openAllTv(all(s));
  const item = app.ctx.deriveAllTv(app.get('derivedData').rows, app.get('tvShowsById'), TODAY).items[0];
  assert.strictEqual(item.upNext.season, 'Season 2');
  assert.ok(app.el('tbody').innerHTML.includes(`Next: Season 2 · ${disp(day(-1))}</td>`), 'aired: no Upcoming tag');
});

// ─── Expansion and edits ─────────────────────────────────────────────────────
test('expanded: every stored season with Watched (Not aired yet until it airs) and Skip / Keep; no add, delete or Match anywhere', async () => {
  const s = show({ title: 'S', status: 'confirmed' }, [{ num: 1, w: true }, { num: 2, s: true }, { num: 3, date: day(9) }, { num: 4, tba: true }]);
  const app = await openAllTv(all(s));
  app.ctx.toggleDerivedShow(s.show.id); await settle();
  const html = app.html();
  assert.strictEqual((app.el('tbody').innerHTML.match(/sub-row/g) || []).length, 4);
  assert.strictEqual((app.el('cardList').innerHTML.match(/card-subseason-row/g) || []).length, 4);
  assert.ok(html.includes(`setSeasonSkipped('${s.rows[1].id}', false)`), 'Keep on the skipped season');
  assert.ok(html.includes(`setSeasonSkipped('${s.rows[2].id}', true)`), 'Skip on the others');
  assert.ok(html.includes('Not aired yet'));
  assert.ok(html.includes(`toggleWatch('${s.rows[0].id}')`), 'a watched season can be unmarked');
  assert.ok(!html.includes(`toggleWatch('${s.rows[2].id}')`) && !html.includes(`toggleWatch('${s.rows[3].id}')`));
  assert.ok(!/delRow\(|openTmdbMatch\(|addEntry\(|toggleAdd\(|searchTMDB\(/.test(html + app.el('filtersRow').innerHTML));
  app.ctx.toggleDerivedShow(s.show.id); await settle();
  assert.ok(!app.el('tbody').innerHTML.includes('sub-row'));
});

test('a season of a Skipped show shows "Show skipped" and the card is dimmed', async () => {
  const s = show({ title: 'Gone', status: 'skipped' }, [{ num: 1 }]);
  const app = await openAllTv(all(s));
  setFilter(app, 'fStatus', 'skipped');
  app.ctx.toggleDerivedShow(s.show.id); await settle();
  assert.ok(app.el('tbody').innerHTML.includes('derived-show-row row-skipped'));
  assert.ok(app.el('cardList').innerHTML.includes('show-group-card row-skipped'));
  assert.ok(app.html().includes('Show skipped'));
});

test('show status: one set_show_status call by real id; the show leaves the default filter when Skipped and the filters are kept', async () => {
  const a = show({ title: 'Alpha', status: 'confirmed' }, [{ num: 1 }]);
  const b = show({ title: 'Beta', status: 'confirmed', collection: 'disney', tmdb_id: null }, [{ season: 'Season 1' }]);
  const app = await openAllTv(all(a, b));
  setFilter(app, 'fSearch', 'a');
  app.ctx.renderFilters(); // a same-view re-render keeps every filter
  assert.strictEqual(app.el('fSearch').value, 'a');
  assert.deepStrictEqual(titlesShown(app), ['Alpha', 'Beta']);
  await app.ctx.setShowStatusById(a.show.id, 'skipped'); await settle();
  const w = app.writes();
  assert.strictEqual(w.length, 1);
  assert.ok(w[0].url.endsWith('/rpc/set_show_status'));
  assert.deepStrictEqual(w[0].body, { p_show_id: a.show.id, p_status: 'skipped' });
  assert.strictEqual(app.store.tv_shows.find(s => s.id === b.show.id).status, 'confirmed', 'the other show is untouched');
  assert.deepStrictEqual(titlesShown(app), ['Beta']);
  app.el('fStatus').value = 'skipped';
  app.ctx.renderFilters(); app.ctx.renderTable();
  assert.strictEqual(app.el('fStatus').value, 'skipped', 'Status survives a same-view re-render');
  assert.strictEqual(app.el('fSearch').value, 'a');
  assert.deepStrictEqual(titlesShown(app), ['Alpha']);
  await app.ctx.setShowStatusById(a.show.id, 'watching'); await settle();
  assert.deepStrictEqual(titlesShown(app), [], 'leaves the Skipped filter when it is no longer Skipped');
});

test('Watched and Skip from All TV: one function call each by row id, mirrored into a loaded tab; a failure rolls back', async () => {
  const s = show({ title: 'Alpha', status: 'watching' }, [{ num: 1, date: day(-30) }, { num: 2, date: day(-3) }]);
  const app = await createApp({ rows: s.rows, tvShows: [s.show] });
  app.ctx.switchTab('othertv'); await settle();
  app.ctx.switchView('alltv'); await settle();
  await app.ctx.toggleWatch(s.rows[0].id); await settle();
  assert.deepStrictEqual(app.writes().map(r => r.url.split('/rest/v1/')[1]), ['rpc/set_season_watched']);
  assert.strictEqual(app.get('tabData.othertv.rows').find(r => r.id === s.rows[0].id).watched, true, 'mirrored to the tab cache');
  assert.ok(app.el('tbody').innerHTML.includes('Season 2 · '), 'up next advanced');
  await app.ctx.setSeasonSkipped(s.rows[1].id, true); await settle();
  assert.strictEqual(app.writes()[1].body.p_row_id, s.rows[1].id);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === s.rows[1].id).skipped, true);
  assert.ok(app.el('tbody').innerHTML.includes('s-caughtup">Up to date'), 'nothing aired remains: Up to date');
  app.failNext(r => r.url.endsWith('/rpc/set_season_skipped'));
  await app.ctx.setSeasonSkipped(s.rows[1].id, false); await settle();
  assert.strictEqual(app.get('derivedData').rows.find(r => r.id === s.rows[1].id).skipped, true, 'rolled back');
  assert.ok(app.el('errorBanner').innerHTML.length > 0);
  app.failNext(r => r.url.endsWith('/rpc/set_show_status'));
  await app.ctx.setShowStatusById(s.show.id, 'complete'); await settle();
  assert.strictEqual(app.get('tvShowsById').get(s.show.id).status, 'watching', 'show status rolled back');
  assert.strictEqual(app.store.watchlist_items.filter(r => r.show_id === s.show.id).length, 2, 'nothing deleted or added');
});

test('Search, Source and Status combine; switching views resets filters; Watching and Coming Soon have no Status filter', async () => {
  const a = show({ title: 'Andor', collection: 'disney', tmdb_id: null, status: 'watching' }, [{ season: 'Season 1' }]);
  const b = show({ title: 'Andor Talk', collection: 'othertv', status: 'confirmed' }, [{ num: 1 }]);
  const c = show({ title: 'Bluey', collection: 'disney', tmdb_id: null, status: 'confirmed' }, [{ season: 'Season 1' }]);
  const app = await openAllTv(all(a, b, c));
  setFilter(app, 'fSearch', 'andor');  assert.deepStrictEqual(titlesShown(app), ['Andor', 'Andor Talk']);
  setFilter(app, 'fSource', 'disney'); assert.deepStrictEqual(titlesShown(app), ['Andor']);
  setFilter(app, 'fStatus', 'confirmed'); assert.deepStrictEqual(titlesShown(app), []);
  setFilter(app, 'fSearch', '');        assert.deepStrictEqual(titlesShown(app), ['Bluey']);
  app.ctx.switchView('watching'); await settle();
  assert.strictEqual(app.el('fStatus'), null);
  assert.ok(!app.el('filtersRow').innerHTML.includes('fStatus'));
  app.ctx.switchView('alltv'); await settle();
  assert.strictEqual(app.el('fSearch').value, '');
  assert.strictEqual(app.el('fStatus').value, '');
  assert.deepStrictEqual(titlesShown(app), ['Andor', 'Andor Talk', 'Bluey']);
  app.ctx.switchView('comingsoon'); await settle();
  assert.strictEqual(app.el('fStatus'), null);
});

test('header and stats follow the open view (All TV has its own branch)', async () => {
  const s = show({ title: 'Alpha', status: 'watching' }, [{ num: 1 }]);
  const app = await openAllTv(all(s));
  assert.ok(app.el('tableHead').innerHTML.includes('<th>Next</th>'));
  assert.ok(app.el('statsRow').innerHTML.includes('>Show<') || app.el('statsRow').innerHTML.includes('>Shows<'));
  app.ctx.switchView('watching'); await settle();
  assert.ok(app.el('tableHead').innerHTML.includes('<th>Up next</th>'));
  assert.ok(app.el('statsRow').innerHTML.includes('In progress'));
  app.ctx.switchView('comingsoon'); await settle();
  assert.ok(app.el('tableHead').innerHTML.includes('Show &amp; Season'));
  assert.ok(app.el('statsRow').innerHTML.includes('Next 30 days'));
});

test('phone width (375 px): filters start collapsed and cards carry the same controls', async () => {
  const s = show({ title: 'Alpha', status: 'watching' }, [{ num: 1, date: day(-2) }]);
  const app = await openAllTv(all(s), { width: 375 });
  assert.ok(app.el('filtersRow').classList.contains('collapsed'));
  const card = app.el('cardList').innerHTML;
  assert.ok(card.includes(`setShowStatusById('${s.show.id}'`) && card.includes(`toggleWatch('${s.rows[0].id}')`));
  app.ctx.toggleDerivedShow(s.show.id); await settle();
  assert.ok(app.el('cardList').innerHTML.includes(`setSeasonSkipped('${s.rows[0].id}', true)`));
});

test('no request from All TV ever uses alltv as a collection; actions never write a collection value', async () => {
  const s = show({ title: 'Alpha', status: 'confirmed' }, [{ num: 1, date: day(-2) }]);
  const app = await openAllTv(all(s));
  await app.ctx.toggleWatch(s.rows[0].id); await settle();
  await app.ctx.setShowStatusById(s.show.id, 'watching'); await settle();
  for (const r of app.requests) {
    assert.ok(!/alltv/.test(r.url), r.url);
    assert.ok(!(r.body && JSON.stringify(r.body).includes('"collection"')), 'no collection written');
  }
  app.ctx.addEntry(); await settle(); // no active collection: nothing happens
  assert.strictEqual(app.writes().length, 2);
});

T.run();
