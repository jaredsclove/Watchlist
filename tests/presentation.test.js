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
  assert.ok(app.el('viewHead').innerHTML.includes('<h2 class="visually-hidden">All Movies</h2>'), 'the heading stays for screen readers');
  assert.strictEqual(app.el('browseBar').innerHTML, '', 'S2: no Browse row in Movies');
  assert.ok(!app.el('browseBar').innerHTML.includes('openCatalogChooser('), 'S1: Catalog updates is on Settings, not in the Browse bar');
  assert.deepStrictEqual(app.writes(), []);
});

test('B9: All Movies keeps its filters, Unwatched-only default, actions and hidden Restore', async () => {
  const app = await boot(moviesLibrary());
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(app.el('fWatch').value, 'unwatched');
  assert.ok(app.el('filtersRow').innerHTML.includes("openLibraryPanel('movie')"));
  assert.ok(app.html().includes('toggleWatch('), 'the film actions are there');
  assert.strictEqual(app.el('restoreBtn'), null, 'S1: no Restore control outside Settings');
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
    assert.ok(app.el('tabBar').innerHTML.includes('class="tab active" aria-current="page" onclick="switchView(\'watching\')"'));
  }
});

test('B9: from a collection opened in Movies, Back and the Movies button both return to All Movies', async () => {
  const app = await boot(moviesLibrary());
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = 'watched'; app.ctx.renderTable();
  app.ctx.openBrowseCollection(app.browseId('sheridan')); await settle();
  assert.strictEqual(app.el('tabBar').hidden, true, 'still no secondary row in a collection opened from Movies');
  assert.ok(app.el('viewHead').innerHTML.includes('← Back to All Movies'));
  app.ctx.browseBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies');
  assert.strictEqual(app.el('fWatch').value, 'watched', 'Back puts the filters back');
  app.ctx.openBrowseCollection(app.browseId('sheridan')); await settle();
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies', 'the Movies button leaves the collection');
  assert.strictEqual(app.el('tabBar').hidden, true);
});

// ─── B2: the show-level shortcut reads Mark watched; its name and tooltip name the season ──
const shortcuts = html => [...html.matchAll(/<button class="watch-btn show-shortcut" data-shortcut-show="([^"]*)" aria-label="([^"]*)" title="([^"]*)" onclick="([^"]*)">([^<]*)<\/button>/g)]
  .map(m => ({ show: m[1], aria: m[2], title: m[3], onclick: m[4], text: m[5] }));

test('B2: Currently Watching and All TV: the show-level shortcut reads Mark watched and names the up-next season to assistive tech, in table and cards', async () => {
  const a = show({ title: 'Synthetic Neighbor Show', status: 'watching' }, [{ num: 1, date: day(-3) }]);
  for (const view of ['watching', 'alltv']) {
    const app = await boot(all(a));
    app.ctx.switchView(view); await settle();
    const rows = shortcuts(app.el('tbody').innerHTML), cards = shortcuts(app.el('cardList').innerHTML);
    assert.strictEqual(rows.length, 1, `${view}: one shortcut in the table`);
    assert.strictEqual(cards.length, 1, `${view}: one shortcut in the cards`);
    for (const s of [rows[0], cards[0]]) {
      assert.strictEqual(s.text, 'Mark watched');
      assert.strictEqual(s.aria, 'Mark watched: Season 1 of Synthetic Neighbor Show');
      assert.strictEqual(s.title, 'Mark Season 1 watched');
      assert.strictEqual(s.show, a.show.id);
      assert.ok(s.onclick.endsWith(`toggleWatch('${a.rows[0].id}')`));
    }
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
    assert.strictEqual(b.text, 'Mark watched');
    assert.strictEqual(b.aria, `Mark watched: ${label} of ${s.show.title.replace(/"/g, '&quot;')}`);
    assert.ok(b.onclick.endsWith(`toggleWatch('${s.rows[s.rows.length - 1].id}')`));
  }
  assert.ok(!app.el('tbody').innerHTML.includes('<b>S1</b>'), 'the label is escaped');
  assert.ok(app.html().includes('aria-label="Mark watched: &lt;b&gt;S1&lt;/b&gt; &amp; &quot;x&quot; of O\'Neil &quot;Q&quot;"'), 'the accessible name is escaped (esc: & < > ")');
});

test('B2: an unaired up-next season shows "Not aired yet" and no shortcut', async () => {
  const a = show({ title: 'Later', status: 'watching' }, [{ num: 1, w: true, date: day(-300) }, { num: 2, date: day(-1) }, { num: 3, date: day(20) }]);
  const b = show({ title: 'Soon', status: 'watching' }, [{ num: 1, w: true, date: day(-300) }, { num: 2, date: day(-200), s: true }, { num: 3, date: day(-100), w: true }, { num: 4, tba: true }]);
  const app = await boot(all(a, b));
  app.ctx.switchView('alltv'); await settle();
  const got = shortcuts(app.el('tbody').innerHTML);
  assert.deepStrictEqual(got.map(x => x.title), ['Mark Season 2 watched'], 'only the aired up-next season gets a shortcut');
});

test('B2: with an active earlier-seasons range the shortcut names the range’s next season', async () => {
  const a = show({ title: 'Ranged', status: 'watching' }, [{ num: 1, date: day(-900) }, { num: 2, date: day(-800) }, { num: 3, w: true, date: day(-700) }, { num: 4, date: day(-10) }]);
  a.show.resume_start_season_id = a.rows[0].id;
  a.show.resume_end_season_id = a.rows[2].id;
  const app = await boot(all(a));
  const got = shortcuts(app.el('tbody').innerHTML);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].title, 'Mark Season 1 watched');
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

// ─── B6: Currently Watching layout, "Next:" wording, keyboard and focus ──────
const tbody = app => app.el('tbody').innerHTML;
const cards = app => app.el('cardList').innerHTML;
const rowsOf = html => html.split('<tr').slice(1).map(x => '<tr' + x);
const showRowOf = (app, key) => rowsOf(tbody(app)).find(r => r.includes(`data-show-row="${key}"`));
const cardOf = (app, key) => { const c = cards(app); const i = c.indexOf(`<div class="item-card show-group-card" data-item="${key}" data-show-row="${key}"`); return i < 0 ? null : c.slice(i, c.indexOf('<div class="item-card', i + 10) > 0 ? c.indexOf('<div class="item-card', i + 10) : undefined); };
const cellCount = row => (row.match(/<td[\s>]/g) || []).length;

function cwLibrary() {
  const p = show({ title: 'Progress', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-3) }]);
  const u = show({ title: 'Current', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(40) }]);
  const none = show({ title: 'Nothing Left', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }]);
  const tba = show({ title: 'Plain TBA', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, tba: true }]);
  const text = show({ title: 'Text TBA', status: 'watching', tmdb_id: null }, [{ season: 'Season 1', w: true, date: day(-90) }, { season: 'Season 2', tba: true, display: '2026 (TBA)', date: '2026-01-01' }]);
  return { p, u, none, tba, text, data: all(p, u, none, tba, text) };
}

test('B6: Currently Watching has no Status column; collapsed rows and cards have no status control and priority only in ⋯', async () => {
  const { p, u, data } = cwLibrary();
  const app = await boot(data);
  assert.strictEqual(app.el('tableHead').innerHTML, '<tr><th>Show</th><th>Categories</th><th>Up next</th><th>Watched</th><th>Progress</th></tr>');
  for (const html of [tbody(app), cards(app)]) {
    assert.ok(!/\{ status: this\.value \}/.test(html), 'no status select while collapsed');
    assert.ok(html.split('<select').slice(1).every(s => s.startsWith(' class="priority-select')), 'the only selects are priority, in the menus');
    assert.ok(!html.includes('s-caughtup'), 'no Up to date pill in Currently Watching');
  }
  assert.strictEqual(cellCount(showRowOf(app, p.show.id)), 5, 'in progress: Show · Categories · Up next · Watched · Progress');
  const cu = showRowOf(app, u.show.id);
  assert.strictEqual(cellCount(cu), 3, 'caught up: Show · Categories · Up next (spanning)');
  assert.ok(cu.includes('<td class="date-cell" colspan="3">'));
  assert.ok(!/watched<\/td>|mini-progress|confirmed-lbl">—/.test(cu), 'caught up: no progress, no count, no "—"');
});

test('B6: headings: In progress (focusable, not collapsible) and Caught up (a real toggle button); empty-state wording', async () => {
  const { data } = cwLibrary();
  const app = await boot(data);
  const html = tbody(app);
  assert.ok(html.includes('<th colspan="5" scope="colgroup" tabindex="-1" data-section="inprogress">In progress'), 'spans the five columns');
  assert.ok(/<button type="button" class="section-toggle" data-section="uptodate" aria-expanded="true" onclick="toggleDerivedSection\('uptodate'\)">[^]*Caught up/.test(html));
  assert.ok(!/Up to date/.test(html), 'the section is Caught up');
  assert.ok(cards(app).includes('<h3 class="derived-section-card derived-heading-card" tabindex="-1" data-section="inprogress">In progress'));
  app.ctx.toggleDerivedSection('uptodate'); await settle();
  assert.ok(tbody(app).includes('data-section="uptodate" aria-expanded="false"'));
  // only caught-up shows: the In progress message uses the new wording and can take focus
  const only = show({ title: 'Only', status: 'watching' }, [{ num: 1, w: true, date: day(-9) }]);
  const app2 = await boot(all(only));
  assert.ok(tbody(app2).includes('tabindex="-1" data-empty="1">Nothing in progress. Every Watching show is caught up.'));
});

test('B6: next-season wording: no "Next:" prefix in Currently Watching, All TV or collections; TBA forms; No upcoming season listed', async () => {
  const { p, u, none, tba, text, data } = cwLibrary();
  data.shows.forEach(s => { s.collection = 'disney'; s.tmdb_id = s.tmdb_id && s.tmdb_id + 5000; });
  data.rows.forEach(r => { r.collection = 'disney'; if (r.tmdb_id) r.tmdb_id += 5000; });
  const app = await boot(data);
  const check = (label) => {
    const h = tbody(app) + cards(app);
    assert.ok(!/Next: |Up next: |premiere date TBA|No new season on your list yet/.test(h), `${label}: no old wording`);
    assert.ok(h.includes(`Season 2 · ${disp(day(-3))}`), `${label}: in progress`);
    assert.ok(h.includes(`Season 2 · ${disp(day(40))}<span class="upcoming-tag">Upcoming`), `${label}: future`);
    assert.ok(h.includes('Season 2 · Date TBA'), `${label}: a plain TBA reads Date TBA`);
    assert.ok(h.includes('Season 2 · 2026 (TBA)'), `${label}: stored TBA text is kept`);
    assert.ok(h.includes('No upcoming season listed'), `${label}: nothing remaining`);
  };
  check('Currently Watching');
  app.ctx.switchView('alltv'); await settle();
  check('All TV');
  app.ctx.openBrowseCollection(app.browseId('disney')); await settle();
  check('collection');
  assert.ok(app.el('tableHead').innerHTML.includes('<th>Next / Release</th>'), 'headings unchanged');
});

test('B6 (decision 6): the hidden "Next season: " is only on phone cards, only before an actual next-season value', async () => {
  const { data } = cwLibrary();
  const ended = show({ title: 'Ended Show', status: 'watching', ended: true }, [{ num: 1, w: true, date: day(-90) }]);
  const skipped = show({ title: 'All Skipped', status: 'watching' }, [{ num: 1, s: true, date: day(-90) }]);
  const other = show({ title: 'Nothing Remaining', status: 'confirmed' }, [{ num: 1, w: true, date: day(-90) }]);
  const d = all(...[data].flatMap(x => []), ended, skipped, other);
  d.rows.push(...data.rows); d.shows.push(...data.shows);
  const app = await boot(d);
  const SR = '<span class="visually-hidden">Next season: </span>';
  for (const view of ['watching', 'alltv']) {
    app.ctx.switchView(view); await settle();
    assert.ok(!tbody(app).includes(SR), `${view}: not in desktop cells (the column heading says it)`);
    const lines = [...cards(app).matchAll(/<span class="card-season">([^]*?)<\/span>\s*<\/div>/g)].map(m => m[1]);
    assert.ok(lines.length >= 5);
    for (const l of lines) {
      const actual = /^(<span class="visually-hidden">Next season: <\/span>)?Season \d+ · /.test(l);
      assert.strictEqual(l.startsWith(SR), actual, `${view}: "${l.slice(0, 80)}"`);
    }
    for (const status of ['No upcoming season listed', 'No remaining season on your list', 'Caught up · Ended', 'All seasons skipped']) {
      assert.ok(!cards(app).includes(SR + status) && !cards(app).includes(SR + `<span title="Based on the seasons stored in your list. New seasons are added with + Add (Refresh shows or Add season) or by Catalog updates.">${status}`)
        && !cards(app).includes(`${SR}<span class="caught-ended">${status}`) && !cards(app).includes(`${SR}<span class="confirmed-lbl">${status}`), `${view}: never before "${status}"`);
    }
  }
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(/\.visually-hidden \{[^}]*clip: rect\(0 0 0 0\)/.test(css));
});

test('B6: the expanded show has the labelled Status select, a progress line and the existing actions, each with a focus hook', async () => {
  const s = show({ title: 'Full', status: 'watching', priority: 'high', catalog_new: true, status_review: true, ended: true },
    [{ num: 1, date: day(-900) }, { num: 2, w: true, date: day(-800) }, { num: 3, date: day(-10) }, { num: 4, date: day(30) }, { num: 5, s: true, date: day(-5) }]);
  const app = await boot(all(s));
  const row = showRowOf(app, s.show.id), card = cardOf(app, s.show.id);
  for (const [where, h] of [['row', row], ['card', card]]) {
    assert.ok(h.includes('class="priority-high"'), `${where}: ★ High in the title`);
    assert.ok(h.includes('ended-tag') && h.includes('new-tag') && h.includes('review-tag-b45'), `${where}: Ended, New, Review status tags`);
    // ("N earlier seasons unwatched" is shown today only beside "Caught up · Ended", which Currently Watching never lists; unchanged.)
    assert.ok(!h.includes('earlier season unwatched'), `${where}: no gap note added`);
    assert.ok(h.includes('Marked ended, but an upcoming season is listed'), `${where}: the ended note`);
    assert.ok(h.includes('data-filter-kind') || h.includes('class="badge'), `${where}: categories / Original label`);
  }
  app.ctx.toggleDerivedShow(s.show.id); await settle();
  for (const [where, h] of [['table', tbody(app)], ['cards', cards(app)]]) {
    assert.ok(h.includes('<label class="state-field" data-action="status"><span class="state-field-label">Status</span> <select'), `${where}: Status`);
    assert.ok(h.includes('<option value="" selected disabled>Choose a status…</option>'), `${where}: review starts on Choose a status…`);
    assert.ok(!h.includes('<label class="state-field" data-action="priority">'), `${where}: priority is in ⋯`);
    assert.ok(h.includes(`setShowStateById('${s.show.id}', { status: this.value })`) && h.includes(`setShowStateById('${s.show.id}', { priority: this.value })`), `${where}: the same writes as All TV's selects`);
    for (const a of ['details', 'ended', 'dismiss-new', 'keep-status', 'open-resume']) assert.ok(h.includes(`data-action="${a}"`), `${where}: ${a}`);
  }
  assert.ok(tbody(app).includes('<span class="show-progress-line">1 of 4 seasons watched · 1 skipped</span>'), 'desktop: progress line');
  assert.ok(tbody(app).includes(`data-show-of="${s.show.id}"`) && tbody(app).includes(`data-season-row="${s.rows[0].id}"`), 'focus hooks on the actions row and seasons');
  // the expanded seasons keep Watched before Skip / Keep under the five headings
  const sub = rowsOf(tbody(app)).find(r => r.includes(`data-season-row="${s.rows[2].id}"`));
  assert.strictEqual(cellCount(sub), 5);
  assert.ok(sub.indexOf(`toggleWatch('${s.rows[2].id}')`) < sub.indexOf(`setSeasonSkipped('${s.rows[2].id}'`));
});

test('B6: the status written from the expanded show is the same guarded call; review and ended rules unchanged', async () => {
  const s = show({ title: 'Move', status: 'watching' }, [{ num: 1, date: day(-3) }]);
  const app = await boot(all(s));
  app.ctx.toggleDerivedShow(s.show.id); await settle();
  await app.ctx.setShowStateById(s.show.id, { status: 'confirmed' }); await settle();
  const w = app.writes();
  assert.strictEqual(w.length, 1);
  assert.ok(w[0].url.endsWith('/rpc/library_set_show_state_b45'));
  assert.deepStrictEqual(w[0].body.p_changes, { status: 'confirmed' });
});

test('B6: phone cards: in progress = title, season, categories, progress, shortcut; caught up collapsed = title and season only', async () => {
  const { p, u, data } = cwLibrary();
  const app = await boot(data);
  const c = cardOf(app, p.show.id);
  const at = s => c.indexOf(s);
  assert.ok(at('card-title') < at('card-season') && at('card-season') < at('card-meta') && at('card-meta') < at('1/2 seasons watched') && at('mini-progress') < at('show-shortcut'), 'in-progress order');
  assert.ok(c.includes('<div class="card-actions shortcut-actions"'));
  const cu = cardOf(app, u.show.id);
  assert.ok(!cu.includes('card-meta') && !cu.includes('mini-progress') && !cu.includes('watched</span>'), 'caught up collapsed: no categories, no progress');
  app.ctx.toggleDerivedShow(u.show.id); await settle();
  const ex = cardOf(app, u.show.id);
  assert.ok(ex.includes('card-meta') && ex.includes('1 of 2 seasons watched'), 'expanded: categories and progress text');
  assert.ok(ex.indexOf('card-meta') < ex.indexOf('show-actions-state') && ex.indexOf('show-actions-state') < ex.indexOf('data-season-row'), 'expanded order: categories, actions, seasons');
});

test('B6: expand buttons: one per show row and card, labelled, aria-expanded, stopping the event; one activation toggles once', async () => {
  const { p, data } = cwLibrary();
  for (const view of ['watching', 'alltv']) {
    const app = await boot(data);
    app.ctx.switchView(view); await settle();
    const btn = `<button type="button" class="expand-btn" data-show-key="${p.show.id}" data-primary="1" aria-expanded="false" aria-label="Show seasons and actions of Progress" onclick="event.stopPropagation(); toggleDerivedShow('${p.show.id}')">`;
    assert.ok(showRowOf(app, p.show.id).includes(btn), `${view}: row`);
    assert.ok(cardOf(app, p.show.id).includes(btn), `${view}: card`);
    // A click that started on a control inside the row belongs to that control.
    const inner = { target: { closest: sel => (sel.includes('button') ? {} : null) } };
    app.ctx.toggleDerivedShow(p.show.id, inner); await settle();
    assert.ok(!app.get('expandedShows').has(p.show.id), `${view}: a click on an inner control doesn't toggle`);
    const plain = { target: { closest: () => null } };
    app.ctx.toggleDerivedShow(p.show.id, plain); await settle();
    assert.ok(app.get('expandedShows').has(p.show.id), `${view}: a click on the row toggles once`);
    app.ctx.toggleDerivedShow(p.show.id); await settle();
    assert.ok(!app.get('expandedShows').has(p.show.id), `${view}: the button (no event) toggles once`);
    assert.deepStrictEqual(app.writes(), []);
  }
});

test('B6: Coming Soon and All TV Seasons section toggles are real buttons', async () => {
  const s = show({ title: 'Soon', status: 'confirmed' }, [{ num: 1, date: day(3) }, { num: 2, tba: true }]);
  const app = await boot(all(s));
  app.ctx.switchView('comingsoon'); await settle();
  assert.ok(tbody(app).includes('<button type="button" class="section-toggle" data-section="tba" aria-expanded="false"'));
  app.ctx.switchView('alltv'); await settle();
  app.ctx.setAllTvPresentation('seasons'); await settle();
  assert.ok(tbody(app).includes('<button type="button" class="section-toggle" data-section="alltvTba" aria-expanded="false"'));
  assert.ok(!/<tr class="derived-section-row" onclick=/.test(tbody(app)), 'the row itself is not the control');
});

test('B6: the sections drawn equal the derivation (membership unchanged) across a state matrix', async () => {
  const shows = [
    show({ title: 'A In progress', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-2) }]),
    show({ title: 'B Future', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(9) }]),
    show({ title: 'C TBA', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, tba: true }]),
    show({ title: 'D None', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }]),
    show({ title: 'E Ended exit', status: 'watching', ended: true }, [{ num: 1, w: true, date: day(-90) }]),
    show({ title: 'F All skipped', status: 'watching' }, [{ num: 1, s: true, date: day(-90) }]),
    show({ title: 'G Review', status: 'watching', status_review: true }, [{ num: 1, date: day(-90) }]),
    show({ title: 'H New Low', status: 'watching', catalog_new: true, priority: 'low' }, [{ num: 1, date: day(-90) }]),
    show({ title: 'I To Watch', status: 'confirmed' }, [{ num: 1, date: day(-90) }])
  ];
  const r = show({ title: 'J Range', status: 'watching' }, [{ num: 1, date: day(-900) }, { num: 2, w: true, date: day(-800) }]);
  r.show.resume_start_season_id = r.rows[0].id; r.show.resume_end_season_id = r.rows[1].id;
  const app = await boot(all(...shows, r));
  const d = app.ctx.deriveCurrentlyWatching(app.get('derivedData').rows, app.get('tvShowsById'), day(0));
  const drawn = sec => rowsOf(tbody(app)).filter(x => x.includes(`data-row-section="${sec}"`)).map(x => x.match(/data-show-row="([^"]*)"/)[1]);
  assert.deepStrictEqual(drawn('inprogress'), Array.from(d.active, x => x.key));
  assert.deepStrictEqual(drawn('uptodate'), Array.from(d.upToDate, x => x.key));
  const titles = rowsOf(tbody(app)).map(x => (x.match(/show-title">([^<]*)</) || [])[1]).filter(Boolean);
  assert.ok(!titles.includes('E Ended exit') && !titles.includes('F All skipped') && !titles.includes('I To Watch'));
  assert.ok(titles.includes('J Range') && titles.includes('G Review') && titles.includes('H New Low'));
});

test('B6: the focus chain F-1 … F-7 (pure): every transition picks one visible, focusable target in order', async () => {
  const app = await boot(all());
  const F = (rec, listing, present = () => false) => JSON.parse(JSON.stringify(app.ctx.focusChainTarget(rec, listing, present)));
  const L = (ip, cu, cuOpen = true) => ({ sections: [
    { name: 'inprogress', shown: true, open: true, heading: true, keys: ip },
    { name: 'uptodate', shown: cu.length > 0, open: cuOpen, heading: true, keys: cu }] });
  const rec = (key, section, hook, next = [], prev = []) => ({ container: 'tbody', key, section, hook, next, prev, loading: false });
  const sel = { kind: 'action', value: 'status', show: 'a' };
  // T1, F-1: the same control is still there
  assert.deepStrictEqual(F(rec('a', 'inprogress', sel), L(['a'], []), t => t.kind === 'action'), sel);
  // T2, F-2: still in progress, the shortcut now names the next season (a new control)
  const sc = { kind: 'shortcut', value: 'a' };
  assert.deepStrictEqual(F(rec('a', 'inprogress', sc), L(['a'], []), t => t.kind === 'shortcut' && t.value === 'a' && false || (t.kind === 'shortcut')), sc);
  assert.deepStrictEqual(F(rec('a', 'inprogress', { kind: 'action', value: 'details', show: 'a' }), L(['a'], []), t => t.kind === 'shortcut'), sc);
  // T3: it moved into an open Caught up (its expand button), or a collapsed one (the toggle)
  assert.deepStrictEqual(F(rec('a', 'inprogress', sc, ['b']), L(['b'], ['a'])), { kind: 'item', value: 'a' });
  assert.deepStrictEqual(F(rec('a', 'inprogress', sc, ['b']), L(['b'], ['a'], false)), { kind: 'section', value: 'uptodate' });
  // T4, F-5: it left; the next neighbour, else the previous one
  assert.deepStrictEqual(F(rec('b', 'inprogress', sel, ['c'], ['a']), L(['a', 'c'], [])), { kind: 'item', value: 'c' });
  assert.deepStrictEqual(F(rec('c', 'inprogress', sel, [], ['b', 'a']), L(['a', 'b'], [])), { kind: 'item', value: 'b' });
  // a neighbour only in another section isn't used
  assert.deepStrictEqual(F(rec('c', 'uptodate', sel, ['x'], []), L(['x', 'p'], ['y'])), { kind: 'section', value: 'uptodate' });
  // T5, F-7: the only Caught up show left (the section is gone at 0): the first heading, In progress
  assert.deepStrictEqual(F(rec('u', 'uptodate', sel), L(['p'], [])), { kind: 'section', value: 'inprogress' });
  // T6, F-6: the last In progress show left while Caught up still lists shows: the In progress heading (not F-4)
  assert.deepStrictEqual(F(rec('p', 'inprogress', sel), L([], ['u'])), { kind: 'section', value: 'inprogress' });
  // T7a, F-4: the view is empty: the empty-state message, never the always-present heading
  assert.deepStrictEqual(F(rec('p', 'inprogress', sel), L([], [])), { kind: 'empty' });
  assert.deepStrictEqual(F(rec('p', 'inprogress', sel, ['q']), L([], [])), { kind: 'empty' });
  // T8: after a reload (the loading message was focused; it is gone): the same rules
  const reload = rec(null, null, { kind: 'loading', value: '1' });
  assert.deepStrictEqual(F(reload, L([], [])), { kind: 'empty' });
  assert.deepStrictEqual(F(reload, L(['p'], [])), { kind: 'section', value: 'inprogress' });
  // All TV: one list without a heading; F-6 / F-7 fall back to its first listed show
  const allTv = keys => ({ sections: [{ name: 'all', shown: true, open: true, heading: false, keys }] });
  assert.deepStrictEqual(F(rec('a', 'all', sel, ['b']), allTv(['b', 'c'])), { kind: 'item', value: 'b' });
  assert.deepStrictEqual(F(rec('a', 'all', sel), allTv(['c'])), { kind: 'item', value: 'c' });
  assert.deepStrictEqual(F(rec('a', 'all', sel), allTv([])), { kind: 'empty' });
  // no listing (Coming Soon, Seasons): only F-1
  assert.strictEqual(app.ctx.focusChainTarget(rec('a', 'all', sel), null, () => false), null);
});

test('B6: filter redraws never use the focus chain: focus in the filter row, or on a filter pill, is not recorded', async () => {
  const { data } = cwLibrary();
  const app = await boot(data);
  const fake = (inList, pill) => ({ closest: sel => (sel === '#tbody' && inList) ? {} : (sel === '.filter-pill' && pill) ? {} : null });
  app.ctx.document.activeElement = fake(false, false); // Search, a filter select, Back
  assert.strictEqual(app.ctx.captureListFocus(), null);
  app.ctx.document.activeElement = fake(true, true);   // a filter pill in the list (render.js keeps its own rule)
  assert.strictEqual(app.ctx.captureListFocus(), null);
  delete app.ctx.document.activeElement;
});

test('B6: loading and failure messages carry their focus hooks (loading message focusable, Retry marked)', async () => {
  const { data } = cwLibrary();
  const app = await boot(data);
  const g = app.hold(r => r.method === 'GET' && r.url.includes('/tv_shows'));
  app.ctx.switchView('alltv'); await g.reached; // a first read (a shown list is read again in place)
  assert.ok(tbody(app).includes('class="loading" tabindex="-1" data-loading="1">Loading…'));
  assert.ok(cards(app).includes('class="loading" tabindex="-1" data-loading="1">Loading…'));
  g.fail(); await settle();
  assert.ok(tbody(app).includes('<button class="btn" data-retry="1" onclick="loadDerivedView()">Retry</button>'));
});

// ─── B8: compact counts ───────────────────────────────────────────────────────
const line = app => (app.el('statsRow').innerHTML.match(/^<p class="count-line">([^<]*)<\/p>$/) || [])[1];
const setFilter = (app, id, value) => { app.el(id).value = value; app.ctx.renderTable(); };

test('B8: no statistics tile in any view; one count line or the section headings instead', async () => {
  const { data } = cwLibrary();
  data.rows.push(film({ title: 'A Film', collection: 'disney' }));
  data.shows[0].collection = 'disney'; data.rows.filter(r => r.show_id === data.shows[0].id).forEach(r => { r.collection = 'disney'; });
  const app = await boot(data);
  const views = [['watching', ''], ['alltv', 'line'], ['comingsoon', 'line'], ['allmovies', 'line']];
  for (const [v, kind] of views) {
    app.ctx.switchView(v); await settle();
    assert.ok(!/class="stat"|stat-num|stat-label/.test(app.el('statsRow').innerHTML + app.html()), `${v}: no tile`);
    if (kind) assert.ok(line(app), `${v}: one count line`); else assert.strictEqual(app.el('statsRow').innerHTML, '');
  }
  app.ctx.switchView('alltv'); await settle(); app.ctx.setAllTvPresentation('seasons'); await settle();
  assert.ok(/^\d+ seasons? from \d+ shows?$/.test(line(app)));
  app.ctx.openBrowseCollection(app.browseId('disney')); await settle();
  assert.strictEqual(app.el('statsRow').innerHTML, '', 'a collection: counts in its section headings');
  assert.ok(!/stat-num/.test(app.html()));
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(!/\.stat\b|\.stat-num|\.stat-label/.test(css), 'the tile styles are gone');
});

test('B8: Currently Watching headings: shows with their unit, "N of T" only when filters narrow; Caught up kept at 0 of T; zero states', async () => {
  const a = show({ title: 'Alpha', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-3) }]);
  const b = show({ title: 'Bravo', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-4) }]);
  const c = show({ title: 'Charlie', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }]);
  const app = await boot(all(a, b, c));
  const h = () => tbody(app);
  assert.ok(h().includes('In progress <span class="section-count">· 2 shows</span>'));
  assert.ok(h().includes('Caught up <span class="section-count">· 1 show</span>'));
  setFilter(app, 'fSearch', 'alpha');
  assert.ok(h().includes('In progress <span class="section-count">· 1 of 2 shows</span>'));
  assert.ok(h().includes('Caught up <span class="section-count">· 0 of 1 show</span>'), 'Caught up stays, at 0 of 1');
  assert.ok(h().includes('No caught-up shows match your filters.'));
  setFilter(app, 'fSearch', 'zzz');
  assert.ok(h().includes('In progress <span class="section-count">· 0 of 2 shows</span>') && h().includes('No in-progress shows match your filters.'));
  setFilter(app, 'fSearch', '');
  assert.strictEqual(app.el('statsRow').innerHTML, '', 'no count line in Currently Watching');
  const empty = await boot(all());
  assert.ok(tbody(empty).includes('In progress <span class="section-count">· 0 shows</span>') && tbody(empty).includes('Nothing is marked Watching yet.'));
  assert.ok(!tbody(empty).includes('Caught up'), 'Caught up hidden when it has no shows at all');
  const onlyCu = await boot(all(c));
  assert.ok(tbody(onlyCu).includes('In progress <span class="section-count">· 0 shows</span>') && tbody(onlyCu).includes('Every Watching show is caught up.'));
});

test('B8: All TV Shows: "N of T shows" (T: every show with a linked season, all statuses) · those listed that are Watching and up to date; zero states', async () => {
  const w = show({ title: 'Watch', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(30) }]);
  const t = show({ title: 'ToWatch', status: 'confirmed' }, [{ num: 1, date: day(-9) }]);
  const s = show({ title: 'Skip', status: 'skipped' }, [{ num: 1, date: day(-9) }]);
  const app = await boot(all(w, t, s));
  app.ctx.switchView('alltv'); await settle();
  assert.strictEqual(line(app), '2 of 3 shows · 1 Watching · 1 up to date', 'the Skipped default narrows it');
  setFilter(app, 'fStatus', 'all');
  assert.strictEqual(line(app), '3 shows · 1 Watching · 1 up to date');
  setFilter(app, 'fSearch', 'zzz');
  assert.strictEqual(line(app), '0 of 3 shows', 'no breakdown at 0');
  assert.ok(tbody(app).includes('No shows match your filters.'));
  const before = app.requests.length;
  setFilter(app, 'fSearch', '');
  assert.strictEqual(app.requests.length, before, 'a filter change makes no request');
  const none = await boot(all());
  none.ctx.switchView('alltv'); await settle();
  assert.strictEqual(line(none), '0 shows');
  assert.ok(tbody(none).includes('No TV shows on your list yet.'));
});

test('B8: All TV Seasons: "N seasons from K shows"; the TBA / no date heading carries units; zero', async () => {
  const a = show({ title: 'A', status: 'confirmed' }, [{ num: 1, date: day(-90) }, { num: 2, tba: true }, { num: 3, date: '2024-13-40', display: 'Someday' }]);
  const b = show({ title: 'B', status: 'confirmed' }, [{ num: 1, date: day(-80) }]);
  const app = await boot(all(a, b));
  app.ctx.switchView('alltv'); await settle(); app.ctx.setAllTvPresentation('seasons'); await settle();
  assert.strictEqual(line(app), '4 seasons from 2 shows');
  assert.ok(tbody(app).includes('TBA / no date <span class="section-count">· 1 TBA season · 1 season needs a date review</span>'));
  setFilter(app, 'fSearch', 'zzz');
  assert.strictEqual(line(app), '0 seasons');
});

test('B8: Coming Soon: dated seasons (of every eligible dated season) · those in the next 30 days; the TBA heading has units', async () => {
  const a = show({ title: 'Alpha', status: 'confirmed' }, [{ num: 1, date: day(5) }, { num: 2, date: day(90) }, { num: 3, tba: true }]);
  const b = show({ title: 'Bravo', status: 'confirmed' }, [{ num: 1, date: day(10) }, { num: 2, tba: true }]);
  const app = await boot(all(a, b));
  app.ctx.switchView('comingsoon'); await settle();
  assert.strictEqual(line(app), '3 dated seasons · 2 in the next 30 days');
  assert.ok(tbody(app).includes('TBA <span class="section-count">· 2 seasons</span>'));
  setFilter(app, 'fSearch', 'alpha');
  assert.strictEqual(line(app), '2 of 3 dated seasons · 1 in the next 30 days');
  assert.ok(tbody(app).includes('TBA <span class="section-count">· 1 of 2 seasons</span>'));
  setFilter(app, 'fSearch', 'zzz');
  assert.strictEqual(line(app), '0 of 3 dated seasons');
  assert.ok(tbody(app).includes('No dated entries match your filters.') && !tbody(app).includes('section-toggle" data-section="tba"'));
  const none = await boot(all());
  none.ctx.switchView('comingsoon'); await settle();
  assert.strictEqual(line(none), '0 dated seasons');
});

test('B8 (decision 13): All Movies: "N of T films" (T: every saved film) · library: watched, unwatched; zero', async () => {
  const data = all(film({ title: 'A' }), film({ title: 'B', watched: true }), film({ title: 'C', status: 'skipped' }), film({ title: 'D', status: 'skipped', watched: true }));
  const app = await boot(data);
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(line(app), '1 of 4 films · library: 2 watched, 2 unwatched', 'defaults: Unwatched only, Skipped hidden');
  setFilter(app, 'fWatch', ''); setFilter(app, 'fStatus', 'all');
  assert.strictEqual(line(app), '4 films · library: 2 watched, 2 unwatched');
  setFilter(app, 'fSearch', 'zzz');
  assert.strictEqual(line(app), '0 of 4 films · library: 2 watched, 2 unwatched');
  assert.ok(app.html().includes('No films match these filters.'));
  const none = await boot(all());
  none.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(line(none), '0 films');
  assert.ok(none.html().includes('No films saved yet.'));
});

test('B8: collection headings: shows and films "N of T" when narrowed, season entries without a total; Combined; zero', async () => {
  const a = show({ title: 'Andor', status: 'confirmed', collection: 'disney' }, [{ num: 1, date: day(-90) }, { num: 2, date: day(-50) }]);
  const b = show({ title: 'Bluey', status: 'confirmed', collection: 'disney' }, [{ num: 1, date: day(-80) }]);
  const data = all(a, b, film({ title: 'Fly', collection: 'disney', media_type: null, tmdb_id: null }));
  const app = await boot(data);
  app.ctx.openBrowseCollection(app.browseId('disney')); await settle();
  const h = () => tbody(app);
  assert.ok(h().includes('TV <span class="section-count">· 2 shows · 3 season entries</span>'));
  assert.ok(h().includes('Movies <span class="section-count">· 1 film</span>'));
  setFilter(app, 'fSearch', 'andor');
  assert.ok(h().includes('TV <span class="section-count">· 1 of 2 shows · 2 season entries</span>'));
  assert.ok(h().includes('Movies <span class="section-count">· 0 of 1 film</span>') && h().includes('No films match these filters.'));
  app.ctx.setBrowseGrouping('combined'); await settle();
  assert.ok(h().includes('All media <span class="section-count">· 1 of 2 shows · 2 season entries · 0 of 1 film</span>'));
  const empty = await boot(all(film({ title: 'Only', collection: 'sheridan' })));
  empty.ctx.openBrowseCollection(empty.browseId('sheridan')); await settle();
  assert.ok(tbody(empty).includes('TV <span class="section-count">· 0 shows · 0 season entries</span>') && tbody(empty).includes('No TV shows in Sheridan.'));
});

test('B8: while a first read loads and after it failed no count is shown; a reread keeps the count apart from its status line', async () => {
  const { data } = cwLibrary();
  const app = await boot(data);
  const g = app.hold(r => r.method === 'GET' && r.url.includes('/tv_shows'));
  app.ctx.switchView('alltv'); await g.reached;
  assert.strictEqual(app.el('statsRow').innerHTML, '', 'loading: no count');
  g.fail(); await settle();
  assert.strictEqual(app.el('statsRow').innerHTML, '', 'failed: no count');
  app.ctx.loadDerivedView(); await settle();
  const shown = line(app);
  assert.ok(shown);
  // Batch A: a reread of the shown list keeps it and its count; the status line is separate.
  const g1 = app.hold(r => r.method === 'GET' && r.url.includes('/tv_shows'));
  app.ctx.loadDerivedView(); await g1.reached;
  assert.strictEqual(line(app), shown, 'reread: the count stays');
  assert.ok(app.el('readStatus').innerHTML.includes('Reading the list again'));
  app.el('fSearch').value = 'x'; app.ctx.renderTable(); // typing during the reread doesn't overwrite its status line
  assert.ok(app.el('readStatus').innerHTML.includes('Reading the list again'));
  g1.fail(); await settle();
  assert.ok(app.el('readStatus').innerHTML.includes('couldn’t be read again') && app.el('readStatus').innerHTML.includes('Retry'));
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(app.el('readStatus').innerHTML, '', 'another view clears it');
  app.ctx.switchMediaType('tv'); await settle();
  const g2 = app.hold(r => r.method === 'GET' && r.url.includes('/tv_shows'));
  app.ctx.switchMediaType('movie'); await g2.reached;
  assert.strictEqual(app.el('statsRow').innerHTML, '', 'All Movies loading: no count');
  g2.fail(); await settle();
  assert.strictEqual(app.el('statsRow').innerHTML, '', 'All Movies failed: no count');
});

// ─── B6 correction batch: focus across real redraws (test-only DOM) ───────────
// The test-only DOM (makeMiniDom) lives in tests/mini-dom.js since S3 (moved unchanged).
const { makeMiniDom } = require('./mini-dom');
const desc = n => (n ? `${n.tag}${Object.entries(n.attrs).filter(([k]) => k.startsWith('data-') || k === 'class').map(([k, v]) => `[${k}=${v}]`).join('')}` : 'null');

test('correction 1: a later focus change by the owner wins: a key or pointer on the placed element, or focus moved outside the list', async () => {
  const a = show({ title: 'Alpha', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-3) }, { num: 3, date: day(40) }]);
  const b = show({ title: 'Bravo', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-4) }]);
  for (const move of ['keydown', 'pointerdown', 'outside']) {
    const app = await boot(all(a, b));
    const dom = makeMiniDom(app);
    dom.focus('tbody', `[data-shortcut-show="${a.show.id}"]`);
    const g = app.hold(r => r.url.endsWith('/rpc/set_season_watched'));
    app.ctx.toggleWatch(a.rows[1].id); await g.reached;
    const placed = dom.active();
    let outside = null;
    if (move === 'outside') outside = dom.outside(); else placed.dispatch(move);
    g.refuseWith('P0002', 'not_found: TV season'); await settle(); // S3-D2 B: a refusal (an unclear answer now reads the view again)
    if (move === 'outside') assert.strictEqual(dom.active(), outside, 'focus outside the list is never taken back');
    else assert.strictEqual(desc(dom.active()), desc(placed), `${move}: the owner's element (its redrawn equivalent) keeps focus, not the old shortcut`);
  }
});

test('correction 1: the status select’s target survives the optimistic redraw and the answer (All TV and the expanded Currently Watching show)', async () => {
  const a = show({ title: 'Alpha', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-3) }]);
  const b = show({ title: 'Bravo', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-4) }]);
  // Currently Watching: status → To Watch takes Alpha out; focus goes to the next show and stays
  // there through the answer (it is the original action's place, F-5).
  const app = await boot(all(a, b));
  const dom = makeMiniDom(app);
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  dom.focus('tbody', `[data-show-of="${a.show.id}"] [data-action="status"] select`);
  await app.ctx.setShowStateById(a.show.id, { status: 'confirmed' }); await settle();
  assert.strictEqual(dom.active(), dom.in('tbody', `[data-item="${b.show.id}"] [data-primary]`), 'F-5: Bravo’s expand button');
  // All TV: a priority change (the menu closes first) keeps the same row's ⋯ (identity, not position).
  const app2 = await boot(all(a, b));
  const dom2 = makeMiniDom(app2);
  app2.ctx.switchView('alltv'); await settle();
  dom2.focus('tbody', `[data-item="${a.show.id}"] [data-action="more"]`);
  await app2.ctx.setShowStateById(a.show.id, { priority: 'high' }); await settle();
  assert.strictEqual(dom2.active(), dom2.in('tbody', `[data-item="${a.show.id}"] [data-action="more"]`));
});

test('correction 2: season actions are found by identity (season + action), never by their position among controls', async () => {
  const s = show({ title: 'Ident', status: 'confirmed', tmdb_id: null, collection: 'othertv' }, [{ season: 'Season 1', date: day(-50) }, { season: 'Season 2', date: day(-40) }]);
  const app = await boot(all(s));
  const dom = makeMiniDom(app);
  app.ctx.switchView('alltv'); await settle();
  app.ctx.toggleDerivedShow(s.show.id); await settle();
  const row = dom.in('tbody', `[data-season-row="${s.rows[0].id}"]`);
  const actions = row.querySelectorAll('[data-action]').map(x => x.attrs['data-action']);
  assert.deepStrictEqual(actions, ['season-match', 'season-control', 'season-watch', 'season-delete'], 'every control has a stable identity');
  // Skip the season: its Watched control turns into "—" (a control disappears) and Skip becomes Keep.
  dom.focus('tbody', `[data-season-row="${s.rows[0].id}"] [data-action="season-control"] button`);
  await app.ctx.setSeasonSkipped(s.rows[0].id, true); await settle();
  assert.strictEqual(dom.active(), dom.in('tbody', `[data-season-row="${s.rows[0].id}"] [data-action="season-control"] button`), 'the same season’s Skip / Keep');
  assert.ok(/Keep/.test(app.el('tbody').innerHTML.split(`data-season-row="${s.rows[0].id}"`)[1].split('</tr>')[0]));
  // The same identities on the phone cards and in Currently Watching's five-cell rows.
  assert.ok(app.el('cardList').innerHTML.includes(`data-season-row="${s.rows[1].id}" data-show-of="${s.show.id}"`));
  assert.ok(app.el('cardList').innerHTML.includes('data-action="season-control"') && app.el('cardList').innerHTML.includes('data-action="season-watch"'));
  // All TV's row selects have identities too.
  assert.ok(app.el('tbody').innerHTML.includes('<span class="state-action" data-action="status"><select') && app.el('tbody').innerHTML.includes('<span class="state-action" data-action="priority"><select'));
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(/\.season-action, \.state-action \{ display: contents; \}/.test(css), 'the wrappers add no box');
});

test('correction 3: Coming Soon: skipping moves focus to the next season, then (dated only) the empty-state message; or the TBA toggle', async () => {
  const a = show({ title: 'Alpha', status: 'confirmed' }, [{ num: 1, date: day(5) }, { num: 2, date: day(9) }]);
  const app = await boot(all(a));
  const dom = makeMiniDom(app);
  app.ctx.switchView('comingsoon'); await settle();
  assert.ok(app.el('tbody').innerHTML.includes(`data-item="${a.rows[0].id}" data-season-row="${a.rows[0].id}" data-row-section="dated"`));
  dom.focus('tbody', `[data-season-row="${a.rows[0].id}"] [data-action="season-control"] button`);
  await app.ctx.setSeasonSkipped(a.rows[0].id, true); await settle();
  assert.strictEqual(dom.active(), dom.in('tbody', `[data-item="${a.rows[1].id}"] [data-primary]`), 'F-5: the next season’s title');
  dom.focus('tbody', `[data-season-row="${a.rows[1].id}"] [data-action="season-control"] button`);
  await app.ctx.setSeasonSkipped(a.rows[1].id, true); await settle();
  assert.strictEqual(dom.active(), dom.in('tbody', '[data-empty]'), 'F-4: dated-only results, now empty: the message');
  assert.ok(dom.active().children.length === 0 && app.el('tbody').innerHTML.includes('data-empty="1">Nothing with a confirmed date is coming up.'));
  assert.strictEqual(dom.active().attrs.colspan, '5', 'Coming Soon has five columns');
  // With a TBA section left: its toggle (F-7)
  const b = show({ title: 'Bravo', status: 'confirmed' }, [{ num: 1, date: day(5) }, { num: 2, tba: true }]);
  const app2 = await boot(all(b));
  const dom2 = makeMiniDom(app2);
  app2.ctx.switchView('comingsoon'); await settle();
  dom2.focus('tbody', `[data-season-row="${b.rows[0].id}"] [data-action="season-control"] button`);
  await app2.ctx.setSeasonSkipped(b.rows[0].id, true); await settle();
  assert.strictEqual(dom2.active(), dom2.in('tbody', '[data-section="tba"]'), 'F-7: the TBA toggle');
});

test('correction 3: All TV Seasons: a skipped season leaves; focus goes to the next season, then to the empty-state message', async () => {
  const a = show({ title: 'Alpha', status: 'confirmed' }, [{ num: 1, date: day(-50) }, { num: 2, date: day(-40) }]);
  const app = await boot(all(a));
  const dom = makeMiniDom(app);
  app.ctx.switchView('alltv'); await settle(); app.ctx.setAllTvPresentation('seasons'); await settle();
  dom.focus('tbody', `[data-season-row="${a.rows[0].id}"] [data-action="season-control"] button`);
  await app.ctx.setSeasonSkipped(a.rows[0].id, true); await settle();
  assert.strictEqual(dom.active(), dom.in('tbody', `[data-item="${a.rows[1].id}"] [data-primary]`), 'F-5: the next season');
  dom.focus('tbody', `[data-season-row="${a.rows[1].id}"] [data-action="season-control"] button`);
  await app.ctx.setSeasonSkipped(a.rows[1].id, true); await settle();
  assert.strictEqual(dom.active(), dom.in('tbody', '[data-empty]'), 'F-4: the empty-state message');
  assert.ok(app.el('tbody').innerHTML.includes('data-empty="1">No seasons match your filters.'));
});

test('correction 5: stored unknown-date text is kept (also with the 2099 sentinel and no "TBA" in it); only empty or bare TBA reads "Date TBA"', async () => {
  const app = await boot(all());
  const t = (display, date_sort) => app.ctx.nextDateText({ display_date: display, date_sort });
  assert.strictEqual(t('2027 (announced)', '2099-01-01'), '2027 (announced)');
  assert.strictEqual(t('Announced', '2099-01-01'), 'Announced');
  assert.strictEqual(t('2026 (TBA)', '2026-06-01'), '2026 (TBA)');
  assert.strictEqual(t('TBA', '2099-01-01'), 'Date TBA');
  assert.strictEqual(t('tba', '2099-01-01'), 'Date TBA');
  assert.strictEqual(t('', '2099-01-01'), 'Date TBA');
  assert.strictEqual(t('Nov 12, 2026', '2026-11-12'), 'Nov 12, 2026');
  assert.strictEqual(t('<b>&', '2099-01-01'), '&lt;b&gt;&amp;', 'escaped');
  const s = show({ title: 'Announced', status: 'watching', tmdb_id: null }, [{ season: 'Season 1', w: true, date: day(-90) }, { season: 'Season 2', date: '2099-01-01', display: '2027 (announced)' }]);
  const app2 = await boot(all(s));
  assert.ok(app2.el('tbody').innerHTML.includes('Season 2 · 2027 (announced)'), 'desktop');
  assert.ok(app2.el('cardList').innerHTML.includes('<span class="visually-hidden">Next season: </span>Season 2 · 2027 (announced)'), 'phone, an actual value: the hidden prefix');
});

test('correction 6: every full-width row of Currently Watching spans its five columns', async () => {
  const mk = (title, extra) => show({ title, status: 'watching', catalog_new: true, ...extra }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-3) }]);
  const a = mk('Alpha'), b = mk('Bravo'), c = show({ title: 'Charlie', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }]);
  const app = await boot(all(a, b, c));
  // Each row's cells add up to the five columns (a caught-up row: Show, Categories, Up next spanning 3).
  const spans = () => app.el('tbody').innerHTML.split('<tr').slice(1).map(r => [...r.split('</tr>')[0].matchAll(/<t[dh](?=[\s>])([^>]*)>/g)]
    .reduce((n, m) => n + Number((m[1].match(/colspan="(\d+)"/) || [0, 1])[1]), 0)).map(String);
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  let html = app.el('tbody').innerHTML;
  assert.ok(html.includes('Dismiss “New” on these 2'), 'the dismiss-all row is present');
  assert.ok(html.includes('data-section="inprogress"') && html.includes('data-section="uptodate"') && html.includes('show-actions-row'));
  assert.ok(spans().length >= 8 && spans().every(x => x === '5'), `every row spans 5: ${spans()}`);
  app.el('fSearch').value = 'zzz'; app.ctx.renderTable();
  assert.ok(app.el('tbody').innerHTML.includes('No in-progress shows match your filters.') && app.el('tbody').innerHTML.includes('No caught-up shows match your filters.'));
  assert.ok(spans().every(x => x === '5'), `messages span 5: ${spans()}`);
  app.ctx.switchView('comingsoon'); await settle();
  const g = app.hold(r => r.method === 'GET' && r.url.includes('/tv_shows'));
  app.ctx.switchView('watching'); await g.reached; // a first read shows the loading message
  assert.ok(app.el('tbody').innerHTML.includes('colspan="5" class="loading"'), 'the loading message too');
  g.fail(); await settle();
  assert.ok(app.el('tbody').innerHTML.includes('colspan="5" class="loading"'), 'and the failure message');
  // All TV keeps six
  app.ctx.switchView('alltv'); await settle();
  assert.ok(spans().every(x => x === '6'), `All TV rows span 6: ${spans()}`);
});

test('B2: the shortcut is an ordinary one-line Mark watched button', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(!/\.watch-btn\.show-shortcut/.test(css), 'no two-line sizing is left');
});

T.run();
