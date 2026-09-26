// Offline tests for tmdbSeasonDateUpdate() in refresh-shows.js.
// Run from the repo root: node tests/season-date-update.test.js
// No network, no database. The classic scripts are loaded into one sandbox the
// same way the page loads them (shared global scope).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = {};
vm.createContext(ctx);
for (const f of ['ui-helpers.js', 'refresh-shows.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
}
const upd = ctx.tmdbSeasonDateUpdate;

// Rows shaped like watchlist_items TV seasons written by the refresh/search flows
const row = (extra = {}) => ({ id: 'x', media_type: 'tv', tmdb_id: 125988, season_number: 4, title: 'Silo', season: 'Season 4',
  display_date: 'TBA', date_sort: '2099-01-01', watched: false, status: 'confirmed', ...extra });
const season = air_date => ({ season_number: 4, air_date, episode_count: 1 });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('1. TBA row + TMDB air date → date fields only', () => {
  assert.deepStrictEqual({ ...upd(row(), season('2027-07-08')) }, { display_date: 'Jul 8, 2027', date_sort: '2027-07-08' });
});
test('2. TBA row + TMDB still has no date → no update', () => {
  assert.strictEqual(upd(row(), season(null)), null);
  assert.strictEqual(upd(row(), season('')), null);
  assert.strictEqual(upd(row(), { season_number: 4 }), null);
});
test('3. already-confirmed date is never overwritten, even if TMDB moved it', () => {
  assert.strictEqual(upd(row({ display_date: 'Nov 26, 2026', date_sort: '2026-11-26' }), season('2026-12-03')), null);
});
test('4. TBA match is case-insensitive, like the rest of the app', () => {
  assert.ok(upd(row({ display_date: 'tba' }), season('2026-11-26')));
});
test('5. unidentified or non-TV rows are never updated', () => {
  assert.strictEqual(upd(row({ tmdb_id: null, media_type: null, season_number: null }), season('2026-11-26')), null);
  assert.strictEqual(upd(row({ media_type: 'movie', season_number: null }), season('2026-11-26')), null);
});
test('6. malformed TMDB date is ignored', () => {
  assert.strictEqual(upd(row(), season('2027')), null);
  assert.strictEqual(upd(row(), season('2027-07-08T00:00:00Z')), null);
});
test('7. user-owned fields are not in the update', () => {
  const u = upd(row({ watched: true, status: 'watching', watch_with: ['Jared'], collections: ['X'] }), season('2027-07-08'));
  assert.deepStrictEqual(Object.keys(u).sort(), ['date_sort', 'display_date']);
});
test('8. missing row or season → no update', () => {
  assert.strictEqual(upd(null, season('2027-07-08')), null);
  assert.strictEqual(upd(row(), null), null);
});

let passed = 0;
for (const t of tests) {
  try { t.fn(); passed++; console.log('PASS', t.name); }
  catch (e) { console.log('FAIL', t.name, '\n ', e.message); }
}
console.log(`${passed}/${tests.length} passed`);
process.exit(passed === tests.length ? 0 : 1);
