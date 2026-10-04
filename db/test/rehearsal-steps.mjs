// Steps for tools/db-rehearsal.mjs after the backup is loaded: the migration in
// phase order, each followed by its SQL self-checks (db/test/t_*.sql).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

export default function register(ctx) {
  const { step, exec, db } = ctx;

  // Runs a self-check script (prelude + checks) and fails the step on any failed check.
  async function checks(file) {
    const out = await db.exec(read('db/test/_prelude.sql') + '\n' + read(file));
    const last = out.at(-1).rows[0];
    const results = JSON.parse(last.results || '[]');
    for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.check}${r.ok ? '' : `\n       ${r.detail}`}`);
    const failed = results.filter(r => !r.ok).length;
    if (failed) throw new Error(`${failed} check(s) failed in ${file}`);
    console.log(`  ${last.passed} checks passed in ${file}`);
  }
  ctx.checks = checks;

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
