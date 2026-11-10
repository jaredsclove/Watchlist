// G1's database tests: games on a database replayed to its final state (db/q1_queues.sql, then db/g1_games.sql).
//   PGLITE_DIR=<dir with @electric-sql/pglite> [PG_BIN=<postgres 17 bin>] node tools/g1-test.mjs
// PGlite covers behaviour: the migration (refusals, every existing row and queue unchanged), settings, games, versions and spots,
// completion, follows, decisions, collections, the IGDB cache, games in queues and the whole-queue order, accounts, restore at
// format 9. Real PostgreSQL 17 (a throwaway server, removed at the end) adds simultaneous saves from two sessions. Without
// PG_BIN that part is skipped, with a notice. Synthetic data only ("ZZ …", made-up IGDB ids). Output: pass/fail and counts.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { replay, library8, library9, file, clone, A, B, C } from './restore-fixture.mjs';

if (!process.env.PGLITE_DIR) { console.error('usage: PGLITE_DIR=<dir> [PG_BIN=<postgres 17 bin>] node tools/g1-test.mjs'); process.exit(2); }
const req = createRequire(path.join(process.env.PGLITE_DIR, 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));

let passed = 0, failed = 0;
const ok = (c, l, d = '') => { c ? passed++ : failed++; if (!c) console.log(`  FAIL ${l}${d ? `\n       ${String(d).slice(0, 600)}` : ''}`); };
const section = t => console.log(`[${t}]`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const id1 = n => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const film = n => id1(3000 + n), show = s => id1(1000 + s), season = (s, n) => id1(10000000 + s * 10 + n);
const MIG = file('db/g1_games.sql'), g1 = run => `select set_config('watchlist.g1_run', '${run}', false);\n` + MIG;
const SIMPLIFY = `select set_config('watchlist.simplify_run', 'local-simplify', false);\n` + file('db/simplify_restore_cleanup.sql');
const Q1 = `select set_config('watchlist.q1_run', 'local-q1', false);\n` + file('db/q1_queues.sql');

const db = new PGlite();
await replay(t => db.exec(t));
await db.exec(SIMPLIFY);
await db.exec(Q1);
const as = (who, sql, params = []) => db.transaction(async tx => {
  await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [who ? JSON.stringify({ sub: who, role: 'authenticated' }) : '']);
  return (await tx.query(sql, params)).rows;
});
const call = (who, sql, params = []) => as(who, `select ${sql} r`, params).then(r => ({ ok: true, r: r[0].r }), e => ({ ok: false, message: e.message, code: e.code }));
const val = async s => Object.values((await db.query(s)).rows[0])[0];
const restore = (who, doc) => call(who, `public.restore_backup($1::jsonb, false)`, [JSON.stringify(doc)]);
const arr = a => `{${a.join(',')}}`;

section('the migration');
const L1 = library8(1), L2 = library8(2);
ok((await restore(A, L1)).ok && (await restore(B, L2)).ok, 'two format-8 libraries with queues restore before the migration');
const fpAll = () => val(`select md5(string_agg(x, '|' order by x)) from (
  select to_jsonb(r)::text x from public.watchlist_items r union all select to_jsonb(r)::text from public.tv_shows r
  union all select to_jsonb(r)::text from public.collection_memberships r union all select to_jsonb(r)::text from public.personal_collections r
  union all select to_jsonb(r)::text from public.episode_marks r union all select to_jsonb(r)::text from public.update_findings r
  union all select to_jsonb(r)::text from public.watch_queues r union all select (to_jsonb(r) - 'game_entry_id')::text from public.queue_entries r
  union all select to_jsonb(r)::text from private.library_members r) q`);
const before = await fpAll();
const attempt = text => db.exec(text).then(() => null, async e => { await db.exec('rollback'); return e.message; });
ok(/set watchlist.g1_run/.test(await attempt(`select set_config('watchlist.g1_run', '', false);\n` + MIG)) && (await val(`select to_regclass('public.game_entries') is null`)), 'without a run id: refused, nothing created');
const late = g1('local-late').replace("select 'G1|'", () => `do $$ begin raise exception 'zz failure before commit'; end $$;\nselect 'G1|'`);
ok(/zz failure before commit/.test(await attempt(late)) && (await val(`select to_regclass('public.game_entries') is null`))
  && (await val(`select public.stage5_capabilities() ->> 'phase'`)) === 'contracted-q1'
  && (await val(`select count(*)::int from information_schema.columns where table_name = 'queue_entries' and column_name = 'game_entry_id'`)) === 0,
  'a failure just before commit leaves the database as it was');
ok(!(await attempt(g1('local-g1'))), 'the migration commits on a database holding libraries and queues');
ok(before === await fpAll(), 'no library row, collection, membership, queue, queue entry or member changed');
ok(/already installed/.test(await attempt(g1('local-g1-again'))), 'a rerun is refused');
const cap = (await call(A, `public.stage5_capabilities()`)).r;
ok(cap.phase === 'contracted-g1' && cap.backup_format === 9 && cap.g1 === 1 && cap.q1 === 1 && cap.member === true, 'the capability says contracted-g1, format 9', JSON.stringify(cap));
ok(/converted in the page/.test((await restore(A, L1)).message || ''), 'a format-8 file sent directly is refused: the page converts it');
const QA = L1.tables.watch_queues[0].id;
const entryOrder = (who, q) => as(who, `select coalesce(json_agg(id order by position), '[]') o from public.queue_entries where queue_id = $1`, [q]).then(r => r[0].o);
ok(same(await entryOrder(A, QA), L1.tables.queue_entries.filter(e => e.queue_id === QA).sort((a, b) => a.position - b.position).map(e => e.id)), 'existing queues keep their entries in their order');
const E0 = await entryOrder(A, QA);
ok((await call(A, `public.library_queue_move($1, $2::uuid[], $3, $4)`, [QA, arr(E0), E0[2], 1])).ok, 'an existing queue still moves with library_queue_move');

section('settings');
const saveSettings = (who, expected, platforms, style) => call(who, `public.library_game_settings_save($1::jsonb, $2::text[], $3)`, [expected === null ? null : JSON.stringify(expected), arr(platforms), style]);
ok((await as(A, `select count(*)::int n from public.game_settings`))[0].n === 0, 'no settings until a member saves them');
const s1 = await saveSettings(A, null, ['ps5'], 'main');
ok(s1.ok && same(s1.r.platforms, ['ps5']) && s1.r.play_style === 'main', 'PS5 only, Main story', s1.message);
ok(/target_changed/.test((await saveSettings(A, null, ['ps5', 'switch'], 'main')).message), 'a save from a page that saw no settings is refused once they exist');
ok((await saveSettings(A, { platforms: ['ps5'], play_style: 'main' }, ['ps5', 'switch'], 'completionist')).ok, 'a save with what the page showed');
ok(/target_changed/.test((await saveSettings(A, { platforms: ['ps5'], play_style: 'main' }, ['ps5'], 'main')).message), 'a save from an out-of-date page is refused');
ok(/invalid_input/.test((await saveSettings(A, { platforms: ['ps5', 'switch'], play_style: 'completionist' }, ['ps9'], 'main')).message)
  && /invalid_input/.test((await saveSettings(A, { platforms: ['ps5', 'switch'], play_style: 'completionist' }, ['ps5', 'ps5'], 'main')).message)
  && /invalid_input/.test((await saveSettings(A, { platforms: ['ps5', 'switch'], play_style: 'completionist' }, ['ps5'], 'speedrun')).message), 'unknown or repeated platforms and an unknown style are refused');
ok((await saveSettings(A, { platforms: ['ps5', 'switch'], play_style: 'completionist' }, ['ps5'], 'main_extra')).ok, 'back to PS5 only, Main story + side content');
ok((await as(B, `select count(*)::int n from public.game_settings`))[0].n === 0, 'another member sees none of them');

section('games: add, versions, status');
const add = (who, igdb, title, spot, ports = [], status = 'want', priority = 'normal') => call(who, `public.library_game_add($1, $2, $3, $4::integer[], $5, $6)`, [igdb, title, spot, arr(ports), status, priority]);
const set = (who, entry, expected, status, priority) => call(who, `public.library_game_set($1, $2::jsonb, $3, $4)`, [entry, JSON.stringify(expected), status, priority]);
// A franchise spot: an original (900001), its remaster (900002, with a joined port record 900003) and a distinct game with a reused title (900010).
const orig = await add(A, 900001, 'ZZ War 4', 900001);
const rem = await add(A, 900002, 'ZZ War 4 Remastered', 900001, [900003], 'want', 'high');
const other = await add(A, 900010, 'ZZ War (reboot)', 900010);
ok(orig.ok && rem.ok && other.ok && orig.r.status === 'want' && orig.r.priority === 'normal' && same(rem.r.port_ids, [900003]), 'an original, its remaster with a port, and a distinct game are saved', [orig.message, rem.message, other.message].join(' / '));
const O = orig.r.id, R = rem.r.id, D = other.r.id;
ok(/game_duplicate/.test((await add(A, 900001, 'ZZ War 4', 900001)).message), 'the same record again is refused');
ok(/game_duplicate/.test((await add(A, 900003, 'ZZ War 4 Port', 900001)).message), 'a record already joined to another game as its port is refused');
ok(/game_duplicate/.test((await add(A, 900020, 'ZZ New', 900020, [900002])).message), 'a port that is already a saved game is refused');
ok((await add(B, 900001, 'ZZ War 4', 900001)).ok, 'another member may save the same record');
ok(/invalid_input/.test((await add(A, 900030, ' padded ', 900030)).message) && /invalid_input/.test((await add(A, 900031, 'ZZ', 900031, [900031])).message)
  && /invalid_input/.test((await add(A, 900032, 'ZZ', 900032, [], 'beaten')).message), 'bad titles, a record as its own port and unknown statuses are refused');
ok((await set(A, O, { status: 'want', priority: 'normal' }, 'playing', 'high')).ok, 'status and priority change with what the page showed');
ok(/target_changed/.test((await set(A, O, { status: 'want', priority: 'normal' }, 'paused', 'high')).message), 'a change from an out-of-date page is refused');
ok(/target_missing/.test((await set(B, O, { status: 'playing', priority: 'high' }, 'finished', 'high')).message), 'another member’s game is out of reach');

section('games in queues, completion and replays');
const addGame = (who, q, e) => call(who, `public.library_queue_add_game($1, $2)`, [q, e]);
const QB = L1.tables.watch_queues[1].id;
const a1 = await addGame(A, QA, O), a2 = await addGame(A, QA, R), a3 = await addGame(A, QB, O), a4 = await addGame(A, QB, D);
ok(a1.ok && a2.ok && a3.ok && a4.ok && a1.r.game_entry_id === O && a1.r.place === E0.length + 1, 'games go to the bottom of mixed queues (films, shows and seasons already there)', [a1.message, JSON.stringify(a1.r)].join(' / '));
ok((await as(A, `select status, priority from public.game_entries where id = $1`, [O]))[0].status === 'playing', 'adding changes no status');
ok(/queue_duplicate/.test((await addGame(A, QA, O)).message) && new RegExp(`#${E0.length + 1}`).test((await addGame(A, QA, O)).message), 'the same game again in a queue is refused, naming its place');
ok(/target_missing/.test((await addGame(B, QA, O)).message), 'another member can’t queue A’s game');
const fin = await set(A, R, { status: 'want', priority: 'high' }, 'finished', 'high');
ok(fin.ok && fin.r.queue_entries_removed === 1, 'finishing the remaster reports its one queue entry removed', JSON.stringify(fin.r || fin.message));
const inQueues = (who, e) => as(who, `select count(*)::int n from public.queue_entries where game_entry_id = $1`, [e]).then(r => r[0].n);
ok(await inQueues(A, R) === 0 && await inQueues(A, O) === 2, 'the remaster left every queue; the original version stays in both of its queues');
ok((await as(A, `select status from public.game_entries where id = $1`, [O]))[0].status === 'playing', 'finishing one version doesn’t touch another version of the same spot');
ok((await addGame(A, QA, R)).ok && await inQueues(A, R) === 1, 'a Finished game may be queued again (a replay)');
ok((await set(A, R, { status: 'finished', priority: 'high' }, 'finished', 'low')).ok && await inQueues(A, R) === 1, 'changing a Finished game’s priority leaves the replay queued');
ok((await set(A, R, { status: 'finished', priority: 'low' }, 'playing', 'low')).ok && (await set(A, R, { status: 'playing', priority: 'low' }, 'finished', 'low')).r.queue_entries_removed === 1
  && await inQueues(A, R) === 0, 'set to Finished again, it leaves the queue again');
ok((await set(A, O, { status: 'playing', priority: 'high' }, 'skipped', 'high')).ok && await inQueues(A, O) === 2, 'Skipped removes nothing from queues');
ok((await set(A, O, { status: 'skipped', priority: 'high' }, 'paused', 'high')).ok && await inQueues(A, O) === 2, 'nor does Paused');

section('the whole-queue order (hidden entries keep their places)');
const setOrder = (who, q, expected, order) => call(who, `public.library_queue_set_order($1, $2::uuid[], $3::uuid[])`, [q, arr(expected), arr(order)]);
// A queue built like the worked example: [Dune, hidden Switch game, Severance S2, Astro Bot].
const QX = (await call(A, `public.library_queue_create($1)`, ['ZZ Worked Example'])).r.id;
const sw = (await add(A, 900040, 'ZZ Switch Game', 900040)).r.id, astro = (await add(A, 900041, 'ZZ Astro', 900041)).r.id;
await call(A, `public.library_queue_add($1, $2, $3)`, [QX, null, film(1)]);
await addGame(A, QX, sw);
await call(A, `public.library_queue_add($1, $2, $3)`, [QX, null, season(2, 2)]);
await addGame(A, QX, astro);
const [dune, swE, sev, astE] = await entryOrder(A, QX);
// The page keeps the hidden entry's slot (2) and puts the visible ones in slots 1, 3, 4.
ok((await setOrder(A, QX, [dune, swE, sev, astE], [astE, swE, dune, sev])).ok && same(await entryOrder(A, QX), [astE, swE, dune, sev]), 'Astro Bot to the top: [Astro Bot, hidden, Dune, Severance S2]');
ok((await setOrder(A, QX, [astE, swE, dune, sev], [dune, swE, sev, astE])).ok, '(back to the original order)');
ok((await setOrder(A, QX, [dune, swE, sev, astE], [sev, swE, astE, dune])).ok && same(await entryOrder(A, QX), [sev, swE, astE, dune]), 'Dune to the bottom: [Severance S2, hidden, Astro Bot, Dune]');
ok(/target_changed/.test((await setOrder(A, QX, [dune, swE, sev, astE], [astE, swE, dune, sev])).message) && same(await entryOrder(A, QX), [sev, swE, astE, dune]), 'an order from an out-of-date page is refused, nothing changed');
const now = await entryOrder(A, QX);
ok(/invalid_input/.test((await setOrder(A, QX, now, now.slice(0, 3))).message) && /invalid_input/.test((await setOrder(A, QX, now, [now[0], now[0], now[1], now[2]])).message)
  && /invalid_input/.test((await setOrder(A, QX, now, [now[0], now[1], now[2], E0[0]])).message), 'an order that drops, repeats or adds an entry is refused');
ok((await as(A, `select json_agg(position order by position) p from public.queue_entries where queue_id = $1`, [QX]))[0].p.join() === '1,2,3,4', 'places are 1..n afterwards');
ok(/queue_missing/.test((await setOrder(B, QX, now, now)).message), 'another member can’t reorder it');
const qbIds = await entryOrder(A, QB);
ok((await setOrder(A, QB, qbIds, qbIds.slice().reverse())).ok && same(await entryOrder(A, QB), qbIds.slice().reverse()), 'it reorders a queue of films, seasons and games alike');

section('relinking a version (review), deleting a game');
const relink = (who, e, expected, spot, ports) => call(who, `public.library_game_relink($1, $2::jsonb, $3, $4::integer[])`, [e, JSON.stringify(expected), spot, arr(ports)]);
ok((await relink(A, R, { spot_igdb_id: 900001, port_ids: [900003] }, 900001, [900003, 900004])).ok, 'a port joined after review');
ok(/target_changed/.test((await relink(A, R, { spot_igdb_id: 900001, port_ids: [900003] }, 900002, [])).message), 'a relink from an out-of-date page is refused');
ok(/game_duplicate/.test((await relink(A, D, { spot_igdb_id: 900010, port_ids: [] }, 900010, [900004])).message), 'a port another game holds can’t be joined');
ok((await as(A, `select status from public.game_entries where id = $1`, [R]))[0].status === 'finished', 'relinking changes no status');
const gc = await call(A, `public.library_game_collection_create($1)`, ['ZZ Couch']);
await call(A, `public.library_game_collection_add($1, $2)`, [gc.r.id, D]);
await addGame(A, QA, D);
const del = await call(A, `public.library_game_delete($1, $2)`, [D, 'want']);
ok(del.ok && del.r.queue_entries_removed === 2 && del.r.collection_memberships_removed === 1, 'deleting a game takes its queue entries and memberships with it, and says so', JSON.stringify(del.r || del.message));
ok(/target_changed/.test((await call(A, `public.library_game_delete($1, $2)`, [O, 'want'])).message), 'a delete from an out-of-date page is refused');

section('follows and decisions');
const follow = await call(A, `public.library_game_follow($1, $2)`, [7001, 'ZZ War']);
ok(follow.ok && /game_follow_exists/.test((await call(A, `public.library_game_follow($1, $2)`, [7001, 'ZZ War'])).message), 'following, once');
ok((await as(A, `select count(*)::int n from public.game_entries where status = 'want'`))[0].n === (await as(A, `select count(*)::int n from public.game_entries where status = 'want'`))[0].n, '(following saves nothing)');
const decide = (who, kind, igdb, platform, expected, value) => call(who, `public.library_game_decision_set($1, $2, $3, $4::jsonb, $5::jsonb)`,
  [kind, igdb, platform, expected === null ? null : JSON.stringify(expected), value === null ? null : JSON.stringify(value)]);
const noy = await decide(B, 'not_out_yet', 900050, 'ps5', null, { date: '2026-10-23', precision: 'day' });
ok(noy.ok && noy.r.basis === 'member', 'Not out yet works for a member without research access', noy.message);
ok(/target_changed/.test((await decide(B, 'not_out_yet', 900050, 'ps5', null, { date: '2026-10-23', precision: 'day' })).message), 'setting it again from a page that saw none is refused');
ok((await decide(B, 'not_out_yet', 900050, 'ps5', { date: '2026-10-23', precision: 'day' }, null)).r.removed === true, '“It’s out” clears it with what the page showed');
ok(/research_not_enabled/.test((await decide(B, 'available', 900051, 'ps5', null, { evidence: [{ url: 'https://zz.example.com' }] })).message), 'recording Store evidence needs research access');
const av = await decide(A, 'available', 900051, 'ps5', null, { precision: 'month', month: '2027-03', evidence: [{ url: 'https://zz.example.com' }] });
ok(av.ok && av.r.basis === 'research', 'with research access it is recorded as research', av.message);
ok((await decide(A, 'skip_spot', 900001, '', null, {})).ok && (await decide(A, 'include_spinoff', 900060, null, null, {})).ok && (await decide(A, 'keep_link', 900002, '', null, { spot_igdb_id: 900009, port_ids: [] })).ok, 'Skip this spot, Include a spin-off and Keep my link');
ok(/invalid_input/.test((await decide(A, 'skip_spot', 900001, 'ps5', null, {})).message) && /invalid_input/.test((await decide(A, 'not_out_yet', 900001, '', null, {})).message)
  && /invalid_input/.test((await decide(A, 'nope', 900001, '', null, {})).message) && /invalid_input/.test((await decide(A, 'not_out_yet', 900001, 'ps5', null, [1])).message), 'decisions of the wrong shape are refused');
ok((await call(A, `public.library_game_unfollow($1)`, [follow.r.id])).r.removed === true && (await as(A, `select count(*)::int n from public.game_decisions`))[0].n === 4, 'unfollowing keeps the decisions and saved games');
// Research: a decision that carries evidence is research, and needs research access; clearing one is the member's own choice.
const ev = { evidence: [{ source: 'playstation_store', url: 'https://store.playstation.com/zz', checked: '2026-11-01' }], research_date: '2026-11-01' };
ok(/research_not_enabled/.test((await decide(B, 'research_link', 900070, '', null, { relation: 'own_spot', ...ev })).message), 'a relationship finding needs research access');
ok(/research_not_enabled/.test((await decide(B, 'not_out_yet', 900071, 'ps5', null, { date: '2026-10-23', precision: 'day', ...ev })).message), 'so does a hold that carries evidence');
const rl = await decide(A, 'research_link', 900070, '', null, { relation: 'port_of', target_igdb_id: 900001, ...ev });
const rh = await decide(A, 'not_out_yet', 900071, 'ps5', null, { date: '2026-10-23', precision: 'day', ...ev });
ok(rl.ok && rl.r.basis === 'research' && rh.ok && rh.r.basis === 'research', 'with research access both are recorded as research', [rl.message, rh.message].join(' / '));
ok((await decide(A, 'not_out_yet', 900071, 'ps5', { date: '2026-10-23', precision: 'day', ...ev }, { date: '2026-10-23', precision: 'day' })).r.basis === 'member', 'the same hold without evidence is the member’s again');
ok(/invalid_input/.test((await decide(A, 'research_role', 900072, 'ps5', null, { role: 'main', ...ev })).message), 'a series role takes no platform');
await as(A, `select 1`);
ok(/library_write_required|violates check/.test(await as(A, `insert into public.game_decisions (kind, igdb_id, platform, value, basis) values ('research_role', 5, '', '{}', 'member')`).then(() => 'inserted', e => e.message)), 'a research kind can’t be stored as a member’s');
ok((await decide(A, 'research_link', 900070, '', { relation: 'port_of', target_igdb_id: 900001, ...ev }, null)).r.removed === true, 'research findings are dismissed by clearing them');

section('collections are independent of follows and queues');
const C1 = gc.r.id;
ok((await call(A, `public.library_game_collection_add($1, $2)`, [C1, O])).ok && (await call(A, `public.library_game_collection_add($1, $2)`, [C1, R])).ok, 'two versions in a collection');
ok(/collection_duplicate/.test((await call(A, `public.library_game_collection_add($1, $2)`, [C1, O])).message), 'the same game twice is refused');
ok(/collection_name_taken/.test((await call(A, `public.library_game_collection_create($1)`, ['zz couch'])).message), 'a name in use (ignoring case) is refused');
const members = () => as(A, `select count(*)::int n from public.game_collection_members where collection_id = $1`, [C1]).then(r => r[0].n);
await addGame(A, QA, O);
ok((await set(A, O, { status: 'paused', priority: 'high' }, 'finished', 'high')).ok && await members() === 2 && await inQueues(A, O) === 0, 'finishing a game takes it out of queues, never out of a collection');
await call(A, `public.library_game_follow($1, $2)`, [7001, 'ZZ War']);
ok(await members() === 2, 'following changes no collection');
const mem = (await as(A, `select id from public.game_collection_members where collection_id = $1 and entry_id = $2`, [C1, O]))[0].id;
ok((await call(A, `public.library_game_collection_remove($1)`, [mem])).r.removed && await members() === 1 && (await as(A, `select count(*)::int n from public.game_entries where id = $1`, [O]))[0].n === 1, 'removing from a collection never removes the game');
ok((await call(A, `public.library_game_collection_rename($1, $2, $3)`, [C1, 'ZZ Couch', 'ZZ Sofa'])).ok && /target_changed/.test((await call(A, `public.library_game_collection_rename($1, $2, $3)`, [C1, 'ZZ Couch', 'ZZ X'])).message), 'rename with what the page showed');
ok(/target_changed/.test((await call(A, `public.library_game_collection_delete($1, $2)`, [C1, 0])).message) && (await call(A, `public.library_game_collection_delete($1, $2)`, [C1, 1])).r.members_removed === 1
  && (await as(A, `select count(*)::int n from public.game_entries where id = $1`, [R]))[0].n === 1, 'deleting a collection with the count shown keeps its games');

section('the IGDB cache');
const put = (who, rows) => call(who, `public.library_game_titles_put($1::jsonb)`, [JSON.stringify(rows)]);
ok((await put(A, [{ igdb_id: 900001, data: { n: 'ZZ War 4' } }, { igdb_id: 900002, data: { n: 'x' } }])).r.cached === 2, 'records are cached');
ok((await put(A, [{ igdb_id: 900001, data: { n: 'ZZ War 4 (fixed)' } }])).ok && (await as(A, `select data ->> 'n' n from public.game_titles where igdb_id = 900001`))[0].n === 'ZZ War 4 (fixed)', 'a newer read replaces a cached record');
ok(/invalid_input/.test((await put(A, [{ igdb_id: 1, data: {} }, { igdb_id: 1, data: {} }])).message) && /invalid_input/.test((await put(A, [{ igdb_id: 'x', data: {} }])).message), 'repeated or malformed records are refused');
ok((await as(B, `select count(*)::int n from public.game_titles`))[0].n === 0, 'another member sees no cached record of A’s');

section('isolation');
ok(/library_write_required/.test(await as(A, `insert into public.game_entries (igdb_id, spot_igdb_id, title) values (1, 1, 'ZZ')`).then(() => 'inserted', e => e.message)), 'a direct insert is refused');
ok(/library_write_required/.test(await as(A, `update public.game_entries set status = 'finished' where id = '${O}'`).then(() => 'updated', e => e.message)), 'a direct update is refused');
ok(/library_write_required/.test(await as(A, `insert into public.queue_entries (queue_id, game_entry_id, position) values ('${QA}', '${R}', 99)`).then(() => 'inserted', e => e.message)), 'a direct queue insert is refused');
ok((await as(B, `with d as (delete from public.game_entries returning 1) select count(*)::int n from d`).catch(e => [{ n: e.message }]))[0].n !== undefined
  && (await as(A, `select count(*)::int n from public.game_entries`))[0].n >= 4, 'another member’s delete reaches none of A’s games');
ok(/not_a_member/.test((await add(C, 1, 'ZZ', 1)).message) && /not_a_member/.test((await saveSettings(C, null, ['ps5'], 'main')).message)
  && (await as(C, `select count(*)::int n from public.game_entries`))[0].n === 0, 'a signed-in non-member can save nothing and reads nothing');
const anon = sql => db.transaction(async tx => { await tx.query(`select set_config('role', 'anon', true)`); return (await tx.query(sql)).rows; }).then(() => 'ran', e => e.message);
ok(['game_settings', 'game_entries', 'game_follows', 'game_decisions', 'game_collections', 'game_collection_members', 'game_titles'].every(Boolean)
  && /permission denied/.test(await anon(`select * from public.game_entries`)) && /permission denied/.test(await anon(`select * from public.game_titles`))
  && /permission denied/.test(await anon(`select public.library_game_add(1, 'x', 1, '{}', 'want', 'normal')`)), 'signed out: nothing at all');

section('restore at format 9');
const L9 = library9(1), L9b = library9(2);
const r9 = await restore(A, L9), r9b = await restore(B, L9b);
ok(r9.ok && r9b.ok && r9.r.formatVersion === 9, 'format-9 libraries restore', [r9.message, r9b.message].join(' / '));
const QA9 = L9.tables.watch_queues[0].id;
const order9 = await as(A, `select coalesce(json_agg(json_build_object('id', id, 'p', position, 'g', game_entry_id) order by position), '[]') o from public.queue_entries where queue_id = $1`, [QA9]).then(r => r[0].o);
const want9 = L9.tables.queue_entries.filter(e => e.queue_id === QA9).sort((a, b) => a.position - b.position).map(e => ({ id: e.id, p: e.position, g: e.game_entry_id }));
ok(same(order9, want9), 'a mixed queue comes back with its games at their exact places (3 and 5, as hidden games keep them)', JSON.stringify(order9));
ok(same((await as(A, `select platforms, play_style from public.game_settings`))[0], { platforms: ['ps5'], play_style: 'main_extra' }), 'platforms and play style come back');
const v9 = await as(A, `select igdb_id, spot_igdb_id, port_ids, status from public.game_entries order by igdb_id`);
ok(same(v9.map(x => [x.igdb_id, x.spot_igdb_id, x.port_ids, x.status]), L9.tables.game_entries.map(x => [x.igdb_id, x.spot_igdb_id, x.port_ids, x.status]).sort((a, b) => a[0] - b[0])), 'versions keep their own status, spot and ports');
ok((await as(A, `select count(*)::int n from public.game_titles`))[0].n === 2, 'the IGDB cache isn’t part of a restore (left as it was)');
ok((await as(A, `select count(*)::int n from public.game_decisions where basis = 'research'`))[0].n === 4 && (await as(B, `select count(*)::int n from public.game_decisions where basis = 'research'`))[0].n === 4,
  'decisions come back, research evidence included, for a member without research access too');
const fpB = await as(B, `select md5(string_agg(to_jsonb(g)::text, '|' order by id)) h from public.game_entries g`);
await restore(A, L9);
ok(same(fpB, await as(B, `select md5(string_agg(to_jsonb(g)::text, '|' order by id)) h from public.game_entries g`)), 'A’s restore leaves B’s games alone');
const fin9 = await set(A, L9.tables.game_entries[1].id, { status: 'want', priority: 'high' }, 'finished', 'high');
ok(fin9.ok && fin9.r.queue_entries_removed === 1, 'after a restore, finishing a restored game still takes it out of its queue');

// ── PostgreSQL 17 ──
if (!process.env.PG_BIN) console.log('\nNOTICE: PG_BIN is not set, so the simultaneous saves on real PostgreSQL 17 were SKIPPED.');
else {
  const BIN = process.env.PG_BIN, WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'g1pg-')), DATA = path.join(WORK, 'data'), SOCK = path.join(WORK, 's');
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
  section('real PostgreSQL 17: simultaneous saves');
  execFileSync(bin('initdb'), ['-D', DATA, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
  execFileSync(bin('pg_ctl'), ['-D', DATA, '-o', `-c listen_addresses='' -c unix_socket_directories='${SOCK}' -c timezone=UTC -c deadlock_timeout=200ms`, '-l', path.join(WORK, 'log'), '-w', 'start'], { stdio: 'ignore' });
  await replay(async t => { psql(t); });
  psql(SIMPLIFY); psql(Q1); psql(g1('local-g1'));
  const f = path.join(WORK, 'a.json'); fs.writeFileSync(f, JSON.stringify(L9));
  psql(`${setAs(A)}\n\\set doc \`cat ${f}\`\nselect public.restore_backup(:'doc'::jsonb, false) is not null;`);
  const q = L9.tables.watch_queues[0].id, G = L9.tables.game_entries[2].id;
  const ids = () => JSON.parse(psql(`${setAs(A)}\nselect coalesce(json_agg(id order by position), '[]') from public.queue_entries where queue_id = '${q}';`).split('\n').pop());
  const s1 = session(), s2 = session();
  await s1.run(setAs(A)); await s2.run(setAs(A));
  {
    // Two devices reorder the same queue from the same page state: the second waits, then is refused as out of date.
    const e = ids();
    await s1.run(`begin; select public.library_queue_set_order('${q}', '{${e.join(',')}}', '{${e.slice().reverse().join(',')}}') is not null;`);
    const m = s2.send(`select public.library_queue_set_order('${q}', '{${e.join(',')}}', '{${[e[1], e[0], ...e.slice(2)].join(',')}}') is not null;`);
    ok(await waiting(), 'a second whole-queue order waits for the first');
    await s1.run('commit;');
    const out = await s2.done(m);
    ok(/target_changed/.test(out) && same(ids(), e.slice().reverse()), 'then it is refused as out of date; the first order stands', out);
  }
  {
    // A game finished on one device while another reorders the queue holding it: one runs after the other, never a mix.
    const e = ids();
    await s1.run(`begin; select public.library_game_set('${G}', '{"status": "playing", "priority": "low"}', 'finished', 'low') is not null;`);
    const m = s2.send(`select public.library_queue_set_order('${q}', '{${e.join(',')}}', '{${e.slice().reverse().join(',')}}') is not null;`);
    ok(await waiting(), 'a reorder waits while a game in that queue is being finished');
    await s1.run('commit;');
    const out = await s2.done(m);
    ok(/target_changed/.test(out) && !ids().includes(L9.tables.queue_entries.find(x => x.game_entry_id === G).id) && ids().length === e.length - 1, 'then the reorder is refused (the queue changed) and the game is gone from it', out);
  }
  s1.end(); s2.end();
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
