// Offline tests for the transactional restore: after the safety-backup
// confirmation, the app replaces every table with one call to the database
// function restore_backup (db/phase0_restore_v1.sql), never with table-by-table
// deletes and inserts, then verifies the result field by field. Since the 5c clean-up
// (G8) this runs only on a contracted database; since B4/B5 only on the B4/B5 database,
// with a format-5 document.
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

// Each season is linked to a show of its own (formats 4 and 5: every row is a film or a linked season).
const show = name => ({ id: uuid('5' + name), collection: 'othertv', title: `Show ${name}`, show_key: `show ${name}`,
  tmdb_id: Number(name.replace(/\D/g, '')) || 1, status: 'confirmed', created_at: '2026-01-01T00:00:00+00:00' });
const linked = (name, o = {}) => row(name, { show_id: uuid('5' + name), skipped: false, ...o });

// A backup of different content than the app's current database. Since EP1 restore runs
// only on the EP1 database, so the backup is the format-6 export of another one.
async function setup() {
  const src = await createApp({ rows: [linked('b7', { title: 'Restored' })], tvShows: [show('b7')] });
  const backup = JSON.parse(JSON.stringify(await src.run('buildBackupObject()'))); // a plain copy, as a file would be
  assert.strictEqual(backup.formatVersion, 6);
  const app = await createApp({ rows: [linked('a1'), linked('a2')], tvShows: [show('a1'), show('a2')] });
  assert.deepStrictEqual(Array.from(app.get('validateBackupObject')(backup)), []);
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings
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

// M1: only a confirmed refusal (a database or API error code) says nothing was changed; an
// answer without one is an unknown outcome (tests/m1-auth.test.js).
test('a refused restore call reports that nothing was changed and stops', async () => {
  const { app } = await setup();
  app.refuseNext(r => r.url.includes('/rpc/restore_backup'), 'P0001', 'restore_invalid: simulated refusal');
  const before = app.requests.length;
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`);
  const after = app.requests.slice(before).filter(r => !r.url.endsWith('/rpc/stage5_capabilities')); // (the phase is read again before sending)
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
  const restore = app.rpcHandlers.restore_backup;
  app.rpcHandlers.restore_backup = body => {
    const r = restore(body);
    app.store.watchlist_items = app.store.watchlist_items.map(x => ({ ...x, title: 'Changed' }));
    return r;
  };
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`);
  assert.match(app.el('restoreModalBox').innerHTML, /verification failed/);
});

// Known timestamp columns match the same instant written another way; nothing else is loosened.
test('field comparison: timestamp columns compare by instant (to the microsecond); other values exactly', async () => {
  const { app } = await setup();
  const cmp = (a, b, types = { created_at: 'timestamp', archived_at: 'timestamp?', title: 'text' }) =>
    Array.from(app.ctx.compareRowFields(a, b, types));
  const ts = (a, b, type) => cmp({ created_at: a }, { created_at: b }, type ? { created_at: type } : undefined);
  // equivalent representations
  assert.deepStrictEqual(ts('2026-10-11T04:32:05.325Z', '2026-10-11T04:32:05.325+00:00'), []);
  assert.deepStrictEqual(ts('2026-10-11T04:32:05.325000Z', '2026-10-11T04:32:05.325+00:00'), []);
  assert.deepStrictEqual(ts('2026-10-11T04:32:05Z', '2026-10-11T04:32:05.000+00:00'), []);
  assert.deepStrictEqual(ts('2026-10-11T06:32:05.123456+02:00', '2026-10-11T04:32:05.123456+00:00'), []);
  assert.deepStrictEqual(ts('2026-10-11T00:02:05-0430', '2026-10-11T04:32:05+00:00'), []);
  assert.deepStrictEqual(cmp({ archived_at: '2026-01-01T00:00:00Z' }, { archived_at: '2026-01-01T00:00:00+00:00' }), []);
  // genuinely different instants, including one microsecond and a different offset
  assert.deepStrictEqual(ts('2026-10-11T04:32:05.325Z', '2026-10-11T04:32:05.325001+00:00'), ['created_at']);
  assert.deepStrictEqual(ts('2026-10-11T04:32:05.325Z', '2026-10-11T05:32:05.325+00:00'), ['created_at']);
  assert.deepStrictEqual(ts('2026-10-11T04:32:05.325+01:00', '2026-10-11T04:32:05.325+00:00'), ['created_at']);
  // years 0000–0099 keep their literal year (never read as 1900–1999), and still normalize among themselves
  assert.deepStrictEqual(ts('0026-01-01T00:00:00Z', '1926-01-01T00:00:00+00:00'), ['created_at']);
  assert.deepStrictEqual(ts('0000-01-01T00:00:00Z', '1900-01-01T00:00:00+00:00'), ['created_at']);
  assert.deepStrictEqual(ts('0099-12-31T23:59:59.5Z', '1999-12-31T23:59:59.5+00:00'), ['created_at']);
  assert.deepStrictEqual(ts('0026-01-01T00:00:00Z', '0026-01-01T00:00:00.000000+00:00'), []);
  assert.deepStrictEqual(ts('0026-01-01T01:00:00+01:00', '0026-01-01T00:00:00+00:00'), []);
  assert.deepStrictEqual(ts('0000-01-01T00:30:00+01:00', '-0001-12-31T23:30:00+00:00'), ['created_at'], 'a crossing into year −1 is not a supported form');
  // null and invalid values: never equal to a timestamp; identical text still equal
  assert.deepStrictEqual(cmp({ archived_at: null }, { archived_at: null }), []);
  assert.deepStrictEqual(cmp({ archived_at: null }, { archived_at: '2026-01-01T00:00:00+00:00' }), ['archived_at']);
  assert.deepStrictEqual(cmp({ archived_at: '2026-01-01T00:00:00Z' }, { archived_at: null }), ['archived_at']);
  assert.deepStrictEqual(ts('not a time', '2026-01-01T00:00:00+00:00'), ['created_at']);
  assert.deepStrictEqual(ts('2026-02-30T00:00:00Z', '2026-03-02T00:00:00+00:00'), ['created_at']);
  assert.deepStrictEqual(ts('2026-01-01T00:00:00', '2026-01-01T00:00:00+00:00'), ['created_at'], 'no offset: not comparable');
  assert.deepStrictEqual(ts('2026-01-01T00:00:00.1234567Z', '2026-01-01T00:00:00.123456+00:00'), ['created_at'], 'beyond microseconds: not comparable');
  assert.deepStrictEqual(ts('not a time', 'not a time'), []);
  // only known timestamp columns: the same pair under a text column, or with no types, still differs
  assert.deepStrictEqual(ts('2026-10-11T04:32:05.325Z', '2026-10-11T04:32:05.325+00:00', 'text'), ['created_at']);
  assert.deepStrictEqual(Array.from(app.ctx.compareRowFields({ created_at: '2026-10-11T04:32:05.325Z' }, { created_at: '2026-10-11T04:32:05.325+00:00' })), ['created_at']);
  // an ordinary non-timestamp mismatch is still reported next to an equivalent timestamp
  assert.deepStrictEqual(cmp({ title: 'A', created_at: '2026-10-11T04:32:05.325Z' }, { title: 'B', created_at: '2026-10-11T04:32:05.325+00:00' }), ['title']);
});

test('native restore: created_at returned in the database’s form verifies; a different instant does not', async () => {
  for (const [back, verified] of [['2026-01-01T00:00:00+00:00', true], ['2026-01-01T00:00:01+00:00', false]]) {
    const { app, backup } = await setup();
    backup.tables.watchlist_items[0].created_at = '2026-01-01T00:00:00.000Z';
    const restore = app.rpcHandlers.restore_backup;
    app.rpcHandlers.restore_backup = body => {
      const r = restore(body);
      app.store.watchlist_items = app.store.watchlist_items.map(x => ({ ...x, created_at: back }));
      return r;
    };
    await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`);
    assert.match(app.el('restoreModalBox').innerHTML, verified ? /restored and verified/ : /verification failed[\s\S]*created_at/);
  }
});

T.run();
