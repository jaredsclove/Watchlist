async function sbFetch(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error ${res.status}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ─── Backup / Restore: paginated fetch ────────────────────────────────────────
// Fetches every row of a table via Range-header pagination, using the
// Content-Range response header (e.g. "0-249/1284") to know the true total
// row count rather than guessing from page size. Deterministic id.asc order
// so paging and later verification are stable.
async function fetchAllRows(table) {
  const allRows = [];
  let offset = 0;
  let total = null;

  while (total === null || offset < total) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&order=id.asc`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Range-Unit': 'items',
        'Range': `${offset}-${offset + BACKUP_PAGE_SIZE - 1}`,
        'Prefer': 'count=exact'
      }
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed fetching ${table} (offset ${offset}): ${res.status} ${err}`);
    }
    const page = await res.json();
    allRows.push(...page);

    const contentRange = res.headers.get('content-range'); // e.g. "0-249/1284" or "0-49/*"
    if (contentRange) {
      const totalPart = contentRange.split('/')[1];
      if (totalPart && totalPart !== '*') total = parseInt(totalPart, 10);
    }
    if (page.length === 0) break; // safety valve against an infinite loop — no more rows to advance by
    if (total === null) {
      // no usable count returned — fall back to "stop when a page comes back short"
      if (page.length < BACKUP_PAGE_SIZE) break;
    }
    // Advance by exactly how many rows this page actually contained, not the
    // requested page size — a short/irregular page can never cause a gap or
    // skip in subsequent requests.
    offset += page.length;
  }

  // If Supabase reported an exact total via Content-Range, the fetched row
  // count must match it exactly, or the backup is not provably complete.
  if (total !== null && allRows.length !== total) {
    throw new Error(`Incomplete fetch of ${table}: expected ${total} rows but retrieved ${allRows.length}. Aborting — this backup would not be complete.`);
  }

  return allRows;
}

async function deleteAllRows(table) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=not.is.null`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=minimal'
    }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to clear ${table}: ${res.status} ${err}`);
  }
}

// Inserts rows in fixed-size batches, preserving any fields present on each row
// (including the original id, since all three tables use uuid PKs with no
// auto-increment sequence to conflict with). Stops and throws immediately on
// the first failed batch, naming the table and batch index.
async function batchInsertRows(table, rows) {
  for (let i = 0; i < rows.length; i += RESTORE_BATCH_SIZE) {
    const batch = rows.slice(i, i + RESTORE_BATCH_SIZE);
    const batchNum = Math.floor(i / RESTORE_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(rows.length / RESTORE_BATCH_SIZE);
    try {
      await sbFetch('POST', table, batch);
    } catch(e) {
      throw new Error(`${table}: batch ${batchNum} of ${totalBatches} failed (rows ${i+1}-${i+batch.length}): ${e.message}`);
    }
  }
}

async function tmdbFetch(path) {
  const res = await fetch(`${TMDB_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${TMDB_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`TMDB error ${res.status}`);
  return res.json();
}
