// Offline tests for pickTmdbMovieCandidate() in identity.js.
// Run from the repo root: node tests/identity-candidate.test.js
// No network, no database. identity.js is a classic browser script, so it is
// loaded into a sandbox the same way the page loads it (shared global scope).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'identity.js'), 'utf8'), ctx);
const pick = ctx.pickTmdbMovieCandidate;

// Search results shaped like TMDB /search/movie (popularity-ordered, as TMDB returns them)
const r = (id, title, release_date, extra = {}) => ({ id, title, original_title: title, release_date, popularity: 0, vote_count: 0, ...extra });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('1. one exact match is accepted', () => {
  const res = pick([r(1, 'Iron Man 2', '2010-04-28'), r(2, 'Iron Man 3', '2013-04-18')], 'Iron Man 2');
  assert.strictEqual(res.match && res.match.id, 1);
});

test('2. multiple exact matches without a year are ambiguous', () => {
  const res = pick([r(36647, 'Blade', '1998-08-21'), r(617127, 'Blade', ''), r(999, 'Blade', '1973-01-01')], 'Blade');
  assert.ok(!res.match, 'must not auto-select');
  assert.deepStrictEqual(res.ambiguous.map(m => m.id), [36647, 617127, 999]);
});

test('3. multiple exact matches with the matching year give the unique match', () => {
  const results = [r(24428, 'The Avengers', '2012-04-25'), r(9320, 'The Avengers', '1998-08-13'), r(432413, 'The Avengers', '1950-01-01')];
  assert.strictEqual(pick(results, 'The Avengers', 1998).match.id, 9320);
  assert.strictEqual(pick(results, 'The Avengers', '2012').match.id, 24428);
});

test('4. "Fantastic Four" vs "Fantastic 4" is not an automatic match', () => {
  const res = pick([r(617126, 'The Fantastic 4: First Steps', '2025-07-23')], 'The Fantastic Four: First Steps');
  assert.ok(res.none && !res.match && !res.ambiguous);
});

test('5. empty results give none', () => {
  assert.ok(pick([], 'Anything').none);
  assert.ok(pick(undefined, 'Anything').none);
});

test('6. a differently titled top-ranked result is never selected for ranking first', () => {
  const results = [
    r(1, 'Blade Runner 2049', '2017-10-04', { popularity: 999, vote_count: 99999 }),
    r(2, 'Blade Runner', '1982-06-25', { popularity: 500, vote_count: 50000 })
  ];
  const res = pick(results, 'Blade');
  assert.ok(res.none, 'top result has a different title, so nothing should match');
});

test('original_title also counts as an exact title', () => {
  const res = pick([r(10, 'Spirited Away', '2001-07-20', { original_title: '千と千尋の神隠し' })], '千と千尋の神隠し');
  assert.strictEqual(res.match.id, 10);
});

test('normalization is conservative: case, curly quotes and spacing only', () => {
  assert.strictEqual(pick([r(5, 'Ocean’s Eleven', '2001-12-07')], "ocean's  eleven").match.id, 5);
  assert.ok(pick([r(6, 'Avengers', '2012-04-25')], 'The Avengers').none, 'a leading "The" is not dropped');
});

test('popularity and vote count never decide between same-title films', () => {
  const quiet = r(443129, 'Reservoir Dogs', '1991-06-01', { popularity: 1, vote_count: 216 });
  const famous = r(500, 'Reservoir Dogs', '1992-09-02', { popularity: 90, vote_count: 15850 });
  const res = pick([famous, quiet], 'Reservoir Dogs');
  assert.ok(res.ambiguous && res.ambiguous.length === 2, 'both remain for a human to choose');
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('PASS', t.name); }
  catch (e) { failed++; console.log('FAIL', t.name, '-', e.message); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
