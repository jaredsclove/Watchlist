// Offline tests for collection updates (item 4, CU1: db/cu1_collection_updates.sql; collection-updates.js,
// collection-research.js, collection-settings.js) in the whole-page harness (tests/cu1-harness.js stands
// in for the database's library_cu_* functions):
//   * Refresh shows: library-wide and TMDB only (catalog and collection shows included, Skipped shows only
//     when followed), seasons reconciled with identified and unidentified rows (an announced row is reused,
//     an ambiguous one goes to review, a genuinely absent one is created), the setup gate for catalog
//     shows, Ended kept and flagged, TBA and future dates, full episode lists on this device, unmatched
//     shows matched only when unambiguous (title or evidenced alias, year, anchor), three result sections
//     with TMDB-only coverage, an unclear answer stopping everything after it;
//   * review: the ambiguous season's row chosen, a date applied, Not now, Exclude, a new show added with
//     its membership, Same as a removed member only with the owner's add-back;
//   * the research round trip: the brief (versions, rules, exclusions, holds, items with their required
//     checks, Ended shows included), the findings file validated and routed by the current state
//     (Manual, a changed rule, evidence below the standard, a conflict, an exclusion), automatic new
//     seasons, dates and aliases, a repeated file refused, overlapping files merged, a later TMDB match
//     reusing the announced row;
//   * the setup file, the definition editor, the Settings card (no request on entry), and format 7.
// Run from the repo root: node tests/collection-updates.test.js
const assert = require('assert');
const crypto = require('crypto');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('collection-updates');
const test = T.test;
const TS = '2026-10-01T00:00:00+00:00';
let n = 0;
const uuid = p => `${p}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const out = v => JSON.parse(JSON.stringify(v));
const text = html => String(html).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/’/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

const showOf = (o = {}) => ({ id: uuid('5a000000'), collection: 'othertv', title: 'Show', show_key: 'show', tmdb_id: null, status: 'confirmed', created_at: TS, ...o });
const seasonOf = (sh, num, o = {}) => ({ id: uuid('5b000000'), collection: sh.collection, title: sh.title, theme: 'Net', status: 'confirmed', watched: false, skipped: false,
  show_id: sh.id, media_type: sh.tmdb_id != null ? 'tv' : null, tmdb_id: sh.tmdb_id, season_number: sh.tmdb_id != null ? num : null, season: `Season ${num}`,
  display_date: 'Jan 1, 2020', date_sort: '2020-01-01', item_key: `${sh.show_key}|season ${num}`, watch_with: [], collections: [], created_at: TS,
  tmdb_collection_id: null, tmdb_collection_name: null, ...o });
const memoryStorage = () => { const map = new Map(); return { map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) }; };
// TMDB: details by id, season details (episode lists), searches.
function tmdbOf({ shows = {}, lists = {}, search = {}, fail = () => false } = {}) {
  return p => {
    if (fail(p)) return { __status: 500 };
    const m = /^\/tv\/(\d+)$/.exec(p);
    if (m) return shows[m[1]] ? { id: +m[1], networks: [{ id: 1, name: 'Net' }], created_by: [], ...shows[m[1]] } : undefined;
    const sn = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(p);
    if (sn) return lists[`${sn[1]}/${sn[2]}`] ? { season_number: +sn[2], episodes: lists[`${sn[1]}/${sn[2]}`] } : { __status: 404 };
    const s = /^\/search\/tv\?query=(.*)$/.exec(p);
    if (s) return { results: search[decodeURIComponent(s[1])] || [] };
    return undefined;
  };
}
async function refresh(app) {
  app.ctx.switchView('alltv'); await settle();
  app.ctx.openLibraryPanel('tv', 'refresh'); await settle();
  await app.ctx.cuRefreshShows(); await settle();
  return text(app.el('tmdbPreview').innerHTML);
}
const rpcs = (app, name) => app.writes().filter(r => r.url.endsWith(`/rpc/${name}`));
const finding = (app, pred) => app.store.update_findings.find(pred);
const EPS = (...ids) => ids.map((id, i) => ({ id, episode_number: i + 1, name: `Ep ${i + 1}` }));

// ═══ Refresh shows ═══════════════════════════════════════════════════════════
test('library-wide: catalog and collection shows are checked; Skipped shows aren’t unless followed; coverage says TMDB only', async () => {
  const cat = showOf({ collection: 'disney', title: 'Cat', show_key: 'cat', tmdb_id: 10 });
  const own = showOf({ title: 'Own', show_key: 'own', tmdb_id: 20 });
  const skip = showOf({ title: 'Skip', show_key: 'skip', tmdb_id: 30, status: 'skipped' });
  const app = await createApp({ rows: [seasonOf(cat, 1), seasonOf(own, 1), seasonOf(skip, 1)], tvShows: [cat, own, skip],
    tmdb: tmdbOf({ shows: { 10: { seasons: [{ season_number: 1 }] }, 20: { seasons: [{ season_number: 1 }] }, 30: { seasons: [{ season_number: 1 }, { season_number: 2, air_date: '2027-01-01', episode_count: 6 }] } } }) });
  const t = await refresh(app);
  assert.match(t, /TMDB only: announcements weren't checked\. Checked 2 shows \(2 matched to TMDB, 0 not yet matched\); 1 Skipped show not checked\./);
  assert.ok(!app.requests.some(r => r.url.includes('/tv/30')), 'the Skipped show isn’t looked up');
  app.store.show_update_settings.push({ id: uuid('0f2c0000'), show_id: skip.id, follow_when_skipped: true, new_season_after_ended_at: null, updated_at: TS });
  const t2 = await refresh(app);
  assert.match(t2, /Checked 3 shows/);
  assert.match(t2, /Skip · Season 2: added/);
  assert.strictEqual(app.store.tv_shows.find(s => s.id === skip.id).status, 'skipped', 'following doesn’t change the status');
});

test('setup gate: a catalog show’s new season waits for the collection setup (review); a show no catalog governs is updated', async () => {
  const cat = showOf({ collection: 'disney', title: 'Cat', show_key: 'cat', tmdb_id: 10 });
  const own = showOf({ title: 'Own', show_key: 'own', tmdb_id: 20 });
  const app = await createApp({ rows: [seasonOf(cat, 1), seasonOf(own, 1)], tvShows: [cat, own],
    tmdb: tmdbOf({ shows: { 10: { seasons: [{ season_number: 1 }, { season_number: 2, air_date: '2027-02-01', episode_count: 8 }] },
      20: { seasons: [{ season_number: 1 }, { season_number: 2, air_date: '2027-03-01', episode_count: 8 }] } } }) });
  const t = await refresh(app);
  assert.match(t, /Own · Season 2: added/);
  assert.match(t, /Needs your review \(1\)[\s\S]*Cat · Season 2: automatic updates for catalog shows wait for the collection setup/);
  assert.ok(!app.store.watchlist_items.some(r => r.show_id === cat.id && r.season_number === 2));
  assert.strictEqual(finding(app, f => f.show_id === cat.id).status, 'pending');
  app.store.update_setup.push({ id: uuid('0f2c0000'), setup_confirmed_at: TS, source: 'setup_file' });
  // The same finding is still pending: a review decision applies it; a later check finds it waiting.
  const t2 = await refresh(app);
  assert.match(t2, /Cat · Season 2: (added|waits for your decision|automatic updates for catalog shows wait)/);
});

test('reconciliation: an announced "Season N" row is reused and mapped (no duplicate); a "Season N (Final)" row sends it to review; an undated empty season waits for evidence', async () => {
  const sh = showOf({ title: 'Rec', show_key: 'rec', tmdb_id: 40 });
  const s3 = seasonOf(sh, 3, { media_type: null, tmdb_id: null, season_number: null, display_date: 'TBA', date_sort: '2099-01-01' });
  const s4 = seasonOf(sh, 4, { season: 'Season 4 (Final)', item_key: 'rec|season 4 (final)', media_type: null, tmdb_id: null, season_number: null, display_date: 'TBA', date_sort: '2099-01-01' });
  const app = await createApp({ rows: [seasonOf(sh, 1), seasonOf(sh, 2), s3, s4], tvShows: [sh],
    tmdb: tmdbOf({ shows: { 40: { seasons: [1, 2].map(n => ({ season_number: n })).concat([{ season_number: 3, air_date: '2027-04-01', episode_count: 8 },
      { season_number: 4, air_date: '2028-01-01', episode_count: 8 }, { season_number: 5, air_date: null, episode_count: 0 }]) } } }) });
  const t = await refresh(app);
  const row3 = app.store.watchlist_items.find(r => r.id === s3.id);
  assert.deepStrictEqual([row3.tmdb_id, row3.season_number, row3.season], [40, 3, 'Season 3'], 'the announced row is mapped');
  assert.strictEqual(app.store.watchlist_items.filter(r => r.show_id === sh.id && (r.season_number === 3 || r.season === 'Season 3')).length, 1, 'no duplicate');
  assert.match(t, /Rec · Season 3: matched to the season already on your list/);
  assert.match(t, /Rec · Season 4: a stored season may already be this one/);
  assert.match(t, /Rec · Season 5: TMDB lists it without a date or episodes/);
  assert.strictEqual(app.store.watchlist_items.filter(r => r.show_id === sh.id).length, 4, 'nothing created');
});

test('dates: a TBA season gets TMDB’s date; an exact future date TMDB disagrees with goes to review; an aired date isn’t re-checked; Ended is kept and the new season flagged', async () => {
  const sh = showOf({ title: 'Dated', show_key: 'dated', tmdb_id: 50, ended: true });
  const tba = seasonOf(sh, 2, { display_date: 'TBA', date_sort: '2099-01-01' });
  const fut = seasonOf(sh, 3, { display_date: 'Jan 1, 2028', date_sort: '2028-01-01' });
  const old = seasonOf(sh, 1, { display_date: 'Jan 1, 2020', date_sort: '2020-01-01' });
  const app = await createApp({ rows: [old, tba, fut], tvShows: [sh],
    tmdb: tmdbOf({ shows: { 50: { seasons: [{ season_number: 1, air_date: '2019-06-01' }, { season_number: 2, air_date: '2027-05-01' }, { season_number: 3, air_date: '2028-02-01' },
      { season_number: 4, air_date: '2029-01-01', episode_count: 10 }] } } }) });
  const t = await refresh(app);
  const row = id => app.store.watchlist_items.find(r => r.id === id);
  assert.strictEqual(row(tba.id).display_date, 'May 1, 2027');
  assert.strictEqual(row(fut.id).display_date, 'Jan 1, 2028', 'an exact future date isn’t overwritten by TMDB');
  assert.strictEqual(finding(app, f => f.season_id === fut.id).reason, 'tmdb_date_differs', 'it waits for review');
  assert.strictEqual(row(old.id).display_date, 'Jan 1, 2020', 'aired: not re-checked');
  assert.ok(!rpcs(app, 'library_cu_set_season_date').some(r => r.body.p_row_id === old.id), 'no request for the aired season');
  assert.match(t, /Dated · Season 4: added \(the show stays marked ended; flagged\)/);
  assert.strictEqual(app.store.tv_shows[0].ended, true);
  assert.ok(app.store.show_update_settings.some(s => s.show_id === sh.id && s.new_season_after_ended_at));
});

// Airing lifecycle (owner decision): a season's episode list is read on every Refresh unless TMDB's own evidence
// says the season has finished (Ended/Canceled with nothing scheduled, or an aired finale); a finished season
// is read only when this device has no full list. Watched and Skipped never decide it.
const EPT = (base, n, o = {}) => Array.from({ length: n }, (_, i) => ({ id: base + i, episode_number: i + 1, name: o.name ? o.name(i) : `Ep ${i + 1}`,
  air_date: o.air || '2020-01-0' + (i + 1), episode_type: i === n - 1 && o.last ? o.last : 'standard' }));
const seasonReads = (app, id) => app.requests.filter(r => new RegExp(`/tv/${id}/season/`).test(r.url)).map(r => +/season\/(\d+)/.exec(r.url)[1]).sort();
test('episode lists: an airing season is read even when its count is unchanged, and changed episode details replace the cache; marks untouched', async () => {
  const sh = showOf({ title: 'Airing', show_key: 'airing', tmdb_id: 60 });
  const s2 = seasonOf(sh, 2, { display_date: 'Oct 1, 2026', date_sort: '2026-10-01' });
  const storage = memoryStorage();
  const app = await createApp({ rows: [s2], tvShows: [sh], storage, episodeMarks: [{ id: uuid('0e100000'), season_id: s2.id, tmdb_episode_id: 601, episode_number: 1 }],
    tmdb: tmdbOf({ shows: { 60: { status: 'Returning Series', next_episode_to_air: { season_number: 2, episode_number: 3, air_date: '2099-01-01' },
      seasons: [{ season_number: 2, episode_count: 3 }] } }, lists: { '60/2': EPT(601, 3, { name: i => `Renamed ${i + 1}` }) } }) });
  app.run(`writeEpisodeListCache({ '60:2': { ids: [601, 602, 603], numbers: [1, 2, 3], names: ['Ep 1', 'Ep 2', 'Ep 3'] } })`);
  await refresh(app);
  assert.deepStrictEqual(seasonReads(app, 60), [2], 'read although the count is unchanged');
  assert.deepStrictEqual(out(app.get('readEpisodeListCache()'))['60:2'].names, ['Renamed 1', 'Renamed 2', 'Renamed 3'], 'the new titles are cached');
  assert.strictEqual(app.store.episode_marks.length, 1, 'marks untouched');
});

test('episode lists: a finished season (TMDB says Ended, nothing scheduled) is read only when this device has no full list; a stale count reads it again', async () => {
  const sh = showOf({ title: 'Done', show_key: 'done', tmdb_id: 61, ended: true });
  const s1 = seasonOf(sh, 1), s2 = seasonOf(sh, 2), s3 = seasonOf(sh, 3);
  const app = await createApp({ rows: [s1, s2, s3], tvShows: [sh], storage: memoryStorage(),
    tmdb: tmdbOf({ shows: { 61: { status: 'Ended', next_episode_to_air: null, seasons: [1, 2, 3].map(n => ({ season_number: n, episode_count: 2 })) } },
      lists: { '61/1': EPT(611, 2), '61/2': EPT(621, 2), '61/3': EPT(631, 2) } }) });
  // Season 1: a full list cached. Season 2: only a count. Season 3: a full list that no longer matches TMDB's count.
  app.run(`writeEpisodeListCache({ '61:1': { ids: [611, 612], numbers: [1, 2], names: ['', ''] }, '61:2': { count: 2 }, '61:3': { ids: [631], numbers: [1], names: [''] } })`);
  await refresh(app);
  assert.deepStrictEqual(seasonReads(app, 61), [2, 3], 'season 1 reuses its cached list');
  app.requests.length = 0;
  await refresh(app);
  assert.deepStrictEqual(seasonReads(app, 61), [], 'all three now have full lists: none is read again');
});

test('episode lists: an aired finale finishes a season; without TMDB evidence (no finale, all episodes aired, nothing scheduled) completion is uncertain and the season keeps being read', async () => {
  const sh = showOf({ title: 'Running', show_key: 'running', tmdb_id: 62 });
  const s1 = seasonOf(sh, 1), s2 = seasonOf(sh, 2), s3 = seasonOf(sh, 3, { display_date: 'TBA', date_sort: '2099-01-01' });
  const app = await createApp({ rows: [s1, s2, s3], tvShows: [sh], storage: memoryStorage(),
    tmdb: tmdbOf({ shows: { 62: { status: 'Returning Series', next_episode_to_air: null, seasons: [1, 2, 3].map(n => ({ season_number: n, episode_count: n === 3 ? 0 : 2 })) } },
      lists: { '62/1': EPT(641, 2, { last: 'finale' }), '62/2': EPT(651, 2), '62/3': [] } }) });
  await refresh(app);
  assert.deepStrictEqual(seasonReads(app, 62), [1, 2, 3], 'nothing cached: every season is read once');
  assert.deepStrictEqual(out(app.get('readEpisodeListCache()'))['62:1'].last, { type: 'finale', air: '2020-01-02' });
  app.requests.length = 0;
  await refresh(app);
  assert.deepStrictEqual(seasonReads(app, 62), [2, 3], 'season 1 (aired finale) is finished; season 2 (no finale, all aired) is uncertain; season 3 (upcoming) is read');
});

test('episode lists: once a later regular season has started airing, an earlier season counts as finished (an accepted inference): cached lists are reused, a missing list or a changed count is still read', async () => {
  const sh = showOf({ title: 'Long', show_key: 'long', tmdb_id: 65 });
  const s1 = seasonOf(sh, 1), s2 = seasonOf(sh, 2), s3 = seasonOf(sh, 3), s4 = seasonOf(sh, 4, { display_date: 'Oct 1, 2026', date_sort: '2026-10-01' });
  const app = await createApp({ rows: [s1, s2, s3, s4], tvShows: [sh], storage: memoryStorage(),
    tmdb: tmdbOf({ shows: { 65: { status: 'Returning Series', next_episode_to_air: { season_number: 4, episode_number: 3, air_date: '2099-01-01' },
      last_episode_to_air: { season_number: 4, episode_number: 2, air_date: '2026-10-08' },
      seasons: [1, 2, 3].map(n => ({ season_number: n, episode_count: 2, air_date: `202${n}-01-01` })).concat([{ season_number: 4, episode_count: 3, air_date: '2026-10-01' }]) } },
      lists: { '65/1': EPT(691, 2), '65/2': EPT(701, 2), '65/3': EPT(711, 2), '65/4': EPT(721, 3) } }) });
  // Season 1: cached, count unchanged (no finale tag). Season 2: nothing cached. Season 3: cached, but TMDB's count changed.
  app.run(`writeEpisodeListCache({ '65:1': { ids: [691, 692], numbers: [1, 2], names: ['', ''] }, '65:3': { ids: [711], numbers: [1], names: [''] } })`);
  await refresh(app);
  assert.deepStrictEqual(seasonReads(app, 65), [2, 3, 4], 'season 1 reused; season 2 (no list) and 3 (count changed) read; season 4 (airing) read');
  app.requests.length = 0;
  await refresh(app);
  assert.deepStrictEqual(seasonReads(app, 65), [4], 'only the airing season again');
});

test('episode lists: the later-season inference leaves Specials out, and the next scheduled episode keeps its season open', async () => {
  const app = await createApp({ rows: [], tvShows: [] });
  const cached = { ids: [1], last: { type: 'standard', air: '2020-01-01' } };
  const fin = (details, n) => app.get(`cuSeasonFinished(${JSON.stringify(details)}, ${n}, ${JSON.stringify(cached)}, '2026-10-23')`);
  const later = { status: 'Returning Series', seasons: [{ season_number: 0, air_date: '2026-01-01' }, { season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2026-05-01' }] };
  assert.strictEqual(fin(later, 1), true, 'season 2 has started: season 1 is finished');
  assert.strictEqual(fin(later, 0), false, 'Specials are never finished by a later season');
  assert.strictEqual(fin({ status: 'Returning Series', seasons: [{ season_number: 0, air_date: '2026-01-01' }, { season_number: 1, air_date: '2020-01-01' }] }, 1), false, 'Specials don’t count as a later season');
  assert.strictEqual(fin({ ...later, seasons: [{ season_number: 1, air_date: '2020-01-01' }, { season_number: 2, air_date: '2099-01-01' }] }, 1), false, 'a later season dated in the future hasn’t started');
  assert.strictEqual(fin({ status: 'Returning Series', seasons: [], last_episode_to_air: { season_number: 2 } }, 1), true, 'the last aired episode is in a later season');
  assert.strictEqual(fin({ ...later, next_episode_to_air: { season_number: 1 } }, 1), false, 'the next scheduled episode is in this season');
});

test('episode lists: Watched or Skipped on a season doesn’t change whether its list is read', async () => {
  const decide = async o => {
    const sh = showOf({ title: 'Same', show_key: 'same', tmdb_id: 63 });
    const s1 = seasonOf(sh, 1, o), s2 = seasonOf(sh, 2, o);
    const app = await createApp({ rows: [s1, s2], tvShows: [sh], storage: memoryStorage(),
      tmdb: tmdbOf({ shows: { 63: { status: 'Returning Series', next_episode_to_air: null, seasons: [1, 2].map(n => ({ season_number: n, episode_count: 2 })) } },
        lists: { '63/1': EPT(661, 2, { last: 'finale' }), '63/2': EPT(671, 2) } }) });
    app.run(`writeEpisodeListCache({ '63:1': { ids: [661, 662], numbers: [1, 2], names: ['', ''], last: { type: 'finale', air: '2020-01-02' } }, '63:2': { ids: [671, 672], numbers: [1, 2], names: ['', ''], last: { type: 'standard', air: '2020-01-02' } } })`);
    await refresh(app);
    return seasonReads(app, 63);
  };
  const unwatched = await decide({}), watched = await decide({ watched: true }), skipped = await decide({ skipped: true });
  assert.deepStrictEqual(unwatched, [2]);
  assert.deepStrictEqual(watched, unwatched);
  assert.deepStrictEqual(skipped, unwatched);
});

test('episode lists: opening a finished season’s list still reads TMDB fresh and keeps saved marks', async () => {
  const sh = showOf({ title: 'Open', show_key: 'open', tmdb_id: 64, status: 'watching' });
  const s1 = seasonOf(sh, 1);
  const app = await createApp({ rows: [s1], tvShows: [sh], storage: memoryStorage(), episodeMarks: [{ id: uuid('0e100000'), season_id: s1.id, tmdb_episode_id: 681, episode_number: 1 }],
    tmdb: tmdbOf({ shows: { 64: { status: 'Ended', seasons: [{ season_number: 1, episode_count: 2 }] } }, lists: { '64/1': EPT(681, 2, { last: 'finale', name: i => `Fixed ${i + 1}` }) } }) });
  app.run(`writeEpisodeListCache({ '64:1': { ids: [681, 682], numbers: [1, 2], names: ['Old 1', 'Old 2'], last: { type: 'finale', air: '2020-01-02' } } })`);
  app.ctx.switchView('alltv'); await settle();
  await app.ctx.loadEpisodeList(app.ctx.actionRows().find(r => r.id === s1.id)); await settle();
  assert.deepStrictEqual(seasonReads(app, 64), [1], 'opened: read fresh');
  assert.deepStrictEqual(out(app.get('readEpisodeListCache()'))['64:1'].names, ['Fixed 1', 'Fixed 2']);
  assert.deepStrictEqual(app.store.episode_marks.map(m => m.tmdb_episode_id), [681], 'marks unchanged');
  assert.ok(!app.writes().length, 'nothing written');
});

test('matching: an unmatched show is matched only when exactly one TMDB result has its title (or an evidenced alias), its year and an anchor; otherwise held for review', async () => {
  const a = showOf({ title: 'Solo', show_key: 'solo', network: 'Net' });
  const b = showOf({ title: 'Twin', show_key: 'twin', network: 'Net' });
  const c = showOf({ title: 'Working', show_key: 'working', network: 'Net' });
  const rows = [seasonOf(a, 1, { date_sort: '2026-05-01', display_date: 'May 1, 2026' }), seasonOf(b, 1, { date_sort: '2026-05-01', display_date: 'May 1, 2026' }),
    seasonOf(c, 1, { display_date: 'TBA 2027', date_sort: '2099-01-01' })];
  const app = await createApp({ rows, tvShows: [a, b, c], cu1: { record_aliases: [{ id: uuid('0f3c0000'), show_id: c.id, item_id: null, alias: 'Final', match_text: 'final', evidence: [], created_at: TS }] },
    tmdb: tmdbOf({ shows: { 701: { name: 'Solo', networks: [{ id: 1, name: 'Net' }], seasons: [{ season_number: 1 }] }, 703: { name: 'Final', networks: [{ id: 1, name: 'Net' }], seasons: [{ season_number: 1 }] } },
      search: { Solo: [{ id: 701, name: 'Solo', first_air_date: '2026-05-01' }], Twin: [{ id: 702, name: 'Twin', first_air_date: '2026-05-01' }, { id: 704, name: 'Twin', first_air_date: '2025-05-01' }],
        Working: [], Final: [{ id: 703, name: 'Final', first_air_date: '2027-03-01' }] } }) });
  const t = await refresh(app);
  const S = id => app.store.tv_shows.find(s => s.id === id);
  assert.strictEqual(S(a.id).tmdb_id, 701, 'one result with its title, year and network: matched');
  assert.strictEqual(app.store.watchlist_items.find(r => r.show_id === a.id).season_number, 1, 'its plain season mapped');
  assert.strictEqual(S(b.id).tmdb_id, null, 'two candidates: not matched');
  assert.match(t, /Twin: TMDB has a possible match/);
  assert.strictEqual(S(c.id).tmdb_id, 703, 'matched by its evidenced alias');
  assert.strictEqual(S(c.id).title, 'Working', 'the title is kept');
});

test('an unclear answer stops sending anything more; nothing is resent; what came before is reported', async () => {
  const x = showOf({ title: 'A', show_key: 'a', tmdb_id: 81 }), y = showOf({ title: 'B', show_key: 'b', tmdb_id: 82 });
  const app = await createApp({ rows: [seasonOf(x, 1), seasonOf(y, 1)], tvShows: [x, y],
    tmdb: tmdbOf({ shows: { 81: { seasons: [{ season_number: 1 }, { season_number: 2, air_date: '2027-01-01', episode_count: 5 }] }, 82: { seasons: [{ season_number: 1 }, { season_number: 2, air_date: '2027-01-01', episode_count: 5 }] } } }) });
  app.loseNext(r => r.url.endsWith('/rpc/library_cu_reconcile_season') && r.body.p_show_id === x.id, 'before');
  const t = await refresh(app);
  assert.strictEqual(rpcs(app, 'library_cu_reconcile_season').length, 1, 'nothing more after the unclear answer');
  assert.match(t, /no clear answer came back[\s\S]*Nothing more was sent/);
});

test('a parked TMDB finding is checked again: an undated season waits, then is added once TMDB lists its date; a Skipped show’s season is added once it is followed', async () => {
  const sh = showOf({ title: 'Later', show_key: 'later', tmdb_id: 95 });
  const sk = showOf({ title: 'Paused', show_key: 'paused', tmdb_id: 96, status: 'skipped' });
  const app = await createApp({ rows: [seasonOf(sh, 1), seasonOf(sk, 1)], tvShows: [sh, sk],
    cu1: { show_update_settings: [] },
    tmdb: tmdbOf({ shows: { 95: { seasons: [{ season_number: 1 }, { season_number: 2, air_date: null, episode_count: 0 }] }, 96: { seasons: [{ season_number: 1 }] } } }) });
  let t = await refresh(app);
  assert.match(t, /Later · Season 2: TMDB lists it without a date or episodes/);
  app.setTmdb(tmdbOf({ shows: { 95: { seasons: [{ season_number: 1 }, { season_number: 2, air_date: '2027-08-01', episode_count: 10 }] },
    96: { seasons: [{ season_number: 1 }, { season_number: 2, air_date: '2027-09-01', episode_count: 6 }] } } }));
  t = await refresh(app);
  assert.match(t, /Later · Season 2: added/, 'the same finding, checked again with what TMDB says now');
  assert.strictEqual(app.store.update_findings.filter(f => f.show_id === sh.id).length, 1, 'one finding, not a second');
  // The Skipped show isn't checked; once followed, its season is added.
  app.store.show_update_settings.push({ id: uuid('0f2c0000'), show_id: sk.id, follow_when_skipped: true, new_season_after_ended_at: null, updated_at: TS });
  t = await refresh(app);
  assert.match(t, /Paused · Season 2: added/);
});

test('import: a new season that names a film (not a show) is refused before anything is recorded', async () => {
  const film = { id: uuid('f0000000'), collection: 'movies', title: 'ZZ Film', theme: 'Drama', status: 'confirmed', watched: false, skipped: false, show_id: null,
    media_type: 'movie', tmdb_id: 931, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01', item_key: 'zz film|film',
    watch_with: [], collections: [], created_at: TS, tmdb_collection_id: null, tmdb_collection_name: null };
  const coll = { id: uuid('0c100000'), name: 'ZZ Films', legacy_source: null, sort_order: 9, archived_at: null, created_at: TS };
  const app = await createApp({ rows: [film], personalCollections: [coll], memberships: [{ id: uuid('0d100000'), collection_id: coll.id, show_id: null, item_id: film.id, created_at: TS }] });
  await app.run(`runWrite('d', () => sbRpc('library_cu_save_definition', { p_collection_id: ${JSON.stringify(coll.id)}, p_expected_version: 0, p_mode: 'follow',
    p_rules: [], p_evidence: ${JSON.stringify({ standard: 'official_or_two_trades', official_domains: ['press.example.org'], trades: [] })}, p_summary: 'x' }))`);
  let brief; app.ctx.downloadJSON = o => { brief = JSON.parse(JSON.stringify(o)); };
  await app.ctx.cuDownloadBrief([coll.id]); await settle();
  const res = await app.ctx.cuImportFindings(JSON.stringify({ format: 'watchlist-research-findings', version: 1, brief_id: brief.brief_id, coverage: [], findings: [
    { kind: 'new_season', collection_id: coll.id, ref: `rec:item:${film.id}`, subject: { title: 'ZZ Film', season_number: 2 },
      evidence: [{ url: 'https://press.example.org/f', source_type: 'official', published_on: '2026-10-10', excerpt: 'x' }],
      assessment: { standard: 'official', researched_on: '2026-10-20', conflict: false } }] })); await settle();
  assert.match(Array.from(res.problems).join(' '), /Finding 1 \(a new season\) doesn’t name a show/);
  assert.strictEqual(app.store.research_imports.length, 0, 'nothing recorded');
});

// ═══ Review ══════════════════════════════════════════════════════════════════
test('review: the ambiguous season’s row is chosen; a date is applied; Not now and Exclude are recorded; New season flags are cleared', async () => {
  const sh = showOf({ title: 'Rev', show_key: 'rev', tmdb_id: 90, ended: true });
  const fin = seasonOf(sh, 2, { season: 'Season 2 (Final)', item_key: 'rev|season 2 (final)', media_type: null, tmdb_id: null, season_number: null, display_date: 'TBA', date_sort: '2099-01-01' });
  const aired = seasonOf(sh, 1);
  const app = await createApp({ rows: [aired, fin], tvShows: [sh], tmdb: tmdbOf({ shows: { 90: { seasons: [{ season_number: 1 }, { season_number: 2, air_date: '2027-06-01', episode_count: 8 }] } } }),
    cu1: { show_update_settings: [{ id: uuid('0f2c0000'), show_id: sh.id, follow_when_skipped: false, new_season_after_ended_at: TS, updated_at: TS }] } });
  await refresh(app);
  await app.ctx.openCuReview(null); await settle();
  let box = app.el('cuModalBox').innerHTML;
  assert.match(text(box), /Rev: Season 2 \(Jun 1, 2027\)[\s\S]*a stored season may already be this one/);
  const f = finding(app, x => x.kind === 'new_season');
  assert.ok(box.includes(`cuReviewSeason('${f.id}', '${fin.id}')`));
  await app.ctx.cuReviewSeason(f.id, fin.id); await settle();
  const r = app.store.watchlist_items.find(x => x.id === fin.id);
  assert.deepStrictEqual([r.tmdb_id, r.season_number, r.season], [90, 2, 'Season 2 (Final)'], 'mapped, the label kept');
  assert.strictEqual(f.status, 'applied');
  // A date change on an aired season: TMDB findings for aired dates aren't made by Refresh; one by hand through the function.
  await app.run(`runWrite('x', () => sbRpc('library_cu_set_season_date', { p_row_id: ${JSON.stringify(aired.id)}, p_expected: { display_date: 'Jan 1, 2020', date_sort: '2020-01-01' },
    p_new: { display_date: 'Feb 2, 2020', date_sort: '2020-02-02' }, p_finding: { source: 'tmdb', kind: 'date', fingerprint: 'date:${'e'.repeat(64)}', show_id: ${JSON.stringify(sh.id)},
    season_id: ${JSON.stringify(aired.id)}, subject: { title: 'Rev', season: 'Season 1' }, proposed: { display_date: 'Feb 2, 2020', date_sort: '2020-02-02' } }, p_review: false }))`); await settle();
  await app.ctx.openCuReview(null); await settle();
  const d = finding(app, x => x.kind === 'date');
  assert.strictEqual(d.reason, 'tmdb_date_differs');
  await app.ctx.cuReviewDate(d.id); await settle();
  assert.strictEqual(app.store.watchlist_items.find(x => x.id === aired.id).display_date, 'Feb 2, 2020');
  box = app.el('cuModalBox').innerHTML;
  assert.ok(box.includes(`cuClearEndedFlag('${sh.id}')`));
  await app.ctx.cuClearEndedFlag(sh.id); await settle();
  assert.strictEqual(app.store.show_update_settings[0].new_season_after_ended_at, null);
});

// ═══ Date equivalence (CU1c): within a day is the same date; TMDB doesn't overwrite an exact date ═══
const displayOf = iso => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}`;
const isoPlus = (iso, days) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + days)).toISOString().slice(0, 10);
async function datesApp(pairs, o = {}) {
  // pairs: [stored display, stored sort, TMDB air date (or null)] for seasons 1..n of one matched show.
  const sh = showOf({ title: 'Eq', show_key: 'eq', tmdb_id: 77 });
  const rows = pairs.map(([d, ds], i) => seasonOf(sh, i + 1, { display_date: d, date_sort: ds }));
  const app = await createApp({ rows, tvShows: [sh], ...o,
    tmdb: tmdbOf({ shows: { 77: { seasons: pairs.map(([, , air], i) => ({ season_number: i + 1, episode_count: 0, ...(air ? { air_date: air } : {}) })) } } }) });
  return { app, sh, rows };
}
test('date equivalence: TMDB within a calendar day of an exact date (either way, across month, year and leap-day boundaries) changes nothing and sends nothing', async () => {
  const { app, rows } = await datesApp([
    ['Mar 10, 2030', '2030-03-10', '2030-03-10'], ['Mar 10, 2030', '2030-03-10', '2030-03-11'], ['Mar 10, 2030', '2030-03-10', '2030-03-09'],
    ['Jan 31, 2030', '2030-01-31', '2030-02-01'], ['Dec 31, 2030', '2030-12-31', '2031-01-01'], ['Feb 29, 2032', '2032-02-29', '2032-03-01'],
    ['Feb 28, 2031', '2031-02-28', '2031-03-01']]);
  const before = JSON.stringify(app.store.watchlist_items);
  await refresh(app);
  assert.strictEqual(rpcs(app, 'library_cu_set_season_date').length, 0, 'nothing sent for one-day differences');
  assert.strictEqual(JSON.stringify(app.store.watchlist_items), before);
  assert.strictEqual(app.store.update_findings.filter(f => f.kind === 'date').length, 0, 'no findings');
  assert.ok(rows.length === 7);
});

test('date equivalence: two or more days from TMDB go to review (a leap year counts Feb 29); a TBA or window is filled even when its guessed sort date is close; aired, today and undated are left alone', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { app, rows } = await datesApp([
    ['Feb 28, 2032', '2032-02-28', '2032-03-01'], // 2 days in a leap year
    ['TBA 2030', '2030-12-31', '2031-01-01'],   // a window: filled, its sort date never compared
    ['TBA', '2099-01-01', '2030-05-05'],         // TBA: filled
    [displayOf(today), today, isoPlus(today, 5)], // equal to today: treated as aired, not re-checked
    ['Jan 1, 2020', '2020-01-01', '2020-03-01'], // aired: not re-checked
    ['Jun 1, 2030', '2030-06-01', null]]);       // TMDB without a date: nothing
  const t = await refresh(app);
  const row = i => app.store.watchlist_items.find(r => r.id === rows[i].id);
  assert.strictEqual(row(0).display_date, 'Feb 28, 2032', 'not overwritten');
  assert.strictEqual(finding(app, f => f.season_id === rows[0].id).reason, 'tmdb_date_differs');
  assert.match(t, /Needs your review \(1\)[\s\S]*Eq · Season 1: TMDB lists a date two or more days from yours/);
  assert.deepStrictEqual([row(1).display_date, row(2).display_date], ['Jan 1, 2031', 'May 5, 2030'], 'window and TBA filled');
  assert.deepStrictEqual([row(3).display_date, row(4).display_date, row(5).display_date], [displayOf(today), 'Jan 1, 2020', 'Jun 1, 2030']);
  const sent = rpcs(app, 'library_cu_set_season_date').map(r => r.body.p_row_id);
  assert.ok(![rows[3].id, rows[4].id, rows[5].id].some(id => sent.includes(id)), 'today, aired and undated: nothing sent');
  // Review: Apply takes TMDB's date only on the owner's decision.
  await app.ctx.openCuReview(null); await settle();
  const f = finding(app, x => x.season_id === rows[0].id);
  assert.ok(app.el('cuModalBox').innerHTML.includes(`cuReviewDate('${f.id}')`));
  await app.ctx.cuReviewDate(f.id); await settle();
  assert.strictEqual(row(0).display_date, 'Mar 1, 2032');
});

function dateFinding(row, sh, proposed, o = {}) {
  return { id: uuid('0f7c0000'), fingerprint: 'date:' + (o.fp || 'a').repeat(64), source: o.source || 'tmdb', kind: 'date', status: 'pending', reason: o.reason || '', collection_id: o.collection_id || null,
    show_id: sh.id, item_id: null, season_id: row.id, subject: { title: sh.title, season: row.season }, proposed, expected: { display_date: row.display_date, date_sort: row.date_sort },
    evidence: [], assessment: {}, rule_id: null, definition_version: null, rule_hash: null, evidence_hash: null, brief_id: null, first_seen_at: TS, last_seen_at: TS, decided_at: null, applied_at: null, result: null };
}
test('date equivalence: an existing pending one-day finding stops being actionable — review offers Keep your date, and the next Refresh resolves it (set aside, the stored date kept)', async () => {
  const sh = showOf({ title: 'Old', show_key: 'old', tmdb_id: 78 });
  const s1 = seasonOf(sh, 1, { display_date: 'Apr 4, 2030', date_sort: '2030-04-04' }), s2 = seasonOf(sh, 2, { display_date: 'May 4, 2030', date_sort: '2030-05-04' });
  const f1 = dateFinding(s1, sh, { display_date: 'Apr 5, 2030', date_sort: '2030-04-05' }, { fp: 'b' });
  const f2 = dateFinding(s2, sh, { display_date: 'May 3, 2030', date_sort: '2030-05-03' }, { fp: 'c' });
  const app = await createApp({ rows: [s1, s2], tvShows: [sh], cu1: { update_findings: [f1, f2] },
    tmdb: tmdbOf({ shows: { 78: { seasons: [{ season_number: 1, air_date: '2030-04-05' }, { season_number: 2, air_date: '2030-05-03' }] } } }) });
  app.ctx.openSettings(null); await settle();
  await app.ctx.openCuReview(null); await settle();
  let html = app.el('cuModalBox').innerHTML;
  assert.ok(html.includes(`cuKeepDate('${f1.id}')`) && !html.includes(`cuReviewDate('${f1.id}')`), 'no Apply for a one-day finding');
  await app.ctx.cuKeepDate(f1.id); await settle();
  const g1 = app.store.update_findings.find(f => f.id === f1.id);
  assert.deepStrictEqual([g1.status, g1.reason, g1.decided_at], ['set_aside', 'same_date_within_one_day', null], 'resolved by the rule, not dismissed by the owner');
  app.ctx.closeCuModal();
  const t = await refresh(app);
  const g2 = app.store.update_findings.find(f => f.id === f2.id);
  assert.deepStrictEqual([g2.status, g2.reason], ['set_aside', 'same_date_within_one_day'], 'the next Refresh resolves the other');
  assert.match(t, /Old · Season 2: not applied — the same date within a day; your stored date stays/);
  assert.deepStrictEqual([s1, s2].map(r => app.store.watchlist_items.find(x => x.id === r.id).display_date), ['Apr 4, 2030', 'May 4, 2030']);
  const again = await refresh(app);
  assert.ok(!/same date within a day/.test(again), 'not repeated');
  assert.strictEqual(app.store.update_findings.length, 2, 'no new findings');
});

test('date equivalence: repeated checks keep one finding; Dismiss stops that disagreement; a genuinely different later date is proposed again', async () => {
  const { app, rows } = await datesApp([['Jul 1, 2030', '2030-07-01', '2030-07-10']]);
  app.ctx.openSettings(null); await settle();
  await refresh(app); await refresh(app);
  assert.strictEqual(app.store.update_findings.filter(f => f.kind === 'date').length, 1, 'one finding');
  const f = finding(app, x => x.kind === 'date');
  await app.ctx.openCuReview(null); await settle();
  await app.ctx.cuDecide(f.id, 'dismissed'); await settle(); app.ctx.closeCuModal();
  let t = await refresh(app);
  assert.match(t, /Needs your review \(0\)/, 'the dismissed disagreement isn’t proposed again');
  app.setTmdb(tmdbOf({ shows: { 77: { seasons: [{ season_number: 1, episode_count: 0, air_date: '2030-07-20' }] } } }));
  t = await refresh(app);
  assert.match(t, /Needs your review \(1\)[\s\S]*Eq · Season 1/, 'a new TMDB date is a new proposal');
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === rows[0].id).display_date, 'Jul 1, 2030');
});

test('date equivalence: a direct TMDB call (an older page) can’t overwrite an exact date; review can apply two or more days; one day is kept even on review', async () => {
  const { app, sh, rows } = await datesApp([['Aug 1, 2030', '2030-08-01', null]]);
  const call = (p_new, p_review, fp) => app.run(`runWrite('x', () => sbRpc('library_cu_set_season_date', { p_row_id: ${JSON.stringify(rows[0].id)},
    p_expected: { display_date: 'Aug 1, 2030', date_sort: '2030-08-01' }, p_new: ${JSON.stringify(p_new)}, p_finding: { source: 'tmdb', kind: 'date', fingerprint: 'date:${'d'.repeat(64)}'.slice(0, 5) + '${fp}'.repeat(64),
    show_id: ${JSON.stringify(sh.id)}, season_id: ${JSON.stringify(rows[0].id)}, subject: {}, proposed: ${JSON.stringify(p_new)} }, p_review: ${p_review} })).then(r => r, e => ({ error: String(e.message) }))`);
  const r1 = await call({ display_date: 'Aug 9, 2030', date_sort: '2030-08-09' }, false, 'e');
  assert.deepStrictEqual([r1.outcome, r1.status, r1.reason], ['policy', 'pending', 'tmdb_date_differs']);
  assert.strictEqual(rows[0].display_date, 'Aug 1, 2030');
  const r2 = await call({ display_date: 'Aug 2, 2030', date_sort: '2030-08-02' }, true, 'f');
  assert.deepStrictEqual([r2.status, r2.reason], ['set_aside', 'same_date_within_one_day'], 'one day: kept, even on review');
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === rows[0].id).display_date, 'Aug 1, 2030');
});

test('date equivalence, research: one day is set aside (stored date kept); two or more days on a future date apply under the evidence rules; aired dates and protected values keep their safeguards', async () => {
  const { app, coll, live, tba } = await researchLibrary();
  // Give Live three dated seasons: future, future (protected), aired.
  const futA = seasonOf(live, 3, { display_date: 'Sep 10, 2030', date_sort: '2030-09-10' });
  const futB = seasonOf(live, 4, { display_date: 'Oct 10, 2030', date_sort: '2030-10-10' });
  const aired = seasonOf(live, 5, { display_date: 'Jan 5, 2021', date_sort: '2021-01-05' });
  app.store.watchlist_items.push(futA, futB, aired);
  app.store.update_holds.push({ id: uuid('0f6c0000'), kind: 'protected_value', collection_id: null, show_id: null, item_id: futB.id, subject_label: null, field: 'display_date',
    protected_value: 'Oct 10, 2030', decision: 'keep', effect: 'keep_value', reopen: { on: 'new_evidence' }, decided_on: null, created_at: TS });
  const other = JSON.stringify(app.store.tv_shows) + JSON.stringify(app.store.collection_memberships);
  const b = await briefOf(app, [coll.id]);
  const dateF = (row, display, sort) => ({ kind: 'date', collection_id: coll.id, ref: `rec:season:${row.id}`, subject: { title: 'Live', season: row.season },
    proposed: { display_date: display, date_sort: sort }, expected: { display_date: row.display_date, date_sort: row.date_sort },
    evidence: [official(`https://press.example.org/${row.id}`)], assessment: assessed() });
  const { text: t } = await importFile(app, { format: 'watchlist-research-findings', version: 1, brief_id: b.brief_id, coverage: [], findings: [
    dateF(tba, 'Jun 5, 2027', '2027-06-05'),          // window → exact: applied
    dateF(futA, 'Sep 11, 2030', '2030-09-11'),        // one day: kept
    dateF(futB, 'Oct 20, 2030', '2030-10-20'),        // protected: waits
    dateF(aired, 'Jan 9, 2021', '2021-01-09')] });    // aired: waits
  const row = r => app.store.watchlist_items.find(x => x.id === r.id).display_date;
  assert.deepStrictEqual([row(tba), row(futA), row(futB), row(aired)], ['Jun 5, 2027', 'Sep 10, 2030', 'Oct 10, 2030', 'Jan 5, 2021']);
  assert.match(t, /Live · Season 3: not applied — the same date within a day; your stored date stays/);
  assert.match(t, /Needs your review[\s\S]*this date is protected[\s\S]*already aired/);
  const fA = finding(app, f => f.season_id === futA.id);
  assert.deepStrictEqual([fA.status, fA.reason], ['set_aside', 'same_date_within_one_day']);
  // Two or more days on a future exact date: applied automatically under the evidence rules.
  const b2 = await briefOf(app, [coll.id]);
  await importFile(app, { format: 'watchlist-research-findings', version: 1, brief_id: b2.brief_id, coverage: [], findings: [dateF({ ...futA, display_date: 'Sep 10, 2030', date_sort: '2030-09-10' }, 'Sep 20, 2030', '2030-09-20')] });
  assert.strictEqual(row(futA), 'Sep 20, 2030');
  assert.strictEqual(JSON.stringify(app.store.tv_shows) + JSON.stringify(app.store.collection_memberships), other, 'unrelated data unchanged');
});

// ═══ The research round trip ═════════════════════════════════════════════════
const EVIDENCE = { standard: 'official_or_two_trades', official_domains: ['press.example.org'],
  trades: [{ id: 'trade_a', name: 'Trade A', domains: ['trade-a.example'] }, { id: 'trade_b', name: 'Trade B', domains: ['trade-b.example'] }] };
const RULES = [{ id: 'person', type: 'person_role', person: 'ZZ Person X', series_roles: ['creator'], film_roles: ['director'], announced: true }];
const official = (url = 'https://press.example.org/a', day = '2026-10-10') => ({ url, publisher: 'Press', outlet: 'official', source_type: 'official', published_on: day, excerpt: 'Announced.' });
const assessed = (o = {}) => ({ standard: 'official', researched_on: '2026-10-20', conflict: false, independence: 'one official release', ...o });
async function researchLibrary() {
  const ended = showOf({ title: 'Old Hit', show_key: 'old hit', tmdb_id: 110, ended: true });
  const live = showOf({ title: 'Live', show_key: 'live', tmdb_id: 111 });
  const skipped = showOf({ title: 'Dropped', show_key: 'dropped', tmdb_id: 112, status: 'skipped' });
  const tba = seasonOf(live, 2, { display_date: 'TBA 2027', date_sort: '2027-06-01' });
  const rows = [seasonOf(ended, 1), seasonOf(live, 1), tba, seasonOf(skipped, 1)];
  const coll = { id: uuid('0c100000'), name: 'ZZ Person X', legacy_source: null, sort_order: 9, archived_at: null, created_at: TS };
  const app = await createApp({ rows, tvShows: [ended, live, skipped],
    personalCollections: [coll], memberships: [ended, live, skipped].map(s => ({ id: uuid('0d100000'), collection_id: coll.id, show_id: s.id, item_id: null, created_at: TS })) });
  await app.run(`runWrite('d', () => sbRpc('library_cu_save_definition', { p_collection_id: ${JSON.stringify(coll.id)}, p_expected_version: 0, p_mode: 'discover',
    p_rules: ${JSON.stringify(RULES)}, p_evidence: ${JSON.stringify(EVIDENCE)}, p_summary: 'x' }))`);
  return { app, coll, ended, live, skipped, tba };
}
async function briefOf(app, collIds) {
  let brief = null;
  app.ctx.downloadJSON = obj => { brief = JSON.parse(JSON.stringify(obj)); };
  await app.ctx.cuDownloadBrief(collIds); await settle();
  return brief;
}
async function importFile(app, doc) {
  const res = await app.ctx.cuImportFindings(JSON.stringify(doc)); await settle();
  return res.problems ? { problems: Array.from(res.problems) } : { results: res.results, text: text(app.ctx.cuResultsHtml(res.results)) };
}

test('the brief: the version and hashes the database recorded, rules, evidence settings, exclusions, holds, items with required checks (Ended included; Skipped none)', async () => {
  const { app, coll, ended, live, skipped, tba } = await researchLibrary();
  await app.run(`runWrite('h', () => sbRpc('library_cu_save_hold', { p_hold: { kind: 'standing_decision', show_id: ${JSON.stringify(live.id)}, subject_label: 'Season 2',
    decision: 'Keep TBA 2027', effect: 'keep_value', reopen: { on: 'official_date_or_window' }, decided_on: '2026-09-28' } }))`);
  await app.run(`runWrite('e', () => sbRpc('library_cu_set_exclusion', { p_collection_id: ${JSON.stringify(coll.id)}, p_op: 'add', p_exclusion: { kind: 'every_version', title: 'ZZ Talk' } }))`);
  const b = await briefOf(app, [coll.id]);
  assert.strictEqual(b.format, 'watchlist-research-brief');
  assert.strictEqual(app.store.research_briefs[0].id, b.brief_id, 'registered');
  const c = b.collections[0];
  assert.deepStrictEqual([c.mode, c.definition_version], ['discover', 1]);
  assert.deepStrictEqual(out(c.rules), RULES);
  assert.deepStrictEqual(c.exclusions.map(e => [e.kind, e.title]), [['every_version', 'ZZ Talk']]);
  assert.deepStrictEqual(c.holds.map(h => [h.subject, h.subject_label, h.reopen.on]), [[`rec:show:${live.id}`, 'Season 2', 'official_date_or_window']]);
  const item = id => c.items.find(i => i.ref === `rec:show:${id}`);
  assert.deepStrictEqual(out(item(ended.id).required_checks), ['renewal'], 'an Ended show is checked for renewals');
  assert.strictEqual(item(ended.id).ended, true);
  assert.deepStrictEqual(out(item(skipped.id).required_checks), [], 'a Skipped show isn’t');
  assert.deepStrictEqual(out(item(live.id).seasons.find(s => s.ref === `rec:season:${tba.id}`).required_checks), ['dates', 'cancellation']);
});

test('import: structure and references checked; a brief this account didn’t export, and the same file twice, are refused; nothing changes', async () => {
  const { app, coll } = await researchLibrary();
  assert.match((await importFile(app, { format: 'nope' })).problems[0], /isn’t a Watchlist research findings file/);
  const b = await briefOf(app, [coll.id]);
  const bad = { format: 'watchlist-research-findings', version: 1, brief_id: b.brief_id, coverage: [], findings: [{ kind: 'new_show', collection_id: coll.id, subject: { title: 'X' }, evidence: [{ url: 'http://x' }], assessment: {} }] };
  const p = (await importFile(app, bad)).problems.join(' ');
  assert.match(p, /evidence 1: url, source_type, published_on and a short excerpt are required/);
  assert.match(p, /no complete assessment/);
  const stranger = { ...bad, brief_id: crypto.randomUUID(), findings: [] };
  assert.match((await importFile(app, stranger)).problems[0], /answers a brief this account didn’t export/);
  const ok = { format: 'watchlist-research-findings', version: 1, brief_id: b.brief_id, coverage: [], findings: [] };
  assert.ok((await importFile(app, ok)).results);
  assert.match((await importFile(app, ok)).problems[0], /already imported/);
  assert.strictEqual(app.store.research_imports.length, 1);
});

test('import: an Ended show’s official renewal adds "Season 2 · TBA" automatically (awaiting TMDB; Ended kept, flagged); a date with evidence is applied; insufficient evidence and conflicts wait; a failed check is listed', async () => {
  const { app, coll, ended, live, tba } = await researchLibrary();
  const b = await briefOf(app, [coll.id]);
  const doc = { format: 'watchlist-research-findings', version: 1, brief_id: b.brief_id, researched_at: '2026-10-20T10:00:00Z',
    coverage: [{ subject: `rec:show:${live.id}`, subject_title: 'Live', check: 'cancellation', status: 'failed', reason: 'the source didn’t load' }],
    findings: [
      { kind: 'new_season', collection_id: coll.id, ref: `rec:show:${ended.id}`, subject: { title: 'Old Hit', season_number: 2 }, proposed: { display_date: 'TBA', date_sort: '2099-01-01' },
        evidence: [official()], assessment: assessed() },
      { kind: 'date', collection_id: coll.id, ref: `rec:season:${tba.id}`, subject: { title: 'Live', season: 'Season 2' }, proposed: { display_date: 'Jun 5, 2027', date_sort: '2027-06-05' },
        expected: { display_date: 'TBA 2027', date_sort: '2027-06-01' }, evidence: [official('https://press.example.org/date')], assessment: assessed() },
      { kind: 'new_show', collection_id: coll.id, rule_id: 'person', subject: { title: 'ZZ Weak' }, evidence: [{ ...official(), url: 'https://trade-a.example/w', source_type: 'trade', outlet: 'trade_a' }],
        assessment: assessed({ standard: 'insufficient' }) },
      { kind: 'new_show', collection_id: coll.id, rule_id: 'person', subject: { title: 'ZZ Contested' }, evidence: [official('https://press.example.org/c')], assessment: assessed({ conflict: true }) }] };
  const { results, text: t } = await importFile(app, doc);
  const s2 = app.store.watchlist_items.find(r => r.show_id === ended.id && r.season === 'Season 2');
  assert.ok(s2 && s2.tmdb_id === null && s2.display_date === 'TBA', 'created unidentified: awaiting TMDB');
  assert.strictEqual(app.store.tv_shows.find(s => s.id === ended.id).ended, true);
  assert.ok(app.store.show_update_settings.some(x => x.show_id === ended.id && x.new_season_after_ended_at), 'flagged');
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === tba.id).display_date, 'Jun 5, 2027', 'TBA window → the confirmed date');
  assert.match(t, /From the imported research file: 4 findings\. Evidence was assessed in Claude research/);
  assert.match(t, /Waiting for more research \(2\) Blocked by the evidence standard: they can't be applied or added from review\.[\s\S]*New show: ZZ Weak: the evidence doesn't meet the standard[\s\S]*New show: ZZ Contested: the sources conflict/);
  assert.ok(!/Needs your review \(\d+\)[^W]*ZZ Weak/.test(t), 'blocked findings aren’t listed as waiting for a decision');
  await app.ctx.openCuReview(null); await settle();
  const box = text(app.el('cuModalBox').innerHTML);
  assert.match(box, /Waiting for more research \(2\) Blocked by the evidence standard[\s\S]*ZZ Weak[\s\S]*ZZ Contested/);
  const weak = finding(app, f => f.subject.title === 'ZZ Weak');
  const html = app.el('cuModalBox').innerHTML, li = html.slice(html.indexOf(`data-finding="${weak.id}"`), html.indexOf('</li>', html.indexOf(`data-finding="${weak.id}"`)));
  assert.ok(/Not now/.test(li) && /Dismiss/.test(li) && !/cuAccept|Add|Apply/.test(li), 'a blocked finding offers only Not now and Dismiss');
  assert.match(t, /Live \(cancellation\): couldn't be checked — the source didn't load/);
  assert.strictEqual(finding(app, f => f.subject.title === 'ZZ Weak').status, 'needs_evidence');
  assert.strictEqual(finding(app, f => f.subject.title === 'ZZ Contested').status, 'conflict');
  assert.ok(results);
  // Coverage: the file reported one check (failed); every other check the brief asked for is named as not reported.
  assert.match(t, /Coverage: 0 of 1 reported check completed; 5 the brief asked for aren't reported\./);
  for (const want of ['Old Hit (renewal)', 'Live (renewal)', 'Live · Season 2 (dates)', 'Live · Season 2 (cancellation)', 'person (sweep)']) assert.ok(t.includes(`${want}: not in the research file's coverage`), want);
  assert.ok(!/Dropped \(renewal\)/.test(t), 'a Skipped show has no checks to report');
  // The same findings in another file: nothing is applied again or duplicated; the applied ones are counted.
  const rows = app.store.watchlist_items.length, found = app.store.update_findings.length;
  const again = await importFile(app, { ...doc, researched_at: '2026-10-21T10:00:00Z' });
  assert.match(again.text, /From the imported research file: 4 findings \(2 already applied or decided earlier, left as they are\)/);
  assert.match(again.text, /Automatic updates \(0\)/);
  assert.deepStrictEqual([app.store.watchlist_items.length, app.store.update_findings.length], [rows, found], 'no new rows or findings');
});

test('import coverage compares with the checks the brief exported (stored with it), not with today’s library', async () => {
  const { app, coll, ended, live, tba } = await researchLibrary();
  const b = await briefOf(app, [coll.id]);
  const exported = [[`rec:show:${ended.id}`, 'renewal'], [`rec:show:${live.id}`, 'renewal'], [`rec:season:${tba.id}`, 'dates'], [`rec:season:${tba.id}`, 'cancellation'], ['rule:person', 'sweep']];
  assert.deepStrictEqual(app.store.research_briefs[0].checks.map(c => [c.subject, c.check]).sort(), exported.slice().sort(), 'the brief’s checks are stored as exported');
  const fileChecks = b.collections[0].items.flatMap(i => i.required_checks.map(c => [i.ref, c]).concat((i.seasons || []).flatMap(x => x.required_checks.map(c => [x.ref, c]))));
  assert.deepStrictEqual(fileChecks.concat([['rule:person', 'sweep']]).sort(), exported.slice().sort(), 'the stored checks are the file’s');
  // After export: the TBA season gets an aired date (a rebuild would no longer ask for it) and a new show joins.
  app.store.watchlist_items.find(r => r.id === tba.id).display_date = 'Jan 1, 2020';
  app.store.watchlist_items.find(r => r.id === tba.id).date_sort = '2020-01-01';
  const later = showOf({ title: 'Later', show_key: 'later', tmdb_id: 113 });
  app.store.tv_shows.push(later);
  app.store.collection_memberships.push({ id: uuid('0d100000'), collection_id: coll.id, show_id: later.id, item_id: null, created_at: TS });
  const partial = exported.filter(([, c]) => c !== 'dates');
  const { text: t } = await importFile(app, { format: 'watchlist-research-findings', version: 1, brief_id: b.brief_id, findings: [],
    coverage: partial.map(([subject, check]) => ({ subject, subject_title: subject, check, status: 'checked' })) });
  assert.match(t, /Coverage: 4 of 4 reported checks completed; 1 the brief asked for isn't reported\./);
  assert.ok(t.includes("Live · Season 2 (dates): not in the research file's coverage"), 'the exported dates check is still expected');
  assert.ok(!/Later \(renewal\)/.test(t), 'a show added after export isn’t expected');
});

test('the brief’s checks are validated by the database: a malformed check refuses the brief', async () => {
  const { app, coll } = await researchLibrary();
  const r = await app.run(`runWrite('b', () => sbRpc('library_cu_register_brief', { p_id: crypto.randomUUID(), p_collections: [${JSON.stringify(coll.id)}], p_checks: [{ subject: 'rec:show:nope', check: 'renewal' }] })).then(() => 'ok', e => String(e && (e.message || e.code)))`);
  assert.match(String(r), /invalid_input|brief/);
  const blank = await app.run(`runWrite('b', () => sbRpc('library_cu_register_brief', { p_id: crypto.randomUUID(), p_collections: [${JSON.stringify(coll.id)}], p_checks: [{ subject: 'rec:show:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}', check: 'renewal', title: '  ' }] })).then(() => 'ok', e => String(e && (e.message || e.code)))`);
  assert.match(String(blank), /invalid_input|brief/, 'a blank title is refused, as the database refuses it');
  assert.strictEqual(app.store.research_briefs.length, 0);
});

test('import re-checks the current state: a collection switched to Manual sets findings aside; a changed rule sends new titles to fresh research; a label-only edit doesn’t', async () => {
  const { app, coll, live } = await researchLibrary();
  const b = await briefOf(app, [coll.id]);
  const save = (v, mode, rules) => app.run(`runWrite('d', () => sbRpc('library_cu_save_definition', { p_collection_id: ${JSON.stringify(coll.id)}, p_expected_version: ${v}, p_mode: '${mode}',
    p_rules: ${JSON.stringify(rules)}, p_evidence: ${JSON.stringify(EVIDENCE)}, p_summary: 'x' }))`);
  await save(1, 'discover', [{ ...RULES[0], label: 'Renamed only' }]);
  const doc = id => ({ format: 'watchlist-research-findings', version: 1, brief_id: b.brief_id, coverage: [], findings: [
    { kind: 'new_show', collection_id: coll.id, rule_id: 'person', subject: { title: `ZZ New ${id}` }, evidence: [official(`https://press.example.org/${id}`)], assessment: assessed() }] });
  const r1 = await importFile(app, doc('a'));
  assert.match(r1.text, /New show: ZZ New a: waits for your decision/, 'a label-only edit: still current');
  await save(2, 'discover', [{ ...RULES[0], series_roles: ['creator', 'co_creator'] }]);
  const r2 = await importFile(app, doc('b'));
  assert.match(r2.text, /ZZ New b: the collection's rule changed since it was researched, so it needs fresh research/);
  assert.strictEqual(finding(app, f => f.subject.title === 'ZZ New b').status, 'needs_research');
  await save(3, 'manual', RULES);
  const r3 = await importFile(app, { format: 'watchlist-research-findings', version: 1, brief_id: b.brief_id, coverage: [], findings: [
    { kind: 'new_season', collection_id: coll.id, ref: `rec:show:${live.id}`, subject: { title: 'Live', season_number: 3 }, evidence: [official('https://press.example.org/m')], assessment: assessed() }] });
  assert.match(r3.text, /not applied — the collection is now Manual/);
  assert.ok(!app.store.watchlist_items.some(r => r.show_id === live.id && r.season === 'Season 3'));
});

test('acceptance: Add creates the show with "Season 1 · TBA" and its membership; a later file’s retitle adds an alias; Refresh then matches it by the final title and maps the announced row', async () => {
  const { app, coll } = await researchLibrary();
  const b = await briefOf(app, [coll.id]);
  await importFile(app, { format: 'watchlist-research-findings', version: 1, brief_id: b.brief_id, coverage: [], findings: [
    { kind: 'new_show', collection_id: coll.id, rule_id: 'person', subject: { title: 'ZZ Working', anchors: { network: 'Net', people: [{ name: 'ZZ Person X', role: 'creator' }] } },
      evidence: [official('https://press.example.org/w')], assessment: assessed() }] });
  await app.ctx.openCuReview(null); await settle();
  const f = finding(app, x => x.subject.title === 'ZZ Working');
  assert.ok(app.el('cuModalBox').innerHTML.includes(`cuAccept('${f.id}', 'create', null)`));
  await app.ctx.cuAccept(f.id, 'create', null); await settle();
  const show = app.store.tv_shows.find(s => s.title === 'ZZ Working');
  assert.ok(show && app.store.collection_memberships.some(m => m.collection_id === coll.id && m.show_id === show.id), 'created with its membership');
  const row = app.store.watchlist_items.find(r => r.show_id === show.id);
  assert.deepStrictEqual([row.season, row.display_date, row.tmdb_id], ['Season 1', 'TBA', null]);
  const b2 = await briefOf(app, [coll.id]);
  await importFile(app, { format: 'watchlist-research-findings', version: 1, brief_id: b2.brief_id, coverage: [], findings: [
    { kind: 'alias', collection_id: coll.id, ref: `rec:show:${show.id}`, subject: { title: 'ZZ Working' }, proposed: { alias: 'ZZ Final' }, evidence: [official('https://press.example.org/retitle')], assessment: assessed() }] });
  assert.ok(app.store.record_aliases.some(a => a.show_id === show.id && a.alias === 'ZZ Final'));
  assert.strictEqual(app.store.tv_shows.find(s => s.id === show.id).title, 'ZZ Working', 'the title is unchanged');
  // TMDB now lists the series under its final title: one result, the alias, no year on either side, the network agreeing.
  app.setTmdb(tmdbOf({ shows: { 777: { name: 'ZZ Final', networks: [{ id: 1, name: 'Net' }], created_by: [{ id: 5, name: 'ZZ Person X' }], seasons: [{ season_number: 1 }] },
    110: { seasons: [{ season_number: 1 }] }, 111: { seasons: [{ season_number: 1 }, { season_number: 2 }] } },
    search: { 'ZZ Working': [], 'ZZ Final': [{ id: 777, name: 'ZZ Final', first_air_date: '' }] } }));
  const t = await refresh(app);
  const matched = app.store.tv_shows.find(s => s.id === show.id);
  assert.deepStrictEqual([matched.tmdb_id, matched.title], [777, 'ZZ Working'], 'matched by the evidenced alias; the title kept');
  const r1 = app.store.watchlist_items.filter(r => r.show_id === show.id);
  assert.strictEqual(r1.length, 1, 'the announced row is reused, not duplicated');
  assert.deepStrictEqual([r1[0].tmdb_id, r1[0].season_number], [777, 1], 'its mapping is confirmed');
  assert.match(t, /ZZ Working: matched to TMDB/);
});

test('Same as a removed member asks before adding it back; Exclude records the exclusion and the finding never returns', async () => {
  const { app, coll, live } = await researchLibrary();
  const mem = app.store.collection_memberships.find(m => m.show_id === live.id);
  await app.run(`runWrite('r', () => sbRpc('org_remove_membership', { p_membership_id: ${JSON.stringify(mem.id)}, p_collection_id: ${JSON.stringify(coll.id)}, p_show_id: ${JSON.stringify(live.id)}, p_item_id: null }))`);
  assert.strictEqual(app.store.membership_removals.length, 1, 'the removal is remembered');
  const b = await briefOf(app, [coll.id]);
  await importFile(app, { format: 'watchlist-research-findings', version: 1, brief_id: b.brief_id, coverage: [], findings: [
    { kind: 'new_show', collection_id: coll.id, rule_id: 'person', subject: { title: 'Live' }, evidence: [official('https://press.example.org/l')], assessment: assessed() },
    { kind: 'new_show', collection_id: coll.id, rule_id: 'person', subject: { title: 'ZZ Talk Again' }, evidence: [official('https://press.example.org/t')], assessment: assessed() }] });
  await app.ctx.openCuReview(null); await settle();
  const f = finding(app, x => x.subject.title === 'Live');
  assert.ok(app.el('cuModalBox').innerHTML.includes(`cuAccept('${f.id}', 'same_as', '${live.id}')`), 'Same as is offered');
  app.dialogAnswer = 'cancel';
  await app.ctx.cuAccept(f.id, 'same_as', live.id); await settle();
  assert.ok(!app.store.collection_memberships.some(m => m.show_id === live.id && m.collection_id === coll.id), 'declined: not added back');
  app.dialogAnswer = 'confirm';
  await app.ctx.cuAccept(f.id, 'same_as', live.id); await settle();
  assert.ok(app.store.collection_memberships.some(m => m.show_id === live.id && m.collection_id === coll.id), 'added back on the owner’s choice');
  assert.strictEqual(app.store.membership_removals.length, 0);
  const g = finding(app, x => x.subject.title === 'ZZ Talk Again');
  app.el(`cuExcl-${g.id}`) ? (app.el(`cuExcl-${g.id}`).value = 'every_version') : app.addEl(`cuExcl-${g.id}`, { value: 'every_version' });
  await app.ctx.cuDecide(g.id, 'excluded'); await settle();
  assert.ok(app.store.collection_exclusions.some(e => e.kind === 'every_version' && e.title === 'ZZ Talk Again'));
  const b2 = await briefOf(app, [coll.id]);
  const r = await importFile(app, { format: 'watchlist-research-findings', version: 1, brief_id: b2.brief_id, coverage: [], findings: [
    { kind: 'new_show', collection_id: coll.id, rule_id: 'person', subject: { title: 'ZZ Talk Again' }, evidence: [official('https://press.example.org/t2', '2026-10-15')], assessment: assessed() }] });
  assert.strictEqual(g.status, 'excluded', 'never returns');
  assert.match(r.text, /not applied — it is excluded/);
});

// ═══ Setup, definitions, Settings, backup ════════════════════════════════════
test('the setup file: resolved against the library, previewed, imported once; afterwards catalog shows update automatically', async () => {
  const cat = showOf({ collection: 'disney', title: 'Cat Show', show_key: 'cat show', tmdb_id: 10 });
  const app = await createApp({ rows: [seasonOf(cat, 1)], tvShows: [cat],
    tmdb: tmdbOf({ shows: { 10: { seasons: [{ season_number: 1 }, { season_number: 2, air_date: '2027-01-01', episode_count: 8 }] } } }) });
  const setup = { format: 'watchlist-collection-setup', version: 1,
    collections: [{ match: { catalog_id: 'disney' }, mode: 'discover', summary: 'Series premiering on the platform.', evidence: EVIDENCE,
      rules: [{ id: 'premiere', type: 'platform_premiere', platform: 'ZZ Plus', region: 'US', media: 'series', genres: 'all' }],
      exclusions: [{ kind: 'title', title: 'ZZ Not This' }] }],
    holds: [{ in_collection: { catalog_id: 'disney' }, show_title: 'Cat Show', season_label: 'Season 3', kind: 'standing_decision', decision: 'Keep TBA', effect: 'keep_value',
      reopen: { on: 'official_date_or_window' }, decided_on: '2026-09-28' }, { show_title: 'Missing Show', kind: 'identity_hold', decision: 'x', effect: 'block_matching', reopen: { on: 'owner_only' } }] };
  app.ctx.openSettings(null); await settle();
  await app.ctx.cuReadState(); await settle();
  assert.match(text(app.el('settingsCuStatus').textContent), /paused until the collection setup is imported/, 'before: paused');
  await app.ctx.cuPreviewSetup(JSON.stringify(setup)); await settle();
  const box = text(app.el('cuModalBox').innerHTML);
  assert.match(box, /Definitions \(1\)[\s\S]*Disney\+ — Discover additions/);
  assert.match(box, /Holds \(1\)[\s\S]*Cat Show · Season 3/);
  assert.match(box, /Not imported[\s\S]*Missing Show/);
  await app.ctx.cuConfirmSetup(); await settle();
  assert.match(text(app.el('cuModalBox').innerHTML), /Imported 1 definition, 1 exclusion and 1 hold/);
  assert.strictEqual(app.store.update_setup.length, 1);
  assert.ok(!/paused/.test(app.el('settingsCuStatus').textContent), 'right after the import the status shows the confirmed setup');
  const t = await refresh(app);
  assert.match(t, /Cat Show · Season 2: added/);
});

test('the setup status: a confirmed import shows at once even when the next read fails; a refused import leaves it paused', async () => {
  const cat = showOf({ collection: 'disney', title: 'Cat Show', show_key: 'cat show', tmdb_id: 10 });
  const setup = { format: 'watchlist-collection-setup', version: 1, collections: [{ match: { catalog_id: 'disney' }, mode: 'follow', summary: 'x', evidence: EVIDENCE, rules: [], exclusions: [] }], holds: [] };
  const app = await createApp({ rows: [seasonOf(cat, 1)], tvShows: [cat] });
  app.ctx.openSettings(null); await settle();
  await app.ctx.cuReadState(); await settle();
  await app.ctx.cuPreviewSetup(JSON.stringify(setup)); await settle();
  const real = app.ctx.cuReadState;
  app.ctx.cuReadState = async () => { throw new Error('read failed'); };
  await app.ctx.cuConfirmSetup(); await settle();
  app.ctx.cuReadState = real;
  assert.strictEqual(app.store.update_setup.length, 1);
  assert.ok(!/paused/.test(app.el('settingsCuStatus').textContent), 'confirmed, though the follow-up read failed');
  // A second import is refused by the database: the error is reported and the status isn't changed by it.
  await app.ctx.cuPreviewSetup(JSON.stringify(setup)); await settle();
  await app.ctx.cuConfirmSetup(); await settle();
  assert.match(text(app.el('cuModalBox').innerHTML), /refused|already|definition/i);
  assert.ok(!/paused/.test(app.el('settingsCuStatus').textContent));
  const app2 = await createApp({ rows: [seasonOf(cat, 1)], tvShows: [cat] });
  app2.ctx.openSettings(null); await settle();
  await app2.ctx.cuReadState(); await settle();
  await app2.ctx.cuPreviewSetup(JSON.stringify(setup)); await settle();
  app2.ctx.sbRpc = async () => { const e = new Error('Supabase error 409: refused'); e.status = 409; throw e; };
  await app2.ctx.cuConfirmSetup(); await settle();
  assert.match(text(app2.el('settingsCuStatus').textContent), /paused until the collection setup is imported/, 'a failed import: still paused');
});

test('the definition editor: forms make the rules, the summary reads them back, Confirm saves a new version; exclusions are added and removed', async () => {
  const coll = { id: uuid('0c100000'), name: 'ZZ Editor', legacy_source: null, sort_order: 9, archived_at: null, created_at: TS };
  const app = await createApp({ personalCollections: [coll], memberships: [] });
  app.ctx.openSettings(null); await settle();
  await app.ctx.openCuDialog('collections', null); await settle();
  assert.match(text(app.el('cuModalBox').innerHTML), /ZZ Editor No definition: Manual/);
  app.ctx.cuOpenEditor(coll.id);
  app.run(`cuModal.draft.mode = 'discover'; cuModal.draft.rules.push({ id: 'person-1', type: 'person_role', person: 'ZZ Person X', person_tmdb_id: 5, series_roles: ['creator', 'co_creator'], film_roles: ['writer', 'director'], announced: true })`);
  const summary = app.get('cuSummary(cuModal.draft, [])');
  assert.strictEqual(summary, 'Discover additions: includes series ZZ Person X is credited on as creator or co-creator; films ZZ Person X is credited on as writer or director.');
  app.ctx.cuReadEditor = () => {};
  await app.ctx.cuConfirmDefinition(); await settle();
  const d = app.store.collection_definitions.find(x => x.collection_id === coll.id);
  assert.deepStrictEqual([d.version, d.mode, d.summary], [1, 'discover', summary]);
  app.addEl('cuExclTitle', { value: 'ZZ Spinoff' }); app.addEl('cuExclKind', { value: 'series_and_spinoffs' });
  await app.ctx.cuAddExclusion(); await settle();
  const e = app.store.collection_exclusions[0];
  assert.deepStrictEqual([e.kind, e.title, e.match_text], ['series_and_spinoffs', 'ZZ Spinoff', 'zz spinoff']);
  await app.ctx.cuRemoveExclusion(e.id); await settle();
  assert.strictEqual(app.store.collection_exclusions.length, 0);
});

test('Settings: the card is drawn with no request; the status comes from what this page already read; a backup is format 7 with collection updates’ tables', async () => {
  const cat = showOf({ collection: 'disney', title: 'Cat', show_key: 'cat', tmdb_id: 10 });
  const app = await createApp({ rows: [seasonOf(cat, 1)], tvShows: [cat], cu1: { update_findings: [] } });
  const before = app.requests.length;
  app.ctx.openSettings(null); await settle();
  assert.strictEqual(app.requests.length, before, 'no request on entry');
  assert.match(app.el('settingsScreen').innerHTML, /Collection updates/);
  await app.ctx.openCuReview(null); await settle(); app.ctx.closeCuModal();
  app.ctx.openSettings(null); await settle();
  assert.match(text(app.el('settingsCuStatus').textContent), /Automatic updates for catalog shows are paused until the collection setup is imported/);
  const b = await app.ctx.buildBackupObject();
  assert.strictEqual(b.formatVersion, 7);
  for (const t of app.get('CU1_TABLES')) assert.ok(Array.isArray(b.tables[t]), t);
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(b)), []);
});

// ═══ The hold editor ═════════════════════════════════════════════════════════
async function holdLibrary() {
  const a = showOf({ title: 'ZZ Hold Show', show_key: 'zz hold show', tmdb_id: 70 });
  const b = showOf({ title: 'ZZ Other Show', show_key: 'zz other show', tmdb_id: 71 });
  const s1 = seasonOf(a, 1, { display_date: 'Jan 1, 2025', date_sort: '2025-01-01' }), s2 = seasonOf(a, 2, { display_date: 'Jan 2, 2026', date_sort: '2026-01-02', watched: true });
  const film = { id: uuid('5c000000'), collection: 'movies', item_key: 'zz hold film', title: 'ZZ Hold Film', season: 'Film', theme: 'Drama', display_date: 'Mar 1, 2024',
    date_sort: '2024-03-01', watched: false, status: 'confirmed', created_at: TS, watch_with: [], collections: [], tmdb_collection_id: null, tmdb_collection_name: null,
    media_type: 'movie', tmdb_id: 7001, season_number: null, skipped: false };
  const coll = { id: uuid('0c100000'), name: 'ZZ Holds', legacy_source: null, sort_order: 9, archived_at: null, created_at: TS };
  const imported = { id: uuid('0f6c0000'), kind: 'standing_decision', collection_id: null, show_id: b.id, item_id: null, subject_label: 'Season 3', field: null, protected_value: null,
    decision: 'Imported: keep TBA', effect: 'keep_value', reopen: { on: 'official_date_or_window' }, decided_on: '2026-09-28', created_at: TS };
  const app = await createApp({ rows: [s1, s2, seasonOf(b, 1), film], tvShows: [a, b], personalCollections: [coll],
    memberships: [{ id: uuid('0d100000'), collection_id: coll.id, show_id: a.id, item_id: null, created_at: TS }], cu1: { update_holds: [imported] } });
  app.ctx.openSettings(null); await settle();
  await app.ctx.openCuDialog('collections', null); await settle();
  app.ctx.cuReadHold = () => {};
  return { app, a, b, s1, s2, film, coll, imported };
}
const libraryOf = app => JSON.stringify(['watchlist_items', 'tv_shows', 'collection_memberships', 'episode_marks'].map(t => app.store[t]));
async function addHold(app, draft) {
  app.ctx.cuOpenHoldEditor(); await settle();
  app.run(`Object.assign(cuModal.hold, ${JSON.stringify(draft)})`);
  app.ctx.cuRenderModal();
  const shown = text(app.el('cuModalBox').innerHTML);
  const n = app.store.update_holds.length;
  await app.ctx.cuSaveHold(); await settle();
  return { shown, added: app.store.update_holds.length > n ? app.store.update_holds[app.store.update_holds.length - 1] : null, box: text(app.el('cuModalBox').innerHTML) };
}
test('hold editor: every supported shape is saved as the setup import writes it, with the subject named before saving; nothing else changes', async () => {
  const { app, a, s2, film, coll, imported } = await holdLibrary();
  const lib0 = libraryOf(app), imp0 = JSON.stringify(imported);
  const pick = h => [h.kind, h.show_id, h.item_id, h.subject_label, h.field, h.protected_value, h.effect, h.reopen.on, h.collection_id];
  let r = await addHold(app, { kind: 'standing_decision', target: `show:${a.id}`, season: '', effect: 'do_not_add', reopen: 'official_or_two_trades', decision: 'No new seasons on rumours' });
  assert.match(r.shown, /This hold applies to ZZ Hold Show \(the whole show\)/);
  assert.deepStrictEqual(pick(r.added), ['standing_decision', a.id, null, null, null, null, 'do_not_add', 'official_or_two_trades', null]);
  assert.match(r.box, /Collections and rules[\s\S]*Add hold: saved/, 'back on the list with the confirmation');
  r = await addHold(app, { kind: 'standing_decision', target: `show:${a.id}`, season: 'label', seasonLabel: 'Season 9', effect: 'keep_value', reopen: 'official_date_or_window', decision: 'Keep TBA', collection_id: coll.id });
  assert.match(r.shown, /ZZ Hold Show · Season 9/);
  assert.deepStrictEqual(pick(r.added), ['standing_decision', a.id, null, 'Season 9', null, null, 'keep_value', 'official_date_or_window', coll.id]);
  r = await addHold(app, { kind: 'standing_decision', target: 'title:', titleLabel: 'ZZ Future Series', effect: 'do_not_add', reopen: 'named_source', sourceDomains: 'https://www.Press.Example.org/news, trade-a.example', sourceName: 'Press', decision: 'Only the studio’s word' });
  assert.match(r.shown, /ZZ Future Series \(not in your library\)/);
  assert.deepStrictEqual(pick(r.added), ['standing_decision', null, null, 'ZZ Future Series', null, null, 'do_not_add', 'named_source', null]);
  assert.deepStrictEqual(out(r.added.reopen), { on: 'named_source', source_domains: ['www.press.example.org', 'trade-a.example'], source_name: 'Press' }, 'scheme and path dropped; the host kept as typed (lowercased)');
  r = await addHold(app, { kind: 'protected_value', target: `show:${a.id}`, season: s2.id, field: 'display_date', reopen: 'new_evidence', decision: 'Owner-approved date' });
  assert.match(r.shown, /ZZ Hold Show · Season 2 — date kept as “Jan 2, 2026”/);
  assert.deepStrictEqual(pick(r.added), ['protected_value', null, s2.id, null, 'display_date', 'Jan 2, 2026', 'keep_value', 'new_evidence', null]);
  r = await addHold(app, { kind: 'protected_value', target: `film:${film.id}`, field: 'title', reopen: 'owner_only', decision: 'Keep the title' });
  assert.match(r.shown, /ZZ Hold Film \(film\) — title kept as “ZZ Hold Film”/);
  assert.deepStrictEqual(pick(r.added), ['protected_value', null, film.id, null, 'title', 'ZZ Hold Film', 'keep_value', 'owner_only', null]);
  r = await addHold(app, { kind: 'identity_hold', target: `show:${a.id}`, season: '', reopen: 'owner_only', decision: 'Don’t match automatically' });
  assert.match(r.shown, /ZZ Hold Show \(the whole show\) — its TMDB matching held/);
  assert.deepStrictEqual(pick(r.added), ['identity_hold', a.id, null, null, null, null, 'block_matching', 'owner_only', null]);
  r = await addHold(app, { kind: 'identity_hold', target: `show:${a.id}`, season: s2.id, reopen: 'owner_only', decision: 'Map Season 2 by hand' });
  assert.match(r.shown, /ZZ Hold Show · Season 2 — its season mapping held/);
  assert.deepStrictEqual(pick(r.added), ['identity_hold', a.id, null, 'Season 2', null, null, 'block_season_mapping', 'owner_only', null]);
  assert.strictEqual(app.store.update_holds.length, 8);
  assert.strictEqual(JSON.stringify(app.store.update_holds.find(h => h.id === imported.id)), imp0, 'the imported hold is untouched');
  assert.strictEqual(libraryOf(app), lib0, 'no show, season, date, progress or membership changed');
});

test('hold editor: an incomplete or impossible hold is explained and nothing is sent', async () => {
  const { app, a, film } = await holdLibrary();
  const writes = app.writes().length;
  for (const [draft, why] of [
    [{ kind: 'protected_value', target: `show:${a.id}`, season: 'label', seasonLabel: '', field: 'display_date', decision: 'x' }, /Name the season/],
    [{ kind: 'identity_hold', target: `film:${film.id}`, decision: 'x' }, /Identity holds are for shows/],
    [{ kind: 'standing_decision', target: `show:${a.id}`, season: 'label', seasonLabel: ' ', decision: 'x' }, /Name the season/],
    [{ kind: 'standing_decision', target: `show:${a.id}`, decision: '  ' }, /Write the decision/],
    [{ kind: 'standing_decision', target: `show:${a.id}`, reopen: 'named_source', sourceDomains: '', decision: 'x' }, /List the source.s domains/],
    [{ kind: 'protected_value', target: `film:${film.id}`, field: 'season_label', decision: 'x' }, /A film has no season label/],
    [{ kind: 'standing_decision', target: '', decision: 'x' }, /Choose what the hold applies to/]]) {
    const r = await addHold(app, draft);
    assert.ok(!r.added, JSON.stringify(draft));
    assert.match(r.box, why);
  }
  assert.strictEqual(app.writes().length, writes, 'nothing sent');
});

test('hold editor: Remove refuses a hold that changed since it was shown and says so; the other holds stay', async () => {
  const { app, imported } = await holdLibrary();
  app.store.update_holds[0].decision = 'Changed in another tab';
  await app.ctx.cuDeleteHold(imported.id); await settle();
  assert.match(text(app.el('cuModalBox').innerHTML), /Collections and rules[\s\S]*changed since the page showed it/);
  assert.strictEqual(app.store.update_holds.length, 1, 'kept');
  await app.ctx.cuDeleteHold(imported.id); await settle();
  assert.strictEqual(app.store.update_holds.length, 0, 'removed once the list showed the current hold');
  assert.match(text(app.el('cuModalBox').innerHTML), /Remove hold: saved/);
});

test('hold editor: holds added in the editor survive a format-7 backup and restore unchanged', async () => {
  const { app, a, s2 } = await holdLibrary();
  await addHold(app, { kind: 'protected_value', target: `show:${a.id}`, season: s2.id, field: 'display_date', reopen: 'new_evidence', decision: 'Owner-approved date' });
  await addHold(app, { kind: 'standing_decision', target: 'title:', titleLabel: 'ZZ Future Series', effect: 'do_not_add', reopen: 'named_source', sourceDomains: 'press.example.org', decision: 'Only the studio’s word' });
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const holds = JSON.stringify(app.store.update_holds.slice().sort((x, y) => cmp(x.id, y.id)));
  const b = await app.ctx.buildBackupObject();
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(b)), []);
  assert.strictEqual(b.tables.update_holds.length, 3);
  app.store.update_holds.splice(0);
  const r = await app.run(`runWrite('r', () => sbRpc('restore_backup', { p_backup: ${JSON.stringify(b)}, p_allow_v1_reset: false })).then(() => 'ok', e => String(e.message))`);
  assert.strictEqual(r, 'ok');
  const strip = h => { const { created_at, ...rest } = h; return rest; };
  assert.deepStrictEqual(app.store.update_holds.map(strip).sort((x, y) => cmp(x.id, y.id)), JSON.parse(holds).map(strip));
});

async function editHold(app, id, change) {
  app.ctx.cuOpenHoldEditor(id); await settle();
  const form = text(app.el('cuModalBox').innerHTML);
  if (change) app.run(`Object.assign(cuModal.hold, ${JSON.stringify(change)})`);
  app.ctx.cuRenderModal();
  const shown = text(app.el('cuModalBox').innerHTML);
  const writes = app.writes().length;
  await app.ctx.cuSaveHold(); await settle();
  return { form, shown, box: text(app.el('cuModalBox').innerHTML), sent: app.writes().slice(writes) };
}
test('hold editor, edit: the form opens on the stored hold; saving updates it in place (same id and created_at, same shape); nothing else changes', async () => {
  const { app, b, imported } = await holdLibrary();
  const lib0 = libraryOf(app);
  const r = await editHold(app, imported.id, { effect: 'do_not_add', reopen: 'official_or_two_trades', decision: 'Edited: no new seasons on rumours' });
  assert.match(r.form, /Edit hold[\s\S]*ZZ Other Show · Season 3/, 'the stored target, by its exact label');
  assert.match(r.form, /Imported: keep TBA/);
  assert.match(r.shown, /Saving changes only this hold, in place/);
  assert.strictEqual(r.sent.length, 1);
  assert.ok(r.sent[0].url.endsWith('/rpc/library_cu_update_hold'));
  assert.deepStrictEqual(out(r.sent[0].body.p_expected), out(Object.fromEntries(['kind', 'collection_id', 'show_id', 'item_id', 'subject_label', 'field', 'protected_value', 'decision', 'effect', 'reopen', 'decided_on'].map(k => [k, imported[k]]))));
  const h = app.store.update_holds.find(x => x.id === imported.id);
  assert.deepStrictEqual([app.store.update_holds.length, h.id, h.created_at, h.show_id, h.item_id, h.subject_label, h.effect, h.reopen.on, h.decision, h.decided_on],
    [1, imported.id, imported.created_at, b.id, null, 'Season 3', 'do_not_add', 'official_or_two_trades', 'Edited: no new seasons on rumours', '2026-09-28']);
  assert.match(r.box, /Collections and rules[\s\S]*Edit hold: saved/);
  assert.strictEqual(libraryOf(app), lib0, 'no show, season, date, progress or membership changed');
});

test('hold editor, edit: a protected value keeps the value it stored (shown beside the current one); a season named by its row stays a row', async () => {
  const { app, a, s2 } = await holdLibrary();
  await addHold(app, { kind: 'protected_value', target: `show:${a.id}`, season: s2.id, field: 'display_date', reopen: 'new_evidence', decision: 'Owner-approved date' });
  const p = app.store.update_holds.find(h => h.kind === 'protected_value');
  app.store.watchlist_items.find(r => r.id === s2.id).display_date = 'Feb 1, 2026';
  await app.ctx.openCuDialog('collections', null); await settle();
  app.ctx.cuReadHold = () => {};
  const r = await editHold(app, p.id, { decision: 'Owner-approved date, confirmed again' });
  assert.match(r.shown, /ZZ Hold Show · Season 2 — date kept as “Jan 2, 2026” \(it shows “Feb 1, 2026” now\)/);
  const h = app.store.update_holds.find(x => x.id === p.id);
  assert.deepStrictEqual([h.item_id, h.field, h.protected_value, h.decision], [s2.id, 'display_date', 'Jan 2, 2026', 'Owner-approved date, confirmed again']);
  // An identity hold stored on a season row keeps that shape when only its decision changes.
  app.store.update_holds.push({ id: uuid('0f6c0000'), kind: 'identity_hold', collection_id: null, show_id: null, item_id: s2.id, subject_label: null, field: null, protected_value: null,
    decision: 'Row-shaped identity hold', effect: 'block_season_mapping', reopen: { on: 'owner_only' }, decided_on: null, created_at: TS });
  const idh = app.store.update_holds[app.store.update_holds.length - 1];
  await app.ctx.openCuDialog('collections', null); await settle();
  app.ctx.cuReadHold = () => {};
  await editHold(app, idh.id, { decision: 'Row-shaped identity hold, edited' });
  assert.deepStrictEqual([idh.item_id, idh.show_id, idh.subject_label, idh.effect, idh.decision], [s2.id, null, null, 'block_season_mapping', 'Row-shaped identity hold, edited']);
});

test('hold editor, edit: an unchanged form sends nothing; an invalid one stays open; a hold changed meanwhile is refused and the list shows it as it is now', async () => {
  const { app, imported } = await holdLibrary();
  let r = await editHold(app, imported.id, null);
  assert.strictEqual(r.sent.length, 0);
  assert.match(r.box, /Edit hold[\s\S]*Nothing to save: the hold is unchanged/);
  await app.ctx.openCuDialog('collections', null); await settle(); app.ctx.cuReadHold = () => {};
  r = await editHold(app, imported.id, { decision: '  ' });
  assert.strictEqual(r.sent.length, 0);
  assert.match(r.box, /Edit hold[\s\S]*Write the decision/);
  await app.ctx.openCuDialog('collections', null); await settle(); app.ctx.cuReadHold = () => {};
  app.ctx.cuOpenHoldEditor(imported.id); await settle();
  app.store.update_holds[0].decision = 'Changed in another tab';
  app.run(`Object.assign(cuModal.hold, { decision: 'My edit' })`);
  await app.ctx.cuSaveHold(); await settle();
  const box = text(app.el('cuModalBox').innerHTML);
  assert.match(box, /Collections and rules[\s\S]*changed since the page showed it[\s\S]*Changed in another tab/);
  assert.strictEqual(app.store.update_holds[0].decision, 'Changed in another tab', 'the other change stands');
});

test('hold editor (review fixes): show-wide protected values, a named source with a name, an archived collection and a stored identity effect all survive an edit', async () => {
  const { app, a, b, coll } = await holdLibrary();
  // A show-wide protected value, as the setup import writes it (no single value): added, then edited.
  let r = await addHold(app, { kind: 'protected_value', target: `show:${a.id}`, season: '', field: 'title', reopen: 'new_evidence', decision: 'Keep every season’s title' });
  assert.match(r.shown, /ZZ Hold Show \(the whole show\) — every season.s title kept as it is/);
  const pv = r.added;
  assert.deepStrictEqual([pv.show_id, pv.item_id, pv.subject_label, pv.field, pv.protected_value, pv.effect], [a.id, null, null, 'title', null, 'keep_value']);
  await app.ctx.openCuDialog('collections', null); await settle(); app.ctx.cuReadHold = () => {};
  r = await editHold(app, pv.id, null);
  assert.strictEqual(r.sent.length, 0, 'opened and saved unchanged: nothing sent');
  await app.ctx.openCuDialog('collections', null); await settle(); app.ctx.cuReadHold = () => {};
  await editHold(app, pv.id, { decision: 'Keep every season’s title (confirmed)' });
  assert.deepStrictEqual([pv.show_id, pv.item_id, pv.subject_label, pv.field, pv.protected_value], [a.id, null, null, 'title', null], 'still show-wide, no value invented');
  // A named source with a name, in an archived collection; the database answers its jsonb keys in its own order.
  const ns = { id: uuid('0f6c0000'), kind: 'standing_decision', collection_id: coll.id, show_id: b.id, item_id: null, subject_label: 'Season 4', field: null, protected_value: null,
    decision: 'Only the studio', effect: 'do_not_add', reopen: { on: 'named_source', source_name: 'Studio', source_domains: ['www.studio.example'] }, decided_on: '2026-09-01', created_at: TS };
  const idh = { id: uuid('0f6c0000'), kind: 'identity_hold', collection_id: null, show_id: b.id, item_id: null, subject_label: null, field: null, protected_value: null,
    decision: 'Odd stored effect', effect: 'block_season_mapping', reopen: { on: 'owner_only' }, decided_on: null, created_at: TS };
  app.store.update_holds.push(ns, idh);
  app.store.personal_collections.find(c => c.id === coll.id).archived_at = TS;
  await app.ctx.openCuDialog('collections', null); await settle(); app.ctx.cuReadHold = () => {};
  r = await editHold(app, ns.id, null);
  assert.strictEqual(r.sent.length, 0, 'unchanged despite key order: nothing sent');
  assert.match(r.form, /ZZ Holds \(archived\)/);
  await app.ctx.openCuDialog('collections', null); await settle(); app.ctx.cuReadHold = () => {};
  r = await editHold(app, ns.id, { decision: 'Only the studio (edited)' });
  assert.match(r.box, /Edit hold: saved/);
  assert.ok(!/list shows it differently/.test(r.box), 'no false alarm');
  assert.deepStrictEqual([ns.collection_id, ns.subject_label, ns.reopen.source_name, out(ns.reopen.source_domains)], [coll.id, 'Season 4', 'Studio', ['www.studio.example']]);
  await app.ctx.openCuDialog('collections', null); await settle(); app.ctx.cuReadHold = () => {};
  await editHold(app, idh.id, { decision: 'Odd stored effect, edited' });
  assert.deepStrictEqual([idh.show_id, idh.subject_label, idh.effect], [b.id, null, 'block_season_mapping'], 'the stored effect stands while the target is unchanged');
});

T.run();
