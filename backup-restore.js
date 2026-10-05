// objects as a whole). Returns an array of field names that differ.
function compareRowFields(expected, restored) {
  const diffFields = [];
  for (const key of Object.keys(expected)) {
    const a = expected[key];
    const b = restored[key];
    // JSON.stringify on a single value (not a whole object) is safe here —
    // it has no key-order ambiguity for primitives, and for arrays
    // (watch_with, collections) it correctly catches real order/content
    // differences, which are genuine data differences, not false positives.
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffFields.push(key);
    }
  }
  return diffFields;
}

// Which backup format the database holds: 2 once the TV-show schema exists
// (tv_shows readable), otherwise 1. A read-only probe; any other answer is an error.
async function detectBackupFormat() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/tv_shows?select=id&limit=1`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  if (res.ok) return 2;
  const body = await res.text();
  if (res.status === 404 && body.includes('PGRST205')) return 1;
  throw new Error(`Couldn't tell which backup format this database uses: ${res.status} ${body}`);
}

// Fetches every row of every table in the database's backup format, asking for the
// format's exact columns (never user_id: a backup is list content, not ownership),
// and assembles the backup JSON object. Does not write anything.
async function buildBackupObject() {
  const formatVersion = await detectBackupFormat();
  const spec = BACKUP_FORMATS[formatVersion];
  const tables = {};
  const rowCounts = {};
  for (const table of spec.tables) {
    const rows = await fetchAllRows(table, null, Object.keys(spec.columns[table]).join(','));
    tables[table] = rows;
    rowCounts[table] = rows.length;
  }
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

function handleRestoreClick() {
  document.getElementById('restoreFileInput').click();
}

function validateBackupObject(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') { errors.push('File does not contain a JSON object.'); return errors; }
  if (obj.format !== BACKUP_FORMAT) errors.push(`Unrecognized backup format ("${obj.format}") — this doesn't look like a Watchlist Tracker backup file.`);
  const spec = BACKUP_FORMATS[obj.formatVersion];
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

// Every column of the three tables, as the live schema defines them. A backup row
// must carry exactly these keys (key presence), and each value must fit the column
// type; a trailing "?" marks columns the database allows to be NULL. If the schema
// gains a column, add it here, or backups that include it will be refused.
const RESTORE_COLUMNS = {
  watchlist_items: {
    id: 'uuid', collection: 'text', item_key: 'text', title: 'text', season: 'text', theme: 'text',
    display_date: 'text', date_sort: 'date', watched: 'bool', status: 'text', created_at: 'timestamp',
    watch_with: 'text[]?', collections: 'text[]?', tmdb_collection_id: 'int?', tmdb_collection_name: 'text?',
    media_type: 'text?', tmdb_id: 'int?', season_number: 'int?'
  },
  othertv_shows: { id: 'uuid', tmdb_id: 'int', title: 'text', network: 'text', created_at: 'timestamp', collection: 'text' },
  custom_collections: { id: 'uuid', name: 'text', tmdb_person_id: 'int', created_at: 'timestamp', role: 'text?' }
};

// Format 2 (once the TV-show schema exists): watchlist_items gains show_id (TV
// seasons only) and skipped, and tv_shows is added. Like format 1, never user_id.
const RESTORE_COLUMNS_V2 = {
  ...RESTORE_COLUMNS,
  watchlist_items: { ...RESTORE_COLUMNS.watchlist_items, show_id: 'uuid?', skipped: 'bool' },
  tv_shows: { id: 'uuid', collection: 'text', title: 'text', show_key: 'text', tmdb_id: 'int?', status: 'text', created_at: 'timestamp' }
};

// The backup formats this app reads and writes, by formatVersion.
const BACKUP_FORMATS = {
  1: { tables: ['watchlist_items', 'othertv_shows', 'custom_collections'], columns: RESTORE_COLUMNS },
  2: { tables: ['watchlist_items', 'tv_shows', 'othertv_shows', 'custom_collections'], columns: RESTORE_COLUMNS_V2 }
};
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
  const spec = BACKUP_FORMATS[formatVersion];
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
  report('watchlist_items duplicate movie identity', findDuplicates(items,
    r => r.media_type === 'movie' && r.tmdb_id != null ? JSON.stringify([r.collection, r.tmdb_id]) : null,
    r => `(collection "${r.collection}", tmdb_id ${r.tmdb_id})`));
  report('watchlist_items duplicate TV identity', findDuplicates(items,
    r => r.media_type === 'tv' && r.tmdb_id != null && r.season_number != null ? JSON.stringify([r.collection, r.tmdb_id, r.season_number]) : null,
    r => `(collection "${r.collection}", tmdb_id ${r.tmdb_id}, season ${r.season_number})`));
  report('watchlist_items duplicate legacy entry', findDuplicates(items,
    r => r.tmdb_id === null ? JSON.stringify([r.collection, r.item_key]) : null,
    r => `(collection "${r.collection}", item_key "${r.item_key}")`));
  report('othertv_shows duplicate tracked show', findDuplicates(tables.othertv_shows.filter(r => r && typeof r === 'object'),
    r => JSON.stringify([r.collection, r.tmdb_id]), r => `(collection "${r.collection}", tmdb_id ${r.tmdb_id})`));
  report('custom_collections duplicate name', findDuplicates(tables.custom_collections.filter(r => r && typeof r === 'object'),
    r => typeof r.name === 'string' ? r.name : null, r => `"${r.name}"`));
  if (formatVersion >= 2) validateTvShowRows(tables, items, report, rowLabel);
  return errors;
}

// Format 2 only: the shows and the season → show links, mirroring the database's
// rules (statuses, one show per identity, a season links only to a show of its own
// collection, films/movies never link, skipped only on linked seasons).
function validateTvShowRows(tables, items, report, rowLabel) {
  const shows = tables.tv_shows.filter(r => r && typeof r === 'object');
  const byId = new Map(shows.map(s => [s.id, s]));
  const findDup = (rows, keyOf, describe) => {
    const seen = new Map(), dups = [];
    rows.forEach((r, i) => { const k = keyOf(r); if (k === null) return; if (seen.has(k)) dups.push(`${describe(r)} on ${rowLabel(rows[seen.get(k)], seen.get(k))} and ${rowLabel(r, i)}`); else seen.set(k, i); });
    return dups;
  };
  report('tv_shows status', shows.map((s, i) => TV_SHOW_STATUSES.includes(s.status) ? null : `${rowLabel(s, i)} has status ${JSON.stringify(s.status)}`).filter(Boolean));
  report('tv_shows empty title or show_key', shows.map((s, i) => (typeof s.title === 'string' && s.title.trim() && typeof s.show_key === 'string' && s.show_key.trim()) ? null : rowLabel(s, i)).filter(Boolean));
  report('tv_shows duplicate identified show', findDup(shows, s => s.tmdb_id != null ? JSON.stringify([s.collection, s.tmdb_id]) : null,
    s => `(collection "${s.collection}", tmdb_id ${s.tmdb_id})`));
  report('tv_shows duplicate legacy show', findDup(shows, s => s.tmdb_id == null ? JSON.stringify([s.collection, s.show_key]) : null,
    s => `(collection "${s.collection}", show_key "${s.show_key}")`));
  const linkProblems = [];
  items.forEach((r, i) => {
    const isFilm = r.season === 'Film' || r.media_type === 'movie';
    if (r.show_id != null) {
      const show = byId.get(r.show_id);
      if (!show) linkProblems.push(`${rowLabel(r, i)} links to show ${r.show_id}, which isn't in the backup`);
      else if (show.collection !== r.collection) linkProblems.push(`${rowLabel(r, i)} links to a show in collection "${show.collection}"`);
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

async function handleRestoreFileSelected(event) {
  const file = event.target.files[0];
  event.target.value = ''; // allow re-selecting the same file later
  if (!file) return;

  let parsed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch(e) {
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
  await renderRestorePreview(parsed);
}

async function renderRestorePreview(backup) {
  showRestoreModal(`<div class="modal-title">Checking current data…</div><div class="modal-progress">Fetching current row counts for comparison…</div>`);

  let currentCounts = {};
  let currentItems = [];
  let dbFormat;
  try {
    dbFormat = await detectBackupFormat();
    for (const table of BACKUP_FORMATS[dbFormat].tables) {
      const rows = await fetchAllRows(table);
      currentCounts[table] = rows.length;
      if (table === 'watchlist_items') currentItems = rows;
    }
  } catch(e) {
    showRestoreModal(`<div class="modal-title">Couldn't check current data</div>
      <div class="modal-error">${esc(e.message)}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }

  // A format-2 backup needs the TV-show schema. Since the switch to show-level
  // status, a TV show's status lives only in tv_shows, so a format-1 backup (which
  // has none) can't be restored into a format-2 database; the database refuses it too.
  const formatErrors = backup.formatVersion > dbFormat
    ? [`This backup is format ${backup.formatVersion}, which needs the TV-show database; this database is still format ${dbFormat}.`]
    : backup.formatVersion < dbFormat
      ? [`This backup predates TV shows (format ${backup.formatVersion}). TV show status is now stored per show, so only format ${dbFormat} backups can be restored.`]
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

  const backupDate = new Date(backup.exportedAt).toLocaleString();
  const tables = [...new Set([...BACKUP_FORMATS[dbFormat].tables, ...BACKUP_FORMATS[backup.formatVersion].tables])];
  const rows = tables.map(t => `
    <div class="modal-row"><span>${esc(t)}</span><span>${currentCounts[t] ?? 0} → ${backup.tables[t] ? (backup.rowCounts[t] ?? backup.tables[t].length) : 0}</span></div>
  `).join('');

  showRestoreModal(`
    <div class="modal-title">Restore from backup?</div>
    <div class="modal-section">
      <div class="modal-label">Backup created</div>
      <div>${esc(backupDate)}</div>
    </div>
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
}

async function executeRestore() {
  const backup = pendingRestoreData;
  if (!backup) { closeRestoreModal(); return; }

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
  } catch(e) {
    showRestoreModal(`<div class="modal-title">Restore aborted</div>
      <div class="modal-error">Couldn't create a safety backup of your current data, so nothing was changed:\n${esc(e.message)}</div>
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
  if (!backup) { closeRestoreModal(); return; }

  const setProgress = (msg) => {
    showRestoreModal(`<div class="modal-title">Restoring…</div><div class="modal-progress">${esc(msg)}</div>`);
  };

  // ── Step 2: replace every table in one database transaction ──
  // restore_backup (db/phase0_restore_v1.sql) deletes and re-inserts all tables
  // atomically: if anything fails, the database rolls back to exactly what it was.
  const restoredTables = BACKUP_FORMATS[backup.formatVersion].tables;
  setProgress(`Restoring ${restoredTables.length} tables…`);
  try {
    await sbFetch('POST', 'rpc/restore_backup', { p_backup: backup, p_allow_v1_reset: pendingRestoreAllowV1Reset === true });
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
        const diffFields = compareRowFields(expectedRow, restoredRow);
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

// Clears all cached tab data and reloads the currently active tab (or derived
// view) from Supabase, so the UI reflects the real post-restore database state
// rather than stale in-memory data. Other tabs will refetch next time they're opened.
function finishRestoreAndReload() {
  closeRestoreModal();
  tabData = {};
  if (activeViewId) loadDerivedView();
  else loadTab(activeTabId);
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
