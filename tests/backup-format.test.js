// Offline tests for backup formats 1 and 2 (backup-restore.js; format 3 is in tests/organization.test.js):
// since the 5c clean-up (G8) a database without Stage 5 gets no backup and no restore (since B4/B5
// the page backs up and restores only format 5); format 1–2
// files (from the test-only fixture builder) are still validated exactly (format 2 adds
// tv_shows/show_id/skipped, checked against the database's show rules).
// Run from the repo root: node tests/backup-format.test.js
const assert = require('assert');
const { createApp, runner, legacyBackupFixture } = require('./app-harness');

const T = runner('backup-format');
const test = T.test;

const OWNER = '11111111-1111-4111-8111-111111111111';
const uuid = name => `00000000-0000-4000-8000-${name.padStart(12, '0')}`;
const TS = '2026-10-01T00:00:00+00:00';
const item = (name, o = {}) => ({
  id: uuid(name), collection: 'othertv', item_key: `show ${name}|season 1`, title: `Show ${name}`, season: 'Season 1', theme: 'HBO',
  display_date: 'Jan 1, 2020', date_sort: '2020-01-01', watched: false, status: 'confirmed', created_at: TS, watch_with: [], collections: [],
  tmdb_collection_id: null, tmdb_collection_name: null, media_type: 'tv', tmdb_id: 100, season_number: 1, user_id: OWNER, ...o
});
const show = (name, o = {}) => ({ id: uuid(name), collection: 'othertv', title: 'Show', show_key: 'show', tmdb_id: 100, status: 'watching',
  created_at: TS, user_id: OWNER, ...o });
const movie = name => item(name, { collection: 'movies', item_key: `film ${name}|film`, season: 'Film', media_type: 'movie', tmdb_id: 200, season_number: null });

// A format-2 database: one show with one linked season, one movie.
const v2Rows = () => [item('a1', { show_id: uuid('c1'), skipped: false }), { ...movie('b1'), show_id: null, skipped: false }];
const v2Shows = () => [show('c1')];
// A format-1 database (no TV-show schema), still with user_id on the rows.
const v1Rows = () => [item('a1'), movie('b1')];

// Since the 5c clean-up (G8) the page exports and restores only on a contracted database;
// since B4/B5 only on the B4/B5 database (format 5). A database without Stage 5 gets no file and no format probe; format 1–2 files
// come from the test-only fixture builder (the page's format 1–3 export is retired).
test('a database without Stage 5 (format 1 or 2): no backup file, no format probe, only the phase read', async () => {
  for (const opts of [{ rows: v1Rows(), format1: true }, { rows: v2Rows(), tvShows: v2Shows(), org: false }]) {
    const app = await createApp({ ...opts, stage5: null });
    const before = app.requests.length;
    const res = await app.run('buildBackupObject()').then(() => 'made', e => e.message);
    assert.match(res, /makes backups only of a database in its own state \(format 5\), and this database isn’t in it, so no file was made/);
    const reads = app.requests.slice(before);
    assert.deepStrictEqual(reads.map(r => `${r.method} ${r.url.split('/rest/v1/')[1].split('?')[0]}`), ['GET rpc/stage5_capabilities']);
  }
});

test('format 2 file (fixture): exact columns with tv_shows, show_id and skipped, no user_id; it validates', async () => {
  const app = await createApp({ rows: v2Rows(), tvShows: v2Shows(), org: false });
  const b = await legacyBackupFixture(app, 2);
  assert.deepStrictEqual(Array.from(Object.keys(b.tables)).sort(), ['custom_collections', 'othertv_shows', 'tv_shows', 'watchlist_items']);
  assert.strictEqual(b.rowCounts.tv_shows, 1);
  assert.deepStrictEqual(Array.from(Object.keys(b.tables.watchlist_items[0])).slice(-2), ['show_id', 'skipped']);
  assert.strictEqual(Object.keys(b.tables.tv_shows[0]).length, 7);
  assert.ok(Object.values(b.tables).every(rows => rows.every(r => !('user_id' in r))));
  assert.deepStrictEqual(Array.from(app.get('validateBackupObject')(b)), []);
});

test('format 2 validation refuses user_id, dangling or cross-collection links, linked films, unlinked skips, bad shows', async () => {
  const app = await createApp({ rows: v2Rows(), tvShows: v2Shows(), org: false });
  const good = await legacyBackupFixture(app, 2);
  const validate = o => Array.from(app.get('validateBackupObject')(o)).join(' | ');
  const variant = fn => { const b = JSON.parse(JSON.stringify(good)); fn(b); return validate(b); };
  assert.match(variant(b => { b.tables.watchlist_items[0].user_id = OWNER; }), /unknown column\(s\) user_id/);
  assert.match(variant(b => { b.tables.watchlist_items[0].show_id = uuid('dd'); }), /isn't in the backup/);
  assert.match(variant(b => { b.tables.tv_shows[0].collection = 'disney'; }), /links to a show in collection "disney"/);
  assert.match(variant(b => { const m = b.tables.watchlist_items.find(r => r.media_type === 'movie'); m.show_id = uuid('c1'); }), /is a film but links to a show/);
  assert.match(variant(b => { const m = b.tables.watchlist_items.find(r => r.media_type === 'movie'); m.skipped = true; }), /is skipped but has no show/);
  assert.match(variant(b => { b.tables.tv_shows[0].status = 'caughtup'; }), /tv_shows status/);
  assert.match(variant(b => { b.tables.tv_shows.push({ ...b.tables.tv_shows[0], id: uuid('c2') }); b.rowCounts.tv_shows = 2; }), /duplicate identified show/);
  assert.match(variant(b => { delete b.tables.tv_shows; }), /Missing or invalid data for table "tv_shows"/);
  assert.match(variant(b => { b.formatVersion = 6; }), /Unsupported backup format version \(6\)/);
  assert.match(variant(b => { b.formatVersion = 3; }), /Missing or invalid data for table "personal_collections"/);
  assert.match(variant(b => { b.formatVersion = 1; }), /Unexpected table\(s\) for format 1: tv_shows/);
});

test('a database without Stage 5 (format 1 or 2): restore isn’t offered for a format 1 or 2 file; nothing is sent', async () => {
  const src1 = await createApp({ rows: v1Rows(), format1: true });
  const src2 = await createApp({ rows: v2Rows(), tvShows: v2Shows(), org: false });
  const files = [await legacyBackupFixture(src1, 1), await legacyBackupFixture(src2, 2)];
  for (const opts of [{ rows: v1Rows(), format1: true }, { rows: v2Rows(), tvShows: v2Shows(), org: false }]) {
    for (const f of files) {
      const app = await createApp({ ...opts, stage5: null });
      app.ctx.__b = f;
      await app.run('pendingRestoreData = __b; renderRestorePreview(__b)');
      assert.match(app.el('restoreModalBox').innerHTML, /Restore isn't available[\s\S]*needs a database update/);
      assert.ok(!app.el('restoreModalBox').innerHTML.includes('executeRestore()'));
      assert.strictEqual(app.get('pendingRestoreData'), null);
      assert.ok(app.requests.every(r => r.method === 'GET'), 'nothing written');
    }
  }
});

test('restore: a format 5 restore sends the flag as false', async () => {
  const app = await createApp({ rows: v2Rows(), tvShows: v2Shows() });
  const b = await app.run('buildBackupObject()');
  assert.strictEqual(b.formatVersion, 5);
  app.ctx.__b = b;
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)');
  assert.strictEqual(app.get('pendingRestoreAllowV1Reset'), false);
  assert.match(app.el('restoreModalBox').innerHTML, /Restore database/);
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`);
  const call = app.requests.find(r => r.url.includes('/rpc/restore_backup'));
  assert.strictEqual(call.body.p_allow_v1_reset, false);
  assert.strictEqual(call.body.p_backup.formatVersion, 5);
});

T.run();
