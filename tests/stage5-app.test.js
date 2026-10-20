// Offline tests for the page against the Stage 5 database phases (db/phase5a_expand.sql,
// db/phase5c_contract.sql; since B4/B5 the page writes only to the B4/B5 phase,
// db/b45_expand.sql — the older phases are refused, tests/b45-compat.test.js), in the whole-page harness:
//   * the phase read at startup (stage5_capabilities, GET) and the notice when it is absent;
//   * no request ever names a storage value or a retired function, in either phase
//     (the request scan), and no app script refers to one (the source scan, with its
//     allowlist); the format-3 module is the one place that knows the old shape, and it
//     sends no request;
//   * the main flows against the B4/B5 database: reads, additions, Match, catalog
//     updates, memberships, backup format 6 (EP1; format 5 before it) and its restore, a format-3 restore
//     converted in the page (with or without the recovery section);
//   * phase transitions while a backup, restore or write is being prepared: consistent
//     success or a safe refusal, never a partial backup file, a fallback write or an
//     automatic retry of an unknown outcome;
//   * the 5c clean-up (G8), since B4/B5: backup and restore only on the B4/B5 database; on
//     a rolled-back (5c) database, without Stage 5 or with an unknown phase there is no file
//     and no restore, and no format probe; only a format-5 document is ever sent;
//   * catalog conflicts shown with their candidates, never resolved by the page (U7);
//     Match into a show a catalog governs is refused and changes nothing (U1).
// The database side is checked on PGlite (db/test/t_5a_expand.sql, db/test/t_5c_contract.sql,
// tools/db-rehearsal-5.mjs); the harness's library_* functions are independent stand-ins.
// Run from the repo root: node tests/stage5-app.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createApp, runner, settle, legacyBackupFixture, userKeyOf } = require('./app-harness');

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
async function boot(stage5 = 'contracted-ep1', opts = {}) {
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
  for (const phase of ['contracted-ep1']) { // (since EP1 the page writes only to the EP1 database)
    const { app } = await boot(phase);
    const reads = app.requests.filter(r => r.url.endsWith('/rpc/stage5_capabilities'));
    assert.deepStrictEqual(reads.map(r => r.method), ['GET'], phase);
    assert.strictEqual(app.get('stage5Phase'), phase);
    assert.deepStrictEqual(app.writes(), []);
    assert.strictEqual(app.el('errorBanner').innerHTML, '', 'no notice');
  }
});

// M1: the signed-in page starts only on a database in the signed-in state (access = members);
// any other database (no Stage 5 at all here) gets the sign-in boot's notice and nothing is read.
test('a database without the Stage 5 update: the sign-in boot’s notice; nothing is read beyond the capability; nothing is written', async () => {
  const { app } = await boot(null);
  assert.strictEqual(app.get('stage5Phase'), null);
  assert.match(app.el('phaseBanner').innerHTML, /hasn’t been updated for signed-in libraries yet, so nothing is shown and nothing will be changed/);
  assert.deepStrictEqual(app.requests.map(r => r.url.split('/rest/v1/')[1]), ['rpc/stage5_capabilities']);
  assert.deepStrictEqual(app.writes(), []);
  noStorage(app);
});

// ─── Request scan (A13, app side) ─────────────────────────────────────────────
for (const phase of ['contracted-ep1']) { // (since EP1 the page writes only to the EP1 database)
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
    // A backup: format 6 on the EP1 database (no storage).
    const before = app.requests.length;
    const b = await app.ctx.buildBackupObject();
    assert.strictEqual(b.formatVersion, 6);
    const backupReads = app.requests.slice(before);
    assert.ok(backupReads.every(r => r.method === 'GET'));
    noStorage(app);
    assert.ok(!app.requests.some(r => /othertv_shows|legacy_source|[?&,=]collection\b/.test(r.url)), 'no retired table or column in any request');
    assert.deepStrictEqual([...new Set(writes(app).map(w => w.split(' ')[1]))].sort(),
      ['rpc/library_add_films_b45', 'rpc/library_add_seasons_b45', 'rpc/library_catalog_apply_b45', 'rpc/library_create_show_b45', 'rpc/library_match_film_b45', 'rpc/library_match_season_b45', 'rpc/org_add_membership']);
    assert.ok(app.store.watchlist_items.some(r => r.tmdb_id === 999), 'the film was added');
    assert.ok(app.store.watchlist_items.some(r => r.id === localRow.id && r.tmdb_id === 888), 'the season was matched');
  });
}

// ─── Source scan (A13, source side) ───────────────────────────────────────────
test('source scan: no app script but backup-format3.js names a storage value, a retired column or table, or a retired function (allowlisted lines listed); backup-format3.js sends no request', () => {
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
    ['browse-views.js', /Pull rest of \$\{esc\(franchise \|\| 'collection'\)\}/],
  ];
  // B4/B5: the preview checks a file's recovery section as restore_backup does (its storage
  // values against the file's own rows); that block reads the file only and sends nothing.
  const BLOCKS = { 'backup-restore.js': [/recovery section check: begin/, /recovery section check: end/] };
  const hits = [];
  for (const f of scripts) {
    if (f === 'backup-format3.js') continue;
    let inBlock = false;
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (BLOCKS[f] && BLOCKS[f][0].test(line)) inBlock = true;
      if (BLOCKS[f] && BLOCKS[f][1].test(line)) inBlock = false;
      if (inBlock) { if (/fetch\(|sbFetch\(|sbRpc\(|fetchAllRows/.test(line)) hits.push(`${f}:${i + 1}: request inside the file-only block`); return; }
      if (!RULE.test(line) || /^\s*\/\//.test(line)) return;
      if (ALLOW.some(([af, re]) => af === f && re.test(line.trim()))) return;
      hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(hits, []);
  // The one module that knows format 1–3 shapes, and nothing else does. Since the 5c clean-up (G8)
  // it only reads files: no request of any kind (no fetch, no Supabase call, no table read).
  const f3 = fs.readFileSync(path.join(ROOT, 'backup-format3.js'), 'utf8');
  assert.ok(/othertv_shows/.test(f3) && /legacy_source/.test(f3));
  assert.deepStrictEqual(f3.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /fetch\(|sbFetch\(|fetchAllRows\(|SUPABASE_/.test(l)).map(([i, l]) => `${i}: ${l.trim()}`), []);
});

// ─── Contracted flows ─────────────────────────────────────────────────────────
test('contracted: Match into a show a catalog governs is refused (match_target_governed); the row and the show are unchanged; nothing is offered instead (U1)', async () => {
  const { app, lib } = await boot('contracted-ep1');
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
  assert.deepStrictEqual(writes(app), ['POST rpc/library_match_season_b45']);
});

test('contracted: Match is not offered for a governed entry (a governed film, a season of a governed show); the database refuses it too', async () => {
  const { app, lib } = await boot('contracted-ep1');
  const andorRow = lib.rows.find(r => r.show_id === lib.andor.id);
  await allTv(app);
  assert.strictEqual(app.get(`isTmdbMatchEligible(derivedData.rows.find(r => r.id === ${JSON.stringify(andorRow.id)}))`), false);
  const res = await app.rpcHandlers.library_match_season_b45({ p_row_id: andorRow.id, p_target: { tmdb_id: 1 }, p_patch: {} }).json();
  assert.match(res.message, /not_eligible/);
});

test('EP1: backup is format 6 (no storage, theme_kind, governance tables, no othertv_shows, the B4/B5 columns); it validates and restores through restore_backup; verification passes', async () => {
  const { app } = await boot('contracted-ep1');
  app.store.watchlist_items.push(filmOf({ collection: 'disney', title: 'Disney Film', media_type: null, tmdb_id: null, item_key: 'disney film|film' })); // a governed film
  const b = await app.ctx.buildBackupObject();
  assert.strictEqual(b.tables.catalog_show_links.length, 1);
  assert.strictEqual(b.tables.catalog_film_links.length, 1);
  assert.strictEqual(b.formatVersion, 6);
  assert.ok(!('othertv_shows' in b.tables));
  assert.ok(b.tables.tv_shows.every(s => 'priority' in s && 'resume_start_season_id' in s) && b.tables.watchlist_items.every(r => 'genres' in r));
  assert.ok(b.tables.watchlist_items.every(r => !('collection' in r) && 'theme_kind' in r));
  assert.ok(b.tables.tv_shows.every(s => !('collection' in s)));
  assert.ok(['catalog_show_links', 'catalog_film_links'].every(t => Array.isArray(b.tables[t])));
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(b)), []);
  app.ctx.__b = b;
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 6');
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  noStorage(app);
});

for (const archive of ['active', 'retired']) {
  test(`B4/B5: a format-3 file is converted in the page (3 → 4 → 5 → 6; previewed, loss-aware${archive === 'active' ? ', with its recovery section' : ', without a recovery section once the archive is retired'}); only the converted document is sent`, async () => {
    const co = await boot('contracted');
    const f3 = await legacyBackupFixture(co.app, 3); // a format-3 file (the page no longer exports one, G8)
    assert.strictEqual(f3.formatVersion, 3);
    const { app } = await boot('contracted-ep1', { recoveryArchive: archive });
    app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
    await app.ctx.handleRestoreFileSelected({ target: { files: [fileOf(f3)], value: 'x' } }); await settle(); // the file is read (and fingerprinted) as when chosen
    const preview = app.el('restoreModalBox').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(preview, /format 3/i);
    assert.match(preview, /Restore database/);
    const sent = app.get('pendingRestoreData');
    assert.strictEqual(sent.formatVersion, 6);
    assert.strictEqual(!!sent.recovery, archive === 'active', 'the recovery section only while the archive is active');
    assert.ok(sent.conversion && sent.conversion.source_format === 3);
    await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
    const calls = app.requests.filter(r => r.url.endsWith('/rpc/restore_backup'));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].body.p_backup.formatVersion, 6, 'never the format-3 file itself');
    assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  });
}

// PostgREST returns timestamptz as e.g. "…05.325+00:00", while the converter stamps the new link
// rows with the file's exportedAt ("…05.325Z"): the same instant must verify; another must not.
for (const [label, shift, verified] of [['the same instant in the database’s form', 0, true], ['a different instant (1 µs later)', 1, false]]) {
  test(`contracted: converted format-3 restore whose link created_at comes back as ${label} ${verified ? 'verifies' : 'fails verification'}`, async () => {
    const co = await boot('contracted');
    const f3 = await legacyBackupFixture(co.app, 3);
    const { app } = await boot('contracted-ep1', { recoveryArchive: 'active' });
    const asDb = ts => ts.replace(/(\.\d{3})Z$/, (m, f) => `${shift ? (f + '00' + shift) : f.replace(/0+$/, '').replace(/\.$/, '')}+00:00`);
    const restore = app.rpcHandlers.restore_backup;
    app.rpcHandlers.restore_backup = body => {
      const r = restore(body);
      for (const l of [...app.store.__links.shows, ...app.store.__links.films]) l.created_at = asDb(l.created_at);
      return r;
    };
    app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
    await app.ctx.handleRestoreFileSelected({ target: { files: [fileOf(f3)], value: 'x' } }); await settle(); // the file is read (and fingerprinted) as when chosen
    const sent = app.get('pendingRestoreData');
    assert.ok(sent.tables.catalog_show_links.length > 0 && sent.tables.catalog_show_links.every(l => /Z$/.test(l.created_at)));
    await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
    assert.ok(app.store.__links.shows.every(l => /\+00:00$/.test(l.created_at)));
    const html = app.el('restoreModalBox').innerHTML;
    if (verified) assert.match(html, /restored and verified/);
    else { assert.match(html, /verification failed/); assert.match(html, /catalog_show_links[\s\S]*created_at/); }
  });
}

test('B4/B5: a format-5 file into a database that is not B4/B5 is refused before anything happens', async () => {
  const c = await boot('contracted-ep1');
  const f4 = await c.app.ctx.buildBackupObject();
  const { app } = await boot('contracted');
  app.ctx.__b = f4;
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
  // (Its first view read lacked the B4/B5 columns, so the page has also stopped until it is reloaded.)
  assert.match(app.el('restoreModalBox').innerHTML, /Restore isn't available[\s\S]*(restores only into a database in its own state \(format 6\)|This page and the database don’t match)/); // the gate comes first since G8
  assert.ok(!app.el('restoreModalBox').innerHTML.includes('executeRestore()'));
  assert.deepStrictEqual(app.writes(), []);
});

// ─── Phase transitions while something is being prepared (#3) ─────────────────
test('transition during a backup: the phase changes (B4/B5 → rolled back) between the first and last reads → no file, a clear message, nothing written', async () => {
  const { app } = await boot('contracted-ep1');
  let downloads = 0;
  app.ctx.downloadJSON = () => { downloads++; };
  const g = app.hold(r => r.method === 'GET' && r.url.includes('/tv_shows?') && r.headers.Range);
  const p = app.ctx.buildBackupObject().then(() => 'made', e => e.message);
  await g.reached;
  app.stage5 = 'contracted'; // a (separately approved) rollback commits while the backup is being read
  g.release();
  const res = await p;
  assert.match(res, /The database was updated while the backup was being read, so no file was made/);
  assert.strictEqual(downloads, 0);
  assert.deepStrictEqual(app.writes(), []);
});

test('transition: the phase can’t be read (HTTP 500) → no backup file and no guess (never the format-3 shape by default)', async () => {
  const { app } = await boot('contracted-ep1');
  app.failNext(r => r.url.endsWith('/rpc/stage5_capabilities'));
  const res = await app.ctx.buildBackupObject().then(() => 'made', e => e.message);
  assert.notStrictEqual(res, 'made');
  assert.deepStrictEqual(app.writes(), []);
});

test('transition after a restore was previewed: the safety backup finds the database changed → aborted before any download or restore call', async () => {
  const { app } = await boot('contracted-ep1');
  let downloads = 0;
  app.ctx.downloadJSON = () => { downloads++; };
  const f4 = await app.ctx.buildBackupObject();
  app.ctx.__b = f4;
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /Restore database/);
  app.stage5 = 'contracted'; // a (separately approved) rollback after the preview
  await app.ctx.executeRestore(); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /Restore aborted[\s\S]*Couldn't create a safety backup of your current data, so nothing was changed/);
  assert.strictEqual(downloads, 0, 'no safety file');
  assert.ok(!app.requests.some(r => r.url.endsWith('/rpc/restore_backup')));
});

test('transition after the safety backup was confirmed: the phase is read again before sending; a changed phase sends nothing (no conversion, no retry)', async () => {
  const { app } = await boot('contracted-ep1');
  const f4 = await app.ctx.buildBackupObject();
  app.ctx.__b = f4;
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 6');
  app.stage5 = 'contracted';
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle(); await settle();
  assert.strictEqual(app.requests.filter(r => r.url.endsWith('/rpc/restore_backup')).length, 0, 'nothing sent');
  assert.match(app.el('restoreModalBox').innerHTML, /Restore not sent[\s\S]*changed after this restore was prepared, so nothing was sent and nothing was changed/);
  // (The database itself refuses a format-3 document once contracted: db/test/t_5c_contract.sql.)
  // ("Restore not sent" doesn't name the safety file; the failed-call, verification-failure and success messages do.)
});

test('a database without the Stage 5 update (or one rolled back meanwhile): no restore is offered, nothing is sent at any step, and no write of any kind leaves the page', async () => {
  const { app } = await boot('contracted-ep1');
  let downloads = 0;
  app.ctx.downloadJSON = () => { downloads++; };
  const b = await app.ctx.buildBackupObject(); // a format-4 file
  await allTv(app);                                   // the page loaded while the database was updated …
  app.stage5 = null;                                  // … then the expansion was rolled back
  app.ctx.__b = b;
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /Restore isn't available[\s\S]*needs a database update/);
  assert.ok(!app.el('restoreModalBox').innerHTML.includes('executeRestore()'));
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 6');
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /Restore not sent[\s\S]*couldn’t be confirmed/);
  // Ordinary writes: the cached phase is cleared on a failed check, so every write is refused before sending.
  app.run('stage5Phase = null');
  const sev = app.store.watchlist_items.find(r => r.title === 'Severance');
  await app.ctx.toggleWatch(sev.id); await settle();
  await app.ctx.setShowStateById(sev.show_id, { status: 'skipped' }); await settle();
  assert.deepStrictEqual(app.writes(), [], 'no write of any kind');
  assert.strictEqual(downloads, 0);
});

// ─── The 5c clean-up (G8): backup and restore only on a contracted database ───
const pathOf = r => `${r.method} ${r.url.split('/rest/v1/')[1].split('?')[0]}`;
const fileOf = obj => ({ text: async () => JSON.stringify(obj) });
const modalText = app => app.el('restoreModalBox').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('G8 N1: a rolled-back (5c) database: Backup makes no file; only the phase is read (no table, no storage column, no othertv_shows); nothing written', async () => {
  const { app } = await boot('contracted');
  let downloads = 0;
  app.ctx.downloadJSON = () => { downloads++; };
  const before = app.requests.length;
  await app.ctx.handleBackupClick(); await settle();
  assert.strictEqual(downloads, 0, 'no file');
  // (Its first view read lacked the B4/B5 columns: the page has stopped until it is reloaded.)
  assert.match(app.el('errorBanner').innerHTML, /Backup failed: This page and the database don’t match \(the database may have been updated or rolled back\), so nothing was changed\. Reload the page\. No file was made\./);
  assert.deepStrictEqual(app.requests.slice(before).map(pathOf), ['GET rpc/stage5_capabilities']);
  assert.deepStrictEqual(app.writes(), []);
  noStorage(app);
});

for (const [label, stage5] of [['no Stage 5 (no capability)', null], ['an unknown phase', 'later_phase']]) {
  test(`G8 N2: ${label}: no backup file and no format probe; restore is not offered; nothing written`, async () => {
    const { app } = await boot('contracted-ep1');
    const f4 = await app.ctx.buildBackupObject();
    app.stage5 = stage5;
    app.run('stage5Phase = null');
    const before = app.requests.length;
    const res = await app.ctx.buildBackupObject().then(() => 'made', e => e.message);
    assert.notStrictEqual(res, 'made');
    assert.match(res, /makes backups only of a database in its own state \(format 6\), and this database isn’t in it, so no file was made/);
    assert.deepStrictEqual(app.requests.slice(before).map(pathOf), ['GET rpc/stage5_capabilities'], 'no personal_collections / tv_shows probe');
    app.ctx.__b = f4;
    app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
    await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
    assert.match(app.el('restoreModalBox').innerHTML, /Restore isn't available/);
    assert.ok(!app.el('restoreModalBox').innerHTML.includes('executeRestore()'));
    assert.strictEqual(app.get('pendingRestoreData'), null);
    assert.deepStrictEqual(app.writes(), []);
  });
}

test('G8 N3: a rolled-back (5c) database: a format-3 file is not restored (no direct restore): not offered, no safety backup, nothing sent or pending', async () => {
  const { app } = await boot('contracted');
  let downloads = 0;
  app.ctx.downloadJSON = () => { downloads++; };
  const f3 = await legacyBackupFixture(app, 3);
  const before = app.requests.length;
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await app.ctx.handleRestoreFileSelected({ target: { files: [fileOf(f3)], value: 'x' } }); await settle();
  assert.match(modalText(app), /Restore isn't available This page and the database don’t match/);
  assert.ok(!app.el('restoreModalBox').innerHTML.includes('executeRestore()'));
  assert.strictEqual(app.get('pendingRestoreData'), null);
  assert.strictEqual(downloads, 0);
  assert.deepStrictEqual(app.requests.slice(before).map(pathOf), ['GET rpc/stage5_capabilities'], 'no table read, no send');
  app.ctx.closeRestoreModal();
  assert.ok(!app.requests.some(r => r.url.includes('/rpc/restore_backup')));
});

test('G8 N4 (B4/B5): a document that is not format 6 is never sent at the send step', async () => {
  const co = await boot('contracted');
  const f3 = await legacyBackupFixture(co.app, 3);
  const { app } = await boot('contracted-ep1');
  app.ctx.__b = f3;
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await app.run('pendingRestoreData = __b; pendingRestoreDbFormat = 6');
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /Restore not sent/);
  assert.ok(!app.requests.some(r => r.url.includes('/rpc/restore_backup')));
  assert.deepStrictEqual(app.writes(), []);
});

test('G8 N5 (B4/B5, finding 4): a page that found the database out of step stays stopped — the capability later reading B4/B5 doesn’t resume backups; a reloaded page makes format 6', async () => {
  const { app } = await boot('contracted');
  const before = app.requests.length;
  const res = await app.ctx.buildBackupObject().then(() => 'made', e => e.message);
  assert.notStrictEqual(res, 'made');
  assert.deepStrictEqual(app.requests.slice(before).map(pathOf), ['GET rpc/stage5_capabilities'], 'nothing read for the refused backup');
  app.migrateB45(); // the database becomes B4/B5 (or its schema cache catches up) under the open page
  const again = await app.ctx.buildBackupObject().then(() => 'made', e => e.message);
  assert.match(again, /This page and the database don’t match[\s\S]*Reload the page\. No file was made\./, 'still stopped until reload');
  assert.match(app.el('phaseBanner').innerHTML, /Reload the page\. Until then this page changes nothing\./);
  const reloaded = await boot('contracted-ep1');
  const b = await reloaded.app.ctx.buildBackupObject();
  assert.strictEqual(b.formatVersion, 6);
  assert.deepStrictEqual(app.writes(), []);
});

test('G8 N6: contracted: a format-3 file the converter refuses (a row that is neither a film nor a linked TV season): the refusal is shown; nothing sent, downloaded or pending', async () => {
  const co = await boot('contracted');
  const f3 = await legacyBackupFixture(co.app, 3);
  const season = f3.tables.watchlist_items.find(r => r.show_id);
  season.show_id = null; // still a valid format-3 row (format 3 allowed unlinked TV rows), but not representable at 5c
  const { app } = await boot('contracted-ep1');
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(f3)), [], 'the file itself passes format-3 validation');
  let downloads = 0;
  app.ctx.downloadJSON = () => { downloads++; };
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await app.ctx.handleRestoreFileSelected({ target: { files: [fileOf(f3)], value: 'x' } }); await settle();
  assert.match(modalText(app), /This format 3 backup can't be converted It breaks a rule your updated list enforces, so nothing was changed: a row that is neither a film nor a linked TV season/);
  assert.ok(!app.el('restoreModalBox').innerHTML.includes('executeRestore()'));
  assert.strictEqual(app.get('pendingRestoreData'), null);
  assert.strictEqual(downloads, 0);
  assert.deepStrictEqual(app.writes(), []);
});

test('G8 N7: contracted: a converted document that fails format-4 validation is refused; nothing sent, downloaded or pending', async () => {
  const co = await boot('contracted');
  const f3 = await legacyBackupFixture(co.app, 3);
  const { app } = await boot('contracted-ep1');
  const real = app.ctx.convertFormat3To4(f3, { includeRecovery: true, sourceSha256: 'a'.repeat(64) });
  const bad = JSON.parse(JSON.stringify(real.doc));
  bad.tables.watchlist_items.find(r => r.theme_kind != null).theme_kind = 'bogus';
  app.ctx.__conv = { refusals: [], doc: bad, summary: real.summary };
  app.run('convertFormat3To4 = () => __conv'); // test-only stand-in; the real converter is unchanged (G8 L6)
  let downloads = 0;
  app.ctx.downloadJSON = () => { downloads++; };
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await app.ctx.handleRestoreFileSelected({ target: { files: [fileOf(f3)], value: 'x' } }); await settle();
  assert.match(modalText(app), /This format 3 backup can't be converted The converted backup doesn’t pass validation, so nothing was changed:[\s\S]*theme_kind/);
  assert.ok(!app.el('restoreModalBox').innerHTML.includes('executeRestore()'));
  assert.strictEqual(app.get('pendingRestoreData'), null);
  assert.strictEqual(downloads, 0);
  assert.deepStrictEqual(app.writes(), []);
});

test('G8 N8: contracted: format 1 and format 2 files are refused at preview, before any safety backup, download or write', async () => {
  const co = await boot('contracted');
  const src2 = await createApp({ rows: library().rows, tvShows: library().tvShows, org: false });
  const files = [[await legacyBackupFixture(co.app, 1), /predates TV shows \(format 1\)[\s\S]*only format 6 backups can be restored/],
    [await legacyBackupFixture(src2, 2), /format 2, from before personal collections/]];
  for (const [f, re] of files) {
    const { app } = await boot('contracted-ep1');
    let downloads = 0;
    app.ctx.downloadJSON = () => { downloads++; };
    app.ctx.__b = f;
    app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
    await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
    assert.match(app.el('restoreModalBox').innerHTML, re);
    assert.ok(!app.el('restoreModalBox').innerHTML.includes('executeRestore()'));
    assert.strictEqual(app.get('pendingRestoreData'), null);
    assert.strictEqual(downloads, 0);
    assert.deepStrictEqual(app.writes(), []);
  }
});

test('G8 N9 (finding 4): a format-3 file refused on a rolled-back database stays refused in that page after the database becomes B4/B5 (stop until reload); a reloaded page converts it', async () => {
  const { app } = await boot('contracted');
  const f3 = await legacyBackupFixture(app, 3);
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await app.ctx.handleRestoreFileSelected({ target: { files: [fileOf(f3)], value: 'x' } }); await settle();
  assert.match(modalText(app), /Restore isn't available/);
  app.ctx.closeRestoreModal();
  app.migrateB45();
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await app.ctx.handleRestoreFileSelected({ target: { files: [fileOf(f3)], value: 'x' } }); await settle();
  assert.match(modalText(app), /Restore isn't available This page and the database don’t match/, 'still stopped until reload');
  assert.strictEqual(app.get('pendingRestoreData'), null);
  const r = (await boot('contracted-ep1')).app;
  r.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  await r.ctx.handleRestoreFileSelected({ target: { files: [fileOf(f3)], value: 'x' } }); await settle();
  assert.match(modalText(r), /This is a format 3 backup; it is converted before restoring/);
  assert.ok(r.el('restoreModalBox').innerHTML.includes('executeRestore()'));
  assert.strictEqual(r.get('pendingRestoreData.formatVersion'), 6);
  assert.deepStrictEqual(app.writes().concat(r.writes()), []);
});

test('transition while an addition is prepared: B4/B5 rolled back between the preview and Add → the _b45 function is missing: refused, nothing added, no older function tried, no further writes', async () => {
  const { app, lib } = await boot('contracted-ep1');
  await allTv(app);
  app.ctx.openLibraryPanel('tv'); await settle();
  await choose(app, 95396, 'Severance'); tick(app, [2]);
  app.stage5 = 'contracted'; // a (separately approved) B4/B5 rollback lands between the preview and Add
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_add_seasons_b45'], 'one attempt; never library_add_seasons');
  assert.match(outcome(app), /This page and the database don’t match[\s\S]*nothing was changed\. Reload the page\./);
  assert.ok(!app.store.watchlist_items.some(r => r.show_id === lib.sev.id && r.season_number === 2));
  assert.strictEqual(app.get('stage5Phase'), null);
  await app.ctx.toggleWatch(lib.rows.find(r => r.show_id === lib.sev.id).id); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_add_seasons_b45'], 'later writes are refused before sending');
  noStorage(app);
});

test('transition while an addition is out: no clear answer → reported unconfirmed, never resent, no fallback', async () => {
  const { app } = await boot('contracted-ep1');
  await allTv(app);
  app.ctx.openLibraryPanel('tv'); await settle();
  await choose(app, 95396, 'Severance'); tick(app, [2]);
  const g = app.hold(r => r.url.endsWith('/rpc/library_add_seasons_b45'));
  const p = app.ctx.addSelectedTMDBSeasons();
  await g.reached;
  app.stage5 = 'contracted'; // rolled back meanwhile
  g.fail(); await p; await settle();
  assert.match(outcome(app), /no clear answer came back/);
  await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_add_seasons_b45'], 'one call');
});

test('transition while a catalog preview is open: B4/B5 rolled back → Apply is refused (the _b45 function is missing); neither the 5a nor the Stage 4a function is called; nothing written', async () => {
  const { app } = await boot('contracted-ep1');
  await allTv(app);
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  assert.match(app.el('catalogModalBox').innerHTML, /catalogApply\(\)/);
  const before = JSON.stringify(app.store.watchlist_items);
  app.stage5 = 'contracted';
  await app.ctx.catalogApply(); await settle();
  const t = app.el('catalogModalBox').innerHTML.replace(/<[^>]+>/g, ' ');
  assert.ok(!/Applied \d+ change/.test(t), t);
  assert.ok(!app.requests.some(r => /\/rpc\/(catalog_apply|library_catalog_apply)$/.test(r.url)));
  assert.strictEqual(app.requests.filter(r => r.url.endsWith('/rpc/library_catalog_apply_b45') && r.body.p_approved).length, 1, 'one apply, never retried');
  assert.strictEqual(JSON.stringify(app.store.watchlist_items), before);
});

// ─── Catalog conflicts (U7) ───────────────────────────────────────────────────
test('catalog conflicts are shown as not included, with their reason and the candidate records; nothing is adopted, merged or created for them (U7)', async () => {
  const { app } = await boot('contracted-ep1');
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
for (const phase of ['contracted-ep1']) { // (since EP1 the page writes only to the EP1 database)
  test(`(${phase}) True Crime / Docs keeps its note and its remembered layout key through its presentation key; nothing reads storage`, async () => {
    const { app } = await boot(phase);
    const tc = app.store.personal_collections.find(c => c.legacy_source === 'truecrime');
    const store = { data: { [userKeyOf('watchlist_browse_layout_truecrime')]: '{"presentation":"seasons","grouping":"combined"}' } };
    app.ctx.localStorage = { getItem: k => store.data[k] ?? null, setItem: (k, v) => { store.data[k] = v; } };
    app.ctx.openBrowseCollection(`browse:${tc.id}`); await settle();
    assert.match(app.el('viewHead').innerHTML, /True Crime and Documentary are not yet classified separately/);
    assert.strictEqual(app.get('browsePresentation'), 'seasons', 'the remembered layout (old device key) applies');
    assert.ok(app.requests.some(r => r.url.includes('/library_collection_presentation?')));
    noStorage(app);
  });
}

test('contracted: a converted format-3 restore keeps every collection’s presentation key (True Crime included); format 4 carries it', async () => {
  const co = await boot('contracted');
  const f3 = await legacyBackupFixture(co.app, 3);
  const { app } = await boot('contracted-ep1');
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
for (const phase of ['contracted-ep1']) { // (since EP1 the page writes only to the EP1 database)
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
    const [call] = app.writes().filter(r => r.url.endsWith('/rpc/library_create_show_b45'));
    assert.deepStrictEqual(Array.from(call.body.p_show.distinct_from), [catalogShow.id]);
    assert.ok(app.store.tv_shows.some(x => x.tmdb_id === 777), 'the confirmed distinct work exists');
  });
}

test('a catalog show that appears after the preview: nothing is sent (the preview no longer applies); the database refuses an unacknowledged twin anyway', async () => {
  const { app } = await boot('contracted-ep1');
  await allTv(app);
  app.ctx.openLibraryPanel('tv'); await settle();
  await choose(app, 777, 'Brand New');
  tick(app, [1]);
  const s = showOf({ title: 'Brand New', show_key: 'brand new (catalog)', collection: 'sheridan' });
  app.store.tv_shows.push(s); app.store.watchlist_items.push(seasonOf(s)); // a catalog application meanwhile
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  assert.deepStrictEqual(app.writes(), []);
  assert.match(outcome(app), /Your list changed since this preview, so nothing was added/);
  const res = await app.rpcHandlers.library_create_show_b45({ p_show: { tmdb_id: 778, title: 'Brand New', show_key: 'brand new' },
    p_seasons: [{ item_key: 'brand new|season 1', title: 'Brand New', season: 'Season 1', date_sort: '2026-01-01', season_number: 1 }] }).json();
  assert.match(res.message, /^catalog_candidate:/);
  assert.deepStrictEqual(JSON.parse(res.details).candidates, [s.id]);
});

test('a film by hand titled like a catalog film: shown first; the confirmation acknowledges it (distinct_from) and the film is created', async () => {
  const { app } = await boot('contracted-ep1');
  const cat = filmOf({ title: 'Hell or High Water', collection: 'sheridan', media_type: null, tmdb_id: null, item_key: 'hell or high water|film' });
  app.store.watchlist_items.push(cat);
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openLibraryPanel('movie', 'manual'); await settle();
  app.el('nTitle').value = 'Hell or High Water'; app.el('nTheme').value = 'Drama'; app.el('nDate').value = 'Jan 1, 2030';
  await app.ctx.libraryManualFilm(); await settle();
  assert.deepStrictEqual(app.writes(), []);
  await app.ctx.libraryManualFilm(); await settle();
  const [call] = app.writes().filter(r => r.url.endsWith('/rpc/library_create_film_b45'));
  assert.deepStrictEqual(Array.from(call.body.p_film.distinct_from), [cat.id]);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.title === 'Hell or High Water').length, 2);
});

test('movie tools: a TMDB film titled like a catalog film is not added (catalog_candidate) and is named in the notice; the others are added', async () => {
  const { app } = await boot('contracted-ep1');
  app.store.watchlist_items.push(filmOf({ title: 'Twin Film', collection: 'sheridan', media_type: null, tmdb_id: null, item_key: 'twin film|film' }));
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openLibraryPanel('movie', 'tools'); await settle();
  await app.ctx.libraryPrepareMovieTools(); await settle();
  const ins = await app.ctx.runWrite('test', () => app.ctx.libraryInsertFilms([ // the tools call it inside the write lane
    { item_key: 'twin film|film', title: 'Twin Film', season: 'Film', theme: 'Drama', date_sort: '2020-01-01', tmdb_id: 4001, media_type: 'movie' },
    { item_key: 'other film|film', title: 'Other Film', season: 'Film', theme: 'Drama', date_sort: '2020-01-01', tmdb_id: 4002, media_type: 'movie' }]));
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
for (const phase of ['contracted-ep1']) { // (since EP1 the page writes only to the EP1 database)
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
    assert.strictEqual(matchCalls(app, 'library_match_season_b45').length, 1);
    await app.ctx.confirmTmdbMatchDistinct(); await settle();
    const calls = matchCalls(app, 'library_match_season_b45');
    assert.strictEqual(calls.length, 2);
    assert.ok(!('distinct_from' in calls[0].body.p_patch));
    assert.deepStrictEqual(Array.from(calls[1].body.p_patch.distinct_from), [catalogShow.id, keyTwin.id].sort());
    assert.strictEqual(app.store.watchlist_items.find(r => r.id === row.id).tmdb_id, 889);
  });
}

test('Match candidates: a failed read can’t be confirmed (nothing sent); Retry only reads, then confirming works', async () => {
  const { app, row } = await showTwins('contracted-ep1');
  app.failNext(r => r.method === 'GET' && r.url.includes('tv_shows?id=in.'));
  await app.ctx.confirmTmdbMatch(); await settle();
  assert.match(twinsText(app), /Couldn’t read those records .* so this can’t be confirmed yet\. Retry/);
  assert.match(twinButton(app), /disabled/);
  await app.ctx.confirmTmdbMatchDistinct(); await settle();
  assert.strictEqual(matchCalls(app, 'library_match_season_b45').length, 1, 'nothing sent');
  const before = app.requests.length;
  await app.ctx.loadTmdbMatchTwins(app.get('window.__tmdbMatch')); await settle();
  assert.ok(app.requests.slice(before).every(r => r.method === 'GET'), 'Retry only reads');
  assert.ok(!/disabled/.test(twinButton(app)));
  await app.ctx.confirmTmdbMatchDistinct(); await settle();
  assert.strictEqual(matchCalls(app, 'library_match_season_b45').length, 2);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === row.id).tmdb_id, 889);
});

test('Match candidates: a read that misses a candidate (or its catalog) is incomplete: not confirmable, nothing acknowledged', async () => {
  const { app, keyTwin } = await showTwins('contracted-ep1');
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
  assert.strictEqual(matchCalls(app, 'library_match_season_b45').length, 1);
});

test('Match candidates: a catalog show that appears after the confirmation is refused, then shown with the others for a new confirmation (never acknowledged unseen)', async () => {
  const { app, catalogShow, keyTwin, row } = await showTwins('contracted-ep1');
  await app.ctx.confirmTmdbMatch(); await settle();
  const late = showOf({ title: 'local show renamed', show_key: 'something else', collection: '90day' });
  app.store.tv_shows.push(late); app.store.watchlist_items.push(seasonOf(late)); // added by a catalog meanwhile
  await app.ctx.confirmTmdbMatchDistinct(); await settle();
  let calls = matchCalls(app, 'library_match_season_b45');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === row.id).tmdb_id, null, 'refused: nothing matched');
  const t = twinsText(app);
  assert.match(t, /changed since you confirmed\. Check them and confirm again\./);
  assert.match(t, /3 built-in catalog shows/);
  assert.match(t, /local show renamed · not matched to TMDB · 90 Day catalog · same name/);
  await settle();
  assert.strictEqual(matchCalls(app, 'library_match_season_b45').length, 2, 'not resent automatically');
  await app.ctx.confirmTmdbMatchDistinct(); await settle();
  calls = matchCalls(app, 'library_match_season_b45');
  assert.deepStrictEqual(Array.from(calls[2].body.p_patch.distinct_from), [catalogShow.id, keyTwin.id, late.id].sort());
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === row.id).tmdb_id, 889);
});

test('Match candidates for a film: the catalog film is read and shown beside the target; confirming sends its id to library_match_film_b45', async () => {
  const { app } = await boot('contracted-ep1');
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
  const calls = matchCalls(app, 'library_match_film_b45');
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(Array.from(calls[1].body.p_patch.distinct_from), [cat.id]);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === id).tmdb_id, 555);
});

test('Match candidates: Back while they are being read; the late read never replaces the panel', async () => {
  const { app } = await showTwins('contracted-ep1');
  const g = app.hold(r => r.method === 'GET' && r.url.includes('tv_shows?id=in.'));
  const p = app.ctx.confirmTmdbMatch();
  await g.reached;
  app.ctx.renderTmdbMatchConfirm();
  const shown = app.el('tmdbMatchBody').innerHTML;
  g.release(); await p; await settle();
  assert.strictEqual(app.el('tmdbMatchBody').innerHTML, shown);
});

// ─── Genre-theme film to TV season: still refused (as before Stage 5) ─────────
for (const phase of ['contracted-ep1']) { // (since EP1 the page writes only to the EP1 database)
  test(`(${phase}) a film whose theme is a genre can’t become a TV season: the page sends nothing; the database refuses it too (genre_film_season)`, async () => {
    const { app } = await boot(phase);
    app.ctx.switchMediaType('movie'); await settle();
    app.el('fWatch').value = ''; app.ctx.renderTable();
    const id = 'f0000000-0000-4000-8000-0000000000d2'; // Hand Film: stored with the films (a genre theme)
    app.run(`window.__tmdbMatch = { rowId: '${id}', results: [], target: { mediaType: 'tv', seasonNumber: 1, details: ${JSON.stringify(TMDB['/tv/888'])} } };`);
    await app.ctx.confirmTmdbMatch(); await settle();
    assert.deepStrictEqual(app.writes(), []);
    assert.match(app.el('errorBanner').innerHTML, /genre can’t be matched to a TV season/);
    const res = await app.rpcHandlers.library_match_season_b45({ p_row_id: id, p_target: { tmdb_id: 888 }, p_patch: {} }).json();
    assert.match(res.message, /^genre_film_season:/);
  });
}

T.run();
