// Offline tests for All Movies' layout: Title | Genres | Groups | Release | Status | Watched | ⋯. Genre pills (with forms and
// a network, else the original label) in Genres; franchises, collection tags and watch-with people in Groups; no pill line
// under the title; each desktop cell one line with a +N that starts hidden (measured in a browser, not here); cards list
// both groups separately with every pill. Collections' film rows are unchanged. Nothing is written.
// Run from the repo root: node tests/movies-layout.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');
const { makeMiniDom } = require('./mini-dom');

const T = runner('movies-layout');
const test = T.test;
const DISNEY = 'browse:0c000000-0000-4000-8000-000000000001';

let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
const film = o => ({ id: nid('f'), collection: 'movies', title: 'Film', theme: 'Drama', status: 'confirmed', watched: false,
  media_type: 'movie', tmdb_id: 900 + n, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });
const CHOICES = [['Robin', 'Robin R.'], ['Sam', 'Sam']].map(([token, label], i) => ({
  id: `0e000000-0000-4000-8000-00000000000${i + 1}`, token, label, sort_order: i + 1, archived_at: null, created_at: '2026-10-06T00:00:00+00:00' }));

const rich = () => film({ id: 'f-rich', title: 'A Very Long Film Title That Keeps Going Well Past One Line', genres: ['Science Fiction', 'Adventure', 'Comedy'],
  forms: ['Animation'], franchises: ['Saga Universe'], collections: ['Toy Story Collection', 'Pixar Favourites', 'Tom Hanks'],
  watch_with: ['Robin', 'Sam'], metadata_owner_set: true });
const plain = () => film({ id: 'f-plain', title: 'Plain', theme: 'Action' }); // no categories, no groups: the original label
const empty = () => film({ id: 'f-empty', title: 'Empty', metadata_owner_set: true }); // Details saved empty: nothing
const boot = (rows = [rich(), plain(), empty()]) => createApp({ rows, tvShows: [], watchWithChoices: CHOICES });
const rowOf = (app, id) => app.el('tbody').innerHTML.split('</tr>').find(r => r.includes(`data-item="${id}"`)) || '';
const cardOf = (app, id) => app.el('cardList').innerHTML.split('<div class="item-card').find(c => c.includes(`data-item="${id}"`)) || '';
const cells = row => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
const pills = h => [...h.matchAll(/data-filter-value="([^"]*)"/g)].map(m => m[1]);
const openMovies = async app => { app.ctx.switchMediaType('movie'); await settle(); app.el('fWatch').value = ''; app.ctx.renderTable(); await settle(); };

test('the header and every row: Title | Genres | Groups | Release | Status | Watched | ⋯', async () => {
  const app = await boot();
  await openMovies(app);
  const head = app.el('tableHead').innerHTML;
  assert.deepStrictEqual([...head.matchAll(/<th class="([^"]+)">/g)].map(m => m[1]), ['col-movie', 'col-genres', 'col-groups', 'col-rel', 'col-status', 'col-watch', 'col-menu']);
  assert.match(head, />Genres<\/th><th class="col-groups">Groups<\/th>/);
  for (const id of ['f-rich', 'f-plain', 'f-empty']) assert.strictEqual(cells(rowOf(app, id)).length, 7, id);
  assert.deepStrictEqual(app.writes(), []);
});

test('genres (and forms) in Genres, franchises, collection tags and people in Groups, in their order; nothing under the title', async () => {
  const app = await boot();
  await openMovies(app);
  const [title, genres, groups, date, status, watch, menu] = cells(rowOf(app, 'f-rich'));
  assert.ok(!/ro-labels|filter-pill/.test(title), 'no pill line under the title');
  assert.match(title, /A Very Long Film Title/);
  assert.deepStrictEqual(pills(genres), ['Science Fiction', 'Adventure', 'Comedy', 'Animation']);
  assert.match(genres, /class="badge meta-chip meta-genres g-[a-z]+ badge-clickable filter-pill"/, 'the genre colours');
  assert.deepStrictEqual(pills(groups), ['Saga Universe', 'Toy Story', 'Pixar Favourites', 'Tom Hanks', 'Robin', 'Sam']);
  assert.match(groups, /meta-franchises[\s\S]*class="collection-tag collection-tag-clickable filter-pill"[\s\S]*class="ww-tag ww-tag-clickable filter-pill"[^>]*>Robin R\.</);
  assert.match(date, /Jan 1, 2020/);
  assert.match(status, /data-action="status"/);
  assert.match(watch, /Mark watched/);
  assert.match(menu, /class="more-btn"/);
  // Each line has its own +N, hidden until measured.
  assert.match(genres, /^<div class="movie-pill-line" data-col="genres">[\s\S]*<button type="button" class="meta-more fit-hidden" data-action="genres-more" aria-expanded="false" aria-label="Show more genres"[^>]*>\+<\/button><\/div>$/);
  assert.match(groups, /data-action="groups-more" aria-expanded="false" aria-label="Show more groups"/);
  assert.deepStrictEqual(app.writes(), []);
});

test('no categories: the original label in Genres; Details saved empty: nothing; no groups: an empty cell; one pill: no +N', async () => {
  const app = await boot([plain(), empty(), film({ id: 'f-one', title: 'One', genres: ['Drama'], metadata_owner_set: true, collections: ['Solo'] })]);
  await openMovies(app);
  const p = cells(rowOf(app, 'f-plain'));
  assert.deepStrictEqual(pills(p[1]), ['Action']);
  assert.strictEqual(p[2], '', 'no groups');
  const e = cells(rowOf(app, 'f-empty'));
  assert.strictEqual(e[1], ''); assert.strictEqual(e[2], '');
  const o = cells(rowOf(app, 'f-one'));
  assert.ok(!/meta-more/.test(o[1] + o[2]), 'a single pill has no +N');
  assert.ok(!cardOf(app, 'f-empty').includes('card-labels'), 'an empty card has no pill lines');
});

test('+N per row and column: Fewer shows every pill in that line only; focus stays on it; pills still filter', async () => {
  const app = await boot();
  await openMovies(app);
  const dom = makeMiniDom(app);
  dom.hide('cardList');
  const sel = '[data-item="f-rich"] [data-action="groups-more"]';
  dom.focus('tbody', sel);
  app.ctx.toggleMoviePillLine('f-rich::groups'); await settle();
  const [, genres, groups] = cells(rowOf(app, 'f-rich'));
  assert.match(groups, /aria-expanded="true" aria-label="Show fewer groups"[^>]*>Fewer<\/button>/);
  assert.match(genres, /aria-expanded="false" aria-label="Show more genres"/, 'the other column stays folded');
  assert.strictEqual(dom.active(), dom.in('tbody', sel), 'focus stays on the button');
  app.ctx.toggleMoviePillLine('f-rich::groups'); await settle();
  assert.match(cells(rowOf(app, 'f-rich'))[2], /aria-expanded="false"/);
  // A group pill filters as before.
  app.ctx.toggleFilterSelect('fCollection', 'Pixar Favourites'); await settle();
  assert.deepStrictEqual([...app.el('tbody').innerHTML.matchAll(/data-item="([^"]+)"/g)].map(m => m[1]), ['f-rich']);
  assert.match(cells(rowOf(app, 'f-rich'))[2], /data-filter-value="Pixar Favourites"[^>]*aria-pressed="true"/);
  app.ctx.toggleFilterSelect('fGenre', 'Comedy'); await settle();
  assert.match(cells(rowOf(app, 'f-rich'))[1], /data-filter-value="Comedy"[^>]*aria-pressed="true"/);
  assert.deepStrictEqual(app.writes(), []);
});

test('the card: date, then Genres, then Groups, each its own line with every pill', async () => {
  const app = await boot();
  await openMovies(app);
  const card = cardOf(app, 'f-rich');
  assert.match(card, /^ movie-card/);
  const g = card.match(/<span class="card-labels movie-card-genres"><span class="visually-hidden">Genres: <\/span>([\s\S]*?)<\/span>\s*<span class="card-labels movie-card-groups">/);
  assert.ok(g, 'genres before groups');
  assert.deepStrictEqual(pills(g[1]), ['Science Fiction', 'Adventure', 'Comedy', 'Animation']);
  const gr = card.match(/movie-card-groups"><span class="visually-hidden">Groups: <\/span>([\s\S]*?)<\/span>\s*<\/div>/);
  assert.deepStrictEqual(pills(gr[1]), ['Saga Universe', 'Toy Story', 'Pixar Favourites', 'Tom Hanks', 'Robin', 'Sam']);
  assert.ok(!/meta-more/.test(card), 'cards have no +N');
});

test('the empty note spans all seven columns; collections keep their six-column film rows', async () => {
  const app = await boot([film({ id: 'f-z', title: 'Zeta', collection: 'disney', media_type: null, tmdb_id: null, theme: 'Star Wars',
    collections: ['Star Wars Collection'], genres: ['Action'], metadata_owner_set: true })]);
  await openMovies(app);
  app.el('fSearch').value = 'nothing like this'; app.ctx.renderTable(); await settle();
  assert.match(app.el('tbody').innerHTML, /<td colspan="7"/);
  app.el('fSearch').value = '';
  app.ctx.openBrowseCollection(DISNEY); await settle();
  assert.ok(!/col-genres/.test(app.el('tableHead').innerHTML), 'the collection header is its own');
  const row = rowOf(app, 'f-z');
  assert.strictEqual(cells(row).length, 6);
  assert.match(row, /class="ro-labels"/, 'a collection film keeps its tag line');
  assert.ok(!/movie-pill-line|movie-card/.test(app.el('tbody').innerHTML + app.el('cardList').innerHTML));
  assert.deepStrictEqual(app.writes(), []);
});

T.run();
