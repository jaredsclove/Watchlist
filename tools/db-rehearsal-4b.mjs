// Local rehearsal of Stage 4b (add_tv_seasons_to_show) on PGlite.
// Builds a replica at stage final with Stage 3b-1, 3b-2 and 4a installed from a
// format 3 backup (tools/db-rehearsal-3b2.mjs buildReplica), then:
//   * applies db/phase4b_add_to_show.sql: data unchanged; exactly its two functions
//     added and nothing else changed; a second run is refused; rpc.sql still
//     refuses and seed_tv_defaults still refuses;
//   * runs the db/test/t_4b_add_to_show.sql and t_4a_catalog.sql self-checks;
//   * sends the requests the app itself composes (library.js, loaded in a vm) for
//     each kind of target on this data — an identified show outside the built-in
//     catalogs, a TMDB-matched built-in show, a legacy show — and for a new show and
//     a film typed by hand, each in a rolled-back transaction as anon, and checks
//     the answer's parent and what was stored;
//   * rolls back with db/rollback/phase4b.sql (schema = Stage 4a exactly, data
//     unchanged), checks a second rollback is refused, applies 4b again.
// It deliberately does not run the Stage 4a maintenance sequence (rollback 4a,
// rpc.sql, 4a again): that sequence has a known, separate issue (it puts back the
// pre-3b-1 three-argument match_tv_row) and is not part of Stage 4b.
// Nothing here touches Supabase. PGlite is one session: lock waits, timeouts and
// how two sessions interleave are not exercised here.
//   PGLITE_DIR=/path/with/node_modules node tools/db-rehearsal-4b.mjs <format3-backup.json> [--evidence <dir>]
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const evIdx = args.indexOf('--evidence');
const evidenceDir = evIdx >= 0 ? args[evIdx + 1] : null;
const backupPath = args.find((a, i) => !a.startsWith('--') && (evIdx < 0 || i !== evIdx + 1));
if (!backupPath) { console.error('usage: node tools/db-rehearsal-4b.mjs <format3-backup.json> [--evidence <dir>]'); process.exit(2); }
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
if (backup.formatVersion !== 3) { console.error('needs a format 3 backup'); process.exit(2); }
const { buildReplica } = await import(path.join(ROOT, 'tools', 'db-rehearsal-3b2.mjs'));

const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const ok = (cond, label, detail = '') => { if (!cond) failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${detail}` : ''}`); };
const section = t => console.log(`\n[${t}]`);
const evidence = { requests: [] };

const FUNCS = `select json_agg(x order by x)::text f from (select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' ||
  md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text, '') x from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')) s`;
const OTHER = `select json_build_object(
  'triggers', (select json_agg(tgname || ' ' || tgenabled::text order by tgname) from pg_trigger where not tgisinternal),
  'tables', (select json_agg(tablename order by tablename) from pg_tables where schemaname = 'public'),
  'indexes', (select json_agg(indexdef order by indexdef) from pg_indexes where schemaname = 'public'),
  'policies', (select json_agg(tablename || '.' || policyname order by 1) from pg_policies where schemaname = 'public'))::text c`;
const CONTENT = `select concat_ws('/',
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.othertv_shows t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.personal_collections t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'item_is_film')::text, '|' order by t.id), '')) from public.collection_memberships t),
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watch_with_choices t)) c`;
const ADDED = ['public.add_tv_seasons_to_show(p_show_id uuid, p_expected jsonb, p_seasons jsonb)', 'public.create_tv_show(p_show jsonb, p_seasons jsonb)'];

// The app's own request builders (library.js), with the helpers they use.
const ctx = { console };
vm.createContext(ctx);
for (const f of ['config.js', 'ui-helpers.js']) vm.runInContext(sql(f), ctx, { filename: f });
vm.runInContext(`const TV_COLLECTION_IDS = COLLECTIONS.filter(c => c.mediaType === 'tv').map(c => c.id);
  function isTvCollection(id) { return TV_COLLECTION_IDS.includes(id); }
  function tvShowKey(collectionId, itemKey) { const prefix = String(itemKey || '').split('|')[0]; return SHOW_KEY_OVERRIDES[collectionId + '|' + prefix] || prefix; }`, ctx);
vm.runInContext(sql('library.js'), ctx, { filename: 'library.js' });
const app = name => (...a) => JSON.parse(JSON.stringify(ctx[name](...a)));

async function selfChecks(db, file) {
  const out = await db.exec(sql('db/test/_prelude.sql') + '\n' + sql(file));
  const last = out.at(-1).rows[0];
  return { results: JSON.parse(last.results), passed: last.passed };
}

try {
  section('replica at stage final with Stage 3b-1, 3b-2 and 4a');
  const { db } = await buildReplica(backup);
  const q = async (s, p) => (await db.query(s, p)).rows;
  await db.exec(sql('db/phase3b2_org_write.sql'));
  await db.exec(sql('db/phase4a_catalog.sql'));
  const funcs4a = JSON.parse((await q(FUNCS))[0].f);
  const other4a = (await q(OTHER))[0].c;
  const contentPre = (await q(CONTENT))[0].c;

  section('migration (db/phase4b_add_to_show.sql)');
  await db.exec(sql('db/phase4b_add_to_show.sql'));
  ok((await q(CONTENT))[0].c === contentPre, 'all tables unchanged');
  const funcs4b = JSON.parse((await q(FUNCS))[0].f);
  const key = x => x.slice(0, x.indexOf(') ') + 1);
  const added = funcs4b.filter(x => !funcs4a.includes(x)).map(key), removed = funcs4a.filter(x => !funcs4b.includes(x)).map(key);
  ok(JSON.stringify(added.sort()) === JSON.stringify([...ADDED].sort()) && removed.length === 0, 'exactly the two Stage 4b functions added; no other function changed or removed', JSON.stringify({ added, removed }));
  ok((await q(OTHER))[0].c === other4a, 'triggers, tables, indexes and policies unchanged');
  try { await db.exec(sql('db/phase4b_add_to_show.sql')); ok(false, 'second run refused'); }
  catch (e) { ok(/already applied/.test(e.message), 'second run refused (already applied)', e.message); await db.exec('rollback').catch(() => {}); }
  try { await db.exec(sql('db/rpc.sql')); ok(false, 'rpc.sql refused'); }
  catch (e) { ok(/Stage 4a is installed/.test(e.message), 'rpc.sql still refuses on this database', e.message); await db.exec('rollback').catch(() => {}); }
  ok(/catalog_apply_required/.test((await q(`select prosrc from pg_proc where oid = 'public.seed_tv_defaults(text, jsonb)'::regprocedure`))[0].prosrc), 'seed_tv_defaults still refuses');

  section('self-checks');
  for (const file of ['db/test/t_4b_add_to_show.sql', 'db/test/t_4a_catalog.sql']) {
    const r = await selfChecks(db, file);
    // (One 4a check needs a TMDB-matched Disney+ show; a backup without one fails it.)
    for (const x of r.results) if (!x.ok || file.includes('4b')) ok(x.ok, `${path.basename(file)}: ${x.check}`, x.detail);
    console.log(`  ${file}: ${r.passed}`);
    evidence[path.basename(file)] = r.passed;
  }
  ok((await q(CONTENT))[0].c === contentPre, 'self-checks left nothing behind');

  section('the app’s own requests (library.js) against the real functions');
  const shows = await q(`select * from public.tv_shows order by id`);
  const rows = await q(`select * from public.watchlist_items order by id`);
  const builtin = ['disney', '90day', 'sheridan'];
  const pickKind = pred => shows.find(s => pred(s) && rows.some(r => r.show_id === s.id));
  const targets = [
    ['identified show outside the built-in catalogs', pickKind(s => s.tmdb_id != null && !builtin.includes(s.collection))],
    ['TMDB-matched built-in show', pickKind(s => s.tmdb_id != null && builtin.includes(s.collection))],
    ['legacy built-in show', pickKind(s => s.tmdb_id == null && builtin.includes(s.collection))],
    ['legacy show outside the built-in catalogs', pickKind(s => s.tmdb_id == null && !builtin.includes(s.collection))]
  ];
  // Runs fn as anon inside a transaction that is always rolled back.
  const inTx = async fn => {
    await db.exec('begin');
    try { await db.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true)`); return await fn(); }
    finally { await db.exec('rollback'); }
  };
  for (const [label, show] of targets) {
    if (!show) { console.log(`  info no ${label} in this backup; covered by the self-checks`); continue; }
    const kind = ctx.showAddKind(show);
    const stored = rows.filter(r => r.show_id === show.id);
    const network = stored[0]?.theme || '';
    const seasons = kind === 'tmdb'
      ? [app('libraryTmdbSeason')(show, { season_number: 90, air_date: null }, network)]
      : [app('libraryLabelSeason')(show, 'Season 90', 'TBA 2099', network)];
    const body = { p_show_id: show.id, p_expected: app('libraryExpected')(show, network), p_seasons: seasons };
    const res = await inTx(async () => (await db.query(`select public.add_tv_seasons_to_show($1, $2::jsonb, $3::jsonb) r`, [body.p_show_id, body.p_expected, body.p_seasons])).rows[0].r);
    const ins = res.inserted || [];
    const identityOk = show.tmdb_id != null
      ? ins.length === 1 && ins[0].tmdb_id === show.tmdb_id && ins[0].season_number === 90 && ins[0].media_type === 'tv'
      : ins.length === 1 && ins[0].tmdb_id == null && ins[0].season_number == null;
    ok(res.show_id === show.id && res.show_created === false && identityOk && ins[0]?.show_id === show.id,
      `${label} (${kind}): the season joins that show${show.tmdb_id != null ? ' as season 90 of its TMDB identity' : ' by label, no identity guessed'}`, JSON.stringify(res));
    evidence.requests.push({ label, kind, body: { ...body, p_show_id: '<id>' }, parent_ok: res.show_id === show.id, created: res.show_created, inserted: ins.length });
    if (kind === 'label' && show.tmdb_id != null) {
      const held = await inTx(async () => (await db.query(`select public.add_tv_seasons_to_show($1, $2::jsonb, $3::jsonb) r`,
        [show.id, body.p_expected, [app('libraryLabelSeason')(show, 'Season 90 (Part 1)', 'TBA 2099', network)]])).rows[0].r);
      ok((held.inserted || []).length === 0 && held.rejected?.[0]?.reason === 'enriched_show_label', `${label}: a nonstandard label is held for review`, JSON.stringify(held));
    }
  }
  // A new show (create_tv_show) and a film typed by hand, as the app composes them.
  const newShow = await inTx(async () => (await db.query(`select public.create_tv_show($1::jsonb, $2::jsonb) r`, [
    { tmdb_id: 99999001, title: 'ZZ Brand New', show_key: 'zz brand new', network: 'ZZ' },
    app('libraryNewShowSeasons')(99999001, 'ZZ Brand New', { networks: [{ name: 'ZZ' }], seasons: [{ season_number: 1, air_date: '2026-01-01' }] }, [1])])).rows[0].r);
  ok(newShow.show_created === true && newShow.inserted.length === 1 && newShow.inserted[0].season_number === 1, 'a new TMDB show: created in othertv with its identity (create_tv_show)', JSON.stringify(newShow));
  const taken = shows.find(s => s.tmdb_id != null && rows.some(r => r.show_id === s.id));
  if (taken) {
    const before = (await q(CONTENT))[0].c;
    let refusal = '';
    await inTx(async () => {
      try { await db.query(`select public.create_tv_show($1::jsonb, $2::jsonb) r`, [{ tmdb_id: taken.tmdb_id, title: taken.title, show_key: taken.show_key, network: '' },
        app('libraryNewShowSeasons')(taken.tmdb_id, taken.title, { networks: [], seasons: [{ season_number: 90, air_date: null }] }, [90])]); }
      catch (e) { refusal = e.message; }
    });
    ok(/^show_exists/.test(refusal) && (await q(CONTENT))[0].c === before, 'a "new" show whose TMDB identity is already on the list: refused, nothing changed', refusal);
  }
  const film = await inTx(async () => {
    const r = { collection: 'movies', item_key: 'zz hand film|film', title: 'ZZ Hand Film', season: 'Film', theme: 'Drama', display_date: 'Mar 3, 2021',
      date_sort: ctx.parseDate('Mar 3, 2021'), watched: false, status: 'confirmed' };
    await db.query(`insert into public.watchlist_items (collection, item_key, title, season, theme, display_date, date_sort, watched, status)
      select collection, item_key, title, season, theme, display_date, date_sort, watched, status from jsonb_populate_record(null::public.watchlist_items, $1::jsonb)`, [r]);
    return (await db.query(`select is_film, media_type, show_id from public.watchlist_items where item_key = 'zz hand film|film'`)).rows[0];
  });
  ok(film && film.is_film === true && film.show_id == null, 'a film typed by hand is a film (is_film), so All Movies lists it', JSON.stringify(film));
  ok((await q(CONTENT))[0].c === contentPre, 'those requests were rolled back');

  section('rollback (db/rollback/phase4b.sql)');
  await db.exec(sql('db/rollback/phase4b.sql'));
  ok(JSON.stringify(JSON.parse((await q(FUNCS))[0].f)) === JSON.stringify(funcs4a) && (await q(OTHER))[0].c === other4a, 'schema after rollback = Stage 4a exactly');
  ok((await q(CONTENT))[0].c === contentPre, 'data unchanged by the rollback');
  try { await db.exec(sql('db/rollback/phase4b.sql')); ok(false, 'second rollback refused'); }
  catch (e) { ok(/not installed/.test(e.message), 'second rollback refused (not installed)', e.message); await db.exec('rollback').catch(() => {}); }
  await db.exec(sql('db/phase4b_add_to_show.sql'));
  ok(JSON.stringify(JSON.parse((await q(FUNCS))[0].f)) === JSON.stringify(funcs4b), 'schema after re-applying = after the first migration');

  console.log(failed ? `\nREHEARSAL 4b FAILED (${failed})` : '\nREHEARSAL 4b PASSED');
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.log(`  FAIL ${e.message}${e.where ? ` (${e.where})` : ''}\nREHEARSAL 4b FAILED`);
  process.exitCode = 1;
}
if (evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'rehearsal-4b.json'), JSON.stringify({ backup: path.basename(backupPath), failed, ...evidence }, null, 1));
}
