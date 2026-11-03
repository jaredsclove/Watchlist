// Offline tests for the UI-polish batch (release 1): category pills in a stable priority with one desktop line and a
// +N button that shows the rest inline; the status filter and collections' Separate / Combined in the Filters panel,
// with the default status said in the chip row; "Mark S4 watched" season labels; an expanded season's actions in one
// group; no empty progress track or "—" placeholder; Coming Soon's shorter dates; All Movies' count. Measured layout
// at real widths is a browser check, not covered here. The harness is 1200 px wide, below the 1240 px where the show
// views' Categories column widens, so its budgets are the narrow ones.
// Run from the repo root: node tests/ui-polish.test.js
const assert = require('assert');
const { createApp, runner, settle, userKeyOf } = require('./app-harness');
const { makeMiniDom } = require('./mini-dom');

const T = runner('ui-polish');
const test = T.test;

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const disp = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
function show(o, specs) {
  const s = { id: nid('show'), collection: 'othertv', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 100 + n, status: 'confirmed', ...o };
  const rows = specs.map(sp => ({
    id: nid('r'), collection: s.collection, title: s.title, theme: 'HBO', status: 'pending', watched: !!sp.w, skipped: !!sp.s, show_id: s.id,
    media_type: 'tv', tmdb_id: s.tmdb_id, season_number: sp.num ?? null, season: sp.season || `Season ${sp.num}`, display_date: sp.display || (sp.date ? disp(sp.date) : 'Jan 1, 2020'),
    date_sort: sp.date || '2020-01-01', item_key: `${s.show_key}|${(sp.season || `season ${sp.num}`).toLowerCase()}`, watch_with: [], collections: []
  }));
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'movies', title: 'Film', theme: 'Drama', status: 'confirmed', watched: false,
  media_type: 'movie', tmdb_id: 900 + n, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) });
const boot = data => createApp({ rows: data.rows, tvShows: data.shows });
const rowOf = (app, id) => app.el('tbody').innerHTML.split('</tr>').find(r => r.includes(`data-show-row="${id}"`)) || '';
const cardOf = (app, id) => app.el('cardList').innerHTML.split('<div class="item-card').find(c => c.includes(`data-show-row="${id}"`)) || '';
const pills = h => [...h.matchAll(/data-filter-value="([^"]*)"/g)].map(m => m[1]);
const text = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const many = () => show({ title: 'Many', status: 'watching', genres: ['Drama', 'Crime'], forms: ['Animation'], franchises: ['Saga'], network: 'Net' },
  [{ num: 1, w: true }, { num: 2, date: day(-3) }]);

// ─── Categories ───────────────────────────────────────────────────────────────
test('categories: network, franchises, genres, forms; the desktop row fits its budget and offers the rest with +N; the card lists every pill', async () => {
  const a = many();
  const app = await boot(all(a));
  app.ctx.switchView('alltv'); await settle();
  // All TV below 1240 px: a budget of 22. Net (7) and Saga (8) fit; Drama (9) doesn't fit.
  const row = rowOf(app, a.show.id);
  assert.deepStrictEqual(pills(row), ['Net', 'Saga'], 'priority order, as many as fit');
  assert.match(row, /<button type="button" class="meta-more" data-action="cats-more" aria-expanded="false" aria-label="Show 3 more categories" onclick="event.stopPropagation\(\); toggleCategoryOverflow\('[^']+'\)">\+3<\/button>/);
  assert.deepStrictEqual(pills(cardOf(app, a.show.id)), ['Net', 'Saga', 'Drama', 'Crime', 'Animation'], 'the card: every pill');
  // A pure check of the fit rule: the first pill always shows whole, however long; then the +N needs room.
  const fit = (labels, budget) => app.ctx.categoryFitCount(labels.map(v => ['genres', v]), budget);
  assert.strictEqual(fit(['An Extremely Long Streaming Service Name'], 20), 1, 'a long first label is kept whole');
  assert.strictEqual(fit(['An Extremely Long Streaming Service Name', 'Drama'], 20), 1);
  assert.strictEqual(fit(['Net', 'Saga', 'Drama'], 30), 3, 'everything fits: no +N');
  assert.strictEqual(fit(['Net', 'Saga', 'Drama', 'Crime'], 30), 3, 'three fit, with room for +1');
  assert.strictEqual(fit(['Net', 'Saga', 'Drama', 'Crime'], 27), 2, 'one fewer when only the +N would not fit');
  assert.deepStrictEqual(app.writes(), []);
});

test('+N shows the rest inline (Fewer puts them away), keeps focus on its button, and the shown pills still filter; the choice is page memory', async () => {
  const a = many(), b = show({ title: 'Other', status: 'watching', genres: ['Comedy'], network: 'Net' }, [{ num: 1, date: day(-3) }]);
  const app = await boot(all(a, b));
  app.ctx.switchView('alltv'); await settle();
  const dom = makeMiniDom(app);
  dom.hide('cardList');
  const sel = `[data-item="${a.show.id}"] [data-action="cats-more"]`;
  dom.focus('tbody', sel);
  app.ctx.toggleCategoryOverflow(a.show.id); await settle();
  const open = rowOf(app, a.show.id);
  assert.deepStrictEqual(pills(open), ['Net', 'Saga', 'Drama', 'Crime', 'Animation'], 'every pill, in the row');
  assert.match(open, /aria-expanded="true" aria-label="Show fewer categories"[^>]*>Fewer<\/button>/);
  assert.strictEqual(dom.active(), dom.in('tbody', sel), 'focus stays on the button');
  assert.deepStrictEqual(pills(rowOf(app, b.show.id)), ['Net', 'Comedy'], 'another row is unchanged (it fits)');
  assert.ok(!rowOf(app, b.show.id).includes('cats-more'), 'no button where nothing is hidden');
  // A pill shown by +N filters like any other.
  const crime = [...app.el('tbody').innerHTML.matchAll(/<button[^>]*data-filter-value="Crime"[^>]*>/g)][0][0];
  assert.match(crime, /toggleFilterPill\(this\)/);
  app.ctx.toggleFilterSelect('fGenre', 'Crime'); await settle();
  assert.strictEqual(app.el('fGenre').value, 'Crime');
  assert.ok(!rowOf(app, b.show.id), 'the filter applies');
  app.ctx.toggleCategoryOverflow(a.show.id); await settle();
  assert.deepStrictEqual(pills(rowOf(app, a.show.id)), ['Net', 'Saga'], 'Fewer');
  app.ctx.toggleCategoryOverflow(a.show.id);
  const again = await boot(all(a, b));
  again.ctx.switchView('alltv'); await settle();
  assert.deepStrictEqual(pills(rowOf(again, a.show.id)), ['Net', 'Saga'], 'a reload starts collapsed');
  assert.deepStrictEqual(app.writes(), []);
});

test('Currently Watching cards show categories only when expanded; All TV cards keep them', async () => {
  const a = many();
  const app = await boot(all(a));
  assert.ok(!cardOf(app, a.show.id).includes('card-labels'), 'collapsed: none');
  app.ctx.toggleDerivedShow(a.show.id); await settle();
  assert.deepStrictEqual(pills(cardOf(app, a.show.id)), ['Net', 'Saga', 'Drama', 'Crime', 'Animation'], 'expanded: all');
  app.ctx.switchView('alltv'); await settle();
  assert.ok(pills(cardOf(app, a.show.id)).length === 5, 'All TV: always');
});

// ─── Filters ──────────────────────────────────────────────────────────────────
test('the status filter is in the Filters panel: its default is said in the chip row; another value is a chip and counts; Separate / Combined is in the panel too', async () => {
  const a = many(), sk = show({ title: 'Skipped one', status: 'skipped' }, [{ num: 1 }]);
  const app = await boot(all(a, sk, film({ title: 'F' })));
  app.ctx.switchView('alltv'); await settle();
  const fb = () => app.el('filtersRow').innerHTML, chips = () => app.el('filterChips').innerHTML;
  assert.ok(fb().indexOf('id="fStatus"') > fb().indexOf('id="filterMore"'), 'in the panel');
  assert.match(fb(), /<label class="filter-field-label" for="fStatus">Status<\/label>/, 'labelled there');
  assert.ok(chips().includes('Status: All except Skipped'), 'the default, said');
  assert.ok(!app.el('tbody').innerHTML.includes('Skipped one'));
  app.el('fStatus').value = 'all'; app.ctx.renderTable(); await settle();
  assert.ok(!chips().includes('All except Skipped') && chips().includes('<span class="chip-k">Status:</span> <span class="chip-v">All statuses</span>'), 'a chip instead');
  assert.strictEqual(app.el('filterMoreCount').textContent, '1', 'it counts in Filters');
  assert.ok(app.el('tbody').innerHTML.includes('Skipped one'));
  // Movies: the same note; the Watched choice stays on the line.
  app.ctx.switchMediaType('movie'); await settle();
  assert.ok(chips().includes('Status: All except Skipped') && fb().indexOf('id="fWatch"') < fb().indexOf('id="filterMoreBtn"'));
  assert.match(fb(), /<span class="filter-label">Filters<\/span>|>Filters<span class="filter-count"/, 'one label: Filters');
  assert.ok(!/More filters/.test(fb()));
  assert.deepStrictEqual(app.writes(), []);
});

// ─── Season actions ───────────────────────────────────────────────────────────
test('season actions: "Mark S4 watched"; Specials and short names by name; a long name "Mark season watched"; the full season always in the name', async () => {
  const app = await boot(all());
  const label = season => app.ctx.seasonMarkLabel({ season });
  assert.strictEqual(label('Season 4'), 'Mark S4 watched');
  assert.strictEqual(label('Season 12'), 'Mark S12 watched');
  assert.strictEqual(label('Specials'), 'Mark Specials watched');
  assert.strictEqual(label('Volume 2'), 'Mark Volume 2 watched');
  assert.strictEqual(label('Season 5 (Part 1)'), 'Mark season watched');
  assert.strictEqual(label(''), 'Mark season watched');
  const a = show({ title: 'Acts', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-30) }, { num: 3, date: day(-10) }]);
  const app2 = await boot(all(a));
  assert.match(rowOf(app2, a.show.id), /aria-label="Mark S2 watched: Season 2 of Acts"[^>]*>Mark S2 watched<\/button>/, 'the show row');
  app2.ctx.toggleDerivedShow(a.show.id); await settle();
  const sub = id => app2.el('tbody').innerHTML.split('</tr>').find(r => r.includes(`data-season-row="${id}"`));
  assert.match(sub(a.rows[2].id), /aria-label="Mark S3 watched: Season 3"[^>]*>Mark S3 watched<\/button>/, 'an expanded season row');
  assert.match(sub(a.rows[0].id), /✓ Watched<\/button>/, 'watched: the undo state is unchanged');
  // Mark and Skip together in one cell, before the season's other management.
  const group = sub(a.rows[2].id).match(/<div class="season-actions">[\s\S]*?<\/div>/)[0];
  assert.ok(group.indexOf('data-action="season-watch"') < group.indexOf('data-action="season-control"'), 'Mark, then Skip');
  const card = app2.el('cardList').innerHTML.split('data-season-row="').find(c => c.startsWith(a.rows[2].id));
  assert.match(card, /<div class="card-actions"><div class="season-actions">/, 'the card groups them the same way');
});

// ─── Progress, placeholders, dates, counts ────────────────────────────────────
test('no empty progress track at 0%, and no "—" where a row has no action', async () => {
  const z = show({ title: 'Zero', status: 'watching' }, [{ num: 1, date: day(-30) }]);
  const t = show({ title: 'ToWatch' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-30) }]);
  const app = await boot(all(z, t));
  app.ctx.switchView('alltv'); await settle();
  assert.ok(rowOf(app, z.show.id).includes('0/1 season watched') && !rowOf(app, z.show.id).includes('mini-progress'), '0%: text only');
  assert.ok(rowOf(app, t.show.id).includes('mini-progress-fill" style="width:50%"'), 'a bar above 0%');
  assert.ok(!rowOf(app, t.show.id).includes('confirmed-lbl">—'), 'To Watch: an empty Action cell');
});

test('Coming Soon: "Nov 18" under a month heading; stored text that isn’t a full date is kept', async () => {
  const d = day(20);
  const a = show({ title: 'Soon' }, [{ num: 1, date: d }]);
  const b = show({ title: 'Vague' }, [{ num: 1, date: d, display: 'Fall 2026' }]);
  const app = await boot(all(a, b));
  app.ctx.switchView('comingsoon'); await settle();
  const short = disp(d).replace(/, \d{4}$/, '');
  const rowFor = title => app.el('tbody').innerHTML.split('</tr>').find(r => r.includes(`show-title">${title}<`));
  assert.ok(rowFor('Soon').includes(`<td class="date-cell">${short}</td>`), short);
  assert.ok(rowFor('Vague').includes('<td class="date-cell">Fall 2026</td>'), 'kept as stored');
});

test('All Movies’ count: "3 films · 1 watched"; filtered, "1 of 3 films · 1 of 3 watched"', async () => {
  const app = await boot(all(film({ title: 'A' }), film({ title: 'B', watched: true }), film({ title: 'C' })));
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = ''; app.ctx.renderTable(); await settle();
  assert.strictEqual(text(app.el('statsRow').innerHTML), '3 films · 1 watched');
  app.el('fWatch').value = 'watched'; app.ctx.renderTable(); await settle();
  assert.strictEqual(text(app.el('statsRow').innerHTML), '1 of 3 films · 1 of 3 watched');
});

// ─── UI refine ────────────────────────────────────────────────────────────────
test('UI refine: TMDB search looks like library search (same field and icon) with an explicit Search button; library search has none', async () => {
  const app = await boot(all(many()));
  app.ctx.switchView('alltv'); await settle();
  const f = app.el('filtersRow').innerHTML;
  assert.match(f, /<input class="search-input" id="fSearch" type="text" placeholder="Search library…"/, 'library search: the shared field');
  assert.match(f, /<form class="tmdb-quick" role="search" onsubmit="event.preventDefault\(\); tmdbQuickSubmit\('tv'\)"><input id="tmdbQuickQuery" class="search-input" type="search"[^>]*><button type="submit" class="btn tmdb-quick-go" aria-label="Search TMDB">Search<\/button><\/form>/, 'TMDB: the same field, then Search; Enter submits the form');
  assert.strictEqual((f.match(/type="submit"/g) || []).length, 1, 'only TMDB search has a submit button');
  assert.ok(!f.includes('⏎'));
});

test('UI refine: show rows name a released up-next season without its past date; upcoming ones keep date or TBA; flat lists and Coming Soon keep dates', async () => {
  const released = show({ title: 'Released', status: 'watching' }, [{ num: 1, w: true, date: day(-200) }, { num: 2, date: day(-20) }]);
  const later = show({ title: 'Later', status: 'watching' }, [{ num: 1, w: true, date: day(-200) }, { num: 2, date: day(40) }]);
  const tba = show({ title: 'Tba', status: 'watching' }, [{ num: 1, w: true, date: day(-200) }, { num: 2, date: '2099-01-01', display: 'TBA' }]);
  const toWatch = show({ title: 'Untouched' }, [{ num: 1, date: day(-20) }]);
  const app = await boot(all(released, later, tba, toWatch));
  const nextCell = id => (rowOf(app, id).match(/<td class="date-cell"[^>]*>([\s\S]*?)<\/td>/) || [])[1]; // (a caught-up row's spans three columns)
  for (const view of ['watching', 'alltv']) {
    app.ctx.switchView(view); await settle();
    assert.strictEqual(nextCell(released.show.id), 'Season 2', `${view}: released, no date`);
    assert.ok(!cardOf(app, released.show.id).includes(disp(day(-20))), `${view}: nor in the card`);
    assert.strictEqual(nextCell(later.show.id), `Season 2 · ${disp(day(40))}<span class="upcoming-tag">Upcoming</span>`, `${view}: upcoming keeps its date`);
    assert.ok(nextCell(tba.show.id).startsWith('Season 2 · Date TBA'), `${view}: TBA kept`);
  }
  assert.strictEqual(nextCell(toWatch.show.id), 'Season 1', 'All TV: a To Watch show’s released season too');
  app.ctx.setAllTvPresentation('seasons'); await settle();
  assert.ok(app.el('tbody').innerHTML.includes(`<td class="date-cell">${disp(day(-20))}</td>`), 'the flat Seasons list keeps the date');
  app.ctx.switchView('comingsoon'); await settle();
  assert.ok(app.el('tbody').innerHTML.includes('Later') && app.el('tbody').innerHTML.includes(disp(day(40)).replace(/, \d{4}$/, '')), 'Coming Soon keeps its dates');
});

test('UI refine: episode progress names its season ("S2 · …"); a long name is kept whole and may wrap; season progress is unchanged', async () => {
  const app = await boot(all());
  const short = season => app.ctx.seasonShortLabel({ season });
  assert.strictEqual(short('Season 35'), 'S35');
  assert.strictEqual(short('Specials'), 'Specials');
  assert.strictEqual(short('Season 5 (Part 1): The Long Way Round'), 'Season 5 (Part 1): The Long Way Round', 'never dropped');
  assert.strictEqual(app.ctx.seasonMarkLabel({ season: 'Season 5 (Part 1): The Long Way Round' }), 'Mark season watched', 'the button may stay short');
  const named = show({ title: 'Parts', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { season: 'Season 2 (Part 1): A Long Way', num: 2, date: day(-20) }]);
  const plain = show({ title: 'Plain', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-20) }]);
  const data = all(named, plain);
  const mk = (r, ep, num) => ({ id: nid('m'), season_id: r.id, tmdb_episode_id: ep, episode_number: num });
  const app2 = await createApp({ rows: data.rows, tvShows: data.shows, episodeMarks: [mk(named.rows[1], 11, 1), mk(plain.rows[1], 21, 1), mk(plain.rows[1], 22, 2)] });
  const progress = id => text(rowOf(app2, id).split('<td class="card-date">')[1] || '');
  assert.strictEqual(progress(plain.show.id), 'S2 · 2 episodes marked', 'S-number; the conservative fallback is kept');
  assert.match(rowOf(app2, named.show.id), /<td class="card-date"><span class="progress-season">Season 2 \(Part 1\): A Long Way<\/span> · 1 episode marked/, 'a long name whole, in a wrapping span');
  const seasonsOnly = show({ title: 'Seasons', status: 'watching' }, [{ num: 1, w: true, date: day(-90) }, { num: 2, date: day(-20) }]);
  const app3 = await boot(all(seasonsOnly));
  assert.strictEqual(text(rowOf(app3, seasonsOnly.show.id).split('<td class="card-date">')[1] || ''), '1/2 seasons watched', 'season progress unchanged');
});

T.run();
