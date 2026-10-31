// Offline tests for the density work and the toolbar's TMDB search: Enter or the button only, reading
// TMDB and nothing else; adding stays the panel's own, confirmed in its preview; from a collection the
// library comes first and the collection is a separate, explicit step. Cards, the compact collection
// header and the tab row are covered as far as markup goes; measured layout is a browser check.
// The model is the harness's in-memory one, not the database. Run from the repo root: node tests/density-search.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('density-search');
const test = T.test;
const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
function show(o, nums) {
  const s = { id: nid('show'), collection: 'truecrime', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: null, status: 'confirmed', ...o };
  const rows = nums.map(num => ({ id: nid('r'), collection: s.collection, title: s.title, theme: 'Net', status: 'pending', watched: false, skipped: false,
    show_id: s.id, media_type: 'tv', tmdb_id: s.tmdb_id, season_number: s.tmdb_id == null ? null : num, season: `Season ${num}`, display_date: `Jan 1, ${2010 + num}`,
    date_sort: `${2010 + num}-01-01`, item_key: `${s.show_key}|season ${num}`, watch_with: [], collections: [] }));
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'othertv', title: 'Film', theme: 'Doc', status: 'confirmed', watched: false, media_type: 'movie', tmdb_id: null,
  season_number: null, season: 'Film', display_date: 'Jan 1, 2015', date_sort: '2015-01-01', item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });

const TMDB = {
  '/tv/9001': { id: 9001, name: 'Lantern Bay', first_air_date: '2022-01-01', networks: [{ name: 'Net' }], genres: [], vote_average: 8.2, vote_count: 950,
    seasons: [{ season_number: 1, episode_count: 8, air_date: '2022-01-01' }, { season_number: 2, episode_count: 8, air_date: '2023-01-01' }] },
  '/tv/9002': { id: 9002, name: 'Saved Show', first_air_date: '2012-01-01', networks: [{ name: 'Net' }], genres: [],
    seasons: [{ season_number: 1, episode_count: 8, air_date: '2011-01-01' }, { season_number: 2, episode_count: 8, air_date: '2012-01-01' }] },
  '/movie/9101': { id: 9101, title: 'Lantern Film', release_date: '2024-06-01', genres: [], production_companies: [] },
  '/movie/9102': { id: 9102, title: 'Saved Film', release_date: '2015-01-01', genres: [], production_companies: [] }
};
const tmdb = p => {
  if (p.startsWith('/search/')) {
    const q = decodeURIComponent((p.match(/query=([^&]*)/) || [])[1] || '').toLowerCase();
    const tv = Object.values(TMDB).filter(x => x.name && x.name.toLowerCase().includes(q)).map(x => ({ id: x.id, name: x.name, first_air_date: x.first_air_date }));
    const mv = Object.values(TMDB).filter(x => x.title && x.title.toLowerCase().includes(q)).map(x => ({ id: x.id, title: x.title, release_date: x.release_date }));
    return { results: p.startsWith('/search/tv') ? tv : mv };
  }
  return TMDB[p];
};
function lib() {
  const L = {};
  L.member = show({ title: 'Member Show' }, [1]);
  L.saved = show({ title: 'Saved Show', collection: 'othertv', tmdb_id: 9002 }, [1]);
  L.savedFilm = film({ title: 'Saved Film', tmdb_id: 9102 });
  L.memberFilm = film({ title: 'Member Film', collection: 'truecrime' });
  L.data = { rows: [...L.member.rows, ...L.saved.rows, L.savedFilm, L.memberFilm], shows: [L.member.show, L.saved.show] };
  return L;
}
const boot = (L = lib(), opts = {}) => createApp({ rows: L.data.rows, tvShows: L.data.shows, tmdb, ...opts });
const TC = app => app.browseId('truecrime');
const CID = app => TC(app).split(':')[1];
async function openTC(app) { app.ctx.openBrowseCollection(TC(app)); await settle(); }
const searches = app => app.requests.filter(r => /\/search\/(tv|movie)/.test(r.url));
const rpc = (app, fn) => app.requests.filter(r => r.url.endsWith(`/rpc/${fn}`));
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const outcome = app => text(app.el('libraryOutcome').innerHTML);
const preview = app => text(app.el('tmdbPreview').innerHTML);
const tick = (app, nums) => { app.el('tmdbPreview').querySelectorAll = sel => (sel.includes('data-season') ? nums.map(x => ({ checked: true, disabled: false, dataset: { season: String(x) } })) : []); };
const results = app => app.el('tmdbResults').innerHTML;
async function quick(app, media, q) {
  app.el('tmdbQuickQuery').value = q;
  await app.ctx.tmdbQuickSubmit(media); await settle();
}
const choose = async (app, id, name, type) => { await app.ctx.selectTMDBShow(id, name, type, `tmdbResult_0_${id}`); await settle(); };

test('the field: in the toolbar before + Add, named, Enter or its button only; typing fetches nothing', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  const f = app.el('filtersRow').innerHTML;
  assert.ok(f.includes('<form class="tmdb-quick" role="search" onsubmit="event.preventDefault(); tmdbQuickSubmit(\'tv\')">'));
  assert.ok(f.includes('placeholder="Search TMDB to add…" aria-label="Search TMDB to add"'));
  assert.ok(f.includes('<button type="submit" class="tmdb-quick-go" aria-label="Search TMDB">'));
  assert.ok(f.indexOf('tmdb-quick') < f.indexOf('add-open-btn'), 'page order');
  assert.ok(f.includes('oninput="tmdbQuickText = this.value"'), 'typing only keeps the text');
  assert.ok(!/oninput="[^"]*(searchTMDB|tmdbFetch|tmdbQuickSubmit)/.test(f));
  const before = app.requests.length;
  app.ctx.document.getElementById('tmdbQuickQuery').value = 'lantern';
  await settle();
  assert.strictEqual(app.requests.length, before, 'no request of any kind while typing');
  await quick(app, 'tv', '   ');
  assert.strictEqual(app.requests.length, before, 'an empty search sends nothing and opens nothing');
  assert.strictEqual(app.get('libraryPanel'), null);
});

test('the library search keeps its scope and gets its name; the visible text is short', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  assert.ok(app.el('filtersRow').innerHTML.includes('id="fSearch" type="text" placeholder="Search library…" aria-label="Search my library" oninput="renderTable()"'));
});

test('the field is desktop only and hidden, not squeezed, in narrower pages; phones have one search field', () => {
  assert.match(css, /\.tmdb-quick \{ display: none;/);
  assert.match(css, /@media \(min-width: 1100px\) \{\s*\.tmdb-quick \{ display: flex;/);
  assert.match(css, /@media \(min-width: 1100px\) and \(max-width: 1239px\) \{\s*\.filters:has\(\.browse-controls\) \.tmdb-quick \{ display: none; \}/);
});

test('a TV view: Enter fills the panel and reads TMDB; choosing previews; neither writes; adding is the panel\'s confirmed action', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  const writes = app.writes().length;
  await quick(app, 'tv', 'lantern');
  assert.strictEqual(searches(app).length, 2, 'one search, TV and film, as the panel does');
  assert.strictEqual(app.el('tmdbQuery').value, 'lantern');
  assert.ok(app.el('libraryPanel').innerHTML.includes('Add TV'), 'the normal panel');
  assert.ok(results(app).indexOf('Lantern Bay') < results(app).indexOf('Lantern Film'), 'series first in a TV view; the other kind stays available');
  await choose(app, 9001, 'Lantern Bay', 'tv');
  assert.match(preview(app), /Adds a new show to your list/);
  assert.strictEqual(app.writes().length, writes, 'searching and previewing write nothing');
  tick(app, [1]);
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.strictEqual(rpc(app, 'library_create_show_b45').length, 1, 'the existing write, once');
  assert.strictEqual(rpc(app, 'org_add_membership').length, 0, 'no collection step outside a collection');
  assert.doesNotMatch(outcome(app), /in your library but not in/);
});

test('Movies lists films first, and the chosen result decides the media type', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  await quick(app, 'movie', 'lantern');
  assert.ok(results(app).indexOf('Lantern Film') < results(app).indexOf('Lantern Bay'));
  await choose(app, 9101, 'Lantern Film', 'movie');
  assert.match(preview(app), /Adds a new film to your list/);
});

test('a mixed collection shows both kinds, each tagged; the panel says the order and that the collection needs confirming', async () => {
  const app = await boot();
  await openTC(app);
  const f = app.el('filtersRow').innerHTML;
  assert.ok(f.includes('tmdbQuickSubmit(\'mixed\')'));
  assert.ok(f.includes('aria-label="Search TMDB to add to your library, then choose collections for True Crime / Docs"'));
  await quick(app, 'mixed', 'lantern');
  const panel = text(app.el('libraryPanel').innerHTML);
  assert.match(panel, /Add to library, then choose collections/);
  assert.match(panel, /Adding to your library comes first\. True Crime \/ Docs is preselected at the next step, and it’s only added when you confirm there\./);
  assert.ok(!app.el('libraryPanel').innerHTML.includes('How to add'), 'search only');
  assert.ok(results(app).includes('tmdb-type-movie') && results(app).includes('tmdb-type-tv'));
  assert.ok(!app.el('libraryPanel').innerHTML.includes('then Disney'));
});

test('from a collection: the library add leaves the collection preselected, unsaved and said so; only the button adds it, there and nowhere else', async () => {
  const app = await boot();
  await openTC(app);
  await quick(app, 'mixed', 'lantern');
  await choose(app, 9101, 'Lantern Film', 'movie');
  const before = app.store.collection_memberships.length;
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.strictEqual(rpc(app, 'library_add_films_b45').length, 1);
  assert.strictEqual(rpc(app, 'org_add_membership').length, 0, 'the library add sends no membership');
  assert.strictEqual(app.store.collection_memberships.length, before);
  const box = app.el('libraryOutcome').innerHTML;
  assert.match(text(box), /Added “Lantern Film”\..*“Lantern Film” is in your library but not in True Crime \/ Docs yet\. Press Add to collections to add it:/);
  assert.ok(box.includes(`data-collection-id="${CID(app)}" checked>`), 'this collection is preselected');
  assert.strictEqual((box.match(/ checked>/g) || []).length, 1, 'and no other');
  // A tick changes nothing either: the boxes have no handler of their own.
  assert.ok(!/<input type="checkbox"[^>]*on(change|click)=/.test(box));
  assert.strictEqual(rpc(app, 'org_add_membership').length, 0);
  app.el('libraryOutcome').querySelectorAll = () => [{ checked: true, dataset: { collectionId: CID(app) } }];
  await app.ctx.libraryAddMemberships(); await settle();
  assert.deepStrictEqual(rpc(app, 'org_add_membership').map(r => r.body.p_collection_id), [CID(app)]);
  assert.match(outcome(app), /“Lantern Film” is saved\. Added to True Crime \/ Docs\./);
});

test('an unticked collection, a closed panel and a refused or unanswered membership never claim the title is in the collection', async () => {
  // Nothing ticked: nothing is sent.
  let app = await boot();
  await openTC(app);
  await quick(app, 'mixed', 'lantern');
  await choose(app, 9101, 'Lantern Film', 'movie');
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  app.el('libraryOutcome').querySelectorAll = () => [{ checked: false, dataset: { collectionId: CID(app) } }];
  await app.ctx.libraryAddMemberships(); await settle();
  assert.strictEqual(rpc(app, 'org_add_membership').length, 0);
  // Refused: the addition stands, and the outcome says what happened.
  app = await boot();
  await openTC(app);
  await quick(app, 'mixed', 'lantern');
  await choose(app, 9101, 'Lantern Film', 'movie');
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  app.el('libraryOutcome').querySelectorAll = () => [{ checked: true, dataset: { collectionId: CID(app) } }];
  app.refuseNext(r => r.url.endsWith('/rpc/org_add_membership'), 'P0001', 'org_target_missing: gone');
  await app.ctx.libraryAddMemberships(); await settle();
  assert.match(outcome(app), /“Lantern Film” is saved\. Couldn’t add to True Crime \/ Docs/);
  assert.strictEqual(rpc(app, 'org_add_membership').length, 1, 'not resent');
  assert.ok(app.store.watchlist_items.some(r => r.title === 'Lantern Film'), 'the library addition stands');
  // No clear answer: said so, not resent, and not reported as added.
  app = await boot();
  await openTC(app);
  await quick(app, 'mixed', 'lantern');
  await choose(app, 9101, 'Lantern Film', 'movie');
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  app.el('libraryOutcome').querySelectorAll = () => [{ checked: true, dataset: { collectionId: CID(app) } }];
  const lost = app.hold(r => r.url.endsWith('/rpc/org_add_membership'));
  const sent = app.ctx.libraryAddMemberships();
  await lost.reached; lost.lose('after'); await sent; await settle();
  assert.match(outcome(app), /“Lantern Film” is saved\. True Crime \/ Docs: no clear answer came back, so it isn’t confirmed; check in Manage\./);
  assert.doesNotMatch(outcome(app), /Added to True Crime/);
  assert.strictEqual(rpc(app, 'org_add_membership').length, 1);
});

test('the panel closed while adding: the notice says the title is in the library, not in the collection', async () => {
  const app = await boot();
  await openTC(app);
  await quick(app, 'mixed', 'lantern');
  await choose(app, 9101, 'Lantern Film', 'movie');
  const g = app.hold(r => r.url.endsWith('/rpc/library_add_films_b45'));
  const add = app.ctx.addSelectedTMDBSeasons();
  await g.reached;
  app.ctx.closeLibraryPanel();
  g.release(); await add; await settle();
  assert.match(text(app.el('noticeBanner').innerHTML + app.el('banner').innerHTML), /Added “Lantern Film”\..*It isn’t in True Crime \/ Docs\./);
  assert.strictEqual(rpc(app, 'org_add_membership').length, 0);
});

test('already saved: nothing to add, and the collection step is the existing picker with the title selected', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  await quick(app, 'mixed', 'saved');
  await choose(app, 9102, 'Saved Film', 'movie');
  assert.match(preview(app), /Already on your list\. Nothing to add\..*“Saved Film” isn’t in True Crime \/ Docs\./);
  assert.ok(app.el('tmdbPreview').innerHTML.includes(`openAddPicker(this, ['i:${L.savedFilm.id}'])`));
  const w = app.writes().length;
  app.ctx.openAddPicker({ id: 'x', isConnected: true, focus() {} }, [`i:${L.savedFilm.id}`]);
  assert.strictEqual(app.writes().length, w, 'opening writes nothing');
  assert.deepStrictEqual(JSON.parse(app.get('JSON.stringify([...addPicker.selected])')), [`i:${L.savedFilm.id}`], 'selected, and Add is still the owner\'s');
  app.ctx.closeAddPicker();
  await choose(app, 9002, 'Saved Show', 'tv');
  assert.match(preview(app), /Adds seasons to “Saved Show”, already on your list\..*“Saved Show” isn’t in True Crime \/ Docs\./);
  assert.ok(app.el('tmdbPreview').innerHTML.includes(`openAddPicker(this, ['s:${L.saved.show.id}'])`), 'a show too');
});

test('already in the collection: said so, with nothing offered; a stale collection refuses the follow-up', async () => {
  const L = lib();
  L.memberMatched = show({ title: 'Lantern Bay', tmdb_id: 9001 }, [1]);
  L.data.rows.push(...L.memberMatched.rows); L.data.shows.push(L.memberMatched.show);
  let app = await boot(L);
  await openTC(app);
  await quick(app, 'mixed', 'lantern');
  await choose(app, 9001, 'Lantern Bay', 'tv');
  assert.match(preview(app), /Already in True Crime \/ Docs\./);
  assert.ok(!app.el('tmdbPreview').innerHTML.includes('openAddPicker'));
  app = await boot();
  await openTC(app);
  await quick(app, 'mixed', 'saved');
  app.get('listStale = true');
  await choose(app, 9102, 'Saved Film', 'movie');
  assert.match(preview(app), /It can’t be added right now: the collection may be out of date\./);
  assert.ok(!app.el('tmdbPreview').innerHTML.includes('openAddPicker'));
});

test('the list changed since the preview: refused with nothing sent, from the toolbar\'s search as from the panel\'s', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  await quick(app, 'tv', 'lantern');
  await choose(app, 9001, 'Lantern Bay', 'tv');
  tick(app, [1]);
  app.store.tv_shows.push({ ...lib().member.show, id: 'late', title: 'Lantern Bay', tmdb_id: 9001, show_key: 'lantern bay' });
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.strictEqual(rpc(app, 'library_create_show_b45').length, 0);
  assert.match(outcome(app), /Your list changed since this preview, so nothing was added/);
});

test('keyboard: results are buttons, focus moves to the first; a chosen preview takes focus itself, never its Add; Close returns to the field', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  await quick(app, 'tv', 'lantern');
  assert.match(results(app), /class="tmdb-result-item" id="tmdbResult_0_9001" role="button" tabindex="0" onkeydown="tmdbResultKeydown\(event\)"/);
  let clicks = 0, prevented = 0;
  const key = k => app.ctx.tmdbResultKeydown({ key: k, currentTarget: { click() { clicks++; } }, preventDefault() { prevented++; } });
  key('Enter'); key(' '); key('a');
  assert.deepStrictEqual([clicks, prevented], [2, 2]);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'tmdb-search.js'), 'utf8'), /previewContainer\.tabIndex = -1;/);
  const field = app.el('tmdbQuickQuery'); let focused = 0; field.focus = () => { focused++; };
  app.ctx.libraryPanelClose();
  assert.strictEqual(app.get('libraryPanel'), null);
  assert.strictEqual(focused, 1);
});

test('a toolbar redraw keeps the typed search; a view change clears it', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  app.get("tmdbQuickText = 'half typ'");
  app.ctx.renderFilters();
  assert.ok(app.el('filtersRow').innerHTML.includes('value="half typ"'));
  app.ctx.switchView('watching'); await settle();
  assert.strictEqual(app.get('tmdbQuickText'), '');
});

test('the collection header: both meanings of the note, a collection\'s own note first, the title, Back and Edit; + Add is named and in the toolbar', async () => {
  const app = await boot();
  await openTC(app);
  const h = app.el('viewHead').innerHTML;
  assert.match(h, /<h2 class="browse-title">/);
  assert.match(text(h), /True Crime and Documentary are not yet classified separately\. Changes here apply everywhere in your library\. Remove takes a title out of True Crime \/ Docs only\./);
  assert.ok(!h.includes('collectionAddBtn'));
  assert.ok(app.el('filtersRow').innerHTML.indexOf('tmdb-quick') < app.el('filtersRow').innerHTML.indexOf('collectionAddBtn'));
});

test('collection tabs: one scrolling row at every width, 44 px, full names available, arrows for the mouse only', async () => {
  const app = await boot();
  await openTC(app);
  const b = app.el('browseBar').innerHTML;
  assert.match(b, /class="tabs-scroll tabs-left" tabindex="-1" aria-hidden="true"/);
  assert.match(b, /title="True Crime \/ Docs"/);
  assert.match(css, /\.collection-tabs \{ display: flex;[^}]*overflow-x: auto;/);
  assert.ok(!/\.collection-tabs \{[^}]*flex-wrap: wrap/.test(css));
  assert.match(css, /\.collection-tab \{ flex: 1 0 auto;[^}]*white-space: nowrap; \}/, 'on phones too, where .tab otherwise lets labels shrink and wrap');
  assert.match(css, /\.collection-tab \{[^}]*min-width: 44px; min-height: 44px;[^}]*text-overflow: ellipsis;/);
});

test('"Film" stays only where a list mixes films with TV; Movies and separated sections drop it', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  assert.ok(!app.el('cardList').innerHTML.includes('<span class="card-season">Film</span>') && !app.el('tbody').innerHTML.includes(' · Film'));
  await openTC(app);
  assert.ok(!app.el('cardList').innerHTML.includes('<span class="card-season">Film</span>'), 'Separate: the Movies section says it');
  app.ctx.setBrowseGrouping('combined'); await settle();
  assert.ok(app.el('cardList').innerHTML.includes('<span class="card-season">Film</span>') && app.el('tbody').innerHTML.includes(' · Film'), 'Combined keeps it');
});

test('phone cards keep their controls and explicit progress; between phone and table widths the list is two columns of cards', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  const c = app.el('cardList').innerHTML;
  assert.ok(c.includes('card-meta') && c.includes('card-progress') && /seasons? watched/.test(c));
  assert.match(css, /@media \(min-width: 701px\) and \(max-width: 1099px\) \{\s*\.card-list \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /@media \(max-width: 1099px\) \{\s*#desktopTable \{ display: none; \}/);
  assert.match(css, /\.card-list > \.item-card:has\(\.card-subseasons\) \{ grid-column: 1 \/ -1; \}/);
  assert.match(css, /\.tmdb-rating \{ position: relative; z-index: 1; min-height: 44px; min-width: 44px;/);
});

T.run();
