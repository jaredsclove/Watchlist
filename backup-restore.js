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

// Which backup format the database holds: 4 once Stage 5's contraction has run
// (stage5_capabilities, read with GET), otherwise what backup-format3.js detects
// (3 with personal collections, 2 with TV shows, else 1). Read-only.
async function stage5Capabilities() {
  try { return await sbFetch('GET', 'rpc/stage5_capabilities', null); }
  catch (e) {
    if (/PGRST202|: 404 /.test(String(e && e.message))) return null; // a database before Stage 5
    throw e;
  }
}

async function detectBackupFormat() {
  const cap = await stage5Capabilities();
  if (cap && cap.phase === 'contracted') return 4;
  return detectLegacyBackupFormat();
}

// At boot (doesn't hold up the first view): which phase this database is in. A database
// without the update gets a notice of its own (#phaseBanner), which no view's message replaces.
async function loadStage5Capabilities() {
  try {
    const cap = await stage5Capabilities();
    stage5Phase = cap && STAGE5_WRITABLE_PHASES.includes(cap.phase) ? cap.phase : null;
    const el = document.getElementById('phaseBanner');
    if (el) el.innerHTML = cap ? '' : '<div class="error-banner">⚠️ This page needs a database update that hasn’t been made yet. Your list may not load, and changes are refused until the update is made. Nothing will be changed.</div>';
  } catch (e) { /* unknown: the backup and restore checks read it again */ }
}

// Fetches every row of every table in the database's backup format, asking for the
// format's exact columns (never user_id: a backup is list content, not ownership),
// and assembles the backup JSON object. Does not write anything.
// The format is read before and again after the reads: a database updated in
// between (coexistence → contracted) gives no file at all, never a mix.
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
      // A read refused because the update removed what it asks for is the same case.
      const now = await detectBackupFormat().catch(() => null);
      throw now != null && now !== formatVersion ? updated : e;
    }
    tables[table] = rows;
    rowCounts[table] = rows.length;
  }
  if (await detectBackupFormat() !== formatVersion) throw updated;
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


// ─── Backup button ──────────────────────────────────────────────────────────
async function handleBackupClick() {
  const btn = document.getElementById('backupBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Backing up…';
  try {
    const backup = await buildBackupObject();
    downloadJSON(backup, `watchlist-backup-${timestampForFilename()}.json`);
    recordBackupTimestamp();
    showSaved();
  } catch(e) {
    showError(`Backup failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Restore isn't offered in the read-only browse views (browse-views.js).
function handleRestoreClick() {
  if (isBrowseView(activeViewId)) return;
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
const CATALOG_GOVERNANCE_IDS = ['disney', '90day', 'sheridan'];
const PRESENTATION_KEYS = ['disney', '90day', 'sheridan', 'truecrime'];

// The tables and columns of a format (4 here; 1–3 in backup-format3.js).
function backupSpec(formatVersion) {
  return formatVersion === 4 ? BACKUP_FORMAT_V4 : legacyBackupSpec(formatVersion);
}

const TV_SHOW_STATUSES = ['confirmed', 'highpriority', 'watching', 'complete', 'pending', 'maybe', 'skipped'];

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
  if (formatVersion === 4) validateFormat4Rows(tables, items, report, rowLabel, findDuplicates);
  else validateLegacyBackupRows(tables, formatVersion, report, rowLabel, findDuplicates);
  return errors;
}

// Format 4: identities unique across the whole library, one season label per show,
// theme meanings only on films, the catalog governance (one catalog per record,
// one record per catalog key), shows and links, collections and choices.
function validateFormat4Rows(tables, items, report, rowLabel, findDuplicates) {
  const shows = tables.tv_shows.filter(r => r && typeof r === 'object');
  validateTvShowRows(shows, items, report, rowLabel, findDuplicates);
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
  const byId = new Map(shows.map(s => [s.id, s]));
  report('tv_shows status', shows.map((s, i) => TV_SHOW_STATUSES.includes(s.status) ? null : `${rowLabel(s, i)} has status ${JSON.stringify(s.status)}`).filter(Boolean));
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
  return session === restoreSessionSeq && !isBrowseView(activeViewId);
}

function invalidateRestorePreparation() {
  if (restoreInFlight) return;
  restoreSessionSeq++;
  if (pendingRestoreData || document.getElementById('restoreModalOverlay')?.style.display === 'flex') closeRestoreModal();
}

async function handleRestoreFileSelected(event) {
  const file = event.target.files[0];
  event.target.value = ''; // allow re-selecting the same file later
  if (!file || isBrowseView(activeViewId)) return;
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
    // A restore needs a database whose Stage 5 phase is known (never a fallback to the legacy format).
    const phaseCap = await stage5Capabilities();
    if (!restoreSessionLive(session)) return;
    if (!phaseCap || !STAGE5_WRITABLE_PHASES.includes(phaseCap.phase)) {
      showRestoreModal(`<div class="modal-title">Restore isn't available</div>
        <div class="modal-error">This page needs a database update that hasn’t been made yet, so it can’t restore here. Nothing was changed.</div>
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

  // Format 3 into a contracted database: an explicit, previewed conversion.
  let conversion = null;
  if (dbFormat === 4 && backup.formatVersion === 3) {
    let cap;
    try { cap = await stage5Capabilities(); } catch (e) { cap = null; }
    if (!restoreSessionLive(session)) return;
    const conv = cap ? convertFormat3To4(backup, { includeRecovery: cap.recovery_archive === 'active', sourceSha256 }) : { refusals: ['Couldn’t read whether the recovery archive is active.'] };
    if (conv.refusals.length) {
      showRestoreModal(`<div class="modal-title">This format 3 backup can't be converted</div>
        <div class="modal-error">${['It breaks a rule your updated list enforces, so nothing was changed:'].concat(conv.refusals).map(esc).join('\n')}</div>
        <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
      pendingRestoreData = null;
      return;
    }
    const docErrors = validateBackupObject(conv.doc);
    if (docErrors.length) {
      showRestoreModal(`<div class="modal-title">This format 3 backup can't be converted</div>
        <div class="modal-error">${['The converted backup doesn’t pass validation, so nothing was changed:'].concat(docErrors).map(esc).join('\n')}</div>
        <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
      pendingRestoreData = null;
      return;
    }
    conversion = conv.summary;
    backup = conv.doc;
    pendingRestoreData = backup;
  }

  // A format-2 backup needs the TV-show schema. Since the switch to show-level
  // status, a TV show's status lives only in tv_shows, so a format-1 backup (which
  // has none) can't be restored into a format-2 database; the database refuses it too.
  // A format-3 database (personal collections) takes format 3 only: an older file
  // has none of your collections or watch-with choices; the database refuses it too.
  // A contracted database takes format 4 (or a converted format 3, above).
  const formatErrors = backup.formatVersion > dbFormat
    ? [backup.formatVersion === 4
      ? 'This backup is format 4, from after the database update; this database hasn’t been updated yet, so it can’t take it. Nothing was changed.'
      : `This backup is format ${backup.formatVersion}, which this database doesn't support yet (it is format ${dbFormat}).`]
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
    <div class="modal-section">
      <div class="modal-label">Rows: current → backup</div>
      ${rows}
    </div>
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
}

async function executeRestore() {
  const backup = pendingRestoreData;
  if (!backup || isBrowseView(activeViewId)) { closeRestoreModal(); return; }
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

async function continueRestoreAfterSafetyConfirm(preRestoreFilename) {
  const backup = pendingRestoreData;
  if (!backup || isBrowseView(activeViewId)) { closeRestoreModal(); return; }

  const setProgress = (msg) => {
    showRestoreModal(`<div class="modal-title">Restoring…</div><div class="modal-progress">${esc(msg)}</div>`);
  };

  // ── Step 2: replace every table in one database transaction ──
  // restore_backup (db/phase0_restore_v1.sql) deletes and re-inserts all tables
  // atomically: if anything fails, the database rolls back to exactly what it was.
  const restoredTables = backupSpec(backup.formatVersion).tables;
  // The phase is read again right before sending: it must still be the one the preview
  // checked (format 4 ⇔ contracted, format 3 ⇔ coexistence). Nothing is sent otherwise.
  let sendCap = null;
  try { sendCap = await stage5Capabilities(); } catch (e) { sendCap = null; }
  const expectedPhase = backup.formatVersion === 4 ? 'contracted' : 'coexistence';
  if (!sendCap || sendCap.phase !== expectedPhase || !pendingRestoreData) {
    showRestoreModal(`<div class="modal-title">Restore not sent</div>
      <div class="modal-error">The database’s update state ${sendCap ? 'changed after this restore was prepared' : 'couldn’t be confirmed'}, so nothing was sent and nothing was changed. Choose the file again to see what restoring it would do now.</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }
  setProgress(`Restoring ${restoredTables.length} tables…`);
  restoreInFlight = true; // sent to the database: navigation no longer abandons it
  try {
    await sbFetch('POST', 'rpc/restore_backup', { p_backup: backup, p_allow_v1_reset: pendingRestoreAllowV1Reset === true });
    // Collections and watch-with choices read before this point are stale now.
    if (orgState !== 'absent') invalidateOrganization();
  } catch(e) {
    showRestoreModal(`<div class="modal-title">Restore failed — nothing was changed</div>
      <div class="modal-error">${esc(e.message)}

The restore runs as a single database transaction, so your data is exactly as it was before. The safety backup is still in your downloads as:
${esc(preRestoreFilename)}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
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

// Clears the caches and reloads the open view from Supabase, so the page shows the
// real post-restore state rather than stale in-memory data.
function finishRestoreAndReload() {
  closeRestoreModal();
  closeLibraryPanel(); // anything prepared before the restore no longer applies (library.js)
  tabData = {};
  loadOrganization(); // the restored collections and watch-with choices (in the background)
  if (isBrowseView(activeViewId)) loadBrowseView();
  else if (activeViewId) loadDerivedView();
}



function recordBackupTimestamp() {
  localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  updateBackupAgeIndicator();
}

function updateBackupAgeIndicator() {
  const el = document.getElementById('backupAgeIndicator');
  if (!el) return;
  const lastStr = localStorage.getItem(LAST_BACKUP_KEY);
  if (!lastStr) {
    el.textContent = 'No backup yet';
    el.className = 'backup-age warn';
    return;
  }
  const last = new Date(lastStr);
  const days = Math.floor((Date.now() - last.getTime()) / (1000*60*60*24));
  if (days < 14) {
    el.textContent = days === 0 ? 'Backed up today' : `Backup: ${days}d ago`;
    el.className = 'backup-age';
  } else if (days < 30) {
    el.textContent = `Backup: ${days}d ago`;
    el.className = 'backup-age warn';
  } else {
    el.textContent = `Backup recommended (${days}d ago)`;
    el.className = 'backup-age urgent';
  }
}
