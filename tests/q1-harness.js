// Q1 named planning queues (db/q1_queues.sql) for the offline harness, written independently of the page's code so the tests can
// catch a page/database mismatch: the two tables, the library_queue_* functions with the database's rules (one item once per queue,
// never a whole show beside its seasons, expected orders and names, places 1..n after a move), completion (an unwatched film or
// season marked watched leaves every queue; an ended show completed by a regular season's mark or by Show ended turned on loses its
// whole-show entries) and identity (a season moved by matching: whole-show entries of an emptied show carried, duplicates merged,
// covered seasons removed). Used by tests/app-harness.js in the current phase (createApp's default).

const Q1_TABLES = ['watch_queues', 'queue_entries'];
const clone = v => JSON.parse(JSON.stringify(v));
const isSpecial = r => r.season_number === 0 || /^specials?$/i.test(String(r.season || '').trim());

function q1Handlers({ store, DbError, isFilmRow, handlers, newId }) {
  const queues = () => store.watch_queues, entries = () => store.queue_entries;
  const refuse = (code, text) => { throw new DbError('P0001', `${code}: ${text}`); };
  const changed = () => refuse('target_changed', 'This changed since the page showed it, so nothing was changed. Look at it again.');
  const queueOf = id => queues().find(q => q.id === id) || refuse('queue_missing', 'This queue is no longer there, so nothing was changed. Look at your queues again.');
  const inQueue = qid => entries().filter(e => e.queue_id === qid).sort((a, b) => a.position - b.position);
  const ordered = () => [...queues()].sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
  const validName = n => typeof n === 'string' && n === n.trim() && n !== '' && n.length <= 100;
  const moved = (ids, id, to) => { const rest = ids.filter(x => x !== id), k = Math.max(1, Math.min(to, rest.length + 1)); return [...rest.slice(0, k - 1), id, ...rest.slice(k - 1)]; };
  const now = () => new Date().toISOString();
  const showComplete = sid => {
    const s = store.tv_shows.find(x => x.id === sid);
    const regular = store.watchlist_items.filter(w => w.show_id === sid && !isSpecial(w));
    return !!s && !!s.ended && regular.length > 0 && regular.every(w => w.watched && !w.skipped);
  };
  const drop = pred => { store.queue_entries = entries().filter(e => !pred(e)); };

  const fns = {
    library_queue_create({ p_name: name }) {
      if (!validName(name)) throw new DbError('22023', 'invalid_input: name');
      if (queues().some(q => q.name.toLowerCase() === name.toLowerCase())) refuse('queue_name_taken', 'You already have a queue with this name, so nothing was changed.');
      const q = { id: newId(), name, sort_order: Math.max(0, ...queues().map(x => x.sort_order)) + 1, created_at: now() };
      queues().push(q);
      return clone(q);
    },
    library_queue_rename({ p_queue_id: id, p_expected_name: expected, p_name: name }) {
      if (!validName(name) || typeof expected !== 'string') throw new DbError('22023', 'invalid_input: name');
      const q = queueOf(id);
      if (q.name !== expected) changed();
      if (queues().some(x => x.id !== q.id && x.name.toLowerCase() === name.toLowerCase())) refuse('queue_name_taken', 'You already have a queue with this name, so nothing was changed.');
      q.name = name;
      return clone(q);
    },
    library_queue_delete({ p_queue_id: id, p_expected_count: n }) {
      if (!Number.isInteger(n) || n < 0) throw new DbError('22023', 'invalid_input: p_expected_count');
      const q = queueOf(id), count = inQueue(q.id).length;
      if (count !== n) changed();
      store.watch_queues = queues().filter(x => x.id !== q.id);
      drop(e => e.queue_id === q.id);
      return { deleted_queue_id: q.id, entries_removed: count };
    },
    library_queue_reorder({ p_expected: expected, p_queue_id: id, p_to_index: to }) {
      if (!Array.isArray(expected) || !id || !Number.isInteger(to) || to < 1) throw new DbError('22023', 'invalid_input: reorder');
      const cur = ordered().map(q => q.id);
      if (JSON.stringify(cur) !== JSON.stringify(expected) || !cur.includes(id)) changed();
      const next = moved(cur, id, to);
      next.forEach((qid, i) => { queues().find(q => q.id === qid).sort_order = i + 1; });
      return { order: next };
    },
    library_queue_add({ p_queue_id: qid, p_show_id: showId, p_item_id: itemId }) {
      if (!qid || (showId == null) === (itemId == null)) throw new DbError('22023', 'invalid_input: one of show or item');
      const w = itemId != null ? store.watchlist_items.find(x => x.id === itemId) : null;
      const s = showId != null ? store.tv_shows.find(x => x.id === showId) : null;
      if (itemId != null && !w) refuse('target_missing', 'This is no longer in your library, so nothing was changed.');
      if (showId != null && !s) refuse('target_missing', 'This show is no longer in your library, so nothing was changed.');
      const q = queueOf(qid), list = inQueue(q.id);
      const dup = list.findIndex(e => (itemId != null && e.item_id === itemId) || (showId != null && e.show_id === showId));
      if (dup >= 0) refuse('queue_duplicate', `This is already in “${q.name}” (#${dup + 1}), so nothing was changed.`);
      if (w && w.show_id && list.some(e => e.show_id === w.show_id)) refuse('queue_overlap', `The whole show is in “${q.name}”, which covers ${w.season}, so nothing was changed.`);
      if (s) {
        const seasons = list.map(e => e.item_id && store.watchlist_items.find(x => x.id === e.item_id)).filter(x => x && x.show_id === s.id).map(x => x.season).sort();
        if (seasons.length) refuse('queue_overlap', `“${q.name}” already has ${seasons.join(', ')} of this show. Remove ${seasons.length > 1 ? 'them' : 'it'} first to add the whole show. Nothing was changed.`);
      }
      const e = { id: newId(), queue_id: q.id, show_id: showId ?? null, item_id: itemId ?? null, position: Math.max(0, ...list.map(x => x.position)) + 1, created_at: now() };
      entries().push(e);
      return { ...clone(e), place: list.length + 1 };
    },
    library_queue_remove({ p_entry_id: id }) {
      if (!id) throw new DbError('22023', 'invalid_input: entry');
      const had = entries().some(e => e.id === id);
      drop(e => e.id === id);
      return { entry_id: id, removed: had };
    },
    library_queue_move({ p_queue_id: qid, p_expected: expected, p_entry_id: id, p_to_index: to }) {
      if (!Array.isArray(expected) || !id || !Number.isInteger(to) || to < 1) throw new DbError('22023', 'invalid_input: move');
      const q = queueOf(qid), cur = inQueue(q.id).map(e => e.id);
      if (JSON.stringify(cur) !== JSON.stringify(expected) || !cur.includes(id)) changed();
      const next = moved(cur, id, to);
      next.forEach((eid, i) => { entries().find(e => e.id === eid).position = i + 1; });
      return { queue_id: q.id, order: next };
    }
  };

  // Completion and identity follow the stored rows after the underlying function (the database's triggers).
  const snapshot = () => ({ items: new Map(store.watchlist_items.map(w => [w.id, { watched: !!w.watched, show_id: w.show_id ?? null }])),
    shows: new Map(store.tv_shows.map(s => [s.id, !!s.ended])) });
  const after = before => {
    for (const w of store.watchlist_items) {
      const was = before.items.get(w.id);
      if (!was) continue;
      if (was.show_id !== (w.show_id ?? null)) {
        const old = was.show_id, neu = w.show_id ?? null;
        if (old && !store.watchlist_items.some(x => x.show_id === old)) {
          for (const e of entries().filter(x => x.show_id === old)) {
            if (neu) { if (entries().some(x => x.queue_id === e.queue_id && x.show_id === neu)) drop(x => x.id === e.id); else e.show_id = neu; }
            else if (entries().some(x => x.queue_id === e.queue_id && x.item_id === w.id)) drop(x => x.id === e.id);
            else { e.show_id = null; e.item_id = w.id; }
          }
        }
        if (neu) {
          const whole = new Set(entries().filter(x => x.show_id === neu).map(x => x.queue_id));
          drop(x => x.item_id && whole.has(x.queue_id) && (store.watchlist_items.find(i => i.id === x.item_id) || {}).show_id === neu);
        }
      }
      if (!was.watched && w.watched) {
        drop(e => e.item_id === w.id);
        if (w.show_id && !isFilmRow(w) && !isSpecial(w) && showComplete(w.show_id)) drop(e => e.show_id === w.show_id);
      }
    }
    for (const s of store.tv_shows) if (before.shows.get(s.id) === false && s.ended && showComplete(s.id)) drop(e => e.show_id === s.id);
    // (a deleted row or show takes its entries: the foreign keys)
    const rows = new Set(store.watchlist_items.map(w => w.id)), shows = new Set(store.tv_shows.map(s => s.id));
    drop(e => (e.item_id && !rows.has(e.item_id)) || (e.show_id && !shows.has(e.show_id)));
  };
  const wrapped = {};
  for (const [name, fn] of Object.entries(handlers)) {
    if (/^library_queue_/.test(name) || name === 'restore_backup') continue;
    wrapped[name] = (...args) => {
      const before = store.watch_queues ? snapshot() : null;
      const out = fn(...args);
      if (out && typeof out.then === 'function') return out.then(v => { if (before && store.queue_entries) after(before); return v; });
      if (before && store.queue_entries) after(before);
      return out;
    };
  }
  return { ...wrapped, ...fns };
}

module.exports = { Q1_TABLES, q1Handlers };
