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

const RESTORE_BATCH_SIZE = 200;

// Fetches all rows from all three app tables and assembles the backup JSON object.
// Does not write anything — pure read + build.
async function buildBackupObject() {
  const tables = {};
  const rowCounts = {};
  for (const table of BACKUP_TABLES) {
    const rows = await fetchAllRows(table);
    tables[table] = rows;
    rowCounts[table] = rows.length;
  }
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
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

// Deletes every row in a table. Supabase requires a filter on DELETE (no filter
// = rejected), so we match "id is not null", which is true for every row since
// id is NOT NULL on all three tables.

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
  if (typeof obj.formatVersion !== 'number' || obj.formatVersion > BACKUP_FORMAT_VERSION) errors.push(`Unsupported backup format version (${obj.formatVersion}).`);
  if (!obj.exportedAt || isNaN(Date.parse(obj.exportedAt))) errors.push('Missing or invalid export timestamp.');
  if (!obj.tables || typeof obj.tables !== 'object') { errors.push('Missing "tables" section.'); return errors; }
  for (const table of BACKUP_TABLES) {
    if (!Array.isArray(obj.tables[table])) {
      errors.push(`Missing or invalid data for table "${table}".`);
      continue;
    }
    const declaredCount = obj.rowCounts?.[table];
    if (typeof declaredCount === 'number' && declaredCount !== obj.tables[table].length) {
      errors.push(`Row count mismatch for "${table}": file claims ${declaredCount} but contains ${obj.tables[table].length}.`);
    }
  }
  // spot-check required fields on watchlist_items rows, the most important table
  const items = obj.tables.watchlist_items || [];
  const missingItemFields = items.filter(r => !r.id || !r.item_key || !r.collection);
  if (missingItemFields.length > 0) errors.push(`${missingItemFields.length} row(s) in watchlist_items are missing required fields (id, item_key, or collection).`);

  // othertv_shows: id, tmdb_id, title are NOT NULL with no default in the verified
  // schema — required. network/collection are NOT NULL but have defaults, so they're
  // not required here (an absent value would still restore safely).
  const othertv = obj.tables.othertv_shows || [];
  const missingOthertvFields = othertv.filter(r => r.id == null || r.tmdb_id == null || !r.title);
  if (missingOthertvFields.length > 0) errors.push(`${missingOthertvFields.length} row(s) in othertv_shows are missing required fields (id, tmdb_id, or title).`);

  // custom_collections: id, name, tmdb_person_id are NOT NULL with no default in the
  // verified schema — required. role is nullable with a default, so it's optional.
  const customCollections = obj.tables.custom_collections || [];
  const missingCollectionFields = customCollections.filter(r => r.id == null || !r.name || r.tmdb_person_id == null);
  if (missingCollectionFields.length > 0) errors.push(`${missingCollectionFields.length} row(s) in custom_collections are missing required fields (id, name, or tmdb_person_id).`);

  return errors;
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
  try {
    for (const table of BACKUP_TABLES) {
      const rows = await fetchAllRows(table);
      currentCounts[table] = rows.length;
    }
  } catch(e) {
    showRestoreModal(`<div class="modal-title">Couldn't check current data</div>
      <div class="modal-error">${esc(e.message)}</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }

  const backupDate = new Date(backup.exportedAt).toLocaleString();
  const rows = BACKUP_TABLES.map(t => `
    <div class="modal-row"><span>${esc(t)}</span><span>${currentCounts[t]} → ${backup.rowCounts[t] ?? backup.tables[t].length}</span></div>
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
    <div class="modal-warning">This will permanently replace all current data in these 3 tables with the contents of this backup. A safety backup of your current data will be downloaded automatically before anything is changed.</div>
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

  // ── Step 2: delete existing rows, then insert backup rows, table by table ──
  const completedTables = [];
  try {
    for (const table of BACKUP_TABLES) {
      setProgress(`Clearing ${table}…`);
      await deleteAllRows(table);
      const rowsToInsert = backup.tables[table];
      if (rowsToInsert.length > 0) {
        setProgress(`Restoring ${table} (${rowsToInsert.length} rows)…`);
        await batchInsertRows(table, rowsToInsert);
      }
      completedTables.push(table);
    }
  } catch(e) {
    showRestoreModal(`<div class="modal-title">Restore failed partway through</div>
      <div class="modal-error">Completed: ${completedTables.length ? completedTables.join(', ') : 'none'}
Failed: ${esc(e.message)}

Your data is now in a MIXED state — do not treat this as complete. A safety backup of your data from before this restore was downloaded as:
${esc(preRestoreFilename)}

You can restore that file to return to your pre-restore state.</div>
      <div class="modal-actions"><button class="btn" onclick="closeRestoreModal()">Close</button></div>`);
    return;
  }

  // ── Step 3: re-fetch and verify against the backup before declaring success ──
  setProgress('Verifying restored data…');
  const verificationErrors = [];
  try {
    for (const table of BACKUP_TABLES) {
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
    <div class="modal-success">All ${BACKUP_TABLES.length} tables restored and verified against the backup.
A safety backup of your data from before this restore was saved as:
${esc(preRestoreFilename)}</div>
    <div class="modal-actions"><button class="btn-accent btn" onclick="finishRestoreAndReload()">Close &amp; reload data</button></div>`);
}

// Clears all cached tab data and reloads the currently active tab from
// Supabase, so the UI reflects the real post-restore database state rather
// than stale in-memory data. Other tabs will refetch next time they're opened.
function finishRestoreAndReload() {
  closeRestoreModal();
  tabData = {};
  loadTab(activeTabId);
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
