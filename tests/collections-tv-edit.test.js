// Offline tests for S3: TV editing in collections (B1a) and D6, the unknown outcome of Watched and
// Skip (S3-D2 B) and the shared operation-reread focus rule (S3-D6 A). The page runs in the
// whole-page harness (tests/app-harness.js); focus uses the test-only DOM (tests/mini-dom.js).
// Groups follow the S3 brief (rev2) §8.1 G1–G9, §8.6 (the S3-D2 B matrix) and §8.7 (the focus matrix).
// Run from the repo root: node tests/collections-tv-edit.test.js
// No network, no database: the model is the harness's in-memory one (it is not the database).
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');
const { makeMiniDom } = require('./mini-dom');

const T = runner('collections-tv-edit');
// ONLY=<text> runs only the tests whose names contain it (for diagnosis; unset in the recorded runs).
const test = (name, fn) => (!process.env.ONLY || name.includes(process.env.ONLY)) && T.test(name, fn);

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const disp = iso => { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const copy = v => JSON.parse(JSON.stringify(v));

let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
// A show and its seasons (stored in True Crime / Docs unless said otherwise, so it is a member of that
// collection and governed by no catalog). Season specs: { num | season, w, s, date, tba, key }.
function show(o, specs) {
  const s = { id: nid('show'), collection: 'truecrime', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 100 + n, status: 'confirmed', ...o };
  const identified = s.tmdb_id != null;
  const rows = specs.map(sp => {
    const num = sp.num !== undefined ? sp.num : null;
    const label = sp.season || (num === 0 ? 'Specials' : `Season ${num}`);
    const date = sp.tba ? '2099-01-01' : (sp.date || '2020-01-01');
    return {
      id: sp.id || nid('r'), collection: s.collection, title: s.title, theme: 'Net', status: 'pending',
      watched: !!sp.w, skipped: !!sp.s, show_id: s.id,
      media_type: identified ? 'tv' : null, tmdb_id: identified ? s.tmdb_id : null, season_number: identified ? num : null,
      season: label, display_date: sp.tba ? 'TBA' : disp(date), date_sort: date,
      item_key: sp.key || `${s.show_key}|${label.toLowerCase()}`, watch_with: [], collections: []
    };
  });
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'truecrime', title: 'Film', theme: 'Doc', status: 'confirmed', watched: false,
  media_type: null, tmdb_id: null, season_number: null, season: 'Film', display_date: disp(day(-400)), date_sort: day(-400),
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });

// The library: one collection (True Crime / Docs) with shows for every flow, and films that stay read-only.
function lib() {
  const L = {};
  L.alpha = show({ title: 'Alpha', status: 'watching' }, [{ num: 1, w: true, date: day(-400) }, { num: 2, date: day(-30) }, { num: 3, date: day(90) }]);
  L.bravo = show({ title: 'Bravo', status: 'confirmed', catalog_new: true }, [{ num: 1, date: day(-200) }]);
  L.charlie = show({ title: 'Charlie', status: 'watching', status_review: true }, [{ num: 1, date: day(-300) }]);
  L.gap = show({ title: 'Gap', status: 'watching' }, [{ num: 1, date: day(-900) }, { num: 2, w: true, date: day(-500) }, { num: 3, date: day(-20) }]);
  L.lone = show({ title: 'Lone', status: 'confirmed' }, [{ num: 1, date: day(-100) }]);
  L.promote = show({ title: 'Promote Me', status: 'confirmed', tmdb_id: null }, [{ num: 1, date: day(-50) }]);
  L.split = show({ title: 'Split Me', status: 'confirmed', tmdb_id: null }, [{ num: 1, date: day(-60) }, { num: 2, date: day(-40) }]);
  L.tba = show({ title: 'Tba Show', status: 'watching' }, [{ num: 1, w: true, date: day(-700) }, { num: 2, tba: true }]);
  L.zed = show({ title: 'Zed Skipped', status: 'skipped' }, [{ num: 1, w: true, date: day(-800) }, { num: 2, date: day(-10) }]);
  L.outsider = show({ title: 'Outsider', collection: 'othertv', status: 'watching' }, [{ num: 1, date: day(-10) }]);
  L.filmA = film({ title: 'Doc One' });
  L.filmB = film({ title: 'Doc Two', watched: true });
  const shows = ['alpha', 'bravo', 'charlie', 'gap', 'lone', 'promote', 'split', 'tba', 'zed', 'outsider'].map(k => L[k]);
  L.data = { rows: shows.flatMap(x => x.rows).concat([L.filmA, L.filmB]), shows: shows.map(x => x.show) };
  return L;
}
async function boot(L = lib(), opts = {}) {
  const app = await createApp({ rows: L.data.rows, tvShows: L.data.shows, ...opts });
  return app;
}
const TC = app => app.browseId('truecrime');
async function openTC(app, status = 'all') {
  app.ctx.openBrowseCollection(TC(app)); await settle();
  if (status !== null) { app.el('fStatus').value = status; app.ctx.renderTable(); }
}
const html = app => app.el('tbody').innerHTML;
const cards = app => app.el('cardList').innerHTML;
const writes = app => app.requests.filter(r => r.method !== 'GET');
const rpc = (app, fn) => app.requests.filter(r => r.method !== 'GET' && r.url.endsWith(`/rpc/${fn}`));
const path = r => r.url.split('/rest/v1/')[1] || r.url;
const banner = app => app.el('errorBanner').innerHTML;
const notice = app => app.el('banner').innerHTML;
const saved = app => app.el('saveStatus').classList.contains('visible');
const pageRow = (app, id) => app.get(`(actionRows().find(r => r.id === ${JSON.stringify(id)}) || null)`);
const storeRow = (app, id) => app.store.watchlist_items.find(r => r.id === id);
const handlersIn = s => [...s.matchAll(/\bon(?:click|change|input|keydown)="([^"]*)"/g)].map(m => m[1].replace(/event\.stopPropagation\(\); /g, ''));
function expandAll(app, ids) { app.run(`expandedShows = new Set(${JSON.stringify(ids)})`); app.ctx.renderTable(); }

// The model's tables as validation plan §2 compares them in E0, with V-S3-1 (owner-approved): the five
// stored tables, and the two link tables through the model's derived governance views.
const CATALOGS = ['disney', '90day', 'sheridan'];
function snap(app) {
  const s = {};
  for (const t of ['watchlist_items', 'tv_shows', 'collection_memberships', 'personal_collections', 'watch_with_choices']) s[t] = copy(app.store[t] || []);
  s.catalog_show_links = app.store.tv_shows.filter(x => CATALOGS.includes(x.collection)).map(x => ({ id: x.id, catalog: x.collection, catalog_key: x.show_key }));
  s.catalog_film_links = app.store.watchlist_items.filter(r => (r.media_type === 'movie' || (r.media_type == null && r.season === 'Film')) && CATALOGS.includes(r.collection))
    .map(r => ({ id: r.id, catalog: r.collection, entry_key: r.item_key }));
  return s;
}
function diff(a, b) {
  const out = {};
  for (const t of Object.keys(a)) {
    const A = new Map(a[t].map(r => [r.id, r])), B = new Map(b[t].map(r => [r.id, r]));
    const added = [...B.keys()].filter(k => !A.has(k)).sort(), removed = [...A.keys()].filter(k => !B.has(k)).sort();
    const changed = {};
    for (const [k, r] of A) {
      if (!B.has(k)) continue;
      const f = [...new Set([...Object.keys(r), ...Object.keys(B.get(k))])].filter(x => JSON.stringify(r[x]) !== JSON.stringify(B.get(k)[x])).sort();
      if (f.length) changed[k] = f;
    }
    if (added.length || removed.length || Object.keys(changed).length) out[t] = { added, removed, changed };
  }
  return out;
}
const UNCONFIRMED = 'This change wasn’t confirmed (Failed to fetch): it may or may not have been saved, and it won’t be sent again.';
const REREAD_OK = ' The list has been read again; look at it again.';
const REREAD_FAIL = ' The list couldn’t be read again, so what is shown may be out of date; use Retry.';

// ═══ G1 (V3.1, V3.2): parity with All TV ═════════════════════════════════════
// Every handler call that names a show's or season's id (expansion toggles aside), in All TV and in
// the collection: the same set, with the same arguments.
function editCalls(s, ids) {
  return handlersIn(s).filter(h => ids.some(id => h.includes(`'${id}'`)) && !/^toggle(Derived|Browse)Show\(/.test(h) && !/^toggleFilterPill\(/.test(h)).sort();
}
const MEMBERS = ['alpha', 'bravo', 'charlie', 'gap', 'lone', 'promote', 'split', 'tba', 'zed'];
for (const [media, grouping] of [['all', 'separate'], ['all', 'combined'], ['tv', 'separate'], ['tv', 'combined']]) {
  for (const box of ['tbody', 'cardList']) {
    test(`G1 V3.1 Shows × ${grouping} × ${media} (${box}): each show has exactly All TV's controls and handler calls, plus (S4) one Remove show; no other membership control`, async () => {
      const L = lib();
      const app = await boot(L);
      app.ctx.switchView('alltv'); await settle();
      app.el('fStatus').value = 'all'; app.ctx.renderTable();
      const ids = MEMBERS.map(k => L[k].show.id);
      expandAll(app, ids);
      const allTv = Object.fromEntries(MEMBERS.map(k => [k, editCalls(app.el(box).innerHTML, [L[k].show.id, ...L[k].rows.map(r => r.id)])]));
      await openTC(app);
      app.ctx.setBrowseMedia(media); app.ctx.setBrowseGrouping(grouping); app.ctx.setBrowsePresentation('shows');
      expandAll(app, ids);
      for (const k of MEMBERS) {
        const all = editCalls(app.el(box).innerHTML, [L[k].show.id, ...L[k].rows.map(r => r.id)]);
        const col = all.filter(h => !h.startsWith('removeFromCollection('));
        assert.ok(col.length > 0, `${k}: has controls`);
        assert.deepStrictEqual(col, allTv[k], `${k}: the same handler calls as All TV`);
        assert.deepStrictEqual(all.filter(h => h.startsWith('removeFromCollection(')), [`removeFromCollection('show', '${L[k].show.id}', null)`], `${k}: S4 Remove show`);
      }
      const s = app.el(box).innerHTML;
      assert.ok(!/org_|openManage/.test(s), 'no other membership control');
      assert.deepStrictEqual(writes(app), []);
    });
  }
}
for (const [media, grouping] of [['all', 'separate'], ['all', 'combined'], ['tv', 'separate'], ['tv', 'combined']]) {
  test(`G1 V3.2 Seasons × ${grouping} × ${media}: each season entry has All TV Seasons' controls (read-only status pill; no status select, Delete, Match or Add season) and (S4, O3) Remove show`, async () => {
    const L = lib();
    const app = await boot(L);
    app.ctx.switchView('alltv'); await settle();
    app.ctx.setAllTvPresentation('seasons'); app.ctx.setAllTvSeasonVis('all');
    app.el('fStatus').value = 'all'; app.ctx.renderTable();
    app.run('derivedSectionOpen.alltvTba = true'); app.ctx.renderTable();
    const seasons = MEMBERS.flatMap(k => L[k].rows.map(r => r.id));
    const allTv = Object.fromEntries(seasons.map(id => [id, editCalls(html(app), [id])]));
    await openTC(app);
    app.ctx.setBrowseMedia(media); app.ctx.setBrowseGrouping(grouping); app.ctx.setBrowsePresentation('seasons'); app.ctx.setBrowseSeasonVis('all');
    app.run("Object.keys(browseSectionOpen).forEach(k => { browseSectionOpen[k] = true; })"); app.ctx.renderTable();
    for (const id of seasons) {
      const all = editCalls(html(app), [id]);
      assert.deepStrictEqual(all.filter(h => !h.startsWith('removeFromCollection(')), allTv[id], `${id}: All TV Seasons' calls`);
      const showId = L[MEMBERS.find(k => L[k].rows.some(r => r.id === id))].show.id;
      assert.deepStrictEqual(all.filter(h => h.startsWith('removeFromCollection(')), [`removeFromCollection('show', '${showId}', '${id}')`], `${id}: O3 Remove show`);
    }
    // (S4: films have their own controls; only the season entries are checked here.)
    const seasonRows = html(app).split('<tr').filter(r => r.includes('browse-season-row')).join('');
    assert.ok(seasonRows && !/status-select|delRow\(|openTmdbMatch\(|openAddSeason\(/.test(seasonRows), 'no status select, Delete, Match or Add season on season entries');
    assert.ok(html(app).includes('Switch to Shows to change it.'), 'the read-only status pill');
  });
}

// ═══ G2 (V3.3): catalog rules ═════════════════════════════════════════════════
async function withCatalog() {
  const probe = await createApp();
  const def = probe.get("COLLECTIONS.find(c => c.id === 'disney').defaults.find(d => d.s !== 'Film' && !/TBA/i.test(d.d))");
  const L = lib();
  const cat = show({ title: def.t, collection: 'disney', show_key: def.k.split('|')[0], tmdb_id: null, status: 'confirmed' },
    [{ season: def.s, key: def.k, date: day(-100) }, { season: 'Season 99', key: `${def.k.split('|')[0]}|season 99`, date: day(-50) }]);
  L.cat = cat;
  L.data.rows.push(...cat.rows); L.data.shows.push(cat.show);
  return L;
}
// Item 4 retired the config-based catalog lists: every season of a show a catalog governs is a catalog
// entry now (Skip, never Delete), including one added by hand.
test('G2 V3.3: a catalog season has Skip / Keep and no Delete…; so has a governed season added by hand (item 4); neither is Match-eligible', async () => {
  const L = await withCatalog();
  const app = await boot(L);
  app.ctx.openBrowseCollection(app.browseId('disney')); await settle();
  app.el('fStatus').value = 'all'; app.ctx.renderTable();
  expandAll(app, [L.cat.show.id]);
  const [catRow, own] = L.cat.rows;
  assert.ok(html(app).includes(`setSeasonSkipped('${catRow.id}', true)`) && !html(app).includes(`delRow('${catRow.id}')`), 'catalog: Skip, no Delete');
  assert.ok(html(app).includes(`setSeasonSkipped('${own.id}', true)`) && !html(app).includes(`delRow('${own.id}')`), 'governed, added by hand: Skip, no Delete (item 4)');
  assert.ok(!html(app).includes(`openTmdbMatch('${catRow.id}')`) && !html(app).includes(`openTmdbMatch('${own.id}')`), 'governed: no Match');
  await app.ctx.delRow(catRow.id); await settle();
  assert.deepStrictEqual(writes(app).map(path), ['rpc/set_season_skipped'], 'the catalog × skips, never deletes');
  assert.strictEqual(app.dialogs.length, 0, 'no question for a catalog-season skip');
});
test('G2 V3.3: Delete… in a collection is named by its effect; All TV keeps × with the same name (S3-D1 A)', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  expandAll(app, [L.lone.show.id]);
  const name = `Delete Season 1 of Lone from your library`;
  assert.ok(html(app).includes(`<button class="btn btn-link season-delete-link" onclick="delRow('${L.lone.rows[0].id}')" title="${name}" aria-label="${name}">Delete…</button>`));
  app.ctx.switchView('alltv'); await settle();
  expandAll(app, [L.lone.show.id]);
  assert.ok(html(app).includes(`<button class="del-btn" onclick="delRow('${L.lone.rows[0].id}')" title="${name}" aria-label="${name}">×</button>`));
});
test('G2 V3.3: unknown governance gives no Delete or Match; a stale delete deletes nothing and reads again', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.run('libraryGovernance = { ...libraryGovernance, knownShows: new Set(), knownItems: new Set() }');
  expandAll(app, [L.lone.show.id, L.promote.show.id]);
  assert.ok(!html(app).includes(`delRow('${L.lone.rows[0].id}')`) && !html(app).includes(`openTmdbMatch('${L.promote.rows[0].id}')`));
  const before = app.requests.length;
  await app.ctx.delRow(L.lone.rows[0].id); await settle();
  assert.deepStrictEqual(writes(app), []);
  assert.ok(app.requests.slice(before).some(r => r.url.includes('/collection_memberships')), 'the collection is read again');
  assert.match(notice(app), /couldn’t confirm whether “Lone” is a built-in catalog entry, so nothing was deleted/);
});

// ═══ G3 (V3.4): exact writes F1–F14 from a collection ═════════════════════════
async function flow(fn, { L = lib(), prep, opts = {} } = {}) {
  const app = await boot(L, opts);
  await openTC(app);
  if (prep) await prep(app, L);
  const before = snap(app), mark = app.requests.length;
  await fn(app, L); await settle(); await settle();
  return { app, L, d: diff(before, snap(app)), sent: app.requests.slice(mark).filter(r => r.method !== 'GET') };
}
const body = r => copy(r.body);
test('G3 F1 status: one library_set_show_state_b45 with the shown state; only that show changes', async () => {
  const { L, d, sent } = await flow(async (app, L) => app.ctx.setShowStateById(L.bravo.show.id, { status: 'watching' }));
  assert.deepStrictEqual(sent.map(path), ['rpc/library_set_show_state_b45']);
  assert.deepStrictEqual(body(sent[0]), { p_show_id: L.bravo.show.id, p_expected: { status: 'confirmed', priority: 'normal', ended: false, catalog_new: true, status_review: false }, p_changes: { status: 'watching' } });
  assert.deepStrictEqual(d, { tv_shows: { added: [], removed: [], changed: { [L.bravo.show.id]: ['catalog_new', 'status'] } } });
});
test('G3 F1 the same status sends nothing; a review status is an explicit choice', async () => {
  const { sent } = await flow(async (app, L) => app.ctx.setShowStateById(L.alpha.show.id, { status: 'watching' }));
  assert.deepStrictEqual(sent, []);
  const r = await flow(async (app, L) => app.ctx.setShowStateById(L.charlie.show.id, { status: 'watching' }));
  assert.deepStrictEqual(r.sent.map(path), ['rpc/library_set_show_state_b45']);
  assert.deepStrictEqual(r.d.tv_shows.changed[r.L.charlie.show.id], ['status_review']);
});
test('G3 F2 priority and F3 Show ended: one call each; only those columns', async () => {
  const p = await flow(async (app, L) => app.ctx.setShowStateById(L.alpha.show.id, { priority: 'high' }));
  assert.deepStrictEqual(body(p.sent[0]).p_changes, { priority: 'high' });
  assert.deepStrictEqual(p.d, { tv_shows: { added: [], removed: [], changed: { [p.L.alpha.show.id]: ['priority'] } } });
  const e = await flow(async (app, L) => app.ctx.setShowStateById(L.alpha.show.id, { ended: true }));
  assert.deepStrictEqual(body(e.sent[0]).p_changes, { ended: true });
  assert.deepStrictEqual(e.d, { tv_shows: { added: [], removed: [], changed: { [e.L.alpha.show.id]: ['ended'] } } });
});
test('G3 F4 Watched (the season-named shortcut): set_season_watched {p_row_id, p_watched}; only that row’s watched', async () => {
  const { app, L, d, sent } = await flow(async (app, L) => {
    assert.ok(html(app).includes(`data-shortcut-show="${L.alpha.show.id}"`) && html(app).includes('>Mark Season 2 watched</button>'));
    await app.ctx.toggleWatch(L.alpha.rows[1].id);
  });
  assert.deepStrictEqual(sent.map(r => [path(r), body(r)]), [['rpc/set_season_watched', { p_row_id: L.alpha.rows[1].id, p_watched: true }]]);
  assert.deepStrictEqual(d, { watchlist_items: { added: [], removed: [], changed: { [L.alpha.rows[1].id]: ['watched'] } } });
  assert.ok(saved(app));
  assert.ok(!html(app).includes(`toggleWatch('${L.alpha.rows[1].id}')">Mark Season 2 watched`), 'up next advanced');
});
test('G3 F4 an unaired season has no Watched control (“Not aired yet”)', async () => {
  const L = lib();
  const app = await boot(L); await openTC(app);
  expandAll(app, [L.alpha.show.id]);
  const row = html(app).split('<tr').find(r => r.includes(`data-season-row="${L.alpha.rows[2].id}"`));
  assert.ok(row.includes('Not aired yet') && !row.includes(`toggleWatch('${L.alpha.rows[2].id}')`));
});
test('G3 F5 Skip / Keep: set_season_skipped; only that row’s skipped; the season leaves the default list', async () => {
  const { app, L, d, sent } = await flow(async (app, L) => {
    app.ctx.setBrowsePresentation('seasons');
    assert.ok(html(app).includes(`setSeasonSkipped('${L.lone.rows[0].id}', true)`));
    await app.ctx.setSeasonSkipped(L.lone.rows[0].id, true);
  });
  assert.deepStrictEqual(sent.map(r => [path(r), body(r)]), [['rpc/set_season_skipped', { p_row_id: L.lone.rows[0].id, p_skipped: true }]]);
  assert.deepStrictEqual(d, { watchlist_items: { added: [], removed: [], changed: { [L.lone.rows[0].id]: ['skipped'] } } });
  assert.ok(!html(app).includes(`data-item="${L.lone.rows[0].id}"`), 'hidden under All (except Skipped)');
});
test('G3 F6 Dismiss “New” (one show): library_dismiss_catalog_new_b45 with exactly that show', async () => {
  const { L, d, sent } = await flow(async (app, L) => { expandAll(app, [L.bravo.show.id]); assert.ok(html(app).includes(`dismissShowNew('${L.bravo.show.id}')`)); await app.ctx.dismissShowNew(L.bravo.show.id); await settle(); });
  assert.deepStrictEqual(sent.map(r => [path(r), body(r)]), [['rpc/library_dismiss_catalog_new_b45', { p_expected: [{ kind: 'show', id: L.bravo.show.id }] }]]);
  assert.deepStrictEqual(d, { tv_shows: { added: [], removed: [], changed: { [L.bravo.show.id]: ['catalog_new'] } } });
});
test('G3 F7 Keep current status: library_dismiss_review_b45 for the show; only status_review', async () => {
  const { L, d, sent } = await flow(async (app, L) => app.ctx.keepCurrentStatus('show', L.charlie.show.id));
  assert.deepStrictEqual(sent.map(path), ['rpc/library_dismiss_review_b45']);
  assert.deepStrictEqual(body(sent[0]).p_kind, 'show');
  assert.deepStrictEqual(d, { tv_shows: { added: [], removed: [], changed: { [L.charlie.show.id]: ['status_review'] } } });
});
test('G3 F8 earlier seasons: start (from the collection’s rows) and stop; only the range columns', async () => {
  const { app, L, d, sent } = await flow(async (app, L) => {
    expandAll(app, [L.gap.show.id]);
    assert.ok(html(app).includes(`openResumePicker('${L.gap.show.id}')`));
    await app.ctx.startResume(L.gap.show.id, L.gap.rows[0].id);
  });
  assert.deepStrictEqual(sent.map(r => [path(r), body(r).p_start, body(r).p_end, body(r).p_set_watching]), [['rpc/library_set_resume_b45', L.gap.rows[0].id, L.gap.rows[1].id, false]]);
  assert.deepStrictEqual(d, { tv_shows: { added: [], removed: [], changed: { [L.gap.show.id]: ['resume_end_season_id', 'resume_start_season_id'] } } });
  await app.ctx.stopResume(L.gap.show.id); await settle();
  assert.deepStrictEqual(body(rpc(app, 'library_set_resume_b45')[1]).p_start, null);
});
test('G3 F9 Details: labels and Viewing progress from the collection’s rows; save sends library_set_metadata_b45 for the show only', async () => {
  const { app, L, d, sent } = await flow(async (app, L) => {
    app.ctx.openDetails('show', L.gap.show.id, null);
    assert.deepStrictEqual(copy(app.get('detailsDialog.labels')), ['Net']);
    assert.match(app.el('detailsModalBox').innerHTML, /1 earlier season unwatched/);
    app.run("detailsDialog.draft.genres = ['Drama']");
    await app.ctx.saveDetails();
  });
  assert.deepStrictEqual(sent.map(path), ['rpc/library_set_metadata_b45']);
  assert.deepStrictEqual([body(sent[0]).p_kind, body(sent[0]).p_id, body(sent[0]).p_metadata.genres], ['show', L.gap.show.id, ['Drama']]);
  assert.deepStrictEqual(Object.keys(d), ['tv_shows']);
});
test('G3 F10 Add season (TMDB kind): /tv/{id}, then library_add_seasons_b45 for that show; inserts only; no membership change; the collection is read again', async () => {
  const L = lib();
  const tmdb = p => (p === `/tv/${L.alpha.show.tmdb_id}` ? { id: L.alpha.show.tmdb_id, name: 'Alpha', networks: [{ name: 'Net' }], seasons: [{ season_number: 4, air_date: '2027-01-01', episode_count: 8 }] } : undefined);
  const { app, d, sent } = await flow(async (app, L) => {
    expandAll(app, [L.alpha.show.id]);
    assert.ok(html(app).includes(`openAddSeason('${L.alpha.show.id}')`));
    app.ctx.openAddSeason(L.alpha.show.id); await settle(); await settle();
    app.el('librarySeasonPick').querySelectorAll = () => [{ checked: true, disabled: false, dataset: { season: '4' } }];
    const mark = app.requests.length;
    await app.ctx.librarySubmitSeason(); await settle();
    assert.ok(app.requests.slice(mark).some(r => r.method === 'GET' && r.url.includes('/collection_memberships')), 'the collection is read again');
  }, { L, opts: { tmdb } });
  assert.deepStrictEqual(sent.map(path), ['rpc/library_add_seasons_b45']);
  assert.strictEqual(body(sent[0]).p_show_id, L.alpha.show.id);
  assert.strictEqual(d.watchlist_items.added.length, 1);
  assert.deepStrictEqual(Object.keys(d).sort(), ['watchlist_items']);
});
test('G3 F11 Add season (by label): empty fields refused before sending; a label adds one season to that show', async () => {
  const { app, L, d, sent } = await flow(async (app, L) => {
    app.ctx.openAddSeason(L.promote.show.id); await settle(); await settle();
    for (const [k, v] of Object.entries({ nSeason: '', nDate: '', nTheme: '' })) app.el(k).value = v;
    await app.ctx.librarySubmitSeason(); await settle();
    assert.deepStrictEqual(writes(app), [], 'nothing sent for empty fields');
    for (const [k, v] of Object.entries({ nSeason: 'Season 2', nDate: 'TBA 2027', nTheme: 'Net' })) app.el(k).value = v;
    await app.ctx.librarySubmitSeason(); await settle();
  });
  assert.deepStrictEqual(sent.map(path), ['rpc/library_add_seasons_b45']);
  assert.deepStrictEqual(d.watchlist_items.added.length, 1);
  assert.deepStrictEqual(Object.keys(d), ['watchlist_items']);
  assert.ok(app.store.watchlist_items.some(r => r.show_id === L.promote.show.id && r.season === 'Season 2'));
});
// Match (F12, F13): the fixture states M1–M14 (S3 brief rev2, E2_S3_PROPOSAL.md §5.1) in E0.
const target = (id, name, seasons) => ({ mediaType: 'tv', seasonNumber: 1, details: { id, name, networks: [{ name: 'Net' }], seasons: seasons || [{ season_number: 1, air_date: '2020-01-01' }] } });
// The target show's only collection is Disney+ (so matching a True Crime / Docs season to it is an expansion).
function onlyInDisney(app, showId) {
  const disney = app.store.personal_collections.find(c => c.legacy_source === 'disney').id;
  app.store.collection_memberships = app.store.collection_memberships.filter(m => m.show_id !== showId);
  app.store.collection_memberships.push({ id: `m-${showId}`, collection_id: disney, show_id: showId, item_id: null, created_at: '2026-10-01T00:00:00+00:00' });
}
async function match(app, rowId, tgt) {
  app.addEl('tmdbMatchBody');
  app.ctx.__tmdbMatch = { rowId, results: [], target: tgt };
  await app.ctx.confirmTmdbMatch(); await settle(); await settle();
}
test('G3 F12 M1 promote in place: the only season of an unidentified show; the show takes the identity; memberships unchanged; no new show', async () => {
  const { L, d, sent } = await flow(async (app, L) => {
    expandAll(app, [L.promote.show.id]);
    assert.ok(html(app).includes(`openTmdbMatch('${L.promote.rows[0].id}')`));
    await match(app, L.promote.rows[0].id, target(7001, 'Promote Me'));
  });
  assert.deepStrictEqual(sent.map(path), ['rpc/library_match_season_b45']);
  assert.ok(!d.collection_memberships, 'memberships unchanged');
  assert.deepStrictEqual(d.tv_shows.added, []);
  assert.ok(d.tv_shows.changed[L.promote.show.id].includes('tmdb_id'));
});
test('G3 F12 M2 new show: the source keeps its other season; a new show with the source’s collections; the source unchanged', async () => {
  const { app, L, d } = await flow(async (app, L) => { await match(app, L.split.rows[0].id, target(7002, 'Split Me')); });
  assert.strictEqual(d.tv_shows.added.length, 1);
  const newId = d.tv_shows.added[0];
  assert.strictEqual(storeRow(app, L.split.rows[0].id).show_id, newId);
  assert.strictEqual(storeRow(app, L.split.rows[1].id).show_id, L.split.show.id, 's2b stays on the source');
  assert.ok(!d.tv_shows.changed[L.split.show.id], 'the source show unchanged');
  assert.strictEqual(d.collection_memberships.added.length, 1, 'the new show joins the source’s collection');
});
test('G3 F12 M3 join with acknowledgment: declined writes nothing; accepted moves the season and deletes the emptied source with its membership', async () => {
  const L = lib();
  const tgt = show({ title: 'Target', collection: 'truecrime', tmdb_id: 7003, status: 'confirmed', priority: 'high' }, [{ num: 2, date: day(-10) }]);
  L.data.rows.push(...tgt.rows); L.data.shows.push(tgt.show);
  const { app, d } = await flow(async (app, L) => {
    await match(app, L.promote.rows[0].id, target(7003, 'Target'));
    assert.ok(app.el('tmdbMatchBody').innerHTML.includes('confirmTmdbMatchAck()'), 'the acknowledgment is asked');
    assert.deepStrictEqual(app.store.watchlist_items.find(r => r.id === L.promote.rows[0].id).show_id, L.promote.show.id, 'nothing yet');
    app.ctx.confirmTmdbMatchAck(); await settle(); await settle();
  }, { L });
  assert.strictEqual(storeRow(app, L.promote.rows[0].id).show_id, tgt.show.id);
  assert.deepStrictEqual(d.tv_shows.removed, [L.promote.show.id]);
  assert.ok(d.collection_memberships.removed.length === 1, 'the source’s membership is deleted with it');
});
test('G3 F12 M4 expansion: declined writes nothing; accepted adds exactly the missing collection; M4s a stale token blocks again', async () => {
  const L = lib();
  const tgt = show({ title: 'Disney Target', collection: 'truecrime', tmdb_id: 7004, status: 'confirmed' }, [{ num: 2, date: day(-10) }]);
  L.data.rows.push(...tgt.rows); L.data.shows.push(tgt.show);
  const app = await boot(L);
  onlyInDisney(app, tgt.show.id);
  await openTC(app);
  const before = snap(app);
  await match(app, L.promote.rows[0].id, target(7004, 'Disney Target'));
  assert.match(app.el('tmdbMatchBody').innerHTML, /Matching also adds a show to collections/);
  assert.deepStrictEqual(diff(before, snap(app)), {}, 'the proposal (and a cancel) writes nothing');
  // M4s: another season joins the target elsewhere; the token no longer matches.
  app.store.watchlist_items.push({ ...tgt.rows[0], id: 'tgt-s3', season: 'Season 3', season_number: 3, item_key: 'disney target|season 3' });
  await app.ctx.confirmTmdbMatch(true); await settle(); await settle();
  assert.match(app.el('tmdbMatchBody').innerHTML, /This changed since you looked/);
  assert.strictEqual(storeRow(app, L.promote.rows[0].id).show_id, L.promote.show.id, 'blocked again: nothing written');
  await app.ctx.confirmTmdbMatch(true); await settle(); await settle();
  if (app.el('tmdbMatchBody').innerHTML.includes('confirmTmdbMatchAck()')) { app.ctx.confirmTmdbMatchAck(); await settle(); await settle(); }
  const d = diff(before, snap(app));
  assert.strictEqual(storeRow(app, L.promote.rows[0].id).show_id, tgt.show.id);
  assert.ok(d.collection_memberships.added.length === 1, 'the target gains the missing collection');
});
test('G3 F12 M5 status mismatch blocks; M6 an identity already in the storage is refused; M7 collections changed meanwhile is refused (refusal control); nothing written', async () => {
  const L = lib();
  const tgt = show({ title: 'Watching Target', collection: 'truecrime', tmdb_id: 7005, status: 'watching' }, [{ num: 2, date: day(-10) }]);
  L.data.rows.push(...tgt.rows); L.data.shows.push(tgt.show);
  const app = await boot(L);
  await openTC(app);
  const before = snap(app);
  await match(app, L.promote.rows[0].id, target(7005, 'Watching Target'));
  assert.deepStrictEqual(diff(before, snap(app)), {}, 'M5: nothing written');
  await match(app, L.split.rows[0].id, target(7005, 'Watching Target', [{ season_number: 2, air_date: '2020-01-01' }]));
  app.refuseNext(r => r.url.endsWith('/rpc/library_match_season_b45'), 'P0001', 'match_conflict: the collections changed meanwhile. Nothing was changed.');
  await match(app, L.split.rows[1].id, target(7099, 'Fresh'));
  assert.match(banner(app), /Something else was changing the same show or collections/);
  assert.deepStrictEqual(diff(before, snap(app)), {}, 'M6 / M7: nothing written');
});
test('G3 F12 M8 no p_expansion is not reachable through the page (it always sends one); the model refuses it (E0 direct call)', async () => {
  const L = lib();
  const tgt = show({ title: 'Disney Target', collection: 'truecrime', tmdb_id: 7008, status: 'confirmed' }, [{ num: 2, date: day(-10) }]);
  L.data.rows.push(...tgt.rows); L.data.shows.push(tgt.show);
  const app = await boot(L);
  onlyInDisney(app, tgt.show.id);
  await openTC(app);
  await match(app, L.promote.rows[0].id, target(7008, 'Disney Target'));
  assert.ok(rpc(app, 'library_match_season_b45').every(r => r.body.p_expansion && typeof r.body.p_expansion === 'object'), 'the page sends p_expansion');
  const res = await app.ctx.fetch(`${app.get('SUPABASE_URL')}/rest/v1/rpc/library_match_season_b45`, { method: 'POST', body: JSON.stringify({ ...copy(rpc(app, 'library_match_season_b45')[0].body), p_expansion: null }) });
  assert.match(await res.text(), /match_needs_confirmation/);
});
test('G3 F13 M10 season → film (the show keeps a season): the row becomes a film with the show’s collections; listed in Movies with its film controls (S4)', async () => {
  const { app, L, d } = await flow(async (app, L) => {
    await match(app, L.split.rows[0].id, { mediaType: 'movie', details: { id: 8010, title: 'Split Film', release_date: '2020-01-01', genres: [{ name: 'Documentary' }], production_companies: [] } });
    if (app.el('tmdbMatchBody').innerHTML.includes('confirmTmdbMatchAck()')) { app.ctx.confirmTmdbMatchAck(); await settle(); await settle(); }
  });
  assert.strictEqual(storeRow(app, L.split.rows[0].id).media_type, 'movie');
  assert.ok(d.collection_memberships.added.length === 1, 'the film joins the show’s collection');
  assert.ok(!d.tv_shows || !d.tv_shows.removed.length, 'the show keeps its other season');
  assert.ok(html(app).includes(`data-item="${L.split.rows[0].id}"`) && html(app).includes(`setStatus('${L.split.rows[0].id}'`), 'listed as a film with its film controls (S4)');
});
test('G3 F13 M11 season → film emptying an Ended show: acknowledgment declined writes nothing; accepted deletes the show with its memberships', async () => {
  const L = lib();
  L.lone.show.ended = true;
  L.lone.show.tmdb_id = null; L.lone.rows[0].media_type = null; L.lone.rows[0].tmdb_id = null; L.lone.rows[0].season_number = null;
  const { app, d } = await flow(async (app, L) => {
    await match(app, L.lone.rows[0].id, { mediaType: 'movie', details: { id: 8011, title: 'Lone Film', release_date: '2020-01-01', genres: [{ name: 'Documentary' }], production_companies: [] } });
    assert.ok(app.el('tmdbMatchBody').innerHTML.includes('confirmTmdbMatchAck()'));
    app.ctx.confirmTmdbMatchAck(); await settle(); await settle();
  }, { L });
  assert.deepStrictEqual(d.tv_shows.removed, [L.lone.show.id]);
  assert.strictEqual(storeRow(app, L.lone.rows[0].id).media_type, 'movie');
});
test('G3 F13 M12 a skipped + watched season asks for a state choice first; M14 a film identity already listed is refused', async () => {
  const L = lib();
  L.zed.show.tmdb_id = null; L.zed.rows.forEach(r => { r.media_type = null; r.tmdb_id = null; r.season_number = null; });
  const dune = film({ id: 'f-known', title: 'Known', media_type: 'movie', tmdb_id: 8014, collection: 'movies' });
  L.data.rows.push(dune);
  const app = await boot(L);
  await openTC(app);
  const before = snap(app);
  await match(app, L.zed.rows[0].id, { mediaType: 'movie', details: { id: 8012, title: 'Zed Film', release_date: '2020-01-01', genres: [{ name: 'Documentary' }], production_companies: [] } });
  assert.match(app.el('tmdbMatchBody').innerHTML, /chooseTmdbMatchState/);
  assert.deepStrictEqual(diff(before, snap(app)), {}, 'M12: nothing until chosen');
  await match(app, L.split.rows[0].id, { mediaType: 'movie', details: { id: 8014, title: 'Known', release_date: '2020-01-01', genres: [], production_companies: [] } });
  assert.deepStrictEqual(diff(before, snap(app)), {}, 'M14: nothing written');
});
test('G3 M9 / M13 (film-origin, owner clarification): since S4 a film in a collection matches as in All Movies (film → film: identity only)', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  await match(app, L.filmA.id, { mediaType: 'movie', details: { id: 8013, title: 'Doc One', release_date: '2019-01-01', genres: [{ name: 'Documentary' }], production_companies: [] } });
  assert.deepStrictEqual(rpc(app, 'library_match_film_b45').length, 1);
  assert.strictEqual(storeRow(app, L.filmA.id).tmdb_id, 8013, 'M13: identity only');
});
// F14 / F15 (D6)
test('G3 F14 Delete… (last season): D6-b text, Cancel sends nothing; confirmed: delete_tv_season, the show and its memberships go, the collection is read again', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.dialogAnswer = 'cancel';
  await app.ctx.delRow(L.lone.rows[0].id); await settle();
  assert.strictEqual(app.dialogs[0].text, 'Delete “Lone · Season 1” from your library? It is removed everywhere: All TV, Currently Watching and every collection it’s in. This is the show’s last season, so the show is deleted too, along with its place in every collection. To keep it but take the show out of True Crime / Docs only, use Remove show from True Crime / Docs instead.');
  assert.deepStrictEqual([app.dialogs[0].cancelLabel, app.dialogs[0].confirmLabel, app.dialogs[0].focus], ['Cancel', 'Delete from library', 'effectCancel']);
  assert.deepStrictEqual(writes(app), [], 'Cancel: nothing sent');
  app.dialogAnswer = 'confirm';
  const before = snap(app), mark = app.requests.length;
  await app.ctx.delRow(L.lone.rows[0].id); await settle(); await settle();
  assert.deepStrictEqual(writes(app).map(r => [path(r), body(r)]), [['rpc/delete_tv_season', { p_row_id: L.lone.rows[0].id, p_marks_expected: 0 }]]);
  const d = diff(before, snap(app));
  assert.deepStrictEqual([d.watchlist_items.removed, d.tv_shows.removed, d.collection_memberships.removed.length], [[L.lone.rows[0].id], [L.lone.show.id], 1]);
  assert.ok(app.requests.slice(mark).some(r => r.method === 'GET' && r.url.includes('/collection_memberships')), 'the collection is read again');
  assert.ok(!/didn’t include/.test(html(app)), 'no stale member line');
});
test('G3 F14 the earlier-seasons sentence is kept; not the last season: no last-season sentence', async () => {
  const L = lib();
  L.gap.show.resume_start_season_id = L.gap.rows[0].id; L.gap.show.resume_end_season_id = L.gap.rows[1].id;
  const app = await boot(L);
  await openTC(app);
  app.dialogAnswer = 'cancel';
  await app.ctx.delRow(L.gap.rows[0].id); await settle();
  assert.strictEqual(app.dialogs[0].text, 'Delete “Gap · Season 1” from your library? It is removed everywhere: All TV, Currently Watching and every collection it’s in. The earlier-seasons choice for “Gap” ends too. To keep it but take the show out of True Crime / Docs only, use Remove show from True Crime / Docs instead.');
});
for (const [label, act] of [
  ['the view changed', app => app.ctx.switchView('alltv')],
  ['the row is gone', (app, L) => app.run(`browseData.rows = browseData.rows.filter(r => r.id !== ${JSON.stringify(L.gap.rows[0].id)})`)],
  ['its rule changed (unknown governance)', app => app.run('libraryGovernance = { ...libraryGovernance, knownShows: new Set(), knownItems: new Set() }')]
]) {
  test(`G5 D6 after the answer: ${label} while the question was open → nothing is sent`, async () => {
    const L = lib();
    const app = await boot(L);
    await openTC(app);
    app.dialogAnswer = 'hold';
    const p = app.ctx.delRow(L.gap.rows[0].id); await settle();
    assert.strictEqual(app.dialogs.length, 1);
    await act(app, L);
    if (app.get('effectDialog')) app.answerDialog(true);
    await p; await settle();
    assert.deepStrictEqual(writes(app), []);
  });
}
test('G3 F14 R (a refusal) puts the row back; U (both loss modes) reads again, never resends; not_found counts as deleted', async () => {
  for (const mode of ['refuse', 'before', 'after', 'gone']) {
    const L = lib();
    const app = await boot(L);
    await openTC(app);
    const id = L.gap.rows[0].id;
    if (mode === 'refuse') app.refuseNext(r => r.url.endsWith('/rpc/delete_tv_season'), 'P0001', 'target_changed: changed elsewhere');
    else if (mode === 'gone') app.store.watchlist_items = app.store.watchlist_items.filter(r => r.id !== id);
    else app.loseNext(r => r.url.endsWith('/rpc/delete_tv_season'), mode);
    const mark = app.requests.length;
    await app.ctx.delRow(id); await settle(); await settle();
    assert.strictEqual(rpc(app, 'delete_tv_season').length, 1, `${mode}: sent once`);
    if (mode === 'refuse') { assert.ok(pageRow(app, id), 'the row is back'); assert.match(banner(app), /Couldn’t delete/); }
    if (mode === 'before' || mode === 'after') {
      assert.ok(app.requests.slice(mark).some(r => r.method === 'GET' && r.url.includes('/collection_memberships')), `${mode}: read again`);
      assert.match(banner(app), /no clear answer came back/);
      assert.strictEqual(!!storeRow(app, id), mode === 'before');
      assert.strictEqual(!!pageRow(app, id), mode === 'before', `${mode}: the page shows what is stored`);
    }
    if (mode === 'gone') assert.strictEqual(banner(app), '', 'not_found counts as deleted');
  }
});
test('G5 D6-a All TV season ×: the dialog and wording; D6-c All Movies film ×; D6-d catalog film: existing text and Skip film; no dialog mentions Remove or membership', async () => {
  const L = await withCatalog();
  const probe = await createApp();
  const fdef = probe.get("COLLECTIONS.find(c => c.id === 'disney').defaults.find(d => d.s === 'Film')");
  const catFilm = film({ id: 'f-cat', title: fdef.t, collection: 'disney', item_key: fdef.k, watched: true });
  const own = film({ id: 'f-own', title: 'Own Film', collection: 'movies', media_type: 'movie', tmdb_id: 9001 });
  L.data.rows.push(catFilm, own);
  const app = await boot(L);
  app.ctx.switchView('alltv'); await settle();
  app.dialogAnswer = 'cancel';
  await app.ctx.delRow(L.gap.rows[0].id); await settle();
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = ''; app.el('fStatus').value = 'all'; app.ctx.renderTable();
  await app.ctx.delRow('f-own'); await settle();
  await app.ctx.delRow('f-cat'); await settle();
  assert.deepStrictEqual(app.dialogs.map(d => [d.text, d.confirmLabel]), [
    ['Delete “Gap · Season 1” from your library? It is removed everywhere: All TV, Currently Watching and every collection it’s in.', 'Delete from library'],
    ['Delete “Own Film” from your library? It is removed everywhere: All Movies and every collection it’s in.', 'Delete from library'],
    [`Skip “${fdef.t}”? It’s part of a built-in catalog, so it is marked Skipped rather than deleted. This also clears Watched.`, 'Skip film']]);
  assert.ok(app.dialogs.every(d => !/\bremove\b|membership/i.test(d.text)), 'no Remove and no membership in any dialog');
  assert.deepStrictEqual(writes(app), [], 'Cancel: nothing sent');
  app.dialogAnswer = 'confirm';
  await app.ctx.delRow('f-own'); await settle();
  await app.ctx.delRow('f-cat'); await settle();
  assert.deepStrictEqual(writes(app).map(r => r.method + ' ' + path(r)), ['DELETE watchlist_items?id=eq.f-own', 'POST rpc/library_set_film_state_b45']);
  assert.deepStrictEqual(body(writes(app)[1]).p_changes, { state: 'skipped' });
});
test('G5 the dialog: Cancel has default focus; Escape cancels; Tab stays on its two buttons; one at a time; switchView answers Cancel; focus returns to the opener', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  const opener = { id: 'opener', isConnected: true, focus() { app.ctx.document.activeElement = this; } };
  opener.focus();
  app.dialogAnswer = 'hold';
  const p1 = app.ctx.askEffect('Q?', 'Do it');
  await settle();
  assert.strictEqual(app.dialogs[0].focus, 'effectCancel');
  assert.strictEqual(await app.ctx.askEffect('Second?', 'Again'), false, 'a second question while one is open is Cancel');
  app.ctx.effectDialogKeydown({ key: 'Tab', preventDefault() {} });
  assert.strictEqual(app.ctx.document.activeElement.id, 'effectConfirm');
  app.ctx.effectDialogKeydown({ key: 'Tab', preventDefault() {} });
  assert.strictEqual(app.ctx.document.activeElement.id, 'effectCancel');
  app.ctx.effectDialogKeydown({ key: 'Escape', preventDefault() {} });
  assert.strictEqual(await p1, false, 'Escape cancels');
  assert.ok(app.ctx.document.activeElement === opener, 'focus back on the opener');
  const p2 = app.ctx.askEffect('Q2?', 'Do it'); await settle();
  app.ctx.switchView('alltv'); await settle();
  assert.strictEqual(await p2, false, 'leaving the view answers Cancel');
  assert.strictEqual(app.el('effectModalOverlay').style.display, 'none');
});
test('G5 catalog-season skip has no dialog; the other confirm() questions are unchanged (Start earlier seasons on a To Watch show)', async () => {
  const L = lib();
  L.gap.show.status = 'confirmed';
  const app = await boot(L);
  await openTC(app);
  const asked = [];
  app.ctx.confirm = q => { asked.push(q); return false; };
  await app.ctx.startResume(L.gap.show.id, L.gap.rows[0].id); await settle();
  assert.match(asked[0], /Start watching earlier seasons of “Gap”\? This sets the status to Watching\./);
  assert.strictEqual(app.dialogs.length, 0);
});

// ═══ G3 error paths per flow from a collection (review finding 3; requirements map §C) ════════
// §8.6 covers Watched / Skip (F4 / F5) only. These are the other flows' R / U / N cases the plan
// lists, run from a collection: R a stale refusal (nothing stored changed; the page shows what is
// stored; the collection read again), U a lost answer before / after commit (not confirmed, read
// again, never resent), N another tab first. (An answer after a restore can't happen since Batch A:
// the restore waits for the write lane.)
const TARGET_CHANGED = 'target_changed: This changed since the page showed it, so nothing was changed. Look at it again.';
const memGets = (app, mark) => app.requests.slice(mark).filter(r => r.method === 'GET' && r.url.includes('/collection_memberships')).length;
const showIn = (app, id) => app.get(`(tvShowsById.get(${JSON.stringify(id)}) || null)`);
const storeShow = (app, id) => app.store.tv_shows.find(s => s.id === id);
const SHOW_FLOWS = [
  ['F1', 'status', 'library_set_show_state_b45', L => L.bravo.show.id, 'status', (app, L) => app.ctx.setShowStateById(L.bravo.show.id, { status: 'watching' }), ['R', 'Ub', 'Ua', 'N']],
  ['F2', 'priority', 'library_set_show_state_b45', L => L.alpha.show.id, 'priority', (app, L) => app.ctx.setShowStateById(L.alpha.show.id, { priority: 'high' }), ['R', 'Ub', 'Ua']],
  ['F3', 'Show ended', 'library_set_show_state_b45', L => L.alpha.show.id, 'ended', (app, L) => app.ctx.setShowStateById(L.alpha.show.id, { ended: true }), ['R', 'Ub', 'Ua']],
  ['F6', 'Dismiss “New”', 'library_dismiss_catalog_new_b45', L => L.bravo.show.id, 'catalog_new', (app, L) => app.ctx.dismissCatalogNew([{ kind: 'show', id: L.bravo.show.id }]), ['R', 'Ub', 'Ua']],
  ['F7', 'Keep current status', 'library_dismiss_review_b45', L => L.charlie.show.id, 'status_review', (app, L) => app.ctx.keepCurrentStatus('show', L.charlie.show.id), ['R']],
  ['F8', 'earlier seasons', 'library_set_resume_b45', L => L.gap.show.id, 'resume_start_season_id', (app, L) => app.ctx.startResume(L.gap.show.id, L.gap.rows[0].id), ['R']]
];
for (const [F, what, endpoint, idOf, field, act, outcomes] of SHOW_FLOWS) {
  const pred = r => r.method !== 'GET' && r.url.endsWith(`/rpc/${endpoint}`);
  for (const o of outcomes) {
    const title = { R: 'R (refused as stale): nothing stored changes; the page shows what is stored; the collection is read again; not resent',
      Ub: 'U lost before commit: not confirmed, read again, never resent; nothing stored', Ua: 'U lost after commit: not confirmed, read again, never resent; the page shows the stored change',
      N: 'N another tab, then the lost answer: one request; the new view is read; nothing resent' }[o];
    test(`G3 ${F} ${what} ${title}`, async () => {
      const L = lib();
      const app = await boot(L);
      await openTC(app);
      const id = idOf(L);
      const before = snap(app);
      let mark = app.requests.length;
      if (o === 'R') app.refuseNext(pred, 'P0001', F === 'F8' ? 'invalid_range: The earlier-seasons range no longer applies, so nothing was changed.' : TARGET_CHANGED);
      if (o === 'Ub' || o === 'Ua') app.loseNext(pred, o === 'Ub' ? 'before' : 'after');
      if (o === 'N') {
        const g = app.hold(pred);
        const p = act(app, L);
        await g.reached;
        app.ctx.selectCollectionTab(app.browseId('disney').split(':')[1]); await settle(); mark = app.requests.length; g.lose('before');
        await p; await settle(); await settle();
      } else { await act(app, L); await settle(); await settle(); }
      assert.strictEqual(rpc(app, endpoint).length, 1, 'one request, never resent');
      assert.ok(!saved(app), 'no Saved');
      if (o === 'N') {
        assert.match(banner(app), /This change wasn’t confirmed/);
        assert.ok(app.requests.slice(mark).some(r => r.method === 'GET'), 'the open view (another collection) is read again');
        assert.ok(app.get('activeViewId') === app.browseId('disney'), 'the new view stays');
        assert.deepStrictEqual(diff(before, snap(app)), {}, 'nothing stored');
        return;
      }
      assert.ok(memGets(app, mark) >= 1, 'the collection is read again');
      if (o === 'R') assert.ok(banner(app) && !/wasn’t confirmed/.test(banner(app)) && /read again/.test(banner(app)), `the refusal and the reread are said: ${banner(app)}`);
      else assert.strictEqual(banner(app), `<div class="error-banner">⚠️ ${UNCONFIRMED}${REREAD_OK}</div>`);
      const d = diff(before, snap(app));
      if (o === 'Ua') assert.ok(d.tv_shows && d.tv_shows.changed[id], 'stored');
      else assert.deepStrictEqual(d, {}, 'nothing stored');
      assert.deepStrictEqual(showIn(app, id)[field] ?? null, storeShow(app, id)[field] ?? null, 'the page shows what is stored');
    });
  }
}
test('G3 F8 the picker opened and closed sends nothing; a To Watch show asks the existing confirm(): Cancel sends nothing, OK sends p_set_watching', async () => {
  const L = lib();
  L.gap.show.status = 'confirmed';
  const app = await boot(L);
  await openTC(app);
  expandAll(app, [L.gap.show.id]);
  app.ctx.openResumePicker(L.gap.show.id); app.ctx.openResumePicker(L.gap.show.id); await settle();
  const asked = [];
  app.ctx.confirm = q => { asked.push(q); return false; };
  await app.ctx.startResume(L.gap.show.id, L.gap.rows[0].id); await settle();
  assert.deepStrictEqual(writes(app), [], 'nothing sent');
  assert.deepStrictEqual(asked, ['Start watching earlier seasons of “Gap”? This sets the status to Watching.']);
  app.ctx.confirm = () => true;
  await app.ctx.startResume(L.gap.show.id, L.gap.rows[0].id); await settle();
  assert.deepStrictEqual(rpc(app, 'library_set_resume_b45').map(r => body(r).p_set_watching), [true]);
});
test('G3 F9 Details: invalid values, a closed dialog and a restore send nothing', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.openDetails('show', L.gap.show.id, null);
  app.ctx.detailsAddValue('franchises'); app.ctx.detailsSetValue('franchises', 0, 'x'.repeat(81));
  await app.ctx.saveDetails(); await settle();
  assert.match(app.get('detailsDialog.error'), /^Not saved: Franchise \/ universe: .* is longer than 80 characters\./);
  app.ctx.closeDetails(); await app.ctx.saveDetails(); await settle();
  app.ctx.openDetails('show', L.gap.show.id, null);
  app.run("detailsDialog.draft.genres = ['Drama']; detailsDialog.restored = true"); // a restore ran since it opened
  await app.ctx.saveDetails(); await settle();
  assert.deepStrictEqual(writes(app), [], 'nothing sent');
});
for (const o of ['R', 'Ub', 'Ua']) {
  test(`G3 F9 Details ${o === 'R' ? 'R (refused as stale)' : `U lost ${o === 'Ub' ? 'before' : 'after'} commit`}: the dialog keeps the draft and says so; the collection is read again; not resent`, async () => {
    const L = lib();
    const app = await boot(L);
    await openTC(app);
    app.ctx.openDetails('show', L.gap.show.id, null);
    app.run("detailsDialog.draft.genres = ['Drama']");
    const pred = r => r.url.endsWith('/rpc/library_set_metadata_b45');
    if (o === 'R') app.refuseNext(pred, 'P0001', TARGET_CHANGED); else app.loseNext(pred, o === 'Ub' ? 'before' : 'after');
    const mark = app.requests.length;
    await app.ctx.saveDetails(); await settle(); await settle();
    assert.strictEqual(rpc(app, 'library_set_metadata_b45').length, 1);
    assert.strictEqual(app.get('detailsDialog && detailsDialog.stale'), o === 'R' ? 'changed' : 'unknown');
    assert.deepStrictEqual(copy(app.get('detailsDialog.draft.genres')), ['Drama'], 'the draft is kept');
    assert.ok(memGets(app, mark) >= 1, 'the collection is read again');
    assert.match(app.get('detailsDialog.notice'), /read again/);
    assert.ok(!saved(app));
  });
}
// F10 (Add season, TMDB kind): what the plan lists beyond G3 F10's success case.
const addTmdb = L => p => (p === `/tv/${L.alpha.show.tmdb_id}` ? { id: L.alpha.show.tmdb_id, name: 'Alpha', networks: [{ name: 'Net' }], seasons: [{ season_number: 4, air_date: '2027-01-01', episode_count: 8 }] } : undefined);
async function addSeasonOpen(L, tmdb) {
  const app = await boot(L, { tmdb });
  await openTC(app);
  app.el('fSearch').value = 'Al'; app.ctx.renderTable();
  app.ctx.openAddSeason(L.alpha.show.id); await settle(); await settle();
  app.el('librarySeasonPick').querySelectorAll = () => [{ checked: true, disabled: false, dataset: { season: '4' } }];
  return app;
}
test('G3 F10 the show changed since the panel opened → nothing sent; a TMDB failure → nothing to add, nothing sent', async () => {
  const L = lib();
  const app = await addSeasonOpen(L, addTmdb(L));
  storeShow(app, L.alpha.show.id).tmdb_id = 99999;
  await app.ctx.librarySubmitSeason(); await settle();
  assert.match(app.el('libraryOutcome').innerHTML, /This show changed or is gone since you opened it, so nothing was added/);
  const L2 = lib();
  const app2 = await boot(L2, { tmdb: () => { throw new Error('TMDB down'); } });
  await openTC(app2);
  app2.ctx.openAddSeason(L2.alpha.show.id); await settle(); await settle();
  assert.ok(!app2.el('librarySeasonPick') || !/data-season=/.test(app2.el('librarySeasonPick').innerHTML), 'no season to pick');
  await app2.ctx.librarySubmitSeason(); await settle();
  assert.deepStrictEqual([writes(app), writes(app2)], [[], []], 'nothing sent');
});
for (const o of ['R', 'Ub']) {
  test(`G3 F10 ${o === 'R' ? 'R (refused as stale): reported; the collection is read again with its filters kept' : 'U lost before commit: not confirmed, never resent, nothing added'}`, async () => {
    const L = lib();
    const app = await addSeasonOpen(L, addTmdb(L));
    const pred = r => r.url.endsWith('/rpc/library_add_seasons_b45');
    if (o === 'R') app.refuseNext(pred, 'P0001', TARGET_CHANGED); else app.loseNext(pred, 'before');
    const before = snap(app), mark = app.requests.length;
    await app.ctx.librarySubmitSeason(); await settle(); await settle();
    assert.strictEqual(rpc(app, 'library_add_seasons_b45').length, 1, 'one request, never resent');
    assert.deepStrictEqual(diff(before, snap(app)), {}, 'nothing added');
    const out = app.el('libraryOutcome').innerHTML;
    if (o === 'R') {
      assert.ok(/error-banner/.test(out) && !/can’t tell|wasn’t confirmed|may or may not/.test(out), out);
      assert.ok(memGets(app, mark) >= 1, 'the collection is read again');
      assert.strictEqual(app.el('fSearch').value, 'Al', 'its filters kept');
    } else assert.match(out, /can’t tell|may or may not|wasn’t confirmed/, out);
    assert.ok(!saved(app));
  });
}
test('G3 F10 a successful add: the collection reread keeps its filters', async () => {
  const L = lib();
  const app = await addSeasonOpen(L, addTmdb(L));
  const mark = app.requests.length;
  await app.ctx.librarySubmitSeason(); await settle(); await settle();
  assert.ok(memGets(app, mark) >= 1);
  assert.strictEqual(app.el('fSearch').value, 'Al');
});
test('G3 F11 Add season (by label): the label “Film” is refused before sending', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.openAddSeason(L.promote.show.id); await settle(); await settle();
  for (const [k, v] of Object.entries({ nSeason: 'Film', nDate: 'TBA 2027', nTheme: 'Net' })) app.el(k).value = v;
  await app.ctx.librarySubmitSeason(); await settle();
  assert.deepStrictEqual(writes(app), [], 'nothing sent');
  assert.match(app.el('libraryOutcome').innerHTML, /A film isn’t a season; add films in Movies\./);
});
// F12 / F13: a lost Match answer (U) and a stale refusal of a film Match (R) from a collection.
for (const [F, rowOf, tgt, endpoint] of [
  ['F12', L => L.promote.rows[0].id, () => target(7001, 'Promote Me'), 'library_match_season_b45'],
  ['F13', L => L.split.rows[0].id, () => ({ mediaType: 'movie', details: { id: 8010, title: 'Split Film', release_date: '2020-01-01', genres: [{ name: 'Documentary' }], production_companies: [] } }), 'library_match_film_b45']
]) {
  for (const o of F === 'F12' ? ['Ub'] : ['R', 'Ub']) {
    test(`G3 ${F} Match ${o === 'R' ? 'R (refused as stale): nothing written; reported' : 'U lost before commit: not confirmed, read again, never resent; nothing claimed'}`, async () => {
      const L = lib();
      const app = await boot(L);
      await openTC(app);
      const pred = r => r.url.endsWith(`/rpc/${endpoint}`);
      if (o === 'R') app.refuseNext(pred, 'P0001', TARGET_CHANGED); else app.loseNext(pred, 'before');
      const before = snap(app);
      await match(app, rowOf(L), tgt());
      if (app.el('tmdbMatchBody').innerHTML.includes('confirmTmdbMatchAck()')) { app.ctx.confirmTmdbMatchAck(); await settle(); await settle(); }
      assert.strictEqual(rpc(app, endpoint).length, 1, 'one request, never resent');
      assert.deepStrictEqual(diff(before, snap(app)), {}, 'nothing written');
      const said = app.el('tmdbMatchBody').innerHTML + banner(app) + notice(app);
      if (o === 'R') assert.ok(/target_changed|changed since|nothing was changed/i.test(said) && !/can.t tell/.test(said), said);
      else assert.match(said, /wasn’t confirmed.*won’t be sent again\. The list has been read again/);
      assert.ok(!saved(app));
    });
  }
}

// F5 (Skip) from a collection: R and X (§8.6 covers its U; its R and X loops use Watched).
test('G3 F5 Skip R from a collection: a database refusal puts it back with the error; no reread; not resent', async () => {
  const L = lib();
  const app = await boot(L);
  await VIEWS.colSeasons(app);
  const id = L.alpha.rows[1].id;
  app.refuseNext(r => r.url.endsWith('/rpc/set_season_skipped'), 'P0002', 'not_found: TV season');
  const mark = app.requests.length;
  await app.ctx.setSeasonSkipped(id, true); await settle(); await settle();
  assert.strictEqual(rpc(app, 'set_season_skipped').length, 1);
  assert.strictEqual(!!pageRow(app, id).skipped, false, 'put back');
  assert.match(banner(app), /Supabase error 400/);
  assert.strictEqual(memGets(app, mark), 0, 'no reread');
});
// F15: the D6 dialogs confirmed, then refused (R) or the answer lost (U): All TV's season ×
// (D6-a), All Movies' film × (D6-c), a catalog film's Skip (D6-d). G5 covers Cancel and the words.
async function d6App() {
  const L = await withCatalog();
  const probe = await createApp();
  const fdef = probe.get("COLLECTIONS.find(c => c.id === 'disney').defaults.find(d => d.s === 'Film')");
  L.data.rows.push(film({ id: 'f-cat', title: fdef.t, collection: 'disney', item_key: fdef.k }),
    film({ id: 'f-own', title: 'Own Film', collection: 'movies', media_type: 'movie', tmdb_id: 9001 }));
  return { L, app: await boot(L) };
}
const D6 = [
  ['D6-a All TV season ×', 'alltv', L => L.gap.rows[0].id, r => r.url.endsWith('/rpc/delete_tv_season')],
  ['D6-c All Movies film ×', 'movies', () => 'f-own', r => r.method === 'DELETE' && r.url.includes('id=eq.f-own')],
  ['D6-d catalog film Skip', 'movies', () => 'f-cat', r => r.url.endsWith('/rpc/library_set_film_state_b45')]
];
for (const [label, where, idOf, pred] of D6) {
  for (const o of ['R', 'Ub']) {
    test(`G5 F15 ${label} confirmed, ${o === 'R' ? 'R (refused): the entry comes back, the refusal is said, nothing stored changes' : 'U lost before commit: not confirmed, read again, never resent'}`, async () => {
      const { L, app } = await d6App();
      app.ctx.switchView('alltv'); await settle();
      if (where === 'movies') { app.ctx.switchMediaType('movie'); await settle(); app.el('fWatch').value = ''; app.el('fStatus').value = 'all'; app.ctx.renderTable(); }
      const id = idOf(L);
      if (o === 'R') app.refuseNext(pred, 'P0001', TARGET_CHANGED); else app.loseNext(pred, 'before');
      const before = snap(app), mark = app.requests.length;
      await app.ctx.delRow(id); await settle(); await settle();
      assert.strictEqual(app.dialogs.length, 1, 'the D6 dialog was asked and confirmed');
      assert.strictEqual(app.requests.slice(mark).filter(r => r.method !== 'GET').length, 1, 'one request, never resent');
      assert.deepStrictEqual(diff(before, snap(app)), {}, 'nothing stored changed');
      assert.ok(pageRow(app, id), 'the entry is listed (put back or read again)');
      if (o === 'R') assert.ok(banner(app) && !/no clear answer|wasn’t confirmed/.test(banner(app)), banner(app));
      else {
        assert.match(banner(app), /no clear answer|wasn’t confirmed/);
        assert.ok(app.requests.slice(mark).some(r => r.method === 'GET'), 'read again');
      }
      assert.ok(!saved(app));
    });
  }
}

// ═══ G4 (V3.5): shared show records ═══════════════════════════════════════════
test('G4: after a collection read, tvShowsById holds exactly the shows read, in read order (the former browseData.showsById)', async () => {
  const app = await boot();
  await openTC(app);
  const read = app.requests.filter(r => r.method === 'GET' && /\/tv_shows\?select=\*&order=id\.asc/.test(r.url));
  assert.ok(read.length > 0, 'the collection read the shows (strict, ordered by id)');
  assert.deepStrictEqual(copy(app.get('[...tvShowsById.keys()]')), app.store.tv_shows.map(s => s.id).sort(), 'every show read, in the read order');
  assert.strictEqual(app.get('browseData.showsById'), undefined);
});
test('G4: a show edited in a collection is the same show object in All TV and Currently Watching', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  await app.ctx.setShowStateById(L.bravo.show.id, { status: 'watching' }); await settle();
  const obj = app.get(`tvShowsById.get(${JSON.stringify(L.bravo.show.id)})`);
  assert.strictEqual(obj.status, 'watching');
  app.ctx.switchView('alltv'); await settle();
  assert.ok(html(app).includes(`setShowStateById('${L.bravo.show.id}', { status: this.value })`));
  assert.strictEqual(app.get(`tvShowsById.get(${JSON.stringify(L.bravo.show.id)}).status`), 'watching');
});
test('G4: a collection reread that finishes while a show edit is pending never replaces the edit', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  const g = app.hold(r => r.url.endsWith('/rpc/library_set_show_state_b45'));
  const p = app.ctx.setShowStateById(L.bravo.show.id, { status: 'watching' });
  await g.reached;
  await app.ctx.loadBrowseView(); await settle();
  assert.strictEqual(app.get(`tvShowsById.get(${JSON.stringify(L.bravo.show.id)}).status`), 'watching', 'the pending edit stands');
  g.release(); await p; await settle();
  assert.strictEqual(app.store.tv_shows.find(s => s.id === L.bravo.show.id).status, 'watching');
});
test('G4: a late collection read after leaving draws nothing', async () => {
  const app = await boot();
  await openTC(app);
  const g = app.hold(r => r.method === 'GET' && r.url.includes('/collection_memberships'));
  const p = app.ctx.loadBrowseView(); await g.reached;
  app.ctx.switchView('alltv'); await settle();
  const before = html(app);
  g.release(); await p; await settle();
  assert.strictEqual(html(app), before);
});

// ═══ G7 (V3.8): filters and counts ════════════════════════════════════════════
test('G7: an edited-out entry disappears, counts follow, and chips, the More filters panel and filter memory are untouched', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app, '');
  app.ctx.toggleFilterPanel(true);
  const memory = JSON.stringify(app.get('viewFilterMemory'));
  const count = () => (html(app).match(/TV <span class="section-count">· ([^<]*)</) || [])[1];
  const before = count();
  await app.ctx.setShowStateById(L.bravo.show.id, { status: 'skipped' }); await settle();
  assert.ok(!html(app).includes(`data-item="${L.bravo.show.id}"`), 'Skipped leaves the default Status');
  assert.notStrictEqual(count(), before);
  assert.strictEqual(JSON.stringify(app.get('viewFilterMemory')), memory);
  assert.strictEqual(app.get('filterPanelOpen'), true);
});

// V3.9 (E0 covers rule presence only; sizes and overflow are measured in a browser, not here).
test('G7 V3.9: the phone rule gives the new controls (Delete…, the dialog’s buttons, the reread status’s Retry) at least 44px', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
  const m = css.match(/@media \(max-width: 700px\) \{\s*([^{}]*)\{\s*min-height: 44px;\s*\}\s*\}/g) || [];
  const sels = m.flatMap(b => b.replace(/^@media[^{]*\{/, '').split('{')[0].split(',').map(s => s.trim()));
  for (const s of ['.season-delete-link', '#effectModalBox .modal-actions .btn', '#effectModalBox .modal-actions .btn-danger', '.reread-status .btn'])
    assert.ok(sels.includes(s), `phone min-height 44px for ${s}`);
});

// ═══ G8: films read-only, no new organization caller, the note ═══════════════
test('G8: no S3 flow sends org_*; Edit collection opens Manage at the members unchanged (S4: film actions are tests/collection-films.test.js)', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  assert.ok(app.el('viewHead').innerHTML.includes('The shows and films in your True Crime / Docs collection. Changing a show or film here changes it in your library everywhere; Remove takes it out of True Crime / Docs only.'));
  assert.ok(app.el('viewHead').innerHTML.includes(`openManage('members', '${app.browseId('truecrime').split(':')[1]}', this)`));
  // S3 flows send no org_* request.
  await app.ctx.setShowStateById(L.bravo.show.id, { status: 'watching' }); await app.ctx.toggleWatch(L.alpha.rows[1].id);
  await app.ctx.setSeasonSkipped(L.lone.rows[0].id, true); await app.ctx.delRow(L.gap.rows[2].id); await settle();
  assert.ok(!app.requests.some(r => /\/rpc\/org_/.test(r.url)), 'no org_* request');
  const mark = app.requests.length;
  app.ctx.openManage('members', app.browseId('truecrime').split(':')[1], null); await settle();
  assert.ok(app.requests.slice(mark).every(r => r.method === 'GET'), 'opening Manage only reads (GET rpc/org_capabilities and its reads)');
  assert.ok(app.requests.slice(mark).some(r => r.url.endsWith('/rpc/org_capabilities')));
  app.ctx.closeManage(); await settle();
  assert.ok(app.requests.slice(mark).every(r => r.method === 'GET'), 'closing unsubmitted sends nothing');
});

// S3-D4 (owner-approved omission): no list-level "Dismiss “New” on these N" in a collection; the
// per-show Dismiss “New” (F6) stays. All TV, with the same New shows, still offers the line.
test('G8 S3-D4: a collection offers no “Dismiss “New” on these N” (All TV does); each New show keeps its own Dismiss “New”', async () => {
  const L = lib();
  L.alpha.show.catalog_new = true;
  const app = await boot(L);
  await VIEWS.alltv(app);
  assert.ok((html(app) + cards(app)).includes('dismissShownNew()'), 'All TV offers the line for two New shows');
  for (const v of ['colShows', 'colSeasons']) {
    await VIEWS[v](app);
    const all = html(app) + cards(app);
    assert.ok(!all.includes('dismissShownNew()') && !all.includes('on these'), `${v}: no list-level line`);
    if (v !== 'colShows') continue;
    expandAll(app, [L.alpha.show.id, L.bravo.show.id]);
    for (const s of [L.alpha.show, L.bravo.show]) assert.ok(html(app).includes(`dismissShowNew('${s.id}')`), `${v}: ${s.title} keeps its own Dismiss “New”`);
    assert.ok(!(html(app) + cards(app)).includes('dismissShownNew()'), `${v} expanded: still no list-level line`);
  }
});

// ═══ G9: S1 / S2 preserved with a pending TV write ═══════════════════════════
for (const [label, go] of [
  ['a collection tab', app => app.ctx.selectCollectionTab(app.browseId('disney').split(':')[1])],
  ['Back', app => app.ctx.browseBack()],
  ['Settings', app => app.ctx.openSettings(null)]
]) {
  test(`G9: ${label} while a collection’s show write is pending: the answer lands on the shared show, nothing else is sent, and the new view is as before`, async () => {
    const L = lib();
    const app = await boot(L);
    app.ctx.switchView('alltv'); await settle();
    await openTC(app);
    const g = app.hold(r => r.url.endsWith('/rpc/library_set_show_state_b45'));
    const p = app.ctx.setShowStateById(L.bravo.show.id, { status: 'watching' });
    await g.reached;
    go(app); await settle();
    g.release(); await p; await settle();
    assert.strictEqual(app.get(`tvShowsById.get(${JSON.stringify(L.bravo.show.id)}).status`), 'watching');
    assert.deepStrictEqual(writes(app).map(path), ['rpc/library_set_show_state_b45']);
    assert.strictEqual(app.consoleErrors.length, 0, app.consoleErrors.join('\n'));
  });
}
test('G9: restore stays Settings-only from a collection (D11)', async () => {
  const app = await boot();
  await openTC(app);
  let clicked = 0;
  app.el('restoreFileInput').click = () => { clicked++; };
  app.ctx.handleRestoreClick();
  assert.strictEqual(clicked, 0);
  app.ctx.openSettings(null);
  app.ctx.handleRestoreClick();
  assert.strictEqual(clicked, 1);
});

// ═══ §8.6: S3-D2 B — Watched / Skip on an unknown outcome, in every view ══════
// Entry points E1–E14: the control is checked in the view's markup, then its handler is called.
const VIEWS = {
  cw: async app => { app.ctx.switchView('watching'); await settle(); },
  alltv: async app => { app.ctx.switchView('alltv'); await settle(); app.el('fStatus').value = 'all'; app.ctx.renderTable(); },
  alltvSeasons: async app => { app.ctx.switchView('alltv'); await settle(); app.ctx.setAllTvPresentation('seasons'); app.ctx.setAllTvSeasonVis('all'); },
  comingsoon: async app => { app.ctx.switchView('comingsoon'); await settle(); },
  colShows: async app => { await openTC(app); },
  colSeasons: async app => { await openTC(app); app.ctx.setBrowsePresentation('seasons'); app.ctx.setBrowseSeasonVis('all'); }
};
const ENTRIES = [
  ['E1', 'cw', 'shortcut', 'watch'], ['E2', 'cw', 'sub-row Watched', 'watch'], ['E3', 'cw', 'sub-row Skip', 'skip'],
  ['E4', 'alltv', 'shortcut', 'watch'], ['E5', 'alltv', 'sub-row Watched', 'watch'], ['E6', 'alltv', 'sub-row Skip', 'skip'], ['E7', 'alltv', 'catalog × (delRow)', 'catskip'],
  ['E8', 'alltvSeasons', 'Watched', 'watch'], ['E9', 'alltvSeasons', 'Skip', 'skip'],
  ['E10', 'comingsoon', 'Skip', 'skip'],
  ['E11', 'colShows', 'shortcut / sub-row Watched', 'watch'], ['E12', 'colShows', 'sub-row Skip', 'skip'],
  ['E13', 'colSeasons', 'Watched', 'watch'], ['E14', 'colSeasons', 'Skip', 'skip']
];
// The row each entry acts on, and the call (after checking the control is drawn).
async function entryAct(app, L, kind, view) {
  if (kind === 'catskip') {
    const id = L.cat.rows[0].id;
    await app.ctx.delRow(id);
    return { id, field: 'skipped', fn: 'set_season_skipped' };
  }
  const id = view === 'comingsoon' ? L.alpha.rows[2].id : L.alpha.rows[1].id;
  if (['cw', 'alltv', 'colShows'].includes(view)) expandAll(app, [L.alpha.show.id]);
  if (kind === 'watch') {
    assert.ok(html(app).includes(`toggleWatch('${id}')`), `${view}: the Watched control is drawn`);
    await app.ctx.toggleWatch(id);
    return { id, field: 'watched', fn: 'set_season_watched' };
  }
  assert.ok(html(app).includes(`setSeasonSkipped('${id}', true)`), `${view}: the Skip control is drawn`);
  await app.ctx.setSeasonSkipped(id, true);
  return { id, field: 'skipped', fn: 'set_season_skipped' };
}
const rereadGets = (app, mark, view) => app.requests.slice(mark).filter(r => r.method === 'GET'
  && (view.startsWith('col') ? r.url.includes('/collection_memberships') : r.url.includes('is_film=eq.false')));
for (const [e, view, what, kind] of ENTRIES) {
  for (const mode of ['before', 'after']) {
    test(`§8.6 ${e} ${view} ${what}: lost ${mode} commit → unconfirmed, read again, never resent; the page shows what is stored; no Saved`, async () => {
      const L = await withCatalog();
      const app = await boot(L);
      await VIEWS[view](app);
      const before = snap(app);
      app.loseNext(r => r.method === 'POST' && /\/rpc\/set_season_(watched|skipped)$/.test(r.url), mode);
      const mark = app.requests.length;
      const { id, field, fn } = await entryAct(app, L, kind, view);
      await settle(); await settle();
      assert.strictEqual(rpc(app, fn).length, 1, 'exactly one request, not resent');
      assert.strictEqual(banner(app), `<div class="error-banner">⚠️ ${UNCONFIRMED}${REREAD_OK}</div>`);
      assert.ok(rereadGets(app, mark, view).length >= 1, 'the open view is read again');
      const d = diff(before, snap(app));
      const stored = !!storeRow(app, id)[field];
      if (mode === 'before') assert.deepStrictEqual(d, {}, 'nothing applied');
      else assert.deepStrictEqual(d, { watchlist_items: { added: [], removed: [], changed: { [id]: [field] } } });
      assert.strictEqual(stored, mode === 'after');
      const shown = pageRow(app, id);
      if (shown) assert.strictEqual(!!shown[field], stored, 'the page shows what is stored');
      assert.ok(!saved(app), 'no Saved');
      assert.strictEqual(writes(app).length, 1, 'no other write');
    });
  }
}
// Brief §4.2 (2): the tracked edit has ended before the reread starts (checked while the reread's
// first read is held), for each handler, in a TV view and a collection, in both loss modes.
for (const [e, view, kind] of [['E8', 'alltvSeasons', 'watch'], ['E9', 'alltvSeasons', 'skip'], ['E13', 'colSeasons', 'watch'], ['E14', 'colSeasons', 'skip']]) {
  for (const mode of ['before', 'after']) {
    test(`§8.6 ${e} ${view} ${kind}: lost ${mode} commit → the reread (inside the write lane) publishes what is stored`, async () => {
      const L = await withCatalog();
      const app = await boot(L);
      await VIEWS[view](app);
      const id = L.alpha.rows[1].id;
      app.loseNext(r => r.method === 'POST' && /\/rpc\/set_season_(watched|skipped)$/.test(r.url), mode);
      const g = app.hold(r => r.method === 'GET'
        && (view.startsWith('col') ? r.url.includes('/collection_memberships') : r.url.includes('is_film=eq.false')));
      const pr = entryAct(app, L, kind, view);
      await g.reached;
      g.release(); await pr; await settle(); await settle();
      const field = kind === 'watch' ? 'watched' : 'skipped';
      const shown = pageRow(app, id);
      assert.ok(shown && !!shown[field] === !!storeRow(app, id)[field], 'the reread published what is stored');
    });
  }
}
for (const view of ['cw', 'alltv', 'alltvSeasons', 'comingsoon', 'colShows', 'colSeasons']) {
  const kind = view === 'comingsoon' ? 'skip' : 'watch';
  test(`§8.6 U-h ${view}: an ambiguous HTTP error (no code) is an unknown outcome too`, async () => {
    const L = lib();
    const app = await boot(L);
    await VIEWS[view](app);
    app.failNext(r => /\/rpc\/set_season_(watched|skipped)$/.test(r.url));
    const { fn } = await entryAct(app, L, kind, view); await settle(); await settle();
    assert.strictEqual(rpc(app, fn).length, 1);
    assert.match(banner(app), /This change wasn’t confirmed \(simulated failure\): it may or may not have been saved, and it won’t be sent again\. The list has been read again/);
  });
  test(`§8.6 R ${view}: a database refusal is unchanged (put back, the error, no reread)`, async () => {
    const L = lib();
    const app = await boot(L);
    await VIEWS[view](app);
    app.refuseNext(r => /\/rpc\/set_season_(watched|skipped)$/.test(r.url), 'P0002', 'not_found: TV season');
    const mark = app.requests.length;
    const { id, field, fn } = await entryAct(app, L, kind, view); await settle(); await settle();
    assert.strictEqual(rpc(app, fn).length, 1);
    assert.strictEqual(!!pageRow(app, id)[field], false, 'put back');
    assert.match(banner(app), /Supabase error 400/);
    assert.strictEqual(rereadGets(app, mark, view).length, 0, 'no reread');
  });
}
for (const view of ['alltv', 'colShows']) {
  for (const mode of ['before', 'after']) {
    test(`§8.6 U-r ${view} lost ${mode}: the reread fails → "use Retry"; still one write; Retry resends nothing`, async () => {
      const L = lib();
      const app = await boot(L);
      await VIEWS[view](app);
      app.loseNext(r => r.url.endsWith('/rpc/set_season_watched'), mode);
      app.failNext(r => r.method === 'GET' && r.url.includes('/tv_shows'));
      await entryAct(app, L, 'watch', view); await settle(); await settle();
      assert.strictEqual(banner(app).includes(UNCONFIRMED + REREAD_FAIL) || banner(app).includes('Couldn'), true, banner(app));
      assert.ok(/>Retry</.test(html(app) + app.el('readStatus').innerHTML), 'Retry offered');
      if (view === 'alltv') await app.ctx.loadDerivedView(); else await app.ctx.loadBrowseView();
      await settle();
      assert.strictEqual(rpc(app, 'set_season_watched').length, 1, 'Retry only reads');
    });
  }
}
for (const [from, go, to] of [
  ['cw', app => app.ctx.switchView('alltv'), 'alltv'],
  ['alltvSeasons', app => app.ctx.switchView('comingsoon'), 'comingsoon'],
  ['colShows', app => app.ctx.selectCollectionTab(app.browseId('disney').split(':')[1]), 'disney'],
  ['alltv', app => app.ctx.openSettings(null), 'settings']
]) {
  for (const mode of ['before', 'after']) {
    test(`§8.6 N ${from} → ${to}, lost ${mode}: nothing published into the new view; it is read again (Settings: drawn, nothing read); one request`, async () => {
      const L = lib();
      const app = await boot(L);
      await VIEWS[from](app);
      const g = app.hold(r => /\/rpc\/set_season_(watched|skipped)$/.test(r.url));
      expandAll(app, [L.alpha.show.id]);
      const p = app.ctx.toggleWatch(L.alpha.rows[1].id);
      await g.reached;
      await go(app); await settle();
      const mark = app.requests.length;
      g.lose(mode); await p; await settle(); await settle();
      assert.strictEqual(rpc(app, 'set_season_watched').length, 1);
      assert.match(banner(app), /This change wasn’t confirmed/);
      const gets = app.requests.slice(mark).filter(r => r.method === 'GET' && !r.url.includes('stage5_capabilities'));
      if (to === 'settings') assert.strictEqual(gets.length, 0, 'Settings: nothing read');
      else assert.ok(gets.length > 0, 'the open view is read again');
      assert.strictEqual(!!storeRow(app, L.alpha.rows[1].id).watched, mode === 'after');
    });
  }
}
for (const mode of ['before', 'after']) {
  test(`§8.6 C0 All Movies film Watched, lost ${mode}: the existing sendFilmState path and words, unchanged`, async () => {
    const L = lib();
    const own = film({ id: 'f-m', title: 'Movie', collection: 'movies', media_type: 'movie', tmdb_id: 9100 });
    L.data.rows.push(own);
    const app = await boot(L);
    app.ctx.switchMediaType('movie'); await settle();
    app.loseNext(r => r.url.endsWith('/rpc/library_set_film_state_b45'), mode);
    await app.ctx.toggleWatch('f-m'); await settle(); await settle();
    assert.strictEqual(rpc(app, 'library_set_film_state_b45').length, 1);
    assert.match(banner(app), /This change wasn’t confirmed \(Failed to fetch\): it may or may not have been saved, and it won’t be sent again\./);
  });
}

const desc = n => (n ? `${n.tag}${Object.entries(n.attrs || {}).filter(([k]) => k.startsWith('data-') || k === 'class').map(([k, v]) => `[${k}=${v}]`).join('')}` : 'null');
const ident = node => {
  if (!node || typeof node.closest !== 'function') return String(node && node.attrs ? desc(node) : node);
  const own = Object.entries(node.attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => `${k}=${v}`).join(',');
  const up = sel => { const x = node.closest(sel); return x ? Object.entries(x.attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => `${k}=${v}`).join(',') : ''; };
  return `${node.tag}{${own}}<${up('[data-action]')}><${up('[data-season-row]')}><${up('[data-item], [data-show-of]')}>`;
};

// ═══ G6 (V3.7): the B6 chain in collections ══════════════════════════════════
test('G6 F-5 / F-4: Skip hides a season entry under All (except Skipped) → the next entry; the last one → the empty message', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.setBrowseMedia('tv'); app.ctx.setBrowsePresentation('seasons');
  const dom = makeMiniDom(app);
  dom.hide('cardList');
  const ids = [...html(app).matchAll(/<tr class="browse-season-row[^"]*" data-item="([^"]+)"/g)].map(m => m[1]);
  dom.focus('tbody', `[data-item="${ids[0]}"] [data-action="season-control"] button`);
  await app.ctx.setSeasonSkipped(ids[0], true); await settle();
  assert.strictEqual(desc(dom.active()), desc(dom.in('tbody', `[data-item="${ids[1]}"] [data-primary]`)), 'F-5: the next entry');
  app.el('fSearch').value = 'Lone'; app.ctx.renderTable();
  dom.focus('tbody', `[data-item="${L.lone.rows[0].id}"] [data-action="season-control"] button`);
  await app.ctx.setSeasonSkipped(L.lone.rows[0].id, true); await settle();
  assert.ok(dom.active() && 'data-empty' in dom.active().attrs, `F-4: ${desc(dom.active())}`);
});
test('G6 F-1: a priority change in a collection keeps focus on the priority select', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  const dom = makeMiniDom(app);
  dom.hide('cardList');
  const sel = `[data-item="${L.bravo.show.id}"] [data-action="priority"] select`;
  dom.focus('tbody', sel);
  await app.ctx.setShowStateById(L.bravo.show.id, { priority: 'high' }); await settle();
  assert.strictEqual(desc(dom.active()), desc(dom.in('tbody', sel)), 'F-1');
});
test('G6 F-2 / F-3 by an owned reread: an entry that moves into the open TBA section gets focus (F-2); into a collapsed one, its toggle (F-3)', async () => {
  for (const open of [true, false]) {
    const L = lib();
    const app = await boot(L);
    await openTC(app);
    app.ctx.setBrowseMedia('tv'); app.ctx.setBrowsePresentation('seasons');
    app.run(`browseSectionOpen.tvTba = ${open}`); app.ctx.renderTable();
    const dom = makeMiniDom(app);
    dom.hide('cardList');
    const id = L.lone.rows[0].id;
    dom.focus('tbody', `[data-item="${id}"] [data-action="season-watch"] button`);
    const g = app.hold(r => r.url.endsWith('/rpc/set_season_watched'));
    const p = app.ctx.toggleWatch(id);
    await g.reached;
    Object.assign(app.store.watchlist_items.find(r => r.id === id), { date_sort: '2099-01-01', display_date: 'TBA' }); // changed elsewhere
    g.lose('before'); await p; await settle(); await settle();
    // A TBA season has no Watched button ("Not aired yet"), so F-1 is gone: F-2, the entry's main control in TBA.
    if (open) assert.strictEqual(ident(dom.active()), ident(dom.in('tbody', `[data-item="${id}"] [data-primary]`)), 'F-2: the entry in the open TBA section');
    else assert.strictEqual(desc(dom.active()), desc(dom.in('tbody', '[data-section="tvTba"]')), 'F-3: the collapsed TBA toggle');
  }
});
test('G6 F-6 / F-7: the last entry of a section gone → its heading; filter redraws and layout toggles never use the chain', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app, '');
  app.ctx.setBrowseMedia('tv');
  app.el('fSearch').value = 'Lone'; app.ctx.renderTable();
  const dom = makeMiniDom(app);
  dom.hide('cardList');
  dom.focus('tbody', `[data-item="${L.lone.show.id}"] [data-action="status"] select`);
  await app.ctx.setShowStateById(L.lone.show.id, { status: 'skipped' }); await settle();
  const end = dom.active();
  assert.ok(end && ('data-empty' in end.attrs || 'data-section' in end.attrs), `F-4 / F-6: ${desc(end)}`);
  const outside = dom.outside();
  app.el('fSearch').value = ''; app.ctx.renderTable();
  app.ctx.setBrowsePresentation('seasons'); app.ctx.setBrowseGrouping('combined');
  assert.ok(dom.active() === outside, 'filter redraws and toggles keep focus where it is');
});
test('G6 (Batch A): reading a shown collection again keeps the list and the focused control; a failed reread keeps them and offers Retry', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  const dom = makeMiniDom(app);
  dom.hide('cardList');
  const sel = `[data-item="${L.bravo.show.id}"] [data-primary]`;
  dom.focus('tbody', sel);
  const g = app.hold(r => r.method === 'GET' && r.url.includes('/tv_shows'));
  const p = app.ctx.loadBrowseView(); await g.reached;
  assert.strictEqual(desc(dom.active()), desc(dom.in('tbody', sel)), 'the list stays while it is read');
  assert.match(app.el('readStatus').innerHTML, /Reading the list again/);
  g.release(); await p; await settle();
  assert.strictEqual(desc(dom.active()), desc(dom.in('tbody', sel)), 'the same control after the redraw');
  assert.strictEqual(app.el('readStatus').innerHTML, '');
  const g2 = app.hold(r => r.method === 'GET' && r.url.includes('/tv_shows'));
  const p2 = app.ctx.loadBrowseView(); await g2.reached;
  g2.fail(); await p2; await settle();
  assert.strictEqual(desc(dom.active()), desc(dom.in('tbody', sel)), 'a failure keeps the list and focus');
  assert.match(app.el('readStatus').innerHTML, /couldn’t be read again.*<button class="btn" onclick="loadBrowseView\(\)">Retry<\/button>/);
});

T.run();
