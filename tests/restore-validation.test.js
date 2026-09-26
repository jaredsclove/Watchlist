// Offline tests for the pre-delete restore checks in backup-restore.js:
// validateBackupObject() and identityLossErrors().
// Run from the repo root: node tests/restore-validation.test.js
// No network, no database. The classic scripts are loaded into one sandbox the
// same way the page loads them (shared global scope).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = {};
vm.createContext(ctx);
for (const f of ['config.js', 'backup-restore.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
}
const validate = ctx.validateBackupObject;
const identityLoss = ctx.identityLossErrors;

// A small backup shaped exactly like the current export: one movie, one TV season,
// one legacy row, one tracked show, one person collection.
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const TS = '2026-09-13T15:16:28.864056+00:00';
const item = extra => ({
  id: uuid(), collection: 'othertv', item_key: 'x|season 1', title: 'X', season: 'Season 1', theme: 'HBO',
  display_date: 'Jan 1, 2026', date_sort: '2026-01-01', watched: false, status: 'confirmed', created_at: TS,
  watch_with: [], collections: [], tmdb_collection_id: null, tmdb_collection_name: null,
  media_type: null, tmdb_id: null, season_number: null, ...extra
});
function validBackup() {
  n = 0;
  const tables = {
    watchlist_items: [
      item({ collection: 'movies', item_key: 'reservoir dogs|film', title: 'Reservoir Dogs', season: 'Film', theme: 'Crime',
        date_sort: '1992-09-02', display_date: 'Sep 2, 1992', collections: ['Quentin Tarantino'], media_type: 'movie', tmdb_id: 500 }),
      item({ item_key: 'silo|season 4', title: 'Silo', season: 'Season 4', theme: 'Apple TV', date_sort: '2027-07-08',
        display_date: 'Jul 8, 2027', watch_with: ['Jared'], media_type: 'tv', tmdb_id: 125988, season_number: 4 }),
      item({ collection: 'disney', item_key: 'andor|season 1', title: 'Andor', theme: 'Star Wars', watched: true }),
    ],
    othertv_shows: [{ id: uuid(), tmdb_id: 125988, title: 'Silo', network: 'Apple TV', created_at: TS, collection: 'othertv' }],
    custom_collections: [{ id: uuid(), name: 'Quentin Tarantino', tmdb_person_id: 138, created_at: TS, role: 'director' }],
  };
  const rowCounts = Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.length]));
  return { format: 'watchlist-tracker-backup', formatVersion: 1, exportedAt: '2026-09-26T18:37:02.000Z', rowCounts, tables };
}
const W = b => b.tables.watchlist_items;
const recount = b => { for (const t of Object.keys(b.tables)) b.rowCounts[t] = b.tables[t].length; return b; };
const dupOf = (b, i) => ({ ...W(b)[i], id: uuid() });

const tests = [];
// expect: a substring the combined error text must contain
const rejects = (name, expect, mutate) => tests.push({ name, fn: () => {
  const b = validBackup(); mutate(b);
  const errors = validate(b);
  assert.ok(errors.length > 0, 'expected the backup to be rejected');
  assert.ok(errors.join('\n').includes(expect), `expected "${expect}" in:\n  ${errors.join('\n  ')}`);
} });

tests.push({ name: 'current valid backup passes', fn: () => assert.deepStrictEqual([...validate(validBackup())], []) });
tests.push({ name: 'nullable arrays and role may be null', fn: () => {
  const b = validBackup(); W(b)[2].watch_with = null; W(b)[2].collections = null; b.tables.custom_collections[0].role = null;
  assert.deepStrictEqual([...validate(b)], []);
} });
rejects('missing rowCounts', 'Missing "rowCounts"', b => { delete b.rowCounts; });
rejects('rowCounts missing one table', 'Row count for "othertv_shows" is missing', b => { delete b.rowCounts.othertv_shows; });
rejects('rowCounts not a whole number', 'Row count for "watchlist_items" is missing or not a whole number', b => { b.rowCounts.watchlist_items = '3'; });
rejects('rowCounts negative', 'not a whole number', b => { b.rowCounts.custom_collections = -1; });
rejects('rowCounts mismatch', 'file claims 4 but contains 3', b => { b.rowCounts.watchlist_items = 4; });
rejects('duplicate movie identity', 'duplicate movie identity: (collection "movies", tmdb_id 500)', b => { W(b).push(dupOf(b, 0)); recount(b); });
rejects('duplicate TV identity', 'duplicate TV identity: (collection "othertv", tmdb_id 125988, season 4)', b => { W(b).push(dupOf(b, 1)); recount(b); });
rejects('duplicate legacy identity', 'duplicate legacy entry: (collection "disney", item_key "andor|season 1")', b => { W(b).push(dupOf(b, 2)); recount(b); });
rejects('duplicate row id', 'watchlist_items duplicate id', b => { W(b).push({ ...W(b)[2], item_key: 'other|season 1' }); recount(b); });
rejects('duplicate tracked show', 'othertv_shows duplicate tracked show', b => { b.tables.othertv_shows.push({ ...b.tables.othertv_shows[0], id: uuid() }); recount(b); });
rejects('duplicate person collection name', 'custom_collections duplicate name: "Quentin Tarantino"', b => { b.tables.custom_collections.push({ ...b.tables.custom_collections[0], id: uuid() }); recount(b); });
rejects('shape CHECK: movie with a season_number', 'identity shape', b => { W(b)[0].season_number = 1; });
rejects('shape CHECK: TV season without season_number', 'identity shape', b => { W(b)[1].season_number = null; });
rejects('shape CHECK: tmdb_id without media_type', 'identity shape', b => { W(b)[2].tmdb_id = 42; });
rejects('shape CHECK: unknown media_type', 'identity shape', b => { W(b)[0].media_type = 'book'; });
rejects('malformed array (watch_with: "Jared")', 'watch_with is not a list of text', b => { W(b)[1].watch_with = 'Jared'; });
rejects('array with a non-text element', 'collections is not a list of text', b => { W(b)[0].collections = ['MCU', 7]; });
rejects('wrong boolean type (watched: "yes")', 'watched is not true/false', b => { W(b)[0].watched = 'yes'; });
rejects('number in a text column (date_sort: 20260101)', 'date_sort is not a YYYY-MM-DD date', b => { W(b)[0].date_sort = 20260101; });
rejects('malformed date_sort', 'date_sort is not a YYYY-MM-DD date', b => { W(b)[0].date_sort = '2026-13-01'; });
rejects('bad timestamp', 'created_at is not a timestamp', b => { W(b)[0].created_at = 'yesterday'; });
rejects('non-integer tmdb_id', 'tmdb_id is not a whole number', b => { W(b)[0].tmdb_id = '500'; });
rejects('bad uuid', 'id is not a uuid', b => { W(b)[0].id = 'abc'; });
rejects('missing key (title absent)', 'is missing column(s) title', b => { delete W(b)[1].title; });
rejects('unknown column', 'has unknown column(s) rating', b => { W(b)[2].rating = 5; });
rejects('mixed key sets in othertv_shows', 'othertv_shows columns', b => { delete b.tables.othertv_shows[0].network; });
rejects('null in a NOT NULL column (theme: null)', 'theme is null but the column can\'t be', b => { W(b)[2].theme = null; });
rejects('null tmdb_person_id', 'tmdb_person_id is null', b => { b.tables.custom_collections[0].tmdb_person_id = null; });
rejects('old pre-identity backup (no identity columns)', 'predates the TMDB identity migration', b => {
  for (const r of W(b)) { delete r.media_type; delete r.tmdb_id; delete r.season_number; }
});

// identityLossErrors compares the backup with the data in the database right now.
tests.push({ name: 'identity loss: identified rows coming back unidentified are refused', fn: () => {
  const current = W(validBackup());
  const backup = current.map(r => ({ ...r, media_type: null, tmdb_id: null, season_number: null }));
  const errors = identityLoss(current, backup);
  assert.ok(errors.length === 1 && errors[0].includes('2 existing row(s) would lose their identity'), errors.join('\n'));
} });
tests.push({ name: 'identity loss: a backup with no identified rows is refused when the database has some', fn: () => {
  const current = W(validBackup());
  const backup = [item({ id: uuid(), item_key: 'other|season 1' })];
  assert.strictEqual(identityLoss(current, backup).length, 1);
} });
tests.push({ name: 'identity loss: an older backup with fewer rows but intact identities is allowed', fn: () => {
  const current = W(validBackup());
  assert.deepStrictEqual([...identityLoss(current, current.slice(0, 2))], []);
} });
tests.push({ name: 'identity loss: nothing to lose when the database has no identified rows', fn: () => {
  const current = W(validBackup()).filter(r => r.tmdb_id == null);
  assert.deepStrictEqual([...identityLoss(current, current)], []);
} });

let passed = 0;
for (const t of tests) {
  try { t.fn(); passed++; console.log('PASS', t.name); }
  catch (e) { console.log('FAIL', t.name, '\n ', e.message); }
}
console.log(`${passed}/${tests.length} passed`);
process.exit(passed === tests.length ? 0 : 1);
