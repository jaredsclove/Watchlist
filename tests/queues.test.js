// Offline tests for named planning queues (Q1, item 7): the Queues area and its route, one queue at a time in the saved
// order, Manage queues (new, rename, delete, move up / down), entries (films, whole shows, seasons) with their labels and
// actions, moving by buttons, the ⋯ menu and a drop, removing, focus after each, Add to queue from the ⋯ menus and the
// flat season lists (refusals shown, nothing changed), completion read back after Mark watched, opening an entry in the
// library, matching's queue report, and backup format 8 (since G1 format 9, with game_entry_id). The database's rules are modelled in tests/q1-harness.js;
// the real ones are tested by tools/q1-test.mjs. Dragging is checked here by its drop rule; the pointer itself is a
// browser check.
// Run from the repo root: node tests/queues.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');
const { makeMiniDom } = require('./mini-dom');

const T = runner('queues');
const test = T.test;

let n = 0;
const nid = p => `${p}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
function show(o, specs) {
  const s = { id: nid('5a000000'), collection: 'othertv', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 100 + n, status: 'confirmed', created_at: '2026-01-01T00:00:00Z', ...o };
  const rows = specs.map(sp => ({
    id: nid('5b000000'), created_at: '2026-01-01T00:00:00Z', collection: s.collection, title: s.title, theme: 'HBO', status: 'pending', watched: !!sp.w, skipped: !!sp.s, show_id: s.id,
    media_type: 'tv', tmdb_id: s.tmdb_id, season_number: sp.num ?? null, season: sp.season || `Season ${sp.num}`, display_date: sp.display || 'Jan 1, 2020',
    date_sort: sp.date || '2020-01-01', item_key: `${s.show_key}|${(sp.season || `season ${sp.num}`).toLowerCase()}`, watch_with: [], collections: []
  }));
  return { show: s, rows };
}
const film = o => ({ id: nid('5c000000'), created_at: '2026-01-01T00:00:00Z', collection: 'movies', title: 'Film', theme: 'Drama', status: 'confirmed', watched: false,
  media_type: 'movie', tmdb_id: 900 + n, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) });
const q = (id, name, sort_order) => ({ id, name, sort_order, created_at: '2026-11-01T00:00:00Z' });
const e = (id, queue_id, target, position) => ({ id, queue_id, show_id: target.show_id || null, item_id: target.item_id || null, position, created_at: '2026-11-01T00:00:00Z' });
const Q1 = '5d000000-0000-4000-8000-000000000001', Q2 = '5d000000-0000-4000-8000-000000000002', Q3 = '5d000000-0000-4000-8000-000000000003';
const E = k => `5e000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
const memoryStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), get length() { return m.size; }, key: i => [...m.keys()][i] }; };
async function boot(data, queues) { const app = await createApp({ rows: data.rows, tvShows: data.shows, queues, storage: memoryStorage() }); app.dom = makeMiniDom(app, ['queuesScreen']); app.dom.hide('cardList'); return app; }
const screen = app => app.el('queuesScreen').innerHTML;
const text = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const entryHtml = (app, id) => (screen(app).split('<li class="queue-entry').find(x => x.includes(`data-entry="${id}"`)) || '');
const order = app => [...screen(app).matchAll(/<li class="queue-entry[^"]*" data-entry="([^"]+)"/g)].map(m => m[1]);
const rpcs = (app, fn) => app.requests.filter(r => r.url.endsWith(`/rpc/${fn}`));
const focusedEntry = app => { const a = app.dom.active(); const li = a && a.closest && a.closest('[data-entry]'); return [li ? li.getAttribute('data-entry') : null, a && (a.getAttribute('data-qaction') || a.getAttribute('data-action'))]; };
const click = (app, sel) => app.dom.focus('queuesScreen', sel);

function library() {
  const a = show({ title: 'Andor', status: 'watching', ended: false }, [{ num: 1, w: true }, { num: 2 }]);
  const b = show({ title: 'Blue Ended', status: 'watching', ended: true }, [{ num: 1, w: true }, { num: 2, w: true }]);
  const c = show({ title: 'Coming', status: 'confirmed' }, [{ num: 1, date: '2099-03-04', display: 'Mar 4, 2099' }]);
  const f1 = film({ title: 'First Film' }), f2 = film({ title: 'Second Film', watched: true }), f3 = film({ title: "O'Brien & <Co>" });
  return { a, b, c, f1, f2, f3 };
}
function seeded() {
  const L = library();
  const queues = { watch_queues: [q(Q2, 'ZZ Second', 2), q(Q1, 'ZZ First', 1)],
    queue_entries: [e(E(1), Q1, { show_id: L.a.show.id }, 1), e(E(2), Q1, { item_id: L.f1.id }, 2), e(E(3), Q1, { item_id: L.c.rows[0].id }, 3),
      e(E(4), Q1, { item_id: L.f2.id }, 5), e(E(5), Q1, { show_id: L.b.show.id }, 6), e(E(6), Q2, { item_id: L.f1.id }, 1)] };
  return { L, data: all(L.a, L.b, L.c, L.f1, L.f2, L.f3), queues };
}
async function openQueues(app) { app.ctx.openQueues(); await settle(); }

test('the Queues area: a fourth app-bar button, its own route, no tabs, filters or Browse row; the first queue in the saved order', async () => {
  const { data, queues } = seeded();
  const app = await boot(data, queues);
  assert.match(app.el('mediaSwitch').innerHTML, /id="areaBtn-queues"[^>]*onclick="openQueues\(\)">Queues<\/button>/);
  await openQueues(app);
  assert.strictEqual(app.get('activeArea'), 'queues');
  assert.match(app.el('mediaSwitch').innerHTML, /id="areaBtn-queues" aria-current="page"/);
  assert.strictEqual(app.get('routeOfView("queues")'), '#/queues');
  assert.strictEqual(app.get('viewOfRoute("#/queues")'), 'queues');
  assert.strictEqual(app.el('tabBar').innerHTML, '');
  assert.strictEqual(app.el('filtersRow').innerHTML, '');
  assert.strictEqual(app.el('desktopTable').style.display, 'none');
  const opts = [...screen(app).split('<select id="queueSelect"')[1].split('</select>')[0].matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)].map(m => [m[3], !!m[2]]);
  assert.deepStrictEqual(opts, [['ZZ First', true], ['ZZ Second', false]], 'the selector follows the saved order: ' + JSON.stringify(opts));
  assert.match(screen(app), /5 entries/);
  assert.deepStrictEqual(order(app), [E(1), E(2), E(3), E(4), E(5)], 'entries in their places (a gap in positions is harmless)');
  assert.deepStrictEqual(app.writes(), []);
});

test('entries: labels and actions — a whole show with its show-row action, a film’s Mark watched, an upcoming season, a watched film, a complete ended show', async () => {
  const { L, data, queues } = seeded();
  const app = await boot(data, queues);
  await openQueues(app);
  const show1 = entryHtml(app, E(1));
  assert.match(text(show1), /Andor Watching Whole show · Up next Season 2/);
  assert.match(show1, /data-action="status"/, 'the show’s status select');
  assert.match(show1, /data-shortcut-show="[^"]+"[^>]*>Mark S2 watched</, 'the show row’s own action');
  assert.match(entryHtml(app, E(2)), /onclick="toggleWatch\('[^']+'\)">Mark watched</);
  assert.match(text(entryHtml(app, E(3))), /Coming Season 1 · Mar 4, 2099 · Upcoming/);
  assert.doesNotMatch(entryHtml(app, E(3)), /Mark watched/, 'not aired: no action');
  assert.match(text(entryHtml(app, E(4))), /Second Film Watched Film/);
  assert.doesNotMatch(entryHtml(app, E(4)), /toggleWatch/, 'a watched film has no action; Remove is in ⋯');
  assert.match(text(entryHtml(app, E(5))), /Blue Ended Complete Whole show/);
  assert.match(entryHtml(app, E(1)), /data-qaction="up"[^>]*disabled/, 'the first entry can’t move up');
  assert.match(entryHtml(app, E(5)), /data-qaction="down"[^>]*disabled/, 'the last can’t move down');
  assert.match(entryHtml(app, E(1)), /class="queue-handle" aria-hidden="true"[^>]*onpointerdown="queueDragStart\(event, '[^']+'\)"/);
  void L;
});

test('select another queue: shown alone, remembered on this browser; an empty queue says how to add', async () => {
  const { data, queues } = seeded();
  queues.watch_queues.push(q(Q3, 'ZZ Empty', 3));
  const app = await boot(data, queues);
  await openQueues(app);
  app.ctx.selectQueue(Q2);
  assert.deepStrictEqual(order(app), [E(6)]);
  assert.strictEqual(app.get("userStorage.getItem('watchlist_last_queue')"), Q2);
  app.ctx.selectQueue(Q3);
  assert.match(text(screen(app)), /“ZZ Empty” is empty\. Add films, whole shows or single seasons with Add to queue…/);
  app.ctx.switchView('watching'); await settle();
  await openQueues(app);
  assert.match(screen(app), new RegExp(`<option value="${Q3}" selected>`), 'the last queue shown opens again');
});

test('move up / down and top / bottom: one guarded move with the order shown; focus stays on the control, or its partner at an end', async () => {
  const { data, queues } = seeded();
  const app = await boot(data, queues);
  await openQueues(app);
  click(app, `[data-entry="${E(2)}"] [data-qaction="up"]`);
  await app.ctx.moveQueueEntry(E(2), 1); await settle();
  assert.deepStrictEqual(order(app), [E(2), E(1), E(3), E(4), E(5)]);
  const [call] = rpcs(app, 'library_queue_move');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(call.body)), { p_queue_id: Q1, p_expected: [E(1), E(2), E(3), E(4), E(5)], p_entry_id: E(2), p_to_index: 1 });
  assert.deepStrictEqual(focusedEntry(app), [E(2), 'down'], 'now first: Move up is disabled, focus on Move down');
  await app.ctx.moveQueueEntry(E(1), 5); await settle();
  assert.deepStrictEqual(order(app), [E(2), E(3), E(4), E(5), E(1)], 'Move to bottom');
  assert.deepStrictEqual(app.store.queue_entries.filter(x => x.queue_id === Q1).sort((a, b) => a.position - b.position).map(x => x.id), order(app), 'saved as shown');
  await app.ctx.moveQueueEntry(E(2), 1); await settle();
  assert.strictEqual(rpcs(app, 'library_queue_move').length, 2, 'a move to where it is sends nothing');
});

test('a move from an out-of-date order is refused: the order goes back, the queue is read again, nothing resent', async () => {
  const { data, queues } = seeded();
  const app = await boot(data, queues);
  await openQueues(app);
  app.store.queue_entries.find(x => x.id === E(5)).position = 0; // another device moved it to the top
  await app.ctx.moveQueueEntry(E(2), 1); await settle();
  assert.strictEqual(rpcs(app, 'library_queue_move').length, 1);
  assert.match(app.el('errorBanner').innerHTML, /changed since the page showed it/);
  assert.deepStrictEqual(order(app), [E(5), E(1), E(2), E(3), E(4)], 'what is saved, read again');
});

test('drag: the drop place is how many other midpoints lie above the pointer; a drop sends the same move', async () => {
  const { data, queues } = seeded();
  const app = await boot(data, queues);
  await openQueues(app);
  assert.strictEqual(app.ctx.queueDropIndex([10, 30, 50], 5), 0);
  assert.strictEqual(app.ctx.queueDropIndex([10, 30, 50], 31), 2);
  assert.strictEqual(app.ctx.queueDropIndex([10, 30, 50], 99), 3);
  await app.ctx.moveQueueEntry(E(3), 1, { entry: E(3), manage: null, hook: ['data-qaction', 'up'], next: [], prev: [] }); await settle();
  assert.deepStrictEqual(order(app), [E(3), E(1), E(2), E(4), E(5)]);
  assert.deepStrictEqual(focusedEntry(app), [E(3), 'down'], 'after a drop, the moved entry’s move control has focus');
});

test('remove: only the entry goes (the film stays in the library); focus goes to the next entry’s ⋯', async () => {
  const { L, data, queues } = seeded();
  const app = await boot(data, queues);
  await openQueues(app);
  click(app, `[data-entry="${E(2)}"] [data-qaction="more"]`);
  await app.ctx.removeQueueEntry(E(2)); await settle();
  assert.deepStrictEqual(order(app), [E(1), E(3), E(4), E(5)]);
  assert.ok(app.store.watchlist_items.some(r => r.id === L.f1.id), 'the film is still in the library');
  assert.ok(app.store.queue_entries.some(x => x.id === E(6)), 'and in its other queue');
  assert.deepStrictEqual(focusedEntry(app), [E(3), 'more']);
});

test('Mark watched from the queue: the film leaves every queue (the database’s completion), read back once the change ends', async () => {
  const { L, data, queues } = seeded();
  const app = await boot(data, queues);
  await openQueues(app);
  await app.ctx.toggleWatch(L.f1.id); await settle();
  assert.ok(app.store.watchlist_items.find(r => r.id === L.f1.id).watched);
  assert.deepStrictEqual(order(app), [E(1), E(3), E(4), E(5)], 'gone from this queue');
  assert.ok(!app.store.queue_entries.some(x => x.item_id === L.f1.id), 'and from the other');
});

test('Manage queues: new (first queue of an empty account), rename, move up / down, delete with its count; the library is untouched', async () => {
  const L = library();
  const app = await boot(all(L.a, L.f1), null);
  await openQueues(app);
  assert.match(text(screen(app)), /You have no queues yet/);
  app.ctx.toggleQueueManage();
  app.run('queueNewName = "ZZ Films"'); await app.ctx.createQueueFromManage(); await settle();
  app.run('queueNewName = "ZZ Shows"'); await app.ctx.createQueueFromManage(); await settle();
  assert.deepStrictEqual(app.store.watch_queues.map(x => [x.name, x.sort_order]), [['ZZ Films', 1], ['ZZ Shows', 2]]);
  assert.match(screen(app), /<option value="[^"]+" selected>ZZ Shows<\/option>/, 'a new queue is shown');
  app.run('queueNewName = "zz films"'); await app.ctx.createQueueFromManage(); await settle();
  assert.match(app.el('errorBanner').innerHTML, /already have a queue with this name/);
  const shows = app.store.watch_queues.find(x => x.name === 'ZZ Shows').id;
  await app.ctx.moveQueue(shows, 1); await settle();
  assert.deepStrictEqual(app.store.watch_queues.sort((a, b) => a.sort_order - b.sort_order).map(x => x.name), ['ZZ Shows', 'ZZ Films']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rpcs(app, 'library_queue_reorder')[0].body.p_expected)).length, 2, 'the order shown is sent');
  app.ctx.startQueueEdit(shows, 'rename'); app.run('queueManageEdit.value = "ZZ Next Up"');
  await app.ctx.renameQueue(shows); await settle();
  assert.strictEqual(rpcs(app, 'library_queue_rename')[0].body.p_expected_name, 'ZZ Shows');
  assert.ok(app.store.watch_queues.some(x => x.name === 'ZZ Next Up'));
  await app.ctx.deleteQueue(shows, 0); await settle();
  assert.deepStrictEqual(app.store.watch_queues.map(x => x.name), ['ZZ Films']);
  assert.match(app.el('noticeBanner').innerHTML + app.el('banner').innerHTML, /was deleted\. Its films, shows and progress stay/);
  assert.strictEqual(app.store.watchlist_items.length, L.a.rows.length + 1, 'nothing in the library changed');
});

test('Add to queue from a show’s ⋯: the whole show or one season; refusals named per queue; added at the bottom, status unchanged', async () => {
  const { L, data, queues } = seeded();
  const app = await boot(data, queues);
  app.ctx.switchView('alltv'); await settle();
  assert.match(app.el('tbody').innerHTML, new RegExp(`onclick="openAddToQueueFromMenu\\(this, 'show', '${L.a.show.id}'\\)">Add to queue…`));
  app.ctx.openAddToQueue('show', L.a.show.id, null, null); await settle();
  const box = () => text(app.el('queueAddBox').innerHTML);
  assert.match(box(), /Add to a queue “Andor” What to add The whole show Season 1 \(watched\) Season 2 Queue ZZ First Already in this queue \(#1\) ZZ Second/);
  assert.match(app.el('queueAddBox').innerHTML, new RegExp(`value="${Q2}" checked`), 'the first queue it can go in');
  app.ctx.queueAddChoose(L.a.rows[1].id);
  assert.match(box(), /ZZ First The whole show is in this queue/);
  app.ctx.queueAddChoose('show');
  const statusBefore = JSON.stringify(app.store.tv_shows.find(s => s.id === L.a.show.id));
  await app.ctx.submitQueueAdd(); await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rpcs(app, 'library_queue_add')[0].body)), { p_queue_id: Q2, p_show_id: L.a.show.id, p_item_id: null });
  assert.strictEqual(app.get('queueAdd'), null, 'closed');
  assert.match(app.el('noticeBanner').innerHTML + app.el('banner').innerHTML, /Added “Andor” to “ZZ Second” \(#2\)/);
  assert.strictEqual(JSON.stringify(app.store.tv_shows.find(s => s.id === L.a.show.id)), statusBefore, 'its status is unchanged');
});

test('Add to queue: a season of a show already whole there, and a duplicate, are refused by the database and said in the dialog', async () => {
  const { L, data, queues } = seeded();
  const app = await boot(data, queues);
  app.ctx.switchView('alltv'); await settle();
  app.ctx.openAddToQueue('show', L.a.show.id, L.a.rows[1].id, null); await settle();
  app.run(`queueAdd.queueId = '${Q1}'`); // as if the dialog's answer were out of date
  app.run(`queueAdd.entries = queueAdd.entries.filter(x => x.queue_id !== '${Q1}')`);
  await app.ctx.submitQueueAdd(); await settle();
  assert.match(text(app.el('queueAddBox').innerHTML), /The whole show is in “ZZ First”, which covers Season 2, so nothing was changed\./);
  assert.strictEqual(app.store.queue_entries.filter(x => x.item_id === L.a.rows[1].id).length, 0);
  app.ctx.closeQueueAdd();
});

test('the flat season lists offer Queue… (All TV Seasons, Coming Soon); a film’s ⋯ offers Add to queue…; nothing is sent until Add', async () => {
  const { L, data, queues } = seeded();
  const app = await boot(data, queues);
  app.ctx.switchView('alltv'); await settle();
  app.ctx.setAllTvPresentation('seasons'); await settle();
  assert.match(app.el('tbody').innerHTML, new RegExp(`data-action="queue"><button type="button" class="btn btn-link queue-season-btn" aria-label="Add Season 2 of Andor to a queue" onclick="openAddToQueue\\('item', '${L.a.rows[1].id}', null, this\\)">Queue…`));
  app.ctx.switchView('comingsoon'); await settle();
  assert.match(app.el('tbody').innerHTML, /queue-season-btn/);
  app.ctx.switchMediaType('movie'); await settle();
  assert.match(app.el('tbody').innerHTML, new RegExp(`openAddToQueueFromMenu\\(this, 'item', '${L.f3.id}'\\)`));
  assert.match(app.el('tbody').innerHTML, /O&#39;Brien &amp; &lt;Co&gt;|O'Brien &amp; &lt;Co&gt;/, 'titles stay escaped');
  app.ctx.openAddToQueue('item', L.f3.id, null, null); await settle();
  assert.strictEqual(rpcs(app, 'library_queue_add').length, 0);
  app.ctx.closeQueueAdd();
});

test('Add to queue makes a first queue in the dialog, then adds there', async () => {
  const L = library();
  const app = await boot(all(L.a, L.f1), null);
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openAddToQueue('item', L.f1.id, null, null); await settle();
  assert.match(text(app.el('queueAddBox').innerHTML), /You have no queues yet/);
  app.run('queueAdd.newName = "ZZ Films With Friends"');
  await app.ctx.queueAddCreate(); await settle();
  await app.ctx.submitQueueAdd(); await settle();
  assert.deepStrictEqual(app.store.queue_entries.map(x => [x.item_id, x.position]), [[L.f1.id, 1]]);
});

test('opening an entry: a season opens All TV as Shows, searched, the show expanded and the season focused; a film opens All Movies', async () => {
  const { L, data, queues } = seeded();
  queues.queue_entries.push(e(E(9), Q2, { item_id: L.a.rows[1].id }, 2));
  const app = await boot(data, queues);
  await openQueues(app);
  app.ctx.selectQueue(Q2);
  app.ctx.openQueueEntry(E(9)); await settle();
  assert.strictEqual(app.get('activeViewId'), 'alltv');
  assert.strictEqual(app.get('allTvPresentation'), 'shows');
  assert.strictEqual(app.el('fSearch').value, 'Andor');
  assert.ok(app.get(`expandedShows.has('${L.a.show.id}')`));
  const a = app.dom.active();
  assert.ok(a && a.closest && a.closest(`[data-season-row="${L.a.rows[1].id}"]`), 'the season has focus');
  await openQueues(app);
  app.ctx.selectQueue(Q2);
  app.ctx.openQueueEntry(E(6)); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies');
  assert.strictEqual(app.el('fSearch').value, 'First Film');
});

test('matching: a queue adjustment made in the same transaction is reported', async () => {
  const { L, data, queues } = seeded();
  const app = await boot(data, queues);
  const before = JSON.parse(JSON.stringify(app.store.queue_entries));
  app.store.queue_entries = app.store.queue_entries.filter(x => x.id !== E(3)); // as the database's identity trigger would
  const said = await app.ctx.queueMatchReport(before);
  assert.match(said, /Queues: 1 queue entry was removed because the whole show is already in “ZZ First”, at its place\./);
  void L;
});

test('backup is format 9 with both queue tables (entries name a game or not); it validates, and an overlap in a file is refused', async () => {
  const { data, queues } = seeded();
  const app = await boot(data, queues);
  const b = await app.ctx.buildBackupObject();
  assert.strictEqual(b.formatVersion, 9);
  assert.deepStrictEqual(Object.keys(b.tables.watch_queues[0]), ['id', 'name', 'sort_order', 'created_at'], JSON.stringify(b.tables.watch_queues[0]));
  assert.deepStrictEqual(Object.keys(b.tables.queue_entries[0]), ['id', 'queue_id', 'show_id', 'item_id', 'game_entry_id', 'position', 'created_at']);
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(b)), [], Array.from(app.ctx.validateBackupObject(b)).join(' | '));
  const bad = JSON.parse(JSON.stringify(b));
  bad.tables.queue_entries.push({ ...bad.tables.queue_entries[0], id: E(99), show_id: null, item_id: data.rows.find(r => r.show_id === bad.tables.queue_entries[0].show_id).id, position: 99 });
  bad.rowCounts.queue_entries++;
  assert.ok(Array.from(app.ctx.validateBackupObject(bad)).some(x => /season of a show its queue holds whole/.test(x)), 'an overlap in a file is refused before anything is sent');
});

T.run();
