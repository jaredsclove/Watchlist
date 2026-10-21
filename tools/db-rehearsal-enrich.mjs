// Local rehearsal of the admin enrichment extensions (db/admin/tv_enrich_partial.sql) on a PGlite replica at
// EP1 (contracted-ep1, M1 access) holding a real format-5 backup as member A (and the same library under new
// ids as member B):
//   install  refusals (no run id, before EP1), failure injection after every statement, the install, a replay
//            refused, admin-only grants, private.tv_enrich_show unchanged;
//   partial  one catalog show whose last season is a provisional, unlisted "Season N": every refusal changes
//            nothing; the dry run changes nothing; applying matches the earlier seasons and leaves that season,
//            viewing state, curation, memberships, catalog links and the rest of the library unchanged;
//   after    catalog updates (no insertion or conflict for the show; a TBA date fill still reaches the
//            unmatched season), adding that season by label is held (identity_conflict) without a duplicate,
//            EP1 marks on matched seasons only, a format-6 backup round trip;
//   season   matching the provisional season later (plain "Season N" → N only), its refusals, marks kept;
//   labels   a synthetic show with "Specials" and a split-season label: Specials → 0 only; split labels refused.
// Nothing here touches Supabase. Output: pass/fail and counts only; never record contents.
//   PGLITE_DIR=/path/with/node_modules node tools/db-rehearsal-enrich.mjs --backup <format5.json> --title <show title> [--no-inject]
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const backupFile = opt('--backup'), TITLE = opt('--title');
if (!backupFile || !TITLE || !process.env.PGLITE_DIR) {
  console.error('usage: PGLITE_DIR=… node tools/db-rehearsal-enrich.mjs --backup <format5.json> --title <show title> [--no-inject]');
  process.exit(2);
}
const inject = !argv.includes('--no-inject');
const req = createRequire(path.join(process.env.PGLITE_DIR, 'package.json'));
const { PGlite } = await import(req.resolve('@electric-sql/pglite'));
const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const backupText = fs.readFileSync(backupFile);
const backupSha = sha(backupText);
const doc5 = JSON.parse(backupText);
if (doc5.formatVersion !== 5) { console.error('--backup must be format 5'); process.exit(2); }

let failed = 0;
const ok = (cond, label, detail = '') => { if (!cond) failed++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `\n       ${String(detail).slice(0, 1200)}` : ''}`); return cond; };
const section = t => console.log(`\n[${t}]`);

// The page's own backup code and catalog definitions.
const page = { console, Map, Set, JSON, Date, Math, Array, Object, String, Number, Boolean, RegExp, Error, Promise, parseInt, isFinite,
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} }, window: {}, localStorage: { getItem: () => null, setItem() {} },
  crypto: crypto.webcrypto, TextEncoder };
page.window = page;
vm.createContext(page);
for (const f of ['config.js', 'ui-helpers.js', 'metadata.js', 'api.js', 'backup-restore.js', 'backup-format3.js']) vm.runInContext(sql(f), page, { filename: f });
const P = expr => vm.runInContext(expr, page);
const validate = d => Array.from(P('validateBackupObject')(d));

const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b', C = '00000000-0000-4000-8000-00000000000c';
const idMap = new Map();
const remap = v => { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return v; if (!idMap.has(v)) idMap.set(v, crypto.randomUUID()); return idMap.get(v); };
const docB = JSON.parse(JSON.stringify(doc5), (k, v) => (typeof v === 'string' ? remap(v) : v));
async function asRole(db, role, sub, s, p) {
  return db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)`, [sub ? JSON.stringify({ sub, role }) : '', role]);
    return (await tx.query(s, p)).rows;
  });
}
const asUser = (db, sub, s, p) => asRole(db, 'authenticated', sub, s, p);
async function attempt(fn) { try { return { ok: true, rows: await fn() }; } catch (e) { return { ok: false, message: e.message }; } }
const val = async (db, s, p) => Object.values((await db.query(s, p)).rows[0])[0];
async function tryExec(db, text) {
  try { const out = await db.exec(text); return { ok: true, out }; }
  catch (e) { await db.exec('rollback').catch(() => {}); return { ok: false, message: e.message }; }
}
async function replica({ ep1 = true } = {}) {
  const db = new PGlite();
  for (const f of ['db/test/supabase_shim.sql', 'db/test/replica_schema.sql', 'db/phase0_restore_v1.sql']) await db.exec(sql(f));
  await db.exec(`set timezone = 'UTC'`);
  for (const f of ['db/phase1b_ownership.sql', 'db/restore_backup.sql', 'db/phase1c_tv_schema.sql', 'db/tv_model.sql', 'db/rpc.sql', 'db/admin/tv_enrich.sql']) await db.exec(sql(f));
  await db.exec(`update private.migration_stage set stage = 'final'`);
  await db.exec(sql('db/phase3b_org.sql'));
  for (const f of ['db/phase3b2_org_write.sql', 'db/phase4a_catalog.sql', 'db/phase4b_add_to_show.sql', 'db/phase5a_expand.sql', 'db/phase5c_contract.sql']) await db.exec(sql(f));
  await db.query(`select set_config('watchlist.b45_choices', $1, false)`, [JSON.stringify({ shows: {}, films: {} })]);
  await db.exec(sql('db/b45_expand.sql'));
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@test.invalid'), ('${B}', 'b@test.invalid'), ('${C}', 'c@test.invalid')`);
  await asRole(db, 'anon', null, `select public.restore_backup($1::jsonb, false)`, [doc5]);
  await db.exec(`begin; select set_config('watchlist.library_write', 'on', true);
    insert into private.stage5_recovery_records (user_id, kind, id, collection)
      select user_id, 'show', id, 'synthetic' from public.tv_shows union all select user_id, 'item', id, 'synthetic' from public.watchlist_items;
    insert into private.stage5_recovery_meta (user_id, origin, counts, hashes) select bootstrap_owner_id, 'contraction', '{}'::jsonb, '{}'::jsonb from private.app_owner;
    commit;`);
  await db.exec(`select set_config('watchlist.m1_owner', '${A}', false), set_config('watchlist.m1_run', 'rehearsal-m1', false);\n` + sql('db/m1_access.sql'));
  await db.exec(`insert into private.library_members (user_id, note) values ('${B}', 'rehearsal B')`);
  await asUser(db, B, `select public.restore_backup($1::jsonb, false)`, [docB]);
  if (ep1) await db.exec(`select set_config('watchlist.ep1_run', 'rehearsal-ep1', false);\n` + sql('db/ep1_episode_marks.sql'));
  return db;
}
const TABLES = ['watchlist_items', 'tv_shows', 'custom_collections', 'personal_collections', 'collection_memberships', 'watch_with_choices',
  'catalog_show_links', 'catalog_film_links', 'episode_marks'];
// Every row of every table (user_id included) — with the identity fields of the given seasons and show left out.
async function digest(db, { seasons = [], show = null } = {}) {
  const out = {};
  for (const t of TABLES) {
    const strip = t === 'watchlist_items' ? `case when r.id = any($1::uuid[]) then to_jsonb(r) - 'media_type' - 'tmdb_id' - 'season_number' else to_jsonb(r) end`
      : t === 'tv_shows' ? `case when r.id = $2::uuid then to_jsonb(r) - 'tmdb_id' else to_jsonb(r) end` : 'to_jsonb(r)';
    const params = t === 'watchlist_items' ? [seasons] : t === 'tv_shows' ? [show] : [];
    out[t] = await val(db, `select md5(coalesce(string_agg(x, '|' order by x), '')) from (select (${strip.replace('$2', '$1')})::text x from public.${t} r) q`, params);
  }
  for (const t of ['stage5_recovery_records', 'library_members', 'migration_runs']) out[t] = await val(db, `select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by to_jsonb(r)::text), '')) from private.${t} r`);
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function statements(text) {
  const out = []; let i = 0, start = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === "'") { i++; while (i < text.length) { if (text[i] === "'" && text[i + 1] === "'") i += 2; else if (text[i] === "'") break; else i++; } i++; continue; }
    if (c === '$') { const m = /^\$[A-Za-z_]*\$/.exec(text.slice(i)); if (m) { const end = text.indexOf(m[0], i + m[0].length); i = end + m[0].length; continue; } }
    if (c === ';') { out.push(text.slice(start, i + 1)); start = i + 1; }
    i++;
  }
  if (text.slice(start).trim()) out.push(text.slice(start));
  return out;
}
const INSTALL = sql('db/admin/tv_enrich_partial.sql');
const pre = run => `select set_config('watchlist.enrich_run', '${run}', false);\n`;
const STRICT_SIG = `select md5(prosrc) || ':' || coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = 'private.tv_enrich_show(uuid, text, integer, jsonb, boolean)'::regprocedure`;
// Run an admin function as postgres; returns { ok, json | message }.
async function admin(db, fn, args) {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  try { const r = await db.query(`select private.${fn}(${ph}) j`, args); return { ok: true, json: r.rows[0].j }; }
  catch (e) { await db.exec('rollback').catch(() => {}); return { ok: false, message: e.message }; }
}

// ═══ install ═══
section('install');
{
  const before = await replica({ ep1: false });
  const r = await tryExec(before, pre('enrich-1') + INSTALL);
  ok(!r.ok && /expected phase contracted-ep1/.test(r.message), 'refused before EP1 (phase contracted-b45), nothing installed', r.message || 'committed');
}
const db = await replica();
const sig0 = await val(db, STRICT_SIG);
const d0 = await digest(db);
{
  const r = await tryExec(db, pre('') + INSTALL);
  ok(!r.ok && /set watchlist\.enrich_run/.test(r.message) && same(d0, await digest(db)), 'no run id: refused, nothing changed', r.message || 'committed');
}
if (inject) {
  const st = statements(INSTALL);
  const bi = st.findIndex(s => /^begin\s*;/i.test(s.replace(/--[^\n]*\n/g, '').trim())), ci = st.findIndex(s => /^commit\s*;/i.test(s.replace(/--[^\n]*\n/g, '').trim()));
  const bad = [];
  for (let k = bi; k < ci; k++) {
    const x = await tryExec(db, pre(`inject-${k}`) + st.slice(0, k + 1).join('') + `\ndo $zz$ begin raise exception 'zz injected after %', ${k}; end $zz$;\n` + st.slice(k + 1).join(''));
    const installed = await val(db, `select to_regprocedure('private.tv_enrich_season(uuid, uuid, text, integer, uuid, text, integer, boolean)') is not null`);
    if (x.ok || !/zz injected/.test(x.message) || installed || !same(d0, await digest(db))) bad.push(`${k}: ${x.message || 'committed'}`);
  }
  ok(bad.length === 0, `a failure after each of its ${ci - bi} statements leaves nothing installed and no run record`, bad.join('\n'));
}
{
  const r = await tryExec(db, pre('enrich-rehearsal-1') + INSTALL);
  if (!ok(r.ok, 'db/admin/tv_enrich_partial.sql commits', r.message)) process.exit(1);
  const dI = await digest(db);
  ok(Object.keys(d0).filter(k => k !== 'migration_runs').every(k => d0[k] === dI[k]), 'the install changes no row (only the run record is added)');
  ok((await val(db, `select count(*) from private.migration_runs where run_id = 'enrich-rehearsal-1' and migration = 'enrich-partial'`)) == 1,
    'the run record holds this run');
  ok((await val(db, STRICT_SIG)) === sig0, 'private.tv_enrich_show is unchanged (source and grants)');
  const replay = await tryExec(db, pre('enrich-rehearsal-2') + INSTALL);
  ok(!replay.ok && /already installed/.test(replay.message), 'a replay is refused', replay.message || 'committed');
  for (const f of ['private.tv_enrich_show_partial(uuid, uuid, text, integer, jsonb, jsonb, boolean)', 'private.tv_enrich_season(uuid, uuid, text, integer, uuid, text, integer, boolean)']) {
    const x = await attempt(() => asUser(db, A, `select ${f.replace(/\(.*$/, '')}(null, null, null, null, null, null, null${f.includes('season(') ? ', null' : ''})`));
    ok(!x.ok && /permission denied/.test(x.message), `${f.split('(')[0]}: an application member can't call it`, x.message || 'succeeded');
  }
  const strictOld = await admin(db, 'tv_enrich_show', ['00000000-0000-4000-8000-0000000000ff', 'x', 1, '[]', false]);
  ok(!strictOld.ok && /not found/.test(strictOld.message), 'the strict function still answers as before');
}

// ═══ partial enrichment of the real show ═══
section('partial: the show’s earlier seasons matched, its provisional season left unmatched');
const show = (await db.query(`select s.id, s.title, s.tmdb_id, s.status from public.tv_shows s where s.user_id = $1 and s.title = $2`, [A, TITLE])).rows[0];
if (!ok(!!show && show.tmdb_id === null, 'the show is in A’s library and unmatched')) process.exit(1);
const rows = (await db.query(`select id, season, watched, skipped, display_date from public.watchlist_items where show_id = $1`, [show.id])).rows;
const num = s => (/^Season ([1-9][0-9]*)$/.exec(s.season) || [])[1] * 1;
rows.sort((a, b) => num(a) - num(b));
const last = rows[rows.length - 1], earlier = rows.slice(0, -1);
ok(rows.every(r => num(r) > 0) && earlier.length >= 1 && /tba/i.test(last.display_date), `${rows.length} plain-labelled seasons; the last is TBA (provisional)`);
console.log(`       seasons ${rows.length}, matched ${earlier.length}, left unmatched 1; watched ${rows.filter(r => r.watched).length}, skipped ${rows.filter(r => r.skipped).length}`);
const TMDB = 67757;
const matched = earlier.map(r => ({ row_id: r.id, season: r.season, season_number: num(r) }));
const unmatched = [{ row_id: last.id, season: last.season }];
const partial = (o = {}) => admin(db, 'tv_enrich_show_partial', [o.owner ?? A, o.show ?? show.id, o.title ?? TITLE, o.tmdb ?? TMDB,
  JSON.stringify(o.seasons ?? matched), JSON.stringify(o.unmatched ?? unmatched), o.apply ?? false]);
const dP = await digest(db);
const otherShow = (await db.query(`select s.id, s.title, s.tmdb_id from public.tv_shows s where s.user_id = $1 and s.tmdb_id is not null order by s.id limit 1`, [A])).rows[0];
const otherSeason = (await db.query(`select id, season from public.watchlist_items where user_id = $1 and show_id <> $2 and tmdb_id is null and show_id is not null order by id limit 1`, [A, show.id])).rows[0];
for (const [label, o, re] of [
  ['a season missing from both lists', { seasons: matched.slice(1) }, /every season must be accounted for/],
  ['nothing left unmatched', { unmatched: [] }, /use private\.tv_enrich_show/],
  ['nothing matched', { seasons: [] }, /at least one season must be matched/],
  ['a season both matched and left', { unmatched: [...unmatched, { row_id: earlier[0].id, season: earlier[0].season }] }, /both matched and left unmatched/],
  ['a season listed twice', { seasons: [...matched, matched[0]] }, /listed twice/],
  ['a label that differs', { unmatched: [{ row_id: last.id, season: 'Season 99' }] }, /is "Season/],
  ['a matched season taking the provisional season’s number', { seasons: matched.map((m, i) => (i === 0 ? { ...m, season_number: num(last) } : m)) }, /takes the number of a season left unmatched/],
  ['a season of another show', { unmatched: [...unmatched, otherSeason && { row_id: otherSeason.id, season: otherSeason.season }].filter(Boolean) }, /is not a season of/],
  ['a TMDB show already on the list', { tmdb: otherShow.tmdb_id }, /is already show/],
  ['a wrong title', { title: TITLE + ' (x)' }, /not ".*\(x\)"/],
  ['another member as owner', { owner: B }, /belongs to another owner/],
  ['a non-member as owner', { owner: C }, /is not a library member/],
  ['an already matched show', { show: otherShow.id, title: otherShow.title }, /already has TMDB id/],
  ['a negative season number', { seasons: matched.map((m, i) => (i === 0 ? { ...m, season_number: -1 } : m)) }, /season_number/],
]) {
  for (const apply of [false, true]) {
    const r = await partial({ ...o, apply });
    ok(!r.ok && re.test(r.message) && same(dP, await digest(db)), `refused (${apply ? 'apply' : 'dry run'}): ${label}; nothing changed`, r.message || JSON.stringify(r.json).slice(0, 200));
  }
}
{
  const dry = await partial();
  ok(dry.ok && dry.json.applied === false && dry.json.seasons.length === earlier.length && dry.json.unmatched.length === 1 && same(dP, await digest(db)),
    'the dry run previews the plan and changes nothing', dry.message);
  const lastRow0 = await val(db, `select to_jsonb(w)::text from public.watchlist_items w where id = $1`, [last.id]);
  const applied = await partial({ apply: true });
  ok(applied.ok && applied.json.applied === true, 'applied', applied.message);
  const s = (await db.query(`select tmdb_id from public.tv_shows where id = $1`, [show.id])).rows[0];
  const idents = (await db.query(`select id, media_type, tmdb_id, season_number from public.watchlist_items where show_id = $1`, [show.id])).rows;
  ok(s.tmdb_id === TMDB && earlier.every(r => { const x = idents.find(i => i.id === r.id); return x.media_type === 'tv' && x.tmdb_id === TMDB && x.season_number === num(r); }),
    'the show and its earlier seasons carry TMDB 67757 and their own numbers');
  ok((await val(db, `select to_jsonb(w)::text from public.watchlist_items w where id = $1`, [last.id])) === lastRow0, 'the provisional season is unchanged, field by field');
  const dAfter = await digest(db, { seasons: earlier.map(r => r.id), show: show.id });
  const dBefore = { ...dP };
  ok(Object.keys(dBefore).filter(k => k !== 'watchlist_items' && k !== 'tv_shows').every(k => dBefore[k] === dAfter[k]),
    'memberships, catalog links, collections, choices, marks, the archive and membership: unchanged');
  const dIdentFree0 = await (async () => { const R = await replica(); await tryExec(R, pre('x-ref') + INSTALL); return digest(R, { seasons: earlier.map(r => r.id), show: show.id }); })();
  ok(dAfter.watchlist_items === dIdentFree0.watchlist_items && dAfter.tv_shows === dIdentFree0.tv_shows,
    'every other field of every row (viewing state, dates, curation, status) equals an untouched replica’s');
  const again = await partial({ apply: true });
  ok(!again.ok && /already has TMDB id/.test(again.message), 'applying again is refused (the checks run again inside the apply)', again.message);
}

// ═══ after: catalog, adds, EP1, backup ═══
section('after: catalog updates, adding a season, EP1, format-6 backup');
const defs = JSON.parse(JSON.stringify(P(`COLLECTIONS.find(c => c.id === '90day').defaults`)));
const showKeyOf = k => String(k).split('|')[0];
const ours = defs.filter(d => d.t === TITLE);
{
  const pv = (await asUser(db, A, `select public.library_catalog_apply_b45('90day', $1::jsonb) r`, [JSON.stringify(defs)]))[0].r;
  const prefix = showKeyOf(ours[0].k);
  const mine = (pv.document.entries || []).filter(e => JSON.stringify(e).includes(prefix) || JSON.stringify(e).includes(show.id));
  const lastKey = ours[ours.length - 1].k;
  ok(ours.length === rows.length && mine.length === rows.length && mine.every(e => e.kind === 'noop')
     && mine.filter(e => e.item_key !== lastKey).every(e => e.category === 'identified') && mine.some(e => e.item_key === lastKey && e.category === 'present'),
    'catalog preview: only no-ops for the show (its earlier seasons as identified, the provisional season as present); no insertion, conflict or change',
    JSON.stringify(mine.map(e => Object.fromEntries(Object.entries(e).filter(([k]) => !/title|name/.test(k))))).slice(0, 600));
  // A date for the provisional season (as a later catalog definition would give it): applied by date, identity untouched.
  const dated = defs.map(d => (d.k === ours[ours.length - 1].k ? { ...d, d: 'Jun 7, 2026', ds: '2026-06-07' } : d));
  const res = await db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [JSON.stringify({ sub: A, role: 'authenticated' })]);
    const p = (await tx.query(`select public.library_catalog_apply_b45('90day', $1::jsonb) r`, [JSON.stringify(dated)])).rows[0].r;
    const a = (await tx.query(`select public.library_catalog_apply_b45('90day', $1::jsonb, $2) r`, [JSON.stringify(dated), p.hash])).rows[0].r;
    const row = (await tx.query(`select display_date, date_sort, media_type, tmdb_id, season_number from public.watchlist_items where id = $1`, [last.id])).rows[0];
    await tx.rollback();
    return { mode: a.mode, row };
  }).catch(e => ({ error: e.message }));
  ok(!res.error && res.mode === 'applied' && res.row.date_sort === '2026-06-07' && res.row.tmdb_id === null && res.row.season_number === null,
    'a catalog date for the provisional season fills its TBA and leaves it unmatched (rolled back)', JSON.stringify(res));
}
{
  const s = (await db.query(`select id, show_key, tmdb_id from public.tv_shows where id = $1`, [show.id])).rows[0];
  const d = ours[ours.length - 1];
  const before = await digest(db);
  const r = await attempt(() => asUser(db, A, `select public.library_add_seasons_b45($1::uuid, $2::jsonb, $3::jsonb) r`, [show.id,
    JSON.stringify({ tmdb_id: s.tmdb_id, show_key: s.show_key, catalog: '90day' }),
    JSON.stringify([{ item_key: d.k, title: d.t, season: d.s, theme: d.th, display_date: d.d, date_sort: d.ds }])]));
  const out = r.ok ? r.rows[0].r : null;
  ok(r.ok && (out.inserted || []).length === 0 && JSON.stringify(out.rejected || []).includes('identity_conflict') && same(before, await digest(db)),
    'adding the provisional season by label is held for review (identity_conflict); no duplicate', r.message || JSON.stringify(out).slice(0, 300));
}
{
  const NONE = '{"watched":false,"skipped":false}';
  const openMatched = earlier.find(r => !r.watched && !r.skipped);
  const m1 = openMatched ? await attempt(() => asUser(db, A, `select public.library_set_episode_marks($1::uuid, '${NONE}', true, '[{"tmdb_episode_id":990001,"episode_number":1}]') r`, [openMatched.id])) : { ok: false, message: 'no open matched season' };
  ok(m1.ok, 'EP1: a matched season takes an episode mark', m1.message);
  const m2 = await attempt(() => asUser(db, A, `select public.library_set_episode_marks($1::uuid, $2::jsonb, true, '[{"tmdb_episode_id":990002,"episode_number":1}]') r`,
    [last.id, JSON.stringify({ watched: last.watched, skipped: last.skipped })]));
  ok(!m2.ok && /season_unmatched/.test(m2.message), 'EP1: the provisional season takes none (season_unmatched)', m2.message || 'succeeded');
}
{
  const exportDoc = async who => {
    const spec = P('backupSpec(6)'), tables = {};
    for (const t of spec.tables) {
      const cols = Object.keys(spec.columns[t]);
      tables[t] = (await asUser(db, who, `select coalesce(json_agg(json_build_object(${cols.map(c => `'${c}', x.${c}`).join(', ')}) order by x.id), '[]') j from public.${t} x`))[0].j;
    }
    return { format: P('BACKUP_FORMAT'), formatVersion: 6, exportedAt: new Date().toISOString(), rowCounts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])), tables };
  };
  const doc6 = await exportDoc(A);
  ok(validate(doc6).length === 0 && doc6.tables.episode_marks.length === 1, 'format 6: the mixed show’s backup validates with the page’s rules', validate(doc6).join(' | '));
  const before = await digest(db);
  const r = await attempt(() => asUser(db, A, `select public.restore_backup($1::jsonb, false) r`, [doc6]));
  ok(r.ok && same(before, await digest(db)), 'format 6: restoring it gives back the same library (matched seasons, the provisional one, the mark)', r.message);
}

// ═══ season: matching the provisional season later ═══
section('season: the provisional season matched later, once listed');
const season = (o = {}) => admin(db, 'tv_enrich_season', [o.owner ?? A, o.show ?? show.id, o.title ?? TITLE, o.tmdb ?? TMDB,
  o.row ?? last.id, o.label ?? last.season, o.number ?? num(last), o.apply ?? false]);
{
  const dS = await digest(db);
  for (const [label, o, re] of [
    ['a number other than its label’s', { number: num(last) + 1 }, /only "Season N" → N/],
    ['a matched season (rematching)', { row: earlier[0].id, label: earlier[0].season, number: num(earlier[0]) }, /already has an identity/],
    ['another TMDB show', { tmdb: TMDB + 1 }, /is matched to TMDB 67757, not/],
    ['an unmatched show', { show: otherSeason ? (await db.query(`select show_id from public.watchlist_items where id = $1`, [otherSeason.id])).rows[0].show_id : show.id,
      title: otherSeason ? (await db.query(`select s.title from public.tv_shows s join public.watchlist_items w on w.show_id = s.id where w.id = $1`, [otherSeason.id])).rows[0].title : TITLE,
      row: otherSeason ? otherSeason.id : last.id, label: otherSeason ? otherSeason.season : last.season, number: 1 }, /is not matched to TMDB/],
    ['a season of another show', { row: otherSeason ? otherSeason.id : earlier[0].id, label: otherSeason ? otherSeason.season : earlier[0].season }, /is not a season of|already has an identity/],
    ['a wrong expected label', { label: 'Season 99' }, /is "Season/],
    ['another member as owner', { owner: B }, /belongs to another owner/],
    ['a non-member', { owner: C }, /not a library member/],
  ]) {
    for (const apply of [false, true]) {
      const r = await season({ ...o, apply });
      ok(!r.ok && re.test(r.message) && same(dS, await digest(db)), `refused (${apply ? 'apply' : 'dry run'}): ${label}; nothing changed`, r.message || JSON.stringify(r.json).slice(0, 200));
    }
  }
  const dry = await season();
  ok(dry.ok && dry.json.applied === false && same(dS, await digest(db)), 'the dry run previews and changes nothing', dry.message);
  const marks0 = await val(db, `select md5(coalesce(string_agg(to_jsonb(m)::text, '|' order by m.id), '')) from public.episode_marks m`);
  const lastRow0 = await val(db, `select (to_jsonb(w) - 'media_type' - 'tmdb_id' - 'season_number')::text from public.watchlist_items w where id = $1`, [last.id]);
  const a = await season({ apply: true });
  const row = (await db.query(`select media_type, tmdb_id, season_number from public.watchlist_items where id = $1`, [last.id])).rows[0];
  ok(a.ok && row.media_type === 'tv' && row.tmdb_id === TMDB && row.season_number === num(last), 'applied: the season carries TMDB 67757 and its own number', a.message);
  ok((await val(db, `select (to_jsonb(w) - 'media_type' - 'tmdb_id' - 'season_number')::text from public.watchlist_items w where id = $1`, [last.id])) === lastRow0
     && (await val(db, `select md5(coalesce(string_agg(to_jsonb(m)::text, '|' order by m.id), '')) from public.episode_marks m`)) === marks0,
    'only its identity changed; the episode marks are unchanged');
  const again = await season({ apply: true });
  ok(!again.ok && /already has an identity/.test(again.message), 'matching it again is refused', again.message);
}

// ═══ labels: Specials and split seasons ═══
section('labels: "Specials" → 0 only; split-season labels refused');
{
  const t = 'ZZ Enrich Labels Check';
  const k = t.toLowerCase();
  const mk = lbl => ({ item_key: `${k}|${lbl.toLowerCase()}`, title: t, season: lbl, theme: 'ZZ', display_date: 'Jan 1, 2020', date_sort: '2020-01-01' });
  const c = await attempt(() => asUser(db, A, `select public.library_create_show_b45($1::jsonb, $2::jsonb) r`,
    [JSON.stringify({ tmdb_id: null, title: t, show_key: k, network: 'ZZ' }), JSON.stringify(['Season 1', 'Season 2 Part 2', 'Specials'].map(mk))]));
  ok(c.ok, 'a synthetic unmatched show with "Season 1", "Season 2 Part 2" and "Specials"', c.message);
  const sid = c.ok ? c.rows[0].r.show.id : null;
  const srows = sid ? (await db.query(`select id, season from public.watchlist_items where show_id = $1`, [sid])).rows : [];
  const R = l => srows.find(r => r.season === l);
  const free = 2147470000 + Math.floor(Math.random() * 1000);
  let p = await admin(db, 'tv_enrich_show_partial', [A, sid, t, free, JSON.stringify([{ row_id: R('Season 1').id, season: 'Season 1', season_number: 1 }]),
    JSON.stringify([{ row_id: R('Season 2 Part 2').id, season: 'Season 2 Part 2' }, { row_id: R('Specials').id, season: 'Specials' }]), true]);
  ok(p.ok, 'partial: "Season 1" matched; the split-season and Specials rows left unmatched', p.message);
  p = await admin(db, 'tv_enrich_season', [A, sid, t, free, R('Season 2 Part 2').id, 'Season 2 Part 2', 2, true]);
  ok(!p.ok && /only "Season N" → N/.test(p.message), 'a split-season label is refused (no override)', p.message);
  p = await admin(db, 'tv_enrich_season', [A, sid, t, free, R('Specials').id, 'Specials', 1, true]);
  ok(!p.ok && /only "Season N" → N/.test(p.message), '"Specials" to a numbered season is refused', p.message);
  p = await admin(db, 'tv_enrich_season', [A, sid, t, free, R('Specials').id, 'Specials', 0, true]);
  ok(p.ok, '"Specials" → 0 is matched', p.message);
  const d = await asUser(db, A, `select public.delete_tv_season(id, 0) from public.watchlist_items where show_id = '${sid}'`).catch(e => e.message);
  ok(Array.isArray(d) && Number(await val(db, `select count(*) from public.tv_shows where title = $1`, [t])) === 0, 'the synthetic show is removed again');
}

section('inputs unchanged');
ok(sha(fs.readFileSync(backupFile)) === backupSha, 'the backup file is unchanged');
console.log(`\n${failed ? `FAILED: ${failed}` : 'all rehearsal checks passed'}`);
process.exitCode = failed ? 1 : 0;
