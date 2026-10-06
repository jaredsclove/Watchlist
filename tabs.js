// ─── Tab bar ──────────────────────────────────────────────────────────────────
function buildTabs() {
  const bar = document.getElementById('tabBar');
  // Derived views (Currently Watching, Coming Soon) come first; they aren't collections.
  const viewTabs = DERIVED_VIEWS.filter(v => v.mediaType === activeMediaType).map(v =>
    `<div class="tab${v.id===activeViewId?' active':''}" onclick="switchView('${v.id}')">
      <span class="tab-icon">${v.icon}</span>${esc(v.label)}
    </div>`
  ).join('');
  const visibleCollections = COLLECTIONS.filter(c => c.mediaType === activeMediaType);
  bar.innerHTML = viewTabs + (viewTabs ? '<div class="tab-sep"></div>' : '') + visibleCollections.map(c =>
    `<div class="tab${!activeViewId && c.id===activeTabId?' active':''}" onclick="switchTab('${c.id}')">
      <span class="tab-icon">${c.icon}</span>${esc(c.label)}
    </div>`
  ).join('');
}

function buildMediaSwitch() {
  const el = document.getElementById('mediaSwitch');
  if (!el) return;
  el.innerHTML = `
    <button class="media-switch-btn${activeMediaType==='tv'?' active':''}" onclick="switchMediaType('tv')">📺 TV</button>
    <button class="media-switch-btn${activeMediaType==='movie'?' active':''}" onclick="switchMediaType('movie')">🎬 Movies</button>
  `;
}

function switchMediaType(type) {
  if (type === activeMediaType) return;
  activeMediaType = type;
  // TV always lands on its first derived view (Currently Watching).
  const firstView = DERIVED_VIEWS.find(v => v.mediaType === type);
  const firstInMode = COLLECTIONS.find(c => c.mediaType === type);
  if (firstView) {
    switchView(firstView.id);
  } else if (firstInMode) {
    switchTab(firstInMode.id);
  }
  buildMediaSwitch();
}

function switchTab(id) {
  activeViewId = null;
  activeTabId = id;
  addOpen = false;
  tmdbSelectedShow = null;
  expandedShows = new Set();
  document.getElementById('addForm').style.display = 'none';
  document.getElementById('banner').innerHTML = '';
  buildTabs();
  const td = tabData[id];
  if (!td || !td.loaded) {
    loadTab(id);
  } else {
    renderFilters();
    renderTable();
  }
}

// Opens a derived view. activeTabId becomes null, so no collection is active:
// anything that would write `collection: activeTabId` is refused by the DB's
// NOT NULL, and a late loadTab() never paints over the view.
function switchView(id) {
  activeViewId = id;
  activeTabId = null;
  addOpen = false;
  tmdbSelectedShow = null;
  expandedShows = new Set();
  derivedSectionOpen = { uptodate: true, tba: false, alltvTba: false };
  // All TV: the remembered Shows / Seasons choice; the Seasons visibility starts at All seasons.
  if (id === 'alltv') allTvPresentation = readAllTvPresentation();
  allTvSeasonVis = 'all';
  derivedData = null;
  document.getElementById('addForm').style.display = 'none';
  document.getElementById('banner').innerHTML = '';
  const tmdbPanel = document.getElementById('tmdbPanel');
  tmdbPanel.style.display = 'none';
  tmdbPanel.innerHTML = '';
  buildTabs();
  loadDerivedView();
}

// ─── Load tab data from Supabase ─────────────────────────────────────────────
async function loadTab(collectionId) {
  // Only show the loading state if this is still the tab the user is looking at —
  // if they've already switched tabs by the time this fires, don't touch the DOM.
  if (activeTabId === collectionId) {
    document.getElementById('tbody').innerHTML = `<tr><td colspan="6" class="loading">Loading…</td></tr>`;
    document.getElementById('cardList').innerHTML = `<div class="loading">Loading…</div>`;
    document.getElementById('statsRow').innerHTML = '';
    document.getElementById('filtersRow').innerHTML = '';
    showError('');
  }

  try {
    const rows = await sbFetch('GET',
      `${TABLE}?collection=eq.${encodeURIComponent(collectionId)}&order=date_sort.asc&select=*`,
      null
    );

    const col = COLLECTIONS.find(c => c.id === collectionId);
    const existingKeys = new Set(rows.map(r => r.item_key));
    const toInsert = [];
    const newKeys = [];

    for (const d of col.defaults) {
      if (!existingKeys.has(d.k)) {
        toInsert.push({
          collection: collectionId,
          item_key: d.k,
          title: d.t,
          season: d.s,
          theme: d.th,
          display_date: d.d,
          date_sort: d.ds,
          watched: false,
          status: d.p ? 'pending' : 'confirmed'
        });
        newKeys.push(d.k);
      } else {
        // refresh TBA dates
        const existing = rows.find(r => r.item_key === d.k);
        if (existing && /TBA/i.test(existing.display_date) && !/TBA/i.test(d.d)) {
          await sbFetch('PATCH',
            `${TABLE}?collection=eq.${encodeURIComponent(collectionId)}&item_key=eq.${encodeURIComponent(d.k)}`,
            { display_date: d.d, date_sort: d.ds }
          );
          existing.display_date = d.d;
          existing.date_sort = d.ds;
        }
      }
    }

    let reopenedIds = [];
    let reviewConflicts = [];
    if (toInsert.length > 0 && isTvCollection(collectionId)) {
      // Only the defaults found missing above, so the rule for "missing" stays
      // exactly this one; seed_tv_defaults links each new season to its show
      // (and reopens a Complete show that gets a new season).
      const missing = new Set(newKeys);
      const res = await sbRpc('seed_tv_defaults', { p_collection: collectionId, p_defaults: col.defaults.filter(d => missing.has(d.k)) });
      rows.push(...(res.inserted || []));
      reopenedIds = res.reopened || [];
      reviewConflicts = (res.conflicts || []).filter(c => TV_REVIEW_REASONS.includes(c.reason));
    } else if (toInsert.length > 0) {
      const inserted = await sbFetch('POST', TABLE, toInsert);
      if (inserted) rows.push(...inserted);
    }
    // A TV tab's statuses live on its shows: read them after any seeding.
    if (isTvCollection(collectionId)) await loadTvShows(collectionId);

    rows.sort((a,b) => a.date_sort.localeCompare(b.date_sort));

    // Always cache the result, even if the user has navigated away — this keeps
    // tabData correct and avoids redundant reloads when they switch back.
    tabData[collectionId] = { rows, loaded: true, newKeys };

    // But only touch the visible DOM if this tab is still the one being viewed.
    if (activeTabId !== collectionId) return;

    if (newKeys.length > 0) {
      const reopened = reopenedIds.map(id => tvShowsById.get(id)?.title).filter(Boolean);
      const reopenedNote = reopened.length
        ? ` ${reopened.map(t => `"${esc(t)}"`).join(', ')} ${reopened.length === 1 ? 'was' : 'were'} Complete and got a new season, so ${reopened.length === 1 ? 'it is' : 'they are'} back On List.`
        : '';
      const added = newKeys.length - reviewConflicts.length;
      const reviewNote = reviewConflicts.length
        ? ` ${esc(tvReviewMessage(reviewConflicts.map(c => ({ season: c.season || c.item_key, reason: c.reason, title: tvShowsById.get(c.show_id)?.title }))))}`
        : '';
      document.getElementById('banner').innerHTML =
        `<div class="banner">✦ ${added} new entr${added===1?'y':'ies'} added.${reopenedNote}${reviewNote}</div>`;
    }

    renderFilters();
    renderTable();
  } catch(e) {
    if (activeTabId !== collectionId) { console.error(e); return; }
    showError(e.message);
    document.getElementById('tbody').innerHTML = `<tr><td colspan="6" class="loading">Failed to load. Check console for details.</td></tr>`;
    document.getElementById('cardList').innerHTML = `<div class="loading">Failed to load. Check console for details.</div>`;
    console.error(e);
  }
}
