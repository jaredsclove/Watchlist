// Local rehearsal of EP1 episode progress (db/ep1_episode_marks.sql) on a PGlite replica at M1
// (contracted-b45, access = members) holding a real format-5 backup as member A, and the same library
// under new ids as member B:
//   pre   refusals before anything changes (no run id, a recorded run id); the state is unchanged;
//   fail  failure injection after every statement of the migration: the state is unchanged, no run record;
//   EP    the migration: every existing row unchanged; only the intended catalog changes; the run record;
//         a replay refused;
//   anon  nothing on episode_marks or the new functions;
//   marks library_set_episode_marks as A: set, clear, idempotence, input refusals, the expected values,
//         the watched / skipped lock, unmatched seasons; season flags keep marks; direct writes refused;
//         a marked season's identity can't change;
//   del   delete_tv_season: an old-style call (no count) refused for a marked season, allowed for an
//         unmarked one; a stale count refused; the right count deletes the season and its marks;
//   iso   B and a non-member C against A's seasons and marks;
//   rst   restore_backup format 6: marks restored and verified; refusals leave the state unchanged;
//         format 5 refused; a format-5 conversion record accepted; B unchanged by A's restores;
//   adm   the admin restore runbook (tools/admin-restore.mjs) at format 6;
//   rev   test-environment reverse (db/test/ep1_reverse.sql) gives back the exact pre-EP1 state.
// Nothing here touches Supabase. PGlite is one session: lock waits between sessions aren't shown.
//   PGLITE_DIR=/path/with/node_modules node tools/db-rehearsal-ep1.mjs --backup <format5.json> [--no-inject]
// Output: pass/fail, counts and statement positions only; never record contents.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import os from 'os';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const backupFile = opt('--backup');
if (!backupFile || !process.env.PGLITE_DIR) {
  console.error('usage: PGLITE_DIR=… node tools/db-rehearsal-ep1.mjs --backup <format5.json> [--no-inject]');
  process.exit(2);
}
const inject = !argv.includes('--no-inject');
const req = createRequire(path.join(process.env.PGLITE_DIR, 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));
const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const backupText = fs.readFileSync(backupFile);
const backupSha = sha(backupText);
const doc5 = JSON.parse(backupText);
if (doc5.formatVersion !== 5) { console.error('--backup must be format 5'); process.exit(2); }

let failed = 0;
const ok = (cond, label, detail = '') => { if (!cond) failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${String(detail).slice(0, 1500)}` : ''}`); return cond; };
const section = t => console.log(`\n[${t}]`);

// ── The page's own backup code (validation, conversion) ──
const page = { console, Map, Set, JSON, Date, Math, Array, Object, String, Number, Boolean, RegExp, Error, Promise, parseInt, isFinite,
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} }, window: {}, localStorage: { getItem: () => null, setItem() {} },
  crypto: crypto.webcrypto, TextEncoder };
page.window = page;
vm.createContext(page);
for (const f of ['config.js', 'ui-helpers.js', 'metadata.js', 'api.js', 'backup-restore.js', 'backup-format3.js']) vm.runInContext(sql(f), page, { filename: f });
const P = expr => vm.runInContext(expr, page);
const validate = d => Array.from(P('validateBackupObject')(d));

// ── Replica: the Stage 5c / B4/B5 schema, the real library restored, then M1 with A as owner ──
const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b', C = '00000000-0000-4000-8000-00000000000c';
async function replica() {
  const db = new PGlite();
  for (const f of ['db/test/supabase_shim.sql', 'db/test/replica_schema.sql', 'db/phase0_restore_v1.sql']) await db.exec(sql(f));
  await db.exec(`set timezone = 'UTC'`);
  for (const f of ['db/phase1b_ownership.sql', 'db/restore_backup.sql', 'db/phase1c_tv_schema.sql', 'db/tv_model.sql', 'db/rpc.sql', 'db/admin/tv_enrich.sql']) await db.exec(sql(f));
  await db.exec(`update private.migration_stage set stage = 'final'`);
  await db.exec(sql('db/phase3b_org.sql'));
  for (const f of ['db/phase3b2_org_write.sql', 'db/phase4a_catalog.sql', 'db/phase4b_add_to_show.sql', 'db/phase5a_expand.sql', 'db/phase5c_contract.sql']) await db.exec(sql(f));
  await db.query(`select set_config('watchlist.b45_choices', $1, false)`, [JSON.stringify({ shows: {}, films: {} })]);
  await db.exec(sql('db/b45_expand.sql'));
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@test.invalid'), ('${B}', 'b@test.invalid'), ('${C}', 'c@test.invalid')`);
  await asAnon(db, `select public.restore_backup($1::jsonb, false)`, [doc5]);
  await db.exec(`begin; select set_config('watchlist.library_write', 'on', true);
    insert into private.stage5_recovery_records (user_id, kind, id, collection)
      select user_id, 'show', id, 'synthetic' from public.tv_shows union all select user_id, 'item', id, 'synthetic' from public.watchlist_items;
    insert into private.stage5_recovery_collections (user_id, id, legacy_source) select user_id, id, null from public.personal_collections;
    insert into private.stage5_recovery_meta (user_id, origin, counts, hashes)
      select bootstrap_owner_id, 'contraction', '{}'::jsonb, '{}'::jsonb from private.app_owner;
    commit;`);
  await db.exec(`select set_config('watchlist.m1_owner', '${A}', false), set_config('watchlist.m1_run', 'rehearsal-m1', false);\n` + sql('db/m1_access.sql'));
  // B: the same library under new ids (local only), restored by B as a member.
  await db.exec(`insert into private.library_members (user_id, note) values ('${B}', 'rehearsal B')`);
  await asUser(db, B, `select public.restore_backup($1::jsonb, false)`, [docB]);
  return db;
}
async function asRole(db, role, sub, s, p) {
  return db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)`, [sub ? JSON.stringify({ sub, role }) : '', role]);
    return (await tx.query(s, p)).rows;
  });
}
const asAnon = (db, s, p) => asRole(db, 'anon', null, s, p);
const asUser = (db, sub, s, p) => asRole(db, 'authenticated', sub, s, p);
async function attempt(fn) { try { return { ok: true, rows: await fn() }; } catch (e) { return { ok: false, message: e.message, code: e.code }; } }
const val = async (db, s, p) => Object.values((await db.query(s, p)).rows[0])[0];
const idMap = new Map();
const remap = v => { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return v; if (!idMap.has(v)) idMap.set(v, crypto.randomUUID()); return idMap.get(v); };
const docB = JSON.parse(JSON.stringify(doc5), (k, v) => (typeof v === 'string' ? remap(v) : v));

// ── Snapshots ──
const TABLES = [['public', 'watchlist_items'], ['public', 'tv_shows'], ['public', 'custom_collections'], ['public', 'personal_collections'],
  ['public', 'collection_memberships'], ['public', 'watch_with_choices'], ['public', 'catalog_show_links'], ['public', 'catalog_film_links'],
  ['private', 'stage5_recovery_records'], ['private', 'stage5_recovery_collections'], ['private', 'stage5_recovery_othertv'], ['private', 'stage5_recovery_meta'],
  ['private', 'library_members']];
async function rows(db) {
  const out = {};
  for (const [s, t] of TABLES) out[`${s}.${t}`] = await val(db, `select md5(coalesce(string_agg(x, '|' order by x), '')) from (select to_jsonb(r)::text x from ${s}.${t} r) q`);
  out.marks = await val(db, `select case when to_regclass('public.episode_marks') is null then 'none' else
    (select md5(coalesce(string_agg(to_jsonb(m)::text, '|' order by to_jsonb(m)::text), '')) from public.episode_marks m) end`).catch(() => 'none');
  return out;
}
async function marksDigest(db) {
  return val(db, `select md5(coalesce(string_agg(to_jsonb(m)::text, '|' order by to_jsonb(m)::text), '')) from public.episode_marks m`);
}
const ACL = (col, dflt) => `coalesce((select string_agg(g, ',' order by g) from (select case when e.grantee = 0 then 'PUBLIC' else pg_get_userbyid(e.grantee) end || ':' || e.privilege_type g
  from aclexplode(coalesce(${col}, ${dflt})) e) q), '')`;
const CAT = `select json_build_object(
  'constraints', (select json_agg(x order by x) from (select conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid) x
    from pg_constraint where connamespace in ('public'::regnamespace, 'private'::regnamespace) and contype <> 'n') s),
  'columns', (select json_agg(x order by x) from (select table_schema || '.' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' ||
    coalesce(column_default, '') x from information_schema.columns where table_schema in ('public', 'private')) s),
  'acl', (select json_agg(x order by x) from (select c.oid::regclass::text || ' ' || ${ACL('c.relacl', "acldefault('r', c.relowner)")} || ' ' || c.relrowsecurity::text x
    from pg_class c where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'v', 'S')) s),
  'col_acl', (select json_agg(x order by x) from (select a.attrelid::regclass::text || '.' || a.attname || ' ' || ${ACL('a.attacl', 'null')} x
    from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and a.attacl is not null) s),
  'functions', (select json_agg(x order by x) from (select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' ||
    md5(regexp_replace(pg_get_functiondef(p.oid), 'FUNCTION [a-z_]+\\.', 'FUNCTION ')) || ' ' || ${ACL('p.proacl', "acldefault('f', p.proowner)")} x
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')) s),
  'triggers', (select json_agg(x order by x) from (select pg_get_triggerdef(oid) x from pg_trigger where not tgisinternal) s),
  'policies', (select json_agg(x order by x) from (select schemaname || '.' || tablename || '.' || policyname || ' ' || cmd || ' ' || permissive || ' ' || roles::text || ' ' ||
    coalesce(qual, '') || ' ' || coalesce(with_check, '') x from pg_policies where schemaname in ('public', 'private')) s),
  'tables', (select json_agg(x order by x) from (select schemaname || '.' || tablename x from pg_tables where schemaname in ('public', 'private')) s),
  'runs', (select json_agg(run_id || '/' || migration order by run_id) from private.migration_runs)
)::text c`;
async function state(db) { return { rows: await rows(db), cat: await val(db, CAT) }; }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const catDiff = (a, b) => { a = JSON.parse(a); b = JSON.parse(b); return Object.keys({ ...a, ...b }).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
  .map(k => `${k}: only before ${JSON.stringify((a[k] || []).filter(x => !(b[k] || []).includes(x)).slice(0, 6))} only after ${JSON.stringify((b[k] || []).filter(x => !(a[k] || []).includes(x)).slice(0, 6))}`); };

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
async function tryExec(db, text) {
  try { const out = await db.exec(text); return { ok: true, out }; }
  catch (e) { await db.exec('rollback').catch(() => {}); return { ok: false, message: e.message }; }
}
const preamble = run => `select set_config('watchlist.ep1_run', '${run}', false);\n`;
const EP1 = sql('db/ep1_episode_marks.sql');

// A format-6 document of one owner's library, read as that member (the shape the page's backup makes).
const T5 = Object.keys(doc5.tables);
async function exportDoc(db, who) {
  const tables = {};
  for (const t of [...T5, 'episode_marks']) {
    const cols = t === 'episode_marks' ? ['id', 'season_id', 'tmdb_episode_id', 'episode_number'] : Object.keys(doc5.tables[t][0] || {});
    const r = await asUser(db, who, `select coalesce(json_agg(json_build_object(${cols.map(c => `'${c}', x.${c}`).join(', ')}) order by x.id), '[]') j from public.${t} x`);
    tables[t] = r[0].j;
  }
  return { format: 'watchlist-tracker-backup', formatVersion: 6, exportedAt: new Date().toISOString(),
    rowCounts: Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length])), tables };
}

// ═══ The rehearsal ═══
section('replica');
ok(validate(doc5).length === 0, 'the backup validates with the page’s rules (format 5)', validate(doc5).join('\n'));
const db = await replica();
ok((await val(db, `select public.stage5_capabilities() ->> 'phase'`)) === 'contracted-b45'
  && (await val(db, `select public.stage5_capabilities() ->> 'access'`)) === 'members', 'the replica is contracted-b45 with M1 (access = members)');
const counts0 = Object.fromEntries(Object.entries(doc5.tables).map(([t, r]) => [t, r.length]));
const countsA = {};
for (const t of T5) countsA[t] = Number(await val(db, `select count(*) from public.${t} where user_id = $1`, [A]));
ok(same(counts0, countsA), 'A holds the backup’s row counts; B holds a copy under new ids');
const s0 = await state(db);
const FN_SIG = `select md5(prosrc) || ' ' || prosecdef || ' ' || coalesce(array_to_string(proconfig, ','), '') || ' ' || ${ACL('proacl', "acldefault('f', proowner)")} from pg_proc where oid = $1::regprocedure`;
const restore5Sig = await val(db, FN_SIG, ['public.restore_backup(jsonb, boolean)']);

section('pre: refusals change nothing');
for (const [label, run, re] of [['no run id', '', /set watchlist\.ep1_run/], ['a recorded run id', 'rehearsal-m1', /already recorded/]]) {
  const x = await tryExec(db, preamble(run) + EP1);
  ok(!x.ok && re.test(x.message) && same(s0, await state(db)), `${label}: refused, state unchanged`, x.message || 'committed');
}

if (inject) {
  section('fail: a failure after every statement leaves the state unchanged');
  const st = statements(EP1);
  const bi = st.findIndex(s => /^begin\s*;/i.test(s.replace(/--[^\n]*\n/g, '').trim())), ci = st.findIndex(s => /^commit\s*;/i.test(s.replace(/--[^\n]*\n/g, '').trim()));
  const bad = [];
  for (let k = bi; k < ci; k++) {
    const text = preamble(`inject-${k}`) + st.slice(0, k + 1).join('') + `\ndo $zz$ begin raise exception 'zz injected after %', ${k}; end $zz$;\n` + st.slice(k + 1).join('');
    const x = await tryExec(db, text);
    if (x.ok || !/zz injected/.test(x.message) || !same(s0, await state(db))) bad.push(`${k}: ${stmtHead(st[k])} ${x.message || 'committed'}`);
  }
  ok(bad.length === 0, `a failure after each of its ${ci - bi} statements leaves the state unchanged and no run record`, bad.join('\n'));
}

section('EP: the migration');
const run = await tryExec(db, preamble('ep1-rehearsal-1') + EP1);
if (!ok(run.ok, 'db/ep1_episode_marks.sql commits', run.message)) { console.log('\nFAILED: the migration did not commit; stopping'); process.exit(1); }
const result = String(run.out.map(r => r.rows && r.rows[0] && r.rows[0].result).find(Boolean));
console.log(`       ${result.slice(0, 300)}`);
ok(/"checked_writes" : true/.test(result), 'the migration ran its synthetic write checks (checked_writes true)', result);
ok(Number(await val(db, `select count(*) from public.tv_shows where title = 'ZZ EP1 Migration Check'`)) + Number(await val(db, `select count(*) from public.watchlist_items where title = 'ZZ EP1 Migration Check'`)) === 0,
  'no synthetic check row survived');
const s1 = await state(db);
ok(same(Object.fromEntries(Object.entries(s0.rows).filter(([k]) => k !== 'marks')), Object.fromEntries(Object.entries(s1.rows).filter(([k]) => k !== 'marks'))),
  'every existing row (user_id included) is unchanged, the archive and memberships included');
ok(Number(await val(db, `select count(*) from public.episode_marks`)) === 0, 'episode_marks is empty');
ok((await val(db, `select public.stage5_capabilities() ->> 'phase'`)) === 'contracted-ep1' && (await val(db, `select public.stage5_capabilities() ->> 'backup_format'`)) === '6',
  'the capability: phase contracted-ep1, backup_format 6');
ok((await val(db, `select string_agg(run_id || '/' || migration, ',' order by run_id) from private.migration_runs`)) === 'ep1-rehearsal-1/ep1,rehearsal-m1/m1',
  'the run record holds this run (ep1-rehearsal-1, ep1) beside M1’s');
{
  const c0 = JSON.parse(s0.cat), c1 = JSON.parse(s1.cat);
  const after = k => (c1[k] || []).filter(x => !(c0[k] || []).includes(x)), before = k => (c0[k] || []).filter(x => !(c1[k] || []).includes(x));
  ok(same(after('tables'), ['public.episode_marks']) && before('tables').length === 0, 'tables: only public.episode_marks added', JSON.stringify(after('tables')));
  ok(before('constraints').length === 0 && after('constraints').every(x => /^(public\.)?episode_marks\.|watchlist_items_id_owner_key UNIQUE \(id, user_id\)/.test(x)),
    'constraints: only episode_marks’ and watchlist_items (id, user_id) added', JSON.stringify(after('constraints')));
  ok(before('triggers').length === 0 && same(after('triggers').map(t => t.split(' ')[2]).sort(), ['episode_marks_season_check', 'episode_marks_write_guard', 'watchlist_items_ep1_identity_guard']),
    'triggers: only the three EP1 triggers added', JSON.stringify(after('triggers')));
  const fnName = x => x.slice(0, x.indexOf(') ') + 1);
  ok(same(before('functions').map(fnName).sort(), ['public.delete_tv_season(p_row_id uuid)', 'public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean)', 'public.stage5_capabilities()'].sort())
     && same(after('functions').map(fnName).sort(), ['private.ep1_identity_guard()', 'private.ep1_mark_season_check()', 'public.delete_tv_season(p_row_id uuid, p_marks_expected integer)',
       'public.library_set_episode_marks(p_season_id uuid, p_expected jsonb, p_watched boolean, p_episodes jsonb)', 'public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean)',
       'public.stage5_capabilities()', 'private.restore_backup_v5(p_backup jsonb, p_allow_v1_reset boolean)'].sort()),
    'functions: the old delete gone; restore_backup_v5 kept (moved to private, same definition and grants); the new ones added; the capability replaced',
    JSON.stringify({ before: before('functions'), after: after('functions') }));
  // The format-5 function's body, settings, security and grants are exactly the old public.restore_backup's.
  const v5 = await val(db, FN_SIG, ['private.restore_backup_v5(jsonb, boolean)']);
  ok(v5 === restore5Sig, 'private.restore_backup_v5 has the old public.restore_backup’s body, settings, security and grants', JSON.stringify({ restore5Sig, v5 }));
  ok(same(c0.policies, (c1.policies || []).filter(x => !x.startsWith('public.episode_marks.'))), 'policies: only episode_marks’ added');
}
const replay = await tryExec(db, preamble('ep1-rehearsal-2') + EP1);
ok(!replay.ok && /already applied/.test(replay.message) && same(s1, await state(db)), 'a replay is refused, state unchanged', replay.message || 'committed');

section('anon: nothing');
const aSeason = await val(db, `select id::text from public.watchlist_items where user_id = '${A}' and not is_film and media_type = 'tv' and tmdb_id is not null
  and season_number is not null and not watched and not skipped order by id limit 1`);
for (const [label, s, p] of [
  ['read episode_marks', `select count(*) from public.episode_marks`],
  ['insert a mark', `insert into public.episode_marks (season_id, tmdb_episode_id, episode_number) values ($1, 1, 1)`, [aSeason]],
  ['library_set_episode_marks()', `select public.library_set_episode_marks($1::uuid, '{"watched":false,"skipped":false}', true, '[{"tmdb_episode_id":1,"episode_number":1}]')`, [aSeason]],
  ['delete_tv_season() (old form)', `select public.delete_tv_season($1::uuid)`, [aSeason]],
  ['delete_tv_season() (new form)', `select public.delete_tv_season($1::uuid, 0)`, [aSeason]],
  ['restore_backup()', `select public.restore_backup('{}'::jsonb, false)`],
  ['private.restore_backup_v5()', `select private.restore_backup_v5('{}'::jsonb, false)`],
]) {
  const x = await attempt(() => asAnon(db, s, p));
  ok(!x.ok && /permission denied/.test(x.message), `anon: ${label} → permission denied`, x.ok ? 'succeeded' : x.message);
}
ok(same(s1, await state(db)), 'state unchanged by the anon attempts');

section('marks: library_set_episode_marks as A');
const NONE = '{"watched":false,"skipped":false}';
const setMarks = (who, season, watched, eps, expected = NONE) => attempt(() => asUser(db, who,
  `select public.library_set_episode_marks($1::uuid, $2::jsonb, $3, $4::jsonb) r`, [season, expected, watched, JSON.stringify(eps)]));
const ep = (id, n) => ({ tmdb_episode_id: id, episode_number: n });
ok(!!aSeason, 'A has a matched, unwatched, unskipped season');
let x = await setMarks(A, aSeason, true, [ep(910001, 1), ep(910002, 2), ep(910003, 3)]);
ok(x.ok && x.rows[0].r.marks.length === 3 && x.rows[0].r.marks.map(m => m.episode_number).join() === '1,2,3', 'set three marks; the season’s marks come back in episode order', x.message || JSON.stringify(x.rows));
const d3 = await marksDigest(db);
x = await setMarks(A, aSeason, true, [ep(910001, 7), ep(910002, 2)]);
ok(x.ok && x.rows[0].r.marks.length === 3 && (await marksDigest(db)) === d3, 'setting marks that exist changes nothing (the stored episode number kept)', x.message);
x = await setMarks(A, aSeason, false, [{ tmdb_episode_id: 910003 }, { tmdb_episode_id: 919999 }]);
ok(x.ok && x.rows[0].r.marks.length === 2, 'clearing a mark (and one that doesn’t exist) leaves the other two', x.message);
for (const [label, eps, expected, re] of [
  ['no episodes', [], NONE, /invalid_input/],
  ['a repeated episode', [ep(5, 1), ep(5, 2)], NONE, /invalid_input/],
  ['a zero episode id', [ep(0, 1)], NONE, /invalid_input/],
  ['a text episode id', [{ tmdb_episode_id: '5', episode_number: 1 }], NONE, /invalid_input/],
  ['a missing episode number', [{ tmdb_episode_id: 5 }], NONE, /invalid_input/],
  ['an extra expected field', [ep(5, 1)], '{"watched":false,"skipped":false,"x":1}', /invalid_input/],
  ['stale expected values', [ep(5, 1)], '{"watched":true,"skipped":false}', /target_changed/],
]) {
  const before = await marksDigest(db);
  const r = await setMarks(A, aSeason, true, eps, expected);
  ok(!r.ok && re.test(r.message) && (await marksDigest(db)) === before, `refused: ${label}`, r.message || 'succeeded');
}
const flag = (fn, v) => attempt(() => asUser(db, A, `select public.${fn}($1::uuid, $2)`, [aSeason, v]));
const d2 = await marksDigest(db);
ok((await flag('set_season_watched', true)).ok && (await marksDigest(db)) === d2, 'marking the season watched keeps its marks');
x = await setMarks(A, aSeason, true, [ep(910004, 4)], '{"watched":true,"skipped":false}');
ok(!x.ok && /season_locked/.test(x.message) && (await marksDigest(db)) === d2, 'a watched season is locked (season_locked)', x.message || 'succeeded');
x = await setMarks(A, aSeason, false, [{ tmdb_episode_id: 910001 }], '{"watched":true,"skipped":false}');
ok(!x.ok && /season_locked/.test(x.message) && (await marksDigest(db)) === d2, 'clearing on a watched season is locked too', x.message || 'succeeded');
ok((await flag('set_season_watched', false)).ok && (await marksDigest(db)) === d2, 'unmarking the season keeps its marks');
ok((await flag('set_season_skipped', true)).ok && (await marksDigest(db)) === d2, 'skipping the season keeps its marks');
x = await setMarks(A, aSeason, true, [ep(910004, 4)], '{"watched":false,"skipped":true}');
ok(!x.ok && /season_locked/.test(x.message), 'a skipped season is locked', x.message || 'succeeded');
ok((await flag('set_season_skipped', false)).ok && (await marksDigest(db)) === d2, 'keeping the season again keeps its marks');
const unmatched = await val(db, `select id::text from public.watchlist_items where user_id = '${A}' and not is_film and tmdb_id is null and not watched and not skipped limit 1`);
if (unmatched) {
  x = await setMarks(A, unmatched, true, [ep(5, 1)]);
  ok(!x.ok && /season_unmatched/.test(x.message), 'an unmatched season takes no marks (season_unmatched)', x.message || 'succeeded');
} else ok(true, '(no unmatched season in this library to check season_unmatched)');
const film = await val(db, `select id::text from public.watchlist_items where user_id = '${A}' and is_film limit 1`);
x = await setMarks(A, film, true, [ep(5, 1)]);
ok(!x.ok && /target_missing/.test(x.message), 'a film id is refused (target_missing)', x.message || 'succeeded');
for (const [label, s, p, re] of [
  ['a direct insert', `insert into public.episode_marks (season_id, tmdb_episode_id, episode_number) values ($1, 920001, 1)`, [aSeason], /library_write_required/],
  ['a direct delete of a mark', `delete from public.episode_marks where season_id = $1`, [aSeason], /library_write_required/],
  ['a direct update', `update public.episode_marks set episode_number = 9 where season_id = $1`, [aSeason], /permission denied/],
  ['a direct delete of a marked season', `delete from public.watchlist_items where id = $1`, [aSeason], /library_write_required/],
]) {
  const r = await attempt(() => asUser(db, A, s, p));
  ok(!r.ok && re.test(r.message) && (await marksDigest(db)) === d2, `A: ${label} → refused`, r.message || 'succeeded');
}
{
  const r = await tryExec(db, `begin; select set_config('watchlist.library_write', 'on', true);
    update public.watchlist_items set season_number = season_number + 100 where id = '${aSeason}'; commit;`);
  ok(!r.ok && /episode_marks_kept/.test(r.message), 'a marked season’s identity can’t change (even with library_write, as postgres)', r.message || 'committed');
  const r2 = await tryExec(db, `begin; select set_config('watchlist.library_write', 'on', true);
    insert into public.episode_marks (user_id, season_id, tmdb_episode_id, episode_number) values ('${A}', '${unmatched || film}', 5, 1); commit;`);
  ok(!r2.ok && /season_unmatched/.test(r2.message), 'a mark on an unmatched season or a film is refused by the table itself', r2.message || 'committed');
}

section('del: delete_tv_season');
const del = (who, season, count) => attempt(() => asUser(db, who, count === undefined ? `select public.delete_tv_season($1::uuid) r` : `select public.delete_tv_season($1::uuid, $2) r`,
  count === undefined ? [season] : [season, count]));
const sDel = await state(db);
x = await del(A, aSeason);
ok(!x.ok && /^update_required: This season has 2 episode marks/.test(x.message) && !/not_found:/.test(x.message) && same(sDel, await state(db)),
  'an old-style call (no count) on a marked season is refused with update_required (never not_found), nothing changed', x.message || 'succeeded');
x = await del(A, aSeason, 3);
ok(!x.ok && /target_changed/.test(x.message) && same(sDel, await state(db)), 'a stale count is refused (target_changed), nothing changed', x.message || 'succeeded');
x = await del(A, aSeason, -1);
ok(!x.ok && /invalid_input/.test(x.message), 'a negative count is refused', x.message || 'succeeded');
// The deletes that succeed run in transactions rolled back afterwards (the library stays whole for later sections).
async function rolledBack(fn) {
  return db.transaction(async tx => { const out = await fn(tx); await tx.rollback(); return out; }).catch(e => ({ error: e.message }));
}
const showOf = await val(db, `select show_id::text from public.watchlist_items where id = $1`, [aSeason]);
const sibling = await val(db, `select count(*)::int from public.watchlist_items where show_id = $1`, [showOf]);
const okDel = await rolledBack(async tx => {
  await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: A, role: 'authenticated' })]);
  const r = (await tx.query(`select public.delete_tv_season($1::uuid, 2) r`, [aSeason])).rows[0].r;
  const left = (await tx.query(`select (select count(*)::int from public.watchlist_items where id = $1) s, (select count(*)::int from public.episode_marks where season_id = $1) m,
    (select count(*)::int from public.tv_shows where id = $2) sh`, [aSeason, showOf])).rows[0];
  return { r, left };
});
ok(!okDel.error && okDel.r.marks_deleted === 2 && okDel.left.s === 0 && okDel.left.m === 0 && okDel.left.sh === (sibling > 1 ? 1 : 0) && okDel.r.show_deleted === (sibling === 1),
  'the right count deletes the season and its marks (and the show with its last season)', JSON.stringify(okDel));
const plain = await val(db, `select w.id::text from public.watchlist_items w where w.user_id = '${A}' and not w.is_film
  and not exists (select 1 from public.episode_marks m where m.season_id = w.id) order by w.id limit 1`);
const oldDel = await rolledBack(async tx => {
  await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: A, role: 'authenticated' })]);
  return (await tx.query(`select public.delete_tv_season($1::uuid) r`, [plain])).rows[0].r;
});
ok(!oldDel.error && oldDel.marks_deleted === 0 && oldDel.deleted_row_id === plain, 'an old-style call still deletes a season without marks', JSON.stringify(oldDel));
ok(same(sDel, await state(db)), 'state unchanged after the rolled-back deletes');
ok(Number(await val(db, `select count(*) from pg_proc where proname = 'delete_tv_season'`)) === 1, 'exactly one delete_tv_season signature exists');

section('iso: B and a non-member C');
const bSeason = await val(db, `select id::text from public.watchlist_items where user_id = '${B}' and not is_film and media_type = 'tv' and tmdb_id is not null and not watched and not skipped order by id limit 1`);
const sIso = await state(db);
for (const [label, fn, re] of [
  ['set marks on A’s season', () => setMarks(B, aSeason, true, [ep(930001, 1)]), /target_missing/],
  ['clear A’s marks', () => setMarks(B, aSeason, false, [{ tmdb_episode_id: 910001 }]), /target_missing/],
  ['delete A’s marked season (new form)', () => del(B, aSeason, 2), /not_found/],
  ['delete A’s marked season (old form)', () => del(B, aSeason), /not_found/],
  ['insert a mark on A’s season with library_write', () => attempt(() => db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true), set_config('watchlist.library_write', 'on', true)`, [JSON.stringify({ sub: B, role: 'authenticated' })]);
    return (await tx.query(`insert into public.episode_marks (season_id, tmdb_episode_id, episode_number) values ($1, 930002, 1)`, [aSeason])).rows;
  })), /violates|season_unmatched|row-level security/],
  ['delete A’s marks directly with library_write', () => attempt(() => db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true), set_config('watchlist.library_write', 'on', true)`, [JSON.stringify({ sub: B, role: 'authenticated' })]);
    const r = (await tx.query(`delete from public.episode_marks where season_id = $1 returning 1`, [aSeason])).rows;
    if (r.length) throw new Error('deleted A’s marks');
    throw new Error('rows0');
  })), /rows0/],
  ['C sets marks on its own behalf', () => setMarks(C, aSeason, true, [ep(930003, 1)]), /not_a_member/],
]) {
  const r = await fn();
  ok(!r.ok && re.test(r.message), `${label} → refused`, r.message || JSON.stringify(r.rows));
}
const seen = await asUser(db, B, `select count(*)::int n from public.episode_marks`);
const seenC = await asUser(db, C, `select count(*)::int n from public.episode_marks`);
ok(seen[0].n === 0 && seenC[0].n === 0, 'B and C see none of A’s marks');
ok(same(sIso, await state(db)), 'nothing changed by B’s and C’s attempts');
x = await setMarks(B, bSeason, true, [ep(940001, 1)]);
ok(x.ok, 'B marks an episode of B’s own season', x.message);
const seenA = await asUser(db, A, `select count(*)::int n from public.episode_marks where user_id <> '${A}'`);
ok(seenA[0].n === 0, 'A doesn’t see B’s mark');

section('rst: restore_backup format 6');
const docA = await exportDoc(db, A);
const bMarkId = (await asUser(db, B, `select id::text from public.episode_marks limit 1`))[0].id;
const bBefore = await rowsOfOwner(db, B);
ok(docA.tables.episode_marks.length === 2 && docA.formatVersion === 6, 'A’s format-6 export holds A’s two marks');
const pageErrs = validate(docA);
ok(pageErrs.length === 0, 'the page validates A’s format-6 export', pageErrs.join('\n'));
const restoreAs = (who, d) => attempt(() => asUser(db, who, `select public.restore_backup($1::jsonb, false) r`, [d]));
// Clear one mark, then restore: it comes back.
ok((await setMarks(A, aSeason, false, [{ tmdb_episode_id: 910001 }])).ok, 'A clears a mark before restoring');
x = await restoreAs(A, docA);
ok(x.ok && x.rows[0].r.formatVersion === 6 && x.rows[0].r.restored.episode_marks === 2, 'A restores A’s format-6 file (restored.episode_marks = 2)', x.message || JSON.stringify(x.rows));
ok(same(await exportDoc(db, A).then(d => d.tables), docA.tables), 'after the restore A’s library equals the file, every table and mark');
ok(same(bBefore, await rowsOfOwner(db, B)), 'B’s library and mark are unchanged by A’s restore');
const sR = await state(db);
const variant = f => { const d = JSON.parse(JSON.stringify(docA)); f(d); return d; };
const someSeason = docA.tables.watchlist_items.find(r => r.media_type === 'tv' && r.tmdb_id != null && r.season_number != null && r.id !== aSeason);
const unmatchedRow = docA.tables.watchlist_items.find(r => r.show_id && r.tmdb_id == null);
for (const [label, d, re] of [
  ['format 5', variant(d => { d.formatVersion = 5; delete d.tables.episode_marks; delete d.rowCounts.episode_marks; }), /converted in the page first/],
  ['no episode_marks table', variant(d => { delete d.tables.episode_marks; delete d.rowCounts.episode_marks; }), /unexpected set of tables for format 6/],
  ['a wrong marks count', variant(d => { d.rowCounts.episode_marks = 5; }), /rowCounts\.episode_marks/],
  ['a mark with an extra column', variant(d => { d.tables.episode_marks[0].user_id = A; }), /expected columns/],
  ['a mark id that isn’t a uuid', variant(d => { d.tables.episode_marks[0].id = 'x'; }), /isn't a uuid/],
  ['a mark for a season not in the file', variant(d => { d.tables.episode_marks[0].season_id = crypto.randomUUID(); }), /points at a season that isn't in it/],
  ['a repeated mark', variant(d => { d.tables.episode_marks.push({ ...d.tables.episode_marks[0], id: crypto.randomUUID() }); d.rowCounts.episode_marks++; }), /repeats an episode mark,/],
  ['a repeated mark id', variant(d => { d.tables.episode_marks.push({ ...d.tables.episode_marks[0], tmdb_episode_id: 999 }); d.rowCounts.episode_marks++; }), /restore_id_collision/],
  ['B’s mark id', variant(d => { d.tables.episode_marks[0].id = bMarkId; }), /restore_id_collision/],
  ['a negative episode number', variant(d => { d.tables.episode_marks[0].episode_number = -1; }), /breaks a rule/],
  ...(unmatchedRow ? [['a mark on an unmatched season', variant(d => { d.tables.episode_marks[0].season_id = unmatchedRow.id; }), /breaks a rule \(season_unmatched/]] : []),
  ['a format-5 conversion record with a recovery section', variant(d => { d.conversion = { source_format: '5', source_sha256: 'a'.repeat(64), converter_version: 'ep1.1', source_exported_at: 'x' }; d.recovery = {}; }), /conversion record is malformed/],
  ['a malformed format-5 conversion record', variant(d => { d.conversion = { source_format: '5', source_sha256: 'x' }; }), /conversion record is malformed/],
  ['an unknown source format', variant(d => { d.conversion = { source_format: '6', source_sha256: 'a'.repeat(64), converter_version: 'x', source_exported_at: 'x' }; }), /conversion record is malformed/],
  ['B’s ids (another owner’s)', JSON.parse(JSON.stringify(docB), (k, v) => v) && variant(d => { d.tables.watchlist_items[0].id = (docB.tables.watchlist_items[0] || {}).id; }), /restore_id_collision|restore_invalid/],
]) {
  const r = await restoreAs(A, d);
  ok(!r.ok && re.test(r.message) && same(sR, await state(db)), `refused, nothing changed: ${label}`, r.message || 'succeeded');
}
x = await restoreAs(A, variant(d => { d.conversion = { source_format: '5', source_sha256: 'b'.repeat(64), converter_version: 'ep1.1', source_exported_at: '2026-10-20T00:00:00Z' }; }));
ok(x.ok && x.rows[0].r.converted_from === 5 && same(sR, await state(db)), 'a file converted from format 5 (a well-formed record) restores; the library is the same', x.message);
if (someSeason) {
  const withMore = variant(d => { d.tables.episode_marks.push({ id: crypto.randomUUID(), season_id: someSeason.id, tmdb_episode_id: 950001, episode_number: 1 }); d.rowCounts.episode_marks++; });
  x = await restoreAs(A, withMore);
  ok(x.ok && x.rows[0].r.restored.episode_marks === 3, 'a file with a mark on another matched season restores it', x.message);
  x = await restoreAs(A, docA);
  ok(x.ok && same(sR, await state(db)), 'restoring the original file again gives the same state');
}
ok(same(bBefore, await rowsOfOwner(db, B)), 'B is unchanged by all of A’s restores');
const tb45 = await attempt(() => db.transaction(async tx => {
  await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A, role: 'authenticated' })]);
  return tx.exec(sql('db/test/_prelude.sql') + sql('db/test/t_b45.sql'));
}));
ok(tb45.ok, 'db/test/t_b45.sql (as postgres with A’s claims) still passes after EP1', tb45.message);

section('adm: the admin restore runbook at format 6');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep1adm-'));
  const tool = (...args) => { try { return { ok: true, out: execFileSync(process.execPath, [path.join(ROOT, 'tools/admin-restore.mjs'), ...args], { encoding: 'utf8' }) }; }
    catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; } };
  const exportAs = async owner => {
    const r = await tryExec(db, tool('export-sql', '--owner', owner).out);
    return r.ok ? r.out.map(q => q.rows && q.rows[0] && q.rows[0].backup).find(Boolean) : null;
  };
  try {
    const safetyText = await exportAs(A);
    const safety = safetyText && JSON.parse(safetyText);
    ok(safety && safety.formatVersion === 6 && safety.tables.episode_marks.length === 2 && validate(safety).length === 0,
      'the member export SQL makes a valid format-6 backup with A’s marks', safety ? validate(safety).join('; ') : 'no export');
    fs.writeFileSync(path.join(dir, 'safety.json'), safetyText);
    fs.writeFileSync(path.join(dir, 'file.json'), JSON.stringify(docA));
    fs.writeFileSync(path.join(dir, 'file5.json'), JSON.stringify(doc5));
    const good = tool('check', '--file', path.join(dir, 'file.json'), '--safety', path.join(dir, 'safety.json'));
    ok(good.ok && /OK/.test(good.out), 'check: A’s format-6 file passes', good.out);
    const conv = tool('check', '--file', path.join(dir, 'file5.json'), '--safety', path.join(dir, 'safety.json'), '--out', path.join(dir, 'conv6.json'));
    ok(conv.ok && /converted to format 6/.test(conv.out) && /episode marks: the file has 0; the library has 2/.test(conv.out),
      'check converts a format-5 file to format 6 and reports the marks it would remove', conv.out);
    const r = await tryExec(db, tool('restore-sql', '--file', path.join(dir, 'file.json'), '--owner', A, '--email', 'a@test.invalid', '--run', 'ep1-adm-1').out);
    ok(r.ok, 'the restore SQL restores the format-6 file as A', r.message);
    fs.writeFileSync(path.join(dir, 'after.json'), await exportAs(A));
    const ver = tool('verify', '--file', path.join(dir, 'file.json'), '--after', path.join(dir, 'after.json'));
    ok(ver.ok && /VERIFIED/.test(ver.out), 'verify: the export after the restore equals the file, marks included', ver.out);
    const ownerText = await (async () => { const q = await tryExec(db, tool('export-owner-sql', '--user', B).out); return q.ok ? q.out.map(z => z.rows && z.rows[0] && z.rows[0].backup).find(Boolean) : null; })();
    const owner = ownerText && JSON.parse(ownerText);
    ok(owner && owner.formatVersion === 6 && owner.tables.episode_marks.length === 1 && validate(owner).length === 0, 'the owner export of B is format 6 with B’s one mark',
      owner ? validate(owner).join('; ') : 'no export');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

section('rev: test-environment reverse');
{
  const R = await replica();
  const unmarked = await tryExec(R, sql('db/test/ep1_reverse.sql'));
  ok(!unmarked.ok && /not a marked test environment|EP1 is not installed/.test(unmarked.message), 'the reverse refuses before EP1 / an unmarked database', unmarked.message || 'committed');
  await R.exec(`select set_config('watchlist.test_project', 'local', false);\n` + sql('db/test/m1_test_marker.sql'));
  const r0 = await state(R);
  const a = await tryExec(R, preamble('rev-run-1') + EP1);
  const seasonR = await val(R, `select id::text from public.watchlist_items where user_id = '${A}' and not is_film and media_type = 'tv' and tmdb_id is not null and not watched and not skipped order by id limit 1`);
  await asUser(R, A, `select public.library_set_episode_marks($1::uuid, '${NONE}', true, '[{"tmdb_episode_id":960001,"episode_number":1}]')`, [seasonR]);
  const refused = await tryExec(R, sql('db/test/ep1_reverse.sql'));
  ok(!refused.ok && /episode marks exist/.test(refused.message), 'the reverse refuses while marks exist', refused.message || 'committed');
  await asUser(R, A, `select public.library_set_episode_marks($1::uuid, '${NONE}', false, '[{"tmdb_episode_id":960001}]')`, [seasonR]);
  const b = a.ok && await tryExec(R, sql('db/test/ep1_reverse.sql'));
  const r1 = await state(R);
  ok(a.ok && b && b.ok && same(r0, r1), 'EP1 then the reverse gives back the exact pre-EP1 state (rows, catalog, ACLs, policies, run records)',
    (a.message || (b && b.message) || '') + '\n' + catDiff(r0.cat, r1.cat).join('\n'));
  const c = await tryExec(R, preamble('rev-run-2') + EP1);
  ok(c.ok, 'EP1 applies again after the reverse', c.message);
}

section('inputs unchanged');
ok(sha(fs.readFileSync(backupFile)) === backupSha, 'the backup file is unchanged');
console.log(`\n${failed ? `FAILED: ${failed}` : 'all rehearsal checks passed'}`);
process.exitCode = failed ? 1 : 0;

async function rowsOfOwner(d, owner) {
  const out = {};
  for (const t of [...T5, 'episode_marks']) {
    out[t] = await val(d, `select md5(coalesce(string_agg(x, '|' order by x), '')) from (select (to_jsonb(r) - 'user_id')::text x from public.${t} r where user_id = $1) q`, [owner]);
  }
  return out;
}
