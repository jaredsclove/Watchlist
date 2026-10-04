// Reference model for the first-class TV-show migration: the approved rules for
// up next, Up to date, the season-status → show-status migration, and the
// compatibility values written to the deprecated season status. Pure functions
// over plain row objects; nothing here touches the network or the page.
//
// The season sort, the special/aired tests and the TV-row test are the app's own
// (config.js + derived-views.js, loaded in a vm), so the model can't drift from
// what the page does today. The database implementation (db/tv_model.sql) is
// checked against this file by tests/tv-model.test.js and tools/db-rehearsal.mjs.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const app = {};
vm.createContext(app);
for (const f of ['config.js', 'derived-views.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), app, { filename: f });
}
// Top-level const/let in a vm script aren't properties of the context; copy the
// ones the model needs across explicitly.
vm.runInContext(`this.COLLECTIONS = COLLECTIONS;
  if (typeof SHOW_KEY_OVERRIDES !== 'undefined') this.SHOW_KEY_OVERRIDES = SHOW_KEY_OVERRIDES;`, app);
const { compareSeasons, isSpecialRow, isReleasedRow, isTvViewRow } = app;
const TV_COLLECTIONS = app.COLLECTIONS.filter(c => c.mediaType === 'tv').map(c => c.id);

// Reviewed show-key overrides (collection|item_key prefix → show key). Must equal
// SHOW_KEY_OVERRIDES in config.js once it ships, and private.tv_show_key_override
// in the database.
const SHOW_KEY_OVERRIDES = { 'disney|the clone wars': 'star wars: the clone wars (2008)' };

const keyPrefix = r => (r.item_key || '').split('|')[0];
const showKeyOf = r => SHOW_KEY_OVERRIDES[`${r.collection}|${keyPrefix(r)}`] || keyPrefix(r);

// One show per owner + collection: TMDB id when present, otherwise the show key.
function showIdentity(r) {
  return r.tmdb_id != null ? `${r.collection}|tmdb:${r.tmdb_id}` : `${r.collection}|key:${showKeyOf(r)}`;
}

function groupShows(rows) {
  const groups = new Map();
  rows.filter(isTvViewRow).forEach(r => {
    const k = showIdentity(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  for (const seasons of groups.values()) seasons.sort(compareSeasons);
  return groups;
}

// The main progression list: numbered seasons when there are any, otherwise all
// (e.g. a standalone special). Input must already be sorted.
function mainList(sorted) {
  const numbered = sorted.filter(r => !isSpecialRow(r));
  return numbered.length ? numbered : sorted;
}

// Index of the furthest watched season in the main list, or -1.
function furthestWatched(main) {
  let f = -1;
  main.forEach((r, i) => { if (r.watched) f = i; });
  return f;
}

// Seasons after the furthest watched point that are unwatched and not skipped.
function remainingSeasons(seasons) {
  const main = mainList([...seasons].sort(compareSeasons));
  return main.slice(furthestWatched(main) + 1).filter(r => !r.watched && !r.skipped);
}

const upNext = seasons => remainingSeasons(seasons)[0] || null;

// A Watching show is Up to date when no remaining season has aired.
const isUpToDate = (seasons, today) => !remainingSeasons(seasons).some(r => isReleasedRow(r, today));

// Season statuses → show status + per-season skipped flags (the approved rules).
// Returns { status, skippedIds } or { unmapped: [statuses] }.
function migrateShow(seasons) {
  const all = new Set(seasons.map(r => r.status));
  if (all.size === 1 && all.has('skipped')) return { status: 'skipped', skippedIds: new Set() };
  const skippedIds = new Set(seasons.filter(r => r.status === 'skipped').map(r => r.id));
  const a = new Set(seasons.filter(r => r.status !== 'skipped').map(r => r.status));
  if (a.size === 1) return { status: [...a][0], skippedIds };
  if (a.has('watching') && [...a].every(s => ['watching', 'confirmed', 'pending'].includes(s))) {
    return { status: 'watching', skippedIds };
  }
  if (a.size === 2 && a.has('confirmed') && a.has('pending')) return { status: 'confirmed', skippedIds };
  return { unmapped: [...all].sort() };
}

// The season that carries "watching" in the compatibility values for a Watching
// show: up next; else the furthest watched season; else the first season.
function watchingAnchor(seasons) {
  const sorted = [...seasons].sort(compareSeasons);
  const next = upNext(sorted);
  if (next) return next;
  const main = mainList(sorted);
  const f = furthestWatched(main);
  return f >= 0 ? main[f] : main[0] || null;
}

// Compatibility values for the deprecated season status: Map(row id → status).
// `seasons` carry the new `skipped` flag.
function projectLegacyStatus(showStatus, seasons) {
  const out = new Map();
  const anchor = showStatus === 'watching' ? watchingAnchor(seasons) : null;
  for (const r of seasons) {
    let s;
    if (showStatus === 'skipped' || r.skipped) s = 'skipped';
    else if (showStatus === 'watching') s = anchor && r.id === anchor.id ? 'watching' : 'confirmed';
    else s = showStatus;
    out.set(r.id, s);
  }
  return out;
}

// What today's app derives from season statuses (for rollback checks).
const OLD_STATUS_ORDER = ['watching', 'highpriority', 'confirmed', 'complete', 'pending', 'maybe', 'skipped'];
function oldAggregateStatus(seasons) {
  for (const s of OLD_STATUS_ORDER) if (seasons.some(r => r.status === s)) return s;
  return 'confirmed';
}
function oldUpNext(seasons) {
  return [...seasons].sort(compareSeasons).find(r => r.status === 'watching' && !r.watched) || null;
}

// Expands a compact case season from tests/fixtures/tv-model-cases.json:
// [id, season number or label, flags, date_sort]. Flags: any of "w" (watched)
// and "s" (skipped), or one of "tba", "future", "today", "2099".
function caseSeasons(spec, today) {
  return spec.map(([id, sn, flags = '', date]) => {
    const numbered = typeof sn === 'number';
    const row = {
      id, collection: numbered ? 'othertv' : 'disney', title: 'Case Show', item_key: `case show|${id.toLowerCase()}`,
      season: numbered ? (sn === 0 ? 'Specials' : `Season ${sn}`) : sn,
      season_number: numbered ? sn : null, media_type: numbered ? 'tv' : null, tmdb_id: numbered ? 1 : null,
      watched: false, skipped: false, display_date: 'Jan 1, 2020', date_sort: date || '2020-01-01', status: 'confirmed'
    };
    if (flags === 'tba') Object.assign(row, { display_date: 'TBA', date_sort: '2099-01-01' });
    else if (flags === 'future') Object.assign(row, { display_date: 'Jun 1, 2098', date_sort: '2098-06-01' });
    else if (flags === 'today') Object.assign(row, { date_sort: today });
    else if (flags === '2099') Object.assign(row, { display_date: 'Jan 1, 2099', date_sort: '2099-01-01' });
    else { row.watched = flags.includes('w'); row.skipped = flags.includes('s'); }
    return row;
  });
}

module.exports = {
  caseSeasons,
  TV_COLLECTIONS, SHOW_KEY_OVERRIDES, app,
  compareSeasons, isSpecialRow, isReleasedRow, isTvViewRow,
  keyPrefix, showKeyOf, showIdentity, groupShows,
  mainList, remainingSeasons, upNext, isUpToDate,
  migrateShow, watchingAnchor, projectLegacyStatus,
  oldAggregateStatus, oldUpNext
};
