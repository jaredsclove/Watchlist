// Offline control tests for the grading logic in tools/identity-audit.mjs.
// Run from the repo root: node tests/identity-audit.test.mjs
// No network, no database: TMDB objects below are trimmed copies of real
// responses (values as of 2026-09-26), passed straight to the pure graders.
import assert from 'assert';
import { gradeMovie, gradeTv } from '../tools/identity-audit.mjs';

const genres = (...names) => names.map(name => ({ name }));
const movie = (id, title, release_date, runtime, g, alts = []) =>
  ({ id, title, original_title: title, release_date, runtime, genres: genres(...g), alternative_titles: { titles: alts } });

const RD_FEATURE = movie(500, 'Reservoir Dogs', '1992-09-02', 99, ['Crime', 'Thriller']);
const RD_SHORT = movie(443129, 'Reservoir Dogs', '1991-06-01', 12, ['Crime']);
const F4_2025 = movie(617126, 'The Fantastic 4: First Steps', '2025-07-23', 115, ['Science Fiction', 'Adventure', 'Action'], [
  { iso_3166_1: 'US', title: "Marvel Studios' The Fantastic Four", type: 'former promotional title' },
  { iso_3166_1: 'US', title: 'Fantastic Four', type: 'working title' },
  { iso_3166_1: 'US', title: 'The Fantastic Four: First Steps', type: 'alternative spelling (official title)' },
  { iso_3166_1: 'US', title: 'The Fantastic Four', type: 'working title' },
  { iso_3166_1: 'US', title: 'Blue Moon', type: 'working title' },
]);
const F4_2015 = movie(166424, 'Fantastic Four', '2015-08-05', 100, ['Action', 'Adventure', 'Science Fiction']);
const SILO = { id: 125988, name: 'Silo', original_name: 'Silo', alternative_titles: { results: [] }, seasons: [
  { season_number: 1, air_date: '2023-05-04' }, { season_number: 2, air_date: '2024-11-14' },
  { season_number: 3, air_date: '2026-07-02' }, { season_number: 4, air_date: '2027-07-08' },
] };

// Rows shaped like production watchlist_items
const movieRow = (title, tmdb_id, date_sort, theme, extra = {}) => ({ collection: 'movies', title, season: 'Film', theme,
  display_date: date_sort, date_sort, media_type: 'movie', tmdb_id, season_number: null, ...extra });
const RD_ROW = movieRow('Reservoir Dogs', 500, '1992-09-02', 'Crime');
const F4_ROW = movieRow('The Fantastic Four: First Steps', 617126, '2025-07-23', 'Science Fiction');
const SILO_S4 = { collection: 'othertv', title: 'Silo', season: 'Season 4', theme: 'Apple TV', display_date: 'Jul 8, 2027',
  date_sort: '2027-07-08', media_type: 'tv', tmdb_id: 125988, season_number: 4 };

// Same-title search results as the tool passes them (runtime only when the linked movie is a short)
const rdCandidates = [{ id: 500, title: 'Reservoir Dogs', release_date: '1992-09-02', runtime: 99 }];
const f4Candidates = [{ id: 617126, title: 'The Fantastic 4: First Steps', release_date: '2025-07-23' }];

const tests = [];
const test = (name, expected, fn) => tests.push({ name, expected, fn });

test('Reservoir Dogs → 500 (feature)', 'A', () => gradeMovie(RD_ROW, RD_FEATURE, []));
test('Reservoir Dogs → 443129 (12-min short), short\'s own date', 'C',
  () => gradeMovie({ ...RD_ROW, tmdb_id: 443129, date_sort: '1991-06-01', display_date: 'Jun 1, 1991' }, RD_SHORT, rdCandidates));
test('Reservoir Dogs → 443129 (12-min short), feature\'s date', 'C',
  () => gradeMovie({ ...RD_ROW, tmdb_id: 443129 }, RD_SHORT, rdCandidates));
test('Fantastic Four current row → 617126 (accepted alternative title)', 'A', () => gradeMovie(F4_ROW, F4_2025, []));
test('Fantastic Four row → 166424 (2015 film, wrong year)', 'C', () => gradeMovie({ ...F4_ROW, tmdb_id: 166424 }, F4_2015, f4Candidates));
test('Fantastic Four row → 500 (clearly unrelated movie)', 'D', () => gradeMovie({ ...F4_ROW, tmdb_id: 500 }, RD_FEATURE, []));
test('numeral/article drift: "Fantastic Four: First Steps" → 617126', 'B',
  () => gradeMovie({ ...F4_ROW, title: 'Fantastic Four: First Steps' }, F4_2025, []));
test('working title only: "Blue Moon" → 617126', 'C', () => gradeMovie({ ...F4_ROW, title: 'Blue Moon' }, F4_2025, []));
test('documentary mismatch: stored theme Documentary on a narrative film', 'C',
  () => gradeMovie({ ...F4_ROW, theme: 'Documentary' }, F4_2025, []));
test('TMDB movie id no longer exists', 'D', () => gradeMovie(F4_ROW, null, []));
test('nonexistent TV season: Silo season 9', 'D', () => gradeTv({ ...SILO_S4, season_number: 9, season: 'Season 9' }, SILO));
test('stale TBA → TMDB now dated: Silo S4 before correction', 'B',
  () => gradeTv({ ...SILO_S4, display_date: 'TBA', date_sort: '2099-01-01' }, SILO));
test('corrected TBA row: Silo S4 after correction', 'A', () => gradeTv(SILO_S4, SILO));
test('wrong show: Silo row → a show with a different title', 'D',
  () => gradeTv(SILO_S4, { ...SILO, id: 244447, name: 'The Hunting Wives', original_name: 'The Hunting Wives',
    seasons: [{ season_number: 4, air_date: '2029-01-01' }] }));

let passed = 0;
for (const t of tests) {
  const res = t.fn();
  try {
    assert.strictEqual(res.grade, t.expected);
    passed++;
    console.log(`PASS ${t.expected}  ${t.name}`);
  } catch {
    console.log(`FAIL ${t.name}: expected ${t.expected}, got ${res.grade}\n  ${res.findings.map(([g, w]) => `[${g}] ${w}`).join('\n  ')}`);
  }
}
console.log(`${passed}/${tests.length} passed`);
process.exit(passed === tests.length ? 0 : 1);
