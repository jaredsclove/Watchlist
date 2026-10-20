// The B4/B5 database (db/b45_expand.sql) for the offline harness, written independently
// of the app's helpers so the tests can catch an app/database mismatch: the new columns
// and their defaults, the fixture migration (the owner's choices: a Complete show becomes
// Watching + Ended, a watching / complete film To Watch), the _b45 functions, the refusing
// stubs of the old names, the guards on direct writes and the resume cleanup.
// Used by tests/app-harness.js when createApp({ stage5: 'contracted-b45' }) (the default).

const B45_PHASE = 'contracted-b45';
// EP1 (db/ep1_episode_marks.sql): the B4/B5 schema plus episode marks; the page's own phase since EP1.
// The B4/B5 columns, guards and functions are the same in both.
const EP1_PHASE = 'contracted-ep1';
const isB45Schema = phase => phase === B45_PHASE || phase === EP1_PHASE;
// The old names that refuse once B4/B5 is installed (an old page still open).
const B45_STUBS = ['set_show_status', 'library_add_seasons', 'library_create_show', 'library_add_films', 'library_create_film',
  'library_match_season', 'library_match_film', 'library_catalog_apply'];
const SHOW_COLUMNS = ['priority', 'ended', 'catalog_new', 'status_review', 'legacy_status', 'genres', 'forms', 'franchises', 'companies',
  'genre_candidates', 'network', 'network_candidates', 'metadata_owner_set', 'resume_start_season_id', 'resume_end_season_id'];
const FILM_COLUMNS = ['priority', 'catalog_new', 'status_review', 'legacy_status', 'genres', 'forms', 'franchises', 'companies',
  'genre_candidates', 'metadata_owner_set'];
const LABEL_FIELDS = ['genres', 'forms', 'franchises', 'companies', 'genre_candidates'];

const clone = v => JSON.parse(JSON.stringify(v));
const cmpC = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const canon = v => v === null || v === undefined ? 'null' : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : typeof v === 'object' ? `{${Object.keys(v).filter(k => v[k] !== undefined).sort(cmpC).map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v);
const same = (a, b) => canon(a) === canon(b);
const md5 = t => require('crypto').createHash('md5').update(t, 'utf8').digest('hex');

const showDefaults = () => ({ priority: 'normal', ended: false, catalog_new: false, status_review: false, legacy_status: null, genres: [], forms: [],
  franchises: [], companies: [], genre_candidates: [], network: null, network_candidates: [], metadata_owner_set: false,
  resume_start_season_id: null, resume_end_season_id: null });
const filmDefaults = () => ({ priority: 'normal', catalog_new: false, status_review: false, legacy_status: null, genres: [], forms: [],
  franchises: [], companies: [], genre_candidates: [], metadata_owner_set: false });
const seasonNulls = () => Object.fromEntries(FILM_COLUMNS.map(c => [c, null]));

// The fixture migration (db/b45_expand.sql §3, with the test owner's choices).
function migrateFixtures(store, isFilmRow) {
  for (const s of store.tv_shows || []) {
    // B4/B5 values the fixture gives are kept; the rest take the defaults.
    const given = Object.fromEntries(SHOW_COLUMNS.filter(k => k in s).map(k => [k, s[k]]));
    const old = s.status;
    Object.assign(s, showDefaults(), given);
    if (['pending', 'highpriority', 'maybe', 'complete'].includes(old)) {
      s.status = old === 'complete' ? 'watching' : 'confirmed';
      s.priority = old === 'highpriority' ? 'high' : old === 'maybe' ? 'low' : 'normal';
      s.ended = old === 'complete';
      s.catalog_new = old === 'pending';
      s.legacy_status = old;
    }
  }
  for (const r of store.watchlist_items || []) {
    if (!isFilmRow(r)) { Object.assign(r, seasonNulls()); continue; }
    const given = Object.fromEntries(FILM_COLUMNS.filter(k => r[k] != null).map(k => [k, r[k]]));
    const old = r.status;
    Object.assign(r, filmDefaults(), given);
    if (['pending', 'highpriority', 'maybe', 'watching', 'complete'].includes(old)) {
      r.status = 'confirmed';
      r.priority = old === 'highpriority' ? 'high' : old === 'maybe' ? 'low' : 'normal';
      r.catalog_new = old === 'pending';
      r.legacy_status = old;
    }
  }
}

// Before and after every request: every row has the B4/B5 columns (a row a test pushed into
// the store takes the column defaults, as a show would; a film the values every insert path
// states; a season nulls), and a deleted season clears any resume range that names it (the
// BEFORE DELETE cleanup).
function normalize(store, isFilmRow) {
  const ids = new Set((store.watchlist_items || []).map(r => r.id));
  for (const s of store.tv_shows || []) {
    for (const [k, v] of Object.entries(showDefaults())) if (!(k in s)) s[k] = v;
    if ((s.resume_start_season_id && !ids.has(s.resume_start_season_id)) || (s.resume_end_season_id && !ids.has(s.resume_end_season_id))) {
      s.resume_start_season_id = null; s.resume_end_season_id = null;
    }
  }
  for (const r of store.watchlist_items || []) {
    const fill = isFilmRow(r) ? filmDefaults() : seasonNulls();
    for (const c of FILM_COLUMNS) if (!(c in r)) r[c] = fill[c];
  }
}

// Direct writes (PATCH) to the guarded columns: refused like the triggers do.
function patchGuard(table, body, targets, isFilmRow) {
  if (!body) return false;
  if (table === 'tv_shows') return targets.some(s => ['status', ...SHOW_COLUMNS].some(k => k in body && !same(body[k], s[k])));
  if (table === 'watchlist_items') {
    return targets.some(r => (isFilmRow(r) && ['status', 'watched'].some(k => k in body && !same(body[k], r[k])))
      || FILM_COLUMNS.some(k => k in body && !same(body[k], r[k])));
  }
  return false;
}

function b45Handlers({ app, store, handlers, newId, org, DbError, isFilmRow, BUILTIN }) {
  const shows = () => store.tv_shows;
  const items = () => store.watchlist_items;
  const on = () => isB45Schema(app.stage5);
  const changed = () => { throw new DbError('P0001', 'target_changed: This changed since the page showed it, so nothing was changed. Look at it again.'); };
  const refuse = (code, text) => { throw new DbError('P0001', `${code}: ${text}`); };
  const showState = s => ({ status: s.status, priority: s.priority, ended: s.ended, catalog_new: s.catalog_new, status_review: s.status_review });
  const filmState = w => ({ status: w.status, watched: !!w.watched, priority: w.priority, catalog_new: w.catalog_new, status_review: w.status_review });
  const showMeta = s => ({ genres: s.genres, forms: s.forms, franchises: s.franchises, companies: s.companies, genre_candidates: s.genre_candidates,
    network: s.network, network_candidates: s.network_candidates, metadata_owner_set: s.metadata_owner_set });
  const filmMeta = w => ({ genres: w.genres, forms: w.forms, franchises: w.franchises, companies: w.companies, genre_candidates: w.genre_candidates,
    metadata_owner_set: w.metadata_owner_set });
  const carry = s => ({ ...showState(s), ...showMeta(s), legacy_status: s.legacy_status });
  const noTitle = e => { const { title, ...x } = e || {}; return x; };
  const filmOut = w => { const { is_film, collection, ...x } = clone(w); return x; };
  const labelsOk = v => Array.isArray(v) && v.length <= 10 && v.every(x => typeof x === 'string' && x === x.trim() && x.length >= 1 && x.length <= 80)
    && new Set(v.map(x => x.toLowerCase())).size === v.length;
  const labels = (v, field) => {
    if (v == null) return [];
    if (!labelsOk(v)) throw new DbError('22023', `invalid_input: ${field} (at most 10 labels, each 1–80 characters with no surrounding spaces, no repeats)`);
    return v.slice();
  };
  const requireOn = name => { if (!on()) throw new DbError('PGRST202', `missing ${name}`); };

  // The main progression (numbered seasons; every season of a specials-only show), in order.
  const special = r => r.season_number === 0 || /^\s*specials?\s*$/i.test(r.season || '');
  const number = r => r.season_number ?? (Number(((r.season || '').match(/^(?:Season|Volume)\s+(\d+)/i) || [])[1]) || null);
  function mainSeasons(showId) {
    const all = items().filter(r => r.show_id === showId);
    const pool = all.some(r => !special(r)) ? all.filter(r => !special(r)) : all;
    return pool.slice().sort((a, b) => (special(a) - special(b)) || ((number(a) ?? Infinity) - (number(b) ?? Infinity))
      || cmpC(a.date_sort || '', b.date_sort || '') || cmpC(a.season || '', b.season || '') || cmpC(String(a.id), String(b.id)));
  }
  function resumeState(s) {
    if (!s.resume_start_season_id) return null;
    const m = mainSeasons(s.id);
    const a = m.findIndex(r => r.id === s.resume_start_season_id), b = m.findIndex(r => r.id === s.resume_end_season_id);
    if (a < 0 || b < 0 || a >= b) return 'invalid';
    return m.slice(a, b).some(r => !r.watched && !r.skipped) ? 'active' : 'complete';
  }

  const fns = {
    library_set_show_state_b45({ p_show_id: id, p_expected: exp, p_changes: ch }) {
      requireOn('library_set_show_state_b45');
      if (!id || !exp || typeof exp !== 'object' || !ch || typeof ch !== 'object' || Object.keys(ch).some(k => !['status', 'priority', 'ended'].includes(k))
          || !Object.keys(ch).length || ('status' in ch && !['confirmed', 'watching', 'skipped'].includes(ch.status))
          || ('priority' in ch && !['high', 'normal', 'low'].includes(ch.priority)) || ('ended' in ch && typeof ch.ended !== 'boolean')) {
        throw new DbError('22023', `invalid_input: show state change ${JSON.stringify(ch)}`);
      }
      const s = shows().find(x => x.id === id);
      if (!s) refuse('target_missing', 'This show is no longer on your list, so nothing was changed.');
      if (!same(showState(s), noTitle(exp))) changed();
      const n = { ...s };
      if ('status' in ch) Object.assign(n, { status: ch.status, catalog_new: false, status_review: false, legacy_status: null });
      if ('priority' in ch) { n.priority = ch.priority; if (n.priority !== s.priority && ['highpriority', 'maybe'].includes(n.legacy_status)) n.legacy_status = null; }
      if ('ended' in ch) { n.ended = ch.ended; if (n.ended !== s.ended && n.legacy_status === 'complete') n.legacy_status = null; }
      if (!('status' in ch && s.status_review) && n.status === s.status && n.priority === s.priority && n.ended === s.ended
          && (!('status' in ch) || (!s.catalog_new && s.legacy_status == null))) return { changed: false, show: clone(s) };
      Object.assign(s, { status: n.status, priority: n.priority, ended: n.ended, catalog_new: n.catalog_new, status_review: n.status_review, legacy_status: n.legacy_status });
      app.b45Writes = (app.b45Writes || 0) + 1;
      return { changed: true, show: clone(s) };
    },
    library_set_film_state_b45({ p_item_id: id, p_expected: exp, p_changes: ch }) {
      requireOn('library_set_film_state_b45');
      if (!id || !exp || typeof exp !== 'object' || !ch || typeof ch !== 'object' || Object.keys(ch).some(k => !['state', 'watched', 'priority'].includes(k))
          || !Object.keys(ch).length || ('state' in ch && 'watched' in ch) || ('state' in ch && !['to_watch', 'watched', 'skipped'].includes(ch.state))
          || ('watched' in ch && typeof ch.watched !== 'boolean') || ('priority' in ch && !['high', 'normal', 'low'].includes(ch.priority))) {
        throw new DbError('22023', `invalid_input: film state change ${JSON.stringify(ch)}`);
      }
      const w = items().find(x => x.id === id);
      if (!w || !isFilmRow(w)) refuse('target_missing', 'This film is no longer on your list, so nothing was changed.');
      if (!same(filmState(w), noTitle(exp))) changed();
      const n = { ...w, watched: !!w.watched };
      if ('state' in ch) Object.assign(n, { status: ch.state === 'skipped' ? 'skipped' : 'confirmed', watched: ch.state === 'watched',
        catalog_new: false, status_review: false, legacy_status: null });
      if ('watched' in ch) {
        if (w.status === 'skipped') refuse('invalid_state', 'A skipped film can\'t be marked watched here; choose Watched as its status. Nothing was changed.');
        n.watched = ch.watched;
      }
      if ('priority' in ch) { n.priority = ch.priority; if (n.priority !== w.priority && ['highpriority', 'maybe'].includes(n.legacy_status)) n.legacy_status = null; }
      if (('state' in ch || 'watched' in ch) && n.status === 'skipped' && n.watched) refuse('invalid_state', 'A film can\'t be both Skipped and Watched. Nothing was changed.');
      if (!('state' in ch && w.status_review) && n.status === w.status && n.watched === !!w.watched && n.priority === w.priority
          && (!('state' in ch) || (!w.catalog_new && w.legacy_status == null))) return { changed: false, row: filmOut(w) };
      Object.assign(w, { status: n.status, watched: n.watched, priority: n.priority, catalog_new: n.catalog_new, status_review: n.status_review, legacy_status: n.legacy_status });
      app.b45Writes = (app.b45Writes || 0) + 1;
      return { changed: true, row: filmOut(w) };
    },
    library_set_metadata_b45({ p_kind: kind, p_id: id, p_expected: exp, p_metadata: md }) {
      requireOn('library_set_metadata_b45');
      const allowed = kind === 'show' ? [...LABEL_FIELDS, 'network', 'network_candidates'] : LABEL_FIELDS;
      if (!['show', 'film'].includes(kind) || !id || !exp || typeof exp !== 'object' || !md || typeof md !== 'object' || Array.isArray(md)
          || Object.keys(md).some(k => !allowed.includes(k))) throw new DbError('22023', `invalid_input: metadata ${JSON.stringify(md)}`);
      const lists = {};
      for (const f of [...LABEL_FIELDS, 'network_candidates']) if (f in md) lists[f] = labels(md[f], f);
      if ('network' in md && md.network != null && (typeof md.network !== 'string' || md.network !== md.network.trim() || md.network.length < 1 || md.network.length > 80)) {
        throw new DbError('22023', 'invalid_input: network');
      }
      if (kind === 'show') {
        const s = shows().find(x => x.id === id);
        if (!s) refuse('target_missing', 'This show is no longer on your list, so nothing was changed.');
        if (!same(showMeta(s), exp)) changed();
        Object.assign(s, lists, 'network' in md ? { network: md.network ?? null } : {}, { metadata_owner_set: true });
        app.b45Writes = (app.b45Writes || 0) + 1;
        return { show: clone(s) };
      }
      const w = items().find(x => x.id === id);
      if (!w || !isFilmRow(w)) refuse('target_missing', 'This film is no longer on your list, so nothing was changed.');
      if (!same(filmMeta(w), exp)) changed();
      Object.assign(w, lists, { metadata_owner_set: true });
      app.b45Writes = (app.b45Writes || 0) + 1;
      return { row: filmOut(w) };
    },
    library_dismiss_catalog_new_b45({ p_expected: exp }) {
      requireOn('library_dismiss_catalog_new_b45');
      if (!Array.isArray(exp) || !exp.length || exp.some(x => !x || typeof x !== 'object' || !['show', 'film'].includes(x.kind) || !/^[0-9a-z-]+$/.test(x.id || ''))) {
        throw new DbError('22023', 'invalid_input: the records to dismiss');
      }
      if (new Set(exp.map(x => `${x.kind}|${x.id}`)).size !== exp.length) throw new DbError('22023', 'invalid_input: a record is listed twice');
      const recs = exp.map(x => x.kind === 'show' ? shows().find(s => s.id === x.id) : items().find(w => w.id === x.id && isFilmRow(w)));
      const n = recs.filter(r => r && r.catalog_new).length;
      if (n !== exp.length) throw new DbError('P0001', `target_changed: ${exp.length - n} of the ${exp.length} records shown are no longer new from the catalog, so nothing was changed. Look at the list again.`);
      recs.forEach(r => { r.catalog_new = false; if (r.legacy_status === 'pending') r.legacy_status = null; });
      app.b45Writes = (app.b45Writes || 0) + 1;
      return { dismissed: n };
    },
    library_dismiss_review_b45({ p_kind: kind, p_id: id, p_expected: exp }) {
      requireOn('library_dismiss_review_b45');
      if (!['show', 'film'].includes(kind) || !id || !exp || typeof exp !== 'object') throw new DbError('22023', 'invalid_input: review dismissal');
      if (kind === 'show') {
        const s = shows().find(x => x.id === id);
        if (!s) refuse('target_missing', 'This show is no longer on your list, so nothing was changed.');
        if (!same(showState(s), exp) || !s.status_review) changed();
        Object.assign(s, { status_review: false, legacy_status: null });
        app.b45Writes = (app.b45Writes || 0) + 1;
        return { show: clone(s) };
      }
      const w = items().find(x => x.id === id);
      if (!w || !isFilmRow(w)) refuse('target_missing', 'This film is no longer on your list, so nothing was changed.');
      if (!same(filmState(w), exp) || !w.status_review) changed();
      Object.assign(w, { status_review: false, legacy_status: null });
      app.b45Writes = (app.b45Writes || 0) + 1;
      return { row: filmOut(w) };
    },
    library_set_resume_b45({ p_show_id: id, p_expected: exp, p_start: a, p_end: b, p_set_watching: setWatching = false }) {
      requireOn('library_set_resume_b45');
      a = a ?? null; b = b ?? null;
      if (!id || !exp || typeof exp !== 'object' || (a == null) !== (b == null) || (a != null && a === b) || (setWatching && a == null)) {
        throw new DbError('22023', 'invalid_input: resume range');
      }
      const s = shows().find(x => x.id === id);
      if (!s) refuse('target_missing', 'This show is no longer on your list, so nothing was changed.');
      if (!same({ status: s.status, resume_start_season_id: s.resume_start_season_id, resume_end_season_id: s.resume_end_season_id }, exp)) changed();
      if (setWatching && s.status === 'watching') throw new DbError('22023', 'invalid_input: the show is already Watching');
      if (a != null) {
        const ra = items().find(r => r.id === a && r.show_id === s.id), rb = items().find(r => r.id === b && r.show_id === s.id);
        if (!ra || !rb) refuse('invalid_range', 'Those seasons aren\'t seasons of this show, so nothing was changed. Look at it again.');
        if (ra.watched || ra.skipped || !rb.watched) refuse('invalid_range', 'The first season must be unwatched and not skipped, and the last one before it watched. Nothing was changed. Look at it again.');
      }
      if (setWatching) Object.assign(s, { status: 'watching', catalog_new: false, status_review: false, legacy_status: null });
      Object.assign(s, { resume_start_season_id: a, resume_end_season_id: b });
      app.b45Writes = (app.b45Writes || 0) + 1;
      return { show: clone(s), resume_state: resumeState(s) };
    },

    // ── Additions: the 5a contracts, To Watch / Normal, with the TMDB metadata ──
    library_add_seasons_b45({ p_show_id: id, p_expected: exp, p_seasons: seasons }) {
      requireOn('library_add_seasons_b45');
      const show = shows().find(x => x.id === id);
      const before = show ? { status: show.status, ended: show.ended } : null;
      const res = handlers.library_add_seasons({ p_show_id: id, p_expected: exp, p_seasons: seasons });
      if (show.status !== before.status || show.ended !== before.ended) throw new DbError('23000', 'integrity_fault: an addition changed the show\'s status');
      const { reopened, ...rest } = res;
      return { ...rest, inserted: rest.inserted.map(filmOut), ended_kept: !!before.ended && (res.inserted || []).length > 0 };
    },
    library_create_show_b45({ p_show: show, p_seasons: seasons }) {
      requireOn('library_create_show_b45');
      if (!show || typeof show !== 'object') throw new DbError('22023', 'invalid_input: show');
      if ((show.initial_status ?? 'confirmed') !== 'confirmed') throw new DbError('22023', 'invalid_input: a new show starts To Watch');
      if ('original_network' in show) throw new DbError('22023', 'invalid_input: Original network is set only by the owner');
      const md = {};
      for (const f of [...LABEL_FIELDS, 'network_candidates']) md[f] = labels(show[f], f);
      const before = new Set(shows().map(s => s.id));
      const res = handlers.library_create_show({ p_show: { ...show, initial_status: 'confirmed' }, p_seasons: seasons });
      const created = shows().find(s => s.id === res.show_id && !before.has(s.id));
      Object.assign(created, showDefaults(), md, { status: 'confirmed' });
      const { reopened, ...rest } = res;
      const { collection, ...out } = clone(created);
      return { ...rest, inserted: rest.inserted.map(filmOut), show_created: true, show: out };
    },
    library_add_films_b45({ p_films: films }) {
      requireOn('library_add_films_b45');
      if (Array.isArray(films)) for (const f of films) for (const x of LABEL_FIELDS) labels(f && f[x], x);
      if (Array.isArray(films) && new Set(films.map(f => f && f.tmdb_id)).size !== films.length) throw new DbError('22023', 'invalid_input: a film is listed twice');
      const res = handlers.library_add_films({ p_films: (films || []).map(f => ({ ...f, status: 'confirmed' })) });
      const ins = new Set(res.inserted.map(r => r.id));
      films.forEach(f => {
        const r = items().find(w => w.media_type === 'movie' && w.tmdb_id === f.tmdb_id && ins.has(w.id));
        if (r) Object.assign(r, filmDefaults(), Object.fromEntries(LABEL_FIELDS.map(x => [x, labels(f[x], x)])), { status: 'confirmed' });
      });
      return { results: res.results, inserted: items().filter(w => ins.has(w.id)).sort((a, b) => cmpC(a.date_sort, b.date_sort) || cmpC(a.id, b.id)).map(filmOut) };
    },
    library_create_film_b45({ p_film: f }) {
      requireOn('library_create_film_b45');
      if (f) for (const x of LABEL_FIELDS) labels(f[x], x);
      if (f && (f.status ?? 'confirmed') !== 'confirmed') throw new DbError('22023', 'invalid_input: a new film starts To Watch');
      const res = handlers.library_create_film({ p_film: f });
      const r = items().find(w => w.id === res.id);
      Object.assign(r, filmDefaults(), Object.fromEntries(LABEL_FIELDS.map(x => [x, labels(f[x], x)])), { status: 'confirmed' });
      return { id: r.id, row: filmOut(r) };
    },

    // ── Match (plan §8.2): the 5a contract, the field rules and the acknowledgment ──
    library_match_season_b45({ p_row_id: id, p_target: target, p_patch: patch, p_expansion: expansion = {}, p_ack: ack = null }) {
      requireOn('library_match_season_b45');
      const r0 = items().find(x => x.id === id);
      const pre = { w: clone(items()), s: clone(shows()), m: clone(store.collection_memberships || []), o: clone(store.othertv_shows || []) };
      const undo = () => { store.watchlist_items = pre.w; store.tv_shows = pre.s; if (store.collection_memberships) store.collection_memberships = pre.m; store.othertv_shows = pre.o; };
      const r = r0 ? clone(r0) : null;
      const l = r && r.show_id ? clone(shows().find(s => s.id === r.show_id) || null) : null;
      const t = target && shows().find(s => s.tmdb_id === target.tmdb_id) ? clone(shows().find(s => s.tmdb_id === target.tmdb_id)) : null;
      const emptied = !!l && !items().some(x => x.show_id === l.id && x.id !== id);
      const res = handlers.library_match_season({ p_row_id: id, p_target: target, p_patch: patch, p_expansion: expansion });
      if (res.blocked) return res;
      // The source's state as a show would hold it, and what the match would drop.
      let src = null, filmStatus = null;
      const items_ = [];
      if (isFilmRow(r)) {
        filmStatus = r.status === 'skipped' ? 'skipped' : 'confirmed';
        src = { status: filmStatus, priority: r.priority, ended: false, catalog_new: r.catalog_new, status_review: r.status_review,
          legacy_status: ['pending', 'highpriority', 'maybe'].includes(r.legacy_status) ? r.legacy_status : null,
          genres: r.genres, forms: r.forms, franchises: r.franchises, companies: r.companies, genre_candidates: r.genre_candidates,
          network: null, network_candidates: [], metadata_owner_set: r.metadata_owner_set };
        if (['watching', 'complete'].includes(r.legacy_status)) items_.push({ field: 'legacy_status', source: r.legacy_status, effect: 'not_carried' });
      } else if (l) src = carry(l);
      let targetId = null;
      if (t) {
        targetId = t.id;
        if (src) {
          const dest = carry(t);
          const fields = ['priority', 'ended', 'catalog_new', 'status_review', 'legacy_status', 'genres', 'forms', 'franchises', 'companies',
            'genre_candidates', 'network', 'network_candidates', 'metadata_owner_set'];
          // (jsonb_agg order by field, then the film's status)
          fields.slice().sort(cmpC).forEach(f => { if (!same(src[f], dest[f])) items_.push({ destination: dest[f] ?? null, field: f, source: src[f] ?? null }); });
          if (isFilmRow(r) && filmStatus !== t.status) items_.push({ destination: t.status, field: 'status', source: filmStatus });
        }
      } else if (l && emptied) targetId = l.id;
      if (l && targetId !== l.id && (l.resume_start_season_id === id || l.resume_end_season_id === id)) items_.push({ effect: 'cleared', field: 'resume', show_id: l.id });
      if (l && targetId !== l.id && emptied) items_.push({ effect: 'deleted', field: 'source_show', show_id: l.id, values: carry(l) });
      const token = md5(canon(items_));
      if (items_.length && ack !== token) {
        undo();
        return { blocked: true, reason: 'state_acknowledgment', items: items_, confirmation: token, changed: ack != null };
      }
      // Writes beyond the 5a match: a new show carries the source's state; film-only values leave the row.
      const created = !t && !(l && emptied);
      const show = shows().find(s => s.id === res.show_id);
      if (created) Object.assign(show, showDefaults(), src ? { ...src } : {}, { status: src ? src.status : 'confirmed' });
      const w = items().find(x => x.id === id);
      Object.assign(w, seasonNulls());
      const lNow = l && shows().find(s => s.id === l.id);
      if (lNow && lNow.id !== show.id && (lNow.resume_start_season_id === id || lNow.resume_end_season_id === id)) {
        lNow.resume_start_season_id = null; lNow.resume_end_season_id = null;
      }
      return { ...res, row: filmOut(w), discarded_source_state: items_ };
    },
    library_match_film_b45({ p_row_id: id, p_expected: exp, p_patch: patch, p_ack: ack = null, p_choice: choice = null }) {
      requireOn('library_match_film_b45');
      if (choice != null && !['watched', 'skipped'].includes(choice)) throw new DbError('22023', 'invalid_input: match patch');
      const r0 = items().find(x => x.id === id);
      if (r0 && isFilmRow(r0)) {
        const res = handlers.library_match_film({ p_row_id: id, p_expected: exp, p_patch: patch });
        return { ...res, row: filmOut(items().find(x => x.id === id)), discarded_source_state: [] };
      }
      const pre = { w: clone(items()), s: clone(shows()), m: clone(store.collection_memberships || []) };
      const undo = () => { store.watchlist_items = pre.w; store.tv_shows = pre.s; if (store.collection_memberships) store.collection_memberships = pre.m; };
      const r = r0 ? clone(r0) : null;
      const former = r && r.show_id ? clone(shows().find(s => s.id === r.show_id) || null) : null;
      const res = handlers.library_match_film({ p_row_id: id, p_expected: exp, p_patch: patch }); // the 5a checks and writes
      const skip = former.status === 'skipped' || !!r.skipped;
      let status, watched, chosen = false;
      if (skip && r.watched) {
        if (choice == null) { undo(); return { blocked: true, reason: 'state_choice', choices: ['watched', 'skipped'] }; }
        chosen = true; status = choice === 'skipped' ? 'skipped' : 'confirmed'; watched = choice === 'watched';
      } else {
        if (choice != null) { undo(); throw new DbError('22023', 'invalid_input: no choice is needed for this row'); }
        status = skip ? 'skipped' : 'confirmed'; watched = !!r.watched;
      }
      const items_ = [];
      if (former.ended) items_.push({ effect: 'dropped', field: 'ended', source: true });
      if (former.network != null) items_.push({ effect: 'dropped', field: 'network', source: former.network });
      if ((former.network_candidates || []).length) items_.push({ effect: 'dropped', field: 'network_candidates', source: former.network_candidates });
      if (!chosen && former.legacy_status === 'complete') items_.push({ effect: 'not_carried', field: 'legacy_status', source: 'complete' });
      if (former.resume_start_season_id === id || former.resume_end_season_id === id) items_.push({ effect: 'cleared', field: 'resume', show_id: former.id });
      if (!pre.w.some(x => x.show_id === former.id && x.id !== id)) items_.push({ effect: 'deleted', field: 'source_show', show_id: former.id, values: carry(former) });
      const token = md5(canon(items_));
      if (items_.length && ack !== token) {
        undo();
        return { blocked: true, reason: 'state_acknowledgment', items: items_, confirmation: token, changed: ack != null };
      }
      const fNow = shows().find(s => s.id === former.id);
      if (fNow && (fNow.resume_start_season_id === id || fNow.resume_end_season_id === id)) { fNow.resume_start_season_id = null; fNow.resume_end_season_id = null; }
      const w = items().find(x => x.id === id);
      Object.assign(w, { skipped: false, status, watched, priority: former.priority,
        catalog_new: chosen ? false : former.catalog_new, status_review: chosen ? false : former.status_review,
        legacy_status: chosen ? null : (['pending', 'highpriority', 'maybe'].includes(former.legacy_status) ? former.legacy_status : null),
        genres: clone(former.genres), forms: clone(former.forms), franchises: clone(former.franchises), companies: clone(former.companies),
        genre_candidates: clone(former.genre_candidates), metadata_owner_set: former.metadata_owner_set });
      return { ...res, row: filmOut(w), discarded_source_state: items_, state_choice: chosen ? choice : null };
    },
    library_catalog_apply_b45({ p_catalog: coll, p_defaults: defs, p_approved: approved }) {
      requireOn('library_catalog_apply_b45');
      return handlers.__catalogApplyB45({ p_collection: coll, p_defaults: defs, p_approved: approved });
    }
  };
  fns.__b45 = { mainSeasons, resumeState, showState, filmState, showMeta, filmMeta, carry };
  return fns;
}

module.exports = { B45_PHASE, EP1_PHASE, isB45Schema, B45_STUBS, SHOW_COLUMNS, FILM_COLUMNS, showDefaults, filmDefaults, seasonNulls,
  migrateFixtures, normalize, patchGuard, b45Handlers, canon, md5 };
