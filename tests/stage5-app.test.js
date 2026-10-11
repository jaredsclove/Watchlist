// Offline tests for the page against the Stage 5 database phases (db/phase5a_expand.sql,
// db/phase5c_contract.sql), in the whole-page harness:
//   * the phase read at startup (stage5_capabilities, GET) and the notice when it is absent;
//   * no request ever names a storage value or a retired function, in either phase
//     (the request scan), and no app script refers to one (the source scan, with its
//     allowlist); the format-3 module is the one place that knows the old shape;
//   * the main flows against a contracted database: reads, additions, Match, catalog
//     updates, memberships, backup format 4 and its restore, a format-3 restore
//     converted in the page (with or without the recovery section);
//   * phase transitions while a backup, restore or write is being prepared: consistent
//     success or a safe refusal, never a partial backup file, a fallback write or an
//     automatic retry of an unknown outcome;
//   * catalog conflicts shown with their candidates, never resolved by the page (U7);
//     Match into a show a catalog governs is refused and changes nothing (U1).
// The database side is checked on PGlite (db/test/t_5a_expand.sql, db/test/t_5c_contract.sql,
// tools/db-rehearsal-5.mjs); the harness's library_* functions are independent stand-ins.
// Run from the repo root: node tests/stage5-app.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('stage5-app');
const test = T.test;
const ROOT = path.join(__dirname, '..');
const out = v => JSON.parse(JSON.stringify(v));

let n = 0;
const uuid = p => `${p}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const TS = '2026-10-01T00:00:00+00:00';
const showOf = (o = {}) => ({ id: uuid('5a000000'), collection: 'othertv', title: 'Show', show_key: 'show', tmdb_id: null, status: 'confirmed', created_at: TS, ...o });
const seasonOf = (sh, o = {}) => ({ id: uuid('5b000000'), collection: sh.collection, title: sh.title, theme: 'Net', status: 'confirmed', watched: false, skipped: false,
  show_id: sh.id, media_type: sh.tmdb_id != null ? 'tv' : null, tmdb_id: sh.tmdb_id, season_number: sh.tmdb_id != null ? 1 : null, season: 'Season 1',
  display_date: 'Jan 1, 2020', date_sort: '2020-01-01', item_key: `${sh.show_key}|season 1`, watch_with: [], collections: [], created_at: TS,
  tmdb_collection_id: null, tmdb_collection_name: null, ...o });
const filmOf = (o = {}) => ({ id: uuid('f0000000'), collection: 'movies', title: 'Film', theme: 'Drama', status: 'confirmed', watched: false, skipped: false,
  show_id: null, media_type: 'movie', tmdb_id: 900 + n, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], created_at: TS, tmdb_collection_id: null, tmdb_collection_name: null, ...o });
function library() {
  const sev = showOf({ title: 'Severance', show_key: 'severance', tmdb_id: 95396, status: 'watching' });
  const local = showOf({ title: 'Local Show', show_key: 'local show' });
  const andor = showOf({ title: 'Andor', show_key: 'andor', collection: 'disney' });
  return {
    tvShows: [sev, local, andor],
    rows: [seasonOf(sev), seasonOf(local), seasonOf(andor),
      filmOf({ id: 'f0000000-0000-4000-8000-0000000000d1', title: 'Dune', tmdb_id: 438631, item_key: 'dune|film' }),
      filmOf({ id: 'f0000000-0000-4000-8000-0000000000d2', title: 'Hand Film', media_type: null, tmdb_id: null, item_key: 'hand film|film' })],
    sev, local, andor
  };
}
const TMDB = {
  '/tv/95396': { id: 95396, name: 'Severance', networks: [{ name: 'Apple TV' }], seasons: [{ season_number: 1, air_date: '2022-02-18', episode_count: 9 }, { season_number: 2, air_date: '2025-01-17', episode_count: 10 }] },
  '/tv/777': { id: 777, name: 'Brand New', networks: [{ name: 'HBO' }], seasons: [{ season_number: 1, air_date: '2026-01-01', episode_count: 6 }] },
  '/tv/888': { id: 888, name: 'Local Show', networks: [{ name: 'BBC' }], seasons: [{ season_number: 1, air_date: '2019-01-01', episode_count: 6 }] },
  '/movie/999': { id: 999, title: 'New Film', release_date: '2026-05-01', genres: [{ name: 'Comedy' }], belongs_to_collection: null },
  '/movie/555': { id: 555, title: 'Hand Film', release_date: '2020-01-01', genres: [{ name: 'Drama' }], belongs_to_collection: null, production_companies: [] }
};
const tmdb = p => {
  if (p.startsWith('/search/')) {
    const q = decodeURIComponent((p.match(/query=([^&]*)/) || [])[1] || '').toLowerCase();
    const all = Object.values(TMDB);
    return { results: p.startsWith('/search/tv') ? all.filter(x => x.name && x.name.toLowerCase().includes(q)).map(x => ({ id: x.id, name: x.name, first_air_date: '2022-01-01' }))
      : all.filter(x => x.title && x.title.toLowerCase().includes(q)).map(x => ({ id: x.id, title: x.title, release_date: x.release_date })) };
  }
  return TMDB[p];
};
async function boot(stage5 = 'contracted', opts = {}) {
  const lib = library();
  const app = await createApp({ rows: lib.rows, tvShows: lib.tvShows, tmdb, stage5, ...opts });
  return { app, lib };
}
const writes = app => app.writes().map(r => `${r.method} ${r.url.split('/rest/v1/')[1].split('?')[0]}`);
const outcome = app => (app.el('libraryOutcome')?.innerHTML || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const banners = app => (app.el('phaseBanner').innerHTML + app.el('banner').innerHTML + app.el('errorBanner').innerHTML + app.el('noticeBanner').innerHTML).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const noStorage = app => assert.deepStrictEqual(app.storageRequests().map(r => `${r.method} ${r.url}`), [], 'no request names a storage value or a retired function');
const noRefusal = app => assert.ok(!/library_write_required|does not exist|schema cache|client_outdated/.test(banners(app) + outcome(app)), banners(app) + outcome(app));
async function allTv(app) { app.ctx.switchView('alltv'); await settle(); app.el('fStatus').value = 'all'; app.ctx.renderTable(); }
async function choose(app, id, name, type = 'tv') {
  app.el('tmdbQuery').value = name; await app.ctx.searchTMDB(); await settle();
  await app.ctx.selectTMDBShow(id, name, type, `tmdbResult_0_${id}`); await settle();
}
const tick = (app, nums) => { app.el('tmdbPreview').querySelectorAll = sel => (sel.includes('data-season') ? nums.map(x => ({ checked: true, disabled: false, dataset: { season: String(x) } })) : []); };

// ─── The phase ────────────────────────────────────────────────────────────────
test('startup reads the phase once with GET (stage5_capabilities) and keeps it; nothing is written', async () => {
  for (const phase of ['coexistence', 'contracted']) {
    const { app } = await boot(phase);
    const reads = app.requests.filter(r => r.url.endsWith('/rpc/stage5_capabilities'));
    assert.deepStrictEqual(reads.map(r => r.method), ['GET'], phase);
    assert.strictEqual(app.get('stage5Phase'), phase);
    assert.deepStrictEqual(app.writes(), []);
    assert.strictEqual(app.el('errorBanner').innerHTML, '', 'no notice');
  }
});

test('a database without the Stage 5 update: its own notice, which a view’s message never replaces; nothing is written; no older function is tried', async () => {
  const { app } = await boot(null);
  assert.strictEqual(app.get('stage5Phase'), null);
  for (const v of ['alltv', 'comingsoon']) { app.ctx.switchView(v); await settle(); }
  assert.match(app.el('phaseBanner').innerHTML, /needs a database update that hasn’t been made yet/);
  assert.deepStrictEqual(app.writes(), []);
  noStorage(app);
});

// ─── Request scan (A13, app side) ─────────────────────────────────────────────
for (const phase of ['coexistence', 'contracted']) {
  test(`request scan (${phase}): every view, the panel’s additions, Match, a catalog application, a membership and a backup — no storage value, no retired function, no refusal`, async () => {
    const { app, lib } = await boot(phase);
    for (const v of ['watching', 'alltv', 'comingsoon']) { app.ctx.switchView(v); await settle(); }
    app.ctx.openBrowseCollection(app.browseId('disney')); await settle();
    app.ctx.switchMediaType('movie'); await settle();
    app.ctx.switchMediaType('tv'); await allTv(app);
    // a new show from TMDB, a season to an identified show, a show by hand
    app.ctx.openLibraryPanel('tv'); await settle();
    await choose(app, 777, 'Brand New'); tick(app, [1]);
    await app.ctx.addSelectedTMDBSeasons(); await settle();
    await choose(app, 95396, 'Severance'); tick(app, [2]);
    await app.ctx.addSelectedTMDBSeasons(); await settle();
    app.ctx.openLibraryPanel('tv', 'manual'); await settle();
    app.el('nTitle').value = 'ZZ Hand'; app.el('nSeason').value = 'Season 1'; app.el('nTheme').value = 'BBC'; app.el('nDate').value = 'Jan 1, 2027';
    await app.ctx.libraryManualShow(); await settle();
    // Match a season (All TV) and a film (All Movies)
    const localRow = lib.rows.find(r => r.show_id === lib.local.id);
    app.run(`window.__tmdbMatch = { rowId: ${JSON.stringify(localRow.id)}, results: [], target: { mediaType: 'tv', seasonNumber: 1, details: ${JSON.stringify(TMDB['/tv/888'])} } };`);
    await app.ctx.confirmTmdbMatch(); await settle();
    app.ctx.switchMediaType('movie'); await settle();
    app.el('fWatch').value = ''; app.ctx.renderTable();
    app.run(`window.__tmdbMatch = { rowId: 'f0000000-0000-4000-8000-0000000000d2', results: [], target: { mediaType: 'movie', details: ${JSON.stringify(TMDB['/movie/555'])} } };`);
    await app.ctx.confirmTmdbMatch(); await settle();
    // a film from TMDB
    app.ctx.openLibraryPanel('movie'); await settle();
    await choose(app, 999, 'New Film', 'movie');
    await app.ctx.addSelectedTMDBSeasons(); await settle();
    // a catalog application (through the dialog) and a membership
    app.ctx.switchMediaType('tv'); await allTv(app);
    app.ctx.openCatalogUpdates('sheridan'); await settle();
    await app.ctx.catalogApply(); await settle();
    app.ctx.closeCatalogUpdates(); await settle();
    const sheridan = app.store.personal_collections.find(c => c.legacy_source === 'sheridan');
    await app.ctx.fetch(`${app.get('SUPABASE_URL')}/rest/v1/rpc/org_add_membership`, { method: 'POST', headers: {}, body: JSON.stringify({ p_collection_id: sheridan.id, p_show_id: lib.sev.id, p_item_id: null }) });
    noStorage(app);
    noRefusal(app);
    // A backup: format 4 once contracted (no storage); format 3 during coexistence, which reads the
    // storage columns by design (GET only, the format-3 shape kept until the contraction).
    const before = app.requests.length;
    const b = await app.ctx.buildBackupObject();
    assert.strictEqual(b.formatVersion, phase === 'contracted' ? 4 : 3);
    const backupReads = app.requests.slice(before);
    assert.ok(backupReads.every(r => r.method === 'GET'));
    if (phase === 'contracted') noStorage(app);
    assert.deepStrictEqual([...new Set(writes(app).map(w => w.split(' ')[1]))].sort(),
      ['rpc/library_add_films', 'rpc/library_add_seasons', 'rpc/library_catalog_apply', 'rpc/library_create_show', 'rpc/library_match_film', 'rpc/library_match_season', 'rpc/org_add_membership']);
    assert.ok(app.store.watchlist_items.some(r => r.tmdb_id === 999), 'the film was added');
    assert.ok(app.store.watchlist_items.some(r => r.id === localRow.id && r.tmdb_id === 888), 'the season was matched');
  });
}

// ─── Source scan (A13, source side) ───────────────────────────────────────────
test('source scan: no app script but backup-format3.js names a storage value, a retired column or table, or a retired function (allowlisted lines listed)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'watchlist.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"?]+\.js)[^"]*"/g)].map(m => m[1]).filter(s => !/^https?:/.test(s));
  assert.ok(scripts.includes('library.js') && scripts.includes('backup-format3.js'));
  const RULE = /legacy_source|othertv_shows|collection=|\.collection\b|['"]collection['"]|\badd_tv_seasons\b|add_tv_seasons_to_show|create_tv_show|match_tv_row|(?<![_a-z])catalog_apply|seed_tv_defaults|tv_collections|isTvCollection|tv_backfill|org_bootstrap/;
  // Each allowlisted line is not a storage value: a tag-filter kind, a personal collection returned by
  // the organization functions, a TMDB franchise label, or config.js's unused BACKUP_TABLES (config.js
  // is synced from the catalog source and isn't edited here; the constant is read by nothing).
  const ALLOW = [
    ['config.js', /^const BACKUP_TABLES = /],
    ['render.js', /filterPillHtml\('collection', c, c, \{ cls: 'collection-tag'/],
    ['collections-pull.js', /tmdbLookupFailureNote\(collectionsMap\.size, failedCollections, 'collection'\)/],
    ['organization-manage.js', /res\.collection \|\| res\.choice|const noun = choice \? 'watch-with choice' : 'collection'|if \(res\.collection\) put\(d\.collections, res\.collection\)|manageCreate\('collection'\)/],
    ['browse-views.js', /Pull rest of \$\{esc\(franchise \|\| 'collection'\)\}/]
  ];
  const hits = [];
  for (const f of scripts) {
    if (f === 'backup-format3.js') continue;
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (!RULE.test(line) || /^\s*\/\//.test(line)) return;
      if (ALLOW.some(([af, re]) => af === f && re.test(line.trim()))) return;
      hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(hits, []);
  // The one module that knows format 1–3 shapes, and nothing else does.
  const f3 = fs.readFileSync(path.join(ROOT, 'backup-format3.js'), 'utf8');
  assert.ok(/othertv_shows/.test(f3) && /legacy_source/.test(f3));
});

// ─── Contracted flows ─────────────────────────────────────────────────────────
test('contracted: Match into a show a catalog governs is refused (match_target_governed); the row and the show are unchanged; nothing is offered instead (U1)', async () => {
  const { app, lib } = await boot('contracted');
  // The governed Andor gets a TMDB identity; an unidentified season elsewhere is matched to it.
  lib.andor.tmdb_id = 1234;
  app.store.tv_shows.find(s => s.id === lib.andor.id).tmdb_id = 1234;
  const localRow = lib.rows.find(r => r.show_id === lib.local.id);
  await allTv(app);
  const before = JSON.stringify([app.store.watchlist_items, app.store.tv_shows, app.store.collection_memberships]);
  // (Season 2: the governed show has no season with that key, so only the governance refusal applies.)
  app.run(`window.__tmdbMatch = { rowId: ${JSON.stringify(localRow.id)}, results: [], target: { mediaType: 'tv', seasonNumber: 2, details: { id: 1234, name: 'Andor', networks: [], seasons: [{ season_number: 1, air_date: '2022-09-21' }, { season_number: 2, air_date: '2025-04-22' }] } } };`);
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.match(banners(app), /part of a built-in catalog on your list, so this row wasn.t matched to it\. Nothing was changed\./);
  assert.ok(!/Add season/.test(banners(app)), 'Add season is not presented as a substitute');
  assert.strictEqual(JSON.stringify([app.store.watchlist_items, app.store.tv_shows, app.store.collection_memberships]), before);
  assert.deepStrictEqual(writes(app), ['POST rpc/library_match_season']);
});

test('contracted: Match is not offered for a governed entry (a governed film, a season of a governed show); the database refuses it too', async () => {
  const { app, lib } = await boot('contracted');
  const andorRow = lib.rows.find(r => r.show_id === lib.andor.id);
  await allTv(app);
  assert.strictEqual(app.get(`isTmdbMatchEligible(derivedData.rows.find(r => r.id === ${JSON.stringify(andorRow.id)}))`), false);
  const res = await app.rpcHandlers.library_match_season({ p_row_id: andorRow.id, p_target: { tmdb_id: 1 }, p_patch: {} }).json();
  assert.match(res.message, /not_eligible/);
});

test('contracted: backup is format 4 (no storage, theme_kind, governance tables, no othertv_shows); it validates and restores through restore_backup; verification passes', async () => {
  const { app } = await boot('contracted');
  app.store.watchlist_items.push(filmOf({ collection: 'disney', title: 'Disney Film', media_type: null, tmdb_id: null, item_key: 'disney film|film' })); // a governed film
  const b = await app.ctx.buildBackupObject();
  assert.strictEqual(b.tables.catalog_show_links.length, 1);
  assert.strictEqual(b.tables.catalog_film_links.length, 1);
  assert.strictEqual(b.formatVersion, 4);
  assert.ok(!('othertv_shows' in b.tables));
  assert.ok(b.tables.watchlist_items.every(r => !('collection' in r) && 'theme_kind' in r));
  assert.ok(b.tables.tv_shows.every(s => !('collection' in s)));
  assert.ok(['catalog_show_links', 'catalog_film_links'].every(t => Array.isArray(b.tables[t])));
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(b)), []);
  app.ctx.__b = b;
  await app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 4');
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  noStorage(app);
});

for (const archive of ['active', 'retired']) {
  test(`contracted: a format-3 file is converted in the page (previewed, loss-aware${archive === 'active' ? ', with its recovery section' : ', without a recovery section once the archive is retired'}); only the converted document is sent`, async () => {
    const co = await boot('coexistence');
    const f3 = await co.app.ctx.buildBackupObject();
    assert.strictEqual(f3.formatVersion, 3);
    const { app } = await boot('contracted', { recoveryArchive: archive });
    app.ctx.__b = f3;
    await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
    const preview = app.el('restoreModalBox').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(preview, /format 3/i);
    assert.match(preview, /Restore database/);
    const sent = app.get('pendingRestoreData');
    assert.strictEqual(sent.formatVersion, 4);
    assert.strictEqual(!!sent.recovery, archive === 'active', 'the recovery section only while the archive is active');
    assert.ok(sent.conversion && sent.conversion.source_format === 3);
    await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
    const calls = app.requests.filter(r => r.url.endsWith('/rpc/restore_backup'));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].body.p_backup.formatVersion, 4, 'never the format-3 file itself');
    assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  });
}

// PostgREST returns timestamptz as e.g. "…05.325+00:00", while the converter stamps the new link
// rows with the file's exportedAt ("…05.325Z"): the same instant must verify; another must not.
for (const [label, shift, verified] of [['the same instant in the database’s form', 0, true], ['a different instant (1 µs later)', 1, false]]) {
  test(`contracted: converted format-3 restore whose link created_at comes back as ${label} ${verified ? 'verifies' : 'fails verification'}`, async () => {
    const co = await boot('coexistence');
    const f3 = await co.app.ctx.buildBackupObject();
    const { app } = await boot('contracted', { recoveryArchive: 'active' });
    const asDb = ts => ts.replace(/(\.\d{3})Z$/, (m, f) => `${shift ? (f + '00' + shift) : f.replace(/0+$/, '').replace(/\.$/, '')}+00:00`);
    const restore = app.rpcHandlers.restore_backup;
    app.rpcHandlers.restore_backup = body => {
      const r = restore(body);
      for (const l of [...app.store.__links.shows, ...app.store.__links.films]) l.created_at = asDb(l.created_at);
      return r;
    };
    app.ctx.__b = f3;
    await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
    const sent = app.get('pendingRestoreData');
    assert.ok(sent.tables.catalog_show_links.length > 0 && sent.tables.catalog_show_links.every(l => /Z$/.test(l.created_at)));
    await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
    assert.ok(app.store.__links.shows.every(l => /\+00:00$/.test(l.created_at)));
    const html = app.el('restoreModalBox').innerHTML;
    if (verified) assert.match(html, /restored and verified/);
    else { assert.match(html, /verification failed/); assert.match(html, /catalog_show_links[\s\S]*created_at/); }
  });
}

test('contracted: a format-4 file into a database that is not contracted is refused before anything happens', async () => {
  const c = await boot('contracted');
  const f4 = await c.app.ctx.buildBackupObject();
  const { app } = await boot('coexistence');
  app.ctx.__b = f4;
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /format 4, from after the database update; this database hasn’t been updated yet/);
  assert.deepStrictEqual(app.writes(), []);
});

// ─── Phase transitions while something is being prepared (#3) ─────────────────
test('transition during a backup: the phase changes between the first and last reads → no file, a clear message, nothing written', async () => {
  const { app } = await boot('coexistence');
  let downloads = 0;
  app.ctx.downloadJSON = () => { downloads++; };
  const g = app.hold(r => r.method === 'GET' && r.url.includes('/tv_shows?') && r.headers.Range);
  const p = app.ctx.buildBackupObject().then(() => 'made', e => e.message);
  await g.reached;
  app.stage5 = 'contracted'; // the contraction commits while the backup is being read
  g.release();
  const res = await p;
  assert.match(res, /The database was updated while the backup was being read, so no file was made/);
  assert.strictEqual(downloads, 0);
  assert.deepStrictEqual(app.writes(), []);
});

test('transition: the phase can’t be read (HTTP 500) → no backup file and no guess (never the format-3 shape by default)', async () => {
  const { app } = await boot('contracted');
  app.failNext(r => r.url.endsWith('/rpc/stage5_capabilities'));
  const res = await app.ctx.buildBackupObject().then(() => 'made', e => e.message);
  assert.notStrictEqual(res, 'made');
  assert.deepStrictEqual(app.writes(), []);
});

test('transition after a restore was previewed: the safety backup finds the database updated → aborted before any download or restore call', async () => {
  const { app } = await boot('coexistence');
  let downloads = 0;
  app.ctx.downloadJSON = () => { downloads++; };
  const f3 = await app.ctx.buildBackupObject();
  app.ctx.__b = f3;
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /Restore database/);
  app.stage5 = 'contracted';
  await app.ctx.executeRestore(); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /The database was updated after this restore was prepared, so nothing was changed/);
  assert.strictEqual(downloads, 0, 'no safety file');
  assert.ok(!app.requests.some(r => r.url.endsWith('/rpc/restore_backup')));
});

test('transition after the safety backup was confirmed: the phase is read again before sending; a changed phase sends nothing (no conversion, no retry); the safety file stays named', async () => {
  const { app } = await boot('coexistence');
  const f3 = await app.ctx.buildBackupObject();
  app.ctx.__b = f3;
  await app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 3');
  app.stage5 = 'contracted';
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle(); await settle();
  assert.strictEqual(app.requests.filter(r => r.url.endsWith('/rpc/restore_backup')).length, 0, 'nothing sent');
  assert.match(app.el('restoreModalBox').innerHTML, /Restore not sent[\s\S]*changed after this restore was prepared, so nothing was sent and nothing was changed/);
  // (The database itself refuses a format-3 document once contracted: db/test/t_5c_contract.sql.)
});

test('a database without the Stage 5 update (or one rolled back meanwhile): no restore is offered, nothing is sent at any step, and no write of any kind leaves the page', async () => {
  const { app } = await boot('coexistence');
  let downloads = 0;
  app.ctx.downloadJSON = () => { downloads++; };
  const b = await app.ctx.buildBackupObject();
  await allTv(app);                                   // the page loaded while the database was updated …
  app.stage5 = null;                                  // … then the expansion was rolled back
  app.ctx.__b = b;
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /Restore isn't available[\s\S]*needs a database update/);
  assert.ok(!app.el('restoreModalBox').innerHTML.includes('executeRestore()'));
  await app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 3');
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /Restore not sent[\s\S]*couldn’t be confirmed/);
  // Ordinary writes: the cached phase is cleared on a failed check, so every write is refused before sending.
  app.run('stage5Phase = null');
  const sev = app.store.watchlist_items.find(r => r.title === 'Severance');
  await app.ctx.toggleWatch(sev.id); await settle();
  await app.ctx.setShowStatusById(sev.show_id, 'complete'); await settle();
  assert.deepStrictEqual(app.writes(), [], 'no write of any kind');
  assert.strictEqual(downloads, 0);
});

test('transition while an addition is prepared: the same library function in both phases → it succeeds; nothing older is tried', async () => {
  const { app, lib } = await boot('coexistence');
  await allTv(app);
  app.ctx.openLibraryPanel('tv'); await settle();
  await choose(app, 95396, 'Severance'); tick(app, [2]);
  app.stage5 = 'contracted'; // the contraction lands between the preview and Add
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_add_seasons']);
  assert.ok(app.store.watchlist_items.some(r => r.show_id === lib.sev.id && r.season_number === 2));
  noStorage(app);
});

test('transition while an addition is out: no clear answer → reported unconfirmed, never resent, no fallback', async () => {
  const { app } = await boot('coexistence');
  await allTv(app);
  app.ctx.openLibraryPanel('tv'); await settle();
  await choose(app, 95396, 'Severance'); tick(app, [2]);
  const g = app.hold(r => r.url.endsWith('/rpc/library_add_seasons'));
  const p = app.ctx.addSelectedTMDBSeasons();
  await g.reached;
  app.stage5 = 'contracted';
  g.fail(); await p; await settle();
  assert.match(outcome(app), /no clear answer came back/);
  await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_add_seasons'], 'one call');
});

test('transition while a catalog preview is open: Apply uses library_catalog_apply in either phase; the Stage 4a function is never called', async () => {
  const { app } = await boot('coexistence');
  await allTv(app);
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  assert.match(app.el('catalogModalBox').innerHTML, /catalogApply\(\)/);
  app.stage5 = 'contracted';
  await app.ctx.catalogApply(); await settle();
  const t = app.el('catalogModalBox').innerHTML.replace(/<[^>]+>/g, ' ');
  assert.ok(/Applied \d+ change/.test(t) || /changed since this preview/.test(t), t);
  assert.ok(!app.requests.some(r => /\/rpc\/catalog_apply$/.test(r.url)));
  assert.strictEqual(app.requests.filter(r => r.url.endsWith('/rpc/library_catalog_apply') && r.body.p_approved).length, 1, 'one apply, never retried');
});

// ─── Catalog conflicts (U7) ───────────────────────────────────────────────────
test('catalog conflicts are shown as not included, with their reason and the candidate records; nothing is adopted, merged or created for them (U7)', async () => {
  const { app } = await boot('coexistence');
  const def = app.get("COLLECTIONS.find(c => c.id === 'sheridan').defaults.find(d => d.s !== 'Film')");
  // Two unidentified shows outside the catalog already use the catalog show's key: ambiguous.
  const key = app.get(`catalogShowKey('sheridan', ${JSON.stringify(def.k)})`);
  const a = showOf({ title: def.t, show_key: key }), b = showOf({ title: def.t, show_key: key, collection: 'truecrime' });
  app.store.tv_shows.push(a, b);
  app.store.watchlist_items.push(seasonOf(a, { item_key: `${key}|zz other season`, season: 'ZZ Other' }), seasonOf(b, { item_key: `${key}|zz third`, season: 'ZZ Third' }));
  await allTv(app);
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  const doc = app.get('catalogDialog.preview.document');
  const conflicts = doc.entries.filter(e => e.kind === 'excluded_conflict' && ['existing_record', 'ambiguous'].includes(e.reason));
  assert.ok(conflicts.length >= 1, JSON.stringify(doc.entries.filter(e => e.kind === 'excluded_conflict')));
  assert.ok(conflicts.every(e => Array.isArray(e.candidates) && e.candidates.length >= 1));
  const t = app.el('catalogModalBox').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(t, /Not included — needs review/);
  const showsBefore = app.store.tv_shows.length;
  await app.ctx.catalogApply(); await settle();
  assert.strictEqual(app.store.tv_shows.filter(s => s.show_key === key).length, 2, 'neither candidate adopted or merged, no third show');
  assert.ok(app.store.tv_shows.length >= showsBefore);
  assert.ok(!app.store.tv_shows.some(s => s.show_key === key && s.collection === 'sheridan'), 'no unidentified duplicate created');
});

// ─── True Crime / Docs presentation (no storage routing) ──────────────────────
for (const phase of ['coexistence', 'contracted']) {
  test(`(${phase}) True Crime / Docs keeps its note and its remembered layout key through its presentation key; nothing reads storage`, async () => {
    const { app } = await boot(phase);
    const tc = app.store.personal_collections.find(c => c.legacy_source === 'truecrime');
    const store = { data: { watchlist_browse_layout_truecrime: '{"presentation":"seasons","grouping":"combined"}' } };
    app.ctx.localStorage = { getItem: k => store.data[k] ?? null, setItem: (k, v) => { store.data[k] = v; } };
    app.ctx.openBrowseCollection(`browse:${tc.id}`); await settle();
    assert.match(app.el('viewHead').innerHTML, /True Crime and Documentary are not yet classified separately/);
    assert.strictEqual(app.get('browsePresentation'), 'seasons', 'the remembered layout (old device key) applies');
    assert.ok(app.requests.some(r => r.url.includes('/library_collection_presentation?')));
    noStorage(app);
  });
}

test('contracted: a converted format-3 restore keeps every collection’s presentation key (True Crime included); format 4 carries it', async () => {
  const co = await boot('coexistence');
  const f3 = await co.app.ctx.buildBackupObject();
  const { app } = await boot('contracted');
  const conv = app.ctx.convertFormat3To4(f3, { includeRecovery: true, sourceSha256: 'a'.repeat(64) });
  const tc = f3.tables.personal_collections.find(c => c.legacy_source === 'truecrime');
  assert.strictEqual(conv.doc.tables.personal_collections.find(c => c.id === tc.id).presentation_key, 'truecrime');
  assert.strictEqual(conv.doc.tables.personal_collections.find(c => c.id === tc.id).catalog_id, null, 'True Crime governs nothing');
  const f4 = await app.ctx.buildBackupObject();
  assert.ok(f4.tables.personal_collections.every(c => 'presentation_key' in c));
  const bad = JSON.parse(JSON.stringify(f4));
  bad.tables.personal_collections[0].presentation_key = 'movies';
  assert.ok(Array.from(app.ctx.validateBackupObject(bad)).some(e => /presentation_key "movies"/.test(e)));
});

// ─── Catalog twins (F2): acknowledged distinct works only ─────────────────────
async function withCatalogShow(phase, title) {
  const r = await boot(phase);
  const s = showOf({ title, show_key: title.toLowerCase() + ' (catalog)', collection: 'sheridan' });
  r.app.store.tv_shows.push(s);
  r.app.store.watchlist_items.push(seasonOf(s));
  return { ...r, catalogShow: s };
}
for (const phase of ['coexistence', 'contracted']) {
  test(`(${phase}) a TMDB show titled like a catalog show (different key): shown first; "Add as a new show" sends that id (distinct_from) and is created`, async () => {
    const { app, catalogShow } = await withCatalogShow(phase, 'Brand New');
    await allTv(app);
    app.ctx.openLibraryPanel('tv'); await settle();
    await choose(app, 777, 'Brand New');
    assert.match(app.el("tmdbPreview").innerHTML, /is already on your list[^.]*\(in the Sheridan catalog\)/);
    assert.deepStrictEqual(app.writes(), []);
    app.ctx.libraryChoose(777, 'tv', null, true); await settle();
    tick(app, [1]);
    await app.ctx.addSelectedTMDBSeasons(); await settle();
    const [call] = app.writes().filter(r => r.url.endsWith('/rpc/library_create_show'));
    assert.deepStrictEqual(Array.from(call.body.p_show.distinct_from), [catalogShow.id]);
    assert.ok(app.store.tv_shows.some(x => x.tmdb_id === 777), 'the confirmed distinct work exists');
  });
}

test('a catalog show that appears after the preview: nothing is sent (the preview no longer applies); the database refuses an unacknowledged twin anyway', async () => {
  const { app } = await boot('contracted');
  await allTv(app);
  app.ctx.openLibraryPanel('tv'); await settle();
  await choose(app, 777, 'Brand New');
  tick(app, [1]);
  const s = showOf({ title: 'Brand New', show_key: 'brand new (catalog)', collection: 'sheridan' });
  app.store.tv_shows.push(s); app.store.watchlist_items.push(seasonOf(s)); // a catalog application meanwhile
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.deepStrictEqual(app.writes(), []);
  assert.match(outcome(app), /Your list changed since this preview, so nothing was added/);
  const res = await app.rpcHandlers.library_create_show({ p_show: { tmdb_id: 778, title: 'Brand New', show_key: 'brand new' },
    p_seasons: [{ item_key: 'brand new|season 1', title: 'Brand New', season: 'Season 1', date_sort: '2026-01-01', season_number: 1 }] }).json();
  assert.match(res.message, /^catalog_candidate:/);
  assert.deepStrictEqual(JSON.parse(res.details).candidates, [s.id]);
});

test('a film by hand titled like a catalog film: shown first; the confirmation acknowledges it (distinct_from) and the film is created', async () => {
  const { app } = await boot('contracted');
  const cat = filmOf({ title: 'Hell or High Water', collection: 'sheridan', media_type: null, tmdb_id: null, item_key: 'hell or high water|film' });
  app.store.watchlist_items.push(cat);
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openLibraryPanel('movie', 'manual'); await settle();
  app.el('nTitle').value = 'Hell or High Water'; app.el('nTheme').value = 'Drama'; app.el('nDate').value = 'Jan 1, 2030';
  await app.ctx.libraryManualFilm(); await settle();
  assert.deepStrictEqual(app.writes(), []);
  await app.ctx.libraryManualFilm(); await settle();
  const [call] = app.writes().filter(r => r.url.endsWith('/rpc/library_create_film'));
  assert.deepStrictEqual(Array.from(call.body.p_film.distinct_from), [cat.id]);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.title === 'Hell or High Water').length, 2);
});

test('movie tools: a TMDB film titled like a catalog film is not added (catalog_candidate) and is named in the notice; the others are added', async () => {
  const { app } = await boot('contracted');
  app.store.watchlist_items.push(filmOf({ title: 'Twin Film', collection: 'sheridan', media_type: null, tmdb_id: null, item_key: 'twin film|film' }));
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openLibraryPanel('movie', 'tools'); await settle();
  await app.ctx.libraryPrepareMovieTools(); await settle();
  const ins = await app.ctx.libraryInsertFilms([
    { item_key: 'twin film|film', title: 'Twin Film', season: 'Film', theme: 'Drama', date_sort: '2020-01-01', tmdb_id: 4001, media_type: 'movie' },
    { item_key: 'other film|film', title: 'Other Film', season: 'Film', theme: 'Drama', date_sort: '2020-01-01', tmdb_id: 4002, media_type: 'movie' }]);
  assert.deepStrictEqual(Array.from(ins, r => r.tmdb_id), [4002]);
  assert.match(app.el('banner').innerHTML, /Not added: Twin Film — a built-in catalog film with the same name/);
});

// ─── Match close to catalog records: every candidate read and shown with the target ──
// The database names the candidate ids (catalog_candidate); the page reads each one (GET)
// with its governing catalog and shows them beside the proposed target. Only that set,
// for that target, is acknowledged (distinct_from); a failed or incomplete read can't be
// confirmed; a set that changed is shown again for a new confirmation.
const twinsText = app => app.el('tmdbMatchBody').innerHTML.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const twinButton = app => (app.el('tmdbMatchBody').innerHTML.match(/<button[^>]*confirmTmdbMatchDistinct[^>]*>/) || [''])[0];
const matchCalls = (app, fn) => app.writes().filter(r => r.url.endsWith(`/rpc/${fn}`));
async function showTwins(phase) {
  const r = await withCatalogShow(phase, 'Local Show Renamed');
  // A second catalog show with another title whose key is the name the match would give.
  const keyTwin = showOf({ title: 'Renamed Locally', show_key: 'local show renamed', collection: 'disney' });
  r.app.store.tv_shows.push(keyTwin); r.app.store.watchlist_items.push(seasonOf(keyTwin));
  await allTv(r.app);
  r.app.addEl('tmdbMatchBody');
  const row = r.lib.rows.find(x => x.show_id === r.lib.local.id);
  r.app.run(`window.__tmdbMatch = { rowId: ${JSON.stringify(row.id)}, results: [], target: { mediaType: 'tv', seasonNumber: 1, details: { id: 889, name: 'Local Show Renamed', networks: [], seasons: [{ season_number: 1, air_date: '2019-01-01' }] } } };`);
  return { ...r, keyTwin, row };
}
for (const phase of ['coexistence', 'contracted']) {
  test(`(${phase}) Match close to two catalog shows (one only by key, another title): both are read and shown with their catalog beside the target; confirming sends exactly those two`, async () => {
    const { app, catalogShow, keyTwin, row } = await showTwins(phase);
    await app.ctx.confirmTmdbMatch(); await settle();
    const t = twinsText(app);
    assert.match(t, /Matching “Local Show” to “Local Show Renamed”, Season 1 \(TMDB series 889, season 1\)/);
    assert.match(t, /2 built-in catalog shows on your list\. Nothing was matched\./);
    assert.match(t, /Local Show Renamed · not matched to TMDB · Sheridan catalog · same name/);
    assert.match(t, /Renamed Locally · not matched to TMDB · Disney\+ catalog · same list key \(“local show renamed”\)/);
    assert.ok(!/disabled/.test(twinButton(app)));
    const reads = app.requests.filter(r => /tv_shows\?id=in\.|library_catalog_shows\?show_id=in\./.test(r.url));
    assert.ok(reads.length === 2 && reads.every(r => r.method === 'GET'));
    assert.strictEqual(matchCalls(app, 'library_match_season').length, 1);
    await app.ctx.confirmTmdbMatchDistinct(); await settle();
    const calls = matchCalls(app, 'library_match_season');
    assert.strictEqual(calls.length, 2);
    assert.ok(!('distinct_from' in calls[0].body.p_patch));
    assert.deepStrictEqual(Array.from(calls[1].body.p_patch.distinct_from), [catalogShow.id, keyTwin.id].sort());
    assert.strictEqual(app.store.watchlist_items.find(r => r.id === row.id).tmdb_id, 889);
  });
}

test('Match candidates: a failed read can’t be confirmed (nothing sent); Retry only reads, then confirming works', async () => {
  const { app, row } = await showTwins('contracted');
  app.failNext(r => r.method === 'GET' && r.url.includes('tv_shows?id=in.'));
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.match(twinsText(app), /Couldn’t read those records .* so this can’t be confirmed yet\. Retry/);
  assert.match(twinButton(app), /disabled/);
  await app.ctx.confirmTmdbMatchDistinct(); await settle();
  assert.strictEqual(matchCalls(app, 'library_match_season').length, 1, 'nothing sent');
  const before = app.requests.length;
  await app.ctx.loadTmdbMatchTwins(app.get('window.__tmdbMatch')); await settle();
  assert.ok(app.requests.slice(before).every(r => r.method === 'GET'), 'Retry only reads');
  assert.ok(!/disabled/.test(twinButton(app)));
  await app.ctx.confirmTmdbMatchDistinct(); await settle();
  assert.strictEqual(matchCalls(app, 'library_match_season').length, 2);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === row.id).tmdb_id, 889);
});

test('Match candidates: a read that misses a candidate (or its catalog) is incomplete: not confirmable, nothing acknowledged', async () => {
  const { app, keyTwin } = await showTwins('contracted');
  const g = app.hold(r => r.method === 'GET' && r.url.includes('library_catalog_shows?show_id=in.'));
  const p = app.ctx.confirmTmdbMatch();
  await g.reached;
  assert.match(twinsText(app), /Reading those records…/);
  assert.match(twinButton(app), /disabled/);
  // The governance read doesn't include the key twin (as if no catalog governed it any more).
  g.releaseWith({ tv_shows: app.store.tv_shows.filter(x => x.id !== keyTwin.id) });
  await p; await settle();
  assert.match(twinsText(app), /Renamed Locally · not matched to TMDB · no catalog governs it now/);
  assert.match(twinsText(app), /Not every one could be read as a catalog show, so this can’t be confirmed\. Retry/);
  assert.match(twinButton(app), /disabled/);
  await app.ctx.confirmTmdbMatchDistinct(); await settle();
  assert.strictEqual(matchCalls(app, 'library_match_season').length, 1);
});

test('Match candidates: a catalog show that appears after the confirmation is refused, then shown with the others for a new confirmation (never acknowledged unseen)', async () => {
  const { app, catalogShow, keyTwin, row } = await showTwins('contracted');
  await app.ctx.confirmTmdbMatch(); await settle();
  const late = showOf({ title: 'local show renamed', show_key: 'something else', collection: '90day' });
  app.store.tv_shows.push(late); app.store.watchlist_items.push(seasonOf(late)); // added by a catalog meanwhile
  await app.ctx.confirmTmdbMatchDistinct(); await settle();
  let calls = matchCalls(app, 'library_match_season');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === row.id).tmdb_id, null, 'refused: nothing matched');
  const t = twinsText(app);
  assert.match(t, /changed since you confirmed\. Check them and confirm again\./);
  assert.match(t, /3 built-in catalog shows/);
  assert.match(t, /local show renamed · not matched to TMDB · 90 Day catalog · same name/);
  await settle();
  assert.strictEqual(matchCalls(app, 'library_match_season').length, 2, 'not resent automatically');
  await app.ctx.confirmTmdbMatchDistinct(); await settle();
  calls = matchCalls(app, 'library_match_season');
  assert.deepStrictEqual(Array.from(calls[2].body.p_patch.distinct_from), [catalogShow.id, keyTwin.id, late.id].sort());
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === row.id).tmdb_id, 889);
});

test('Match candidates for a film: the catalog film is read and shown beside the target; confirming sends its id to library_match_film', async () => {
  const { app } = await boot('contracted');
  const cat = filmOf({ title: 'Hand Film', collection: 'sheridan', media_type: null, tmdb_id: null, item_key: 'hand film (catalog)|film', display_date: 'Mar 3, 2003' });
  app.store.watchlist_items.push(cat);
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = ''; app.ctx.renderTable();
  app.addEl('tmdbMatchBody');
  const id = 'f0000000-0000-4000-8000-0000000000d2';
  app.run(`window.__tmdbMatch = { rowId: '${id}', results: [], target: { mediaType: 'movie', details: ${JSON.stringify(TMDB['/movie/555'])} } };`);
  await app.ctx.confirmTmdbMatch(); await settle();
  const t = twinsText(app);
  assert.match(t, /Matching “Hand Film” to “Hand Film” \(TMDB film 555\) would give it the name or key of a built-in catalog film/);
  assert.match(t, /Hand Film · Mar 3, 2003 · not matched to TMDB · Sheridan catalog · same name/);
  assert.match(app.el('tmdbMatchBody').innerHTML, /It is different — match anyway<\/button>/);
  assert.ok(app.requests.some(r => r.method === 'GET' && r.url.includes('library_catalog_films?item_id=in.')));
  await app.ctx.confirmTmdbMatchDistinct(); await settle();
  const calls = matchCalls(app, 'library_match_film');
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(Array.from(calls[1].body.p_patch.distinct_from), [cat.id]);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === id).tmdb_id, 555);
});

test('Match candidates: Back while they are being read; the late read never replaces the panel', async () => {
  const { app } = await showTwins('contracted');
  const g = app.hold(r => r.method === 'GET' && r.url.includes('tv_shows?id=in.'));
  const p = app.ctx.confirmTmdbMatch();
  await g.reached;
  app.ctx.renderTmdbMatchConfirm();
  const shown = app.el('tmdbMatchBody').innerHTML;
  g.release(); await p; await settle();
  assert.strictEqual(app.el('tmdbMatchBody').innerHTML, shown);
});

// ─── Genre-theme film to TV season: still refused (as before Stage 5) ─────────
for (const phase of ['coexistence', 'contracted']) {
  test(`(${phase}) a film whose theme is a genre can’t become a TV season: the page sends nothing; the database refuses it too (genre_film_season)`, async () => {
    const { app } = await boot(phase);
    app.ctx.switchMediaType('movie'); await settle();
    app.el('fWatch').value = ''; app.ctx.renderTable();
    const id = 'f0000000-0000-4000-8000-0000000000d2'; // Hand Film: stored with the films (a genre theme)
    app.run(`window.__tmdbMatch = { rowId: '${id}', results: [], target: { mediaType: 'tv', seasonNumber: 1, details: ${JSON.stringify(TMDB['/tv/888'])} } };`);
    await app.ctx.confirmTmdbMatch(); await settle();
    assert.deepStrictEqual(app.writes(), []);
    assert.match(app.el('errorBanner').innerHTML, /genre can’t be matched to a TV season/);
    const res = await app.rpcHandlers.library_match_season({ p_row_id: id, p_target: { tmdb_id: 888 }, p_patch: {} }).json();
    assert.match(res.message, /^genre_film_season:/);
  });
}

T.run();
