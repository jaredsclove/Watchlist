// The page writes only to a database whose phase it has read (stage5_capabilities):
// the B4/B5 phase (contracted-b45). Any other phase authorizes nothing; an unknown one
// is read again (GET) once before a write. The refusal is raised before anything is
// sent and is formatted as a database refusal (code update_required), so every caller
// reports that nothing was changed.
const STAGE5_WRITABLE_PHASES = ['contracted-b45'];
const STATE_MISMATCH_TEXT = 'This page and the database don’t match (the database may have been updated or rolled back), so nothing was changed. Reload the page.';
// Once a B4/B5 function is missing or a read lacks the B4/B5 columns, this page stops writing
// (and makes no backup or restore) until it is reloaded. A later capability read that still
// says B4/B5 — the API's schema cache lagging behind the database, or a database rolled back
// and changed again — never resumes it: only a reload starts from a fresh state.
let b45Stopped = false;
function stopB45Writes() {
  b45Stopped = true;
  stage5Phase = null;
  const el = typeof document !== 'undefined' && document.getElementById('phaseBanner');
  if (el) el.innerHTML = `<div class="error-banner">⚠️ ${esc(STATE_MISMATCH_TEXT)} Until then this page changes nothing.</div>`;
}
// Whether this page may write to a database whose capability reads cap.
function pageMayWrite(cap) {
  return !b45Stopped && !!cap && STAGE5_WRITABLE_PHASES.includes(cap.phase);
}
function stage5Refusal(text) {
  return new Error(`Supabase error 412: ${JSON.stringify({ code: 'P0001', details: null, hint: null, message: `update_required: ${text}` })}`);
}
async function requireWritablePhase() {
  if (b45Stopped) throw stage5Refusal(STATE_MISMATCH_TEXT);
  if (STAGE5_WRITABLE_PHASES.includes(stage5Phase)) return stage5Phase;
  let cap;
  try { cap = await stage5Capabilities(); }
  catch (e) { throw stage5Refusal('The database’s update state couldn’t be read, so nothing was changed. Try again.'); }
  stage5Phase = pageMayWrite(cap) ? cap.phase : null;
  if (!stage5Phase) throw stage5Refusal(cap ? STATE_MISMATCH_TEXT : 'This page needs a database update that hasn’t been made yet, so nothing was changed.');
  return stage5Phase;
}

// A read the B4/B5 page can't show: shows or films without the B4/B5 columns (the database
// isn't, or is no longer, in the B4/B5 phase). The view then shows Retry, offers no edit,
// and the page stops writing until it is reloaded.
function requireB45Shape(rows, field) {
  if ((rows || []).some(r => r && !(field in r))) {
    stopB45Writes();
    throw new Error(STATE_MISMATCH_TEXT);
  }
  return rows;
}

async function sbFetch(method, path, body) {
  if (method !== 'GET') await requireWritablePhase();
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
    // A B4/B5 function that doesn't exist: the database isn't (or is no longer) in this
    // page's phase. Nothing ran; the page stops writing until it is reloaded.
    if (res.status === 404 && /^rpc\/[a-z0-9_]+_b45$/.test(path) && /PGRST202/.test(err)) {
      stopB45Writes();
      throw stage5Refusal(STATE_MISMATCH_TEXT);
    }
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
// PostgREST filter such as "is_film=eq.false"; the exact-count check then
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

// Every row of a table, for views that must never show a partial result
// (browse-views.js). Stricter than fetchAllRows, whose callers are unchanged:
// every page must report an exact total in Content-Range, start where the last
// one ended, keep the same total, and repeat no row id; the rows read must equal
// the total. Anything else throws, so the caller can offer Retry. GET only.
async function fetchAllRowsStrict(table, filter, pageSize = BACKUP_PAGE_SIZE) {
  const rows = [];
  const ids = new Set();
  let total = null;
  for (;;) {
    const offset = rows.length;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*${filter ? `&${filter}` : ''}&order=id.asc`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Range-Unit': 'items',
        'Range': `${offset}-${offset + pageSize - 1}`,
        'Prefer': 'count=exact'
      }
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed reading ${table} (offset ${offset}): ${res.status} ${err}`);
    }
    const contentRange = (res.headers.get('content-range') || '').trim();
    const m = /^(?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(contentRange);
    if (!m || !Number.isSafeInteger(Number(m[3]))) {
      throw new Error(`Incomplete read of ${table}: no exact row count was reported (Content-Range "${contentRange}").`);
    }
    const pageTotal = Number(m[3]);
    if (total !== null && pageTotal !== total) {
      throw new Error(`Incomplete read of ${table}: the row count changed during the read (${total} → ${pageTotal}). Try again.`);
    }
    total = pageTotal;
    const page = await res.json();
    if (!Array.isArray(page) || page.length > pageSize) throw new Error(`Incomplete read of ${table}: unexpected page at offset ${offset}.`);
    if (page.length === 0) {
      if (m[1] !== undefined || offset < total) throw new Error(`Incomplete read of ${table}: ${offset} of ${total} rows, then an empty page.`);
      break;
    }
    if (m[1] === undefined || Number(m[1]) !== offset || Number(m[2]) !== offset + page.length - 1) {
      throw new Error(`Incomplete read of ${table}: the page at offset ${offset} doesn't line up (Content-Range "${contentRange}").`);
    }
    for (const r of page) {
      if (!r || r.id == null || ids.has(r.id)) throw new Error(`Incomplete read of ${table}: a row was missing an id or repeated (offset ${offset}).`);
      ids.add(r.id);
      rows.push(r);
    }
    if (rows.length > total) throw new Error(`Incomplete read of ${table}: ${rows.length} rows read but ${total} reported.`);
    if (rows.length === total) break;
  }
  return rows;
}

// ─── Database functions ───────────────────────────────────────────────────────
// Every structural write (adding, creating, matching, deleting TV seasons, films
// and catalog entries) goes through a database function that checks it in one
// transaction (library.js, tmdb-match.js, catalog-apply.js). Where a record was
// once stored is not part of any request since Stage 5.

// A catalog entry's show key (private.tv_show_key in the database): the entry
// key's prefix, unless a reviewed override for that catalog applies.
function catalogShowKey(catalogId, itemKey) {
  const prefix = String(itemKey || '').split('|')[0];
  return SHOW_KEY_OVERRIDES[`${catalogId}|${prefix}`] || prefix;
}

function sbRpc(fn, args) {
  return sbFetch('POST', `rpc/${fn}`, args);
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
