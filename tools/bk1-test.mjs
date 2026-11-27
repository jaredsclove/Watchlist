// BK1's database tests: books on a database replayed to its final state (through TC1, then db/bk1_books.sql).
//   PGLITE_DIR=<dir with @electric-sql/pglite> [PG_BIN=<postgres 17 bin>] node tools/bk1-test.mjs
// PGlite covers behaviour: the migration (refusals, every existing row unchanged), books, statuses, edits and chosen dates, an
// explicit later match, removal and its exclusions, follows and automatic adding's setting, official sites, manual author credits,
// decisions, review items, the cache, accounts, and restore at format 10 (the cache untouched; removed titles stay excluded). Real
// PostgreSQL 17 (a throwaway server, removed at the end) adds simultaneous saves and a restore beside a books change. Without
// PG_BIN that part is skipped, with a notice. Synthetic data only ("ZZ …", made-up Hardcover ids). Output: pass/fail and counts.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { replay, toCurrent, library9, library10, file, clone, A, B, C } from './restore-fixture.mjs';

if (!process.env.PGLITE_DIR) { console.error('usage: PGLITE_DIR=<dir> [PG_BIN=<postgres 17 bin>] node tools/bk1-test.mjs'); process.exit(2); }
const req = createRequire(path.join(process.env.PGLITE_DIR, 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));

let passed = 0, failed = 0;
const ok = (c, l, d = '') => { c ? passed++ : failed++; if (!c) console.log(`  FAIL ${l}${d ? `\n       ${String(d).slice(0, 600)}` : ''}`); };
const section = t => console.log(`[${t}]`);
const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const MIG = file('db/bk1_books.sql'), bk1 = run => `select set_config('watchlist.bk1_run', '${run}', false);\n` + MIG;

const db = new PGlite();
await replay(t => db.exec(t));
await toCurrent(t => db.exec(t), { books: false });
const as = (who, sql, params = []) => db.transaction(async tx => {
  await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [who ? JSON.stringify({ sub: who, role: 'authenticated' }) : '']);
  return (await tx.query(sql, params)).rows;
});
const call = (who, sql, params = []) => as(who, `select ${sql} r`, params).then(r => ({ ok: true, r: r[0].r }), e => ({ ok: false, message: e.message, code: e.code }));
const val = async s => Object.values((await db.query(s)).rows[0])[0];
const restore = (who, doc) => call(who, `public.restore_backup($1::jsonb, false)`, [JSON.stringify(doc)]);
const arr = a => `{${a.map(x => `"${x}"`).join(',')}}`;
const J = x => (x === null || x === undefined ? null : JSON.stringify(x));

section('the migration');
const L1 = library9(1), L2 = library9(2);
ok((await restore(A, L1)).ok && (await restore(B, L2)).ok, 'two format-9 libraries (TV, films, games, queues) restore before the migration');
const tables = ['public.tv_shows', 'public.watchlist_items', 'public.collection_memberships', 'public.personal_collections', 'public.episode_marks',
  'public.update_findings', 'public.watch_queues', 'public.queue_entries', 'public.game_entries', 'public.game_decisions', 'public.tmdb_tv_cache', 'private.library_members'];
const fpAll = () => val(`select md5(string_agg(x, '|' order by x)) from (${tables.map(t => `select to_jsonb(r)::text x from ${t} r`).join(' union all ')}) q`);
const before = await fpAll();
const attempt = text => db.exec(text).then(() => null, async e => { await db.exec('rollback'); return e.message; });
ok(/set watchlist.bk1_run/.test(await attempt(`select set_config('watchlist.bk1_run', '', false);\n` + MIG)) && (await val(`select to_regclass('public.book_entries') is null`)),
  'without a run id: refused, nothing created');
const late = bk1('local-late').replace("select 'BK1|'", () => `do $$ begin raise exception 'zz failure before commit'; end $$;\nselect 'BK1|'`);
ok(/zz failure before commit/.test(await attempt(late)) && (await val(`select to_regclass('public.book_entries') is null`))
  && (await val(`select public.stage5_capabilities() ->> 'phase'`)) === 'contracted-g1' && (await val(`select public.stage5_capabilities() ->> 'backup_format'`)) === '9',
  'a failure just before commit leaves the database as it was');
ok(!(await attempt(bk1('local-bk1'))), 'the migration commits on a database holding libraries, games and queues');
ok(before === await fpAll(), 'no library row, game, queue, cache row or member changed');
ok(/already installed/.test(await attempt(bk1('local-bk1-again'))), 'a rerun is refused');
const cap = (await call(A, `public.stage5_capabilities()`)).r;
ok(cap.phase === 'contracted-bk1' && cap.backup_format === 10 && cap.bk1 === 1 && cap.g1 === 1 && cap.tc1 === 1 && cap.member === true, 'the capability says contracted-bk1, format 10', JSON.stringify(cap));
ok(/converted in the page/.test((await restore(A, L1)).message || ''), 'a format-9 file sent directly is refused: the page converts it');

section('BK1b: a follow\'s starting catalog');
{
  const MIGB = file('db/bk1b_baselines.sql'), bk1b = run => `select set_config('watchlist.bk1b_run', '${run}', false);\n` + MIGB;
  ok(/set watchlist.bk1b_run/.test(await attempt(`select set_config('watchlist.bk1b_run', '', false);\n` + MIGB)), 'without a run id: refused');
  const beforeB = await fpAll();
  ok(!(await attempt(bk1b('local-bk1b'))), 'the migration commits');
  ok(beforeB === await fpAll(), 'no other row changed');
  ok(/already installed/.test(await attempt(bk1b('local-bk1b-again'))), 'a rerun is refused');
  const capB = (await call(A, `public.stage5_capabilities()`)).r;
  ok(capB.phase === 'contracted-bk1' && capB.backup_format === 10, 'phase and backup format unchanged');
}
const decB = (who, key, exp, value) => call(who, `public.library_book_decision_set('baseline', $1, $2::jsonb, $3::jsonb, null, null)`, [key, J(exp), J(value)]);
{
  const ids = Array.from({ length: 3000 }, (_, i) => 800000 + i);
  ok((await decB(A, 'f:zz-follow-1', null, { ids })).ok, 'a baseline of 3,000 Hardcover ids is kept (beyond the 4,000 bytes of other decisions)');
  ok(/invalid_input/.test((await decB(A, 'f:zz-follow-2', null, { ids: [1, -2] })).message) && /invalid_input/.test((await decB(A, 'f:zz-follow-2', null, { ids: [1], extra: 1 })).message)
    && /invalid_input/.test((await decB(A, 'f:zz-follow-2', null, { ids: Array.from({ length: 5001 }, (_, i) => i + 1) })).message), 'a malformed or oversized baseline is refused');
  ok(/invalid_input/.test((await call(A, `public.library_book_decision_set('skip', 'hc:1', null, $1::jsonb, null, null)`, [J({ pad: 'x'.repeat(5000) })])).message), 'other kinds keep their 4,000-byte limit');
  ok(/target_changed/.test((await decB(A, 'f:zz-follow-1', null, { ids: [1] })).message), 'a stale baseline write is refused');
  ok((await as(B, `select count(*)::int n from public.book_decisions where kind = 'baseline'`))[0].n === 0, 'another member sees none');
  await decB(A, 'f:zz-follow-1', { ids }, null);
}

section('books: add, status, edit');
const add = (who, book, status = 'want', clear = [], finding = null, refuse = null) => call(who, `public.library_book_add($1::jsonb, $2, $3::text[], $4, $5::text[])`, [J(book), status, arr(clear), finding, refuse ? arr(refuse) : null]);
const setS = (who, e, exp, s) => call(who, `public.library_book_set($1, $2, $3)`, [e, exp, s]);
const edit = (who, e, exp, fields, finding = null) => call(who, `public.library_book_edit($1, $2::jsonb, $3::jsonb, $4)`, [e, J(exp), J(fields), finding]);
const auth = [{ id: 700500, name: 'ZZ Novelist' }];
const b1 = await add(A, { hardcover_id: 700001, title: 'ZZ The First Case', authors: auth, series: [{ id: 700900, name: 'ZZ Detective', position: '1' }] });
const b2 = await add(A, { title: 'ZZ A Novella', authors: [{ name: 'ZZ Novelist' }], series: [{ name: 'ZZ Detective', position: '1.5' }], chosen_date: { value: '2027', source: 'member' } }, 'want');
ok(b1.ok && b2.ok && b1.r.status === 'want' && b1.r.hardcover_id === 700001 && b2.r.hardcover_id === null && b2.r.chosen_date.value === '2027', 'a Hardcover book and a book entered by hand are saved', [b1.message, b2.message].join(' / '));
const E1 = b1.r.id, E2 = b2.r.id;
ok(/book_duplicate/.test((await add(A, { hardcover_id: 700001, title: 'ZZ The First Case (UK)', authors: auth })).message), 'the same Hardcover book again is refused');
ok((await add(A, { title: 'ZZ A Novella', authors: [{ name: 'ZZ Novelist' }] })).ok, 'a second hand-entered book with the same title is allowed (similar titles are only hints)');
ok((await add(B, { hardcover_id: 700001, title: 'ZZ The First Case', authors: auth })).ok, 'another member may save the same Hardcover book');
const bad = [
  [{ title: ' padded ' }, 'want'], [{ title: 'ZZ' }, 'read'], [{ title: 'ZZ', hardcover_id: -3 }, 'want'], [{ title: 'ZZ', extra: 1 }, 'want'],
  [{ title: 'ZZ', authors: [{ name: '' }] }, 'want'], [{ title: 'ZZ', series: [{ name: 'S', position: 'two' }] }, 'want'],
  [{ title: 'ZZ', chosen_date: { value: '2027-13-40x', source: 'member' } }, 'want'], [{ title: 'ZZ', chosen_date: { value: '2027', source: 'website', url: 'http://zz.example.com' } }, 'want']];
let allBad = true;
for (const [bk, st] of bad) allBad = allBad && /invalid_input/.test((await add(A, bk, st)).message);
ok(allBad, 'bad titles, unknown statuses, bad ids, unknown fields, empty names, bad positions and dates and a non-https source are refused');
ok((await setS(A, E1, 'want', 'reading')).ok && (await setS(A, E1, 'reading', 'dropped')).ok, 'status changes with the one the page showed (Reading, then Dropped)');
ok(/target_changed/.test((await setS(A, E1, 'want', 'finished')).message), 'a status change from an out-of-date page is refused');
ok(/target_missing/.test((await setS(B, E1, 'dropped', 'finished')).message), 'another member’s book is out of reach');
ok((await edit(A, E2, { chosen_date: { value: '2027', source: 'member' } }, { chosen_date: { value: '2027-05-11', source: 'website', url: 'https://zz.example.com/b', chosen_at: '2026-11-26' } })).ok,
  'a chosen date changes with what the page showed');
ok(/target_changed/.test((await edit(A, E2, { chosen_date: { value: '2027', source: 'member' } }, { chosen_date: null })).message), 'an edit from an out-of-date page is refused');
ok((await edit(A, E2, { chosen_date: { value: '2027-05-11', source: 'website', url: 'https://zz.example.com/b', chosen_at: '2026-11-26' }, title: 'ZZ A Novella' },
  { chosen_date: null, title: 'ZZ A Novella (Renamed)' })).ok && (await as(A, `select chosen_date, title from public.book_entries where id = $1`, [E2]))[0].chosen_date === null,
  'title and date edit together; clearing the chosen date leaves none');
ok(/invalid_input/.test((await edit(A, E2, { status: 'want' }, { status: 'finished' })).message) && /invalid_input/.test((await edit(A, E2, { title: 'x' }, { title: 'x', series: [] })).message),
  'edit refuses fields it doesn’t own and expected values that don’t match the fields');

section('an explicit later match keeps progress and decisions');
const link = (who, e, exp, hc, fields = null, finding = null) => call(who, `public.library_book_link($1, $2, $3, $4::jsonb, $5)`, [e, exp, hc, J(fields), finding]);
const dec = (who, kind, key, exp, value, finding = null, outcome = null) => call(who, `public.library_book_decision_set($1, $2, $3::jsonb, $4::jsonb, $5, $6)`, [kind, key, J(exp), J(value), finding, outcome]);
await setS(A, E2, 'want', 'reading');
ok((await dec(A, 'skip', `e:${E2}`, null, {})).ok, 'a hand-entered book is skipped in its series');
ok((await edit(A, E2, { chosen_date: null }, { chosen_date: { value: '2027-02', source: 'member' } })).ok, 'and given a chosen date');
const rec = await call(A, `public.library_book_findings_record($1::jsonb, '{}'::text[])`, [J([{ fingerprint: `mt:e:${E2}:hc:700002`, source: 'hardcover', kind: 'match', subject: { entry_id: E2, hardcover_id: 700002 } }])]);
ok(rec.ok && rec.r.added === 1, 'a match suggestion is recorded', rec.message);
const ln = await link(A, E2, null, 700002, { title: 'ZZ A Novella', series: [{ id: 700900, name: 'ZZ Detective', position: '1.5' }] }, `mt:e:${E2}:hc:700002`);
const after = (await as(A, `select * from public.book_entries where id = $1`, [E2]))[0];
ok(ln.ok && after.hardcover_id === 700002 && after.status === 'reading' && after.chosen_date.value === '2027-02' && after.series[0].id === 700900,
  'linking it to a Hardcover record keeps its status and chosen date and takes the placement', ln.message);
ok((await as(A, `select count(*)::int n from public.book_decisions where kind = 'skip' and key = $1`, [`e:${E2}`]))[0].n === 1
  && (await as(A, `select count(*)::int n from public.book_findings where fingerprint = $1`, [`mt:e:${E2}:hc:700002`]))[0].n === 0, 'its skip stays; the suggestion it settled is gone');
ok(/target_changed/.test((await link(A, E2, null, 700003)).message), 'a link from a page that saw it unlinked is refused once it is linked');
ok(/book_duplicate/.test((await link(A, E2, 700002, 700001)).message), 'a link to a record another saved book has is refused');

section('removal and exclusions');
const del = (who, e, exp, keys) => call(who, `public.library_book_delete($1, $2, $3::text[])`, [e, exp, arr(keys)]);
const recF = (who, rows, close = []) => call(who, `public.library_book_findings_record($1::jsonb, $2::text[])`, [J(rows), arr(close)]);
const hd = await del(A, E1, 'dropped', ['hc:700001', 't:700500:zz-the-first-case']);
ok(hd.ok && hd.r.excluded === 2 && (await as(A, `select count(*)::int n from public.book_entries where id = $1`, [E1]))[0].n === 0, 'a removed book leaves the library with two exclusions', hd.message);
ok(/invalid_input/.test((await del(A, E2, 'reading', [])).message), 'a removal without exclusion keys is refused');
const nb = { fingerprint: 'nb:hc:700001', source: 'hardcover', kind: 'new_book', subject: { title: 'ZZ The First Case', hardcover_id: 700001 }, exclude_keys: ['hc:700001'] };
const nbSite = { fingerprint: 'nb:site:700500:zz-the-first-case', source: 'website', kind: 'new_book', subject: { title: 'ZZ The First Case' }, exclude_keys: ['t:700500:zz-the-first-case'] };
const r1 = await recF(A, [nb, nbSite, { fingerprint: 'nb:hc:700010', source: 'hardcover', kind: 'new_book', subject: { title: 'ZZ The Second Case' }, exclude_keys: ['hc:700010'] }]);
ok(r1.ok && r1.r.suppressed === 2 && r1.r.added === 1, 'a later refresh finding the removed title (by Hardcover or by its site) records nothing for it; a new title opens', JSON.stringify(r1.r || r1.message));
ok((await add(A, { hardcover_id: 700001, title: 'ZZ The First Case', authors: auth }, 'want', ['hc:700001', 't:700500:zz-the-first-case'])).r.exclusions_lifted === 2,
  'adding it again explicitly lifts its exclusions');
ok((await recF(A, [{ ...nb, fingerprint: 'nb:hc:700001b' }])).r.added === 1, 'so a later finding for it is no longer suppressed');
await dec(A, 'exclude', 'hc:700011', null, { reason: 'dismissed', title: 'ZZ Excluded' });
ok(/book_excluded/.test((await add(A, { hardcover_id: 700011, title: 'ZZ Excluded', authors: auth }, 'want', [], null, ['hc:700011', 't:700500:zz-excluded'])).message)
  && (await as(A, `select count(*)::int n from public.book_entries where hardcover_id = 700011`))[0].n === 0, 'an automatic add of an excluded title is refused (a page loaded before the dismissal)');
ok((await add(A, { hardcover_id: 700012, title: 'ZZ Not Excluded', authors: auth }, 'want', [], null, ['hc:700012'])).ok, 'an automatic add of a title not excluded goes through');
ok(/invalid_input/.test((await add(A, { title: 'ZZ Both' }, 'want', ['hc:1'], null, ['hc:2'])).message), 'an add that both lifts and checks exclusions is refused');

section('review items');
const res = (who, fp, exp, out) => call(who, `public.library_book_finding_resolve($1, $2, $3)`, [fp, exp, out]);
ok((await res(A, 'nb:hc:700010', 'pending', 'later')).r.status === 'later', 'an item can wait under Later');
const r2 = await recF(A, [{ fingerprint: 'nb:hc:700010', source: 'hardcover', kind: 'new_book', subject: { title: 'ZZ The Second Case', date: '2027-01-01' }, exclude_keys: ['hc:700010'] }]);
const st2 = (await as(A, `select status, subject from public.book_findings where fingerprint = 'nb:hc:700010'`))[0];
ok(r2.r.updated === 1 && st2.status === 'later' && st2.subject.date === '2027-01-01', 'an unchanged refresh updates it without reopening it', JSON.stringify(st2));
ok(/target_changed/.test((await res(A, 'nb:hc:700010', 'pending', 'done')).message), 'resolving from an out-of-date page is refused');
ok((await res(A, 'nb:hc:700010', 'later', 'pending')).r.status === 'pending', 'it comes back from Later');
ok((await dec(A, 'exclude', 'hc:700010', null, { reason: 'dismissed', title: 'ZZ The Second Case' }, 'nb:hc:700010', 'done')).ok
  && (await as(A, `select count(*)::int n from public.book_findings where fingerprint = 'nb:hc:700010'`))[0].n === 0, 'dismissing it stores an exclusion and closes the item in one change');
ok((await recF(A, [{ fingerprint: 'nb:hc:700010', source: 'hardcover', kind: 'new_book', subject: { title: 'ZZ The Second Case' }, exclude_keys: ['hc:700010'] }])).r.suppressed === 1,
  'a dismissed title stays out');
const dt = { fingerprint: 'dt:hc:700001:2013-04-04', source: 'website', kind: 'date', subject: { hardcover_id: 700001, suggested: '2013-04-04' }, exclude_keys: [] };
await recF(A, [dt]);
ok((await dec(A, 'keep_date', dt.fingerprint, null, { date: '2013-04-04' }, dt.fingerprint, 'done')).ok && (await recF(A, [dt])).r.suppressed === 1,
  'a declined date suggestion isn’t offered again while the site’s date is unchanged');
ok((await recF(A, [{ ...dt, fingerprint: 'dt:hc:700001:2013-04-18' }])).r.added === 1, 'a different date from the site is a new suggestion');
ok((await recF(A, [], ['dt:hc:700001:2013-04-18'])).r.closed === 1, 'a refresh can close an item it finds settled');
ok(/invalid_input/.test((await recF(A, [{ ...dt, kind: 'gossip' }])).message) && /invalid_input/.test((await recF(A, [dt, dt])).message)
  && /invalid_input/.test((await recF(A, [{ ...dt, subject: 'x' }])).message), 'unknown kinds, repeated fingerprints and bad subjects are refused');

section('follows, sites, credits, decisions, cache');
const fol = (who, kind, id, name, auto) => call(who, `public.library_book_follow($1, $2, $3, $4)`, [kind, id, name, auto]);
const fa = await fol(A, 'author', 700500, 'ZZ Novelist', false), fs1 = await fol(A, 'series', 700900, 'ZZ Detective', false);
ok(fa.ok && fs1.ok && fs1.r.auto_add === false, 'an author and a series are followed, automatic adding off', [fa.message, fs1.message].join(' / '));
ok(/book_follow_exists/.test((await fol(A, 'series', 700900, 'ZZ Detective', false)).message) && /invalid_input/.test((await fol(A, 'author', 700501, 'ZZ Other', true)).message),
  'following twice is refused, and an author can’t add automatically');
const fset = (who, f, exp, v) => call(who, `public.library_book_follow_set($1, $2, $3)`, [f, exp, v]);
ok((await fset(A, fs1.r.id, false, true)).r.auto_add === true && /target_changed/.test((await fset(A, fs1.r.id, false, true)).message), 'automatic adding turns on with the value shown; a stale toggle is refused');
ok(/invalid_input/.test((await fset(A, fa.r.id, false, true)).message), 'an author follow has no automatic adding');
ok((await call(A, `public.library_book_unfollow($1)`, [fa.r.id])).r.removed === true && (await call(A, `public.library_book_unfollow($1)`, [fa.r.id])).r.removed === false, 'unfollow, then again: reported');
const site = (who, id, name, exp, url) => call(who, `public.library_book_site_set($1, $2, $3, $4)`, [id, name, exp, url]);
ok((await site(A, 700500, 'ZZ Novelist', null, 'https://zz.example.com/books/')).ok && (await site(A, 700500, 'ZZ Novelist', 'https://zz.example.com/books/', 'https://zz.example.com/novels')).ok,
  'an official listing page is set, then changed');
ok(/target_changed/.test((await site(A, 700500, 'ZZ Novelist', null, 'https://zz.example.com/x')).message) && /invalid_input/.test((await site(A, 700500, 'ZZ Novelist', 'https://zz.example.com/novels', 'http://zz.example.com/')).message)
  && /invalid_input/.test((await site(A, 700500, 'ZZ Novelist', 'https://zz.example.com/novels', 'https://zz example.com/')).message), 'a stale change and non-https or malformed addresses are refused');
ok((await site(A, 700500, 'ZZ Novelist', 'https://zz.example.com/novels', null)).r.removed === true, 'and removed');
await recF(A, [{ fingerprint: 'cg:700007:700500', source: 'hardcover', kind: 'credit_gap', subject: { hardcover_id: 700007, author_id: 700500 }, exclude_keys: [] }]);
const asn = await call(A, `public.library_book_association_set($1, $2, $3, $4, $5)`, [700007, 700500, 'ZZ Novelist', true, 'cg:700007:700500']);
ok(asn.ok && (await as(A, `select count(*)::int n from public.book_findings where fingerprint = 'cg:700007:700500'`))[0].n === 0, 'a manual author credit settles its suggestion', asn.message);
ok((await call(A, `public.library_book_association_set($1, $2, $3, $4, null)`, [700007, 700500, 'ZZ Novelist', false])).r.removed === true, 'and can be removed');
ok(/target_changed/.test((await dec(A, 'skip', `e:${E2}`, null, {})).message) && (await dec(A, 'skip', `e:${E2}`, {}, null)).r.removed === true, 'a stale decision is refused; a skip is cleared with what was shown');
ok(/invalid_input/.test((await dec(A, 'skip', 'nospace here', null, {})).message) && /invalid_input/.test((await dec(A, 'gossip', 'hc:1', null, {})).message)
  && /invalid_input/.test((await dec(A, 'skip', 'hc:1', null, {}, 'nb:hc:1', null)).message), 'bad keys, kinds and a finding without an outcome are refused');
const put = await call(A, `public.library_book_cache_put($1::jsonb)`, [J([{ kind: 'book', key: '700001', data: { v: 1, title: 'ZZ' } }, { kind: 'site', key: '700500', data: { v: 1, links: [] } }])]);
ok(put.ok && put.r.cached === 2, 'the cache takes books and site readings');
ok(/invalid_input/.test((await call(A, `public.library_book_cache_put($1::jsonb)`, [J([{ kind: 'film', key: '1', data: {} }])])).message), 'an unknown cache kind is refused');
const big = await call(A, `public.library_book_cache_put($1::jsonb)`, [J([{ kind: 'author', key: '700900', data: { v: 1, pad: 'x'.repeat(61000) } }, { kind: 'author', key: '700901', data: { v: 1 } }])]);
ok(big.ok && big.r.cached === 1 && big.r.skipped === 1 && (await as(A, `select count(*)::int n from public.book_cache where key = '700900'`))[0].n === 0, 'a row too large to keep is skipped and counted; the rest of the batch is saved', JSON.stringify(big.r || big.message));

section('accounts');
ok((await as(B, `select count(*)::int n from public.book_entries`))[0].n === 1 && (await as(B, `select count(*)::int n from public.book_findings`))[0].n === 0,
  'another member sees only their own books and none of A’s review items');
ok(!(await call(C, `public.library_book_add($1::jsonb, 'want', '{}', null, null)`, [J({ title: 'ZZ' })])).ok && (await as(C, `select count(*)::int n from public.book_entries`))[0].n === 0,
  'a signed-in non-member can neither save nor read books');
const anon = await db.transaction(async tx => { await tx.query(`select set_config('role', 'anon', true)`); return tx.query(`select count(*) from public.book_entries`); }).then(() => 'read', e => e.message);
ok(/permission denied/.test(anon), 'signed out (anon): no access', anon);
const direct = await as(A, `insert into public.book_entries (title) values ('ZZ Direct') returning id`).then(() => 'inserted', e => e.message);
ok(direct !== 'inserted', 'a direct insert outside the library functions is refused', direct);

section('restore, format 10');
const L10 = library10(1);
const ra = await restore(A, L10);
const BK = ['book_entries', 'book_follows', 'book_sites', 'book_associations', 'book_decisions', 'book_findings'];
ok(ra.ok && ra.r.formatVersion === 10 && BK.every(t => ra.r.restored[t] === L10.tables[t].length), 'a format-10 library restores; its answer counts every book table', JSON.stringify(ra.r || ra.message));
let fieldOk = true;
for (const t of BK) {
  const rows = await as(A, `select * from public.${t} order by id`);
  const want = L10.tables[t].slice().sort((a, b) => a.id.localeCompare(b.id));
  if (rows.length !== want.length) fieldOk = false;
  rows.forEach((r, i) => Object.keys(want[i]).forEach(k => {
    const a = r[k], b = want[i][k];
    const eq = a instanceof Date ? a.getTime() === new Date(b).getTime() : same(a, b);
    if (!eq) { fieldOk = false; console.log('   differs', t, k, JSON.stringify(a), JSON.stringify(b)); }
  }));
}
ok(fieldOk, 'every book row comes back field by field');
ok((await as(A, `select count(*)::int n from public.book_cache`))[0].n === 3, 'the cache is untouched by a restore');
ok((await recF(A, [{ fingerprint: 'nb:hc:601004', source: 'hardcover', kind: 'new_book', subject: { title: 'ZZ Book 1 Four' }, exclude_keys: ['hc:601004'] },
  { fingerprint: 'nb:site:601500:zz-book-1-four', source: 'website', kind: 'new_book', subject: { title: 'ZZ Book 1 Four' }, exclude_keys: ['t:601500:zz-book-1-four'] }])).r.suppressed === 2,
  'a title removed before the backup stays out after the restore');
await call(A, `public.library_book_cache_purge()`);
ok((await recF(A, [{ fingerprint: 'nb:hc:601004', source: 'hardcover', kind: 'new_book', subject: { title: 'ZZ Book 1 Four' }, exclude_keys: ['hc:601004'] }])).r.suppressed === 1
  && (await as(A, `select status from public.book_findings where fingerprint = 'nb:hc:601006'`))[0].status === 'later', 'and after the cache is emptied; a restored Later item is still Later');
const twice = clone(L10); twice.tables.book_entries.push({ ...twice.tables.book_entries[0], id: '71000000-0000-4000-8000-000000095099', title: 'ZZ Copy' }); twice.rowCounts.book_entries++;
ok(/repeats a book_entries row/.test((await restore(A, twice)).message || ''), 'a file saving one Hardcover book twice is refused');
const badRow = clone(L10); badRow.tables.book_entries[0].status = 'abandoned';
ok(/breaks a rule/.test((await restore(A, badRow)).message || ''), 'a file with an unknown status is refused');
ok(/restore_id_collision/.test((await restore(B, L10)).message || ''), 'another member restoring A’s ids is refused as an id collision');
const fpB = await as(B, `select md5(string_agg(to_jsonb(b)::text, '|' order by id)) h from public.book_entries b`);
ok((await restore(B, library10(2))).ok, 'B restores their own library');
await restore(A, L10);
const fpB2 = await as(B, `select count(*)::int n from public.book_entries`);
ok(fpB2[0].n === library10(2).tables.book_entries.length && fpB[0].h !== null, 'A’s restore leaves B’s books alone');
const ten = clone(L10); ten.formatVersion = 11;
ok(/unsupported backup format/.test((await restore(A, ten)).message || ''), 'a future format is refused');

// ── PostgreSQL 17 ──
if (!process.env.PG_BIN) console.log('\nNOTICE: PG_BIN is not set, so the simultaneous saves on real PostgreSQL 17 were SKIPPED.');
else {
  const BIN = process.env.PG_BIN, WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bk1pg-')), DATA = path.join(WORK, 'data'), SOCK = path.join(WORK, 's');
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
  await toCurrent(async t => { psql(t); });
  const f = path.join(WORK, 'a.json'); fs.writeFileSync(f, JSON.stringify(L10));
  psql(`${setAs(A)}\n\\set doc \`cat ${f}\`\nselect public.restore_backup(:'doc'::jsonb, false) is not null;`);
  const s1 = session(), s2 = session();
  await s1.run(setAs(A)); await s2.run(setAs(A));
  {
    // Two devices save the same Hardcover book at once: the second waits, then is refused as a duplicate.
    await s1.run(`begin; select public.library_book_add('{"hardcover_id": 650001, "title": "ZZ Both Devices"}', 'want', '{}', null) is not null;`);
    const m = s2.send(`select public.library_book_add('{"hardcover_id": 650001, "title": "ZZ Both Devices"}', 'want', '{}', null) is not null;`);
    ok(await waiting(), 'a second save of the same book waits for the first');
    await s1.run('commit;');
    const out = await s2.done(m);
    ok(/book_duplicate/.test(out) && psql(`select count(*) from public.book_entries where hardcover_id = 650001`) === '1', 'then it is refused; one copy is saved', out);
  }
  {
    // A status change on one device and a removal on the other, from the same page state: one wins, the other is refused.
    const e = L10.tables.book_entries[1].id;
    await s1.run(`begin; select public.library_book_set('${e}', 'want', 'reading') is not null;`);
    const m = s2.send(`select public.library_book_delete('${e}', 'want', '{"e:${e}"}') is not null;`);
    ok(await waiting(), 'a removal waits while the same book’s status is being saved');
    await s1.run('commit;');
    const out = await s2.done(m);
    ok(/target_changed/.test(out) && psql(`select status from public.book_entries where id = '${e}'`) === 'reading', 'then the removal is refused as out of date; the book stays Reading', out);
  }
  {
    ok(/lock table public\.book_entries[\s\S]*pg_advisory_xact_lock/.test(psql(`select prosrc from pg_proc where proname = 'bk1_lock'`)), 'bk1_lock takes the book tables before its advisory lock');
    await s1.run(`begin; select public.library_book_follow('author', 650500, 'ZZ Lock Test', false) is not null;`);
    const m = s2.send(`\\set doc \`cat ${f}\`\nselect public.restore_backup(:'doc'::jsonb, false) is not null;`);
    ok(await waiting(), 'a restore waits while a books change is open');
    await s1.run('commit;');
    const out = await s2.done(m);
    ok(/^t$/m.test(out) && !/deadlock/.test(out), 'then it runs, no deadlock', out);
    await s2.run(`begin;\n\\set doc \`cat ${f}\`\nselect public.restore_backup(:'doc'::jsonb, false) is not null;`);
    const m2 = s1.send(`select public.library_book_follow('author', 650501, 'ZZ Lock Test 2', false) is not null;`);
    ok(await waiting(), 'a books change waits while a restore is open');
    await s2.run('commit;');
    const out2 = await s1.done(m2);
    ok(/^t$/m.test(out2) && !/deadlock/.test(out2), 'then it runs, no deadlock', out2);
  }
  s1.end(); s2.end();
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
