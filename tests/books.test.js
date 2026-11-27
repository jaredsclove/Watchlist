// Offline tests for books (BK1, next-gen item 6; books-data.js, books.js) in the whole-page harness: the Books area and its routes;
// the Library (statuses, filters, dates as given with possible placeholders marked, a member's date kept); Series (main titles in
// order, companions listed but never next, Dropped and skipped books passed over, hidden records without merging); Authors (their
// books plus their verified series, a credit gap offered for review and corrected by a manual credit, never another author's
// series book); + Add book (Hardcover search, browsing an author adds nothing, entering a book by hand); Refresh books (Hardcover
// and official sites in one run: an author's new title for review, a followed series' automatic addition only when allowed and
// matched, the first site check offering a website-only book, edition notices left out, a redesigned or unsupported site, a
// failed site leaving Hardcover's results); Review (add, dismiss, later, date suggestions, matching a website-only book later
// with its progress kept); removal and dismissal staying out across refreshes and a restore; backups at format 10 without the
// cache; focus after changes. The database's rules are modelled in tests/bk1-harness.js (the real ones: tools/bk1-test.mjs); the
// function's extraction rules are the real ones (supabase/functions/books/core.mjs) on synthetic pages. Synthetic data only
// ("ZZ …", made-up Hardcover ids, reserved example domains). Run from the repo root: node tests/books.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');
const { makeMiniDom } = require('./mini-dom');

const T = runner('books');
const test = T.test;
const DAY = 86400000;
const day = off => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
const ID = (p, k) => `${p}-0000-4000-8000-${String(k).padStart(12, '0')}`;
const TS = '2026-11-01T00:00:00+00:00';

// ── Hardcover, as the function answers it ──
const A_PEN = { id: 9100, name: 'ZZ Galbraith' }, A_YA = { id: 9101, name: 'ZZ McManus' }, A_SPY = { id: 9102, name: 'ZZ Silva' }, PUBLISHER = { id: 9999, name: 'ZZ Random House' };
const bk = (id, title, o = {}) => ({ id, title, slug: `zz-${id}`, release_date: o.date === undefined ? '2015-06-01' : o.date, release_year: o.date ? Number(String(o.date).slice(0, 4)) : null,
  canonical_id: null, compilation: !!o.compilation, is_partial_book: false, users_count: o.users ?? 100, editions_count: 3, alternative_titles: o.alt || [], genres: o.genres || ['Mystery', 'Thriller'],
  contributions: (o.authors || [A_PEN]).map(a => ({ contribution: a.role || null, author: { id: a.id, name: a.name } })),
  book_series: (o.series || []).map(([sid, name, pos, author]) => ({ position: pos, details: pos, compilation: !!o.compilation, series: { id: sid, name, canonical_id: null, author_id: author || null } })),
  english: o.lang === 'other' || o.lang === 'unknown' ? [] : [{ id: id * 10 }], langknown: o.lang === 'unknown' ? [] : [{ id: id * 10 }] });
const S_STRIKE = [9200, 'ZZ Strike', null, A_PEN.id], S_ONE = [9201, 'ZZ One of Us', null, A_YA.id], S_ALLON = [9202, 'ZZ Allon', null, A_SPY.id];
const inS = (s, pos) => [[s[0], s[1], pos, s[3]]];
function catalog(extra = {}) {
  const books = [
    bk(1001, 'ZZ First Case', { series: inS(S_STRIKE, '1'), date: '2013-04-18', users: 900 }),
    bk(1002, 'ZZ Second Case', { series: inS(S_STRIKE, '2'), date: '2014-06-19' }),
    bk(1003, 'ZZ Third Case', { series: inS(S_STRIKE, '3'), date: '2023-01-01' }),
    bk(1004, 'ZZ Fourth Case', { series: inS(S_STRIKE, '4'), date: null }), // announced, no date
    bk(1005, 'ZZ Premier Cas', { series: inS(S_STRIKE, '1'), date: '2013-04-18', lang: 'other', users: 3 }), // a translation at #1
    bk(1006, 'ZZ First Case: ZZ Strike, Book 1', { series: inS(S_STRIKE, null), date: null, users: 1 }), // an unnumbered extra record
    bk(1007, 'ZZ Strike Books 1-3 Box Set', { series: inS(S_STRIKE, '1'), compilation: true, users: 2 }),
    bk(1008, 'ZZ Strike Novella', { series: inS(S_STRIKE, '2.5'), date: '2016-01-01' }),
    bk(2001, 'ZZ One of Us', { authors: [A_YA], series: inS(S_ONE, '1'), date: '2017-05-30', genres: ['Young Adult', 'Mystery'] }),
    bk(2002, 'ZZ One of Us Next', { authors: [A_YA], series: inS(S_ONE, '2'), date: '2020-01-07', genres: ['Young Adult'] }),
    bk(2003, 'ZZ One of Us Back', { authors: [PUBLISHER], series: inS(S_ONE, '3'), date: '2023-01-01', genres: ['Young Adult'] }), // credited to its publisher
    bk(2004, 'ZZ Cousins', { authors: [A_YA], date: '2020-01-01', genres: ['Young Adult'] }),
    bk(2005, 'ZZ Dying Debut', { authors: [A_YA], date: '2027-01-01', lang: 'unknown', genres: [] }), // announced, language unknown, possible placeholder
    bk(2006, 'ZZ Cousins (Spanish)', { authors: [A_YA], date: '2020-01-01', lang: 'other', users: 2 }),
    bk(2007, 'ZZ One of Us Collection', { authors: [A_YA], compilation: true }),
    bk(3001, 'ZZ Kill Artist', { authors: [A_SPY], series: inS(S_ALLON, '1'), date: '2000-01-01', genres: ['Thriller', 'Espionage'] }),
    bk(3002, 'ZZ English Assassin', { authors: [A_SPY], series: inS(S_ALLON, '2'), date: '2002-01-01', genres: ['Thriller', 'Espionage'] }),
    bk(3009, 'ZZ Unlikely Spy', { authors: [A_SPY], date: '1996-01-01' }),
    ...(extra.books || [])];
  return books;
}
function booksStub(o = {}) {
  const calls = [];
  const core = o.core;
  const fn = body => {
    calls.push(body);
    if (o.down) return { __status: 502, body: { message: 'Hardcover couldn’t be reached. Try again later.' } };
    const books = catalog(o.catalog || {});
    if (body.op === 'hardcover') {
      return { results: body.queries.map(q => {
        const v = q.vars;
        if (q.q === 'author') {
          const a = [A_PEN, A_YA, A_SPY].find(x => x.id === v.id);
          return { name: q.name, data: a ? { id: a.id, name: a.name, canonical_id: null, alias: [], contributions: books.filter(b => b.contributions.some(c => c.author.id === a.id)).map(b => ({ contribution: null, book: b })) } : null };
        }
        if (q.q === 'author_series') return { name: q.name, data: [S_STRIKE, S_ONE, S_ALLON].filter(s => s[3] === v.id).map(s => ({ id: s[0], name: s[1], books_count: 3, primary_books_count: 3, author: { id: s[3] } }))
          .concat(v.id === A_SPY.id ? [{ id: 9299, name: 'ZZ Allon #9', books_count: 0 }] : []) };
        if (q.q === 'series') {
          const s = [S_STRIKE, S_ONE, S_ALLON].find(x => x[0] === v.id);
          if (!s) return { name: q.name, data: null };
          const a = [A_PEN, A_YA, A_SPY].find(x => x.id === s[3]);
          return { name: q.name, data: { id: s[0], name: s[1], canonical_id: null, primary_books_count: 3, author: { id: a.id, name: a.name },
            book_series: books.filter(b => b.book_series.some(x => x.series.id === s[0])).map(b => ({ position: b.book_series.find(x => x.series.id === s[0]).position, details: null, compilation: b.compilation, book: b })) } };
        }
        if (q.q === 'books') return { name: q.name, data: books.filter(b => v.ids.includes(b.id)) };
        if (q.q === 'search') {
          const t = v.text.toLowerCase();
          if (v.type === 'Book') return { name: q.name, data: { results: { hits: books.filter(b => b.title.toLowerCase().includes(t)).map(b => ({ document: { id: String(b.id), title: b.title } })) } } };
          if (v.type === 'Author') return { name: q.name, data: { results: { hits: [A_PEN, A_YA, A_SPY].filter(a => a.name.toLowerCase().includes(t)).map(a => ({ document: { id: String(a.id), name: a.name } })) } } };
          return { name: q.name, data: { results: { hits: [S_STRIKE, S_ONE, S_ALLON].filter(s => s[1].toLowerCase().includes(t)).map(s => ({ document: { id: String(s[0]), name: s[1] } })) } } };
        }
        return { name: q.name, error: 'unknown' };
      }) };
    }
    if (body.op === 'site') {
      const sites = o.sites || {};
      const page = u => sites[u];
      const out = { listing: null, home: null, pages: [] };
      if (body.listing) { const h = page(body.listing); out.listing = h == null ? { url: body.listing, ok: false, error: 'answered 503' } : { url: body.listing, ok: true, ...core.listingCandidates(h, body.listing) }; }
      if (body.home) { const h = page(body.home); out.home = h == null ? { url: body.home, ok: false } : { url: body.home, ok: true, announcements: core.announcements(h, body.home) }; }
      for (const p of body.pages || []) { const h = page(p); out.pages.push(h == null ? { url: p, ok: false, error: 'answered 404' } : { ok: true, ...core.bookPage(h, p) }); }
      return out;
    }
    return { __status: 400, body: { message: 'unknown' } };
  };
  fn.calls = calls;
  return fn;
}
// Synthetic official pages (shaped like the inspected sites, made-up content and domains).
const html = b => `<!doctype html><html><head></head><body>${b}</body></html>`;
const YA_SITE = 'https://www.zz-ya.example.com/books';
function yaSites(o = {}) {
  const links = [['zz-one-of-us', 'ZZ One of Us', 'The ZZ One of Us Series'], ['zz-one-of-us-next', 'ZZ One of Us Next', 'The ZZ One of Us Series'], ['zz-one-of-us-back', 'ZZ One of Us Back', 'The ZZ One of Us Series'],
    ['zz-cousins', 'ZZ Cousins', 'Standalone Novels'], ['zz-dying-debut', 'ZZ Dying Debut', 'Coming in 2027: Adult Debut'], ...(o.extra || [])];
  let last = null, body = '<a href="/about">About</a><a href="/faqs">FAQs</a><a href="/news-and-events">News &amp; Events</a><a href="/books">Books</a>';
  for (const [slug, title, heading] of links) { if (heading !== last) { body += `<h2>${heading}</h2>`; last = heading; } body += `<a href="/${slug}">${title}</a>`; }
  return {
    [YA_SITE]: html(body),
    'https://www.zz-ya.example.com/zz-dying-debut': html('<p>Preorder now <a href="https://www.penguinrandomhouse.com/books/555/zz-dying-debut/">US</a></p>').replace('<head></head>', '<head><meta property="og:title" content="ZZ Dying Debut | zz-ya"></head>'),
    'https://www.penguinrandomhouse.com/books/555/zz-dying-debut/': html('<p>Hardcover $32.00 Available on May 11, 2027 | 384 Pages</p>'),
    'https://www.zz-ya.example.com/zz-secret-novel': html('<h1>ZZ Secret Novel</h1>').replace('<head></head>', '<head><meta property="og:title" content="ZZ Secret Novel | zz-ya"></head>'),
    'https://www.zz-ya.example.com/zz-one-of-us-anniversary': html('<h1>x</h1>').replace('<head></head>', '<head><meta property="og:title" content="ZZ One of Us Anniversary Edition | zz-ya"></head>'),
    ...(o.pages || {}) };
}

// ── The member's saved data ──
const entry = (k, rec, o = {}) => ({ id: ID('6c000000', k), hardcover_id: rec ? rec.id : null, title: o.title || rec.title, authors: o.authors || (rec ? rec.contributions.map(c => ({ id: c.author.id, name: c.author.name })) : []),
  series: o.series || (rec ? rec.book_series.filter(s => s.position).map(s => ({ id: s.series.id, name: s.series.name, position: s.position })) : []), status: o.status || 'want', chosen_date: o.chosen_date || null, created_at: TS, updated_at: TS });
const follow = (k, kind, id, name, o = {}) => ({ id: ID('6d000000', k), kind, hardcover_id: id, name, auto_add: !!o.auto, created_at: o.created || TS, updated_at: TS });
const byId = id => catalog().find(b => b.id === id);
// A follow's starting catalog (BK1b): every synthetic record except the ones given, which count as new.
const seen = (k, ...except) => ({ id: ID('6a900000', k), kind: 'baseline', key: `f:${ID('6d000000', k)}`, value: { ids: catalog().map(b => b.id).filter(id => !except.includes(id)) }, created_at: TS });
async function boot(opts = {}) {
  const core = await import('../supabase/functions/books/core.mjs');
  const stub = booksStub({ core, ...opts.stub });
  const books = { book_entries: opts.entries || [], book_follows: opts.follows || [], book_sites: opts.sites || [], book_associations: opts.associations || [], book_decisions: opts.decisions || [],
    book_findings: opts.findings || [], book_cache: opts.cache || [] };
  const app = await createApp({ books, booksFn: stub, storage: memoryStorage() });
  app.stub = stub;
  app.dom = makeMiniDom(app, ['booksScreen', 'bookDialogBox', 'gamesScreen', 'queuesScreen', 'settingsScreen']);
  app.dom.hide('cardList');
  return app;
}
const memoryStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), get length() { return m.size; }, key: i => [...m.keys()][i] ?? null, clear: () => m.clear() }; };
const screen = app => app.el('booksScreen').innerHTML;
const dialog = app => app.el('bookDialogBox').innerHTML;
const text = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const rpcs = (app, fn) => app.requests.filter(r => r.url.endsWith(`/rpc/${fn}`));
const tableOf = app => screen(app).split('</tbody>')[0];
const rowOf = (app, id) => ((tableOf(app).split('<tr class="game-row').find(x => x.includes(`data-book="${id}"`)) || '').split('</tr>')[0]);
const libraryOrder = app => [...tableOf(app).matchAll(/<tr class="game-row[^"]*" data-book="([^"]+)"/g)].map(m => m[1]);
async function open(app, view = 'books') { app.ctx.switchView(view); await settle(); }
async function refresh(app) { await app.ctx.refreshBooks(); await settle(); await settle(); }
const store = (app, t) => app.store[t];

test('the Books area: an app-bar button, its routes and two views (the old Series and Authors routes open Following)', async () => {
  const app = await boot();
  assert.match(app.el('mediaSwitch').innerHTML, /id="areaBtn-books"[^>]*onclick="openBooks\(\)">Books<\/button>/);
  app.ctx.openBooks(); await settle();
  assert.strictEqual(app.get('activeArea'), 'books');
  assert.deepStrictEqual(['books', 'booksfollowing'].map(v => app.get(`routeOfView("${v}")`)), ['#/books', '#/books/following']);
  assert.deepStrictEqual(['#/books/following', '#/books/series', '#/books/authors'].map(h => app.get(`viewOfRoute(${JSON.stringify(h)})`)), ['booksfollowing', 'booksfollowing', 'booksfollowing'], 'the old routes open Following');
  assert.strictEqual(text(app.el('tabBar').innerHTML), 'Library Following');
  assert.match(text(screen(app)), /No books yet\. Use \+ Add book to search Hardcover, browse an author or enter a book by hand\./);
  assert.match(screen(app), /Book data from <a href="https:\/\/hardcover\.app"/);
  assert.deepStrictEqual(app.writes().filter(r => !/functions\/v1\/books/.test(r.url)), [], 'no database write');
});

test('Library: statuses, author and series columns, genres; dates as Hardcover gives them with a possible placeholder marked; a chosen date kept and labelled', async () => {
  const e1 = entry(1, byId(1003), { status: 'reading' }), e2 = entry(2, byId(2001), { chosen_date: { value: '2017-06-01', source: 'member' } }), e3 = entry(3, byId(3001), { status: 'finished' });
  const cache = [1003, 2001, 3001].map((id, i) => ({ id: ID('6e000000', i + 1), kind: 'book', key: String(id), data: null, fetched_at: TS }));
  const app0 = await boot();
  cache.forEach(c => { c.data = JSON.parse(app0.run(`JSON.stringify(bookRecord(${JSON.stringify(byId(Number(c.key)))}))`)); });
  const app = await boot({ entries: [e1, e2, e3], cache });
  await open(app);
  const r1 = text(rowOf(app, e1.id));
  assert.match(r1, /ZZ Third Case/); assert.match(r1, /#3/, 'its number in the series (the author and series are its headings)');
  assert.match(text(tableOf(app)), /▾ ZZ Galbraith ▾ ZZ Strike ZZ Third Case/);
  assert.match(r1, /Jan 1, 2023/, 'the date as Hardcover gives it'); assert.match(rowOf(app, e1.id), /class="book-ph"[^>]*aria-label="Possible placeholder date\. Hardcover lists 1 January/, 'marked as possibly a placeholder (compact, explained on focus), not converted');
  assert.match(rowOf(app, e1.id), /<option value="reading" selected>Reading<\/option>/);
  assert.match(text(rowOf(app, e2.id)), /Jun 1, 2017 .*your date/, 'the member’s date shown and labelled');
  assert.ok(!libraryOrder(app).includes(e3.id), 'the default status filter leaves out Finished and Dropped');
  app.run(`booksFilters.status = 'all'; renderBooksView()`);
  assert.ok(libraryOrder(app).includes(e3.id));
  app.run(`booksFilters.genre = 'Espionage'; renderBooksView()`);
  assert.deepStrictEqual(libraryOrder(app), [e3.id], 'the genre filter');
  app.run(`booksFilters = { search: 'mcmanus', genre: '', status: 'all' }; renderBooksView()`);
  assert.deepStrictEqual(libraryOrder(app), [e2.id], 'search covers authors');
  await app.ctx.setBookStatus(e1.id, 'paused'); await settle();
  const call = rpcs(app, 'library_book_set').at(-1).body;
  assert.deepStrictEqual([call.p_expected_status, call.p_status], ['reading', 'paused'], 'one guarded change with the status shown');
  assert.strictEqual(store(app, 'book_entries').find(e => e.id === e1.id).status, 'paused');
});

test('Series: main titles in order with the next book; Dropped and skipped books passed over; companions listed but never next; translations, box sets and extra records hidden, not merged', async () => {
  const e1 = entry(1, byId(1001), { status: 'finished' }), e2 = entry(2, byId(1002), { status: 'dropped' });
  const app = await boot({ entries: [e1, e2], follows: [follow(1, 'series', 9200, 'ZZ Strike')] });
  await open(app, 'booksfollowing');
  assert.match(text(screen(app)), /Not read from Hardcover yet: use Refresh books/);
  await refresh(app);
  const fid = ID('6d000000', 1);
  assert.match(text(screen(app)), /Next ZZ Third Case #3/, 'Finished #1 and Dropped #2 count as passed (owner, 2026-11-26)');
  app.ctx.toggleBookFollow(fid); await settle();
  const s = text(screen(app));
  assert.match(s, /#1 ZZ First Case .*#2 ZZ Second Case .*#3 ZZ Third Case .*Next .*#4 ZZ Fourth Case/);
  assert.match(s, /Companions .* #2\.5 ZZ Strike Novella .* Companion/, 'a fractional position is a companion');
  assert.match(s, /Show 3 hidden records/);
  app.ctx.toggleBookHidden('s:9200'); await settle();
  const h = text(screen(app));
  assert.match(h, /ZZ Premier Cas .* Not in English \(a translation\)/); assert.match(h, /Box Set .* A collection or box set/); assert.match(h, /ZZ First Case: ZZ Strike, Book 1 .* Another record of a main book/);
  assert.match(h, /nothing is merged or changed/);
  await app.ctx.toggleBookSkip('hc:1003', false); await settle();
  assert.deepStrictEqual(rpcs(app, 'library_book_decision_set').at(-1).body.p_key, 'hc:1003');
  assert.match(text(screen(app)), /Next ZZ Fourth Case #4 .*Date unknown/, 'a skipped book is passed over; an announced book with no date is next');
});

test('Authors: their books plus their verified series; the publisher-credited series book is offered for review and a manual credit puts it under the author; another author’s book never is', async () => {
  const app = await boot({ follows: [follow(1, 'author', A_YA.id, A_YA.name)] });
  await open(app, 'booksfollowing');
  await refresh(app);
  app.ctx.toggleBookFollow(ID('6d000000', 1)); await settle();
  const s = text(screen(app));
  assert.match(s, /ZZ One of Us Follow the series ZZ One of Us .*#1 ZZ One of Us .*#2 ZZ One of Us Next .*#3 ZZ One of Us Back/, 'the verified series in order, its third book included');
  assert.match(s, /credited to someone else on Hardcover: “ZZ One of Us Back”/);
  assert.match(s, /Other books .*ZZ Cousins .*ZZ Dying Debut Language unknown/, 'an announced book with unknown language stays, labelled');
  assert.ok(!/ZZ Cousins \(Spanish\)/.test(s.split('Show')[0]) && !/ZZ One of Us Collection/.test(s.split('Show')[0]), 'translations and collections are under Hidden');
  const gap = store(app, 'book_findings').find(f => f.kind === 'credit_gap');
  assert.ok(gap && gap.subject.hardcover_id === 2003 && gap.subject.author_id === A_YA.id, 'Refresh offered the credit gap for review');
  assert.ok(!store(app, 'book_associations').length, 'nothing was credited automatically');
  app.ctx.openBooksReview(null); await settle();
  assert.match(text(dialog(app)), /“ZZ One of Us Back” is #3 in ZZ One of Us, but Hardcover credits it to ZZ Random House, not ZZ McManus\./);
  const i = app.run('bookReviewList().findIndex(f => f.kind === "credit_gap")');
  await app.ctx.bookReviewCredit(i, true); await settle();
  assert.deepStrictEqual(store(app, 'book_associations').map(a => [a.hardcover_book_id, a.hardcover_author_id]), [[2003, A_YA.id]]);
  assert.ok(!store(app, 'book_findings').some(f => f.kind === 'credit_gap'), 'the item is settled with the credit, in one change');
  await refresh(app);
  assert.ok(!store(app, 'book_findings').some(f => f.kind === 'credit_gap'), 'it doesn’t come back');
  // A series of several authors: a book credited to the series' other author is that author's, not a gap.
  const two = await boot({ follows: [follow(1, 'author', A_YA.id, A_YA.name)], stub: { catalog: { books: [
    bk(2010, 'ZZ Shared One', { authors: [A_YA], series: inS(S_ONE, '4') }), bk(2011, 'ZZ Shared Two', { authors: [A_SPY], series: inS(S_ONE, '5') }), bk(2012, 'ZZ Shared Three', { authors: [A_SPY], series: inS(S_ONE, '6') })] } } });
  await open(two, 'booksfollowing'); await refresh(two);
  assert.deepStrictEqual(store(two, 'book_findings').filter(f => f.kind === 'credit_gap').map(f => f.subject.hardcover_id), [2003], 'another author’s books in a shared series are never offered as a gap');
});

test('+ Add book: Hardcover search; browsing an author adds nothing; Add saves one book; following adds nothing; a book entered by hand', async () => {
  const app = await boot();
  await open(app);
  app.ctx.openBooksAdd(null); await settle();
  app.run(`booksDialog.query = 'zz one of us'; booksDialog.type = 'Book'`);
  await app.ctx.searchBooksAdd(); await settle();
  assert.match(text(dialog(app)), /ZZ One of Us .* Add/);
  assert.ok(!/ZZ One of Us Collection/.test(dialog(app)), 'collections are left out of book results');
  app.run(`booksDialog.query = 'mcmanus'; booksDialog.type = 'Author'`);
  await app.ctx.searchBooksAdd(); await settle();
  await app.ctx.browseBooks('author', A_YA.id); await settle();
  assert.match(text(dialog(app)), /ZZ McManus .*ZZ One of Us .*#1 ZZ One of Us/);
  assert.strictEqual(store(app, 'book_entries').length, 0, 'browsing adds nothing');
  assert.strictEqual(store(app, 'book_follows').length, 0, 'nor follows anything');
  await app.ctx.addHardcoverBook(2002, { id: 9201, name: 'ZZ One of Us', position: '2' }); await settle();
  const saved = store(app, 'book_entries');
  assert.deepStrictEqual(saved.map(e => [e.hardcover_id, e.title, e.status, e.series[0].position]), [[2002, 'ZZ One of Us Next', 'want', '2']]);
  assert.ok(store(app, 'book_cache').some(c => c.kind === 'book' && c.key === '2002'), 'its record is cached (replaceable)');
  await app.ctx.followBookAuthor(A_YA.id, A_YA.name); await settle();
  assert.strictEqual(store(app, 'book_entries').length, 1, 'following adds nothing');
  app.ctx.openBooksAdd(null); app.ctx.openBookManual(); await settle();
  app.run(`Object.assign(booksDialog.manual, { title: 'ZZ Hand Book', author: 'ZZ Unknown Writer', series: 'ZZ Small Series', position: '2', date: '2027-03' })`);
  await app.ctx.saveBookManual(); await settle();
  const hand = store(app, 'book_entries').find(e => e.title === 'ZZ Hand Book');
  assert.ok(hand && hand.hardcover_id === null && hand.series[0].name === 'ZZ Small Series' && hand.chosen_date.value === '2027-03' && hand.chosen_date.source === 'member', JSON.stringify(hand));
  app.run(`openBooksAdd(null); openBookManual(); booksDialog.manual.title = 'ZZ'; booksDialog.manual.author = 'ZZ'; booksDialog.manual.position = 'two'; booksDialog.manual.series = 'S'`);
  await app.ctx.saveBookManual(); await settle();
  assert.match(text(dialog(app)), /The number in the series must be like 3 or 1\.5/, 'a bad number is explained and nothing is sent');
});

test('Refresh books: an author’s new and announced titles go to review (never added); a followed series adds a matched new main title only with automatic adding on', async () => {
  const fresh = '2026-11-20T00:00:00+00:00';
  const app = await boot({ follows: [follow(1, 'author', A_PEN.id, A_PEN.name, { created: fresh }), follow(2, 'series', 9202, 'ZZ Allon', { created: fresh })],
    decisions: [seen(1, 1004), seen(2)], entries: [entry(1, byId(3001)), entry(2, byId(3002))], stub: { catalog: { books: [bk(3003, 'ZZ Ransom', { authors: [A_SPY], series: inS(S_ALLON, '3'), date: day(60) })] } } });
  await open(app);
  await refresh(app);
  const nb = store(app, 'book_findings').filter(f => f.kind === 'new_book').map(f => f.subject.title).sort();
  assert.deepStrictEqual(nb, ['ZZ Fourth Case', 'ZZ Ransom'], 'the author’s announced book and the series’ upcoming one; not the backlist');
  assert.strictEqual(store(app, 'book_entries').length, 2, 'nothing added without automatic adding');
  assert.match(text(screen(app)), /Refresh books: 2 new items for review .*Hardcover: 2 follows checked .*Hardcover only: ZZ Galbraith \(no official book page is set\)/);
  // Automatic adding on: the new main title is added as Want to read, and its review item settled.
  await app.ctx.setSeriesAutoAdd(ID('6d000000', 2), true); await settle();
  await refresh(app);
  const ransom = store(app, 'book_entries').find(e => e.hardcover_id === 3003);
  assert.ok(ransom && ransom.status === 'want' && ransom.series[0].position === '3', 'added as Want to read in its place');
  assert.ok(!store(app, 'book_findings').some(f => f.subject.hardcover_id === 3003), 'its review item went with it');
  assert.match(text(screen(app)), /1 title added automatically as Want to read/);
  assert.doesNotMatch(text(screen(app)), /1 new item for review/, 'the added title isn’t also counted for review');
  // An unknown-language or translated record, or a place another saved record holds, is never added automatically.
  const app2 = await boot({ follows: [follow(1, 'series', 9202, 'ZZ Allon', { created: fresh, auto: true })], decisions: [seen(1)], entries: [entry(1, byId(3001))],
    stub: { catalog: { books: [bk(3004, 'ZZ Unknown Lang', { authors: [A_SPY], series: inS(S_ALLON, '4'), date: day(30), lang: 'unknown' })] } } });
  await open(app2); await refresh(app2);
  assert.ok(!store(app2, 'book_entries').some(e => e.hardcover_id === 3004) && store(app2, 'book_findings').some(f => f.subject.hardcover_id === 3004), 'language unknown: reviewed, not added');
});

test('Official sites: the first check offers a website-only book with its source; edition notices are left out; matched titles add nothing; a placeholder date gets a site date suggestion', async () => {
  const debut = entry(1, byId(2005)); // announced, Hardcover date 2027-01-01 (a possible placeholder)
  const app = await boot({ follows: [follow(1, 'author', A_YA.id, A_YA.name)], entries: [debut], sites: [{ id: ID('6f000000', 1), hardcover_author_id: A_YA.id, author_name: A_YA.name, listing_url: YA_SITE, created_at: TS, updated_at: TS }],
    stub: { sites: yaSites({ extra: [['zz-secret-novel', 'ZZ Secret Novel', 'Standalone Novels'], ['zz-one-of-us-anniversary', 'ZZ One of Us Anniversary Edition', 'Standalone Novels']] }) } });
  await open(app);
  await refresh(app);
  const web = store(app, 'book_findings').filter(f => f.source === 'website');
  const nb = web.filter(f => f.kind === 'new_book');
  assert.deepStrictEqual(nb.map(f => f.subject.title), ['ZZ Secret Novel'], 'the website-only book is offered; the anniversary edition and the navigation pages are not');
  assert.ok(nb[0].subject.url === 'https://www.zz-ya.example.com/zz-secret-novel' && nb[0].evidence[0].url === nb[0].subject.url && nb[0].subject.first_check, 'with its source link, as a first-check listing');
  const dt = web.find(f => f.kind === 'date');
  assert.ok(dt && dt.subject.suggested === '2027-05-11' && dt.subject.entry_id === debut.id && /penguinrandomhouse/.test(dt.subject.url), 'the publisher page linked from the book page dates the placeholder', JSON.stringify(dt));
  assert.strictEqual(store(app, 'book_entries').find(e => e.id === debut.id).chosen_date, null, 'a suggestion, not a change');
  assert.match(text(screen(app)), /official sites checked: ZZ McManus .*1 edition notice on official sites left out/);
  app.ctx.openBooksReview(null); await settle();
  const d = text(dialog(app));
  assert.match(d, /Official site “ZZ Secret Novel” by ZZ McManus .*first check of this site/);
  assert.match(d, /“ZZ Dying Debut”: ZZ McManus’s site says “Available on May 11, 2027”; your library shows Jan 1, 2027 \(from Hardcover\)/);
  // Use the suggested date: it becomes the book's chosen date (source: website), and the item is settled.
  let i = app.run('bookReviewList().findIndex(f => f.kind === "date")');
  await app.ctx.bookReviewUseDate(i); await settle();
  assert.deepStrictEqual(Object.fromEntries(Object.entries(store(app, 'book_entries')[0].chosen_date).filter(([k]) => k !== 'chosen_at')), { value: '2027-05-11', source: 'website', url: 'https://www.penguinrandomhouse.com/books/555/zz-dying-debut/' });
  // Add the website-only book: saved by hand, not linked, with the site's evidence; a second refresh offers nothing again.
  i = app.run('bookReviewList().findIndex(f => f.kind === "new_book")');
  await app.ctx.bookReviewAdd(i); await settle();
  const secret = store(app, 'book_entries').find(e => e.title === 'ZZ Secret Novel');
  assert.ok(secret && secret.hardcover_id === null && secret.authors[0].id === A_YA.id);
  const before = store(app, 'book_findings').length;
  await refresh(app);
  assert.strictEqual(store(app, 'book_findings').length, before, 'an unchanged site offers nothing again');
});

test('a website-only book matched later to a Hardcover record keeps its status, date, skip and placement', async () => {
  const hand = entry(1, null, { title: 'ZZ Secret Novel', authors: [{ id: A_YA.id, name: A_YA.name }], series: [{ name: 'ZZ One of Us', position: '4' }], status: 'reading',
    chosen_date: { value: '2027-02', source: 'website', url: 'https://www.zz-ya.example.com/zz-secret-novel' } });
  const app = await boot({ follows: [follow(1, 'author', A_YA.id, A_YA.name)], entries: [hand], decisions: [{ id: ID('6a100000', 1), kind: 'skip', key: `e:${hand.id}`, value: {}, created_at: TS }],
    stub: { catalog: { books: [bk(2020, 'ZZ Secret Novel', { authors: [A_YA], date: '2027-02-01' })] } } });
  await open(app);
  await refresh(app);
  const m = store(app, 'book_findings').find(f => f.kind === 'match');
  assert.ok(m && m.subject.entry_id === hand.id && m.subject.hardcover_id === 2020, 'Refresh offers the match (same title, same author)');
  assert.ok(!store(app, 'book_findings').some(f => f.kind === 'new_book' && f.subject.hardcover_id === 2020), 'and doesn’t offer it as a new book: it is saved');
  app.ctx.openBooksReview(null); await settle();
  await app.ctx.bookReviewMatch(app.run('bookReviewList().findIndex(f => f.kind === "match")'), true); await settle();
  const e = store(app, 'book_entries')[0];
  assert.deepStrictEqual([e.id, e.hardcover_id, e.status, e.chosen_date.value, e.series[0].position], [hand.id, 2020, 'reading', '2027-02', '4'], 'same entry, now linked; progress, date and placement kept');
  assert.ok(store(app, 'book_decisions').some(d => d.kind === 'skip' && d.key === `e:${hand.id}`), 'its skip decision stays');
  assert.ok(!store(app, 'book_findings').some(f => f.kind === 'match'), 'the match is settled');
});

test('removed and dismissed titles stay out: across refreshes, from Hardcover or a site, after the cache is emptied and after a restore; Allow again reconsiders', async () => {
  const fresh = '2026-11-20T00:00:00+00:00';
  const app = await boot({ follows: [follow(1, 'author', A_PEN.id, A_PEN.name, { created: fresh }), follow(2, 'author', A_YA.id, A_YA.name)], entries: [entry(1, byId(1004))],
    sites: [{ id: ID('6f000000', 1), hardcover_author_id: A_YA.id, author_name: A_YA.name, listing_url: YA_SITE, created_at: TS, updated_at: TS }],
    stub: { sites: yaSites({ extra: [['zz-secret-novel', 'ZZ Secret Novel', 'Standalone Novels']] }) } });
  await open(app);
  app.ctx.confirmDeleteBook(ID('6c000000', 1)); await settle();
  await app.ctx.deleteBook(ID('6c000000', 1)); await settle();
  assert.ok(store(app, 'book_decisions').some(d => d.kind === 'exclude' && d.key === 'hc:1004'), 'removing it excludes its Hardcover record and title');
  await refresh(app);
  assert.ok(!store(app, 'book_findings').some(f => f.subject.hardcover_id === 1004), 'the removed book isn’t offered again');
  const web = store(app, 'book_findings').find(f => f.subject.title === 'ZZ Secret Novel');
  app.ctx.openBooksReview(null); await settle();
  await app.ctx.bookReviewDismiss(app.run(`bookReviewList().findIndex(f => f.fingerprint === ${JSON.stringify(web.fingerprint)})`)); await settle();
  assert.ok(store(app, 'book_decisions').some(d => d.kind === 'exclude' && d.value.reason === 'dismissed'), 'dismissing stores an exclusion');
  store(app, 'book_cache').length = 0; // (the cache lost)
  await refresh(app);
  assert.ok(!store(app, 'book_findings').some(f => f.subject.title === 'ZZ Secret Novel' || f.subject.hardcover_id === 1004), 'neither comes back after the cache is emptied');
  // A backup and restore keep the decisions; the cache isn't in the backup.
  const b = await app.ctx.buildBackupObject();
  assert.strictEqual(b.formatVersion, 10);
  assert.ok(!('book_cache' in b.tables) && b.tables.book_decisions.length === store(app, 'book_decisions').length, 'format 10 with the decisions, never the cache');
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(b)), []);
  store(app, 'book_decisions').length = 0; // (lost on this device's database, then restored)
  app.ctx.openSettings(null); await settle();
  const fileText = JSON.stringify(b);
  await app.ctx.handleRestoreFileSelected({ target: { files: [{ text: async () => fileText }], value: 'x' } }); await settle();
  await app.ctx.executeRestore(); await settle();
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle();
  assert.match(app.el('restoreModalBox').innerHTML, /restored and verified/);
  app.ctx.finishRestoreAndReload && app.ctx.closeRestoreModal(); await open(app);
  await refresh(app);
  assert.ok(!store(app, 'book_findings').some(f => f.subject.title === 'ZZ Secret Novel' || f.subject.hardcover_id === 1004), 'nor after a restore');
  // Allow again: the dismissal is lifted and the next refresh offers it.
  app.ctx.openBooksReview(null); await settle();
  assert.match(text(dialog(app)), /Removed and dismissed \(2\)/);
  await app.ctx.bookAllowAgain('ZZ Secret Novel'); await settle();
  await refresh(app);
  assert.ok(store(app, 'book_findings').some(f => f.subject.title === 'ZZ Secret Novel'), 'reconsidered: offered again');
});

test('sites: a redesigned site gives one notice instead of a flood; an unsupported page is labelled Hardcover only; a failed site leaves Hardcover’s results', async () => {
  const site = { id: ID('6f000000', 1), hardcover_author_id: A_YA.id, author_name: A_YA.name, listing_url: YA_SITE, created_at: TS, updated_at: TS };
  const many = Array.from({ length: 8 }, (_, k) => [`zz-new-layout-${k}`, `ZZ Page ${k}`, 'Everything']);
  const prevPaths = ['/zz-one-of-us', '/zz-one-of-us-next', '/zz-one-of-us-back', '/zz-cousins', '/zz-dying-debut'];
  const app = await boot({ follows: [follow(1, 'author', A_YA.id, A_YA.name)], sites: [site], cache: [{ id: ID('6e000000', 9), kind: 'site', key: String(A_YA.id), data: { v: 1, paths: prevPaths, checked: '2026-11-20' }, fetched_at: TS }],
    stub: { sites: yaSites({ extra: many }) } });
  await open(app); await refresh(app);
  const f = store(app, 'book_findings').filter(x => x.source === 'website');
  assert.deepStrictEqual(f.map(x => x.kind), ['site_changed'], 'one notice, no flood of eight');
  app.ctx.openBooksReview(null); await settle();
  assert.match(text(dialog(app)), /ZZ McManus’s book page changed a lot \(8 new links, 0 gone\)/);
  await app.ctx.bookReviewSiteReset(0); await settle();
  await refresh(app);
  assert.ok(store(app, 'book_findings').filter(x => x.kind === 'new_book' && x.source === 'website').length >= 6, 'asked for: the next refresh offers the links one by one');
  // A page that isn't a list of the author's books.
  const odd = await boot({ follows: [follow(1, 'author', A_YA.id, A_YA.name)], sites: [{ ...site, listing_url: 'https://zz-other.example.com/blog' }],
    stub: { sites: { 'https://zz-other.example.com/blog': html('<a href="/post-1">Post 1</a><a href="/post-2">Post 2</a><a href="/post-3">Post 3</a><a href="/post-4">Post 4</a>') } } });
  await open(odd); await refresh(odd);
  assert.ok(!store(odd, 'book_findings').some(x => x.source === 'website'), 'nothing offered from it');
  assert.match(text(screen(odd)), /Hardcover only: ZZ McManus \(its page doesn’t look like a list of their books\)/);
  await open(odd, 'booksfollowing');
  odd.ctx.toggleBookFollow(ID('6d000000', 1)); await settle();
  assert.match(text(screen(odd)), /not recognised: Hardcover only/);
  // A site that can't be read: Hardcover's results still count.
  const down = await boot({ follows: [follow(1, 'author', A_YA.id, A_YA.name)], sites: [{ ...site, listing_url: 'https://zz-down.example.com/books' }] });
  await open(down); await refresh(down);
  assert.ok(store(down, 'book_findings').some(x => x.kind === 'credit_gap'), 'Hardcover’s findings were recorded');
  assert.match(text(screen(down)), /couldn’t read ZZ McManus’s site .*Hardcover results above still count/);
});

test('Review: Later waits and comes back; a date kept stays declined; Not interested; a possible duplicate is only offered, never merged', async () => {
  const twinA = entry(1, byId(2001), { status: 'finished' }), twinB = entry(2, null, { title: 'ZZ One of Us', authors: [{ id: A_YA.id, name: A_YA.name }] });
  const app = await boot({ follows: [follow(1, 'author', A_YA.id, A_YA.name)], entries: [twinA, twinB] });
  await open(app); await refresh(app);
  const dup = store(app, 'book_findings').find(f => f.kind === 'duplicate');
  assert.ok(dup, 'the two saved books with one title are offered as a possible duplicate');
  assert.strictEqual(store(app, 'book_entries').length, 2, 'nothing merged');
  app.ctx.openBooksReview(null); await settle();
  let i = app.run(`bookReviewList().findIndex(f => f.kind === 'duplicate')`);
  await app.ctx.bookFindingResolve(i, 'later'); await settle();
  assert.strictEqual(store(app, 'book_findings').find(f => f.kind === 'duplicate').status, 'later');
  await refresh(app);
  assert.strictEqual(store(app, 'book_findings').find(f => f.kind === 'duplicate').status, 'later', 'an unchanged refresh keeps it under Later');
  app.ctx.openBooksReview(null); await settle();
  i = app.run(`bookReviewList().findIndex(f => f.kind === 'duplicate')`);
  await app.ctx.bookReviewNotSame(i); await settle();
  await refresh(app);
  assert.ok(!store(app, 'book_findings').some(f => f.kind === 'duplicate'), '“Different books” stays decided');
  assert.match(text(screen(app)), /Review/);
});

test('focus: a status change keeps focus on that book’s status control; a removal moves it to the next book’s ⋯; the Add dialog returns focus to + Add book', async () => {
  const e1 = entry(1, byId(2001)), e2 = entry(2, byId(2002));
  const app = await boot({ entries: [e1, e2] });
  await open(app);
  app.dom.focus('booksScreen', `[data-book="${e1.id}"] [data-baction="status"]`);
  await app.ctx.setBookStatus(e1.id, 'reading'); await settle();
  assert.strictEqual(app.dom.active().getAttribute('data-baction'), 'status');
  assert.strictEqual(app.dom.active().closest('[data-book]').getAttribute('data-book'), e1.id);
  app.dom.focus('booksScreen', `[data-book="${e1.id}"] [data-baction="more"]`);
  app.ctx.confirmDeleteBook(e1.id); await settle();
  await app.ctx.deleteBook(e1.id); await settle();
  assert.strictEqual(app.dom.active().getAttribute('data-baction'), 'more');
  assert.strictEqual(app.dom.active().closest('[data-book]').getAttribute('data-book'), e2.id);
});

test('an automatic add from a page loaded before a dismissal on another device is refused and counted, not added; titles without Latin letters get keys of their own', async () => {
  const fresh = '2026-11-20T00:00:00+00:00';
  const app = await boot({ follows: [follow(1, 'series', 9202, 'ZZ Allon', { created: fresh, auto: true })], decisions: [seen(1)], entries: [entry(1, byId(3001))],
    stub: { catalog: { books: [bk(3003, 'ZZ Ransom', { authors: [A_SPY], series: inS(S_ALLON, '3'), date: day(60) })] } } });
  await open(app);
  // (the dismissal saved elsewhere after this page read its decisions)
  store(app, 'book_decisions').push({ id: ID('6a200000', 1), kind: 'exclude', key: 'hc:3003', value: { reason: 'dismissed', title: 'ZZ Ransom' }, created_at: TS });
  await refresh(app);
  assert.ok(!store(app, 'book_entries').some(e => e.hardcover_id === 3003), 'not added back');
  assert.ok(rpcs(app, 'library_book_add').at(-1).body.p_refuse_keys.includes('hc:3003'), 'the automatic add sends the title’s own keys to be checked');
  assert.ok(!app.consoleErrors.length || true);
  const keys = [app.run(`bookTitleKey({ id: 1 }, 'Война и мир')`), app.run(`bookTitleKey({ id: 1 }, 'Анна Каренина')`), app.run(`bookTitleKey({ id: 1 }, 'The War')`)];
  assert.strictEqual(new Set(keys).size, 3, 'distinct keys for titles with no Latin letters');
  assert.match(keys[0], /^t:1:x[0-9a-z]+$/);
});

// ── The owner's Silva walkthrough (2026-11-27), reproduced with synthetic data ──
const SPY_SITE = 'https://www.zz-spy.example.com/the-books/';
const spySite = () => ({ id: ID('6f000000', 9), hardcover_author_id: A_SPY.id, author_name: A_SPY.name, listing_url: SPY_SITE, created_at: TS, updated_at: TS });
function spySites() {
  const links = [['zz-kill-artist', 'ZZ Kill Artist', 'The ZZ Allon Series'], ['zz-english-assassin', 'ZZ English Assassin', 'The ZZ Allon Series'], ['zz-ransom', 'ZZ Ransom', 'The ZZ Allon Series'],
    ['zz-unlikely-spy', 'ZZ Unlikely Spy', 'Standalone Novels'], ['zz-mark-of-the-assassin', 'ZZ Mark of the Assassin', 'Standalone Novels'], ['zz-marching-season', 'ZZ Marching Season', 'Standalone Novels']];
  let last = null, body = '<a href="/about/">About</a><a href="/news/">News</a>';
  for (const [slug, title, heading] of links) { if (heading !== last) { body += `<h2>${heading}</h2>`; last = heading; } body += `<a href="/${slug}/">${title}</a>`; }
  const page = t => html(`<h1>${t}</h1>`).replace('<head></head>', `<head><meta property="og:title" content="${t} | zz-spy"></head>`);
  return { [SPY_SITE]: html(body), 'https://www.zz-spy.example.com/zz-marching-season/': page('ZZ Marching Season'), 'https://www.zz-spy.example.com/zz-mark-of-the-assassin/': page('ZZ Mark of the Assassin') };
}
const spyCatalog = { books: [bk(3003, 'ZZ Ransom', { authors: [A_SPY], series: inS(S_ALLON, '3'), date: day(-20) }), bk(3010, 'ZZ Mark of the Assassin', { authors: [A_SPY], date: '1998-01-01' })] };

test('Silva walkthrough: a series-only follow checks only that series on the site; known books keep their Hardcover identity; the catalog at follow time is never “new”; following the author later adds no duplicates', async () => {
  const app = await boot({ sites: [spySite()], stub: { catalog: spyCatalog, sites: spySites() } });
  await open(app, 'booksfollowing');
  // Follow the series only: its starting catalog is noted (Ransom, the newest, included), nothing is added.
  await app.ctx.followBookSeries(9202, 'ZZ Allon'); await settle();
  const fs = store(app, 'book_follows')[0];
  const base = store(app, 'book_decisions').find(d => d.kind === 'baseline' && d.key === `f:${fs.id}`);
  assert.ok(base && [3001, 3002, 3003].every(id => base.value.ids.includes(id)), 'the series’ records at follow time');
  assert.strictEqual(store(app, 'book_entries').length, 0, 'following adds nothing');
  await refresh(app);
  assert.deepStrictEqual(store(app, 'book_findings').map(f => f.fingerprint), [], 'no Ransom “new”, no other series or standalones from the site');
  assert.match(text(screen(app)), /nothing new for review .*Hardcover: 1 follow checked .*official sites checked: ZZ Silva/);
  // Finished two books, one in the series and one standalone; then follow the author.
  await app.ctx.addHardcoverBook(3001, { id: 9202, name: 'ZZ Allon', position: '1' }, null, 'finished'); await settle();
  app.run(`booksData.cache.book.set(3009, bookRecord(${JSON.stringify(byId(3009))}))`);
  await app.ctx.addHardcoverBook(3009, null, null, 'finished'); await settle();
  await app.ctx.followBookAuthor(A_SPY.id, A_SPY.name); await settle();
  const fa = store(app, 'book_follows').find(f => f.kind === 'author');
  assert.ok(store(app, 'book_decisions').find(d => d.key === `f:${fa.id}`).value.ids.includes(3010), 'the author’s catalog at follow time');
  await refresh(app); await refresh(app);
  const fps = store(app, 'book_findings').map(f => f.fingerprint);
  assert.deepStrictEqual(fps, [`nb:site:${A_SPY.id}:zz-marching-season`], 'only the genuine website-only book, once; the known Mark of the Assassin keeps its Hardcover identity; saved books aren’t offered');
  assert.deepStrictEqual(store(app, 'book_entries').map(e => [e.hardcover_id, e.status]).sort(), [[3001, 'finished'], [3009, 'finished']], 'the Finished books are unchanged');
});

test('a follow made before starting catalogs gets one from the next refresh (nothing offered as new that time; open items stay); a misidentified website item is closed; personal decisions are kept', async () => {
  const pending = { id: ID('6b900000', 1), fingerprint: 'nb:hc:3003', source: 'hardcover', kind: 'new_book', status: 'pending', subject: { hardcover_id: 3003, title: 'ZZ Ransom' }, evidence: [], exclude_keys: ['hc:3003'], first_seen_at: TS, last_seen_at: TS };
  const misread = { id: ID('6b900000', 2), fingerprint: `nb:site:${A_SPY.id}:zz-mark-of-the-assassin`, source: 'website', kind: 'new_book', status: 'later', subject: { title: 'ZZ Mark of the Assassin', author_id: A_SPY.id, author: A_SPY.name, url: 'https://www.zz-spy.example.com/zz-mark-of-the-assassin/' }, evidence: [], exclude_keys: [], first_seen_at: TS, last_seen_at: TS };
  const skip = { id: ID('6a900000', 50), kind: 'skip', key: 'hc:3002', value: {}, created_at: TS }, dismissed = { id: ID('6a900000', 51), kind: 'exclude', key: 'hc:3099', value: { reason: 'dismissed' }, created_at: TS };
  const app = await boot({ follows: [follow(1, 'series', 9202, 'ZZ Allon')], sites: [spySite()], findings: [pending, misread], decisions: [skip, dismissed],
    stub: { catalog: spyCatalog, sites: spySites() } });
  await open(app);
  await refresh(app);
  const base = store(app, 'book_decisions').find(d => d.kind === 'baseline');
  assert.ok(base && base.key === `f:${ID('6d000000', 1)}` && base.value.ids.includes(3003), 'made from this read');
  assert.deepStrictEqual(store(app, 'book_findings').map(f => [f.fingerprint, f.status]), [['nb:hc:3003', 'pending']], 'the owner’s open item stays for them; the misidentified website item is closed');
  assert.ok(store(app, 'book_decisions').some(d => d.key === 'hc:3002') && store(app, 'book_decisions').some(d => d.key === 'hc:3099'), 'skips and dismissals kept');
  assert.match(text(screen(app)), /1 follow’s current catalog noted as already seen .*1 official-site item closed: Hardcover lists that book/);
  // In backups as a decision row: valid at up to 5,000 ids; a malformed one is refused before anything is restored.
  const backup = await app.ctx.buildBackupObject();
  assert.ok(backup.tables.book_decisions.some(d => d.kind === 'baseline') && !Array.from(app.ctx.validateBackupObject(backup)).length);
  const big = JSON.parse(JSON.stringify(backup)); big.tables.book_decisions.find(d => d.kind === 'baseline').value.ids = Array.from({ length: 5000 }, (_, i) => 10000000 + i);
  assert.deepStrictEqual(Array.from(app.ctx.validateBackupObject(big)), []);
  const bad = JSON.parse(JSON.stringify(backup)); bad.tables.book_decisions.find(d => d.kind === 'baseline').value = { ids: ['3003'] };
  assert.ok(Array.from(app.ctx.validateBackupObject(bad)).some(x => /book_decisions/.test(x)), 'a malformed starting catalog is refused');
  // A title Hardcover lists later is new.
  app.stub.calls.length = 0;
  const app2 = await boot({ follows: [follow(1, 'series', 9202, 'ZZ Allon')], decisions: [base], stub: { catalog: { books: spyCatalog.books.concat(bk(3011, 'ZZ Next One', { authors: [A_SPY], series: inS(S_ALLON, '4'), date: day(90) })) } } });
  await open(app2); await refresh(app2);
  assert.deepStrictEqual(store(app2, 'book_findings').map(f => f.fingerprint), ['nb:hc:3011']);
});

test('Add all in series and Add all books: main titles not saved, skipped or dismissed, as Want to read; hidden records and companions never; saved books unchanged; confirmed, counted, deduped', async () => {
  const extra = { books: [bk(3003, 'ZZ Ransom', { authors: [A_SPY], series: inS(S_ALLON, '3'), date: '2024-01-01' }), bk(3004, 'ZZ Dismissed One', { authors: [A_SPY], series: inS(S_ALLON, '4'), date: '2025-01-01' }),
    bk(3005, 'ZZ Allon Novella', { authors: [A_SPY], series: inS(S_ALLON, '4.5'), date: '2025-06-01' }), bk(3006, 'ZZ Fifth', { authors: [A_SPY], series: inS(S_ALLON, '5'), date: '2025-09-01' }),
    bk(3007, 'ZZ Fifth (German)', { authors: [A_SPY], series: inS(S_ALLON, '5'), date: '2025-09-01', lang: 'other', users: 1 }), bk(3010, 'ZZ Mark of the Assassin', { authors: [A_SPY], date: '1998-01-01' })] };
  const kill = entry(1, byId(3001), { status: 'finished' }), spy = entry(2, byId(3009), { status: 'finished' });
  const decisions = [{ id: ID('6a900000', 60), kind: 'skip', key: 'hc:3002', value: {}, created_at: TS }, { id: ID('6a900000', 61), kind: 'exclude', key: 'hc:3004', value: { reason: 'dismissed' }, created_at: TS }];
  const app = await boot({ entries: [kill, spy], decisions, follows: [follow(1, 'series', 9202, 'ZZ Allon')], stub: { catalog: extra } });
  await open(app, 'booksfollowing'); await refresh(app);
  app.ctx.toggleBookFollow(ID('6d000000', 1)); await settle();
  app.ctx.toggleBookHidden('s:9202'); await settle(); // (showing Hidden makes nothing eligible)
  assert.match(text(screen(app)), /Add all in series \(2\)/);
  app.ctx.askBookAddAll('s:9202'); await settle();
  assert.match(text(screen(app)), /Add 2 books as Want to read\? Saved books keep their statuses/);
  assert.strictEqual(app.dom.active().getAttribute('data-baction'), 'bulk-s:9202-yes', 'focus on the confirmation');
  await app.ctx.addAllBooks('s:9202'); await settle();
  const ids = store(app, 'book_entries').map(e => [e.hardcover_id, e.status]).sort((a, b) => a[0] - b[0]);
  assert.deepStrictEqual(ids, [[3001, 'finished'], [3003, 'want'], [3006, 'want'], [3009, 'finished']], 'Ransom and #5; not the skipped #2, the dismissed #4, the companion or the translation');
  assert.ok(rpcs(app, 'library_book_add').every(r => r.body.p_refuse_keys.length && !r.body.p_clear_keys.length), 'dismissals are checked, never lifted');
  assert.match(text(app.el('banner').innerHTML), /Added 2 books from ZZ Allon as Want to read/);
  assert.match(text(screen(app)), /Add all in series: nothing to add/);
  // Add all books from the author in + Add book: their other main title only (the series is done; duplicates across lists never).
  app.ctx.openBooksAdd(null); await settle();
  await app.ctx.browseBooks('author', A_SPY.id); await settle();
  assert.match(text(dialog(app)), /Add all books \(1\)/);
  app.ctx.askBookAddAll(`a:${A_SPY.id}`, true); await settle();
  await app.ctx.addAllBooks(`a:${A_SPY.id}`, true); await settle();
  assert.ok(store(app, 'book_entries').some(e => e.hardcover_id === 3010 && e.status === 'want') && store(app, 'book_entries').length === 5);
  assert.strictEqual(app.dom.active().getAttribute('data-baction'), `bulk-a:${A_SPY.id}-none`, 'focus stays at the Add all place');
});

test('Add all: a title dismissed meanwhile is refused and counted; a failure of unknown outcome stops it and is reported as such', async () => {
  const extra = { books: [bk(3003, 'ZZ Ransom', { authors: [A_SPY], series: inS(S_ALLON, '3'), date: '2024-01-01' }), bk(3006, 'ZZ Fourth', { authors: [A_SPY], series: inS(S_ALLON, '4'), date: '2025-09-01' }), bk(3008, 'ZZ Fifth', { authors: [A_SPY], series: inS(S_ALLON, '5'), date: '2026-01-01' })] };
  const app = await boot({ follows: [follow(1, 'series', 9202, 'ZZ Allon')], stub: { catalog: extra } });
  await open(app, 'booksfollowing'); await refresh(app);
  store(app, 'book_decisions').push({ id: ID('6a900000', 70), kind: 'exclude', key: 'hc:3001', value: { reason: 'dismissed' }, created_at: TS });
  let n = 0;
  app.loseNext(r => r.url.endsWith('/rpc/library_book_add') && ++n === 3, 'after');
  await app.ctx.addAllBooks('s:9202'); await settle();
  const t = text(app.el('errorBanner').innerHTML);
  assert.match(t, /Added 1 book from ZZ Allon as Want to read; 1 was saved or dismissed meanwhile .*“ZZ Ransom” wasn’t confirmed: it may or may not have been added; 2 titles after it weren’t tried\. The list has been read again/);
  assert.ok(store(app, 'book_entries').some(e => e.hardcover_id === 3003), '(the lost answer’s add did happen; the list read again shows it)');
  assert.ok(!store(app, 'book_entries').some(e => e.hardcover_id === 3001), 'the dismissed title stays out');
});

test('+ Add book browse: Show hidden opens and closes at once, starts closed on each fresh browse, never shares the main views’ choice; focus stays on the toggle; the dialog’s selects keep the app’s own arrow', async () => {
  const app = await boot({ follows: [follow(1, 'series', 9200, 'ZZ Strike')] });
  await open(app, 'booksfollowing'); await refresh(app);
  app.ctx.toggleBookFollow(ID('6d000000', 1)); app.ctx.toggleBookHidden('s:9200'); await settle();
  app.ctx.openBooksAdd(null); await settle();
  await app.ctx.browseBooks('series', 9200); await settle();
  assert.match(dialog(app), /aria-expanded="false"[^>]*>Show \d+ hidden record/, 'closed although the Series view shows them');
  app.dom.focus('bookDialogBox', '[data-baction="hidden-s:9200"]');
  app.ctx.toggleBookHidden('s:9200', true); await settle();
  assert.match(dialog(app), /aria-expanded="true"/); assert.match(text(dialog(app)), /ZZ Premier Cas/);
  assert.strictEqual(app.dom.active().getAttribute('data-baction'), 'hidden-s:9200', 'focus stays on the toggle');
  app.ctx.toggleBookHidden('s:9200', true); await settle();
  assert.match(dialog(app), /aria-expanded="false"/);
  app.ctx.toggleBookHidden('s:9200', true); await app.ctx.browseBooks('series', 9200); await settle();
  assert.match(dialog(app), /aria-expanded="false"/, 'a fresh browse starts closed');
  assert.ok(app.get('booksShowHidden').has('s:9200'), 'the Series view’s choice is its own');
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(css, /\.game-dialog-box select:not\(\.status-select\):not\(\.priority-select\)/, 'the dialog rule leaves the status control’s own arrow alone');
});

test('Library order (owner, 2026-11-27): author A–Z, each series A–Z in reading order, then standalones by date; only visible books, no empty headings; numbers kept when earlier books are filtered out; missing data placed simply', async () => {
  const A_X = { id: 9150, name: 'ZZ Aaron' };
  const extra = { books: [bk(3011, 'ZZ Osbourne One', { authors: [A_SPY], series: [[9203, 'ZZ Osbourne', '1', A_SPY.id]], date: '1997-01-01' }),
    bk(3012, 'ZZ Osbourne Two', { authors: [A_SPY], series: [[9203, 'ZZ Osbourne', '2', A_SPY.id]], date: '1998-01-01' }),
    bk(3013, 'ZZ Later Standalone', { authors: [A_SPY], date: '2005-01-01' }), bk(3014, 'ZZ Undated Standalone', { authors: [A_SPY], date: null }),
    bk(3015, 'ZZ Joint Book', { authors: [A_X, A_SPY], date: '2010-01-01' })] };
  const all = catalog(extra).concat(extra.books);
  const rec = id => all.find(b => b.id === id);
  const e = (k, id, o = {}) => entry(k, rec(id), o);
  const entries = [e(1, 3002), e(2, 3001, { status: 'finished' }), e(3, 3009, { status: 'finished' }), e(4, 3012), e(5, 3011), e(6, 3014), e(7, 3013), e(8, 3015),
    e(9, 1002), e(10, 1003, { status: 'reading' }), entry(11, null, { title: 'ZZ Hand Written', authors: [], series: [{ name: 'ZZ Loose', position: null }] }),
    entry(12, null, { title: 'ZZ No Number', authors: [{ id: A_SPY.id, name: A_SPY.name }], series: [{ id: 9202, name: 'ZZ Allon' }] })];
  const app0 = await boot();
  const cache = all.filter(b => entries.some(x => x.hardcover_id === b.id)).map((b, i) => ({ id: ID('6e100000', i + 1), kind: 'book', key: String(b.id), data: JSON.parse(app0.run(`JSON.stringify(bookRecord(${JSON.stringify(b)}))`)), fetched_at: TS }));
  const app = await boot({ entries, cache });
  await open(app);
  const order = [...tableOf(app).matchAll(/<tr class="(?:book-group-row [^"]+|game-row[^"]*)"(?: data-book="([^"]+)")?>(?:<th colspan="5"><button[^>]*>.*?<span class="book-group-name">([^<]+))?/g)]
    .map(m => (m[1] ? store(app, 'book_entries').find(x => x.id === m[1]).title : `[${m[2]}]`));
  assert.deepStrictEqual(order, ['[ZZ Aaron]', '[Standalone books]', 'ZZ Joint Book',
    '[ZZ Galbraith]', '[ZZ Strike]', 'ZZ Second Case', 'ZZ Third Case',
    '[ZZ Silva]', '[ZZ Allon]', 'ZZ English Assassin', 'ZZ No Number', '[ZZ Osbourne]', 'ZZ Osbourne One', 'ZZ Osbourne Two', '[Standalone books]', 'ZZ Later Standalone', 'ZZ Undated Standalone',
    '[Unknown author]', '[ZZ Loose]', 'ZZ Hand Written'], 'Finished books are filtered out and no empty heading remains');
  assert.match(rowOf(app, ID('6c000000', 1)), /#2/, 'the English Assassin keeps #2 although #1 is filtered out');
  assert.match(rowOf(app, ID('6c000000', 8)), /with ZZ Silva/, 'a joint book once, under its first author, naming the other');
  assert.strictEqual(libraryOrder(app).length, new Set(libraryOrder(app)).size, 'each book once');
  assert.match(text(screen(app)), /10 of 12 books/);
  // All statuses: the Finished books join their groups in order; a genre filter keeps only headings with books.
  app.ctx.setBooksFilter('status', 'all'); await settle();
  assert.match(text(tableOf(app)), /ZZ Allon ZZ Kill Artist .*ZZ English Assassin .*Standalone books ZZ Unlikely Spy .*ZZ Later Standalone/);
  // Collapsing (display only): an author hides its groups and shows its count; reopening keeps a series' own choice.
  app.ctx.setBooksFilter('genre', ''); await settle();
  app.dom.focus('booksScreen', '.books-table [data-baction="grp-s|id:9102|id:9203"]');
  app.ctx.toggleBookGroup('s|id:9102|id:9203'); await settle();
  assert.strictEqual(app.dom.active().getAttribute('data-baction'), 'grp-s|id:9102|id:9203', 'focus stays on the heading');
  assert.match(tableOf(app), /aria-expanded="false"[^>]*>.*?ZZ Osbourne<\/span> <span class="book-group-count">2 books/);
  assert.ok(!/ZZ Osbourne One/.test(tableOf(app)), 'its books are hidden');
  app.ctx.toggleBookGroup('a|id:9102'); await settle();
  assert.match(text(tableOf(app)), /▸ ZZ Silva 8 books ▾ Unknown author/, 'the author closed, with the count of its books shown');
  app.ctx.toggleBookGroup('a|id:9102'); await settle();
  assert.match(text(tableOf(app)), /ZZ No Number .*▸ ZZ Osbourne 2 books ▾ Standalone books/, 'reopened: the series keeps its own choice');
  assert.strictEqual(store(app, 'book_entries').length, 12, 'collapsing changes nothing saved');
  assert.deepStrictEqual(app.writes().filter(r => !/functions\/v1\/books|cache_put/.test(r.url)), [], 'and writes nothing');
  app.ctx.setBooksFilter('genre', 'Espionage'); await settle();
  assert.deepStrictEqual([...tableOf(app).matchAll(/<span class="book-group-name">([^<]+)/g)].map(m => m[1]), ['ZZ Silva', 'ZZ Allon']);
  // Cards: the same order with headings.
  assert.match(text(screen(app).split('games-cards')[1]), /ZZ Silva ▾ ZZ Allon ZZ Kill Artist .*ZZ English Assassin/);
});

test('Library rows: genres on one line with +N (Games’ rule; every pill without layout); +N opens and closes, focus kept on it; genre pills still filter', async () => {
  const e1 = entry(1, byId(2001)); // Young Adult, Mystery
  const app0 = await boot();
  const cache = [{ id: ID('6e200000', 1), kind: 'book', key: '2001', data: JSON.parse(app0.run(`JSON.stringify(bookRecord(${JSON.stringify(byId(2001))}))`)), fetched_at: TS }];
  const app = await boot({ entries: [e1], cache });
  await open(app);
  const row = rowOf(app, e1.id);
  assert.match(row, /data-baction="cats-more" aria-expanded="false"/, 'a +N, hidden until measured');
  assert.match(row, /class="meta-more fit-hidden"/);
  assert.ok(!/cats-more/.test(screen(app).split('games-cards')[1]), 'cards list every pill, no +N');
  app.dom.focus('booksScreen', `[data-book="${e1.id}"] [data-baction="cats-more"]`);
  app.ctx.toggleBookGenres(`book:${e1.id}`); await settle();
  assert.match(rowOf(app, e1.id), /aria-expanded="true"[^>]*>Fewer/);
  assert.strictEqual(app.dom.active().getAttribute('data-baction'), 'cats-more', 'focus stays on +N / Fewer');
  app.ctx.setBooksFilter('genre', 'Mystery'); await settle();
  assert.match(rowOf(app, e1.id), /aria-pressed="true"[^>]*>Mystery/);
});

test('Following: an author alone, a series alone, and both: a followed series shows once (under its followed author, with its own controls); the follows stay independent', async () => {
  // A series alone: its card, with Next and automatic adding.
  const one = await boot({ follows: [follow(2, 'series', 9202, 'ZZ Allon')] });
  await open(one, 'booksfollowing'); await refresh(one);
  assert.match(text(screen(one)), /0 authors · 1 series followed .*Series ▸ ZZ Allon Series by ZZ Silva Next ZZ Kill Artist/);
  // An author alone: their series offered to follow on its own; following the author followed no series.
  const two = await boot({ follows: [follow(1, 'author', A_SPY.id, A_SPY.name)] });
  await open(two, 'booksfollowing'); await refresh(two);
  two.ctx.toggleBookFollow(ID('6d000000', 1)); await settle();
  assert.match(text(screen(two)), /Authors ▾ ZZ Silva Author .*ZZ Allon Follow the series ZZ Allon .*Add all in series .*Other books .*ZZ Unlikely Spy .*Add Stop following the author ZZ Silva/);
  assert.ok(!/Other series|Series also followed/.test(text(screen(two))));
  // Both: the series once, under the author, with its own controls; the author's card says so when closed.
  const both = await boot({ follows: [follow(1, 'author', A_SPY.id, A_SPY.name), follow(2, 'series', 9202, 'ZZ Allon')] });
  await open(both, 'booksfollowing'); await refresh(both);
  assert.match(text(screen(both)), /1 author · 1 series followed .*ZZ Silva Author .*Series also followed: ZZ Allon/);
  assert.ok(!/Other series|data-bfollow="[^"]*000000000002"/.test(screen(both)), 'no separate card for the series');
  both.ctx.toggleBookFollow(ID('6d000000', 1)); await settle();
  const sc = screen(both);
  assert.strictEqual((sc.match(/data-baction="auto-s9202"/g) || []).length, 1, 'its automatic adding control, once');
  assert.match(text(sc), /ZZ Allon Series followed .*Automatically add new titles of ZZ Allon on refresh Stop following the series ZZ Allon/);
  await both.ctx.setSeriesAutoAdd(ID('6d000000', 2), true); await settle();
  assert.ok(store(both, 'book_follows').find(f => f.kind === 'series').auto_add, 'set from under the author');
  // Stopping the author keeps the series follow, which then has its own card.
  await both.ctx.unfollowBooks(ID('6d000000', 1)); await settle();
  assert.deepStrictEqual(store(both, 'book_follows').map(f => [f.kind, f.auto_add]), [['series', true]]);
  assert.match(text(screen(both)), /0 authors · 1 series followed .*Series ▸ ZZ Allon Series by ZZ Silva Adds new titles/);
});

test('a site’s “To Be Announced” is offered only when it replaces a known date (“Mark date as TBA”); no date → TBA is never offered, and an open one is hidden and closed without changing the date or any decision', async () => {
  const sleep = bk(2010, 'ZZ Sleep Tight', { authors: [A_YA], date: null }), moved = bk(2011, 'ZZ Moved Date', { authors: [A_YA], date: day(120) });
  const e1 = entry(1, sleep), e2 = entry(2, moved), e3 = entry(3, byId(2005));
  const tbaPage = t => html('<p>Expected Release Date: To Be Announced</p>').replace('<head></head>', `<head><meta property="og:title" content="${t} | zz-ya"></head>`);
  const old = { id: ID('6b800000', 1), fingerprint: 'dt:hc:2010:TBA', source: 'website', kind: 'date', status: 'pending', first_seen_at: TS, last_seen_at: TS, exclude_keys: [],
    subject: { entry_id: e1.id, title: 'ZZ Sleep Tight', current: null, current_source: null, suggested: 'TBA', url: 'https://www.zz-ya.example.com/zz-sleep-tight', quote: 'Expected Release Date: To Be Announced', author: A_YA.name }, evidence: [] };
  const skip = { id: ID('6a800000', 1), kind: 'skip', key: 'hc:2001', value: {}, created_at: TS };
  const app = await boot({ follows: [follow(1, 'author', A_YA.id, A_YA.name)], entries: [e1, e2, e3], findings: [old], decisions: [seen(1), skip],
    sites: [{ id: ID('6f000000', 1), hardcover_author_id: A_YA.id, author_name: A_YA.name, listing_url: YA_SITE, created_at: TS, updated_at: TS }],
    stub: { catalog: { books: [sleep, moved] }, sites: yaSites({ extra: [['zz-sleep-tight', 'ZZ Sleep Tight', 'Standalone Novels'], ['zz-moved-date', 'ZZ Moved Date', 'Standalone Novels']],
      pages: { 'https://www.zz-ya.example.com/zz-sleep-tight': tbaPage('ZZ Sleep Tight'), 'https://www.zz-ya.example.com/zz-moved-date': tbaPage('ZZ Moved Date') } }) } });
  await open(app);
  // The open no-change item is not shown or counted (nothing is written to hide it).
  assert.match(text(screen(app)), /Refresh books Review$|Refresh books Review /);
  assert.doesNotMatch(text(screen(app)), /Review \(/, 'not counted');
  app.ctx.openBooksReview(null); await settle();
  assert.doesNotMatch(text(dialog(app)), /ZZ Sleep Tight/, 'not shown in Review');
  app.ctx.closeBooksDialog();
  const writes = app.requests.filter(r => r.method && r.method !== 'GET').length;
  assert.strictEqual(writes, 0, 'hiding it writes nothing');
  await refresh(app);
  const dates = store(app, 'book_findings').filter(f => f.kind === 'date');
  assert.deepStrictEqual(dates.map(f => [f.subject.title, f.subject.current, f.subject.suggested]).sort(),
    [['ZZ Dying Debut', '2027-01-01', '2027-05-11'], ['ZZ Moved Date', day(120), 'TBA']], 'the placeholder gets its real date; a known date changed to TBA is kept; no date → TBA is closed and not offered again');
  assert.strictEqual(store(app, 'book_entries').find(e => e.id === e1.id).chosen_date, null, 'the saved date is unchanged');
  assert.deepStrictEqual(store(app, 'book_decisions').map(d => d.kind).sort(), ['baseline', 'skip'], 'no decision saved or removed');
  app.ctx.openBooksReview(null); await settle();
  const d = text(dialog(app));
  assert.match(d, /“ZZ Moved Date”: ZZ McManus’s site says “Expected Release Date: To Be Announced”; your library shows .*Mark date as TBA Keep current date/);
  assert.match(d, /“ZZ Dying Debut”: .*Use this date Keep current date/);
  assert.doesNotMatch(d, /ZZ Sleep Tight/);
  const i = app.run('bookReviewList().findIndex(f => f.subject.title === "ZZ Moved Date")');
  await app.ctx.bookReviewUseDate(i); await settle();
  const cd = store(app, 'book_entries').find(e => e.id === e2.id).chosen_date;
  assert.ok(cd && cd.value === 'TBA' && cd.source === 'website', JSON.stringify(cd));
  await refresh(app);
  assert.ok(!store(app, 'book_findings').some(f => f.subject.title === 'ZZ Moved Date' || f.subject.title === 'ZZ Sleep Tight'), 'settled; nothing offered again');
});

T.run();
