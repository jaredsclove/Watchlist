// ─── Books (BK1, next-gen item 6; db/bk1_books.sql, books-data.js, supabase/functions/books) ─────────────────────────────
// The Books area, drawn as Games and TV are (the tab row, the toolbar, aligned rows on wide screens and cards on narrow ones):
// Library (saved books, grouped by author and series) and Following (followed authors with their books, series and official
// book page, and followed series, each in order with the next book). Catalog data comes from Hardcover and
// official sites through the books function; the page never holds Hardcover's token. Saving a book follows nothing; following
// saves nothing, except that a followed series may add new main titles automatically when the member turns that on. Every change
// goes through the one write lane and is read again through reloadOpenView; focus follows the list's rule (the same control of
// the same row, else its ⋯ or expand button, else a neighbour's).

// Two tabs (owner, 2026-11-27): Library (saved books) and Following (followed authors, their series and other followed series;
// unsaved titles, follows, official pages, automatic adding). The old #/books/series and #/books/authors open Following.
const BOOKS_VIEWS = { books: 'library', booksfollowing: 'following' };
const BOOKS_VIEW_LABELS = { books: 'Library', booksfollowing: 'Following' };
const BOOKS_STATUS_DEFAULT = 'notdone';
const BOOKS_STATUS_GROUP_LABELS = { notdone: 'All except Finished and Dropped', all: 'All' };
const BOOK_STATUS_LOOK = { want: 'confirmed', reading: 'watching', paused: 'maybe', finished: 'complete', dropped: 'skipped' };
function isBooksView(id = activeViewId) { return Object.prototype.hasOwnProperty.call(BOOKS_VIEWS, id); }
function openBooks() { if (activeArea !== 'books') switchView('books'); }
const bkArg = s => esc(String(s)).replace(/'/g, "\\'");

// ── Reading ──
async function loadBooksView() {
  if (!isBooksView()) return null;
  const seq = ++booksLoadSeq, stamp = readStamp(), inPlace = !!booksData && booksData.loaded;
  if (inPlace) { beginListReread(); showError(''); } else { showError(''); paintBooksMessage('Loading…', false); }
  try {
    const data = await readBooksData();
    if (seq !== booksLoadSeq || !isBooksView()) return null;
    if (!readFresh(stamp)) { readAgainWhenFree(() => { if (seq === booksLoadSeq && isBooksView()) loadBooksView(); }); return null; }
    booksData = data;
    if (inPlace) endListReread(true);
    renderBooksView();
    return true;
  } catch (e) {
    console.error(e);
    if (seq !== booksLoadSeq || !isBooksView()) return null;
    if (inPlace) { endListReread(false, 'loadBooksView', e); return false; }
    showError(`Couldn’t read your books, so nothing is shown rather than an incomplete list. ${e.message}`);
    paintBooksMessage('Failed to load.', true);
    return false;
  }
}
async function readBooksData() {
  const [entries, follows, sites, associations, decisions, findings, cache] = await Promise.all(['book_entries', 'book_follows', 'book_sites', 'book_associations',
    'book_decisions', 'book_findings', 'book_cache'].map(t => fetchAllRows(t)));
  return booksDataFrom({ entries, follows, sites, associations, decisions, findings, cache });
}
function booksDataFrom(t) {
  const cache = { book: new Map(), author: new Map(), series: new Map(), site: new Map() };
  (t.cache || []).forEach(r => { if (r && r.data && r.data.v === 1 && cache[r.kind]) cache[r.kind].set(Number(r.key), r.data); });
  return { loaded: true, entries: t.entries || [], follows: t.follows || [], sites: t.sites || [], associations: t.associations || [],
    decisionRows: t.decisions || [], decisions: new Map((t.decisions || []).map(d => [`${d.kind}|${d.key}`, d])), findings: t.findings || [], cache };
}
// A saved book's Hardcover record, from whichever cached list has it.
function bookRecOf(id) {
  if (!booksData || !id) return null;
  const c = booksData.cache;
  if (c.book.has(id)) return c.book.get(id);
  for (const a of c.author.values()) { const r = a.books.find(b => b.id === id); if (r) return r; }
  for (const s of c.series.values()) { const b = s.books.find(x => x.rec.id === id); if (b) return b.rec; }
  return null;
}
function bookEntryView(e) {
  const rec = e.hardcover_id ? bookRecOf(e.hardcover_id) : null;
  const date = bookShownDate(e, rec);
  const series = (e.series || [])[0] || (rec && rec.series.find(s => s.position != null)) || null;
  return { entry: e, rec, title: e.title, authors: (e.authors && e.authors.length ? e.authors : rec ? rec.authors : []), series, date,
    genres: rec ? rec.genres : [], skipped: booksData.decisions.has(`skip|${bookEntryKey(e)}`) };
}
const booksToday = () => localTodayStr();
const bookReviewCount = () => (booksData ? booksData.findings.filter(f => f.status === 'pending').length : 0);

// ── The function ──
async function booksFn(body) {
  const headers = await authHeaders({ 'Content-Type': 'application/json' });
  let res;
  try { res = await fetch(`${SUPABASE_URL}/functions/v1/books`, { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch (e) { throw new Error('The books service couldn’t be reached. Try again later.'); }
  let j = null;
  try { j = await res.json(); } catch (e) { j = null; }
  if (!res.ok || !j) throw new Error((j && j.message) || `The books service couldn’t be reached (${res.status}). Try again later.`);
  return j;
}
// Hardcover queries in batches of eight: { name: data }; a refused query is { name: { error } } (not thrown) so one can fail alone.
async function hardcoverQueries(queries) {
  const out = {};
  for (let i = 0; i < queries.length; i += 8) {
    const j = await booksFn({ op: 'hardcover', queries: queries.slice(i, i + 8) });
    if (!Array.isArray(j.results)) throw new Error('Hardcover’s answer couldn’t be read.');
    j.results.forEach(r => { out[r.name] = r.error ? { error: r.error } : { data: r.data }; });
  }
  return out;
}
async function hardcoverAuthor(id) {
  const r = await hardcoverQueries([{ name: 'a', q: 'author', vars: { id } }, { name: 's', q: 'author_series', vars: { id } }]);
  if (!r.a || r.a.error || !r.a.data) throw new Error('Hardcover couldn’t give this author’s books. Try again later.');
  const author = authorRecord(r.a.data);
  author.seriesIds = r.s && r.s.data ? bookAuthorSeriesIds(r.s.data) : [];
  const ser = author.seriesIds.length ? await hardcoverQueries(author.seriesIds.map(sid => ({ name: `x${sid}`, q: 'series', vars: { id: sid } }))) : {};
  const series = author.seriesIds.map(sid => ser[`x${sid}`] && ser[`x${sid}`].data ? seriesRecord(ser[`x${sid}`].data) : null).filter(Boolean);
  return { author, series };
}
async function hardcoverSeries(id) {
  const r = await hardcoverQueries([{ name: 'x', q: 'series', vars: { id } }]);
  if (!r.x || r.x.error || !r.x.data) throw new Error('Hardcover couldn’t give this series. Try again later.');
  return seriesRecord(r.x.data);
}
// Cache rows (replaceable): authors and series with their books; a saved book's own record.
function bookCacheRows({ authors = [], series = [], books = [], sites = [] }) {
  const rows = [];
  authors.forEach(a => rows.push({ kind: 'author', key: String(a.id), data: { ...a, fetched: new Date().toISOString() } }));
  series.forEach(s => rows.push({ kind: 'series', key: String(s.id), data: { ...s, fetched: new Date().toISOString() } }));
  books.forEach(b => rows.push({ kind: 'book', key: String(b.id), data: b }));
  sites.forEach(x => rows.push({ kind: 'site', key: String(x.authorId), data: x.data }));
  // (the table keeps a row of up to 60,000 bytes of its JSON text, which spaces out more than JSON.stringify: a margin)
  return rows.filter(r => new TextEncoder().encode(JSON.stringify(r.data)).length * 1.2 < 60000);
}
async function putBookCache(parts) {
  const rows = bookCacheRows(parts);
  for (let i = 0; i < rows.length; i += 100) await sbRpc('library_book_cache_put', { p_rows: rows.slice(i, i + 100) });
  if (booksData) rows.forEach(r => booksData.cache[r.kind].set(Number(r.key), r.data));
}

// ── Drawing ──
function hideListForBooks() {
  ['viewHead', 'filtersRow', 'statsRow', 'tbody', 'cardList'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
  SETTINGS_LIST_CONTAINERS.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  const filtersRow = document.getElementById('filtersRow');
  if (filtersRow) filtersRow.dataset.tab = '';
  ['settingsScreen', 'queuesScreen', 'gamesScreen'].forEach(id => { const el = document.getElementById(id); if (el) { el.style.display = 'none'; el.innerHTML = ''; } });
}
function paintBooksMessage(text, withRetry) {
  hideListForBooks();
  const screen = document.getElementById('booksScreen');
  if (!screen) return;
  screen.style.display = '';
  screen.innerHTML = `<h2 class="games-title">Books</h2><div class="loading"${withRetry ? '' : ' tabindex="-1" data-loading="1"'}>${esc(text)}${withRetry ? ' <button class="btn" data-retry="1" onclick="loadBooksView()">Retry</button>' : ''}</div>`;
}
function renderBooksView() {
  if (!isBooksView() || !booksData || !booksData.loaded) return;
  const rec = captureBooksFocus();
  hideListForBooks();
  const screen = document.getElementById('booksScreen');
  if (!screen) return;
  screen.style.display = '';
  const view = BOOKS_VIEWS[activeViewId];
  const head = `<h2 class="visually-hidden games-title" id="booksTitle" tabindex="-1">Books: ${esc(BOOKS_VIEW_LABELS[activeViewId])}</h2>
    ${booksReport ? `<div class="games-report" role="status" data-books-report="1">${booksReport}</div>` : ''}`;
  const body = view === 'library' ? booksLibraryHtml() : booksFollowingHtml();
  screen.innerHTML = head + body + '<p class="games-note books-credit">Book data from <a href="https://hardcover.app" target="_blank" rel="noopener noreferrer">Hardcover</a> and authors’ official sites.</p>';
  if (view === 'library') fitBookGenres(); // (before focus: a focused pill now behind +N hands focus to +N)
  applyBooksFocus(rec);
}
function booksActionsHtml() {
  const n = bookReviewCount(), later = booksData.findings.length - n;
  return `<span class="games-actions"><button class="btn add-open-btn" data-baction="add" onclick="openBooksAdd(this)">+ Add book</button>
    <button class="btn" data-baction="refresh" onclick="refreshBooks()"${booksRefreshing ? ' disabled' : ''}>${booksRefreshing ? 'Refreshing…' : 'Refresh books'}</button>
    <button class="btn" data-baction="review" onclick="openBooksReview(this)">${n ? `Review (${n})` : later ? `Review (${later} later)` : 'Review'}</button></span>`;
}
function booksToolbarHtml({ line = '', panel = '', chips = '', count = '' }) {
  return `<div class="list-toolbar games-toolbar"><div class="filters"><div class="filter-line">${line}${booksActionsHtml()}</div>${panel}${chips}</div>
    ${count ? `<div class="stats-row"><p class="count-line" id="booksCount">${esc(count)}</p></div>` : ''}</div>`;
}
function bookStatusMatches(status, filter) {
  if (filter === 'all') return true;
  if (filter === 'notdone') return !BOOK_DONE.has(status);
  return status === filter;
}
function bookStatusSelectHtml(e, hook = 'status') {
  return `<select class="status-select game-status s-${BOOK_STATUS_LOOK[e.status] || 'confirmed'}" data-baction="${hook}" aria-label="${esc(`Status of ${e.title}`)}" onchange="setBookStatus('${bkArg(e.id)}', this.value)">${Object.entries(BOOK_STATUS_LABELS)
    .map(([v, l]) => `<option value="${v}"${e.status === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
function bookDateHtml(d, today = booksToday()) {
  if (!d) return '<span class="muted">Date unknown</span>';
  const upcoming = bookUpcoming(d, today);
  const src = d.source === 'member' ? ' · your date' : d.source === 'website' ? ' · from the official site' : '';
  // A possible placeholder: a small mark beside the date, its meaning on hover, keyboard focus or tap, and in its accessible name.
  const phNote = 'Hardcover lists 1 January, which often stands for a year-only date: the exact day may not be known.';
  const ph = d.placeholder ? `<span class="book-ph" tabindex="0" role="note" aria-label="${esc(`Possible placeholder date. ${phNote}`)}" title="${esc(phNote)}" data-note="${esc(phNote)}" onclick="event.stopPropagation(); this.focus()">?</span>` : '';
  return `<span class="game-when${d.value === 'TBA' ? ' game-tba' : upcoming ? ' game-upcoming' : ''}">${esc(bookDateText(d))}<span class="visually-hidden">${esc(src)}</span></span>${upcoming && d.value !== 'TBA' ? '<span class="upcoming-tag">Upcoming</span>' : ''}${ph}${d.source !== 'hardcover' ? ` <span class="game-basis">${esc(d.source === 'member' ? 'your date' : 'official site')}</span>` : ''}`;
}
// A desktop row (fit) draws every pill and a +N that starts hidden; fitBookGenres then shows one line, as Games' and Movies'.
function bookGenrePillsHtml(v, fit = false) {
  const all = v.genres || [], owner = `book:${v.entry.id}`, open = expandedCategoryOwners.has(owner);
  const more = fit && all.length > 1 ? `<button type="button" class="meta-more fit-hidden" data-baction="cats-more" aria-expanded="${open}" aria-label="${open ? 'Show fewer genres' : 'Show more genres'}" onclick="event.stopPropagation(); toggleBookGenres('${bkArg(owner)}')">${open ? 'Fewer' : '+'}</button>` : '';
  return all.map(g => {
    const pressed = booksFilters.genre === g;
    return `<button type="button" class="badge meta-chip meta-genres g-${genreFamily(g)} badge-clickable filter-pill" data-baction="${esc(`genre:${g}`)}" aria-pressed="${pressed}" title="${esc(pressed ? `Remove this filter (${g})` : `Filter by ${g}`)}" onclick="event.stopPropagation(); setBooksFilter('genre', booksFilters.genre === '${bkArg(g)}' ? '' : '${bkArg(g)}')">${esc(g)}</button>`;
  }).join('') + more;
}
function toggleBookGenres(owner) { if (expandedCategoryOwners.has(owner)) expandedCategoryOwners.delete(owner); else expandedCategoryOwners.add(owner); renderBooksView(); }
// Measured after each draw and on resize (Games' rule: the pills on the cell's first line stay, the rest behind +N).
function fitBookGenres() {
  const screen = typeof document !== 'undefined' && document.getElementById('booksScreen');
  if (!screen || typeof screen.querySelectorAll !== 'function') return;
  screen.querySelectorAll('.books-table .game-genres').forEach(fitGameGenreCell);
}
let booksFitFrame = 0;
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && typeof requestAnimationFrame === 'function') {
  window.addEventListener('resize', () => {
    if (booksFitFrame) return;
    booksFitFrame = requestAnimationFrame(() => { booksFitFrame = 0; if (typeof isBooksView === 'function' && isBooksView() && BOOKS_VIEWS[activeViewId] === 'library') fitBookGenres(); });
  });
}
const bookAuthorsText = v => (v.authors || []).map(a => a.name).join(', ') || '—';
const bookSeriesText = s => (s ? `${s.name}${s.position ? ` #${s.position}` : ''}` : '');
function bookMenuHtml(v) {
  const e = v.entry, id = esc(e.id), idArg = bkArg(e.id);
  const inSeries = !!v.series;
  const followA = (v.authors || []).filter(a => a.id && !booksData.follows.some(f => f.kind === 'author' && f.hardcover_id === a.id));
  const followS = v.rec ? v.rec.series.filter(s => s.id && s.position != null && !booksData.follows.some(f => f.kind === 'series' && f.hardcover_id === s.id)) : [];
  return `<span class="more-cell" onclick="event.stopPropagation()"><button type="button" class="more-btn" data-baction="more" aria-expanded="false" onclick="toggleMorePopover('b-${id}', this)" title="More" aria-label="${esc(`More for ${e.title}`)}">⋯</button>
      <div class="more-popover" id="more-popover-b-${id}" style="display:none">
        ${inSeries ? `<button class="popover-action" data-baction="skip" onclick="closeRowMenu(this); toggleBookSkip('${bkArg(bookEntryKey(e))}', ${v.skipped})">${v.skipped ? 'Unskip in its series' : 'Skip in its series'}</button>` : ''}
        <button class="popover-action" data-baction="date" onclick="closeRowMenu(this); openBookDate('${idArg}', this)">Choose a date…</button>
        <button class="popover-action" data-baction="edit" onclick="closeRowMenu(this); openBookEdit('${idArg}', this)">Edit title, author or series…</button>
        <button class="popover-action" data-baction="match" onclick="closeRowMenu(this); openBookMatch('${idArg}', this)">${e.hardcover_id ? 'Match to another Hardcover record…' : 'Match to Hardcover…'}</button>
        ${followA.map(a => `<button class="popover-action" data-baction="follow-a${a.id}" onclick="closeRowMenu(this); followBookAuthor(${a.id}, '${bkArg(a.name)}')">Follow the author ${esc(a.name)}</button>`).join('')}
        ${followS.map(s => `<button class="popover-action" data-baction="follow-s${s.id}" onclick="closeRowMenu(this); followBookSeries(${s.id}, '${bkArg(s.name)}')">Follow the series ${esc(s.name)}</button>`).join('')}
        <button class="popover-action" data-baction="delete" onclick="closeRowMenu(this); confirmDeleteBook('${idArg}')">Remove from library…</button>
      </div></span>`;
}
// A Library row under its author and series headings: the title (with any other authors), its series number, genres, date, status.
function bookRowParts(v) {
  const e = v.entry, id = esc(e.id), dim = e.status === 'dropped' || v.skipped ? ' row-skipped' : '';
  const others = (v.authors || []).slice(1).map(a => a.name);
  const n = v.series && v.series.position ? `#${v.series.position}` : '';
  const title = `<span class="show-title-main"><span class="show-title">${esc(v.title)}</span>${others.length ? ` <span class="book-coauthors">with ${esc(others.join(', '))}</span>` : ''}${v.skipped ? ' <span class="state-tag">Skipped in series</span>' : ''}${e.hardcover_id ? '' : ' <span class="state-tag">Not on Hardcover</span>'}</span>`;
  const menu = bookMenuHtml(v), status = `<span class="state-action">${bookStatusSelectHtml(e)}</span>`;
  const row = `<tr class="game-row${dim}" data-book="${id}">
      <td><div class="show-title-row"><div class="show-title-left">${title}</div>${menu}</div></td>
      <td class="book-num-cell">${n ? `<span aria-label="${esc(`Number ${v.series.position} in ${v.series.name}`)}">${esc(n)}</span>` : ''}</td>
      <td class="game-genres-cell"><div class="game-genres">${bookGenrePillsHtml(v, true)}</div></td>
      <td class="game-rel-cell"><span class="game-rel">${bookDateHtml(v.date)}</span></td>
      <td class="game-status-cell">${status}</td></tr>`;
  const card = `<div class="item-card game-card${dim}" data-book="${id}">
      <div class="card-top"><div class="card-title-block"><span class="card-title">${title}</span></div>${menu}</div>
      <div class="card-meta">${n ? `<span class="card-season book-card-by">${esc(bookSeriesText(v.series))}</span>` : ''}
        <span class="card-date">${bookDateHtml(v.date)}</span>${v.genres.length ? `<span class="card-labels">${bookGenrePillsHtml(v)}</span>` : ''}
        <span class="card-actions card-complete">${status}</span></div></div>`;
  return { row, card };
}
function booksLibraryHtml() {
  const f = booksFilters, all = booksData.entries.map(bookEntryView);
  const genres = [...new Set(all.flatMap(v => v.genres))].sort(compareTitles);
  const term = normalTitle(f.search);
  const list = all.filter(v => (!term || normalTitle(`${v.title} ${bookAuthorsText(v)} ${v.series ? v.series.name : ''}`).includes(term))
    && (!f.genre || v.genres.includes(f.genre)) && bookStatusMatches(v.entry.status, f.status));
  const statusOpts = [...Object.entries(BOOKS_STATUS_GROUP_LABELS), ...Object.entries(BOOK_STATUS_LABELS)];
  const isDefault = f.status === BOOKS_STATUS_DEFAULT;
  const applied = [f.genre ? ['genre', 'Genre', f.genre] : null, !isDefault ? ['status', 'Status', (statusOpts.find(o => o[0] === f.status) || [])[1] || f.status] : null].filter(Boolean);
  const open = booksFiltersOpen;
  const line = `<label class="visually-hidden" for="bSearch">Search your books</label>
      <input id="bSearch" class="search-input" type="search" placeholder="Search your books" value="${esc(f.search)}" oninput="setBooksFilter('search', this.value)">
      <button type="button" class="btn filter-more-btn" id="bFiltersBtn" aria-expanded="${open}" aria-controls="bFilters" onclick="toggleBooksFilters()">Filters${applied.length ? `<span class="filter-count" aria-hidden="true">${applied.length}</span><span class="visually-hidden"> (${applied.length} applied)</span>` : ''}</button>`;
  const field = (label, id, control) => `<div class="filter-field"><label class="filter-field-label" for="${id}">${esc(label)}</label>${control}</div>`;
  const panel = `<div class="filter-more" id="bFilters" role="group" aria-label="Filters" onkeydown="booksFiltersKeydown(event)"${open ? '' : ' hidden'}>
      <div class="filter-group" role="group" aria-label="Categories"><span class="filter-group-title" aria-hidden="true">Categories</span>${field('Genre', 'bGenre', `<select id="bGenre"${f.genre ? ' class="filter-set"' : ''} onchange="setBooksFilter('genre', this.value)"><option value="">All genres</option>${genres.map(g => `<option value="${esc(g)}"${f.genre === g ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select>`)}</div>
      <div class="filter-group" role="group" aria-label="Your marks"><span class="filter-group-title" aria-hidden="true">Your marks</span>${field('Status', 'bStatus', `<select id="bStatus"${!isDefault ? ' class="filter-set"' : ''} onchange="setBooksFilter('status', this.value)">${statusOpts.map(([v, l]) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}</div>
    </div>`;
  const chip = ([k, l, t]) => `<button type="button" id="bchip-${k}" class="filter-chip" aria-label="${esc(`Remove filter: ${l}, ${t}`)}" title="${esc(`Remove filter: ${l}, ${t}`)}" onclick="removeBooksFilter('${k}')"><span class="chip-k">${esc(l)}:</span> <span class="chip-v">${esc(t)}</span> <span aria-hidden="true">×</span></button>`;
  const chips = `<div class="filter-chips" id="bFilterChips">${isDefault ? `<span class="filter-default">Status: ${esc(BOOKS_STATUS_GROUP_LABELS[BOOKS_STATUS_DEFAULT])}</span>` : ''}${applied.length
    ? `<div class="chip-group" role="group" aria-label="Active filters"><span class="chips-label" aria-hidden="true">Active:</span>${applied.map(chip).join('')}</div>` : ''}${applied.length || f.search
    ? '<button type="button" class="btn-link filter-clear" id="bFilterClear" onclick="clearBooksFilters()">Clear filters</button>' : ''}</div>`;
  const count = all.length ? (list.length !== all.length ? `${list.length} of ${countUnit(all.length, 'book', 'books')}` : countUnit(list.length, 'book', 'books')) : '';
  const toolbar = booksToolbarHtml({ line, panel, chips, count });
  if (!all.length) return toolbar + `<div class="games-empty" data-books-empty="1" tabindex="-1"><p>No books yet. Use <strong>+ Add book</strong> to search Hardcover, browse an author or enter a book by hand.</p></div>`;
  if (!list.length) return toolbar + `<div class="games-empty" data-books-empty="1" tabindex="-1"><p>No books match these filters.</p></div>`;
  // Grouped (the Library's only order): author, then each series in reading order, then standalones by date. Each heading is a
  // disclosure (open at first; page memory, booksCollapsed): an author's hides its series and standalones, whose own choices are
  // kept; a closed heading gives its count of the books shown. Collapsing changes the display only.
  const groups = bookLibraryGroups(list), rows = [], cards = [];
  const head = (cls, key, text, count, level) => {
    const open = !booksCollapsed.has(key), hook = `grp-${key}`;
    const btn = `<button type="button" class="book-group-toggle" data-baction="${esc(hook)}" aria-expanded="${open}" onclick="toggleBookGroup('${bkArg(key)}')"><span class="expand-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span><span class="book-group-name">${esc(text)}</span>${open ? '' : ` <span class="book-group-count">${esc(countUnit(count, 'book', 'books'))}</span>`}</button>`;
    rows.push(`<tr class="book-group-row ${cls}"><th colspan="5">${btn}</th></tr>`);
    cards.push(`<h${level} class="book-group-head ${cls}">${btn}</h${level}>`);
    return open;
  };
  const add = v => { const p = bookRowParts(v); rows.push(p.row); cards.push(p.card); };
  for (const g of groups) {
    const n = g.series.reduce((k, x) => k + x.books.length, 0) + g.standalone.length;
    if (!head('book-group-author', `a|${g.key}`, g.name, n, 3)) continue;
    for (const x of g.series) if (head('book-group-series', `s|${g.key}|${x.key}`, x.name, x.books.length, 4)) x.books.forEach(add);
    if (g.standalone.length && head('book-group-series', `st|${g.key}`, 'Standalone books', g.standalone.length, 4)) g.standalone.forEach(add);
  }
  return toolbar + `<table class="games-table books-table" aria-label="Your books, by author and series"><thead><tr><th class="col-game">Book</th><th class="col-num"><span class="visually-hidden">Number in series</span><span aria-hidden="true">#</span></th><th class="col-cats">Genres</th><th class="col-rel">Release</th><th class="col-status">Status</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>
    <div class="card-list games-cards" aria-label="Your books, by author and series">${cards.join('')}</div>`;
}
function toggleBookGroup(key) { if (booksCollapsed.has(key)) booksCollapsed.delete(key); else booksCollapsed.add(key); renderBooksView(); }
function setBooksFilter(key, value) {
  booksFilters[key] = value;
  renderBooksView();
}
function removeBooksFilter(key) {
  booksFilters[key] = key === 'status' ? BOOKS_STATUS_DEFAULT : '';
  renderBooksView();
  const other = key === 'genre' ? 'bchip-status' : 'bchip-genre';
  focusFilterTarget(document.getElementById(other) ? other : 'bSearch');
}
function clearBooksFilters() { booksFilters = { search: '', genre: '', status: BOOKS_STATUS_DEFAULT }; renderBooksView(); focusFilterTarget('bSearch'); }
function toggleBooksFilters(open = !booksFiltersOpen) { booksFiltersOpen = !!open; renderBooksView(); }
function booksFiltersKeydown(e) {
  if (!e || e.key !== 'Escape' || !booksFiltersOpen) return;
  if (typeof e.preventDefault === 'function') e.preventDefault();
  booksFiltersOpen = false; renderBooksView(); focusFilterTarget('bFiltersBtn');
}

// A book in a series or author list: its saved status, else Add (and Skip in a series).
function bookPickHtml(rec, entry, { skipKey = null, skipped = false, hook = '', seriesPl = null } = {}) {
  if (entry) return `<span class="state-action">${bookStatusSelectHtml(entry, `status-${hook}`)}</span>`;
  const add = `<button class="btn btn-link" data-baction="add-${hook}" onclick="addHardcoverBook(${rec.id}${seriesPl ? `, ${JSON.stringify(seriesPl).replace(/"/g, '&quot;')}` : ''})">Add</button>`;
  const skip = skipKey ? ` <button class="btn btn-link" data-baction="skip-${hook}" onclick="toggleBookSkip('${bkArg(skipKey)}', ${skipped})">${skipped ? 'Unskip' : 'Skip'}</button>` : '';
  return add + skip;
}
function bookRecLine(rec, extra = '', entry = null) {
  const d = bookShownDate(entry, rec); // (a saved book shows its own date: the member's choice when there is one)
  const lang = rec.lang === 'unknown' ? ' <span class="state-tag">Language unknown</span>' : '';
  return `<span class="spot-version-name">${esc(rec.title)}${lang}${extra}</span> <span class="muted">${bookDateHtml(d)}</span>`;
}
// Which lists show their hidden records: the main screen's (page memory) or the open browse dialog's own set, which starts empty
// on each fresh browse (an author or series opened from + Add book), so it never inherits the main views' choices.
const bookHiddenSet = inDialog => (inDialog && booksDialog ? (booksDialog.showHidden || (booksDialog.showHidden = new Set())) : booksShowHidden);
function bookHiddenListHtml(owner, hidden, inDialog = false) {
  if (!hidden.length) return '';
  const open = bookHiddenSet(inDialog).has(owner);
  return `<div class="book-hidden"><button class="btn btn-link" data-baction="${esc(`hidden-${owner}`)}" aria-expanded="${open}" onclick="toggleBookHidden('${bkArg(owner)}', ${inDialog})">${open ? 'Hide' : 'Show'} ${countUnit(hidden.length, 'hidden record', 'hidden records')}</button>
    ${open ? `<p class="games-note">Shown here only. Hardcover keeps these as separate records; nothing is merged or changed.</p><ul class="spot-versions">${hidden.map(h => `<li class="spot-version">${bookRecLine(h.rec, h.position ? ` <span class="muted">#${esc(h.position)}</span>` : '')} <span class="muted">· ${esc(h.reason)}</span> ${bookPickHtml(h.rec, bookSavedFor(h.rec, bookSavedIndex(booksData.entries)), { hook: `h${h.rec.id}` })}</li>`).join('')}</ul>` : ''}</div>`;
}
function toggleBookHidden(owner, inDialog = false) {
  const set = bookHiddenSet(inDialog);
  if (set.has(owner)) set.delete(owner); else set.add(owner);
  if (inDialog) redrawBooksDialog(); else renderBooksView();
}
// A series' list (a followed series in Following, and Browse in + Add book).
function bookSeriesListHtml(s, { follow = null, inDialog = false } = {}) {
  const v = bookSeriesView(s, { entries: booksData.entries, decisions: booksData.decisions, today: booksToday() });
  const bulk = bookAddAllHtml(`s:${s.id}`, bookAddAllPlan({ kind: 'series', series: s }, bookPlanCtx()), inDialog, 'Add all in series');
  const item = (p, companion) => {
    const rec = p.rec, e = p.entry, key = e ? bookEntryKey(e) : rec ? `hc:${rec.id}` : null;
    const name = rec ? bookRecLine(rec, '', e) : `<span class="spot-version-name">${esc(e.title)}</span> <span class="state-tag">Not on Hardcover</span>`;
    const state = p.done && !companion ? ` <span class="state-tag">${p.skipped ? 'Skipped' : e ? esc(BOOK_STATUS_LABELS[e.status]) : 'Done'}</span>` : companion ? ' <span class="state-tag">Companion</span>' : '';
    const pick = rec ? bookPickHtml(rec, e, { skipKey: key, skipped: p.skipped, hook: `s${rec.id}`, seriesPl: { id: s.id, name: s.name, position: p.position } })
      : e ? `<span class="state-action">${bookStatusSelectHtml(e, `status-e${e.id}`)}</span>` : '';
    const next = v.next === p ? ' <span class="status-pill s-watching">Next</span>' : '';
    return `<li class="spot-version book-pos"><span class="book-pos-n">${p.position ? `#${esc(p.position)}` : '—'}</span> ${name}${state}${next} <span class="book-pick">${pick}</span></li>`;
  };
  return `${bulk}<ol class="spot-versions book-series-list">${v.positions.map(p => item(p, false)).join('')}</ol>
    ${v.companions.length ? `<p class="games-note">Companions (novellas and extras): listed and trackable, never the next book, never added automatically.</p><ul class="spot-versions">${v.companions.map(p => item(p, true)).join('')}</ul>` : ''}
    ${bookHiddenListHtml(`s:${s.id}`, v.hidden, inDialog)}`;
}
// Following: followed authors (each with their official page, series and other books; a series also followed on its own shows
// there with its own follow controls), then followed series not shown under a followed author. Author and series follows stay
// independent: following an author follows none of their series, and stopping one follow leaves the others.
function bookSeriesFollowOf(id) { return booksData.follows.find(f => f.kind === 'series' && f.hardcover_id === id) || null; }
// The followed series shown under each followed author: the author's verified series (as their list shows them).
function booksSeriesUnderAuthors() {
  const under = new Map(); // series id → author follow
  for (const f of booksData.follows.filter(x => x.kind === 'author')) {
    const a = booksData.cache.author.get(f.hardcover_id);
    if (!a) continue;
    const seriesList = (a.seriesIds || []).map(id => booksData.cache.series.get(id)).filter(Boolean);
    bookAuthorView(a, { seriesList, associations: booksData.associations, entries: booksData.entries, decisions: booksData.decisions, today: booksToday() })
      .verified.forEach(sr => { if (!under.has(sr.id)) under.set(sr.id, f); });
  }
  return under;
}
// A followed series' own controls (in its card, or under its author): automatic adding and Stop following.
function bookSeriesFollowControlsHtml(f, hookSuffix = '') {
  return `<label class="settings-check book-auto"><input type="checkbox" data-baction="auto${hookSuffix}" ${f.auto_add ? 'checked' : ''} onchange="setSeriesAutoAdd('${bkArg(f.id)}', this.checked)"> Automatically add new titles of ${esc(f.name)} on refresh</label>
    <button class="btn" data-baction="unfollow${hookSuffix}" onclick="unfollowBooks('${bkArg(f.id)}')">Stop following the series ${esc(f.name)}</button>`;
}
function bookSeriesNextHtml(s) {
  const v = s ? bookSeriesView(s, { entries: booksData.entries, decisions: booksData.decisions, today: booksToday() }) : null;
  return !v ? '<span class="muted">Not read from Hardcover yet: use Refresh books</span>'
    : v.next ? `<span class="fr-label">Next</span> <span class="fr-name">${esc(v.next.rec ? v.next.rec.title : v.next.entry.title)}</span> <span class="muted">#${esc(v.next.position)} · ${bookDateHtml(v.next.entry ? bookShownDate(v.next.entry, v.next.rec) : v.next.rec ? bookShownDate(null, v.next.rec) : null)}</span>`
      : '<span class="fr-label">Next</span> <span class="status-pill s-caughtup">Caught up</span>';
}
const bookExpandHtml = (f, open, what) => `<button type="button" class="expand-btn" data-baction="expand" aria-expanded="${open}" aria-label="${esc(`${open ? 'Hide' : 'Show'} ${what}`)}" onclick="event.stopPropagation(); toggleBookFollow('${bkArg(f.id)}')"><span class="expand-chevron">${open ? '▾' : '▸'}</span></button>`;
function bookSeriesFollowCardHtml(f) {
  const s = booksData.cache.series.get(f.hardcover_id), open = booksExpanded.has(f.id);
  const body = open ? `<div class="book-follow-body">${s ? bookSeriesListHtml(s, { follow: f }) : '<p class="muted">Nothing read from Hardcover yet: use Refresh books.</p>'}
      ${bookSeriesFollowControlsHtml(f)}<p class="games-note">New main titles are added as Want to read when they have an English edition and nothing else holds their place; anything uncertain waits in Review.</p></div>` : '';
  return `<div class="item-card show-group-card book-follow" data-bfollow="${esc(f.id)}">
      <div class="card-top" onclick="toggleBookFollow('${bkArg(f.id)}')" style="cursor:pointer">${bookExpandHtml(f, open, `the books of ${f.name}`)}<div class="card-title-block"><span class="card-title"><span class="show-title">${esc(f.name)}</span> <span class="state-tag">Series</span>${s && s.author ? ` <span class="muted">by ${esc(s.author.name)}</span>` : ''}${f.auto_add ? ' <span class="state-tag">Adds new titles</span>' : ''}</span></div></div>
      <div class="card-meta"><span class="card-season fr-next">${bookSeriesNextHtml(s)}</span></div>${body}</div>`;
}
function bookAuthorFollowCardHtml(f, ownSeries) {
  const a = booksData.cache.author.get(f.hardcover_id), open = booksExpanded.has(f.id);
  const site = booksData.sites.find(x => x.hardcover_author_id === f.hardcover_id), siteState = booksData.cache.site.get(f.hardcover_id);
  const siteLine = site ? `Official book page: <a href="${esc(site.listing_url)}" target="_blank" rel="noopener noreferrer">${esc(site.listing_url.replace(/^https:\/\//, ''))}</a>${siteState && siteState.unsupported ? ' · <strong>not recognised: Hardcover only</strong>' : siteState && siteState.checked ? ` · checked ${esc(siteState.checked)}` : ''}`
    : '<strong>Hardcover only</strong> (no official book page set)';
  const also = ownSeries.length ? `<span class="card-season book-also">Series also followed: ${ownSeries.map(x => `${esc(x.name)}${x.auto_add ? ' (adds new titles)' : ''}`).join(', ')}</span>` : '';
  const body = open ? `<div class="book-follow-body">${bookSiteFormHtml(f.hardcover_id, f.name, site)}${a ? bookAuthorListHtml(a) : '<p class="muted">Nothing read from Hardcover yet: use Refresh books.</p>'}
      <button class="btn" data-baction="unfollow" onclick="unfollowBooks('${bkArg(f.id)}')">Stop following the author ${esc(f.name)}</button>
      <p class="games-note">Stopping this follow keeps any series of theirs you follow on its own, and your saved books.</p></div>` : '';
  return `<div class="item-card show-group-card book-follow" data-bfollow="${esc(f.id)}">
      <div class="card-top" onclick="toggleBookFollow('${bkArg(f.id)}')" style="cursor:pointer">${bookExpandHtml(f, open, `the books of ${f.name}`)}<div class="card-title-block"><span class="card-title"><span class="show-title">${esc(f.name)}</span> <span class="state-tag">Author</span></span></div></div>
      <div class="card-meta"><span class="card-season">${siteLine}</span>${also}</div>${body}</div>`;
}
function booksFollowingHtml() {
  const authors = booksData.follows.filter(f => f.kind === 'author').sort((a, b) => compareTitles(a.name, b.name));
  const under = booksSeriesUnderAuthors();
  const seriesF = booksData.follows.filter(f => f.kind === 'series');
  const alone = seriesF.filter(f => !under.has(f.hardcover_id)).sort((a, b) => compareTitles(a.name, b.name));
  const count = authors.length || seriesF.length ? `${countUnit(authors.length, 'author', 'authors')} · ${countUnit(seriesF.length, 'series', 'series')} followed` : '';
  const toolbar = booksToolbarHtml({ count });
  if (!authors.length && !seriesF.length) return toolbar + `<div class="games-empty" data-books-empty="1" tabindex="-1"><p>You follow no authors or series. Find one with <strong>+ Add book</strong> (Authors or Series): browse their books, then follow them to have Refresh books look for new ones. Following adds nothing to your library.</p></div>`;
  const ownSeriesOf = f => seriesF.filter(x => under.get(x.hardcover_id) === f);
  return toolbar + `${authors.length ? `<h3 class="book-follow-head">Authors</h3><div class="books-follows" aria-label="Followed authors">${authors.map(f => bookAuthorFollowCardHtml(f, ownSeriesOf(f))).join('')}</div>` : ''}
    ${alone.length ? `<h3 class="book-follow-head">${authors.length ? 'Other series' : 'Series'}</h3><div class="books-follows" aria-label="Followed series">${alone.map(bookSeriesFollowCardHtml).join('')}</div>` : ''}`;
}
function bookSiteFormHtml(authorId, name, site) {
  const known = KNOWN_BOOK_SITES[authorId];
  const val = bookSiteDraft.has(authorId) ? bookSiteDraft.get(authorId) : site ? site.listing_url : known ? known.listing : '';
  return `<div class="book-site-form"><label for="bSite-${authorId}">Official book-listing page</label>
    <input id="bSite-${authorId}" class="search-input" type="url" placeholder="https://…" value="${esc(val)}" oninput="bookSiteDraft.set(${authorId}, this.value)">
    <button class="btn" data-baction="site-save" onclick="saveBookSite(${authorId}, '${bkArg(name)}')">Save</button>
    ${site ? `<button class="btn btn-link" data-baction="site-remove" onclick="saveBookSite(${authorId}, '${bkArg(name)}', true)">Remove</button>` : ''}
    <p class="games-note">Refresh books reads this page for new book pages and dates. ${known ? 'This author’s site is supported.' : 'Sites other than the supported ones are read with the same rule; a page that doesn’t look like a list of their books is reported and the author is checked on Hardcover only.'}</p></div>`;
}
// An author's books: their verified series in order, then their other books; Hidden below.
function bookAuthorListHtml(a, seriesSource = booksData.cache.series, inDialog = false) {
  const seriesList = (a.seriesIds || []).map(id => seriesSource.get(id)).filter(Boolean);
  const v = bookAuthorView(a, { seriesList, associations: booksData.associations, entries: booksData.entries, decisions: booksData.decisions, today: booksToday() });
  const inVerified = new Set(v.verified.flatMap(s => s.books.map(b => b.rec.id)));
  const others = v.shown.filter(x => !inVerified.has(x.rec.id));
  // A series of theirs: Follow it on its own, or, when it is followed, its own state (and in Following, its controls).
  const followBtn = s => { const sf = bookSeriesFollowOf(s.id);
    return sf ? `<span class="state-tag">Series followed${sf.auto_add ? ' · adds new titles' : ''}</span>`
      : `<button class="btn btn-link" data-baction="follow-s${s.id}" onclick="followBookSeries(${s.id}, '${bkArg(s.name)}')">Follow the series ${esc(s.name)}</button>`; };
  const ownControls = s => { const sf = !inDialog && bookSeriesFollowOf(s.id); return sf ? `<div class="book-series-controls">${bookSeriesFollowControlsHtml(sf, `-s${s.id}`)}</div>` : ''; };
  const gaps = v.gaps.length ? `<p class="games-note">${countUnit(v.gaps.length, 'book in their series is', 'books in their series are')} credited to someone else on Hardcover: ${v.gaps.map(g => `“${esc(g.rec.title)}”`).join(', ')}. Refresh books offers ${v.gaps.length === 1 ? 'it' : 'them'} in Review, where you can credit ${esc(a.name)}.</p>` : '';
  const bulk = bookAddAllHtml(`a:${a.id}`, bookAddAllPlan({ kind: 'author', author: a, seriesList }, bookPlanCtx()), inDialog, 'Add all books');
  return `${bulk}${v.verified.map(s => `<div class="book-author-series"><h4 class="book-sub">${esc(s.name)} ${followBtn(s)}</h4>${bookSeriesListHtml(s, { inDialog })}${ownControls(s)}</div>`).join('')}
    ${gaps}<h4 class="book-sub">${v.verified.length ? 'Other books' : 'Books'}</h4>
    <ul class="spot-versions">${others.map(x => `<li class="spot-version">${bookRecLine(x.rec, '', x.entry)} <span class="book-pick">${bookPickHtml(x.rec, x.entry, { hook: `a${x.rec.id}` })}</span></li>`).join('') || '<li class="muted">None.</li>'}</ul>
    ${bookHiddenListHtml(`a:${a.id}`, v.hidden, inDialog)}`;
}
// ── Add all ──
const bookPlanCtx = () => ({ entries: booksData.entries, decisions: booksData.decisions, associations: booksData.associations, today: booksToday() });
const bookBulkAsk = inDialog => (inDialog ? (booksDialog && booksDialog.bulkAsk) || null : booksBulkAsk);
// The button, or its confirmation in place. Nothing to add: a short line instead (no button that would add nothing).
function bookAddAllHtml(owner, plan, inDialog, label) {
  const o = bkArg(owner), hook = `bulk-${owner}`;
  if (!plan.length) return `<p class="games-note book-bulk" tabindex="-1" data-baction="${esc(hook)}-none">${esc(label)}: nothing to add (every main title is saved, skipped or dismissed).</p>`;
  if (bookBulkAsk(inDialog) !== owner) return `<p class="book-bulk"><button class="btn" data-baction="${esc(hook)}" onclick="askBookAddAll('${o}', ${inDialog})">${esc(label)} (${plan.length})</button></p>`;
  return `<div class="book-bulk book-bulk-ask" role="group" aria-label="${esc(label)}"><p>Add ${countUnit(plan.length, 'book', 'books')} as Want to read? Saved books keep their statuses; hidden records, companions, skipped and dismissed titles aren’t included.</p>
    <button class="btn btn-accent" data-baction="${esc(hook)}-yes" onclick="addAllBooks('${o}', ${inDialog})">Add ${plan.length}</button> <button class="btn" data-baction="${esc(hook)}-no" onclick="askBookAddAll(null, ${inDialog}, '${o}')">Cancel</button></div>`;
}
function bookBulkRedraw(inDialog, hook) {
  if (inDialog) { if (booksDialog) { booksDialog.focusHook = hook; redrawBooksDialog(); } return; }
  booksFocusIntent = { attr: null, row: null, hook, id: null, next: [], prev: [] };
  renderBooksView();
}
function askBookAddAll(owner, inDialog = false, back = null) {
  if (inDialog) { if (booksDialog) booksDialog.bulkAsk = owner; } else booksBulkAsk = owner;
  bookBulkRedraw(inDialog, owner ? `bulk-${owner}-yes` : `bulk-${back}`);
}
// The list an owner names, read now (the plan is made again at the moment of adding, from what is saved then).
function bookBulkTarget(owner, inDialog) {
  const [kind, raw] = String(owner).split(':'), id = Number(raw), b = inDialog && booksDialog ? booksDialog.browse : null;
  const seriesOf = sid => (b ? (b.series || []).find(s => s.id === sid) : null) || booksData.cache.series.get(sid) || null;
  if (kind === 's') { const s = seriesOf(id); return s ? { kind: 'series', series: s } : null; }
  const a = (b && b.author && b.author.id === id ? b.author : null) || booksData.cache.author.get(id);
  return a ? { kind: 'author', author: a, seriesList: (a.seriesIds || []).map(seriesOf).filter(Boolean) } : null;
}
// One write: the records cached, then each title added in turn (an automatic-style add: a title dismissed or removed meanwhile is
// refused, never brought back; one saved meanwhile is skipped). A failure stops it; what was added, skipped and not tried is said,
// and a failure whose outcome is unknown is reported as such. The list is read again afterwards.
async function addAllBooks(owner, inDialog = false) {
  const target = bookBulkTarget(owner, inDialog);
  const plan = target ? bookAddAllPlan(target, bookPlanCtx()) : [];
  if (inDialog) { if (booksDialog) booksDialog.bulkAsk = null; } else booksBulkAsk = null;
  const hook = `bulk-${owner}`;
  if (!plan.length) { showNotice('Nothing to add: every main title is saved, skipped or dismissed.'); bookBulkRedraw(inDialog, `${hook}-none`); return; }
  const name = target.kind === 'series' ? target.series.name : target.author.name;
  await runWrite(`${name} · add all`, async lane => {
    let added = 0, skipped = 0, failed = null, i = 0;
    try { await putBookCache({ books: plan.map(x => x.rec) }); }
    catch (err) { if (stateNeedsReread(err)) { showError(stateErrorText(err)); lane.after.push(() => reloadOpenView()); return; } console.error(err); }
    for (; i < plan.length; i++) {
      const { rec, seriesPl } = plan[i];
      try {
        const made = await sbRpc('library_book_add', { p_book: bookFromRec(rec, seriesPl), p_status: 'want', p_clear_keys: [], p_finding: null,
          p_refuse_keys: bookKeysOf({ hardcoverId: rec.id, title: rec.title, authors: rec.authors }) });
        if (made && booksData) booksData.entries.push(made);
        added++;
      } catch (err) {
        if (/book_duplicate|book_excluded/.test(String(err && err.message))) { skipped++; continue; }
        failed = { err, title: rec.title, unknown: orgErrorInfo(err).kind !== 'database' }; break;
      }
    }
    const notTried = failed ? plan.length - i - 1 : 0;
    const parts = [`Added ${countUnit(added, 'book', 'books')} from ${name} as Want to read`];
    if (skipped) parts.push(`${countUnit(skipped, 'was', 'were')} saved or dismissed meanwhile and left as ${skipped === 1 ? 'it was' : 'they were'}`);
    if (failed) {
      parts.push(failed.unknown ? `“${failed.title}” wasn’t confirmed: it may or may not have been added` : `“${failed.title}” wasn’t added (${stateErrorText(failed.err)})`);
      if (notTried) parts.push(`${countUnit(notTried, 'title', 'titles')} after it ${notTried === 1 ? 'wasn’t' : 'weren’t'} tried`);
    }
    if (booksDialog && inDialog) booksDialog.focusHook = hook;
    else booksFocusIntent = { attr: null, row: null, hook, id: null, next: [], prev: [] };
    if (booksDialog) redrawBooksDialog();
    if (failed) {
      // (read again first: a reread clears the error line, and what was saved must be what is shown)
      const ok = isBooksView() ? await reloadOpenView() : null;
      if (booksDialog && inDialog) { booksDialog.focusHook = hook; redrawBooksDialog(); }
      showError(`${parts.join('; ')}.${rereadText(ok)}`);
      return;
    }
    showSaved(); showNotice(`${parts.join('; ')}.`);
    if (isBooksView()) renderBooksView();
    lane.after.push(() => reloadOpenView());
  }, { list: true });
}
function toggleBookFollow(id) { if (booksExpanded.has(id)) booksExpanded.delete(id); else booksExpanded.add(id); renderBooksView(); }

// ── Focus (the list's rule, for this screen) ──
function captureBooksFocus() {
  if (booksFocusIntent) { const i = booksFocusIntent; booksFocusIntent = null; return i; }
  if (!documentHasFocus()) return null;
  const a = document.activeElement;
  if (!a || typeof a.closest !== 'function' || !a.closest('#booksScreen')) return null;
  const rowEl = a.closest('[data-book], [data-bfollow]');
  const hookEl = a.closest('[data-baction]');
  const attr = rowEl ? (rowEl.getAttribute('data-book') != null ? 'data-book' : 'data-bfollow') : null;
  const screen = document.getElementById('booksScreen');
  const ids = attr ? [...new Set([...screen.querySelectorAll(`[${attr}]`)].map(x => x.getAttribute(attr)))] : [];
  const row = rowEl ? rowEl.getAttribute(attr) : null, at = ids.indexOf(row);
  const sel = a.id && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd, a.selectionDirection || 'none'] : null;
  return { attr, row, hook: hookEl ? hookEl.getAttribute('data-baction') : null, id: a.id || null, sel,
    next: at >= 0 ? ids.slice(at + 1) : [], prev: at >= 0 ? ids.slice(0, at).reverse() : [] };
}
function applyBooksFocus(rec) {
  if (!rec || !documentHasFocus()) return;
  const screen = document.getElementById('booksScreen');
  if (!screen || typeof screen.querySelector !== 'function') return;
  const q = JSON.stringify.bind(JSON);
  const usable = el => !!el && !el.disabled && typeof el.focus === 'function';
  const shownOf = sel => { const all = [...screen.querySelectorAll(sel)]; return all.find(x => typeof x.getClientRects !== 'function' || x.getClientRects().length > 0) || all[0] || null; };
  let el = null;
  if (rec.row) {
    const inRow = (r, sel) => shownOf(`[${rec.attr}=${q(String(r))}] ${sel}`);
    if (rec.hook) el = inRow(rec.row, `[data-baction=${q(rec.hook)}]`);
    // An Add just done: the book's new status control.
    if (!usable(el) && rec.hook && /^add-/.test(rec.hook)) el = inRow(rec.row, `[data-baction=${q(`status-${rec.hook.slice(4)}`)}]`);
    if (!usable(el)) el = inRow(rec.row, '[data-baction="more"], [data-baction="expand"]');
    for (const r of rec.next.concat(rec.prev)) { if (usable(el)) break; el = inRow(r, '[data-baction="more"], [data-baction="expand"]'); }
  } else if (rec.id) el = document.getElementById(rec.id);
  else if (rec.hook) {
    el = shownOf(`[data-baction=${q(rec.hook)}]`);
    // (Add all: its button, else the line that says nothing is left to add)
    if (!usable(el) && /^bulk-/.test(rec.hook)) { const base = rec.hook.replace(/-(yes|no|none)$/, ''); el = shownOf(`[data-baction=${q(base)}]`) || shownOf(`[data-baction=${q(`${base}-none`)}]`); }
  }
  if (!usable(el)) el = ['[data-books-empty]', '#bSearch', '#booksTitle'].map(sel => screen.querySelector(sel)).find(usable) || null;
  if (!usable(el)) return;
  el.focus();
  if (rec.sel && el.id === rec.id && typeof el.setSelectionRange === 'function') el.setSelectionRange(...rec.sel);
}

// ── Changes ──
function bookFromRec(rec, seriesPl = null) {
  const series = seriesPl ? [seriesPl] : rec.series.filter(s => s.position != null).slice(0, 3).map(s => ({ id: s.id, name: s.name, position: s.position }));
  return { hardcover_id: rec.id, title: rec.title.slice(0, 300), authors: rec.authors.slice(0, 20).map(a => ({ id: a.id, name: a.name.slice(0, 200) })),
    series: series.map(s => ({ ...(s.id ? { id: s.id } : {}), name: String(s.name).slice(0, 200), ...(s.position != null && /^\d{1,3}(\.\d{1,2})?$/.test(String(s.position)) ? { position: String(s.position) } : {}) })) };
}
function bookRecAnywhere(id) {
  const r = bookRecOf(id);
  if (r) return r;
  if (booksDialog && booksDialog.recs) return booksDialog.recs.get(id) || null;
  return null;
}
async function addHardcoverBook(id, seriesPl = null, finding = null, status = 'want') {
  const rec = bookRecAnywhere(id);
  if (!rec) { showError('This book’s details aren’t loaded; use Refresh books or search again.'); return; }
  const book = bookFromRec(rec, seriesPl), keys = bookKeysOf({ hardcoverId: rec.id, title: rec.title, authors: rec.authors });
  await runWrite(`“${rec.title}” · add`, async lane => {
    try {
      await putBookCache({ books: [rec] });
      const made = await sbRpc('library_book_add', { p_book: book, p_status: status, p_clear_keys: keys, p_finding: finding });
      if (booksData && made) { booksData.entries.push(made); if (finding) booksData.findings = booksData.findings.filter(f => f.fingerprint !== finding); keys.forEach(k => booksData.decisions.delete(`exclude|${k}`)); }
      showSaved();
      showNotice(`Added “${rec.title}” as ${BOOK_STATUS_LABELS[status]}.${made && made.exclusions_lifted ? ' It was removed or dismissed before; it can come back in refreshes now.' : ''}`);
      if (booksDialog) redrawBooksDialog();
      if (isBooksView()) renderBooksView();
      lane.after.push(() => { if (isBooksView()) reloadOpenView(); });
    } catch (e) {
      showError(stateErrorText(e));
      if (stateNeedsReread(e) && isBooksView()) await reloadOpenView();
    }
  }, { list: isBooksView() });
}
async function setBookStatus(entryId, status) {
  const e = booksData && booksData.entries.find(x => x.id === entryId);
  if (!e || e.status === status) return;
  await runWrite(`“${e.title}” · ${BOOK_STATUS_LABELS[status]}`, async lane => {
    const before = e.status;
    e.status = status; renderBooksView(); if (booksDialog) redrawBooksDialog();
    try {
      await sbRpc('library_book_set', { p_entry_id: e.id, p_expected_status: before, p_status: status });
      showSaved();
      lane.after.push(() => reloadOpenView());
    } catch (err) {
      e.status = before;
      if (stateNeedsReread(err)) { await reportStateFailure(err); return; }
      showError(stateErrorText(err)); renderBooksView();
    }
  }, { list: true });
}
async function setBookDecision(kind, key, value, label, finding = null, outcome = null) {
  const cur = booksData && booksData.decisions.get(`${kind}|${key}`);
  await runWrite(label, async lane => {
    try {
      await sbRpc('library_book_decision_set', { p_kind: kind, p_key: key, p_expected: cur ? cur.value : null, p_value: value, p_finding: finding, p_outcome: outcome });
      if (value === null) booksData.decisions.delete(`${kind}|${key}`); else booksData.decisions.set(`${kind}|${key}`, { kind, key, value });
      if (finding && outcome === 'done') booksData.findings = booksData.findings.filter(f => f.fingerprint !== finding);
      showSaved(); renderBooksView(); if (booksDialog) redrawBooksDialog();
      lane.after.push(() => reloadOpenView());
    } catch (err) {
      if (stateNeedsReread(err)) { await reportStateFailure(err); return; }
      showError(stateErrorText(err));
    }
  }, { list: true });
}
function toggleBookSkip(key, skipped) { return setBookDecision('skip', key, skipped ? null : {}, skipped ? 'Unskip' : 'Skip in its series'); }
function confirmDeleteBook(entryId) {
  const e = booksData && booksData.entries.find(x => x.id === entryId);
  if (!e) return;
  showBooksDialog(`<h2 class="modal-title" id="bookDialogTitle">Remove “${esc(e.title)}”?</h2>
    <p>It leaves your library, and Refresh books won’t offer it again (from Hardcover or an official site) until you add it again yourself.</p>
    <div class="modal-actions"><button class="btn" onclick="closeBooksDialog()">Cancel</button>
      <button class="btn-danger" id="bDeleteConfirm" onclick="deleteBook('${bkArg(e.id)}')">Remove from library</button></div>`);
  focusFilterTarget('bDeleteConfirm');
}
async function deleteBook(entryId, { keys = null, label = null } = {}) {
  const e = booksData && booksData.entries.find(x => x.id === entryId);
  if (!e) { closeBooksDialog(); return; }
  const box = document.getElementById('booksScreen');
  const ids = box && typeof box.querySelectorAll === 'function' ? [...box.querySelectorAll('[data-book]')].map(x => x.getAttribute('data-book')) : [];
  const at = ids.indexOf(e.id);
  booksFocusIntent = { attr: 'data-book', row: e.id, hook: 'more', next: at >= 0 ? ids.slice(at + 1) : [], prev: at >= 0 ? ids.slice(0, at).reverse() : [] };
  closeBooksDialog(false);
  const exclude = keys || [...new Set([bookEntryKey(e), ...bookKeysOf({ hardcoverId: e.hardcover_id, title: e.title, authors: e.authors || [] })])].slice(0, 20);
  await runWrite(label || `“${e.title}” · remove`, async lane => {
    try {
      await sbRpc('library_book_delete', { p_entry_id: e.id, p_expected_status: e.status, p_exclude_keys: exclude });
      booksData.entries = booksData.entries.filter(x => x.id !== e.id);
      showSaved(); showNotice(`Removed “${e.title}”. Refresh books won’t offer it again unless you add it yourself.`);
      renderBooksView();
      lane.after.push(() => reloadOpenView());
    } catch (err) {
      if (stateNeedsReread(err)) { await reportStateFailure(err); return; }
      showError(stateErrorText(err));
    }
  }, { list: true });
}
async function editBookFields(entryId, fields, label, finding = null) {
  const e = booksData && booksData.entries.find(x => x.id === entryId);
  if (!e) return false;
  const expected = Object.fromEntries(Object.keys(fields).map(k => [k, e[k] === undefined ? null : e[k]]));
  let ok = false;
  await runWrite(label, async lane => {
    try {
      const saved = await sbRpc('library_book_edit', { p_entry_id: e.id, p_expected: expected, p_fields: fields, p_finding: finding });
      Object.assign(e, saved);
      if (finding) booksData.findings = booksData.findings.filter(f => f.fingerprint !== finding);
      ok = true; showSaved(); renderBooksView();
      lane.after.push(() => reloadOpenView());
    } catch (err) {
      if (stateNeedsReread(err)) { await reportStateFailure(err); return; }
      showError(stateErrorText(err));
    }
  }, { list: true });
  return ok;
}
async function linkBook(entryId, rec, finding = null) {
  const e = booksData && booksData.entries.find(x => x.id === entryId);
  if (!e || !rec) return;
  const fields = { title: rec.title.slice(0, 300), authors: bookFromRec(rec).authors, series: (e.series && e.series.length ? e.series : bookFromRec(rec).series) };
  await runWrite(`“${e.title}” · match`, async lane => {
    try {
      await putBookCache({ books: [rec] });
      const saved = await sbRpc('library_book_link', { p_entry_id: e.id, p_expected_hardcover_id: e.hardcover_id || null, p_hardcover_id: rec.id, p_fields: fields, p_finding: finding });
      Object.assign(e, saved);
      if (finding) booksData.findings = booksData.findings.filter(f => f.fingerprint !== finding);
      showSaved(); showNotice(`“${e.title}” is now linked to Hardcover. Its status, date and series place are kept.`);
      closeBooksDialog(); renderBooksView();
      lane.after.push(() => reloadOpenView());
    } catch (err) {
      if (stateNeedsReread(err)) { await reportStateFailure(err); return; }
      showError(stateErrorText(err));
    }
  }, { list: true });
}

// ── Following ──
// A new follow's starting catalog (its baseline): what is listed now is never offered as new later. A failure to save it is
// reported and harmless: the next Refresh makes it from that read, and offers nothing new for the follow that time.
async function saveBookBaseline(f, read) {
  const ids = bookFollowCatalogIds(f, read);
  if (!f || !ids.length) return true;
  try {
    const d = await sbRpc('library_book_decision_set', { p_kind: 'baseline', p_key: bookBaselineKey(f), p_expected: null, p_value: { ids }, p_finding: null, p_outcome: null });
    if (booksData && d) booksData.decisions.set(`baseline|${bookBaselineKey(f)}`, { kind: 'baseline', key: bookBaselineKey(f), value: { ids } });
    return true;
  } catch (err) { if (stateNeedsReread(err)) throw err; console.error(err); return false; }
}
async function followBookAuthor(id, name) {
  let got;
  try { got = await hardcoverAuthor(id); } catch (e) { showError(`${e.message} Nothing was changed.`); return; }
  const known = KNOWN_BOOK_SITES[id], hasSite = booksData && booksData.sites.some(s => s.hardcover_author_id === id);
  await runWrite(`Follow ${name}`, async lane => {
    try {
      const f = await sbRpc('library_book_follow', { p_kind: 'author', p_hardcover_id: id, p_name: String(name).slice(0, 200), p_auto_add: false });
      await saveBookBaseline(f, { authors: new Map([[id, got.author]]), seriesOf: new Map([[id, got.author.seriesIds]]), series: new Map(got.series.map(x => [x.id, x])) });
      await putBookCache({ authors: [got.author], series: got.series });
      if (known && !hasSite) { const s = await sbRpc('library_book_site_set', { p_author_id: id, p_author_name: String(name).slice(0, 200), p_expected_url: null, p_url: known.listing }); if (booksData) booksData.sites.push(s); }
      if (booksData && f) booksData.follows.push(f);
      showSaved();
      showNotice(`Following ${name}. Refresh books looks for their new books${known ? ' on Hardcover and their official site' : ' on Hardcover'}; you review each one. Nothing was added to your library, and none of their series is followed unless you follow it too.`);
      if (booksDialog) redrawBooksDialog();
      if (isBooksView()) renderBooksView();
      lane.after.push(() => { if (isBooksView()) reloadOpenView(); });
    } catch (err) { showError(stateErrorText(err)); if (stateNeedsReread(err) && isBooksView()) await reloadOpenView(); }
  }, { list: isBooksView() });
}
async function followBookSeries(id, name) {
  let s;
  try { s = await hardcoverSeries(id); } catch (e) { showError(`${e.message} Nothing was changed.`); return; }
  const author = s.author, known = author && KNOWN_BOOK_SITES[author.id], hasSite = author && booksData && booksData.sites.some(x => x.hardcover_author_id === author.id);
  await runWrite(`Follow ${name}`, async lane => {
    try {
      const f = await sbRpc('library_book_follow', { p_kind: 'series', p_hardcover_id: id, p_name: String(name).slice(0, 200), p_auto_add: false });
      await saveBookBaseline(f, { authors: new Map(), seriesOf: new Map(), series: new Map([[id, s]]) });
      await putBookCache({ series: [s] });
      if (known && !hasSite) { const x = await sbRpc('library_book_site_set', { p_author_id: author.id, p_author_name: String(author.name).slice(0, 200), p_expected_url: null, p_url: known.listing }); if (booksData) booksData.sites.push(x); }
      if (booksData && f) booksData.follows.push(f);
      showSaved();
      showNotice(`Following ${name}. Its next book is in Books → Following. Nothing was added to your library; you can turn on automatic adding there.`);
      if (booksDialog) redrawBooksDialog();
      if (isBooksView()) renderBooksView();
      lane.after.push(() => { if (isBooksView()) reloadOpenView(); });
    } catch (err) { showError(stateErrorText(err)); if (stateNeedsReread(err) && isBooksView()) await reloadOpenView(); }
  }, { list: isBooksView() });
}
async function unfollowBooks(followId) {
  const f = booksData && booksData.follows.find(x => x.id === followId);
  if (!f) return;
  await runWrite(`Stop following ${f.name}`, async lane => {
    try {
      await sbRpc('library_book_unfollow', { p_follow_id: f.id });
      booksData.follows = booksData.follows.filter(x => x.id !== f.id); booksExpanded.delete(f.id);
      showSaved(); showNotice(`You no longer follow ${f.name}. Your saved books and decisions are unchanged.`);
      renderBooksView();
      lane.after.push(() => reloadOpenView());
    } catch (err) { if (stateNeedsReread(err)) { await reportStateFailure(err); return; } showError(stateErrorText(err)); }
  }, { list: true });
}
async function setSeriesAutoAdd(followId, on) {
  const f = booksData && booksData.follows.find(x => x.id === followId);
  if (!f || f.auto_add === on) return;
  await runWrite(`${f.name} · automatic adding ${on ? 'on' : 'off'}`, async lane => {
    const before = f.auto_add;
    try {
      const saved = await sbRpc('library_book_follow_set', { p_follow_id: f.id, p_expected_auto_add: before, p_auto_add: on });
      Object.assign(f, saved); showSaved(); renderBooksView();
      lane.after.push(() => reloadOpenView());
    } catch (err) { if (stateNeedsReread(err)) { await reportStateFailure(err); return; } showError(stateErrorText(err)); renderBooksView(); }
  }, { list: true });
}
async function saveBookSite(authorId, name, remove = false) {
  const site = booksData && booksData.sites.find(s => s.hardcover_author_id === authorId);
  const url = remove ? null : String(bookSiteDraft.has(authorId) ? bookSiteDraft.get(authorId) : site ? site.listing_url : (KNOWN_BOOK_SITES[authorId] || {}).listing || '').trim();
  if (!remove && !/^https:\/\/[A-Za-z0-9.-]+(\/\S*)?$/.test(url)) { showError('The official page must be an https address, such as https://example.com/books. Nothing was changed.'); return; }
  await runWrite(`${name} · official page`, async lane => {
    try {
      const saved = await sbRpc('library_book_site_set', { p_author_id: authorId, p_author_name: String(name).slice(0, 200), p_expected_url: site ? site.listing_url : null, p_url: url });
      booksData.sites = booksData.sites.filter(s => s.hardcover_author_id !== authorId);
      if (!remove) booksData.sites.push(saved);
      bookSiteDraft.delete(authorId); booksData.cache.site.delete(authorId);
      showSaved(); renderBooksView();
      lane.after.push(() => reloadOpenView());
    } catch (err) { if (stateNeedsReread(err)) { await reportStateFailure(err); return; } showError(stateErrorText(err)); }
  }, { list: true });
}

// ── Refresh books: Hardcover for followed authors and series, then supported official sites ──
async function readBookSite(authorId, authorName, url, known) {
  const prev = booksData.cache.site.get(authorId) || null;
  const home = KNOWN_BOOK_SITES[authorId] && KNOWN_BOOK_SITES[authorId].home ? KNOWN_BOOK_SITES[authorId].home : null;
  const first = await booksFn({ op: 'site', listing: url, ...(home ? { home } : {}) });
  const out = { ok: !!(first.listing && first.listing.ok), authorName, listing: first.listing, home: first.home, pages: new Map(), prev, error: first.listing && first.listing.error };
  if (!out.ok) return out;
  // Pages to read: candidates that match no known title (up to five), then saved books whose date may be missing or a placeholder.
  const names = c => bookCandidateNames(c, authorName);
  const unmatched = first.listing.candidates.filter(c => !names(c).some(n => known.has(n))).slice(0, 5);
  const needDate = first.listing.candidates.filter(c => { const k = names(c).find(n => known.has(n)); const x = k && known.get(k); return x && x.needsDate; }).slice(0, 3);
  const pageUrls = [...new Set([...unmatched, ...needDate].map(c => c.url))].slice(0, 8);
  if (pageUrls.length) {
    const r = await booksFn({ op: 'site', pages: pageUrls });
    (r.pages || []).forEach(p => out.pages.set(p.url, p));
    // A book page with no date that links to its publisher's page: that page's date (at most two).
    const pubs = (r.pages || []).filter(p => p.ok && !p.date && (p.publishers || []).length).slice(0, 2);
    if (pubs.length) {
      const r2 = await booksFn({ op: 'site', pages: pubs.map(p => p.publishers[0]) });
      (r2.pages || []).forEach((pp, i) => { const p = pubs[i]; if (pp.ok && pp.date) { p.publisherDate = pp.date; p.publisherUrl = pp.url; } });
    }
  }
  // (pages are keyed by the address asked for, which a redirect may have changed: keep both)
  for (const c of first.listing.candidates) { for (const [u, p] of out.pages) if (new URL(u).pathname.replace(/\/+$/, '') === c.path) out.pages.set(c.url, p); }
  return out;
}
async function refreshBooks() {
  if (!booksData || booksRefreshing) return;
  if (writeLane) { showError(LANE_BUSY_TEXT(writeLane.label)); return; }
  const fromButton = !!(document.activeElement && typeof document.activeElement.getAttribute === 'function' && document.activeElement.getAttribute('data-baction') === 'refresh');
  booksRefreshing = true; booksReport = ''; renderBooksView();
  const today = booksToday(), follows = booksData.follows.slice();
  const read = { authors: new Map(), series: new Map(), seriesOf: new Map(), sites: new Map() };
  const failed = [];
  try {
    for (const f of follows.filter(x => x.kind === 'author')) {
      try { const got = await hardcoverAuthor(f.hardcover_id); read.authors.set(f.hardcover_id, got.author); read.seriesOf.set(f.hardcover_id, got.author.seriesIds); got.series.forEach(s => read.series.set(s.id, s)); }
      catch (e) { failed.push(f.name); }
    }
    const want = follows.filter(x => x.kind === 'series' && !read.series.has(x.hardcover_id));
    if (want.length) {
      const r = await hardcoverQueries(want.map(f => ({ name: `x${f.hardcover_id}`, q: 'series', vars: { id: f.hardcover_id } })));
      want.forEach(f => { const x = r[`x${f.hardcover_id}`]; if (x && x.data) read.series.set(f.hardcover_id, seriesRecord(x.data)); else failed.push(f.name); });
    }
    // The followed series' authors, for their sites.
    for (const f of follows.filter(x => x.kind === 'series')) {
      const s = read.series.get(f.hardcover_id);
      if (s && s.author) { const list = read.seriesOf.get(s.author.id) || []; if (!list.includes(s.id)) read.seriesOf.set(s.author.id, list.concat(s.id)); }
    }
    // A followed series' author with an official page set: their whole catalog is read too, only so the site's links can be
    // matched to books Hardcover knows (their other books stay out of scope until the author is followed).
    for (const f of follows.filter(x => x.kind === 'series')) {
      const s = read.series.get(f.hardcover_id), aid = s && s.author && s.author.id;
      if (!aid || read.authors.has(aid) || !booksData.sites.some(x => x.hardcover_author_id === aid)) continue;
      try { const got = await hardcoverAuthor(aid); read.authors.set(aid, got.author); read.seriesOf.set(aid, [...new Set((read.seriesOf.get(aid) || []).concat(got.author.seriesIds))]); got.series.forEach(x => { if (!read.series.has(x.id)) read.series.set(x.id, x); }); }
      catch (e) { read.noCatalog = (read.noCatalog || new Set()).add(aid); }
    }
  } catch (e) {
    booksRefreshing = false; booksReport = '';
    showError(`Refresh books couldn’t read Hardcover (${e.message}), so nothing was changed.`);
    renderBooksView();
    return;
  }
  // Official sites: followed authors and the authors of followed series that have a page set.
  const siteAuthors = new Map();
  follows.filter(f => f.kind === 'author').forEach(f => siteAuthors.set(f.hardcover_id, f.name));
  follows.filter(f => f.kind === 'series').forEach(f => { const s = read.series.get(f.hardcover_id); if (s && s.author) siteAuthors.set(s.author.id, s.author.name); });
  const siteFailures = [];
  for (const [authorId, name] of siteAuthors) {
    const site = booksData.sites.find(s => s.hardcover_author_id === authorId);
    if (!site) continue;
    // (without their catalog the site's links couldn't be matched, so it isn't checked this time)
    if (read.noCatalog && read.noCatalog.has(authorId)) { read.sites.set(authorId, { ok: false, authorName: name, error: 'their Hardcover catalog couldn’t be read' }); siteFailures.push(name); continue; }
    const known = new Map();
    const a = read.authors.get(authorId);
    (a ? a.books : []).forEach(r => known.set(normBookTitle(r.title), { rec: r }));
    (read.seriesOf.get(authorId) || []).forEach(id => { const s = read.series.get(id); if (s) s.books.forEach(b => { const t = normBookTitle(b.rec.title); if (!known.has(t)) known.set(t, { rec: b.rec }); }); });
    booksData.entries.forEach(e => {
      const rec = e.hardcover_id ? bookRecOf(e.hardcover_id) : null, d = bookShownDate(e, rec);
      const needsDate = !(e.chosen_date && e.chosen_date.source === 'member') && (!d || d.value === 'TBA' || d.placeholder || d.value.length < 10 || bookUpcoming(d, today));
      const k = normBookTitle(e.title);
      if (known.has(k)) known.get(k).needsDate = known.get(k).needsDate || needsDate;
      else if ((e.authors || []).some(x => x.id === authorId || normBookTitle(x.name) === normBookTitle(name))) known.set(k, { entry: e, needsDate });
    });
    try { read.sites.set(authorId, await readBookSite(authorId, name, site.listing_url, known)); }
    catch (e) { read.sites.set(authorId, { ok: false, authorName: name, error: e.message }); siteFailures.push(name); }
  }
  const found = bookRefreshFindings(read, { entries: booksData.entries, follows, associations: booksData.associations, decisions: booksData.decisions, findings: booksData.findings, today });
  found.report.hardcoverFailed.push(...failed.filter(n => !found.report.hardcoverFailed.includes(n)));
  // Sites the rule didn't recognise as a book list: remembered (replaceable) so Following can say so.
  const unsupported = found.report.hardcoverOnly.filter(x => /doesn’t look/.test(x.why));
  await runWrite('Refresh books', async lane => {
    let added = 0;
    try {
      const books = booksData.entries.filter(e => e.hardcover_id).map(e => { for (const a of read.authors.values()) { const r = a.books.find(b => b.id === e.hardcover_id); if (r) return r; } for (const s of read.series.values()) { const b = s.books.find(x => x.rec.id === e.hardcover_id); if (b) return b.rec; } return null; }).filter(Boolean);
      const sites = found.siteCache.concat(unsupported.map(x => { const id = [...siteAuthors.entries()].find(([, n]) => n === x.author); return id ? { authorId: id[0], data: { v: 1, unsupported: true, checked: today } } : null; }).filter(Boolean));
      // The cache is replaceable: a failure to save it is reported and the refresh goes on.
      try { await putBookCache({ authors: [...read.authors.values()], series: [...read.series.values()], books, sites }); }
      catch (err) { if (stateNeedsReread(err)) throw err; console.error(err); found.report.cacheFailed = true; }
      for (let i = 0; i < Math.max(found.rows.length, found.close.length ? 1 : 0); i += 200) {
        await sbRpc('library_book_findings_record', { p_rows: found.rows.slice(i, i + 200), p_close: i === 0 ? found.close.slice(0, 200) : [] });
      }
      // Starting catalogs for follows made before BK1b (from this read; nothing was offered as new for them this time).
      let based = 0;
      for (const b of found.baselines) if (await saveBookBaseline(b.follow, read)) based++;
      for (const x of found.autoAdd) {
        const book = bookFromRec(x.rec, { id: x.series.id, name: x.series.name, position: x.position });
        try {
          const made = await sbRpc('library_book_add', { p_book: book, p_status: 'want', p_clear_keys: [], p_finding: x.fingerprint,
            p_refuse_keys: bookKeysOf({ hardcoverId: x.rec.id, title: x.rec.title, authors: x.rec.authors }) });
          if (made) { booksData.entries.push(made); added++; }
        } catch (err) { if (!/book_duplicate|book_excluded/.test(String(err && err.message))) throw err; } // (saved or excluded meanwhile, perhaps on another device)
      }
      showSaved();
      const r = found.report, parts = [];
      const fresh = found.rows.filter(x => !booksData.findings.some(f => f.fingerprint === x.fingerprint));
      parts.push(fresh.length ? `${countUnit(fresh.length, 'new item', 'new items')} for review` : 'nothing new for review');
      if (added) parts.push(`${countUnit(added, 'title', 'titles')} added automatically as Want to read`);
      parts.push(`Hardcover: ${countUnit(r.hardcover, 'follow', 'follows')} checked${r.hardcoverFailed.length ? `, couldn’t read ${r.hardcoverFailed.map(esc).join(', ')}` : ''}`);
      if (r.sites.length) parts.push(`official sites checked: ${r.sites.map(esc).join(', ')}`);
      if (r.sitesFailed.length) parts.push(`<strong>couldn’t read ${r.sitesFailed.map(x => esc(x.author)).join(', ')}’s site</strong> (Hardcover results above still count)`);
      if (r.hardcoverOnly.length) parts.push(`Hardcover only: ${r.hardcoverOnly.map(x => `${esc(x.author)} (${esc(x.why)})`).join(', ')}`);
      if (r.cacheFailed) parts.push('the catalog copy couldn’t be saved this time (it is refilled next time)');
      if (based) parts.push(`${countUnit(based, 'follow’s', 'follows’')} current catalog noted as already seen (only later titles count as new)`);
      if (r.siteMatched) parts.push(`${countUnit(r.siteMatched, 'official-site item', 'official-site items')} closed: Hardcover lists ${r.siteMatched === 1 ? 'that book' : 'those books'} for the author`);
      if (r.editions) parts.push(`${countUnit(r.editions, 'edition notice', 'edition notices')} on official sites left out`);
      booksReport = `<strong>Refresh books:</strong> ${parts.join(' · ')}.`;
      lane.after.push(() => reloadOpenView());
    } catch (err) {
      showError(stateErrorText(err));
      if (stateNeedsReread(err)) await reloadOpenView();
    }
  }, { list: true });
  booksRefreshing = false;
  // (the button was disabled while it ran, so focus may have left it: it goes back there)
  if (fromButton) booksFocusIntent = { attr: null, row: null, hook: 'refresh', id: null, next: [], prev: [] };
  if (isBooksView()) renderBooksView();
}

// ── Review ──
function bookFindingText(f) {
  const s = f.subject || {}, src = f.source === 'website' ? 'Official site' : 'Hardcover';
  const by = s.authors ? ` by ${s.authors.map(a => a.name).join(', ')}` : s.author ? ` by ${s.author}` : '';
  if (f.kind === 'new_book') return { src, text: `${s.why ? `${s.why}: ` : ''}“${s.title}”${by}${s.date ? ` · ${bookDateText({ value: s.date })}` : ''}${s.lang === 'unknown' ? ' · language unknown on Hardcover' : ''}${s.maybe === 'edition' ? ' · this may be an edition or collection rather than a new book' : ''}${f.source === 'website' && s.first_check ? ' · listed on their book page (first check of this site)' : f.source === 'website' ? ' · newly listed on their book page; not on Hardcover yet' : ''}${s.series_hint ? ` · listed under ${s.series_hint}` : ''}.` };
  if (f.kind === 'date') return { src, text: `“${s.title}”: ${s.author ? `${s.author}’s site` : 'the official site'} says ${s.quote ? `“${s.quote}”` : bookDateText({ value: s.suggested })}; your library shows ${s.current ? bookDateText({ value: s.current }) : 'no date'}${s.current_source === 'hardcover' ? ' (from Hardcover)' : ''}.` };
  if (f.kind === 'credit_gap') return { src, text: `“${s.title}” is #${s.series.position} in ${s.series.name}, but Hardcover credits it to ${(s.credited || []).join(', ') || 'no-one'}, not ${s.author}.` };
  if (f.kind === 'match') return { src, text: `Your book “${s.title}” (not linked to Hardcover) may be Hardcover’s “${s.hardcover_title}”${s.authors ? ` by ${s.authors.map(a => a.name).join(', ')}` : ''}.` };
  if (f.kind === 'duplicate') return { src: 'Your library', text: `These saved books may be the same book: ${(s.entries || []).map(e => `“${e.title}” (${BOOK_STATUS_LABELS[e.status] || e.status})`).join(' and ')}.` };
  if (f.kind === 'site_changed') return { src, text: `${s.author}’s book page changed a lot (${s.fresh} new links, ${s.vanished} gone), so its links weren’t offered one by one. The site may have been redesigned.` };
  return { src, text: 'A change to review.' };
}
function bookFindingActions(f, i) {
  const s = f.subject || {}, b = (label, fn, primary = false) => `<button class="btn${primary ? ' btn-accent' : ''}" onclick="${fn}">${esc(label)}</button>`;
  const later = f.status === 'later' ? b('Back to review', `bookFindingResolve(${i}, 'pending')`) : b('Later', `bookFindingResolve(${i}, 'later')`);
  if (f.kind === 'new_book') return `${b('Add as Want to read', `bookReviewAdd(${i})`, true)} ${b('Not interested', `bookReviewDismiss(${i})`)} ${later}`;
  if (f.kind === 'date') return `${b('Use this date', `bookReviewUseDate(${i})`, true)} ${b('Keep current date', `bookReviewKeepDate(${i})`)} ${later}`;
  if (f.kind === 'credit_gap') return `${b(`Credit ${s.author}`, `bookReviewCredit(${i}, true)`, true)} ${b(`Not ${s.author}’s`, `bookReviewCredit(${i}, false)`)} ${later}`;
  if (f.kind === 'match') return `${b('Link to Hardcover', `bookReviewMatch(${i}, true)`, true)} ${b('Different books', `bookReviewMatch(${i}, false)`)} ${later}`;
  if (f.kind === 'duplicate') return `${b('Different books', `bookReviewNotSame(${i})`, true)} ${(s.entries || []).map(e => b(`Remove “${e.title}” (${BOOK_STATUS_LABELS[e.status] || e.status})`, `bookReviewRemoveCopy(${i}, '${bkArg(e.id)}')`)).join(' ')} ${later}`;
  if (f.kind === 'site_changed') return `${b('Offer its links for review', `bookReviewSiteReset(${i})`, true)} ${b('Dismiss', `bookFindingResolve(${i}, 'done')`)}`;
  return later;
}
function bookReviewList() { return booksData.findings.slice().sort((a, b) => (a.status === 'later') - (b.status === 'later') || String(a.first_seen_at).localeCompare(String(b.first_seen_at))); }
function openBooksReview(opener) {
  booksDialog = { kind: 'review', session: ++booksDialogSeq, opener: opener || null };
  showBooksDialog(booksReviewHtml());
}
function booksReviewHtml() {
  const list = bookReviewList();
  const excl = booksData.decisionRows.filter(d => d.kind === 'exclude' && /^hc:|^t:/.test(d.key));
  const byTitle = new Map(); excl.forEach(d => { const t = (d.value && d.value.title) || d.key; (byTitle.get(t) || byTitle.set(t, []).get(t)).push(d); });
  const item = (f, i) => {
    const t = bookFindingText(f), ev = (f.evidence || []).filter(x => x && x.url).map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.text || x.url)}</a>`).join(' · ');
    return `<li data-bfinding="${i}"${f.status === 'later' ? ' class="book-later"' : ''}><p><span class="state-tag">${esc(t.src)}</span> ${esc(t.text)}${ev ? ` <span class="muted">Source: ${ev}</span>` : ''}</p>${bookFindingActions(f, i)}</li>`;
  };
  return `<h2 class="modal-title" id="bookDialogTitle">Review books</h2>
    <p class="games-note">Nothing changes in your library until you choose. Titles from official sites, author discoveries and anything uncertain always wait here; only a followed series with automatic adding on adds matched Hardcover titles by itself.</p>
    <ul class="games-review">${list.map(item).join('') || '<li>Nothing to review.</li>'}</ul>
    ${byTitle.size ? `<details class="book-excluded"><summary>Removed and dismissed (${byTitle.size})</summary><p class="games-note">These stay out of refreshes. Allowing one back lets Refresh books offer it again.</p>
      <ul class="games-review">${[...byTitle.entries()].map(([t, ds]) => `<li>${esc(t)} <span class="muted">(${esc((ds[0].value && ds[0].value.reason) || 'excluded')})</span> <button class="btn" onclick="bookAllowAgain('${bkArg(t)}')">Allow again</button></li>`).join('')}</ul></details>` : ''}
    <div class="modal-actions"><button class="btn" onclick="closeBooksDialog()">Close</button></div>`;
}
const reviewItem = i => bookReviewList()[i] || null;
async function bookFindingResolve(i, outcome) { noteReviewPlace(i);
  const f = reviewItem(i);
  if (!f) return;
  await runWrite('Review', async lane => {
    try {
      await sbRpc('library_book_finding_resolve', { p_fingerprint: f.fingerprint, p_expected_status: f.status, p_outcome: outcome });
      if (outcome === 'done') booksData.findings = booksData.findings.filter(x => x !== f); else f.status = outcome;
      showSaved(); redrawBooksDialog(); renderBooksView();
      lane.after.push(() => reloadOpenView());
    } catch (err) { if (stateNeedsReread(err)) { await reportStateFailure(err); return; } showError(stateErrorText(err)); }
  }, { list: true });
}
async function bookReviewAdd(i) { noteReviewPlace(i);
  const f = reviewItem(i);
  if (!f) return;
  const s = f.subject;
  if (s.hardcover_id) {
    if (!bookRecAnywhere(s.hardcover_id)) {
      try { const r = await hardcoverQueries([{ name: 'b', q: 'books', vars: { ids: [s.hardcover_id] } }]); const rec = r.b && r.b.data && r.b.data[0] ? bookRecord(r.b.data[0]) : null; if (rec) booksData.cache.book.set(rec.id, rec); } catch (e) { /* the add reports it */ }
    }
    await addHardcoverBook(s.hardcover_id, s.series && s.series.position ? s.series : null, f.fingerprint);
    return;
  }
  // From an official site only: saved by hand, with the site's date as its chosen date (a Hardcover record can be matched later).
  const book = { title: String(s.title).slice(0, 300), authors: [{ ...(s.author_id ? { id: s.author_id } : {}), name: String(s.author || 'Unknown').slice(0, 200) }], series: s.series_hint ? [{ name: String(s.series_hint).slice(0, 200) }] : [],
    ...(s.date ? { chosen_date: { value: s.date, source: 'website', url: s.url || null, chosen_at: booksToday() } } : {}) };
  const keys = bookKeysOf({ title: book.title, authors: book.authors });
  await runWrite(`“${book.title}” · add`, async lane => {
    try {
      const made = await sbRpc('library_book_add', { p_book: book, p_status: 'want', p_clear_keys: keys, p_finding: f.fingerprint });
      booksData.entries.push(made); booksData.findings = booksData.findings.filter(x => x !== f);
      showSaved(); showNotice(`Added “${book.title}” as Want to read. It isn’t on Hardcover yet; Refresh books offers a match when it is.`);
      redrawBooksDialog(); renderBooksView();
      lane.after.push(() => reloadOpenView());
    } catch (err) { if (stateNeedsReread(err)) { await reportStateFailure(err); return; } showError(stateErrorText(err)); }
  }, { list: true });
}
function bookReviewDismiss(i) { noteReviewPlace(i);
  const f = reviewItem(i);
  if (!f) return;
  const s = f.subject, keys = s.hardcover_id ? bookKeysOf({ hardcoverId: s.hardcover_id, title: s.title, authors: s.authors || [] })
    : bookKeysOf({ title: s.title, authors: [{ id: s.author_id, name: s.author }] });
  // One decision carries the dismissal (its first key); the others follow in the same lane run.
  return (async () => {
    await setBookDecision('exclude', keys[0], { reason: 'dismissed', title: s.title }, `“${s.title}” · not interested`, f.fingerprint, 'done');
    for (const k of keys.slice(1)) if (!booksData.decisions.has(`exclude|${k}`)) await setBookDecision('exclude', k, { reason: 'dismissed', title: s.title }, `“${s.title}” · not interested`);
  })();
}
async function bookReviewUseDate(i) { noteReviewPlace(i);
  const f = reviewItem(i);
  if (!f) return;
  const s = f.subject;
  await editBookFields(s.entry_id, { chosen_date: { value: s.suggested, source: 'website', url: s.url || null, chosen_at: booksToday() } }, `“${s.title}” · date`, f.fingerprint);
  redrawBooksDialog();
}
function bookReviewKeepDate(i) { noteReviewPlace(i); const f = reviewItem(i); if (f) return setBookDecision('keep_date', f.fingerprint, { date: f.subject.suggested }, `“${f.subject.title}” · keep date`, f.fingerprint, 'done'); }
async function bookReviewCredit(i, yes) { noteReviewPlace(i);
  const f = reviewItem(i);
  if (!f) return;
  const s = f.subject;
  if (!yes) return setBookDecision('not_author', f.fingerprint, {}, `“${s.title}” · not ${s.author}’s`, f.fingerprint, 'done');
  await runWrite(`“${s.title}” · credit ${s.author}`, async lane => {
    try {
      const a = await sbRpc('library_book_association_set', { p_book_id: s.hardcover_id, p_author_id: s.author_id, p_author_name: String(s.author).slice(0, 200), p_on: true, p_finding: f.fingerprint });
      booksData.associations.push(a); booksData.findings = booksData.findings.filter(x => x !== f);
      showSaved(); showNotice(`“${s.title}” now shows under ${s.author}. Hardcover’s own credit is unchanged.`);
      redrawBooksDialog(); renderBooksView();
      lane.after.push(() => reloadOpenView());
    } catch (err) { if (stateNeedsReread(err)) { await reportStateFailure(err); return; } showError(stateErrorText(err)); }
  }, { list: true });
}
async function bookReviewMatch(i, yes) { noteReviewPlace(i);
  const f = reviewItem(i);
  if (!f) return;
  const s = f.subject;
  if (!yes) return setBookDecision('not_same', f.fingerprint, {}, `“${s.title}” · different books`, f.fingerprint, 'done');
  let rec = bookRecAnywhere(s.hardcover_id);
  if (!rec) { try { const r = await hardcoverQueries([{ name: 'b', q: 'books', vars: { ids: [s.hardcover_id] } }]); rec = r.b && r.b.data && r.b.data[0] ? bookRecord(r.b.data[0]) : null; } catch (e) { rec = null; } }
  if (!rec) { showError('Hardcover’s record couldn’t be read; try again later. Nothing was changed.'); return; }
  await linkBook(s.entry_id, rec, f.fingerprint);
}
function bookReviewNotSame(i) { noteReviewPlace(i); const f = reviewItem(i); if (f) return setBookDecision('not_same', f.fingerprint, {}, 'Different books', f.fingerprint, 'done'); }
function bookReviewRemoveCopy(i, entryId) {
  const f = reviewItem(i);
  const e = f && booksData.entries.find(x => x.id === entryId);
  if (!e) return;
  // Removing a copy keeps the book: only this entry's own key is excluded, never the title or Hardcover record the other copy has.
  closeBooksDialog(false);
  return deleteBook(entryId, { keys: [`e:${e.id}`], label: `“${e.title}” · remove copy` });
}
async function bookReviewSiteReset(i) { noteReviewPlace(i);
  const f = reviewItem(i);
  if (!f) return;
  await runWrite('Official site · offer its links', async lane => {
    try {
      await sbRpc('library_book_cache_put', { p_rows: [{ kind: 'site', key: String(f.subject.author_id), data: { v: 1, reset: true } }] });
      await sbRpc('library_book_finding_resolve', { p_fingerprint: f.fingerprint, p_expected_status: f.status, p_outcome: 'done' });
      booksData.cache.site.set(f.subject.author_id, { v: 1, reset: true }); booksData.findings = booksData.findings.filter(x => x !== f);
      showSaved(); showNotice(`The next Refresh books offers each unmatched link on ${f.subject.author}’s page for review.`);
      redrawBooksDialog();
      lane.after.push(() => reloadOpenView());
    } catch (err) { if (stateNeedsReread(err)) { await reportStateFailure(err); return; } showError(stateErrorText(err)); }
  }, { list: true });
}
async function bookAllowAgain(title) {
  const ds = booksData.decisionRows.filter(d => d.kind === 'exclude' && ((d.value && d.value.title) || d.key) === title);
  for (const d of ds) await setBookDecision('exclude', d.key, null, `“${title}” · allow again`);
  booksData.decisionRows = booksData.decisionRows.filter(d => !ds.includes(d));
  redrawBooksDialog();
}

// ── + Add book: search Hardcover (books, authors, series), browse, or enter a book by hand ──
function openBooksAdd(opener) {
  booksDialog = { kind: 'add', session: ++booksDialogSeq, opener: opener || null, query: '', type: 'Book', status: 'idle', results: [], recs: new Map(), browse: null, message: '', manual: null, matchFor: null };
  showBooksDialog(booksAddHtml());
  focusFilterTarget('bAddSearch');
}
function openBookMatch(entryId, opener) {
  const e = booksData.entries.find(x => x.id === entryId);
  if (!e) return;
  openBooksAdd(opener);
  booksDialog.matchFor = entryId; booksDialog.query = e.title; booksDialog.type = 'Book';
  redrawBooksDialog();
  searchBooksAdd();
}
function booksAddHtml() {
  const d = booksDialog;
  const match = d.matchFor && booksData.entries.find(x => x.id === d.matchFor);
  let body = '';
  if (d.manual) body = bookManualFormHtml(d.manual);
  else if (d.status === 'searching') body = '<p class="modal-progress">Searching Hardcover…</p>';
  else if (d.status === 'error') body = `<p class="modal-error" role="alert">${esc(d.message)}</p>`;
  else if (d.browse) body = bookBrowseHtml(d.browse);
  else if (d.status === 'ready') body = d.results.length ? `<ul class="games-results">${d.results.map((r, i) => bookResultHtml(r, i, match)).join('')}</ul>` : '<p>Nothing found on Hardcover.</p>';
  return `<h2 class="modal-title" id="bookDialogTitle">${match ? `Match “${esc(match.title)}” to Hardcover` : 'Add a book'}</h2>
    ${d.manual ? '' : `<div class="games-search-row"><label class="visually-hidden" for="bAddType">Search for</label>
      <select id="bAddType" onchange="booksDialog.type = this.value"${match ? ' disabled' : ''}>${['Book', 'Author', 'Series'].map(t => `<option value="${t}"${d.type === t ? ' selected' : ''}>${t === 'Book' ? 'Books' : t === 'Author' ? 'Authors' : 'Series'}</option>`).join('')}</select>
      <label class="visually-hidden" for="bAddSearch">Search Hardcover</label>
      <input id="bAddSearch" class="search-input" type="search" placeholder="Search Hardcover" value="${esc(d.query)}" oninput="booksDialog.query = this.value" onkeydown="if (event.key === 'Enter') { event.preventDefault(); searchBooksAdd(); }">
      <button class="btn" onclick="searchBooksAdd()">Search</button></div>`}
    ${body}
    ${!d.manual && !match ? '<p class="games-note">Can’t find it? <button class="btn-link" data-baction="manual" onclick="openBookManual()">Enter a book by hand</button></p>' : ''}
    <p class="games-note">Book data from Hardcover. Adding a book follows nothing; following an author or series adds nothing.</p>
    <div class="modal-actions"><button class="btn" onclick="closeBooksDialog()">Close</button></div>`;
}
function bookResultHtml(r, i, match) {
  if (r.kind === 'book') {
    const rec = booksDialog.recs.get(r.id), saved = rec && bookSavedFor(rec, bookSavedIndex(booksData.entries));
    const action = match ? `<button class="btn btn-accent" data-baction="link-${r.id}" onclick="pickBookMatch(${r.id})">Link to this record</button>`
      : saved ? `<span class="game-state">In your library (${esc(BOOK_STATUS_LABELS[saved.status])})</span>` : `<button class="btn btn-accent" data-baction="add-r${r.id}" onclick="addHardcoverBook(${r.id})">Add</button>`;
    return `<li><span class="spot-version-name">${esc(r.title)}</span> <span class="muted">${esc([r.authors, r.year, r.series].filter(Boolean).join(' · '))}</span> ${action}</li>`;
  }
  const follows = booksData.follows.some(f => f.kind === r.kind && f.hardcover_id === r.id);
  return `<li><span class="spot-version-name">${esc(r.title)}</span> <span class="muted">${esc(r.note || '')}</span>
    <button class="btn" data-baction="browse-${r.kind}${r.id}" onclick="browseBooks('${r.kind}', ${r.id})">Browse books</button>
    ${follows ? '<span class="game-state">Following</span>' : `<button class="btn" data-baction="follow-${r.kind}${r.id}" onclick="${r.kind === 'author' ? 'followBookAuthor' : 'followBookSeries'}(${r.id}, '${bkArg(r.title)}')">Follow</button>`}</li>`;
}
// Hardcover's search answer (Typesense hits) as rows; books are read again by id so the list shows full records.
function bookSearchRows(data, type) {
  const hits = data && data.results && Array.isArray(data.results.hits) ? data.results.hits : [];
  return hits.map(h => h.document || {}).filter(d => d.id != null).slice(0, 20).map(d => type === 'Book'
    ? { kind: 'book', id: Number(d.id), title: d.title || '', authors: (d.author_names || []).slice(0, 3).join(', '), year: d.release_year || '', series: (d.series_names || [])[0] || '' }
    : { kind: type === 'Author' ? 'author' : 'series', id: Number(d.id), title: d.name || d.title || '', note: type === 'Author' ? (d.books ? `${(d.books || []).slice(0, 2).join(', ')}` : '') : (d.author_name || (d.books || []).slice(0, 2).join(', ') || '') });
}
async function searchBooksAdd() {
  const d = booksDialog;
  if (!d || d.kind !== 'add') return;
  const text = String(d.query || '').trim().slice(0, 120);
  if (!text) return;
  const session = d.session, type = d.type;
  d.status = 'searching'; d.browse = null; redrawBooksDialog();
  try {
    const r = await hardcoverQueries([{ name: 's', q: 'search', vars: { text, type } }]);
    if (!booksDialog || booksDialog.session !== session) return;
    if (!r.s || r.s.error) throw new Error('Hardcover’s search didn’t answer. Try again later.');
    d.results = bookSearchRows(r.s.data, type);
    if (type === 'Book' && d.results.length) {
      const ids = d.results.map(x => x.id).filter(Number.isInteger);
      const got = await hardcoverQueries([{ name: 'b', q: 'books', vars: { ids } }]);
      (got.b && got.b.data || []).map(bookRecord).filter(Boolean).forEach(rec => d.recs.set(rec.id, rec));
      d.results = d.results.filter(x => !d.recs.has(x.id) || !bookHiddenReason(d.recs.get(x.id), { inSeries: true }) || d.matchFor)
        .map(x => { const rec = d.recs.get(x.id); return rec ? { ...x, title: rec.title, authors: rec.authors.map(a => a.name).join(', '), year: rec.year || '' } : x; });
    }
    d.status = 'ready';
  } catch (e) {
    if (!booksDialog || booksDialog.session !== session) return;
    d.status = 'error'; d.message = e.message;
  }
  redrawBooksDialog();
  focusFilterTarget('bAddSearch');
}
async function browseBooks(kind, id) {
  const d = booksDialog;
  if (!d) return;
  const session = d.session;
  d.status = 'searching'; d.showHidden = new Set(); d.bulkAsk = null; redrawBooksDialog(); // (a fresh browse: every hidden group starts closed)
  try {
    if (kind === 'author') {
      const got = await hardcoverAuthor(id);
      got.author.books.forEach(r => d.recs.set(r.id, r)); got.series.forEach(s => s.books.forEach(b => d.recs.set(b.rec.id, b.rec)));
      if (!booksDialog || booksDialog.session !== session) return;
      d.browse = { kind, author: got.author, series: got.series };
    } else {
      const s = await hardcoverSeries(id);
      s.books.forEach(b => d.recs.set(b.rec.id, b.rec));
      if (!booksDialog || booksDialog.session !== session) return;
      d.browse = { kind, series: [s] };
    }
    d.status = 'ready';
  } catch (e) { if (!booksDialog || booksDialog.session !== session) return; d.status = 'error'; d.message = e.message; }
  redrawBooksDialog();
}
function bookBrowseHtml(b) {
  // (the lists read the dialog's records through the cache's lookups)
  const back = '<button class="btn-link" onclick="booksDialog.browse = null; redrawBooksDialog()">← Back to results</button>';
  if (b.kind === 'series') {
    const s = b.series[0];
    return `<div class="games-preview"><h3>${esc(s.name)}${s.author ? ` <span class="muted">by ${esc(s.author.name)}</span>` : ''}</h3>${bookSeriesListHtml(s, { inDialog: true })}${back}</div>`;
  }
  return `<div class="games-preview"><h3>${esc(b.author.name)}</h3>${bookAuthorListHtml(b.author, new Map(b.series.map(s => [s.id, s])), true)}${back}</div>`;
}
function pickBookMatch(id) { const d = booksDialog; if (d && d.matchFor) linkBook(d.matchFor, d.recs.get(id)); }
function openBookManual() {
  booksDialog.manual = { title: '', author: '', series: '', position: '', date: '', error: '' };
  redrawBooksDialog();
  focusFilterTarget('bmTitle');
}
function bookManualFormHtml(m) {
  const f = (id, label, key, extra = '') => `<div class="filter-field"><label class="filter-field-label" for="${id}">${esc(label)}</label><input id="${id}" class="search-input" value="${esc(m[key])}" oninput="booksDialog.manual.${key} = this.value"${extra}></div>`;
  return `<div class="book-manual">${f('bmTitle', 'Title', 'title', ' maxlength="300"')}${f('bmAuthor', 'Author', 'author', ' maxlength="200"')}
    ${f('bmSeries', 'Series (optional)', 'series', ' maxlength="200"')}${f('bmPosition', 'Number in the series (optional: 3, or 1.5 for a companion)', 'position', ' maxlength="6"')}
    ${f('bmDate', 'Release date (optional: 2027, 2027-05 or 2027-05-11, or TBA)', 'date', ' maxlength="10"')}
    ${m.error ? `<p class="modal-error" role="alert">${esc(m.error)}</p>` : ''}
    <p class="games-note">A book entered by hand can be matched to Hardcover later; its status, date and series place are kept.</p>
    <button class="btn btn-accent" onclick="saveBookManual()">Add as Want to read</button> <button class="btn" onclick="booksDialog.manual = null; redrawBooksDialog()">Back</button></div>`;
}
async function saveBookManual() {
  const m = booksDialog && booksDialog.manual;
  if (!m) return;
  const title = m.title.trim(), author = m.author.trim(), series = m.series.trim(), position = m.position.trim(), date = m.date.trim();
  const problem = !title ? 'A title is needed.' : !author ? 'An author is needed.' : position && !/^\d{1,3}(\.\d{1,2})?$/.test(position) ? 'The number in the series must be like 3 or 1.5.'
    : position && !series ? 'A number needs its series.' : date && !/^(\d{4}(-\d{2}(-\d{2})?)?|TBA)$/i.test(date) ? 'The date must be like 2027, 2027-05, 2027-05-11 or TBA.' : '';
  if (problem) { m.error = problem; redrawBooksDialog(); return; }
  const book = { title, authors: [{ name: author }], series: series ? [{ name: series, ...(position ? { position } : {}) }] : [],
    ...(date ? { chosen_date: { value: date.toUpperCase() === 'TBA' ? 'TBA' : date, source: 'member', chosen_at: booksToday() } } : {}) };
  const keys = bookKeysOf({ title, authors: book.authors });
  await runWrite(`“${title}” · add`, async lane => {
    try {
      const made = await sbRpc('library_book_add', { p_book: book, p_status: 'want', p_clear_keys: keys, p_finding: null });
      booksData.entries.push(made);
      showSaved(); showNotice(`Added “${title}” as Want to read.`);
      closeBooksDialog(); renderBooksView();
      lane.after.push(() => reloadOpenView());
    } catch (err) { m.error = stateErrorText(err); redrawBooksDialog(); }
  }, { list: true });
}
// Choose a date (the member's choice: it stays until they change or clear it; nothing else replaces it).
function openBookDate(entryId, opener) {
  const e = booksData.entries.find(x => x.id === entryId);
  if (!e) return;
  booksDialog = { kind: 'date', session: ++booksDialogSeq, opener: opener || null, entryId, value: e.chosen_date ? e.chosen_date.value : '', error: '' };
  redrawBooksDialog(); focusFilterTarget('bDate');
}
function bookDateDialogHtml() {
  const d = booksDialog, e = booksData.entries.find(x => x.id === d.entryId), rec = e && e.hardcover_id ? bookRecOf(e.hardcover_id) : null;
  if (!e) return '<p>This book is no longer in your library.</p><div class="modal-actions"><button class="btn" onclick="closeBooksDialog()">Close</button></div>';
  const hc = rec ? bookShownDate(null, rec) : null;
  return `<h2 class="modal-title" id="bookDialogTitle">Date for “${esc(e.title)}”</h2>
    <p class="games-note">Hardcover: ${hc ? esc(bookDateText(hc)) + (hc.placeholder ? ' (1 January: may be a placeholder)' : '') : 'no date'}. A date you choose is kept until you change or clear it; official-site dates only ever come as suggestions in Review.</p>
    <label for="bDate">Your date (2027, 2027-05, 2027-05-11 or TBA)</label> <input id="bDate" class="search-input" maxlength="10" value="${esc(d.value)}" oninput="booksDialog.value = this.value">
    ${d.error ? `<p class="modal-error" role="alert">${esc(d.error)}</p>` : ''}
    <div class="modal-actions"><button class="btn" onclick="closeBooksDialog()">Cancel</button>${e.chosen_date ? ' <button class="btn" onclick="saveBookDate(true)">Clear my date</button>' : ''} <button class="btn btn-accent" onclick="saveBookDate(false)">Save</button></div>`;
}
async function saveBookDate(clear) {
  const d = booksDialog;
  if (!d || d.kind !== 'date') return;
  const v = String(d.value || '').trim();
  if (!clear && !/^(\d{4}(-\d{2}(-\d{2})?)?|TBA)$/i.test(v)) { d.error = 'The date must be like 2027, 2027-05, 2027-05-11 or TBA.'; redrawBooksDialog(); return; }
  const id = d.entryId;
  closeBooksDialog();
  await editBookFields(id, { chosen_date: clear ? null : { value: v.toUpperCase() === 'TBA' ? 'TBA' : v, source: 'member', chosen_at: booksToday() } }, clear ? 'Clear date' : 'Choose date');
}
function openBookEdit(entryId, opener) {
  const e = booksData.entries.find(x => x.id === entryId);
  if (!e) return;
  const s = (e.series || [])[0] || {};
  booksDialog = { kind: 'edit', session: ++booksDialogSeq, opener: opener || null, entryId, title: e.title, author: (e.authors || []).map(a => a.name).join(', '), series: s.name || '', position: s.position || '', error: '' };
  redrawBooksDialog(); focusFilterTarget('beTitle');
}
function bookEditDialogHtml() {
  const d = booksDialog, e = booksData.entries.find(x => x.id === d.entryId);
  if (!e) return '<p>This book is no longer in your library.</p><div class="modal-actions"><button class="btn" onclick="closeBooksDialog()">Close</button></div>';
  const f = (id, label, key) => `<div class="filter-field"><label class="filter-field-label" for="${id}">${esc(label)}</label><input id="${id}" class="search-input" value="${esc(d[key])}" oninput="booksDialog.${key} = this.value"></div>`;
  return `<h2 class="modal-title" id="bookDialogTitle">Edit “${esc(e.title)}”</h2>
    ${f('beTitle', 'Title', 'title')}${f('beAuthor', 'Author (for several: separated by commas)', 'author')}${f('beSeries', 'Series', 'series')}${f('bePosition', 'Number in the series (3, or 1.5 for a companion)', 'position')}
    <p class="games-note">Your corrections are kept with your library; Hardcover’s record isn’t changed.${e.hardcover_id ? ' A Hardcover author credit you remove here still shows on its author’s page.' : ''}</p>
    ${d.error ? `<p class="modal-error" role="alert">${esc(d.error)}</p>` : ''}
    <div class="modal-actions"><button class="btn" onclick="closeBooksDialog()">Cancel</button> <button class="btn btn-accent" onclick="saveBookEdit()">Save</button></div>`;
}
async function saveBookEdit() {
  const d = booksDialog;
  if (!d || d.kind !== 'edit') return;
  const e = booksData.entries.find(x => x.id === d.entryId);
  if (!e) return;
  const title = d.title.trim(), names = d.author.split(',').map(x => x.trim()).filter(Boolean), series = d.series.trim(), position = d.position.trim();
  const problem = !title ? 'A title is needed.' : !names.length ? 'An author is needed.' : position && !/^\d{1,3}(\.\d{1,2})?$/.test(position) ? 'The number must be like 3 or 1.5.' : position && !series ? 'A number needs its series.' : '';
  if (problem) { d.error = problem; redrawBooksDialog(); return; }
  const authors = names.map(n => { const was = (e.authors || []).find(a => a.name === n); return was && was.id ? { id: was.id, name: n } : { name: n }; });
  const old = (e.series || [])[0];
  const seriesList = series ? [{ ...(old && old.id && old.name === series ? { id: old.id } : {}), name: series, ...(position ? { position } : {}) }, ...(e.series || []).slice(1)] : (e.series || []).slice(1);
  const id = d.entryId;
  closeBooksDialog();
  await editBookFields(id, { title, authors, series: seriesList }, `“${title}” · edit`);
}

// ── The dialog ──
function redrawBooksDialog() {
  if (!booksDialog) return;
  const k = booksDialog.kind;
  // Focus kept across the redraw: the same control (by its hook), or for an Add just done that book's new status control.
  const boxNow = document.getElementById('bookDialogBox'), was = document.activeElement;
  const wanted = booksDialog.focusHook || null; booksDialog.focusHook = null; // (a step that names where focus goes next: Add all)
  const hook = wanted || (was && boxNow && typeof boxNow.contains === 'function' && boxNow.contains(was) && typeof was.getAttribute === 'function' ? was.getAttribute('data-baction') : null);
  showBooksDialog(k === 'review' ? booksReviewHtml() : k === 'date' ? bookDateDialogHtml() : k === 'edit' ? bookEditDialogHtml() : booksAddHtml());
  const box = document.getElementById('bookDialogBox');
  if (hook && box && typeof box.querySelector === 'function') {
    const q = JSON.stringify.bind(JSON);
    const el = box.querySelector(`[data-baction=${q(hook)}]`) || (/^bulk-/.test(hook) ? box.querySelector(`[data-baction=${q(`${hook.replace(/-(yes|no|none)$/, '')}-none`)}], [data-baction=${q(hook.replace(/-(yes|no|none)$/, ''))}]`) : null) || (/^add-/.test(hook) ? box.querySelector(`[data-baction=${q(`status-${hook.slice(4)}`)}]`) : null);
    if (el && typeof el.focus === 'function') { el.focus(); return; }
  }
  // Review: after an item is decided, focus goes to the item now in its place (else the one before, else Close).
  if (k === 'review' && booksDialog.place != null && box && document.activeElement === box && typeof box.querySelector === 'function') {
    const n = box.querySelectorAll('li[data-bfinding]').length, at = Math.min(booksDialog.place, n - 1);
    const el = at >= 0 ? box.querySelector(`li[data-bfinding="${at}"] button`) : box.querySelector('.modal-actions button');
    if (el && typeof el.focus === 'function') el.focus();
  }
}
function noteReviewPlace(i) { if (booksDialog && booksDialog.kind === 'review') booksDialog.place = i; }
function showBooksDialog(html) {
  const overlay = document.getElementById('bookDialogOverlay'), box = document.getElementById('bookDialogBox');
  if (!overlay || !box) return;
  if (overlay.style.display === 'none' && !booksDialogOpener) booksDialogOpener = (booksDialog && booksDialog.opener) || document.activeElement || null;
  const inBox = el => !!el && typeof box.contains === 'function' && box.contains(el);
  const was = document.activeElement, keep = was && was.id && inBox(was) && typeof was.selectionStart === 'number'
    ? { id: was.id, start: was.selectionStart, end: was.selectionEnd, dir: was.selectionDirection } : null;
  box.innerHTML = html;
  overlay.style.display = 'flex';
  if (document.activeElement && !inBox(document.activeElement) && typeof box.focus === 'function') box.focus();
  const again = keep && document.getElementById(keep.id);
  if (again && inBox(again) && typeof again.focus === 'function') { again.focus(); if (typeof again.setSelectionRange === 'function') again.setSelectionRange(keep.start, keep.end, keep.dir || 'none'); }
}
function closeBooksDialog(returnFocus = true) {
  const overlay = document.getElementById('bookDialogOverlay'), box = document.getElementById('bookDialogBox');
  const opener = booksDialogOpener;
  booksDialog = null; booksDialogOpener = null;
  if (overlay) overlay.style.display = 'none';
  if (box) box.innerHTML = '';
  const hook = opener && typeof opener.getAttribute === 'function' ? opener.getAttribute('data-baction') : null;
  if (returnFocus) returnDialogFocus(opener, () => (hook && document.querySelector(`#booksScreen [data-baction="${hook}"]`)) || document.getElementById('booksTitle') || document.getElementById('mainContent'));
}
function bookDialogKeydown(event) { dialogKeydown(event, document.getElementById('bookDialogBox'), 'button, input, select, a, summary, [tabindex="0"]', closeBooksDialog); }
function booksOnNavigate() {
  const overlay = document.getElementById('bookDialogOverlay');
  if (overlay && overlay.style.display !== 'none' && !writeLane) closeBooksDialog();
  booksReport = ''; bookSiteDraft.clear();
}
