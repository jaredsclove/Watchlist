// ─── Filters ──────────────────────────────────────────────────────────────────
function renderFilters() {
  if (isBrowseView(activeViewId)) { renderBrowseFilters(); return; }
  if (activeViewId) { renderDerivedFilters(); return; }
  const col = COLLECTIONS.find(c => c.id === activeTabId);
  const td = tabData[activeTabId];

  // Re-rendering the same tab (e.g. after an add or a tag backfill) keeps the
  // user's filter/search selections; a different tab starts from the defaults.
  const filtersRowEl = document.getElementById('filtersRow');
  const keepState = filtersRowEl.dataset.tab === activeTabId;
  const savedValues = {};
  if (keepState) {
    ['fSearch', 'fTheme', 'fYear', 'fCollection', 'fWatchWith', 'fWatch', 'fStatus', 'tmdbQuery'].forEach(id => {
      const el = document.getElementById(id);
      if (el) savedValues[id] = el.value;
    });
  }
  const wasCollapsed = filtersRowEl.classList.contains('collapsed');

  let themeList = col.themes;
  let yearList  = col.years;
  if (col.dynamic && td) {
    themeList = [...new Set(td.rows.map(r => r.theme).filter(Boolean))].sort();
    yearList  = [...new Set(td.rows.map(r => r.date_sort.substring(0,4)))].sort();
  }

  const themeOpts = themeList.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  const yearOpts  = yearList.map(y => `<option value="${y}">${y}</option>`).join('');

  let collectionsFilterHtml = '';
  let watchWithFilterHtml = '';
  if (col.isMovieTab && td) {
    const collectionSet = new Set();
    td.rows.forEach(r => (r.collections || []).forEach(c => collectionSet.add(cleanCollectionName(c))));
    const collectionList = [...collectionSet].sort();
    if (collectionList.length > 0) {
      const collectionOpts = collectionList.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
      collectionsFilterHtml = `
      <select id="fCollection" onchange="renderTable(); updateCollectionRefreshLink();">
        <option value="">All collections</option>${collectionOpts}
      </select>
      <span id="collectionRefreshLink"></span>`;
    }
    // In its own wrapper so a watch-with refresh can replace just this control.
    watchWithFilterHtml = `<span id="fWatchWithWrap" class="ww-filter">${watchWithFilterControlHtml('')}</span>`;
  }

  document.getElementById('filtersRow').innerHTML = `
    <button class="filter-toggle-btn" onclick="toggleFilters()" id="filterToggleBtn">
      <span>🔍 Search &amp; Filter</span><span id="filterToggleChevron">▾</span>
    </button>
    <div class="filters-inner">
      <span class="filter-label">Filter:</span>
      <input class="search-input" id="fSearch" type="text" placeholder="Search titles…" oninput="renderTable()">
      <select id="fTheme" onchange="renderTable()">
        <option value="">All themes</option>${themeOpts}
      </select>
      <select id="fYear" onchange="renderTable()">
        <option value="">All years</option>${yearOpts}
      </select>
      ${collectionsFilterHtml}
      ${watchWithFilterHtml}
      <select id="fWatch" onchange="renderTable()">
        <option value="">All statuses</option>
        <option value="unwatched" selected>Not watched</option>
        <option value="watched">Watched</option>
      </select>
      <select id="fStatus" onchange="renderTable()">
        <option value="">All (except Skipped)</option>
        <option value="confirmed">On list only</option>
        <option value="highpriority">High Priority only</option>
        <option value="watching">Watching only</option>
        <option value="uptodate">Up to date only</option>
        <option value="complete">Complete only</option>
        <option value="pending">Pending only</option>
        <option value="maybe">Maybe Later only</option>
        <option value="skipped">Skipped</option>
      </select>
      <button class="btn" onclick="toggleAdd()" id="addToggleBtn">+ Add entry</button>
    </div>
  `;
  filtersRowEl.dataset.tab = activeTabId;
  // start collapsed on mobile widths
  if (window.innerWidth <= 700) {
    document.getElementById('filtersRow').classList.add('collapsed');
  }

  // build add form (dynamic tabs use free-text network field instead of fixed theme list)
  const themeFieldHtml = col.dynamic
    ? `<input id="nTheme" type="text" placeholder="e.g. HBO, Netflix">`
    : `<select id="nTheme">${col.themes.map(t => `<option>${esc(t)}</option>`).join('')}</select>`;
  document.getElementById('addFormGrid').innerHTML = `
    <div><label>Title</label><input id="nTitle" type="text" placeholder="Show title"></div>
    <div><label>Season</label><input id="nSeason" type="text" value="Season 1"></div>
    <div><label>${col.dynamic?'Network':'Theme'}</label>${themeFieldHtml}</div>
    <div><label>Premiere date</label><input id="nDate" type="text" placeholder="e.g. Jan 12, 2014"></div>
    <button class="btn btn-accent" onclick="addEntry()" style="margin-bottom:0">Add</button>
  `;

  // TMDB search panel (dynamic tabs only)
  const tmdbPanel = document.getElementById('tmdbPanel');
  if (col.dynamic) {
    tmdbPanel.style.display = 'block';
    if (col.isMovieTab) {
      tmdbPanel.innerHTML = `
        <div class="tmdb-search-row">
          <input id="tmdbQuery" type="text" placeholder="Search for a movie…" onkeydown="if(event.key==='Enter'){searchTMDB();}">
          <button class="btn btn-accent" onclick="searchTMDB()">Search</button>
          <button class="btn" onclick="refreshCollections()" title="Check your tracked collections/franchises for movies you haven't added yet">↻ Refresh collections</button>
        </div>
        <div class="tmdb-universe-row">
          <button class="universe-link" onclick="pullUniverse('mcu')">+ pull entire MCU</button>
          <span class="universe-sep">·</span>
          <button class="universe-link" onclick="togglePersonCollectionPrompt()">+ start a person collection</button>
        </div>
        <div id="personCollectionPrompt" style="display:none"></div>
        <div id="tmdbResults"></div>
        <div id="tmdbPreview"></div>
      `;
    } else {
      tmdbPanel.innerHTML = `
        <div class="tmdb-search-row">
          <input id="tmdbQuery" type="text" placeholder="Search for a show…" onkeydown="if(event.key==='Enter'){searchTMDB();}">
          <button class="btn btn-accent" onclick="searchTMDB()">Search</button>
          <button class="btn" onclick="refreshShows()" title="Check for new seasons of shows already on this list">↻ Refresh shows</button>
        </div>
        <div id="tmdbResults"></div>
        <div id="tmdbPreview"></div>
      `;
    }
  } else {
    tmdbPanel.style.display = 'none';
    tmdbPanel.innerHTML = '';
  }

  if (keepState) {
    for (const [id, value] of Object.entries(savedValues)) {
      const el = document.getElementById(id);
      if (!el) continue;
      // A select whose saved option no longer exists keeps its rendered default.
      if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === value)) continue;
      el.value = value;
    }
    // keep the mobile expand/collapse state the user chose
    if (filtersRowEl.classList.contains('collapsed') !== wasCollapsed) toggleFilters();
    updateCollectionRefreshLink();
  }
}

// ─── Render table ─────────────────────────────────────────────────────────────
function renderTable() {
  if (isBrowseView(activeViewId)) { renderBrowseTable(); return; }
  if (activeViewId) { renderDerivedTable(); return; }
  const td = tabData[activeTabId];
  if (!td) return;
  const col = COLLECTIONS.find(c => c.id === activeTabId);

  const fSearch = document.getElementById('fSearch')?.value.trim().toLowerCase() || '';
  const fTheme  = document.getElementById('fTheme')?.value  || '';
  const fYear   = document.getElementById('fYear')?.value   || '';
  const fCollection = document.getElementById('fCollection')?.value || '';
  const fWatchWith = document.getElementById('fWatchWith')?.value || '';
  const fWatch  = document.getElementById('fWatch')?.value  || '';
  const fStatus = document.getElementById('fStatus')?.value || '';

  let list = [...td.rows].sort((a,b) => a.date_sort.localeCompare(b.date_sort));

  // A TV season's status is its show's (tv-shows.js); a film's is its own.
  // "Up to date" isn't a stored status: Watching shows none of whose remaining
  // seasons has aired.
  if (fStatus === 'uptodate') {
    const upToDate = upToDateShowIds(td.rows, localTodayStr());
    list = list.filter(r => isTvSeason(r) && upToDate.has(r.show_id) && !isOffList(r));
  } else if (fStatus === 'skipped') {
    list = list.filter(isOffList);
  } else if (fStatus) {
    list = list.filter(r => displayStatus(r) === fStatus && !isOffList(r));
  } else {
    list = list.filter(r => !isOffList(r));
  }

  if (fSearch) list = list.filter(r => r.title.toLowerCase().includes(fSearch));
  if (fTheme) list = list.filter(r => r.theme === fTheme);
  if (fYear)  list = list.filter(r => r.date_sort.startsWith(fYear));
  if (fCollection) list = list.filter(r => (r.collections || []).some(c => cleanCollectionName(c) === fCollection));
  if (fWatchWith) list = list.filter(r => (r.watch_with || []).includes(fWatchWith));

  // statsList mirrors list's theme/year/status/search scope, but ignores the
  // watched/unwatched filter — stats should reflect real progress, not be
  // zeroed out just because the table is currently showing only unwatched rows.
  const statsList = list;

  if (fWatch === 'watched')   list = list.filter(r => r.watched);
  if (fWatch === 'unwatched') list = list.filter(r => !r.watched);

  const trackable = statsList.filter(r => !isOffList(r));
  const watched   = trackable.filter(r => r.watched).length;
  const total     = trackable.length;
  const pct       = total > 0 ? Math.round(watched/total*100) : 0;
  // Status counts: one per show for TV seasons, one per film.
  const countStatus = status => {
    const shows = new Set();
    let films = 0;
    statsList.forEach(r => {
      if (displayStatus(r) !== status) return;
      if (isTvSeason(r)) shows.add(r.show_id); else films++;
    });
    return shows.size + films;
  };
  const pending   = countStatus('pending');
  const maybe     = countStatus('maybe');
  const watching     = countStatus('watching');
  const highPriority = countStatus('highpriority');

  document.getElementById('statsRow').innerHTML = `
    <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">On List</div></div>
    <div class="stat"><div class="stat-num">${watched}</div><div class="stat-label">Watched</div></div>
    <div class="stat"><div class="stat-num">${total-watched}</div><div class="stat-label">To Watch</div></div>
    <div class="stat">
      <div class="stat-num">${pct}%</div><div class="stat-label">Complete</div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
    ${watching>0?`<div class="stat"><div class="stat-num">${watching}</div><div class="stat-label">Watching</div></div>`:''}
    ${highPriority>0?`<div class="stat"><div class="stat-num">${highPriority}</div><div class="stat-label">High Priority</div></div>`:''}
    ${pending>0?`<div class="stat"><div class="stat-num">${pending}</div><div class="stat-label">Pending</div></div>`:''}
    ${maybe>0?`<div class="stat"><div class="stat-num">${maybe}</div><div class="stat-label">Maybe Later</div></div>`:''}
  `;

  updateTableHeader(col);

  if (list.length === 0) {
    const colCount = col.isMovieTab ? 9 : 6;
    document.getElementById('tbody').innerHTML = `<tr class="empty-row"><td colspan="${colCount}">No entries match your filters.</td></tr>`;
    document.getElementById('cardList').innerHTML = '<div class="empty-row" style="padding:2rem 0">No entries match your filters.</div>';
    return;
  }

  if (col.dynamic && !col.isMovieTab) {
    renderGroupedTable(list, td, fStatus);
  } else if (col.isMovieTab) {
    renderMoviesTable(list, td);
  } else {
    renderFlatTable(list, td);
  }
}

function updateTableHeader(col) {
  const thead = document.getElementById('tableHead');
  if (!thead) return;
  if (col.isMovieTab) {
    thead.innerHTML = `
      <tr>
        <th>Title</th>
        <th>Genre</th>
        <th>Collection</th>
        <th>Watch With</th>
        <th>Release Date</th>
        <th>Status</th>
        <th>Watched</th>
        <th></th>
        <th></th>
      </tr>`;
  } else {
    thead.innerHTML = `
      <tr>
        <th>Show &amp; Season</th>
        <th>Theme</th>
        <th>Premiere</th>
        <th>Status</th>
        <th>Watched</th>
        <th></th>
      </tr>`;
  }
}

// ─── Flat rendering (Disney+, 90 Day, Sheridan) ───────────────────────────────
// TV seasons show their show's status (a show-scoped control) and Skip / Keep;
// films keep their own row-level status.
function renderFlatTable(list, td) {
  let html = '', cardHtml = '', lastYear = '';
  list.forEach(r => {
    const yr = r.date_sort.substring(0,4);
    if (yr !== lastYear) {
      html += `<tr class="year-group"><td colspan="6">${yr}</td></tr>`;
      cardHtml += `<div class="card-year-group">${yr}</div>`;
      lastYear = yr;
    }
    const isNew = td.newKeys.includes(r.item_key);
    const bc = badgeClass(r.theme);
    const tv = isTvSeason(r);
    const isSkipped = isOffList(r);
    const isMaybe   = displayStatus(r) === 'maybe';
    const statusCell = tv
      ? showStatusSelectHtml(showOfRow(r))
      : `<select class="status-select s-${r.status}" onchange="setStatus('${r.id}', this.value, this)">${statusOptionsHtml(r.status)}</select>`;
    const rowClass = isSkipped?'row-skipped':isMaybe?'row-maybe':'';
    const watchBtn = `<button class="watch-btn${r.watched?' watched':''}" onclick="toggleWatch('${r.id}')">${r.watched?'✓ Watched':'Mark watched'}</button>`;
    // A skipped season can be kept again; a season of a Skipped show follows its show.
    const showSkipped = tv && displayStatus(r) === 'skipped';
    const seasonControls = !tv
      ? (!isSkipped ? watchBtn : '')
      : showSkipped ? '' : r.skipped ? seasonSkipButtonHtml(r) : `${watchBtn} ${seasonSkipButtonHtml(r)}`;
    // × on a built-in TV season means Skip (see delRow), so a skipped one has none.
    const builtInTv = tv && isDefaultRow(r);
    const delBtn = cls => (builtInTv && isSkipped) ? ''
      : `<button class="${cls}" onclick="delRow('${r.id}')" title="${builtInTv ? 'Skip this season' : 'Remove'}">×</button>`;

    html += `<tr class="${rowClass}">
      <td>
        <span class="show-title">${esc(r.title)}</span>
        <span class="season-lbl"> · ${esc(r.season)}</span>
        ${isNew?'<span class="new-tag">New</span>':''}
      </td>
      <td><button class="badge ${bc} badge-clickable" onclick="event.stopPropagation(); toggleThemeFilterFromTag('${esc(r.theme).replace(/'/g,"\\'")}')" title="Filter by this theme">${esc(r.theme)}</button></td>
      <td class="date-cell">${esc(r.display_date)}</td>
      <td>${statusCell}</td>
      <td>${seasonControls || `<span class="confirmed-lbl">—</span>`}</td>
      <td>${delBtn('del-btn')}</td>
    </tr>`;

    cardHtml += `<div class="item-card ${rowClass}">
      <div class="card-top">
        <div class="card-title-block">
          <span class="card-title">${esc(r.title)}</span>
          <span class="card-season">${esc(r.season)}</span>
          ${isNew?'<span class="new-tag">New</span>':''}
        </div>
        ${delBtn('card-del-btn')}
      </div>
      <div class="card-meta">
        <button class="badge ${bc} badge-clickable" onclick="event.stopPropagation(); toggleThemeFilterFromTag('${esc(r.theme).replace(/'/g,"\\'")}')" title="Filter by this theme">${esc(r.theme)}</button>
        <span class="card-date">${esc(r.display_date)}</span>
      </div>
      <div class="card-actions">
        ${statusCell}
        ${seasonControls}
      </div>
    </div>`;
  });
  document.getElementById('tbody').innerHTML = html;
  document.getElementById('cardList').innerHTML = cardHtml;
}

// From the tab's built-in default list (× then means Skip, never delete).
function isDefaultRow(r) {
  const col = COLLECTIONS.find(c => c.id === r.collection);
  return !!(col && Array.isArray(col.defaults) && col.defaults.some(d => d.k === r.item_key));
}

// Watching shows among these rows that are Up to date (none of their remaining seasons has aired).
function upToDateShowIds(rows, today) {
  const byShow = new Map();
  rows.forEach(r => {
    if (!isTvSeason(r) || !r.show_id) return;
    if (!byShow.has(r.show_id)) byShow.set(r.show_id, []);
    byShow.get(r.show_id).push(r);
  });
  const out = new Set();
  for (const [id, seasons] of byShow) {
    if (tvShowsById.get(id)?.status === 'watching' && isShowUpToDate(seasons, today)) out.add(id);
  }
  return out;
}

// The Movies watch-with filter: the loaded choices; while loading or after a
// failed read it says so, and a failed read offers Retry right beside it, so
// recovery doesn't depend on any row being visible. `selected` is kept when
// still offered.
function watchWithFilterControlHtml(selected) {
  const usable = watchWithUsable();
  const opts = usable
    ? watchWithChoiceList().map(w => `<option value="${esc(w.token)}"${w.token === selected ? ' selected' : ''}>${esc(w.label)}</option>`).join('')
    : `<option value="" disabled>${watchWithState === 'loading' ? 'Watch-with choices are loading…' : 'Watch-with choices couldn’t be loaded'}</option>`;
  // Archived choices still used in this list: for filtering only, never offered for assignment.
  const archived = usable ? archivedWatchWithInUse((tabData[activeTabId] || {}).rows) : [];
  const archivedOpts = archived.length
    ? `<optgroup label="Archived">${archived.map(w => `<option value="${esc(w.token)}"${w.token === selected ? ' selected' : ''}>${esc(w.label)}</option>`).join('')}</optgroup>`
    : '';
  const retry = watchWithState === 'unavailable'
    ? ` <button class="btn" onclick="loadOrganization()" aria-label="Retry loading watch-with choices">Retry</button>`
    : '';
  const stale = watchWithState === 'ready' && orgChoicesStale
    ? ` <span class="ww-stale">Choices may be out of date · <button class="btn" onclick="retryOrgRefresh()">Retry</button></span>` : '';
  const manageLink = watchWithState === 'ready' ? ` <button class="btn btn-link" onclick="openManage('choices')">Manage choices…</button>` : '';
  return `<select id="fWatchWith" onchange="renderTable()" aria-label="Watch with">
        <option value="">Watch with: anyone</option>${opts}${archivedOpts}
      </select>${retry}${stale}${manageLink}`;
}

// ─── Movies rendering (standalone films, with Watch With + Collections tags) ──
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

function renderMoviesTable(list, td) {
  let html = '', cardHtml = '';
  list.forEach(r => {
    const isNew = td.newKeys.includes(r.item_key);
    const genreBadgeStyle = networkBadgeStyle(r.theme);
    const isSkipped = r.status === 'skipped';
    const isMaybe   = r.status === 'maybe';
    const statusClass = `s-${r.status}`;
    const statusOptions = statusOptionsHtml(r.status);
    const statusCell = `<select class="status-select ${statusClass}" onchange="setStatus('${r.id}', this.value, this)">${statusOptions}</select>`;
    const rowClass = isSkipped?'row-skipped':isMaybe?'row-maybe':'';

    const watchWith = r.watch_with || [];
    const collections = (r.collections || []).map(cleanCollectionName);
    const collectionTagsHtml = collections.map(c => `<button class="collection-tag collection-tag-clickable" onclick="event.stopPropagation(); toggleCollectionFilterFromTag('${esc(c).replace(/'/g,"\\'")}')" title="Filter by this collection">${esc(c)}</button>`).join('');
    const watchWithTagsHtml = watchWith.map(w => `<button class="ww-tag ww-tag-clickable" onclick="event.stopPropagation(); toggleWatchWithFilterFromTag('${esc(w).replace(/'/g,"\\'")}')" title="Filter by this person">${esc(watchWithLabel(w))}</button>`).join('');
    // mobile card view keeps tags combined near the title — no column grid to align there anyway
    const inlineTagsHtml = collectionTagsHtml + watchWithTagsHtml;
    const cleanCollectionDisplayName = cleanCollectionName(r.tmdb_collection_name || '');
    const pullBtnHtml = r.tmdb_collection_id
      ? `<button class="popover-action" onclick="openPullCollection('${r.id}', ${r.tmdb_collection_id}, '${esc(cleanCollectionDisplayName).replace(/'/g,"\\'")}')">🔗 Pull rest of ${esc(cleanCollectionDisplayName||'collection')}</button>`
      : '';

    const morePopover = `
      <div class="more-popover" id="more-popover-${r.id}" style="display:none">
        <div class="popover-section-label">Watch with</div>
        <div class="ww-options-grid">${watchWithPickerHtml(r.id, watchWith)}</div>
        ${pullBtnHtml ? `<div class="popover-section-label" style="margin-top:8px">Collection</div>${pullBtnHtml}` : ''}
        ${isTmdbMatchEligible(r) ? `<div class="popover-section-label" style="margin-top:8px">TMDB</div><button class="popover-action" onclick="openTmdbMatch('${r.id}')">🎯 Match to TMDB</button>` : ''}
      </div>`;

    html += `<tr class="${rowClass} movie-row-condensed">
      <td>
        <span class="show-title">${esc(r.title)}</span>
        ${isNew?'<span class="new-tag">New</span>':''}
      </td>
      <td><button class="badge badge-clickable" ${genreBadgeStyle} onclick="event.stopPropagation(); toggleThemeFilterFromTag('${esc(r.theme).replace(/'/g,"\\'")}')" title="Filter by this genre">${esc(r.theme)}</button></td>
      <td class="tags-cell">${collectionTagsHtml || '<span class="tags-empty">—</span>'}</td>
      <td class="tags-cell">${watchWithTagsHtml || '<span class="tags-empty">—</span>'}</td>
      <td class="date-cell">${esc(r.display_date)}</td>
      <td>${statusCell}</td>
      <td>${!isSkipped
        ? `<button class="watch-btn${r.watched?' watched':''}" onclick="toggleWatch('${r.id}')">${r.watched?'✓ Watched':'Mark watched'}</button>`
        : `<span class="confirmed-lbl">—</span>`
      }</td>
      <td class="more-cell">
        <button class="more-btn" onclick="toggleMorePopover('${r.id}', this)" title="Watch with / collection">⋯</button>
        ${morePopover}
      </td>
      <td><button class="del-btn" onclick="delRow('${r.id}')" title="Remove">×</button></td>
    </tr>`;

    cardHtml += `<div class="item-card ${rowClass} movie-card-condensed">
      <div class="card-top">
        <div class="card-title-block">
          <span class="card-title">${esc(r.title)}</span>
          ${isNew?'<span class="new-tag">New</span>':''}
          ${inlineTagsHtml ? `<div class="inline-tags">${inlineTagsHtml}</div>` : ''}
        </div>
        <div class="card-row-actions">
          <button class="more-btn" onclick="toggleMorePopover('${r.id}', this)" title="Watch with / collection">⋯</button>
          <button class="card-del-btn" onclick="delRow('${r.id}')" title="Remove">×</button>
        </div>
        ${morePopover}
      </div>
      <div class="card-meta">
        <button class="badge badge-clickable" ${genreBadgeStyle} onclick="event.stopPropagation(); toggleThemeFilterFromTag('${esc(r.theme).replace(/'/g,"\\'")}')" title="Filter by this genre">${esc(r.theme)}</button>
        <span class="card-date">${esc(r.display_date)}</span>
      </div>
      <div class="card-actions">
        <select class="status-select ${statusClass}" onchange="setStatus('${r.id}', this.value, this)">${statusOptions}</select>
        ${!isSkipped
          ? `<button class="watch-btn${r.watched?' watched':''}" onclick="toggleWatch('${r.id}')">${r.watched?'✓ Watched':'Mark watched'}</button>`
          : ''
        }
      </div>
    </div>`;
  });
  document.getElementById('tbody').innerHTML = html;
  document.getElementById('cardList').innerHTML = cardHtml;
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


// ─── Grouped rendering (Other TV, True Crime/Docs) ────────────────────────────
// Row-level status options: films (TV shows use showStatusSelectHtml).
function statusOptionsHtml(status) {
  return TV_STATUS_ORDER.map(s => `<option value="${s}"${status === s ? ' selected' : ''}>${statusOptionLabel(s)}</option>`).join('');
}

// The watch control for one season row. Derived views pass requireReleased, which
// replaces "Mark watched" with a note until the season has aired (a row already
// marked watched keeps its toggle so it can be undone). Collection tabs keep a
// watch button on every row that's on the list. compact is the mobile label.
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
// opts: { isNew, showMatch, showDelete, requireReleased, today }
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
        <td>${opts.showDelete ? `<button class="del-btn" onclick="delRow('${r.id}')" title="Remove">×</button>` : ''}</td>
      </tr>`;
}

function seasonSubCardHtml(r, opts) {
  return `<div class="card-subseason-row">
          <span class="card-season">${esc(r.season)} · ${esc(r.display_date)}${opts.showMatch ? ` <button class="universe-link" onclick="openTmdbMatch('${r.id}')">🎯 Match to TMDB</button>` : ''}</span>
          <div class="card-actions">
            ${seasonRowControlHtml(r)}
            ${seasonWatchControlHtml(r, opts, true)}
            ${opts.showDelete ? `<button class="card-del-btn" onclick="delRow('${r.id}')" title="Remove">×</button>` : ''}
          </div>
        </div>`;
}

// The group a row belongs to: its show (by show_id) for a TV season, the row
// itself for a film.
function groupKeyOf(r) {
  return isTvSeason(r) && r.show_id ? `show:${r.show_id}` : `row:${r.id}`;
}

function renderGroupedTable(list, td, fStatus) {
  // Which groups are visible is determined by the filtered `list`. Once a group is
  // visible, its season breakdown/progress reflects ALL of its seasons, not just
  // the ones surviving the current filter (e.g. "Not watched").
  const visibleKeys = new Set(list.map(groupKeyOf));
  const today = localTodayStr();

  const groups = new Map();
  td.rows.forEach(r => {
    const key = groupKeyOf(r);
    if (!visibleKeys.has(key)) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });

  // Order: Watching (in progress, then Up to date) > High Priority > On List > Complete > Pending > Maybe Later > Skipped
  const rankOf = g => g.status === 'watching' ? (g.upToDate ? 1 : 0) : TV_STATUS_ORDER.indexOf(g.status) + 1;

  const groupList = [...groups.entries()].map(([key, seasons]) => {
    seasons.sort(isTvSeason(seasons[0]) ? compareSeasons : (a, b) => a.date_sort.localeCompare(b.date_sort));
    const show = isTvSeason(seasons[0]) ? showOfRow(seasons[0]) : null;
    const status = show ? show.status : seasons[0].status;
    const upToDate = !!show && status === 'watching' && isShowUpToDate(seasons, today);
    const earliestDate = seasons.reduce((m, r) => (r.date_sort < m ? r.date_sort : m), seasons[0].date_sort);
    return { key, show, seasons, status, upToDate, earliestDate, title: show ? show.title : seasons[0].title };
  });
  groupList.sort((a, b) => (rankOf(a) - rankOf(b)) || a.earliestDate.localeCompare(b.earliestDate));

  let html = '', cardHtml = '';
  groupList.forEach(group => {
    const { key, show, seasons, status, upToDate, title } = group;
    const isExpanded = expandedShows.has(key);
    const first = seasons[0];
    const network = first.theme || 'Unknown';
    const badgeStyle = networkBadgeStyle(network);
    const trackableSeasons = seasons.filter(s => !isOffList(s));
    const watchedCount = trackableSeasons.filter(s => s.watched).length;
    const totalCount = trackableSeasons.length;
    const anyNew = seasons.some(s => td.newKeys.includes(s.item_key));

    const progressPct = totalCount > 0 ? Math.round(watchedCount/totalCount*100) : 0;
    const progressLabel = totalCount > 0 ? `${watchedCount}/${totalCount} watched` : `${seasons.length} season${seasons.length===1?'':'s'}`;
    const progressBarHtml = totalCount > 0
      ? `<div class="mini-progress-track"><div class="mini-progress-fill" style="width:${progressPct}%"></div></div>`
      : '';
    const keyArg = esc(key).replace(/'/g,"\\'");
    const masterStatusCell = show
      ? showStatusSelectHtml(show, { stopPropagation: true })
      : `<select class="status-select s-${status}" onclick="event.stopPropagation()" onchange="event.stopPropagation(); setStatus('${first.id}', this.value, this)">${statusOptionsHtml(status)}</select>`;
    const upToDateTag = upToDate ? '<span class="status-pill s-caughtup">Up to date</span>' : '';

    const seasonOpts = r => ({ isNew: td.newKeys.includes(r.item_key), showMatch: isTmdbMatchEligible(r), showDelete: true });
    const seasonRowsHtml = seasons.map(r => seasonSubRowHtml(r, seasonOpts(r))).join('');

    html += `<tr class="show-group-row" onclick="toggleShowExpand('${keyArg}')">
      <td>
        <div class="show-title-row">
          <div class="show-title-left">
            <span class="show-title">${esc(title)}</span>
            ${anyNew?'<span class="new-tag">New</span>':''}
          </div>
          <span class="expand-chevron">${isExpanded?'▾':'▸'}</span>
        </div>
      </td>
      <td><button class="badge badge-clickable" ${badgeStyle} onclick="event.stopPropagation(); toggleThemeFilterFromTag('${esc(network).replace(/'/g,"\\'")}')" title="Filter by this network">${esc(network)}</button></td>
      <td class="date-cell">${esc(first.display_date)}</td>
      <td>${masterStatusCell} ${upToDateTag}</td>
      <td class="card-date">${progressLabel}${progressBarHtml}</td>
      <td><span class="confirmed-lbl">—</span></td>
    </tr>`;
    if (isExpanded) html += seasonRowsHtml;

    cardHtml += `<div class="item-card show-group-card">
      <div class="card-top" onclick="toggleShowExpand('${keyArg}')" style="cursor:pointer">
        <div class="card-title-block">
          <span class="card-title">${esc(title)}</span>
          ${anyNew?'<span class="new-tag">New</span>':''}
        </div>
        <span class="expand-chevron">${isExpanded?'▾':'▸'}</span>
      </div>
      <div class="card-meta">
        <button class="badge badge-clickable" ${badgeStyle} onclick="event.stopPropagation(); toggleThemeFilterFromTag('${esc(network).replace(/'/g,"\\'")}')" title="Filter by this network">${esc(network)}</button>
        <span class="card-date">${esc(first.display_date)} · ${progressLabel}</span>
        ${progressBarHtml}
      </div>
      <div class="card-actions" onclick="event.stopPropagation()">
        ${masterStatusCell} ${upToDateTag}
      </div>
      ${isExpanded ? `<div class="card-subseasons">${seasons.map(r => seasonSubCardHtml(r, seasonOpts(r))).join('')}</div>` : ''}
    </div>`;
  });

  const emptyMsg = fStatus === 'uptodate'
    ? `Nothing is up to date right now — Watching shows land here once none of their remaining seasons has aired.`
    : `No entries match your filters.`;
  document.getElementById('tbody').innerHTML = html || `<tr class="empty-row"><td colspan="6">${emptyMsg}</td></tr>`;
  document.getElementById('cardList').innerHTML = cardHtml || `<div class="empty-row" style="padding:2rem 0">${emptyMsg}</div>`;
}

function toggleShowExpand(key) {
  if (expandedShows.has(key)) expandedShows.delete(key);
  else expandedShows.add(key);
  renderTable();
}
