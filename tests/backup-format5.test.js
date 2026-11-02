// Offline tests for backup format 5 and the restore input classes (B4/B5 Batch A, plan §9),
// carried forward to format 6 (EP1: format 5 plus episode_marks; every format-5 document is converted
// 5 → 6 before restoring, tests/episodes.test.js has the marks themselves),
// in the whole-page harness: the format-5 export (exact tables and columns, made only on the
// B4/B5 database, phase read before and after); a native format-5 round trip with an active
// and a completed-but-retained earlier-seasons range, a preserved pair, provenance and
// metadata (RL8); files carrying the retired conversion and recovery sections; formats 3 and 4
// refused; and the format-5 refusals in the preview, nothing sent (N1, RL9).
// The database side: tools/restore-test.mjs.
// Run from the repo root: node tests/backup-format5.test.js
const assert = require('assert');
const crypto = require('crypto');
const { createApp, runner, settle } = require('./app-harness');

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

// ─── The format-5 export ──────────────────────────────────────────────────────
test('format 7: the nineteen tables with exactly the format-7 columns, in order; the phase is read before and after the tables; it validates', async () => {
  const sh = showOf({ priority: 'high', ended: true, genres: ['Drama'], network: 'HBO', network_candidates: ['HBO'] });
  const a = seasonOf(sh, 1), b = seasonOf(sh, 2, { watched: true });
  Object.assign(sh, { resume_start_season_id: a.id, resume_end_season_id: b.id });
  const app = await createApp({ rows: [a, b, filmOf({ priority: 'low', legacy_status: 'maybe' })], tvShows: [sh] });
  const before = app.requests.length;
  const doc = await app.ctx.buildBackupObject();
  const reads = app.requests.slice(before).map(r => r.url.split('/rest/v1/')[1].split('?')[0]);
  assert.strictEqual(reads[0], 'rpc/stage5_capabilities');
  assert.strictEqual(reads.at(-1), 'rpc/stage5_capabilities', 'read again after the tables');
  const spec = app.get('BACKUP_FORMAT_V7');
  assert.strictEqual(doc.formatVersion, 7);
  assert.deepStrictEqual(Array.from(spec.tables), Array.from(app.get('BACKUP_FORMAT_V5').tables).concat(['episode_marks'], Array.from(app.get('CU1_TABLES'))));
  assert.deepStrictEqual(Object.keys(doc.tables), Array.from(spec.tables));
  for (const t of spec.tables) for (const r of doc.tables[t]) assert.deepStrictEqual(Object.keys(r), Object.keys(spec.columns[t]), t);
  assert.ok(!('conversion' in doc) && !('recovery' in doc));
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(doc)), []);
  assert.deepStrictEqual(app.writes(), []);
});

test('RL8 a native format-7 round trip restores every value exactly — an active and a completed-but-retained range, a preserved pair, provenance, markers, metadata — and the derived sequence is unchanged', async () => {
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
  assert.strictEqual(target.get('pendingRestoreData.formatVersion'), 7);
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

// ─── Formats 3 and 4, and the sections they left behind ──────────────────────
test('formats 1 to 4: refused when the file is chosen, naming the last commit that read them and the docs; nothing sent, downloaded or pending', async () => {
  for (const v of [1, 2, 3, 4]) {
    const app = await createApp({ rows: [], tvShows: [] });
    await choose(app, fileOf({ format: app.get('BACKUP_FORMAT'), formatVersion: v, exportedAt: '2026-01-01T00:00:00Z', rowCounts: {}, tables: {} }));
    const m = modal(app);
    assert.match(m, new RegExp(`format ${v} backup, which this page no longer reads`));
    assert.match(m, /It restores formats 5 to 7/);
    assert.match(m, /docs\/ADMIN_RESTORE\.md/);
    assert.ok(m.includes(app.get('LAST_FORMAT_3_4_COMMIT')));
    assert.ok(!app.el('restoreModalBox').innerHTML.includes('executeRestore()'));
    assert.strictEqual(app.get('pendingRestoreData'), null);
    assert.strictEqual(restoreCalls(app).length, 0);
    assert.ok(app.requests.every(r => r.method === 'GET'), 'nothing written');
  }
});

test('a file carrying conversion and recovery sections (formats 5, 6 and 7): the preview says they aren’t restored, and neither is sent', async () => {
  const sh = showOf({ priority: 'normal', ended: false, catalog_new: false, status_review: false });
  const lib = { rows: [seasonOf(sh, 1)], tvShows: [sh] };
  const base = await createApp(lib);
  const b7 = out(await base.ctx.buildBackupObject());
  const drop = (d, tables) => { const c = out(d); tables.forEach(t => { delete c.tables[t]; delete c.rowCounts[t]; }); return c; };
  const six = { ...drop(b7, Array.from(base.get('CU1_TABLES'))), formatVersion: 6 }, five = { ...drop(six, ['episode_marks']), formatVersion: 5 };
  const sections = { conversion: { source_format: 3, source_exported_at: '2026-01-01T00:00:00Z', source_sha256: 'b'.repeat(64), converter_version: '5.1' },
    recovery: { storage_map: { items: [], shows: [], personal_collections: [] }, othertv_shows: [{ not: 'checked any more' }] } };
  for (const doc of [b7, six, five]) {
    const app = await createApp(lib);
    await choose(app, fileOf({ ...doc, ...sections }));
    assert.match(modal(app), /Old conversion data in this file isn’t restored/);
    await app.ctx.executeRestore(); await settle();
    await send(app);
    const sent = restoreCalls(app)[0].body.p_backup;
    assert.strictEqual(sent.formatVersion, 7);
    assert.ok(!('conversion' in sent) && !('recovery' in sent), `format ${doc.formatVersion}`);
    assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  }
  const plain = await createApp(lib);
  await choose(plain, fileOf(b7));
  assert.ok(!/Old conversion data/.test(modal(plain)), 'an ordinary file shows no such note');
  const original = { ...b7, ...sections };
  const sentBack = base.ctx.restoreDocument(original);
  assert.ok('recovery' in original && 'conversion' in original && !('recovery' in sentBack), 'the document read from the file isn’t changed');
});

test('N1 / RL9: a format-6 document breaking the row-class or range rules is refused in the preview — nothing sent, downloaded or pending', async () => {
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

test('a restore preview cancelled (Close) sends nothing', async () => {
  const app = await createApp();
  app.ctx.switchView('alltv'); await settle();
  const doc = out(await app.ctx.buildBackupObject());
  await choose(app, fileOf(doc));
  app.ctx.closeRestoreModal();
  assert.strictEqual(app.get('pendingRestoreData'), null);
  assert.deepStrictEqual(app.writes(), []);
});

T.run();
