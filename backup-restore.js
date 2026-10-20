// objects as a whole). Returns an array of field names that differ.
// columnTypes (the format's RESTORE_COLUMNS for the table, optional): a column of
// type 'timestamp' also matches the same instant written another way (the database
// returns "…05.325+00:00" for a file's "…05.325Z").
function compareRowFields(expected, restored, columnTypes = {}) {
  const diffFields = [];
  for (const key of Object.keys(expected)) {
    const a = expected[key];
    const b = restored[key];
    // JSON.stringify on a single value (not a whole object) is safe here —
    // it has no key-order ambiguity for primitives, and for arrays
    // (watch_with, collections) it correctly catches real order/content
    // differences, which are genuine data differences, not false positives.
    if (JSON.stringify(a) !== JSON.stringify(b) &&
        !(/^timestamp\??$/.test(columnTypes[key] || '') && sameTimestampInstant(a, b))) {
      diffFields.push(key);
    }
  }
  return diffFields;
}

// The instant of an ISO timestamp with an explicit offset (Z, ±HH, ±HHMM, ±HH:MM),
// to the microsecond (the database's precision), as a comparable string; null for
// anything else (no offset, more than 6 fractional digits, not a valid date).
function timestampInstantKey(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac = '', off] = m;
  // setUTCFullYear keeps the literal year (Date.UTC would read 0000–0099 as 1900–1999).
  const check = new Date(0);
  check.setUTCFullYear(+y, +mo - 1, +d);
  check.setUTCHours(+h, +mi, +s, 0);
  const ms = check.getTime();
  if (isNaN(ms) || check.getUTCFullYear() !== +y || check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) return null;
  let offMin = 0;
  if (off !== 'Z') {
    const o = /^([+-])(\d{2}):?(\d{2})?$/.exec(off);
    if (+o[2] > 23 || +(o[3] || 0) > 59) return null;
    offMin = (o[1] === '-' ? -1 : 1) * (+o[2] * 60 + +(o[3] || 0));
  }
  return `${(ms - offMin * 60000) / 1000}.${frac.padEnd(6, '0')}`;
}

// True only when both values are such timestamps and name the same instant.
function sameTimestampInstant(a, b) {
  const ka = timestampInstantKey(a), kb = timestampInstantKey(b);
  return ka !== null && ka === kb;
}

// The database's Stage 5 phase (stage5_capabilities, read with GET); null for a
// database without Stage 5. Read-only.
async function stage5Capabilities() {
  try { return await sbFetch('GET', 'rpc/stage5_capabilities', null); }
  catch (e) {
    if (/PGRST202|: 404 /.test(String(e && e.message))) return null; // a database before Stage 5
    throw e;
  }
}

// Which backup format this page makes and restores: 6, and only on a database in the
// page's phase (EP1). Any other phase (an older one, none, unknown) is refused,
// never guessed: this page makes no format 5 (it would leave out every episode mark).
async function detectBackupFormat() {
  const cap = await stage5Capabilities();
  if (b45Stopped) throw new Error(STATE_MISMATCH_TEXT + ' No file was made.');
  if (cap && cap.access === 'members' && cap.member !== true) throw new Error(NOT_A_MEMBER_TEXT + ' No file was made.');
  if (pageMayWrite(cap)) return 6;
  throw new Error('This page makes backups only of a database in its own state (format 6), and this database isn’t in it, so no file was made and nothing was changed. Reload the page.');
}

// At boot (doesn't hold up the first view): which phase this database is in. A database
// without the update gets a notice of its own (#phaseBanner), which no view's message replaces.
// M1: the sign-in boot (auth.js) has just read it; that answer is used (known) instead of a second read.
async function loadStage5Capabilities(known) {
  try {
    const cap = known !== undefined ? known : await stage5Capabilities();
    stage5Phase = pageMayWrite(cap) ? cap.phase : null;
    const el = document.getElementById('phaseBanner');
    if (el && !b45Stopped) el.innerHTML = cap ? '' : '<div class="error-banner">⚠️ This page needs a database update that hasn’t been made yet. Your list may not load, and changes are refused until the update is made. Nothing will be changed.</div>';
  } catch (e) { /* unknown: the backup and restore checks read it again */ }
}

// Fetches every row of every table in the database's backup format, asking for the
// format's exact columns (never user_id: a backup is list content, not ownership),
// and assembles the backup JSON object. Does not write anything.
// The phase is read before and again after the reads: a database whose phase
// changed in between (for example a rollback) gives no file at all,
// never a mix.
async function buildBackupObject() {
  const formatVersion = await detectBackupFormat();
  const spec = backupSpec(formatVersion);
  const tables = {};
  const rowCounts = {};
  const updated = new Error('The database was updated while the backup was being read, so no file was made. Try again.');
  for (const table of spec.tables) {
    let rows;
    try { rows = await fetchAllRows(table, null, Object.keys(spec.columns[table]).join(',')); }
    catch (e) {
      // A read refused because the phase changed underneath it is the same case.
      const now = await stage5Capabilities().catch(() => undefined);
      throw now !== undefined && !(now && now.phase === PAGE_PHASE) ? updated : e;
    }
    tables[table] = rows;
    rowCounts[table] = rows.length;
  }
  // Membership is checked again after the reads: a membership ended during them would have made the later
  // reads empty, so no file is made rather than an incomplete one.
  const after = await stage5Capabilities();
  if (after && after.access === 'members' && after.member !== true) throw new Error(NOT_A_MEMBER_TEXT + ' (It ended while the backup was being read.) No file was made.');
  if (!pageMayWrite(after)) throw updated;
  return {
    format: BACKUP_FORMAT,
    formatVersion,
    exportedAt: new Date().toISOString(),
    rowCounts,
    tables
  };
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function timestampForFilename() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ─── Collection definitions ───────────────────────────────────────────────────


// ─── Backup buttons ─────────────────────────────────────────────────────────
// O5 (S1): ⬇ Backup in the header and ⬇ Download backup in Settings run the same backup
// and share one busy state: while it runs both are disabled, the pressed one says
// "Backing up…", and a second press (of either) does nothing.
const BACKUP_LABELS = { backupBtn: '⬇ Backup', settingsBackupBtn: '⬇ Download backup' };
let backupBusy = false;
let backupPressedId = null;

function setBackupButtons() {
  Object.entries(BACKUP_LABELS).forEach(([id, label]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = backupBusy;
    btn.textContent = backupBusy && backupPressedId === id ? 'Backing up…' : label;
  });
}

async function handleBackupClick(opener) {
  if (backupBusy) return;
  backupBusy = true;
  backupPressedId = opener && BACKUP_LABELS[opener.id] ? opener.id : 'backupBtn';
  setBackupButtons();
  try {
    const backup = await buildBackupObject();
    downloadJSON(backup, `watchlist-backup-${timestampForFilename()}.json`);
    recordBackupTimestamp();
    showSaved();
  } catch(e) {
    showError(`Backup failed: ${e.message}`);
  } finally {
    backupBusy = false;
    backupPressedId = null;
    setBackupButtons();
  }
}

// D11 (S1): restore is prepared and confirmed only on Settings. The browse-view refusal
// is kept as it was (a browse view is never Settings). Nothing checks this after
// restore_backup has been sent (restoreInFlight): a submitted restore always finishes.
function restoreEligibleView() {
  return typeof isSettingsView === 'function' && isSettingsView(activeViewId) && !isBrowseView(activeViewId);
}

// Restore is offered only on Settings (tabs.js).
function handleRestoreClick() {
  if (!restoreEligibleView()) return;
  document.getElementById('restoreFileInput').click();
}

function validateBackupObject(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') { errors.push('File does not contain a JSON object.'); return errors; }
  if (obj.format !== BACKUP_FORMAT) errors.push(`Unrecognized backup format ("${obj.format}") — this doesn't look like a Watchlist Tracker backup file.`);
  const spec = backupSpec(obj.formatVersion);
  if (!spec) { errors.push(`Unsupported backup format version (${obj.formatVersion}).`); return errors; }
  if (!obj.exportedAt || isNaN(Date.parse(obj.exportedAt))) errors.push('Missing or invalid export timestamp.');
  if (!obj.tables || typeof obj.tables !== 'object') { errors.push('Missing "tables" section.'); return errors; }
  const unexpected = Object.keys(obj.tables).filter(t => !spec.tables.includes(t));
  if (unexpected.length) errors.push(`Unexpected table(s) for format ${obj.formatVersion}: ${unexpected.join(', ')}.`);
  const hasRowCounts = obj.rowCounts && typeof obj.rowCounts === 'object' && !Array.isArray(obj.rowCounts);
  if (!hasRowCounts) errors.push('Missing "rowCounts" section, so the file can\'t be checked for completeness.');
  for (const table of spec.tables) {
    if (!Array.isArray(obj.tables[table])) {
      errors.push(`Missing or invalid data for table "${table}".`);
      continue;
    }
    if (!hasRowCounts) continue;
    const declaredCount = obj.rowCounts[table];
    if (!Number.isInteger(declaredCount) || declaredCount < 0) {
      errors.push(`Row count for "${table}" is missing or not a whole number.`);
    } else if (declaredCount !== obj.tables[table].length) {
      errors.push(`Row count mismatch for "${table}": file claims ${declaredCount} but contains ${obj.tables[table].length}.`);
    }
  }
  if (errors.length > 0) return errors;

  // A backup made before the TMDB identity migration has no identity columns at all.
  // Restoring it would silently turn every identified show and movie back into a
  // legacy row, so it is refused outright rather than reported column by column.
  const items = obj.tables.watchlist_items;
  if (items.length > 0 && items.every(r => r && typeof r === 'object' && !('media_type' in r) && !('tmdb_id' in r) && !('season_number' in r))) {
    errors.push('This backup predates the TMDB identity migration: its watchlist_items rows have no media_type, tmdb_id or season_number. Restoring it would discard the TMDB identity of every show and movie, so it can\'t be used.');
    return errors;
  }
  return errors.concat(validateBackupRows(obj.tables, obj.formatVersion));
}

// Format 4 (Stage 5, once the contraction has run): no storage. watchlist_items
// carries theme_kind (films: 'genre' / 'other'), personal_collections catalog_id,
// and the catalog governance tables are included. Never user_id, never the
// generated is_film / item_is_film. Formats 1–3: backup-format3.js. A trailing "?"
// marks columns the database allows to be NULL. If the schema gains a column, add it here.
const RESTORE_COLUMNS_V4 = {
  watchlist_items: {
    id: 'uuid', item_key: 'text', title: 'text', season: 'text', theme: 'text', theme_kind: 'text?',
    display_date: 'text', date_sort: 'date', watched: 'bool', status: 'text', created_at: 'timestamp',
    watch_with: 'text[]?', collections: 'text[]?', tmdb_collection_id: 'int?', tmdb_collection_name: 'text?',
    media_type: 'text?', tmdb_id: 'int?', season_number: 'int?', show_id: 'uuid?', skipped: 'bool'
  },
  tv_shows: { id: 'uuid', title: 'text', show_key: 'text', tmdb_id: 'int?', status: 'text', created_at: 'timestamp' },
  custom_collections: { id: 'uuid', name: 'text', tmdb_person_id: 'int', created_at: 'timestamp', role: 'text?' },
  personal_collections: { id: 'uuid', name: 'text', catalog_id: 'text?', presentation_key: 'text?', sort_order: 'int', archived_at: 'timestamp?', created_at: 'timestamp' },
  collection_memberships: { id: 'uuid', collection_id: 'uuid', show_id: 'uuid?', item_id: 'uuid?', created_at: 'timestamp' },
  watch_with_choices: { id: 'uuid', token: 'text', label: 'text', sort_order: 'int', archived_at: 'timestamp?', created_at: 'timestamp' },
  catalog_show_links: { id: 'uuid', catalog: 'text', catalog_key: 'text', show_id: 'uuid', origin: 'text', created_at: 'timestamp' },
  catalog_film_links: { id: 'uuid', catalog: 'text', entry_key: 'text', item_id: 'uuid', origin: 'text', created_at: 'timestamp' }
};
const BACKUP_FORMAT_V4 = { tables: Object.keys(RESTORE_COLUMNS_V4), columns: RESTORE_COLUMNS_V4 };
// Format 5 (B4/B5): format 4 plus the viewing state (status codes To Watch / Watching /
// Skipped for shows, To Watch / Skipped plus watched for films; priority; Show ended;
// New from catalog; Needs status review; the old status kept as provenance), the
// categorized metadata, and a show's earlier-seasons resume range. Season rows carry
// none of the film values (NULL); films carry every one of them.
const RESTORE_COLUMNS_V5 = {
  ...RESTORE_COLUMNS_V4,
  watchlist_items: {
    ...RESTORE_COLUMNS_V4.watchlist_items, priority: 'text?', catalog_new: 'bool?', status_review: 'bool?', legacy_status: 'text?',
    genres: 'text[]?', forms: 'text[]?', franchises: 'text[]?', companies: 'text[]?', genre_candidates: 'text[]?', metadata_owner_set: 'bool?'
  },
  tv_shows: {
    ...RESTORE_COLUMNS_V4.tv_shows, priority: 'text', ended: 'bool', catalog_new: 'bool', status_review: 'bool', legacy_status: 'text?',
    genres: 'text[]', forms: 'text[]', franchises: 'text[]', companies: 'text[]', genre_candidates: 'text[]', network: 'text?',
    network_candidates: 'text[]', metadata_owner_set: 'bool', resume_start_season_id: 'uuid?', resume_end_season_id: 'uuid?'
  }
};
const BACKUP_FORMAT_V5 = { tables: Object.keys(RESTORE_COLUMNS_V5), columns: RESTORE_COLUMNS_V5 };
// Format 6 (EP1): format 5 plus episode_marks, the watched episodes of TMDB-matched seasons
// (no dates, no titles: episode lists are TMDB's and never stored).
const RESTORE_COLUMNS_V6 = {
  ...RESTORE_COLUMNS_V5,
  episode_marks: { id: 'uuid', season_id: 'uuid', tmdb_episode_id: 'int', episode_number: 'int' }
};
const BACKUP_FORMAT_V6 = { tables: Object.keys(RESTORE_COLUMNS_V6), columns: RESTORE_COLUMNS_V6 };
const FORMAT5_CONVERTER_VERSION = 'ep1.1';
const CATALOG_GOVERNANCE_IDS = ['disney', '90day', 'sheridan'];
const PRESENTATION_KEYS = ['disney', '90day', 'sheridan', 'truecrime'];
const FORMAT4_CONVERTER_VERSION = 'b45.1';

// The tables and columns of a format (4–6 here; 1–3 in backup-format3.js).
function backupSpec(formatVersion) {
  return formatVersion === 6 ? BACKUP_FORMAT_V6 : formatVersion === 5 ? BACKUP_FORMAT_V5 : formatVersion === 4 ? BACKUP_FORMAT_V4 : legacyBackupSpec(formatVersion);
}

const TV_SHOW_STATUSES = ['confirmed', 'highpriority', 'watching', 'complete', 'pending', 'maybe', 'skipped'];
const TV_SHOW_STATUSES_V5 = ['confirmed', 'watching', 'skipped'];

// Returns why a value doesn't fit a RESTORE_COLUMNS type, or null if it does.
function restoreValueProblem(type, v) {
  const nullable = type.endsWith('?');
  const base = nullable ? type.slice(0, -1) : type;
  if (v === null) return nullable ? null : 'is null but the column can\'t be';
  switch (base) {
    case 'uuid': return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? null : 'is not a uuid';
    case 'text': return typeof v === 'string' ? null : 'is not text';
    case 'date': return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v) ? null : 'is not a YYYY-MM-DD date';
    case 'timestamp': return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !isNaN(Date.parse(v)) ? null : 'is not a timestamp';
    case 'bool': return typeof v === 'boolean' ? null : 'is not true/false';
    case 'int': return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? null : 'is not a whole number';
    case 'text[]': return Array.isArray(v) && v.every(x => typeof x === 'string') ? null : 'is not a list of text';
  }
  return 'has an unknown type';
}

// Row-level checks that mirror the database: exact columns, value types, the
// identity-shape CHECK, and every primary/unique key. Anything reported here would
// otherwise fail only after the tables had already been cleared.
function validateBackupRows(tables, formatVersion = 1) {
  const spec = backupSpec(formatVersion);
  const errors = [];
  const report = (label, problems) => {
    if (problems.length === 0) return;
    const more = problems.length > 5 ? ` …and ${problems.length - 5} more` : '';
    errors.push(`${label}: ${problems.slice(0, 5).join('; ')}${more}`);
  };
  const rowLabel = (r, i) => `row ${i + 1}${r && typeof r.id === 'string' ? ` (id ${r.id})` : ''}`;
  const findDuplicates = (rows, keyOf, describe) => {
    const seen = new Map();
    const dups = [];
    rows.forEach((r, i) => {
      const key = keyOf(r);
      if (key === null) return;
      if (seen.has(key)) dups.push(`${describe(r)} on ${rowLabel(rows[seen.get(key)], seen.get(key))} and ${rowLabel(r, i)}`);
      else seen.set(key, i);
    });
    return dups;
  };

  for (const table of spec.tables) {
    const columns = spec.columns[table];
    const rows = tables[table];
    const columnProblems = [], typeProblems = [];
    rows.forEach((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) { columnProblems.push(`${rowLabel(r, i)} is not an object`); return; }
      const unknown = Object.keys(r).filter(k => !(k in columns));
      const missing = Object.keys(columns).filter(k => !(k in r));
      if (unknown.length) columnProblems.push(`${rowLabel(r, i)} has unknown column(s) ${unknown.join(', ')}`);
      if (missing.length) columnProblems.push(`${rowLabel(r, i)} is missing column(s) ${missing.join(', ')}`);
      for (const [col, type] of Object.entries(columns)) {
        if (!(col in r)) continue;
        const problem = restoreValueProblem(type, r[col]);
        if (problem) typeProblems.push(`${rowLabel(r, i)} ${col} ${problem}`);
      }
    });
    report(`${table} columns`, columnProblems);
    report(`${table} values`, typeProblems);
    report(`${table} duplicate id`, findDuplicates(rows, r => r && typeof r.id === 'string' ? r.id.toLowerCase() : null, () => 'same id'));
  }

  const items = tables.watchlist_items.filter(r => r && typeof r === 'object');
  const shapeProblems = [];
  items.forEach((r, i) => {
    const m = r.media_type, id = r.tmdb_id, s = r.season_number;
    const ok = (m === null && id === null && s === null)
      || (m === 'tv' && id != null && s != null)
      || (m === 'movie' && id != null && s === null);
    if (!ok) shapeProblems.push(`${rowLabel(r, i)} has media_type ${JSON.stringify(m)}, tmdb_id ${JSON.stringify(id)}, season_number ${JSON.stringify(s)}`);
  });
  report('watchlist_items identity shape (must be movie, TV season, or legacy with all three empty)', shapeProblems);
  report('custom_collections duplicate name', findDuplicates(tables.custom_collections.filter(r => r && typeof r === 'object'),
    r => typeof r.name === 'string' ? r.name : null, r => `"${r.name}"`));
  if (formatVersion === 5 || formatVersion === 6) {
    validateFormat4Rows(tables, items, report, rowLabel, findDuplicates, TV_SHOW_STATUSES_V5);
    validateFormat5Rows(tables, items, report, rowLabel);
    if (formatVersion === 6) validateFormat6Rows(tables, items, report, rowLabel, findDuplicates);
  } else if (formatVersion === 4) validateFormat4Rows(tables, items, report, rowLabel, findDuplicates);
  else validateLegacyBackupRows(tables, formatVersion, report, rowLabel, findDuplicates);
  return errors;
}

// Format 5: what the database's B4/B5 checks enforce, before anything is sent. A film
// carries every film value (its legacy status may be empty); a season row carries none;
// statuses, priorities and provenance from their lists; label lists as the database
// accepts them; a show's resume range is two different seasons of that same show, or none.
function validateFormat5Rows(tables, items, report, rowLabel) {
  const isFilm = r => r.media_type === 'movie' || (r.media_type == null && r.season === 'Film');
  const shows = tables.tv_shows.filter(r => r && typeof r === 'object');
  const labelsOk = v => Array.isArray(v) && JSON.stringify(labelList(v)) === JSON.stringify(v) && v.length <= METADATA_LIMITS.values;
  const FILM_FIELDS = ['priority', 'catalog_new', 'status_review', 'genres', 'forms', 'franchises', 'companies', 'genre_candidates', 'metadata_owner_set'];
  const LISTS = ['genres', 'forms', 'franchises', 'companies', 'genre_candidates'];
  const filmProblems = [];
  items.forEach((r, i) => {
    if (isFilm(r)) {
      const missing = FILM_FIELDS.filter(f => r[f] === null || r[f] === undefined);
      if (missing.length) filmProblems.push(`${rowLabel(r, i)} is a film without ${missing.join(', ')}`);
      if (!['confirmed', 'skipped'].includes(r.status)) filmProblems.push(`${rowLabel(r, i)} has film status ${JSON.stringify(r.status)}`);
      if (r.priority != null && !PRIORITIES.includes(r.priority)) filmProblems.push(`${rowLabel(r, i)} has priority ${JSON.stringify(r.priority)}`);
      if (r.legacy_status != null && !['pending', 'highpriority', 'maybe', 'watching', 'complete'].includes(r.legacy_status)) filmProblems.push(`${rowLabel(r, i)} has legacy_status ${JSON.stringify(r.legacy_status)}`);
      LISTS.forEach(f => { if (r[f] != null && !labelsOk(r[f])) filmProblems.push(`${rowLabel(r, i)} ${f} isn’t a valid label list`); });
    } else {
      const set = FILM_FIELDS.concat(['legacy_status']).filter(f => r[f] !== null && r[f] !== undefined);
      if (set.length) filmProblems.push(`${rowLabel(r, i)} is a TV season but has ${set.join(', ')}`);
    }
  });
  report('watchlist_items B4/B5 values', filmProblems);
  const seasonsById = new Map(items.filter(r => r.show_id != null).map(r => [r.id, r]));
  const showProblems = [];
  shows.forEach((s, i) => {
    if (!PRIORITIES.includes(s.priority)) showProblems.push(`${rowLabel(s, i)} has priority ${JSON.stringify(s.priority)}`);
    if (s.legacy_status != null && !['pending', 'highpriority', 'maybe', 'complete'].includes(s.legacy_status)) showProblems.push(`${rowLabel(s, i)} has legacy_status ${JSON.stringify(s.legacy_status)}`);
    LISTS.concat(['network_candidates']).forEach(f => { if (!labelsOk(s[f])) showProblems.push(`${rowLabel(s, i)} ${f} isn’t a valid label list`); });
    if (s.network != null && (s.network !== s.network.trim() || !s.network || s.network.length > METADATA_LIMITS.length)) showProblems.push(`${rowLabel(s, i)} has network ${JSON.stringify(s.network)}`);
    const a = s.resume_start_season_id, b = s.resume_end_season_id;
    if ((a == null) !== (b == null) || (a != null && a === b)) showProblems.push(`${rowLabel(s, i)} has an incomplete earlier-seasons range`);
    else if (a != null && [a, b].some(id => !seasonsById.has(id) || seasonsById.get(id).show_id !== s.id)) showProblems.push(`${rowLabel(s, i)} has an earlier-seasons range naming a season that isn’t one of its own`);
  });
  report('tv_shows B4/B5 values', showProblems);
}

// Format 6: what the database's episode_marks rules enforce, before anything is sent. A mark
// belongs to a TMDB-matched season of a show in the backup, once per TMDB episode.
function validateFormat6Rows(tables, items, report, rowLabel, findDuplicates) {
  const marks = tables.episode_marks.filter(r => r && typeof r === 'object');
  const seasons = new Map(items.filter(r => r.show_id != null).map(r => [r.id, r]));
  const problems = [];
  marks.forEach((m, i) => {
    const s = seasons.get(m.season_id);
    if (!s) problems.push(`${rowLabel(m, i)} points at season ${m.season_id}, which isn't a TV season in the backup`);
    else if (!(s.media_type === 'tv' && s.tmdb_id != null && s.season_number != null)) problems.push(`${rowLabel(m, i)} points at a season that isn't matched to TMDB`);
    if (!(Number.isInteger(m.tmdb_episode_id) && m.tmdb_episode_id > 0)) problems.push(`${rowLabel(m, i)} has tmdb_episode_id ${JSON.stringify(m.tmdb_episode_id)}`);
    if (!(Number.isInteger(m.episode_number) && m.episode_number >= 0)) problems.push(`${rowLabel(m, i)} has episode_number ${JSON.stringify(m.episode_number)}`);
  });
  report('episode_marks', problems);
  report('episode_marks duplicate episode of a season', findDuplicates(marks, m => `${m.season_id}|${m.tmdb_episode_id}`, m => `(season ${m.season_id}, TMDB episode ${m.tmdb_episode_id})`));
}

// ─── Converting a format-5 document to format 6 ───────────────────────────────
// Format 6 adds episode marks, which a format-5 file can't have: the converted document has
// none, and every other table is kept as it is. A format-5 document converted from format 3 or 4
// keeps its conversion record (and a format-3 recovery section) verbatim, with this converter
// added to its version; a native format-5 file gets its own record (source format 5).
function convertFormat5To6(doc5, { sourceSha256 } = {}) {
  const tables = { ...doc5.tables, episode_marks: [] };
  const doc = { format: doc5.format, formatVersion: 6, exportedAt: doc5.exportedAt,
    rowCounts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])), tables };
  doc.conversion = doc5.conversion
    ? { ...doc5.conversion, converter_version: `${doc5.conversion.converter_version}+${FORMAT5_CONVERTER_VERSION}` }
    : { source_format: 5, source_exported_at: doc5.exportedAt, source_sha256: sourceSha256, converter_version: FORMAT5_CONVERTER_VERSION };
  if (doc5.recovery) doc.recovery = doc5.recovery;
  return { doc };
}
function format5ConversionHtml() {
  return `<div class="modal-section"><div class="modal-label">This backup is converted to format 6 before restoring</div><ul class="manage-list">
    <li>Format 6 adds episode marks. This backup was made before them, so after restoring no season has episode marks; seasons keep their watched and skipped marks from the backup.</li>
    <li>The file itself isn’t changed.</li></ul></div>`;
}

// ─── Converting a format-4 document to format 5 ───────────────────────────────
// Deterministic, with the plan's converter rules (metadata.js b45MapShowStatus /
// b45MapFilmStatus): Pending → To Watch with New from catalog; High Priority / Maybe
// Later → To Watch with High / Low priority; Complete (a show) → To Watch, Show ended,
// Needs status review; a film's watching / complete → To Watch (its watched flag kept)
// with Needs status review; the old status is kept as provenance. Every film keeps its
// watched flag (a Skipped + Watched pair stays one). No metadata, no resume range. A
// format-4 document converted from format 3 keeps its conversion record (source format 3,
// the original file's hash) and its recovery section verbatim; a native format-4 file gets
// its own record (source format 4) and never a recovery section. sourceSha256: of the
// file's text, as read. Refuses (never a document) an unknown status.
function convertFormat4To5(doc4, { sourceSha256 } = {}) {
  const t = doc4.tables;
  const isFilm = r => r.media_type === 'movie' || (r.media_type == null && r.season === 'Film');
  const refusals = [];
  const badShows = t.tv_shows.filter(s => !OLD_STATUSES.includes(s.status)).map(s => s.id);
  const badFilms = t.watchlist_items.filter(r => isFilm(r) && !OLD_STATUSES.includes(r.status)).map(r => r.id);
  if (badShows.length) refusals.push(`a show with an unknown status: ${badShows.slice(0, 5).join(', ')}`);
  if (badFilms.length) refusals.push(`a film with an unknown status: ${badFilms.slice(0, 5).join(', ')}`);
  if (refusals.length) return { refusals };
  const tally = {};
  const count = k => { tally[k] = (tally[k] || 0) + 1; };
  const shows = t.tv_shows.map(s => {
    if (s.status !== b45MapShowStatus(s.status).status || s.status === 'complete') count(`show:${s.status}`);
    return { ...s, ...b45MapShowStatus(s.status), genres: [], forms: [], franchises: [], companies: [], genre_candidates: [], network: null,
      network_candidates: [], metadata_owner_set: false, resume_start_season_id: null, resume_end_season_id: null };
  });
  const items = t.watchlist_items.map(r => {
    if (!isFilm(r)) return { ...r, priority: null, catalog_new: null, status_review: null, legacy_status: null, genres: null, forms: null,
      franchises: null, companies: null, genre_candidates: null, metadata_owner_set: null };
    const m = b45MapFilmStatus(r.status);
    if (m.legacy_status) count(`film:${r.status}`);
    if (r.status === 'skipped' && r.watched) count('film:pair');
    return { ...r, ...m, genres: [], forms: [], franchises: [], companies: [], genre_candidates: [], metadata_owner_set: false };
  });
  const tables = { ...t, watchlist_items: items, tv_shows: shows };
  const doc = { format: doc4.format, formatVersion: 5, exportedAt: doc4.exportedAt,
    rowCounts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])), tables };
  doc.conversion = doc4.conversion
    ? { ...doc4.conversion, converter_version: `${doc4.conversion.converter_version}+${FORMAT4_CONVERTER_VERSION}` }
    : { source_format: 4, source_exported_at: doc4.exportedAt, source_sha256: sourceSha256, converter_version: FORMAT4_CONVERTER_VERSION };
  if (doc4.recovery) doc.recovery = doc4.recovery;
  const review = shows.filter(s => s.status_review).map(s => s.title).concat(items.filter(r => r.status_review).map(r => r.title));
  return { refusals: [], doc, summary: { tally, review, pairs: tally['film:pair'] || 0, fromFormat: doc4.conversion ? 3 : 4 } };
}

// A format-4 file read from disk may carry a conversion record and a recovery section only
// as the page's own format-3 conversion writes them (source format 3, the file's hash, a
// converter version; a recovery section only with them and only while the archive is
// active). Anything else is refused before anything is sent.
function format4SectionProblems(doc4, archiveActive) {
  return sectionProblems(doc4, archiveActive, ['3']);
}
// The optional sections of a document about to be restored (format 4 from disk: conversion
// source 3 only; format 5: source 3 or 4; format 6: 3, 4 or 5), checked as restore_backup checks them: the
// conversion record's fields; a recovery section only with a format-3 conversion and an
// active archive, of exactly the expected shape, and corresponding to the document's own rows.
function sectionProblems(doc, archiveActive, sources) {
  const problems = [];
  const c = doc.conversion, r = doc.recovery;
  if (c !== undefined && (!c || typeof c !== 'object' || !sources.includes(String(c.source_format)) || !/^[0-9a-f]{64}$/.test(c.source_sha256 || '')
      || !c.converter_version || !c.source_exported_at)) problems.push('Its conversion record isn’t one this page writes.');
  if (r !== undefined) {
    if (c === undefined) problems.push('It has a recovery section without a conversion record.');
    else if (c && String(c.source_format) !== '3') problems.push('It has a recovery section, which belongs only to a converted format-3 backup.');
    if (!archiveActive) problems.push('It has a recovery section, and the recovery archive has been retired.');
    problems.push(...recoverySectionProblems(doc));
  }
  return problems;
}
// ── recovery section check: begin (reads a file's recovery section only; sends nothing) ──
// A recovery section against the document's own rows: restore_backup's shape, exact-field and
// correspondence rules (db/b45_expand.sql), so a section the database would refuse never gets
// an actionable confirmation. The database still checks everything again, in one transaction.
const RECOVERY_STORAGE = ['disney', '90day', 'sheridan', 'othertv', 'truecrime', 'movies'];
const RECOVERY_OTHERTV_FIELDS = ['collection', 'created_at', 'id', 'network', 'title', 'tmdb_id'];
// The other-TV rows go into private.stage5_recovery_othertv (like othertv_shows: id uuid primary key,
// tmdb_id integer, title / network text, created_at timestamptz, collection text, all NOT NULL,
// one row per collection and tmdb_id) after restore_backup's own row checks; these mirror both.
// The id: restore_backup's pattern (36 lowercase hex digits and hyphens) and PostgreSQL's uuid input
// (32 hex digits, a hyphen only after a group of four). Returns the uuid's digits, or null.
function recoveryUuidDigits(v) {
  return typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) && /^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/.test(v) ? v.replace(/-/g, '') : null;
}
// tmdb_id: its text matches ^[0-9]+$ and fits an integer. Returns the number, or null.
function recoveryTmdbId(v) {
  const t = typeof v === 'string' ? v : Number.isInteger(v) ? String(v) : null;
  if (t === null || !/^[0-9]+$/.test(t)) return null;
  const n = Number(t);
  return n <= 2147483647 ? n : null;
}
// created_at: an ISO 8601 date and time PostgreSQL reads as timestamptz — a real calendar date
// (year 1–9999), hour 0–23, minute and second 0–59, optional fraction, optional offset within ±15:59.
// (Stricter than PostgreSQL, which also reads other spellings; the page and the database write this one.)
function recoveryTimestampOk(v) {
  const m = typeof v === 'string'
    && /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2})(?::?(\d{2}))?)?$/.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, sec, oh, om] = m.slice(1).map(x => (x === undefined ? 0 : Number(x)));
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1] && h <= 23 && mi <= 59 && sec <= 59 && oh <= 15 && om <= 59;
}
// title: restore_backup reads it as text and refuses it blank (PostgreSQL's btrim trims spaces only).
const recoveryTextOf = v => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));
const recoveryNoNul = v => typeof v !== 'string' || !v.includes('\u0000'); // PostgreSQL text can't hold U+0000
function recoverySectionProblems(doc) {
  const r = doc.recovery, t = doc.tables || {};
  const keys = o => Object.keys(o).sort().join(',');
  const isObj = o => !!o && typeof o === 'object' && !Array.isArray(o);
  if (!isObj(r) || keys(r) !== 'othertv_shows,storage_map' || !isObj(r.storage_map) || keys(r.storage_map) !== 'items,personal_collections,shows'
      || !Array.isArray(r.othertv_shows) || !['items', 'shows', 'personal_collections'].every(k => Array.isArray(r.storage_map[k]))) {
    return ['Its recovery section isn’t one this page writes (its structure is malformed).'];
  }
  const sm = r.storage_map, out = [];
  const exact = (list, fields, what) => { const bad = list.filter(x => !isObj(x) || keys(x) !== fields).length; if (bad) out.push(`${bad} recovery ${what} entr${bad === 1 ? 'y doesn’t' : 'ies don’t'} have exactly the expected fields.`); };
  exact(sm.items, 'collection,id', 'item'); exact(sm.shows, 'collection,id', 'show'); exact(sm.personal_collections, 'id,legacy_source', 'collection');
  exact(r.othertv_shows, RECOVERY_OTHERTV_FIELDS.join(','), 'other-TV');
  if (out.length) return out;
  const say = (n, text) => { if (n) out.push(`${n} ${text}`); };
  const count = (xs, f) => xs.filter(f).length;
  const items = t.watchlist_items || [], shows = t.tv_shows || [], cols = t.personal_collections || [];
  const itemMap = new Map(sm.items.map(x => [x.id, x.collection])), showMap = new Map(sm.shows.map(x => [x.id, x.collection]));
  const repeats = list => list.length - new Set(list.map(x => x.id)).size;
  say(repeats(sm.items) + repeats(sm.shows), 'recovery entries name the same record twice.');
  say(count(items, w => !itemMap.has(w.id)), 'saved rows have no recovery entry.');
  say(count(shows, s => !showMap.has(s.id)), 'shows have no recovery entry.');
  const itemIds = new Set(items.map(w => w.id)), showIds = new Set(shows.map(s => s.id));
  say(count(sm.items, x => !itemIds.has(x.id)) + count(sm.shows, x => !showIds.has(x.id)), 'recovery entries name records that aren’t in the backup.');
  say(count(sm.items.concat(sm.shows), x => !RECOVERY_STORAGE.includes(x.collection)), 'recovery entries name an unknown storage.');
  const showCat = new Map((t.catalog_show_links || []).map(l => [l.show_id, l.catalog])), filmCat = new Map((t.catalog_film_links || []).map(l => [l.item_id, l.catalog]));
  const builtin = c => ['disney', '90day', 'sheridan'].includes(c);
  say(count(sm.shows, x => showIds.has(x.id) && (builtin(x.collection) !== showCat.has(x.id) || (showCat.has(x.id) && showCat.get(x.id) !== x.collection)
    || (!showCat.has(x.id) && !['othertv', 'truecrime'].includes(x.collection)))), 'show recovery entries disagree with what the backup’s catalogs govern.');
  say(count(items, w => w.show_id && itemMap.has(w.id) && showMap.has(w.show_id) && itemMap.get(w.id) !== showMap.get(w.show_id)), 'season recovery entries disagree with their show’s.');
  const isFilm = w => w.media_type === 'movie' || (w.media_type == null && w.season === 'Film');
  say(count(items, w => isFilm(w) && itemMap.has(w.id) && (builtin(itemMap.get(w.id)) !== filmCat.has(w.id) || (filmCat.has(w.id) && filmCat.get(w.id) !== itemMap.get(w.id))
    || ((w.theme_kind === 'genre') !== (itemMap.get(w.id) === 'movies')))), 'film recovery entries disagree with the backup’s catalogs or theme meanings.');
  const colMap = new Map(sm.personal_collections.map(x => [x.id, x.legacy_source]));
  say(count(cols, c => !colMap.has(c.id)), 'collections have no recovery entry.');
  say(count(sm.personal_collections, x => { const c = cols.find(y => y.id === x.id);
    return !c || (x.legacy_source != null && !['disney', '90day', 'sheridan', 'truecrime'].includes(x.legacy_source)) || (c.catalog_id != null && x.legacy_source !== c.catalog_id)
      || (c.catalog_id == null && builtin(x.legacy_source)) || (c.presentation_key ?? null) !== (x.legacy_source ?? null); }), 'collection recovery entries disagree with the backup’s collections.');
  say(repeats(sm.personal_collections), 'collection recovery entries repeat a collection.');
  const otv = r.othertv_shows;
  say(count(otv, x => recoveryUuidDigits(x.id) === null), 'other-TV recovery rows have an id that isn’t a valid lowercase uuid.');
  say(count(otv, x => recoveryTmdbId(x.tmdb_id) === null), 'other-TV recovery rows have a TMDB id that isn’t a whole number from 0 to 2147483647.');
  say(count(otv, x => !recoveryTimestampOk(x.created_at)), 'other-TV recovery rows have a created_at that isn’t a valid date and time.');
  say(count(otv, x => !['othertv', 'truecrime'].includes(x.collection)), 'other-TV recovery rows have a storage other than othertv or truecrime.');
  say(count(otv, x => { const t = recoveryTextOf(x.title); return t === null || t.replace(/^ +| +$/g, '') === '' || !recoveryNoNul(t); }), 'other-TV recovery rows have a title that is blank or can’t be stored.');
  say(count(otv, x => typeof x.network !== 'string' || !recoveryNoNul(x.network)), 'other-TV recovery rows have a network that isn’t text that can be stored.');
  const ids = otv.map(x => recoveryUuidDigits(x.id)).filter(Boolean);
  say(ids.length - new Set(ids).size, 'other-TV recovery rows repeat an id.');
  const otvShows = otv.filter(x => recoveryTmdbId(x.tmdb_id) !== null).map(x => `${x.collection}|${recoveryTmdbId(x.tmdb_id)}`);
  say(otvShows.length - new Set(otvShows).size, 'other-TV recovery rows repeat a show.');
  return out.length ? [`Its recovery section doesn’t correspond to the backup: ${out.join(' ')}`] : [];
}
// ── recovery section check: end ──

// The preview's list of what the format-4 → 5 conversion derives.
function format4ConversionHtml(summary) {
  const li = text => `<li>${esc(text)}</li>`;
  const n = k => summary.tally[k] || 0;
  return `<div class="modal-section"><div class="modal-label">This backup is converted to format 5 before restoring</div><ul class="manage-list">
    ${n('show:pending') + n('film:pending') ? li(`${n('show:pending')} shows and ${n('film:pending')} films that were Pending: To Watch, marked New from catalog.`) : ''}
    ${n('show:highpriority') + n('film:highpriority') ? li(`${n('show:highpriority')} shows and ${n('film:highpriority')} films that were High Priority: To Watch, High priority.`) : ''}
    ${n('show:maybe') + n('film:maybe') ? li(`${n('show:maybe')} shows and ${n('film:maybe')} films that were Maybe Later: To Watch, Low priority.`) : ''}
    ${n('show:complete') ? li(`${n('show:complete')} shows that were Complete: To Watch, Show ended, Needs status review.`) : ''}
    ${n('film:watching') + n('film:complete') ? li(`${n('film:watching') + n('film:complete')} films that were Watching or Complete: To Watch or Watched (as marked), Needs status review.`) : ''}
    ${summary.pairs ? li(`${summary.pairs} films that are both Skipped and marked watched are kept that way.`) : ''}
    ${summary.review.length ? li(`Needs status review: ${summary.review.slice(0, 10).join(', ')}${summary.review.length > 10 ? ` and ${summary.review.length - 10} more` : ''}.`) : ''}
    ${li('Each old status is kept with the record (for a rollback); no categories or earlier-seasons ranges are added. No field of the backup is lost.')}
    ${li('The file itself isn’t changed.')}</ul></div>`;
}

// Format 4: identities unique across the whole library, one season label per show,
// theme meanings only on films, the catalog governance (one catalog per record,
// one record per catalog key), shows and links, collections and choices.
function validateFormat4Rows(tables, items, report, rowLabel, findDuplicates, statuses = TV_SHOW_STATUSES) {
  const shows = tables.tv_shows.filter(r => r && typeof r === 'object');
  checkTvShowRows(shows, items, report, rowLabel, statuses);
  validateOrganizationRows(tables, items, report, rowLabel, findDuplicates);
  report('watchlist_items duplicate movie identity', findDuplicates(items, r => r.media_type === 'movie' && r.tmdb_id != null ? String(r.tmdb_id) : null, r => `(tmdb_id ${r.tmdb_id})`));
  report('watchlist_items duplicate TV identity', findDuplicates(items, r => r.media_type === 'tv' && r.tmdb_id != null && r.season_number != null ? `${r.tmdb_id}|${r.season_number}` : null,
    r => `(tmdb_id ${r.tmdb_id}, season ${r.season_number})`));
  report('watchlist_items duplicate season of a show', findDuplicates(items, r => r.show_id != null ? `${r.show_id}|${r.item_key}` : null, r => `(show ${r.show_id}, item_key "${r.item_key}")`));
  report('tv_shows duplicate identified show', findDuplicates(shows, s => s.tmdb_id != null ? String(s.tmdb_id) : null, s => `(tmdb_id ${s.tmdb_id})`));
  const isFilm = r => r.media_type === 'movie' || (r.media_type == null && r.season === 'Film');
  report('watchlist_items theme_kind', items.map((r, i) => (isFilm(r) ? ['genre', 'other'].includes(r.theme_kind) : r.theme_kind === null) ? null
    : `${rowLabel(r, i)} has theme_kind ${JSON.stringify(r.theme_kind)}`).filter(Boolean));
  report('watchlist_items kind', items.map((r, i) => isFilm(r) || r.show_id != null ? null : `${rowLabel(r, i)} is neither a film nor a linked TV season`).filter(Boolean));
  const showIds = new Set(shows.map(s => s.id)), itemsById = new Map(items.map(r => [r.id, r]));
  const sl = tables.catalog_show_links.filter(r => r && typeof r === 'object'), fl = tables.catalog_film_links.filter(r => r && typeof r === 'object');
  const linkProblems = [];
  sl.forEach((l, i) => {
    if (!CATALOG_GOVERNANCE_IDS.includes(l.catalog)) linkProblems.push(`show link ${rowLabel(l, i)} has catalog ${JSON.stringify(l.catalog)}`);
    if (!showIds.has(l.show_id)) linkProblems.push(`show link ${rowLabel(l, i)} points at show ${l.show_id}, which isn't in the backup`);
    if (!['migrated_from_storage', 'catalog_insert'].includes(l.origin)) linkProblems.push(`show link ${rowLabel(l, i)} has origin ${JSON.stringify(l.origin)}`);
  });
  fl.forEach((l, i) => {
    if (!CATALOG_GOVERNANCE_IDS.includes(l.catalog)) linkProblems.push(`film link ${rowLabel(l, i)} has catalog ${JSON.stringify(l.catalog)}`);
    const r = itemsById.get(l.item_id);
    if (!r || !isFilm(r)) linkProblems.push(`film link ${rowLabel(l, i)} points at ${r ? 'a row that isn’t a film' : `row ${l.item_id}, which isn't in the backup`}`);
    if (!['migrated_from_storage', 'catalog_insert'].includes(l.origin)) linkProblems.push(`film link ${rowLabel(l, i)} has origin ${JSON.stringify(l.origin)}`);
  });
  report('catalog governance', linkProblems);
  report('catalog_show_links one catalog per show', findDuplicates(sl, l => l.show_id, l => `(show ${l.show_id})`));
  report('catalog_show_links one show per catalog key', findDuplicates(sl, l => `${l.catalog}|${l.catalog_key}`, l => `(${l.catalog} "${l.catalog_key}")`));
  report('catalog_film_links one catalog per film', findDuplicates(fl, l => l.item_id, l => `(film ${l.item_id})`));
  report('catalog_film_links one film per catalog key', findDuplicates(fl, l => `${l.catalog}|${l.entry_key}`, l => `(${l.catalog} "${l.entry_key}")`));
  const colls = tables.personal_collections.filter(r => r && typeof r === 'object');
  report('personal_collections catalog', colls.map((c, i) => c.catalog_id == null || CATALOG_GOVERNANCE_IDS.includes(c.catalog_id) ? null : `${rowLabel(c, i)} has catalog_id ${JSON.stringify(c.catalog_id)}`).filter(Boolean));
  report('personal_collections duplicate catalog', findDuplicates(colls, c => c.catalog_id ?? null, c => `"${c.catalog_id}"`));
  // presentation_key: how the page presents a collection it has always known (note, layout key); never placement.
  report('personal_collections presentation', colls.map((c, i) => c.presentation_key == null || PRESENTATION_KEYS.includes(c.presentation_key) ? null
    : `${rowLabel(c, i)} has presentation_key ${JSON.stringify(c.presentation_key)}`).filter(Boolean));
  report('personal_collections duplicate presentation', findDuplicates(colls, c => c.presentation_key ?? null, c => `"${c.presentation_key}"`));
  report('personal_collections catalog vs presentation', colls.map((c, i) => c.catalog_id != null && c.presentation_key !== c.catalog_id
    ? `${rowLabel(c, i)} has catalog_id ${JSON.stringify(c.catalog_id)} but presentation_key ${JSON.stringify(c.presentation_key)}` : null).filter(Boolean));
}

// Format 3 only: collections, memberships and watch-with choices, mirroring the
// database's rules (exactly one target that is in the backup and of the right
// kind, one membership per collection and target, names and labels unique
// ignoring case, every watch-with value on a row is a choice).
function validateOrganizationRows(tables, items, report, rowLabel) { // formats 3 and 4
  const colls = tables.personal_collections.filter(r => r && typeof r === 'object');
  const members = tables.collection_memberships.filter(r => r && typeof r === 'object');
  const choices = tables.watch_with_choices.filter(r => r && typeof r === 'object');
  const showIds = new Set(tables.tv_shows.filter(r => r && typeof r === 'object').map(s => s.id));
  const itemsById = new Map(items.map(r => [r.id, r]));
  const collIds = new Set(colls.map(c => c.id));
  const trimmedText = v => typeof v === 'string' && v.trim() === v && v !== '';
  const dupBy = (rows, keyOf, describe) => {
    const seen = new Map(), dups = [];
    rows.forEach((r, i) => { const k = keyOf(r); if (k === null) return; if (seen.has(k)) dups.push(`${describe(r)} on ${rowLabel(rows[seen.get(k)], seen.get(k))} and ${rowLabel(r, i)}`); else seen.set(k, i); });
    return dups;
  };
  report('personal_collections name', colls.map((c, i) => trimmedText(c.name) && c.name.length <= 100 ? null : `${rowLabel(c, i)} has name ${JSON.stringify(c.name)}`).filter(Boolean));
  report('personal_collections duplicate name (ignoring case)', dupBy(colls, c => typeof c.name === 'string' ? c.name.toLowerCase() : null, c => `"${c.name}"`));
  const memberProblems = [];
  members.forEach((m, i) => {
    if ((m.show_id == null) === (m.item_id == null)) { memberProblems.push(`${rowLabel(m, i)} must have exactly one of show_id and item_id`); return; }
    if (!collIds.has(m.collection_id)) memberProblems.push(`${rowLabel(m, i)} is in collection ${m.collection_id}, which isn't in the backup`);
    if (m.show_id != null && !showIds.has(m.show_id)) memberProblems.push(`${rowLabel(m, i)} points at show ${m.show_id}, which isn't in the backup`);
    if (m.item_id != null) {
      const r = itemsById.get(m.item_id);
      if (!r) memberProblems.push(`${rowLabel(m, i)} points at row ${m.item_id}, which isn't in the backup`);
      else if (!(r.media_type === 'movie' || (r.media_type == null && r.season === 'Film'))) memberProblems.push(`${rowLabel(m, i)} points at row ${m.item_id}, which isn't a film`);
    }
  });
  report('collection_memberships', memberProblems);
  report('collection_memberships duplicate', dupBy(members, m => JSON.stringify([m.collection_id, m.show_id ?? null, m.item_id ?? null]),
    m => `(collection ${m.collection_id}, ${m.show_id != null ? `show ${m.show_id}` : `film ${m.item_id}`})`));
  report('watch_with_choices token or label', choices.map((c, i) => trimmedText(c.token) && trimmedText(c.label) && c.label.length <= 100 ? null : rowLabel(c, i)).filter(Boolean));
  report('watch_with_choices duplicate token', dupBy(choices, c => typeof c.token === 'string' ? c.token : null, c => `"${c.token}"`));
  report('watch_with_choices duplicate label (ignoring case)', dupBy(choices, c => typeof c.label === 'string' ? c.label.toLowerCase() : null, c => `"${c.label}"`));
  const tokens = new Set(choices.map(c => c.token));
  report('watchlist_items watch_with', items.flatMap((r, i) => (r.watch_with || []).filter(t => !tokens.has(t))
    .map(t => `${rowLabel(r, i)} uses "${t}", which isn't one of the backup's watch-with choices`)));
}

// Formats 2–4: the shows and the season → show links, mirroring the database's
// rules (statuses, every link points at a show in the backup, films never link,
// skipped only on linked seasons). The identity keys per format are checked by the caller.
function validateTvShowRows(shows, items, report, rowLabel) {
  checkTvShowRows(shows, items, report, rowLabel, TV_SHOW_STATUSES);
}
// The same rules with a given set of show statuses (format 5: To Watch / Watching / Skipped).
// (backup-format3.js, unchanged since Stage 5, calls validateTvShowRows with the old set.)
function checkTvShowRows(shows, items, report, rowLabel, statuses) {
  const byId = new Map(shows.map(s => [s.id, s]));
  report('tv_shows status', shows.map((s, i) => statuses.includes(s.status) ? null : `${rowLabel(s, i)} has status ${JSON.stringify(s.status)}`).filter(Boolean));
  report('tv_shows empty title or show_key', shows.map((s, i) => (typeof s.title === 'string' && s.title.trim() && typeof s.show_key === 'string' && s.show_key.trim()) ? null : rowLabel(s, i)).filter(Boolean));
  const linkProblems = [];
  items.forEach((r, i) => {
    const isFilm = r.season === 'Film' || r.media_type === 'movie';
    if (r.show_id != null) {
      const show = byId.get(r.show_id);
      if (!show) linkProblems.push(`${rowLabel(r, i)} links to show ${r.show_id}, which isn't in the backup`);
      if (isFilm) linkProblems.push(`${rowLabel(r, i)} is a film but links to a show`);
    } else if (r.skipped === true) {
      linkProblems.push(`${rowLabel(r, i)} is skipped but has no show`);
    }
  });
  report('watchlist_items show links', linkProblems);
}

// Compares the backup with the data currently in the database. Refuses a restore that
// would strip TMDB identity: rows identified now that come back unidentified, or a
// backup with no identified rows at all while the database has some.
function identityLossErrors(currentItems, backupItems) {
  const currentIdentified = currentItems.filter(r => r.tmdb_id != null);
  if (currentIdentified.length === 0) return [];
  const backupById = new Map(backupItems.map(r => [r.id, r]));
  const lost = currentIdentified.filter(r => backupById.has(r.id) && backupById.get(r.id).tmdb_id == null);
  const backupIdentified = backupItems.filter(r => r.tmdb_id != null).length;
  if (lost.length === 0 && backupIdentified > 0) return [];
  const examples = lost.slice(0, 3).map(r => `"${r.title} ${r.season}"`).join(', ');
  return [`This backup would discard TMDB identity: ${currentIdentified.length} row(s) are identified now, the backup has ${backupIdentified}` +
    (lost.length ? `, and ${lost.length} existing row(s) would lose their identity (e.g. ${examples})` : '') +
    '. It probably predates the TMDB identity migration, so it can\'t be used.'];
}

// A restore being prepared (file read, preview, safety backup) belongs to the
// view it started in. Navigating abandons it (invalidateRestorePreparation), and
// every step re-checks after each await, so a late step can't open a dialog or
// download anything, least of all in a read-only browse view. Once restore_backup
// has been sent, navigation no longer interrupts it.
function restoreSessionLive(session) {
  return session === restoreSessionSeq && restoreEligibleView();
}

function invalidateRestorePreparation() {
  if (restoreInFlight) return;
  restoreSessionSeq++;
  if (pendingRestoreData || document.getElementById('restoreModalOverlay')?.style.display === 'flex') closeRestoreModal();
}

async function handleRestoreFileSelected(event) {
  const file = event.target.files[0];
  event.target.value = ''; // allow re-selecting the same file later
  if (!file || !restoreEligibleView()) return;
  const session = ++restoreSessionSeq;

  let parsed, sourceSha256;
  try {
    const text = await file.text();
    if (!restoreSessionLive(session)) return;
    parsed = JSON.parse(text);
    sourceSha256 = await catalogSha256(text);
    if (!restoreSessionLive(session)) return;
  } catch(e) {
    if (!restoreSessionLive(session)) return;
    showRestoreModal(`<div class="modal-title">Invalid backup file</div>
      <div class="modal-error">Couldn't parse this file as JSON: ${esc(e.message)}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }

  const errors = validateBackupObject(parsed);
  if (errors.length > 0) {
    showRestoreModal(`<div class="modal-title">This file can't be used for restore</div>
      <div class="modal-error">${errors.map(esc).join('\n')}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }

  pendingRestoreData = parsed;
  await renderRestorePreview(parsed, session, sourceSha256);
}

// A format-3 file on a contracted database (format 4) is converted first
// (backup-format3.js): the preview shows what the conversion derives and what it
// can't keep, and only the converted document is ever sent. Nothing is converted or
// sent again automatically if the database refuses it.
async function renderRestorePreview(backup, session = restoreSessionSeq, sourceSha256 = null) {
  if (!restoreSessionLive(session)) return;
  showRestoreModal(`<div class="modal-title">Checking current data…</div><div class="modal-progress">Fetching current row counts for comparison…</div>`);

  let currentCounts = {};
  let currentItems = [];
  let dbFormat;
  try {
    // A restore needs a database in this page's phase (format 6); formats 3, 4 and 5 are
    // converted here first. Never a fallback to another format.
    const phaseCap = await stage5Capabilities();
    if (!restoreSessionLive(session)) return;
    if (!pageMayWrite(phaseCap)) {
      showRestoreModal(`<div class="modal-title">Restore isn't available</div>
        <div class="modal-error">${b45Stopped ? esc(STATE_MISMATCH_TEXT) : phaseCap
          ? 'This page restores only into a database in its own state (format 6), and this database isn’t in it, so it can’t restore here. Nothing was changed. Reload the page.'
          : 'This page needs a database update that hasn’t been made yet, so it can’t restore here. Nothing was changed.'}</div>
        <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
      pendingRestoreData = null;
      return;
    }
    dbFormat = await detectBackupFormat();
    if (!restoreSessionLive(session)) return;
    for (const table of backupSpec(dbFormat).tables) {
      const rows = await fetchAllRows(table);
      if (!restoreSessionLive(session)) return;
      currentCounts[table] = rows.length;
      if (table === 'watchlist_items') currentItems = rows;
    }
  } catch(e) {
    if (!restoreSessionLive(session)) return;
    showRestoreModal(`<div class="modal-title">Couldn't check current data</div>
      <div class="modal-error">${esc(e.message)}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }

  // Formats 3, 4 and 5 into the EP1 database: an explicit, previewed conversion (3 → 4 with
  // the retained converter, 4 → 5, then 5 → 6). Only the converted document is ever sent.
  let conversion = null, conversion5 = null, conversion6 = false;
  const refuseConversion = (lines) => {
    showRestoreModal(`<div class="modal-title">This format ${backup.formatVersion} backup can't be converted</div>
      <div class="modal-error">${lines.map(esc).join('\n')}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    pendingRestoreData = null;
  };
  if (dbFormat === 6 && [3, 4, 5].includes(backup.formatVersion)) {
    let cap;
    try { cap = await stage5Capabilities(); } catch (e) { cap = null; }
    if (!restoreSessionLive(session)) return;
    if (!cap) { refuseConversion(['Couldn’t read whether the recovery archive is active, so nothing was changed.']); return; }
    // The conversion record names the file it came from (its SHA-256, computed when the file was read).
    if (!/^[0-9a-f]{64}$/.test(sourceSha256 || '')) { refuseConversion(['The file’s fingerprint couldn’t be computed, so nothing was changed. Choose the file again.']); return; }
    let doc5 = backup;
    if (backup.formatVersion === 3 || backup.formatVersion === 4) {
      let doc4 = backup;
      if (backup.formatVersion === 3) {
        const conv = convertFormat3To4(backup, { includeRecovery: cap.recovery_archive === 'active', sourceSha256 });
        if (conv.refusals.length) { refuseConversion(['It breaks a rule your updated list enforces, so nothing was changed:'].concat(conv.refusals)); return; }
        conversion = conv.summary;
        doc4 = conv.doc;
      } else {
        const problems = format4SectionProblems(backup, cap.recovery_archive === 'active');
        if (problems.length) { refuseConversion(['Nothing was changed:'].concat(problems)); return; }
      }
      const conv5 = convertFormat4To5(doc4, { sourceSha256 });
      if (conv5.refusals.length) { refuseConversion(['It breaks a rule your list enforces, so nothing was changed:'].concat(conv5.refusals)); return; }
      conversion5 = conv5.summary;
      doc5 = conv5.doc;
    } else if (backup.conversion !== undefined || backup.recovery !== undefined) {
      // A format-5 file carrying a conversion record or a recovery section (possible only by hand
      // or from a converted document saved elsewhere): checked as the database checks them first.
      const problems = sectionProblems(backup, cap.recovery_archive === 'active', ['3', '4']);
      if (problems.length) { refuseConversion(['Nothing was changed:'].concat(problems)); return; }
    }
    const conv6 = convertFormat5To6(doc5, { sourceSha256 });
    const docErrors = validateBackupObject(conv6.doc);
    if (docErrors.length) { refuseConversion(['The converted backup doesn’t pass validation, so nothing was changed:'].concat(docErrors)); return; }
    if (conv6.doc.recovery !== undefined) {
      const rp = recoverySectionProblems(conv6.doc);
      if (rp.length) { refuseConversion(['Nothing was changed:'].concat(rp)); return; }
    }
    conversion6 = true;
    backup = conv6.doc;
    pendingRestoreData = backup;
  }
  // A format-6 file carrying a conversion record or a recovery section (possible only by hand
  // or from a converted document saved elsewhere): checked as the database checks them first.
  if (dbFormat === 6 && backup.formatVersion === 6 && !conversion6 && (backup.conversion !== undefined || backup.recovery !== undefined)) {
    let cap;
    try { cap = await stage5Capabilities(); } catch (e) { cap = null; }
    if (!restoreSessionLive(session)) return;
    const problems = cap ? sectionProblems(backup, cap.recovery_archive === 'active', ['3', '4', '5'])
      : ['Couldn’t read whether the recovery archive is active, so nothing was changed.'];
    if (problems.length) {
      showRestoreModal(`<div class="modal-title">This file can't be used for restore</div>
        <div class="modal-error">${problems.map(esc).join('\n')} Nothing was changed.</div>
        <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
      pendingRestoreData = null;
      return;
    }
  }

  // A format-2 backup needs the TV-show schema. Since the switch to show-level
  // status, a TV show's status lives only in tv_shows, so a format-1 backup (which
  // has none) can't be restored into a format-2 database; the database refuses it too.
  // A format-3 database (personal collections) takes format 3 only: an older file
  // has none of your collections or watch-with choices; the database refuses it too.
  // A contracted database takes format 4 (or a converted format 3, above).
  const formatErrors = backup.formatVersion > dbFormat
    ? [`This backup is format ${backup.formatVersion}, which this database doesn't support yet (it is format ${dbFormat}).`]
    : backup.formatVersion < dbFormat
      ? [dbFormat >= 3 && backup.formatVersion === 2
        ? 'This backup is format 2, from before personal collections: it has none of your collections or watch-with choices, so it can\'t be restored here. Restore a format 3 backup (made after the personal-collections update) instead. Nothing was changed.'
        : `This backup predates TV shows (format ${backup.formatVersion}). TV show status is now stored per show, so only format ${dbFormat} backups can be restored.`]
      : [];
  const lossErrors = formatErrors.concat(identityLossErrors(currentItems, backup.tables.watchlist_items));
  if (lossErrors.length > 0) {
    showRestoreModal(`<div class="modal-title">This file can't be used for restore</div>
      <div class="modal-error">${lossErrors.map(esc).join('\n')}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    pendingRestoreData = null;
    return;
  }
  pendingRestoreAllowV1Reset = false;
  pendingRestoreDbFormat = dbFormat;

  const backupDate = new Date(backup.exportedAt).toLocaleString();
  // EP1: episode marks are replaced like everything else; say so plainly when the file has fewer.
  const marksNow = currentCounts.episode_marks || 0, marksFile = (backup.tables.episode_marks || []).length;
  const marksNote = marksNow > marksFile
    ? `<div class="modal-warning">Your library has ${marksNow} episode mark${marksNow === 1 ? '' : 's'} now; this backup has ${marksFile}. Restoring replaces them with the backup’s. The safety backup keeps the current ones.</div>`
    : '';
  const tables = [...new Set([...backupSpec(dbFormat).tables, ...backupSpec(backup.formatVersion).tables])];
  const rows = tables.map(t => `
    <div class="modal-row"><span>${esc(t)}</span><span>${currentCounts[t] ?? 0} → ${backup.tables[t] ? (backup.rowCounts[t] ?? backup.tables[t].length) : 0}</span></div>
  `).join('');

  showRestoreModal(`
    <div class="modal-title">Restore from backup?</div>
    <div class="modal-section">
      <div class="modal-label">Backup created</div>
      <div>${esc(backupDate)}</div>
    </div>
    ${conversion ? format3ConversionHtml(conversion) : ''}
    ${conversion5 ? format4ConversionHtml(conversion5) : ''}
    ${conversion6 ? format5ConversionHtml() : ''}
    <div class="modal-section">
      <div class="modal-label">Rows: current → backup</div>
      ${rows}
    </div>
    ${marksNote}
    <div class="modal-warning">This will permanently replace all current data in these ${tables.length} tables with the contents of this backup. A safety backup of your current data will be downloaded automatically before anything is changed.</div>
    <div class="modal-actions">
      <button class="btn" onclick="closeRestoreModal()">Cancel</button>
      <button class="btn-danger" id="confirmRestoreBtn" onclick="executeRestore()">Restore database</button>
    </div>
  `);
}

function showRestoreModal(html) {
  document.getElementById('restoreModalBox').innerHTML = html;
  document.getElementById('restoreModalOverlay').style.display = 'flex';
}
function closeRestoreModal() {
  document.getElementById('restoreModalOverlay').style.display = 'none';
  document.getElementById('restoreModalBox').innerHTML = '';
  pendingRestoreData = null;
  pendingRestoreAllowV1Reset = false;
  pendingRestoreDbFormat = null;
  restoreInFlight = false;
  if (typeof updateLeaveWarning === 'function') updateLeaveWarning(); // S6 (D18)
}

async function executeRestore() {
  const backup = pendingRestoreData;
  if (!backup || !restoreEligibleView()) { closeRestoreModal(); return; }
  const session = restoreSessionSeq;

  const confirmBtn = document.getElementById('confirmRestoreBtn');
  if (confirmBtn) confirmBtn.disabled = true;

  const setProgress = (msg) => {
    showRestoreModal(`<div class="modal-title">Restoring…</div><div class="modal-progress">${esc(msg)}</div>`);
  };

  // ── Step 1: automatic safety backup of the CURRENT live data, before anything is touched ──
  setProgress('Backing up your current data first (safety copy)…');
  let preRestoreBackup;
  try {
    preRestoreBackup = await buildBackupObject();
    if (!restoreSessionLive(session)) return;
  } catch(e) {
    if (!restoreSessionLive(session)) return;
    showRestoreModal(`<div class="modal-title">Restore aborted</div>
      <div class="modal-error">Couldn't create a safety backup of your current data, so nothing was changed:\n${esc(e.message)}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }
  // The database must still be in the format the preview checked against (an update
  // in between means the preview no longer applies; nothing is sent or retried).
  if (pendingRestoreDbFormat != null && preRestoreBackup.formatVersion !== pendingRestoreDbFormat) {
    showRestoreModal(`<div class="modal-title">Restore aborted</div>
      <div class="modal-error">The database was updated after this restore was prepared, so nothing was changed. Choose the file again to see what restoring it would do now.</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }
  // The safety copy must itself be a restorable backup, and the backup being restored
  // must not strip identity from the data as it stands right now.
  const safetyErrors = validateBackupObject(preRestoreBackup);
  if (safetyErrors.length > 0) {
    showRestoreModal(`<div class="modal-title">Restore aborted</div>
      <div class="modal-error">The safety backup of your current data didn't pass validation, so nothing was changed:\n${safetyErrors.map(esc).join('\n')}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }
  const lossErrors = identityLossErrors(preRestoreBackup.tables.watchlist_items, backup.tables.watchlist_items);
  if (lossErrors.length > 0) {
    showRestoreModal(`<div class="modal-title">Restore aborted</div>
      <div class="modal-error">Nothing was changed:\n${lossErrors.map(esc).join('\n')}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }
  const preRestoreFilename = `watchlist-pre-restore-${timestampForFilename()}.json`;
  try {
    downloadJSON(preRestoreBackup, preRestoreFilename);
    pendingSafetyBackup = { filename: preRestoreFilename, doc: preRestoreBackup };
  } catch(e) {
    showRestoreModal(`<div class="modal-title">Restore aborted</div>
      <div class="modal-error">The safety backup couldn't be downloaded, so nothing was changed:\n${esc(e.message)}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }

  // ── Pause here: do not proceed to any destructive step until the user has
  // explicitly confirmed they can see the safety backup file. pendingRestoreData
  // (the validated backup to restore) is untouched and still available — we're
  // only waiting on a click, not discarding any state.
  showRestoreModal(`
    <div class="modal-title">Safety backup downloaded</div>
    <div class="modal-section">
      <div class="modal-label">Filename</div>
      <div style="font-family:monospace; font-size:13px; word-break:break-all;">${esc(preRestoreFilename)}</div>
    </div>
    <div class="modal-warning">Before continuing: please check your Downloads folder (or wherever your browser saves files) and confirm you can see this file. This is your only copy of your current data if anything goes wrong with the restore.</div>
    <div class="modal-actions">
      <button class="btn" onclick="closeRestoreModal()">Cancel</button>
      <button class="btn-danger" onclick="continueRestoreAfterSafetyConfirm('${esc(preRestoreFilename).replace(/'/g,"\\'")}')">I have the backup — continue restore</button>
    </div>
  `);
}

// One change at a time (write-lane.js): no other change runs from the phase check before
// sending to the end of verification, and no read that overlapped the restore publishes.
async function continueRestoreAfterSafetyConfirm(preRestoreFilename) {
  if (!pendingRestoreData || !restoreEligibleView()) { closeRestoreModal(); return; }
  if (writeLane) {
    showRestoreModal(`<div class="modal-title">Restore not sent</div>
      <div class="modal-error">${esc(LANE_BUSY_TEXT(writeLane.label))} Nothing was restored; continue again when it has finished.</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button>
        <button class="btn-danger" onclick="continueRestoreAfterSafetyConfirm('${esc(preRestoreFilename).replace(/'/g, "\\'")}')">Continue restore</button></div>`);
    return;
  }
  return runWrite('Restore', () => sendRestore(preRestoreFilename));
}

async function sendRestore(preRestoreFilename) {
  const backup = pendingRestoreData;
  if (!backup || !restoreEligibleView()) { closeRestoreModal(); return; }
  // The preparation this continuation belongs to (S1 review): after the awaited phase read
  // below, a navigation (which abandoned it) or a newer preparation means it returns
  // without any dialog or send, leaving the current view and any newer restore alone.
  const session = restoreSessionSeq;

  const setProgress = (msg) => {
    showRestoreModal(`<div class="modal-title">Restoring…</div><div class="modal-progress">${esc(msg)}</div>`);
  };

  // ── Step 2: replace every table in one database transaction ──
  // restore_backup (db/phase0_restore_v1.sql) deletes and re-inserts all tables
  // atomically: if anything fails, the database rolls back to exactly what it was.
  const restoredTables = backupSpec(backup.formatVersion).tables;
  // The phase is read again right before sending: it must still be this page's, and only
  // a format-6 document is ever sent (formats 3, 4 and 5 were converted in the preview).
  // Nothing is sent otherwise.
  let sendCap = null;
  try { sendCap = await stage5Capabilities(); } catch (e) { sendCap = null; }
  if (!restoreSessionLive(session) || pendingRestoreData !== backup) return;
  if (!pageMayWrite(sendCap) || backup.formatVersion !== 6 || !pendingRestoreData) {
    showRestoreModal(`<div class="modal-title">Restore not sent</div>
      <div class="modal-error">The database’s update state ${sendCap ? 'changed after this restore was prepared' : 'couldn’t be confirmed'}, so nothing was sent and nothing was changed. Choose the file again to see what restoring it would do now.</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }
  setProgress(`Restoring ${restoredTables.length} tables…`);
  restoreInFlight = true; // sent to the database: navigation no longer abandons it
  if (typeof updateLeaveWarning === 'function') updateLeaveWarning(); // S6 (D18): leaving now may leave its outcome unknown
  try {
    await sbFetch('POST', 'rpc/restore_backup', { p_backup: backup, p_allow_v1_reset: pendingRestoreAllowV1Reset === true },
      { what: 'Restore from a backup file', note: { safetyBackup: preRestoreFilename } });
    // Collections and watch-with choices read before this point are stale now, and an open
    // Details dialog can no longer save its draft.
    if (orgState !== 'absent') invalidateOrganization();
    if (typeof detailsDialog !== 'undefined' && detailsDialog) { detailsDialog.restored = true; renderDetails(); }
  } catch(e) {
    // M1: only a refusal (or a restore never sent) means nothing was changed. With no confirmed
    // answer the outcome is unknown: the transaction is atomic, but it may still have committed,
    // or still be running. What the library matches now is reported as an observation only.
    if (writeOutcomeOf(e) !== 'unknown') {
      showRestoreModal(`<div class="modal-title">Restore failed — nothing was changed</div>
      <div class="modal-error">${esc(e.message)}

The restore was refused (or never sent), so your data is as it was before. The safety backup is still in your downloads as:
${esc(preRestoreFilename)}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
      return;
    }
    if (orgState !== 'absent') invalidateOrganization();
    if (typeof detailsDialog !== 'undefined' && detailsDialog) { detailsDialog.restored = true; renderDetails(); }
    setProgress('No answer from the database. Checking what your library matches now…');
    const safety = pendingSafetyBackup && pendingSafetyBackup.filename === preRestoreFilename ? pendingSafetyBackup.doc : null;
    const seen = await observeLibraryAgainst(restoredTables, backup, safety);
    showRestoreModal(`<div class="modal-title">Restore outcome unknown</div>
      <div class="modal-error">The restore got no answer (${esc(e.message)}), so it may or may not have been made. It was not sent again.

${esc(seen)}

This is what the library looks like right now; it doesn’t show whether the restore request finished. It could still be running and finish later. Check your library before making changes. The safety backup of your data from before the restore is in your downloads as:
${esc(preRestoreFilename)}</div>
      <div class="modal-actions"><button class="btn" onclick="finishRestoreAndReload()">Close &amp; reload data</button></div>`);
    return;
  }

  // ── Step 3: re-fetch and verify against the backup before declaring success ──
  setProgress('Verifying restored data…');
  const verificationErrors = [];
  try {
    for (const table of restoredTables) {
      const restoredRows = await fetchAllRows(table);
      const expectedRows = backup.tables[table];
      if (restoredRows.length !== expectedRows.length) {
        verificationErrors.push(`${table}: expected ${expectedRows.length} rows, found ${restoredRows.length}.`);
        continue;
      }
      const restoredById = new Map(restoredRows.map(r => [r.id, r]));
      const missingIds = expectedRows.filter(r => !restoredById.has(r.id));
      if (missingIds.length > 0) {
        verificationErrors.push(`${table}: ${missingIds.length} expected row(s) not found after restore.`);
        continue;
      }
      // Every expected row exists by id — now compare every backed-up field
      // value exactly, not just presence. Report per-row field mismatches,
      // capped to the first 10 for readability, with a total count if more exist.
      const rowMismatches = [];
      for (const expectedRow of expectedRows) {
        const restoredRow = restoredById.get(expectedRow.id);
        const diffFields = compareRowFields(expectedRow, restoredRow, backupSpec(backup.formatVersion).columns[table]);
        if (diffFields.length > 0) {
          rowMismatches.push({ id: expectedRow.id, fields: diffFields });
        }
      }
      if (rowMismatches.length > 0) {
        const shown = rowMismatches.slice(0, 10)
          .map(m => `  • row ${m.id}: ${m.fields.join(', ')}`)
          .join('\n');
        const more = rowMismatches.length > 10 ? `\n  …and ${rowMismatches.length - 10} more row(s) with mismatches.` : '';
        verificationErrors.push(`${table}: ${rowMismatches.length} row(s) have field values that don't match the backup:\n${shown}${more}`);
      }
    }
  } catch(e) {
    verificationErrors.push(`Couldn't complete verification: ${e.message}`);
  }

  if (verificationErrors.length > 0) {
    showRestoreModal(`<div class="modal-title">Restore finished, but verification failed</div>
      <div class="modal-error">The restore ran, but the data afterward didn't match the backup exactly:
${verificationErrors.map(esc).join('\n')}

A safety backup of your data from before this restore was downloaded as:
${esc(preRestoreFilename)}</div>
      <div class="modal-actions"><button class="btn" onclick="finishRestoreAndReload()">Close &amp; reload data</button></div>`);
    return;
  }

  // ── Step 4: success — only reached if delete+insert+verify all passed for every table ──
  showRestoreModal(`<div class="modal-title">Restore completed successfully</div>
    <div class="modal-success">All ${restoredTables.length} tables restored and verified against the backup.
A safety backup of your data from before this restore was saved as:
${esc(preRestoreFilename)}</div>
    <div class="modal-actions"><button class="btn-accent btn" onclick="finishRestoreAndReload()">Close &amp; reload data</button></div>`);
}

// After a restore with no answer: which of the two files the library matches right now (every
// restored table, every backed-up field). An observation, never a verdict on the request.
async function observeLibraryAgainst(tables, fileDoc, safetyDoc) {
  const matchesDoc = (doc, current) => tables.every(t => {
    const want = doc.tables[t] || [], have = current[t] || [];
    if (want.length !== have.length) return false;
    const byId = new Map(have.map(r => [r.id, r]));
    return want.every(r => byId.has(r.id) && compareRowFields(r, byId.get(r.id), backupSpec(doc.formatVersion).columns[t]).length === 0);
  });
  let current = {};
  try {
    for (const t of tables) current[t] = await fetchAllRows(t, null, Object.keys(backupSpec(fileDoc.formatVersion).columns[t]).join(','));
  } catch (e) {
    return `Your library couldn’t be read just now (${e.message}), so it isn’t known what it matches. Reload and check it.`;
  }
  const file = matchesDoc(fileDoc, current), safety = safetyDoc && matchesDoc(safetyDoc, current);
  if (file && safety) return 'Your library currently matches both the restore file and the safety backup (they hold the same data).';
  if (file) return 'Your library currently matches the restore file.';
  if (safety) return 'Your library currently matches the safety backup (your data from before the restore).';
  return 'Your library currently matches neither the restore file nor the safety backup.';
}

// Clears the caches and reloads the open view from Supabase, so the page shows the
// real post-restore state rather than stale in-memory data.
function finishRestoreAndReload() {
  closeRestoreModal();
  closeLibraryPanel(); // anything prepared before the restore no longer applies (library.js)
  tabData = {};
  const organization = loadOrganization(); // the restored collections and watch-with choices (in the background)
  if (typeof isSettingsView === 'function' && isSettingsView()) {
    // Settings (S1): drawn again from the reset state, then its counts once the organization is read.
    renderSettings();
    Promise.resolve(organization).then(() => { if (isSettingsView()) updateSettingsCounts(); }, () => {});
    const head = document.getElementById('settingsTitle');
    if (head && typeof head.focus === 'function') head.focus();
  } else if (typeof isCollectionsStateView === 'function' && isCollectionsStateView()) {
    renderCollectionsState(); // the Collections state (S2): the reloaded collections resolve it when they are published
  } else if (isBrowseView(activeViewId)) loadBrowseView();
  else if (activeViewId) loadDerivedView();
}



function recordBackupTimestamp() {
  try { userStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString()); } catch (e) { /* storage unavailable */ }
  updateBackupAgeIndicator();
}

// The backup status (this device's last backup for the signed-in account, from localStorage; no request): the same
// text and colour in the header link and on Settings (S1).
function backupStatus() {
  let lastStr = null;
  try { lastStr = userStorage.getItem(LAST_BACKUP_KEY); } catch (e) { lastStr = null; }
  if (!lastStr) return { text: 'No backup yet', cls: 'warn' };
  const last = new Date(lastStr);
  const days = Math.floor((Date.now() - last.getTime()) / (1000*60*60*24));
  if (days < 14) return { text: days === 0 ? 'Backed up today' : `Backup: ${days}d ago`, cls: '' };
  if (days < 30) return { text: `Backup: ${days}d ago`, cls: 'warn' };
  return { text: `Backup recommended (${days}d ago)`, cls: 'urgent' };
}

function updateBackupAgeIndicator() {
  const status = backupStatus();
  const el = document.getElementById('backupAgeIndicator');
  if (el) {
    el.textContent = status.text;
    el.className = status.cls ? `backup-age ${status.cls}` : 'backup-age';
  }
  const onSettings = document.getElementById('settingsBackupStatus');
  if (onSettings) {
    onSettings.textContent = status.text;
    onSettings.className = status.cls ? `settings-status ${status.cls}` : 'settings-status';
  }
}
