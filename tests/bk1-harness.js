// BK1 books (db/bk1_books.sql) for the offline harness, written independently of the page's code so the tests can catch a
// page/database mismatch: the book tables, the library_book_* functions with the database's rules (expected values, one saved book
// per Hardcover id, exclusions that keep removed and dismissed titles out, review items that keep their status, declined
// suggestions that stay declined), and the books function (supabase/functions/books) as app.books(body) → answer (default: none).
// Used by tests/app-harness.js in the current phase (createApp's default).

const BK1_TABLES = ['book_entries', 'book_follows', 'book_sites', 'book_associations', 'book_decisions', 'book_findings', 'book_cache'];
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const STATUSES = ['want', 'reading', 'paused', 'finished', 'dropped'];
const KEY_RE = /^[a-z]{1,3}:\S+$/;
const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));

function bk1Handlers({ store, DbError }) {
  let seq = 0;
  const newId = () => `6b000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const refuse = (code, text) => { throw new DbError('P0001', `${code}: ${text}`); };
  const refuse_ = refuse;
  const invalid = what => { throw new DbError('22023', `invalid_input: ${what}`); };
  const changed = () => refuse('target_changed', 'This changed since the page showed it, so nothing was changed. Look at it again.');
  const now = () => new Date().toISOString();
  const entryOf = id => store.book_entries.find(e => e.id === id) || refuse('target_missing', 'This book is no longer in your library, so nothing was changed.');
  const close = fp => { if (fp) store.book_findings = store.book_findings.filter(f => f.fingerprint !== fp); };
  const keysOk = k => Array.isArray(k) && k.length <= 20 && k.every(x => typeof x === 'string' && KEY_RE.test(x) && x.length <= 300);
  const titleOk = t => typeof t === 'string' && t === t.trim() && t !== '' && t.length <= 300;
  const peopleOk = p => Array.isArray(p) && p.every(x => x && titleOk(x.name) && Object.keys(x).every(k => k === 'id' || k === 'name'));
  const seriesOk = p => Array.isArray(p) && p.every(x => x && titleOk(x.name) && (x.position == null || /^\d{1,3}(\.\d{1,2})?$/.test(x.position)));
  const dateOk = d => d == null || (d && /^(\d{4}(-\d{2}(-\d{2})?)?|TBA)$/.test(d.value) && ['member', 'website'].includes(d.source) && (d.url == null || /^https:\/\/\S+$/.test(d.url)));
  return {
    library_book_add({ p_book: b, p_status: status, p_clear_keys: clear, p_finding: finding, p_refuse_keys: refuse }) {
      if (!b || !titleOk(b.title) || !STATUSES.includes(status) || !peopleOk(b.authors || []) || !seriesOk(b.series || []) || !dateOk(b.chosen_date) || !keysOk(clear || []) || !keysOk(refuse || [])) invalid('book');
      if (store.book_decisions.some(d => d.kind === 'exclude' && (refuse || []).includes(d.key))) refuse_('book_excluded', 'This title was removed or dismissed, so it wasn\'t added. Add it yourself to bring it back.');
      if (b.hardcover_id != null && store.book_entries.some(e => e.hardcover_id === b.hardcover_id)) refuse('book_duplicate', 'This book is already in your library, so nothing was changed.');
      const e = { id: newId(), hardcover_id: b.hardcover_id ?? null, title: b.title, authors: clone(b.authors || []), series: clone(b.series || []), status, chosen_date: clone(b.chosen_date ?? null), created_at: now(), updated_at: now() };
      store.book_entries.push(e);
      const before = store.book_decisions.length;
      store.book_decisions = store.book_decisions.filter(d => !(d.kind === 'exclude' && (clear || []).includes(d.key)));
      close(finding);
      return { ...clone(e), exclusions_lifted: before - store.book_decisions.length };
    },
    library_book_set({ p_entry_id: id, p_expected_status: exp, p_status: status }) {
      if (!STATUSES.includes(status)) invalid('book');
      const e = entryOf(id);
      if (e.status !== exp) changed();
      Object.assign(e, { status, updated_at: now() });
      return clone(e);
    },
    library_book_edit({ p_entry_id: id, p_expected: exp, p_fields: fields, p_finding: finding }) {
      const keys = Object.keys(fields || {});
      if (!keys.length || keys.some(k => !['title', 'authors', 'series', 'chosen_date'].includes(k)) || keys.sort().join() !== Object.keys(exp || {}).sort().join()) invalid('book');
      if (('title' in fields && !titleOk(fields.title)) || ('authors' in fields && !peopleOk(fields.authors)) || ('series' in fields && !seriesOk(fields.series)) || ('chosen_date' in fields && !dateOk(fields.chosen_date))) invalid('book');
      const e = entryOf(id);
      if (keys.some(k => !same(e[k], exp[k]))) changed();
      keys.forEach(k => { e[k] = clone(fields[k] ?? null); });
      e.updated_at = now();
      close(finding);
      return clone(e);
    },
    library_book_link({ p_entry_id: id, p_expected_hardcover_id: exp, p_hardcover_id: hc, p_fields: fields, p_finding: finding }) {
      if (!(hc > 0)) invalid('link');
      const e = entryOf(id);
      if ((e.hardcover_id ?? null) !== (exp ?? null)) changed();
      if (store.book_entries.some(x => x.id !== e.id && x.hardcover_id === hc)) refuse('book_duplicate', 'Another book in your library already has this Hardcover record, so nothing was changed.');
      e.hardcover_id = hc;
      Object.keys(fields || {}).forEach(k => { e[k] = clone(fields[k]); });
      e.updated_at = now();
      close(finding);
      return clone(e);
    },
    library_book_delete({ p_entry_id: id, p_expected_status: exp, p_exclude_keys: keys }) {
      if (!keysOk(keys || []) || !(keys || []).length) invalid('book');
      const e = entryOf(id);
      if (e.status !== exp) changed();
      for (const k of keys) {
        const d = store.book_decisions.find(x => x.kind === 'exclude' && x.key === k);
        if (d) d.value = { reason: 'removed', title: e.title }; else store.book_decisions.push({ id: newId(), kind: 'exclude', key: k, value: { reason: 'removed', title: e.title }, created_at: now() });
      }
      store.book_entries = store.book_entries.filter(x => x.id !== e.id);
      return { deleted_id: e.id, excluded: keys.length };
    },
    library_book_follow({ p_kind: kind, p_hardcover_id: hc, p_name: name, p_auto_add: auto }) {
      if (!['author', 'series'].includes(kind) || !(hc > 0) || !titleOk(name) || typeof auto !== 'boolean' || (kind === 'author' && auto)) invalid('follow');
      if (store.book_follows.some(f => f.kind === kind && f.hardcover_id === hc)) refuse('book_follow_exists', `You already follow this ${kind}, so nothing was changed.`);
      const f = { id: newId(), kind, hardcover_id: hc, name, auto_add: auto, created_at: now(), updated_at: now() };
      store.book_follows.push(f);
      return clone(f);
    },
    library_book_follow_set({ p_follow_id: id, p_expected_auto_add: exp, p_auto_add: auto }) {
      const f = store.book_follows.find(x => x.id === id) || refuse('follow_missing', 'You no longer follow this, so nothing was changed.');
      if (f.kind !== 'series') invalid('follow');
      if (f.auto_add !== exp) changed();
      Object.assign(f, { auto_add: auto, updated_at: now() });
      return clone(f);
    },
    library_book_unfollow({ p_follow_id: id }) {
      const had = store.book_follows.some(f => f.id === id);
      store.book_follows = store.book_follows.filter(f => f.id !== id);
      return { follow_id: id, removed: had };
    },
    library_book_site_set({ p_author_id: a, p_author_name: name, p_expected_url: exp, p_url: url }) {
      if (!(a > 0) || !titleOk(name) || (url != null && !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/\S*)?$/.test(url))) invalid('site');
      const s = store.book_sites.find(x => x.hardcover_author_id === a);
      if ((s ? s.listing_url : null) !== (exp ?? null)) changed();
      if (url == null) { store.book_sites = store.book_sites.filter(x => x !== s); return { hardcover_author_id: a, removed: !!s }; }
      if (s) { Object.assign(s, { author_name: name, listing_url: url, updated_at: now() }); return clone(s); }
      const n = { id: newId(), hardcover_author_id: a, author_name: name, listing_url: url, created_at: now(), updated_at: now() };
      store.book_sites.push(n);
      return clone(n);
    },
    library_book_association_set({ p_book_id: b, p_author_id: a, p_author_name: name, p_on: on, p_finding: finding }) {
      if (!(b > 0) || !(a > 0) || !titleOk(name)) invalid('association');
      const x = store.book_associations.find(r => r.hardcover_book_id === b && r.hardcover_author_id === a);
      close(finding);
      if (!on) { store.book_associations = store.book_associations.filter(r => r !== x); return { hardcover_book_id: b, hardcover_author_id: a, removed: !!x }; }
      if (x) { x.author_name = name; return clone(x); }
      const n = { id: newId(), hardcover_book_id: b, hardcover_author_id: a, author_name: name, created_at: now() };
      store.book_associations.push(n);
      return clone(n);
    },
    library_book_decision_set({ p_kind: kind, p_key: key, p_expected: exp, p_value: value, p_finding: finding, p_outcome: outcome }) {
      if (!['skip', 'exclude', 'keep_date', 'not_same', 'not_author', 'baseline', 'replace_credit'].includes(kind) || !KEY_RE.test(key || '') || (!!finding !== !!outcome)) invalid('decision');
      if (kind === 'replace_credit' && value != null && !(/^rc:[1-9]\d*:([1-9]\d*)$/.test(key) && Object.keys(value).join() === 'by' && Number.isInteger(value.by) && value.by > 0 && String(value.by) !== key.split(':')[2])) invalid('decision');
      const d = store.book_decisions.find(x => x.kind === kind && x.key === key);
      if (!!d !== (exp != null) || (d && !same(d.value, exp))) changed();
      if (outcome === 'done') close(finding);
      else if (outcome === 'later') store.book_findings.filter(f => f.fingerprint === finding).forEach(f => { f.status = 'later'; });
      if (value == null) { store.book_decisions = store.book_decisions.filter(x => x !== d); return { kind, key, removed: !!d }; }
      if (d) { d.value = clone(value); d.created_at = now(); return clone(d); }
      const n = { id: newId(), kind, key, value: clone(value), created_at: now() };
      store.book_decisions.push(n);
      return clone(n);
    },
    library_book_findings_record({ p_rows: rows, p_close: closeList }) {
      if (!Array.isArray(rows) || rows.length > 200 || new Set(rows.map(r => r.fingerprint)).size !== rows.length) invalid('findings');
      for (const r of rows) {
        if (!KEY_RE.test(r.fingerprint || '') || !['hardcover', 'website'].includes(r.source) || !['new_book', 'date', 'credit_gap', 'match', 'duplicate', 'site_changed'].includes(r.kind)
          || !r.subject || typeof r.subject !== 'object' || !keysOk(r.exclude_keys || [])) invalid('findings');
      }
      const before = store.book_findings.length;
      store.book_findings = store.book_findings.filter(f => !(closeList || []).includes(f.fingerprint));
      const out = { added: 0, updated: 0, suppressed: 0, closed: before - store.book_findings.length };
      for (const r of rows) {
        const blocked = store.book_decisions.some(d => (d.kind === 'exclude' && (r.exclude_keys || []).includes(d.key)) || (['keep_date', 'not_same', 'not_author'].includes(d.kind) && d.key === r.fingerprint));
        if (blocked) { store.book_findings = store.book_findings.filter(f => f.fingerprint !== r.fingerprint); out.suppressed++; continue; }
        const f = store.book_findings.find(x => x.fingerprint === r.fingerprint);
        if (f) { Object.assign(f, { subject: clone(r.subject), evidence: clone(r.evidence || []), source: r.source, kind: r.kind, last_seen_at: now() }); out.updated++; }
        else { store.book_findings.push({ id: newId(), fingerprint: r.fingerprint, source: r.source, kind: r.kind, status: 'pending', subject: clone(r.subject), evidence: clone(r.evidence || []), first_seen_at: now(), last_seen_at: now() }); out.added++; }
      }
      return out;
    },
    library_book_finding_resolve({ p_fingerprint: fp, p_expected_status: exp, p_outcome: outcome }) {
      if (!['later', 'pending', 'done'].includes(outcome)) invalid('finding');
      const f = store.book_findings.find(x => x.fingerprint === fp);
      if (!f) return { fingerprint: fp, gone: true };
      if (f.status !== exp) changed();
      if (outcome === 'done') close(fp); else f.status = outcome;
      return { fingerprint: fp, status: outcome === 'done' ? null : outcome };
    },
    library_book_cache_put({ p_rows: rows }) {
      if (!Array.isArray(rows) || rows.length > 200 || rows.some(r => !['book', 'author', 'series', 'site'].includes(r.kind) || typeof r.key !== 'string' || !r.data || typeof r.data !== 'object')) invalid('cache');
      let skipped = 0;
      for (const r of rows) {
        if (Buffer.byteLength(JSON.stringify(r.data).replace(/([,:])/g, '$1 ')) > 60000) { skipped++; continue; }
        const old = store.book_cache.find(x => x.kind === r.kind && x.key === r.key);
        if (old) Object.assign(old, { data: clone(r.data), fetched_at: now() });
        else store.book_cache.push({ id: newId(), kind: r.kind, key: r.key, data: clone(r.data), fetched_at: now() });
      }
      return { cached: rows.length - skipped, skipped };
    },
    library_book_cache_purge() { const n = store.book_cache.length; store.book_cache = []; return { removed: n }; }
  };
}

module.exports = { BK1_TABLES, bk1Handlers };
