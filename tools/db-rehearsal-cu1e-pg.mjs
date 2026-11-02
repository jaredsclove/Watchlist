// Local rehearsal of CU1e's concurrency on a real, throwaway PostgreSQL 17 server, with two real connections: what PGlite (one
// session) can't show. Simultaneous Refreshes of a season, first time and after a delete; a delete in flight while Refresh runs,
// committed and rolled back; a Refresh in flight while a delete runs; different seasons of one show. Each case needs the
// second connection observed waiting on a lock before the first ends, and leaves exactly the expected rows.
//   PG_BIN=/path/to/postgres17/bin node tools/db-rehearsal-cu1e-pg.mjs
// The server listens on a Unix socket in a temporary directory only (no TCP), and is removed at the end. No library data:
// one synthetic member. Output: pass/fail only.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.env.PG_BIN;
if (!BIN) { console.error('usage: PG_BIN=… node tools/db-rehearsal-cu1e-pg.mjs'); process.exit(2); }
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cu1epg-')), DATA = path.join(WORK, 'data'), SOCK = path.join(WORK, 's');
fs.mkdirSync(SOCK);
const bin = n => path.join(BIN, n);
const A = '00000000-0000-4000-8000-00000000000a';
const args = ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', SOCK, '-U', 'postgres', '-d', 'postgres'];
const psql = text => execFileSync(bin('psql'), args, { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).trim();
const file = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const ok = (c, l, d = '') => { if (!c) failed++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l}${!c && d ? `\n       ${String(d).slice(0, 400)}` : ''}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const stop = () => { try { execFileSync(bin('pg_ctl'), ['-D', DATA, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch (e) { /* not running */ } fs.rmSync(WORK, { recursive: true, force: true }); };
process.on('exit', stop);

// A long-lived session: send a statement, read its answer when it comes.
function session() {
  const p = spawn(bin('psql'), ['-X', '-At', '-h', SOCK, '-U', 'postgres', '-d', 'postgres'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; p.stdout.on('data', d => { buf += d; }); p.stderr.on('data', d => { buf += d; });
  let n = 0;
  return {
    send(text) { const mark = `zzdone${++n}`; buf = ''; p.stdin.write(`${text}\n\\echo ${mark}\n`); return mark; },
    async done(mark, ms = 15000) { const t0 = Date.now(); while (!buf.includes(mark)) { if (Date.now() - t0 > ms) throw new Error(`no answer: ${buf.slice(0, 200)}`); await wait(20); } return buf.split(mark)[0]; },
    async run(text) { return this.done(this.send(text)); },
    end() { p.stdin.end(); }
  };
}
const as = `select set_config('request.jwt.claims', '{"sub": "${A}", "role": "authenticated"}', false), set_config('role', 'authenticated', false);`;
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const fpS = (show, n) => `new_season:${sha(JSON.stringify(['new_season', show, 993000, n]))}`;
const expected = key => JSON.stringify({ tmdb_id: 993000, show_key: key });
const refreshSql = (S, n) => `select public.library_cu_reconcile_season('${S.id}', '${expected(S.key)}', '{"season_number": ${n}, "display_date": "Jan 1, 2013", "date_sort": "2013-01-01", "episode_count": 8}', '${JSON.stringify({ source: 'tmdb', kind: 'new_season', fingerprint: fpS(S.id, n), show_id: S.id, subject: { season_number: n } })}', false, null);`;
const count = (S, n) => Number(psql(`select count(*) from public.watchlist_items where show_id = '${S.id}' and season_number = ${n}`));
const rowOf = (S, n) => psql(`select id from public.watchlist_items where show_id = '${S.id}' and season_number = ${n}`);
const deleteSql = id => `select public.delete_tv_season('${id}', 0);`;
const waiting = async () => { for (let i = 0; i < 300; i++) { if (Number(psql(`select count(*) from pg_stat_activity where wait_event_type = 'Lock' and state = 'active'`)) > 0) return true; await wait(20); } return false; };

console.log('[server]');
execFileSync(bin('initdb'), ['-D', DATA, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
execFileSync(bin('pg_ctl'), ['-D', DATA, '-o', `-c listen_addresses='' -c unix_socket_directories='${SOCK}' -c timezone=UTC -c deadlock_timeout=200ms`, '-l', path.join(WORK, 'log'), '-w', 'start'], { stdio: 'ignore' });
for (const f of ['db/test/supabase_shim.sql', 'db/test/replica_schema.sql', 'db/phase0_restore_v1.sql', 'db/phase1b_ownership.sql', 'db/restore_backup.sql', 'db/phase1c_tv_schema.sql', 'db/tv_model.sql', 'db/rpc.sql', 'db/admin/tv_enrich.sql']) psql(file(f));
psql(`update private.migration_stage set stage = 'final'`);
for (const f of ['db/phase3b_org.sql', 'db/phase3b2_org_write.sql', 'db/phase4a_catalog.sql', 'db/phase4b_add_to_show.sql', 'db/phase5a_expand.sql', 'db/phase5c_contract.sql']) psql(file(f));
psql(`select set_config('watchlist.b45_choices', '{"shows": {}, "films": {}}', false);\n` + file('db/b45_expand.sql'));
psql(`insert into auth.users (id, email) values ('${A}', 'a@test.invalid'); begin; select set_config('watchlist.library_write', 'on', true); insert into private.stage5_recovery_meta (user_id, origin, counts, hashes) select bootstrap_owner_id, 'contraction', '{}'::jsonb, '{}'::jsonb from private.app_owner; commit;`);
psql(`select set_config('watchlist.m1_owner', '${A}', false), set_config('watchlist.m1_run', 'pg-m1-run', false);\n` + file('db/m1_access.sql'));
psql(`select set_config('watchlist.ep1_run', 'pg-ep1-run', false);\n` + file('db/ep1_episode_marks.sql'));
for (const [g, f] of [['cu1', 'db/cu1_collection_updates.sql'], ['cu1b', 'db/cu1b_hold_edit.sql'], ['cu1c', 'db/cu1c_date_equivalence.sql'], ['cu1d', 'db/cu1d_network_and_marks.sql']]) psql(`select set_config('watchlist.${g}_run', 'pg-${g}-run', false);\n` + file(f));
psql(`select set_config('watchlist.cu2_run', 'pg-cu2-run', false), set_config('watchlist.cu2_owner', '${A}', false);\n` + file('db/cu2_research_access.sql'));
psql(`select set_config('watchlist.cu1e_run', 'pg-cu1e-run', false);\n` + file('db/cu1e_missing_season.sql'));
psql(`select set_config('watchlist.simplify_run', 'pg-simplify-run', false);\n` + file('db/simplify_restore_cleanup.sql'));
ok(psql(`select count(*) from private.migration_runs where migration = 'cu1e'`) === '1', 'a real server at the final state');

const s1 = session(), s2 = session();
await s1.run(as); await s2.run(as);
let seq = 0;
async function show() {
  const title = `ZZ Race ${++seq}`, key = title.toLowerCase(), tmdb = 993000;
  const before = psql(`begin; select set_config('watchlist.library_write', 'on', true); delete from public.update_findings where source = 'tmdb'; delete from public.watchlist_items where user_id = '${A}'; delete from public.tv_shows where user_id = '${A}'; commit;`);
  const seasons = [1, 2, 3].map(n => ({ item_key: `${key}|season ${n}`, title, season: `Season ${n}`, theme: 'ZZ', display_date: 'Jan 1, 2020', date_sort: '2020-01-01', season_number: n }));
  const out = await s1.run(`select (public.library_create_show_b45('${JSON.stringify({ tmdb_id: tmdb, title, show_key: key, network: 'ZZ' })}', '${JSON.stringify(seasons)}') -> 'show' ->> 'id');`);
  return { id: out.trim().split('\n').pop(), key };
}
// One return so that the finding is `applied`, then the season deleted again.
async function primed(n = 3) {
  const S = await show();
  await s1.run(deleteSql(rowOf(S, n))); await s1.run(refreshSql(S, n));
  await s1.run(deleteSql(rowOf(S, n)));
  return S;
}
const outcome = t => { try { return JSON.parse(t.trim().split('\n').find(l => l.startsWith('{'))).outcome; } catch (e) { return t.slice(0, 120); } };

console.log('[two Refreshes at once]');
{
  const S = await show();
  await s1.run(deleteSql(rowOf(S, 3)));
  await s1.run('begin;'); const a = await s1.run(refreshSql(S, 3));
  const m = s2.send(refreshSql(S, 3));
  ok(await waiting(), 'first time ever: the second waits on the first');
  await s1.run('commit;');
  const b = await s2.done(m);
  ok(outcome(a) === 'applied' && outcome(b) === 'not_pending' && count(S, 3) === 1, 'one season, one finding, the second told it exists', [outcome(a), outcome(b), count(S, 3)]);
}
{
  const S = await primed();
  await s1.run('begin;'); const a = await s1.run(refreshSql(S, 3));
  const m = s2.send(refreshSql(S, 3));
  ok(await waiting(), 'after a delete: the second waits on the first');
  await s1.run('commit;');
  const b = await s2.done(m);
  ok(outcome(a) === 'applied' && outcome(b) === 'not_pending' && count(S, 3) === 1, 'restored once, no duplicate', [outcome(a), outcome(b), count(S, 3)]);
}
{
  const S = await primed();
  await s1.run('begin;'); const a = await s1.run(refreshSql(S, 3));
  const m = s2.send(refreshSql(S, 3));
  ok(await waiting(), 'first rolls back: the second waits');
  await s1.run('rollback;');
  const b = await s2.done(m);
  ok(outcome(a) === 'applied' && outcome(b) === 'applied' && count(S, 3) === 1, 'the second restores it', [outcome(a), outcome(b), count(S, 3)]);
}
console.log('[a delete racing Refresh]');
{
  const S = await show();
  await s1.run(deleteSql(rowOf(S, 3))); await s1.run(refreshSql(S, 3));
  await s1.run('begin;'); await s1.run(deleteSql(rowOf(S, 3)));
  const m = s2.send(refreshSql(S, 3));
  ok(await waiting(), 'delete in flight: Refresh waits for the show');
  await s1.run('commit;');
  const b = await s2.done(m);
  ok(outcome(b) === 'applied' && count(S, 3) === 1, 'delete commits: Refresh sees it and restores the season, not “already there”', [outcome(b), count(S, 3)]);
}
{
  const S = await show();
  await s1.run(deleteSql(rowOf(S, 3))); await s1.run(refreshSql(S, 3));
  await s1.run('begin;'); await s1.run(deleteSql(rowOf(S, 3)));
  const m = s2.send(refreshSql(S, 3));
  ok(await waiting(), 'delete in flight, again');
  await s1.run('rollback;');
  const b = await s2.done(m);
  ok(outcome(b) === 'not_pending' && count(S, 3) === 1, 'delete rolls back: the season is there, one row', [outcome(b), count(S, 3)]);
}
{
  const S = await show();
  await s1.run(deleteSql(rowOf(S, 3))); await s1.run(refreshSql(S, 3));
  const id = rowOf(S, 3);
  await s1.run('begin;'); const a = await s1.run(refreshSql(S, 3));
  const m = s2.send(deleteSql(id));
  ok(await waiting(), 'Refresh in flight on an existing season: the delete waits');
  await s1.run('commit;');
  const b = await s2.done(m);
  ok(outcome(a) === 'not_pending' && /deleted_row_id/.test(b) && count(S, 3) === 0, 'the delete then goes ahead', [outcome(a), b.slice(0, 80), count(S, 3)]);
  ok(outcome(await s1.run(refreshSql(S, 3))) === 'applied' && count(S, 3) === 1, 'and the next Refresh restores it');
}
console.log('[no deadlock]');
{
  const S = await primed(3);
  await s1.run(deleteSql(rowOf(S, 2))); await s1.run(refreshSql(S, 2)); await s1.run(deleteSql(rowOf(S, 2)));
  await s1.run('begin;'); await s1.run(refreshSql(S, 3));
  const m = s2.send(refreshSql(S, 2));
  ok(await waiting(), 'different seasons of one show: the second waits on the show');
  await s1.run('commit;');
  const b = await s2.done(m);
  ok(outcome(b) === 'applied' && count(S, 2) === 1 && count(S, 3) === 1, 'both restored', [outcome(b), count(S, 2), count(S, 3)]);
  const log = fs.readFileSync(path.join(WORK, 'log'), 'utf8');
  ok(!/deadlock detected/.test(log), 'the server logged no deadlock');
}
s1.end(); s2.end();
console.log(failed ? `\nFAILED: ${failed} check(s)` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
