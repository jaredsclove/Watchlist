// Q1's database tests: named queues on a database replayed to its final state (db/q1_queues.sql applied after the simplification).
//   PGLITE_DIR=<dir with @electric-sql/pglite> [PG_BIN=<postgres 17 bin>] node tools/q1-test.mjs
// PGlite covers behaviour: the migration (refusals, nothing else changed), the functions, completion and identity, accounts, restore
// at format 8. Real PostgreSQL 17 (a throwaway server on a Unix socket, removed at the end) adds simultaneous saves from two sessions.
// Without PG_BIN that part is skipped, with a notice. Synthetic data only ("ZZ …"). Output: pass/fail and counts.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { replay, library, clone, file, A, B, C } from './restore-fixture.mjs';

if (!process.env.PGLITE_DIR) { console.error('usage: PGLITE_DIR=<dir> [PG_BIN=<postgres 17 bin>] node tools/q1-test.mjs'); process.exit(2); }
const req = createRequire(path.join(process.env.PGLITE_DIR, 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));

let passed = 0, failed = 0;
const ok = (c, l, d = '') => { c ? passed++ : failed++; if (!c) console.log(`  FAIL ${l}${d ? `\n       ${String(d).slice(0, 600)}` : ''}`); };
const section = t => console.log(`[${t}]`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Seed 1's ids (tools/restore-fixture.mjs): show s is id(1000 + s), its season n id(10000000 + 10 s + n); films id(3001..3004).
const id1 = n => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const show = s => id1(1000 + s), season = (s, n) => id1(10000000 + s * 10 + n), film = n => id1(3000 + n);
const id2 = n => `72000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const L1 = library(1), L2 = library(2);
// Format 8: format 7's tables plus the two queue tables (the page converts the same way).
const to8 = (doc, queues = [], entries = []) => {
  const d = clone(doc); d.formatVersion = 8; d.tables.watch_queues = queues; d.tables.queue_entries = entries;
  d.rowCounts = Object.fromEntries(Object.entries(d.tables).map(([k, v]) => [k, v.length])); return d;
};
const MIG = file('db/q1_queues.sql'), q1 = run => `select set_config('watchlist.q1_run', '${run}', false);\n` + MIG;
const SIMPLIFY = `select set_config('watchlist.simplify_run', 'local-simplify', false);\n` + file('db/simplify_restore_cleanup.sql');

// ── PGlite ──
const db = new PGlite();
await replay(t => db.exec(t));
await db.exec(SIMPLIFY);
const as = (who, sql, params = []) => db.transaction(async tx => {
  await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [who ? JSON.stringify({ sub: who, role: 'authenticated' }) : '']);
  return (await tx.query(sql, params)).rows;
});
const call = (who, sql, params = []) => as(who, `select ${sql} r`, params).then(r => ({ ok: true, r: r[0].r }), e => ({ ok: false, message: e.message, code: e.code }));
const val = async s => Object.values((await db.query(s)).rows[0])[0];
// As the database owner (admin scripts' route), with A's id as the default owner of new rows.
const asAdmin = sql => db.exec(`begin; select set_config('watchlist.library_write', 'on', true), set_config('request.jwt.claims', '{"sub": "${A}"}', true); ${sql}; commit;`)
  .catch(async e => { await db.exec('rollback'); throw new Error(e.message); });
const restore = (who, doc) => call(who, `public.restore_backup($1::jsonb, false)`, [JSON.stringify(doc)]);

section('the migration');
ok((await restore(A, L1)).ok && (await restore(B, L2)).ok, 'two format-7 libraries restore before the migration');
const fpAll = () => val(`select md5(string_agg(x, '|' order by x)) from (
  select to_jsonb(r)::text x from public.watchlist_items r union all select to_jsonb(r)::text from public.tv_shows r
  union all select to_jsonb(r)::text from public.collection_memberships r union all select to_jsonb(r)::text from public.episode_marks r
  union all select to_jsonb(r)::text from public.update_findings r union all select to_jsonb(r)::text from private.library_members r) q`);
const before = await fpAll();
const attempt = text => db.exec(text).then(() => null, async e => { await db.exec('rollback'); return e.message; });
ok(/set watchlist.q1_run/.test(await attempt(`select set_config('watchlist.q1_run', '', false);\n` + MIG)) && (await val(`select to_regclass('public.watch_queues') is null`)), 'without a run id: refused, nothing created');
const late = q1('local-late').replace("select 'Q1|'", () => `do $$ begin raise exception 'zz failure before commit'; end $$;\nselect 'Q1|'`);
ok(/zz failure before commit/.test(await attempt(late)) && (await val(`select to_regclass('public.watch_queues') is null`))
  && (await val(`select public.stage5_capabilities() ->> 'phase'`)) === 'contracted-cu1', 'a failure just before commit leaves the database as it was');
ok(!(await attempt(q1('local-q1'))), 'the migration commits on a database holding libraries');
ok(before === await fpAll(), 'no library row, membership or member changed');
ok(/already installed/.test(await attempt(q1('local-q1-again'))), 'a rerun is refused');
const cap = (await call(A, `public.stage5_capabilities()`)).r;
ok(cap.phase === 'contracted-q1' && cap.backup_format === 8 && cap.q1 === 1 && cap.member === true, 'the capability says contracted-q1, format 8', JSON.stringify(cap));
ok((await call(A, `public.restore_backup($1::jsonb, false)`, [JSON.stringify(L1)])).message?.includes('converted in the page'), 'a format-7 file sent directly is refused: the page converts it');

section('queues: create, rename, reorder, delete');
const create = (who, name) => call(who, `public.library_queue_create($1)`, [name]);
const qa = await create(A, 'ZZ Shows Next');
ok(qa.ok && qa.r.sort_order === 1, 'a first queue on an account with none', qa.message);
const qb = await create(A, 'ZZ Films Alone'), qc = await create(A, 'ZZ Third');
ok(qb.r.sort_order === 2 && qc.r.sort_order === 3, 'later queues go at the end');
ok(/queue_name_taken/.test((await create(A, 'zz shows next')).message), 'a name already used (ignoring case) is refused');
ok((await create(B, 'ZZ Shows Next')).ok, 'another member may use the same name');
ok(/invalid_input/.test((await create(A, ' padded ')).message) && /invalid_input/.test((await create(A, '')).message), 'blank and padded names are refused');
const QA = qa.r.id, QB = qb.r.id, QC = qc.r.id;
const order = who => as(who, `select coalesce(json_agg(id order by sort_order), '[]') o from public.watch_queues`).then(r => r[0].o);
const reorder = (who, expected, q, to) => call(who, `public.library_queue_reorder($1::uuid[], $2, $3)`, [`{${expected.join(',')}}`, q, to]);
ok((await reorder(A, [QA, QB, QC], QC, 1)).ok && same(await order(A), [QC, QA, QB]), 'a queue moves to the top');
ok(/target_changed/.test((await reorder(A, [QA, QB, QC], QA, 3)).message) && same(await order(A), [QC, QA, QB]), 'a reorder from an out-of-date order is refused, nothing changed');
ok((await reorder(A, [QC, QA, QB], QC, 9)).ok && same(await order(A), [QA, QB, QC]), 'a place past the end means the end');
ok((await call(A, `public.library_queue_rename($1, $2, $3)`, [QB, 'ZZ Films Alone', 'ZZ Films Solo'])).ok, 'rename with the name the page showed');
ok(/target_changed/.test((await call(A, `public.library_queue_rename($1, $2, $3)`, [QB, 'ZZ Films Alone', 'ZZ Other'])).message), 'rename from an out-of-date name is refused');
ok(/queue_name_taken/.test((await call(A, `public.library_queue_rename($1, $2, $3)`, [QB, 'ZZ Films Solo', 'zz third'])).message), 'rename to a name in use is refused');

section('entries: add, refusals, move, remove');
const add = (who, q, s, i) => call(who, `public.library_queue_add($1, $2, $3)`, [q, s, i]);
const ids = (who, q) => as(who, `select coalesce(json_agg(coalesce(show_id, item_id) order by position), '[]') o from public.queue_entries where queue_id = $1`, [q]).then(r => r[0].o);
const entryIds = (who, q) => as(who, `select coalesce(json_agg(id order by position), '[]') o from public.queue_entries where queue_id = $1`, [q]).then(r => r[0].o);
const statusOf = () => val(`select md5(string_agg(id::text || watched || skipped || status, ',' order by id)) from public.watchlist_items`);
const st0 = await statusOf(), sh0 = await val(`select md5(string_agg(id::text || status || ended, ',' order by id)) from public.tv_shows`);
ok((await add(A, QA, show(1), null)).ok && (await add(A, QA, null, season(2, 3))).ok && (await add(A, QA, null, film(1))).ok, 'a whole show, a season and a film in one queue');
ok((await add(A, QA, null, season(2, 4))).ok, 'a second, distinct season of the same show');
ok(same(await ids(A, QA), [show(1), season(2, 3), film(1), season(2, 4)]), 'each goes to the bottom, in order');
ok(st0 === await statusOf() && sh0 === await val(`select md5(string_agg(id::text || status || ended, ',' order by id)) from public.tv_shows`), 'adding changes no viewing status');
ok(/queue_duplicate/.test((await add(A, QA, null, film(1))).message) && /#3/.test((await add(A, QA, null, film(1))).message), 'the same film again is refused, naming its place');
ok(/queue_duplicate/.test((await add(A, QA, show(1), null)).message), 'the same show again is refused');
ok(/queue_overlap/.test((await add(A, QA, null, season(1, 2))).message), 'a season of a whole show in the queue is refused');
const ov = await add(A, QA, show(2), null);
ok(/queue_overlap/.test(ov.message) && /Season 3, Season 4/.test(ov.message), 'a whole show beside its queued seasons is refused, naming them', ov.message);
ok((await add(A, QB, null, season(1, 2))).ok && (await add(A, QB, null, film(1))).ok, 'the same items in another queue, a show as one season there');
ok((await add(A, QB, null, film(4))).ok && (await add(A, QB, null, season(1, 1))).ok, 'an already watched film and season may be added');
ok((await add(A, QB, show(4), null)).ok, 'an ended show may be added');
ok(/target_missing/.test((await add(A, QA, null, id2(3001))).message), 'another member’s film is out of reach');
ok(/target_missing/.test((await add(B, QA, show(1), null)).message) && /queue_missing/.test((await add(B, QA, id2(1001), null)).message), 'another member’s queue is out of reach');
ok(/invalid_input/.test((await add(A, QA, show(1), film(1))).message) && /invalid_input/.test((await add(A, QA, null, null)).message), 'exactly one of a show or an item');
const move = (who, q, expected, e, to) => call(who, `public.library_queue_move($1, $2::uuid[], $3, $4)`, [q, `{${expected.join(',')}}`, e, to]);
let E = await entryIds(A, QA);
ok((await move(A, QA, E, E[3], 1)).ok && same(await ids(A, QA), [season(2, 4), show(1), season(2, 3), film(1)]), 'an entry moves to the top');
ok(/target_changed/.test((await move(A, QA, E, E[0], 4)).message), 'a move from an out-of-date order is refused');
E = await entryIds(A, QA);
ok((await move(A, QA, E, E[0], 4)).ok && same(await ids(A, QA), [show(1), season(2, 3), film(1), season(2, 4)]), 'and to the bottom');
ok((await as(A, `select json_agg(position order by position) p from public.queue_entries where queue_id = $1`, [QA]))[0].p.join() === '1,2,3,4', 'positions are 1..n after a move');
E = await entryIds(A, QA);
const rm = await call(A, `public.library_queue_remove($1)`, [E[2]]);
ok(rm.ok && rm.r.removed && same(await ids(A, QA), [show(1), season(2, 3), season(2, 4)]), 'an entry is removed; the film stays in the library', rm.message);
ok((await val(`select count(*)::int from public.watchlist_items where id = '${film(1)}'`)) === 1, '(the film is still there)');
ok((await call(A, `public.library_queue_remove($1)`, [E[2]])).r.removed === false, 'removing it again reports it gone');
E = await entryIds(A, QA);
ok((await move(A, QA, E, E[2], 1)).ok, 'a move after a removal (positions with a gap) works');

section('isolation');
ok((await as(B, `select count(*)::int n from public.watch_queues`))[0].n === 1 && (await as(B, `select count(*)::int n from public.queue_entries`))[0].n === 0, 'another member sees only their own queues');
ok(/queue_missing/.test((await call(B, `public.library_queue_rename($1, $2, $3)`, [QA, 'ZZ Shows Next', 'ZZ Mine'])).message), 'nor can they rename one');
ok(/queue_missing/.test((await call(B, `public.library_queue_delete($1, 0)`, [QA])).message), 'or delete one');
ok((await call(B, `public.library_queue_remove($1)`, [E[0]])).r.removed === false && (await entryIds(A, QA)).length === 3, 'or remove an entry');
ok(/library_write_required/.test(await as(A, `insert into public.queue_entries (queue_id, item_id, position) values ('${QA}', '${film(2)}', 99)`).then(() => 'inserted', e => e.message)), 'a direct insert is refused');
ok(/library_write_required|permission/.test(await as(A, `update public.queue_entries set position = 50 where queue_id = '${QA}'`).then(() => 'updated', e => e.message)), 'a direct update is refused');
// Direct deletes of a member's own entries aren't guarded (a film's delete cascades to them); they reach only that member's rows.
ok((await as(B, `with d as (delete from public.queue_entries returning 1) select count(*)::int n from d`))[0].n === 0 && (await entryIds(A, QA)).length === 3, 'another member’s direct delete reaches none of A’s entries');
ok(/not_a_member/.test((await create(C, 'ZZ Nope')).message) && (await as(C, `select count(*)::int n from public.watch_queues`))[0].n === 0, 'a signed-in non-member can create nothing and reads nothing');
const anon = sql => db.transaction(async tx => { await tx.query(`select set_config('role', 'anon', true)`); return (await tx.query(sql)).rows; }).then(() => 'ran', e => e.message);
ok(/permission denied/.test(await anon(`select * from public.watch_queues`)) && /permission denied/.test(await anon(`select * from public.queue_entries`))
  && /permission denied/.test(await anon(`select public.library_queue_create('x')`)), 'signed out: nothing at all');

section('completion');
// Show 3 (ongoing): seasons 1 watched, 2 marked, 3, 4 (TBA). Show 4 is ended. Show 8 ended.
const setWatched = (who, row, on) => call(who, `public.set_season_watched($1, $2)`, [row, on]);
const filmState = r => call(A, `public.library_set_film_state_b45($1, (select jsonb_build_object('status', status, 'watched', watched, 'priority', priority, 'catalog_new', catalog_new, 'status_review', status_review) from public.watchlist_items where id = $1), $2::jsonb)`, [film(r.n), JSON.stringify(r.changes)]);
const showState = (s, changes) => call(A, `public.library_set_show_state_b45($1, (select jsonb_build_object('status', status, 'priority', priority, 'ended', ended, 'catalog_new', catalog_new, 'status_review', status_review) from public.tv_shows where id = $1), $2::jsonb)`, [show(s), JSON.stringify(changes)]);
const inQueues = async (who, target) => (await as(who, `select count(*)::int n from public.queue_entries where show_id = $1 or item_id = $1`, [target]))[0].n;
ok((await add(A, QC, null, film(2))).ok && (await add(A, QB, null, film(2))).ok && await inQueues(A, film(2)) === 2, 'a film in two queues');
const fw = await filmState({ n: 2, changes: { watched: true } });
ok(fw.ok && await inQueues(A, film(2)) === 0, 'marked watched: it leaves every queue', fw.message);
ok((await filmState({ n: 2, changes: { watched: false } })).ok && await inQueues(A, film(2)) === 0, 'unmarking doesn’t bring it back');
ok((await add(A, QC, null, season(3, 3))).ok && (await add(A, QB, null, season(3, 3))).ok, 'a season in two queues');
const sk = await call(A, `public.set_season_skipped($1, true)`, [season(3, 3)]);
ok(sk.ok && await inQueues(A, season(3, 3)) === 2, 'skipping leaves it queued', sk.message);
await call(A, `public.set_season_skipped($1, false)`, [season(3, 3)]);
ok((await call(A, `public.library_set_episode_marks($1, '{"watched": false, "skipped": false}'::jsonb, true, '[{"tmdb_episode_id": 9900001, "episode_number": 1}]'::jsonb)`, [season(3, 3)])).ok
  && await inQueues(A, season(3, 3)) === 2, 'episode marks never complete a season');
ok((await setWatched(A, season(3, 3), true)).ok && await inQueues(A, season(3, 3)) === 0, 'a season marked watched leaves every queue');
// An ongoing show caught up stays.
ok((await add(A, QC, show(3), null)).ok, 'an ongoing show queued whole');
await setWatched(A, season(3, 2), true); await setWatched(A, season(3, 4), true);
ok(await inQueues(A, show(3)) === 1, 'caught up but not ended: it stays');
// Show 6 ended with seasons 1 (watched), 2, 3, 4: completing the last regular season takes the season and the show out everywhere.
await asAdmin(`update public.tv_shows set ended = false where id = '${show(6)}'`);
ok((await showState(6, { ended: true })).ok, '(show 6 marked ended)');
ok((await add(A, QA, null, season(6, 4))).ok && (await add(A, QB, show(6), null)).ok && (await add(A, QC, show(6), null)).ok, 'an ended show whole in two queues, its last season in a third');
await setWatched(A, season(6, 2), true);
ok(await inQueues(A, show(6)) === 2, 'not complete while a regular season is unwatched');
// A special doesn't gate completion, and a skipped regular season blocks it.
await asAdmin(`insert into public.watchlist_items (item_key, title, season, theme, display_date, date_sort, watched, status, media_type, tmdb_id, season_number, show_id, skipped)
  values ('zz show 1 6|specials', 'ZZ Show 1.6', 'Specials', 'ZZ Theme', 'TBA', '9999-12-31', false, 'confirmed', 'tv', 8100006, 0, '${show(6)}', false)`);
await call(A, `public.set_season_skipped($1, true)`, [season(6, 3)]);
await setWatched(A, season(6, 4), true);
ok(await inQueues(A, season(6, 4)) === 0 && await inQueues(A, show(6)) === 2, 'the last season watched with another skipped: the season goes, the show stays');
await call(A, `public.set_season_skipped($1, false)`, [season(6, 3)]);
ok(await inQueues(A, show(6)) === 2, 'un-skipping isn’t a completion');
const last = await setWatched(A, season(6, 3), true);
ok(last.ok && await inQueues(A, show(6)) === 0, 'the final regular season watched (a special still unwatched): the show leaves every queue', last.message);
// Show ended turned on after every regular season is watched (show 5: mark its seasons, then ended).
ok((await add(A, QB, show(5), null)).ok, 'an ongoing show queued whole');
for (const n of [2, 3, 4]) await setWatched(A, season(5, n), true);
ok(await inQueues(A, show(5)) === 1, '(every season watched; not ended: it stays)');
ok((await showState(5, { ended: true })).ok && await inQueues(A, show(5)) === 0, 'Show ended turned on: it leaves');
// A deliberately queued complete show stays through everything but a new completion.
ok((await add(A, QA, show(5), null)).ok && (await add(A, QC, null, season(5, 2))).ok, 'a complete show and a watched season queued deliberately');
const keep = async l => ok(await inQueues(A, show(5)) === 1 && await inQueues(A, season(5, 2)) === 1, l);
await asAdmin(`insert into public.watchlist_items (item_key, title, season, theme, display_date, date_sort, watched, status, media_type, tmdb_id, season_number, show_id, skipped)
  values ('zz show 1 5|specials', 'ZZ Show 1.5', 'Specials', 'ZZ Theme', 'TBA', '9999-12-31', false, 'confirmed', 'tv', 8100005, 0, '${show(5)}', false)`);
await setWatched(A, (await val(`select id from public.watchlist_items where show_id = '${show(5)}' and season_number = 0`)), true);
await keep('a special marked watched doesn’t sweep it');
await showState(5, { priority: 'high' });
await asAdmin(`update public.watchlist_items set display_date = 'Jan 9, 2025', date_sort = '2025-01-09' where id = '${season(5, 2)}'`);
await keep('priority and date edits don’t sweep it');
await asAdmin(`insert into public.watchlist_items (item_key, title, season, theme, display_date, date_sort, watched, status, media_type, tmdb_id, season_number, show_id, skipped)
  values ('zz show 1 5|season 5', 'ZZ Show 1.5', 'Season 5', 'ZZ Theme', 'TBA', '9999-12-31', false, 'confirmed', 'tv', 8100005, 5, '${show(5)}', false)`);
await keep('a new season added (as Refresh shows adds one) doesn’t sweep it');
await setWatched(A, (await val(`select id from public.watchlist_items where show_id = '${show(5)}' and season_number = 5`)), true);
ok(await inQueues(A, show(5)) === 0 && await inQueues(A, season(5, 2)) === 1, 'watching that new season completes it again: the show leaves; the other season stays');
await setWatched(A, season(5, 2), false);
ok(await inQueues(A, season(5, 2)) === 1, 'unmarking a queued watched season keeps it');
await setWatched(A, season(5, 2), true);
ok(await inQueues(A, season(5, 2)) === 0, 'and marking it again is a completion');
// A show with no regular season never completes; an unmatched show completes on its stored rows.
await asAdmin(`insert into public.tv_shows (id, title, show_key, tmdb_id, status, ended) values ('${id1(77)}', 'ZZ Specials Only', 'zz specials only', null, 'watching', true);
  insert into public.watchlist_items (id, item_key, title, season, theme, display_date, date_sort, watched, status, show_id, skipped)
  values ('${id1(78)}', 'zz specials only|specials', 'ZZ Specials Only', 'Specials', 'ZZ Theme', 'TBA', '9999-12-31', false, 'confirmed', '${id1(77)}', false)`);
ok((await add(A, QA, id1(77), null)).ok && (await setWatched(A, id1(78), true)).ok && await inQueues(A, id1(77)) === 1, 'only specials: never complete');
await asAdmin(`update public.tv_shows set ended = true where id = '${id1(999)}'`);
ok((await add(A, QB, id1(999), null)).ok && (await setWatched(A, id1(998), true)).ok && await inQueues(A, id1(999)) === 0, 'an unmatched ended show completes on its stored seasons');

section('identity');
// A season moved into a show whole in a queue: the whole-show entry stays, the season entry goes.
const qd = (await create(A, 'ZZ Identity')).r.id;
ok((await add(A, qd, show(7), null)).ok && (await add(A, qd, null, season(8, 3))).ok && (await add(A, QA, null, season(8, 3))).ok, '(show 7 whole and a season of show 8 in one queue; that season alone in another)');
const before7 = await ids(A, qd);
await asAdmin(`update public.watchlist_items set show_id = '${show(7)}' where id = '${season(8, 3)}'`);
ok(same(await ids(A, qd), [show(7)]) && await inQueues(A, season(8, 3)) === 1, 'moved into show 7: the season entry covered by show 7 goes; elsewhere it follows the season', JSON.stringify([before7, await ids(A, qd)]));
// The last season leaving a show carries that show's whole-show entries; a duplicate keeps the destination's.
await asAdmin(`insert into public.tv_shows (id, title, show_key, tmdb_id, status) values ('${id1(80)}', 'ZZ Lonely', 'zz lonely', null, 'confirmed');
  insert into public.watchlist_items (id, item_key, title, season, theme, display_date, date_sort, watched, status, show_id, skipped)
  values ('${id1(81)}', 'zz lonely|season 1', 'ZZ Lonely', 'Season 1', 'ZZ Theme', 'TBA', '9999-12-31', false, 'confirmed', '${id1(80)}', false)`);
const qe = (await create(A, 'ZZ Carry')).r.id;
ok((await add(A, qe, null, film(3))).ok && (await add(A, qe, id1(80), null)).ok && (await add(A, qe, null, season(7, 2))).ok, '(a lonely show between a film and a season of show 7)');
ok((await add(A, qd, id1(80), null)).ok, '(and whole in the queue that has show 7 whole)');
await asAdmin(`update public.watchlist_items set show_id = '${show(7)}' where id = '${id1(81)}'; delete from public.tv_shows where id = '${id1(80)}'`);
ok(same(await ids(A, qe), [film(3), show(7)]), 'carried to show 7 at its place; the show-7 season it now covers goes', JSON.stringify(await ids(A, qe)));
ok(same(await ids(A, qd), [show(7)]), 'where show 7 was already whole: the entry already there stays, the duplicate goes');
ok((await as(A, `select json_agg(position order by position) p from public.queue_entries where queue_id = $1`, [qe]))[0].p.join() === '1,2', '(positions kept)');
// A season becoming a film: its whole-show entry of the emptied show becomes the film's.
await asAdmin(`insert into public.tv_shows (id, title, show_key, tmdb_id, status) values ('${id1(82)}', 'ZZ Was Show', 'zz was show', null, 'confirmed');
  insert into public.watchlist_items (id, item_key, title, season, theme, display_date, date_sort, watched, status, show_id, skipped)
  values ('${id1(83)}', 'zz was show|season 1', 'ZZ Was Show', 'Season 1', 'ZZ Theme', 'TBA', '9999-12-31', false, 'confirmed', '${id1(82)}', false)`);
ok((await add(A, qe, id1(82), null)).ok, '(a show queued whole)');
await asAdmin(`update public.watchlist_items set show_id = null, season = 'Film', media_type = null, theme_kind = 'other', priority = 'normal', catalog_new = false, status_review = false, metadata_owner_set = false,
  genres = '{}', forms = '{}', franchises = '{}', companies = '{}', genre_candidates = '{}' where id = '${id1(83)}'; delete from public.tv_shows where id = '${id1(82)}'`);
ok(same(await ids(A, qe), [film(3), show(7), id1(83)]), 'its season became a film: the entry is now the film’s, at its place');
// The real match function: an unmatched season matched into an existing TMDB show that a queue holds whole.
const tm = await val(`select tmdb_id from public.tv_shows where id = '${show(7)}'`);
const qf = (await create(A, 'ZZ Match')).r.id;
ok((await add(A, qf, show(7), null)).ok && (await add(A, qf, null, id1(998))).ok, '(show 7 whole, and the unmatched season, in one queue)');
await asAdmin(`update public.tv_shows set status = (select status from public.tv_shows where id = '${show(7)}') where id = '${id1(999)}'`);
const watchedBefore = await val(`select watched from public.watchlist_items where id = '${id1(998)}'`);
const mArgs = [id1(998), JSON.stringify({ tmdb_id: tm, season_number: 9, show_id: show(7) }),
  JSON.stringify({ title: 'ZZ Show 1.7', season: 'Season 9', season_number: 9, media_type: 'tv', tmdb_id: tm, item_key: 'zz show 1.7|season 9', date_sort: '2025-09-09', display_date: 'Sep 9, 2025' })];
let m = await call(A, `public.library_match_season_b45($1, $2::jsonb, $3::jsonb)`, mArgs);
if (m.ok && m.r.blocked && m.r.confirmation) m = await call(A, `public.library_match_season_b45($1, $2::jsonb, $3::jsonb, '{}'::jsonb, $4)`, [...mArgs, m.r.confirmation]);
ok(m.ok && !m.r.blocked, 'library_match_season_b45 runs', m.message || JSON.stringify(m.r));
if (m.ok) {
  ok(same(await ids(A, qf), [show(7)]), 'matched into show 7: the covered season entry goes, the whole-show entry stays', JSON.stringify(await ids(A, qf)));
  ok(await inQueues(A, id1(999)) === 0 && (await val(`select count(*)::int from public.tv_shows where id = '${id1(999)}'`)) === 0, '(its emptied show was deleted; its entries were carried or gone)');
  ok((await val(`select watched from public.watchlist_items where id = '${id1(998)}'`)) === watchedBefore, 'viewing progress unchanged by matching');
}

section('delete and cascades');
const n0 = (await entryIds(A, QC)).length;
ok(/target_changed/.test((await call(A, `public.library_queue_delete($1, $2)`, [QC, n0 + 1])).message), 'delete from an out-of-date count is refused');
const libBefore = await val(`select md5(string_agg(to_jsonb(w)::text, '|' order by id)) from public.watchlist_items w`);
ok((await call(A, `public.library_queue_delete($1, $2)`, [QC, n0])).ok && (await val(`select count(*)::int from public.queue_entries where queue_id = '${QC}'`)) === 0, 'a queue is deleted with its entries');
ok(libBefore === await val(`select md5(string_agg(to_jsonb(w)::text, '|' order by id)) from public.watchlist_items w`), 'the library is unchanged');
ok((await add(A, QA, null, film(4))).ok, '(a film queued)');
const del = await call(A, `public.delete_tv_season($1, (select count(*)::int from public.episode_marks where season_id = $1))`, [season(2, 4)]);
ok(del.ok && await inQueues(A, season(2, 4)) === 0, 'deleting a season removes its entries', del.message);
// The page deletes a film directly (a PostgREST DELETE, no library function): its entries go with it.
const filmDel = await as(A, `delete from public.watchlist_items where id = '${film(4)}'`).then(() => 'deleted', e => e.message);
ok(filmDel === 'deleted' && await inQueues(A, film(4)) === 0, 'a queued film deleted directly (as the page does): allowed, its entries gone', filmDel);

section('restore, format 8');
const exportA = async () => {
  const t = {};
  for (const [name, cols] of Object.entries(SPEC8)) t[name] = (await as(A, `select coalesce(json_agg(json_build_object(${cols.map(c => `'${c}', x.${c}`).join(', ')}) order by x.id), '[]') j from public.${name} x`))[0].j;
  return { format: 'watchlist-tracker-backup', formatVersion: 8, exportedAt: '2026-11-05T00:00:00.000Z', rowCounts: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.length])), tables: t };
};
const SPEC8 = {};
for (const r of (await db.query(`select table_name t, json_agg(column_name order by ordinal_position) c from information_schema.columns
  where table_schema = 'public' and table_name in ('watch_with_choices','personal_collections','tv_shows','watchlist_items','custom_collections','collection_memberships','catalog_show_links','catalog_film_links','episode_marks','update_setup','collection_definitions','collection_exclusions','update_holds','record_aliases','membership_removals','show_update_settings','research_briefs','research_imports','update_findings','watch_queues','queue_entries')
  and column_name not in ('user_id', 'is_film', 'item_is_film') group by table_name`)).rows) SPEC8[r.t] = r.c;
const snap = await exportA();
ok(snap.tables.watch_queues.length >= 4 && snap.tables.queue_entries.length >= 6, 'an export holds the queues and entries', JSON.stringify(snap.rowCounts));
const r8 = await restore(A, snap);
ok(r8.ok && r8.r.formatVersion === 8 && same(await exportA().then(d => d.tables), snap.tables), 'a format-8 round trip restores both orders exactly', r8.message);
// A restore whose file holds completed items (watched seasons queued) keeps them: inserts never sweep.
const fileWithDone = clone(snap);
fileWithDone.tables.queue_entries.push({ id: id1(90001), queue_id: qf, show_id: null, item_id: season(1, 1), position: 50, created_at: '2026-11-05T00:00:00+00:00' });
fileWithDone.rowCounts.queue_entries++;
ok((await restore(A, fileWithDone)).ok && await inQueues(A, season(1, 1)) >= 1, 'a restored queue keeps a watched season it holds');
const bad = (f, l, re) => { const d = clone(snap); f(d); d.rowCounts = Object.fromEntries(Object.entries(d.tables).map(([k, v]) => [k, v.length])); return restore(A, d).then(x => ok(!x.ok && re.test(x.message), l, x.message)); };
await bad(d => { const es = d.tables.queue_entries, a = es.find(e => es.some(x => x.queue_id === e.queue_id && x.id !== e.id)); a.position = es.find(x => x.queue_id === a.queue_id && x.id !== a.id).position; }, 'a repeated place in a queue is refused', /repeats a queue_entries row|restore_invalid/);
await bad(d => { d.tables.watch_queues[1].sort_order = d.tables.watch_queues[0].sort_order; }, 'a repeated queue order is refused', /restore_invalid/);
await bad(d => { const e = d.tables.queue_entries.find(x => x.show_id === show(7)); d.tables.queue_entries.push({ ...e, id: id1(90002), show_id: null, item_id: season(7, 2), position: 99 }); }, 'a whole show beside its season is refused', /whole show and one of its seasons/);
await bad(d => { d.tables.queue_entries[0].queue_id = id1(55555); }, 'an entry of a queue not in the file is refused', /points at something/);
const byId = t => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, [...v].sort((a, b) => a.id < b.id ? -1 : 1).map(r => JSON.stringify(r))]));
const nowT = await exportA().then(d => d.tables), wantT = clone(fileWithDone.tables);
wantT.queue_entries = nowT.queue_entries.some(e => e.id === id1(90001)) ? wantT.queue_entries.map(e => e.id === id1(90001) ? nowT.queue_entries.find(x => x.id === e.id) : e) : wantT.queue_entries;
ok(same(byId(nowT), byId(wantT)), 'after the refusals the library is what the last restore made');
const restB = await restore(B, to8(L2));
ok(restB.ok && (await as(B, `select count(*)::int n from public.watch_queues`))[0].n === 0, 'a format-7 library converted to 8 restores with no queues', restB.message);
const steal = clone(snap); steal.tables.watchlist_items = []; steal.tables.tv_shows = [];
ok(!(await restore(B, to8(L2, snap.tables.watch_queues.slice(0, 1)))).ok, 'another member can’t restore A’s queue ids');

console.log(`\nPGlite: ${passed} passed, ${failed} failed`);
await db.close();

// ── Real PostgreSQL 17: simultaneous saves ──
if (!process.env.PG_BIN) console.log('NOTICE: PG_BIN is not set, so the simultaneous-save checks on real PostgreSQL 17 were SKIPPED.');
else {
  const BIN = process.env.PG_BIN, WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'q1pg-')), DATA = path.join(WORK, 'data'), SOCK = path.join(WORK, 's');
  fs.mkdirSync(SOCK);
  const bin = n => path.join(BIN, n);
  const args = ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', SOCK, '-U', 'postgres', '-d', 'postgres'];
  const psql = text => execFileSync(bin('psql'), args, { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();
  process.on('exit', () => { try { execFileSync(bin('pg_ctl'), ['-D', DATA, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch (e) { /* not running */ } fs.rmSync(WORK, { recursive: true, force: true }); });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const session = () => {
    const p = spawn(bin('psql'), ['-X', '-At', '-h', SOCK, '-U', 'postgres', '-d', 'postgres'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', n = 0; p.stdout.on('data', d => { buf += d; }); p.stderr.on('data', d => { buf += d; });
    const s = {
      send(text) { const mark = `zzdone${++n}`; buf = ''; p.stdin.write(`${text}\n\\echo ${mark}\n`); return mark; },
      async done(mark, ms = 60000) { const t0 = Date.now(); while (!buf.includes(mark)) { if (Date.now() - t0 > ms) throw new Error(`no answer: ${buf.slice(0, 300)}`); await wait(10); } return buf.split(mark)[0]; },
      run(text) { return s.done(s.send(text)); },
      end() { p.stdin.end(); }
    };
    return s;
  };
  const setAs = who => `select set_config('request.jwt.claims', '{"sub": "${who}", "role": "authenticated"}', false), set_config('role', 'authenticated', false);`;
  const waiting = async () => { for (let i = 0; i < 500; i++) { if (Number(psql(`select count(*) from pg_stat_activity where wait_event_type in ('Lock', 'Advisory') and state = 'active'`)) > 0) return true; await wait(10); } return false; };
  const before = (s, sql) => s.run(`begin; ${sql};`);
  let p2 = 0, f2 = 0;
  const ok2 = (c, l, d = '') => { c ? p2++ : f2++; if (!c) console.log(`  FAIL ${l}${d ? `\n       ${String(d).slice(0, 600)}` : ''}`); };

  section('real PostgreSQL 17: simultaneous saves');
  execFileSync(bin('initdb'), ['-D', DATA, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
  execFileSync(bin('pg_ctl'), ['-D', DATA, '-o', `-c listen_addresses='' -c unix_socket_directories='${SOCK}' -c timezone=UTC -c deadlock_timeout=200ms`, '-l', path.join(WORK, 'log'), '-w', 'start'], { stdio: 'ignore' });
  await replay(async t => { psql(t); });
  psql(SIMPLIFY);
  const fA = path.join(WORK, 'a.json'); fs.writeFileSync(fA, JSON.stringify(L1));
  psql(`${setAs(A)}\n\\set doc \`cat ${fA}\`\nselect public.restore_backup(:'doc'::jsonb, false) is not null;`);
  psql(q1('local-q1'));
  const s1 = session(), s2 = session();
  await s1.run(setAs(A)); await s2.run(setAs(A));
  const q = sql => psql(`${setAs(A)}\n${sql}`).split('\n').slice(1).join('\n').trim();

  // Two devices create their first queues at once: the second waits, then both are saved in order.
  await before(s1, `select (public.library_queue_create('ZZ One')) ->> 'sort_order'`);
  const m2 = s2.send(`select (public.library_queue_create('ZZ Two')) ->> 'sort_order';`);
  ok2(await waiting(), 'the second first-queue waits for the first');
  await s1.run('commit;');
  const out2 = await s2.done(m2);
  ok2(/^2$/m.test(out2) && q(`select string_agg(name || ':' || sort_order, ',' order by sort_order) from public.watch_queues`) === 'ZZ One:1,ZZ Two:2', 'both saved, in order, on an account that had none', out2);
  // The same name at once: one is refused.
  await before(s1, `select public.library_queue_create('ZZ Same') is not null`);
  const m3 = s2.send(`select public.library_queue_create('ZZ Same') is not null;`);
  await waiting(); await s1.run('commit;');
  ok2(/queue_name_taken/.test(await s2.done(m3)), 'the same new name from two devices: the second is refused');
  const [Q1, Q2] = q(`select string_agg(id::text, ',' order by sort_order) from public.watch_queues`).split(',');
  // Two reorders from the same shown order: the second is refused.
  const order0 = q(`select '{' || string_agg(id::text, ',' order by sort_order) || '}' from public.watch_queues`);
  await before(s1, `select public.library_queue_reorder('${order0}', '${Q2}', 1) is not null`);
  const m4 = s2.send(`select public.library_queue_reorder('${order0}', '${Q1}', 3) is not null;`);
  await waiting(); await s1.run('commit;');
  ok2(/target_changed/.test(await s2.done(m4)), 'two queue reorders from the same order: the second is refused');
  // The same film added at once: one is refused.
  await before(s1, `select public.library_queue_add('${Q1}', null, '${film(1)}') is not null`);
  const m5 = s2.send(`select public.library_queue_add('${Q1}', null, '${film(1)}') is not null;`);
  await waiting(); await s1.run('commit;');
  ok2(/queue_duplicate/.test(await s2.done(m5)), 'the same film added from two devices: the second is refused');
  // A whole show and one of its seasons at once: one is refused.
  await before(s1, `select public.library_queue_add('${Q1}', '${show(3)}', null) is not null`);
  const m6 = s2.send(`select public.library_queue_add('${Q1}', null, '${season(3, 3)}') is not null;`);
  await waiting(); await s1.run('commit;');
  ok2(/queue_overlap/.test(await s2.done(m6)), 'a whole show and its season added at once: the second is refused');
  // Two moves from the same order: the second is refused.
  psql(`${setAs(A)} select public.library_queue_add('${Q1}', null, '${film(2)}'); select public.library_queue_add('${Q1}', null, '${season(2, 3)}');`);
  const e0 = q(`select '{' || string_agg(id::text, ',' order by position) || '}' from public.queue_entries where queue_id = '${Q1}'`);
  const eIds = e0.slice(1, -1).split(',');
  await before(s1, `select public.library_queue_move('${Q1}', '${e0}', '${eIds[3]}', 1) is not null`);
  const m7 = s2.send(`select public.library_queue_move('${Q1}', '${e0}', '${eIds[0]}', 4) is not null;`);
  await waiting(); await s1.run('commit;');
  ok2(/target_changed/.test(await s2.done(m7)), 'two moves from the same order: the second is refused');
  ok2(q(`select string_agg(position::text, ',' order by position) from public.queue_entries where queue_id = '${Q1}'`) === '1,2,3,4', 'positions stay 1..n');
  // A season marked watched while another device adds it: either order ends without a stale entry.
  await before(s1, `select public.set_season_watched('${season(2, 3)}', true) is not null`);
  const m8 = s2.send(`select public.library_queue_add('${Q2}', null, '${season(2, 3)}') is not null;`);
  await waiting(); await s1.run('commit;');
  const a8 = await s2.done(m8);
  ok2(/^t$/m.test(a8) && q(`select count(*) from public.queue_entries where item_id = '${season(2, 3)}'`) === '1', 'marked watched while being added elsewhere: the add waits, then keeps it as deliberately added (it was already watched)', a8);
  // Marking watched while a move holds the queue: the removal waits, the queue stays consistent.
  const e1 = q(`select '{' || string_agg(id::text, ',' order by position) || '}' from public.queue_entries where queue_id = '${Q1}'`);
  const e1Ids = e1.slice(1, -1).split(',');
  await before(s1, `select public.library_queue_move('${Q1}', '${e1}', '${e1Ids[0]}', 3) is not null`);
  const m9 = s2.send(`select public.library_set_film_state_b45('${film(2)}', (select jsonb_build_object('status', status, 'watched', watched, 'priority', priority, 'catalog_new', catalog_new, 'status_review', status_review) from public.watchlist_items where id = '${film(2)}'), '{"watched": true}'::jsonb) is not null;`);
  await waiting(); await s1.run('commit;');
  const a9 = await s2.done(m9);
  ok2(/^t$/m.test(a9) && q(`select count(*) from public.queue_entries where item_id = '${film(2)}'`) === '0', 'a film marked watched during a move: removed once the move commits', a9);
  ok2(q(`select count(*) = count(distinct position) from public.queue_entries where queue_id = '${Q1}'`) === 't', 'places stay distinct');
  // A restore and a queue change from two devices at once: one waits for the other, no deadlock, nothing half done.
  const fA8 = path.join(WORK, 'a8.json');
  const doc8 = to8(L1, [{ id: id1(70001), name: 'ZZ Restored', sort_order: 1, created_at: '2026-11-05T00:00:00+00:00' }],
    [{ id: id1(70002), queue_id: id1(70001), show_id: null, item_id: film(1), position: 1, created_at: '2026-11-05T00:00:00+00:00' }]);
  fs.writeFileSync(fA8, JSON.stringify(doc8));
  const eNow = q(`select '{' || string_agg(id::text, ',' order by position) || '}' from public.queue_entries where queue_id = '${Q1}'`);
  const eNowIds = eNow.slice(1, -1).split(',');
  await before(s1, `select public.library_queue_move('${Q1}', '${eNow}', '${eNowIds[0]}', 2) is not null`);
  const m10 = s2.send(`\\set doc \`cat ${fA8}\`\nselect public.restore_backup(:'doc'::jsonb, false) is not null;`);
  ok2(await waiting(), 'a restore waits for a queue move in progress');
  await s1.run('commit;');
  const a10 = await s2.done(m10);
  ok2(/^t$/m.test(a10) && !/deadlock/.test(a10) && q(`select string_agg(name, ',') from public.watch_queues`) === 'ZZ Restored', 'then restores the file’s queues; no deadlock', a10);
  await before(s1, `select public.restore_backup((select '${JSON.stringify(doc8).replace(/'/g, "''")}'::jsonb), false) is not null`);
  const m11 = s2.send(`select public.library_queue_remove('${id1(70002)}') ->> 'removed';`);
  ok2(await waiting(), 'a queue change waits for a restore in progress');
  await s1.run('commit;');
  const a11 = await s2.done(m11);
  ok2(/^true$/m.test(a11) && !/deadlock/.test(a11), 'then runs on the restored queue; no deadlock', a11);
  s1.end(); s2.end();
  passed += p2; failed += f2;
  console.log(`Real PostgreSQL: ${p2} passed, ${f2} failed`);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
