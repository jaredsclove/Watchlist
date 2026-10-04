// Local database rehearsal for the TV-show migration, on PGlite (Postgres in
// WebAssembly). Runs the repo's db/*.sql scripts in phase order against a replica
// of the production schema, loads a real backup through the restore function,
// and runs the SQL self-checks in db/test/. Nothing here touches Supabase.
//
// PGlite is not a repo dependency. Install it anywhere and point at it:
//   PGLITE_DIR=/path/with/node_modules node tools/db-rehearsal.mjs <backup.json> [--until=<step>]
// The Supabase test project, not this script, is the authoritative environment.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(process.env.PGLITE_DIR || '.', 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));

const args = process.argv.slice(2);
const backupPath = args.find(a => !a.startsWith('--'));
const until = (args.find(a => a.startsWith('--until=')) || '').slice(8) || null;
if (!backupPath) { console.error('usage: node tools/db-rehearsal.mjs <backup.json> [--until=step]'); process.exit(2); }
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

const db = new PGlite();
const sqlFile = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failures = 0;

async function exec(label, sql) {
  try { await db.exec(sql); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}\n       ${e.message}`); throw e; }
}
async function query(sql, params) { return (await db.query(sql, params)).rows; }

// Runs fn as an API role inside one transaction, the way PostgREST does.
async function asRole(role, sub, fn) {
  return db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [sub ? JSON.stringify({ sub, role }) : '']);
    await tx.query(`select set_config('role', $1, true)`, [role]);
    return fn(tx);
  });
}
async function rpc(role, sub, fn, argsObj) {
  return asRole(role, sub, async tx => {
    const names = Object.keys(argsObj);
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
    return (await tx.query(sql, names.map(n => argsObj[n]))).rows[0].r;
  });
}

const steps = [];
const step = (name, fn) => steps.push({ name, fn });
export const ctx = { db, exec, query, asRole, rpc, backup, sqlFile, step };

step('shim', () => exec('supabase shim', sqlFile('db/test/supabase_shim.sql')));
step('replica', () => exec('production replica schema', sqlFile('db/test/replica_schema.sql')));
step('phase0', () => exec('phase 0 restore_backup (v1)', sqlFile('db/phase0_restore_v1.sql')));
step('load', async () => {
  await db.exec(`set timezone = 'UTC'`);
  const r = await rpc('anon', null, 'restore_backup', { p_backup: backup });
  console.log(`  ok   loaded backup as anon via restore_backup: ${JSON.stringify(r.restored)}`);
  const [f] = await query(FINGERPRINT_SQL);
  console.log(`  info fingerprints (same SQL as the handoff, §16): ${JSON.stringify(f)}`);
  if (process.env.EXPECT_FINGERPRINT && process.env.EXPECT_FINGERPRINT !== `${f.w_h}/${f.o_h}/${f.c_h}`) {
    throw new Error(`fingerprints differ from EXPECT_FINGERPRINT`);
  }
});

// The production fingerprint query from the handoff, restricted to the columns
// that existed before the migration so it stays comparable across phases.
export const FINGERPRINT_SQL = `select
  (select count(*)::int from public.watchlist_items) w_n,
  (select md5(string_agg(row(t.id, t.collection, t.item_key, t.title, t.season, t.theme, t.display_date, t.date_sort,
     t.watched, t.status, t.created_at, t.watch_with, t.collections, t.tmdb_collection_id, t.tmdb_collection_name,
     t.media_type, t.tmdb_id, t.season_number)::text, '|' order by t.id)) from public.watchlist_items t) w_h,
  (select count(*)::int from public.othertv_shows) o_n,
  (select md5(string_agg(row(t.id, t.tmdb_id, t.title, t.network, t.created_at, t.collection)::text, '|' order by t.id))
     from public.othertv_shows t) o_h,
  (select count(*)::int from public.custom_collections) c_n,
  (select md5(string_agg(row(t.id, t.name, t.tmdb_person_id, t.created_at, t.role)::text, '|' order by t.id))
     from public.custom_collections t) c_h`;
ctx.FINGERPRINT_SQL = FINGERPRINT_SQL;

// Later phases register their steps from db/test/rehearsal-steps.mjs when present.
const extra = path.join(ROOT, 'db/test/rehearsal-steps.mjs');
if (fs.existsSync(extra)) (await import(extra)).default(ctx);

for (const s of steps) {
  console.log(`[${s.name}]`);
  try { await s.fn(); } catch (e) { if (!failures) failures++; console.log(`  FAIL ${s.name}: ${e.message}`); break; }
  if (s.name === until) break;
}
console.log(failures ? `REHEARSAL FAILED (${failures})` : 'REHEARSAL PASSED');
process.exitCode = failures ? 1 : 0;
