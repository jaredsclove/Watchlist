// ─── Collection updates (item 4): Settings — definitions, holds, briefs, imports ──
// Settings → Collection updates. Ordinary form controls define each collection's updates: a mode
// (Manual, Follow existing shows, Discover additions), typed rules (franchise, platform premiere,
// person and role, explicit list, or a written rule for anything the forms can't express),
// exclusions and evidence settings, with a readable summary and a TMDB preview before the owner
// confirms; each confirmation saves a new version (library_cu_save_definition). The card also
// downloads research briefs, imports findings and the setup file, lists holds and the Skipped shows
// that are still checked, and opens the review. Dialog state: cuModal (watchlist.html).

const CU_MODES = [['manual', 'Manual', 'No research. Refresh shows still checks its shows with TMDB.'],
  ['follow', 'Follow existing shows', 'Research covers the shows already in it: renewals, dates, cancellations.'],
  ['discover', 'Discover additions', 'Also finds new titles that meet its rules, for your review.']];
const CU_RULE_TYPES = [['person_role', 'Person and role'], ['franchise', 'Franchise'], ['platform_premiere', 'Platform premiere'],
  ['explicit_list', 'Explicit list'], ['written', 'Written rule']];
const CU_SERIES_ROLES = [['creator', 'Creator'], ['co_creator', 'Co-creator'], ['showrunner', 'Showrunner'], ['writer', 'Writer'], ['executive_producer', 'Executive producer']];
const CU_FILM_ROLES = [['director', 'Director'], ['writer', 'Writer'], ['producer', 'Producer']];
const CU_DEFAULT_TRADES = [
  { id: 'variety', name: 'Variety', domains: ['variety.com'] }, { id: 'deadline', name: 'Deadline', domains: ['deadline.com'] },
  { id: 'thr', name: 'The Hollywood Reporter', domains: ['hollywoodreporter.com'] }, { id: 'tvline', name: 'TVLine', domains: ['tvline.com'] }];
const CU_EXCLUSION_KINDS = [['title', 'This title only'], ['every_version', 'Every version (any title containing it)'], ['series_and_spinoffs', 'The series and its spin-offs']];

// ── The Settings card ──
function cuSettingsSectionHtml() {
  return `<section class="settings-card" aria-labelledby="settingsCuTitle">
        <h3 id="settingsCuTitle">Collection updates</h3>
        <p class="settings-text">TV → + Add → Refresh shows checks every show with TMDB (new seasons, dates, episode lists and matches). Announcements come from a research brief you give to Claude; you import the findings it returns. New shows and films always wait for your review.</p>
        <p class="settings-status" id="settingsCuStatus" role="status"></p>
        <div class="settings-actions">
          <button class="btn settings-cu-review" onclick="openCuReview(this)">Review findings…</button>
          <button class="btn settings-cu-collections" onclick="openCuDialog('collections', this)">Collections and rules…</button>
          <button class="btn settings-cu-brief" onclick="openCuDialog('brief', this)">Download research brief…</button>
          <button class="btn settings-cu-findings" onclick="cuPickFile('findings')">Import findings file…</button>
          <button class="btn settings-cu-setup" onclick="cuPickFile('setup')">Import setup file…</button>
        </div>
      </section>`;
}
// The card's status line, from what this page has already read (entering Settings sends no request):
// the newest collection-updates state (cuLastState) and the published governance.
function updateCuSettingsStatus() {
  const el = document.getElementById('settingsCuStatus');
  if (!el) return;
  if (!cuLastState) { el.className = 'settings-status'; el.textContent = 'Review findings shows what waits for your decision.'; return; }
  const gated = !cuLastState.setup && (libraryGovernance.shows.size || libraryGovernance.films.size);
  const open = cuLastState.open, blocked = cuLastState.blocked || 0;
  el.className = `settings-status${gated ? ' warn' : ''}`;
  el.textContent = `${gated ? 'Automatic updates for catalog shows are paused until the collection setup is imported. ' : ''}${open ? `${open} finding${open === 1 ? '' : 's'} wait${open === 1 ? 's' : ''} for your decision.` : 'Nothing waits for your decision.'}${blocked ? ` ${blocked} wait${blocked === 1 ? 's' : ''} for more research (blocked by the evidence standard).` : ''}`;
}

// ── Files ──
function cuPickFile(kind) {
  const input = document.getElementById('cuFileInput');
  if (!input) return;
  input.dataset.kind = kind;
  input.click();
}
async function handleCuFileSelected(event) {
  const file = event.target.files && event.target.files[0];
  const kind = event.target.dataset.kind;
  event.target.value = '';
  if (!file) return;
  const text = await file.text();
  if (kind === 'findings') return cuRunFindingsImport(text);
  if (kind === 'setup') return cuPreviewSetup(text);
}
async function cuRunFindingsImport(text) {
  cuModal = { kind: 'message', session: (cuModal && cuModal.session || 0) + 1, title: 'Import findings', html: '<div class="modal-progress">Checking the file…</div>' };
  cuRenderModal();
  const session = cuModal.session;
  let out;
  try { out = await cuImportFindings(text); } catch (e) { out = { problems: [`The file couldn’t be imported (${e.message}). Nothing was changed.`] }; }
  if (!cuModal || cuModal.session !== session) return;
  cuModal.html = out.problems ? `<div class="modal-error">${out.problems.map(esc).join('<br>')}</div>` : cuResultsHtml(out.results);
  cuRenderModal();
}
async function cuPreviewSetup(text) {
  cuModal = { kind: 'setup', session: (cuModal && cuModal.session || 0) + 1, state: 'loading' };
  cuRenderModal();
  const session = cuModal.session;
  let doc;
  try { doc = JSON.parse(text); } catch (e) { doc = null; }
  try {
    const [lib, colls, memberships] = await Promise.all([readLibrary(), readPersonalCollections(), fetchAllRowsStrict('collection_memberships')]);
    if (!cuModal || cuModal.session !== session) return;
    Object.assign(cuModal, { state: 'ready', resolved: cuResolveSetup(doc, lib, colls, memberships) });
  } catch (e) {
    if (!cuModal || cuModal.session !== session) return;
    Object.assign(cuModal, { state: 'failed', message: e.message });
  }
  cuRenderModal();
}
async function cuConfirmSetup() {
  const m = cuModal;
  if (!m || m.kind !== 'setup' || !m.resolved) return;
  let res, failure;
  try { res = await cuImportSetup(m.resolved); } catch (e) { failure = libraryFailure(e, 'Importing the setup', 'Collection updates'); }
  if (cuModal !== m) return;
  m.done = failure ? { error: failure.text } : res ? { text: `Imported ${res.definitions} definition${res.definitions === 1 ? '' : 's'}, ${res.exclusions} exclusion${res.exclusions === 1 ? '' : 's'} and ${res.holds} hold${res.holds === 1 ? '' : 's'}.` }
    : { error: LANE_BUSY_TEXT(writeLane ? writeLane.label : 'A change') };
  if (res) showSaved();
  cuRenderModal();
  updateCuSettingsStatus();
}

// ── The dialogs (collections and rules, the definition editor, the brief, the setup preview) ──
async function openCuDialog(kind, opener) {
  cuModal = { kind, session: (cuModal && cuModal.session || 0) + 1, opener: opener || null, state: 'loading' };
  cuRenderModal();
  const session = cuModal.session;
  try {
    const [lib, st, colls] = await Promise.all([readLibrary(), cuReadState(), readPersonalCollections()]);
    if (!cuModal || cuModal.session !== session) return;
    Object.assign(cuModal, { state: 'ready', lib, st, colls, chosen: new Set() });
  } catch (e) {
    if (!cuModal || cuModal.session !== session) return;
    Object.assign(cuModal, { state: 'failed', message: e.message });
  }
  cuRenderModal();
}
function cuSettingsModalHtml() {
  const m = cuModal;
  const head = t => `<div class="modal-title" id="cuTitle">${esc(t)}</div>`;
  const close = '<div class="modal-actions"><button class="btn" onclick="closeCuModal()">Close</button></div>';
  if (m.kind === 'message') return `${head(m.title)}${m.html}${close}`;
  if (m.state === 'loading') return `${head('Collection updates')}<div class="modal-progress">Reading…</div>`;
  if (m.state === 'failed') return `${head('Collection updates')}<div class="modal-error">Couldn’t read your collections (${esc(m.message)}). Nothing was changed.</div>${close}`;
  if (m.kind === 'setup') return cuSetupPreviewHtml(m) + close;
  if (m.kind === 'brief') return cuBriefDialogHtml(m) + close;
  if (m.kind === 'editor') return cuEditorHtml(m);
  return cuCollectionsHtml(m) + close;
}
function cuModeLabel(mode) { return (CU_MODES.find(x => x[0] === mode) || [null, 'Manual'])[1]; }

function cuCollectionsHtml(m) {
  const rows = m.colls.filter(c => !c.archived_at).map(c => {
    const d = m.st.definitions.get(c.id);
    return `<li class="cu-item"><div class="cu-item-text">${esc(c.name)}</div>
      <div class="cu-item-why">${d ? `${esc(cuModeLabel(d.mode))} · version ${d.version}${d.summary ? ` — ${esc(d.summary)}` : ''}` : 'No definition: Manual'}</div>
      <div class="cu-item-actions"><button class="btn" onclick="cuOpenEditor('${esc(c.id)}')">Edit updates…</button></div></li>`;
  }).join('');
  const holds = m.st.holds.map(h => `<li class="cu-item"><div class="cu-item-text">${esc(cuHoldSubject(m, h))}</div>
      <div class="cu-item-why">${esc(h.kind.replace(/_/g, ' '))}: ${esc(h.decision)}${h.reopen ? ` · reopens: ${esc(cuReopenText(h.reopen))}` : ''}</div>
      <div class="cu-item-actions"><button class="btn" onclick="cuDeleteHold('${esc(h.id)}')">Remove hold</button></div></li>`).join('');
  const skipped = m.lib.shows.filter(s => s.status === 'skipped');
  const followed = skipped.filter(s => (m.st.settings.get(s.id) || {}).follow_when_skipped);
  return `<div class="modal-title" id="cuTitle">Collections and rules</div>
    <ul class="cu-review-list">${rows || '<li>No collections.</li>'}</ul>
    <div class="modal-label">Holds (${m.st.holds.length})</div>
    ${holds ? `<ul class="cu-review-list">${holds}</ul>` : '<p class="settings-text">No holds. The collection setup file brings the built-in collections’ decisions.</p>'}
    <div class="modal-label">Skipped shows still checked for new seasons</div>
    <p class="settings-text">A Skipped show gets no new seasons automatically unless you choose it here.</p>
    <ul class="cu-review-list">${followed.map(s => `<li class="cu-item">${esc(s.title)} <button class="btn" onclick="cuSetFollow('${esc(s.id)}', false)">Stop checking</button></li>`).join('') || '<li>None.</li>'}</ul>
    ${skipped.length > followed.length ? `<div class="settings-actions"><select id="cuFollowPick" aria-label="A Skipped show">${skipped.filter(s => !followed.includes(s)).map(s => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('')}</select>
      <button class="btn" onclick="cuSetFollow((document.getElementById('cuFollowPick') || {}).value, true)">Keep checking this show</button></div>` : ''}`;
}
function cuHoldSubject(m, h) {
  const show = h.show_id && m.lib.showsById.get(h.show_id), row = h.item_id && m.lib.rows.find(r => r.id === h.item_id);
  const coll = h.collection_id && m.colls.find(c => c.id === h.collection_id);
  return [show && show.title, row && (row.show_id ? `${row.title} · ${row.season}` : row.title), !show && !row && h.subject_label, h.subject_label && show ? h.subject_label : null,
    coll && `(${coll.name})`].filter(Boolean).join(' · ');
}
function cuReopenText(r) {
  return { official_date_or_window: 'an official date or window', official_or_two_trades: 'an official announcement or two independent trades',
    named_source: `an announcement from ${r.source_name || (r.source_domains || []).join(', ')}`, renewal_cast_date_cancellation: 'a renewal, cast news, a date or a cancellation',
    owner_only: 'only when you ask', new_evidence: 'new qualifying evidence' }[r.on] || r.on;
}
function cuDeleteHold(id) {
  const h = cuModal && cuModal.st.holds.find(x => x.id === id);
  if (!h) return;
  return cuDialogWrite('Remove hold', () => sbRpc('library_cu_delete_hold', { p_id: id, p_expected_decision: h.decision }));
}
function cuSetFollow(showId, on) {
  if (!showId) return;
  const st = cuModal.st.settings.get(showId);
  return cuDialogWrite(on ? 'Keep checking' : 'Stop checking', () => sbRpc('library_cu_set_show_settings', { p_show_id: showId,
    p_expected: { follow_when_skipped: !!(st && st.follow_when_skipped), flagged: !!(st && st.new_season_after_ended_at) },
    p_follow_when_skipped: !!on, p_clear_ended_flag: false }));
}
// One change through the write lane, then the dialog's data read again.
async function cuDialogWrite(label, fn) {
  const m = cuModal;
  if (!m) return;
  const session = m.session;
  let failure = null, res;
  const ran = await runWrite(label, async () => { try { res = await fn(); return true; } catch (e) { failure = libraryFailure(e, label, 'Collection updates'); return true; } });
  if (!cuModal || cuModal.session !== session) return res;
  cuModal.message = !ran ? LANE_BUSY_TEXT(writeLane ? writeLane.label : label) : failure ? failure.text : `${label}: saved.`;
  cuModal.messageError = !ran || !!failure;
  if (ran && !failure) showSaved();
  try { const st = await cuReadState(); if (cuModal && cuModal.session === session) cuModal.st = st; } catch (e) { /* message stands */ }
  cuRenderModal();
  return res;
}

// ── The definition editor ──
function cuOpenEditor(collectionId) {
  const m = cuModal;
  const d = m.st.definitions.get(collectionId);
  Object.assign(m, { kind: 'editor', collectionId, message: '', preview: null,
    draft: { version: d ? d.version : 0, mode: d ? d.mode : 'manual', rules: JSON.parse(JSON.stringify(d ? d.rules : [])),
      evidence: JSON.parse(JSON.stringify(d ? d.evidence : { standard: 'official_or_two_trades', official_domains: [], trades: CU_DEFAULT_TRADES })) } });
  cuRenderModal();
}
const cuList = v => String(v || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
function cuRuleFieldsHtml(r, i) {
  const f = (label, name, value, attrs = '') => `<label class="cu-field">${esc(label)} <input type="text" data-cu-rule="${i}" data-cu-key="${name}" value="${esc(value == null ? '' : value)}" ${attrs}></label>`;
  const chk = (label, name, on) => `<label class="ww-option"><input type="checkbox" data-cu-rule="${i}" data-cu-key="${name}"${on ? ' checked' : ''}> ${esc(label)}</label>`;
  const multi = (name, opts, list) => opts.map(([v, l]) => `<label class="ww-option"><input type="checkbox" data-cu-rule="${i}" data-cu-key="${name}" data-cu-value="${v}"${(list || []).includes(v) ? ' checked' : ''}> ${esc(l)}</label>`).join('');
  const media = `<label class="cu-field">Media <select data-cu-rule="${i}" data-cu-key="media">${[['series', 'Series'], ['films', 'Films'], ['both', 'Both']].map(([v, l]) => `<option value="${v}"${(r.media || 'series') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
  switch (r.type) {
    case 'person_role': return f('Person', 'person', r.person) + f('TMDB person id', 'person_tmdb_id', r.person_tmdb_id, 'inputmode="numeric"')
      + `<div class="cu-sub">Series roles that qualify</div>${multi('series_roles', CU_SERIES_ROLES, r.series_roles)}`
      + `<div class="cu-sub">Film roles that qualify</div>${multi('film_roles', CU_FILM_ROLES, r.film_roles)}`
      + `<label class="cu-field">Writer credit <select data-cu-rule="${i}" data-cu-key="writer_threshold"><option value="series"${(r.writer_threshold || 'series') === 'series' ? ' selected' : ''}>a series-level writing credit</option><option value="episode"${r.writer_threshold === 'episode' ? ' selected' : ''}>at least one episode</option></select></label>`
      + chk('Include announced titles not yet on TMDB', 'announced', r.announced !== false);
    case 'franchise': return f('Root series', 'root_title', r.root_title) + f('Root TMDB id', 'root_tmdb_id', r.root_tmdb_id, 'inputmode="numeric"')
      + f('Named franchise titles (comma-separated)', 'title_roots', (r.title_roots || []).join(', '))
      + chk('Also series an official source identifies as part of the franchise', 'official_spinoffs', r.official_spinoffs !== false)
      + `<div class="cu-sub">Counts as part of it</div>${multi('relations', [['spinoff', 'Spin-off'], ['prequel', 'Prequel'], ['sequel', 'Sequel']], r.relations || ['spinoff'])}`
      + f('Networks to search (comma-separated; where to look, not a limit)', 'search_networks', (r.search_networks || []).join(', ')) + media
      + chk('Include announced titles not yet on TMDB', 'announced', r.announced !== false);
    case 'platform_premiere': return f('Platform', 'platform', r.platform) + f('TMDB network id', 'platform_tmdb_network_id', r.platform_tmdb_network_id, 'inputmode="numeric"')
      + f('Premiere region (two letters)', 'region', r.region || 'US', 'maxlength="2"') + media
      + f('Genres (“all”, or comma-separated)', 'genres', Array.isArray(r.genres) ? r.genres.join(', ') : 'all')
      + '<p class="settings-text">Premiere means the platform first released it in that region; a show only available there later doesn’t qualify.</p>';
    case 'explicit_list': return `<label class="cu-field">Titles (one per line)<textarea data-cu-rule="${i}" data-cu-key="titles" rows="4">${esc((r.titles || []).map(t => t.title).join('\n'))}</textarea></label>`;
    case 'written': return `<label class="cu-field">Rule, as you’d explain it<textarea data-cu-rule="${i}" data-cu-key="text" rows="3">${esc(r.text || '')}</textarea></label>
      <p class="settings-text">Claude researches a written rule as written; what it finds is labelled and always waits for your review.</p>`;
  }
  return '';
}
// The draft from the form (read back before every redraw and before confirming).
function cuReadEditor() {
  const m = cuModal;
  if (!m || m.kind !== 'editor') return;
  const mode = document.querySelector('input[name="cuMode"]:checked');
  if (mode && mode.value) m.draft.mode = mode.value;
  m.draft.rules.forEach((r, i) => {
    const els = Array.from(document.querySelectorAll(`[data-cu-rule="${i}"]`));
    const byKey = {};
    els.forEach(el => { (byKey[el.dataset.cuKey] = byKey[el.dataset.cuKey] || []).push(el); });
    for (const [k, list] of Object.entries(byKey)) {
      const el = list[0];
      if (list.some(x => x.dataset.cuValue)) r[k] = list.filter(x => x.checked).map(x => x.dataset.cuValue);
      else if (el.type === 'checkbox') r[k] = !!el.checked;
      else if (['person_tmdb_id', 'root_tmdb_id', 'platform_tmdb_network_id'].includes(k)) { const n = parseInt(el.value, 10); if (Number.isInteger(n) && n > 0) r[k] = n; else delete r[k]; }
      else if (['title_roots', 'search_networks'].includes(k)) r[k] = cuList(el.value);
      else if (k === 'genres') { const g = cuList(el.value); r[k] = !g.length || (g.length === 1 && /^all$/i.test(g[0])) ? 'all' : g; }
      else if (k === 'titles') r[k] = String(el.value || '').split('\n').map(x => x.trim()).filter(Boolean).map(title => ({ title }));
      else if (k === 'region') r[k] = String(el.value || '').trim().toUpperCase();
      else if (el.value.trim()) r[k] = el.value.trim(); else delete r[k];
    }
  });
  const dom = document.getElementById('cuOfficialDomains');
  if (dom) m.draft.evidence.official_domains = cuList(dom.value).map(d => d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''));
}
// A readable summary from the fields (no interpretation: exactly what the rules say).
function cuSummary(draft, exclusions) {
  if (draft.mode === 'manual') return 'Manual: no research; Refresh shows still checks its shows with TMDB.';
  const roleList = (list, opts) => (list || []).map(v => (opts.find(x => x[0] === v) || [0, v])[1].toLowerCase()).join(' or ');
  const parts = draft.rules.map(r => {
    switch (r.type) {
      case 'person_role': return [r.series_roles && r.series_roles.length ? `series ${r.person || 'the person'} is credited on as ${roleList(r.series_roles, CU_SERIES_ROLES)}` : '',
        r.film_roles && r.film_roles.length ? `films ${r.person || 'the person'} is credited on as ${roleList(r.film_roles, CU_FILM_ROLES)}` : ''].filter(Boolean).join('; ');
      case 'franchise': return `the named ${r.root_title || 'franchise'} titles${(r.title_roots || []).length ? ` (${r.title_roots.join(', ')})` : ''}${r.official_spinoffs !== false ? `, plus series an official source identifies as a ${(r.relations || ['spinoff']).join(', ').replace('spinoff', 'spin-off')} of ${r.root_title || 'it'}` : ''}`;
      case 'platform_premiere': return `${(r.media || 'series') === 'series' ? 'series' : r.media} that premiered on ${r.platform || 'the platform'} in ${(r.region || 'US') === 'US' ? 'the US' : r.region}${Array.isArray(r.genres) ? ` (${r.genres.join(', ')})` : ', any genre'}; not titles that premiered elsewhere and later stream there`;
      case 'explicit_list': return `only the listed titles (${(r.titles || []).length})`;
      case 'written': return `as written: “${r.text || ''}”`;
    }
    return '';
  }).filter(Boolean);
  const excl = (exclusions || []).map(e => `${e.title}${e.kind === 'every_version' ? ' (every version)' : e.kind === 'series_and_spinoffs' ? ' and its spin-offs' : ''}`);
  return `${cuModeLabel(draft.mode)}: ${draft.mode === 'follow' ? 'research covers the shows already in it' : parts.length ? `includes ${parts.join('; and ')}` : 'no rules yet'}.${excl.length ? ` Excludes ${excl.join(', ')}.` : ''}`;
}
function cuEditorHtml(m) {
  const c = m.colls.find(x => x.id === m.collectionId) || {};
  const exclusions = m.st.exclusions.filter(e => e.collection_id === m.collectionId);
  const d = m.draft;
  const rules = d.rules.map((r, i) => `<fieldset class="cu-rule"><legend>${esc((CU_RULE_TYPES.find(x => x[0] === r.type) || [0, r.type])[1])}${r.label ? ` · ${esc(r.label)}` : ''}</legend>
      ${cuRuleFieldsHtml(r, i)}<button class="btn" onclick="cuRemoveRule(${i})">Remove this rule</button></fieldset>`).join('');
  const preview = m.preview ? `<div class="modal-label">TMDB preview</div><ul class="cu-review-list">${m.preview.map(p => `<li class="cu-item">${esc(p.text)}</li>`).join('') || '<li>Nothing found on TMDB for these rules.</li>'}</ul>` : '';
  return `<div class="modal-title" id="cuTitle">Updates for ${esc(c.name || 'this collection')}</div>
    ${m.message ? `<div class="${m.messageError ? 'modal-error' : 'banner'}">${esc(m.message)}</div>` : ''}
    <div class="modal-label">Mode</div>
    ${CU_MODES.map(([v, l, t]) => `<label class="cu-mode"><input type="radio" name="cuMode" value="${v}"${d.mode === v ? ' checked' : ''} onchange="cuReadEditor(); cuRenderModal()"> <span><strong>${esc(l)}</strong> — ${esc(t)}</span></label>`).join('')}
    ${d.mode === 'discover' ? `<div class="modal-label">Inclusion rules</div>${rules || '<p class="settings-text">No rules yet.</p>'}
      <div class="settings-actions"><select id="cuNewRuleType" aria-label="Rule type">${CU_RULE_TYPES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
      <button class="btn" onclick="cuAddRule()">Add rule</button></div>` : ''}
    <div class="modal-label">Exclusions</div>
    <ul class="cu-review-list">${exclusions.map(e => `<li class="cu-item">${esc(e.title)} — ${esc((CU_EXCLUSION_KINDS.find(x => x[0] === e.kind) || [0, e.kind])[1])}
      <button class="btn" onclick="cuRemoveExclusion('${esc(e.id)}')">Remove</button></li>`).join('') || '<li>None.</li>'}</ul>
    <div class="settings-actions"><input type="text" id="cuExclTitle" placeholder="Title to exclude" aria-label="Title to exclude">
      <select id="cuExclKind" aria-label="What to exclude">${CU_EXCLUSION_KINDS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
      <button class="btn" onclick="cuAddExclusion()">Add exclusion</button></div>
    <div class="modal-label">Evidence</div>
    <p class="settings-text">Announcements qualify on an official network, studio or show announcement, or reporting from two independent established trades (${esc(d.evidence.trades.map(t => t.name).join(', '))}). Rumours, filming sightings and predicted release patterns never qualify.</p>
    <label class="cu-field">Official sources for this collection (domains, comma-separated)<textarea id="cuOfficialDomains" rows="2">${esc(d.evidence.official_domains.join(', '))}</textarea></label>
    <div class="modal-label">What this means</div><p class="settings-text" id="cuSummary">${esc(cuSummary(d, exclusions))}</p>
    ${preview}
    <div class="modal-actions">
      <button class="btn" onclick="cuReadEditor(); cuEditorPreview()">Preview with TMDB</button>
      <button class="btn btn-accent" onclick="cuConfirmDefinition()">Confirm this definition</button>
      <button class="btn" onclick="openCuDialog('collections', null)">Back</button>
    </div>`;
}
function cuAddRule() {
  cuReadEditor();
  const type = (document.getElementById('cuNewRuleType') || {}).value || 'person_role';
  const used = new Set(cuModal.draft.rules.map(r => r.id));
  let n = 1; while (used.has(`${type.replace(/_/g, '-')}-${n}`)) n++;
  cuModal.draft.rules.push({ id: `${type.replace(/_/g, '-')}-${n}`, type, ...(type === 'platform_premiere' ? { region: 'US', media: 'series', genres: 'all' } : {}),
    ...(type === 'franchise' ? { official_spinoffs: true, relations: ['spinoff'], media: 'series', announced: true } : {}),
    ...(type === 'person_role' ? { series_roles: [], film_roles: [], announced: true } : {}), ...(type === 'explicit_list' ? { titles: [] } : {}) });
  cuRenderModal();
}
function cuRemoveRule(i) { cuReadEditor(); cuModal.draft.rules.splice(i, 1); cuRenderModal(); }
function cuAddExclusion() {
  cuReadEditor();
  const title = ((document.getElementById('cuExclTitle') || {}).value || '').trim(), kind = (document.getElementById('cuExclKind') || {}).value || 'title';
  if (!title) return;
  const m = cuModal;
  return cuDialogWrite('Add exclusion', () => sbRpc('library_cu_set_exclusion', { p_collection_id: m.collectionId, p_op: 'add', p_exclusion: { kind, title } }));
}
function cuRemoveExclusion(id) {
  cuReadEditor();
  const e = cuModal.st.exclusions.find(x => x.id === id);
  if (!e) return;
  return cuDialogWrite('Remove exclusion', () => sbRpc('library_cu_set_exclusion', { p_collection_id: e.collection_id, p_op: 'remove', p_exclusion: { id: e.id, title: e.title } }));
}
async function cuConfirmDefinition() {
  cuReadEditor();
  const m = cuModal, d = m.draft;
  const exclusions = m.st.exclusions.filter(e => e.collection_id === m.collectionId);
  const rules = d.mode === 'discover' ? d.rules : d.rules;
  await cuDialogWrite('Confirm definition', () => sbRpc('library_cu_save_definition', { p_collection_id: m.collectionId, p_expected_version: d.version,
    p_mode: d.mode, p_rules: rules, p_evidence: d.evidence, p_summary: cuSummary(d, exclusions) }));
  const now = cuModal && cuModal.st.definitions.get(m.collectionId);
  if (cuModal === m && now) m.draft.version = now.version;
  cuRenderModal();
}
// The TMDB-answerable parts of the rules: what qualifies and what doesn't, with the reason, and the
// collection's current members no rule matches (they stay as manual members).
async function cuEditorPreview() {
  const m = cuModal;
  const lines = [];
  for (const r of m.draft.rules) {
    try {
      if (r.type === 'person_role' && r.person_tmdb_id) {
        const d = await tmdbFetch(`/person/${r.person_tmdb_id}/combined_credits`);
        (d && d.crew || []).slice(0, 80).forEach(c => {
          const role = cuCreditRole(c); if (!role) return;
          const tv = c.media_type === 'tv', ok = tv ? (r.series_roles || []).includes(role) : (r.film_roles || []).includes(role);
          lines.push({ text: `${ok ? 'Qualifies' : 'Doesn’t qualify'}: ${c.name || c.title} (${tv ? 'series' : 'film'}, ${role.replace(/_/g, ' ')})` });
        });
      } else if (r.type === 'platform_premiere' && r.platform_tmdb_network_id) {
        const d = await tmdbFetch(`/discover/tv?with_networks=${Number(r.platform_tmdb_network_id)}&sort_by=first_air_date.desc`);
        (d && d.results || []).slice(0, 10).forEach(c => lines.push({ text: `Candidate (research must confirm a ${r.region || 'regional'} ${r.platform || 'platform'} premiere): ${c.name}${c.first_air_date ? ` (${c.first_air_date.slice(0, 4)})` : ''}` }));
      } else if (r.type === 'franchise' && r.root_title) {
        for (const t of [r.root_title, ...(r.title_roots || [])].slice(0, 5)) {
          const d = await tmdbFetch(`/search/tv?query=${encodeURIComponent(t)}`);
          (d && d.results || []).slice(0, 5).forEach(c => lines.push({ text: `${(r.title_roots || []).some(x => cuNorm(c.name).includes(cuNorm(x))) || cuNorm(c.name).includes(cuNorm(r.root_title)) ? 'Named franchise title' : 'Needs an official spin-off identification'}: ${c.name}` }));
        }
      }
    } catch (e) { lines.push({ text: `TMDB didn’t answer for one rule.` }); }
  }
  const members = m.st.memberships.filter(x => x.collection_id === m.collectionId);
  const named = new Set(lines.map(l => cuNorm(l.text.split(': ').slice(1).join(': ').replace(/ \(.*\)$/, ''))));
  members.forEach(x => {
    const t = x.show_id ? (m.lib.showsById.get(x.show_id) || {}).title : (m.lib.rows.find(r => r.id === x.item_id) || {}).title;
    if (t && !named.has(cuNorm(t))) lines.push({ text: `Current member not matched by a TMDB-answerable rule (stays as a manual member): ${t}` });
  });
  if (cuModal === m) { m.preview = lines.slice(0, 80); cuRenderModal(); }
}

// ── The brief dialog ──
function cuBriefDialogHtml(m) {
  const usable = m.colls.filter(c => { const d = m.st.definitions.get(c.id); return d && d.mode !== 'manual'; });
  return `<div class="modal-title" id="cuTitle">Download research brief</div>
    <p class="settings-text">The brief carries the chosen collections’ confirmed rules, exclusions, holds and existing items with the checks each needs. Give it to Claude with /refresh-catalogs; import the findings file it returns. The brief holds your library’s titles: keep it private.</p>
    ${usable.length ? `<ul class="cu-review-list">${usable.map(c => `<li class="cu-item"><label class="ww-option"><input type="checkbox" class="cu-brief-pick" value="${esc(c.id)}" checked> ${esc(c.name)} (${esc(cuModeLabel(m.st.definitions.get(c.id).mode))})</label></li>`).join('')}</ul>
      <div class="settings-actions"><button class="btn btn-accent" onclick="cuBriefDownload()">Download brief</button></div>`
      : '<p class="settings-text">No collection has a confirmed Follow or Discover definition yet.</p>'}
    ${m.message ? `<div class="${m.messageError ? 'modal-error' : 'banner'}">${esc(m.message)}</div>` : ''}`;
}
async function cuBriefDownload() {
  const m = cuModal;
  const ids = Array.from(document.querySelectorAll('.cu-brief-pick')).filter(x => x.checked).map(x => x.value);
  if (!ids.length) return;
  try { await cuDownloadBrief(ids); m.message = 'The brief was downloaded.'; m.messageError = false; }
  catch (e) { const fl = libraryFailure(e, 'The brief', 'Collection updates'); m.message = fl.text; m.messageError = true; }
  if (cuModal === m) cuRenderModal();
}

// ── The setup preview ──
function cuSetupPreviewHtml(m) {
  if (m.state === 'loading') return '<div class="modal-title" id="cuTitle">Import setup</div><div class="modal-progress">Reading…</div>';
  if (m.state === 'failed') return `<div class="modal-title" id="cuTitle">Import setup</div><div class="modal-error">${esc(m.message)}</div>`;
  const r = m.resolved;
  if (r.problems && r.problems.length) return `<div class="modal-title" id="cuTitle">Import setup</div><div class="modal-error">${r.problems.map(esc).join('<br>')}</div>`;
  if (m.done) return `<div class="modal-title" id="cuTitle">Import setup</div><div class="${m.done.error ? 'modal-error' : 'banner'}">${esc(m.done.error || m.done.text)}</div>`;
  return `<div class="modal-title" id="cuTitle">Import setup</div>
    <p class="settings-text">Check every item before importing. Each definition becomes version 1 of its collection’s updates.</p>
    <div class="modal-label">Definitions (${r.definitions.length})</div><ul class="cu-review-list">${r.definitions.map(d => `<li class="cu-item"><strong>${esc(d.name)}</strong> — ${esc(cuModeLabel(d.mode))}<div class="cu-item-why">${esc(d.summary)}</div></li>`).join('')}</ul>
    <div class="modal-label">Exclusions (${r.exclusions.length})</div><ul class="cu-review-list">${r.exclusions.map(e => `<li class="cu-item">${esc(e.title)} — ${esc((CU_EXCLUSION_KINDS.find(x => x[0] === e.kind) || [0, e.kind])[1])}</li>`).join('')}</ul>
    <div class="modal-label">Holds (${r.holds.length})</div><ul class="cu-review-list">${r.holds.map(h => `<li class="cu-item">${esc(h.label)} — ${esc(h.kind.replace(/_/g, ' '))}: ${esc(h.decision)}<div class="cu-item-why">Reopens: ${esc(cuReopenText(h.reopen || {}))}</div></li>`).join('')}</ul>
    ${r.unresolved.length ? `<div class="modal-warning">Not imported (fix the file to include them):<br>${r.unresolved.map(esc).join('<br>')}</div>` : ''}
    <div class="settings-actions"><button class="btn btn-accent" onclick="cuConfirmSetup()">Import these</button></div>`;
}
