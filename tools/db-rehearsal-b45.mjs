// Local rehearsal of B4/B5 Batch A (db/b45_expand.sql, db/rollback/b45.sql) on PGlite replicas
// of real backups (plan §16.1, evidence R):
//   M1   the migration's per-status counts and per-id results equal §7.1 applied to the
//        baseline (the owner's recorded choices for Complete shows); A-2: every pre-existing
//        column of every table is unchanged except the mapped statuses; db/test/t_b45.sql;
//   M2   the page's 4 → 5 converter (backup-restore.js) on the baseline's format-4 export
//        equals the migration, except the conversion variants, which equal the converter column;
//   M3   restore input classes: native format 5 round trip; native format 4 converted (no
//        archive entries); format 3 converted 3 → 4 → 5 with its recovery section (archive
//        entries written while the archive is active);
//   RL8/RL11  active and completed-but-retained ranges round trip in format 5 (the derived
//        state equal, SQL and the page's resumeRange agree); conversions give no range;
//   B2   untouched round trip: migrate → rollback equals the original baseline exactly
//        (every column of every table, owners included; schema; functions; the archive);
//   B1/B5/RL12  after edits: the report's tiers; the lossy acceptance required; afterwards
//        statuses by tier, every 5c-era column at its pre-rollback value, inventory = baseline;
//   B4   binding under lock: a change after the dry run to any of the 12 tables, the
//        inventory, or an approval naming another report → refused before mutation, state
//        unchanged; the P1 association check (tools/b45-backup-digest.mjs) equals the
//        report's backup digests, and a mismatched P1 file fails it;
//   B3   the D2 chain: B45 → rollback → the pinned db/rollback/phase5c.sql equals running
//        that rollback without B45; the pinned rollback refuses while B45 is installed;
//   W8   catalog previews on real data write nothing; an apply creates To Watch / Normal /
//        New; a replay is stale;
//   fail failure injection after every statement of db/b45_expand.sql and db/rollback/b45.sql:
//        the state is unchanged each time.
// Nothing here touches Supabase. PGlite is one session (no lock waits or interleavings).
//   PGLITE_DIR=/path/with/node_modules node tools/db-rehearsal-b45.mjs --h3 <format4.json> --f4 <format4.json> --f3 <format3.json>
//     [--expect <json>] [--choices <json>] [--evidence <dir>] [--no-inject]
// --h3: the recovery baseline (format 4; most checks run on it); --f4 / --f3: further retained
// backups (format 4 / format 3). --expect: the baseline's expected figures (private; kept outside
// the repository): { completeTitles, counts, currentlyWatching, endedExit }. --choices: the
// owner's recorded choices {shows:{title:status}} for Complete shows (default: every Complete
// show → watching); films watching / complete → to_watch.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { b45BackupDigests, associate, approvalToken, reportSha256 } from './b45-backup-digest.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const files = { h3: opt('--h3'), f4: opt('--f4'), f3: opt('--f3') };
if (!files.h3 || !files.f4 || !files.f3 || !process.env.PGLITE_DIR) {
  console.error('usage: PGLITE_DIR=… node tools/db-rehearsal-b45.mjs --h3 <format4> --f4 <format4> --f3 <format3> [--choices <json>] [--evidence <dir>] [--no-inject]');
  process.exit(2);
}
const evidenceDir = opt('--evidence');
const inject = !argv.includes('--no-inject');
const choicesByTitle = opt('--choices') ? JSON.parse(fs.readFileSync(opt('--choices'), 'utf8')) : null;
const expect = opt('--expect') ? JSON.parse(fs.readFileSync(opt('--expect'), 'utf8')) : null;
const req = createRequire(path.join(process.env.PGLITE_DIR, 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));
const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const inputs = Object.fromEntries(Object.entries(files).map(([k, f]) => { const t = fs.readFileSync(f); return [k, { sha256: sha(t), doc: JSON.parse(t) }]; }));
if (inputs.h3.doc.formatVersion !== 4 || inputs.f4.doc.formatVersion !== 4 || inputs.f3.doc.formatVersion !== 3) { console.error('needs --h3 / --f4 format 4 and --f3 format 3'); process.exit(2); }

let failed = 0;
const ok = (cond, label, detail = '') => { if (!cond) failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${String(detail).slice(0, 2000)}` : ''}`); return cond; };
const section = t => console.log(`\n[${t}]`);
const evidence = { inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.sha256])), sections: {} };

// ── The page's own code (converter, validators, the §4.7 helpers) ──
const page = { console, Map, Set, JSON, Date, Math, Array, Object, String, Number, Boolean, RegExp, Error, Promise, parseInt, isFinite,
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} }, window: {}, localStorage: { getItem: () => null, setItem() {} },
  crypto: crypto.webcrypto, TextEncoder };
page.window = page;
vm.createContext(page);
for (const f of ['config.js', 'ui-helpers.js', 'metadata.js', 'api.js', 'backup-restore.js', 'backup-format3.js', 'render.js', 'tv-shows.js', 'derived-views.js']) {
  vm.runInContext(sql(f), page, { filename: f });
}
const P = expr => vm.runInContext(expr, page);

// ── Replicas ──
async function replica3(f3doc) {
  const db = new PGlite();
  const anon = (s, p) => db.transaction(async tx => { await tx.query(`select set_config('request.jwt.claims', '', true), set_config('role', 'anon', true)`); return (await tx.query(s, p)).rows; });
  for (const f of ['db/test/supabase_shim.sql', 'db/test/replica_schema.sql', 'db/phase0_restore_v1.sql']) await db.exec(sql(f));
  await db.exec(`set timezone = 'UTC'`);
  for (const f of ['db/phase1b_ownership.sql', 'db/restore_backup.sql', 'db/phase1c_tv_schema.sql', 'db/tv_model.sql', 'db/rpc.sql', 'db/admin/tv_enrich.sql']) await db.exec(sql(f));
  await db.exec(`update private.migration_stage set stage = 'final'`);
  await db.exec(sql('db/phase3b_org.sql'));
  await anon(`select public.restore_backup($1::jsonb, false)`, [f3doc]);
  for (const f of ['db/phase3b2_org_write.sql', 'db/phase4a_catalog.sql', 'db/phase4b_add_to_show.sql', 'db/phase5a_expand.sql', 'db/phase5c_contract.sql']) await db.exec(sql(f));
  return { db, anon };
}
// A 5c replica holding a format-4 backup: 5c built from the format-3 backup, then restore_backup(format 4).
async function replica4(f4doc) {
  const R = await replica3(inputs.f3.doc);
  await R.anon(`select public.restore_backup($1::jsonb) r`, [f4doc]);
  return R;
}
const one = async (db, s, p) => (await db.query(s, p)).rows[0];
const val = async (db, s, p) => Object.values(await one(db, s, p))[0];

// ── Snapshots ──
const TABLES = ['tv_shows', 'watchlist_items', 'custom_collections', 'personal_collections', 'collection_memberships', 'watch_with_choices', 'catalog_show_links', 'catalog_film_links'];
const ARCHIVE = ['stage5_recovery_records', 'stage5_recovery_collections', 'stage5_recovery_othertv', 'stage5_recovery_meta'];
// Every row of every table (every column, owners included), by id; the archive by row text.
// A table that doesn't exist in the current phase (othertv_shows at 5c; the links after the
// 5c rollback) is left out.
const exists = async (db, t) => !!(await val(db, `select to_regclass($1)::text`, [t]));
async function rowsOf(db) {
  const out = {};
  for (const t of TABLES.concat(['othertv_shows'])) {
    if (!(await exists(db, `public.${t}`))) continue;
    out[t] = Object.fromEntries((await db.query(`select id::text id, to_jsonb(t) j from public.${t} t order by id`)).rows.map(r => [r.id, r.j]));
  }
  return out;
}
async function archiveMd5(db) {
  const out = {};
  for (const t of ARCHIVE) out[t] = (await exists(db, `private.${t}`)) ? await val(db, `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.${t} t`) : null;
  return JSON.stringify(out);
}
const CAT = `select json_build_object(
  'indexes', (select json_agg(indexdef order by indexdef) from pg_indexes where schemaname in ('public', 'private')),
  'constraints', (select json_agg(x order by x) from (select conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid) x
    from pg_constraint where connamespace in ('public'::regnamespace, 'private'::regnamespace) and contype <> 'n') s),
  'columns', (select json_agg(x order by x) from (select table_schema || '.' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' ||
    coalesce(column_default, '') x from information_schema.columns where table_schema in ('public', 'private')) s),
  'column_grants', (select json_agg(x order by x) from (select table_name || '.' || column_name || ' ' || grantee || ' ' || privilege_type x
    from information_schema.column_privileges where table_schema in ('public', 'private') and grantee in ('anon', 'authenticated', 'service_role')) s),
  'table_grants', (select json_agg(x order by x) from (select table_schema || '.' || table_name || ' ' || grantee || ' ' || privilege_type x
    from information_schema.role_table_grants where table_schema in ('public', 'private') and grantee in ('anon', 'authenticated', 'service_role')) s),
  'functions', (select json_agg(x order by x) from (select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' ||
    md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text, '') x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')) s),
  'triggers', (select json_agg(x order by x) from (select pg_get_triggerdef(oid) x from pg_trigger where not tgisinternal) s),
  'views', (select json_agg(x order by x) from (select viewname || ' ' || md5(definition) x from pg_views where schemaname = 'public') s),
  'policies', (select json_agg(x order by x) from (select tablename || '.' || policyname || ' ' || cmd || ' ' || roles::text x from pg_policies where schemaname = 'public') s),
  'tables', (select json_agg(x order by x) from (select schemaname || '.' || tablename x from pg_tables where schemaname in ('public', 'private')) s)
)::text c`;
const catDiff = (a, b) => { a = JSON.parse(a); b = JSON.parse(b); return Object.keys({ ...a, ...b }).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
  .map(k => `${k}: only before ${JSON.stringify((a[k] || []).filter(x => !(b[k] || []).includes(x)).slice(0, 3))} only after ${JSON.stringify((b[k] || []).filter(x => !(a[k] || []).includes(x)).slice(0, 3))}`); };
async function state(db) { return { rows: await rowsOf(db), archive: await archiveMd5(db), cat: await val(db, CAT) }; }
const sameState = (a, b) => JSON.stringify(a.rows) === JSON.stringify(b.rows) && a.archive === b.archive && a.cat === b.cat;
const stateDigest = s => sha(JSON.stringify(s));
// Differences between two row sets (table, id, column), up to a limit.
function rowDiff(a, b, ignore = () => false, limit = 20) {
  const out = [];
  for (const t of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
    const ids = new Set([...Object.keys(a[t] || {}), ...Object.keys(b[t] || {})]);
    for (const id of ids) {
      const x = (a[t] || {})[id], y = (b[t] || {})[id];
      if (!x || !y) { out.push(`${t} ${id}: ${x ? 'removed' : 'added'}`); continue; }
      for (const c of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (ignore(t, id, c, x, y)) continue;
        if (JSON.stringify(x[c]) !== JSON.stringify(y[c])) out.push(`${t} ${id}.${c}: ${JSON.stringify(x[c])} → ${JSON.stringify(y[c])}`);
      }
      if (out.length >= limit) return out;
    }
  }
  return out;
}
const B45_SHOW_COLS = ['priority', 'ended', 'catalog_new', 'status_review', 'legacy_status', 'genres', 'forms', 'franchises', 'companies', 'genre_candidates',
  'network', 'network_candidates', 'metadata_owner_set', 'resume_start_season_id', 'resume_end_season_id'];
const B45_ITEM_COLS = ['priority', 'catalog_new', 'status_review', 'legacy_status', 'genres', 'forms', 'franchises', 'companies', 'genre_candidates', 'metadata_owner_set'];
const isFilm = r => r.media_type === 'movie' || (r.media_type == null && r.season === 'Film');

// A page-shaped export (as PostgREST returns rows: json, exact text), format 4 or 5.
async function exportDoc(db, version) {
  const spec = P(`backupSpec(${version})`);
  const tables = {};
  for (const t of spec.tables) {
    const cols = Object.keys(spec.columns[t]);
    tables[t] = JSON.parse(await val(db, `select coalesce(json_agg(x order by x.id), '[]')::text j from (select ${cols.map(c => `"${c}"`).join(', ')} from public.${t}) x`));
  }
  return { format: 'watchlist-tracker-backup', formatVersion: version, exportedAt: '2026-10-13T00:00:00.000Z',
    rowCounts: Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length])), tables };
}
const validate = doc => Array.from(P('validateBackupObject')(doc));

// ── Applying B45 and its rollback ──
async function choicesFor(db) {
  const complete = (await db.query(`select id::text id, title from public.tv_shows where status = 'complete' order by title`)).rows;
  const films = (await db.query(`select id::text id from public.watchlist_items where is_film and status in ('watching', 'complete')`)).rows;
  const shows = Object.fromEntries(complete.map(r => [r.id, choicesByTitle ? choicesByTitle.shows[r.title] : 'watching']));
  return { shows, films: Object.fromEntries(films.map(r => [r.id, 'confirmed'])), complete };
}
async function applyB45(db, choices) {
  await db.query(`select set_config('watchlist.b45_choices', $1, false)`, [JSON.stringify({ shows: choices.shows, films: choices.films })]);
  await db.exec(sql('db/b45_expand.sql'));
}
async function dryRun(db) {
  const out = await db.exec(sql('db/rollback/b45_report.sql'));
  const row = out.find(r => r.rows && r.rows[0] && r.rows[0].report_sha256).rows[0];
  return { report: row.report, hash: row.report_sha256 };
}
// The approval procedure (plan §10.2; tools/b45-backup-digest.mjs): the P1 file (the page's
// format-5 export, as text) is checked against the dry run; the token it prints is the approval;
// the preamble it then prints (only for that token and that file) is applied. p1Text: a P1 taken
// earlier (default: exported now). Returns the tool's result.
async function approve(db, dr, lossy, p1Text = null) {
  const text = p1Text ?? JSON.stringify(await exportDoc(db, 5));
  const run = { report: dr.report, report_sha256: dr.hash };
  const first = associate(text, run, { lossy });
  const r = associate(text, run, { lossy, approval: first.token });
  if (!r.ok || !r.preamble) throw new Error(`approval procedure refused: ${r.problems.join('; ')}`);
  await setApproval(db, { reportSha: r.reportSha, lossy, p1Sha: r.p1Sha, digests: r.digests, token: r.token });
  return r;
}
// The preamble's settings, as given (the refusal checks set them by hand).
async function setApproval(db, { reportSha, lossy, p1Sha, digests, token, base = null }) {
  const b = base ?? await val(db, `select md5(baseline_inventory::text) m from private.b45_meta`);
  await db.query(`select set_config('watchlist.b45_rollback_approved', $1, false), set_config('watchlist.b45_rollback_lossy', $2, false),
    set_config('watchlist.b45_rollback_baseline_md5', $3, false), set_config('watchlist.b45_rollback_p1_sha256', $4, false),
    set_config('watchlist.b45_rollback_p1_digests', $5, false), set_config('watchlist.b45_rollback_approval', $6, false)`,
    [reportSha, lossy ? 'accepted' : '', b, p1Sha ?? '', digests ? JSON.stringify(digests) : '', token ?? '']);
}
async function tryExec(db, text) {
  try { const out = await db.exec(text); return { ok: true, out }; }
  catch (e) { await db.exec('rollback').catch(() => {}); return { ok: false, message: e.message }; }
}

// ── A statement splitter (top-level semicolons; quotes, dollar quotes and comments respected) ──
function statements(text) {
  const out = []; let i = 0, start = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i) + 2; continue; }
    if (c === "'") { i++; while (i < text.length) { if (text[i] === "'" && text[i + 1] === "'") i += 2; else if (text[i] === "'") break; else i++; } i++; continue; }
    if (c === '"') { i = text.indexOf('"', i + 1) + 1; continue; }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(text.slice(i));
      if (m) { const end = text.indexOf(m[0], i + m[0].length); i = end + m[0].length; continue; }
    }
    if (c === ';') { out.push(text.slice(start, i + 1)); start = i + 1; }
    i++;
  }
  if (text.slice(start).trim()) out.push(text.slice(start));
  return out;
}
const stmtHead = s => s.replace(/--[^\n]*\n/g, '').trim().split(/\s+/).slice(0, 4).join(' ');

// ═══ The rehearsal ═══
const results = {};
for (const [key, label, build] of [['h3', '--h3 (format 4)', () => replica4(inputs.h3.doc)], ['f4', '--f4 (format 4)', () => replica4(inputs.f4.doc)],
  ['f3', '--f3 (format 3)', () => replica3(inputs.f3.doc)]]) {
  section(`${label}: replica, M1, A-2, t_b45, M2`);
  const R = await build();
  const db = R.db;
  ok((await val(db, `select public.stage5_capabilities() ->> 'phase'`)) === 'contracted', 'the replica is contracted (5c), format 4');
  const base = await state(db);
  const doc4 = await exportDoc(db, 4);
  ok(validate(doc4).length === 0, 'its format-4 export validates (the page’s rules)', validate(doc4).join('\n'));
  const choices = await choicesFor(db);
  if (key === 'h3' && expect) ok(JSON.stringify(choices.complete.map(r => r.title)) === JSON.stringify(expect.completeTitles) && Object.keys(choices.films).length === 0,
    'the baseline’s Complete shows are exactly the expected ones (each with a recorded choice); no film is watching / complete', JSON.stringify(choices.complete));
  // The pinned 5c rollback refuses while B45 is installed (checked after applying); applying:
  const t0 = Date.now();
  await applyB45(db, choices);
  const applyMs = Date.now() - t0;
  const cap = JSON.parse(await val(db, `select public.stage5_capabilities()::text`));
  ok(JSON.stringify(cap) === JSON.stringify({ b45: 1, phase: 'contracted-b45', stage5: 1, backup_format: 5, recovery_archive: 'active' }),
    'capability: contracted-b45, format 5, b45 1, archive active', JSON.stringify(cap));
  const after = await state(db);
  // M1: every mapped value equals §7.1 applied to the baseline.
  const want = { shows: {}, films: {} };
  for (const [id, s] of Object.entries(base.rows.tv_shows)) {
    const o = s.status;
    want.shows[id] = { status: o === 'complete' ? choices.shows[id] : ['pending', 'highpriority', 'maybe'].includes(o) ? 'confirmed' : o,
      priority: o === 'highpriority' ? 'high' : o === 'maybe' ? 'low' : 'normal', ended: o === 'complete', catalog_new: o === 'pending', status_review: false,
      legacy_status: ['pending', 'highpriority', 'maybe', 'complete'].includes(o) ? o : null, resume_start_season_id: null, resume_end_season_id: null,
      genres: [], forms: [], franchises: [], companies: [], genre_candidates: [], network: null, network_candidates: [], metadata_owner_set: false };
  }
  for (const [id, r] of Object.entries(base.rows.watchlist_items)) {
    if (!isFilm(r)) { want.films[id] = Object.fromEntries(B45_ITEM_COLS.map(c => [c, null])); continue; }
    const o = r.status;
    want.films[id] = { status: ['watching', 'complete'].includes(o) ? choices.films[id] : ['pending', 'highpriority', 'maybe'].includes(o) ? 'confirmed' : o,
      priority: o === 'highpriority' ? 'high' : o === 'maybe' ? 'low' : 'normal', catalog_new: o === 'pending', status_review: false,
      legacy_status: ['pending', 'highpriority', 'maybe', 'watching', 'complete'].includes(o) ? o : null,
      genres: [], forms: [], franchises: [], companies: [], genre_candidates: [], metadata_owner_set: false };
  }
  const m1 = [];
  for (const [id, w] of Object.entries(want.shows)) for (const [c, v] of Object.entries(w)) if (JSON.stringify(after.rows.tv_shows[id][c]) !== JSON.stringify(v)) m1.push(`show ${id}.${c}`);
  for (const [id, w] of Object.entries(want.films)) for (const [c, v] of Object.entries(w)) {
    if (c === 'status' && !isFilm(base.rows.watchlist_items[id])) continue;
    if (JSON.stringify(after.rows.watchlist_items[id][c]) !== JSON.stringify(v)) m1.push(`item ${id}.${c}`);
  }
  ok(m1.length === 0, `M1 every show and film equals §7.1 applied to the baseline (${Object.keys(want.shows).length} shows, ${Object.values(base.rows.watchlist_items).filter(isFilm).length} films, season rows NULL)`, m1.slice(0, 20).join('\n'));
  // A-2: every pre-existing column unchanged except the mapped statuses.
  const a2 = rowDiff(base.rows, after.rows, (t, id, c, x) => (t === 'tv_shows' && (B45_SHOW_COLS.includes(c) || (c === 'status' && ['pending', 'highpriority', 'maybe', 'complete'].includes(x.status))))
    || (t === 'watchlist_items' && (B45_ITEM_COLS.includes(c) || (c === 'status' && isFilm(x) && ['pending', 'highpriority', 'maybe', 'watching', 'complete'].includes(x.status)))));
  ok(a2.length === 0 && after.archive === base.archive, 'A-2 every pre-existing column of every table unchanged except the mapped statuses; the archive unchanged', a2.join('\n'));
  const counts = await one(db, `select json_build_object(
    'confirmed', (select count(*) from public.tv_shows where status = 'confirmed'), 'watching', (select count(*) from public.tv_shows where status = 'watching'),
    'skipped', (select count(*) from public.tv_shows where status = 'skipped'), 'high', (select count(*) from public.tv_shows where priority = 'high'),
    'low', (select count(*) from public.tv_shows where priority = 'low'), 'ended', (select count(*) from public.tv_shows where ended),
    'catalog_new', (select count(*) from public.tv_shows where catalog_new), 'legacy_status', (select count(*) from public.tv_shows where legacy_status is not null),
    'status_review', (select count(*) from public.tv_shows where status_review),
    'films', json_build_array((select count(*) from public.watchlist_items where is_film and status = 'confirmed' and not watched),
      (select count(*) from public.watchlist_items where is_film and status = 'confirmed' and watched),
      (select count(*) from public.watchlist_items where is_film and status = 'skipped')),
    'film_legacy', (select count(*) from public.watchlist_items where is_film and legacy_status is not null)) c`);
  evidence.sections[key] = { applyMs, counts: counts.c };
  console.log(`  info counts ${JSON.stringify(counts.c)} (applied in ${applyMs} ms)`);
  if (key === 'h3' && expect) ok(JSON.stringify(counts.c) === JSON.stringify(expect.counts), `M1 the baseline’s expected figures: ${JSON.stringify(expect.counts)}`, JSON.stringify(counts.c));
  // Currently Watching on the migrated data (the page's own derivation).
  const items = JSON.parse(await val(db, `select json_agg(to_jsonb(w) - 'user_id')::text from public.watchlist_items w where not is_film`));
  const shows = JSON.parse(await val(db, `select json_agg(to_jsonb(s) - 'user_id')::text from public.tv_shows s`));
  page.__rows = items; page.__shows = shows;
  const cw = JSON.parse(P(`JSON.stringify((({ active, upToDate }) => active.concat(upToDate).map(x => x.show.title).sort())(deriveCurrentlyWatching(__rows, __shows, '2026-10-13')))`));
  const exits = JSON.parse(P(`JSON.stringify(deriveAllTv(__rows, __shows, '2026-10-13').items.filter(x => x.endedExit).map(x => x.title).sort())`));
  const allSkippedWatching = JSON.parse(P(`JSON.stringify(deriveAllTv(__rows, __shows, '2026-10-13').items.filter(x => x.allSkipped && x.show.status === 'watching').map(x => x.title))`));
  evidence.sections[key].currentlyWatching = cw.length;
  console.log(`  info Currently Watching ${cw.length}; Ended exit ${JSON.stringify(exits)}; all-skipped Watching ${JSON.stringify(allSkippedWatching)}`);
  if (key === 'h3' && expect) ok(cw.length === expect.currentlyWatching && JSON.stringify(exits) === JSON.stringify(expect.endedExit) && allSkippedWatching.length === 0,
    `the baseline’s Currently Watching: ${expect.currentlyWatching} shows; the expected shows take the Ended exit; no Watching show is all skipped`);
  // t_b45 on this replica (synthetic ZZ records inside real data; each check rolled back).
  const out = await db.exec(sql('db/test/_prelude.sql') + '\n' + sql('db/test/t_b45.sql'));
  const last = out.at(-1).rows[0];
  const tres = JSON.parse(last.results);
  ok(tres.every(r => r.ok), `db/test/t_b45.sql: ${last.passed}`, tres.filter(r => !r.ok).map(r => `${r.check}: ${r.detail}`).join('\n'));
  ok(JSON.stringify(await rowsOf(db)) === JSON.stringify(after.rows), 't_b45 left the data unchanged (every check rolled back)');
  // M2: the page's converter on the baseline's format-4 export equals the migration, except the variants.
  const conv = P('convertFormat4To5')(doc4, { sourceSha256: 'a'.repeat(64) });
  ok(conv.refusals.length === 0, 'M2 the page converts the format-4 export', JSON.stringify(conv.refusals));
  const doc5 = await exportDoc(db, 5);
  ok(validate(doc5).length === 0, 'the migrated database’s format-5 export validates', validate(doc5).join('\n'));
  const m2 = [], variants = [];
  for (const t of Object.keys(doc5.tables)) {
    const byId = new Map(conv.doc.tables[t].map(r => [r.id, r]));
    for (const r of doc5.tables[t]) {
      const c = byId.get(r.id);
      if (!c) { m2.push(`${t} ${r.id} missing`); continue; }
      const old = t === 'tv_shows' ? base.rows.tv_shows[r.id].status : t === 'watchlist_items' && isFilm(r) ? base.rows.watchlist_items[r.id].status : null;
      const variant = (t === 'tv_shows' && old === 'complete') || (t === 'watchlist_items' && ['watching', 'complete'].includes(old));
      for (const k of Object.keys(r)) {
        if (JSON.stringify(r[k]) === JSON.stringify(c[k])) continue;
        if (variant) variants.push(`${t} ${r.id}.${k}: migration ${JSON.stringify(r[k])}, converter ${JSON.stringify(c[k])}`);
        else m2.push(`${t} ${r.id}.${k}: migration ${JSON.stringify(r[k])}, converter ${JSON.stringify(c[k])}`);
      }
      if (variant) {
        const m = t === 'tv_shows' ? P('b45MapShowStatus')(old) : P('b45MapFilmStatus')(old);
        if (['status', 'priority', 'catalog_new', 'status_review', 'legacy_status'].some(k => JSON.stringify(c[k]) !== JSON.stringify(m[k]))) m2.push(`${t} ${r.id}: converter ≠ the converter column`);
      }
    }
  }
  ok(m2.length === 0, `M2 the converter equals the migration on every non-variant row; the variants (${variants.length} differing fields) equal the converter column`, m2.slice(0, 20).join('\n'));
  if (variants.length) console.log(`  info variants: ${variants.slice(0, 6).join('; ')}`);
  ok(conv.doc.tables.tv_shows.every(s => s.resume_start_season_id === null && s.resume_end_season_id === null), 'RL11 the 4 → 5 conversion gives no range');

  // B2: untouched round trip.
  section(`${label}: B2 untouched round trip, B3 chain refusal, association check`);
  const p5c = await tryExec(db, sql('db/rollback/phase5c.sql'));
  ok(!p5c.ok && /not contracted|contracted/.test(p5c.message) && JSON.stringify(await rowsOf(db)) === JSON.stringify(after.rows),
    'B3 the pinned 5c rollback refuses while B45 is installed (nothing changed)', p5c.message);
  const dr = await dryRun(db);
  ok(dr.report.lossy === 0, `an untouched migration’s report is exact (tiers ${JSON.stringify(dr.report.tiers)}, lossy ${dr.report.lossy})`, JSON.stringify(dr.report.projected).slice(0, 800));
  const p1 = await exportDoc(db, 5);
  const digests = b45BackupDigests(JSON.parse(JSON.stringify(p1)));
  const sameDigests = (x, y) => Object.keys({ ...x, ...y }).every(t => JSON.stringify(x[t]) === JSON.stringify(y[t]));
  ok(sameDigests(digests, dr.report.backup_digests), 'B4 association: the P1 file’s digests (tools/b45-backup-digest.mjs) equal the report’s backup digests',
    JSON.stringify({ file: digests, report: dr.report.backup_digests }).slice(0, 1500));
  const p1x = JSON.parse(JSON.stringify(p1)); p1x.tables.tv_shows[0].title += ' (later)';
  ok(JSON.stringify(b45BackupDigests(p1x).tv_shows) !== JSON.stringify(dr.report.backup_digests.tv_shows), 'B4 association: a mismatched P1 file fails the check');
  ok(reportSha256(dr.report) === dr.hash, 'the tool recomputes the report’s SHA-256 exactly as the database does');
  await approve(db, dr, false, JSON.stringify(p1));
  const rb = await tryExec(db, sql('db/rollback/b45.sql'));
  ok(rb.ok, 'the rollback runs with the report-bound approval (no lossy acceptance needed)', rb.message);
  const back = await state(db);
  const b2 = rowDiff(base.rows, back.rows);
  ok(b2.length === 0 && back.archive === base.archive, 'B2 every column of every table (owners included) and the archive equal the original baseline', b2.join('\n'));
  ok(back.cat === base.cat, 'B2 schema, functions, triggers, grants, views and policies equal the original baseline', catDiff(base.cat, back.cat).join('\n'));
  ok((await val(db, `select public.stage5_capabilities() ->> 'phase'`)) === 'contracted', 'the capability is contracted again (format 4)');
  results[key] = { R, base, choices };
}

// ═══ The recovery baseline (--h3): restore classes, ranges, rollback tiers, binding, catalog, chain, failure injection ═══
const H = results.h3;
const db = H.R.db;
section('--h3: M3 restore classes and RL8 ranges (format 5 round trip; native format 4; converted format 3)');
await applyB45(db, H.choices);
const asAnon = async (s, p) => db.transaction(async tx => { await tx.query(`select set_config('request.jwt.claims', '', true), set_config('role', 'anon', true)`); return (await tx.query(s, p)).rows; });
// Two real shows get a range: one active, one completed-but-retained (as the page's O9 would set them).
const pickRange = await db.query(`select s.id::text show, s.status,
    (select array_agg(w.id::text order by w.date_sort, w.id) from public.watchlist_items w where w.show_id = s.id and not w.skipped) seasons,
    (select array_agg(w.watched order by w.date_sort, w.id) from public.watchlist_items w where w.show_id = s.id and not w.skipped) watched
  from public.tv_shows s where (select count(*) from public.watchlist_items w where w.show_id = s.id and not w.skipped and w.season ~ '^Season [0-9]+$') >= 3
    and not exists (select 1 from public.watchlist_items w where w.show_id = s.id and w.season !~ '^Season [0-9]+$') order by s.title limit 2`);
ok(pickRange.rows.length === 2, 'two real shows with three or more numbered seasons');
const ranges = [];
for (const [i, r] of pickRange.rows.entries()) {
  const [a, b, c] = r.seasons;
  // Make S1 unwatched and S3 watched (season watched changes, as set_season_watched would), then set the range.
  await asAnon(`select public.set_season_watched($1, false)`, [a]);
  await asAnon(`select public.set_season_watched($1, true)`, [c]);
  if (i === 1) { await asAnon(`select public.set_season_watched($1, true)`, [a]); await asAnon(`select public.set_season_watched($1, true)`, [b]); await asAnon(`select public.set_season_watched($1, false)`, [a]); }
  const st = await val(db, `select status from public.tv_shows where id = $1`, [r.show]);
  const res = await asAnon(`select public.library_set_resume_b45($1, $2::jsonb, $3, $4) r`, [r.show, JSON.stringify({ status: st, resume_start_season_id: null, resume_end_season_id: null }), a, c]);
  ranges.push({ show: r.show, state: res[0].r.resume_state });
  if (i === 1) await asAnon(`select public.set_season_watched($1, true)`, [a]); // the range completes; it is kept
}
const rstates = await db.query(`select id::text id, private.b45_resume_state(id) s from public.tv_shows where resume_start_season_id is not null order by id`);
ok(rstates.rows.length === 2 && rstates.rows.map(x => x.s).sort().join(',') === 'active,complete', 'one active and one completed-but-retained range', JSON.stringify(rstates.rows));
const jsState = async () => {
  page.__rows = JSON.parse(await val(db, `select json_agg(to_jsonb(w) - 'user_id')::text from public.watchlist_items w where not is_film`));
  page.__shows = JSON.parse(await val(db, `select json_agg(to_jsonb(s) - 'user_id')::text from public.tv_shows s where resume_start_season_id is not null`));
  return JSON.parse(P(`JSON.stringify(__shows.map(s => [s.id, resumeRange(s, __rows.filter(r => r.show_id === s.id)).state]).sort())`));
};
const js1 = await jsState();
ok(JSON.stringify(js1) === JSON.stringify(rstates.rows.map(x => [x.id, x.s]).sort()), 'the SQL range state equals the page’s resumeRange for both', JSON.stringify({ js1, sql: rstates.rows }));
const before8 = await state(db);
const doc8 = await exportDoc(db, 5);
ok(validate(doc8).length === 0, 'RL8 the format-5 export with both ranges validates');
const r8 = await asAnon(`select public.restore_backup($1::jsonb) r`, [doc8]).then(r => r[0].r, e => ({ error: e.message }));
ok(!r8.error, 'RL8 / M3 native format 5 restores', JSON.stringify(r8));
const after8 = await state(db);
const d8 = rowDiff(before8.rows, after8.rows);
ok(d8.length === 0 && after8.archive === before8.archive, 'RL8 every value restored exactly (both ranges included); no archive entry', d8.join('\n'));
ok(JSON.stringify(await jsState()) === JSON.stringify(js1), 'RL8 the derived range states are unchanged after the round trip');
// Native format 4 (the baseline's own export) → 4 → 5 in the page → restore: no archive entries.
const conv4 = P('convertFormat4To5')(await (async () => { const d = JSON.parse(JSON.stringify(inputs.h3.doc)); return d; })(), { sourceSha256: inputs.h3.sha256 });
ok(conv4.refusals.length === 0 && validate(conv4.doc).length === 0 && conv4.doc.conversion.source_format === 4 && !conv4.doc.recovery,
  'M3 native format 4 (the --h3 file itself) converts: source format 4, its SHA-256, no recovery section', JSON.stringify(conv4.doc.conversion));
const archBefore4 = await archiveMd5(db);
const r4 = await asAnon(`select public.restore_backup($1::jsonb) r`, [conv4.doc]).then(r => r[0].r, e => ({ error: e.message }));
ok(!r4.error && (await archiveMd5(db)) === archBefore4, 'M3 the converted native format 4 restores and writes no archive entry', JSON.stringify(r4));
ok((await val(db, `select count(*) from public.tv_shows where resume_start_season_id is not null`)) === 0, 'RL11 after it, no range (the converter sets both NULL)');
// Format 3 → 4 → 5 with the recovery section, while the archive is active: converted_restore entries.
const f3text = fs.readFileSync(files.f3);
const conv3 = P('convertFormat3To4')(inputs.f3.doc, { includeRecovery: true, sourceSha256: sha(f3text) });
const conv35 = P('convertFormat4To5')(conv3.doc, { sourceSha256: sha(f3text) });
ok(conv3.refusals.length === 0 && conv35.refusals.length === 0 && validate(conv35.doc).length === 0 && JSON.stringify(conv35.doc.recovery) === JSON.stringify(conv3.doc.recovery)
  && conv35.doc.conversion.source_format === 3 && conv35.doc.conversion.converter_version === `${conv3.doc.conversion.converter_version}+b45.1`,
  'M3 format 3 → 4 → 5: the conversion record and the recovery section are preserved verbatim', JSON.stringify(conv35.doc.conversion));
const r3 = await asAnon(`select public.restore_backup($1::jsonb) r`, [conv35.doc]).then(r => r[0].r, e => ({ error: e.message }));
const meta = await val(db, `select json_agg(origin order by origin)::text from private.stage5_recovery_meta`);
ok(!r3.error && /converted_restore/.test(meta), 'M3 the converted format 3 restores and writes converted_restore archive entries (archive active)', JSON.stringify({ r3, meta }));
const direct = [];
for (const [what, d] of [['format 4 sent directly', inputs.h3.doc], ['format 3 sent directly', inputs.f3.doc]]) {
  const s0 = await state(db);
  const x = await asAnon(`select public.restore_backup($1::jsonb) r`, [d]).then(r => r[0].r, e => ({ error: e.message }));
  direct.push(x.error && /converted in the page first/.test(x.error) && sameState(s0, await state(db)));
}
ok(direct.every(Boolean), 'M3 format 4 and format 3 sent directly are refused (“convert first”), nothing changed');

section('--h3: B1 / B5 / RL12 rollback after edits (tiers, lossy acceptance, pre-rollback values kept)');
// Back to the baseline, migrated (its conversion is not the migration: rebuild from the 5c state).
const H2 = await replica4(inputs.h3.doc);
const db2 = H2.db;
await applyB45(db2, H.choices);
const an2 = async (s, p) => db2.transaction(async tx => { await tx.query(`select set_config('request.jwt.claims', '', true), set_config('role', 'anon', true)`); return (await tx.query(s, p)).rows; });
// Edits through the _b45 functions, as the page sends them.
const showOf = async where => (await db2.query(`select * from public.tv_shows where ${where} order by title limit 1`)).rows[0];
const sState = s => ({ status: s.status, priority: s.priority, ended: s.ended, catalog_new: s.catalog_new, status_review: s.status_review });
const pend = await showOf(`legacy_status = 'pending'`), bb = await showOf(`legacy_status = 'complete'`), plain = await showOf(`legacy_status is null and status = 'confirmed' and not catalog_new`);
await an2(`select public.library_set_show_state_b45($1, $2::jsonb, '{"priority":"high"}'::jsonb)`, [pend.id, JSON.stringify(sState(pend))]);       // 1L: pending with priority high
await an2(`select public.library_set_show_state_b45($1, $2::jsonb, '{"status":"skipped"}'::jsonb)`, [bb.id, JSON.stringify(sState(bb))]);        // tier 3 (the plan's worked example)
await an2(`select public.library_set_metadata_b45('show', $1, $2::jsonb, '{"genres":["Drama"],"network":"AMC"}'::jsonb)`, [plain.id,
  JSON.stringify({ genres: [], forms: [], franchises: [], companies: [], genre_candidates: [], network: null, network_candidates: [], metadata_owner_set: false })]);
// A range (RL12).
const rs = (await db2.query(`select s.id::text show, s.status, array_agg(w.id::text order by w.date_sort, w.id) seasons from public.tv_shows s join public.watchlist_items w on w.show_id = s.id
  where w.season ~ '^Season [0-9]+$' and not w.skipped group by s.id, s.status having count(*) >= 3 order by s.title limit 1`)).rows[0];
await an2(`select public.set_season_watched($1, false)`, [rs.seasons[0]]);
await an2(`select public.set_season_watched($1, true)`, [rs.seasons[2]]);
await an2(`select public.library_set_resume_b45($1, $2::jsonb, $3, $4)`, [rs.show, JSON.stringify({ status: rs.status, resume_start_season_id: null, resume_end_season_id: null }), rs.seasons[0], rs.seasons[2]]);
const pre = await state(db2);
const d2 = await dryRun(db2);
const tierOf = id => (d2.report.projected.find(p => p.id === id) || {}).tier;
ok(tierOf(pend.id) === '1L' && tierOf(bb.id) === '3' && d2.report.discarded_metadata.some(m => m.id === plain.id) && d2.report.discarded_resume.some(r => r.show_id === rs.show),
  `B1 / RL12 the report: 1L (pending + High), 3 (a former Complete show → Skipped), the metadata and the range listed as lossy (lossy ${d2.report.lossy})`, JSON.stringify({ tiers: d2.report.tiers, resume: d2.report.discarded_resume }));
ok(d2.report.discarded_resume.every(r => r.start && r.end && ['active', 'complete', 'invalid'].includes(r.state)), 'RL12 every pair listed with its show, labels and state', JSON.stringify(d2.report.discarded_resume));
const d2p1 = JSON.stringify(await exportDoc(db2, 5));
ok(!associate(d2p1, { report: d2.report, report_sha256: d2.hash }, { lossy: false }).ok, 'B5 the tool itself refuses a lossy report without the acceptance');
await setApproval(db2, { reportSha: d2.hash, lossy: false, p1Sha: associate(d2p1, d2, {}).p1Sha, digests: b45BackupDigests(JSON.parse(d2p1)),
  token: approvalToken(d2.hash, associate(d2p1, d2, {}).p1Sha, false) });
const noLossy = await tryExec(db2, sql('db/rollback/b45.sql'));
ok(!noLossy.ok && /not accepted/.test(noLossy.message) && sameState(pre, await state(db2)), 'B5 / RL12 without the lossy acceptance: refused, nothing changed', noLossy.message);
await approve(db2, d2, true, d2p1);
const rb2 = await tryExec(db2, sql('db/rollback/b45.sql'));
ok(rb2.ok, 'B5 with the lossy acceptance in the report-bound approval: the rollback runs', rb2.message);
const post = await state(db2);
const stat = (t, id) => post.rows[t][id].status;
ok(stat('tv_shows', pend.id) === 'pending' && stat('tv_shows', bb.id) === 'skipped' && stat('tv_shows', plain.id) === pre.rows.tv_shows[plain.id].status,
  'B1 statuses by tier: 1L → its provenance (pending); 3 → the projection (the former Complete show: skipped); 2 → stored');
const b1 = rowDiff(pre.rows, post.rows, (t, id, c) => (t === 'tv_shows' && (B45_SHOW_COLS.includes(c) || c === 'status')) || (t === 'watchlist_items' && (B45_ITEM_COLS.includes(c) || c === 'status')));
ok(b1.length === 0 && post.archive === pre.archive, 'B1 every 5c-era column keeps its pre-rollback value (later edits included: the watched changes stay)', b1.join('\n'));
const allStat = Object.keys(pre.rows.tv_shows).every(id => {
  const p = d2.report.projected.find(x => x.id === id);
  const s = pre.rows.tv_shows[id];
  const want = p ? p.rollback_status : (s.legacy_status || s.status);
  return post.rows.tv_shows[id].status === want;
});
ok(allStat, 'B1 every show’s status equals the report (tier 1 / 1L: provenance; 2: stored; 3: projection)');
ok(post.cat === H.base.cat, 'B1 the schema and function inventory equal the bound pre-B45 baseline', catDiff(H.base.cat, post.cat).join('\n'));
ok(!JSON.stringify(post.rows.tv_shows).includes('resume_start_season_id'), 'RL12 both resume columns are gone');

section('--h3: B4 binding under lock — any change after the dry run refuses before mutation');
const H3b = await replica4(inputs.h3.doc);
const db3 = H3b.db;
await applyB45(db3, H.choices);
const drifts = [
  ['tv_shows', `update public.tv_shows set title = title || ' (zz)' where id = (select id from public.tv_shows order by id limit 1)`],
  ['watchlist_items', `update public.watchlist_items set watched = not watched where id = (select id from public.watchlist_items where not is_film order by id limit 1)`],
  ['custom_collections', `insert into public.custom_collections (name, tmdb_person_id, role, user_id) select 'ZZ drift', 1, 'actor', (select user_id from public.tv_shows limit 1)`],
  ['personal_collections', `update public.personal_collections set sort_order = sort_order + 100 where id = (select id from public.personal_collections order by id limit 1)`],
  ['collection_memberships', `delete from public.collection_memberships where id = (select id from public.collection_memberships order by id limit 1)`],
  ['watch_with_choices', `update public.watch_with_choices set sort_order = sort_order + 100 where id = (select id from public.watch_with_choices order by id limit 1)`],
  ['catalog_show_links', `update public.catalog_show_links set origin = origin where false; update public.catalog_show_links set created_at = created_at + interval '1 microsecond' where id = (select id from public.catalog_show_links order by id limit 1)`],
  ['catalog_film_links', `update public.catalog_film_links set created_at = created_at + interval '1 microsecond' where id = (select id from public.catalog_film_links order by id limit 1)`],
  ['stage5_recovery_records', `update private.stage5_recovery_records set collection = collection where false; delete from private.stage5_recovery_records where ctid = (select ctid from private.stage5_recovery_records limit 1)`],
  ['stage5_recovery_collections', `delete from private.stage5_recovery_collections where ctid = (select ctid from private.stage5_recovery_collections limit 1)`],
  ['stage5_recovery_othertv', `update private.stage5_recovery_othertv set title = title || ' (zz)' where ctid = (select ctid from private.stage5_recovery_othertv limit 1)`],
  ['stage5_recovery_meta', `update private.stage5_recovery_meta set counts = counts || '{"zz":1}'::jsonb where ctid = (select ctid from private.stage5_recovery_meta limit 1)`],
  ['inventory', `create function public.zz_drift() returns int language sql as 'select 1'`]
];
const b4 = [];
for (const [what, change] of drifts) {
  const dr3 = await dryRun(db3); // (its own transaction, rolled back)
  const p1before = JSON.stringify(await exportDoc(db3, 5)); // P1 of the dry-run state
  const appr = associate(p1before, dr3, { lossy: true });
  await db3.exec('begin');
  await db3.query(`select set_config('watchlist.library_write', 'on', true)`);
  const applied = await db3.exec(change).then(() => true, e => { console.log(`  info ${what}: ${e.message}`); return false; });
  if (!applied) { await db3.exec('rollback'); b4.push([what, false, false, false]); continue; }
  await db3.query(`select set_config('watchlist.library_write', '', true)`);
  const drifted = await state(db3);
  await setApproval(db3, { reportSha: appr.reportSha, lossy: true, p1Sha: appr.p1Sha, digests: appr.digests, token: appr.token });
  const x = await (async () => { try { await db3.exec(sql('db/rollback/b45.sql').replace(/^begin;/m, 'savepoint zz_rb;').replace(/^commit;\s*$/m, 'release savepoint zz_rb;')); return { ok: true }; }
    catch (e) { await db3.exec('rollback to savepoint zz_rb').catch(() => {}); return { ok: false, message: e.message }; } })();
  const unchanged = sameState(drifted, await state(db3));
  b4.push([what, applied, !x.ok && /differs from the approved report/.test(x.message || ''), unchanged]);
  await db3.exec('rollback'); // the drift is undone; the next table starts from the same migrated state
}
for (const [what, applied, refused, unchanged] of b4) ok(applied && refused && unchanged, `B4 a change to ${what} after the dry run: refused before mutation, state unchanged`);
const dr4 = await dryRun(db3);
const p1 = JSON.stringify(await exportDoc(db3, 5));
const good = associate(p1, dr4, { lossy: true });
const s4 = await state(db3);
const refusedRun = async (label, values, pattern) => {
  await setApproval(db3, values);
  const x = await tryExec(db3, sql('db/rollback/b45.sql'));
  ok(!x.ok && pattern.test(x.message || '') && sameState(s4, await state(db3)), `B4 ${label}: refused, nothing changed`, x.message);
};
await refusedRun('an approval naming another report', { reportSha: 'f'.repeat(64), lossy: true, p1Sha: good.p1Sha, digests: good.digests,
  token: approvalToken('f'.repeat(64), good.p1Sha, true) }, /differs from the approved report/);
await refusedRun('an approval naming another pre-B45 baseline', { reportSha: good.reportSha, lossy: true, p1Sha: good.p1Sha, digests: good.digests, token: good.token,
  base: '0'.repeat(32) }, /baseline is not the one named/);
// P1 binding: an approval naming a different P1 file hash, a P1 of another state, missing P1 values.
const otherP1 = (() => { const d = JSON.parse(p1); d.exportedAt = '2026-10-14T00:00:00.000Z'; return JSON.stringify(d); })(); // same rows, another file
const otherSha = crypto.createHash('sha256').update(otherP1).digest('hex');
const toolWrongP1 = associate(p1, dr4, { lossy: true, approval: approvalToken(good.reportSha, otherSha, true) });
ok(!toolWrongP1.ok && !toolWrongP1.preamble && toolWrongP1.problems.some(p => /different P1 file hash/.test(p)),
  'B4 P1 binding (tool): an approval naming a different P1 file hash gets no execution preamble', toolWrongP1.problems.join('; '));
await refusedRun('P1 binding (script): the preamble names a P1 file hash the approval doesn’t', { reportSha: good.reportSha, lossy: true, p1Sha: otherSha,
  digests: good.digests, token: good.token }, /doesn't name this report, this P1 backup file/);
await refusedRun('P1 binding (script): an approval naming a different P1 file hash, with that hash in the preamble', { reportSha: good.reportSha, lossy: true,
  p1Sha: otherSha, digests: good.digests, token: approvalToken(good.reportSha, good.p1Sha, false) }, /doesn't name this report, this P1 backup file/);
const staleP1 = (() => { const d = JSON.parse(p1); d.tables.tv_shows[0].title += ' (another state)'; return JSON.stringify(d); })();
const staleSha = crypto.createHash('sha256').update(staleP1).digest('hex');
ok(!associate(staleP1, dr4, { lossy: true }).ok, 'B4 P1 binding (tool): a P1 file of another state fails the association check');
await refusedRun('P1 binding (script): a consistently approved P1 file of another state', { reportSha: good.reportSha, lossy: true, p1Sha: staleSha,
  digests: b45BackupDigests(JSON.parse(staleP1)), token: approvalToken(good.reportSha, staleSha, true) }, /not a backup of this state/);
await refusedRun('P1 binding (script): no P1 file hash', { reportSha: good.reportSha, lossy: true, p1Sha: '', digests: good.digests, token: good.token }, /no P1 backup file hash/);
await refusedRun('P1 binding (script): no P1 digests', { reportSha: good.reportSha, lossy: true, p1Sha: good.p1Sha, digests: null, token: good.token }, /no P1 backup digests/);
// The procedure as an operator runs it (the CLI), on real files.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b45-approval-'));
  try {
    fs.writeFileSync(path.join(dir, 'p1.json'), p1); fs.writeFileSync(path.join(dir, 'dry-run.json'), JSON.stringify({ report: dr4.report, report_sha256: dr4.hash }));
    const cli = extra => { try { return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, 'tools/b45-backup-digest.mjs'), path.join(dir, 'p1.json'),
      '--report', path.join(dir, 'dry-run.json'), '--lossy', ...extra], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: String(e.stdout) }; } };
    const a1 = cli([]), a2 = cli(['--approval', approvalToken(good.reportSha, otherSha, true)]), a3 = cli(['--approval', good.token]);
    ok(a1.code === 0 && a1.out.includes(good.token) && !a1.out.includes('set_config'), 'CLI: association passes and prints the token to approve (no preamble yet)');
    ok(a2.code === 1 && /REFUSED: the approval doesn’t name this report, this P1 file/.test(a2.out) && !a2.out.includes('set_config'), 'CLI: an approval naming a different P1 file hash is refused (exit 1, no preamble)', a2.out);
    ok(a3.code === 0 && a3.out.includes(`b45_rollback_p1_sha256', '${good.p1Sha}'`) && a3.out.includes(`b45_rollback_approval', '${good.token}'`), 'CLI: the approved token and the same file give the execution preamble', a3.out.slice(0, 400));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
await refusedRun('loss acceptance changed after approval (approved without it)', { reportSha: good.reportSha, lossy: true, p1Sha: good.p1Sha, digests: good.digests,
  token: approvalToken(good.reportSha, good.p1Sha, false) }, /doesn't name this report, this P1 backup file and this loss acceptance/);

section('--h3: W8 catalog applications on real data (preview writes nothing; apply To Watch / Normal / New; replay stale)');
const cfg = {};
vm.runInContext(sql('config.js') + '; this.__C = COLLECTIONS;', vm.createContext(cfg));
const before8w = await state(db3);
const w8 = [];
for (const c of cfg.__C.filter(x => ['disney', '90day', 'sheridan'].includes(x.id))) {
  const prev = (await an3(db3, `select public.library_catalog_apply_b45($1, $2::jsonb) r`, [c.id, JSON.stringify(c.defaults)]))[0].r;
  w8.push([c.id, prev.mode, prev.document.version, prev.document.entries.filter(e => !['noop'].includes(e.kind)).length]);
}
ok(sameState(before8w, await state(db3)) && w8.every(x => x[1] === 'preview' && x[2] === 'b45.1'), `W8 previews of the three catalogs (version b45.1) write nothing: ${JSON.stringify(w8)}`);
// Remove one catalog film and one catalog season so an apply has work, then apply and replay.
await db3.query(`select set_config('watchlist.library_write', 'on', false)`);
const goneFilm = await val(db3, `select w.item_key from public.watchlist_items w join public.catalog_film_links l on l.item_id = w.id where l.catalog = 'sheridan' order by w.item_key desc limit 1`);
await db3.exec(`delete from public.collection_memberships where item_id in (select w.id from public.watchlist_items w where w.item_key = '${goneFilm.replace(/'/g, "''")}');
  delete from public.catalog_film_links where entry_key = '${goneFilm.replace(/'/g, "''")}'; delete from public.watchlist_items where item_key = '${goneFilm.replace(/'/g, "''")}'`);
await db3.query(`select set_config('watchlist.library_write', '', false)`);
const sher = cfg.__C.find(x => x.id === 'sheridan').defaults;
const pv = (await an3(db3, `select public.library_catalog_apply_b45('sheridan', $1::jsonb) r`, [JSON.stringify(sher)]))[0].r;
const ap = (await an3(db3, `select public.library_catalog_apply_b45('sheridan', $1::jsonb, $2) r`, [JSON.stringify(sher), pv.hash]))[0].r;
const newFilm = (await db3.query(`select status, watched, priority, catalog_new, status_review, legacy_status from public.watchlist_items where item_key = $1`, [goneFilm])).rows[0];
ok(ap.mode === 'applied' && newFilm && newFilm.status === 'confirmed' && newFilm.priority === 'normal' && newFilm.catalog_new === true && newFilm.legacy_status === null,
  `W8 apply bound to the previewed hash: the film comes back To Watch / Normal / New (${goneFilm})`, JSON.stringify({ mode: ap.mode, newFilm }));
const replay = await an3(db3, `select public.library_catalog_apply_b45('sheridan', $1::jsonb, $2) r`, [JSON.stringify(sher), pv.hash]).then(() => ({}), e => ({ error: e.message }));
ok(/catalog_stale/.test(replay.error || ''), 'W8 a replay of the same approval after the commit is stale', replay.error);
const oldName = await an3(db3, `select public.library_catalog_apply('sheridan', $1::jsonb) r`, [JSON.stringify(sher)]).then(() => ({}), e => ({ error: e.message }));
ok(/client_outdated/.test(oldName.error || ''), 'W8 the old name refuses (client_outdated)', oldName.error);

section('B3 the D2 chain: B45 → its rollback → the pinned 5c rollback equals the pinned 5c rollback alone');
const C1 = await replica4(inputs.h3.doc), C2 = await replica4(inputs.h3.doc);
await applyB45(C1.db, H.choices);
const drc = await dryRun(C1.db);
await approve(C1.db, drc, false);
ok((await tryExec(C1.db, sql('db/rollback/b45.sql'))).ok, 'B45 rolled back (exact)');
const rA = await tryExec(C1.db, sql('db/rollback/phase5c.sql')), rB = await tryExec(C2.db, sql('db/rollback/phase5c.sql'));
ok(rA.ok && rB.ok, 'the pinned 5c rollback (unchanged file) runs on both', `${rA.message || ''} ${rB.message || ''}`);
const sA = await state(C1.db), sB = await state(C2.db);
const chain = rowDiff(sB.rows, sA.rows, (t, id, c) => c === 'user_id');
ok(chain.length === 0 && sA.cat === sB.cat, 'B3 the recovered 5a state is exactly the one the pinned rollback gives without B45 (every column, schema, functions)', chain.concat(catDiff(sB.cat, sA.cat)).join('\n'));
const committed = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:db/rollback/phase5c.sql']);
ok(sha(fs.readFileSync(path.join(ROOT, 'db/rollback/phase5c.sql'))) === sha(committed), 'the pinned 5c rollback file is unchanged (equal to the committed one)');

if (inject) {
  section('failure injection: after every statement of db/b45_expand.sql and db/rollback/b45.sql, the state is unchanged');
  const F = await replica4(inputs.h3.doc);
  const fdb = F.db;
  await fdb.query(`select set_config('watchlist.b45_choices', $1, false)`, [JSON.stringify({ shows: H.choices.shows, films: H.choices.films })]);
  const s0 = await state(fdb);
  const st = statements(sql('db/b45_expand.sql'));
  const bi = st.findIndex(s => /^begin\s*;/i.test(s.replace(/--[^\n]*\n/g, '').trim())), ci = st.findIndex(s => /^commit\s*;/i.test(s.replace(/--[^\n]*\n/g, '').trim()));
  let bad = [];
  for (let k = bi; k < ci; k++) {
    const text = st.slice(0, k + 1).join('') + `\ndo $zz$ begin raise exception 'zz injected after %', ${k}; end $zz$;\n` + st.slice(k + 1).join('');
    const x = await tryExec(fdb, text);
    if (x.ok || !/zz injected/.test(x.message) || !sameState(s0, await state(fdb))) bad.push(`${k}: ${stmtHead(st[k])} ${x.message || 'committed'}`);
  }
  ok(bad.length === 0, `db/b45_expand.sql: a failure after each of its ${ci - bi} statements leaves the state unchanged`, bad.join('\n'));
  await applyB45(fdb, { shows: H.choices.shows, films: H.choices.films });
  const s1 = await state(fdb);
  const dr5 = await dryRun(fdb);
  await approve(fdb, dr5, true);
  const rt = statements(sql('db/rollback/b45.sql'));
  const rbi = rt.findIndex(s => /^begin\s*;/i.test(s.replace(/--[^\n]*\n/g, '').trim())), rci = rt.findIndex(s => /^commit\s*;/i.test(s.replace(/--[^\n]*\n/g, '').trim()));
  bad = [];
  for (let k = rbi; k < rci; k++) {
    const text = rt.slice(0, k + 1).join('') + `\ndo $zz$ begin raise exception 'zz injected after %', ${k}; end $zz$;\n` + rt.slice(k + 1).join('');
    const x = await tryExec(fdb, text);
    if (x.ok || !/zz injected/.test(x.message) || !sameState(s1, await state(fdb))) bad.push(`${k}: ${stmtHead(rt[k])} ${x.message || 'committed'}`);
  }
  ok(bad.length === 0, `db/rollback/b45.sql: a failure after each of its ${rci - rbi} statements leaves the state unchanged (B45 still installed)`, bad.join('\n'));
  evidence.injection = { expand: ci - bi, rollback: rci - rbi };
}

section('inputs unchanged');
for (const [k, f] of Object.entries(files)) ok(sha(fs.readFileSync(f)) === inputs[k].sha256, `${k}: the backup file is unchanged`);

console.log(`\n${failed ? `FAILED: ${failed}` : 'all rehearsal checks passed'}`);
if (evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, `rehearsal-b45-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ failed, ...evidence }, null, 2));
}
process.exitCode = failed ? 1 : 0;

async function an3(d, s, p) { return d.transaction(async tx => { await tx.query(`select set_config('request.jwt.claims', '', true), set_config('role', 'anon', true)`); return (await tx.query(s, p)).rows; }); }
