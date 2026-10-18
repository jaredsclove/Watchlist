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

// The notice above the list: a line of text and, while it applies, Undo.
function showCollectionNotice(text, withUndo) {
  const el = document.getElementById('banner');
  if (!el) return;
  const active = document.activeElement;
  const hadFocus = !!active && typeof active.closest === 'function' && !!active.closest('#collectionNotice');
  el.innerHTML = text ? `<div class="banner collection-notice" id="collectionNotice" role="status" tabindex="-1">${esc(text)}${withUndo
    ? ` <button class="btn" id="collectionUndoBtn" onclick="undoCollectionRemove()">Undo</button>` : ''}</div>` : '';
  // A used Undo button is replaced: focus stays on the notice rather than falling to the page.
  if (hadFocus) {
    const again = document.getElementById(withUndo ? 'collectionUndoBtn' : 'collectionNotice') || document.getElementById('collectionNotice');
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
  const target = { kind, id, title: rec.title, name: dest.label, collectionId: dest.collectionId, membershipId: m.id, viewId, epoch };
  await runWrite(`Remove “${rec.title}” from ${dest.label}`, () => collectionRemoveNow(target), { list: true });
}

async function collectionRemoveNow(t) {
  const cap = await checkOrgCapability();
  if (cap !== 'yes') { showError(COLLECTION_CAPABILITY_TEXT[cap] || COLLECTION_CAPABILITY_TEXT.unknown); return; }
  if (activeViewId !== t.viewId || orgEpoch !== t.epoch) return; // left or restored while checking: nothing is sent
  const args = { p_membership_id: t.membershipId, p_collection_id: t.collectionId,
    p_show_id: t.kind === 'show' ? t.id : null, p_item_id: t.kind === 'film' ? t.id : null };
  let res = null, err = null;
  try { res = await sbRpc('org_remove_membership', args); } catch (e) { err = e; }
  await collectionAnswer(t, 'remove', args, res, err);
}

// Undo (once): the same collection, show or film, back through org_add_membership.
async function undoCollectionRemove() {
  const u = collectionUndo;
  if (!u || u.viewId !== activeViewId || u.epoch !== orgEpoch) { collectionUndo = null; showCollectionNotice('', false); return; }
  await runWrite(`Undo: “${u.title}” back to ${u.name}`, async () => {
    if (collectionUndo !== u) return;
    collectionUndo = null; // offered at most once, whatever the answer
    const cap = await checkOrgCapability();
    if (cap !== 'yes') { showCollectionNotice('', false); showError(COLLECTION_CAPABILITY_TEXT[cap] || COLLECTION_CAPABILITY_TEXT.unknown); return; }
    if (activeViewId !== u.viewId || orgEpoch !== u.epoch) return;
    const args = { p_collection_id: u.collectionId, p_show_id: u.kind === 'show' ? u.id : null, p_item_id: u.kind === 'film' ? u.id : null };
    let res = null, err = null;
    try { res = await sbRpc('org_add_membership', args); } catch (e) { err = e; }
    await collectionAnswer(u, 'add', args, res, err);
  }, { list: true });
}

// One answer to a Remove or an Undo: reported in Manage's words; the collection is read again.
async function collectionAnswer(t, kind, args, res, err) {
  const info = err ? orgErrorInfo(err) : null;
  const here = activeViewId === t.viewId && orgEpoch === t.epoch;
  if (info && orgMissingFunction(info)) {
    orgWriteCapability = null;
    if (here) { showCollectionNotice('', false); showError(COLLECTION_CAPABILITY_TEXT.absent); }
    return;
  }
  if (info && info.kind !== 'database') {
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
  const outcome = describeOutcome({ kind, args }, res, info);
  let text, undo = false;
  if (kind === 'remove' && res && res.removed) {
    text = `Removed “${t.title}” from ${t.name}. It’s still in your library.`;
    collectionUndo = { kind: t.kind, id: t.id, title: t.title, name: t.name, collectionId: t.collectionId, viewId: t.viewId, epoch: t.epoch };
    undo = true;
  } else if (kind === 'add' && res) {
    text = res.added ? `“${t.title}” is back in ${t.name}.` : `“${t.title}” is already in ${t.name} (added again elsewhere).`;
  } else {
    const what = kind === 'remove' ? `“${t.title}” wasn’t removed from ${t.name}` : `“${t.title}” wasn’t put back in ${t.name}`;
    text = `${what}: ${outcome.note || outcome.text}`;
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
  libraryReport({ session: tool.session, viewId: tool.viewId },
    `Added ${n} film${n === 1 ? '' : 's'} to your library. ${n === 1 ? 'It isn’t' : 'They aren’t'} in ${dest.label}: Pull rest adds to your library, not to this collection.`, false);
}
