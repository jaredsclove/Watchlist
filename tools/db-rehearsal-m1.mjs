// Local rehearsal of M1 owner-only access (db/m1_access.sql) on a PGlite contracted-b45 replica
// holding a real format-5 backup (restored with the page's own restore_backup):
//   pre   refusals before anything changes: no run id, no owner, unknown Auth user, an owner
//         who already owns rows; each leaves the whole state unchanged;
//   fail  failure injection after every statement of db/m1_access.sql: the state is unchanged;
//   M     the migration: every row (every column but user_id) and the archive preserved; every
//         owned row belongs to the owner; the catalog shape changes only as intended; a replay
//         is refused;
//   anon  no read, write or function call succeeds (tables, views, the archive, functions);
//   iso   a second member (B, with the same library under new ids) and a non-member (C):
//         reads, inserts, updates, deletes, forged owners, cross-owner links and functions
//         against the other library's ids; restore isolation both ways; B4/B5 self-checks as A;
//   adm   the admin restore runbook (tools/admin-restore.mjs): the SQL export as a member validates;
//         check refuses an invalid file and an identity-stripping file (no override); the restore
//         SQL refuses a wrong destination; a restore as A leaves B unchanged and verifies;
//   rev   test-environment reverse (db/test/m1_reverse.sql) gives back the exact pre-M1 state.
// Nothing here touches Supabase. PGlite is one session: lock waits, two concurrent runs and the
// run label in pg_stat_activity need real connections (tools/db-rehearsal-m1-pg.sh).
//   PGLITE_DIR=/path/with/node_modules node tools/db-rehearsal-m1.mjs --backup <format5.json> [--no-inject]
// Output: pass/fail, counts and statement positions only; never record contents.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { createRequire } from 'module';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const backupFile = opt('--backup');
if (!backupFile || !process.env.PGLITE_DIR) {
  console.error('usage: PGLITE_DIR=… node tools/db-rehearsal-m1.mjs --backup <format5.json> [--no-inject]');
  process.exit(2);
}
const inject = !argv.includes('--no-inject');
const req = createRequire(path.join(process.env.PGLITE_DIR, 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));
const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const backupText = fs.readFileSync(backupFile);
const backupSha = sha(backupText);
const doc = JSON.parse(backupText);
if (doc.formatVersion !== 5) { console.error('--backup must be format 5'); process.exit(2); }

let failed = 0;
const ok = (cond, label, detail = '') => { if (!cond) failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${String(detail).slice(0, 1500)}` : ''}`); return cond; };
const section = t => console.log(`\n[${t}]`);

// ── The page's own backup code (validation) ──
const page = { console, Map, Set, JSON, Date, Math, Array, Object, String, Number, Boolean, RegExp, Error, Promise, parseInt, isFinite,
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} }, window: {}, localStorage: { getItem: () => null, setItem() {} },
  crypto: crypto.webcrypto, TextEncoder };
page.window = page;
vm.createContext(page);
for (const f of ['config.js', 'ui-helpers.js', 'metadata.js', 'api.js', 'backup-restore.js', 'backup-format3.js']) vm.runInContext(sql(f), page, { filename: f });
const P = expr => vm.runInContext(expr, page);
const validate = d => Array.from(P('validateBackupObject')(d));

// ── Replica ──
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
  // The real library, as the pre-M1 page restores it (anon, bootstrap owner).
  await asAnon(db, `select public.restore_backup($1::jsonb, false)`, [doc]);
  // Synthetic recovery-archive rows for the bootstrap owner (production's archive is not in a backup):
  // one record entry per show and item, one collection entry per personal collection, one meta row.
  await db.exec(`begin; select set_config('watchlist.library_write', 'on', true);
    insert into private.stage5_recovery_records (user_id, kind, id, collection)
      select user_id, 'show', id, 'synthetic' from public.tv_shows union all select user_id, 'item', id, 'synthetic' from public.watchlist_items;
    insert into private.stage5_recovery_collections (user_id, id, legacy_source) select user_id, id, null from public.personal_collections;
    insert into private.stage5_recovery_meta (user_id, origin, counts, hashes)
      select bootstrap_owner_id, 'contraction', '{}'::jsonb, '{}'::jsonb from private.app_owner;
    commit;`);
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

// ── Snapshots ──
const OWNED = [['public', 'watchlist_items'], ['public', 'tv_shows'], ['public', 'custom_collections'], ['public', 'personal_collections'],
  ['public', 'collection_memberships'], ['public', 'watch_with_choices'], ['public', 'catalog_show_links'], ['public', 'catalog_film_links'],
  ['private', 'stage5_recovery_records'], ['private', 'stage5_recovery_collections'], ['private', 'stage5_recovery_othertv'], ['private', 'stage5_recovery_meta']];
async function rows(db, withOwner = true) {
  const out = {};
  for (const [s, t] of OWNED) {
    out[`${s}.${t}`] = await val(db, `select md5(coalesce(string_agg(x, '|' order by x), '')) from (select (to_jsonb(r)${withOwner ? '' : " - 'user_id'"})::text x from ${s}.${t} r) q`);
  }
  return out;
}
// An ACL as a sorted list of grantee:privilege (grant order and grantor differences don't matter).
const ACL = (col, dflt) => `coalesce((select string_agg(case when e.grantee = 0 then 'PUBLIC' else pg_get_userbyid(e.grantee) end || ':' || e.privilege_type, ',' order by 1)
  from aclexplode(coalesce(${col}, ${dflt})) e), '')`;
const CAT = `select json_build_object(
  'constraints', (select json_agg(x order by x) from (select conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid) x
    from pg_constraint where connamespace in ('public'::regnamespace, 'private'::regnamespace) and contype <> 'n') s),
  'columns', (select json_agg(x order by x) from (select table_schema || '.' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' ||
    coalesce(column_default, '') x from information_schema.columns where table_schema in ('public', 'private')) s),
  'acl', (select json_agg(x order by x) from (select c.oid::regclass::text || ' ' || ${ACL("c.relacl", "acldefault('r', c.relowner)")} || ' ' || c.relrowsecurity::text x
    from pg_class c where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'v', 'S')) s),
  'col_acl', (select json_agg(x order by x) from (select a.attrelid::regclass::text || '.' || a.attname || ' ' || ${ACL('a.attacl', 'null')} x
    from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and a.attacl is not null) s),
  'functions', (select json_agg(x order by x) from (select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' ||
    md5(pg_get_functiondef(p.oid)) || ' ' || ${ACL('p.proacl', "acldefault('f', p.proowner)")} x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')) s),
  'triggers', (select json_agg(x order by x) from (select pg_get_triggerdef(oid) x from pg_trigger where not tgisinternal) s),
  'policies', (select json_agg(x order by x) from (select schemaname || '.' || tablename || '.' || policyname || ' ' || cmd || ' ' || permissive || ' ' || roles::text || ' ' ||
    coalesce(qual, '') || ' ' || coalesce(with_check, '') x from pg_policies where schemaname in ('public', 'private')) s),
  'schemas', (select json_agg(x order by x) from (select nspname || ' ' || ${ACL('nspacl', "acldefault('n', nspowner)")} x from pg_namespace where nspname in ('public', 'private')) s),
  'defaults', (select json_agg(x order by x) from (select pg_get_userbyid(defaclrole) || ' ' || coalesce(defaclnamespace::regnamespace::text, '-') || ' ' || defaclobjtype::text || ' ' || ${ACL('defaclacl', 'null')} x from pg_default_acl) s),
  'tables', (select json_agg(x order by x) from (select schemaname || '.' || tablename x from pg_tables where schemaname in ('public', 'private')) s),
  'owner', (select json_agg(bootstrap_owner_id) from private.app_owner)
)::text c`;
async function state(db) { return { rows: await rows(db), cat: await val(db, CAT) }; }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const catDiff = (a, b) => { a = JSON.parse(a); b = JSON.parse(b); return Object.keys({ ...a, ...b }).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
  .map(k => `${k}: only before ${JSON.stringify((a[k] || []).filter(x => !(b[k] || []).includes(x)).slice(0, 4))} only after ${JSON.stringify((b[k] || []).filter(x => !(a[k] || []).includes(x)).slice(0, 4))}`); };

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
const preamble = (owner, run) => `select set_config('watchlist.m1_owner', '${owner}', false), set_config('watchlist.m1_run', '${run}', false);\n`;
const M1 = sql('db/m1_access.sql');

// ═══ The rehearsal ═══
section('replica');
ok(validate(doc).length === 0, 'the backup validates with the page’s rules', validate(doc).join('\n'));
const db = await replica();
ok((await val(db, `select public.stage5_capabilities() ->> 'phase'`)) === 'contracted-b45', 'the replica is contracted-b45');
const counts0 = Object.fromEntries(Object.entries(doc.tables).map(([t, r]) => [t, r.length]));
const counts1 = {};
for (const t of Object.keys(doc.tables)) counts1[t] = Number(await val(db, `select count(*) from public.${t}`));
ok(same(counts0, counts1), 'the replica holds the backup’s row counts', JSON.stringify({ counts0, counts1 }));
const s0 = await state(db);
const content0 = await rows(db, false);

section('pre: refusals change nothing');
for (const [label, pre, re] of [
  ['no run id', `select set_config('watchlist.m1_owner', '${A}', false), set_config('watchlist.m1_run', '', false);`, /set watchlist\.m1_run/],
  ['no owner', `select set_config('watchlist.m1_owner', '', false), set_config('watchlist.m1_run', 'rehearsal-1', false);`, /set watchlist\.m1_owner/],
  ['an unknown Auth user', preamble('00000000-0000-4000-8000-0000000000ff', 'rehearsal-1'), /no Auth user/],
]) {
  const x = await tryExec(db, pre + M1);
  ok(!x.ok && re.test(x.message) && same(s0, await state(db)), `${label}: refused, state unchanged`, x.message || 'committed');
}

if (inject) {
  section('fail: a failure after every statement leaves the state unchanged');
  const st = statements(M1);
  const bi = st.findIndex(s => /^begin\s*;/i.test(s.replace(/--[^\n]*\n/g, '').trim())), ci = st.findIndex(s => /^commit\s*;/i.test(s.replace(/--[^\n]*\n/g, '').trim()));
  const bad = [];
  for (let k = bi; k < ci; k++) {
    const text = preamble(A, `inject-${k}`) + st.slice(0, k + 1).join('') + `\ndo $zz$ begin raise exception 'zz injected after %', ${k}; end $zz$;\n` + st.slice(k + 1).join('');
    const x = await tryExec(db, text);
    if (x.ok || !/zz injected/.test(x.message) || !same(s0, await state(db))) bad.push(`${k}: ${stmtHead(st[k])} ${x.message || 'committed'}`);
  }
  ok(bad.length === 0, `a failure after each of its ${ci - bi} statements leaves the state unchanged`, bad.join('\n'));
}

section('M: the migration');
const run = await tryExec(db, preamble(A, 'rehearsal-1') + M1);
if (!ok(run.ok, 'db/m1_access.sql commits', run.message)) { console.log('\nFAILED: the migration did not commit; stopping'); process.exit(1); }
if (run.ok) {
  const res = run.out.map(r => r.rows && r.rows[0] && r.rows[0].result).find(Boolean);
  console.log(`       ${String(res).replace(/"owner":"[^"]+"/, '"owner":"A"').slice(0, 600)}`);
}
ok(same(content0, await rows(db, false)), 'every owned table’s content (every column but user_id) is unchanged, the archive included');
let notA = 0;
for (const [s, t] of OWNED) notA += Number(await val(db, `select count(*) from ${s}.${t} where user_id <> '${A}'`));
ok(notA === 0, 'every owned row belongs to A');
ok((await val(db, `select public.stage5_capabilities() ->> 'access'`)) === 'members', 'the capability says access = members');
ok((await val(db, `select public.stage5_capabilities() ->> 'phase'`)) === 'contracted-b45', 'the phase string is unchanged');
ok(Number(await val(db, `select count(*) from private.library_members`)) === 1, 'one member (A)');
const s1 = await state(db);
const aPub0 = await rowsFor(db, A);
const cat0 = JSON.parse(s0.cat), cat1 = JSON.parse(s1.cat);
const onlyAfter = k => (cat1[k] || []).filter(x => !(cat0[k] || []).includes(x));
const onlyBefore = k => (cat0[k] || []).filter(x => !(cat1[k] || []).includes(x));
ok(JSON.stringify(onlyBefore('columns')) === '[]' && JSON.stringify(onlyAfter('columns').map(x => x.split(' ')[0])) === JSON.stringify(['private.library_members.added_at', 'private.library_members.note', 'private.library_members.user_id']),
  'columns: only private.library_members added', JSON.stringify({ before: onlyBefore('columns'), after: onlyAfter('columns') }));
ok(same(cat0.triggers, cat1.triggers), 'triggers unchanged');
ok(JSON.stringify(onlyAfter('tables')) === '["private.library_members"]' && onlyBefore('tables').length === 0, 'tables: only private.library_members added');
ok(onlyBefore('constraints').length === 0 && onlyAfter('constraints').every(x => /(_user_id_auth_fkey FOREIGN KEY \(user_id\) REFERENCES auth\.users\(id\) ON DELETE RESTRICT|^private\.library_members\.)/.test(x)),
  'constraints: the exact catalog-link FKs kept; only the user_id → auth.users FKs and the membership table’s added', JSON.stringify(onlyAfter('constraints').filter(x => !/_user_id_auth_fkey|library_members/.test(x))));
const replay = await tryExec(db, preamble(A, 'rehearsal-2') + M1);
ok(!replay.ok && /already applied/.test(replay.message) && same(s1, await state(db)), 'a replay is refused, state unchanged', replay.message || 'committed');

section('anon: nothing');
const anonChecks = [
  ['read watchlist_items', `select count(*) from public.watchlist_items`],
  ['read a view', `select count(*) from public.library_catalog_shows`],
  ['read the archive', `select count(*) from private.stage5_recovery_records`],
  ['insert a custom collection', `insert into public.custom_collections (name) values ('x')`],
  ['update tv_shows', `update public.tv_shows set title = title`],
  ['delete memberships', `delete from public.collection_memberships`],
  ['stage5_capabilities()', `select public.stage5_capabilities()`],
  ['org_capabilities()', `select public.org_capabilities()`],
  ['restore_backup()', `select public.restore_backup($1::jsonb, false)`, [doc]],
  ['org_create_collection()', `select public.org_create_collection(gen_random_uuid(), 'x')`],
  ['a private helper', `select private.current_owner_id()`],
];
for (const [label, s, p] of anonChecks) {
  const x = await attempt(() => asAnon(db, s, p));
  ok(!x.ok && /permission denied/.test(x.message), `anon: ${label} → permission denied`, x.ok ? 'succeeded' : x.message);
}
ok(same(s1, await state(db)), 'state unchanged by the anon attempts');

section('iso: a second member and a non-member');
// B: the same library under new ids (local only), restored by B through the page's restore.
const idMap = new Map();
const remap = v => { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return v; if (!idMap.has(v)) idMap.set(v, crypto.randomUUID()); return idMap.get(v); };
const docB = JSON.parse(JSON.stringify(doc), (k, v) => (typeof v === 'string' ? remap(v) : v));
ok(validate(docB).length === 0, 'B’s remapped library validates');
const nonMember = await attempt(() => asUser(db, B, `select public.restore_backup($1::jsonb, false)`, [docB]));
ok(!nonMember.ok && /not_a_member/.test(nonMember.message), 'B before membership: restore refused (not_a_member)', nonMember.message || 'succeeded');
await db.exec(`insert into private.library_members (user_id, note) values ('${B}', 'rehearsal B')`);
const rb = await attempt(() => asUser(db, B, `select public.restore_backup($1::jsonb, false) r`, [docB]));
ok(rb.ok, 'B restores B’s library', rb.message);
ok(same(aPub0, await rowsFor(db, A)), 'A’s library is unchanged by B’s restore');
const bPub0 = await rowsFor(db, B);
const aIds = { item: await val(db, `select id::text from public.watchlist_items where user_id = '${A}' and is_film limit 1`),
  show: await val(db, `select id::text from public.tv_shows where user_id = '${A}' limit 1`),
  coll: await val(db, `select id::text from public.personal_collections where user_id = '${A}' limit 1`),
  choice: await val(db, `select id::text from public.watch_with_choices where user_id = '${A}' limit 1`) };
const bShow = await val(db, `select id::text from public.tv_shows where user_id = '${B}' limit 1`);
const bColl = await val(db, `select id::text from public.personal_collections where user_id = '${B}' limit 1`);
const sAB = await state(db);
for (const [s, t] of OWNED) {
  const seenA = await asUser(db, A, `select count(*)::int n, count(*) filter (where user_id <> '${A}')::int other from ${s}.${t}`);
  const seenB = await asUser(db, B, `select count(*)::int n, count(*) filter (where user_id <> '${B}')::int other from ${s}.${t}`);
  const seenC = await asUser(db, C, `select count(*)::int n from ${s}.${t}`);
  ok(seenA[0].other === 0 && seenB[0].other === 0 && seenC[0].n === 0 && (s === 'private' || seenA[0].n > 0 || counts0[t] === 0),
    `${s}.${t}: A sees only A’s rows, B only B’s, C none`, JSON.stringify({ A: seenA[0], B: seenB[0], C: seenC[0] }));
}
for (const v of ['library_catalog_shows', 'library_catalog_films', 'library_collection_catalogs', 'library_collection_presentation', 'library_film_theme_kinds']) {
  const bSeesA = await asUser(db, B, `select count(*)::int n from public.${v} x where x.id = any($1::uuid[])`, [[aIds.item, aIds.show, aIds.coll].filter(Boolean)]);
  ok(bSeesA[0].n === 0, `view ${v}: B sees none of A’s ids`);
}
const crossWrites = [
  ['update A’s show', `update public.tv_shows set title = 'x' where id = $1 returning id`, [aIds.show], 'rows0'],
  ['delete A’s film', `delete from public.watchlist_items where id = $1 returning id`, [aIds.item], 'rows0'],
  ['rename A’s watch-with choice', `update public.watch_with_choices set label = 'x' where id = $1 returning id`, [aIds.choice], 'rows0'],
  ['delete A’s collection', `delete from public.personal_collections where id = $1 returning id`, [aIds.coll], 'rows0'],
  ['insert with A as owner', `insert into public.custom_collections (name, user_id) values ('x', '${A}')`, [], 'denied'],
  ['move B’s show to A', `update public.tv_shows set user_id = '${A}' where id = $1`, [bShow], 'denied'],
  ['link A’s show into B’s collection', `select public.org_add_membership($1::uuid, $2::uuid, null)`, [bColl, aIds.show], 'refused'],
  ['add A’s film to B’s collection', `select public.org_add_membership($1::uuid, null, $2::uuid)`, [bColl, aIds.item], 'refused'],
  ['rename A’s collection', `select public.org_rename_collection($1::uuid, null, 'x')`, [aIds.coll], 'refused'],
  ['archive A’s collection', `select public.org_set_collection_archived($1::uuid, true)`, [aIds.coll], 'refused'],
  ['set A’s film state', `select public.library_set_film_state_b45($1::uuid, '{}'::jsonb, '{"priority":"high"}'::jsonb)`, [aIds.item], 'refused'],
  ['set A’s show state', `select public.library_set_show_state_b45($1::uuid, '{}'::jsonb, '{"priority":"high"}'::jsonb)`, [aIds.show], 'refused'],
  ['delete A’s season', `select public.delete_tv_season($1::uuid)`, [await val(db, `select id::text from public.watchlist_items where user_id = '${A}' and not is_film limit 1`)], 'refused'],
  ['restore A’s original file over B', `select public.restore_backup($1::jsonb, false)`, [doc], 'refused'],
];
for (const [label, s, p, expect] of crossWrites) {
  const x = await attempt(() => asUser(db, B, s, p));
  const pass = expect === 'rows0' ? (x.ok && x.rows.length === 0) : expect === 'denied' ? (!x.ok && /permission denied|row-level security/.test(x.message)) : !x.ok || (x.rows[0] && JSON.stringify(x.rows[0]).match(/"ok":\s*false|refus|not found|missing/i));
  ok(pass, `B: ${label} → ${expect}`, x.ok ? JSON.stringify(x.rows).slice(0, 300) : x.message);
}
ok(same(sAB, await state(db)), 'both libraries unchanged by B’s cross-owner attempts');
const nm = await attempt(() => asUser(db, C, `select public.org_create_collection(gen_random_uuid(), 'x')`));
ok(!nm.ok && /not_a_member/.test(nm.message), 'C (no membership): a write function is refused', nm.message || 'succeeded');
const nmi = await attempt(() => asUser(db, C, `insert into public.watch_with_choices (token, label) values ('x', 'x')`));
ok(!nmi.ok, 'C: a direct insert is refused', nmi.message || 'succeeded');
const ra = await attempt(() => asUser(db, A, `select public.restore_backup($1::jsonb, false) r`, [doc]));
ok(ra.ok, 'A restores A’s file (as a member)', ra.message);
ok(same(aPub0, await rowsFor(db, A)), 'A’s content equals the backup after A’s restore');
ok(same(bPub0, await rowsFor(db, B)), 'B’s library is unchanged by A’s restore');
const archA = Number(await val(db, `select count(*) from private.stage5_recovery_records where user_id = '${A}'`));
const archB = Number(await val(db, `select count(*) from private.stage5_recovery_records where user_id = '${B}'`));
ok(archA > 0 && archB === 0, 'the archive: A’s rows kept by A’s restore (no recovery section), none for B');
const tb45 = await attempt(() => db.transaction(async tx => {
  await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A, role: 'authenticated' })]);
  return tx.exec(sql('db/test/_prelude.sql') + sql('db/test/t_b45.sql'));
}));
ok(tb45.ok, 'db/test/t_b45.sql (as postgres with A’s claims): its checks pass', tb45.message);

section('adm: the admin restore runbook');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1adm-'));
  const tool = (...args) => { try { return { ok: true, out: execFileSync(process.execPath, [path.join(ROOT, 'tools/admin-restore.mjs'), ...args], { encoding: 'utf8' }) }; }
    catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; } };
  const runSql = async text => { const r = await tryExec(db, text); return r; };
  const exportAs = async owner => {
    const r = await runSql(tool('export-sql', '--owner', owner).out);
    const row = r.ok && r.out.map(x => x.rows && x.rows[0] && x.rows[0].backup).find(Boolean);
    return row || null;
  };
  try {
    const safetyText = await exportAs(A);
    ok(!!safetyText, 'the export SQL runs read-only as A', '');
    fs.writeFileSync(path.join(dir, 'safety.json'), safetyText);
    const safety = JSON.parse(safetyText);
    ok(validate(safety).length === 0 && safety.tables.watchlist_items.length === counts0.watchlist_items, 'A’s exported safety backup validates with the page’s rules and holds A’s rows only', validate(safety).join('\n'));
    const bExport = JSON.parse(await exportAs(B));
    ok(bExport.tables.watchlist_items.every(r => !safety.tables.watchlist_items.some(x => x.id === r.id)), 'B’s export holds none of A’s rows');
    fs.writeFileSync(path.join(dir, 'file.json'), JSON.stringify(doc));
    const good = tool('check', '--file', path.join(dir, 'file.json'), '--safety', path.join(dir, 'safety.json'));
    ok(good.ok && /OK/.test(good.out), 'check: the backup file passes against the fresh safety backup', good.out);
    // A valid file whose TV seasons have lost their TMDB identity (the legacy shape: all three empty).
    const stripped = JSON.parse(JSON.stringify(doc));
    stripped.tables.watchlist_items.forEach(r => { if (r.media_type === 'tv') { r.media_type = null; r.tmdb_id = null; r.season_number = null; } });
    fs.writeFileSync(path.join(dir, 'stripped.json'), JSON.stringify(stripped));
    const loss = tool('check', '--file', path.join(dir, 'stripped.json'), '--safety', path.join(dir, 'safety.json'));
    ok(!loss.ok && /REFUSED[\s\S]*discard TMDB identity/.test(loss.out), 'check refuses a file that would strip identities (no override)', loss.out.slice(-600));
    fs.writeFileSync(path.join(dir, 'invalid.json'), JSON.stringify({ format: 'watchlist-tracker-backup', formatVersion: 5 }));
    const inv = tool('check', '--file', path.join(dir, 'invalid.json'), '--safety', path.join(dir, 'safety.json'));
    ok(!inv.ok && /REFUSED|doesn’t validate/.test(inv.out), 'check refuses an invalid file', inv.out.slice(0, 300));
    const sB = await rowsFor(db, B), sA = await rowsFor(db, A);
    const wrong = await runSql(tool('restore-sql', '--file', path.join(dir, 'file.json'), '--owner', A, '--email', 'b@test.invalid', '--run', 'adm-run-1').out);
    ok(!wrong.ok && /is not the account/.test(wrong.message) && same(sA, await rowsFor(db, A)), 'the restore SQL refuses a wrong destination; nothing changed', wrong.message);
    const right = await runSql(tool('restore-sql', '--file', path.join(dir, 'file.json'), '--owner', A, '--email', 'a@test.invalid', '--run', 'adm-run-2').out);
    ok(right.ok, 'the restore SQL restores as A', right.message);
    ok(same(sB, await rowsFor(db, B)), 'B’s library is unchanged by the admin restore');
    fs.writeFileSync(path.join(dir, 'after.json'), await exportAs(A));
    const ver = tool('verify', '--file', path.join(dir, 'file.json'), '--after', path.join(dir, 'after.json'));
    ok(ver.ok && /VERIFIED/.test(ver.out), 'verify: the export after the restore equals the file, field by field', ver.out);
    const badVer = tool('verify', '--file', path.join(dir, 'stripped.json'), '--after', path.join(dir, 'after.json'));
    ok(!badVer.ok && /DIFFERENT/.test(badVer.out), 'verify reports a difference');
    // Membership in the capability, and exports that never turn a non-member into an empty backup.
    const capOf = async who => (await asUser(db, who, `select public.stage5_capabilities() c`))[0].c;
    ok((await capOf(A)).member === true && (await capOf(B)).member === true && (await capOf(C)).member === false, 'the capability reports membership (A, B members; C not)');
    const cExport = await runSql(tool('export-sql', '--owner', C).out);
    ok(!cExport.ok && /is not a member now/.test(cExport.message), 'the member export refuses a non-member (no empty backup)', cExport.message || 'exported');
    // Removing member B: owner export filtered to B, then the guarded removal.
    const ownerExport = async who => { const r = await runSql(tool('export-owner-sql', '--user', who).out); return r.ok ? r.out.map(x => x.rows && x.rows[0] && x.rows[0].backup).find(Boolean) : null; };
    const bText = await ownerExport(B);
    ok(!!bText, 'the owner export runs read-only as postgres');
    fs.writeFileSync(path.join(dir, 'b-owner.json'), bText);
    const bDoc = JSON.parse(bText);
    const aIdsAll = new Set(Object.values(JSON.parse(await ownerExport(A)).tables).flat().map(r => r.id));
    const bCounts = {};
    for (const t of Object.keys(bDoc.tables)) bCounts[t] = Number(await val(db, `select count(*) from public.${t} where user_id = $1`, [B]));
    ok(validate(bDoc).length === 0 && Object.values(bDoc.tables).flat().every(r => !aIdsAll.has(r.id)) && same(bCounts, bDoc.rowCounts) && bDoc.tables.watchlist_items.length > 0,
      'the owner export holds exactly B’s rows (none of A’s), with B’s counts', validate(bDoc).join('; '));
    const stillMember = await runSql(tool('remove-sql', '--user', B, '--file', path.join(dir, 'b-owner.json')).out);
    ok(!stillMember.ok && /still a member/.test(stillMember.message), 'removal refuses while B is a member', stillMember.message || 'removed');
    await db.exec(`delete from private.library_members where user_id = '${B}'`);
    const stale = JSON.parse(bText); stale.tables.custom_collections = stale.tables.custom_collections.slice(1); stale.rowCounts.custom_collections = stale.tables.custom_collections.length;
    fs.writeFileSync(path.join(dir, 'b-stale.json'), JSON.stringify(stale));
    const staleRun = await runSql(tool('remove-sql', '--user', B, '--file', path.join(dir, 'b-stale.json')).out);
    ok(!staleRun.ok && /no longer matches the export/.test(staleRun.message), 'removal refuses when the library no longer matches the export', staleRun.message || 'removed');
    const aBefore = await rowsFor(db, A);
    const removed = await runSql(tool('remove-sql', '--user', B, '--file', path.join(dir, 'b-owner.json')).out);
    let bLeft = 0; for (const [sc, t] of OWNED) bLeft += Number(await val(db, `select count(*) from ${sc}.${t} where user_id = $1`, [B]));
    ok(removed.ok && bLeft === 0 && same(aBefore, await rowsFor(db, A)), 'removal deletes only B’s rows; A unchanged', removed.message);
    await db.exec(`insert into private.library_members (user_id, note) values ('${B}', 'rehearsal B')`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

section('rev: test-environment reverse');
if (fs.existsSync(path.join(ROOT, 'db/test/m1_reverse.sql'))) {
  const R = await replica();
  const unmarked = await tryExec(R, `select set_config('watchlist.m1_snapshot', '{"bootstrap":"x"}', false);\n` + sql('db/test/m1_reverse.sql'));
  ok(!unmarked.ok && /not a marked test environment/.test(unmarked.message), 'the reverse refuses an unmarked database', unmarked.message || 'committed');
  await R.exec(`select set_config('watchlist.test_project', 'local', false);\n` + sql('db/test/m1_test_marker.sql'));
  const snap = await val(R, sql('db/test/m1_snapshot.sql').replace(/;\s*$/, ''));
  const r0 = await state(R);
  const a = await tryExec(R, preamble(A, 'rev-run-1') + M1);
  await R.query(`select set_config('watchlist.m1_snapshot', $1, false)`, [JSON.stringify(snap)]);
  const b = a.ok && await tryExec(R, sql('db/test/m1_reverse.sql'));
  const r1 = await state(R);
  ok(a.ok && b && b.ok && same(r0, r1), 'M1 then the reverse gives back the exact pre-M1 state (rows with owners, catalog, ACLs, policies, defaults)',
    (a.message || (b && b.message) || '') + '\n' + catDiff(r0.cat, r1.cat).join('\n'));
  const c = await tryExec(R, preamble(A, 'rev-run-2') + M1);
  ok(c.ok, 'M1 applies again after the reverse', c.message);
} else ok(false, 'db/test/m1_reverse.sql exists');

section('inputs unchanged');
ok(sha(fs.readFileSync(backupFile)) === backupSha, 'the backup file is unchanged');
console.log(`\n${failed ? `FAILED: ${failed}` : 'all rehearsal checks passed'}`);
process.exitCode = failed ? 1 : 0;

async function rowsFor(d, owner) {
  const out = {};
  for (const [s, t] of OWNED) {
    if (s === 'private') continue;
    out[`${s}.${t}`] = await val(d, `select md5(coalesce(string_agg(x, '|' order by x), '')) from (select (to_jsonb(r) - 'user_id')::text x from ${s}.${t} r where user_id = $1) q`, [owner]);
  }
  return out;
}
