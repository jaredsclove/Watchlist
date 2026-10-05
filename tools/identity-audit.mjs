// Read-only identity audit for watchlist_items rows that carry a TMDB identity.
// Run from the repo root: node tools/identity-audit.mjs
//
// Every request is an HTTP GET (see httpGet below); it never writes to Supabase.
// Not part of the app: watchlist.html does not load it.
//
// Grades (a row gets the worst grade among its findings):
//   A  normal: exact or accepted-alternative title, dates agree, season identity agrees
//   B  benign drift: identity still supported, metadata changed (title spelling, TBA now dated, ...)
//   C  needs review: identity ambiguity (short vs feature, material date mismatch, ...)
//   D  wrong identity: TMDB object missing, season missing, or clearly a different work
//
// The looser title matching here is for grading only. identity.js stays strict
// when the app assigns identities; do not reuse these helpers for writes.
//
// The grading functions below are pure (no network); tests/identity-audit.test.mjs
// exercises them offline with synthetic TMDB objects.

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';

// ─── Grading (pure, no network) ───────────────────────────────────────────────

export const SHORT_MIN = 40;   // runtime under this many minutes counts as a short
export const CLOSE_DAYS = 31;  // date difference treated as benign drift

const strict = s => String(s || '').normalize('NFKC').toLowerCase()
  .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const NUM = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve',
  'thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty'];
// Punctuation, "&", leading articles and numerals-as-digits are ignored.
export const looseTokens = s => strict(s).replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
  .map(t => (/^\d+$/.test(t) && +t <= 20) ? NUM[+t] : t).filter(t => !['the', 'a', 'an'].includes(t));
const looseKey = s => looseTokens(s).join(' ');
const jaccard = (a, b) => {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / (new Set([...A, ...B]).size || 1);
};

// US/GB alternative titles count as accepted names, except working, promotional
// and former titles (e.g. 617126 lists the working title "Blue Moon").
export function acceptedAltTitles(list) {
  return (list || [])
    .filter(t => ['US', 'GB', ''].includes(t.iso_3166_1 || '') && !/working|promotional|former/i.test(t.type || ''))
    .map(t => t.title);
}

// → { kind: 'exact' | 'alt' | 'loose' | 'similar' | 'different', sim? }
export function titleMatch(stored, primary, alts) {
  if (primary.some(t => strict(t) === strict(stored))) return { kind: 'exact' };
  if (alts.some(t => strict(t) === strict(stored))) return { kind: 'alt' };
  const key = looseKey(stored);
  if ([...primary, ...alts].some(t => looseKey(t) === key)) return { kind: 'loose' };
  const sim = Math.max(0, ...[...primary, ...alts].map(t => jaccard(looseTokens(stored), looseTokens(t))));
  return { kind: sim >= 0.5 ? 'similar' : 'different', sim: +sim.toFixed(2) };
}

const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);
export const isTba = r => /TBA/i.test(r.display_date || '') || !r.date_sort || r.date_sort >= '2099';
export const isShort = m => !!m && m.runtime > 0 && m.runtime < SHORT_MIN;

function compareDate(row, tmdbDate) {
  if (isTba(row)) return tmdbDate ? 'tba-now-dated' : 'tba-both';
  if (!tmdbDate) return 'tmdb-undated';
  if (tmdbDate === row.date_sort) return 'match';
  return days(tmdbDate, row.date_sort) <= CLOSE_DAYS ? 'close' : 'mismatch';
}

const RANK = { A: 0, B: 1, C: 2, D: 3 };
function result(findings, sameTitle = []) {
  const grade = findings.reduce((g, [x]) => RANK[x] > RANK[g] ? x : g, 'A');
  return { grade, findings, sameTitle };
}

// Other TMDB movies whose title matches the row's title (loosely), excluding the linked one.
export function sameTitleCandidates(row, movie, searchResults) {
  return (searchResults || []).filter(c => c.id !== movie?.id && looseKey(c.title) === looseKey(row.title));
}

// movie: TMDB /movie/{id}?append_to_response=alternative_titles, or null if TMDB has no such id.
// candidates: same-title movies [{ id, title, release_date, runtime? }]; runtime is
// needed only when the linked movie is a short.
export function gradeMovie(row, movie, candidates = []) {
  if (!movie) return result([['D', `TMDB movie ${row.tmdb_id} not found`]]);
  const f = [];
  const add = (g, why) => f.push([g, why]);
  const rel = movie.release_date || '';
  const date = compareDate(row, rel);
  const t = titleMatch(row.title, [movie.title, movie.original_title], acceptedAltTitles(movie.alternative_titles?.titles));

  if (date === 'tba-now-dated') add('B', `stored TBA, TMDB now ${rel}`);
  if (date === 'tmdb-undated') add('C', `stored ${row.date_sort}, TMDB has no release date`);
  if (date === 'close') add('B', `date ${row.date_sort} vs TMDB ${rel} (within ${CLOSE_DAYS} days)`);
  if (date === 'mismatch') add('C', `date ${row.date_sort} vs TMDB ${rel}`);

  if (t.kind === 'alt') add('A', 'title matches an accepted TMDB alternative title');
  if (t.kind === 'loose') add('B', `title drift: "${row.title}" vs TMDB "${movie.title}" (punctuation/numerals/articles only)`);
  if (t.kind === 'similar') add(date === 'match' || date === 'close' ? 'B' : 'C', `title changed: "${row.title}" vs TMDB "${movie.title}" (similarity ${t.sim})`);
  if (t.kind === 'different') add(date === 'mismatch' ? 'D' : 'C', `title "${row.title}" vs TMDB "${movie.title}" (similarity ${t.sim})`);

  if (row.season !== 'Film') add('C', `movie row has season label "${row.season}"`);
  if (row.season_number != null) add('D', 'movie row has a season_number');

  // The Movies tab stores TMDB genres[0] as theme; other tabs store a company name.
  const genres = (movie.genres || []).map(x => x.name);
  if (row.collection === 'movies') {
    if ((row.theme === 'Documentary') !== genres.includes('Documentary')) add('C', `documentary mismatch: stored theme "${row.theme}", TMDB genres [${genres.join(', ')}]`);
    else if (genres.length && !genres.includes(row.theme)) add('B', `stored genre "${row.theme}" not in TMDB genres [${genres.join(', ')}]`);
  }

  const short = isShort(movie);
  const same = sameTitleCandidates(row, movie, candidates);
  if (short || date === 'mismatch' || date === 'tmdb-undated') {
    for (const c of same) {
      // A feature needs a known feature-length runtime: TMDB's 0 (or none) means unknown.
      if (short && c.runtime >= SHORT_MIN) add('C', `linked work is a ${movie.runtime}-min short; same-title feature exists: ${c.id} (${c.release_date}, ${c.runtime} min)`);
      if (!isTba(row) && c.release_date && days(c.release_date, row.date_sort) <= CLOSE_DAYS) add('C', `another same-title work ${c.id} (${c.release_date}) matches the stored date better`);
    }
  }
  return result(f, same.map(c => `${c.id} "${c.title}" (${c.release_date || 'no date'})`));
}

// show: TMDB /tv/{id}?append_to_response=alternative_titles, or null if TMDB has no such id.
// Today's date (local), as YYYY-MM-DD.
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// A season TMDB doesn't list is normally D. It is a provisional B only when the
// curated catalog is simply one season ahead of TMDB: the show itself matches
// (title graded as usual), the label is exactly "Season N" for this row's N >= 1,
// N is TMDB's next season (highest listed + 1; no gap, no lower number), no TMDB
// season already carries the name "Season N", and the season is TBA or future-dated.
// It is never reported as TMDB-verified. Once TMDB lists it, normal grading applies.
export function provisionalSeason(row, show, today) {
  const n = row.season_number;
  const listed = (show.seasons || []).map(x => x.season_number);
  return Number.isInteger(n) && n >= 1 && row.season === `Season ${n}`
    && n === Math.max(0, ...listed) + 1
    && !(show.seasons || []).some(x => (x.name || '').trim() === `Season ${n}`)
    && (isTba(row) || (row.date_sort || '') > today);
}

// ─── Owner-approved exceptions (tools/identity-exceptions.json) ──────────────
// An exception turns one specific C finding of one identified row into B (never A)
// while every value it is bound to still matches: collection, media type, TMDB id,
// season (where it has one), the local value and TMDB's value. It never applies to
// a D, to a provisional season, or to any other finding.

export const EXCEPTION_KINDS = {
  // label "Volume 2" vs season_number 2
  season_label: { local: ['season'], tmdb: ['season_name'], seasonal: true },
  // stored date vs TMDB season air date, outside 31 days
  season_date: { local: ['date_sort'], tmdb: ['air_date'], seasonal: true },
  // stored show title vs TMDB title that only a working title supports
  show_title: { local: ['title'], tmdb: ['name', 'alternative_title', 'alternative_title_type'], seasonal: false },
};

// Throws on anything malformed, so a bad file aborts the audit instead of being ignored.
export function validateExceptions(doc) {
  if (!doc || doc.version !== 1 || !Array.isArray(doc.exceptions)) throw new Error('identity exceptions: expected { version: 1, exceptions: [...] }');
  const ids = new Set();
  for (const e of doc.exceptions) {
    const where = `identity exception ${JSON.stringify(e && e.id)}`;
    const k = e && EXCEPTION_KINDS[e.kind];
    if (!k) throw new Error(`${where}: unknown kind ${JSON.stringify(e && e.kind)}`);
    if (typeof e.id !== 'string' || !e.id || ids.has(e.id)) throw new Error(`${where}: missing or duplicate id`);
    ids.add(e.id);
    if (typeof e.collection !== 'string' || !e.collection || e.media_type !== 'tv' || !Number.isInteger(e.tmdb_id) || e.tmdb_id <= 0) throw new Error(`${where}: collection, media_type "tv" and tmdb_id are required`);
    if (k.seasonal ? !(Number.isInteger(e.season_number) && e.season_number >= 0) : e.season_number !== undefined) throw new Error(`${where}: season_number ${k.seasonal ? 'required' : 'not allowed'} for ${e.kind}`);
    for (const [side, keys] of [['local', k.local], ['tmdb', k.tmdb]]) {
      if (!e[side] || Object.keys(e[side]).sort().join() !== [...keys].sort().join() || keys.some(x => typeof e[side][x] !== 'string' || !e[side][x])) {
        throw new Error(`${where}: ${side} must have exactly ${keys.join(', ')}`);
      }
    }
    if (typeof e.reason !== 'string' || e.reason.length < 20) throw new Error(`${where}: reason required`);
    if (!Array.isArray(e.evidence) || !e.evidence.length || e.evidence.some(u => !/^https:\/\/\S+$/.test(u))) throw new Error(`${where}: evidence URLs required`);
  }
  return doc.exceptions;
}

const sameTarget = (e, row) => e.collection === row.collection && e.media_type === row.media_type && e.tmdb_id === row.tmdb_id
  && (EXCEPTION_KINDS[e.kind].seasonal ? e.season_number === row.season_number : true);

// Report lines for the exceptions file. applied: Map id → [{ label, grade }] for the rows
// where the exception changed a finding. An exception can apply while another finding
// still fails the row (C/D); that is reported as such, never as a pass.
export function exceptionReport(exceptions, applied, identified) {
  return exceptions.map(e => {
    const hits = applied.get(e.id) || [];
    if (hits.length) {
      return hits.map(h => ['C', 'D'].includes(h.grade)
        ? `  applied, ROW STILL FAILS  ${e.id} → ${h.label}: grade ${h.grade} from another finding (this exception covers only its own finding)`
        : `  applied      ${e.id} → ${h.label} (grade ${h.grade})`).join('\n');
    }
    const target = `${e.collection} tv ${e.tmdb_id}${e.season_number !== undefined ? ' s' + e.season_number : ''}`;
    const onRow = identified.some(r => r.collection === e.collection && r.media_type === e.media_type && r.tmdb_id === e.tmdb_id
      && (e.season_number === undefined || r.season_number === e.season_number));
    return `  not applied  ${e.id} (${target}): ${onRow ? 'the row no longer has exactly this finding with the bound values; review or retire it' : 'no identified row with this identity'}`;
  });
}

export function gradeTv(row, show, today = localToday(), exceptions = []) {
  if (!show) return { ...result([['D', `TMDB tv ${row.tmdb_id} not found`]]), exceptions: [] };
  const s = (show.seasons || []).find(x => x.season_number === row.season_number);
  const f = [];
  const add = (g, why) => f.push([g, why]);
  if (!s) {
    if (!provisionalSeason(row, show, today)) {
      const released = !isTba(row) && (row.date_sort || '') <= today;
      return { ...result([['D', `show ${row.tmdb_id} (${show.name}) has no season ${row.season_number}${released ? ' (already released)' : ''}`]]), exceptions: [] };
    }
    add('B', `provisional future season not yet listed by TMDB (season ${row.season_number}; not TMDB-verified)`);
    const t = titleMatch(row.title, [show.name, show.original_name], acceptedAltTitles(show.alternative_titles?.results));
    if (t.kind === 'loose') add('B', `show title drift: "${row.title}" vs TMDB "${show.name}"`);
    if (t.kind === 'similar') add('C', `show title changed: "${row.title}" vs TMDB "${show.name}" (similarity ${t.sim})`);
    if (t.kind === 'different') add('D', `show title "${row.title}" vs TMDB "${show.name}" (similarity ${t.sim})`);
    return { ...result(f), exceptions: [] }; // exceptions never apply to provisional seasons
  }
  const air = s.air_date || '';
  const date = compareDate(row, air);
  const t = titleMatch(row.title, [show.name, show.original_name], acceptedAltTitles(show.alternative_titles?.results));

  // A C finding an owner-approved exception covers exactly (see EXCEPTION_KINDS) becomes B.
  const applied = [];
  const addC = (kind, why, bound) => {
    const e = exceptions.find(x => x.kind === kind && sameTarget(x, row) && bound(x));
    if (!e) return add('C', why);
    applied.push(e.id);
    add('B', `accepted exception ${e.id}: ${why}`);
  };

  const expected = row.season_number === 0 ? 'Specials' : `Season ${row.season_number}`;
  if (row.season !== expected) addC('season_label', `season label "${row.season}" vs season_number ${row.season_number}`,
    e => e.local.season === row.season && e.tmdb.season_name === (s.name || '').trim());

  if (date === 'tba-now-dated') add('B', `stored TBA, TMDB now ${air}`);
  if (date === 'tmdb-undated') add('B', `stored ${row.date_sort}, TMDB season now undated`);
  if (date === 'close') add('B', `season date ${row.date_sort} vs TMDB ${air} (within ${CLOSE_DAYS} days)`);
  if (date === 'mismatch') addC('season_date', `season date ${row.date_sort} vs TMDB ${air}`,
    e => e.local.date_sort === row.date_sort && e.tmdb.air_date === air);

  if (t.kind === 'alt') add('A', 'title matches an accepted TMDB alternative title');
  if (t.kind === 'loose') add('B', `show title drift: "${row.title}" vs TMDB "${show.name}"`);
  if (t.kind === 'similar') add(date === 'mismatch' ? 'C' : 'B', `show title changed: "${row.title}" vs TMDB "${show.name}" (similarity ${t.sim})`);
  if (t.kind === 'different') {
    const why = `show title "${row.title}" vs TMDB "${show.name}" (similarity ${t.sim})`;
    if (date === 'mismatch' || date === 'tmdb-undated') add('D', why);
    else addC('show_title', why, e => e.local.title === row.title && e.tmdb.name === show.name
      && (show.alternative_titles?.results || []).some(a => a.title === e.tmdb.alternative_title
        && (a.type || '').toLowerCase() === e.tmdb.alternative_title_type.toLowerCase()));
  }
  return { ...result(f), exceptions: applied };
}

// ─── Network (GET only) ───────────────────────────────────────────────────────

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// config.js is a classic browser script; its top-level consts are read in a sandbox.
function loadConfig() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'config.js'), 'utf8'), ctx);
  return vm.runInContext('({ SUPABASE_URL, SUPABASE_KEY, TABLE, TMDB_TOKEN, TMDB_BASE })', ctx);
}

// The only function that performs HTTP. Always GET. Returns null only for an
// allowed 404; any other failure throws so the audit never reports a partial result.
async function httpGet(url, headers, { allow404 = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: 'GET', headers });
    if (res.ok) return res;
    if (res.status === 404 && allow404) return null;
    if (attempt >= 4 || (res.status < 500 && res.status !== 429)) {
      throw new Error(`GET ${url.split('?')[0]} failed: ${res.status} ${await res.text()}`);
    }
    await new Promise(r => setTimeout(r, 1000 * attempt));
  }
}

async function fetchAllRows(cfg, table) {
  const headers = { apikey: cfg.SUPABASE_KEY, Authorization: `Bearer ${cfg.SUPABASE_KEY}`, 'Range-Unit': 'items', Prefer: 'count=exact' };
  const rows = [];
  let total = null;
  while (total === null || rows.length < total) {
    const res = await httpGet(`${cfg.SUPABASE_URL}/rest/v1/${table}?select=*&order=id.asc`, { ...headers, Range: `${rows.length}-${rows.length + 499}` });
    const m = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
    if (!m) throw new Error(`${table}: missing Content-Range total`);
    total = +m[1];
    const page = await res.json();
    if (!page.length && rows.length < total) throw new Error(`${table}: empty page at offset ${rows.length} of ${total}`);
    rows.push(...page);
  }
  if (rows.length !== total || new Set(rows.map(r => r.id)).size !== total) throw new Error(`${table}: fetched ${rows.length} rows, expected ${total}`);
  return rows;
}

function tmdbClient(cfg) {
  const cache = new Map();
  const headers = { Authorization: `Bearer ${cfg.TMDB_TOKEN}` };
  return async (p, opts) => {
    if (!cache.has(p)) cache.set(p, httpGet(cfg.TMDB_BASE + p, headers, opts).then(r => r && r.json()));
    return cache.get(p);
  };
}

// Reads and validates tools/identity-exceptions.json (an empty list if the file is absent).
export function loadExceptions(file = path.join(repoRoot, 'tools/identity-exceptions.json')) {
  if (!fs.existsSync(file)) return [];
  return validateExceptions(JSON.parse(fs.readFileSync(file, 'utf8')));
}

async function auditRow(row, tmdb, exceptions) {
  if (row.media_type === 'tv') {
    return gradeTv(row, await tmdb(`/tv/${row.tmdb_id}?append_to_response=alternative_titles`, { allow404: true }), localToday(), exceptions);
  }
  if (row.media_type === 'movie') {
    const movie = await tmdb(`/movie/${row.tmdb_id}?append_to_response=alternative_titles`, { allow404: true });
    let candidates = [];
    if (movie) {
      const search = await tmdb(`/search/movie?query=${encodeURIComponent(row.title)}&include_adult=false`);
      candidates = sameTitleCandidates(row, movie, search.results);
      if (isShort(movie)) {
        candidates = await Promise.all(candidates.map(async c => ({ ...c, runtime: (await tmdb(`/movie/${c.id}`)).runtime })));
      }
    }
    return gradeMovie(row, movie, candidates);
  }
  return result([['D', `identified row has media_type ${JSON.stringify(row.media_type)}`]]);
}

async function main() {
  const cfg = loadConfig();
  const exceptions = loadExceptions();
  console.log('Identity audit — READ-ONLY: issues HTTP GET requests only; nothing is written.');
  console.log(`Supabase host: ${new URL(cfg.SUPABASE_URL).host}  table: ${cfg.TABLE}`);
  console.log(`Started: ${new Date().toISOString()}`);

  const rows = await fetchAllRows(cfg, cfg.TABLE);
  const identified = rows.filter(r => r.tmdb_id != null);
  console.log(`${cfg.TABLE} rows fetched: ${rows.length} (identified: ${identified.length}, legacy/unidentified: ${rows.length - identified.length})\n`);

  const tmdb = tmdbClient(cfg);
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  const flagged = [], ambiguous = [];
  const applied = new Map();
  for (const row of identified) {
    const res = await auditRow(row, tmdb, exceptions);
    for (const id of res.exceptions || []) applied.set(id, [...(applied.get(id) || []), { label: `${row.collection} | ${row.title} ${row.season || ''} | tv ${row.tmdb_id} s${row.season_number}`, grade: res.grade }]);
    counts[res.grade]++;
    const label = `${row.collection} | ${row.title} ${row.season || ''} | ${row.media_type} ${row.tmdb_id}${row.season_number != null ? ' s' + row.season_number : ''} | ${row.id}`;
    if (res.grade !== 'A') flagged.push(`${res.grade}  ${label}\n${res.findings.map(([g, w]) => `     [${g}] ${w}`).join('\n')}`);
    if (res.sameTitle.length) ambiguous.push(`${res.grade}  ${label}\n     same-title works on TMDB: ${res.sameTitle.join('; ')}`);
  }
  const graded = counts.A + counts.B + counts.C + counts.D;
  if (graded !== identified.length) throw new Error(`graded ${graded} of ${identified.length} identified rows`);

  console.log(`Rows audited: ${graded}`);
  console.log(`A ${counts.A} / B ${counts.B} / C ${counts.C} / D ${counts.D}\n`);
  console.log(`B/C/D rows (${flagged.length}):`);
  console.log(flagged.length ? flagged.join('\n') : '  none');
  console.log(`\nSame-title ambiguity (${ambiguous.length} rows with other same-title works on TMDB; informational unless graded C/D above):`);
  console.log(ambiguous.length ? ambiguous.join('\n') : '  none');
  console.log(`\nOwner-approved exceptions (${exceptions.length} in tools/identity-exceptions.json; each turns one specific C into B, never A):`);
  for (const line of exceptionReport(exceptions, applied, identified)) console.log(line);
  const pass = counts.C === 0 && counts.D === 0;
  console.log(`\nRESULT: ${pass ? 'PASS' : 'FAIL'} — ${counts.C} C, ${counts.D} D`);
  return pass;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(pass => process.exit(pass ? 0 : 1), e => {
    console.error(`\nAUDIT ABORTED (no result): ${e.message}`);
    process.exit(2);
  });
}
