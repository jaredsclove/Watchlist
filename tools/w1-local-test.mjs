// W1 on a real local Supabase stack (never a hosted project): real Auth, PostgREST, its connection pool and pg_graphql.
//   the catalog      every entry function and writer, by the same rules the migration checks
//   ordinary work    the page's calls through the API, restore, cascades, admin paths
//   scope            nested calls, exceptions, savepoints, chained GraphQL mutations, direct REST and GraphQL writes
//   defaults         database, role, server and connection defaults refuse every write, each with its own cause
//   pool             a pooled connection after success, failure and cancellation; a leak the guard can't see
//
//   LOCAL_SERVICE_KEY=… node tools/w1-local-test.mjs --api http://127.0.0.1:54321 --key <anon key> --container <db container>
//     --backup <format6.json> [--cu1e <file>] [--cu1e-first]
// Needs a fresh stack (`supabase db reset`). PostgREST reads a role's own settings, not a role's per-database ones.
// --cu1e installs that CU1e file after W1, or before it with --cu1e-first.
// Exit 0 only if every check passes.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const API = opt('--api'), KEY = opt('--key'), CONTAINER = opt('--container'), backupFile = opt('--backup'), CU1E = opt('--cu1e'), SERVICE = process.env.LOCAL_SERVICE_KEY;
if (!API || !KEY || !CONTAINER || !backupFile || !SERVICE) { console.error('usage: see the top of this file'); process.exit(2); }
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(API)) { console.error('a local API only'); process.exit(2); }
const REST_CONTAINER = CONTAINER.replace('_db_', '_rest_');
const doc6 = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failed = 0, passed = 0;
const ok = (cond, label, detail = '') => { cond ? passed++ : failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${String(detail).slice(0, 400)}` : ''}`); return cond; };
const section = t => console.log(`\n[${t}]`);
const info = t => console.log(`  info ${t}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const psqlAs = (user, text, env = {}) => execFileSync('docker', ['exec', '-i', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), CONTAINER, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', 'postgres'],
  { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
const psql = text => psqlAs('postgres', text);
const tryPsql = (text, user = 'postgres', env = {}) => { try { return { ok: true, out: psqlAs(user, text, env) }; } catch (e) { return { ok: false, message: String(e.stderr || e.message) }; } };
const Q = text => psql(text).trim();

async function call(token, method, p, body, extra = {}) {
  const res = await fetch(`${API}/${p}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${token || KEY}`, 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}
const rpc = (t, fn, args) => call(t, 'POST', `rest/v1/rpc/${fn}`, args);
const rest = (t, method, p, body, extra) => call(t, method, `rest/v1/${p}`, body, extra);
const gql = (t, query, variables) => call(t, 'POST', 'graphql/v1', { query, variables });
async function account(email) {
  const password = 'Local-' + crypto.randomBytes(18).toString('base64url');
  const r = await fetch(`${API}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }) });
  const u = await r.json();
  if (!u.id) throw new Error(`no local user ${email}`);
  const s = await call(null, 'POST', 'auth/v1/token?grant_type=password', { email, password });
  if (!s.json || !s.json.access_token) throw new Error(`no sign-in for ${email}`);
  return { id: u.id, token: s.json.access_token };
}
const scrub = t => String(t).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>');
const required = r => /library_write_required/.test(r.text || r.message || '');
const misconfigured = r => /library_write_misconfigured/.test(r.text || r.message || '');

// ═══ The schema ═══
section('install');
if (!ok(Q(`select to_regclass('public.tv_shows') is null`) === 't', 'the stack is fresh')) process.exit(1);
psql(`create extension if not exists pg_graphql; comment on schema public is '@graphql({"introspection": true})'`);
for (const f of ['db/test/replica_schema.sql', 'db/phase0_restore_v1.sql', 'db/phase1b_ownership.sql', 'db/restore_backup.sql', 'db/phase1c_tv_schema.sql', 'db/tv_model.sql', 'db/rpc.sql', 'db/admin/tv_enrich.sql']) psql(sql(f));
psql(`update private.migration_stage set stage = 'final'`);
for (const f of ['db/phase3b_org.sql', 'db/phase3b2_org_write.sql', 'db/phase4a_catalog.sql', 'db/phase4b_add_to_show.sql', 'db/phase5a_expand.sql', 'db/phase5c_contract.sql']) psql(sql(f));
psql(`select set_config('watchlist.b45_choices', '{"shows": {}, "films": {}}', false);\n` + sql('db/b45_expand.sql'));
const A = await account('w1-a@test.invalid'), B = await account('w1-b@test.invalid');
psql(`begin; select set_config('watchlist.library_write', 'on', true); set local xmloption = 'document';
  insert into private.stage5_recovery_meta (user_id, origin, counts, hashes) select bootstrap_owner_id, 'contraction', '{}'::jsonb, '{}'::jsonb from private.app_owner; commit;`);
psql(`select set_config('watchlist.m1_owner', '${A.id}', false), set_config('watchlist.m1_run', 'local-m1', false);\n` + sql('db/m1_access.sql'));
psql(`select set_config('watchlist.ep1_run', 'local-ep1', false);\n` + sql('db/ep1_episode_marks.sql'));
psql(`select set_config('watchlist.enrich_run', 'local-enrich', false);\n` + sql('db/admin/tv_enrich_partial.sql'));
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
psql(`select set_config('watchlist.cu2_run', 'local-cu2', false), set_config('watchlist.cu2_owner', '${A.id}', false);\n` + sql('db/cu2_research_access.sql'));
psql(`select set_config('watchlist.test_project', 'local', false);\n` + sql('db/test/m1_test_marker.sql'));
const installCu1e = () => ok(/CU1E\|/.test(psqlAs('postgres', `select set_config('watchlist.cu1e_run', 'local-cu1e', false);\n` + fs.readFileSync(CU1E, 'utf8'))), 'CU1e installs here');
if (CU1E && argv.includes('--cu1e-first')) installCu1e();

const W1 = run => `select set_config('watchlist.w1_run', '${run}', false);\n` + sql('db/w1_write_scope.sql');
const noRun = tryPsql(sql('db/w1_write_scope.sql'));
ok(!noRun.ok && /set watchlist\.w1_run/.test(noRun.message), 'no run id: refused', noRun.message);
const inst = tryPsql(W1('local-w1'));
if (!ok(inst.ok && /W1\|.*"functions" ?: ?38/.test(inst.out), 'db/w1_write_scope.sql commits, 38 functions', inst.message || inst.out)) process.exit(1);
const again = tryPsql(W1('local-w1b'));
ok(!again.ok && /already installed/.test(again.message), 'a rerun is refused', again.message);
if (CU1E && !argv.includes('--cu1e-first')) installCu1e();
await sleep(2000);

// ═══ The catalog ═══
section('catalog');
const fnRows = JSON.parse(Q(`select json_agg(json_build_object('sig', p.oid::regprocedure::text, 'schema', n.nspname, 'name', p.proname, 'src', p.prosrc, 'conf', p.proconfig, 'exec', has_function_privilege('authenticated', p.oid, 'execute'), 'trig', p.prorettype = 'trigger'::regtype))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')`));
const hasClause = f => (f.conf || []).includes('xmloption=document');
const clause = fnRows.filter(hasClause);
ok(clause.filter(f => f.schema === 'public').length === 35 && clause.filter(f => f.schema === 'private').length === 3, '35 public entry functions and 3 enrichment functions carry the clause', clause.length);
ok(clause.every(f => f.conf.some(c => c.startsWith('search_path='))), 'each keeps its search_path');
ok(fnRows.filter(f => f.schema === 'public' && /lib_write_on|watchlist\.library_write/.test(f.src)).every(hasClause), 'every public function that names the write scope has it');
ok(clause.filter(f => f.schema === 'private').every(f => !f.exec), 'no application role can execute the enrichment functions');
const guarded = Q(`select string_agg(distinct format('%s.%s', n.nspname, c.relname), ' ') from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and t.tgfoid in ('private.library_write_guard()'::regprocedure, 'private.b45_show_guard()'::regprocedure)`).split(' ');
ok(guarded.length >= 20 && guarded.includes('public.tv_shows') && guarded.includes('public.update_holds'), `${guarded.length} guarded tables`, guarded.join(' '));
// Who writes a guarded table, directly or through a private helper: each entry point an application role can reach.
const writes = f => guarded.some(t => { const n = t.split('.')[1]; return new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+(public\\.|private\\.)?${n}\\b`, 'i').test(f.src); });
const callees = f => fnRows.filter(g => g.schema === 'private' && g.name !== f.name && new RegExp(`\\b${g.name}\\s*\\(`).test(f.src));
const reach = (f, seen = new Set()) => { if (seen.has(f.sig)) return false; seen.add(f.sig); return writes(f) || callees(f).some(g => reach(g, seen)); };
const noClauseWriters = fnRows.filter(f => f.schema === 'public' && f.exec && !f.trig && !hasClause(f) && reach(f)).map(f => f.name).sort();
const allowed = ['org_create_collection', 'org_rename_collection', 'org_set_collection_archived', 'set_season_skipped', 'set_season_watched'];
ok(noClauseWriters.every(n => allowed.includes(n)), `entry points without the clause that reach a guarded table are the known ones (${[...new Set(noClauseWriters)].join(', ') || 'none'})`, noClauseWriters.join(', '));
// A caller that wrote after a nested call relied on the flag outliving the callee; the clause doesn't.
const nestedCallers = fnRows.filter(f => !hasClause(f) && !f.trig && clause.some(g => g.schema === 'public' && g.name !== f.name && new RegExp(`\\b${g.name}\\s*\\(`).test(f.src))).map(f => f.sig);
ok(nestedCallers.length === 0, 'no function without the clause calls one with it', nestedCallers.join(', '));
const trigWriters = fnRows.filter(f => f.trig && !/guard/.test(f.name) && writes(f)).map(f => f.sig);
info(`trigger functions that write a guarded table run inside the writing statement: ${trigWriters.join(', ') || 'none'}`);
const deferred = Q(`select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgdeferrable and p.proname !~ '^RI_FKey_(noaction|check)_'`);
ok(deferred === '0', 'no deferred trigger writes (it would fire at commit, after every function)', deferred);
const namesIt = Q(`select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') from pg_proc p where p.prosrc ~* 'xml\\s*_?option' and p.oid not in ('private.lib_authorized()'::regprocedure, 'private.lib_write_on()'::regprocedure)
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))`);
ok(namesIt === '', 'no function an application role can execute names the setting, in any schema', namesIt);
ok(Q(`select current_setting('xmloption') || '|' || (select reset_val || '|' || source from pg_settings where name = 'xmloption') || '|' || (select count(*) from pg_db_role_setting s, unnest(s.setconfig) x where lower(x) like 'xmloption=%')`) === 'content|content|default|0',
  'outside a function: content, at its default, configured nowhere');
ok(Q(`select bool_or(has_schema_privilege(r, s, 'create')) from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['public', 'private']) s`) === 'f', 'no application role can create functions');
ok(Q(`select to_regprocedure('private.lib_write_on()') is not null and (select prosrc !~ 'set_config' from pg_proc where oid = 'private.lib_write_on()'::regprocedure)`) === 't', 'lib_write_on sets nothing');

// ═══ Ordinary work through the API ═══
section('ordinary work through the API');
const fixture = async (who, label, tmdb) => {
  const key = label.toLowerCase();
  const r = await rpc(who.token, 'library_create_show_b45', { p_show: { tmdb_id: tmdb, title: label, show_key: key, network: 'ZZ' },
    p_seasons: [1, 2].map(n => ({ item_key: `${key}|season ${n}`, title: label, season: `Season ${n}`, theme: 'ZZ', display_date: `Jan 1, 202${n}`, date_sort: `202${n}-01-01`, season_number: n })) });
  if (!r.ok) throw new Error(r.text);
  const rows = (await rest(who.token, 'GET', `watchlist_items?select=*&show_id=eq.${r.json.show.id}&order=date_sort`)).json;
  return { show: r.json.show, rows };
};
const F = await fixture(A, 'ZZ W1 Show', 990901);
ok(F.rows.length === 2, 'a show is created');
const st = await rpc(A.token, 'library_set_show_state_b45', { p_show_id: F.show.id, p_expected: JSON.parse(Q(`select private.b45_show_state(s) from public.tv_shows s where id = '${F.show.id}'`)), p_changes: { priority: 'high' } });
ok(st.ok, 'a show’s state changes', st.text);
const coll = crypto.randomUUID();
ok((await rpc(A.token, 'org_create_collection', { p_id: coll, p_name: 'ZZ W1 Coll' })).ok, 'a collection is created (no clause, an unguarded table)');
const added = await rpc(A.token, 'org_add_membership', { p_collection_id: coll, p_show_id: F.show.id });
ok(added.ok, 'a membership is added', added.text);
const rm = await rpc(A.token, 'org_remove_membership', { p_membership_id: added.json.membership.id, p_collection_id: coll, p_show_id: F.show.id });
ok(rm.ok && rm.json.removed === true, 'and removed, its removal remembered', rm.text);
ok((await rest(A.token, 'GET', `membership_removals?select=id&collection_id=eq.${coll}`)).json.length === 1, 'the remembered removal is there');
const hold = await rpc(A.token, 'library_cu_save_hold', { p_hold: { kind: 'standing_decision', subject_label: 'ZZ W1', decision: 'x', effect: 'do_not_add', reopen: { on: 'owner_only' } } });
ok(hold.ok, 'a hold is saved', hold.text);
const wt = await rpc(A.token, 'set_season_watched', { p_row_id: F.rows[0].id, p_watched: true });
ok(wt.ok, 'a season is marked Watched (no clause: not a guarded write)', wt.text);
const eps = [{ tmdb_episode_id: 1, episode_number: 1 }];
const mk = await rpc(A.token, 'library_set_episode_marks', { p_season_id: F.rows[1].id, p_expected: { watched: false, skipped: false }, p_watched: true, p_episodes: eps });
ok(mk.ok, 'an episode is marked', mk.text);
const mw = await rpc(A.token, 'library_add_watched_season_marks', { p_season_id: F.rows[0].id, p_expected: { show_id: F.show.id, show_tmdb_id: F.show.tmdb_id, tmdb_id: F.rows[0].tmdb_id, season_number: 1, watched: true, skipped: false }, p_episodes: eps });
ok(mw.ok, 'marks are added on a Watched season', mw.text);
const del1 = await rpc(A.token, 'delete_tv_season', { p_row_id: F.rows[1].id, p_marks_expected: 1 });
ok(del1.ok, 'a season is deleted', del1.text);
const film = await rpc(A.token, 'library_create_film_b45', { p_film: { item_key: 'zz w1 film|film', title: 'ZZ W1 Film', season: 'Film', theme: 'ZZ', display_date: 'Jan 1, 2020', date_sort: '2020-01-01' } });
ok(film.ok, 'a film is created', film.text);
const filmId = (await rest(A.token, 'GET', `watchlist_items?select=id&item_key=eq.${encodeURIComponent('zz w1 film|film')}`)).json[0].id;
const fd = await rest(A.token, 'DELETE', `watchlist_items?id=eq.${filmId}`, undefined, { Prefer: 'return=representation' });
ok(fd.ok && fd.json.length === 1, 'the page’s direct delete of a film still works (item 11, unchanged)', fd.text);

section('restore through the API');
function backupOf(who) {
  const out = psql(execFileSync(process.execPath, [path.join(ROOT, 'tools/admin-restore.mjs'), 'export-sql', '--owner', who.id], { encoding: 'utf8' }));
  return JSON.parse(out.slice(out.indexOf('{"format"'), out.lastIndexOf('}') + 1));
}
const doc7 = backupOf(A);
const restored = await rpc(A.token, 'restore_backup', { p_backup: doc7, p_allow_v1_reset: false });
ok(restored.ok, 'a format-7 restore runs', restored.text);
const doc7b = backupOf(A);
ok(JSON.stringify(doc7.rowCounts) === JSON.stringify(doc7b.rowCounts), 'row counts unchanged by the round trip', JSON.stringify(doc7b.rowCounts));
const f0 = await fixture(A, 'ZZ W1 Rollback', 990902);
const broken = JSON.parse(JSON.stringify(doc7)); broken.tables.tv_shows = 'not a table';
const rb = await rpc(A.token, 'restore_backup', { p_backup: broken, p_allow_v1_reset: false });
ok(!rb.ok && (await rest(A.token, 'GET', `tv_shows?select=id&id=eq.${f0.show.id}`)).json.length === 1, 'a refused restore changes nothing', rb.text);

section('admin paths');
const r1 = tryPsql(`update public.tv_shows set ended = true where id = '${F.show.id}'`);
ok(!r1.ok && required(r1), 'as postgres at the top level, no scope: refused', r1.message);
const r2 = tryPsql(`begin; set local xmloption = 'document'; update public.tv_shows set ended = true where id = '${F.show.id}'; commit;`);
ok(r2.ok && Q(`select ended from public.tv_shows where id = '${F.show.id}'`) === 't', 'set local xmloption in one transaction: the runbook path works', r2.message);
ok(Q(`select current_setting('xmloption')`) === 'content', 'and ends with its transaction');
const r3 = tryPsql(`begin; set local xmloption = 'document'; update public.watchlist_items set title = title where id = '${F.rows[0].id}'; rollback; update public.tv_shows set ended = false where id = '${F.show.id}';`);
ok(!r3.ok && required(r3), 'it doesn’t outlive a rollback on the same connection', r3.message);
const en = tryPsql(`begin;
  insert into public.tv_shows (id, user_id, title, show_key, status) values ('00000000-0000-4000-8000-0000000000e1', '${A.id}', 'ZZ W1 Enrich', 'zz w1 enrich', 'Backlog');
  rollback;`);
ok(!en.ok && required(en), 'a direct insert as postgres: refused', en.message);
const legacy = async label => {
  const key = label.toLowerCase();
  const r = await rpc(A.token, 'library_create_show_b45', { p_show: { title: label, show_key: key, network: 'ZZ' },
    p_seasons: [1, 2].map(n => ({ item_key: `${key}|season ${n}`, title: label, season: `Season ${n}`, theme: 'ZZ', display_date: n === 1 ? 'Jan 1, 2021' : 'TBA', date_sort: n === 1 ? '2021-01-01' : '2099-12-31' })) });
  if (!r.ok) throw new Error(r.text);
  return { id: r.json.show.id, rows: (await rest(A.token, 'GET', `watchlist_items?select=id,season&show_id=eq.${r.json.show.id}&order=date_sort`)).json };
};
const refusedScope = r => /library_write_scope|library_write_required/.test(r.message || '');
const L1 = await legacy('ZZ W1 Strict'), L2 = await legacy('ZZ W1 Partial');
const seasonsJ = L => JSON.stringify(L.rows.map((x, i) => ({ row_id: x.id, season: x.season, season_number: i + 1 })));
const e1 = tryPsql(`select private.tv_enrich_show('${L1.id}', 'ZZ W1 Strict', 990911, '${seasonsJ(L1)}'::jsonb, true)`);
ok(e1.ok && Q(`select tmdb_id from public.tv_shows where id = '${L1.id}'`) === '990911', 'tv_enrich_show applies under its clause', e1.message);
const e2 = tryPsql(`select private.tv_enrich_show_partial('${A.id}', '${L2.id}', 'ZZ W1 Partial', 990912, '${JSON.stringify([{ row_id: L2.rows[0].id, season: 'Season 1', season_number: 1 }])}'::jsonb, '${JSON.stringify([{ row_id: L2.rows[1].id, season: 'Season 2' }])}'::jsonb, true)`);
ok(e2.ok && Q(`select tmdb_id from public.tv_shows where id = '${L2.id}'`) === '990912', 'tv_enrich_show_partial applies under its clause', e2.message);
const e3 = tryPsql(`select private.tv_enrich_season('${A.id}', '${L2.id}', 'ZZ W1 Partial', 990912, '${L2.rows[1].id}', 'Season 2', 2, true)`);
ok(e3.ok && Q(`select season_number from public.watchlist_items where id = '${L2.rows[1].id}'`) === '2', 'tv_enrich_season applies under its clause', e3.message);
ok(!refusedScope(e1) && !refusedScope(e2) && !refusedScope(e3) && Q(`select current_setting('xmloption')`) === 'content', 'none needed a scope from outside');

// ═══ Scope ═══
section('nested calls, exceptions and savepoints');
// One transaction as member A, the way a chained request runs, on one connection.
const asA = body => `begin; select set_config('request.jwt.claims', '{"sub": "${A.id}", "role": "authenticated"}', true); set local role authenticated;\n${body}\ncommit;`;
const S = await fixture(A, 'ZZ W1 Scope', 990903), R0 = S.rows[0].id;
const direct = `update public.watchlist_items set season_number = 99 where id = '${R0}'`;
const failing = `public.delete_tv_season('${R0}', 5)`;
const titleNow = () => Q(`select season_number from public.watchlist_items where id = '${R0}'`);
const t0 = titleNow();
const scope = [
  ['a successful function, then a direct write', `select public.library_cu_set_show_settings('${S.show.id}', '{"follow_when_skipped": false, "flagged": false}'::jsonb, false, false); ${direct};`],
  ['a function that failed under a savepoint, then a direct write', `savepoint s; do $$ begin perform ${failing}; exception when others then null; end $$; ${direct};`],
  ['a rolled-back savepoint with a function in it, then a direct write', `savepoint s; select public.library_cu_set_show_settings('${S.show.id}', '{"follow_when_skipped": false, "flagged": false}'::jsonb, false, false); rollback to savepoint s; ${direct};`],
  ['the flag itself, set by hand (the old route)', `select set_config('watchlist.library_write', 'on', true); ${direct};`]
];
for (const [label, body] of scope) {
  const r = tryPsql(asA(body));
  ok(!r.ok && required(r) && titleNow() === t0, `${label}: refused`, r.message || r.out);
}
const nestedProbe = tryPsql(`begin;
create function pg_temp.zz_inner() returns text language plpgsql set xmloption = 'document' as $$ begin return current_setting('xmloption'); end $$;
create function pg_temp.zz_err() returns void language plpgsql set xmloption = 'document' as $$ begin raise exception 'x'; end $$;
create function pg_temp.zz_outer() returns text language plpgsql set xmloption = 'document' as $$
declare a text; begin
  a := pg_temp.zz_inner();
  begin perform pg_temp.zz_err(); exception when others then null; end;
  return a || '|' || current_setting('xmloption');
end $$;
select pg_temp.zz_outer() || '|' || current_setting('xmloption');
rollback;`);
ok(nestedProbe.ok && nestedProbe.out.trim().endsWith('document|document|content'), 'nested clauses and a caught failure inside one leave the outer scope intact, and the default after it', nestedProbe.out || nestedProbe.message);
const inSave = tryPsql(asA(`savepoint s; select public.delete_tv_season('${S.rows[1].id}', 0); rollback to savepoint s; select public.delete_tv_season('${S.rows[1].id}', 0);`));
ok(inSave.ok && Q(`select count(*) from public.watchlist_items where id = '${S.rows[1].id}'`) === '0', 'a library function runs again after a rolled-back savepoint', inSave.message);
const noClause = tryPsql(asA(`select private.lib_write_on();`));
ok(!noClause.ok && /library_write_scope/.test(noClause.message), 'lib_write_on outside a function: a clear refusal', noClause.message);

section('direct writes through the API');
const before = JSON.stringify((await rest(A.token, 'GET', `watchlist_items?select=*&id=eq.${R0}`)).json);
const u = await rest(A.token, 'PATCH', `watchlist_items?id=eq.${R0}`, { season_number: 99 }, { Prefer: 'return=representation' });
ok(!u.ok && required(u), 'REST update of a season: refused', u.text);
const us = await rest(A.token, 'PATCH', `tv_shows?id=eq.${S.show.id}`, { status: 'Watched' }, { Prefer: 'return=representation' });
ok(!us.ok && required(us), 'REST update of a show’s status: refused', us.text);
const ins = await rest(A.token, 'POST', 'update_setup', { source: 'setup_file' });
ok(!ins.ok && (required(ins) || /research/.test(ins.text)), 'REST insert into a guarded table: refused', ins.text);
const dl = await rest(A.token, 'DELETE', `membership_removals?collection_id=eq.${coll}`);
ok(!dl.ok && required(dl), 'REST delete from a guarded table: refused', dl.text);
const hdr = await rest(A.token, 'GET', 'tv_shows?select=id&limit=1', undefined, { 'Accept-Profile': 'private' });
ok(!hdr.ok, 'the private schema can’t be selected by a header', hdr.text);
for (const f of ['set_config', 'lib_write_on', 'lib_authorized']) {
  const r = await rpc(A.token, f, {});
  ok(!r.ok && r.status === 404, `/rpc/${f}: not found`, r.text);
}
const pre = await gql(A.token, `{ __schema { mutationType { fields { name } } } }`);
const names = (pre.json && pre.json.data && pre.json.data.__schema.mutationType.fields || []).map(f => f.name);
if (ok(names.includes('updatetv_showsCollection') && names.includes('library_cu_set_show_settings'), 'pg_graphql is on here, so the checks below are real', pre.text)) {
  ok(!names.some(n => /^(set_config|lib_)/.test(n)), 'and exposes no way to set a setting');
}

section('chained GraphQL mutations');
const net0 = () => Q(`select ended from public.tv_shows where id = '${S.show.id}'`);
const fnA = `a: library_cu_set_show_settings(p_show_id: "${S.show.id}", p_expected: "{\\"follow_when_skipped\\": false, \\"flagged\\": false}", p_follow_when_skipped: false, p_clear_ended_flag: false)`;
const fnFail = `a: delete_tv_season(p_row_id: "${R0}", p_marks_expected: 5)`;
const n0 = net0();
for (const [label, first] of [['a successful function', fnA], ['a failed function', fnFail]]) {
  const r = await gql(A.token, `mutation { ${first}\n b: updatetv_showsCollection(set: { ended: true }, filter: { id: { eq: "${S.show.id}" } }, atMost: 1) { affectedCount } }`);
  ok(net0() === n0, `${label}, then an update of a show: nothing changed`, r.text);
  if (first === fnA) ok(required(r), 'refused by the guard', r.text);
}
const g2 = await gql(A.token, `mutation { ${fnA}\n b: updatewatchlist_itemsCollection(set: { season_number: 99 }, filter: { id: { eq: "${R0}" } }, atMost: 1) { affectedCount } }`);
ok(required(g2) && JSON.stringify((await rest(A.token, 'GET', `watchlist_items?select=*&id=eq.${R0}`)).json) === before, 'a function, then an update of a season: refused', g2.text);
const g3 = await gql(A.token, `mutation { ${fnA}\n b: deleteFrommembership_removalsCollection(filter: { collection_id: { eq: "${coll}" } }, atMost: 1) { affectedCount } }`);
ok(required(g3) && Q(`select count(*) from public.membership_removals where collection_id = '${coll}'`) === '1', 'a function, then a delete from a guarded table: refused', g3.text);
const g4 = await gql(A.token, `mutation($d: JSON!) { a: restore_backup(p_backup: $d, p_allow_v1_reset: false)
  b: updatetv_showsCollection(set: { ended: true }, filter: { id: { eq: "${S.show.id}" } }, atMost: 1) { affectedCount } }`, { d: JSON.stringify(backupOf(A)) });
ok(required(g4) && net0() === n0, 'a restore, then an update of a show, one request: refused', g4.text);
const g5 = await gql(A.token, `mutation { b: updatetv_showsCollection(set: { ended: true }, filter: { id: { eq: "${S.show.id}" } }, atMost: 1) { affectedCount } }`);
ok(required(g5) && net0() === n0, 'a direct GraphQL update alone: refused', g5.text);

// ═══ Defaults ═══
const reachA = () => rpc(A.token, 'library_cu_set_show_settings', { p_show_id: S.show.id, p_expected: { follow_when_skipped: false, flagged: false }, p_follow_when_skipped: false, p_clear_ended_flag: false });
const directA = () => rest(A.token, 'PATCH', `tv_shows?id=eq.${S.show.id}`, { ended: true }, { Prefer: 'return=representation' });
const restartRest = async () => {
  execFileSync('docker', ['restart', REST_CONTAINER], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { await sleep(500); try { if ((await rest(A.token, 'GET', 'tv_shows?select=id&limit=1')).ok) return; } catch (e) { /* still starting */ } }
  throw new Error('PostgREST did not come back');
};
const reloadConfig = async () => { psql(`notify pgrst, 'reload config'; notify pgrst, 'reload schema';`); await sleep(1800); };
const healthy = async label => {
  const d = await directA(), f = await reachA();
  ok(required(d) && f.ok && net0() === n0, `${label}: direct write refused, function works, nothing leaked`, `${d.text} | ${f.text}`);
};
await healthy('before any default');

// What a pooled connection sees: its current value against its configured default.
const stateFn = `create function public.zz_state() returns jsonb language sql as $$ select jsonb_build_object('cur', current_setting('xmloption'), 'reset', (select reset_val from pg_settings where name = 'xmloption'), 'source', (select source from pg_settings where name = 'xmloption')) $$;
  grant execute on function public.zz_state() to authenticated; notify pgrst, 'reload schema';`;
psql(stateFn); await sleep(1800);
const state = async () => { const r = await rpc(A.token, 'zz_state', {}); return r.ok ? `${r.json.cur}/${r.json.reset}/${r.json.source}` : scrub(r.text); };
ok(await state() === 'content/content/default', 'a healthy connection: content, content, default', await state());
section('poisoned defaults: database and roles');
const poisons = [
  ['the database', `alter database postgres set xmloption = 'document'`, `alter database postgres reset xmloption`, 'document/document/database'],
  ['the authenticated role (PostgREST applies it to each request, and reset_val stays content)', `alter role authenticated set xmloption = 'document'`, `alter role authenticated reset xmloption`, 'document/content/session'],
  ['the authenticated role in this database', `alter role authenticated in database postgres set xmloption = 'document'`, `alter role authenticated in database postgres reset xmloption`, 'content/content/default'],
  ['the authenticator role', `alter role authenticator set xmloption = 'document'`, `alter role authenticator reset xmloption`, 'document/document/user'],
  ['every role', `alter role all set xmloption = 'document'`, `alter role all reset xmloption`, 'document/document/global'],
  ['a role, at the harmless-looking value', `alter role authenticated set xmloption = 'content'`, `alter role authenticated reset xmloption`, 'content/content/session']
];
for (const [label, on, off, expected] of poisons) {
  const allowed2 = tryPsql(`${on};`, 'supabase_admin');
  if (!ok(allowed2.ok, `${label}: applied`, allowed2.message)) continue;
  await reloadConfig(); await restartRest();
  const seen = await state();
  ok(seen === expected, `${label}: a pooled connection sees ${seen} (current/reset/source)`, seen);
  const d = await directA(), f = await reachA();
  ok(!d.ok && (misconfigured(d) || required(d)) && net0() === n0, `${label}: a direct write is refused`, d.text); // required where the connection is at content
  ok(!f.ok && misconfigured(f), `${label}: a library function fails with the cause named`, f.text);
  const chain = await gql(A.token, `mutation { b: updatetv_showsCollection(set: { ended: true }, filter: { id: { eq: "${S.show.id}" } }, atMost: 1) { affectedCount } }`);
  ok(net0() === n0, `${label}: a direct GraphQL write is refused`, chain.text);
  tryPsql(`${off};`, 'supabase_admin');
  await reloadConfig(); await restartRest();
  await healthy(`${label}, removed`);
}

section('poisoned defaults: the server and the connection');
const sys = tryPsql(`alter system set xmloption = 'document';`, 'supabase_admin');
if (ok(sys.ok, 'alter system applied', sys.message)) {
  psqlAs('supabase_admin', `select pg_reload_conf();`); await sleep(1500);
  ok(Q(`select reset_val || '|' || source from pg_settings where name = 'xmloption'`).startsWith('document|'), 'the server default is now document: reset_val shows it, the catalog doesn’t');
  ok(Q(`select count(*) from pg_db_role_setting s, unnest(s.setconfig) x where lower(x) like 'xmloption=%'`) === '0', 'no database or role entry');
  await restartRest();
  const d = await directA(), f = await reachA();
  ok(!d.ok && misconfigured(d) && net0() === n0, 'a direct write: refused, the cause named', d.text);
  ok(!f.ok && misconfigured(f), 'a library function: refused, the cause named', f.text);
  psqlAs('supabase_admin', `alter system reset xmloption;`); psqlAs('supabase_admin', `select pg_reload_conf();`); await sleep(1500);
  await restartRest();
  await healthy('the server default, removed');
}
const conn = tryPsql(`select current_setting('xmloption') || '|' || (select reset_val from pg_settings where name = 'xmloption'); update public.tv_shows set ended = true where id = '${S.show.id}';`, 'postgres', { PGOPTIONS: '-c xmloption=document' });
ok(!conn.ok && misconfigured(conn) && net0() === n0, 'a connection started with xmloption=document: refused, though it looks like a function’s scope', conn.message);
const connFn = tryPsql(asA(`select public.library_cu_set_show_settings('${S.show.id}', '{"follow_when_skipped": false, "flagged": false}'::jsonb, false, false);`), 'postgres', { PGOPTIONS: '-c xmloption=document' });
ok(!connFn.ok && misconfigured(connFn), 'and a library function on it', connFn.message);

section('a connection that kept a default after it was removed');
psqlAs('supabase_admin', `alter role authenticator set xmloption = 'document';`);
await restartRest();
psqlAs('supabase_admin', `alter role authenticator reset xmloption;`);
ok(await state() === 'document/document/user', 'the catalog is clean again, the connection isn’t', await state());
const stale = await reachA(), staleD = await directA();
ok(!stale.ok && misconfigured(stale) && !staleD.ok, 'pooled connections opened under it refuse until they restart (reset_val: fail closed)', stale.text);
await restartRest();
await healthy('restarted');

section('the migration refuses a state it can’t trust');
psql(`drop function public.zz_state(); notify pgrst, 'reload schema';`);
ok(tryPsql(sql('db/test/w1_reverse.sql')).ok, 'W1 reversed (test environment)');
psqlAs('supabase_admin', `alter role authenticated set xmloption = 'document';`);
const pz = tryPsql(W1('local-w1-p'));
ok(!pz.ok && /configured for a database or role/.test(pz.message), 'a role default: refused', pz.message);
psqlAs('supabase_admin', `alter role authenticated reset xmloption;`);
psql(`create function public.zz_names_it() returns void language sql as $$ select set_config('xmloption', 'document', false) $$;`);
const pn = tryPsql(W1('local-w1-n'));
ok(!pn.ok && /source names xmloption/.test(pn.message), 'a function that names the setting: refused', pn.message);
psql(`drop function public.zz_names_it();`);
psql(`create function public.zz_stray() returns void language plpgsql as $$ begin perform private.lib_write_on(); end $$;`);
const ps = tryPsql(W1('local-w1-s'));
ok(!ps.ok && /doesn't name/.test(ps.message), 'a library function outside the list: refused', ps.message);
psql(`drop function public.zz_stray();`);
const inst2 = tryPsql(W1('local-w1-2'));
ok(inst2.ok, 'and it installs once the state is clean', inst2.message);
await sleep(1500);
await healthy('reinstalled');

section('a later replacement that loses the clause fails clearly');
psql(`alter function public.library_cu_set_show_settings(uuid, jsonb, boolean, boolean) reset xmloption`);
const lost = await reachA();
ok(!lost.ok && /library_write_scope|library_write_required/.test(lost.text), 'the function refuses, nothing half-done', lost.text);
psql(`alter function public.library_cu_set_show_settings(uuid, jsonb, boolean, boolean) set xmloption = 'document'`);

// ═══ The pool ═══
section('pooled connections');
psql(`create function public.zz_probe() returns jsonb language sql as $$ select jsonb_build_object('pid', pg_backend_pid(), 'x', current_setting('xmloption')) $$;
  create function public.zz_sleep(p double precision) returns void language plpgsql set xmloption = 'document' as $$ begin perform pg_sleep(p); end $$;
  create function public.zz_leak() returns void language plpgsql as $$ begin set xmloption = 'document'; end $$;
  create function public.zz_leak2() returns void language sql as $$ select set_config('xmloption', 'document', false) $$;
  grant execute on function public.zz_probe(), public.zz_sleep(double precision), public.zz_leak(), public.zz_leak2() to authenticated;
  notify pgrst, 'reload schema';`);
await sleep(2000);
const sweep = async n => {
  const rs = await Promise.all(Array.from({ length: n }, () => rpc(A.token, 'zz_probe', {})));
  return { pids: new Set(rs.map(r => r.json && r.json.pid)), bad: rs.filter(r => !r.json || r.json.x !== 'content').length, any: rs.length };
};
const s0 = await sweep(60);
ok(s0.bad === 0 && s0.pids.size >= 2, `every pooled connection starts a request at content (${s0.pids.size} connections)`, JSON.stringify([...s0.pids]));
await Promise.all(Array.from({ length: 30 }, () => reachA()));
await Promise.all(Array.from({ length: 30 }, () => rpc(A.token, 'delete_tv_season', { p_row_id: R0, p_marks_expected: 5 })));
await Promise.all(Array.from({ length: 10 }, () => gql(A.token, `mutation { ${fnA}\n b: updatetv_showsCollection(set: { ended: true }, filter: { id: { eq: "${S.show.id}" } }, atMost: 1) { affectedCount } }`)));
const s1 = await sweep(60);
ok(s1.bad === 0, 'after successes, failures and refused chains: still content on all of them', s1.bad);
const sl = rpc(A.token, 'zz_sleep', { p: 8 });
await sleep(1200);
const cancelled = Q(`select count(pg_cancel_backend(pid)) from pg_stat_activity where query ~ 'zz_sleep' and pid <> pg_backend_pid() and state = 'active'`);
const slr = await sl;
ok(!slr.ok && cancelled !== '0', 'a function cancelled inside its clause', slr.text);
const s2 = await sweep(60);
ok(s2.bad === 0, 'still content on all of them after the cancellation', s2.bad);
const sk = rpc(A.token, 'zz_sleep', { p: 8 });
await sleep(1200);
Q(`select count(pg_terminate_backend(pid)) from pg_stat_activity where query ~ 'zz_sleep' and pid <> pg_backend_pid() and state = 'active'`);
await sk.catch(() => {});
await sleep(800);
const s3 = await sweep(60);
ok(s3.bad === 0, 'and after a connection is killed inside its clause', s3.bad);
ok(required(await directA()) && net0() === n0, 'a direct write is still refused after all of it');

section('the leak the guard can’t see');
// Deliberate: proves the limit the migration's catalog check exists for. Then the whole pool restarts.
await Promise.all(Array.from({ length: 40 }, () => rpc(A.token, 'zz_leak', {})));
const s4 = await sweep(60);
info(`a function with a session-level SET leaked to ${s4.bad}/60 later requests`);
const viaLeak = await directA();
info(`a direct write ${viaLeak.ok ? 'WENT THROUGH' : 'was refused'} on such a connection`);
ok(s4.bad > 0, 'the limit is real: a session-level SET in a function survives the request');
const flagged = Q(`select string_agg(proname, ', ' order by proname) from pg_proc p where p.prosrc ~* 'xml\\s*_?option' and p.oid not in ('private.lib_authorized()'::regprocedure, 'private.lib_write_on()'::regprocedure) and has_function_privilege('authenticated', p.oid, 'execute')`);
ok(/zz_leak, zz_leak2/.test(flagged), 'and the catalog check names both spellings of such a function', flagged);
psql(`drop function public.zz_leak(); drop function public.zz_leak2(); drop function public.zz_sleep(double precision); drop function public.zz_probe(); notify pgrst, 'reload schema';`);
psql(`begin; set local xmloption = 'document'; update public.tv_shows set ended = false where id = '${S.show.id}'; commit;`);
await restartRest();
await healthy('the pool restarted');

section('end state');
ok(Q(`select count(*) from pg_db_role_setting s, unnest(s.setconfig) x where lower(x) like 'xmloption=%'`) === '0', 'no default left behind');
ok(Q(`select reset_val || '|' || source from pg_settings where name = 'xmloption'`) === 'content|default', 'at its default');
ok(spawnSync('true').status === 0, 'done');

console.log(failed ? `\nFAILED: ${failed} check(s)` : `\nALL ${passed} CHECKS PASSED`);
process.exit(failed ? 1 : 0);
