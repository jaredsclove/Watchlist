// Offline tests for the presentation batch (B9, B2, B6, B8): Movies without a secondary
// row (B9). The page runs in the whole-page harness (tests/app-harness.js).
// Run from the repo root: node tests/presentation.test.js
// No network, no database. Rendered checks (focus, layout at real widths) are not
// covered here; the harness's DOM has no layout or focus.
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('presentation');
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
// A show and its seasons. Season specs: { num | season, w, s (skipped), date, tba, display }.
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
      season: label, display_date: sp.tba ? (sp.display || 'TBA') : (sp.display || disp(date)), date_sort: date,
      item_key: `${s.show_key}|${label.toLowerCase()}`, watch_with: [], collections: []
    };
  });
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'movies', title: 'Film', theme: 'Drama', status: 'confirmed', watched: false,
  media_type: 'movie', tmdb_id: 900 + n, season_number: null, season: 'Film', display_date: disp(day(-400)), date_sort: day(-400),
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) });

async function boot(data, opts = {}) {
  return createApp({ rows: data.rows, tvShows: data.shows, ...opts });
}

// ─── B9: Movies without a secondary row ───────────────────────────────────────
function moviesLibrary() {
  return all(
    show({ title: 'Alpha', status: 'watching' }, [{ num: 1, w: true }, { num: 2 }]),
    film({ title: 'Heat' }),
    film({ title: 'Sheridan Film', collection: 'sheridan' })
  );
}

test('B9: Movies has no secondary row (hidden, empty); TV keeps its three views', async () => {
  const app = await boot(moviesLibrary());
  assert.strictEqual(app.el('tabBar').hidden, false, 'TV shows its row');
  assert.deepStrictEqual([...app.el('tabBar').innerHTML.matchAll(/switchView\('([^']+)'\)/g)].map(m => m[1]), ['watching', 'alltv', 'comingsoon']);
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies', 'the Movies button opens the film list directly');
  assert.strictEqual(app.el('tabBar').hidden, true);
  assert.strictEqual(app.el('tabBar').innerHTML, '');
  assert.ok(app.el('viewHead').innerHTML.includes('🎞️ All Movies</h2>'), 'the content heading stays');
  assert.ok(app.el('browseBar').innerHTML.includes('openCatalogChooser(this)'), 'the Browse bar (and Catalog updates) stays');
  assert.deepStrictEqual(app.writes(), []);
});

test('B9: All Movies keeps its filters, Unwatched-only default, actions and hidden Restore', async () => {
  const app = await boot(moviesLibrary());
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(app.el('fWatch').value, 'unwatched');
  assert.ok(app.el('filtersRow').innerHTML.includes("openLibraryPanel('movie')"));
  assert.ok(app.html().includes('toggleWatch('), 'the film actions are there');
  assert.strictEqual(app.el('restoreBtn').style.display, 'none', 'Restore stays hidden in All Movies');
});

test('B9: repeated TV ↔ Movies switches leave no stale row', async () => {
  const app = await boot(moviesLibrary());
  for (let i = 0; i < 3; i++) {
    app.ctx.switchMediaType('movie'); await settle();
    assert.strictEqual(app.el('tabBar').hidden, true);
    assert.strictEqual(app.el('tabBar').innerHTML, '');
    app.ctx.switchMediaType('tv'); await settle();
    assert.strictEqual(app.el('tabBar').hidden, false);
    assert.strictEqual(app.get('activeViewId'), 'watching');
    assert.ok(app.el('tabBar').innerHTML.includes('class="tab active" onclick="switchView(\'watching\')"'));
  }
});

test('B9: from a collection opened in Movies, Back and the Movies button both return to All Movies', async () => {
  const app = await boot(moviesLibrary());
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = 'watched'; app.ctx.renderTable();
  app.ctx.openBrowseCollection(app.browseId('sheridan')); await settle();
  assert.strictEqual(app.el('tabBar').hidden, true, 'still no secondary row in a collection opened from Movies');
  assert.ok(app.el('viewHead').innerHTML.includes('← Back to Movies'));
  app.ctx.browseBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies');
  assert.strictEqual(app.el('fWatch').value, 'watched', 'Back puts the filters back');
  app.ctx.openBrowseCollection(app.browseId('sheridan')); await settle();
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies', 'the Movies button leaves the collection');
  assert.strictEqual(app.el('tabBar').hidden, true);
});

T.run();
