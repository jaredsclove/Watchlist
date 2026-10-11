// Local rehearsal of Stage 5 (db/phase5a_expand.sql, db/phase5c_contract.sql and their
// rollbacks) on PGlite, from a format 3 backup (tools/db-rehearsal-3b2.mjs buildReplica
// builds a replica at stage final with Stage 3b-1; 3b-2, 4a and 4b are installed on it):
//   5a   the expansion changes no stored value and adds exactly its objects (A2); a
//        second run is refused; db/test/t_5a_expand.sql; an old (Stage 4b) page's
//        functions still work (db/test/t_4b_add_to_show.sql) and its catalog apply
//        is refused; the app's own requests (library.js in a vm) against the real
//        functions, as anon, rolled back; db/rollback/phase5a.sql (with the G3
//        baseline) gives Stage 4b exactly, equal to the baseline, and 5a applies
//        again; it refuses a missing or wrong baseline and any difference from it
//        (catalog_apply source; missing, extra or changed functions; triggers),
//        each time leaving the complete state unchanged;
//   5c   the contraction preserves every field (by id) and turns storage into the
//        same governance and theme meaning; db/test/t_5c_contract.sql; the same
//        library calls answer alike in both phases (cross-phase equivalence);
//        a format-4 backup restores to the same contents; a format-3 file converted
//        in the page (backup-format3.js) restores, with its recovery section;
//   back db/rollback/phase5c.sql recovers storage and othertv_shows exactly from the
//        archive (the gate for dropping othertv_shows), the catalog equals Stage 5a,
//        and its report names what it discards; after writes made since the
//        contraction it resolves records without an archive entry by the documented
//        rule; it refuses (nothing changed) what Stage 5a can't represent and once the
//        archive is retired; after a converted restore it recovers that file's storage;
//   gen  the rollback's generated sections are current (tools/stage5-rollback-gen.mjs).
// Nothing here touches Supabase. PGlite is one session: lock waits, timeouts and how
// two sessions interleave are not exercised (G2); privileges are those of the replica's
// anon role (A12 is the hosted check).
// db/rollback/phase5a.sql is bound to the G3 baseline (plan §3(b)): --baseline5a names the
// exact G3 inventory file, which the rehearsal supplies the way the documented preamble does.
//   PGLITE_DIR=/path/with/node_modules node tools/db-rehearsal-5.mjs <format3-backup.json> --baseline5a <G3 inventory> [--evidence <dir>]
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const evIdx = args.indexOf('--evidence');
const evidenceDir = evIdx >= 0 ? args[evIdx + 1] : null;
const blIdx = args.indexOf('--baseline5a');
const baselinePath = blIdx >= 0 ? args[blIdx + 1] : null;
const backupPath = args.find((a, i) => !a.startsWith('--') && (evIdx < 0 || i !== evIdx + 1) && (blIdx < 0 || i !== blIdx + 1));
if (!backupPath || !baselinePath) { console.error('usage: node tools/db-rehearsal-5.mjs <format3-backup.json> --baseline5a <G3 inventory> [--evidence <dir>]'); process.exit(2); }
const baseline5a = fs.readFileSync(baselinePath, 'utf8');
const backupText = fs.readFileSync(backupPath, 'utf8');
const backup = JSON.parse(backupText);
if (backup.formatVersion !== 3) { console.error('needs a format 3 backup'); process.exit(2); }
const { buildReplica } = await import(path.join(ROOT, 'tools', 'db-rehearsal-3b2.mjs'));
const { generateSections, sectionsOf } = await import(path.join(ROOT, 'tools', 'stage5-rollback-gen.mjs'));

const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
const ok = (cond, label, detail = '') => { if (!cond) failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${String(detail).slice(0, 1500)}` : ''}`); };
const section = t => console.log(`\n[${t}]`);
const evidence = {};

// ── Catalog and content snapshots ──
const CAT = `select json_build_object(
  'indexes', (select json_agg(indexdef order by indexdef) from pg_indexes where schemaname in ('public', 'private')),
  'constraints', (select json_agg(x order by x) from (select conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid) x
    from pg_constraint where connamespace in ('public'::regnamespace, 'private'::regnamespace) and contype <> 'n') s),
  'columns', (select json_agg(x order by x) from (select table_schema || '.' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' ||
    coalesce(column_default, '') || ' ' || coalesce(generation_expression, '') x from information_schema.columns where table_schema in ('public', 'private')) s),
  'policies', (select json_agg(x order by x) from (select tablename || '.' || policyname || ' ' || cmd || ' ' || roles::text || ' ' || coalesce(qual, '') || ' ' ||
    coalesce(with_check, '') x from pg_policies where schemaname = 'public') s),
  'table_grants', (select json_agg(x order by x) from (select table_schema || '.' || table_name || ' ' || grantee || ' ' || privilege_type x
    from information_schema.role_table_grants where table_schema in ('public', 'private') and grantee in ('anon', 'authenticated', 'service_role')) s),
  'column_grants', (select json_agg(x order by x) from (select table_name || '.' || column_name || ' ' || grantee || ' ' || privilege_type x
    from information_schema.column_privileges where table_schema in ('public', 'private') and grantee in ('anon', 'authenticated', 'service_role')) s),
  'functions', (select json_agg(x order by x) from (select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' ||
    md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text, '') x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')) s),
  'triggers', (select json_agg(x order by x) from (select pg_get_triggerdef(oid) x from pg_trigger where not tgisinternal) s),
  'views', (select json_agg(x order by x) from (select viewname || ' ' || md5(definition) x from pg_views where schemaname = 'public') s),
  'rls', (select json_agg(x order by x) from (select relname || ' ' || relrowsecurity x from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r') s),
  'tables', (select json_agg(x order by x) from (select schemaname || '.' || tablename x from pg_tables where schemaname in ('public', 'private')) s)
)::text c`;
// Every row's owner (user_id), by id, in every table that has one.
const OWNED = `select json_build_object(${['watchlist_items', 'tv_shows', 'personal_collections', 'collection_memberships', 'watch_with_choices', 'custom_collections']
  .map(t => `'${t}', (select md5(coalesce(string_agg(id || ':' || coalesce(user_id::text, '-'), '|' order by id), '')) from public.${t})`).join(', ')})::text c`;
// othertv_shows' owners, by id (only where the table exists: before 5c and after its rollback).
const OTV_OWNED = `select md5(coalesce(string_agg(id || ':' || coalesce(user_id::text, '-'), '|' order by id), '')) c from public.othertv_shows`;
const hashOf = (table, minus) => `(select md5(coalesce(string_agg((to_jsonb(t) ${minus.map(m => `- '${m}'`).join(' ')})::text, '|' order by t.id), '')) from public.${table} t)`;
// Every stored field that exists in every phase (storage and the phase's own columns left out), by id.
const PRESERVED = `select json_build_object(
  'items', ${hashOf('watchlist_items', ['user_id', 'is_film', 'collection', 'theme_kind'])},
  'shows', ${hashOf('tv_shows', ['user_id', 'collection'])},
  'collections', ${hashOf('personal_collections', ['user_id', 'legacy_source', 'catalog_id', 'presentation_key'])},
  'memberships', ${hashOf('collection_memberships', ['user_id', 'item_is_film'])},
  'choices', ${hashOf('watch_with_choices', ['user_id'])},
  'custom', ${hashOf('custom_collections', ['user_id'])})::text c`;
// What governs each record and what each film's theme means (the read views, the same in both phases).
const GOVERNANCE = `select json_build_object(
  'shows', (select md5(coalesce(string_agg(show_id || ':' || catalog, '|' order by show_id), '')) from public.library_catalog_shows),
  'films', (select md5(coalesce(string_agg(item_id || ':' || catalog, '|' order by item_id), '')) from public.library_catalog_films),
  'kinds', (select md5(coalesce(string_agg(item_id || ':' || theme_kind, '|' order by item_id), '')) from public.library_film_theme_kinds),
  'collections', (select md5(coalesce(string_agg(collection_id || ':' || catalog, '|' order by collection_id), '')) from public.library_collection_catalogs),
  'counts', (select json_build_array((select count(*) from public.library_catalog_shows), (select count(*) from public.library_catalog_films),
    (select count(*) from public.library_film_theme_kinds where theme_kind = 'genre'))))::text c`;
// Storage as Stage 5a holds it (to compare a rollback with the state before contraction).
const STORAGE = `select json_build_object(
  'items', (select md5(coalesce(string_agg(id || ':' || collection, '|' order by id), '')) from public.watchlist_items),
  'shows', (select md5(coalesce(string_agg(id || ':' || collection, '|' order by id), '')) from public.tv_shows),
  'collections', (select md5(coalesce(string_agg(id || ':' || coalesce(legacy_source, '-'), '|' order by id), '')) from public.personal_collections),
  'othertv', ${hashOf('othertv_shows', ['user_id'])})::text c`; // (each replica has its own owner id)
// Every governance field, row for row (a same-format round trip must keep all of them).
const GOV_ROWS = `select json_build_object(
  'show_links', ${hashOf('catalog_show_links', ['user_id'])},
  'film_links', ${hashOf('catalog_film_links', ['user_id'])},
  'theme_kinds', (select md5(coalesce(string_agg(id || ':' || coalesce(theme_kind, '-'), '|' order by id), '')) from public.watchlist_items),
  'collections', (select md5(coalesce(string_agg(id || ':' || coalesce(catalog_id, '-') || ':' || coalesce(presentation_key, '-'), '|' order by id), '')) from public.personal_collections))::text c`;
const LINKS_JSON = `select json_build_object(
  'shows', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'show_id', show_id, 'catalog', catalog, 'origin', origin, 'created_at', created_at) order by id), '[]') from public.catalog_show_links),
  'films', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'item_id', item_id, 'catalog', catalog, 'origin', origin, 'created_at', created_at) order by id), '[]') from public.catalog_film_links))::text c`;
const one = async (db, s, p) => (await db.query(s, p)).rows[0];
const val = async (db, s) => Object.values(await one(db, s))[0];
// The rollback-5a baseline, set as the documented preamble sets it (a session setting), and the
// inventory it is compared with (the G3 capture's scope), for the rehearsal's own structural check.
const setBaseline5a = (db, text) => db.query(`select set_config('watchlist.rollback5a_baseline', $1, false)`, [text]);
const INVENTORY = `select jsonb_build_object(
  'stage', (select private.tv_stage()),
  'functions', (select jsonb_object_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
      jsonb_build_object('src', md5(pg_get_functiondef(p.oid)), 'acl', coalesce(p.proacl::text, ''), 'secdef', p.prosecdef,
        'config', coalesce(array_to_string(p.proconfig, ','), '')))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prokind = 'f' and p.proname not like 'zz\\_%'),
  'triggers', (select jsonb_object_agg(c.relname || '.' || t.tgname, t.tgenabled::text || ' ' || md5(pg_get_triggerdef(t.oid)))
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relnamespace = 'public'::regnamespace)
)::text as inventory`;

async function selfChecks(db, file) {
  const out = await db.exec(sql('db/test/_prelude.sql') + '\n' + sql(file));
  const last = out.at(-1).rows[0];
  return { results: JSON.parse(last.results), passed: last.passed };
}
// A statement as anon inside a transaction that is always rolled back.
async function asAnonRolledBack(db, fn) {
  await db.exec('begin');
  try {
    await db.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true)`);
    return await fn();
  } finally { await db.exec('rollback'); }
}
async function anonCall(db, s, p) {
  return asAnonRolledBack(db, async () => {
    try { return { ok: (await db.query(s, p)).rows[0] }; } catch (e) { return { error: e.message }; }
  });
}
async function refusedExec(db, file, pattern) {
  try { await db.exec(sql(file)); return { refused: false }; }
  catch (e) { await db.exec('rollback').catch(() => {}); return { refused: pattern.test(e.message), message: e.message }; }
}
// Explicit synthetic fixtures (fixed ids and dates, so every replica holds the same
// rows), added at Stage 4b because the retained backups lack these kinds: an
// unidentified show no catalog governs, an unidentified True Crime / Docs film (a
// company theme) and an unidentified film stored with the films (a genre theme).
const FX = {
  show: 'f5000000-0000-4000-8000-000000000001', season: 'f5000000-0000-4000-8000-000000000002',
  tcFilm: 'f5000000-0000-4000-8000-000000000003', tcMember: 'f5000000-0000-4000-8000-000000000004',
  genreFilm: 'f5000000-0000-4000-8000-000000000005'
};
async function addFixtures(db) {
  const at = '2026-10-01T00:00:00+00:00';
  await db.query(`insert into public.tv_shows (id, collection, title, show_key, status, created_at)
    values ($1, 'othertv', 'ZZ Fixture Loose', 'zz fixture loose', 'confirmed', $2)`, [FX.show, at]);
  await db.query(`insert into public.watchlist_items (id, collection, item_key, title, season, theme, display_date, date_sort, created_at, show_id)
    values ($1, 'othertv', 'zz fixture loose|season 1', 'ZZ Fixture Loose', 'Season 1', 'ZZ Net', 'Jan 1, 2020', '2020-01-01', $2, $3)`, [FX.season, at, FX.show]);
  await db.query(`insert into public.watchlist_items (id, collection, item_key, title, season, theme, display_date, date_sort, created_at)
    values ($1, 'truecrime', 'zz fixture doc|film', 'ZZ Fixture Doc', 'Film', 'ZZ Studio', 'Jan 1, 2020', '2020-01-01', $2)`, [FX.tcFilm, at]);
  // (its True Crime / Docs membership, from the Stage 3b-1 trigger, gets a fixed id too)
  await db.query(`update public.collection_memberships set id = $1, created_at = $2 where item_id = $3`, [FX.tcMember, at, FX.tcFilm]);
  await db.query(`insert into public.watchlist_items (id, collection, item_key, title, season, theme, display_date, date_sort, created_at)
    values ($1, 'movies', 'zz fixture genre film|film', 'ZZ Fixture Genre Film', 'Film', 'Drama', 'Jan 1, 2020', '2020-01-01', $2)`, [FX.genreFilm, at]);
}
async function replicaAt(phase, { fixtures = true } = {}) {
  const { db, anon } = await buildReplica(backup);
  for (const f of ['db/phase3b2_org_write.sql', 'db/phase4a_catalog.sql', 'db/phase4b_add_to_show.sql']) await db.exec(sql(f));
  if (fixtures) await addFixtures(db);
  if (phase === '4b') return { db, anon };
  await db.exec(sql('db/phase5a_expand.sql'));
  if (phase === '5a') return { db, anon };
  await db.exec(sql('db/phase5c_contract.sql'));
  return { db, anon };
}

// ── Failure injection (A2) ─────────────────────────────────────────────────────
// The complete state a failed script must leave untouched: the catalog (CAT), object
// owners and ACLs, the schemas, every row of every table in public and private (owners'
// user_id included; the archive is in private), and the write flag of the session.
const OWNERS = `select json_build_object(
  'relations', (select json_agg(x order by x) from (select n.nspname || '.' || c.relname || ' ' || c.relkind::text || ' ' || pg_get_userbyid(c.relowner) || ' ' ||
    coalesce(c.relacl::text, '') x from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private')) s),
  'functions', (select json_agg(x order by x) from (select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' ||
    pg_get_userbyid(p.proowner) || ' ' || p.prosecdef::text || ' ' || coalesce(p.proconfig::text, '') x from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')) s),
  'schemas', (select json_agg(nspname || ' ' || pg_get_userbyid(nspowner) || ' ' || coalesce(nspacl::text, '') order by nspname) from pg_namespace
    where nspname in ('public', 'private')),
  'types', (select json_agg(x order by x) from (select n.nspname || '.' || t.typname || ' ' || pg_get_userbyid(t.typowner) x from pg_type t
    join pg_namespace n on n.oid = t.typnamespace where n.nspname in ('public', 'private')) s),
  'write_flag', coalesce(current_setting('watchlist.library_write', true), '')
)::text c`;
async function fullState(db) {
  const tables = (await db.query(`select schemaname || '.' || tablename t from pg_tables where schemaname in ('public', 'private') order by 1`)).rows.map(r => r.t);
  const data = {};
  for (const t of tables) data[t] = (await one(db, `select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from ${t} x`));
  return JSON.stringify({ catalog: await val(db, CAT), owners: await val(db, OWNERS), data });
}
// The labeled points of a script: just after begin, before each section header (or, with
// statements, before every top-level statement outside a dollar-quoted body), just before commit.
function injectionPoints(file, { statements = false } = {}) {
  const lines = sql(file).split('\n');
  const begin = lines.findIndex(l => /^begin;\s*$/i.test(l)), commit = lines.findLastIndex(l => /^commit;\s*$/i.test(l));
  const pts = [{ at: begin + 1, label: 'after begin' }];
  let inBody = false, atStart = false; // atStart: the previous code line ended a statement
  lines.forEach((l, i) => {
    if (i > begin && i < commit) {
      if (!statements && /^-- ──/.test(l)) pts.push({ at: i, label: `before “${l.replace(/^-- ──\s*/, '').replace(/\s*─+\s*$/, '')}”` });
      if (statements && !inBody && atStart && /^(drop|create|notify|grant|revoke|alter|insert|update|delete|select|do|set|with|comment)\b/i.test(l)) pts.push({ at: i, label: `before line ${i + 1}: ${l.slice(0, 60)}` });
    }
    if (((l.match(/\$\$/g) || []).length) % 2) inBody = !inBody;
    const code = l.replace(/--.*$/, '').trim();
    if (i >= begin && code) atStart = !inBody && /;$/.test(code);
  });
  pts.push({ at: commit, label: 'before commit' });
  return pts.map((p, k) => {
    const tag = `injected_failure_${k}`;
    const text = [...lines.slice(0, p.at), `do $inj$ begin raise exception '${tag}'; end $inj$;`, ...lines.slice(p.at)].join('\n');
    return { ...p, tag, text };
  });
}
async function injectAll(db, file, opts) {
  const before = await fullState(db);
  const pts = injectionPoints(file, opts);
  const bad = [];
  for (const p of pts) {
    let message = null;
    try { await db.exec(p.text); } catch (e) { message = e.message; }
    await db.exec('rollback').catch(() => {});
    if (message !== p.tag) bad.push(`${p.label}: ${message === null ? 'the script completed (the point was not reached at top level)' : message}`);
    else if (await fullState(db) !== before) bad.push(`${p.label}: state changed`);
    if (bad.length) break;
  }
  return { n: pts.length, labels: pts.map(p => p.label), bad };
}

// ── The app's own code, loaded the way the page loads it ──
const app = { console, crypto: { randomUUID: () => crypto.randomUUID() } };
vm.createContext(app);
vm.runInContext('var orgEpoch = 0; var libraryGovernance = { seq: 0 }; function isFilmRow(r) { return !!r && (r.media_type === "movie" || (r.media_type == null && r.season === "Film")); } function isTvSeason(r) { return !!r && (r.media_type === "tv" || (r.media_type == null && (r.season || "") !== "Film")); }', app); // copies of browse-views.js / tv-shows.js
for (const f of ['config.js', 'ui-helpers.js', 'api.js', 'library.js', 'tmdb-match.js', 'catalog-apply.js', 'backup-restore.js', 'backup-format3.js']) vm.runInContext(sql(f), app, { filename: f });
const call = (name, ...a) => JSON.parse(JSON.stringify(app[name](...a)));
// The governance a library read publishes in the page (readGovernance + governanceCovers), from the read views.
async function publishGovernance(db) {
  const rows = async v => (await db.query(`select * from public.${v}`)).rows;
  const [shows, films, kinds] = [await rows('library_catalog_shows'), await rows('library_catalog_films'), await rows('library_film_theme_kinds')];
  const all = await rows('watchlist_items'), allShows = await rows('tv_shows');
  vm.runInContext('libraryGovernance = { seq: 0 };', app);
  const gov = { shows: new Map(shows.map(x => [x.show_id, x.catalog])), films: new Map(films.map(x => [x.item_id, x.catalog])),
    kinds: new Map(kinds.map(x => [x.item_id, x.theme_kind])), knownShows: new Set(), knownItems: new Set(), seq: 1, epoch: 0 };
  app.governanceCovers(gov, all, allShows);
  if (!app.publishGovernance(gov)) throw new Error('governance not published');
  return { rows: all, shows: allShows };
}
// A1 / A10: the editing policy, Match eligibility and film theme meaning of every row,
// as the page computes them from governance (editPolicyOf, isTmdbMatchEligible,
// filmThemeKindOf) — compared with the Stage 4b storage rule computed on the 4b replica.
async function policies(db) {
  const { rows } = await publishGovernance(db);
  return new Map(rows.map(r => [r.id, JSON.stringify({ effect: app.editPolicyOf(r).deleteEffect, match: app.isTmdbMatchEligible(r),
    genre: app.isFilmRow(r) ? app.filmThemeKindOf(r) === 'genre' : null })]));
}
async function policies4b(db) {
  const rows = (await db.query(`select * from public.watchlist_items`)).rows;
  const shows = new Map((await db.query(`select * from public.tv_shows`)).rows.map(x => [x.id, x]));
  const CAT = ['disney', '90day', 'sheridan'];
  return new Map(rows.map(r => {
    const place = r.show_id ? (shows.get(r.show_id) || {}).collection : r.collection;
    const governed = CAT.includes(place);
    const entry = governed && app.catalogDefaultsOf(place).some(d => d.k === r.item_key);
    const film = app.isFilmRow(r);
    return [r.id, JSON.stringify({ effect: entry ? (film ? 'skip-film' : 'skip') : 'delete',
      match: r.tmdb_id == null && r.media_type == null && r.season_number == null && !governed, genre: film ? r.collection === 'movies' : null })];
  }));
}
const mapsEqual = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
const mapDiff = (a, b) => [...a].filter(([k, v]) => b.get(k) !== v).slice(0, 5).map(([k, v]) => `${k}: ${v} vs ${b.get(k)}`).join('; ');
// The same library calls the page sends, for each kind of target this backup has. Answers
// are normalized (ids, owner and phase-only columns removed) to compare the two phases.
async function libraryCalls(db) {
  await publishGovernance(db);
  // (the fixture's unidentified ungoverned show covers that kind wherever a backup has none)
  const shows = (await db.query(`select * from public.tv_shows order by id`)).rows;
  const rows = (await db.query(`select * from public.watchlist_items order by id`)).rows;
  const gov = app.libraryGovernance;
  const pick = pred => shows.find(s => pred(s) && rows.some(r => r.show_id === s.id));
  const targets = [
    ['identified show no catalog governs', pick(s => s.tmdb_id != null && !gov.shows.get(s.id))],
    ['TMDB-matched show a catalog governs', pick(s => s.tmdb_id != null && gov.shows.get(s.id))],
    ['unidentified show a catalog governs', pick(s => s.tmdb_id == null && gov.shows.get(s.id))],
    ['unidentified show no catalog governs', pick(s => s.tmdb_id == null && !gov.shows.get(s.id))]
  ];
  const out = [];
  // (is_film is a generated column, the same in both phases' rows; the 5c answers leave it out.)
  const norm = v => JSON.parse(JSON.stringify(v, (k, x) => (['id', 'user_id', 'show_id', 'created_at', 'collection', 'theme_kind', 'former_show_id', 'is_film'].includes(k) ? undefined : x)));
  for (const [label, show] of targets) {
    if (!show) { out.push({ label, skipped: 'none in this backup or the fixtures' }); continue; }
    const kind = call('showAddKind', show);
    const network = rows.find(r => r.show_id === show.id)?.theme || '';
    const seasons = kind === 'tmdb' ? [call('libraryTmdbSeason', show, { season_number: 90, air_date: null }, network)]
      : [call('libraryLabelSeason', show, 'Season 90', 'TBA 2099', network)];
    const res = await anonCall(db, `select public.library_add_seasons($1, $2::jsonb, $3::jsonb) r`, [show.id, call('libraryExpected', show, network), seasons]);
    out.push({ label, kind, parentOk: res.ok ? res.ok.r.show_id === show.id && !res.ok.r.show_created : false, answer: norm(res.ok ? res.ok.r : res) });
  }
  const tmdbShow = { networks: [{ name: 'ZZ' }], seasons: [{ season_number: 1, air_date: '2026-01-01' }, { season_number: 2, air_date: null }] };
  for (const [label, s, p] of [
    ['a new TMDB show', `select public.library_create_show($1::jsonb, $2::jsonb) r`, [{ tmdb_id: 99999001, title: 'ZZ Brand New', show_key: 'zz brand new', network: 'ZZ' },
      call('libraryNewShowSeasons', 99999001, 'ZZ Brand New', tmdbShow, [1, 2])]],
    ['a new show by hand', `select public.library_create_show($1::jsonb, $2::jsonb) r`, [{ tmdb_id: null, title: 'ZZ By Hand', show_key: 'zz by hand', network: 'ZZ', distinct_from: [] },
      [call('libraryLabelSeason', { show_key: 'zz by hand', title: 'ZZ By Hand' }, 'Season 1', 'Jan 5, 2023', 'ZZ')]]],
    ['a TMDB film', `select public.library_add_films($1::jsonb) r`, [[call('libraryFilmFromTmdb', 99999002, 'ZZ Film', { genres: [{ name: 'Drama' }], release_date: '2020-02-02' })]]],
    ['a film by hand', `select public.library_create_film($1::jsonb) r`, [{ item_key: 'zz hand film|film', title: 'ZZ Hand Film', season: 'Film', theme: 'Drama',
      display_date: 'Mar 3, 2021', date_sort: app.parseDate('Mar 3, 2021'), watched: false, status: 'confirmed', distinct_from: [] }]]
  ]) {
    const res = await anonCall(db, s, p);
    out.push({ label, answer: norm(res.ok ? res.ok.r : res) });
  }
  return out;
}

try {
  // ═══ 5a ═══
  section('replica at stage final with Stages 3b-1, 3b-2, 4a and 4b');
  const A = await replicaAt('4b');
  const cat4b = await val(A.db, CAT);
  const preserved0 = await val(A.db, PRESERVED);
  const storage0 = await val(A.db, STORAGE);
  const pol4b = await policies4b(A.db);
  console.log('  info synthetic fixtures added (fixed ids): an unidentified ungoverned show, a True Crime / Docs film (company theme), a film stored with the films (genre theme)');

  section('expansion (db/phase5a_expand.sql)');
  await A.db.exec(sql('db/phase5a_expand.sql'));
  ok(await val(A.db, PRESERVED) === preserved0 && await val(A.db, STORAGE) === storage0, 'no stored value changed (every field of every record, by id; storage; othertv_shows)');
  const c4 = JSON.parse(cat4b), c5a = JSON.parse(await val(A.db, CAT));
  const diff = k => ({ added: (c5a[k] || []).filter(x => !(c4[k] || []).includes(x)), removed: (c4[k] || []).filter(x => !(c5a[k] || []).includes(x)) });
  const fnKey = x => x.slice(0, x.indexOf(') ') + 1);
  const fd = diff('functions');
  const changedFns = fd.removed.map(fnKey);
  ok(JSON.stringify(changedFns) === JSON.stringify(['public.catalog_apply(p_collection text, p_defaults jsonb, p_approved text)']),
    'the only existing function replaced is catalog_apply (its apply step now refuses); none removed', JSON.stringify(changedFns));
  ok(fd.added.map(fnKey).every(x => /^public\.(library_|stage5_capabilities|catalog_apply\()|^private\.(lib_|catalog_run5\()/.test(x)), 'every added function is a Stage 5 one (library_*, stage5_capabilities, private lib_*)',
    JSON.stringify(fd.added.map(fnKey).filter(x => !/^public\.(library_|stage5_capabilities|catalog_apply\()|^private\.(lib_|catalog_run5\()/.test(x))));
  const id = diff('indexes');
  ok(id.removed.length === 0 && id.added.length === 4 && id.added.every(x => /library_identity_key|library_movie_key|library_tv_key|show_item_key/.test(x)), 'exactly the four identity indexes added; none removed', JSON.stringify(id));
  ok(JSON.stringify(diff('views').added.map(v => v.split(' ')[0])) === JSON.stringify(['library_catalog_films', 'library_catalog_shows', 'library_collection_catalogs',
    'library_collection_presentation', 'library_film_theme_kinds']), 'exactly the five read views added');
  for (const k of ['constraints', 'columns', 'policies', 'table_grants', 'column_grants', 'triggers', 'rls', 'tables']) {
    const d = diff(k);
    const viewsOwn = ['columns', 'table_grants', 'column_grants'].includes(k);
    const allowed = viewsOwn ? d.added.every(x => /library_/.test(x)) && d.removed.length === 0 : d.added.length === 0 && d.removed.length === 0;
    ok(allowed, `${k}: unchanged${viewsOwn ? ' (apart from the views’ own)' : ''}`, JSON.stringify(d).slice(0, 600));
  }
  const second = await refusedExec(A.db, 'db/phase5a_expand.sql', /already applied|phase5a/);
  ok(second.refused, 'a second run is refused', second.message);
  const pol5a = await policies(A.db);
  ok(mapsEqual(pol4b, pol5a), `A1/A10: for every one of ${pol4b.size} rows, the page's policy (Skip / Delete), Match eligibility and film theme meaning from governance equal the Stage 4b storage rule`, mapDiff(pol4b, pol5a));
  const cat5a = await val(A.db, CAT);

  section('self-checks on 5a');
  for (const file of ['db/test/t_5a_expand.sql', 'db/test/t_4b_add_to_show.sql']) {
    const r = await selfChecks(A.db, file);
    for (const x of r.results) ok(x.ok, `${path.basename(file)}: ${x.check}`, x.detail);
    console.log(`  ${file}: ${r.passed}`);
    evidence[path.basename(file)] = r.passed;
  }
  ok(await val(A.db, PRESERVED) === preserved0, 'the self-checks left nothing behind');

  section('the app’s own requests (library.js) against the 5a functions, as anon, rolled back');
  const calls5a = await libraryCalls(A.db);
  for (const c of calls5a) {
    if (c.skipped) { console.log(`  info ${c.label}: ${c.skipped}`); continue; }
    ok(!c.answer.error && (c.parentOk === undefined || c.parentOk), `${c.label}${c.kind ? ` (${c.kind})` : ''}: accepted${c.parentOk ? ', joined that show' : ''}`, JSON.stringify(c.answer));
  }
  evidence.calls5a = calls5a;
  ok(await val(A.db, PRESERVED) === preserved0, 'those requests were rolled back');

  section('rollback of 5a (db/rollback/phase5a.sql)');
  await setBaseline5a(A.db, baseline5a);
  await A.db.exec(sql('db/rollback/phase5a.sql'));
  ok(await val(A.db, CAT) === cat4b, 'the catalog after the rollback = Stage 4b exactly (functions with their definitions and grants, indexes, views, triggers, grants)');
  ok(await val(A.db, PRESERVED) === preserved0 && await val(A.db, STORAGE) === storage0, 'data unchanged by the rollback');
  ok((await one(A.db, `select (${INVENTORY.replace(/::text as inventory$/, '')}) = $1::jsonb eq`, [baseline5a])).eq === true,
    'the restored inventory equals the G3 baseline structurally (every function with source md5, grants, security mode and configuration; triggers; stage)');
  ok(await val(A.db, `select current_setting('watchlist.rollback5a_baseline', true) v`) === '', 'the rollback cleared the baseline setting on success');
  await A.db.exec(sql('db/phase5a_expand.sql'));
  ok(await val(A.db, CAT) === cat5a, 'applying 5a again gives the same catalog');
  await A.db.close();

  section('rollback of 5a bound to the G3 baseline (plan §3(b)): each refusal leaves the complete state unchanged');
  {
    const rb = sql('db/rollback/phase5a.sql');
    evidence.bind5a = [];
    const attempt = async (label, { baseline = baseline5a, setup = null, text = rb, expect }) => {
      const R = await replicaAt('5a');
      if (setup) {
        const inv0 = await val(R.db, INVENTORY);
        await R.db.exec(setup);
        ok(await val(R.db, INVENTORY) !== inv0, `${label}: the set-up changed the inventory`);
      }
      if (baseline !== null) await setBaseline5a(R.db, baseline);
      const before = await fullState(R.db);
      let message = null;
      try { await R.db.exec(text); } catch (e) { message = e.message; }
      await R.db.exec('rollback').catch(() => {});
      const unchanged = await fullState(R.db) === before;
      const phase = await val(R.db, `select public.stage5_capabilities() ->> 'phase' p`).catch(e => e.message);
      ok(message !== null && expect.test(message) && unchanged && phase === 'coexistence', `${label}: refused, complete state unchanged, still coexistence`,
        `${message === null ? 'the rollback completed' : message} | unchanged ${unchanged} | phase ${phase}`);
      evidence.bind5a.push({ label, message, unchanged, phase });
      await R.db.close();
    };
    const probe = 'private.tv_stage()';
    await attempt('baseline missing (no setting)', { baseline: null, expect: /baseline missing/ });
    await attempt('baseline empty', { baseline: '', expect: /baseline missing/ });
    await attempt('baseline invalid (one byte changed)', { baseline: baseline5a.replace('"stage": "final"', '"stage": "finaL"'), expect: /baseline invalid: it is not the exact G3/ });
    {
      const R = await replicaAt('5a');
      const coexist = await val(R.db, INVENTORY);
      await R.db.close();
      await attempt('baseline invalid (valid inventory JSON that isn’t G3: the coexistence inventory)', { baseline: coexist, expect: /baseline invalid: it is not the exact G3/ });
    }
    const variant = rb.replace('Review again in a moment.', 'Review again in a moment!');
    ok(variant !== rb && variant.split('Review again in a moment!').length === 2, 'test copy: one character changed in the reinstalled catalog_apply body only');
    await attempt('catalog_apply source mismatch (test copy of the rollback)', { text: variant, expect: /restored catalog_apply source \(md5 [0-9a-f]{32}\) is not G3/ });
    await attempt('catalog_apply grants changed (EXECUTE revoked from authenticated)', { setup: 'revoke execute on function public.catalog_apply(text, jsonb, text) from authenticated;',
      expect: /changed \[public\.catalog_apply\(p_collection text, p_defaults jsonb, p_approved text\) \(acl\)\]/ });
    await attempt('missing function (create_tv_show dropped)', { setup: 'drop function public.create_tv_show(jsonb, jsonb);', expect: /missing \[public\.create_tv_show\(p_show jsonb, p_seasons jsonb\)\]/ });
    await attempt('extra function (private.g3_probe_extra)', { setup: `create function private.g3_probe_extra() returns int language sql as 'select 1';`, expect: /extra \[private\.g3_probe_extra\(\)\]/ });
    {
      const R = await replicaAt('5a');
      const def = await val(R.db, `select pg_get_functiondef('${probe}'::regprocedure) d`);
      await R.db.close();
      ok(def.includes('$function$'), `${probe} has a dollar-quoted body to change`);
      await attempt(`changed source (${probe} recreated with a comment)`, { setup: def.replace('$function$', '$function$\n-- g3 probe\n') + ';', expect: /changed \[private\.tv_stage\(\) \(src\)\]/ });
    }
    await attempt(`changed security mode (${probe}, security definer in G3, made security invoker)`, { setup: `alter function ${probe} security invoker;`, expect: /changed \[private\.tv_stage\(\) \(secdef,src\)\]/ });
    await attempt(`changed configuration (${probe} search_path)`, { setup: `alter function ${probe} set search_path = public;`, expect: /changed \[private\.tv_stage\(\) \(config,src\)\]/ });
    await attempt('changed trigger (catalog_date_guard disabled)', { setup: 'alter table public.watchlist_items disable trigger catalog_date_guard;', expect: /triggers \[watchlist_items\.catalog_date_guard\]/ });
  }

  // ═══ 5c ═══
  section('contraction (db/phase5c_contract.sql)');
  const C = await replicaAt('5a');
  const gov5a = await val(C.db, GOVERNANCE);
  const calls5aAgain = await libraryCalls(C.db);
  await C.db.exec(sql('db/phase5c_contract.sql'));
  ok(await val(C.db, PRESERVED) === preserved0, 'every preserved field of every record, show, collection, membership, choice and person collection is unchanged, by id');
  ok(await val(C.db, GOVERNANCE) === gov5a, 'governance, theme meaning and collection catalogs equal what storage said (the same read views, both phases)', `${gov5a} vs ${await val(C.db, GOVERNANCE)}`);
  const counts = await one(C.db, `select (select count(*) from public.catalog_show_links) sl, (select count(*) from public.catalog_film_links) fl,
    (select count(*) from private.stage5_recovery_records) ar, (select count(*) from private.stage5_recovery_othertv) ot`);
  console.log(`  info links ${counts.sl} shows / ${counts.fl} films; archive ${counts.ar} records, ${counts.ot} othertv_shows rows`);
  evidence.contraction = counts;
  const pol5c = await policies(C.db);
  ok(mapsEqual(pol4b, pol5c), 'A1/A10 after contraction: policy, Match eligibility and theme meaning of every row still equal the Stage 4b rule', mapDiff(pol4b, pol5c));
  const second5c = await refusedExec(C.db, 'db/phase5c_contract.sql', /already applied|phase5c/);
  ok(second5c.refused, 'a second run is refused', second5c.message);
  const rpcRefused = await refusedExec(C.db, 'db/rpc.sql', /.+/);
  ok(rpcRefused.refused, 'db/rpc.sql refuses on a contracted database', rpcRefused.message);

  section('self-checks on 5c');
  const r5c = await selfChecks(C.db, 'db/test/t_5c_contract.sql');
  for (const x of r5c.results) ok(x.ok, `t_5c_contract.sql: ${x.check}`, x.detail);
  console.log(`  db/test/t_5c_contract.sql: ${r5c.passed}`);
  evidence['t_5c_contract.sql'] = r5c.passed;
  ok(await val(C.db, PRESERVED) === preserved0, 'the self-checks left nothing behind');

  section('cross-phase equivalence: the same library calls answer alike in 5a and 5c');
  const calls5c = await libraryCalls(C.db);
  for (let i = 0; i < calls5aAgain.length; i++) {
    const a = calls5aAgain[i], b = calls5c[i];
    if (a.skipped) continue;
    ok(JSON.stringify(a.answer) === JSON.stringify(b.answer), `${a.label}: same answer`, `${JSON.stringify(a.answer)}\n       vs ${JSON.stringify(b.answer)}`);
  }
  evidence.calls5c = calls5c;

  section('format 4 backup and restore (backup-restore.js spec), as anon');
  const spec4 = app.backupSpec(4);
  const tables = {};
  for (const t of spec4.tables) {
    // As PostgREST returns them (exact text for dates and timestamps).
    const cols = Object.keys(spec4.columns[t]);
    tables[t] = JSON.parse((await one(C.db, `select coalesce(json_agg(x order by x.id), '[]')::text j from (select ${cols.map(c => `"${c}"`).join(', ')} from public.${t}) x`)).j);
  }
  const doc4 = { format: 'watchlist-tracker-backup', formatVersion: 4, exportedAt: new Date().toISOString(),
    rowCounts: Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length])), tables };
  const docErrors = Array.from(app.validateBackupObject(doc4));
  ok(docErrors.length === 0, 'the format-4 backup validates with the page’s own rules', docErrors.join('\n'));
  const before4 = await val(C.db, PRESERVED), gov4 = await val(C.db, GOVERNANCE), rows4 = await val(C.db, GOV_ROWS);
  const restored = await C.anon(`select public.restore_backup($1::jsonb) r`, [doc4]).then(r => r[0].r, e => ({ error: e.message }));
  ok(!restored.error, 'restore_backup accepts it', JSON.stringify(restored));
  ok(await val(C.db, PRESERVED) === before4 && await val(C.db, GOVERNANCE) === gov4, 'the restore gives the same contents and governance');
  ok(await val(C.db, GOV_ROWS) === rows4, 'every governance field is kept row for row: link ids, catalog, entry keys, origin, created_at; theme_kind; catalog_id and presentation_key');
  await C.db.close();

  // ═══ Rollback of 5c: exact recovery ═══
  section('rollback of 5c right after the contraction: exact recovery from the archive (the gate for dropping othertv_shows)');
  const R = await replicaAt('5a');
  const cat5aR = await val(R.db, CAT);
  // Writes during coexistence first (a Stage 5 page's and an old page's), so storage differs from the backup's.
  await R.db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true)`);
    await tx.query(`select public.library_create_show('{"title":"ZZ Coexist Show","show_key":"zz coexist show"}'::jsonb,
      '[{"item_key":"zz coexist show|season 1","title":"ZZ Coexist Show","season":"Season 1","date_sort":"2020-01-01"}]'::jsonb)`);
    await tx.query(`select public.add_tv_seasons('truecrime', '{"title":"ZZ Old Page Doc Series","show_key":"zz old page doc series"}'::jsonb,
      '[{"item_key":"zz old page doc series|season 1","title":"ZZ Old Page Doc Series","season":"Season 1","date_sort":"2020-01-01"}]'::jsonb)`);
    await tx.query(`select public.library_add_films('[{"tmdb_id":99997001,"title":"ZZ Coexist Film","item_key":"zz coexist film|film","date_sort":"2020-01-01","theme":"Drama"}]'::jsonb)`);
  });
  const storageW = await val(R.db, STORAGE), preservedW = await val(R.db, PRESERVED), govW = await val(R.db, GOVERNANCE), ownedW = await val(R.db, OWNED), otvOwnedW = await val(R.db, OTV_OWNED);
  await R.db.exec(sql('db/phase5c_contract.sql'));
  const linksBefore = JSON.parse(await val(R.db, LINKS_JSON));
  const rb = await R.db.exec(sql('db/rollback/phase5c.sql'));
  const report = rb.at(-1).rows[0].report;
  if (await val(R.db, STORAGE) !== storageW) console.log(`  info storage before ${storageW}\n       after  ${await val(R.db, STORAGE)}`);
  ok(await val(R.db, STORAGE) === storageW, 'after coexistence writes (Stage 5 page and old page): storage of every record and collection, and othertv_shows row for row, are exactly as before the contraction');
  ok(await val(R.db, PRESERVED) === preservedW, 'every preserved field unchanged');
  ok(await val(R.db, OWNED) === ownedW && await val(R.db, OTV_OWNED) === otvOwnedW, 'every row’s owner (user_id, by id) unchanged, othertv_shows included');
  ok(JSON.stringify(report.discarded_show_links) === JSON.stringify(linksBefore.shows) && JSON.stringify(report.discarded_film_links) === JSON.stringify(linksBefore.films),
    `the report lists every discarded link exactly (id, record, catalog, origin, created_at): ${linksBefore.shows.length} show links, ${linksBefore.films.length} film links`);
  const catR = JSON.parse(await val(R.db, CAT)), catA = JSON.parse(cat5aR);
  const catDiff = Object.keys(catA).filter(k => JSON.stringify(catA[k]) !== JSON.stringify(catR[k]));
  ok(catDiff.length === 0, 'the catalog equals Stage 5a (functions, triggers, views, indexes, constraints, columns, grants, policies, row security)',
    catDiff.map(k => `${k}: only 5a ${JSON.stringify((catA[k] || []).filter(x => !(catR[k] || []).includes(x)).slice(0, 4))} only after ${JSON.stringify((catR[k] || []).filter(x => !(catA[k] || []).includes(x)).slice(0, 4))}`).join('\n'));
  ok(report.records_by_rule === 0 && report.collections_without_archive_entry === 0 && report.discarded_show_links.length === linksBefore.shows.length,
    'its report: every record from the archive; the governance links it discards (ids, origin, created_at) are listed', JSON.stringify({ ...report, discarded_show_links: report.discarded_show_links.length, discarded_film_links: report.discarded_film_links.length }));
  evidence.rollback = { records_from_archive: report.records_from_archive, discarded_show_links: report.discarded_show_links.length, discarded_film_links: report.discarded_film_links.length };
  const again = await refusedExec(R.db, 'db/rollback/phase5c.sql', /not contracted/);
  ok(again.refused, 'a second rollback is refused', again.message);
  await R.db.exec(sql('db/phase5c_contract.sql'));
  ok(await val(R.db, GOVERNANCE) === govW, 'contracting again gives the same governance (as read in 5a after those writes)');
  await R.db.close();

  section('a format-3 restore during coexistence that changes ids and storage, then contraction and recovery');
  {
    const doc = structuredClone(backup), t = doc.tables;
    const swap = (from, to) => {
      for (const r of t.watchlist_items) { if (r.id === from) r.id = to; if (r.show_id === from) r.show_id = to; }
      for (const r of t.tv_shows) if (r.id === from) r.id = to;
      for (const m of t.collection_memberships) { if (m.item_id === from) m.item_id = to; if (m.show_id === from) m.show_id = to; }
    };
    const others = t.tv_shows.filter(x => x.collection === 'othertv' && x.tmdb_id != null).sort((a, b) => a.id.localeCompare(b.id));
    const reShow = others[0], moveShow = others[1];
    const reFilm = t.watchlist_items.filter(r => r.season === 'Film' && r.collection === 'movies').sort((a, b) => a.id.localeCompare(b.id))[0];
    const tcFilm = t.watchlist_items.filter(r => r.season === 'Film' && r.collection === 'truecrime').sort((a, b) => a.id.localeCompare(b.id))[0];
    const NEW = { show: 'f5000000-0000-4000-8000-0000000000c1', film: 'f5000000-0000-4000-8000-0000000000c2' };
    swap(reShow.id, NEW.show); swap(reFilm.id, NEW.film);
    tcFilm.collection = 'othertv';                                                        // a True Crime / Docs film stored with Other TV
    moveShow.collection = 'truecrime';                                                    // an Other TV show (and its seasons) stored with True Crime / Docs
    for (const r of t.watchlist_items) if (r.show_id === moveShow.id) r.collection = 'truecrime';
    const otv = t.othertv_shows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    otv.network = 'ZZ Network (changed by the restore)';
    const Q = await replicaAt('5a');
    const res = await Q.anon(`select public.restore_backup($1::jsonb) r`, [doc]).then(r => r[0].r, e => ({ error: e.message }));
    ok(!res.error, 'Stage 5a’s restore_backup (format 3) accepts the changed file', JSON.stringify(res));
    const where = async (table, id) => val(Q.db, `select collection from public.${table} where id = '${id}'`);
    ok(await where('tv_shows', NEW.show) === 'othertv' && await where('watchlist_items', NEW.film) === 'movies'
      && await where('watchlist_items', tcFilm.id) === 'othertv' && await where('tv_shows', moveShow.id) === 'truecrime',
      'restored: the new ids and the changed storage are what the file says');
    const storageQ = await val(Q.db, STORAGE), preservedQ = await val(Q.db, PRESERVED), govQ = await val(Q.db, GOVERNANCE), ownersQ = await val(Q.db, OWNED), otvOwnersQ = await val(Q.db, OTV_OWNED);
    await Q.db.exec(sql('db/phase5c_contract.sql'));
    ok(await val(Q.db, GOVERNANCE) === govQ && await val(Q.db, PRESERVED) === preservedQ && await val(Q.db, OWNED) === ownersQ,
      'contracted: governance, theme meaning, every preserved field and every row’s owner equal the restored state');
    ok(await val(Q.db, `select theme_kind from public.watchlist_items where id = '${tcFilm.id}'`) === 'other'
      && await val(Q.db, `select theme_kind from public.watchlist_items where id = '${NEW.film}'`) === 'genre',
      'theme meaning follows the restored storage (the moved True Crime film: other; the re-identified film: genre)');
    const rbQ = await Q.db.exec(sql('db/rollback/phase5c.sql'));
    ok(await val(Q.db, STORAGE) === storageQ, 'rolled back: storage and othertv_shows (the changed row included) are exactly the restored file’s, by the new ids');
    ok(await val(Q.db, PRESERVED) === preservedQ && await val(Q.db, OWNED) === ownersQ && await val(Q.db, OTV_OWNED) === otvOwnersQ, 'every preserved field and every row’s owner (othertv_shows included) unchanged');
    ok(await val(Q.db, `select network from public.othertv_shows where id = '${otv.id}'`) === otv.network, 'the othertv_shows row the file changed is back as the file has it');
    ok(rbQ.at(-1).rows[0].report.records_by_rule === 0, 'every record came from the archive (none by rule)');
    await Q.db.close();
  }

  section('rollback after writes made since the contraction: records without an archive entry follow the documented rule; the report says so');
  const W = await replicaAt('5c');
  const writes = await W.db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true)`);
    const show = (await tx.query(`select public.library_create_show('{"tmdb_id":99998001,"title":"ZZ Post Show","show_key":"zz post show"}'::jsonb,
      '[{"item_key":"zz post show|season 1","title":"ZZ Post Show","season":"Season 1","date_sort":"2020-01-01","season_number":1}]'::jsonb) r`)).rows[0].r;
    const film = (await tx.query(`select public.library_add_films('[{"tmdb_id":99998002,"title":"ZZ Post Film","item_key":"zz post film|film","date_sort":"2020-01-01","theme":"Drama"}]'::jsonb) r`)).rows[0].r;
    const defs = [{ k: 'zz post cat|season 1', t: 'ZZ Post Cat', s: 'Season 1', d: 'Jan 1, 2020', ds: '2020-01-01' }, { k: 'zz post cat film|film', t: 'ZZ Post Cat Film', s: 'Film', d: 'Jan 1, 2020', ds: '2020-01-01' }];
    const p = (await tx.query(`select public.library_catalog_apply('sheridan', $1::jsonb) r`, [defs])).rows[0].r;
    await tx.query(`select public.library_catalog_apply('sheridan', $1::jsonb, $2)`, [defs, p.hash]);
    const coll = (await tx.query(`insert into public.personal_collections (name, sort_order) values ('ZZ Post Collection', 990) returning id`)).rows[0].id;
    // The fixture True Crime / Docs film (company theme) matched to a new TV show; the genre fixture is refused.
    await tx.query(`select public.library_match_season($1, '{"tmdb_id": 99998003}'::jsonb, $2::jsonb)`, [FX.tcFilm,
      { item_key: 'zz post doc series|season 1', title: 'ZZ Post Doc Series', season: 'Season 1', theme: 'ZZ', display_date: 'TBA', date_sort: '2099-01-01', media_type: 'tv', tmdb_id: 99998003, season_number: 1 }]);
    let genreRefusal = '';
    await tx.query('savepoint g');
    try { await tx.query(`select public.library_match_season($1, '{"tmdb_id": 99998004}'::jsonb, $2::jsonb)`, [FX.genreFilm,
      { item_key: 'zz post genre|season 1', title: 'ZZ Post Genre', season: 'Season 1', theme: 'ZZ', display_date: 'TBA', date_sort: '2099-01-01', media_type: 'tv', tmdb_id: 99998004, season_number: 1 }]); }
    catch (e) { genreRefusal = e.message; await tx.query('rollback to savepoint g'); }
    const docShow = (await tx.query(`select show_id from public.watchlist_items where id = $1`, [FX.tcFilm])).rows[0].show_id;
    return { show: show.show_id, film: film.results[0].id, coll, docShow, genreRefusal };
  });
  const rbW = await W.db.exec(sql('db/rollback/phase5c.sql'));
  const repW = rbW.at(-1).rows[0].report;
  const where = async (table, id) => (await one(W.db, `select collection from public.${table} where id = $1`, [id])).collection;
  ok(await where('tv_shows', writes.show) === 'othertv', 'a show created since (no catalog) → othertv');
  ok(await where('watchlist_items', writes.film) === 'movies', 'a film added since whose theme is a genre → movies');
  ok(await val(W.db, `select collection from public.tv_shows where show_key = 'zz post cat'`) === 'sheridan'
     && await val(W.db, `select collection from public.watchlist_items where item_key = 'zz post cat film|film'`) === 'sheridan', 'records the catalog created since → that catalog');
  ok(await val(W.db, `select coalesce(legacy_source, '-') from public.personal_collections where name = 'ZZ Post Collection'`) === '-', 'a collection created since gets its catalog_id as legacy_source (none here)');
  ok(/^genre_film_season/.test(writes.genreRefusal), 'the genre fixture film can’t become a TV season (refused, as in Stage 4b)', writes.genreRefusal);
  ok(await where('tv_shows', writes.docShow) === 'truecrime' && await where('watchlist_items', FX.tcFilm) === 'truecrime',
    'the True Crime / Docs fixture film matched since to a new show → that show takes the storage its archived season shares (truecrime), as Stage 5a would have made it');
  ok(repW.records_by_rule >= 6 && repW.collections_without_archive_entry === 1 && repW.discarded_show_links.some(l => l.origin === 'catalog_insert'),
    'the report counts the records placed by rule and the new collection, and lists the discarded links with their origin and created_at',
    JSON.stringify({ by_rule: repW.records_by_rule, colls: repW.collections_without_archive_entry }));
  await W.db.close();

  section('rollback refusals: what Stage 5a can’t represent, and a retired archive (nothing changed either time)');
  const X = await replicaAt('5c');
  await X.db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true)`);
    const a = (await tx.query(`select public.library_create_show('{"title":"ZZ Same","show_key":"zz same"}'::jsonb,
      '[{"item_key":"zz same|season 1","title":"ZZ Same","season":"Season 1","date_sort":"2020-01-01"}]'::jsonb) r`)).rows[0].r;
    await tx.query(`select public.library_create_show($1::jsonb, '[{"item_key":"zz same|season 2","title":"ZZ Same","season":"Season 2","date_sort":"2021-01-01"}]'::jsonb)`,
      [{ title: 'ZZ Same', show_key: 'zz same', distinct_from: [a.show_id] }]);
  });
  const xBefore = await val(X.db, PRESERVED) + await val(X.db, GOVERNANCE);
  const xr = await refusedExec(X.db, 'db/rollback/phase5c.sql', /can't be represented in Stage 5a[\s\S]*unmatched_show_key_collision/);
  ok(xr.refused, 'two same-named unmatched shows made since (distinct_from) → refused: Stage 5a keeps one per name where new shows go', xr.message);
  ok(await val(X.db, PRESERVED) + await val(X.db, GOVERNANCE) === xBefore && await val(X.db, `select public.stage5_capabilities() ->> 'phase'`) === 'contracted', 'nothing changed');
  const X2 = await replicaAt('5c');
  await X2.db.exec(`begin; select private.lib_write_on(); update public.watchlist_items set theme_kind = 'other' where id = '${FX.genreFilm}'; commit;`);
  const x2Before = await val(X2.db, PRESERVED) + await val(X2.db, GOV_ROWS);
  const xr3 = await refusedExec(X2.db, 'db/rollback/phase5c.sql', /film_archive_disagrees_with_governance/);
  ok(xr3.refused, 'a film whose theme_kind no longer agrees with its archived storage (genre ⇔ movies) → refused', xr3.message);
  ok(await val(X2.db, PRESERVED) + await val(X2.db, GOV_ROWS) === x2Before, 'nothing changed');
  await X2.db.close();
  await X.db.exec(`drop table private.stage5_recovery_meta`); // what retiring the archive leaves (the retirement itself is a later, separately approved step)
  const xr2 = await refusedExec(X.db, 'db/rollback/phase5c.sql', /recovery archive has been retired/);
  ok(xr2.refused, 'once the archive is retired: refused, recovery is fix-forward only', xr2.message);
  ok(await val(X.db, `select public.stage5_capabilities() ->> 'recovery_archive'`) === 'retired', 'the phase says the archive is retired (the page then converts format-3 files without a recovery section)');
  await X.db.close();

  section('a materially changed format-4 restore, then a rollback: new ids follow the rule; governance removed from an archived record is refused');
  async function doc4Of(db) {
    const spec = app.backupSpec(4), t = {};
    for (const name of spec.tables) {
      const cols = Object.keys(spec.columns[name]);
      t[name] = JSON.parse((await one(db, `select coalesce(json_agg(x order by x.id), '[]')::text j from (select ${cols.map(c => `"${c}"`).join(', ')} from public.${name}) x`)).j);
    }
    return { format: 'watchlist-tracker-backup', formatVersion: 4, exportedAt: '2026-10-09T00:00:00.000Z', rowCounts: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.length])), tables: t };
  }
  const N = await replicaAt('5c');
  const dN = await doc4Of(N.db);
  const newId = 'f5000000-0000-4000-8000-0000000000a5';
  dN.tables.watchlist_items = dN.tables.watchlist_items.map(r => r.id === FX.genreFilm ? { ...r, id: newId } : r); // a film under a new id (no archive entry)
  const vN = await N.anon(`select public.restore_backup($1::jsonb) r`, [dN]).then(r => r[0].r, e => ({ error: e.message }));
  ok(!vN.error, 'a format-4 document with a film under a new id restores', JSON.stringify(vN));
  const rbN = await N.db.exec(sql('db/rollback/phase5c.sql'));
  ok(await val(N.db, `select collection from public.watchlist_items where id = '${newId}'`) === 'movies' && rbN.at(-1).rows[0].report.records_by_rule >= 1,
    'rolled back: that film has no archive entry, so its genre theme places it with the films; the report counts it');
  await N.db.close();
  const M = await replicaAt('5c');
  const dM = await doc4Of(M.db);
  if (dM.tables.catalog_film_links.length) {
    dM.tables.catalog_film_links = dM.tables.catalog_film_links.slice(1); dM.rowCounts.catalog_film_links--;
    const vM = await M.anon(`select public.restore_backup($1::jsonb) r`, [dM]).then(r => r[0].r, e => ({ error: e.message }));
    ok(!vM.error, 'a format-4 document without one film’s governing link restores (a valid state)', JSON.stringify(vM));
    const mBefore = await val(M.db, PRESERVED) + await val(M.db, GOV_ROWS);
    const mr = await refusedExec(M.db, 'db/rollback/phase5c.sql', /film_archive_disagrees_with_governance/);
    ok(mr.refused, 'rolling back is refused: the archive says that film was stored with its catalog, but nothing governs it now', mr.message);
    ok(await val(M.db, PRESERVED) + await val(M.db, GOV_ROWS) === mBefore, 'nothing changed');
  } else console.log('  info no governed film in this backup: the link-removal case is covered by db/test/t_5c_contract.sql only');
  await M.db.close();

  section('a format-3 file converted in the page (backup-format3.js) restores into a contracted database; rolling back recovers that file’s storage');
  const V = await replicaAt('5c', { fixtures: false });
  const F = await replicaAt('4b', { fixtures: false });
  const preservedFile = await val(F.db, PRESERVED), storageFile = await val(F.db, STORAGE);
  await F.db.exec(sql('db/phase5a_expand.sql'));
  const govFile = await val(F.db, GOVERNANCE);
  await F.db.close();
  const sha = crypto.createHash('sha256').update(backupText).digest('hex');
  const conv = app.convertFormat3To4(backup, { includeRecovery: true, sourceSha256: sha });
  ok(!conv.refusals || conv.refusals.length === 0, 'the backup converts (no refusal)', JSON.stringify(conv.refusals));
  const convErrors = Array.from(app.validateBackupObject(conv.doc));
  ok(convErrors.length === 0, 'the converted document validates', convErrors.join('\n'));
  const vr = await V.anon(`select public.restore_backup($1::jsonb) r`, [conv.doc]).then(r => r[0].r, e => ({ error: e.message }));
  ok(!vr.error, 'restore_backup accepts the converted document with its recovery section', JSON.stringify(vr));
  ok(await val(V.db, PRESERVED) === preservedFile, 'every preserved field equals the file');
  ok(await val(V.db, GOVERNANCE) === govFile, 'governance and theme meaning equal what the file’s storage said');
  const metaV = await one(V.db, `select origin, hashes from private.stage5_recovery_meta`);
  ok(metaV.origin === 'converted_restore' && metaV.hashes.source_sha256 === sha && /^[0-9a-f]{32}$/.test(metaV.hashes.records || '') && /^[0-9a-f]{32}$/.test(metaV.hashes.othertv_shows || ''),
    'the archive records the converted file (origin converted_restore, the file’s sha256) and its own installed-content hashes');
  await V.db.exec(sql('db/rollback/phase5c.sql'));
  ok(await val(V.db, STORAGE) === storageFile, 'rolled back: storage and othertv_shows are exactly the file’s');
  const noRec = app.convertFormat3To4(backup, { includeRecovery: false, sourceSha256: sha });
  ok(!noRec.doc.recovery, 'the converter omits the recovery section when asked (the page asks once the archive is retired; the real restore of that case: db/test/t_5c_contract.sql)');
  await V.db.close();

  // ═══ The generated rollback sections ═══
  section('failure injection (A2): a failure at each labeled point of each script leaves everything exactly as before');
  {
    // Control: the comparison sees a script that committed part of its work before failing.
    const K = await replicaAt('4b');
    const before = await fullState(K.db);
    const p = injectionPoints('db/phase5a_expand.sql')[3];
    const partial = p.text.replace(`do $inj$ begin raise exception '${p.tag}'`, `commit; begin; do $inj$ begin raise exception '${p.tag}'`);
    let message = null;
    try { await K.db.exec(partial); } catch (e) { message = e.message; }
    await K.db.exec('rollback').catch(() => {});
    ok(message === p.tag && await fullState(K.db) !== before, `control: a copy of db/phase5a_expand.sql that commits ${p.label} and then fails is detected as a changed state`);
    await K.db.close();
  }
  for (const [phase, file, opts] of [['4b', 'db/phase5a_expand.sql', { statements: true }], ['5a', 'db/phase5c_contract.sql', { statements: true }], ['5c', 'db/rollback/phase5c.sql', { statements: true }], ['5a', 'db/rollback/phase5a.sql', { statements: true }]]) {
    const J = await replicaAt(phase);
    if (file === 'db/rollback/phase5a.sql') await setBaseline5a(J.db, baseline5a);
    const r = await injectAll(J.db, file, opts);
    ok(r.bad.length === 0, `${file} (from ${phase}): ${r.n} points, each reached (its own error) and each leaving catalog, owners, ACLs, every row of every table (user_id included), the archive and the write flag unchanged`,
      r.bad.join('\n') + (process.env.INJECT_VERBOSE ? '\n' + r.labels.join('\n') : ''));
    evidence[`inject_${file}`] = { points: r.n, labels: r.labels };
    const done = await J.db.exec(sql(file)).then(() => true, e => e.message);
    ok(done === true, `${file} still runs normally on that replica afterwards`, String(done));
    await J.db.close();
  }

  section('the rollback’s generated sections are current');
  const g = await generateSections(backup);
  const cur = sectionsOf(sql('db/rollback/phase5c.sql'));
  ok(cur.othertv === g.othertv && cur.catalog === g.catalog, 'db/rollback/phase5c.sql GENERATED sections equal a fresh generation');

  console.log(failed ? `\nREHEARSAL 5 FAILED (${failed})` : '\nREHEARSAL 5 PASSED');
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.log(`  FAIL ${e.stack || e.message}\nREHEARSAL 5 FAILED`);
  process.exitCode = 1;
}
if (evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'rehearsal-5.json'), JSON.stringify({ backup: path.basename(backupPath), failed, ...evidence }, null, 1));
}
