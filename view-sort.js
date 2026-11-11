// ─── Sorting library views (item 13) ─────────────────────────────────────────
// A view's sort is an ordered list of fields, each with its own direction: [{ f, d }], the first
// field primary. Choosing a field makes it primary; fields already chosen keep their order behind it
// (a field chosen again keeps its direction, a new one starts in its default). Its arrow reverses a
// field in place; ✕ takes one field out; Reset to default clears the whole sort. The view's usual
// order is always the final tie-breaker, so an empty sort is the usual order.
// Sorting is display only: it reads what the page already has (stored dates, the up-next season,
// this device's TMDB show cache, show-ratings.js) and never fetches, writes or touches the write lane.
// Unknown values (no date, TBA, no rating shown, a field an item doesn't have) go last in either
// direction. Sorted: Currently Watching (within In progress and Caught up), All TV in Shows, Coming
// Soon (within each month and within TBA; months stay in date order), All Movies, and a collection
// in Shows or Movies only (within its TV and Movies sections, or All media). Not sorted: the flat
// Seasons presentations, Queues (their own order) and the seasons inside an expanded show.
// Page memory (watchlist.html viewSorts) keeps each view's sort while the page is open. With
// Settings' "Remember each view’s sort when I reopen Watchlist" on (the default), each view's sort
// is also saved for this account in this browser (auth.js userStorage); a collection keeps one per
// layout (All media, TV, Movies). Turning it off deletes this account's saved sorts on this browser.

const VIEW_SORTS_KEY = 'watchlist_view_sorts';
const REMEMBER_SORTS_KEY = 'watchlist_remember_sorts';

// Each field's starting direction and its directions in words (Status's words come from the view).
const SORT_FIELD_DEFS = {
  title: { dir: 'asc', words: { asc: 'A to Z', desc: 'Z to A' } },
  premiere: { dir: 'desc', words: { asc: 'oldest first', desc: 'newest first' } },
  next: { dir: 'asc', words: { asc: 'earliest first', desc: 'latest first' } },
  season: { dir: 'asc', words: { asc: 'earliest first', desc: 'latest first' } },
  rating: { dir: 'desc', words: { asc: 'lowest first', desc: 'highest first' } },
  status: { dir: 'asc', words: null },
  priority: { dir: 'desc', words: { asc: 'Low first', desc: 'High first' } },
  // G1 (games): critic and player scores are separate fields. (Length was removed, 2026-11-10: a remembered Length field is
  // dropped by cleanSortSpec, which keeps only defined fields; the rest of that sort stays.)
  release: { dir: 'desc', words: { asc: 'oldest first', desc: 'newest first' } },
  critic: { dir: 'desc', words: { asc: 'lowest first', desc: 'highest first' } },
  player: { dir: 'desc', words: { asc: 'lowest first', desc: 'highest first' } }
};
const SORT_GAME_STATUS_RANK = { playing: 0, paused: 1, want: 2, finished: 3, skipped: 4 };
// Status groups in their default order (ascending); a Skipped film marked watched is Skipped.
const SORT_STATUS_RANK = { watching: 0, confirmed: 1, to_watch: 1, watched: 2, skipped: 3, pair: 3 };
const SORT_PRIORITY_RANK = { high: 3, normal: 2, low: 1 };

// ── What the open view offers ──
// null: the view (or its current layout) isn't sorted. key: where its sort is kept.
function viewSortContext(viewId = activeViewId) {
  const fd = (id, label) => ({ id, label });
  const tvFields = premiereLabel => [fd('title', 'Title'), fd('premiere', premiereLabel), fd('next', 'Next unwatched season premiere'), fd('rating', 'Rating')];
  const filmFields = [fd('title', 'Title'), fd('premiere', 'Release date'), fd('status', 'Status'), fd('priority', 'Priority')];
  const showStatus = ['Watching', 'To Watch', 'Skipped'];
  if (viewId === 'watching') return { key: 'watching', fields: tvFields('Series premiere').concat(fd('priority', 'Priority')) };
  if (viewId === 'alltv') {
    if (allTvPresentation === 'seasons') return null;
    return { key: 'alltv', fields: tvFields('Series premiere').concat(fd('status', 'Status'), fd('priority', 'Priority')), statusOrder: showStatus };
  }
  if (viewId === 'comingsoon') {
    return { key: 'comingsoon', fields: [fd('title', 'Title'), fd('season', 'Season premiere'), fd('rating', 'Show rating'), fd('status', 'Status'), fd('priority', 'Priority')],
      statusOrder: ['Watching', 'To Watch'] };
  }
  if (viewId === 'games') return { key: 'games', fields: [fd('title', 'Title'), fd('release', 'Release date'), fd('status', 'Status'), fd('priority', 'Priority'),
    fd('critic', 'Critic score'), fd('player', 'Player score')], statusOrder: ['Playing', 'Paused', 'Want to play', 'Finished', 'Skipped'] };
  if (typeof ALL_MOVIES_VIEW !== 'undefined' && viewId === ALL_MOVIES_VIEW.id) return { key: 'allmovies', fields: filmFields, statusOrder: ['To Watch', 'Watched', 'Skipped'] };
  if (typeof isBrowseCollectionView === 'function' && isBrowseCollectionView(viewId)) {
    if (browseMedia === 'movie') return { key: `${viewId}:movie`, fields: filmFields, statusOrder: ['To Watch', 'Watched', 'Skipped'] };
    if (browsePresentation === 'seasons') return null;
    if (browseMedia === 'tv') return { key: `${viewId}:tv`, fields: tvFields('Series premiere').concat(fd('status', 'Status'), fd('priority', 'Priority')), statusOrder: showStatus };
    return { key: `${viewId}:all`, fields: tvFields('Premiere or release').concat(fd('status', 'Status'), fd('priority', 'Priority')),
      statusOrder: ['Watching', 'To Watch', 'Watched', 'Skipped'] };
  }
  return null;
}

function sortFieldOf(ctx, f) {
  return ctx ? ctx.fields.find(x => x.id === f) || null : null;
}
function sortDirWords(ctx, f, d) {
  if (f === 'status') {
    const order = (ctx && ctx.statusOrder) || ['Watching', 'To Watch', 'Skipped'];
    return `${d === 'asc' ? order[0] : order[order.length - 1]} first`;
  }
  return SORT_FIELD_DEFS[f].words[d];
}
const flipSortDir = d => (d === 'asc' ? 'desc' : 'asc');
const sortArrow = d => (d === 'asc' ? '↑' : '↓');

// ── Values (pure) ──
// Any listed item as what sorting reads: its show (a show, a season's show), item (a show item with
// its up-next season), season (a Coming Soon row) or film.
function sortSubject(x) {
  if (x && x.kind === 'game') return { game: x.v, title: x.v.title };
  if (x && x.kind === 'show') return { show: x.item.show, item: x.item, title: x.item.title };
  if (x && x.kind === 'film') return { film: x.row, title: x.row.title };
  if (x && x.kind === 'season') return { show: x.show, season: x.row, title: x.show ? x.show.title : x.row.title };
  if (x && x.show && Array.isArray(x.seasons)) return { show: x.show, item: x, title: x.title };
  if (isFilmRow(x)) return { film: x, title: x.title };
  return { show: showOfRow(x), season: x, title: x.title };
}
// A stored date that is a real date and not TBA, else null.
function sortDateOf(r) {
  return r && !isTbaRow(r) && isValidDateSort(r.date_sort) ? r.date_sort : null;
}
const SORT_VALUE = {
  title: s => s.title || '',
  // Games (G1): the date the row shows (its platform line) and the scores IGDB gives.
  release: s => (s.game && s.game.dateKey && s.game.dateKey !== '9999-12-31' ? s.game.dateKey : null),
  critic: s => (s.game && s.game.rec && s.game.rec.critic ? s.game.rec.critic.score : null),
  player: s => (s.game && s.game.rec && s.game.rec.player ? s.game.rec.player.score : null),
  // Series premiere: TMDB's first-air date (this device's cache); a film's own release date.
  premiere: s => (s.film ? sortDateOf(s.film) : showFirstAirDate(s.show)),
  // The season the row's Up next / Next names (an active earlier-seasons range first; skipped seasons passed over).
  next: s => (s.item ? sortDateOf(s.item.upNext) : null),
  season: s => (s.season ? sortDateOf(s.season) : null),
  rating: s => (s.film ? null : showRatingScore(s.show)),
  status: s => (s.game ? SORT_GAME_STATUS_RANK[s.game.entry.status] : s.film ? SORT_STATUS_RANK[filmViewState(s.film)] : s.show ? SORT_STATUS_RANK[s.show.status] : null) ?? null,
  priority: s => SORT_PRIORITY_RANK[(s.game ? s.game.entry : s.film || s.show || {}).priority] ?? null
};

// The comparator for a sort: its fields in order, unknown last either way, then the usual order.
function viewSortComparator(spec, usual) {
  return (a, b) => {
    for (const { f, d } of spec) {
      const va = a.v[f], vb = b.v[f];
      if (va == null || vb == null) {
        if (va == null && vb == null) continue;
        return va == null ? 1 : -1;
      }
      const c = f === 'title' ? compareTitles(va, vb) : typeof va === 'number' ? va - vb : cmpStr(va, vb);
      if (c) return d === 'desc' ? -c : c;
    }
    return usual(a.x, b.x);
  };
}

// One listed section of the open view, sorted by its sort (a new list; the usual order when it has
// none, or when the view isn't sorted). Notes, for the sort line, whether a rating field is active
// and a listed show has no rating on this device.
function sortForView(list, usual) {
  const ctx = viewSortContext();
  const spec = ctx ? viewSortSpec(ctx) : [];
  if (!spec.length) return list.slice().sort(usual);
  const decorated = list.map(x => {
    const s = sortSubject(x), v = {};
    spec.forEach(({ f }) => { v[f] = SORT_VALUE[f](s); });
    return { x, s, v };
  });
  if (spec.some(e => e.f === 'rating') && decorated.some(o => !o.s.film && !o.s.game && o.s.show && o.v.rating == null)) {
    viewSortPass = { key: ctx.key, unrated: true };
  } else if (!viewSortPass || viewSortPass.key !== ctx.key) viewSortPass = { key: ctx.key, unrated: false };
  return decorated.sort(viewSortComparator(spec, usual)).map(o => o.x);
}

// ── The sorts (page memory, and this browser's saved copy) ──
function cleanSortSpec(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  return v.filter(e => e && SORT_FIELD_DEFS[e.f] && (e.d === 'asc' || e.d === 'desc') && !seen.has(e.f) && seen.add(e.f)).map(e => ({ f: e.f, d: e.d }));
}
function readStoredViewSorts() {
  try {
    const v = JSON.parse(userStorage.getItem(VIEW_SORTS_KEY) || '{}');
    return v && typeof v === 'object' && v.views && typeof v.views === 'object' && !Array.isArray(v.views) ? v.views : {};
  } catch (e) { return {}; }
}
// The page's sorts: read from this browser once signed in (when remembering is on), then page memory.
function viewSortMap() {
  if (viewSorts) return viewSorts;
  const map = new Map();
  if (typeof userKey !== 'function' || !userKey('')) return map;
  if (rememberViewSorts()) Object.entries(readStoredViewSorts()).forEach(([k, v]) => { const spec = cleanSortSpec(v); if (spec.length) map.set(k, spec); });
  viewSorts = map;
  return map;
}
// A view's sort, limited to the fields it offers.
function viewSortSpec(ctx) {
  return (viewSortMap().get(ctx.key) || []).filter(e => sortFieldOf(ctx, e.f));
}
// Only this view's entry is written, read afresh, so another tab's sorts are kept.
function storeViewSort(key, spec) {
  if (!rememberViewSorts()) return;
  try {
    const views = readStoredViewSorts();
    if (spec.length) views[key] = spec; else delete views[key];
    if (Object.keys(views).length) userStorage.setItem(VIEW_SORTS_KEY, JSON.stringify({ v: 1, views }));
    else userStorage.removeItem(VIEW_SORTS_KEY);
  } catch (e) { /* storage unavailable: this page only */ }
}
function setViewSortSpec(ctx, spec) {
  const map = viewSortMap();
  if (spec.length) map.set(ctx.key, spec); else map.delete(ctx.key);
  storeViewSort(ctx.key, spec);
}

// ── Remembering (Settings) ──
// The choice made on this page wins (a choice that couldn't be saved holds until the page closes); else
// the stored one; else on.
function rememberViewSorts() {
  if (rememberSortsChoice) return rememberSortsChoice.on;
  try { return userStorage.getItem(REMEMBER_SORTS_KEY) !== 'off'; } catch (e) { return true; }
}
function rememberSortsNoteText() {
  return rememberSortsChoice && !rememberSortsChoice.saved
    ? 'This browser couldn’t save the choice, so it applies only until this page is closed or reloaded.' : '';
}
function viewSortSettingHtml() {
  return `<section class="settings-card" aria-labelledby="settingsSortTitle">
        <h3 id="settingsSortTitle">Sorting</h3>
        <label class="settings-check"><input type="checkbox" class="settings-remember-sorts"${rememberViewSorts() ? ' checked' : ''} onchange="setRememberViewSorts(this.checked)"> Remember each view’s sort when I reopen Watchlist</label>
        <p class="settings-text">While Watchlist is open, each view keeps its sort either way. When this is on, each view’s sort comes back when you reload or reopen Watchlist; when it is off, views open in their usual order, and turning it off forgets the saved sorts. Saved for this account in this browser on this device only.</p>
        <p class="settings-status warn" id="settingsSortNote" role="status">${esc(rememberSortsNoteText())}</p>
      </section>`;
}
// Off deletes this account's saved sorts on this browser (the open page keeps its sorts); on saves the open page's.
function setRememberViewSorts(on) {
  on = !!on;
  let saved = false;
  try { userStorage.setItem(REMEMBER_SORTS_KEY, on ? 'on' : 'off'); saved = true; } catch (e) { /* storage unavailable: this page only */ }
  const map = viewSortMap();
  rememberSortsChoice = { on, saved };
  if (!on) { try { userStorage.removeItem(VIEW_SORTS_KEY); } catch (e) { /* storage unavailable */ } }
  else map.forEach((spec, key) => storeViewSort(key, spec));
  const note = document.getElementById('settingsSortNote');
  if (note) note.textContent = rememberSortsNoteText();
}

// ── Controls ──
// The toolbar's Sort button and its list of fields (a disclosure, like the rows' ⋯).
function sortButtonHtml() {
  if (!viewSortContext()) return '';
  return `<span class="sort-wrap" id="sortWrap" onkeydown="sortMenuKeydown(event)"><button type="button" class="btn sort-btn" id="sortBtn" aria-expanded="false" aria-controls="sortMenu" onclick="toggleSortMenu()">Sort <span aria-hidden="true">▾</span></button><div class="sort-menu" id="sortMenu" role="group" aria-label="Sort by" hidden></div></span>`;
}
function sortMenuHtml(ctx) {
  const spec = viewSortSpec(ctx);
  return `<p class="sort-menu-hint">The field you choose sorts first; earlier choices break ties.</p>` + ctx.fields.map(fd => {
    const at = spec.findIndex(e => e.f === fd.id);
    const d = at >= 0 ? spec[at].d : SORT_FIELD_DEFS[fd.id].dir;
    const words = sortDirWords(ctx, fd.id, d);
    const name = at === 0 ? `${fd.label}, ${words}: sorted by this first` : `Sort by ${fd.label} first, ${words}${at > 0 ? ` (now number ${at + 1})` : ''}`;
    return `<button type="button" class="sort-option${at === 0 ? ' current' : ''}" data-sort-field="${fd.id}" aria-label="${esc(name)}" onclick="chooseSortField('${fd.id}')"><span class="sort-option-label">${esc(fd.label)}</span> <span class="sort-option-dir">${sortArrow(d)} ${esc(words)}</span>${at >= 0 ? `<span class="sort-pos" aria-hidden="true">${at + 1}</span>` : ''}</button>`;
  }).join('');
}
function toggleSortMenu(open) {
  const menu = document.getElementById('sortMenu'), btn = document.getElementById('sortBtn');
  const ctx = viewSortContext();
  if (!menu || !btn || !ctx) return;
  const show = open === undefined ? menu.hidden : !!open;
  if (show) menu.innerHTML = sortMenuHtml(ctx);
  menu.hidden = !show;
  btn.setAttribute('aria-expanded', String(show));
}
function closeSortMenu(focusButton) {
  const menu = document.getElementById('sortMenu');
  if (menu && !menu.hidden) toggleSortMenu(false);
  if (focusButton) focusFilterTarget('sortBtn');
}
function sortMenuKeydown(e) {
  if (!e || e.key !== 'Escape') return;
  const menu = document.getElementById('sortMenu');
  if (!menu || menu.hidden) return;
  if (typeof e.preventDefault === 'function') e.preventDefault();
  if (typeof e.stopPropagation === 'function') e.stopPropagation();
  closeSortMenu(true);
}
function chooseSortField(f) {
  const ctx = viewSortContext();
  if (!ctx || !sortFieldOf(ctx, f)) return;
  const spec = viewSortSpec(ctx);
  closeSortMenu(true);
  if (spec[0] && spec[0].f === f) return; // already first: its arrow reverses it
  const had = spec.find(e => e.f === f);
  setViewSortSpec(ctx, [{ f, d: had ? had.d : SORT_FIELD_DEFS[f].dir }].concat(spec.filter(e => e.f !== f)));
  renderTable();
}
// Reverses one field where it is; focus stays on its arrow.
function reverseSortField(f) {
  const ctx = viewSortContext();
  if (!ctx) return;
  const spec = viewSortSpec(ctx);
  if (!spec.some(e => e.f === f)) return;
  setViewSortSpec(ctx, spec.map(e => (e.f === f ? { f, d: flipSortDir(e.d) } : e)));
  renderTable();
  focusFilterTarget(`sortDir-${f}`);
}
// Takes one field out; focus goes to the next field's arrow, else the previous one's, else Sort.
function removeSortField(f) {
  const ctx = viewSortContext();
  if (!ctx) return;
  const spec = viewSortSpec(ctx), at = spec.findIndex(e => e.f === f);
  if (at < 0) return;
  const rest = spec.filter(e => e.f !== f);
  setViewSortSpec(ctx, rest);
  renderTable();
  const next = rest[at] || rest[at - 1];
  focusFilterTarget(next ? `sortDir-${next.f}` : 'sortBtn');
}
// The whole sort of this view (this layout of a collection) cleared: its usual order. Other views keep theirs.
function resetViewSort() {
  const ctx = viewSortContext();
  if (!ctx) return;
  setViewSortSpec(ctx, []);
  renderTable();
  focusFilterTarget('sortBtn');
}

// The active fields in order, each with its arrow and ✕, then Reset to default; nothing when the view
// has its usual order.
function sortLineHtml(ctx, unrated) {
  const spec = ctx ? viewSortSpec(ctx) : [];
  if (!spec.length) return '';
  const chips = spec.map(e => {
    const fd = sortFieldOf(ctx, e.f), words = sortDirWords(ctx, e.f, e.d), other = sortDirWords(ctx, e.f, flipSortDir(e.d));
    const name = `${fd.label}, ${words}. Reverse to ${other}`;
    return `<span class="sort-chip" data-sort-field="${e.f}"><span class="sort-chip-label">${esc(fd.label)}</span>`
      + `<button type="button" class="sort-dir" id="sortDir-${e.f}" aria-label="${esc(name)}" title="${esc(name)}" onclick="reverseSortField('${e.f}')">${sortArrow(e.d)}</button>`
      + `<button type="button" class="sort-x" id="sortX-${e.f}" aria-label="${esc(`Remove ${fd.label} from the sort`)}" title="Remove from the sort" onclick="removeSortField('${e.f}')"><span aria-hidden="true">✕</span></button></span>`;
  }).join('<span class="sort-then" aria-hidden="true">then</span>');
  const note = unrated ? '<span class="sort-note" id="sortRatingNote">Some shows have no rating on this device.</span>' : '';
  return `<div class="sort-line" role="group" aria-label="Sort order"><span class="sort-line-label" aria-hidden="true">Sorted:</span>${chips}<button type="button" class="btn-link sort-reset" id="sortReset" onclick="resetViewSort()">Reset to default</button>${note}</div>`;
}
// After every list redraw (render.js renderFilterBarState): redrawn only when it changed, so focus on
// one of its controls stays.
function renderSortLine() {
  const ctx = viewSortContext();
  const pass = viewSortPass;
  viewSortPass = null;
  viewSortLast = { key: ctx ? ctx.key : null, unrated: !!(ctx && pass && pass.key === ctx.key && pass.unrated) };
  const box = document.getElementById('sortLine');
  if (!box) return;
  const html = sortLineHtml(ctx, viewSortLast.unrated);
  if (sortLineDrawn && sortLineDrawn.box === box && sortLineDrawn.html === html) return;
  box.innerHTML = html;
  sortLineDrawn = { box, html };
}
// The line as last drawn, for a toolbar redraw (render.js filterBarHtml).
function sortLineNowHtml() {
  const ctx = viewSortContext();
  return sortLineHtml(ctx, !!(ctx && viewSortLast && viewSortLast.key === ctx.key && viewSortLast.unrated));
}

// A click outside the open Sort list closes it.
document.addEventListener('click', function(e) {
  if (e.target.isConnected === false) return;
  if (e.target.closest('.sort-wrap')) return;
  const menu = document.getElementById('sortMenu');
  if (menu && !menu.hidden) toggleSortMenu(false);
});
