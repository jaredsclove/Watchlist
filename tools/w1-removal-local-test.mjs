// The W1 removal on a local Supabase stack: real Auth, PostgREST and tokens, synthetic data. Builds production's order, with CU1e before W1,
// snapshots the catalog before W1, installs W1, then proves db/w1_removal.sql gives that catalog back and that the app's work still runs.
//   LOCAL_SERVICE_KEY=… node tools/w1-removal-local-test.mjs --api http://127.0.0.1:54321 --key <anon key> --container <db container> --backup <format6.json>
// The stack must be fresh. Remove this file with the status read once production is done: nothing else depends on W1.
// Exit 0 only if every check passes.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const API = opt('--api'), KEY = opt('--key'), CONTAINER = opt('--container'), backupFile = opt('--backup'), SERVICE = process.env.LOCAL_SERVICE_KEY;
if (!API || !KEY || !CONTAINER || !backupFile || !SERVICE) { console.error('usage: see the top of this file'); process.exit(2); }
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(API)) { console.error('a local API only'); process.exit(2); }
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
const psqlAsync = text => new Promise((resolve, reject) => { const p = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres']); let o = '', e = ''; p.stdout.on('data', d => { o += d; }); p.stderr.on('data', d => { e += d; }); p.on('close', code => code ? reject(new Error(e)) : resolve(o)); p.stdin.end(text); });
const tryPsql = (text, user = 'postgres', env = {}) => { try { return { ok: true, out: psqlAs(user, text, env) }; } catch (e) { return { ok: false, message: String(e.stderr || e.message) }; } };
const Q = text => psql(text).trim();
const batch = text => { try { return { ok: true, out: execFileSync('docker', ['exec', CONTAINER, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', text], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { ok: false, message: String(e.stderr || e.message) }; } };
// One connection kept open, to hold a transaction while another session changes the configuration.
async function call(token, method, p, body, extra = {}) {
  const res = await fetch(`${API}/${p}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${token || KEY}`, 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}
const rpc = (t, fn, args) => call(t, 'POST', `rest/v1/rpc/${fn}`, args);
const rest = (t, method, p, body, extra) => call(t, method, `rest/v1/${p}`, body, extra);
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

// ═══ The schema ═══
section('install');
if (!ok(Q(`select to_regclass('public.tv_shows') is null`) === 't', 'the stack is fresh')) process.exit(1);
for (const f of ['db/test/replica_schema.sql', 'db/phase0_restore_v1.sql', 'db/phase1b_ownership.sql', 'db/restore_backup.sql', 'db/phase1c_tv_schema.sql', 'db/tv_model.sql', 'db/rpc.sql', 'db/admin/tv_enrich.sql']) psql(sql(f));
psql(`update private.migration_stage set stage = 'final'`);
for (const f of ['db/phase3b_org.sql', 'db/phase3b2_org_write.sql', 'db/phase4a_catalog.sql', 'db/phase4b_add_to_show.sql', 'db/phase5a_expand.sql', 'db/phase5c_contract.sql']) psql(sql(f));
psql(`select set_config('watchlist.b45_choices', '{"shows": {}, "films": {}}', false);\n` + sql('db/b45_expand.sql'));
const A = await account('w1r-a@test.invalid'), B = await account('w1r-b@test.invalid');
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

psql(`select set_config('watchlist.cu1e_run', 'local-cu1e', false);\n` + sql('db/cu1e_missing_season.sql'));

// Everything that decides what a request may do: function bodies, settings and grants, triggers, policies, table and column grants, role settings.
const catalog = () => JSON.parse(Q(`select json_object_agg(k, v) from (
  select 'fn ' || p.oid::regprocedure::text k, md5(coalesce(p.prosrc, '') || '|' || coalesce(p.proconfig::text, '') || '|' || p.prosecdef || '|' || p.provolatile::text || '|' || coalesce(p.proacl::text, '')) v
    from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
  union all select 'trg ' || t.tgrelid::regclass || ' ' || t.tgname, md5(t.tgfoid::regprocedure::text || t.tgtype::text || t.tgenabled::text || coalesce(pg_get_triggerdef(t.oid), '')) from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace in ('public'::regnamespace, 'private'::regnamespace)
  union all select 'pol ' || schemaname || '.' || tablename || ' ' || policyname, md5(p::text) from pg_policies p where schemaname in ('public', 'private')
  union all select 'acl ' || c.oid::regclass, md5(coalesce(c.relacl::text, '') || (select coalesce(string_agg(a.attname || coalesce(a.attacl::text, ''), ',' order by a.attnum), '') from pg_attribute a where a.attrelid = c.oid)) from pg_class c where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'v')
  union all select 'nsp ' || nspname, md5(coalesce(nspacl::text, '')) from pg_namespace where nspname in ('public', 'private')
  union all select 'role ' || coalesce(s.setrole::regrole::text, '-'), md5(s.setconfig::text) from pg_db_role_setting s
) q`));
const library = () => Q(`select md5(string_agg(t, '|' order by t)) from (
  select to_jsonb(x)::text t from public.tv_shows x union all select to_jsonb(x)::text from public.watchlist_items x union all select to_jsonb(x)::text from public.collection_memberships x
  union all select to_jsonb(x)::text from public.personal_collections x union all select to_jsonb(x)::text from public.custom_collections x union all select to_jsonb(x)::text from public.watch_with_choices x
  union all select to_jsonb(x)::text from public.episode_marks x union all select to_jsonb(x)::text from public.update_holds x union all select to_jsonb(x)::text from public.update_findings x
  union all select to_jsonb(x)::text from public.membership_removals x union all select to_jsonb(x)::text from public.record_aliases x union all select to_jsonb(x)::text from private.library_members x
  union all select to_jsonb(x)::text from private.stage5_recovery_records x) s`);
const status = () => JSON.parse(Q(sql('db/test/w1_removal_status.sql')).match(/W1S\|(\{.*\})/)[1]);
const REMOVAL = run => `select set_config('watchlist.w1_removal_run', '${run}', false);\n` + sql('db/w1_removal.sql');
const before = catalog();
ok(Object.keys(before).length > 300, `the pre-W1 catalog is captured (${Object.keys(before).length} entries)`);

section('W1 as production has it');
ok(/W1\|.*"functions" ?: ?38/.test(psql(`select set_config('watchlist.w1_run', 'local-w1', false);\n` + sql('db/w1_write_scope.sql'))), 'W1 installs');
await sleep(1500);
const s1 = status();
ok(s1.clause_functions === 38 && s1.helper && s1.runs.w1 === 1 && !s1.runs.w1_removal, 'the status read shows W1 in place', JSON.stringify(s1));
const mkShow = async (who, label, tmdb) => {
  const key = label.toLowerCase();
  const r = await rpc(who.token, 'library_create_show_b45', { p_show: { tmdb_id: tmdb, title: label, show_key: key, network: 'ZZ' },
    p_seasons: [1, 2].map(n => ({ item_key: `${key}|season ${n}`, title: label, season: `Season ${n}`, theme: 'ZZ', display_date: `Jan 1, 202${n}`, date_sort: `202${n}-01-01`, season_number: n })) });
  if (!r.ok) throw new Error(r.text);
  return { show: r.json.show, rows: (await rest(who.token, 'GET', `watchlist_items?select=*&show_id=eq.${r.json.show.id}&order=date_sort`)).json };
};
const mkFilm = async (who, label) => { const r = await rpc(who.token, 'library_create_film_b45', { p_film: { title: label, item_key: `${label.toLowerCase()}|film`, season: 'Film', theme: 'ZZ', display_date: 'Jan 1, 2020', date_sort: '2020-01-01' } });
  if (!r.ok) throw new Error(r.text); return (await rest(who.token, 'GET', `watchlist_items?select=id&item_key=eq.${encodeURIComponent(`${label.toLowerCase()}|film`)}`)).json[0].id; };
const seedShow = await mkShow(A, 'ZZ W1R Seed', 990801);
const seedColl = crypto.randomUUID();
await rpc(A.token, 'org_create_collection', { p_id: seedColl, p_name: 'ZZ W1R Seed' });
await rpc(A.token, 'org_add_membership', { p_collection_id: seedColl, p_show_id: seedShow.show.id });

section('a refused or failed removal changes nothing');
let w1Catalog = catalog(); const lib0 = library();
const unchanged = () => JSON.stringify(catalog()) === JSON.stringify(w1Catalog) && library() === lib0;
const noRun = tryPsql(sql('db/w1_removal.sql'));
ok(!noRun.ok && /set watchlist\.w1_removal_run/.test(noRun.message) && unchanged(), 'no run id: refused', noRun.message);
psql(`create extension pg_graphql`);
const withG = tryPsql(REMOVAL('local-r-g'));
ok(!withG.ok && /pg_graphql/.test(withG.message), 'pg_graphql installed: refused', withG.message);
psql(`drop extension pg_graphql`);
psql(`alter role authenticator set xmloption = 'document'`);
const withD = tryPsql(REMOVAL('local-r-d'));
ok(!withD.ok && /configured default/.test(withD.message), 'a configured default: refused', withD.message);
psql(`alter role authenticator reset xmloption`);
psql(`alter function public.org_create_collection(uuid, text) set xmloption = 'document'`);
const extra = tryPsql(REMOVAL('local-r-e'));
ok(!extra.ok && /outside the set/.test(extra.message), 'the clause outside the set: refused', extra.message);
psql(`alter function public.org_create_collection(uuid, text) reset xmloption`);
psql(`alter function public.delete_tv_season(uuid, integer) reset xmloption`);
const missing = tryPsql(REMOVAL('local-r-m'));
ok(!missing.ok && /expected the clause/.test(missing.message), 'the clause missing from one: refused', missing.message);
psql(`alter function public.delete_tv_season(uuid, integer) set xmloption = 'document'`);
w1Catalog = catalog(); // the clause came back last in that function's list of settings, which is all that moved
const lastCommit = text => { const i = text.lastIndexOf('commit;'); return text.slice(0, i) + `select 1 / 0;\n` + text.slice(i); };
const fail = tryPsql(lastCommit(REMOVAL('local-r-f')));
ok(!fail.ok && /division by zero/.test(fail.message), 'a failure at the last moment fails the run', fail.message);
ok(unchanged(), 'and leaves the catalog and every row exactly as they were');
const s2 = status();
ok(s2.clause_functions === 38 && s2.helper && !s2.runs.w1_removal, 'W1 is still fully in place, with no run record');
const cut = tryPsql(REMOVAL('local-r-c').replace("drop function private.lib_authorized();", "select pg_terminate_backend(pg_backend_pid());\ndrop function private.lib_authorized();"));
ok(!cut.ok, 'a connection lost partway through', cut.message);
ok(unchanged(), 'leaves nothing behind either');

section('the removal');
const gone = tryPsql(REMOVAL('local-w1r'));
if (!ok(gone.ok && /W1-REMOVED\|.*"functions" ?: ?38/.test(gone.out), 'db/w1_removal.sql commits', gone.message || gone.out)) process.exit(1);
await sleep(1500);
const again = tryPsql(REMOVAL('local-w1r-2'));
ok(!again.ok && /already installed/.test(again.message), 'a rerun is refused', again.message);
const s3 = status();
ok(s3.clause_functions === 0 && !s3.helper && s3.names_w1 === 0 && s3.guards_read_flag === 3 && s3.xmloption === 'content', 'no clause, no helper, no function names W1, the guards read the flag', JSON.stringify(s3));
ok(s3.runs.w1 === 1 && s3.runs.w1_removal === 1, 'W1’s run record stays as history, beside the removal’s');
ok(library() === lib0, 'no row changed');
const after = catalog();
const diff = Object.keys({ ...before, ...after }).filter(k => before[k] !== after[k]);
ok(diff.length === 0, 'the catalog equals the one before W1, entry for entry: bodies, settings, grants, triggers, policies, role settings', diff.join(', '));
ok(Q(`select bool_and(proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'xmloption%')) from pg_proc`) === 't', 'in every schema');

section('the earlier write authorization');
const required = r => /library_write_required/.test(r.text);
const dw = await rest(A.token, 'PATCH', `tv_shows?id=eq.${seedShow.show.id}`, { priority: 'high' }, { Prefer: 'return=representation' });
ok(required(dw), 'a direct write of a guarded column is refused', dw.text);
const dw2 = await rest(A.token, 'PATCH', `watchlist_items?id=eq.${seedShow.rows[0].id}`, { season_number: 9 }, { Prefer: 'return=representation' });
ok(required(dw2), 'an identity column too', dw2.text);
const dw3 = await rest(A.token, 'POST', 'tv_shows', [{ title: 'ZZ Direct', show_key: 'zz direct' }]);
ok(required(dw3), 'a direct insert too', dw3.text);
const dw4 = await rest(A.token, 'DELETE', `update_holds?id=eq.${crypto.randomUUID()}`);
ok(dw4.ok, 'a guarded table with nothing to delete answers as usual');
ok(Q(`select current_setting('xmloption')`) === 'content', 'the setting is at its default');

section('ordinary work');
const st0 = s => JSON.parse(Q(`select private.b45_show_state(s) from public.tv_shows s where id = '${s}'`));
const F = await mkShow(A, 'ZZ W1R Show', 990802);
ok(F.rows.length === 2, 'a show is created');
ok((await rpc(A.token, 'library_set_show_state_b45', { p_show_id: F.show.id, p_expected: st0(F.show.id), p_changes: { priority: 'high' } })).ok, 'its state changes');
ok((await rpc(A.token, 'set_season_watched', { p_row_id: F.rows[0].id, p_watched: true })).ok, 'a season is marked Watched');
const eps = await rpc(A.token, 'library_set_episode_marks', { p_season_id: F.rows[1].id, p_expected: { watched: false, skipped: false }, p_watched: true, p_episodes: [{ tmdb_episode_id: 1, episode_number: 1 }] });
ok(eps.ok, 'an episode is marked', eps.text);
const film = await mkFilm(A, 'ZZ W1R Film');
const fs0 = JSON.parse(Q(`select json_build_object('status', status, 'watched', watched, 'priority', priority, 'catalog_new', catalog_new, 'status_review', status_review) from public.watchlist_items where id = '${film}'`));
ok((await rpc(A.token, 'library_set_film_state_b45', { p_item_id: film, p_expected: fs0, p_changes: { watched: true } })).ok, 'a film’s state changes');
const coll = crypto.randomUUID();
ok((await rpc(A.token, 'org_create_collection', { p_id: coll, p_name: 'ZZ W1R Coll' })).ok, 'a collection is created');
const mem = await rpc(A.token, 'org_add_membership', { p_collection_id: coll, p_show_id: F.show.id });
ok(mem.ok, 'a show joins it', mem.text);
const memF = await rpc(A.token, 'org_add_membership', { p_collection_id: coll, p_item_id: film });
ok(memF.ok, 'a film joins it');
const rm = await rpc(A.token, 'org_remove_membership', { p_membership_id: mem.json.membership.id, p_collection_id: coll, p_show_id: F.show.id });
ok(rm.ok && rm.json.removed, 'a membership is removed', rm.text);
ok(Q(`select count(*) from public.membership_removals where collection_id = '${coll}'`) === '1', 'and the removal is remembered');
ok((await rpc(A.token, 'org_add_membership', { p_collection_id: coll, p_show_id: F.show.id })).ok, 'and added back');
const stale = await rpc(A.token, 'delete_tv_season', { p_row_id: F.rows[1].id, p_marks_expected: 0 });
ok(!stale.ok && /target_changed/.test(stale.text), 'a delete with a stale mark count is refused', stale.text);
ok((await rpc(A.token, 'delete_tv_season', { p_row_id: F.rows[1].id, p_marks_expected: 1 })).ok && Q(`select count(*) from public.episode_marks where season_id = '${F.rows[1].id}'`) === '0', 'the right count: the season and its mark go');
const lastS = await rpc(A.token, 'delete_tv_season', { p_row_id: F.rows[0].id, p_marks_expected: 0 });
ok(lastS.ok && lastS.json.show_deleted && Q(`select count(*) from public.collection_memberships where show_id = '${F.show.id}'`) === '0', 'the last season takes the show and its membership', lastS.text);
const fd = await rest(A.token, 'DELETE', `watchlist_items?id=eq.${film}`, undefined, { Prefer: 'return=representation' });
ok(fd.ok && fd.json.length === 1 && Q(`select count(*) from public.collection_memberships where item_id = '${film}'`) === '0', 'the page’s film delete works, and its membership cascades', fd.text);
const toMatch = await mkFilm(A, 'ZZ W1R Unmatched');
const mPatch = { title: 'ZZ W1R Matched', season: 'Film', item_key: 'zz w1r matched|film', theme: 'ZZ', display_date: 'Jan 1, 2020', date_sort: '2020-01-01', media_type: 'movie', tmdb_id: 990803, season_number: null };
const mExp = JSON.parse(Q(`select json_build_object('tmdb_id', tmdb_id, 'show_id', show_id) from public.watchlist_items where id = '${toMatch}'`));
const m1 = await rpc(A.token, 'library_match_film_b45', { p_row_id: toMatch, p_expected: mExp, p_patch: mPatch });
const m2 = m1.ok && m1.json && m1.json.confirmation ? await rpc(A.token, 'library_match_film_b45', { p_row_id: toMatch, p_expected: mExp, p_patch: mPatch, p_ack: m1.json.confirmation }) : m1;
ok(m2.ok && Q(`select title from public.watchlist_items where id = '${toMatch}'`) === 'ZZ W1R Matched', 'a match works', m2.text);

section('item 10: a missing season comes back');
const T = await mkShow(A, 'ZZ W1R Missing', 990804);
const seasonArgs = () => ({ p_show_id: T.show.id, p_expected: { tmdb_id: 990804, show_key: T.show.show_key }, p_season: { season_number: 2, display_date: 'Jan 1, 2022', date_sort: '2022-01-01', episode_count: 0 },
  p_finding: { source: 'tmdb', kind: 'new_season', fingerprint: `new_season:${crypto.createHash('sha256').update(T.show.id).digest('hex')}`, show_id: T.show.id, subject: { title: 'ZZ W1R Missing', season_number: 2, label: 'Season 2' },
    proposed: { season_number: 2, display_date: 'Jan 1, 2022', date_sort: '2022-01-01', episode_count: 0 }, expected: { tmdb_id: 990804, show_key: T.show.show_key } }, p_review: false, p_row_id: null });
const row2 = () => (Q(`select id from public.watchlist_items where show_id = '${T.show.id}' and season_number = 2`) || null);
for (const round of ['first', 'second', 'third']) {
  ok((await rpc(A.token, 'delete_tv_season', { p_row_id: row2(), p_marks_expected: 0 })).ok, `${round} delete`);
  const back = await rpc(A.token, 'library_cu_reconcile_season', seasonArgs());
  ok(back.ok && row2(), `Refresh brings it back after the ${round} delete`, back.text);
}
const twice = await rpc(A.token, 'library_cu_reconcile_season', seasonArgs());
ok(twice.ok && Q(`select count(*) from public.watchlist_items where show_id = '${T.show.id}' and season_number = 2`) === '1', 'with the season there, no duplicate', twice.text);

section('account isolation');
const Bs = await mkShow(B, 'ZZ W1R B', 990805);
const none = r => r.ok && Array.isArray(r.json) && r.json.length === 0;
ok(none(await rest(A.token, 'GET', `tv_shows?select=id&id=eq.${Bs.show.id}`)), 'another account’s row can’t be read');
ok(none(await rest(A.token, 'DELETE', `watchlist_items?id=eq.${Bs.rows[0].id}`, undefined, { Prefer: 'return=representation' })) && Q(`select count(*) from public.watchlist_items where id = '${Bs.rows[0].id}'`) === '1', 'or deleted');
const xs = await rpc(A.token, 'delete_tv_season', { p_row_id: Bs.rows[0].id, p_marks_expected: 0 });
ok(!xs.ok && /not_found/.test(xs.text), 'or deleted through a function', xs.text);
const xc = await rpc(A.token, 'library_set_show_state_b45', { p_show_id: Bs.show.id, p_expected: st0(Bs.show.id), p_changes: { priority: 'low' } });
ok(!xc.ok && Q(`select priority from public.tv_shows where id = '${Bs.show.id}'`) !== 'low', 'or changed through a function', xc.text);
const signedOut = await rest(null, 'GET', 'tv_shows?select=id&limit=1');
ok(!signedOut.ok, 'signed out: refused', signedOut.text);
const signedOutR = await rpc(null, 'delete_tv_season', { p_row_id: Bs.rows[0].id, p_marks_expected: 0 });
ok(!signedOutR.ok, 'and no function runs', signedOutR.text);
const outsider = await account('w1r-c@test.invalid');
const notMember = await rest(outsider.token, 'GET', 'tv_shows?select=id');
ok(!notMember.ok || notMember.json.length === 0, 'someone who isn’t a member reaches nothing');
ok(!(await rpc(outsider.token, 'library_create_film_b45', { p_film: { title: 'ZZ Outsider', item_key: 'zz outsider|film', season: 'Film', theme: 'ZZ', display_date: 'Jan 1, 2020', date_sort: '2020-01-01' } })).ok, 'and can’t write');

section('research permission');
const notEnabled = r => /research_not_enabled/.test(r.text);
psql(`update private.library_members set research_enabled = false where user_id = '${B.id}'; update private.library_members set research_enabled = true where user_id = '${A.id}'`);
const newHold = { kind: 'standing_decision', subject_label: 'ZZ W1R', decision: 'x', effect: 'do_not_add', reopen: { on: 'owner_only' } };
ok((await rpc(A.token, 'library_cu_save_hold', { p_hold: newHold })).ok, 'a member with research access saves a hold');
ok(notEnabled(await rpc(B.token, 'library_cu_save_hold', { p_hold: newHold })), 'a member without it is refused');
const cap = async who => (await rpc(who.token, 'stage5_capabilities', {})).json;
ok((await cap(A)).research === true && (await cap(B)).research === false, 'the capability says which');
const directHold = await rest(B.token, 'POST', 'update_holds', [{ ...newHold }]);
ok(notEnabled(directHold) || required(directHold), 'a direct insert of a hold is refused', directHold.text);

section('backup and restore');
function backupOf(who) {
  const out = psql(execFileSync(process.execPath, [path.join(ROOT, 'tools/admin-restore.mjs'), 'export-sql', '--owner', who.id], { encoding: 'utf8' }));
  return JSON.parse(out.slice(out.indexOf('{"format"'), out.lastIndexOf('}') + 1));
}
const printOf = who => Q(`select md5(string_agg(t, '|' order by t)) from (select to_jsonb(x)::text t from public.tv_shows x where user_id = '${who.id}' union all select to_jsonb(x)::text from public.watchlist_items x where user_id = '${who.id}'
  union all select to_jsonb(x)::text from public.collection_memberships x where user_id = '${who.id}' union all select to_jsonb(x)::text from public.update_holds x where user_id = '${who.id}' union all select to_jsonb(x)::text from public.episode_marks x where user_id = '${who.id}') s`);
const doc7 = backupOf(A), keep = printOf(A), other = printOf(B);
ok(doc7.formatVersion === 7, 'the backup is format 7');
const added = await mkFilm(A, 'ZZ W1R Later');
const rest1 = await rpc(A.token, 'restore_backup', { p_backup: doc7, p_allow_v1_reset: false });
ok(rest1.ok, 'a format-7 restore runs', rest1.text);
ok(printOf(A) === keep && Q(`select count(*) from public.watchlist_items where id = '${added}'`) === '0', 'it brings the library back exactly');
ok(printOf(B) === other, 'and no other account changed');
const broken = JSON.parse(JSON.stringify(doc7)); broken.tables.tv_shows[0].title = null;
const pre = printOf(A), rest2 = await rpc(A.token, 'restore_backup', { p_backup: broken, p_allow_v1_reset: false });
ok(!rest2.ok && printOf(A) === pre, 'a refused restore changes nothing', rest2.text);
const dwR = await rest(A.token, 'PATCH', `tv_shows?id=eq.${(await rest(A.token, 'GET', 'tv_shows?select=id&limit=1')).json[0].id}`, { priority: 'low' });
ok(required(dwR), 'a direct write after a restore request is refused: the flag ended with its transaction', dwR.text);

console.log(failed ? `\nFAILED: ${failed} check(s)` : `\nALL ${passed} CHECKS PASSED`);
process.exit(failed ? 1 : 0);
