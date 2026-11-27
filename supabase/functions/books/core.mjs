// The books function (BK1, next-gen item 6): the page's only way to Hardcover and to authors' official book pages.
// Hardcover's API needs an account token that must stay server-side; this function holds it (Supabase function secret
// HARDCOVER_TOKEN, a personal access token limited to read:catalog), answers only signed-in library members, and sends only the
// fixed read-only queries below, with the caller's variables checked. It also reads an author's official book-listing page (and a
// few pages it links to) for Refresh books, with bounded fetching: https only, public host names, size and time limits, at most a
// few pages per request. Page text is data: it is reduced here to links, titles and dated phrases; nothing in it is followed as an
// instruction. It stores nothing and logs no query or page.
//
// Membership is checked as the igdb function checks it (supabase/functions/igdb/core.mjs): the caller's own token and the
// project's publishable key, sent to PostgREST's rpc/stage5_capabilities, which answers member: true for a member.
// Answers: 401 signed out or an invalid token; 403 signed in but not a member; 400 a request outside the allow-list; 502 when
// Hardcover can't be reached or refuses; a site that can't be read is reported in its own result (ok: false), never as a failure
// of the whole request. Pure: everything it reaches goes through deps.fetch (tests pass a fake).

export const MAX_QUERIES = 8;
export const MAX_PAGES = 8;
export const MAX_PAGE_BYTES = 2_500_000;
const HARDCOVER_DEFAULT = 'https://api.hardcover.app/v1/graphql';
const SITE_TIMEOUT_MS = 10000;
const USER_AGENT = 'WatchlistBooks/1 (private reading list; reads book-listing pages on Refresh)';

const CORS = {
  'Access-Control-Allow-Origin': '*', // the caller's token is the credential; no cookies are used
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600'
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ── Hardcover: the fixed queries ──
// One book as every list carries it. Merged records (canonical_id set) are left out where the queries can say so; the
// language aliases say whether an English edition exists (english) and whether any edition has a language at all (langknown):
// a book with neither has an unknown language, which the page never treats as English.
const BOOK = `id title slug release_date release_year canonical_id compilation is_partial_book users_count editions_count alternative_titles cached_tags
  contributions { contribution author { id name } }
  book_series { position details compilation series { id name canonical_id author_id } }
  english: editions(where: {language_id: {_eq: 1}}, limit: 1) { id }
  langknown: editions(where: {language_id: {_is_null: false}}, limit: 1) { id }`;
export const QUERIES = {
  search: { vars: { text: 'text', type: 'type' },
    doc: `query($text: String!, $type: String!) { result: search(query: $text, query_type: $type, per_page: 20, page: 1) { results } }` },
  author: { vars: { id: 'id' },
    doc: `query($id: Int!) { result: authors_by_pk(id: $id) { id name slug canonical_id alias { id name }
      contributions(where: {book: {canonical_id: {_is_null: true}}}, limit: 500) { contribution book { ${BOOK} } } } }` },
  author_series: { vars: { id: 'id' },
    doc: `query($id: Int!) { result: series(where: {author_id: {_eq: $id}, canonical_id: {_is_null: true}}, limit: 50) { id name slug books_count primary_books_count author { id name } } }` },
  series: { vars: { id: 'id' },
    doc: `query($id: Int!) { result: series_by_pk(id: $id) { id name slug canonical_id primary_books_count is_completed author { id name }
      book_series(where: {book: {canonical_id: {_is_null: true}}}, order_by: [{position: asc_nulls_last}, {book: {users_count: desc}}], limit: 500) { position details compilation book { ${BOOK} } } } }` },
  books: { vars: { ids: 'ids' },
    doc: `query($ids: [Int!]) { result: books(where: {id: {_in: $ids}}, limit: 100) { ${BOOK} } }` }
};
const SEARCH_TYPES = ['Book', 'Author', 'Series'];
export function queryProblem(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return 'not an object';
  if (typeof q.name !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(q.name)) return 'name missing';
  const spec = QUERIES[q.q];
  if (!spec) return `query ${JSON.stringify(q.q)} isn’t allowed`;
  const vars = q.vars && typeof q.vars === 'object' && !Array.isArray(q.vars) ? q.vars : null;
  if (!vars || Object.keys(vars).sort().join() !== Object.keys(spec.vars).sort().join()) return 'variables don’t match the query';
  for (const [k, t] of Object.entries(spec.vars)) {
    const v = vars[k];
    if (t === 'id' && !(Number.isInteger(v) && v > 0 && v < 2147483647)) return `${k} must be a Hardcover id`;
    if (t === 'ids' && !(Array.isArray(v) && v.length >= 1 && v.length <= 100 && v.every(x => Number.isInteger(x) && x > 0 && x < 2147483647))) return `${k} must be 1 to 100 Hardcover ids`;
    if (t === 'text' && !(typeof v === 'string' && v.trim() && v.length <= 120)) return `${k} must be 1 to 120 characters`;
    if (t === 'type' && !SEARCH_TYPES.includes(v)) return `${k} must be Book, Author or Series`;
  }
  return null;
}
// The genre tags a book carries, by how many readers applied them (Hardcover's cached_tags), names only.
export function genreNames(tags) {
  const g = tags && typeof tags === 'object' && Array.isArray(tags.Genre) ? tags.Genre : [];
  return g.filter(t => t && typeof t.tag === 'string').sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 12).map(t => t.tag.trim()).filter(Boolean);
}
// Smaller answers: cached_tags reduced to genre names; anything else is passed on as Hardcover gave it.
function trimBooks(v) {
  if (Array.isArray(v)) return v.map(trimBooks);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'cached_tags') out.genres = genreNames(x);
    else out[k] = trimBooks(x);
  }
  return out;
}
async function hardcover(env, deps, q, retried = false) {
  const res = await deps.fetch(env.HARDCOVER_URL || HARDCOVER_DEFAULT, { method: 'POST',
    headers: { authorization: `Bearer ${env.HARDCOVER_TOKEN}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ query: QUERIES[q.q].doc, variables: q.vars }) });
  if (res.status === 429 && !retried) { await deps.sleep(3000); return hardcover(env, deps, q, true); }
  const limit = res.headers && typeof res.headers.get === 'function' ? res.headers.get('ratelimit') || '' : '';
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok || !body || body.errors || body.error) return { name: q.name, error: `hardcover_${res.status}${body && body.errors ? '_query' : ''}`, limit };
  const data = body.data && 'result' in body.data ? body.data.result : null;
  return { name: q.name, data: trimBooks(data), limit };
}
// Whether the next query should wait: Hardcover's RateLimit header ('"Free";r=9;t=0, ...'): r is what is left of the burst.
export function burstLeft(header) { const m = /"Free";r=(\d+)/.exec(header || '') || /;r=(\d+)/.exec(header || ''); return m ? Number(m[1]) : null; }

// ── Official sites ──
// A public https address: no credentials, no IP-address or single-label hosts, the default port.
export function siteUrlProblem(u) {
  let url;
  try { url = new URL(u); } catch (e) { return 'not an address'; }
  if (url.protocol !== 'https:') return 'not https';
  if (url.username || url.password) return 'carries credentials';
  if (url.port && url.port !== '443') return 'uses another port';
  const h = url.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || /^\d+(\.\d+){3}$/.test(h) || h.endsWith('.local') || h.endsWith('.internal') || h === 'localhost' || h.endsWith('.localhost')) return 'not a public host name';
  if (String(u).length > 500) return 'too long';
  return null;
}
async function readPage(u, deps, hops = 0) {
  const p = siteUrlProblem(u);
  if (p) return { url: u, ok: false, error: `address refused (${p})` };
  let res;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), SITE_TIMEOUT_MS) : null;
  try { res = await deps.fetch(u, { method: 'GET', redirect: 'manual', headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' }, signal: ctl ? ctl.signal : undefined }); }
  catch (e) { if (timer) clearTimeout(timer); return { url: u, ok: false, error: 'couldn’t be reached' }; }
  if (res.status >= 300 && res.status < 400) {
    if (timer) clearTimeout(timer);
    const to = res.headers.get('location');
    if (!to || hops >= 3) return { url: u, ok: false, error: 'too many redirects' };
    let next;
    try { next = new URL(to, u).toString(); } catch (e) { return { url: u, ok: false, error: 'a redirect to an address that can’t be read' }; }
    return readPage(next, deps, hops + 1);
  }
  try {
    if (!res.ok) return { url: u, ok: false, status: res.status, error: `answered ${res.status}` };
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/.test(type)) return { url: u, ok: false, status: res.status, error: 'not a web page' };
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_PAGE_BYTES) return { url: u, ok: false, error: 'page too large' };
    // Read with a byte cap (a chunked or compressed page has no length to check first).
    let text = '';
    if (res.body && typeof res.body.getReader === 'function') {
      const cs = (/charset=([\w-]+)/i.exec(type) || [])[1];
      let dec;
      try { dec = new TextDecoder(cs || 'utf-8'); } catch (e) { dec = new TextDecoder(); } // (the page's declared charset, else UTF-8)
      const reader = res.body.getReader();
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > MAX_PAGE_BYTES) { try { await reader.cancel(); } catch (e) { /* closed */ } return { url: u, ok: false, error: 'page too large' }; }
        text += dec.decode(value, { stream: true });
      }
      text += dec.decode();
    } else {
      text = await res.text();
      if (text.length > MAX_PAGE_BYTES) return { url: u, ok: false, error: 'page too large' };
    }
    return { url: u, ok: true, status: res.status, html: text };
  } catch (e) { return { url: u, ok: false, error: 'couldn’t be read' }; }
  finally { if (timer) clearTimeout(timer); }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä' };
export function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const textOf = h => decode(String(h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTH_NO = Object.fromEntries(MONTHS.split('|').map((m, i) => [m.toLowerCase(), String(i + 1).padStart(2, '0')]));
// "2 September 2025", "September 2, 2025", "Sept. 2, 2025" → 2025-09-02 (null when it isn't a real date).
export function isoDate(s) {
  const t = String(s || '').replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  let m = new RegExp(`^(\\d{1,2}) (${MONTHS}) (\\d{4})$`, 'i').exec(t), d, mo, y;
  if (m) [d, mo, y] = [m[1], m[2], m[3]];
  else { m = new RegExp(`^(${MONTHS}) (\\d{1,2}) (\\d{4})$`, 'i').exec(t); if (!m) return null; [mo, d, y] = [m[1], m[2], m[3]]; }
  const iso = `${y}-${MONTH_NO[mo.toLowerCase()]}-${String(d).padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso ? null : iso;
}
const DAY = `(?:\\d{1,2}(?:st|nd|rd|th)? (?:${MONTHS}),? \\d{4}|(?:${MONTHS}) \\d{1,2}(?:st|nd|rd|th)?,? \\d{4})`;
// The dated phrases a book page can carry, each tried in order (the inspected sites' wording; a new phrase is a maintenance change).
export const DATE_RULES = [
  { id: 'published_on', re: new RegExp(`\\bPublished on (${DAY})`, 'i'), kind: 'day' },
  { id: 'expected_release', re: new RegExp(`\\bExpected Release Date:? (To Be Announced|TBA|${DAY})`, 'i'), kind: 'expected' },
  { id: 'coming', re: new RegExp(`\\bComing (${DAY})`, 'i'), kind: 'day' },
  { id: 'on_sale', re: new RegExp(`\\bOn sale (${DAY})`, 'i'), kind: 'day' },
  { id: 'available_on', re: new RegExp(`\\bAvailable on (${DAY})`, 'i'), kind: 'day' },
  { id: 'coming_year', re: /\bComing in (\d{4})\b/i, kind: 'year' }
];
// The first dated phrase in a stretch of text: { value: 'YYYY-MM-DD' | 'YYYY' | 'TBA', rule, quote }.
export function datePhrase(text) {
  for (const r of DATE_RULES) {
    const m = r.re.exec(text);
    if (!m) continue;
    const raw = m[1];
    const value = r.kind === 'year' ? raw : /^(To Be Announced|TBA)$/i.test(raw) ? 'TBA' : isoDate(raw);
    if (value) return { value, rule: r.id, quote: m[0].slice(0, 120) };
  }
  return null;
}
// "In the 26th book of the Gabriel Allon series" → { position: '26', name: 'Gabriel Allon' }.
export function seriesPhrase(text) {
  const m = /\b(?:the )?(\d{1,3})(?:st|nd|rd|th) (?:book|novel|installment|instalment) (?:of|in) the ([A-Z][\w’' .-]{1,60}?) series\b/.exec(text);
  return m ? { position: m[1], name: m[2].trim() } : null;
}
// Links in a page: same-site links with their text (or an image's alt text), each with the heading it sits under.
const NAV_WORDS = new Set(['about', 'about-me', 'bio', 'biography', 'contact', 'contact-faqs', 'faq', 'faqs', 'news', 'news-and-events', 'events', 'events-appearances',
  'tour', 'appearances', 'media', 'press', 'blog', 'links', 'extras', 'home', 'shop', 'store', 'cart', 'account', 'login', 'search', 'newsletter', 'subscribe',
  'join-the-mailing-list', 'mailing-list', 'privacy', 'privacy-policy', 'terms', 'cookies', 'international-publishers', 'interviews', 'gallery', 'videos',
  'podcast', 'listen', 'listen-to-daniel', 'watch', 'books', 'the-books', 'all-books', 'novels', 'series', 'characters', 'locations', 'tv', 'tv-series', 'feed',
  'wp-json', 'follow', 'follow-daniel', 'watch-daniel-on', 'author', 'authors', 'a-complete-listing', 'stories', 'resources', 'teachers', 'book-clubs']);
export function pageLinks(html, base) {
  const out = [];
  let origin;
  try { origin = new URL(base); } catch (e) { return out; }
  const host = origin.hostname.replace(/^www\./, '');
  const re = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m, heading = '';
  while ((m = re.exec(html))) {
    if (m[1]) { heading = textOf(m[2]).slice(0, 160); continue; }
    const href = /\bhref\s*=\s*"([^"]+)"|\bhref\s*=\s*'([^']+)'/i.exec(m[3]);
    if (!href) continue;
    let u;
    try { u = new URL(decode(href[1] || href[2]), base); } catch (e) { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (u.hostname.replace(/^www\./, '') !== host) continue;
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const alt = /\balt\s*=\s*"([^"]*)"/i.exec(m[4]);
    const text = textOf(m[4]).slice(0, 300) || (alt ? decode(alt[1]).slice(0, 300) : '');
    out.push({ path, url: `${u.origin}${u.pathname}`, text, heading });
  }
  return out;
}
// The shared listing rule: book pages are the same-site links under the most common path prefix with at least three distinct
// pages (as /strike-books/<book> or /books/<book>); on a flat site (no such prefix), every single-level page that isn't a
// navigation page. Each candidate has every text its links carried (title, alt text) and the heading it was listed under.
export function listingCandidates(html, base) {
  const links = pageLinks(html, base);
  let listing;
  try { listing = new URL(base).pathname.replace(/\/+$/, '') || '/'; } catch (e) { listing = '/'; }
  const children = new Map();
  for (const l of links) {
    const parts = l.path.split('/').filter(Boolean);
    if (parts.length >= 2) { const pre = `/${parts.slice(0, -1).join('/')}`; (children.get(pre) || children.set(pre, new Set()).get(pre)).add(l.path); }
  }
  let prefix = null, best = 0;
  for (const [pre, set] of children) if (set.size > best && set.size >= 3 && !pre.split('/').some(p => NAV_WORDS.has(p) && !/book|novel/.test(p))) { prefix = pre; best = set.size; }
  if (prefix === null) for (const [pre, set] of children) if (set.size > best && set.size >= 3 && /book|novel/.test(pre)) { prefix = pre; best = set.size; }
  const byPath = new Map();
  for (const l of links) {
    const parts = l.path.split('/').filter(Boolean);
    const slug = parts[parts.length - 1] || '';
    const isBook = prefix ? l.path.startsWith(`${prefix}/`) && parts.length === prefix.split('/').filter(Boolean).length + 1
      : parts.length === 1 && !NAV_WORDS.has(slug.toLowerCase());
    if (!isBook || l.path === listing || /\.(pdf|jpe?g|png|gif|webp|zip)$/i.test(slug)) continue;
    const c = byPath.get(l.path) || byPath.set(l.path, { path: l.path, url: l.url, slug, texts: [], headings: [] }).get(l.path);
    if (l.text && !c.texts.includes(l.text)) c.texts.push(l.text);
    if (l.heading && !c.headings.includes(l.heading)) c.headings.push(l.heading);
  }
  return { prefix, candidates: [...byPath.values()].slice(0, 200) };
}
// A book page: its title (og:title without the site's name, else the first heading), its first dated phrase and series phrase, and
// links to publisher pages it points to (where a date may be given).
export const PUBLISHER_HOSTS = ['penguinrandomhouse.com', 'www.penguinrandomhouse.com', 'penguin.co.uk', 'www.penguin.co.uk', 'harpercollins.com', 'www.harpercollins.com',
  'littlebrown.co.uk', 'www.littlebrown.co.uk', 'hachettebookgroup.com', 'www.hachettebookgroup.com', 'simonandschuster.com', 'www.simonandschuster.com', 'macmillan.com', 'us.macmillan.com'];
export function bookPage(html, url) {
  const og = /<meta[^>]+property\s*=\s*"og:title"[^>]+content\s*=\s*"([^"]*)"|<meta[^>]+content\s*=\s*"([^"]*)"[^>]+property\s*=\s*"og:title"/i.exec(html);
  let title = og ? decode(og[1] ?? og[2]).trim() : '';
  title = title.replace(/\s+[|–—]\s+[^|–—]{2,60}$/, '').replace(/\s+-\s+[^-]{2,60}$/, '').trim();
  if (!title) { const h = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html); title = h ? textOf(h[1]).slice(0, 300) : ''; }
  const text = textOf(html);
  const publishers = [];
  const re = /<a\b[^>]*\bhref\s*=\s*"(https:\/\/[^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) && publishers.length < 4) {
    try { const u = new URL(decode(m[1])); if (PUBLISHER_HOSTS.includes(u.hostname) && /\/books?\//.test(u.pathname) && !publishers.includes(u.toString())) publishers.push(u.toString()); } catch (e) { /* skip */ }
  }
  return { url, title: title.slice(0, 300), date: datePhrase(text), series: seriesPhrase(text), publishers };
}
// An announcement on the site's front page: a linked title followed by "Coming <date>! In the 26th book of the … series".
export function announcements(html, base) {
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>([^<]{2,200})<\/a>\s*(?:<\/h[1-6]>)?\s*(?:<p\b[^>]*>)?\s*((?:Coming|On sale|Available)[^<]{0,300})/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 5) {
    const text = decode(m[3]).replace(/\s+/g, ' ');
    const date = datePhrase(text);
    if (!date) continue;
    let url;
    try { url = new URL(decode(m[1]), base).toString(); } catch (e) { continue; }
    out.push({ url, title: decode(m[2]).trim(), date, series: seriesPhrase(text), quote: text.slice(0, 200) });
  }
  return out;
}

// ── Membership ──
export async function memberCheck(req, env, deps) {
  const auth = req.headers.get('authorization') || '';
  const apikey = req.headers.get('apikey') || env.SUPABASE_ANON_KEY || '';
  const m = /^Bearer\s+(\S+)$/.exec(auth);
  if (!m || !apikey || m[1] === apikey) return json(401, { error: 'not_signed_in', message: 'Sign in to look up books.' });
  let res;
  try {
    res = await deps.fetch(`${env.SUPABASE_URL}/rest/v1/rpc/stage5_capabilities`, { headers: { apikey, Authorization: `Bearer ${m[1]}`, Accept: 'application/json' } });
  } catch (e) { return json(502, { error: 'membership_unknown', message: 'Your membership couldn’t be checked. Try again.' }); }
  if (res.status === 401 || res.status === 403) return json(401, { error: 'not_signed_in', message: 'Sign in to look up books.' });
  if (!res.ok) return json(502, { error: 'membership_unknown', message: 'Your membership couldn’t be checked. Try again.' });
  let cap = null;
  try { cap = await res.json(); } catch (e) { cap = null; }
  if (!cap || cap.member !== true) return json(403, { error: 'not_a_member', message: 'This account has no library here.' });
  return null;
}

export async function handle(req, env, deps) {
  const d = { sleep: ms => new Promise(r => setTimeout(r, ms)), ...deps };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const refused = await memberCheck(req, env, d);
  if (refused) return refused;
  let body;
  try { body = await req.json(); } catch (e) { return json(400, { error: 'invalid_request', message: 'The request isn’t JSON.' }); }
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid_request', message: 'The request isn’t an object.' });

  if (body.op === 'hardcover') {
    const queries = Array.isArray(body.queries) ? body.queries : null;
    if (!queries || !queries.length || queries.length > MAX_QUERIES) return json(400, { error: 'invalid_request', message: `Send 1 to ${MAX_QUERIES} queries.` });
    for (const q of queries) { const p = queryProblem(q); if (p) return json(400, { error: 'invalid_request', message: p }); }
    if (!env.HARDCOVER_TOKEN) return json(502, { error: 'hardcover_not_configured', message: 'Hardcover isn’t set up for this site yet.' });
    const results = [];
    try {
      for (const q of queries) {
        const r = await hardcover(env, d, q);
        results.push({ name: r.name, ...(r.error ? { error: r.error } : { data: r.data }) });
        const left = burstLeft(r.limit);
        if (left !== null && left < 1) await d.sleep(1100); // (the burst refills at one request a second)
      }
    } catch (e) {
      return json(502, { error: 'hardcover_unreachable', message: 'Hardcover couldn’t be reached. Try again later.' });
    }
    return json(200, { results });
  }

  if (body.op === 'site') {
    // { listing: url, pages: [url…] (book pages and publisher pages to read), home: url (the site's front page; optional) }.
    const listing = typeof body.listing === 'string' ? body.listing : null;
    const pages = Array.isArray(body.pages) ? body.pages : [];
    const home = typeof body.home === 'string' ? body.home : null;
    if ((!listing && !pages.length) || pages.length > MAX_PAGES || pages.some(p => typeof p !== 'string') || (listing && siteUrlProblem(listing)) || (home && siteUrlProblem(home))) {
      return json(400, { error: 'invalid_request', message: 'Send a book-listing page and up to 8 pages, as https addresses.' });
    }
    const out = { listing: null, home: null, pages: [] };
    if (listing) {
      const r = await readPage(listing, d);
      out.listing = r.ok ? { url: r.url, ok: true, ...listingCandidates(r.html, r.url) } : { url: listing, ok: false, error: r.error };
    }
    if (home) {
      const r = await readPage(home, d);
      out.home = r.ok ? { url: r.url, ok: true, announcements: announcements(r.html, r.url) } : { url: home, ok: false, error: r.error };
    }
    for (const p of pages) {
      const r = await readPage(p, d);
      out.pages.push(r.ok ? { ok: true, ...bookPage(r.html, r.url) } : { url: p, ok: false, error: r.error });
    }
    return json(200, out);
  }
  return json(400, { error: 'invalid_request', message: 'Unknown operation.' });
}
