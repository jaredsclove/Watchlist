// Offline tests for episode progress within seasons (EP1, db/ep1_episode_marks.sql), in the whole-page
// harness: the collapsed "N/T watched" with its per-device cache and fallbacks; the inline episode list
// (fetched from TMDB, titles hidden until asked unless Settings' "Show episode titles by default" is on,
// EP2); marks set and cleared one change at a time through library_set_episode_marks (refusals put back
// what was shown; no answer is never resent); the one "Mark watched through" control (EP2);
// the explicit Mark season watched suggestion (never automatic); watched and skipped seasons locked, their
// marks kept; unmatched seasons untouched; the guarded delete; backup formats 6 and 7 and their restore; the same
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
const { makeMiniDom } = require('./mini-dom');

const T = runner('episodes');
const test = T.test;
const ROOT = path.join(__dirname, '..');
// The page as released before EP1 (M1, PR #7): its application files, read from git.
const RELEASE_BEFORE_EP1 = '502570a';

const TS = '2026-10-01T00:00:00+00:00';
let n = 0;
const uuid = p => `${p}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
// Severance is To Watch unless asked (status), so its seasons' own rows keep their episode progress; a Watching show's
// up-next season is represented by the show row instead (EP5).
function library(status = 'confirmed') {
  const sev = { id: uuid('5a000000'), collection: 'othertv', title: 'Severance', show_key: 'severance', tmdb_id: 95396, status, created_at: TS };
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
test('collapsed: no marks, no text; marks without a cached list → "N episodes marked"; Episodes only on matched seasons', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9002, 2)] });
  assert.ok(!/ep-progress/.test(seasonRow(app, lib.s3)), 'no marks: nothing');
  assert.match(text(seasonRow(app, lib.s2)), /2 episodes marked/);
  assert.ok(seasonRow(app, lib.s2).includes(`toggleEpisodes('${lib.s2.id}')`));
  app.ctx.toggleDerivedShow(lib.loc.id); await settle();
  assert.ok(!seasonRow(app, lib.l1).includes('toggleEpisodes'), 'an unmatched season has no episode list');
  assert.match(seasonRow(app, lib.l1), /Mark S1 watched|Not aired/, 'its season-level controls are unchanged');
});

test('collapsed: against the cached list "N/T watched" counts only listed marks, unlisted ones apart; a count alone only while N < T; watched without "In progress"; skipped shows none', async () => {
  const storage = memoryStorage();
  const { app, lib } = await boot({ storage, marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 7777, 9), mark(l.s1, 8001, 1)] });
  await open(app, lib.s2); // the list is cached on this device (its ids)
  app.ctx.toggleEpisodes(lib.s2.id); await settle(); // closed again
  assert.match(text(seasonRow(app, lib.s2)), /· 1\/4 episodes watched · 1 not listed/);
  const cacheKey = userKeyOf('watchlist-episode-lists');
  assert.deepStrictEqual(JSON.parse(storage.getItem(cacheKey))['95396:2'], { ids: [9001, 9002, 9003, 9004], numbers: [1, 2, 3, 4],
    names: ['Title 1', 'Title 2', 'Title 3', 'Title 4'], last: { type: null, air: null } }, 'with each episode’s number and title (the next-unwatched line), and the last episode’s type and air date');
  // A count only (Refresh shows / Add season): N/T while the marks are fewer; never a complete-looking T/T.
  storage.setItem(cacheKey, JSON.stringify({ '95396:2': { count: 4 }, '95396:1': { count: 1 } }));
  app.ctx.renderTable();
  assert.match(text(seasonRow(app, lib.s2)), /· 2\/4 episodes watched/);
  assert.match(text(seasonRow(app, lib.s1)), /1 episode marked/, 'marks not fewer than the count: no total');
  assert.doesNotMatch(text(seasonRow(app, lib.s1)), /In progress|1\/1/, 'a watched season isn’t in progress');
  storage.setItem(cacheKey, '{"95396:2":{"ids":[9001,9002]}}');
  app.ctx.renderTable();
  assert.match(text(seasonRow(app, lib.s2)), /1\/2 episodes watched · 1 not listed/, 'a stale list is shown as it is (accepted)');
  await app.ctx.setSeasonSkipped(lib.s2.id, true); await settle();
  assert.ok(!/ep-progress/.test(seasonRow(app, lib.s2)), 'skipped: no progress shown');
  assert.deepStrictEqual(marksIn(app, lib.s2), [7777, 9001], 'skipping kept the marks');
});

test('collapsed: unreadable storage leaves "N marked"; a corrupt cache is ignored', async () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  const { app, lib } = await boot({ storage: broken, marks: l => [mark(l.s2, 9001, 1)] });
  assert.match(text(seasonRow(app, lib.s2)), /1 episode marked/);
  await open(app, lib.s2);
  assert.match(panel(app), /1\/4 watched/, 'the open list still counts');
  const s = memoryStorage(); s.setItem(userKeyOf('watchlist-episode-lists'), 'not json');
  const b = await boot({ storage: s, marks: l => [mark(l.s2, 9001, 1)] });
  assert.match(text(seasonRow(b.app, b.lib.s2)), /1 episode marked/);
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
  assert.strictEqual((html(app).match(/>Show title</g) || []).length, 4, 'one Show title button per listed episode');
  assert.ok(html(app).includes('aria-label="Show title of episode 2"'), 'each button names its episode');
  assert.match(p, /Marks for episodes TMDB no longer lists \(kept; not counted\): Episode 9 \(no longer listed\)/);
  app.ctx.toggleEpisodeTitle(lib.s2.id, 9002);
  assert.match(panel(app), /Episode 2: Title 2/);
  assert.doesNotMatch(panel(app), /Title 1/);
  assert.ok(html(app).includes('aria-label="Hide title of episode 2"') && />Hide title</.test(html(app)));
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
  assert.match(text(seasonRow(app, lib.s2)), /· 1\/4 episodes watched/);
  await app.ctx.setEpisodeMark(lib.s2.id, 9001, true); await settle();
  await app.ctx.setEpisodeMark(lib.s2.id, 9002, false); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rpcs(app, 'library_set_episode_marks')[2].body.p_episodes)), [{ tmdb_episode_id: 9002 }]);
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001]);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s2.id).watched, false, 'a mark never changes the season');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === lib.sev.id).status, 'confirmed', 'nor the show');
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

// ── Episode titles by default (EP2) ──
const titlesKey = () => userKeyOf('watchlist_episode_titles');
test('titles by default: off unless chosen; on shows every title with no reveal buttons; blank titles never get one; per account in this browser', async () => {
  const eps = { 2: [E(9001, 1), E(9002, 2, { name: '   ' }), E(9003, 3, { name: '' }), E(9004, 4, { name: null })] };
  const storage = memoryStorage();
  const { app, lib } = await boot({ storage, episodes: eps });
  await open(app, lib.s2);
  assert.match(panel(app), /Episode 1 Show title Episode 2 Episode 3 Episode 4/, 'off by default: numbers, and Show title only where there is a title');
  app.ctx.switchView('settings'); await settle();
  const box = app.el('settingsScreen').innerHTML;
  assert.match(text(box), /Show episode titles by default/);
  assert.match(text(box), /Saved for this account in this browser on this device only/);
  assert.ok(!/settings-episode-titles" checked/.test(box), 'unchecked');
  app.ctx.setEpisodeTitlesShown(true);
  assert.strictEqual(storage.getItem(titlesKey()), 'on', 'saved under this account');
  assert.strictEqual(app.el('settingsEpisodeTitlesNote').textContent, '', 'saved: no warning');
  app.ctx.switchView('alltv'); await settle();
  app.ctx.toggleDerivedShow(lib.sev.id); await settle();
  if (!/ep-panel-row/.test(html(app))) await open(app, lib.s2);
  assert.match(panel(app), /Episode 1: Title 1 Episode 2 Episode 3 Episode 4/);
  assert.doesNotMatch(html(app), /Show title|Hide title/, 'no reveal buttons while titles are shown by default');
  // A new page for the same account reads it back; another account doesn't share it.
  const again = await boot({ storage, episodes: eps });
  await open(again.app, again.lib.s2);
  assert.match(panel(again.app), /Episode 1: Title 1/);
  assert.ok(titlesKey().endsWith('::' + again.app.get('pageUser.id')), 'the key is the account’s');
  storage.setItem(titlesKey(), 'off');
  const off = await boot({ storage, episodes: eps });
  await open(off.app, off.lib.s2);
  assert.doesNotMatch(panel(off.app), /Title 1/);
  assert.deepStrictEqual(app.writes().concat(off.app.writes()), [], 'a display choice writes nothing to the database');
});

test('titles by default: storage that can’t be read is off; a choice that can’t be saved holds for this page across redraws and says so', async () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  const { app, lib } = await boot({ storage: broken });
  await open(app, lib.s2);
  assert.doesNotMatch(panel(app), /Title 1/, 'unreadable: off');
  app.ctx.toggleEpisodeTitle(lib.s2.id, 9001);
  assert.match(panel(app), /Episode 1: Title 1/);
  app.ctx.switchView('settings'); await settle();
  app.ctx.setEpisodeTitlesShown(true);
  assert.match(app.el('settingsEpisodeTitlesNote').textContent, /couldn’t save the choice, so it applies only until this page is closed or reloaded/);
  app.ctx.renderSettings();
  assert.ok(/settings-episode-titles" checked/.test(app.el('settingsScreen').innerHTML), 'the redrawn Settings shows the page’s choice');
  assert.match(text(app.el('settingsScreen').innerHTML), /couldn’t save the choice/);
  app.ctx.switchView('alltv'); await settle();
  if (!/data-season-row="[^"]*"[^>]*>[\s\S]*Season 2/.test(html(app))) { app.ctx.toggleDerivedShow(lib.sev.id); await settle(); }
  if (!/ep-panel-row/.test(html(app))) await open(app, lib.s2);
  assert.match(panel(app), /Episode 1: Title 1 .*Episode 2: Title 2/, 'on for this page');
  app.ctx.switchView('settings'); await settle();
  app.ctx.setEpisodeTitlesShown(false);
  app.ctx.switchView('alltv'); await settle();
  if (!/ep-panel-row/.test(html(app))) await open(app, lib.s2);
  assert.doesNotMatch(panel(app), /Title 1/, 'off again, and the title revealed earlier is hidden again');
});

// ── Mark watched through (EP2) ──
const throughSelect = app => (html(app).match(/<select class="ep-through-select"[\s\S]*?<\/select>/) || [''])[0];
const selectedEpisode = app => ((throughSelect(app).match(/<option value="(\d+)" selected>/) || [])[1] || null);
test('Mark watched through: one control above the list (no per-episode buttons); starts on the first unmarked episode, else the last', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9003, 3)] });
  await open(app, lib.s2);
  const p = panel(app);
  assert.match(p, /Mark watched through Episode 1 Episode 2 Episode 3 Episode 4 Apply Episode 1/, 'one control, above the list');
  assert.doesNotMatch(p, /Through here/);
  assert.strictEqual((html(app).match(/ep-through-apply/g) || []).length, 2, 'one Apply (its class and its focus hook)');
  assert.strictEqual(selectedEpisode(app), '9002');
  assert.ok(/<label class="ep-bulk-label">Mark watched through <span class="season-action" data-action="ep-through-select"><select/.test(html(app)), 'the label names the selector');
  assert.ok(!/<select[^>]* id=/.test(throughSelect(app)), 'no ids (both layouts are on the page)');
  const all = await boot({ marks: l => [9001, 9002, 9003, 9004].map((id, i) => mark(l.s2, id, i + 1)) });
  await open(all.app, all.lib.s2);
  assert.strictEqual(selectedEpisode(all.app), '9004', 'all marked: the last');
});

test('Mark watched through: Apply marks only the unmarked episodes through the chosen one in one call, keeps later marks and the choice; again is a no-op that sends nothing', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s2, 9002, 2), mark(l.s2, 9004, 4)] });
  await open(app, lib.s2);
  app.ctx.chooseEpisodesThrough(lib.s2.id, '9003');
  app.ctx.renderTable();
  assert.strictEqual(selectedEpisode(app), '9003', 'a redraw keeps the choice');
  await app.ctx.applyEpisodesThrough(lib.s2.id); await settle();
  const calls = rpcs(app, 'library_set_episode_marks');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0].body)), { p_season_id: lib.s2.id, p_expected: { watched: false, skipped: false }, p_watched: true,
    p_episodes: [{ tmdb_episode_id: 9001, episode_number: 1 }, { tmdb_episode_id: 9003, episode_number: 3 }] });
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002, 9003, 9004], 'the later mark is kept');
  assert.strictEqual(selectedEpisode(app), '9003', 'the choice stays after success');
  await app.ctx.applyEpisodesThrough(lib.s2.id); await settle();
  assert.strictEqual(rpcs(app, 'library_set_episode_marks').length, 1, 'again: nothing sent');
  assert.match(panel(app), /Already marked through episode 3\./);
  app.ctx.chooseEpisodesThrough(lib.s2.id, '9001');
  assert.doesNotMatch(panel(app), /Already marked/, 'a new choice clears the note');
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s2.id).watched, false, 'nothing completes the season');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === lib.sev.id).status, 'confirmed', 'the show is unchanged');
  assert.match(panel(app), /Every listed episode is checked/, 'only the explicit suggestion');
  assert.deepStrictEqual(writes(app), ['POST rpc/library_set_episode_marks']);
});

test('Mark watched through: the default choice stays put after Apply; a refusal puts back what was shown and keeps the choice; locked seasons have no control and send nothing', async () => {
  const { app, lib } = await boot();
  await open(app, lib.s2);
  assert.strictEqual(selectedEpisode(app), '9001');
  await app.ctx.applyEpisodesThrough(lib.s2.id); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001]);
  assert.strictEqual(selectedEpisode(app), '9001', 'kept, not moved to the next unmarked');
  app.ctx.chooseEpisodesThrough(lib.s2.id, '9003');
  app.refuseNext(r => r.url.endsWith('/rpc/library_set_episode_marks'), 'P0001', 'season_locked: This season is marked watched or skipped, so its episodes can\'t be changed. Change that first. Nothing was changed.');
  await app.ctx.applyEpisodesThrough(lib.s2.id); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001]);
  assert.match(panel(app), /1\/4 watched/, 'what was shown is put back');
  assert.match(banners(app), /Nothing was changed/);
  assert.strictEqual(selectedEpisode(app), '9003', 'the choice stays after a refusal');
  await app.ctx.setSeasonSkipped(lib.s2.id, true); await settle();
  if (!/ep-panel-row/.test(html(app))) await open(app, lib.s2);
  assert.doesNotMatch(panel(app), /Mark watched through/, 'skipped: no control');
  const before = rpcs(app, 'library_set_episode_marks').length;
  await app.ctx.applyEpisodesThrough(lib.s2.id); await settle();
  assert.strictEqual(rpcs(app, 'library_set_episode_marks').length, before, 'a locked season sends nothing');
  await open(app, lib.s1);
  assert.doesNotMatch(panel(app), /Mark watched through/, 'watched: no control');
});

test('Mark watched through: focus stays on Apply through the change and its redraws, in the table and the phone card; a change already in progress refuses a second Apply', async () => {
  for (const layout of ['tbody', 'cardList']) {
    const { app, lib } = await boot();
    await open(app, lib.s2);
    const dom = makeMiniDom(app);
    dom.hide(layout === 'tbody' ? 'cardList' : 'tbody');
    const sel = `[data-season-row="${lib.s2.id}"] [data-action="ep-through-apply"] button`;
    app.ctx.chooseEpisodesThrough(lib.s2.id, '9002');
    dom.focus(layout, sel);
    const held = app.hold(r => r.url.endsWith('/rpc/library_set_episode_marks'));
    const p = app.ctx.applyEpisodesThrough(lib.s2.id);
    await held.reached;
    assert.strictEqual(dom.active(), dom.in(layout, sel), `${layout}: on Apply while it is saved`);
    await app.ctx.applyEpisodesThrough(lib.s2.id); // a second press while the first is saved
    held.release(); await p; await settle();
    assert.strictEqual(rpcs(app, 'library_set_episode_marks').length, 1, `${layout}: the second press sent nothing`);
    assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002]);
    assert.strictEqual(dom.active(), dom.in(layout, sel), `${layout}: on Apply after the change and its reread`);
    await app.ctx.applyEpisodesThrough(lib.s2.id); await settle();
    assert.strictEqual(dom.active(), dom.in(layout, sel), `${layout}: on Apply after a no-op`);
    assert.strictEqual(rpcs(app, 'library_set_episode_marks').length, 1);
  }
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
  assert.doesNotMatch(p, /Mark watched through|Every listed episode/);
  assert.ok((html(app).match(/<input type="checkbox" checked disabled/g) || []).length === 4, 'locked');
  await app.ctx.setEpisodeMark(lib.s2.id, 9001, false); await settle();
  assert.strictEqual(rpcs(app, 'library_set_episode_marks').length, 1, 'a locked season sends nothing');
  await app.ctx.toggleWatch(lib.s2.id); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002, 9003, 9004], 'unmarking kept them too');
  assert.match(panel(app), /4\/4 watched/);
  assert.match(panel(app), /Every listed episode is checked/, 'unlocked again; still only a suggestion');
});

test('a watched season without marks: its list for reference, no checkboxes, no fabricated marks; a skipped season is locked with its marks', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s3, 1, 1)] });
  await open(app, lib.s1);
  assert.match(panel(app), /This season is marked watched\. No episode progress is recorded for it, so this list is for reference\./);
  assert.match(panel(app), /2 episodes listed/);
  assert.match(panel(app), /Episode 1 .*Episode 2/);
  assert.ok(!/0\/2 watched/.test(panel(app)), 'no progress count for a season with no recorded progress');
  assert.ok(!/type="checkbox"/.test(html(app).match(/<tr class="sub-row ep-panel-row"[\s\S]*?<\/tr>/)[0]), 'no checkbox: nothing suggests an episode is unwatched');
  assert.ok(!/Title 1/.test(panel(app)), 'titles stay hidden by default');
  app.ctx.toggleEpisodeTitle(lib.s1.id, 8001); await settle();
  assert.match(panel(app), /Episode 1: Title 1/, 'the title preference and Show title work as elsewhere');
  assert.deepStrictEqual(app.writes().map(r => r.url).filter(u => /episode_marks/.test(u)), [], 'nothing is written');
  assert.deepStrictEqual(marksIn(app, lib.s1), []);
  await open(app, lib.s1);
  await app.ctx.setSeasonSkipped(lib.s3.id, true); await settle();
  app.ctx.toggleSkippedSeasons(lib.sev.id); await settle(); // skipped seasons are listed on request
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
test('backup: format 7 with every mark (id, season, TMDB episode, number; never user_id); a round trip restores them; the preview warns when the file has fewer', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s2, 9001, 1), mark(l.s3, 5, 1)] });
  const b = JSON.parse(JSON.stringify(await app.ctx.buildBackupObject()));
  assert.strictEqual(b.formatVersion, 7);
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

test('restore: a format-5 file is converted to format 7 with no marks, previewed, and the marks it removes are named', async () => {
  const { app } = await boot({ marks: l => [mark(l.s2, 9001, 1)] });
  const b7 = JSON.parse(JSON.stringify(await app.ctx.buildBackupObject()));
  const b5 = { ...b7, formatVersion: 5, tables: { ...b7.tables }, rowCounts: { ...b7.rowCounts } };
  for (const t of ['episode_marks', ...app.get('CU1_TABLES')]) { delete b5.tables[t]; delete b5.rowCounts[t]; }
  app.ctx.openSettings(null);
  const textOf = JSON.stringify(b5);
  await app.ctx.handleRestoreFileSelected({ target: { files: [{ text: async () => textOf }], value: 'x' } }); await settle();
  const doc = JSON.parse(JSON.stringify(app.get('pendingRestoreData')));
  assert.strictEqual(doc.formatVersion, 7);
  assert.deepStrictEqual(doc.tables.episode_marks, []);
  assert.ok(!('conversion' in doc));
  const m = text(app.el('restoreModalBox').innerHTML);
  assert.match(m, /This backup is converted to format 7 before restoring/);
  assert.match(m, /This backup also has no episode marks/);
  assert.match(m, /Your library has 1 episode mark now; this backup has 0\./);
  await app.ctx.executeRestore(); await settle();
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  assert.strictEqual(rpcs(app, 'restore_backup')[0].body.p_backup.formatVersion, 7, 'only the converted document is sent');
  assert.deepStrictEqual(app.store.episode_marks, []);
});

// ── Next unwatched ──
const nextIn = s => (s.match(/<span class="ep-next">([^<]*)<\/span>/) || [])[1] || '';
test('next unwatched: the first listed episode without a mark (gaps included), from the cached list after it closes; titles hidden by default', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9003, 3)] });
  assert.strictEqual(nextIn(seasonRow(app, lib.s2)), '', 'no list known yet: nothing, never a guess from the marks');
  await open(app, lib.s2);
  assert.strictEqual(nextIn(seasonRow(app, lib.s2)), 'Next unwatched: E2', 'the open list: E2, not E3 from the count of marks');
  app.ctx.toggleEpisodes(lib.s2.id); await settle();
  assert.match(text(seasonRow(app, lib.s2)), /· 2\/4 episodes watched ▸ Episodes Next unwatched: E2/, 'with Episodes on the progress line, then its own, from the cache once closed');
  assert.doesNotMatch(html(app) + card(app), /Title 2/, 'no title while titles are hidden by default');
  assert.match(card(app), /· 2\/4 episodes watched<\/span> <span class="season-action" data-action="episodes">[^]*?<\/span> <span class="ep-next-line"><span class="ep-next">Next unwatched: E2</, 'the phone card has the same order');
  await open(app, lib.s2); // a mark is set from the open list
  await app.ctx.setEpisodeMark(lib.s2.id, 9002, true); await settle();
  assert.strictEqual(nextIn(seasonRow(app, lib.s2)), 'Next unwatched: E4', 'marking E2 moves it past the marked E3');
  await app.ctx.setEpisodeMark(lib.s2.id, 9001, false); await settle();
  assert.strictEqual(nextIn(seasonRow(app, lib.s2)), 'Next unwatched: E1', 'clearing a mark brings it back');
  assert.ok(rpcs(app, 'library_set_episode_marks').length === 2 && app.writes().length === 2, 'the line itself writes nothing');
});

test('next unwatched: follows "Show episode titles by default" on return from Settings; a blank title shows the number only', async () => {
  const eps = { 2: [E(9001, 1), E(9002, 2), E(9003, 3, { name: '  ' })] };
  const storage = memoryStorage();
  const { app, lib } = await boot({ storage, episodes: eps, marks: l => [mark(l.s2, 9001, 1)] });
  await open(app, lib.s2); app.ctx.toggleEpisodes(lib.s2.id); await settle();
  assert.strictEqual(nextIn(seasonRow(app, lib.s2)), 'Next unwatched: E2');
  app.ctx.switchView('settings'); await settle();
  app.ctx.setEpisodeTitlesShown(true);
  app.ctx.switchView('alltv'); await settle();
  if (!seasonRow(app, lib.s2)) { app.ctx.toggleDerivedShow(lib.sev.id); await settle(); }
  assert.strictEqual(nextIn(seasonRow(app, lib.s2)), 'Next unwatched: E2 — Title 2');
  assert.ok(card(app).includes('Next unwatched: E2 — Title 2'));
  await open(app, lib.s2);
  await app.ctx.setEpisodeMark(lib.s2.id, 9002, true); await settle();
  assert.strictEqual(nextIn(seasonRow(app, lib.s2)), 'Next unwatched: E3', 'no title available: the number only');
  app.ctx.switchView('settings'); await settle();
  app.ctx.setEpisodeTitlesShown(false);
  app.ctx.switchView('alltv'); await settle();
  if (!seasonRow(app, lib.s2)) { app.ctx.toggleDerivedShow(lib.sev.id); await settle(); }
  if (!/ep-panel-row/.test(html(app))) await open(app, lib.s2);
  await app.ctx.setEpisodeMark(lib.s2.id, 9002, false); await settle();
  assert.strictEqual(nextIn(seasonRow(app, lib.s2)), 'Next unwatched: E2', 'off again: no title');
});

test('next unwatched: hidden for a list cached before it (ids only), a count only, an unreadable or malformed cache, an empty or fully marked list, a watched or skipped season', async () => {
  const storage = memoryStorage(), cacheKey = userKeyOf('watchlist-episode-lists');
  const { app, lib } = await boot({ storage, episodes: { 2: [E(9001, 1), E(9002, 2)], 1: [] }, marks: l => [mark(l.s2, 9001, 1), mark(l.s1, 8001, 1), mark(l.s3, 5, 1)] });
  const hidden = (cache, why) => { storage.setItem(cacheKey, JSON.stringify(cache)); app.ctx.renderTable(); assert.strictEqual(nextIn(html(app) + card(app)), '', why); };
  hidden({ '95396:2': { ids: [9001, 9002] } }, 'a list cached before the line: no numbers, nothing shown');
  hidden({ '95396:2': { count: 2 } }, 'a count only');
  hidden({ '95396:2': { ids: [9001, 9002], numbers: [1] } }, 'numbers that don’t line up');
  hidden({ '95396:2': { ids: [9001, 9002], numbers: [1, 'x'] } }, 'a number that isn’t one');
  hidden({ '95396:2': { ids: [9001], numbers: [1], names: ['Title 1'] } }, 'every listed episode marked (a kept, unlisted mark doesn’t count)');
  hidden({ '95396:3': { ids: [], numbers: [], names: [] } }, 'an empty list');
  hidden({ '95396:1': { ids: [8001, 8002], numbers: [1, 2], names: ['A', 'B'] } }, 'a watched season');
  storage.setItem(cacheKey, JSON.stringify({ '95396:2': { ids: [9001, 9002], numbers: [1, 2] } })); app.ctx.renderTable();
  assert.strictEqual(nextIn(seasonRow(app, lib.s2)), 'Next unwatched: E2', 'names missing: the number only');
  await app.ctx.setSeasonSkipped(lib.s2.id, true); await settle();
  assert.strictEqual(nextIn(html(app) + card(app)), '', 'a skipped season');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  const b = await boot({ storage: broken, marks: l => [mark(l.s2, 9001, 1)] });
  assert.strictEqual(nextIn(seasonRow(b.app, b.lib.s2)), '', 'unreadable storage: nothing');
  await open(b.app, b.lib.s2);
  assert.strictEqual(nextIn(seasonRow(b.app, b.lib.s2)), 'Next unwatched: E2', 'the open list in page memory still gives it');
});

// ── The show row's target (EP5) ──
// A Watching show (Severance: Season 1 watched; Seasons 2 and 3 aired): the row stands for its up-next season.
async function bootRow(o = {}) {
  const lib = library('watching');
  if (o.edit) o.edit(lib);
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows, tmdb: tmdb(o.episodes), storage: o.storage || memoryStorage(), episodeMarks: (o.marks || (() => []))(lib), width: o.width || 1200, ...(o.extra || {}) });
  app.ctx.switchView(o.view || 'alltv'); await settle();
  return { app, lib };
}
const showRowOf = (app, sh) => (html(app).match(new RegExp(`<tr[^>]*data-show-row="${sh.id}"[\\s\\S]*?</tr>`)) || [''])[0];
const showCardOf = (app, sh) => card(app).split('<div class="item-card').find(c => c.includes(`data-show-row="${sh.id}"`)) || '';
const cellsOf = row => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => text(m[1]).trim());
const listCache = (storage, lists) => { storage.setItem(userKeyOf('watchlist-episode-lists'), JSON.stringify(lists)); return storage; };
const S2_LIST = { '95396:2': { ids: [9001, 9002, 9003, 9004], numbers: [1, 2, 3, 4], names: ['Title 1', 'Title 2', 'Title 3', 'Title 4'] } };

test('EP5 show row: Up next, action and progress describe the up-next season’s next episode, in All TV, Currently Watching and a collection, rows and cards', async () => {
  const storage = listCache(memoryStorage(), { ...S2_LIST, '95396:3': { ids: [7001, 7002], numbers: [1, 2], names: ['A', 'B'] } });
  storage.setItem(userKeyOf('watchlist_episode_titles'), 'on');
  const coll = { personalCollections: [{ id: '0c000000-0000-4000-8000-000000000002', name: 'Mine', legacy_source: null, sort_order: 1, archived_at: null, created_at: TS }],
    memberships: [{ id: '0d000000-0000-4000-8000-000000000002', collection_id: '0c000000-0000-4000-8000-000000000002', show_id: null, item_id: null, created_at: TS }] };
  const { app, lib } = await bootRow({ storage, extra: coll, edit: l => { coll.memberships[0].show_id = l.sev.id; }, marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9002, 2), mark(l.s3, 7001, 1)] });
  const check = (where, row, c, actionCol) => {
    const cells = cellsOf(row);
    assert.match(cells[2], /^Season 2 · Episode 3\s*Title 3$/, `${where}: Up next names the episode, its title below`);
    assert.ok(row.includes('<span class="next-ep-title">Title 3</span>'), `${where}: the title on its own quieter line`);
    assert.strictEqual(cells[actionCol], 'Mark E3 watched', `${where}: the action`);
    assert.ok(row.includes(`markNextEpisode('${lib.s2.id}', 9003, '${lib.sev.id}')`) && row.includes(`data-shortcut-show="${lib.sev.id}"`) && row.includes('onkeydown="if (event.repeat) event.preventDefault()"'), `${where}: the existing episode change, the row's focus hook, no held-key repeats`);
    assert.strictEqual(cells[actionCol + 1], '2/4 episodes watched', `${where}: episode progress`);
    assert.ok(row.includes('mini-progress-fill" style="width:50%"'), `${where}: a matching bar`);
    assert.ok(c.includes('Season 2 · Episode 3') && c.includes('Mark E3 watched') && c.includes('2/4 episodes watched'), `${where}: the card`);
  };
  check('All TV', showRowOf(app, lib.sev), showCardOf(app, lib.sev), 4);
  assert.ok(app.el('tableHead').innerHTML.includes('<th>Action</th>') && !app.el('tableHead').innerHTML.includes('<th>Watched</th>'), 'All TV: Action');
  app.ctx.switchView('watching'); await settle();
  check('Currently Watching', showRowOf(app, lib.sev), showCardOf(app, lib.sev), 3);
  assert.ok(app.el('tableHead').innerHTML.includes('<th>Action</th>'), 'Currently Watching: Action');
  app.ctx.openBrowseCollection('browse:0c000000-0000-4000-8000-000000000002'); await settle();
  check('collection', showRowOf(app, lib.sev), showCardOf(app, lib.sev), 4);
  assert.ok(app.el('tableHead').innerHTML.includes('<th>Action</th>'), 'collection: Action');
  // Expanded: Season 2 (represented) keeps only Episodes, Mark season watched and Skip; Season 3 keeps its own.
  app.ctx.toggleBrowseShow(lib.sev.id); await settle();
  const s2 = seasonRow(app, lib.s2), s3 = seasonRow(app, lib.s3);
  assert.match(text(s2), /^\s*Season 2 ▸ Episodes\s+Mark S2 watched Skip Delete…\s*$/, 'the represented season: no progress, next episode or date');
  assert.ok(!s2.includes('ep-next') && !s2.includes('Jan 1, 2022'));
  assert.match(text(s3), /1\/2 episodes watched ▸ Episodes Next unwatched: E2 — B Mark E2 watched/, 'another partly watched season keeps its own');
  assert.match(text(html(app)), /1\/3 seasons watched/, 'the season progress moves to the expanded show');
  assert.ok(!showCardOf(app, lib.sev).includes('Next unwatched: E3'), 'the card’s represented season too');
  await open(app, lib.s2);
  assert.match(panel(app), /^\s*Premiere: Jan 1, 2022 · 2\/4 watched/, 'its premiere is in the open list’s summary');
  app.ctx.switchView('alltv'); await settle();
  app.ctx.setAllTvPresentation('seasons'); await settle();
  assert.ok(app.el('tableHead').innerHTML.includes('<th>Watched</th>'), 'the flat Seasons list keeps Watched');
  assert.ok(html(app).includes('Next unwatched: E3') && html(app).includes('2/4 episodes watched'), 'and its seasons’ own progress');
  assert.deepStrictEqual(app.writes(), [], 'reading only');
});

test('EP5 show row: every other target keeps the season presentation; nothing is inferred from marks alone', async () => {
  const run = async (o, expect) => {
    const { app, lib } = await bootRow(o);
    const cells = cellsOf(showRowOf(app, lib.sev));
    assert.deepStrictEqual([cells[2], cells[4], cells[5]], expect, o.why);
    return { app, lib };
  };
  await run({ why: 'no marks: the season, Mark season watched, season progress' }, ['Season 2 · Jan 1, 2022', 'Mark S2 watched', '1/3 seasons watched']);
  await run({ why: 'marks, the list unknown: N marked, no bar', marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9002, 2)] }, ['Season 2 · Jan 1, 2022', 'Mark S2 watched', '2 episodes marked']);
  const counted = await run({ why: 'a count only, equal to the marks: still N marked, never a complete-looking 2/2', storage: listCache(memoryStorage(), { '95396:2': { count: 2 } }), marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9005, 5)] },
    ['Season 2 · Jan 1, 2022', 'Mark S2 watched', '2 episodes marked']);
  assert.ok(!showRowOf(counted.app, counted.lib.sev).includes('mini-progress-fill'), 'no bar without a known total');
  const partial = await run({ why: 'a count above the marks: N/T with its bar', storage: listCache(memoryStorage(), { '95396:2': { count: 4 } }), marks: l => [mark(l.s2, 9001, 1)] },
    ['Season 2 · Jan 1, 2022', 'Mark S2 watched', '1/4 episodes watched']);
  assert.ok(showRowOf(partial.app, partial.lib.sev).includes('style="width:25%"'));
  const listed = await run({ why: 'every listed episode marked: said so, no row action; a mark TMDB no longer lists isn’t counted', storage: listCache(memoryStorage(), { '95396:2': { ids: [9001, 9002], numbers: [1, 2], names: ['', ''] } }),
    marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9002, 2), mark(l.s2, 9009, 9)] }, ['Season 2 · All listed episodes watched', '', '2/2 episodes watched · 1 not listed']);
  assert.ok(!/markSeasonFromRow|markNextEpisode|toggleWatch/.test(showRowOf(listed.app, listed.lib.sev) + showCardOf(listed.app, listed.lib.sev)), 'no action in the row or card: the season is completed deliberately');
  listed.app.ctx.toggleDerivedShow(listed.lib.sev.id); await settle();
  assert.ok(seasonRow(listed.app, listed.lib.s2).includes(`toggleWatch('${listed.lib.s2.id}')`) && text(seasonRow(listed.app, listed.lib.s2)).includes('Mark S2 watched'), 'the expanded season row keeps it');
  await run({ why: 'not aired yet: the restriction stands', storage: listCache(memoryStorage(), S2_LIST), marks: l => [mark(l.s2, 9001, 1)],
    edit: l => { l.s2.date_sort = '2099-03-01'; l.s2.display_date = 'Mar 1, 2099'; } }, ['Season 2 · Mar 1, 2099 Upcoming', 'Not aired yet', '1/3 seasons watched']);
  const toWatch = await bootRow({ storage: listCache(memoryStorage(), S2_LIST), marks: l => [mark(l.s2, 9001, 1)], edit: l => { l.sev.status = 'confirmed'; } });
  assert.ok(!/Episode 2|markNextEpisode/.test(showRowOf(toWatch.app, toWatch.lib.sev)) && /1\/3 seasons watched/.test(showRowOf(toWatch.app, toWatch.lib.sev)), 'a show that isn’t Watching: as before');
});

test('EP5 show row: an Earlier-seasons range keeps choosing the season; marks never choose it', async () => {
  const storage = listCache(memoryStorage(), { '95396:3': { ids: [7001, 7002], numbers: [1, 2], names: ['A', 'B'] } });
  const { app, lib } = await bootRow({ storage, edit: l => { l.s1.watched = false; l.s2.watched = true; }, marks: l => [mark(l.s3, 7001, 1)] });
  assert.match(cellsOf(showRowOf(app, lib.sev))[2], /^Season 3 · Episode 2/, 'after the furthest watched season: Season 3, by its marks’ episode');
  app.ctx.toggleDerivedShow(lib.sev.id); await settle();
  await app.ctx.startResume(lib.sev.id, lib.s1.id); await settle();
  const cells = cellsOf(showRowOf(app, lib.sev));
  assert.deepStrictEqual([cells[2], cells[4]], ['Season 1 · Jan 1, 2022', 'Mark S1 watched'], 'the range’s next season, though Season 3 has marks');
  assert.match(text(seasonRow(app, lib.s3)), /1\/2 episodes watched ▸ Episodes Next unwatched: E2 Mark E2 watched/, 'Season 3 keeps its own row');
});

test('EP5 row action: one episode per press, focus stays on the action as it moves on; repeats and stale presses send nothing; the last one leaves no action and focus on the expand button', async () => {
  for (const layout of ['tbody', 'cardList']) {
    const { app, lib } = await bootRow({ storage: listCache(memoryStorage(), { '95396:2': { ids: [9001, 9002, 9003], numbers: [1, 2, 3], names: ['', '', ''] } }), marks: l => [mark(l.s2, 9001, 1)] });
    const dom = makeMiniDom(app);
    dom.hide(layout === 'tbody' ? 'cardList' : 'tbody');
    const sel = `[data-shortcut-show="${lib.sev.id}"]`;
    dom.focus(layout, sel);
    const held = app.hold(r => r.url.endsWith('/rpc/library_set_episode_marks'));
    const first = app.ctx.markNextEpisode(lib.s2.id, 9002, lib.sev.id);
    await held.reached;
    await app.ctx.markNextEpisode(lib.s2.id, 9003, lib.sev.id); // the second click lands on the redrawn Mark E3
    held.release(); await first; await settle();
    await app.ctx.markNextEpisode(lib.s2.id, 9003, lib.sev.id); // just after
    assert.deepStrictEqual(rpcEpisodes(app), [[{ tmdb_episode_id: 9002, episode_number: 2 }]], `${layout}: one episode`);
    assert.doesNotMatch(banners(app), /still being saved/, `${layout}: ignored, not refused`);
    assert.strictEqual(dom.active(), dom.in(layout, sel), `${layout}: focus on the row’s action`);
    assert.match(text(layout === 'tbody' ? showRowOf(app, lib.sev) : showCardOf(app, lib.sev)), /Season 2 · Episode 3[\s\S]*Mark E3 watched[\s\S]*2\/3 episodes watched|Season 2 · Episode 3[\s\S]*2\/3 episodes watched[\s\S]*Mark E3 watched/);
    assert.strictEqual(app.get('episodePanel'), null, `${layout}: Episodes not opened`);
    app.run('episodeNextMark.until = 0');
    await app.ctx.markNextEpisode(lib.s2.id, 9002, lib.sev.id); await settle();
    assert.strictEqual(rpcEpisodes(app).length, 1, `${layout}: a press naming an episode no longer next sends nothing`);
    await app.ctx.markNextEpisode(lib.s2.id, 9003, lib.sev.id); await settle();
    assert.match(text(layout === 'tbody' ? showRowOf(app, lib.sev) : showCardOf(app, lib.sev)), /All listed episodes watched/, `${layout}: the last one`);
    assert.ok(!dom.in(layout, sel), `${layout}: no action replaces it`);
    assert.strictEqual(dom.active(), dom.in(layout, `[data-item="${lib.sev.id}"] [data-primary]`), `${layout}: focus on the show’s expand button`);
    assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s2.id).watched, false, `${layout}: the season isn’t completed`);
  }
});

test('EP5 row action: Mark season watched is the season’s Watched change; the next season’s button that replaces it ignores repeats for a moment', async () => {
  const { app, lib } = await bootRow();
  const dom = makeMiniDom(app);
  dom.hide('cardList');
  dom.focus('tbody', `[data-shortcut-show="${lib.sev.id}"]`);
  await app.ctx.markSeasonFromRow(lib.s2.id); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/set_season_watched']);
  assert.strictEqual(cellsOf(showRowOf(app, lib.sev))[2], 'Season 3 · Jan 1, 2022', 'up next moves on');
  assert.ok(showRowOf(app, lib.sev).includes(`markSeasonFromRow('${lib.s3.id}')`) && dom.active() === dom.in('tbody', `[data-shortcut-show="${lib.sev.id}"]`), 'focus on the next season’s action');
  await app.ctx.markSeasonFromRow(lib.s3.id); await settle();
  assert.strictEqual(writes(app).length, 1, 'a second press just after sends nothing');
  app.run('episodeNextMark.until = 0');
  await app.ctx.markSeasonFromRow(lib.s3.id); await settle();
  assert.deepStrictEqual(writes(app), ['POST rpc/set_season_watched', 'POST rpc/set_season_watched'], 'a later press works');
});

test('EP5 expanded show: the season progress line leaves the skipped count to its control; an all-skipped show keeps its explanation', async () => {
  const { app, lib } = await bootRow({ edit: l => { l.s3.skipped = true; } });
  const p = (seasons, show) => app.ctx.showProgressText(seasons, show);
  const sev = lib.sev, rows = [lib.s1, lib.s2, lib.s3];
  assert.strictEqual(p(rows, sev), '1/2 seasons watched', 'the control says (1)');
  assert.strictEqual(p(rows, { ...sev, status: 'skipped' }), '1/2 seasons watched · 1 skipped', 'a Skipped show has no such control: kept');
  assert.strictEqual(p(rows.map(r => ({ ...r, skipped: true })), sev), '', 'all skipped: the control’s note explains');
  assert.strictEqual(p(rows.map(r => ({ ...r, skipped: true })), { ...sev, status: 'skipped' }), '3 seasons · all skipped');
  app.ctx.switchView('watching'); await settle();
  app.ctx.toggleDerivedShow(lib.sev.id); await settle();
  assert.match(text(html(app)), /1\/2 seasons watched Details… Show skipped seasons \(1\)/);
  assert.doesNotMatch(html(app), /· 1 skipped/);
});

// ── Mark E9 watched (EP4) ──
const quickIn = s => (s.match(/<span class="season-action" data-action="ep-next-mark">[\s\S]*?<\/span>/) || [''])[0];
const quickLabel = s => text(quickIn(s)).trim();
function cachedList(storage, n = 4) {
  storage.setItem(userKeyOf('watchlist-episode-lists'), JSON.stringify({ '95396:2': { ids: [9001, 9002, 9003, 9004].slice(0, n), numbers: [1, 2, 3, 4].slice(0, n), names: ['Title 1', 'Title 2', 'Title 3', 'Title 4'].slice(0, n) } }));
  return storage;
}
const rpcEpisodes = app => rpcs(app, 'library_set_episode_marks').map(r => r.body.p_episodes);
test('Mark E2 watched: beside the line on the expanded row and phone card, named for that one episode; not on the flat Seasons list; hidden with the line', async () => {
  const { app, lib } = await boot({ storage: cachedList(memoryStorage()), marks: l => [mark(l.s2, 9001, 1), mark(l.s1, 8001, 1)] });
  const row = seasonRow(app, lib.s2);
  assert.strictEqual(quickLabel(row), 'Mark E2 watched');
  assert.match(row, /<span class="ep-next-line"><span class="ep-next">Next unwatched: E2<\/span> <span class="season-action" data-action="ep-next-mark"><button type="button" class="btn btn-link ep-next-mark" aria-label="Mark E2 watched: episode 2 of Season 2 only"/);
  assert.ok(quickIn(row).includes('onkeydown="if (event.repeat) event.preventDefault()"'), 'a held key’s repeats don’t press it again');
  assert.ok(quickIn(row).includes(`markNextEpisode('${lib.s2.id}', 9002)`), 'it carries the episode it names');
  assert.match(card(app), /<span class="ep-next-line"><span class="ep-next">Next unwatched: E2<\/span> <span class="season-action" data-action="ep-next-mark">/, 'the phone card too');
  assert.match(text(row), /Mark S2 watched/, 'the season’s own Mark S2 watched stays, separate');
  assert.strictEqual(quickIn(seasonRow(app, lib.s1)), '', 'a watched season: no line, no button');
  assert.strictEqual(quickIn(seasonRow(app, lib.s3)), '', 'a season without marks: no line, no button');
  app.ctx.setAllTvPresentation('seasons'); await settle();
  assert.ok((html(app) + card(app)).includes('Next unwatched: E2'), 'the flat Seasons list keeps the line');
  assert.ok(!(html(app) + card(app)).includes('ep-next-mark'), 'but not the button');
  app.ctx.setAllTvPresentation('shows'); await settle();
  assert.deepStrictEqual(app.writes(), [], 'showing it writes nothing');
});

test('Mark E2 watched: marks only that episode through the one change, the progress and line move on, the list stays closed and focus stays; the last one removes both and focus goes to Episodes', async () => {
  for (const layout of ['tbody', 'cardList']) {
    const { app, lib } = await boot({ storage: cachedList(memoryStorage()), marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9003, 3)] });
    const dom = makeMiniDom(app);
    dom.hide(layout === 'tbody' ? 'cardList' : 'tbody');
    const sel = `[data-season-row="${lib.s2.id}"] [data-action="ep-next-mark"] button`;
    dom.focus(layout, sel);
    await app.ctx.markNextEpisode(lib.s2.id, 9002); await settle();
    assert.deepStrictEqual(rpcEpisodes(app), [[{ tmdb_episode_id: 9002, episode_number: 2 }]], `${layout}: one episode, the one named`);
    assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002, 9003]);
    assert.match(text(seasonRow(app, lib.s2)), /· 3\/4 episodes watched ▸ Episodes Next unwatched: E4 Mark E4 watched/, `${layout}: past the marked E3`);
    assert.strictEqual(app.get('episodePanel'), null, `${layout}: Episodes not opened`);
    assert.strictEqual(dom.active(), dom.in(layout, sel), `${layout}: focus on the button, now for E4`);
    app.run('episodeNextMark = null');
    await app.ctx.markNextEpisode(lib.s2.id, 9004); await settle();
    assert.match(text(seasonRow(app, lib.s2)), /· 4\/4 episodes watched ▸ Episodes/, `${layout}: the last one: 4/4`);
    assert.ok(!(html(app) + card(app)).includes('ep-next'));
    assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s2.id).watched, false, `${layout}: nothing completes the season`);
    assert.strictEqual(dom.active(), dom.in(layout, `[data-season-row="${lib.s2.id}"] [data-action="episodes"] button`), `${layout}: focus on the season’s Episodes toggle, not the show’s Mark watched`);
  }
});

test('Mark E2 watched: further clicks while it is saved and just after send nothing (no lane message); a click naming an episode no longer next sends nothing; a later click marks the next', async () => {
  const { app, lib } = await boot({ storage: cachedList(memoryStorage()), marks: l => [mark(l.s2, 9001, 1)] });
  const held = app.hold(r => r.url.endsWith('/rpc/library_set_episode_marks'));
  const first = app.ctx.markNextEpisode(lib.s2.id, 9002);
  await held.reached;
  assert.strictEqual(quickLabel(seasonRow(app, lib.s2)), 'Mark E3 watched', 'shown at once');
  await app.ctx.markNextEpisode(lib.s2.id, 9003); // the double click's second half, on the redrawn button
  held.release(); await first; await settle();
  await app.ctx.markNextEpisode(lib.s2.id, 9003); // just after it settled
  assert.deepStrictEqual(rpcEpisodes(app), [[{ tmdb_episode_id: 9002, episode_number: 2 }]]);
  assert.doesNotMatch(banners(app), /still being saved/, 'ignored, not refused');
  app.run('episodeNextMark.until = 0');
  await app.ctx.markNextEpisode(lib.s2.id, 9002); await settle();
  assert.strictEqual(rpcEpisodes(app).length, 1, 'E2 is no longer next: nothing sent');
  await app.ctx.markNextEpisode(lib.s2.id, 9003); await settle();
  assert.deepStrictEqual(rpcEpisodes(app)[1], [{ tmdb_episode_id: 9003, episode_number: 3 }]);
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002, 9003]);
});

test('Mark E2 watched: marked on another device already, harmless and the line moves on; refusals and a season changed elsewhere put back what was shown; another change in progress refuses it', async () => {
  const { app, lib } = await boot({ storage: cachedList(memoryStorage()), marks: l => [mark(l.s2, 9001, 1)] });
  app.store.episode_marks.push(mark(lib.s2, 9002, 2), mark(lib.s2, 9003, 3)); // another device
  await app.ctx.markNextEpisode(lib.s2.id, 9002); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002, 9003]);
  assert.strictEqual(nextIn(seasonRow(app, lib.s2)), 'Next unwatched: E4', 'the answer’s marks: E4 next');
  app.run('episodeNextMark = null');
  app.refuseNext(r => r.url.endsWith('/rpc/library_set_episode_marks'), 'P0001', 'season_locked: This season is marked watched or skipped, so its episodes can\'t be changed. Change that first. Nothing was changed.');
  await app.ctx.markNextEpisode(lib.s2.id, 9004); await settle();
  assert.strictEqual(nextIn(seasonRow(app, lib.s2)), 'Next unwatched: E4', 'refused: put back');
  assert.match(banners(app), /marked watched or skipped/);
  app.run('episodeNextMark = null');
  app.store.watchlist_items.find(r => r.id === lib.s2.id).watched = true; // marked watched elsewhere
  await app.ctx.markNextEpisode(lib.s2.id, 9004); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002, 9003], 'the expected values refuse it');
  app.store.watchlist_items.find(r => r.id === lib.s2.id).watched = false;
  app.run('episodeNextMark = null');
  const g = app.hold(r => r.url.includes('/rpc/') && !r.url.endsWith('/rpc/library_set_episode_marks'));
  const other = app.ctx.toggleWatch(lib.s3.id); // another change in progress
  await g.reached;
  await app.ctx.markNextEpisode(lib.s2.id, 9004);
  assert.match(banners(app), /still being saved/, 'the lane refuses it as any other change');
  g.release(); await other; await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002, 9003], 'nothing marked');
  assert.strictEqual(rpcEpisodes(app).length, 3, 'nothing sent');
});

// ── Collections and the phone ──
test('a collection’s show entry has the same progress, list and marks; the phone card has them too', async () => {
  const lib = library();
  const app = await createApp({ rows: lib.rows, tvShows: lib.shows, tmdb: tmdb(), storage: memoryStorage(), episodeMarks: [mark(lib.s2, 9001, 1)],
    personalCollections: [{ id: '0c000000-0000-4000-8000-000000000001', name: 'Mine', legacy_source: null, sort_order: 1, archived_at: null, created_at: TS }],
    memberships: [{ id: '0d000000-0000-4000-8000-000000000001', collection_id: '0c000000-0000-4000-8000-000000000001', show_id: lib.sev.id, item_id: null, created_at: TS }] });
  app.ctx.openBrowseCollection('browse:0c000000-0000-4000-8000-000000000001'); await settle();
  app.ctx.toggleBrowseShow(lib.sev.id); await settle();
  assert.match(text(seasonRow(app, lib.s2)), /1 episode marked/);
  await open(app, lib.s2);
  assert.match(panel(app), /1\/4 watched/);
  await app.ctx.setEpisodeMark(lib.s2.id, 9002, true); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002]);
  const c = card(app);
  assert.ok(c.includes(`toggleEpisodes('${lib.s2.id}')`) && /ep-panel-card/.test(c) && c.includes(`setEpisodeMark('${lib.s2.id}', 9003, this.checked)`), 'the card carries the toggle and the list');
  assert.match(panel(app), /Mark watched through Episode 1 Episode 2 Episode 3 Episode 4 Apply/, 'EP2: the same bulk control in a collection');
  assert.ok(c.includes(`applyEpisodesThrough('${lib.s2.id}')`) && c.includes(`chooseEpisodesThrough('${lib.s2.id}', this.value)`) && />Show title</.test(c), 'and in its phone card');
  app.ctx.chooseEpisodesThrough(lib.s2.id, '9003');
  await app.ctx.applyEpisodesThrough(lib.s2.id); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001, 9002, 9003]);
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

// ── CU1d: a Watched season's list, Mark all episodes watched ──
const EP_ALL = 'library_add_watched_season_marks';
const tmdbWith = (shows = {}, eps = EPISODES) => p => {
  const m = /^\/tv\/95396\/season\/(\d+)$/.exec(p);
  if (m) return eps[m[1]] ? { id: 1, episodes: eps[m[1]] } : undefined;
  return p === '/tv/95396' ? shows.details : undefined;
};
const reads = (app, path) => app.requests.filter(r => r.url.includes(`/3${path}`) && new URL(r.url).pathname.endsWith(path)).length;

test('Mark all episodes watched: asked first; adds every listed episode, aired or not, with the identity the list was read for; the season doesn’t change', async () => {
  const eps = { ...EPISODES, 1: [E(8001, 1), E(8002, 2, { air_date: '2099-01-01' }), E(8003, 3, { air_date: null })] };
  const { app, lib } = await boot({ episodes: eps });
  await open(app, lib.s1);
  const before = { ...app.store.watchlist_items.find(r => r.id === lib.s1.id) };
  assert.match(panel(app), /Mark all episodes watched/);
  app.ctx.askMarkAllEpisodes(lib.s1.id, true); await settle();
  assert.match(panel(app), /Mark 3 listed episodes watched\? The season stays marked watched, and episodes TMDB adds later won’t be marked\./);
  app.ctx.askMarkAllEpisodes(lib.s1.id, false); await settle();
  assert.deepStrictEqual(rpcs(app, EP_ALL), [], 'Cancel sends nothing');
  app.ctx.askMarkAllEpisodes(lib.s1.id, true); await settle();
  await app.ctx.markAllEpisodesWatched(lib.s1.id); await settle();
  const [call] = rpcs(app, EP_ALL);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(call.body)), { p_season_id: lib.s1.id,
    p_expected: { show_id: lib.sev.id, show_tmdb_id: 95396, tmdb_id: 95396, season_number: 1, watched: true, skipped: false },
    p_episodes: [8001, 8002, 8003].map((id, i) => ({ tmdb_episode_id: id, episode_number: i + 1 })) });
  assert.deepStrictEqual(rpcs(app, 'library_set_episode_marks'), [], 'the ordinary function isn’t used');
  assert.deepStrictEqual(rpcs(app, 'set_season_watched'), [], 'no status change, not even a round trip');
  assert.deepStrictEqual(marksIn(app, lib.s1), [8001, 8002, 8003]);
  assert.deepStrictEqual({ ...app.store.watchlist_items.find(r => r.id === lib.s1.id) }, before);
  assert.match(panel(app), /This season is marked watched, so its episodes are locked/);
  assert.match(panel(app), /3\/3 watched/);
  assert.ok(!/Mark all episodes watched/.test(panel(app)), 'nothing left to mark: no button');
});

test('Mark all on a Watched season with some marks: only the unmarked go; ordinary editing stays locked; a later episode isn’t marked', async () => {
  const eps = { ...EPISODES, 1: [E(8001, 1), E(8002, 2), E(8003, 3)] };
  const { app, lib } = await boot({ episodes: eps, marks: l => [mark(l.s1, 8002, 2)] });
  await open(app, lib.s1);
  app.ctx.setEpisodeMark(lib.s1.id, 8001, true); await settle();
  assert.deepStrictEqual(rpcs(app, 'library_set_episode_marks'), [], 'one box on a Watched season stays locked');
  app.ctx.askMarkAllEpisodes(lib.s1.id, true); await settle();
  assert.match(panel(app), /Mark 2 listed episodes watched\?/);
  await app.ctx.markAllEpisodesWatched(lib.s1.id); await settle();
  assert.deepStrictEqual(rpcs(app, EP_ALL)[0].body.p_episodes.map(e => e.tmdb_episode_id), [8001, 8003]);
  assert.deepStrictEqual(marksIn(app, lib.s1), [8001, 8002, 8003]);
  // TMDB adds an episode: it's listed unmarked, and nothing marks it.
  app.setTmdb(tmdb({ ...EPISODES, 1: [E(8001, 1), E(8002, 2), E(8003, 3), E(8004, 4)] }));
  await open(app, lib.s1); await open(app, lib.s1);
  assert.match(panel(app), /3\/4 watched/);
  assert.deepStrictEqual(marksIn(app, lib.s1), [8001, 8002, 8003]);
  // Unmarking Watched keeps them all and unlocks ordinary editing.
  await app.ctx.toggleWatch(lib.s1.id); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s1), [8001, 8002, 8003]);
  assert.ok(!/Mark all episodes watched/.test(panel(app)), 'only a Watched season has it');
  await app.ctx.setEpisodeMark(lib.s1.id, 8001, false); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s1), [8002, 8003]);
});

test('marking Watched adds no marks; unmarking clears none', async () => {
  const { app, lib } = await boot({ marks: l => [mark(l.s2, 9001, 1)] });
  await open(app, lib.s2);
  await app.ctx.toggleWatch(lib.s2.id); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001]);
  await app.ctx.toggleWatch(lib.s2.id); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s2), [9001]);
});

test('a season rematched after its list was read: refused, nothing marked, what was shown put back', async () => {
  for (const change of [s => { s.season_number = 7; }, s => { s.tmdb_id = 1234; }]) {
    const { app, lib } = await boot();
    await open(app, lib.s1);
    change(app.store.watchlist_items.find(r => r.id === lib.s1.id));
    app.ctx.askMarkAllEpisodes(lib.s1.id, true); await settle();
    await app.ctx.markAllEpisodesWatched(lib.s1.id); await settle();
    assert.strictEqual(rpcs(app, EP_ALL).length, 1);
    assert.deepStrictEqual(rpcs(app, EP_ALL)[0].body.p_expected.tmdb_id, 95396, 'the identity the list was read for, not the row’s newer one');
    assert.deepStrictEqual(marksIn(app, lib.s1), []);
    assert.match(banners(app), /changed|Nothing was changed/i);
  }
  const { app, lib } = await boot();
  await open(app, lib.s1);
  app.store.tv_shows.find(s => s.id === lib.sev.id).tmdb_id = 1234;
  app.ctx.askMarkAllEpisodes(lib.s1.id, true); await settle();
  await app.ctx.markAllEpisodesWatched(lib.s1.id); await settle();
  assert.deepStrictEqual(marksIn(app, lib.s1), [], 'the show rematched: refused too');
});

test('Mark all: no clear answer is never resent; the view is read again', async () => {
  const { app, lib } = await boot();
  await open(app, lib.s1);
  app.failNext(r => r.url.endsWith(`/rpc/${EP_ALL}`));
  app.ctx.askMarkAllEpisodes(lib.s1.id, true); await settle();
  await app.ctx.markAllEpisodesWatched(lib.s1.id); await settle();
  assert.strictEqual(rpcs(app, EP_ALL).length, 1);
  assert.deepStrictEqual(marksIn(app, lib.s1), []);
});

// ── CU1d: the completion suggestion ──
const AIRED = (n, o = {}) => E(9100 + n, n, { air_date: '2025-01-0' + n, ...o });
const FINALE = { 2: [AIRED(1), AIRED(2, { episode_type: 'finale' })] };
const details = (o = {}) => ({ id: 95396, status: 'Returning Series', next_episode_to_air: null, seasons: [{ season_number: 1, episode_count: 2 }, { season_number: 2, episode_count: 2 }], ...o });
const allMarked = l => [mark(l.s2, 9101, 1), mark(l.s2, 9102, 2)];
const FINISHED = /TMDB’s details indicate this season has finished, though that isn’t a guarantee\./;
async function bootFinish(o = {}) {
  const lib0 = await boot({ episodes: o.episodes || FINALE, marks: o.marks || allMarked, storage: o.storage });
  lib0.app.setTmdb(tmdbWith({ details: o.details === undefined ? details() : o.details }, o.episodes || FINALE));
  return lib0;
}

test('completion evidence: every rule, on its own', async () => {
  const { app } = await boot();
  const eps = [{ id: 1, air_date: '2025-01-01', type: null }, { id: 2, air_date: '2025-01-02', type: 'finale' }];
  const marks = new Map([[1, {}], [2, {}]]), today = '2026-01-01';
  const yes = (d, list = eps, n = 2, m = marks) => app.ctx.seasonLooksFinished(d, n, list, m, today);
  const plain = [{ id: 1, air_date: '2025-01-01', type: null }, { id: 2, air_date: '2025-01-02', type: 'standard' }];
  assert.strictEqual(yes(details()), true, 'an aired finale at the end of the list');
  assert.strictEqual(yes(details({ next_episode_to_air: { season_number: 3 } })), true, 'a next episode in a later season doesn’t matter to a finale');
  assert.strictEqual(yes(details({ status: 'Ended' }), plain), true, 'Ended with nothing scheduled');
  assert.strictEqual(yes(details({ status: 'Canceled' }), plain), true, 'Canceled with nothing scheduled');
  assert.strictEqual(yes(details({ status: 'Returning Series' }), plain), false, 'no finale, not ended');
  assert.strictEqual(yes(details({ status: 'Ended', next_episode_to_air: { season_number: 3 } }), plain), false, 'Ended, something scheduled');
  assert.strictEqual(yes(details({ next_episode_to_air: { season_number: 2 } })), false, 'a next episode in this season stops it, finale or not');
  assert.strictEqual(yes(details({ status: 'Ended', next_episode_to_air: { season_number: 2 } })), false);
  assert.strictEqual(yes(details({ next_episode_to_air: { name: 'x' } })), false, 'a next episode without a season is conflicting evidence');
  assert.strictEqual(yes(details({ last_episode_to_air: { season_number: 3 }, status: 'Returning Series', seasons: [{ season_number: 2, episode_count: 2 }, { season_number: 3, air_date: '2025-06-01', episode_count: 1 }] }), plain), false, 'a later season having started counts for nothing');
  assert.strictEqual(yes(details({ seasons: [{ season_number: 2, episode_count: 3 }] })), false, 'TMDB’s count disagrees with the list');
  assert.strictEqual(yes(details({ seasons: [{ season_number: 2 }] })), false, 'no count for the season');
  assert.strictEqual(yes(details({ seasons: [] })), false, 'the season isn’t in the details');
  assert.strictEqual(yes(details({ seasons: undefined })), false);
  assert.strictEqual(yes(null), false, 'no details');
  assert.strictEqual(yes(details(), []), false, 'an empty list');
  assert.strictEqual(yes(details(), [eps[0], { ...eps[1], air_date: '2026-06-01' }]), false, 'an episode still to air');
  assert.strictEqual(yes(details(), [eps[0], { ...eps[1], air_date: null }]), false, 'an episode without an air date');
  assert.strictEqual(yes(details(), eps, 2, new Map([[1, {}]])), false, 'an unmarked episode');
  assert.strictEqual(yes(details({ status: 'Ended', seasons: [{ season_number: 0, episode_count: 2 }] }), eps, 0), false, 'specials never');
  assert.strictEqual(yes(details(), [{ ...eps[1] }, { ...eps[0], id: 3 }], 2, new Map([[2, {}], [3, {}]])), false, 'a finale that isn’t last');
});

test('the last box checked: the season and show are read once; the existing offer says so honestly; Watched waits for the owner', async () => {
  const { app, lib } = await bootFinish({ marks: l => [mark(l.s2, 9101, 1)] });
  await open(app, lib.s2);
  assert.ok(!FINISHED.test(panel(app)));
  const before = app.requests.length;
  await app.ctx.setEpisodeMark(lib.s2.id, 9102, true); await settle();
  const after = app.requests.slice(before).filter(r => /\/3\/tv\//.test(r.url)).map(r => new URL(r.url).pathname);
  assert.strictEqual(after.filter(p => p.endsWith('/tv/95396/season/2')).length, 1, 'one fresh season read');
  assert.strictEqual(after.filter(p => p.endsWith('/tv/95396')).length, 1, 'one fresh show read');
  assert.match(panel(app), FINISHED);
  assert.match(panel(app), /Mark Season 2 watched/);
  assert.strictEqual((html(app).match(/<tr class="sub-row ep-panel-row"[\s\S]*?<\/tr>/)[0].match(/toggleWatch\(/g) || []).length, 1, 'the one existing control, not a second');
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s2.id).watched, false, 'nothing changes without the owner');
  await app.ctx.setEpisodeMark(lib.s2.id, 9102, false); await settle();
  assert.ok(!FINISHED.test(panel(app)), 'unchecked: the suggestion goes');
  await app.ctx.setEpisodeMark(lib.s2.id, 9102, true); await settle();
  assert.match(panel(app), FINISHED, 'checked again: decided again');
  await app.ctx.toggleWatch(lib.s2.id); await settle();
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s2.id).watched, true);
  assert.deepStrictEqual(marksIn(app, lib.s2), [9101, 9102], 'marks kept');
  await app.ctx.toggleWatch(lib.s2.id); await settle();
  assert.ok(!FINISHED.test(panel(app)), 'a suggestion doesn’t outlive the state it was made for');
});

test('opening a fully marked list checks too, with one season read and one show read', async () => {
  const { app, lib } = await bootFinish();
  const before = app.requests.length;
  await open(app, lib.s2);
  const after = app.requests.slice(before).filter(r => /\/3\/tv\//.test(r.url)).map(r => new URL(r.url).pathname);
  assert.deepStrictEqual([after.filter(p => p.endsWith('/season/2')).length, after.filter(p => p.endsWith('/tv/95396')).length], [1, 1]);
  assert.match(panel(app), FINISHED);
});

test('uncertain metadata: the plain offer stays, with Mark season watched', async () => {
  for (const [label, o] of [
    ['a failed show read', { details: null }],
    ['no finale, Returning Series', { episodes: { 2: [AIRED(1), AIRED(2)] } }],
    ['a next episode in this season', { details: details({ next_episode_to_air: { season_number: 2 } }) }],
    ['the count disagrees', { details: details({ seasons: [{ season_number: 2, episode_count: 3 }] }) }]]) {
    const { app, lib } = await bootFinish(o);
    await open(app, lib.s2);
    assert.ok(!FINISHED.test(panel(app)), label);
    assert.match(panel(app), /Every listed episode is checked\./, label);
    assert.match(panel(app), /Mark Season 2 watched/, label);
    assert.ok(!/Not now/.test(panel(app)), label);
  }
});

test('a list that isn’t fully marked or aired reads nothing extra', async () => {
  const { app, lib } = await bootFinish({ episodes: EPISODES, marks: l => [mark(l.s2, 9001, 1), mark(l.s2, 9002, 2), mark(l.s2, 9003, 3), mark(l.s2, 9004, 4)] });
  const before = app.requests.length;
  await open(app, lib.s2);
  const after = app.requests.slice(before).filter(r => /\/3\/tv\//.test(r.url)).map(r => new URL(r.url).pathname);
  assert.strictEqual(after.filter(p => p.endsWith('/tv/95396')).length, 0, 'unaired episodes: no show read');
  assert.match(panel(app), /Every listed episode is checked/);
});

test('fresh TMDB data wins: an episode added since the list opened leaves the season not fully checked', async () => {
  const { app, lib } = await bootFinish({ marks: l => [mark(l.s2, 9101, 1)] });
  await open(app, lib.s2);
  app.setTmdb(tmdbWith({ details: details({ seasons: [{ season_number: 2, episode_count: 3 }] }) }, { 2: [AIRED(1), AIRED(2), AIRED(3, { episode_type: 'finale' })] }));
  await app.ctx.setEpisodeMark(lib.s2.id, 9102, true); await settle();
  assert.match(panel(app), /2\/3 watched/);
  assert.ok(!/Every listed episode is checked/.test(panel(app)));
});

test('Not now: the plain offer stays and no reads repeat, across a reload, until the episode count changes', async () => {
  const storage = memoryStorage();
  const { app, lib } = await bootFinish({ storage });
  await open(app, lib.s2);
  assert.match(panel(app), /Not now/);
  app.ctx.declineSeasonFinish(lib.s2.id); await settle();
  assert.ok(!FINISHED.test(panel(app)));
  assert.match(panel(app), /Mark Season 2 watched/, 'ordinary completion stays');
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === lib.s2.id).watched, false);
  const again = await bootFinish({ storage });
  const before = again.app.requests.length;
  await open(again.app, again.lib.s2);
  const after = again.app.requests.slice(before).map(r => new URL(r.url).pathname);
  assert.strictEqual(after.filter(p => p.endsWith('/tv/95396')).length, 0, 'declined: no show read');
  assert.ok(!FINISHED.test(panel(again.app)));
  // Another account's choice is its own: userStorage is per account (auth.js); here, one more episode asks again.
  const more = { 2: [AIRED(1), AIRED(2), AIRED(3, { episode_type: 'finale' })] };
  const third = await bootFinish({ storage, episodes: more, details: details({ seasons: [{ season_number: 2, episode_count: 3 }] }),
    marks: l => [mark(l.s2, 9101, 1), mark(l.s2, 9102, 2), mark(l.s2, 9103, 3)] });
  await open(third.app, third.lib.s2);
  assert.match(panel(third.app), FINISHED);
});

test('Not now without working storage holds for the open page', async () => {
  const storage = memoryStorage();
  const { app, lib } = await bootFinish({ storage });
  storage.setItem = () => { throw new Error('quota'); };
  await open(app, lib.s2);
  app.ctx.declineSeasonFinish(lib.s2.id); await settle();
  await open(app, lib.s2); await open(app, lib.s2);
  assert.ok(!FINISHED.test(panel(app)));
});

T.run();
