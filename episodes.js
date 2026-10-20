// ─── Episode progress within seasons (EP1) ────────────────────────────────────
// A TMDB-matched season can hold episode marks (public.episode_marks: the TMDB episode id and the
// episode number when it was marked; no dates, no titles). The marks are read with each view's rows
// (episodeMarks) and change only through library_set_episode_marks, one change at a time through
// the write lane. Show-level Watching and the season's Watched / Skip are unchanged: "In progress"
// is derived (a season not watched or skipped with at least one mark), and a watched or skipped
// season's episodes are locked (changing those flags keeps every mark). Nothing here completes a
// season: when every listed episode is checked, the open list offers Mark season watched.
// One season's episode list is open at a time (episodePanel), fetched from TMDB when it opens and
// kept only in page memory. Each list's episode ids are cached on this device (per account) so a
// collapsed season can say "N/T watched"; Refresh shows and Add season leave a count only. The
// cache is replaceable reference data: it never changes saved marks or a season's state.

const EPISODE_LIST_CACHE_KEY = 'watchlist-episode-lists';

// A season row that takes episode marks: a TV season of a show, matched to TMDB.
function isEpisodeTrackable(r) {
  return !!r && isTvSeason(r) && !!r.show_id && r.media_type === 'tv' && r.tmdb_id != null && r.season_number != null;
}

// ── Saved marks ──
// The owner's marks for a view's read (strict: the browse views' complete-or-nothing read). A database
// without them isn't in this page's phase: like a read without the B4/B5 columns, the page stops
// writing until it is reloaded, and the view shows that the page and the database don't match.
async function readEpisodeMarks(strict) {
  try { return await (strict ? fetchAllRowsStrict('episode_marks') : fetchAllRows('episode_marks')); }
  catch (e) {
    if (/PGRST205/.test(String(e && e.message))) { stopB45Writes(); throw new Error(STATE_MISMATCH_TEXT); }
    throw e;
  }
}
// Every read of a view publishes the owner's marks with its rows (the whole table: a few per season).
function publishEpisodeMarks(rows) {
  const next = new Map();
  (rows || []).forEach(m => {
    if (!next.has(m.season_id)) next.set(m.season_id, new Map());
    next.get(m.season_id).set(m.tmdb_episode_id, { id: m.id, episode_number: m.episode_number });
  });
  episodeMarks = next;
}
function marksOf(seasonId) {
  return episodeMarks.get(seasonId) || new Map();
}
function episodeMarkCount(seasonId) {
  return marksOf(seasonId).size;
}
// The season's marks as the database returned them after a change.
function replaceSeasonMarks(seasonId, marks) {
  const m = new Map((marks || []).map(x => [x.tmdb_episode_id, { id: x.id, episode_number: x.episode_number }]));
  if (m.size) episodeMarks.set(seasonId, m); else episodeMarks.delete(seasonId);
}

// ── The per-device list cache: { "<tmdb show id>:<season number>": { ids: [...] } | { count } } ──
function readEpisodeListCache() {
  try {
    const v = JSON.parse(userStorage.getItem(EPISODE_LIST_CACHE_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}
function writeEpisodeListCache(cache) {
  try { userStorage.setItem(EPISODE_LIST_CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* storage unavailable: totals stay unknown */ }
}
const episodeCacheKey = (tmdbId, seasonNumber) => `${tmdbId}:${seasonNumber}`;
// A loaded list: its episode ids (the exact list the collapsed count is measured against).
function noteEpisodeList(tmdbId, seasonNumber, ids) {
  const cache = readEpisodeListCache();
  cache[episodeCacheKey(tmdbId, seasonNumber)] = { ids: ids.slice() };
  writeEpisodeListCache(cache);
}
// A show's seasons from TMDB's show details (Refresh shows, Add season): a count only, kept unless
// the cached list already has that many episodes (its ids are more precise).
function noteSeasonEpisodeCounts(tmdbId, seasons) {
  if (tmdbId == null || !Array.isArray(seasons)) return;
  const cache = readEpisodeListCache();
  let changed = false;
  seasons.forEach(s => {
    if (!s || !Number.isInteger(s.season_number) || !Number.isInteger(s.episode_count) || s.episode_count < 0) return;
    const key = episodeCacheKey(tmdbId, s.season_number), had = cache[key];
    if (had && Array.isArray(had.ids) && had.ids.length === s.episode_count) return;
    if (had && had.count === s.episode_count) return;
    cache[key] = { count: s.episode_count };
    changed = true;
  });
  if (changed) writeEpisodeListCache(cache);
}
function cachedEpisodeList(r) {
  const v = readEpisodeListCache()[episodeCacheKey(r.tmdb_id, r.season_number)];
  if (v && Array.isArray(v.ids) && v.ids.every(Number.isInteger)) return { ids: v.ids };
  if (v && Number.isInteger(v.count) && v.count >= 0) return { count: v.count };
  return null;
}

// ── Progress text ──
// Against a list of episode ids: the marks that belong to it, and the ones kept for episodes it
// no longer lists (never counted toward the list).
function marksAgainstList(seasonId, ids) {
  const listed = new Set(ids), marks = marksOf(seasonId);
  let inList = 0;
  marks.forEach((v, id) => { if (listed.has(id)) inList++; });
  return { inList, unlisted: marks.size - inList, total: ids.length };
}
// A collapsed season: "N/T watched" against the cached list; from a count alone only while the marks
// are fewer than it (a count can't tell a kept mark for an unlisted episode from a listed one, so it
// never shows a complete-looking T/T); otherwise "N marked". Nothing for a season without marks, an
// untracked or a skipped one.
function episodeProgressText(r) {
  if (!isEpisodeTrackable(r) || r.skipped) return '';
  const n = episodeMarkCount(r.id);
  if (!n) return '';
  const cached = cachedEpisodeList(r);
  let text = `${n} marked`;
  if (cached && cached.ids && cached.ids.length) {
    const p = marksAgainstList(r.id, cached.ids);
    text = `${p.inList}/${p.total} watched${p.unlisted ? ` · ${p.unlisted} not listed` : ''}`;
  } else if (cached && cached.count > 0 && n < cached.count) text = `${n}/${cached.count} watched`;
  return r.watched ? text : `In progress · ${text}`;
}
function episodeProgressHtml(r) {
  const text = episodeProgressText(r);
  return text ? ` <span class="ep-progress">${esc(text)}</span>` : '';
}

// ── The open list ──
function episodeToggleHtml(r) {
  if (!isEpisodeTrackable(r)) return '';
  const open = !!episodePanel && episodePanel.seasonId === r.id;
  const idArg = esc(r.id).replace(/'/g, "\\'");
  const name = `${open ? 'Hide' : 'Show'} the episodes of ${r.season}`;
  return seasonActionHtml('episodes', `<button type="button" class="btn btn-link ep-toggle" aria-expanded="${open}" aria-label="${esc(name)}" onclick="event.stopPropagation(); toggleEpisodes('${idArg}')">${open ? '▾' : '▸'} Episodes</button>`);
}

function toggleEpisodes(seasonId) {
  if (episodePanel && episodePanel.seasonId === seasonId) { episodePanel = null; renderTable(); return; }
  const row = actionRows().find(r => r.id === seasonId);
  if (!isEpisodeTrackable(row)) return;
  loadEpisodeList(row);
}

async function loadEpisodeList(row) {
  const seq = ++episodePanelSeq;
  episodePanel = { seasonId: row.id, seq, status: 'loading', episodes: [], error: '', titles: new Set() };
  renderTable();
  let d;
  try { d = await tmdbFetch(`/tv/${row.tmdb_id}/season/${row.season_number}`); }
  catch (e) {
    if (!episodePanel || episodePanel.seq !== seq) return;
    episodePanel.status = 'error';
    episodePanel.error = e && e.status === 404 ? 'TMDB has no episode list for this season' : (e && e.message) || 'TMDB didn’t answer';
    renderTable();
    return;
  }
  if (!episodePanel || episodePanel.seq !== seq) return;
  const seen = new Set();
  const episodes = (d && Array.isArray(d.episodes) ? d.episodes : [])
    .filter(e => e && Number.isInteger(e.id) && e.id > 0 && Number.isInteger(e.episode_number) && e.episode_number >= 0 && !seen.has(e.id) && seen.add(e.id))
    .map(e => ({ id: e.id, number: e.episode_number, name: typeof e.name === 'string' ? e.name : '',
      air_date: /^\d{4}-\d{2}-\d{2}$/.test(e.air_date || '') ? e.air_date : null }))
    .sort((a, b) => a.number - b.number || a.id - b.id);
  episodePanel.status = 'ready';
  episodePanel.episodes = episodes;
  noteEpisodeList(row.tmdb_id, row.season_number, episodes.map(e => e.id));
  renderTable();
}

function retryEpisodes(seasonId) {
  const row = actionRows().find(r => r.id === seasonId);
  if (isEpisodeTrackable(row)) loadEpisodeList(row);
}

function toggleEpisodeTitle(seasonId, episodeId) {
  if (!episodePanel || episodePanel.seasonId !== seasonId) return;
  if (episodePanel.titles.has(episodeId)) episodePanel.titles.delete(episodeId); else episodePanel.titles.add(episodeId);
  renderTable();
}

// The open list's markup for a season row (a table row, or a block in the phone card); '' when closed.
// Each control has a focus hook (data-action within data-season-row), so a redraw keeps focus on it.
function episodePanelHtml(r, opts = {}, card = false) {
  if (!episodePanel || episodePanel.seasonId !== r.id || !isEpisodeTrackable(r)) return '';
  const p = episodePanel;
  const idArg = esc(r.id).replace(/'/g, "\\'");
  const marks = marksOf(r.id);
  const locked = r.watched || r.skipped;
  const today = localTodayStr();
  const parts = [];
  if (r.watched && !marks.size) parts.push('<div class="ep-note">Watched (no episode detail)</div>');
  else if (r.watched) parts.push(`<div class="ep-note">This season is marked watched, so its episodes are locked; unmark it to change them. Its marks are kept.</div>`);
  else if (r.skipped) parts.push(`<div class="ep-note">This season is skipped, so its episodes are locked; keep it to change them.${marks.size ? ' Its marks are kept.' : ''}</div>`);
  if (p.status === 'loading') parts.push('<div class="ep-note" role="status">Loading episodes…</div>');
  else if (p.status === 'error') {
    parts.push(`<div class="ep-note" role="status">Couldn’t load the episode list (${esc(p.error)}).${marks.size ? ` ${marks.size} episode${marks.size === 1 ? ' is' : 's are'} marked.` : ''} `
      + `${seasonActionHtml('ep-retry', `<button type="button" class="btn btn-link" onclick="retryEpisodes('${idArg}')">Retry</button>`)}</div>`);
  } else if (!(r.watched && !marks.size)) {
    const eps = p.episodes;
    const listed = new Set(eps.map(e => e.id));
    const done = eps.filter(e => marks.has(e.id)).length;
    const notAired = eps.filter(e => e.air_date && e.air_date > today).length, noDate = eps.filter(e => !e.air_date).length;
    parts.push(`<div class="ep-summary">${eps.length ? `${done}/${eps.length} watched` : 'TMDB lists no episodes for this season'}${notAired ? ` · ${notAired} not aired yet` : ''}${noDate ? ` · ${noDate} without an air date` : ''}</div>`);
    // The explicit completion suggestion: a loaded, non-empty list with every listed episode checked.
    if (!locked && eps.length && done === eps.length) {
      const why = notAired || noDate
        ? ` TMDB lists ${eps.length} episode${eps.length === 1 ? '' : 's'}; ${[notAired ? `${notAired} ha${notAired === 1 ? 's' : 've'}n’t aired yet` : '', noDate ? `${noDate} ha${noDate === 1 ? 's' : 've'} no air date` : ''].filter(Boolean).join(' and ')}.` : '';
      parts.push(`<div class="ep-suggest">Every listed episode is checked.${esc(why)} ${seasonActionHtml('ep-complete', `<button type="button" class="watch-btn" onclick="toggleWatch('${idArg}')">Mark ${esc(r.season)} watched</button>`)}</div>`);
    }
    const items = eps.map(e => {
      const checked = marks.has(e.id);
      const showTitle = p.titles.has(e.id);
      const label = `Episode ${e.number}${showTitle && e.name ? `: ${e.name}` : ''}`;
      const through = !locked && eps.some(x => x.number <= e.number && !marks.has(x.id))
        ? seasonActionHtml(`ep-through-${e.id}`, `<button type="button" class="btn btn-link ep-through" aria-label="${esc(`Mark episodes 1 to ${e.number} of ${r.season} watched`)}" onclick="markEpisodesThrough('${idArg}', ${e.id})">Through here</button>`) : '';
      const title = e.name ? seasonActionHtml(`ep-title-${e.id}`, `<button type="button" class="btn btn-link ep-title" aria-expanded="${showTitle}" onclick="toggleEpisodeTitle('${idArg}', ${e.id})">${showTitle ? 'Hide title' : 'Title'}</button>`) : '';
      const date = e.air_date ? (e.air_date > today ? `<span class="ep-date">${esc(formatDisplayDate(e.air_date))}</span>` : '') : '<span class="ep-date">No air date</span>';
      return `<li class="ep-item${checked ? ' ep-checked' : ''}">${seasonActionHtml(`ep-${e.id}`, `<label class="ep-check"><input type="checkbox"${checked ? ' checked' : ''}${locked ? ' disabled' : ''} onchange="setEpisodeMark('${idArg}', ${e.id}, this.checked)"> <span>${esc(label)}</span></label>`)} ${date} ${title} ${through}</li>`;
    }).join('');
    if (items) parts.push(`<ul class="ep-list" aria-label="${esc(`Episodes of ${r.season}`)}">${items}</ul>`);
    // Marks kept for episodes the current list doesn't have: shown apart, never counted.
    const kept = [...marks.entries()].filter(([id]) => !listed.has(id)).sort((a, b) => a[1].episode_number - b[1].episode_number || a[0] - b[0]);
    if (kept.length) {
      parts.push(`<div class="ep-note">Marks for episodes TMDB no longer lists (kept; not counted):</div><ul class="ep-list ep-unlisted">${kept.map(([id, m]) =>
        `<li class="ep-item ep-checked">${seasonActionHtml(`ep-${id}`, `<label class="ep-check"><input type="checkbox" checked${locked ? ' disabled' : ''} onchange="setEpisodeMark('${idArg}', ${id}, this.checked)"> <span>${esc(`Episode ${m.episode_number} (no longer listed)`)}</span></label>`)}</li>`).join('')}</ul>`);
    }
  }
  const hooks = ` data-season-row="${esc(r.id)}"${opts.showOf ? ` data-show-of="${esc(opts.showOf)}"` : ''}`;
  const body = `<div class="ep-panel">${parts.join('')}</div>`;
  return card ? `<div class="card-subseason-row ep-panel-card"${hooks}>${body}</div>`
    : `<tr class="sub-row ep-panel-row"${hooks}><td style="padding-left:44px" colspan="${opts.colspan || 6}">${body}</td></tr>`;
}

// ── Changes ──
function setEpisodeMark(seasonId, episodeId, checked) {
  const ep = episodePanel && episodePanel.seasonId === seasonId ? episodePanel.episodes.find(e => e.id === episodeId) : null;
  const kept = marksOf(seasonId).get(episodeId);
  const number = ep ? ep.number : kept ? kept.episode_number : null;
  if (number == null) { renderTable(); return; }
  return setEpisodeMarks(seasonId, [{ tmdb_episode_id: episodeId, episode_number: number }], checked);
}
// Marks every listed episode up to this one that isn't marked yet (never clears one).
function markEpisodesThrough(seasonId, episodeId) {
  if (!episodePanel || episodePanel.seasonId !== seasonId || episodePanel.status !== 'ready') return;
  const target = episodePanel.episodes.find(e => e.id === episodeId);
  if (!target) return;
  const marks = marksOf(seasonId);
  const todo = episodePanel.episodes.filter(e => e.number <= target.number && !marks.has(e.id))
    .map(e => ({ tmdb_episode_id: e.id, episode_number: e.number }));
  if (todo.length) return setEpisodeMarks(seasonId, todo, true);
}

// One guarded change: the season's watched / skipped as shown are its expected values. Shown at
// once; the database's answer replaces the season's marks. A refusal puts back what was shown; no
// clear answer is never resent, and the view is read again (tv-shows.js reportStateFailure).
async function setEpisodeMarks(seasonId, episodes, watched) {
  const row = actionRows().find(r => r.id === seasonId);
  if (!isEpisodeTrackable(row) || row.watched || row.skipped || !episodes.length) { renderTable(); return; }
  const expected = { watched: !!row.watched, skipped: !!row.skipped };
  const what = episodes.length === 1 ? `episode ${episodes[0].episode_number}` : `${episodes.length} episodes`;
  await runWrite(`“${row.title}” · ${row.season} · ${what}`, async () => {
    const before = new Map(marksOf(seasonId));
    const shown = new Map(before);
    episodes.forEach(e => { if (watched) { if (!shown.has(e.tmdb_episode_id)) shown.set(e.tmdb_episode_id, { id: null, episode_number: e.episode_number }); } else shown.delete(e.tmdb_episode_id); });
    if (shown.size) episodeMarks.set(seasonId, shown); else episodeMarks.delete(seasonId);
    renderTable();
    try {
      const saved = await sbRpc('library_set_episode_marks', { p_season_id: seasonId, p_expected: expected, p_watched: watched,
        p_episodes: episodes.map(e => (watched ? { tmdb_episode_id: e.tmdb_episode_id, episode_number: e.episode_number } : { tmdb_episode_id: e.tmdb_episode_id })) });
      replaceSeasonMarks(seasonId, saved && saved.marks);
      showSaved();
    } catch (e) {
      if (before.size) episodeMarks.set(seasonId, before); else episodeMarks.delete(seasonId);
      if (orgErrorInfo(e).kind !== 'database') { await reportStateFailure(e); return; }
      showError(stateErrorText(e));
    }
    renderTable();
  }, { list: true });
}
