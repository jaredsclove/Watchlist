// G1 (games) against a real local Supabase stack: real Auth tokens, PostgREST and the Edge Function runtime, for what PGlite
// can't show (grants, policies, exposure through the API, and the igdb function's access checks). Refuses any address but
// 127.0.0.1. Builds its own synthetic database on a fresh stack (`supabase start` in an empty folder), so it runs once per stack.
//   LOCAL_SERVICE_KEY=<the stack's service key> node tools/g1-local-api-test.mjs --api http://127.0.0.1:54321 --key <publishable key> \
//     --container supabase_db_<project> --project <the stack's folder> [--host-alias host.docker.internal]
// The igdb function is served from this checkout (supabase functions serve, the JWT check off as deployed) against a fake IGDB and
// Twitch on this machine, with a generated test secret: no IGDB credential is used. Accounts: A and B (members) and C (signed in,
// not a member); test passwords are generated in this process and never printed or stored. Checks: the function answers signed
// out 401, the publishable key as a token 401, a non-member 403, a member 200, a query outside the allow-list 400, and never says
// its secret; each member reaches only their own games, settings, follows, decisions and collections through every function and
// table route; direct table writes are refused; signed out reaches nothing; a format-9 restore keeps a mixed queue's places.
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { library9 } from './restore-fixture.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const API = opt('--api'), KEY = opt('--key'), CONTAINER = opt('--container'), PROJECT = opt('--project'), SERVICE = process.env.LOCAL_SERVICE_KEY;
const HOST_ALIAS = opt('--host-alias') || 'host.docker.internal';
if (!API || new URL(API).hostname !== '127.0.0.1' || !KEY || !CONTAINER || !PROJECT || !SERVICE) {
  console.error('usage: LOCAL_SERVICE_KEY=… node tools/g1-local-api-test.mjs --api http://127.0.0.1:54321 --key <key> --container <db container> --project <stack folder>');
  process.exit(2);
}
const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const psql = (text, quiet = true) => execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-X', ...(quiet ? ['-q'] : []), '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
  { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
const SECRET = 'local-' + crypto.randomBytes(16).toString('hex');

let failed = 0, passed = 0;
const scrub = s => String(s || '').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]').split(SECRET).join('[secret]').slice(0, 400);
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
const wait = ms => new Promise(r => setTimeout(r, ms));

section('stack: a synthetic database, through G1');
if (!ok(psql(`select to_regclass('public.tv_shows') is null;`).trim() === 't', 'the stack is fresh')) process.exit(1);
for (const f of ['db/test/replica_schema.sql', 'db/phase0_restore_v1.sql', 'db/phase1b_ownership.sql', 'db/restore_backup.sql', 'db/phase1c_tv_schema.sql', 'db/tv_model.sql', 'db/rpc.sql', 'db/admin/tv_enrich.sql']) psql(sql(f));
psql(`update private.migration_stage set stage = 'final'`);
for (const f of ['db/phase3b_org.sql', 'db/phase3b2_org_write.sql', 'db/phase4a_catalog.sql', 'db/phase4b_add_to_show.sql', 'db/phase5a_expand.sql', 'db/phase5c_contract.sql']) psql(sql(f));
psql(`select set_config('watchlist.b45_choices', '{"shows": {}, "films": {}}', false);\n` + sql('db/b45_expand.sql'));
const A = await account('g1-a@test.invalid'), B = await account('g1-b@test.invalid'), C = await account('g1-c@test.invalid');
psql(`begin; select set_config('watchlist.library_write', 'on', true);
  insert into private.stage5_recovery_meta (user_id, origin, counts, hashes) select bootstrap_owner_id, 'contraction', '{}'::jsonb, '{}'::jsonb from private.app_owner; commit;`);
psql(`select set_config('watchlist.m1_owner', '${A.id}', false), set_config('watchlist.m1_run', 'local-m1', false);\n` + sql('db/m1_access.sql'));
psql(`select set_config('watchlist.ep1_run', 'local-ep1', false);\n` + sql('db/ep1_episode_marks.sql'));
psql(`insert into private.library_members (user_id, note) values ('${B.id}', 'local B')`);
for (const g of ['cu1', 'cu1b', 'cu1c', 'cu1d']) psql(`select set_config('watchlist.${g}_run', 'local-${g}', false);\n` + sql({ cu1: 'db/cu1_collection_updates.sql', cu1b: 'db/cu1b_hold_edit.sql', cu1c: 'db/cu1c_date_equivalence.sql', cu1d: 'db/cu1d_network_and_marks.sql' }[g]));
psql(`select set_config('watchlist.cu2_run', 'local-cu2', false), set_config('watchlist.cu2_owner', '${A.id}', false);\n` + sql('db/cu2_research_access.sql'));
psql(`select set_config('watchlist.cu1e_run', 'local-cu1e', false);\n` + sql('db/cu1e_missing_season.sql'));
psql(`select set_config('watchlist.simplify_run', 'local-simplify', false);\n` + sql('db/simplify_restore_cleanup.sql'));
psql(`select set_config('watchlist.q1_run', 'local-q1', false);\n` + sql('db/q1_queues.sql'));
ok(/G1\|/.test(psql(`select set_config('watchlist.g1_run', 'local-g1', false);\n` + sql('db/g1_games.sql'), false)), 'db/g1_games.sql commits on the stack');
await wait(2000); // the API reloads its schema cache
const cap = (await rpc(A.token, 'stage5_capabilities')).json || {};
ok(cap.phase === 'contracted-g1' && cap.backup_format === 9 && cap.member === true, 'the capability says contracted-g1, format 9', JSON.stringify(cap));
ok((await rpc(C.token, 'stage5_capabilities')).json?.member === false, 'a signed-in non-member reads member: false (what the function checks)');

section('the igdb function: who may use it (served from this checkout, a fake IGDB)');
const seen = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/token') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ access_token: 'zz-app-token', expires_in: 5000000, token_type: 'bearer' })); return; }
    if (req.url.startsWith('/v4/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify([{ id: 1, name: 'ZZ Local Game' }])); return; }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => mock.listen(0, '0.0.0.0', r));
const port = mock.address().port;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'g1fn-'));
const envFile = path.join(work, 'fn.env');
fs.writeFileSync(envFile, `IGDB_CLIENT_ID=zz-local-client\nIGDB_CLIENT_SECRET=${SECRET}\nIGDB_BASE=http://${HOST_ALIAS}:${port}/v4\nIGDB_TOKEN_URL=http://${HOST_ALIAS}:${port}/token\n`, { mode: 0o600 });
const fnDir = path.join(PROJECT, 'supabase', 'functions', 'igdb');
fs.mkdirSync(fnDir, { recursive: true });
for (const f of ['core.mjs', 'index.ts']) fs.copyFileSync(path.join(ROOT, 'supabase/functions/igdb', f), path.join(fnDir, f));
const serve = spawn('supabase', ['functions', 'serve', 'igdb', '--no-verify-jwt', '--env-file', envFile, '--workdir', PROJECT], { stdio: ['ignore', 'pipe', 'pipe'] });
let serveLog = ''; serve.stdout.on('data', d => { serveLog += d; }); serve.stderr.on('data', d => { serveLog += d; });
const fn = (token, body, extra = {}) => call(token, 'POST', 'functions/v1/igdb', body, extra);
const Q = { queries: [{ name: 'search', endpoint: 'games', body: 'search "zz"; fields id,name; limit 5;' }] };
try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) { const r = await call('anon', 'OPTIONS', 'functions/v1/igdb').catch(() => null); up = !!r && r.status === 204; if (!up) await wait(1000); }
  if (!ok(up, 'the function is served', serveLog.slice(-400))) throw new Error('not served');
  const out = await fn('anon', Q);
  ok(out.status === 401 && out.json?.error === 'not_signed_in', `signed out (no token): ${out.status}`, out.text);
  const key = await fn(KEY, Q);
  ok(key.status === 401, `the publishable key as the token: ${key.status}`, key.text);
  const bogus = await fn('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad', Q);
  ok(bogus.status === 401, `an invalid token: ${bogus.status}`, bogus.text);
  const nm = await fn(C.token, Q);
  ok(nm.status === 403 && nm.json?.error === 'not_a_member', `signed in, not a member: ${nm.status}`, nm.text);
  ok(!seen.some(s => s.url.startsWith('/v4/')) && !seen.some(s => s.url === '/token'), 'none of those reached IGDB or made a token');
  const m = await fn(A.token, Q);
  ok(m.status === 200 && m.json?.results?.[0]?.data?.[0]?.name === 'ZZ Local Game', `a member: ${m.status}, answered`, m.text);
  const igdbCall = seen.find(s => s.url === '/v4/games');
  ok(igdbCall && igdbCall.headers['client-id'] === 'zz-local-client' && igdbCall.headers.authorization === 'Bearer zz-app-token' && /search "zz"/.test(igdbCall.body), 'IGDB got the client id, the app token and the query');
  const tok = seen.find(s => s.url === '/token');
  ok(tok && tok.body.includes(encodeURIComponent(SECRET)) && !tok.url.includes(SECRET), 'the secret went only in the token request’s body');
  ok(!m.text.includes(SECRET) && !m.text.includes('zz-app-token'), 'no secret or token in the answer');
  const bad = await fn(A.token, { queries: [{ name: 'x', endpoint: 'game_secrets', body: 'fields *;' }] });
  ok(bad.status === 400, `a query outside the allow-list: ${bad.status}`, bad.text);
  ok((await fn(B.token, Q)).status === 200, 'another member: answered');
} finally {
  serve.kill('SIGINT');
  await wait(1500);
  mock.close();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(fnDir, { recursive: true, force: true });
}

section('a member’s own games');
const g = (t, args) => rpc(t, 'library_game_add', { p_status: 'want', p_priority: 'normal', p_port_ids: [], ...args });
const a1 = await g(A.token, { p_igdb_id: 900001, p_title: 'ZZ War 4', p_spot_igdb_id: 900001 });
const b1 = await g(B.token, { p_igdb_id: 900001, p_title: 'ZZ War 4', p_spot_igdb_id: 900001 });
ok(a1.ok && b1.ok, 'each member saves the same IGDB record', a1.text + b1.text);
ok((await rpc(A.token, 'library_game_settings_save', { p_expected: null, p_platforms: ['ps5'], p_play_style: 'main' })).ok, 'A saves platforms and play style');
ok((await rpc(B.token, 'library_game_decision_set', { p_kind: 'not_out_yet', p_igdb_id: 900001, p_platform: 'ps5', p_expected: null, p_value: { date: '2026-10-23', precision: 'day' } })).ok, 'B (no research access) holds a release: Not out yet');
ok(/research_not_enabled/.test((await rpc(B.token, 'library_game_decision_set', { p_kind: 'available', p_igdb_id: 900001, p_platform: 'ps5', p_expected: null, p_value: { precision: 'year', year: 2027 } })).text), 'B can’t record Store evidence');
const coll = await rpc(A.token, 'library_game_collection_create', { p_name: 'ZZ Couch' });
ok(coll.ok && (await rpc(A.token, 'library_game_collection_add', { p_collection_id: coll.json.id, p_entry_id: a1.json.id })).ok, 'A makes a game collection and adds the game');
ok((await rpc(A.token, 'library_game_titles_put', { p_rows: [{ igdb_id: 900001, data: { v: 1, name: 'ZZ War 4' } }] })).ok, 'A caches an IGDB record');
for (const t of ['game_entries', 'game_settings', 'game_decisions', 'game_collections', 'game_collection_members', 'game_titles']) {
  const ra = await rest(A.token, 'GET', `${t}?select=id,user_id`), rb = await rest(B.token, 'GET', `${t}?select=id,user_id`);
  ok(ra.ok && rb.ok && ra.json.every(r => r.user_id === A.id) && rb.json.every(r => r.user_id === B.id), `${t}: each member reads only their own (${ra.json.length} / ${rb.json.length})`, ra.text + rb.text);
}
ok(/target_missing/.test((await rpc(B.token, 'library_game_set', { p_entry_id: a1.json.id, p_expected: { status: 'want', priority: 'normal' }, p_status: 'finished', p_priority: 'normal' })).text), 'B can’t change A’s game');
ok(/collection_missing|target_missing/.test((await rpc(B.token, 'library_game_collection_add', { p_collection_id: coll.json.id, p_entry_id: b1.json.id })).text), 'B can’t add to A’s collection');

section('tables: no direct writes, nothing signed out or for a non-member');
for (const [label, r] of [
  ['insert a game', await rest(A.token, 'POST', 'game_entries', { igdb_id: 5, spot_igdb_id: 5, title: 'ZZ Direct' })],
  ['finish a game', await rest(A.token, 'PATCH', `game_entries?id=eq.${a1.json.id}`, { status: 'finished' })],
  ['insert settings', await rest(B.token, 'POST', 'game_settings', { platforms: ['ps5'] })],
  ['insert a decision', await rest(A.token, 'POST', 'game_decisions', { kind: 'skip_spot', igdb_id: 1, value: {} })],
  ['cache a record', await rest(A.token, 'POST', 'game_titles', { igdb_id: 2, data: {} })],
  ['delete a game', await rest(A.token, 'DELETE', `game_entries?id=eq.${a1.json.id}`)]]) {
  ok(!r.ok && /library_write_required|permission denied/.test(r.text), `A’s direct ${label}: refused (${r.status})`, r.text);
}
for (const [label, r] of [['read games', await rest('anon', 'GET', 'game_entries?select=*')], ['read the cache', await rest('anon', 'GET', 'game_titles?select=*')],
  ['save a game', await rest('anon', 'POST', 'rpc/library_game_add', { p_igdb_id: 1, p_title: 'x', p_spot_igdb_id: 1, p_port_ids: [], p_status: 'want', p_priority: 'normal' })]]) ok(!r.ok, `signed out: ${label} refused (${r.status})`, r.text);
ok(/not_a_member/.test((await g(C.token, { p_igdb_id: 1, p_title: 'ZZ C', p_spot_igdb_id: 1 })).text) && (await rest(C.token, 'GET', 'game_entries?select=id')).json.length === 0, 'a non-member: nothing');
for (const f of ['g1_lock', 'g1_entry', 'g1_saved_as']) {
  const r = await rest(A.token, 'POST', `rpc/${f}`, {}, { 'Content-Profile': 'private' });
  ok(!r.ok && [404, 406].includes(r.status), `private.${f}: not exposed (${r.status})`, r.text);
}

section('a format-9 restore through the API keeps a mixed queue’s places');
const L = library9(1);
const r9 = await rpc(A.token, 'restore_backup', { p_backup: L, p_allow_v1_reset: false });
ok(r9.ok, 'restored', r9.text);
const got = (await rest(A.token, 'GET', `queue_entries?select=id,position,game_entry_id&queue_id=eq.${L.tables.watch_queues[0].id}&order=position`)).json;
const want = L.tables.queue_entries.filter(e => e.queue_id === L.tables.watch_queues[0].id).sort((a, b) => a.position - b.position).map(e => ({ id: e.id, position: e.position, game_entry_id: e.game_entry_id }));
ok(JSON.stringify(got) === JSON.stringify(want), 'games at their places (3 and 5) between films and shows', JSON.stringify(got));
const fin = await rpc(A.token, 'library_game_set', { p_entry_id: L.tables.game_entries[1].id, p_expected: { status: 'want', priority: 'high' }, p_status: 'finished', p_priority: 'high' });
ok(fin.ok && fin.json.queue_entries_removed === 1, 'finishing a restored game through the API takes it out of its queue', fin.text);
ok((await rest(B.token, 'GET', 'game_entries?select=id')).json.length === 1, 'B’s games are untouched by A’s restore');

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
