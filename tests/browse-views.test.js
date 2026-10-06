// Offline tests for the read-only browse views (browse-views.js): Browse
// collections (Disney+, Sheridan, 90 Day, True Crime / Docs; TV and films
// together) and All Movies (every saved film, whatever tab stores it).
// Membership is the storage tab only; TV groups by show_id and follows the show's
// status; films keep their own row. The views read everything completely or show
// Retry, never write (not on entry and not from any control), and never paint
// after being left. Run from the repo root: node tests/browse-views.test.js
// No network, no database (see tests/app-harness.js).
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('browse-views');
const test = T.test;

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const disp = iso => { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };

let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
// A show and its seasons. Season specs: { num | season, w, s (skipped), date, tba, display, id }.
// Each season's own status is deliberately misleading: only the show's status counts.
function show(o, specs) {
  const s = { id: nid('show'), collection: 'disney', title: 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: null, status: 'confirmed', ...o };
  const identified = s.tmdb_id != null;
  const rows = specs.map(sp => {
    const num = sp.num !== undefined ? sp.num : null;
    const label = sp.season || (num === 0 ? 'Specials' : `Season ${num}`);
    const date = sp.date || '2020-01-01';
    return {
      id: sp.id || nid('r'), collection: s.collection, title: s.title, theme: 'Drama', status: sp.status || 'skipped',
      watched: !!sp.w, skipped: !!sp.s, show_id: s.id,
      media_type: identified ? 'tv' : null, tmdb_id: identified ? s.tmdb_id : null, season_number: identified ? num : null,
      season: label, display_date: sp.display || (sp.tba ? 'TBA' : disp(date)), date_sort: sp.tba && !sp.date ? '2099-01-01' : date,
      item_key: `${s.show_key}|${label.toLowerCase()}`, watch_with: [], collections: []
    };
  });
  return { show: s, rows };
}
const film = o => ({ id: nid('f'), collection: 'movies', title: 'Film', theme: 'Drama', status: 'confirmed', watched: false,
  media_type: 'movie', tmdb_id: 900 + n, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });
const legacyFilm = o => film({ media_type: null, tmdb_id: null, ...o });
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows || [x]), shows: xs.filter(x => x.show).map(x => x.show) });

// The library used by most tests.
function library() {
  const andor = show({ title: 'Andor', status: 'watching' }, [{ num: 1, w: true, season: 'Season 1' }, { season: 'Season 2', display: 'TBA 2027', date: '2027-06-01' }]);
  const bear = show({ title: 'The Bear', tmdb_id: 136315, status: 'confirmed' }, [{ num: 1, w: true }, { num: 2 }, { num: 0 }]);
  const visions = show({ title: 'Star Wars: Visions', status: 'pending' }, [{ season: 'Volume 2' }, { season: 'Volume 1', w: true }]);
  const lamp = show({ title: 'Lamp Life', status: 'pending' }, [{ season: 'Special' }]);
  const wonder = show({ title: 'Wonder Man', status: 'skipped' }, [{ season: 'Season 1', w: true }, { season: 'Season 2', s: true, tba: true }]);
  const flagged = show({ title: 'Explicit TV', tmdb_id: 4242, status: 'confirmed' }, [{ num: 1, season: 'Film' }]); // explicit tv wins over a Film-like label
  const yellow = show({ title: 'Yellowstone', collection: 'sheridan', status: 'complete' }, [{ season: 'Season 5 (Part 2)', w: true, date: '2024-11-10' }, { season: 'Season 5 (Part 1)', w: true, date: '2022-11-13' }]);
  const tulsa = show({ title: 'Tulsa King', collection: 'sheridan', tmdb_id: 153312, status: 'highpriority' }, [{ num: 1 }]);
  const fiance = show({ title: '90 Day Fiancé', collection: '90day', tmdb_id: 61575, status: 'confirmed' }, [{ num: 1 }, { num: 2 }]);
  const tcShow = show({ title: 'The Jinx', collection: 'truecrime', tmdb_id: 61101, status: 'complete' }, [{ num: 1, w: true }]);
  const otherBear = show({ title: 'The Bear', collection: 'othertv', tmdb_id: 136315, status: 'watching' }, [{ num: 1, w: true }, { num: 2 }]);
  return all(andor, bear, visions, lamp, wonder, flagged, yellow, tulsa, fiance, tcShow, otherBear,
    legacyFilm({ id: 'f-mando', collection: 'disney', title: 'The Mandalorian & Grogu', display_date: 'May 22, 2026', date_sort: '2026-05-22' }),
    legacyFilm({ id: 'f-ewoks', collection: 'disney', title: 'Ewoks: The Battle for Endor', status: 'skipped', display_date: 'Nov 24, 1985', date_sort: '1985-11-24' }),
    legacyFilm({ id: 'f-sicario', collection: 'sheridan', title: 'Sicario', watched: true, display_date: 'Sep 18, 2015', date_sort: '2015-09-18' }),
    legacyFilm({ id: 'f-fast', collection: 'sheridan', title: 'F.A.S.T.', display_date: 'TBA 2027', date_sort: '2027-05-14' }),
    film({ id: 'f-tc', collection: 'truecrime', title: 'Tell Me Who I Am', watched: true }),
    film({ id: 'f-wind', title: 'Wind River', theme: 'Sheridan', collections: ['Sheridan', 'Taylor Sheridan Collection'], watch_with: ['Kids'] }),
    film({ id: 'f-dune', title: 'Dune', tmdb_id: 438631, display_date: 'Oct 22, 2021', date_sort: '2021-10-22' }),
    film({ id: 'f-dune84', title: 'Dune', tmdb_id: 841, display_date: 'Dec 14, 1984', date_sort: '1984-12-14' }),
    film({ id: 'f-future', title: 'Avengers: Doomsday', display_date: disp(day(60)), date_sort: day(60) }),
    { id: 'odd-1', collection: 'movies', title: 'Odd Row', season: 'Season 1', item_key: 'odd row|season 1', theme: '', display_date: '', date_sort: '2020-01-01',
      status: 'confirmed', watched: false, media_type: 'tv', tmdb_id: 5, season_number: 1, show_id: null, skipped: false, watch_with: [], collections: [] }
  );
}

async function boot(data = library(), opts = {}) {
  return createApp({ rows: data.rows, tvShows: data.shows, ...opts });
}
async function openCol(app, id) { app.ctx.openBrowseCollection(id); await settle(); }
const html = app => app.el('tbody').innerHTML;
const cards = app => app.el('cardList').innerHTML;
const titles = app => [...html(app).matchAll(/<span class="show-title">([^<]*)<\/span>/g)].map(m => m[1]);
const cardTitles = app => [...cards(app).matchAll(/<span class="card-title">([^<]*)<\/span>/g)].map(m => m[1]);
const stats = app => [...app.el('statsRow').innerHTML.matchAll(/stat-num">(\d+)<\/div><div class="stat-label">([^<]*)</g)].map(m => `${m[1]} ${m[2]}`);
const setFilter = (app, id, value) => { app.el(id).value = value; app.ctx.renderTable(); };
const mutating = app => app.requests.filter(r => r.method !== 'GET' || /\/rpc\//.test(r.url) || !r.url.includes('/rest/v1/'));
const handlersIn = s => [...s.matchAll(/\bon(?:click|change|input|keydown)="([^"]*)"/g)]
  .flatMap(m => [...m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\(/g)].map(x => x[1]))
  .filter(x => !['if', 'replace', 'stopPropagation'].includes(x));
const READ_ONLY_HANDLERS = new Set(['toggleBrowseShow', 'setBrowseMedia', 'renderTable', 'toggleFilters', 'browseBack', 'openBrowseCollection',
  'loadBrowseView', 'switchView', 'switchTab', 'switchMediaType']);
function assertReadOnlyDom(app) {
  for (const id of ['tbody', 'cardList', 'filtersRow', 'statsRow', 'browseBar', 'viewHead']) {
    const bad = handlersIn(app.el(id).innerHTML).filter(h => !READ_ONLY_HANDLERS.has(h));
    assert.deepStrictEqual(bad, [], `${id} exposes ${bad.join(', ')}`);
  }
  assert.ok(!/<select[^>]*class="[^"]*status-select/.test(html(app) + cards(app)), 'no status select');
  assert.ok(!/watch-btn|skip-btn|del-btn|Match to TMDB|toggleWatchWith/.test(html(app) + cards(app)), 'no row controls');
}

// ─── Navigation ───────────────────────────────────────────────────────────────
test('the app still opens on Currently Watching; Browse collections is offered in TV and in Movies, in the approved order', async () => {
  const app = await boot();
  assert.strictEqual(app.get('activeViewId'), 'watching');
  assert.ok(!app.requests.some(r => !r.url.includes('collection=in.') && r.url.includes('/watchlist_items?')), 'boot reads only the TV rows, as before');
  const opts = () => [...app.el('browseBar').innerHTML.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map(m => m[2]);
  assert.deepStrictEqual(opts(), ['Choose a collection…', 'Disney+', 'Sheridan', '90 Day', 'True Crime / Docs']);
  app.ctx.switchMediaType('movie'); await settle();
  assert.deepStrictEqual(opts().slice(1), ['Disney+', 'Sheridan', '90 Day', 'True Crime / Docs']);
});

test('Movies opens on All Movies; the legacy Movies tab stays one click away, labelled Movies (legacy); TV still lands on Currently Watching', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies');
  assert.strictEqual(app.get('activeTabId'), null);
  const bar = app.el('tabBar').innerHTML;
  assert.ok(bar.indexOf("switchView('allmovies')") < bar.indexOf('tab-sep') && bar.indexOf('tab-sep') < bar.indexOf("switchTab('movies')"));
  assert.ok(bar.includes('Movies (legacy)') && /class="tab active" onclick="switchView\('allmovies'\)"/.test(bar));
  app.ctx.switchTab('movies'); await settle();
  assert.strictEqual(app.get('activeTabId'), 'movies');
  assert.ok(html(app).includes("toggleWatch('f-wind')"), 'the legacy tab keeps its controls');
  app.ctx.switchMediaType('tv'); await settle();
  assert.strictEqual(app.get('activeViewId'), 'watching');
});

for (const [id, label, from] of [['browse-disney', 'Disney+', 'tv'], ['browse-sheridan', 'Sheridan', 'movie'], ['browse-90day', '90 Day', 'tv'], ['browse-truecrime', 'True Crime / Docs', 'movie']]) {
  test(`${label} opens from ${from === 'tv' ? 'TV' : 'Movies'}: All media, its own destination (no legacy tab active), reads only`, async () => {
    const app = await boot();
    if (from === 'movie') { app.ctx.switchMediaType('movie'); await settle(); }
    const before = app.requests.length;
    await openCol(app, id);
    assert.strictEqual(app.get('activeViewId'), id);
    assert.strictEqual(app.get('activeTabId'), null);
    assert.strictEqual(app.get('browseMedia'), 'all');
    assert.ok(app.el('viewHead').innerHTML.includes(`${label.replace('&', '&amp;')} — All media`));
    assert.ok(app.el('viewHead').innerHTML.includes(`Back to ${from === 'tv' ? 'TV' : 'Movies'}`));
    assert.ok(!/class="tab active"[^>]*switchTab/.test(app.el('tabBar').innerHTML), 'the legacy tab is not marked active');
    assert.ok(app.el('browseBar').innerHTML.includes(`value="${id}" selected`));
    const reqs = app.requests.slice(before);
    assert.ok(reqs.length >= 2 && reqs.every(r => r.method === 'GET' && r.headers.Range && r.headers.Prefer === 'count=exact'));
    assert.deepStrictEqual([...new Set(reqs.map(r => new URL(r.url).pathname.split('/').pop()))].sort(), ['tv_shows', 'watchlist_items']);
    assert.ok(reqs.every(r => !r.url.includes('collection=')), 'a destination id is never sent as a collection');
    assert.strictEqual(mutating(app).length, 0);
    assert.strictEqual(app.get(`tabData[${JSON.stringify(id.slice(7))}]`), undefined, 'the legacy loader was not used');
    if (id === 'browse-truecrime') assert.ok(app.el('viewHead').innerHTML.includes('True Crime and Documentary are not yet classified separately'));
  });
}

test('each fresh collection entry starts at All media with Search and Status reset, and reads again', async () => {
  const app = await boot();
  await openCol(app, 'browse-disney');
  app.ctx.setBrowseMedia('movie'); await settle();
  setFilter(app, 'fSearch', 'ewoks'); setFilter(app, 'fStatus', 'all');
  const reads = app.requests.length;
  app.ctx.switchMediaType('movie'); await settle();
  await openCol(app, 'browse-disney');
  assert.ok(app.requests.length > reads + 2, 'read again');
  assert.strictEqual(app.get('browseMedia'), 'all');
  assert.strictEqual(app.el('fSearch').value, '');
  assert.strictEqual(app.el('fStatus').value, '');
  assert.ok(app.el('viewHead').innerHTML.includes('Disney+ — All media'));
});

test('Back returns to the view it came from with its filters; from a legacy tab it goes to the area’s first view without loading that tab', async () => {
  const app = await boot();
  app.ctx.switchView('alltv'); await settle();
  setFilter(app, 'fSearch', 'bear'); setFilter(app, 'fSource', 'disney'); setFilter(app, 'fStatus', 'all');
  const allTvHtml = html(app);
  await openCol(app, 'browse-sheridan');
  await openCol(app, 'browse-90day'); // collection to collection keeps the first origin
  assert.ok(app.el('viewHead').innerHTML.includes('Back to TV'));
  app.ctx.browseBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'alltv');
  assert.deepStrictEqual(['fSearch', 'fSource', 'fStatus'].map(f => app.el(f).value), ['bear', 'disney', 'all']);
  assert.strictEqual(html(app), allTvHtml, 'All TV shows exactly what it showed');
  assert.strictEqual(app.get('allTvSeasonVis'), 'all');

  app.ctx.switchMediaType('movie'); await settle();
  setFilter(app, 'fSource', 'sheridan');
  await openCol(app, 'browse-disney');
  app.ctx.browseBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'allmovies');
  assert.strictEqual(app.el('fSource').value, 'sheridan');
  assert.deepStrictEqual(titles(app), ['F.A.S.T.', 'Sicario']);

  app.ctx.switchMediaType('tv'); await settle();
  app.ctx.switchTab('sheridan'); await settle();
  const writesBefore = mutating(app).length;
  await openCol(app, 'browse-sheridan');
  const getsBefore = app.requests.length;
  app.ctx.browseBack(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'watching');
  assert.strictEqual(app.get('activeTabId'), null);
  assert.ok(app.requests.slice(getsBefore).every(r => r.method === 'GET' && !r.url.includes('collection=eq.sheridan')), 'the legacy loader did not run again');
  assert.strictEqual(mutating(app).length, writesBefore);
  assert.strictEqual(app.el('fSearch').value, '', 'a later visit starts with fresh filters');
});

// ─── Read-only ────────────────────────────────────────────────────────────────
test('missing defaults and a stale TBA date cause no write from any new view or any of its controls (the legacy tab would write)', async () => {
  const probe = await createApp();
  const def = probe.get("COLLECTIONS.find(c => c.id === 'disney').defaults.find(d => d.s !== 'Film' && !/TBA/i.test(d.d))");
  const stale = show({ title: def.t, show_key: def.k.split('|')[0], status: 'confirmed' }, [{ season: def.s, display: 'TBA', date: '2099-01-01' }]);
  stale.rows[0].item_key = def.k;
  const data = library();
  data.rows.push(...stale.rows); data.shows.push(stale.show);
  const app = await boot(data);
  for (const id of ['browse-disney', 'browse-sheridan', 'browse-90day', 'browse-truecrime']) {
    await openCol(app, id);
    for (const m of ['tv', 'movie', 'all']) { app.ctx.setBrowseMedia(m); await settle(); }
    for (const st of ['', 'all', 'watching', 'highpriority', 'confirmed', 'complete', 'pending', 'maybe', 'skipped']) setFilter(app, 'fStatus', st);
    setFilter(app, 'fStatus', 'all');
    for (const key of app.get('[...browseData.showsById.keys()]')) { app.ctx.toggleBrowseShow(key); await settle(); }
    assertReadOnlyDom(app);
    setFilter(app, 'fSearch', 'zzz'); setFilter(app, 'fSearch', '');
    app.ctx.loadBrowseView(); await settle();
    app.ctx.toggleFilters();
    app.ctx.browseBack(); await settle();
  }
  app.ctx.switchMediaType('movie'); await settle();
  setFilter(app, 'fStatus', 'all'); setFilter(app, 'fSource', 'disney');
  assertReadOnlyDom(app);
  assert.deepStrictEqual(mutating(app), [], 'no POST/PATCH/DELETE/RPC/TMDB request');
  // Control: the legacy Disney+ tab does write for the same data.
  app.ctx.switchMediaType('tv'); await settle();
  app.ctx.switchTab('disney'); await settle();
  const w = mutating(app).map(r => `${r.method} ${new URL(r.url).pathname.split('/').pop()}`);
  assert.ok(w.includes('PATCH watchlist_items') && w.includes('POST seed_tv_defaults'), w.join(', '));
});

test('every row action and Restore is inert while a read-only view is open; Restore is hidden there only', async () => {
  const app = await boot();
  assert.notStrictEqual(app.el('restoreBtn').style.display, 'none');
  let clicked = 0;
  app.el('restoreFileInput').click = () => { clicked++; };
  for (const enter of [() => openCol(app, 'browse-disney'), async () => { app.ctx.switchMediaType('movie'); await settle(); }]) {
    await enter();
    assert.strictEqual(app.el('restoreBtn').style.display, 'none');
    const showId = app.get("[...browseData.showsById.values()].find(s => s.status === 'pending').id");
    assert.ok(app.get(`tvShowsById.has(${JSON.stringify(showId)})`), 'the show is loaded page-wide, so only the guard stops the write');
    await app.ctx.toggleWatch('f-mando');
    await app.ctx.setStatus('f-mando', 'skipped', null);
    await app.ctx.setSeasonSkipped(app.get("browseData.rows.find(r => r.show_id).id"), true);
    await app.ctx.setShowStatusById(showId, 'watching');
    await app.ctx.delRow('f-wind');
    await app.ctx.toggleWatchWith('f-wind', 'Kids', false);
    await app.ctx.addEntry();
    app.ctx.handleRestoreClick();
    await app.ctx.handleRestoreFileSelected({ target: { files: [{ text: async () => '{}' }], value: 'x' } });
    await settle();
  }
  assert.strictEqual(clicked, 0);
  assert.strictEqual(app.el('restoreModalOverlay').style.display, undefined, 'no restore dialog opened');
  assert.deepStrictEqual(mutating(app), []);
  app.ctx.switchView('alltv'); await settle();
  assert.notStrictEqual(app.el('restoreBtn').style.display, 'none', 'Restore is back in the established views');
  assert.strictEqual(app.el('viewHead').innerHTML, '', 'the browse heading is gone in other views');
  app.ctx.handleRestoreClick();
  assert.strictEqual(clicked, 1);
});

// A restore started before navigating: a valid backup file whose text arrives late.
// A small library with real UUIDs and every column, so its backup is valid.
function restoreLibrary() {
  const u = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const at = '2026-01-01T00:00:00+00:00';
  const showRow = { id: u(1), collection: 'disney', title: 'Andor', show_key: 'andor', tmdb_id: null, status: 'watching', created_at: at };
  const base = { theme: 'Star Wars', watch_with: [], collections: [], tmdb_collection_id: null, tmdb_collection_name: null, created_at: at, skipped: false };
  return {
    shows: [showRow],
    rows: [
      { ...base, id: u(2), collection: 'disney', item_key: 'andor|season 1', title: 'Andor', season: 'Season 1', display_date: 'Sep 21, 2022', date_sort: '2022-09-21',
        watched: true, status: 'confirmed', media_type: null, tmdb_id: null, season_number: null, show_id: u(1) },
      { ...base, id: u(3), collection: 'movies', item_key: 'dune|film', title: 'Dune', season: 'Film', display_date: 'Oct 22, 2021', date_sort: '2021-10-22',
        watched: false, status: 'confirmed', media_type: 'movie', tmdb_id: 438631, season_number: null, show_id: null }
    ]
  };
}
async function restoreSetup() {
  const app = await boot(restoreLibrary());
  const backup = await app.ctx.buildBackupObject();
  const text = JSON.stringify(backup);
  let release;
  const file = { text: () => new Promise(r => { release = () => r(text); }) };
  let downloads = 0;
  app.ctx.downloadJSON = () => { downloads++; };
  return { app, file, release: () => release(), downloads: () => downloads };
}
const modalOpen = app => app.el('restoreModalOverlay').style.display === 'flex';
const restoreWrites = app => app.requests.filter(r => r.method !== 'GET');

test('restore: without navigating, a late file still opens the restore dialog (control)', async () => {
  const { app, file, release } = await restoreSetup();
  app.ctx.switchView('alltv'); await settle();
  const done = app.ctx.handleRestoreFileSelected({ target: { files: [file], value: 'x' } });
  release(); await done; await settle();
  assert.ok(modalOpen(app) && app.el('restoreModalBox').innerHTML.includes('executeRestore()'), 'the test is armed: ' + app.el('restoreModalBox').innerHTML.slice(0, 300));
  assert.deepStrictEqual(restoreWrites(app), []);
});

for (const [name, when] of [
  ['the file text arrives', 'text'],
  ['the preview is reading current data', 'preview'],
  ['the safety backup is being built', 'safety'],
  ['the safety-backup confirmation is showing', 'confirm']
]) {
  test(`restore race: navigating to a browse view while ${name} leaves no restore action and writes nothing`, async () => {
    const { app, file, release, downloads } = await restoreSetup();
    app.ctx.switchView('alltv'); await settle();
    const done = app.ctx.handleRestoreFileSelected({ target: { files: [file], value: 'x' } });
    let tail = done;
    if (when === 'text') {
      await openCol(app, 'browse-disney');
      release(); await done; await settle();
    } else if (when === 'preview') {
      const g = app.hold(r => r.method === 'GET' && r.url.includes('/tv_shows?select=id&limit=1'));
      release(); await g.reached;
      assert.ok(modalOpen(app) && app.el('restoreModalBox').innerHTML.includes('Checking current data'), 'reached the preview');
      await openCol(app, 'browse-disney');
      g.release(); await done; await settle();
    } else {
      release(); await done; await settle();
      assert.ok(app.el('restoreModalBox').innerHTML.includes('executeRestore()'));
      if (when === 'safety') {
        const g = app.hold(r => r.method === 'GET' && r.url.includes('/rest/v1/watchlist_items?'));
        tail = app.ctx.executeRestore();
        await g.reached;
        assert.ok(app.el('restoreModalBox').innerHTML.includes('Backing up your current data first'), 'reached the safety backup');
        await openCol(app, 'browse-disney');
        g.release(); await tail; await settle();
      } else {
        await app.ctx.executeRestore(); await settle();
        assert.ok(app.el('restoreModalBox').innerHTML.includes('continueRestoreAfterSafetyConfirm'));
        assert.strictEqual(downloads(), 1);
        await openCol(app, 'browse-disney');
      }
    }
    assert.ok(!modalOpen(app), 'no restore dialog');
    assert.ok(!/executeRestore|continueRestoreAfterSafetyConfirm/.test(app.el('restoreModalBox').innerHTML), 'no restore action available');
    assert.strictEqual(app.get('pendingRestoreData'), null);
    assert.strictEqual(downloads(), when === 'confirm' ? 1 : 0, 'no safety backup downloaded after leaving');
    // Even a stale handler can't continue the restore.
    await app.ctx.executeRestore();
    await app.ctx.continueRestoreAfterSafetyConfirm('watchlist-pre-restore-x.json');
    await settle();
    assert.ok(!modalOpen(app));
    assert.deepStrictEqual(restoreWrites(app), [], 'no POST/PATCH/DELETE/RPC');
    assert.strictEqual(app.get('activeViewId'), 'browse-disney');
  });
}

test('restore: the confirmation steps refuse to run in a browse view even if a prepared backup were left behind', async () => {
  const { app, downloads } = await restoreSetup();
  await openCol(app, 'browse-disney');
  app.ctx.__b = await app.ctx.buildBackupObject();
  app.run('pendingRestoreData = __b');
  await app.ctx.executeRestore(); await settle();
  assert.strictEqual(downloads(), 0, 'no safety backup');
  app.run('pendingRestoreData = __b');
  await app.ctx.continueRestoreAfterSafetyConfirm('f.json'); await settle();
  assert.ok(!modalOpen(app));
  assert.strictEqual(app.get('pendingRestoreData'), null);
  assert.deepStrictEqual(restoreWrites(app), []);
});

test('restore: any navigation abandons a prepared restore; one already sent to the database is not interrupted', async () => {
  const { app, file, release } = await restoreSetup();
  app.ctx.switchView('alltv'); await settle();
  const done = app.ctx.handleRestoreFileSelected({ target: { files: [file], value: 'x' } });
  release(); await done; await settle();
  app.ctx.switchView('comingsoon'); await settle();
  assert.ok(!modalOpen(app) && app.get('pendingRestoreData') === null);
  // Sent: the RPC is in flight when navigation happens.
  const done2 = app.ctx.handleRestoreFileSelected({ target: { files: [{ text: async () => JSON.stringify(await app.ctx.buildBackupObject()) }], value: 'x' } });
  await done2; await settle();
  await app.ctx.executeRestore(); await settle();
  const g = app.hold(r => r.url.includes('rpc/restore_backup'));
  const sent = app.ctx.continueRestoreAfterSafetyConfirm('f.json');
  await g.reached;
  app.ctx.switchView('alltv'); await settle();
  assert.ok(modalOpen(app), 'the in-flight restore keeps its dialog');
  g.release(); await sent; await settle();
  assert.ok(app.el('restoreModalBox').innerHTML.includes('finishRestoreAndReload'));
  app.ctx.finishRestoreAndReload(); await settle();
  assert.strictEqual(app.get('restoreInFlight'), false);
});

// ─── Keyboard focus ───────────────────────────────────────────────────────────
// The fake DOM has no focus: these give it a focused element and record refocusing.
function focusRig(app, containerId) {
  const focused = [];
  app.ctx.document.activeElement = { closest: sel => (sel === `#${containerId}` ? {} : null) };
  for (const id of ['tbody', 'cardList', 'filtersRow']) {
    app.el(id).querySelector = sel => ({ focus: () => focused.push(`${id} ${sel}`) });
  }
  return focused;
}

test('expanding or collapsing a show keeps keyboard focus on that show’s button, in the table or the cards', async () => {
  const app = await boot();
  await openCol(app, 'browse-sheridan');
  const id = app.get("[...browseData.showsById.values()].find(s => s.title === 'Yellowstone').id");
  assert.ok(html(app).includes(`data-show-key="${id}"`) && cards(app).includes(`data-show-key="${id}"`));
  let focused = focusRig(app, 'tbody');
  app.ctx.toggleBrowseShow(id);
  assert.deepStrictEqual(focused, [`tbody [data-show-key="${id}"]`]);
  focused = focusRig(app, 'cardList');
  app.ctx.toggleBrowseShow(id);
  assert.deepStrictEqual(focused, [`cardList [data-show-key="${id}"]`]);
  app.ctx.document.activeElement = null;
  app.ctx.toggleBrowseShow(id); // focus elsewhere: nothing is focused
});

test('changing the media choice keeps keyboard focus on the chosen media button', async () => {
  const app = await boot();
  await openCol(app, 'browse-disney');
  assert.ok(app.el('filtersRow').innerHTML.includes('data-media="tv"'));
  const focused = focusRig(app, 'filtersRow');
  app.ctx.setBrowseMedia('tv');
  app.ctx.setBrowseMedia('all');
  assert.deepStrictEqual(focused, ['filtersRow [data-media="tv"]', 'filtersRow [data-media="all"]']);
});

// ─── Membership and classification ───────────────────────────────────────────
test('a collection lists its own TV shows and films only; Specials, Volumes, Parts and an explicit-TV "Film" label stay TV', async () => {
  const app = await boot();
  await openCol(app, 'browse-disney');
  setFilter(app, 'fStatus', 'all');
  assert.deepStrictEqual(titles(app), ['Andor', 'Explicit TV', 'Lamp Life', 'Star Wars: Visions', 'The Bear', 'Wonder Man',
    'Ewoks: The Battle for Endor', 'The Mandalorian &amp; Grogu']);
  assert.deepStrictEqual(cardTitles(app), titles(app), 'the cards hold the same content');
  assert.ok(!html(app).includes('Wind River') && !html(app).includes('Sicario'));
  const filmTitles = [...html(app).matchAll(/<tr class="browse-film-row[^"]*">\s*<td><span class="show-title">([^<]*)</g)].map(m => m[1]);
  assert.deepStrictEqual(filmTitles, ['Ewoks: The Battle for Endor', 'The Mandalorian &amp; Grogu'], 'legacy Film rows are the films');
  assert.strictEqual(stats(app).join(' | '), '6 Shows | 11 Season entries | 2 Films');
});

test('a Movies-stored film with a Sheridan tag and theme is not added to Sheridan; it is in All Movies', async () => {
  const app = await boot();
  await openCol(app, 'browse-sheridan');
  setFilter(app, 'fStatus', 'all');
  assert.deepStrictEqual(titles(app), ['Tulsa King', 'Yellowstone', 'F.A.S.T.', 'Sicario']);
  app.ctx.switchMediaType('movie'); await settle();
  assert.ok(titles(app).includes('Wind River'));
  assert.ok(html(app).includes('<span class="ro-label">Sheridan</span>') && html(app).includes('<span class="ro-label">Taylor Sheridan</span>'),
    'existing tags are shown as plain text (display-only short form)');
  assert.ok(html(app).includes('With Kids'));
});

test('All Movies lists every saved film from every tab, once, with the same row and state as its collection; unknown rows are reported, not listed', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  setFilter(app, 'fStatus', 'all');
  assert.deepStrictEqual(titles(app), ['Avengers: Doomsday', 'Dune', 'Dune', 'Ewoks: The Battle for Endor', 'F.A.S.T.', 'Sicario', 'Tell Me Who I Am',
    'The Mandalorian &amp; Grogu', 'Wind River']);
  assert.ok(html(app).includes('1 saved entry is neither a TV season nor a film'));
  assert.ok(!html(app).includes('Odd Row') && !html(app).includes('Explicit TV') && !html(app).includes('Lamp Life'));
  const ids = app.get('deriveAllMovies(browseData.rows).films.map(r => r.id)');
  assert.strictEqual(new Set(ids).size, ids.length);
  // Same UUID, same saved state in both projections.
  const inAll = app.get("deriveAllMovies(browseData.rows).films.find(r => r.id === 'f-sicario')");
  await openCol(app, 'browse-sheridan');
  const inCol = app.get("deriveBrowseCollection(browseData.rows, browseData.showsById, 'sheridan', localTodayStr()).films.find(r => r.id === 'f-sicario')");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(inCol)), JSON.parse(JSON.stringify(inAll)));
  assert.strictEqual(inCol.watched, true);
  // The two Dunes (different TMDB ids) stay apart; order is title, source, id.
  assert.deepStrictEqual(Array.from(app.get("deriveAllMovies(browseData.rows).films.filter(r => r.title === 'Dune').map(r => r.id)")), ['f-dune', 'f-dune84']);
});

test('Source in All Movies is the storage tab; Status is the film row’s own; Skipped hidden by default', async () => {
  const app = await boot();
  app.ctx.switchMediaType('movie'); await settle();
  assert.ok(!titles(app).includes('Ewoks: The Battle for Endor'), 'skipped film hidden by default');
  assert.ok(titles(app).includes('Sicario'), 'watched films stay');
  setFilter(app, 'fSource', 'disney');
  assert.deepStrictEqual(titles(app), ['The Mandalorian &amp; Grogu']);
  setFilter(app, 'fStatus', 'skipped');
  assert.deepStrictEqual(titles(app), ['Ewoks: The Battle for Endor']);
  setFilter(app, 'fSource', 'truecrime'); setFilter(app, 'fStatus', '');
  assert.deepStrictEqual(titles(app), ['Tell Me Who I Am']);
  assert.deepStrictEqual(stats(app), ['1 Film', '1 Watched']);
});

test('repeated TMDB identities in different tabs stay separate records: Disney+ shows only its own The Bear; All TV still lists both', async () => {
  const app = await boot();
  await openCol(app, 'browse-disney');
  setFilter(app, 'fSearch', 'bear');
  assert.deepStrictEqual(titles(app), ['The Bear']);
  assert.ok(html(app).includes('Stored in Disney+') && !html(app).includes('Stored in Other TV'));
  assert.ok(!html(app).includes('Up to date'), 'the Other TV copy’s Watching state is not borrowed');
  app.ctx.switchView('alltv'); await settle();
  setFilter(app, 'fSearch', 'bear');
  assert.strictEqual(titles(app).filter(t => t === 'The Bear').length, 2);
});

test('TV follows the show status, never the season status copies; Skipped shows and films hidden by default; Complete and watched stay', async () => {
  const app = await boot();
  await openCol(app, 'browse-sheridan');
  assert.deepStrictEqual(titles(app), ['Tulsa King', 'Yellowstone', 'F.A.S.T.', 'Sicario'], 'Complete Yellowstone and watched Sicario stay');
  await openCol(app, 'browse-disney');
  assert.ok(!titles(app).includes('Wonder Man') && !titles(app).includes('Ewoks: The Battle for Endor'));
  assert.ok(titles(app).includes('The Bear'), 'its season copies all say skipped; the show is On List');
  setFilter(app, 'fStatus', 'skipped');
  assert.deepStrictEqual(titles(app), ['Wonder Man', 'Ewoks: The Battle for Endor']);
  for (const [st, expected] of [['watching', ['Andor']], ['pending', ['Lamp Life', 'Star Wars: Visions']], ['confirmed', ['Explicit TV', 'The Bear', 'The Mandalorian &amp; Grogu']],
    ['highpriority', []], ['complete', []], ['maybe', []]]) {
    setFilter(app, 'fStatus', st);
    assert.deepStrictEqual(titles(app), expected, st);
  }
});

// ─── Presentation ─────────────────────────────────────────────────────────────
test('the media choice hides a section without changing membership; Search and Status survive it; counts follow what is shown', async () => {
  const app = await boot();
  await openCol(app, 'browse-disney');
  setFilter(app, 'fSearch', 'the'); setFilter(app, 'fStatus', 'all');
  assert.deepStrictEqual(stats(app), ['1 Show', '3 Season entries', '2 Films']);
  app.ctx.setBrowseMedia('tv'); await settle();
  assert.ok(app.el('viewHead').innerHTML.includes('Disney+ — TV'));
  assert.deepStrictEqual([app.el('fSearch').value, app.el('fStatus').value], ['the', 'all']);
  assert.deepStrictEqual(titles(app), ['The Bear']);
  assert.deepStrictEqual(stats(app), ['1 Show', '3 Season entries']);
  assert.ok(!html(app).includes('browse-film-row') && !html(app).includes('>Movies <'));
  app.ctx.setBrowseMedia('movie'); await settle();
  assert.deepStrictEqual(titles(app), ['Ewoks: The Battle for Endor', 'The Mandalorian &amp; Grogu']);
  assert.deepStrictEqual(stats(app), ['2 Films']);
  assert.ok(!html(app).includes('browse-show-row'));
  assert.ok(/aria-pressed="true" onclick="setBrowseMedia\('movie'\)"/.test(app.el('filtersRow').innerHTML));
});

test('section labels carry their counts; season entries include Specials and parts; expanding changes no count and reads nothing', async () => {
  const app = await boot();
  await openCol(app, 'browse-sheridan');
  assert.ok(html(app).includes('TV <span class="section-count">2 shows · 3 season entries</span>'));
  assert.ok(html(app).includes('Movies <span class="section-count">2 films</span>'));
  const reqs = app.requests.length;
  const before = app.el('statsRow').innerHTML;
  const yid = app.get("[...browseData.showsById.values()].find(s => s.title === 'Yellowstone').id");
  app.ctx.toggleBrowseShow(yid); await settle();
  assert.strictEqual(app.el('statsRow').innerHTML, before);
  assert.strictEqual(app.requests.length, reqs);
  assert.ok(html(app).includes(`aria-expanded="true" aria-label="Hide seasons of Yellowstone"`));
  const seasonOrder = [...html(app).matchAll(/padding-left:28px"><span class="season-lbl">([^<]*)<\/span>/g)].map(m => m[1]);
  assert.deepStrictEqual(seasonOrder, ['Season 5 (Part 1)', 'Season 5 (Part 2)']);
  app.ctx.toggleBrowseShow(yid); await settle();
  assert.ok(!html(app).includes('sub-row'));
});

test('an expanded show lists every stored season in season order: numbered before Specials; watched, skipped and TBA shown as text', async () => {
  const app = await boot();
  await openCol(app, 'browse-disney');
  setFilter(app, 'fStatus', 'all');
  for (const t of ['The Bear', 'Wonder Man', 'Star Wars: Visions']) {
    app.ctx.toggleBrowseShow(app.get(`[...browseData.showsById.values()].find(s => s.title === ${JSON.stringify(t)} && s.collection === 'disney').id`));
  }
  await settle();
  const labels = [...html(app).matchAll(/padding-left:28px"><span class="season-lbl">([^<]*)<\/span>/g)].map(m => m[1]);
  assert.deepStrictEqual(labels, ['Volume 1', 'Volume 2', 'Season 1', 'Season 2', 'Specials', 'Season 1', 'Season 2']);
  assert.ok(html(app).includes('Season skipped'));
  assert.ok((html(app).match(/✓ Watched/g) || []).length >= 3);
  assert.strictEqual((cards(app).match(/card-subseason-row/g) || []).length, 7, 'the phone cards list the same seasons');
});

test('Up to date only for a Watching show; other statuses get a neutral Next; dates: TBA text or sentinel wins over a guessed date, invalid dates need review', async () => {
  const data = library();
  data.rows.push(legacyFilm({ id: 'f-bad', collection: 'disney', title: 'Bad Date Film', display_date: 'Someday', date_sort: '2026-13-45' }),
    film({ id: 'f-sent', collection: 'truecrime', title: 'Sentinel Doc', display_date: '', date_sort: '2099-01-01' }));
  const app = await boot(data);
  await openCol(app, 'browse-disney');
  setFilter(app, 'fStatus', 'all');
  const rowOf = t => html(app).split('<tr').find(r => r.includes(`<span class="show-title">${t}</span>`));
  assert.ok(rowOf('Andor').includes('Up to date') && rowOf('Andor').includes('Next: Season 2 · premiere date TBA'));
  assert.ok(!rowOf('The Bear').includes('Up to date') && rowOf('The Bear').includes('Next: Season 2'));
  assert.ok(rowOf('Bad Date Film').includes('date needs review') && !rowOf('Bad Date Film').includes('Upcoming'));
  assert.strictEqual(rowOf('The Mandalorian &amp; Grogu').includes('Upcoming'), day(0) < '2026-05-22');
  await openCol(app, 'browse-sheridan');
  assert.ok(rowOf('F.A.S.T.').includes('TBA 2027') && !rowOf('F.A.S.T.').includes('Upcoming'), 'guessed date_sort is not a confirmed release');
  await openCol(app, 'browse-truecrime');
  assert.ok(rowOf('Sentinel Doc').includes('<span class="ro-tag">TBA</span>'));
  app.ctx.switchMediaType('movie'); await settle();
  assert.ok(rowOf('Avengers: Doomsday').includes('Upcoming'));
});

test('order is deterministic: shuffled storage gives byte-identical views', async () => {
  const base = library();
  const outputs = new Set();
  for (let i = 0; i < 6; i++) {
    const rows = base.rows.slice(), shows = base.shows.slice();
    let seed = i * 7919 + 1;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (const arr of [rows, shows]) for (let j = arr.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [arr[j], arr[k]] = [arr[k], arr[j]]; }
    const app = await boot({ rows, shows });
    let out = '';
    for (const id of ['browse-disney', 'browse-sheridan', 'browse-truecrime']) {
      await openCol(app, id);
      setFilter(app, 'fStatus', 'all');
      for (const key of app.get('[...browseData.showsById.keys()].sort()')) app.ctx.toggleBrowseShow(key);
      out += html(app) + cards(app);
    }
    app.ctx.switchMediaType('movie'); await settle();
    setFilter(app, 'fStatus', 'all');
    outputs.add(out + html(app));
  }
  assert.strictEqual(outputs.size, 1);
});

test('empty and no-match states are told apart: no films saved, no TV saved, nothing matches', async () => {
  const app = await boot();
  await openCol(app, 'browse-90day');
  assert.ok(html(app).includes('No films saved in this collection.'));
  assert.deepStrictEqual(stats(app), ['1 Show', '2 Season entries', '0 Films']);
  setFilter(app, 'fSearch', 'zzz');
  assert.ok(html(app).includes('No TV shows match these filters.') && html(app).includes('No films saved in this collection.'));
  const app2 = await boot(all(film({ title: 'Only Film' })));
  await openCol(app2, 'browse-sheridan');
  assert.ok(html(app2).includes('No TV shows saved in Sheridan.') && html(app2).includes('No films saved in this collection.'));
  await openCol(app2, 'browse-disney');
  app2.ctx.switchMediaType('movie'); await settle();
  setFilter(app2, 'fSearch', 'zzz');
  assert.ok(html(app2).includes('No films match these filters.'));
  const app3 = await boot(all());
  app3.ctx.switchMediaType('movie'); await settle();
  assert.ok(html(app3).includes('No films saved yet.') && !html(app3).includes('Failed'), 'an empty library is not a failure');
});

test('a TV season without a show of its collection is counted and reported, never listed as a film or guessed into a show', async () => {
  const data = library();
  const ghost = show({ title: 'Ghost Show' }, [{ season: 'Season 1' }]).rows[0]; // its show is not saved
  const cross = data.rows.find(r => r.collection === 'othertv' && r.show_id);
  data.rows.push(ghost, { ...cross, id: 'cross-1', collection: 'disney', item_key: 'x|season 9', season: 'Season 9' }); // linked to an Other TV show
  const app = await boot(data);
  await openCol(app, 'browse-disney');
  assert.ok(html(app).includes('2 TV season entries aren’t linked to a show saved in Disney+'));
  assert.ok(html(app).includes('onclick="loadBrowseView()">Read again'));
  assert.ok(!html(app).includes('Ghost Show') && !html(app).includes('Season 9'));
  assert.ok(!app.get("deriveAllMovies(browseData.rows).films.some(r => r.id === 'cross-1' || r.title === 'Ghost Show')"));
  assert.deepStrictEqual(mutating(app), []);
});

test('titles with apostrophes, ampersands and markup are escaped; handlers carry ids only', async () => {
  const s = show({ title: `It's <b>Bold</b> & "Long" ${'x'.repeat(120)}`, status: 'confirmed' }, [{ season: 'Season 1' }]);
  const app = await boot(all(s, legacyFilm({ collection: 'disney', title: `Don't <i>Panic</i>` })));
  await openCol(app, 'browse-disney');
  assert.ok(!html(app).includes('<b>Bold') && !html(app).includes('<i>Panic') && !cards(app).includes('<b>Bold'));
  assert.ok(html(app).includes('It&#39;s') || html(app).includes("It's &lt;b&gt;"));
  assert.ok(html(app).includes(`toggleBrowseShow('${s.show.id}')`));
  assertReadOnlyDom(app);
});

test('at phone width the title, Back and media choice stay outside the collapsed filter panel; cards match the table', async () => {
  const app = await boot(library(), { width: 375 });
  await openCol(app, 'browse-sheridan');
  const f = app.el('filtersRow');
  assert.ok(f.classList.contains('collapsed'));
  const inner = f.innerHTML.indexOf('class="filters-inner"');
  assert.ok(app.el('viewHead').innerHTML.includes('browse-title') && app.el('viewHead').innerHTML.includes('Back to TV'));
  assert.ok(f.innerHTML.indexOf("setBrowseMedia('tv')") < inner);
  assert.ok(f.innerHTML.indexOf('id="fSearch"') > inner);
  assert.deepStrictEqual(cardTitles(app), titles(app));
  assert.ok(cards(app).includes('aria-label="Show seasons of Tulsa King"'));
});

// ─── Complete reads ───────────────────────────────────────────────────────────
// Answers the page's fetch with irregular or broken pages; everything else goes to the harness.
function intercept(app, fn) {
  const real = app.ctx.fetch;
  app.ctx.fetch = async (url, opts) => (await fn(url, opts || {}, () => real(url, opts))) ?? real(url, opts);
}
const res = (status, body, headers = {}) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body,
  headers: { get: k => headers[k.toLowerCase()] ?? null } });
const isRead = (u, table) => u.includes(`/rest/v1/${table}?`);

test('irregular short pages are read to the end and give the same view as one page', async () => {
  const app = await boot();
  await openCol(app, 'browse-disney');
  const oneRead = html(app);
  intercept(app, (url, opts) => {
    if (!isRead(url, 'watchlist_items') && !isRead(url, 'tv_shows')) return null;
    const [from] = opts.headers.Range.split('-').map(Number);
    const size = [1, 3, 2, 5][from % 4];
    opts.headers = { ...opts.headers, Range: `${from}-${from + size - 1}` };
    return null;
  });
  const before = app.requests.length;
  app.ctx.loadBrowseView(); await settle(200);
  assert.ok(app.requests.length - before > 10, 'many pages');
  assert.strictEqual(html(app), oneRead);
});

for (const [name, mangle, why] of [
  ['a page without Content-Range', (r) => res(206, r.body, {}), /no exact row count/],
  ['an unknown total ("*")', (r) => res(206, r.body, { 'content-range': r.cr.replace(/\/\d+$/, '/*') }), /no exact row count/],
  ['a malformed Content-Range', (r) => res(206, r.body, { 'content-range': 'items 0-x' }), /no exact row count/],
  ['a total that changes between pages', (r) => r.from > 0 ? res(206, r.body, { 'content-range': r.cr.replace(/\/(\d+)$/, (m, t) => `/${+t + 1}`) }) : null, /row count changed during the read/],
  ['a repeated page', (r) => r.from === 2 && r.table === 'watchlist_items' ? res(206, r.first, { 'content-range': `${r.from}-${r.from + r.first.length - 1}/${r.total}` }) : null, /missing an id or repeated/],
  ['a page that starts at the wrong offset', (r) => r.from > 0 ? res(206, r.body, { 'content-range': `${r.from + 1}-${r.from + r.body.length}/${r.total}` }) : null, /doesn't line up/],
  ['an empty page before the total is reached', (r) => r.from > 0 ? res(206, [], { 'content-range': `*/${r.total}` }) : null, /then an empty page/],
  ['an HTTP error on the second table', (r) => r.table === 'tv_shows' ? res(500, { message: 'boom' }) : null, /Failed reading tv_shows/]
]) {
  test(`strict read: ${name} → Retry and nothing shown, never a partial or empty list`, async () => {
    const app = await boot();
    await openCol(app, 'browse-disney');
    let first = null;
    intercept(app, async (url, opts, pass) => {
      const table = isRead(url, 'watchlist_items') ? 'watchlist_items' : isRead(url, 'tv_shows') ? 'tv_shows' : null;
      if (!table) return null;
      const [from] = opts.headers.Range.split('-').map(Number);
      opts.headers = { ...opts.headers, Range: `${from}-${from + 1}` }; // pages of 2
      const real = await pass();
      const body = await real.json();
      if (table === 'watchlist_items' && from === 0) first = body;
      const cr = real.headers.get('content-range');
      const out = mangle({ table, from, body, first: table === 'watchlist_items' ? first : body, cr, total: Number(cr.split('/')[1]) });
      return out || res(real.status, body, { 'content-range': cr });
    });
    app.ctx.loadBrowseView(); await settle(200);
    assert.ok(html(app).includes('Failed to load') && html(app).includes('onclick="loadBrowseView()">Retry'), html(app).slice(0, 200));
    assert.ok(!/browse-show-row|browse-film-row|No films|No TV/.test(html(app) + cards(app)));
    assert.strictEqual(app.el('statsRow').innerHTML, '');
    assert.ok(app.el('errorBanner').innerHTML.includes("Couldn't read everything that's saved"));
    assert.ok(why.test(app.el('errorBanner').innerHTML.replace(/&#39;|&apos;/g, "'")), app.el('errorBanner').innerHTML);
    assert.strictEqual(app.get('browseData'), null);
  });
}

test('a reported count that never arrives (count mismatch) shows Retry; Retry after the problem clears shows the full view', async () => {
  const app = await boot(library(), { countOverride: 999 });
  await openCol(app, 'browse-disney');
  assert.ok(html(app).includes('Failed to load'));
  app.countOverride = null;
  app.ctx.loadBrowseView(); await settle();
  assert.ok(titles(app).includes('Andor'));
  assert.deepStrictEqual(mutating(app), []);
});

test('the existing backup/derived reader keeps its behaviour (no-count fallback still accepted there)', async () => {
  const app = await boot();
  intercept(app, async (url, opts, pass) => {
    if (!isRead(url, 'tv_shows')) return null;
    const real = await pass();
    return res(real.status, await real.json(), {});
  });
  const shows = await app.ctx.fetchAllRows('tv_shows');
  assert.strictEqual(shows.length, library().shows.length);
  await assert.rejects(app.ctx.fetchAllRowsStrict('tv_shows'), /no exact row count/);
});

// ─── Races ────────────────────────────────────────────────────────────────────
test('a slow read never paints after leaving the view, or over a newer entry of the same view', async () => {
  const app = await boot();
  const g = app.hold(r => r.method === 'GET' && isRead(r.url, 'watchlist_items') && !r.url.includes('collection='));
  app.ctx.openBrowseCollection('browse-disney');
  await g.reached;
  app.ctx.switchView('alltv'); await settle();
  g.release(); await settle();
  assert.strictEqual(app.get('activeViewId'), 'alltv');
  assert.strictEqual(app.get('browseData'), null);
  assert.ok(app.el('tableHead').innerHTML.includes('<th>Next</th>'), 'All TV header intact');

  // Leave and come back while the first read is still out: only the newer read paints.
  const g1 = app.hold(r => r.method === 'GET' && isRead(r.url, 'watchlist_items') && !r.url.includes('collection='));
  app.ctx.openBrowseCollection('browse-sheridan');
  await g1.reached;
  app.ctx.switchView('comingsoon'); await settle();
  app.store.watchlist_items.find(r => r.id === 'f-sicario').title = 'Sicario (newer)';
  await openCol(app, 'browse-sheridan');
  assert.ok(titles(app).includes('Sicario (newer)'));
  const painted = html(app);
  g1.fail(); await settle(); // the old read fails late: its error must not replace the newer view
  assert.strictEqual(html(app), painted);
  assert.strictEqual(app.el('errorBanner').innerHTML, '');
});

test('an old legacy tab load cannot paint over a browse view; its own writes are the legacy loader’s, not the view’s', async () => {
  const app = await boot();
  const g = app.hold(r => r.method === 'GET' && r.url.includes('collection=eq.disney'));
  app.ctx.switchTab('disney');
  await g.reached;
  await openCol(app, 'browse-disney');
  const browseHtml = html(app);
  const mark = app.requests.length;
  g.release(); await settle();
  assert.strictEqual(html(app), browseHtml, 'the late legacy load did not paint');
  assert.strictEqual(app.get('activeViewId'), 'browse-disney');
  const late = mutating(app).filter(r => app.requests.indexOf(r) >= mark).map(r => new URL(r.url).pathname.split('/').pop());
  assert.ok(late.length > 0 && late.every(t => t === 'seed_tv_defaults' || t === 'watchlist_items'), 'only the legacy seeding that was already in flight');
});

test('coming back after an edit in a legacy tab shows the current saved state', async () => {
  const app = await boot();
  await openCol(app, 'browse-sheridan');
  assert.ok(!html(app).split('<tr').find(r => r.includes('>F.A.S.T.<')).includes('✓ Watched'));
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.switchTab('movies'); await settle();
  app.store.watchlist_items.find(r => r.id === 'f-fast').watched = true; // saved elsewhere meanwhile
  await openCol(app, 'browse-sheridan');
  assert.ok(html(app).split('<tr').find(r => r.includes('>F.A.S.T.<')).includes('✓ Watched'));
});

// ─── Regression ───────────────────────────────────────────────────────────────
test('Currently Watching, All TV (Shows and Seasons) and Coming Soon render identically before and after visiting the browse views; All TV’s stored choice is untouched', async () => {
  const data = library();
  const render = async app => {
    let out = '';
    for (const v of ['watching', 'alltv', 'comingsoon']) { app.ctx.switchView(v); await settle(); out += app.el('tableHead').innerHTML + html(app) + cards(app) + app.el('statsRow').innerHTML; }
    app.ctx.switchView('alltv'); await settle(); app.ctx.setAllTvPresentation('seasons'); await settle();
    out += html(app); app.ctx.setAllTvPresentation('shows'); await settle();
    return out;
  };
  const a = await boot(data);
  const before = await render(a);
  const stored = [];
  const b = await boot(data);
  b.ctx.localStorage.setItem = (k, v) => stored.push([k, v]);
  for (const id of ['browse-disney', 'browse-sheridan', 'browse-90day', 'browse-truecrime']) await openCol(b, id);
  b.ctx.switchMediaType('movie'); await settle();
  b.ctx.switchMediaType('tv'); await settle();
  assert.deepStrictEqual(stored, [], 'the browse views store nothing on the device');
  assert.strictEqual(await render(b), before);
});

T.run();
