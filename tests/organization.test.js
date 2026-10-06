// Offline tests for personal organization (Stage 3b-1): the Browse selector loads
// your collections at startup without holding up the first view; collections list
// their members (never the storage tab); archived collections are hidden and a
// renamed one keeps its device layout; watch-with shows labels and stores tokens;
// backup format 3 and its validation; format 2 refused before anything happens;
// Match never applies a collection expansion silently; and the app against a
// database without personal collections. Run from the repo root:
//   node tests/organization.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('organization');
const test = T.test;

const uuid = (p, n) => `${p}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = Object.fromEntries(['disney', 'sheridan', '90day', 'truecrime'].map((k, i) => [k, `browse:0c000000-0000-4000-8000-00000000000${i + 1}`]));
const TS = '2026-10-01T00:00:00+00:00';
let n = 0;
const show = (o, seasons) => {
  const id = uuid('5a', ++n);
  const s = { id, collection: 'disney', title: 'Show', show_key: (o.title || 'show').toLowerCase(), tmdb_id: null, status: 'confirmed', created_at: TS, ...o };
  const rows = seasons.map((label, i) => ({ id: uuid('5b', ++n), collection: s.collection, item_key: `${s.show_key}|${label.toLowerCase()}`, title: s.title,
    season: label, theme: 'Drama', display_date: 'Jan 1, 2020', date_sort: '2020-01-01', watched: false, status: 'confirmed', created_at: TS,
    watch_with: [], collections: [], tmdb_collection_id: null, tmdb_collection_name: null, media_type: null, tmdb_id: null, season_number: null,
    show_id: id, skipped: false }));
  return { show: s, rows };
};
const film = o => ({ id: uuid('f0', ++n), collection: 'movies', item_key: `film ${n}|film`, title: 'Film', season: 'Film', theme: 'Drama',
  display_date: 'Jan 1, 2020', date_sort: '2020-01-01', watched: false, status: 'confirmed', created_at: TS, watch_with: [], collections: [],
  tmdb_collection_id: null, tmdb_collection_name: null, media_type: 'movie', tmdb_id: 7000 + n, season_number: null, show_id: null, skipped: false, ...o });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) });
function library() {
  return all(
    show({ title: 'Andor', status: 'watching' }, ['Season 1', 'Season 2']),
    show({ title: 'Tulsa King', collection: 'sheridan' }, ['Season 1']),
    show({ title: 'Severance', collection: 'othertv', tmdb_id: 95396 }, ['Season 1']),
    film({ title: 'Sicario', collection: 'sheridan', media_type: null, tmdb_id: null }),
    film({ title: 'Wind River', watch_with: ['Rina', 'Kids'] }),
    film({ title: 'Dune', watch_with: ['Suzanne'] })
  );
}
const boot = (data = library(), opts = {}) => createApp({ rows: data.rows, tvShows: data.shows, ...opts });
const open = async (app, id) => { app.ctx.openBrowseCollection(id); await settle(); };
const html = app => app.el('tbody').innerHTML;
const titles = app => [...html(app).matchAll(/<span class="show-title">([^<]*)<\/span>/g)].map(m => m[1]);
const options = app => [...app.el('browseBar').innerHTML.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map(m => [m[1], m[2]]);
const writes = app => app.requests.filter(r => r.method !== 'GET');
const coll = (app, source) => app.store.personal_collections.find(c => c.legacy_source === source);

// ── shared lists ──
test('the configured watch-with choices, the harness bootstrap and the migration bootstrap list the same values', async () => {
  const app = await boot();
  const config = Array.from(app.get('WATCH_WITH_OPTIONS'));
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'phase3b_org.sql'), 'utf8');
  const inSql = JSON.parse(sql.match(/v_config text\[\] := array\[([^\]]*)\]/)[1].replace(/'/g, '"').replace(/^/, '[').replace(/$/, ']'));
  const inRollback = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'rollback', 'phase3b.sql'), 'utf8')
    .match(/v_config text\[\] := array\[([^\]]*)\]/)[1].replace(/'/g, '"').replace(/^/, '[').replace(/$/, ']'));
  assert.deepStrictEqual(inSql, config);
  assert.deepStrictEqual(inRollback, config);
  assert.deepStrictEqual(app.store.watch_with_choices.slice(0, 4).map(c => c.token), config);
  assert.deepStrictEqual(app.store.watch_with_choices.slice(4).map(c => c.token), ['Kids'], 'a value used on a row but not configured is kept as a choice');
});

// ── selector ──
test('startup: the TV landing view comes first; the selector then lists your collections in order, valued by collection id', async () => {
  const app = await boot();
  const urls = app.requests.map(r => new URL(r.url).pathname.split('/').pop());
  assert.ok(urls.indexOf('watchlist_items') < urls.indexOf('personal_collections'), 'the first view’s read is sent before the organization read');
  assert.strictEqual(app.get('orgState'), 'ready');
  assert.deepStrictEqual(options(app), [['', 'Choose a collection…'], [B.disney, 'Disney+'], [B.sheridan, 'Sheridan'], [B['90day'], '90 Day'], [B.truecrime, 'True Crime / Docs']]);
  assert.strictEqual(writes(app).length, 0);
});

test('while collections load the selector says so; the current view keeps working; a failed load says unavailable with Retry, never an empty list', async () => {
  const app = await boot();
  const g = app.hold(r => r.url.includes('/personal_collections?'));
  const loading = app.ctx.loadOrganization();
  await g.reached;
  assert.match(app.el('browseBar').innerHTML, /<select id="browseSelect" disabled><option value="" selected>Loading collections…<\/option>/);
  app.ctx.switchView('alltv'); await settle();
  assert.ok(app.el('tbody').innerHTML.includes('Andor'), 'All TV renders while collections are loading');
  g.release(); await loading; await settle();
  assert.strictEqual(options(app).length, 5);
  app.failNext(r => r.url.includes('/personal_collections?'));
  await app.ctx.loadOrganization(); await settle();
  assert.strictEqual(app.get('orgState'), 'unavailable');
  assert.match(app.el('browseBar').innerHTML, /Collections unavailable<\/option><\/select> <button class="btn" onclick="loadOrganization\(\)">Retry<\/button>/);
  assert.ok(!options(app).some(([v]) => v.startsWith('browse:')));
  await app.ctx.loadOrganization(); await settle();
  assert.strictEqual(options(app).length, 5);
});

test('archived collections are hidden; a renamed collection shows its new name and keeps its device layout key; a new one uses its id', async () => {
  const data = library();
  const pcs = ['disney', 'sheridan', '90day', 'truecrime'].map((src, i) => ({ id: uuid('0c', i + 1), name: ['Disney+', 'Sheridan', '90 Day', 'True Crime / Docs'][i],
    legacy_source: src, sort_order: i + 1, archived_at: null, created_at: TS }));
  pcs[0].name = 'Mouse House';
  pcs[2].archived_at = TS;
  pcs.push({ id: uuid('0c', 9), name: 'Anime', legacy_source: null, sort_order: 0, archived_at: null, created_at: TS });
  const app = await boot(data, { personalCollections: pcs });
  assert.deepStrictEqual(options(app).map(o => o[1]), ['Choose a collection…', 'Anime', 'Mouse House', 'Sheridan', 'True Crime / Docs']);
  const store = { data: { watchlist_browse_layout_disney: '{"presentation":"seasons","grouping":"combined"}' }, writes: [] };
  app.ctx.localStorage = { getItem: k => store.data[k] ?? null, setItem: (k, v) => { store.writes.push(k); store.data[k] = v; } };
  await open(app, B.disney);
  assert.strictEqual(app.get('browsePresentation'), 'seasons', 'the renamed Disney+ reads its old layout key');
  assert.ok(app.el('viewHead').innerHTML.includes('Mouse House — All media'));
  app.ctx.setBrowseGrouping('separate'); await settle();
  await open(app, `browse:${uuid('0c', 9)}`);
  app.ctx.setBrowsePresentation('seasons'); await settle();
  assert.deepStrictEqual(store.writes, ['watchlist_browse_layout_disney', `watchlist_browse_layout_id_${uuid('0c', 9)}`]);
  assert.ok(html(app).includes('No TV shows saved in Anime.'), 'an empty collection says so');
});

test('a collection archived after the selector loaded: entering it says it isn’t available, with Back; nothing is written', async () => {
  const app = await boot();
  coll(app, 'sheridan').archived_at = TS;
  await open(app, B.sheridan);
  assert.ok(html(app).includes('This collection isn’t available any more.'));
  assert.ok(app.el('viewHead').innerHTML.includes('browseBack()'));
  assert.ok(!options(app).some(([v]) => v === B.sheridan), 'the selector drops it after the fresh read');
  assert.strictEqual(writes(app).length, 0);
});

// ── membership, not storage ──
test('collections list their members only: a removed membership hides a show there but not in its tab or All TV; members from other tabs appear with their source', async () => {
  const data = library();
  const app = await boot(data);
  const andor = data.shows.find(s => s.title === 'Andor');
  const severance = data.shows.find(s => s.title === 'Severance');
  const dune = data.rows.find(r => r.title === 'Dune');
  app.store.collection_memberships = app.store.collection_memberships.filter(m => m.show_id !== andor.id);
  app.store.collection_memberships.push({ id: uuid('0d', 900), collection_id: coll(app, 'sheridan').id, show_id: severance.id, item_id: null, created_at: TS },
    { id: uuid('0d', 901), collection_id: coll(app, 'disney').id, show_id: null, item_id: dune.id, created_at: TS });
  await open(app, B.disney);
  assert.ok(!titles(app).includes('Andor'), 'not a member any more');
  assert.ok(titles(app).includes('Dune'), 'a film stored in Movies, added to Disney+');
  await open(app, B.sheridan);
  assert.ok(titles(app).includes('Severance') && html(app).includes('Other TV'), 'an Other TV show in Sheridan, badged with its tab');
  assert.strictEqual(writes(app).length, 0, 'the collection views wrote nothing');
  app.ctx.switchTab('disney'); await settle(); // (the legacy tab seeds its missing defaults, as before)
  assert.ok(app.el('tbody').innerHTML.includes('Andor'), 'the legacy tab still shows what it stores');
  app.ctx.switchView('alltv'); await settle();
  assert.ok(app.el('tbody').innerHTML.includes('Andor'));
});

test('the membership-based view equals the storage-based one while memberships match the tabs (counts, order, markup)', async () => {
  const app = await boot();
  await open(app, B.disney);
  assert.deepStrictEqual(titles(app), ['Andor']);
  await open(app, B.sheridan);
  assert.deepStrictEqual(titles(app), ['Tulsa King', 'Sicario']);
  assert.match(app.el('statsRow').innerHTML, /stat-num">1<\/div><div class="stat-label">Show</);
});

// ── watch-with ──
test('watch-with: labels from your choices, tokens in the data; an archived choice isn’t offered but stays visible where used; an undefined value is refused and rolled back', async () => {
  const data = library();
  const app = await boot(data);
  app.store.watch_with_choices.find(c => c.token === 'Rina').label = 'Rina S.';
  app.store.watch_with_choices.find(c => c.token === 'Kids').archived_at = TS;
  await app.ctx.loadOrganization(); await settle();
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.switchTab('movies'); await settle();
  const body = app.el('tbody').innerHTML;
  assert.ok(body.includes('>Rina S.</button>') && !body.includes('>Rina</button>'), 'the tag shows the label');
  assert.ok(/<option value="Rina">Rina S\.<\/option>/.test(app.el('filtersRow').innerHTML), 'the filter offers the label and filters by token');
  assert.ok(!/<option value="Kids">/.test(app.el('filtersRow').innerHTML), 'an archived choice isn’t offered');
  const wind = data.rows.find(r => r.title === 'Wind River');
  const picker = app.get(`watchWithPickerHtml('${wind.id}', ['Rina', 'Kids'])`);
  assert.ok(picker.includes('value="Kids" checked') && picker.includes('> Kids</label>'), 'still visible (and untickable) where it is used');
  await app.ctx.toggleWatchWith(wind.id, 'Suzanne', true); await settle();
  const patch = writes(app).at(-1);
  assert.deepStrictEqual(patch.body, { watch_with: ['Rina', 'Kids', 'Suzanne'] }, 'tokens are written');
  await app.ctx.toggleWatchWith(wind.id, 'Nobody', true); await settle();
  assert.match(app.el('errorBanner') ? app.el('errorBanner').innerHTML : app.get('document.getElementById("errorBanner").innerHTML'), /watch_with_invalid/);
  assert.deepStrictEqual(Array.from(app.store.watchlist_items.find(r => r.id === wind.id).watch_with), ['Rina', 'Kids', 'Suzanne']);
});

// ── backup format 3 ──
test('backup is format 3 with the seven tables and exact columns; never user_id, is_film or item_is_film; it validates', async () => {
  const app = await boot();
  const b = await app.run('buildBackupObject()');
  assert.strictEqual(b.formatVersion, 3);
  assert.deepStrictEqual(Object.keys(b.tables).sort(), ['collection_memberships', 'custom_collections', 'othertv_shows', 'personal_collections', 'tv_shows', 'watch_with_choices', 'watchlist_items']);
  assert.strictEqual(Object.keys(b.tables.watchlist_items[0]).length, 20);
  assert.deepStrictEqual(Object.keys(b.tables.collection_memberships[0]), ['id', 'collection_id', 'show_id', 'item_id', 'created_at']);
  assert.deepStrictEqual(Object.keys(b.tables.personal_collections[0]), ['id', 'name', 'legacy_source', 'sort_order', 'archived_at', 'created_at']);
  assert.deepStrictEqual(Object.keys(b.tables.watch_with_choices[0]), ['id', 'token', 'label', 'sort_order', 'archived_at', 'created_at']);
  assert.ok(Object.values(b.tables).every(rows => rows.every(r => !('user_id' in r) && !('is_film' in r) && !('item_is_film' in r))));
  assert.deepStrictEqual(Array.from(app.get('validateBackupObject')(b)), []);
  assert.ok(app.requests.every(r => r.method === 'GET'));
});

test('format 3 validation mirrors the database: targets, kinds, duplicates, names and labels ignoring case, sources, watch-with values', async () => {
  const data = library();
  const app = await boot(data);
  const good = await app.run('buildBackupObject()');
  const validate = o => Array.from(app.get('validateBackupObject')(o)).join(' | ');
  const variant = fn => { const b = JSON.parse(JSON.stringify(good)); fn(b); return validate(b); };
  const season = data.rows.find(r => r.show_id);
  assert.match(variant(b => { b.tables.collection_memberships[0].show_id = uuid('99', 1); }), /isn't in the backup/);
  assert.match(variant(b => { const m = b.tables.collection_memberships[0]; m.show_id = null; m.item_id = season.id; }), /which isn't a film/);
  assert.match(variant(b => { const m = b.tables.collection_memberships[0]; m.item_id = season.id; }), /exactly one of show_id and item_id/);
  assert.match(variant(b => { b.tables.collection_memberships.push({ ...b.tables.collection_memberships[0], id: uuid('99', 2) }); b.rowCounts.collection_memberships++; }), /collection_memberships duplicate/);
  assert.match(variant(b => { b.tables.collection_memberships[0].collection_id = uuid('99', 3); }), /which isn't in the backup/);
  assert.match(variant(b => { b.tables.personal_collections[1].name = 'disney+'; }), /duplicate name \(ignoring case\)/);
  assert.match(variant(b => { b.tables.personal_collections[1].name = ' Spaced'; }), /personal_collections name/);
  assert.match(variant(b => { b.tables.personal_collections[0].legacy_source = 'othertv'; }), /legacy source/);
  assert.match(variant(b => { b.tables.watch_with_choices[1].label = 'ALONE'; }), /duplicate label \(ignoring case\)/);
  assert.match(variant(b => { b.tables.watch_with_choices = b.tables.watch_with_choices.filter(c => c.token !== 'Rina'); b.rowCounts.watch_with_choices--; }), /uses "Rina", which isn't one of the backup's watch-with choices/);
  assert.match(variant(b => { delete b.tables.collection_memberships; }), /Missing or invalid data for table "collection_memberships"/);
});

test('restore: a format 2 file into this database is refused with guidance before any safety backup, download or write', async () => {
  const src = await boot(library(), { org: false });
  const v2 = await src.run('buildBackupObject()');
  assert.strictEqual(v2.formatVersion, 2);
  const app = await boot();
  app.ctx.__b = v2;
  const before = app.requests.length;
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)');
  assert.match(app.el('restoreModalBox').innerHTML, /format 2, from before personal collections/);
  assert.match(app.el('restoreModalBox').innerHTML, /Restore a format 3 backup/);
  assert.strictEqual(app.get('pendingRestoreData'), null);
  assert.ok(app.requests.slice(before).every(r => r.method === 'GET'));
});

test('restore: a format 3 file goes through as one restore_backup call with the whole backup, then verifies all seven tables', async () => {
  const app = await boot();
  const b = await app.run('buildBackupObject()');
  app.store.collection_memberships.pop(); // differs from the backup until restored
  app.ctx.__b = b;
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)');
  assert.ok(app.el('restoreModalBox').innerHTML.includes('these 7 tables'));
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  const call = app.requests.filter(r => r.method !== 'GET');
  assert.deepStrictEqual(call.map(r => new URL(r.url).pathname.split('/').pop()), ['restore_backup']);
  assert.strictEqual(call[0].body.p_backup.formatVersion, 3);
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  assert.strictEqual(app.store.collection_memberships.length, b.tables.collection_memberships.length);
});

// ── Match ──
async function matchAsTv(app, rowId, tmdb) {
  // The confirm step of Match to TMDB with a chosen series season (tmdb-match.js).
  app.ctx.__tmdbMatch = { rowId, results: [], target: { mediaType: 'tv', seasonNumber: 1,
    details: { id: tmdb, name: 'Target Show', networks: [{ name: 'Net' }], seasons: [{ season_number: 1, air_date: '2020-01-01' }] } } };
  await app.ctx.confirmTmdbMatch(); await settle();
}

test('Match asks the database to refuse a collection expansion; the refusal is explained and nothing else is written', async () => {
  const target = show({ title: 'Target Show', collection: 'truecrime', tmdb_id: 4000 }, ['Season 2']);
  target.rows[0].media_type = 'tv'; target.rows[0].tmdb_id = 4000; target.rows[0].season_number = 2; target.rows[0].season = 'Season 2';
  target.rows[0].item_key = 'target show|season 2';
  const legacy = film({ title: 'Target Show', collection: 'truecrime', media_type: null, tmdb_id: null, item_key: 'target show|film' });
  const app = await boot(all(target, legacy));
  app.store.collection_memberships.push({ id: uuid('0d', 950), collection_id: coll(app, 'disney').id, show_id: null, item_id: legacy.id, created_at: TS });
  app.ctx.switchTab('truecrime'); await settle();
  const before = JSON.stringify([app.store.watchlist_items, app.store.collection_memberships, app.store.tv_shows]);
  await matchAsTv(app, legacy.id, 4000);
  const calls = writes(app);
  assert.deepStrictEqual(calls.map(r => new URL(r.url).pathname.split('/').pop()), ['match_tv_row']);
  assert.deepStrictEqual(calls[0].body.p_expansion, {});
  assert.match(app.get('document.getElementById("errorBanner").innerHTML'), /would also show all 1 of its saved seasons in Disney\+/);
  assert.strictEqual(JSON.stringify([app.store.watchlist_items, app.store.collection_memberships, app.store.tv_shows]), before, 'nothing changed');
});

test('Match without an expansion keeps the row in its collections; a TV season matched as a film keeps its show’s collections after the two requests', async () => {
  const doc = show({ title: 'Doc Series', collection: 'truecrime' }, ['Season 1', 'Season 2']);
  const app = await boot(all(doc));
  app.store.collection_memberships.push({ id: uuid('0d', 960), collection_id: coll(app, 'sheridan').id, show_id: doc.show.id, item_id: null, created_at: TS });
  app.ctx.switchTab('truecrime'); await settle();
  const s1 = doc.rows[0];
  app.ctx.__tmdbMatch = { rowId: s1.id, results: [], target: { mediaType: 'movie', details: { id: 5555, title: 'Doc Film', release_date: '2020-01-01', genres: [], production_companies: [], belongs_to_collection: null } } };
  await app.ctx.confirmTmdbMatch(); await settle();
  const ofFilm = app.store.collection_memberships.filter(m => m.item_id === s1.id).map(m => m.collection_id).sort();
  assert.deepStrictEqual(ofFilm, [coll(app, 'sheridan').id, coll(app, 'truecrime').id].sort());
  assert.ok(app.store.tv_shows.some(s => s.id === doc.show.id), 'the show keeps its other season (the DELETE is refused, 23001)');
  assert.strictEqual(app.store.collection_memberships.filter(m => m.show_id === doc.show.id).length, 2, 'the show keeps its collections');
  assert.ok(!writes(app).some(r => r.body && JSON.stringify(r.body).includes('is_film')), 'the app never sends is_film');
});

// ── database without personal collections (previous schema) ──
test('without personal collections: the selector is unavailable (never the storage tabs), backup is format 2, watch-with uses the configured list, Match sends no new parameter', async () => {
  const data = library();
  const app = await boot(data, { org: false });
  assert.strictEqual(app.get('orgState'), 'absent');
  assert.match(app.el('browseBar').innerHTML, /Collections unavailable/);
  app.ctx.openBrowseCollection(B.disney); await settle();
  assert.strictEqual(app.get('activeViewId'), 'watching', 'nothing to open');
  const b = await app.run('buildBackupObject()');
  assert.strictEqual(b.formatVersion, 2);
  assert.deepStrictEqual(JSON.parse(app.get('JSON.stringify(watchWithChoiceList().map(c => c.token))')), Array.from(app.get('WATCH_WITH_OPTIONS')));
  const legacy = film({ title: 'Solo Doc', collection: 'truecrime', media_type: null, tmdb_id: null, item_key: 'solo doc|film' });
  const app2 = await boot(all(legacy), { org: false });
  app2.ctx.switchTab('truecrime'); await settle();
  await matchAsTv(app2, legacy.id, 4100);
  const call = writes(app2).find(r => r.url.includes('match_tv_row'));
  assert.ok(call && !('p_expansion' in call.body));
});

T.run();
