// ─── Games research (G1, next-gen item 5): the games brief and findings file ───
// The same round trip as collection research (collection-research.js), for members with research access: research runs in a
// Claude session the owner starts (the refresh-catalogs skill), never here.
//   1. Settings → Games → Download games research brief: what IGDB alone can't settle for this member — announced releases on
//      their platforms in followed franchises (to confirm availability or a date), recent releases dated only by IGDB, PS4 games
//      counted as playable on PS5 through Sony's rule, relationships IGDB leaves ambiguous (a remaster of a port, a saved game
//      IGDB has moved to another spot) and spin-offs in followed franchises.
//   2. Claude returns a findings file (watchlist-games-research-findings, version 1), each finding with title-specific evidence:
//      a PlayStation Store page (store.playstation.com) or the publisher's official page.
//   3. Settings → Games → Import games findings: the file's structure and evidence fields are checked here; availability and
//      compatibility findings become decisions at once (Available, or a Not out yet hold carrying the evidence); relationship and
//      series-role findings are kept and offered in Games → Review, where nothing changes until the member chooses. Every
//      decision that carries evidence is research: the database refuses it without research access (library_game_decision_set).
// What an article or Store page says is Claude's assessment, shown as such; the page checks only the evidence's shape.

const GAMES_BRIEF_FORMAT = 'watchlist-games-research-brief';
const GAMES_FINDINGS_FORMAT = 'watchlist-games-research-findings';
const GAMES_FINDING_TYPES = ['availability', 'compatibility', 'relationship', 'role'];
const GAMES_EVIDENCE_SOURCES = ['playstation_store', 'publisher'];

// ── 1. The brief ──
function gamesBriefChecks(data, today) {
  const st = gamesState(data, today), out = { announcements: [], recent: [], compatibility: [], relationships: [], roles: [] };
  const seen = new Set(), add = (list, key, item) => { if (seen.has(key)) return; seen.add(key); list.push(item); };
  const lineOf = c => ({ platform: c.platform, from: c.from, precision: c.row.prec, igdb_date: gameDateText(c.row), date_key: c.key });
  const daysAgo = d => (Date.parse(today) - Date.parse(d)) / 86400000;
  for (const f of data.follows) {
    const sum = franchiseSummary(f, st);
    sum.coming.forEach(x => add(out.announcements, `a|${x.version.rec.id}|${x.c.platform}`, { igdb_id: x.version.rec.id, title: x.version.rec.name, franchise: f.name, ...lineOf(x.c) }));
    sum.spots.filter(s => s.spinoff && !s.included).forEach(s => add(out.roles, `r|${s.id}`, { igdb_id: s.id, title: s.title, franchise: f.name, igdb_collection_id: f.igdb_collection_id, igdb_role: 'spinoff' }));
    sum.spots.forEach(s => s.versions.forEach(v => { if (gameAmbiguousChain(v.rec, st.cache)) add(out.relationships, `l|${v.rec.id}`, { igdb_id: v.rec.id, title: v.rec.name, igdb_type: v.rec.type, igdb_parent: v.rec.parent, question: 'same_game_or_separate_version' }); }));
    if (sum.upNext) {
      const c = sum.upNext.version.avail.released[0];
      if (c && !c.native) add(out.compatibility, `c|${c.rec.id}`, { igdb_id: c.rec.id, title: c.rec.name, ps4_date: gameDateText(c.row) });
    }
  }
  for (const e of data.entries) {
    const v = gameEntryView(e, st), c = v.avail.line;
    if (!c || c.evidence) continue;
    if (c.isReleased && c.native && c.row.prec === 'day' && daysAgo(c.row.d) <= 60) add(out.recent, `n|${c.rec.id}|${c.platform}`, { igdb_id: c.rec.id, title: c.rec.name, ...lineOf(c) });
    if (c.isReleased && !c.native) add(out.compatibility, `c|${c.rec.id}`, { igdb_id: c.rec.id, title: c.rec.name, ps4_date: gameDateText(c.row) });
    if (!c.isReleased) add(out.announcements, `a|${c.rec.id}|${c.platform}`, { igdb_id: c.rec.id, title: c.rec.name, franchise: null, ...lineOf(c) });
  }
  gamesReviewItems(data).filter(it => it.kind !== 'research').forEach(it => add(out.relationships, `l|${it.rec.id}`, { igdb_id: it.rec.id, title: it.rec.name, igdb_type: it.rec.type,
    igdb_parent: it.rec.parent, saved_spot_igdb_id: it.entry.spot_igdb_id, igdb_spot_igdb_id: it.derived, question: it.kind === 'chain' ? 'same_game_or_separate_version' : 'which_spot' }));
  return out;
}
function gamesBuildBrief(data, today = localTodayStr()) {
  return { format: GAMES_BRIEF_FORMAT, version: 1, exported_at: new Date().toISOString(), research_date: today,
    platforms: data.settings ? data.settings.platforms : [], franchises: data.follows.map(f => ({ igdb_collection_id: f.igdb_collection_id, name: f.name })),
    evidence_rules: 'Each finding needs title-specific evidence: a PlayStation Store page for that game (store.playstation.com) or the publisher’s official page, published or checked on or before research_date. Report only IGDB records named here; say not_found when the evidence is silent.',
    checks: gamesBriefChecks(data, today) };
}
async function gamesDownloadBrief() {
  if (!researchEnabled) { showError('Games research needs research access. Nothing was made.'); return; }
  try {
    const data = await readGamesData();
    downloadJSON(gamesBuildBrief(data), `watchlist-games-research-brief-${timestampForFilename()}.json`);
    showNotice('Games research brief downloaded. Give it to Claude with the refresh-catalogs skill, then import the findings file it returns here.');
  } catch (e) { showError(`The games research brief couldn’t be made: ${e.message}`); }
}

// ── 2. The findings file ──
function gamesEvidenceProblem(ev, researchDate) {
  if (!Array.isArray(ev) || !ev.length || ev.length > 5) return 'needs one to five pieces of evidence';
  for (const e of ev) {
    if (!e || typeof e !== 'object' || !GAMES_EVIDENCE_SOURCES.includes(e.source)) return 'evidence needs a source: playstation_store or publisher';
    let u; try { u = new URL(e.url); } catch (x) { return 'evidence needs a web address'; }
    if (u.protocol !== 'https:') return 'evidence must be an https address';
    if (e.source === 'playstation_store' && !/(^|\.)playstation\.com$/.test(u.hostname)) return 'PlayStation Store evidence must be on playstation.com';
    if (typeof e.checked !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.checked) || e.checked > researchDate) return 'evidence needs the date it was checked, not after the research date';
    if (e.note != null && (typeof e.note !== 'string' || e.note.length > 300)) return 'an evidence note is too long';
  }
  return null;
}
const GAMES_PRECISIONS = ['day', 'month', 'quarter', 'year'];
function gamesDatePart(f) {
  if (f.precision === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(f.date)) return { precision: 'day', date: f.date };
  if (f.precision === 'month' && Number.isInteger(f.year) && f.month >= 1 && f.month <= 12) return { precision: 'month', year: f.year, month: f.month };
  if (f.precision === 'quarter' && Number.isInteger(f.year) && f.quarter >= 1 && f.quarter <= 4) return { precision: 'quarter', year: f.year, quarter: f.quarter };
  if (f.precision === 'year' && Number.isInteger(f.year)) return { precision: 'year', year: f.year };
  return null;
}
// The file's own problems (structure and evidence), before anything is applied.
function gamesFindingsProblems(doc) {
  const p = [];
  if (!doc || typeof doc !== 'object') return ['The file isn’t a JSON object.'];
  if (doc.format !== GAMES_FINDINGS_FORMAT || doc.version !== 1) return [`This isn’t a games findings file (${GAMES_FINDINGS_FORMAT}, version 1).`];
  if (typeof doc.research_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.research_date) || doc.research_date > localTodayStr()) p.push('research_date must be a date, not in the future');
  if (!Array.isArray(doc.findings) || doc.findings.length > 500) return p.concat(['findings must be a list (at most 500)']);
  doc.findings.forEach((f, i) => {
    const at = `finding ${i + 1}`;
    if (!f || !GAMES_FINDING_TYPES.includes(f.type)) { p.push(`${at}: unknown type`); return; }
    if (!(Number.isInteger(f.igdb_id) && f.igdb_id > 0)) p.push(`${at}: igdb_id must be an IGDB id`);
    if (f.status === 'not_found') return; // (nothing to apply; reported)
    const ev = gamesEvidenceProblem(f.evidence, doc.research_date);
    if (ev) p.push(`${at}: ${ev}`);
    if (f.type === 'availability') {
      if (!G1_PLATFORMS.includes(f.platform)) p.push(`${at}: unknown platform`);
      if (!['available', 'not_yet'].includes(f.status)) p.push(`${at}: status must be available, not_yet or not_found`);
      if (f.status === 'available' && !gamesDatePart(f)) p.push(`${at}: an available release needs its date at a precision (day, month, quarter or year)`);
    } else if (f.type === 'compatibility') {
      if (!['playable_on_ps5', 'ps4_only'].includes(f.status)) p.push(`${at}: status must be playable_on_ps5, ps4_only or not_found`);
    } else if (f.type === 'relationship') {
      if (!['same_spot_as', 'own_spot', 'port_of'].includes(f.relation)) p.push(`${at}: relation must be same_spot_as, own_spot or port_of`);
      if (f.relation !== 'own_spot' && !(Number.isInteger(f.target_igdb_id) && f.target_igdb_id > 0 && f.target_igdb_id !== f.igdb_id)) p.push(`${at}: target_igdb_id must be another IGDB id`);
    } else if (f.type === 'role') {
      if (!['main', 'spinoff'].includes(f.role)) p.push(`${at}: role must be main or spinoff`);
    }
  });
  return p;
}
// What each finding asks for, against the member's current data: a decision to set, or why nothing is done.
function gamesFindingOps(doc, data, today = localTodayStr()) {
  const st = gamesState(data, today), ops = [];
  const meta = f => ({ evidence: f.evidence, research_date: doc.research_date, ...(f.note ? { note: String(f.note).slice(0, 300) } : {}) });
  // The release row a hold names: the platform line Watchlist would use for that record and platform.
  const rowFor = (rec, platform) => { const a = gameAvailability([rec], st); return a.released.concat(a.coming).find(c => c.platform === platform && !c.evidence) || null; };
  for (const f of doc.findings) {
    const rec = st.cache.get(f.igdb_id), label = rec ? rec.name : `IGDB ${f.igdb_id}`;
    if (f.status === 'not_found') { ops.push({ skip: `${label}: research found nothing title-specific` }); continue; }
    if (!rec) { ops.push({ skip: `${label}: not read from IGDB on this account (use Refresh first)` }); continue; }
    if (f.type === 'availability' && f.status === 'available') ops.push({ kind: 'available', igdb: rec.id, platform: f.platform, value: { ...gamesDatePart(f), ...meta(f) }, label: `${label}: available on ${GAME_PLATFORM_LABEL[f.platform]}` });
    else if (f.type === 'availability' || (f.type === 'compatibility' && f.status === 'ps4_only')) {
      const platform = f.type === 'compatibility' ? 'ps5' : f.platform, c = rowFor(rec, platform);
      if (!c) { ops.push({ skip: `${label}: no release on ${GAME_PLATFORM_LABEL[platform]} to hold` }); continue; }
      ops.push({ kind: 'not_out_yet', igdb: rec.id, platform, value: { date: c.key, precision: c.row.prec, ...meta(f) }, label: `${label}: not out yet on ${GAME_PLATFORM_LABEL[platform]}${f.type === 'compatibility' ? ' (PS4 only)' : ''}` });
    } else if (f.type === 'compatibility') {
      const c = rowFor(rec, 'ps5');
      if (!c || c.native) { ops.push({ skip: `${label}: no PS4 release playable on PS5 to confirm` }); continue; }
      ops.push({ kind: 'available', igdb: rec.id, platform: 'ps5', value: { precision: c.row.prec, ...(c.row.d ? { date: c.row.d } : { year: c.row.y, month: c.row.m, quarter: c.row.q }), compat: true, ...meta(f) }, label: `${label}: confirmed playable on PS5` });
    } else if (f.type === 'relationship') ops.push({ kind: 'research_link', igdb: rec.id, platform: '', value: { relation: f.relation, target_igdb_id: f.target_igdb_id || null, ...meta(f) }, label: `${label}: relationship for review` });
    else ops.push({ kind: 'research_role', igdb: rec.id, platform: '', value: { role: f.role, igdb_collection_id: f.igdb_collection_id || null, ...meta(f) }, label: `${label}: series role for review` });
  }
  return ops;
}
function openGamesFindingsFile() {
  if (!researchEnabled) { showError('Games research needs research access. Nothing was changed.'); return; }
  const input = document.getElementById('gamesFileInput');
  if (input) input.click();
}
async function handleGamesFindingsSelected(event) {
  const file = event && event.target && event.target.files && event.target.files[0];
  if (event && event.target) event.target.value = '';
  if (!file) return;
  return gamesImportFindings(await file.text());
}
// Applies a findings file: one write lane, each decision guarded by what was read; already-made decisions are left alone.
async function gamesImportFindings(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { showError('The findings file isn’t JSON. Nothing was changed.'); return; }
  const problems = gamesFindingsProblems(doc);
  if (problems.length) { showError(`The findings file can’t be imported, so nothing was changed: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` …and ${problems.length - 5} more` : ''}.`); return; }
  let data;
  try { data = await readGamesData(); } catch (e) { showError(`Your games couldn’t be read, so nothing was changed: ${e.message}`); return; }
  const ops = gamesFindingOps(doc, data);
  const done = [], already = [], skipped = ops.filter(o => o.skip).map(o => o.skip);
  await runWrite('Import games findings', async lane => {
    for (const o of ops.filter(x => !x.skip)) {
      const key = gameDecisionKey(o.kind, o.igdb, o.platform), cur = data.decisions.get(key);
      if (cur && JSON.stringify(cur.value) === JSON.stringify(o.value)) { already.push(o.label); continue; }
      try {
        const d = await sbRpc('library_game_decision_set', { p_kind: o.kind, p_igdb_id: o.igdb, p_platform: o.platform, p_expected: cur ? cur.value : null, p_value: o.value });
        data.decisions.set(key, d); done.push(o.label);
      } catch (err) {
        showError(`${stateErrorText(err)} The findings applied before this one stay applied; import the file again to continue.`);
        lane.after.push(() => reloadOpenView());
        return;
      }
    }
    showSaved();
    lane.after.push(() => reloadOpenView());
  });
  showNotice(`Games findings: ${countUnit(done.length, 'decision', 'decisions')} recorded${already.length ? `, ${already.length} already recorded` : ''}${skipped.length ? `, ${skipped.length} not applied (${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? '…' : ''})` : ''}. Relationships and series roles wait in Games → Review.`);
  return { done, already, skipped };
}

// ── 3. Review: what research says about relationships and series roles ──
// Kept as research decisions; nothing changes until the member chooses (Use research's / Count it / Skip all versions / Dismiss).
function gamesResearchReviewItems(data) {
  const cache = data.cache, items = [];
  const savedBy = new Map(); data.entries.forEach(e => { savedBy.set(e.igdb_id, e); (e.port_ids || []).forEach(p => savedBy.set(p, e)); });
  for (const d of data.decisionRows || []) {
    if (d.kind === 'research_link') {
      const rec = cache.get(d.igdb_id), target = d.value.target_igdb_id ? cache.get(d.value.target_igdb_id) : null;
      const entry = savedBy.get(d.igdb_id), targetEntry = d.value.target_igdb_id ? savedBy.get(d.value.target_igdb_id) : null;
      const spot = d.value.relation === 'own_spot' ? d.igdb_id : target ? gameAnchor(target, cache) : d.value.target_igdb_id;
      const name = rec ? rec.name : `IGDB ${d.igdb_id}`, tname = target ? target.name : `IGDB ${d.value.target_igdb_id}`;
      const words = d.value.relation === 'own_spot' ? `is a game of its own in the franchise` : d.value.relation === 'port_of' ? `is a port of ${tname}` : `is a version of the same game as ${tname}`;
      let action = null;
      if (d.value.relation === 'port_of' && !entry && targetEntry && targetEntry.igdb_id !== d.igdb_id) action = { kind: 'join', entry: targetEntry };
      else if (entry && entry.igdb_id === d.igdb_id && entry.spot_igdb_id !== spot) action = { kind: 'spot', entry, spot };
      items.push({ kind: 'research', decision: d, text: `Research (${d.value.research_date}) says “${name}” ${words}.`, action });
    } else if (d.kind === 'research_role') {
      const rec = cache.get(d.igdb_id), name = rec ? rec.name : `IGDB ${d.igdb_id}`;
      const included = data.decisions.has(gameDecisionKey('include_spinoff', d.igdb_id)), skipped = data.decisions.has(gameDecisionKey('skip_spot', d.igdb_id));
      const action = d.value.role === 'main' && !included ? { kind: 'include' } : d.value.role === 'spinoff' && !skipped ? { kind: 'skipspot' } : null;
      items.push({ kind: 'research', decision: d, text: `Research (${d.value.research_date}) says “${name}” is ${d.value.role === 'main' ? 'main series' : 'a spin-off'}.`, action });
    }
  }
  return items;
}
const gamesResearchActionLabel = a => (!a ? '' : a.kind === 'join' ? `Join it to “${a.entry.title}” as a port` : a.kind === 'spot' ? 'Use research’s answer' : a.kind === 'include' ? 'Count it toward Caught up' : 'Skip all versions');
// The member's choice on a research item: apply it (a guarded relink, or a counting decision), then the finding is done.
async function gamesResearchChoose(i, apply) {
  const it = gamesResearchReviewItems(gamesData)[i];
  if (!it) return;
  closeGameDialog();
  const d = it.decision, a = apply ? it.action : null;
  await runWrite(`Research · ${apply ? 'apply' : 'dismiss'}`, async lane => {
    try {
      if (a && a.kind === 'join') await sbRpc('library_game_relink', { p_entry_id: a.entry.id, p_expected: { spot_igdb_id: a.entry.spot_igdb_id, port_ids: a.entry.port_ids || [] }, p_spot_igdb_id: a.entry.spot_igdb_id, p_port_ids: [...(a.entry.port_ids || []), d.igdb_id] });
      if (a && a.kind === 'spot') await sbRpc('library_game_relink', { p_entry_id: a.entry.id, p_expected: { spot_igdb_id: a.entry.spot_igdb_id, port_ids: a.entry.port_ids || [] }, p_spot_igdb_id: a.spot, p_port_ids: a.entry.port_ids || [] });
      if (a && (a.kind === 'include' || a.kind === 'skipspot')) {
        const kind = a.kind === 'include' ? 'include_spinoff' : 'skip_spot', cur = gamesData.decisions.get(gameDecisionKey(kind, d.igdb_id));
        await sbRpc('library_game_decision_set', { p_kind: kind, p_igdb_id: d.igdb_id, p_platform: '', p_expected: cur ? cur.value : null, p_value: {} });
      }
      await sbRpc('library_game_decision_set', { p_kind: d.kind, p_igdb_id: d.igdb_id, p_platform: '', p_expected: d.value, p_value: null });
      showSaved();
      lane.after.push(() => reloadOpenView());
    } catch (err) {
      if (stateNeedsReread(err)) { await reportStateFailure(err); return; }
      showError(stateErrorText(err));
    }
  }, { list: true });
}
function gamesResearchSettingHtml() {
  if (!researchEnabled) return '';
  return `<div class="settings-sub">Games research</div>
    <p class="settings-text">Download a brief of what IGDB can’t settle (announcements, recent releases, PS4 games on PS5, unclear relationships and spin-offs), research it with Claude, then import the findings file. Release findings become decisions with their evidence; relationships and series roles wait in Games → Review.</p>
    <div class="settings-actions"><button class="btn" data-games-research="brief" onclick="gamesDownloadBrief()">Download games research brief</button>
      <button class="btn" data-games-research="import" onclick="openGamesFindingsFile()">Import games findings…</button></div>`;
}
