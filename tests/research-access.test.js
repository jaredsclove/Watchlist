// Offline tests for CU2, per-member research access (db/cu2_research_access.sql; the page's side in api.js,
// collection-updates.js, collection-research.js and collection-settings.js), in the whole-page harness (tests/cu1-harness.js
// stands in for the database's guard):
//   * with access nothing changes; without it, or without an answer, every research control is gone, while Refresh
//     shows, TMDB review, Skipped shows, ordinary collections and backup and restore stay;
//   * a page left open when access ends: the database refuses, the page follows, nothing is resent;
//   * an interrupted import: the unfinished findings are exactly those no applying function has evaluated, and
//     "Continue applying imported updates" runs only on a click, under the automatic rules, and disappears when done.
// The database's own rules are rehearsed in tools/db-rehearsal-cu1.mjs. Run from the repo root: node tests/research-access.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('research-access');
const test = T.test;
const TS = '2026-10-01T00:00:00+00:00';
let n = 0;
const uuid = p => `${p}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const text = html => String(html).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/’/g, "'").replace(/\s+/g, ' ').trim();
const showOf = (o = {}) => ({ id: uuid('5a000000'), collection: 'othertv', title: 'Show', show_key: 'show', tmdb_id: null, status: 'confirmed', created_at: TS, ...o });
const seasonOf = (sh, num, o = {}) => ({ id: uuid('5b000000'), collection: sh.collection, title: sh.title, theme: 'Net', status: 'confirmed', watched: false, skipped: false,
  show_id: sh.id, media_type: sh.tmdb_id != null ? 'tv' : null, tmdb_id: sh.tmdb_id, season_number: sh.tmdb_id != null ? num : null, season: `Season ${num}`,
  display_date: 'Jan 1, 2020', date_sort: '2020-01-01', item_key: `${sh.show_key}|season ${num}`, watch_with: [], collections: [], created_at: TS,
  tmdb_collection_id: null, tmdb_collection_name: null, ...o });
const rpcs = (app, name) => app.writes().filter(r => r.url.endsWith(`/rpc/${name}`));
const fpr = c => `${c.repeat(64)}`;
const EVIDENCE = { standard: 'official_or_two_trades', official_domains: ['press.example.org'],
  trades: [{ id: 'trade_a', name: 'Trade A', domains: ['trade-a.example'] }, { id: 'trade_b', name: 'Trade B', domains: ['trade-b.example'] }] };
const RULES = [{ id: 'person', type: 'person_role', person: 'ZZ Person X', series_roles: ['creator'], film_roles: ['director'], announced: true }];
const official = (url = 'https://press.example.org/a', day = '2026-10-10') => ({ url, publisher: 'Press', outlet: 'official', source_type: 'official', published_on: day, excerpt: 'Announced.' });
const assessed = () => ({ standard: 'official', researched_on: '2026-10-20', conflict: false, independence: 'one official release' });

// A library with research data: a definition, a hold, a Skipped show and findings of both sources.
async function library(o = {}) {
  const live = showOf({ title: 'Live', show_key: 'live', tmdb_id: 111 }), other = showOf({ title: 'Other', show_key: 'other', tmdb_id: 113 });
  const skipped = showOf({ title: 'Dropped', show_key: 'dropped', tmdb_id: 112, status: 'skipped' });
  const tba = seasonOf(live, 2, { display_date: 'TBA', date_sort: '2099-01-01' });
  const coll = { id: uuid('0c100000'), name: 'ZZ Person X', legacy_source: null, sort_order: 9, archived_at: null, created_at: TS };
  const app = await createApp({ rows: [seasonOf(live, 1), tba, seasonOf(other, 1), seasonOf(skipped, 1)], tvShows: [live, other, skipped], personalCollections: [coll],
    memberships: [live, other, skipped].map(s => ({ id: uuid('0d100000'), collection_id: coll.id, show_id: s.id, item_id: null, created_at: TS })), ...o, research: true });
  await app.run(`runWrite('d', () => sbRpc('library_cu_save_definition', { p_collection_id: ${JSON.stringify(coll.id)}, p_expected_version: 0, p_mode: 'discover',
    p_rules: ${JSON.stringify(RULES)}, p_evidence: ${JSON.stringify(EVIDENCE)}, p_summary: 'x' }))`);
  await app.run(`runWrite('h', () => sbRpc('library_cu_save_hold', { p_hold: { kind: 'standing_decision', show_id: ${JSON.stringify(other.id)}, subject_label: 'Season 9', decision: 'ZZ Decision',
    effect: 'do_not_add', reopen: { on: 'owner_only' }, decided_on: '2026-01-01' } }))`);
  return { app, coll, live, other, skipped, tba };
}
// Findings as the database stores them.
function stored(app, coll, o) {
  const f = { id: uuid('0f200000'), fingerprint: `alias:${fpr(String((++n) % 10))}${n}`, source: 'research', kind: 'alias', status: 'pending', reason: '', collection_id: coll.id, show_id: null, item_id: null, season_id: null,
    subject: {}, proposed: {}, expected: {}, evidence: [official()], assessment: assessed(), rule_id: null, definition_version: 1, rule_hash: null,
    evidence_hash: app.store.collection_definitions[0].evidence_hash, brief_id: uuid('0e200000'), first_seen_at: `2026-10-0${(n % 8) + 1}T00:00:00+00:00`, last_seen_at: TS, decided_at: null, applied_at: null, result: null, ...o };
  app.store.update_findings.push(f);
  return f;
}
const newSeason = (app, coll, show, num = 3, o = {}) => stored(app, coll, { kind: 'new_season', show_id: show.id, subject: { title: show.title, season_number: num }, proposed: { display_date: 'TBA', date_sort: '2099-01-01' }, ...o });
const newDate = (app, coll, show, row, o = {}) => stored(app, coll, { kind: 'date', show_id: show.id, season_id: row.id, subject: { title: show.title, season: row.season }, proposed: { display_date: 'Jun 5, 2030', date_sort: '2030-06-05' }, ...o });
const alias = (app, coll, show, name = 'ZZ Other Title', o = {}) => stored(app, coll, { kind: 'alias', show_id: show.id, subject: { title: show.title }, proposed: { alias: name }, ...o });
const off = app => { app.research = false; app.ctx.noteResearchAccess({ research: false }); };
const on = app => { app.research = true; app.ctx.noteResearchAccess({ research: true }); };
const review = async app => { await app.ctx.openCuReview(null); await settle(); return app.el('cuModalBox').innerHTML; };
const LABEL = 'Continue applying imported updates';
const RESEARCH_WORDS = /research|brief|findings? file|Import setup|setup file|Collections and rules|definition|evidence|announcement|\bhold/i;

test('with access: the card, the dialogs and review are as they were', async () => {
  const { app, coll, live } = await library();
  app.ctx.openSettings(null); await settle();
  const card = app.el('settingsScreen').innerHTML;
  for (const x of ['Collection updates', 'Review findings…', 'Collections and rules…', 'Download research brief…', 'Import findings file…', 'Import setup file…']) assert.ok(card.includes(x), x);
  await app.ctx.openCuDialog('collections', null); await settle();
  const d = text(app.el('cuModalBox').innerHTML);
  assert.match(d, /Collections and rules/); assert.match(d, /Holds \(1\)/); assert.match(d, /Skipped shows still checked/);
  app.ctx.closeCuModal();
  alias(app, coll, live, 'ZZ Waits', { reason: 'something_else' });
  assert.match(text(await review(app)), /also titled "?.?ZZ Waits/);
});

test('without access: no research control on Settings; ordinary collections, watch-with, backup and restore stay', async () => {
  const { app } = await library();
  off(app);
  app.ctx.openSettings(null); await settle();
  const card = app.el('settingsScreen').innerHTML;
  for (const x of ['Review findings', 'Collections and rules', 'Download research brief', 'Import findings file', 'Import setup file', 'Collection updates']) assert.ok(!card.includes(x), x);
  for (const x of ['Show updates', 'Review updates…', 'Skipped shows…', 'Manage collections…', 'Manage watch-with choices…', 'Restore from a backup file…']) assert.ok(card.includes(x), x);
  const start = card.indexOf('settingsCuTitle'), end = card.indexOf('settingsBackupTitle');
  assert.ok(!RESEARCH_WORDS.test(text(card.slice(start, end))), text(card.slice(start, end)));
});

test('without an answer the controls stay hidden: an older database, a failed read', async () => {
  const none = await createApp({ research: null });
  none.ctx.openSettings(null); await settle();
  assert.ok(!none.el('settingsScreen').innerHTML.includes('Download research brief'), 'a capability without research');
  const { app } = await library();
  assert.strictEqual(app.get('researchEnabled'), true);
  app.ctx.openSettings(null); await settle();
  app.ctx.noteResearchAccess(null); await settle();
  assert.strictEqual(app.get('researchEnabled'), false);
  assert.ok(!app.el('settingsScreen').innerHTML.includes('Download research brief'), 'the card follows at once');
  const weird = await library();
  weird.app.ctx.noteResearchAccess({ research: 'true' }); await settle();
  assert.strictEqual(weird.app.get('researchEnabled'), false, 'only an explicit true');
});

test('without access the research entry points do nothing, called directly', async () => {
  const { app, coll } = await library();
  off(app);
  let clicked = 0;
  app.el('cuFileInput').click = () => { clicked++; };
  for (const k of ['brief', 'setup', 'editor']) { await app.ctx.openCuDialog(k, null); await settle(); assert.strictEqual(app.get('cuModal'), null, k); }
  app.ctx.cuPickFile('findings'); app.ctx.cuPickFile('setup');
  assert.strictEqual(clicked, 0);
  await app.ctx.openCuDialog('collections', null); await settle();
  const before = app.el('cuModalBox').innerHTML;
  app.ctx.cuOpenHoldEditor(); app.ctx.cuOpenEditor(coll.id); await settle();
  assert.strictEqual(app.el('cuModalBox').innerHTML, before, 'the Skipped dialog stays what it is');
  assert.ok(!RESEARCH_WORDS.test(text(before)), text(before));
});

test('without access: Skipped shows stays, and keeps saving', async () => {
  const { app, skipped } = await library();
  off(app);
  await app.ctx.openCuDialog('collections', null); await settle();
  assert.match(text(app.el('cuModalBox').innerHTML), /Skipped shows still checked for new seasons[\s\S]*Keep checking this show/);
  await app.ctx.cuSetFollow(skipped.id, true); await settle();
  assert.ok(app.store.show_update_settings.some(s => s.show_id === skipped.id && s.follow_when_skipped), 'saved');
  assert.match(text(app.el('cuModalBox').innerHTML), /Stop checking/);
});

test('without access: review shows TMDB findings only; its counts and wording leave research out', async () => {
  const { app, coll, live, other } = await library();
  alias(app, coll, live, 'ZZ Research Pending');
  alias(app, coll, live, 'ZZ Research Blocked', { status: 'needs_evidence', reason: 'evidence_below_standard' });
  const tmdb = o => stored(app, coll, { source: 'tmdb', collection_id: null, brief_id: null, show_id: other.id, evidence: [], assessment: {}, ...o });
  tmdb({ kind: 'identity', reason: 'possible_match', subject: { title: 'Other', candidates: [{ tmdb_id: 5, name: 'ZZ Candidate' }] } });
  tmdb({ kind: 'new_season', status: 'needs_evidence', reason: 'tmdb_undated_empty', subject: { title: 'Other', season_number: 7, label: 'Season 7' } });
  off(app);
  const t = text(await review(app));
  assert.match(t, /Review show updates/);
  assert.match(t, /Match to "?.?ZZ Candidate/, t);
  assert.match(t, /Waiting for more information \(1\) TMDB doesn't have enough on these yet/);
  assert.ok(!/ZZ Research|research/i.test(t), t);
  await app.ctx.cuReadState(); await settle();
  assert.strictEqual(app.get('cuLastState').open, 1, 'a research finding isn’t counted');
  assert.strictEqual(app.get('cuLastState').blocked, 1);
});

test('without access: Refresh shows runs, leaves research findings alone and says nothing of research; holds still hold', async () => {
  const tmdb = p => ({ '/tv/111': { id: 111, networks: [{ id: 1, name: 'Net' }], created_by: [], seasons: [{ season_number: 1 }, { season_number: 2 }, { season_number: 3, air_date: '2030-01-01', episode_count: 5 }] },
    '/tv/113': { id: 113, networks: [{ id: 1, name: 'Net' }], created_by: [], seasons: [{ season_number: 1 }, { season_number: 9, air_date: '2030-01-01', episode_count: 5 }] } }[p] || (/season/.test(p) ? { __status: 404 } : undefined));
  const { app, coll, live, tba, other } = await library({ tmdb });
  const exact = app.store.watchlist_items.find(r => r.id === tba.id);
  exact.display_date = 'Jun 5, 2030'; exact.date_sort = '2030-06-05';
  const sameDay = newDate(app, coll, live, tba, { proposed: { display_date: 'Jun 6, 2030', date_sort: '2030-06-06' } });
  off(app);
  app.ctx.switchView('alltv'); await settle();
  app.ctx.openLibraryPanel('tv', 'refresh'); await settle();
  assert.ok(!/research/i.test(app.el('libraryPanel') ? app.el('libraryPanel').innerHTML : ''), 'the panel');
  await app.ctx.cuRefreshShows(); await settle();
  const t = text(app.el('tmdbPreview').innerHTML);
  assert.ok(app.store.watchlist_items.some(r => r.show_id === live.id && r.season === 'Season 3'), 'a TMDB season is added');
  assert.ok(!app.store.watchlist_items.some(r => r.show_id === other.id && r.season === 'Season 9'), 'a standing decision still stops one');
  assert.match(t, /Season 9: a standing decision covers it/);
  assert.ok(!rpcs(app, 'library_cu_set_season_date').some(r => r.body.p_finding.id === sameDay.id), 'a research date finding isn’t sent');
  assert.strictEqual(app.store.update_findings.find(f => f.id === sameDay.id).status, 'pending');
  assert.ok(!/announcement|research/i.test(t), t);
});

test('the New season tag names the card this member has', async () => {
  const { app, live } = await library();
  app.ctx.cuPublishShowSettings([{ show_id: live.id, new_season_after_ended_at: TS }]);
  assert.match(app.ctx.cuEndedFlagHtml(live), /Settings → Collection updates clears it/);
  off(app);
  assert.match(app.ctx.cuEndedFlagHtml(live), /Settings → Show updates clears it/);
});

test('without access a backup is still complete, and restoring keeps research rows; the preview still says what goes', async () => {
  const { app, coll, live } = await library();
  alias(app, coll, live, 'ZZ Kept');
  off(app);
  const b = await app.ctx.buildBackupObject();
  assert.strictEqual(b.formatVersion, 9);
  assert.strictEqual(b.tables.update_holds.length, 1); assert.strictEqual(b.tables.collection_definitions.length, 1);
  assert.ok(b.tables.update_findings.some(f => f.source === 'research'), 'research findings are in it');
  assert.ok(!('research_enabled' in b) && !('library_members' in b.tables), 'and the permission isn’t');
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(b)), []);
  const html = text(app.ctx.format6ConversionHtml({ update_holds: 2, update_findings: 1 }));
  assert.match(html, /Restoring it removes the 3 collection-update records you have now \(the safety backup keeps them\)/);
  assert.ok(!/import the collection setup/.test(html), html);
  on(app);
  assert.match(text(app.ctx.format6ConversionHtml({ update_holds: 2 })), /import the collection setup file again/);
});

test('access ending on an open page: the refusal is shown once, the dialog gives way, Settings follows, nothing is resent', async () => {
  const { app, coll } = await library();
  app.ctx.openSettings(null); await settle();
  await app.ctx.openCuDialog('brief', null); await settle();
  app.research = false; // the owner switched it off; this page doesn't know yet
  let file = 0;
  app.ctx.downloadJSON = () => { file++; };
  app.el('cuModalBox').querySelectorAll = () => [];
  await app.ctx.cuDownloadBrief([coll.id]).catch(() => {}); await settle();
  assert.strictEqual(file, 0, 'no brief');
  assert.strictEqual(app.get('researchEnabled'), false);
  assert.strictEqual(rpcs(app, 'library_cu_register_brief').length, 1, 'not resent');
  assert.match(text(app.el('cuModalBox').innerHTML), /Collection research isn't enabled for this account/);
  assert.ok(!app.el('settingsScreen').innerHTML.includes('Download research brief'));
});

test('access ending while a hold is edited: refused, the draft gives way, the saved hold is untouched', async () => {
  const { app } = await library();
  await app.ctx.openCuDialog('collections', null); await settle();
  const h = app.store.update_holds[0], before = JSON.stringify(h);
  app.ctx.cuOpenHoldEditor(h.id); await settle();
  app.research = false;
  app.run(`Object.assign(cuModal.hold, { decision: 'Changed' })`);
  app.ctx.cuReadHold = () => {}; // the offline page has no form values to read back
  await app.ctx.cuSaveHold(); await settle();
  assert.strictEqual(JSON.stringify(app.store.update_holds[0]), before);
  assert.strictEqual(app.get('cuModal').kind, 'message');
  assert.match(text(app.el('cuModalBox').innerHTML), /Everything already saved is kept/);
});

// Applies one call, then access ends: the state an interrupted import leaves.
async function interrupted() {
  const ctx = await library();
  const { app, coll, live, tba, other } = ctx;
  const b = await (async () => { let x; app.ctx.downloadJSON = o => { x = JSON.parse(JSON.stringify(o)); }; await app.ctx.cuDownloadBrief([coll.id]); await settle(); return x; })();
  const doc = { format: 'watchlist-research-findings', version: 1, brief_id: b.brief_id, researched_at: '2026-10-20T10:00:00Z', coverage: [], findings: [
    { kind: 'new_season', collection_id: coll.id, ref: `rec:show:${live.id}`, subject: { title: 'Live', season_number: 3 }, proposed: { display_date: 'TBA', date_sort: '2099-01-01' }, evidence: [official()], assessment: assessed() },
    { kind: 'date', collection_id: coll.id, ref: `rec:season:${tba.id}`, subject: { title: 'Live', season: 'Season 2' }, proposed: { display_date: 'Jun 5, 2030', date_sort: '2030-06-05' }, evidence: [official('https://press.example.org/d')], assessment: assessed() },
    { kind: 'alias', collection_id: coll.id, ref: `rec:show:${other.id}`, subject: { title: 'Other' }, proposed: { alias: 'ZZ Other Name' }, evidence: [official('https://press.example.org/e')], assessment: assessed() },
    { kind: 'new_show', collection_id: coll.id, rule_id: 'person', subject: { title: 'ZZ New Title' }, evidence: [official('https://press.example.org/f')], assessment: assessed() }] };
  const real = app.ctx.sbRpc;
  let applied = 0;
  app.ctx.sbRpc = async (fn, args) => { const r = await real(fn, args); if (/reconcile_season|set_season_date|add_alias/.test(fn) && ++applied === 1) app.research = false; return r; };
  const res = await app.ctx.cuImportFindings(JSON.stringify(doc)); await settle();
  app.ctx.sbRpc = real;
  return { ...ctx, doc, res, text: text(app.ctx.cuResultsHtml(res.results)) };
}
const sentApplying = app => ['library_cu_reconcile_season', 'library_cu_set_season_date', 'library_cu_add_alias'].reduce((c, x) => c + rpcs(app, x).length, 0);

test('an interrupted import: the first update applied, the next refused and nothing more sent; nothing is lost and the file stays refused', async () => {
  const { app, res, text: t, live, doc } = await interrupted();
  assert.strictEqual(sentApplying(app), 2, 'one applied, one refused, the third never sent');
  assert.ok(app.store.watchlist_items.some(r => r.show_id === live.id && r.season === 'Season 3'));
  assert.match(t, /Collection research isn't enabled for this account[\s\S]*Nothing more was sent/);
  assert.strictEqual(app.get('researchEnabled'), false);
  assert.strictEqual(app.store.update_findings.filter(f => f.status === 'pending' && !f.reason).length, 3, 'two updates and the new title stay pending');
  assert.ok(res.results);
  on(app);
  const again = await app.ctx.cuImportFindings(JSON.stringify(doc)); await settle();
  assert.match(again.problems[0], /already imported[\s\S]*continued from Review findings/);
});

test('Continue appears only with access, only on a click: neither loading nor re-enabling sends anything', async () => {
  const { app } = await interrupted();
  const sent = app.writes().length;
  const hidden = await review(app);
  assert.ok(!hidden.includes(LABEL), 'without access it isn’t there');
  assert.ok(!/ZZ Other Name/.test(hidden), 'nor its findings');
  app.ctx.closeCuModal();
  on(app); await settle();
  await app.ctx.cuReadState(); await settle();
  const t = await review(app);
  assert.ok(t.includes(LABEL));
  assert.match(text(t), /Imported updates not applied yet \(2\)/);
  assert.match(text(t), /it may apply the update or leave it for your review, so it doesn't guarantee that every one will apply/);
  assert.match(text(t), /New show: ZZ New Title/, 'a new title stays an ordinary decision');
  assert.strictEqual(app.writes().length, sent, 'nothing was sent');
  assert.ok(!/Apply this date/.test(t), 'no owner override beside it');
});

test('Continue: applies under the automatic rules (never a review decision), then disappears; a second run sends nothing', async () => {
  const { app, tba } = await interrupted();
  on(app);
  await review(app);
  const before = sentApplying(app);
  await app.ctx.cuContinueImported(); await settle();
  assert.strictEqual(sentApplying(app), before + 2);
  assert.ok(rpcs(app, 'library_cu_set_season_date').every(r => r.body.p_review === false), 'never a review decision');
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === tba.id).display_date, 'Jun 5, 2030');
  assert.ok(app.store.record_aliases.some(a => a.alias === 'ZZ Other Name'));
  const t = app.el('cuModalBox').innerHTML;
  assert.ok(!t.includes(LABEL), 'gone');
  assert.match(text(t), /Checked 2 imported updates against your library as it is now\./);
  await app.ctx.cuContinueImported(); await settle();
  assert.strictEqual(sentApplying(app), before + 2, 'nothing left to send');
});

test('Continue reads the library first: a hold added since sends it to review; a changed rule blocks it; neither is offered again', async () => {
  const { app, coll, tba, other } = await interrupted();
  on(app);
  await app.run(`runWrite('h', () => sbRpc('library_cu_save_hold', { p_hold: { kind: 'protected_value', item_id: ${JSON.stringify(tba.id)}, field: 'display_date', protected_value: 'TBA', decision: 'Kept', effect: 'keep_value', reopen: { on: 'owner_only' } } }))`);
  await app.run(`runWrite('d', () => sbRpc('library_cu_save_definition', { p_collection_id: ${JSON.stringify(coll.id)}, p_expected_version: 1, p_mode: 'discover', p_rules: ${JSON.stringify(RULES)}, p_evidence: ${JSON.stringify({ ...EVIDENCE, official_domains: ['other.example.org'] })}, p_summary: 'y' }))`);
  await review(app);
  await app.ctx.cuContinueImported(); await settle();
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === tba.id).display_date, 'TBA', 'the hold kept it');
  assert.ok(!app.store.record_aliases.some(a => a.show_id === other.id));
  const t = app.el('cuModalBox').innerHTML;
  assert.ok(!t.includes(LABEL), 'nothing left to continue');
  assert.match(text(t), /Waiting for more research/);
});

test('Continue: an unclear answer stops the rest; the next run sends only what isn’t applied, so nothing applies twice', async () => {
  const { app, tba } = await interrupted();
  on(app);
  await review(app);
  app.loseNext(r => r.url.endsWith('/rpc/library_cu_set_season_date'), 'after');
  const before = sentApplying(app);
  await app.ctx.cuContinueImported(); await settle();
  assert.strictEqual(sentApplying(app), before + 1, 'nothing more after the unclear answer');
  assert.match(text(app.el('cuModalBox').innerHTML), /no clear answer came back[\s\S]*Nothing more was sent/);
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === tba.id).display_date, 'Jun 5, 2030', 'it did commit');
  assert.ok(app.el('cuModalBox').innerHTML.includes(LABEL), 'the alias is still unfinished');
  const dates = rpcs(app, 'library_cu_set_season_date').length;
  await app.ctx.cuContinueImported(); await settle();
  assert.strictEqual(rpcs(app, 'library_cu_set_season_date').length, dates, 'the date wasn’t sent again');
  assert.ok(app.store.record_aliases.some(a => a.alias === 'ZZ Other Name'));
  assert.ok(!app.el('cuModalBox').innerHTML.includes(LABEL), 'done');
});

test('Continue when access has ended meanwhile: refused once, nothing more is sent, the findings stay', async () => {
  const { app } = await interrupted();
  on(app);
  await review(app);
  const before = sentApplying(app);
  app.research = false;
  await app.ctx.cuContinueImported(); await settle();
  assert.strictEqual(sentApplying(app), before + 1);
  assert.strictEqual(app.get('researchEnabled'), false);
  const t = app.el('cuModalBox').innerHTML;
  assert.ok(!t.includes(LABEL));
  assert.strictEqual(app.store.update_findings.filter(f => f.status === 'pending' && !f.reason).length, 3);
});

test('eligibility: only research findings of the automatic kinds, pending with no reason, whose record still exists', async () => {
  const { app, coll, live, other, tba } = await library();
  const yes = [alias(app, coll, live, 'ZZ Yes'), newSeason(app, coll, live), newDate(app, coll, live, tba),
    alias(app, coll, other, 'ZZ Reopened From Not Now', { decided_at: TS })]; // an import reopening Not now keeps its decision time
  for (const [name, o] of [['applied', { status: 'applied' }], ['accepted', { status: 'accepted' }], ['dismissed', { status: 'dismissed' }], ['not now', { status: 'not_now' }],
    ['excluded', { status: 'excluded' }], ['set aside', { status: 'set_aside' }], ['needs evidence', { status: 'needs_evidence', reason: 'evidence_below_standard' }], ['conflict', { status: 'conflict', reason: 'conflict' }],
    ['needs research', { status: 'needs_research', reason: 'rule_changed' }], ['needs evidence, no reason', { status: 'needs_evidence' }], ['review required', { reason: 'date_needs_review' }], ['held', { reason: 'standing_decision' }],
    ['paused for setup', { reason: 'setup_required' }], ['TMDB', { source: 'tmdb' }]]) alias(app, coll, live, `ZZ No ${name}`, o);
  stored(app, coll, { kind: 'new_show', subject: { title: 'ZZ No New Show' } });
  stored(app, coll, { kind: 'cancellation', show_id: live.id, subject: { title: 'Live' } });
  alias(app, coll, { id: uuid('5a000000'), title: 'Gone' }, 'ZZ No Record');
  newSeason(app, coll, { id: uuid('5a000000'), title: 'Gone' });
  stored(app, coll, { kind: 'date', season_id: uuid('5b000000'), subject: { title: 'Gone' }, proposed: { display_date: 'Jun 5, 2030', date_sort: '2030-06-05' } });
  await review(app);
  const m = app.get('cuModal');
  assert.deepStrictEqual(Array.from(app.ctx.cuUnfinishedFindings(m.lib, m.st)).map(f => f.id).sort(), yes.map(f => f.id).sort());
});

test('no unfinished findings: nothing is shown; dismissing the last one removes the action', async () => {
  const { app, coll, live } = await library();
  assert.ok(!(await review(app)).includes(LABEL));
  app.ctx.closeCuModal();
  const f = alias(app, coll, live, 'ZZ Last');
  assert.ok((await review(app)).includes(LABEL));
  await app.ctx.cuDecide(f.id, 'dismissed'); await settle();
  assert.ok(!app.el('cuModalBox').innerHTML.includes(LABEL));
});

T.run();
