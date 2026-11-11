// Genre colour families (ui-helpers.js GENRE_FAMILIES, styles.css --chip-g-*): the mapping and its aliases, the same family
// wherever a genre pill is drawn (TV and film rows, games), and the text contrast on each pill as rendered: its background
// composited over the page's surfaces (rows, row hover, cards), plain, hovered (the .badge-clickable filter) and pressed,
// in the dark and light themes. Offline; nothing is sent.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('genre-colors');
const test = T.test;
const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

// ── The mapping ──
const EXPECTED = {
  rust: ['Action', 'Adventure', 'Shooter', 'Fighting', 'Platform', 'Hack and slash/Beat \'em up', 'Arcade', 'Action & Adventure'],
  violet: ['Science Fiction', 'Fantasy', 'Role-playing (RPG)', 'Sci-Fi & Fantasy'],
  rose: ['Comedy', 'Romance', 'Family', 'Kids'],
  slate: ['Drama', 'Crime', 'Mystery', 'Thriller', 'Horror', 'Point-and-click', 'Visual Novel'],
  sage: ['Puzzle', 'Strategy', 'Real Time Strategy (RTS)', 'Turn-based strategy (TBS)', 'Tactical', 'Simulator', 'Card & Board Game', 'Quiz/Trivia', 'MOBA'],
  sky: ['Sport', 'Racing', 'Music', 'Musical', 'Pinball'],
  other: ['History', 'War', 'Western', 'Politics', 'War & Politics', 'Indie', 'Something New', '']
};

test('every TV and film genre, IGDB’s genres and TMDB’s combined categories map to their family; History, War, Western, Politics and unknown labels stay gray', async () => {
  const app = await createApp({});
  const fam = l => app.ctx.genreFamily(l);
  for (const [family, labels] of Object.entries(EXPECTED)) for (const l of labels) assert.strictEqual(fam(l), family, `${l} → ${family}`);
  // Every label of the controlled TV / film list has a deliberate place in the table above.
  const listed = new Set(Object.values(EXPECTED).flat());
  for (const g of app.get('GENRES')) assert.ok(listed.has(g), `${g} is accounted for`);
});

test('aliases and spellings are one genre: case, "&" / "and", punctuation and brackets don’t matter; no spelling is in two families', async () => {
  const app = await createApp({});
  const fam = l => app.ctx.genreFamily(l);
  for (const l of ['RPG', 'Role-playing', 'role playing (rpg)', 'ROLE-PLAYING GAME']) assert.strictEqual(fam(l), 'violet', l);
  for (const l of ['Sci-Fi', 'sci-fi', 'Science fiction', 'Sci-Fi and Fantasy']) assert.strictEqual(fam(l), 'violet', l);
  for (const l of ['Sports', 'sport']) assert.strictEqual(fam(l), 'sky', l);
  for (const l of ['Simulation', 'Real-time strategy', 'RTS', 'TBS', 'Card and board game']) assert.strictEqual(fam(l), 'sage', l);
  for (const l of ['Action and Adventure', 'Beat \'em up', 'Hack and slash']) assert.strictEqual(fam(l), 'rust', l);
  const seen = new Map();
  for (const [family, labels] of Object.entries(app.get('GENRE_FAMILIES'))) for (const l of labels) {
    const k = app.ctx.genreKey(l);
    assert.ok(!seen.has(k) || seen.get(k) === family, `"${l}" is in ${seen.get(k)} and ${family}`);
    seen.set(k, family);
  }
});

test('the same genre has the same family class on a TV or film row and on a game; other kinds of pill keep their own look', async () => {
  const app = await createApp({});
  const tv = app.ctx.metadataChipsHtml({ genres: ['Adventure', 'Music', 'History'], forms: ['Docuseries'], franchises: ['ZZ Saga'], network: 'Network A' }, 'show-1');
  const game = app.ctx.gameGenrePillsHtml({ genres: ['Adventure', 'Music', 'History'], entry: { id: 'game-1' } });
  const plain = app.ctx.gameGenrePillsHtml({ genres: ['Adventure', 'Music', 'History'], entry: { id: 'game-1' } }, 0, true);
  const classes = html => [...html.matchAll(/class="badge meta-chip meta-genres (g-\w+)/g)].map(m => m[1]);
  assert.deepStrictEqual(classes(tv), ['g-rust', 'g-sky', 'g-other']);
  assert.deepStrictEqual(classes(game), ['g-rust', 'g-sky', 'g-other']);
  assert.deepStrictEqual(classes(plain), ['g-rust', 'g-sky', 'g-other'], 'a collection’s plain labels too');
  // (a pill is a button where its filter control is on the page, else a label: the look is the same)
  assert.match(tv, /class="badge meta-chip meta-forms[ "]/, 'a form keeps its teal');
  assert.match(tv, /class="badge meta-chip meta-franchises[ "]/, 'a franchise keeps its amber');
  assert.match(tv, /class="badge meta-chip meta-network[^"]*" style="background:/, 'a network keeps its own colour');
  assert.doesNotMatch(tv, /meta-(forms|franchises|network)[^"]* g-/, 'only genres take a family');
  void settle;
});

// ── Contrast as rendered ──
const hexRgba = h => { const x = h.replace('#', ''); const n = x.length === 3 || x.length === 4 ? x.split('').map(c => c + c).join('') : x;
  return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16)).concat(n.length === 8 ? parseInt(n.slice(6, 8), 16) / 255 : 1); };
const over = (fg, bg) => fg.slice(0, 3).map((v, i) => Math.round(v * fg[3] + bg[i] * (1 - fg[3])));
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const clamp = v => Math.max(0, Math.min(255, v));
// CSS filter functions on a colour (W3C Filter Effects): brightness multiplies; saturate is its matrix.
const brightness = (c, b) => c.map(v => clamp(v * b));
const saturate = (c, s) => { const [r, g, b] = c;
  return [clamp((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b),
    clamp((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b),
    clamp((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b)]; };
// The tokens of a theme: the dark ones are on :root; the light ones override them under prefers-color-scheme: light.
function tokens(theme) {
  const out = {};
  const blocks = [...CSS.matchAll(/(@media \(prefers-color-scheme: light\) \{\s*)?:root \{([^}]*)\}/g)];
  const take = body => { for (const [, k, v] of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\b/g)) out[k] = v; };
  blocks.filter(b => !b[1]).forEach(b => take(b[2]));
  if (theme === 'light') blocks.filter(b => b[1]).forEach(b => take(b[2]));
  return out;
}

test('every family’s text reads at 4.5:1 or more on its rendered pill over rows, row hover and cards, plain, hovered and pressed, in both themes', async () => {
  const families = ['rust', 'violet', 'rose', 'slate', 'sage', 'sky'];
  assert.ok(families.every(f => new RegExp(`\\.meta-chip\\.meta-genres\\.g-${f} \\{ background: var\\(--chip-g-${f}-bg\\); color: var\\(--chip-g-${f}-fg\\)`).test(CSS)), 'a rule per family');
  // The hover filters, as styles.css sets them on .badge-clickable.
  assert.match(CSS, /\.badge-clickable:hover \{ filter: brightness\(1\.35\); \}/);
  assert.match(CSS, /\.badge-clickable:hover \{ filter: brightness\(0\.92\) saturate\(1\.15\); \}/);
  const hover = { dark: c => brightness(c, 1.35), light: c => saturate(brightness(c, 0.92), 1.15) };
  const report = [];
  for (const theme of ['dark', 'light']) {
    const t = tokens(theme);
    const surfaces = ['--bg', '--surface', '--surface2'].map(k => { assert.ok(t[k], `${theme} ${k}`); return hexRgba(t[k]); }); // rows, row hover / cards, raised
    for (const f of families.concat('genre')) {
      const pre = f === 'genre' ? '--chip-genre' : `--chip-g-${f}`;
      assert.ok(t[`${pre}-bg`] && t[`${pre}-fg`], `${theme} ${f} tokens`);
      let worst = Infinity;
      for (const s of surfaces) {
        const bg = over(hexRgba(t[`${pre}-bg`]), s), fg = over(hexRgba(t[`${pre}-fg`]), bg);
        // plain and pressed (the ring is outside the pill; the colours are the same), then hovered (and hovered while pressed)
        for (const [state, a, b] of [['plain', fg, bg], ['hover', hover[theme](fg), hover[theme](bg)]]) {
          const r = contrast(a, b);
          worst = Math.min(worst, r);
          assert.ok(r >= 4.5, `${theme} ${f} ${state} over ${t[['--bg', '--surface', '--surface2'][surfaces.indexOf(s)]]}: ${r.toFixed(2)}:1`);
        }
      }
      report.push(`${theme} ${f} ${worst.toFixed(2)}`);
    }
  }
  console.log(`       worst contrast: ${report.join(', ')}`);
});

T.run();
