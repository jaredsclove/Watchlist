// ─── Membership changes from a collection view (S4: Remove and Undo, D5) ──────
// A collection's own controls take a show (all its seasons) or a film out of the open
// collection, and Undo puts it back. They call the existing organization functions
// (db/phase3b2_org_write.sql) the Manage dialog uses, under its rules: the read-only
// capability check first, guarded arguments (the membership id this view read, with its
// collection and target), one change at a time through the write lane (with the list rule:
// refused while the list is out of date), Manage's wording for each answer, and the
// collection read again (reloadOpenView) inside the lane afterwards. The library itself
// (the show, its seasons, the film) is never changed here.
//
// No clear answer: reported as not confirmed, never sent again, the list read again, and no
// Undo. What the page showed is checked again after the question and before sending: the same
// view, no restore since (orgEpoch) and the same membership still listed; otherwise nothing is
// sent. An answer that arrives after you left the view or after a restore changes nothing on
// the page. Undo is offered once per confirmed removal, only in that collection's visit
// (leaving the view or a restore withdraws it).

// The open collection's membership of a show or film, as its last read listed it (with its id).
function collectionMembershipOf(kind, id) {
  const rows = (browseData && browseData.memberRows) || [];
  return rows.find(m => (kind === 'show' ? m.show_id === id : m.item_id === id)) || null;
}

// What Remove does, in the dialog's words. season: the season entry it was pressed on (O3).
function collectionRemoveText(kind, title, name, season) {
  if (kind === 'film') return `Remove “${title}” from ${name}? It stays in your library with its status and watched state. Only ${name} changes.`;
  const head = season ? `Remove the show “${title}” from ${name}?` : `Remove “${title}” from ${name}?`;
  return `${head} It stays in your library with its status and watched seasons. Only ${name} changes (the whole show, all its seasons).`
    + (season ? ` This removes every season of ${title} from ${name}, not only ${season.season}.` : '');
}

const COLLECTION_CAPABILITY_TEXT = {
  absent: 'Changing collections isn’t available on this database, so nothing was changed.',
  denied: 'The database refused access to collection editing, so nothing was changed.',
  unknown: 'Couldn’t check whether collection editing is available, so nothing was changed. Try again.'
};

// The notice above the list: a Remove's line (with Undo while it applies) and, below it, this visit's
// Add / Undo batch summary (renderAddNotice). Each keeps its own Undo until the visit ends or a restore.
function showCollectionNotice(text, withUndo) {
  removeNotice = text ? { text, withUndo: !!withUndo } : null;
  renderCollectionBanner();
}

function renderCollectionBanner() {
  const el = document.getElementById('banner');
  if (!el) return;
  const active = document.activeElement;
  const focusId = active && typeof active.closest === 'function' && active.closest('#collectionNotice, #addNotice') ? active.id || null : null;
  const inRemove = !!active && typeof active.closest === 'function' && !!active.closest('#collectionNotice');
  const inAdd = !!active && typeof active.closest === 'function' && !!active.closest('#addNotice');
  const r = removeNotice;
  const removeHtml = r ? `<div class="banner collection-notice" id="collectionNotice" role="status" tabindex="-1">${esc(r.text)}${r.withUndo
    ? ` <button class="btn" id="collectionUndoBtn" onclick="undoCollectionRemove()">Undo</button>` : ''}</div>` : '';
  el.innerHTML = removeHtml + addNoticeHtml();
  // A used button is replaced: focus stays on its notice rather than falling to the page.
  if (inRemove || inAdd) {
    const again = (focusId && document.getElementById(focusId)) || document.getElementById(inRemove ? 'collectionNotice' : 'addNotice') || document.getElementById('collectionNotice');
    if (again && typeof again.focus === 'function') again.focus();
  }
}

// kind 'show' | 'film'; id: the show's or film's id; seasonId: the season entry pressed (O3).
async function removeFromCollection(kind, id, seasonId) {
  const viewId = activeViewId;
  if (!isBrowseCollectionView(viewId) || !browseData || !browseData.loaded || (kind !== 'show' && kind !== 'film')) return;
  const dest = currentBrowseDest();
  const rec = kind === 'show' ? tvShowsById.get(id) : actionRows().find(r => r.id === id);
  const m = collectionMembershipOf(kind, id);
  if (!dest || !rec || !m) {
    showNotice('That isn’t in this collection as of its last read, so nothing was changed. The list has been read again.');
    reloadOpenView();
    return;
  }
  const season = seasonId ? actionRows().find(r => r.id === seasonId) || null : null;
  const epoch = orgEpoch;
  if (!await askEffect(collectionRemoveText(kind, rec.title, dest.label, season), `Remove from ${dest.label}`)) return;
  const now = collectionMembershipOf(kind, id);
  if (activeViewId !== viewId || orgEpoch !== epoch) return; // another view or a restore answered the question: nothing is sent
  if (!now || now.id !== m.id) {
    showNotice(`“${rec.title}” changed while the question was open, so nothing was changed. The list has been read again.`);
    reloadOpenView();
    return;
  }
  const target = { kind, id, title: rec.title, name: dest.label, collectionId: dest.collectionId, membershipId: m.id, viewId, epoch, shown: pageShowEpoch };
  await runWrite(`Remove “${rec.title}” from ${dest.label}`, () => collectionRemoveNow(target), { list: true });
}

async function collectionRemoveNow(t) {
  const cap = await checkOrgCapability();
  if (cap !== 'yes') { showError(COLLECTION_CAPABILITY_TEXT[cap] || COLLECTION_CAPABILITY_TEXT.unknown); return; }
  if (activeViewId !== t.viewId || orgEpoch !== t.epoch) return; // left or restored while checking: nothing is sent
  const args = membershipArgs('remove', { membershipId: t.membershipId, collectionId: t.collectionId, ...membershipTarget(t.kind, t.id) });
  let res = null, err = null;
  try { res = await sbRpc(membershipFn('remove'), args); } catch (e) { err = e; }
  await collectionAnswer(t, 'remove', args, res, err);
}

// Undo (once): the same collection, show or film, back through org_add_membership.
async function undoCollectionRemove() {
  const u = collectionUndo;
  if (!u || u.viewId !== activeViewId || u.epoch !== orgEpoch) { collectionUndo = null; showCollectionNotice('', false); return; }
  await runWrite(`Undo: “${u.title}” back to ${u.name}`, async () => {
    if (collectionUndo !== u) return;
    collectionUndo = null; // offered at most once, whatever the answer
    u.shown = pageShowEpoch;
    const cap = await checkOrgCapability();
    if (cap !== 'yes') { showCollectionNotice('', false); showError(COLLECTION_CAPABILITY_TEXT[cap] || COLLECTION_CAPABILITY_TEXT.unknown); return; }
    if (activeViewId !== u.viewId || orgEpoch !== u.epoch) return;
    const args = membershipArgs('add', { collectionId: u.collectionId, ...membershipTarget(u.kind, u.id) });
    let res = null, err = null;
    try { res = await sbRpc(membershipFn('add'), args); } catch (e) { err = e; }
    await collectionAnswer(u, 'add', args, res, err);
  }, { list: true });
}

// The show or film a collection-view membership request is about.
const membershipTarget = (kind, id) => ({ showId: kind === 'show' ? id : null, itemId: kind === 'film' ? id : null });

// One answer to a Remove or an Undo: reported in Manage's words; the collection is read again.
async function collectionAnswer(t, kind, args, res, err) {
  const outcome = membershipOutcome(kind, args, res, err);
  const info = outcome.info || null;
  // Left the page and brought back from the back/forward cache meanwhile: not confirmed (history.js), so
  // the answer changes nothing; the list is read again.
  if (t.shown !== pageShowEpoch) { if (activeViewId === t.viewId) await reloadOpenView(); return; }
  const here = activeViewId === t.viewId && orgEpoch === t.epoch;
  if (outcome.state === 'absent') {
    orgWriteCapability = null;
    if (here) { showCollectionNotice('', false); showError(COLLECTION_CAPABILITY_TEXT.absent); }
    return;
  }
  if (outcome.state === 'unconfirmed') {
    // No clear answer: not confirmed, never sent again; what is saved now is read (no Undo).
    const text = kind === 'remove'
      ? `Removing “${t.title}” from ${t.name} wasn’t confirmed (${info.message}): it may or may not have been removed, and it won’t be sent again.`
      : `Putting “${t.title}” back in ${t.name} wasn’t confirmed (${info.message}): it may or may not have been added, and it won’t be sent again.`;
    if (!here) return;
    showCollectionNotice('', false);
    showError(text);
    const ok = await reloadOpenView();
    if (activeViewId === t.viewId) showError(text + rereadText(ok));
    return;
  }
  // An answer after you left the collection or after a restore changes nothing on the page.
  if (!here) return;
  let text, undo = false;
  if (outcome.state === 'removed') {
    text = `Removed “${t.title}” from ${t.name}. It’s still in your library.`;
    // Undo puts back exactly this show or film (membershipUndo), once, in this collection's visit.
    if (outcome.undo) {
      collectionUndo = { kind: t.kind, id: t.id, title: t.title, name: t.name, collectionId: t.collectionId, viewId: t.viewId, epoch: t.epoch };
      undo = true;
    }
  } else if (kind === 'add' && res) {
    text = outcome.state === 'added' ? `“${t.title}” is back in ${t.name}.` : `“${t.title}” is already in ${t.name} (added again elsewhere).`;
  } else {
    const what = kind === 'remove' ? `“${t.title}” wasn’t removed from ${t.name}` : `“${t.title}” wasn’t put back in ${t.name}`;
    text = `${what}: ${outcome.note}`;
  }
  showCollectionNotice(text, undo);
  if (!res) showError('');
  await reloadOpenView();
}

// Pull rest from a collection's film (S4): the films went to your library, not to the collection,
// so the collection's reread doesn't list them; the report says so.
function collectionPullReport(tool, inserted) {
  if (!isBrowseCollectionView(tool.viewId) || activeViewId !== tool.viewId || !inserted || !inserted.length) return;
  const dest = currentBrowseDest();
  if (!dest) return;
  const n = inserted.length;
  // S5: the follow-up opens the picker with exactly these films selected; nothing is added until you press Add.
  pullPreselect = { viewId: tool.viewId, ids: inserted.map(r => r.id).filter(Boolean) };
  const follow = collectionAddAllowed() ? ` <button class="btn" id="pullAddBtn" onclick="openAddPickerForPulled(this)">Add ${n === 1 ? 'this film' : `these ${n} films`} to ${esc(dest.label)}…</button>` : '';
  libraryReport({ session: tool.session, viewId: tool.viewId },
    `Added ${n} film${n === 1 ? '' : 's'} to your library. ${n === 1 ? 'It isn’t' : 'They aren’t'} in ${dest.label}: Pull rest adds to your library, not to this collection.`, false, follow);
}

// ─── Add existing shows and films to the open collection (S5: O4, D14) ────────
// Add to <collection>… opens a picker drawn from the collection view's own complete read (every
// saved show and film; nothing is read when it opens). Pressing Add N to <collection> starts one
// batch: one change through the write lane ({ list: true }) that checks the capability, then sends
// one org_add_membership at a time, in the listed order, never two at once, each only while the
// picker session, the view and the restore epoch are unchanged. A refusal is reported and the batch
// goes on; an answer that is missing or unclear makes that item Not confirmed and stops the batch
// (the rest Not sent), with nothing sent again. Close, Escape or navigation while a request is out
// means Stop after this one: that request may still finish; nothing further is sent. After the
// batch the collection is read again (inside the lane). A membership seen in that read is never
// taken as made by this batch: only an answer says so.
// Undo is a new batch, by your press only: org_remove_membership for exactly the items reported
// Added, by the membership ids their answers returned, under the same rules; each at most once.
// The results stay in the dialog, then in a notice for the rest of that collection's visit
// (Show details; Undo while it applies). Leaving the collection or a restore withdraws Undo; a batch
// stopped by leaving reports a one-line summary in the view you went to.
const ADD_STOP_WAIT_MS = 15000;
const ADD_STATE_TEXT = {
  queued: 'Waiting', sending: 'Adding…', added: 'Added', already: name => `Already in ${name}`, notsent: 'Not sent',
  removing: 'Removing…', removed: 'Removed', notremoved: 'Not removed: already removed or changed elsewhere'
};

// The picker may open: the open collection, read completely (no member missing from the read), not
// archived, and the list not marked out of date.
function collectionAddAllowed() {
  if (!isBrowseCollectionView(activeViewId) || !browseData || !browseData.loaded || !browseData.members || listStale) return false;
  const dest = currentBrowseDest();
  return !!dest && !dest.archived && browseFilterBase().badLinks === 0;
}

// Every saved show and film of the view's read, A–Z (a show before a film of the same title), and
// how many rows are neither a TV season of a show nor a film (not offered).
function addCandidates() {
  const rows = uniqueById(browseData.rows || []);
  const m = browseData.members;
  const seasons = new Map();
  rows.forEach(r => { if (r.show_id != null && isTvViewRow(r)) seasons.set(r.show_id, (seasons.get(r.show_id) || 0) + 1); });
  const shows = [...tvShowsById.values()].map(s => ({ key: `s:${s.id}`, kind: 'show', id: s.id, title: s.title, seasons: seasons.get(s.id) || 0,
    status: plainStatusLabel(s.status), skipped: s.status === 'skipped', member: m.showIds.has(s.id) }));
  const films = rows.filter(isFilmRow).map(r => {
    const state = filmViewState(r);
    return { key: `i:${r.id}`, kind: 'film', id: r.id, title: r.title, status: String(FILM_STATE_LABELS[state] || '').replace(/^[✓✕] /, ''),
      skipped: state === 'skipped' || state === 'pair', member: m.filmIds.has(r.id) };
  });
  const unclassified = rows.filter(r => !isFilmRow(r) && r.show_id == null).length;
  const list = shows.concat(films).sort((a, b) => compareTitles(a.title, b.title) || (a.kind === 'film') - (b.kind === 'film') || cmpStr(a.id, b.id));
  return { list, unclassified };
}

// preselect: picker keys to start selected (i:<film>, s:<show>); only ones that can be added.
// Nothing is added until Add is pressed.
function openAddPicker(opener, preselect) {
  if (addPicker) return;
  if (writeLane) { showError(LANE_BUSY_TEXT(writeLane.label)); return; } // refused before anything is shown
  if (!collectionAddAllowed()) {
    showError('Adding to this collection isn’t possible right now: the list may be incomplete or out of date. Read it again first. Nothing was changed.');
    return;
  }
  const dest = currentBrowseDest();
  const can = new Set(addCandidates().list.filter(c => !c.member).map(c => c.key));
  const selected = new Set((preselect || []).filter(k => can.has(k)));
  addPicker = { session: ++addPickerSeq, viewId: activeViewId, epoch: orgEpoch, collectionId: dest.collectionId, name: dest.label,
    opener: opener || document.activeElement || null, query: '', selected, batch: null, details: false };
  const overlay = document.getElementById('addPickerOverlay');
  if (overlay) overlay.style.display = 'flex';
  renderAddPicker();
  const search = document.getElementById('addPickerSearch');
  if (search && typeof search.focus === 'function') search.focus();
}

// The Pull rest follow-up (collectionPullReport): the films it just added, preselected.
function openAddPickerForPulled(opener) {
  const ids = pullPreselect && pullPreselect.viewId === activeViewId ? pullPreselect.ids : [];
  openAddPicker(opener, ids.map(id => `i:${id}`));
}

function addBatchRunning(b) { return !!b && b.phase === 'submitting'; }

// Close (or Escape): Idle and results close; while a batch is submitting it means Stop after this one,
// and the dialog stays until the request out has answered.
function closeAddPicker() {
  const p = addPicker;
  if (!p) return;
  if (addBatchRunning(p.batch)) { p.batch.stop = true; renderAddPicker(); return; }
  dismissAddPicker(true);
}

function dismissAddPicker(returnFocus) {
  const p = addPicker;
  if (!p) return;
  addPicker = null;
  const overlay = document.getElementById('addPickerOverlay');
  const box = document.getElementById('addPickerBox');
  if (overlay) overlay.style.display = 'none';
  if (box) box.innerHTML = '';
  if (addBatch && addBatch.viewId === activeViewId) renderAddNotice();
  if (returnFocus) returnDialogFocus(p.opener, () => document.getElementById('collectionAddBtn'));
}

// Leaving the view (tabs.js switchView): an idle picker is cancelled (nothing sent); a submitting
// batch stops after its current request and reports in the view you went to.
function addPickerOnNavigate() {
  const p = addPicker;
  if (p && addBatchRunning(p.batch)) { p.batch.stop = true; p.batch.left = true; }
  if (p) dismissAddPicker(false);
  if (addBatch && !addBatchRunning(addBatch)) addBatch = null; // results and Undo belong to that visit
}

function addPickerKeydown(event) {
  if (!addPicker || !event) return;
  dialogKeydown(event, document.getElementById('addPickerBox'), 'button, input, [tabindex="0"]', closeAddPicker);
}

function addPickerSearch(el) {
  if (!addPicker || addPicker.batch) return;
  addPicker.query = el ? el.value : '';
  renderAddPicker();
}

function addPickerToggle(key, checked) {
  if (!addPicker || addPicker.batch) return;
  if (checked) addPicker.selected.add(key); else addPicker.selected.delete(key);
  renderAddPicker();
}

// ── The batches ──
async function submitAddPicker() {
  const p = addPicker;
  if (!p || p.batch || !p.selected.size) return;
  if (activeViewId !== p.viewId || orgEpoch !== p.epoch) { dismissAddPicker(false); return; }
  const chosen = addCandidates().list.filter(c => p.selected.has(c.key) && !c.member);
  if (!chosen.length) return;
  const batch = { kind: 'add', session: p.session, viewId: p.viewId, epoch: p.epoch, collectionId: p.collectionId, name: p.name,
    items: chosen.map(c => ({ key: c.key, kind: c.kind, id: c.id, title: c.title, state: 'queued' })), phase: 'submitting', stop: false };
  await startAddBatch(p, batch, `Adding to ${p.name}`);
}

// Undo: a new batch for exactly the items reported Added (their returned membership ids), each once.
async function undoAddBatch() {
  const root = addBatch && addBatch.kind === 'add' ? addBatch : addBatch && addBatch.undoOf;
  if (!root || addBatchRunning(addBatch) || root.left || root.viewId !== activeViewId || root.epoch !== orgEpoch) return;
  const targets = root.items.filter(it => it.state === 'added' && it.membershipId && !it.undoTried);
  if (!targets.length) return;
  const batch = { kind: 'undo', undoOf: root, session: addPicker ? addPicker.session : null, viewId: root.viewId, epoch: root.epoch,
    collectionId: root.collectionId, name: root.name, phase: 'submitting', stop: false,
    items: targets.map(it => ({ key: it.key, kind: it.kind, id: it.id, title: it.title, membershipId: it.membershipId, of: it, state: 'queued' })) };
  await startAddBatch(addPicker, batch, `Undo adding to ${root.name}`);
}

async function startAddBatch(p, batch, label) {
  const before = addBatch, beforeBatch = p ? p.batch : null;
  if (p) p.batch = batch;
  addBatch = batch;
  renderAddPicker(); renderAddNotice();
  const ran = await runWrite(label, () => runAddBatch(batch), { list: true });
  if (ran === undefined && !batch.started) { // refused before anything was sent (another change, or the list out of date)
    addBatch = before;
    if (p && addPicker === p) p.batch = beforeBatch;
    renderAddPicker(); renderAddNotice();
  }
}

// The batch is still where it started: the same view and no restore since (and, while its picker is
// open, the same picker).
function addBatchLive(b) {
  return !b.left && activeViewId === b.viewId && orgEpoch === b.epoch && (!addPicker || b.session == null || addPicker.session === b.session);
}

async function runAddBatch(b) {
  b.started = true;
  const cap = await checkOrgCapability();
  if (cap !== 'yes') {
    b.items.forEach(it => { it.state = 'notsent'; });
    b.error = COLLECTION_CAPABILITY_TEXT[cap] || COLLECTION_CAPABILITY_TEXT.unknown;
    return finishAddBatch(b, null);
  }
  for (const it of b.items) {
    if (b.stop || !addBatchLive(b)) break;
    it.state = b.kind === 'add' ? 'sending' : 'removing';
    if (it.of) it.of.undoTried = true;
    b.current = it;
    renderAddPicker();
    const action = b.kind === 'add' ? 'add' : 'remove';
    const args = membershipArgs(action, { collectionId: b.collectionId, membershipId: it.membershipId, ...membershipTarget(it.kind, it.id) });
    const request = sbRpc(membershipFn(action), args)
      .then(res => ({ res }), err => ({ err }));
    // Stop waiting (after 15 s): the item becomes Not confirmed and the batch stops; the request may
    // still answer, which is recorded but changes nothing.
    let abandon;
    const abandoned = new Promise(r => { abandon = r; });
    b.abandon = () => abandon({ abandoned: true });
    const timer = setTimeout(() => { if (b.current === it) { b.canStopWaiting = true; renderAddPicker(); } }, ADD_STOP_WAIT_MS);
    const answer = await Promise.race([request, abandoned]);
    clearTimeout(timer);
    b.current = null; b.canStopWaiting = false; b.abandon = null;
    if (answer.abandoned) {
      it.state = 'unconfirmed'; it.waited = true;
      b.stop = true;
      request.then(late => { it.late = late.res ? addLateText(b, late.res) : 'no clear answer'; renderAddPicker(); renderAddNotice(); });
      b.pending = request; // the lane stays held until it settles
      break;
    }
    const late = !addBatchLive(b);
    const o = membershipOutcome(action, args, answer.res, answer.err);
    if (o.state === 'absent') {
      orgWriteCapability = null;
      it.state = 'refused'; it.note = COLLECTION_CAPABILITY_TEXT.absent;
      b.stop = true;
    } else if (o.state === 'unconfirmed') {
      it.state = 'unconfirmed';
      b.stop = true;
    } else {
      it.state = o.state;
      if (o.state === 'refused') it.note = o.note;
      // Undo removes exactly what this answer added, by the membership id it returned (membershipUndo).
      if (o.state === 'added' && o.undo) it.membershipId = o.undo.membershipId;
      if (o.state === 'removed') it.of.undone = true;
    }
    if (late) it.after = orgEpoch !== b.epoch ? 'restore' : 'left';
  }
  b.items.forEach(it => { if (it.state === 'queued') it.state = 'notsent'; });
  return finishAddBatch(b, b.pending || null);
}

function addLateText(b, res) {
  if (b.kind === 'add') return res.added ? 'answered later: Added' : 'answered later: already in';
  return res.removed ? 'answered later: Removed' : 'answered later: not removed';
}

// After the last request: the result is shown, then (while the batch is still where it started) the
// collection is read again inside the lane; a batch that left reports in the view now open.
async function finishAddBatch(b, pending) {
  b.phase = b.items.some(it => it.state === 'unconfirmed') ? 'unknown' : b.items.some(it => it.state === 'notsent') ? 'partial' : 'completed';
  if (b.undoOf) b.undoOf.lastUndo = b;
  renderAddPicker(); renderAddNotice();
  if (pending) { await pending; b.pending = null; } // the lane frees with it: Undo applies again
  if (!b.left && activeViewId === b.viewId && orgEpoch === b.epoch) {
    const ok = await reloadOpenView();
    b.reread = ok === true ? 'ok' : ok === false ? 'failed' : null;
    if (ok === true && browseData && browseData.members) {
      b.items.filter(it => it.state === 'unconfirmed').forEach(it => {
        it.nowIn = it.kind === 'show' ? browseData.members.showIds.has(it.id) : browseData.members.filmIds.has(it.id);
      });
    }
    renderAddPicker(); renderAddNotice();
  } else if (b.left || activeViewId !== b.viewId) {
    showNotice(`${b.kind === 'add' ? 'Adding to' : 'Undoing the additions to'} ${b.name} stopped when you left: ${addSummaryCounts(b)}. Open ${b.name} to check.`);
  } else {
    showNotice(`${b.kind === 'add' ? 'Adding to' : 'Undoing the additions to'} ${b.name} stopped: your data was restored meanwhile (${addSummaryCounts(b)}). What is shown now is what is saved.`);
  }
}

// ── Words ──
function addItemText(b, it) {
  const n = b.name;
  let t;
  if (it.state === 'refused') t = b.kind === 'add' ? `Couldn’t add: ${it.note}` : `Not removed: ${it.note}`;
  else if (it.state === 'unconfirmed') {
    const verb = b.kind === 'add' ? 'added' : 'removed';
    t = `Not confirmed: no clear answer came back, so this may or may not have been ${verb}.`;
    if (b.reread === 'ok' && it.nowIn != null) t += ` The list has been read again. It now shows ${it.title} as ${it.nowIn ? 'in' : 'not in'} ${n}, but that doesn’t show whether this request ${b.kind === 'add' ? 'added' : 'removed'} it.`;
    else if (b.reread === 'failed') t += ' The list couldn’t be read again, so it may be out of date; use Retry.';
    t += ' Nothing was sent again.';
  } else {
    const s = ADD_STATE_TEXT[it.state];
    t = typeof s === 'function' ? s(n) : s || it.state;
  }
  if (it.after === 'left') t += ' (answered after you left)';
  else if (it.after === 'restore') t += ' (answered after a restore: not applied here)';
  if (it.late) t += ` (${it.late})`;
  return t;
}

function addSummaryCounts(b) {
  const count = s => b.items.filter(it => it.state === s).length;
  const parts = b.kind === 'add'
    ? [[count('added'), 'added'], [count('already'), 'already in'], [count('refused'), 'couldn’t be added'], [count('unconfirmed'), 'not confirmed'], [count('notsent'), 'not sent']]
    : [[count('removed'), 'removed'], [count('notremoved') + count('refused'), 'not removed'], [count('unconfirmed'), 'not confirmed'], [count('notsent'), 'not sent']];
  return parts.filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).join(', ') || 'nothing sent';
}

function addSummaryText(b) {
  return `${b.kind === 'add' ? `Add to ${b.name}` : `Undo adding to ${b.name}`}: ${addSummaryCounts(b)}.${b.error ? ` ${b.error}` : ''}`;
}

// The Undo button while it applies: the batch that added is this visit's, no batch is running, and
// some item it added hasn't had its Undo sent.
function addUndoHtml(b) {
  const root = b && (b.kind === 'add' ? b : b.undoOf);
  if (!root || addBatchRunning(b) || b.pending || root.left || b.left || root.viewId !== activeViewId || root.epoch !== orgEpoch) return '';
  const n = root.items.filter(it => it.state === 'added' && it.membershipId && !it.undoTried).length;
  return n ? ` <button class="btn" id="addUndoBtn" onclick="undoAddBatch()">Undo ${n} confirmed addition${n === 1 ? '' : 's'}</button>` : '';
}

function addResultsListHtml(b) {
  return `<ul class="manage-list add-results" aria-label="Results">${b.items.map(it =>
    `<li class="manage-item"><span class="manage-name">${esc(it.title)}</span> <span class="manage-meta">${esc(addItemText(b, it))}</span></li>`).join('')}</ul>`;
}

// ── Drawing ──
function renderAddPicker() {
  const box = document.getElementById('addPickerBox');
  const p = addPicker;
  if (!box || !p) return;
  const active = document.activeElement;
  const inside = !!active && typeof box.contains === 'function' && box.contains(active);
  const focusId = inside && active.id ? active.id : null;
  const caret = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  box.innerHTML = addPickerHtml(p);
  const again = focusId && document.getElementById(focusId);
  if (again && typeof again.focus === 'function') {
    again.focus();
    if (caret && typeof again.setSelectionRange === 'function') try { again.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ }
  } else if (inside && typeof box.focus === 'function') box.focus();
}

function addPickerHtml(p) {
  const b = p.batch;
  const title = `<h2 class="modal-title" id="addPickerTitle">Add to ${esc(p.name)}</h2>`;
  if (!b) {
    const { list, unclassified } = addCandidates();
    const q = p.query.trim().toLowerCase();
    const shown = q ? list.filter(c => String(c.title || '').toLowerCase().includes(q)) : list;
    const n = p.selected.size;
    const row = c => {
      const kind = c.kind === 'show' ? `TV show · ${c.seasons} stored season${c.seasons === 1 ? '' : 's'}` : 'Film';
      const meta = `${kind} · ${c.status}${c.skipped ? ' (hidden by default here)' : ''}`;
      const cbId = `addPick-${c.key.replace(/[^\w-]/g, '_')}`;
      return c.member
        ? `<li class="manage-item add-pick"><span class="manage-name">${esc(c.title)}</span> <span class="manage-meta">${esc(meta)}</span> <span class="manage-in">Already in ${esc(p.name)}</span></li>`
        : `<li class="manage-item add-pick"><label class="add-pick-label" for="${cbId}"><input type="checkbox" id="${cbId}"${p.selected.has(c.key) ? ' checked' : ''} onchange="addPickerToggle('${c.key}', this.checked)">
            <span class="manage-name">${esc(c.title)}</span> <span class="manage-meta">${esc(meta)}</span></label></li>`;
    };
    return `${title}<div class="manage-body" id="addPickerBody">
        <label for="addPickerSearch">Search your saved shows and films</label>
        <input id="addPickerSearch" type="search" value="${esc(p.query)}" oninput="addPickerSearch(this)" placeholder="Search titles…">
        <p class="manage-hint">A show is added whole: every stored season, and any added later. Nothing is copied or moved, and watched status is unchanged.</p>
        <ul class="manage-list" aria-label="Shows and films">${shown.map(row).join('') || '<li class="manage-empty">Nothing saved matches.</li>'}</ul>
        ${unclassified ? `<p class="manage-hint">${unclassified} saved row${unclassified === 1 ? ' is' : 's are'} neither a TV season nor a film, so ${unclassified === 1 ? 'it isn’t' : 'they aren’t'} offered.</p>` : ''}
      </div>
      <div class="modal-actions"><button class="btn" id="addPickerCancel" onclick="closeAddPicker()">Cancel</button>
        <button class="btn btn-accent" id="addPickerSubmit" onclick="submitAddPicker()"${n ? '' : ' disabled'}>Add ${n} to ${esc(p.name)}</button></div>`;
  }
  const running = addBatchRunning(b);
  const done = b.items.filter(it => !['queued', 'sending', 'removing'].includes(it.state)).length;
  const at = b.items.indexOf(b.current) + 1;
  const progress = running
    ? `<p class="manage-status" role="status">${b.kind === 'add' ? 'Adding' : 'Undoing'} ${at || done} of ${b.items.length}… The selection is locked.${b.stop ? ' Stopping after this one: nothing further will be sent.' : ''}</p>`
    : `<p class="manage-status" role="status">${esc(addSummaryText(b))}</p>`;
  const actions = running
    ? `<button class="btn" id="addPickerStop" onclick="closeAddPicker()"${b.stop ? ' disabled' : ''}>${b.stop ? 'Stopping…' : 'Stop after this one'}</button>`
      + (b.canStopWaiting ? ` <button class="btn" id="addPickerStopWaiting" onclick="addStopWaiting()">Stop waiting</button>` : '')
    : `${addUndoHtml(b)} <button class="btn" id="addPickerClose" onclick="closeAddPicker()">Close</button>`;
  const root = b.undoOf;
  const earlier = root ? `<h3 class="manage-subtitle">Added earlier</h3>${addResultsListHtml(root)}` : '';
  return `${title}${progress}<div class="manage-body" id="addPickerBody">${addResultsListHtml(b)}${earlier}</div><div class="modal-actions">${actions}</div>`;
}

function addStopWaiting() {
  const b = addPicker && addPicker.batch;
  if (b && b.abandon) b.abandon();
}

// The collection's notice for this visit's batch (once the picker is closed): the summary, Show
// details, and Undo while it applies.
function renderAddNotice() {
  const b = addBatch;
  if (!b || addPicker || b.left || b.viewId !== activeViewId) return;
  renderCollectionBanner();
}

function addNoticeHtml() {
  const b = addBatch;
  if (!b || addPicker || b.left || b.viewId !== activeViewId) return '';
  const details = b.details ? addResultsListHtml(b) + (b.undoOf ? addResultsListHtml(b.undoOf) : '') : '';
  return `<div class="banner collection-notice" id="addNotice" role="status" tabindex="-1">${esc(addSummaryText(b))}
      ${addBatchRunning(b) ? '' : ` <button class="btn" id="addDetailsBtn" aria-expanded="${!!b.details}" onclick="toggleAddDetails()">${b.details ? 'Hide details' : 'Show details'}</button>${addUndoHtml(b)}`}${details}</div>`;
}

function toggleAddDetails() {
  if (!addBatch) return;
  addBatch.details = !addBatch.details;
  renderAddNotice();
}
