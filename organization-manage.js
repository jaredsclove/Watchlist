// ─── Manage collections (Stage 3b-2) ─────────────────────────────────────────
// One dialog, opened from the Browse collections bar (Manage), a collection's
// heading (Edit members) or the Movies watch-with filter (Manage choices…). It
// changes only your organization: create, rename, archive and unarchive
// collections and watch-with choices, and add or remove a whole show or a film in
// a collection. Tracking (watched, status, dates) is never changed here, and the
// Browse views stay read-only. Every change goes through one database function
// (db/phase3b2_org_write.sql), which is one transaction and guarded by the values
// this page showed, so a change based on an older view never overwrites a newer one.
//
// Opening: first a read-only capability check (GET rpc/org_capabilities; never a
// change), then a complete read of everything the editor shows (collections,
// memberships, choices, shows and every saved row). Nothing is edited on partial
// data, and the reads are not one snapshot: a membership whose show, film or
// collection this read didn't include is reported (Read again), never shown as
// absent and never repaired.
//
// Replies and reads: a reply updates at most the dialog's copy of that one record,
// and only if (1) the restore epoch and dialog session are unchanged, (2) no newer
// action on that record was started, (3) the request wasn't given up on (Stop
// waiting / no answer), and (4) no complete read started after it was sent has
// already replaced that record. It is never published as a snapshot. After every
// confirmed change the page sets the write barrier and then re-reads
// (organization.js publishes only reads newer than the barrier); if that read
// fails it says "Saved. Couldn't refresh" and marks the data possibly out of date.
//
// No answer: the page never sends a change again by itself. It re-reads and says
// what is saved now, keeping "wasn't confirmed" (a matching state doesn't prove
// the request finished; only a reply to it does). Stop waiting ends the wait, not
// the request.

const ORG_STOP_WAITING_MS = 15000;
const ORG_LATE_NOTE = 'Your earlier attempt might still arrive. Depending on what changes before then, it may have no effect, or it may still make its change.';
const ORG_INCONSISTENT_TAIL = 'Something may have changed while reading. This does not mean anything was deleted; this read changed nothing.';

// ── Errors ──
// sbFetch throws "Supabase error <status>: <body>" for an HTTP error; a TypeError
// from fetch means no answer came back. Only a recognized database or API answer
// (a JSON body with an error code: a SQLSTATE such as P0001, 23514, 57014, or a
// PostgREST code such as PGRST202) is definitive. Any other HTTP error (a gateway
// or proxy page, JSON without a code) doesn't show whether the write committed:
// it is treated like no answer ('ambiguous').
function orgErrorInfo(e) {
  const msg = String(e && e.message || e || '');
  const m = msg.match(/^Supabase error (\d+): ([\s\S]*)$/);
  if (!m) return { kind: 'network', message: msg };
  let body = null;
  try { body = JSON.parse(m[2]); } catch (x) { body = null; }
  const recognized = body && typeof body === 'object' && typeof body.code === 'string' && /^([0-9A-Z]{5}|PGRST\d+)$/.test(body.code);
  if (!recognized) return { kind: 'ambiguous', status: Number(m[1]), message: String((body && body.message) || m[2]) };
  const text = String(body.message || m[2]);
  let detail = null;
  try { detail = body.details ? JSON.parse(body.details) : null; } catch (x) { detail = null; }
  const prefix = (text.match(/^([a-z_]+):/) || [])[1] || '';
  return { kind: 'database', status: Number(m[1]), pgCode: body.code, code: prefix, message: text, detail };
}

// A function this database doesn't have (or the API hasn't loaded yet).
const orgMissingFunction = info => info.kind === 'database' && info.status === 404 && info.pgCode === 'PGRST202';

// The sentence after "code: " in a refusal, which the database wrote for people.
function orgRefusalText(info) {
  return info.code ? info.message.slice(info.code.length + 1).trim().replace(/^./, c => c.toUpperCase()) : info.message;
}

// ── Capability (read-only) ──
async function checkOrgCapability() {
  if (orgWriteCapability && orgWriteCapability.epoch === orgEpoch && orgWriteCapability.value === 'yes') return 'yes';
  try {
    const r = await sbFetch('GET', 'rpc/org_capabilities', null);
    const value = r && r.org_write === 1 ? 'yes' : 'unknown';
    if (value === 'yes') orgWriteCapability = { value, epoch: orgEpoch };
    return value;
  } catch (e) {
    const info = orgErrorInfo(e);
    if (orgMissingFunction(info)) return 'absent';
    if (info.kind === 'database' && (info.status === 401 || info.status === 403 || info.pgCode === '42501')) return 'denied';
    return 'unknown';
  }
}

// ── Opening and closing ──
// opener: the control that opened the dialog (passed by its handler; a mouse click
// doesn't always focus a button), else whatever had focus.
function openManage(view, collectionId, openerEl) {
  if (manage) return;
  if (orgState === 'absent') return;
  const opener = openerEl || document.activeElement || null;
  // The control that opened the dialog may be redrawn meanwhile: remember how to find it again.
  const openerSelector = opener && typeof opener.matches === 'function'
    ? ['.browse-manage', '.browse-edit-members', '.ww-filter .btn-link'].find(sel => opener.matches(sel)) || null : null;
  manage = {
    session: ++manageSession, epoch: orgEpoch, opener, openerSelector, view: view === 'choices' ? 'choices' : view === 'members' ? 'members' : 'collections',
    collectionId: collectionId || null, phase: 'checking', error: '', data: null, readSeq: 0, refreshing: false, refreshFor: null,
    pending: {}, latestOp: {}, notes: {}, unconfirmed: {}, saved: {}, drafts: {}, undo: [], status: null, confirm: null,
    renaming: null, showArchived: false, wrote: false, reconcile: []
  };
  document.getElementById('manageModalOverlay').style.display = 'flex';
  renderManage();
  const box = document.getElementById('manageModalBox');
  if (box && typeof box.focus === 'function') box.focus();
  const session = manage.session;
  checkOrgCapability().then(value => {
    if (!manage || manage.session !== session) return;
    if (value !== 'yes') { manage.phase = value; renderManage(); return; }
    manage.phase = 'loading';
    renderManage();
    startOrgRefresh({ barrier: false, reason: 'open' });
  });
}

function manageHasPending() {
  return !!manage && Object.values(manage.pending).some(op => op && op.state === 'pending');
}

function closeManage() {
  if (!manage || manageHasPending()) return;
  const { opener, openerSelector, wrote } = manage;
  manage = null;
  document.getElementById('manageModalOverlay').style.display = 'none';
  document.getElementById('manageModalBox').innerHTML = '';
  buildBrowseBar();
  if (wrote && isBrowseCollectionView(activeViewId)) loadBrowseView();
  // Focus goes back to the control that opened the dialog (or its redrawn equivalent).
  const back = opener && opener.isConnected ? opener : (openerSelector && document.querySelector(openerSelector)) || null;
  if (back && typeof back.focus === 'function') back.focus();
}

// A restore made in this page (organization.js): everything the dialog holds is stale.
function manageInvalidate() {
  orgWriteCapability = null;
  if (!manage) return;
  manage.epoch = -1;
  manage.phase = 'restored';
  manage.undo = [];
  manage.unconfirmed = {};
  manage.notes = {};
  renderManage();
}

// Escape closes (unless a change is being saved); Tab stays inside the dialog.
function manageKeydown(event) {
  if (!manage) return;
  if (event.key === 'Escape') { event.preventDefault(); closeManage(); return; }
  if (event.key !== 'Tab') return;
  const box = document.getElementById('manageModalBox');
  const items = [...box.querySelectorAll('button, input, select, [tabindex="0"]')].filter(el => !el.disabled && el.offsetParent !== null);
  if (!items.length) { event.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === box)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

// ── Reads ──
// barrier: a confirmed change (or an unconfirmed one being reconciled) came first.
// The barrier is set BEFORE the read starts, so this read is newer than it and can
// publish; any organization read started earlier can't.
function startOrgRefresh({ barrier = true, reason = 'write', reconcile = null } = {}) {
  if (barrier) orgWriteBarrier = orgReadSeq;
  const read = orgReadStart();
  const open = !!manage && manage.epoch === orgEpoch;
  const session = open ? manage.session : null;
  if (open) {
    manage.readSeq = read.seq;
    manage.refreshing = true;
    manage.refreshFor = reason;
    if (reconcile) manage.reconcile.push(reconcile);
  }
  // Collections and choices publish (or are marked possibly out of date) on their
  // own, as each read finishes, under the usual sequence, barrier and epoch rules;
  // a failure of one never discards the other. The editor still needs every read.
  const collectionsRead = fetchAllRowsStrict('personal_collections').then(rows => {
    if (publishCollections(rows, read)) buildBrowseBar();
    return rows;
  }, e => { markOrgStale('collections', read); throw e; });
  const choicesRead = fetchAllRowsStrict('watch_with_choices').then(rows => {
    publishChoices(rows, read);
    return rows;
  }, e => { markOrgStale('choices', read); throw e; });
  const reads = open
    ? [collectionsRead, fetchAllRowsStrict('collection_memberships'), choicesRead, fetchAllRowsStrict('tv_shows'), fetchAllRowsStrict(TABLE)]
    : [collectionsRead, Promise.resolve(null), choicesRead];
  return Promise.allSettled(reads).then(results => {
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map(r => r.value);
  }).then(([collections, memberships, choices, shows, rows]) => {
    if (!manage || manage.session !== session || manage.epoch !== orgEpoch || read.seq !== manage.readSeq) return;
    manage.data = { collections, memberships, choices, shows, rows, readSeq: read.seq, readAt: new Date() };
    manage.refreshing = false;
    manage.saved = {};
    manage.phase = 'ready';
    if (manage.status && manage.status.kind === 'refresh-failed') manage.status = null;
    const pendingReconcile = manage.reconcile;
    manage.reconcile = [];
    pendingReconcile.forEach(op => observeAfterReconcile(op));
    renderManage();
  }, e => {
    console.error(e);
    if (!manage || manage.session !== session || manage.epoch !== orgEpoch || read.seq !== manage.readSeq) return;
    manage.refreshing = false;
    const msg = String(e && e.message || e);
    if (reason === 'open' || (reason === 'read' && !manage.data)) { manage.phase = 'failed'; manage.error = msg; }
    else if (manage.reconcile.length) {
      // The outcome of an unconfirmed change can't be checked: no editor on unverified data.
      manage.phase = 'unverified';
      manage.error = msg;
    } else if (reason === 'write') manage.status = { kind: 'refresh-failed', text: `Saved. Couldn’t refresh your collections (${msg}).` };
    else manage.status = { kind: 'refresh-failed', text: `Couldn’t read your collections again (${msg}).` };
    renderManage();
  });
}

function manageReadAgain() {
  if (!manage) return;
  if (manage.phase === 'failed') { manage.phase = 'loading'; renderManage(); }
  startOrgRefresh({ barrier: !!manage.reconcile.length || manage.phase === 'unverified', reason: manage.data ? 'read' : 'open' });
}

// Retry from the Browse bar or a watch-with control after a failed refresh.
function retryOrgRefresh() {
  if (manage) { manageReadAgain(); return; }
  startOrgRefresh({ barrier: false, reason: 'retry' });
}

// ── Derived data for the editor ──
const orgKeyColl = id => `c:${id}`;
const orgKeyChoice = id => `w:${id}`;
const orgKeyMember = (collectionId, showId, itemId) => `m:${collectionId}|${showId != null ? `s:${showId}` : `i:${itemId}`}`;

function manageIndex() {
  const d = manage.data;
  const shows = new Map(d.shows.map(s => [s.id, s]));
  const rows = new Map(d.rows.map(r => [r.id, r]));
  const colls = new Map(d.collections.map(c => [c.id, c]));
  const seasons = new Map();
  d.rows.forEach(r => { if (r.show_id != null) seasons.set(r.show_id, (seasons.get(r.show_id) || 0) + 1); });
  const members = new Map(); // collection id -> [{ m, kind, target }]
  const missingTargets = new Map(); // collection id -> count
  let missingCollections = 0;
  d.memberships.forEach(m => {
    if (!colls.has(m.collection_id)) { missingCollections++; return; }
    const target = m.show_id != null ? shows.get(m.show_id) : rows.get(m.item_id);
    if (!target) { missingTargets.set(m.collection_id, (missingTargets.get(m.collection_id) || 0) + 1); return; }
    if (!members.has(m.collection_id)) members.set(m.collection_id, []);
    members.get(m.collection_id).push({ m, kind: m.show_id != null ? 'show' : 'film', target });
  });
  const usage = new Map();
  d.rows.forEach(r => (r.watch_with || []).forEach(t => usage.set(t, (usage.get(t) || 0) + 1)));
  return { shows, rows, colls, seasons, members, missingTargets, missingCollections, usage };
}

function membershipByPair(collectionId, showId, itemId) {
  return manage.data.memberships.find(m => m.collection_id === collectionId
    && (showId != null ? m.show_id === showId : m.item_id === itemId)) || null;
}

const plainStatus = s => (s ? statusOptionLabel(s).replace(/^\S+ /, '') : '');
const storageLabel = c => (COLLECTIONS.find(x => x.id === c) || {}).label || c;

// ── Writes ──
function runOrgOp(op) {
  op.id = ++orgOpSeq;
  op.session = manage.session;
  op.epoch = orgEpoch;
  op.sentReadSeq = orgReadSeq;
  op.state = 'pending';
  manage.latestOp[op.key] = op.id;
  manage.pending[op.key] = op;
  manage.status = null;
  renderManage();
  op.timer = setTimeout(() => {
    if (op.state === 'pending' && manage && manage.session === op.session) { op.slow = true; renderManage(); }
  }, ORG_STOP_WAITING_MS);
  return sbRpc(op.fn, op.args).then(res => finishOrgOp(op, res, null), e => finishOrgOp(op, null, e));
}

// Stop waiting: the outcome is unknown from here; the request itself isn't cancelled.
function manageStopWaiting(opId) {
  if (!manage) return;
  const op = Object.values(manage.pending).find(o => o && o.id === Number(opId));
  if (!op || op.state !== 'pending') return;
  becomeUnknown(op);
}

function becomeUnknown(op) {
  op.state = 'unknown';
  if (manage && manage.session === op.session) {
    if (manage.pending[op.key] === op) delete manage.pending[op.key];
    manage.undo = manage.undo.filter(u => u.key !== op.key);
    manage.unconfirmed[op.id] = { op, text: 'Your change wasn’t confirmed. Checking what is saved now…' };
    renderManage();
  }
  startOrgRefresh({ barrier: true, reason: 'reconcile', reconcile: op });
}

function finishOrgOp(op, res, err) {
  if (typeof clearTimeout === 'function') clearTimeout(op.timer);
  const info = err ? orgErrorInfo(err) : null;
  const wasUnknown = op.state === 'unknown';
  // No answer, or an answer that doesn't show whether it committed: unknown.
  if (info && info.kind !== 'database') {
    if (!wasUnknown) becomeUnknown(op);
    return;
  }
  op.state = 'done';
  const here = !!manage && manage.session === op.session && op.epoch === orgEpoch && manage.epoch === orgEpoch;
  if (here && manage.pending[op.key] === op) delete manage.pending[op.key];
  if (info && orgMissingFunction(info)) {
    orgWriteCapability = null;
    if (here) { manage.phase = 'absent'; manage.status = { kind: 'note', text: 'Editing collections isn’t available on this database, so your change wasn’t applied.' }; renderManage(); }
    return;
  }
  const outcome = describeOutcome(op, res, info);
  op.ok = !!outcome.ok;
  if (manage && manage.session === op.session) (manage.lastOutcome = manage.lastOutcome || {})[op.key] = op.ok && !wasUnknown;
  if (here) {
    if (wasUnknown) {
      // A late, definitive reply resolves that request's uncertainty; its record is
      // not applied (a reconciliation read may already show newer data).
      // Only this request's uncertainty is resolved; other requests on the record keep theirs.
      manage.unconfirmed[op.id] = { op, text: res ? 'Your earlier change was saved.' : `Your earlier change was refused: ${outcome.text}`, resolved: true };
    } else {
      const canApply = res && manage.latestOp[op.key] === op.id && manage.data && manage.data.readSeq <= op.sentReadSeq;
      if (canApply) applyOrgReply(op, res);
      if (res) manage.saved[op.key] = true;
      const isCreate = op.kind === 'createCollection' || op.kind === 'createChoice';
      // Creates have no listed record yet, and an archive or unarchive can move the
      // record into the collapsed Archived group: their outcome is shown at the top.
      if (isCreate) { delete manage.notes[op.key]; manage.status = { kind: 'note', text: outcome.text, unarchive: outcome.unarchive || null }; }
      else if (op.kind === 'archive') { manage.status = { kind: 'note', text: outcome.text }; if (outcome.note) manage.notes[op.key] = outcome.note; else delete manage.notes[op.key]; }
      else if (outcome.note) manage.notes[op.key] = outcome.note; else delete manage.notes[op.key];
      if (res && !op.undoOf) addUndo(op, res);
    }
    if (res) manage.wrote = true;
  }
  if (here && !res && !info.code) manage.status = { kind: 'note', text: outcome.text };
  if (res || (info && info.code)) startOrgRefresh({ barrier: !!res, reason: res ? 'write' : 'read' });
  if (here) renderManage();
}

// What a definitive answer means, in words (no plan references).
function describeOutcome(op, res, info) {
  if (res) {
    if (op.kind === 'createCollection' || op.kind === 'createChoice') {
      const rec = res.collection || res.choice;
      const name = rec.name ?? rec.label;
      const asked = String(op.args.p_name ?? op.args.p_label).trim();
      if (!res.existing) return { text: 'Created.', ok: true };
      if (name !== asked) return { text: `Already created; it’s now called “${name}”${rec.archived_at ? ' and is archived' : ''}.`, ok: true };
      return { text: rec.archived_at ? 'Already created; it’s archived.' : 'Already created.', ok: true };
    }
    if (op.kind === 'add') return res.added ? { text: 'Added.', ok: true } : { text: 'Already in this collection.', note: 'Already in this collection.', ok: true };
    if (op.kind === 'remove') {
      if (res.removed) return { text: 'Removed.', ok: true };
      if (res.reason === 'target_missing') return { text: 'Not removed.', note: 'This is no longer saved, so it’s in no collection.' };
      if (res.reason === 'not_film') return { text: 'Not removed.', note: `This was matched as a season of “${res.show_title || 'a show'}”; that show’s membership wasn’t touched.` };
      return { text: 'Not removed.', note: 'That membership was already removed or changed elsewhere.' };
    }
    return { text: 'Saved.', ok: true };
  }
  const d = info.detail || {};
  const choice = op.target === 'w' || op.kind === 'createChoice';
  const noun = choice ? 'watch-with choice' : 'collection';
  let text;
  switch (info.code) {
    case 'org_name_taken': case 'org_label_taken': {
      const name = d.name ?? d.label ?? '';
      text = d.archived ? `An archived ${noun} is called “${name}”.` : `You already have a ${noun} called “${name}”.`;
      return { text, note: text, unarchive: d.archived && d.conflict_id ? { target: choice ? 'w' : 'c', id: d.conflict_id } : null };
    }
    case 'org_conflict': {
      const cur = d.current || {};
      if (op.kind === 'rename') text = `Renamed elsewhere to “${cur.name ?? cur.label}”; nothing changed.`;
      else text = `Already ${cur.archived_at ? 'archived' : 'active'} elsewhere; nothing changed.`;
      return { text, note: text };
    }
    case 'org_archived': text = 'This collection is archived; unarchive it to change its members.'; break;
    case 'org_target_missing': text = 'This is no longer saved.'; break;
    case 'org_not_film': text = `This row is now a TV season of “${d.show_title || 'a show'}”.`; break;
    case 'org_not_found': text = `This ${noun} is no longer available.`; break;
    case 'org_invalid_name': case 'org_invalid_label': case 'invalid_input': case 'org_id_taken': text = `${orgRefusalText(info)}`; break;
    default:
      text = /57014|55P03|40001|40P01|statement timeout|lock timeout|deadlock/.test(`${info.pgCode} ${info.message}`)
        ? 'The database didn’t finish this (another change was using the same records, or it took too long), so nothing was changed. Try again.'
        : `Not saved: ${info.message}`;
  }
  return { text, note: text };
}

// Apply a reply to the dialog's copy of exactly that record (guards checked by the caller).
function applyOrgReply(op, res) {
  const d = manage.data;
  const put = (list, rec) => { const i = list.findIndex(x => x.id === rec.id); if (i >= 0) list[i] = { ...list[i], ...rec }; else list.push(rec); };
  if (res.collection) put(d.collections, res.collection);
  if (res.choice) put(d.choices, res.choice);
  if (op.kind === 'add' && res.membership) put(d.memberships, res.membership);
  if (op.kind === 'remove' && res.removed) d.memberships = d.memberships.filter(m => m.id !== op.args.p_membership_id);
}

// Undo only for a change this request actually made.
function addUndo(op, res) {
  if (op.kind === 'add' && res.added === true && res.membership) {
    manage.undo.unshift({ key: op.key, label: op.label, action: 'remove', collectionId: op.args.p_collection_id,
      showId: op.args.p_show_id, itemId: op.args.p_item_id, membershipId: res.membership.id });
  } else if (op.kind === 'remove' && res.removed === true) {
    manage.undo.unshift({ key: op.key, label: op.label, action: 'add', collectionId: op.args.p_collection_id,
      showId: op.args.p_show_id, itemId: op.args.p_item_id });
  }
  manage.undo = manage.undo.slice(0, 5);
}

function manageUndo(index) {
  if (!manage || !manage.data) return;
  const u = manage.undo[Number(index)];
  if (!u || manage.pending[u.key]) return;
  manage.undo.splice(Number(index), 1);
  if (u.action === 'remove') {
    runOrgOp({ kind: 'remove', key: u.key, label: u.label, undoOf: true, fn: 'org_remove_membership',
      args: { p_membership_id: u.membershipId, p_collection_id: u.collectionId, p_show_id: u.showId ?? null, p_item_id: u.itemId ?? null } });
  } else {
    runOrgOp({ kind: 'add', key: u.key, label: u.label, undoOf: true, fn: 'org_add_membership',
      args: { p_collection_id: u.collectionId, p_show_id: u.showId ?? null, p_item_id: u.itemId ?? null } });
  }
}

// After a reconciliation read: what is saved now, for an unconfirmed request. The
// request stays unconfirmed whatever the read shows.
function observeAfterReconcile(op) {
  const u = manage.unconfirmed[op.id];
  if (!u || u.resolved) return;
  const d = manage.data;
  let text;
  if (op.kind === 'createCollection' || op.kind === 'createChoice') {
    const rec = (op.kind === 'createCollection' ? d.collections : d.choices).find(x => x.id === op.args.p_id);
    if (rec) text = 'Created. Your request wasn’t confirmed, so it may have been created by an earlier attempt.';
    else {
      text = 'Not created as of this check. Your earlier request could still create it.';
      manage.unconfirmedCreate = { kind: op.kind, id: op.args.p_id, name: String(op.args.p_name ?? op.args.p_label).trim() };
    }
  } else if (op.kind === 'rename') {
    const rec = (op.target === 'c' ? d.collections : d.choices).find(x => x.id === op.args.p_id);
    const now = rec ? (rec.name ?? rec.label) : null;
    const wanted = String(op.args.p_name ?? op.args.p_label).trim();
    const old = op.args.p_expected_name ?? op.args.p_expected_label;
    if (now === wanted) text = 'Your rename wasn’t confirmed.';
    else if (now === old) text = 'Not renamed as of this check. Your earlier request could still rename it.';
    else text = `Renamed elsewhere to “${now}”.`;
  } else if (op.kind === 'archive') {
    const rec = (op.target === 'c' ? d.collections : d.choices).find(x => x.id === op.args.p_id);
    const want = op.args.p_archived;
    const word = want ? 'archive' : 'unarchive', done = want ? 'archived' : 'active';
    if (rec && !!rec.archived_at === want) text = `It is now ${done}. Your earlier ${word} request wasn’t confirmed, so it may not have been what made it ${done}.`;
    else text = `${want ? 'Active' : 'Archived'}. Your earlier ${word} request wasn’t confirmed and could still take effect.`;
  } else if (op.kind === 'add') {
    const m = membershipByPair(op.args.p_collection_id, op.args.p_show_id, op.args.p_item_id);
    text = m ? 'Your add wasn’t confirmed.' : 'Not added as of this check. Your earlier request could still add it.';
  } else if (op.kind === 'remove') {
    // Tracked by the original membership id; shown by the (collection, target) pair.
    const original = d.memberships.find(m => m.id === op.args.p_membership_id);
    const pair = membershipByPair(op.args.p_collection_id, op.args.p_show_id, op.args.p_item_id);
    if (original) text = 'Not removed as of this check. Your earlier request could still remove it.';
    else if (pair) text = `Your removal wasn’t confirmed. ${op.label || 'This'} is in this collection, added again elsewhere.`;
    else text = 'Your removal wasn’t confirmed; it may have been removed elsewhere.';
  }
  manage.unconfirmed[op.id] = { op, text };
}

// Every unconfirmed request on one record (by operation, oldest first), and the
// records that have any.
function unconfirmedFor(key) {
  return Object.values(manage.unconfirmed).filter(u => u.op.key === key).sort((a, b) => a.op.id - b.op.id);
}
const unconfirmedKeys = () => [...new Set(Object.values(manage.unconfirmed).map(u => u.op.key))];

// ── User actions ──
function manageDraft(el) {
  if (manage && el && el.id) manage.drafts[el.id] = el.value;
  if (manage && el && el.id === 'manageMemberSearch') renderManage();
}

function manageShow(view) {
  if (!manage) return;
  manage.view = view === 'choices' ? 'choices' : 'collections';
  manage.collectionId = null;
  manage.confirm = null;
  manage.renaming = null;
  renderManage();
}

function manageEditMembers(collectionId) {
  if (!manage) return;
  manage.view = 'members';
  manage.collectionId = collectionId;
  manage.confirm = null;
  renderManage();
}

function manageToggleArchived() {
  if (!manage) return;
  manage.showArchived = !manage.showArchived;
  renderManage();
}

function newOrgId() {
  if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const h = n => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${h(8)}-${h(4)}-4${h(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${h(3)}-${h(12)}`;
}

function manageCreate(kind) {
  if (!manage || manage.phase !== 'ready') return;
  const inputId = kind === 'choice' ? 'manageNewChoice' : 'manageNewCollection';
  const name = String(manage.drafts[inputId] || '').trim();
  const what = kind === 'choice' ? 'label' : 'name';
  if (!name) { manage.status = { kind: 'note', text: `Type a ${what} first.` }; renderManage(); return; }
  if (name.length > 100) { manage.status = { kind: 'note', text: `That ${what} is longer than 100 characters.` }; renderManage(); return; }
  const opKind = kind === 'choice' ? 'createChoice' : 'createCollection';
  // A fresh click after an unconfirmed create with the same name reuses its id, so
  // the two requests can only ever make one record.
  const prior = manage.unconfirmedCreate;
  const id = prior && prior.kind === opKind && prior.name === name ? prior.id : newOrgId();
  const key = kind === 'choice' ? orgKeyChoice(id) : orgKeyColl(id);
  if (manage.pending[key]) return;
  runOrgOp({ kind: opKind, key, label: name, fn: kind === 'choice' ? 'org_create_choice' : 'org_create_collection',
    args: kind === 'choice' ? { p_id: id, p_label: name } : { p_id: id, p_name: name } }).then(() => {
    if (!manage) return;
    // The form keeps the text unless the create is confirmed.
    if (!unconfirmedFor(key).some(u => !u.resolved) && manage.latestOp[key] && Object.values(manage.pending).every(o => o.key !== key)) {
      const done = manage.lastOutcome && manage.lastOutcome[key];
      if (done) manage.drafts[inputId] = '';
    }
    if (prior && prior.id === id && !unconfirmedFor(key).some(u => !u.resolved)) manage.unconfirmedCreate = null;
    renderManage();
  });
}

function manageStartRename(target, id) {
  if (!manage || !manage.data) return;
  const rec = target === 'w' ? manage.data.choices.find(x => x.id === id) : manage.data.collections.find(x => x.id === id);
  if (!rec) return;
  manage.renaming = { target, id, expected: rec.name ?? rec.label };
  manage.drafts[`manageRename-${id}`] = rec.name ?? rec.label;
  renderManage();
  const el = document.getElementById(`manageRename-${id}`);
  if (el && typeof el.focus === 'function') el.focus();
}

function manageCancelRename() {
  if (!manage) return;
  manage.renaming = null;
  renderManage();
}

function manageSaveRename(target, id) {
  if (!manage || !manage.renaming || manage.renaming.id !== id) return;
  const value = String(manage.drafts[`manageRename-${id}`] || '').trim();
  const key = target === 'w' ? orgKeyChoice(id) : orgKeyColl(id);
  if (!value) { manage.status = { kind: 'note', text: 'Type a name first.' }; renderManage(); return; }
  if (value.length > 100) { manage.status = { kind: 'note', text: 'That name is longer than 100 characters.' }; renderManage(); return; }
  if (manage.pending[key]) return;
  const expected = manage.renaming.expected;
  manage.renaming = null;
  runOrgOp(target === 'w'
    ? { kind: 'rename', target, key, label: value, fn: 'org_rename_choice', args: { p_id: id, p_expected_label: expected, p_label: value } }
    : { kind: 'rename', target, key, label: value, fn: 'org_rename_collection', args: { p_id: id, p_expected_name: expected, p_name: value } });
}

function manageAskArchive(target, id) {
  if (!manage) return;
  manage.confirm = { target, id };
  renderManage();
}

function manageSetArchived(target, id, archived) {
  if (!manage || !manage.data) return;
  const key = target === 'w' ? orgKeyChoice(id) : orgKeyColl(id);
  if (manage.pending[key]) return;
  manage.confirm = null;
  runOrgOp({ kind: 'archive', target, key, fn: target === 'w' ? 'org_set_choice_archived' : 'org_set_collection_archived',
    args: { p_id: id, p_archived: !!archived } });
}

function manageAddMember(kind, targetId) {
  if (!manage || !manage.data || !manage.collectionId) return;
  const c = manage.collectionId;
  const showId = kind === 's' ? targetId : null, itemId = kind === 'i' ? targetId : null;
  const key = orgKeyMember(c, showId, itemId);
  if (manage.pending[key]) return;
  const ix = manageIndex();
  const target = showId ? ix.shows.get(showId) : ix.rows.get(itemId);
  runOrgOp({ kind: 'add', key, label: target ? `“${target.title}”` : '', fn: 'org_add_membership',
    args: { p_collection_id: c, p_show_id: showId, p_item_id: itemId } });
}

function manageRemoveMember(membershipId) {
  if (!manage || !manage.data) return;
  const m = manage.data.memberships.find(x => x.id === membershipId);
  if (!m) return;
  const key = orgKeyMember(m.collection_id, m.show_id, m.item_id);
  if (manage.pending[key]) return;
  const ix = manageIndex();
  const target = m.show_id != null ? ix.shows.get(m.show_id) : ix.rows.get(m.item_id);
  runOrgOp({ kind: 'remove', key, label: target ? `“${target.title}”` : '', fn: 'org_remove_membership',
    args: { p_membership_id: m.id, p_collection_id: m.collection_id, p_show_id: m.show_id ?? null, p_item_id: m.item_id ?? null } });
}

// ── Rendering ──
// The whole dialog is redrawn from state; typed text lives in manage.drafts, and
// keyboard focus, the caret and the list's scroll position are put back (focus on a
// control that no longer exists, such as a used Undo button, moves to the dialog).
function renderManage() {
  const box = document.getElementById('manageModalBox');
  if (!box || !manage) return;
  const active = document.activeElement;
  const inside = !!active && typeof box.contains === 'function' && box.contains(active);
  const focusId = inside && active.id ? active.id : null;
  const caret = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const body = document.getElementById('manageBody');
  const scroll = body ? body.scrollTop : 0;
  box.innerHTML = manageHtml();
  const again = focusId && document.getElementById(focusId);
  if (again && typeof again.focus === 'function') {
    again.focus();
    if (caret && typeof again.setSelectionRange === 'function') try { again.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ }
  } else if (inside && typeof box.focus === 'function') box.focus(); // the focused control was redrawn away: keep focus in the dialog
  const body2 = document.getElementById('manageBody');
  if (body2 && scroll) body2.scrollTop = scroll;
}

function manageHtml() {
  const pending = manageHasPending();
  const head = `<h2 class="modal-title" id="manageTitle">Manage collections</h2>
    <div class="manage-switch" role="group" aria-label="What to manage">
      <button class="btn${manage.view !== 'choices' ? ' active' : ''}" aria-pressed="${manage.view !== 'choices'}" onclick="manageShow('collections')">Collections</button>
      <button class="btn${manage.view === 'choices' ? ' active' : ''}" aria-pressed="${manage.view === 'choices'}" onclick="manageShow('choices')">Watch with</button>
    </div>`;
  const close = `<div class="modal-actions"><button class="btn" id="manageClose" onclick="closeManage()"${pending ? ' disabled' : ''}>${pending ? 'Saving…' : 'Close'}</button></div>`;
  const msg = (text, extra = '') => `${head}<div class="manage-body" id="manageBody"><p class="manage-message">${esc(text)}</p>${extra}</div>${close}`;
  switch (manage.phase) {
    case 'checking': return msg('Checking whether editing is available…');
    case 'absent': return msg('Editing collections isn’t available on this database yet.', `<button class="btn" onclick="manageRecheck()">Check again</button>`);
    case 'denied': return msg('The database refused access to collection editing.', `<button class="btn" onclick="manageRecheck()">Check again</button>`);
    case 'unknown': return msg('Couldn’t check whether editing is available.', `<button class="btn" onclick="manageRecheck()">Check again</button>`);
    case 'loading': return msg('Loading your collections…');
    case 'failed': return msg(`Couldn’t load your collections (${manage.error}).`, `<button class="btn" onclick="manageReadAgain()">Retry</button>`);
    case 'unverified': return msg(`The change may or may not have been saved, and your collections couldn’t be read (${manage.error}).`,
      `<button class="btn" onclick="manageReadAgain()">Check again</button>`);
    case 'restored': return msg('Your data was restored. Close this and open Manage again to see it.');
  }
  const st = manage.status;
  const status = st ? `<div class="manage-status" role="status">${esc(st.text)}${st.kind === 'refresh-failed'
    ? ` <button class="btn" onclick="manageReadAgain()">Retry</button>` : ''}${st.unarchive
    ? ` <button class="btn" onclick="manageSetArchived('${st.unarchive.target === 'w' ? 'w' : 'c'}', '${esc(st.unarchive.id)}', false)">Unarchive it</button>` : ''}</div>`
    : (manage.refreshing ? `<div class="manage-status" role="status">Refreshing…</div>` : '');
  const ix = manageIndex();
  const view = manage.view === 'choices' ? manageChoicesHtml(ix) : manage.view === 'members' ? manageMembersHtml(ix) : manageCollectionsHtml(ix);
  return `${head}${status}<div class="manage-body" id="manageBody">${view}</div>${close}`;
}

function manageRecheck() {
  if (!manage) return;
  const session = manage.session;
  manage.phase = 'checking';
  renderManage();
  checkOrgCapability().then(value => {
    if (!manage || manage.session !== session) return;
    if (value !== 'yes') { manage.phase = value; renderManage(); return; }
    manage.phase = 'loading';
    renderManage();
    startOrgRefresh({ barrier: false, reason: 'open' });
  });
}

// Notes for one record: its last outcome, and anything unconfirmed.
function manageNotesHtml(key) {
  const out = [];
  unconfirmedFor(key).forEach(u => out.push(`<div class="manage-note">${esc(u.text)}${u.resolved ? '' : ` ${esc(ORG_LATE_NOTE)}`}</div>`));
  if (manage.notes[key]) out.push(`<div class="manage-note">${esc(manage.notes[key])}</div>`);
  const op = manage.pending[key];
  if (op) out.push(`<div class="manage-note">Saving…${op.slow ? ` <button class="btn" onclick="manageStopWaiting('${op.id}')">Stop waiting</button>` : ''}</div>`);
  else if (manage.saved[key] && manage.refreshing) out.push(`<div class="manage-note">Saved · refreshing</div>`);
  return out.join('');
}

function manageInconsistencyHtml(ix, collectionId) {
  const out = [];
  const list = collectionId ? [[collectionId, ix.missingTargets.get(collectionId) || 0]] : [...ix.missingTargets.entries()];
  list.forEach(([cid, n]) => {
    if (!n) return;
    const c = ix.colls.get(cid);
    out.push(`<div class="manage-warning">This read didn’t include ${n} member${n === 1 ? '' : 's'} of ${esc(c ? c.name : 'a collection')}. ${esc(ORG_INCONSISTENT_TAIL)} <button class="btn" onclick="manageReadAgain()">Read again</button></div>`);
  });
  if (!collectionId && ix.missingCollections) {
    out.push(`<div class="manage-warning">This read found ${ix.missingCollections} membership${ix.missingCollections === 1 ? '' : 's'} in a collection it couldn’t read. ${esc(ORG_INCONSISTENT_TAIL)} <button class="btn" onclick="manageReadAgain()">Read again</button></div>`);
  }
  return out.join('');
}

function manageSummary(ix, c) {
  const list = ix.members.get(c.id) || [];
  const s = list.filter(x => x.kind === 'show').length, f = list.length - s;
  return `${s} show${s === 1 ? '' : 's'} · ${f} film${f === 1 ? '' : 's'}`;
}

function manageRenameHtml(target, rec) {
  const id = rec.id;
  return `<span class="manage-rename"><input id="manageRename-${esc(id)}" type="text" maxlength="100" aria-label="New name"
      value="${esc(manage.drafts[`manageRename-${id}`] ?? (rec.name ?? rec.label))}" oninput="manageDraft(this)"
      onkeydown="if(event.key==='Enter'){manageSaveRename('${target}', '${esc(id)}');}">
    <button class="btn btn-accent" onclick="manageSaveRename('${target}', '${esc(id)}')">Save</button>
    <button class="btn" onclick="manageCancelRename()">Cancel</button></span>`;
}

function manageCollectionsHtml(ix) {
  const colls = manage.data.collections.slice().sort(compareCollections);
  const active = colls.filter(c => !c.archived_at), archived = colls.filter(c => c.archived_at);
  const row = c => {
    const key = orgKeyColl(c.id), busy = !!manage.pending[key];
    const renaming = manage.renaming && manage.renaming.target === 'c' && manage.renaming.id === c.id;
    const confirming = manage.confirm && manage.confirm.target === 'c' && manage.confirm.id === c.id;
    const archivedRow = !!c.archived_at;
    const name = renaming ? manageRenameHtml('c', c) : `<span class="manage-name">${esc(c.name)}</span>`;
    let actions;
    if (archivedRow) actions = `<button class="btn" onclick="manageSetArchived('c', '${esc(c.id)}', false)"${busy ? ' disabled' : ''}>Unarchive</button>
      <button class="btn" onclick="manageEditMembers('${esc(c.id)}')">Members</button>`;
    else if (confirming) {
      const note = c.legacy_source ? ' Catalog updates won’t add new shows or films to it while it’s archived.' : '';
      actions = `<div class="manage-confirm">Hides ${esc(c.name)} from Browse collections. Its shows and films stay saved, in every other view and in this collection. You can unarchive it at any time.${esc(note)}
        <button class="btn btn-danger" onclick="manageSetArchived('c', '${esc(c.id)}', true)"${busy ? ' disabled' : ''}>Archive</button>
        <button class="btn" onclick="manageAskArchive(null, null)">Cancel</button></div>`;
    } else actions = renaming ? '' : `<button class="btn" onclick="manageStartRename('c', '${esc(c.id)}')"${busy ? ' disabled' : ''}>Rename</button>
      <button class="btn" onclick="manageAskArchive('c', '${esc(c.id)}')"${busy ? ' disabled' : ''}>Archive</button>
      <button class="btn" onclick="manageEditMembers('${esc(c.id)}')">Edit members</button>`;
    return `<li class="manage-item" data-key="${esc(key)}"><div class="manage-line">${name}<span class="manage-meta">${esc(manageSummary(ix, c))}</span></div>
      <div class="manage-actions">${actions}</div>${manageNotesHtml(key)}</li>`;
  };
  const createId = 'manageNewCollection';
  const newKeyNotes = unconfirmedKeys().filter(k => k.startsWith('c:') && !ix.colls.has(k.slice(2))).map(k => manageNotesHtml(k)).join('');
  return `${manageInconsistencyHtml(ix, null)}
    <div class="manage-create"><label for="${createId}">New collection</label>
      <input id="${createId}" type="text" maxlength="100" value="${esc(manage.drafts[createId] || '')}" oninput="manageDraft(this)"
        onkeydown="if(event.key==='Enter'){manageCreate('collection');}">
      <button class="btn btn-accent" onclick="manageCreate('collection')">Create</button>${newKeyNotes}
      ${Object.keys(manage.pending).filter(k => k.startsWith('c:') && !ix.colls.has(k.slice(2))).map(k => manageNotesHtml(k)).join('')}</div>
    <ul class="manage-list" aria-label="Your collections">${active.map(row).join('') || '<li class="manage-empty">No active collections.</li>'}</ul>
    ${archived.length ? `<button class="btn manage-archived-toggle" aria-expanded="${manage.showArchived}" onclick="manageToggleArchived()">Archived (${archived.length})</button>
      ${manage.showArchived ? `<ul class="manage-list" aria-label="Archived collections">${archived.map(row).join('')}</ul>` : ''}` : ''}`;
}

// Since Stage 4b where a record is stored isn't shown; two records with one TMDB
// identity get the "Duplicate on your list" marker (its tooltip names their storage).
function manageDuplicateHtml(kind, t) {
  if (!t || t.tmdb_id == null || !manage || !manage.data) return '';
  const same = kind === 's' ? (manage.data.shows || []).filter(s => s.tmdb_id === t.tmdb_id)
    : (manage.data.rows || []).filter(r => r.is_film && r.media_type === 'movie' && r.tmdb_id === t.tmdb_id);
  if (same.length < 2) return '';
  return ` · <span class="dup-tag" title="${esc(`${same.length} records on your list have this TMDB identity (stored under: ${same.map(x => storageLabel(x.collection)).join(', ')}). They are not merged automatically.`)}">Duplicate on your list</span>`;
}

function manageMembersHtml(ix) {
  const c = ix.colls.get(manage.collectionId);
  const back = `<button class="btn" onclick="manageShow('collections')">← All collections</button>`;
  if (!c) return `${back}<p class="manage-message">This collection isn’t in the latest read. <button class="btn" onclick="manageReadAgain()">Read again</button></p>`;
  const inconsistent = (ix.missingTargets.get(c.id) || 0) > 0;
  const locked = !!c.archived_at || inconsistent;
  const members = (ix.members.get(c.id) || []).slice().sort((a, b) => compareTitles(a.target.title, b.target.title) || cmpStr(a.m.id, b.m.id));
  const memberRow = x => {
    const key = orgKeyMember(c.id, x.m.show_id, x.m.item_id), busy = !!manage.pending[key];
    const kind = x.kind === 'show' ? `TV show · ${ix.seasons.get(x.target.id) || 0} stored season${(ix.seasons.get(x.target.id) || 0) === 1 ? '' : 's'}` : 'Film';
    return `<li class="manage-item"><div class="manage-line"><span class="manage-name">${esc(x.target.title)}</span>
      <span class="manage-meta">${esc(kind)} · ${esc(plainStatus(x.target.status))}${manageDuplicateHtml(x.kind === 'show' ? 's' : 'i', x.target)}</span></div>
      <div class="manage-actions"><button class="btn" onclick="manageRemoveMember('${esc(x.m.id)}')"${locked || busy ? ' disabled' : ''} aria-label="Remove ${esc(x.target.title)} from ${esc(c.name)}">Remove</button></div>
      ${manageNotesHtml(key)}</li>`;
  };
  // Notes for members no longer listed (removed, or unconfirmed changes).
  const listed = new Set(members.map(x => orgKeyMember(c.id, x.m.show_id, x.m.item_id)));
  const otherNotes = [...new Set([...unconfirmedKeys(), ...Object.keys(manage.notes), ...Object.keys(manage.pending)])]
    .filter(k => k.startsWith(`m:${c.id}|`) && !listed.has(k)).map(k => manageNotesHtml(k)).join('');
  const undo = manage.undo.map((u, i) => u.collectionId === c.id
    ? `<div class="manage-note">${u.action === 'remove' ? 'Added' : 'Removed'} ${esc(u.label)}. <button class="btn" onclick="manageUndo(${i})"${locked ? ' disabled' : ''}>Undo</button></div>` : '').join('');
  const q = String(manage.drafts.manageMemberSearch || '').trim().toLowerCase();
  let results = '';
  if (!locked && q) {
    const memberKeys = new Set((manage.data.memberships || []).filter(m => m.collection_id === c.id).map(m => m.show_id != null ? `s:${m.show_id}` : `i:${m.item_id}`));
    const shows = manage.data.shows.filter(s => String(s.title || '').toLowerCase().includes(q)).map(s => ({ kind: 's', t: s }));
    const films = manage.data.rows.filter(r => r.is_film && String(r.title || '').toLowerCase().includes(q)).map(r => ({ kind: 'i', t: r }));
    const unclassified = manage.data.rows.filter(r => !r.is_film && r.show_id == null && String(r.title || '').toLowerCase().includes(q)).length;
    const list = shows.concat(films).sort((a, b) => compareTitles(a.t.title, b.t.title) || cmpStr(a.t.id, b.t.id)).slice(0, 40);
    results = `<ul class="manage-list" aria-label="Search results">${list.map(({ kind, t }) => {
      const inIt = memberKeys.has(`${kind}:${t.id}`);
      const n = kind === 's' ? ix.seasons.get(t.id) || 0 : 0;
      const key = orgKeyMember(c.id, kind === 's' ? t.id : null, kind === 'i' ? t.id : null), busy = !!manage.pending[key];
      const label = kind === 's' ? `Add show (all ${n} stored season${n === 1 ? '' : 's'}, and any added later)` : 'Add film';
      return `<li class="manage-item"><div class="manage-line"><span class="manage-name">${esc(t.title)}</span>
        <span class="manage-meta">${kind === 's' ? 'TV show' : 'Film'} · ${esc(plainStatus(t.status))}${t.status === 'skipped' ? ' (Browse hides Skipped by default)' : ''}${manageDuplicateHtml(kind, t)}</span></div>
        <div class="manage-actions">${inIt ? '<span class="manage-in">In this collection</span>'
          : `<button class="btn" onclick="manageAddMember('${kind}', '${esc(t.id)}')"${busy ? ' disabled' : ''}>${esc(label)}</button>`}</div>${inIt ? '' : manageNotesHtml(key)}</li>`;
    }).join('') || '<li class="manage-empty">Nothing saved matches.</li>'}</ul>
    ${unclassified ? `<p class="manage-hint">${unclassified} matching saved row${unclassified === 1 ? ' is' : 's are'} neither a TV season nor a film, so ${unclassified === 1 ? 'it' : 'they'} can’t be added. All Movies lists such rows.</p>` : ''}`;
  }
  // Adding comes first, so it never needs a scroll past a long member list.
  return `${back}<h3 class="manage-subtitle">${esc(c.name)}${c.archived_at ? ' (archived)' : ''}</h3>
    ${c.archived_at ? `<p class="manage-hint">This collection is archived. Unarchive it to change its members.</p>` : ''}
    ${manageInconsistencyHtml(ix, c.id)}${undo}${otherNotes}
    ${c.archived_at ? '' : `<div class="manage-create"><label for="manageMemberSearch">Add a saved show or film</label>
      <input id="manageMemberSearch" type="search" value="${esc(manage.drafts.manageMemberSearch || '')}" oninput="manageDraft(this)"${locked ? ' disabled' : ''}
        placeholder="Search your saved titles…">
      <p class="manage-hint">A show is added whole: every stored season, and any added later. Nothing is copied or moved, and watched status is unchanged.</p>
      ${results}</div>`}
    <h4 class="manage-members-head">Members (${members.length})</h4>
    <ul class="manage-list" aria-label="Members of ${esc(c.name)}">${members.map(memberRow).join('') || '<li class="manage-empty">No members yet.</li>'}</ul>`;
}

function manageChoicesHtml(ix) {
  const choices = manage.data.choices.slice().sort((a, b) => (a.sort_order - b.sort_order) || cmpStr(a.token, b.token));
  const active = choices.filter(c => !c.archived_at), archived = choices.filter(c => c.archived_at);
  const row = w => {
    const key = orgKeyChoice(w.id), busy = !!manage.pending[key];
    const renaming = manage.renaming && manage.renaming.target === 'w' && manage.renaming.id === w.id;
    const n = ix.usage.get(w.token) || 0;
    const name = renaming ? manageRenameHtml('w', w) : `<span class="manage-name">${esc(w.label)}</span>`;
    const actions = w.archived_at
      ? `<button class="btn" onclick="manageSetArchived('w', '${esc(w.id)}', false)"${busy ? ' disabled' : ''}>Unarchive</button>`
      : renaming ? '' : `<button class="btn" onclick="manageStartRename('w', '${esc(w.id)}')"${busy ? ' disabled' : ''}>Rename</button>
        <button class="btn" onclick="manageSetArchived('w', '${esc(w.id)}', true)"${busy ? ' disabled' : ''}>Archive</button>`;
    return `<li class="manage-item"><div class="manage-line">${name}<span class="manage-meta">used on ${n} saved item${n === 1 ? '' : 's'}</span></div>
      <div class="manage-actions">${actions}</div>${manageNotesHtml(key)}</li>`;
  };
  const createId = 'manageNewChoice';
  const newKeyNotes = [...new Set([...unconfirmedKeys(), ...Object.keys(manage.pending)])].filter(k => k.startsWith('w:') && !manage.data.choices.some(c => `w:${c.id}` === k)).map(k => manageNotesHtml(k)).join('');
  return `<p class="manage-hint">Archiving a choice stops offering it; items that have it keep it and still show it.</p>
    <div class="manage-create"><label for="${createId}">New watch-with choice</label>
      <input id="${createId}" type="text" maxlength="100" value="${esc(manage.drafts[createId] || '')}" oninput="manageDraft(this)"
        onkeydown="if(event.key==='Enter'){manageCreate('choice');}">
      <button class="btn btn-accent" onclick="manageCreate('choice')">Create</button>${newKeyNotes}</div>
    <ul class="manage-list" aria-label="Your watch-with choices">${active.map(row).join('') || '<li class="manage-empty">No active choices.</li>'}</ul>
    ${archived.length ? `<button class="btn manage-archived-toggle" aria-expanded="${manage.showArchived}" onclick="manageToggleArchived()">Archived (${archived.length})</button>
      ${manage.showArchived ? `<ul class="manage-list" aria-label="Archived choices">${archived.map(row).join('')}</ul>` : ''}` : ''}`;
}
