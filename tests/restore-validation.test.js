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
for (const f of ['config.js', 'ui-helpers.js', 'metadata.js', 'backup-restore.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
}
const validate = ctx.validateBackupObject;
const identityLoss = ctx.identityLossErrors;

// A format-7 file from the shared synthetic library: seasons, films, a person collection, all nineteen tables.
let library, clone;
const validBackup = () => clone(library(1, 3));
const uuid = (() => { let n = 0; return () => `7f000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })();
const W = b => b.tables.watchlist_items;
const film = b => W(b).find(r => r.media_type === 'movie'), season = b => W(b).find(r => r.media_type === 'tv'), unmatched = b => W(b).find(r => r.media_type === null);
const P = b => b.tables.custom_collections[0];
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
  const b = validBackup(); unmatched(b).watch_with = null; unmatched(b).collections = null; P(b).role = null;
  assert.deepStrictEqual([...validate(b)], []);
} });
tests.push({ name: 'a supported older format validates', fn: () => {
  const b = validBackup();
  for (const t of vm.runInContext('CU1_TABLES', ctx)) { delete b.tables[t]; delete b.rowCounts[t]; }
  b.formatVersion = 6;
  assert.deepStrictEqual([...validate(b)], []);
  delete b.tables.episode_marks; delete b.rowCounts.episode_marks; b.formatVersion = 5;
  assert.deepStrictEqual([...validate(b)], []);
} });
rejects('format 3', 'format 3 backup, which this page no longer reads', b => { b.formatVersion = 3; });
rejects('format 4', 'format 4 backup, which this page no longer reads', b => { b.formatVersion = 4; });
rejects('a future format', 'Unsupported backup format version (9)', b => { b.formatVersion = 9; });
rejects('missing rowCounts', 'Missing "rowCounts"', b => { delete b.rowCounts; });
rejects('rowCounts missing one table', 'Row count for "update_holds" is missing', b => { delete b.rowCounts.update_holds; });
rejects('rowCounts not a whole number', 'Row count for "watchlist_items" is missing or not a whole number', b => { b.rowCounts.watchlist_items = '3'; });
rejects('rowCounts negative', 'not a whole number', b => { b.rowCounts.custom_collections = -1; });
rejects('rowCounts mismatch', 'but contains', b => { b.rowCounts.watchlist_items += 1; });
rejects('duplicate movie identity', 'duplicate movie identity', b => { W(b).push({ ...film(b), id: uuid(), item_key: 'zz copy' }); recount(b); });
rejects('duplicate TV identity', 'duplicate TV identity', b => { W(b).push({ ...season(b), id: uuid(), item_key: 'zz copy|season 1' }); recount(b); });
rejects('duplicate season of a show', 'duplicate season of a show', b => { W(b).push({ ...unmatched(b), id: uuid() }); recount(b); });
rejects('duplicate row id', 'watchlist_items duplicate id', b => { W(b).push({ ...unmatched(b), item_key: 'other|season 1' }); recount(b); });
rejects('duplicate person collection name', 'custom_collections duplicate name', b => { b.tables.custom_collections.push({ ...P(b), id: uuid() }); recount(b); });
rejects('shape CHECK: movie with a season_number', 'identity shape', b => { film(b).season_number = 1; });
rejects('shape CHECK: TV season without season_number', 'identity shape', b => { season(b).season_number = null; });
rejects('shape CHECK: tmdb_id without media_type', 'identity shape', b => { unmatched(b).tmdb_id = 42; });
rejects('shape CHECK: unknown media_type', 'identity shape', b => { film(b).media_type = 'book'; });
rejects('malformed array (watch_with: "Alone")', 'watch_with is not a list of text', b => { season(b).watch_with = 'Alone'; });
rejects('array with a non-text element', 'collections is not a list of text', b => { film(b).collections = ['MCU', 7]; });
rejects('wrong boolean type (watched: "yes")', 'watched is not true/false', b => { film(b).watched = 'yes'; });
rejects('number in a text column (date_sort: 20260101)', 'date_sort is not a YYYY-MM-DD date', b => { film(b).date_sort = 20260101; });
rejects('malformed date_sort', 'date_sort is not a YYYY-MM-DD date', b => { film(b).date_sort = '2026-13-01'; });
rejects('bad timestamp', 'created_at is not a timestamp', b => { film(b).created_at = 'yesterday'; });
rejects('non-integer tmdb_id', 'tmdb_id is not a whole number', b => { film(b).tmdb_id = '500'; });
rejects('bad uuid', 'id is not a uuid', b => { film(b).id = 'abc'; });
rejects('missing key (title absent)', 'is missing column(s) title', b => { delete season(b).title; });
rejects('unknown column', 'has unknown column(s) rating', b => { unmatched(b).rating = 5; });
rejects('mixed key sets', 'update_holds columns', b => { delete b.tables.update_holds[0].decision; });
rejects('null in a NOT NULL column (theme: null)', 'theme is null but the column can\'t be', b => { unmatched(b).theme = null; });
rejects('null tmdb_person_id', 'tmdb_person_id is null', b => { P(b).tmdb_person_id = null; });
rejects('old pre-identity backup (no identity columns)', 'predates the TMDB identity migration', b => {
  for (const r of W(b)) { delete r.media_type; delete r.tmdb_id; delete r.season_number; }
});

// identityLossErrors compares the backup with the data in the database right now.
tests.push({ name: 'identity loss: identified rows coming back unidentified are refused', fn: () => {
  const current = W(validBackup());
  const backup = current.map(r => ({ ...r, media_type: null, tmdb_id: null, season_number: null }));
  const errors = identityLoss(current, backup);
  assert.ok(errors.length === 1 && errors[0].includes(`${current.filter(r => r.tmdb_id != null).length} existing row(s) would lose their identity`), errors.join('\n'));
} });
tests.push({ name: 'identity loss: a backup with no identified rows is refused when the database has some', fn: () => {
  const current = W(validBackup());
  const backup = [{ ...unmatched(validBackup()), id: uuid() }];
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

(async () => {
({ library, clone } = await import('../tools/restore-fixture.mjs'));
let passed = 0;
for (const t of tests) {
  try { t.fn(); passed++; console.log('PASS', t.name); }
  catch (e) { console.log('FAIL', t.name, '\n ', e.message); }
}
console.log(`${passed}/${tests.length} passed`);
process.exit(passed === tests.length ? 0 : 1);
})();
