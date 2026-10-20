// Offline tests for episode progress within seasons (EP1, db/ep1_episode_marks.sql), in the whole-page
// harness: the collapsed "N/T watched" with its per-device cache and fallbacks; the inline episode list
// (fetched from TMDB, titles hidden until asked); marks set and cleared one change at a time through
// library_set_episode_marks (refusals put back what was shown; no answer is never resent); Mark through;
// the explicit Mark season watched suggestion (never automatic); watched and skipped seasons locked, their
// marks kept; unmatched seasons untouched; the guarded delete; backup format 6 and its restore; the same
// controls in a collection; and a page from before EP1 (the released files, from git) against the
// migrated database: backups and restores refused, ordinary writes continuing, a marked season's delete
// refused by the database.
// Run from the repo root: node tests/episodes.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const { createApp, runner, settle, userKeyOf } = require('./app-harness');

const T = runner('episodes');
const test = T.test;
const ROOT = path.join(__dirname, '..');
// The page as released before EP1 (M1, PR #7): its application files, read from git.
const RELEASE_BEFORE_EP1 = '502570a';

const TS = '2026-10-01T00:00:00+00:00';
let n = 0;
const uuid = p => `${p}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
function library() {
  const sev = { id: uuid('5a000000'), collection: 'othertv', title: 'Severance', show_key: 'severance', tmdb_id: 95396, status: 'watching', created_at: TS };
  const loc = { id: uuid('5a000000'), collection: 'othertv', title: 'Local', show_key: 'local', tmdb_id: null, status: 'watching', created_at: TS };
  const season = (sh, num, o = {}) => ({ id: uuid('5b000000'), collection: 'othertv', title: sh.title, theme: 'Apple TV', status: 'confirmed', watched: false, skipped: false,
    show_id: sh.id, media_type: sh.tmdb_id ? 'tv' : null, tmdb_id: sh.tmdb_id, season_number: sh.tmdb_id ? num : null, season: `Season ${num}`,
    display_date: 'Jan 1, 2022', date_sort: `202${num}-01-01`, item_key: `${sh.show_key}|season ${num}`, watch_with: [], collections: [], created_at: TS,
    tmdb_collection_id: null, tmdb_collection_name: null, ...o });
  const s1 = season(sev, 1, { watched: true }), s2 = season(sev, 2), s3 = season(sev, 3), l1 = season(loc, 1);
  return { sev, loc, s1, s2, s3, l1, rows: [s1, s2, s3, l1], shows: [sev, loc] };
}
const E = (id, num, o = {}) => ({ id, episode_number: num, name: `Title ${num}`, air_date: '2025-01-0' + Math.min(num, 9), ...o });
// Season 2: four listed episodes (one not aired yet, one without an air date); season 1: two.
const EPISODES = { 2: [E(9001, 1), E(9002, 2), E(9003, 3, { air_date: '2099-01-01' }), E(9004, 4, { air_date: null })], 1: [E(8001, 1), E(8002, 2)] };
const tmdb = (eps = EPISODES) => p => { const m = /^\/tv\/95396\/season\/(\d+)$/.exec(p); return m && eps[m[1]] ? { id: 1, episodes: eps[m[1]] } : undefined; };
function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m };
}
const mark = (season, id, num, o = {}) => ({ id: uuid('0f000000'), season_id: season.id, tmdb_episode_id: id, episode_number: num, ...o });
async function boot(o = {}) {
  const lib = library();
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows, tmdb: tmdb(o.episodes), storage: o.storage || memoryStorage(), episodeMarks: (o.marks || (() => []))(lib), width: o.width || 1200 });
  app.ctx.switchView('alltv'); await settle();
  app.ctx.toggleDerivedShow(lib.sev.id); await settle();
  return { app, lib };
}
const text = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|’/g, '’').replace(/\s+/g, ' ');
const html = app => app.el('tbody').innerHTML;
const card = app => app.el('cardList').innerHTML;
const writes = app => app.writes().map(r => `${r.method} ${r.url.split('/rest/v1/')[1].split('?')[0]}`);
const rpcs = (app, name) => app.writes().filter(r => r.url.endsWith(`/rpc/${name}`));
const banners = app => text(['phaseBanner', 'banner', 'errorBanner'].map(id => (app.el(id) || {}).innerHTML || '').join(' '));
const seasonRow = (app, s) => (html(app).match(new RegExp(`<tr[^>]*data-season-row="${s.id}"[\\s\\S]*?</tr>`)) || [''])[0];
const panel = app => text((html(app).match(/<tr class="sub-row ep-panel-row"[\s\S]*?<\/tr>/) || [''])[0]);
async function open(app, s) { app.ctx.toggleEpisodes(s.id); await settle(); }
const marksIn = (app, s) => app.store.episode_marks.filter(m => m.season_id === s.id).map(m => m.tmdb_episode_id).sort();

// ── Collapsed progress ──
test('collapsed: no marks, no text; marks without a cached list → "In progress · N marked"; Episodes only on matched seasons', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9002, 2)] });
  assert.ok(!/ep-progress/.test(seasonRow(app, lib.s3)), 'no marks: nothing');
  assert.match(text(seasonRow(app, lib.s2)), /In progress · 2 marked/);
  assert.ok(seasonRow(app, lib.s2).includes(`toggleEpisodes('${lib.s2.id}')`));
  app.ctx.toggleDerivedShow(lib.loc.id); await settle();
  assert.ok(!seasonRow(app, lib.l1).includes('toggleEpisodes'), 'an unmatched season has no episode list');
  assert.match(seasonRow(app, lib.l1), /Mark watched|Not aired/, 'its season-level controls are unchanged');
});

test('collapsed: against the cached list "N/T watched" counts only listed marks, unlisted ones apart; a count alone only while N < T; watched without "In progress"; skipped shows none', async () => {
  const storage = memoryStorage();
  const { app, lib } = await boot({ storage, marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 7777, 9), mark(l.s1, 8001, 1)] });
  await open(app, lib.s2); // the list is cached on this device (its ids)
  app.ctx.toggleEpisodes(lib.s2.id); await settle(); // closed again
  assert.match(text(seasonRow(app, lib.s2)), /In progress · 1\/4 watched · 1 not listed/);
  const cacheKey = userKeyOf('watchlist-episode-lists');
  assert.deepStrictEqual(JSON.parse(storage.getItem(cacheKey))['95396:2'], { ids: [9001, 9002, 9003, 9004] });
  // A count only (Refresh shows / Add season): N/T while the marks are fewer; never a complete-looking T/T.
  storage.setItem(cacheKey, JSON.stringify({ '95396:2': { count: 4 }, '95396:1': { count: 1 } }));
  app.ctx.renderTable();
  assert.match(text(seasonRow(app, lib.s2)), /In progress · 2\/4 watched/);
  assert.match(text(seasonRow(app, lib.s1)), /1 marked/, 'marks not fewer than the count: no total');
  assert.doesNotMatch(text(seasonRow(app, lib.s1)), /In progress|1\/1/, 'a watched season isn’t in progress');
  storage.setItem(cacheKey, '{"95396:2":{"ids":[9001,9002]}}');
  app.ctx.renderTable();
  assert.match(text(seasonRow(app, lib.s2)), /1\/2 watched · 1 not listed/, 'a stale list is shown as it is (accepted)');
  await app.ctx.setSeasonSkipped(lib.s2.id, true); await settle();
  assert.ok(!/ep-progress/.test(seasonRow(app, lib.s2)), 'skipped: no progress shown');
  assert.deepStrictEqual(marksIn(app, lib.s2), [7777, 9001], 'skipping kept the marks');
});

test('collapsed: unreadable storage leaves "N marked"; a corrupt cache is ignored', async () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  const { app, lib } = await boot({ storage: broken, marks: l => [mark(l.s2, 9001, 1)] });
  assert.match(text(seasonRow(app, lib.s2)), /In progress · 1 marked/);
  await open(app, lib.s2);
  assert.match(panel(app), /1\/4 watched/, 'the open list still counts');
  const s = memoryStorage(); s.setItem(userKeyOf('watchlist-episode-lists'), 'not json');
  const b = await boot({ storage: s, marks: l => [mark(l.s2, 9001, 1)] });
  assert.match(text(seasonRow(b.app, b.lib.s2)), /In progress · 1 marked/);
});

// ── The list ──
test('the list: fetched from TMDB on opening, one season at a time; titles hidden until asked; the summary counts listed marks only; air-date notes', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 7777, 9)] });
  await open(app, lib.s2);
  assert.ok(app.requests.some(r => r.url.endsWith('/tv/95396/season/2')));
  const p = panel(app);
  assert.match(p, /1\/4 watched · 1 not aired yet · 1 without an air date/);
  assert.match(p, /Episode 1 .*Episode 2 .*Episode 3 .*Episode 4/);
  assert.doesNotMatch(p, /Title 1/, 'titles are hidden until asked');
  assert.match(p, /Marks for episodes TMDB no longer lists \(kept; not counted\): Episode 9 \(no longer listed\)/);
  app.ctx.toggleEpisodeTitle(lib.s2.id, 9002);
  assert.match(panel(app), /Episode 2: Title 2/);
  assert.doesNotMatch(panel(app), /Title 1/);
  await open(app, lib.s3);
  assert.strictEqual((html(app).match(/ep-panel-row/g) || []).length, 1, 'one list open at a time');
  assert.deepStrictEqual(app.writes(), [], 'opening and reading write nothing');
});

test('the list: a TMDB failure shows Retry and the saved count; an empty list offers no suggestion; nothing is written', async () => {
  const { app, lib } = await boot({ episodes: { 2: [] }, marks: l => [mark(l.s3, 1, 1)] });
  await open(app, lib.s3);
  assert.match(panel(app), /Couldn’t load the episode list \(TMDB has no episode list for this season\)\. 1 episode is marked\. Retry/);
  assert.doesNotMatch(panel(app), /Mark Season 3 watched/);
  await open(app, lib.s2);
  assert.match(panel(app), /TMDB lists no episodes for this season/);
  assert.doesNotMatch(panel(app), /Every listed episode|Mark Season 2 watched/);
  assert.deepStrictEqual(app.writes(), []);
});

// ── Changes ──
test('a mark: one guarded call (the season’s watched / skipped as expected); the stored marks come back; clearing one leaves the others', async () => {
  const { app, lib } = await boot();
  await open(app, lib.s2);
  await app.ctx.setEpisodeMark(lib.s2.id, 9002, true); await settle();
  const [call] = rpcs(app, 'library_set_episode_marks');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(call.body)), { p_season_id: lib.s2.id, p_expected: { watched: false, skipped: false }, p_watched: true,
    p_episodes: [{ tmdb_episode_id: 9002, episode_number: 2 }] });
  assert.deepStrictEqual(marksIn(app, lib.s2), [9002]);
  assert.match(panel(app), /1\/4 watched/);
  assert.match(text(seasonRow(app, lib.s2)), /In progress · 1\/4 watched/);
  await app.ctx.setEpisodeMark(lib.s2.id, 9001, true); await settle();
  await app.ctx.setEpisodeMark(lib.s2.id, 9002, false); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rpcs(app, 'library_set_episode_marks')[2].body.p_episodes)), [{ tmdb_episode_id: 9002 }]);
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001]);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s2.id).watched, false, 'a mark never changes the season');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === lib.sev.id).status, 'watching', 'nor the show');
  assert.deepStrictEqual(writes(app).filter(w => !w.endsWith('library_set_episode_marks')), []);
});

test('Mark through: every listed episode up to it that isn’t marked, in one call; never clears one', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s2, 9002, 2)] });
  await open(app, lib.s2);
  await app.ctx.markEpisodesThrough(lib.s2.id, 9003); await settle();
  const calls = rpcs(app, 'library_set_episode_marks');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0].body.p_episodes)), [{ tmdb_episode_id: 9001, episode_number: 1 }, { tmdb_episode_id: 9003, episode_number: 3 }]);
  assert.strictEqual(calls[0].body.p_watched, true);
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002, 9003]);
  await app.ctx.markEpisodesThrough(lib.s2.id, 9002); await settle();
  assert.strictEqual(rpcs(app, 'library_set_episode_marks').length, 1, 'nothing left to mark: nothing sent');
});

test('the suggestion: only with a loaded, non-empty list and every listed episode checked; never automatic; it is the normal Watched action; marks kept and locked afterwards', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9002, 2), mark(l.s2, 9003, 3)] });
  await open(app, lib.s2);
  assert.doesNotMatch(panel(app), /Every listed episode/, 'three of four: no suggestion');
  await app.ctx.setEpisodeMark(lib.s2.id, 9004, true); await settle();
  assert.match(panel(app), /Every listed episode is checked\. TMDB lists 4 episodes; 1 hasn’t aired yet and 1 has no air date\. Mark Season 2 watched/);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s2.id).watched, false, 'nothing completes the season by itself');
  assert.deepStrictEqual(writes(app), ['POST rpc/library_set_episode_marks']);
  await app.ctx.toggleWatch(lib.s2.id); await settle(); // the suggestion's button
  assert.deepStrictEqual(writes(app), ['POST rpc/library_set_episode_marks', 'POST rpc/set_season_watched']);
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002, 9003, 9004], 'marking the season kept every mark');
  const p = panel(app);
  assert.match(p, /This season is marked watched, so its episodes are locked; unmark it to change them\. Its marks are kept\./);
  assert.match(p, /4\/4 watched/, 'its recorded progress is still shown');
  assert.doesNotMatch(p, /Through here|Every listed episode/);
  assert.ok((html(app).match(/<input type="checkbox" checked disabled/g) || []).length === 4, 'locked');
  await app.ctx.setEpisodeMark(lib.s2.id, 9001, false); await settle();
  assert.strictEqual(rpcs(app, 'library_set_episode_marks').length, 1, 'a locked season sends nothing');
  await app.ctx.toggleWatch(lib.s2.id); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002, 9003, 9004], 'unmarking kept them too');
  assert.match(panel(app), /4\/4 watched/);
  assert.match(panel(app), /Every listed episode is checked/, 'unlocked again; still only a suggestion');
});

test('a watched season without marks: "Watched (no episode detail)", no list and no fabricated marks; a skipped season is locked with its marks', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s3, 1, 1)] });
  await open(app, lib.s1);
  assert.match(panel(app), /^\s*Watched \(no episode detail\)\s*$/);
  await app.ctx.setSeasonSkipped(lib.s3.id, true); await settle();
  await open(app, lib.s3);
  assert.match(panel(app), /This season is skipped, so its episodes are locked; keep it to change them\. Its marks are kept\./);
  await app.ctx.markEpisodesThrough(lib.s3.id, 1); await settle();
  assert.deepStrictEqual(rpcs(app, 'library_set_episode_marks'), []);
  assert.deepStrictEqual(app.store.episode_marks.map(m => m.season_id), [lib.s3.id]);
});

test('a refusal puts back what was shown and says nothing was changed; no clear answer is never resent and the view is read again', async () => {
  const { app, lib } = await boot();
  await open(app, lib.s2);
  app.refuseNext(r => r.url.endsWith('/rpc/library_set_episode_marks'), 'P0001', 'season_locked: This season is marked watched or skipped, so its episodes can\'t be changed. Change that first. Nothing was changed.');
  await app.ctx.setEpisodeMark(lib.s2.id, 9001, true); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), []);
  assert.match(banners(app), /Nothing was changed/);
  assert.doesNotMatch(panel(app), /1\/4/, 'the mark shown was put back');
  app.loseNext(r => r.url.endsWith('/rpc/library_set_episode_marks'), 'after');
  const before = app.requests.length;
  await app.ctx.setEpisodeMark(lib.s2.id, 9002, true); await settle();
  assert.strictEqual(rpcs(app, 'library_set_episode_marks').length, 2, 'sent once, never again');
  assert.match(banners(app), /wasn’t confirmed[\s\S]*won’t be sent again/);
  assert.ok(app.requests.slice(before).some(r => /\/rest\/v1\/episode_marks\?/.test(r.url)), 'the view (and its marks) were read again');
  assert.match(panel(app), /1\/4 watched/, 'it shows what is stored (the lost answer had been applied)');
});

test('one change at a time: while a mark is being saved, another change is refused before it is shown or sent', async () => {
  const { app, lib } = await boot();
  await open(app, lib.s2);
  const g = app.hold(r => r.url.endsWith('/rpc/library_set_episode_marks'));
  const first = app.ctx.setEpisodeMark(lib.s2.id, 9001, true);
  await g.reached;
  await app.ctx.setEpisodeMark(lib.s2.id, 9002, true);
  await app.ctx.toggleWatch(lib.s3.id);
  g.release(); await first; await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/library_set_episode_marks']);
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001]);
});

// ── Delete ──
test('delete: the dialog names the marks; the count shown goes with the request; the season and its marks go together; a stale count is refused', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s3, 1, 1), mark(l.s3, 2, 2)] });
  await app.ctx.delRowInView(lib.s3.id); await settle();
  assert.match(app.dialogs[0].text, /Its 2 episode marks are deleted with it\./);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rpcs(app, 'delete_tv_season')[0].body)), { p_row_id: lib.s3.id, p_marks_expected: 2 });
  assert.ok(!app.store.watchlist_items.some(r => r.id === lib.s3.id));
  assert.deepStrictEqual(app.store.episode_marks, []);
  // Stale: a mark added elsewhere after this page read the list.
  const b = await boot();
  b.app.store.episode_marks.push(mark(b.lib.s2, 9001, 1));
  await b.app.ctx.delRowInView(b.lib.s2.id); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rpcs(b.app, 'delete_tv_season')[0].body)), { p_row_id: b.lib.s2.id, p_marks_expected: 0 });
  assert.ok(b.app.store.watchlist_items.some(r => r.id === b.lib.s2.id), 'not deleted');
  assert.match(banners(b.app), /Couldn’t delete[\s\S]*Nothing was changed/);
});

// ── Backup and restore ──
test('backup: format 6 with every mark (id, season, TMDB episode, number; never user_id); a round trip restores them; the preview warns when the file has fewer', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s2, 9001, 1), mark(l.s3, 5, 1)] });
  const b = JSON.parse(JSON.stringify(await app.ctx.buildBackupObject()));
  assert.strictEqual(b.formatVersion, 6);
  assert.deepStrictEqual(b.tables.episode_marks.map(r => Object.keys(r)), [['id', 'season_id', 'tmdb_episode_id', 'episode_number'], ['id', 'season_id', 'tmdb_episode_id', 'episode_number']]);
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(b)), []);
  const bad = JSON.parse(JSON.stringify(b)); bad.tables.episode_marks[0].season_id = lib.l1.id;
  assert.match(Array.from(app.ctx.validateBackupObject(bad)).join(' '), /points at a season that isn't matched to TMDB/);
  const dup = JSON.parse(JSON.stringify(b)); dup.tables.episode_marks.push({ ...dup.tables.episode_marks[0], id: uuid('0f000000') }); dup.rowCounts.episode_marks++;
  assert.match(Array.from(app.ctx.validateBackupObject(dup)).join(' '), /episode_marks duplicate episode of a season/);
  // A file with one mark fewer, restored: the preview says so; afterwards the library equals the file.
  const fewer = JSON.parse(JSON.stringify(b)); fewer.tables.episode_marks.pop(); fewer.rowCounts.episode_marks = 1;
  app.ctx.openSettings(null);
  const textOf = JSON.stringify(fewer);
  await app.ctx.handleRestoreFileSelected({ target: { files: [{ text: async () => textOf }], value: 'x' } }); await settle();
  assert.match(text(app.el('restoreModalBox').innerHTML), /Your library has 2 episode marks now; this backup has 1\. Restoring replaces them with the backup’s\. The safety backup keeps the current ones\./);
  await app.ctx.executeRestore(); await settle();
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  assert.deepStrictEqual(app.store.episode_marks.map(m => m.tmdb_episode_id), [9001]);
});

test('restore: a format-5 file is converted to format 6 with no marks (its own conversion record), previewed, and the marks it removes are named', async () => {
  const { app } = await boot({ marks: l => [mark(l.s2, 9001, 1)] });
  const b6 = JSON.parse(JSON.stringify(await app.ctx.buildBackupObject()));
  const b5 = { ...b6, formatVersion: 5, tables: { ...b6.tables }, rowCounts: { ...b6.rowCounts } };
  delete b5.tables.episode_marks; delete b5.rowCounts.episode_marks;
  app.ctx.openSettings(null);
  const textOf = JSON.stringify(b5);
  await app.ctx.handleRestoreFileSelected({ target: { files: [{ text: async () => textOf }], value: 'x' } }); await settle();
  const doc = JSON.parse(JSON.stringify(app.get('pendingRestoreData')));
  assert.strictEqual(doc.formatVersion, 6);
  assert.deepStrictEqual(doc.tables.episode_marks, []);
  assert.deepStrictEqual(Object.keys(doc.conversion).sort(), ['converter_version', 'source_exported_at', 'source_format', 'source_sha256']);
  assert.strictEqual(doc.conversion.source_format, 5);
  assert.strictEqual(doc.conversion.converter_version, 'ep1.1');
  const m = text(app.el('restoreModalBox').innerHTML);
  assert.match(m, /This backup is converted to format 6 before restoring/);
  assert.match(m, /Your library has 1 episode mark now; this backup has 0\./);
  await app.ctx.executeRestore(); await settle();
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  assert.strictEqual(rpcs(app, 'restore_backup')[0].body.p_backup.formatVersion, 6, 'only the converted document is sent');
  assert.deepStrictEqual(app.store.episode_marks, []);
});

// ── Collections and the phone ──
test('a collection’s show entry has the same progress, list and marks; the phone card has them too', async () => {
  const lib = library();
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows, tmdb: tmdb(), storage: memoryStorage(), episodeMarks: [mark(lib.s2, 9001, 1)],
    personalCollections: [{ id: '0c000000-0000-4000-8000-000000000001', name: 'Mine', legacy_source: null, sort_order: 1, archived_at: null, created_at: TS }],
    memberships: [{ id: '0d000000-0000-4000-8000-000000000001', collection_id: '0c000000-0000-4000-8000-000000000001', show_id: lib.sev.id, item_id: null, created_at: TS }] });
  app.ctx.openBrowseCollection('browse:0c000000-0000-4000-8000-000000000001'); await settle();
  app.ctx.toggleBrowseShow(lib.sev.id); await settle();
  assert.match(text(seasonRow(app, lib.s2)), /In progress · 1 marked/);
  await open(app, lib.s2);
  assert.match(panel(app), /1\/4 watched/);
  await app.ctx.setEpisodeMark(lib.s2.id, 9002, true); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002]);
  const c = card(app);
  assert.ok(c.includes(`toggleEpisodes('${lib.s2.id}')`) && /ep-panel-card/.test(c) && c.includes(`setEpisodeMark('${lib.s2.id}', 9003, this.checked)`), 'the card carries the toggle and the list');
});

// ── A page from before EP1 ──
function exportRelease() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-release-'));
  execSync(`git -C "${ROOT}" archive ${RELEASE_BEFORE_EP1} | tar -x -C "${dir}"`);
  return dir;
}
test('a page from before EP1 on the migrated database: backup and restore refused (the phase is read again); ordinary writes continue; deleting a marked season is refused by the database, never reported as deleted', async () => {
  const dir = exportRelease();
  try {
    const lib = library();
    const app = await createApp({ rows: lib.rows, tvShows: lib.shows, stage5: 'contracted-b45', pageRoot: dir });
    app.ctx.switchView('alltv'); await settle();
    assert.ok(!app.get('typeof toggleEpisodes === "function"'), 'the released page has no episode code');
    app.migrateEp1(); // db/ep1_episode_marks.sql commits under the open page
    app.store.episode_marks.push(mark(lib.s3, 1, 1)); // a mark made from an updated page elsewhere
    const res = await app.ctx.buildBackupObject().then(() => 'made', e => e.message);
    assert.match(res, /makes backups only of a database in its own state \(format 5\), and this database isn’t in it, so no file was made/);
    app.ctx.openSettings(null);
    app.ctx.__b = { formatVersion: 5 };
    await app.run('pendingRestoreData = __b; renderRestorePreview(__b)'); await settle();
    assert.match(app.el('restoreModalBox').innerHTML, /Restore isn't available/);
    app.ctx.closeRestoreModal();
    app.ctx.switchView('alltv'); await settle();
    app.ctx.toggleDerivedShow(lib.sev.id); await settle();
    // Ordinary writes continue (they don't touch marks).
    await app.ctx.toggleWatch(lib.s2.id); await settle();
    assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s2.id).watched, true);
    // Its delete of the marked season: refused (update_required), the row put back, the marks kept.
    await app.ctx.delRowInView(lib.s3.id); await settle();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rpcs(app, 'delete_tv_season')[0].body)), { p_row_id: lib.s3.id }, 'the released page sends no count');
    assert.ok(app.store.watchlist_items.some(r => r.id === lib.s3.id), 'not deleted');
    assert.deepStrictEqual(app.store.episode_marks.map(m => m.season_id), [lib.s3.id], 'its mark kept');
    assert.match(banners(app), /Couldn’t delete[\s\S]*episode mark[\s\S]*Reload the page[\s\S]*Nothing was changed/);
    assert.ok(html(app).includes(`data-season-row="${lib.s3.id}"`), 'the row is listed again');
    // A season without marks is still deleted as before.
    await app.ctx.delRowInView(lib.l1.id); await settle();
    assert.ok(!app.store.watchlist_items.some(r => r.id === lib.l1.id));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('this page on a database before EP1 (the marks table missing): the page and the database don’t match; nothing is written', async () => {
  const lib = library();
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows, stage5: 'contracted-b45' });
  app.ctx.switchView('alltv'); await settle();
  assert.match(html(app) + banners(app), /This page and the database don’t match/);
  await app.ctx.toggleWatch(lib.s2.id); await settle();
  const res = await app.ctx.buildBackupObject().then(() => 'made', e => e.message);
  assert.notStrictEqual(res, 'made');
  assert.deepStrictEqual(app.writes(), []);
});

T.run();
