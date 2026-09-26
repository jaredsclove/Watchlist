// Offline test for toggleMorePopover() in render.js: the "⋯" button must open the
// popover in its own table cell or mobile card, even though each movie row renders
// the popover twice with the same id.
// Run from the repo root: node tests/row-popover.test.js
// Node has no DOM, so a minimal stand-in models just what the handler uses
// (closest, querySelector, getElementById, querySelectorAll, style.display).
// The live desktop/mobile check is done separately in a browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Build: for each row, a desktop table cell and a mobile card, each holding a
// button and a popover. Desktop copies come first in the document, as in the page.
function buildPage(rowIds) {
  const all = [];
  const make = (rowId, where) => {
    const container = { className: where === 'desktop' ? 'more-cell' : 'card-top' };
    const popover = { id: `more-popover-${rowId}`, where, rowId, style: { display: 'none' } };
    container.querySelector = sel => (sel === '.more-popover' ? popover : null);
    const btn = { where, rowId, closest: sel => (sel === '.more-cell, .card-top' ? container : null) };
    all.push(popover);
    return { btn, popover };
  };
  const desktop = rowIds.map(id => make(id, 'desktop'));
  const mobile = rowIds.map(id => make(id, 'mobile'));
  const document = {
    getElementById: id => all.find(p => p.id === id) || null, // first in document order, like a browser
    querySelectorAll: sel => (sel === '.more-popover' ? all : []),
    addEventListener() {},
  };
  return { document, desktop, mobile, all };
}

function load(document) {
  const ctx = { document };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'render.js'), 'utf8'), ctx);
  return ctx.toggleMorePopover;
}
const open = all => all.filter(p => p.style.display === 'block').map(p => `${p.where}:${p.rowId}`);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('mobile: tapping ⋯ opens the popover in that card, not the hidden desktop copy', () => {
  const page = buildPage(['a', 'b']);
  const toggle = load(page.document);
  toggle('b', page.mobile[1].btn);
  assert.deepStrictEqual(open(page.all), ['mobile:b']);
});
test('desktop: tapping ⋯ opens the popover in that table cell', () => {
  const page = buildPage(['a', 'b']);
  const toggle = load(page.document);
  toggle('a', page.desktop[0].btn);
  assert.deepStrictEqual(open(page.all), ['desktop:a']);
});
test('tapping the same ⋯ again closes it, repeatedly', () => {
  const page = buildPage(['a']);
  const toggle = load(page.document);
  for (let i = 0; i < 3; i++) {
    toggle('a', page.mobile[0].btn);
    assert.deepStrictEqual(open(page.all), ['mobile:a']);
    toggle('a', page.mobile[0].btn);
    assert.deepStrictEqual(open(page.all), []);
  }
});
test('opening another row closes the first; only one popover is ever open', () => {
  const page = buildPage(['a', 'b', 'c']);
  const toggle = load(page.document);
  toggle('a', page.mobile[0].btn);
  toggle('c', page.mobile[2].btn);
  assert.deepStrictEqual(open(page.all), ['mobile:c']);
});
test('without a button it falls back to the id lookup (previous behavior)', () => {
  const page = buildPage(['a']);
  const toggle = load(page.document);
  toggle('a');
  assert.deepStrictEqual(open(page.all), ['desktop:a']);
});

let passed = 0;
for (const t of tests) {
  try { t.fn(); passed++; console.log('PASS', t.name); }
  catch (e) { console.log('FAIL', t.name, '\n ', e.message); }
}
console.log(`${passed}/${tests.length} passed`);
process.exit(passed === tests.length ? 0 : 1);
