// Offline tests for B4 metadata (B4/B5 Batch A), in the whole-page harness: the TMDB source
// map at creation (genres and forms by the approved lists, combined TV categories kept as
// unresolved candidates, every network a candidate, Original network never set, companies,
// omitted categories named in the outcome); Details (O7: one guarded call, owner protection,
// resolving a candidate, choosing a network candidate, refusals); the chips and their Original
// label fallback; and the filters (the controlled lists, unresolved candidates as their own
// group, confirmed networks only, seasons inheriting their show's values).
// The database rules: db/test/t_b45.sql (W3, W9). Run from the repo root: node tests/b45-metadata.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('b45-metadata');
const test = T.test;

const TMDB = {
  '/tv/700': { id: 700, name: 'Space Show', networks: [{ name: 'HBO' }, { name: 'Max' }], genres: [{ name: 'Sci-Fi & Fantasy' }, { name: 'Drama' }, { name: 'Animation' }, { name: 'Soap' }, { name: 'Telenovela' }],
    production_companies: [{ name: 'Studio A' }], seasons: [{ season_number: 1, air_date: '2020-01-01', episode_count: 8 }] },
  '/movie/800': { id: 800, title: 'A Film', release_date: '2021-02-02', genres: [{ name: 'Action' }, { name: 'TV Movie' }, { name: 'Documentary' }, { name: 'Weird Genre' }],
    production_companies: [{ name: 'Studio B' }, { name: 'Studio B' }], belongs_to_collection: null }
};
const tmdb = p => {
  if (p.startsWith('/search/')) {
    const all = Object.values(TMDB);
    return { results: p.startsWith('/search/tv') ? all.filter(x => x.name).map(x => ({ id: x.id, name: x.name, first_air_date: '2020-01-01' }))
      : all.filter(x => x.title).map(x => ({ id: x.id, title: x.title, release_date: x.release_date })) };
  }
  return TMDB[p];
};
async function choose(app, id, name, type = 'tv') {
  app.el('tmdbQuery').value = name; await app.ctx.searchTMDB(); await settle();
  await app.ctx.selectTMDBShow(id, name, type, `tmdbResult_0_${id}`); await settle();
}
const outcome = app => (app.el('libraryOutcome')?.innerHTML || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const body = (app, fn) => app.writes().filter(r => r.url.endsWith(`/rpc/${fn}`)).map(r => JSON.parse(JSON.stringify(r.body)));
const out = v => JSON.parse(JSON.stringify(v));

let n = 0;
const showRec = (o = {}) => ({ id: `s${++n}`, collection: 'othertv', title: o.title || `Show ${n}`, show_key: (o.title || `show ${n}`).toLowerCase(), tmdb_id: 1000 + n, status: 'confirmed', ...o });
const seasonRec = (sh, o = {}) => ({ id: `r${++n}`, collection: sh.collection, title: sh.title, theme: o.theme || 'HBO', status: 'confirmed', watched: false, skipped: false,
  show_id: sh.id, media_type: 'tv', tmdb_id: sh.tmdb_id, season_number: 1, season: 'Season 1', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `${sh.show_key}|season 1`, watch_with: [], collections: [], ...o });
const filmRec = (o = {}) => ({ id: `f${++n}`, collection: 'movies', title: o.title || `Film ${n}`, theme: 'Drama', status: 'confirmed', watched: false,
  media_type: 'movie', tmdb_id: 5000 + n, season_number: null, season: 'Film', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
  item_key: `film ${n}|film`, watch_with: [], collections: [], show_id: null, skipped: false, ...o });

// ─── The source map (§5.2) and sourcing at creation (§5.5) ────────────────────
test('tmdbMetadata: the approved lists; combined TV categories as candidates (never split); every network a candidate; Original network never set; unknown categories omitted and named', async () => {
  const app = await createApp();
  const tv = out(app.ctx.tmdbMetadata('tv', TMDB['/tv/700']));
  assert.deepStrictEqual(tv, { genres: ['Drama'], forms: ['Animation', 'Soap'], genre_candidates: ['Sci-Fi & Fantasy'], companies: ['Studio A'],
    unmapped: ['Telenovela'], omitted: [], network_candidates: ['HBO', 'Max'] });
  assert.ok(!('network' in tv), 'Original network is never set automatically');
  const mv = out(app.ctx.tmdbMetadata('movie', TMDB['/movie/800']));
  assert.deepStrictEqual(mv, { genres: ['Action'], forms: ['TV Movie', 'Documentary'], genre_candidates: [], companies: ['Studio B'], unmapped: ['Weird Genre'], omitted: [] });
  assert.strictEqual(app.get('GENRES.length'), 19);
  assert.strictEqual(app.get('FORMS.length'), 11);
  const single = out(app.ctx.tmdbMetadata('tv', { networks: [{ name: 'BBC' }], genres: [{ name: 'Action & Adventure' }, { name: 'War & Politics' }, { name: 'Kids' }] }));
  assert.deepStrictEqual([single.network_candidates, single.genre_candidates, single.genres], [['BBC'], ['Action & Adventure', 'War & Politics'], ['Kids']], 'a single network is a candidate too');
  const many = Array.from({ length: 14 }, (_, i) => ` Co ${i % 12} `).concat(['x'.repeat(81), '', 'co 1']);
  assert.deepStrictEqual(out(app.ctx.labelList(many)), Array.from({ length: 10 }, (_, i) => `Co ${i}`), 'trimmed, no case-insensitive repeat, at most 80 characters, at most 10');
  // (GA-1 review 1: what sourcing can't keep is named, never silently dropped.)
  const lots = out(app.ctx.tmdbMetadata('movie', { genres: [], production_companies: [...Array.from({ length: 11 }, (_, i) => ({ name: `Co ${i}` })), { name: 'y'.repeat(81) }] }));
  assert.strictEqual(lots.companies.length, 10);
  assert.deepStrictEqual(lots.omitted, ['“Co 10” (company: more than 10)', `“${'y'.repeat(40)}…” (company: longer than 80 characters)`]);
});

test('the movie tools name what TMDB sourcing left out in their outcome (plan §5.2), once', async () => {
  const app = await createApp();
  app.ctx.switchMediaType('movie'); await settle();
  const details = { genres: [{ name: 'Action' }, { name: 'Weird Genre' }], production_companies: [{ name: 'z'.repeat(90) }] };
  const fields = out(app.ctx.creationMetadata('movie', details, 'Tool Film'));
  assert.deepStrictEqual([fields.genres, fields.companies, 'unmapped' in fields, 'omitted' in fields], [['Action'], [], false, false], 'the request carries only stored fields');
  await app.ctx.libraryInsertFilms([{ item_key: 'tool film|film', title: 'Tool Film', season: 'Film', theme: 'Action', display_date: 'Jan 1, 2020', date_sort: '2020-01-01',
    watched: false, status: 'confirmed', ...fields, media_type: 'movie', tmdb_id: 4242, season_number: null }]); await settle();
  assert.match(app.el('banner').innerHTML, /TMDB categories not used: Tool Film: Weird Genre, “z{40}…” \(company: longer than 80 characters\)\./);
  assert.strictEqual(app.ctx.takeSourcingNote(['Tool Film']), '', 'reported once');
});

test('a new TMDB show and a new TMDB film carry their sourced metadata; the outcome names the omitted categories; the legacy theme is written as before', async () => {
  const app = await createApp({ tmdb });
  app.ctx.switchView('alltv'); await settle();
  app.ctx.openLibraryPanel('tv'); await settle();
  await choose(app, 700, 'Space Show');
  app.el('tmdbPreview').querySelectorAll = sel => (sel.includes('data-season') ? [{ checked: true, disabled: false, dataset: { season: '1' } }] : []);
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  const [show] = body(app, 'library_create_show_b45');
  assert.deepStrictEqual([show.p_show.network, show.p_show.genres, show.p_show.forms, show.p_show.genre_candidates, show.p_show.companies, show.p_show.network_candidates],
    ['HBO', ['Drama'], ['Animation', 'Soap'], ['Sci-Fi & Fantasy'], ['Studio A'], ['HBO', 'Max']]);
  assert.ok(!('original_network' in show.p_show));
  assert.match(outcome(app), /TMDB categories not used: Telenovela\./);
  const stored = app.store.tv_shows.find(s => s.tmdb_id === 700);
  assert.deepStrictEqual([stored.network, stored.metadata_owner_set, stored.status, stored.priority, stored.catalog_new], [null, false, 'confirmed', 'normal', false]);
  assert.strictEqual(app.store.watchlist_items.find(r => r.show_id === stored.id).theme, 'HBO', 'the legacy label as today');
  app.ctx.switchMediaType('movie'); await settle();
  app.ctx.openLibraryPanel('movie'); await settle();
  await choose(app, 800, 'A Film', 'movie');
  await app.ctx.addSelectedTMDBSeasons(); await settle();
  const [films] = body(app, 'library_add_films_b45');
  assert.deepStrictEqual([films.p_films[0].genres, films.p_films[0].forms, films.p_films[0].companies, films.p_films[0].theme], [['Action'], ['TV Movie', 'Documentary'], ['Studio B'], 'Action']);
  assert.match(outcome(app), /Added “A Film”\. TMDB categories not used: Weird Genre\./);
  const f = app.store.watchlist_items.find(r => r.tmdb_id === 800);
  assert.deepStrictEqual([f.priority, f.catalog_new, f.status_review, f.legacy_status, f.metadata_owner_set, f.genres], ['normal', false, false, null, false, ['Action']]);
});

// ─── Details (O7) ─────────────────────────────────────────────────────────────
async function detailsApp(rec, kind, extra = {}) {
  const isShow = kind === 'show';
  const app = await createApp(isShow ? { tvShows: [rec], rows: extra.rows || [seasonRec(rec)] } : { rows: [rec] });
  if (isShow) { app.ctx.switchView('alltv'); await settle(); } else { app.ctx.switchMediaType('movie'); await settle(); app.el('fWatch').value = ''; app.ctx.renderTable(); }
  app.ctx.openDetails(kind, rec.id); await settle();
  return app;
}
const box = app => app.el('detailsModalBox').innerHTML;
const boxText = app => box(app).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const dlg = app => app.get('detailsDialog');
const gi = (app, name) => app.get(`GENRES.indexOf(${JSON.stringify(name)})`);
const fi = (app, name) => app.get(`FORMS.indexOf(${JSON.stringify(name)})`);
const EMPTY_SHOW_META = { genres: [], forms: [], franchises: [], companies: [], genre_candidates: [], network: null, network_candidates: [], metadata_owner_set: false };

test('Details shows the stored values exactly (commas included) in a per-value editor; resolves a candidate; picks a network candidate; Save is one guarded call bound to the values it displayed', async () => {
  const s = showRec({ title: 'Space Show', genres: ['Drama'], genre_candidates: ['Sci-Fi & Fantasy'], network_candidates: ['HBO', 'Max'],
    companies: ['Warner Bros. Pictures, Inc.', 'Studio A'], franchises: ['Star Wars, Legends'] });
  const app = await detailsApp(s, 'show');
  const html = box(app);
  assert.ok(html.includes('Original label') && html.includes('HBO'));
  assert.strictEqual((html.match(/name="detailsGenre"/g) || []).length, 19);
  assert.strictEqual((html.match(/name="detailsForm"/g) || []).length, 11);
  assert.ok(html.includes('value="Warner Bros. Pictures, Inc."') && html.includes('value="Star Wars, Legends"'), 'each value in its own input, commas kept');
  assert.ok(html.includes('Unresolved category') && html.includes('Unresolved source category: Sci-Fi &amp; Fantasy'));
  assert.ok(html.includes('Network candidates (TMDB):') && html.includes('detailsPickNetwork(1)'));
  app.ctx.detailsToggle('forms', fi(app, 'Animation'), true);
  app.ctx.detailsResolve(0, 'both');
  app.ctx.detailsPickNetwork(1);
  app.ctx.detailsAddValue('franchises');
  app.ctx.detailsSetValue('franchises', 1, '  Space, the Final Frontier  ');
  await app.ctx.saveDetails(); await settle();
  const [call] = body(app, 'library_set_metadata_b45');
  assert.deepStrictEqual(call, { p_kind: 'show', p_id: s.id,
    p_expected: { ...EMPTY_SHOW_META, genres: ['Drama'], companies: ['Warner Bros. Pictures, Inc.', 'Studio A'], franchises: ['Star Wars, Legends'], genre_candidates: ['Sci-Fi & Fantasy'], network_candidates: ['HBO', 'Max'] },
    p_metadata: { genres: ['Drama', 'Fantasy', 'Science Fiction'], forms: ['Animation'], franchises: ['Star Wars, Legends', 'Space, the Final Frontier'],
      companies: ['Warner Bros. Pictures, Inc.', 'Studio A'], genre_candidates: [], network: 'Max', network_candidates: ['HBO', 'Max'] } });
  const st = app.store.tv_shows.find(x => x.id === s.id);
  assert.deepStrictEqual([st.companies, st.franchises, st.network, st.genre_candidates, st.metadata_owner_set],
    [['Warner Bros. Pictures, Inc.', 'Studio A'], ['Star Wars, Legends', 'Space, the Final Frontier'], 'Max', [], true], 'stored exactly');
  assert.strictEqual(app.el('detailsModalOverlay').style.display, 'none', 'closed after saving');
  // Reopened: the same values come back unchanged (a round trip changes nothing).
  app.ctx.openDetails('show', s.id); await settle();
  await app.ctx.saveDetails(); await settle();
  assert.deepStrictEqual(body(app, 'library_set_metadata_b45')[1].p_metadata.companies, ['Warner Bros. Pictures, Inc.', 'Studio A']);
});

test('Details refuses what the database wouldn’t accept, says why, sends nothing and keeps the draft: more than 10 values, over 80 characters, a repeat, more than 10 genres; corrected, it saves exactly', async () => {
  const f = filmRec({ title: 'Valid' });
  const app = await detailsApp(f, 'film');
  for (let i = 0; i < 11; i++) { app.ctx.detailsAddValue('companies'); app.ctx.detailsSetValue('companies', i, `Co, ${i}`); }
  app.ctx.detailsAddValue('franchises'); app.ctx.detailsSetValue('franchises', 0, 'x'.repeat(81));
  app.ctx.detailsAddValue('franchises'); app.ctx.detailsSetValue('franchises', 1, 'Saga');
  app.ctx.detailsAddValue('franchises'); app.ctx.detailsSetValue('franchises', 2, 'saga');
  ['Action', 'Adventure', 'Comedy', 'Crime', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Kids', 'Music'].forEach(g => app.ctx.detailsToggle('genres', gi(app, g), true));
  await app.ctx.saveDetails(); await settle();
  assert.deepStrictEqual(body(app, 'library_set_metadata_b45'), [], 'nothing sent');
  const t = boxText(app);
  assert.match(t, /Not saved: /);
  assert.match(t, /Production company: at most 10 values \(there are 11\)\./);
  assert.match(t, /Franchise \/ universe: “x{30}…” is longer than 80 characters\./);
  assert.match(t, /Franchise \/ universe: “saga” is listed twice\./);
  assert.match(t, /Genres: at most 10 values \(there are 11\)\./);
  assert.ok(box(app).includes('value="Co, 10"') && box(app).includes('value="saga"'), 'the draft is kept for correction');
  app.ctx.detailsRemoveValue('companies', 10); app.ctx.detailsRemoveValue('franchises', 2); app.ctx.detailsRemoveValue('franchises', 0);
  app.ctx.detailsToggle('genres', gi(app, 'Music'), false);
  await app.ctx.saveDetails(); await settle();
  const [call] = body(app, 'library_set_metadata_b45');
  assert.deepStrictEqual([call.p_metadata.companies.length, call.p_metadata.companies[3], call.p_metadata.franchises, call.p_metadata.genres.length], [10, 'Co, 3', ['Saga'], 10]);
});

test('Details saving with every field empty still records the owner’s choice; the chips then show nothing (no Original label fallback); a film has no network fields', async () => {
  const f = filmRec({ title: 'Plain', theme: 'Drama' });
  const app = await detailsApp(f, 'film');
  assert.ok(app.el('tbody').innerHTML.includes('data-filter-value="Drama"'), 'before: the Original label badge');
  assert.ok(!box(app).includes('detailsNetwork'), 'no network on a film');
  await app.ctx.saveDetails(); await settle();
  assert.deepStrictEqual(body(app, 'library_set_metadata_b45')[0].p_metadata, { genres: [], forms: [], franchises: [], companies: [], genre_candidates: [] });
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === f.id).metadata_owner_set, true);
  const row = app.el('tbody').innerHTML.split('<tr').find(x => x.includes('show-title">Plain<'));
  assert.ok(!/data-filter-kind="theme"/.test(row.split('</td>')[1] || ''), 'no fallback badge once the owner has saved');
  assert.strictEqual(app.store.watchlist_items.find(r => r.id === f.id).theme, 'Drama');
});

test('Details lifecycle: a refresh while editing never makes the draft adopt newer values — Save sends the values the dialog displayed and the database refuses; the dialog locks, keeps the draft, the list is read again; only “Start again” takes the current values', async () => {
  const s = showRec({ title: 'S', companies: ['Old Co'] });
  const app = await detailsApp(s, 'show');
  app.ctx.detailsSetValue('companies', 0, 'My Co');
  app.store.tv_shows.find(x => x.id === s.id).companies = ['Other Page Co']; // another page saved meanwhile
  app.ctx.loadDerivedView(); await settle(); // the page reads the newer value
  assert.deepStrictEqual(Array.from(app.get(`tvShowsById.get('${s.id}').companies`)), ['Other Page Co']);
  app.ctx.renderDetails(); // (any redraw of the open dialog draws its own draft, not the newer values)
  assert.ok(box(app).includes('value="My Co"') && !box(app).includes('value="Other Page Co"'), 'the open dialog still shows its draft');
  const before = app.requests.length;
  await app.ctx.saveDetails(); await settle(); await settle();
  const [call] = body(app, 'library_set_metadata_b45');
  assert.deepStrictEqual(call.p_expected.companies, ['Old Co'], 'the expected values are the ones the dialog displayed');
  assert.deepStrictEqual(app.store.tv_shows.find(x => x.id === s.id).companies, ['Other Page Co'], 'the newer value is not overwritten');
  assert.ok(app.requests.slice(before).some(r => r.method === 'GET' && r.url.includes('/tv_shows?')), 'the list was read again');
  const t = boxText(app);
  assert.match(t, /This changed since the page showed it, so nothing was changed\./);
  assert.match(t, /This entry changed since this dialog opened, so nothing was saved\. Your entries are shown for reference/);
  assert.match(t, /The list has been read again; look at it again\./);
  assert.ok(box(app).includes('value="My Co"') && box(app).includes('detailsRestart()') && !box(app).includes('saveDetails()'), 'draft kept; Save replaced by Start again');
  await app.ctx.saveDetails(); await settle();
  assert.strictEqual(body(app, 'library_set_metadata_b45').length, 1, 'never resent');
  app.ctx.detailsRestart(); await settle();
  assert.ok(box(app).includes('value="Other Page Co"') && !box(app).includes('value="My Co"'), 'Start again: the current values, the draft discarded');
  assert.deepStrictEqual(Array.from(dlg(app).snapshot.companies), ['Other Page Co']);
});

test('Details lifecycle: after a restore the dialog sends nothing and says so; an answer that arrives after a restore changes nothing restored and closes only its own dialog', async () => {
  const s = showRec({ title: 'S' });
  const app = await detailsApp(s, 'show');
  app.run('orgEpoch++'); // a restore completed in this page
  await app.ctx.saveDetails(); await settle();
  assert.deepStrictEqual(body(app, 'library_set_metadata_b45'), []);
  assert.match(boxText(app), /A restore happened since this dialog opened, so it can’t save\./);
  app.ctx.detailsRestart(); await settle();
  app.ctx.detailsAddValue('franchises'); app.ctx.detailsSetValue('franchises', 0, 'Before Restore');
  const g = app.hold(r => r.url.endsWith('/rpc/library_set_metadata_b45'));
  const p = app.ctx.saveDetails();
  await g.reached;
  app.run('orgEpoch++');
  g.releaseWith({ tv_shows: JSON.parse(JSON.stringify(app.store.tv_shows)) }); await p; await settle(); await settle();
  assert.match(app.el('banner').innerHTML, /“S” · details was sent before the restore and answered afterwards\./);
  assert.strictEqual(app.el('detailsModalOverlay').style.display, 'none');
});

test('Details lifecycle: a delayed answer for an earlier opening never closes or changes a newer dialog (success or refusal); its data still lands', async () => {
  const a = showRec({ title: 'A' }), b = showRec({ title: 'B' });
  const app = await createApp({ tvShows: [a, b], rows: [seasonRec(a), seasonRec(b)] });
  app.ctx.switchView('alltv'); await settle();
  for (const outcome of ['success', 'refusal']) {
    app.ctx.openDetails('show', a.id); await settle();
    app.ctx.detailsAddValue('franchises'); app.ctx.detailsSetValue('franchises', 0, `A ${outcome}`);
    if (outcome === 'refusal') app.store.tv_shows.find(x => x.id === a.id).companies = ['Changed'];
    const g = app.hold(r => r.url.endsWith('/rpc/library_set_metadata_b45'));
    const p = app.ctx.saveDetails();
    await g.reached;
    app.ctx.closeDetails();
    app.ctx.openDetails('show', b.id); await settle();
    app.ctx.detailsAddValue('companies'); app.ctx.detailsSetValue('companies', 0, 'B draft');
    const session = dlg(app).session;
    g.release(); await p; await settle(); await settle();
    const d = dlg(app);
    assert.ok(d && d.session === session && d.id === b.id && !d.stale && d.error === '', `${outcome}: the newer dialog is untouched`);
    app.ctx.renderDetails();
    assert.ok(box(app).includes('value="B draft"'), `${outcome}: its draft kept`);
    if (outcome === 'success') assert.deepStrictEqual(Array.from(app.get(`tvShowsById.get('${a.id}').franchises`)), ['A success'], 'the earlier save landed');
    else assert.match(app.el('errorBanner').innerHTML, /This changed since the page showed it/, 'the refusal is reported outside the newer dialog');
    app.ctx.closeDetails();
  }
});

test('Details: no clear answer → not confirmed, never resent; the list is read again; a failed reread is said so', async () => {
  const s = showRec({ title: 'S' });
  const app = await detailsApp(s, 'show');
  app.ctx.detailsAddValue('franchises'); app.ctx.detailsSetValue('franchises', 0, 'Unknown');
  const g = app.hold(r => r.url.endsWith('/rpc/library_set_metadata_b45'));
  app.failNext(r => r.method === 'GET' && r.url.includes('/tv_shows?')); // the reread will fail
  const p = app.ctx.saveDetails();
  await g.reached; g.fail(); await p; await settle(); await settle();
  const t = boxText(app);
  assert.match(t, /This change wasn’t confirmed[\s\S]*won’t be sent again/);
  assert.match(t, /The save wasn’t confirmed and won’t be sent again\. Your entries are shown for reference/);
  assert.match(t, /The list couldn’t be read again, so what is shown may be out of date; use Retry\./);
  assert.ok(box(app).includes('value="Unknown"'));
  await settle(50);
  assert.strictEqual(body(app, 'library_set_metadata_b45').length, 1, 'never resent');
});

test('Details viewing progress (§4.7 placement): Caught up · Ended; earlier unwatched seasons with Watch earlier seasons (the same guarded call); the range’s state with Stop; an inert range with Choose again / Stop', async () => {
  const mk = (title, o, specs) => { const sh = showRec({ title, status: 'watching', ...o }); const rows = specs.map((sp, i) => seasonRec(sh, { id: `${title}-${i + 1}`, season_number: i + 1, season: `Season ${i + 1}`,
    item_key: `${title.toLowerCase()}|season ${i + 1}`, date_sort: `201${i}-01-01`, ...sp })); return { sh, rows }; };
  const ended = mk('Ended', { ended: true }, [{ watched: true }, { watched: true }]);
  const gap = mk('Gap', { ended: true }, [{}, { watched: true }]);
  const inert = mk('Inert', {}, [{}, { watched: true }]);
  Object.assign(inert.sh, { resume_start_season_id: 'Inert-2', resume_end_season_id: 'Inert-1' });
  const app = await createApp({ tvShows: [ended.sh, gap.sh, inert.sh], rows: [...ended.rows, ...gap.rows, ...inert.rows] });
  app.ctx.switchView('alltv'); await settle();
  app.ctx.openDetails('show', ended.sh.id); await settle();
  assert.match(boxText(app), /Viewing progress Caught up · Ended/);
  app.ctx.closeDetails();
  app.ctx.openDetails('show', gap.sh.id); await settle();
  assert.match(boxText(app), /Caught up · Ended · 1 earlier season unwatched/);
  assert.ok(box(app).includes('Watch earlier seasons…'));
  app.ctx.detailsTogglePicker(); await settle();
  assert.ok(box(app).includes(`startResume('${gap.sh.id}', 'Gap-1')`));
  await app.ctx.startResume(gap.sh.id, 'Gap-1'); await settle();
  assert.deepStrictEqual(app.writes().map(r => r.url.split('/rpc/')[1]), ['library_set_resume_b45']);
  assert.match(boxText(app), /Watching earlier seasons from Season 1/);
  assert.ok(!/Caught up · Ended/.test(boxText(app)), 'an active range waives the Ended exit');
  assert.ok(box(app).includes('Stop watching earlier seasons'));
  app.ctx.closeDetails();
  app.ctx.openDetails('show', inert.sh.id); await settle();
  assert.match(boxText(app), /Earlier-seasons range no longer applies; choose again or stop/);
  assert.ok(box(app).includes('>Choose again<') && box(app).includes(`stopResume('${inert.sh.id}')`));
  await app.ctx.stopResume(inert.sh.id); await settle();
  assert.strictEqual(app.store.tv_shows.find(x => x.id === inert.sh.id).resume_start_season_id, null);
  assert.ok(!/no longer applies/.test(boxText(app)), 'the dialog shows the cleared range');
});

// ─── Chips and filters (§5.2, §5.4, §5.5) ─────────────────────────────────────
test('filters: Genre offers the 19 genres plus “Unresolved source categories”; a genre matches asserted values only, a candidate only candidates; Network lists confirmed values only; seasons inherit their show’s values', async () => {
  const a = showRec({ title: 'Asserted', genres: ['Science Fiction'], network: 'HBO', network_candidates: ['HBO'] });
  const b = showRec({ title: 'Candidate', genre_candidates: ['Sci-Fi & Fantasy'], network_candidates: ['Max'] });
  const c = showRec({ title: 'Neither' });
  const app = await createApp({ tvShows: [a, b, c], rows: [seasonRec(a), seasonRec(b), seasonRec(c)] });
  app.ctx.switchView('alltv'); await settle();
  const f = app.el('filtersRow').innerHTML;
  const genreOpts = [...(f.match(/id="fGenre"[\s\S]*?<\/select>/) || [''])[0].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
  assert.strictEqual(genreOpts.length, 1 + 19 + 1);
  assert.ok(f.includes('<optgroup label="Unresolved source categories"><option value="cand:Sci-Fi &amp; Fantasy">Sci-Fi &amp; Fantasy (unresolved)</option>'));
  const netOpts = [...(f.match(/id="fNetwork"[\s\S]*?<\/select>/) || [''])[0].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
  assert.deepStrictEqual(netOpts, ['', 'HBO'], 'confirmed networks only, never candidates');
  const titles = () => [...app.el('tbody').innerHTML.matchAll(/show-title">([^<]*)</g)].map(m => m[1]);
  app.el('fGenre').value = 'Science Fiction'; app.ctx.renderTable(); assert.deepStrictEqual(titles(), ['Asserted']);
  app.el('fGenre').value = 'cand:Sci-Fi & Fantasy'; app.ctx.renderTable(); assert.deepStrictEqual(titles(), ['Candidate']);
  app.el('fGenre').value = ''; app.el('fNetwork').value = 'HBO'; app.ctx.renderTable(); assert.deepStrictEqual(titles(), ['Asserted']);
  app.el('fNetwork').value = '';
  app.ctx.setAllTvPresentation('seasons'); await settle();
  app.el('fGenre').value = 'Science Fiction'; app.ctx.renderTable();
  assert.deepStrictEqual([...app.el('tbody').innerHTML.matchAll(/show-title">([^<]*)</g)].map(m => m[1]), ['Asserted'], 'a season inherits its show’s genres');
  assert.ok(!app.el('tbody').innerHTML.includes('data-filter-value="Sci-Fi &amp; Fantasy"'), 'a candidate is never a chip');
  app.ctx.setAllTvPresentation('shows'); await settle();
  assert.deepStrictEqual(app.writes(), []);
});

test('chips: categorized values as filter pills (two genres, then +N); the Original label only while everything is empty and not owner set; a candidate is never a chip', async () => {
  const many = showRec({ title: 'Many', genres: ['Drama', 'Crime', 'Mystery'], forms: ['Limited series'], franchises: ['Saga'] });
  const none = showRec({ title: 'None', genre_candidates: ['Sci-Fi & Fantasy'] });
  const app = await createApp({ tvShows: [many, none], rows: [seasonRec(many, { theme: 'Netflix' }), seasonRec(none, { theme: 'Netflix' })] });
  app.ctx.switchView('alltv'); await settle();
  const row = t => app.el('tbody').innerHTML.split('<tr').find(x => x.includes(`show-title">${t}<`));
  assert.ok(/data-filter-value="Drama"[\s\S]*data-filter-value="Crime"[\s\S]*\+1/.test(row('Many')) && row('Many').includes('data-filter-value="Limited series"') && row('Many').includes('data-filter-value="Saga"'));
  assert.ok(!row('Many').includes('data-filter-value="Netflix"'), 'no Original label once a category is set');
  assert.ok(row('None').includes('data-filter-value="Netflix"') && !row('None').includes('Sci-Fi'), 'Original label fallback; the candidate isn’t shown as a genre');
  // A chip is a filter pill: it sets (and clears) its category filter.
  const titles = () => [...app.el('tbody').innerHTML.matchAll(/show-title">([^<]*)</g)].map(m => m[1]);
  app.ctx.toggleFilterPill({ dataset: { filterKind: 'genres', filterValue: 'Crime', pillOwner: many.id } }); await settle();
  assert.strictEqual(app.el('fGenre').value, 'Crime');
  assert.deepStrictEqual(titles(), ['Many']);
  app.ctx.toggleFilterPill({ dataset: { filterKind: 'genres', filterValue: 'Crime', pillOwner: many.id } }); await settle();
  assert.deepStrictEqual(titles(), ['Many', 'None']);
  assert.deepStrictEqual(app.writes(), []);
});

T.run();
