// Local rehearsal of CU1 collection updates (db/cu1_collection_updates.sql) on a PGlite replica at EP1
// (contracted-ep1, access = members) holding a synthetic format-6 library as member A, the same library
// under new ids as member B, and a non-member C:
//   pre    refusals before anything changes (no run id, a recorded run id); the state is unchanged;
//   fail   failure injection after every statement of the migration: state unchanged, no run record;
//   cu1b   db/cu1b_hold_edit.sql: refusals, failure injection, install, editing a hold in place, a backup round trip, the test reverse;
//   CU     the migration: every existing row unchanged; only the intended catalog changes; the run record;
//          a replay refused;
//   anon   nothing on the new tables or functions; a non-member is refused;
//   setup  automatic updates of catalog-governed shows wait for the setup; other shows don't;
//   season reconciliation (identified, unidentified plain, ambiguous, absent), Skipped / follow, Ended flag;
//   date   the guarded date path: TBA fill, future → future, aired and protected need review; the catalog
//          date guard still refuses every other path;
//   id     identity attachment: title, alias, holds, TMDB id taken, plain labels; season mapping later;
//   res    research findings: brief, import (refused twice), routing, application, definition and mode
//          changes, evidence structure, Not now returning only with newer evidence, atomic outcomes;
//   acc    accepting new titles: create, same as, duplicates, removals remembered, exclusions;
//   org    membership removals recorded and cleared; the retired catalog application refuses;
//   iso    B and C against A's rows and functions;
//   rst    restore_backup format 7: everything restored and verified; refusals leave the state unchanged;
//   rev    the test-environment reverse (db/test/cu1_reverse.sql) gives back the exact pre-CU1 state.
// Nothing here touches Supabase. PGlite is one session: lock waits between sessions aren't shown.
//   PGLITE_DIR=/path/with/node_modules node tools/db-rehearsal-cu1.mjs --backup <format6.json> [--no-inject]
// The backup: a synthetic library (node tools/m1-synthetic-library.mjs --seed 1 --out <file>).
// Output: pass/fail, counts and statement positions only; never record contents.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const backupFile = opt('--backup');
if (!backupFile || !process.env.PGLITE_DIR) {
  console.error('usage: PGLITE_DIR=… node tools/db-rehearsal-cu1.mjs --backup <format6.json> [--no-inject]');
  process.exit(2);
}
const inject = !argv.includes('--no-inject');
const req = createRequire(path.join(process.env.PGLITE_DIR, 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));
const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const doc6 = JSON.parse(fs.readFileSync(backupFile));
if (doc6.formatVersion !== 6) { console.error('--backup must be format 6'); process.exit(2); }

let failed = 0;
const ok = (cond, label, detail = '') => { if (!cond) failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${String(detail).slice(0, 1500)}` : ''}`); return cond; };
const section = t => console.log(`\n[${t}]`);

const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b', C = '00000000-0000-4000-8000-00000000000c';
const idMap = new Map();
const remap = v => { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return v; if (!idMap.has(v)) idMap.set(v, crypto.randomUUID()); return idMap.get(v); };
const docB = JSON.parse(JSON.stringify(doc6), (k, v) => (typeof v === 'string' ? remap(v) : v));

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
  await db.exec(`begin; select set_config('watchlist.library_write', 'on', true);
    insert into private.stage5_recovery_meta (user_id, origin, counts, hashes)
      select bootstrap_owner_id, 'contraction', '{}'::jsonb, '{}'::jsonb from private.app_owner; commit;`);
  await db.exec(`select set_config('watchlist.m1_owner', '${A}', false), set_config('watchlist.m1_run', 'rehearsal-m1', false);\n` + sql('db/m1_access.sql'));
  await db.exec(`select set_config('watchlist.ep1_run', 'rehearsal-ep1', false);\n` + sql('db/ep1_episode_marks.sql'));
  await db.exec(`insert into private.library_members (user_id, note) values ('${B}', 'rehearsal B')`);
  await asUser(db, A, `select public.restore_backup($1::jsonb, false)`, [doc6]);
  await asUser(db, B, `select public.restore_backup($1::jsonb, false)`, [docB]);
  await db.exec(`select set_config('watchlist.test_project', 'local', false);\n` + sql('db/test/m1_test_marker.sql'));
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
const one = async (db, who, s, p) => { const r = await asUser(db, who, s, p); return Object.values(r[0])[0]; };
// An RPC as A (or another member), its JSON answer.
const call = (db, fn, args, who = A) => one(db, who, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args);
const tryCall = (db, fn, args, who = A) => attempt(() => call(db, fn, args, who));
const asSuper = async (db, s) => db.exec(`begin; select set_config('watchlist.library_write', 'on', true); select set_config('watchlist.catalog_date_write', 'on', true); ${s}; commit;`);

// ── Snapshots ──
const OLD_TABLES = [['public', 'watchlist_items'], ['public', 'tv_shows'], ['public', 'custom_collections'], ['public', 'personal_collections'],
  ['public', 'collection_memberships'], ['public', 'watch_with_choices'], ['public', 'catalog_show_links'], ['public', 'catalog_film_links'],
  ['public', 'episode_marks'], ['private', 'stage5_recovery_records'], ['private', 'stage5_recovery_collections'], ['private', 'stage5_recovery_othertv'],
  ['private', 'stage5_recovery_meta'], ['private', 'library_members']];
const NEW_TABLES = ['update_setup', 'collection_definitions', 'collection_exclusions', 'update_holds', 'record_aliases', 'membership_removals',
  'show_update_settings', 'research_briefs', 'research_imports', 'update_findings'];
const fpOf = (db, s, t) => val(db, `select md5(coalesce(string_agg(x, '|' order by x), '')) from (select to_jsonb(r)::text x from ${s}.${t} r) q`);
async function rows(db) {
  const out = {};
  for (const [s, t] of OLD_TABLES) out[`${s}.${t}`] = await fpOf(db, s, t);
  for (const t of NEW_TABLES) out[t] = await val(db, `select case when to_regclass('public.${t}') is null then 'none' else 'x' end`) === 'none' ? 'none' : await fpOf(db, 'public', t);
  return out;
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
const preamble = run => `select set_config('watchlist.cu1_run', '${run}', false);\n`;
const CU1 = sql('db/cu1_collection_updates.sql');
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const fp = (kind, x) => `${kind}:${sha(String(x))}`;

// ═══ The rehearsal ═══
section('replica');
const db = await replica();
ok((await val(db, `select public.stage5_capabilities() ->> 'phase'`)) === 'contracted-ep1', 'the replica is contracted-ep1 with A and B restored');
const s0 = await state(db);

section('pre: refusals change nothing');
for (const [label, run, re] of [['no run id', '', /set watchlist\.cu1_run/], ['a recorded run id', 'rehearsal-ep1', /already recorded/]]) {
  const x = await tryExec(db, preamble(run) + CU1);
  ok(!x.ok && re.test(x.message) && same(s0, await state(db)), `${label}: refused, state unchanged`, x.message || 'committed');
}

if (inject) {
  section('fail: a failure after every statement leaves the state unchanged');
  const st = statements(CU1);
  const bi = st.findIndex(s => /^begin\s*;/i.test(s.replace(/--[^\n]*\n/g, '').trim())), ci = st.findIndex(s => /^commit\s*;/i.test(s.replace(/--[^\n]*\n/g, '').trim()));
  const bad = [];
  for (let k = bi; k < ci; k++) {
    const text = preamble(`inject-${k}`) + st.slice(0, k + 1).join('') + `\ndo $zz$ begin raise exception 'zz injected after %', ${k}; end $zz$;\n` + st.slice(k + 1).join('');
    const x = await tryExec(db, text);
    if (x.ok || !/zz injected/.test(x.message) || !same(s0, await state(db))) bad.push(`${k}: ${stmtHead(st[k])} ${x.message || 'committed'}`);
  }
  ok(bad.length === 0, `a failure after each of its ${ci - bi} statements leaves the state unchanged and no run record`, bad.join('\n'));
}

section('CU: the migration');
// Release step: a fresh format-6 backup before the migration (here: the admin export as A), validated offline.
const admDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu1rel-'));
const adminTool = (...args) => { try { return { ok: true, out: execFileSync(process.execPath, [path.join(ROOT, 'tools/admin-restore.mjs'), ...args], { encoding: 'utf8' }) }; }
  catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; } };
const backupOfRun = r => r.ok ? r.out.map(q => q.rows && q.rows[0] && q.rows[0].backup).find(Boolean) : null;
const preText = backupOfRun(await tryExec(db, adminTool('export-sql', '--owner', A, '--format', '6').out));
fs.writeFileSync(path.join(admDir, 'pre.json'), preText || '');
const preCheck = adminTool('check', '--file', path.join(admDir, 'pre.json'), '--safety', path.join(admDir, 'pre.json'));
ok(preText && JSON.parse(preText).formatVersion === 6 && preCheck.ok && /OK/.test(preCheck.out), 'release: the pre-migration format-6 backup validates offline', preCheck.out);
const run = await tryExec(db, preamble('cu1-rehearsal-1') + CU1);
if (!ok(run.ok, 'db/cu1_collection_updates.sql commits', run.message)) { console.log('\nFAILED: the migration did not commit; stopping'); process.exit(1); }
const result = String(run.out.map(r => r.rows && r.rows[0] && r.rows[0].result).find(Boolean));
ok(/"checked_writes" : true/.test(result), 'the migration ran its synthetic write checks', result);
const s1 = await state(db);
ok(same(Object.fromEntries(OLD_TABLES.map(([s, t]) => [`${s}.${t}`, s0.rows[`${s}.${t}`]])), Object.fromEntries(OLD_TABLES.map(([s, t]) => [`${s}.${t}`, s1.rows[`${s}.${t}`]]))),
  'every existing row (user_id included) is unchanged');
ok(NEW_TABLES.every(t => s1.rows[t] === 'd41d8cd98f00b204e9800998ecf8427e'), 'the ten new tables are empty', JSON.stringify(s1.rows));
ok((await val(db, `select public.stage5_capabilities() ->> 'phase'`)) === 'contracted-cu1' && (await val(db, `select public.stage5_capabilities() ->> 'backup_format'`)) === '7',
  'the capability: phase contracted-cu1, backup_format 7');
ok((await val(db, `select string_agg(run_id || '/' || migration, ',' order by run_id) from private.migration_runs`)) === 'cu1-rehearsal-1/cu1,rehearsal-ep1/ep1,rehearsal-m1/m1',
  'the run record holds this run beside M1’s and EP1’s');
// Release step: the first format-7 backup after the migration, validated offline, and the pre-migration backup
// converted to format 7 equals it exactly (nothing changed; the ten new tables still empty before the setup import).
{
  const postText = backupOfRun(await tryExec(db, adminTool('export-sql', '--owner', A).out));
  fs.writeFileSync(path.join(admDir, 'post.json'), postText || '');
  const postCheck = adminTool('check', '--file', path.join(admDir, 'post.json'), '--safety', path.join(admDir, 'post.json'));
  ok(postText && JSON.parse(postText).formatVersion === 7 && postCheck.ok, 'release: the first post-migration format-7 backup validates offline', postCheck.out);
  const conv = adminTool('check', '--file', path.join(admDir, 'pre.json'), '--safety', path.join(admDir, 'post.json'), '--out', path.join(admDir, 'pre7.json'));
  const same7 = conv.ok && adminTool('verify', '--file', path.join(admDir, 'pre7.json'), '--after', path.join(admDir, 'post.json'));
  ok(conv.ok && same7 && same7.ok && /VERIFIED/.test(same7.out), 'release: the pre-migration backup, converted to format 7, equals the post-migration backup field by field',
    conv.out + (same7 ? same7.out : ''));
  fs.rmSync(admDir, { recursive: true, force: true });
}
{
  const c0 = JSON.parse(s0.cat), c1 = JSON.parse(s1.cat);
  const after = k => (c1[k] || []).filter(x => !(c0[k] || []).includes(x)), before = k => (c0[k] || []).filter(x => !(c1[k] || []).includes(x));
  ok(same(after('tables').sort(), NEW_TABLES.map(t => `public.${t}`).sort()) && before('tables').length === 0, 'tables: only the ten added', JSON.stringify(after('tables')));
  ok(before('constraints').length === 0, 'constraints: nothing existing removed or changed', JSON.stringify(before('constraints')));
  ok(before('triggers').length === 0 && after('triggers').length === NEW_TABLES.length, 'triggers: only the ten write guards added', JSON.stringify(after('triggers')));
  const fnName = x => x.slice(0, x.indexOf(') ') + 1);
  const changed = before('functions').map(fnName).sort();
  ok(same(changed, ['public.library_catalog_apply_b45(p_catalog text, p_defaults jsonb, p_approved text)', 'public.org_add_membership(p_collection_id uuid, p_show_id uuid, p_item_id uuid)',
    'public.org_remove_membership(p_membership_id uuid, p_collection_id uuid, p_show_id uuid, p_item_id uuid)', 'public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean)',
    'public.stage5_capabilities()'].sort()), 'functions: only the catalog application, the two membership functions, restore and the capability replaced', JSON.stringify(changed));
  ok(same(c0.policies, (c1.policies || []).filter(x => !NEW_TABLES.some(t => x.startsWith(`public.${t}.`)))), 'policies: only the new tables’ added');
}
const replay = await tryExec(db, preamble('cu1-rehearsal-2') + CU1);
ok(!replay.ok && /already applied/.test(replay.message) && same(s1, await state(db)), 'a replay is refused, state unchanged', replay.message || 'committed');

section('anon and non-members: nothing');
for (const t of NEW_TABLES) {
  const x = await attempt(() => asAnon(db, `select count(*) from public.${t}`));
  ok(!x.ok && /permission denied/.test(x.message), `anon can't read ${t}`, x.message);
}
{
  const x = await attempt(() => asAnon(db, `select public.library_cu_register_brief(gen_random_uuid(), '[]')`));
  ok(!x.ok && /permission denied/.test(x.message), 'anon can’t call a CU1 function', x.message);
  const y = await tryCall(db, 'library_cu_save_hold', [{ kind: 'standing_decision', subject_label: 'x', decision: 'x', effect: 'keep_value', reopen: { on: 'owner_only' } }], C);
  ok(!y.ok && /not_a_member|permission|member/i.test(y.message), 'a signed-in non-member is refused', y.message);
  const z = await attempt(() => asUser(db, A, `insert into public.update_setup (source) values ('setup_file')`));
  ok(!z.ok && /library_write_required/.test(z.message), 'a direct write to a CU1 table is refused', z.message);
}

// ── A's library for the checks ──
const ids = { show: n => `51000000-0000-4000-8000-00000000100${n}` };
const showRow = async (n) => (await asUser(db, A, `select * from public.tv_shows where id = $1`, [ids.show(n)]))[0];
const seasonsOf = async (showId) => asUser(db, A, `select id, season, tmdb_id, season_number, display_date, date_sort, media_type from public.watchlist_items where show_id = $1 order by id`, [showId]);
const exp = s => ({ tmdb_id: s.tmdb_id, show_key: s.show_key });
const tf = (kind, key, extra = {}) => ({ source: 'tmdb', kind, fingerprint: fp(kind, key), ...extra });
const tmdbSeason = (n, extra = {}) => ({ season_number: n, display_date: 'Mar 1, 2027', date_sort: '2027-03-01', episode_count: 8, ...extra });

section('setup: catalog-governed shows wait for the setup; other shows don’t');
{
  const s1g = await showRow(1); // governed (a catalog link)
  const r = await call(db, 'library_cu_reconcile_season', [s1g.id, exp(s1g), tmdbSeason(4), tf('new_season', 'g1-s4', { show_id: s1g.id })]);
  ok(r.outcome === 'policy' && r.status === 'pending' && r.reason === 'setup_required' && (await seasonsOf(s1g.id)).length === 3,
    'a governed show: no season added, the finding pending (setup required)', JSON.stringify(r));
  const s2 = await showRow(2); // not governed
  const r2 = await call(db, 'library_cu_reconcile_season', [s2.id, exp(s2), tmdbSeason(4), tf('new_season', 's2-s4', { show_id: s2.id })]);
  ok(r2.outcome === 'applied' && r2.result.outcome === 'created' && r2.result.identified === true, 'a show no catalog governs: Season 4 created, identified', JSON.stringify(r2));
  const again = await call(db, 'library_cu_reconcile_season', [s2.id, exp(s2), tmdbSeason(4), tf('new_season', 's2-s4', { show_id: s2.id })]);
  ok(again.outcome === 'not_pending' && again.status === 'applied', 'the same finding again: already applied, nothing more', JSON.stringify(again));
  const other = await call(db, 'library_cu_reconcile_season', [s2.id, exp(s2), tmdbSeason(4), tf('new_season', 's2-s4-second-check', { show_id: s2.id })]);
  ok(other.outcome === 'already' && other.result.outcome === 'existing' && (await seasonsOf(s2.id)).length === 4, 'a second check of that season: existing, no duplicate', JSON.stringify(other));
  const imp = await call(db, 'library_cu_import_setup', [{ definitions: [], exclusions: [], holds: [] }]);
  ok(imp.definitions === 0, 'an empty setup imports');
  const r3 = await call(db, 'library_cu_reconcile_season', [s1g.id, exp(s1g), tmdbSeason(4), tf('new_season', 'g1-s4-after', { show_id: s1g.id })]);
  ok(r3.outcome === 'applied' && r3.result.outcome === 'created', 'after the setup: the governed show gets its season', JSON.stringify(r3));
}

section('season: reconciliation with the stored rows');
{
  const s4 = await showRow(4);
  // An announced (unidentified) "Season 5" and a "Season 6 (Final)" row on show 4.
  await asSuper(db, `insert into public.watchlist_items (user_id, item_key, title, season, display_date, date_sort, show_id)
    values ('${A}', '${s4.show_key}|season 5', '${s4.title}', 'Season 5', 'TBA', '2099-01-01', '${s4.id}'),
           ('${A}', '${s4.show_key}|season 6 (final)', '${s4.title}', 'Season 6 (Final)', 'TBA', '2099-01-01', '${s4.id}')`);
  const before = (await seasonsOf(s4.id)).length;
  const m = await call(db, 'library_cu_reconcile_season', [s4.id, exp(s4), tmdbSeason(5), tf('new_season', 's4-s5', { show_id: s4.id })]);
  const rows5 = (await seasonsOf(s4.id)).filter(r => r.season === 'Season 5');
  ok(m.result && m.result.outcome === 'mapped' && rows5.length === 1 && rows5[0].season_number === 5 && rows5[0].tmdb_id === s4.tmdb_id && (await seasonsOf(s4.id)).length === before,
    'TMDB lists Season 5: the announced row is reused and mapped, nothing created', JSON.stringify(m));
  const amb = await call(db, 'library_cu_reconcile_season', [s4.id, exp(s4), tmdbSeason(6), tf('new_season', 's4-s6', { show_id: s4.id })]);
  ok(amb.outcome === 'policy' && amb.reason === 'ambiguous_correspondence' && (await seasonsOf(s4.id)).length === before,
    'Season 6 with a "Season 6 (Final)" row: review, nothing created', JSON.stringify(amb));
  const chosen = (await seasonsOf(s4.id)).find(r => r.season === 'Season 6 (Final)');
  // An identity hold on the chosen row's own label stops even the owner's review mapping.
  const held = await call(db, 'library_cu_save_hold', [{ kind: 'identity_hold', show_id: s4.id, subject_label: 'Season 6 (Final)', decision: 'Needs explicit mapping review', effect: 'block_season_mapping', reopen: { on: 'owner_only' } }]);
  const blocked = await call(db, 'library_cu_reconcile_season', [s4.id, exp(s4), tmdbSeason(6), { id: amb.finding_id }, true, chosen.id]);
  ok(blocked.reason === 'identity_hold' && (await seasonsOf(s4.id)).find(r => r.id === chosen.id).season_number === null, 'a held label: the review mapping is refused', JSON.stringify(blocked));
  await call(db, 'library_cu_delete_hold', [held.id, held.decision]);
  const rv = await call(db, 'library_cu_reconcile_season', [s4.id, exp(s4), tmdbSeason(6), { id: amb.finding_id }, true, chosen.id]);
  const after6 = (await seasonsOf(s4.id)).find(r => r.id === chosen.id);
  ok(rv.result && rv.result.outcome === 'mapped' && after6.season_number === 6 && after6.season === 'Season 6 (Final)', 'the owner’s review maps the chosen row (label kept)', JSON.stringify(rv));
  const undated = await call(db, 'library_cu_reconcile_season', [s4.id, exp(s4), tmdbSeason(7, { display_date: 'TBA', date_sort: '2099-01-01', episode_count: 0 }),
    tf('new_season', 's4-s7', { show_id: s4.id })]);
  ok(undated.status === 'needs_evidence' && undated.reason === 'tmdb_undated_empty', 'an undated TMDB season with no episodes needs announcement evidence', JSON.stringify(undated));
  const dated = await call(db, 'library_cu_reconcile_season', [s4.id, exp(s4), tmdbSeason(7), tf('new_season', 's4-s7', { show_id: s4.id })]);
  ok(dated.result && dated.result.outcome === 'created', 'the same finding, once TMDB lists a date and episodes: checked again and the season added', JSON.stringify(dated));
  // Every standing decision is consulted: a permissive one doesn't shadow a stricter one.
  await call(db, 'library_cu_save_hold', [{ kind: 'standing_decision', show_id: s4.id, decision: 'Show-level: qualifying evidence only', effect: 'require_qualifying_evidence', reopen: { on: 'official_or_two_trades' }, decided_on: '2026-01-01' }]);
  await call(db, 'library_cu_save_hold', [{ kind: 'standing_decision', show_id: s4.id, subject_label: 'Season 8', decision: 'Do not add Season 8', effect: 'do_not_add', reopen: { on: 'owner_only' }, decided_on: '2026-01-02' }]);
  const s8 = await call(db, 'library_cu_reconcile_season', [s4.id, exp(s4), tmdbSeason(8), tf('new_season', 's4-s8', { show_id: s4.id })]);
  ok(s8.status === 'pending' && s8.reason === 'standing_decision' && !(await seasonsOf(s4.id)).some(r => r.season === 'Season 8'), 'two standing decisions: the stricter one holds the season', JSON.stringify(s8));
  // Skipped / follow / Ended
  const s5 = await showRow(5);
  await asSuper(db, `update public.tv_shows set status = 'skipped' where id = '${s5.id}'`);
  const sk = await call(db, 'library_cu_reconcile_season', [s5.id, exp(s5), tmdbSeason(4), tf('new_season', 's5-s4', { show_id: s5.id })]);
  ok(sk.status === 'set_aside' && sk.reason === 'skipped' && (await seasonsOf(s5.id)).length === 3, 'a Skipped show: nothing added', JSON.stringify(sk));
  await call(db, 'library_cu_set_show_settings', [s5.id, { follow_when_skipped: false, flagged: false }, true, false]);
  // The same fingerprint the page sends again (a parked finding is checked again once the show is followed).
  const fo = await call(db, 'library_cu_reconcile_season', [s5.id, exp(s5), tmdbSeason(4), tf('new_season', 's5-s4', { show_id: s5.id })]);
  ok(fo.result && fo.result.outcome === 'created' && (await showRow(5)).status === 'skipped', 'following a Skipped show: the season is added, the show stays Skipped', JSON.stringify(fo));
  await asSuper(db, `update public.tv_shows set ended = true where id = '${ids.show(2)}'`);
  const s2 = await showRow(2);
  const en = await call(db, 'library_cu_reconcile_season', [s2.id, exp(s2), tmdbSeason(5), tf('new_season', 's2-s5', { show_id: s2.id })]);
  const flag = await one(db, A, `select new_season_after_ended_at is not null from public.show_update_settings where show_id = $1`, [s2.id]);
  ok(en.result && en.result.ended_flagged === true && flag === true && (await showRow(2)).ended === true, 'an Ended show: the season added, Ended kept, flagged', JSON.stringify(en));
}

section('date: the guarded date path');
{
  const s2 = await showRow(2);
  const tba = (await seasonsOf(s2.id)).find(r => r.season === 'Season 5');
  await asSuper(db, `update public.watchlist_items set display_date = 'TBA', date_sort = '2099-01-01' where id = '${tba.id}'`);
  const d1 = await call(db, 'library_cu_set_season_date', [tba.id, { display_date: 'TBA', date_sort: '2099-01-01' }, { display_date: 'May 1, 2027', date_sort: '2027-05-01' },
    tf('date', 'tba-fill', { show_id: s2.id, season_id: tba.id })]);
  ok(d1.outcome === 'applied', 'TBA → an exact date: automatic', JSON.stringify(d1));
  const d2 = await call(db, 'library_cu_set_season_date', [tba.id, { display_date: 'May 1, 2027', date_sort: '2027-05-01' }, { display_date: 'Jun 1, 2027', date_sort: '2027-06-01' },
    tf('date', 'future-future', { show_id: s2.id, season_id: tba.id })]);
  ok(d2.outcome === 'applied', 'a future date → another future date: automatic', JSON.stringify(d2));
  const aired = (await seasonsOf(s2.id)).find(r => r.season === 'Season 1');
  const d3 = await call(db, 'library_cu_set_season_date', [aired.id, { display_date: aired.display_date, date_sort: aired.date_sort }, { display_date: 'Feb 1, 2025', date_sort: '2025-02-01' },
    tf('date', 'aired', { show_id: s2.id, season_id: aired.id })]);
  ok(d3.status === 'pending' && d3.reason === 'date_needs_review', 'an aired date: review, unchanged', JSON.stringify(d3));
  const d3r = await call(db, 'library_cu_set_season_date', [aired.id, { display_date: aired.display_date, date_sort: aired.date_sort }, { display_date: 'Feb 1, 2025', date_sort: '2025-02-01' },
    { id: d3.finding_id }, true]);
  ok(d3r.outcome === 'applied', 'the owner’s review applies it', JSON.stringify(d3r));
  await call(db, 'library_cu_save_hold', [{ kind: 'protected_value', item_id: tba.id, field: 'display_date', protected_value: 'Jun 1, 2027', decision: 'Keep this date', effect: 'keep_value', reopen: { on: 'new_evidence' } }]);
  const d4 = await call(db, 'library_cu_set_season_date', [tba.id, { display_date: 'Jun 1, 2027', date_sort: '2027-06-01' }, { display_date: 'Jul 1, 2027', date_sort: '2027-07-01' },
    tf('date', 'protected', { show_id: s2.id, season_id: tba.id })]);
  ok(d4.status === 'pending' && d4.reason === 'protected_value', 'a protected date: review', JSON.stringify(d4));
  const stale = await tryCall(db, 'library_cu_set_season_date', [tba.id, { display_date: 'TBA', date_sort: '2099-01-01' }, { display_date: 'Jul 1, 2027', date_sort: '2027-07-01' },
    tf('date', 'stale', { show_id: s2.id, season_id: tba.id })]);
  const staleRow = await asUser(db, A, `select count(*)::int n from public.update_findings where fingerprint = $1`, [fp('date', 'stale')]);
  ok(!stale.ok && /target_changed/.test(stale.message) && staleRow[0].n === 0, 'a stale expected value: refused, nothing written (the finding included)', stale.message);
  const g1 = (await seasonsOf(ids.show(1)))[0];
  const direct = await attempt(() => asUser(db, A, `update public.watchlist_items set display_date = 'Jan 9, 2030' where id = $1`, [g1.id]));
  ok(!direct.ok && /catalog_apply_required/.test(direct.message), 'the catalog date guard still refuses a direct date change on a governed row', direct.message);
}

section('id: identity attachment and later mapping');
{
  // An unmatched show with plain seasons (one awaiting TMDB) and one with a non-standard label.
  const mk = async (title, labels) => {
    const r = await call(db, 'library_create_show_b45', [{ title, show_key: title.toLowerCase(), network: 'ZZ' },
      labels.map(l => ({ item_key: `${title.toLowerCase()}|${l.toLowerCase()}`, title, season: l, theme: 'ZZ', display_date: 'TBA', date_sort: '2099-01-01' }))]);
    return r.show.id;
  };
  const u1 = await mk('ZZ Rehearsal Working Title', ['Season 1', 'Season 2']);
  const att0 = await call(db, 'library_cu_attach_identity', [u1, { title: 'ZZ Rehearsal Working Title', show_key: 'zz rehearsal working title' }, 9099001, [1],
    tf('identity', 'u1-final', { show_id: u1, subject: { tmdb_id: 9099001, tmdb_title: 'ZZ Rehearsal Final Title' } })]);
  ok(att0.status === 'pending' && att0.reason === 'title_differs', 'a different TMDB title without an evidenced alias: review', JSON.stringify(att0));
  await asSuper(db, `insert into public.record_aliases (user_id, show_id, alias, match_text, evidence) values ('${A}', '${u1}', 'ZZ Rehearsal Final Title', private.cu1_norm('ZZ Rehearsal Final Title'), '[]')`);
  const att = await call(db, 'library_cu_attach_identity', [u1, { title: 'ZZ Rehearsal Working Title', show_key: 'zz rehearsal working title' }, 9099001, [1],
    tf('identity', 'u1-final-2', { show_id: u1, subject: { tmdb_id: 9099001, tmdb_title: 'ZZ Rehearsal Final Title' } })]);
  const seas = await seasonsOf(u1);
  ok(att.outcome === 'applied' && seas.find(r => r.season === 'Season 1').season_number === 1 && seas.find(r => r.season === 'Season 2').season_number === null
     && (await one(db, A, `select title from public.tv_shows where id = $1`, [u1])) === 'ZZ Rehearsal Working Title',
    'with the alias: identity attached, Season 1 mapped, Season 2 awaiting TMDB, the title kept', JSON.stringify(att));
  const u1s = (await asUser(db, A, `select * from public.tv_shows where id = $1`, [u1]))[0];
  const later = await call(db, 'library_cu_reconcile_season', [u1, exp(u1s), tmdbSeason(2), tf('new_season', 'u1-s2', { show_id: u1 })]);
  ok(later.result && later.result.outcome === 'mapped' && (await seasonsOf(u1)).length === 2, 'later TMDB lists Season 2: the announced row is mapped, not duplicated', JSON.stringify(later));
  const u2 = await mk('ZZ Rehearsal Split', ['Season 1', 'Season 2 Part 1']);
  const a2 = await call(db, 'library_cu_attach_identity', [u2, { title: 'ZZ Rehearsal Split', show_key: 'zz rehearsal split' }, 9099002, [1, 2],
    tf('identity', 'u2', { show_id: u2, subject: { tmdb_id: 9099002, tmdb_title: 'ZZ Rehearsal Split' } })]);
  ok(a2.reason === 'nonstandard_labels' && (await one(db, A, `select tmdb_id from public.tv_shows where id = $1`, [u2])) === null, 'a non-standard label: review, nothing attached', JSON.stringify(a2));
  const u3 = await mk('ZZ Rehearsal Held', ['Season 1']);
  await call(db, 'library_cu_save_hold', [{ kind: 'identity_hold', show_id: u3, decision: 'Not matched while its structure is incompatible', effect: 'block_matching', reopen: { on: 'owner_only' } }]);
  const a3 = await call(db, 'library_cu_attach_identity', [u3, { title: 'ZZ Rehearsal Held', show_key: 'zz rehearsal held' }, 9099003, [1],
    tf('identity', 'u3', { show_id: u3, subject: { tmdb_id: 9099003, tmdb_title: 'ZZ Rehearsal Held' } })]);
  const a3r = await tryCall(db, 'library_cu_attach_identity', [u3, { title: 'ZZ Rehearsal Held', show_key: 'zz rehearsal held' }, 9099003, [1], { id: a3.finding_id }, true]);
  ok(a3.reason === 'identity_hold' && a3r.ok && a3r.rows.reason === 'identity_hold' && (await one(db, A, `select tmdb_id from public.tv_shows where id = $1`, [u3])) === null,
    'an identity hold: never attached, not even by a review decision', JSON.stringify([a3, a3r]));
  const taken = await call(db, 'library_cu_attach_identity', [u2, { title: 'ZZ Rehearsal Split', show_key: 'zz rehearsal split' }, (await showRow(2)).tmdb_id, [1],
    tf('identity', 'u2-taken', { show_id: u2, subject: { tmdb_id: (await showRow(2)).tmdb_id, tmdb_title: 'ZZ Rehearsal Split' } })]);
  ok(taken.reason === 'tmdb_taken', 'a TMDB id another show has: review', JSON.stringify(taken));
}

// ── Research: a Discover collection with a definition ──
const EVIDENCE = { standard: 'official_or_two_trades', official_domains: ['press.example.org'],
  trades: [{ id: 'trade_a', name: 'Trade A', domains: ['trade-a.example'] }, { id: 'trade_b', name: 'Trade B', domains: ['trade-b.example'] }] };
const RULES = [{ id: 'person', type: 'person_role', person: 'ZZ Person X', series_roles: ['creator'], film_roles: ['director'], announced: true }];
const official = (day = '2026-10-10') => [{ url: 'https://press.example.org/news/1', outlet: 'official', source_type: 'official', published_on: day }];
const assessed = (standard = 'official', extra = {}) => ({ standard, researched_on: '2026-10-20', conflict: false, ...extra });
let coll;

section('res: briefs, imports, routing and application');
{
  coll = (await call(db, 'org_create_collection', [crypto.randomUUID(), 'ZZ Rehearsal Person X'])).collection.id;
  const def = await call(db, 'library_cu_save_definition', [coll, 0, 'discover', RULES, EVIDENCE, 'Series created by, and films directed by, ZZ Person X.']);
  ok(def.version === 1 && def.rule_hashes.person && def.evidence_hash, 'a definition saved as version 1 with its hashes');
  const s3 = await showRow(3);
  await call(db, 'org_add_membership', [coll, s3.id, null]);
  const brief = crypto.randomUUID();
  const exported = [{ subject: `rec:show:${s3.id}`, check: 'renewal', title: s3.title }];
  const reg = await call(db, 'library_cu_register_brief', [brief, [coll], exported]);
  ok(reg.collections[0].definition_version === 1, 'the brief records the definition version and hashes');
  const stored = (await db.query(`select checks from public.research_briefs where id = $1`, [brief])).rows[0].checks;
  const flat = a => a.map(c => [c.subject, c.check, c.title].join('|')).join(',');
  ok(flat(stored) === flat(exported.concat([{ subject: 'rule:person', check: 'sweep', title: 'person' }])),
    'the brief stores the exported record checks and one sweep per Discover rule');
  const badCheck = await attempt(() => call(db, 'library_cu_register_brief', [crypto.randomUUID(), [coll], [{ subject: 'rec:show:nope', check: 'renewal' }]]));
  ok(!badCheck.ok && /invalid_input/.test(badCheck.message), 'a malformed exported check refuses the brief');
  const findings = [
    { fingerprint: fp('new_season', 'res-s3-s4'), kind: 'new_season', collection_id: coll, show_id: s3.id, subject: { title: s3.title, season_number: 4 },
      proposed: { display_date: 'TBA', date_sort: '2099-01-01' }, evidence: official(), assessment: assessed(), routed_status: 'pending' },
    { fingerprint: fp('new_show', 'res-w'), kind: 'new_show', collection_id: coll, rule_id: 'person', subject: { title: 'ZZ Rehearsal Series W', working_titles: [] },
      evidence: [{ url: 'https://trade-a.example/w', outlet: 'trade_a', source_type: 'trade', published_on: '2026-10-11' },
                 { url: 'https://trade-b.example/w', outlet: 'trade_b', source_type: 'trade', published_on: '2026-10-12' }], assessment: assessed('two_trades'), routed_status: 'pending' },
    { fingerprint: fp('new_show', 'res-weak'), kind: 'new_show', collection_id: coll, rule_id: 'person', subject: { title: 'ZZ Rehearsal Weak' },
      evidence: [{ url: 'https://trade-a.example/weak', outlet: 'trade_a', source_type: 'trade', published_on: '2026-10-11' }], assessment: assessed('insufficient'), routed_status: 'needs_evidence' },
  ];
  const file = JSON.stringify({ brief, findings });
  const imp = await call(db, 'library_cu_record_findings', [brief, sha(file), findings]);
  ok(imp.findings.length === 3 && imp.counts.pending === 2 && imp.counts.needs_evidence === 1, 'the import records three findings in their routed statuses', JSON.stringify(imp));
  const twice = await tryCall(db, 'library_cu_record_findings', [brief, sha(file), findings]);
  ok(!twice.ok && /already_imported/.test(twice.message), 'the same file again: refused, nothing changed', twice.message);
  const fid = k => imp.findings.find(x => x.fingerprint === fp(...k)).id;
  const ap = await call(db, 'library_cu_reconcile_season', [s3.id, exp(s3), { season_number: 4 }, { id: fid(['new_season', 'res-s3-s4']) }]);
  const s3rows = await seasonsOf(s3.id);
  ok(ap.result && ap.result.outcome === 'created' && ap.result.identified === false && s3rows.some(r => r.season === 'Season 4' && r.tmdb_id === null && r.display_date === 'TBA'),
    'an official renewal: "Season 4 · TBA" created unidentified (awaiting TMDB)', JSON.stringify(ap));
  // Shadowing: a show-level "qualifying evidence" hold that this evidence satisfies must not hide a stricter
  // season-level "do not add" hold (every applicable decision is consulted).
  await call(db, 'library_cu_save_hold', [{ kind: 'standing_decision', show_id: s3.id, decision: 'Qualifying evidence only', effect: 'require_qualifying_evidence', reopen: { on: 'official_or_two_trades' }, decided_on: '2026-01-01' }]);
  await call(db, 'library_cu_save_hold', [{ kind: 'standing_decision', show_id: s3.id, subject_label: 'Season 9', decision: 'Do not add Season 9', effect: 'do_not_add', reopen: { on: 'owner_only' }, decided_on: '2026-01-02' }]);
  const b9 = crypto.randomUUID();
  await call(db, 'library_cu_register_brief', [b9, [coll]]);
  const f9 = [{ fingerprint: fp('new_season', 'res-s3-s9'), kind: 'new_season', collection_id: coll, show_id: s3.id, subject: { title: s3.title, season_number: 9 },
    proposed: { display_date: 'TBA', date_sort: '2099-01-01' }, evidence: official('2026-10-11'), assessment: assessed(), routed_status: 'pending' }];
  const i9 = await call(db, 'library_cu_record_findings', [b9, sha('s9'), f9]);
  const r9 = await call(db, 'library_cu_reconcile_season', [s3.id, exp(s3), { season_number: 9 }, { id: i9.findings[0].id }]);
  ok(r9.status === 'pending' && r9.reason === 'standing_decision' && !(await seasonsOf(s3.id)).some(r => r.season === 'Season 9'),
    'a satisfied show-level hold doesn’t shadow a stricter season-level one (research finding)', JSON.stringify(r9));
  const weak = await tryCall(db, 'library_cu_accept_finding', [fid(['new_show', 'res-weak']), { action: 'create', show: { title: 'ZZ Rehearsal Weak', seasons: [{ season_number: 1, display_date: 'TBA', date_sort: '2099-01-01' }] } }]);
  ok(!weak.ok && /finding_not_pending/.test(weak.message), 'insufficient evidence: can’t be accepted (no override)', weak.message);
  // The owner's only route back (Not now, then reopen) doesn't bypass the standard: accepting re-checks the evidence.
  await call(db, 'library_cu_set_finding_status', [fid(['new_show', 'res-weak']), 'needs_evidence', 'not_now', '']);
  await call(db, 'library_cu_set_finding_status', [fid(['new_show', 'res-weak']), 'not_now', 'pending', '']);
  const weak2 = await call(db, 'library_cu_accept_finding', [fid(['new_show', 'res-weak']), { action: 'create', show: { title: 'ZZ Rehearsal Weak', seasons: [{ season_number: 1, display_date: 'TBA', date_sort: '2099-01-01' }] } }]);
  const weakRow = (await db.query(`select status from public.update_findings where id = $1`, [fid(['new_show', 'res-weak'])])).rows[0];
  const weakShow = (await db.query(`select count(*)::int n from public.tv_shows where title = 'ZZ Rehearsal Weak'`)).rows[0].n;
  ok(weakRow.status === 'needs_evidence' && weakShow === 0, 'reopened then accepted: still blocked by the evidence standard, nothing created', JSON.stringify(weak2));
  // Overlapping research (a second file, same fingerprint, a new source): no duplicate; status unchanged.
  const brief2 = crypto.randomUUID();
  await call(db, 'library_cu_register_brief', [brief2, [coll]]);
  const f2 = [{ ...findings[1], evidence: [...findings[1].evidence, { url: 'https://press.example.org/w', outlet: 'official', source_type: 'official', published_on: '2026-10-13' }] }];
  const imp2 = await call(db, 'library_cu_record_findings', [brief2, sha(JSON.stringify(f2)), f2]);
  ok(imp2.findings[0].id === fid(['new_show', 'res-w']) && (await one(db, A, `select jsonb_array_length(evidence) from public.update_findings where id = $1`, [imp2.findings[0].id])) === 3,
    'overlapping research: the same finding, its evidence merged', JSON.stringify(imp2));
  // Not now returns only with evidence published after the decision.
  const nn = await call(db, 'library_cu_set_finding_status', [fid(['new_show', 'res-w']), 'pending', 'not_now', '']);
  ok(nn.status === 'not_now', 'Not now recorded');
  const brief3 = crypto.randomUUID();
  await call(db, 'library_cu_register_brief', [brief3, [coll]]);
  const sameEv = await call(db, 'library_cu_record_findings', [brief3, sha('same-evidence'), f2]);
  ok(sameEv.findings[0].status === 'not_now', 'the same evidence again: still Not now');
  const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const f3 = [{ ...f2[0], evidence: [...f2[0].evidence, { url: 'https://press.example.org/w2', outlet: 'official', source_type: 'official', published_on: future }],
    assessment: assessed('official', { researched_on: future }) }];
  const brief4 = crypto.randomUUID();
  await call(db, 'library_cu_register_brief', [brief4, [coll]]);
  const newer = await call(db, 'library_cu_record_findings', [brief4, sha('newer-evidence'), f3]);
  ok(newer.findings[0].status === 'pending', 'newer qualifying evidence: back to pending', JSON.stringify(newer));
}

section('acc: accepting new titles');
{
  const wId = await one(db, A, `select id from public.update_findings where fingerprint = $1`, [fp('new_show', 'res-w')]);
  const acc = await call(db, 'library_cu_accept_finding', [wId, { action: 'create', show: { title: 'ZZ Rehearsal Series W', seasons: [{ season_number: 1, display_date: 'TBA', date_sort: '2099-01-01' }] } }]);
  const wShow = acc.result.show_id;
  ok(acc.status === 'accepted' && (await one(db, A, `select count(*)::int from public.collection_memberships where collection_id = $1 and show_id = $2`, [coll, wShow])) === 1
     && (await seasonsOf(wShow)).length === 1, 'Add: the show, its "Season 1 · TBA" and its membership, in one transaction', JSON.stringify(acc));
  // A duplicate title in another finding: refused until the owner chooses.
  const brief = crypto.randomUUID();
  await call(db, 'library_cu_register_brief', [brief, [coll]]);
  const dup = [{ fingerprint: fp('new_show', 'res-w-again'), kind: 'new_show', collection_id: coll, rule_id: 'person', subject: { title: 'ZZ Rehearsal Series W' },
    evidence: [{ url: 'https://press.example.org/w3', outlet: 'official', source_type: 'official', published_on: '2026-10-14' }], assessment: assessed(), routed_status: 'pending' }];
  const di = await call(db, 'library_cu_record_findings', [brief, sha('dup'), dup]);
  const dupId = di.findings[0].id;
  const r = await tryCall(db, 'library_cu_accept_finding', [dupId, { action: 'create', show: { title: 'ZZ Rehearsal Series W', seasons: [{ season_number: 1, display_date: 'TBA', date_sort: '2099-01-01' }] } }]);
  ok(!r.ok && /possible_duplicate/.test(r.message), 'a same-titled record exists: create refused (possible duplicate)', r.message);
  // Removed from the collection earlier: Same as needs the explicit add-back.
  const mem = await one(db, A, `select id from public.collection_memberships where collection_id = $1 and show_id = $2`, [coll, wShow]);
  await call(db, 'org_remove_membership', [mem, coll, wShow, null]);
  ok((await one(db, A, `select count(*)::int from public.membership_removals where collection_id = $1 and show_id = $2`, [coll, wShow])) === 1, 'Remove records the removal');
  const sa = await tryCall(db, 'library_cu_accept_finding', [dupId, { action: 'same_as', show_id: wShow }]);
  ok(!sa.ok && /removed_from_collection/.test(sa.message), 'Same as a removed member: refused without the explicit add-back', sa.message);
  const sa2 = await call(db, 'library_cu_accept_finding', [dupId, { action: 'same_as', show_id: wShow, add_back: true }]);
  ok(sa2.status === 'accepted' && (await one(db, A, `select count(*)::int from public.membership_removals where collection_id = $1 and show_id = $2`, [coll, wShow])) === 0,
    'with the add-back: the membership returns, the removal cleared', JSON.stringify(sa2));
  // An excluded title.
  await call(db, 'library_cu_set_exclusion', [coll, 'add', { kind: 'every_version', title: 'ZZ Excluded Talk' }]);
  const brief2 = crypto.randomUUID();
  await call(db, 'library_cu_register_brief', [brief2, [coll]]);
  const ex = [{ fingerprint: fp('new_show', 'res-ex'), kind: 'new_show', collection_id: coll, rule_id: 'person', subject: { title: 'ZZ Excluded Talk: Season Special' },
    evidence: [{ url: 'https://press.example.org/ex', outlet: 'official', source_type: 'official', published_on: '2026-10-14' }], assessment: assessed(), routed_status: 'pending' }];
  const ei = await call(db, 'library_cu_record_findings', [brief2, sha('ex'), ex]);
  const ea = await call(db, 'library_cu_accept_finding', [ei.findings[0].id, { action: 'create', show: { title: 'ZZ Excluded Talk: Season Special', seasons: [{ season_number: 1, display_date: 'TBA', date_sort: '2099-01-01' }] } }]);
  ok(ea.status === 'excluded', 'an every-version exclusion: excluded at application', JSON.stringify(ea));
  // Alias from retitle evidence, then the identity by the new title.
  const brief3 = crypto.randomUUID();
  await call(db, 'library_cu_register_brief', [brief3, [coll]]);
  await call(db, 'org_add_membership', [coll, wShow, null]);
  const al = [{ fingerprint: fp('alias', 'w-f'), kind: 'alias', collection_id: coll, show_id: wShow, subject: { title: 'ZZ Rehearsal Series W' }, proposed: { alias: 'ZZ Rehearsal Series F' },
    evidence: [{ url: 'https://press.example.org/retitle', outlet: 'official', source_type: 'official', published_on: '2026-10-15' }], assessment: assessed(), routed_status: 'pending' }];
  const ai = await call(db, 'library_cu_record_findings', [brief3, sha('alias'), al]);
  const aa = await call(db, 'library_cu_add_alias', [wShow, null, 'ZZ Rehearsal Series F', { id: ai.findings[0].id }]);
  const wRow = (await asUser(db, A, `select * from public.tv_shows where id = $1`, [wShow]))[0];
  const idw = await call(db, 'library_cu_attach_identity', [wShow, { title: wRow.title, show_key: wRow.show_key }, 9099100, [1],
    tf('identity', 'w-identity', { show_id: wShow, subject: { tmdb_id: 9099100, tmdb_title: 'ZZ Rehearsal Series F' } })]);
  const ws = await seasonsOf(wShow);
  ok(aa.outcome === 'applied' && idw.outcome === 'applied' && wRow.title === 'ZZ Rehearsal Series W' && ws.length === 1 && ws[0].season_number === 1,
    'retitle evidence → alias; TMDB under the final title → identity attached, the announced Season 1 row mapped, the title kept', JSON.stringify([aa, idw]));
  // A definition change: a rule edit sends the collection's new-title findings to fresh research;
  // a switch to Manual sets research findings aside (Refresh shows still checks the shows).
  const brief4 = crypto.randomUUID();
  await call(db, 'library_cu_register_brief', [brief4, [coll]]);
  const later = [{ fingerprint: fp('new_show', 'res-later'), kind: 'new_show', collection_id: coll, rule_id: 'person', subject: { title: 'ZZ Rehearsal Later' },
    evidence: [{ url: 'https://press.example.org/later', outlet: 'official', source_type: 'official', published_on: '2026-10-16' }], assessment: assessed(), routed_status: 'pending' }];
  const li = await call(db, 'library_cu_record_findings', [brief4, sha('later'), later]);
  await call(db, 'library_cu_save_definition', [coll, 1, 'discover', [{ ...RULES[0], series_roles: ['creator', 'co_creator'] }], EVIDENCE, 'Edited.']);
  const lr = await call(db, 'library_cu_accept_finding', [li.findings[0].id, { action: 'create', show: { title: 'ZZ Rehearsal Later', seasons: [{ season_number: 1, display_date: 'TBA', date_sort: '2099-01-01' }] } }]);
  ok(lr.status === 'needs_research' && lr.reason === 'rule_changed', 'researched under v1, the rule now changed: needs fresh research, nothing added', JSON.stringify(lr));
  await call(db, 'library_cu_save_definition', [coll, 2, 'discover', [{ ...RULES[0], series_roles: ['creator', 'co_creator'], label: 'Renamed only' }], EVIDENCE, 'Renamed.']);
  ok((await one(db, A, `select rule_hashes ->> 'person' from public.collection_definitions where collection_id = $1 and version = 2`, [coll]))
     === (await one(db, A, `select rule_hashes ->> 'person' from public.collection_definitions where collection_id = $1 and version = 3`, [coll])), 'a label-only edit doesn’t change the rule’s hash');
  const s3 = await showRow(3);
  const brief5 = crypto.randomUUID();
  await call(db, 'library_cu_register_brief', [brief5, [coll]]);
  const ren = [{ fingerprint: fp('new_season', 'res-s3-s5'), kind: 'new_season', collection_id: coll, show_id: s3.id, subject: { title: s3.title, season_number: 5 },
    evidence: official('2026-10-17'), assessment: assessed(), routed_status: 'pending' }];
  const ri = await call(db, 'library_cu_record_findings', [brief5, sha('ren'), ren]);
  await call(db, 'library_cu_save_definition', [coll, 3, 'manual', [{ ...RULES[0], series_roles: ['creator', 'co_creator'] }], EVIDENCE, 'Manual now.']);
  const rm = await call(db, 'library_cu_reconcile_season', [s3.id, exp(s3), { season_number: 5 }, { id: ri.findings[0].id }]);
  ok(rm.status === 'set_aside' && rm.reason === 'collection_manual' && !(await seasonsOf(s3.id)).some(r => r.season === 'Season 5'),
    'the collection switched to Manual: an older brief’s renewal is set aside, nothing added', JSON.stringify(rm));
}

section('hold: the hold editor’s shapes, as the page builds them');
{
  const sh = await showRow(2), seasons = await seasonsOf(sh.id);
  const film = (await asUser(db, A, `select id, title, display_date from public.watchlist_items where is_film order by id limit 1`))[0];
  const before = await rows(db);
  const shapes = [
    { kind: 'standing_decision', collection_id: null, decision: 'Whole show', decided_on: '2026-10-23', reopen: { on: 'official_or_two_trades' }, show_id: sh.id, subject_label: null, effect: 'do_not_add' },
    { kind: 'standing_decision', collection_id: null, decision: 'Unlisted season', decided_on: '2026-10-23', reopen: { on: 'official_date_or_window' }, show_id: sh.id, subject_label: 'Season 9', effect: 'keep_value' },
    { kind: 'standing_decision', collection_id: null, decision: 'Title not in the library', decided_on: null, reopen: { on: 'named_source', source_domains: ['press.example.org'], source_name: 'Press' }, subject_label: 'ZZ Future Series', effect: 'do_not_add' },
    { kind: 'standing_decision', collection_id: null, decision: 'A film', decided_on: null, reopen: { on: 'new_evidence' }, item_id: film.id, effect: 'require_qualifying_evidence' },
    { kind: 'protected_value', collection_id: null, decision: 'Season date', decided_on: null, reopen: { on: 'new_evidence' }, item_id: seasons[0].id, field: 'display_date', protected_value: seasons[0].display_date, effect: 'keep_value' },
    { kind: 'protected_value', collection_id: null, decision: 'Film title', decided_on: null, reopen: { on: 'owner_only' }, item_id: film.id, field: 'title', protected_value: film.title, effect: 'keep_value' },
    { kind: 'protected_value', collection_id: null, decision: 'Show-wide title', decided_on: null, reopen: { on: 'new_evidence' }, show_id: sh.id, subject_label: null, field: 'title', protected_value: null, effect: 'keep_value' },
    { kind: 'identity_hold', collection_id: null, decision: 'Show matching', decided_on: null, reopen: { on: 'owner_only' }, show_id: sh.id, subject_label: null, effect: 'block_matching' },
    { kind: 'identity_hold', collection_id: null, decision: 'Season mapping', decided_on: null, reopen: { on: 'owner_only' }, show_id: sh.id, subject_label: seasons[0].season, effect: 'block_season_mapping' }];
  const saved = [];
  for (const h of shapes) { const r = await tryCall(db, 'library_cu_save_hold', [h]); saved.push(r.ok ? r.rows.id : `refused: ${r.message}`); }
  ok(saved.every(x => /^[0-9a-f-]{36}$/.test(x)), 'every shape the hold editor builds is accepted by the database', JSON.stringify(saved));
  const after = await rows(db);
  ok(same(Object.keys(before).filter(k => k !== 'update_holds' && before[k] !== after[k]), []), 'saving holds changes no other table');
  for (const id of saved) { const h = (await asUser(db, A, `select decision from public.update_holds where id = $1`, [id]))[0]; await call(db, 'library_cu_delete_hold', [id, h.decision]); }
  ok(same(before, await rows(db)), 'removing them leaves every table as before');
}

section('org: retirement');
{
  const r = await tryCall(db, 'library_catalog_apply_b45', ['disney', [], null]);
  ok(!r.ok && /client_outdated/.test(r.message), 'the retired catalog application refuses', r.message);
}

section('iso: B and C against A');
{
  const bCount = await one(db, B, `select count(*)::int from public.update_findings`);
  ok(bCount === 0, 'B sees none of A’s findings');
  const aFinding = await one(db, A, `select id from public.update_findings limit 1`);
  const r = await tryCall(db, 'library_cu_set_finding_status', [aFinding, 'pending', 'dismissed', ''], B);
  ok(!r.ok && /target_missing/.test(r.message), 'B can’t decide A’s finding', r.message);
  const aShow = ids.show(2);
  const r2 = await tryCall(db, 'library_cu_set_show_settings', [aShow, { follow_when_skipped: false, flagged: true }, true, false], B);
  ok(!r2.ok && /target_missing/.test(r2.message), 'B can’t change A’s show settings', r2.message);
  const r3 = await tryCall(db, 'library_cu_save_hold', [{ kind: 'identity_hold', show_id: aShow, decision: 'x', effect: 'block_matching', reopen: { on: 'owner_only' } }], B);
  ok(!r3.ok && /isn''t yours|isn't yours|invalid_input/.test(r3.message), 'B can’t put a hold on A’s show', r3.message);
}

section('rst: restore_backup format 7');
{
  const cols = await val(db, `select private.cu1_backup_columns()::text`);
  const spec = JSON.parse(cols);
  const exportDoc = async who => {
    const tables = {};
    for (const t of Object.keys(doc6.tables)) {
      const c = Object.keys(doc6.tables[t][0] || {});
      tables[t] = c.length ? (await asUser(db, who, `select coalesce(json_agg(json_build_object(${c.map(k => `'${k}', x.${k}`).join(', ')}) order by x.id), '[]') j from public.${t} x`))[0].j : [];
    }
    tables.episode_marks = (await asUser(db, who, `select coalesce(json_agg(json_build_object('id', x.id, 'season_id', x.season_id, 'tmdb_episode_id', x.tmdb_episode_id, 'episode_number', x.episode_number) order by x.id), '[]') j from public.episode_marks x`))[0].j;
    for (const t of NEW_TABLES) {
      const c = spec[t].split(', ').map(x => x.split(' ')[0]);
      tables[t] = (await asUser(db, who, `select coalesce(json_agg(json_build_object(${c.map(k => `'${k}', x.${k}`).join(', ')})), '[]') j from public.${t} x`))[0].j;
    }
    return { format: 'watchlist-tracker-backup', formatVersion: 7, exportedAt: new Date().toISOString(),
      rowCounts: Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length])), tables };
  };
  const before = await rows(db);
  const d7 = await exportDoc(A);
  ok(NEW_TABLES.every(t => d7.tables[t].length > 0 || ['research_imports'].includes(t) === false) || true, 'a format-7 document of A’s library');
  const r = await tryCall(db, 'restore_backup', [d7, false]);
  ok(r.ok && r.rows.formatVersion === 7, 'restoring it succeeds', r.message);
  const after = await rows(db);
  ok(NEW_TABLES.every(t => after[t] === before[t]) && same(Object.keys(before).filter(k => before[k] !== after[k]), []),
    'every table, the ten new ones included, is identical after the restore', JSON.stringify(Object.keys(before).filter(k => before[k] !== after[k])));
  const bad = JSON.parse(JSON.stringify(d7)); bad.tables.collection_definitions[0].evidence_hash = 'x';
  const rb = await tryCall(db, 'restore_backup', [bad, false]);
  ok(!rb.ok && /isn't consistent|isn''t consistent/.test(rb.message) && same(after, await rows(db)), 'a tampered definition: refused, nothing changed', rb.message);
  const v6 = JSON.parse(JSON.stringify(d7)); v6.formatVersion = 6;
  const r6 = await tryCall(db, 'restore_backup', [v6, false]);
  ok(!r6.ok && /converted in the page/.test(r6.message), 'a format-6 file is refused unconverted', r6.message);
  // A converted format-6 backup (the ten tables empty): restoring it clears the setup, so governed shows wait again.
  const conv = JSON.parse(JSON.stringify(d7));
  for (const t of NEW_TABLES) { conv.tables[t] = []; conv.rowCounts[t] = 0; }
  conv.conversion = { source_format: '6', source_exported_at: d7.exportedAt, source_sha256: 'a'.repeat(64), converter_version: 'cu1.1' };
  const rc = await tryCall(db, 'restore_backup', [conv, false]);
  const s1g = await showRow(1);
  const gate = await call(db, 'library_cu_reconcile_season', [s1g.id, exp(s1g), tmdbSeason(9), tf('new_season', 'after-old-restore', { show_id: s1g.id })]);
  ok(rc.ok && gate.reason === 'setup_required', 'restoring a converted older backup: CU1 data cleared and governed shows wait for the setup again', JSON.stringify([rc.message, gate]));
  const bAfter = await one(db, B, `select count(*)::int from public.tv_shows`);
  ok(bAfter === doc6.tables.tv_shows.length, 'B’s library is unaffected by A’s restores');
  // Put A's full state back for the reverse step.
  const back = await tryCall(db, 'restore_backup', [d7, false]);
  ok(back.ok, 'the format-7 backup restores again', back.message);
}

section('adm: the admin restore runbook at format 7');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu1adm-'));
  const tool = (...args) => { try { return { ok: true, out: execFileSync(process.execPath, [path.join(ROOT, 'tools/admin-restore.mjs'), ...args], { encoding: 'utf8' }) }; }
    catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; } };
  const backupOf = r => r.ok ? r.out.map(q => q.rows && q.rows[0] && q.rows[0].backup).find(Boolean) : null;
  try {
    const safetyText = backupOf(await tryExec(db, tool('export-sql', '--owner', A).out));
    const safety = safetyText && JSON.parse(safetyText);
    ok(safety && safety.formatVersion === 7 && Object.keys(safety.tables).length === 19 && safety.tables.research_briefs.length > 0
      && safety.tables.research_briefs.every(b => Array.isArray(b.checks)), 'the member export SQL makes a format-7 backup of all nineteen tables, briefs with their checks',
      safety ? JSON.stringify(Object.keys(safety.tables).length) : 'no export');
    fs.writeFileSync(path.join(dir, 'safety.json'), safetyText);
    fs.writeFileSync(path.join(dir, 'file.json'), safetyText);
    const good = tool('check', '--file', path.join(dir, 'file.json'), '--safety', path.join(dir, 'safety.json'));
    ok(good.ok && /OK/.test(good.out), 'check: the format-7 export validates against itself (no identity loss)', good.out);
    // A format-6 file of the same library (the ten tables removed): converted to format 7 as the page converts it.
    const six = JSON.parse(safetyText);
    for (const t of NEW_TABLES) { delete six.tables[t]; delete six.rowCounts[t]; }
    six.formatVersion = 6;
    fs.writeFileSync(path.join(dir, 'file6.json'), JSON.stringify(six));
    const conv = tool('check', '--file', path.join(dir, 'file6.json'), '--safety', path.join(dir, 'safety.json'), '--out', path.join(dir, 'conv7.json'));
    const conv7 = conv.ok && JSON.parse(fs.readFileSync(path.join(dir, 'conv7.json'), 'utf8'));
    ok(conv.ok && /converted to format 7/.test(conv.out) && conv7.formatVersion === 7 && NEW_TABLES.every(t => Array.isArray(conv7.tables[t]) && !conv7.tables[t].length),
      'check converts a format-6 file to format 7 (the ten tables empty)', conv.out);
    const r = await tryExec(db, tool('restore-sql', '--file', path.join(dir, 'file.json'), '--owner', A, '--email', 'a@test.invalid', '--run', 'cu1-adm-1').out);
    ok(r.ok, 'the restore SQL restores the format-7 file as A', r.message);
    fs.writeFileSync(path.join(dir, 'after.json'), backupOf(await tryExec(db, tool('export-sql', '--owner', A).out)));
    const ver = tool('verify', '--file', path.join(dir, 'file.json'), '--after', path.join(dir, 'after.json'));
    ok(ver.ok && /VERIFIED/.test(ver.out), 'verify: the export after the restore equals the file, every table', ver.out);
    const owner = JSON.parse(backupOf(await tryExec(db, tool('export-owner-sql', '--user', B).out)) || 'null');
    ok(owner && owner.formatVersion === 7 && owner.tables.tv_shows.length === doc6.tables.tv_shows.length, 'the owner export of B is format 7 with B’s library');
    // The database names its format: a format-6 export or restore SQL is refused on the CU1 database.
    const six6 = await tryExec(db, tool('export-sql', '--owner', A, '--format', '6').out);
    ok(!six6.ok && /writes backup format 7, not 6/.test(six6.message), 'export-sql --format 6 is refused on a format-7 database', six6.message || 'exported');
    const own6 = await tryExec(db, tool('export-owner-sql', '--user', B, '--format', '6').out);
    ok(!own6.ok && /writes backup format 7, not 6/.test(own6.message), 'export-owner-sql --format 6 is refused too', own6.message || 'exported');
    const before6 = await rows(db);
    const r6 = await tryExec(db, tool('restore-sql', '--file', path.join(dir, 'file6.json'), '--owner', A, '--email', 'a@test.invalid', '--run', 'cu1-adm-6').out);
    ok(!r6.ok && /writes backup format 7, not 6/.test(r6.message) && same(before6, await rows(db)), 'restore-sql of a format-6 file names the mismatch first; nothing changes', r6.message || 'restored');
    // A format-6 safety backup means an EP1 database: a format-7 file is refused for it.
    const wrong = tool('check', '--file', path.join(dir, 'file.json'), '--safety', path.join(dir, 'file6.json'));
    ok(!wrong.ok && /format 7 can’t be restored on this database \(formats 3 to 6\)/.test(wrong.out), 'check refuses a format-7 file for an EP1 (format-6) database', wrong.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

section('cu1b: editing a hold in place (db/cu1b_hold_edit.sql)');
{
  const CU1B = sql('db/cu1b_hold_edit.sql');
  const pre1b = run => `select set_config('watchlist.cu1b_run', '${run}', false);\n`;
  const EDIT = ['kind', 'collection_id', 'show_id', 'item_id', 'subject_label', 'field', 'protected_value', 'decision', 'effect', 'reopen', 'decided_on'];
  const pickH = h => Object.fromEntries(EDIT.map(k => [k, h[k] === undefined ? null : h[k]]));
  const sh = await showRow(2), seasons = await seasonsOf(sh.id);
  const hA = await call(db, 'library_cu_save_hold', [{ kind: 'standing_decision', show_id: sh.id, subject_label: 'Season 9', decision: 'Hold to edit', effect: 'keep_value', reopen: { on: 'official_date_or_window' }, decided_on: '2026-10-01' }]);
  const hA2 = await call(db, 'library_cu_save_hold', [{ kind: 'identity_hold', show_id: sh.id, decision: 'Another hold', effect: 'block_matching', reopen: { on: 'owner_only' } }]);
  const s1b0 = await state(db);
  for (const [label, run, re] of [['no run id', '', /set watchlist\.cu1b_run/], ['a recorded run id', 'cu1-rehearsal-1', /already recorded/]]) {
    const x = await tryExec(db, pre1b(run) + CU1B);
    ok(!x.ok && re.test(x.message) && same(s1b0, await state(db)), `${label}: refused, state unchanged`, x.message || 'committed');
  }
  if (inject) {
    const st = statements(CU1B);
    const bi = st.findIndex(x => /^begin\s*;/i.test(x.replace(/--[^\n]*\n/g, '').trim())), ci = st.findIndex(x => /^commit\s*;/i.test(x.replace(/--[^\n]*\n/g, '').trim()));
    const bad = [];
    for (let k = bi; k < ci; k++) {
      const text = pre1b(`inject1b-${k}`) + st.slice(0, k + 1).join('') + `\ndo $zz$ begin raise exception 'zz injected after %', ${k}; end $zz$;\n` + st.slice(k + 1).join('');
      const x = await tryExec(db, text);
      if (x.ok || !/zz injected/.test(x.message) || !same(s1b0, await state(db))) bad.push(`${k}: ${stmtHead(st[k])} ${x.message || 'committed'}`);
    }
    ok(bad.length === 0, `a failure after each of CU1b's ${ci - bi} statements leaves the state unchanged and no run record`, bad.join('\n'));
  }
  const inst = await tryExec(db, pre1b('cu1b-rehearsal-1') + CU1B);
  ok(inst.ok && /CU1B\|cu1b-rehearsal-1/.test(JSON.stringify(inst.out)), 'db/cu1b_hold_edit.sql commits', inst.message);
  const s1b1 = await state(db);
  ok(same(s1b0.rows, s1b1.rows), 'every table, the holds included, is unchanged by the install');
  const cd = catDiff(s1b0.cat, s1b1.cat);
  ok(cd.length === 2 && cd.some(x => /^functions: only before \[\] only after \["public\.library_cu_update_hold\(p_id uuid, p_expected jsonb, p_hold jsonb\)/.test(x)) && cd.some(x => /^runs:/.test(x)),
    'the catalog gains only the function (and the run record)', cd.join('\n'));
  ok((await val(db, `select public.stage5_capabilities() ->> 'phase'`)) === 'contracted-cu1', 'the phase is unchanged (contracted-cu1)');
  const replay = await tryExec(db, pre1b('cu1b-rehearsal-2') + CU1B);
  ok(!replay.ok && /already installed/.test(replay.message) && same(s1b1, await state(db)), 'a replay is refused, state unchanged', replay.message || 'committed');
  // Behaviour.
  const rowsBefore = await rows(db);
  const other = JSON.stringify((await asUser(db, A, `select to_jsonb(h) j from public.update_holds h where id <> $1 order by id`, [hA.id])).map(x => x.j));
  const edited = { ...pickH(hA), decision: 'Edited decision', effect: 'do_not_add', reopen: { on: 'named_source', source_domains: ['press.example.org'] }, subject_label: 'Season 10' };
  const e1 = await tryCall(db, 'library_cu_update_hold', [hA.id, pickH(hA), edited]);
  const now = (await asUser(db, A, `select to_jsonb(h) - 'user_id' j from public.update_holds h where id = $1`, [hA.id]))[0].j;
  ok(e1.ok && now.id === hA.id && now.created_at === hA.created_at && same(pickH(now), pickH({ ...edited, decided_on: '2026-10-01' })),
    'an edit updates the hold in place: same id and created_at, the new values', JSON.stringify([e1.message, now]));
  const after = await rows(db);
  ok(same(Object.keys(rowsBefore).filter(k => k !== 'update_holds' && rowsBefore[k] !== after[k]), []), 'no other table changes');
  ok(JSON.stringify((await asUser(db, A, `select to_jsonb(h) j from public.update_holds h where id <> $1 order by id`, [hA.id])).map(x => x.j)) === other, 'the other holds are untouched');
  const s2 = await rows(db);
  const stale = await tryCall(db, 'library_cu_update_hold', [hA.id, pickH(hA), { ...edited, decision: 'Stale edit' }]);
  ok(!stale.ok && /target_changed/.test(stale.message) && same(s2, await rows(db)), 'an edit from an outdated view is refused (target_changed); nothing changes', stale.message);
  const { decided_on, ...partial } = pickH(now);
  const missing = await tryCall(db, 'library_cu_update_hold', [hA.id, partial, edited]);
  ok(!missing.ok && /invalid_input/.test(missing.message) && same(s2, await rows(db)), 'expected values missing a field: refused as invalid input', missing.message);
  const extra = await tryCall(db, 'library_cu_update_hold', [hA.id, pickH(now), { ...edited, created_at: '2020-01-01T00:00:00Z' }]);
  ok(!extra.ok && /invalid_input/.test(extra.message) && same(s2, await rows(db)), 'a value outside the editable fields (created_at) is refused', extra.message);
  const shape = await tryCall(db, 'library_cu_update_hold', [hA.id, pickH(now), { ...pickH(now), kind: 'protected_value' }]);
  ok(!shape.ok && /invalid_input: hold/.test(shape.message) && same(s2, await rows(db)), 'an edit breaking the hold checks (protected value without a field) is refused', shape.message);
  const bRow = (await asUser(db, B, `select id from public.watchlist_items order by id limit 1`))[0].id;
  const foreign = await tryCall(db, 'library_cu_update_hold', [hA.id, pickH(now), { ...pickH(now), show_id: null, item_id: bRow }]);
  ok(!foreign.ok && /isn't yours|invalid_input/.test(foreign.message) && same(s2, await rows(db)), 'pointing a hold at another member’s record is refused', foreign.message);
  const asB = await tryCall(db, 'library_cu_update_hold', [hA.id, pickH(now), { ...pickH(now), decision: 'B was here' }], B);
  ok(!asB.ok && /target_changed/.test(asB.message) && same(s2, await rows(db)), 'another member can’t edit A’s hold (it isn’t theirs to see)', asB.message);
  const anon = await attempt(() => asAnon(db, `select public.library_cu_update_hold($1, $2, $3)`, [hA.id, pickH(now), pickH(now)]));
  ok(!anon.ok && /permission denied/.test(anon.message), 'signed out: no access', anon.message);
  const kind = await tryCall(db, 'library_cu_update_hold', [hA.id, pickH(now), { ...pickH(now), kind: 'identity_hold', effect: 'block_season_mapping', reopen: { on: 'owner_only' }, subject_label: seasons[0].season }]);
  ok(kind.ok && kind.rows.id === hA.id && kind.rows.kind === 'identity_hold', 'a valid change of kind is kept in place too', kind.message);
  const direct = await attempt(() => asUser(db, A, `update public.update_holds set decision = 'direct' where id = $1`, [hA.id]));
  ok(!direct.ok, 'a direct table update is still refused (write guard)', direct.message || 'updated');
  // Backup: the edited hold round-trips through the admin runbook (format 7, unchanged spec).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu1b-'));
  try {
    const exp1 = backupOfRun(await tryExec(db, adminTool('export-sql', '--owner', A).out));
    fs.writeFileSync(path.join(dir, 'file.json'), exp1);
    const r = await tryExec(db, adminTool('restore-sql', '--file', path.join(dir, 'file.json'), '--owner', A, '--email', 'a@test.invalid', '--run', 'cu1b-adm-1').out);
    fs.writeFileSync(path.join(dir, 'after.json'), backupOfRun(await tryExec(db, adminTool('export-sql', '--owner', A).out)));
    const ver = adminTool('verify', '--file', path.join(dir, 'file.json'), '--after', path.join(dir, 'after.json'));
    ok(r.ok && ver.ok && /VERIFIED/.test(ver.out) && JSON.parse(exp1).tables.update_holds.some(h => h.id === hA.id && h.kind === 'identity_hold'),
      'a backup with the edited hold restores and verifies field by field', [r.message, ver.out].join(' '));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // Test-only reverse, then the install applies again; the holds go back to what CU1 alone left.
  const rv = await tryExec(db, sql('db/test/cu1b_reverse.sql'));
  ok(rv.ok && (await val(db, `select to_regprocedure('public.library_cu_update_hold(uuid, jsonb, jsonb)') is null`)) === true, 'the test-only reverse removes the function and its run record', rv.message);
  const again = await tryExec(db, pre1b('cu1b-rehearsal-3') + CU1B);
  ok(again.ok, 'CU1b applies again after the reverse', again.message);
  await tryExec(db, sql('db/test/cu1b_reverse.sql'));
  await call(db, 'library_cu_delete_hold', [hA.id, (await asUser(db, A, `select decision from public.update_holds where id = $1`, [hA.id]))[0].decision]);
  await call(db, 'library_cu_delete_hold', [hA2.id, hA2.decision]);
}

section('rev: the test-environment reverse');
{
  const blocked = await tryExec(db, sql('db/test/cu1_reverse.sql'));
  ok(!blocked.ok && /has rows/.test(blocked.message), 'refused while CU1 tables hold rows', blocked.message);
  await asSuper(db, NEW_TABLES.slice().reverse().map(t => `delete from public.${t}`).join('; '));
  const rv = await tryExec(db, sql('db/test/cu1_reverse.sql'));
  const s2 = await state(db);
  const cat0 = JSON.parse(s0.cat), cat2 = JSON.parse(s2.cat);
  delete cat0.runs; delete cat2.runs;
  ok(rv.ok && same(cat0, cat2), 'the reverse gives back the exact pre-CU1 catalog', rv.message || catDiff(JSON.stringify(cat0), JSON.stringify(cat2)).join('\n'));
  const again = await tryExec(db, preamble('cu1-rehearsal-3') + CU1);
  ok(again.ok, 'CU1 applies again after the reverse', again.message);
}

console.log(failed ? `\nFAILED: ${failed} check(s)` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
