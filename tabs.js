// ─── Tab bar ──────────────────────────────────────────────────────────────────
function buildTabs() {
  const bar = document.getElementById('tabBar');
  const visibleCollections = COLLECTIONS.filter(c => c.mediaType === activeMediaType);
  bar.innerHTML = visibleCollections.map(c =>
    `<div class="tab${c.id===activeTabId?' active':''}" onclick="switchTab('${c.id}')">
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
  const firstInMode = COLLECTIONS.find(c => c.mediaType === type);
  if (firstInMode) {
    switchTab(firstInMode.id);
  }
  buildMediaSwitch();
}

function switchTab(id) {
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

    if (toInsert.length > 0) {
      const inserted = await sbFetch('POST', TABLE, toInsert);
      if (inserted) rows.push(...inserted);
    }

    rows.sort((a,b) => a.date_sort.localeCompare(b.date_sort));

    // Always cache the result, even if the user has navigated away — this keeps
    // tabData correct and avoids redundant reloads when they switch back.
    tabData[collectionId] = { rows, loaded: true, newKeys };

    // But only touch the visible DOM if this tab is still the one being viewed.
    if (activeTabId !== collectionId) return;

    if (newKeys.length > 0) {
      document.getElementById('banner').innerHTML =
        `<div class="banner">✦ ${newKeys.length} new entr${newKeys.length===1?'y':'ies'} added.</div>`;
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
