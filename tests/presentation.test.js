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

// ─── B2: the show-level shortcut names its season ─────────────────────────────
const shortcuts = html => [...html.matchAll(/<button class="watch-btn show-shortcut" data-shortcut-show="([^"]*)" aria-label="([^"]*)" onclick="([^"]*)">([^<]*)<\/button>/g)]
  .map(m => ({ show: m[1], aria: m[2], onclick: m[3], text: m[4] }));

test('B2: Currently Watching and All TV name the up-next season on the show-level shortcut, in table and cards', async () => {
  const a = show({ title: 'Worst Neighbor Ever', status: 'watching' }, [{ num: 1, date: day(-3) }]);
  for (const view of ['watching', 'alltv']) {
    const app = await boot(all(a));
    app.ctx.switchView(view); await settle();
    const rows = shortcuts(app.el('tbody').innerHTML), cards = shortcuts(app.el('cardList').innerHTML);
    assert.strictEqual(rows.length, 1, `${view}: one shortcut in the table`);
    assert.strictEqual(cards.length, 1, `${view}: one shortcut in the cards`);
    for (const s of [rows[0], cards[0]]) {
      assert.strictEqual(s.text, 'Mark Season 1 watched');
      assert.strictEqual(s.aria, 'Mark Season 1 of Worst Neighbor Ever watched');
      assert.strictEqual(s.show, a.show.id);
      assert.ok(s.onclick.endsWith(`toggleWatch('${a.rows[0].id}')`));
    }
    assert.ok(!/>Mark watched</.test(app.html()), `${view}: no bare "Mark watched" at show level`);
  }
});

test('B2: the stored label is used verbatim (Volume, Specials, parts, a 60-character label) and escaped', async () => {
  const long = 'Season 7: The Extremely Long Subtitle That Keeps Going On On';
  assert.strictEqual(long.length, 60);
  const cases = [
    [show({ title: 'Vol', status: 'watching', tmdb_id: null }, [{ season: 'Volume 1', w: true }, { season: 'Volume 2', date: day(-2) }]), 'Volume 2'],
    [show({ title: 'Sp', status: 'watching' }, [{ num: 0, date: day(-2) }]), 'Specials'],
    [show({ title: 'Part', status: 'watching', tmdb_id: null }, [{ season: 'Season 5 (Part 1)', date: day(-2) }]), 'Season 5 (Part 1)'],
    [show({ title: 'Long', status: 'watching', tmdb_id: null }, [{ season: long, date: day(-2) }]), long],
    [show({ title: 'O\'Neil "Q"', status: 'watching', tmdb_id: null }, [{ season: '<b>S1</b> & "x"', date: day(-2) }]), '&lt;b&gt;S1&lt;/b&gt; &amp; &quot;x&quot;']
  ];
  const app = await boot(all(...cases.map(c => c[0])));
  const got = shortcuts(app.el('tbody').innerHTML);
  for (const [s, label] of cases) {
    const b = got.find(x => x.show === s.show.id);
    assert.ok(b, `${s.show.title}: has a shortcut`);
    assert.strictEqual(b.text, `Mark ${label} watched`);
    assert.ok(b.onclick.endsWith(`toggleWatch('${s.rows[s.rows.length - 1].id}')`));
  }
  assert.ok(!app.el('tbody').innerHTML.includes('<b>S1</b>'), 'the label is escaped');
  assert.ok(app.html().includes('aria-label="Mark &lt;b&gt;S1&lt;/b&gt; &amp; &quot;x&quot; of O\'Neil &quot;Q&quot; watched"'), 'the accessible name is escaped (esc: & < > ")');
});

test('B2: an unaired up-next season shows "Not aired yet" and no shortcut', async () => {
  const a = show({ title: 'Later', status: 'watching' }, [{ num: 1, w: true, date: day(-300) }, { num: 2, date: day(-1) }, { num: 3, date: day(20) }]);
  const b = show({ title: 'Soon', status: 'watching' }, [{ num: 1, w: true, date: day(-300) }, { num: 2, date: day(-200), s: true }, { num: 3, date: day(-100), w: true }, { num: 4, tba: true }]);
  const app = await boot(all(a, b));
  app.ctx.switchView('alltv'); await settle();
  const got = shortcuts(app.el('tbody').innerHTML);
  assert.deepStrictEqual(got.map(x => x.text), ['Mark Season 2 watched'], 'only the aired up-next season gets a shortcut');
});

test('B2: with an active earlier-seasons range the shortcut names the range’s next season', async () => {
  const a = show({ title: 'Ranged', status: 'watching' }, [{ num: 1, date: day(-900) }, { num: 2, date: day(-800) }, { num: 3, w: true, date: day(-700) }, { num: 4, date: day(-10) }]);
  a.show.resume_start_season_id = a.rows[0].id;
  a.show.resume_end_season_id = a.rows[2].id;
  const app = await boot(all(a));
  const got = shortcuts(app.el('tbody').innerHTML);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].text, 'Mark Season 1 watched');
  assert.ok(got[0].onclick.endsWith(`toggleWatch('${a.rows[0].id}')`));
});

test('B2: the shortcut sends the same single set_season_watched request as before; season rows keep "Mark watched"', async () => {
  const a = show({ title: 'Same', status: 'watching' }, [{ num: 1, w: true, date: day(-50) }, { num: 2, date: day(-5) }]);
  const app = await boot(all(a));
  app.ctx.toggleWatch(a.rows[1].id); await settle();
  const w = app.writes();
  assert.strictEqual(w.length, 1);
  assert.ok(w[0].url.endsWith('/rpc/set_season_watched'));
  assert.deepStrictEqual(w[0].body, { p_row_id: a.rows[1].id, p_watched: true });
  app.ctx.switchView('alltv'); await settle();
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  assert.ok(app.el('tbody').innerHTML.includes(`toggleWatch('${a.rows[0].id}')">✓ Watched</button>`), 'a season row keeps its own labels');
});

test('B2: the shortcut style wraps the full label and never truncates it', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
  const rule = (css.match(/\.watch-btn\.show-shortcut\s*\{([^}]*)\}/) || [])[1] || '';
  assert.ok(/white-space:\s*normal/.test(rule), 'wraps (overrides .watch-btn nowrap)');
  assert.ok(!/ellipsis/.test(rule) && !/text-overflow:\s*ellipsis/.test(css.match(/show-shortcut[^}]*\}/g).join('')), 'no ellipsis');
});

T.run();
