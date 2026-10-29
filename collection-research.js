// ─── Collection updates (item 4): research briefs, findings files and the setup file ──
// Announcement research runs in a Claude session the owner starts (the refresh-catalogs skill), never
// here. The round trip:
//   1. Download research brief: the chosen Follow / Discover collections' confirmed definitions (with
//      the version and hashes the database records for the brief), exclusions, holds, the existing
//      items with their required checks (renewal for every show not Skipped, Ended shows included;
//      dates for TBA and future seasons; cancellation for unaired ones), TMDB candidates and open findings.
//   2. Claude returns a findings file (format watchlist-research-findings, version 1).
//   3. Import findings: the file's structure, references and evidence fields are validated here; the
//      current collection mode, definition, exclusions and evidence settings route each finding; the
//      database records them (library_cu_record_findings: a file already imported is refused) and every
//      applying function checks everything again. Evidence content (what an article says, whether it is
//      current, whether reports are independent) is Claude's assessment, shown as such.
// The setup file (watchlist-collection-setup, version 1) carries the built-in collections' definitions,
// exclusions and holds; it is kept outside the repository and imported once (Settings).

const CU_BRIEF_FORMAT = 'watchlist-research-brief';
const CU_FINDINGS_FORMAT = 'watchlist-research-findings';
const CU_SETUP_FORMAT = 'watchlist-collection-setup';
const CU_FINDING_KINDS = ['new_season', 'date', 'alias', 'new_show', 'new_film', 'cancellation'];
const CU_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── 1. The brief ──
// A collection's shows and films as the brief lists them, each with the checks research must run.
function cuBriefItems(collectionId, lib, st, today, protectedIds) {
  const members = st.memberships.filter(m => m.collection_id === collectionId);
  const items = [];
  for (const m of members) {
    if (m.show_id) {
      const show = lib.showsById.get(m.show_id);
      if (!show) continue;
      const following = !!(st.settings.get(show.id) || {}).follow_when_skipped;
      const skipped = show.status === 'skipped' && !following;
      const seasons = lib.rows.filter(r => r.show_id === show.id).map(r => {
        return { ref: `rec:season:${r.id}`, label: r.season, season_number: r.season_number,
          state: r.tmdb_id != null ? (r.season_number != null ? 'identified' : 'unidentified') : (show.tmdb_id != null ? 'awaiting_tmdb' : 'unidentified'),
          display_date: r.display_date, date_sort: r.date_sort, watched: !!r.watched, skipped: !!r.skipped, protected: protectedIds.has(r.id),
          required_checks: skipped ? [] : cuDateChecks(r, today) };
      });
      items.push({ ref: `rec:show:${show.id}`, kind: 'show', title: show.title, aliases: cuAliasesOf(st, show.id, null), tmdb_id: show.tmdb_id,
        status: show.status, ended: !!show.ended, follow_when_skipped: following, network: show.network || null,
        required_checks: skipped ? [] : ['renewal'], seasons });
    } else if (m.item_id) {
      const r = lib.rows.find(x => x.id === m.item_id);
      if (!r) continue;
      items.push({ ref: `rec:item:${r.id}`, kind: 'film', title: r.title, aliases: cuAliasesOf(st, null, r.id), tmdb_id: r.tmdb_id,
        display_date: r.display_date, date_sort: r.date_sort, protected: protectedIds.has(r.id), required_checks: cuDateChecks(r, today) });
    }
  }
  return { members, items };
}
async function cuBuildBrief(collectionIds) {
  const [lib, st, colls] = await Promise.all([readLibrary(), cuReadState(), readPersonalCollections()]);
  const briefId = crypto.randomUUID();
  const today = cuToday();
  const protectedIds = new Set(st.holds.filter(h => h.kind === 'protected_value' && h.field === 'display_date').map(h => h.item_id).filter(Boolean));
  const briefItems = new Map(collectionIds.map(id => [id, cuBriefItems(id, lib, st, today, protectedIds)]));
  // The checks exactly as exported go with the brief's record, so an import compares its coverage with them.
  const checks = [];
  briefItems.forEach(({ items }) => items.forEach(i => {
    i.required_checks.forEach(check => checks.push({ subject: i.ref, check, title: i.title.slice(0, 300) }));
    (i.seasons || []).forEach(x => x.required_checks.forEach(check => checks.push({ subject: x.ref, check, title: `${i.title} · ${x.label}`.slice(0, 300) })));
  }));
  // The brief's record (versions, hashes and checks) is the database's; the file carries the same.
  const reg = await runWrite('Research brief', () => sbRpc('library_cu_register_brief', { p_id: briefId, p_collections: collectionIds, p_checks: checks }));
  if (!reg) throw new Error(LANE_BUSY_TEXT(writeLane ? writeLane.label : 'A change'));
  const collections = [];
  for (const rc of reg.collections) {
    const c = colls.find(x => x.id === rc.collection_id) || {};
    const def = st.allDefinitions.find(d => d.id === rc.definition_id) || {};
    const { members, items } = briefItems.get(rc.collection_id);
    const holdItems = st.holds.filter(h => h.collection_id === rc.collection_id
      || members.some(m => (h.show_id && h.show_id === m.show_id) || (h.item_id && (h.item_id === m.item_id || lib.rows.some(r => r.id === h.item_id && r.show_id === m.show_id)))));
    collections.push({
      collection_id: rc.collection_id, name: c.name || '', mode: rc.mode, definition_id: rc.definition_id, definition_version: rc.definition_version,
      rule_hashes: rc.rule_hashes, evidence_hash: rc.evidence_hash, summary: def.summary || '', rules: def.rules || [], evidence: def.evidence || {},
      exclusions: st.exclusions.filter(e => e.collection_id === rc.collection_id).map(e => ({ kind: e.kind, title: e.title, tmdb_id: e.tmdb_id, media: e.media })),
      holds: holdItems.map(h => ({ kind: h.kind, subject: h.item_id ? `rec:${lib.rows.find(r => r.id === h.item_id && r.show_id) ? 'season' : 'item'}:${h.item_id}` : h.show_id ? `rec:show:${h.show_id}` : null,
        subject_label: h.subject_label, field: h.field, protected_value: h.protected_value, decision: h.decision, effect: h.effect, reopen: h.reopen, decided_on: h.decided_on })),
      items,
      tmdb_candidates: rc.mode === 'discover' ? await cuTmdbCandidates(def.rules || [], lib) : [],
      open_findings: st.findings.filter(f => f.collection_id === rc.collection_id && f.source === 'research' && !['applied', 'accepted', 'dismissed'].includes(f.status))
        .map(f => ({ ref: `fnd:${f.id}`, kind: f.kind, status: f.status, reason: f.reason, subject: f.subject, proposed: f.proposed,
          evidence_urls: (f.evidence || []).map(e => e.url), decided_at: f.decided_at }))
    });
  }
  return { format: CU_BRIEF_FORMAT, version: 1, brief_id: briefId, exported_at: new Date().toISOString(), today,
    findings_format: { format: CU_FINDINGS_FORMAT, version: 1 },
    evidence_policy: 'An official network, studio or show announcement, or reporting from two independent established entertainment trades (two different outlets on the trade list, neither crediting the other). Rumours, filming sightings and predicted release patterns never qualify. A confirmed renewal without a date enters as TBA. A standing decision reopens only on its own condition.',
    collections };
}

// TMDB candidates for a Discover collection's rules (hints for research; never added from TMDB alone).
async function cuTmdbCandidates(rules, lib) {
  const have = new Set(lib.shows.map(s => s.tmdb_id).filter(Boolean)), haveFilms = new Set(lib.rows.filter(isFilmRow).map(r => r.tmdb_id).filter(Boolean));
  const out = [];
  for (const r of rules) {
    try {
      if (r.type === 'person_role' && r.person_tmdb_id) {
        const d = await tmdbFetch(`/person/${r.person_tmdb_id}/combined_credits`);
        (d && d.crew || []).forEach(c => {
          const role = cuCreditRole(c);
          if (!role) return;
          const tv = c.media_type === 'tv', ok = tv ? (r.series_roles || []).includes(role) : (r.film_roles || []).includes(role);
          if (!ok || (tv ? have.has(c.id) : haveFilms.has(c.id))) return;
          if (!out.some(x => x.tmdb_id === c.id && x.media === (tv ? 'tv' : 'movie'))) out.push({ rule_id: r.id, media: tv ? 'tv' : 'movie', tmdb_id: c.id, title: c.name || c.title, role, first_air_or_release: c.first_air_date || c.release_date || null });
        });
      } else if (r.type === 'platform_premiere' && r.platform_tmdb_network_id && (r.media || 'series') !== 'films') {
        const d = await tmdbFetch(`/discover/tv?with_networks=${Number(r.platform_tmdb_network_id)}&sort_by=first_air_date.desc`);
        (d && d.results || []).filter(c => !have.has(c.id)).slice(0, 20).forEach(c => out.push({ rule_id: r.id, media: 'tv', tmdb_id: c.id, title: c.name, first_air_or_release: c.first_air_date || null,
          note: `Candidate only: TMDB lists ${r.platform || 'the platform'} as a network; research must confirm the title premiered on ${r.platform || 'the platform'} in ${r.region === 'US' ? 'the US' : r.region || 'the region'}` }));
      }
    } catch (e) { out.push({ rule_id: r.id, unavailable: 'TMDB didn’t answer for this rule' }); }
  }
  return out.slice(0, 60);
}
// A TMDB crew credit as a rule role (creator credits are TMDB's "Creator"; writing and directing by job).
function cuCreditRole(c) {
  const job = String(c.job || '');
  if (/^creator$/i.test(job)) return 'creator';
  if (/^co-?creator$/i.test(job)) return 'co_creator';
  if (/^showrunner$/i.test(job)) return 'showrunner';
  if (/^executive producer$/i.test(job)) return 'executive_producer';
  if (/^director$/i.test(job)) return 'director';
  if (/^(writer|screenplay|story|teleplay|novel)$/i.test(job)) return 'writer';
  if (/^producer$/i.test(job)) return 'producer';
  return null;
}

async function cuDownloadBrief(collectionIds) {
  const brief = await cuBuildBrief(collectionIds);
  downloadJSON(brief, `watchlist-research-brief-${timestampForFilename()}.json`);
  return brief;
}

// ── 3. Importing a findings file ──
// Structure and references; null when the file can be used, else the problems.
function cuFindingsFileProblems(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || doc.format !== CU_FINDINGS_FORMAT) return ['This isn’t a Watchlist research findings file.'];
  if (doc.version !== 1) return [`Findings format version ${JSON.stringify(doc.version)} isn’t one this page reads.`];
  if (!CU_UUID.test(doc.brief_id || '')) problems.push('It doesn’t name the brief it answers.');
  if (!Array.isArray(doc.findings)) problems.push('It has no list of findings.');
  if (!Array.isArray(doc.coverage)) problems.push('It has no coverage report.');
  (doc.findings || []).forEach((f, i) => {
    const at = `Finding ${i + 1}`;
    if (!f || typeof f !== 'object') { problems.push(`${at} isn’t an object.`); return; }
    if (!CU_FINDING_KINDS.includes(f.kind)) problems.push(`${at} has an unknown kind.`);
    if (!CU_UUID.test(f.collection_id || '')) problems.push(`${at} doesn’t name a collection.`);
    if (f.ref != null && !/^(rec:(show|season|item)|fnd):[0-9a-f-]{36}$/i.test(f.ref)) problems.push(`${at} has a reference this page doesn’t recognise.`);
    if (!f.subject || typeof f.subject !== 'object' || typeof f.subject.title !== 'string' || !f.subject.title.trim()) problems.push(`${at} has no subject title.`);
    if (!Array.isArray(f.evidence)) problems.push(`${at} has no evidence list.`);
    else f.evidence.forEach((e, j) => {
      if (!e || !/^https:\/\//i.test(e.url || '') || !['official', 'trade', 'other'].includes(e.source_type) || !cuDate(e.published_on)
          || typeof e.excerpt !== 'string' || e.excerpt.length > 400) problems.push(`${at}, evidence ${j + 1}: url, source_type, published_on and a short excerpt are required.`);
    });
    if (!f.assessment || typeof f.assessment !== 'object' || !['official', 'two_trades', 'insufficient'].includes(f.assessment.standard) || !cuDate(f.assessment.researched_on)
        || typeof f.assessment.conflict !== 'boolean') problems.push(`${at} has no complete assessment (standard, researched_on, conflict).`);
    if (f.kind === 'new_season' && !Number.isInteger((f.subject || {}).season_number)) problems.push(`${at} (a new season) has no season number.`);
    if (f.kind === 'date' && !(f.proposed && f.proposed.display_date && cuDate(f.proposed.date_sort))) problems.push(`${at} (a date) has no proposed date.`);
    if (f.kind === 'alias' && !(f.proposed && typeof f.proposed.alias === 'string' && f.proposed.alias.trim())) problems.push(`${at} (an alias) has no alias.`);
  });
  return problems.length ? problems.slice(0, 30) : null;
}

// Routes each finding by the current state and prepares what the database records. The database
// checks everything again at application; this decides only what's shown and what is tried.
async function cuPrepareFindings(doc, brief, lib, st) {
  const out = [], problems = [];
  const briefColl = new Map((brief.collections || []).map(c => [c.collection_id, c]));
  for (const [i, f] of doc.findings.entries()) {
    const at = `Finding ${i + 1}`;
    const bc = briefColl.get(f.collection_id);
    if (!bc) { problems.push(`${at} names a collection the brief didn’t carry.`); continue; }
    const [, refKind, refId] = (String(f.ref || '').match(/^(rec:show|rec:season|rec:item|fnd):(.+)$/) || []);
    let showId = null, itemId = null, seasonId = null, fingerprint = null;
    if (refKind === 'rec:show') { if (!lib.showsById.has(refId)) { problems.push(`${at} names a show that isn’t in your library.`); continue; } showId = refId; }
    else if (refKind === 'rec:season') {
      const r = lib.rows.find(x => x.id === refId && x.show_id);
      if (!r) { problems.push(`${at} names a season that isn’t in your library.`); continue; }
      seasonId = r.id; showId = r.show_id;
    } else if (refKind === 'rec:item') { if (!lib.rows.some(x => x.id === refId)) { problems.push(`${at} names a film that isn’t in your library.`); continue; } itemId = refId; }
    else if (refKind === 'fnd') {
      const prior = st.findings.find(x => x.id === refId);
      if (!prior) { problems.push(`${at} names a finding that isn’t saved.`); continue; }
      fingerprint = prior.fingerprint; showId = prior.show_id; itemId = prior.item_id; seasonId = prior.season_id;
    }
    if (f.kind === 'date' && !(seasonId || itemId)) { problems.push(`${at} (a date) doesn’t name a season or film.`); continue; }
    if (f.kind === 'new_season' && !showId) { problems.push(`${at} (a new season) doesn’t name a show.`); continue; }
    if (['alias', 'cancellation'].includes(f.kind) && !(showId || itemId)) { problems.push(`${at} doesn’t name the record it’s about.`); continue; }
    const subject = { ...f.subject, title: f.subject.title.trim() };
    if (!fingerprint) {
      const key = showId || itemId || seasonId ? [showId, itemId, seasonId] : [cuNorm(subject.title)];
      const value = f.kind === 'new_season' ? subject.season_number : f.kind === 'date' ? (f.proposed || {}).date_sort
        : f.kind === 'alias' ? cuNorm((f.proposed || {}).alias) : null;
      fingerprint = await cuFingerprint(f.kind, ['research', f.collection_id, f.kind, key, value]);
    }
    // Routing by the current state (the database checks the same again when applying).
    const def = st.definitions.get(f.collection_id);
    const newTitle = f.kind === 'new_show' || f.kind === 'new_film';
    let routed = 'pending', reason = '';
    const hashChanged = !def || def.evidence_hash !== bc.evidence_hash || (f.rule_id && (def.rule_hashes || {})[f.rule_id] !== (bc.rule_hashes || {})[f.rule_id]);
    if (!def) { routed = 'set_aside'; reason = 'no_definition'; }
    else if (def.mode === 'manual') { routed = 'set_aside'; reason = 'collection_manual'; }
    else if (newTitle && def.mode !== 'discover') { routed = 'set_aside'; reason = 'collection_not_discovering'; }
    else if (f.rule_id && !(f.rule_id in (def.rule_hashes || {}))) { routed = 'set_aside'; reason = 'rule_removed'; }
    else if (hashChanged) { routed = 'needs_research'; reason = def.evidence_hash !== bc.evidence_hash ? 'evidence_rules_changed' : 'rule_changed'; }
    else if (!newTitle && (showId || itemId) && st.removals.some(r => r.collection_id === f.collection_id && (r.show_id === showId || r.item_id === itemId))) { routed = 'set_aside'; reason = 'removed_from_collection'; }
    else if (st.exclusions.some(e => e.collection_id === f.collection_id && cuExcludes(e, subject))) { routed = 'set_aside'; reason = 'excluded'; }
    else {
      const p = cuEvidenceProblem(f.evidence, f.assessment, def.evidence);
      if (p === 'conflict') { routed = 'conflict'; reason = 'conflict'; }
      else if (p) { routed = 'needs_evidence'; reason = p; }
    }
    out.push({ fingerprint, kind: f.kind, collection_id: f.collection_id, ...(f.rule_id ? { rule_id: f.rule_id } : {}), show_id: showId, item_id: itemId, season_id: seasonId,
      subject, proposed: f.proposed || {}, expected: f.expected || {}, evidence: f.evidence.map(e => ({ url: e.url, publisher: e.publisher || '', outlet: e.outlet || '',
        source_type: e.source_type, published_on: e.published_on, claim_on: e.claim_on || null, accessed_on: e.accessed_on || null, claim_type: e.claim_type || '',
        excerpt: e.excerpt, attribution: e.attribution || 'original' })),
      assessment: { standard: f.assessment.standard, researched_on: f.assessment.researched_on, conflict: f.assessment.conflict,
        independence: f.assessment.independence || '', latest_check_on: f.assessment.latest_check_on || null }, routed_status: routed, reason });
  }
  return { findings: out, problems };
}
// A TBA or future season or film needs its date and a cancellation checked (the brief and the import's coverage check).
function cuDateChecks(r, today) {
  const tba = /tba/i.test(r.display_date), future = !tba && r.date_sort > today;
  return tba || future ? ['dates', 'cancellation'] : [];
}
function cuExcludes(e, subject) {
  const names = [subject.title, ...(subject.aliases || []), ...(subject.working_titles || [])].map(cuNorm).filter(Boolean);
  if (e.tmdb_id && subject.tmdb_id === e.tmdb_id) return true;
  if (e.kind === 'title') return names.includes(e.match_text);
  if (e.kind === 'every_version') return names.some(n => ` ${n} `.includes(` ${e.match_text} `));
  return names.includes(e.match_text) || cuNorm(subject.spinoff_of) === e.match_text;
}

// Reads, validates, records and applies a findings file; returns the results.
async function cuImportFindings(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { return { problems: ['The file isn’t valid JSON.'] }; }
  const structural = cuFindingsFileProblems(doc);
  if (structural) return { problems: structural };
  const [lib, st, briefs] = await Promise.all([readLibrary(), cuReadState(), fetchAllRowsStrict('research_briefs')]);
  const brief = briefs.find(b => b.id === doc.brief_id);
  if (!brief) return { problems: ['This findings file answers a brief this account didn’t export, so nothing was imported.'] };
  const sha = await cuSha256(text);
  if ((await fetchAllRowsStrict('research_imports')).some(r => r.file_sha256 === sha)) return { problems: ['This findings file was already imported, so nothing changed.'] };
  const ageDays = (Date.now() - Date.parse(brief.exported_at)) / 86400000;
  const prepared = await cuPrepareFindings(doc, brief, lib, st);
  if (prepared.problems.length) return { problems: prepared.problems.slice(0, 30) };
  const results = cuEmptyResults('research');
  results.checked = prepared.findings.length;
  results.unchanged = 0;
  if (ageDays > 14) results.failed.push(`The brief is ${Math.floor(ageDays)} days old; current values were checked again, but consider a fresh brief.`);
  const reported = (doc.coverage || []).filter(c => c && typeof c === 'object');
  results.coverage = { reported: reported.length, checked: reported.filter(c => c.status === 'checked').length,
    missing: (Array.isArray(brief.checks) ? brief.checks : []).filter(x => x && !reported.some(c => c.subject === x.subject && c.check === x.check)) };
  results.coverage.missing.forEach(x => results.failed.push(`${x.title} (${x.check}): not in the research file’s coverage, so it may not have been checked`));
  reported.forEach(c => {
    if (c.status === 'failed' || c.status === 'unsupported') results.failed.push(`${c.subject_title || c.subject || c.rule_id || 'A check'}${c.check ? ` (${c.check})` : ''}: ${c.status === 'failed' ? 'couldn’t be checked' : 'not supported by the research'}${c.reason ? ` — ${c.reason}` : ''}`);
  });
  let recorded;
  const lane = beginWrite('Import findings');
  if (!lane) return { problems: [LANE_BUSY_TEXT(writeLane ? writeLane.label : 'A change')] };
  try { recorded = await sbRpc('library_cu_record_findings', { p_brief_id: doc.brief_id, p_file_sha256: sha, p_findings: prepared.findings }); }
  catch (e) { endWrite(lane); const fl = libraryFailure(e, 'Importing the findings file', 'Collection updates'); return { problems: [fl.text] }; }
  endWrite(lane);
  // Automatic application: new seasons, dates and aliases whose finding is pending.
  const byFp = new Map((recorded.findings || []).map(x => [x.fingerprint, x]));
  const plan = cuSameDayPlan(lib, st).filter(x => !prepared.findings.some(f => f.fingerprint && (st.findings.find(y => y.id === x.args.p_finding.id) || {}).fingerprint === f.fingerprint));
  for (const f of prepared.findings) {
    const rec = byFp.get(f.fingerprint);
    if (!rec) continue;
    const label = cuRecordTitle(lib, f);
    if (rec.status !== 'pending') {
      if (rec.status === 'set_aside') results.setAside.push(`${label}: not applied — ${cuReasonText(f.reason)}`);
      else if (rec.status === 'excluded') results.setAside.push(`${label}: not applied — it is excluded`);
      else if (CU_OPEN_STATUSES.includes(rec.status)) (CU_BLOCKED_STATUSES.includes(rec.status) ? results.blocked : results.review).push(`${cuFindingSentence(lib, f)}: ${cuReasonText(f.reason) || rec.status.replace(/_/g, ' ')}`);
      else results.unchanged++; // applied, accepted, dismissed or Not now earlier: the finding stands as decided
      continue;
    }
    if (f.kind === 'new_season') {
      const show = lib.showsById.get(f.show_id);
      if (!show) { results.failed.push(`${label}: the show it names is no longer in your library`); continue; }
      plan.push({ type: 'season', fn: 'library_cu_reconcile_season', what: `${show.title} · Season ${f.subject.season_number}`,
        args: { p_show_id: show.id, p_expected: { tmdb_id: show.tmdb_id, show_key: show.show_key }, p_season: { season_number: f.subject.season_number },
          p_finding: { id: rec.id }, p_review: false, p_row_id: null } });
    } else if (f.kind === 'date') {
      const row = lib.rows.find(r => r.id === (f.season_id || f.item_id));
      if (!row) { results.failed.push(`${label}: the season or film it names is no longer in your library`); continue; }
      plan.push({ type: 'date', fn: 'library_cu_set_season_date', what: `${row.title}${row.show_id ? ` · ${row.season}` : ''}`, newDate: f.proposed,
        args: { p_row_id: row.id, p_expected: { display_date: row.display_date, date_sort: row.date_sort },
          p_new: { display_date: f.proposed.display_date, date_sort: f.proposed.date_sort }, p_finding: { id: rec.id }, p_review: false } });
    } else if (f.kind === 'alias') {
      plan.push({ type: 'alias', fn: 'library_cu_add_alias', what: label, alias: f.proposed.alias,
        args: { p_show_id: f.show_id, p_item_id: f.show_id ? null : f.item_id, p_alias: f.proposed.alias, p_finding: { id: rec.id } } });
    } else results.review.push(`${cuFindingSentence(lib, f)}: waits for your decision`);
  }
  await cuApplyPlan(plan, results, 'Import findings');
  return { results };
}

// ── The setup file ──
// { format, version: 1, collections: [{ match: { catalog_id | name }, mode, rules, evidence, summary,
//   exclusions: [{ kind, title, tmdb_id?, media?, note? }] }], holds: [{ collection: { catalog_id | name },
//   show_title?, season_label?, item_title?, kind, field?, protected_value?, decision, effect, reopen, decided_on? }] }
// Resolved against the library (collections by catalog or name; shows by title among the collection's
// members first, then the library); anything unresolved or ambiguous is listed and left out unless the
// owner fixes the file. Imported only after the owner confirms the preview.
function cuResolveSetup(doc, lib, colls, memberships) {
  const problems = [], unresolved = [];
  if (!doc || doc.format !== CU_SETUP_FORMAT || doc.version !== 1 || !Array.isArray(doc.collections) || !Array.isArray(doc.holds)) {
    return { problems: ['This isn’t a Watchlist collection setup file (version 1).'] };
  }
  const findColl = m => {
    const hits = colls.filter(c => (m && m.catalog_id && c.catalog === m.catalog_id) || (m && m.name && cuNorm(c.name) === cuNorm(m.name)));
    return hits.length === 1 ? hits[0] : null;
  };
  const definitions = [], exclusions = [], holds = [];
  doc.collections.forEach((x, i) => {
    const c = findColl(x.match);
    if (!c) { unresolved.push(`Collection ${i + 1} (${(x.match && (x.match.name || x.match.catalog_id)) || '?'}) isn’t one collection in your library.`); return; }
    definitions.push({ collection_id: c.id, name: c.name, mode: x.mode, rules: x.rules || [], evidence: x.evidence, summary: x.summary || '' });
    (x.exclusions || []).forEach(e => exclusions.push({ collection_id: c.id, kind: e.kind, title: e.title, tmdb_id: e.tmdb_id || null, media: e.media || 'any', note: e.note || '' }));
  });
  doc.holds.forEach((h, i) => {
    const c = h.in_collection ? findColl(h.in_collection) : null;
    if (h.in_collection && !c) { unresolved.push(`Hold ${i + 1}: its collection isn’t in your library.`); return; }
    const memberShows = c ? new Set(memberships.filter(m => m.collection_id === c.id).map(m => m.show_id).filter(Boolean)) : null;
    const byTitle = t => {
      const all = lib.shows.filter(s => cuNorm(s.title) === cuNorm(t));
      const inColl = memberShows ? all.filter(s => memberShows.has(s.id)) : [];
      return inColl.length === 1 ? inColl[0] : all.length === 1 ? all[0] : null;
    };
    const base = { kind: h.kind, collection_id: c ? c.id : null, field: h.field || null, protected_value: h.protected_value || null,
      decision: h.decision, effect: h.effect, reopen: h.reopen, decided_on: h.decided_on || null, subject_label: null, show_id: null, item_id: null };
    if (h.show_title) {
      const s = byTitle(h.show_title);
      if (!s) {
        // A show not in the library: kept by name (a standing decision about a title not yet added).
        if (h.kind === 'standing_decision') { holds.push({ ...base, subject_label: h.season_label ? `${h.show_title} · ${h.season_label}` : h.show_title, label: `${h.show_title}${h.season_label ? ` · ${h.season_label}` : ''} (not in your library)` }); return; }
        unresolved.push(`Hold ${i + 1} (${h.show_title}): not one show in your library.`); return;
      }
      if (h.season_label && (h.kind === 'protected_value')) {
        const r = lib.rows.filter(x => x.show_id === s.id && cuNorm(x.season) === cuNorm(h.season_label));
        if (r.length !== 1) { unresolved.push(`Hold ${i + 1} (${h.show_title} · ${h.season_label}): not one season of that show.`); return; }
        holds.push({ ...base, item_id: r[0].id, label: `${s.title} · ${r[0].season}` });
      } else holds.push({ ...base, show_id: s.id, subject_label: h.season_label || null, label: `${s.title}${h.season_label ? ` · ${h.season_label}` : ''}` });
    } else if (h.item_title) {
      const r = lib.rows.filter(x => isFilmRow(x) && cuNorm(x.title) === cuNorm(h.item_title));
      if (r.length !== 1) { unresolved.push(`Hold ${i + 1} (${h.item_title}): not one film in your library.`); return; }
      holds.push({ ...base, item_id: r[0].id, label: r[0].title });
    } else unresolved.push(`Hold ${i + 1}: names no show or film.`);
  });
  return { problems, unresolved, definitions, exclusions, holds };
}
async function cuImportSetup(resolved) {
  const strip = ({ label, name, ...x }) => x;
  return runWrite('Import collection setup', () => sbRpc('library_cu_import_setup', { p_doc: {
    definitions: resolved.definitions.map(strip), exclusions: resolved.exclusions, holds: resolved.holds.map(strip) } }));
}
