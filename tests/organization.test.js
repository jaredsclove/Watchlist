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
  app.run("orgState = 'loading'; personalCollections = null"); // as at startup (a refresh while ready keeps the list)
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
  assert.ok(html(app).includes('No TV shows in Anime.'), 'an empty collection says so');
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

// ── organization refresh (review finding 1) ──
// A format 3 backup whose collections and watch-with labels differ from what the page has loaded.
async function restoredBackup(app) {
  const b = JSON.parse(JSON.stringify(await app.run('buildBackupObject()')));
  const old = b.tables.personal_collections.find(c => c.legacy_source === 'disney');
  const fresh = uuid('0c', 77);
  b.tables.personal_collections = b.tables.personal_collections.map(c => c.id === old.id ? { ...c, id: fresh, name: 'Disney+ (restored)' } : c);
  b.tables.collection_memberships = b.tables.collection_memberships.map(m => m.collection_id === old.id ? { ...m, collection_id: fresh } : m);
  b.tables.watch_with_choices = b.tables.watch_with_choices.map(c => c.token === 'Rina' ? { ...c, label: 'Rina (restored)' } : c);
  return { b, oldId: old.id, freshId: fresh };
}
async function restoreThrough(app, b) {
  app.ctx.__b = b;
  await app.run('pendingRestoreData = __b');
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  app.ctx.finishRestoreAndReload(); await settle();
}

test('after a restore the selector and watch-with labels come from the restored data (changed ids, names, labels)', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.switchTab('movies'); await settle();
  const { b, oldId, freshId } = await restoredBackup(app);
  await restoreThrough(app, b);
  assert.ok(options(app).some(([v, t]) => v === `browse:${freshId}` && t === 'Disney+ (restored)'), JSON.stringify(options(app)));
  assert.ok(!options(app).some(([v]) => v === `browse:${oldId}`), 'the restored-away collection is gone from the selector');
  assert.ok(app.el('tbody').innerHTML.includes('>Rina (restored)</button>'), 'the open Movies tab shows the restored label');
  assert.ok(/<option value="Rina">Rina \(restored\)<\/option>/.test(app.el('filtersRow').innerHTML));
});

test('a restored-away collection that is still open (or chosen from a stale selector) says it isn’t available, with Back', async () => {
  const app = await boot();
  const { b, oldId } = await restoredBackup(app);
  app.ctx.__b = b;
  await app.run('pendingRestoreData = __b');
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  // Simulate the view being a collection when the page reloads its data.
  app.run(`activeViewId = 'browse:${oldId}'`);
  app.ctx.finishRestoreAndReload(); await settle();
  assert.ok(html(app).includes('This collection isn’t available any more.'));
  assert.ok(app.el('viewHead').innerHTML.includes('browseBack()'));
  assert.strictEqual(writes(app).filter(r => !r.url.includes('restore_backup')).length, 0);
});

test('watch-with controls drawn before the choices load are redrawn when the loaded labels differ (slow startup)', async () => {
  const data = library();
  const app = await boot(data);
  app.store.watch_with_choices.find(c => c.token === 'Suzanne').label = 'Suzanne B.';
  app.run('watchWithChoices = null'); // as if the startup read hadn't finished yet
  const g = app.hold(r => r.url.includes('/watch_with_choices?'));
  const loading = app.ctx.loadOrganization();
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.switchTab('movies'); await settle();
  assert.ok(app.el('tbody').innerHTML.includes('>Suzanne</button>'), 'fallback before the choices arrive');
  g.release(); await loading; await settle();
  assert.ok(app.el('tbody').innerHTML.includes('>Suzanne B.</button>'), 'redrawn with the loaded label');
});

test('an older organization read that finishes last never replaces newer data (Retry, a collection view, a restore)', async () => {
  const app = await boot();
  // 1. An older load is still pending when a newer one (Retry) finishes.
  const g = app.hold(r => r.url.includes('/personal_collections?'));
  const older = app.ctx.loadOrganization();
  await g.reached;
  coll(app, 'sheridan').name = 'Sheridan (newer)';
  await app.ctx.loadOrganization(); await settle();
  coll(app, 'sheridan').name = 'Sheridan (newest db)'; // the held read answers with whatever the store holds when released
  g.release(); await older; await settle();
  assert.ok(options(app).some(([, t]) => t === 'Sheridan (newer)'), JSON.stringify(options(app)));
  // 2. A collection view's fresher read is not overwritten by an older startup-style read.
  const g2 = app.hold(r => r.url.includes('/personal_collections?'));
  const older2 = app.ctx.loadOrganization();
  await g2.reached;
  coll(app, 'disney').name = 'Disney+ v2';
  await open(app, B.disney);
  assert.ok(options(app).some(([, t]) => t === 'Disney+ v2'));
  coll(app, 'disney').name = 'Disney+ v1 (stale)';
  g2.release(); await older2; await settle();
  assert.ok(options(app).some(([, t]) => t === 'Disney+ v2'), 'the older read was dropped: ' + JSON.stringify(options(app)));
});

test('a startup read pending across a restore is discarded; the post-restore read wins', async () => {
  const app = await boot();
  const { b, freshId } = await restoredBackup(app);
  const g = app.hold(r => r.url.includes('/personal_collections?'));
  const pending = app.ctx.loadOrganization();
  await g.reached;
  const preRestore = JSON.parse(JSON.stringify(app.store.personal_collections));
  await restoreThrough(app, b);
  // The held (pre-restore) read now answers with the old rows.
  app.store.personal_collections_hold = app.store.personal_collections;
  app.store.personal_collections = preRestore;
  g.release(); await pending; await settle();
  app.store.personal_collections = app.store.personal_collections_hold;
  assert.ok(options(app).some(([v]) => v === `browse:${freshId}`), 'still the restored collections: ' + JSON.stringify(options(app)));
});

test('a pre-restore read that finishes before the post-restore read publishes nothing; the selector waits for the restored data', async () => {
  const app = await boot();
  const { b, freshId, oldId } = await restoredBackup(app);
  const g = app.hold(r => r.url.includes('/personal_collections?'));
  const pending = app.ctx.loadOrganization();
  await g.reached;
  const preRestore = JSON.parse(JSON.stringify(app.store.personal_collections));
  app.ctx.__b = b;
  await app.run('pendingRestoreData = __b');
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  const g2 = app.hold(r => r.url.includes('/personal_collections?')); // hold the post-restore read
  app.ctx.finishRestoreAndReload();
  await g2.reached;
  const restored = app.store.personal_collections;
  app.store.personal_collections = preRestore; // the pre-restore read answers with the old rows
  g.release(); await pending; await settle();
  app.store.personal_collections = restored;
  assert.ok(!options(app).some(([v]) => v === `browse:${oldId}`), 'the pre-restore read did not publish: ' + JSON.stringify(options(app)));
  assert.match(app.el('browseBar').innerHTML, /Loading collections…/);
  g2.release(); await settle();
  assert.ok(options(app).some(([v]) => v === `browse:${freshId}`));
});

test('the database model refuses a NULL watch-with value and deleting a choice in use; the app reports it and keeps the row', async () => {
  const data = library();
  const app = await boot(data);
  const dune = data.rows.find(r => r.title === 'Dune');
  const res = await app.ctx.fetch(`${app.get('SUPABASE_URL')}/rest/v1/watch_with_choices?token=eq.Suzanne`, { method: 'DELETE', headers: {} });
  assert.strictEqual(res.status, 409);
  assert.ok(app.store.watch_with_choices.some(c => c.token === 'Suzanne'));
  const res2 = await app.ctx.fetch(`${app.get('SUPABASE_URL')}/rest/v1/watchlist_items?id=eq.${dune.id}`, { method: 'PATCH', headers: {}, body: JSON.stringify({ watch_with: [null] }) });
  assert.strictEqual(res2.status, 400);
  assert.deepStrictEqual(Array.from(app.store.watchlist_items.find(r => r.id === dune.id).watch_with), ['Suzanne']);
});

// ── failed post-restore choices read (second review, finding 2) ──
async function restoreChangedChoices(app) {
  const b = JSON.parse(JSON.stringify(await app.run('buildBackupObject()')));
  b.tables.watch_with_choices = b.tables.watch_with_choices.filter(c => c.token !== 'Alone') // a removed choice
    .map(c => c.token === 'Suzanne' ? { ...c, label: 'Suzanne (restored)' } : c);
  b.rowCounts.watch_with_choices = b.tables.watch_with_choices.length;
  app.ctx.__b = b;
  await app.run('pendingRestoreData = __b');
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
}
const pickerOf = (app, id) => app.get(`watchWithPickerHtml('${id}', [])`);

for (const withBrowse of [false, true]) {
  test(`post-restore choices read fails${withBrowse ? ' while a collection view reads successfully' : ''}: no stale or default choices are offered; unavailable + Retry; Retry recovers`, async () => {
    const data = library();
    const app = await boot(data);
    const dune = data.rows.find(r => r.title === 'Dune');
    app.ctx.switchMediaType('movie'); await settle();
    app.ctx.switchTab('movies'); await settle();
    await restoreChangedChoices(app);
    if (withBrowse) {
      // The choices read is still in flight when a collection view reads collections successfully; then it fails.
      const g = app.hold(r => r.url.includes('/watch_with_choices?'));
      app.ctx.finishRestoreAndReload();
      await g.reached; await settle(); // the collections arrive first
      const loadSeq = app.get('orgLoadSeq');
      await open(app, B.sheridan);
      assert.ok(app.get('orgCollectionsSeq') > loadSeq, 'the collection view published newer collections than the failing load');
      g.fail(); await settle();
      app.ctx.switchTab('movies'); await settle();
    } else {
      app.failNext(r => r.url.includes('/watch_with_choices?'));
      app.ctx.finishRestoreAndReload(); await settle();
    }
    const picker = pickerOf(app, dune.id);
    assert.ok(!/value="Alone"/.test(picker), 'the removed choice is not offered: ' + picker);
    assert.ok(!/> Suzanne<\/label>/.test(picker), 'no stale label');
    assert.ok(!/<input type="checkbox"/.test(picker), 'no choices offered while unavailable');
    assert.match(picker, /Watch-with choices couldn’t be loaded/);
    assert.match(picker, /onclick="loadOrganization\(\)">Retry/);
    assert.ok(!/<option value="Alone">/.test(app.el('filtersRow').innerHTML), 'the filter offers no stale choice');
    assert.strictEqual(app.get('watchWithState'), 'unavailable');
    assert.strictEqual(app.get('watchWithChoiceList().length'), 0, 'no choice list at all (not the configured one)');
    const writesBefore = writes(app).length;
    await app.ctx.toggleWatchWith(dune.id, 'Rina', true); await settle();
    assert.strictEqual(writes(app).length, writesBefore, 'no watch-with write while choices are unavailable');
    await app.ctx.loadOrganization(); await settle();
    assert.strictEqual(app.get('watchWithState'), 'ready');
    const after = pickerOf(app, dune.id);
    assert.ok(after.includes('> Suzanne (restored)</label>') && !after.includes('value="Alone"'), after);
  });
}

test('while the post-restore choices read is pending the controls say loading (no defaults, no stale values)', async () => {
  const data = library();
  const app = await boot(data);
  const dune = data.rows.find(r => r.title === 'Dune');
  await restoreChangedChoices(app);
  const g = app.hold(r => r.url.includes('/watch_with_choices?'));
  app.ctx.finishRestoreAndReload();
  await g.reached;
  const picker = pickerOf(app, dune.id);
  assert.ok(!/<input type="checkbox"/.test(picker) && /Watch-with choices are loading/.test(picker), picker);
  g.release(); await settle();
  assert.ok(pickerOf(app, dune.id).includes('> Suzanne (restored)</label>'));
});

// ── unfinished work during a watch-with refresh; Retry beside the filter (third review) ──
// The watch-with filter control (replaced in place; the fake DOM doesn't propagate that to its parent's markup).
const wwFilter = app => (app.el('fWatchWithWrap') && app.el('fWatchWithWrap').innerHTML) || app.el('filtersRow').innerHTML;
async function moviesWithUnfinishedWork(app) {
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.switchTab('movies'); await settle();
  app.ctx.toggleAdd(); await settle();
  app.el('nTitle').value = 'Unfinished title';
  app.el('nDate').value = 'Jan 1, 2031';
  app.el('tmdbQuery').value = 'dune part three';
  app.el('tmdbResults').innerHTML = '<div class="tmdb-result">a chosen search result</div>';
  app.el('tmdbPreview').innerHTML = '<div class="tmdb-preview">an open preview</div>';
}
function assertWorkKept(app, when) {
  assert.strictEqual(app.el('nTitle') && app.el('nTitle').value, 'Unfinished title', `add-entry title kept (${when})`);
  assert.strictEqual(app.el('nDate').value, 'Jan 1, 2031', `add-entry date kept (${when})`);
  assert.strictEqual(app.el('tmdbQuery').value, 'dune part three', `TMDB query kept (${when})`);
  assert.ok(app.el('tmdbResults').innerHTML.includes('a chosen search result'), `TMDB results kept (${when})`);
  assert.ok(app.el('tmdbPreview').innerHTML.includes('an open preview'), `TMDB preview kept (${when})`);
}

test('a delayed startup choices read doesn’t erase an open Add entry form or TMDB search/preview', async () => {
  const app = await boot();
  app.run("watchWithChoices = null; watchWithState = 'loading'; orgChoicesSeq = 0");
  const g = app.hold(r => r.url.includes('/watch_with_choices?'));
  const loading = app.ctx.loadOrganization();
  await moviesWithUnfinishedWork(app);
  assert.match(wwFilter(app), /Watch-with choices are loading/);
  g.release(); await loading; await settle();
  assert.ok(/<option value="Rina">Rina<\/option>/.test(wwFilter(app)), 'the filter now offers the choices');
  assertWorkKept(app, 'after the delayed read');
});

for (const emptyList of [false, true]) {
  test(`a failed choices read shows Retry beside the Movies filter (${emptyList ? 'no rows visible' : 'rows visible'}); Retry recovers; unfinished work is kept`, async () => {
    const app = await boot();
    await moviesWithUnfinishedWork(app);
    if (emptyList) { app.el('fSearch').value = 'no film has this title'; app.ctx.renderTable(); }
    app.failNext(r => r.url.includes('/watch_with_choices?'));
    app.run("invalidateOrganization()");
    await app.ctx.loadOrganization(); await settle();
    const filters = wwFilter(app);
    assert.match(filters, /Watch-with choices couldn’t be loaded/);
    assert.match(filters, /<button class="btn" onclick="loadOrganization\(\)" aria-label="Retry loading watch-with choices">Retry<\/button>/);
    if (emptyList) assert.ok(!/class="ww-option"/.test(app.el('tbody').innerHTML) && !/more-popover/.test(app.el('tbody').innerHTML), 'no rows (so no row Retry) are visible');
    assertWorkKept(app, 'after the failure');
    await app.ctx.loadOrganization(); await settle();
    assert.ok(/<option value="Rina">Rina<\/option>/.test(wwFilter(app)), 'recovered');
    assert.ok(!/aria-label="Retry loading watch-with choices"/.test(wwFilter(app)));
    if (emptyList) assert.strictEqual(app.el('fSearch').value, 'no film has this title', 'the filter search is kept');
    assertWorkKept(app, 'after Retry');
  });
}

test('views without watch-with controls aren’t redrawn when choices arrive or change', async () => {
  const app = await boot();
  for (const go of [() => app.ctx.switchView('watching'), () => app.ctx.switchTab('disney')]) {
    go(); await settle();
    let draws = 0;
    const real = app.ctx.renderTable, realF = app.ctx.renderFilters;
    app.ctx.renderTable = (...a) => { draws++; return real(...a); };
    app.ctx.renderFilters = (...a) => { draws++; return realF(...a); };
    app.store.watch_with_choices.find(c => c.token === 'Rina').label = `Rina ${Math.random()}`;
    await app.ctx.loadOrganization(); await settle();
    app.ctx.renderTable = real; app.ctx.renderFilters = realF;
    assert.strictEqual(draws, 0, 'no redraw');
  }
});

test('Match refused by a concurrent change (40001 re-check, deadlock victim, lock or statement timeout): one clear message, nothing else written', async () => {
  for (const [code, message] of [['40001', 'match_conflict: the collections of this row changed while matching; try again'],
    ['40P01', 'deadlock detected'], ['55P03', 'canceling statement due to lock timeout'], ['57014', 'canceling statement due to statement timeout']]) {
    const legacy = film({ title: 'Race Doc', collection: 'truecrime', media_type: null, tmdb_id: null, item_key: 'race doc|film' });
    const app = await boot(all(legacy));
    app.ctx.switchTab('truecrime'); await settle();
    app.rpcHandlers.match_tv_row = () => ({ ok: false, status: 409, text: async () => JSON.stringify({ code, message }), json: async () => ({ code, message }), headers: { get: () => null } });
    await matchAsTv(app, legacy.id, 4200);
    assert.match(app.get('document.getElementById("errorBanner").innerHTML'), ['55P03', '57014'].includes(code)
      ? /The database didn’t finish the match in time, so it was cancelled and nothing was matched\. Another change may have been using the same rows; try again\./
      : /Something else was changing the same show or collections at that moment, so nothing was matched\. Try again\./, code);
    assert.deepStrictEqual(writes(app).map(r => new URL(r.url).pathname.split('/').pop()), ['match_tv_row']);
  }
});

T.run();
