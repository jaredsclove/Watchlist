// Offline tests for which TMDB search hits the manual search shows per tab:
// tmdbSearchModeFor() and selectTmdbSearchResults() in tmdb-search.js.
// Run from the repo root: node tests/search-selection.test.js
// No network. The classic scripts are loaded into one sandbox the same way the
// page loads them (shared global scope).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = {};
vm.createContext(ctx);
for (const f of ['config.js', 'tmdb-search.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
}
// Results are copied into this realm's arrays so deepStrictEqual compares values, not prototypes.
const select = (...args) => Array.from(ctx.selectTmdbSearchResults(...args));
const modeFor = ctx.tmdbSearchModeFor;
const tab = id => vm.runInContext(`COLLECTIONS.find(c => c.id === ${JSON.stringify(id)})`, ctx);

// TMDB /search responses for "Dune" (page 1, TMDB's own order, trimmed), tagged the way searchTMDB tags them
const tv = ['Dune: Prophecy', "Frank Herbert's Children of Dune", "Frank Herbert's Dune", 'H24', 'China: The Making of a Nation', 'Be Dune Teen', 'Fly Tales']
  .map((name, i) => ({ id: 100 + i, name, mediaType: 'tv' }));
const movies = ['Dune', 'Dune', 'Dune: Part Two', 'Dune: Part Three', 'Anatomy of a Fall', 'Dune', 'The Dune']
  .map((title, i) => ({ id: 200 + i, title, mediaType: 'movie' }));
const labels = list => list.map(r => `${r.mediaType}:${r.title || r.name}`);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('tab modes: Movies → movie, Other TV → tv, True Crime / Docs → mixed', () => {
  assert.strictEqual(modeFor(tab('movies')), 'movie');
  assert.strictEqual(modeFor(tab('othertv')), 'tv');
  assert.strictEqual(modeFor(tab('truecrime')), 'mixed');
  assert.strictEqual(modeFor(undefined), 'tv');
});
test('Movies: films fill the list; TV cannot crowd out Dune: Part Two', () => {
  const out = select(tv, movies, 'movie');
  assert.strictEqual(out.length, 6);
  assert.ok(out.every(r => r.mediaType === 'movie'));
  assert.ok(labels(out).includes('movie:Dune: Part Two'));
});
test('Movies: TV only fills room the films leave', () => {
  assert.deepStrictEqual(labels(select(tv, movies.slice(0, 2), 'movie')),
    ['movie:Dune', 'movie:Dune', 'tv:Dune: Prophecy', "tv:Frank Herbert's Children of Dune", "tv:Frank Herbert's Dune", 'tv:H24']);
});
test('TV tab: series come first and fill the list', () => {
  const out = select(tv, movies, 'tv');
  assert.strictEqual(out.length, 6);
  assert.ok(out.every(r => r.mediaType === 'tv'));
});
test('TV tab: films only fill room the series leave', () => {
  assert.deepStrictEqual(labels(select(tv.slice(0, 1), movies, 'tv')),
    ['tv:Dune: Prophecy', 'movie:Dune', 'movie:Dune', 'movie:Dune: Part Two', 'movie:Dune: Part Three', 'movie:Anatomy of a Fall']);
});
test('True Crime / Docs: original mixed split (up to 4 series, then films) is unchanged', () => {
  const out = select(tv, movies, 'mixed');
  assert.deepStrictEqual(labels(out), ['tv:Dune: Prophecy', "tv:Frank Herbert's Children of Dune", "tv:Frank Herbert's Dune", 'tv:H24', 'movie:Dune', 'movie:Dune']);
  // same as the old rule for every tab
  assert.deepStrictEqual(out, [...tv.slice(0, 4), ...movies.slice(0, 4)].slice(0, 6));
});
test('True Crime / Docs: films still appear when there are few series', () => {
  assert.deepStrictEqual(labels(select(tv.slice(0, 1), movies, 'mixed')),
    ['tv:Dune: Prophecy', 'movie:Dune', 'movie:Dune', 'movie:Dune: Part Two', 'movie:Dune: Part Three']);
});
test('cap stays at 6 in every mode, and small or empty inputs are fine', () => {
  for (const mode of ['movie', 'tv', 'mixed']) {
    assert.ok(select(tv, movies, mode).length <= 6);
    assert.deepStrictEqual([...select([], [], mode)], []);
    assert.strictEqual(select([], movies.slice(0, 2), mode).length, 2);
  }
});
test('order within a type follows TMDB and is deterministic', () => {
  const a = select(tv, movies, 'movie'), b = select(tv, movies, 'movie');
  assert.deepStrictEqual(a.map(r => r.id), [200, 201, 202, 203, 204, 205]);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(select(tv, movies, 'tv').map(r => r.id), [100, 101, 102, 103, 104, 105]);
});
test('inputs are not modified', () => {
  const tvCopy = JSON.stringify(tv), movieCopy = JSON.stringify(movies);
  select(tv, movies, 'movie'); select(tv, movies, 'mixed');
  assert.strictEqual(JSON.stringify(tv), tvCopy);
  assert.strictEqual(JSON.stringify(movies), movieCopy);
});

let passed = 0;
for (const t of tests) {
  try { t.fn(); passed++; console.log('PASS', t.name); }
  catch (e) { console.log('FAIL', t.name, '\n ', e.message); }
}
console.log(`${passed}/${tests.length} passed`);
process.exit(passed === tests.length ? 0 : 1);
