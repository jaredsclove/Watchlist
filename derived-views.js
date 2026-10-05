// ─── Derived TV views: Currently Watching, Coming Soon ────────────────────────
// Views over every TV collection's seasons and shows (tv_shows). They are not
// collections: nothing here writes a `collection` value, seeds defaults, calls
// TMDB, or touches backup/restore. While one is open, activeViewId holds its id
// and activeTabId is null. Edits go through the show and season actions
// (tv-shows.js, row-actions.js), by the show's or the row's real id.
// Defined here rather than in config.js so the catalog-refresh workflow's
// config.js cache handling is unaffected.
const DERIVED_VIEWS = [
  { id: 'watching',   label: 'Currently Watching', icon: '▶',  mediaType: 'tv' },
  { id: 'comingsoon', label: 'Coming Soon',        icon: '📅', mediaType: 'tv' }
];

// ─── Row rules (pure) ─────────────────────────────────────────────────────────
function tvCollectionIds() {
  return COLLECTIONS.filter(c => c.mediaType === 'tv').map(c => c.id);
}

// A TV season row from a TV collection. Excludes films: truecrime rows with
// media_type 'movie', and legacy/static rows labelled 'Film'.
function isTvViewRow(r) {
  if (!r || !tvCollectionIds().includes(r.collection)) return false;
  if (r.media_type === 'tv') return true;
  return r.media_type == null && r.season !== 'Film';
}

// Dynamic rows store TMDB's TBA as 'TBA' / '2099-01-01'; static rows use free
// text such as "TBA 2027" with a guessed date_sort, so the text decides.
function isTbaRow(r) {
  return /TBA/i.test(r.display_date || '') || r.date_sort === '2099-01-01';
}

// Today's date in the viewer's own time zone, as YYYY-MM-DD.
function localTodayStr(now) {
  const d = now || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Aired on or before today, going by the stored date only (no TMDB lookup).
function isReleasedRow(r, today) {
  return !isTbaRow(r) && (r.date_sort || '') <= today;
}

function isSpecialRow(r) {
  return r.season_number === 0 || /^Specials?$/i.test((r.season || '').trim());
}

// season_number when stored; otherwise the number in a static label such as
// "Season 5 (Part 1)" or "Volume 2"; otherwise last.
function seasonNumberOf(r) {
  if (r.season_number != null) return r.season_number;
  const m = /^(?:Season|Volume)\s+(\d+)/i.exec(r.season || '');
  return m ? parseInt(m[1], 10) : Infinity;
}

function cmpStr(a, b) {
  a = a || ''; b = b || '';
  return a < b ? -1 : a > b ? 1 : 0;
}

// Season order within a show: numbered seasons before specials, then season
// number, then date, then label.
function seasonOrder(a, b) {
  const sa = isSpecialRow(a) ? 1 : 0, sb = isSpecialRow(b) ? 1 : 0;
  if (sa !== sb) return sa - sb;
  const na = seasonNumberOf(a), nb = seasonNumberOf(b);
  if (na !== nb) return na < nb ? -1 : 1;
  return cmpStr(a.date_sort, b.date_sort) || cmpStr(a.season, b.season);
}

// Fully deterministic: the row id breaks any remaining tie.
function compareSeasons(a, b) {
  return seasonOrder(a, b) || cmpStr(a.id, b.id);
}

// One show per collection: TMDB identity when present, otherwise the title.
function showGroupKey(r) {
  return `${r.collection}|${r.tmdb_id != null ? `tmdb:${r.tmdb_id}` : `title:${(r.title || '').trim().toLowerCase()}`}`;
}

function collectionLabel(id) {
  return COLLECTIONS.find(c => c.id === id)?.label || id;
}

function compareTitles(a, b) {
  return (a || '').localeCompare(b || '', undefined, { sensitivity: 'base' });
}

// Watching shows (tv_shows.status), each with its seasons in sorted order, its up
// next season and whether it is Up to date (none of its remaining seasons has
// aired). Up to date is a state, not a stored status. Both lists are A–Z by
// title, then collection. `shows` is a Map or list of tv_shows rows.
function deriveCurrentlyWatching(rows, shows, today) {
  const seasonsByShow = new Map();
  rows.forEach(r => {
    if (!isTvViewRow(r) || !r.show_id) return;
    if (!seasonsByShow.has(r.show_id)) seasonsByShow.set(r.show_id, []);
    seasonsByShow.get(r.show_id).push(r);
  });
  const active = [], upToDate = [];
  for (const show of (shows instanceof Map ? shows.values() : shows)) {
    if (show.status !== 'watching') continue;
    const seasons = (seasonsByShow.get(show.id) || []).sort(compareSeasons);
    if (seasons.length === 0) continue;
    const upNext = upNextSeason(seasons);
    const item = {
      key: show.id,
      show,
      collection: show.collection,
      title: show.title,
      seasons,
      upNext,
      upNextReleased: upNext ? isReleasedRow(upNext, today) : false,
      upToDate: isShowUpToDate(seasons, today)
    };
    (item.upToDate ? upToDate : active).push(item);
  }
  const byTitle = (a, b) => compareTitles(a.title, b.title)
    || compareTitles(collectionLabel(a.collection), collectionLabel(b.collection))
    || cmpStr(a.key, b.key);
  return { active: active.sort(byTitle), upToDate: upToDate.sort(byTitle) };
}

// Linked, unwatched, non-skipped seasons of a show that isn't Skipped: those with
// a confirmed date from today on, and those still TBA (whatever their guessed date_sort).
function deriveComingSoon(rows, shows, today) {
  const showOf = r => (shows instanceof Map ? shows.get(r.show_id) : shows.find(s => s.id === r.show_id));
  const eligible = rows.filter(r => {
    if (!isTvViewRow(r) || !r.show_id || r.watched || r.skipped) return false;
    const show = showOf(r);
    return !!show && show.status !== 'skipped';
  });
  const order = (a, b) => cmpStr(a.date_sort, b.date_sort)
    || compareTitles(a.title, b.title)
    || seasonOrder(a, b)
    || compareTitles(collectionLabel(a.collection), collectionLabel(b.collection))
    || cmpStr(a.id, b.id);
  return {
    dated: eligible.filter(r => !isTbaRow(r) && (r.date_sort || '') >= today).sort(order),
    tba: eligible.filter(isTbaRow).sort(order)
  };
}

// ─── Loading ──────────────────────────────────────────────────────────────────
function tvRowsFilter() {
  return `collection=in.(${tvCollectionIds().map(id => encodeURIComponent(`"${id}"`)).join(',')})`;
}

// Paginated, exact-count-checked reads of every TV collection's rows and of every
// show. GET only: no seeding, no TBA refresh. Refetched each time a view is entered.
async function loadDerivedView() {
  const viewId = activeViewId;
  if (!viewId) return;
  const seq = ++derivedLoadSeq;
  document.getElementById('statsRow').innerHTML = '';
  document.getElementById('filtersRow').innerHTML = '';
  showError('');
  paintDerivedMessage('Loading…', false);
  try {
    const [rows, shows] = await Promise.all([fetchAllRows(TABLE, tvRowsFilter()), fetchAllRows('tv_shows')]);
    if (seq !== derivedLoadSeq || activeViewId !== viewId) return;
    tvShowsById = new Map(shows.map(s => [s.id, s]));
    derivedData = { rows: rows.filter(isTvViewRow), loaded: true };
    renderFilters();
    renderTable();
  } catch(e) {
    console.error(e);
    if (seq !== derivedLoadSeq || activeViewId !== viewId) return;
    showError(`Couldn't load every TV row, so nothing is shown rather than an incomplete list. ${e.message}`);
    paintDerivedMessage('Failed to load.', true);
  }
}

function paintDerivedMessage(text, withRetry) {
  const retry = withRetry ? ` <button class="btn" onclick="loadDerivedView()">Retry</button>` : '';
  document.getElementById('tbody').innerHTML = `<tr><td colspan="6" class="loading">${esc(text)}${retry}</td></tr>`;
  document.getElementById('cardList').innerHTML = `<div class="loading">${esc(text)}${retry}</div>`;
}

// ─── Filters ──────────────────────────────────────────────────────────────────
function renderDerivedFilters() {
  const filtersRowEl = document.getElementById('filtersRow');
  const tag = `view:${activeViewId}`;
  const keepState = filtersRowEl.dataset.tab === tag;
  const savedValues = {};
  if (keepState) {
    ['fSearch', 'fSource'].forEach(id => {
      const el = document.getElementById(id);
      if (el) savedValues[id] = el.value;
    });
  }
  const wasCollapsed = filtersRowEl.classList.contains('collapsed');
  const sourceOpts = COLLECTIONS.filter(c => c.mediaType === 'tv')
    .map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');

  filtersRowEl.innerHTML = `
    <button class="filter-toggle-btn" onclick="toggleFilters()" id="filterToggleBtn">
      <span>🔍 Search &amp; Filter</span><span id="filterToggleChevron">▾</span>
    </button>
    <div class="filters-inner">
      <span class="filter-label">Filter:</span>
      <input class="search-input" id="fSearch" type="text" placeholder="Search titles…" oninput="renderTable()">
      <select id="fSource" onchange="renderTable()">
        <option value="">All TV sources</option>${sourceOpts}
      </select>
    </div>
  `;
  filtersRowEl.dataset.tab = tag;
  if (window.innerWidth <= 700) filtersRowEl.classList.add('collapsed');

  const tmdbPanel = document.getElementById('tmdbPanel');
  tmdbPanel.style.display = 'none';
  tmdbPanel.innerHTML = '';

  if (keepState) {
    for (const [id, value] of Object.entries(savedValues)) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === value)) continue;
      el.value = value;
    }
    if (filtersRowEl.classList.contains('collapsed') !== wasCollapsed) toggleFilters();
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function renderDerivedTable() {
  if (!derivedData || !derivedData.loaded) return;
  const today = localTodayStr();
  const fSearch = document.getElementById('fSearch')?.value.trim().toLowerCase() || '';
  const fSource = document.getElementById('fSource')?.value || '';
  const keep = x => (!fSource || x.collection === fSource) && (!fSearch || (x.title || '').toLowerCase().includes(fSearch));
  updateDerivedTableHeader();
  if (activeViewId === 'comingsoon') renderComingSoon(today, keep);
  else renderCurrentlyWatching(today, keep);
}

function updateDerivedTableHeader() {
  const thead = document.getElementById('tableHead');
  if (!thead) return;
  thead.innerHTML = activeViewId === 'comingsoon'
    ? `<tr><th>Show &amp; Season</th><th>Source</th><th>Theme</th><th>Premiere</th><th>Status</th><th></th></tr>`
    : `<tr><th>Show</th><th>Source</th><th>Up next</th><th>Status</th><th>Watched</th><th>Progress</th></tr>`;
}

function sourceBadgeHtml(collectionId) {
  const col = COLLECTIONS.find(c => c.id === collectionId);
  return `<span class="source-badge" title="Stored in ${esc(col?.label || collectionId)}">${col ? `${col.icon} ` : ''}${esc(col?.label || collectionId)}</span>`;
}

// Dynamic tabs store the network as the theme; static tabs use themed badges.
function themeBadgeHtml(collectionId, theme) {
  if (!theme) return '';
  const col = COLLECTIONS.find(c => c.id === collectionId);
  return col?.dynamic
    ? `<span class="badge" ${networkBadgeStyle(theme)}>${esc(theme)}</span>`
    : `<span class="badge ${badgeClass(theme)}">${esc(theme)}</span>`;
}

function derivedStatsHtml(stats) {
  return stats.map(([num, label]) => `<div class="stat"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`).join('');
}

function derivedSectionHtml(name, label, count) {
  const open = !!derivedSectionOpen[name];
  const chevron = `<span class="expand-chevron">${open ? '▾' : '▸'}</span>`;
  return {
    row: `<tr class="derived-section-row" onclick="toggleDerivedSection('${name}')"><td colspan="6">${chevron} ${esc(label)} <span class="section-count">${count}</span></td></tr>`,
    card: `<div class="derived-section-card" onclick="toggleDerivedSection('${name}')">${chevron} ${esc(label)} <span class="section-count">${count}</span></div>`
  };
}

function renderCurrentlyWatching(today, keep) {
  const { active, upToDate } = deriveCurrentlyWatching(derivedData.rows, tvShowsById, today);
  const shownActive = active.filter(keep);
  const shownUpToDate = upToDate.filter(keep);

  document.getElementById('statsRow').innerHTML = derivedStatsHtml([
    [shownActive.length, 'In progress'],
    [shownUpToDate.length, 'Up to date']
  ]);

  let html = '', cardHtml = '';
  shownActive.forEach(show => {
    const out = derivedShowHtml(show, today);
    html += out.row;
    cardHtml += out.card;
  });

  if (shownActive.length === 0) {
    const msg = active.length + upToDate.length === 0
      ? 'Nothing is marked Watching yet. Set a show to ▶ Watching on any TV tab and it shows up here.'
      : active.length === 0
        ? 'Nothing in progress. Every Watching show is up to date.'
        : 'No in-progress shows match your filters.';
    html += `<tr class="empty-row"><td colspan="6">${esc(msg)}</td></tr>`;
    cardHtml += `<div class="empty-row" style="padding:2rem 0">${esc(msg)}</div>`;
  }

  if (shownUpToDate.length > 0) {
    const section = derivedSectionHtml('uptodate', 'Up to date', shownUpToDate.length);
    html += section.row;
    cardHtml += section.card;
    if (derivedSectionOpen.uptodate) {
      shownUpToDate.forEach(show => {
        const out = derivedShowHtml(show, today);
        html += out.row;
        cardHtml += out.card;
      });
    }
  }

  document.getElementById('tbody').innerHTML = html;
  document.getElementById('cardList').innerHTML = cardHtml;
}

// One Watching show: a header row/card with its up-next season (or, when Up to
// date, what is next on the list), the show-level status control and, for a
// show in progress, the up-next season's watch control; expanded, every season
// of the show with Watched and Skip / Keep.
function derivedShowHtml(item, today) {
  const { key, show, seasons, upNext, upToDate } = item;
  const isExpanded = expandedShows.has(key);
  const keyArg = esc(key).replace(/'/g, "\\'");
  const theme = (upNext || seasons[0]).theme;
  const badges = `${sourceBadgeHtml(item.collection)} ${themeBadgeHtml(item.collection, theme)}`;

  const trackable = seasons.filter(s => !s.skipped);
  const watchedCount = trackable.filter(s => s.watched).length;
  const progressPct = trackable.length > 0 ? Math.round(watchedCount / trackable.length * 100) : 0;
  const progressLabel = trackable.length > 0 ? `${watchedCount}/${trackable.length} watched` : `${seasons.length} season${seasons.length === 1 ? '' : 's'}`;
  const progressBarHtml = trackable.length > 0
    ? `<div class="mini-progress-track"><div class="mini-progress-fill" style="width:${progressPct}%"></div></div>`
    : '';

  const upcomingTag = upNext && !item.upNextReleased ? '<span class="upcoming-tag">Upcoming</span>' : '';
  const upNextLabel = upToDate
    ? upToDateNextLabel(upNext)
    : `${esc(upNext.season)} · ${esc(upNext.display_date)}${upcomingTag}`;
  const upToDatePill = upToDate ? ' <span class="status-pill s-caughtup">Up to date</span>' : '';
  const releaseOpts = { requireReleased: true, today };
  const subOpts = { isNew: false, showMatch: false, showDelete: false, requireReleased: true, today };
  const watchCell = !upToDate && upNext ? seasonWatchControlHtml(upNext, { ...releaseOpts, stopPropagation: true }, false) : '<span class="confirmed-lbl">—</span>';

  let row = `<tr class="show-group-row derived-show-row" onclick="toggleDerivedShow('${keyArg}')">
      <td>
        <div class="show-title-row">
          <div class="show-title-left"><span class="show-title">${esc(item.title)}</span></div>
          <span class="expand-chevron">${isExpanded ? '▾' : '▸'}</span>
        </div>
      </td>
      <td>${badges}</td>
      <td class="date-cell">${upNextLabel}</td>
      <td>${showStatusSelectHtml(show, { stopPropagation: true })}${upToDatePill}</td>
      <td>${watchCell}</td>
      <td class="card-date">${progressLabel}${progressBarHtml}</td>
    </tr>`;
  if (isExpanded) row += seasons.map(r => seasonSubRowHtml(r, subOpts)).join('');

  const card = `<div class="item-card show-group-card">
      <div class="card-top" onclick="toggleDerivedShow('${keyArg}')" style="cursor:pointer">
        <div class="card-title-block">
          <span class="card-title">${esc(item.title)}</span>
          <span class="card-season">${upNextLabel}</span>
        </div>
        <span class="expand-chevron">${isExpanded ? '▾' : '▸'}</span>
      </div>
      <div class="card-meta">
        ${badges}
        <span class="card-date">${progressLabel}</span>
        ${progressBarHtml}
      </div>
      <div class="card-actions" onclick="event.stopPropagation()">
        ${showStatusSelectHtml(show)}${upToDatePill}
        ${!upToDate && upNext ? seasonWatchControlHtml(upNext, releaseOpts, false) : ''}
      </div>
      ${isExpanded ? `<div class="card-subseasons">${seasons.map(r => seasonSubCardHtml(r, subOpts)).join('')}</div>` : ''}
    </div>`;

  return { row, card };
}

// What is next for an Up to date show, from what's stored in the list (no TMDB
// lookup): a future or TBA up-next season, or nothing yet.
function upToDateNextLabel(upNext) {
  if (!upNext) return `<span title="Based on the seasons stored in your list. New seasons are added by ↻ Refresh shows (Other TV, True Crime / Docs) or a catalog refresh (static tabs).">No new season on your list yet</span>`;
  if (isTbaRow(upNext)) return `Next: ${esc(upNext.season)} · premiere date TBA`;
  return `Next: ${esc(upNext.season)} · ${esc(upNext.display_date)}<span class="upcoming-tag">Upcoming</span>`;
}

function renderComingSoon(today, keep) {
  const { dated, tba } = deriveComingSoon(derivedData.rows, tvShowsById, today);
  const shownDated = dated.filter(keep);
  const shownTba = tba.filter(keep);
  const in30 = new Date();
  in30.setDate(in30.getDate() + 30);
  const cutoff30 = localTodayStr(in30);

  document.getElementById('statsRow').innerHTML = derivedStatsHtml([
    [shownDated.length, 'Dated'],
    [shownDated.filter(r => r.date_sort <= cutoff30).length, 'Next 30 days'],
    [shownTba.length, 'TBA']
  ]);

  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  let html = '', cardHtml = '', lastMonth = '';
  shownDated.forEach(r => {
    const month = r.date_sort.substring(0, 7);
    if (month !== lastMonth) {
      const label = `${months[parseInt(month.substring(5, 7), 10) - 1] || ''} ${month.substring(0, 4)}`;
      html += `<tr class="year-group"><td colspan="6">${esc(label)}</td></tr>`;
      cardHtml += `<div class="card-year-group">${esc(label)}</div>`;
      lastMonth = month;
    }
    const out = comingSoonRowHtml(r, today);
    html += out.row;
    cardHtml += out.card;
  });

  if (shownDated.length === 0) {
    const msg = dated.length === 0 ? 'Nothing with a confirmed date is coming up.' : 'No dated entries match your filters.';
    html += `<tr class="empty-row"><td colspan="6">${esc(msg)}</td></tr>`;
    cardHtml += `<div class="empty-row" style="padding:2rem 0">${esc(msg)}</div>`;
  }

  if (shownTba.length > 0) {
    const section = derivedSectionHtml('tba', 'TBA', shownTba.length);
    html += section.row;
    cardHtml += section.card;
    if (derivedSectionOpen.tba) {
      shownTba.forEach(r => {
        const out = comingSoonRowHtml(r, today);
        html += out.row;
        cardHtml += out.card;
      });
    }
  }

  document.getElementById('tbody').innerHTML = html;
  document.getElementById('cardList').innerHTML = cardHtml;
}

// Source/date details, the show's status as a label, and Skip only: Coming
// Soon is about availability, so there is no status menu, watch control or delete.
function comingSoonRowHtml(r, today) {
  const status = displayStatus(r);
  const rowClass = status === 'maybe' ? 'row-maybe' : '';
  const todayTag = r.date_sort === today ? '<span class="today-tag">Today</span>' : '';
  const statusPill = `<span class="status-pill s-${status}" title="Show status">${esc(statusOptionLabel(status))}</span>`;
  const skip = seasonSkipButtonHtml(r);
  const row = `<tr class="${rowClass}">
      <td>
        <span class="show-title">${esc(r.title)}</span>
        <span class="season-lbl"> · ${esc(r.season)}</span>
        ${todayTag}
      </td>
      <td>${sourceBadgeHtml(r.collection)}</td>
      <td>${themeBadgeHtml(r.collection, r.theme)}</td>
      <td class="date-cell">${esc(r.display_date)}</td>
      <td>${statusPill}</td>
      <td>${skip}</td>
    </tr>`;
  const card = `<div class="item-card ${rowClass}">
      <div class="card-top">
        <div class="card-title-block">
          <span class="card-title">${esc(r.title)}</span>
          <span class="card-season">${esc(r.season)}</span>
          ${todayTag}
        </div>
      </div>
      <div class="card-meta">
        ${sourceBadgeHtml(r.collection)}
        ${themeBadgeHtml(r.collection, r.theme)}
        <span class="card-date">${esc(r.display_date)}</span>
      </div>
      <div class="card-actions">${statusPill} ${skip}</div>
    </div>`;
  return { row, card };
}

function toggleDerivedShow(key) {
  if (expandedShows.has(key)) expandedShows.delete(key);
  else expandedShows.add(key);
  renderTable();
}

function toggleDerivedSection(name) {
  derivedSectionOpen[name] = !derivedSectionOpen[name];
  renderTable();
}
