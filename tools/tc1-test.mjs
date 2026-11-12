// TC1's database tests: the member's TMDB cache on a database replayed to its final state (Q1, G1, then db/tc1_tmdb_cache.sql
// with db/test/pg_cron_shim.sql standing in for pg_cron).
//   PGLITE_DIR=<dir with @electric-sql/pglite> [PG_BIN=<postgres 17 bin>] node tools/tc1-test.mjs
// PGlite covers behaviour: the migration (refusals, every existing row unchanged, the expiry job), writes against the revision
// the page last saw (a stale write, a row deleted and made again, overlapping writes from two devices), validation, isolation,
// the purge, the expiry (only this cache, only rows past 150 days) and restore leaving the cache alone. Real PostgreSQL 17 (a
// throwaway server, removed at the end) adds two simultaneous writes. Synthetic data only (made-up TMDB ids).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { replay, library9, file, A, B, C } from './restore-fixture.mjs';

if (!process.env.PGLITE_DIR) { console.error('usage: PGLITE_DIR=<dir> [PG_BIN=<postgres 17 bin>] node tools/tc1-test.mjs'); process.exit(2); }
const req = createRequire(path.join(process.env.PGLITE_DIR, 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));

let passed = 0, failed = 0;
const ok = (c, l, d = '') => { c ? passed++ : failed++; if (!c) console.log(`  FAIL ${l}${d ? `\n       ${String(d).slice(0, 600)}` : ''}`); };
const section = t => console.log(`[${t}]`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SIMPLIFY = `select set_config('watchlist.simplify_run', 'local-simplify', false);\n` + file('db/simplify_restore_cleanup.sql');
const Q1 = `select set_config('watchlist.q1_run', 'local-q1', false);\n` + file('db/q1_queues.sql');
const G1 = `select set_config('watchlist.g1_run', 'local-g1', false);\n` + file('db/g1_games.sql');
const CRON = file('db/test/pg_cron_shim.sql');
const MIG = file('db/tc1_tmdb_cache.sql'), tc1 = run => `select set_config('watchlist.tc1_run', '${run}', false);\n` + MIG;

const db = new PGlite();
await replay(t => db.exec(t));
await db.exec(SIMPLIFY);
await db.exec(Q1);
await db.exec(G1);
const as = (who, sql, params = []) => db.transaction(async tx => {
  await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [who ? JSON.stringify({ sub: who, role: 'authenticated' }) : '']);
  return (await tx.query(sql, params)).rows;
});
const call = (who, sql, params = []) => as(who, `select ${sql} r`, params).then(r => ({ ok: true, r: r[0].r }), e => ({ ok: false, message: e.message, code: e.code }));
const val = async s => Object.values((await db.query(s)).rows[0])[0];
const restore = (who, doc) => call(who, `public.restore_backup($1::jsonb, false)`, [JSON.stringify(doc)]);
const attempt = text => db.exec(text).then(() => null, async e => { await db.exec('rollback'); return e.message; });
const put = (who, rows) => call(who, `public.library_tmdb_cache_put($1::jsonb)`, [JSON.stringify(rows)]);
const showRow = (id, base, a = 8.1) => ({ kind: 'show', tmdb_id: id, season_number: -1, data: { a, c: 120, f: '2020-01-01' }, base_rev: base });
const seasonRow = (id, n, base, ids = [1, 2, 3]) => ({ kind: 'season', tmdb_id: id, season_number: n, data: { ids, numbers: ids.map((x, i) => i + 1), names: ids.map(() => ''), last: null }, base_rev: base });
const stored = (who, kind, id, n) => as(who, `select rev::text, data from public.tmdb_tv_cache where kind = $1 and tmdb_id = $2 and season_number = $3`, [kind, id, n]).then(r => r[0] || null);
const count = who => as(who, `select count(*)::int n from public.tmdb_tv_cache`).then(r => r[0].n);

section('the migration');
const L1 = library9(1), L2 = library9(2);
ok((await restore(A, L1)).ok && (await restore(B, L2)).ok, 'two format-9 libraries restore before the migration');
const fpAll = () => val(`select md5(string_agg(x, '|' order by x)) from (
  select to_jsonb(r)::text x from public.watchlist_items r union all select to_jsonb(r)::text from public.tv_shows r
  union all select to_jsonb(r)::text from public.collection_memberships r union all select to_jsonb(r)::text from public.personal_collections r
  union all select to_jsonb(r)::text from public.episode_marks r union all select to_jsonb(r)::text from public.update_findings r
  union all select to_jsonb(r)::text from public.watch_queues r union all select to_jsonb(r)::text from public.queue_entries r
  union all select to_jsonb(r)::text from public.game_entries r union all select to_jsonb(r)::text from public.game_titles r
  union all select to_jsonb(r)::text from private.library_members r) q`);
const before = await fpAll();
ok(/pg_cron extension isn't enabled/.test(await attempt(tc1('local-nocron'))) && (await val(`select to_regclass('public.tmdb_tv_cache') is null`)), 'without pg_cron: refused, nothing created');
await db.exec(CRON);
ok(/set watchlist.tc1_run/.test(await attempt(`select set_config('watchlist.tc1_run', '', false);\n` + MIG)) && (await val(`select to_regclass('public.tmdb_tv_cache') is null`)), 'without a run id: refused, nothing created');
const late = tc1('local-late').replace("select 'TC1|'", () => `do $$ begin raise exception 'zz failure before commit'; end $$;\nselect 'TC1|'`);
ok(/zz failure before commit/.test(await attempt(late)) && (await val(`select to_regclass('public.tmdb_tv_cache') is null`))
  && (await val(`select count(*)::int from cron.job`)) === 0 && (await val(`select public.stage5_capabilities() ->> 'tc1'`)) === null,
  'a failure just before commit leaves the database as it was (no table, no job, no capability)');
ok(!(await attempt(tc1('local-tc1'))), 'the migration commits on a database holding libraries, queues and games');
ok(before === await fpAll(), 'no library row, mark, queue, game, IGDB cache row or member changed');
ok(/already installed/.test(await attempt(tc1('local-tc1-again'))), 'a rerun is refused');
const cap = (await call(A, `public.stage5_capabilities()`)).r;
ok(cap.phase === 'contracted-g1' && cap.backup_format === 9 && cap.tc1 === 1 && cap.g1 === 1 && cap.member === true, 'the capability adds tc1; phase and backup format are unchanged', JSON.stringify(cap));
ok(same((await db.query(`select jobname, schedule, command from cron.job`)).rows, [{ jobname: 'watchlist-tmdb-cache-expiry', schedule: '23 4 * * *', command: 'select private.tmdb_cache_expire()' }]), 'one daily expiry job');
ok((await val(`select count(*)::int from private.migration_runs where migration = 'tc1' and run_id = 'local-tc1'`)) === 1, 'the run record holds the run id');

section('writes against the revision the page saw');
const w1 = await put(A, [showRow(500001, 0), seasonRow(500001, 1, 0)]);
ok(w1.ok && w1.r.rows.length === 2 && w1.r.rows.every(x => x.written && /^\d+$/.test(String(x.rev))), 'new rows (base 0) are written and answered with their revision', w1.message || JSON.stringify(w1.r));
const r1 = String(w1.r.rows[0].rev);
const w2 = await put(A, [showRow(500001, 0, 6.0)]);
ok(w2.ok && !w2.r.rows[0].written && String(w2.r.rows[0].rev) === r1 && w2.r.rows[0].data.a === 8.1, 'a second "new" write for the same key is ignored and answered with what is stored');
const w3 = await put(A, [showRow(500001, Number(r1), 7.5)]);
const r2 = String(w3.r.rows[0].rev);
ok(w3.ok && w3.r.rows[0].written && BigInt(r2) > BigInt(r1) && w3.r.rows[0].data.a === 7.5, 'a write based on the stored revision is written with a new, larger revision');
const w4 = await put(A, [showRow(500001, Number(r1), 5.0)]);
ok(w4.ok && !w4.r.rows[0].written && String(w4.r.rows[0].rev) === r2 && w4.r.rows[0].data.a === 7.5, 'a write based on an older revision is ignored; the newer row stands');
// Two devices read revision r2; each fetches TMDB and writes. The first write wins; the second is answered with it.
const dx = await put(A, [showRow(500001, Number(r2), 7.6)]), dy = await put(A, [showRow(500001, Number(r2), 7.7)]);
ok(dx.r.rows[0].written && !dy.r.rows[0].written && dy.r.rows[0].data.a === 7.6 && String(dy.r.rows[0].rev) === String(dx.r.rows[0].rev), 'overlapping writes from two devices: one is written, the other is answered with it');
const r3 = String(dx.r.rows[0].rev);
// Deleted and made again: the new row's revision is new, so a page still holding r3 can't overwrite it.
ok((await call(A, `public.library_tmdb_cache_purge()`)).r.removed === 2, 'the purge empties the member’s cache');
ok(!(await put(A, [showRow(500001, Number(r3), 1.0)])).r.rows[0].written && (await stored(A, 'show', 500001, -1)) === null, 'a write based on a deleted row is ignored (it creates nothing)');
const re = await put(A, [showRow(500001, 0, 8.8)]);
const r4 = String(re.r.rows[0].rev);
ok(re.r.rows[0].written && BigInt(r4) > BigInt(r3), 'the row made again gets a revision never used before', `${r3} → ${r4}`);
const stale = await put(A, [showRow(500001, Number(r3), 2.0), showRow(500001 + 1, Number(r1), 2.0)]);
ok(stale.r.rows.every(x => !x.written) && (await stored(A, 'show', 500001, -1)).data.a === 8.8, 'an old response holding an earlier revision can’t replace the new row');
ok((await val(`select count(distinct rev) = count(*) from public.tmdb_tv_cache`)) === true, 'no two rows share a revision');

section('validation');
const bad = async (rows, label) => ok(/invalid_input|violates check constraint/.test((await put(A, rows)).message || ''), label);
await bad(Array.from({ length: 101 }, (_, i) => showRow(600000 + i, 0)), 'more than 100 rows are refused');
await bad([showRow(600001, 0), showRow(600001, 0)], 'the same key twice is refused');
await bad([{ ...showRow(600002, 0), kind: 'film' }], 'an unknown kind is refused');
await bad([{ ...showRow(600003, 0), season_number: 2 }], 'a show row with a season number is refused');
await bad([{ ...seasonRow(600004, 1, 0), season_number: -1 }], 'a season row without one is refused');
await bad([{ ...seasonRow(600005, 1, 0), data: { numbers: [] } }], 'a season row without episode ids is refused');
await bad([{ ...showRow(600006, 0), data: [1] }], 'data that isn’t an object is refused');
await bad([{ ...showRow(600007, 0), base_rev: -1 }], 'a negative revision is refused');
await bad([{ ...showRow(600008, 0), tmdb_id: 0 }], 'TMDB id 0 is refused');
await bad([{ ...seasonRow(600009, 1, 0), data: { ids: [1], names: ['x'.repeat(41000)] } }], 'an oversized row is refused');
ok((await count(A)) === 1, 'nothing refused was written');

section('isolation');
await put(A, [seasonRow(500002, 3, 0, [7, 8])]);
ok((await count(B)) === 0, 'another member sees none of the rows');
const wb = await put(B, [showRow(500001, 0, 3.3)]);
ok(wb.r.rows[0].written && (await stored(A, 'show', 500001, -1)).data.a === 8.8 && (await stored(B, 'show', 500001, -1)).data.a === 3.3, 'the same key for another member is that member’s own row');
ok(!(await put(B, [showRow(500001, Number(r4), 0.1)])).r.rows[0].written && (await stored(A, 'show', 500001, -1)).data.a === 8.8, 'a revision from another member’s row writes nothing');
const anon = await put(null, [showRow(700001, 0)]), cx = await put(C, [showRow(700001, 0)]);
ok(!anon.ok && !cx.ok && /not_a_member/.test(cx.message), 'signed out or not a member: refused', `${anon.message} / ${cx.message}`);
ok((await call(C, `public.library_tmdb_cache_purge()`)).ok === false, 'a non-member can’t purge');
const direct = [`insert into public.tmdb_tv_cache (kind, tmdb_id, season_number, data) values ('show', 700002, -1, '{}')`,
  `update public.tmdb_tv_cache set data = '{"a": 1}'`, `delete from public.tmdb_tv_cache`];
for (const s of direct) ok(/library_write_required|permission denied/.test(await as(A, s).then(() => '', e => e.message)), `a direct write is refused: ${s.split(' ')[0]}`);
ok((await as(A, `select has_table_privilege('anon', 'public.tmdb_tv_cache', 'select') a, has_function_privilege('authenticated', 'private.tmdb_cache_expire()', 'execute') e`))[0].a === false
  && (await as(A, `select has_function_privilege('authenticated', 'private.tmdb_cache_expire()', 'execute') e`))[0].e === false, 'anon has no access; members can’t run the expiry');
const purgeB = await call(B, `public.library_tmdb_cache_purge()`);
ok(purgeB.r.removed === 1 && (await count(A)) === 2, 'a member’s purge removes only their own rows');

section('expiry');
await db.exec(`begin; select set_config('watchlist.library_write', 'on', true);
  update public.tmdb_tv_cache set fetched_at = now() - interval '151 days' where tmdb_id = 500002;
  update public.tmdb_tv_cache set fetched_at = now() - interval '149 days' where tmdb_id = 500001; commit;`);
await put(B, [showRow(500003, 0)]);
await db.exec(`begin; select set_config('watchlist.library_write', 'on', true); update public.tmdb_tv_cache set fetched_at = now() - interval '400 days' where tmdb_id = 500003; commit;`);
const fpBefore = await fpAll();
ok((await val(`select private.tmdb_cache_expire()`)) === 2, 'the job’s statement deletes the rows past 150 days, across members');
ok((await stored(A, 'show', 500001, -1)) !== null && (await stored(A, 'season', 500002, 3)) === null && (await count(B)) === 0, 'a row 149 days old stays; 151 and 400 days old are gone');
ok(fpBefore === await fpAll(), 'nothing outside the cache changed (library, marks, queues, games, the IGDB cache)');
ok(/library_write_required/.test(await db.exec(`delete from public.tmdb_tv_cache`).then(() => '', e => e.message)), 'outside the function the guard still refuses deletes, even for postgres');

section('restore leaves the cache alone');
await put(A, [seasonRow(500004, 1, 0)]);
const cacheA = await as(A, `select kind, tmdb_id, season_number, rev::text, data from public.tmdb_tv_cache order by kind, tmdb_id, season_number`);
const rr = await restore(A, library9(3));
ok(rr.ok && rr.r.formatVersion === 9, 'a format-9 restore runs', rr.message);
ok(same(cacheA, await as(A, `select kind, tmdb_id, season_number, rev::text, data from public.tmdb_tv_cache order by kind, tmdb_id, season_number`)), 'the member’s cache is exactly as it was (rows, revisions, data)');
ok(!(JSON.stringify(library9(3)).includes('tmdb_tv_cache')), 'a backup has no cache table');

// ── PostgreSQL 17 ──
if (!process.env.PG_BIN) console.log('\nNOTICE: PG_BIN is not set, so the simultaneous writes on real PostgreSQL 17 were SKIPPED.');
else {
  const BIN = process.env.PG_BIN, WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tc1pg-')), DATA = path.join(WORK, 'data'), SOCK = path.join(WORK, 's');
  fs.mkdirSync(SOCK);
  const bin = n => path.join(BIN, n);
  const psql = text => execFileSync(bin('psql'), ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', SOCK, '-U', 'postgres', '-d', 'postgres'], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();
  process.on('exit', () => { try { execFileSync(bin('pg_ctl'), ['-D', DATA, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch (e) { /* not running */ } fs.rmSync(WORK, { recursive: true, force: true }); });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const session = () => {
    const p = spawn(bin('psql'), ['-X', '-At', '-h', SOCK, '-U', 'postgres', '-d', 'postgres'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', n = 0; p.stdout.on('data', d => { buf += d; }); p.stderr.on('data', d => { buf += d; });
    const s = { send(text) { const mark = `zzdone${++n}`; buf = ''; p.stdin.write(`${text}\n\\echo ${mark}\n`); return mark; },
      async done(mark, ms = 60000) { const t0 = Date.now(); while (!buf.includes(mark)) { if (Date.now() - t0 > ms) throw new Error(`no answer: ${buf.slice(0, 300)}`); await wait(10); } return buf.split(mark)[0]; },
      run(text) { return s.done(s.send(text)); }, end() { p.stdin.end(); } };
    return s;
  };
  const setAs = who => `select set_config('request.jwt.claims', '{"sub": "${who}", "role": "authenticated"}', false), set_config('role', 'authenticated', false);`;
  const waiting = async () => { for (let i = 0; i < 500; i++) { if (Number(psql(`select count(*) from pg_stat_activity where wait_event_type = 'Lock' and state = 'active'`)) > 0) return true; await wait(10); } return false; };
  section('real PostgreSQL 17: simultaneous writes');
  execFileSync(bin('initdb'), ['-D', DATA, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
  execFileSync(bin('pg_ctl'), ['-D', DATA, '-o', `-c listen_addresses='' -c unix_socket_directories='${SOCK}' -c timezone=UTC -c deadlock_timeout=200ms`, '-l', path.join(WORK, 'log'), '-w', 'start'], { stdio: 'ignore' });
  await replay(async t => { psql(t); });
  psql(SIMPLIFY); psql(Q1); psql(G1); psql(CRON); psql(tc1('local-tc1'));
  const f = path.join(WORK, 'a.json'); fs.writeFileSync(f, JSON.stringify(L1));
  psql(`${setAs(A)}\n\\set doc \`cat ${f}\`\nselect public.restore_backup(:'doc'::jsonb, false) is not null;`);
  const putSql = rows => `select public.library_tmdb_cache_put('${JSON.stringify(rows)}'::jsonb) ->> 'rows';`;
  const s1 = session(), s2 = session();
  await s1.run(setAs(A)); await s2.run(setAs(A));
  {
    // Two devices create the same row at once: the second waits, then is answered with the first.
    await s1.run(`begin; ${putSql([showRow(800001, 0, 6.1)])}`);
    const m = s2.send(putSql([showRow(800001, 0, 6.2)]));
    ok(await waiting(), 'a second write for the member waits for the first');
    await s1.run('commit;');
    const out = JSON.parse((await s2.done(m)).trim().split('\n').pop());
    ok(out[0].written === false && out[0].data.a === 6.1, 'then it is answered with the first write (nothing replaced)', JSON.stringify(out));
  }
  {
    // Two devices update from the same revision at once: one write, never both.
    const rev = Number(JSON.parse(psql(`${setAs(A)}\nselect json_agg(rev) from public.tmdb_tv_cache where tmdb_id = 800001;`).split('\n').pop())[0]);
    await s1.run(`begin; ${putSql([showRow(800001, rev, 7.1)])}`);
    const m = s2.send(putSql([showRow(800001, rev, 7.2)]));
    ok(await waiting(), 'an update from the same revision waits');
    await s1.run('commit;');
    const out = JSON.parse((await s2.done(m)).trim().split('\n').pop());
    ok(out[0].written === false && out[0].data.a === 7.1, 'then it is ignored; the first update stands', JSON.stringify(out));
  }
  {
    // A cache write and a restore of the same member don't wait for each other (restore doesn't touch the cache).
    await s1.run(`begin; ${putSql([showRow(800002, 0)])}`);
    const out = await s2.run(`\\set doc \`cat ${f}\`\nselect public.restore_backup(:'doc'::jsonb, false) is not null;`);
    ok(/^t$/m.test(out), 'a restore runs while a cache write is open', out);
    await s1.run('commit;');
  }
  s1.end(); s2.end();
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
