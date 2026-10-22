// ─── TMDB show ratings (item 2, first part) ───────────────────────────────────
// A TMDB-matched show's community score with its categories: the number alone, "8.2", rounded to one
// decimal and coloured by that rounded score (8.0 and up; 7.0 to 7.9; below 7.0). Its source, scale
// and vote count are behind a tap or keyboard focus, and in its accessible label ("TMDB: 8.2 out of
// 10 · 1,987 votes."). Practical display rules, not a measure of reliability: fewer than 10 votes, a
// missing or zero score, or no vote count shows nothing; 10–99 votes adds an asterisk ("8.2*") and
// "· Limited votes" to the explanation.
// Scores come from TMDB's show details (vote_average, vote_count) and are kept in a per-device cache
// (per account): replaceable reference data, never library data, never in backups, never sent to the
// database. It fills from show details the page already reads (Refresh shows, Add season, a TMDB
// preview, Match) and from one request when a show is expanded whose score isn't cached or is older
// than SHOW_RATING_MAX_AGE_MS. A failed request changes nothing and isn't repeated on this page.
// Season and episode scores aren't shown (TMDB gives a season no vote count).

const SHOW_RATINGS_KEY = 'watchlist-tmdb-show-ratings';
const SHOW_RATING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SHOW_RATINGS_LIMIT = 1000; // entries kept; the oldest go first

// ── The per-device cache: { "<tmdb show id>": { a: vote_average, c: vote_count, t: fetched at (ms) } } ──
function readStoredShowRatings() {
  try {
    const v = JSON.parse(userStorage.getItem(SHOW_RATINGS_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}
function showRatings() {
  if (showRatingCache) return showRatingCache;
  const cache = readStoredShowRatings();
  if (userKey('')) showRatingCache = cache; // only once signed in: the cache is the account's
  return cache;
}
// TMDB's show details for one show: kept even when they hold no usable score, so the show isn't
// requested again until the entry is old. Another tab's entries are kept (the cache is read afresh).
function noteShowRating(tmdbId, details) {
  if (tmdbId == null || !details || typeof details !== 'object') return;
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const cache = readStoredShowRatings();
  cache[String(tmdbId)] = { a: num(details.vote_average), c: num(details.vote_count), t: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > SHOW_RATINGS_LIMIT) {
    keys.sort((x, y) => (Number(cache[x] && cache[x].t) || 0) - (Number(cache[y] && cache[y].t) || 0))
      .slice(0, keys.length - SHOW_RATINGS_LIMIT).forEach(k => { delete cache[k]; });
  }
  try { userStorage.setItem(SHOW_RATINGS_KEY, JSON.stringify(cache)); } catch (e) { /* storage unavailable: this page only */ }
  showRatingCache = cache;
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
  return `<span class="tmdb-rating-slot" data-rating-of="${esc(String(show.tmdb_id))}">${showRatingInnerHtml(showRatingModel(showRatings()[String(show.tmdb_id)]))}</span>`;
}
// A score that arrives fills the show's slots where they are, so nothing else is redrawn.
function paintShowRating(tmdbId) {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  const html = showRatingInnerHtml(showRatingModel(showRatings()[String(tmdbId)]));
  document.querySelectorAll(`[data-rating-of="${String(tmdbId).replace(/"/g, '')}"]`).forEach(el => { el.innerHTML = html; });
}
// Tap, click, Enter or Space shows or hides the vote count; keyboard focus shows it too (styles.css).
function toggleShowRatingNote(btn, ev) {
  if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
  if (!btn) return;
  if (btn.getAttribute('data-open') === '1') btn.removeAttribute('data-open');
  else btn.setAttribute('data-open', '1');
}

// ── On demand: an expanded show whose score isn't cached, or is old ──
function requestShowRating(show) {
  if (!show || show.tmdb_id == null) return;
  const id = String(show.tmdb_id);
  const had = showRatings()[id];
  if (had && Date.now() - (Number(had.t) || 0) < SHOW_RATING_MAX_AGE_MS) return;
  if (showRatingRequests.has(id)) return;
  showRatingRequests.add(id);
  tmdbFetch(`/tv/${encodeURIComponent(id)}`).then(d => noteShowRating(id, d), () => { /* no score: nothing changes */ });
}
