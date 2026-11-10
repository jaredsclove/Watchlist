// ─── Planning queues (Q1, next-gen item 7; db/q1_queues.sql) ──────────────────
// A member's named, manually ordered queues of films, whole shows, single seasons and (G1) games. The Queues area shows one queue
// at a time: a selector in the saved queue order, Manage queues (new, rename, delete, move up / down) and the entries,
// reordered by dragging the handle (mouse or touch) or with Move up / down and the ⋯ menu's Move to top / bottom.
// Adding never changes viewing status; removing an entry or deleting a queue never touches the library.
// Entries leave every queue in the database when their item is completed by an explicit change (a film or season marked
// watched; an ended show whose last regular season is marked, or Show ended turned on with every regular season watched).
// Everything here writes through the one write lane; a refused or unconfirmed change reads the queue again through
// reloadOpenView. Focus follows the list's rule: only when it was in the queue, to the same control of the same entry,
// else that entry's ⋯, else a neighbour's, else the queue's own controls.

const QUEUES_VIEW_ID = 'queues';
const QUEUE_LAST_KEY = 'watchlist_last_queue';     // per account, this browser: the queue shown last
const QUEUE_ADD_LAST_KEY = 'watchlist_last_queue_add'; // per account, this browser: the queue added to last
const QUEUE_DRAG_START_PX = 6;

function isQueuesView(id = activeViewId) { return id === QUEUES_VIEW_ID; }

// The Queues button (the app bar): pressing it inside the area does nothing.
function openQueues() {
  if (activeArea === 'queues') return;
  switchView(QUEUES_VIEW_ID);
}

// ── Reading ──
async function loadQueuesView() {
  if (!isQueuesView()) return null;
  const seq = ++queuesLoadSeq, stamp = readStamp();
  const inPlace = !!queuesData && queuesData.loaded;
  if (inPlace) { beginListReread(); showError(''); }
  else { showError(''); paintQueuesMessage('Loading…', false); }
  const showsRead = startShowsRead();
  try {
    const [rows, shows, queues, entries, marks, games] = await Promise.all([fetchAllRows(TABLE), fetchAllRows('tv_shows'),
      fetchAllRows('watch_queues'), fetchAllRows('queue_entries'), readEpisodeMarks(false), readGamesData()]);
    requireB45Shape(shows, 'priority');
    publishAllTvShows(showsRead, shows);
    if (seq !== queuesLoadSeq || !isQueuesView()) return null;
    if (!readFresh(stamp)) { readAgainWhenFree(() => { if (seq === queuesLoadSeq && isQueuesView()) loadQueuesView(); }); return null; }
    publishEpisodeMarks(marks);
    queuesData = { loaded: true, queues: sortQueues(queues), entries, rows, games };
    if (inPlace) endListReread(true);
    pickActiveQueue();
    renderQueuesView();
    return true;
  } catch (e) {
    console.error(e);
    if (seq !== queuesLoadSeq || !isQueuesView()) return null;
    if (inPlace) { endListReread(false, 'loadQueuesView', e); return false; }
    showError(`Couldn’t read your queues, so nothing is shown rather than an incomplete list. ${e.message}`);
    paintQueuesMessage('Failed to load.', true);
    return false;
  }
}

const sortQueues = qs => [...qs].sort((a, b) => a.sort_order - b.sort_order || cmpStr(a.id, b.id));
function queueEntriesOf(queueId) {
  return (queuesData ? queuesData.entries : []).filter(e => e.queue_id === queueId).sort((a, b) => a.position - b.position || cmpStr(a.id, b.id));
}
function activeQueue() {
  return queuesData && queuesData.queues.find(q => q.id === activeQueueId) || null;
}
// The queue shown: this visit's choice, else the one shown last on this browser, else the first.
function pickActiveQueue() {
  const qs = queuesData ? queuesData.queues : [];
  if (qs.some(q => q.id === activeQueueId)) return;
  let remembered = null;
  try { remembered = userStorage.getItem(QUEUE_LAST_KEY); } catch (e) { remembered = null; }
  activeQueueId = (qs.find(q => q.id === remembered) || qs[0] || {}).id || null;
}
function selectQueue(id) {
  if (!queuesData || !queuesData.queues.some(q => q.id === id)) return;
  activeQueueId = id;
  try { userStorage.setItem(QUEUE_LAST_KEY, id); } catch (e) { /* this browser keeps no choice */ }
  renderQueuesView();
}

// ── What an entry shows ──
// A film or season by its library row, a whole show by All TV's derivation (its up next, Up to date, its action).
function queueEntryView(e, rowsById, showItems, today) {
  if (e.game_entry_id) {
    // G1: a game, as its Library row shows it; hidden while it is on none of the member's platforms (its place is kept).
    const g = queuesData.games, ge = g && g.entries.find(x => x.id === e.game_entry_id);
    if (!ge) return { kind: 'game', missing: true, title: 'A game no longer in your library' };
    const v = gameEntryView(ge, gamesState(g, today));
    return { kind: 'game', game: ge, title: v.title, hidden: v.hidden, kindLine: `Game · ${v.avail.line ? gameLineText(v.avail.line) : 'Not announced on your platforms'}`,
      state: '', done: ge.status === 'finished', control: `<span class="state-action" data-action="status">${gameStatusSelectHtml(ge, 'queue')}</span>`, action: '' };
  }
  if (e.show_id) {
    const item = showItems.get(e.show_id), show = tvShowsById.get(e.show_id);
    if (!show) return { kind: 'show', missing: true, title: 'A show no longer in your library' };
    const seasons = item ? item.seasons : [];
    const complete = queueShowComplete(show, seasons);
    const up = item && item.upNext;
    const kindLine = complete ? 'Whole show' : item && item.upToDate ? 'Whole show · Up to date'
      : up ? `Whole show · Up next ${up.season}${item.upNextReleased ? '' : ` · ${isTbaRow(up) ? 'TBA' : up.display_date}`}` : 'Whole show';
    const state = complete ? 'Complete' : show.status === 'skipped' ? 'Skipped' : plainStatusLabel(show.status);
    const action = item && !complete ? showRowActionHtml(item, today, false) : '';
    return { kind: 'show', show, item, title: show.title, kindLine, state, done: complete,
      control: `<span class="state-action" data-action="status">${showStatusSelectHtml(show)}</span>`, action };
  }
  const r = rowsById.get(e.item_id);
  if (!r) return { kind: 'item', missing: true, title: 'An entry no longer in your library' };
  if (!isTvSeason(r)) {
    const skipped = r.status === 'skipped';
    const action = r.watched || skipped ? '' : `<span class="state-action" data-action="watch"><button class="watch-btn" onclick="toggleWatch('${esc(r.id)}')">Mark watched</button></span>`;
    return { kind: 'film', row: r, title: r.title, kindLine: `Film${r.display_date ? ` · ${r.display_date}` : ''}`,
      state: r.watched ? 'Watched' : skipped ? 'Skipped' : '', done: !!r.watched, action };
  }
  const off = isOffList(r);
  const released = isReleasedRow(r, today);
  const kindLine = `${r.season}${released ? '' : ` · ${isTbaRow(r) ? 'TBA' : r.display_date} · Upcoming`}`;
  const action = r.watched || off ? '' : seasonActionHtml('watch', seasonWatchControlHtml(r, { requireReleased: true, today }, false));
  return { kind: 'season', row: r, title: r.title, kindLine, state: r.watched ? 'Watched' : off ? 'Skipped' : '', done: !!r.watched, action };
}
// The database's rule (q1_show_complete): Show ended, a regular season, every regular season watched and none skipped.
function queueShowComplete(show, seasons) {
  const regular = (seasons || []).filter(r => !isSpecialRow(r));
  return !!show && !!show.ended && regular.length > 0 && regular.every(r => r.watched && !r.skipped);
}

// ── Drawing ──
function hideListForQueues() {
  ['viewHead', 'filtersRow', 'statsRow', 'tbody', 'cardList'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
  SETTINGS_LIST_CONTAINERS.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  const filtersRow = document.getElementById('filtersRow');
  if (filtersRow) filtersRow.dataset.tab = '';
  const settings = document.getElementById('settingsScreen');
  if (settings) { settings.style.display = 'none'; settings.innerHTML = ''; }
}
function paintQueuesMessage(text, withRetry) {
  hideListForQueues();
  const screen = document.getElementById('queuesScreen');
  if (!screen) return;
  screen.style.display = '';
  const retry = withRetry ? ` <button class="btn" data-retry="1" onclick="loadQueuesView()">Retry</button>` : '';
  screen.innerHTML = `<h2 class="queues-title">Queues</h2><div class="loading"${withRetry ? '' : ' tabindex="-1" data-loading="1"'}>${esc(text)}${retry}</div>`;
}

function renderQueuesView() {
  if (!isQueuesView() || !queuesData || !queuesData.loaded) return;
  const rec = captureQueueFocus();
  hideListForQueues();
  const screen = document.getElementById('queuesScreen');
  if (!screen) return;
  screen.style.display = '';
  const today = localTodayStr();
  const qs = queuesData.queues, q = activeQueue();
  const rowsById = new Map(queuesData.rows.map(r => [r.id, r]));
  const showItems = new Map(deriveAllTv(queuesData.rows, tvShowsById, today).items.map(x => [x.key, x]));
  const all = q ? queueEntriesOf(q.id) : [];
  // G1: games on none of the member's platforms are hidden; they keep their places while the others move (queueMove).
  const views = new Map(all.map(e => [e.id, queueEntryView(e, rowsById, showItems, today)]));
  const entries = all.filter(e => !views.get(e.id).hidden), hiddenCount = all.length - entries.length;
  const select = qs.length
    ? `<label class="queue-select-label" for="queueSelect">Queue</label>
       <select id="queueSelect" class="queue-select" data-qaction="select" onchange="selectQueue(this.value)">${qs.map(x =>
         `<option value="${esc(x.id)}"${q && x.id === q.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
       <span class="queue-count" id="queueCount">${countUnit(entries.length, 'entry', 'entries')}${hiddenCount ? ` (+${hiddenCount} hidden)` : ''}</span>` : '';
  const head = `<div class="queues-head">
      <h2 class="queues-title" id="queuesTitle" tabindex="-1">Queues</h2>
      <div class="queues-controls">${select}
        <button class="btn queue-manage-btn" data-qaction="manage" aria-expanded="${queueManageOpen ? 'true' : 'false'}" aria-controls="queueManage" onclick="toggleQueueManage()">Manage queues</button>
      </div>
    </div>`;
  const manage = queueManageOpen ? queueManageHtml() : '';
  let body;
  if (!qs.length) {
    body = `<div class="queue-empty" data-queue-empty="1" tabindex="-1"><p>You have no queues yet. Use Manage queues to make one, for example “Films to watch together”.</p>
      <p>Then add films, whole shows or single seasons with <strong>Add to queue…</strong> in their ⋯ menu, or a season’s <strong>Queue…</strong> button.</p></div>`;
  } else if (!entries.length && hiddenCount) {
    body = `<div class="queue-empty" data-queue-empty="1" tabindex="-1"><p>Every entry in “${esc(q.name)}” is a game on none of your platforms, so they are hidden here. They keep their places and come back when you choose a platform that has them.</p></div>`;
  } else if (!entries.length) {
    body = `<div class="queue-empty" data-queue-empty="1" tabindex="-1"><p>“${esc(q.name)}” is empty. Add films, whole shows or single seasons with <strong>Add to queue…</strong> in their ⋯ menu, or a season’s <strong>Queue…</strong> button.</p></div>`;
  } else {
    const n = entries.length;
    body = `<ol class="queue-list" id="queueList" aria-label="${esc(q.name)}">${entries.map((e, i) => queueEntryHtml(e, i, n, views.get(e.id))).join('')}</ol>`
      + (hiddenCount ? `<p class="queue-hidden-note">${countUnit(hiddenCount, 'game on none of your platforms is', 'games on none of your platforms are')} hidden here and keep${hiddenCount === 1 ? 's' : ''} ${hiddenCount === 1 ? 'its place' : 'their places'} while you reorder the others.</p>` : '');
  }
  screen.innerHTML = head + manage + body;
  applyQueueFocus(rec);
}

function queueEntryHtml(e, i, n, v) {
  const id = esc(e.id), idArg = esc(e.id).replace(/'/g, "\\'");
  const name = v.title + (v.kind === 'season' ? ` ${v.row.season}` : '');
  const titleBtn = v.missing ? `<span class="queue-title-text">${esc(v.title)}</span>`
    : `<button type="button" class="queue-title btn-link" data-qaction="open" onclick="openQueueEntry('${idArg}')" title="Show it in your library">${esc(v.title)}</button>`;
  const state = v.state ? `<span class="queue-state${v.done ? ' queue-done' : ''}">${esc(v.state)}</span>` : '';
  const menu = `<span class="more-cell"><button type="button" class="more-btn" data-qaction="more" aria-expanded="false" onclick="toggleMorePopover('q-${id}', this)" aria-label="${esc(`More for ${name}`)}">⋯</button>
      <div class="more-popover" id="more-popover-q-${id}" style="display:none">
        <button class="popover-action" data-qaction="top" onclick="closeRowMenu(this); moveQueueEntry('${idArg}', 1)"${i === 0 ? ' disabled' : ''}>Move to top</button>
        <button class="popover-action" data-qaction="bottom" onclick="closeRowMenu(this); moveQueueEntry('${idArg}', ${n})"${i === n - 1 ? ' disabled' : ''}>Move to bottom</button>
        <button class="popover-action" data-qaction="remove" onclick="closeRowMenu(this); removeQueueEntry('${idArg}')">Remove from queue</button>
      </div></span>`;
  return `<li class="queue-entry${v.done ? ' queue-entry-done' : ''}" data-entry="${id}">
      <span class="queue-handle" aria-hidden="true" title="Drag to reorder" onpointerdown="queueDragStart(event, '${idArg}')" onpointermove="queueDragMove(event)" onpointerup="queueDragEnd(event)" onpointercancel="queueDragCancel()">⠿</span>
      <span class="queue-pos" aria-hidden="true">${i + 1}</span>
      <div class="queue-main">
        <div class="queue-title-line">${titleBtn}${state}</div>
        ${v.kindLine ? `<div class="queue-kind">${esc(v.kindLine)}</div>` : ''}
      </div>
      <div class="queue-actions">${v.control || ''}${v.action || ''}</div>
      <div class="queue-moves">
        <button type="button" class="btn queue-move" data-qaction="up" aria-label="${esc(`Move ${name} up`)}" title="Move up" onclick="moveQueueEntry('${idArg}', ${i})"${i === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="btn queue-move" data-qaction="down" aria-label="${esc(`Move ${name} down`)}" title="Move down" onclick="moveQueueEntry('${idArg}', ${i + 2})"${i === n - 1 ? ' disabled' : ''}>↓</button>
        ${menu}
      </div>
    </li>`;
}

function queueManageHtml() {
  const qs = queuesData.queues, edit = queueManageEdit || {};
  const items = qs.map((q, i) => {
    const id = esc(q.id), idArg = esc(q.id).replace(/'/g, "\\'"), count = queueEntriesOf(q.id).length;
    if (edit.id === q.id && edit.mode === 'rename') {
      return `<li class="queue-manage-item" data-manage-queue="${id}">
        <label class="visually-hidden" for="queueRenameInput">New name for ${esc(q.name)}</label>
        <input id="queueRenameInput" class="search-input queue-name-input" data-qaction="rename-input" maxlength="100" value="${esc(edit.value ?? q.name)}" oninput="queueManageEdit.value = this.value" onkeydown="if (event.key === 'Enter') { event.preventDefault(); renameQueue('${idArg}'); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelQueueEdit('${idArg}', 'rename'); }">
        <button class="btn btn-accent" data-qaction="rename-save" onclick="renameQueue('${idArg}')">Save</button>
        <button class="btn" data-qaction="rename-cancel" onclick="cancelQueueEdit('${idArg}', 'rename')">Cancel</button></li>`;
    }
    if (edit.id === q.id && edit.mode === 'delete') {
      return `<li class="queue-manage-item queue-manage-confirm" data-manage-queue="${id}">
        <span>Delete “${esc(q.name)}”${count ? ` and its ${countUnit(count, 'entry', 'entries')}` : ''}? Films, shows and progress stay in your library.</span>
        <button class="btn-danger" data-qaction="delete-confirm" onclick="deleteQueue('${idArg}', ${count})">Delete queue</button>
        <button class="btn" data-qaction="delete-cancel" onclick="cancelQueueEdit('${idArg}', 'delete')">Cancel</button></li>`;
    }
    return `<li class="queue-manage-item" data-manage-queue="${id}">
      <span class="queue-manage-name">${esc(q.name)}</span> <span class="queue-manage-count">${countUnit(count, 'entry', 'entries')}</span>
      <span class="queue-manage-actions">
        <button class="btn queue-move" data-qaction="q-up" aria-label="${esc(`Move ${q.name} up`)}" title="Move up" onclick="moveQueue('${idArg}', ${i})"${i === 0 ? ' disabled' : ''}>↑</button>
        <button class="btn queue-move" data-qaction="q-down" aria-label="${esc(`Move ${q.name} down`)}" title="Move down" onclick="moveQueue('${idArg}', ${i + 2})"${i === qs.length - 1 ? ' disabled' : ''}>↓</button>
        <button class="btn" data-qaction="rename" aria-label="${esc(`Rename ${q.name}`)}" onclick="startQueueEdit('${idArg}', 'rename')">Rename</button>
        <button class="btn" data-qaction="delete" aria-label="${esc(`Delete ${q.name}`)}" onclick="startQueueEdit('${idArg}', 'delete')">Delete…</button>
      </span></li>`;
  }).join('');
  return `<section class="queue-manage" id="queueManage" aria-label="Manage queues">
      ${qs.length ? `<ol class="queue-manage-list">${items}</ol>` : ''}
      <div class="queue-new">
        <label for="queueNewName">New queue</label>
        <input id="queueNewName" class="search-input queue-name-input" maxlength="100" placeholder="Name" value="${esc(queueNewName)}" oninput="queueNewName = this.value" onkeydown="if (event.key === 'Enter') { event.preventDefault(); createQueueFromManage(); }">
        <button class="btn btn-accent" data-qaction="create" onclick="createQueueFromManage()">Create</button>
      </div>
    </section>`;
}

// ── Focus (the list's rule, for this screen) ──
function captureQueueFocus() {
  if (queueFocusIntent) { const i = queueFocusIntent; queueFocusIntent = null; return i; }
  if (!documentHasFocus()) return null;
  const a = document.activeElement;
  if (!a || typeof a.closest !== 'function' || !a.closest('#queuesScreen')) return null;
  const entryEl = a.closest('[data-entry]'), manageEl = a.closest('[data-manage-queue]');
  const hookEl = a.closest('[data-qaction], [data-shortcut-show], [data-action]');
  const hook = !hookEl ? null : hookEl.getAttribute('data-qaction') != null ? ['data-qaction', hookEl.getAttribute('data-qaction')]
    : hookEl.getAttribute('data-shortcut-show') != null ? ['data-shortcut-show', hookEl.getAttribute('data-shortcut-show')] : ['data-action', hookEl.getAttribute('data-action')];
  const screen = document.getElementById('queuesScreen');
  const ids = entryEl ? [...screen.querySelectorAll('[data-entry]')].map(x => x.getAttribute('data-entry')) : [];
  const entry = entryEl ? entryEl.getAttribute('data-entry') : null, at = ids.indexOf(entry);
  return { entry, manage: manageEl ? manageEl.getAttribute('data-manage-queue') : null, hook,
    next: at >= 0 ? ids.slice(at + 1) : [], prev: at >= 0 ? ids.slice(0, at).reverse() : [] };
}
function applyQueueFocus(rec) {
  if (!rec || !documentHasFocus()) return;
  const screen = document.getElementById('queuesScreen');
  if (!screen) return;
  const v = x => JSON.stringify(String(x));
  const off = el => !!el && (el.disabled === true || (typeof el.getAttribute === 'function' && el.getAttribute('disabled') !== null));
  const usable = el => !!el && !off(el) && typeof el.focus === 'function';
  const inEntry = (id, sel) => screen.querySelector(`[data-entry=${v(id)}] ${sel}`);
  const hookSel = h => `[${h[0]}=${v(h[1])}]`;
  const focusable = el => (!el ? null : el.matches('button, select, input, [tabindex]') ? el : el.querySelector('button, select, input'));
  if (typeof screen.querySelector !== 'function') return;
  let el = null;
  if (rec.entry) {
    if (rec.hook) el = focusable(inEntry(rec.entry, hookSel(rec.hook)));
    // A move button that is now disabled (top or bottom): the other one.
    if (off(el) && rec.hook[1] === 'up') el = inEntry(rec.entry, '[data-qaction="down"]');
    else if (off(el) && rec.hook[1] === 'down') el = inEntry(rec.entry, '[data-qaction="up"]');
    if (!usable(el)) el = inEntry(rec.entry, '[data-qaction="more"]');
    for (const id of rec.next.concat(rec.prev)) { if (usable(el)) break; el = inEntry(id, '[data-qaction="more"]'); }
    if (!usable(el)) el = screen.querySelector('[data-queue-empty], #queueSelect');
  } else if (rec.manage) {
    if (rec.hook) el = screen.querySelector(`[data-manage-queue=${v(rec.manage)}] ${hookSel(rec.hook)}`);
    if (off(el) && rec.hook[1] === 'q-up') el = screen.querySelector(`[data-manage-queue=${v(rec.manage)}] [data-qaction="q-down"]`);
    else if (off(el) && rec.hook[1] === 'q-down') el = screen.querySelector(`[data-manage-queue=${v(rec.manage)}] [data-qaction="q-up"]`);
    if (!usable(el)) el = screen.querySelector(`[data-manage-queue=${v(rec.manage)}] [data-qaction="rename"]`);
    if (!usable(el)) el = screen.querySelector('#queueNewName');
  } else if (rec.hook) {
    el = rec.hook[0] === 'id' ? screen.querySelector(`#${rec.hook[1]}`) : screen.querySelector(hookSel(rec.hook));
  }
  if (!usable(el)) el = screen.querySelector('#queueSelect, [data-queue-empty], #queuesTitle');
  if (usable(el)) el.focus();
}

// ── Entries: move and remove ──
const queueMovedIds = (ids, id, to) => { const rest = ids.filter(x => x !== id), k = Math.max(1, Math.min(to, rest.length + 1)); return [...rest.slice(0, k - 1), id, ...rest.slice(k - 1)]; };
// The whole order after moving one shown entry to the 1-based place `to` among the shown ones: hidden entries keep their places
// (their slots), and the shown ones are put back into the other slots in their new order. Pure.
function queueOrderWithHidden(ids, shown, id, to) {
  const visible = ids.filter(x => shown.has(x));
  const moved = queueMovedIds(visible, id, to);
  let k = 0;
  return ids.map(x => (shown.has(x) ? moved[k++] : x));
}
// to: the 1-based place among the shown entries. One guarded change with the order the page has: library_queue_move when nothing
// is hidden (as before G1), else library_queue_set_order with the whole order, hidden entries in their places.
async function moveQueueEntry(entryId, to, focusAfter = null) {
  const q = activeQueue();
  if (!q) return;
  const list = queueEntriesOf(q.id), expected = list.map(e => e.id);
  const today = localTodayStr(), rowsById = new Map(queuesData.rows.map(r => [r.id, r]));
  const shown = new Set(list.filter(e => !(e.game_entry_id && queueEntryView(e, rowsById, new Map(), today).hidden)).map(e => e.id));
  const visible = expected.filter(id => shown.has(id)), from = visible.indexOf(entryId);
  if (from < 0) return;
  const target = Math.max(1, Math.min(to, visible.length));
  if (target === from + 1) { renderQueuesView(); return; }
  if (shown.size < list.length) return setQueueOrder(q, list, queueOrderWithHidden(expected, shown, entryId, target), focusAfter);
  const v = list[from];
  await runWrite(`“${q.name}” · order`, async lane => {
    lane.queueReread = true; // (showSaved: no second read)
    const before = list.map(e => [e, e.position]);
    queueMovedIds(expected, entryId, target).forEach((id, i) => { list.find(e => e.id === id).position = i + 1; });
    if (focusAfter) queueFocusIntent = focusAfter;
    renderQueuesView();
    try {
      await sbRpc('library_queue_move', { p_queue_id: q.id, p_expected: expected, p_entry_id: v.id, p_to_index: target });
      showSaved();
    } catch (e) {
      before.forEach(([entry, p]) => { entry.position = p; });
      if (stateNeedsReread(e)) { await reportStateFailure(e); return; }
      showError(stateErrorText(e));
      renderQueuesView();
    }
  }, { list: true });
}

async function setQueueOrder(q, list, order, focusAfter) {
  const expected = list.map(e => e.id);
  await runWrite(`“${q.name}” · order`, async lane => {
    lane.queueReread = true;
    const before = list.map(e => [e, e.position]);
    order.forEach((id, i) => { list.find(e => e.id === id).position = i + 1; });
    if (focusAfter) queueFocusIntent = focusAfter;
    renderQueuesView();
    try {
      await sbRpc('library_queue_set_order', { p_queue_id: q.id, p_expected: expected, p_order: order });
      showSaved();
    } catch (e) {
      before.forEach(([entry, p]) => { entry.position = p; });
      if (stateNeedsReread(e)) { await reportStateFailure(e); return; }
      showError(stateErrorText(e));
      renderQueuesView();
    }
  }, { list: true });
}

async function removeQueueEntry(entryId) {
  const q = activeQueue();
  if (!q || !queuesData) return;
  const e = queuesData.entries.find(x => x.id === entryId);
  if (!e) return;
  await runWrite(`“${q.name}” · remove`, async lane => {
    lane.queueReread = true;
    queuesData.entries = queuesData.entries.filter(x => x !== e);
    renderQueuesView();
    try {
      await sbRpc('library_queue_remove', { p_entry_id: entryId });
      showSaved();
    } catch (err) {
      queuesData.entries.push(e);
      if (stateNeedsReread(err)) { await reportStateFailure(err); return; }
      showError(stateErrorText(err));
      renderQueuesView();
    }
  }, { list: true });
}

// ── Queues: manage ──
function toggleQueueManage() {
  queueManageOpen = !queueManageOpen;
  queueManageEdit = null;
  renderQueuesView();
  if (queueManageOpen) { const input = document.getElementById('queueNewName'); if (input && typeof input.focus === 'function' && !(queuesData && queuesData.queues.length)) input.focus(); }
}
function startQueueEdit(id, mode) {
  const q = queuesData && queuesData.queues.find(x => x.id === id);
  if (!q) return;
  queueManageEdit = { id, mode, value: q.name };
  renderQueuesView();
  const el = document.querySelector(mode === 'rename' ? '#queueRenameInput' : `[data-manage-queue=${JSON.stringify(id)}] [data-qaction="delete-cancel"]`);
  if (el && typeof el.focus === 'function') { el.focus(); if (mode === 'rename' && typeof el.select === 'function') el.select(); }
}
function cancelQueueEdit(id, mode) {
  queueManageEdit = null;
  queueFocusIntent = { entry: null, manage: id, hook: ['data-qaction', mode], next: [], prev: [] };
  renderQueuesView();
}
async function createQueueFromManage() {
  const name = String(queueNewName || '').trim();
  if (!name) { showError('Give the new queue a name. Nothing was changed.'); return; }
  const made = await createQueueNamed(name);
  if (!made) return;
  queueNewName = '';
  activeQueueId = made.id;
  try { userStorage.setItem(QUEUE_LAST_KEY, made.id); } catch (e) { /* not remembered */ }
  queueFocusIntent = { entry: null, manage: null, hook: ['id', 'queueNewName'], next: [], prev: [] };
  renderQueuesView();
}
// Creates a queue at the end (library_queue_create); the new row or null. Shared with the Add dialog.
async function createQueueNamed(name, report = showError) {
  let made = null;
  await runWrite('New queue', async lane => {
    lane.queueReread = true;
    try {
      made = await sbRpc('library_queue_create', { p_name: name });
      if (queuesData && made && !queuesData.queues.some(q => q.id === made.id)) queuesData.queues = sortQueues(queuesData.queues.concat([made]));
      showSaved();
      if (isQueuesView()) showError('');
    } catch (e) {
      made = null;
      report(stateErrorText(e));
      if (stateNeedsReread(e) && isQueuesView()) await reloadOpenView();
    }
  }, { list: isQueuesView() });
  return made;
}
async function renameQueue(id) {
  const q = queuesData && queuesData.queues.find(x => x.id === id);
  if (!q || !queueManageEdit) return;
  const name = String(queueManageEdit.value || '').trim();
  if (!name) { showError('A queue needs a name. Nothing was changed.'); return; }
  if (name === q.name) { cancelQueueEdit(id, 'rename'); return; }
  await runWrite(`“${q.name}” · rename`, async lane => {
    lane.queueReread = true;
    try {
      await sbRpc('library_queue_rename', { p_queue_id: id, p_expected_name: q.name, p_name: name });
      q.name = name;
      queueManageEdit = null;
      queueFocusIntent = { entry: null, manage: id, hook: ['data-qaction', 'rename'], next: [], prev: [] };
      showSaved();
      showError('');
      renderQueuesView();
    } catch (e) {
      if (stateNeedsReread(e)) { queueManageEdit = null; await reportStateFailure(e); return; }
      showError(stateErrorText(e));
    }
  }, { list: true });
}
async function deleteQueue(id, count) {
  const q = queuesData && queuesData.queues.find(x => x.id === id);
  if (!q) return;
  const order = queuesData.queues.map(x => x.id), at = order.indexOf(id);
  await runWrite(`“${q.name}” · delete`, async lane => {
    lane.queueReread = true;
    try {
      await sbRpc('library_queue_delete', { p_queue_id: id, p_expected_count: count });
      queuesData.queues = queuesData.queues.filter(x => x.id !== id);
      queuesData.entries = queuesData.entries.filter(e => e.queue_id !== id);
      queueManageEdit = null;
      if (activeQueueId === id) { activeQueueId = null; pickActiveQueue(); }
      const nextId = order[at + 1] || order[at - 1] || null;
      queueFocusIntent = nextId ? { entry: null, manage: nextId, hook: ['data-qaction', 'delete'], next: [], prev: [] } : { entry: null, manage: null, hook: ['id', 'queueNewName'], next: [], prev: [] };
      showSaved();
      showNotice(`“${q.name}” was deleted. Its films, shows and progress stay in your library.`);
      renderQueuesView();
    } catch (e) {
      queueManageEdit = null;
      if (stateNeedsReread(e)) { await reportStateFailure(e); return; }
      showError(stateErrorText(e));
      renderQueuesView();
    }
  }, { list: true });
}
// to: the 1-based place among the queues (library_queue_reorder with the order shown).
async function moveQueue(id, to) {
  if (!queuesData) return;
  const qs = queuesData.queues, expected = qs.map(q => q.id), from = expected.indexOf(id);
  const target = Math.max(1, Math.min(to, qs.length));
  if (from < 0 || target === from + 1) return;
  await runWrite('Queue order', async lane => {
    lane.queueReread = true;
    const before = qs.map(q => [q, q.sort_order]);
    queueMovedIds(expected, id, target).forEach((qid, i) => { qs.find(q => q.id === qid).sort_order = i + 1; });
    queuesData.queues = sortQueues(qs);
    renderQueuesView();
    try {
      await sbRpc('library_queue_reorder', { p_expected: expected, p_queue_id: id, p_to_index: target });
      showSaved();
    } catch (e) {
      before.forEach(([q, s]) => { q.sort_order = s; });
      queuesData.queues = sortQueues(queuesData.queues);
      if (stateNeedsReread(e)) { await reportStateFailure(e); return; }
      showError(stateErrorText(e));
      renderQueuesView();
    }
  }, { list: true });
}

// After a confirmed change made from the queue (a film or season marked watched, a show's status, an episode), the queue
// is read again once the change ends: completing an item takes it out in the database.
function noteQueueSaved() {
  if (typeof isQueuesView !== 'function' || !isQueuesView() || !writeLane || writeLane.queueReread) return;
  writeLane.queueReread = true;
  writeLane.after.push(() => { if (isQueuesView()) reloadOpenView(); });
}

// ── Dragging an entry (mouse and touch, on the handle only) ──
// The drop place: how many of the other entries' midpoints lie above the pointer. Pure.
function queueDropIndex(midpoints, y) {
  return midpoints.filter(m => m < y).length;
}
function queueDragStart(event, entryId) {
  if (queueDrag || writeLane || listStale) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const handle = event.currentTarget || event.target;
  const li = handle && typeof handle.closest === 'function' ? handle.closest('[data-entry]') : null;
  if (!li) return;
  queueDrag = { entryId, pointerId: event.pointerId, startY: event.clientY, y: event.clientY, started: false, li, handle, raf: 0 };
  if (typeof handle.setPointerCapture === 'function') { try { handle.setPointerCapture(event.pointerId); } catch (e) { /* not capturable */ } }
  if (typeof event.preventDefault === 'function') event.preventDefault();
}
function queueDragMove(event) {
  const d = queueDrag;
  if (!d || event.pointerId !== d.pointerId) return;
  d.y = event.clientY;
  if (!d.started) {
    if (Math.abs(d.y - d.startY) < QUEUE_DRAG_START_PX) return;
    d.started = true;
    d.li.classList.add('queue-dragging');
    document.body.classList.add('queue-drag-active');
    d.raf = requestAnimationFrame(queueDragScroll);
  }
  if (typeof event.preventDefault === 'function') event.preventDefault();
  queueDragPlace();
}
// The dragged entry is placed among the others as the pointer passes their midpoints.
function queueDragPlace() {
  const d = queueDrag, list = d && d.li.parentElement;
  if (!list) return;
  const others = [...list.querySelectorAll('[data-entry]')].filter(x => x !== d.li);
  const mids = others.map(x => { const r = x.getBoundingClientRect(); return r.top + r.height / 2; });
  const k = queueDropIndex(mids, d.y);
  const before = others[k] || null;
  if (before !== d.li.nextElementSibling || (!before && list.lastElementChild !== d.li)) list.insertBefore(d.li, before);
}
// Near the top or bottom of the window the page scrolls while an entry is held there.
function queueDragScroll() {
  const d = queueDrag;
  if (!d || !d.started) return;
  const edge = 56, h = window.innerHeight || 0;
  const step = d.y < edge ? -Math.ceil((edge - d.y) / 4) : d.y > h - edge ? Math.ceil((d.y - (h - edge)) / 4) : 0;
  if (step) { window.scrollBy(0, step); queueDragPlace(); }
  d.raf = requestAnimationFrame(queueDragScroll);
}
function queueDragFinish() {
  const d = queueDrag;
  queueDrag = null;
  if (!d) return null;
  if (d.raf) cancelAnimationFrame(d.raf);
  d.li.classList.remove('queue-dragging');
  document.body.classList.remove('queue-drag-active');
  return d;
}
function queueDragEnd(event) {
  const d = queueDrag;
  if (!d || (event && event.pointerId !== d.pointerId)) return;
  queueDragFinish();
  if (!d.started) return; // a tap on the handle moves nothing
  const ids = [...d.li.parentElement.querySelectorAll('[data-entry]')].map(x => x.getAttribute('data-entry'));
  const to = ids.indexOf(d.entryId) + 1;
  moveQueueEntry(d.entryId, to, { entry: d.entryId, manage: null, hook: ['data-qaction', 'up'], next: [], prev: [] });
}
function queueDragCancel() {
  const d = queueDragFinish();
  if (d && d.started) renderQueuesView(); // the order shown goes back to what is saved
}
document.addEventListener('keydown', e => { if (queueDrag && e.key === 'Escape') { e.preventDefault(); queueDragCancel(); } });

// ── Opening an entry where it lives ──
// A season or whole show: All TV, as Shows for this visit (the remembered choice isn't changed), searched by its title,
// the show expanded and the season (or the show) focused; a skipped season's show shows its skipped seasons, a Skipped show
// widens the status filter. A film: All Movies, searched by its title, its row focused.
function openQueueEntry(entryId) {
  const e = queuesData && queuesData.entries.find(x => x.id === entryId);
  if (!e) return;
  if (e.game_entry_id) {
    const g = queuesData.games && queuesData.games.entries.find(x => x.id === e.game_entry_id);
    if (!g) return;
    gamesFilters = { search: g.title, genre: '', status: 'all' };
    switchView('games');
    return;
  }
  const row = e.item_id ? queuesData.rows.find(r => r.id === e.item_id) : null;
  if (row && !isTvSeason(row)) {
    activeMediaType = 'movie';
    backNavFilters = { view: ALL_MOVIES_VIEW.id, values: { fSearch: row.title, ...(row.status === 'skipped' ? { fStatus: 'all' } : {}) } };
    pendingReveal = { viewId: ALL_MOVIES_VIEW.id, item: row.id, season: null };
    switchView(ALL_MOVIES_VIEW.id);
    buildMediaSwitch();
    return;
  }
  const showId = e.show_id || (row && row.show_id);
  const show = showId ? tvShowsById.get(showId) : null;
  if (!show) return;
  activeMediaType = 'tv';
  backNavFilters = { view: 'alltv', values: { fSearch: show.title, ...(show.status === 'skipped' ? { fStatus: 'all' } : {}) } };
  pendingReveal = { viewId: 'alltv', item: show.id, season: row ? row.id : null };
  switchView('alltv');
  allTvPresentation = 'shows';
  expandedShows.add(show.id);
  if (row && row.skipped) shownSkippedSeasons.add(show.id);
  buildMediaSwitch();
}
// After the list is drawn: the revealed season's or item's first control takes focus and is scrolled into view.
function applyPendingReveal() {
  const p = pendingReveal;
  if (!p || p.viewId !== activeViewId) return;
  pendingReveal = null;
  const v = x => JSON.stringify(String(x));
  for (const id of ['tbody', 'cardList']) {
    const box = document.getElementById(id);
    if (!box || !isRendered(box)) continue;
    const holder = p.season ? box.querySelector(`[data-season-row=${v(p.season)}]`) : box.querySelector(`[data-item=${v(p.item)}]`);
    if (!holder) continue;
    const el = holder.matches('[data-primary]') ? holder : holder.querySelector('[data-primary], button, select');
    if (el && typeof el.focus === 'function') el.focus();
    if (typeof holder.scrollIntoView === 'function') holder.scrollIntoView({ block: 'center' });
    return;
  }
}

// ── Add to queue (the ⋯ menus and the flat season lists) ──
// kind 'show' (a show; seasonId preselects one of its seasons) or 'item' (a film). opener: the control that opened it
// (focus goes back there). The dialog reads the queues fresh; adding is one change at the bottom of one queue.
function openAddToQueueFromMenu(control, kind, id) {
  const container = control.closest('.more-cell, .card-top');
  const opener = container ? container.querySelector('.more-btn') : control;
  closeMorePopovers();
  openAddToQueue(kind, id, null, opener);
}
function openAddToQueue(kind, id, seasonId, opener) {
  if (writeLane) { showError(LANE_BUSY_TEXT(writeLane.label)); return; }
  let title = '', seasons = [];
  if (kind === 'game') {
    const g = (gamesData && gamesData.entries.find(x => x.id === id)) || (queuesData && queuesData.games && queuesData.games.entries.find(x => x.id === id));
    if (!g) return;
    title = g.title;
  } else if (kind === 'item') {
    const r = actionRows().find(x => x.id === id);
    if (!r) return;
    if (isTvSeason(r) && r.show_id) return openAddToQueue('show', r.show_id, r.id, opener);
    title = r.title;
  } else {
    const show = tvShowsById.get(id);
    if (!show) return;
    title = show.title;
    seasons = actionRows().filter(r => r.show_id === id && isTvSeason(r)).sort(compareSeasons);
  }
  queueAdd = { session: ++queueAddSeq, kind, id, title, seasons, choice: kind === 'show' ? (seasonId || 'show') : id, queueId: null,
    status: 'loading', queues: [], entries: [], message: '', newName: '', opener: opener || document.activeElement || null, viewId: activeViewId };
  const overlay = document.getElementById('queueAddOverlay');
  if (overlay) overlay.style.display = 'flex';
  renderQueueAdd();
  const box = document.getElementById('queueAddBox');
  if (box && typeof box.focus === 'function') box.focus();
  readQueueAddData();
}
async function readQueueAddData() {
  const a = queueAdd;
  if (!a) return;
  const session = a.session, stamp = readStamp();
  a.status = 'loading'; renderQueueAdd();
  try {
    const [queues, entries] = await Promise.all([fetchAllRows('watch_queues'), fetchAllRows('queue_entries')]);
    if (!queueAdd || queueAdd.session !== session) return;
    if (!readFresh(stamp)) { readAgainWhenFree(() => { if (queueAdd && queueAdd.session === session) readQueueAddData(); }); return; }
    a.queues = sortQueues(queues); a.entries = entries; a.status = 'ready';
    if (!a.queueId || queueAddBlock(a, a.queueId)) a.queueId = queueAddDefault(a);
    renderQueueAdd();
  } catch (e) {
    if (!queueAdd || queueAdd.session !== session) return;
    a.status = 'error'; a.message = `Your queues couldn’t be read (${e.message}).`;
    renderQueueAdd();
  }
}
// Why the chosen thing can't go into queue q (null: it can).
function queueAddBlock(a, qid) {
  const list = a.entries.filter(e => e.queue_id === qid).sort((x, y) => x.position - y.position);
  const place = pred => list.findIndex(pred) + 1;
  if (a.kind === 'item') { const n = place(e => e.item_id === a.id); return n ? `Already in this queue (#${n})` : null; }
  if (a.kind === 'game') { const n = place(e => e.game_entry_id === a.id); return n ? `Already in this queue (#${n})` : null; }
  const seasonIds = new Set(a.seasons.map(r => r.id));
  if (a.choice === 'show') {
    const n = place(e => e.show_id === a.id);
    if (n) return `Already in this queue (#${n})`;
    const held = list.filter(e => seasonIds.has(e.item_id)).map(e => (a.seasons.find(r => r.id === e.item_id) || {}).season).filter(Boolean);
    return held.length ? `Has ${held.join(', ')} of this show` : null;
  }
  const n = place(e => e.item_id === a.choice);
  if (n) return `Already in this queue (#${n})`;
  return list.some(e => e.show_id === a.id) ? 'The whole show is in this queue' : null;
}
function queueAddDefault(a) {
  let last = null;
  try { last = userStorage.getItem(QUEUE_ADD_LAST_KEY); } catch (e) { last = null; }
  const open = a.queues.filter(q => !queueAddBlock(a, q.id));
  return (open.find(q => q.id === last) || open[0] || {}).id || null;
}
function renderQueueAdd() {
  const a = queueAdd, box = document.getElementById('queueAddBox');
  if (!a || !box) return;
  const seasonName = r => `${r.season}${r.watched ? ' (watched)' : r.skipped ? ' (skipped)' : ''}`;
  const what = a.kind === 'show' ? `<fieldset class="queue-add-what"><legend>What to add</legend>
      <label class="queue-add-option"><input type="radio" name="queueAddWhat" value="show"${a.choice === 'show' ? ' checked' : ''} onchange="queueAddChoose(this.value)"> The whole show</label>
      ${a.seasons.map(r => `<label class="queue-add-option"><input type="radio" name="queueAddWhat" value="${esc(r.id)}"${a.choice === r.id ? ' checked' : ''} onchange="queueAddChoose(this.value)"> ${esc(seasonName(r))}</label>`).join('')}
    </fieldset>` : '';
  let queues;
  if (a.status === 'loading') queues = '<p class="modal-progress">Reading your queues…</p>';
  else if (a.status === 'error') queues = `<p class="modal-error">${esc(a.message)}</p><button class="btn" onclick="readQueueAddData()">Retry</button>`;
  else queues = `<fieldset class="queue-add-queues"><legend>Queue</legend>${a.queues.length ? a.queues.map(q => {
      const block = queueAddBlock(a, q.id);
      return `<label class="queue-add-option${block ? ' queue-add-blocked' : ''}"><input type="radio" name="queueAddQueue" value="${esc(q.id)}"${a.queueId === q.id && !block ? ' checked' : ''}${block ? ' disabled' : ''} onchange="queueAddPick(this.value)"> ${esc(q.name)}${block ? ` <span class="queue-add-note">${esc(block)}</span>` : ''}</label>`;
    }).join('') : '<p class="queue-add-note">You have no queues yet. Make one here.</p>'}
      <div class="queue-new"><label for="queueAddNew">New queue</label>
        <input id="queueAddNew" class="search-input queue-name-input" maxlength="100" placeholder="Name" value="${esc(a.newName)}" oninput="queueAdd.newName = this.value" onkeydown="if (event.key === 'Enter') { event.preventDefault(); queueAddCreate(); }">
        <button class="btn" onclick="queueAddCreate()">Create</button></div>
    </fieldset>`;
  const canAdd = a.status === 'ready' && !!a.queueId && !queueAddBlock(a, a.queueId) && !a.busy;
  const note = a.status === 'ready' && a.message ? `<p class="modal-error" role="alert">${esc(a.message)}</p>` : '';
  box.innerHTML = `<h2 class="modal-title" id="queueAddTitle">Add to a queue</h2>
    <p class="queue-add-title">“${esc(a.title)}”</p>
    ${what}${queues}${note}
    <p class="queue-add-help">It goes at the bottom. Its status isn’t changed.${a.kind === 'game' ? ' Setting it to Finished takes it out of every queue.' : ''}</p>
    <div class="modal-actions"><button class="btn" onclick="closeQueueAdd()">Cancel</button>
      <button class="btn btn-accent" id="queueAddSubmit" onclick="submitQueueAdd()"${canAdd ? '' : ' disabled'}>${a.busy ? 'Adding…' : 'Add'}</button></div>`;
}
function queueAddChoose(value) {
  const a = queueAdd;
  if (!a || a.busy) return;
  a.choice = value; a.message = '';
  if (!a.queueId || queueAddBlock(a, a.queueId)) a.queueId = queueAddDefault(a);
  renderQueueAdd();
  const el = document.querySelector(`#queueAddBox input[name="queueAddWhat"][value=${JSON.stringify(value)}]`);
  if (el && typeof el.focus === 'function') el.focus();
}
function queueAddPick(qid) {
  if (!queueAdd || queueAdd.busy) return;
  queueAdd.queueId = qid; queueAdd.message = '';
  renderQueueAdd();
  const el = document.querySelector(`#queueAddBox input[name="queueAddQueue"][value=${JSON.stringify(qid)}]`);
  if (el && typeof el.focus === 'function') el.focus();
}
async function queueAddCreate() {
  const a = queueAdd;
  if (!a || a.busy) return;
  const name = String(a.newName || '').trim();
  if (!name) { a.message = 'Give the new queue a name. Nothing was changed.'; renderQueueAdd(); return; }
  const session = a.session;
  const made = await createQueueNamed(name, text => { if (queueAdd && queueAdd.session === session) { queueAdd.message = text; renderQueueAdd(); } });
  if (!made || !queueAdd || queueAdd.session !== session) return;
  a.queues = sortQueues(a.queues.filter(q => q.id !== made.id).concat([made]));
  a.queueId = made.id; a.newName = ''; a.message = '';
  renderQueueAdd();
  const el = document.getElementById('queueAddSubmit');
  if (el && typeof el.focus === 'function') el.focus();
}
async function submitQueueAdd() {
  const a = queueAdd;
  if (!a || a.busy || a.status !== 'ready' || !a.queueId || queueAddBlock(a, a.queueId)) return;
  const q = a.queues.find(x => x.id === a.queueId);
  const showId = a.kind === 'show' && a.choice === 'show' ? a.id : null, itemId = showId ? null : a.choice;
  const label = a.kind === 'show' && a.choice !== 'show' ? `${a.title} ${(a.seasons.find(r => r.id === a.choice) || {}).season || ''}`.trim() : a.title;
  a.busy = true; renderQueueAdd();
  await runWrite(`“${label}” · queue`, async lane => {
    lane.queueReread = true;
    try {
      const res = a.kind === 'game' ? await sbRpc('library_queue_add_game', { p_queue_id: q.id, p_entry_id: a.id })
        : await sbRpc('library_queue_add', { p_queue_id: q.id, p_show_id: showId, p_item_id: itemId });
      try { userStorage.setItem(QUEUE_ADD_LAST_KEY, q.id); } catch (e) { /* not remembered */ }
      showSaved();
      dismissQueueAdd(true);
      showNotice(`Added “${label}” to “${q.name}” (#${res && res.place ? res.place : '?'}).`);
    } catch (e) {
      if (!queueAdd || queueAdd.session !== a.session) return;
      a.busy = false;
      a.message = stateErrorText(e) + (orgErrorInfo(e).kind === 'database' ? '' : ' Your queues are being read again.');
      renderQueueAdd();
      await readQueueAddData();
    }
  });
  if (queueAdd && queueAdd.session === a.session && a.busy) { a.busy = false; renderQueueAdd(); } // (the lane refused it)
}
function closeQueueAdd() {
  if (!queueAdd || queueAdd.busy) return;
  dismissQueueAdd(true);
}
function dismissQueueAdd(returnFocus) {
  const a = queueAdd;
  if (!a) return;
  queueAdd = null;
  const overlay = document.getElementById('queueAddOverlay'), box = document.getElementById('queueAddBox');
  if (overlay) overlay.style.display = 'none';
  if (box) box.innerHTML = '';
  if (returnFocus) returnDialogFocus(a.opener, () => document.getElementById('mainContent'));
}
function queueAddKeydown(event) {
  if (!queueAdd || !event) return;
  dialogKeydown(event, document.getElementById('queueAddBox'), 'button, input, [tabindex="0"]', closeQueueAdd);
}
// Leaving the view: an idle dialog closes (nothing was sent).
function queueOnNavigate() {
  if (queueAdd && !queueAdd.busy) dismissQueueAdd(false);
  if (queueDrag) queueDragFinish();
  queueManageEdit = null;
}

// The Queue… button of a season in the flat lists (All TV Seasons, a collection's Seasons, Coming Soon).
function queueSeasonButtonHtml(r) {
  if (!r || !r.show_id) return '';
  const idArg = esc(r.id).replace(/'/g, "\\'");
  return seasonActionHtml('queue', `<button type="button" class="btn btn-link queue-season-btn" aria-label="${esc(`Add ${r.season} of ${r.title} to a queue`)}" onclick="openAddToQueue('item', '${idArg}', null, this)">Queue…</button>`);
}
// The ⋯ menu's entry (shows and films).
function addToQueueMenuHtml(kind, id) {
  const idArg = esc(id).replace(/'/g, "\\'");
  return `<div class="popover-section-label" style="margin-top:8px">Queues</div><button class="popover-action" data-action="queue" onclick="openAddToQueueFromMenu(this, '${kind}', '${idArg}')">Add to queue…</button>`;
}

// Matching (tmdb-match.js) may adjust queues in the same transaction: a whole-show entry carried to the show the season
// joined, a duplicate merged into the entry already there, or season entries a whole-show entry now covers removed.
// The page reads the entries before and after and says what changed.
async function queueEntriesSnapshot() {
  try { return await fetchAllRows('queue_entries'); } catch (e) { return null; }
}
async function queueMatchReport(before) {
  if (!before) return '';
  let after = null, queues = null;
  try { [after, queues] = await Promise.all([fetchAllRows('queue_entries'), fetchAllRows('watch_queues')]); } catch (e) { return ' Queues may have changed; open Queues to check.'; }
  const now = new Map(after.map(e => [e.id, e])), names = new Map(queues.map(q => [q.id, q.name]));
  const gone = before.filter(e => !now.has(e.id)), changed = before.filter(e => now.has(e.id) && (now.get(e.id).show_id !== e.show_id || now.get(e.id).item_id !== e.item_id));
  if (!gone.length && !changed.length) return '';
  const inQ = list => [...new Set(list.map(e => `“${names.get(e.queue_id) || 'a queue'}”`))].join(', ');
  const parts = [];
  if (changed.length) parts.push(`${countUnit(changed.length, 'queue entry', 'queue entries')} now point${changed.length === 1 ? 's' : ''} to where it moved (${inQ(changed)})`);
  if (gone.length) parts.push(`${countUnit(gone.length, 'queue entry was', 'queue entries were')} removed because the whole show is already in ${inQ(gone)}, at its place`);
  return ` Queues: ${parts.join('; ')}.`;
}
