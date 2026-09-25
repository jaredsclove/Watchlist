// ─── Filters ──────────────────────────────────────────────────────────────────
function renderFilters() {
  const col = COLLECTIONS.find(c => c.id === activeTabId);
  const td = tabData[activeTabId];

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
    const watchWithOpts = WATCH_WITH_OPTIONS.map(w => `<option value="${esc(w)}">${esc(w)}</option>`).join('');
    watchWithFilterHtml = `
      <select id="fWatchWith" onchange="renderTable()">
        <option value="">Watch with: anyone</option>${watchWithOpts}
      </select>`;
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
        <option value="caughtup">Caught Up only</option>
        <option value="complete">Complete only</option>
        <option value="pending">Pending only</option>
        <option value="maybe">Maybe Later only</option>
        <option value="skipped">Skipped</option>
      </select>
      <button class="btn" onclick="toggleAdd()" id="addToggleBtn">+ Add entry</button>
    </div>
  `;
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
}

// ─── Render table ─────────────────────────────────────────────────────────────
function renderTable() {
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

  if (fStatus === 'caughtup') {
    // "Caught Up" is a derived, show-level status — never stored on an individual
    // row. At the row level we pass through the same rows as "Watching" and let
    // the grouped renderer split Watching vs. Caught Up by derived aggStatus.
    list = list.filter(r => r.status === 'watching');
  } else if (fStatus) {
    list = list.filter(r => r.status === fStatus);
  } else {
    list = list.filter(r => r.status !== 'skipped');
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

  const trackable = statsList.filter(r => r.status !== 'skipped');
  const watched   = trackable.filter(r => r.watched).length;
  const total     = trackable.length;
  const pct       = total > 0 ? Math.round(watched/total*100) : 0;
  const pending   = statsList.filter(r => r.status === 'pending').length;
  const maybe     = statsList.filter(r => r.status === 'maybe').length;
  const watching     = statsList.filter(r => r.status === 'watching').length;
  const highPriority = statsList.filter(r => r.status === 'highpriority').length;

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

  if (list.length === 0) {
    const colCount = col.isMovieTab ? 9 : 6;
    document.getElementById('tbody').innerHTML = `<tr class="empty-row"><td colspan="${colCount}">No entries match your filters.</td></tr>`;
    document.getElementById('cardList').innerHTML = '<div class="empty-row" style="padding:2rem 0">No entries match your filters.</div>';
    return;
  }

  updateTableHeader(col);

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
    const isSkipped = r.status === 'skipped';
    const isMaybe   = r.status === 'maybe';
    const statusClass = `s-${r.status}`;
    const statusOptions = statusOptionsHtml(r.status);
    const statusCell = `<select class="status-select ${statusClass}" onchange="setStatus('${r.id}', this.value, this)">${statusOptions}</select>`;
    const rowClass = isSkipped?'row-skipped':isMaybe?'row-maybe':'';

    html += `<tr class="${rowClass}">
      <td>
        <span class="show-title">${esc(r.title)}</span>
        <span class="season-lbl"> · ${esc(r.season)}</span>
        ${isNew?'<span class="new-tag">New</span>':''}
      </td>
      <td><button class="badge ${bc} badge-clickable" onclick="event.stopPropagation(); toggleThemeFilterFromTag('${esc(r.theme).replace(/'/g,"\\'")}')" title="Filter by this theme">${esc(r.theme)}</button></td>
      <td class="date-cell">${esc(r.display_date)}</td>
      <td>${statusCell}</td>
      <td>${!isSkipped
        ? `<button class="watch-btn${r.watched?' watched':''}" onclick="toggleWatch('${r.id}')">${r.watched?'✓ Watched':'Mark watched'}</button>`
        : `<span class="confirmed-lbl">—</span>`
      }</td>
      <td><button class="del-btn" onclick="delRow('${r.id}')" title="Remove">×</button></td>
    </tr>`;

    cardHtml += `<div class="item-card ${rowClass}">
      <div class="card-top">
        <div class="card-title-block">
          <span class="card-title">${esc(r.title)}</span>
          <span class="card-season">${esc(r.season)}</span>
          ${isNew?'<span class="new-tag">New</span>':''}
        </div>
        <button class="card-del-btn" onclick="delRow('${r.id}')" title="Remove">×</button>
      </div>
      <div class="card-meta">
        <button class="badge ${bc} badge-clickable" onclick="event.stopPropagation(); toggleThemeFilterFromTag('${esc(r.theme).replace(/'/g,"\\'")}')" title="Filter by this theme">${esc(r.theme)}</button>
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

// ─── Movies rendering (standalone films, with Watch With + Collections tags) ──
function watchWithPickerHtml(rowId, current) {
  current = current || [];
  return WATCH_WITH_OPTIONS.map(opt => {
    const checked = current.includes(opt) ? 'checked' : '';
    return `<label class="ww-option"><input type="checkbox" value="${esc(opt)}" ${checked} onchange="toggleWatchWith('${rowId}', '${esc(opt).replace(/'/g,"\\'")}', this.checked)"> ${esc(opt)}</label>`;
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
    const watchWithTagsHtml = watchWith.map(w => `<button class="ww-tag ww-tag-clickable" onclick="event.stopPropagation(); toggleWatchWithFilterFromTag('${esc(w).replace(/'/g,"\\'")}')" title="Filter by this person">${esc(w)}</button>`).join('');
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
        <button class="more-btn" onclick="toggleMorePopover('${r.id}')" title="Watch with / collection">⋯</button>
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
          <button class="more-btn" onclick="toggleMorePopover('${r.id}')" title="Watch with / collection">⋯</button>
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

function toggleMorePopover(rowId) {
  const el = document.getElementById(`more-popover-${rowId}`);
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

async function toggleWatchWith(rowId, tag, checked) {
  const td = tabData[activeTabId];
  const row = td.rows.find(r => r.id === rowId);
  if (!row) return;
  const current = new Set(row.watch_with || []);
  if (checked) current.add(tag); else current.delete(tag);
  const updated = [...current];
  const previous = row.watch_with || [];
  row.watch_with = updated;
  try {
    await sbFetch('PATCH', `${TABLE}?id=eq.${rowId}`, { watch_with: updated });
    showSaved();
    renderTable();
  } catch(e) {
    row.watch_with = previous;
    renderTable();
    showError(e.message);
  }
}

// ─── Grouped rendering (Other TV, True Crime/Docs) ────────────────────────────
function statusOptionsHtml(status) {
  // "Caught Up" is purely derived (see hasWatchableSoonSeason) — never a status the
  // user sets directly. It only appears in this list when it's already the current
  // value (so the dropdown displays it correctly), and it's disabled so re-selecting
  // it can't happen — Supabase should never end up with a literal "caughtup" status.
  const caughtUpOption = status === 'caughtup'
    ? `<option value="caughtup" selected disabled>✓ Caught Up</option>`
    : '';
  return `
    <option value="confirmed"${status==='confirmed'?' selected':''}>✓ On List</option>
    <option value="highpriority"${status==='highpriority'?' selected':''}>⭐ High Priority</option>
    <option value="watching"${status==='watching'?' selected':''}>▶ Watching</option>
    ${caughtUpOption}
    <option value="complete"${status==='complete'?' selected':''}>◆ Complete</option>
    <option value="pending"${status==='pending'?' selected':''}>⏳ Pending</option>
    <option value="maybe"${status==='maybe'?' selected':''}>? Maybe Later</option>
    <option value="skipped"${status==='skipped'?' selected':''}>✕ Skipped</option>
  `;
}

function renderGroupedTable(list, td, fStatus) {
  // Which shows are visible is determined by the filtered `list`.
  // But once a show is visible, its season breakdown/progress/badges should reflect
  // ALL of that show's seasons in Supabase — not just the ones surviving the current filter —
  // otherwise progress counts (e.g. "2/3 watched") get skewed by filters like "Not watched".
  const visibleTitles = new Set(list.map(r => r.title));

  const groups = new Map();
  td.rows.forEach(r => {
    if (!visibleTitles.has(r.title)) return;
    if (!groups.has(r.title)) groups.set(r.title, []);
    groups.get(r.title).push(r);
  });

  // Status priority order for sorting: Watching > Caught Up > High Priority > On List > Complete > Pending > Maybe Later > Skipped
  const statusOrder = ['watching','caughtup','highpriority','confirmed','complete','pending','maybe','skipped'];

  const groupList = [...groups.entries()].map(([title, seasons]) => {
    seasons.sort((a,b) => a.date_sort.localeCompare(b.date_sort));
    // aggregate status: earliest-priority status present among this show's seasons
    let aggStatus = 'confirmed';
    for (const s of statusOrder) { if (seasons.some(x => x.status === s)) { aggStatus = s; break; } }
    // derived (not stored): a show sitting at "Watching" with nothing actually
    // watchable soon displays as "Caught Up" instead — purely a display state,
    // the underlying stored status remains "watching" in Supabase.
    if (aggStatus === 'watching' && !hasWatchableSoonSeason(seasons)) {
      aggStatus = 'caughtup';
    }
    return { title, seasons, earliestDate: seasons[0].date_sort, aggStatus };
  });
  groupList.sort((a,b) => {
    const rankDiff = statusOrder.indexOf(a.aggStatus) - statusOrder.indexOf(b.aggStatus);
    if (rankDiff !== 0) return rankDiff;
    return a.earliestDate.localeCompare(b.earliestDate);
  });

  // "Watching" and "Caught Up" are split by the derived aggStatus — a group's real
  // stored status stays "watching" in Supabase either way; only the filtered view differs.
  let visibleGroupList = groupList;
  if (fStatus === 'watching') {
    visibleGroupList = groupList.filter(group => group.aggStatus === 'watching');
  } else if (fStatus === 'caughtup') {
    visibleGroupList = groupList.filter(group => group.aggStatus === 'caughtup');
  }

  let html = '', cardHtml = '';
  visibleGroupList.forEach(group => {
    const { title, seasons, aggStatus } = group;
    const isExpanded = expandedShows.has(title);
    const network = seasons[0].theme || 'Unknown';
    const badgeStyle = networkBadgeStyle(network);
    const trackableSeasons = seasons.filter(s => s.status !== 'skipped');
    const watchedCount = trackableSeasons.filter(s => s.watched).length;
    const totalCount = trackableSeasons.length;
    const anyNew = seasons.some(s => td.newKeys.includes(s.item_key));

    const aggClass = `s-${aggStatus}`;

    const progressPct = totalCount > 0 ? Math.round(watchedCount/totalCount*100) : 0;
    const progressLabel = totalCount > 0 ? `${watchedCount}/${totalCount} watched` : `${seasons.length} season${seasons.length===1?'':'s'}`;
    const progressBarHtml = totalCount > 0
      ? `<div class="mini-progress-track"><div class="mini-progress-fill" style="width:${progressPct}%"></div></div>`
      : '';
    const titleEsc = esc(title).replace(/'/g,"\\'");
    const masterStatusCell = `<select class="status-select ${aggClass}" onclick="event.stopPropagation()" onchange="event.stopPropagation(); setShowStatus('${titleEsc}', this.value)">${statusOptionsHtml(aggStatus)}</select>`;

    const seasonRowsHtml = seasons.map(r => {
      const isSkipped = r.status === 'skipped';
      const isMaybe   = r.status === 'maybe';
      const statusClass = `s-${r.status}`;
      const statusCell = `<select class="status-select ${statusClass}" onchange="setStatus('${r.id}', this.value, this)">${statusOptionsHtml(r.status)}</select>`;
      const rowClass = isSkipped?'row-skipped':isMaybe?'row-maybe':'';
      return `<tr class="${rowClass} sub-row">
        <td style="padding-left:28px">
          <span class="season-lbl">${esc(r.season)}</span>
          ${td.newKeys.includes(r.item_key)?'<span class="new-tag">New</span>':''}
        </td>
        <td></td>
        <td class="date-cell">${esc(r.display_date)}</td>
        <td>${statusCell}</td>
        <td>${!isSkipped
          ? `<button class="watch-btn${r.watched?' watched':''}" onclick="toggleWatch('${r.id}')">${r.watched?'✓ Watched':'Mark watched'}</button>`
          : `<span class="confirmed-lbl">—</span>`
        }</td>
        <td><button class="del-btn" onclick="delRow('${r.id}')" title="Remove">×</button></td>
      </tr>`;
    }).join('');

    html += `<tr class="show-group-row" onclick="toggleShowExpand('${titleEsc}')">
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
      <td class="date-cell">${esc(seasons[0].display_date)}</td>
      <td>${masterStatusCell}</td>
      <td class="card-date">${progressLabel}${progressBarHtml}</td>
      <td><span class="confirmed-lbl">—</span></td>
    </tr>`;
    if (isExpanded) html += seasonRowsHtml;

    cardHtml += `<div class="item-card show-group-card">
      <div class="card-top" onclick="toggleShowExpand('${titleEsc}')" style="cursor:pointer">
        <div class="card-title-block">
          <span class="card-title">${esc(title)}</span>
          ${anyNew?'<span class="new-tag">New</span>':''}
        </div>
        <span class="expand-chevron">${isExpanded?'▾':'▸'}</span>
      </div>
      <div class="card-meta">
        <button class="badge badge-clickable" ${badgeStyle} onclick="event.stopPropagation(); toggleThemeFilterFromTag('${esc(network).replace(/'/g,"\\'")}')" title="Filter by this network">${esc(network)}</button>
        <span class="card-date">${esc(seasons[0].display_date)} · ${progressLabel}</span>
        ${progressBarHtml}
      </div>
      <div class="card-actions" onclick="event.stopPropagation()">
        ${masterStatusCell}
      </div>
      ${isExpanded ? `<div class="card-subseasons">${seasons.map(r => {
        const isSkipped = r.status === 'skipped';
        const statusClass = `s-${r.status}`;
        return `<div class="card-subseason-row">
          <span class="card-season">${esc(r.season)} · ${esc(r.display_date)}</span>
          <div class="card-actions">
            <select class="status-select ${statusClass}" onchange="setStatus('${r.id}', this.value, this)">${statusOptionsHtml(r.status)}</select>
            ${!isSkipped
              ? `<button class="watch-btn${r.watched?' watched':''}" onclick="toggleWatch('${r.id}')">${r.watched?'✓':'Mark watched'}</button>`
              : ''
            }
            <button class="card-del-btn" onclick="delRow('${r.id}')" title="Remove">×</button>
          </div>
        </div>`;
      }).join('')}</div>` : ''}
    </div>`;
  });

  const emptyMsg = fStatus === 'caughtup'
    ? `Nothing caught up right now — shows land here once they're marked Watching with no new episodes due in the next 60 days.`
    : fStatus === 'watching'
      ? `Nothing watchable in the next 60 days — check "Caught Up" or "All (except Skipped)" to see everything marked Watching.`
      : `No entries match your filters.`;
  document.getElementById('tbody').innerHTML = html || `<tr class="empty-row"><td colspan="6">${emptyMsg}</td></tr>`;
  document.getElementById('cardList').innerHTML = cardHtml || `<div class="empty-row" style="padding:2rem 0">${emptyMsg}</div>`;
}

function toggleShowExpand(title) {
  if (expandedShows.has(title)) expandedShows.delete(title);
  else expandedShows.add(title);
  renderTable();
}
