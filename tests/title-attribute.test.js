// Offline test: titles written into double-quoted HTML attributes with esc()
// (as the person/universe pull flows do for data-title) must come back exactly.
// Run from the repo root: node tests/title-attribute.test.js
// Node has no DOM, so this decodes only the four entities esc() emits. The live
// browser round-trip (dataset.title) is verified separately.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui-helpers.js'), 'utf8'), ctx);
const esc = ctx.esc;

// Inverse of esc() for the only references it produces (&amp; last, so "&amp;lt;" stays literal).
const decodeAttr = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

const titles = [
  "The Lost Chapter: Yuki's Revenge",
  'Someone’s Story',
  'Me & You',
  'He Said "Hello"',
  'Tom & Jerry\'s "Big" <Night>'
];

let failed = 0;
for (const t of titles) {
  try {
    const attr = esc(t);
    assert.ok(!attr.includes('\\'), 'no backslash added');
    assert.ok(!attr.includes('"'), 'no raw double quote that could end the attribute');
    assert.strictEqual(decodeAttr(attr), t, 'round-trips exactly');
    console.log('PASS', JSON.stringify(t), '->', attr);
  } catch (e) { failed++; console.log('FAIL', JSON.stringify(t), '-', e.message); }
}
console.log(`${titles.length - failed}/${titles.length} passed`);
process.exit(failed ? 1 : 0);
