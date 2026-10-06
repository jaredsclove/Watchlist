// Offline harness that runs the whole page in a Node vm: every script in
// watchlist.html's order, then the page's inline state/boot script, against a
// minimal fake DOM and an in-memory stand-in for Supabase and TMDB.
// Used by tests/derived-views.test.js and tests/derived-nav.test.js.
// No network, no database: fetch is a stub that refuses any unexpected host.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'watchlist.html'), 'utf8');
const SCRIPT_FILES = [...HTML.matchAll(/<script src="([^"?]+)(?:\?[^"]*)?"><\/script>/g)].map(m => m[1]);
const INLINE_SCRIPT = HTML.match(/<script>\n([\s\S]*?)<\/script>/)[1];
const PAGE_IDS = [...HTML.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/id="([^"]+)"/g)].map(m => m[1]);

const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const clone = v => JSON.parse(JSON.stringify(v));

// PostgREST-style filter over in-memory rows: eq., is.null, in.(...)
function matches(row, params) {
  for (const [k, v] of params) {
    if (k === 'select' || k === 'order' || k === 'limit') continue;
    if (v === 'is.null') { if (row[k] != null) return false; continue; }
    if (v.startsWith('eq.')) { if (String(row[k]) !== v.slice(3)) return false; continue; }
    if (v.startsWith('in.(')) {
      const list = v.slice(4, -1).split(',').map(x => x.replace(/^"|"$/g, ''));
      if (!list.includes(String(row[k]))) return false;
      continue;
    }
    throw new Error(`harness: unsupported filter ${k}=${v}`);
  }
  return true;
}

function response(status, body, headers = {}) {
  const text = body == null ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text || 'null'),
    headers: { get: name => headers[name.toLowerCase()] ?? null }
  };
}

// The browser-facing TV functions of db/rpc.sql as they behave in the shadow and
// authoritative and final stages (app.stage; default 'final', production's stage), written independently
// of the app's helpers so the tests can catch an app/database mismatch. Shows live
// in store.tv_shows. The compatibility values the database writes to the season
// status in the authoritative stage aren't simulated: the app must not read them.
// Errors answer like PostgREST.
const TV_COLLECTIONS = ['disney', '90day', 'sheridan', 'othertv', 'truecrime'];
const SHOW_KEY_OVERRIDE = { 'disney|the clone wars': 'star wars: the clone wars (2008)' };
const sqlShowKey = (collection, itemKey) => {
  const prefix = String(itemKey || '').split('|')[0];
  return SHOW_KEY_OVERRIDE[`${collection}|${prefix}`] || prefix;
};
const isTvRow = r => TV_COLLECTIONS.includes(r.collection) && (r.media_type === 'tv' || (r.media_type == null && (r.season || '') !== 'Film'));
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
class DbError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const HTTP_FOR = { '22023': 400, '23505': 409, P0002: 404, '23000': 409, '40001': 409, '55000': 400 };

const TV_STATUSES = ['confirmed', 'highpriority', 'watching', 'complete', 'pending', 'maybe', 'skipped'];

// Links fixture TV rows that have no show_id the way the Phase 1c backfill does:
// one show per collection + TMDB id (or show key), status and skip flags from the
// approved migration rule (old aggregate status for a pattern the rule doesn't map).
function linkFixtureRows(store, newId) {
  const M = require('./tv-model-reference');
  const groups = new Map();
  for (const r of store.watchlist_items) {
    if (!isTvRow(r) || r.show_id) continue;
    const key = r.tmdb_id != null ? `${r.collection}|tmdb:${r.tmdb_id}` : `${r.collection}|key:${sqlShowKey(r.collection, r.item_key)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const seasons of groups.values()) {
    const r0 = seasons[0];
    const showKey = r0.tmdb_id != null ? String(r0.item_key).split('|')[0] : sqlShowKey(r0.collection, r0.item_key);
    let show = store.tv_shows.find(s => s.collection === r0.collection && (r0.tmdb_id != null ? s.tmdb_id === r0.tmdb_id : s.tmdb_id == null && s.show_key === showKey));
    if (!show) {
      const m = M.migrateShow(seasons);
      const titleRow = seasons.find(x => String(x.item_key).split('|')[0] === showKey) || r0;
      show = { id: newId(), collection: r0.collection, title: titleRow.title, show_key: showKey, tmdb_id: r0.tmdb_id ?? null,
        status: m.unmapped ? M.oldAggregateStatus(seasons) : m.status, created_at: '2026-01-01T00:00:00+00:00' };
      store.tv_shows.push(show);
      for (const x of seasons) if (x.skipped === undefined) x.skipped = !m.unmapped && m.skippedIds.has(x.id);
    }
    for (const x of seasons) { x.show_id = show.id; if (x.skipped === undefined) x.skipped = false; }
  }
}

function tvFunctions(app, store, newId, org = NO_ORG) {
  const shows = () => store.tv_shows;
  const authoritative = () => ['authoritative', 'final'].includes(app.stage);
  const requireAuthoritative = fn => {
    if (!authoritative()) throw new DbError('55000', `not_available: ${fn} is not available in stage ${app.stage}`);
  };
  const items = () => store.watchlist_items;
  const seasonLabel = n => (n === 0 ? 'Specials' : `Season ${n}`);
  function lockOrCreateShow(collection, tmdbId, showKey, title, status) {
    let s = shows().find(x => x.collection === collection && (tmdbId != null ? x.tmdb_id === tmdbId : x.tmdb_id == null && x.show_key === showKey));
    if (s) return { show: s, created: false };
    s = { id: newId(), collection, title, show_key: showKey, tmdb_id: tmdbId, status };
    shows().push(s);
    org.newShow(s);
    return { show: s, created: true };
  }
  function insertRow(fields) {
    const r = { id: newId(), watched: false, media_type: null, tmdb_id: null, season_number: null, show_id: null, skipped: false, ...fields };
    items().push(r);
    org.newItem(r);
    return r;
  }
  // Refresh tracking (othertv_shows) is kept only in the shadow and authoritative stages.
  const keepsTracking = () => ['shadow', 'authoritative'].includes(app.stage);
  function track(collection, tmdbId, title, network) {
    if (!keepsTracking()) return;
    if (!store.othertv_shows.some(o => o.collection === collection && o.tmdb_id === tmdbId)) {
      store.othertv_shows.push({ id: newId(), tmdb_id: tmdbId, title, network, collection });
    }
  }
  // Enriched (TMDB-matched) built-in shows: later legacy-keyed seasons join them.
  const BUILTIN = ['disney', '90day', 'sheridan'];
  const plainSeason = l => (/^Season [1-9][0-9]{0,3}$/.test(l || '') ? Number(l.slice(7)) : null);
  const enrichedFor = (coll, key) => {
    if (!BUILTIN.includes(coll)) return null;
    const m = shows().filter(s => s.collection === coll && s.show_key === key && s.tmdb_id != null);
    if (m.length > 1) throw new DbError('23000', `integrity_fault: ${m.length} TMDB-matched shows share the key ${key}`);
    return m[0] || null;
  };
  function addToEnriched(show, seasons) {
    const inserted = [], existing = [], rejected = [];
    for (const s of seasons) {
      const n = plainSeason(s.season);
      if (n == null) { rejected.push({ item_key: s.item_key, season: s.season, reason: 'enriched_show_label', show_id: show.id }); continue; }
      const same = items().find(r => r.collection === show.collection && r.item_key === s.item_key);
      if (same) {
        if (same.show_id === show.id && same.media_type === 'tv' && same.tmdb_id === show.tmdb_id && same.season_number === n) existing.push({ season_number: n, item_key: same.item_key, id: same.id });
        else rejected.push({ item_key: s.item_key, season: s.season, reason: 'identity_conflict', conflicting_row_id: same.id });
        continue;
      }
      const held = items().find(r => r.collection === show.collection && r.media_type === 'tv' && r.tmdb_id === show.tmdb_id && r.season_number === n);
      if (held) { rejected.push({ item_key: s.item_key, season: s.season, reason: 'identity_conflict', conflicting_row_id: held.id }); continue; }
      inserted.push(insertRow({ collection: show.collection, item_key: s.item_key, title: s.title, season: s.season, theme: s.theme || '',
        display_date: s.display_date || '', date_sort: s.date_sort, status: s.status || 'confirmed', show_id: show.id, media_type: 'tv', tmdb_id: show.tmdb_id, season_number: n }));
    }
    let reopened = false;
    if (inserted.length && authoritative() && show.status === 'complete') { show.status = 'confirmed'; reopened = true; }
    return { inserted, existing, rejected, reopened };
  }
  const handlers = {
    add_tv_seasons({ p_collection: coll, p_show: show, p_seasons: seasons }) {
      const tmdb = show.tmdb_id ?? null;
      const key = show.show_key || '';
      if (!TV_COLLECTIONS.includes(coll)) throw new DbError('22023', `invalid_input: ${coll} is not a TV collection`);
      if (!String(show.title || '').trim() || !key.trim()) throw new DbError('22023', 'invalid_input: show title and show_key are required');
      if (!Array.isArray(seasons) || !seasons.length) throw new DbError('22023', 'invalid_input: seasons must be a non-empty list');
      const seen = new Set();
      for (const s of seasons) {
        if (!s.item_key || !String(s.title || '').trim() || !String(s.season || '').trim() || !validDate(s.date_sort)) {
          throw new DbError('22023', `invalid_input: season ${JSON.stringify(s)}`);
        }
        let ident;
        if (tmdb != null) {
          const n = s.season_number;
          if (!Number.isInteger(n) || n < 0 || s.season !== seasonLabel(n) || s.item_key !== `${key}|${seasonLabel(n).toLowerCase()}`) {
            throw new DbError('22023', `invalid_input: season ${JSON.stringify(s)} does not match its number and show`);
          }
          ident = String(n);
        } else {
          if (s.season_number != null) throw new DbError('22023', 'invalid_input: a legacy season has no season_number');
          if (s.season === 'Film' || sqlShowKey(coll, s.item_key) !== key) throw new DbError('22023', `invalid_input: season ${s.item_key} does not belong to show ${key}`);
          ident = s.item_key;
        }
        if (seen.has(ident)) throw new DbError('22023', `invalid_input: season ${ident} requested twice`);
        seen.add(ident);
      }
      const enriched = tmdb == null ? enrichedFor(coll, key) : null;
      if (enriched) {
        const r = addToEnriched(enriched, seasons);
        return { show_id: enriched.id, show_created: false, inserted: clone(r.inserted), existing: r.existing, rejected: r.rejected, reopened: r.reopened, show_status: enriched.status };
      }
      const { show: target, created } = lockOrCreateShow(coll, tmdb, key, show.title.trim(), show.initial_status || 'confirmed');
      const inserted = [], existing = [], rejected = [];
      for (const s of seasons) {
        const found = items().find(r => r.collection === coll && (tmdb != null
          ? r.media_type === 'tv' && r.tmdb_id === tmdb && r.season_number === s.season_number
          : r.tmdb_id == null && r.item_key === s.item_key));
        if (found) {
          if (found.show_id != null && found.show_id !== target.id) throw new DbError('23000', 'integrity_fault: season is linked to a different show');
          existing.push({ season_number: s.season_number ?? null, item_key: found.item_key, id: found.id });
          continue;
        }
        const other = items().find(r => r.collection === coll && r.item_key === s.item_key && (tmdb != null ? r.tmdb_id == null : r.tmdb_id != null));
        if (other) {
          rejected.push({ season_number: s.season_number ?? null, item_key: s.item_key,
            reason: tmdb != null ? 'legacy_row_same_key' : 'identified_row_same_key', conflicting_row_id: other.id });
          continue;
        }
        inserted.push(insertRow({ collection: coll, item_key: s.item_key, title: s.title, season: s.season, theme: s.theme || '',
          display_date: s.display_date || '', date_sort: s.date_sort, status: 'confirmed', show_id: target.id,
          ...(tmdb != null ? { media_type: 'tv', tmdb_id: tmdb, season_number: s.season_number } : {}) }));
      }
      let reopened = false;
      if (inserted.length && authoritative() && target.status === 'complete') { target.status = 'confirmed'; reopened = true; }
      if (tmdb != null) track(coll, tmdb, show.title.trim(), show.network || '');
      return { show_id: target.id, show_created: created, inserted: clone(inserted), existing, rejected, reopened, show_status: target.status };
    },
    seed_tv_defaults({ p_collection: coll, p_defaults: defs }) {
      if (!TV_COLLECTIONS.includes(coll)) throw new DbError('22023', `invalid_input: ${coll} is not a TV collection`);
      const keys = new Set();
      for (const d of defs) {
        if (!String(d.k || '').includes('|') || !String(d.t || '').trim() || !String(d.s || '').trim() || !validDate(d.ds)
            || ('p' in d && typeof d.p !== 'boolean')) throw new DbError('22023', `invalid_input: default ${JSON.stringify(d)}`);
        if (keys.has(d.k)) throw new DbError('22023', `invalid_input: default ${d.k} listed twice`);
        keys.add(d.k);
      }
      const missing = d => !items().some(r => r.collection === coll && r.tmdb_id == null && r.item_key === d.k);
      const rowFields = d => ({ collection: coll, item_key: d.k, title: d.t, season: d.s, theme: d.th || '', display_date: d.d || '',
        date_sort: d.ds, status: d.p ? 'pending' : 'confirmed' });
      const inserted = [];
      const reopened = [];
      let showsCreated = 0;
      const groups = new Map();
      for (const d of defs) {
        if (d.s === 'Film') continue;
        const k = sqlShowKey(coll, d.k);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(d);
      }
      const conflicts = [];
      const reopenedIds = [];
      for (const [k, ds] of groups) {
        const enriched = enrichedFor(coll, k);
        if (enriched) {
          const r = addToEnriched(enriched, ds.map(d => ({ item_key: d.k, title: d.t, season: d.s, theme: d.th, display_date: d.d, date_sort: d.ds, status: d.p ? 'pending' : 'confirmed' })));
          inserted.push(...r.inserted); conflicts.push(...r.rejected);
          if (r.reopened) reopenedIds.push(enriched.id);
          continue;
        }
        const todo = ds.filter(missing);
        if (!todo.length) continue;
        const title = (ds.find(d => d.k.split('|')[0] === k) || ds[0]).t;
        const { show, created } = lockOrCreateShow(coll, null, k, title, ds.every(d => d.p === true) ? 'pending' : 'confirmed');
        if (created) showsCreated++;
        for (const d of todo) inserted.push(insertRow({ ...rowFields(d), show_id: show.id }));
        if (!created && authoritative() && show.status === 'complete') { show.status = 'confirmed'; reopened.push(show.id); }
      }
      for (const d of defs) if (d.s === 'Film' && missing(d)) inserted.push(insertRow(rowFields(d)));
      inserted.sort((a, b) => a.date_sort.localeCompare(b.date_sort) || a.item_key.localeCompare(b.item_key));
      return { inserted: clone(inserted), shows_created: showsCreated, reopened: [...reopened, ...reopenedIds], conflicts };
    },
    delete_tv_season({ p_row_id: id }) {
      const r = items().find(x => x.id === id && isTvRow(x));
      if (!r) throw new DbError('P0002', 'not_found: TV season');
      store.watchlist_items = items().filter(x => x.id !== id);
      const show = shows().find(s => s.id === r.show_id);
      let showDeleted = false;
      if (show && !items().some(x => x.show_id === show.id)) {
        shows().splice(shows().indexOf(show), 1);
        org.dropShow(show.id);
        showDeleted = true;
        if (show.tmdb_id != null && keepsTracking()) store.othertv_shows = store.othertv_shows.filter(o => !(o.collection === show.collection && o.tmdb_id === show.tmdb_id));
      }
      return { deleted_row_id: id, show_id: show ? show.id : null, show_deleted: showDeleted };
    },
    match_tv_row({ p_row_id: id, p_target: target, p_patch: patch, p_expansion: expansion }) {
      const tmdb = target.tmdb_id, n = patch.season_number;
      const key = String(patch.title || '').trim().toLowerCase();
      if (!Number.isInteger(tmdb) || !Number.isInteger(n) || n < 0 || !key || patch.media_type !== 'tv' || patch.tmdb_id !== tmdb
          || patch.season !== seasonLabel(n) || patch.item_key !== `${key}|${seasonLabel(n).toLowerCase()}` || !validDate(patch.date_sort)) {
        throw new DbError('22023', `invalid_input: match patch ${JSON.stringify(patch)}`);
      }
      const r = items().find(x => x.id === id && TV_COLLECTIONS.includes(x.collection) && x.tmdb_id == null && x.media_type == null && x.season_number == null);
      if (!r) throw new DbError('P0002', 'not_found: unidentified row');
      const c1 = items().find(x => x.collection === r.collection && x.media_type === 'tv' && x.tmdb_id === tmdb && x.season_number === n);
      if (c1) throw new DbError('23505', `match_conflict: identity already on the list as row ${c1.id}`);
      const c2 = items().find(x => x.collection === r.collection && x.tmdb_id == null && x.item_key === patch.item_key && x.id !== r.id);
      if (c2) throw new DbError('23505', `match_conflict: item_key already used by row ${c2.id}`);
      const legacy = shows().find(s => s.id === r.show_id) || null;
      const t = shows().find(s => s.collection === r.collection && s.tmdb_id === tmdb);
      if (t && legacy && authoritative() && t.status !== legacy.status) {
        return { blocked: true, legacy_status: legacy.status, target_status: t.status, legacy_show_id: legacy.id, target_show_id: t.id };
      }
      // Personal collections (db/phase3b_org.sql): the row's collections move with it,
      // and a show joining new collections needs a matching confirmation.
      const visible = org.enabled ? (org.isFilm(r) ? org.collectionsOfItem(r.id) : legacy ? org.collectionsOfShow(legacy.id) : []) : [];
      if (t && org.enabled) {
        const extra = visible.filter(c => !org.collectionsOfShow(t.id).includes(c)).sort();
        if (extra.length) {
          const seasonIds = items().filter(x => x.show_id === t.id).map(x => x.id).sort();
          const token = `${t.id}|${extra.join(',')}|${seasonIds.join(',')}`;
          if (expansion == null) throw new DbError('P0001', `match_needs_confirmation: matching this row would also show all ${seasonIds.length} stored seasons of "${t.title}" in ${extra.map(org.collectionName).join(', ')}. This page can't confirm that; reload it and match again. Nothing was changed.`);
          if (expansion.confirm !== token) {
            return { blocked: true, reason: 'membership_expansion', target_show_id: t.id, show_title: t.title, seasons: seasonIds.length,
              collections: extra.map(c => ({ id: c, name: org.collectionName(c) })), confirmation: token, changed: expansion.confirm != null };
          }
        }
      }
      let targetId;
      let created = false;
      if (t) targetId = t.id;
      else if (legacy && !items().some(x => x.show_id === legacy.id && x.id !== r.id)) {
        Object.assign(legacy, { tmdb_id: tmdb, title: patch.title.trim(), show_key: key });
        targetId = legacy.id;
      } else {
        targetId = newId();
        created = true;
        shows().push({ id: targetId, collection: r.collection, title: patch.title.trim(), show_key: key, tmdb_id: tmdb, status: legacy ? legacy.status : 'confirmed' });
      }
      if (org.enabled && (!legacy || targetId !== legacy.id)) {
        if (created) org.dropShow(targetId);
        visible.forEach(c => org.add(c, { show_id: targetId }));
      }
      if (org.enabled && org.isFilm(r)) org.dropItem(r.id);
      Object.assign(r, { title: patch.title, season: patch.season, item_key: patch.item_key, theme: patch.theme ?? r.theme,
        display_date: patch.display_date ?? r.display_date, date_sort: patch.date_sort, media_type: 'tv', tmdb_id: tmdb, season_number: n, show_id: targetId });
      if (legacy && legacy.id !== targetId && !items().some(x => x.show_id === legacy.id)) { shows().splice(shows().indexOf(legacy), 1); org.dropShow(legacy.id); }
      track(r.collection, tmdb, patch.title.trim(), target.network ?? patch.theme ?? '');
      return { blocked: false, row: clone(r), show_id: targetId };
    },
    set_show_status({ p_show_id: id, p_status: status }) {
      requireAuthoritative('set_show_status');
      if (!TV_STATUSES.includes(status)) throw new DbError('22023', `invalid_input: status ${status}`);
      const show = shows().find(s => s.id === id);
      if (!show) throw new DbError('P0002', 'not_found: show');
      show.status = status;
      return clone(show);
    },
    set_season_watched({ p_row_id: id, p_watched: watched }) {
      requireAuthoritative('set_season_watched');
      if (typeof watched !== 'boolean') throw new DbError('22023', 'invalid_input: watched');
      const r = items().find(x => x.id === id && x.show_id != null);
      if (!r) throw new DbError('P0002', 'not_found: TV season');
      r.watched = watched;
      return clone(r);
    },
    set_season_skipped({ p_row_id: id, p_skipped: skipped }) {
      requireAuthoritative('set_season_skipped');
      if (typeof skipped !== 'boolean') throw new DbError('22023', 'invalid_input: skipped');
      const r = items().find(x => x.id === id && x.show_id != null);
      if (!r) throw new DbError('P0002', 'not_found: TV season');
      r.skipped = skipped;
      return clone(r);
    }
  };
  return Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, body => {
    try { return response(200, fn(body)); }
    catch (e) {
      if (!(e instanceof DbError)) throw e;
      return response(HTTP_FOR[e.code] || 400, { code: e.code, details: null, hint: null, message: e.message });
    }
  }]));
}

const NO_ORG = { enabled: false, newShow() {}, newItem() {}, dropShow() {}, dropItem() {}, isFilm: () => false,
  collectionsOfItem: () => [], collectionsOfShow: () => [], add() {}, collectionName: c => c };
const LEGACY_SOURCES = [['disney', 'Disney+'], ['sheridan', 'Sheridan'], ['90day', '90 Day'], ['truecrime', 'True Crime / Docs']];
const CONFIG_WATCH_WITH = ['Alone', 'Suzanne', 'Rina', 'Whole Family']; // WATCH_WITH_OPTIONS (tests/organization.test.js keeps them equal)
const isFilmRow = r => r.media_type === 'movie' || (r.media_type == null && r.season === 'Film');

// options:
//   org:     false for a database without personal collections (before Stage 3b-1);
//            otherwise personal_collections, collection_memberships and
//            watch_with_choices exist, bootstrapped like db/phase3b_org.sql
//            (fixed uuids; app.browseId(source) names a view) unless given as personalCollections / memberships /
//            watchWithChoices, and the database behaves like it: the membership
//            trigger, cascades, Match keeping memberships, watch-with checks,
//            is_film on reads, format 3 only in restore_backup
//   rows:    initial watchlist_items rows (the fake database)
//   tmdb:    path => response body for TMDB requests (default: 404)
//   width:   window.innerWidth (default 1200)
//   countOverride: total reported in Content-Range (simulates a count mismatch)
//   tvShows: tv_shows rows (the fake database has the TV-show schema, backup
//            format 2); TV rows given without show_id are linked to shows as the
//            Phase 1c backfill would (see linkFixtureRows)
//   format1: true for a database without the TV-show schema (no tv_shows)
//   stage:   migration stage the TV functions behave by (default 'final')
async function createApp({ rows = [], othertvShows = [], tvShows = [], customCollections = [], tmdb, width = 1200, countOverride = null,
  format1 = false, stage = 'final', org = true, personalCollections = null, memberships = null, watchWithChoices = null, storage = null } = {}) {
  const store = { watchlist_items: clone(rows), othertv_shows: clone(othertvShows), custom_collections: clone(customCollections) };
  if (!format1) store.tv_shows = clone(tvShows || []);
  const requests = [];
  const gates = [];
  const failures = [];
  const consoleErrors = [];
  const selectors = {};
  let nextId = 1;
  const app = { store, requests, selectors, consoleErrors, countOverride, stage };
  if (store.tv_shows) linkFixtureRows(store, () => `new-${nextId++}`);

  // ── personal organization (db/phase3b_org.sql) ──
  const orgOn = !format1 && org !== false;
  const ORG = { ...NO_ORG };
  if (orgOn) {
    const ts = '2026-10-06T00:00:00+00:00';
    store.personal_collections = personalCollections ? clone(personalCollections)
      : LEGACY_SOURCES.map(([src, name], i) => ({ id: `0c000000-0000-4000-8000-00000000000${i + 1}`, name, legacy_source: src, sort_order: i + 1, archived_at: null, created_at: ts }));
    const used = [...new Set(store.watchlist_items.flatMap(r => r.watch_with || []))].filter(t => !CONFIG_WATCH_WITH.includes(t)).sort();
    store.watch_with_choices = watchWithChoices ? clone(watchWithChoices)
      : CONFIG_WATCH_WITH.concat(used).map((t, i) => ({ id: `0e000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, token: t, label: t, sort_order: i + 1, archived_at: null, created_at: ts }));
    const mapped = coll => (store.personal_collections.find(c => c.legacy_source === coll) || {}).id || null;
    if (memberships) store.collection_memberships = clone(memberships);
    else {
      store.collection_memberships = [];
      let n = 1;
      store.tv_shows.forEach(sh => { const c = mapped(sh.collection); if (c) store.collection_memberships.push({ id: `0d000000-0000-4000-8000-${String(n++).padStart(12, '0')}`, collection_id: c, show_id: sh.id, item_id: null, created_at: ts }); });
      store.watchlist_items.forEach(r => { const c = mapped(r.collection); if (c && isFilmRow(r)) store.collection_memberships.push({ id: `0d000000-0000-4000-8000-${String(n++).padStart(12, '0')}`, collection_id: c, show_id: null, item_id: r.id, created_at: ts }); });
    }
    const M = () => store.collection_memberships;
    Object.assign(ORG, {
      enabled: true,
      isFilm: isFilmRow,
      collectionName: id => (store.personal_collections.find(c => c.id === id) || {}).name || id,
      collectionsOfShow: id => M().filter(m => m.show_id === id).map(m => m.collection_id),
      collectionsOfItem: id => M().filter(m => m.item_id === id).map(m => m.collection_id),
      add(collectionId, target) {
        const key = target.show_id != null ? 'show_id' : 'item_id';
        if (M().some(m => m.collection_id === collectionId && m[key] === target[key])) return;
        M().push({ id: `new-${nextId++}`, collection_id: collectionId, show_id: target.show_id ?? null, item_id: target.item_id ?? null, created_at: new Date().toISOString() });
      },
      newShow(sh) { const c = mapped(sh.collection); if (c) ORG.add(c, { show_id: sh.id }); },
      newItem(r) { const c = mapped(r.collection); if (c && isFilmRow(r)) ORG.add(c, { item_id: r.id }); },
      dropShow(id) { store.collection_memberships = M().filter(m => m.show_id !== id); },
      dropItem(id) { store.collection_memberships = M().filter(m => m.item_id !== id); }
    });
  }
  // Row-level database rules the API would enforce with personal collections.
  const pgError = (status, code, message) => response(status, { code, details: null, hint: null, message });
  const writeProblem = (table, list) => {
    if (!orgOn || table !== 'watchlist_items') return null;
    if (list.some(b => b && 'is_film' in b)) return pgError(400, '428C9', 'cannot insert a non-DEFAULT value into column "is_film"');
    if (list.some(b => b && Array.isArray(b.watch_with) && b.watch_with.some(t => t == null))) return pgError(400, '23514', 'watch_with_invalid: a watch-with value is empty');
    const tokens = new Set(store.watch_with_choices.map(c => c.token));
    const bad = list.flatMap(b => (b && b.watch_with) || []).find(t => !tokens.has(t));
    if (bad !== undefined) return pgError(400, '23514', `watch_with_invalid: "${bad}" is not one of your watch-with choices`);
    return null;
  };
  app.browseId = source => `browse:${store.personal_collections.find(c => c.legacy_source === source).id}`;

  // ── fake DOM ──
  const registry = new Map();
  const children = new Map(); // container id -> ids created by its last innerHTML
  function makeEl(id) {
    const classes = new Set();
    let html = '';
    const el = {
      id, tagName: 'DIV', value: '', textContent: '', style: {}, dataset: {}, options: [],
      classList: {
        add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: c => (classes.has(c) ? classes.delete(c) : classes.add(c))
      },
      scrollIntoView() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      remove() {}, appendChild() {}, insertAdjacentElement() {},
      get innerHTML() { return html; },
      set innerHTML(v) {
        html = v;
        if (!id) return;
        // Replacing a container's markup drops the elements it held and creates the ones it now holds.
        (children.get(id) || []).forEach(c => registry.delete(c));
        const ids = [...String(v).matchAll(/id="([^"]+)"/g)].map(m => m[1]);
        ids.forEach(c => registry.set(c, makeEl(c)));
        children.set(id, ids);
      }
    };
    return el;
  }
  PAGE_IDS.forEach(id => registry.set(id, makeEl(id)));
  const document = {
    getElementById: id => registry.get(id) || null,
    querySelectorAll: sel => selectors[sel] || [],
    querySelector: () => null,
    createElement: () => makeEl(null),
    addEventListener() {}
  };
  app.el = id => registry.get(id) || null;
  app.addEl = (id, props = {}) => { const e = Object.assign(makeEl(id), props); registry.set(id, e); return e; };
  app.removeEl = id => registry.delete(id);

  // ── fake network ──
  // hold(pred) pauses the first matching request until release()/fail() is called.
  app.hold = pred => {
    const g = { pred, hit: false };
    g.gate = new Promise(r => { g.release = () => r('ok'); g.fail = () => r('fail'); });
    g.reached = new Promise(r => { g.onHit = r; });
    gates.push(g);
    return g;
  };
  // failNext(pred) makes the next matching request return HTTP 500.
  app.failNext = pred => failures.push(pred);
  // Database functions called as POST rpc/<name>. restore_backup replaces every
  // table with the backup's rows in one step, as the real function does.
  app.rpcHandlers = {
    restore_backup: body => {
      if (orgOn && body.p_backup.formatVersion !== 3) {
        return pgError(400, '22023', `restore_invalid: format ${body.p_backup.formatVersion} backups ${body.p_backup.formatVersion === 2 ? 'predate personal collections' : 'predate TV shows'} and can't be restored here`);
      }
      const tables = body.p_backup.tables;
      for (const t of Object.keys(tables)) store[t] = clone(tables[t]);
      return response(200, { restored: Object.fromEntries(Object.keys(tables).map(t => [t, tables[t].length])) });
    },
    ...tvFunctions(app, store, () => `new-${nextId++}`, ORG)
  };

  async function fetchStub(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    const req = { method, url, body, headers: opts.headers || {} };
    requests.push(req);
    const g = gates.find(x => !x.hit && x.pred(req));
    let forceFail = false;
    if (g) { g.hit = true; g.onHit(req); forceFail = (await g.gate) === 'fail'; }
    const fi = failures.findIndex(p => p(req));
    if (fi !== -1) { failures.splice(fi, 1); forceFail = true; }
    if (forceFail) return response(500, { message: 'simulated failure' });

    const TMDB_BASE = vm.runInContext('TMDB_BASE', ctx), SUPABASE_URL = vm.runInContext('SUPABASE_URL', ctx);
    if (url.startsWith(TMDB_BASE)) {
      const p = url.slice(TMDB_BASE.length);
      const out = tmdb ? tmdb(p) : undefined;
      return out === undefined ? response(404, { status_message: 'not found' }) : response(200, out);
    }
    const prefix = `${SUPABASE_URL}/rest/v1/`;
    if (!url.startsWith(prefix)) throw new Error(`harness: refused request to ${url}`);
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    const params = [...u.searchParams.entries()];
    if (u.pathname.includes('/rpc/')) {
      const handler = app.rpcHandlers[table];
      if (!handler) throw new Error(`harness: unknown rpc ${table}`);
      return handler(body);
    }
    const rowsOf = store[table];
    // Like PostgREST: a table that doesn't exist answers 404 PGRST205.
    if (!rowsOf) return response(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });

    if (method === 'GET') {
      let found = rowsOf.filter(r => matches(r, params));
      if (orgOn && table === 'watchlist_items') found = found.map(r => ({ ...r, is_film: isFilmRow(r) })); // generated column
      const select = u.searchParams.get('select');
      if (select && select !== '*' && select !== 'id') {
        const cols = select.split(',');
        found = found.map(r => Object.fromEntries(cols.map(c => [c, r[c] === undefined ? null : r[c]])));
      }
      const limit = Number(u.searchParams.get('limit'));
      if (limit) found = found.slice(0, limit);
      const range = req.headers.Range;
      if (range) {
        found = found.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const [from, to] = range.split('-').map(Number);
        const page = found.slice(from, to + 1);
        const total = app.countOverride ?? found.length;
        const cr = page.length ? `${from}-${from + page.length - 1}/${total}` : `*/${total}`;
        return response(206, clone(page), { 'content-range': cr });
      }
      return response(200, clone(found));
    }
    if (method === 'POST') {
      const problem = writeProblem(table, body);
      if (problem) return problem;
      const inserted = body.map(r => ({ id: `new-${nextId++}`, ...r }));
      rowsOf.push(...clone(inserted));
      if (table === 'tv_shows') inserted.forEach(r => ORG.newShow(r));
      if (table === 'watchlist_items') inserted.forEach(r => ORG.newItem(r));
      return response(201, orgOn && table === 'watchlist_items' ? inserted.map(r => ({ ...r, is_film: isFilmRow(r) })) : inserted);
    }
    if (method === 'PATCH') {
      const problem = writeProblem(table, [body]);
      if (problem) return problem;
      const targets = rowsOf.filter(r => matches(r, params));
      if (orgOn && table === 'watchlist_items') {
        for (const r of targets) {
          const after = { ...r, ...body };
          if (isFilmRow(r) && !isFilmRow(after) && ORG.collectionsOfItem(r.id).length) {
            return pgError(409, '23503', 'update or delete on table "watchlist_items" violates foreign key constraint "collection_memberships_item_fkey"');
          }
        }
      }
      targets.forEach(r => {
        const before = { ...r };
        Object.assign(r, clone(body));
        // The trigger: a TV season matched as a film keeps its show's collections.
        if (orgOn && table === 'watchlist_items' && before.show_id != null && r.show_id == null && isFilmRow(r)) {
          ORG.collectionsOfShow(before.show_id).forEach(c => ORG.add(c, { item_id: r.id }));
        }
      });
      return response(204, null);
    }
    if (method === 'DELETE') {
      const gone = rowsOf.filter(r => matches(r, params));
      // ON DELETE RESTRICT: a show that still has seasons can't be deleted.
      // A watch-with choice still used on a row can't be deleted (db/phase3b_org.sql).
      const used = orgOn && table === 'watch_with_choices' && gone.find(c => store.watchlist_items.some(r => (r.watch_with || []).includes(c.token)));
      if (used) return pgError(409, '23503', `watch_with_in_use: "${used.token}" is still used on saved items; remove it from them first`);
      if (table === 'tv_shows' && gone.some(sh => store.watchlist_items.some(r => r.show_id === sh.id))) {
        return pgError(409, '23001', 'update or delete on table "tv_shows" violates RESTRICT setting of foreign key constraint "watchlist_items_show_fkey" on table "watchlist_items"');
      }
      store[table] = rowsOf.filter(r => !matches(r, params));
      if (table === 'tv_shows') gone.forEach(sh => ORG.dropShow(sh.id));
      if (table === 'watchlist_items') gone.forEach(r => ORG.dropItem(r.id));
      return response(204, null);
    }
    throw new Error(`harness: unsupported ${method}`);
  }

  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => consoleErrors.push(a.map(String).join(' ')) },
    document,
    fetch: fetchStub,
    localStorage: storage || { getItem: () => null, setItem() {}, removeItem() {} },
    confirm: () => true,
    alert() {},
    setTimeout: () => 0,
    innerWidth: width,
    matchMedia: () => ({ matches: false })
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of SCRIPT_FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  app.ctx = ctx;
  app.get = expr => vm.runInContext(expr, ctx);
  app.run = code => vm.runInContext(code, ctx);
  vm.runInContext(INLINE_SCRIPT, ctx, { filename: 'watchlist.html' }); // state + boot
  await settle();

  app.writes = () => requests.filter(r => r.method !== 'GET');
  app.html = () => registry.get('tbody').innerHTML + '\n' + registry.get('cardList').innerHTML;
  return app;
}

// A small test runner that reports "N/N passed" like the other test files.
function runner(title) {
  const tests = [];
  const unhandled = [];
  process.on('unhandledRejection', e => unhandled.push(e));
  return {
    test: (name, fn) => tests.push({ name, fn }),
    async run() {
      let passed = 0;
      for (const t of tests) {
        unhandled.length = 0;
        try {
          await t.fn();
          await settle();
          if (unhandled.length) throw unhandled[0];
          passed++;
          console.log(`  ok   ${t.name}`);
        } catch (e) {
          console.log(`  FAIL ${t.name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e}`);
        }
      }
      console.log(`${title}: ${passed}/${tests.length} passed`);
      if (passed !== tests.length) process.exitCode = 1;
    }
  };
}

module.exports = { createApp, runner, settle, clone };
