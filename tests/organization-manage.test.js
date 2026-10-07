// Offline tests for Manage collections (Stage 3b-2, organization-manage.js): the
// read-only capability check, the editor's complete reads and count meanings,
// inconsistent reads, every write and its refusals, guarded edits, unknown
// outcomes (no automatic resubmission; a matching state never clears "wasn't
// confirmed"; a late definitive reply resolves it), Undo only for changes this page
// made, the reply guards and the write barrier, per-kind stale flags, pending-write
// close behaviour, restore, safe rendering, and that tracking is never written.
// Run from the repo root: node tests/organization-manage.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('organization-manage');
const test = T.test;
const TS = '2026-10-01T00:00:00+00:00';
const uuid = (p, n) => `${p}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let n = 0;
const show = (o, seasons) => {
  const id = uuid('5a', ++n);
  const s = { id, collection: 'disney', title: 'Show', show_key: (o.title || 'show').toLowerCase(), tmdb_id: null, status: 'confirmed', created_at: TS, ...o };
  const rows = seasons.map(label => ({ id: uuid('5b', ++n), collection: s.collection, item_key: `${s.show_key}|${label.toLowerCase()}`, title: s.title,
    season: label, theme: 'Drama', display_date: 'Jan 1, 2020', date_sort: '2020-01-01', watched: false, status: 'confirmed', created_at: TS,
    watch_with: [], collections: [], tmdb_collection_id: null, tmdb_collection_name: null, media_type: null, tmdb_id: null, season_number: null,
    show_id: id, skipped: false }));
  return { show: s, rows };
};
const film = o => ({ id: uuid('f0', ++n), collection: 'movies', item_key: `film ${n}|film`, title: 'Film', season: 'Film', theme: 'Drama',
  display_date: 'Jan 1, 2020', date_sort: '2020-01-01', watched: false, status: 'confirmed', created_at: TS, watch_with: [], collections: [],
  tmdb_collection_id: null, tmdb_collection_name: null, media_type: 'movie', tmdb_id: 7000 + n, season_number: null, show_id: null, skipped: false, ...o });
function library() {
  const parts = [
    show({ title: 'Andor', status: 'watching' }, ['Season 1', 'Season 2']),
    show({ title: 'Tulsa King', collection: 'sheridan' }, ['Season 1']),
    show({ title: 'Severance', collection: 'othertv', tmdb_id: 95396 }, ['Season 1', 'Season 2', 'Specials']),
    film({ title: 'Sicario', collection: 'sheridan', media_type: null, tmdb_id: null }),
    film({ title: 'Wind River', watch_with: ['Rina'] }),
    film({ title: 'Dune', watch_with: ['Suzanne', 'Rina'] }),
    film({ title: 'Skipped Film', status: 'skipped' })
  ];
  const rows = parts.flatMap(x => x.rows || [x]);
  // a TV season carrying a watch-with value too (usage counts cover every tab)
  rows.find(r => r.title === 'Andor').watch_with = ['Rina'];
  // a row that is neither a TV season nor a film (unclassified)
  rows.push({ ...film({ title: 'Severance Notes', collection: 'movies' }), media_type: null, season: 'Notes', tmdb_id: null });
  return { rows, shows: parts.filter(x => x.show).map(x => x.show) };
}
const boot = (opts = {}) => { const d = library(); return createApp({ rows: d.rows, tvShows: d.shows, ...opts }); };
const box = app => app.el('manageModalBox').innerHTML;
const text = app => box(app).replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const rpc = (app, name) => app.requests.filter(r => r.url.includes(`/rpc/${name}`));
const writesSince = (app, i) => app.requests.slice(i).filter(r => r.method !== 'GET');
const coll = (app, source) => app.store.personal_collections.find(c => c.legacy_source === source);
const open = async (app, view = 'collections', id) => { app.ctx.openManage(view, id); await settle(); };
const state = app => app.get('manage');
const typeInto = (app, id, value) => app.run(`manageDraft({ id: ${JSON.stringify(id)}, value: ${JSON.stringify(value)} })`);
const showByTitle = (app, t) => app.store.tv_shows.find(s => s.title === t);
const rowByTitle = (app, t) => app.store.watchlist_items.find(r => r.title === t);
// A handler that performs the database's work but whose reply never arrives (no answer).
const lostReply = (app, name, after) => {
  const original = app.rpcHandlers[name];
  app.rpcHandlers[name] = body => { original(body); if (after) after(); app.rpcHandlers[name] = original; throw new TypeError('Failed to fetch'); };
};
// A handler whose request never reached the database (no answer, nothing done).
const neverArrived = (app, name) => {
  const original = app.rpcHandlers[name];
  app.rpcHandlers[name] = () => { app.rpcHandlers[name] = original; throw new TypeError('Failed to fetch'); };
};

// ── capability (read-only) ──
test('opening: a GET capability check first (never a change), then complete reads; the editor lists collections in order with counts', async () => {
  const app = await boot();
  const i = app.requests.length;
  await open(app);
  const sent = app.requests.slice(i);
  assert.strictEqual(sent[0].method, 'GET');
  assert.ok(sent[0].url.includes('/rpc/org_capabilities'));
  assert.deepStrictEqual(writesSince(app, i), [], 'nothing but GETs');
  for (const t of ['personal_collections', 'collection_memberships', 'watch_with_choices', 'tv_shows', 'watchlist_items']) {
    assert.ok(sent.some(r => r.url.includes(`/rest/v1/${t}?`)), `reads ${t}`);
  }
  assert.match(text(app), /Disney\+ 1 show · 0 films/);
  assert.match(text(app), /Sheridan 1 show · 1 film/);
  assert.ok(text(app).indexOf('Disney+') < text(app).indexOf('Sheridan') && text(app).indexOf('Sheridan') < text(app).indexOf('90 Day'));
});

test('capability: a database without the functions (PGRST202) shows "isn’t available yet" and no editor; nothing is sent', async () => {
  const app = await boot({ orgWrite: false });
  const i = app.requests.length;
  await open(app);
  assert.match(text(app), /Editing collections isn’t available on this database yet/);
  assert.ok(!/New collection/.test(text(app)));
  assert.deepStrictEqual(writesSince(app, i), []);
});

test('capability: permission refused and no answer are told apart from a missing function, with Check again', async () => {
  const app = await boot();
  app.rpcHandlers.org_capabilities = () => ({ ok: false, status: 401, text: async () => JSON.stringify({ code: '42501', message: 'permission denied' }), headers: { get: () => null } });
  await open(app);
  assert.match(text(app), /The database refused access to collection editing/);
  app.ctx.closeManage();
  app.rpcHandlers.org_capabilities = () => { throw new TypeError('Failed to fetch'); };
  await open(app);
  assert.match(text(app), /Couldn’t check whether editing is available/);
  assert.match(box(app), /manageRecheck\(\)">Check again/);
});

// ── reads and counts ──
test('counts: stored seasons from the rows (Specials included); watch-with usage across every tab', async () => {
  const app = await boot();
  await open(app, 'members', coll(app, 'disney').id);
  typeInto(app, 'manageMemberSearch', 'sev'); await settle();
  assert.match(text(app), /Add show \(all 3 stored seasons, and any added later\)/);
  app.ctx.manageShow('choices'); await settle();
  assert.match(text(app), /Rina used on 3 saved items/, 'two films and a TV season');
  assert.match(text(app), /Suzanne used on 1 saved item\b/);
});

test('inconsistent read: a membership whose show or collection wasn’t read is reported (no name needed), not shown, and Add/Remove are disabled', async () => {
  const app = await boot();
  const d = coll(app, 'disney');
  app.store.collection_memberships.push({ id: uuid('0d', 990), collection_id: d.id, show_id: uuid('5a', 999), item_id: null, created_at: TS });
  app.store.collection_memberships.push({ id: uuid('0d', 991), collection_id: uuid('0c', 999), show_id: showByTitle(app, 'Andor').id, item_id: null, created_at: TS });
  await open(app);
  assert.match(text(app), /This read didn’t include 1 member of Disney\+\. Something may have changed while reading\. This does not mean anything was deleted; this read changed nothing\./);
  assert.match(text(app), /This read found 1 membership in a collection it couldn’t read\. Something may have changed while reading\. This does not mean anything was deleted; this read changed nothing\./);
  app.ctx.manageEditMembers(d.id); await settle();
  assert.match(box(app), /aria-label="Remove Andor from Disney\+"\s*disabled|disabled aria-label="Remove Andor/);
  assert.ok(/<input id="manageMemberSearch"[^>]*disabled/.test(box(app)), 'search disabled');
  assert.ok(app.store.collection_memberships.some(m => m.id === uuid('0d', 990)), 'never repaired (still in the database, unchanged)');
});

test('loading and a failed read show no editor; Retry reads again', async () => {
  const app = await boot();
  app.failNext(r => r.url.includes('/rest/v1/collection_memberships?'));
  await open(app);
  assert.match(text(app), /Couldn’t load your collections/);
  assert.ok(!/New collection/.test(text(app)));
  app.ctx.manageReadAgain(); await settle();
  assert.match(text(app), /New collection/);
});

// ── create, rename, archive ──
test('create: trimmed name sent with a page-chosen id; Created; a post-write read publishes it to the selector; tracking untouched', async () => {
  const app = await boot();
  await open(app);
  const i = app.requests.length;
  typeInto(app, 'manageNewCollection', '  Favourites  ');
  app.ctx.manageCreate('collection'); await settle();
  const call = rpc(app, 'org_create_collection')[0];
  assert.strictEqual(call.body.p_name, 'Favourites');
  assert.match(call.body.p_id, /^[0-9a-f-]{36}$/);
  assert.match(text(app), /Created\./);
  assert.ok(app.el('browseBar').innerHTML.includes('>Favourites</option>'), 'selector updated from a read');
  assert.ok(writesSince(app, i).every(r => r.url.includes('/rpc/org_')), 'only organization functions written');
});

test('name conflicts: an active name says so; an archived one offers Unarchive it, which sends the archived record’s id', async () => {
  const app = await boot();
  await open(app);
  typeInto(app, 'manageNewCollection', 'disney+');
  app.ctx.manageCreate('collection'); await settle();
  assert.match(text(app), /You already have a collection called “Disney\+”\./);
  const ninety = coll(app, '90day');
  ninety.archived_at = TS;
  typeInto(app, 'manageNewCollection', '90 DAY');
  app.ctx.manageCreate('collection'); await settle();
  assert.match(text(app), /An archived collection is called “90 Day”\. Unarchive it/);
  const m = box(app).match(/manageSetArchived\('c', '([^']+)', false\)">Unarchive it/);
  assert.strictEqual(m[1], ninety.id);
  app.run(`manageSetArchived('c', '${ninety.id}', false)`); await settle();
  assert.strictEqual(coll(app, '90day').archived_at, null);
});

test('rename is guarded by the name shown: renamed elsewhere → "Renamed elsewhere", nothing changed, the list updates', async () => {
  const app = await boot();
  await open(app);
  const s = coll(app, 'sheridan');
  app.ctx.manageStartRename('c', s.id);
  typeInto(app, `manageRename-${s.id}`, 'Sheridan Universe');
  s.name = 'Taylor Sheridan'; // another page renamed it
  app.ctx.manageSaveRename('c', s.id); await settle();
  assert.strictEqual(rpc(app, 'org_rename_collection')[0].body.p_expected_name, 'Sheridan');
  assert.match(text(app), /Renamed elsewhere to “Taylor Sheridan”; nothing changed\./);
  assert.strictEqual(s.name, 'Taylor Sheridan');
  assert.match(text(app), /Taylor Sheridan 1 show/);
});

test('archive: the confirmation explains what happens (no plan references) and, for an original, that new tab items still join it', async () => {
  const app = await boot();
  await open(app);
  app.ctx.manageAskArchive('c', coll(app, 'disney').id); await settle();
  const t = text(app);
  assert.match(t, /Hides Disney\+ from Browse collections\. Its shows and films stay saved, in every other view and in this collection\. You can unarchive it at any time\./);
  assert.match(t, /New shows and films added in the Disney\+ tab will still join it\./);
  assert.ok(!/\(C4\)|§|Stage 3b/.test(t), 'no plan references in UI text');
});

test('archive is strict: archived elsewhere first → "Already archived elsewhere; nothing changed"', async () => {
  const app = await boot();
  await open(app);
  const d = coll(app, 'disney');
  d.archived_at = TS;
  app.ctx.manageSetArchived('c', d.id, true); await settle();
  assert.match(text(app), /Already archived elsewhere; nothing changed\./);
});

// ── unknown outcomes ──
test('archive succeeds, its reply is lost, another page unarchives: the page shows Active with "wasn’t confirmed" and never re-archives', async () => {
  const app = await boot();
  await open(app);
  const d = coll(app, 'disney');
  lostReply(app, 'org_set_collection_archived', () => { d.archived_at = null; });
  app.ctx.manageSetArchived('c', d.id, true); await settle();
  assert.strictEqual(rpc(app, 'org_set_collection_archived').length, 1, 'sent once; no automatic resubmission');
  assert.match(text(app), /Active\. Your earlier archive request wasn’t confirmed and could still take effect\./);
  assert.match(text(app), /Your earlier attempt might still arrive\. Depending on what changes before then, it may have no effect, or it may still make its change\./);
  assert.ok(!/won’t apply twice|not saved/i.test(text(app)));
  assert.strictEqual(d.archived_at, null);
});

test('a matching state never clears "wasn’t confirmed": the reply to an applied archive is lost, the read shows it archived', async () => {
  const app = await boot();
  await open(app);
  const d = coll(app, 'disney');
  lostReply(app, 'org_set_collection_archived');
  app.ctx.manageSetArchived('c', d.id, true); await settle();
  assert.ok(d.archived_at);
  app.ctx.manageShow('collections'); app.ctx.manageToggleArchived(); await settle();
  assert.match(text(app), /It is now archived\. Your earlier archive request wasn’t confirmed, so it may not have been what made it archived\./);
});

test('create with no answer: reconciliation says what is saved now; a fresh click with the same name reuses the id, an edited name gets a new one', async () => {
  const app = await boot();
  await open(app);
  neverArrived(app, 'org_create_collection');
  typeInto(app, 'manageNewCollection', 'Favourites');
  app.ctx.manageCreate('collection'); await settle();
  assert.match(text(app), /Not created as of this check\. Your earlier request could still create it\./);
  assert.strictEqual(app.el('manageModalBox').innerHTML.includes('value="Favourites"'), true, 'the form keeps the text');
  const first = rpc(app, 'org_create_collection')[0].body.p_id;
  app.ctx.manageCreate('collection'); await settle();
  assert.strictEqual(rpc(app, 'org_create_collection')[1].body.p_id, first, 'same name → same id (both requests can only make one record)');
  // the earlier request arriving late with the same id would return existing:true
  const late = app.rpcHandlers.org_create_collection({ p_id: first, p_name: 'Favourites' });
  assert.ok(JSON.parse(await late.text()).existing === true);
  assert.strictEqual(app.store.personal_collections.filter(c => c.name === 'Favourites').length, 1);
  neverArrived(app, 'org_create_collection');
  typeInto(app, 'manageNewCollection', 'Favorites 2');
  app.ctx.manageCreate('collection'); await settle();
  assert.notStrictEqual(rpc(app, 'org_create_collection')[2].body.p_id, first, 'edited name → new id');
});

test('create whose reply is lost but which was applied: "Created. Your request wasn’t confirmed…"', async () => {
  const app = await boot();
  await open(app);
  lostReply(app, 'org_create_collection');
  typeInto(app, 'manageNewCollection', 'Favourites');
  app.ctx.manageCreate('collection'); await settle();
  assert.match(text(app), /Created\. Your request wasn’t confirmed, so it may have been created by an earlier attempt\./);
  assert.strictEqual(rpc(app, 'org_create_collection').length, 1);
});

test('rename with no answer: not applied as of this check, "could still rename it"; a third name says renamed elsewhere', async () => {
  const app = await boot();
  await open(app);
  const s = coll(app, 'sheridan');
  neverArrived(app, 'org_rename_collection');
  app.ctx.manageStartRename('c', s.id);
  typeInto(app, `manageRename-${s.id}`, 'Sheridan Universe');
  app.ctx.manageSaveRename('c', s.id); await settle();
  assert.match(text(app), /Not renamed as of this check\. Your earlier request could still rename it\./);
  lostReply(app, 'org_rename_collection', () => { s.name = 'Third Name'; });
  app.ctx.manageStartRename('c', s.id);
  typeInto(app, `manageRename-${s.id}`, 'Sheridan Universe');
  app.ctx.manageSaveRename('c', s.id); await settle();
  assert.match(text(app), /Renamed elsewhere to “Third Name”\./);
});

test('removal with no answer, then removed and added again elsewhere (new id): shown as a member; nothing names the replacement id', async () => {
  const app = await boot();
  const d = coll(app, 'disney');
  const andor = showByTitle(app, 'Andor');
  await open(app, 'members', d.id);
  const original = app.store.collection_memberships.find(m => m.collection_id === d.id && m.show_id === andor.id).id;
  lostReply(app, 'org_remove_membership', () => {
    app.store.collection_memberships.push({ id: uuid('0d', 777), collection_id: d.id, show_id: andor.id, item_id: null, created_at: TS });
  });
  app.ctx.manageRemoveMember(original); await settle();
  assert.match(text(app), /Your removal wasn’t confirmed\. “Andor” is in this collection, added again elsewhere\./);
  assert.match(box(app), /Remove Andor from Disney\+/, 'listed as a member (by pair)');
  assert.ok(!app.requests.some(r => JSON.stringify(r.body || {}).includes(uuid('0d', 777))), 'no request names the replacement');
  assert.ok(app.store.collection_memberships.some(m => m.id === uuid('0d', 777)), 'replacement untouched');
});

test('Stop waiting: Close is disabled while saving, Escape does nothing; Stop waiting makes it unknown and re-enables Close (the request isn’t cancelled); the late reply resolves the note without applying its record', async () => {
  const app = await boot();
  await open(app);
  const s = coll(app, 'sheridan');
  const g = app.hold(r => r.url.includes('/rpc/org_rename_collection'));
  app.ctx.manageStartRename('c', s.id);
  typeInto(app, `manageRename-${s.id}`, 'Sheridan Universe');
  app.ctx.manageSaveRename('c', s.id);
  await g.reached; await settle();
  assert.match(box(app), /id="manageClose" onclick="closeManage\(\)" disabled>Saving…/);
  app.ctx.closeManage();
  app.ctx.manageKeydown({ key: 'Escape', preventDefault() {} });
  assert.ok(state(app), 'still open');
  const op = Object.values(state(app).pending)[0];
  app.ctx.manageStopWaiting(String(op.id)); await settle();
  assert.ok(!/disabled>Saving/.test(box(app)), 'Close enabled');
  assert.match(text(app), /Not renamed as of this check\. Your earlier request could still rename it\./, 'the request hasn’t run yet');
  // The request was never cancelled: it now arrives and is applied; its reply resolves the note but its record isn't applied.
  const postRead = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
  g.release(); await settle();
  assert.match(text(app), /Your earlier change was saved\./);
  assert.strictEqual(state(app).data.collections.find(c => c.id === s.id).name, 'Sheridan', 'the late reply’s record is not applied');
  assert.strictEqual(state(app).undo.length, 0);
  postRead.release(); await settle();
  assert.strictEqual(state(app).data.collections.find(c => c.id === s.id).name, 'Sheridan Universe', 'the post-write read shows it');
});

test('read-version guard: a delayed rename reply after a newer accepted read (no newer local action, no Stop waiting) keeps the read’s name, never the older one', async () => {
  const app = await boot();
  await open(app);
  const s = coll(app, 'sheridan');
  const original = app.rpcHandlers.org_rename_collection;
  let releaseReply;
  app.rpcHandlers.org_rename_collection = body => {
    const res = original(body);                 // commits "B"
    s.name = 'C';                               // another page renames again
    return new Promise(r => { releaseReply = () => r(res); });
  };
  app.ctx.manageStartRename('c', s.id);
  typeInto(app, `manageRename-${s.id}`, 'B');
  app.ctx.manageSaveRename('c', s.id); await settle();
  app.ctx.manageReadAgain(); await settle();     // an editor read, started after the rename was sent, shows C
  assert.strictEqual(state(app).data.collections.find(c => c.id === s.id).name, 'C');
  const postRead = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
  releaseReply(); await settle();
  assert.strictEqual(state(app).data.collections.find(c => c.id === s.id).name, 'C', 'never shows B, even briefly');
  postRead.release(); await settle();
  assert.strictEqual(state(app).data.collections.find(c => c.id === s.id).name, 'C');
});

test('read-version guard for a membership pair: a delayed added:true after a newer read showing the pair absent is reported, not re-inserted', async () => {
  const app = await boot();
  const d = coll(app, 'disney');
  const sev = showByTitle(app, 'Severance');
  await open(app, 'members', d.id);
  const original = app.rpcHandlers.org_add_membership;
  let releaseReply;
  app.rpcHandlers.org_add_membership = body => {
    const res = original(body);
    app.store.collection_memberships = app.store.collection_memberships.filter(m => !(m.collection_id === d.id && m.show_id === sev.id));
    return new Promise(r => { releaseReply = () => r(res); });
  };
  app.ctx.manageAddMember('s', sev.id); await settle();
  app.ctx.manageReadAgain(); await settle();
  const postRead = app.hold(r => r.url.includes('/rest/v1/collection_memberships?'));
  releaseReply(); await settle();
  assert.ok(!state(app).data.memberships.some(m => m.collection_id === d.id && m.show_id === sev.id), 'not re-inserted from the reply');
  postRead.release(); await settle();
});

test('control: with no newer read, a reply updates the working copy right away (before the post-write read)', async () => {
  const app = await boot();
  await open(app);
  const s = coll(app, 'sheridan');
  const postRead = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
  app.ctx.manageStartRename('c', s.id);
  typeInto(app, `manageRename-${s.id}`, 'Sheridan Universe');
  app.ctx.manageSaveRename('c', s.id); await settle();
  await postRead.reached;
  assert.strictEqual(state(app).data.collections.find(c => c.id === s.id).name, 'Sheridan Universe');
  assert.match(text(app), /Saved · refreshing/);
  postRead.release(); await settle();
});

test('write barrier: a read started before a change can’t publish after it; the post-write read started after the barrier does', async () => {
  const app = await boot();
  await open(app);
  const preChange = JSON.parse(JSON.stringify(app.store.personal_collections));
  const early = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
  const p = app.ctx.loadOrganization();          // started before the change
  await early.reached;
  typeInto(app, 'manageNewCollection', 'Favourites');
  app.ctx.manageCreate('collection'); await settle();
  assert.ok(app.get('personalCollections').some(c => c.name === 'Favourites'), 'post-write read published');
  // The early read finishes last and answers with what it saw before the change.
  const now = app.store.personal_collections;
  app.store.personal_collections = preChange;
  early.release(); await p; await settle();
  app.store.personal_collections = now;
  assert.ok(app.get('personalCollections').some(c => c.name === 'Favourites'), 'the older read didn’t replace it');
});

test('write barrier (contract): a read started before a confirmed change never publishes after its reply, even before the post-write read finishes', async () => {
  // Replies never touch the shared lists, so a late pre-change read would show the same
  // data they already hold; this pins the publication rule itself (defence in depth).
  const app = await boot();
  await open(app);
  const early = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
  const p = app.ctx.loadOrganization();
  await early.reached;
  const earlySeq = app.get('orgReadSeq');
  const post = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
  typeInto(app, 'manageNewCollection', 'Favourites');
  app.ctx.manageCreate('collection');
  await post.reached;                               // the post-write read is in flight
  assert.ok(app.get('orgWriteBarrier') >= earlySeq, 'barrier set before the post-write read started');
  early.release(); await p; await settle();
  assert.ok(app.get('orgCollectionsSeq') < earlySeq, 'the earlier read did not publish');
  post.release(); await settle();
  assert.ok(app.get('orgCollectionsSeq') > app.get('orgWriteBarrier'), 'the post-write read (newer than the barrier) published');
});

test('write barrier (contract): a read started before a confirmed change never publishes after its reply when the post-write refresh fails; the stale flag stays', async () => {
  const app = await boot();
  await open(app);
  const early = app.hold(r => r.url.includes('/rest/v1/personal_collections?'));
  const p = app.ctx.loadOrganization();
  await early.reached;
  const earlySeq = app.get('orgReadSeq');
  const seqBefore = app.get('orgCollectionsSeq');
  app.failNext(r => r.url.includes('/rest/v1/personal_collections?'));   // the post-write collections read fails
  typeInto(app, 'manageNewCollection', 'Favourites');
  app.ctx.manageCreate('collection'); await settle();
  assert.ok(app.get('orgCollectionsStale') > 0, 'collections marked possibly out of date');
  early.release(); await p; await settle();
  assert.strictEqual(app.get('orgCollectionsSeq'), seqBefore, 'the earlier read did not publish');
  assert.ok(app.get('orgCollectionsSeq') < earlySeq);
  assert.ok(app.get('orgCollectionsStale') > 0, 'still marked possibly out of date');
  assert.match(app.el('browseBar').innerHTML, /Collections may be out of date/);
});

test('saved but refresh failed: the dialog says so with Retry; the Browse bar marks collections out of date; Retry recovers', async () => {
  const app = await boot();
  await open(app);
  app.failNext(r => r.url.includes('/rest/v1/personal_collections?'));
  typeInto(app, 'manageNewCollection', 'Favourites');
  app.ctx.manageCreate('collection'); await settle();
  assert.match(text(app), /Saved\. Couldn’t refresh your collections/);
  assert.match(app.el('browseBar').innerHTML, /Collections may be out of date/);
  assert.ok(!/nothing (was )?changed/i.test(text(app)));
  app.ctx.manageReadAgain(); await settle();
  assert.ok(!/may be out of date/.test(app.el('browseBar').innerHTML));
});

test('per-kind stale flags: a choices-only failure marks only choices stale; the collections read still publishes; a collections-only read doesn’t clear choices; an older failed refresh doesn’t mark newer data stale', async () => {
  const app = await boot();
  const choicesFail = app.hold(r => r.url.includes('/rest/v1/watch_with_choices?'), 'fail');
  const p = app.ctx.startOrgRefresh({ barrier: false, reason: 'retry' });
  await choicesFail.reached;
  const readSeq = app.get('orgReadSeq');
  choicesFail.fail(); await p; await settle();
  assert.ok(app.get('orgChoicesStale') > 0, 'choices stale');
  assert.strictEqual(app.get('orgCollectionsStale'), 0, 'collections not stale (their read succeeded)');
  assert.strictEqual(app.get('orgCollectionsSeq'), readSeq, 'the successful collections read published');
  app.ctx.openBrowseCollection(app.browseId('disney')); await settle(); // a collections-only read
  assert.ok(app.get('orgChoicesStale') > 0, 'choices still stale after a collections-only read');
  // an older failed read can't mark newer data stale
  const older = app.get('orgReadStart()');
  await app.ctx.loadOrganization(); await settle();
  app.ctx.markOrgStale('choices', older);
  app.ctx.markOrgStale('collections', older);
  assert.strictEqual(app.get('orgChoicesStale'), 0);
  assert.strictEqual(app.get('orgCollectionsStale'), 0);
});

test('per-kind stale flags: a collections-only failure marks only collections stale; the choices read still publishes; a newer collections read clears it', async () => {
  const app = await boot();
  app.store.watch_with_choices.find(c => c.token === 'Suzanne').label = 'Suzanne R.';
  app.failNext(r => r.url.includes('/rest/v1/personal_collections?'));
  await app.ctx.startOrgRefresh({ barrier: false, reason: 'retry' }); await settle();
  assert.ok(app.get('orgCollectionsStale') > 0, 'collections stale');
  assert.strictEqual(app.get('orgChoicesStale'), 0, 'choices not stale');
  assert.ok(app.get('watchWithChoices').some(c => c.label === 'Suzanne R.'), 'the successful choices read published');
  assert.match(app.el('browseBar').innerHTML, /Collections may be out of date/);
  app.ctx.openBrowseCollection(app.browseId('disney')); await settle();
  assert.strictEqual(app.get('orgCollectionsStale'), 0, 'cleared by a newer successful collections read');
});

test('a membership, show or row read failing after a change: both shared lists still publish, no stale flag; the editor says it couldn’t refresh (its complete-data rule)', async () => {
  for (const table of ['collection_memberships', 'tv_shows', 'watchlist_items']) {
    const app = await boot();
    await open(app);
    app.failNext(r => r.method === 'GET' && r.url.includes(`/rest/v1/${table}?`));
    typeInto(app, 'manageNewCollection', 'Favourites');
    app.ctx.manageCreate('collection'); await settle();
    assert.ok(app.get('personalCollections').some(c => c.name === 'Favourites'), `${table}: collections published`);
    assert.strictEqual(app.get('orgCollectionsStale'), 0, `${table}: collections not stale`);
    assert.strictEqual(app.get('orgChoicesStale'), 0, `${table}: choices not stale`);
    assert.match(text(app), /Saved\. Couldn’t refresh your collections/, `${table}: the editor reports the failed refresh`);
  }
});

// ── Ambiguous HTTP outcomes (review finding 2) ──
const rawResponse = (status, body) => ({ ok: false, status, text: async () => body, json: async () => JSON.parse(body), headers: { get: () => null } });

test('a committed write whose response is an unstructured gateway error stays unconfirmed; reconciled by a read; never re-sent', async () => {
  const app = await boot();
  await open(app);
  const s = coll(app, 'sheridan');
  const original = app.rpcHandlers.org_rename_collection;
  app.rpcHandlers.org_rename_collection = body => { original(body); app.rpcHandlers.org_rename_collection = original; return rawResponse(502, '<html><body>502 Bad Gateway</body></html>'); };
  const i = app.requests.length;
  app.ctx.manageStartRename('c', s.id);
  typeInto(app, `manageRename-${s.id}`, 'Sheridan Universe');
  app.ctx.manageSaveRename('c', s.id); await settle();
  assert.strictEqual(rpc(app, 'org_rename_collection').length, 1, 'never re-sent');
  assert.ok(app.requests.slice(i).some(r => r.method === 'GET' && r.url.includes('/rest/v1/personal_collections?')), 'reconciled by a read');
  assert.match(text(app), /Your rename wasn’t confirmed\./);
  assert.ok(!/refused|Not saved|nothing changed/i.test(text(app)), 'not reported as a refusal');
});

test('a JSON error without a database code (a gateway or proxy) is also ambiguous; an unconfirmed create keeps its id for a same-name retry', async () => {
  const app = await boot();
  await open(app);
  app.rpcHandlers.org_create_collection = (orig => body => { app.rpcHandlers.org_create_collection = orig; return rawResponse(503, '{"message":"upstream request timeout"}'); })(app.rpcHandlers.org_create_collection);
  typeInto(app, 'manageNewCollection', 'Favourites');
  app.ctx.manageCreate('collection'); await settle();
  assert.match(text(app), /Not created as of this check\. Your earlier request could still create it\./);
  const first = rpc(app, 'org_create_collection')[0].body.p_id;
  app.ctx.manageCreate('collection'); await settle();
  assert.strictEqual(rpc(app, 'org_create_collection')[1].body.p_id, first, 'same name → same id');
  assert.strictEqual(app.store.personal_collections.filter(c => c.name === 'Favourites').length, 1);
});

test('recognized database answers stay definitive: a statement timeout (57014) and a P0001 refusal are reported, with no "wasn’t confirmed"', async () => {
  const app = await boot();
  await open(app);
  const s = coll(app, 'sheridan');
  app.rpcHandlers.org_rename_collection = (orig => () => { app.rpcHandlers.org_rename_collection = orig; return rawResponse(500, '{"code":"57014","details":null,"hint":null,"message":"canceling statement due to statement timeout"}'); })(app.rpcHandlers.org_rename_collection);
  app.ctx.manageStartRename('c', s.id);
  typeInto(app, `manageRename-${s.id}`, 'Sheridan Universe');
  app.ctx.manageSaveRename('c', s.id); await settle();
  assert.match(text(app), /The database didn’t finish this .* so nothing was changed\. Try again\./);
  assert.ok(!/wasn’t confirmed/.test(text(app)));
  s.name = 'Elsewhere';
  app.ctx.manageStartRename('c', s.id);
  typeInto(app, `manageRename-${s.id}`, 'X');
  app.ctx.manageSaveRename('c', s.id); await settle();
  assert.match(text(app), /Renamed elsewhere to “Elsewhere”; nothing changed\./);
  assert.ok(!/wasn’t confirmed/.test(text(app)));
});

// ── Overlapping unresolved requests on one record (review finding 3) ──
test('Archive → Stop waiting → Unarchive succeeds → the original Archive arrives late: each request’s uncertainty is its own', async () => {
  const app = await boot();
  await open(app);
  const d = coll(app, 'disney');
  const original = app.rpcHandlers.org_set_collection_archived;
  let releaseFirst, calls = 0;
  app.rpcHandlers.org_set_collection_archived = body => {
    const res = original(body);
    return ++calls === 1 ? new Promise(r => { releaseFirst = () => r(res); }) : res;   // the archive commits; its reply is delayed
  };
  app.ctx.manageSetArchived('c', d.id, true); await settle();
  const op1 = Object.values(state(app).pending)[0];
  app.ctx.manageStopWaiting(String(op1.id)); await settle();
  app.ctx.manageToggleArchived(); await settle();
  assert.match(text(app), /It is now archived\. Your earlier archive request wasn’t confirmed/);
  app.ctx.manageSetArchived('c', d.id, false); await settle();          // a fresh action: Unarchive succeeds
  assert.strictEqual(d.archived_at, null);
  assert.match(text(app), /Disney\+ .*Your earlier archive request wasn’t confirmed/, 'the earlier Archive is still unconfirmed after the Unarchive succeeded');
  releaseFirst(); await settle(); await settle();                        // the original Archive's reply arrives
  assert.match(text(app), /Your earlier change was saved\./, 'it resolves only its own request');
  assert.strictEqual(d.archived_at, null, 'its record was not applied over the newer state');
  assert.strictEqual(state(app).data.collections.find(c => c.id === d.id).archived_at, null);
});

test('two unresolved requests on one record whose replies arrive out of order: each reply resolves only its own request', async () => {
  const app = await boot();
  await open(app);
  const s = coll(app, 'sheridan');
  const rename = async (to) => {
    const g = app.hold(r => r.url.includes('/rpc/org_rename_collection') && r.body && r.body.p_name === to);
    app.ctx.manageStartRename('c', s.id);
    typeInto(app, `manageRename-${s.id}`, to);
    app.ctx.manageSaveRename('c', s.id);
    await g.reached; await settle();
    const op = Object.values(state(app).pending).find(o => o.args.p_name === to);
    app.ctx.manageStopWaiting(String(op.id)); await settle();
    return g;
  };
  const g1 = await rename('First Name');
  const g2 = await rename('Second Name');
  assert.strictEqual((text(app).match(/could still rename it/g) || []).length, 2, 'two unconfirmed requests shown');
  g2.release(); await settle(); await settle();                          // the second one's reply first
  assert.match(text(app), /Your earlier change was saved\./);
  assert.strictEqual((text(app).match(/could still rename it/g) || []).length, 1, 'the first is still unconfirmed');
  g1.release(); await settle(); await settle();                          // then the first (refused by its guard)
  assert.match(text(app), /Your earlier change was refused: Renamed elsewhere to “Second Name”; nothing changed\./);
  assert.match(text(app), /Your earlier change was saved\./, 'the second request’s resolution is kept');
  assert.ok(!/could still rename it/.test(text(app)));
  assert.strictEqual(s.name, 'Second Name');
});

// ── memberships and Undo ──
test('add a whole show from search: the button says all stored seasons; Undo removes exactly the returned membership', async () => {
  const app = await boot();
  const d = coll(app, 'disney');
  const sev = showByTitle(app, 'Severance');
  await open(app, 'members', d.id);
  typeInto(app, 'manageMemberSearch', 'Severance'); await settle();
  assert.match(text(app), /Severance TV show · Other TV · /);
  app.ctx.manageAddMember('s', sev.id); await settle();
  const added = app.store.collection_memberships.find(m => m.collection_id === d.id && m.show_id === sev.id);
  assert.ok(added);
  assert.match(text(app), /Added “Severance”\. Undo/);
  app.ctx.manageUndo(0); await settle();
  assert.strictEqual(rpc(app, 'org_remove_membership')[0].body.p_membership_id, added.id);
  assert.ok(!app.store.collection_memberships.some(m => m.id === added.id));
});

test('no Undo for a no-op add (someone else’s existing membership), a refusal or an unknown outcome', async () => {
  const app = await boot();
  const d = coll(app, 'disney');
  const andor = showByTitle(app, 'Andor');
  await open(app, 'members', d.id);
  app.ctx.manageAddMember('s', andor.id); await settle(); // already a member: added:false
  assert.strictEqual(state(app).undo.length, 0);
  app.ctx.manageAddMember('s', uuid('5a', 4242)); await settle(); // refused
  assert.strictEqual(state(app).undo.length, 0);
  const sev = showByTitle(app, 'Severance');
  lostReply(app, 'org_add_membership');
  app.ctx.manageAddMember('s', sev.id); await settle();
  assert.strictEqual(state(app).undo.length, 0, 'unknown outcome: no Undo');
  assert.match(text(app), /Your add wasn’t confirmed\./);
});

test('add-Undo after another page removed and re-added the pair (new id): removed:false, the replacement untouched', async () => {
  const app = await boot();
  const d = coll(app, 'disney');
  const sev = showByTitle(app, 'Severance');
  await open(app, 'members', d.id);
  app.ctx.manageAddMember('s', sev.id); await settle();
  const mine = app.store.collection_memberships.find(m => m.collection_id === d.id && m.show_id === sev.id);
  app.store.collection_memberships = app.store.collection_memberships.filter(m => m.id !== mine.id);
  app.store.collection_memberships.push({ id: uuid('0d', 555), collection_id: d.id, show_id: sev.id, item_id: null, created_at: TS });
  app.ctx.manageUndo(0); await settle();
  assert.ok(app.store.collection_memberships.some(m => m.id === uuid('0d', 555)), 'replacement untouched');
  assert.match(text(app), /That membership was already removed or changed elsewhere\./);
});

test('remove-Undo when the collection was archived meanwhile: refused with the reason', async () => {
  const app = await boot();
  const d = coll(app, 'disney');
  const andor = showByTitle(app, 'Andor');
  await open(app, 'members', d.id);
  const m = app.store.collection_memberships.find(x => x.collection_id === d.id && x.show_id === andor.id);
  app.ctx.manageRemoveMember(m.id); await settle();
  d.archived_at = TS;
  app.ctx.manageUndo(0); await settle();
  assert.ok(!app.store.collection_memberships.some(x => x.collection_id === d.id && x.show_id === andor.id));
  assert.match(text(app), /archived/);
});

test('search: unclassified rows are explained, not offered; a skipped film notes that Browse hides Skipped; an archived collection is read-only', async () => {
  const app = await boot();
  const d = coll(app, 'disney');
  await open(app, 'members', d.id);
  typeInto(app, 'manageMemberSearch', 'sever'); await settle();
  assert.match(text(app), /1 matching saved row is neither a TV season nor a film, so it can’t be added\. All Movies lists such rows\./);
  typeInto(app, 'manageMemberSearch', 'skipped'); await settle();
  assert.match(text(app), /Browse hides Skipped by default/);
  d.archived_at = TS;
  app.ctx.manageReadAgain(); await settle();
  assert.match(text(app), /This collection is archived\. Unarchive it to change its members\./);
  assert.ok(!/id="manageMemberSearch"/.test(box(app)), 'no add search');
  assert.match(box(app), /Remove Andor from Disney\+"\s*disabled|disabled aria-label="Remove Andor/);
});

// ── watch-with ──
test('watch-with choices: create (token ww:<id>), rename, archive; an archived one is listed with its usage and can be unarchived', async () => {
  const app = await boot();
  await open(app, 'choices');
  typeInto(app, 'manageNewChoice', 'Grandma');
  app.ctx.manageCreate('choice'); await settle();
  const g = app.store.watch_with_choices.find(c => c.label === 'Grandma');
  assert.strictEqual(g.token, `ww:${g.id}`);
  const rina = app.store.watch_with_choices.find(c => c.token === 'Rina');
  app.ctx.manageSetArchived('w', rina.id, true); await settle();
  app.ctx.manageToggleArchived(); await settle();
  assert.match(text(app), /Archived \(1\).*Rina used on 3 saved items Unarchive/);
  assert.ok(app.get('watchWithChoiceList()').every(c => c.token !== 'Rina'), 'no longer offered');
});

test('a stale page offering an archived choice: the database refuses the update, the row is unchanged, the choices are read again', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.switchTab('movies'); await settle();
  const wind = rowByTitle(app, 'Wind River');
  app.store.watch_with_choices.find(c => c.token === 'Suzanne').archived_at = TS; // archived elsewhere; this page still offers it
  const i = app.requests.length;
  await app.ctx.toggleWatchWith(wind.id, 'Suzanne', true); await settle();
  assert.match(app.el('errorBanner').innerHTML, /“Suzanne” is archived, so it can’t be added\. Nothing was changed/);
  assert.deepStrictEqual(Array.from(rowByTitle(app, 'Wind River').watch_with), ['Rina']);
  assert.ok(app.requests.slice(i).some(r => r.method === 'GET' && r.url.includes('watch_with_choices')), 'choices read again');
});

// ── restore, safety, tracking ──
test('a restore in this page invalidates the open dialog (no edits on stale data)', async () => {
  const app = await boot();
  await open(app);
  app.ctx.invalidateOrganization(); await settle();
  assert.match(text(app), /Your data was restored\. Close this and open Manage again to see it\./);
  assert.strictEqual(state(app).undo.length, 0);
});

test('hostile names render as text everywhere and never reach a handler (ids only)', async () => {
  const app = await boot();
  const evil = `<script>x()</script>"'&\\ 🎬 שלום ${'y'.repeat(60)}`.slice(0, 100);
  await open(app);
  typeInto(app, 'manageNewCollection', evil);
  app.ctx.manageCreate('collection'); await settle();
  const created = app.store.personal_collections.find(c => c.name === evil.trim());
  assert.ok(created);
  const handlers = [...(box(app) + app.el('browseBar').innerHTML).matchAll(/on(?:click|change|input|keydown)="([^"]*)"/g)].map(m => m[1]);
  assert.ok(handlers.every(h => !h.includes('<script>') && !h.includes('שלום')), 'no names in handlers');
  assert.ok(!box(app).includes('<script>x()'), 'escaped in the dialog');
  assert.ok(!app.el('browseBar').innerHTML.includes('<script>x()'), 'escaped in the selector');
  app.ctx.closeManage();
  app.ctx.openBrowseCollection(`browse:${created.id}`); await settle();
  assert.ok(!app.el('viewHead').innerHTML.includes('<script>x()'), 'escaped in the Browse heading');
  assert.match(app.el('viewHead').innerHTML, new RegExp(`openManage\\('members', '${created.id}', this\\)`));
});

test('no tracking write and no write without a user action, across every dialog operation', async () => {
  const app = await boot();
  const d = coll(app, 'disney');
  const i = app.requests.length;
  await open(app, 'members', d.id);
  app.ctx.manageAddMember('s', showByTitle(app, 'Severance').id); await settle();
  app.ctx.manageAddMember('i', rowByTitle(app, 'Dune').id); await settle();
  app.ctx.manageUndo(0); await settle();
  app.ctx.manageShow('collections'); await settle();
  app.ctx.manageStartRename('c', d.id);
  typeInto(app, `manageRename-${d.id}`, 'Disney Plus');
  app.ctx.manageSaveRename('c', d.id); await settle();
  neverArrived(app, 'org_set_collection_archived');
  app.ctx.manageSetArchived('c', d.id, true); await settle(); await settle();
  const w = writesSince(app, i);
  assert.ok(w.every(r => /\/rpc\/org_(add_membership|remove_membership|rename_collection|set_collection_archived)$/.test(new URL(r.url).pathname)), w.map(r => r.url).join(' '));
  assert.strictEqual(rpc(app, 'org_set_collection_archived').length, 1, 'never re-sent');
});

test('closing returns to the page: the Browse bar is rebuilt and an open collection that was edited reloads', async () => {
  const app = await boot();
  app.ctx.openBrowseCollection(app.browseId('disney')); await settle();
  await open(app, 'members', coll(app, 'disney').id);
  app.ctx.manageAddMember('s', showByTitle(app, 'Severance').id); await settle();
  const i = app.requests.length;
  app.ctx.closeManage(); await settle();
  assert.strictEqual(app.el('manageModalOverlay').style.display, 'none');
  assert.ok(app.requests.slice(i).some(r => r.url.includes('/rest/v1/collection_memberships?')), 'the collection view read again');
  assert.match(app.el('tbody').innerHTML, /Severance/);
});

T.run();
