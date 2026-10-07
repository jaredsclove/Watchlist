// Local rehearsal of Stage 3b-2 (editing personal organization) on PGlite.
// Builds a replica at stage final with Stage 3b-1 installed, from either a
// format 2 backup (loaded before db/phase3b_org.sql, which then bootstraps the
// organization) or a format 3 backup (restored after it). Then: applies
// db/phase3b2_org_write.sql (existing rows and organization unchanged; only the
// expected objects added or changed), checks a second run is refused, runs the
// db/test/t_3b2_org.sql self-checks and the Stage 3b-1 self-checks again, makes
// a set of 3b-2 edits, rolls back with db/rollback/phase3b2.sql (schema equal to
// Stage 3b-1 exactly, edits kept), checks the rollback refuses when 3b-2 isn't
// installed, and applies 3b-2 again. With --export-edited <file> it writes the
// edited state as a format 3 backup (for the app's compatibility tests).
// Nothing here touches Supabase. PGlite is not a repo dependency:
//   PGLITE_DIR=/path/with/node_modules node tools/db-rehearsal-3b2.mjs <backup.json> [--export-edited <out.json>]
// PGlite is one session: it shows each function's behaviour, not how two
// sessions interleave (that needs two real connections on a hosted test project).
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(process.env.PGLITE_DIR || '.', 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));
const args = process.argv.slice(2);
const exportIdx = args.indexOf('--export-edited');
const exportPath = exportIdx >= 0 ? args[exportIdx + 1] : null;
const preIdx = args.indexOf('--export-pre');
const exportPrePath = preIdx >= 0 ? args[preIdx + 1] : null;
const flagValues = new Set([exportIdx, preIdx].filter(i => i >= 0).map(i => i + 1));
const backupPath = args.find((a, i) => !a.startsWith('--') && !flagValues.has(i));
if (!backupPath) { console.error('usage: node tools/db-rehearsal-3b2.mjs <backup.json> [--export-edited <out.json>] [--export-pre <out.json>]'); process.exit(2); }
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
if (![2, 3].includes(backup.formatVersion)) { console.error('needs a format 2 or 3 backup'); process.exit(2); }

const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const ok = (cond, label, detail = '') => { if (!cond) failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${detail}` : ''}`); };
const section = t => console.log(`\n[${t}]`);

// Stage final with Stage 3b-1 installed and the backup's data.
export async function buildReplica(snapshot) {
  const db = new PGlite();
  const anon = (s, p) => db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', '', true), set_config('role', 'anon', true)`);
    return (await tx.query(s, p)).rows;
  });
  for (const f of ['db/test/supabase_shim.sql', 'db/test/replica_schema.sql', 'db/phase0_restore_v1.sql']) await db.exec(sql(f));
  await db.exec(`set timezone = 'UTC'`);
  const v2 = snapshot.formatVersion === 2;
  if (v2) {
    const v1 = { format: snapshot.format, formatVersion: 1, exportedAt: snapshot.exportedAt,
      rowCounts: { watchlist_items: snapshot.rowCounts.watchlist_items, othertv_shows: snapshot.rowCounts.othertv_shows, custom_collections: snapshot.rowCounts.custom_collections },
      tables: { watchlist_items: snapshot.tables.watchlist_items.map(({ show_id, skipped, ...r }) => r),
        othertv_shows: snapshot.tables.othertv_shows, custom_collections: snapshot.tables.custom_collections } };
    await anon(`select public.restore_backup($1::jsonb)`, [v1]);
  }
  for (const f of ['db/phase1b_ownership.sql', 'db/restore_backup.sql', 'db/phase1c_tv_schema.sql', 'db/tv_model.sql', 'db/rpc.sql', 'db/admin/tv_enrich.sql']) {
    await db.exec(sql(f));
  }
  await db.exec(`update private.migration_stage set stage = 'final'`);
  if (v2) await anon(`select public.restore_backup($1::jsonb, false)`, [snapshot]);
  await db.exec(sql('db/phase3b_org.sql'));
  if (!v2) await anon(`select public.restore_backup($1::jsonb, false)`, [snapshot]);
  return { db, anon };
}

const CATALOG = `select json_build_object(
  'indexes', (select json_agg(indexdef order by indexdef) from pg_indexes where schemaname = 'public'),
  'constraints', (select json_agg(x order by x) from (select conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid) x
                  from pg_constraint where connamespace = 'public'::regnamespace) s),
  'columns', (select json_agg(x order by x) from (select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' ||
              coalesce(column_default, '') || ' ' || coalesce(generation_expression, '') x from information_schema.columns where table_schema = 'public') s),
  'policies', (select json_agg(x order by x) from (select tablename || '.' || policyname || ' ' || cmd || ' ' || roles::text x from pg_policies where schemaname = 'public') s),
  'table_grants', (select json_agg(x order by x) from (select table_name || ' ' || grantee || ' ' || privilege_type x
                   from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')) s),
  'column_grants', (select json_agg(x order by x) from (select c.relname || '.' || a.attname || ' ' || a.attacl::text x
                    from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace = 'public'::regnamespace and a.attacl is not null) s),
  'functions', (select json_agg(x order by x) from (select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' ||
                md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text, '') x
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')) s),
  'triggers', (select json_agg(tgname || ' ' || tgenabled::text order by tgname) from pg_trigger where not tgisinternal),
  'tables', (select json_agg(tablename order by tablename) from pg_tables where schemaname = 'public')
)::text c`;
// Everything stored, apart from owner and generated columns.
const CONTENT = `select concat_ws('/',
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.othertv_shows t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.custom_collections t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.personal_collections t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watch_with_choices t)) c`;
const NEW_FUNCTIONS = ['public.org_capabilities()', 'public.org_create_collection(p_id uuid, p_name text)',
  'public.org_rename_collection(p_id uuid, p_expected_name text, p_name text)', 'public.org_set_collection_archived(p_id uuid, p_archived boolean)',
  'public.org_add_membership(p_collection_id uuid, p_show_id uuid, p_item_id uuid)',
  'public.org_remove_membership(p_membership_id uuid, p_collection_id uuid, p_show_id uuid, p_item_id uuid)',
  'public.org_create_choice(p_id uuid, p_label text)', 'public.org_rename_choice(p_id uuid, p_expected_label text, p_label text)',
  'public.org_set_choice_archived(p_id uuid, p_archived boolean)', 'private.org_refuse(p_code text, p_message text, p_detail jsonb)',
  'private.org_clean_text(p_text text, p_what text)'];

async function selfChecks(db, file) {
  const out = await db.exec(sql('db/test/_prelude.sql') + '\n' + sql(file));
  const last = out.at(-1).rows[0];
  return { results: JSON.parse(last.results), passed: last.passed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) try {
  section(`replica at stage final with Stage 3b-1 (from a format ${backup.formatVersion} backup)`);
  const { db, anon } = await buildReplica(backup);
  const q = async s => (await db.query(s)).rows;
  const counts = (await q(`select (select count(*)::int from public.watchlist_items) w, (select count(*)::int from public.tv_shows) s,
    (select count(*)::int from public.personal_collections) pc, (select count(*)::int from public.collection_memberships) m,
    (select count(*)::int from public.watch_with_choices) ww`))[0];
  console.log(`  info ${JSON.stringify(counts)}`);
  ok(counts.w === backup.rowCounts.watchlist_items && counts.s === backup.rowCounts.tv_shows, 'backup loaded');
  const checkMd5 = (await q(`select md5(prosrc) h from pg_proc where oid = 'private.org_check_watch_with()'::regprocedure`))[0].h;
  console.log(`  info Stage 3b-1 org_check_watch_with prosrc md5 ${checkMd5}`);
  const catalog3b1 = JSON.parse((await q(CATALOG))[0].c);
  const contentBefore = (await q(CONTENT))[0].c;
  const fnOf = cat => new Map(cat.functions.map(x => { const i = x.indexOf(') '); return [x.slice(0, i + 1), x.slice(i + 2)]; }));

  section('migration');
  const t0 = Date.now();
  await db.exec(sql('db/phase3b2_org_write.sql'));
  ok(true, `db/phase3b2_org_write.sql committed in ${Date.now() - t0} ms`);
  ok((await q(CONTENT))[0].c === contentBefore, 'all seven tables unchanged (content without user_id and generated columns)');
  const catalog3b2 = JSON.parse((await q(CATALOG))[0].c);
  for (const k of Object.keys(catalog3b1)) if (k !== 'functions') {
    ok(JSON.stringify(catalog3b1[k]) === JSON.stringify(catalog3b2[k]), `${k} unchanged`);
  }
  const before = fnOf(catalog3b1), after = fnOf(catalog3b2);
  const added = [...after.keys()].filter(k => !before.has(k)).sort();
  const removed = [...before.keys()].filter(k => !after.has(k));
  const changed = [...before.keys()].filter(k => after.has(k) && after.get(k) !== before.get(k));
  ok(JSON.stringify(added) === JSON.stringify([...NEW_FUNCTIONS].sort()), `exactly the 11 new functions added (${added.length})`, JSON.stringify(added));
  ok(removed.length === 0, 'no function removed', JSON.stringify(removed));
  ok(JSON.stringify(changed) === JSON.stringify(['private.org_check_watch_with()']), 'only private.org_check_watch_with changed (match_tv_row, restore_backup and every other function identical)', JSON.stringify(changed));
  try { await db.exec(sql('db/phase3b2_org_write.sql')); ok(false, 'second run refused'); }
  catch (e) { ok(/already applied/.test(e.message), 'second run refused (already applied)', e.message); await db.exec('rollback').catch(() => {}); }

  section('self-checks (db/test/t_3b2_org.sql)');
  const r2 = await selfChecks(db, 'db/test/t_3b2_org.sql');
  for (const r of r2.results) ok(r.ok, r.check, r.detail);
  console.log(`  ${r2.passed} checks passed`);
  ok((await q(CONTENT))[0].c === contentBefore, 'self-checks left nothing behind');

  section('Stage 3b-1 self-checks again, with 3b-2 installed (db/test/t_3b_org.sql)');
  const r1 = await selfChecks(db, 'db/test/t_3b_org.sql');
  for (const r of r1.results) ok(r.ok, r.check, r.detail);
  console.log(`  ${r1.passed} checks passed`);
  ok((await q(CONTENT))[0].c === contentBefore, 'self-checks left nothing behind');

  section('3b-2 edits (as anon, through the new functions)');
  // The state before the edits, as a format 3 backup (pg_temp.backup_v3() was
  // defined in this session by the self-check script); restored after the
  // rollback, because both self-check scripts assume the bootstrap state.
  const preEdit = (await db.query(`select pg_temp.backup_v3() b`)).rows[0].b;
  if (exportPrePath) { fs.writeFileSync(exportPrePath, JSON.stringify(preEdit, null, 2)); console.log(`  info pre-edit state written to ${exportPrePath}`); }
  const edit = async (s, p) => (await anon(s, p))[0];
  await edit(`select public.org_create_collection('c3b2e000-0000-4000-8000-000000000001', 'ZZ Favourites')`);
  const anyOtherShow = (await q(`select id from public.tv_shows where collection = 'othertv' order by id limit 1`))[0]?.id
    || (await q(`select id from public.tv_shows order by id limit 1`))[0].id;
  const aFilm = (await q(`select id from public.watchlist_items where is_film order by id limit 1`))[0].id;
  await edit(`select public.org_add_membership('c3b2e000-0000-4000-8000-000000000001', $1, null)`, [anyOtherShow]);
  await edit(`select public.org_add_membership('c3b2e000-0000-4000-8000-000000000001', null, $1)`, [aFilm]);
  const sher = (await q(`select id, name from public.personal_collections where legacy_source = 'sheridan'`))[0];
  await edit(`select public.org_rename_collection($1, $2, 'ZZ Sheridan (renamed)')`, [sher.id, sher.name]);
  const ninety = (await q(`select id from public.personal_collections where legacy_source = '90day'`))[0].id;
  await edit(`select public.org_set_collection_archived($1, true)`, [ninety]).catch(() => {}); // already archived in an edited input
  const disneyShowMember = (await q(`select m.id, m.show_id, m.collection_id from public.collection_memberships m
    join public.personal_collections c on c.id = m.collection_id where c.legacy_source = 'disney' and m.show_id is not null order by m.id limit 1`))[0];
  if (disneyShowMember) await edit(`select public.org_remove_membership($1, $2, $3, null)`, [disneyShowMember.id, disneyShowMember.collection_id, disneyShowMember.show_id]);
  await edit(`select public.org_create_choice('e3b2e000-0000-4000-8000-000000000001', 'ZZ Grandma')`);
  await anon(`update public.watchlist_items set watch_with = array['ww:e3b2e000-0000-4000-8000-000000000001'] where id = $1`, [aFilm]);
  const rina = (await q(`select id from public.watch_with_choices where token = 'Rina'`))[0];
  if (rina) await edit(`select public.org_set_choice_archived($1, true)`, [rina.id]).catch(() => {});
  const editedContent = (await q(CONTENT))[0].c;
  ok(editedContent !== contentBefore, 'edits applied');
  if (exportPath) {
    const exported = (await db.query(`select pg_temp.backup_v3() b`)).rows[0].b;
    fs.writeFileSync(exportPath, JSON.stringify(exported, null, 2));
    console.log(`  info edited state written to ${exportPath} (${JSON.stringify(exported.rowCounts)})`);
  }

  section('rollback (db/rollback/phase3b2.sql)');
  await db.exec(sql('db/rollback/phase3b2.sql'));
  const catalogRb = JSON.parse((await q(CATALOG))[0].c);
  const diffs = Object.keys(catalog3b1).filter(k => JSON.stringify(catalog3b1[k]) !== JSON.stringify(catalogRb[k]));
  if (diffs.length) for (const k of diffs) {
    const x = new Set(catalog3b1[k] || []), y = new Set(catalogRb[k] || []);
    console.log(`       ${k}: missing ${JSON.stringify([...x].filter(v => !y.has(v)))} extra ${JSON.stringify([...y].filter(v => !x.has(v)))}`);
  }
  ok(diffs.length === 0, 'schema after rollback = Stage 3b-1 exactly (tables, columns, indexes, constraints, policies, grants, triggers, function sources)');
  ok((await q(CONTENT))[0].c === editedContent, 'every 3b-2 edit is kept (data and organization unchanged by the rollback)');
  // Without 3b-2, the 3b-1 rule applies again: an UPDATE newly adding an archived choice is accepted (enforcement gone).
  if (rina) {
    const film2 = (await q(`select id from public.watchlist_items where is_film and not ('Rina' = any(coalesce(watch_with, '{}'))) order by id limit 1`))[0].id;
    let accepted = true;
    try { await anon(`update public.watchlist_items set watch_with = array['Rina'] where id = $1`, [film2]); } catch (e) { accepted = false; }
    ok(accepted, 'after the rollback an UPDATE adding an archived choice is accepted again (documented loss of enforcement)');
    await db.query(`update public.watchlist_items set watch_with = null where id = $1`, [film2]);
  }
  try { await db.exec(sql('db/rollback/phase3b2.sql')); ok(false, 'a second rollback is refused'); }
  catch (e) { ok(/not installed/.test(e.message), 'a second rollback is refused (3b-2 not installed)', e.message); await db.exec('rollback').catch(() => {}); }
  await anon(`select public.restore_backup($1::jsonb, false)`, [preEdit]);
  ok((await q(CONTENT))[0].c === contentBefore, 'pre-edit state restored exactly (format 3 restore after the rollback)');
  const r1b = await selfChecks(db, 'db/test/t_3b_org.sql');
  ok(r1b.results.every(r => r.ok), `Stage 3b-1 self-checks pass after the rollback (${r1b.passed})`, JSON.stringify(r1b.results.filter(r => !r.ok)));

  section('migration again');
  await db.exec(sql('db/phase3b2_org_write.sql'));
  ok((await q(CATALOG))[0].c === JSON.stringify(catalog3b2) || JSON.stringify(JSON.parse((await q(CATALOG))[0].c)) === JSON.stringify(catalog3b2),
    'schema after re-applying = after the first migration');
  const r2b = await selfChecks(db, 'db/test/t_3b2_org.sql');
  ok(r2b.results.every(r => r.ok), `3b-2 self-checks pass again on the edited data (${r2b.passed})`, JSON.stringify(r2b.results.filter(r => !r.ok)));

  console.log(failed ? `\nREHEARSAL 3b-2 FAILED (${failed})` : '\nREHEARSAL 3b-2 PASSED');
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.log(`  FAIL ${e.message}${e.where ? ` (${e.where})` : ''}\nREHEARSAL 3b-2 FAILED`);
  process.exitCode = 1;
}
