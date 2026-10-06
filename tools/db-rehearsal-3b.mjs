// Local rehearsal of Stage 3b-1 (personal organization) on PGlite. Builds a
// replica at stage final from the committed db/ scripts, loads a format 2
// backup through restore_backup, then: applies db/phase3b_org.sql, runs the
// db/test/t_3b_org.sql self-checks, checks a second run is refused, rolls back
// with db/rollback/phase3b.sql (schema and data must equal the replica before
// the migration, function sources included), checks the rollback refuses after
// an organization change, and applies the migration again. Nothing here
// touches Supabase. PGlite is not a repo dependency:
//   PGLITE_DIR=/path/with/node_modules node tools/db-rehearsal-3b.mjs <format-2 backup.json>
// PGlite runs a newer Postgres than production; it is an early gate, not proof
// of Supabase's API, grants or RLS behaviour.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(process.env.PGLITE_DIR || '.', 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));
const backupPath = process.argv[2];
if (!backupPath) { console.error('usage: node tools/db-rehearsal-3b.mjs <format-2 backup.json>'); process.exit(2); }
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
if (backup.formatVersion !== 2) { console.error('needs a format 2 backup'); process.exit(2); }

const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const ok = (cond, label, detail = '') => { if (!cond) failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${detail}` : ''}`); };
const section = t => console.log(`\n[${t}]`);

export async function buildFinalReplica(snapshot) {
  const db = new PGlite();
  const anon = (s, p) => db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', '', true), set_config('role', 'anon', true)`);
    return (await tx.query(s, p)).rows;
  });
  for (const f of ['db/test/supabase_shim.sql', 'db/test/replica_schema.sql', 'db/phase0_restore_v1.sql']) await db.exec(sql(f));
  await db.exec(`set timezone = 'UTC'`);
  const v1 = { format: snapshot.format, formatVersion: 1, exportedAt: snapshot.exportedAt,
    rowCounts: { watchlist_items: snapshot.rowCounts.watchlist_items, othertv_shows: snapshot.rowCounts.othertv_shows, custom_collections: snapshot.rowCounts.custom_collections },
    tables: { watchlist_items: snapshot.tables.watchlist_items.map(({ show_id, skipped, ...r }) => r),
      othertv_shows: snapshot.tables.othertv_shows, custom_collections: snapshot.tables.custom_collections } };
  await anon(`select public.restore_backup($1::jsonb)`, [v1]);
  for (const f of ['db/phase1b_ownership.sql', 'db/restore_backup.sql', 'db/phase1c_tv_schema.sql', 'db/tv_model.sql', 'db/rpc.sql', 'db/admin/tv_enrich.sql']) {
    await db.exec(sql(f));
  }
  // The stage blocks in db/stages.sql only switch the stage; the Phase 1c backfill
  // only writes data, which the backup below replaces exactly.
  await db.exec(`update private.migration_stage set stage = 'final'`);
  await anon(`select public.restore_backup($1::jsonb, false)`, [snapshot]);
  return { db, anon };
}

// Schema state that must survive migrate → rollback unchanged.
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
  'triggers', (select json_agg(tgname order by tgname) from pg_trigger where not tgisinternal),
  'tables', (select json_agg(tablename order by tablename) from pg_tables where schemaname = 'public')
)::text c`;
const CONTENT = `select concat_ws('/',
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.othertv_shows t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.custom_collections t)) c`;
const ORG = `select (select count(*)::int from public.personal_collections) collections,
  (select count(*)::int from public.collection_memberships where show_id is not null) show_memberships,
  (select count(*)::int from public.collection_memberships where item_id is not null) film_memberships,
  (select count(*)::int from public.watch_with_choices) choices,
  (select json_object_agg(c.name, (select count(*) from public.collection_memberships m where m.collection_id = c.id)) from public.personal_collections c) per_collection,
  (select string_agg(token, ',' order by sort_order) from public.watch_with_choices) tokens`;

if (process.argv[1] === fileURLToPath(import.meta.url)) try {
  section('replica at stage final');
  const { db, anon } = await buildFinalReplica(backup);
  const q = async s => (await db.query(s)).rows;
  const counts = (await q(`select (select count(*)::int from public.watchlist_items) w, (select count(*)::int from public.tv_shows) s,
    (select count(*)::int from public.othertv_shows) o, (select count(*)::int from public.custom_collections) c`))[0];
  ok(counts.w === backup.rowCounts.watchlist_items && counts.s === backup.rowCounts.tv_shows, `backup loaded: ${JSON.stringify(counts)}`);
  const catalogBefore = (await q(CATALOG))[0].c;
  const contentBefore = (await q(CONTENT))[0].c;

  section('migration');
  const t0 = Date.now();
  await db.exec(sql('db/phase3b_org.sql'));
  ok(true, `db/phase3b_org.sql committed in ${Date.now() - t0} ms`);
  ok((await q(CONTENT))[0].c === contentBefore, 'existing rows unchanged (content without user_id / is_film)');
  const org = (await q(ORG))[0];
  console.log(`  info ${JSON.stringify(org)}`);
  try { await db.exec(sql('db/phase3b_org.sql')); ok(false, 'second run refused'); }
  catch (e) { ok(/already applied/.test(e.message), 'second run refused (already applied)', e.message); await db.exec('rollback').catch(() => {}); }

  section('self-checks (db/test/t_3b_org.sql)');
  const out = await db.exec(sql('db/test/_prelude.sql') + '\n' + sql('db/test/t_3b_org.sql'));
  const last = out.at(-1).rows[0];
  for (const r of JSON.parse(last.results)) ok(r.ok, r.check, r.detail);
  console.log(`  ${last.passed} checks passed`);
  ok((await q(CONTENT))[0].c === contentBefore && JSON.stringify((await q(ORG))[0]) === JSON.stringify(org), 'self-checks left nothing behind');

  section('rollback');
  // Each change below can't be represented by the old model, so the rollback must refuse it and change
  // nothing; the change is then undone exactly before the next case.
  const ORG_STATE = `select concat_ws('/',
    (select md5(coalesce(string_agg((to_jsonb(t))::text, '|' order by t.id), '')) from public.personal_collections t),
    (select md5(coalesce(string_agg((to_jsonb(t) - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t),
    (select md5(coalesce(string_agg((to_jsonb(t))::text, '|' order by t.id), '')) from public.watch_with_choices t)) h`;
  const orgBefore = (await q(ORG_STATE))[0].h;
  const unusedConfig = (await q(`select token from public.watch_with_choices c where c.sort_order <= 4
    and not exists (select 1 from public.watchlist_items w where c.token = any(w.watch_with)) order by sort_order limit 1`))[0]?.token;
  const saved = async (t, cols, where = 'true') => (await q(`select ${cols} from public.${t} where ${where}`));
  const reinsert = async (t, rows) => { for (const r of rows) {
    const cols = Object.keys(r);
    await db.query(`insert into public.${t} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map(c => r[c])); } };
  const MC = 'id, user_id, collection_id, show_id, item_id, created_at', PC = 'id, user_id, name, legacy_source, sort_order, archived_at, created_at',
    WC = 'id, user_id, token, label, sort_order, archived_at, created_at';
  const cases = [
    ['a removed membership', async () => { const m = await saved('collection_memberships', MC, `id = (select id from public.collection_memberships order by id limit 1)`);
      await db.query(`delete from public.collection_memberships where id = $1`, [m[0].id]); return () => reinsert('collection_memberships', m); }],
    ['a membership in another tab’s collection', async () => { await db.exec(`insert into public.collection_memberships (id, user_id, collection_id, show_id)
      select '0d000000-0000-4000-8000-0000000000aa', s.user_id, (select id from public.personal_collections where legacy_source = 'sheridan'), s.id
      from public.tv_shows s where s.collection = 'othertv' order by s.id limit 1`);
      return () => db.exec(`delete from public.collection_memberships where id = '0d000000-0000-4000-8000-0000000000aa'`); }],
    ['a renamed collection', async () => { await db.exec(`update public.personal_collections set name = 'ZZ' where legacy_source = 'disney'`);
      return () => db.exec(`update public.personal_collections set name = 'Disney+' where legacy_source = 'disney'`); }],
    ['an archived collection', async () => { await db.exec(`update public.personal_collections set archived_at = now() where legacy_source = '90day'`);
      return () => db.exec(`update public.personal_collections set archived_at = null where legacy_source = '90day'`); }],
    ['an added collection', async () => { await db.exec(`insert into public.personal_collections (id, user_id, name, sort_order)
      select '0c000000-0000-4000-8000-0000000000aa', user_id, 'ZZ Extra', 9 from public.personal_collections limit 1`);
      return () => db.exec(`delete from public.personal_collections where id = '0c000000-0000-4000-8000-0000000000aa'`); }],
    ['all of an owner’s collections removed', async () => { const m = await saved('collection_memberships', MC), c = await saved('personal_collections', PC);
      await db.exec(`delete from public.collection_memberships; delete from public.personal_collections`);
      return async () => { await reinsert('personal_collections', c); await reinsert('collection_memberships', m); }; }],
    ['reordered watch-with choices', async () => { await db.exec(`update public.watch_with_choices set sort_order = case sort_order when 1 then 2 when 2 then 1 end where sort_order in (1, 2)`);
      return () => db.exec(`update public.watch_with_choices set sort_order = case sort_order when 1 then 2 when 2 then 1 end where sort_order in (1, 2)`); }],
    ['a relabelled watch-with choice', async () => { await db.exec(`update public.watch_with_choices set label = 'ZZ Label' where sort_order = 3`);
      return () => db.exec(`update public.watch_with_choices set label = token where sort_order = 3`); }],
    ['an archived watch-with choice', async () => { await db.exec(`update public.watch_with_choices set archived_at = now() where sort_order = 4`);
      return () => db.exec(`update public.watch_with_choices set archived_at = null where sort_order = 4`); }],
    // Well ordered, plain, and given the bootstrap timestamp: only "defined but used nowhere" refuses it.
    ['an added unused choice with the bootstrap timestamp', async () => { await db.exec(`insert into public.watch_with_choices (id, user_id, token, label, sort_order, created_at)
      select '0e000000-0000-4000-8000-0000000000ab', user_id, 'ZZ Zebra', 'ZZ Zebra', (select count(*) + 1 from public.watch_with_choices), created_at
      from public.personal_collections limit 1`);
      return () => db.exec(`delete from public.watch_with_choices where id = '0e000000-0000-4000-8000-0000000000ab'`); }],
    ['a watch-with choice added later', async () => { await db.exec(`insert into public.watch_with_choices (id, user_id, token, label, sort_order)
      select '0e000000-0000-4000-8000-0000000000aa', user_id, 'ZZ Later', 'ZZ Later',
        (select count(*) + 1 from public.watch_with_choices) from public.personal_collections limit 1`);
      return () => db.exec(`delete from public.watch_with_choices where id = '0e000000-0000-4000-8000-0000000000aa'`); }],
    ['an owner with saved rows but no organization', async () => { await db.exec(`insert into public.watchlist_items
      (id, user_id, collection, item_key, title, season, date_sort, media_type, tmdb_id)
      values ('aa000000-0000-4000-8000-0000000000aa', '99999999-0000-4000-8000-000000000001', 'movies', 'zz o|film', 'ZZ O', 'Film', '2020-01-01', 'movie', 990004001)`);
      return () => db.exec(`delete from public.watchlist_items where id = 'aa000000-0000-4000-8000-0000000000aa'`); }],
    ...(unusedConfig ? [[`an unused configured choice (${unusedConfig}) deleted`, async () => { const w = await saved('watch_with_choices', WC, `token = '${unusedConfig}'`);
      await db.exec(`delete from public.watch_with_choices where token = '${unusedConfig}'`); return () => reinsert('watch_with_choices', w); }]] : [])
  ];
  for (const [label, mutate] of cases) {
    const undo = await mutate();
    let refused = false, msg = '';
    try { await db.exec(sql('db/rollback/phase3b.sql')); } catch (e) { refused = /rollback 3b refused/.test(e.message); msg = e.message; await db.exec('rollback').catch(() => {}); }
    const stillThere = !!(await q(`select to_regclass('public.personal_collections') r`))[0].r;
    await undo();
    ok(refused && stillThere && (await q(ORG_STATE))[0].h === orgBefore, `rollback refuses ${label}; nothing changed`, msg);
  }
  ok((await q(CONTENT))[0].c === contentBefore && (await q(ORG_STATE))[0].h === orgBefore, 'after the refusal cases the data and organization equal the bootstrap');
  await db.exec(sql('db/rollback/phase3b.sql'));
  const catalogAfter = (await q(CATALOG))[0].c;
  if (catalogAfter !== catalogBefore) {
    const a = JSON.parse(catalogBefore), b = JSON.parse(catalogAfter);
    for (const k of Object.keys(a)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      const x = new Set(a[k] || []), y = new Set(b[k] || []);
      console.log(`       ${k}: removed ${JSON.stringify([...x].filter(v => !y.has(v)))} added ${JSON.stringify([...y].filter(v => !x.has(v)))}`);
    }
  }
  ok(catalogAfter === catalogBefore, 'schema after rollback = before the migration (tables, columns, indexes, constraints, policies, grants, triggers, function sources)');
  ok((await q(CONTENT))[0].c === contentBefore, 'data after rollback = before the migration');
  const v2 = await anon(`select public.restore_backup($1::jsonb, false) r`, [backup]);
  ok(v2[0].r.formatVersion === 2 && (await q(CONTENT))[0].c === contentBefore, 'after rollback, the format 2 backup restores again (data unchanged)');

  section('migration again');
  await db.exec(sql('db/phase3b_org.sql'));
  const org2 = (await q(ORG))[0];
  ok(JSON.stringify(org2) === JSON.stringify(org), `the same organization is created again: ${JSON.stringify(org2)}`);

  section('future sign-in script with the new tables (rehearsal only; rolled back)');
  await db.exec(sql('db/future/auth_switchover.sql'));
  await db.transaction(async tx => {
    const u = (await tx.query(`insert into auth.users (id) values (gen_random_uuid()) returning id`)).rows[0].id;
    await tx.query(`select private.auth_move_owner($1)`, [u]);
    const left = (await tx.query(`select (select count(*) from public.watchlist_items where user_id <> $1) + (select count(*) from public.tv_shows where user_id <> $1)
      + (select count(*) from public.personal_collections where user_id <> $1) + (select count(*) from public.collection_memberships where user_id <> $1)
      + (select count(*) from public.watch_with_choices where user_id <> $1) n`, [u])).rows[0].n;
    const m = (await tx.query(`select count(*)::int n from public.collection_memberships`)).rows[0].n;
    ok(Number(left) === 0 && m === org.show_memberships + org.film_memberships, `auth_move_owner moves every table, memberships intact (${m})`);
    await tx.query(`select private.auth_lock()`);
    const pol = (await tx.query(`select count(*)::int n from pg_policies where policyname = 'owner_only'
      and tablename in ('personal_collections', 'collection_memberships', 'watch_with_choices')`)).rows[0].n;
    ok(pol === 3, 'auth_lock puts owner-only rules on the three new tables');
    await tx.rollback();
  });

  console.log(failed ? `\nREHEARSAL 3b FAILED (${failed})` : '\nREHEARSAL 3b PASSED');
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.log(`  FAIL ${e.message}${e.where ? ` (${e.where})` : ''}\nREHEARSAL 3b FAILED`);
  process.exitCode = 1;
}
