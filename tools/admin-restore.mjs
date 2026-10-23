// The admin restore runbook's tooling (M1, plan D2): restoring a library from the SQL Editor when
// the page or sign-in can't be used, with the page's own safeguards. Offline; it never connects
// to anything. Every check uses the page's code (backup-restore.js, backup-format3.js).
//
// The database's backup format: 7 since CU1 (collection updates), 6 on an EP1 database. export-sql and
// export-owner-sql take --format 6 for an EP1 database (default 7); check takes the target format from the
// safety backup; restore-sql and verify use the file's format (the database refuses any other).
//
//   node tools/admin-restore.mjs export-sql --owner <auth user id> [--format 7|6]
//       Prints the read-only SQL that exports that member's library as a format-7 (or -6) backup (the safety
//       backup), acting as that member (role authenticated + their JWT claims), in one repeatable-read
//       snapshot whose first statement refuses unless that account is a member (a non-member reads no rows,
//       which must never become an "empty" backup).
//   node tools/admin-restore.mjs export-owner-sql --user <auth user id> [--format 7|6]
//       For removing a member (docs/MEMBER_RECOVERY.md): the same document, read by the database owner
//       (postgres) and filtered to that account on every table, in one repeatable-read snapshot. It needs no
//       membership, so it never reopens access to the account. Its rowCounts are that snapshot's counts.
//   node tools/admin-restore.mjs check --file <backup.json> --safety <safety.json> [--out <converted.json>]
//       The page's checks, refusing as the page refuses: the file and the safety backup
//       validate; an older file (format 3 to 6) is converted to the safety backup's format exactly as the page converts it (written
//       to --out); a conversion record or recovery section is checked; then the identity-loss
//       check against the safety backup. Any finding: exit 1, and the runbook stops. No override.
//       It also reports how many episode marks the file and the safety backup hold (a restore
//       replaces the library's marks with the file's).
//   node tools/admin-restore.mjs restore-sql --file <format7.json> --owner <id> --email <email> --run <run id>
//       Prints the restore SQL: the run label, the destination check (that id is that email and
//       a member), then restore_backup as that member, in one transaction.
//   node tools/admin-restore.mjs verify --file <format7.json> --after <export after restore.json>
//       Field by field, as the page verifies after a restore. Exit 1 on any difference.
// Output: counts, hashes and pass/fail; never record contents (except the identity-loss
// examples the page itself shows).
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const opt = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

const page = { console, Map, Set, JSON, Date, Math, Array, Object, String, Number, Boolean, RegExp, Error, Promise, parseInt, isFinite,
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} }, window: {}, localStorage: { getItem: () => null, setItem() {} },
  crypto: crypto.webcrypto, TextEncoder };
page.window = page;
vm.createContext(page);
for (const f of ['config.js', 'ui-helpers.js', 'metadata.js', 'api.js', 'backup-restore.js', 'backup-format3.js', 'collection-updates.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), page, { filename: f });
}
const P = expr => vm.runInContext(expr, page);
const FORMATS = [6, 7];
const exportFormat = () => { const v = opt('--format') == null ? 7 : Number(opt('--format')); if (!FORMATS.includes(v)) die('--format 7 (CU1) or 6 (EP1)'); return v; };
const specOf = v => P(`backupSpec(${v})`);
const arr = x => Array.from(x || []);

function readDoc(file) {
  if (!file) die('missing file argument');
  const text = fs.readFileSync(file, 'utf8');
  let doc;
  try { doc = JSON.parse(text); } catch (e) { die(`${file}: not JSON`, 1); }
  return { text, doc, sha256: sha(text) };
}

const SELECTS = (spec, where = '') => spec.tables.map(t => {
  const cols = Object.keys(spec.columns[t]).map(c => `"${c}"`).join(', ');
  return `'${t}', (select coalesce(json_agg(row_to_json(x) order by x.id), '[]'::json) from (select ${cols} from public.${t}${where}) x)`;
});
const COUNTS = (spec, where = '') => spec.tables.map(t => `'${t}', (select count(*) from public.${t}${where})`).join(', ');
const DOC = (v, where = '') => `select json_build_object('format', 'watchlist-tracker-backup', 'formatVersion', ${v},
  'exportedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'rowCounts', json_build_object(${COUNTS(specOf(v), where)}),
  'tables', json_build_object(${SELECTS(specOf(v), where).join(',\n    ')}))::text as backup;`;
if (cmd === 'export-sql') {
  const owner = opt('--owner');
  if (!UUID.test(owner || '')) die('--owner <auth user id>');
  console.log(`-- Admin restore runbook, step 3: export the member's library (the safety backup). Read-only, one snapshot.
-- Save the single value it returns as a .json file, then: node tools/admin-restore.mjs check …
begin isolation level repeatable read read only;
select set_config('request.jwt.claims', json_build_object('sub', '${owner}', 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  if not private.is_member() then raise exception 'export: ${owner} is not a member now; a non-member reads no rows, so no backup was made'; end if;
end $$;
${DOC(exportFormat())}
rollback;`);
} else if (cmd === 'export-owner-sql') {
  const user = opt('--user');
  if (!UUID.test(user || '')) die('--user <auth user id>');
  const where = ` where user_id = '${user}'`;
  console.log(`-- Removing a member, step 2: export that account's library as the database owner, filtered to it on every
-- table. Read-only, one snapshot; needs no membership. Save the value as a .json file, check it, keep it.
begin isolation level repeatable read read only;
do $$ begin
  if current_user <> 'postgres' then raise exception 'export: run as postgres (the SQL Editor role)'; end if;
  if not exists (select 1 from auth.users where id = '${user}') then raise exception 'export: no Auth user ${user}'; end if;
end $$;
${DOC(exportFormat(), where)}
rollback;`);
} else if (cmd === 'check') {
  const f = readDoc(opt('--file')), s = readDoc(opt('--safety'));
  const problems = [];
  const target = s.doc && s.doc.formatVersion;
  const safetyErrors = arr(P('validateBackupObject')(s.doc));
  if (safetyErrors.length || !FORMATS.includes(target)) problems.push(`the safety backup isn’t a valid format-7 (or format-6) backup: ${safetyErrors.concat(!FORMATS.includes(target) ? [`format ${target}`] : []).join('; ')}`);
  const fileErrors = arr(P('validateBackupObject')(f.doc));
  if (fileErrors.length) problems.push(`the file doesn’t validate: ${fileErrors.join('; ')}`);
  let doc = f.doc;
  const v = doc.formatVersion;
  if (!problems.length && (v > target || ![3, 4, 5, 6, 7].includes(v))) {
    problems.push(`format ${v} can’t be restored on this database (formats 3 to ${target})`);
  } else if (!problems.length && v < target) {
    // The page's conversion chain (backup-restore.js), to the database's format; the archive is taken as active.
    let doc5 = doc, doc6 = doc;
    if (v === 3 || v === 4) {
      let doc4 = doc;
      if (v === 3) {
        const conv = P('convertFormat3To4')(doc, { includeRecovery: true, sourceSha256: f.sha256 });
        if (conv.refusals.length) problems.push(`the format-3 file can’t be converted: ${arr(conv.refusals).join('; ')}`);
        else doc4 = conv.doc;
      } else {
        const sp = arr(P('format4SectionProblems')(doc, true));
        if (sp.length) problems.push(...sp);
      }
      if (!problems.length) {
        const conv5 = P('convertFormat4To5')(doc4, { sourceSha256: f.sha256 });
        if (conv5.refusals.length) problems.push(`it can’t be converted to format 5: ${arr(conv5.refusals).join('; ')}`);
        else doc5 = conv5.doc;
      }
    } else if (v === 5 && (doc.conversion !== undefined || doc.recovery !== undefined)) {
      problems.push(...arr(P('sectionProblems')(doc, true, ['3', '4'])));
    } else if (v === 6 && (doc.conversion !== undefined || doc.recovery !== undefined)) {
      problems.push(...arr(P('sectionProblems')(doc, true, ['3', '4', '5'])));
    }
    if (!problems.length && v !== 6) doc6 = P('convertFormat5To6')(doc5, { sourceSha256: f.sha256 }).doc;
    if (!problems.length) {
      doc = JSON.parse(JSON.stringify(target === 7 ? P('convertFormat6To7')(doc6, { sourceSha256: f.sha256 }).doc : doc6));
      const ve = arr(P('validateBackupObject')(doc));
      if (ve.length) problems.push(`the converted backup doesn’t validate: ${ve.join('; ')}`);
      if (doc.recovery !== undefined) problems.push(...arr(P('recoverySectionProblems')(doc)));
    }
  } else if (!problems.length && (doc.conversion !== undefined || doc.recovery !== undefined)) {
    problems.push(...arr(P('sectionProblems')(doc, true, ['3', '4', '5', '6'].filter(x => +x < target))));
  }
  if (!problems.length) problems.push(...arr(P('identityLossErrors')(s.doc.tables.watchlist_items, doc.tables.watchlist_items)));
  console.log(`file ${opt('--file')} sha256 ${f.sha256} format ${f.doc.formatVersion}; safety sha256 ${s.sha256} format ${target}`);
  if (problems.length) {
    console.log(`REFUSED — the runbook stops here; nothing may be sent:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  if (doc !== f.doc) {
    const out = opt('--out');
    if (!out) die('a converted document must be written with --out <converted.json>', 1);
    const text = JSON.stringify(doc);
    fs.writeFileSync(out, text);
    console.log(`converted to format ${target}: ${out} sha256 ${sha(text)}`);
  }
  console.log(`episode marks: the file has ${doc.tables.episode_marks.length}; the library has ${s.doc.tables.episode_marks.length} (a restore replaces them with the file's)`);
  console.log(`OK — counts ${JSON.stringify(Object.fromEntries(Object.entries(doc.tables).map(([t, r]) => [t, r.length])))}`);
} else if (cmd === 'restore-sql') {
  const f = readDoc(opt('--file'));
  const owner = opt('--owner'), email = opt('--email'), run = opt('--run');
  if (!UUID.test(owner || '') || !/^[^@\s']+@[^@\s']+$/.test(email || '') || !/^[A-Za-z0-9_-]{6,64}$/.test(run || '')) die('--owner <id> --email <email> --run <run id>');
  if (!FORMATS.includes(f.doc.formatVersion)) die('restore-sql takes the format-7 (or format-6) document from check (--out for a converted file)', 1);
  let tag = 'wlr';
  while (f.text.includes(`$${tag}$`)) tag += 'x';
  console.log(`-- Admin restore runbook, step 5: restore. Only after check printed OK for this exact file and the
-- owner confirmed the destination. File sha256 ${f.sha256}. Whether an unanswered run committed is decided
-- by the run label (watchlist-restore-${run}: observed, then absent) and then a fresh export; never by rerunning.
begin;
select set_config('application_name', 'watchlist-restore-${run}', true);
do $$ begin
  if not exists (select 1 from auth.users where id = '${owner}' and lower(email) = lower('${email}')) then
    raise exception 'admin restore: ${owner} is not the account ${email}; nothing was changed';
  end if;
  if to_regclass('private.library_members') is null or not exists (select 1 from private.library_members where user_id = '${owner}') then
    raise exception 'admin restore: ${owner} is not a library member; nothing was changed';
  end if;
end $$;
select set_config('request.jwt.claims', json_build_object('sub', '${owner}', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.restore_backup($${tag}$${f.text}$${tag}$::jsonb, false) as result;
commit;`);
} else if (cmd === 'verify') {
  const f = readDoc(opt('--file')), a = readDoc(opt('--after'));
  const errors = [];
  const spec = specOf(f.doc.formatVersion);
  if (!FORMATS.includes(f.doc.formatVersion) || a.doc.formatVersion !== f.doc.formatVersion) die('verify compares a format-7 (or -6) file with an export in the same format', 1);
  for (const t of spec.tables) {
    const want = f.doc.tables[t] || [], have = a.doc.tables[t] || [];
    if (want.length !== have.length) { errors.push(`${t}: expected ${want.length} rows, found ${have.length}`); continue; }
    const byId = new Map(have.map(r => [r.id, r]));
    const missing = want.filter(r => !byId.has(r.id)).length;
    if (missing) { errors.push(`${t}: ${missing} expected row(s) not found`); continue; }
    const diff = want.filter(r => arr(P('compareRowFields')(r, byId.get(r.id), spec.columns[t])).length).length;
    if (diff) errors.push(`${t}: ${diff} row(s) differ`);
  }
  if (errors.length) { console.log(`DIFFERENT:\n  - ${errors.join('\n  - ')}`); process.exit(1); }
  console.log(`VERIFIED — every table and field equals the file (sha256 ${f.sha256})`);
} else {
  die('usage: node tools/admin-restore.mjs export-sql | export-owner-sql | check | restore-sql | verify (see the header)');
}
