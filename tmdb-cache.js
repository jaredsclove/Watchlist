// ─── The member's TMDB cache across devices (TC1: item 2's ratings, item 13's Series premiere, EP1's episode lists) ───
// What TMDB says about a show (its score, vote count and first-air date) and a season (its episode list) is kept in the
// member's own cache in the database (public.tmdb_tv_cache, db/tc1_tmdb_cache.sql), so every device of the member shows the
// same "N/T episodes watched", next episode, rating and Series premiere without reading TMDB itself. It is the provider's data:
// replaceable, never in a backup, untouched by a restore, never changing a mark, Watched or Skipped.
// Reading: each view's read brings the whole cache with its rows and marks (readTmdbCache); a read that fails, or a database
// without the table, leaves what this page already holds and the library loads as before. Rows older than 150 days are
// ignored (the database deletes them daily; TMDB's API terms forbid caching for longer than six months).
// Writing: TMDB answers that the page reads (an opened Episodes list, Refresh shows, Add season, a preview, Match, an expanded
// show, the background queue) are shown at once from page memory (tmdbCacheFresh) and saved in short batches by the
// background queue, through the write lane (busy state shown, changes refused while it is held) and followed by the one reread
// path, like any change. A save never starts while the member is using the page (a recent click, tap, key or scroll; a text
// box with focus; a dialog open). Each row is saved with the revision this page saw before its TMDB request started; the
// database writes it only when that revision is still the stored one (protection against conflicting cache writes, not a
// freshness clock), and answers every row with what is stored now, which the page adopts. Revisions are never reused, so a
// row deleted and made again can't be overwritten by an old response.
// The background queue (no scheduled service: it runs while the page is open): after each view's read, the episode lists of
// seasons with marks and each Watching show's actionable up-next season, marks or not (in progress: missing or a day old;
// Watched with marks: 30 days) and the details of every TMDB-matched
// show (missing or a week old), in that order, at most 20 TMDB requests a batch, 4 at a time, a pause between batches.
// Bounded: two tries per item per page load (the second at least 30 seconds later); a 404 isn't tried again on this load;
// TMDB's Retry-After is honoured in full (waited for when it is a minute or less; otherwise the queue stops until a later
// read after that time); after three such pauses, or five failures in a row, or two failed saves, it stops for this load.

const TMDB_CACHE_TABLE = 'tmdb_tv_cache';
const TMDB_DAY_MS = 24 * 60 * 60 * 1000;
const TMDB_CACHE_LIMIT_MS = 150 * TMDB_DAY_MS;
const TMDB_REFRESH_MS = { inProgress: TMDB_DAY_MS, season: 30 * TMDB_DAY_MS, show: 7 * TMDB_DAY_MS };
const TMDB_QUEUE_LIMITS = { batch: 20, concurrency: 4, saveRows: 40, pauseMs: 1000, idleMs: 3000, retryMs: 30000, waitLimitMs: 60000,
  maxPauses: 3, maxFailuresInRow: 5, maxSaveFailures: 2, triesPerKey: 2, defaultRetryAfterMs: 120000, maxDataChars: 28000 };
// (maxDataChars: a row's data as JSON, kept well under the database's 40,000-byte limit on its jsonb text, which adds spaces and
// counts UTF-8 bytes. defaultRetryAfterMs: a 429 whose Retry-After can't be read is treated as a long wait, never retried early.)
const TMDB_SAVE_LABEL = 'The TMDB update';
// The per-device caches this replaces (removed for the signed-in member when the page opens; another member's when they sign in).
const SUPERSEDED_CACHE_KEYS = ['watchlist-episode-lists', 'watchlist-tmdb-show-ratings'];
// Time and waiting (the offline tests replace them).
let tmdbNow = () => Date.now();
let tmdbDelay = ms => new Promise(resolve => setTimeout(resolve, ms));

const tmdbShowKey = id => `show:${id}`;
const tmdbSeasonKey = (id, n) => `season:${id}:${n}`;
const tmdbKeyOfRow = r => (r.kind === 'show' ? tmdbShowKey(r.tmdb_id) : tmdbSeasonKey(r.tmdb_id, r.season_number));
function tmdbKeyParts(key) {
  const p = String(key).split(':');
  return p[0] === 'show' ? { kind: 'show', tmdb_id: Number(p[1]), season_number: -1 } : { kind: 'season', tmdb_id: Number(p[1]), season_number: Number(p[2]) };
}

function discardSupersededCaches() {
  SUPERSEDED_CACHE_KEYS.forEach(k => { try { if (userStorage.getItem(k) !== null) userStorage.removeItem(k); } catch (e) { /* storage unavailable */ } });
}

// ── Reading ──
async function readTmdbCache() {
  if (tmdbCacheAvailable === false) return { rows: null };
  try { return { rows: await fetchAllRows(TMDB_CACHE_TABLE) }; }
  catch (e) {
    if (/PGRST205/.test(String(e && e.message))) { tmdbCacheAvailable = false; return { rows: null }; } // a database without TC1
    console.error(e);
    return { rows: null, failed: true };
  }
}
// The saved cache as this read found it. An entry fetched here and not saved yet is kept only while the saved row is still the
// one it was fetched over; otherwise the saved row (another page's or device's) wins.
function publishTmdbCache(read) {
  if (!read || !read.rows) return;
  tmdbCacheAvailable = true;
  const next = new Map();
  read.rows.forEach(r => {
    if (!r || (r.kind !== 'show' && r.kind !== 'season') || !r.data || typeof r.data !== 'object' || r.rev == null) return;
    next.set(tmdbKeyOfRow(r), { rev: String(r.rev), data: r.data, at: Date.parse(r.fetched_at) || 0 });
  });
  tmdbCacheRows = next;
  tmdbCacheFresh.forEach((f, key) => {
    const row = next.get(key);
    if ((row ? row.rev : '0') !== f.base) { tmdbCacheFresh.delete(key); if (tmdbQueue) tmdbQueue.unsaved.delete(key); }
  });
}
// What the page knows for a key: this page's own reading first, else the saved row while it is within the age limit.
function tmdbEntry(key) {
  const f = tmdbCacheFresh.get(key);
  if (f) return f;
  const r = tmdbCacheRows.get(key);
  return r && tmdbNow() - r.at < TMDB_CACHE_LIMIT_MS ? r : null;
}

// ── TMDB answers ──
// api.js tmdbFetch records, before each show or season request starts, the revision this page holds for it; the answer carries it
// here (by object), so a save is based on what was known before the request, never on a revision read while it was running.
const tmdbResponseBases = new WeakMap();
function tmdbKeyOfPath(path) {
  let m = /^\/tv\/(\d+)\/season\/(\d+)(?:[?#]|$)/.exec(path);
  if (m) return tmdbSeasonKey(Number(m[1]), Number(m[2]));
  m = /^\/tv\/(\d+)(?:[?#]|$)/.exec(path);
  return m ? tmdbShowKey(Number(m[1])) : null;
}
function tmdbRequestBase(path) {
  const key = tmdbKeyOfPath(String(path || ''));
  if (!key) return null;
  const row = tmdbCacheRows.get(key);
  return { key, base: row ? row.rev : '0' };
}
function tmdbAnswerBase(answer, key) {
  const b = answer && typeof answer === 'object' ? tmdbResponseBases.get(answer) : null;
  return b && b.key === key ? b.base : null;
}
// A reading for a key: shown at once (page memory); saved by the queue when it came from a TMDB answer (base known) and save is
// true. Called by episodes.js (lists) and show-ratings.js (show details).
function noteTmdbData(key, data, base, save = true) {
  // A list too long for a row (a season of several hundred episodes) is saved without its titles; if still too long, kept on
  // this page only, so one such season never blocks the other saves.
  if (save && tmdbDataSize(data) > TMDB_QUEUE_LIMITS.maxDataChars && Array.isArray(data.names)) data = { ...data, names: [] };
  if (save && tmdbDataSize(data) > TMDB_QUEUE_LIMITS.maxDataChars) save = false;
  tmdbCacheFresh.set(key, { data, base: base == null ? null : String(base), at: tmdbNow() });
  const q = tmdbQueueFor();
  if (!q) return;
  if (save && base != null) { q.unsaved.add(key); kickTmdbQueue(); }
  else q.unsaved.delete(key);
}

// ── The background queue ──
function tmdbQueueFor() {
  const owner = typeof pageUser !== 'undefined' && pageUser ? pageUser.id : null;
  if (!owner || !tmdbQueueEnabled) return null;
  if (!tmdbQueue || tmdbQueue.owner !== owner) {
    tmdbQueue = { owner, wanted: new Map(), tries: new Map(), unavailable: new Set(), inFlight: new Set(), unsaved: new Set(), failuresInRow: 0,
      pauses: 0, blockedUntil: 0, saveFailures: 0, stopped: false, savingStopped: false, running: false, timer: null };
  }
  return tmdbQueue;
}
// A row's data size as the database counts it, roughly: UTF-8 bytes of its JSON.
function tmdbDataSize(data) {
  const text = JSON.stringify(data);
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length * 3;
}
const tmdbQueueLive = q => !!q && tmdbQueue === q && !q.stopped && tmdbQueueEnabled && typeof pageUser !== 'undefined' && !!pageUser && pageUser.id === q.owner;

// What the open library needs, from a view's read (rows: every library row the read returned; shows: tvShowsById).
function scheduleTmdbWork(rows) {
  const q = tmdbQueueFor();
  if (!q) return;
  const wanted = new Map();
  (rows || []).forEach(r => {
    if (!isEpisodeTrackable(r) || r.skipped || !episodeMarkCount(r.id)) return;
    const key = tmdbSeasonKey(r.tmdb_id, r.season_number), rank = r.watched ? 2 : 0, prev = wanted.get(key);
    if (!prev || rank < prev.rank) wanted.set(key, { rank, maxAge: r.watched ? TMDB_REFRESH_MS.season : TMDB_REFRESH_MS.inProgress });
  });
  // A Watching show's up-next season that its row acts on (episodes.js showTarget), marked or not: its list lets the row offer
  // the next episode (Mark E1 watched for a season not started), as for a season in progress.
  if (typeof deriveCurrentlyWatching === 'function') {
    deriveCurrentlyWatching(rows || [], tvShowsById, localTodayStr()).active.forEach(item => {
      const r = item.upNext;
      if (!r || item.upToDate || !item.upNextReleased || r.watched || r.skipped || !isEpisodeTrackable(r)) return;
      wanted.set(tmdbSeasonKey(r.tmdb_id, r.season_number), { rank: 0, maxAge: TMDB_REFRESH_MS.inProgress });
    });
  }
  tvShowsById.forEach(s => {
    if (s && s.tmdb_id != null && !wanted.has(tmdbShowKey(s.tmdb_id))) wanted.set(tmdbShowKey(s.tmdb_id), { rank: 1, maxAge: TMDB_REFRESH_MS.show });
  });
  q.wanted = wanted;
  kickTmdbQueue();
}
function tmdbKeyDue(q, key, w, now) {
  if (q.unavailable.has(key) || q.inFlight.has(key)) return false;
  const p = tmdbKeyParts(key);
  const e = tmdbEntry(key);
  if (e && now - e.at < w.maxAge) return false;
  const t = q.tries.get(key);
  return !(t && (t.n >= TMDB_QUEUE_LIMITS.triesPerKey || now < t.nextAt));
}
function tmdbDueKeys(q) {
  const now = tmdbNow();
  return [...q.wanted.entries()].filter(([key, w]) => tmdbKeyDue(q, key, w, now))
    .sort((a, b) => a[1].rank - b[1].rank || (tmdbEntry(a[0]) ? 1 : 0) - (tmdbEntry(b[0]) ? 1 : 0)).map(([key]) => key);
}
function kickTmdbQueue() {
  const q = tmdbQueueFor();
  if (!q || q.running || q.stopped) return;
  if (q.timer) { clearTimeout(q.timer); q.timer = null; }
  runTmdbQueue(q).catch(e => console.error(e));
}
async function runTmdbQueue(q) {
  q.running = true;
  try {
    for (;;) {
      if (!tmdbQueueLive(q)) return;
      const wait = q.blockedUntil - tmdbNow();
      if (wait > 0) {
        if (wait > TMDB_QUEUE_LIMITS.waitLimitMs) return; // deferred, never early: a later read after that time resumes it
        await tmdbDelay(wait);
        continue;
      }
      const due = tmdbDueKeys(q).slice(0, TMDB_QUEUE_LIMITS.batch);
      if (due.length) await tmdbFetchBatch(q, due);
      if (!tmdbQueueLive(q)) return;
      const canSave = !q.savingStopped && tmdbCacheAvailable !== false;
      if (q.unsaved.size && canSave) await tmdbSaveWhenIdle(q);
      else if (due.length) tmdbRedrawWhenIdle();
      if (!tmdbDueKeys(q).length && !(q.unsaved.size && canSave && !q.savingStopped)) break;
      await tmdbDelay(TMDB_QUEUE_LIMITS.pauseMs);
    }
  } finally {
    q.running = false;
  }
  tmdbWakeForRetry(q);
}
// An item waiting for its second try wakes the queue when it is due (a short, bounded wait).
function tmdbWakeForRetry(q) {
  if (!tmdbQueueLive(q) || q.timer) return;
  const now = tmdbNow();
  const next = [...q.wanted.keys()].map(k => q.tries.get(k)).filter(t => t && t.n < TMDB_QUEUE_LIMITS.triesPerKey && t.nextAt > now).map(t => t.nextAt);
  if (!next.length) return;
  q.timer = setTimeout(() => { q.timer = null; kickTmdbQueue(); }, Math.min(...next) - now);
}
function tmdbRetryAfterMs(e) {
  const v = e && e.retryAfter != null ? String(e.retryAfter).trim() : '';
  if (/^\d+$/.test(v)) return Math.max(1000, Number(v) * 1000);
  const at = v ? Date.parse(v) : NaN;
  if (Number.isFinite(at)) return Math.max(1000, at - Date.now());
  return TMDB_QUEUE_LIMITS.defaultRetryAfterMs;
}
async function tmdbFetchBatch(q, keys) {
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      if (!tmdbQueueLive(q) || q.blockedUntil > tmdbNow()) return;
      // (never more requests out than failures still allowed in a row, so the stop after five is exact)
      if (q.failuresInRow + q.inFlight.size >= TMDB_QUEUE_LIMITS.maxFailuresInRow) return;
      const key = keys[next++], p = tmdbKeyParts(key);
      q.inFlight.add(key);
      try {
        const d = await tmdbFetch(p.kind === 'show' ? `/tv/${p.tmdb_id}` : `/tv/${p.tmdb_id}/season/${p.season_number}`);
        if (!tmdbQueueLive(q)) return;
        q.failuresInRow = 0;
        q.tries.delete(key);
        if (p.kind === 'show') { noteSeasonEpisodeCounts(p.tmdb_id, d && d.seasons); noteShowRating(p.tmdb_id, d); }
        else noteEpisodeList(p.tmdb_id, p.season_number, cuEpisodes(d && d.episodes), d);
      } catch (e) {
        if (!tmdbQueueLive(q)) return;
        if (e && e.status === 429) {
          // TMDB asked to wait: the item isn't counted as tried; nothing is sent before the full interval has passed.
          q.blockedUntil = Math.max(q.blockedUntil, tmdbNow() + tmdbRetryAfterMs(e));
          if (++q.pauses > TMDB_QUEUE_LIMITS.maxPauses) q.stopped = true;
        } else if (e && e.status === 404) q.unavailable.add(key); // TMDB has nothing for it: not asked again on this load
        else {
          const t = q.tries.get(key) || { n: 0, nextAt: 0 };
          t.n++; t.nextAt = tmdbNow() + TMDB_QUEUE_LIMITS.retryMs;
          q.tries.set(key, t);
          if (t.n >= TMDB_QUEUE_LIMITS.triesPerKey) q.unavailable.add(key);
          if (++q.failuresInRow >= TMDB_QUEUE_LIMITS.maxFailuresInRow) q.stopped = true;
        }
      } finally {
        q.inFlight.delete(key);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TMDB_QUEUE_LIMITS.concurrency, keys.length) }, worker));
}

// ── Saving, while the page isn't being used ──
function tmdbPageIdle() {
  if (writeLane || listRereading) return false;
  if (manage || cuModal || addPicker || libraryPanel || detailsDialog || resumePickerFor || queueAdd || queueDrag || pendingRestoreData
    || gamesAdd || gamesCollectionAdd || gamesCollectionEdit || gamesDialogOpener // (Details and Review are open only in Games, below)
    || (typeof window !== 'undefined' && window.__tmdbMatch)) return false;
  if (typeof isGamesView === 'function' && isGamesView()) return false; // (nothing of the cache is shown there; saved after leaving)
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(String(a.tagName || '').toUpperCase()) || a.isContentEditable === true)) return false;
  return tmdbNow() - tmdbLastInput >= TMDB_QUEUE_LIMITS.idleMs;
}
async function tmdbWaitForIdle(q) {
  for (;;) {
    if (!tmdbQueueLive(q)) return false;
    if (tmdbPageIdle()) return true;
    await tmdbDelay(TMDB_QUEUE_LIMITS.pauseMs);
  }
}
async function tmdbSaveWhenIdle(q) {
  if (!(await tmdbWaitForIdle(q)) || q.savingStopped) return;
  const keys = [...q.unsaved].filter(k => { const f = tmdbCacheFresh.get(k); if (!f || f.base == null) { q.unsaved.delete(k); return false; } return true; })
    .slice(0, TMDB_QUEUE_LIMITS.saveRows);
  if (!keys.length) return;
  const sent = new Map(keys.map(k => [k, tmdbCacheFresh.get(k)]));
  const rows = keys.map(k => ({ ...tmdbKeyParts(k), data: sent.get(k).data, base_rev: Number(sent.get(k).base) }));
  let failed = false;
  // (checked idle in this same turn, so the lane is free: never refused with a message)
  await runWrite(TMDB_SAVE_LABEL, async () => {
    let answer;
    try { answer = await sbRpc('library_tmdb_cache_put', { p_rows: rows }, { cache: true }); }
    catch (e) {
      console.error(e); failed = true;
      // Refused by the database (a confirmed answer): these rows aren't sent again on this load, so they can't block later
      // saves; they stay shown from this page's memory. No answer: they stay queued for one more save.
      if (writeOutcomeOf(e) === 'refused') keys.forEach(k => q.unsaved.delete(k));
      return;
    }
    if (!tmdbQueueLive(q)) return;
    tmdbAdoptAnswer(q, answer, sent);
    await reloadOpenView();
  });
  if (failed && ++q.saveFailures >= TMDB_QUEUE_LIMITS.maxSaveFailures) q.savingStopped = true;
}
// The database's answer: what is stored now for every row sent, written or not.
function tmdbAdoptAnswer(q, answer, sent) {
  ((answer && answer.rows) || []).forEach(x => {
    const key = tmdbKeyOfRow(x), f = sent.get(key);
    if (!f) return;
    if (x.rev == null) {
      tmdbCacheRows.delete(key);
      // Based on a row that no longer exists (deleted since): saved once more as a new row.
      if (tmdbCacheFresh.get(key) === f && f.base !== '0' && !f.again) { f.base = '0'; f.again = true; return; }
    } else tmdbCacheRows.set(key, { rev: String(x.rev), data: x.data, at: Date.parse(x.fetched_at) || tmdbNow() });
    if (tmdbCacheFresh.get(key) === f) tmdbCacheFresh.delete(key);
    q.unsaved.delete(key);
  });
}
// Without a saved cache (or once saving has stopped) the queue's readings are drawn when the page isn't being used.
async function tmdbRedrawWhenIdle() {
  const q = tmdbQueue;
  if (q && (await tmdbWaitForIdle(q)) && typeof renderTable === 'function' && !(typeof isGamesView === 'function' && isGamesView())) renderTable();
}

// A season the queue would still read, or has given up on for this load (episodes.js progress text).
function tmdbSeasonWaiting(r) {
  const q = tmdbQueue;
  if (!q || !isEpisodeTrackable(r)) return null;
  const key = tmdbSeasonKey(r.tmdb_id, r.season_number);
  if (!q.wanted.has(key) || tmdbEntry(key)) return null;
  return q.unavailable.has(key) || q.stopped || !tmdbQueueEnabled ? 'unavailable' : 'loading';
}

// Clicks, taps, keys and scrolling postpone a save for a moment.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  ['pointerdown', 'pointermove', 'keydown', 'input', 'wheel', 'touchmove'].forEach(t => document.addEventListener(t, () => { tmdbLastInput = tmdbNow(); }, { capture: true, passive: true }));
}
