// Offline tests for the transactional restore: after the safety-backup
// confirmation, the app replaces every table with one call to the database
// function restore_backup (db/phase0_restore_v1.sql), never with table-by-table
// deletes and inserts, then verifies the result field by field.
// Run from the repo root: node tests/restore-rpc.test.js
const assert = require('assert');
const { createApp, runner } = require('./app-harness');

const T = runner('restore-rpc');
const test = T.test;

// Readable ids ('a1') become valid uuids, as the backup validator requires.
const uuid = name => `00000000-0000-4000-8000-${name.padStart(12, '0')}`;
const row = (name, o = {}) => ({
  id: uuid(name), collection: 'othertv', item_key: `show ${name}|season 1`, title: `Show ${name}`, season: 'Season 1', theme: 'HBO',
  display_date: 'Jan 1, 2020', date_sort: '2020-01-01', watched: false, status: 'confirmed',
  created_at: '2026-01-01T00:00:00+00:00', watch_with: [], collections: [], tmdb_collection_id: null,
  tmdb_collection_name: null, media_type: 'tv', tmdb_id: Number(name.replace(/\D/g, '')) || 1, season_number: 1, ...o
});

// A backup of different content than the app's current database.
async function setup() {
  const app = await createApp({ rows: [row('a1'), row('a2')] });
  const backup = {
    format: 'watchlist-tracker-backup', formatVersion: 1, exportedAt: '2026-10-04T00:00:00.000Z',
    rowCounts: { watchlist_items: 1, othertv_shows: 0, custom_collections: 0 },
    tables: { watchlist_items: [row('b7', { title: 'Restored' })], othertv_shows: [], custom_collections: [] }
  };
  assert.deepStrictEqual(Array.from(app.get('validateBackupObject')(backup)), []);
  app.ctx.__backup = backup;
  app.run(`pendingRestoreData = __backup`);
  return { app, backup };
}

test('restore is one rpc/restore_backup call with the whole backup; no table deletes or inserts', async () => {
  const { app, backup } = await setup();
  const before = app.requests.length;
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`);
  const writes = app.requests.slice(before).filter(r => r.method !== 'GET');
  assert.strictEqual(writes.length, 1);
  assert.ok(writes[0].url.endsWith('/rest/v1/rpc/restore_backup'));
  assert.strictEqual(writes[0].method, 'POST');
  assert.deepStrictEqual(writes[0].body, { p_backup: backup, p_allow_v1_reset: false });
  assert.deepStrictEqual(app.store.watchlist_items.map(r => r.id), [uuid('b7')]);
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
});

test('a failed restore call reports that nothing was changed and stops', async () => {
  const { app } = await setup();
  app.failNext(r => r.url.includes('/rpc/restore_backup'));
  const before = app.requests.length;
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`);
  const after = app.requests.slice(before);
  assert.strictEqual(after.length, 1, 'no verification reads after a failed restore');
  assert.deepStrictEqual(app.store.watchlist_items.map(r => r.id), [uuid('a1'), uuid('a2')]);
  const html = app.el('restoreModalBox').innerHTML;
  assert.match(html, /nothing was changed/);
  assert.match(html, /safety\.json/);
  assert.doesNotMatch(html, /MIXED/);
});

test('verification still compares every field after the restore call', async () => {
  const { app } = await setup();
  // Simulate the database returning a different value than the backup holds.
  app.rpcHandlers.restore_backup = body => {
    app.store.watchlist_items = body.p_backup.tables.watchlist_items.map(r => ({ ...r, title: 'Changed' }));
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}), headers: { get: () => null } };
  };
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`);
  assert.match(app.el('restoreModalBox').innerHTML, /verification failed/);
});

T.run();
