// Offline tests for the B5 viewing model on TV shows (B4/B5 Batch A), in the whole-page
// harness: the status, priority and Show ended controls and the guarded calls they send
// (O1 / O2 / O3), the markers (New from catalog, Needs status review) and their dismissals
// (O5 one and all, O6), refusals, cancellations and unknown outcomes; Currently Watching
// membership (the Ended exit, the all-skipped exclusion; plan §4.7.2–4.7.3, CW1); the
// earlier-seasons range (O9; O1 + O9) and its progression (§4.7.4, CW2); and the labels (U1).
// The database rules themselves are checked on PGlite (db/test/t_b45.sql W1–W10); the
// harness's _b45 functions are independent stand-ins (tests/b45-harness.js).
// Run from the repo root: node tests/b45-status.test.js
const assert = require('assert');
const { createApp, runner, settle } = require('./app-harness');

const T = runner('b45-status');
const test = T.test;

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
let n = 0;
const nid = p => `${p}${String(++n).padStart(4, '0')}`;
// A show and its seasons. Season specs: { num, w, s, date, tba, id }.
function show(o, specs) {
  const s = { id: nid('show'), collection: 'othertv', title: o.title || 'Show', show_key: (o.title || 'Show').toLowerCase(), tmdb_id: 100 + n, status: 'confirmed', ...o };
  const rows = specs.map(sp => {
    const num = sp.num !== undefined ? sp.num : 1;
    const label = num === 0 ? 'Specials' : `Season ${num}`;
    const date = sp.tba ? '2099-01-01' : (sp.date || `20${10 + num}-01-01`);
    return { id: sp.id || nid('r'), collection: s.collection, title: s.title, theme: 'HBO', status: 'confirmed', watched: !!sp.w, skipped: !!sp.s, show_id: s.id,
      media_type: 'tv', tmdb_id: s.tmdb_id, season_number: num, season: label, display_date: sp.tba ? 'TBA' : date, date_sort: date,
      item_key: `${s.show_key}|${label.toLowerCase()}`, watch_with: [], collections: [] };
  });
  return { show: s, rows };
}
const all = (...xs) => ({ rows: xs.flatMap(x => x.rows), shows: xs.map(x => x.show) });
async function open(view, data, opts = {}) {
  const app = await createApp({ rows: data.rows, tvShows: data.shows, ...opts });
  app.ctx.switchView(view); await settle();
  if (app.el('fStatus')) { app.el('fStatus').value = 'all'; app.ctx.renderTable(); }
  return app;
}
const body = app => app.el('tbody').innerHTML + '\n' + app.el('cardList').innerHTML;
const rowOf = (app, title) => app.el('tbody').innerHTML.split('<tr').find(x => x.includes(`show-title">${title}<`)) || '';
const calls = (app, fn) => app.writes().filter(r => r.url.endsWith(`/rpc/${fn}`)).map(r => JSON.parse(JSON.stringify(r.body)));
const stored = (app, id) => app.store.tv_shows.find(s => s.id === id);
const banner = app => app.el('errorBanner').innerHTML;
const STATE = { status: 'confirmed', priority: 'normal', ended: false, catalog_new: false, status_review: false };
const watchingIds = app => {
  const today = app.get('localTodayStr()');
  const r = app.ctx.deriveCurrentlyWatching(app.get('derivedData').rows, app.get('tvShowsById'), today);
  return { active: Array.from(r.active, x => x.show.title), upToDate: Array.from(r.upToDate, x => x.show.title) };
};

// ─── Controls and labels (§4.6, U1) ───────────────────────────────────────────
test('controls: To Watch / ▶ Watching / ✕ Skipped, ★ High / Normal / Low beside it; ★ before the title with an accessible label, Low after it; no row dimming', async () => {
  const hi = show({ title: 'Hi', priority: 'high' }, [{ num: 1 }]);
  const lo = show({ title: 'Lo', priority: 'low' }, [{ num: 1 }]);
  const app = await open('alltv', all(hi, lo));
  const r = rowOf(app, 'Hi');
  assert.ok(/<option value="confirmed" selected>To Watch<\/option><option value="watching">▶ Watching<\/option><option value="skipped">✕ Skipped<\/option>/.test(r), r);
  assert.ok(/<option value="high" selected>★ High<\/option><option value="normal">Normal<\/option><option value="low">Low<\/option>/.test(r));
  assert.ok(r.includes('<span class="priority-high" role="img" aria-label="High priority" title="High priority">★</span> <span class="show-title">Hi</span>'));
  assert.ok(rowOf(app, 'Lo').includes('<span class="show-title">Lo</span> <span class="priority-low" title="Low priority">Low</span>'));
  assert.ok(!/row-maybe/.test(body(app)), 'no dimming for Low');
});

test('the status filter is All (except Skipped) · All · To Watch · Watching · Skipped; priority Any · High · Normal · Low · High + Normal; markers are two checkboxes', async () => {
  const a = show({ title: 'A', priority: 'high' }, [{ num: 1 }]), b = show({ title: 'B', priority: 'low', catalog_new: true }, [{ num: 1 }]);
  const c = show({ title: 'C', status_review: true, legacy_status: 'complete', ended: true }, [{ num: 1 }]);
  const app = await open('alltv', all(a, b, c));
  const f = app.el('filtersRow').innerHTML;
  const opts = id => [...(f.match(new RegExp(`id="${id}"[\\s\\S]*?</select>`)) || [''])[0].matchAll(/<option value="([^"]*)">([^<]*)</g)].map(m => `${m[1]}=${m[2]}`);
  assert.deepStrictEqual(opts('fStatus'), ['=All (except Skipped)', 'all=All statuses', 'confirmed=To Watch', 'watching=Watching', 'skipped=Skipped']);
  assert.deepStrictEqual(opts('fPriority'), ['=Any priority', 'high=★ High', 'normal=Normal', 'low=Low', 'highnormal=High + Normal']);
  assert.ok(f.includes('id="fNew"') && f.includes('New from catalog') && f.includes('id="fReview"') && f.includes('Needs status review'));
  const titles = () => [...app.el('tbody').innerHTML.matchAll(/show-title">([^<]*)</g)].map(m => m[1]);
  app.el('fPriority').value = 'highnormal'; app.ctx.renderTable(); assert.deepStrictEqual(titles(), ['A', 'C']);
  app.el('fPriority').value = ''; app.el('fNew').checked = true; app.ctx.renderTable(); assert.deepStrictEqual(titles(), ['B']);
  app.el('fNew').checked = false; app.el('fReview').checked = true; app.ctx.renderTable(); assert.deepStrictEqual(titles(), ['C']);
  app.ctx.renderFilters(); assert.strictEqual(app.el('fReview').checked, true, 'a ticked marker survives a redraw');
  assert.ok(rowOf(app, 'C').includes('Ended') && rowOf(app, 'C').includes('Review status'));
  assert.deepStrictEqual(app.writes(), []);
});

// ─── O1 / O2 / O3 (W1, page side) ─────────────────────────────────────────────
test('O1 from the selector: one guarded call with the shown state; New, review and provenance cleared in the page as in the database', async () => {
  const s = show({ title: 'S', catalog_new: true, legacy_status: 'pending' }, [{ num: 1 }]);
  const app = await open('alltv', all(s));
  assert.ok(rowOf(app, 'S').includes('>New<'));
  await app.ctx.setShowStateById(s.show.id, { status: 'watching' }); await settle();
  assert.deepStrictEqual(calls(app, 'library_set_show_state_b45'), [{ p_show_id: s.show.id, p_expected: { ...STATE, catalog_new: true }, p_changes: { status: 'watching' } }]);
  assert.deepStrictEqual(['status', 'catalog_new', 'status_review', 'legacy_status'].map(k => stored(app, s.show.id)[k]), ['watching', false, false, null]);
  assert.ok(!rowOf(app, 'S').includes('>New<'), 'the tag is gone');
  assert.deepStrictEqual(app.writes().length, 1);
});

test('O1 under review: the selector starts on “Choose a status…”; choosing the current status is sent (it resolves the review); without review the same status sends nothing (O8)', async () => {
  const r = show({ title: 'R', status_review: true, legacy_status: 'complete', ended: true }, [{ num: 1 }]);
  const q = show({ title: 'Q' }, [{ num: 1 }]);
  const app = await open('alltv', all(r, q));
  assert.ok(rowOf(app, 'R').includes('<option value="" selected disabled>Choose a status…</option>'));
  await app.ctx.setShowStateById(q.show.id, { status: 'confirmed' }); await settle();
  assert.deepStrictEqual(app.writes(), [], 'O8: nothing sent');
  await app.ctx.setShowStateById(r.show.id, { status: 'confirmed' }); await settle();
  assert.deepStrictEqual(calls(app, 'library_set_show_state_b45').map(c => c.p_changes), [{ status: 'confirmed' }]);
  assert.deepStrictEqual(['status_review', 'legacy_status', 'ended'].map(k => stored(app, r.show.id)[k]), [false, null, true], 'review and provenance cleared; Ended kept');
});

test('O2 priority and O3 Ended: markers kept; provenance cleared only for the field it encodes', async () => {
  const p = show({ title: 'P', priority: 'high', legacy_status: 'highpriority', catalog_new: true }, [{ num: 1 }]);
  const e = show({ title: 'E', status: 'watching', ended: true, legacy_status: 'complete', status_review: true }, [{ num: 1, w: true }]);
  const app = await open('alltv', all(p, e));
  await app.ctx.setShowStateById(p.show.id, { priority: 'normal' }); await settle();
  assert.deepStrictEqual(['priority', 'legacy_status', 'catalog_new'].map(k => stored(app, p.show.id)[k]), ['normal', null, true]);
  await app.ctx.setShowStateById(e.show.id, { priority: 'low' }); await settle();
  assert.deepStrictEqual(['priority', 'legacy_status', 'status_review'].map(k => stored(app, e.show.id)[k]), ['low', 'complete', true], 'complete provenance isn’t about priority');
  app.ctx.toggleDerivedShow(e.show.id); await settle();
  assert.ok(app.el('tbody').innerHTML.includes(`setShowStateById('${e.show.id}', { ended: this.checked })`));
  await app.ctx.setShowStateById(e.show.id, { ended: false }); await settle();
  assert.deepStrictEqual(['ended', 'legacy_status', 'status_review'].map(k => stored(app, e.show.id)[k]), [false, null, true], 'O3 clears complete; review kept');
  assert.deepStrictEqual(calls(app, 'library_set_show_state_b45').map(c => c.p_changes), [{ priority: 'normal' }, { priority: 'low' }, { ended: false }]);
});

test('refused (stale): the page shows the refusal, puts the value back and reads the view again; nothing is resent', async () => {
  const s = show({ title: 'S' }, [{ num: 1 }]);
  const app = await open('alltv', all(s));
  stored(app, s.show.id).priority = 'high'; // changed elsewhere after the page read it
  await app.ctx.setShowStateById(s.show.id, { status: 'skipped' }); await settle();
  assert.match(banner(app), /This changed since the page showed it, so nothing was changed\. The list has been read again/);
  assert.strictEqual(stored(app, s.show.id).status, 'confirmed');
  assert.strictEqual(app.get(`tvShowsById.get('${s.show.id}').priority`), 'high', 'the view shows what is stored now');
  assert.strictEqual(calls(app, 'library_set_show_state_b45').length, 1);
});

test('no clear answer: “wasn’t confirmed”, never resent, the view read again in the same epoch', async () => {
  const s = show({ title: 'S' }, [{ num: 1 }]);
  const app = await open('alltv', all(s));
  const g = app.hold(r => r.url.endsWith('/rpc/library_set_show_state_b45'));
  const p = app.ctx.setShowStateById(s.show.id, { priority: 'low' });
  await g.reached; g.fail(); await p; await settle(); await settle(50);
  assert.match(banner(app), /This change wasn’t confirmed[\s\S]*it won’t be sent again/);
  assert.strictEqual(calls(app, 'library_set_show_state_b45').length, 1);
});

// ─── O5 / O6 (W4–W6, page side) ───────────────────────────────────────────────
test('O5 one: Dismiss “New” sends that one record; review untouched; pending provenance cleared, other provenance kept', async () => {
  const s = show({ title: 'S', catalog_new: true, legacy_status: 'pending' }, [{ num: 1 }]);
  const t = show({ title: 'T', catalog_new: true, status_review: true, legacy_status: 'complete', ended: true }, [{ num: 1 }]);
  const app = await open('alltv', all(s, t));
  app.ctx.toggleDerivedShow(s.show.id); await settle();
  assert.ok(app.el('tbody').innerHTML.includes(`dismissShowNew('${s.show.id}')`));
  await app.ctx.dismissShowNew(s.show.id); await settle();
  await app.ctx.dismissShowNew(t.show.id); await settle();
  assert.deepStrictEqual(calls(app, 'library_dismiss_catalog_new_b45'), [{ p_expected: [{ kind: 'show', id: s.show.id }] }, { p_expected: [{ kind: 'show', id: t.show.id }] }]);
  assert.deepStrictEqual(['catalog_new', 'legacy_status'].map(k => stored(app, s.show.id)[k]), [false, null]);
  assert.deepStrictEqual(['catalog_new', 'status_review', 'legacy_status'].map(k => stored(app, t.show.id)[k]), [false, true, 'complete']);
});

test('O5 all: offered for the New records the view shows (from two), one atomic call over exactly that set; the confirmation states the count; Cancel sends nothing; a changed set refuses the whole call', async () => {
  const a = show({ title: 'A', catalog_new: true }, [{ num: 1 }]), b = show({ title: 'B', catalog_new: true }, [{ num: 1 }]);
  const c = show({ title: 'C', catalog_new: true, status: 'skipped' }, [{ num: 1 }]), d = show({ title: 'D' }, [{ num: 1 }]);
  const app = await open('alltv', all(a, b, c, d));
  app.el('fStatus').value = ''; app.ctx.renderTable(); // the Skipped one isn't shown
  assert.ok(app.el('tbody').innerHTML.includes('Dismiss “New” on these 2'));
  const asked = [];
  app.ctx.confirm = q => { asked.push(q); return false; };
  await app.ctx.dismissShownNew(); await settle();
  assert.deepStrictEqual(app.writes(), [], 'Cancel: nothing sent');
  assert.match(asked[0], /on the 2 records shown\? Their status and priority don’t change\./);
  app.ctx.confirm = () => true;
  stored(app, b.show.id).catalog_new = false; // dismissed elsewhere meanwhile
  await app.ctx.dismissShownNew(); await settle();
  assert.deepStrictEqual(calls(app, 'library_dismiss_catalog_new_b45'), [{ p_expected: [{ kind: 'show', id: a.show.id }, { kind: 'show', id: b.show.id }] }]);
  assert.match(banner(app), /1 of the 2 records shown are no longer new from the catalog, so nothing was changed/);
  assert.strictEqual(stored(app, a.show.id).catalog_new, true, 'all or nothing');
  assert.strictEqual(stored(app, c.show.id).catalog_new, true, 'a record not shown is never included');
  app.ctx.renderTable();
  assert.ok(!app.el('tbody').innerHTML.includes('Dismiss “New” on these'), 'the view was read again: only A is New, so Dismiss all isn’t offered');
  await app.ctx.dismissShownNew(); await settle();
  assert.strictEqual(calls(app, 'library_dismiss_catalog_new_b45').length, 1);
});

test('O6 Keep current status: clears review and provenance; New and status untouched', async () => {
  const s = show({ title: 'S', status: 'watching', ended: true, status_review: true, legacy_status: 'complete', catalog_new: true }, [{ num: 1, w: true }]);
  const app = await open('alltv', all(s));
  app.ctx.toggleDerivedShow(s.show.id); await settle();
  assert.ok(app.el('tbody').innerHTML.includes(`keepCurrentStatus('show', '${s.show.id}')`));
  await app.ctx.keepCurrentStatus('show', s.show.id); await settle();
  assert.deepStrictEqual(calls(app, 'library_dismiss_review_b45'), [{ p_kind: 'show', p_id: s.show.id, p_expected: { ...STATE, status: 'watching', ended: true, catalog_new: true, status_review: true } }]);
  assert.deepStrictEqual(['status_review', 'legacy_status', 'catalog_new', 'status'].map(k => stored(app, s.show.id)[k]), [false, null, true, 'watching']);
});

// ─── Currently Watching membership (§4.7.2–4.7.3, CW1) ────────────────────────
test('CW1 membership, table-driven: the Ended exit, the all-skipped exclusion and every edge case; nothing written', async () => {
  const W = (title, o, specs) => show({ title, status: 'watching', ...o }, specs);
  const cases = [
    // [show, in Currently Watching?, where, why]
    [W('Ended all watched', { ended: true }, [{ num: 1, w: true }, { num: 2, w: true }]), false, '', 'Ended exit: every season watched'],
    [W('Ended latest reached', { ended: true }, [{ num: 1 }, { num: 2, w: true }]), false, '', 'Ended exit: the last main season watched, a gap left'],
    [W('Ended trailing skipped', { ended: true }, [{ num: 1, w: true }, { num: 2, s: true }]), false, '', 'Ended exit: every main season after the progress point skipped'],
    [W('Ended unaired listed', { ended: true }, [{ num: 1, w: true }, { num: 2, date: day(40) }]), true, 'upToDate', 'a stored upcoming season keeps it (conservative)'],
    [W('Ended special unwatched', { ended: true }, [{ num: 0 }, { num: 1, w: true }]), false, '', 'an unwatched special doesn’t block the exit'],
    [W('Specials only ended', { ended: true }, [{ num: 0, w: true }]), false, '', 'specials-only: the specials are the main progression'],
    [W('Zero seasons', {}, []), false, '', 'not listed (unchanged)'],
    [W('All skipped', {}, [{ num: 1, s: true }, { num: 2, s: true }]), false, '', 'all-skipped exclusion'],
    [W('All skipped ended', { ended: true }, [{ num: 1, s: true }]), false, '', 'all-skipped exclusion, Ended or not'],
    [W('Main skipped special not', {}, [{ num: 0 }, { num: 1, s: true }]), true, 'upToDate', 'not rule 3; no non-skipped main season, so not an Ended exit'],
    [W('Ended off', {}, [{ num: 1, w: true }, { num: 2, w: true }]), true, 'upToDate', 'normal rules'],
    [W('In progress ended', { ended: true }, [{ num: 1, w: true }, { num: 2, date: day(-5) }]), true, 'active', 'Remaining non-empty'],
    [show({ title: 'To Watch show' }, [{ num: 1 }]), false, '', 'rule 1']
  ];
  const app = await open('watching', all(...cases.map(c => c[0])));
  const got = watchingIds(app);
  for (const [s, inCw, where, why] of cases) {
    const at = got.active.includes(s.show.title) ? 'active' : got.upToDate.includes(s.show.title) ? 'upToDate' : '';
    assert.strictEqual(!!at, inCw, `${s.show.title}: ${why}`);
    if (inCw) assert.strictEqual(at, where, `${s.show.title}: section`);
  }
  assert.ok(app.el('tbody').innerHTML.includes('Marked ended, but an upcoming season is listed') || app.get('derivedSectionOpen.uptodate') === false);
  // Status change and a new season arriving (derived; nothing written).
  app.ctx.switchView('alltv'); await settle(); app.el('fStatus').value = 'all'; app.ctx.renderTable();
  assert.ok(rowOf(app, 'Ended all watched').includes('Caught up · Ended'), 'All TV: Caught up · Ended');
  assert.ok(rowOf(app, 'Ended latest reached').includes('1 earlier season unwatched'), 'the gap note');
  assert.ok(rowOf(app, 'All skipped').includes('All seasons skipped'));
  assert.ok(!/Finished|all watched/i.test(rowOf(app, 'Ended latest reached')), 'never Finished or all watched');
  const ended = cases[0][0];
  app.store.watchlist_items.push({ ...ended.rows[1], id: 'new-s3', season_number: 3, season: 'Season 3', item_key: 'ended all watched|season 3', watched: false, date_sort: day(-1), display_date: day(-1) });
  app.ctx.switchView('watching'); await settle();
  assert.ok(watchingIds(app).active.includes('Ended all watched'), 'a new season arriving brings it back');
  assert.strictEqual(stored(app, ended.show.id).ended, true, 'Ended unchanged');
  assert.deepStrictEqual(app.writes(), [], 'membership writes nothing');
});

// ─── The earlier-seasons range (§4.7.4–4.7.5; O9; CW2) ────────────────────────
test('O9 from the expanded show: the gap seasons are offered; the start and the furthest watched season are sent; Stop clears both; no status, watched, Ended or marker change', async () => {
  const s = show({ title: 'S', status: 'watching', ended: true, catalog_new: true }, [{ num: 1 }, { num: 2 }, { num: 3, w: true }]);
  const app = await open('alltv', all(s));
  app.ctx.toggleDerivedShow(s.show.id); await settle();
  assert.ok(app.el('tbody').innerHTML.includes('Watch earlier seasons…'));
  app.ctx.openResumePicker(s.show.id); await settle();
  const html = app.el('tbody').innerHTML;
  assert.ok(html.includes(`startResume('${s.show.id}', '${s.rows[0].id}')`) && html.includes(`startResume('${s.show.id}', '${s.rows[1].id}')`));
  assert.ok(!html.includes(`startResume('${s.show.id}', '${s.rows[2].id}')`), 'the watched season isn’t offered');
  await app.ctx.startResume(s.show.id, s.rows[0].id); await settle();
  assert.deepStrictEqual(calls(app, 'library_set_resume_b45'), [{ p_show_id: s.show.id, p_expected: { status: 'watching', resume_start_season_id: null, resume_end_season_id: null },
    p_start: s.rows[0].id, p_end: s.rows[2].id, p_set_watching: false }]);
  const st = stored(app, s.show.id);
  assert.deepStrictEqual([st.status, st.ended, st.catalog_new, st.resume_start_season_id, st.resume_end_season_id], ['watching', true, true, s.rows[0].id, s.rows[2].id]);
  assert.ok(app.el('tbody').innerHTML.includes('Earlier seasons from Season 1'));
  await app.ctx.stopResume(s.show.id); await settle();
  assert.deepStrictEqual(calls(app, 'library_set_resume_b45')[1].p_start, null);
  assert.deepStrictEqual([stored(app, s.show.id).resume_start_season_id, stored(app, s.show.id).resume_end_season_id], [null, null]);
  assert.ok(app.store.watchlist_items.every(r => !r.watched || r.id === s.rows[2].id), 'nothing marked watched');
});

test('O1 + O9 “Start watching earlier seasons” on a To Watch show: the confirmation says it sets the status; Cancel sends nothing; OK sends one call that applies O1', async () => {
  const s = show({ title: 'S', catalog_new: true, legacy_status: 'pending' }, [{ num: 1 }, { num: 2, w: true }]);
  const app = await open('alltv', all(s));
  app.ctx.toggleDerivedShow(s.show.id); await settle();
  assert.ok(app.el('tbody').innerHTML.includes('Start watching earlier seasons…'));
  const asked = [];
  app.ctx.confirm = q => { asked.push(q); return false; };
  await app.ctx.startResume(s.show.id, s.rows[0].id); await settle();
  assert.deepStrictEqual(app.writes(), []);
  assert.match(asked[0], /This sets the status to Watching\./);
  app.ctx.confirm = () => true;
  await app.ctx.startResume(s.show.id, s.rows[0].id); await settle();
  assert.strictEqual(calls(app, 'library_set_resume_b45')[0].p_set_watching, true);
  assert.deepStrictEqual(['status', 'catalog_new', 'legacy_status'].map(k => stored(app, s.show.id)[k]), ['watching', false, null]);
  app.ctx.switchView('watching'); await settle();
  assert.ok(watchingIds(app).active.includes('S'));
});

test('a refused range (the start was watched elsewhere) changes nothing and is reported; the view is read again', async () => {
  const s = show({ title: 'S', status: 'watching' }, [{ num: 1 }, { num: 2, w: true }]);
  const app = await open('alltv', all(s));
  app.store.watchlist_items.find(r => r.id === s.rows[0].id).watched = true;
  await app.ctx.sendResume(app.get(`tvShowsById.get('${s.show.id}')`), s.rows[0].id, s.rows[1].id, false); await settle();
  assert.match(banner(app), /The first season must be unwatched and not skipped/);
  assert.strictEqual(stored(app, s.show.id).resume_start_season_id, null);
});

// CW2: every row of §4.7.4's change table, over the fixed range (derived; evaluated on every render).
test('CW2 resume progression, table-driven over §4.7.4 (the reviewed example first)', async () => {
  const range = (sh, seasons) => app.ctx.resumeRange(sh, seasons);
  const state = (sh, seasons) => { const r = range(sh, seasons); return r ? `${r.state}:${Array.from(r.sequence, x => x.season).join(',')}` : 'none'; };
  const mk = (o = {}) => {
    const s = show({ title: 'R', status: 'watching', ...o }, [{ num: 1, id: 'a1' }, { num: 2, id: 'a2' }, { num: 3, id: 'a3', w: true }, { num: 4, id: 'a4' }]);
    s.show.resume_start_season_id = 'a1'; s.show.resume_end_season_id = 'a3';
    return s;
  };
  const app = await createApp();
  const set = (rows, id, f) => rows.map(r => (r.id === id ? { ...r, ...f } : r));
  let s = mk();
  assert.strictEqual(state(s.show, s.rows), 'active:Season 1,Season 2', 'resume from S1, boundary S3');
  // The reviewed example: S3 marked unwatched → the range is fixed; S3 never enters.
  assert.strictEqual(state(s.show, set(s.rows, 'a3', { watched: false })), 'active:Season 1,Season 2', 'the reviewed example');
  assert.strictEqual(app.ctx.effectiveUpNext(s.show, set(s.rows, 'a3', { watched: false })).season, 'Season 1');
  assert.strictEqual(state(s.show, set(s.rows, 'a1', { watched: true })), 'active:Season 2', 'mark inside → leaves; up next advances');
  assert.strictEqual(state(s.show, set(set(s.rows, 'a1', { watched: true }), 'a2', { watched: true })), 'complete:', 'completion');
  assert.strictEqual(state(s.show, set(set(s.rows, 'a1', { watched: true }), 'a2', { watched: false })), 'active:Season 2', 'undo inside → re-enters');
  assert.strictEqual(state(s.show, set(s.rows, 'a2', { skipped: true })), 'active:Season 1', 'skip inside → leaves; unskip brings it back');
  assert.strictEqual(state(s.show, set(s.rows, 'a1', { skipped: true })), 'active:Season 2', 'skipping the start: still the anchor');
  assert.strictEqual(state(s.show, set(s.rows, 'a3', { skipped: true })), 'active:Season 1,Season 2', 'skipping the boundary: no effect');
  assert.strictEqual(state(s.show, set(s.rows, 'a4', { watched: true })), 'active:Season 1,Season 2', 'later marks: no effect');
  const hist = { ...s.rows[0], id: 'a25', season_number: null, season: 'Season 2.5', date_sort: '2012-06-01' };
  const sorted = [s.rows[0], s.rows[1], { ...hist, season_number: 2, season: 'Season 2', id: 'a2b', date_sort: '2012-06-01' }, s.rows[2], s.rows[3]];
  assert.strictEqual(state(s.show, sorted), 'active:Season 1,Season 2,Season 2', 'a new historical season inside the range enters');
  const before = { ...s.rows[0], id: 'a0', season_number: 0, season: 'Specials' };
  assert.strictEqual(state(s.show, [before, ...s.rows]), 'active:Season 1,Season 2', 'a special / season before the start doesn’t enter');
  assert.strictEqual(state(s.show, [...s.rows, { ...s.rows[3], id: 'a5', season_number: 5, season: 'Season 5', date_sort: '2099-01-01' }]), 'active:Season 1,Season 2', 'a future season doesn’t enter');
  const reordered = set(s.rows, 'a1', { season_number: 9, season: 'Season 9' });
  assert.strictEqual(range(s.show, reordered).state, 'invalid', 'an order change that puts the start after the boundary: inert');
  assert.strictEqual(state(s.show, set(s.rows, 'a3', { id: 'gone' }).filter(r => r.id !== 'gone')), 'invalid:', 'a missing endpoint is inert (the database clears it on delete)');
  // After completion the normal rules apply again (the Ended exit included), and normal progression resumes.
  const done = set(set(s.rows, 'a1', { watched: true }), 'a2', { watched: true });
  assert.strictEqual(app.ctx.effectiveUpNext(s.show, done).season, 'Season 4', 'normal up next after completion');
  const e = mk({ ended: true });
  const endedDone = set(set(set(e.rows, 'a1', { watched: true }), 'a2', { watched: true }), 'a4', { watched: true });
  const today = app.get('localTodayStr()');
  const cw = rows => { const r = app.ctx.deriveCurrentlyWatching(rows, [e.show], today); return [...r.active, ...r.upToDate].map(x => x.show.title); };
  assert.deepStrictEqual(cw(set(e.rows, 'a4', { watched: true })), ['R'], 'resume active waives the Ended exit');
  assert.deepStrictEqual(cw(endedDone), [], 'completed: the Ended exit applies again');
  assert.deepStrictEqual(cw(set(endedDone, 'a2', { watched: false })), ['R'], 're-activation');
  // Status changed from Watching: the range is kept, inactive; active again when Watching is chosen again.
  assert.deepStrictEqual(Array.from(app.ctx.deriveCurrentlyWatching(e.rows, [{ ...e.show, status: 'confirmed' }], today).active), []);
  assert.strictEqual(state({ ...e.show, status: 'confirmed' }, e.rows), 'active:Season 1,Season 2', 'kept while not Watching');
});

test('labels in the expanded show: “Earlier seasons done” for a completed range, “no longer applies” for an inert one; the range tag only while active', async () => {
  const done = show({ title: 'Done', status: 'watching' }, [{ num: 1, id: 'd1', w: true }, { num: 2, id: 'd2', w: true }, { num: 3, id: 'd3' }]);
  Object.assign(done.show, { resume_start_season_id: 'd1', resume_end_season_id: 'd2' });
  const inert = show({ title: 'Inert', status: 'watching' }, [{ num: 1, id: 'i1' }, { num: 2, id: 'i2', w: true }]);
  Object.assign(inert.show, { resume_start_season_id: 'i2', resume_end_season_id: 'i1' }); // reversed: accepted by the database, inert here
  const app = await open('alltv', all(done, inert));
  app.ctx.toggleDerivedShow(done.show.id); app.ctx.toggleDerivedShow(inert.show.id); await settle();
  const html = app.el('tbody').innerHTML;
  assert.ok(html.includes('Earlier seasons done') && html.includes('Earlier-seasons range no longer applies; choose again or stop'));
  assert.ok(!html.includes('Earlier seasons from'), 'no tag for a range that isn’t active');
  assert.ok(rowOf(app, 'Done').includes('Season 3'), 'normal progression after completion');
  assert.deepStrictEqual(app.writes(), []);
});

test('phone width (375 px): the cards carry the status, priority and marker controls; the show actions are in the expanded card', async () => {
  const s = show({ title: 'S', status: 'watching', catalog_new: true, ended: true }, [{ num: 1 }, { num: 2, w: true }]);
  const app = await open('alltv', all(s), { width: 375 });
  const cards = app.el('cardList').innerHTML;
  assert.ok(cards.includes(`setShowStateById('${s.show.id}', { status: this.value })`) && cards.includes(`setShowStateById('${s.show.id}', { priority: this.value })`));
  assert.ok(cards.includes('>New<') && cards.includes('>Ended<'));
  app.ctx.toggleDerivedShow(s.show.id); await settle();
  assert.ok(app.el('cardList').innerHTML.includes('Watch earlier seasons…') && app.el('cardList').innerHTML.includes('Show ended'));
});

// ─── GA-1 review 3: stale and uncertain outcomes, the same everywhere ─────────
test('Keep current status when the record changed elsewhere: refused, the list really is read again, and the message says so; a failed reread is said so', async () => {
  const s = show({ title: 'S', status_review: true, legacy_status: 'complete', ended: true }, [{ num: 1 }]);
  const app = await open('alltv', all(s));
  stored(app, s.show.id).priority = 'high';
  const before = app.requests.length;
  await app.ctx.keepCurrentStatus('show', s.show.id); await settle();
  assert.ok(app.requests.slice(before).some(r => r.method === 'GET' && r.url.includes('/tv_shows?')), 'reread');
  assert.match(banner(app), /This changed since the page showed it, so nothing was changed\. The list has been read again; look at it again\./);
  assert.strictEqual(app.get(`tvShowsById.get('${s.show.id}').priority`), 'high', 'the page shows what is stored now');
  app.failNext(r => r.method === 'GET' && r.url.includes('/tv_shows?'));
  stored(app, s.show.id).priority = 'low';
  await app.ctx.keepCurrentStatus('show', s.show.id); await settle();
  assert.match(banner(app), /This changed since the page showed it, so nothing was changed\. The list couldn’t be read again, so what is shown may be out of date; use Retry\./);
  assert.strictEqual(calls(app, 'library_dismiss_review_b45').length, 2, 'one call each, never resent');
});

test('Start / Stop earlier seasons: a stale range or record is refused and the list is read again; no clear answer → not confirmed, never resent, read again', async () => {
  const s = show({ title: 'S', status: 'watching' }, [{ num: 1 }, { num: 2, w: true }]);
  const app = await open('alltv', all(s));
  app.store.watchlist_items.find(r => r.id === s.rows[0].id).watched = true; // watched elsewhere: the start is no longer valid
  const before = app.requests.length;
  await app.ctx.startResume(s.show.id, s.rows[0].id); await settle();
  assert.match(banner(app), /The first season must be unwatched and not skipped[\s\S]*Nothing was changed\. The list has been read again; look at it again\./);
  assert.ok(app.requests.slice(before).some(r => r.method === 'GET' && r.url.includes('/watchlist_items?')), 'reread');
  assert.ok(app.get(`derivedData.rows.find(r => r.id === '${s.rows[0].id}').watched`), 'the page now shows the watched start');
  const t = show({ title: 'T', status: 'watching' }, [{ num: 1 }, { num: 2, w: true }]);
  const app2 = await open('alltv', all(t));
  const g = app2.hold(r => r.url.endsWith('/rpc/library_set_resume_b45'));
  const p = app2.ctx.startResume(t.show.id, t.rows[0].id);
  await g.reached; g.fail(); await p; await settle(); await settle(50);
  assert.match(banner(app2), /This change wasn’t confirmed[\s\S]*won’t be sent again\. The list has been read again; look at it again\./);
  assert.strictEqual(calls(app2, 'library_set_resume_b45').length, 1);
  stored(app2, t.show.id).status = 'confirmed'; // changed elsewhere
  await app2.ctx.stopResume(t.show.id); await settle(); // (no range stored in the page: nothing to stop)
  assert.strictEqual(calls(app2, 'library_set_resume_b45').length, 1);
});

test('an answer that arrives after a restore: the notice says the list was read again only once it was (and says so when that read fails)', async () => {
  const s = show({ title: 'S' }, [{ num: 1 }]);
  const app = await open('alltv', all(s));
  const g = app.hold(r => r.url.endsWith('/rpc/library_set_show_state_b45'));
  const p = app.ctx.setShowStateById(s.show.id, { priority: 'high' });
  await g.reached;
  app.run('orgEpoch++');
  app.failNext(r => r.method === 'GET' && r.url.includes('/tv_shows?'));
  g.release(); await p; await settle(); await settle();
  assert.match(app.el('banner').innerHTML, /“S” · priority was sent before the restore and answered afterwards\. The list couldn’t be read again \(use Retry\); this doesn’t show/);
});

// ─── F5 (owner amendment 2026-10-13): display only ────────────────────────────
test('F5: a show labelled “Caught up · Ended” or “All seasons skipped” shows no “Up to date” pill (All TV rows and cards, Browse collections); the calculation, the stats count and Currently Watching are unchanged', async () => {
  const e = show({ title: 'Ended', status: 'watching', ended: true, collection: 'truecrime' }, [{ num: 1, w: true }]);
  const k = show({ title: 'Skipped', status: 'watching' }, [{ num: 1, s: true }]);
  const u = show({ title: 'Plain', status: 'watching' }, [{ num: 1, w: true }, { num: 2, date: day(40) }]);
  const app = await open('alltv', all(e, k, u));
  for (const t of ['Ended', 'Skipped']) assert.ok(!rowOf(app, t).includes('s-caughtup">Up to date'), `${t}: no pill in the row`);
  assert.ok(rowOf(app, 'Ended').includes('Caught up · Ended') && rowOf(app, 'Skipped').includes('All seasons skipped'));
  assert.ok(rowOf(app, 'Plain').includes('s-caughtup">Up to date'), 'a plain Up to date show keeps the pill');
  const cardOf = t => app.el('cardList').innerHTML.split('item-card').find(x => x.includes(`show-title">${t}<`)) || '';
  for (const t of ['Ended', 'Skipped']) assert.ok(!cardOf(t).includes('Up to date'), `${t}: no pill on the card`);
  const items = app.ctx.deriveAllTv(app.get('derivedData').rows, app.get('tvShowsById'), app.get('localTodayStr()')).items;
  assert.deepStrictEqual(Object.fromEntries(Array.from(items, x => [x.title, x.upToDate])), { Ended: true, Plain: true, Skipped: true }, 'the calculation is unchanged');
  assert.strictEqual(app.el('statsRow').innerHTML, '<p class="count-line">3 shows · of these, 3 Watching, 3 up to date</p>', 'the count is unchanged (B8: a count line)');
  app.ctx.switchView('watching'); await settle();
  assert.deepStrictEqual(watchingIds(app), { active: [], upToDate: ['Plain'] }, 'Currently Watching membership unchanged (Ended exit and all-skipped excluded)');
  // Browse collections show “Caught up · Ended” too (read-only): no pill beside it.
  app.ctx.openBrowseCollection(app.browseId('truecrime')); await settle();
  const browseRow = app.el('tbody').innerHTML.split('<tr').find(x => x.includes('show-title">Ended<')) || '';
  assert.ok(browseRow.includes('Caught up · Ended') && !browseRow.includes('Up to date'), browseRow.slice(0, 300));
  assert.deepStrictEqual(app.writes(), []);
});

T.run();
