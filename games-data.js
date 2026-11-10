// ─── Games: IGDB data and the rules (G1, next-gen item 5) ──────────────────────
// Pure rules over IGDB records as this member's cache holds them (public.game_titles), with the member's saved games
// (game_entries), decisions (game_decisions) and settings (game_settings). Nothing here writes; games.js draws and saves.
//
// Release evidence (the owner's rule, 2026-11-10): a qualifying release row (status Full Release, or none) with a full date
// on a selected platform makes the game playable on that date, labelled with its basis ("PS5 · Oct 23, 2026 · per IGDB").
// A month, quarter, year or TBA never becomes playable by its period ending: it stays under Coming until a full date or
// title-specific Store or publisher evidence (an Available decision) says otherwise. Betas, early and advanced access,
// optimization patches, compatibility listings, cancellations and offline rows never count as a native release. With PS5
// selected, a released PS4 game counts as playable on PS5 unless it is on Sony's published PS4-only list ("PS4 · Playable on
// PS5", with the PS4 date). A member's Not out yet holds that one platform release out of their Up next while IGDB's row is
// unchanged; a changed row (a corrected date) ends the hold by itself.

// The platforms a member can choose (game_settings.platforms), with IGDB's platform ids.
const GAME_PLATFORMS = [
  { key: 'ps5', label: 'PS5', igdb: 167 }, { key: 'ps4', label: 'PS4', igdb: 48 }, { key: 'switch2', label: 'Switch 2', igdb: 508 },
  { key: 'switch', label: 'Switch', igdb: 130 }, { key: 'xbox_series', label: 'Xbox Series X|S', igdb: 169 }, { key: 'xbox_one', label: 'Xbox One', igdb: 49 },
  { key: 'pc', label: 'PC', igdb: 6 }];
const GAME_PLATFORM_BY_IGDB = new Map(GAME_PLATFORMS.map(p => [p.igdb, p]));
const GAME_PLATFORM_LABEL = Object.fromEntries(GAME_PLATFORMS.map(p => [p.key, p.label]));
// Sony's published list of PS4 games that don't play on PS5 (playstation.com, "Backward compatibility", checked 2026-11-10).
// Titles only; a title-specific decision (Not out yet, Available) always wins over this list. Re-check it with the research brief.
const PS4_ONLY_TITLES = ['Afro Samurai 2: Revenge of Kuma Volume One', 'Just Deal With It!', 'Robinson: The Journey', 'We Sing',
  'Hitman Go: Definitive Edition', 'Shadwen'];
const PS4_ONLY_CHECKED = '2026-11-10';
// IGDB's references (their lookup tables' ids, read 2026-11-10 with tools/igdb-feasibility.mjs).
const IGDB_GAME_TYPES = { 0: 'main', 1: 'dlc', 2: 'expansion', 3: 'bundle', 4: 'standalone', 5: 'mod', 6: 'episode', 7: 'season', 8: 'remake', 9: 'remaster',
  10: 'expanded', 11: 'port', 12: 'fork', 13: 'pack', 14: 'update' };
const IGDB_RELEASE_STATUS = { 6: 'full', 1: 'alpha', 2: 'beta', 3: 'early', 4: 'offline', 5: 'cancelled', 34: 'advanced', 35: 'compat', 36: 'patch' };
const IGDB_DATE_FORMAT = { 0: 'day', 1: 'month', 2: 'year', 3: 'quarter', 4: 'quarter', 5: 'quarter', 6: 'quarter', 7: 'tbd' };
const IGDB_REGIONS = { 1: 'Europe', 2: 'North America', 3: 'Australia', 4: 'New Zealand', 5: 'Japan', 6: 'China', 7: 'Asia', 8: 'Worldwide', 9: 'Korea', 10: 'Brazil' };
const IGDB_MEMBERSHIP = { 1: 'member', 2: 'spinoff' };
const IGDB_GAME_STATUS = { 0: 'released', 2: 'alpha', 3: 'beta', 4: 'early', 5: 'offline', 6: 'cancelled', 7: 'rumored', 8: 'delisted' };
const GAME_SKIP_TYPES = ['dlc', 'expansion', 'bundle', 'mod', 'episode', 'season', 'fork', 'pack', 'update'];
const GAME_VERSION_TYPES = ['remake', 'remaster', 'port'];
const GAME_STATUS_LABELS = { want: 'Want to play', playing: 'Playing', paused: 'Paused', finished: 'Finished', skipped: 'Skipped' };
const GAME_STYLE_LABELS = { main: 'Main story', main_extra: 'Main story + side content', completionist: 'Completionist' };
// The length rule: a value above its style's cap, or out of order with a neighbouring style (by more than 10%), is unreliable.
const GAME_LENGTH_CAPS = { main: 200, main_extra: 400, completionist: 1000 };

// ── IGDB records → the cache's shape ──
// What games.js asks IGDB for, per record (every reference as an id, to keep the answer small).
const IGDB_GAME_FIELDS = 'id,name,slug,game_type,game_status,first_release_date,parent_game,version_parent,ports,remasters,remakes,' +
  'collections.name,franchises.name,genres.name,aggregated_rating,aggregated_rating_count,rating,rating_count,' +
  'external_games.external_game_source,external_games.url,release_dates.platform,release_dates.date,release_dates.y,release_dates.m,' +
  'release_dates.date_format,release_dates.status,release_dates.release_region';
const isoDay = t => new Date(t * 1000).toISOString().slice(0, 10);
const idsOf = v => (Array.isArray(v) ? v.map(x => (x && typeof x === 'object' ? x.id : x)).filter(x => Number.isInteger(x)) : []);
function igdbReleaseRow(rd) {
  const plat = GAME_PLATFORM_BY_IGDB.get(typeof rd.platform === 'object' ? rd.platform && rd.platform.id : rd.platform);
  if (!plat) return null;
  const fmt = typeof rd.date_format === 'object' ? rd.date_format && rd.date_format.id : rd.date_format;
  let prec = IGDB_DATE_FORMAT[fmt] || (rd.date ? 'day' : 'tbd');
  const st = typeof rd.status === 'object' ? rd.status && rd.status.id : rd.status;
  const reg = typeof rd.release_region === 'object' ? rd.release_region && rd.release_region.id : rd.release_region;
  const row = { p: plat.key, prec, s: st == null ? 'none' : IGDB_RELEASE_STATUS[st] || 'other', r: reg == null ? null : reg };
  if (prec === 'day' && rd.date) row.d = isoDay(rd.date);
  else if (prec === 'day') row.prec = prec = 'tbd';
  if (prec === 'month' || prec === 'year' || prec === 'quarter') row.y = Number(rd.y) || (rd.date ? Number(isoDay(rd.date).slice(0, 4)) : null);
  if (prec === 'month') row.m = Number(rd.m) || (rd.date ? Number(isoDay(rd.date).slice(5, 7)) : null);
  if (prec === 'quarter') row.q = fmt - 2;
  if ((prec === 'month' || prec === 'year' || prec === 'quarter') && !row.y) row.prec = 'tbd';
  return row;
}
// One IGDB game as the cache keeps it (time to beat and memberships are merged in by games.js).
function igdbRecord(g, extra = {}) {
  const ext = Array.isArray(g.external_games) ? g.external_games : [];
  const ps = ext.find(e => (e.external_game_source === 36 || (e.external_game_source && e.external_game_source.id === 36)) && typeof e.url === 'string');
  return {
    v: 1, id: g.id, name: String(g.name || '').trim() || `IGDB ${g.id}`, slug: g.slug || null,
    type: IGDB_GAME_TYPES[typeof g.game_type === 'object' ? g.game_type && g.game_type.id : g.game_type] || 'main',
    status: IGDB_GAME_STATUS[typeof g.game_status === 'object' ? g.game_status && g.game_status.id : g.game_status] || null,
    first: Number.isFinite(g.first_release_date) ? isoDay(g.first_release_date) : null,
    parent: idsOf([g.parent_game])[0] || null, versionParent: idsOf([g.version_parent])[0] || null,
    ports: idsOf(g.ports), remasters: idsOf(g.remasters), remakes: idsOf(g.remakes),
    collections: (g.collections || []).filter(c => c && c.id).map(c => ({ id: c.id, name: String(c.name || '') })),
    franchises: (g.franchises || []).filter(c => c && c.id).map(c => ({ id: c.id, name: String(c.name || '') })),
    genres: (g.genres || []).map(x => String(x && x.name || '')).filter(Boolean),
    critic: Number.isFinite(g.aggregated_rating) ? { score: Math.round(g.aggregated_rating), count: g.aggregated_rating_count || 0 } : null,
    player: Number.isFinite(g.rating) ? { score: Math.round(g.rating), count: g.rating_count || 0 } : null,
    releases: (g.release_dates || []).map(igdbReleaseRow).filter(Boolean),
    store: ps ? ps.url : null, m: {}, hours: null, ...extra
  };
}
function igdbHours(t) {
  const h = s => (Number.isFinite(s) && s > 0 ? Math.round(s / 360) / 10 : null);
  return t ? { main: h(t.hastily), main_extra: h(t.normally), completionist: h(t.completely), count: t.count || 0 } : null;
}

// ── Dates ──
const GAME_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function gameDateText(row) {
  if (!row) return 'Date TBA';
  if (row.prec === 'day' && row.d) { const [y, m, d] = row.d.split('-').map(Number); return `${GAME_MONTHS[m - 1]} ${d}, ${y}`; }
  if (row.prec === 'month' && row.m) return `${GAME_MONTHS[row.m - 1]} ${row.y}`;
  if (row.prec === 'quarter' && row.q) return `Q${row.q} ${row.y}`;
  if (row.prec === 'year' && row.y) return String(row.y);
  return 'Date TBA';
}
// A sortable key for a date at its precision: the start of its period; TBA last.
function gameDateKey(row) {
  if (!row) return '9999-12-31';
  if (row.prec === 'day' && row.d) return row.d;
  if (row.prec === 'month' && row.m) return `${row.y}-${String(row.m).padStart(2, '0')}-01`;
  if (row.prec === 'quarter' && row.q) return `${row.y}-${String(row.q * 3 - 2).padStart(2, '0')}-01`;
  if (row.prec === 'year' && row.y) return `${row.y}-01-01`;
  return '9999-12-31';
}
const normalTitle = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const PS4_ONLY_SET = new Set(PS4_ONLY_TITLES.map(normalTitle));
function onPs4OnlyList(rec) { return !!rec && PS4_ONLY_SET.has(normalTitle(rec.name)); }

// ── Availability of one record on the selected platforms ──
// rows: { rec, row } for a version and its joined ports. Returns { playable, line, coming, released, hiddenByPlatforms }.
// line: what the row shows ({ platform, date, basis, compat, released }); coming: upcoming releases on selected platforms.
const qualifies = row => row.s === 'full' || row.s === 'none';
const inRegion = row => row.r == null || row.r === 2 || row.r === 8;
function gameDecisionKey(kind, igdbId, platform = '') { return `${kind}|${igdbId}|${platform}`; }
function heldOut(decisions, rec, platform, row) {
  const d = decisions.get(gameDecisionKey('not_out_yet', rec.id, platform));
  return !!d && d.value && d.value.date === gameDateKey(row) && d.value.precision === row.prec;
}
function gameAvailability(records, ctx) {
  const selected = ctx.platforms; // [] or null: nothing chosen yet (everything shows)
  const today = ctx.today;
  const out = { playable: false, line: null, coming: [], released: [], unknown: !records.length };
  if (!records.length) return out;
  const cands = [];
  for (const rec of records) {
    const byPlat = new Map();
    for (const row of rec.releases || []) {
      if (!qualifies(row)) continue;
      (byPlat.get(row.p) || byPlat.set(row.p, []).get(row.p)).push(row);
    }
    for (const [p, rowsAll] of byPlat) {
      const rows = rowsAll.some(inRegion) ? rowsAll.filter(inRegion) : rowsAll; // a region-only game: its own rows, labelled
      const native = !selected || !selected.length || selected.includes(p);
      const compat = !native && p === 'ps4' && selected && selected.includes('ps5') && !onPs4OnlyList(rec);
      if (!native && !compat) continue;
      const platform = native ? p : 'ps5';
      rows.forEach(row => cands.push({ rec, row, platform, native, from: p }));
    }
    // Title-specific Store or publisher evidence (research): available, at the precision it gives.
    for (const p of (selected && selected.length ? selected : [])) {
      const d = ctx.decisions.get(gameDecisionKey('available', rec.id, p));
      if (d) cands.push({ rec, row: { p, prec: d.value.precision || 'tbd', d: d.value.date, y: d.value.year, m: d.value.month, q: d.value.quarter, s: 'full' }, platform: p, native: true, from: p, evidence: d });
    }
  }
  for (const c of cands) {
    const held = !c.evidence && heldOut(ctx.decisions, c.rec, c.platform, c.row);
    c.held = held;
    c.isReleased = !held && (c.evidence ? true : c.row.prec === 'day' && !!c.row.d && c.row.d <= today);
    c.key = gameDateKey(c.row);
    (c.isReleased ? out.released : out.coming).push(c);
  }
  const byDate = (a, b) => (a.native === b.native ? 0 : a.native ? -1 : 1) || cmpStrGame(a.key, b.key);
  out.released.sort(byDate);
  out.coming.sort((a, b) => cmpStrGame(a.key, b.key) || (a.native === b.native ? 0 : a.native ? -1 : 1));
  out.playable = out.released.length > 0;
  out.line = out.released[0] || out.coming.find(c => c.native) || out.coming[0] || null;
  out.hiddenByPlatforms = !!(selected && selected.length) && !cands.length;
  return out;
}
const cmpStrGame = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// "PS5 · Oct 23, 2026 · per IGDB", "PS4 · Playable on PS5 · Nov 3, 2017", "PS5 · Date TBA", "PS5 · Mar 2027 · Store or publisher".
function gameLineText(c) {
  if (!c) return '';
  const from = GAME_PLATFORM_LABEL[c.from] || c.from;
  const region = c.row.r != null && c.row.r !== 2 && c.row.r !== 8 ? ` (${IGDB_REGIONS[c.row.r] || 'another region'})` : '';
  const head = c.native ? from : `${from} · Playable on PS5`;
  const basis = c.evidence ? 'Store or publisher' : c.held ? 'not out yet (your hold)' : c.row.prec === 'day' ? 'per IGDB' : '';
  return [head, gameDateText(c.row) + region, basis].filter(Boolean).join(' · ');
}

// ── Versions and franchise spots ──
// The original a version counts for: a remake, remaster or port counts for its parent's spot (followed up the chain).
function gameAnchor(rec, cache, seen = new Set()) {
  if (!rec || seen.has(rec.id)) return rec ? rec.id : null;
  seen.add(rec.id);
  if (GAME_VERSION_TYPES.includes(rec.type) && rec.parent && cache.get(rec.parent)) return gameAnchor(cache.get(rec.parent), cache, seen);
  return rec.id;
}
// A chain that isn't a plain one: a remake or remaster whose parent is itself a port (IGDB's Resident Evil 4 HD is a
// "remaster" of the Wii port). Whether it is the same personal game as a saved original is the member's review.
function gameAmbiguousChain(rec, cache) {
  if (!rec || !['remake', 'remaster'].includes(rec.type) || !rec.parent) return false;
  const p = cache.get(rec.parent);
  return !!p && p.type === 'port';
}
// The ports a saved version takes automatically: IGDB's ports of its record that IGDB types as ports with that parent.
function gamePlainPorts(rec, cache) {
  return (rec ? rec.ports : []).filter(id => { const p = cache.get(id); return !p || (p.type === 'port' && (p.parent == null || p.parent === rec.id)); });
}

// A followed franchise's spots, in original release order, with the member's progress. follow: { igdb_collection_id };
// state: { cache: Map(id → rec), entries: [game_entries], decisions: Map, platforms, today }.
function franchiseSpots(follow, state) {
  const cache = state.cache, cid = follow.igdb_collection_id;
  const members = [...cache.values()].filter(r => r.m && r.m[cid]);
  const savedBy = new Map();
  state.entries.forEach(e => { savedBy.set(e.igdb_id, e); (e.port_ids || []).forEach(p => savedBy.set(p, e)); });
  const spots = new Map();
  const consider = new Set(members.map(r => r.id));
  members.forEach(r => [...r.remakes, ...r.remasters, ...r.ports].forEach(id => { if (cache.get(id)) consider.add(id); }));
  state.entries.forEach(e => { if (cache.get(e.igdb_id) && (consider.has(e.spot_igdb_id) || [...consider].some(id => gameAnchor(cache.get(id), cache) === e.spot_igdb_id))) consider.add(e.igdb_id); });
  // A plain port belongs to the version it ports (shown with it, never as a version of its own).
  const portOf = new Set();
  for (const id of consider) { const r = cache.get(id); if (r && r.type !== 'port') gamePlainPorts(r, cache).forEach(p => portOf.add(p)); }
  for (const id of consider) {
    const rec = cache.get(id);
    if (!rec || GAME_SKIP_TYPES.includes(rec.type) || rec.versionParent) continue; // DLC, bundles, seasons, editions…
    if (portOf.has(rec.id) && !savedBy.has(rec.id)) continue;
    const entry = savedBy.get(rec.id);
    if (entry && entry.igdb_id !== rec.id) continue; // a port joined to a saved game: part of that version
    // An unsaved version follows a research finding about its relationship, else IGDB; a saved one keeps its stored spot.
    const link = !entry && state.decisions.get(gameDecisionKey('research_link', rec.id));
    const anchorId = entry ? entry.spot_igdb_id : link ? (link.value.relation === 'own_spot' ? rec.id : cache.get(link.value.target_igdb_id) ? gameAnchor(cache.get(link.value.target_igdb_id), cache) : link.value.target_igdb_id) : gameAnchor(rec, cache);
    const anchor = cache.get(anchorId) || rec;
    if (!spots.has(anchorId)) {
      const role = (anchor.m && anchor.m[cid]) || (rec.m && rec.m[cid]) || 'member';
      const spinoff = role === 'spinoff' || anchor.type === 'standalone' || anchor.type === 'expanded';
      spots.set(anchorId, { id: anchorId, anchor, title: anchor.name, first: anchor.first, spinoff,
        included: !spinoff || state.decisions.has(gameDecisionKey('include_spinoff', anchorId)),
        skipped: state.decisions.has(gameDecisionKey('skip_spot', anchorId)), versions: [] });
    }
    const recs = [rec].concat(entry ? (entry.port_ids || []).map(p => cache.get(p)).filter(Boolean) : gamePlainPorts(rec, cache).map(p => cache.get(p)).filter(Boolean));
    spots.get(anchorId).versions.push({ rec, entry, avail: gameAvailability(recs, state) });
  }
  const list = [...spots.values()];
  list.forEach(s => {
    s.versions.sort((a, b) => cmpStrGame(a.rec.first || '9999', b.rec.first || '9999'));
    s.finished = s.versions.some(v => v.entry && v.entry.status === 'finished');
    s.done = s.finished || s.skipped;
    s.candidates = s.versions.filter(v => v.avail.playable && !(v.entry && v.entry.status === 'skipped'));
  });
  return list.sort((a, b) => cmpStrGame(a.first || '9999-12-31', b.first || '9999-12-31') || cmpStrGame(a.title, b.title));
}
// Which version a spot's Up next names: the member's saved one first (Playing, Paused, Want to play), then a version released
// natively on a selected platform (newest first), then one playable through compatibility.
const SAVED_RANK = { playing: 0, paused: 1, want: 2 };
function spotUpNextVersion(spot) {
  const c = spot.candidates.slice();
  c.sort((a, b) => {
    const ra = a.entry ? SAVED_RANK[a.entry.status] ?? 3 : 4, rb = b.entry ? SAVED_RANK[b.entry.status] ?? 3 : 4;
    if (ra !== rb) return ra - rb;
    const na = a.avail.released[0] && a.avail.released[0].native ? 0 : 1, nb = b.avail.released[0] && b.avail.released[0].native ? 0 : 1;
    return na - nb || cmpStrGame(b.rec.first || '', a.rec.first || '');
  });
  return c[0] || null;
}
// The franchise row: Up next (the earliest counted spot not finished or skipped with a playable version) or Caught up, and
// Coming: releases announced on a selected platform for counted spots not done, and a native edition coming for any version
// (a native PS5 release after a finished PS4 version), never moving the franchise off Caught up.
function franchiseSummary(follow, state) {
  const spots = franchiseSpots(follow, state);
  const counted = spots.filter(s => s.included);
  const upSpot = counted.find(s => !s.done && s.candidates.length);
  const upNext = upSpot ? { spot: upSpot, version: spotUpNextVersion(upSpot) } : null;
  const coming = [];
  const seen = new Set();
  for (const s of counted) {
    for (const v of s.versions) {
      if (v.entry && v.entry.status === 'skipped') continue;
      const nativeReleased = new Set(v.avail.released.filter(c => c.native).map(c => c.platform));
      for (const c of v.avail.coming) {
        if (seen.has(`${v.rec.id}|${c.platform}`)) continue;
        const forUndone = !s.done && !v.avail.playable;
        const nativeEdition = c.native && !nativeReleased.has(c.platform);
        if (!forUndone && !nativeEdition) continue;
        seen.add(`${v.rec.id}|${c.platform}`);
        coming.push({ spot: s, version: v, c });
      }
    }
  }
  coming.sort((a, b) => cmpStrGame(a.c.key, b.c.key));
  return { spots, upNext, caughtUp: !upNext, coming };
}

// ── Scores and length ──
function gameLengthOf(rec, style) {
  const h = rec && rec.hours;
  if (!h || h[style] == null) return { value: null, reliable: false, reason: 'unknown', hours: h };
  const order = ['main', 'main_extra', 'completionist'];
  const bad = new Set();
  order.forEach(s => { if (h[s] != null && h[s] > GAME_LENGTH_CAPS[s]) bad.add(s); });
  const known = order.filter(s => h[s] != null);
  for (let i = 0; i + 1 < known.length; i++) if (h[known[i]] > h[known[i + 1]] * 1.1) { bad.add(known[i]); bad.add(known[i + 1]); }
  const reliable = !bad.has(style);
  return { value: h[style], reliable, reason: reliable ? '' : 'unreliable', hours: h };
}
function gameLengthText(len) {
  if (!len || len.value == null) return 'Length unknown';
  if (!len.reliable) return 'Estimate unreliable';
  return `${len.value % 1 ? len.value.toFixed(1) : len.value} h · IGDB`;
}
const gameSearchHltbUrl = title => `https://howlongtobeat.com/?q=${encodeURIComponent(title)}`;
