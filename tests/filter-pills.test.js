// Offline tests for the list filters added after Stage 3b-2: filter pills (genre /
// theme / network, legacy collection tags, watch-with choices) that toggle one value
// per filter in every list view, their selected state and keyboard focus; All
// Movies' Watched filter (Unwatched only on entry); All TV's Shows-only progress
// filter; show-level theme matching that keeps every season; filter values kept
// through redraws, presentation and media changes and Back, and hidden controls
// not filtering. Filtering only redraws: no request is made, nothing is written.
// Run from the repo root: node tests/filter-pills.test.js
// No network, no database (see tests/app-harness.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('filter-pills');
const test = T.test;
const DISNEY = 'browse:0c000000-0000-4000-8000-000000000001';

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
// A show and its seasons. Season specs: { theme, w (watched), s (skipped), date }.
function show(o, specs) {
  const s = { id: nid('show'), collection: 'othertv', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: null, status: 'confirmed', ...o };
  const rows = specs.map((sp, i) => ({
    id: nid('r'), collection: s.collection, title: s.title, theme: sp.theme || 'HBO', status: 'confirmed',
    watched: !!sp.w, skipped: !!sp.s, show_id: s.id, media_type: null, tmdb_id: null, season_number: null,
    season: `Season ${i + 1}`, display_date: sp.date || '2020-01-01', date_sort: sp.date || '2020-01-0' + (i + 1),
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
    // Disney+ (static themes): one show whose seasons have different themes.
    show({ title: 'Mixed Show', collection: 'disney', status: 'watching' }, [{ theme: 'Marvel', w: true }, { theme: 'Star Wars' }]),
    show({ title: 'Soon Show', collection: 'disney' }, [{ theme: 'Marvel', date: day(20) }]),
    show({ title: 'All Watched', status: 'complete' }, [{ w: true }, { w: true }, { s: true }]),
    show({ title: 'All Skipped' }, [{ s: true }, { s: true }]),
    show({ title: 'Future Only', theme: 'Netflix' }, [{ theme: 'Netflix', date: day(40) }]),
    show({ title: 'Skipped Show', status: 'skipped' }, [{ theme: 'Netflix' }, { theme: 'Netflix', w: true }]),
    show({ title: 'Done Skipped Show', status: 'skipped' }, [{ theme: 'Netflix', w: true }]),
    show({ title: 'Other Watch', status: 'watching' }, [{ theme: 'HBO' }]),
    film({ id: 'f-alpha', title: 'Alpha', theme: 'Action', collections: ['Star Wars Collection'], watch_with: ['Rina'] }),
    film({ id: 'f-beta', title: 'Beta', watched: true, watch_with: ['Rina'] }),
    film({ id: 'f-gamma', title: 'Gamma', collection: 'disney', media_type: null, tmdb_id: null, theme: 'Marvel' }),
    film({ id: 'f-delta', title: 'Delta', theme: 'Action', watched: true, collections: ['Star Wars Collection'] }),
    film({ id: 'f-eps', title: 'Epsilon', status: 'skipped' }),
    film({ id: 'f-zeta', title: 'Zeta', collection: 'disney', media_type: null, tmdb_id: null, theme: 'Star Wars',
      collections: ['Star Wars Collection'], watch_with: ['Rina'] })
  );
}
// Rina's choice was renamed: the stored token stays "Rina", the label is now "Rina R.".
const CHOICES = [['Alone', 'Alone'], ['Rina', 'Rina R.'], ['Suzanne', 'Suzanne']].map(([token, label], i) => ({
  id: `0e000000-0000-4000-8000-00000000000${i + 1}`, token, label, sort_order: i + 1, archived_at: null, created_at: '2026-10-06T00:00:00+00:00' }));

async function boot(data = library(), opts = {}) {
  return createApp({ rows: data.rows, tvShows: data.shows, watchWithChoices: CHOICES, ...opts });
}
const html = app => app.el('tbody').innerHTML;
const cards = app => app.el('cardList').innerHTML;
const titles = app => [...html(app).matchAll(/<span class="show-title">([^<]*)<\/span>/g)].map(m => m[1]);
const stats = app => [...app.el('statsRow').innerHTML.matchAll(/stat-num">(\d+)<\/div><div class="stat-label">([^<]*)</g)].map(m => `${m[1]} ${m[2]}`);
const setFilter = (app, id, value) => { app.el(id).value = value; app.ctx.renderTable(); };
// A pill as the page passes it to its handler (this): its kind and value, and optionally its row.
const pill = (kind, value, owner = '') => ({ dataset: { filterKind: kind, filterValue: value, pillOwner: owner } });
const click = (app, kind, value) => app.ctx.toggleFilterPill(pill(kind, value));
const pressed = (app, s = html(app)) => [...s.matchAll(/data-filter-kind="(\w+)" data-filter-value="([^"]*)"[^>]*aria-pressed="true"/g)].map(m => `${m[1]}:${m[2]}`);
const options = (app, id) => {
  const m = app.el('filtersRow').innerHTML.match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`));
  return m ? [...m[0].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map(x => `${x[1]}=${x[2]}`) : null;
};
const readsOnly = app => app.requests.every(r => r.method === 'GET');

// ─── All Movies: Watched ─────────────────────────────────────────────────────
test('All Movies opens on Unwatched only (the stored watched flag); Status still hides Skipped; totals before Watched, Shown after', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies');
  assert.strictEqual(app.el('fWatch').value, 'unwatched');
  assert.deepStrictEqual(options(app, 'fWatch'), ['=Any watched state', 'unwatched=Unwatched only', 'watched=Watched only']);
  assert.ok(/<option value="unwatched" selected>/.test(app.el('filtersRow').innerHTML), 'selected in the markup too (a real select shows it)');
  assert.deepStrictEqual(titles(app), ['Alpha', 'Gamma', 'Zeta'], 'unwatched; Skipped Epsilon hidden by Status');
  assert.deepStrictEqual(stats(app), ['3 Shown', '5 Films', '2 Watched', '3 To watch']);
  setFilter(app, 'fWatch', 'watched');
  assert.deepStrictEqual(titles(app), ['Beta', 'Delta']);
  assert.deepStrictEqual(stats(app), ['2 Shown', '5 Films', '2 Watched', '3 To watch']);
  setFilter(app, 'fWatch', '');
  assert.deepStrictEqual(titles(app), ['Alpha', 'Beta', 'Delta', 'Gamma', 'Zeta']);
  setFilter(app, 'fStatus', 'all'); setFilter(app, 'fWatch', 'unwatched');
  assert.deepStrictEqual(titles(app), ['Alpha', 'Epsilon', 'Gamma', 'Zeta'], 'Status All statuses + Unwatched only');
  setFilter(app, 'fStatus', 'skipped');
  assert.deepStrictEqual(titles(app), ['Epsilon']);
  setFilter(app, 'fStatus', ''); setFilter(app, 'fSearch', 'a'); setFilter(app, 'fSource', 'disney');
  assert.deepStrictEqual(titles(app), ['Gamma', 'Zeta'], 'Search and Source combine with it');
  assert.ok(readsOnly(app));
});

test('a changed Watched choice is kept through redraws, Retry and Back; a fresh entry starts on Unwatched only again', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  setFilter(app, 'fWatch', 'watched');
  app.ctx.renderFilters(); app.ctx.renderTable();
  assert.strictEqual(app.el('fWatch').value, 'watched', 'redraw');
  app.ctx.loadBrowseView(); await settle();
  assert.strictEqual(app.el('fWatch').value, 'watched', 'Retry / read again');
  assert.deepStrictEqual(titles(app), ['Beta', 'Delta']);
  setFilter(app, 'fWatch', '');
  app.ctx.openBrowseCollection(DISNEY); await settle();
  app.ctx.browseBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies');
  assert.strictEqual(app.el('fWatch').value, '', 'Back keeps an explicit Any watched state');
  assert.strictEqual(titles(app).length, 5);
  app.ctx.switchView('allmovies'); await settle();
  assert.strictEqual(app.el('fWatch').value, 'unwatched', 'fresh entry');
  assert.ok(readsOnly(app));
});

test('All Movies: a changed filter survives a direct reload (no redraw first) and a failed read then Retry; a fresh entry still resets', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  setFilter(app, 'fWatch', 'watched'); setFilter(app, 'fTheme', 'Action');
  app.ctx.loadBrowseView(); await settle();
  assert.deepStrictEqual([app.el('fWatch').value, app.el('fTheme').value], ['watched', 'Action'], 'direct reload');
  assert.deepStrictEqual(titles(app), ['Delta']);
  setFilter(app, 'fWatch', '');
  app.failNext(r => r.method === 'GET' && r.url.includes('/watchlist_items'));
  app.ctx.loadBrowseView(); await settle();
  assert.ok(html(app).includes('Failed to load') && app.el('fWatch') === null, 'the read failed: no controls');
  app.ctx.loadBrowseView(); await settle(); // Retry
  assert.deepStrictEqual([app.el('fWatch').value, app.el('fTheme').value], ['', 'Action'], 'Retry after a failed read');
  assert.deepStrictEqual(titles(app), ['Alpha', 'Delta']);
  app.ctx.switchView('allmovies'); await settle(); // the previous controls are still drawn when the fresh entry starts
  assert.deepStrictEqual([app.el('fWatch').value, app.el('fTheme').value], ['unwatched', ''], 'fresh entry: defaults');
  assert.ok(readsOnly(app));
});

test('All TV: progress and theme survive a direct reload and a failed read then Retry, also while hidden in Seasons; a fresh entry resets', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  setFilter(app, 'fStatus', 'all'); setFilter(app, 'fProgress', 'allwatched');
  app.ctx.loadDerivedView(); await settle();
  assert.deepStrictEqual([app.el('fStatus').value, app.el('fProgress').value], ['all', 'allwatched'], 'direct reload');
  assert.deepStrictEqual(titles(app), ['All Watched', 'Done Skipped Show']);
  setFilter(app, 'fTheme', 'Netflix');
  app.failNext(r => r.method === 'GET' && r.url.includes('/tv_shows'));
  app.ctx.loadDerivedView(); await settle();
  assert.ok(html(app).includes('Failed to load') && app.el('fProgress') === null, 'the read failed: no controls');
  app.ctx.loadDerivedView(); await settle(); // Retry
  assert.deepStrictEqual([app.el('fTheme').value, app.el('fProgress').value], ['Netflix', 'allwatched'], 'Retry after a failed read');
  assert.deepStrictEqual(titles(app), ['Done Skipped Show']);
  app.ctx.setAllTvPresentation('seasons'); await settle();
  setFilter(app, 'fTheme', 'HBO');
  app.ctx.loadDerivedView(); await settle(); // reloaded while Progress is hidden
  assert.strictEqual(app.el('fProgress'), null);
  assert.strictEqual(app.el('fTheme').value, 'HBO');
  app.ctx.setAllTvPresentation('shows'); await settle();
  assert.deepStrictEqual([app.el('fTheme').value, app.el('fProgress').value], ['HBO', 'allwatched'], 'the hidden filter comes back');
  app.ctx.switchView('alltv'); await settle();
  assert.deepStrictEqual([app.el('fStatus').value, app.el('fTheme').value, app.el('fProgress').value], ['', '', ''], 'fresh entry: defaults');
  assert.ok(readsOnly(app));
});

// ─── Pills: toggle, replace, clear, selected state ───────────────────────────
test('a genre pill filters All Movies; clicking it again clears it, another replaces it; selected pills show it; no request', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  setFilter(app, 'fWatch', '');
  const before = app.requests.length;
  click(app, 'theme', 'Action');
  assert.strictEqual(app.el('fTheme').value, 'Action');
  assert.deepStrictEqual(titles(app), ['Alpha', 'Delta']);
  assert.deepStrictEqual(pressed(app), ['theme:Action', 'theme:Action'], 'every pill with that value, and only those');
  assert.deepStrictEqual(pressed(app, cards(app)), ['theme:Action', 'theme:Action'], 'cards too');
  assert.ok(/aria-pressed="true" title="Remove this filter \(Action\)"/.test(html(app)));
  click(app, 'theme', 'Drama');
  assert.strictEqual(app.el('fTheme').value, 'Drama', 'another pill replaces it');
  assert.deepStrictEqual(titles(app), ['Beta']);
  click(app, 'theme', 'Drama');
  assert.strictEqual(app.el('fTheme').value, '', 'the selected pill clears it');
  assert.deepStrictEqual(pressed(app), []);
  assert.strictEqual(titles(app).length, 5);
  assert.strictEqual(app.requests.length, before, 'filtering makes no request');
});

test('filter choices come from the whole view, not the shown rows, so a choice can always be changed or cleared', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  setFilter(app, 'fSearch', 'zzz'); click(app, 'theme', 'Action');
  assert.deepStrictEqual(titles(app), []);
  assert.deepStrictEqual(options(app, 'fTheme'), ['=All genres / themes', 'Action=Action', 'Drama=Drama', 'Marvel=Marvel', 'Star Wars=Star Wars']);
  app.ctx.renderFilters(); app.ctx.renderTable();
  assert.deepStrictEqual(options(app, 'fTheme').length, 5, 'unchanged after a redraw with nothing shown');
  assert.strictEqual(app.el('fTheme').value, 'Action');
  assert.deepStrictEqual(options(app, 'fCollection'), ['=All collection tags', 'Star Wars=Star Wars']);
  assert.deepStrictEqual(options(app, 'fWatchWith'), ['=Watch with: anyone', 'Rina=Rina R.']);
});

test('collection-tag and watch-with pills in All Movies: by cleaned tag and by stored token, showing the renamed label; they combine', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  setFilter(app, 'fWatch', '');
  assert.ok(/class="ww-tag ww-tag-clickable filter-pill" data-filter-kind="watchwith" data-filter-value="Rina"[^>]*>Rina R\.<\/button>/.test(html(app)),
    'token in the value, current label shown');
  assert.ok(/class="collection-tag collection-tag-clickable filter-pill" data-filter-kind="collection" data-filter-value="Star Wars"[^>]*>Star Wars</.test(html(app)));
  click(app, 'collection', 'Star Wars');
  assert.deepStrictEqual(titles(app), ['Alpha', 'Delta', 'Zeta']);
  click(app, 'watchwith', 'Rina');
  assert.deepStrictEqual(titles(app), ['Alpha', 'Zeta'], 'both: AND');
  assert.deepStrictEqual(pressed(app).sort(), ['collection:Star Wars', 'collection:Star Wars', 'watchwith:Rina', 'watchwith:Rina']);
  click(app, 'collection', 'Star Wars');
  assert.deepStrictEqual(titles(app), ['Alpha', 'Beta', 'Zeta']);
  assert.strictEqual(app.el('fCollection').value, '');
  assert.ok(readsOnly(app) && app.writes().length === 0);
});

test('a collection’s films: tag and watch-with filters; no TV while one is set (said so); TV only hides them without filtering; they come back', async () => {
  const app = await boot();
  app.ctx.openBrowseCollection(DISNEY); await settle();
  assert.deepStrictEqual(titles(app), ['Mixed Show', 'Soon Show', 'Gamma', 'Zeta']);
  click(app, 'collection', 'Star Wars');
  assert.deepStrictEqual(titles(app), ['Zeta']);
  assert.ok(html(app).includes('Only films carry collection tags and watch-with choices'));
  app.ctx.setBrowseMedia('tv'); await settle();
  assert.strictEqual(app.el('fCollection'), null, 'not offered for TV only');
  assert.deepStrictEqual(titles(app), ['Mixed Show', 'Soon Show'], 'a hidden filter doesn’t narrow');
  app.ctx.setBrowseMedia('all'); await settle();
  assert.strictEqual(app.el('fCollection').value, 'Star Wars', 'kept for the visit');
  assert.deepStrictEqual(titles(app), ['Zeta']);
  click(app, 'watchwith', 'Rina');
  assert.deepStrictEqual(titles(app), ['Zeta']);
  assert.ok(readsOnly(app));
});

test('a collection’s theme: a show matches on any stored season and keeps all of them; Seasons matches each season', async () => {
  const app = await boot();
  app.ctx.openBrowseCollection(DISNEY); await settle();
  setFilter(app, 'fTheme', 'Star Wars');
  assert.deepStrictEqual(titles(app), ['Mixed Show', 'Zeta']);
  assert.ok(html(app).includes('1/1 watched') === false && html(app).includes('1/2 watched'), 'progress over both seasons');
  setFilter(app, 'fTheme', 'Marvel');
  assert.deepStrictEqual(titles(app), ['Mixed Show', 'Soon Show', 'Gamma']);
  app.ctx.setBrowsePresentation('seasons'); await settle();
  assert.strictEqual(app.el('fTheme').value, 'Marvel', 'kept across Shows / Seasons');
  const seasonRows = [...html(app).matchAll(/<span class="show-title">([^<]*)<\/span><span class="season-lbl"> · ([^<]*)</g)].map(m => `${m[1]} ${m[2]}`);
  assert.deepStrictEqual(seasonRows.filter(x => !x.endsWith('Film')), ['Mixed Show Season 1', 'Soon Show Season 1']);
});

// ─── All TV ───────────────────────────────────────────────────────────────────
test('All TV: a network/theme pill filters Shows by any stored season, keeping every season for progress, up next and expansion', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  assert.ok(/data-filter-kind="theme" data-filter-value="Star Wars"[^>]*aria-pressed="false"/.test(html(app)), 'the up-next season’s theme is the pill');
  click(app, 'theme', 'Marvel');
  assert.deepStrictEqual(titles(app), ['Mixed Show', 'Soon Show']);
  const mixed = html(app).slice(html(app).indexOf('Mixed Show'), html(app).indexOf('</tr>', html(app).indexOf('Mixed Show')));
  assert.ok(mixed.includes('1/2 watched') && mixed.includes('Season 2'), 'all seasons kept: progress 1/2, up next Season 2');
  assert.ok(/data-filter-value="Star Wars"[^>]*aria-pressed="false"/.test(mixed), 'its own pill (another theme) isn’t shown as selected');
  app.ctx.toggleDerivedShow(app.get("[...tvShowsById.values()].find(s => s.title === 'Mixed Show').id"));
  assert.strictEqual((html(app).match(/class="[^"]*sub-row/g) || []).length, 2, 'expanded: both seasons');
  click(app, 'theme', 'Marvel');
  assert.strictEqual(app.el('fTheme').value, '');
});

test('All TV Seasons: theme per season; Shows’ progress filter isn’t shown there and doesn’t narrow; both come back in Shows', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  setFilter(app, 'fStatus', 'all'); setFilter(app, 'fProgress', 'allwatched'); setFilter(app, 'fTheme', 'Netflix');
  assert.deepStrictEqual(titles(app), ['Done Skipped Show']);
  app.ctx.setAllTvPresentation('seasons'); await settle();
  assert.strictEqual(app.el('fProgress'), null);
  assert.strictEqual(app.el('fTheme').value, 'Netflix');
  app.ctx.setAllTvSeasonVis('all');
  assert.deepStrictEqual(titles(app).sort(), ['Done Skipped Show', 'Future Only', 'Skipped Show', 'Skipped Show'], 'every Netflix season, progress not applied');
  app.ctx.setAllTvSeasonVis('towatch');
  assert.deepStrictEqual(titles(app), ['Future Only'], 'the existing To watch rule (no Skipped show) with the theme');
  app.ctx.setAllTvPresentation('shows'); await settle();
  assert.strictEqual(app.el('fProgress').value, 'allwatched');
  assert.deepStrictEqual(titles(app), ['Done Skipped Show']);
});

test('All TV progress: unwatched seasons (future ones count, skipped seasons don’t, never a Skipped show); all non-skipped watched needs one', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  assert.deepStrictEqual(options(app, 'fProgress'), ['=Any progress', 'unwatched=Has unwatched seasons', 'allwatched=All non-skipped seasons watched']);
  setFilter(app, 'fStatus', 'all');
  setFilter(app, 'fProgress', 'unwatched');
  assert.deepStrictEqual(titles(app), ['Future Only', 'Mixed Show', 'Other Watch', 'Soon Show'], 'not All Watched, All Skipped, or the Skipped shows');
  setFilter(app, 'fProgress', 'allwatched');
  assert.deepStrictEqual(titles(app), ['All Watched', 'Done Skipped Show'], 'All Skipped has no non-skipped season; a Skipped show is listed when Status allows');
  setFilter(app, 'fStatus', '');
  assert.deepStrictEqual(titles(app), ['All Watched'], 'Status still filters the show status separately');
  setFilter(app, 'fStatus', 'complete'); setFilter(app, 'fProgress', 'unwatched');
  assert.deepStrictEqual(titles(app), [], 'Complete is a status; progress reads the seasons');
  setFilter(app, 'fProgress', '');
  assert.deepStrictEqual(titles(app), ['All Watched']);
  const item = t => app.get(`deriveAllTv(derivedData.rows, tvShowsById, localTodayStr()).items.find(x => x.title === ${JSON.stringify(t)})`);
  assert.strictEqual(app.ctx.allTvProgressMatches(item('All Skipped'), 'unwatched'), false);
  assert.strictEqual(app.ctx.allTvProgressMatches(item('All Skipped'), 'allwatched'), false);
  assert.strictEqual(app.ctx.allTvProgressMatches(item('Skipped Show'), 'unwatched'), false);
  assert.ok(readsOnly(app));
});

test('Back from a collection puts All TV’s theme and progress back; a fresh entry resets them', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  setFilter(app, 'fTheme', 'HBO'); setFilter(app, 'fProgress', 'unwatched');
  const shown = html(app);
  app.ctx.openBrowseCollection(DISNEY); await settle();
  app.ctx.browseBack(); await settle();
  assert.deepStrictEqual([app.el('fTheme').value, app.el('fProgress').value], ['HBO', 'unwatched']);
  assert.strictEqual(html(app), shown);
  app.ctx.switchView('alltv'); await settle();
  assert.deepStrictEqual([app.el('fTheme').value, app.el('fProgress').value], ['', '']);
});

// ─── Currently Watching and Coming Soon ──────────────────────────────────────
test('Currently Watching and Coming Soon filter by theme too, with choices from their own lists', async () => {
  const app = await boot();
  assert.strictEqual(app.get('activeViewId'), 'watching');
  assert.deepStrictEqual(options(app, 'fTheme'), ['=All networks / themes', 'HBO=HBO', 'Marvel=Marvel', 'Star Wars=Star Wars']);
  assert.deepStrictEqual(titles(app), ['Mixed Show', 'Other Watch']);
  click(app, 'theme', 'Star Wars');
  assert.deepStrictEqual(titles(app), ['Mixed Show']);
  click(app, 'theme', 'Star Wars');
  assert.deepStrictEqual(titles(app), ['Mixed Show', 'Other Watch']);
  app.ctx.switchView('comingsoon'); await settle();
  assert.strictEqual(app.el('fTheme').value, '', 'each view starts unfiltered');
  assert.deepStrictEqual(options(app, 'fTheme'), ['=All networks / themes', 'Marvel=Marvel', 'Netflix=Netflix']);
  click(app, 'theme', 'Netflix');
  assert.deepStrictEqual(titles(app), ['Future Only']);
  assert.deepStrictEqual(pressed(app), ['theme:Netflix']);
  assert.ok(readsOnly(app));
});

// ─── Legacy tabs ──────────────────────────────────────────────────────────────
test('legacy tabs: the same pills show their selected state; collection tags keep the legacy refresh link only there', async () => {
  const app = await boot();
  app.ctx.switchTab('othertv'); await settle();
  app.el('fWatch').value = ''; app.ctx.renderTable();
  click(app, 'theme', 'Netflix');
  assert.strictEqual(app.el('fTheme').value, 'Netflix');
  assert.ok(pressed(app).length > 0 && pressed(app).every(p => p === 'theme:Netflix'));
  click(app, 'theme', 'Netflix');
  assert.deepStrictEqual(pressed(app), []);
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.switchTab('movies'); await settle();
  app.el('fWatch').value = ''; app.ctx.renderTable();
  const writes = app.writes().length;
  let linkCalls = 0;
  const original = app.ctx.updateCollectionRefreshLink;
  app.ctx.updateCollectionRefreshLink = () => { linkCalls++; };
  click(app, 'collection', 'Star Wars');
  assert.strictEqual(app.el('fCollection').value, 'Star Wars');
  assert.strictEqual(linkCalls, 1, 'the legacy tab’s refresh link is updated');
  click(app, 'watchwith', 'Rina');
  assert.ok(/data-filter-value="Rina"[^>]*aria-pressed="true"[^>]*>Rina R\.</.test(html(app)), 'token filter, renamed label');
  app.ctx.switchView('allmovies'); await settle();
  click(app, 'collection', 'Star Wars');
  assert.strictEqual(app.el('fCollection').value, 'Star Wars');
  assert.strictEqual(linkCalls, 1, 'not in All Movies');
  app.ctx.updateCollectionRefreshLink = original;
  assert.strictEqual(app.writes().length, writes, 'no write from any pill');
});

// ─── Keyboard focus and safety ───────────────────────────────────────────────
test('keyboard: focus stays on the same pill (same row, same container) after the redraw, else the filter control', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  setFilter(app, 'fWatch', '');
  const focused = [];
  const btn = { ...pill('theme', 'Action', 'f-delta'), closest: sel => (sel === '#cardList' ? {} : null) };
  app.ctx.document.activeElement = btn;
  for (const id of ['tbody', 'cardList']) app.el(id).querySelector = sel => ({ focus: () => focused.push(`${id} ${sel}`) });
  app.ctx.toggleFilterPill(btn);
  assert.deepStrictEqual(focused, ['cardList [data-filter-kind="theme"][data-filter-value="Action"][data-pill-owner="f-delta"]']);
  app.el('cardList').querySelector = () => null;
  app.el('fTheme').focus = () => focused.push('fTheme');
  app.ctx.toggleFilterPill(btn);
  assert.strictEqual(focused[1], 'fTheme');
  app.ctx.document.activeElement = null;
  app.ctx.toggleFilterPill(btn); // a mouse click: nothing is refocused
  assert.strictEqual(focused.length, 2);
});

test('a pill is plain text without its filter control; an unoffered value changes nothing; pills are buttons with ids and data only', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  assert.strictEqual(app.get("filterPillHtml('collection', 'X', 'X', { cls: 'collection-tag' })"), '<span class="collection-tag">X</span>');
  // As a real select: only its options can be chosen (the fake DOM's controls accept any value).
  Object.assign(app.el('fTheme'), { tagName: 'SELECT', options: options(app, 'fTheme').map(o => ({ value: o.split('=')[0] })) });
  click(app, 'theme', 'Nope');
  assert.strictEqual(app.el('fTheme').value, '');
  click(app, 'theme', 'HBO');
  assert.strictEqual(app.el('fTheme').value, 'HBO', 'an offered one is set');
  const handlers = [...html(app).matchAll(/onclick="([^"]*toggleFilterPill[^"]*)"/g)].map(m => m[1]);
  assert.ok(handlers.length > 0 && handlers.every(h => h === 'event.stopPropagation(); toggleFilterPill(this)'));
  assert.ok(/<button type="button" class="badge [^"]*filter-pill"/.test(html(app)), 'a real button: Enter and Space work');
});

test('selected-state styling survives a network badge’s inline colours; the read-only watched label is not a control', async () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const rule = (css.match(/\.filter-pill\[aria-pressed="true"\] \{([^}]*)\}/) || [])[1] || '';
  assert.ok(/box-shadow/.test(rule) && /::after \{ content: ' ✕'; \}/.test(css));
  const app = await boot();
  const inline = app.get("networkBadgeStyle('HBO')");
  assert.ok(!/box-shadow|font-weight|outline/.test(inline), inline);
  app.ctx.switchMediaType('movie'); await settle();
  setFilter(app, 'fWatch', '');
  assert.ok(html(app).includes('<span class="ro-watch">Not watched</span>') && html(app).includes('<span class="ro-watch watched">✓ Watched</span>'));
  assert.ok(!/class="[^"]*(watch-btn|confirmed-lbl)[^"]*">(Not watched|✓ Watched)/.test(html(app) + cards(app)));
});

T.run();
