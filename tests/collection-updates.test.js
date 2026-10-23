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
// TMDB: details by id, appended season lists, searches.
function tmdbOf({ shows = {}, lists = {}, search = {}, fail = () => false } = {}) {
  return p => {
    if (fail(p)) return { __status: 500 };
    const m = /^\/tv\/(\d+)(\?append_to_response=(.*))?$/.exec(p);
    if (m) {
      if (!shows[m[1]]) return undefined;
      if (!m[2]) return { id: +m[1], networks: [{ id: 1, name: 'Net' }], created_by: [], ...shows[m[1]] };
      return Object.fromEntries(m[3].split(',').filter(k => lists[`${m[1]}/${k.split('/')[1]}`]).map(k => [k, { episodes: lists[`${m[1]}/${k.split('/')[1]}`] }]));
    }
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
  assert.match(t, /Needs review \(1\)[\s\S]*Cat · Season 2: automatic updates for catalog shows wait for the collection setup/);
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

test('dates: a TBA season gets TMDB’s date and a future date follows TMDB; an aired date isn’t re-checked; Ended is kept and the new season flagged', async () => {
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
  assert.strictEqual(row(fut.id).display_date, 'Feb 1, 2028');
  assert.strictEqual(row(old.id).display_date, 'Jan 1, 2020', 'aired: not re-checked');
  assert.ok(!rpcs(app, 'library_cu_set_season_date').some(r => r.body.p_row_id === old.id), 'no request for the aired season');
  assert.match(t, /Dated · Season 4: added \(the show stays marked ended; flagged\)/);
  assert.strictEqual(app.store.tv_shows[0].ended, true);
  assert.ok(app.store.show_update_settings.some(s => s.show_id === sh.id && s.new_season_after_ended_at));
});

test('episode lists: every identified season’s full list is fetched (20 per request) and cached on this device; new episodes are reported; marks untouched', async () => {
  const sh = showOf({ title: 'Eps', show_key: 'eps', tmdb_id: 60 });
  const s1 = seasonOf(sh, 1), s2 = seasonOf(sh, 2, { watched: true });
  const storage = memoryStorage();
  const app = await createApp({ rows: [s1, s2], tvShows: [sh], storage, episodeMarks: [{ id: uuid('0e100000'), season_id: s1.id, tmdb_episode_id: 601, episode_number: 1 }],
    tmdb: tmdbOf({ shows: { 60: { seasons: [{ season_number: 1 }, { season_number: 2 }] } }, lists: { '60/1': EPS(601, 602, 603), '60/2': EPS(611, 612) } }) });
  // This device had season 1's list with two episodes.
  app.run(`writeEpisodeListCache({ '60:1': { ids: [601, 602], numbers: [1, 2], names: ['', ''] } })`);
  const t = await refresh(app);
  assert.ok(app.requests.some(r => r.url.includes('/tv/60?append_to_response=season/1,season/2')), 'one request for both lists');
  assert.match(t, /Eps · Season 1: 1 new episode listed \(this device\)/);
  const cache = out(app.get('readEpisodeListCache()'));
  assert.deepStrictEqual(cache['60:1'].ids, [601, 602, 603]);
  assert.deepStrictEqual(cache['60:2'].ids, [611, 612]);
  assert.strictEqual(app.store.episode_marks.length, 1, 'marks untouched');
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
  assert.strictEqual(d.reason, 'date_needs_review');
  await app.ctx.cuReviewDate(d.id); await settle();
  assert.strictEqual(app.store.watchlist_items.find(x => x.id === aired.id).display_date, 'Feb 2, 2020');
  box = app.el('cuModalBox').innerHTML;
  assert.ok(box.includes(`cuClearEndedFlag('${sh.id}')`));
  await app.ctx.cuClearEndedFlag(sh.id); await settle();
  assert.strictEqual(app.store.show_update_settings[0].new_season_after_ended_at, null);
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
  assert.match(t, /New show: ZZ Weak: the evidence doesn't meet the standard/);
  assert.match(t, /New show: ZZ Contested: the sources conflict/);
  assert.match(t, /Live \(cancellation\): couldn't be checked — the source didn't load/);
  assert.strictEqual(finding(app, f => f.subject.title === 'ZZ Weak').status, 'needs_evidence');
  assert.strictEqual(finding(app, f => f.subject.title === 'ZZ Contested').status, 'conflict');
  assert.ok(results);
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
  await app.ctx.cuPreviewSetup(JSON.stringify(setup)); await settle();
  const box = text(app.el('cuModalBox').innerHTML);
  assert.match(box, /Definitions \(1\)[\s\S]*Disney\+ — Discover additions/);
  assert.match(box, /Holds \(1\)[\s\S]*Cat Show · Season 3/);
  assert.match(box, /Not imported[\s\S]*Missing Show/);
  await app.ctx.cuConfirmSetup(); await settle();
  assert.match(text(app.el('cuModalBox').innerHTML), /Imported 1 definition, 1 exclusion and 1 hold/);
  assert.strictEqual(app.store.update_setup.length, 1);
  const t = await refresh(app);
  assert.match(t, /Cat Show · Season 2: added/);
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

T.run();
