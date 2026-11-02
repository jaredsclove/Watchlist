// The restore suite: what restore_backup must do on a database replayed to its final state, tested against expected behaviour.
//   PGLITE_DIR=<dir with @electric-sql/pglite> [PG_BIN=<postgres 17 bin>] node tools/restore-test.mjs
// PGlite covers behaviour: nineteen tables field by field, older formats through the page's converters, the admin tool, refusals, a late
// failure, accounts, research permissions and ordinary functions afterwards. Real PostgreSQL 17 (a throwaway server on a Unix socket, removed
// at the end) adds what one session can't show: concurrent writes and restores, and local timing. Without PG_BIN that part is skipped, with a
// notice. Synthetic data only. Output: pass/fail and counts. Local timing says nothing about hosted performance.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { replay, library, pageCode, clone, recount, rekey, file, ROOT, A, B, C, SPEC_CU1 } from './restore-fixture.mjs';

if (!process.env.PGLITE_DIR) { console.error('usage: PGLITE_DIR=<dir> [PG_BIN=<postgres 17 bin>] node tools/restore-test.mjs'); process.exit(2); }
const req = createRequire(path.join(process.env.PGLITE_DIR, 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));
const P = pageCode();
const FINAL = fs.existsSync(path.join(ROOT, 'db/simplify_restore_cleanup.sql'));
const finalStep = 'db/simplify_restore_cleanup.sql';

let passed = 0, failed = 0;
const ok = (c, l, d = '') => { c ? passed++ : failed++; if (!c) console.log(`  FAIL ${l}${d ? `\n       ${String(d).slice(0, 600)}` : ''}`); };
const section = t => console.log(`[${t}]`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const TABLES = Array.from(P('backupSpec')(7).tables);
const COLUMNS = P('backupSpec')(7).columns;

// ── PGlite ──
const db = new PGlite();
await replay(t => db.exec(t));

const as = (who, sql, params = [], role = 'authenticated') => db.transaction(async tx => {
  await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)`, [who ? JSON.stringify({ sub: who, role }) : '', role]);
  return (await tx.query(sql, params)).rows;
});
const restore = (who, doc) => as(who, `select public.restore_backup($1::jsonb, false) r`, [JSON.stringify(doc)]).then(r => ({ ok: true, r: r[0].r }), e => ({ ok: false, message: e.message, code: e.code }));
const rpc = (who, fn, args) => as(who, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args).then(r => ({ ok: true, r: r[0].r }), e => ({ ok: false, message: e.message, code: e.code }));
const val = async s => Object.values((await db.query(s)).rows[0])[0];
const fp = async () => {
  const out = {};
  for (const t of TABLES) out[t] = await val(`select md5(coalesce(string_agg(x, '|' order by x), '')) from (select to_jsonb(r)::text x from public.${t} r) q`);
  out.members = await val(`select md5(coalesce(string_agg(to_jsonb(m)::text, '|' order by user_id), '')) from private.library_members m`);
  return out;
};
// The library as the owner reads it now, compared with a file field by field, as the page verifies.
const differences = async (who, doc) => {
  const out = [];
  for (const t of TABLES) {
    const have = (await as(who, `select to_jsonb(x) j from public.${t} x`)).map(r => r.j), want = doc.tables[t] || [];
    if (have.length !== want.length) { out.push(`${t}: ${want.length} expected, ${have.length} found`); continue; }
    const byId = new Map(have.map(r => [r.id, r]));
    for (const r of want) {
      const h = byId.get(r.id);
      if (!h) { out.push(`${t}: ${r.id} missing`); continue; }
      const d = Array.from(P('compareRowFields')(r, h, COLUMNS[t]));
      if (d.length) out.push(`${t} ${r.id}: ${d.join(', ')}`);
      if (h.user_id !== who) out.push(`${t} ${r.id}: owner ${h.user_id}`);
    }
  }
  return out;
};

const L1 = library(1), L2 = library(2), L3 = library(3, 3);

if (FINAL) {
  section('the migration');
  await restore(A, L1); await restore(B, L2);
  const catalog = () => val(`select md5(coalesce(string_agg(x, '|' order by x), '')) from (
    select pg_get_functiondef(p.oid) x from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prokind = 'f'
    union all select c.oid::regclass::text from pg_class c where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace)
    union all select pg_get_triggerdef(t.oid) from pg_trigger t where not t.tgisinternal) q`);
  const step = file(finalStep), go = run => `select set_config('watchlist.simplify_run', '${run}', false);\n` + step;
  const attempt = text => db.exec(text).then(() => null, async e => { await db.exec('rollback'); return e.message; });
  const data = await fp(), cat = await catalog();
  ok(/set watchlist.simplify_run/.test(await attempt(`select set_config('watchlist.simplify_run', '', false);\n` + step)) && same(data, await fp()) && cat === await catalog(), 'without a run id: refused, nothing changed');
  const late = go('local-late').replace("select 'SIMPLIFY|'", () => `do $$ begin raise exception 'zz failure before commit'; end $$;\nselect 'SIMPLIFY|'`);
  const lateError = await attempt(late);
  ok(/zz failure before commit/.test(lateError) && same(data, await fp()) && cat === await catalog() && (await val(`select count(*)::int from private.migration_runs where migration = 'simplify'`)) === 0,
    'a failure just before commit leaves the old chain, the archive and every row in place', [lateError, same(data, await fp()), cat === await catalog()].join(' / '));
  ok(!(await attempt(go('local-simplify'))), 'the exact migration commits on a database holding libraries');
  ok(same(data, await fp()), 'installing it changes no library row');
  ok(await catalog() !== cat && (await val(`select count(*)::int from private.migration_runs where migration = 'simplify'`)) === 1, 'it changes the catalog and records one run');
  ok(/already installed/.test(await attempt(go('local-again'))) && same(data, await fp()), 'a rerun is refused');
  const gone = await val(`select count(*)::int from pg_class c where c.relnamespace = 'private'::regnamespace and c.relname ~ '^(stage5_recovery_|b45_)'`);
  ok(gone === 0, 'the archive and rollback tables are gone');
}
section('the fixture');
ok(!Array.from(P('validateBackupObject')(L1)).length && !Array.from(P('validateBackupObject')(L2)).length, 'the library passes the page’s validation', Array.from(P('validateBackupObject')(L1)).join('; '));
ok(TABLES.length === 19 && TABLES.every(t => L1.tables[t].length > 0), 'it has rows in all nineteen tables', TABLES.filter(t => !L1.tables[t].length).join());

section('a valid format-7 file');
{
  const r = await restore(A, L1);
  ok(r.ok, 'A’s restore is accepted', r.message);
  ok(r.ok && r.r.formatVersion === 7 && TABLES.every(t => r.r.restored[t] === L1.tables[t].length), 'its answer counts every table', JSON.stringify(r.r));
  ok(same(await differences(A, L1), []), 'all nineteen tables equal the file, field by field', (await differences(A, L1)).slice(0, 5).join('; '));
  const before = await fp();
  ok((await restore(A, L1)).ok && same(before, await fp()), 'restoring it again changes no row');
  const r2 = await restore(B, L2);
  ok(r2.ok && same(await differences(B, L2), []), 'a member without research access restores all nineteen too', r2.message);
  ok(same(await differences(A, L1), []), 'A’s library is untouched by B’s restore');
  const small = await restore(A, L3);
  ok(small.ok && same(await differences(A, L3), []), 'a smaller file replaces the whole library: nothing of the old one stays', small.message || (await differences(A, L3)).slice(0, 5).join('; '));
  const shuffled = clone(L1); TABLES.forEach(t => shuffled.tables[t].reverse());
  ok((await restore(A, shuffled)).ok && same(await differences(A, L1), []), 'rows in any order restore the same library: shows naming seasons that come later, seasons first');
  const empty = recount({ ...clone(L1), tables: Object.fromEntries(TABLES.map(t => [t, []])) });
  ok((await restore(A, empty)).ok && same(await differences(A, empty), []), 'an empty file empties the library');
  await restore(A, L1);
}

section('Earlier seasons and retired flags');
{
  const shows = L1.tables.tv_shows.filter(s => s.resume_start_season_id);
  const got = await as(A, `select id, resume_start_season_id, resume_end_season_id from public.tv_shows where resume_start_season_id is not null`);
  ok(shows.length > 0 && got.length === shows.length && shows.every(s => got.some(g => g.id === s.id && g.resume_start_season_id === s.resume_start_season_id && g.resume_end_season_id === s.resume_end_season_id)), 'every active range comes back');
  const none = clone(L1); none.tables.tv_shows.forEach(s => { s.resume_start_season_id = s.resume_end_season_id = null; });
  ok((await restore(A, none)).ok && (await as(A, `select count(*)::int n from public.tv_shows where resume_start_season_id is not null`))[0].n === 0, 'a file without ranges clears them');
  await restore(A, L1);
  const other = clone(L1); const s = other.tables.tv_shows.find(x => x.resume_start_season_id); const t = other.tables.watchlist_items.find(w => w.show_id && w.show_id !== s.id);
  s.resume_end_season_id = t.id;
  const before = await fp(), r = await restore(A, other);
  ok(!r.ok && same(before, await fp()), 'a range naming another show’s season is refused, nothing changed', r.message);
  const half = clone(L1); half.tables.tv_shows.find(x => x.resume_start_season_id).resume_end_season_id = null;
  const r2 = await restore(A, half);
  ok(!r2.ok && same(before, await fp()), 'half a range is refused, nothing changed', r2.message);
  const flags = (await as(A, `select count(*) filter (where catalog_new)::int n, count(*) filter (where status_review)::int r, count(legacy_status)::int l from public.tv_shows`))[0];
  ok(flags.n > 0 && flags.r > 0 && flags.l > 0, 'retired flags in a file are stored as they are', JSON.stringify(flags));
}

section('older formats, through the page');
{
  const drop = (doc, tables) => { const d = clone(doc); tables.forEach(t => { delete d.tables[t]; delete d.rowCounts[t]; }); return d; };
  const six = { ...drop(L1, SPEC_CU1), formatVersion: 6 };
  const five = { ...drop(L1, [...SPEC_CU1, 'episode_marks']), formatVersion: 5 };
  ok(!Array.from(P('validateBackupObject')(six)).length && !Array.from(P('validateBackupObject')(five)).length, 'format-5 and format-6 files validate', Array.from(P('validateBackupObject')(five)).join('; '));
  const prepared = doc => clone(P('restoreDocument')(doc));
  const p6 = prepared(six), p5 = prepared(five);
  ok(p6.formatVersion === 7 && !('conversion' in p6) && !('recovery' in p6) && !Array.from(P('validateBackupObject')(p6)).length, 'format 6 becomes a plain format-7 document');
  const r6 = await restore(A, p6);
  ok(r6.ok && same(await differences(A, p6), []), 'restored: its nine tables equal the file; collection updates are empty', r6.message);
  const r5 = await restore(A, p5);
  ok(r5.ok && same(await differences(A, p5), []) && (await as(A, `select count(*)::int n from public.episode_marks`))[0].n === 0, 'format 5: restored, no episode marks', r5.message);
  // Inherited sections, as a saved converted file carries them.
  const legacy = clone(L1); legacy.conversion = { source_format: 3, source_exported_at: '2026-01-01T00:00:00Z', source_sha256: 'b'.repeat(64), converter_version: '5.1' };
  legacy.recovery = { storage_map: { items: [], shows: [], personal_collections: [] }, othertv_shows: [{ id: 'not-even-valid' }] };
  const pl = prepared(legacy);
  ok(!('conversion' in pl) && !('recovery' in pl) && same(pl.tables, L1.tables), 'a format-7 file’s conversion and recovery sections are left out of what is sent, its tables kept');
  ok('recovery' in legacy, 'the document read from the file keeps them');
  const rl = await restore(A, pl);
  ok(rl.ok && same(await differences(A, L1), []), 'restored, the library tables fully checked', rl.message);
  const sixLegacy = clone(six); sixLegacy.conversion = { source_format: 3, source_exported_at: '2026-01-01T00:00:00Z', source_sha256: 'b'.repeat(64), converter_version: '5.1+ep1.1' }; sixLegacy.recovery = legacy.recovery;
  const ps = prepared(sixLegacy);
  ok(ps.formatVersion === 7 && !('conversion' in ps) && !('recovery' in ps) && (await restore(A, ps)).ok, 'the same on a format-6 file: converted, sections left out, restored');
  await restore(A, L1);
  if (FINAL) {
    const direct = await restore(A, legacy);
    ok(direct.ok && same(await differences(A, L1), []), 'the function itself accepts and ignores both sections', direct.message);
    const junk = clone(L1); junk.conversion = 'junk'; junk.recovery = 7;
    ok((await restore(A, junk)).ok, 'in any shape');
  }
  for (const [v, name] of [[3, 'format 3'], [4, 'format 4']]) {
    const doc = { format: 'watchlist-tracker-backup', formatVersion: v, exportedAt: L1.exportedAt, rowCounts: {}, tables: {} };
    const before = await fp(), r = await restore(A, doc);
    ok(!r.ok && /format/.test(r.message) && same(before, await fp()), `${name}: refused by the database, nothing changed`, r.message);
    ok(Array.from(P('validateBackupObject')(doc)).some(e => /format/i.test(e)), `${name}: refused by the page’s validation`);
  }
}

section('refusals leave everything as it was');
{
  await restore(A, L1); await restore(B, L2);
  const before = await fp();
  const edit = fn => { const d = clone(L1); fn(d); return d; };
  const row = (d, t, f = () => true) => d.tables[t].find(f);
  const CASES = {
    'not a backup': d => { d.format = 'other'; },
    'no format': d => { delete d.formatVersion; },
    'format 1': d => { d.formatVersion = 1; }, 'format 2': d => { d.formatVersion = 2; }, 'format 5 unconverted': d => { d.formatVersion = 5; }, 'format 6 unconverted': d => { d.formatVersion = 6; },
    'a future format': d => { d.formatVersion = 8; },
    'an unknown top-level field': d => { d.extra = 1; },
    'a missing table': d => { delete d.tables.update_holds; delete d.rowCounts.update_holds; },
    'an extra table': d => { d.tables.zz = []; d.rowCounts.zz = 0; },
    'a table that isn’t a list': d => { d.tables.tv_shows = {}; },
    'a wrong row count': d => { d.rowCounts.watchlist_items += 1; },
    'a wrong row count in a late table': d => { d.rowCounts.update_findings += 1; },
    'a row with a missing column': d => { delete d.tables.tv_shows[0].network; },
    'a row with an extra column': d => { d.tables.episode_marks[0].user_id = A; },
    'a row that isn’t an object': d => { d.tables.update_setup[0] = 1; },
    'an id that isn’t a uuid': d => { d.tables.tv_shows[0].id = 'x'; },
    'a repeated id': d => { d.tables.update_holds[1].id = d.tables.update_holds[0].id; },
    'a value of the wrong type': d => { d.tables.watchlist_items[0].season_number = 'x'; },
    'a date that isn’t one': d => { d.tables.update_holds[0].decided_on = 'soon'; },
    'an unknown show status': d => { d.tables.tv_shows[0].status = 'complete'; },
    'a season without a show': d => { const s = row(d, 'watchlist_items', w => w.show_id); s.show_id = null; d.tables.tv_shows.forEach(x => { if (x.resume_start_season_id === s.id || x.resume_end_season_id === s.id) x.resume_start_season_id = x.resume_end_season_id = null; }); },
    'a season naming a missing show': d => { row(d, 'watchlist_items', w => w.show_id).show_id = '70000000-0000-4000-8000-000000000000'; },
    'an unknown watch-with choice': d => { row(d, 'watchlist_items', w => w.show_id).watch_with = ['nobody']; },
    'a membership naming a season, not a film': d => { const m = row(d, 'collection_memberships', x => x.item_id); m.item_id = row(d, 'watchlist_items', w => w.show_id).id; },
    'a repeated membership': d => { const m = d.tables.collection_memberships; m.push({ ...m[0], id: '7a000000-0000-4000-8000-000000000001' }); recount(d); },
    'a film link naming a season': d => { d.tables.catalog_film_links[0].item_id = row(d, 'watchlist_items', w => w.show_id).id; },
    'a mark on an unmatched season': d => { d.tables.episode_marks[0].season_id = row(d, 'watchlist_items', w => w.media_type === null).id; },
    'a mark on a missing season': d => { d.tables.episode_marks[0].season_id = '70000000-0000-4000-8000-000000000000'; },
    'a repeated mark': d => { const m = d.tables.episode_marks; m[1].tmdb_episode_id = m[0].tmdb_episode_id; },
    'a repeated mark id': d => { d.tables.episode_marks[1].id = d.tables.episode_marks[0].id; },
    'a negative episode number': d => { d.tables.episode_marks[0].episode_number = -1; },
    'a film without a priority': d => { row(d, 'watchlist_items', w => w.media_type === 'movie').priority = null; },
    'a season with a priority': d => { row(d, 'watchlist_items', w => w.show_id).priority = 'high'; },
    'a film with an old status outside the list': d => { row(d, 'watchlist_items', w => w.media_type === 'movie').legacy_status = 'skipped'; },
    'a range naming a film': d => { row(d, 'tv_shows', s => s.resume_start_season_id).resume_start_season_id = row(d, 'watchlist_items', w => w.media_type === 'movie').id; },
    'two setup rows': d => { d.tables.update_setup.push({ ...d.tables.update_setup[0], id: '7a000000-0000-4000-8000-000000000002' }); recount(d); },
    'a tampered definition': d => { d.tables.collection_definitions[0].evidence_hash = 'x'; },
    'a definition with unreadable rules': d => { d.tables.collection_definitions[0].rules = [{ type: 'nope' }]; },
    'a definition with bad evidence settings': d => { d.tables.collection_definitions[0].evidence = {}; },
    'a hold naming a missing collection': d => { d.tables.update_holds[0].collection_id = '70000000-0000-4000-8000-000000000000'; },
    'a hold of the wrong shape': d => { d.tables.update_holds[0].field = null; },
    'an import naming a missing brief': d => { d.tables.research_imports[0].brief_id = '70000000-0000-4000-8000-000000000000'; },
    'a research finding without a brief (the last table)': d => { d.tables.update_findings[1].brief_id = null; },
    'a repeated fingerprint (the last table)': d => { d.tables.update_findings[1].fingerprint = d.tables.update_findings[0].fingerprint; }
  };
  for (const [name, fn] of Object.entries(CASES)) {
    const r = await restore(A, edit(fn));
    ok(!r.ok && same(before, await fp()), `${name}: refused, nothing changed`, r.ok ? 'accepted' : r.message);
  }
  ok(Object.keys(CASES).length >= 35, 'the refusals above all ran');
}

section('a failure late in the restore');
{
  const before = await fp();
  // After every delete and every other insert: the last row of the last table fails.
  await db.exec(`create function public.zz_late() returns trigger language plpgsql as $$ begin raise exception 'zz late failure' using errcode = 'XX000'; end $$;
    create trigger zz_late before insert on public.update_findings for each row when (new.source = 'research') execute function public.zz_late()`);
  const r = await restore(A, L1);
  ok(!r.ok && /zz late/.test(r.message) && same(before, await fp()), 'it rolls everything back', r.message);
  await db.exec(`drop trigger zz_late on public.update_findings; drop function public.zz_late()`);
  // A later insert changing an earlier row: only a check of the final state can see it.
  await db.exec(`create function public.zz_late() returns trigger language plpgsql as $$ begin update public.tv_shows set network = 'ZZ Changed' where id = '${L1.tables.tv_shows[0].id}' and user_id = new.user_id; return new; end $$;
    alter function public.zz_late() set search_path = '';
    create trigger zz_late after insert on public.update_findings for each row when (new.source = 'research') execute function public.zz_late()`);
  const r2 = await restore(A, L1);
  if (FINAL) ok(!r2.ok && /differ/.test(r2.message), 'a row changed by a later insert is seen before commit', r2.ok ? 'accepted' : r2.message);
  await db.exec(`drop trigger zz_late on public.update_findings; drop function public.zz_late()`);
  if (r2.ok) await restore(A, L1);
  ok(same(before, await fp()), 'and leaves the library as it was');
}

section('accounts');
{
  const before = await fp();
  // Another account's ids, in every table a file names: the database refuses them even though row security hides them.
  for (const t of TABLES.filter(x => x !== 'watchlist_items' && x !== 'tv_shows')) {
    const d = clone(L1); d.tables[t][0].id = L2.tables[t][0].id;
    const r = await restore(A, d);
    ok(!r.ok && same(before, await fp()), `${t}: another account’s id is refused`, r.ok ? 'accepted' : r.message);
  }
  for (const t of ['tv_shows', 'watchlist_items']) {
    const d = clone(L1), old = d.tables[t][0].id;
    const text = JSON.stringify(d).replaceAll(old, L2.tables[t][0].id);
    const r = await restore(A, JSON.parse(text));
    ok(!r.ok && /another user/.test(r.message) && same(before, await fp()), `${t}: another account’s id is refused as such`, r.ok ? 'accepted' : r.message);
  }
  const ref = async (name, fn) => { const d = clone(L1); fn(d); const r = await restore(A, d); ok(!r.ok && same(before, await fp()), `a reference into another account: ${name}`, r.ok ? 'accepted' : r.message); };
  await ref('a membership naming B’s show', d => { d.tables.collection_memberships.find(m => m.show_id).show_id = L2.tables.tv_shows[0].id; });
  await ref('a season naming B’s show', d => { d.tables.watchlist_items.find(w => w.show_id).show_id = L2.tables.tv_shows[0].id; });
  await ref('a mark naming B’s season', d => { d.tables.episode_marks[0].season_id = L2.tables.episode_marks[0].season_id; });
  await ref('a hold naming B’s show', d => { d.tables.update_holds[0].show_id = L2.tables.tv_shows[0].id; });
  await ref('an import naming B’s brief', d => { d.tables.research_imports[0].brief_id = L2.tables.research_briefs[0].id; });
  const nm = await restore(C, rekey(L3, '73', '76'));
  ok(!nm.ok && /not_a_member/.test(nm.message) && same(before, await fp()), 'a signed-in non-member is refused', nm.message);
  const anon = await as(null, `select public.restore_backup($1::jsonb, false)`, [JSON.stringify(L1)], 'anon').then(() => null, e => e.message);
  ok(anon && /permission denied/.test(anon) && same(before, await fp()), 'signed out: not executable', anon);
  ok((await val(`select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = 'restore_backup' and n.nspname = 'public' and not has_function_privilege('anon', p.oid, 'execute') and has_function_privilege('authenticated', p.oid, 'execute') and p.prosecdef = false`)) === 1,
    'one public restore_backup: security invoker, for authenticated only');
  const sig = await val(`select pg_get_function_identity_arguments('public.restore_backup(jsonb, boolean)'::regprocedure)`);
  ok(sig === 'p_backup jsonb, p_allow_v1_reset boolean', 'its signature is unchanged', sig);
}

section('research permissions');
{
  await restore(B, L2);
  const on = async who => (await as(who, `select public.stage5_capabilities() c`))[0].c.research;
  ok(await on(A) === true && await on(B) === false, 'A has research access; B doesn’t');
  ok((await as(B, `select count(*)::int n from public.update_findings where source = 'research'`))[0].n === 1, 'B’s restored research rows are stored');
  const write = await rpc(B, 'library_cu_delete_hold', [L2.tables.update_holds[0].id, 'ZZ keep']);
  ok(!write.ok && /research_not_enabled/.test(write.message), 'a research write after B’s restore is refused', write.message);
  // In the same transaction as a successful restore: nothing stays open.
  const same_tx = await db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: B, role: 'authenticated' })]);
    await tx.query(`select public.restore_backup($1::jsonb, false)`, [JSON.stringify(L2)]);
    const flag = (await tx.query(`select current_setting('watchlist.research_restore', true) f`)).rows[0].f;
    const r = await tx.query(`delete from public.update_holds where id = $1`, [L2.tables.update_holds[0].id]).then(() => 'deleted', e => e.message);
    await tx.rollback();
    return { flag, r };
  });
  ok(same_tx.flag === '' && /research_not_enabled/.test(same_tx.r), 'the bypass ends with the restore, inside the transaction', JSON.stringify(same_tx));
  // A failed restore, caught in a savepoint.
  const caught = await db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: B, role: 'authenticated' })]);
    await tx.exec(`savepoint s`);
    const bad = clone(L2); bad.tables.update_findings[1].brief_id = null;
    await tx.query(`select public.restore_backup($1::jsonb, false)`, [JSON.stringify(bad)]).catch(() => {});
    await tx.exec(`rollback to savepoint s`);
    const flag = (await tx.query(`select coalesce(current_setting('watchlist.research_restore', true), '') f`)).rows[0].f;
    const r = await tx.query(`delete from public.update_holds where id = $1`, [L2.tables.update_holds[0].id]).then(() => 'deleted', e => e.message);
    await tx.rollback();
    return { flag, r };
  });
  ok(caught.flag === '' && /research_not_enabled/.test(caught.r), 'and after a refused restore caught in a savepoint', JSON.stringify(caught));
  ok((await val(`select research_enabled from private.library_members where user_id = '${B}'`)) === false, 'B’s research permission is unchanged');
  ok((await as(A, `select count(*)::int n from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosrc like '%watchlist.research_restore%'`))[0].n >= 2, 'the flag is read by the guard and set by restore');
  const direct = await as(B, `insert into public.update_setup (id, source) values ('7b000000-0000-4000-8000-000000000001', 'setup_file')`).then(() => 'inserted', e => e.message);
  ok(!/inserted/.test(direct), 'a direct research-table write stays refused', direct);
}

section('holds keep protecting after a restore');
{
  await restore(A, L1);
  const s = L1.tables.tv_shows[0], before = await fp();
  const del = await rpc(A, 'library_cu_delete_hold', [L1.tables.update_holds[0].id, 'someone else’s decision']);
  ok(!del.ok && same(before, await fp()), 'a stale hold delete is refused', del.message);
  const list = await as(A, `select count(*)::int n from public.update_holds where show_id = $1`, [s.id]);
  ok(list[0].n === 1, 'the restored hold is on its show');
}

section('ordinary functions afterwards');
{
  await restore(A, L1);
  const seasons = [1, 2, 3].map(n => ({ item_key: `zz smoke|season ${n}`, title: 'ZZ Smoke', season: `Season ${n}`, theme: 'ZZ', display_date: 'Jan 1, 2020', date_sort: '2020-01-01', season_number: n }));
  const made = await rpc(A, 'library_create_show_b45', [{ tmdb_id: 8999001, title: 'ZZ Smoke', show_key: 'zz smoke', network: 'ZZ' }, seasons]);
  ok(made.ok, 'a show is created', made.message);
  const show = made.r.show.id, rows = (await as(A, `select id, watched, skipped from public.watchlist_items where show_id = $1 order by season_number`, [show]));
  ok((await rpc(A, 'set_season_watched', [rows[1].id, true])).ok, 'a season is marked watched');
  const m = await rpc(A, 'library_set_episode_marks', [rows[2].id, { watched: false, skipped: false }, true, [{ tmdb_episode_id: 8999100, episode_number: 1 }]]);
  ok(m.ok, 'an episode is marked', m.message);
  const res = await rpc(A, 'library_set_resume_b45', [show, { status: 'confirmed', resume_start_season_id: null, resume_end_season_id: null }, rows[0].id, rows[1].id, false]);
  ok(res.ok, 'an Earlier seasons range is saved', res.message);
  const mem = await rpc(A, 'org_add_membership', [L1.tables.personal_collections[1].id, show, null]);
  ok(mem.ok, 'the show joins a collection', mem.message);
  const hold = await rpc(A, 'library_cu_save_hold', [{ kind: 'standing_decision', subject_label: 'ZZ Smoke Hold', decision: 'ZZ', effect: 'do_not_add', reopen: { on: 'owner_only' } }]);
  ok(hold.ok, 'a hold is saved with research access', hold.message);
  const del = await rpc(A, 'delete_tv_season', [rows[1].id, 0]);
  ok(del.ok && (await as(A, `select resume_start_season_id s from public.tv_shows where id = $1`, [show]))[0].s === null, 'deleting a season clears its range', del.message);
  const cap = (await as(A, `select public.stage5_capabilities() c`))[0].c;
  ok(cap.phase === 'contracted-cu1' && cap.backup_format === 7 && cap.member === true && cap.research === true && cap.access === 'members', 'the capability answers as before', JSON.stringify(cap));
  ok(cap.recovery_archive === (FINAL ? 'retired' : 'active'), 'and reports the archive', cap.recovery_archive);
  if (FINAL) {
    const stale = await rpc(A, 'library_dismiss_catalog_new_b45', [[]]);
    const b = await fp();
    ok(!stale.ok && /does not exist/.test(stale.message) && same(b, await fp()), 'a stale tab’s retired call fails without changing data', stale.message);
    ok((await as(A, `select public.org_capabilities() c`))[0].c !== undefined, 'the Manage dialog’s capability still answers');
  }
}

section('the admin tool');
{
  await restore(A, L1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-adm-'));
  const tool = (...args) => { try { return { ok: true, out: execFileSync(process.execPath, [path.join(ROOT, 'tools/admin-restore.mjs'), ...args], { encoding: 'utf8' }) }; } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; } };
  const exportDoc = async () => { const out = await db.exec(tool('export-sql', '--owner', A).out); return out.map(q => q.rows && q.rows[0] && q.rows[0].backup).find(Boolean); };
  try {
    const safety = await exportDoc();
    fs.writeFileSync(path.join(dir, 'safety.json'), safety);
    const legacy = JSON.parse(safety); legacy.conversion = { source_format: 3, source_exported_at: '2026-01-01T00:00:00Z', source_sha256: 'b'.repeat(64), converter_version: '5.1' }; legacy.recovery = { storage_map: {}, othertv_shows: [] };
    fs.writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify(legacy));
    const legacyBefore = fs.readFileSync(path.join(dir, 'legacy.json'));
    const c = tool('check', '--file', path.join(dir, 'legacy.json'), '--safety', path.join(dir, 'safety.json'), '--out', path.join(dir, 'out.json'));
    ok(c.ok && /OK/.test(c.out), 'check accepts a format-7 file with inherited sections', c.out);
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
    ok(!('conversion' in out) && !('recovery' in out) && fs.readFileSync(path.join(dir, 'legacy.json')).equals(legacyBefore), 'its output has neither; the original file is unchanged');
    const six = JSON.parse(safety); SPEC_CU1.forEach(t => { delete six.tables[t]; delete six.rowCounts[t]; }); six.formatVersion = 6;
    fs.writeFileSync(path.join(dir, 'six.json'), JSON.stringify(six));
    const c6 = tool('check', '--file', path.join(dir, 'six.json'), '--safety', path.join(dir, 'safety.json'), '--out', path.join(dir, 'six7.json'));
    const six7 = JSON.parse(fs.readFileSync(path.join(dir, 'six7.json'), 'utf8'));
    ok(c6.ok && six7.formatVersion === 7 && !('conversion' in six7), 'check converts a format-6 file to plain format 7', c6.out);
    const r = await db.exec(tool('restore-sql', '--file', path.join(dir, 'out.json'), '--owner', A, '--email', 'a@test.invalid', '--run', 'restore-suite-1').out).then(() => ({ ok: true }), e => ({ ok: false, message: e.message }));
    ok(r.ok, 'the restore SQL restores it as the member', r.message);
    fs.writeFileSync(path.join(dir, 'after.json'), await exportDoc());
    const v = tool('verify', '--file', path.join(dir, 'out.json'), '--after', path.join(dir, 'after.json'));
    ok(v.ok && /VERIFIED/.test(v.out), 'verify: the export equals the file, every table', v.out);
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ format: 'watchlist-tracker-backup', formatVersion: 4, exportedAt: L1.exportedAt, rowCounts: {}, tables: {} }));
    const c4 = tool('check', '--file', path.join(dir, 'old.json'), '--safety', path.join(dir, 'safety.json'));
    ok(!c4.ok && /format 4/.test(c4.out), 'check refuses a format-4 file and says why', c4.out);
    const f6 = tool('export-sql', '--owner', A, '--format', '6');
    ok(!f6.ok, '--format 6 is gone', f6.out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ── PostgreSQL 17 ──
if (!process.env.PG_BIN) console.log('\nNOTICE: PG_BIN is not set, so the concurrency and timing checks on real PostgreSQL 17 were SKIPPED.');
else {
  const BIN = process.env.PG_BIN, WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'restorepg-')), DATA = path.join(WORK, 'data'), SOCK = path.join(WORK, 's');
  fs.mkdirSync(SOCK);
  const bin = n => path.join(BIN, n);
  const args = ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', SOCK, '-U', 'postgres', '-d', 'postgres'];
  const psql = text => execFileSync(bin('psql'), args, { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();
  process.on('exit', () => { try { execFileSync(bin('pg_ctl'), ['-D', DATA, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch (e) { /* not running */ } fs.rmSync(WORK, { recursive: true, force: true }); });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const session = who => {
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
  const docFile = (name, doc) => { const f = path.join(WORK, name); fs.writeFileSync(f, JSON.stringify(doc)); return f; };
  const rest = f => `\\set doc \`cat ${f}\`\nselect public.restore_backup(:'doc'::jsonb, false) is not null;`;
  const as1 = (who, sql) => psql(`begin; select set_config('request.jwt.claims', '{"sub": "${who}", "role": "authenticated"}', true), set_config('role', 'authenticated', true);\n${sql};\ncommit;`).split('\n').slice(1).join('\n').trim();
  const waiting = async () => { for (let i = 0; i < 500; i++) { if (Number(psql(`select count(*) from pg_stat_activity where wait_event_type = 'Lock' and state = 'active'`)) > 0) return true; await wait(10); } return false; };
  const count = (who, t, where = 'true') => Number(as1(who, `select count(*) from public.${t} where ${where}`));
  const fp17 = () => psql(TABLES.map(t => `select md5(coalesce(string_agg(x, '|' order by x), '')) from (select to_jsonb(r)::text x from public.${t} r) q`).join(';\n') + ';');

  section('real PostgreSQL 17: concurrency');
  execFileSync(bin('initdb'), ['-D', DATA, '-U', 'postgres', '--auth=trust'], { stdio: 'ignore' });
  execFileSync(bin('pg_ctl'), ['-D', DATA, '-o', `-c listen_addresses='' -c unix_socket_directories='${SOCK}' -c timezone=UTC -c deadlock_timeout=200ms`, '-l', path.join(WORK, 'log'), '-w', 'start'], { stdio: 'ignore' });
  await replay(async t => { psql(t); });
  if (FINAL) psql(`select set_config('watchlist.simplify_run', 'local-simplify', false);\n` + file(finalStep));
  const fA = docFile('a.json', L1), fB = docFile('b.json', L2), fA2 = docFile('a2.json', rekey(L1, '71', '74'));
  const season = L1.tables.watchlist_items.find(w => w.show_id && !w.watched).id;
  ok(/^t$/m.test(psql(setAs(A) + '\n' + rest(fA))) && /^t$/m.test(psql(setAs(B) + '\n' + rest(fB))), 'both libraries restore on a real server');
  const base = fp17();
  const s1 = session(), s2 = session();
  await s1.run(setAs(A)); await s2.run(setAs(A));
  {
    // A write in flight when the restore starts: the restore waits, then replaces it.
    await s1.run(`begin; select public.set_season_watched('${season}', true);`);
    const m = s2.send(rest(fA));
    ok(await waiting(), 'an ordinary write in flight: the restore waits for it');
    await s1.run('commit;');
    const out = await s2.done(m);
    ok(/^t$/m.test(out) && fp17() === base, 'then the library equals the file exactly; the earlier write is part of what the restore replaced', out);
  }
  {
    // A restore in flight: an ordinary write waits, and applies to the restored row.
    await s1.run(`begin;`); await s1.run(rest(fA));
    const m = s2.send(`select public.set_season_watched('${season}', true) is not null;`);
    ok(await waiting(), 'a restore in flight: an ordinary write waits for it');
    await s1.run('commit;');
    const out = await s2.done(m);
    ok(/^t$/m.test(out) && count(A, 'watchlist_items', `id = '${season}' and watched`) === 1 && count(A, 'watchlist_items') === L1.tables.watchlist_items.length, 'then it applies to the restored row, and no row is lost', out);
    psql(setAs(A) + '\n' + rest(fA));
  }
  {
    // A write aimed at a row the file doesn't have: refused, never brought back.
    psql(setAs(A) + '\n' + rest(fA2));
    await s1.run(`begin;`); await s1.run(rest(fA));
    const gone = rekey(L1, '71', '74').tables.watchlist_items.find(w => w.show_id && !w.watched).id;
    const m = s2.send(`select public.set_season_watched('${gone}', true) is not null;`);
    ok(await waiting(), 'a write to a row the restore removes waits');
    await s1.run('commit;');
    const out = await s2.done(m);
    ok(fp17() === base, 'then it changes nothing, and the row doesn’t come back', out);
  }
  {
    // Two restores of one library, the second file different.
    await s1.run(`begin;`); await s1.run(rest(fA2));
    const m = s2.send(rest(fA));
    ok(await waiting(), 'a second restore waits for the first');
    await s1.run('commit;');
    const out = await s2.done(m);
    ok(/^t$/m.test(out) && fp17() === base, 'then its file wins whole: no mix of the two', out);
  }
  {
    // Another member's write during a restore.
    const s3 = session(); await s3.run(setAs(B));
    const seasonB = L2.tables.watchlist_items.find(w => w.show_id && !w.watched).id;
    await s1.run(`begin;`); await s1.run(rest(fA));
    const m = s3.send(`select public.set_season_watched('${seasonB}', true) is not null;`);
    ok(await waiting(), 'another member’s write waits for the restore (the table lock, as before)');
    await s1.run('commit;');
    const out = await s3.done(m);
    ok(/^t$/m.test(out) && count(B, 'watchlist_items', `id = '${seasonB}' and watched`) === 1, 'then it applies', out);
    await s3.run(`select public.set_season_watched('${seasonB}', false) is not null;`);
    s3.end();
  }
  {
    // A lock held past the restore's timeout: refused, nothing changed.
    await s1.run(`begin; select public.set_season_watched('${season}', true);`);
    const out = await s2.run(rest(fA));
    await s1.run('rollback;');
    ok(/lock timeout|canceling statement/.test(out) && fp17() === base, 'a restore that can’t get its lock in 5 s is refused, nothing changed', out);
  }
  s1.end(); s2.end();

  section('real PostgreSQL 17: local timing');
  const big = library(1, 2500), fBig = docFile('big.json', big);
  psql('analyze');
  const rows = Object.values(big.rowCounts).reduce((a, b) => a + b, 0);
  const times = [];
  for (let i = 0; i < 3; i++) {
    const out = psql(`\\timing on\n${setAs(A)}\n${rest(fBig)}`);
    times.push(Number(/Time: ([\d.]+) ms/.exec(out.split('\n').filter(l => l.startsWith('Time:')).pop())[1]));
  }
  const best = Math.min(...times);
  console.log(`  local, ${rows} synthetic rows: ${times.map(t => Math.round(t)).join(', ')} ms (best ${Math.round(best)})`);
  ok(count(A, 'watchlist_items') === big.rowCounts.watchlist_items, 'the large library restored');
  const LIMIT = Number(process.env.RESTORE_MS_LIMIT || 6000);
  ok(best < LIMIT, `a large local restore stays under ${LIMIT} ms (a guard against a material regression, not a hosted figure)`, `${best} ms`);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
