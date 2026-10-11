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
  watchwith: { select: 'fWatchWith', clickable: 'ww-tag-clickable' }
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

// Sets the filter control to the value (or clears it when it is already set),
// opens the collapsed filter panel so the choice is visible, and redraws. A value
// the control doesn't offer changes nothing.
function toggleFilterSelect(selectId, value) {
  const select = document.getElementById(selectId);
  if (!select) return false;
  if (select.tagName === 'SELECT' && select.value !== value && ![...select.options].some(o => o.value === value)) return false;
  select.value = select.value === value ? '' : value;
  const filtersEl = document.getElementById('filtersRow');
  if (filtersEl && filtersEl.classList.contains('collapsed')) {
    filtersEl.classList.remove('collapsed');
    const chevron = document.getElementById('filterToggleChevron');
    if (chevron) chevron.textContent = '▴';
  }
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

// A theme / genre / network filter control: every value in the view's loaded rows
// (never only the shown ones), so a choice can always be changed or cleared.
function themeFilterSelectHtml(themes, allLabel, ariaLabel) {
  const list = [...new Set(themes.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return `<select id="fTheme" onchange="renderTable()" aria-label="${esc(ariaLabel)}">
        <option value="">${esc(allLabel)}</option>${list.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
      </select>`;
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
// Row-level status options: films (TV shows use showStatusSelectHtml).
function statusOptionsHtml(status) {
  return TV_STATUS_ORDER.map(s => `<option value="${s}"${status === s ? ' selected' : ''}>${statusOptionLabel(s)}</option>`).join('');
}

// The watch control for one season row. Derived views pass requireReleased, which
// replaces "Mark watched" with a note until the season has aired (a row already
// marked watched keeps its toggle so it can be undone). compact is the mobile label.
function seasonWatchControlHtml(r, opts, compact) {
  if (isOffList(r)) return compact ? '' : `<span class="confirmed-lbl">—</span>`;
  if (opts.requireReleased && !r.watched && !isReleasedRow(r, opts.today)) {
    return `<span class="not-aired-lbl">Not aired yet</span>`;
  }
  const label = r.watched ? (compact ? '✓' : '✓ Watched') : 'Mark watched';
  return `<button class="watch-btn${r.watched?' watched':''}" onclick="${opts.stopPropagation ? 'event.stopPropagation(); ' : ''}toggleWatch('${r.id}')">${label}</button>`;
}

// The per-row control in a season list: Skip / Keep for a TV season (its status
// is the show's), the row-level status for a film. A season of a Skipped show
// follows its show and has none.
function seasonRowControlHtml(r, opts = {}) {
  if (!isTvSeason(r)) return `<select class="status-select s-${r.status}" onchange="setStatus('${r.id}', this.value, this)">${statusOptionsHtml(r.status)}</select>`;
  if (displayStatus(r) === 'skipped') return `<span class="confirmed-lbl">Show skipped</span>`;
  return seasonSkipButtonHtml(r, opts);
}

// One season of a grouped show: a desktop sub-row and a mobile card row.
// opts: { isNew, showMatch, showDelete, deleteTitle, requireReleased, today }
function seasonSubRowHtml(r, opts) {
  const isSkipped = isOffList(r);
  const isMaybe   = displayStatus(r) === 'maybe';
  const rowClass = isSkipped?'row-skipped':isMaybe?'row-maybe':'';
  return `<tr class="${rowClass} sub-row">
        <td style="padding-left:28px">
          <span class="season-lbl">${esc(r.season)}</span>
          ${opts.isNew?'<span class="new-tag">New</span>':''}
        </td>
        <td>${opts.showMatch ? `<button class="universe-link" onclick="openTmdbMatch('${r.id}')">🎯 Match to TMDB</button>` : ''}</td>
        <td class="date-cell">${esc(r.display_date)}</td>
        <td>${seasonRowControlHtml(r)}</td>
        <td>${seasonWatchControlHtml(r, opts, false)}</td>
        <td>${opts.showDelete ? `<button class="del-btn" onclick="delRow('${r.id}')" title="${esc(opts.deleteTitle || 'Remove')}">×</button>` : ''}</td>
      </tr>`;
}

function seasonSubCardHtml(r, opts) {
  return `<div class="card-subseason-row">
          <span class="card-season">${esc(r.season)} · ${esc(r.display_date)}${opts.showMatch ? ` <button class="universe-link" onclick="openTmdbMatch('${r.id}')">🎯 Match to TMDB</button>` : ''}</span>
          <div class="card-actions">
            ${seasonRowControlHtml(r)}
            ${seasonWatchControlHtml(r, opts, true)}
            ${opts.showDelete ? `<button class="card-del-btn" onclick="delRow('${r.id}')" title="${esc(opts.deleteTitle || 'Remove')}">×</button>` : ''}
          </div>
        </div>`;
}
