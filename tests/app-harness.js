// Offline harness that runs the whole page in a Node vm: every script in
// watchlist.html's order, then the page's inline state/boot script, against a
// minimal fake DOM and an in-memory stand-in for Supabase and TMDB.
// Used by tests/derived-views.test.js and tests/derived-nav.test.js.
// No network, no database: fetch is a stub that refuses any unexpected host.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'watchlist.html'), 'utf8');
const SCRIPT_FILES = [...HTML.matchAll(/<script src="([^"?]+)(?:\?[^"]*)?"><\/script>/g)].map(m => m[1]);
const INLINE_SCRIPT = HTML.match(/<script>\n([\s\S]*?)<\/script>/)[1];
const PAGE_IDS = [...HTML.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/id="([^"]+)"/g)].map(m => m[1]);

const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const clone = v => JSON.parse(JSON.stringify(v));

// PostgREST-style filter over in-memory rows: eq., is.null, in.(...)
function matches(row, params) {
  for (const [k, v] of params) {
    if (k === 'select' || k === 'order' || k === 'limit') continue;
    if (v === 'is.null') { if (row[k] != null) return false; continue; }
    if (v.startsWith('eq.')) { if (String(row[k]) !== v.slice(3)) return false; continue; }
    if (v.startsWith('in.(')) {
      const list = v.slice(4, -1).split(',').map(x => x.replace(/^"|"$/g, ''));
      if (!list.includes(String(row[k]))) return false;
      continue;
    }
    throw new Error(`harness: unsupported filter ${k}=${v}`);
  }
  return true;
}

function response(status, body, headers = {}) {
  const text = body == null ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text || 'null'),
    headers: { get: name => headers[name.toLowerCase()] ?? null }
  };
}

// options:
//   rows:    initial watchlist_items rows (the fake database)
//   tmdb:    path => response body for TMDB requests (default: 404)
//   width:   window.innerWidth (default 1200)
//   countOverride: total reported in Content-Range (simulates a count mismatch)
//   tvShows: tv_shows rows; when given, the fake database has the TV-show schema
//            (backup format 2), otherwise tv_shows doesn't exist (format 1)
async function createApp({ rows = [], othertvShows = [], tvShows = null, customCollections = [], tmdb, width = 1200, countOverride = null } = {}) {
  const store = { watchlist_items: clone(rows), othertv_shows: clone(othertvShows), custom_collections: clone(customCollections) };
  if (tvShows) store.tv_shows = clone(tvShows);
  const requests = [];
  const gates = [];
  const failures = [];
  const consoleErrors = [];
  const selectors = {};
  let nextId = 1;
  const app = { store, requests, selectors, consoleErrors, countOverride };

  // ── fake DOM ──
  const registry = new Map();
  const children = new Map(); // container id -> ids created by its last innerHTML
  function makeEl(id) {
    const classes = new Set();
    let html = '';
    const el = {
      id, tagName: 'DIV', value: '', textContent: '', style: {}, dataset: {}, options: [],
      classList: {
        add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: c => (classes.has(c) ? classes.delete(c) : classes.add(c))
      },
      scrollIntoView() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      remove() {}, appendChild() {}, insertAdjacentElement() {},
      get innerHTML() { return html; },
      set innerHTML(v) {
        html = v;
        if (!id) return;
        // Replacing a container's markup drops the elements it held and creates the ones it now holds.
        (children.get(id) || []).forEach(c => registry.delete(c));
        const ids = [...String(v).matchAll(/id="([^"]+)"/g)].map(m => m[1]);
        ids.forEach(c => registry.set(c, makeEl(c)));
        children.set(id, ids);
      }
    };
    return el;
  }
  PAGE_IDS.forEach(id => registry.set(id, makeEl(id)));
  const document = {
    getElementById: id => registry.get(id) || null,
    querySelectorAll: sel => selectors[sel] || [],
    querySelector: () => null,
    createElement: () => makeEl(null),
    addEventListener() {}
  };
  app.el = id => registry.get(id) || null;
  app.addEl = (id, props = {}) => { const e = Object.assign(makeEl(id), props); registry.set(id, e); return e; };
  app.removeEl = id => registry.delete(id);

  // ── fake network ──
  // hold(pred) pauses the first matching request until release()/fail() is called.
  app.hold = pred => {
    const g = { pred, hit: false };
    g.gate = new Promise(r => { g.release = () => r('ok'); g.fail = () => r('fail'); });
    g.reached = new Promise(r => { g.onHit = r; });
    gates.push(g);
    return g;
  };
  // failNext(pred) makes the next matching request return HTTP 500.
  app.failNext = pred => failures.push(pred);
  // Database functions called as POST rpc/<name>. restore_backup replaces every
  // table with the backup's rows in one step, as the real function does.
  app.rpcHandlers = {
    restore_backup: body => {
      const tables = body.p_backup.tables;
      for (const t of Object.keys(tables)) store[t] = clone(tables[t]);
      return response(200, { restored: Object.fromEntries(Object.keys(tables).map(t => [t, tables[t].length])) });
    }
  };

  async function fetchStub(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    const req = { method, url, body, headers: opts.headers || {} };
    requests.push(req);
    const g = gates.find(x => !x.hit && x.pred(req));
    let forceFail = false;
    if (g) { g.hit = true; g.onHit(req); forceFail = (await g.gate) === 'fail'; }
    const fi = failures.findIndex(p => p(req));
    if (fi !== -1) { failures.splice(fi, 1); forceFail = true; }
    if (forceFail) return response(500, { message: 'simulated failure' });

    const TMDB_BASE = vm.runInContext('TMDB_BASE', ctx), SUPABASE_URL = vm.runInContext('SUPABASE_URL', ctx);
    if (url.startsWith(TMDB_BASE)) {
      const p = url.slice(TMDB_BASE.length);
      const out = tmdb ? tmdb(p) : undefined;
      return out === undefined ? response(404, { status_message: 'not found' }) : response(200, out);
    }
    const prefix = `${SUPABASE_URL}/rest/v1/`;
    if (!url.startsWith(prefix)) throw new Error(`harness: refused request to ${url}`);
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    const params = [...u.searchParams.entries()];
    if (u.pathname.includes('/rpc/')) {
      const handler = app.rpcHandlers[table];
      if (!handler) throw new Error(`harness: unknown rpc ${table}`);
      return handler(body);
    }
    const rowsOf = store[table];
    // Like PostgREST: a table that doesn't exist answers 404 PGRST205.
    if (!rowsOf) return response(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });

    if (method === 'GET') {
      let found = rowsOf.filter(r => matches(r, params));
      const select = u.searchParams.get('select');
      if (select && select !== '*' && select !== 'id') {
        const cols = select.split(',');
        found = found.map(r => Object.fromEntries(cols.map(c => [c, r[c] === undefined ? null : r[c]])));
      }
      const limit = Number(u.searchParams.get('limit'));
      if (limit) found = found.slice(0, limit);
      const range = req.headers.Range;
      if (range) {
        found = found.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const [from, to] = range.split('-').map(Number);
        const page = found.slice(from, to + 1);
        const total = app.countOverride ?? found.length;
        const cr = page.length ? `${from}-${from + page.length - 1}/${total}` : `*/${total}`;
        return response(206, clone(page), { 'content-range': cr });
      }
      return response(200, clone(found));
    }
    if (method === 'POST') {
      const inserted = body.map(r => ({ id: `new-${nextId++}`, ...r }));
      rowsOf.push(...clone(inserted));
      return response(201, inserted);
    }
    if (method === 'PATCH') {
      rowsOf.filter(r => matches(r, params)).forEach(r => Object.assign(r, clone(body)));
      return response(204, null);
    }
    if (method === 'DELETE') {
      store[table] = rowsOf.filter(r => !matches(r, params));
      return response(204, null);
    }
    throw new Error(`harness: unsupported ${method}`);
  }

  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => consoleErrors.push(a.map(String).join(' ')) },
    document,
    fetch: fetchStub,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    confirm: () => true,
    alert() {},
    setTimeout: () => 0,
    innerWidth: width,
    matchMedia: () => ({ matches: false })
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of SCRIPT_FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  app.ctx = ctx;
  app.get = expr => vm.runInContext(expr, ctx);
  app.run = code => vm.runInContext(code, ctx);
  vm.runInContext(INLINE_SCRIPT, ctx, { filename: 'watchlist.html' }); // state + boot
  await settle();

  app.writes = () => requests.filter(r => r.method !== 'GET');
  app.html = () => registry.get('tbody').innerHTML + '\n' + registry.get('cardList').innerHTML;
  return app;
}

// A small test runner that reports "N/N passed" like the other test files.
function runner(title) {
  const tests = [];
  const unhandled = [];
  process.on('unhandledRejection', e => unhandled.push(e));
  return {
    test: (name, fn) => tests.push({ name, fn }),
    async run() {
      let passed = 0;
      for (const t of tests) {
        unhandled.length = 0;
        try {
          await t.fn();
          await settle();
          if (unhandled.length) throw unhandled[0];
          passed++;
          console.log(`  ok   ${t.name}`);
        } catch (e) {
          console.log(`  FAIL ${t.name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e}`);
        }
      }
      console.log(`${title}: ${passed}/${tests.length} passed`);
      if (passed !== tests.length) process.exitCode = 1;
    }
  };
}

module.exports = { createApp, runner, settle, clone };
