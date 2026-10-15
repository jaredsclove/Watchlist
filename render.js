// ─── Filters and table: each view draws its own (derived-views.js, browse-views.js) ──
function renderFilters() {
  if (isBrowseView(activeViewId)) { renderBrowseFilters(); return; }
  if (activeViewId) renderDerivedFilters();
}

// ─── Filter pills ─────────────────────────────────────────────────────────────
// A pill that filters the open list by its value: a genre / theme / network
// (fTheme), a legacy collection tag (fCollection; a saved content tag, not one of
// the personal collections) or a watch-with choice (fWatchWith; filtered by its
// stored token, showing the choice's current label). One value per filter:
// clicking the selected pill clears it, another pill replaces it. A pill shows
// whether it is the current filter (aria-pressed, and ✕ in CSS). Without its
// filter control the label is plain text. Filtering only redraws; nothing is written.
const FILTER_PILLS = {
  theme: { select: 'fTheme', clickable: 'badge-clickable' },
  collection: { select: 'fCollection', clickable: 'collection-tag-clickable' },
  watchwith: { select: 'fWatchWith', clickable: 'ww-tag-clickable' },
  genres: { select: 'fGenre', clickable: 'badge-clickable' },
  forms: { select: 'fForm', clickable: 'badge-clickable' },
  franchises: { select: 'fFranchise', clickable: 'badge-clickable' },
  network: { select: 'fNetwork', clickable: 'badge-clickable' },
  companies: { select: 'fCompany', clickable: 'badge-clickable' }
};

// cls / attrs: the label's existing look; owner: the row or show it sits on (for focus).
function filterPillHtml(kind, value, text, { cls = '', attrs = '', title = '', owner = '' } = {}) {
  const pill = FILTER_PILLS[kind];
  const select = pill && document.getElementById(pill.select);
  const extra = attrs ? ` ${attrs}` : '';
  if (!select) return `<span class="${cls}"${extra}>${esc(text)}</span>`;
  const pressed = value !== '' && select.value === value;
  return `<button type="button" class="${cls} ${pill.clickable} filter-pill"${extra} data-filter-kind="${kind}" data-filter-value="${esc(value)}"${owner ? ` data-pill-owner="${esc(owner)}"` : ''} aria-pressed="${pressed}" title="${esc(pressed ? `Remove this filter (${text})` : title)}" onclick="event.stopPropagation(); toggleFilterPill(this)">${esc(text)}</button>`;
}

// Sets the filter control to the value (or clears it when it is already set) and
// redraws. A value the control doesn't offer changes nothing. B10 (D5): a pill never
// opens the More filters panel; the chip row shows the value instead.
function toggleFilterSelect(selectId, value) {
  const select = document.getElementById(selectId);
  if (!select) return false;
  if (select.tagName === 'SELECT' && select.value !== value && ![...select.options].some(o => o.value === value)) return false;
  select.value = select.value === value ? '' : value;
  // All Movies' ↻ Refresh link for a person collection (a read only), as its select does.
  if (selectId === 'fCollection' && activeViewId === ALL_MOVIES_VIEW.id) updateCollectionRefreshLink();
  renderTable();
  return true;
}

// A pill's click (mouse, Enter or Space). Keyboard focus stays on the same pill
// after the redraw (same container and row, else the same value), else on the filter control.
function toggleFilterPill(btn) {
  const kind = btn && btn.dataset ? btn.dataset.filterKind : '';
  const pill = FILTER_PILLS[kind];
  if (!pill) return;
  const value = btn.dataset.filterValue || '', owner = btn.dataset.pillOwner || '';
  const container = document.activeElement === btn ? focusedContainerOf(['tbody', 'cardList']) : null;
  if (!toggleFilterSelect(pill.select, value) || !container) return;
  const box = document.getElementById(container);
  const sel = `[data-filter-kind="${kind}"][data-filter-value=${JSON.stringify(value)}]`;
  const target = (owner && box && box.querySelector(`${sel}[data-pill-owner=${JSON.stringify(owner)}]`))
    || (box && box.querySelector(sel)) || document.getElementById(pill.select);
  if (target && typeof target.focus === 'function') target.focus();
}

// The Original label filter (each row's stored theme, B4: kept as it was): every value in
// the view's loaded rows (never only the shown ones), so a choice can always be changed or cleared.
function themeFilterSelectHtml(themes, allLabel = 'Any original label', ariaLabel = 'Original label') {
  const list = [...new Set(themes.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return `<select id="fTheme" onchange="renderTable()" aria-label="${esc(ariaLabel)}" title="Original label: the label each entry was saved with">
        <option value="">${esc(allLabel)}</option>${list.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
      </select>`;
}

// ─── Categorized metadata (B4) ────────────────────────────────────────────────
// A TV season shows and filters by its show's metadata (no per-season values); a show
// and a film by their own. Combined TMDB categories stay unresolved candidates: shown in
// Details, filterable as such, never as genres.
function metadataOf(rec) {
  if (rec && typeof isTvSeason === 'function' && isTvSeason(rec) && !('genres' in rec && Array.isArray(rec.genres))) return showOfRow(rec) || {};
  return rec || {};
}
function metadataEmpty(m) {
  return !['genres', 'forms', 'franchises', 'companies'].some(k => (m[k] || []).length) && !m.network;
}
// Chips (filter pills where the view has the filter): up to two genres, then forms,
// franchises and the network. While every category is empty and the owner hasn't saved
// Details, the original label is shown instead (fallback: its badge HTML).
function metadataChipsHtml(m, owner, fallback = '') {
  if (!m || (metadataEmpty(m) && !m.metadata_owner_set)) return fallback;
  const chip = (kind, v) => filterPillHtml(kind, v, v, { cls: `badge meta-chip meta-${kind}`, attrs: kind === 'network' ? networkChipStyle(v) : '', title: `Filter by “${v}”`, owner });
  const genres = m.genres || [];
  return genres.slice(0, 2).map(v => chip('genres', v)).join('')
    + (genres.length > 2 ? `<span class="meta-more" title="${esc(genres.slice(2).join(', '))}">+${genres.length - 2}</span>` : '')
    + (m.forms || []).map(v => chip('forms', v)).join('')
    + (m.franchises || []).map(v => chip('franchises', v)).join('')
    + (m.network ? chip('network', m.network) : '');
}
// The category filters' values (a control that isn't shown doesn't filter).
function categoryFilterValues() {
  const val = id => document.getElementById(id)?.value || '';
  return { genres: val('fGenre'), forms: val('fForm'), franchises: val('fFranchise'), network: val('fNetwork'), companies: val('fCompany') };
}
// AND across categories; one value per category. An unresolved candidate is chosen as "cand:<name>".
function categoryMatches(m, f) {
  if (!f) return true;
  for (const c of METADATA_CATEGORIES) {
    const v = f[c.key];
    if (!v) continue;
    if (c.key === 'genres' && v.startsWith('cand:')) { if (!(m.genre_candidates || []).includes(v.slice(5))) return false; continue; }
    if (c.single ? m[c.key] !== v : !(m[c.key] || []).includes(v)) return false;
  }
  return true;
}
// The category selects, each as a labelled field of the More filters panel (B10). Genre and
// Form offer their whole controlled lists (Genre also an "Unresolved source categories" group
// of the combined names present); Franchise, Network (confirmed values only) and Company offer
// the values of the records the view lists before filtering, and aren't offered while no
// record has one.
function categoryFilterSelectsHtml(records) {
  const ms = records.map(metadataOf);
  return METADATA_CATEGORIES.map(c => {
    const values = c.list ? c.list.slice()
      : [...new Set(ms.flatMap(m => (c.single ? [m[c.key]] : m[c.key] || [])).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const cands = c.key === 'genres' ? [...new Set(ms.flatMap(m => m.genre_candidates || []))].sort((a, b) => a.localeCompare(b)) : [];
    if (!values.length && !cands.length) return '';
    return filterFieldHtml(c.label, c.filter, `<select id="${c.filter}" onchange="renderTable()" aria-label="${esc(c.label)}">
        <option value="">${esc(`Any ${c.label.toLowerCase()}`)}</option>${values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}${cands.length
          ? `<optgroup label="Unresolved source categories">${cands.map(v => `<option value="cand:${esc(v)}">${esc(v)} (unresolved)</option>`).join('')}</optgroup>` : ''}
      </select>`);
  }).join('');
}
// Priority and the markers (shows and films alike).
function priorityFilterSelectHtml() {
  return `<select id="fPriority" onchange="renderTable()" aria-label="Priority">
        <option value="">Any priority</option><option value="high">★ High</option><option value="normal">Normal</option>
        <option value="low">Low</option><option value="highnormal">High + Normal</option></select>`;
}
// The markers: two checkboxes; a ticked one keeps only the records that have that marker.
const MARKER_FILTER_IDS = ['fNew', 'fReview'];
function markerFilterChecksHtml() {
  return `<label class="filter-check"><input type="checkbox" id="fNew" onchange="renderTable()"> New from catalog</label>
      <label class="filter-check"><input type="checkbox" id="fReview" onchange="renderTable()"> Needs status review</label>`;
}
function markerFilterValues() {
  return { fNew: !!document.getElementById('fNew')?.checked, fReview: !!document.getElementById('fReview')?.checked };
}
function priorityMatches(p, fPriority) {
  if (!fPriority) return true;
  if (fPriority === 'highnormal') return p !== 'low';
  return p === fPriority;
}
function markerMatches(rec, m) {
  return (!m || !m.fNew || !!rec.catalog_new) && (!m || !m.fReview || !!rec.status_review);
}

// ─── Filter bar (B10) ─────────────────────────────────────────────────────────
// Every derived and browse view draws one filter bar (filterBarHtml). On one line: Search, the
// view's scope controls (those that hide something by default) and More filters. Then the More
// filters panel: every other control, grouped; closed means hidden, never removed, so its
// controls keep filtering and its pills keep working. Then the chip row: the applied values, the
// values the visit keeps that don't filter in this mode ("Not applied"), and Clear filters. DOM
// order is the keyboard order. The renderers filter exactly as before (they read the controls);
// nothing here sends a request or writes.

// A labelled control of the panel (a control that isn't offered gives no field).
function filterFieldHtml(label, id, control) {
  return control ? `<div class="filter-field"><label class="filter-field-label" for="${id}">${esc(label)}</label>${control}</div>` : '';
}

// lead: what stays outside the filters (layout toggles, + Add); line: the scope controls;
// cats / marks / more: the panel's fields, in that group order.
function filterBarHtml({ lead = '', line = '', cats = [], marks = [], more = [] }) {
  const groups = [['Categories', cats], ['Your marks', marks], ['More', more]].map(([title, fields]) => {
    const body = fields.filter(Boolean).join('');
    return body ? `<div class="filter-group" role="group" aria-label="${title}"><span class="filter-group-title" aria-hidden="true">${title}</span>${body}</div>` : '';
  }).join('');
  return `${lead}
    <div class="filter-line">
      <input class="search-input" id="fSearch" type="text" placeholder="Search titles…" aria-label="Search titles" oninput="renderTable()">${line}
      <button type="button" class="btn filter-more-btn" id="filterMoreBtn" aria-expanded="${filterPanelOpen}" aria-controls="filterMore" onclick="toggleFilterPanel()"><span class="more-label-wide">More filters</span><span class="more-label-narrow">Filters</span><span class="filter-count" id="filterMoreCount" aria-hidden="true" hidden></span><span class="visually-hidden" id="filterMoreA11y"></span> <span id="filterMoreChevron" aria-hidden="true">${filterPanelOpen ? '▴' : '▾'}</span></button>
    </div>
    <div class="filter-more" id="filterMore" role="group" aria-label="More filters" onkeydown="filterPanelKeydown(event)"${filterPanelOpen ? '' : ' hidden'}>${groups}</div>
    <div class="filter-chips" id="filterChips"></div>`;
}

// The panel's open state (proposal §4.2.1): kept for a redraw of the same visit (a filter,
// presentation or media change, reload, Retry, an action); a fresh entry (switchView resets
// the visit's memory: another view, TV ↔ Movies, a collection) and Back close it.
function filterPanelStart(tag, restored) {
  if (restored || viewFilterMemory.tag !== tag) filterPanelOpen = false;
}

function toggleFilterPanel(open = !filterPanelOpen) {
  filterPanelOpen = !!open;
  const panel = document.getElementById('filterMore');
  if (panel) panel.hidden = !filterPanelOpen;
  const btn = document.getElementById('filterMoreBtn');
  if (btn && typeof btn.setAttribute === 'function') btn.setAttribute('aria-expanded', String(filterPanelOpen));
  const chevron = document.getElementById('filterMoreChevron');
  if (chevron) chevron.textContent = filterPanelOpen ? '▴' : '▾';
}

// Escape inside the open panel closes it and returns focus to its button.
function filterPanelKeydown(e) {
  if (!e || e.key !== 'Escape' || !filterPanelOpen) return;
  if (typeof e.preventDefault === 'function') e.preventDefault();
  toggleFilterPanel(false);
  focusFilterTarget('filterMoreBtn');
}

// Chip order: the scope controls, then the panel's groups (Categories, Your marks, More).
// 'seasons' is the Seasons / TV seasons choice (page state, not the visit's memory).
const FILTER_DEFS = [
  { id: 'fStatus', label: 'Status', scope: true }, { id: 'fWatch', label: 'Watched', scope: true }, { id: 'seasons', scope: true },
  { id: 'fGenre', label: 'Genre' }, { id: 'fForm', label: 'Form' }, { id: 'fFranchise', label: 'Franchise' },
  { id: 'fNetwork', label: 'Network' }, { id: 'fCompany', label: 'Company' },
  { id: 'fPriority', label: 'Priority' }, { id: 'fNew', label: 'New from catalog', check: true },
  { id: 'fReview', label: 'Needs status review', check: true }, { id: 'fWatchWith', label: 'Watch with' },
  { id: 'fYear', label: 'Year' }, { id: 'fProgress', label: 'Progress' }, { id: 'fCollection', label: 'Collection tag' },
  { id: 'fTheme', label: 'Original label' }
];
const FILTER_PRIORITY_LABELS = { high: '★ High', normal: 'Normal', low: 'Low', highnormal: 'High + Normal' };
const FILTER_CONTEXT_SENTENCES = { 'Shows only': 'Applies in Shows only.', 'Seasons only': 'Applies in Seasons only.',
  'while films are shown': 'Applies while films are shown.', 'not offered in this list': 'Not offered in this list.' };

// A filter's starting value (what a fresh entry gives): All Movies opens on Unwatched only;
// every other control on its first choice ('' / unticked).
function filterDefault(id) {
  return id === 'fWatch' && activeViewId === ALL_MOVIES_VIEW.id ? 'unwatched' : '';
}

// The Seasons choice of All TV or a collection: its value, and whether the current mode lists seasons.
function filterSeasonsState() {
  if (activeViewId === 'alltv') return { label: 'Seasons', value: allTvSeasonVis, labels: ALLTV_SEASON_VIS_LABELS, applies: allTvPresentation === 'seasons' };
  if (isBrowseCollectionView(activeViewId)) return { label: 'TV seasons', value: browseSeasonVis, labels: BROWSE_SEASON_VIS_LABELS,
    applies: browsePresentation === 'seasons' && browseMedia !== 'movie' };
  return null;
}
function setFilterSeasonsDefault() {
  if (activeViewId === 'alltv') allTvSeasonVis = 'notskipped';
  else if (isBrowseCollectionView(activeViewId)) browseSeasonVis = 'notskipped';
  else return;
  const select = document.getElementById('fSeasonVis');
  if (select) select.value = 'notskipped';
}

// A value as its control shows it.
function filterValueText(id, v) {
  if (id === 'fStatus') return v === 'all' ? 'All statuses' : (isBrowseView(activeViewId) ? BROWSE_STATUS_LABELS[v] : plainStatusLabel(v)) || v;
  if (id === 'fWatch') return BROWSE_WATCH_LABELS[v] || v;
  if (id === 'fPriority') return FILTER_PRIORITY_LABELS[v] || v;
  if (id === 'fProgress') return ALLTV_PROGRESS_LABELS[v] || v;
  if (id === 'fWatchWith') return watchWithArchived(v) ? `${watchWithLabel(v)} (archived)` : watchWithLabel(v);
  if (id === 'fGenre' && v.startsWith('cand:')) return `${v.slice(5)} (unresolved)`;
  return v;
}

// Why a kept value doesn't filter: its control isn't in the current mode.
function filterKeptContext(id) {
  if (id === 'fProgress') return 'Shows only';
  if ((id === 'fCollection' || id === 'fWatchWith') && isBrowseCollectionView(activeViewId) && browseMedia === 'tv') return 'while films are shown';
  return 'not offered in this list';
}

// What the chip row shows (proposal §4.3, §4.3.1). A control in the page (open or closed panel)
// filters by its value: applied when that isn't the starting value. A value counts as "Not
// applied" only when the visit's memory keeps it and no control in the page filters by it (the
// renderers read a missing control as no filter); for the Seasons choice, when the mode lists
// no seasons. Options and result counts never decide it. badge: the panel's applied controls.
function filterChipModel() {
  const tag = `view:${activeViewId}`;
  const kept = viewFilterMemory.tag === tag ? viewFilterMemory.values : {};
  const applied = [], inactive = [];
  for (const d of FILTER_DEFS) {
    if (d.id === 'seasons') {
      const s = filterSeasonsState();
      if (s && s.value !== 'notskipped') (s.applies ? applied : inactive).push({ key: 'seasons', label: s.label, text: s.labels[s.value] || s.value, scope: true, context: 'Seasons only' });
      continue;
    }
    const el = document.getElementById(d.id), def = filterDefault(d.id);
    const chip = v => ({ key: d.id, label: d.label, text: d.check ? '' : filterValueText(d.id, v), check: !!d.check, scope: !!d.scope });
    if (el) {
      const v = d.check ? (el.checked ? 'on' : '') : (el.value || '');
      if (v !== def) applied.push(chip(v));
    } else if (kept[d.id] !== undefined && kept[d.id] !== def) {
      inactive.push({ ...chip(kept[d.id]), context: filterKeptContext(d.id) });
    }
  }
  const search = document.getElementById('fSearch');
  return { applied, inactive, search: !!(search && search.value), badge: applied.filter(c => !c.scope).length };
}

// Whether anything differs from the view's starting filters (Search text included).
function viewFiltersNonDefault() {
  const m = filterChipModel();
  return m.search || m.applied.length > 0 || m.inactive.length > 0;
}

function filterChipHtml(c, applied) {
  const what = c.check ? c.label : `${c.label}, ${c.text}`;
  const name = applied ? `Remove filter: ${what}` : `Not applied: ${what}. ${FILTER_CONTEXT_SENTENCES[c.context]} Remove.`;
  const body = c.check ? `<span class="chip-v">${esc(c.label)}</span>` : `<span class="chip-k">${esc(c.label)}:</span> <span class="chip-v">${esc(c.text)}</span>`;
  const kept = applied ? '' : ` <span class="chip-na">Not applied (${esc(c.context)})</span>`;
  return `<button type="button" id="chip-${c.key}" class="filter-chip${applied ? '' : ' filter-chip-kept'}" aria-label="${esc(name)}" title="${esc(name)}" onclick="removeFilterChip('${c.key}')">${body}${kept}<span class="chip-x" aria-hidden="true">✕</span></button>`;
}

// After every list redraw: the chip row, the More filters count and the marked controls.
// Only these are redrawn; the controls are not, so focus stays where it is.
function renderFilterBarState() {
  const box = document.getElementById('filterChips');
  if (!box) return;
  const m = filterChipModel();
  const group = (list, label, visible, applied) => (list.length
    ? `<div class="chip-group" role="group" aria-label="${label}"><span class="chips-label" aria-hidden="true">${visible}</span>${list.map(c => filterChipHtml(c, applied)).join('')}</div>` : '');
  const clear = m.search || m.applied.length || m.inactive.length
    ? '<button type="button" class="btn-link filter-clear" id="filterClear" onclick="clearViewFilters()">Clear filters</button>' : '';
  box.innerHTML = group(m.applied, 'Active filters', 'Active:', true) + group(m.inactive, 'Kept, not applied', 'Kept, not applied:', false) + clear;
  const count = document.getElementById('filterMoreCount');
  if (count) { count.textContent = m.badge ? String(m.badge) : ''; count.hidden = !m.badge; }
  const a11y = document.getElementById('filterMoreA11y');
  if (a11y) a11y.textContent = m.badge ? `, ${m.badge} active` : '';
  const marked = new Set(m.applied.map(c => (c.key === 'seasons' ? 'fSeasonVis' : c.key)));
  FILTER_DEFS.map(d => (d.id === 'seasons' ? 'fSeasonVis' : d.id)).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList[marked.has(id) ? 'add' : 'remove']('filter-set');
  });
}

function filterChipOrder() {
  const m = filterChipModel();
  return m.applied.concat(m.inactive).map(c => c.key);
}

function focusFilterTarget(id) {
  const el = document.getElementById(id);
  if (!el || typeof el.focus !== 'function') return;
  el.focus();
  if (id === 'fSearch' && typeof el.setSelectionRange === 'function') el.setSelectionRange(el.value.length, el.value.length);
}

// A chip's ✕: that one value back to its starting value (the control, or the kept value of a
// control the mode doesn't show), as changing the control would. Focus: the next chip, else the
// previous one, else Search.
function removeFilterChip(key) {
  const before = filterChipOrder();
  const at = before.indexOf(key);
  if (at < 0) return;
  const tag = `view:${activeViewId}`;
  if (key === 'seasons') setFilterSeasonsDefault();
  else {
    const def = filterDefault(key), el = document.getElementById(key);
    if (el) { if (MARKER_FILTER_IDS.includes(key)) el.checked = false; else el.value = def; }
    if (viewFilterMemory.tag === tag) viewFilterMemory.values[key] = def;
    if (key === 'fCollection' && activeViewId === ALL_MOVIES_VIEW.id) updateCollectionRefreshLink();
  }
  renderTable();
  const after = filterChipOrder();
  const next = after[at] || after[at - 1];
  focusFilterTarget(next ? `chip-${next}` : 'fSearch');
}

// Clear filters (proposal §4.4): every filter of the open view back to its starting value,
// kept values included; layout, expansion, sections and the panel's state are unchanged.
// Focus: Search (moved there first, so a Clear inside the list leaves nothing to carry).
function clearViewFilters() {
  const tag = `view:${activeViewId}`;
  focusFilterTarget('fSearch');
  const search = document.getElementById('fSearch');
  if (search) search.value = '';
  FILTER_DEFS.forEach(d => {
    if (d.id === 'seasons') { setFilterSeasonsDefault(); return; }
    const el = document.getElementById(d.id);
    if (el) { if (d.check) el.checked = false; else el.value = filterDefault(d.id); }
  });
  if (viewFilterMemory.tag === tag) {
    const values = {};
    VIEW_FILTER_IDS.forEach(id => { values[id] = filterDefault(id); });
    viewFilterMemory = { tag, values };
  }
  if (activeViewId === ALL_MOVIES_VIEW.id) updateCollectionRefreshLink();
  renderTable();
  focusFilterTarget('fSearch');
}

// Clear filters inside a "no matches" message (D7), while anything differs from the starting filters.
function filterEmptyClearHtml() {
  return viewFiltersNonDefault() ? ' <button type="button" class="btn empty-clear" onclick="clearViewFilters()">Clear filters</button>' : '';
}

// ─── Details: categorized metadata of one show or film (O7) ───────────────────
// Opened from an expanded show (All TV, Currently Watching) or a film's ⋯ (All Movies).
// Saving records the owner's choice (also with every field left empty) through one guarded
// call; nothing automatic changes it afterwards. The original labels are shown read-only.
// Each opening is a session bound to the metadata it displayed (its snapshot), the restore
// epoch and its own id: Save sends that snapshot as the expected values, so a draft never
// overwrites values that changed meanwhile (a refresh or another page), never runs after a
// restore, and an answer for an earlier opening never closes or changes a newer one. Values
// are kept exactly as typed (commas included; surrounding spaces trimmed); anything the
// database wouldn't accept is refused here with the reason, and the draft stays.
function detailsRecord() {
  if (!detailsDialog) return null;
  return detailsDialog.kind === 'show' ? tvShowsById.get(detailsDialog.id) || null : (actionRows().find(r => r.id === detailsDialog.id) || null);
}
function metadataExpected(rec, kind) {
  const m = { genres: (rec.genres || []).slice(), forms: (rec.forms || []).slice(), franchises: (rec.franchises || []).slice(),
    companies: (rec.companies || []).slice(), genre_candidates: (rec.genre_candidates || []).slice() };
  if (kind === 'show') Object.assign(m, { network: rec.network ?? null, network_candidates: (rec.network_candidates || []).slice() });
  m.metadata_owner_set = !!rec.metadata_owner_set;
  return m;
}
function openDetails(kind, id, opener) {
  const rec = kind === 'show' ? tvShowsById.get(id) : actionRows().find(r => r.id === id);
  if (!rec) return;
  const snapshot = metadataExpected(rec, kind);
  const labels = kind === 'show'
    ? [...new Set(((derivedData && derivedData.rows) || []).filter(r => r.show_id === rec.id).map(r => r.theme).filter(Boolean))]
    : [rec.theme].filter(Boolean);
  detailsDialog = { session: ++detailsSessionSeq, kind, id, title: rec.title, epoch: orgEpoch, snapshot, labels, opener: opener || null,
    draft: { genres: snapshot.genres.slice(), forms: snapshot.forms.slice(), franchises: snapshot.franchises.slice(),
      companies: snapshot.companies.slice(), resolve: {}, network: kind === 'show' ? (snapshot.network || '') : '' },
    error: '', notice: '', saving: false, stale: null, picker: false };
  renderDetails();
  document.getElementById('detailsModalOverlay').style.display = 'flex';
  const box = document.getElementById('detailsModalBox');
  if (box && typeof box.focus === 'function') box.focus();
}
function closeDetails() {
  const opener = detailsDialog && detailsDialog.opener;
  detailsDialog = null;
  document.getElementById('detailsModalOverlay').style.display = 'none';
  document.getElementById('detailsModalBox').innerHTML = '';
  if (opener && typeof opener.focus === 'function') opener.focus();
}
// Discards this draft and starts again from what the page holds now (after a refusal or an
// unknown outcome, once the list was read again). Never automatic.
function detailsRestart() {
  if (!detailsDialog) return;
  const { kind, id, opener } = detailsDialog;
  openDetails(kind, id, opener);
}
function detailsKeydown(e) {
  if (e && e.key === 'Escape') closeDetails();
}
// Draft edits (no redraw while typing, so focus stays).
function detailsToggle(field, index, checked) {
  if (!detailsDialog) return;
  const v = (field === 'genres' ? GENRES : FORMS)[index];
  const list = detailsDialog.draft[field].filter(x => x !== v);
  if (checked) list.push(v);
  detailsDialog.draft[field] = list;
}
function detailsSetValue(field, index, value) { if (detailsDialog) detailsDialog.draft[field][index] = String(value); }
function detailsAddValue(field) { if (!detailsDialog) return; detailsDialog.draft[field].push(''); renderDetails(); }
function detailsRemoveValue(field, index) { if (!detailsDialog) return; detailsDialog.draft[field].splice(index, 1); renderDetails(); }
function detailsResolve(index, choice) { if (detailsDialog) detailsDialog.draft.resolve[index] = choice; }
function detailsSetNetwork(value) { if (detailsDialog) detailsDialog.draft.network = String(value); }
function detailsPickNetwork(index) {
  if (!detailsDialog) return;
  detailsDialog.draft.network = (detailsDialog.snapshot.network_candidates || [])[index] || '';
  renderDetails();
}
function detailsTogglePicker() { if (detailsDialog) { detailsDialog.picker = !detailsDialog.picker; renderDetails(); } }

// The draft as the database would store it, or the reasons it can't be (nothing is dropped).
function detailsValidate(dialog) {
  const d = dialog.draft, problems = [];
  const list = (field, label, values) => {
    const out = values.map(v => String(v).trim()).filter(v => v !== '');
    out.filter(v => v.length > METADATA_LIMITS.length).forEach(v => problems.push(`${label}: “${v.slice(0, 30)}…” is longer than ${METADATA_LIMITS.length} characters.`));
    if (out.length > METADATA_LIMITS.values) problems.push(`${label}: at most ${METADATA_LIMITS.values} values (there are ${out.length}).`);
    const seen = new Map();
    out.forEach(v => { const k = v.toLowerCase(); if (seen.has(k)) problems.push(`${label}: “${v}” is listed twice.`); seen.set(k, v); });
    return out;
  };
  const genres = d.genres.slice(), candidates = [];
  (dialog.snapshot.genre_candidates || []).forEach((c, i) => {
    const choice = d.resolve[i] || '';
    const pair = COMBINED_CATEGORIES[c] || [];
    if (!choice) { candidates.push(c); return; }
    const add = choice === 'a' ? [pair[0]] : choice === 'b' ? [pair[1]] : choice === 'both' ? pair : [];
    add.filter(Boolean).forEach(g => { if (!genres.includes(g)) genres.push(g); });
  });
  const metadata = { genres: list('genres', 'Genres', GENRES.filter(g => genres.includes(g))), forms: list('forms', 'Form', FORMS.filter(f => d.forms.includes(f))),
    franchises: list('franchises', 'Franchise / universe', d.franchises), companies: list('companies', 'Production company', d.companies),
    genre_candidates: candidates };
  if (dialog.kind === 'show') {
    const net = String(d.network || '').trim();
    if (net.length > METADATA_LIMITS.length) problems.push(`Original network: “${net.slice(0, 30)}…” is longer than ${METADATA_LIMITS.length} characters.`);
    metadata.network = net || null;
    metadata.network_candidates = (dialog.snapshot.network_candidates || []).slice();
  }
  return { metadata, problems };
}

// Viewing progress of a show (§4.7, details placement): Caught up · Ended, earlier unwatched
// seasons with "Watch earlier seasons", the range's state and its recovery actions. Live (what
// the page holds now); the actions are the same guarded calls as in the expanded show.
function detailsProgressHtml(show) {
  const seasons = ((derivedData && derivedData.rows) || []).filter(r => r.show_id === show.id);
  if (!seasons.length) return '';
  const range = resumeRange(show, seasons);
  const active = !!range && range.state === 'active';
  const gap = gapSeasons(seasons);
  const idArg = esc(show.id).replace(/'/g, "\\'");
  const lines = [];
  if (!active && isEndedExit(show, seasons)) lines.push('<span class="caught-ended">Caught up · Ended</span>');
  if (gap.length) lines.push(`<span>${gap.length} earlier season${gap.length === 1 ? '' : 's'} unwatched</span>`);
  if (range) {
    const text = range.state === 'active' ? `Watching earlier seasons from ${esc(range.start ? range.start.season : '')}`
      : range.state === 'complete' ? 'Earlier seasons done' : 'Earlier-seasons range no longer applies; choose again or stop';
    lines.push(`<span>${text}</span>`);
  }
  const actions = [];
  if (gap.length && !active) {
    const label = range && range.state === 'invalid' ? 'Choose again' : show.status === 'watching' ? 'Watch earlier seasons…' : 'Start watching earlier seasons…';
    actions.push(`<button class="btn btn-link" aria-expanded="${!!detailsDialog.picker}" onclick="detailsTogglePicker()">${label}</button>`);
  }
  if (range) actions.push(`<button class="btn btn-link" onclick="stopResume('${idArg}')">Stop watching earlier seasons</button>`);
  if (range && range.state === 'invalid' && !gap.length) lines.push('<span class="manage-hint">No earlier unwatched season to choose now.</span>');
  const picker = detailsDialog.picker && gap.length && !active
    ? `<div class="resume-picker" role="group" aria-label="Start from">${gap.map(r => `<button class="btn" onclick="startResume('${idArg}', '${esc(r.id)}')">Start from ${esc(r.season)}</button>`).join(' ')}</div>` : '';
  if (!lines.length && !actions.length) return '';
  return `<div class="details-field"><span class="modal-label">Viewing progress</span><div class="details-progress">${lines.join(' · ')}</div>
    ${actions.length ? `<div class="show-actions-inner">${actions.join(' ')}</div>` : ''}${picker}</div>`;
}

function renderDetails() {
  const box = document.getElementById('detailsModalBox');
  if (!box || !detailsDialog) return;
  const dlg = detailsDialog, rec = detailsRecord();
  if (!rec && !dlg.saving) { box.innerHTML = `<div class="modal-title" id="detailsTitle">Details</div><div class="modal-error">This entry isn’t on the page any more. Nothing was changed.</div><div class="modal-actions"><button class="btn" onclick="closeDetails()">Close</button></div>`; return; }
  const kind = dlg.kind, m = dlg.snapshot, d = dlg.draft;
  const restored = dlg.epoch !== orgEpoch;
  const locked = !!dlg.stale || restored;
  const checks = (field, listName, list) => `<div class="details-checks">${list.map((v, i) =>
    `<label class="details-check"><input type="checkbox" name="${listName}" value="${esc(v)}"${d[field].includes(v) ? ' checked' : ''} onchange="detailsToggle('${field}', ${i}, this.checked)"> ${esc(v)}</label>`).join('')}</div>`;
  const values = (field, label, addLabel) => `<div class="details-field"><span class="modal-label">${esc(label)}</span>
      ${d[field].map((v, i) => `<div class="details-value"><input type="text" class="search-input" id="details-${field}-${i}" value="${esc(v)}" aria-label="${esc(label)} ${i + 1}" oninput="detailsSetValue('${field}', ${i}, this.value)">
        <button type="button" class="btn btn-link" onclick="detailsRemoveValue('${field}', ${i})" aria-label="Remove ${esc(label)} ${i + 1}">Remove</button></div>`).join('')}
      <button type="button" class="btn btn-link" onclick="detailsAddValue('${field}')">${esc(addLabel)}</button></div>`;
  const cands = m.genre_candidates.length ? `<div class="details-field"><span class="modal-label">Unresolved source categories</span>
      ${m.genre_candidates.map((c, i) => {
        const pair = COMBINED_CATEGORIES[c];
        const opts = (pair ? [['a', pair[0]], ['b', pair[1]], ['both', 'Both']] : []).concat([['neither', 'Neither']]);
        return `<div class="details-candidate"><span class="state-tag review-tag-b45">Unresolved category</span> Unresolved source category: ${esc(c)}
          <select id="detailsResolve${i}" aria-label="Resolve ${esc(c)}" onchange="detailsResolve(${i}, this.value)"><option value="">Resolve…</option>${opts.map(([v, l]) =>
            `<option value="${v}"${d.resolve[i] === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
      }).join('')}</div>` : '';
  const network = kind === 'show' ? `<div class="details-field"><span class="modal-label">Original network / service</span>
      <input type="text" id="detailsNetwork" class="search-input" value="${esc(d.network)}" placeholder="Not set" oninput="detailsSetNetwork(this.value)">
      ${(m.network_candidates || []).length ? `<p class="browse-note">Network candidates (TMDB): ${m.network_candidates.map((n, i) =>
        `<button type="button" class="btn btn-link" onclick="detailsPickNetwork(${i})">${esc(n)}</button>`).join(', ')}</p>` : ''}</div>` : '';
  const progress = kind === 'show' && rec ? detailsProgressHtml(rec) : '';
  const lockText = restored ? 'A restore happened since this dialog opened, so it can’t save. Your entries are shown for reference; start again from the current values.'
    : dlg.stale === 'changed' ? 'This entry changed since this dialog opened, so nothing was saved. Your entries are shown for reference; start again from the current values to edit what is stored now.'
    : dlg.stale === 'unknown' ? 'The save wasn’t confirmed and won’t be sent again. Your entries are shown for reference; start again from the current values once you have checked what is stored.' : '';
  box.innerHTML = `<div class="modal-title" id="detailsTitle">Details · ${esc(dlg.title)}</div>
    ${progress}
    ${dlg.labels.length ? `<div class="details-field"><span class="modal-label">Original label${dlg.labels.length > 1 ? 's' : ''}</span><div>${dlg.labels.map(esc).join(', ')}</div></div>` : ''}
    <div class="details-field"><span class="modal-label">Genres</span>${checks('genres', 'detailsGenre', GENRES)}</div>
    ${cands}
    <div class="details-field"><span class="modal-label">Form</span>${checks('forms', 'detailsForm', FORMS)}</div>
    ${values('franchises', 'Franchise / universe', 'Add a franchise / universe')}
    ${network}
    ${values('companies', 'Production company', 'Add a production company')}
    ${dlg.error ? `<div class="modal-error" role="alert">${esc(dlg.error)}</div>` : ''}
    ${dlg.notice ? `<div class="manage-hint" role="status">${esc(dlg.notice)}</div>` : ''}
    ${lockText ? `<div class="modal-error" role="alert">${esc(lockText)}</div>` : ''}
    <div class="modal-actions"><button class="btn" onclick="closeDetails()">${locked ? 'Close' : 'Cancel'}</button>
      ${locked ? '<button class="btn btn-accent" onclick="detailsRestart()">Start again from the current values</button>'
        : `<button class="btn btn-accent" onclick="saveDetails()"${dlg.saving ? ' disabled' : ''}>${dlg.saving ? 'Saving…' : 'Save'}</button>`}</div>`;
}

async function saveDetails() {
  if (isBrowseView(activeViewId) && activeViewId !== ALL_MOVIES_VIEW.id) return; // read-only views never write
  const dlg = detailsDialog;
  if (!dlg || dlg.saving || dlg.stale) return;
  if (dlg.epoch !== orgEpoch) { renderDetails(); return; } // a restore happened: nothing is sent (the dialog says so)
  const { metadata, problems } = detailsValidate(dlg);
  if (problems.length) { dlg.error = `Not saved: ${problems.join(' ')} Correct these and save again.`; renderDetails(); return; }
  const { session, kind, id, title, epoch } = dlg;
  dlg.saving = true;
  dlg.error = '';
  renderDetails();
  const current = () => detailsDialog && detailsDialog.session === session ? detailsDialog : null; // this opening, still open
  try {
    const res = await sbRpc('library_set_metadata_b45', { p_kind: kind, p_id: id, p_expected: dlg.snapshot, p_metadata: metadata });
    if (epoch !== orgEpoch) { if (current()) closeDetails(); staleAfterRestore(`“${title}” · details`); return; }
    if (kind === 'show' && res && res.show) { const rec = tvShowsById.get(id); if (rec) Object.assign(rec, res.show); }
    else if (res && res.row) mirrorRowUpdate(id, res.row, epoch);
    showSaved();
    if (current()) closeDetails();
    renderFilters();
    renderTable();
  } catch (e) {
    if (epoch !== orgEpoch) { if (current()) closeDetails(); staleAfterRestore(`“${title}” · details`); return; }
    const mine = current();
    if (mine) {
      mine.saving = false;
      mine.error = stateErrorText(e);
      if (stateNeedsReread(e)) mine.stale = stateUnconfirmed(e) ? 'unknown' : 'changed';
      renderDetails();
    }
    // Stale or unknown: the open view is read again (same epoch); the dialog keeps this draft
    // and says whether that read succeeded. An earlier opening's answer touches no dialog.
    const ok = await reportStateFailure(e, epoch);
    const still = current();
    if (still && still.stale) { still.notice = rereadText(ok).trim(); renderDetails(); }
  }
}

// A film's legacy collection tags (cleaned names) and watch-with choices as filter pills.
function collectionTagPillsHtml(tags, owner) {
  return tags.map(c => filterPillHtml('collection', c, c, { cls: 'collection-tag', title: 'Filter by this collection tag', owner })).join('');
}
function watchWithPillsHtml(tokens, owner) {
  return tokens.map(w => filterPillHtml('watchwith', w, watchWithLabel(w), { cls: 'ww-tag', title: 'Filter by this person', owner })).join('');
}

// ─── Render table ─────────────────────────────────────────────────────────────
function renderTable() {
  if (isBrowseView(activeViewId)) { renderBrowseTable(); return; }
  if (activeViewId) renderDerivedTable();
}

// ─── Watch-with picker (films) ────────────────────────────────────────────────
// The choices on offer, plus any value the row already has that isn't offered
// (an archived choice), so it can still be seen and unticked. Values are tokens;
// what's shown is the choice's label.
function watchWithPickerHtml(rowId, current) {
  current = current || [];
  if (!watchWithUsable()) return `<span class="ww-status">${watchWithStatusHtml()}</span>`;
  const offered = watchWithChoiceList();
  // Archived choices are listed only on rows that have them, marked, and can only be unticked.
  const extra = current.filter(t => !offered.some(o => o.token === t))
    .map(t => ({ token: t, label: watchWithArchived(t) ? `${watchWithLabel(t)} (archived)` : watchWithLabel(t) }));
  const stale = orgChoicesStale ? `<span class="ww-stale">Choices may be out of date · <button class="btn" onclick="retryOrgRefresh()">Retry</button></span>` : '';
  return stale + offered.concat(extra).map(opt => {
    const checked = current.includes(opt.token) ? 'checked' : '';
    return `<label class="ww-option"><input type="checkbox" value="${esc(opt.token)}" ${checked} onchange="toggleWatchWith('${rowId}', '${esc(opt.token).replace(/'/g,"\\'")}', this.checked)"> ${esc(opt.label)}</label>`;
  }).join('');
}

function toggleMorePopover(rowId, btn) {
  // Each movie row renders this popover twice (desktop table cell and mobile card),
  // so open the copy next to the tapped button rather than the first one by id.
  const container = btn && btn.closest('.more-cell, .card-top');
  const el = container ? container.querySelector('.more-popover') : document.getElementById(`more-popover-${rowId}`);
  if (!el) return;
  const isOpen = el.style.display !== 'none';
  // close any other open popovers first
  document.querySelectorAll('.more-popover').forEach(p => p.style.display = 'none');
  el.style.display = isOpen ? 'none' : 'block';
}

// close any open popover when clicking elsewhere on the page
document.addEventListener('click', function(e) {
  if (e.target.closest('.more-popover') || e.target.closest('.more-btn')) return;
  document.querySelectorAll('.more-popover').forEach(p => p.style.display = 'none');
});


// ─── Season rows (derived views) ─────────────────────────────────────────────
// The watch control for one season row. Derived views pass requireReleased, which
// replaces "Mark watched" with a note until the season has aired (a row already
// marked watched keeps its toggle so it can be undone). compact is the mobile label.
// opts.shortcutOf (B2): the show whose show-level shortcut this is; the button then names
// the season it marks ("Mark Season 1 watched"), in full (it wraps, never truncates), and
// its accessible name names the show too. Same action as the season row's button.
function seasonWatchControlHtml(r, opts, compact) {
  if (isOffList(r)) return compact ? '' : `<span class="confirmed-lbl">—</span>`;
  if (opts.requireReleased && !r.watched && !isReleasedRow(r, opts.today)) {
    return `<span class="not-aired-lbl">Not aired yet</span>`;
  }
  const stop = opts.stopPropagation ? 'event.stopPropagation(); ' : '';
  const show = opts.shortcutOf;
  if (show && !r.watched) {
    return `<button class="watch-btn show-shortcut" data-shortcut-show="${esc(show.id)}" aria-label="${esc(`Mark ${r.season} of ${show.title} watched`)}" onclick="${stop}toggleWatch('${r.id}')">Mark ${esc(r.season)} watched</button>`;
  }
  const label = r.watched ? (compact ? '✓' : '✓ Watched') : 'Mark watched';
  return `<button class="watch-btn${r.watched?' watched':''}" onclick="${stop}toggleWatch('${r.id}')">${label}</button>`;
}

// The per-row control in a season list: Skip / Keep for a TV season (its status
// is the show's), the row-level status for a film. A season of a Skipped show
// follows its show and has none.
function seasonRowControlHtml(r, opts = {}) {
  if (!isTvSeason(r)) return filmStatusSelectHtml(r);
  if (displayStatus(r) === 'skipped') return `<span class="confirmed-lbl">Show skipped</span>`;
  return seasonSkipButtonHtml(r, opts);
}

// One season of a grouped show: a desktop sub-row and a mobile card row.
// opts: { isNew, showMatch, showDelete, deleteTitle, requireReleased, today, showOf, cwOrder }
// Focus hooks (B6): data-season-row names the season and data-action each of its controls,
// so focus can return to the same control after a redraw (an identity, never a position);
// showOf names the show the row belongs to.
// cwOrder (Currently Watching, B6, which has no Status column): Watched under Watched, then
// Skip / Keep, in five cells.
function seasonActionHtml(action, html) {
  return html ? `<span class="season-action" data-action="${action}">${html}</span>` : '';
}
function seasonSubRowHtml(r, opts) {
  const isSkipped = isOffList(r);
  const rowClass = isSkipped ? 'row-skipped' : '';
  const hooks = ` data-season-row="${esc(r.id)}"${opts.showOf ? ` data-show-of="${esc(opts.showOf)}"` : ''}`;
  const label = `<td style="padding-left:28px">
          <span class="season-lbl">${esc(r.season)}</span>
          ${opts.isNew?'<span class="new-tag">New</span>':''}
        </td>`;
  const watch = seasonActionHtml('season-watch', seasonWatchControlHtml(r, opts, false));
  const control = seasonActionHtml('season-control', seasonRowControlHtml(r));
  if (opts.cwOrder) {
    return `<tr class="${rowClass} sub-row"${hooks}>
        ${label}
        <td></td>
        <td class="date-cell">${esc(r.display_date)}</td>
        <td>${watch}</td>
        <td>${control}</td>
      </tr>`;
  }
  return `<tr class="${rowClass} sub-row"${hooks}>
        ${label}
        <td>${opts.showMatch ? seasonActionHtml('season-match', `<button class="universe-link" onclick="openTmdbMatch('${r.id}')">🎯 Match to TMDB</button>`) : ''}</td>
        <td class="date-cell">${esc(r.display_date)}</td>
        <td>${control}</td>
        <td>${watch}</td>
        <td>${opts.showDelete ? seasonActionHtml('season-delete', `<button class="del-btn" onclick="delRow('${r.id}')" title="${esc(opts.deleteTitle || 'Remove')}">×</button>`) : ''}</td>
      </tr>`;
}

function seasonSubCardHtml(r, opts) {
  return `<div class="card-subseason-row" data-season-row="${esc(r.id)}"${opts.showOf ? ` data-show-of="${esc(opts.showOf)}"` : ''}>
          <span class="card-season">${esc(r.season)} · ${esc(r.display_date)}${opts.showMatch ? ` ${seasonActionHtml('season-match', `<button class="universe-link" onclick="openTmdbMatch('${r.id}')">🎯 Match to TMDB</button>`)}` : ''}</span>
          <div class="card-actions">
            ${seasonActionHtml('season-control', seasonRowControlHtml(r))}
            ${seasonActionHtml('season-watch', seasonWatchControlHtml(r, opts, true))}
            ${opts.showDelete ? seasonActionHtml('season-delete', `<button class="card-del-btn" onclick="delRow('${r.id}')" title="${esc(opts.deleteTitle || 'Remove')}">×</button>`) : ''}
          </div>
        </div>`;
}
