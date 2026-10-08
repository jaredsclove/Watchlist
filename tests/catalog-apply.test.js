// Offline tests for Catalog updates (Stage 4a, catalog-apply.js) in the
// whole-page harness: built-in tabs only read (entry, reload, Retry, after a
// restore); the notice; the freshness check; the preview and the exact apply
// request; the receipt and the bounded read-back (verified or differences);
// stale, busy and refused answers; unknown outcomes (no resend, no attribution,
// apply-then-reversal indistinguishable); archived targets and conflicts in the
// dialog; a database without Stage 4a; format-3 backups after an application.
// The database rules themselves are checked on PGlite (db/test/t_4a_catalog.sql);
// the harness's catalog_apply is an independent stand-in.
// Run from the repo root: node tests/catalog-apply.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('catalog-apply');
const test = T.test;
const writes = app => app.writes().map(r => `${r.method} ${r.url.split('/rest/v1/')[1].split('?')[0]}`);
const box = app => app.el('catalogModalBox').innerHTML;
const text = app => box(app).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const rpcCalls = app => app.requests.filter(r => r.url.includes('/rpc/catalog_apply'));
const openTab = async (app, id) => { app.ctx.switchTab(id); await settle(); };

// Sheridan with its catalog applied, then: one season and one film missing again,
// one season's date and one film's date back to TBA (the catalog now dates them).
async function behind(opts = {}) {
  const app0 = await createApp();
  await app0.applyCatalog('sheridan');
  const defaults = app0.get("COLLECTIONS.find(c => c.id === 'sheridan').defaults");
  const rows = app0.store.watchlist_items;
  const dated = defaults.filter(d => !/TBA/i.test(d.d));
  const seasonDef = dated.find(d => d.s !== 'Film'), filmDef = dated.find(d => d.s === 'Film');
  const missingSeason = dated.filter(d => d.s !== 'Film' && d.k !== seasonDef.k).at(-1), missingFilm = dated.filter(d => d.s === 'Film' && d.k !== filmDef.k).at(-1);
  for (const d of [seasonDef, filmDef]) Object.assign(rows.find(r => r.item_key === d.k), { display_date: 'TBA', date_sort: '2099-01-01' });
  const kept = rows.filter(r => r.item_key !== missingSeason.k && r.item_key !== missingFilm.k);
  const app = await createApp({ rows: kept, tvShows: app0.store.tv_shows, ...opts });
  return { app, seasonDef, filmDef, missingSeason, missingFilm };
}

// ── Read-only tabs ──
test('entry, reload, Retry and the post-restore reload of a built-in tab only read, even with catalog entries waiting', async () => {
  const { app } = await behind();
  await openTab(app, 'sheridan');
  app.ctx.loadTab('sheridan'); await settle();
  app.failNext(r => r.method === 'GET' && r.url.includes('collection=eq.sheridan'));
  app.ctx.loadTab('sheridan'); await settle();
  app.ctx.loadTab('sheridan'); await settle(); // Retry
  app.ctx.finishRestoreAndReload(); await settle();
  assert.deepStrictEqual(app.writes(), []);
  assert.ok(app.el('banner').innerHTML.includes('4 catalog entries are waiting'), app.el('banner').innerHTML);
});

// ── Review, apply, receipt, read-back ──
test('review: freshness check, then a preview; Apply sends the same catalog with the preview hash; receipt read back as verified; the tab reloads by GET', async () => {
  const { app, seasonDef, filmDef, missingSeason, missingFilm } = await behind();
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  const t = text(app);
  assert.match(t, /Applying this catalog would make these changes\. Nothing has changed yet\./);
  assert.match(t, /New seasons \(1\)/); assert.match(t, /New films \(1\)/); assert.match(t, /Date updates \(2\)/);
  assert.match(t, /TBA → /);
  assert.ok(app.requests.some(r => r.url === 'config.js'), 'config.js read again');
  assert.deepStrictEqual(writes(app), ['POST rpc/catalog_apply'], 'the preview is the only call so far');
  const previewHash = app.get('catalogDialog.preview.hash');
  assert.strictEqual(rpcCalls(app)[0].body.p_approved, undefined);
  await app.ctx.catalogApply(); await settle();
  const apply = rpcCalls(app)[1];
  assert.strictEqual(apply.body.p_approved, previewHash);
  assert.deepStrictEqual(apply.body.p_defaults, rpcCalls(app)[0].body.p_defaults);
  assert.match(text(app), /Applied 4 changes\./);
  assert.match(text(app), /Verified: every applied change was read back as approved\./);
  assert.deepStrictEqual(writes(app), ['POST rpc/catalog_apply', 'POST rpc/catalog_apply'], 'read-back and reload are GETs');
  const rc = app.get('catalogDialog.result.receipt');
  assert.ok(app.store.watchlist_items.some(r => r.id === rc[Object.keys(rc).find(k => k.startsWith('insert_film:'))].row_id && r.item_key === missingFilm.k));
  assert.ok(app.store.watchlist_items.some(r => r.item_key === missingSeason.k));
  for (const d of [seasonDef, filmDef]) assert.strictEqual(app.store.watchlist_items.find(r => r.item_key === d.k).display_date, d.d);
  app.ctx.closeCatalogUpdates(); await settle();
  assert.strictEqual(app.el('banner').innerHTML, '', 'nothing waiting now');
});

test('read-back reports differences instead of "verified" when a record changed after the commit', async () => {
  const { app, seasonDef } = await behind();
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  const g = app.hold(readBackRead);
  const done = app.ctx.catalogApply();
  await g.reached;
  app.store.watchlist_items.find(r => r.item_key === seasonDef.k).display_date = 'TBA again';
  g.release(); await done; await settle();
  assert.match(text(app), /Applied, but reading back found differences \(possibly later edits\):/);
  assert.ok(!/Verified/.test(text(app)));
});

test('a page whose catalog is older than the published one offers no Apply and calls nothing', async () => {
  const fs = require('fs');
  const cfg = fs.readFileSync(require('path').join(__dirname, '..', 'config.js'), 'utf8').replace('k:"yellowstone|season 1",t:"Yellowstone"', 'k:"yellowstone|season 1",t:"Yellowstone (renamed)"');
  const { app } = await behind({ configText: cfg });
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  assert.match(text(app), /This page has an older catalog than the one published\. Reload the page and review again\. Nothing was changed\./);
  assert.strictEqual(rpcCalls(app).length, 0);
  assert.ok(!box(app).includes('catalogApply()'));
});

// The read-back's complete read of the tab's rows (Range-paginated, unlike the tab load).
const readBackRead = r => r.method === 'GET' && r.url.includes('/watchlist_items?') && r.url.includes('collection=eq.sheridan') && !!r.headers.Range;

test('read-back compares every approved value: a new film’s later title, status and watched changes are reported, not verified', async () => {
  const { app, missingFilm } = await behind();
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  const g = app.hold(readBackRead);
  const done = app.ctx.catalogApply();
  await g.reached;
  Object.assign(app.store.watchlist_items.find(r => r.item_key === missingFilm.k), { title: 'ZZ Renamed', status: 'skipped', watched: true });
  g.release(); await done; await settle();
  const t = text(app);
  assert.match(t, /reading back found differences/);
  assert.ok(t.includes(`${missingFilm.k}: title, status, watched differ from what was approved`), t);
  assert.ok(!/Verified/.test(t));
});

test('read-back: an incomplete receipt and a membership in another collection are differences', async () => {
  const { app, missingFilm } = await behind();
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  const real = app.rpcHandlers.catalog_apply;
  app.rpcHandlers.catalog_apply = body => {
    const res = real(body);
    if (body.p_approved == null) return res;
    return { ...res, text: async () => { const j = JSON.parse(await res.text()); delete j.receipt[Object.keys(j.receipt).find(k => k.startsWith('fill_date:'))]; return JSON.stringify(j); } };
  };
  const g = app.hold(readBackRead);
  const done = app.ctx.catalogApply();
  await g.reached;
  const film = app.store.watchlist_items.find(r => r.item_key === missingFilm.k);
  const other = app.store.personal_collections.find(c => c.legacy_source === 'disney');
  app.store.collection_memberships.find(m => m.item_id === film.id).collection_id = other.id;
  g.release(); await done; await settle();
  const t = text(app);
  assert.match(t, /the receipt doesn’t list exactly the approved changes/);
  assert.match(t, /F1: not exactly in its approved collection/);
});

test('check state after a lost reply: a different exact date on the approved row is not "present"; the differences are named; nothing resent', async () => {
  const { app, seasonDef } = await behind();
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  loseReply(app, { commit: false });
  await app.ctx.catalogApply(); await settle();
  Object.assign(app.store.watchlist_items.find(r => r.item_key === seasonDef.k), { display_date: 'Dec 31, 2030', date_sort: '2030-12-31' });
  await app.ctx.catalogCheckState(); await settle();
  const t = text(app);
  assert.ok(!/now includes these changes/.test(t), t);
  assert.match(t, /matches neither the approved changes nor the state before them, so the earlier result is still unknown/);
  assert.ok(t.includes(`${seasonDef.k}: the date is Dec 31, 2030, not ${seasonDef.d}`), t);
  assert.strictEqual(rpcCalls(app).filter(r => r.body.p_approved).length, 1, 'not resent');
});

test('check state: "present" needs every approved outcome exactly; a committed apply whose new film was later edited is not "present"', async () => {
  const { app, missingFilm } = await behind();
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  loseReply(app, { commit: true });
  await app.ctx.catalogApply(); await settle();
  app.store.watchlist_items.find(r => r.item_key === missingFilm.k).status = 'skipped';
  await app.ctx.catalogCheckState(); await settle();
  const t = text(app);
  assert.ok(!/now includes these changes/.test(t), t);
  assert.ok(t.includes(`${missingFilm.k}: status differs from what was approved`), t);
});

// ── Verification audit: every approved outcome field and receipt value (table-driven) ──
// A Sheridan library behind its catalog with every kind of effect: show A missing
// entirely (create_show, its seasons, membership), show B Complete with its latest
// season missing (attach, insert_season, reopen), a season and a film back to TBA
// (fill_date), a film missing (insert_film, membership).
async function rich({ archived = false } = {}) {
  const app0 = await createApp();
  await app0.applyCatalog('sheridan');
  const rows = app0.store.watchlist_items, shows = app0.store.tv_shows;
  const defs = app0.get("COLLECTIONS.find(c => c.id === 'sheridan').defaults");
  const multi = shows.filter(x => rows.filter(r => r.show_id === x.id).length >= 2);
  const [A, B] = multi;
  const bDrop = rows.filter(r => r.show_id === B.id).sort((x, y) => y.date_sort.localeCompare(x.date_sort))[0];
  const seasonFillDef = defs.find(d => d.s !== 'Film' && !/TBA/i.test(d.d) && ![A.id, B.id].includes((rows.find(r => r.item_key === d.k) || {}).show_id));
  const filmFillDef = defs.find(d => d.s === 'Film' && !/TBA/i.test(d.d));
  const missingFilmDef = defs.filter(d => d.s === 'Film' && !/TBA/i.test(d.d) && d.k !== filmFillDef.k).at(-1);
  for (const d of [seasonFillDef, filmFillDef]) Object.assign(rows.find(r => r.item_key === d.k), { display_date: 'TBA', date_sort: '2099-01-01' });
  B.status = 'complete';
  const kept = rows.filter(r => r.show_id !== A.id && r.id !== bDrop.id && r.item_key !== missingFilmDef.k);
  const app = await createApp({ rows: kept, tvShows: shows.filter(x => x.id !== A.id) });
  if (archived) app.store.personal_collections.find(c => c.legacy_source === 'sheridan').archived_at = '2026-10-08T00:00:00+00:00';
  return { app, A, B, bDrop, seasonFillDef, filmFillDef, missingFilmDef };
}
// Applies through the dialog; mutate(store, result) runs right after the commit, before the read-back.
async function verifyAfter(app, mutate) {
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  const real = app.rpcHandlers.catalog_apply;
  app.rpcHandlers.catalog_apply = body => {
    const res = real(body);
    if (body.p_approved == null) return res;
    app.rpcHandlers.catalog_apply = real;
    return { ...res, text: async () => { const j = JSON.parse(await res.text()); mutate(app.store, j); return JSON.stringify(j); } };
  };
  await app.ctx.catalogApply(); await settle();
  return { state: app.get('catalogDialog.readBack.state'), diffs: app.get('catalogDialog.readBack.differences') || [], text: text(app) };
}
const rowByKey = (st, k) => st.watchlist_items.find(r => r.item_key === k);
const receiptKey = (j, prefix) => Object.keys(j.receipt).find(k => k.startsWith(prefix));
const flip = v => (typeof v === 'boolean' ? !v : typeof v === 'number' ? v + 1000 : v == null ? 'zz' : `${v} (changed)`);

test('verification audit: with no change after the commit, every kind of effect reads back as verified', async () => {
  const { app } = await rich();
  const r = await verifyAfter(app, () => {});
  assert.strictEqual(r.state, 'verified', JSON.stringify(r.diffs));
  const kinds = new Set(app.get('catalogDialog.result.document.entries').map(e => e.kind));
  for (const k of ['create_show', 'attach', 'insert_season', 'insert_film', 'fill_date', 'reopen', 'membership', 'noop']) assert.ok(kinds.has(k), `fixture lacks ${k}`);
});

const SEASON_FIELDS = ['title', 'season', 'theme', 'display_date', 'date_sort', 'status', 'watched', 'skipped', 'media_type', 'tmdb_id', 'season_number'];
const FILM_FIELDS = ['title', 'season', 'theme', 'display_date', 'date_sort', 'status', 'watched', 'media_type', 'tmdb_id'];
const AUDIT = [
  ...['title', 'tmdb_id', 'status'].map(f => [`create_show ${f}`, (st, j, x) => { const s = st.tv_shows.find(y => y.id === j.receipt['create_show:S1'].show_id); s[f] = f === 'status' ? 'skipped' : flip(s[f]); }, 'new show']),
  ['attach status (reopened show)', (st, j, x) => { st.tv_shows.find(y => y.id === x.B.id).status = 'watching'; }, 'status differs'],
  ['reopen: show not On List', (st, j, x) => { st.tv_shows.find(y => y.id === x.B.id).status = 'skipped'; }, 'is not On List'],
  ...SEASON_FIELDS.map(f => [`insert_season ${f}`, (st, j, x) => { const r = rowByKey(st, x.bDrop.item_key); r[f] = flip(r[f]); }, `${f} differ`]),
  ['insert_season show link', (st, j, x) => { rowByKey(st, x.bDrop.item_key).show_id = x.A.id; }, 'not linked to the approved show'],
  ...FILM_FIELDS.map(f => [`insert_film ${f}`, (st, j, x) => { const r = rowByKey(st, x.missingFilmDef.k); r[f] = flip(r[f]); }, `${f} differ`]),
  ['insert_film show link', (st, j, x) => { rowByKey(st, x.missingFilmDef.k).show_id = x.B.id; }, 'linked to a show'],
  ['fill_date season date', (st, j, x) => { rowByKey(st, x.seasonFillDef.k).display_date = 'Dec 31, 2030'; }, 'the date is Dec 31, 2030'],
  ['fill_date season sort date', (st, j, x) => { rowByKey(st, x.seasonFillDef.k).date_sort = '2030-12-31'; }, 'the date is'],
  ['fill_date season watched', (st, j, x) => { rowByKey(st, x.seasonFillDef.k).watched = true; }, 'watched differs'],
  ['fill_date season skipped', (st, j, x) => { rowByKey(st, x.seasonFillDef.k).skipped = true; }, 'skipped differs'],
  ['fill_date season parent show status (confirmed → skipped)', (st, j, x) => { const r = rowByKey(st, x.seasonFillDef.k); st.tv_shows.find(y => y.id === r.show_id).status = 'skipped'; }, 'its show\'s status differs'],
  ['fill_date season parent link', (st, j, x) => { rowByKey(st, x.seasonFillDef.k).show_id = x.B.id; }, 'not linked to the approved show'],
  ['fill_date film status', (st, j, x) => { rowByKey(st, x.filmFillDef.k).status = 'skipped'; }, 'status differs'],
  ['fill_date film watched', (st, j, x) => { rowByKey(st, x.filmFillDef.k).watched = !rowByKey(st, x.filmFillDef.k).watched; }, 'watched differs'],
  ['fill_date film link', (st, j, x) => { rowByKey(st, x.filmFillDef.k).show_id = x.B.id; }, 'linked to a show'],
  ['membership joined: removed', (st, j, x) => { const f = rowByKey(st, x.missingFilmDef.k); st.collection_memberships = st.collection_memberships.filter(m => m.item_id !== f.id); }, 'not exactly in its approved collection'],
  ['membership joined: another collection too', (st, j, x) => { const f = rowByKey(st, x.missingFilmDef.k); st.collection_memberships.push({ id: 'zz-m', collection_id: st.personal_collections.find(c => c.legacy_source === 'disney').id, show_id: null, item_id: f.id }); }, 'not exactly in its approved collection'],
  ['noop row no longer stored', (st, j, x) => { const keep = new Set(Object.values(j.receipt).map(v => v.row_id).filter(Boolean)); const fills = [x.seasonFillDef.k, x.filmFillDef.k]; const r = st.watchlist_items.find(w => w.collection === 'sheridan' && !keep.has(w.id) && !fills.includes(w.item_key)); st.watchlist_items = st.watchlist_items.filter(w => w !== r); }, 'no longer stored'],
  ['receipt create_show show_id', (st, j) => { j.receipt['create_show:S1'].show_id = 'zz-other'; }, 'new show'],
  ['receipt insert_season row_id', (st, j) => { j.receipt[receiptKey(j, 'insert_season:')].row_id = 'zz-other'; }, 'the receipt names another row'],
  ['receipt insert_season show_id', (st, j) => { j.receipt[receiptKey(j, 'insert_season:')].show_id = 'zz-other'; }, 'the receipt names another show'],
  ['receipt insert_film row_id', (st, j) => { j.receipt['insert_film:F1'].row_id = 'zz-other'; }, 'the receipt names another row'],
  ['receipt fill_date row_id', (st, j) => { j.receipt[receiptKey(j, 'fill_date:')].row_id = 'zz-other'; }, 'the receipt names another row'],
  ['receipt reopen show_id', (st, j) => { j.receipt[receiptKey(j, 'reopen:')].show_id = 'zz-other'; }, 'the receipt names another reopened show'],
  ['receipt membership_id', (st, j) => { j.receipt['membership:F1'].membership_id = 'zz-other'; }, 'the receipt names another membership'],
  ['receipt missing an entry', (st, j) => { delete j.receipt[receiptKey(j, 'fill_date:')]; }, 'the receipt doesn’t list exactly the approved changes'],
  ['receipt with an extra entry', (st, j) => { j.receipt['insert_film:F9'] = { row_id: 'zz' }; }, 'the receipt doesn’t list exactly the approved changes']
];
for (const [name, mutate, expect] of AUDIT) {
  test(`verification audit: ${name} → a named difference, not verified`, async () => {
    const x = await rich();
    const r = await verifyAfter(x.app, (st, j) => mutate(st, j, x));
    assert.strictEqual(r.state, 'differs', `${name}: ${r.state} ${JSON.stringify(r.diffs)}`);
    assert.ok(r.diffs.some(d => d.includes(expect)), `${name}: ${JSON.stringify(r.diffs)}`);
  });
}

test('verification audit, archived target: a membership added later, or a receipt naming one, is a difference', async () => {
  for (const [mutate, expect] of [
    [(st, j, x) => { const f = rowByKey(st, x.missingFilmDef.k); st.collection_memberships.push({ id: 'zz-m', collection_id: st.personal_collections.find(c => c.legacy_source === 'sheridan').id, show_id: null, item_id: f.id }); }, 'though the approved result was to stay out of the archived one'],
    [(st, j) => { j.receipt['membership:F1'].membership_id = 'zz-m'; }, 'the receipt names a membership, though none was approved'],
    [(st, j, x) => { st.personal_collections.find(c => c.legacy_source === 'sheridan').archived_at = null; }, 'archive state differs']
  ]) {
    const x = await rich({ archived: true });
    const r = await verifyAfter(x.app, (st, j) => mutate(st, j, x));
    assert.strictEqual(r.state, 'differs', JSON.stringify(r.diffs));
    assert.ok(r.diffs.some(d => d.includes(expect)), JSON.stringify(r.diffs));
  }
});

test('verification reads are strict: an empty membership answer without an exact count leaves the result unverified, never "absent"', async () => {
  const x = await rich({ archived: true });
  const realFetch = x.app.ctx.fetch;
  x.app.ctx.fetch = async (url, opts) => (String(url).includes('/collection_memberships?')
    ? { ok: true, status: 200, text: async () => '[]', json: async () => [], headers: { get: () => null } }
    : realFetch(url, opts));
  const r = await verifyAfter(x.app, (st, j) => { const f = rowByKey(st, x.missingFilmDef.k); st.collection_memberships.push({ id: 'zz-m', collection_id: st.personal_collections.find(c => c.legacy_source === 'sheridan').id, show_id: null, item_id: f.id }); });
  assert.strictEqual(r.state, 'unread', JSON.stringify(r));
  assert.match(r.text, /couldn’t be read back to verify/);
  assert.ok(!/Verified/.test(r.text));
});

test('check state uses the same comparison: a lost committed apply whose dated season’s show was later Skipped is not "present"; an incomplete read stays unknown', async () => {
  const x = await rich();
  await openTab(x.app, 'sheridan');
  x.app.ctx.openCatalogUpdates('sheridan'); await settle();
  loseReply(x.app, { commit: true });
  await x.app.ctx.catalogApply(); await settle();
  const r = rowByKey(x.app.store, x.seasonFillDef.k);
  x.app.store.tv_shows.find(y => y.id === r.show_id).status = 'skipped';
  await x.app.ctx.catalogCheckState(); await settle();
  assert.ok(!/now includes these changes/.test(text(x.app)), text(x.app));
  assert.ok(text(x.app).includes(`${x.seasonFillDef.k}: its show's status differs`), text(x.app));
  const realFetch = x.app.ctx.fetch;
  x.app.ctx.fetch = async (url, opts) => (String(url).includes('/tv_shows?')
    ? { ok: true, status: 200, text: async () => '[]', json: async () => [], headers: { get: () => null } } : realFetch(url, opts));
  await x.app.ctx.catalogCheckState(); await settle();
  assert.match(text(x.app), /We couldn’t confirm the result \(Couldn't read the current state/);
});

// ── Refusals ──
test('stale: a film Skip between preview and apply → refused, nothing written; Review again shows the new preview', async () => {
  const { app, filmDef } = await behind();
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  app.store.watchlist_items.find(r => r.item_key === filmDef.k).status = 'skipped';
  const before = JSON.stringify(app.store.watchlist_items);
  await app.ctx.catalogApply(); await settle();
  assert.match(text(app), /changed since this preview, so nothing was changed/);
  assert.strictEqual(JSON.stringify(app.store.watchlist_items), before);
  app.ctx.catalogReview(); await settle();
  assert.match(text(app), /skipped; stays skipped/, 'the skipped film is still eligible for its date and shown as skipped');
});

test('busy: nothing written, no automatic retry', async () => {
  const { app } = await behind();
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  app.catalogBusyNext = 1;
  const before = JSON.stringify(app.store.watchlist_items);
  await app.ctx.catalogApply(); await settle();
  assert.match(text(app), /The database was busy, so nothing was changed/);
  assert.strictEqual(rpcCalls(app).length, 2);
  assert.strictEqual(JSON.stringify(app.store.watchlist_items), before);
});

// ── Unknown outcomes ──
function loseReply(app, { commit }) {
  const real = app.rpcHandlers.catalog_apply;
  app.rpcHandlers.catalog_apply = body => {
    if (body.p_approved == null) return real(body);
    app.rpcHandlers.catalog_apply = real;
    if (commit) real(body);
    throw new TypeError('Failed to fetch');
  };
}
test('no reply after a committed apply: unknown, never resent; Check current state says the library holds the changes without saying who made them', async () => {
  const { app } = await behind();
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  loseReply(app, { commit: true });
  await app.ctx.catalogApply(); await settle();
  assert.match(text(app), /We couldn’t confirm the result \(Failed to fetch\)\. Your request may still finish, may have finished, or may have been stopped\. It won’t be sent again automatically\./);
  await settle(50);
  assert.strictEqual(rpcCalls(app).filter(r => r.body.p_approved).length, 1, 'not resent');
  await app.ctx.catalogCheckState(); await settle();
  assert.match(text(app), /Your library now includes these changes\. This page can’t tell whether its own request or another one made them\./);
});

test('no reply and nothing committed: "aren’t in your library right now", never "not applied"; the same as applied-then-undone; applying again is the owner’s choice', async () => {
  const { app } = await behind();
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  loseReply(app, { commit: false });
  await app.ctx.catalogApply(); await settle();
  await app.ctx.catalogCheckState(); await settle();
  const t = text(app);
  assert.match(t, /These changes aren’t in your library right now\. Your earlier request may still finish, or may have been stopped; this can’t be told apart from changes that were applied and later undone\./);
  assert.ok(!/not applied/i.test(t));
  assert.strictEqual(rpcCalls(app).filter(r => r.body.p_approved).length, 1);
  app.ctx.catalogApplyChecked(); await settle();
  assert.match(text(app), /Applied 4 changes\./);
});

test('applied, then undone elsewhere: Check current state can’t tell it from never applied', async () => {
  const { app } = await behind();
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  const snapshot = JSON.parse(JSON.stringify({ w: app.store.watchlist_items, s: app.store.tv_shows, m: app.store.collection_memberships }));
  loseReply(app, { commit: true });
  await app.ctx.catalogApply(); await settle();
  Object.assign(app.store, { watchlist_items: snapshot.w, tv_shows: snapshot.s, collection_memberships: snapshot.m }); // reversed
  await app.ctx.catalogCheckState(); await settle();
  assert.match(text(app), /can’t be told apart from changes that were applied and later undone/);
});

// ── Memberships and conflicts in the dialog ──
test('archived target: the preview says new items won’t join it; the receipt has no membership and the read-back verifies that', async () => {
  const { app } = await behind();
  app.store.personal_collections.find(c => c.legacy_source === 'sheridan').archived_at = '2026-10-08T00:00:00+00:00';
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  assert.match(text(app), /won’t join Sheridan \(archived\)/);
  await app.ctx.catalogApply(); await settle();
  assert.match(text(app), /Verified/);
  const rc = app.get('catalogDialog.result.receipt');
  assert.ok(Object.keys(rc).filter(k => k.startsWith('membership:')).every(k => rc[k].membership_id === 'none'));
});

test('conflicts are listed as not included and reported as such after applying', async () => {
  const app0 = await createApp();
  await app0.applyCatalog('sheridan');
  const shows = app0.store.tv_shows, rows = app0.store.watchlist_items;
  const mayor = shows.find(x => x.show_key === 'mayor of kingstown');
  mayor.tmdb_id = 97951;
  for (const r of rows.filter(x => x.show_id === mayor.id)) { const m = /^Season (\d+)$/.exec(r.season); if (m) Object.assign(r, { media_type: 'tv', tmdb_id: 97951, season_number: Number(m[1]) }); }
  const drop = rows.find(r => r.show_id === mayor.id && r.media_type == null);
  const missing = rows.filter(r => r.season === 'Film').at(-1);
  const app = await createApp({ rows: rows.filter(r => r !== drop && r !== missing), tvShows: shows });
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  assert.match(text(app), /1 entry is not included; it needs review\./);
  assert.match(text(app), /Not included — needs review \(1\)/);
  await app.ctx.catalogApply(); await settle();
  assert.match(text(app), /Applied 1 change; 1 entry not included \(listed below\)\./);
});

test('an identified row holding a catalog key keeps it a no-op (the harness follows the SQL rule): no new film, no membership', async () => {
  const { app, missingFilm } = await behind();
  app.store.watchlist_items.push({ id: 'zz-identified', collection: 'sheridan', item_key: missingFilm.k, title: missingFilm.t, season: 'Film', theme: 'Drama',
    display_date: missingFilm.d, date_sort: missingFilm.ds, status: 'confirmed', watched: false, media_type: 'movie', tmdb_id: 990001, season_number: null,
    show_id: null, skipped: false, watch_with: [], collections: [] });
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  const doc = app.get('catalogDialog.preview.document');
  assert.ok(!doc.entries.some(e => e.kind === 'insert_film' || e.kind === 'membership'), JSON.stringify(doc.entries.filter(e => e.kind !== 'noop')));
  assert.strictEqual(doc.entries.find(e => e.key === `noop:${missingFilm.k}`).category, 'identified');
});

test('closing the dialog returns keyboard focus to the redrawn Review button, or to the open tab once nothing is waiting', async () => {
  const { app } = await behind();
  await openTab(app, 'sheridan');
  const focused = [];
  const realGet = app.ctx.document.getElementById;
  app.ctx.document.querySelector = sel => (sel === '#banner .catalog-banner button' && app.el('banner').innerHTML.includes('Review') ? { focus: () => focused.push('review') }
    : sel === '#tabBar .tab.active' ? { focus: () => focused.push('tab') } : null);
  app.ctx.openCatalogUpdates('sheridan', { isConnected: false }); await settle();
  app.ctx.closeCatalogUpdates(); await settle();
  app.ctx.openCatalogUpdates('sheridan', { isConnected: false }); await settle();
  await app.ctx.catalogApply(); await settle();
  app.ctx.closeCatalogUpdates(); await settle();
  assert.deepStrictEqual(focused, ['review', 'tab']);
  app.ctx.document.getElementById = realGet;
});

test('a redraw keeps keyboard focus inside the dialog (preview → applied); conflicts show the catalog title and label', async () => {
  const app0 = await createApp();
  await app0.applyCatalog('sheridan');
  const shows = app0.store.tv_shows, rows = app0.store.watchlist_items;
  const mayor = shows.find(x => x.show_key === 'mayor of kingstown');
  mayor.tmdb_id = 97951;
  for (const r of rows.filter(x => x.show_id === mayor.id)) { const m = /^Season (\d+)$/.exec(r.season); if (m) Object.assign(r, { media_type: 'tv', tmdb_id: 97951, season_number: Number(m[1]) }); }
  const drop = rows.find(r => r.show_id === mayor.id && r.media_type == null);
  const app = await createApp({ rows: rows.filter(r => r !== drop), tvShows: shows });
  await openTab(app, 'sheridan');
  const boxEl = app.el('catalogModalBox');
  let focusedBox = 0;
  boxEl.focus = () => { focusedBox++; };
  boxEl.contains = () => true;
  app.ctx.document.activeElement = app.ctx.document.body = {};
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  const before = focusedBox;
  assert.ok(before >= 1);
  app.ctx.renderCatalogDialog();
  assert.ok(focusedBox > before, 'refocused after a redraw');
  assert.match(text(app), new RegExp(`Mayor of Kingstown · ${drop.season.replace(/[()]/g, '\\$&')}`));
  assert.ok(!text(app).includes('mayor of kingstown|'), 'not the raw key');
});

// ── Compatibility ──
test('a database without Stage 4a: tabs still only read; Review says catalog updates aren’t available, nothing written', async () => {
  const { app } = await behind({ catalog4a: false });
  await openTab(app, 'sheridan');
  app.ctx.openCatalogUpdates('sheridan'); await settle();
  assert.match(text(app), /Catalog updates aren’t available on this database yet\. Nothing was changed\./);
  assert.deepStrictEqual(app.writes().filter(r => !r.url.includes('/rpc/catalog_apply')), []);
});

test('a backup taken after an application is format 3 and holds the applied rows (validation and restore: db/test/t_4a_catalog.sql, real ids)', async () => {
  const { app, missingSeason, missingFilm } = await behind();
  await app.applyCatalog('sheridan');
  const b = await app.ctx.buildBackupObject();
  assert.strictEqual(b.formatVersion, 3);
  assert.deepStrictEqual(Object.keys(b.tables).sort(), ['collection_memberships', 'custom_collections', 'othertv_shows', 'personal_collections', 'tv_shows', 'watch_with_choices', 'watchlist_items']);
  for (const d of [missingSeason, missingFilm]) assert.ok(b.tables.watchlist_items.some(r => r.item_key === d.k));
});

T.run();
