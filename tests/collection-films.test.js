// Offline tests for S4: films in collections (All Movies' controls, the library action by effect,
// Pull rest) and membership removal from a collection view with Undo (D5), including Remove show on
// season entries (O3). The page runs in the whole-page harness (tests/app-harness.js); focus uses the
// test-only DOM (tests/mini-dom.js). The model is the harness's in-memory one, not the database.
// Run from the repo root: node tests/collection-films.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');
const { makeMiniDom } = require('./mini-dom');

const T = runner('collection-films');
const test = (name, fn) => (!process.env.ONLY || name.includes(process.env.ONLY)) && T.test(name, fn);
const copy = v => JSON.parse(JSON.stringify(v));

let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
function show(o, nums) {
  const s = { id: nid('show'), collection: 'truecrime', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 100 + n, status: 'confirmed', ...o };
  const rows = nums.map(num => ({ id: nid('r'), collection: s.collection, title: s.title, theme: 'Net', status: 'pending', watched: false, skipped: false,
    show_id: s.id, media_type: 'tv', tmdb_id: s.tmdb_id, season_number: num, season: `Season ${num}`, display_date: `Jan 1, ${2010 + num}`,
    date_sort: `${2010 + num}-01-01`, item_key: `${s.show_key}|season ${num}`, watch_with: [], collections: [] }));
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'truecrime', title: 'Film', theme: 'Doc', status: 'confirmed', watched: false,
  media_type: null, tmdb_id: null, season_number: null, season: 'Film', display_date: 'Jan 1, 2015', date_sort: '2015-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });

function lib() {
  const L = {};
  L.alpha = show({ title: 'Alpha', status: 'watching' }, [1, 2]);
  L.bravo = show({ title: 'Bravo' }, [1, 2, 3]);
  L.charlie = show({ title: 'Charlie' }, [1]);
  L.outsider = show({ title: 'Outsider', collection: 'othertv' }, [1]);
  L.filmA = film({ title: 'Doc One' });
  L.filmB = film({ title: 'Doc Two', watched: true });
  L.filmC = film({ title: 'Doc Three' });
  const shows = ['alpha', 'bravo', 'charlie', 'outsider'].map(k => L[k]);
  L.data = { rows: shows.flatMap(x => x.rows).concat([L.filmA, L.filmB, L.filmC]), shows: shows.map(x => x.show) };
  return L;
}
const boot = (L = lib(), opts = {}) => createApp({ rows: L.data.rows, tvShows: L.data.shows, ...opts });
const TC = app => app.browseId('truecrime');
const CID = app => TC(app).split(':')[1];
async function openTC(app) {
  app.ctx.openBrowseCollection(TC(app)); await settle();
  app.el('fStatus').value = 'all'; app.ctx.renderTable();
}
const html = app => app.el('tbody').innerHTML;
const cards = app => app.el('cardList').innerHTML;
const writes = app => app.requests.filter(r => r.method !== 'GET');
const rpc = (app, fn) => app.requests.filter(r => r.url.endsWith(`/rpc/${fn}`));
const path = r => r.url.split('/rest/v1/')[1] || r.url;
const banner = app => app.el('errorBanner').innerHTML;
const notice = app => app.el('banner').innerHTML;
const handlersIn = s => [...s.matchAll(/\bon(?:click|change|input|keydown)="([^"]*)"/g)].map(m => m[1].replace(/event\.stopPropagation\(\); /g, ''));
const membership = (app, pred) => app.store.collection_memberships.find(pred) || null;
const memberOf = (app, key, id) => membership(app, m => m.collection_id === CID(app) && m[key] === id);
function snap(app) {
  const s = {};
  for (const t of ['watchlist_items', 'tv_shows', 'collection_memberships', 'personal_collections', 'watch_with_choices']) s[t] = copy(app.store[t] || []);
  return s;
}
function diff(a, b) {
  const out = {};
  for (const t of Object.keys(a)) {
    const A = new Map(a[t].map(r => [r.id, JSON.stringify(r)])), B = new Map(b[t].map(r => [r.id, JSON.stringify(r)]));
    const added = [...B.keys()].filter(k => !A.has(k)), removed = [...A.keys()].filter(k => !B.has(k));
    const changed = [...A.keys()].filter(k => B.has(k) && A.get(k) !== B.get(k));
    if (added.length || removed.length || changed.length) out[t] = { added, removed, changed };
  }
  return out;
}
const desc = n => (n ? `${n.tag}${Object.entries(n.attrs || {}).filter(([k]) => k.startsWith('data-') || k === 'class').map(([k, v]) => `[${k}=${v}]`).join('')}` : 'null');

// ═══ Films: All Movies' controls in every layout (V4.1, V4.2) ════════════════
// Every handler call naming the film's id, in All Movies and in the collection: the same, except that the
// collection has no × and ends its menu with Remove and the library action by effect.
function filmCalls(s, id) {
  return handlersIn(s).filter(h => h.includes(`'${id}'`) && !/^toggleFilterPill\(/.test(h)).sort();
}
test('V4.1 a film has All Movies’ controls in Shows / Seasons × Separate / Combined × All / Movies, plus Remove; the bare × is gone', async () => {
  const L = lib();
  const app = await boot(L);
  app.ctx.switchMediaType('movie'); await settle();
  app.el('fWatch').value = ''; app.el('fStatus').value = 'all'; app.ctx.renderTable();
  const allMovies = filmCalls(html(app), L.filmA.id);
  assert.ok(allMovies.includes(`delRow('${L.filmA.id}')`) && allMovies.length > 4, allMovies.join(' | '));
  await openTC(app);
  for (const [media, pres, grouping] of [['all', 'shows', 'separate'], ['all', 'seasons', 'combined'], ['movie', 'shows', 'separate']]) {
    app.ctx.setBrowseMedia(media); app.ctx.setBrowsePresentation(pres); app.ctx.setBrowseGrouping(grouping);
    for (const box of ['tbody', 'cardList']) {
      const s = app.el(box).innerHTML;
      const calls = filmCalls(s, L.filmA.id);
      assert.deepStrictEqual(calls.filter(h => !h.startsWith('removeFromCollection(')), allMovies, `${media}/${pres}/${grouping} ${box}`);
      assert.deepStrictEqual(calls.filter(h => h.startsWith('removeFromCollection(')), [`removeFromCollection('film', '${L.filmA.id}', null)`]);
      assert.ok(!/class="(card-)?del-btn"/.test(s), 'no bare × in a collection');
      assert.ok(s.includes('>Delete from library…</button>') && s.includes('>Remove from True Crime / Docs…</button>'));
    }
  }
  assert.deepStrictEqual(writes(app), []);
});
test('V4.2 the library action is named by its effect: a catalog film offers Skip film (built-in catalog)…, a Skipped one nothing; its dialog keeps the existing text', async () => {
  const probe = await createApp();
  const def = probe.get("COLLECTIONS.find(c => c.id === 'disney').defaults.find(d => d.s === 'Film')");
  const L = lib();
  const cat = film({ title: def.t, collection: 'disney', item_key: def.k, theme: 'Disney+' });
  const catSkipped = film({ title: 'Skipped Catalog', collection: 'disney', item_key: (probe.get("COLLECTIONS.find(c => c.id === 'disney').defaults.filter(d => d.s === 'Film')[1]") || {}).k, status: 'skipped' });
  L.data.rows.push(cat, catSkipped);
  const app = await boot(L);
  app.ctx.openBrowseCollection(app.browseId('disney')); await settle();
  app.el('fStatus').value = 'all'; app.ctx.renderTable();
  assert.ok(html(app).includes(`Skip film (built-in catalog)…</button>`) && !html(app).includes(`aria-label="Delete ${def.t} from your library"`));
  if (catSkipped.item_key) {
    const row = html(app).split('<tr').find(r => r.includes(`data-item="${catSkipped.id}"`));
    assert.ok(row && !/delRow\(/.test(row), 'a Skipped catalog film has no library action');
  }
  app.dialogAnswer = 'cancel';
  await app.ctx.delRow(cat.id); await settle();
  assert.strictEqual(app.dialogs[0].text, `Skip “${def.t}”? It’s part of a built-in catalog, so it is marked Skipped rather than deleted.`);
  assert.strictEqual(app.dialogs[0].confirmLabel, 'Skip film');
  app.dialogAnswer = 'confirm';
  await app.ctx.delRow(cat.id); await settle();
  assert.deepStrictEqual(writes(app).map(path), ['rpc/library_set_film_state_b45']);
  assert.strictEqual(writes(app)[0].body.p_changes.state, 'skipped');
});
test('V4.5 Delete from library in a collection names Remove as the alternative (film and season); All TV and All Movies don’t', async () => {
  const L = lib();
  const app = await boot(L);
  app.dialogAnswer = 'cancel';
  await openTC(app);
  await app.ctx.delRow(L.filmA.id); await settle();
  await app.ctx.delRow(L.bravo.rows[0].id); await settle();
  assert.strictEqual(app.dialogs[0].text, 'Delete “Doc One” from your library? It is removed everywhere: All Movies and every collection it’s in. To keep it but take it out of True Crime / Docs only, use Remove from True Crime / Docs instead.');
  assert.ok(app.dialogs[1].text.endsWith(' To keep it but take the show out of True Crime / Docs only, use Remove show from True Crime / Docs instead.'), app.dialogs[1].text);
  app.ctx.switchMediaType('movie'); await settle();
  await app.ctx.delRow(L.filmA.id); await settle();
  app.ctx.switchMediaType('tv'); app.ctx.switchView('alltv'); await settle();
  await app.ctx.delRow(L.bravo.rows[0].id); await settle();
  assert.ok(!/Remove/.test(app.dialogs[2].text) && !/Remove/.test(app.dialogs[3].text), 'All Movies and All TV unchanged');
  assert.deepStrictEqual(writes(app), []);
});
test('film actions in a collection write as in All Movies: status, priority, Watched, watch-with, Details; confirmed Delete from library deletes the row (and its memberships) and reads again', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  await app.ctx.setStatus(L.filmA.id, 'watched'); await settle();
  await app.ctx.setFilmPriority(L.filmA.id, 'high'); await settle();
  await app.ctx.toggleWatch(L.filmC.id); await settle();
  await app.ctx.toggleWatchWith(L.filmC.id, 'Rina', true); await settle();
  assert.deepStrictEqual(writes(app).map(path), ['rpc/library_set_film_state_b45', 'rpc/library_set_film_state_b45', 'rpc/library_set_film_state_b45', `watchlist_items?id=eq.${L.filmC.id}`]);
  const stored = app.store.watchlist_items.find(r => r.id === L.filmA.id);
  assert.deepStrictEqual([stored.watched, stored.priority], [true, 'high']);
  app.ctx.openDetails('film', L.filmA.id, null);
  assert.ok(app.get('detailsDialog') && app.get('detailsDialog.kind') === 'film', 'Details opens for a film (S4)');
  app.ctx.closeDetails();
  const before = snap(app), mark = app.requests.length;
  await app.ctx.delRow(L.filmB.id); await settle(); await settle();
  assert.deepStrictEqual(writes(app).slice(-1).map(path), [`watchlist_items?id=eq.${L.filmB.id}`]);
  const d = diff(before, snap(app));
  assert.deepStrictEqual(d.watchlist_items.removed, [L.filmB.id]);
  assert.strictEqual(d.collection_memberships.removed.length, 1);
  assert.ok(app.requests.slice(mark).some(r => r.method === 'GET' && r.url.includes('/collection_memberships')), 'read again');
  assert.ok(!html(app).includes(`data-item="${L.filmB.id}"`));
});

// ═══ Remove (V4.3, V4.4, V4.9; F22–F24) ═══════════════════════════════════════
test('V4.3 Remove a film: the dialog, Cancel sends nothing; confirmed: the capability check, one org_remove_membership with the read ids, exactly that membership goes, read again, notice with Undo', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  const m = memberOf(app, 'item_id', L.filmA.id);
  app.dialogAnswer = 'cancel';
  await app.ctx.removeFromCollection('film', L.filmA.id, null); await settle();
  assert.strictEqual(app.dialogs[0].text, 'Remove “Doc One” from True Crime / Docs? It stays in your library with its status and watched state. Only True Crime / Docs changes.');
  assert.deepStrictEqual([app.dialogs[0].cancelLabel, app.dialogs[0].confirmLabel, app.dialogs[0].focus], ['Cancel', 'Remove from True Crime / Docs', 'effectCancel']);
  assert.deepStrictEqual(writes(app), [], 'Cancel: nothing sent');
  app.dialogAnswer = 'confirm';
  const before = snap(app), mark = app.requests.length;
  await app.ctx.removeFromCollection('film', L.filmA.id, null); await settle(); await settle();
  const sent = app.requests.slice(mark);
  assert.ok(sent.findIndex(r => r.url.endsWith('/rpc/org_capabilities')) < sent.findIndex(r => r.url.endsWith('/rpc/org_remove_membership')), 'capability first');
  assert.deepStrictEqual(writes(app).map(r => [path(r), r.body]), [['rpc/org_remove_membership',
    { p_membership_id: m.id, p_collection_id: CID(app), p_show_id: null, p_item_id: L.filmA.id }]]);
  assert.deepStrictEqual(diff(before, snap(app)), { collection_memberships: { added: [], removed: [m.id], changed: [] } }, 'only that membership; the library unchanged');
  assert.ok(sent.some(r => r.method === 'GET' && r.url.includes('/collection_memberships')), 'read again');
  assert.ok(!html(app).includes(`data-item="${L.filmA.id}"`), 'no longer listed');
  assert.ok(notice(app).includes('Removed “Doc One” from True Crime / Docs. It’s still in your library.') && notice(app).includes('undoCollectionRemove()'));
  assert.strictEqual(app.get('writeLane'), null, 'the lane is free');
});
test('V4.3 / F22 Remove show (expanded show actions): whole-show wording; every season leaves; the show, its seasons and other memberships unchanged', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.run(`expandedShows = new Set([${JSON.stringify(L.bravo.show.id)}])`); app.ctx.renderTable();
  assert.ok(html(app).includes(`removeFromCollection('show', '${L.bravo.show.id}', null)`) && html(app).includes('>Remove show from True Crime / Docs…</button>'));
  const before = snap(app);
  await app.ctx.removeFromCollection('show', L.bravo.show.id, null); await settle(); await settle();
  assert.strictEqual(app.dialogs[0].text, 'Remove “Bravo” from True Crime / Docs? It stays in your library with its status and watched seasons. Only True Crime / Docs changes (the whole show, all its seasons).');
  const d = diff(before, snap(app));
  assert.deepStrictEqual(Object.keys(d), ['collection_memberships']);
  assert.strictEqual(d.collection_memberships.removed.length, 1);
  assert.ok(!html(app).includes(`data-item="${L.bravo.show.id}"`));
});
test('V4.9 / F24 Remove show on a season entry (Seasons × Separate / Combined × All / TV): whole-show name and dialog; every entry of the show leaves together; focus to an entry of a different show', async () => {
  for (const [media, grouping] of [['all', 'separate'], ['all', 'combined'], ['tv', 'separate'], ['tv', 'combined']]) {
    const L = lib();
    const app = await boot(L);
    await openTC(app);
    app.ctx.setBrowseMedia(media); app.ctx.setBrowseGrouping(grouping); app.ctx.setBrowsePresentation('seasons'); app.ctx.setBrowseSeasonVis('all');
    for (const r of L.bravo.rows) {
      const entry = html(app).split('<tr').find(x => x.includes(`data-item="${r.id}"`));
      assert.ok(entry.includes(`removeFromCollection('show', '${L.bravo.show.id}', '${r.id}')`) && entry.includes('aria-label="Remove the show Bravo and all its seasons from True Crime / Docs"') && entry.includes('>Remove show…</button>'), `${media}/${grouping}: ${r.season}`);
    }
    const dom = makeMiniDom(app);
    dom.hide('cardList');
    const s2 = L.bravo.rows[1];
    dom.focus('tbody', `[data-item="${s2.id}"] [data-action="remove"] button`);
    const before = snap(app);
    await app.ctx.removeFromCollection('show', L.bravo.show.id, s2.id); await settle(); await settle();
    assert.strictEqual(app.dialogs[0].text, 'Remove the show “Bravo” from True Crime / Docs? It stays in your library with its status and watched seasons. Only True Crime / Docs changes (the whole show, all its seasons). This removes every season of Bravo from True Crime / Docs, not only Season 2.');
    assert.deepStrictEqual(writes(app).map(r => r.body.p_show_id), [L.bravo.show.id]);
    assert.ok(writes(app).every(r => r.body.p_item_id === null));
    const d = diff(before, snap(app));
    assert.deepStrictEqual(Object.keys(d), ['collection_memberships'], `${media}/${grouping}: the library unchanged`);
    assert.ok(L.bravo.rows.every(r => !html(app).includes(`data-item="${r.id}"`)), 'every season entry of the show leaves');
    const at = dom.active();
    const key = at && at.closest('[data-item]') ? at.closest('[data-item]').getAttribute('data-item') : null;
    assert.ok(key && !L.bravo.rows.some(r => r.id === key), `${media}/${grouping}: F-5 to a different show (${desc(at)})`);
  }
});
test('V4.3 focus after Remove from a film’s menu: the chain runs from the film (F-5: its neighbour)', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.ctx.setBrowseMedia('movie');
  const dom = makeMiniDom(app);
  dom.hide('cardList');
  const order = [...html(app).matchAll(/<tr class="browse-film-row[^"]*" data-item="([^"]+)"/g)].map(m => m[1]);
  const opener = dom.focus('tbody', `[data-item="${order[0]}"] .popover-action[aria-label^="Remove"]`);
  assert.ok(opener);
  await app.ctx.removeFromCollection('film', order[0], null); await settle(); await settle();
  assert.strictEqual(desc(dom.active()), desc(dom.in('tbody', `[data-item="${order[1]}"] [data-primary]`)));
});
test('V4.4 Undo: one org_add_membership for the same collection and target; back in the list; offered once; the notice says so', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  await app.ctx.removeFromCollection('film', L.filmA.id, null); await settle(); await settle();
  const before = snap(app), mark = app.requests.length;
  await app.ctx.undoCollectionRemove(); await settle(); await settle();
  assert.deepStrictEqual(app.requests.slice(mark).filter(r => r.method !== 'GET').map(r => [path(r), r.body]),
    [['rpc/org_add_membership', { p_collection_id: CID(app), p_show_id: null, p_item_id: L.filmA.id }]]);
  const d = diff(before, snap(app));
  assert.deepStrictEqual([Object.keys(d), d.collection_memberships.added.length], [['collection_memberships'], 1]);
  assert.ok(html(app).includes(`data-item="${L.filmA.id}"`), 'listed again');
  assert.ok(notice(app).includes('“Doc One” is back in True Crime / Docs.') && !notice(app).includes('undoCollectionRemove()'));
  const after = app.requests.length;
  await app.ctx.undoCollectionRemove(); await settle();
  assert.strictEqual(app.requests.length, after, 'at most once');
});
test('V4.4 Undo is withdrawn when you leave the collection or after a restore: nothing is sent', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  await app.ctx.removeFromCollection('film', L.filmA.id, null); await settle(); await settle();
  app.ctx.switchView('alltv'); await settle();
  await openTC(app);
  const mark = app.requests.length;
  await app.ctx.undoCollectionRemove(); await settle();
  assert.ok(app.requests.slice(mark).every(r => r.method === 'GET'), 'left: no Undo');
  await app.ctx.removeFromCollection('film', L.filmC.id, null); await settle(); await settle();
  assert.ok(notice(app).includes('undoCollectionRemove()'));
  app.run('invalidateOrganization()'); // what a restore made in this page does (organization.js)
  const mark2 = app.requests.length;
  await app.ctx.undoCollectionRemove(); await settle();
  assert.ok(app.requests.slice(mark2).every(r => r.method === 'GET'), 'restored: no Undo');
});
for (const mode of ['before', 'after']) {
  test(`V4.4 an unconfirmed Remove (answer lost ${mode} commit): not confirmed, never resent, read again, no Undo; the table matches the mode`, async () => {
    const L = lib();
    const app = await boot(L);
    await openTC(app);
    const m = memberOf(app, 'item_id', L.filmA.id);
    app.loseNext(r => r.url.endsWith('/rpc/org_remove_membership'), mode);
    const before = snap(app), mark = app.requests.length;
    await app.ctx.removeFromCollection('film', L.filmA.id, null); await settle(); await settle();
    assert.strictEqual(rpc(app, 'org_remove_membership').length, 1, 'sent once, never again');
    assert.ok(banner(app).includes('Removing “Doc One” from True Crime / Docs wasn’t confirmed (Failed to fetch): it may or may not have been removed, and it won’t be sent again. The list has been read again; look at it again.'), banner(app));
    assert.ok(!notice(app).includes('undoCollectionRemove()'), 'no Undo');
    assert.ok(app.requests.slice(mark).some(r => r.method === 'GET' && r.url.includes('/collection_memberships')), 'read again');
    const d = diff(before, snap(app));
    if (mode === 'before') assert.deepStrictEqual(d, {});
    else assert.deepStrictEqual(d, { collection_memberships: { added: [], removed: [m.id], changed: [] } });
    assert.strictEqual(html(app).includes(`data-item="${L.filmA.id}"`), mode === 'before', 'the reread shows what is stored');
  });
}
test('V4.4 an unconfirmed Undo: not confirmed, never resent, read again', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  await app.ctx.removeFromCollection('film', L.filmA.id, null); await settle(); await settle();
  app.loseNext(r => r.url.endsWith('/rpc/org_add_membership'), 'after');
  await app.ctx.undoCollectionRemove(); await settle(); await settle();
  assert.strictEqual(rpc(app, 'org_add_membership').length, 1);
  assert.ok(banner(app).includes('Putting “Doc One” back in True Crime / Docs wasn’t confirmed'), banner(app));
  assert.ok(html(app).includes(`data-item="${L.filmA.id}"`), 'the reread shows it (added after commit)');
  await app.ctx.undoCollectionRemove(); await settle();
  assert.strictEqual(rpc(app, 'org_add_membership').length, 1, 'never offered again');
});
test('V4.4 answers in Manage’s words: already removed elsewhere; archived meanwhile (refused); the function missing; each read again or reported, nothing resent', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  // Already removed elsewhere (removed: false).
  app.store.collection_memberships = app.store.collection_memberships.filter(m => m.item_id !== L.filmA.id);
  await app.ctx.removeFromCollection('film', L.filmA.id, null); await settle(); await settle();
  assert.ok(notice(app).includes('“Doc One” wasn’t removed from True Crime / Docs: That membership was already removed or changed elsewhere.'), notice(app));
  assert.ok(!notice(app).includes('undoCollectionRemove()'));
  // Archived meanwhile: the database refuses.
  app.store.personal_collections.find(c => c.id === CID(app)).archived_at = '2026-01-01T00:00:00Z';
  await app.ctx.removeFromCollection('film', L.filmC.id, null); await settle(); await settle();
  assert.ok(notice(app).includes('“Doc Three” wasn’t removed from True Crime / Docs: This collection is archived; unarchive it to change its members.'), notice(app));
  assert.ok(html(app).includes('This collection isn’t available any more.'), 'the reread shows the collection is gone');
  assert.strictEqual(rpc(app, 'org_remove_membership').length, 2);
});
test('F22 guards: no capability → nothing sent; a list that may be out of date → refused before sending; another change in progress → refused', async () => {
  const L = lib();
  const app = await boot(L);
  await openTC(app);
  app.refuseNext(r => r.url.endsWith('/rpc/org_capabilities'), 'PGRST202', 'Could not find the function');
  app.run('orgWriteCapability = null');
  await app.ctx.removeFromCollection('film', L.filmA.id, null); await settle();
  assert.deepStrictEqual(writes(app), []);
  app.run('listStale = true');
  await app.ctx.removeFromCollection('film', L.filmA.id, null); await settle();
  assert.deepStrictEqual(writes(app), []);
  assert.ok(banner(app).includes('may be out of date'), banner(app));
  app.run('listStale = false');
  const held = app.hold(r => r.url.endsWith('/rpc/library_set_film_state_b45'));
  const pending = app.ctx.setFilmPriority(L.filmC.id, 'high');
  await held.reached;
  await app.ctx.removeFromCollection('film', L.filmA.id, null); await settle();
  assert.ok(banner(app).includes('is still being saved'), banner(app));
  held.release(); await pending; await settle();
  assert.deepStrictEqual(writes(app).map(path), ['rpc/library_set_film_state_b45']);
});
test('F22 checks after the question: another view, a restore, or a changed membership while it was open → nothing is sent', async () => {
  for (const [label, act] of [
    ['another view', app => app.ctx.switchView('alltv')],
    ['a restore', app => app.run('invalidateOrganization()')],
    ['the membership changed', app => app.run(`browseData.memberRows = browseData.memberRows.map(m => m.item_id === ${JSON.stringify('X')} ? m : ({ ...m, id: m.id + '-new' }))`)]
  ]) {
    const L = lib();
    const app = await boot(L);
    await openTC(app);
    app.dialogAnswer = 'hold';
    const p = app.ctx.removeFromCollection('film', L.filmA.id, null); await settle();
    act(app);
    app.answerDialog(true); await p; await settle();
    assert.ok(!rpc(app, 'org_remove_membership').length, `${label}: nothing sent`);
  }
});

// ═══ Pull rest in a collection (V4.6, F19) ═════════════════════════════════════
test('V4.6 Pull rest from a collection: the panel shows only the franchise; films go to the library, not the collection; the report says so', async () => {
  const L = lib();
  // A film stored with the films (a genre theme), added to the collection as a member.
  const franchise = film({ title: 'Saga One', collection: 'movies', media_type: 'movie', tmdb_id: 501, theme: 'Action', tmdb_collection_id: 900, tmdb_collection_name: 'Saga Collection', collections: ['Saga Collection'], item_key: 'saga one|film' });
  L.data.rows.push(franchise);
  const tmdb = p => {
    if (p.startsWith('/collection/900')) return { id: 900, name: 'Saga Collection', parts: [{ id: 501, title: 'Saga One', release_date: '2001-01-01' }, { id: 502, title: 'Saga Two', release_date: '2003-01-01' }] };
    if (p.startsWith('/movie/502')) return { id: 502, title: 'Saga Two', release_date: '2003-01-01', genres: [{ id: 28, name: 'Action' }], production_companies: [] };
    return undefined;
  };
  const app = await boot(L, { tmdb });
  app.store.collection_memberships.push({ id: '0d000000-0000-4000-8000-0000000009aa', collection_id: CID(app), show_id: null, item_id: franchise.id, created_at: '2026-01-01T00:00:00Z' });
  await openTC(app);
  assert.ok(html(app).includes(`checkFilmCollection('${franchise.id}')`) && !html(app).includes('libraryPullRest('), 'unknown contents: Check collection, no Pull rest yet');
  await app.ctx.checkFilmCollection(franchise.id); await settle(); app.ctx.renderTable();
  assert.ok(html(app).includes(`libraryPullRest('${franchise.id}', 900,`), 'another film to add: Pull rest offered in the film’s menu');
  await app.ctx.libraryPullRest(franchise.id, 900, 'Saga'); await settle(); await settle();
  const panel = app.el('libraryPanel').innerHTML;
  assert.ok(panel.includes('Pull rest of Saga') && !panel.includes('How to add') && !panel.includes('pull entire MCU'), 'only the franchise preview');
  app.addEl('tmdbPreview');
  const before = snap(app);
  app.ctx.document.querySelectorAll = sel => sel.includes('data-movie-id') ? [{ checked: true, disabled: false, dataset: { movieId: '502' } }] : [];
  await app.ctx.addPulledCollectionMovies(); await settle(); await settle();
  const d = diff(before, snap(app));
  assert.deepStrictEqual([Object.keys(d), d.watchlist_items.added.length], [['watchlist_items'], 1], 'a library row only; no membership');
  assert.ok(!html(app).includes('>Saga Two<'), 'not listed in the collection');
  assert.ok((app.el('libraryOutcome') || {}).innerHTML.includes('Added 1 film to your library. It isn’t in True Crime / Docs: Pull rest adds to your library, not to this collection.'), 'the report');
});

T.run();
