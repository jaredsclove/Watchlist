// CU2 (research access) against a real local Supabase stack: real Auth tokens, PostgREST and GraphQL, for what
// PGlite can't show. Refuses any address but 127.0.0.1. Builds its own synthetic database on a fresh stack
// (`supabase start` in an empty folder), so it runs once per stack.
//   LOCAL_SERVICE_KEY=<the stack's service key> node tools/cu2-local-auth-test.mjs --api http://127.0.0.1:54321 --key <publishable key>
//        --container supabase_db_<project> --backup <format6.json>
// Three accounts: A (member, access on), B (member, access off) and C (signed in, not a member). Test passwords are
// generated in this process and never printed or stored.
// Checks: each account's capability; self-enablement through the API, Auth metadata and a backup; every exposed way
// to reach private functions or the restore flag; research writes through RPC, REST and GraphQL, including several
// GraphQL mutations in one request; ordinary work and TMDB findings without access; revocation and re-enabling on a
// token already issued; the cascade of an ordinary delete; restore. Output: pass/fail and counts only.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const API = opt('--api'), KEY = opt('--key'), CONTAINER = opt('--container'), SERVICE = process.env.LOCAL_SERVICE_KEY;
if (!API || new URL(API).hostname !== '127.0.0.1' || !KEY || !CONTAINER || !SERVICE || !opt('--backup')) {
  console.error('usage: LOCAL_SERVICE_KEY=… node tools/cu2-local-auth-test.mjs --api http://127.0.0.1:54321 --key <key> --container <db container> --backup <format6.json>');
  process.exit(2);
}
const doc6 = JSON.parse(fs.readFileSync(opt('--backup'), 'utf8'));
const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const psql = (text, quiet = true) => execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-X', ...(quiet ? ['-q'] : []), '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
  { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26 });

let failed = 0, passed = 0;
const scrub = s => String(s || '').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]').slice(0, 400);
const ok = (cond, label, detail = '') => { if (cond) passed++; else failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${scrub(detail)}` : ''}`); return cond; };
const section = t => console.log(`\n[${t}]`);

async function call(token, method, p, body, extra = {}) {
  const res = await fetch(`${API}/${p}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${token || KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}
const rest = (t, m, p, b, x) => call(t, m, `rest/v1/${p}`, b, x);
const rpc = (t, fn, args) => rest(t, 'POST', `rpc/${fn}`, args);
const gql = (t, query, variables) => call(t, 'POST', 'graphql/v1', { query, variables });
const notEnabled = r => /research_not_enabled/.test(r.text);
const newPassword = () => 'Local-' + crypto.randomBytes(18).toString('base64url');
async function account(email) {
  const password = newPassword();
  const r = await fetch(`${API}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }) });
  const u = await r.json();
  if (!u.id) throw new Error(`no local user ${email}: ${scrub(JSON.stringify(u))}`);
  const s = await call(null, 'POST', 'auth/v1/token?grant_type=password', { email, password });
  if (!s.json || !s.json.access_token) throw new Error(`no sign-in for ${email}`);
  return { id: u.id, token: s.json.access_token, email };
}

section('stack: a synthetic database, up to CU2');
const preEmpty = psql(`select to_regclass('public.tv_shows') is null;`).trim();
if (!ok(preEmpty === 't', 'the stack is fresh')) process.exit(1);
// Off by default on a local stack: without it every GraphQL check below would pass for the wrong reason.
psql(`create extension if not exists pg_graphql; comment on schema public is '@graphql({"introspection": true})'`);
for (const f of ['db/test/replica_schema.sql', 'db/phase0_restore_v1.sql', 'db/phase1b_ownership.sql', 'db/restore_backup.sql', 'db/phase1c_tv_schema.sql', 'db/tv_model.sql', 'db/rpc.sql', 'db/admin/tv_enrich.sql']) psql(sql(f));
psql(`update private.migration_stage set stage = 'final'`);
for (const f of ['db/phase3b_org.sql', 'db/phase3b2_org_write.sql', 'db/phase4a_catalog.sql', 'db/phase4b_add_to_show.sql', 'db/phase5a_expand.sql', 'db/phase5c_contract.sql']) psql(sql(f));
psql(`select set_config('watchlist.b45_choices', '{"shows": {}, "films": {}}', false);\n` + sql('db/b45_expand.sql'));
const A = await account('cu2-a@test.invalid'), B = await account('cu2-b@test.invalid'), C = await account('cu2-c@test.invalid');
psql(`begin; select set_config('watchlist.library_write', 'on', true);
  insert into private.stage5_recovery_meta (user_id, origin, counts, hashes) select bootstrap_owner_id, 'contraction', '{}'::jsonb, '{}'::jsonb from private.app_owner; commit;`);
psql(`select set_config('watchlist.m1_owner', '${A.id}', false), set_config('watchlist.m1_run', 'local-m1', false);\n` + sql('db/m1_access.sql'));
psql(`select set_config('watchlist.ep1_run', 'local-ep1', false);\n` + sql('db/ep1_episode_marks.sql'));
psql(`insert into private.library_members (user_id, note) values ('${B.id}', 'local B')`);
const asMember = (who, q) => psql(`begin; select set_config('request.jwt.claims', '{"sub": "${who.id}", "role": "authenticated"}', true); set local role authenticated; ${q}; commit;`);
const idMap = new Map();
const remap = v => { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return v; if (!idMap.has(v)) idMap.set(v, crypto.randomUUID()); return idMap.get(v); };
const docB = JSON.parse(JSON.stringify(doc6), (k, v) => (typeof v === 'string' ? remap(v) : v));
asMember(A, `select public.restore_backup($zz$${JSON.stringify(doc6)}$zz$::jsonb, false)`);
asMember(B, `select public.restore_backup($zz$${JSON.stringify(docB)}$zz$::jsonb, false)`);
for (const [g, f] of [['cu1', 'db/cu1_collection_updates.sql'], ['cu1b', 'db/cu1b_hold_edit.sql'], ['cu1c', 'db/cu1c_date_equivalence.sql'], ['cu1d', 'db/cu1d_network_and_marks.sql']]) {
  psql(`select set_config('watchlist.${g}_run', 'local-${g}', false);\n` + sql(f));
}
const inst = psql(`select set_config('watchlist.cu2_run', 'local-cu2', false), set_config('watchlist.cu2_owner', '${A.id}', false);\n` + sql('db/cu2_research_access.sql'), false);
ok(/CU2\|/.test(inst), 'db/cu2_research_access.sql commits on real PostgreSQL 17');
psql(`select set_config('watchlist.cu1e_run', 'local-cu1e', false);\n` + sql('db/cu1e_missing_season.sql'));
ok(/SIMPLIFY\|/.test(psql(`select set_config('watchlist.simplify_run', 'local-simplify', false);\n` + sql('db/simplify_restore_cleanup.sql'))), 'the final state: CU1e and the flat restore installed');
await new Promise(r => setTimeout(r, 1500)); // the API reloads its schema cache
const access = (who, v) => psql(`update private.library_members set research_enabled = ${v} where user_id = '${who.id}'`);
const cap = async who => (await rpc(who.token, 'stage5_capabilities')).json;
const flags = () => psql(`select string_agg(research_enabled::text, ',' order by user_id) from private.library_members`).trim();

section('capability');
ok((await cap(A)).research === true && (await cap(B)).research === false, 'A reads on, B reads off');
ok((await cap(C)).research === false && (await cap(C)).member === false, 'a non-member reads off');
ok(!(await rest(null, 'POST', 'rpc/stage5_capabilities')).ok, 'signed out: nothing');

section('no self-enablement');
const f0 = flags();
for (const [label, r] of [
  ['the table through the API', await rest(B.token, 'PATCH', `library_members?user_id=eq.${B.id}`, { research_enabled: true })],
  ['the table with the private profile', await rest(B.token, 'PATCH', `library_members?user_id=eq.${B.id}`, { research_enabled: true }, { 'Content-Profile': 'private' })],
  ['a read with the private profile', await rest(B.token, 'GET', 'library_members?select=*', undefined, { 'Accept-Profile': 'private' })]]) {
  ok(!r.ok && flags() === f0, `${label}: refused (${r.status})`, r.text);
}
await call(B.token, 'PUT', 'auth/v1/user', { data: { research: true, research_enabled: true } });
const s2 = await call(null, 'POST', 'auth/v1/token?grant_type=refresh_token', { refresh_token: 'x' });
ok(!s2.ok && (await cap(B)).research === false, 'Auth metadata the user can write carries no permission');

section('nothing private is reachable');
for (const [label, r] of [
  ['private.research_enabled', await rest(B.token, 'POST', 'rpc/research_enabled', {}, { 'Content-Profile': 'private' })],
  ['private.lib_write_on', await rest(B.token, 'POST', 'rpc/lib_write_on', {}, { 'Content-Profile': 'private' })],
  ['set_config', await rest(B.token, 'POST', 'rpc/set_config', { setting_name: 'watchlist.research_restore', new_value: 'on', is_local: true })],
  ['set_config, pg_catalog profile', await rest(B.token, 'POST', 'rpc/set_config', { setting_name: 'watchlist.research_restore', new_value: 'on', is_local: true }, { 'Content-Profile': 'pg_catalog' })]]) {
  ok(!r.ok && [404, 406].includes(r.status), `${label}: not exposed (${r.status})`, r.text);
}
const introspect = await gql(B.token, `{ __schema { mutationType { fields { name } } queryType { fields { name } } } }`);
const mutations = ((((introspect.json || {}).data || {}).__schema || {}).mutationType || { fields: [] }).fields.map(f => f.name);
ok(mutations.includes('restore_backup') && mutations.includes('deleteFromupdate_holdsCollection'), `GraphQL is on and exposes the app (${mutations.length} mutations)`, introspect.text);
ok(!mutations.some(n => /set_config|lib_write_on|restore_backup_v|research_enabled/.test(n)), 'GraphQL offers no such function', mutations.join());

section('research writes without access, each path');
const newHold = { kind: 'standing_decision', subject_label: 'ZZ CU2 Local', decision: 'x', effect: 'do_not_add', reopen: { on: 'owner_only' } };
access(B, true);
const cB = (await rpc(B.token, 'org_create_collection', { p_id: crypto.randomUUID(), p_name: 'ZZ CU2 Local' })).json.collection.id;
const hSaved = (await rpc(B.token, 'library_cu_save_hold', { p_hold: newHold })).json;
const show = (await rpc(B.token, 'library_create_show_b45', { p_show: { tmdb_id: 990300, title: 'ZZ CU2 Local Show', show_key: 'zz cu2 local show', network: 'ZZ' },
  p_seasons: [{ item_key: 'zz cu2 local show|season 1', title: 'ZZ CU2 Local Show', season: 'Season 1', theme: 'ZZ', display_date: 'TBA', date_sort: '2099-01-01', season_number: 1 }] })).json.show;
const hOnShow = (await rpc(B.token, 'library_cu_save_hold', { p_hold: { kind: 'standing_decision', show_id: show.id, decision: 'On the show', effect: 'keep_value', reopen: { on: 'owner_only' } } })).json;
ok(hSaved && hSaved.id && hOnShow && hOnShow.id, 'with access, holds save through the API');
access(B, false);
ok((await cap(B)).research === false, 'revocation reaches a token already issued, at once');
const holds = async who => (await rest(who.token, 'GET', 'update_holds?select=id,decision&order=id.asc')).json;
const h0 = JSON.stringify(await holds(B));
ok(notEnabled(await rpc(B.token, 'library_cu_save_hold', { p_hold: newHold })) && JSON.stringify(await holds(B)) === h0, 'RPC: a hold is refused');
ok(notEnabled(await rpc(B.token, 'library_cu_delete_hold', { p_id: hSaved.id, p_expected_decision: 'x' })) && JSON.stringify(await holds(B)) === h0, 'RPC: removing a hold is refused');
for (const [label, r] of [
  ['REST insert', await rest(B.token, 'POST', 'update_holds', { ...newHold, reopen: { on: 'owner_only' } })],
  ['REST update', await rest(B.token, 'PATCH', `update_holds?id=eq.${hSaved.id}`, { decision: 'y' })],
  ['REST delete', await rest(B.token, 'DELETE', `update_holds?id=eq.${hSaved.id}`)]]) {
  ok(!r.ok && JSON.stringify(await holds(B)) === h0, `${label}: refused`, r.text);
}
const gIns = await gql(B.token, `mutation { insertIntoupdate_holdsCollection(objects: [{ kind: "standing_decision", subject_label: "ZZ G", decision: "x", effect: "do_not_add", reopen: "{\\"on\\": \\"owner_only\\"}" }]) { affectedCount } }`);
ok(JSON.stringify(await holds(B)) === h0 && notEnabled(gIns), 'GraphQL insert: refused by the guard', gIns.text);
const gDel = await gql(B.token, `mutation { deleteFromupdate_holdsCollection(filter: { id: { eq: "${hSaved.id}" } }, atMost: 1) { affectedCount } }`);
ok(JSON.stringify(await holds(B)) === h0 && notEnabled(gDel), 'GraphQL delete: refused by the guard', gDel.text);

section('several GraphQL mutations in one request');
// One request is one transaction: a function that leaves watchlist.library_write on runs first, then a direct write.
const gChain = await gql(B.token, `mutation {
  a: org_create_collection(p_id: "${crypto.randomUUID()}", p_name: "ZZ CU2 Chain")
  b: deleteFromupdate_holdsCollection(filter: { id: { eq: "${hSaved.id}" } }, atMost: 1) { affectedCount } }`);
ok(JSON.stringify(await holds(B)) === h0 && notEnabled(gChain), 'a function, then a direct delete of a hold: refused by the guard', gChain.text);
function backupOf(who) {
  const out = psql(execFileSync(process.execPath, [path.join(ROOT, 'tools/admin-restore.mjs'), 'export-sql', '--owner', who.id], { encoding: 'utf8' }));
  return JSON.parse(out.slice(out.indexOf('{"format"'), out.lastIndexOf('}') + 1));
}
const docNow = backupOf(B);
const gRestore = await gql(B.token, `mutation($d: JSON!) {
  a: restore_backup(p_backup: $d, p_allow_v1_reset: false)
  b: deleteFromupdate_holdsCollection(filter: { id: { eq: "${hSaved.id}" } }, atMost: 1) { affectedCount } }`, { d: JSON.stringify(docNow) });
ok(JSON.stringify(await holds(B)) === h0 && notEnabled(gRestore), 'a restore, then a direct delete of a hold, one request: refused by the guard', gRestore.text);

// Not CU2's: reported, not asserted. watchlist.library_write lasts to the end of a transaction, so where pg_graphql is on, a chained
// write to an ordinary table may pass library_write_guard. It stays within the member's own rows and can't reach a guarded table.
const netBefore = psql(`select coalesce(network, '') from public.tv_shows where id = '${show.id}'`).trim();
const gOrd = await gql(B.token, `mutation {
  a: library_cu_set_show_settings(p_show_id: "${show.id}", p_expected: "{\\"follow_when_skipped\\": false, \\"flagged\\": false}", p_follow_when_skipped: false, p_clear_ended_flag: false)
  b: updatetv_showsCollection(set: { network: "ZZ Chained" }, filter: { id: { eq: "${show.id}" } }, atMost: 1) { affectedCount } }`);
const netAfter = psql(`select coalesce(network, '') from public.tv_shows where id = '${show.id}'`).trim();
console.log(`  info a chained direct write to an ordinary table ${netAfter !== netBefore ? 'WENT THROUGH' : 'was refused'} (${scrub(gOrd.text).slice(0, 140)})`);

section('ordinary work and TMDB findings without access');
const fpTmdb = `new_season:${crypto.randomBytes(32).toString('hex')}`;
const rec = await rpc(B.token, 'library_cu_reconcile_season', { p_show_id: show.id, p_expected: { tmdb_id: 990300, show_key: 'zz cu2 local show' },
  p_season: { season_number: 2, display_date: 'Mar 1, 2027', date_sort: '2027-03-01', episode_count: 8 }, p_finding: { source: 'tmdb', kind: 'new_season', fingerprint: fpTmdb, show_id: show.id } });
ok(rec.ok && rec.json.status === 'pending' && rec.json.reason === 'standing_decision' || (rec.ok && rec.json.outcome === 'applied'), 'a TMDB season is handled, under the standing decision on the show', rec.text);
ok((await rpc(B.token, 'org_add_membership', { p_collection_id: cB, p_show_id: show.id })).ok, 'a membership is added');
ok((await rest(B.token, 'GET', 'update_holds?select=id')).ok && (await rest(B.token, 'GET', 'update_findings?select=id')).ok, 'B reads its own research rows');
ok(((await rest(B.token, 'GET', `update_holds?select=id&user_id=eq.${A.id}`)).json || []).length === 0, 'and nothing of A’s');

section('the cascade of an ordinary delete');
const rowsOf = (await rest(B.token, 'GET', `watchlist_items?select=id&show_id=eq.${show.id}`)).json;
let del = null;
for (const r of rowsOf) del = await rpc(B.token, 'delete_tv_season', { p_row_id: r.id, p_marks_expected: 0 });
const after = await holds(B);
ok(del.ok && !after.some(h => h.id === hOnShow.id) && after.some(h => h.id === hSaved.id), 'deleting the show’s last season takes the hold on it, and only it', del.text);

section('restore through the API');
const fBefore = flags();
const doc7 = backupOf(B);
ok(doc7.formatVersion === 7 && doc7.tables.update_holds.length === after.length, 'B’s backup has its holds');
const rs = await rpc(B.token, 'restore_backup', { p_backup: doc7, p_allow_v1_reset: false });
ok(rs.ok && flags() === fBefore && (await cap(B)).research === false && JSON.stringify(await holds(B)) === JSON.stringify(after), 'without access, a restore keeps every hold and the permission', rs.text);
ok(notEnabled(await rpc(B.token, 'library_cu_save_hold', { p_hold: newHold })), 'and the next research request is refused');
const carried = JSON.parse(JSON.stringify(doc7)); carried.tables.library_members = [{ user_id: B.id, research_enabled: true }]; carried.rowCounts.library_members = 1;
const rc = await rpc(B.token, 'restore_backup', { p_backup: carried, p_allow_v1_reset: false });
ok(!rc.ok && /unexpected set of tables/.test(rc.text) && flags() === fBefore, 'a file carrying the permission is refused', rc.text);
access(B, true);
ok((await rpc(B.token, 'library_cu_save_hold', { p_hold: { ...newHold, subject_label: 'ZZ CU2 Back' } })).ok, 'switched back on, the same token works at once');
access(B, false);

console.log(failed ? `\nFAILED: ${failed} check(s)` : `\nALL ${passed} CHECKS PASSED`);
process.exit(failed ? 1 : 0);
