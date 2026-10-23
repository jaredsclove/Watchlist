// ─── Collection updates (item 4, CU1): shared rules, Refresh shows, results and review ──
// Design: docs/ITEM4_DESIGN.md. The database decides and enforces (db/cu1_collection_updates.sql):
// every change goes through a library_cu_* function that re-reads the current library under lock,
// applies its rules (holds, exclusions, setup, Skipped, expected values, evidence structure for
// research) and records its finding's outcome in the same transaction. The page reads, proposes,
// routes and reports.
// Refresh shows is library-wide and TMDB only: every TMDB-matched show (catalog and collection
// shows included; Skipped shows only when followed), new seasons reconciled with the stored rows,
// TBA and future dates, full episode lists (this device's cache), and unmatched shows matched when
// the match is unambiguous. Announcements come from research briefs (collection-research.js).
// Page state: cuShowSettings, cuModal (watchlist.html).

const CU_OPEN_STATUSES = ['pending', 'needs_evidence', 'conflict', 'needs_research'];
const CU_TBA_SORT = '2099-01-01';
const CU_REASON_TEXT = {
  setup_required: 'automatic updates for catalog shows wait for the collection setup (Settings → Collection updates)',
  ambiguous_correspondence: 'a stored season may already be this one (a different or second label), so it needs your choice',
  key_conflict: 'a stored season already uses this season’s label',
  tmdb_season_elsewhere: 'TMDB’s season is already on another show in your list',
  tmdb_undated_empty: 'TMDB lists it without a date or episodes, so it waits for announcement evidence',
  date_needs_review: 'it changes a date that has already aired, or a window',
  protected_value: 'this date is protected',
  standing_decision: 'a standing decision covers it',
  identity_hold: 'a matching hold covers this show',
  title_differs: 'TMDB’s title isn’t the show’s title or an evidenced alias',
  nonstandard_labels: 'the show has a season label that isn’t a plain “Season N”',
  tmdb_taken: 'another show in your list already has this TMDB identity',
  possible_match: 'TMDB has a possible match that doesn’t meet every rule for matching automatically',
  skipped: 'the show is Skipped',
  no_definition: 'the collection has no confirmed definition',
  collection_manual: 'the collection is now Manual',
  collection_not_discovering: 'the collection no longer discovers new titles',
  removed_from_collection: 'you removed it from the collection',
  not_in_collection: 'it is no longer in the collection',
  rule_removed: 'the rule it was researched under was removed',
  rule_changed: 'the collection’s rule changed since it was researched, so it needs fresh research',
  evidence_rules_changed: 'the collection’s evidence settings changed since it was researched, so it needs fresh research',
  excluded: 'it is excluded from the collection',
  conflict: 'the sources conflict',
  evidence_insufficient: 'the evidence doesn’t meet the standard (an official announcement or two independent trades)',
  evidence_incomplete: 'the evidence is incomplete',
  evidence_below_standard: 'the evidence doesn’t meet the standard (an official announcement or two independent trades)',
  evidence_named_source_missing: 'the decision reopens only on a named source, which isn’t among the evidence',
  record_missing: 'the record it names is no longer in your library'
};
const cuReasonText = r => CU_REASON_TEXT[r] || (r ? r.replace(/_/g, ' ') : '');

// ── Shared rules (the database's private.cu1_norm and private.cu1_evidence_ok, for routing) ──
function cuNorm(t) {
  return String(t || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');
}
async function cuSha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function cuFingerprint(kind, parts) {
  return `${kind}:${await cuSha256(JSON.stringify(parts))}`;
}
function cuHost(url) {
  const m = /^https:\/\/([^/:?#]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase().replace(/^www\./, '') : null;
}
function cuHostIn(host, domains) {
  return !!host && (domains || []).some(d => host === d || host.endsWith(`.${d}`));
}
function cuDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null;
}
const cuToday = () => new Date().toISOString().slice(0, 10);
// The structure and policy of a finding's evidence (never its content, which is Claude's assessment):
// null when it meets the standard, else the reason. after: published after that day; named: only an
// official source on these domains counts.
function cuEvidenceProblem(evidence, assessment, settings, after = null, named = null) {
  const a = assessment || {};
  if (a.conflict === true) return 'conflict';
  if (!['official', 'two_trades'].includes(a.standard)) return 'evidence_insufficient';
  const on = cuDate(a.researched_on);
  if (!on || !Array.isArray(evidence)) return 'evidence_incomplete';
  const dated = e => { const d = cuDate(e && e.published_on); return d && d <= on && (!after || d > after); };
  const official = evidence.some(e => e && e.source_type === 'official' && dated(e) && cuHostIn(cuHost(e.url), named || (settings && settings.official_domains)));
  if (named) return official ? null : 'evidence_named_source_missing';
  const trades = new Set(evidence.filter(e => e && e.source_type === 'trade' && (e.attribution || 'original') === 'original' && dated(e))
    .map(e => ((settings && settings.trades) || []).find(t => t.id === e.outlet && cuHostIn(cuHost(e.url), t.domains)))
    .filter(Boolean).map(t => t.id));
  return official || trades.size >= 2 ? null : 'evidence_below_standard';
}

// ── Reading the collection-updates state ──
async function cuReadState() {
  const [setup, defs, exclusions, holds, aliases, settings, findings, memberships, removals] = await Promise.all([
    fetchAllRowsStrict('update_setup'), fetchAllRowsStrict('collection_definitions'), fetchAllRowsStrict('collection_exclusions'),
    fetchAllRowsStrict('update_holds'), fetchAllRowsStrict('record_aliases'), fetchAllRowsStrict('show_update_settings'),
    fetchAllRowsStrict('update_findings'), fetchAllRowsStrict('collection_memberships'), fetchAllRowsStrict('membership_removals')]);
  const definitions = new Map();
  defs.forEach(d => { const c = definitions.get(d.collection_id); if (!c || d.version > c.version) definitions.set(d.collection_id, d); });
  cuPublishShowSettings(settings);
  cuLastState = { setup: setup.length > 0, open: findings.filter(f => CU_OPEN_STATUSES.includes(f.status)).length };
  if (typeof updateCuSettingsStatus === 'function') updateCuSettingsStatus(); // Settings' status line, if it is shown
  return { setup: setup[0] || null, definitions, allDefinitions: defs, exclusions, holds, aliases,
    settings: new Map(settings.map(s => [s.show_id, s])), findings, memberships, removals };
}
const cuAliasesOf = (st, showId, itemId) => st.aliases.filter(a => (showId && a.show_id === showId) || (itemId && a.item_id === itemId)).map(a => a.alias);

// The per-show settings, read with each view (the "New season" flag on Ended shows).
async function readShowUpdateSettings(strict) {
  return strict ? fetchAllRowsStrict('show_update_settings') : fetchAllRows('show_update_settings');
}
function cuPublishShowSettings(rows) {
  cuShowSettings = new Map((rows || []).map(s => [s.show_id, s]));
}
function cuEndedFlagHtml(show) {
  const st = show && cuShowSettings.get(show.id);
  return st && st.new_season_after_ended_at
    ? ' <span class="state-tag cu-flag-tag" title="A new season was added after you marked this show ended (Settings → Collection updates clears it)">New season</span>' : '';
}

// The anchors a show's collections give matching: TMDB person ids (creator rules), TMDB network ids
// (platform rules), and accepted findings' network and creator names.
function cuAnchorsFor(st, show) {
  const colls = st.memberships.filter(m => m.show_id === show.id).map(m => m.collection_id);
  const people = new Set(), networks = new Set(), names = new Set();
  colls.forEach(c => ((st.definitions.get(c) || {}).rules || []).forEach(r => {
    if (r.type === 'person_role' && r.person_tmdb_id && (r.series_roles || []).some(x => ['creator', 'co_creator', 'showrunner'].includes(x))) people.add(r.person_tmdb_id);
    if (r.type === 'platform_premiere' && r.platform_tmdb_network_id) networks.add(r.platform_tmdb_network_id);
  }));
  st.findings.filter(f => f.show_id === show.id && f.status === 'accepted').forEach(f => {
    const a = (f.subject && f.subject.anchors) || {};
    if (a.network) names.add(cuNorm(a.network));
    (a.people || []).forEach(p => p && p.name && names.add(cuNorm(p.name)));
  });
  if (show.network) names.add(cuNorm(show.network));
  return { people, networks, names };
}
// A record's year: its earliest exact date, else a year written in a TBA window ("TBA 2027"), else null.
function cuRecordYear(rows) {
  const exact = rows.map(r => cuDate(r.date_sort)).filter(d => d && d < CU_TBA_SORT).sort();
  if (exact.length) return Number(exact[0].slice(0, 4));
  const w = rows.map(r => (String(r.display_date || '').match(/\b(19|20)\d{2}\b/) || [])[0]).filter(Boolean).sort();
  return w.length ? Number(w[0]) : null;
}
function cuEpisodes(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter(e => e && Number.isInteger(e.id) && e.id > 0 && Number.isInteger(e.episode_number) && e.episode_number >= 0 && !seen.has(e.id) && seen.add(e.id))
    .map(e => ({ id: e.id, number: e.episode_number, name: typeof e.name === 'string' ? e.name : '' }))
    .sort((a, b) => a.number - b.number || a.id - b.id);
}

// ── Results ──
function cuEmptyResults(source) {
  return { source, checked: 0, matched: 0, unmatched: 0, skipped: 0, applied: [], review: [], failed: [], setAside: [], episodes: [], unknown: null, laneRefused: null };
}
function cuResultsHtml(r) {
  const li = items => items.map(x => `<li>${esc(x)}</li>`).join('');
  const coverage = r.source === 'tmdb'
    ? `TMDB only: announcements weren’t checked. Checked ${r.checked} show${r.checked === 1 ? '' : 's'} (${r.matched} matched to TMDB, ${r.unmatched} not yet matched)${r.skipped ? `; ${r.skipped} Skipped show${r.skipped === 1 ? '' : 's'} not checked` : ''}.`
    : `From the imported research file: ${r.checked} finding${r.checked === 1 ? '' : 's'}. Evidence was assessed in Claude research; links are kept with each finding.`;
  const episodes = r.episodes.map(e => `${e.title} · ${e.season}: ${e.added} new episode${e.added === 1 ? '' : 's'} listed (this device)`);
  const auto = r.applied.concat(episodes);
  const notChecked = r.failed.concat(r.setAside);
  return `<div class="cu-results">
    <p class="cu-coverage">${esc(coverage)}</p>
    ${r.unknown ? `<div class="error-banner">⚠️ ${esc(r.unknown)}</div>` : ''}
    ${r.laneRefused ? `<div class="error-banner">⚠️ ${esc(r.laneRefused)}</div>` : ''}
    <h4 class="cu-results-head">Automatic updates (${auto.length})</h4>${auto.length ? `<ul class="cu-list">${li(auto)}</ul>` : '<p class="cu-none">None.</p>'}
    <h4 class="cu-results-head">Needs review (${r.review.length})</h4>${r.review.length ? `<ul class="cu-list">${li(r.review)}</ul>
      <div class="settings-actions"><button class="btn" onclick="openCuReview(this)">Review…</button></div>` : '<p class="cu-none">None.</p>'}
    <h4 class="cu-results-head">Couldn’t check or apply (${notChecked.length})</h4>${notChecked.length ? `<ul class="cu-list">${li(notChecked)}</ul>` : '<p class="cu-none">None.</p>'}
  </div>`;
}

// What one applying call's answer means for the results.
function cuRecordOutcome(op, res, results) {
  if (!res || typeof res !== 'object') { results.failed.push(`${op.what}: the answer couldn’t be read; check the list`); return; }
  const why = cuReasonText(res.reason);
  if (res.outcome === 'applied') {
    const o = (res.result || {}).outcome;
    results.applied.push(op.type === 'season' ? `${op.what}: ${o === 'mapped' ? 'matched to the season already on your list' : o === 'created' ? 'added' : 'already on your list'}${(res.result || {}).ended_flagged ? ' (the show stays marked ended; flagged)' : ''}`
      : op.type === 'date' ? `${op.what}: date set to ${op.newDate.display_date}`
      : op.type === 'identity' ? `${op.what}: matched to TMDB${(res.result || {}).unidentified && res.result.unidentified.length ? ` (${res.result.unidentified.length} season${res.result.unidentified.length === 1 ? '' : 's'} still awaiting TMDB)` : ''}`
      : op.type === 'alias' ? `${op.what}: “${op.alias}” recorded as another title (the title shown is unchanged)`
      : op.what);
  } else if (res.outcome === 'already' || res.outcome === 'not_pending') {
    if (res.outcome === 'not_pending' && CU_OPEN_STATUSES.includes(res.status)) results.review.push(`${op.what}: ${cuReasonText(res.reason) || 'waits for review'}`);
  } else if (res.outcome === 'policy') {
    if (res.status === 'set_aside' || res.status === 'excluded') results.setAside.push(`${op.what}: not applied — ${why}`);
    else results.review.push(`${op.what}: ${why}`);
  }
}

// One applying call per operation, in order, through the write lane; an unclear answer stops sending
// anything more (never resent: the next check reads the finding and the library again).
async function cuApplyPlan(plan, results, label) {
  if (!plan.length) return;
  const lane = beginWrite(label);
  if (!lane) { results.laneRefused = LANE_BUSY_TEXT(writeLane ? writeLane.label : label); return; }
  let confirmed = 0;
  try {
    for (const op of plan) {
      let res;
      try { res = await sbRpc(op.fn, op.args); }
      catch (e) {
        const fl = libraryFailure(e, op.what, 'Collection updates');
        if (fl.unknown) { results.unknown = `${fl.text} Nothing more was sent.`; break; }
        results.failed.push(`${op.what}: ${fl.text}`);
        continue;
      }
      if (res && res.outcome === 'applied') confirmed++;
      cuRecordOutcome(op, res, results);
    }
    if (confirmed) showSaved();
    if (activeViewId) await Promise.allSettled([reloadOpenView()]);
  } finally {
    endWrite(lane);
  }
}

// ── Refresh shows (TMDB, library-wide) ──
async function cuRefreshShows() {
  const p = libraryPanel;
  if (!p || p.mode !== 'refresh') return;
  const session = p.session;
  cancelTMDBPreview();
  const out = document.getElementById('tmdbPreview');
  if (out) out.innerHTML = '<div class="tmdb-loading">Checking every show with TMDB…</div>';
  let lib, st;
  try { [lib, st] = await Promise.all([readLibrary(), cuReadState()]); }
  catch (e) { if (libraryLive(session) && out) out.innerHTML = `<div class="tmdb-no-results">Couldn’t read your whole list (${esc(e.message)}). Nothing was checked.</div>`; return; }
  if (!libraryLive(session)) return;
  p.lib = lib;
  const results = cuEmptyResults('tmdb');
  const plan = [];
  const shows = lib.shows.slice().sort((a, b) => compareTitles(a.title, b.title) || cmpStr(a.id, b.id));
  for (const show of shows) {
    if (show.status === 'skipped' && !(st.settings.get(show.id) || {}).follow_when_skipped) { results.skipped++; continue; }
    results.checked++;
    if (show.tmdb_id != null) { results.matched++; await cuCheckMatchedShow(show, lib, plan, results); }
    else { results.unmatched++; await cuCheckUnmatchedShow(show, lib, st, plan, results); }
    if (!libraryLive(session)) return;
  }
  await cuApplyPlan(plan, results, 'Refresh shows');
  const el = document.getElementById('tmdbPreview');
  if (libraryLive(session) && el) el.innerHTML = cuResultsHtml(results);
  else showNotice(`Refresh shows: ${results.applied.length} automatic update${results.applied.length === 1 ? '' : 's'}, ${results.review.length} to review, ${results.failed.length} couldn’t be checked.`);
  if (libraryLive(session)) libraryLoad(session);
  return results;
}

async function cuCheckMatchedShow(show, lib, plan, results) {
  let details;
  try { details = await tmdbFetch(`/tv/${show.tmdb_id}`); }
  catch (e) { results.failed.push(`${show.title}: TMDB didn’t answer, so it wasn’t checked`); return; }
  noteShowRating(show.tmdb_id, details); // item 2 (show-ratings.js)
  const seasons = (details.seasons || []).filter(s => s && Number.isInteger(s.season_number) && (tmdbShowSpecials || s.season_number !== 0));
  const rows = lib.rows.filter(r => r.show_id === show.id);
  // Full episode lists from TMDB's season details (one documented request per season), only for a stored
  // season still to watch whose cached list doesn't match TMDB's episode count (marks are never touched).
  const lists = new Map();
  for (const s of seasons) {
    const stored = rows.find(r => r.media_type === 'tv' && r.tmdb_id === show.tmdb_id && r.season_number === s.season_number);
    if (!stored || stored.watched || stored.skipped) continue;
    const cached = cachedEpisodeList(stored) || {};
    if (Array.isArray(cached.ids) && Number.isInteger(s.episode_count) && cached.ids.length === s.episode_count) continue;
    try { const sd = await tmdbFetch(`/tv/${show.tmdb_id}/season/${s.season_number}`); if (sd) lists.set(s.season_number, { sd, before: cached }); }
    catch (e) { results.failed.push(`${show.title} · ${stored.season}: TMDB’s episode list didn’t load, so it wasn’t refreshed`); }
  }
  noteSeasonEpisodeCounts(show.tmdb_id, seasons); // the other seasons' counts, from the show details
  const today = cuToday();
  for (const s of seasons) {
    const got = lists.get(s.season_number), sd = got && got.sd;
    const air = cuDate(s.air_date) || cuDate(sd && sd.air_date);
    const stored = rows.find(r => r.media_type === 'tv' && r.tmdb_id === show.tmdb_id && r.season_number === s.season_number);
    if (sd) {
      const episodes = cuEpisodes(sd.episodes);
      const before = got.before;
      noteEpisodeList(show.tmdb_id, s.season_number, episodes);
      if (stored && Array.isArray(before.ids)) {
        const added = episodes.filter(e => !before.ids.includes(e.id)).length;
        if (added) results.episodes.push({ title: show.title, season: stored.season, added });
      } else if (stored && Number.isInteger(before.count) && episodes.length > before.count) {
        results.episodes.push({ title: show.title, season: stored.season, added: episodes.length - before.count });
      }
    }
    const label = s.season_number === 0 ? 'Specials' : `Season ${s.season_number}`;
    if (stored) {
      // Only a TBA or a future date is checked; aired dates aren't re-checked routinely.
      const tba = /tba/i.test(stored.display_date);
      const future = !tba && cuDate(stored.date_sort) && stored.date_sort > today;
      if (air && (tba || (future && air > today)) && (stored.date_sort !== air || stored.display_date !== formatDisplayDate(air))) {
        const newDate = { display_date: formatDisplayDate(air), date_sort: air };
        plan.push({ type: 'date', fn: 'library_cu_set_season_date', what: `${show.title} · ${stored.season}`, newDate,
          args: { p_row_id: stored.id, p_expected: { display_date: stored.display_date, date_sort: stored.date_sort }, p_new: newDate,
            p_finding: { source: 'tmdb', kind: 'date', fingerprint: await cuFingerprint('date', ['date', stored.id, stored.display_date, stored.date_sort, newDate.display_date, air]),
              show_id: show.id, season_id: stored.id, subject: { title: show.title, season: stored.season }, proposed: newDate,
              expected: { display_date: stored.display_date, date_sort: stored.date_sort } }, p_review: false } });
      }
      continue;
    }
    const season = { season_number: s.season_number, display_date: air ? formatDisplayDate(air) : 'TBA', date_sort: air || CU_TBA_SORT,
      episode_count: Number.isInteger(s.episode_count) ? s.episode_count : 0 };
    plan.push({ type: 'season', fn: 'library_cu_reconcile_season', what: `${show.title} · ${label}`,
      args: { p_show_id: show.id, p_expected: { tmdb_id: show.tmdb_id, show_key: show.show_key }, p_season: season,
        p_finding: { source: 'tmdb', kind: 'new_season', fingerprint: await cuFingerprint('new_season', ['new_season', show.id, show.tmdb_id, s.season_number]),
          show_id: show.id, subject: { title: show.title, season_number: s.season_number, label }, proposed: season,
          expected: { tmdb_id: show.tmdb_id, show_key: show.show_key } }, p_review: false, p_row_id: null } });
  }
}

// An unmatched show: matched automatically only when exactly one TMDB result has its title or an
// evidenced alias and a first-air year within a year of its own, and an anchor agrees (network or a
// credited creator). A possible match that misses a test is held for review; nothing is applied.
async function cuCheckUnmatchedShow(show, lib, st, plan, results) {
  const rows = lib.rows.filter(r => r.show_id === show.id);
  const names = [show.title, ...cuAliasesOf(st, show.id, null)];
  const wanted = new Set(names.map(cuNorm).filter(Boolean));
  const found = new Map();
  for (const n of [...new Map(names.map(x => [cuNorm(x), x])).values()]) {
    try { const r = await tmdbFetch(`/search/tv?query=${encodeURIComponent(n)}`); (r && r.results || []).forEach(c => c && Number.isInteger(c.id) && found.set(c.id, c)); }
    catch (e) { results.failed.push(`${show.title}: TMDB didn’t answer, so no match was looked for`); return; }
  }
  const titled = [...found.values()].filter(c => wanted.has(cuNorm(c.name)) || wanted.has(cuNorm(c.original_name)));
  if (!titled.length) return;
  const year = cuRecordYear(rows);
  const dated = titled.filter(c => {
    const y = cuDate(c.first_air_date) ? Number(c.first_air_date.slice(0, 4)) : null;
    return (y == null && year == null) || (y != null && year != null && Math.abs(y - year) <= 1);
  });
  const note = async (reason, candidates) => plan.push({ type: 'note', fn: 'library_cu_note_finding', what: show.title,
    args: { p_finding: { source: 'tmdb', kind: 'identity', fingerprint: await cuFingerprint('identity', ['identity', show.id, 'candidates', candidates.map(c => c.id).sort()]),
      show_id: show.id, subject: { title: show.title, candidates: candidates.slice(0, 8).map(c => ({ tmdb_id: c.id, name: c.name, first_air_date: c.first_air_date || null })) } },
      p_reason: reason } });
  if (dated.length !== 1) { await note('possible_match', titled); return; }
  const c = dated[0];
  let details;
  try { details = await tmdbFetch(`/tv/${c.id}`); }
  catch (e) { results.failed.push(`${show.title}: TMDB’s details for a possible match didn’t load`); return; }
  const anchors = cuAnchorsFor(st, show);
  const anchorOk = (details.networks || []).some(n => anchors.networks.has(n.id) || anchors.names.has(cuNorm(n.name)))
    || (details.created_by || []).some(p => anchors.people.has(p.id) || anchors.names.has(cuNorm(p.name)));
  if (!anchorOk) { await note('possible_match', [c]); return; }
  const listed = (details.seasons || []).map(s => s && s.season_number).filter(n => Number.isInteger(n) && n > 0);
  plan.push({ type: 'identity', fn: 'library_cu_attach_identity', what: show.title,
    args: { p_show_id: show.id, p_expected: { title: show.title, show_key: show.show_key }, p_tmdb_id: c.id, p_listed: listed,
      p_finding: { source: 'tmdb', kind: 'identity', fingerprint: await cuFingerprint('identity', ['identity', show.id, c.id]), show_id: show.id,
        subject: { title: show.title, tmdb_id: c.id, tmdb_title: c.name, listed } }, p_review: false } });
}

// ── Review ──
async function openCuReview(opener) {
  cuModal = { kind: 'review', session: (cuModal && cuModal.session || 0) + 1, opener: opener || null, state: 'loading', message: '' };
  cuRenderModal();
  const session = cuModal.session;
  try {
    const [lib, st, colls] = await Promise.all([readLibrary(), cuReadState(), readPersonalCollections()]);
    if (!cuModal || cuModal.session !== session) return;
    Object.assign(cuModal, { state: 'ready', lib, st, colls });
  } catch (e) {
    if (!cuModal || cuModal.session !== session) return;
    Object.assign(cuModal, { state: 'failed', message: e.message });
  }
  cuRenderModal();
}
// Focus goes back to the button that opened the dialog, or to its redrawn equivalent on Settings.
const CU_OPENER_CLASS = { review: 'settings-cu-review', collections: 'settings-cu-collections', editor: 'settings-cu-collections', brief: 'settings-cu-brief',
  setup: 'settings-cu-setup', message: 'settings-cu-findings' };
function closeCuModal() {
  const opener = cuModal && cuModal.opener, kind = cuModal && cuModal.kind;
  cuModal = null;
  const o = document.getElementById('cuModalOverlay'), b = document.getElementById('cuModalBox');
  if (b) b.innerHTML = '';
  if (o) o.style.display = 'none';
  returnDialogFocus(opener, CU_OPENER_CLASS[kind] ? () => document.querySelector(`#settingsScreen .${CU_OPENER_CLASS[kind]}`) : null);
}
function cuModalKeydown(event) {
  dialogKeydown(event, document.getElementById('cuModalBox'), 'button, input, select, textarea, a[href]', closeCuModal);
}
function cuRenderModal() {
  const o = document.getElementById('cuModalOverlay'), b = document.getElementById('cuModalBox');
  if (!o || !b || !cuModal) return;
  o.style.display = 'flex';
  if (cuModal.kind === 'review') b.innerHTML = cuReviewHtml();
  else if (typeof cuSettingsModalHtml === 'function') b.innerHTML = cuSettingsModalHtml();
}
function cuRecordTitle(lib, f) {
  const show = f.show_id && lib.showsById.get(f.show_id);
  const row = (f.season_id || f.item_id) && lib.rows.find(r => r.id === (f.season_id || f.item_id));
  return (show && show.title) || (row && row.title) || (f.subject && f.subject.title) || 'A finding';
}
function cuEvidenceHtml(f) {
  const ev = Array.isArray(f.evidence) ? f.evidence : [];
  if (!ev.length) return f.source === 'tmdb' ? '<div class="cu-evidence">Source: TMDB</div>' : '';
  return `<div class="cu-evidence">Evidence (assessed in Claude research${f.assessment && f.assessment.researched_on ? ` on ${esc(f.assessment.researched_on)}` : ''}):
    ${ev.slice(0, 6).map(e => `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.publisher || cuHost(e.url) || 'source')}</a>${e.published_on ? ` (${esc(e.published_on)})` : ''}`).join(' · ')}</div>`;
}
function cuFindingSentence(lib, f) {
  const t = cuRecordTitle(lib, f), s = f.subject || {}, p = f.proposed || {};
  switch (f.kind) {
    case 'new_season': return `${t}: ${s.label || (s.season_number != null ? `Season ${s.season_number}` : 'a new season')}${p.display_date ? ` (${p.display_date})` : ''}`;
    case 'date': return `${t} · ${s.season || ''}: date ${f.expected && f.expected.display_date ? `${f.expected.display_date} → ` : ''}${p.display_date || ''}`;
    case 'identity': return s.tmdb_id ? `${t}: match to TMDB “${s.tmdb_title || s.tmdb_id}”` : `${t}: possible TMDB matches`;
    case 'alias': return `${t}: also titled “${p.alias || ''}”`;
    case 'new_show': return `New show: ${s.title || ''}`;
    case 'new_film': return `New film: ${s.title || ''}`;
    case 'cancellation': return `${t}: reported cancelled or shelved`;
    default: return t;
  }
}
function cuReviewHtml() {
  const m = cuModal;
  if (m.state === 'loading') return `<div class="modal-title" id="cuTitle">Review collection updates</div><div class="modal-progress">Reading…</div>`;
  if (m.state === 'failed') return `<div class="modal-title" id="cuTitle">Review collection updates</div><div class="modal-error">Couldn’t read the findings (${esc(m.message)}). Nothing was changed.</div>
    <div class="modal-actions"><button class="btn" onclick="closeCuModal()">Close</button></div>`;
  const open = m.st.findings.filter(f => CU_OPEN_STATUSES.includes(f.status)).sort((a, b) => cmpStr(a.first_seen_at, b.first_seen_at) || cmpStr(a.id, b.id));
  const flagged = m.lib.shows.filter(s => (m.st.settings.get(s.id) || {}).new_season_after_ended_at);
  const items = open.map(f => `<li class="cu-item" data-finding="${esc(f.id)}">
      <div class="cu-item-text">${esc(cuFindingSentence(m.lib, f))}</div>
      <div class="cu-item-why">${esc(f.status === 'pending' ? (cuReasonText(f.reason) || 'waits for your decision') : cuReasonText(f.reason) || f.status.replace(/_/g, ' '))}</div>
      ${cuEvidenceHtml(f)}
      <div class="cu-item-actions">${cuReviewActionsHtml(m, f)}</div></li>`).join('');
  return `<div class="modal-title" id="cuTitle">Review collection updates</div>
    ${m.message ? `<div class="${m.messageError ? 'modal-error' : 'banner'}">${esc(m.message)}</div>` : ''}
    ${open.length ? `<ul class="cu-review-list">${items}</ul>` : '<p class="settings-text">Nothing waits for review.</p>'}
    ${flagged.length ? `<div class="modal-label">New seasons after Ended</div><ul class="cu-review-list">${flagged.map(s => `<li class="cu-item">${esc(s.title)}
      <button class="btn" onclick="cuClearEndedFlag('${esc(s.id)}')">Clear flag</button></li>`).join('')}</ul>` : ''}
    <div class="modal-actions"><button class="btn" onclick="closeCuModal()">Close</button></div>`;
}
function cuReviewActionsHtml(m, f) {
  const id = esc(f.id), btn = (label, call) => `<button class="btn" onclick="${call}">${esc(label)}</button>`;
  const decide = `${btn('Not now', `cuDecide('${id}', 'not_now')`)}${btn('Dismiss', `cuDecide('${id}', 'dismissed')`)}`;
  if (f.status !== 'pending') return decide;
  if (f.kind === 'new_season') {
    const cands = ((f.result || {}).candidates || []).map(rid => m.lib.rows.find(r => r.id === rid)).filter(Boolean);
    return (cands.length ? cands.map(r => btn(`It’s “${r.season}”`, `cuReviewSeason('${id}', '${esc(r.id)}')`)).join('') : btn('Apply', `cuReviewSeason('${id}', null)`)) + decide;
  }
  if (f.kind === 'date') return btn('Apply this date', `cuReviewDate('${id}')`) + decide;
  if (f.kind === 'identity') {
    const s = f.subject || {};
    if (s.tmdb_id) return btn('Match to this TMDB show', `cuReviewIdentity('${id}', ${Number(s.tmdb_id)})`) + decide;
    return (s.candidates || []).map(c => btn(`Match to “${c.name}”${c.first_air_date ? ` (${String(c.first_air_date).slice(0, 4)})` : ''}`, `cuReviewIdentity('${id}', ${Number(c.tmdb_id)})`)).join('') + decide;
  }
  if (f.kind === 'new_show' || f.kind === 'new_film') {
    const title = (f.subject || {}).title || '';
    const names = new Set([title, ...((f.subject || {}).working_titles || [])].map(cuNorm));
    const same = f.kind === 'new_show'
      ? m.lib.shows.filter(s => names.has(cuNorm(s.title)) || cuAliasesOf(m.st, s.id, null).some(a => names.has(cuNorm(a))))
      : m.lib.rows.filter(r => isFilmRow(r) && (names.has(cuNorm(r.title)) || cuAliasesOf(m.st, null, r.id).some(a => names.has(cuNorm(a)))));
    const sameBtns = same.map(r => btn(`Same as “${r.title}”`, `cuAccept('${id}', 'same_as', '${esc(r.id)}')`)).join('');
    return (same.length ? sameBtns + btn('Add as a different work', `cuAccept('${id}', 'create', null)`) : btn('Add', `cuAccept('${id}', 'create', null)`))
      + btn('Not now', `cuDecide('${id}', 'not_now')`)
      + `<select class="cu-exclude-kind" id="cuExcl-${id}" aria-label="What to exclude"><option value="title">Exclude this title</option><option value="every_version">Exclude every version</option><option value="series_and_spinoffs">Exclude the series and its spin-offs</option></select>`
      + btn('Exclude', `cuDecide('${id}', 'excluded')`);
  }
  return decide;
}

// Each review decision is one change through the write lane; the dialog is read again afterwards.
async function cuReviewWrite(label, fn) {
  const m = cuModal;
  if (!m) return;
  const session = m.session;
  let res = null, failure = null;
  await runWrite(label, async () => {
    try { res = await fn(); } catch (e) { failure = libraryFailure(e, label, 'Collection updates'); }
  });
  if (!cuModal || cuModal.session !== session) return;
  cuModal.message = failure ? failure.text : res && res.outcome === 'policy' ? `${label}: not applied — ${cuReasonText(res.reason)}.` : `${label}: done.`;
  cuModal.messageError = !!failure || (res && res.outcome === 'policy');
  if (!failure) showSaved();
  try {
    const [lib, st] = await Promise.all([readLibrary(), cuReadState()]);
    if (cuModal && cuModal.session === session) Object.assign(cuModal, { lib, st });
  } catch (e) { /* the message stands; Close and open again to read */ }
  if (activeViewId) reloadOpenView();
  cuRenderModal();
}
const cuFind = id => cuModal && cuModal.st.findings.find(f => f.id === id);
function cuDecide(id, status) {
  const f = cuFind(id);
  if (!f) return;
  let exclusion = null;
  if (status === 'excluded') {
    const kind = (document.getElementById(`cuExcl-${id}`) || {}).value || 'title';
    exclusion = { kind, title: (f.subject || {}).title || '', media: f.kind === 'new_film' ? 'movie' : 'tv' };
  }
  return cuReviewWrite(status === 'not_now' ? 'Not now' : status === 'excluded' ? 'Exclude' : 'Dismiss',
    () => sbRpc('library_cu_set_finding_status', { p_id: id, p_expected_status: f.status, p_status: status, p_note: '', p_exclusion: exclusion }));
}
function cuReviewSeason(id, rowId) {
  const f = cuFind(id), lib = cuModal.lib;
  const show = f && lib.showsById.get(f.show_id);
  if (!f || !show) return;
  const season = { season_number: f.subject.season_number, ...(f.proposed || {}) };
  return cuReviewWrite(`${show.title} · season`, () => sbRpc('library_cu_reconcile_season', { p_show_id: show.id,
    p_expected: { tmdb_id: show.tmdb_id, show_key: show.show_key }, p_season: season, p_finding: { id }, p_review: true, p_row_id: rowId }));
}
function cuReviewDate(id) {
  const f = cuFind(id);
  const row = f && cuModal.lib.rows.find(r => r.id === (f.season_id || f.item_id));
  if (!row) return;
  return cuReviewWrite(`${row.title} · date`, () => sbRpc('library_cu_set_season_date', { p_row_id: row.id,
    p_expected: { display_date: row.display_date, date_sort: row.date_sort }, p_new: { display_date: f.proposed.display_date, date_sort: f.proposed.date_sort },
    p_finding: { id }, p_review: true }));
}
async function cuReviewIdentity(id, tmdbId) {
  const f = cuFind(id), lib = cuModal.lib;
  const show = f && lib.showsById.get(f.show_id);
  if (!show) return;
  let details;
  try { details = await tmdbFetch(`/tv/${tmdbId}`); }
  catch (e) { cuModal.message = 'TMDB didn’t answer, so nothing was matched.'; cuModal.messageError = true; cuRenderModal(); return; }
  const listed = (details.seasons || []).map(s => s && s.season_number).filter(n => Number.isInteger(n) && n > 0);
  const finding = f.subject && f.subject.tmdb_id === tmdbId ? { id }
    : { source: 'tmdb', kind: 'identity', fingerprint: await cuFingerprint('identity', ['identity', show.id, tmdbId]), show_id: show.id,
      subject: { title: show.title, tmdb_id: tmdbId, tmdb_title: details.name, listed } };
  await cuReviewWrite(`${show.title} · match`, async () => {
    const res = await sbRpc('library_cu_attach_identity', { p_show_id: show.id, p_expected: { title: show.title, show_key: show.show_key },
      p_tmdb_id: tmdbId, p_listed: listed, p_finding: finding, p_review: true });
    // A possible-match finding is closed once one of its candidates is matched.
    if (res && res.outcome === 'applied' && !finding.id) await sbRpc('library_cu_set_finding_status', { p_id: id, p_expected_status: f.status, p_status: 'dismissed', p_note: 'matched', p_exclusion: null });
    return res;
  });
}
async function cuAccept(id, action, recordId) {
  const f = cuFind(id);
  if (!f) return;
  // A record removed from this collection earlier comes back only when the owner says so (the database
  // refuses it otherwise).
  let addBack = false;
  if (action === 'same_as' && cuModal.st.removals.some(r => r.collection_id === f.collection_id && (r.show_id === recordId || r.item_id === recordId))) {
    addBack = await askEffect('You removed this from the collection earlier. Add it back to the collection?', 'Add it back');
    if (!addBack) return;
  }
  const s = f.subject || {}, isShow = f.kind === 'new_show';
  const choice = action === 'same_as'
    ? { action, [isShow ? 'show_id' : 'item_id']: recordId, add_back: addBack }
    : { action, distinct_from: [], [isShow ? 'show' : 'film']: isShow
      ? { title: s.title, tmdb_id: s.tmdb_id || null, seasons: [{ season_number: 1, display_date: (f.proposed || {}).display_date || 'TBA', date_sort: (f.proposed || {}).date_sort || CU_TBA_SORT }] }
      : { title: s.title, tmdb_id: s.tmdb_id || null, display_date: (f.proposed || {}).display_date || 'TBA', date_sort: (f.proposed || {}).date_sort || CU_TBA_SORT } };
  if (action === 'create') {
    const names = new Set([s.title, ...(s.working_titles || [])].map(cuNorm));
    choice.distinct_from = (isShow ? cuModal.lib.shows : cuModal.lib.rows.filter(isFilmRow))
      .filter(r => names.has(cuNorm(r.title)) || cuAliasesOf(cuModal.st, isShow ? r.id : null, isShow ? null : r.id).some(a => names.has(cuNorm(a)))).map(r => r.id);
  }
  return cuReviewWrite(`${s.title || 'New title'}`, () => sbRpc('library_cu_accept_finding', { p_finding_id: id, p_choice: choice }));
}
function cuClearEndedFlag(showId) {
  const st = cuModal && cuModal.st.settings.get(showId);
  return cuReviewWrite('Clear the flag', () => sbRpc('library_cu_set_show_settings', { p_show_id: showId,
    p_expected: { follow_when_skipped: !!(st && st.follow_when_skipped), flagged: !!(st && st.new_season_after_ended_at) },
    p_follow_when_skipped: !!(st && st.follow_when_skipped), p_clear_ended_flag: true }));
}
