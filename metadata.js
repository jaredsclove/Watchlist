// ─── B4 / B5: categories, vocabularies, the viewing model ─────────────────────
// The categories (B4), their controlled lists and the TMDB source map; the viewing
// status, priority and markers (B5) with their labels; a film's view state over its
// stored status and watched flag; and the old-status mapping a format 3 / 4 backup is
// converted with (db/b45_expand.sql maps the live database itself, with the owner's
// recorded choices). Pure; nothing here sends a request.

// ── Categories (B4) ──
const GENRES = ['Action', 'Adventure', 'Comedy', 'Crime', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Kids', 'Music',
  'Musical', 'Mystery', 'Politics', 'Romance', 'Science Fiction', 'Thriller', 'War', 'Western'];
const FORMS = ['Animation', 'Anthology', 'Documentary', 'Docuseries', 'Limited series', 'News', 'Reality', 'Soap', 'Special', 'Talk', 'TV Movie'];
// key: the stored field; filter: the filter control's id; shows: shows only; single: one value.
const METADATA_CATEGORIES = [
  { key: 'genres', label: 'Genre', plural: 'Genres', filter: 'fGenre', list: GENRES },
  { key: 'forms', label: 'Form', plural: 'Forms', filter: 'fForm', list: FORMS },
  { key: 'franchises', label: 'Franchise / universe', plural: 'Franchises', filter: 'fFranchise' },
  { key: 'network', label: 'Original network / service', plural: 'Networks', filter: 'fNetwork', shows: true, single: true },
  { key: 'companies', label: 'Production company', plural: 'Companies', filter: 'fCompany' }
];
const METADATA_LIMITS = { values: 10, length: 80 };
// TMDB's combined TV categories and the two genres each could be resolved to (Details → Resolve).
const COMBINED_CATEGORIES = { 'Action & Adventure': ['Action', 'Adventure'], 'Sci-Fi & Fantasy': ['Science Fiction', 'Fantasy'],
  'War & Politics': ['War', 'Politics'] };

// TMDB genre names → the approved lists. Combined TV categories are not split: they stay
// unresolved candidates (the owner resolves them). Anything else is omitted and reported.
const TMDB_GENRE_MAP = {
  movie: { Action: ['genres', 'Action'], Adventure: ['genres', 'Adventure'], Animation: ['forms', 'Animation'], Comedy: ['genres', 'Comedy'],
    Crime: ['genres', 'Crime'], Documentary: ['forms', 'Documentary'], Drama: ['genres', 'Drama'], Family: ['genres', 'Family'],
    Fantasy: ['genres', 'Fantasy'], History: ['genres', 'History'], Horror: ['genres', 'Horror'], Music: ['genres', 'Music'],
    Mystery: ['genres', 'Mystery'], Romance: ['genres', 'Romance'], 'Science Fiction': ['genres', 'Science Fiction'],
    'TV Movie': ['forms', 'TV Movie'], Thriller: ['genres', 'Thriller'], War: ['genres', 'War'], Western: ['genres', 'Western'] },
  tv: { Animation: ['forms', 'Animation'], Comedy: ['genres', 'Comedy'], Crime: ['genres', 'Crime'], Documentary: ['forms', 'Documentary'],
    Drama: ['genres', 'Drama'], Family: ['genres', 'Family'], Kids: ['genres', 'Kids'], Mystery: ['genres', 'Mystery'],
    News: ['forms', 'News'], Reality: ['forms', 'Reality'], Soap: ['forms', 'Soap'], Talk: ['forms', 'Talk'], Western: ['genres', 'Western'],
    'Action & Adventure': ['genre_candidates', 'Action & Adventure'], 'Sci-Fi & Fantasy': ['genre_candidates', 'Sci-Fi & Fantasy'],
    'War & Politics': ['genre_candidates', 'War & Politics'] }
};

// A label list as the database accepts it: trimmed, non-empty, at most 80 characters,
// no case-insensitive repeats, at most 10 (extra values are dropped, never guessed).
function labelList(values) {
  const out = [];
  const seen = new Set();
  for (const v of values || []) {
    const t = String(v == null ? '' : v).trim();
    if (!t || t.length > METADATA_LIMITS.length || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === METADATA_LIMITS.values) break;
  }
  return out;
}

// labelList, also naming what it couldn't keep: a value over 80 characters or beyond the
// tenth (a repeat is the same value, not a loss). For TMDB sourcing, which never guesses.
function labelListReport(values, what) {
  const kept = labelList(values), dropped = [];
  const seen = new Set(kept.map(v => v.toLowerCase()));
  for (const v of values || []) {
    const t = String(v == null ? '' : v).trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    dropped.push(t.length > METADATA_LIMITS.length ? `“${t.slice(0, 40)}…” (${what}: longer than ${METADATA_LIMITS.length} characters)` : `“${t}” (${what}: more than ${METADATA_LIMITS.values})`);
  }
  return { kept, dropped };
}

// The metadata a new show or film takes from TMDB at creation (B4 §5.5): genres and forms
// by the map, combined TV categories as candidates, companies, and (shows) every network as
// a candidate. Original network is never set here. unmapped: TMDB genres left out;
// omitted: TMDB values the lists can't hold (both named in the add outcome, never guessed).
function tmdbMetadata(kind, details) {
  const map = TMDB_GENRE_MAP[kind === 'movie' ? 'movie' : 'tv'];
  const out = { genres: [], forms: [], genre_candidates: [], companies: [], unmapped: [], omitted: [] };
  for (const g of (details && details.genres) || []) {
    const hit = map[g && g.name];
    if (hit) out[hit[0]].push(hit[1]);
    else if (g && g.name) out.unmapped.push(g.name);
  }
  out.companies = ((details && details.production_companies) || []).map(c => c && c.name);
  const names = { genres: 'genre', forms: 'form', genre_candidates: 'category', companies: 'company', network_candidates: 'network' };
  if (kind !== 'movie') out.network_candidates = ((details && details.networks) || []).map(n => n && n.name);
  for (const k of Object.keys(names)) {
    if (!(k in out)) continue;
    const r = labelListReport(out[k], names[k]);
    out[k] = r.kept;
    out.omitted.push(...r.dropped);
  }
  return out;
}

// What creation-time sourcing left out, by title, for the add outcome of the movie tools
// (+ Add reports its own); read and cleared by takeSourcingNote.
const metadataSourcingNotes = new Map();
// The fields a creation request carries (without the report of what was left out). title:
// recorded for the outcome when anything was left out.
function creationMetadata(kind, details, title) {
  const { unmapped, omitted, ...fields } = tmdbMetadata(kind, details);
  if (title && (unmapped.length || omitted.length)) metadataSourcingNotes.set(title, unmapped.concat(omitted));
  return fields;
}
// "TMDB categories not used: …" for the titles given (notes for other titles are dropped too).
function takeSourcingNote(titles) {
  const parts = (titles || []).filter(t => metadataSourcingNotes.has(t)).map(t => `${t}: ${metadataSourcingNotes.get(t).join(', ')}`);
  metadataSourcingNotes.clear();
  return parts.length ? `TMDB categories not used: ${parts.join('; ')}.` : '';
}

// ── The viewing model (B5) ──
// TV shows: the stored status codes ('confirmed' is To Watch). Films: a view state over
// the stored status and watched flag; a Skipped + Watched pair is kept where it exists.
const SHOW_STATUS_LABELS = { confirmed: 'To Watch', watching: '▶ Watching', skipped: '✕ Skipped' };
const FILM_STATE_LABELS = { to_watch: 'To Watch', watched: '✓ Watched', skipped: '✕ Skipped', pair: '✕ Skipped (marked watched)' };
const PRIORITY_LABELS = { high: '★ High', normal: 'Normal', low: 'Low' };
const PRIORITIES = ['high', 'normal', 'low'];

function filmViewState(r) {
  if (!r) return 'to_watch';
  if (r.status === 'skipped') return r.watched ? 'pair' : 'skipped';
  return r.watched ? 'watched' : 'to_watch';
}

// ── Old statuses in a format 3 / 4 backup (plan §7.1, the converter column) ──
// The stored values a record of the old model takes. Complete (shows) and watching /
// complete (films) can't be decided without the owner, so they come back To Watch (a film
// keeps its watched flag) with Needs status review; the old value is kept as provenance.
function b45MapShowStatus(old) {
  const v = { status: old, priority: 'normal', ended: false, catalog_new: false, status_review: false, legacy_status: null };
  if (old === 'pending') Object.assign(v, { status: 'confirmed', catalog_new: true, legacy_status: 'pending' });
  else if (old === 'highpriority') Object.assign(v, { status: 'confirmed', priority: 'high', legacy_status: 'highpriority' });
  else if (old === 'maybe') Object.assign(v, { status: 'confirmed', priority: 'low', legacy_status: 'maybe' });
  else if (old === 'complete') Object.assign(v, { status: 'confirmed', ended: true, status_review: true, legacy_status: 'complete' });
  return v;
}
function b45MapFilmStatus(old) {
  const v = { status: old, priority: 'normal', catalog_new: false, status_review: false, legacy_status: null };
  if (old === 'pending') Object.assign(v, { status: 'confirmed', catalog_new: true, legacy_status: 'pending' });
  else if (old === 'highpriority') Object.assign(v, { status: 'confirmed', priority: 'high', legacy_status: 'highpriority' });
  else if (old === 'maybe') Object.assign(v, { status: 'confirmed', priority: 'low', legacy_status: 'maybe' });
  else if (old === 'watching' || old === 'complete') Object.assign(v, { status: 'confirmed', status_review: true, legacy_status: old });
  return v;
}
const OLD_STATUSES = ['confirmed', 'highpriority', 'watching', 'complete', 'pending', 'maybe', 'skipped'];
