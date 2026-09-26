// ─── TMDB-first, item_key-fallback duplicate detection ────────────────────────
// Given the set of rows already in a collection and the identity of a
// candidate item, finds the matching existing row (or undefined if none).
// Prefers matching by (media_type, tmdb_id[, season_number]) when the
// candidate has a tmdb_id — this is exact and immune to title-string
// collisions/variations. Falls back to the legacy item_key string match only
// for rows that have NO tmdb_id of their own (manual entries, or legacy rows
// not yet backfilled). Critically, a row that already has a DIFFERENT
// non-null tmdb_id must never match via the item_key fallback merely because
// the title/item_key text happens to coincide — that would incorrectly
// conflate two distinct TMDB identities.
// existingRows: array of row objects from Supabase (have .item_key, .media_type, .tmdb_id, .season_number)
// candidate: { itemKey, mediaType, tmdbId, seasonNumber } — seasonNumber omitted/null for movies
function findExistingRow(existingRows, candidate) {
  if (candidate.tmdbId != null) {
    const found = existingRows.find(r =>
      r.tmdb_id === candidate.tmdbId &&
      r.media_type === candidate.mediaType &&
      (candidate.mediaType === 'movie' || r.season_number === candidate.seasonNumber)
    );
    if (found) return found;
  }
  return existingRows.find(r => r.tmdb_id == null && r.item_key === candidate.itemKey);
}
// Boolean convenience wrapper around findExistingRow, for call sites that
// only need a yes/no answer (e.g. disabling an "already added" checkbox).
function isAlreadyAdded(existingRows, candidate) {
  return !!findExistingRow(existingRows, candidate);
}

// Conservative title normalization for automated TMDB matching: case, Unicode
// form, curly quotes and whitespace only. Deliberately does NOT equate "4" with
// "Four", drop a leading "The", or strip punctuation, so near-miss titles never
// count as the same work.
function normalizeTmdbTitle(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ').trim();
}
// Picks a TMDB /search/movie result for an AUTOMATED lookup (no human choosing).
// Only an exact normalized match on title or original_title counts, optionally
// narrowed to expectedYear (release year). Returns:
//   { match: result }      exactly one candidate remains
//   { ambiguous: [...] }   more than one remains; a human must choose
//   { none: true }         nothing matches
// Never falls back to the first result, and never uses popularity or vote count
// to choose between legitimate same-title films.
function pickTmdbMovieCandidate(results, title, expectedYear) {
  const want = normalizeTmdbTitle(title);
  let candidates = (results || []).filter(m =>
    normalizeTmdbTitle(m.title) === want || normalizeTmdbTitle(m.original_title) === want);
  if (expectedYear != null && expectedYear !== '') {
    candidates = candidates.filter(m => (m.release_date || '').slice(0, 4) === String(expectedYear));
  }
  if (candidates.length === 1) return { match: candidates[0] };
  if (candidates.length > 1) return { ambiguous: candidates };
  return { none: true };
}

// Detects a Postgres unique-constraint violation (duplicate key) from an
// sbFetch error message. Used at every watchlist_items insert site so a race
// (e.g. two tabs open, a rapid double-click, or a stale "already added"
// check) surfaces as a friendly message instead of raw Postgres error text.
function isDuplicateKeyError(e) {
  return e && e.message && (e.message.includes('23505') || e.message.includes('duplicate key'));
}
// Standard friendly message for a duplicate-key error on a watchlist_items
// insert. actionHint is a short phrase telling the user how to get a fresh
// check (varies by flow, since the "try again" action differs per entry point).
function duplicateInsertMessage(actionHint) {
  return `One or more of these was already on your list but wasn't detected in time — ${actionHint}, or reload the page first.`;
}

// TMDB collection names always come back as "X Collection" (e.g. "The Avengers Collection").
// Strip the trailing "Collection" for cleaner display everywhere a collection name is shown or stored.
function cleanCollectionName(name) {
  if (!name) return name;
  return name.replace(/\s+Collection\s*$/i, '').trim();
}
