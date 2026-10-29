// CU1 collection updates (db/cu1_collection_updates.sql) for the offline harness, written
// independently of the page's helpers so the tests can catch a page/database mismatch: the ten
// tables, the library_cu_* functions with the database's rules (re-reading the store at the call:
// setup gate, Skipped / follow, holds, exclusions, research mode and hashes, evidence structure,
// expected values; reconciliation with identified and unidentified rows; the date rules; identity
// and alias rules; accepting with duplicates and remembered removals), the membership functions
// recording removals, and the retired catalog application. Used by tests/app-harness.js when
// createApp({ stage5: 'contracted-cu1' }) (the default).

const CU1_PHASE = 'contracted-cu1';
const CU1_TABLES = ['update_setup', 'collection_definitions', 'collection_exclusions', 'update_holds', 'record_aliases',
  'membership_removals', 'show_update_settings', 'research_briefs', 'research_imports', 'update_findings'];
const BUILTIN = ['disney', '90day', 'sheridan'];
const crypto = require('crypto');
const md5 = t => crypto.createHash('md5').update(t, 'utf8').digest('hex');
const cuNorm = t => String(t || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(`${s}T00:00:00Z`));
const host = u => { const m = /^https:\/\/([^/:?#]+)/i.exec(String(u || '')); return m ? m[1].toLowerCase().replace(/^www\./, '') : null; };
const hostIn = (h, d) => !!h && (d || []).some(x => h === x || h.endsWith(`.${x}`));
const clone = v => JSON.parse(JSON.stringify(v));
// jsonb text as PostgreSQL writes it (keys by length, then bytes; ", " and ": " separators), for the hashes.
const jsonbText = v => v === null || v === undefined ? 'null' : Array.isArray(v) ? `[${v.map(jsonbText).join(', ')}]`
  : typeof v === 'object' ? `{${Object.keys(v).filter(k => v[k] !== undefined).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(k => `${JSON.stringify(k)}: ${jsonbText(v[k])}`).join(', ')}}` : JSON.stringify(v);
const ruleHashes = rules => Object.fromEntries((rules || []).map(r => { const { label, search_networks, official_domains_hint, ...x } = r; return [r.id, md5(jsonbText(x))]; }));

function evidenceProblem(evidence, a, settings, after = null, named = null) {
  a = a || {};
  if (a.conflict === true) return 'conflict';
  if (!['official', 'two_trades'].includes(a.standard)) return 'evidence_insufficient';
  if (!isDate(a.researched_on) || !Array.isArray(evidence)) return 'evidence_incomplete';
  const ok = e => isDate(e && e.published_on) && e.published_on <= a.researched_on && (!after || e.published_on > after);
  const official = evidence.some(e => e && e.source_type === 'official' && ok(e) && hostIn(host(e.url), named || (settings && settings.official_domains)));
  if (named) return official ? null : 'evidence_named_source_missing';
  const trades = new Set(evidence.filter(e => e && e.source_type === 'trade' && (e.attribution || 'original') === 'original' && ok(e))
    .map(e => ((settings && settings.trades) || []).find(t => t.id === e.outlet && hostIn(host(e.url), t.domains))).filter(Boolean).map(t => t.id));
  return official || trades.size >= 2 ? null : 'evidence_below_standard';
}

function cu1Handlers({ app, store, DbError, isFilmRow }) {
  let n = 0;
  const id = () => `0f1c0000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const now = () => new Date().toISOString();
  const T = t => (store[t] = store[t] || []);
  const refuse = (code, text, detail) => { throw new DbError('P0001', `${code}: ${text}`, detail); };
  const invalid = text => { throw new DbError('22023', `invalid_input: ${text}`); };
  const changed = () => refuse('target_changed', 'This changed since the page showed it, so nothing was changed. Look at it again.');
  const requireOn = name => { if (app.stage5 !== CU1_PHASE) throw new DbError('PGRST202', `missing ${name}`); };
  const shows = () => store.tv_shows, items = () => store.watchlist_items;
  const governed = (showId, itemId) => (showId && shows().some(s => s.id === showId && BUILTIN.includes(s.collection)))
    || (itemId && items().some(r => r.id === itemId && ((isFilmRow(r) && BUILTIN.includes(r.collection)) || (r.show_id && shows().some(s => s.id === r.show_id && BUILTIN.includes(s.collection))))));
  const setupOk = (showId, itemId) => !governed(showId, itemId) || T('update_setup').length > 0;
  const currentDef = c => T('collection_definitions').filter(d => d.collection_id === c).sort((a, b) => b.version - a.version)[0] || null;
  const label = num => (num === 0 ? 'Specials' : `Season ${num}`);
  const plainNumber = l => { const m = /^Season ([1-9][0-9]{0,3})$/.exec(l || ''); return m ? Number(m[1]) : null; };
  const holdFor = (kinds, showId, itemId, lbl) => T('update_holds').filter(h => kinds.includes(h.kind)
    && ((itemId && h.item_id === itemId) || (showId && h.show_id === showId && !h.item_id && (!h.subject_label || (lbl && cuNorm(h.subject_label) === cuNorm(lbl))))))
    .sort((a, b) => (a.kind === 'identity_hold' ? 0 : a.kind === 'standing_decision' ? 1 : 2) - (b.kind === 'identity_hold' ? 0 : b.kind === 'standing_decision' ? 1 : 2))[0] || null;
  const excluded = (coll, subject) => {
    const names = [subject.title, ...(subject.aliases || []), ...(subject.working_titles || [])].filter(Boolean).map(cuNorm);
    return T('collection_exclusions').some(e => e.collection_id === coll && ((e.tmdb_id && subject.tmdb_id === e.tmdb_id)
      || (e.kind === 'title' && names.includes(e.match_text)) || (e.kind === 'every_version' && names.some(x => ` ${x} `.includes(` ${e.match_text} `)))
      || (e.kind === 'series_and_spinoffs' && (names.includes(e.match_text) || cuNorm(subject.spinoff_of) === e.match_text))));
  };
  const finish = (f, outcome, status, reason, result) => {
    Object.assign(f, { status, reason: reason || '', result: result === undefined || result === null ? f.result : result, last_seen_at: now(),
      applied_at: ['applied', 'accepted'].includes(status) ? now() : f.applied_at, decided_at: ['applied', 'accepted'].includes(status) ? now() : f.decided_at });
    return { outcome, finding_id: f.id, status: f.status, reason: f.reason, result: f.result };
  };
  const notActionable = f => (f.status !== 'pending' ? { outcome: 'not_pending', finding_id: f.id, status: f.status, reason: f.reason, result: f.result } : null);
  function take(p, kinds) {
    if (!p || typeof p !== 'object') invalid('finding');
    let f;
    if (p.id) {
      f = T('update_findings').find(x => x.id === p.id);
      if (!f) refuse('target_missing', 'This finding is no longer saved, so nothing was changed. Check again.');
    } else {
      if (p.source !== 'tmdb' || !/^[a-z_]+:[0-9a-f]{64}$/.test(p.fingerprint || '') || !kinds.includes(p.kind)) invalid('TMDB finding');
      f = T('update_findings').find(x => x.fingerprint === p.fingerprint);
      if (!f) {
        f = { id: id(), fingerprint: p.fingerprint, source: 'tmdb', kind: p.kind, status: 'pending', reason: '', collection_id: null,
          show_id: p.show_id || null, item_id: p.item_id || null, season_id: p.season_id || null, subject: clone(p.subject || {}), proposed: clone(p.proposed || {}),
          expected: clone(p.expected || {}), evidence: [], assessment: {}, rule_id: null, definition_version: null, rule_hash: null, evidence_hash: null, brief_id: null,
          first_seen_at: now(), last_seen_at: now(), decided_at: null, applied_at: null, result: null };
        T('update_findings').push(f);
      } else if (['needs_evidence', 'set_aside'].includes(f.status) && !f.decided_at) {
        // A parked TMDB finding the owner hasn't decided is checked again with what TMDB says now.
        Object.assign(f, { status: 'pending', reason: '', subject: clone(p.subject || f.subject), proposed: clone(p.proposed || f.proposed),
          expected: clone(p.expected || f.expected), last_seen_at: now() });
      }
    }
    if (!kinds.includes(f.kind)) invalid(`a ${f.kind} finding can't be applied here`);
    return f;
  }
  function researchGate(f, newTitle) {
    if (f.source !== 'research') return null;
    const d = currentDef(f.collection_id);
    if (!d) return 'set_aside:no_definition';
    if (d.mode === 'manual') return 'set_aside:collection_manual';
    if (newTitle && d.mode !== 'discover') return 'set_aside:collection_not_discovering';
    if (!newTitle && (f.show_id || f.item_id)) {
      if (T('membership_removals').some(r => r.collection_id === f.collection_id && ((f.show_id && r.show_id === f.show_id) || (f.item_id && r.item_id === f.item_id)))) return 'set_aside:removed_from_collection';
      if (!store.collection_memberships.some(m => m.collection_id === f.collection_id && ((f.show_id && m.show_id === f.show_id) || (f.item_id && m.item_id === f.item_id)))) return 'set_aside:not_in_collection';
    }
    if (f.evidence_hash !== d.evidence_hash) return 'needs_research:evidence_rules_changed';
    if (f.rule_id) {
      if (!(f.rule_id in d.rule_hashes)) return 'set_aside:rule_removed';
      if (f.rule_hash !== d.rule_hashes[f.rule_id]) return 'needs_research:rule_changed';
    }
    if (excluded(f.collection_id, f.subject)) return 'excluded:excluded';
    const p = evidenceProblem(f.evidence, f.assessment, d.evidence);
    if (p === 'conflict') return 'conflict:conflict';
    if (p) return `needs_evidence:${p}`;
    return null;
  }
  const gateFinish = (f, g) => finish(f, 'policy', g.split(':')[0], g.split(':')[1], null);
  const settingsOf = f => (f.source === 'research' ? (currentDef(f.collection_id) || {}).evidence : null);
  const reopenMet = (h, f, review) => {
    if (h.reopen.on === 'owner_only') return review;
    if (f.source !== 'research' || !settingsOf(f)) return false;
    return evidenceProblem(f.evidence, f.assessment, settingsOf(f), h.decided_on, h.reopen.on === 'named_source' ? h.reopen.source_domains : null) === null;
  };
  function holdGate(f, showId, itemId, lbl, review, identity) {
    if (identity && holdFor(['identity_hold'], showId, itemId, lbl)) return 'pending:identity_hold';
    // Every standing decision that applies is consulted; the most restrictive outcome wins.
    const all = T('update_holds').filter(h => h.kind === 'standing_decision' && ((itemId && h.item_id === itemId)
      || (showId && h.show_id === showId && !h.item_id && (!h.subject_label || (lbl && cuNorm(h.subject_label) === cuNorm(lbl))))));
    for (const h of all) {
      if (h.effect === 'stay_skipped_unmatched' && !identity) continue;
      if (h.effect === 'require_qualifying_evidence' && f.source === 'research' && reopenMet(h, f, false)) continue;
      if (review) { if (reopenMet(h, f, true)) continue; return 'refuse:reopen_condition_not_met'; }
      return 'pending:standing_decision';
    }
    return null;
  }
  const showOf = sid => shows().find(s => s.id === sid);
  // private.cu1c_exact_date / the calendar-day difference (CU1c).
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const exactDate = (display, sort) => {
    if (!/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(String(display || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(sort || ''))) return null;
    const [y, m, d] = sort.split('-').map(Number), real = new Date(Date.UTC(y, m - 1, d));
    if (real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) return null;
    return `${MON[m - 1]} ${d}, ${y}` === display ? sort : null;
  };
  const dayDiff = (a, b) => { const n = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; }; return Math.abs(n(a) - n(b)); };
  // update_holds' checks and private.cu1_insert_hold's key list (db/cu1_collection_updates.sql).
  const HOLD_KEYS = ['kind', 'collection_id', 'show_id', 'item_id', 'subject_label', 'field', 'protected_value', 'decision', 'effect', 'reopen', 'decided_on'];
  const REOPEN_ON = ['official_date_or_window', 'official_or_two_trades', 'named_source', 'renewal_cast_date_cancellation', 'owner_only', 'new_evidence'];
  const holdShapeCheck = h => {
    if (!h || typeof h !== 'object' || Array.isArray(h) || Object.keys(h).some(k => !HOLD_KEYS.includes(k))) invalid('hold');
    const bad = () => invalid('hold check');
    if (!['standing_decision', 'protected_value', 'identity_hold'].includes(h.kind)) bad();
    if (h.subject_label != null && (!String(h.subject_label).trim() || String(h.subject_label).length > 200)) bad();
    if (h.field != null && !['display_date', 'title', 'season_label'].includes(h.field)) bad();
    if (h.protected_value != null && String(h.protected_value).length > 200) bad();
    if (!String(h.decision || '').trim() || String(h.decision).length > 2000) bad();
    const r = h.reopen;
    if (!r || typeof r !== 'object' || !REOPEN_ON.includes(r.on) || Object.keys(r).some(k => !['on', 'source_domains', 'source_name'].includes(k))
      || (r.on === 'named_source' && !(Array.isArray(r.source_domains) && r.source_domains.length >= 1 && r.source_domains.length <= 10))) bad();
    if (!h.show_id && !h.item_id && !h.subject_label) bad();
    const target = !!(h.show_id || h.item_id);
    if (h.kind === 'protected_value' ? !(h.field && target && h.effect === 'keep_value')
      : h.kind === 'identity_hold' ? !(!h.field && target && ['block_matching', 'block_season_mapping'].includes(h.effect))
      : !(!h.field && ['keep_value', 'do_not_add', 'require_qualifying_evidence', 'stay_skipped_unmatched'].includes(h.effect))) bad();
    if ((h.show_id && !showOf(h.show_id)) || (h.item_id && !T('watchlist_items').some(r => r.id === h.item_id))
      || (h.collection_id && !T('personal_collections').some(c => c.id === h.collection_id))) invalid('a hold names a record or collection that isn\'t yours');
  };
  const newSeasonRow = (s, lbl, num, identified, display, sort, theme) => ({ id: id(), collection: s.collection, item_key: `${s.show_key}|${lbl.toLowerCase()}`, title: s.title,
    season: lbl, theme: theme || '', display_date: display, date_sort: sort, watched: false, status: 'confirmed', created_at: now(), watch_with: [], collections: [],
    tmdb_collection_id: null, tmdb_collection_name: null, media_type: identified ? 'tv' : null, tmdb_id: identified ? s.tmdb_id : null,
    season_number: identified ? num : null, show_id: s.id, skipped: false, priority: null, catalog_new: null, status_review: null, legacy_status: null,
    genres: null, forms: null, franchises: null, companies: null, genre_candidates: null, metadata_owner_set: null });

  const fns = {
    library_cu_reconcile_season({ p_show_id, p_expected, p_season, p_finding, p_review = false, p_row_id = null }) {
      requireOn('library_cu_reconcile_season');
      if (!p_show_id || !p_expected || !p_season || !Number.isInteger(p_season.season_number)) invalid('show, expected values and season number are required');
      const num = p_season.season_number, lbl = label(num);
      const f = take(p_finding, ['new_season']);
      const na = notActionable(f);
      if (na) { if (p_review) refuse('finding_not_pending', 'This finding was already decided, so nothing was changed.'); return na; }
      const s = showOf(p_show_id);
      if (!s) refuse('target_missing', 'This show is no longer on your list, so nothing was changed.');
      if ((s.tmdb_id ?? null) !== (p_expected.tmdb_id ?? null) || s.show_key !== p_expected.show_key) changed();
      if (f.source === 'tmdb') {
        if (s.tmdb_id == null) invalid('a TMDB season needs a TMDB-matched show');
        if (!isDate(p_season.date_sort) || !p_season.display_date) invalid('a TMDB season needs its date fields');
        if (/tba/i.test(p_season.display_date) && !(p_season.episode_count > 0)) return finish(f, 'policy', 'needs_evidence', 'tmdb_undated_empty');
      } else {
        const g = researchGate(f, false);
        if (g) return gateFinish(f, g);
        if (f.subject.season_number !== num) invalid('the season isn\'t the finding\'s');
      }
      if (!p_review && !setupOk(s.id, null)) return finish(f, 'policy', 'pending', 'setup_required');
      const st = T('show_update_settings').find(x => x.show_id === s.id);
      if (s.status === 'skipped' && !(st && st.follow_when_skipped)) return finish(f, 'policy', 'set_aside', 'skipped');
      const rows = items().filter(r => r.show_id === s.id);
      if (s.tmdb_id != null) {
        const ident = items().find(r => r.media_type === 'tv' && r.tmdb_id === s.tmdb_id && r.season_number === num);
        if (ident) {
          if (ident.show_id !== s.id) return finish(f, 'policy', 'pending', 'tmdb_season_elsewhere', { row_id: ident.id });
          return finish(f, 'already', 'applied', 'existing', { outcome: 'existing', row_id: ident.id });
        }
      }
      const g = holdGate(f, s.id, null, lbl, p_review, f.source === 'tmdb');
      if (g && g.startsWith('refuse:')) refuse('reopen_condition_not_met', 'The decision held for this season isn\'t reopened by this evidence, so nothing was changed.');
      if (g) return gateFinish(f, g);
      const unid = rows.filter(r => r.tmdb_id == null).sort((a, b) => (a.id < b.id ? -1 : 1));
      const plain = unid.filter(r => num > 0 && r.season === lbl).map(r => r.id);
      const named = unid.filter(r => !(num > 0 && r.season === lbl) && ((num > 0 && new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(r.season || '')) || (num === 0 && /^\s*specials?/i.test(r.season || '')))).map(r => r.id);
      let rowId = null;
      if (p_review && p_row_id) { if (!plain.concat(named).includes(p_row_id)) invalid('the chosen row isn\'t an unidentified season of this show matching this number'); rowId = p_row_id; }
      else if (plain.length === 1 && named.length === 0) rowId = plain[0];
      else if (plain.length + named.length > 0) return finish(f, 'policy', 'pending', 'ambiguous_correspondence', { candidates: plain.concat(named) });
      if (rowId) {
        if (f.source === 'tmdb') {
          const chosen = items().find(r => r.id === rowId);
          if (holdFor(['identity_hold'], s.id, rowId, chosen.season)) return finish(f, 'policy', 'pending', 'identity_hold', { row_id: rowId });
          Object.assign(chosen, { media_type: 'tv', tmdb_id: s.tmdb_id, season_number: num });
          return finish(f, 'applied', 'applied', '', { outcome: 'mapped', row_id: rowId });
        }
        return finish(f, 'already', 'applied', 'existing', { outcome: 'existing', row_id: rowId });
      }
      const key = `${s.show_key}|${lbl.toLowerCase()}`;
      if (rows.some(r => r.item_key === key)) return finish(f, 'policy', 'pending', 'key_conflict');
      const identified = f.source === 'tmdb';
      const display = identified ? p_season.display_date : (f.proposed.display_date || 'TBA');
      const sort = identified ? p_season.date_sort : (f.proposed.date_sort || '2099-01-01');
      const theme = rows.slice().sort((a, b) => ((b.season_number ?? -1) - (a.season_number ?? -1)) || (b.date_sort || '').localeCompare(a.date_sort || ''))[0];
      const row = newSeasonRow(s, lbl, num, identified, display, sort, theme && theme.theme);
      items().push(row);
      let flagged = false;
      if (s.ended) {
        const x = T('show_update_settings').find(y => y.show_id === s.id);
        if (x) Object.assign(x, { new_season_after_ended_at: now(), updated_at: now() });
        else T('show_update_settings').push({ id: id(), show_id: s.id, follow_when_skipped: false, new_season_after_ended_at: now(), updated_at: now() });
        flagged = true;
      }
      return finish(f, 'applied', 'applied', '', { outcome: 'created', row_id: row.id, identified, ended_flagged: flagged });
    },
    library_cu_set_season_date({ p_row_id, p_expected, p_new, p_finding, p_review = false }) {
      requireOn('library_cu_set_season_date');
      if (!p_row_id || !p_expected || !p_new || !isDate(p_new.date_sort) || !p_new.display_date) invalid('row, expected and new date');
      const f = take(p_finding, ['date']);
      const na = notActionable(f);
      if (na) { if (p_review) refuse('finding_not_pending', 'This finding was already decided, so nothing was changed.'); return na; }
      const w = items().find(r => r.id === p_row_id);
      if (!w) refuse('target_missing', 'This row is no longer on your list, so nothing was changed.');
      if (w.display_date !== p_expected.display_date || w.date_sort !== p_expected.date_sort) changed();
      if ((f.season_id || f.item_id) !== w.id) invalid('the row isn\'t the finding\'s');
      if (w.display_date === p_new.display_date && w.date_sort === p_new.date_sort) return finish(f, 'already', 'applied', 'existing', { outcome: 'existing', row_id: w.id });
      if (f.source === 'tmdb') { if (w.media_type !== 'tv' || w.tmdb_id == null) invalid('a TMDB date needs an identified season'); }
      else { const g = researchGate(f, false); if (g) return gateFinish(f, g); }
      // CU1c (db/cu1c_date_equivalence.sql): two exact dates within a calendar day are the same date (set aside,
      // the stored date kept, on review too); TMDB never overwrites an exact date without an owner review.
      const oldExact = exactDate(w.display_date, w.date_sort), newExact = exactDate(p_new.display_date, p_new.date_sort);
      if (oldExact && newExact && dayDiff(oldExact, newExact) <= 1) {
        return finish(f, 'policy', 'set_aside', 'same_date_within_one_day', { outcome: 'kept', row_id: w.id, stored: { display_date: w.display_date, date_sort: w.date_sort } });
      }
      if (!p_review && !setupOk(w.show_id, w.id)) return finish(f, 'policy', 'pending', 'setup_required');
      const g = holdGate(f, w.show_id, w.id, w.season, p_review, false);
      if (g && g.startsWith('refuse:')) refuse('reopen_condition_not_met', 'The decision held for this date isn\'t reopened by this evidence, so nothing was changed.');
      if (g) return gateFinish(f, g);
      if (!p_review && T('update_holds').some(h => h.kind === 'protected_value' && h.field === 'display_date' && (h.item_id === w.id || (h.show_id === w.show_id && !h.item_id)))) {
        return finish(f, 'policy', 'pending', 'protected_value');
      }
      const today = new Date().toISOString().slice(0, 10);
      if (f.source === 'tmdb' && oldExact && !p_review) return finish(f, 'policy', 'pending', 'tmdb_date_differs');
      const oldSort = isDate(w.date_sort) && new Date(`${w.date_sort}T00:00:00Z`).toISOString().slice(0, 10) === w.date_sort ? w.date_sort : null; // as cu1_date: a real date
      const auto = !!newExact && (/tba/i.test(w.display_date || '') || (!!oldSort && oldSort > today && newExact > today));
      if (!auto && !p_review) return finish(f, 'policy', 'pending', 'date_needs_review');
      const from = { display_date: w.display_date, date_sort: w.date_sort };
      Object.assign(w, { display_date: p_new.display_date, date_sort: p_new.date_sort });
      return finish(f, 'applied', 'applied', '', { outcome: 'updated', row_id: w.id, from, to: { display_date: p_new.display_date, date_sort: p_new.date_sort } });
    },
    library_cu_attach_identity({ p_show_id, p_expected, p_tmdb_id, p_listed, p_finding, p_review = false }) {
      requireOn('library_cu_attach_identity');
      if (!p_show_id || !(p_tmdb_id > 0) || !p_expected || !Array.isArray(p_listed)) invalid('show, TMDB id and listed seasons');
      const f = take(p_finding, ['identity']);
      if (f.source !== 'tmdb') invalid('an identity comes from TMDB');
      const na = notActionable(f);
      if (na) { if (p_review) refuse('finding_not_pending', 'This finding was already decided, so nothing was changed.'); return na; }
      const s = showOf(p_show_id);
      if (!s) refuse('target_missing', 'This show is no longer on your list, so nothing was changed.');
      if (s.tmdb_id === p_tmdb_id) return finish(f, 'already', 'applied', 'existing', { outcome: 'existing' });
      if (s.tmdb_id != null || s.title !== p_expected.title || s.show_key !== p_expected.show_key) changed();
      if ((f.subject || {}).tmdb_id !== p_tmdb_id) invalid('the identity isn\'t the finding\'s');
      if (!p_review && !setupOk(s.id, null)) return finish(f, 'policy', 'pending', 'setup_required');
      const g = holdGate(f, s.id, null, null, p_review, true);
      if (g && g.startsWith('refuse:')) refuse('reopen_condition_not_met', 'The decision held for this show isn\'t reopened, so nothing was changed.');
      if (g) return gateFinish(f, g);
      if (shows().some(x => x.tmdb_id === p_tmdb_id)) return finish(f, 'policy', 'pending', 'tmdb_taken');
      const t = cuNorm(f.subject.tmdb_title);
      if (!p_review && t !== cuNorm(s.title) && !T('record_aliases').some(a => a.show_id === s.id && a.match_text === t)) return finish(f, 'policy', 'pending', 'title_differs');
      const rows = items().filter(r => r.show_id === s.id);
      if (!p_review && rows.some(r => plainNumber(r.season) == null)) return finish(f, 'policy', 'pending', 'nonstandard_labels');
      s.tmdb_id = p_tmdb_id;
      const mapped = [], left = [];
      rows.filter(r => r.tmdb_id == null).sort((a, b) => (a.id < b.id ? -1 : 1)).forEach(r => {
        const num = plainNumber(r.season);
        if (num != null && p_listed.includes(num) && !items().some(x => x.media_type === 'tv' && x.tmdb_id === p_tmdb_id && x.season_number === num)
            && !holdFor(['identity_hold'], s.id, null, r.season)) { Object.assign(r, { media_type: 'tv', tmdb_id: p_tmdb_id, season_number: num }); mapped.push(r.id); }
        else left.push(r.id);
      });
      return finish(f, 'applied', 'applied', '', { outcome: 'attached', mapped, unidentified: left });
    },
    library_cu_note_finding({ p_finding, p_reason }) {
      requireOn('library_cu_note_finding');
      if (!/^[a-z_]{1,60}$/.test(p_reason || '')) invalid('reason');
      const f = take(p_finding, ['identity']);
      if (f.status !== 'pending') return notActionable(f);
      return finish(f, 'policy', 'pending', p_reason);
    },
    library_cu_add_alias({ p_show_id = null, p_item_id = null, p_alias, p_finding }) {
      requireOn('library_cu_add_alias');
      if (!p_show_id === !p_item_id || !String(p_alias || '').trim() || !cuNorm(p_alias)) invalid('alias');
      const f = take(p_finding, ['alias']);
      if (f.source !== 'research') invalid('an alias comes from research evidence');
      const na = notActionable(f);
      if (na) return na;
      if ((f.show_id || null) !== p_show_id || (f.item_id || null) !== p_item_id || f.proposed.alias !== p_alias) invalid('the alias isn\'t the finding\'s');
      if (p_show_id ? !showOf(p_show_id) : !items().some(r => r.id === p_item_id)) refuse('target_missing', 'This record is no longer on your list, so nothing was changed.');
      const g = researchGate(f, false);
      if (g) return gateFinish(f, g);
      const mt = cuNorm(p_alias);
      if (T('record_aliases').some(a => a.match_text === mt && ((p_show_id && a.show_id === p_show_id) || (p_item_id && a.item_id === p_item_id)))) return finish(f, 'already', 'applied', 'existing', { outcome: 'existing' });
      const a = { id: id(), show_id: p_show_id, item_id: p_item_id, alias: p_alias.trim(), match_text: mt, evidence: clone(f.evidence), created_at: now() };
      T('record_aliases').push(a);
      return finish(f, 'applied', 'applied', '', { outcome: 'added', alias_id: a.id });
    },
    library_cu_accept_finding({ p_finding_id, p_choice }) {
      requireOn('library_cu_accept_finding');
      if (!p_finding_id || !p_choice || !['create', 'same_as'].includes(p_choice.action)) invalid('finding and choice');
      const f = T('update_findings').find(x => x.id === p_finding_id);
      if (!f) refuse('target_missing', 'This finding is no longer saved, so nothing was changed.');
      if (f.status !== 'pending') refuse('finding_not_pending', 'This finding was already decided, so nothing was changed.');
      if (!['new_show', 'new_film'].includes(f.kind) || f.source !== 'research') invalid('only a researched new show or film is accepted');
      const g = researchGate(f, true);
      if (g) return gateFinish(f, g);
      const c = store.personal_collections.find(x => x.id === f.collection_id);
      if (!c) refuse('org_not_found', 'This collection is no longer available, so nothing was changed.');
      if (c.archived_at) refuse('org_archived', 'This collection is archived; unarchive it first. Nothing was changed.');
      const names = [f.subject.title, ...(f.subject.working_titles || [])].filter(Boolean);
      let showId = null, itemId = null, title = null;
      if (p_choice.action === 'same_as') {
        showId = p_choice.show_id || null; itemId = p_choice.item_id || null;
        if (!showId === !itemId || (f.kind === 'new_show' && !showId) || (f.kind === 'new_film' && !itemId)) invalid('same_as names one show (for a show) or one film (for a film)');
        if (showId ? !showOf(showId) : !items().some(r => r.id === itemId && isFilmRow(r))) refuse('target_missing', 'That record is no longer on your list, so nothing was changed.');
      } else {
        const distinct = p_choice.distinct_from || [];
        const x = f.kind === 'new_show' ? p_choice.show : p_choice.film;
        if (!x || !String(x.title || '').trim()) invalid('the new record');
        title = x.title.trim();
        const want = new Set(names.concat(title).map(cuNorm));
        const aliasHit = (rid, isShow) => T('record_aliases').some(a => (isShow ? a.show_id === rid : a.item_id === rid) && want.has(a.match_text));
        const dups = f.kind === 'new_show'
          ? shows().filter(s => !distinct.includes(s.id) && ((x.tmdb_id && s.tmdb_id === x.tmdb_id) || want.has(cuNorm(s.title)) || aliasHit(s.id, true))).map(s => s.id)
          : items().filter(r => isFilmRow(r) && !distinct.includes(r.id) && ((x.tmdb_id && r.tmdb_id === x.tmdb_id) || want.has(cuNorm(r.title)) || aliasHit(r.id, false))).map(r => r.id);
        if (dups.length) refuse('possible_duplicate', 'A record with this TMDB identity, title or alias is already on your list. Choose it, or confirm this is a different work. Nothing was changed.', { candidates: dups.sort() });
        if (f.kind === 'new_show') {
          if (!Array.isArray(x.seasons) || !x.seasons.length) invalid('seasons');
          const s = { id: id(), collection: 'othertv', title, show_key: title.toLowerCase(), tmdb_id: x.tmdb_id || null, status: 'confirmed', created_at: now(),
            priority: 'normal', ended: false, catalog_new: false, status_review: false, legacy_status: null, genres: [], forms: [], franchises: [], companies: [],
            genre_candidates: [], network: null, network_candidates: [], metadata_owner_set: false, resume_start_season_id: null, resume_end_season_id: null };
          shows().push(s);
          x.seasons.forEach(se => items().push(newSeasonRow(s, label(se.season_number), se.season_number, !!(x.tmdb_id && se.identified), se.display_date, se.date_sort, se.theme || '')));
          showId = s.id;
        } else {
          const r = { id: id(), collection: 'othertv', item_key: `${title.toLowerCase()}|film`, title, season: 'Film', theme: x.theme || '', display_date: x.display_date,
            date_sort: x.date_sort, watched: false, status: 'confirmed', created_at: now(), watch_with: [], collections: [], tmdb_collection_id: null, tmdb_collection_name: null,
            media_type: x.tmdb_id ? 'movie' : null, tmdb_id: x.tmdb_id || null, season_number: null, show_id: null, skipped: false, priority: 'normal', catalog_new: false,
            status_review: false, legacy_status: null, genres: [], forms: [], franchises: [], companies: [], genre_candidates: [], metadata_owner_set: false };
          items().push(r);
          itemId = r.id;
        }
      }
      const removed = T('membership_removals').find(r => r.collection_id === c.id && ((showId && r.show_id === showId) || (itemId && r.item_id === itemId)));
      if (removed && !p_choice.add_back) refuse('removed_from_collection', 'You removed this from the collection earlier. Choose to add it back, or leave it out. Nothing was changed.');
      let added = false;
      if (!store.collection_memberships.some(m => m.collection_id === c.id && ((showId && m.show_id === showId) || (itemId && m.item_id === itemId)))) {
        store.collection_memberships.push({ id: id(), collection_id: c.id, show_id: showId, item_id: itemId, created_at: now() });
        added = true;
      }
      store.membership_removals = T('membership_removals').filter(r => r !== removed);
      const shown = title || (showId ? showOf(showId).title : items().find(r => r.id === itemId).title);
      names.filter(x => cuNorm(x) && cuNorm(x) !== cuNorm(shown)).forEach(x => {
        if (!T('record_aliases').some(a => a.match_text === cuNorm(x) && ((showId && a.show_id === showId) || (itemId && a.item_id === itemId)))) {
          T('record_aliases').push({ id: id(), show_id: showId, item_id: itemId, alias: x.trim(), match_text: cuNorm(x), evidence: clone(f.evidence), created_at: now() });
        }
      });
      Object.assign(f, { show_id: showId, item_id: itemId }); // the accepted finding names its record from now on
      return finish(f, 'applied', 'accepted', '', { outcome: p_choice.action, show_id: showId, item_id: itemId, membership_added: added });
    },
    library_cu_set_finding_status({ p_id, p_expected_status, p_status, p_note = '', p_exclusion = null }) {
      requireOn('library_cu_set_finding_status');
      if (!p_id || !['not_now', 'dismissed', 'excluded', 'pending'].includes(p_status)) invalid('finding status');
      const f = T('update_findings').find(x => x.id === p_id);
      if (!f) refuse('target_missing', 'This finding is no longer saved, so nothing was changed.');
      if (f.status !== p_expected_status) changed();
      const allowed = (['pending', 'needs_evidence', 'conflict', 'needs_research'].includes(f.status) && ['not_now', 'dismissed', 'excluded'].includes(p_status))
        || (f.status === 'not_now' && ['pending', 'dismissed'].includes(p_status)) || (f.status === 'set_aside' && p_status === 'dismissed');
      if (!allowed) refuse('invalid_transition', 'This finding can\'t be changed that way. Nothing was changed.');
      if (p_status === 'excluded') {
        if (!f.collection_id || !p_exclusion || !['title', 'every_version', 'series_and_spinoffs'].includes(p_exclusion.kind) || !String(p_exclusion.title || '').trim()) invalid('an exclusion needs a collection, a kind and a title');
        const mt = cuNorm(p_exclusion.title);
        if (!T('collection_exclusions').some(e => e.collection_id === f.collection_id && e.kind === p_exclusion.kind && e.match_text === mt)) {
          T('collection_exclusions').push({ id: id(), collection_id: f.collection_id, kind: p_exclusion.kind, title: p_exclusion.title.trim(), match_text: mt,
            tmdb_id: p_exclusion.tmdb_id || null, media: p_exclusion.media || 'any', note: p_exclusion.note || '', created_at: now() });
        }
      }
      Object.assign(f, { status: p_status, reason: p_note || '', decided_at: now(), last_seen_at: now() });
      return clone(f);
    },
    library_cu_register_brief({ p_id, p_collections, p_checks = [] }) {
      requireOn('library_cu_register_brief');
      const checks = p_checks == null ? [] : p_checks;
      if (!p_id || !Array.isArray(p_collections) || !p_collections.length || !Array.isArray(checks) || checks.length > 5000
        || checks.some(c => !c || typeof c !== 'object' || Array.isArray(c) || !/^rec:(show|season|item):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.subject || '')
          || !['renewal', 'dates', 'cancellation'].includes(c.check) || ('title' in c && (typeof c.title !== 'string' || !c.title.trim() || c.title.length > 300))
          || Object.keys(c).some(k => !['subject', 'check', 'title'].includes(k)))) invalid('brief');
      const sweeps = [];
      const out = p_collections.map(c => {
        const d = currentDef(c);
        if (!d || d.mode === 'manual') refuse('no_definition', 'A chosen collection has no confirmed Follow or Discover definition, so no brief was made.');
        if (d.mode === 'discover') (d.rules || []).forEach(r => sweeps.push({ subject: `rule:${r.id}`, check: 'sweep', title: r.label || r.id }));
        return { collection_id: c, definition_id: d.id, definition_version: d.version, mode: d.mode, rule_hashes: clone(d.rule_hashes), evidence_hash: d.evidence_hash };
      });
      T('research_briefs').push({ id: p_id, exported_at: now(), collections: out, checks: clone(checks).concat(sweeps) });
      return { id: p_id, collections: clone(out) };
    },
    library_cu_record_findings({ p_brief_id, p_file_sha256, p_findings }) {
      requireOn('library_cu_record_findings');
      if (!p_brief_id || !/^[0-9a-f]{64}$/.test(p_file_sha256 || '') || !Array.isArray(p_findings)) invalid('findings import');
      const b = T('research_briefs').find(x => x.id === p_brief_id);
      if (!b) refuse('unknown_brief', 'This findings file names a brief this account didn\'t export, so nothing was imported.');
      if (T('research_imports').some(x => x.file_sha256 === p_file_sha256)) refuse('already_imported', 'This findings file was already imported, so nothing changed.');
      const out = [], counts = {};
      for (const x of p_findings) {
        const bc = b.collections.find(c => c.collection_id === x.collection_id);
        if (!/^[a-z_]+:[0-9a-f]{64}$/.test(x.fingerprint || '') || !bc) invalid(`finding ${x.fingerprint}`);
        let f = T('update_findings').find(y => y.fingerprint === x.fingerprint);
        if (!f) {
          f = { id: id(), fingerprint: x.fingerprint, source: 'research', kind: x.kind, status: x.routed_status, reason: x.reason || '', collection_id: x.collection_id,
            show_id: x.show_id || null, item_id: x.item_id || null, season_id: x.season_id || null, subject: clone(x.subject), proposed: clone(x.proposed || {}),
            expected: clone(x.expected || {}), evidence: clone(x.evidence), assessment: clone(x.assessment), rule_id: x.rule_id || null, definition_version: bc.definition_version,
            rule_hash: x.rule_id ? bc.rule_hashes[x.rule_id] : null, evidence_hash: bc.evidence_hash, brief_id: b.id, first_seen_at: now(), last_seen_at: now(),
            decided_at: null, applied_at: null, result: null };
          T('update_findings').push(f);
        } else {
          const fresh = x.evidence.filter(e => !f.evidence.some(o => o.url === e.url));
          const newer = fresh.some(e => f.decided_at && e.published_on > f.decided_at.slice(0, 10));
          const final = ['excluded', 'accepted', 'applied', 'dismissed'].includes(f.status);
          const routed = x.routed_status;
          const status = final ? f.status : f.status === 'not_now' ? (newer && routed === 'pending' ? 'pending' : 'not_now')
            : f.status === 'set_aside' ? (b.exported_at > (f.decided_at || f.last_seen_at) && routed === 'pending' ? 'pending' : 'set_aside')
            : ['needs_evidence', 'conflict', 'needs_research'].includes(f.status) ? (routed === 'pending' && (fresh.length || f.evidence_hash !== bc.evidence_hash || f.rule_hash !== (f.rule_id ? bc.rule_hashes[f.rule_id] : null)) ? 'pending' : routed)
            : routed;
          const reopened = status === 'pending' && f.status !== 'pending';
          if (!final) { f.evidence = f.evidence.concat(clone(fresh)); f.assessment = clone(x.assessment); }
          if (status !== f.status) f.reason = x.reason || '';
          if (reopened) Object.assign(f, { definition_version: bc.definition_version, rule_hash: f.rule_id ? bc.rule_hashes[f.rule_id] : f.rule_hash, evidence_hash: bc.evidence_hash, brief_id: b.id });
          Object.assign(f, { status, last_seen_at: now() });
        }
        out.push({ fingerprint: f.fingerprint, id: f.id, status: f.status });
        counts[f.status] = (counts[f.status] || 0) + 1;
      }
      T('research_imports').push({ id: id(), brief_id: b.id, file_sha256: p_file_sha256, imported_at: now(), counts });
      return { findings: out, counts };
    },
    library_cu_save_definition({ p_collection_id, p_expected_version, p_mode, p_rules, p_evidence, p_summary }) {
      requireOn('library_cu_save_definition');
      if (!store.personal_collections.some(c => c.id === p_collection_id)) refuse('org_not_found', 'This collection is no longer available, so nothing was changed.');
      if (((currentDef(p_collection_id) || {}).version || 0) !== p_expected_version) changed();
      if (!['manual', 'follow', 'discover'].includes(p_mode) || !Array.isArray(p_rules) || !p_evidence || !Array.isArray(p_evidence.official_domains) || !Array.isArray(p_evidence.trades)) invalid('rules or evidence settings');
      const d = { id: id(), collection_id: p_collection_id, version: p_expected_version + 1, mode: p_mode, rules: clone(p_rules), evidence: clone(p_evidence),
        summary: p_summary || '', rule_hashes: ruleHashes(p_rules), evidence_hash: md5(jsonbText(p_evidence)), confirmed_at: now() };
      T('collection_definitions').push(d);
      return clone(d);
    },
    library_cu_set_exclusion({ p_collection_id, p_op, p_exclusion }) {
      requireOn('library_cu_set_exclusion');
      if (!store.personal_collections.some(c => c.id === p_collection_id)) refuse('org_not_found', 'This collection is no longer available, so nothing was changed.');
      if (p_op === 'add') {
        const mt = cuNorm(p_exclusion.title);
        if (T('collection_exclusions').some(e => e.collection_id === p_collection_id && e.kind === p_exclusion.kind && e.match_text === mt)) return { added: false, id: null };
        const e = { id: id(), collection_id: p_collection_id, kind: p_exclusion.kind, title: p_exclusion.title.trim(), match_text: mt, tmdb_id: p_exclusion.tmdb_id || null,
          media: p_exclusion.media || 'any', note: p_exclusion.note || '', created_at: now() };
        T('collection_exclusions').push(e);
        return { added: true, id: e.id };
      }
      const i = T('collection_exclusions').findIndex(e => e.id === p_exclusion.id && e.collection_id === p_collection_id && e.title === p_exclusion.title);
      if (i >= 0) store.collection_exclusions.splice(i, 1);
      return { removed: i >= 0, id: i >= 0 ? p_exclusion.id : null };
    },
    library_cu_save_hold({ p_hold }) {
      requireOn('library_cu_save_hold');
      holdShapeCheck(p_hold);
      // As private.cu1_insert_hold stores them: subject_label nullif(btrim), decision btrim, protected_value as given.
      const h = { id: id(), kind: p_hold.kind, collection_id: p_hold.collection_id || null, show_id: p_hold.show_id || null, item_id: p_hold.item_id || null,
        subject_label: p_hold.subject_label && String(p_hold.subject_label).trim() ? String(p_hold.subject_label).trim() : null, field: p_hold.field || null,
        protected_value: p_hold.protected_value === undefined ? null : p_hold.protected_value, decision: String(p_hold.decision).trim(),
        effect: p_hold.effect, reopen: clone(p_hold.reopen), decided_on: p_hold.decided_on || null, created_at: now() };
      T('update_holds').push(h);
      return clone(h);
    },
    // db/cu1b_hold_edit.sql: in place (same id and created_at), every editable value as expected, update_holds' checks.
    library_cu_update_hold({ p_id, p_expected, p_hold }) {
      requireOn('library_cu_update_hold');
      const obj = x => x && typeof x === 'object' && !Array.isArray(x);
      if (!p_id || !obj(p_expected) || !obj(p_hold) || Object.keys(p_hold).some(k => !HOLD_KEYS.includes(k))
        || Object.keys(p_expected).some(k => !HOLD_KEYS.includes(k)) || HOLD_KEYS.some(k => !(k in p_expected))) invalid('hold');
      const h = T('update_holds').find(x => x.id === p_id);
      if (!h) changed();
      if (HOLD_KEYS.some(k => jsonbText(h[k] === undefined ? null : h[k]) !== jsonbText(p_expected[k] === undefined ? null : p_expected[k]))) changed();
      holdShapeCheck(p_hold);
      Object.assign(h, { kind: p_hold.kind, collection_id: p_hold.collection_id || null, show_id: p_hold.show_id || null, item_id: p_hold.item_id || null,
        subject_label: p_hold.subject_label && String(p_hold.subject_label).trim() ? String(p_hold.subject_label).trim() : null, field: p_hold.field || null, protected_value: p_hold.protected_value === undefined ? null : p_hold.protected_value,
        decision: String(p_hold.decision).trim(), effect: p_hold.effect, reopen: clone(p_hold.reopen), decided_on: p_hold.decided_on || null });
      return clone(h);
    },
    library_cu_delete_hold({ p_id, p_expected_decision }) {
      requireOn('library_cu_delete_hold');
      const i = T('update_holds').findIndex(h => h.id === p_id && h.decision === p_expected_decision);
      if (i < 0) changed();
      store.update_holds.splice(i, 1);
      return { deleted: p_id };
    },
    library_cu_set_show_settings({ p_show_id, p_expected, p_follow_when_skipped, p_clear_ended_flag }) {
      requireOn('library_cu_set_show_settings');
      if (!showOf(p_show_id)) refuse('target_missing', 'This show is no longer on your list, so nothing was changed.');
      let st = T('show_update_settings').find(x => x.show_id === p_show_id);
      if (!!(st && st.follow_when_skipped) !== !!p_expected.follow_when_skipped || !!(st && st.new_season_after_ended_at) !== !!p_expected.flagged) changed();
      if (!st) { st = { id: id(), show_id: p_show_id, follow_when_skipped: false, new_season_after_ended_at: null, updated_at: now() }; T('show_update_settings').push(st); }
      Object.assign(st, { follow_when_skipped: !!p_follow_when_skipped, new_season_after_ended_at: p_clear_ended_flag ? null : st.new_season_after_ended_at, updated_at: now() });
      return clone(st);
    },
    library_cu_import_setup({ p_doc }) {
      requireOn('library_cu_import_setup');
      if (!p_doc || !Array.isArray(p_doc.definitions) || !Array.isArray(p_doc.exclusions) || !Array.isArray(p_doc.holds)) invalid('setup');
      for (const d of p_doc.definitions) if (currentDef(d.collection_id)) refuse('definition_exists', 'A collection in the setup already has a definition, so nothing was imported.');
      p_doc.definitions.forEach(d => T('collection_definitions').push({ id: id(), collection_id: d.collection_id, version: 1, mode: d.mode, rules: clone(d.rules),
        evidence: clone(d.evidence), summary: d.summary || '', rule_hashes: ruleHashes(d.rules), evidence_hash: md5(jsonbText(d.evidence)), confirmed_at: now() }));
      let ex = 0;
      p_doc.exclusions.forEach(e => { const r = fns.library_cu_set_exclusion({ p_collection_id: e.collection_id, p_op: 'add', p_exclusion: e }); if (r.added) ex++; });
      p_doc.holds.forEach(h => fns.library_cu_save_hold({ p_hold: h }));
      if (!T('update_setup').length) T('update_setup').push({ id: id(), setup_confirmed_at: now(), source: 'setup_file' });
      else store.update_setup[0].setup_confirmed_at = now();
      return { definitions: p_doc.definitions.length, exclusions: ex, holds: p_doc.holds.length };
    }
  };
  return fns;
}

module.exports = { CU1_PHASE, CU1_TABLES, cu1Handlers, cuNorm, ruleHashes, jsonbText, md5 };
