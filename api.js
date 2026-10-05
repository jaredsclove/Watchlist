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
// so paging and later verification are stable. `filter` (optional) is a
// PostgREST filter such as "collection=in.(...)"; the exact-count check then
// applies to the filtered rows. Backup calls this without one. `select`
// (optional) is a comma-separated column list; backups pass their exact columns.
async function fetchAllRows(table, filter, select = '*') {
  const allRows = [];
  let offset = 0;
  let total = null;

  while (total === null || offset < total) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${select}${filter ? `&${filter}` : ''}&order=id.asc`, {
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

// ─── TV structural writes (TV-show migration) ────────────────────────────────
// TV seasons are added, matched and deleted through database functions that
// keep every season linked to its show in tv_shows (show status: tv-shows.js).
// Mirrors private.tv_collections() and private.tv_is_tv_row() in db/tv_model.sql.
const TV_COLLECTION_IDS = ['disney', '90day', 'sheridan', 'othertv', 'truecrime'];
function isTvCollection(collectionId) {
  return TV_COLLECTION_IDS.includes(collectionId);
}
function isTvSeasonRow(collectionId, mediaType, season) {
  return isTvCollection(collectionId) && (mediaType === 'tv' || (mediaType == null && (season || '') !== 'Film'));
}
// The show a legacy (unidentified) season belongs to: private.tv_show_key().
function tvShowKey(collectionId, itemKey) {
  const prefix = String(itemKey || '').split('|')[0];
  return SHOW_KEY_OVERRIDES[`${collectionId}|${prefix}`] || prefix;
}
function sbRpc(fn, args) {
  return sbFetch('POST', `rpc/${fn}`, args);
}

// Adds TV season rows (shaped like a direct watchlist_items insert) through
// add_tv_seasons, one call per show; each call is atomic, and the function also
// reopens a Complete show that gets a genuinely new season (Refresh shows finds
// identified shows in tv_shows). onInserted(rows) runs after each call, so rows
// already added stay in the page if a later call fails. Returns
// { inserted, alreadyListed, rejected, reopened: [show titles] }.
async function addTvSeasonRows(collectionId, rows, onInserted) {
  const groups = new Map();
  for (const r of rows) {
    const showKey = r.tmdb_id != null ? r.item_key.slice(0, r.item_key.lastIndexOf('|')) : tvShowKey(collectionId, r.item_key);
    const id = r.tmdb_id != null ? `tmdb:${r.tmdb_id}` : `key:${showKey}`;
    if (!groups.has(id)) {
      groups.set(id, { show: { tmdb_id: r.tmdb_id ?? null, title: r.title, show_key: showKey, network: r.theme || '' }, seasons: [] });
    }
    groups.get(id).seasons.push({
      item_key: r.item_key, title: r.title, season: r.season, theme: r.theme, display_date: r.display_date,
      date_sort: r.date_sort, season_number: r.tmdb_id != null ? r.season_number : null
    });
  }
  const outcome = { inserted: 0, alreadyListed: 0, rejected: 0, reopened: [] };
  for (const g of groups.values()) {
    const res = await sbRpc('add_tv_seasons', { p_collection: collectionId, p_show: g.show, p_seasons: g.seasons });
    outcome.alreadyListed += (res.existing || []).length;
    outcome.rejected += (res.rejected || []).length;
    const show = tvShowsById.get(res.show_id);
    if (show) show.status = res.show_status;
    else tvShowsById.set(res.show_id, { id: res.show_id, collection: collectionId, title: g.show.title, show_key: g.show.show_key,
      tmdb_id: g.show.tmdb_id, status: res.show_status });
    if (res.reopened) outcome.reopened.push(tvShowsById.get(res.show_id).title);
    if (res.inserted && res.inserted.length) {
      outcome.inserted += res.inserted.length;
      onInserted(res.inserted);
    }
  }
  return outcome;
}

async function tmdbFetch(path) {
  const res = await fetch(`${TMDB_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${TMDB_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    const err = new Error(`TMDB error ${res.status}`);
    err.status = res.status; // lets callers tell a genuine 404 "not found" from a failed request
    throw err;
  }
  return res.json();
}
