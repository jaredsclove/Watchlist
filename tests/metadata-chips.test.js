// Offline tests for the category chips' colours (render.js metadataChipsHtml, ui-helpers.js
// networkChipStyle, styles.css): every chip has explicit colours by kind instead of the
// browser's default button face; network chips keep their network's hue with readable text.
// Run from the repo root: node tests/metadata-chips.test.js
// No network, no database. Computed colours at real widths are checked in a browser, not here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('metadata-chips');
const test = T.test;
const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'watchlist.html'), 'utf8');

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
function show(o, seasons = 2) {
  const s = { id: nid('show'), collection: 'othertv', title: 'Show', show_key: (o.title || 'show').toLowerCase(), tmdb_id: 500 + n, status: 'watching', ...o };
  const rows = Array.from({ length: seasons }, (_, i) => ({
    id: nid('r'), collection: s.collection, title: s.title, theme: o.theme || 'HBO', status: 'pending', watched: i === 0, skipped: false,
    show_id: s.id, media_type: 'tv', tmdb_id: s.tmdb_id, season_number: i + 1, season: `Season ${i + 1}`,
    display_date: 'Jan 1, 2020', date_sort: i === 0 ? day(-300) : day(-3), item_key: `${s.show_key}|season ${i + 1}`, watch_with: [], collections: []
  }));
  return { show: s, rows };
}
const meta = (genres, forms, franchises, network) => ({ genres, forms, franchises, network, metadata_owner_set: true });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows), tvShows: xs.map(x => x.show) });
const library = () => all(
  show({ title: 'Alpha', ...meta(['Drama', 'Comedy', 'Mystery'], ['Limited series'], ['Some Universe'], 'HBO') }),
  show({ title: 'Bravo', ...meta(['Crime'], [], [], 'Unknown Network Co') }),
  show({ title: 'Charlie' }) // no categories, Details never saved: the original label
);
const chipsOf = (markup, id) => {
  const row = markup.split('data-item="').find(p => p.startsWith(id));
  return [...(row || '').matchAll(/<(button|span)\b[^>]*?class="(badge meta-chip meta-(\w+)|meta-more)[^"]*"([^>]*)>([^<]*)</g)]
    .map(m => ({ tag: m[1], kind: m[3] || 'more', attrs: m[4], text: m[5] }));
};

// ─── Independent contrast arithmetic (not the app's helpers) ──────────────────
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (fg, a, bg) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
const SURF = { dark: ['#0d0f14', '#161a23', '#1e2330'], light: ['#f5f6f8', '#ffffff'] };
function styleContrast(style, mode) {
  const bg = style.match(/background:(#[0-9a-f]{6})([0-9a-f]{2})/), fg = style.match(/color:(#[0-9a-f]{6})/);
  assert.ok(bg && fg, `parsable style: ${style}`);
  const a = parseInt(bg[2], 16) / 255;
  return Math.min(...SURF[mode].map(s => ratio(rgb(fg[1]), over(rgb(bg[1]), a, rgb(s)))));
}

test('styles: every rendered kind has explicit background, text and border colours, not limited to buttons', () => {
  for (const [sel, pre] of [['.meta-chip', 'chip'], ['.meta-chip.meta-forms', 'chip-form'], ['.meta-chip.meta-franchises', 'chip-fr']]) {
    const rule = css.match(new RegExp(sel.replace(/\./g, '\\.') + ' \\{ background[^}]*\\}'));
    assert.ok(rule, `${sel} has a colour rule`);
    for (const p of ['background', 'color', 'border-color']) assert.ok(new RegExp(`${p}: var\\(--${pre}-(bg|fg|border)\\)`).test(rule[0]), `${sel} ${p}`);
    assert.ok(!/button/.test(rule[0]), 'applies to button and text chips alike');
  }
  const vars = ['--chip-bg', '--chip-fg', '--chip-border', '--chip-form-bg', '--chip-form-fg', '--chip-form-border', '--chip-fr-bg', '--chip-fr-fg', '--chip-fr-border'];
  const blocks = [...css.matchAll(/:root \{([^}]*--chip-bg[^}]*)\}/g)].map(m => m[1]);
  assert.strictEqual(blocks.length, 2, 'a dark default and a light-scheme override');
  for (const b of blocks) for (const v of vars) assert.ok(b.includes(v + ':'), `${v} defined`);
  assert.ok(/@media \(prefers-color-scheme: light\) \{\s*:root \{[^}]*--chip-bg/.test(css), 'the override is the light scheme');
  assert.ok(/\.meta-more \{[^}]*color: var\(--text2\)/.test(css), '"+N" uses the readable secondary text colour');
});

test('per-kind palette: text reads at 4.5:1 or more on its chip in both schemes', () => {
  const blocks = [...css.matchAll(/:root \{([^}]*--chip-bg[^}]*)\}/g)].map(m => m[1]);
  assert.strictEqual(blocks.length, 2, 'both schemes define the palette');
  for (const b of blocks) {
    const v = name => b.match(new RegExp(`${name}: (#[0-9a-f]{6})`))[1];
    for (const k of ['chip', 'chip-form', 'chip-fr']) assert.ok(ratio(rgb(v(`--${k}-fg`)), rgb(v(`--${k}-bg`))) >= 4.5, k);
  }
});

test('network chips: an inline style from the network colour (known or hashed) with text at 4.5:1 or more, both schemes', async () => {
  const app = await createApp({ rows: [], tvShows: [] });
  const ctx = app.ctx;
  const config = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  const known = [...config.slice(config.indexOf('const NETWORK_COLORS'), config.indexOf('const UNIVERSE_LISTS')).matchAll(/'([^']+)':\s*'#/g)].map(m => m[1]);
  assert.ok(known.length >= 40, 'every NETWORK_COLORS entry');
  const names = [...known, 'Unknown Network Co', 'Some Streamer', 'Channel 4', 'PV Unknown Network', 'X'];
  for (const mode of ['dark', 'light']) {
    ctx.matchMedia = () => ({ matches: mode === 'light' });
    for (const name of names) {
      const style = ctx.networkChipStyle(name);
      const color = ctx.networkColor(name);
      assert.ok(style.startsWith(`style="background:${color}${mode === 'light' ? '1a' : '22'}; color:#`), `${name} keeps its hue (${mode})`);
      assert.ok(style.endsWith(`border-color:${color}${mode === 'light' ? '66' : '55'}"`), `${name} border (${mode})`);
      assert.ok(styleContrast(style, mode) >= 4.5, `${name} ${mode}: ${styleContrast(style, mode).toFixed(2)}`);
    }
  }
  // The original-label badge style is unchanged.
  ctx.matchMedia = () => ({ matches: false });
  assert.strictEqual(ctx.networkBadgeStyle('HBO'), 'style="background:#8b5cf622; color:#8b5cf6; border-color:#8b5cf655"');
});

test('rendering: labels, order and the "+N" marker unchanged; only the network chip carries a style; the original label stays a fallback', async () => {
  const lib = library();
  const app = await createApp(lib);
  await settle();
  const alpha = chipsOf(app.html(), lib.tvShows[0].id);
  assert.deepStrictEqual(alpha.map(c => `${c.kind}:${c.text}`),
    ['genres:Drama', 'genres:Comedy', 'more:+1', 'forms:Limited series', 'franchises:Some Universe', 'network:HBO']);
  for (const c of alpha) {
    if (c.kind === 'network') assert.ok(/style="background:#8b5cf622; color:#[0-9a-f]{6}; border-color:#8b5cf655"/.test(c.attrs), 'HBO style');
    else assert.ok(!/style=/.test(c.attrs), `${c.kind} has no inline style`);
  }
  assert.ok(alpha.filter(c => c.kind !== 'more').every(c => c.tag === 'button'), 'clickable where the view has the filter');
  const bravo = chipsOf(app.html(), lib.tvShows[1].id);
  const unknown = bravo.find(c => c.kind === 'network');
  assert.ok(unknown && new RegExp(`background:${app.ctx.networkColor('Unknown Network Co')}22`).test(unknown.attrs), 'an unknown network gets its hashed colour');
  const charlie = app.html().split('data-item="').find(p => p.startsWith(lib.tvShows[2].id));
  assert.ok(!/meta-chip/.test(charlie) && /badge badge-clickable filter-pill" style="background:/.test(charlie), 'no categories: the original-label badge, its old style');
  // Details saved with every category empty: nothing (unchanged rule).
  assert.strictEqual(app.ctx.metadataChipsHtml({ genres: [], forms: [], franchises: [], companies: [], network: null, metadata_owner_set: true }, 'x', 'FALLBACK'), '');
  assert.strictEqual(app.ctx.metadataChipsHtml({ genres: [], forms: [], franchises: [], companies: [], network: null, metadata_owner_set: false }, 'x', 'FALLBACK'), 'FALLBACK');
});

test('text chips (no filter control in the view) keep the same classes and network style', async () => {
  const app = await createApp(library());
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(app.ctx.document.getElementById('fNetwork'), null, 'All Movies has no network filter');
  const out = app.ctx.metadataChipsHtml(meta(['Drama'], [], [], 'HBO'), 'x');
  assert.ok(/<span class="badge meta-chip meta-network" style="background:#8b5cf622; color:#[0-9a-f]{6}; border-color:#8b5cf655">HBO<\/span>/.test(out), out);
  assert.ok(/<button type="button" class="badge meta-chip meta-genres badge-clickable filter-pill"/.test(out), 'genre stays a filter pill');
});

test('filtering: a network chip toggles its filter, shows the pressed state and keeps its colours', async () => {
  const lib = library();
  const app = await createApp(lib);
  await settle();
  const before = app.html();
  app.ctx.toggleFilterSelect('fNetwork', 'HBO'); await settle();
  assert.strictEqual(app.el('fNetwork').value, 'HBO');
  const pressed = chipsOf(app.html(), lib.tvShows[0].id).find(c => c.kind === 'network');
  assert.ok(/aria-pressed="true"/.test(pressed.attrs) && /style="background:#8b5cf622/.test(pressed.attrs), 'pressed, same colours');
  app.ctx.toggleFilterSelect('fNetwork', 'HBO'); await settle();
  assert.strictEqual(app.el('fNetwork').value, '');
  assert.strictEqual(app.html(), before, 'clearing the filter restores the same markup');
  assert.deepStrictEqual(app.writes(), [], 'no write');
});

test('assets: one new token on every versioned file, ui-helpers.js now versioned, order unchanged', () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.deepStrictEqual(scripts.map(s => s.split('?')[0]), ['config.js', 'identity.js', 'api.js', 'ui-helpers.js', 'metadata.js', 'backup-restore.js',
    'backup-format3.js', 'tabs.js', 'render.js', 'row-actions.js', 'tmdb-search.js', 'collections-pull.js', 'universe-pull.js', 'person-pull.js',
    'refresh-shows.js', 'tmdb-match.js', 'derived-views.js', 'tv-shows.js', 'organization.js', 'organization-manage.js', 'catalog-apply.js',
    'browse-views.js', 'library.js']);
  const tokens = new Set([...html.matchAll(/\?v=([\w-]+)/g)].map(m => m[1]));
  assert.deepStrictEqual([...tokens], ['20261015-filters1']); // B10 bumped the token (tests/filter-bar.test.js)
  assert.ok(scripts.includes('ui-helpers.js?v=20261015-filters1'), 'render.js and its helper load together');
  assert.ok(scripts.includes('config.js') && scripts.includes('identity.js'), 'config.js and identity.js stay unversioned');
  assert.strictEqual([...html.matchAll(/(?:src|href)="[^"]+\?v=/g)].length, 22, 'styles.css + 21 scripts');
});

T.run();
