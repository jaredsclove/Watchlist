// ─── TMDB show ratings (item 2, first part) ───────────────────────────────────
// A TMDB-matched show's community score with its categories: the number alone, "8.2", rounded to one
// decimal and coloured by that rounded score (8.0 and up; 7.0 to 7.9; below 7.0). Its source, scale
// and vote count are behind a tap or keyboard focus, and in its accessible label ("TMDB: 8.2 out of
// 10 · 1,987 votes."). Practical display rules, not a measure of reliability: fewer than 10 votes, a
// missing or zero score, or no vote count shows nothing; 10–99 votes adds an asterisk ("8.2*") and
// "· Limited votes" to the explanation.
// Scores come from TMDB's show details (vote_average, vote_count) and are kept in the member's TMDB cache (TC1,
// tmdb-cache.js: shared by the member's devices; replaceable reference data, never library data, never in backups). It fills
// from show details the page already reads (Refresh shows, Add season, a TMDB preview, Match), from one request when a show
// is expanded whose score isn't known or is older than SHOW_RATING_MAX_AGE_MS, and from the background queue, which reads
// every TMDB-matched show missing or a week old. A failed request changes nothing and isn't repeated on this page.
// Season and episode scores aren't shown (TMDB gives a season no vote count).
// Sorting (view-sort.js) reads the same entries: the rounded score, and the show's first-air date
// (TMDB's first_air_date, kept as "f"), which sorts Series premiere. A read with no date keeps f: null. Sorting never
// requests anything.

const SHOW_RATING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ── A show's entry: { a: vote_average, c: vote_count, f: first_air_date or null, t: when it was read (ms) }, or null ──
function showRatingEntry(tmdbId) {
  if (tmdbId == null) return null;
  const e = tmdbEntry(tmdbShowKey(tmdbId));
  return e && e.data && typeof e.data === 'object' ? { ...e.data, t: e.at } : null;
}
// TMDB's show details for one show: kept even when they hold no usable score, so the show isn't requested again until the
// entry is old. Saved to the member's cache for a show in the library (a preview of another show stays in this page's memory).
function noteShowRating(tmdbId, details) {
  if (tmdbId == null || !details || typeof details !== 'object') return;
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const prev = showRatingEntry(tmdbId);
  const entry = { a: num(details.vote_average), c: num(details.vote_count) };
  // The first-air date: a real date, else null (TMDB has none); details without the field keep what was known.
  if ('first_air_date' in details) entry.f = isValidDateSort(details.first_air_date) ? details.first_air_date : null;
  else entry.f = prev && 'f' in prev ? prev.f : null;
  const key = tmdbShowKey(Number(tmdbId));
  const inLibrary = [...tvShowsById.values()].some(s => s && String(s.tmdb_id) === String(tmdbId));
  noteTmdbData(key, entry, tmdbAnswerBase(details, key), inLibrary);
  paintShowRating(tmdbId);
}

// ── What a cached entry shows ──
// null: nothing is shown. Colour follows the rounded score, so the colour and the number agree.
function showRatingModel(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const { a, c } = entry;
  if (typeof a !== 'number' || !Number.isFinite(a) || a > 10) return null;
  if (!Number.isInteger(c) || c < 10) return null;
  const score = Math.round(a * 10) / 10;
  if (!(score > 0)) return null;
  const limited = c < 100;
  const shown = score.toFixed(1);
  // The explanation names the source and the scale, which the compact number leaves out.
  const note = `TMDB: ${shown} out of 10 · ${c.toLocaleString('en-US')} votes${limited ? ' · Limited votes' : ''}.`;
  return {
    score,
    text: `${shown}${limited ? '*' : ''}`,
    band: score >= 8 ? 'high' : score >= 7 ? 'mid' : 'low',
    limited,
    note,
    label: note
  };
}
function showRatingInnerHtml(m) {
  return m ? `<button type="button" class="tmdb-rating r-${m.band}" data-action="rating" aria-label="${esc(m.label)}" onclick="toggleShowRatingNote(this, event)" onblur="this.removeAttribute('data-open')">${esc(m.text)}</button><span class="tmdb-rating-note" aria-hidden="true">${esc(m.note)}</span>` : '';
}
// A show's rating slot (empty until a usable score is cached); a show not matched to TMDB has none.
function showRatingHtml(show) {
  if (!show || show.tmdb_id == null) return '';
  return `<span class="tmdb-rating-slot" data-rating-of="${esc(String(show.tmdb_id))}">${showRatingInnerHtml(showRatingModel(showRatingEntry(show.tmdb_id)))}</span>`;
}
// A score that arrives fills the show's slots where they are, so nothing else is redrawn.
function paintShowRating(tmdbId) {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  const html = showRatingInnerHtml(showRatingModel(showRatingEntry(tmdbId)));
  document.querySelectorAll(`[data-rating-of="${String(tmdbId).replace(/"/g, '')}"]`).forEach(el => { el.innerHTML = html; });
}
// Tap, click, Enter or Space shows or hides the vote count; keyboard focus shows it too (styles.css).
function toggleShowRatingNote(btn, ev) {
  if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
  if (!btn) return;
  if (btn.getAttribute('data-open') === '1') btn.removeAttribute('data-open');
  else btn.setAttribute('data-open', '1');
}

// ── On demand: an expanded show whose score isn't cached, is old, or was cached without its first-air date ──
function requestShowRating(show) {
  if (!show || show.tmdb_id == null) return;
  const id = String(show.tmdb_id);
  const had = showRatingEntry(show.tmdb_id);
  // Fresh, and with the first-air date known (or known to be missing): nothing to read.
  if (had && tmdbNow() - (Number(had.t) || 0) < SHOW_RATING_MAX_AGE_MS && 'f' in had) return;
  if (showRatingRequests.has(id)) return;
  // TMDB asked to wait, or the background queue is reading it or has already tried it on this page (tmdb-cache.js).
  const key = tmdbShowKey(show.tmdb_id), q = tmdbQueue;
  if (q && (q.blockedUntil > tmdbNow() || q.inFlight.has(key) || q.tries.has(key) || q.unavailable.has(key))) return;
  showRatingRequests.add(id);
  tmdbFetch(`/tv/${encodeURIComponent(id)}`).then(d => noteShowRating(id, d), () => { /* no score: nothing changes */ });
}

// The show's first-air date from the member's cache (view-sort.js Series premiere), or null when it
// isn't known: not matched to TMDB, not read yet, or TMDB has no date.
function showFirstAirDate(show) {
  if (!show || show.tmdb_id == null) return null;
  const e = showRatingEntry(show.tmdb_id);
  return e && typeof e === 'object' && isValidDateSort(e.f) ? e.f : null;
}
// The rounded score a show's row shows, or null when it shows none (view-sort.js Rating).
function showRatingScore(show) {
  if (!show || show.tmdb_id == null) return null;
  const m = showRatingModel(showRatingEntry(show.tmdb_id));
  return m ? m.score : null;
}
