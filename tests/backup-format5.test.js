// Offline tests for backup format 5 and the restore input classes (B4/B5 Batch A, plan §9),
// in the whole-page harness: the format-5 export (exact tables and columns, made only on the
// B4/B5 database, phase read before and after); a native format-5 round trip with an active
// and a completed-but-retained earlier-seasons range, a preserved pair, provenance and
// metadata (RL8); native format 4 converted 4 → 5 by the converter column of §7.1 (M2), with
// its own conversion record and no recovery section; format 3 converted 3 → 4 → 5 with its
// conversion record and recovery section preserved verbatim while the archive is active; a
// hand-made format-4 file carrying those sections; and the format-5 refusals in the preview,
// nothing sent (N1, RL9). Both resume columns are NULL after any conversion (RL11).
// The database side: db/test/t_b45.sql (N1, RL8–RL10) and tools/db-rehearsal-b45.mjs.
// Run from the repo root: node tests/backup-format5.test.js
const assert = require('assert');
const crypto = require('crypto');
const { createApp, runner, settle, legacyBackupFixture } = require('./app-harness');

const T = runner('backup-format5');
const test = T.test;

const TS = '2026-10-01T00:00:00+00:00';
let n = 0;
const uuid = p => `${p}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const showOf = (o = {}) => ({ id: uuid('5a000000'), collection: 'othertv', title: 'Show', show_key: `show ${n}`, tmdb_id: null, status: 'confirmed', created_at: TS, ...o });
const seasonOf = (sh, num, o = {}) => ({ id: uuid('5b000000'), collection: sh.collection, title: sh.title, theme: 'Net', status: 'confirmed', watched: false, skipped: false,
  show_id: sh.id, media_type: null, tmdb_id: null, season_number: null, season: `Season ${num}`, display_date: 'Jan 1, 2020', date_sort: `20${10 + num}-01-01`,
  item_key: `${sh.show_key}|season ${num}`, watch_with: [], collections: [], created_at: TS, tmdb_collection_id: null, tmdb_collection_name: null, ...o });
const filmOf = (o = {}) => ({ id: uuid('f0000000'), collection: 'movies', title: `Film ${n}`, theme: 'Drama', status: 'confirmed', watched: false, skipped: false,
  show_id: null, media_type: 'movie', tmdb_id: 900 + n, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], created_at: TS, tmdb_collection_id: null, tmdb_collection_name: null, ...o });
const out = v => JSON.parse(JSON.stringify(v));
const fileOf = obj => { const text = JSON.stringify(obj); return { text: async () => text, sha: crypto.createHash('sha256').update(text, 'utf8').digest('hex') }; };
const modal = app => app.el('restoreModalBox').innerHTML.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const restoreCalls = app => app.requests.filter(r => r.url.endsWith('/rpc/restore_backup'));
async function choose(app, file) {
  app.ctx.openSettings(null); // S1 (D11): restore runs only on Settings (no navigation if already there)
  await app.ctx.handleRestoreFileSelected({ target: { files: [file], value: 'x' } }); await settle();
}
async function send(app) { await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle(); }

// A library with every old status (shows and films), for format 3 / 4 sources (no B4/B5 migration).
function oldLibrary() {
  const shows = ['confirmed', 'watching', 'skipped', 'pending', 'highpriority', 'maybe', 'complete'].map(st => showOf({ title: `S-${st}`, show_key: `s-${st}`, status: st }));
  const rows = shows.map(s => seasonOf(s, 1));
  const films = [['confirmed', false], ['confirmed', true], ['skipped', false], ['skipped', true], ['pending', false], ['highpriority', true], ['maybe', false],
    ['watching', false], ['watching', true], ['complete', true]].map(([st, w]) => filmOf({ title: `F-${st}-${w}`, item_key: `f-${st}-${w}|film`, status: st, watched: w }));
  return { shows, rows: rows.concat(films) };
}
// A format-4 file: the page's format-4 columns read from a contracted (5c) database.
async function format4File() {
  const lib = oldLibrary();
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows, stage5: 'contracted' });
  const spec = app.get('BACKUP_FORMAT_V4');
  const tables = {};
  for (const t of spec.tables) tables[t] = out(await app.ctx.fetchAllRows(t, null, Object.keys(spec.columns[t]).join(',')));
  return { format: app.get('BACKUP_FORMAT'), formatVersion: 4, exportedAt: '2026-10-12T09:24:00.000Z', rowCounts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])), tables };
}

// ─── The format-5 export ──────────────────────────────────────────────────────
test('format 5: the eight tables with exactly the format-5 columns, in order; the phase is read before and after the tables; it validates', async () => {
  const sh = showOf({ priority: 'high', ended: true, genres: ['Drama'], network: 'HBO', network_candidates: ['HBO'] });
  const a = seasonOf(sh, 1), b = seasonOf(sh, 2, { watched: true });
  Object.assign(sh, { resume_start_season_id: a.id, resume_end_season_id: b.id });
  const app = await createApp({ rows: [a, b, filmOf({ priority: 'low', legacy_status: 'maybe' })], tvShows: [sh] });
  const before = app.requests.length;
  const doc = await app.ctx.buildBackupObject();
  const reads = app.requests.slice(before).map(r => r.url.split('/rest/v1/')[1].split('?')[0]);
  assert.strictEqual(reads[0], 'rpc/stage5_capabilities');
  assert.strictEqual(reads.at(-1), 'rpc/stage5_capabilities', 'read again after the tables');
  const spec = app.get('BACKUP_FORMAT_V5');
  assert.strictEqual(doc.formatVersion, 5);
  assert.deepStrictEqual(Object.keys(doc.tables), Array.from(spec.tables));
  for (const t of spec.tables) for (const r of doc.tables[t]) assert.deepStrictEqual(Object.keys(r), Object.keys(spec.columns[t]), t);
  assert.ok(!('conversion' in doc) && !('recovery' in doc));
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(doc)), []);
  assert.deepStrictEqual(app.writes(), []);
});

test('RL8 a native format-5 round trip restores every value exactly — an active and a completed-but-retained range, a preserved pair, provenance, markers, metadata — and the derived sequence is unchanged', async () => {
  const act = showOf({ title: 'Active', status: 'watching', ended: true, legacy_status: 'complete', status_review: true });
  const a1 = seasonOf(act, 1), a2 = seasonOf(act, 2), a3 = seasonOf(act, 3, { watched: true });
  Object.assign(act, { resume_start_season_id: a1.id, resume_end_season_id: a3.id });
  const done = showOf({ title: 'Done', status: 'watching', catalog_new: true });
  const d1 = seasonOf(done, 1, { watched: true }), d2 = seasonOf(done, 2, { watched: true }), d3 = seasonOf(done, 3);
  Object.assign(done, { resume_start_season_id: d1.id, resume_end_season_id: d2.id });
  const pair = filmOf({ status: 'skipped', watched: true, priority: 'high', genres: ['Crime'], genre_candidates: ['War & Politics'], metadata_owner_set: true });
  const src = await createApp({ rows: [a1, a2, a3, d1, d2, d3, pair], tvShows: [act, done] });
  const doc = out(await src.ctx.buildBackupObject());
  const target = await createApp({ rows: [seasonOf(showOf(), 1)], tvShows: [] });
  target.ctx.switchView('alltv'); await settle();
  const file = fileOf(doc);
  await choose(target, file);
  assert.match(modal(target), /Restore database/);
  assert.strictEqual(target.get('pendingRestoreData.formatVersion'), 5);
  await send(target);
  assert.match(target.el('restoreModalBox').innerHTML, /restored and verified/);
  assert.deepStrictEqual(out(restoreCalls(target)[0].body.p_backup), doc, 'sent unchanged');
  const pick = (store, keys) => store.map(r => Object.fromEntries(keys.map(k => [k, r[k]]))).sort((x, y) => (x.id < y.id ? -1 : 1));
  const showKeys = Object.keys(doc.tables.tv_shows[0]), itemKeys = Object.keys(doc.tables.watchlist_items[0]).filter(k => k !== 'theme_kind');
  assert.deepStrictEqual(pick(target.store.tv_shows, showKeys), pick(src.store.tv_shows, showKeys));
  assert.deepStrictEqual(pick(target.store.watchlist_items, itemKeys), pick(src.store.watchlist_items, itemKeys));
  const seq = app => ['Active', 'Done'].map(t => {
    const s = app.store.tv_shows.find(x => x.title === t);
    const r = app.ctx.resumeRange(s, app.store.watchlist_items.filter(x => x.show_id === s.id));
    return `${r.state}:${Array.from(r.sequence, x => x.season).join(',')}`;
  });
  assert.deepStrictEqual(seq(target), seq(src));
  assert.deepStrictEqual(seq(target), ['active:Season 1,Season 2', 'complete:'], 'the completed range is kept as stored');
});

// ─── Native format 4 → 5 (M2, RL11) ───────────────────────────────────────────
test('M2 native format 4: converted by the converter column of §7.1 (every old status, shows and films); pairs kept; both resume columns NULL; season rows NULL; its own conversion record; no recovery section', async () => {
  const f4 = await format4File();
  const app = await createApp();
  app.ctx.switchView('alltv'); await settle();
  const file = fileOf(f4);
  await choose(app, file);
  const doc = out(app.get('pendingRestoreData'));
  assert.strictEqual(doc.formatVersion, 5);
  assert.deepStrictEqual(doc.conversion, { source_format: 4, source_exported_at: f4.exportedAt, source_sha256: file.sha, converter_version: 'b45.1' });
  assert.ok(!('recovery' in doc));
  const S = t => doc.tables.tv_shows.find(s => s.title === t);
  const pick = (r, ks) => ks.map(k => r[k]);
  const SK = ['status', 'priority', 'ended', 'catalog_new', 'status_review', 'legacy_status'];
  assert.deepStrictEqual(pick(S('S-confirmed'), SK), ['confirmed', 'normal', false, false, false, null]);
  assert.deepStrictEqual(pick(S('S-watching'), SK), ['watching', 'normal', false, false, false, null]);
  assert.deepStrictEqual(pick(S('S-skipped'), SK), ['skipped', 'normal', false, false, false, null]);
  assert.deepStrictEqual(pick(S('S-pending'), SK), ['confirmed', 'normal', false, true, false, 'pending']);
  assert.deepStrictEqual(pick(S('S-highpriority'), SK), ['confirmed', 'high', false, false, false, 'highpriority']);
  assert.deepStrictEqual(pick(S('S-maybe'), SK), ['confirmed', 'low', false, false, false, 'maybe']);
  assert.deepStrictEqual(pick(S('S-complete'), SK), ['confirmed', 'normal', true, false, true, 'complete'], 'Complete: To Watch, Ended, Needs status review');
  assert.ok(doc.tables.tv_shows.every(s => s.resume_start_season_id === null && s.resume_end_season_id === null && s.network === null && s.metadata_owner_set === false));
  const F = t => doc.tables.watchlist_items.find(r => r.title === t);
  const FK = ['status', 'watched', 'priority', 'catalog_new', 'status_review', 'legacy_status'];
  const want = {
    'F-confirmed-false': ['confirmed', false, 'normal', false, false, null], 'F-confirmed-true': ['confirmed', true, 'normal', false, false, null],
    'F-skipped-false': ['skipped', false, 'normal', false, false, null], 'F-skipped-true': ['skipped', true, 'normal', false, false, null],
    'F-pending-false': ['confirmed', false, 'normal', true, false, 'pending'], 'F-highpriority-true': ['confirmed', true, 'high', false, false, 'highpriority'],
    'F-maybe-false': ['confirmed', false, 'low', false, false, 'maybe'], 'F-watching-false': ['confirmed', false, 'normal', false, true, 'watching'],
    'F-watching-true': ['confirmed', true, 'normal', false, true, 'watching'], 'F-complete-true': ['confirmed', true, 'normal', false, true, 'complete']
  };
  for (const [t, v] of Object.entries(want)) assert.deepStrictEqual(pick(F(t), FK), v, t);
  assert.ok(doc.tables.watchlist_items.filter(r => r.show_id).every(r => ['priority', 'catalog_new', 'status_review', 'legacy_status', 'genres', 'metadata_owner_set'].every(k => r[k] === null)));
  // Every format-4 field is kept as it was (except the statuses the table maps).
  for (const t of Object.keys(f4.tables)) for (const r of f4.tables[t]) {
    const c = doc.tables[t].find(x => x.id === r.id);
    for (const k of Object.keys(r)) if (k !== 'status') assert.deepStrictEqual(c[k], r[k], `${t}.${k}`);
  }
  const m = modal(app);
  assert.match(m, /This backup is converted to format 5 before restoring/);
  assert.match(m, /1 shows and 1 films that were Pending: To Watch, marked New from catalog\./);
  assert.match(m, /1 shows that were Complete: To Watch, Show ended, Needs status review\./);
  assert.match(m, /3 films that were Watching or Complete: To Watch or Watched \(as marked\), Needs status review\./);
  assert.match(m, /1 films that are both Skipped and marked watched are kept that way\./);
  assert.match(m, /Needs status review: S-complete, F-watching-false, F-watching-true, F-complete-true\./);
  assert.match(m, /No field of the backup is lost\./);
  await send(app);
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  assert.strictEqual(restoreCalls(app)[0].body.p_backup.formatVersion, 5, 'never the format-4 file itself');
});

test('format 3 → 4 → 5: the conversion record (source format 3, the file’s hash, converter 5.1+b45.1) and the recovery section are preserved verbatim while the archive is active; none once it is retired (RL11)', async () => {
  const lib = oldLibrary();
  const co = await createApp({ rows: lib.rows, tvShows: lib.shows, stage5: 'coexistence' });
  const f3 = await legacyBackupFixture(co, 3);
  for (const archive of ['active', 'retired']) {
    const app = await createApp({ recoveryArchive: archive });
    app.ctx.switchView('alltv'); await settle();
    const file = fileOf(f3);
    await choose(app, file);
    const doc = out(app.get('pendingRestoreData'));
    const ref = out(app.ctx.convertFormat3To4(f3, { includeRecovery: archive === 'active', sourceSha256: file.sha }).doc);
    assert.deepStrictEqual(doc.conversion, { ...ref.conversion, converter_version: `${ref.conversion.converter_version}+b45.1` });
    assert.strictEqual(doc.conversion.source_format, 3);
    assert.strictEqual(doc.conversion.source_sha256, file.sha);
    if (archive === 'active') assert.deepStrictEqual(doc.recovery, ref.recovery, 'verbatim');
    else assert.ok(!('recovery' in doc));
    assert.ok(doc.tables.tv_shows.every(s => s.resume_start_season_id === null && s.resume_end_season_id === null));
    assert.match(modal(app), /This is a format 3 backup; it is converted before restoring/);
    await send(app);
    assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/, archive);
  }
});

test('a format-4 file carrying a conversion record and recovery section (made by hand): accepted only when both are what the page writes and the archive is active; otherwise refused in the preview, nothing sent', async () => {
  const lib = oldLibrary();
  const co = await createApp({ rows: lib.rows, tvShows: lib.shows, stage5: 'coexistence' });
  const f3 = await legacyBackupFixture(co, 3);
  const helper = await createApp();
  const sha = 'b'.repeat(64);
  const good = out(helper.ctx.convertFormat3To4(f3, { includeRecovery: true, sourceSha256: sha }).doc);
  const cases = [
    ['valid, archive active', good, 'active', null],
    ['valid, archive retired', good, 'retired', /the recovery archive has been retired/],
    ['malformed conversion', { ...good, conversion: { ...good.conversion, source_sha256: 'x' } }, 'active', /Its conversion record isn’t one this page writes/],
    ['recovery without conversion', (({ conversion, ...d }) => d)(good), 'active', /It has a recovery section without a conversion record/],
    ['malformed recovery', { ...good, recovery: { storage_map: {} } }, 'active', /Its recovery section isn’t one this page writes/]
  ];
  for (const [label, doc, archive, refusal] of cases) {
    const app = await createApp({ recoveryArchive: archive });
    app.ctx.switchView('alltv'); await settle();
    await choose(app, fileOf(doc));
    if (!refusal) {
      const sent = out(app.get('pendingRestoreData'));
      assert.deepStrictEqual(sent.recovery, good.recovery, label);
      assert.strictEqual(sent.conversion.source_sha256, sha, `${label}: the original file's hash is kept`);
      await send(app);
      assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/, label);
    } else {
      assert.match(modal(app), refusal, label);
      assert.strictEqual(app.get('pendingRestoreData'), null, label);
      assert.strictEqual(restoreCalls(app).length, 0, label);
      assert.deepStrictEqual(app.writes(), [], label);
    }
  }
});

// ─── Format-5 refusals in the preview (N1, RL9) ───────────────────────────────
// GA-1 review 7: the recovery section is checked against the backup's own rows before any
// actionable confirmation (restore_backup's rules; the database checks again). Each case changes
// one thing in a valid section; each is refused in the preview with nothing sent, both for a
// format-4 file (converted 4 → 5) and for a format-5 file carrying the sections.
test('recovery section: malformed entries and entries not corresponding to the backup are refused in the preview, nothing sent (format 4 and format 5 carrying the sections)', async () => {
  const lib = oldLibrary();
  const co = await createApp({ rows: lib.rows, tvShows: lib.shows, stage5: 'coexistence' });
  const f3 = await legacyBackupFixture(co, 3);
  const helper = await createApp();
  const good = out(helper.ctx.convertFormat3To4(f3, { includeRecovery: true, sourceSha256: 'b'.repeat(64) }).doc);
  // The same sections on a format-5 document (what the page makes of a format-3 file while the archive is active).
  const conv = await createApp();
  await choose(conv, fileOf(good));
  const good5 = out(conv.get('pendingRestoreData'));
  assert.strictEqual(good5.formatVersion, 5); assert.ok(good5.recovery && good5.conversion);
  const film = d => d.tables.watchlist_items.find(w => w.media_type === 'movie');
  const season = d => d.tables.watchlist_items.find(w => w.show_id);
  const ent = (d, kind, id) => d.recovery.storage_map[kind].find(x => x.id === id);
  const otv = (o = {}) => ({ collection: 'othertv', created_at: TS, id: '0d000000-0000-4000-8000-000000000001', network: 'Net', title: 'T', tmdb_id: 77, ...o });
  const cases = [
    ['an item entry with an extra field', d => { d.recovery.storage_map.items[0].note = 'x'; }, /recovery item entry doesn’t have exactly the expected fields/],
    ['a show entry missing its storage', d => { delete d.recovery.storage_map.shows[0].collection; }, /recovery show entry doesn’t have exactly the expected fields/],
    ['an extra key in the section', d => { d.recovery.extra = []; }, /structure is malformed/],
    ['an extra key in the storage map', d => { d.recovery.storage_map.films = []; }, /structure is malformed/],
    ['a saved row without an entry', d => { d.recovery.storage_map.items.shift(); }, /saved rows have no recovery entry/],
    ['a show without an entry', d => { d.recovery.storage_map.shows.shift(); }, /shows have no recovery entry/],
    ['an entry for a record not in the backup', d => { d.recovery.storage_map.items.push({ collection: 'movies', id: 'f0000000-0000-4000-8000-0000000009ff' }); }, /recovery entries name records that aren’t in the backup/],
    ['a repeated entry', d => { d.recovery.storage_map.items.push({ ...d.recovery.storage_map.items[0] }); }, /recovery entries name the same record twice/],
    ['an unknown storage', d => { ent(d, 'items', film(d).id).collection = 'cinema'; }, /recovery entries name an unknown storage/],
    ['a season stored apart from its show', d => { ent(d, 'items', season(d).id).collection = 'truecrime'; }, /season recovery entries disagree with their show’s/],
    ['a show entry naming a catalog that doesn’t govern it', d => { d.recovery.storage_map.shows[0].collection = 'disney'; }, /show recovery entries disagree with what the backup’s catalogs govern/],
    ['a film entry disagreeing with its theme meaning', d => { ent(d, 'items', film(d).id).collection = 'othertv'; }, /film recovery entries disagree with the backup’s catalogs or theme meanings/],
    ['a collection entry disagreeing with its collection', d => { d.recovery.storage_map.personal_collections[0].legacy_source = 'truecrime'; }, /collection recovery entries disagree with the backup’s collections/],
    ['a collection without an entry', d => { d.recovery.storage_map.personal_collections.shift(); }, /collections have no recovery entry/],
    ['a repeated collection entry', d => { d.recovery.storage_map.personal_collections.push({ ...d.recovery.storage_map.personal_collections[0] }); }, /collection recovery entries repeat a collection/],
    ['an other-TV row with an invalid id', d => { d.recovery.othertv_shows.push(otv({ id: 'x' })); }, /other-TV recovery rows have an id that isn’t a valid lowercase uuid/],
    // GA-1 review 7 (remaining): ids of 36 hex digits / hyphens that aren't uuids, created_at values, repeated ids.
    ['an other-TV id of 36 hyphens', d => { d.recovery.othertv_shows.push(otv({ id: '-'.repeat(36) })); }, /other-TV recovery rows have an id that isn’t a valid lowercase uuid/],
    ['an other-TV id of 36 hex digits', d => { d.recovery.othertv_shows.push(otv({ id: '0d0000000000400080000000000000010000' })); }, /other-TV recovery rows have an id that isn’t a valid lowercase uuid/],
    ['an other-TV id with a misplaced hyphen', d => { d.recovery.othertv_shows.push(otv({ id: '0d0000000-000-4000-8000-000000000001' })); }, /other-TV recovery rows have an id that isn’t a valid lowercase uuid/],
    ['an other-TV id in capitals', d => { d.recovery.othertv_shows.push(otv({ id: '0D000000-0000-4000-8000-000000000001' })); }, /other-TV recovery rows have an id that isn’t a valid lowercase uuid/],
    ['an other-TV created_at that isn’t a date', d => { d.recovery.othertv_shows.push(otv({ created_at: 'not a date' })); }, /other-TV recovery rows have a created_at that isn’t a valid date and time/],
    ['an other-TV created_at on an impossible day', d => { d.recovery.othertv_shows.push(otv({ created_at: '2026-02-30T00:00:00+00:00' })); }, /other-TV recovery rows have a created_at that isn’t a valid date and time/],
    ['an other-TV created_at with an impossible time', d => { d.recovery.othertv_shows.push(otv({ created_at: '2026-01-01T25:00:00+00:00' })); }, /other-TV recovery rows have a created_at that isn’t a valid date and time/],
    ['an other-TV created_at that is null', d => { d.recovery.othertv_shows.push(otv({ created_at: null })); }, /other-TV recovery rows have a created_at that isn’t a valid date and time/],
    ['an other-TV created_at that is a number', d => { d.recovery.othertv_shows.push(otv({ created_at: 1767225600000 })); }, /other-TV recovery rows have a created_at that isn’t a valid date and time/],
    ['other-TV rows repeating an id for different shows', d => { d.recovery.othertv_shows.push(otv(), otv({ collection: 'truecrime', tmdb_id: 78 })); }, /other-TV recovery rows repeat an id/],
    ['other-TV rows repeating an id spelled with other hyphens', d => { d.recovery.othertv_shows.push(otv(), otv({ id: '0d00-0000-0000-400080000000-00000001', tmdb_id: 78 })); }, /other-TV recovery rows repeat an id/],
    ['an other-TV TMDB id beyond an integer', d => { d.recovery.othertv_shows.push(otv({ tmdb_id: 2147483648 })); }, /other-TV recovery rows have a TMDB id that isn’t a whole number/],
    ['other-TV rows repeating a show (TMDB id as text and as a number)', d => { d.recovery.othertv_shows.push(otv(), otv({ id: '0d000000-0000-4000-8000-000000000002', tmdb_id: '077' })); }, /other-TV recovery rows repeat a show/],
    ['an other-TV title of spaces', d => { d.recovery.othertv_shows.push(otv({ title: '   ' })); }, /other-TV recovery rows have a title that is blank/],
    ['an other-TV row with a missing field', d => { const { network, ...o } = otv(); d.recovery.othertv_shows.push(o); }, /recovery other-TV entry doesn’t have exactly the expected fields/],
    ['repeated other-TV rows', d => { d.recovery.othertv_shows.push(otv(), otv({ id: '0d000000-0000-4000-8000-000000000002' })); }, /other-TV recovery rows repeat a show/]
  ];
  for (const [fmt, base] of [['format 4', good], ['format 5', good5]]) {
    for (const [label, change, refusal] of cases) {
      const doc = out(base); change(doc);
      const app = await createApp();
      app.ctx.switchView('alltv'); await settle();
      await choose(app, fileOf(doc));
      assert.match(modal(app), refusal, `${fmt}: ${label}`);
      assert.doesNotMatch(app.el('restoreModalBox').innerHTML, /continueRestore|Restore this backup/, `${fmt}: ${label}: no actionable confirmation`);
      assert.strictEqual(app.get('pendingRestoreData'), null, `${fmt}: ${label}`);
      assert.strictEqual(restoreCalls(app).length, 0, `${fmt}: ${label}`);
      assert.deepStrictEqual(app.writes(), [], `${fmt}: ${label}`);
    }
    // The unchanged sections are still accepted, and the database's own check is still the last word;
    // so are valid other-TV rows in the other spellings the database reads (an id with its hyphens
    // elsewhere, a TMDB id as text, no fraction or a space and Z, a Feb 29, an offset without colon).
    const extra = [otv({ id: '0d00-0000-0000-400080000000-00000003', tmdb_id: '79', created_at: '2024-02-29 12:00:00Z' }),
      otv({ id: '0d000000-0000-4000-8000-000000000004', collection: 'truecrime', tmdb_id: 79, created_at: '2026-10-12T09:24:00.5-0530', network: '' })];
    for (const [what, doc] of [['unchanged', out(base)], ['with valid other-TV rows', (d => { d.recovery.othertv_shows.push(...extra); return d; })(out(base))]]) {
      const app = await createApp();
      app.ctx.switchView('alltv'); await settle();
      await choose(app, fileOf(doc));
      assert.ok(app.get('pendingRestoreData'), `${fmt} ${what}: the valid section is offered`);
      assert.deepStrictEqual(out(app.get('pendingRestoreData')).recovery.othertv_shows, doc.recovery.othertv_shows, `${fmt} ${what}: kept verbatim`);
      await send(app);
      assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/, `${fmt} ${what}`);
    }
  }
});

test('N1 / RL9: a format-5 document breaking the row-class or range rules is refused in the preview — nothing sent, downloaded or pending', async () => {
  const sh = showOf({ title: 'R' }), other = showOf({ title: 'O' });
  const a = seasonOf(sh, 1), b = seasonOf(sh, 2, { watched: true }), o1 = seasonOf(other, 1), f = filmOf();
  const src = await createApp({ rows: [a, b, o1, f], tvShows: [sh, other] });
  const base = out(await src.ctx.buildBackupObject());
  const mut = fn => { const d = JSON.parse(JSON.stringify(base)); fn(d); return d; };
  const S = d => d.tables.tv_shows.find(x => x.id === sh.id), F = d => d.tables.watchlist_items.find(x => x.id === f.id), A = d => d.tables.watchlist_items.find(x => x.id === a.id);
  const cases = [
    ['a film without priority', d => { F(d).priority = null; }, /is a film without priority/],
    ['a season with a priority', d => { A(d).priority = 'high'; }, /is a TV season but has priority/],
    ['a season with provenance', d => { A(d).legacy_status = 'pending'; }, /is a TV season but has legacy_status/],
    ['a film legacy outside the domain', d => { F(d).legacy_status = 'bogus'; }, /has legacy_status "bogus"/],
    ['a removed film status', d => { F(d).status = 'watching'; }, /has film status "watching"/],
    ['a removed show status', d => { S(d).status = 'complete'; }, /tv_shows status/],
    ['one resume column only', d => { S(d).resume_start_season_id = a.id; }, /incomplete earlier-seasons range/],
    ['start = boundary', d => { Object.assign(S(d), { resume_start_season_id: a.id, resume_end_season_id: a.id }); }, /incomplete earlier-seasons range/],
    ['another show’s season', d => { Object.assign(S(d), { resume_start_season_id: o1.id, resume_end_season_id: b.id }); }, /naming a season that isn’t one of its own/],
    ['a film', d => { Object.assign(S(d), { resume_start_season_id: f.id, resume_end_season_id: b.id }); }, /naming a season that isn’t one of its own/],
    ['an absent row', d => { Object.assign(S(d), { resume_start_season_id: uuid('5b000000'), resume_end_season_id: b.id }); }, /naming a season that isn’t one of its own/]
  ];
  for (const [label, fn, re] of cases) {
    const app = await createApp();
    app.ctx.switchView('alltv'); await settle();
    let downloads = 0;
    app.ctx.downloadJSON = () => { downloads++; };
    await choose(app, fileOf(mut(fn)));
    assert.match(modal(app), re, label);
    assert.ok(!app.el('restoreModalBox').innerHTML.includes('executeRestore()'), label);
    assert.strictEqual(app.get('pendingRestoreData'), null, label);
    assert.strictEqual(downloads, 0, label);
    assert.deepStrictEqual(app.writes(), [], label);
  }
});

test('a restore preview cancelled (Close) sends nothing; formats 1 and 2 stay refused', async () => {
  const app = await createApp();
  app.ctx.switchView('alltv'); await settle();
  const doc = out(await app.ctx.buildBackupObject());
  await choose(app, fileOf(doc));
  app.ctx.closeRestoreModal();
  assert.strictEqual(app.get('pendingRestoreData'), null);
  assert.deepStrictEqual(app.writes(), []);
  const v1 = await createApp({ rows: [filmOf()], format1: true });
  await choose(app, fileOf(await legacyBackupFixture(v1, 1)));
  assert.match(modal(app), /predates TV shows \(format 1\)[\s\S]*only format 5 backups can be restored/);
  assert.deepStrictEqual(app.writes(), []);
});

T.run();
