// G1 games (db/g1_games.sql) for the offline harness, written independently of the page's code so the tests can catch a
// page/database mismatch: the game tables, the library_game_* functions with the database's rules (expected values, one saved
// game per IGDB record and port, decisions keyed by kind, record and platform, Available only with research access),
// completion (a game set to Finished leaves every queue), games in queues (library_queue_add_game) and the whole-queue order
// (library_queue_set_order). The IGDB function is app.igdb (queries → results; default: none). Used by tests/app-harness.js in
// the current phase (createApp's default).

const G1_TABLES = ['game_settings', 'game_entries', 'game_follows', 'game_decisions', 'game_collections', 'game_collection_members', 'game_titles'];
const clone = v => JSON.parse(JSON.stringify(v));
const PLATFORMS = ['ps5', 'ps4', 'switch2', 'switch', 'xbox_series', 'xbox_one', 'pc'];
const STATUSES = ['want', 'playing', 'paused', 'finished', 'skipped'];

function g1Handlers({ app, store, DbError }) {
  // Real-shaped ids, as the database makes them (a backup of these rows must validate).
  let seq = 0;
  const newId = () => `6a000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const refuse = (code, text) => { throw new DbError('P0001', `${code}: ${text}`); };
  const invalid = what => { throw new DbError('22023', `invalid_input: ${what}`); };
  const changed = () => refuse('target_changed', 'This changed since the page showed it, so nothing was changed. Look at it again.');
  const now = () => new Date().toISOString();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const entryOf = id => store.game_entries.find(e => e.id === id) || refuse('target_missing', 'This game is no longer in your library, so nothing was changed.');
  const savedAs = (igdb, except) => store.game_entries.find(e => e.id !== except && (e.igdb_id === igdb || (e.port_ids || []).includes(igdb)));
  const queueOf = id => store.watch_queues.find(q => q.id === id) || refuse('queue_missing', 'This queue is no longer there, so nothing was changed. Look at your queues again.');
  const inQueue = qid => store.queue_entries.filter(e => e.queue_id === qid).sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  const json = e => clone(e);
  return {
    library_game_settings_save({ p_expected: expected, p_platforms: platforms, p_play_style: style }) {
      if (!Array.isArray(platforms) || !platforms.every(p => PLATFORMS.includes(p)) || new Set(platforms).size !== platforms.length || !['main', 'main_extra', 'completionist'].includes(style)) invalid('settings');
      const s = store.game_settings[0];
      if (!!s !== (expected != null) || (s && (!same(s.platforms, expected.platforms) || s.play_style !== expected.play_style))) changed();
      if (s) Object.assign(s, { platforms: clone(platforms), play_style: style, updated_at: now() });
      else store.game_settings.push({ id: newId(), platforms: clone(platforms), play_style: style, updated_at: now() });
      return json(store.game_settings[0]);
    },
    library_game_add({ p_igdb_id: igdb, p_title: title, p_spot_igdb_id: spot, p_port_ids: ports, p_status: status, p_priority: priority }) {
      if (!(igdb > 0) || !(spot > 0) || !Array.isArray(ports) || ports.includes(igdb) || typeof title !== 'string' || !title.trim() || !STATUSES.includes(status)) invalid('game');
      if ([igdb, ...ports].some(x => savedAs(x))) refuse('game_duplicate', 'This game is already in your library, so nothing was changed.');
      const e = { id: newId(), igdb_id: igdb, spot_igdb_id: spot, port_ids: clone(ports), title, status, priority, created_at: now(), updated_at: now() };
      store.game_entries.push(e);
      return json(e);
    },
    library_game_set({ p_entry_id: id, p_expected: expected, p_status: status, p_priority: priority }) {
      if (!STATUSES.includes(status)) invalid('game');
      const e = entryOf(id);
      if (e.status !== expected.status || e.priority !== expected.priority) changed();
      let n = 0;
      if (status === 'finished' && e.status !== 'finished') {
        n = store.queue_entries.filter(q => q.game_entry_id === e.id).length;
        store.queue_entries = store.queue_entries.filter(q => q.game_entry_id !== e.id);
      }
      Object.assign(e, { status, priority, updated_at: now() });
      return { ...json(e), queue_entries_removed: n };
    },
    library_game_relink({ p_entry_id: id, p_expected: expected, p_spot_igdb_id: spot, p_port_ids: ports }) {
      const e = entryOf(id);
      if (expected.spot_igdb_id !== e.spot_igdb_id || !same(expected.port_ids, e.port_ids)) changed();
      if (ports.some(p => savedAs(p, e.id))) refuse('game_duplicate', 'One of these records is already saved as another game, so nothing was changed.');
      Object.assign(e, { spot_igdb_id: spot, port_ids: clone(ports), updated_at: now() });
      return json(e);
    },
    library_game_delete({ p_entry_id: id, p_expected_status: status }) {
      const e = entryOf(id);
      if (e.status !== status) changed();
      const q = store.queue_entries.filter(x => x.game_entry_id === e.id).length, c = store.game_collection_members.filter(m => m.entry_id === e.id).length;
      store.game_entries = store.game_entries.filter(x => x !== e);
      store.queue_entries = store.queue_entries.filter(x => x.game_entry_id !== e.id);
      store.game_collection_members = store.game_collection_members.filter(m => m.entry_id !== e.id);
      return { deleted_id: e.id, queue_entries_removed: q, collection_memberships_removed: c };
    },
    library_game_follow({ p_collection_igdb_id: cid, p_name: name }) {
      if (store.game_follows.some(f => f.igdb_collection_id === cid)) refuse('game_follow_exists', 'You already follow this franchise, so nothing was changed.');
      const f = { id: newId(), igdb_collection_id: cid, name, created_at: now() };
      store.game_follows.push(f);
      return json(f);
    },
    library_game_unfollow({ p_follow_id: id }) {
      const had = store.game_follows.some(f => f.id === id);
      store.game_follows = store.game_follows.filter(f => f.id !== id);
      return { follow_id: id, removed: had };
    },
    library_game_decision_set({ p_kind: kind, p_igdb_id: igdb, p_platform: platform, p_expected: expected, p_value: value }) {
      const p = platform || '';
      if (!['not_out_yet', 'available', 'skip_spot', 'include_spinoff', 'keep_link', 'research_link', 'research_role'].includes(kind) || (['not_out_yet', 'available'].includes(kind)) !== (p !== '')) invalid('decision');
      const basis = ['available', 'research_link', 'research_role'].includes(kind) || (value && Array.isArray(value.evidence) && value.evidence.length) ? 'research' : 'member';
      if (value != null && basis === 'research' && app.research !== true) refuse('research_not_enabled', 'Recording release evidence needs research access. Nothing was changed.');
      const d = store.game_decisions.find(x => x.kind === kind && x.igdb_id === igdb && x.platform === p);
      if (!!d !== (expected != null) || (d && !same(d.value, expected))) changed();
      if (value == null) { store.game_decisions = store.game_decisions.filter(x => x !== d); return { kind, igdb_id: igdb, platform: p, removed: !!d }; }
      if (d) Object.assign(d, { value: clone(value), basis, created_at: now() });
      else store.game_decisions.push({ id: newId(), kind, igdb_id: igdb, platform: p, value: clone(value), basis, created_at: now() });
      return json(store.game_decisions.find(x => x.kind === kind && x.igdb_id === igdb && x.platform === p));
    },
    library_game_collection_create({ p_name: name }) {
      if (store.game_collections.some(c => c.name.toLowerCase() === String(name).toLowerCase())) refuse('collection_name_taken', 'You already have a game collection with this name, so nothing was changed.');
      const c = { id: newId(), name, created_at: now() };
      store.game_collections.push(c);
      return json(c);
    },
    library_game_collection_rename({ p_collection_id: id, p_expected_name: expected, p_name: name }) {
      const c = store.game_collections.find(x => x.id === id) || refuse('collection_missing', 'This game collection is no longer there, so nothing was changed.');
      if (c.name !== expected) changed();
      c.name = name;
      return json(c);
    },
    library_game_collection_delete({ p_collection_id: id, p_expected_count: n }) {
      const c = store.game_collections.find(x => x.id === id) || refuse('collection_missing', 'This game collection is no longer there, so nothing was changed.');
      const count = store.game_collection_members.filter(m => m.collection_id === id).length;
      if (count !== n) changed();
      store.game_collections = store.game_collections.filter(x => x !== c);
      store.game_collection_members = store.game_collection_members.filter(m => m.collection_id !== id);
      return { deleted_collection_id: id, members_removed: count };
    },
    library_game_collection_add({ p_collection_id: cid, p_entry_id: eid }) {
      entryOf(eid);
      const c = store.game_collections.find(x => x.id === cid) || refuse('collection_missing', 'This game collection is no longer there, so nothing was changed.');
      if (store.game_collection_members.some(m => m.collection_id === cid && m.entry_id === eid)) refuse('collection_duplicate', `This game is already in “${c.name}”, so nothing was changed.`);
      const m = { id: newId(), collection_id: cid, entry_id: eid, created_at: now() };
      store.game_collection_members.push(m);
      return json(m);
    },
    library_game_collection_remove({ p_member_id: id }) {
      const had = store.game_collection_members.some(m => m.id === id);
      store.game_collection_members = store.game_collection_members.filter(m => m.id !== id);
      return { member_id: id, removed: had };
    },
    library_game_titles_put({ p_rows: rows }) {
      if (!Array.isArray(rows) || rows.length > 500) invalid('titles');
      for (const r of rows) {
        const old = store.game_titles.find(t => t.igdb_id === r.igdb_id);
        if (old) Object.assign(old, { data: clone(r.data), fetched_at: now() });
        else store.game_titles.push({ id: newId(), igdb_id: r.igdb_id, data: clone(r.data), fetched_at: now() });
      }
      return { cached: rows.length };
    },
    library_game_titles_purge() { const n = store.game_titles.length; store.game_titles = []; return { removed: n }; },
    library_queue_add_game({ p_queue_id: qid, p_entry_id: eid }) {
      entryOf(eid);
      const q = queueOf(qid), list = inQueue(q.id), at = list.findIndex(e => e.game_entry_id === eid);
      if (at >= 0) refuse('queue_duplicate', `This is already in “${q.name}” (#${at + 1}), so nothing was changed.`);
      const e = { id: newId(), queue_id: q.id, show_id: null, item_id: null, game_entry_id: eid, position: Math.max(0, ...list.map(x => x.position)) + 1, created_at: now() };
      store.queue_entries.push(e);
      return { ...json(e), place: list.length + 1 };
    },
    library_queue_set_order({ p_queue_id: qid, p_expected: expected, p_order: order }) {
      const q = queueOf(qid), cur = inQueue(q.id).map(e => e.id);
      if (!same(cur, expected)) changed();
      if (!Array.isArray(order) || order.length !== cur.length || new Set(order).size !== cur.length || !order.every(id => cur.includes(id))) invalid('the new order must hold exactly the queue\'s entries');
      order.forEach((id, i) => { store.queue_entries.find(e => e.id === id).position = i + 1; });
      return { queue_id: q.id, order: clone(order) };
    }
  };
}

module.exports = { G1_TABLES, g1Handlers };
