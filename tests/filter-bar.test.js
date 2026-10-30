// Offline tests for B10, the filter bar of every list view (render.js filterBarHtml and its
// helpers; derived-views.js and browse-views.js draw it): Search, the scope controls and More
// filters on one line; the More filters panel (closed = hidden, its controls still filter);
// the chip row (applied values, "Not applied" values the visit keeps, Clear filters); the
// panel's open / closed state; chip removal and Clear filters with their focus targets; the
// empty-state Clear; the count line below the filters; the cache token. Filtering itself is
// unchanged (tests/filter-pills.test.js and the view suites). Nothing here makes a request
// other than the views' own reads.
// Run from the repo root: node tests/filter-bar.test.js
// No network, no database (see tests/app-harness.js). The harness's DOM has no layout, focus or
// attributes: focus and attribute calls are recorded by a small spy (spyDom), not performed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('filter-bar');
const test = T.test;
const DISNEY = 'browse:0c000000-0000-4000-8000-000000000001';

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
// A show and its seasons. Season specs: { w (watched), s (skipped), date }.
function show(o, specs) {
  const s = { id: nid('show'), collection: 'othertv', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: null, status: 'confirmed', ...o };
  const rows = specs.map((sp, i) => ({
    id: nid('r'), collection: s.collection, title: s.title, theme: 'HBO', status: 'confirmed',
    watched: !!sp.w, skipped: !!sp.s, show_id: s.id, media_type: null, tmdb_id: null, season_number: i + 1,
    season: `Season ${i + 1}`, display_date: sp.date || day(-100 + i), date_sort: sp.date || day(-100 + i),
    item_key: `${s.show_key}|season ${i + 1}`, watch_with: [], collections: []
  }));
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'movies', title: 'Film', theme: 'Drama', status: 'confirmed', watched: false,
  media_type: 'movie', tmdb_id: 900 + n, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) });

function library() {
  return all(
    show({ title: 'Alpha', collection: 'disney', status: 'watching', genres: ['Drama'], network: 'HBO', franchises: ['Saga'], companies: ['Co One'] },
      [{ w: true }, { date: day(-5) }]),
    show({ title: 'Bravo', collection: 'disney', priority: 'high', catalog_new: true, genres: ['Comedy'], network: 'Netflix' }, [{ date: day(-30) }]),
    show({ title: 'Charlie', status: 'skipped', genres: ['Drama'] }, [{ date: day(-40) }]),
    show({ title: 'Delta', status: 'watching', genres: ['Drama'] }, [{ w: true, date: day(-200) }, { date: day(20) }]),
    film({ id: 'f-a', title: 'Film A', collection: 'disney', media_type: null, tmdb_id: null, genres: ['Drama'], collections: ['Saga Collection'], watch_with: ['Rina'] }),
    film({ id: 'f-b', title: 'Film B', watched: true, genres: ['Comedy'] }),
    film({ id: 'f-c', title: 'Film C', status: 'skipped', genres: ['Drama'] })
  );
}
const boot = (data = library(), opts = {}) => createApp({ rows: data.rows, tvShows: data.shows, ...opts });
const fb = app => app.el('filtersRow').innerHTML;
const chipsHtml = app => (app.el('filterChips') ? app.el('filterChips').innerHTML : '');
const chipKeys = app => [...chipsHtml(app).matchAll(/id="chip-(\w+)"/g)].map(m => m[1]);
// The chip groups as [label, keys]: "Active filters" and "Kept, not applied".
const groups = app => [...chipsHtml(app).matchAll(/<div class="chip-group" role="group" aria-label="([^"]+)">([\s\S]*?)<\/div>/g)]
  .map(m => [m[1], [...m[2].matchAll(/id="chip-(\w+)"/g)].map(x => x[1])]);
const chipName = (app, key) => (chipsHtml(app).match(new RegExp(`id="chip-${key}"[^>]*aria-label="([^"]*)"`)) || [])[1];
const countLine = app => (app.el('statsRow').innerHTML.match(/<p class="count-line">([^<]*)<\/p>/) || [])[1] || '';
const titles = app => [...app.el('tbody').innerHTML.matchAll(/<span class="show-title">([^<]*)<\/span>/g)].map(m => m[1]);
const setFilter = (app, id, value) => { app.el(id).value = value; app.ctx.renderTable(); };
const check = (app, id, on) => { app.el(id).checked = on; app.ctx.renderTable(); };
const badge = app => [app.el('filterMoreCount').textContent, app.el('filterMoreCount').hidden, app.el('filterMoreA11y').textContent];
const panelHidden = app => /id="filterMore"[^>]* hidden>/.test(fb(app));
const isOpen = app => app.get('filterPanelOpen');
const readsOnly = app => app.requests.every(r => r.method === 'GET');
// Ids in the visible line (between the line's start and the panel) and in the panel.
const ids = s => [...s.matchAll(/ id="(f[A-Z]\w*|filterMoreBtn)"/g)].map(m => m[1]);
const lineIds = app => { const f = fb(app); return ids(f.slice(f.indexOf('class="filter-line"'), f.indexOf('id="filterMore"'))); };
const panelIds = app => { const f = fb(app); return ids(f.slice(f.indexOf('id="filterMore"'), f.indexOf('id="filterChips"'))); };
// Records focus() and setAttribute() on the page's elements (the harness's DOM has neither).
function spyDom(app) {
  const doc = app.ctx.document, orig = doc.getElementById, log = [];
  doc.getElementById = id => {
    const e = orig(id);
    if (e && !e.__spied) {
      e.__spied = true;
      e.attrs = {};
      e.focus = () => log.push(id);
      e.setSelectionRange = () => {};
      e.setAttribute = (a, v) => { e.attrs[a] = v; };
      e.removeAttribute = a => { delete e.attrs[a]; };
    }
    return e;
  };
  return log;
}
async function allTv(app, mode = 'shows') {
  app.ctx.switchView('alltv'); await settle();
  if (mode === 'seasons') app.ctx.setAllTvPresentation('seasons');
}
async function movies(app) { app.ctx.switchMediaType('movie'); await settle(); }
async function collection(app) { app.ctx.openBrowseCollection(DISNEY); await settle(); }

// ─── §5: the visible line and the panel, per view and mode ─────────────────────
test('§5: each view and mode has Search, its scope controls and More filters on the line; every other control is in the panel, labelled and grouped', async () => {
  const app = await boot();
  const panelCats = ['fGenre', 'fForm', 'fFranchise', 'fNetwork', 'fCompany'];
  // Currently Watching (Alpha and Delta are Watching: both have a franchise / network / company only on Alpha)
  assert.deepStrictEqual(lineIds(app), ['fSearch', 'filterMoreBtn'], 'Currently Watching');
  assert.deepStrictEqual(panelIds(app), [...panelCats, 'fPriority', 'fNew', 'fReview', 'fTheme']);
  await allTv(app);
  assert.deepStrictEqual(lineIds(app), ['fSearch', 'fStatus', 'filterMoreBtn'], 'All TV Shows');
  assert.deepStrictEqual(panelIds(app), [...panelCats, 'fPriority', 'fNew', 'fReview', 'fYear', 'fProgress', 'fTheme']);
  app.ctx.setAllTvPresentation('seasons');
  assert.deepStrictEqual(lineIds(app), ['fSearch', 'fStatus', 'fSeasonVis', 'filterMoreBtn'], 'All TV Seasons');
  assert.deepStrictEqual(panelIds(app), [...panelCats, 'fPriority', 'fNew', 'fReview', 'fYear', 'fTheme'], 'no Progress control in Seasons');
  app.ctx.switchView('comingsoon'); await settle();
  assert.deepStrictEqual(lineIds(app), ['fSearch', 'filterMoreBtn'], 'Coming Soon');
  assert.ok(panelIds(app).includes('fGenre') && panelIds(app).includes('fTheme') && !panelIds(app).includes('fStatus'));
  await movies(app);
  assert.deepStrictEqual(lineIds(app), ['fSearch', 'fStatus', 'fWatch', 'filterMoreBtn'], 'All Movies');
  assert.deepStrictEqual(panelIds(app), ['fGenre', 'fForm', 'fPriority', 'fNew', 'fReview', 'fWatchWith', 'fYear', 'fCollection', 'fTheme'], 'no Network for films');
  await collection(app);
  assert.deepStrictEqual(lineIds(app), ['fSearch', 'fStatus', 'filterMoreBtn'], 'collection Shows');
  assert.deepStrictEqual(panelIds(app), [...panelCats, 'fPriority', 'fNew', 'fReview', 'fWatchWith', 'fCollection', 'fTheme']);
  app.ctx.setBrowsePresentation('seasons');
  assert.deepStrictEqual(lineIds(app), ['fSearch', 'fStatus', 'fSeasonVis', 'filterMoreBtn'], 'collection Seasons');
  app.ctx.setBrowseMedia('tv');
  assert.ok(!panelIds(app).includes('fCollection') && !panelIds(app).includes('fWatchWith'), 'TV only: no film filters (unchanged rule)');
  // Grouping and visible labels
  const f = fb(app);
  assert.ok(f.indexOf('aria-label="Categories"') < f.indexOf('aria-label="Your marks"') && f.indexOf('aria-label="Your marks"') < f.indexOf('aria-label="More"'));
  for (const [id, label] of [['fGenre', 'Genre'], ['fNetwork', 'Original network / service'], ['fPriority', 'Priority'], ['fTheme', 'Original label']]) {
    assert.ok(f.includes(`<label class="filter-field-label" for="${id}">${label}</label>`), `${id} has a visible label`);
  }
  assert.ok(/<label class="filter-check"><input type="checkbox" id="fNew"/.test(f), 'markers keep their own labels');
  assert.ok(readsOnly(app));
});

test('§5: layout controls come before the filter line and + Add after More filters, outside the panel; the old collapse toggle is gone', async () => {
  const app = await boot();
  await allTv(app);
  let f = fb(app);
  assert.ok(f.indexOf('view-toggle') < f.indexOf('class="filter-line"') && f.indexOf('id="filterMoreBtn"') < f.indexOf('add-open-btn') && f.indexOf('add-open-btn') < f.indexOf('id="filterMore"'));
  await collection(app);
  f = fb(app);
  for (const s of ['data-media="all"', 'data-presentation="shows"', 'data-grouping="separate"']) assert.ok(f.indexOf(s) < f.indexOf('class="filter-line"'), s);
  assert.ok(!/filterToggleBtn|filters-inner|Search &amp; Filter|class="filter-label"/.test(f), 'no collapse toggle, no "Filter:" label');
  assert.ok(!app.el('filtersRow').classList.contains('collapsed'));
  assert.strictEqual(typeof app.ctx.toggleFilters, 'undefined', 'the collapse handler is retired');
});

// ─── §4.8.1 and D6: DOM order ─────────────────────────────────────────────────
test('§4.8.1: DOM order is Search → scope → More filters → panel → applied chips → "Not applied" chips → Clear; the count line follows the filters (D6)', async () => {
  const app = await boot();
  await allTv(app);
  setFilter(app, 'fProgress', 'unwatched');
  app.ctx.setAllTvPresentation('seasons');   // Progress is now kept, not applied
  setFilter(app, 'fStatus', 'all'); setFilter(app, 'fGenre', 'Drama');
  const f = fb(app);
  const at = s => f.indexOf(s);
  assert.ok(at('id="fSearch"') < at('id="fStatus"') && at('id="fStatus"') < at('id="fSeasonVis"') && at('id="fSeasonVis"') < at('id="filterMoreBtn"')
    && at('id="filterMoreBtn"') < at('id="filterMore"') && at('id="filterMore"') < at('id="filterChips"'));
  const c = chipsHtml(app);
  assert.ok(c.indexOf('aria-label="Active filters"') < c.indexOf('aria-label="Kept, not applied"') && c.indexOf('aria-label="Kept, not applied"') < c.indexOf('id="filterClear"'));
  assert.deepStrictEqual(chipKeys(app), ['fStatus', 'fGenre', 'fProgress'], 'chip order: scope, panel order, then kept');
  const page = fs.readFileSync(path.join(__dirname, '..', 'watchlist.html'), 'utf8');
  assert.ok(page.indexOf('id="viewHead"') < page.indexOf('id="filtersRow"') && page.indexOf('id="filtersRow"') < page.indexOf('id="statsRow"')
    && page.indexOf('id="statsRow"') < page.indexOf('id="tmdbPanel"') && page.indexOf('id="statsRow"') < page.indexOf('id="desktopTable"'), 'viewHead → filters → count → panels → list');
});

// ─── §4.3: applied chips and the More filters count ───────────────────────────
test('§4.3: every non-default value has one chip ("Kind: value", full-text name); Search has none; the count is the panel\'s applied controls', async () => {
  const app = await boot();
  await allTv(app);
  assert.strictEqual(chipsHtml(app), '', 'starting values: no chips, no Clear');
  assert.deepStrictEqual(badge(app), ['', true, '']);
  setFilter(app, 'fSearch', 'a');
  assert.deepStrictEqual(chipKeys(app), [], 'no Search chip (D13)');
  assert.ok(chipsHtml(app).includes('id="filterClear"'), 'Clear for Search alone');
  setFilter(app, 'fStatus', 'all'); setFilter(app, 'fPriority', 'high'); check(app, 'fNew', true); setFilter(app, 'fGenre', 'Drama');
  assert.deepStrictEqual(groups(app), [['Active filters', ['fStatus', 'fGenre', 'fPriority', 'fNew']]]);
  assert.strictEqual(chipName(app, 'fStatus'), 'Remove filter: Status, All statuses');
  assert.strictEqual(chipName(app, 'fPriority'), 'Remove filter: Priority, ★ High');
  assert.strictEqual(chipName(app, 'fNew'), 'Remove filter: New from catalog');
  assert.ok(chipsHtml(app).includes('<span class="chip-k">Genre:</span> <span class="chip-v">Drama</span>'));
  assert.ok(!chipsHtml(app).includes('Not applied'), 'no applied chip says Not applied');
  assert.deepStrictEqual(badge(app), ['3', false, ', 3 active'], 'Genre, Priority, New (Status is on the line)');
  assert.ok(app.el('fGenre').classList.contains('filter-set') && app.el('fStatus').classList.contains('filter-set') && !app.el('fYear').classList.contains('filter-set'));
  assert.ok(readsOnly(app));
});

test('§4.3: value texts follow the controls (unresolved genre, watch-with label, Watched, collection Status and TV seasons)', async () => {
  const app = await boot();
  await movies(app);
  setFilter(app, 'fWatch', ''); setFilter(app, 'fWatchWith', 'Rina'); setFilter(app, 'fStatus', 'to_watch'); setFilter(app, 'fGenre', 'cand:Sci-Fi & Fantasy');
  assert.strictEqual(chipName(app, 'fWatch'), 'Remove filter: Watched, Any watched state');
  assert.strictEqual(chipName(app, 'fWatchWith'), 'Remove filter: Watch with, Rina');
  assert.strictEqual(chipName(app, 'fStatus'), 'Remove filter: Status, To Watch');
  assert.strictEqual(chipName(app, 'fGenre'), 'Remove filter: Genre, Sci-Fi &amp; Fantasy (unresolved)');
  await collection(app);
  app.ctx.setBrowsePresentation('seasons'); app.ctx.setBrowseSeasonVis('towatch');
  assert.strictEqual(chipName(app, 'seasons'), 'Remove filter: TV seasons, To watch');
});

// ─── §4.3.1: "Not applied" ────────────────────────────────────────────────────
test('§4.3.1: Progress kept in Seasons is "Not applied (Shows only)": own group, name, no badge, no Active label, count line and list unchanged', async () => {
  const app = await boot();
  await allTv(app);
  setFilter(app, 'fProgress', 'unwatched');
  assert.deepStrictEqual(groups(app), [['Active filters', ['fProgress']]], 'applied in Shows');
  app.ctx.setAllTvPresentation('seasons');
  const withKept = [countLine(app), app.el('tbody').innerHTML];
  assert.deepStrictEqual(groups(app), [['Kept, not applied', ['fProgress']]]);
  assert.ok(!chipsHtml(app).includes('Active:'), 'no "Active" label when only kept values exist');
  assert.strictEqual(chipName(app, 'fProgress'), 'Not applied: Progress, Has unwatched seasons. Applies in Shows only. Remove.');
  assert.ok(chipsHtml(app).includes('<span class="chip-na">Not applied (Shows only)</span>') && chipsHtml(app).includes('filter-chip filter-chip-kept'));
  assert.deepStrictEqual(badge(app), ['', true, ''], 'never counted');
  app.ctx.removeFilterChip('fProgress');
  assert.deepStrictEqual([countLine(app), app.el('tbody').innerHTML], withKept, 'the kept value never changed the list or the count');
});

test('§4.3.1: the Seasons choice kept in Shows and a collection\'s TV seasons in Shows or Movies only are "Not applied (Seasons only)"', async () => {
  const app = await boot();
  await allTv(app, 'seasons');
  app.ctx.setAllTvSeasonVis('watched');
  assert.deepStrictEqual(groups(app), [['Active filters', ['seasons']]]);
  app.ctx.setAllTvPresentation('shows');
  assert.deepStrictEqual(groups(app), [['Kept, not applied', ['seasons']]]);
  assert.strictEqual(chipName(app, 'seasons'), 'Not applied: Seasons, Watched. Applies in Seasons only. Remove.');
  setFilter(app, 'fGenre', 'Drama');
  assert.deepStrictEqual(groups(app), [['Active filters', ['fGenre']], ['Kept, not applied', ['seasons']]]);
  assert.deepStrictEqual(badge(app), ['1', false, ', 1 active'], 'only Genre counts');
  await collection(app);
  app.ctx.setBrowsePresentation('seasons'); app.ctx.setBrowseSeasonVis('skipped');
  assert.deepStrictEqual(groups(app), [['Active filters', ['seasons']]]);
  app.ctx.setBrowsePresentation('shows');
  assert.deepStrictEqual(groups(app), [['Kept, not applied', ['seasons']]]);
  app.ctx.setBrowsePresentation('seasons'); app.ctx.setBrowseMedia('movie');
  assert.deepStrictEqual(groups(app), [['Kept, not applied', ['seasons']]], 'Movies only lists no seasons');
});

test('§4.3.1: a collection\'s Collection tag / Watch with kept while media is TV are "Not applied (while films are shown)"', async () => {
  const app = await boot();
  await collection(app);
  setFilter(app, 'fWatchWith', 'Rina');
  assert.deepStrictEqual(groups(app), [['Active filters', ['fWatchWith']]]);
  app.ctx.setBrowseMedia('tv');
  assert.deepStrictEqual(groups(app), [['Kept, not applied', ['fWatchWith']]]);
  assert.strictEqual(chipName(app, 'fWatchWith'), 'Not applied: Watch with, Rina. Applies while films are shown. Remove.');
  app.ctx.setBrowseMedia('all');
  assert.deepStrictEqual(groups(app), [['Active filters', ['fWatchWith']]], 'applies again when films are shown (unchanged memory rule)');
});

test('owner limitation: an applied filter with zero results stays applied; a control in the closed panel stays applied; a kept value for a control that is shown is never "Not applied"', async () => {
  const app = await boot();
  await allTv(app);
  setFilter(app, 'fGenre', 'Western');                         // no show has it
  assert.deepStrictEqual(titles(app), []);
  assert.deepStrictEqual(groups(app), [['Active filters', ['fGenre']]], 'zero results: applied, not "Not applied"');
  assert.ok(panelHidden(app) && !isOpen(app));
  setFilter(app, 'fGenre', '');
  // The visit's memory keeps a value the shown select doesn't hold (as when a choice isn't offered):
  // the shown control decides (it filters by its own value), so there is no chip at all.
  app.get("viewFilterMemory.values.fGenre = 'Nonexistent'");
  app.ctx.renderTable();
  assert.deepStrictEqual(chipKeys(app), []);
  // A kept value whose control isn't drawn at all doesn't filter: "Not applied (not offered in this list)".
  app.ctx.switchView('watching'); await settle();
  app.get("viewFilterMemory.values.fYear = '2020'");          // Currently Watching draws no Year control
  app.ctx.renderTable();
  assert.deepStrictEqual(groups(app), [['Kept, not applied', ['fYear']]]);
  assert.strictEqual(chipName(app, 'fYear'), 'Not applied: Year, 2020. Not offered in this list. Remove.');
});

// ─── chip removal ─────────────────────────────────────────────────────────────
test('§4.3 / AC5: a chip\'s removal sets that value to its starting value (Watched → Unwatched only), redraws once, sends nothing; focus next → previous → Search', async () => {
  const app = await boot();
  await movies(app);
  const focused = spyDom(app);
  setFilter(app, 'fWatch', 'watched'); setFilter(app, 'fGenre', 'Comedy'); setFilter(app, 'fPriority', 'normal');
  assert.deepStrictEqual(chipKeys(app), ['fWatch', 'fGenre', 'fPriority']);
  const before = app.requests.length;
  let draws = 0;
  const real = app.ctx.renderTable;
  app.ctx.renderTable = () => { draws++; real(); };
  app.ctx.removeFilterChip('fWatch');
  assert.strictEqual(draws, 1, 'one redraw');
  assert.strictEqual(app.el('fWatch').value, 'unwatched', 'back to Unwatched only');
  assert.deepStrictEqual(focused.splice(0), ['chip-fGenre'], 'next chip');
  app.ctx.removeFilterChip('fPriority');
  assert.deepStrictEqual(focused.splice(0), ['chip-fGenre'], 'previous chip (it was the last)');
  app.ctx.removeFilterChip('fGenre');
  assert.deepStrictEqual(focused.splice(0), ['fSearch'], 'Search when no chip is left');
  assert.deepStrictEqual(chipKeys(app), []);
  assert.strictEqual(app.requests.length, before, 'no request');
  app.ctx.renderTable = real;
});

test('removing a "Not applied" chip resets only the kept value; without removal it re-applies on Shows (memory unchanged)', async () => {
  const app = await boot();
  await allTv(app);
  setFilter(app, 'fProgress', 'allwatched');
  app.ctx.setAllTvPresentation('seasons');
  app.ctx.setAllTvPresentation('shows');
  assert.strictEqual(app.el('fProgress').value, 'allwatched', 're-applied on Shows (existing memory)');
  app.ctx.setAllTvPresentation('seasons');
  const list = app.el('tbody').innerHTML;
  app.ctx.removeFilterChip('fProgress');
  assert.strictEqual(app.el('tbody').innerHTML, list, 'the list is unchanged');
  assert.strictEqual(app.get('viewFilterMemory.values.fProgress'), '');
  app.ctx.setAllTvPresentation('shows');
  assert.strictEqual(app.el('fProgress').value, '', 'not re-applied after removal');
});

// ─── §4.4 Clear filters ───────────────────────────────────────────────────────
test('§4.4 / AC6: Clear filters returns every filter to its starting value (Unwatched only, kept values), keeps layout and the panel, focuses Search, sends nothing', async () => {
  const app = await boot();
  await movies(app);
  const focused = spyDom(app);
  app.ctx.toggleFilterPanel(true);
  setFilter(app, 'fSearch', 'film'); setFilter(app, 'fStatus', 'all'); setFilter(app, 'fWatch', ''); setFilter(app, 'fGenre', 'Drama');
  check(app, 'fReview', true); setFilter(app, 'fCollection', 'Saga Collection'); setFilter(app, 'fWatchWith', 'Rina'); setFilter(app, 'fTheme', 'Drama');
  const before = app.requests.length;
  app.ctx.clearViewFilters();
  assert.deepStrictEqual(['fSearch', 'fStatus', 'fWatch', 'fGenre', 'fCollection', 'fWatchWith', 'fTheme'].map(id => app.el(id).value), ['', '', 'unwatched', '', '', '', '']);
  assert.strictEqual(app.el('fReview').checked, false);
  assert.strictEqual(chipsHtml(app), '', 'no chips and no Clear');
  assert.ok(isOpen(app), 'the panel stays open');
  assert.strictEqual(focused[focused.length - 1], 'fSearch');
  assert.strictEqual(countLine(app), '1 of 3 films · library: 1 watched, 2 unwatched', 'the starting list');
  assert.strictEqual(app.requests.length, before);
});

test('§4.4: Clear in All TV Seasons and a collection resets the seasons choices and kept values; Shows / Seasons, media, grouping and expansion are unchanged', async () => {
  const app = await boot();
  await allTv(app);
  setFilter(app, 'fProgress', 'unwatched');
  app.ctx.setAllTvPresentation('seasons'); app.ctx.setAllTvSeasonVis('watched');
  app.ctx.clearViewFilters();
  assert.strictEqual(app.get('allTvSeasonVis'), 'notskipped');
  assert.strictEqual(app.el('fSeasonVis').value, 'notskipped');
  assert.strictEqual(app.get('allTvPresentation'), 'seasons', 'layout unchanged');
  assert.strictEqual(app.get('viewFilterMemory.values.fProgress'), '', 'kept value cleared');
  app.ctx.setAllTvPresentation('shows');
  assert.strictEqual(app.el('fProgress').value, '');
  await collection(app);
  app.ctx.setBrowsePresentation('seasons'); app.ctx.setBrowseGrouping('combined'); app.ctx.setBrowseSeasonVis('towatch');
  setFilter(app, 'fWatchWith', 'Rina'); app.ctx.setBrowseMedia('tv');
  const key = app.get('[...tvShowsById.keys()][0]');
  app.ctx.toggleBrowseShow(key);
  app.ctx.clearViewFilters();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(app.get('[browseMedia, browsePresentation, browseGrouping, browseSeasonVis]'))), ['tv', 'seasons', 'combined', 'notskipped']);
  assert.ok(app.get(`expandedShows.has(${JSON.stringify(key)})`), 'expansion unchanged');
  assert.deepStrictEqual(chipKeys(app), []);
  assert.ok(readsOnly(app));
});

test('§4.4: Clear is shown only while something is non-default: Search alone, a kept value alone; never with the starting filters', async () => {
  const app = await boot();
  await allTv(app);
  assert.ok(!chipsHtml(app).includes('filterClear'));
  setFilter(app, 'fSearch', 'x');
  assert.ok(chipsHtml(app).includes('filterClear'));
  setFilter(app, 'fSearch', '');
  assert.ok(!chipsHtml(app).includes('filterClear'));
  setFilter(app, 'fProgress', 'unwatched'); app.ctx.setAllTvPresentation('seasons');
  assert.ok(chipsHtml(app).includes('filterClear'), 'a kept value alone');
});

// ─── D7: Clear in "no matches" ────────────────────────────────────────────────
test('D7: "no matches" empty states carry Clear while it applies; an empty library or the starting filters alone don\'t', async () => {
  const app = await boot();
  setFilter(app, 'fSearch', 'zzz');
  assert.ok(/No in-progress shows match your filters\. <button type="button" class="btn empty-clear" onclick="clearViewFilters\(\)">Clear filters<\/button>/.test(app.el('tbody').innerHTML), 'Currently Watching');
  await allTv(app); setFilter(app, 'fSearch', 'zzz');
  assert.ok(app.el('tbody').innerHTML.includes('No shows match your filters. <button type="button" class="btn empty-clear"'), 'All TV');
  app.ctx.setAllTvPresentation('seasons');
  assert.ok(app.el('tbody').innerHTML.includes('match your filters. <button type="button" class="btn empty-clear"'), 'All TV Seasons');
  app.ctx.switchView('comingsoon'); await settle(); setFilter(app, 'fSearch', 'zzz');
  assert.ok(app.el('tbody').innerHTML.includes('No dated entries match your filters. <button'), 'Coming Soon');
  await movies(app); setFilter(app, 'fSearch', 'zzz');
  assert.ok(app.el('tbody').innerHTML.includes('No films match these filters. <button'), 'All Movies');
  await collection(app); setFilter(app, 'fSearch', 'zzz');
  assert.ok(app.el('tbody').innerHTML.includes('No TV shows match these filters. <button') && app.el('tbody').innerHTML.includes('No films match these filters. <button'), 'collection');
  // Clear inside the list focuses Search
  const focused = spyDom(app);
  app.ctx.clearViewFilters();
  assert.strictEqual(focused[focused.length - 1], 'fSearch');
  assert.ok(!app.el('tbody').innerHTML.includes('empty-clear'));
  // The starting filters alone (every show Skipped, hidden by Status): no Clear.
  const only = await boot(all(show({ title: 'Gone', status: 'skipped' }, [{}])));
  await allTv(only);
  assert.ok(only.el('tbody').innerHTML.includes('No shows match your filters.') && !only.el('tbody').innerHTML.includes('empty-clear'));
  const empty = await boot(all());
  await allTv(empty);
  assert.ok(empty.el('tbody').innerHTML.includes('No TV shows on your list yet.') && !empty.el('tbody').innerHTML.includes('empty-clear'));
});

// ─── §4.2.1 panel state ───────────────────────────────────────────────────────
test('§4.2.1: the panel starts closed; the toggle opens and closes it (hidden, aria-expanded, chevron) and leaves focus on itself', async () => {
  const app = await boot();
  const focused = spyDom(app);
  assert.ok(panelHidden(app) && fb(app).includes('aria-expanded="false" aria-controls="filterMore"'));
  app.ctx.toggleFilterPanel();
  assert.ok(isOpen(app) && app.el('filterMore').hidden === false && app.el('filterMoreBtn').attrs['aria-expanded'] === 'true' && app.el('filterMoreChevron').textContent === '▴');
  app.ctx.toggleFilterPanel();
  assert.ok(!isOpen(app) && app.el('filterMore').hidden === true && app.el('filterMoreBtn').attrs['aria-expanded'] === 'false' && app.el('filterMoreChevron').textContent === '▾');
  assert.deepStrictEqual(focused, [], 'the toggle moves no focus');
  app.ctx.toggleFilterPanel();
  app.ctx.renderFilters();
  assert.ok(!panelHidden(app) && fb(app).includes('aria-expanded="true"'), 'a redraw draws it open');
});

test('§4.2.1: Escape inside the open panel closes it and focuses More filters; other keys and a closed panel do nothing', async () => {
  const app = await boot();
  const focused = spyDom(app);
  let prevented = 0;
  const key = k => ({ key: k, preventDefault() { prevented++; } });
  app.ctx.filterPanelKeydown(key('Escape'));
  assert.deepStrictEqual([focused.length, prevented], [0, 0], 'closed: nothing');
  app.ctx.toggleFilterPanel(true);
  app.ctx.filterPanelKeydown(key('Enter'));
  assert.ok(isOpen(app));
  app.ctx.filterPanelKeydown(key('Escape'));
  assert.ok(!isOpen(app) && app.el('filterMore').hidden === true);
  assert.deepStrictEqual(focused, ['filterMoreBtn']);
  assert.ok(fb(app).includes('onkeydown="filterPanelKeydown(event)"'));
});

test('§4.2.1: kept for filter changes, Search, chips, Clear, pills, Shows ↔ Seasons, reload, a failed read and Retry', async () => {
  const app = await boot();
  await allTv(app);
  app.ctx.toggleFilterPanel(true);
  setFilter(app, 'fGenre', 'Drama'); setFilter(app, 'fSearch', 'a');
  app.ctx.removeFilterChip('fGenre');
  app.ctx.clearViewFilters();
  app.ctx.toggleFilterPill({ dataset: { filterKind: 'genres', filterValue: 'Drama', pillOwner: '' } });
  assert.ok(isOpen(app), 'filters, chips, Clear, pill');
  app.ctx.setAllTvPresentation('seasons');
  assert.ok(isOpen(app) && !panelHidden(app), 'Shows → Seasons');
  app.ctx.setAllTvPresentation('shows');
  assert.ok(isOpen(app) && !panelHidden(app), 'Seasons → Shows');
  app.ctx.loadDerivedView(); await settle();
  assert.ok(isOpen(app) && !panelHidden(app), 'reload');
  app.failNext(r => r.method === 'GET' && r.url.includes('/tv_shows'));
  app.ctx.loadDerivedView(); await settle();
  assert.ok(isOpen(app) && !panelHidden(app), 'a failed reread keeps the shown list and its filter row (Batch A)');
  app.ctx.loadDerivedView(); await settle();
  assert.ok(isOpen(app) && !panelHidden(app), 'Retry draws it open again');
  assert.strictEqual(app.el('fGenre').value, 'Drama', 'the pill value kept through reload and Retry');
});

test('§4.2.1: kept for a collection\'s media, presentation and grouping changes and its reload', async () => {
  const app = await boot();
  await collection(app);
  app.ctx.toggleFilterPanel(true);
  for (const step of [() => app.ctx.setBrowseMedia('tv'), () => app.ctx.setBrowsePresentation('seasons'), () => app.ctx.setBrowseMedia('all'),
    () => app.ctx.setBrowseGrouping('combined'), () => app.ctx.setBrowseMedia('movie')]) {
    step();
    assert.ok(isOpen(app) && !panelHidden(app));
  }
  app.ctx.loadBrowseView(); await settle();
  assert.ok(isOpen(app) && !panelHidden(app), 'reload');
});

test('§4.2.1: closed by TV ↔ Movies, another tab, re-entering a tab, entering a collection (from a view or another collection) and Back (values still restored)', async () => {
  const app = await boot();
  const open = () => { app.ctx.toggleFilterPanel(true); assert.ok(isOpen(app)); };
  await allTv(app); open();
  await movies(app);
  assert.ok(!isOpen(app) && panelHidden(app), 'TV → Movies');
  open();
  app.ctx.switchMediaType('tv'); await settle();
  assert.ok(!isOpen(app) && panelHidden(app), 'Movies → TV');
  open();
  app.ctx.switchView('comingsoon'); await settle();
  assert.ok(!isOpen(app) && panelHidden(app), 'another tab');
  open();
  app.ctx.switchView('comingsoon'); await settle();
  assert.ok(!isOpen(app), 're-entering the same tab is a fresh entry');
  await allTv(app);
  setFilter(app, 'fGenre', 'Drama'); setFilter(app, 'fPriority', 'high'); open();
  await collection(app);
  assert.ok(!isOpen(app) && panelHidden(app), 'entering a collection');
  open();
  app.ctx.openBrowseCollection('browse:0c000000-0000-4000-8000-000000000002'); await settle();
  assert.ok(!isOpen(app) && panelHidden(app), 'one collection to another');
  open();
  app.ctx.browseBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'alltv');
  assert.ok(!isOpen(app) && panelHidden(app), 'Back closes it');
  assert.deepStrictEqual([app.el('fGenre').value, app.el('fPriority').value], ['Drama', 'high'], 'Back restores the values');
  assert.deepStrictEqual(chipKeys(app), ['fGenre', 'fPriority'], 'and their chips');
  assert.ok(readsOnly(app));
});

// ─── memory, pills (D5) ───────────────────────────────────────────────────────
test('with the panel closed, its values are kept through redraw, reload, Retry and Back, and still filter', async () => {
  const app = await boot();
  await allTv(app);
  setFilter(app, 'fGenre', 'Comedy'); check(app, 'fNew', true);
  assert.ok(panelHidden(app));
  assert.deepStrictEqual(titles(app), ['Bravo']);
  app.ctx.renderFilters(); app.ctx.renderTable();
  app.ctx.loadDerivedView(); await settle();
  app.failNext(r => r.method === 'GET' && r.url.includes('/tv_shows'));
  app.ctx.loadDerivedView(); await settle();
  app.ctx.loadDerivedView(); await settle();
  await collection(app); app.ctx.browseBack(); await settle();
  assert.deepStrictEqual([app.el('fGenre').value, app.el('fNew').checked], ['Comedy', true]);
  assert.deepStrictEqual(titles(app), ['Bravo']);
  assert.deepStrictEqual(chipKeys(app), ['fGenre', 'fNew']);
});

test('D5: a pill with the panel closed sets its filter and chip but never opens the panel', async () => {
  const app = await boot();
  await allTv(app);
  app.ctx.toggleFilterPill({ dataset: { filterKind: 'network', filterValue: 'HBO', pillOwner: '' } });
  assert.strictEqual(app.el('fNetwork').value, 'HBO');
  assert.ok(!isOpen(app) && panelHidden(app));
  assert.deepStrictEqual(chipKeys(app), ['fNetwork']);
  assert.deepStrictEqual(titles(app), ['Alpha']);
  app.ctx.toggleFilterPill({ dataset: { filterKind: 'network', filterValue: 'HBO', pillOwner: '' } });
  assert.deepStrictEqual(chipKeys(app), []);
  assert.ok(!/filterToggleChevron|collapsed/.test(fs.readFileSync(path.join(__dirname, '..', 'render.js'), 'utf8').match(/function toggleFilterSelect[\s\S]*?\n}/)[0]));
});

// ─── counts (AC8) ─────────────────────────────────────────────────────────────
test('AC8: count lines keep their B8 wording with the bar, chips and panel', async () => {
  const app = await boot();
  await allTv(app);
  assert.strictEqual(countLine(app), '3 of 4 shows · 2 Watching · 1 up to date');
  setFilter(app, 'fGenre', 'Drama');
  assert.strictEqual(countLine(app), '2 of 4 shows · 2 Watching · 1 up to date');
  app.ctx.toggleFilterPanel(true);
  assert.strictEqual(countLine(app), '2 of 4 shows · 2 Watching · 1 up to date', 'opening the panel changes nothing');
  await movies(app);
  assert.strictEqual(countLine(app), '1 of 3 films · library: 1 watched, 2 unwatched');
});

// ─── assets and CSS ───────────────────────────────────────────────────────────
test('assets: one new token on every versioned file; config.js, identity.js and the vendored supabase-js (version in its name) unversioned; script order', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'watchlist.html'), 'utf8');
  // Consistency only: that the token differs from the previous release's is a release check (docs/STATE.md).
  const versioned = [...html.matchAll(/\?v=([\w-]+)/g)].map(m => m[1]);
  assert.strictEqual(versioned.length, 29, 'every versioned file carries a token');
  assert.strictEqual(new Set(versioned).size, 1, `one token on every versioned file: ${[...new Set(versioned)].join(', ')}`);
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1].split('?')[0]);
  // The order at the baseline (fa69c9a), with write-lane.js after api.js (Batch A) and collection-members.js after organization-manage.js (S4) and history.js after browse-views.js (S6);
  // M1: the vendored supabase-js after config.js, and auth.js after identity.js. EP1: episodes.js after tv-shows.js. Item 2: show-ratings.js after episodes.js.
  // Item 4: refresh-shows.js and catalog-apply.js retired; collection-updates.js, collection-research.js and collection-settings.js where catalog-apply.js was.
  assert.deepStrictEqual(scripts, ['config.js', 'vendor/supabase-js-2.117.2.umd.js', 'identity.js', 'auth.js', 'api.js', 'write-lane.js', 'ui-helpers.js', 'metadata.js', 'backup-restore.js', 'backup-format3.js', 'tabs.js',
    'render.js', 'row-actions.js', 'tmdb-search.js', 'collections-pull.js', 'universe-pull.js', 'person-pull.js', 'tmdb-match.js',
    'derived-views.js', 'tv-shows.js', 'episodes.js', 'show-ratings.js', 'organization.js', 'organization-manage.js', 'collection-members.js',
    'collection-updates.js', 'collection-research.js', 'collection-settings.js', 'browse-views.js', 'history.js', 'library.js']);
  assert.ok(/src="config\.js"/.test(html) && /src="identity\.js"/.test(html), 'unversioned');
});

// Contrast of the new styles' colour pairs, calculated from styles.css tokens (not rendered).
function tokens(css, light) {
  const block = light ? css.match(/@media \(prefers-color-scheme: light\) \{\s*:root \{([\s\S]*?)\}\s*\}/)[1] : css.match(/^:root \{([\s\S]*?)\}/m)[1];
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map(m => [m[1], m[2]]));
}
const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
test('CSS: the panel hides with [hidden], phone rules replace the collapse; calculated contrast of the new chips, count and Clear ≥ 4.5:1 in both schemes', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(css.includes('.filter-more[hidden] { display: none; }') && css.includes('.filter-count[hidden] { display: none; }'));
  assert.ok(!/filter-toggle-btn|filters-inner|\.filters\.collapsed/.test(css), 'the collapse rules are gone');
  assert.ok(/\.filter-line \.search-input \{ flex: 1 1 150px;/.test(css) && /\.filter-chip \.chip-x \{ width: 28px; height: 28px; \}/.test(css), 'phone rules');
  for (const light of [false, true]) {
    const t = { ...tokens(css, false), ...(light ? tokens(css, true) : {}) };
    const pairs = [['chip text', t.text, t['accent-dim']], ['chip kind', t.text, t['accent-dim']], ['kept chip', t.text2, t.bg],
      ['kept chip on a card', t.text2, t.surface], ['count badge', t.bg, t.accent], ['Clear link', t.accent, t.bg], ['group label', t.text2, t.bg]];
    for (const [what, fg, bg] of pairs) assert.ok(contrast(fg, bg) >= 4.5, `${light ? 'light' : 'dark'} ${what}: ${contrast(fg, bg).toFixed(2)}`);
  }
});

// B10 correction batch 1 (BV-2 findings F1–F5). Source checks and calculated contrast only: the rendered
// layout and contrast are checked in the browser (bi1-corr1 package).
test('corr1 (F3, F4): More filters open keeps the text colour (rest and hover backgrounds); panel group titles ≥ 4.5:1 — calculated, both schemes', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const open = css.match(/\.filter-more-btn\[aria-expanded="true"\] \{([^}]*)\}/)[1];
  assert.ok(!/(^|[^-])color\s*:/.test(open), 'the open state sets no text colour (the button keeps --text)');
  assert.ok(/border-color: var\(--accent\)/.test(open), 'the open state is still marked (accent border)');
  assert.ok(/\.filter-group-title \{[^}]*color: var\(--text2\)/.test(css), 'group titles use --text2');
  assert.ok(/\.btn \{[^}]*color: var\(--text\)/.test(css) && /\.btn \{[^}]*background: var\(--surface2\)/.test(css) && /\.btn:hover \{ background: var\(--border\); \}/.test(css), 'the button colours the pairs below assume');
  for (const light of [false, true]) {
    const t = { ...tokens(css, false), ...(light ? tokens(css, true) : {}) };
    const pairs = [['More filters (open, rest)', t.text, t.surface2], ['More filters (open, hover)', t.text, t.border],
      ['panel group title', t.text2, t.surface]];
    for (const [what, fg, bg] of pairs) assert.ok(contrast(fg, bg) >= 4.5, `${light ? 'light' : 'dark'} ${what}: ${contrast(fg, bg).toFixed(2)}`);
  }
});

test('corr1 (F1, F2, F5): kept chips are a two-row grid inside their box; chips and their rows can shrink, phones bound a chip by the viewport; collection toggles take their own desktop line — source checks', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(/\.filter-chip\.filter-chip-kept \{ display: inline-grid; grid-template-columns: auto minmax\(0, 1fr\) auto; grid-template-areas: "k v x" "na na x";/.test(css), 'F1: kind, value and ✕ on one row, the context below');
  for (const [part, area] of [['chip-k', 'k'], ['chip-v', 'v'], ['chip-x', 'x'], ['chip-na', 'na']]) {
    assert.ok(new RegExp(`\\.filter-chip-kept \\.${part} \\{ grid-area: ${area};`).test(css), `F1: ${part} in area ${area}`);
  }
  assert.ok(/\.filter-chip\.filter-chip-kept \.chip-na \{[^}]*white-space: normal;/.test(css), 'F1: the context may wrap (and wins over the general nowrap rule by specificity)');
  assert.ok(/\.filter-chips \{[^}]*min-width: 0; max-width: 100%;/.test(css) && /\.chip-group \{ display: flex;[^}]*min-width: 0; max-width: 100%;/.test(css), 'F2: rows and groups shrink');
  const phone = css.slice(css.indexOf('/* B10 (D10)'));
  assert.ok(/\.filter-chip \{ min-height: 32px; max-width: min\(100%, calc\(100vw - 24px\)\); \}/.test(phone), 'F2: phone bounds');
  assert.ok(/@media \(min-width: 701px\) \{ \.filters > \.browse-controls \{ display: flex; flex: 1 0 100%;/.test(css), 'F5: desktop toggles on their own line');
});

// B10 correction batch 2 (D11): All Movies' ↻ Refresh for a person collection tag sits beside the Collection
// tag select, in one row of its field inside More filters. Markup and source checks; the rendered placement is
// checked in the browser (bi1-corr2 package).
test('corr2 (D11): the Collection tag select and its ↻ Refresh share one field row inside More filters; Refresh only for a person tag; collections unchanged', async () => {
  const data = library();
  data.rows.push(film({ id: 'f-dir', title: 'Director Film', collections: ['Some Director'] }));
  const app = await boot(data, { customCollections: [{ id: 'cc-1', name: 'Some Director', tmdb_person_id: 42, role: 'director' }] });
  await movies(app);
  const f = fb(app);
  const row = f.match(/<div class="filter-field"><label class="filter-field-label" for="fCollection">Collection tag<\/label><div class="filter-field-row"><select id="fCollection"[\s\S]*?<\/select><span id="collectionRefreshLink"><\/span><\/div><\/div>/);
  assert.ok(row, 'select then the Refresh span, in one row of the Collection tag field');
  assert.ok(f.indexOf(row[0]) > f.indexOf('id="filterMore"') && f.indexOf(row[0]) < f.indexOf('id="filterChips"'), 'inside More filters');
  setFilter(app, 'fCollection', 'Some Director'); app.ctx.updateCollectionRefreshLink(); await settle();
  assert.ok(app.el('collectionRefreshLink').innerHTML.includes(`libraryRefreshPerson('Some Director')`) && app.el('collectionRefreshLink').innerHTML.includes('↻ Refresh'), 'Refresh for the person tag');
  setFilter(app, 'fCollection', 'Saga'); app.ctx.updateCollectionRefreshLink(); await settle();
  assert.strictEqual(app.el('collectionRefreshLink').innerHTML, '', 'no Refresh for a non-person tag');
  assert.ok(app.requests.every(r => r.method === 'GET'), 'nothing but reads');
  await collection(app);
  assert.ok(!fb(app).includes('filter-field-row') && !fb(app).includes('collectionRefreshLink'), 'a collection has no Refresh and no field row');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(/\.filter-field-row \{ display: flex; align-items: center; gap: 6px; min-width: 0; \}/.test(css) && /\.filter-field-row select \{ flex: 1 1 auto; min-width: 0; \}/.test(css)
    && /\.filter-field-row #collectionRefreshLink:empty \{ display: none; \}/.test(css), 'CSS: one row; the select shrinks; an empty link takes no space');
});

// B10 follow-up (FP-0 rev2, approved): F7, the ↻ Refresh link's readability and target; F6, a collection's TV seasons
// choice on phones. Source checks and calculated contrast only: rendered contrast, sizes and fit are FV-2's.
test('follow-up F7: ↻ Refresh is 13 px underlined accent text with the inherited font, a hover and focus treatment, ≥ 30 px desktop / 44 px phone targets; accent ≥ 4.5:1 and focus ring ≥ 3:1 on the panel — calculated, both schemes', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const rule = css.match(/\n\.collection-refresh-link \{([^}]*)\}/)[1];
  for (const decl of ['font-size: 13px', 'font-family: inherit', 'color: var(--accent)', 'text-decoration: underline', 'min-height: 30px', 'padding: 4px 6px', 'white-space: nowrap']) {
    assert.ok(rule.includes(decl), `rule has ${decl}`);
  }
  assert.ok(!/--text3|margin-left/.test(rule), 'the old muted colour and margin are gone');
  assert.ok(/\.collection-refresh-link:hover \{ color: var\(--text\); \}/.test(css), 'hover');
  assert.ok(/\.collection-refresh-link:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 2px; \}/.test(css), 'focus ring');
  const phone = css.slice(css.indexOf('/* B10 (D10)'));
  assert.ok(/\.collection-refresh-link \{ min-height: 44px; padding: 0 10px; \}/.test(phone), 'phone target 44 px');
  assert.ok(/\.filter-more \{[^}]*background: var\(--surface\)/.test(css), 'the panel background the pairs below assume');
  for (const light of [false, true]) {
    const t = { ...tokens(css, false), ...(light ? tokens(css, true) : {}) };
    for (const [what, fg, bg, min] of [['Refresh text', t.accent, t.surface, 4.5], ['Refresh hover', t.text, t.surface, 4.5], ['Refresh focus ring', t.accent, t.surface, 3]]) {
      assert.ok(contrast(fg, bg) >= min, `${light ? 'light' : 'dark'} ${what}: ${contrast(fg, bg).toFixed(2)}`);
    }
  }
});

test('follow-up F7: Refresh markup, name, visibility, action and place are unchanged — beside the Collection tag select, only for a person tag, reads only', async () => {
  const data = library();
  data.rows.push(film({ id: 'f-dir2', title: 'Director Film', collections: ['Some Director'] }));
  const app = await boot(data, { customCollections: [{ id: 'cc-1', name: 'Some Director', tmdb_person_id: 42, role: 'director' }] });
  await movies(app);
  assert.ok(/<div class="filter-field-row"><select id="fCollection"[\s\S]*?<\/select><span id="collectionRefreshLink"><\/span><\/div>/.test(fb(app)), 'select, then the Refresh span, in one field row');
  setFilter(app, 'fCollection', 'Some Director'); app.ctx.updateCollectionRefreshLink(); await settle();
  assert.strictEqual(app.el('collectionRefreshLink').innerHTML, `<button class="collection-refresh-link" onclick="libraryRefreshPerson('Some Director')">↻ Refresh</button>`, 'same button, name and action');
  setFilter(app, 'fCollection', ''); app.ctx.updateCollectionRefreshLink(); await settle();
  assert.strictEqual(app.el('collectionRefreshLink').innerHTML, '', 'none for All collection tags');
  assert.ok(readsOnly(app), 'nothing but reads; Refresh is never invoked');
});

test('follow-up F6: only a collection\'s TV seasons select carries the marker class; All TV\'s Seasons select does not; option wording, values, order and name unchanged; the phone rule widens the grid only for the marked select', async () => {
  const app = await boot();
  await collection(app);
  app.ctx.setBrowsePresentation('seasons');
  const sel = fb(app).match(/<select id="fSeasonVis"[^>]*>[\s\S]*?<\/select>/)[0];
  assert.ok(sel.startsWith('<select id="fSeasonVis" class="season-vis-select" onchange="setBrowseSeasonVis(this.value)" aria-label="TV seasons">'), 'class added; handler and name unchanged');
  assert.deepStrictEqual([...sel.matchAll(/<option value="(\w+)"[^>]*>([^<]*)<\/option>/g)].map(m => [m[1], m[2]]),
    [['notskipped', 'TV seasons: All (except Skipped)'], ['all', 'TV seasons: All'], ['towatch', 'TV seasons: To watch'], ['watched', 'TV seasons: Watched'], ['skipped', 'TV seasons: Skipped']], 'options unchanged');
  assert.deepStrictEqual(lineIds(app), ['fSearch', 'fStatus', 'fSeasonVis', 'filterMoreBtn'], 'line order unchanged');
  await allTv(app, 'seasons');
  const tvSel = fb(app).match(/<select id="fSeasonVis"[^>]*>/)[0];
  assert.ok(!tvSel.includes('season-vis-select') && tvSel.includes('aria-label="Seasons"'), 'All TV unchanged (outside scope)');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const phone = css.slice(css.indexOf('/* B10 (D10)'), css.indexOf('/* ─── Manage collections'));
  assert.ok(/\.filter-line \.season-vis-select \{ flex-basis: 260px; \}/.test(phone), 'phone-only rule, 260 px wide');
  assert.strictEqual((css.match(/season-vis-select/g) || []).length, 1, 'no desktop rule');
});

T.run();
