// Offline tests for the compact interface: the row's order (expand · title · ⋯), priority in the
// menu with non-default marks in the row, status emphasis, explicit progress, the Mark watched
// shortcut, subdued genres and the toolbar's order. The page runs in the whole-page harness
// (tests/app-harness.js); measured layout at real widths is a browser check, not covered here.
// Run from the repo root: node tests/compact-layout.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createApp, runner, settle } = require('./app-harness');
const { makeMiniDom } = require('./mini-dom');

const T = runner('compact-layout');
const test = T.test;
const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const phone = css.slice(css.indexOf('@media (max-width: 1099px)'));

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
function show(o, specs) {
  const s = { id: nid('show'), collection: 'othertv', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 100 + n, status: 'confirmed', ...o };
  const rows = specs.map(sp => ({
    id: nid('r'), collection: s.collection, title: s.title, theme: 'HBO', status: 'pending', watched: !!sp.w, skipped: !!sp.s, show_id: s.id,
    media_type: 'tv', tmdb_id: s.tmdb_id, season_number: sp.num, season: `Season ${sp.num}`, display_date: sp.display || 'Jan 1, 2020',
    date_sort: sp.date || '2020-01-01', item_key: `${s.show_key}|season ${sp.num}`, watch_with: [], collections: []
  }));
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'movies', title: 'Film', theme: 'Drama', status: 'confirmed', watched: false,
  media_type: 'movie', tmdb_id: 900 + n, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) });
const boot = data => createApp({ rows: data.rows, tvShows: data.shows });
const rowsOf = html => html.split('</tr>');
const rowOf = (app, id) => rowsOf(app.el('tbody').innerHTML).find(r => r.includes(`data-show-row="${id}"`));
const cardOf = (app, id) => app.el('cardList').innerHTML.split('<div class="item-card').find(c => c.includes(`data-show-row="${id}"`));
const mixed = () => show({ title: 'Mixed', status: 'watching', genres: ['Crime', 'Drama'], network: 'Net' }, [{ num: 1, w: true }, { num: 2, date: day(-3) }, { num: 3, date: day(-1) }]);

test('every show row and card reads expand · title · ⋯, each a separate button', async () => {
  const a = mixed();
  for (const view of ['watching', 'alltv']) {
    const app = await boot(all(a));
    app.ctx.switchView(view); await settle();
    for (const h of [rowOf(app, a.show.id), cardOf(app, a.show.id)]) {
      const expand = h.indexOf('class="expand-btn"'), title = h.indexOf('>Mixed<') >= 0 ? h.indexOf('>Mixed<') : h.indexOf('Mixed'), more = h.indexOf('class="more-btn"');
      assert.ok(expand >= 0 && expand < title && title < more, `${view}: order`);
      assert.ok(h.includes('aria-label="More for Mixed"') && h.includes('aria-expanded="false"'), `${view}: ⋯ is named and disclosed`);
    }
  }
});

test('priority lives in ⋯: no Normal label or select in the row; the same write; High and Low stay visible, as a star and a word', async () => {
  const a = show({ title: 'High', priority: 'high' }, [{ num: 1 }]), b = show({ title: 'Plain' }, [{ num: 1 }]), c = show({ title: 'Low', priority: 'low' }, [{ num: 1 }]);
  const app = await boot(all(a, b, c));
  app.ctx.switchView('alltv'); await settle();
  const cell = h => h.split('class="more-popover"');
  for (const [s, mark] of [[a, 'aria-label="High priority"'], [c, '>Low</span>']]) assert.ok(cell(rowOf(app, s.show.id))[0].includes(mark), s.show.title);
  const plain = rowOf(app, b.show.id);
  assert.ok(!cell(plain)[0].includes('priority-') && !/>Normal</.test(plain.split('</div></span>').pop()), 'Normal shows nothing in the row');
  assert.ok(plain.split('class="more-popover"')[1].includes(`setShowStateById('${b.show.id}', { priority: this.value })`), 'the same call, in the menu');
  assert.ok(plain.includes('onchange="closeRowMenu(this); setShowStateById('), 'the menu closes first');
});

test('films: priority is first in the existing ⋯, in All Movies and collections alike; their rows have no priority select', async () => {
  const f = film({ title: 'Heat', priority: 'low' });
  const app = await boot(all(f));
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = ''; app.ctx.renderTable();
  const h = app.el('tbody').innerHTML;
  const [before, menu] = h.split('class="more-popover"');
  assert.ok(!before.includes('priority-select'), 'none in the row');
  assert.ok(menu.indexOf('priority-select') < menu.indexOf('Watch with'), 'first in the menu');
  assert.ok(before.includes('>Low</span>'), 'Low stays visible');
  assert.ok(h.includes(`closeRowMenu(this); setFilmPriority('${f.id}', this.value)`));
});

test('a click anywhere in ⋯ never expands the row; the row itself still does', async () => {
  const a = mixed();
  const app = await boot(all(a));
  app.ctx.switchView('alltv'); await settle();
  const dom = makeMiniDom(app);
  const label = dom.in('tbody', `[data-item="${a.show.id}"] .popover-section-label`);
  app.ctx.toggleDerivedShow(a.show.id, { target: label });
  assert.strictEqual(app.get('expandedShows.size'), 0, 'the menu’s own text');
  app.ctx.toggleDerivedShow(a.show.id, { target: dom.in('tbody', `[data-item="${a.show.id}"] .more-btn`) });
  assert.strictEqual(app.get('expandedShows.size'), 0, 'the ⋯');
  app.ctx.toggleDerivedShow(a.show.id, { target: dom.in('tbody', `[data-item="${a.show.id}"] [data-action="status"] select`) });
  assert.strictEqual(app.get('expandedShows.size'), 0, 'the status select');
  app.ctx.toggleDerivedShow(a.show.id, { target: dom.in('tbody', `[data-item="${a.show.id}"] .show-title`) });
  assert.strictEqual(app.get('expandedShows.size'), 1, 'the row');
});

test('focus: choosing a priority moves focus to the row’s ⋯, which keeps it through the redraws, in All TV and All Movies', async () => {
  const a = mixed();
  const app = await boot(all(a));
  app.ctx.switchView('alltv'); await settle();
  const dom = makeMiniDom(app);
  dom.hide('cardList');
  const more = `[data-item="${a.show.id}"] [data-action="more"]`;
  app.ctx.closeRowMenu(dom.focus('tbody', `[data-item="${a.show.id}"] [data-action="priority"] select`));
  assert.strictEqual(dom.active(), dom.in('tbody', more));
  await app.ctx.setShowStateById(a.show.id, { priority: 'high' }); await settle();
  assert.strictEqual(dom.active(), dom.in('tbody', more), 'redrawn');

  const f = film({ title: 'Heat' });
  const app2 = await boot(all(f));
  app2.ctx.switchMediaType('movie'); await settle();
  const dom2 = makeMiniDom(app2);
  dom2.hide('cardList');
  const fMore = `[data-item="${f.id}"] [data-action="more"]`;
  app2.ctx.closeRowMenu(dom2.focus('tbody', `[data-item="${f.id}"] [data-action="priority"] select`));
  await app2.ctx.setFilmPriority(f.id, 'high'); await settle();
  assert.strictEqual(dom2.active(), dom2.in('tbody', fMore), 'All Movies keeps it too');
});

test('progress is explicit: seasons are named, one season is singular, and episode progress keeps its own wording', async () => {
  const a = mixed(), b = show({ title: 'One', status: 'watching' }, [{ num: 1, date: day(-2) }]);
  const app = await boot(all(a, b));
  app.ctx.switchView('alltv'); await settle();
  assert.ok(rowOf(app, a.show.id).includes('1/3 seasons watched') && cardOf(app, a.show.id).includes('1/3 seasons watched'));
  assert.ok(rowOf(app, b.show.id).includes('0/1 season watched'));
  const ep = fs.readFileSync(path.join(__dirname, '..', 'episodes.js'), 'utf8');
  assert.ok(ep.includes('In progress'), 'the episode wording is its own');
});

test('the shortcut is drawn only beside the up-next line naming the same season, and the completion offer in an episode list keeps its full wording', async () => {
  const a = mixed();
  for (const view of ['watching', 'alltv']) {
    const app = await boot(all(a));
    app.ctx.switchView(view); await settle();
    const h = rowOf(app, a.show.id);
    assert.ok(h.includes('aria-label="Mark watched: Season 2 of Mixed"') && h.includes('>Mark watched</button>'), view);
    assert.ok(/Season 2 · /.test(h), `${view}: the row names it`);
  }
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'episodes.js'), 'utf8').includes('Mark ${'), 'the offer is unchanged');
});

test('status stays a directly editable select; To Watch and Skipped are quiet, Choose a status… never is, and focus is visible', async () => {
  const a = show({ title: 'Review', status_review: true }, [{ num: 1 }]), b = show({ title: 'Quiet' }, [{ num: 1 }]);
  const app = await boot(all(a, b));
  app.ctx.switchView('alltv'); await settle();
  assert.ok(rowOf(app, a.show.id).includes('status-needs-choice'));
  assert.ok(!rowOf(app, b.show.id).includes('status-needs-choice') && rowOf(app, b.show.id).includes(`setShowStateById('${b.show.id}', { status: this.value })`));
  assert.match(css, /\.status-select\.s-confirmed \{ background-color: transparent; color: var\(--text2\); border-color: transparent;/);
  assert.match(css, /\.status-select\.status-needs-choice \{ background-color: var\(--amber-bg\);/);
  assert.match(css, /\.status-select:focus-visible \{ outline: 2px solid var\(--accent\);/);
});

test('genres: a clickable one stays a filter button, subdued, with hover and focus treatments; without its filter it stays plain text', async () => {
  const a = mixed();
  const app = await boot(all(a));
  app.ctx.switchView('alltv'); await settle();
  const h = rowOf(app, a.show.id);
  assert.match(h, /<button type="button" class="badge meta-chip meta-genres badge-clickable filter-pill"[^>]*data-filter-kind="genres" data-filter-value="Crime"/);
  assert.strictEqual(app.get("filterPillHtml('watchwith', 'x', 'X', { cls: 'ww-tag' })").startsWith('<span'), app.el('fWatchWith') === null, 'no filter control, no button');
  assert.match(css, /button\.meta-chip\.meta-genres:hover \{[^}]*text-decoration: underline;/);
  assert.match(css, /\.filter-pill:focus-visible \{ outline: 2px solid var\(--accent\);/);
  assert.match(phone, /\.filter-pill \{ min-height: 32px;/);
});

test('the toolbar: toggles, Search, scope, More filters, + Add in page order; the count beside them; nothing reordered on phones', async () => {
  const app = await boot(all(mixed()));
  app.ctx.switchView('alltv'); await settle();
  const f = app.el('filtersRow').innerHTML;
  const at = s => f.indexOf(s);
  assert.ok(at('view-toggle') < at('id="fSearch"') && at('id="fSearch"') < at('id="fStatus"') && at('id="fStatus"') < at('id="filterMoreBtn"') && at('id="filterMoreBtn"') < at('add-open-btn'));
  const page = fs.readFileSync(path.join(__dirname, '..', 'watchlist.html'), 'utf8');
  assert.match(page, /<div class="list-toolbar">\s*<div class="filters" id="filtersRow"><\/div>\s*<div class="stats-row" id="statsRow"><\/div>/);
  assert.match(css, /\.filter-line \.search-input \{ flex: 1 1 260px;/);
  assert.ok(!/\.search-input[^{]*\{[^}]*order:/.test(phone), 'Search keeps its place in the Tab order');
});

test('phone cards: labels are small pills in 32 px targets, Up to date is quiet text, and one margin holds the card', () => {
  assert.match(phone, /\.item-card \.filter-pill:not\(\.meta-genres\) \{[^}]*border-color: transparent !important;[^}]*background-clip: padding-box !important;[^}]*min-height: 32px;/);
  assert.match(phone, /\.card-actions \.status-pill\.s-caughtup \{ background: none; border: 0; padding: 0;/);
  assert.match(phone, /\.card-labels \{ display: flex; flex-wrap: wrap;/, 'the labels move together');
  assert.ok(!/\.card-progress \{[^}]*margin-left: auto/.test(css), 'progress that wraps starts on the card\'s margin');
  assert.match(phone, /\.card-top > \.expand-btn \{[^}]*margin: -6px 0 -6px -10px;[^}]*padding-left: 10px;/, 'the chevron starts on the margin, in its whole target');
  assert.match(phone, /\.card-top \.more-btn \{ position: relative; z-index: 1; \}/, 'the season line never covers ⋯');
});

test('the header and view tabs: areas in the bar; view tabs are buttons with a current page; the phone header isn’t sticky and has no logo', async () => {
  const app = await boot(all(mixed()));
  const page = fs.readFileSync(path.join(__dirname, '..', 'watchlist.html'), 'utf8');
  assert.ok(page.indexOf('class="logo"') < page.indexOf('id="mediaSwitch"') && page.indexOf('id="mediaSwitch"') < page.indexOf('class="topbar-right"'));
  assert.match(app.el('tabBar').innerHTML, /<button type="button" class="tab active" aria-current="page" onclick="switchView\('watching'\)">/);
  assert.match(phone.slice(phone.indexOf('.topbar {')), /\.topbar \{ position: static;/);
  assert.match(phone, /body:not\(\.signed-out\) \.logo \{ display: none; \}/);
  assert.match(css, /\.topbar \{[^}]*padding: 8px var\(--page-gutter\);/);
});

test('a collection’s Seasons card shows the show’s priority, as its row does', async () => {
  const fix = fs.readFileSync(path.join(__dirname, '..', 'browse-views.js'), 'utf8');
  const fn = fix.slice(fix.indexOf('function browseSeasonEntryHtml'), fix.indexOf('function collectionRemoveShowHtml'));
  assert.ok(fn.includes('<span class="card-title">${priorityMarkHtml(show.priority)}${esc(show.title)}${priorityMarkHtml(show.priority, true)}</span>'));
});

T.run();
