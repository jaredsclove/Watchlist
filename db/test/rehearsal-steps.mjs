// Steps for tools/db-rehearsal.mjs after the backup is loaded: the migration in
// phase order, each followed by its SQL self-checks (db/test/t_*.sql).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execFileSync } from 'child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

export default function register(ctx) {
  const { step, exec, db } = ctx;

  // Runs a self-check script (prelude + checks) and fails the step on any failed check.
  async function checks(file, text) {
    const out = await db.exec(read('db/test/_prelude.sql') + '\n' + (text ?? read(file)));
    const last = out.at(-1).rows[0];
    const results = JSON.parse(last.results || '[]');
    for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.check}${r.ok ? '' : `\n       ${r.detail}`}`);
    const failed = results.filter(r => !r.ok).length;
    if (failed) throw new Error(`${failed} check(s) failed in ${file}`);
    console.log(`  ${last.passed} checks passed in ${file}`);
  }
  ctx.checks = checks;

  step('catalog-before', async () => {
    globalThis.__catalogBefore = (await ctx.query(CATALOG_SQL))[0].c;
    console.log('  ok   recorded the original schema catalog');
  });
  step('phase1b', async () => {
    await exec('phase 1b ownership', read('db/phase1b_ownership.sql'));
    await exec('owner-scoped restore_backup', read('db/restore_backup.sql'));
  });
  step('t_1b', () => checks('db/test/t_1b_ownership.sql'));

  step('phase1c', async () => {
    await exec('phase 1c tv schema', read('db/phase1c_tv_schema.sql'));
    await exec('tv model functions', read('db/tv_model.sql'));
    await exec('phase 1c backfill with exact-count assertions', read('db/phase1c_backfill.sql'));
  });
  step('t_1c', () => checks('db/test/t_1c_tv_schema.sql'));
  step('model-vs-reference', () => modelVsReference(ctx));
  // The generated script used on the Supabase test project, checked here too.
  step('expectations-sql', () => checks('tools/tv-model-expectations.mjs (generated)',
    execFileSync(process.execPath, [path.join(ROOT, 'tools/tv-model-expectations.mjs'), ctx.backupPath], { encoding: 'utf8', maxBuffer: 1 << 26 })));
  step('rpc', () => exec('browser-facing TV functions', read('db/rpc.sql')));
  step('t_rpc', () => checks('db/test/t_rpc.sql'));
  step('admin-enrich', () => exec('admin TMDB enrichment', read('db/admin/tv_enrich.sql')));
  step('t_enrich', () => checks('db/test/t_enrich.sql'));
  step('t_restore', () => checks('db/test/t_restore.sql'));
  step('future-auth', () => exec('future sign-in functions (rehearsal only)', read('db/future/auth_switchover.sql')));
  step('t_two_user', async () => {
    // Locally there are no real test users: random ids, and t_two_user.sql creates
    // the matching auth.users rows inside each rolled-back check.
    await db.query(`select set_config('watchlist_test.user_a', gen_random_uuid()::text, false),
                           set_config('watchlist_test.user_b', gen_random_uuid()::text, false)`);
    await checks('db/test/t_two_user.sql');
  });
  step('t_two_user-unconfigured', async () => {
    await db.query(`select set_config('watchlist_test.user_a', '', false), set_config('watchlist_test.user_b', '', false)`);
    const out = await db.exec(read('db/test/_prelude.sql') + '\n' + read('db/test/t_two_user.sql'));
    const results = JSON.parse(out.at(-1).rows[0].results);
    if (results.some(r => r.ok) || !results.every(r => /watchlist_test\.user_[ab] is not set/.test(r.detail))) {
      throw new Error('t_two_user.sql did not refuse to run without configured test users');
    }
    console.log(`  ok   without configured test users every one of the ${results.length} checks fails with a clear message`);
  });
  step('end-to-end', () => endToEnd(ctx));
}

// The schema as the replica had it before any migration, for the rollback check.
export const CATALOG_SQL = `select json_build_object(
  'indexes', (select json_agg(x order by x) from (select indexdef as x from pg_indexes where schemaname = 'public') s),
  'constraints', (select json_agg(x order by x) from (select conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid) as x
                  from pg_constraint where connamespace = 'public'::regnamespace) s),
  'columns', (select json_agg(x order by x) from (select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' ||
              coalesce(column_default, '') as x from information_schema.columns where table_schema = 'public') s),
  'policies', (select json_agg(x order by x) from (select tablename || '.' || policyname || ' ' || cmd || ' ' || roles::text as x
               from pg_policies where schemaname = 'public') s),
  'table_grants', (select json_agg(x order by x) from (select table_name || ' ' || grantee || ' ' || privilege_type as x
                   from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')) s),
  'column_grants', (select json_agg(x order by x) from (select c.relname || '.' || a.attname || ' ' || a.attacl::text as x
                    from pg_attribute a join pg_class c on c.oid = a.attrelid
                    where c.relnamespace = 'public'::regnamespace and a.attacl is not null) s),
  'functions', (select json_agg(x order by x) from (select n.nspname || '.' || p.proname as x from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')) s),
  'schemas', (select json_agg(nspname order by nspname) from pg_namespace where nspname in ('private'))
)::text as c`;

// Migrate through every stage with real edits, check the compatibility values
// keep the old app correct, roll every phase back, and prove the schema and the
// data end exactly where production started.
async function endToEnd({ db, exec, query, rpc, backup, FINGERPRINT_SQL }) {
  const M = require(path.join(ROOT, 'tests/tv-model-reference.js'));
  const ok = msg => console.log(`  ok   ${msg}`);
  const anonRpc = (fn, args) => rpc('anon', null, fn, args);
  const showsWithSeasons = async () => {
    const rows = await query(`select w.*, s.status as show_status from public.watchlist_items w join public.tv_shows s on s.id = w.show_id`);
    const by = new Map();
    for (const r of rows) { if (!by.has(r.show_id)) by.set(r.show_id, []); by.get(r.show_id).push(r); }
    return by;
  };
  // The property the compatibility values must hold: from season statuses alone,
  // the old app derives each show's status and (for Watching) the same up next.
  const checkCompat = async label => {
    let n = 0;
    for (const seasons of (await showsWithSeasons()).values()) {
      const status = seasons[0].show_status;
      if (M.oldAggregateStatus(seasons) !== status) throw new Error(`${label}: old aggregate differs for show ${seasons[0].show_id}`);
      if (status === 'watching' && !seasons.every(s => s.skipped)) {
        const a = M.oldUpNext(seasons), b = M.upNext(seasons);
        if ((a ? a.id : null) !== (b ? b.id : null)) throw new Error(`${label}: old up next differs for show ${seasons[0].show_id}`);
      }
      n++;
    }
    ok(`${label}: old app would derive the same status${''} and up next for all ${n} shows`);
  };

  // Phase 2: shadow. Old-style edits (season PATCHes) + a function insert, then resync.
  await exec('stage → shadow', `update private.migration_stage set stage = 'shadow'`);
  await anonRpc('add_tv_seasons', { p_collection: 'othertv', p_show: { tmdb_id: 990000401, title: 'ZZ E2E', show_key: 'zz e2e' },
    p_seasons: [1, 2].map(n => ({ item_key: `zz e2e|season ${n}`, title: 'ZZ E2E', season: `Season ${n}`, date_sort: '2020-01-01', season_number: n })) });
  await db.exec(`set role anon; update public.watchlist_items set status = 'watching' where item_key = 'zz e2e|season 1'; reset role;`);
  await query(`select private.tv_shadow_resync((select bootstrap_owner_id from private.app_owner))`);
  const [e2e] = await query(`select status from public.tv_shows where show_key = 'zz e2e'`);
  if (e2e.status !== 'watching') throw new Error('shadow resync did not pick up the season edit');
  await checkCompat('shadow');

  // Phase 3: switch-over, then authoritative edits through the functions as anon.
  await exec('stage → authoritative (switch-over checks)', read('db/stages.sql').split('-- Phase 3')[1].split('-- Clean-up C1')[0]
    .split('\n').filter(l => l.startsWith('--   ') || l.startsWith('-- begin') || l.startsWith('-- commit')).map(l => l.replace(/^-- ?/, '').replace(/^  /, '')).join('\n'));
  const traitors = (await query(`select id from public.tv_shows where title = 'The Traitors'`))[0].id;
  await anonRpc('set_show_status', { p_show_id: traitors, p_status: 'complete' });
  await anonRpc('set_show_status', { p_show_id: traitors, p_status: 'watching' });
  const s5 = (await query(`select id from public.watchlist_items where show_id = $1 and season_number = 5`, [traitors]))[0].id;
  await anonRpc('set_season_watched', { p_row_id: s5, p_watched: true });
  const s1 = (await query(`select id from public.watchlist_items where show_id = $1 and season_number = 1`, [traitors]))[0].id;
  await anonRpc('set_season_skipped', { p_row_id: s1, p_skipped: true });
  const bb = (await query(`select id from public.tv_shows where title = 'Breaking Bad'`))[0].id;
  const r = await anonRpc('add_tv_seasons', { p_collection: 'othertv', p_show: { tmdb_id: (await query(`select tmdb_id from public.tv_shows where id = $1`, [bb]))[0].tmdb_id, title: 'Breaking Bad', show_key: 'breaking bad' },
    p_seasons: [{ item_key: 'breaking bad|season 6', title: 'Breaking Bad', season: 'Season 6', date_sort: '2030-01-01', season_number: 6 }] });
  if (!r.reopened) throw new Error('Breaking Bad not reopened');
  const e2eRows = await query(`select id from public.watchlist_items where item_key like 'zz e2e|%' order by item_key`);
  for (const x of e2eRows) await anonRpc('delete_tv_season', { p_row_id: x.id });
  if ((await query(`select 1 from public.tv_shows where show_key = 'zz e2e'`)).length) throw new Error('empty show kept');
  await checkCompat('authoritative after edits');
  const before = await query(`select id, status from public.tv_shows order by id`);

  // Roll back Phase 3: stage back to shadow and resync from the compatibility values.
  await exec('rollback Phase 3 (stage → shadow + resync)', read('db/stages.sql').split('-- Rollback of Phase 3')[1]
    .split('\n').filter(l => l.startsWith('--   ') || l.startsWith('-- begin') || l.startsWith('-- commit')).map(l => l.replace(/^-- ?/, '').replace(/^  /, '')).join('\n'));
  const after = await query(`select id, status from public.tv_shows order by id`);
  const lost = before.filter(b => !after.find(a => a.id === b.id && a.status === b.status));
  if (lost.length) throw new Error(`resync after rollback changed ${lost.length} show statuses`);
  ok('rolling back the switch-over keeps every show status (resync from compatibility values)');

  // Roll back Phase 2 + 1c and Phase 1b, reinstall the Phase 0 restore, restore the original backup.
  await exec('rollback Phase 2 + 1c', read('db/rollback/phase2_and_1c.sql'));
  await exec('rollback Phase 1b', read('db/rollback/phase1b.sql'));
  await exec('reinstall Phase 0 restore_backup', read('db/phase0_restore_v1.sql'));
  const catalog = (await query(CATALOG_SQL))[0].c;
  if (catalog !== globalThis.__catalogBefore) {
    const a = JSON.parse(globalThis.__catalogBefore), b = JSON.parse(catalog);
    const diff = Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    throw new Error(`schema after rollback differs from the original in: ${diff.join(', ')}`);
  }
  ok('schema after full rollback is identical to the original (indexes, constraints, columns, policies, grants, functions)');
  await rpc('anon', null, 'restore_backup', { p_backup: backup });
  const [f] = await query(FINGERPRINT_SQL);
  if (process.env.EXPECT_FINGERPRINT && process.env.EXPECT_FINGERPRINT !== `${f.w_h}/${f.o_h}/${f.c_h}`) throw new Error('fingerprints differ after rollback');
  ok(`data after rollback + restore of the original backup: ${f.w_n}/${f.o_n}/${f.c_n}, fingerprints ${process.env.EXPECT_FINGERPRINT ? 'equal production' : f.w_h}`);
}

// The database model against tests/tv-model-reference.js: shared configuration,
// the shared cases (up next, Watching anchor, compatibility values) and the real
// migrated data (grouping, show status, skip flags, up next for every show).
async function modelVsReference({ db, query }) {
  const M = require(path.join(ROOT, 'tests/tv-model-reference.js'));
  const CASES = JSON.parse(read('tests/fixtures/tv-model-cases.json'));
  const ok = msg => console.log(`  ok   ${msg}`);

  const [cfg] = await query(`select private.tv_collections() as c,
    (select jsonb_object_agg(c || '|' || p, private.tv_show_key_override(c, p)) from (values ('disney', 'the clone wars')) v(c, p)) as o`);
  if (JSON.stringify([...cfg.c].sort()) !== JSON.stringify([...M.TV_COLLECTIONS].sort())) throw new Error('tv_collections differs from config.js');
  if (JSON.stringify(cfg.o) !== JSON.stringify(M.SHOW_KEY_OVERRIDES)) throw new Error('show-key overrides differ');
  ok('TV collections and show-key overrides match config/reference');

  const STATUSES = ['confirmed', 'highpriority', 'watching', 'complete', 'pending', 'maybe', 'skipped'];
  let caseChecks = 0;
  await db.transaction(async tx => {
    let i = 0;
    for (const c of CASES.upNext) {
      const seasons = M.caseSeasons(c.seasons, CASES.today);
      const tmdb = 990000000 + (++i);
      const legacy = seasons[0].media_type == null;
      const show = (await tx.query(`insert into public.tv_shows (collection, title, show_key, tmdb_id) values ($1, $2, $3, $4) returning id`,
        [seasons[0].collection, 'ZZ Case ' + i, 'zz case ' + i, legacy ? null : tmdb])).rows[0].id;
      const idMap = new Map();
      for (const r of seasons) {
        const { id } = (await tx.query(`insert into public.watchlist_items (collection, item_key, title, season, season_number, media_type,
          tmdb_id, display_date, date_sort, watched, skipped, show_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
          [r.collection, `zz case ${i}|${r.id.toLowerCase()}`, 'ZZ Case ' + i, r.season, r.season_number, r.media_type,
           legacy ? null : tmdb, r.display_date, r.date_sort, r.watched, r.skipped, show])).rows[0];
        idMap.set(id, r.id);
      }
      const [{ up, anchor }] = (await tx.query(`select private.tv_up_next($1) up, private.tv_watching_anchor($1) anchor`, [show])).rows;
      const jsUp = M.upNext(seasons), jsAnchor = M.watchingAnchor(seasons);
      if ((up ? idMap.get(up) : null) !== (jsUp ? jsUp.id : null)) throw new Error(`up next differs: ${c.name}`);
      if ((anchor ? idMap.get(anchor) : null) !== (jsAnchor ? jsAnchor.id : null)) throw new Error(`anchor differs: ${c.name}`);
      for (const st of STATUSES) {
        await tx.query(`update public.tv_shows set status = $1 where id = $2`, [st, show]);
        await tx.query(`select private.tv_project_legacy_status($1)`, [show]);
        const got = (await tx.query(`select id, status from public.watchlist_items where show_id = $1`, [show])).rows;
        const want = M.projectLegacyStatus(st, seasons);
        for (const g of got) if (want.get(idMap.get(g.id)) !== g.status) throw new Error(`projection differs: ${c.name} / ${st}`);
        caseChecks++;
      }
    }
    await tx.rollback();
  });
  ok(`${CASES.upNext.length} shared cases: up next and Watching anchor match; ${caseChecks} compatibility projections match`);

  // Real data: rebuild the reference result from the same rows and compare show by show.
  const rows = await query(`select w.*, s.status as show_status, s.title as show_title from public.watchlist_items w
                            left join public.tv_shows s on s.id = w.show_id`);
  const ref = M.groupShows(rows.map(r => ({ ...r, status: r.status })));
  const byShow = new Map();
  for (const r of rows) if (r.show_id) { if (!byShow.has(r.show_id)) byShow.set(r.show_id, []); byShow.get(r.show_id).push(r); }
  if (byShow.size !== ref.size) throw new Error(`show count ${byShow.size} vs reference ${ref.size}`);
  const ups = new Map((await query(`select id, private.tv_up_next(id) up from public.tv_shows`)).map(r => [r.id, r.up]));
  for (const [showId, seasons] of byShow) {
    const key = M.showIdentity(seasons[0]);
    const refSeasons = ref.get(key);
    if (!refSeasons || refSeasons.length !== seasons.length || !seasons.every(s => M.showIdentity(s) === key)) {
      throw new Error(`grouping differs for ${seasons[0].show_title}`);
    }
    const m = M.migrateShow(refSeasons);
    if (m.status !== seasons[0].show_status) throw new Error(`status differs for ${seasons[0].show_title}`);
    for (const s of seasons) if (s.skipped !== m.skippedIds.has(s.id)) throw new Error(`skip flag differs for ${seasons[0].show_title}`);
    const jsUp = M.upNext(seasons);
    if ((jsUp ? jsUp.id : null) !== ups.get(showId)) throw new Error(`up next differs for ${seasons[0].show_title}`);
  }
  ok(`production data: all ${byShow.size} shows match the reference (grouping, status, skip flags, up next)`);
}
