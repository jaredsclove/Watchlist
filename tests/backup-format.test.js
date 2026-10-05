// Offline tests for backup formats 1 and 2 (backup-restore.js): the database's
// format is detected with a read-only probe, backups request exact columns and
// never contain user_id, format 2 adds tv_shows/show_id/skipped and is validated
// against the database's show rules, and restore handles the format combinations.
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

test('format 1 database: backup is format 1, exact columns, no user_id', async () => {
  const app = await createApp({ rows: v1Rows(), format1: true });
  const b = await app.run('buildBackupObject()');
  assert.strictEqual(b.formatVersion, 1);
  assert.deepStrictEqual(Array.from(Object.keys(b.tables)).sort(), ['custom_collections', 'othertv_shows', 'watchlist_items']);
  assert.strictEqual(Object.keys(b.tables.watchlist_items[0]).length, 18);
  assert.ok(Object.values(b.tables).every(rows => rows.every(r => !('user_id' in r))));
  assert.deepStrictEqual(Array.from(app.get('validateBackupObject')(b)), []);
  assert.ok(app.requests.every(r => r.method === 'GET'), 'backup only reads');
});

test('format 2 database: backup is format 2 with tv_shows, show_id and skipped, still no user_id', async () => {
  const app = await createApp({ rows: v2Rows(), tvShows: v2Shows() });
  const b = await app.run('buildBackupObject()');
  assert.strictEqual(b.formatVersion, 2);
  assert.deepStrictEqual(Array.from(Object.keys(b.tables)).sort(), ['custom_collections', 'othertv_shows', 'tv_shows', 'watchlist_items']);
  assert.strictEqual(b.rowCounts.tv_shows, 1);
  assert.deepStrictEqual(Array.from(Object.keys(b.tables.watchlist_items[0])).slice(-2), ['show_id', 'skipped']);
  assert.strictEqual(Object.keys(b.tables.tv_shows[0]).length, 7);
  assert.ok(Object.values(b.tables).every(rows => rows.every(r => !('user_id' in r))));
  assert.deepStrictEqual(Array.from(app.get('validateBackupObject')(b)), []);
});

test('format 2 validation refuses user_id, dangling or cross-collection links, linked films, unlinked skips, bad shows', async () => {
  const app = await createApp({ rows: v2Rows(), tvShows: v2Shows() });
  const good = await app.run('buildBackupObject()');
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
  assert.match(variant(b => { b.formatVersion = 3; }), /Unsupported backup format version \(3\)/);
  assert.match(variant(b => { b.formatVersion = 1; }), /Unexpected table\(s\) for format 1: tv_shows/);
});

test('restore: a format 2 file into a format 1 database is refused before anything changes', async () => {
  const src = await createApp({ rows: v2Rows(), tvShows: v2Shows() });
  const v2 = await src.run('buildBackupObject()');
  const app = await createApp({ rows: v1Rows(), format1: true });
  app.ctx.__b = v2;
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)');
  assert.match(app.el('restoreModalBox').innerHTML, /needs the TV-show database/);
  assert.strictEqual(app.get('pendingRestoreData'), null);
  assert.ok(app.requests.every(r => r.method === 'GET'));
});

test('restore: a format 1 file into a format 2 database is refused before anything changes (show status lives in tv_shows)', async () => {
  const src = await createApp({ rows: v1Rows(), format1: true });
  const v1 = await src.run('buildBackupObject()');
  const app = await createApp({ rows: v2Rows(), tvShows: v2Shows() });
  app.ctx.__b = v1;
  await app.run('pendingRestoreData = __b; renderRestorePreview(__b)');
  assert.match(app.el('restoreModalBox').innerHTML, /predates TV shows \(format 1\)/);
  assert.match(app.el('restoreModalBox').innerHTML, /only format 2 backups can be restored/);
  assert.strictEqual(app.get('pendingRestoreData'), null);
  assert.strictEqual(app.get('pendingRestoreAllowV1Reset'), false);
  assert.ok(app.requests.every(r => r.method === 'GET'), 'nothing written');
});

test('restore: same-format restores send the flag as false', async () => {
  for (const [rows, tvShows, format1] of [[v1Rows(), [], true], [v2Rows(), v2Shows(), false]]) {
    const app = await createApp({ rows, tvShows, format1 });
    const b = await app.run('buildBackupObject()');
    app.ctx.__b = b;
    await app.run('pendingRestoreData = __b; renderRestorePreview(__b)');
    assert.strictEqual(app.get('pendingRestoreAllowV1Reset'), false);
    assert.doesNotMatch(app.el('restoreModalBox').innerHTML, /predates TV shows/);
    await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`);
    const call = app.requests.find(r => r.url.includes('/rpc/restore_backup'));
    assert.strictEqual(call.body.p_allow_v1_reset, false);
    assert.strictEqual(call.body.p_backup.formatVersion, b.formatVersion);
  }
});

T.run();
