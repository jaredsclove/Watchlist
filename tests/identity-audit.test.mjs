// Offline control tests for the grading logic in tools/identity-audit.mjs.
// Run from the repo root: node tests/identity-audit.test.mjs
// No network, no database: TMDB objects below are trimmed copies of real
// responses (values as of 2026-09-26), passed straight to the pure graders.
import assert from 'assert';
import { gradeMovie, gradeTv, loadExceptions, validateExceptions } from '../tools/identity-audit.mjs';

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

// Provisional future seasons (catalog one season ahead of TMDB). Fixed "today".
const TODAY = '2026-10-05';
const S5 = o => ({ ...SILO_S4, season: 'Season 5', season_number: 5, display_date: 'TBA', date_sort: '2099-01-01', ...o });
test('provisional: next season, TBA, not on TMDB yet → B (not TMDB-verified)', 'B', () => {
  const r = gradeTv(S5(), SILO, TODAY);
  if (!r.findings.some(([, why]) => /provisional future season not yet listed by TMDB/.test(why) && /not TMDB-verified/.test(why))) throw new Error('wording');
  return r;
});
test('provisional: next season with a future date → B', 'B', () => gradeTv(S5({ display_date: 'Jul 1, 2028', date_sort: '2028-07-01' }), SILO, TODAY));
test('same season once its date has passed, still absent from TMDB → D', 'D', () => gradeTv(S5({ display_date: 'Jul 1, 2026', date_sort: '2026-07-01' }), SILO, TODAY));
test('label not exactly "Season N" ("Season 5 (Final)") → D', 'D', () => gradeTv(S5({ season: 'Season 5 (Final)' }), SILO, TODAY));
test('not the next season (TMDB lists 1 and 3; ours is 2) → D', 'D', () =>
  gradeTv(S5({ season: 'Season 2', season_number: 2 }), { ...SILO, seasons: [{ season_number: 1, air_date: '2026-03-14' }, { season_number: 3, name: 'Season 3', air_date: null }] }, TODAY));
test('TMDB already names another season "Season 5" → D', 'D', () =>
  gradeTv(S5(), { ...SILO, seasons: [...SILO.seasons.slice(0, 3), { season_number: 4, name: 'Season 5', air_date: '2027-07-08' }] }, TODAY));
test('once TMDB lists the season, normal grading applies (dates match) → A', 'A', () =>
  gradeTv(S5({ display_date: 'Jul 1, 2028', date_sort: '2028-07-01' }), { ...SILO, seasons: [...SILO.seasons, { season_number: 5, name: 'Season 5', air_date: '2028-07-01' }] }, TODAY));
test('provisional season of a show whose title doesn\'t match → D', 'D', () =>
  gradeTv(S5(), { ...SILO, id: 244447, name: 'The Hunting Wives', original_name: 'The Hunting Wives' }, TODAY));
test('wrong show: Silo row → a show with a different title', 'D',
  () => gradeTv(SILO_S4, { ...SILO, id: 244447, name: 'The Hunting Wives', original_name: 'The Hunting Wives',
    seasons: [{ season_number: 4, air_date: '2029-01-01' }] }));

// ─── Owner-approved exceptions (tools/identity-exceptions.json) ───
// TMDB objects trimmed from real responses (2026-10-05).
const EXC = loadExceptions(new URL('../tools/identity-exceptions.json', import.meta.url).pathname);
const VISIONS = { id: 114478, name: 'Star Wars: Visions', original_name: 'Star Wars: Visions', alternative_titles: { results: [] }, seasons: [
  { season_number: 0, name: 'Specials', air_date: '2021-09-22' }, { season_number: 1, name: 'Season 1', air_date: '2021-09-22' },
  { season_number: 2, name: 'Volume 2', air_date: '2023-05-04' }, { season_number: 3, name: 'Volume 3', air_date: '2025-10-29' }] };
const REBELS = { id: 60554, name: 'Star Wars Rebels', original_name: 'Star Wars Rebels', alternative_titles: { results: [] }, seasons: [
  { season_number: 0, name: 'Specials', air_date: '2014-08-11' }, { season_number: 1, name: 'Season 1', air_date: '2014-10-13' },
  { season_number: 2, name: 'Season 2', air_date: '2015-10-14' }] };
const ACOLYTE = { id: 114479, name: 'The Acolyte', original_name: 'The Acolyte', seasons: [{ season_number: 1, name: 'Season 1', air_date: '2024-06-04' }],
  alternative_titles: { results: [{ iso_3166_1: 'US', title: 'Star Wars: The Acolyte', type: 'working title' }] } };
const dRow = (title, tmdb_id, n, season, date_sort, o = {}) => ({ collection: 'disney', title, season, theme: 'Star Wars',
  display_date: date_sort, date_sort, media_type: 'tv', tmdb_id, season_number: n, ...o });
const vol = (n, date, o) => dRow('Star Wars: Visions', 114478, n, `Volume ${n}`, date, o);
const exceptionTest = (name, expected, fn, applied) => test(name, expected, () => {
  const r = fn();
  if (applied !== undefined && JSON.stringify(r.exceptions || []) !== JSON.stringify(applied)) throw new Error(`applied ${JSON.stringify(r.exceptions)}`);
  if (applied && applied.length && !r.findings.some(([g, w]) => g === 'B' && w.startsWith(`accepted exception ${applied[0]}: `))) throw new Error('wording');
  return r;
});
exceptionTest('Visions "Volume 1" → s1 (TMDB "Season 1"), with its exception → B', 'B', () => gradeTv(vol(1, '2021-09-22'), VISIONS, TODAY, EXC), ['visions-volume-1']);
exceptionTest('Visions "Volume 2" → s2, with its exception → B', 'B', () => gradeTv(vol(2, '2023-05-04'), VISIONS, TODAY, EXC), ['visions-volume-2']);
exceptionTest('Visions "Volume 3" → s3, with its exception → B', 'B', () => gradeTv(vol(3, '2025-10-29'), VISIONS, TODAY, EXC), ['visions-volume-3']);
exceptionTest('Visions "Volume 2" without exceptions → C', 'C', () => gradeTv(vol(2, '2023-05-04'), VISIONS, TODAY), []);
exceptionTest('"Volume 2" mapped to season 3 (dates made equal) → C: the label is bound to its season', 'C',
  () => gradeTv({ ...vol(2, '2025-10-29'), season_number: 3 }, VISIONS, TODAY, EXC), []);
exceptionTest('Visions "Volume 2" with a far-off stored date → C: the label exception never covers the date', 'C',
  () => gradeTv(vol(2, '2024-06-01'), VISIONS, TODAY, EXC), ['visions-volume-2']);
exceptionTest('TMDB renames season 2 → the bound TMDB value no longer matches → C', 'C',
  () => gradeTv(vol(2, '2023-05-04'), { ...VISIONS, seasons: VISIONS.seasons.map(x => x.season_number === 2 ? { ...x, name: 'Season 2' } : x) }, TODAY, EXC), []);
exceptionTest('same identity in another collection → C', 'C', () => gradeTv(vol(2, '2023-05-04', { collection: 'othertv' }), VISIONS, TODAY, EXC), []);
exceptionTest('never lowers a D: "Volume 4", not on TMDB, released → D', 'D', () => gradeTv(vol(4, '2026-01-01'), VISIONS, TODAY, EXC));
exceptionTest('never touches the provisional rule: "Volume 4", TBA → D (label not "Season N")', 'D',
  () => gradeTv(vol(4, '2099-01-01', { display_date: 'TBA' }), VISIONS, TODAY, EXC));
exceptionTest('Rebels S2 stored premiere 2015-06-20 vs TMDB 2015-10-14, with its exception → B', 'B',
  () => gradeTv(dRow('Star Wars Rebels', 60554, 2, 'Season 2', '2015-06-20'), REBELS, TODAY, EXC), ['rebels-s2-premiere']);
exceptionTest('Rebels S1 needs no exception: normal B (within 31 days)', 'B',
  () => gradeTv(dRow('Star Wars Rebels', 60554, 1, 'Season 1', '2014-10-03'), REBELS, TODAY, EXC), []);
exceptionTest('Rebels S2 with a different stored date → C', 'C',
  () => gradeTv(dRow('Star Wars Rebels', 60554, 2, 'Season 2', '2015-06-21'), REBELS, TODAY, EXC), []);
exceptionTest('Rebels S2 when TMDB moves its season date → C', 'C',
  () => gradeTv(dRow('Star Wars Rebels', 60554, 2, 'Season 2', '2015-06-20'), { ...REBELS, seasons: REBELS.seasons.map(x => x.season_number === 2 ? { ...x, air_date: '2015-10-21' } : x) }, TODAY, EXC), []);
exceptionTest('Rebels S2 date exception does not cover season 1 → C', 'C',
  () => gradeTv(dRow('Star Wars Rebels', 60554, 1, 'Season 1', '2015-06-20'), REBELS, TODAY, EXC), []);
exceptionTest('Acolyte curated title (TMDB working title), with its exception → B', 'B',
  () => gradeTv(dRow('Star Wars: The Acolyte', 114479, 1, 'Season 1', '2024-06-04'), ACOLYTE, TODAY, EXC), ['acolyte-title']);
exceptionTest('Acolyte title without exceptions → C', 'C', () => gradeTv(dRow('Star Wars: The Acolyte', 114479, 1, 'Season 1', '2024-06-04'), ACOLYTE, TODAY), []);
exceptionTest('Acolyte: TMDB drops the working title → C', 'C',
  () => gradeTv(dRow('Star Wars: The Acolyte', 114479, 1, 'Season 1', '2024-06-04'), { ...ACOLYTE, alternative_titles: { results: [] } }, TODAY, EXC), []);
exceptionTest('Acolyte: TMDB makes it an accepted title → normal A, exception unused', 'A',
  () => gradeTv(dRow('Star Wars: The Acolyte', 114479, 1, 'Season 1', '2024-06-04'), { ...ACOLYTE, alternative_titles: { results: [{ iso_3166_1: 'US', title: 'Star Wars: The Acolyte', type: '' }] } }, TODAY, EXC), []);
exceptionTest('Acolyte title plus a far-off date → D (never lowered)', 'D',
  () => gradeTv(dRow('Star Wars: The Acolyte', 114479, 1, 'Season 1', '2023-01-01'), ACOLYTE, TODAY, EXC), []);
exceptionTest('the Acolyte exception does not cover a different stored title → C', 'C',
  () => gradeTv(dRow('Star Wars: The High Republic', 114479, 1, 'Season 1', '2024-06-04'), ACOLYTE, TODAY, EXC), []);

// Validation: a malformed file aborts (it is never silently ignored).
const throws = (name, doc) => test(`exceptions file rejected: ${name}`, 'REJECTED', () => {
  try { validateExceptions(doc); return { grade: 'ACCEPTED', findings: [] }; } catch { return { grade: 'REJECTED', findings: [] }; }
});
const good = EXC[0];
test('the committed exceptions file validates (5 exceptions)', 'OK', () => ({ grade: EXC.length === 5 ? 'OK' : String(EXC.length), findings: [] }));
throws('unknown kind', { version: 1, exceptions: [{ ...good, kind: 'any_finding' }] });
throws('duplicate id', { version: 1, exceptions: [good, good] });
throws('no evidence', { version: 1, exceptions: [{ ...good, evidence: [] }] });
throws('season_label without season_number', { version: 1, exceptions: [{ ...good, season_number: undefined }] });
throws('extra bound value', { version: 1, exceptions: [{ ...good, local: { ...good.local, title: 'x' } }] });
throws('wrong version', { version: 2, exceptions: [] });

// ─── Unknown runtime is not a feature (Ciao Alberto) ───
const CIAO = movie(876716, 'Ciao Alberto', '2021-11-12', 7, ['Animation']);
const CIAO_ROW = movieRow('Ciao Alberto', 876716, '2021-11-12', 'Animation', { collection: 'disney' });
const ciaoCand = runtime => [{ id: 938981, title: 'Ciao Alberto', release_date: '2003-02-01', runtime }];
test('short + same-title work with runtime 0 (unknown) → no short/feature conflict', 'A', () => {
  const r = gradeMovie(CIAO_ROW, CIAO, ciaoCand(0));
  if (!r.sameTitle.length) throw new Error('unknown-runtime work should still be listed');
  return r;
});
test('short + same-title work with no runtime → no conflict', 'A', () => gradeMovie(CIAO_ROW, CIAO, ciaoCand(undefined)));
test('short + same-title 39-min work (also a short) → no conflict', 'A', () => gradeMovie(CIAO_ROW, CIAO, ciaoCand(39)));
test('short + same-title 40-min work (feature) → C', 'C', () => gradeMovie(CIAO_ROW, CIAO, ciaoCand(40)));
test('short + same-title unknown-runtime work that fits the stored date better → C (date rule)', 'C',
  () => gradeMovie({ ...CIAO_ROW, date_sort: '2003-02-01', display_date: 'Feb 1, 2003' }, CIAO, ciaoCand(0)));

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
