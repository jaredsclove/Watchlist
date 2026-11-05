// Q1 (named planning queues) against a real local Supabase stack: real Auth tokens and PostgREST, for what PGlite can't show
// (grants, policies and exposure through the API). Refuses any address but 127.0.0.1. Builds its own synthetic database on a
// fresh stack (`supabase start` in an empty folder), so it runs once per stack.
//   LOCAL_SERVICE_KEY=<the stack's service key> node tools/q1-local-api-test.mjs --api http://127.0.0.1:54321 --key <publishable key> --container supabase_db_<project>
// Three accounts: A and B (members) and C (signed in, not a member). Test passwords are generated in this process and never
// printed or stored. Checks: each member reaches only their own queues and entries, through every function and table route;
// direct table writes are refused; signed out reaches nothing; private helpers aren't exposed; completion through the API
// removes entries; a format-8 restore through the API keeps both orders. Output: pass/fail and counts only.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { library } from './restore-fixture.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const API = opt('--api'), KEY = opt('--key'), CONTAINER = opt('--container'), SERVICE = process.env.LOCAL_SERVICE_KEY;
if (!API || new URL(API).hostname !== '127.0.0.1' || !KEY || !CONTAINER || !SERVICE) {
  console.error('usage: LOCAL_SERVICE_KEY=… node tools/q1-local-api-test.mjs --api http://127.0.0.1:54321 --key <key> --container <db container>');
  process.exit(2);
}
const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const psql = (text, quiet = true) => execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-X', ...(quiet ? ['-q'] : []), '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
  { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26 });

let failed = 0, passed = 0;
const scrub = s => String(s || '').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]').slice(0, 400);
const ok = (cond, label, detail = '') => { if (cond) passed++; else failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${scrub(detail)}` : ''}`); return cond; };
const section = t => console.log(`\n[${t}]`);
async function call(token, method, p, body, extra = {}) {
  const headers = { apikey: KEY, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extra };
  if (token !== 'anon') headers.Authorization = `Bearer ${token || KEY}`;
  const res = await fetch(`${API}/${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}
const rest = (t, m, p, b, x) => call(t, m, `rest/v1/${p}`, b, x);
const rpc = (t, fn, args) => rest(t, 'POST', `rpc/${fn}`, args);
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

section('stack: a synthetic database, through Q1');
if (!ok(psql(`select to_regclass('public.tv_shows') is null;`).trim() === 't', 'the stack is fresh')) process.exit(1);
for (const f of ['db/test/replica_schema.sql', 'db/phase0_restore_v1.sql', 'db/phase1b_ownership.sql', 'db/restore_backup.sql', 'db/phase1c_tv_schema.sql', 'db/tv_model.sql', 'db/rpc.sql', 'db/admin/tv_enrich.sql']) psql(sql(f));
psql(`update private.migration_stage set stage = 'final'`);
for (const f of ['db/phase3b_org.sql', 'db/phase3b2_org_write.sql', 'db/phase4a_catalog.sql', 'db/phase4b_add_to_show.sql', 'db/phase5a_expand.sql', 'db/phase5c_contract.sql']) psql(sql(f));
psql(`select set_config('watchlist.b45_choices', '{"shows": {}, "films": {}}', false);\n` + sql('db/b45_expand.sql'));
const A = await account('q1-a@test.invalid'), B = await account('q1-b@test.invalid'), C = await account('q1-c@test.invalid');
psql(`begin; select set_config('watchlist.library_write', 'on', true);
  insert into private.stage5_recovery_meta (user_id, origin, counts, hashes) select bootstrap_owner_id, 'contraction', '{}'::jsonb, '{}'::jsonb from private.app_owner; commit;`);
psql(`select set_config('watchlist.m1_owner', '${A.id}', false), set_config('watchlist.m1_run', 'local-m1', false);\n` + sql('db/m1_access.sql'));
psql(`select set_config('watchlist.ep1_run', 'local-ep1', false);\n` + sql('db/ep1_episode_marks.sql'));
psql(`insert into private.library_members (user_id, note) values ('${B.id}', 'local B')`);
for (const g of ['cu1', 'cu1b', 'cu1c', 'cu1d']) psql(`select set_config('watchlist.${g}_run', 'local-${g}', false);\n` + sql({ cu1: 'db/cu1_collection_updates.sql', cu1b: 'db/cu1b_hold_edit.sql', cu1c: 'db/cu1c_date_equivalence.sql', cu1d: 'db/cu1d_network_and_marks.sql' }[g]));
psql(`select set_config('watchlist.cu2_run', 'local-cu2', false), set_config('watchlist.cu2_owner', '${A.id}', false);\n` + sql('db/cu2_research_access.sql'));
psql(`select set_config('watchlist.cu1e_run', 'local-cu1e', false);\n` + sql('db/cu1e_missing_season.sql'));
psql(`select set_config('watchlist.simplify_run', 'local-simplify', false);\n` + sql('db/simplify_restore_cleanup.sql'));
await new Promise(r => setTimeout(r, 1500));
const L1 = library(1), L2 = library(2);
ok((await rpc(A.token, 'restore_backup', { p_backup: L1, p_allow_v1_reset: false })).ok && (await rpc(B.token, 'restore_backup', { p_backup: L2, p_allow_v1_reset: false })).ok,
  'two format-7 libraries restore through the API before Q1');
ok(/Q1\|/.test(psql(`select set_config('watchlist.q1_run', 'local-q1', false);\n` + sql('db/q1_queues.sql'), false)), 'db/q1_queues.sql commits on the stack');
await new Promise(r => setTimeout(r, 2000)); // the API reloads its schema cache
const cap = (await rpc(A.token, 'stage5_capabilities')).json || {};
ok(cap.phase === 'contracted-q1' && cap.backup_format === 8, 'the capability says contracted-q1, format 8', JSON.stringify(cap));

const film = n => L1.tables.watchlist_items.find(w => w.season === 'Film' && w.item_key.endsWith(` ${n}`)).id;
const season = (s, n) => L1.tables.watchlist_items.find(w => w.show_id && w.title === `ZZ Show 1.${s}` && w.season_number === n).id;
const show = s => L1.tables.tv_shows.find(x => x.title === `ZZ Show 1.${s}`).id;

section('a member’s own queues');
const qa = await rpc(A.token, 'library_queue_create', { p_name: 'ZZ A Queue' });
const qb = await rpc(B.token, 'library_queue_create', { p_name: 'ZZ A Queue' });
ok(qa.ok && qb.ok && qa.json.sort_order === 1 && qb.json.sort_order === 1, 'each member makes a first queue (the same name is fine across accounts)', qa.text + qb.text);
const QA = qa.json.id, QB = qb.json.id;
const add1 = await rpc(A.token, 'library_queue_add', { p_queue_id: QA, p_show_id: null, p_item_id: film(1) });
const add2 = await rpc(A.token, 'library_queue_add', { p_queue_id: QA, p_show_id: null, p_item_id: season(3, 3) });
const add3 = await rpc(A.token, 'library_queue_add', { p_queue_id: QA, p_show_id: show(5), p_item_id: null });
ok(add1.ok && add2.ok && add3.ok, 'A adds a film, a season and a whole show', add1.text + add2.text + add3.text);
ok(/queue_overlap/.test((await rpc(A.token, 'library_queue_add', { p_queue_id: QA, p_show_id: null, p_item_id: season(5, 2) })).text), 'a season of the whole show is refused');
const readA = await rest(A.token, 'GET', 'queue_entries?select=id,user_id');
ok(readA.ok && readA.json.length === 3 && readA.json.every(r => r.user_id === A.id), 'A reads exactly their three entries');

section('isolation');
ok((await rest(B.token, 'GET', `watch_queues?id=eq.${QA}&select=id`)).json.length === 0 && (await rest(B.token, 'GET', 'queue_entries?select=id')).json.length === 0, 'B reads none of A’s');
ok(/queue_missing/.test((await rpc(B.token, 'library_queue_add', { p_queue_id: QA, p_show_id: null, p_item_id: L2.tables.watchlist_items[0].id })).text), 'B can’t add to A’s queue');
ok(/target_missing/.test((await rpc(B.token, 'library_queue_add', { p_queue_id: QB, p_show_id: null, p_item_id: film(1) })).text), 'B can’t queue A’s film');
ok(/queue_missing/.test((await rpc(B.token, 'library_queue_rename', { p_queue_id: QA, p_expected_name: 'ZZ A Queue', p_name: 'x' })).text), 'B can’t rename A’s queue');
ok(/queue_missing/.test((await rpc(B.token, 'library_queue_delete', { p_queue_id: QA, p_expected_count: 3 })).text), 'B can’t delete it');
ok((await rpc(B.token, 'library_queue_remove', { p_entry_id: add1.json.id })).json.removed === false, 'B can’t remove A’s entry');
ok(/queue_missing/.test((await rpc(B.token, 'library_queue_move', { p_queue_id: QA, p_expected: [], p_entry_id: add1.json.id, p_to_index: 1 })).text), 'B can’t move A’s entries');
const bOrder = await rpc(B.token, 'library_queue_reorder', { p_expected: [QA], p_queue_id: QA, p_to_index: 1 });
ok(!bOrder.ok, 'B can’t reorder with A’s queue', bOrder.text);
ok((await rest(A.token, 'GET', 'queue_entries?select=id')).json.length === 3, '(A’s entries are all there)');

section('tables: no direct writes, nothing signed out or for a non-member');
for (const [label, r] of [
  ['insert a queue', await rest(A.token, 'POST', 'watch_queues', { name: 'ZZ Direct', sort_order: 9 })],
  ['insert an entry', await rest(A.token, 'POST', 'queue_entries', { queue_id: QA, item_id: film(2), position: 9 })],
  ['move an entry', await rest(A.token, 'PATCH', `queue_entries?id=eq.${add1.json.id}`, { position: 7 })],
  ['rename a queue', await rest(A.token, 'PATCH', `watch_queues?id=eq.${QA}`, { name: 'ZZ Renamed' })],
  ['delete an entry', await rest(A.token, 'DELETE', `queue_entries?id=eq.${add1.json.id}`)],
  ['delete a queue', await rest(A.token, 'DELETE', `watch_queues?id=eq.${QA}`)]]) {
  ok(!r.ok && /library_write_required|permission denied/.test(r.text), `A’s direct ${label}: refused (${r.status})`, r.text);
}
ok((await rest(A.token, 'GET', 'queue_entries?select=id')).json.length === 3, '(nothing changed)');
for (const [label, r] of [['read queues', await rest('anon', 'GET', 'watch_queues?select=*')], ['read entries', await rest('anon', 'GET', 'queue_entries?select=*')],
  ['create', await rest('anon', 'POST', 'rpc/library_queue_create', { p_name: 'x' })]]) ok(!r.ok, `signed out: ${label} refused (${r.status})`, r.text);
ok(/not_a_member/.test((await rpc(C.token, 'library_queue_create', { p_name: 'ZZ C' })).text) && (await rest(C.token, 'GET', 'watch_queues?select=id')).json.length === 0, 'a non-member: nothing');
for (const fn of ['q1_lock', 'q1_show_complete', 'q1_moved']) {
  const r = await rest(A.token, 'POST', `rpc/${fn}`, {}, { 'Content-Profile': 'private' });
  ok(!r.ok && [404, 406].includes(r.status), `private.${fn}: not exposed (${r.status})`, r.text);
}

section('completion and restore through the API');
ok((await rpc(A.token, 'set_season_watched', { p_row_id: season(3, 3), p_watched: true })).ok
  && !(await rest(A.token, 'GET', 'queue_entries?select=item_id')).json.some(r => r.item_id === season(3, 3)), 'a season marked watched leaves the queue');
const tables = {};
for (const t of Object.keys(L1.tables)) tables[t] = L1.tables[t];
const snapshot = async () => ({ q: (await rest(A.token, 'GET', 'watch_queues?select=id,name,sort_order,created_at&order=id')).json, e: (await rest(A.token, 'GET', 'queue_entries?select=id,queue_id,show_id,item_id,position,created_at&order=id')).json });
const before = await snapshot();
const doc8 = { ...L1, formatVersion: 8, tables: { ...tables, watch_queues: before.q, queue_entries: before.e } };
doc8.rowCounts = Object.fromEntries(Object.entries(doc8.tables).map(([k, v]) => [k, v.length]));
const restored = await rpc(A.token, 'restore_backup', { p_backup: doc8, p_allow_v1_reset: false });
const after = await snapshot();
ok(restored.ok && JSON.stringify(after) === JSON.stringify(before), 'a format-8 restore through the API keeps both orders exactly', restored.text);
ok(/converted in the page/.test((await rpc(A.token, 'restore_backup', { p_backup: L1, p_allow_v1_reset: false })).text), 'a format-7 file sent directly is refused');
ok((await rest(B.token, 'GET', 'watch_queues?select=id')).json.length === 1, 'B’s queue is untouched by A’s restore');

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
