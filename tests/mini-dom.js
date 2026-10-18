// Offline test helper (not a suite): a small test-only DOM for focus across real redraws, moved
// unchanged from tests/presentation.test.js (S3), so other suites use the same model.
'use strict';
const assert = require('assert');

// The harness's DOM has no element tree or focus. This small test-only DOM parses the
// list containers' rendered markup (re-parsed only when it changes, so elements keep their
// identity between redraws) and gives elements closest / matches / querySelector(All) /
// getAttribute / focus / events / getClientRects, enough to run the page's own capture →
// redraw → focus code. It is not a browser: no layout, no real keyboard or pointer.
const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);
function parseSel(sel) {
  return sel.split(',').map(alt => alt.trim().split(/\s+(?![^\[]*\])/).map(part => {
    const s = { tag: null, id: null, cls: [], attrs: [] };
    const re = /^([a-zA-Z][a-zA-Z0-9]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=("(?:[^"\\]|\\.)*"))?\]/g;
    let m;
    while ((m = re.exec(part))) {
      if (m[1]) s.tag = m[1].toLowerCase(); else if (m[2]) s.id = m[2]; else if (m[3]) s.cls.push(m[3]);
      else s.attrs.push([m[4], m[5] === undefined ? undefined : JSON.parse(m[5])]);
    }
    return s;
  }));
}
function makeMiniDom(app) {
  const doc = app.ctx.document;
  // Document- and window-level listeners (the page's focus-placement tracking uses them), and
  // focusin on every focus, as a browser sends them.
  const docL = {}, winL = {};
  doc.addEventListener = (t, f) => { (docL[t] = docL[t] || []).push(f); };
  doc.removeEventListener = (t, f) => { docL[t] = (docL[t] || []).filter(x => x !== f); };
  app.ctx.addEventListener = (t, f) => { (winL[t] = winL[t] || []).push(f); };
  app.ctx.removeEventListener = (t, f) => { winL[t] = (winL[t] || []).filter(x => x !== f); };
  doc.defaultView = app.ctx;
  let pageHasFocus = true;
  doc.hasFocus = () => pageHasFocus;
  const docEvent = (type, target) => (docL[type] || []).slice().forEach(f => f({ type, target }));
  const unesc = v => v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  function node(tag, attrs, parent, root) {
    const n = { tagName: tag.toUpperCase(), tag, attrs, parent, root, children: [], listeners: {} };
    n.getAttribute = a => (a in n.attrs ? n.attrs[a] : null);
    n.matchesSimple = s => (!s.tag || s.tag === n.tag) && (!s.id || n.attrs.id === s.id)
      && s.cls.every(c => (n.attrs.class || '').split(/\s+/).includes(c))
      && s.attrs.every(([a, v]) => a in n.attrs && (v === undefined || n.attrs[a] === v));
    n.matchesChain = chain => {
      if (!n.matchesSimple(chain[chain.length - 1])) return false;
      let i = chain.length - 2, p = n.parent;
      while (i >= 0 && p) { if (p.matchesSimple(chain[i])) i--; p = p.parent; }
      return i < 0;
    };
    n.matches = sel => parseSel(sel).some(ch => n.matchesChain(ch));
    n.closest = sel => { const alts = parseSel(sel); for (let p = n; p; p = p.parent) if (alts.some(ch => p.matchesChain(ch))) return p; return null; };
    const all = () => { const out = []; const walk = x => x.children.forEach(c => { out.push(c); walk(c); }); walk(n); return out; };
    n.querySelectorAll = sel => { const alts = parseSel(sel); return all().filter(x => alts.some(ch => x.matchesChain(ch))); };
    n.querySelector = sel => n.querySelectorAll(sel)[0] || null;
    n.focus = () => { doc.activeElement = n; docEvent('focusin', n); };
    n.ownerDocument = doc;
    Object.defineProperty(n, 'isConnected', { get: () => ['tbody', 'cardList'].some(id => cache[id] && cache[id].root === n.root) || n.root === n });
    n.getClientRects = () => (n.root.hidden ? [] : [{}]);
    n.addEventListener = (t, f) => { (n.listeners[t] = n.listeners[t] || []).push(f); };
    n.removeEventListener = (t, f) => { n.listeners[t] = (n.listeners[t] || []).filter(x => x !== f); };
    // An event on an element also reaches the document's capturing listeners, as in a browser.
    n.dispatch = t => { docEvent(t, n); (n.listeners[t] || []).slice().forEach(f => f({ type: t, target: n })); };
    return n;
  }
  const cache = {};
  function tree(id) {
    const el = app.el(id), html = el.innerHTML;
    if (cache[id] && cache[id].html === html) return cache[id].root;
    const root = node('div', { id }, null, null); root.root = root; root.hidden = !!(cache[id] && cache[id].root.hidden);
    let cur = root;
    for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)((?:[^>"]|"[^"]*")*)>/g)) {
      const [, close, tagRaw, rest] = m; const tag = tagRaw.toLowerCase();
      if (close) { let p = cur; while (p && p.tag !== tag) p = p.parent; if (p && p.parent) cur = p.parent; continue; }
      const attrs = {};
      for (const a of rest.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : unesc(a[2]);
      const n = node(tag, attrs, cur, root); cur.children.push(n);
      if (!VOID.has(tag) && !/\/\s*$/.test(rest)) cur = n;
    }
    cache[id] = { html, root };
    return root;
  }
  for (const id of ['tbody', 'cardList']) {
    const el = app.el(id);
    el.querySelector = sel => tree(id).querySelector(sel);
    el.querySelectorAll = sel => tree(id).querySelectorAll(sel);
    el.getClientRects = () => (tree(id).hidden ? [] : [{}]);
  }
  return {
    in: (id, sel) => tree(id).querySelector(sel),
    hide: (id, hidden = true) => { tree(id).hidden = hidden; },
    focus: (id, sel) => { const n = tree(id).querySelector(sel); assert.ok(n, `no ${sel} in ${id}`); n.focus(); return n; },
    active: () => doc.activeElement,
    outside: () => { const n = node('input', { id: 'fSearch' }, null, null); n.root = n; n.focus(); return n; },
    // What Chrome does when the focused element's layout becomes hidden: focus falls to the
    // page (no focusin anywhere, no user event).
    blurToBody: () => { doc.activeElement = null; },
    docEvent,
    winEvent: type => { if (type === 'blur') pageHasFocus = false; if (type === 'focus') pageHasFocus = true; (winL[type] || []).slice().forEach(f => f({ type })); },
    listenerCount: () => Object.values(docL).reduce((n, l) => n + l.length, 0) + Object.values(winL).reduce((n, l) => n + l.length, 0)
  };
}

module.exports = { makeMiniDom, parseSel, VOID };
