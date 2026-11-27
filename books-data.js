// ─── Books: records, lists and Refresh books' rules (BK1, next-gen item 6; db/bk1_books.sql, books.js) ─────────────────
// Pure functions (no page state, no network), shared by the Books area and the offline tests: Hardcover's answers as compact
// records, an author's list and a series' order (filters that only change what a list shows: they never hide, merge or change a
// saved book), and what Refresh books finds (review items, date suggestions and a followed series' automatic additions).

// Supported official sites (a maintenance list): Hardcover author id → the author's book-listing page. A member may set a page for
// any other author; Refresh books then uses the same shared rule, and a page it doesn't recognise as a book list is reported,
// that author's refresh labelled Hardcover only.
const KNOWN_BOOK_SITES = {
  200048: { listing: 'https://robert-galbraith.com/strike-books/', home: null }, // Robert Galbraith (Cormoran Strike)
  86081: { listing: 'https://danielsilvabooks.com/the-books/', home: 'https://danielsilvabooks.com/' }, // Daniel Silva
  177846: { listing: 'https://www.karenmcmanus.com/books', home: null } // Karen M. McManus
};
const BOOK_STATUS_LABELS = { want: 'Want to read', reading: 'Reading', paused: 'Paused', finished: 'Finished', dropped: 'Dropped' };
const BOOK_DONE = new Set(['finished', 'dropped']); // (owner, 2026-11-26: a Dropped book counts as passed in its series)

// ── Titles and keys ──
function normBookTitle(s) {
  return String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`ʼ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(the|a|an) /, '');
}
// A title with no Latin letters or digits (Cyrillic, CJK…) has no slug: a short hash of the title stands in, so such titles don't
// share one key.
const bookSlug = s => normBookTitle(s).replace(/ /g, '-').slice(0, 200) || `x${bookHash(String(s == null ? '' : s).normalize('NFC').trim().toLowerCase())}`;
function bookHash(t) { let h = 5381; for (const ch of t) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0; return h.toString(36); }
const bookAuthorKey = a => (a && a.id ? String(a.id) : `n-${bookSlug(a && a.name).slice(0, 60)}`);
const bookTitleKey = (author, title) => `t:${bookAuthorKey(author)}:${bookSlug(title)}`;
// A saved book's key: its Hardcover record, else the entry itself.
const bookEntryKey = e => (e.hardcover_id ? `hc:${e.hardcover_id}` : `e:${e.id}`);
// The exclusion keys of a title: its Hardcover record (when it has one) and its title under each author.
function bookKeysOf({ hardcoverId = null, title, authors = [] }) {
  const keys = hardcoverId ? [`hc:${hardcoverId}`] : [];
  (authors.length ? authors : [{ name: 'unknown' }]).slice(0, 10).forEach(a => keys.push(bookTitleKey(a, title)));
  return [...new Set(keys)].slice(0, 20);
}

// ── Hardcover answers as records ──
const BOOK_GENRE_ALIASES = {
  mystery: 'Mystery', mysteries: 'Mystery', detective: 'Mystery', 'mystery and detective': 'Mystery', crime: 'Crime', 'crime fiction': 'Crime',
  thriller: 'Thriller', thrillers: 'Thriller', 'thriller and suspense': 'Thriller', 'thrillers and suspense': 'Thriller', suspense: 'Suspense', 'fiction suspense': 'Suspense',
  espionage: 'Espionage', 'spy thriller': 'Espionage', 'young adult': 'Young Adult', 'young adult fiction': 'Young Adult', ya: 'Young Adult',
  fantasy: 'Fantasy', 'science fiction': 'Science Fiction', 'sci fi': 'Science Fiction', horror: 'Horror', romance: 'Romance',
  'historical fiction': 'Historical Fiction', 'literary fiction': 'Literary Fiction', contemporary: 'Contemporary', 'contemporary fiction': 'Contemporary',
  classics: 'Classics', humor: 'Humor', humour: 'Humor', nonfiction: 'Nonfiction', 'non fiction': 'Nonfiction', biography: 'Biography', memoir: 'Memoir',
  history: 'History', poetry: 'Poetry', 'graphic novels': 'Graphic Novel', 'graphic novel': 'Graphic Novel', adventure: 'Adventure', 'true crime': 'True Crime'
};
// Hardcover's genre tags (readers' tags, by count) mapped onto a short list; anything else is left out. At most four.
function bookGenres(names) {
  const out = [];
  for (const n of names || []) {
    const g = BOOK_GENRE_ALIASES[String(n).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()];
    if (g && !out.includes(g)) out.push(g);
    if (out.length === 4) break;
  }
  return out;
}
const isAuthorRole = c => c == null || /^author$/i.test(String(c).trim());
// A book from Hardcover, compact (what the cache keeps): authors are its Author credits only (not translators or narrators).
function bookRecord(b) {
  if (!b || !Number.isInteger(b.id)) return null;
  const date = typeof b.release_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.release_date) ? b.release_date : null;
  return { v: 1, id: b.id, title: String(b.title || '').trim() || `Hardcover ${b.id}`, date, year: Number.isInteger(b.release_year) ? b.release_year : date ? Number(date.slice(0, 4)) : null,
    users: Number(b.users_count) || 0, editions: Number(b.editions_count) || 0, compilation: !!b.compilation, partial: !!b.is_partial_book,
    lang: Array.isArray(b.english) && b.english.length ? 'en' : Array.isArray(b.langknown) && b.langknown.length ? 'other' : 'unknown',
    genres: bookGenres(b.genres), alt: Array.isArray(b.alternative_titles) ? b.alternative_titles.filter(t => typeof t === 'string').slice(0, 8) : [],
    authors: (b.contributions || []).filter(c => c && c.author && Number.isInteger(c.author.id) && isAuthorRole(c.contribution))
      .map(c => ({ id: c.author.id, name: String(c.author.name || '').trim() })).filter((a, i, l) => a.name && l.findIndex(x => x.id === a.id) === i).slice(0, 20),
    series: (b.book_series || []).filter(s => s && s.series && Number.isInteger(s.series.id) && s.series.canonical_id == null)
      .map(s => ({ id: s.series.id, name: String(s.series.name || '').trim(), position: s.position == null ? null : String(s.position), details: s.details || null,
        compilation: !!s.compilation, author_id: s.series.author_id || null })).filter(s => s.name).slice(0, 10) };
}
function authorRecord(a) {
  if (!a || !Number.isInteger(a.id)) return null;
  const books = [], roles = {};
  for (const c of a.contributions || []) {
    const r = bookRecord(c && c.book);
    if (!r) continue;
    if (!books.some(x => x.id === r.id)) books.push(r);
    roles[r.id] = isAuthorRole(c.contribution) ? 'author' : String(c.contribution).toLowerCase();
  }
  return { v: 1, id: a.id, name: String(a.name || '').trim(), alias: (Array.isArray(a.alias) ? a.alias : a.alias ? [a.alias] : []).filter(x => x && x.id).map(x => ({ id: x.id, name: x.name })),
    books, roles };
}
function seriesRecord(s) {
  if (!s || !Number.isInteger(s.id)) return null;
  const books = [];
  for (const bs of s.book_series || []) {
    const r = bookRecord(bs && bs.book);
    if (r) books.push({ position: bs.position == null ? null : String(bs.position), details: bs.details || null, compilation: !!bs.compilation, rec: r });
  }
  return { v: 1, id: s.id, name: String(s.name || '').trim(), author: s.author && s.author.id ? { id: s.author.id, name: s.author.name } : null,
    primary: Number.isInteger(s.primary_books_count) ? s.primary_books_count : null, books };
}

// ── Dates ──
// A provider date that is the first of January: often a year-only placeholder. It is shown as given, marked as possibly one.
const bookDatePlaceholder = d => typeof d === 'string' && /^\d{4}-01-01$/.test(d);
// The date a saved book shows: the member's choice, else the record's (Hardcover), else none.
function bookShownDate(entry, rec) {
  if (entry && entry.chosen_date && entry.chosen_date.value) return { value: entry.chosen_date.value, source: entry.chosen_date.source, url: entry.chosen_date.url || null };
  if (rec && rec.date) return { value: rec.date, source: 'hardcover', placeholder: bookDatePlaceholder(rec.date) };
  if (rec && rec.year) return { value: String(rec.year), source: 'hardcover' };
  return null;
}
// A book's authors as the member's lists show them: authors they credited in Review (a manual credit, book_associations) first,
// in the order credited, then the book's own credits (co-authors kept; an author listed in both, once). Display only: the saved
// entry and Hardcover's record keep their own credits.
function bookAuthorsWithCredits(authors, hardcoverId, associations = []) {
  const own = authors || [];
  if (!hardcoverId) return own;
  const credited = associations.filter(a => a.hardcover_book_id === hardcoverId)
    .slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .map(a => ({ id: a.hardcover_author_id, name: a.author_name }));
  if (!credited.length) return own;
  const ids = new Set(credited.map(a => a.id));
  return credited.concat(own.filter(a => !(a && a.id && ids.has(a.id))));
}
// A date suggestion that would change nothing: the official site says TBA and the library shows no date or TBA. It isn't offered,
// an open one isn't shown and the next Refresh closes it (no decision is saved; a later real date is still suggested).
const bookDateNoChange = (current, suggested) => suggested === 'TBA' && (!current || current === 'TBA');
const bookFindingOffered = f => !(f && f.kind === 'date' && f.subject && bookDateNoChange(f.subject.current, f.subject.suggested));
const bookDateSortKey = d => (!d || d.value === 'TBA' ? '9999-12-31' : d.value.length === 4 ? `${d.value}-12-31` : d.value.length === 7 ? `${d.value}-28` : d.value);
function bookUpcoming(d, today) { return !!d && (d.value === 'TBA' || bookDateSortKey(d) > today); }
function bookDateText(d) {
  if (!d) return 'Date unknown';
  if (d.value === 'TBA') return 'TBA';
  const [y, m, day] = d.value.split('-');
  const mon = m ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] : '';
  return day ? `${mon} ${Number(day)}, ${y}` : m ? `${mon} ${y}` : y;
}

// ── What a list shows ──
const BOOK_COLLECTION_RE = /\b(box(?:ed)? set|collection|omnibus|anthology set|books? \d+\s*(?:-|–|to|&|and)\s*\d+|novels? \d+\s*(?:-|–|to)\s*\d+|\d+[- ]book|series set|cd collection|bundle)\b/i;
function bookHiddenReason(rec, ctx = {}) {
  if (rec.partial) return 'Part of another book';
  if (rec.compilation || BOOK_COLLECTION_RE.test(rec.title) || / \/ /.test(rec.title)) return 'A collection or box set';
  const t = normBookTitle(rec.title);
  if (/^untitled\b/i.test(rec.title) || (ctx.seriesName && t === normBookTitle(`${ctx.seriesName} ${ctx.position || ''}`))
    || (rec.series || []).some(x => t === normBookTitle(`${x.name} ${x.position || ''}`))) return 'A placeholder title';
  if (rec.lang === 'other') return 'Not in English (a translation)';
  if (rec.lang === 'unknown' && !(ctx.upcoming || ctx.inSeries)) return 'Language unknown';
  return null;
}
// Records that may be the same book as another (hints only): the same title, the same title before a colon, or a series position
// another record holds. The record with more readers is shown; the others go under Hidden with the reason. A saved book is always
// shown. Nothing is merged or changed.
function bookDuplicateHints(recs, saved) {
  const out = new Map(), byTitle = new Map();
  const order = recs.slice().sort((a, b) => (saved.has(b.id) - saved.has(a.id)) || (b.users - a.users) || (a.id - b.id));
  for (const r of order) {
    const bare = String(r.title).replace(/\s+by\s+.+$/i, (m) => (r.authors.some(a => m.toLowerCase().includes(a.name.toLowerCase())) ? '' : m));
    const t = normBookTitle(bare), head = normBookTitle(bare.split(':')[0]);
    const twin = byTitle.get(t) || (head !== t ? byTitle.get(head) : null);
    if (twin && !saved.has(r.id)) { out.set(r.id, `Possibly another record of “${twin.title}”`); continue; }
    if (!byTitle.has(t)) byTitle.set(t, r);
    if (!byTitle.has(head)) byTitle.set(head, r);
  }
  return out;
}
const bookPositionNumber = p => (p == null || p === '' ? null : Number(p));
const bookMainPosition = p => p != null && /^\d{1,3}$/.test(String(p));

// The saved entries by Hardcover id and by title key, and the skip decisions (ctx for the views and Refresh).
function bookSavedIndex(entries) {
  const byHc = new Map(), byKey = new Map();
  for (const e of entries) {
    if (e.hardcover_id) byHc.set(e.hardcover_id, e);
    (e.authors && e.authors.length ? e.authors : [{ name: 'unknown' }]).forEach(a => { const k = bookTitleKey(a, e.title); if (!byKey.has(k)) byKey.set(k, e); });
  }
  return { byHc, byKey };
}
// A record's saved entry: by its id, else (for a book saved by hand or from a site, not yet linked) by its title under one of its authors.
function bookSavedFor(rec, idx) {
  if (idx.byHc.has(rec.id)) return idx.byHc.get(rec.id);
  for (const a of rec.authors) { const e = idx.byKey.get(bookTitleKey(a, rec.title)); if (e && !e.hardcover_id) return e; }
  return null;
}

// A series in order: main positions (whole numbers), each with the record shown and the other records there; companions
// (fractional or unnumbered positions: listed, never next, never added automatically; owner, 2026-11-26); hidden records with a
// reason; and the next book: the first main position whose book isn't Finished, Dropped or skipped.
function bookSeriesView(series, { entries = [], decisions = new Map(), today = '9999-12-31' } = {}) {
  const idx = bookSavedIndex(entries), skipped = key => decisions.has(`skip|${key}`);
  const saved = new Set(entries.filter(e => e.hardcover_id).map(e => e.hardcover_id));
  const slots = new Map(), hidden = [], companions = [];
  for (const b of series.books) {
    const reason = bookHiddenReason(b.rec, { seriesName: series.name, position: b.position, inSeries: true, upcoming: bookUpcoming(bookShownDate(null, b.rec), today) })
      || (b.compilation ? 'A collection or box set' : null);
    if (reason && !saved.has(b.rec.id)) { hidden.push({ rec: b.rec, position: b.position, reason }); continue; }
    const key = b.position == null ? null : b.position;
    if (key === null) { companions.push({ position: null, rec: b.rec }); continue; }
    (slots.get(key) || slots.set(key, []).get(key)).push(b.rec);
  }
  // Books saved by hand (or from a site) placed in this series.
  const manual = entries.filter(e => !e.hardcover_id && (e.series || []).some(s => (s.id && s.id === series.id) || (!s.id && normBookTitle(s.name) === normBookTitle(series.name))));
  const positions = [];
  for (const [pos, recs] of [...slots.entries()].sort((a, b) => bookPositionNumber(a[0]) - bookPositionNumber(b[0]))) {
    const ordered = recs.slice().sort((a, b) => (saved.has(b.id) - saved.has(a.id)) || ((b.lang === 'en') - (a.lang === 'en')) || (b.users - a.users) || (a.id - b.id));
    const shown = ordered[0], others = ordered.slice(1);
    others.forEach(r => hidden.push({ rec: r, position: pos, reason: `Another record at #${pos}` }));
    const entry = bookSavedFor(shown, idx) || ordered.map(r => bookSavedFor(r, idx)).find(Boolean) || null;
    const slot = { position: pos, main: bookMainPosition(pos), rec: shown, others, entry };
    if (slot.main) positions.push(slot); else companions.push(slot);
  }
  for (const e of manual) {
    const pl = e.series.find(s => (s.id && s.id === series.id) || normBookTitle(s.name) === normBookTitle(series.name));
    const slot = positions.find(p => p.position === pl.position);
    if (slot && !slot.entry) slot.entry = e;
    else if (!slot) { const s = { position: pl.position, main: bookMainPosition(pl.position), rec: null, others: [], entry: e }; if (s.main) positions.push(s); else companions.push(s); }
  }
  positions.sort((a, b) => bookPositionNumber(a.position) - bookPositionNumber(b.position));
  // (unnumbered records that are another record of a main book, such as "The Silkworm: Cormoran Strike, Book 2", go under Hidden)
  const mainTitles = positions.filter(p => p.rec).map(p => normBookTitle(p.rec.title));
  const keptCompanions = [];
  for (const c of companions) {
    if (c.position === null && c.rec && !saved.has(c.rec.id) && mainTitles.some(t => normBookTitle(c.rec.title).startsWith(t))) hidden.push({ rec: c.rec, position: null, reason: 'Another record of a main book' });
    else keptCompanions.push(c);
  }
  keptCompanions.sort((a, b) => (bookPositionNumber(a.position) ?? 1e9) - (bookPositionNumber(b.position) ?? 1e9));
  const done = p => (p.entry && BOOK_DONE.has(p.entry.status)) || (p.rec && skipped(`hc:${p.rec.id}`)) || (p.others || []).some(r => skipped(`hc:${r.id}`)) || (p.entry && skipped(bookEntryKey(p.entry)));
  positions.forEach(p => { p.done = !!done(p); p.skipped = !!((p.rec && skipped(`hc:${p.rec.id}`)) || (p.entry && skipped(bookEntryKey(p.entry)))); });
  keptCompanions.forEach(p => { p.skipped = !!((p.rec && skipped(`hc:${p.rec.id}`)) || (p.entry && skipped(bookEntryKey(p.entry)))); });
  const next = positions.find(p => !p.done) || null;
  return { series, positions, companions: keptCompanions, hidden, next };
}

// An author's books: Hardcover's Author credits, the member's manual credits, and the books of the author's verified series (series
// Hardcover gives this author as primary author, in which most main books credit them, or which the official site lists). A
// verified series' book credited to no-one else in the series and not to this author is a possible credit gap (reviewed, never
// assumed); a book in a series of several authors stays that series' and its authors'.
function bookAuthorView(author, { seriesList = [], associations = [], entries = [], decisions = new Map(), siteTitles = null, today = '9999-12-31' } = {}) {
  const idx = bookSavedIndex(entries), saved = new Set(entries.filter(e => e.hardcover_id).map(e => e.hardcover_id));
  const credited = new Map();
  for (const r of author.books) if ((author.roles || {})[r.id] === 'author' || r.authors.some(a => a.id === author.id)) credited.set(r.id, r);
  const manual = new Set(associations.filter(a => a.hardcover_author_id === author.id).map(a => a.hardcover_book_id));
  const verified = [], gaps = [];
  for (const s of seriesList) {
    if (!s || !s.author || s.author.id !== author.id) continue;
    const main = s.books.filter(b => bookMainPosition(b.position) && !b.compilation && !b.rec.partial);
    const byAuthor = main.filter(b => b.rec.authors.some(a => a.id === author.id) || manual.has(b.rec.id)).length;
    const onSite = siteTitles ? main.filter(b => siteTitles.has(normBookTitle(b.rec.title))).length : 0;
    if (!(main.length && (byAuthor * 2 >= main.length || onSite > 0))) continue;
    verified.push(s);
    const others = new Map();
    main.forEach(b => b.rec.authors.forEach(a => { if (a.id !== author.id) others.set(a.id, (others.get(a.id) || 0) + 1); }));
    for (const b of main) {
      if (credited.has(b.rec.id) || manual.has(b.rec.id) || b.rec.authors.some(a => a.id === author.id)) continue;
      if (b.rec.authors.some(a => (others.get(a.id) || 0) > 1)) continue; // (another author of this series: their book, not a gap)
      if (bookHiddenReason(b.rec, { inSeries: true, seriesName: s.name, position: b.position }) && !saved.has(b.rec.id)) continue;
      if (decisions.has(`not_author|cg:${b.rec.id}:${author.id}`)) continue;
      gaps.push({ rec: b.rec, series: s, position: b.position });
    }
  }
  const all = new Map(credited);
  for (const s of verified) for (const b of s.books) if (manual.has(b.rec.id) && !all.has(b.rec.id)) all.set(b.rec.id, b.rec);
  for (const id of manual) { const r = author.books.find(x => x.id === id); if (r && !all.has(id)) all.set(id, r); }
  const recs = [...all.values()];
  const dupes = bookDuplicateHints(recs, saved);
  const shown = [], hidden = [];
  for (const r of recs) {
    const inSeries = r.series.some(s => verified.some(v => v.id === s.id) && s.position != null);
    const reason = saved.has(r.id) ? null : (bookHiddenReason(r, { inSeries, upcoming: bookUpcoming(bookShownDate(null, r), today) }) || dupes.get(r.id) || null);
    (reason ? hidden : shown).push({ rec: r, reason, entry: bookSavedFor(r, idx) });
  }
  shown.sort((a, b) => bookDateSortKey(bookShownDate(null, a.rec)).localeCompare(bookDateSortKey(bookShownDate(null, b.rec))) || a.rec.title.localeCompare(b.rec.title));
  return { author, shown, hidden, verified, gaps };
}

// Add all: the titles a bulk add would save as Want to read. A series' main positions with a shown record and nothing saved there
// (no record of that place saved, no book saved by hand placed there), not skipped and not excluded (dismissed or removed); for
// an author, their verified series that way, then their other shown books that aren't a companion anywhere. Hidden records and
// companions are never included (showing Hidden changes nothing). Saved books are left as they are. One entry per record.
function bookAddAllPlan(target, { entries = [], decisions = new Map(), associations = [], today = '9999-12-31' } = {}) {
  const out = new Map(), excluded = rec => bookKeysOf({ hardcoverId: rec.id, title: rec.title, authors: rec.authors }).some(k => decisions.has(`exclude|${k}`));
  const idx = bookSavedIndex(entries);
  const fromSeries = s => {
    const v = bookSeriesView(s, { entries, decisions, today });
    for (const p of v.positions) {
      if (!p.main || !p.rec || p.entry || p.done || p.skipped || out.has(p.rec.id) || excluded(p.rec)) continue;
      out.set(p.rec.id, { rec: p.rec, seriesPl: { id: s.id, name: s.name, position: p.position } });
    }
  };
  if (target.kind === 'series') fromSeries(target.series);
  else {
    const v = bookAuthorView(target.author, { seriesList: target.seriesList || [], associations, entries, decisions, today });
    v.verified.forEach(fromSeries);
    const inVerified = new Set(v.verified.flatMap(s => s.books.map(b => b.rec.id)));
    for (const x of v.shown) {
      const r = x.rec;
      if (inVerified.has(r.id) || x.entry || bookSavedFor(r, idx) || out.has(r.id) || excluded(r) || decisions.has(`skip|hc:${r.id}`)) continue;
      if ((r.series || []).some(pl => pl.position != null && !bookMainPosition(pl.position))) continue; // (a companion somewhere)
      out.set(r.id, { rec: r, seriesPl: null });
    }
  }
  return [...out.values()];
}

// The series worth reading for an author: those Hardcover gives them as primary author with at least two books (an author's
// list also has one-book "series" made by readers' typing, such as "Gabriel Allon #23", and translated series).
const bookAuthorSeriesIds = list => (list || []).filter(x => x && Number.isInteger(x.id) && (Number(x.books_count) || 0) >= 2).map(x => x.id).slice(0, 12);

// ── The Library's order (owner, 2026-11-27): author, then series, then reading order ──
// Groups the visible books (views with title, authors, series and date) by their first-listed author (A–Z; books with no author
// last, as "Unknown author"), then by their series placement (A–Z, each in position order: numbered positions by number, then
// unnumbered by title), then that author's books with no series ("Standalone books", by date, undated last, then title). Each
// book is in exactly one place: its own saved author and series, never a relationship made up for the layout. Empty groups
// aren't made, since only visible books are grouped.
function bookLibraryGroups(views) {
  const authorKey = a => (a ? (a.id ? `id:${a.id}` : `n:${normBookTitle(a.name)}`) : '~');
  const authors = new Map();
  for (const v of views) {
    const a = (v.authors || [])[0] || null, ak = authorKey(a);
    const g = authors.get(ak) || authors.set(ak, { key: ak, name: a ? a.name : 'Unknown author', series: new Map(), standalone: [] }).get(ak);
    if (v.series && v.series.name) {
      const sk = v.series.id ? `id:${v.series.id}` : `n:${normBookTitle(v.series.name)}`;
      (g.series.get(sk) || g.series.set(sk, { key: sk, name: v.series.name, books: [] }).get(sk)).books.push(v);
    } else g.standalone.push(v);
  }
  const pos = v => { const n = Number(v.series && v.series.position); return v.series && v.series.position != null && v.series.position !== '' && Number.isFinite(n) ? n : Infinity; };
  const byTitle = (a, b) => compareTitles(a.title, b.title) || String(a.entry.id).localeCompare(String(b.entry.id));
  return [...authors.values()].sort((a, b) => (a.key === '~') - (b.key === '~') || compareTitles(a.name, b.name) || a.key.localeCompare(b.key)).map(g => ({
    key: g.key, name: g.name,
    series: [...g.series.values()].sort((a, b) => compareTitles(a.name, b.name) || a.key.localeCompare(b.key))
      .map(s => ({ ...s, books: s.books.slice().sort((a, b) => (pos(a) - pos(b)) || byTitle(a, b)) })),
    standalone: g.standalone.slice().sort((a, b) => bookDateSortKey(a.date).localeCompare(bookDateSortKey(b.date)) || byTitle(a, b))
  }));
}

// ── Refresh books ──
// A title is new for a follow when its Hardcover record wasn't in the follow's starting catalog (its baseline: every record the
// member could see when they followed, BK1b). A follow without a baseline yet (made before BK1b) gets one from this refresh and
// offers nothing new until the next: what is listed now was there to see, however recent (the owner's walkthrough, 2026-11-27).
const bookBaselineKey = follow => `f:${follow.id}`;
function bookNewForFollow(rec, baseline) { return !!baseline && !baseline.has(rec.id); }
// The ids a follow starts with: every record of the series, or of the author and their series (hidden ones included).
function bookFollowCatalogIds(follow, read) {
  const ids = new Set();
  if (follow.kind === 'series') { const s = read.series.get(follow.hardcover_id); if (s) s.books.forEach(b => ids.add(b.rec.id)); }
  else {
    const a = read.authors.get(follow.hardcover_id);
    if (a) { a.books.forEach(r => ids.add(r.id)); (read.seriesOf.get(a.id) || []).forEach(sid => { const s = read.series.get(sid); if (s) s.books.forEach(b => ids.add(b.rec.id)); }); }
  }
  return [...ids].slice(0, 5000);
}
// A website candidate's names: its link texts and its address's last part, with the wording sites put around a title removed.
function bookCandidateNames(c, authorName) {
  const strip = t => String(t || '').replace(/\.(jpe?g|png|gif|webp)$/i, '').replace(/^(book cover:|cover:)\s*/i, '').replace(/^\d{4}\s+/, '').replace(/^coming soon\s+/i, '')
    .replace(new RegExp(`\\s+by\\s+${String(authorName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'i'), '').replace(/\s+on sale .*$/i, '');
  return [...new Set([c.slug ? c.slug.replace(/-/g, ' ') : '', ...(c.texts || []).map(strip), ...(c.texts || [])].map(normBookTitle).filter(Boolean))];
}
const BOOK_EDITION_RE = /\b(paperback|hardcover edition|anniversary edition|special edition|deluxe|illustrated edition|large print|audiobook|audio edition|ebook|box(?:ed)? set|collection|omnibus|movie tie-in|tie-in edition)\b/i;
// A candidate's best title: the book page's title when it was read, else its shortest clean link text, else its address.
function bookCandidateTitle(c, page, authorName) {
  if (page && page.ok && page.title) return page.title.replace(/\s+by\s+[^|]+$/i, '').trim();
  const texts = (c.texts || []).map(t => t.replace(/\.(jpe?g|png|gif|webp)$/i, '').replace(/^(book cover:|cover:)\s*/i, '').replace(new RegExp(`\\s+by\\s+${String(authorName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'i'), '').trim())
    .filter(t => t && t.length <= 120 && !/_|\d{6,}|FINAL/i.test(t));
  texts.sort((a, b) => a.length - b.length);
  return texts[0] || c.slug.replace(/-/g, ' ').replace(/\b\w/g, x => x.toUpperCase());
}

// What one Refresh books found. read: { authors: Map(id → author record), series: Map(id → series record), seriesOf: Map(author id →
// [series id]), sites: Map(author id → { ok, error, listing, home, pages: Map(url → page), prev }) }. state: { entries, follows,
// associations, decisions (Map 'kind|key'), findings (open), sites (book_sites rows), today }. Returns { rows (to record),
// close (open fingerprints now settled), autoAdd ([{ rec, series, position, fingerprint }]), siteCache ([{ authorId, data }]),
// report }.
function bookRefreshFindings(read, state) {
  const { entries, follows, associations = [], decisions, findings = [], today } = state;
  const idx = bookSavedIndex(entries), savedHc = new Set(entries.filter(e => e.hardcover_id).map(e => e.hardcover_id));
  const excluded = keys => keys.some(k => decisions.has(`exclude|${k}`));
  const rows = new Map(), autoAdd = [], report = { hardcover: 0, hardcoverFailed: [], sites: [], sitesFailed: [], hardcoverOnly: [], editions: 0, autoAdded: 0 };
  const put = row => { if (!rows.has(row.fingerprint)) rows.set(row.fingerprint, row); };
  const savedKeyOf = rec => savedHc.has(rec.id) || !!bookSavedFor(rec, idx);
  const newBookRow = (rec, why, extra = {}) => ({ fingerprint: `nb:hc:${rec.id}`, source: 'hardcover', kind: 'new_book',
    subject: { title: rec.title, hardcover_id: rec.id, authors: rec.authors.slice(0, 5), date: rec.date || (rec.year ? String(rec.year) : null), lang: rec.lang, why, ...extra },
    evidence: [{ url: `https://hardcover.app/books/${rec.id}`, text: 'Hardcover' }], exclude_keys: bookKeysOf({ hardcoverId: rec.id, title: rec.title, authors: rec.authors }) });
  const authorFollows = follows.filter(f => f.kind === 'author'), seriesFollows = follows.filter(f => f.kind === 'series');
  // Baselines: the follow's own (a decision row), else one made now from this read (saved by the page; nothing new this time).
  const baselines = [], baselineOf = f => {
    const d = decisions.get(`baseline|${bookBaselineKey(f)}`);
    if (d && d.value && Array.isArray(d.value.ids)) return new Set(d.value.ids);
    const ids = bookFollowCatalogIds(f, read);
    if (ids.length) baselines.push({ follow: f, ids });
    return null;
  };
  // Followed series: new main and companion titles; a main title added automatically when the follow allows it.
  for (const f of seriesFollows) {
    const s = read.series.get(f.hardcover_id);
    if (!s) { report.hardcoverFailed.push(f.name); continue; }
    report.hardcover++;
    const base = baselineOf(f);
    const view = bookSeriesView(s, { entries, decisions, today });
    for (const p of [...view.positions, ...view.companions]) {
      if (!p.rec || p.entry || savedKeyOf(p.rec) || p.skipped) continue;
      if (!bookNewForFollow(p.rec, base)) continue;
      const keys = bookKeysOf({ hardcoverId: p.rec.id, title: p.rec.title, authors: p.rec.authors });
      if (excluded(keys)) continue;
      const fp = `nb:hc:${p.rec.id}`;
      const otherSaved = (p.others || []).some(r => savedKeyOf(r));
      const dupOpen = findings.some(x => x.kind === 'duplicate' && JSON.stringify(x.subject || {}).includes(`hc:${p.rec.id}`));
      if (f.auto_add && p.main && p.rec.lang === 'en' && !otherSaved && !dupOpen) { autoAdd.push({ rec: p.rec, series: s, position: p.position, fingerprint: fp }); continue; }
      put(newBookRow(p.rec, p.main ? `New in ${s.name} (#${p.position})` : `New companion in ${s.name}${p.position ? ` (#${p.position})` : ''}`,
        { series: { id: s.id, name: s.name, position: p.position } }));
    }
  }
  // Followed authors: their new titles (review only), and possible credit gaps in their verified series.
  for (const f of authorFollows) {
    const a = read.authors.get(f.hardcover_id);
    if (!a) { report.hardcoverFailed.push(f.name); continue; }
    report.hardcover++;
    const site = read.sites.get(f.hardcover_id);
    const siteTitles = site && site.ok && site.listing ? new Set(site.listing.candidates.flatMap(c => bookCandidateNames(c, a.name))) : null;
    const base = baselineOf(f);
    const view = bookAuthorView(a, { seriesList: (read.seriesOf.get(a.id) || []).map(id => read.series.get(id)).filter(Boolean), associations, entries, decisions, siteTitles, today });
    for (const x of view.shown) {
      if (x.entry || savedKeyOf(x.rec) || !bookNewForFollow(x.rec, base)) continue;
      const keys = bookKeysOf({ hardcoverId: x.rec.id, title: x.rec.title, authors: x.rec.authors });
      if (excluded(keys)) continue;
      put(newBookRow(x.rec, `New from ${a.name}`));
    }
    for (const g of view.gaps) {
      put({ fingerprint: `cg:${g.rec.id}:${a.id}`, source: 'hardcover', kind: 'credit_gap',
        subject: { title: g.rec.title, hardcover_id: g.rec.id, author_id: a.id, author: a.name, credited: g.rec.authors.map(x => x.name).slice(0, 5),
          series: { id: g.series.id, name: g.series.name, position: g.position } },
        evidence: [{ url: `https://hardcover.app/books/${g.rec.id}`, text: 'Hardcover' }], exclude_keys: [] });
    }
  }
  // Books saved by hand or from a site that a Hardcover record now matches (same title under the same author): a link to offer.
  const allRecs = new Map();
  read.authors.forEach(a => a.books.forEach(r => allRecs.set(r.id, r)));
  read.series.forEach(s => s.books.forEach(b => allRecs.set(b.rec.id, b.rec)));
  const recByKey = new Map();
  allRecs.forEach(r => { if (!bookHiddenReason(r, { inSeries: true })) r.authors.forEach(a => { const k = bookTitleKey(a, r.title); if (!recByKey.has(k) || r.users > recByKey.get(k).users) recByKey.set(k, r); }); });
  for (const e of entries) {
    if (e.hardcover_id) continue;
    let r = null;
    for (const a of e.authors || []) {
      r = recByKey.get(bookTitleKey(a, e.title)) || null;
      if (!r && !a.id) for (const rec of allRecs.values()) {
        if (normBookTitle(rec.title) === normBookTitle(e.title) && rec.authors.some(x => normBookTitle(x.name) === normBookTitle(a.name)) && !bookHiddenReason(rec, { inSeries: true }) && (!r || rec.users > r.users)) r = rec;
      }
      if (r) break;
    }
    if (!r || savedHc.has(r.id) || decisions.has(`not_same|mt:e:${e.id}:hc:${r.id}`)) continue;
    put({ fingerprint: `mt:e:${e.id}:hc:${r.id}`, source: 'hardcover', kind: 'match',
      subject: { entry_id: e.id, title: e.title, hardcover_id: r.id, hardcover_title: r.title, authors: r.authors.slice(0, 5), date: r.date },
      evidence: [{ url: `https://hardcover.app/books/${r.id}`, text: 'Hardcover' }], exclude_keys: [] });
  }
  // Saved books that may be the same book (the same title under an author, or the same main position in a series): review only.
  const groups = new Map();
  for (const e of entries) {
    (e.authors || []).forEach(a => { const k = `t|${bookTitleKey(a, e.title)}`; (groups.get(k) || groups.set(k, []).get(k)).push(e); });
    (e.series || []).forEach(s => { if (bookMainPosition(s.position)) { const k = `s|${s.id || normBookTitle(s.name)}|${s.position}`; (groups.get(k) || groups.set(k, []).get(k)).push(e); } });
  }
  for (const [, list] of groups) {
    const uniq = [...new Map(list.map(e => [e.id, e])).values()];
    for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
      const [x, y] = [bookEntryKey(uniq[i]), bookEntryKey(uniq[j])].sort();
      const fp = `dp:${x}:${y}`;
      if (x === y || decisions.has(`not_same|${fp}`)) continue;
      put({ fingerprint: fp, source: 'hardcover', kind: 'duplicate', subject: { entries: [uniq[i], uniq[j]].map(e => ({ id: e.id, title: e.title, status: e.status, hardcover_id: e.hardcover_id || null })) },
        evidence: [], exclude_keys: [] });
    }
  }
  // Official sites.
  const siteCache = [], followedAuthors = new Set(authorFollows.map(f => f.hardcover_id));
  const followedSeriesNames = new Map(); // author id → normalized names of their followed series (a series-only author's scope)
  seriesFollows.forEach(f => { const s = read.series.get(f.hardcover_id); if (s && s.author) (followedSeriesNames.get(s.author.id) || followedSeriesNames.set(s.author.id, []).get(s.author.id)).push(normBookTitle(s.name)); });
  const misread = []; // open website items for a title that is in the author's Hardcover catalog (a misidentification to close)
  report.outOfScope = 0; report.siteMatched = 0;
  for (const [authorId, site] of read.sites) {
    // Matching uses the author's whole Hardcover catalog (read for a series-only author too), so a known book keeps its identity.
    const a = read.authors.get(authorId) || { id: authorId, name: site.authorName, books: [] };
    if (!site.ok || !site.listing || !site.listing.ok) { report.sitesFailed.push({ author: site.authorName, error: site.error || (site.listing && site.listing.error) || 'couldn’t be read' }); continue; }
    const known = new Map(); // normalized title → record or entry
    a.books.forEach(r => { known.set(normBookTitle(r.title), r); (r.alt || []).forEach(t => known.set(normBookTitle(t), r)); });
    (read.seriesOf.get(authorId) || []).map(id => read.series.get(id)).filter(Boolean).forEach(s => s.books.forEach(b => { const t = normBookTitle(b.rec.title); if (!known.has(t)) known.set(t, b.rec); }));
    entries.forEach(e => {
      if (!(e.authors || []).some(x => (x.id && x.id === authorId) || normBookTitle(x.name) === normBookTitle(site.authorName))) return;
      const k = normBookTitle(e.title), had = known.get(k);
      known.set(k, { entry: e, rec: had && !had.entry ? had : had && had.rec ? had.rec : null });
    });
    // Open website items whose title is in this author's Hardcover catalog: they were misidentified (a known or saved book
    // isn't a website-only one) and are closed; Hardcover's own record is what Review and the lists use.
    findings.filter(x => x.source === 'website' && x.kind === 'new_book' && !x.subject.hardcover_id && x.subject.author_id === authorId)
      .forEach(x => { const k = known.get(normBookTitle(x.subject.title)); if (k) { misread.push(x.fingerprint); report.siteMatched++; } });
    const cands = site.listing.candidates;
    const matchOf = c => { for (const n of bookCandidateNames(c, a.name)) if (known.has(n)) return known.get(n); return null; };
    const matched = cands.filter(c => matchOf(c)).length;
    if (cands.length < 3 || (matched < Math.min(3, a.books.length) && a.books.length)) {
      report.hardcoverOnly.push({ author: site.authorName, why: 'its page doesn’t look like a list of their books' });
      continue;
    }
    report.sites.push(site.authorName);
    const prev = site.prev && Array.isArray(site.prev.paths) && !site.prev.reset ? new Set(site.prev.paths) : null;
    const unmatched = cands.filter(c => !matchOf(c));
    const fresh = prev ? unmatched.filter(c => !prev.has(c.path)) : unmatched;
    const vanished = prev ? [...prev].filter(p => !cands.some(c => c.path === p)).length : 0;
    siteCache.push({ authorId, data: { v: 1, url: site.listing.url, checked: today, paths: cands.map(c => c.path).slice(0, 300) } });
    if (prev && (fresh.length > 6 || (vanished >= 3 && vanished * 2 > prev.size))) {
      put({ fingerprint: `sc:${authorId}`, source: 'website', kind: 'site_changed', subject: { author_id: authorId, author: site.authorName, url: site.listing.url, fresh: fresh.length, vanished },
        evidence: [{ url: site.listing.url, text: 'Official book page' }], exclude_keys: [] });
      continue;
    }
    // A series-only follow's scope: only links the site lists under that series; the author's other books are out of scope until
    // the author is followed.
    const inScope = c => followedAuthors.has(authorId) || (c.headings || []).some(h => (followedSeriesNames.get(authorId) || []).some(n => n && normBookTitle(h).includes(n)));
    for (const c of unmatched) {
      if (!inScope(c)) { report.outOfScope++; continue; }
      const page = site.pages.get(c.url) || null;
      const title = bookCandidateTitle(c, page, a.name);
      const names = bookCandidateNames(c, a.name).concat(page && page.title ? [normBookTitle(page.title)] : []);
      const edition = BOOK_EDITION_RE.test([title, ...(c.texts || [])].join(' '));
      if (edition && names.some(n => [...known.keys()].some(k => k && n.includes(k)))) { report.editions++; continue; }
      const keys = bookKeysOf({ title, authors: [{ id: authorId, name: a.name }] });
      if (excluded(keys)) continue;
      const heading = (c.headings || []).find(h => / series$/i.test(h) || /^coming in \d{4}/i.test(h)) || null;
      const year = heading && /^coming in (\d{4})/i.exec(heading);
      const date = page && page.date ? page.date : year ? { value: year[1], rule: 'coming_year', quote: heading } : null;
      put({ fingerprint: `nb:site:${authorId}:${bookSlug(title)}`, source: 'website', kind: 'new_book',
        subject: { title, author_id: authorId, author: a.name, url: c.url, date: date ? date.value : null, quote: date ? date.quote : null,
          series_hint: heading && / series$/i.test(heading) ? heading.replace(/^the /i, '').replace(/ series$/i, '') : null, maybe: edition ? 'edition' : null, first_check: !prev },
        evidence: [{ url: c.url, text: date ? `${site.authorName}’s site: “${date.quote}”` : `Listed on ${site.authorName}’s book page` }], exclude_keys: keys });
    }
    // Date suggestions for saved books the site lists, where the date shown is missing, a possible placeholder, TBA or upcoming
    // (a long-published book's regional date difference is never suggested). Editions' dates are never used.
    for (const c of cands) {
      const m = matchOf(c);
      const e = m && (m.entry || bookSavedFor(m, idx));
      if (!e || (e.chosen_date && e.chosen_date.source === 'member')) continue;
      const page = site.pages.get(c.url) || null, ann = (site.home && site.home.ok ? site.home.announcements : []).find(x => x.url && new URL(x.url).pathname.replace(/\/+$/, '') === c.path);
      const heading = (c.headings || []).find(h => /^coming in \d{4}/i.test(h));
      const pub = page && page.publisherDate ? page.publisherDate : null;
      const found = (page && page.date) || (ann && ann.date) || pub || (heading ? { value: /(\d{4})/.exec(heading)[1], rule: 'coming_year', quote: heading } : null);
      if (!found) continue;
      const rec = m.entry ? (m.rec || null) : m, shown = bookShownDate(e, rec);
      const upcoming = bookUpcoming(shown, today) || bookUpcoming({ value: found.value }, today);
      const weak = !shown || shown.value === 'TBA' || shown.placeholder || (shown.value.length < 10);
      if (!(weak || upcoming)) continue;
      if (bookDateNoChange(shown && shown.value, found.value)) continue;
      if (shown && (shown.value === found.value || (found.value.length === 4 && shown.value.startsWith(found.value) && shown.value.length > 4))) continue;
      const src = (page && page.date) ? c.url : ann ? ann.url : pub ? page.publisherUrl : c.url;
      put({ fingerprint: `dt:${bookEntryKey(e)}:${found.value}`, source: 'website', kind: 'date',
        subject: { entry_id: e.id, title: e.title, current: shown ? shown.value : null, current_source: shown ? shown.source : null, suggested: found.value, url: src, quote: found.quote, author: site.authorName },
        evidence: [{ url: src, text: `${site.authorName}’s site: “${found.quote}”` }], exclude_keys: [] });
    }
  }
  for (const f of authorFollows) if (!read.sites.has(f.hardcover_id)) report.hardcoverOnly.push({ author: f.name, why: 'no official book page is set' });
  // Open items now settled: a book now saved, a match now linked or gone, a credit now given, a pair no longer both saved.
  const entryIds = new Set(entries.map(e => e.id));
  const close = findings.filter(x => {
    if (misread.includes(x.fingerprint)) return true;
    const s = x.subject || {};
    if (x.kind === 'new_book' && s.hardcover_id) return savedHc.has(s.hardcover_id);
    if (x.kind === 'new_book' && s.title) return !!idx.byKey.get(bookTitleKey({ id: s.author_id, name: s.author }, s.title));
    if (x.kind === 'match') return !entryIds.has(s.entry_id) || entries.some(e => e.id === s.entry_id && e.hardcover_id);
    if (x.kind === 'credit_gap') return associations.some(a => a.hardcover_book_id === s.hardcover_id && a.hardcover_author_id === s.author_id);
    if (x.kind === 'duplicate') return (s.entries || []).some(e => !entryIds.has(e.id));
    if (x.kind === 'date' && bookDateNoChange(s.current, s.suggested) && !rows.has(x.fingerprint)) return true;
    if (x.kind === 'date') return !entryIds.has(s.entry_id) || entries.some(e => e.id === s.entry_id && e.chosen_date && e.chosen_date.value === s.suggested);
    return false;
  }).map(x => x.fingerprint);
  report.autoAdded = autoAdd.length;
  const added = new Set(autoAdd.map(x => x.fingerprint)); // (a title added automatically isn't also offered for review)
  return { rows: [...rows.values()].filter(r => !close.includes(r.fingerprint) && !added.has(r.fingerprint)), close, autoAdd, siteCache, baselines, report };
}
