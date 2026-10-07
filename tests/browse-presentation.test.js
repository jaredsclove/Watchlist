// Offline tests for a Browse collection's presentation (browse-views.js): TV
// presentation Shows / Seasons and grouping Separate / Combined, independent of
// All media / TV / Movies. Shows and Movies-only are A–Z; Seasons is oldest first
// for TV seasons and films (Combined interleaves them), with TBA and Date needs
// review apart; TV seasons narrows season entries only; counts keep shows,
// season entries and films apart; the layout is remembered per collection only
// when changed; everything stays read-only.
// Run from the repo root: node tests/browse-presentation.test.js
// No network, no database (see tests/app-harness.js).
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('browse-presentation');
const test = T.test;
// Browse views are personal collections (Stage 3b-1); the harness bootstraps the four with fixed ids.
const B = Object.fromEntries(['disney', 'sheridan', '90day', 'truecrime'].map((k, i) => [k, `browse:0c000000-0000-4000-8000-00000000000${i + 1}`]));

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
// A show (Disney+ by default) and its seasons: { label, date, display, w, s, title, id }.
function show(o, specs) {
  const s = { id: nid('show'), collection: 'disney', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: null, status: 'confirmed', ...o };
  const rows = specs.map(sp => ({
    id: sp.id || nid('r'), collection: s.collection, title: sp.title || s.title, theme: 'Drama', status: 'skipped',
    watched: !!sp.w, skipped: !!sp.s, show_id: s.id, media_type: null, tmdb_id: null, season_number: null,
    season: sp.label, display_date: sp.display || sp.date, date_sort: sp.date,
    item_key: `${s.show_key}|${sp.label.toLowerCase()}`, watch_with: [], collections: []
  }));
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'disney', title: 'Film', theme: 'Lucasfilm', status: 'confirmed', watched: false,
  media_type: null, tmdb_id: null, season_number: null, season: 'Film', display_date: o.date, date_sort: o.date,
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) });

// A Disney+ collection with every ordering case.
function library() {
  const cw = show({ title: 'Star Wars: The Clone Wars (2008)', show_key: 'star wars: the clone wars (2008)', status: 'watching' }, [
    { id: 'cw1', label: 'Season 1', date: '2008-10-03', w: true },
    { id: 'cw-legacy', label: 'Season 2', date: '2009-10-02', title: 'The Clone Wars' } // stored under another title
  ]);
  const andor = show({ title: 'Andor', status: 'confirmed' }, [
    { id: 'an1', label: 'Season 1', date: '2022-09-21', w: true, s: true }, // watched and skipped
    { id: 'an2', label: 'Season 2', date: '2025-04-22' },
    { id: 'an3', label: 'Season 3', date: '2027-06-01', display: 'TBA 2027' } // guessed date: TBA
  ]);
  const visions = show({ title: 'Star Wars: Visions', status: 'pending' }, [
    { id: 'v2', label: 'Volume 2', date: '2023-05-04' },
    { id: 'v1', label: 'Volume 1', date: '2023-05-04' }, // same date: season order decides
    { id: 'vs', label: 'Specials', date: '2023-05-04' }
  ]);
  const odd = show({ title: 'Bad Date Show', status: 'confirmed' }, [{ id: 'bd1', label: 'Season 1', date: '2024-13-40', display: 'Someday' }]);
  const skipped = show({ title: 'Wonder Man', status: 'skipped' }, [{ id: 'wm1', label: 'Season 1', date: '2026-01-27', w: true }]);
  return all(cw, andor, visions, odd, skipped,
    film({ id: 'f-cw', title: 'Star Wars: The Clone Wars (2008)', date: '2008-08-15', display: 'Aug 15, 2008', watched: true }),
    film({ id: 'a-same', title: 'Star Wars: The Clone Wars (2008)', date: '2008-10-03' }), // same date and title as cw1; its id sorts first
    film({ id: 'a-andor', title: 'Andor', date: '2022-09-21' }), // same date as an1: title ties, TV first despite the id
    film({ id: 'f-mando', title: 'The Mandalorian & Grogu', date: '2026-05-22' }),
    film({ id: 'f-ewoks', title: 'Ewoks', date: '1985-11-24', status: 'skipped' }),
    film({ id: 'f-tba', title: 'Untitled Film', date: '2099-01-01', display: 'TBA' }),
    film({ id: 'f-bad', title: 'Odd Film', date: '', display: 'Someday' }));
}

function memStore(initial = {}) {
  const data = { ...initial };
  const writes = [];
  return { data, writes, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { writes.push([k, v]); data[k] = String(v); }, removeItem: k => { delete data[k]; } };
}
async function boot(data = library(), opts = {}) {
  const app = await createApp({ rows: data.rows, tvShows: data.shows, ...opts });
  app.store_ = memStore(opts.stored || {});
  app.ctx.localStorage = app.store_;
  return app;
}
async function open(app, id = B['disney']) { app.ctx.openBrowseCollection(id); await settle(); }
const html = app => app.el('tbody').innerHTML;
const cards = app => app.el('cardList').innerHTML;
const filters = app => app.el('filtersRow').innerHTML;
const stats = app => [...app.el('statsRow').innerHTML.matchAll(/stat-num">(\d+)<\/div><div class="stat-label">([^<]*)</g)].map(m => `${m[1]} ${m[2]}`);
const setFilter = (app, id, value) => { app.el(id).value = value; app.ctx.renderTable(); };
// The listed entries in order: "title · season" for seasons, "title [film]", "title [show]", plus headers.
function listed(app) {
  const out = [];
  for (const m of html(app).matchAll(/<tr class="(year-group|browse-subsection-row|browse-section-row|browse-season-row[^"]*|browse-film-row[^"]*|show-group-row[^"]*|sub-row[^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const [cls, body] = [m[1], m[2]];
    const title = (body.match(/<span class="show-title">([^<]*)</) || [])[1];
    if (cls === 'year-group') out.push(`# ${body.replace(/<[^>]+>/g, '').trim()}`);
    else if (cls.startsWith('browse-subsection-row')) out.push(`> ${(body.match(/<\/span> ([^<]+) <span/) || [])[1]}`);
    else if (cls.startsWith('browse-section-row')) out.push(`== ${body.replace(/<[^>]+>/g, '').trim().split(' ')[0]}`);
    else if (cls.startsWith('browse-season-row')) out.push(`${title} · ${(body.match(/<span class="season-lbl"> · ([^<]*)</) || [])[1]}`);
    else if (cls.startsWith('browse-film-row')) out.push(`${title} [film]`);
    else if (cls.startsWith('show-group-row')) out.push(`${title} [show]`);
    else out.push(`  - ${(body.match(/<span class="season-lbl">([^<]*)</) || [])[1]}`);
  }
  return out;
}
const handlersIn = s => [...s.matchAll(/\bon(?:click|change|input|keydown)="([^"]*)"/g)]
  .flatMap(m => [...m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\(/g)].map(x => x[1])).filter(x => !['if', 'replace', 'stopPropagation'].includes(x));
const READ_ONLY = new Set(['toggleBrowseShow', 'setBrowseMedia', 'setBrowsePresentation', 'setBrowseGrouping', 'setBrowseSeasonVis', 'toggleBrowseSection',
  'renderTable', 'toggleFilters', 'browseBack', 'openBrowseCollection', 'loadBrowseView',
  'openManage']); // Stage 3b-2: opens the Manage collections dialog (organization only, never tracking)
const mutating = app => app.requests.filter(r => r.method !== 'GET' || /\/rpc\//.test(r.url) || !r.url.includes('/rest/v1/'));
const J = (app, expr) => JSON.parse(JSON.stringify(app.get(expr)));

// ─── Controls ─────────────────────────────────────────────────────────────────
test('first use is All media + Shows + Separate; Shows/Seasons hides with Movies only, Separate/Combined shows with All media only', async () => {
  const app = await boot();
  await open(app);
  assert.deepStrictEqual(J(app, '[browseMedia, browsePresentation, browseGrouping, browseSeasonVis]'), ['all', 'shows', 'separate', 'notskipped']);
  const inner = () => filters(app).indexOf('class="filters-inner"');
  const at = s => filters(app).indexOf(s);
  assert.ok(at('data-presentation="shows"') > -1 && at('data-presentation="shows"') < inner() && at('data-grouping="combined"') < inner(), 'outside the collapsible panel');
  assert.ok(/aria-label="TV presentation"/.test(filters(app)) && /aria-label="Grouping"/.test(filters(app)));
  assert.ok(!filters(app).includes('fSeasonVis'), 'TV seasons only in Seasons');
  app.ctx.setBrowseMedia('tv');
  assert.ok(at('data-presentation') > -1 && at('data-grouping') === -1);
  app.ctx.setBrowseMedia('movie');
  assert.ok(at('data-presentation') === -1 && at('data-grouping') === -1 && !filters(app).includes('fSeasonVis'));
  app.ctx.setBrowseMedia('all');
  app.ctx.setBrowsePresentation('seasons');
  assert.ok(at('id="fSeasonVis"') > inner(), 'TV seasons sits inside the panel');
  assert.deepStrictEqual([...filters(app).matchAll(/<option value="(\w+)"[^>]*>(TV seasons: [^<]*)</g)].map(m => m[2]),
    ['TV seasons: All (except Skipped)', 'TV seasons: All', 'TV seasons: To watch', 'TV seasons: Watched', 'TV seasons: Skipped']);
  assert.ok(filters(app).includes('<option value="notskipped" selected>TV seasons: All (except Skipped)'), 'the default is selected');
  assert.strictEqual(app.get('browseGrouping'), 'separate', 'kept while hidden');
});

test('the media, presentation and grouping controls sit in .browse-controls (larger phone targets there only); All TV’s toggle is not in it', async () => {
  const app = await boot();
  await open(app);
  const f = filters(app);
  const box = f.slice(f.indexOf('<div class="browse-controls">'), f.indexOf('class="filter-toggle-btn"'));
  for (const s of ['data-media="all"', 'data-presentation="seasons"', 'data-grouping="combined"']) assert.ok(box.includes(s), s);
  app.ctx.setBrowsePresentation('seasons');
  assert.ok(html(app).includes('<button class="section-toggle"'));
  app.ctx.switchView('alltv'); await settle();
  assert.ok(!filters(app).includes('browse-controls') && filters(app).includes('setAllTvPresentation'));
});

// ─── The four presentations ───────────────────────────────────────────────────
test('Shows + Separate: TV show groups A–Z, then films A–Z (Skipped hidden by default)', async () => {
  const app = await boot();
  await open(app);
  assert.deepStrictEqual(listed(app), ['== TV', 'Andor [show]', 'Bad Date Show [show]', 'Star Wars: The Clone Wars (2008) [show]', 'Star Wars: Visions [show]',
    '== Movies', 'Andor [film]', 'Odd Film [film]', 'Star Wars: The Clone Wars (2008) [film]', 'Star Wars: The Clone Wars (2008) [film]', 'The Mandalorian &amp; Grogu [film]', 'Untitled Film [film]']);
});

test('Shows + Combined: shows and films interleaved A–Z, TV before a film of the same title; an expanded show keeps its seasons beneath it', async () => {
  const app = await boot();
  await open(app);
  app.ctx.setBrowseGrouping('combined');
  const cw = app.get("[...browseData.showsById.values()].find(s => s.title.startsWith('Star Wars: The Clone')).id");
  app.ctx.toggleBrowseShow(cw);
  assert.deepStrictEqual(listed(app), ['== All', 'Andor [show]', 'Andor [film]', 'Bad Date Show [show]', 'Odd Film [film]',
    'Star Wars: The Clone Wars (2008) [show]', '  - Season 1', '  - Season 2', 'Star Wars: The Clone Wars (2008) [film]', 'Star Wars: The Clone Wars (2008) [film]',
    'Star Wars: Visions [show]', 'The Mandalorian &amp; Grogu [film]', 'Untitled Film [film]']);
  assert.ok(html(app).includes('<span class="ro-tag">TV show</span>') && html(app).includes('· Film'));
  assert.ok(cards(app).includes('<span class="ro-tag">TV show</span>'));
  // The two same-title films: same title, same kind and source → row id.
  const ids = [...html(app).matchAll(/browse-film-row[^"]*">\s*<td><span class="show-title">Star Wars: The Clone Wars \(2008\)/g)].length;
  assert.strictEqual(ids, 2);
});

test('Seasons + Separate: TV seasons oldest first, then films oldest first; year headers; TBA (collapsed) and Date needs review (expanded) apart', async () => {
  const app = await boot();
  await open(app);
  app.ctx.setBrowsePresentation('seasons');
  assert.deepStrictEqual(listed(app), ['== TV',
    '# 2008', 'Star Wars: The Clone Wars (2008) · Season 1',
    '# 2009', 'Star Wars: The Clone Wars (2008) · Season 2',
    '# 2023', 'Star Wars: Visions · Volume 1', 'Star Wars: Visions · Volume 2', 'Star Wars: Visions · Specials',
    '# 2025', 'Andor · Season 2',
    '> TBA', '> Date needs review', 'Bad Date Show · Season 1',
    '== Movies',
    '# 2008', 'Star Wars: The Clone Wars (2008) [film]', 'Star Wars: The Clone Wars (2008) [film]',
    '# 2022', 'Andor [film]', '# 2026', 'The Mandalorian &amp; Grogu [film]',
    '> TBA', '> Date needs review', 'Odd Film [film]']);
  assert.ok(html(app).includes('data-section="tvTba" aria-expanded="false"') && html(app).includes('data-section="tvReview" aria-expanded="true"'));
  assert.ok(html(app).includes('TBA <span class="section-count">1</span>'), 'collapsed TBA still counted');
  assert.ok(!html(app).includes('Andor · Season 3') && !html(app).split('> TBA')[0].includes('TBA 2027'), 'a guessed date stays out of the timeline');
  app.ctx.toggleBrowseSection('tvTba');
  assert.ok(listed(app).includes('Andor · Season 3'));
  assert.ok(html(app).includes('date needs review'), 'labelled, never Upcoming');
  // Andor Season 1 is skipped on its own: left out by the default, back in its place under All.
  assert.ok(!listed(app).includes('Andor · Season 1'));
  app.ctx.setBrowseSeasonVis('all');
  const all = listed(app);
  assert.deepStrictEqual(all.slice(all.indexOf('# 2009'), all.indexOf('# 2023')), ['# 2009', 'Star Wars: The Clone Wars (2008) · Season 2', '# 2022', 'Andor · Season 1']);
});

test('Seasons + Combined: TV seasons and films interleaved oldest first; equal dates by show title, TV before film, season order; one shared TBA and review section', async () => {
  const app = await boot();
  await open(app);
  app.ctx.setBrowsePresentation('seasons');
  app.ctx.setBrowseGrouping('combined');
  app.ctx.toggleBrowseSection('allTba');
  assert.deepStrictEqual(listed(app), ['== All',
    '# 2008', 'Star Wars: The Clone Wars (2008) [film]', 'Star Wars: The Clone Wars (2008) · Season 1', 'Star Wars: The Clone Wars (2008) [film]',
    '# 2009', 'Star Wars: The Clone Wars (2008) · Season 2',
    '# 2022', 'Andor [film]',
    '# 2023', 'Star Wars: Visions · Volume 1', 'Star Wars: Visions · Volume 2', 'Star Wars: Visions · Specials',
    '# 2025', 'Andor · Season 2',
    '# 2026', 'The Mandalorian &amp; Grogu [film]',
    '> TBA', 'Andor · Season 3', 'Untitled Film [film]',
    '> Date needs review', 'Bad Date Show · Season 1', 'Odd Film [film]']);
  assert.ok(html(app).includes('<span class="ro-tag">TV</span>'), 'season entries carry a media label');
  const years = listed(app).filter(x => x.startsWith('# ')).map(x => x.slice(2));
  assert.deepStrictEqual(years, years.slice().sort(), 'year headers ascend');
});

test('Movies only is always A–Z, even when Seasons is the chosen (hidden) TV presentation', async () => {
  const app = await boot();
  await open(app);
  app.ctx.setBrowsePresentation('seasons');
  app.ctx.setBrowseMedia('movie');
  assert.deepStrictEqual(listed(app), ['== Movies', 'Andor [film]', 'Odd Film [film]', 'Star Wars: The Clone Wars (2008) [film]', 'Star Wars: The Clone Wars (2008) [film]',
    'The Mandalorian &amp; Grogu [film]', 'Untitled Film [film]']);
  assert.ok(!html(app).includes('year-group') && !html(app).includes('section-toggle'));
  app.ctx.setBrowseMedia('tv');
  assert.ok(listed(app)[1] === '# 2008', 'TV only + Seasons is chronological');
  app.ctx.setBrowseMedia('all'); app.ctx.setBrowseGrouping('combined'); app.ctx.setBrowseMedia('tv');
  assert.strictEqual(listed(app)[0], '== TV', 'a hidden Combined choice has no effect with TV only');
  app.ctx.setBrowseMedia('movie');
  assert.strictEqual(listed(app)[0], '== Movies');
});

// ─── Titles, membership and counts ────────────────────────────────────────────
test('a season stored under another title is shown and sorted by its show’s title; the saved row and All TV are unchanged', async () => {
  const app = await boot();
  await open(app);
  app.ctx.setBrowsePresentation('seasons');
  setFilter(app, 'fSearch', 'star wars: the clone');
  assert.ok(listed(app).includes('Star Wars: The Clone Wars (2008) · Season 2'));
  assert.ok(!html(app).includes('>The Clone Wars<'));
  assert.strictEqual(app.get("browseData.rows.find(r => r.id === 'cw-legacy').title"), 'The Clone Wars', 'the row is not changed');
  // Same date as a show titled between the two names: the show's title decides.
  const data = library();
  const between = show({ title: 'Super Show' }, [{ id: 'aa-super', label: 'Season 1', date: '2009-10-02' }]);
  data.rows.push(...between.rows); data.shows.push(between.show);
  const app2 = await boot(data);
  await open(app2);
  app2.ctx.setBrowsePresentation('seasons');
  const order = listed(app2);
  assert.ok(order.indexOf('Star Wars: The Clone Wars (2008) · Season 2') < order.indexOf('Super Show · Season 1'), order.join(' | '));
  app.ctx.switchView('alltv'); await settle();
  app.ctx.setAllTvPresentation('seasons');
  assert.ok(app.el('tbody').innerHTML.includes('<span class="show-title">The Clone Wars</span>'), 'All TV keeps its own behaviour');
});

test('all 12 combinations: grouping never changes counts or members; counts keep shows, season entries and films apart', async () => {
  const app = await boot();
  await open(app);
  setFilter(app, 'fStatus', 'all');
  const members = () => app.get(`(() => { const v = deriveBrowsePresentation(deriveBrowseCollection(browseData.rows, browseData.showsById, browseData.members, localTodayStr()),
    { media: browseMedia, presentation: browsePresentation, grouping: browseGrouping, seasonVis: browseSeasonVis, textMatches: () => true, fStatus: 'all' });
    return v.sections.flatMap(s => s.entries).map(e => e.kind + ':' + (e.kind === 'show' ? e.item.key : e.row.id)).sort().join(','); })()`);
  const expected = {
    // Seasons lists one season fewer: Andor Season 1, skipped on its own, under the default TV seasons choice.
    'all/shows': ['5 Shows', '10 Season entries', '7 Films'], 'all/seasons': ['5 Shows', '9 Season entries', '7 Films'],
    'tv/shows': ['5 Shows', '10 Season entries'], 'tv/seasons': ['5 Shows', '9 Season entries'],
    'movie/shows': ['7 Films'], 'movie/seasons': ['7 Films']
  };
  for (const media of ['all', 'tv', 'movie']) {
    for (const pres of ['shows', 'seasons']) {
      app.ctx.setBrowseMedia(media);
      if (media !== 'movie') app.ctx.setBrowsePresentation(pres); else app.run(`browsePresentation = '${pres}'; renderFilters(); renderTable();`);
      const seen = new Set();
      for (const grouping of ['separate', 'combined']) {
        app.run(`browseGrouping = '${grouping}'; renderFilters(); renderTable();`);
        assert.deepStrictEqual(stats(app), expected[`${media}/${pres}`], `${media}/${pres}/${grouping}`);
        seen.add(members());
        assert.strictEqual(mutating(app).length, 0);
      }
      assert.strictEqual(seen.size, 1, `${media}/${pres}: grouping changed members`);
    }
  }
});

test('TV seasons narrows season entries only (never films), with the note; it is kept through Shows and Movies-only and reset on a fresh entry', async () => {
  const app = await boot();
  await open(app);
  app.ctx.setBrowsePresentation('seasons');
  app.ctx.setBrowseSeasonVis('towatch');
  assert.deepStrictEqual(stats(app), ['4 Shows', '7 Season entries', '6 Films'], 'To watch: not watched, not season-skipped, not a Skipped show');
  assert.ok(html(app).includes('TV seasons: To watch. Films aren’t filtered by this.'));
  app.ctx.setBrowseSeasonVis('watched');
  assert.deepStrictEqual(stats(app), ['2 Shows', '2 Season entries', '6 Films'], 'watched, incl. the one that is also skipped; Wonder Man hidden by Status');
  app.ctx.setBrowseSeasonVis('skipped');
  assert.ok(listed(app).includes('Andor · Season 1'), 'both flags: in Skipped too');
  app.ctx.setBrowseMedia('tv');
  assert.ok(!html(app).includes('Films aren’t filtered'), 'no note when films are hidden');
  app.ctx.setBrowsePresentation('shows');
  assert.deepStrictEqual(stats(app), ['4 Shows', '9 Season entries'], 'Shows lists every stored season of the 4 shows (Wonder Man hidden by Status)');
  app.ctx.setBrowseMedia('movie'); app.ctx.setBrowseMedia('all'); app.ctx.setBrowsePresentation('seasons');
  assert.strictEqual(app.get('browseSeasonVis'), 'skipped');
  assert.ok(filters(app).includes('<option value="skipped" selected>TV seasons: Skipped'));
  app.ctx.setBrowseSeasonVis('all');
  assert.ok(!html(app).includes('Films aren’t filtered'));
  app.ctx.setBrowseSeasonVis('watched');
  await open(app, B['sheridan']); await open(app);
  assert.strictEqual(app.get('browseSeasonVis'), 'notskipped');
});

test('TV seasons defaults to All (except Skipped): a season skipped on its own is hidden and uncounted; All lists it, labelled; Status still decides shows and films', async () => {
  const data = library();
  const allSkipped = show({ title: 'All Skipped Show', status: 'confirmed' }, [{ id: 'as1', label: 'Season 1', date: '2020-01-01', s: true }]);
  data.rows.push(...allSkipped.rows); data.shows.push(allSkipped.show);
  const app = await boot(data);
  await open(app);
  app.ctx.setBrowsePresentation('seasons');
  assert.strictEqual(app.get('browseSeasonVis'), 'notskipped');
  // Default Status hides the Skipped show (Wonder Man) and film (Ewoks); the default TV seasons choice
  // hides Andor Season 1 and the only season of All Skipped Show, which then isn't counted as a show.
  assert.deepStrictEqual(stats(app), ['4 Shows', '8 Season entries', '6 Films']);
  assert.ok(!listed(app).includes('Andor · Season 1') && !listed(app).some(x => x.startsWith('All Skipped Show')));
  assert.ok(!html(app).includes('Season skipped') && !html(app).includes('Films aren’t filtered'), 'no skipped season and no note under the default');
  app.ctx.setBrowseSeasonVis('all');
  assert.deepStrictEqual(stats(app), ['5 Shows', '10 Season entries', '6 Films']);
  assert.ok(listed(app).includes('Andor · Season 1') && listed(app).includes('All Skipped Show · Season 1'));
  assert.ok(html(app).includes('<span class="ro-tag">Season skipped</span>'), 'skipped seasons are labelled under All');
  assert.ok(!html(app).includes('Films aren’t filtered'), 'no note under All');
  app.ctx.setBrowseSeasonVis('notskipped');
  setFilter(app, 'fStatus', 'all');
  assert.deepStrictEqual(stats(app), ['5 Shows', '9 Season entries', '7 Films'], 'All statuses brings back Wonder Man and Ewoks; skipped seasons stay out');
  app.ctx.setBrowsePresentation('shows');
  app.ctx.toggleBrowseShow(app.get("[...browseData.showsById.values()].find(s => s.title === 'Andor').id"));
  assert.ok(listed(app).includes('  - Season 1'), 'Shows: an expanded show still lists every stored season');
  assert.strictEqual(mutating(app).length, 0);
});

test('Status and Search apply to the show (TV) and the film; they survive presentation, grouping and media changes', async () => {
  const app = await boot();
  await open(app);
  setFilter(app, 'fSearch', 'andor'); setFilter(app, 'fStatus', 'all');
  for (const step of [() => app.ctx.setBrowsePresentation('seasons'), () => app.ctx.setBrowseGrouping('combined'), () => app.ctx.setBrowseMedia('tv'), () => app.ctx.setBrowseMedia('all')]) {
    step();
    assert.deepStrictEqual([app.el('fSearch').value, app.el('fStatus').value], ['andor', 'all']);
  }
  assert.deepStrictEqual(listed(app).filter(x => !x.startsWith('#') && !x.startsWith('==') && !x.startsWith('>')), ['Andor [film]', 'Andor · Season 2'], 'Season 1 is skipped on its own: TV seasons, not Status, leaves it out');
  setFilter(app, 'fSearch', ''); setFilter(app, 'fStatus', 'skipped');
  assert.deepStrictEqual(stats(app), ['1 Show', '1 Season entry', '1 Film'], 'Wonder Man and Ewoks');
});

test('empty states: no films saved (Separate) and nothing matching (Combined); a TV-only collection never gets made-up films', async () => {
  const data = all(show({ title: 'Fiance', collection: '90day' }, [{ label: 'Season 1', date: '2014-01-12' }]));
  const app = await boot(data);
  await open(app, B['90day']);
  app.ctx.setBrowsePresentation('seasons');
  assert.ok(html(app).includes('No films in this collection.'));
  app.ctx.setBrowseGrouping('combined');
  assert.deepStrictEqual(stats(app), ['1 Show', '1 Season entry', '0 Films']);
  assert.ok(!html(app).includes('[film]') && !html(app).includes('browse-film-row'));
  setFilter(app, 'fSearch', 'zzz');
  assert.ok(html(app).includes('Nothing matches these filters.'));
  app.ctx.setBrowseGrouping('separate');
  assert.ok(html(app).includes('No TV seasons match these filters.'));
});

// ─── Order is deterministic ───────────────────────────────────────────────────
test('shuffled storage gives byte-identical output in every presentation', async () => {
  const base = library();
  const outputs = new Set();
  for (let i = 0; i < 6; i++) {
    const rows = base.rows.slice(), shows = base.shows.slice();
    let seed = i * 7919 + 3;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (const arr of [rows, shows]) for (let j = arr.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [arr[j], arr[k]] = [arr[k], arr[j]]; }
    const app = await boot({ rows, shows });
    await open(app);
    setFilter(app, 'fStatus', 'all');
    let out = '';
    for (const [pres, grouping] of [['shows', 'separate'], ['shows', 'combined'], ['seasons', 'separate'], ['seasons', 'combined']]) {
      app.run(`browsePresentation = '${pres}'; browseGrouping = '${grouping}'; browseSectionOpen = { tvTba: true, filmTba: true, allTba: true, tvReview: true, filmReview: true, allReview: true }; renderFilters(); renderTable();`);
      out += html(app) + cards(app);
    }
    outputs.add(out);
  }
  assert.strictEqual(outputs.size, 1);
});

// ─── Preferences ──────────────────────────────────────────────────────────────
test('the layout is remembered per collection, written only when changed, apart from All TV; Search/Status/media/TV seasons still reset on entry', async () => {
  const app = await boot();
  await open(app);
  await open(app, B['sheridan']);
  assert.deepStrictEqual(app.store_.writes, [], 'nothing is written on entry');
  await open(app);
  app.ctx.setBrowsePresentation('seasons');
  app.ctx.setBrowsePresentation('seasons'); // no change: no write
  app.ctx.setBrowseGrouping('combined');
  setFilter(app, 'fSearch', 'andor');
  app.ctx.setBrowseMedia('tv');
  assert.deepStrictEqual(app.store_.writes.map(w => w[0]), ['watchlist_browse_layout_disney', 'watchlist_browse_layout_disney']);
  assert.deepStrictEqual(JSON.parse(app.store_.data.watchlist_browse_layout_disney), { presentation: 'seasons', grouping: 'combined' });
  await open(app, B['sheridan']);
  assert.deepStrictEqual(J(app, '[browsePresentation, browseGrouping]'), ['shows', 'separate'], 'per collection');
  await open(app);
  assert.deepStrictEqual(J(app, '[browseMedia, browsePresentation, browseGrouping, browseSeasonVis]'), ['all', 'seasons', 'combined', 'notskipped']);
  assert.deepStrictEqual([app.el('fSearch').value, app.el('fStatus').value], ['', '']);
  app.ctx.switchView('alltv'); await settle();
  assert.strictEqual(app.get('allTvPresentation'), 'shows', 'All TV is independent');
  assert.ok(!app.store_.writes.some(w => w[0] === 'watchlist_alltv_presentation'));
});

test('missing, invalid or unavailable storage falls back to Shows + Separate without an error', async () => {
  for (const stored of [{}, { watchlist_browse_layout_disney: 'not json' }, { watchlist_browse_layout_disney: '{"presentation":"timeline","grouping":7}' }]) {
    const app = await boot(library(), { stored });
    await open(app);
    assert.deepStrictEqual(J(app, '[browsePresentation, browseGrouping]'), ['shows', 'separate']);
  }
  const app = await boot();
  app.ctx.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  await open(app);
  app.ctx.setBrowsePresentation('seasons');
  assert.strictEqual(app.get('browsePresentation'), 'seasons', 'works for the visit');
  assert.strictEqual(app.consoleErrors.length, 0);
  const half = await boot(library(), { stored: { watchlist_browse_layout_disney: '{"grouping":"combined"}' } });
  await open(half);
  assert.deepStrictEqual(J(half, '[browsePresentation, browseGrouping]'), ['shows', 'combined'], 'each value independently');
});

// ─── Focus and expansion ──────────────────────────────────────────────────────
function focusRig(app, containerId) {
  const focused = [];
  app.ctx.document.activeElement = { closest: sel => (sel === `#${containerId}` ? {} : null) };
  for (const id of ['tbody', 'cardList', 'filtersRow']) app.el(id).querySelector = sel => ({ focus: () => focused.push(`${id} ${sel}`) });
  return focused;
}

test('keyboard focus returns to the presentation, grouping and section buttons after redrawing', async () => {
  const app = await boot();
  await open(app);
  let focused = focusRig(app, 'filtersRow');
  app.ctx.setBrowsePresentation('seasons');
  app.ctx.setBrowseGrouping('combined');
  assert.deepStrictEqual(focused, ['filtersRow [data-presentation="seasons"]', 'filtersRow [data-grouping="combined"]']);
  for (const c of ['tbody', 'cardList']) {
    focused = focusRig(app, c);
    app.ctx.toggleBrowseSection('allReview');
    assert.deepStrictEqual(focused, [`${c} [data-section="allReview"]`]);
  }
  assert.ok(html(app).includes('<button class="section-toggle" data-section="allTba" aria-expanded="false"') && cards(app).includes('data-section="allTba"'));
});

test('expanded shows stay expanded across presentation and grouping changes in a visit, and reset on a fresh entry', async () => {
  const app = await boot();
  await open(app);
  const id = app.get("[...browseData.showsById.values()].find(s => s.title === 'Andor').id");
  app.ctx.toggleBrowseShow(id);
  app.ctx.setBrowsePresentation('seasons'); app.ctx.setBrowseGrouping('combined'); app.ctx.setBrowsePresentation('shows');
  assert.ok(html(app).includes(`data-show-key="${id}" aria-expanded="true"`));
  await open(app, B['sheridan']); await open(app);
  assert.ok(html(app).includes(`data-show-key="${id}" aria-expanded="false"`));
});

// ─── Read-only ────────────────────────────────────────────────────────────────
test('every control in every combination stays read-only: only non-mutating handlers, no writes, no reads after loading', async () => {
  const probe = await createApp();
  const def = probe.get("COLLECTIONS.find(c => c.id === 'disney').defaults.find(d => d.s !== 'Film' && !/TBA/i.test(d.d))");
  const data = library();
  const stale = show({ title: def.t, show_key: def.k.split('|')[0] }, [{ label: def.s, date: '2099-01-01', display: 'TBA' }]);
  stale.rows[0].item_key = def.k;
  data.rows.push(...stale.rows); data.shows.push(stale.show);
  const app = await boot(data);
  await open(app);
  const reads = app.requests.length;
  for (const media of ['all', 'tv', 'movie', 'all']) {
    app.ctx.setBrowseMedia(media);
    for (const pres of ['seasons', 'shows']) {
      app.ctx.setBrowsePresentation(pres);
      for (const grouping of ['combined', 'separate']) {
        app.ctx.setBrowseGrouping(grouping);
        for (const vis of ['towatch', 'watched', 'skipped', 'all']) app.ctx.setBrowseSeasonVis(vis);
        for (const sec of ['tvTba', 'filmTba', 'allTba', 'tvReview', 'filmReview', 'allReview']) app.ctx.toggleBrowseSection(sec);
        for (const key of app.get('[...browseData.showsById.keys()]')) app.ctx.toggleBrowseShow(key);
        for (const id of ['tbody', 'cardList', 'filtersRow', 'statsRow', 'viewHead']) {
          const bad = handlersIn(app.el(id).innerHTML).filter(h => !READ_ONLY.has(h));
          assert.deepStrictEqual(bad, [], `${media}/${pres}/${grouping} ${id}: ${bad}`);
        }
      }
    }
  }
  await settle();
  assert.strictEqual(app.requests.length, reads, 'presentation changes read nothing');
  assert.deepStrictEqual(mutating(app), []);
  assert.ok(!/status-select|watch-btn|skip-btn|del-btn/.test(html(app) + cards(app)));
});

T.run();
