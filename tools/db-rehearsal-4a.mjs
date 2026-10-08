// Local rehearsal of Stage 4a (explicit catalog application) on PGlite.
// Builds a replica at stage final with Stage 3b-1 and 3b-2 installed from a
// format 3 backup (tools/db-rehearsal-3b2.mjs buildReplica), then:
//   * applies db/phase4a_catalog.sql: data unchanged; only the expected functions
//     and the date-guard trigger added or changed; a second run is refused;
//   * runs the db/test/t_4a_catalog.sql self-checks (synthetic ZZ entries);
//   * previews every built-in catalog of config.js at the working tree: stable
//     hashes (twice, and after a restore with shuffled row order), the payload
//     hash equal to the one the app computes (catalog-apply.js), and applies
//     them with the previewed hash;
//   * rolls back with db/rollback/phase4a.sql (schema equal to before 4a exactly,
//     data unchanged, tab-open seeding and date writes accepted again), checks a
//     second rollback is refused, and applies 4a again.
// Nothing here touches Supabase. PGlite is not a repo dependency:
//   PGLITE_DIR=/path/with/node_modules node tools/db-rehearsal-4a.mjs <format3-backup.json> [--evidence <dir>]
// PGlite is one session: lock waits, catalog_busy and deadlocks between two
// sessions are not exercised here (that needs two real connections).
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const evIdx = args.indexOf('--evidence');
const evidenceDir = evIdx >= 0 ? args[evIdx + 1] : null;
const backupPath = args.find((a, i) => !a.startsWith('--') && (evIdx < 0 || i !== evIdx + 1));
if (!backupPath) { console.error('usage: node tools/db-rehearsal-4a.mjs <format3-backup.json> [--evidence <dir>]'); process.exit(2); }
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
if (backup.formatVersion !== 3) { console.error('needs a format 3 backup'); process.exit(2); }
const { buildReplica } = await import(path.join(ROOT, 'tools', 'db-rehearsal-3b2.mjs'));

const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const ok = (cond, label, detail = '') => { if (!cond) failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${detail}` : ''}`); };
const section = t => console.log(`\n[${t}]`);
const evidence = {};

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
const CONTENT = `select concat_ws('/',
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.othertv_shows t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.custom_collections t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.personal_collections t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watch_with_choices t)) c`;
const ADDED = ['private.catalog_canon(p jsonb)', 'private.catalog_date_guard()', 'private.catalog_hash(p jsonb)',
  'private.catalog_insert_missing(p_owner uuid, p_collection text, p_defaults jsonb)', 'private.catalog_run(p_collection text, p_defaults jsonb)',
  'public.catalog_apply(p_collection text, p_defaults jsonb, p_approved text)'];

// The built-in catalogs and the app's own payload hash (catalog-apply.js, as the page computes it).
const ctx = { console, crypto: crypto.webcrypto, TextEncoder };
vm.createContext(ctx);
vm.runInContext(sql('config.js') + '\nthis.COLLECTIONS = COLLECTIONS;', ctx, { filename: 'config.js' });
vm.runInContext(sql('catalog-apply.js'), ctx, { filename: 'catalog-apply.js' });
const catalogs = ctx.COLLECTIONS.filter(c => c.defaults && c.defaults.length).map(c => ({ id: c.id, defaults: JSON.parse(JSON.stringify(c.defaults)) }));

async function selfChecks(db, file) {
  const out = await db.exec(sql('db/test/_prelude.sql') + '\n' + sql(file));
  const last = out.at(-1).rows[0];
  return { results: JSON.parse(last.results), passed: last.passed };
}

try {
  section('replica at stage final with Stage 3b-1 and 3b-2');
  const { db, anon } = await buildReplica(backup);
  const q = async (s, p) => (await db.query(s, p)).rows;
  await db.exec(sql('db/phase3b2_org_write.sql'));
  const counts = (await q(`select (select count(*)::int from public.watchlist_items) w, (select count(*)::int from public.tv_shows) s,
    (select count(*)::int from public.collection_memberships) m`))[0];
  console.log(`  info ${JSON.stringify(counts)}`);
  ok(counts.w === backup.rowCounts.watchlist_items && counts.s === backup.rowCounts.tv_shows, 'backup loaded');
  const catalogPre = JSON.parse((await q(CATALOG))[0].c);
  const contentPre = (await q(CONTENT))[0].c;
  const fnOf = cat => new Map(cat.functions.map(x => { const i = x.indexOf(') '); return [x.slice(0, i + 1), x.slice(i + 2)]; }));

  section('migration (db/phase4a_catalog.sql)');
  await db.exec(sql('db/phase4a_catalog.sql'));
  ok((await q(CONTENT))[0].c === contentPre, 'all seven tables unchanged');
  const catalog4a = JSON.parse((await q(CATALOG))[0].c);
  for (const k of Object.keys(catalogPre)) if (!['functions', 'triggers'].includes(k)) ok(JSON.stringify(catalogPre[k]) === JSON.stringify(catalog4a[k]), `${k} unchanged`);
  const before = fnOf(catalogPre), after = fnOf(catalog4a);
  const added = [...after.keys()].filter(k => !before.has(k)).sort();
  const changed = [...before.keys()].filter(k => after.has(k) && after.get(k) !== before.get(k));
  const removed = [...before.keys()].filter(k => !after.has(k));
  ok(JSON.stringify(added) === JSON.stringify([...ADDED].sort()), `exactly the ${ADDED.length} new functions added`, JSON.stringify(added));
  ok(JSON.stringify(changed) === JSON.stringify(['public.seed_tv_defaults(p_collection text, p_defaults jsonb)']), 'only seed_tv_defaults changed (now a refusal)', JSON.stringify(changed));
  ok(removed.length === 0, 'no function removed');
  const trigAdded = catalog4a.triggers.filter(t => !catalogPre.triggers.includes(t));
  ok(JSON.stringify(trigAdded) === JSON.stringify(['catalog_date_guard O']) && catalog4a.triggers.length === catalogPre.triggers.length + 1, 'one trigger added (catalog_date_guard); existing triggers unchanged', JSON.stringify(trigAdded));
  try { await db.exec(sql('db/rpc.sql')); ok(false, 'rpc.sql refused on a 4a database'); }
  catch (e) { ok(/Stage 4a is installed/.test(e.message), 'rpc.sql refuses to run on a 4a database (it would restore tab-open seeding)', e.message); await db.exec('rollback').catch(() => {}); }
  ok(/catalog_apply_required/.test((await q(`select prosrc from pg_proc where oid = 'public.seed_tv_defaults(text, jsonb)'::regprocedure`))[0].prosrc), 'seed_tv_defaults still refuses after the refused rpc.sql');
  try { await db.exec(sql('db/phase4a_catalog.sql')); ok(false, 'second run refused'); }
  catch (e) { ok(/already applied/.test(e.message), 'second run refused (already applied)', e.message); await db.exec('rollback').catch(() => {}); }

  section('self-checks (db/test/t_4a_catalog.sql)');
  const r = await selfChecks(db, 'db/test/t_4a_catalog.sql');
  for (const x of r.results) ok(x.ok, x.check, x.detail);
  console.log(`  ${r.passed} checks passed`);
  ok((await q(CONTENT))[0].c === contentPre, 'self-checks left nothing behind');
  evidence.selfChecks = r;

  section('the built-in catalogs of config.js on this data');
  evidence.catalogs = {};
  for (const c of catalogs) {
    const t0 = Date.now();
    const p1 = (await anon(`select public.catalog_apply($1, $2::jsonb) r`, [c.id, JSON.stringify(c.defaults)]))[0].r;
    const ms = Date.now() - t0;
    const p2 = (await anon(`select public.catalog_apply($1, $2::jsonb) r`, [c.id, JSON.stringify(c.defaults)]))[0].r;
    const kinds = {}; for (const e of p1.document.entries) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    console.log(`  info ${c.id}: ${c.defaults.length} defaults → ${JSON.stringify(kinds)}, preview ${ms} ms, hash ${p1.hash.slice(0, 16)}`);
    ok(p1.hash === p2.hash, `${c.id}: the same preview hash twice`);
    const appHash = await ctx.catalogPayloadHash(c.defaults);
    ok(appHash === p1.document.payload_hash, `${c.id}: the app's payload hash equals the database's (${appHash.slice(0, 16)})`);
    evidence.catalogs[c.id] = { defaults: c.defaults.length, kinds, hash: p1.hash, payload_hash: p1.document.payload_hash, preview_ms: ms };
  }
  ok((await q(CONTENT))[0].c === contentPre, 'previews wrote nothing');
  // The same data restored with every table's rows in reverse order: the same hashes.
  const shuffled = JSON.parse(JSON.stringify(backup));
  for (const t of Object.keys(shuffled.tables)) shuffled.tables[t].reverse();
  await anon(`select public.restore_backup($1::jsonb, false)`, [shuffled]);
  ok((await q(CONTENT))[0].c === contentPre, 'restore of the shuffled backup gives the same content');
  for (const c of catalogs) {
    const p = (await anon(`select public.catalog_apply($1, $2::jsonb) r`, [c.id, JSON.stringify(c.defaults)]))[0].r;
    ok(p.hash === evidence.catalogs[c.id].hash, `${c.id}: the same hash after restoring shuffled rows`);
    const a = (await anon(`select public.catalog_apply($1, $2::jsonb, $3) r`, [c.id, JSON.stringify(c.defaults), p.hash]))[0].r;
    ok(a.mode === 'applied' && a.hash === p.hash, `${c.id}: applied with the previewed hash`);
  }
  ok((await q(CONTENT))[0].c === contentPre, 'applying catalogs that are already present changed nothing');

  section('rollback (db/rollback/phase4a.sql)');
  await db.exec(sql('db/rollback/phase4a.sql'));
  const catalogRb = JSON.parse((await q(CATALOG))[0].c);
  const diffs = Object.keys(catalogPre).filter(k => JSON.stringify(catalogPre[k]) !== JSON.stringify(catalogRb[k]));
  for (const k of diffs) {
    const x = new Set(catalogPre[k] || []), y = new Set(catalogRb[k] || []);
    console.log(`       ${k}: missing ${JSON.stringify([...x].filter(v => !y.has(v)))} extra ${JSON.stringify([...y].filter(v => !x.has(v)))}`);
  }
  ok(diffs.length === 0, 'schema after rollback = before Stage 4a exactly (function sources, triggers, grants, tables)');
  ok((await q(CONTENT))[0].c === contentPre, 'data unchanged by the rollback');
  // Implicit writes are accepted again (that is what the rollback re-enables), shown in a transaction that is undone.
  await db.exec('begin');
  try {
    const seeded = (await db.query(`select set_config('role', 'anon', true), public.seed_tv_defaults('sheridan',
      '[{"k":"zz rb|season 1","t":"ZZ RB","s":"Season 1","d":"Jan 1, 2020","ds":"2020-01-01"}]'::jsonb) r`)).rows[0].r;
    ok(seeded.inserted.length === 1, 'after the rollback tab-open seeding inserts again (re-enabled implicit write)');
    const row = (await db.query(`select id from public.watchlist_items where collection = 'sheridan' order by id limit 1`)).rows[0];
    await db.query(`update public.watchlist_items set display_date = 'ZZ rb', date_sort = '2099-01-01' where id = $1`, [row.id]);
    ok(true, 'after the rollback a built-in row date PATCH is accepted again (date guard gone)');
  } finally { await db.exec('rollback'); }
  ok((await q(CONTENT))[0].c === contentPre, 'those demonstration writes were undone');
  try { await db.exec(sql('db/rollback/phase4a.sql')); ok(false, 'second rollback refused'); }
  catch (e) { ok(/not installed/.test(e.message), 'second rollback refused (not installed)', e.message); await db.exec('rollback').catch(() => {}); }

  section('migration again');
  await db.exec(sql('db/phase4a_catalog.sql'));
  ok(JSON.stringify(JSON.parse((await q(CATALOG))[0].c)) === JSON.stringify(catalog4a), 'schema after re-applying = after the first migration');
  const r2 = await selfChecks(db, 'db/test/t_4a_catalog.sql');
  ok(r2.results.every(x => x.ok), `self-checks pass again (${r2.passed})`, JSON.stringify(r2.results.filter(x => !x.ok)));

  console.log(failed ? `\nREHEARSAL 4a FAILED (${failed})` : '\nREHEARSAL 4a PASSED');
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.log(`  FAIL ${e.message}${e.where ? ` (${e.where})` : ''}\nREHEARSAL 4a FAILED`);
  process.exitCode = 1;
}
if (evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'rehearsal-4a.json'), JSON.stringify({ backup: path.basename(backupPath), failed, ...evidence }, null, 1));
}
