// Offline tests for backup formats 1 and 2 (backup-restore.js; format 3 is in tests/organization.test.js):
// since the 5c clean-up (G8) a database without Stage 5 gets no backup and no restore (since B4/B5
// the page backs up and restores only format 7 since CU1); format 1–2
// files (from the test-only fixture builder) are still validated exactly (format 2 adds
// tv_shows/show_id/skipped, checked against the database's show rules).
// Run from the repo root: node tests/backup-format.test.js
const assert = require('assert');
const { createApp, runner } = require('./app-harness');

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
// since CU1 only on the CU1 database (format 7). A database without Stage 5 gets no file and no format probe; format 1–2 files
// come from the test-only fixture builder (the page's format 1–3 export is retired).
test('a database without Stage 5 (format 1 or 2): no backup file, no format probe, only the phase read', async () => {
  for (const opts of [{ rows: v1Rows(), format1: true }, { rows: v2Rows(), tvShows: v2Shows(), org: false }]) {
    const app = await createApp({ ...opts, stage5: null });
    const before = app.requests.length;
    const res = await app.run('buildBackupObject()').then(() => 'made', e => e.message);
    assert.match(res, /makes backups only of a database in its own state \(format 8\), and this database isn’t in it, so no file was made/);
    const reads = app.requests.slice(before);
    assert.deepStrictEqual(reads.map(r => `${r.method} ${r.url.split('/rest/v1/')[1].split('?')[0]}`), ['GET rpc/stage5_capabilities']);
  }
});

test('a database without Stage 5 (format 1 or 2): restore isn’t offered for a format 1 or 2 file; nothing is sent', async () => {
  const files = [1, 2].map(formatVersion => ({ format: 'watchlist-tracker-backup', formatVersion, exportedAt: '2026-01-01T00:00:00Z', rowCounts: {}, tables: {} }));
  for (const opts of [{ rows: v1Rows(), format1: true }, { rows: v2Rows(), tvShows: v2Shows(), org: false }]) {
    for (const f of files) {
      const app = await createApp({ ...opts, stage5: null });
      app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
      app.ctx.__b = f;
      await app.run('pendingRestoreData = __b; renderRestorePreview(__b)');
      assert.match(app.el('restoreModalBox').innerHTML, /Restore isn't available[\s\S]*needs a database update/);
      assert.ok(!app.el('restoreModalBox').innerHTML.includes('executeRestore()'));
      assert.strictEqual(app.get('pendingRestoreData'), null);
      assert.ok(app.requests.every(r => r.method === 'GET'), 'nothing written');
    }
  }
});

test('restore: a format 7 restore sends the flag as false', async () => {
  const app = await createApp({ rows: v2Rows(), tvShows: v2Shows() });
  const b = await app.run('buildBackupObject()');
  assert.strictEqual(b.formatVersion, 8);
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
  app.ctx.__b = b;
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)');
  assert.match(app.el('restoreModalBox').innerHTML, /Restore database/);
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`);
  const call = app.requests.find(r => r.url.includes('/rpc/restore_backup'));
  assert.strictEqual(call.body.p_allow_v1_reset, false);
  assert.strictEqual(call.body.p_backup.formatVersion, 8);
});

T.run();
