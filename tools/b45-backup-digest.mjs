// The B45 rollback's association check and approval binding (plan §10.2 steps 3–4).
// The backup-comparable digests of a format-5 backup file are computed exactly as
// private.b45_rollback_report() computes its backup_digests in the database — per table, the
// row count and an MD5 over each row's format-5 columns as PostgreSQL renders jsonb text (keys
// by length, then bytes; ", " and ": " separators), joined with "|" in id order. Equal digests
// mean the backup is of the state the report describes; any difference means it isn't (stop,
// take P1 again). The approval is one token binding the report's SHA-256 (recomputed here from
// the report itself), the P1 file's SHA-256 and the loss acceptance; db/rollback/b45.sql
// refuses unless its preamble carries that token for those values and the P1 digests equal the
// state's under lock. Timestamps compare as text: the backup and the report must both use UTC
// (PostgREST and the Supabase SQL Editor do by default).
//   node tools/b45-backup-digest.mjs <format5-backup.json>                       digests only
//   node tools/b45-backup-digest.mjs <P1.json> --report <dry-run.json> [--lossy]  association check + the token to approve
//   node tools/b45-backup-digest.mjs <P1.json> --report <dry-run.json> [--lossy] --approval <token>
//                                                                                the execution preamble, only for that token
// <dry-run.json>: the dry run's row ({ report, report_sha256 }) or the report alone. Exits 1 on
// any mismatch or refusal. Reads files only; sends nothing.
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// PostgreSQL's escape_json: \" \\ \b \f \n \r \t, other control characters as \u00xx (lowercase).
function pgString(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}
// jsonb's key order: shorter keys first, then byte order (UTF-8).
const keyOrder = (a, b) => {
  const ba = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
  return ba.length - bb.length || Buffer.compare(ba, bb);
};
export function pgJsonbText(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return pgString(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`not a JSON number: ${v}`);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `[${v.map(pgJsonbText).join(', ')}]`;
  return `{${Object.keys(v).sort(keyOrder).map(k => `${pgString(k)}: ${pgJsonbText(v[k])}`).join(', ')}}`;
}

// The format-5 columns per table (db/b45_expand.sql b45_rollback_report v_cols; backup-restore.js RESTORE_COLUMNS_V5).
export const FORMAT5_COLUMNS = {
  watchlist_items: ['id', 'item_key', 'title', 'season', 'theme', 'theme_kind', 'display_date', 'date_sort', 'watched', 'status', 'created_at',
    'watch_with', 'collections', 'tmdb_collection_id', 'tmdb_collection_name', 'media_type', 'tmdb_id', 'season_number', 'show_id', 'skipped',
    'priority', 'catalog_new', 'status_review', 'legacy_status', 'genres', 'forms', 'franchises', 'companies', 'genre_candidates', 'metadata_owner_set'],
  tv_shows: ['id', 'title', 'show_key', 'tmdb_id', 'status', 'created_at', 'priority', 'ended', 'catalog_new', 'status_review', 'legacy_status',
    'genres', 'forms', 'franchises', 'companies', 'genre_candidates', 'network', 'network_candidates', 'metadata_owner_set',
    'resume_start_season_id', 'resume_end_season_id'],
  custom_collections: ['id', 'name', 'tmdb_person_id', 'created_at', 'role'],
  personal_collections: ['id', 'name', 'catalog_id', 'presentation_key', 'sort_order', 'archived_at', 'created_at'],
  collection_memberships: ['id', 'collection_id', 'show_id', 'item_id', 'created_at'],
  watch_with_choices: ['id', 'token', 'label', 'sort_order', 'archived_at', 'created_at'],
  catalog_show_links: ['id', 'catalog', 'catalog_key', 'show_id', 'origin', 'created_at'],
  catalog_film_links: ['id', 'catalog', 'entry_key', 'item_id', 'origin', 'created_at']
};

export function b45BackupDigests(doc) {
  if (!doc || doc.formatVersion !== 5 || !doc.tables) throw new Error('needs a format 5 backup');
  const out = {};
  for (const [t, cols] of Object.entries(FORMAT5_COLUMNS)) {
    const rows = (doc.tables[t] || []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // uuid order = lowercase hex order
    const text = rows.map(r => pgJsonbText(Object.fromEntries(cols.map(c => [c, r[c] === undefined ? null : r[c]])))).join('|');
    out[t] = { n: rows.length, md5: crypto.createHash('md5').update(text, 'utf8').digest('hex') };
  }
  return out;
}

// The report's SHA-256 as the database computes it: encode(sha256(convert_to(report::text, 'UTF8')), 'hex').
export function reportSha256(report) {
  return crypto.createHash('sha256').update(pgJsonbText(report), 'utf8').digest('hex');
}
// The approval token db/rollback/b45.sql recomputes.
export function approvalToken(reportSha, p1Sha, lossyAccepted) {
  return crypto.createHash('sha256').update(`b45-rollback-approval|${reportSha}|${p1Sha}|${lossyAccepted ? 'accepted' : ''}`, 'utf8').digest('hex');
}
const sameDigests = (a, b) => Object.keys(FORMAT5_COLUMNS).every(t => JSON.stringify(a && a[t]) === JSON.stringify(b && b[t]));
// The whole procedure for a P1 file's text and a dry-run output: { ok, problems, reportSha, p1Sha, digests, token, preamble }.
// approval: the token that was approved (the preamble is produced only when it matches).
export function associate(p1Text, dryRun, { lossy = false, approval = null } = {}) {
  const problems = [];
  const report = dryRun && dryRun.report ? dryRun.report : dryRun;
  const reportSha = reportSha256(report);
  if (dryRun && dryRun.report_sha256 && dryRun.report_sha256 !== reportSha) problems.push(`the report's text doesn't match its stated SHA-256 (${dryRun.report_sha256} vs ${reportSha})`);
  const p1Sha = crypto.createHash('sha256').update(p1Text).digest('hex');
  let digests = null;
  try { digests = b45BackupDigests(JSON.parse(p1Text)); } catch (e) { problems.push(`the P1 file isn't a format-5 backup (${e.message})`); }
  if (digests && !sameDigests(digests, report.backup_digests)) problems.push('the P1 file is not a backup of the state the report describes (digests differ)');
  if (Number(report.lossy) > 0 && !lossy) problems.push(`the report lists ${report.lossy} lossy items; the approval must accept them (--lossy)`);
  const token = approvalToken(reportSha, p1Sha, lossy);
  if (approval != null && approval !== token) problems.push('the approval doesn’t name this report, this P1 file and this loss acceptance (a different P1 file hash, report or acceptance was approved)');
  const preamble = !problems.length && approval === token ? [
    `select set_config('watchlist.b45_rollback_approved', '${reportSha}', false),`,
    `       set_config('watchlist.b45_rollback_lossy', '${lossy ? 'accepted' : ''}', false),`,
    `       set_config('watchlist.b45_rollback_p1_sha256', '${p1Sha}', false),`,
    `       set_config('watchlist.b45_rollback_p1_digests', '${JSON.stringify(digests).replace(/'/g, "''")}', false),`,
    `       set_config('watchlist.b45_rollback_approval', '${token}', false);`,
    `-- (and watchlist.b45_rollback_baseline_md5, from the GA-2 read-only capture)`].join('\n') : null;
  return { ok: !problems.length, problems, reportSha, p1Sha, digests, token, preamble };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const file = args.find((a, i) => !a.startsWith('--') && !['--report', '--approval'].includes(args[i - 1]));
  if (!file) { console.error('usage: node tools/b45-backup-digest.mjs <format5-backup.json> [--report <dry-run.json>] [--lossy] [--approval <token>]'); process.exit(2); }
  const text = fs.readFileSync(file);
  if (!opt('--report')) { console.log(JSON.stringify(b45BackupDigests(JSON.parse(text)), null, 2)); process.exit(0); }
  const r = associate(text, JSON.parse(fs.readFileSync(opt('--report'), 'utf8')), { lossy: args.includes('--lossy'), approval: opt('--approval') });
  console.log(`report SHA-256 ${r.reportSha}\nP1 file SHA-256 ${r.p1Sha}\nloss accepted ${args.includes('--lossy') ? 'yes' : 'no'}`);
  if (!r.ok) { r.problems.forEach(p => console.log(`REFUSED: ${p}`)); console.log('Nothing to run. Stop; take P1 again and re-run the dry run if the backup is not of this state.'); process.exit(1); }
  if (!r.preamble) { console.log(`The P1 file is a backup of the reported state.\nApprove exactly this token (it names the report, the P1 file and the loss acceptance):\n${r.token}`); process.exit(0); }
  console.log(`The approval matches. Execution preamble (run in the same session, before db/rollback/b45.sql):\n${r.preamble}`);
  process.exit(0);
}
